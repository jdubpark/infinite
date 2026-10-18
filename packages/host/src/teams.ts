import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ProviderLimits } from "./provider-limits.js";
import type { Config } from "./types.js";
import type { Manager } from "./manager.js";
import { writeSealed, unseal } from "./vault.js";
import { createTeamSchema, lineupProfiles, resolveLimitFallback, teamActionSchema, teamGoalContextSchema, teamLineupSchema, teamMutationSchema, teamReportEnvelopeSchema, type CreateTeam, type TeamAssignment, type TeamGoalContext, type TeamLineup, type TeamMember, type TeamModelProfile, type TeamRun, type TeamScout, type TeamTask, type TeamView } from "./team-types.js";
import { teamPrompt } from "./team-prompts.js";
import { teamModelLaunch } from "./launch.js";
import type { UsageService } from "./usage-service.js";
import type { LinearService } from "./linear.js";
import { TeamError, assertMemberReadOnly, assertMemberScope, assertTeamPath, captureMemberResult, integrateMemberResult, prepareMemberWorkspace, prepareTeamWorkspace, teamCommand, teamPathAllowed, teamWorkspacePath, validateTeamPlan } from "./team-workspace.js";
export { TeamError } from "./team-workspace.js";

type Mutation = { requestId: string; revision: number; text: string };
type Action = { requestId: string; revision: number };
type StartInProject = <T>(projectId: string, start: () => Promise<T>) => Promise<T>;
type Stored = {
  run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean;
  pending?: { id: string; kind: "prepare" | "member" | "result" | "check"; revision: number };
  halt?: "pause" | "cancel" | "steer" | "block";
  checkHead?: string;
  source?: { path: string; head?: string };
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = () => new Date().toISOString();
const activeMember = (member: TeamMember) => ["queued", "running", "reported", "unavailable"].includes(member.status);
const providerInputReason = "A provider needs user input. Open the member session to respond; the team will not approve it.";
const runtimeUnavailableReason = "An agent runtime is unavailable; the team is waiting for confirmed state.";
const assignment = (member: TeamMember): TeamAssignment => ({ runId: member.runId, memberId: member.memberId, revision: member.revision, role: member.role, ...(member.taskId ? { taskId: member.taskId } : {}) });

/** Durable orchestration; reports describe agent claims, configured checks describe host evidence. */
export class TeamService {
  private readonly records = new Map<string, Stored>();
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private running = false;
  private closed = false;
  private tickQueued = false;
  private readonly commands = new Map<string, AbortController>();
  private readonly directory: string;
  private usage?: UsageService;
  readonly limits: ProviderLimits;
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager, private readonly startInProject: StartInProject, private readonly linear?: LinearService) {
    this.limits = new ProviderLimits(join(config.stateDir, "provider-limits.sealed"), key);
    this.directory = join(config.stateDir, "teams");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `team:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.run.id !== id) throw new TeamError(409, "invalid-team-record", "A team record cannot be authenticated.");
      this.records.set(id, stored);
      if (stored.pending) {
        for (const check of stored.run.checks) if (check.status === "running") { check.status = "interrupted"; check.finishedAt = timestamp(); }
        stored.run.status = "blocked"; stored.halt = "block";
        stored.run.reason = "The host restarted during a workspace or verification operation. Inspect the isolated workspace before starting a new team; the operation will not be replayed.";
        this.event(stored, stored.run.reason);
        // Retain the intent so resume cannot disguise an ambiguous operation.
        this.save(stored);
      }
    }
  }
  useUsage(service: UsageService) { this.usage = service; }
  usageForRuns(ids: string[]) { return this.usage?.aggregate([...new Set(ids)].flatMap(id => this.record(id).run.members)); }
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task); this.serial = next.catch(() => {}); return next;
  }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "team-not-found", "This team does not exist.");
    return stored;
  }
  private view(stored: Stored): TeamView {
    const { members, ...run } = structuredClone(stored.run);
    // Queue evidence from this exact state before a goal can use its sync gate
    // to continue from a newly reviewed or no-change result.
    const tracking = this.linear?.updateTeam(stored.run, stored.run.linearTracking === true);
    run.linear = this.linear?.getTeam(run.id) ?? tracking ?? run.linear;
    return { ...run, ...(this.usage ? { usage: this.usage.aggregate(members) } : {}), providerLimits: this.limits.active(), members: members.map(({ prompt: _prompt, feedback: _feedback, pendingLimit: _pendingLimit, ...member }) => {
      const usage = this.usage?.session(member.sessionId);
      return { ...member, ...(usage?.measured ? { usage } : {}) };
    }) };
  }
  private save(stored: Stored) {
    stored.run.updatedAt = timestamp();
    writeSealed(join(this.directory, `${stored.run.id}.sealed`), this.key, `team:${stored.run.id}`, stored);
  }
  private event(stored: Stored, text: string) {
    stored.run.events.push({ at: timestamp(), text });
    if (stored.run.events.length > 300) stored.run.events.splice(0, stored.run.events.length - 300);
  }
  list(): TeamView[] { return [...this.records.values()].map(record => this.view(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id: string): TeamView { return this.view(this.record(id)); }
  activeForProject(projectId: string) {
    return [...this.records.values()].some(({ run }) => run.projectId === projectId && !["cancelled", "ready-for-review", "no-change"].includes(run.status));
  }
  create(request: CreateTeam): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    return this.createRun(parsed);
  }
  /** Goal authority and model snapshots come from the host, never from a public create body. */
  createForGoal(request: CreateTeam, goal: TeamGoalContext, lineup: TeamLineup, linearTracking = false): Promise<TeamView> {
    return this.createRun(createTeamSchema.parse(request), { goal: teamGoalContextSchema.parse(goal), lineup: teamLineupSchema.parse(lineup) }, linearTracking);
  }
  private createRun(parsed: CreateTeam, internal?: { goal: TeamGoalContext; lineup: TeamLineup }, linearTracking = false): Promise<TeamView> {
    return this.enqueue(async () => {
      // Preserve the fingerprints written before lineup selection existed.
      const { useConfiguredLineup, ...singleProviderRequest } = parsed;
      const prior = this.records.get(parsed.requestId), fingerprint = digest(internal ? { request: parsed, ...internal } : useConfiguredLineup ? parsed : singleProviderRequest);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team request.");
        return this.view(prior);
      }
      const project = this.config.projects.find(item => item.id === parsed.projectId);
      if (!project) throw new TeamError(404, "unknown-project", "The selected project is not configured.");
      if (!this.config.teams || !project.team?.checks.length) throw new TeamError(409, "teams-not-configured", "Configure a team workspace directory and project verification commands before starting a team.");
      const goal = internal ? structuredClone(internal.goal) : undefined;
      const lineup = internal ? structuredClone(internal.lineup) : useConfiguredLineup ? structuredClone(this.config.teams.lineup) : undefined;
      if (useConfiguredLineup && !lineup) throw new TeamError(409, "team-lineup-not-configured", "The requested team lineup is not configured on this host.");
      if (lineup && parsed.provider !== lineup.coordinator.provider)
        throw new TeamError(409, "team-provider-mismatch", "The selected provider must match the configured coordinator provider.");
      const profiles = lineup ? lineupProfiles(lineup) : [];
      const providers = new Set(lineup ? profiles.map(profile => profile.provider) : [parsed.provider]);
      for (const provider of providers) {
        const profile = this.config.agents[provider];
        if (!profile || (provider === "demo" && !this.config.enableDemo)) throw new TeamError(409, "provider-not-configured", "Every selected team provider must be configured and available on this host.");
        if (/(^|\/)sudo$/.test(profile.command) && !this.config.teams.commandPrefix)
          throw new TeamError(409, "team-execution-identity-required", "Configure a team command prefix using the provider's execution identity before starting this team.");
      }
      for (const selection of profiles) {
        try { teamModelLaunch(this.config.agents[selection.provider]!, selection); }
        catch { throw new TeamError(409, "team-model-profile-conflict", "Move model, effort, and fallback-model arguments from provider profiles into the team lineup before starting this team."); }
      }
      const parent = goal?.parentRunId ? this.record(goal.parentRunId).run : undefined;
      if (parent && (parent.goal?.id !== goal!.id || parent.projectId !== parsed.projectId || parent.status !== "ready-for-review" || !parent.headCommit))
        throw new TeamError(409, "invalid-goal-parent", "Continue only from a ready, recorded run of this goal and project.");
      if (parent) assertTeamPath(this.config.teams.workspaceDir, parent.workspace);
      const source = { path: parent?.workspace ?? project.path, ...(parent ? { head: parent.headCommit! } : {}) };
      const parentRevision = parent?.revision;
      const at = timestamp();
      const run: TeamRun = { linearTracking: internal ? linearTracking : Boolean(project.linear), id: parsed.requestId, projectId: parsed.projectId, provider: parsed.provider, ...(lineup ? { lineup } : {}), ...(goal ? { goal } : {}), title: parsed.title, objective: parsed.objective, parallelism: parsed.parallelism, revision: 1, status: "planning", createdAt: at, updatedAt: at, workspace: teamWorkspacePath(this.config.teams.workspaceDir, parsed.requestId), branch: `infinite/team-${parsed.requestId}`, baseCommit: "", tasks: [], members: [], decisions: [], checks: [], steering: [], events: [], round: 0 };
      this.assertBudget(run);
      const stored: Stored = { run, fingerprint, receipts: {}, prepared: false, source };
      this.records.set(run.id, stored); this.event(stored, "Team created; preparing an isolated copy of the configured project."); this.save(stored);
      this.operation(stored, "prepare", async signal => this.startInProject(run.projectId, async () => {
        const assertParent = () => {
          if (parent && (parent.status !== "ready-for-review" || parent.revision !== parentRevision || parent.headCommit !== source.head))
            throw new TeamError(409, "parent-workspace-changed", "The previous goal run changed while its continuation was being prepared.");
        };
        assertParent();
        const workspace = await prepareTeamWorkspace(source.path, this.config.teams!.workspaceDir, run.id, this.config.teams?.commandPrefix, signal, source.head);
        assertParent();
        if (project.team?.setup) {
          const setup = await teamCommand(project.team.setup, workspace.workspace, signal, 600000, this.config.teams?.commandPrefix);
          if (setup.exitCode !== 0 || setup.interrupted) throw new TeamError(409, "team-setup-failed", "The configured setup command failed. Inspect the isolated workspace before restarting.");
          await assertMemberReadOnly(workspace.workspace, workspace.baseCommit, this.config.teams?.commandPrefix, signal);
        }
        assertParent();
        if (source.head) await assertMemberReadOnly(source.path, source.head, this.config.teams?.commandPrefix, signal);
        return workspace;
      }), workspace => { Object.assign(run, workspace); run.headCommit = workspace.baseCommit; stored.prepared = true; this.event(stored, "Isolated project ready. Starting the project manager."); });
      return this.view(stored);
    });
  }
  private replay(stored: Stored, operation: string, body: Action | Mutation) {
    const prior = stored.receipts[body.requestId];
    if (!prior) return false;
    if (prior !== digest({ operation, ...body })) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
    return true;
  }
  private mutation(stored: Stored, operation: string, body: Action | Mutation) {
    const fingerprint = digest({ operation, ...body });
    const prior = stored.receipts[body.requestId];
    if (prior) {
      if (prior !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
      return false;
    }
    if (body.revision !== stored.run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
    if (stored.run.status === "cancelled") throw new TeamError(409, "team-cancelled", "This team has been cancelled.");
    stored.receipts[body.requestId] = fingerprint;
    return true;
  }
  steer(id: string, input: Mutation) {
    const body = teamMutationSchema.parse(input);
    return this.enqueue(() => {
      const stored = this.record(id);
      if (this.replay(stored, "steer", body)) return this.view(stored);
      if (stored.pending && !this.commands.has(id)) throw new TeamError(409, "team-reconciliation-required", "This team has an unresolved workspace or verification operation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (stored.pending && stored.pending.kind !== "check") throw new TeamError(409, "team-operation-running", "A workspace operation is in progress. Retry steering after it settles.");
      if (Buffer.byteLength(stored.run.steering.map(item => item.text).join("")) + Buffer.byteLength(body.text) > 32 * 1024) throw new TeamError(409, "team-steering-limit", "This team reached its 32 KiB steering limit. Start a new team with consolidated requirements.");
      if (stored.run.steering.length >= 20) throw new TeamError(409, "team-steering-limit", "This team reached its steering limit. Start a new team from the reviewed integration branch.");
      if (!this.mutation(stored, "steer", body)) return this.view(stored);
      this.commands.get(id)?.abort();
      stored.run.revision++; stored.run.steering.push({ text: body.text, revision: stored.run.revision, at: timestamp() });
      stored.run.status = "planning"; stored.halt = "steer"; stored.run.reason = "Stopping earlier members before planning the updated request.";
      stored.run.tasks = []; stored.run.review = undefined; stored.run.round = 0; stored.checkHead = undefined;
      stored.run.brief = undefined; stored.run.noChange = undefined;
      if (stored.run.discovery && !stored.run.discovery.completedAt) stored.run.discovery.completedAt = timestamp();
      this.event(stored, "User steering recorded. Earlier reports cannot satisfy the new revision."); this.save(stored);
      return this.view(stored);
    });
  }
  answer(id: string, decisionId: string, input: Mutation, authorizeNewAnswer?: () => void) {
    const body = teamMutationSchema.parse(input);
    return this.enqueue(() => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, `answer:${decisionId}`, body)) return this.view(stored);
      authorizeNewAnswer?.();
      const decision = run.decisions.find(item => item.id === decisionId && item.revision === run.revision);
      if (!decision) throw new TeamError(404, "decision-not-found", "This decision is no longer current.");
      if (stored.receipts[body.requestId]) { this.mutation(stored, `answer:${decisionId}`, body); return this.view(stored); }
      if (decision.answer) throw new TeamError(409, "decision-answered", "This decision already has an answer.");
      if (stored.halt || run.status === "paused") throw new TeamError(409, "team-paused", "Resume the team before answering its decision.");
      if (!this.mutation(stored, `answer:${decisionId}`, body)) return this.view(stored);
      decision.answer = body.text; decision.answeredAt = timestamp();
      this.event(stored, "A user decision was recorded. The requesting member will continue in a new attempt."); this.save(stored);
      return this.view(stored);
    });
  }
  pause(id: string, input: Action) { return this.action(id, "pause", teamActionSchema.parse(input)); }
  resume(id: string, input: Action) { return this.action(id, "resume", teamActionSchema.parse(input)); }
  cancel(id: string, input: Action) { return this.action(id, "cancel", teamActionSchema.parse(input)); }
  private action(id: string, action: "pause" | "resume" | "cancel", body: Action) {
    return this.enqueue(() => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, action, body)) return this.view(stored);
      if (action === "pause" && ["blocked", "ready-for-review", "no-change"].includes(run.status)) throw new TeamError(409, "team-not-running", "This team is not running and cannot be paused.");
      if (action === "resume" && (stored.pending || !stored.prepared || run.status === "blocked"))
        throw new TeamError(409, "team-reconciliation-required", "This team requires workspace reconciliation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (action === "resume" && stored.halt) throw new TeamError(409, "members-stopping", "Wait for the team's active members to stop before resuming.");
      if (!this.mutation(stored, action, body)) return this.view(stored);
      if (action === "resume") {
        if (run.status !== "paused") { this.save(stored); return this.view(stored); }
        // Pausing stopped native agents. Replan from the confirmed integration head, preserving stopped copies for inspection.
        run.revision++; run.tasks = []; run.review = undefined; run.round = 0; stored.checkHead = undefined;
        run.brief = undefined; run.noChange = undefined;
        if (run.discovery && !run.discovery.completedAt) run.discovery.completedAt = timestamp();
        run.status = "planning"; run.reason = undefined;
      } else {
        run.status = action === "pause" ? "paused" : "cancelled"; stored.halt = action;
        run.reason = "Stopping active team members; any human input lease remains authoritative.";
        this.commands.get(id)?.abort();
      }
      this.event(stored, `Team ${action === "resume" ? "resumed with a fresh plan" : action === "pause" ? "paused" : "cancelled"}.`); this.save(stored);
      return this.view(stored);
    });
  }
  start() {
    if (this.running || this.closed) return;
    this.running = true;
    const tick = () => {
      if (this.tickQueued || !this.running) return;
      this.tickQueued = true;
      void this.enqueue(async () => {
        try { await this.observeProviderLimits(); for (const stored of this.records.values()) await this.step(stored); }
        finally { this.tickQueued = false; }
      }).catch(() => { this.tickQueued = false; });
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
  }
  close() { this.closed = true; this.running = false; if (this.timer) clearInterval(this.timer); for (const controller of this.commands.values()) controller.abort(); }
  private assertBudget(run: TeamRun, addingMember = false) {
    if (run.goal && Date.now() >= Date.parse(run.goal.deadlineAt)) {
      run.stopReason = "deadline";
      throw new TeamError(409, "goal-deadline", "The goal reached its deadline. Active work is being stopped and retained for inspection.");
    }
    const limit = run.goal?.maxMembers ?? 60;
    if (run.members.length + (addingMember ? 1 : 0) > limit) {
      if (run.goal) run.stopReason = "member-limit";
      throw new TeamError(409, "team-attempt-limit", `The team reached its limit of ${limit} agent attempts. Review its evidence before continuing.`);
    }
  }
  /** Persist an intent before external work. A restart keeps the unresolved intent blocked. */
  private operation<T>(stored: Stored, kind: NonNullable<Stored["pending"]>["kind"], perform: (signal: AbortSignal) => Promise<T>, complete: (value: T) => void) {
    if (stored.pending) throw new TeamError(409, "team-operation-running", "A team workspace operation is already running.");
    const pending = { id: randomUUID(), kind, revision: stored.run.revision };
    const controller = new AbortController(); this.commands.set(stored.run.id, controller);
    stored.pending = pending; this.save(stored);
    void perform(controller.signal).then(value => this.enqueue(() => {
      if (this.closed || stored.pending?.id !== pending.id) return;
      this.commands.delete(stored.run.id);
      try { this.assertBudget(stored.run); } catch (error) { this.block(stored, error); return; }
      if (stored.run.stopReason) { this.block(stored, new TeamError(409, "goal-budget-exhausted", "The goal exhausted its execution budget.")); return; }
      const held = ["paused", "cancelled", "blocked"].includes(stored.run.status) ? stored.run.status : undefined;
      stored.pending = undefined;
      try { complete(value); } catch (error) { this.block(stored, error); }
      if (held) stored.run.status = held;
      this.save(stored);
    }), error => this.enqueue(() => {
      if (this.closed || stored.pending?.id !== pending.id) return;
      this.commands.delete(stored.run.id);
      // Failed side effects retain their intent; a pause must not make them replayable.
      this.block(stored, error);
    })).catch(() => {});
  }
  private block(stored: Stored, error: unknown) {
    this.commands.get(stored.run.id)?.abort();
    if (!["paused", "cancelled"].includes(stored.run.status)) { stored.run.status = "blocked"; stored.halt = "block"; }
    stored.run.reason = stored.run.stopReason === "deadline" ? "The goal reached its deadline. Active work is being stopped and retained for inspection."
      : stored.run.stopReason === "member-limit" ? "The goal reached this run's agent attempt limit. Active work is being stopped and retained for inspection."
        : error instanceof TeamError ? error.message : "A team operation failed. Its workspaces and recorded evidence were preserved for inspection.";
    this.event(stored, stored.run.reason); this.save(stored);
  }
  private hasLaunch(member: TeamMember) {
    try { this.manager.meta(member.sessionId); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private async stopped(member: TeamMember) {
    const state = await this.manager.stopTeamSession(member.sessionId, member.stopRequestId, assignment(member));
    if (state.status !== "exited") return false;
    member.status = "stopped"; return true;
  }
  private async observeProviderLimits() {
    for (const session of await this.manager.list()) {
      if (session.provider !== "claude" && session.provider !== "codex") continue;
      const limit = session.attention.limit;
      if (limit?.confidence === "corroborated") {
        this.limits.observe({ provider: session.provider, detectedAt: limit.since, resetsAt: limit.resetsAt,
          sessionId: session.id, ...(session.team ? { runId: session.team.runId } : {}), confidence: "corroborated" });
      }
      const current = this.limits.active().find(entry => entry.provider === session.provider);
      if (current && session.attention.lastSuccessfulTurnAt && session.attention.lastSuccessfulTurnAt > current.detectedAt)
        this.limits.clear(session.provider, session.attention.lastSuccessfulTurnAt);
    }
  }
  private async switchLimitedMember(stored: Stored, member: TeamMember) {
    const run = stored.run, limit = member.pendingLimit!;
    const provider = member.provider ?? run.provider;
    if (limit.confidence === "corroborated") this.limits.observe({ provider, detectedAt: limit.detectedAt,
      resetsAt: limit.resetsAt, sessionId: member.sessionId, runId: run.id, confidence: "corroborated" });
    try {
      if (!await this.stopped(member)) { member.status = "unavailable"; run.reason = runtimeUnavailableReason; this.save(stored); return; }
    } catch {
      member.status = "unavailable";
      run.reason = "The limited agent could not be stopped. Release its input control or inspect its terminal before a replacement can write.";
      this.save(stored); return;
    }
    const limited = this.limits.limited(); limited.add(provider);
    const fallback = run.lineup && member.modelProfile ? resolveLimitFallback(run.lineup, member.modelProfile.id, limited) : undefined;
    const reason = `${provider} ${limit.limit} limit reached${limit.resetsAt ? `; resets ${limit.resetsAt}` : ""}`;
    member.stoppedReason = reason;
    if (!fallback) {
      this.block(stored, new TeamError(409, "provider-limit", `${reason}; no fallback profile is configured for ${member.modelProfile?.id ?? provider}.`)); return;
    }
    this.assertBudget(run, true);
    const task = member.role === "scout" ? run.discovery?.tasks.find(task => task.id === member.taskId) : run.tasks.find(task => task.id === member.taskId);
    this.operation(stored, "member", async signal => {
      if (member.role === "implementer") await assertMemberScope(member.cwd, member.baseCommit, (task as TeamTask).paths, this.config.teams?.commandPrefix, signal);
      else if (member.role === "integrator") await assertMemberScope(member.cwd, member.baseCommit, run.goal?.allowedPaths, this.config.teams?.commandPrefix, signal);
      else await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
    }, () => {
      const feedback = [this.memberFeedback(run, member), "The previous member stopped at a provider usage limit. Its partial edits, if any, are present and passed the role's path check. Inspect them and finish the same assignment."].filter(Boolean).join("\n\n");
      const next = this.newMember(run, member.role, member.cwd, member.baseCommit, member.taskId, feedback, fallback);
      run.members.push(next); member.pendingLimit = undefined;
      if (task) { task.memberId = next.memberId; task.status = "running"; }
      if (member.role === "implementer" && task) {
        const implementation = task as TeamTask;
        (implementation.limitSwitches ??= []).push({ fromProfileId: member.modelProfile?.id, toProfileId: fallback.id,
          reason, resetsAt: limit.resetsAt, memberId: member.memberId, at: limit.detectedAt });
      }
      run.reason = undefined;
      this.event(stored, `${member.modelProfile?.label ?? provider} hit a usage limit; ${member.taskId ?? member.role} continues on ${fallback.label} with partial work preserved.`);
    });
  }
  private async step(stored: Stored) {
    const run = stored.run;
    try {
      const tracking = this.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
      if (JSON.stringify(run.linear) !== JSON.stringify(tracking)) { run.linear = tracking; this.save(stored); }
      if (tracking?.status === "blocked" && !stored.halt && !["cancelled", "blocked", "ready-for-review", "no-change"].includes(run.status)) {
        this.block(stored, new TeamError(409, "linear-issue-changed", tracking.reason ?? "The Linear issue no longer permits this work. Review its requirements before starting another team."));
      }
      const trackingReady = !tracking || tracking.status === "synced";
      if (!stored.halt && !["paused", "cancelled", "blocked", "ready-for-review", "no-change"].includes(run.status)) this.assertBudget(run);
      if (stored.halt) {
        let all = true;
        for (const member of run.members.filter(activeMember)) {
          try {
            // A queued launch may already have spawned before the API stopped.
            if (member.status === "queued" && !this.hasLaunch(member)) member.status = "stopped";
            else if (!await this.stopped(member)) all = false;
          } catch { all = false; member.status = "unavailable"; }
        }
        if (all && (!stored.pending || run.status === "blocked" || run.status === "cancelled")) { stored.halt = undefined; if (!["blocked", "cancelled"].includes(run.status)) run.reason = undefined; }
        this.save(stored); return;
      }
      if (!stored.prepared || ["paused", "cancelled", "blocked", "ready-for-review", "no-change"].includes(run.status)) return;
      if (run.reason === providerInputReason || run.reason === runtimeUnavailableReason) {
        const states = await Promise.all(run.members.filter(member => member.revision === run.revision && activeMember(member) && member.status !== "queued" && !member.report)
          .map(member => this.manager.state(member.sessionId)));
        if (this.closed) return;
        const reason = states.some(state => ["unavailable", "recording-error"].includes(state.status)) ? runtimeUnavailableReason
          : states.some(state => state.status !== "exited" && state.attention.state === "needs-you") ? providerInputReason : undefined;
        if (run.reason !== reason) { run.reason = reason; this.save(stored); }
      }
      if (stored.pending) return;
      assertTeamPath(this.config.teams!.workspaceDir, run.workspace);
      for (const member of run.members.filter(item => item.revision === run.revision && activeMember(item))) {
        if (member.status === "queued") { await this.launch(stored, member); continue; }
        if (!member.report) {
          if (member.startedAt && Date.now() - Date.parse(member.startedAt) > 60 * 60 * 1000) { this.block(stored, new TeamError(409, "member-time-limit", "An agent exceeded its one-hour runtime limit. Its workspace was preserved.")); return; }
          const page = this.manager.events(member.sessionId, member.cursor, 200, new Set(["team-report", "signal"]));
          member.cursor = page.cursor;
          for (const event of page.events) {
            if (event.type === "signal") {
              const signal = event.data;
              if (signal.kind === "provider-limit" && ["usage", "credits"].includes(String(signal.limit)) && typeof signal.message === "string"
                && (signal.confidence === "corroborated" || ((member.provider ?? run.provider) === "claude" && signal.source === "hook" && signal.confidence === "single-source"))) {
                member.pendingLimit = { limit: signal.limit as "usage" | "credits", confidence: signal.confidence as "single-source" | "corroborated",
                  message: signal.message, detectedAt: event.at, ...(typeof signal.resetsAt === "string" ? { resetsAt: signal.resetsAt } : {}) };
              }
              continue;
            }
            const parsed = teamReportEnvelopeSchema.safeParse(event.data);
            if (!parsed.success) continue;
            const envelope = parsed.data;
            if (envelope.runId !== run.id || envelope.memberId !== member.memberId || envelope.revision !== member.revision) continue;
            member.report = envelope.report; member.status = "reported"; break;
          }
          if (!member.report) {
            if (member.pendingLimit) {
              // Persist the observation before attempting a lease-aware stop. A denied stop
              // retries this same member, even though the journal cursor has advanced.
              this.save(stored);
              // Allow the worker's next two screen checks to add a reset time and
              // corroboration before stopping a hook-only failed turn.
              if (member.pendingLimit.confidence === "single-source" && Date.now() - Date.parse(member.pendingLimit.detectedAt) < 2200) continue;
              await this.switchLimitedMember(stored, member); return;
            }
            const state = await this.manager.state(member.sessionId);
            if (state.status === "exited" && (page.more || member.cursor < state.seq)) { this.save(stored); continue; }
            if (state.status === "exited") { member.status = "stopped"; this.block(stored, new TeamError(409, "missing-agent-report", "An agent exited without a valid structured report. Its task is unresolved.")); return; }
            if (["unavailable", "recording-error"].includes(state.status)) { member.status = "unavailable"; run.reason = runtimeUnavailableReason; }
            else if (state.attention.state === "needs-you") run.reason = providerInputReason;
            else member.status = "running";
            this.save(stored); continue;
          }
          this.save(stored);
        }
        try { if (!await this.stopped(member)) continue; }
        catch { member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); continue; }
        if (!trackingReady) { member.status = "reported"; this.save(stored); continue; }
        if (member.role === "implementer" && member.report?.kind === "result") {
          const position = run.tasks.findIndex(task => task.id === member.taskId);
          if (run.tasks.slice(0, position).some(task => task.status !== "integrated")) { member.status = "reported"; this.save(stored); continue; }
        }
        this.consume(stored, member);
        if (stored.pending || run.status === "blocked" || run.status === "no-change") return;
      }
      if (!trackingReady) return;
      // A recorded answer creates one replacement only after the original has confirmed exit.
      for (const decision of run.decisions.filter(item => item.revision === run.revision && item.answer)) {
        const prior = run.members.find(member => member.memberId === decision.memberId)!;
        if (prior.status !== "waiting") continue;
        const next = this.newMember(run, prior.role, prior.cwd, prior.baseCommit, prior.taskId, `${this.memberFeedback(run, prior)}\n\nUser answered: ${decision.answer}`, prior.modelProfile);
        prior.status = "stopped"; run.members.push(next);
        const task = prior.role === "scout" ? run.discovery?.tasks.find(item => item.id === prior.taskId) : run.tasks.find(item => item.id === prior.taskId);
        if (task) { task.memberId = next.memberId; task.status = "running"; }
        this.save(stored);
      }
      if (run.discovery && !run.discovery.completedAt && run.discovery.revision === run.revision) {
        const scouts = run.discovery.tasks;
        const active = run.members.filter(member => member.revision === run.revision && member.role === "scout" && activeMember(member)).length;
        const next = scouts.find(scout => scout.status === "pending");
        if (next && active < run.parallelism) { this.prepareMember(stored, "scout", next); return; }
        if (scouts.every(scout => scout.status === "complete")) {
          run.discovery.completedAt = timestamp(); run.status = "planning";
          this.event(stored, "Read-only discovery finished. The coordinator will use its recorded evidence once."); this.save(stored);
        } else {
          run.status = scouts.some(scout => scout.status === "waiting") ? "needs-input" : "discovering";
          this.save(stored); return;
        }
      }
      if (run.members.some(member => member.revision === run.revision && activeMember(member) && member.role !== "implementer")) return;
      if (run.members.some(member => member.revision === run.revision && member.status === "waiting" && member.role !== "implementer")) { run.status = "needs-input"; this.save(stored); return; }
      if (!run.tasks.length) {
        if (run.members.some(member => member.revision === run.revision && member.role === "project-manager" && member.status === "waiting")) { run.status = "needs-input"; this.save(stored); return; }
        this.prepareMember(stored, "project-manager"); return;
      }
      const pendingTasks = run.tasks.filter(task => task.status === "pending");
      const activeCount = run.members.filter(member => member.revision === run.revision && activeMember(member)).length;
      const nextTask = pendingTasks.find(task => task.dependsOn.every(id => run.tasks.find(item => item.id === id)?.status === "integrated"));
      if (nextTask && activeCount < run.parallelism) { this.prepareMember(stored, "implementer", nextTask); return; }
      if (run.tasks.some(task => task.status !== "integrated")) {
        run.status = run.decisions.some(decision => decision.revision === run.revision && !decision.answer) ? "needs-input" : "implementing";
        this.save(stored); return;
      }
      if (activeCount) return;
      if (stored.checkHead !== run.headCommit) { this.check(stored); return; }
      if (!run.review || run.review.revision !== run.revision) { this.prepareMember(stored, "reviewer"); return; }
      if (run.review.verdict === "approved") {
        await assertMemberReadOnly(run.workspace, run.headCommit!, this.config.teams?.commandPrefix);
        this.assertBudget(run);
        run.status = "ready-for-review"; run.reason = undefined;
        this.event(stored, "The reviewer approved the integrated change and configured checks passed. Ready for human review; nothing was published."); this.save(stored);
      }
    } catch (error) { this.block(stored, error); }
  }
  private taskProfiles(run: TeamRun, tasks: { agentProfileId?: string }[]) {
    for (const task of tasks) {
      if (!run.lineup) {
        if (task.agentProfileId !== undefined) throw new TeamError(409, "invalid-agent-profile", "A single-provider team cannot select profiles from a configured lineup.");
      } else if (!task.agentProfileId || !run.lineup.implementers.some(profile => profile.id === task.agentProfileId)) {
        throw new TeamError(409, "invalid-agent-profile", "Every task must select an agentProfileId from the team's configured implementer pool.");
      }
    }
  }
  private memberProfile(run: TeamRun, role: TeamMember["role"], task?: TeamTask | TeamScout): TeamModelProfile | undefined {
    if (!run.lineup) return undefined;
    if (role === "project-manager") return run.lineup.coordinator;
    if (role === "integrator") return run.lineup.integrator;
    if (role === "reviewer") return run.lineup.reviewer;
    if (!task) throw new TeamError(409, "invalid-agent-profile", "An implementer requires an assigned task and allowed model profile.");
    this.taskProfiles(run, [task]);
    return run.lineup.implementers.find(profile => profile.id === task.agentProfileId)!;
  }
  private memberFeedback(run: TeamRun, member: TeamMember) {
    if (member.feedback !== undefined) return member.feedback;
    // Legacy members did not retain structured feedback. Recover only that section,
    // never their provider-specific runtime or reporting instructions.
    const start = member.prompt.indexOf("\n\nFeedback and answers:\n");
    const end = member.prompt.lastIndexOf("\n\nDo not publish, merge, deploy,");
    const feedback = start >= 0 && end > start ? member.prompt.slice(start + "\n\nFeedback and answers:\n".length, end) : "";
    const answers = run.decisions.filter(decision => decision.memberId === member.memberId && decision.answer).map(decision => `User answered: ${decision.answer}`).join("\n");
    return [feedback, answers].filter(Boolean).join("\n\n");
  }
  private newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, feedback?: string, pinnedProfile?: TeamModelProfile): TeamMember {
    this.assertBudget(run, true);
    const memberId = randomUUID();
    const task = role === "scout" ? run.discovery?.tasks.find(task => task.id === taskId) : run.tasks.find(task => task.id === taskId);
    let selected = pinnedProfile ?? this.memberProfile(run, role, task);
    if (selected && run.lineup && this.limits.limited().has(selected.provider)) {
      const fallback = resolveLimitFallback(run.lineup, selected.id, this.limits.limited());
      if (fallback) {
        this.event(this.record(run.id), `${selected.label} launched on ${fallback.label}: ${selected.provider} has an active usage limit.`);
        selected = fallback;
      }
    }
    const modelProfile = selected ? structuredClone(selected) : undefined;
    const provider = modelProfile?.provider ?? run.provider;
    const instructions = teamPrompt(run, role, task, feedback, provider, modelProfile);
    if (Buffer.byteLength(instructions) > 80 * 1024) throw new TeamError(409, "team-prompt-too-large", "The accumulated team requirements exceed the prompt limit. Start a new team with consolidated requirements.");
    return { runId: run.id, memberId, revision: run.revision, role, provider, ...(modelProfile ? { modelProfile } : {}), ...(taskId ? { taskId } : {}), sessionId: randomUUID(), title: `${role}: ${taskId ?? run.title}`.slice(0, 100), status: "queued", cwd, baseCommit, prompt: instructions, ...(feedback ? { feedback } : {}), cursor: 0, stopRequestId: randomUUID() };
  }
  private prepareMember(stored: Stored, role: TeamMember["role"], task?: TeamTask | TeamScout, feedback?: string) {
    const run = stored.run, member = this.newMember(run, role, "", run.headCommit!, task?.id, feedback);
    run.status = role === "project-manager" ? "planning" : role === "scout" ? "discovering" : role === "reviewer" ? "reviewing" : role === "integrator" ? "integrating" : "implementing";
    this.operation(stored, "member", async signal => {
      const cwd = await prepareMemberWorkspace(run.workspace, member.memberId, member.baseCommit, this.config.teams?.commandPrefix, signal);
      const setup = this.config.projects.find(project => project.id === run.projectId)!.team!.setup;
      if (setup) {
        const result = await teamCommand(setup, cwd, signal, 600000, this.config.teams?.commandPrefix);
        if (result.exitCode !== 0 || result.interrupted) throw new TeamError(409, "team-setup-failed", "A member's configured setup command failed. Its isolated workspace was preserved.");
        await assertMemberReadOnly(cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
      }
      return cwd;
    }, cwd => {
      member.cwd = cwd; run.members.push(member);
      if (task) { task.status = "running"; task.memberId = member.memberId; }
      this.event(stored, `${member.title} queued in an isolated working copy.`);
    });
  }
  private async launch(stored: Stored, member: TeamMember) {
    this.assertBudget(stored.run);
    assertTeamPath(this.config.teams!.workspaceDir, member.cwd);
    // Recover an already-created assignment even while Linear is unavailable. A new
    // process requires the bridge's fresh feature and parent issue observations.
    if (!this.hasLaunch(member)) {
      const tracking = this.linear?.updateTeam(stored.run, stored.run.linearTracking === true) ?? stored.run.linear;
      if (JSON.stringify(stored.run.linear) !== JSON.stringify(tracking)) { stored.run.linear = tracking; this.save(stored); }
      if (tracking?.status === "blocked") throw new TeamError(409, "linear-issue-changed", tracking.reason ?? "The Linear issue no longer permits this work.");
      if (tracking && tracking.status !== "synced") return;
    }
    if (!this.hasLaunch(member) && (await this.manager.list()).filter(session => session.status === "running" || session.status === "starting").length >= this.config.maxSessions) { stored.run.reason = "Waiting for an available host session slot."; this.save(stored); return; }
    // All launch fields were persisted with the queued member before this call.
    let result;
    try { result = await this.startInProject(stored.run.projectId, () => this.manager.createTeamSession({ requestId: member.sessionId, provider: member.provider ?? stored.run.provider, projectId: stored.run.projectId, title: member.title, prompt: member.prompt }, assignment(member), member.cwd, member.modelProfile)); }
    catch (error) { if (error instanceof Error && /configured session limit/.test(error.message)) { stored.run.reason = "Waiting for an available host session slot."; this.save(stored); return; } throw error; }
    member.status = result.status === "unavailable" ? "unavailable" : "running"; member.startedAt ??= timestamp(); this.save(stored);
  }
  private consume(stored: Stored, member: TeamMember) {
    const run = stored.run, report = member.report!;
    if (report.kind === "blocked") { this.block(stored, new TeamError(409, "agent-blocked", report.summary)); return; }
    if (report.kind === "question") {
      if (run.decisions.length >= 40) { this.block(stored, new TeamError(409, "team-decision-limit", "The team reached its limit of 40 decisions. Review its evidence before starting another team.")); return; }
      member.status = "waiting";
      run.decisions.push({ id: randomUUID(), memberId: member.memberId, revision: run.revision, question: report.question, options: report.options, createdAt: timestamp() });
      const task = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId) : run.tasks.find(item => item.id === member.taskId); if (task) task.status = "waiting";
      run.status = "needs-input"; this.event(stored, `${member.title} requested a user decision.`); this.save(stored); return;
    }
    const expected = member.role === "project-manager" ? ["plan", "explore", "no-change"] : member.role === "scout" ? ["findings"] : member.role === "reviewer" ? ["review"] : member.role === "implementer" ? ["result", "escalate"] : ["result"];
    if (!expected.includes(report.kind)) { this.block(stored, new TeamError(409, "wrong-agent-report", "An agent's report does not match its assigned role.")); return; }
    if (report.kind === "no-change") {
      if (!run.goal || run.tasks.length) throw new TeamError(409, "invalid-no-change", "Only a goal coordinator can conclude that discovery found no justified change.");
      this.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
        await assertMemberReadOnly(run.workspace, run.headCommit!, this.config.teams?.commandPrefix, signal);
      }, () => {
        run.noChange = { summary: report.summary, evidence: report.evidence }; run.status = "no-change"; run.reason = undefined;
        this.event(stored, "The coordinator reported no justified change and recorded its evidence. No implementation was started.");
      }); return;
    }
    if (report.kind === "explore") {
      if (run.discovery || run.tasks.length || !run.lineup) throw new TeamError(409, "discovery-already-used", "A team may request one read-only discovery batch before implementation planning.");
      if (new Set(report.tasks.map(task => task.id)).size !== report.tasks.length) throw new TeamError(409, "invalid-discovery", "Discovery task IDs must be unique.");
      this.taskProfiles(run, report.tasks);
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        run.discovery = { revision: run.revision, summary: report.summary, tasks: report.tasks.map(task => ({ ...task, status: "pending" })) };
        run.status = "discovering";
        this.event(stored, `The coordinator requested ${report.tasks.length} read-only discovery tasks.`);
      }); return;
    }
    if (report.kind === "findings") {
      const scout = run.discovery?.tasks.find(task => task.id === member.taskId && task.memberId === member.memberId);
      if (!scout || run.discovery?.revision !== run.revision) throw new TeamError(409, "invalid-discovery", "The scout does not belong to the current discovery batch.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        scout.status = "complete"; scout.summary = report.summary; scout.evidence = report.evidence;
        this.event(stored, `${member.title} returned evidence without changing its working copy.`);
      }); return;
    }
    if (report.kind === "escalate") {
      const task = run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId);
      const profile = run.lineup?.escalations?.find(item => item.id === report.agentProfileId);
      if (!task || task.escalation || !profile || profile.id === member.modelProfile?.id)
        throw new TeamError(409, "invalid-escalation", "An implementer may escalate once to a different profile in the approved escalation pool.");
      this.operation(stored, "result", signal => assertMemberScope(member.cwd, member.baseCommit, task.paths, this.config.teams?.commandPrefix, signal), () => {
        task.escalation = { ...(member.modelProfile ? { fromProfileId: member.modelProfile.id } : {}), toProfileId: profile.id, reason: report.reason, memberId: member.memberId, at: timestamp() };
        const next = this.newMember(run, "implementer", member.cwd, member.baseCommit, task.id,
          `The previous implementer requested escalation: ${report.reason}. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.`, profile);
        run.members.push(next); task.memberId = next.memberId; task.status = "running";
        run.status = "implementing";
        this.event(stored, `${task.title} escalated to ${profile.label}; the stopped member's partial work was preserved.`);
      }); return;
    }
    if (report.kind === "plan") {
      validateTeamPlan(report.tasks);
      this.taskProfiles(run, report.tasks);
      if (run.goal && !report.brief) throw new TeamError(409, "goal-brief-required", "A goal plan must include an evidence-backed brief with acceptance criteria.");
      if (run.goal && report.tasks.some(task => task.paths.some(path => !teamPathAllowed(path, run.goal!.allowedPaths))))
        throw new TeamError(409, "goal-scope-violation", "The plan proposes paths outside the approved goal scope.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        const remaining = [...report.tasks];
        run.tasks = [];
        while (remaining.length) {
          const index = remaining.findIndex(task => task.dependsOn.every(id => run.tasks.some(done => done.id === id)));
          run.tasks.push({ ...remaining.splice(index, 1)[0], status: "pending" });
        }
        run.brief = report.brief;
        run.status = "implementing";
        this.event(stored, `Project manager planned ${run.tasks.length} tasks.`);
      }); return;
    }
    if (report.kind === "review") {
      if (member.baseCommit !== run.headCommit || stored.checkHead !== run.headCommit) { this.block(stored, new TeamError(409, "stale-review", "The reviewer did not review the currently verified integration commit.")); return; }
      if (run.brief?.uiChanges && report.verdict === "approved" && !report.uiEvidence)
        throw new TeamError(409, "ui-review-evidence-required", "Approval of UI changes requires the reviewer's evidence from inspecting the runnable interface.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        run.review = { verdict: report.verdict, summary: report.summary, revision: run.revision, ...(report.uiEvidence ? { uiEvidence: report.uiEvidence } : {}) };
        if (report.verdict === "changes-requested") this.repair(stored, report.summary);
        else run.status = "reviewing";
      }); return;
    }
    if (report.kind !== "result") throw new TeamError(409, "wrong-agent-report", "The member did not submit an implementation result.");
    const task = run.tasks.find(item => item.id === member.taskId);
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    run.status = "integrating";
    this.operation(stored, "result", async signal => {
      const commit = await captureMemberResult(member.cwd, member.baseCommit, member.role === "implementer" ? task!.paths : run.goal?.allowedPaths, this.config.teams?.commandPrefix, signal);
      const head = commit ? await integrateMemberResult(run.workspace, member.cwd, commit, this.config.teams?.commandPrefix, signal) : run.headCommit!;
      return { commit, head };
    }, ({ commit, head }) => {
      run.headCommit = head; stored.checkHead = undefined; run.review = undefined;
      if (task) { task.status = "integrated"; task.commit = commit; task.summary = report.summary; }
      this.event(stored, `${member.title} reported a result; its validated changes were integrated.`);
      run.status = "implementing";
    });
  }
  private repair(stored: Stored, feedback: string) {
    if (stored.halt || ["paused", "cancelled"].includes(stored.run.status)) return;
    if (stored.run.round >= 2) { this.block(stored, new TeamError(409, "repair-limit", "The team exhausted its two correction rounds. Review the check and agent evidence before continuing manually.")); return; }
    stored.run.round++; stored.run.review = undefined; stored.checkHead = undefined;
    this.prepareMember(stored, "integrator", undefined, feedback);
  }
  private check(stored: Stored) {
    const run = stored.run, revision = run.revision, head = run.headCommit!;
    const commands = this.config.projects.find(project => project.id === run.projectId)!.team!.checks;
    run.status = "verifying";
    this.operation(stored, "check", async signal => {
      const results: typeof run.checks = [];
      for (const command of commands) {
        const check: TeamRun["checks"][number] = { command, status: "running", startedAt: timestamp(), output: "", revision };
        await this.enqueue(() => { if (!this.closed) { run.checks.push(check); this.save(stored); } });
        const result = await teamCommand(command, run.workspace, signal, 600000, this.config.teams?.commandPrefix);
        Object.assign(check, { status: result.interrupted ? "interrupted" : result.exitCode === 0 ? "passed" : "failed", finishedAt: timestamp(), exitCode: result.exitCode, output: result.output });
        results.push(check);
        await this.enqueue(() => { if (!this.closed) this.save(stored); });
        if (check.status !== "passed") break;
      }
      if (!this.closed) await assertMemberReadOnly(run.workspace, head, this.config.teams?.commandPrefix);
      return results;
    }, results => {
      if (revision !== run.revision || stored.halt || run.status === "paused" || run.status === "cancelled") return;
      if (results.length === commands.length && results.every(result => result.status === "passed")) {
        stored.checkHead = head; this.event(stored, "All configured verification commands passed against the integrated commit."); run.status = "reviewing";
      } else this.repair(stored, `Configured verification failed:\n${JSON.stringify(results)}`);
    });
  }
}
