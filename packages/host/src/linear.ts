import { inputSourceLabel, decisionAnswerLabel, decisionAuthorityQuestion } from "./team-types.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_REPORT_NAME, reportName } from "./config.js";
import type { Config } from "./types.js";
import type { ProductGoal } from "./goal-types.js";
import type { TeamRun, TeamView } from "./team-types.js";
import type { LinearBridgeStatus, LinearIssueView, LinearLimitView, LinearTrackingView } from "./linear-types.js";
import { unseal, writeSealed } from "./vault.js";
import { recommendationLine } from "./question-recommendation.js";

const endpoint = "https://api.linear.app/graphql";
const freshnessMs = 30000;
const settledFreshnessMs = 10 * 60000;
const maxPauseMs = 5 * 60000;
const fallbackPauseMs = 60000;
const maxRetryAfterMs = 2 * 3600000;
const confirmWaitMs = 5000;
const at = (ms: number) => new Date(Math.ceil(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const rateLimitReason = (retryAt: number) => `Linear is rate-limiting this host's requests. Tracking retries at ${at(retryAt)}; execution waits until Linear confirms current requirements.`;
const maxResponseBytes = 1024 * 1024;
const issueFields = "id identifier url title description updatedAt archivedAt team { id } project { id } parent { id } state { id name type }";
const issueSchema = z.object({
  id: z.uuid(), identifier: z.string().min(1).max(100),
  url: z.url().max(2048).refine(value => new URL(value).origin === "https://linear.app"),
  title: z.string().min(1).max(512), description: z.string().max(64000).nullable(),
  updatedAt: z.iso.datetime(), archivedAt: z.iso.datetime().nullable(),
  team: z.object({ id: z.uuid() }), project: z.object({ id: z.uuid() }).nullable().optional(), parent: z.object({ id: z.uuid() }).nullable(),
  state: z.object({ id: z.uuid(), name: z.string().min(1).max(200), type: z.string().min(1).max(40) }),
});
const commentSchema = z.object({ id: z.uuid(), body: z.string().max(64000), issue: z.object({ id: z.uuid() }) });
const labelSchema = z.object({ id: z.uuid(), name: z.string().max(200), team: z.object({ id: z.uuid() }).nullable() });
const BLOCKED_LABEL = "Blocked";
type Issue = z.infer<typeof issueSchema>;
type Comment = { id: string; body: string; attempted: boolean; delivered: boolean };
type Stored = {
  kind: "goal" | "team"; id: string; projectId: string; teamId: string; linearProjectId?: string; endpoint: string;
  lookup: string; existing: boolean; parentKey?: string;
  create: { id: string; title: string; description: string; teamId: string; projectId?: string; parentId?: string };
  attempted: boolean; issue?: Issue; baseline?: string; checkedAt?: string;
  blocked?: string; error?: string; failures: number; retryAt: number;
  terminal: boolean; comments: Record<string, Comment>;
  label?: "add" | "added" | "remove"; labelFailures?: number; labelRetryAt?: number;
  retitle?: string; retitleFailures?: number; retitleRetryAt?: number;
  retitleWanted?: string;
  retitleSent?: { id: string; title: string }[];
};
type Freshness = { requested: number; verified: number; queued: Set<string>; readRequested: boolean };
const keyOf = (kind: Stored["kind"], id: string) => `${kind}:${id}`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminalStatuses = new Set(["ready-for-review", "merged", "no-change", "no-opportunity", "blocked", "cancelled", "limit-reached", "achieved"]);
const evidenceStatuses = new Set([...terminalStatuses, "needs-input", "paused"]);
const RETITLE_SENT_LIMIT = 16;
const normalized = (value: string | null) => (value ?? "").replace(/\r\n/g, "\n").trim();
const createMatchNormalized = (value: string | null) => {
  let fenced = false;
  return normalized(value).split("\n").map(line => {
    if (/^[ \t]*(?:```|~~~)/.test(line)) { fenced = !fenced; return line; }
    if (fenced) return line;
    return line.replace(/^([ \t]*)[-*+](?= )/, "$1-").split(/(`[^`]*`)/).map((part, index) => index % 2 ? part
      : part.replace(/\[([^\]]+)\]\(<\1>\)/g, "$1").replace(/\[([^\]]+)\]\(\1\)/g, "$1").replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, "$1")).join("");
  }).join("\n");
};
const scopeHash = (issue: Issue, linearProjectId?: string) => hash({ title: issue.title, description: normalized(issue.description), teamId: issue.team.id,
  ...(linearProjectId !== undefined ? { projectId: issue.project?.id ?? null } : {}), parentId: issue.parent?.id ?? null });

