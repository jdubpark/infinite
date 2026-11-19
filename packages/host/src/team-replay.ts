import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { evalCommandPrefix } from "./eval-config.js";
import { evalProxyUrl } from "./egress.js";
import { planDigest } from "./run-events.js";
import type { Capsule, EvalFeatures, TrialEnding } from "./eval-types.js";
import type { Config, SessionPurpose } from "./types.js";
import type { TeamCommand, TeamMember, TeamModelProfile, TeamReport, TeamRun } from "./team-types.js";
import { TeamError } from "./team-workspace.js";

export type ReplayCreate = {
  trialId: string; jobId: string; purpose: "replay" | "gate"; projectId: string;
  profile: TeamModelProfile; capsule: Capsule; features: EvalFeatures;
  baseCommit: string; workspace: string;   // ROOT/trials/TRIAL/work, prepared by the pump
};
export type ReplayState = {
  phase: "running" | "ended";
  ending?: TrialEnding | "settled";   // with "ended"
  resultCommit?: string;              // with "settled", when the member committed a change
  resetsAt?: string;                  // with "void-limit", the provider's stated reset
  memberId?: string; sessionId?: string; memberStartedAt?: string;
  sessionExited: boolean;             // true when no member launched, or the member's session is exited
};
/** The service's record of a run. `outbox` is the record's unstored run events, when it has any. */
export type ReplayHolder = { run: TeamRun; outbox?: readonly unknown[] };
/** Closures over TeamService, built in one field initializer in teams.ts. */
export type ReplayHost = {
  config(): Config;
  emit(holder: ReplayHolder, kind: string, keyParts: readonly (string | number)[],
    ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void;
  save(holder: ReplayHolder): void;
  /** stopRun(stored, "cancel") through enqueue. */
  cancel(holder: ReplayHolder): Promise<void>;
  sessionStatus(sessionId: string): Promise<string | undefined>;
  activeMember(member: TeamMember): boolean;
};

/** The ending of a block that an agent or the host raised. Anything else voids the trial. */
function endingOfBlock(error: unknown): TrialEnding {
  const code = error instanceof TeamError ? error.code : undefined;
  if (code === "missing-agent-report") return "no-result";
  if (code === "agent-question") return "question";
  if (code === "agent-blocked") return "blocked";
  if (code === "task-scope-violation") return "scope-violation";
  return "void-host";
}

/** Replay runs: the seeded record, its commands, its endings, and its settling. Teams.ts calls these in place. */
export class TeamReplay {
  constructor(private readonly host: ReplayHost) {}

  /** The new run: implementing, one pending task from capsule.task, parallelism 1, the trial profile in every role, and
   *  supervised autonomy with no Linear tracking. Objective, brief, steering, and owner answers come from the capsule. */
  seed(input: ReplayCreate, at: string): TeamRun {
    const { profile, capsule } = input;
    const decisions = capsule.ownerAnswers.map((answer, index) => ({
      id: `answer-${index + 1}`, memberId: "replay", revision: 1, question: answer.question, options: [],
      createdAt: at, answer: answer.answer, answeredBy: "owner" as const, answeredAt: at,
    }));
    const task = capsule.task;
    return {
      id: input.trialId, projectId: input.projectId, provider: profile.provider, title: "Eval trial", objective: capsule.objective,
      lineup: { coordinator: profile, integrator: profile, reviewer: profile, implementers: [profile] },
      parallelism: 1, revision: 1, status: "implementing", createdAt: at, updatedAt: at,
      workspace: this.workspace(input.workspace), branch: `replay/${input.trialId}`, baseCommit: input.baseCommit, headCommit: input.baseCommit,
      tasks: [{ id: task.id, title: task.title, instructions: task.instructions, agentProfileId: profile.id, paths: [...task.paths], dependsOn: [], revision: 1, status: "pending" }],
      members: [], decisions, checks: [], events: [], round: 0,
      steering: capsule.steering.map(text => ({ text, revision: 1, at, source: "coordinator" as const })),
      autonomy: "supervised", linearTracking: false,
      ...(capsule.brief ? { brief: structuredClone(capsule.brief) } : {}),
      replay: { jobId: input.jobId, trialId: input.trialId, purpose: input.purpose },
    } as TeamRun;
  }

  /** join(eval.member.root, "trials"). Throws TeamError 409 "eval-identity-missing" without eval.member. */
  root(): string {
    const member = this.host.config().eval?.member;
    if (!member) throw new TeamError(409, "eval-identity-missing", "The eval identity is not configured.");
    return join(member.root, "trials");
  }

  /** The trial workspace below the trials root's real path, which is how the run-path check reads the root. The rest of the
   *  path stays as given, so a link inside it is still refused. */
  private workspace(path: string): string {
    const root = this.root(), rest = relative(root, resolve(path));
    if (!rest || rest.startsWith("..") || isAbsolute(rest)) throw new TeamError(409, "invalid-workspace", "The trial workspace is outside the trials root.");
    try { return join(realpathSync(root), rest); }
    catch { throw new TeamError(409, "invalid-workspace", "The trials root cannot be read."); }
  }

  /** run.created, plan.accepted, and one task.planned with the eval features. */
  created(holder: ReplayHolder, features: EvalFeatures): void {
    const { run } = holder, replay = run.replay!;
    this.host.emit(holder, "run.created", [], { revision: 1 }, { projectId: run.projectId, purpose: replay.purpose, trialId: replay.trialId });
    this.host.emit(holder, "plan.accepted", [1], { revision: 1 }, { taskCount: run.tasks.length, planDigest: planDigest(run.tasks), parallelism: run.parallelism });
    for (const task of run.tasks) this.host.emit(holder, "task.planned", [1, task.id], { taskId: task.id, revision: 1 }, { taskId: task.id, revision: 1, features });
  }

  /** A replay run's commands run through the eval launcher's exec operation, never through teams.commandPrefix. */
  prefixFor(run: TeamRun, fallback: TeamCommand | undefined): TeamCommand | undefined {
    if (!run.replay) return fallback;
    return this.launcher("exec");
  }

  /** For a replay run: the setup prefix, and stdin that carries the `_eval-setup` proxy URL and a newline. */
  setupFor(run: TeamRun, fallback: TeamCommand | undefined): { prefix: TeamCommand | undefined; input?: string } {
    if (!run.replay) return { prefix: fallback };
    const url = evalProxyUrl("_eval-setup", run.replay.trialId, 900);
    return { prefix: this.launcher("setup"), input: `${url ?? ""}\n` };
  }

  header(run: TeamRun): { purpose?: SessionPurpose } {
    return run.replay ? { purpose: run.replay.purpose } : {};
  }

  trusted(run: TeamRun): boolean {
    return run.replay ? true : this.host.config().teams?.trustWorkspaces === true;
  }

  /** Every task integrated and no member active. The result is the task's commit, absent for an empty result. */
  step(holder: ReplayHolder): void {
    const { run } = holder, replay = run.replay!;
    if (replay.ending) return;
    const commit = run.tasks[0]?.commit;
    if (commit) replay.resultCommit = commit;
    run.status = "ready-for-review";
    this.host.save(holder);
  }

  /** A question, a blocked report, or an escalation ends the trial. Any other report is left to the run. */
  consume(holder: ReplayHolder, member: TeamMember): boolean {
    const report: TeamReport | undefined = member.report;
    if (!report) return false;
    const ending: TrialEnding | undefined = report.kind === "question" ? "question" : report.kind === "blocked" ? "blocked"
      : report.kind === "escalate" ? "escalated" : undefined;
    if (!ending) return false;
    this.end(holder, ending);
    return true;
  }

  /** Records the ending once and cancels the run. It never creates a member, asks the owner, or switches a profile. */
  end(holder: ReplayHolder, ending: TrialEnding, resetsAt?: string): true {
    const replay = holder.run.replay!;
    if (replay.ending) return true;
    replay.ending = ending;
    if (resetsAt) replay.resetsAt = resetsAt;
    this.host.save(holder);
    void this.host.cancel(holder).catch(() => {});
    return true;
  }

  blocked(holder: ReplayHolder, error: unknown): true {
    return this.end(holder, endingOfBlock(error));
  }

  async state(holder: ReplayHolder | undefined): Promise<ReplayState | undefined> {
    if (!holder?.run.replay) return undefined;
    const { run } = holder, replay = run.replay!;
    const member = [...run.members].reverse().find(item => item.role === "implementer");
    const status = member ? await this.host.sessionStatus(member.sessionId) : undefined;
    const base = {
      sessionExited: !member || status === undefined || !["starting", "running"].includes(status),
      ...(member ? { memberId: member.memberId, sessionId: member.sessionId, ...(member.startedAt ? { memberStartedAt: member.startedAt } : {}) } : {}),
    };
    if (replay.ending) return { phase: "ended", ending: replay.ending, ...(replay.resetsAt ? { resetsAt: replay.resetsAt } : {}), ...(replay.resultCommit ? { resultCommit: replay.resultCommit } : {}), ...base };
    if (run.status === "ready-for-review") return { phase: "ended", ending: "settled", ...(replay.resultCommit ? { resultCommit: replay.resultCommit } : {}), ...base };
    if (run.status === "paused" || run.status === "cancelled") return { phase: "ended", ending: "void-owner", ...base };
    if (run.status === "blocked") return { phase: "ended", ending: "void-host", ...base };
    return { phase: "running", ...base };
  }

  /** Ended or settled, no member active, and the outbox empty. */
  forgettable(holder: ReplayHolder): boolean {
    const { run } = holder, replay = run.replay;
    if (!replay) return false;
    const ended = Boolean(replay.ending) || run.status === "ready-for-review";
    return ended && !run.members.some(member => this.host.activeMember(member)) && (holder.outbox?.length ?? 0) === 0;
  }

  private launcher(op: "exec" | "setup"): TeamCommand {
    const prefix = evalCommandPrefix(this.host.config().eval?.member, op);
    if (!prefix) throw new TeamError(409, "eval-identity-missing", "The eval identity is not configured.");
    return prefix;
  }
}
