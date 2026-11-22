import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { evalCommandPrefix } from "./eval-config.js";
import { evalProxyUrl } from "./egress.js";
import { planDigest } from "./run-events.js";
import type { Capsule, EvalFeatures, TrialEnding } from "./eval-types.js";
import { JUDGE_PACKAGE_DIR, type Judgement, type JudgeEnding } from "./judge-types.js";
import { judgePrompt } from "./judge-prompt.js";
import type { Config, SessionPurpose } from "./types.js";
import type { TeamCommand, TeamMember, TeamModelProfile, TeamReport, TeamRun } from "./team-types.js";
import { assertMemberReadOnly, assertSecureAncestors, TeamError } from "./team-workspace.js";

export type ReplayCreate = {
  trialId: string; jobId: string; purpose: "replay" | "gate"; projectId: string;
  profile: TeamModelProfile; capsule: Capsule; features: EvalFeatures;
  baseCommit: string; workspace: string;   // ROOT/trials/TRIAL/work, prepared by the pump
};
/** One judge, no tasks: the input of a duel run. `trialId` is the duel ID, which the judge's report must repeat. */
export type JudgeCreate = {
  purpose: "duel"; trialId: string; jobId: string; projectId: string; profile: TeamModelProfile;
  baseCommit: string; workspace: string;   // ROOT/trials/ID/work, prepared by the pump, with the package already written
  steering: string[]; ownerAnswers: { question: string; answer: string }[]; judgeMinutes: number;
};
/** What the judge reads of its run, besides the package. It has no `assignment`: the report binding stays in the environment. */
export type JudgeContext = {
  kind: "judge-context"; runId: string; revision: number; baseCommit: string; duelId: string;
  steering: string[]; ownerAnswers: { question: string; answer: string }[]; package: `.git/${typeof JUDGE_PACKAGE_DIR}`;
};
export type ReplayState = {
  phase: "running" | "ended";
  ending?: TrialEnding | JudgeEnding | "settled";   // with "ended"
  judgement?: Judgement;              // with the judge ending "judged"
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
  /** Starts the judge member of a duel run, with its prebuilt prompt and profile. */
  prepare(holder: ReplayHolder, onPrepared: (member: TeamMember) => void, prebuilt: { prompt: string; profile: TeamModelProfile }): void;
  /** A host operation that checks the member's working copy, then completes under the run's lock. */
  operation(holder: ReplayHolder, perform: (signal: AbortSignal) => Promise<unknown>, complete: () => void, member: TeamMember): void;
};

const isJudgeCreate = (input: ReplayCreate | JudgeCreate): input is JudgeCreate => input.purpose === "duel";
const MINUTE = 60_000;

