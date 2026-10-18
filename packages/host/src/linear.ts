import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./types.js";
import type { ProductGoal } from "./goal-types.js";
import type { TeamRun, TeamView } from "./team-types.js";
import type { LinearTrackingView } from "./linear-types.js";
import { unseal, writeSealed } from "./vault.js";

const endpoint = "https://api.linear.app/graphql";
const freshnessMs = 30000;
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
type Issue = z.infer<typeof issueSchema>;
type Comment = { id: string; body: string; attempted: boolean; delivered: boolean };
type Stored = {
  kind: "goal" | "team"; id: string; projectId: string; teamId: string; linearProjectId?: string; endpoint: string;
  lookup: string; existing: boolean; parentKey?: string;
  create: { id: string; title: string; description: string; teamId: string; projectId?: string; parentId?: string };
  attempted: boolean; issue?: Issue; baseline?: string; checkedAt?: string;
  blocked?: string; error?: string; failures: number; retryAt: number;
  terminal: boolean; comments: Record<string, Comment>;
};
type Freshness = { requested: number; verified: number; queued: Set<string>; readRequested: boolean };
const keyOf = (kind: Stored["kind"], id: string) => `${kind}:${id}`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminalStatuses = new Set(["ready-for-review", "merged", "no-change", "no-opportunity", "blocked", "cancelled", "limit-reached", "achieved"]);
const evidenceStatuses = new Set([...terminalStatuses, "needs-input", "paused"]);
const normalized = (value: string | null) => (value ?? "").replace(/\r\n/g, "\n").trim();
const scopeHash = (issue: Issue, linearProjectId?: string) => hash({ title: issue.title, description: normalized(issue.description), teamId: issue.team.id,
  ...(linearProjectId !== undefined ? { projectId: issue.project?.id ?? null } : {}), parentId: issue.parent?.id ?? null });