export function sharedText(value: string) {
  return value.replace(/(?:\/(?:Users|home|tmp|private\/tmp|private\/var|var\/folders)\/|~\/|[A-Za-z]:\\)[^\s<>"'`]+/g, "[local path omitted]");
}

type RateLimitWait = { delay: number; basis: "retry-after" | "reset" | "fallback"; retryAfterSeconds?: number };
function serverSkew(response: Response) {
  const date = Date.parse(response.headers.get("date") ?? "");
  const skew = Number.isFinite(date) ? date - Date.now() : 0;
  return Math.abs(skew) < 5000 ? 0 : skew;
}

export class LinearFailure extends Error {
  constructor(readonly retryAfterMs = 0) { super("Linear could not confirm synchronization. Check the connection and host credential; execution is waiting."); }
}

export class LinearService {
  private readonly records = new Map<string, Stored>();
  private readonly saved = new Map<string, string>();
  private readonly fresh = new Map<string, Freshness>();
  private readonly directory: string;
  private readonly requests = new Set<AbortController>();
  private readonly labels = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private pumping = false;
  private closed = false;
  private retryUntil = 0;
  private readonly activeTeams = new Map<string, string | undefined>();
  private readonly statuses = new Map<string, string>();
  private readonly usage: { minute: number; requests: number; complexity: number }[] = [];
  private limits?: LinearBridgeStatus["limits"];
  private lastLimit?: LinearBridgeStatus["lastRateLimit"];
  private limitLoggedAt = 0;
  private limitStreak = 0;
  private recovering = false;
  private probe?: Promise<void>;

  constructor(private readonly config: Config, private readonly key: Buffer) {
    this.directory = join(config.stateDir, "linear");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^(goal|team)-[a-f0-9-]{36}\.sealed$/.test(name))) {
      const recordKey = file.slice(0, -7).replace("-", ":");
      const stored = unseal<Stored>(key, `linear:${recordKey}`, readFileSync(join(this.directory, file), "utf8"));
      if (keyOf(stored.kind, stored.id) !== recordKey) throw new Error("A Linear tracking record cannot be authenticated.");
      this.records.set(recordKey, stored); this.saved.set(recordKey, hash(stored));
      this.fresh.set(recordKey, { requested: 1, verified: 0, queued: new Set(), readRequested: false });
    }
  }

  private save(stored: Stored) {
    if (this.closed) return;
    const recordKey = keyOf(stored.kind, stored.id), fingerprint = hash(stored);
    if (this.saved.get(recordKey) === fingerprint) return;
    writeSealed(join(this.directory, `${stored.kind}-${stored.id}.sealed`), this.key, `linear:${recordKey}`, stored);
    this.saved.set(recordKey, fingerprint);
  }
  private clock(stored: Stored) { return this.fresh.get(keyOf(stored.kind, stored.id))!; }
  private force(stored: Stored) { this.clock(stored).requested++; }
  private configuration(stored: Stored): boolean {
    const project = this.config.projects.find(project => project.id === stored.projectId);
    if (!this.config.linear || project?.linear?.teamId !== stored.teamId || project?.linear?.projectId !== stored.linearProjectId || (this.config.linear.endpoint ?? endpoint) !== stored.endpoint) {
      stored.blocked ??= "This run's Linear configuration was removed or changed. Restore its binding or start a newly approved run.";
      this.save(stored); return false;
    }
    return true;
  }
  private register(kind: Stored["kind"], value: { id: string; projectId: string; title: string; status: string }, description: string, optedInAtCreation: boolean, existing?: string, parentKey?: string) {
    const recordKey = keyOf(kind, value.id), prior = this.records.get(recordKey);
    if (prior) {
      this.statuses.set(recordKey, value.status);
      this.configuration(prior);
      if (prior.projectId !== value.projectId || prior.parentKey !== parentKey || (existing && prior.lookup !== existing))
        prior.blocked ??= "The Linear issue binding changed. Start a newly approved run with the intended issue.";
      prior.terminal = terminalStatuses.has(value.status); this.save(prior); return prior;
    }
    if (!optedInAtCreation) return undefined;
    const project = this.config.projects.find(project => project.id === value.projectId);
    if (!project?.linear) return undefined;
    const createId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id) ? value.id : randomUUID();
    const stored: Stored = { kind, id: value.id, projectId: value.projectId, teamId: project.linear.teamId, ...(project.linear.projectId ? { linearProjectId: project.linear.projectId } : {}),
      endpoint: this.config.linear?.endpoint ?? endpoint, lookup: existing ?? createId, existing: Boolean(existing),
      ...(parentKey ? { parentKey } : {}), create: { id: createId, title: sharedText(value.title), description: sharedText(description), teamId: project.linear.teamId, ...(project.linear.projectId ? { projectId: project.linear.projectId } : {}) },
      attempted: false, failures: 0, retryAt: 0, terminal: terminalStatuses.has(value.status), comments: {},
    };
    this.records.set(recordKey, stored); this.fresh.set(recordKey, { requested: 1, verified: 0, queued: new Set(), readRequested: false });
    this.statuses.set(recordKey, value.status);
    this.configuration(stored); this.save(stored);
    if (parentKey) { const parent = this.records.get(parentKey); if (parent) this.force(parent); }
    return stored;
  }
  private comment(stored: Stored, event: string, text: string, keyText = text) {
    const body = sharedText(text), eventKey = hash({ event, body: sharedText(keyText) });
    if (stored.comments[eventKey]) return;
    if (Object.keys(stored.comments).length >= 256 || Buffer.byteLength(body) > 64000) {
      stored.blocked ??= "Linear evidence exceeded its bounded outbox. Review the saved execution before starting another run.";
      this.save(stored); return;
    }
    stored.comments[eventKey] = { id: randomUUID(), body, attempted: false, delivered: false };
    this.save(stored);
  }
  updateGoal(goal: ProductGoal, optedInAtCreation = false): LinearTrackingView | undefined {
    const description = [goal.objective, `Success criteria:\n${goal.successCriteria}`, `Non-goals:\n${goal.nonGoals.join("\n") || "None specified"}`,
      `Approved paths: ${goal.allowedPaths.join(", ")}`, `Limits: ${goal.standing ? `standing objective, a cycle every ${goal.standing.cadenceMinutes} minutes; per cycle` : `${goal.maxRuns} feature runs`}; ${goal.maxMinutes} minutes; ${goal.maxMembers} agent attempts; ${goal.parallelism} parallel members.`,
      ...(goal.evidence.length ? [`Provided evidence:\n${goal.evidence.join("\n")}`] : [])].join("\n\n");
    const stored = this.register("goal", goal, description, optedInAtCreation, goal.linearIssueId);
    if (!stored) return goal.linearIssueId ? { status: "blocked", reason: "Configure Linear for this project before linking an existing issue." } : undefined;
    this.activeTeams.set(keyOf("goal", goal.id), goal.activeTeamId);
    for (const direction of goal.steering) this.comment(stored, `direction:${direction.revision}`, `User direction for goal revision ${direction.revision}:\n\n${direction.text}\n\nThe approved scope and execution limits remain in force.`);
    for (const outcome of goal.outcomes) this.comment(stored, `outcome:${outcome.revision}`, `User-recorded product outcome: ${outcome.result}\n\n${outcome.summary}\n\nEvidence:\n${outcome.evidence}`);
    if (evidenceStatuses.has(goal.status)) { const status = (name: string) => `${name} goal execution\n\nStatus: ${goal.status}\nFeature runs: ${goal.cycles.length}\nAgent attempts: ${goal.memberCount}\n\nThis is local execution evidence. Linear's workflow status has not been changed.`; this.comment(stored, `status:${goal.revision}:${goal.status}`, status(reportName(this.config)), status(DEFAULT_REPORT_NAME)); }
    this.save(stored); return this.view(stored);
  }
  updateTeam(run: TeamRun | TeamView, optedInAtCreation = false, resumable?: boolean): LinearTrackingView | undefined {
    const parentKey = run.goal ? keyOf("goal", run.goal.id) : undefined;
    const stored = this.register("team", run, run.objective, optedInAtCreation, undefined, parentKey);
    if (!stored) return undefined;
    if (!stored.existing) {
      const title = sharedText(run.title);
      if (!stored.attempted) {
        stored.create.title = title;
        stored.retitle = undefined; stored.retitleWanted = undefined; stored.retitleFailures = 0; stored.retitleRetryAt = 0;
      } else {
        const changed = stored.retitleWanted !== title;
        stored.retitleWanted = title;
        if (stored.issue?.title === title) stored.retitle = undefined;
        else if (changed || !stored.retitle) {
          if (changed) { stored.retitleFailures = 0; stored.retitleRetryAt = 0; }
          stored.retitle = title;
          if (stored.issue) this.force(stored);
        }
      }
    }
    const clock = this.clock(stored);
    for (const member of run.members.filter(member => member.status === "queued")) if (!clock.queued.has(member.memberId)) {
      clock.queued.add(member.memberId); this.force(stored);
      if (parentKey) { const parent = this.records.get(parentKey); if (parent) this.force(parent); }
    }
    for (const direction of run.steering) this.comment(stored, `direction:${direction.revision}`, `${direction.source ? inputSourceLabel(direction.source) : "User"} direction for feature revision ${direction.revision}:\n\n${direction.text}\n\nThe approved scope and execution limits remain in force.`);
    if (!run.missionId) for (const decision of run.decisions) {
      this.comment(stored, `question:${decision.id}`, `Agent question for feature revision ${decision.revision}:\n\n${decisionAuthorityQuestion(decision)}${decision.recommendation ? `\n\n${recommendationLine(decision.recommendation)}` : ""}`);
      if (decision.answer) this.comment(stored, `answer:${decision.id}`, `${decision.answeredBy === "connector" ? decisionAnswerLabel(decision) : decision.answeredBy === "coordinator" ? "Coordinator" : "User"} answer for feature revision ${decision.revision}:\n\n${decision.answer}`);
    }
    if (run.brief) this.comment(stored, `brief:${run.revision}`, [`Proposed feature: ${run.brief.title}`, run.brief.problem,
      `Acceptance criteria:\n${run.brief.acceptance.join("\n")}`, `Expected outcome:\n${run.brief.expectedOutcome}`].join("\n\n"));
    if (run.deliveryReceipt) {
      const receipt = run.deliveryReceipt;
      this.comment(stored, `delivery:${receipt.revision}:${receipt.headCommit}`, `Delivery agent reported a merged pull request: ${receipt.pullRequestUrl}\n\nReviewed head: ${receipt.headCommit}\nReported merge commit: ${receipt.mergeCommit}\n\n${receipt.summary}\n\nThis is agent-reported delivery evidence, not independent host verification or a product outcome.`);
    }
    for (const decision of run.permissionDecisions ?? []) {
      if (!["answered", "escalated", "stale", "uncertain"].includes(decision.status)) continue;
      this.comment(stored, `permission:${decision.id}:${decision.status}`,
        `Delegated permission decision ${decision.id}\n\nStatus: ${decision.status}\nRun revision: ${decision.revision}\nTarget member: ${decision.targetMemberId}\nTarget session: ${decision.targetSessionId}\nPrompt: ${decision.promptId}\nCoordinator member: ${decision.coordinatorMemberId ?? "not assigned"}\nAnswer request: ${decision.answerRequestId}\nDelivery: ${decision.receipt ? `${decision.receipt.state}; ${decision.receipt.result ?? "unconfirmed"}; journal sequence ${decision.receipt.seq}` : decision.status === "uncertain" ? "dispatch or result unconfirmed" : "no recorded dispatch"}\n\nThe owner delegated one-shot tool decisions under this run's pinned repository policy. Approval is separate from successful tool execution. This comment omits prompt content and the coordinator's summary.`);
    }
    if (evidenceStatuses.has(run.status) && (run.status !== "blocked" || resumable !== undefined && !run.missionId)) {
      const checks = run.checks.filter(check => check.revision === run.revision);
      const flag = run.status === "blocked" ? `Reason: ${sharedText(run.reason ?? "not recorded")}\nNext step: ${run.goal ? "inspect the goal that owns this run, then approve new work for it if it should continue."
        : resumable ? `run \`infinite team resume ${run.id}\` to replan from the integrated work.` : "inspect the run's evidence, then start a new run to continue."}\n` : "";
      const status = (name: string) => `${name} feature execution\n\nStatus: ${run.status}\n${flag}Agent attempts: ${run.members.length}\nChecks passed: ${checks.filter(check => check.status === "passed").length}/${checks.length}\nIndependent review: ${run.review?.verdict ?? "not recorded"}\n\nChecks and review describe code readiness. They do not establish a product outcome or change Linear's workflow status.`;
      this.comment(stored, `status:${run.revision}:${run.status}`, status(reportName(this.config)), status(DEFAULT_REPORT_NAME));
    }
    if (!run.missionId && run.status === "blocked" && stored.label !== "added" && stored.label !== "add") { stored.label = "add"; stored.labelFailures = 0; stored.labelRetryAt = 0; }
    else if ((run.missionId || run.status !== "blocked") && (stored.label === "added" || stored.label === "add")) { stored.label = "remove"; stored.labelFailures = 0; stored.labelRetryAt = 0; }
    this.save(stored); return this.view(stored);
  }
  getGoal(id: string) { return this.get("goal", id); }
  getTeam(id: string, current = false) { return this.get("team", id, current); }
  async confirmTeam(id: string): Promise<LinearTrackingView | undefined> {
    const deadline = Date.now() + confirmWaitMs;
    while (this.timer && !this.closed && Date.now() < deadline && Date.now() >= this.retryUntil && this.get("team", id, true)?.status === "pending")
      await new Promise(resolve => setTimeout(resolve, 100));
    return this.get("team", id, true);
  }
  private get(kind: Stored["kind"], id: string, current = false) {
    const stored = this.records.get(keyOf(kind, id));
    if (!stored) return undefined;
    if (stored.error || !this.isFresh(stored, this.window(stored, !current))) this.clock(stored).readRequested = true;
    return this.view(stored, !current);
  }
  private gating(stored: Stored) {
    if (stored.blocked) return false;
    if (!stored.terminal) return true;
    const parent = stored.kind === "team" && stored.parentKey ? this.records.get(stored.parentKey) : undefined;
    return Boolean(parent && !parent.terminal && !parent.blocked && this.activeTeams.get(stored.parentKey!) === stored.id);
  }
  private window(stored: Stored, relaxed: boolean) {
    const restartable = stored.kind === "team" && !stored.blocked && this.statuses.get(keyOf(stored.kind, stored.id)) === "blocked";
    return relaxed && !restartable && !this.gating(stored) ? settledFreshnessMs : freshnessMs;
  }
  private isFresh(stored: Stored, windowMs = freshnessMs) {
    const clock = this.clock(stored);
    return Boolean(stored.issue && stored.checkedAt && Date.now() - Date.parse(stored.checkedAt) < windowMs && clock.verified === clock.requested);
  }
  private pendingComments(stored: Stored) { return Object.values(stored.comments).some(comment => !comment.delivered); }
  private pendingLabel(stored: Stored) { return (stored.label === "add" || stored.label === "remove") && (stored.labelRetryAt ?? 0) <= Date.now(); }
  private pendingRetitle(stored: Stored) { return Boolean(stored.retitle && (stored.retitleRetryAt ?? 0) <= Date.now() && (stored.retitleSent?.length ?? 0) < RETITLE_SENT_LIMIT); }
  private view(stored: Stored, relaxed = false): LinearTrackingView {
    this.configuration(stored);
    const issue: LinearIssueView | undefined = stored.issue ? {
      id: stored.issue.id, identifier: stored.issue.identifier, url: stored.issue.url,
      title: stored.issue.title, description: stored.issue.description,
      state: { name: stored.issue.state.name, type: stored.issue.state.type }, updatedAt: stored.issue.updatedAt,
    } : undefined;
    const checked = stored.checkedAt ? { checkedAt: stored.checkedAt } : {};
    const withIssue = issue ? { issue } : {};
    if (stored.blocked) return { status: "blocked", reason: stored.blocked, ...checked, ...withIssue };
    const waiting = (status: "pending" | "error", reason: string): LinearTrackingView => {
      const retryAt = this.retryUntil > Date.now() ? Math.max(this.retryUntil, stored.retryAt) : 0;
      const waitReason = retryAt ? rateLimitReason(retryAt) : reason;
      const retry = retryAt ? { retryAt: at(retryAt) } : {};
      if (status === "error") return { status: "error", reason: waitReason, ...checked, ...retry, ...withIssue };
      return { status: "pending", reason: waitReason, ...checked, ...retry, ...withIssue };
    };
    if (stored.parentKey) {
      const parent = this.records.get(stored.parentKey), current = !relaxed || this.gating(stored);
      if (parent && current && !this.isFresh(parent)) this.clock(parent).readRequested = true;
      const gate = parent ? this.view(parent, !current) : undefined;
      if (gate?.status === "blocked") return { status: "blocked", reason: gate.reason, ...checked, ...withIssue };
      if (!gate || gate.status !== "synced") return waiting(gate?.status === "error" ? "error" : "pending", gate?.reason ?? "Waiting for the parent goal's Linear issue.");
    }
    if (stored.error) return waiting("error", stored.error);
    if (!issue || !this.isFresh(stored, this.window(stored, relaxed)) || this.pendingComments(stored)) {
      return waiting("pending", "Waiting for Linear to confirm current requirements and execution evidence.");
    }
    return { status: "synced", issue, ...checked };
  }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => {
      if (this.pumping || this.closed) return;
      this.pumping = true;
      void this.pump().catch(() => {}).finally(() => { this.pumping = false; });
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); for (const request of this.requests) request.abort(); }
  private failure(stored: Stored, error: unknown) {
    if (this.closed) return;
    stored.failures++; stored.error = new LinearFailure().message;
    stored.retryAt = Date.now() + Math.max(Math.min(30000, 1000 * 2 ** Math.min(stored.failures - 1, 5)), error instanceof LinearFailure ? error.retryAfterMs : 0);
    this.save(stored);
  }
  private success(stored: Stored) {
    if (this.isFresh(stored) && !this.pendingComments(stored)) { stored.error = undefined; stored.failures = 0; stored.retryAt = 0; }
    this.save(stored);
  }
  private accept(stored: Stored, issue: Issue, generation: number, created = false) {
    if (this.closed) return;
    if (issue.team.id !== stored.teamId || (stored.linearProjectId !== undefined && issue.project?.id !== stored.linearProjectId)
      || (!stored.existing && (issue.id !== stored.create.id || (issue.parent?.id ?? undefined) !== stored.create.parentId)))
      stored.blocked ??= "The Linear issue belongs to a different team, project, or parent. Its execution binding cannot be used.";
    if (!created && !stored.baseline && !stored.existing && (issue.title !== stored.create.title || createMatchNormalized(issue.description) !== createMatchNormalized(stored.create.description)))
      stored.blocked ??= "The created Linear issue no longer matches the saved requirements. Start a newly approved run.";
    if (issue.archivedAt || !["triage", "backlog", "unstarted", "started"].includes(issue.state.type))
      stored.blocked ??= "The Linear issue is closed, archived, or uses an unsupported workflow state. Further execution is stopped.";
    const prior = stored.issue;
    if (!created) {
      const sent = Boolean(stored.retitleSent?.some(value => value.title === issue.title)) && issue.title !== prior?.title;
      if ((stored.retitle || stored.retitleSent?.length || sent) && prior && (issue.project?.id ?? null) !== (prior.project?.id ?? null))
        stored.blocked ??= "The Linear issue requirements or parent changed. Review the updated issue and start a newly approved run.";
      if (!stored.blocked && sent && stored.baseline && prior && stored.baseline === scopeHash(prior, stored.linearProjectId)
        && scopeHash(issue, stored.linearProjectId) === scopeHash({ ...prior, title: issue.title }, stored.linearProjectId)) {
        stored.baseline = scopeHash(issue, stored.linearProjectId);
        stored.retitleFailures = 0; stored.retitleRetryAt = 0;
        if (stored.retitleWanted && issue.title !== stored.retitleWanted) stored.retitle ??= stored.retitleWanted;
      }
      if (!stored.blocked && stored.retitleWanted !== undefined && issue.title === stored.retitleWanted) {
        stored.retitle = undefined; stored.retitleFailures = 0; stored.retitleRetryAt = 0;
      }
    }
    if (stored.baseline && stored.baseline !== scopeHash(issue, stored.linearProjectId)) stored.blocked ??= "The Linear issue requirements or parent changed. Review the updated issue and start a newly approved run.";
    stored.issue = issue; stored.baseline ??= scopeHash(issue, stored.linearProjectId); stored.checkedAt = new Date().toISOString();
    this.clock(stored).verified = generation; this.clock(stored).readRequested = false; this.success(stored);
  }
  private async pump() {
    if (Date.now() < this.retryUntil) return;
    const records = [...this.records.values()];
    for (const stored of records) this.configuration(stored);
    const initial = records.filter(value => {
      if (value.issue || value.blocked || value.retryAt > Date.now()) return false;
      if (!value.parentKey) return true;
      const parent = this.records.get(value.parentKey);
      return parent && this.view(parent).status === "synced";
    });
    for (const stored of initial.slice(0, 8)) {
      if (this.closed) return;
      try { await this.initialize(stored); } catch (error) { this.failure(stored, error); }
    }
    const due = records.filter(stored => stored.issue && this.configuration(stored) && stored.retryAt <= Date.now() && !this.isFresh(stored)
      && (stored.blocked ? this.clock(stored).readRequested
        : this.gating(stored) || this.pendingComments(stored) || this.pendingLabel(stored) || this.pendingRetitle(stored) || this.clock(stored).readRequested || this.clock(stored).requested !== this.clock(stored).verified));
    const batches: Stored[][] = [];
    let bytes = 0;
    const size = (stored: Stored) => Buffer.byteLength(JSON.stringify(stored.issue)) + 256;
    const fits = (stored: Stored) => batches.length > 0 && batches.at(-1)!.length < 100 && bytes + size(stored) <= maxResponseBytes / 2;
    for (const stored of due) {
      if (fits(stored)) batches.at(-1)!.push(stored); else { batches.push([stored]); bytes = 0; }
      bytes += size(stored);
    }
    const age = (stored: Stored) => Date.now() - Date.parse(stored.checkedAt!);
    for (const stored of records.filter(value => value.issue && value.checkedAt && !value.blocked && value.retryAt <= Date.now() && !due.includes(value)
      && age(value) > this.window(value, true) / 2).sort((a, b) => age(b) - age(a))) {
      if (!fits(stored)) break;
      batches.at(-1)!.push(stored); bytes += size(stored);
    }
    for (const batch of batches.slice(0, 10)) {
      if (this.closed) return;
      const generations = batch.map(stored => this.clock(stored).requested);
      try {
        const issues = await this.issues([...new Set(batch.map(stored => stored.issue!.id))]);
        if (this.closed) return;
        for (const [position, stored] of batch.entries()) {
          const issue = issues.get(stored.issue!.id);
          if (issue) this.accept(stored, issue, generations[position]);
          else {
            stored.blocked = "The linked Linear issue is missing or no longer accessible. Further execution is stopped.";
            stored.checkedAt = new Date().toISOString();
            this.clock(stored).verified = generations[position];
            this.clock(stored).readRequested = false;
            this.save(stored);
          }
        }
      } catch (error) { for (const stored of batch) this.failure(stored, error); }
    }
    for (const stored of records.filter(value => value.issue && !value.blocked && value.retryAt <= Date.now() && this.isFresh(value))) {
      if (this.closed) return;
      if (this.pendingRetitle(stored) && this.open()) {
        try { await this.applyRetitle(stored); }
        catch (error) {
          if (this.closed) return;
          stored.retitleFailures = (stored.retitleFailures ?? 0) + 1;
          const backoff = Math.min(30 * 60000, 30000 * 2 ** Math.min(stored.retitleFailures - 1, 6));
          stored.retitleRetryAt = Date.now() + Math.max(backoff, error instanceof LinearFailure ? error.retryAfterMs : 0); this.save(stored);
        }
      }
      try {
        for (const comment of Object.values(stored.comments).filter(comment => !comment.delivered).slice(0, 8)) {
          await this.deliver(stored, comment); if (this.closed) return;
        }
        this.success(stored);
      } catch (error) { this.failure(stored, error); continue; }
      if (this.pendingLabel(stored) && this.open()) {
        try { await this.applyLabel(stored); }
        catch (error) {
          if (this.closed) return;
          stored.labelFailures = (stored.labelFailures ?? 0) + 1;
          const backoff = Math.min(30 * 60000, 30000 * 2 ** Math.min(stored.labelFailures - 1, 6));
          stored.labelRetryAt = Date.now() + Math.max(backoff, error instanceof LinearFailure ? error.retryAfterMs : 0); this.save(stored);
        }
      }
    }
  }
  private async initialize(stored: Stored) {
    const generation = this.clock(stored).requested;
    if (stored.parentKey) {
      const parent = this.records.get(stored.parentKey);
      if (!parent || this.view(parent).status !== "synced") return;
      if (!stored.create.parentId) { stored.create.parentId = parent.issue!.id; this.save(stored); }
    }
    if (stored.existing) {
      const data = await this.graphql("InfiniteLinearIssue", `query InfiniteLinearIssue($id: String!) { issue(id: $id) { ${issueFields} } }`, { id: stored.lookup });
      if (this.closed) return;
      if (data.issue === null) { stored.blocked = "The requested Linear issue is missing or inaccessible."; this.save(stored); return; }
      this.accept(stored, issueSchema.parse(data.issue), generation); return;
    }
    if (stored.attempted) {
      const existing = (await this.issues([stored.create.id])).get(stored.create.id);
      if (this.closed) return;
      if (existing) { this.accept(stored, existing, generation); return; }
    }
    stored.attempted = true; this.save(stored);
    const data = await this.graphql("InfiniteLinearIssueCreate", `mutation InfiniteLinearIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${issueFields} } } }`, { input: stored.create });
    if (this.closed) return;
    const result = z.object({ success: z.literal(true), issue: issueSchema }).parse(data.issueCreate);
    this.accept(stored, result.issue, generation, true);
  }
  private async applyRetitle(stored: Stored) {
    const prior = stored.issue!, title = stored.retitle!, generation = this.clock(stored).requested;
    const attempt = { id: randomUUID(), title }, delivery = { sent: false, answered: false };
    stored.retitleSent = [...(stored.retitleSent ?? []), attempt]; this.save(stored);
    let updated: Issue;
    try {
      const data = await this.graphql("InfiniteLinearIssueUpdate", `mutation InfiniteLinearIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${issueFields} } } }`,
        { id: prior.id, input: { title } }, false, delivery);
      if (this.closed) return;
      updated = z.object({ success: z.literal(true), issue: issueSchema }).parse(data.issueUpdate).issue;
    } catch (error) {
      if (!delivery.sent || delivery.answered) { stored.retitleSent = stored.retitleSent?.filter(value => value.id !== attempt.id); this.save(stored); }
      throw error;
    }
    this.accept(stored, updated, generation);
    stored.retitleSent = stored.retitleSent?.filter(value => value.id !== attempt.id); this.save(stored);
  }
  private async applyLabel(stored: Stored) {
    const adding = stored.label === "add", teamId = stored.issue!.team.id, cached = this.labels.has(teamId);
    const change = async (labelId: string) => {
      const mutation = adding ? "issueAddLabel" : "issueRemoveLabel", operation = adding ? "InfiniteLinearIssueAddLabel" : "InfiniteLinearIssueRemoveLabel";
      const data = await this.graphql(operation, `mutation ${operation}($id: String!, $labelId: String!) { ${mutation}(id: $id, labelId: $labelId) { success } }`, { id: stored.issue!.id, labelId }, false);
      z.object({ success: z.literal(true) }).parse(data[mutation]);
    };
    let labelId = await this.blockedLabel(teamId, adding);
    if (this.closed) return;
    if (labelId) {
      try { await change(labelId); }
      catch (error) {
        if (error instanceof LinearFailure && error.retryAfterMs > 0) throw error;
        this.labels.delete(teamId);
        if (!cached || this.closed) throw error;
        labelId = await this.blockedLabel(teamId, adding);
        if (labelId) await change(labelId);
      }
      if (this.closed) return;
    }
    stored.label = adding ? "added" : undefined; stored.labelFailures = 0; stored.labelRetryAt = 0; this.save(stored);
  }
  private async blockedLabel(teamId: string, create: boolean) {
    const cached = this.labels.get(teamId);
    if (cached) return cached;
    const data = await this.graphql("InfiniteLinearLabels", "query InfiniteLinearLabels($filter: IssueLabelFilter!) { issueLabels(filter: $filter, first: 50) { nodes { id name team { id } } } }", { filter: { name: { eqIgnoreCase: BLOCKED_LABEL } } }, false);
    const nodes = z.object({ nodes: z.array(labelSchema).max(50) }).parse(data.issueLabels).nodes;
    let label = nodes.find(node => node.team?.id === teamId) ?? nodes.find(node => node.team === null);
    if (!label && create) {
      const created = await this.graphql("InfiniteLinearLabelCreate", "mutation InfiniteLinearLabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name team { id } } } }", { input: { name: BLOCKED_LABEL, color: "#eb5757", teamId } }, false);
      label = z.object({ success: z.literal(true), issueLabel: labelSchema }).parse(created.issueLabelCreate).issueLabel;
    }
    if (label) this.labels.set(teamId, label.id);
    return label?.id;
  }
  private async issues(ids: string[]) {
    const result = new Map<string, Issue>(); let after: string | undefined;
    for (let page = 0; page < 3; page++) {
      const data = await this.graphql("InfiniteLinearIssues", `query InfiniteLinearIssues($filter: IssueFilter!, $first: Int!, $after: String) { issues(filter: $filter, includeArchived: true, first: $first, after: $after) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`, { filter: { id: { in: ids } }, first: Math.min(100, Math.max(1, ids.length)), ...(after ? { after } : {}) });
      const connection = z.object({ nodes: z.array(issueSchema).max(100), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }).parse(data.issues);
      for (const issue of connection.nodes) {
        if (!ids.includes(issue.id) || result.has(issue.id)) throw new LinearFailure();
        result.set(issue.id, issue);
      }
      if (!connection.pageInfo.hasNextPage) return result;
      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) throw new LinearFailure();
      after = connection.pageInfo.endCursor;
    }
    throw new LinearFailure();
  }
  private async deliver(stored: Stored, comment: Comment) {
    const verify = (value: unknown) => {
      const received = commentSchema.parse(value);
      if (received.id !== comment.id || received.issue.id !== stored.issue!.id || normalized(received.body) !== normalized(comment.body)) {
        stored.blocked = "A Linear evidence receipt conflicts with its saved issue or content."; this.save(stored); return false;
      }
      comment.delivered = true; this.save(stored); return true;
    };
    if (comment.attempted) {
      const data = await this.graphql("InfiniteLinearComment", "query InfiniteLinearComment($filter: CommentFilter!) { comments(filter: $filter, includeArchived: true, first: 1) { nodes { id body issue { id } } } }", { filter: { id: { eq: comment.id } } });
      if (this.closed) return;
      const result = z.object({ nodes: z.array(commentSchema).max(1) }).parse(data.comments);
      if (result.nodes.length) { verify(result.nodes[0]); return; }
    }
    comment.attempted = true; this.save(stored);
    const data = await this.graphql("InfiniteLinearCommentCreate", "mutation InfiniteLinearCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body issue { id } } } }", { input: { id: comment.id, issueId: stored.issue!.id, body: comment.body } });
    if (this.closed) return;
    const result = z.object({ success: z.literal(true), comment: commentSchema }).parse(data.commentCreate);
    verify(result.comment);
  }
  request(operationName: string, query: string, variables: unknown): Promise<Record<string, unknown>> {
    return this.graphql(operationName, query, variables);
  }
  private async graphql(operationName: string, query: string, variables: unknown, shared = true, delivery?: { sent: boolean; answered: boolean }): Promise<Record<string, unknown>> {
    if (this.closed) throw new LinearFailure();
    if (Date.now() < this.retryUntil) throw new LinearFailure(this.retryUntil - Date.now());
    const api = this.config.linear;
    if (!api) throw new LinearFailure();
    const url = new URL(api.endpoint ?? endpoint);
    if (url.href !== endpoint && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new LinearFailure();
    let token: string;
    try { token = readFileSync(api.apiKeyFile, "utf8").trim(); } catch { throw new LinearFailure(); }
    if (!token || token.length > 8192 || /\s/.test(token)) throw new LinearFailure();
    const admission = await this.admit(shared);
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000); timeout.unref();
    try {
      if (delivery) delivery.sent = true;
      this.tally(1, 0);
      const response = await fetch(url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify({ operationName, query, variables }) });
      const seen = this.observe(response, operationName);
      const reader = response.body?.getReader();
      if (!reader) throw new LinearFailure();
      const chunks: Buffer[] = []; let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) { await reader.cancel(); throw new LinearFailure(); }
        chunks.push(Buffer.from(value));
      }
      let body: { data?: Record<string, unknown> | null; errors?: unknown[] } | undefined;
      try { body = z.object({ data: z.record(z.string(), z.unknown()).nullable().optional(), errors: z.array(z.unknown()).optional() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { if (response.status !== 429) throw error; }
      if (delivery && (body || response.status === 429)) delivery.answered = response.status < 500;
      if (!response.ok || !body || body.errors?.length || !body.data) {
        const limited = response.status === 429 || body?.errors?.some(error => z.object({ extensions: z.object({ code: z.literal("RATELIMITED") }) }).safeParse(error).success);
        if (limited) {
          this.limitStreak++;
          const wait = this.limitDelay(response, seen);
          if (shared) { this.retryUntil = Math.max(this.retryUntil, Date.now() + wait.delay); this.recovering = true; }
          this.limited(operationName, response, wait, shared);
          throw new LinearFailure(wait.delay);
        }
        this.answered(admission.probe);
        throw new LinearFailure();
      }
      this.answered(admission.probe);
      return body.data;
    } catch (error) { throw error instanceof LinearFailure ? error : new LinearFailure(); }
    finally { clearTimeout(timeout); this.requests.delete(controller); admission.release(); }
  }
  private async admit(shared: boolean): Promise<{ probe: boolean; release: () => void }> {
    for (;;) {
      if (this.closed) throw new LinearFailure();
      if (Date.now() < this.retryUntil) throw new LinearFailure(this.retryUntil - Date.now());
      if (!this.recovering) return { probe: false, release: () => {} };
      if (!shared) throw new LinearFailure(fallbackPauseMs);
      if (!this.probe) {
        let done!: () => void;
        this.probe = new Promise<void>(resolve => { done = resolve; });
        return { probe: true, release: () => { this.probe = undefined; done(); } };
      }
      await this.probe;
    }
  }
  private answered(probe: boolean) {
    if (!probe && this.recovering) return;
    this.limitStreak = 0;
    this.recovering = false;
  }
  private limitDelay(response: Response, { requests, complexity, endpoint, cost }: ReturnType<LinearService["observe"]>): RateLimitWait {
    const retryAfter = response.headers.get("retry-after")?.trim();
    const stated = !retryAfter ? undefined : /^\d{1,10}$/.test(retryAfter) ? Number(retryAfter) * 1000
      : /[A-Za-z]/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter)) ? Date.parse(retryAfter) - Date.now() - serverSkew(response) : undefined;
    if (stated !== undefined) {
      const delay = Math.min(maxRetryAfterMs, Math.max(1000, stated));
      return { delay, basis: "retry-after", retryAfterSeconds: Math.ceil(delay / 1000) };
    }
    const families = [requests, complexity, endpoint].filter((value): value is LinearLimitView => Boolean(value?.resetAt));
    const spent = families.filter(value => value.remaining !== undefined && (value.remaining <= 0
      || value === complexity && cost !== undefined && value.remaining < cost));
    const resets = (spent.length ? spent : families).map(value => Date.parse(value.resetAt!) - Date.now()).filter(value => value > 0);
    if (resets.length) return { delay: Math.min(maxPauseMs, Math.max(1000, ...resets)), basis: "reset" };
    return { delay: Math.min(maxPauseMs, fallbackPauseMs * 2 ** Math.min(this.limitStreak - 1, 4)), basis: "fallback" };
  }
  private observe(response: Response, operation: string) {
    const count = (name: string) => {
      const value = response.headers.get(name)?.trim();
      return value && /^\d{1,16}(?:\.\d{1,6})?$/.test(value) ? Number(value) : undefined;
    };
    const skew = serverSkew(response);
    const family = (prefix: string): LinearLimitView | undefined => {
      const limit = count(`${prefix}-limit`), remaining = count(`${prefix}-remaining`), raw = count(`${prefix}-reset`);
      if (limit === undefined && remaining === undefined && raw === undefined) return undefined;
      const reset = raw === undefined ? undefined : raw >= 1e12 && raw < 1e14 ? raw : raw >= 1e9 && raw < 1e11 ? raw * 1000 : undefined;
      return { ...(limit !== undefined ? { limit } : {}), ...(remaining !== undefined ? { remaining } : {}),
        ...(reset !== undefined ? { resetAt: new Date(reset - skew).toISOString() } : {}) };
    };
    const requests = family("x-ratelimit-requests"), complexity = family("x-ratelimit-complexity"), endpoint = family("x-ratelimit-endpoint-requests");
    const cost = count("x-complexity"), name = response.headers.get("x-ratelimit-endpoint-name")?.trim(), observedAt = new Date().toISOString();
    if (cost !== undefined) this.tally(0, cost);
    if (!requests && !complexity && !endpoint && cost === undefined) return { requests, complexity, endpoint, cost };
    this.limits = { observedAt, operation, ...(requests ? { requests } : {}), ...(complexity ? { complexity } : {}), ...(cost !== undefined ? { lastComplexity: cost } : {}),
      ...(endpoint ? { endpoint: { ...endpoint, ...(name && /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(name) ? { name } : {}), observedAt } }
        : this.limits?.endpoint ? { endpoint: this.limits.endpoint } : {}) };
    return { requests, complexity, endpoint, cost };
  }
  private limited(operation: string, response: Response, { delay, basis, retryAfterSeconds }: RateLimitWait, shared: boolean) {
    this.lastLimit = { at: new Date().toISOString(), operation, httpStatus: response.status,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}), waitSeconds: Math.ceil(delay / 1000), basis, shared };
    if (Date.now() - this.limitLoggedAt < 60000) return;
    this.limitLoggedAt = Date.now();
    const limit = (label: string, value?: LinearLimitView) => value ? `${label} ${value.remaining ?? "?"}/${value.limit ?? "?"} left, resets ${value.resetAt ?? "unknown"}` : `${label} not reported`;
    const sent = this.lastHour();
    console.warn(`Linear rate limit on ${operation} (HTTP ${response.status}): ${shared ? "the host's Linear requests pause" : "this optional request backs off"} until ${at(Date.now() + delay)}. `
      + `${limit("Requests", this.limits?.requests)}; ${limit("complexity", this.limits?.complexity)}${this.limits?.endpoint ? `; ${limit(`endpoint ${this.limits.endpoint.name ?? "limit"}`, this.limits.endpoint)}` : ""}. `
      + `This host sent ${sent.requests} requests (${sent.complexity} complexity points reported) in the last hour.`);
  }
  private open() { return Date.now() >= this.retryUntil && !this.recovering; }
  private tally(requests: number, complexity: number) {
    const minute = Math.floor(Date.now() / 60000);
    while (this.usage.length && this.usage[0].minute <= minute - 60) this.usage.shift();
    let bucket = this.usage.at(-1);
    if (!bucket || bucket.minute !== minute) { bucket = { minute, requests: 0, complexity: 0 }; this.usage.push(bucket); }
    bucket.requests += requests; bucket.complexity += complexity;
  }
  private lastHour() {
    const minute = Math.floor(Date.now() / 60000), live = this.usage.filter(bucket => bucket.minute > minute - 60);
    return { requests: live.reduce((sum, bucket) => sum + bucket.requests, 0), complexity: Math.ceil(live.reduce((sum, bucket) => sum + bucket.complexity, 0)) };
  }
  status(): LinearBridgeStatus {
    const records = [...this.records.values()];
    return { configured: Boolean(this.config.linear), records: { total: records.length, gating: records.filter(stored => this.gating(stored)).length },
      sentLastHour: this.lastHour(), ...(this.limits ? { limits: structuredClone(this.limits) } : {}),
      ...(this.retryUntil > Date.now() ? { pausedUntil: at(this.retryUntil) } : {}), ...(this.lastLimit ? { lastRateLimit: { ...this.lastLimit } } : {}) };
  }
}