/** The ending of a block that an agent or the host raised. Anything else voids the trial. */
function endingOfBlock(error: unknown, judge: boolean): TrialEnding | JudgeEnding {
  const code = error instanceof TeamError ? error.code : undefined;
  // A judge may not change its working copy: its read-only check names that ending.
  if (judge && code === "read-only-role-changed-files") return "changed";
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
  seed(input: ReplayCreate | JudgeCreate, at: string): TeamRun {
    if (isJudgeCreate(input)) return this.seedJudge(input, at);
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

  /** A judge run: one judge's slot in every lineup role, no task, and status implementing. Replacements and fallbacks never apply. */
  private seedJudge(input: JudgeCreate, at: string): TeamRun {
    const { limitFallback: _fallback, ...profile } = input.profile;
    const decisions = input.ownerAnswers.map((answer, index) => ({
      id: `answer-${index + 1}`, memberId: "replay", revision: 1, question: answer.question, options: [],
      createdAt: at, answer: answer.answer, answeredBy: "owner" as const, answeredAt: at,
    }));
    return {
      id: input.trialId, projectId: input.projectId, provider: profile.provider, title: "Judgement", objective: "Judgement",
      lineup: { coordinator: profile, integrator: profile, reviewer: profile, implementers: [profile] },
      parallelism: 1, revision: 1, status: "implementing", createdAt: at, updatedAt: at,
      workspace: this.workspace(input.workspace), branch: `replay/${input.trialId}`, baseCommit: input.baseCommit, headCommit: input.baseCommit,
      tasks: [], members: [], decisions, checks: [], events: [], round: 0,
      steering: input.steering.map(text => ({ text, revision: 1, at, source: "coordinator" as const })),
      autonomy: "supervised", linearTracking: false,
      replay: { jobId: input.jobId, trialId: input.trialId, purpose: "duel", judgeMinutes: input.judgeMinutes },
    } as TeamRun;
  }

  /** join(eval.member.root, "trials"). Throws TeamError 409 "eval-identity-missing" without eval.member. */
  root(): string {
    const member = this.host.config().eval?.member;
    if (!member) throw new TeamError(409, "eval-identity-missing", "The eval identity is not configured.");
    return join(member.root, "trials");
  }

  /**
   * The trials root's real path, for the run-path check. The eval account owns the launcher root and its trials directory,
   * so the host-owned rule of a team root cannot hold for them: both must be real directories that no group or other
   * account can write, and every directory above the launcher root must pass the host-owned rule.
   */
  canonicalRoot(): string {
    try {
      const real = realpathSync(this.root()), launcherRoot = dirname(real);
      for (const directory of [real, launcherRoot]) {
        const info = lstatSync(directory);
        if (!info.isDirectory() || (info.mode & 0o022) !== 0) throw new Error("unsafe");
      }
      assertSecureAncestors(dirname(launcherRoot));
      return real;
    } catch {
      throw new TeamError(409, "team-root-unsafe", "The trials root must be a real directory that only its account can write, below host-owned directories.");
    }
  }

  /** The trial workspace below the trials root's real path, which is how the run-path check reads the root. The rest of the
   *  path stays as given, so a link inside it is still refused. */
  private workspace(path: string): string {
    const root = this.root(), rest = relative(root, resolve(path));
    if (!rest || rest.startsWith("..") || isAbsolute(rest)) throw new TeamError(409, "invalid-workspace", "The trial workspace is outside the trials root.");
    try { return join(realpathSync(root), rest); }
    catch { throw new TeamError(409, "invalid-workspace", "The trials root cannot be read."); }
  }

  /** run.created, plan.accepted, and one task.planned with the eval features. A judge run emits run.created only. */
  created(holder: ReplayHolder, input: ReplayCreate | JudgeCreate): void {
    const { run } = holder, replay = run.replay!;
    this.host.emit(holder, "run.created", [], { revision: 1 }, { projectId: run.projectId, purpose: replay.purpose, trialId: replay.trialId });
    if (isJudgeCreate(input)) return;
    const { features } = input;
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
    if (holder.run.replay?.purpose === "duel") return this.consumeJudge(holder, member, report);
    const ending: TrialEnding | undefined = report.kind === "question" ? "question" : report.kind === "blocked" ? "blocked"
      : report.kind === "escalate" ? "escalated" : undefined;
    if (!ending) return false;
    this.end(holder, ending);
    return true;
  }

  /**
   * A judge's report. A question or a blocker ends the run with that name. A judgement is accepted only for this duel, within
   * the judging window, and with the working copy unchanged: the first two are read here, the third by the host's read-only check.
   * The judge role accepts no other kind, so ingest refuses one; if one arrived anyway, the run ends void-host. The host never infers a preference.
   */
  private consumeJudge(holder: ReplayHolder, member: TeamMember, report: TeamReport): true {
    const replay = holder.run.replay!;
    if (report.kind === "question") return this.end(holder, "question");
    if (report.kind === "blocked") return this.end(holder, "blocked");
    if (report.kind !== "judgement") return this.end(holder, "void-host");
    if (report.duelId !== replay.trialId) return this.end(holder, "mismatch");
    const started = member.startedAt ? Date.parse(member.startedAt) : NaN, arrived = Date.parse(member.reportedAt ?? new Date().toISOString());
    if (replay.judgeMinutes === undefined || !Number.isFinite(started) || !Number.isFinite(arrived) || arrived - started > replay.judgeMinutes * MINUTE) return this.end(holder, "timeout");
    const judgement: Judgement = { preferred: report.preferred, rubric: { a: { ...report.rubric.a }, b: { ...report.rubric.b } } };
    this.host.operation(holder, signal => this.readOnly(member, signal), () => {
      if (replay.ending) return;
      replay.judgement = judgement;
      this.end(holder, "judged");
    }, member);
    return true;
  }

  /** Records the ending once and cancels the run. It never creates a member, asks the owner, or switches a profile. */
  end(holder: ReplayHolder, ending: TrialEnding | JudgeEnding, resetsAt?: string): true {
    const replay = holder.run.replay!;
    if (replay.ending) return true;
    replay.ending = ending;
    if (resetsAt) replay.resetsAt = resetsAt;
    this.host.save(holder);
    void this.host.cancel(holder).catch(() => {});
    return true;
  }

  blocked(holder: ReplayHolder, error: unknown): true {
    return this.end(holder, endingOfBlock(error, holder.run.replay?.purpose === "duel"));
  }

  async state(holder: ReplayHolder | undefined): Promise<ReplayState | undefined> {
    if (!holder?.run.replay) return undefined;
    const { run } = holder, replay = run.replay!;
    const member = [...run.members].reverse().find(item => item.role === "implementer" || item.role === "judge");
    const status = member ? await this.host.sessionStatus(member.sessionId) : undefined;
    const base = {
      sessionExited: !member || status === undefined || !["starting", "running"].includes(status),
      ...(member ? { memberId: member.memberId, sessionId: member.sessionId, ...(member.startedAt ? { memberStartedAt: member.startedAt } : {}) } : {}),
    };
    if (replay.ending) return { phase: "ended", ending: replay.ending, ...(replay.resetsAt ? { resetsAt: replay.resetsAt } : {}), ...(replay.resultCommit ? { resultCommit: replay.resultCommit } : {}), ...(replay.judgement ? { judgement: replay.judgement } : {}), ...base };
    if (run.status === "ready-for-review") return { phase: "ended", ending: "settled", ...(replay.resultCommit ? { resultCommit: replay.resultCommit } : {}), ...base };
    if (run.status === "paused" || run.status === "cancelled") return { phase: "ended", ending: "void-owner", ...base };
    if (run.status === "blocked") return { phase: "ended", ending: "void-host", ...base };
    return { phase: "running", ...base };
  }

  /**
   * True for every judge run, with or without an ending, so the service's generic step never starts a project manager, a
   * replacement, or a limit fallback in one. It prepares the judge only for a run with no member and no ending.
   */
  judgeStep(holder: ReplayHolder): boolean {
    const { run } = holder, replay = run.replay;
    if (replay?.purpose !== "duel") return false;
    if (replay.ending || run.members.length || run.status !== "implementing" || !run.lineup) return true;
    this.host.prepare(holder, () => {}, { prompt: judgePrompt(run.lineup.coordinator.provider), profile: run.lineup.coordinator });
    return true;
  }

  /** The judge's context file. It names the duel, never a contestant, a profile, or the member. */
  judgeContext(holder: ReplayHolder, member: TeamMember): JudgeContext {
    const { run } = holder;
    return {
      kind: "judge-context", runId: run.id, revision: member.revision, baseCommit: member.baseCommit, duelId: run.replay!.trialId,
      steering: run.steering.map(item => item.text),
      ownerAnswers: run.decisions.flatMap(decision => decision.answer === undefined ? [] : [{ question: decision.question, answer: decision.answer }]),
      package: `.git/${JUDGE_PACKAGE_DIR}`,
    };
  }

  /** The judge's working copy must still be its clean base: it reads, and never changes. */
  private readOnly(member: TeamMember, signal: AbortSignal): Promise<void> {
    return assertMemberReadOnly(member.cwd, member.baseCommit, this.launcher("exec"), signal);
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