// Only deliberately selected requirements and user directions leave the host.
// Machine paths sometimes appear in those fields; never publish them as evidence.
function sharedText(value: string) {
  return value.replace(/(?:\/(?:Users|home|tmp|private\/tmp|private\/var|var\/folders)\/|~\/|[A-Za-z]:\\)[^\s<>"'`]+/g, "[local path omitted]");
}

class LinearFailure extends Error {
  constructor(readonly retryAfterMs = 0) { super("Linear could not confirm synchronization. Check the connection and host credential; execution is waiting."); }
}

/** The bridge owns HTTP and its outbox; execution queues only inspect cached gates. */
export class LinearService {
  private readonly records = new Map<string, Stored>();
  private readonly saved = new Map<string, string>();
  private readonly fresh = new Map<string, Freshness>();
  private readonly directory: string;
  private readonly requests = new Set<AbortController>();
  private timer?: NodeJS.Timeout;
  private pumping = false;
  private closed = false;
  private retryUntil = 0;

  constructor(private readonly config: Config, private readonly key: Buffer) {
    this.directory = join(config.stateDir, "linear");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^(goal|team)-[a-f0-9-]{36}\.sealed$/.test(name))) {
      const recordKey = file.slice(0, -7).replace("-", ":");
      const stored = unseal<Stored>(key, `linear:${recordKey}`, readFileSync(join(this.directory, file), "utf8"));
      if (keyOf(stored.kind, stored.id) !== recordKey) throw new Error("A Linear tracking record cannot be authenticated.");
      this.records.set(recordKey, stored); this.saved.set(recordKey, JSON.stringify(stored));
      this.fresh.set(recordKey, { requested: 1, verified: 0, queued: new Set(), readRequested: false });
    }
  }

  private save(stored: Stored) {
    if (this.closed) return;
    const recordKey = keyOf(stored.kind, stored.id), serialized = JSON.stringify(stored);
    if (this.saved.get(recordKey) === serialized) return;
    writeSealed(join(this.directory, `${stored.kind}-${stored.id}.sealed`), this.key, `linear:${recordKey}`, stored);
    this.saved.set(recordKey, serialized);
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
      this.configuration(prior);
      if (prior.projectId !== value.projectId || prior.parentKey !== parentKey || (existing && prior.lookup !== existing))
        prior.blocked ??= "The Linear issue binding changed. Start a newly approved run with the intended issue.";
      prior.terminal = terminalStatuses.has(value.status); this.save(prior); return prior;
    }
    // A current project mapping must never enroll an older local run. Only a
    // run that persisted its creation-time choice can create a new outbox row.
    if (!optedInAtCreation) return undefined;
    const project = this.config.projects.find(project => project.id === value.projectId);
    if (!project?.linear) return undefined;
    // Linear requires UUID v4 create IDs; older local IDs may use another UUID version.
    const createId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.id) ? value.id : randomUUID();
    const stored: Stored = { kind, id: value.id, projectId: value.projectId, teamId: project.linear.teamId, ...(project.linear.projectId ? { linearProjectId: project.linear.projectId } : {}),
      endpoint: this.config.linear?.endpoint ?? endpoint, lookup: existing ?? createId, existing: Boolean(existing),
      ...(parentKey ? { parentKey } : {}), create: { id: createId, title: sharedText(value.title), description: sharedText(description), teamId: project.linear.teamId, ...(project.linear.projectId ? { projectId: project.linear.projectId } : {}) },
      attempted: false, failures: 0, retryAt: 0, terminal: terminalStatuses.has(value.status), comments: {},
    };
    this.records.set(recordKey, stored); this.fresh.set(recordKey, { requested: 1, verified: 0, queued: new Set(), readRequested: false });
    this.configuration(stored); this.save(stored);
    if (parentKey) { const parent = this.records.get(parentKey); if (parent) this.force(parent); }
    return stored;
  }
  private comment(stored: Stored, event: string, text: string) {
    const body = sharedText(text), eventKey = hash({ event, body });
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
      `Approved paths: ${goal.allowedPaths.join(", ")}`, `Limits: ${goal.maxRuns} feature runs; ${goal.maxMinutes} minutes; ${goal.maxMembers} agent attempts; ${goal.parallelism} parallel members.`,
      ...(goal.evidence.length ? [`Provided evidence:\n${goal.evidence.join("\n")}`] : [])].join("\n\n");
    const stored = this.register("goal", goal, description, optedInAtCreation, goal.linearIssueId);
    if (!stored) return goal.linearIssueId ? { status: "blocked", reason: "Configure Linear for this project before linking an existing issue." } : undefined;
    for (const direction of goal.steering) this.comment(stored, `direction:${direction.revision}`, `User direction for goal revision ${direction.revision}:\n\n${direction.text}\n\nThe approved scope and execution limits remain in force.`);
    for (const outcome of goal.outcomes) this.comment(stored, `outcome:${outcome.revision}`, `User-recorded product outcome: ${outcome.result}\n\n${outcome.summary}\n\nEvidence:\n${outcome.evidence}`);
    if (evidenceStatuses.has(goal.status)) this.comment(stored, `status:${goal.revision}:${goal.status}`, `Infinite goal execution\n\nStatus: ${goal.status}\nFeature runs: ${goal.cycles.length}\nAgent attempts: ${goal.memberCount}\n\nThis is local execution evidence. Linear's workflow status has not been changed.`);
    this.save(stored); return this.view(stored);
  }
  updateTeam(run: TeamRun | TeamView, optedInAtCreation = false): LinearTrackingView | undefined {
    const parentKey = run.goal ? keyOf("goal", run.goal.id) : undefined;
    const stored = this.register("team", run, run.objective, optedInAtCreation, undefined, parentKey);
    if (!stored) return undefined;
    const clock = this.clock(stored);
    for (const member of run.members.filter(member => member.status === "queued")) if (!clock.queued.has(member.memberId)) {
      clock.queued.add(member.memberId); this.force(stored);
      if (parentKey) { const parent = this.records.get(parentKey); if (parent) this.force(parent); }
    }
    for (const direction of run.steering) this.comment(stored, `direction:${direction.revision}`, `User direction for feature revision ${direction.revision}:\n\n${direction.text}\n\nThe approved scope and execution limits remain in force.`);
    for (const decision of run.decisions) {
      this.comment(stored, `question:${decision.id}`, `Agent question for feature revision ${decision.revision}:\n\n${decision.question}`);
      if (decision.answer) this.comment(stored, `answer:${decision.id}`, `User answer for feature revision ${decision.revision}:\n\n${decision.answer}`);
    }
    if (run.brief) this.comment(stored, `brief:${run.revision}`, [`Proposed feature: ${run.brief.title}`, run.brief.problem,
      `Acceptance criteria:\n${run.brief.acceptance.join("\n")}`, `Expected outcome:\n${run.brief.expectedOutcome}`].join("\n\n"));
    if (run.deliveryReceipt) {
      const receipt = run.deliveryReceipt;
      this.comment(stored, `delivery:${receipt.revision}:${receipt.headCommit}`, `Delivery agent reported a merged pull request: ${receipt.pullRequestUrl}\n\nReviewed head: ${receipt.headCommit}\nReported merge commit: ${receipt.mergeCommit}\n\n${receipt.summary}\n\nThis is agent-reported delivery evidence, not independent host verification or a product outcome.`);
    }
    if (evidenceStatuses.has(run.status)) {
      const checks = run.checks.filter(check => check.revision === run.revision);
      this.comment(stored, `status:${run.revision}:${run.status}`, `Infinite feature execution\n\nStatus: ${run.status}\nAgent attempts: ${run.members.length}\nChecks passed: ${checks.filter(check => check.status === "passed").length}/${checks.length}\nIndependent review: ${run.review?.verdict ?? "not recorded"}\n\nChecks and review describe code readiness. They do not establish a product outcome or change Linear's workflow status.`);
    }
    this.save(stored); return this.view(stored);
  }
  getGoal(id: string) { return this.get("goal", id); }
  getTeam(id: string) { return this.get("team", id); }
  private get(kind: Stored["kind"], id: string) {
    const stored = this.records.get(keyOf(kind, id));
    if (!stored) return undefined;
    if (!this.isFresh(stored)) this.clock(stored).readRequested = true;
    return this.view(stored);
  }
  private isFresh(stored: Stored) {
    const clock = this.clock(stored);
    return Boolean(stored.issue && stored.checkedAt && Date.now() - Date.parse(stored.checkedAt) < freshnessMs && clock.verified === clock.requested);
  }
  private pendingComments(stored: Stored) { return Object.values(stored.comments).some(comment => !comment.delivered); }
  private view(stored: Stored): LinearTrackingView {
    this.configuration(stored);
    const { issue } = stored;
    const view: LinearTrackingView = { status: "pending", ...(stored.checkedAt ? { checkedAt: stored.checkedAt } : {}),
      ...(issue ? { issue: { id: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title, description: issue.description, state: { name: issue.state.name, type: issue.state.type }, updatedAt: issue.updatedAt } } : {}) };
    if (stored.blocked) return { ...view, status: "blocked", reason: stored.blocked };
    if (stored.parentKey) {
      const parent = this.records.get(stored.parentKey), gate = parent ? this.view(parent) : undefined;
      if (!gate || gate.status !== "synced") return { ...view, status: gate?.status ?? "pending", reason: gate?.reason ?? "Waiting for the parent goal's Linear issue." };
    }
    if (stored.error) return { ...view, status: "error", reason: stored.error };
    if (!this.isFresh(stored) || this.pendingComments(stored)) return { ...view, reason: "Waiting for Linear to confirm current requirements and execution evidence." };
    return { ...view, status: "synced" };
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
  private accept(stored: Stored, issue: Issue, generation: number) {
    if (this.closed) return;
    if (issue.team.id !== stored.teamId || (stored.linearProjectId !== undefined && issue.project?.id !== stored.linearProjectId)
      || (!stored.existing && (issue.id !== stored.create.id || (issue.parent?.id ?? undefined) !== stored.create.parentId)))
      stored.blocked ??= "The Linear issue belongs to a different team, project, or parent. Its execution binding cannot be used.";
    if (!stored.baseline && !stored.existing && (issue.title !== stored.create.title || normalized(issue.description) !== normalized(stored.create.description)))
      stored.blocked ??= "The created Linear issue no longer matches the saved requirements. Start a newly approved run.";
    if (stored.baseline && stored.baseline !== scopeHash(issue, stored.linearProjectId)) stored.blocked ??= "The Linear issue requirements or parent changed. Review the updated issue and start a newly approved run.";
    if (issue.archivedAt || !["triage", "backlog", "unstarted", "started"].includes(issue.state.type))
      stored.blocked ??= "The Linear issue is closed, archived, or uses an unsupported workflow state. Further execution is stopped.";
    stored.issue = issue; stored.baseline ??= scopeHash(issue, stored.linearProjectId); stored.checkedAt = new Date().toISOString();
    this.clock(stored).verified = generation; this.clock(stored).readRequested = false; this.success(stored);
  }
  private async pump() {
    if (Date.now() < this.retryUntil) return;
    const records = [...this.records.values()];
    for (const stored of records) this.configuration(stored);
    // One pump serializes all writes made with the host's configured key.
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
        : !stored.terminal || this.pendingComments(stored) || this.clock(stored).readRequested || this.clock(stored).requested !== this.clock(stored).verified));
    for (let index = 0; index < Math.min(due.length, 1000); index += 100) {
      if (this.closed) return;
      const batch = due.slice(index, index + 100), generations = batch.map(stored => this.clock(stored).requested);
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
      try {
        for (const comment of Object.values(stored.comments).filter(comment => !comment.delivered).slice(0, 8)) {
          await this.deliver(stored, comment); if (this.closed) return;
        }
        this.success(stored);
      } catch (error) { this.failure(stored, error); }
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
    this.accept(stored, result.issue, generation);
  }
  private async issues(ids: string[]) {
    const result = new Map<string, Issue>(); let after: string | undefined;
    for (let page = 0; page < 3; page++) {
      const data = await this.graphql("InfiniteLinearIssues", `query InfiniteLinearIssues($filter: IssueFilter!, $first: Int!, $after: String) { issues(filter: $filter, includeArchived: true, first: $first, after: $after) { nodes { ${issueFields} } pageInfo { hasNextPage endCursor } } }`, { filter: { id: { in: ids } }, first: 100, ...(after ? { after } : {}) });
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
  private async graphql(operationName: string, query: string, variables: unknown): Promise<Record<string, unknown>> {
    if (this.closed) throw new LinearFailure();
    if (Date.now() < this.retryUntil) throw new LinearFailure(this.retryUntil - Date.now());
    const api = this.config.linear;
    if (!api) throw new LinearFailure();
    const url = new URL(api.endpoint ?? endpoint);
    if (url.href !== endpoint && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new LinearFailure();
    let token: string;
    try { token = readFileSync(api.apiKeyFile, "utf8").trim(); } catch { throw new LinearFailure(); }
    if (!token || token.length > 8192 || /\s/.test(token)) throw new LinearFailure();
    const controller = new AbortController(); this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000); timeout.unref();
    try {
      const response = await fetch(url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify({ operationName, query, variables }) });
      const reader = response.body?.getReader();
      if (!reader) throw new LinearFailure();
      const chunks: Buffer[] = []; let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) { await reader.cancel(); throw new LinearFailure(); }
        chunks.push(Buffer.from(value));
      }
      const body = z.object({ data: z.record(z.string(), z.unknown()).nullable().optional(), errors: z.array(z.unknown()).optional() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!response.ok || body.errors?.length || !body.data) {
        const limited = response.status === 429 || body.errors?.some(error => z.object({ extensions: z.object({ code: z.literal("RATELIMITED") }) }).safeParse(error).success);
        if (limited) {
          const resets = ["x-ratelimit-requests-reset", "x-ratelimit-endpoint-requests-reset", "x-ratelimit-complexity-reset"].map(name => Number(response.headers.get(name))).filter(value => Number.isFinite(value) && value > Date.now());
          const retry = Number(response.headers.get("retry-after"));
          const delay = Math.max(1000, ...resets.map(value => value - Date.now()), Number.isFinite(retry) ? retry * 1000 : 0);
          this.retryUntil = Date.now() + delay; throw new LinearFailure(delay);
        }
        throw new LinearFailure();
      }
      return body.data;
    } catch (error) { throw error instanceof LinearFailure ? error : new LinearFailure(); }
    finally { clearTimeout(timeout); this.requests.delete(controller); }
  }
}
