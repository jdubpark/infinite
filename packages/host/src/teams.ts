import type { HandoffPolicy, TeamHandoffContext } from "./handoff-types.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, Provider } from "./types.js";
import { TeamStopRefused, type Manager } from "./manager.js";
import type { WorkerError } from "./ipc.js";
import { writeSealed, unseal } from "./vault.js";
import { PROVIDER_NAMES, recoveryTurnEnd, type SignalData } from "@infinite/attention";
import { createTeamSchema, lineupProfiles, resolveLimitFallback, teamActionSchema, teamGoalContextSchema, teamLineupSchema, teamMutationSchema, teamParallelismSchema, teamReportEnvelopeSchema, type CreateTeam, type TeamAssignment, type TeamBrief, type TeamGoalContext, type TeamLineup, type TeamMember, type TeamModelProfile, type TeamParallelism, type TeamPermissionDecision, type TeamRun, type TeamScout, type TeamTask, type TeamView } from "./team-types.js";
import { refreshReportingInstructions, retargetPrompt, teamPrompt } from "./team-prompts.js";
import { permissionCoordinatorLaunch, teamModelLaunch } from "./launch.js";
import type { UsageService } from "./usage-service.js";
import { teamUsage } from "./team-usage.js";
import { ProviderLimits, switchesMember, type LimitObservation } from "./provider-limits.js";
import type { LinearService } from "./linear.js";
import type { Readings } from "./readings.js";
import { TeamError, assertMemberReadOnly, assertMemberScope, assertTeamPath, captureDeliveryBaseline, captureMemberResult, ensureDefaultTeamRoot, ensureHostDirectory, integrateMemberResult, memberChangedPaths, prepareMemberWorkspace, prepareTeamWorkspace, teamCommand, teamPathAllowed, teamWorkspacePath, teamGitArgs, validateTeamPlan } from "./team-workspace.js";
import { assertTeamworkPath } from "./repo-enrollment.js";
import { oneShotPermissionOption, permissionEvidenceHash, refusedBeforeSend } from "./team-permissions.js";
export { TeamError } from "./team-workspace.js";

type Mutation = { requestId: string; revision: number; text: string };
type Action = { requestId: string; revision: number };
type LimitSwitch = LimitObservation & { at: string; seq: number };
type StartInProject = <T>(projectId: string, start: () => Promise<T>) => Promise<T>;
type MissionReservationLookup = (projectId: string, exceptMissionId?: string) => string | undefined;
type Stored = {
  run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean; root?: string; anchor?: string;
  pending?: { id: string; kind: "prepare" | "member" | "result" | "check"; revision: number };
  halt?: "pause" | "cancel" | "steer" | "block";
  deliveryAttempt?: { memberId: string; revision: number; headCommit: string };
  checkHead?: string;
  source?: { path: string; head?: string; startCommit?: string };
  handoffPolicy?: HandoffPolicy;
  goalExtensions?: Record<string, { deadlineAt: string; ceilingAt: string }>;
  ratings?: Record<string, { fingerprint: string; result: TeamTask["ownerRating"] }>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const timestamp = () => new Date().toISOString();
const activeMember = (member: TeamMember) => ["queued", "running", "reported", "unavailable"].includes(member.status);
const holdsWorkerSlot = (member: TeamMember, revision: number) => member.revision === revision &&
  (member.role === "scout" || member.role === "implementer") &&
  (["queued", "running", "unavailable"].includes(member.status) || member.status === "reported" && !member.exitConfirmedAt);
const inactiveTeamStatuses = new Set(["cancelled", "ready-for-review", "merged", "no-change"]);
const activeTeamRun = (status: string) => !inactiveTeamStatuses.has(status);
export const providerInputReason = "A provider needs user input. Open the member session to respond; the team will not approve it.";
const permissionReviewReason = "The permission coordinator is reviewing a provider request.";
/** Whether a delegated permission decision still holds this member's open prompt. */
const underReview = (run: TeamRun, sessionId: string, promptId?: number) => promptId !== undefined &&
  (run.permissionDecisions ?? []).some(decision => decision.targetSessionId === sessionId && decision.promptId === promptId &&
    ["pending", "reviewing", "approved", "answering"].includes(decision.status));
const runtimeUnavailableReason = "An agent runtime is unavailable; the team is waiting for confirmed state.";
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;
const runEvent = (run: TeamRun, text: string) => {
  run.events.push({ at: timestamp(), text });
  if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
};
function diffStat(output?: string) {
  if (output === undefined) return undefined;
  // `--numstat -z --no-renames` ends every file record with NUL: "added<TAB>removed<TAB>path".
  const rows = output.split("\0").filter(Boolean).map(line => {
    const [added, removed, path] = line.split("\t");
    return { added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed), path: path ?? "" };
  });
  return { added: rows.reduce((sum, row) => sum + row.added, 0), removed: rows.reduce((sum, row) => sum + row.removed, 0), files: rows.length,
    docs: rows.some(row => row.path.startsWith("docs/") || row.path.endsWith(".md")),
    tests: rows.some(row => /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(row.path)) };
}

/** Written by hosts before stall detection; still resumable. */
export const memberTimeLimitReason = "An agent exceeded its one-hour runtime limit. Its workspace was preserved.";
export const memberStallReason = "An agent showed no activity twice on the same assignment. Its workspace was preserved.";
export const checkTimeoutReason = "A configured check ran past the team check time limit (teams.checkMinutes) and was stopped. No correction round was used; the integrated work was preserved.";

export function applyTeamBriefTitle(run: TeamRun, brief: TeamBrief | undefined, revision = run.revision) {
  run.brief = brief;
  if (brief && run.status !== "cancelled" && revision === run.revision && (run.titleSource === "request" || run.titleSource === "model" || run.titleSource === "brief")) {
    run.title = brief.title;
    run.titleSource = "brief";
  }
}

/**
 * The fallback for a member stopped at a provider limit. Its own provider counts as limited even when
 * only a single-source observation saw the limit, so a second hop never returns to that account.
 */
export function switchFallback(lineup: TeamLineup, profileId: string, provider: Provider, limited: Set<Provider>) {
  return resolveLimitFallback(lineup, profileId, new Set([...limited, provider]));
}

/** A stalled or legacy one-hour member stop can replan. Interrupted workspace operations cannot. */
export function blockedTeamCanResume(input: {
  status: string;
  reason?: string;
  pending: boolean;
  deliveryAttempt: boolean;
  deliveryReceipt: boolean;
  prepared: boolean;
  stopReason?: string;
  linearStatus?: string;
}): boolean {
  return input.status === "blocked"
    && (input.reason === memberStallReason || input.reason === memberTimeLimitReason || input.reason === checkTimeoutReason)
    && input.prepared
    && !input.pending
    && !input.deliveryAttempt
    && !input.deliveryReceipt
    && !input.stopReason
    && input.linearStatus !== "blocked";
}
/** Milliseconds since the member last showed attention activity, or since it started before any was observed. */
const quietFor = (member: TeamMember) => Date.now() - Date.parse(member.lastActivityAt ?? member.startedAt ?? timestamp());
// The flag is persisted on the member at creation, so a recovered or stopped session keeps the fingerprint it launched with.
const assignment = (member: TeamMember): TeamAssignment => ({ runId: member.runId, memberId: member.memberId, revision: member.revision, role: member.role, ...(member.taskId ? { taskId: member.taskId } : {}),
  ...(member.verificationRefused ? { verificationRefused: true } : {}) });

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
  private missionReservations?: MissionReservationLookup;
  private readonly limits: ProviderLimits;
  private reconciledAt = 0;
  constructor(private readonly config: Config, private readonly key: Buffer, private readonly manager: Manager, private readonly startInProject: StartInProject, private readonly linear?: LinearService, private readonly titler?: Pick<Readings, "requestTitle">) {
    this.directory = join(config.stateDir, "teams");
    this.limits = new ProviderLimits(join(config.stateDir, "provider-limits.sealed"), key);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.sealed$/.test(name))) {
      const id = file.slice(0, -7);
      const stored = unseal<Stored>(key, `team:${id}`, readFileSync(join(this.directory, file), "utf8"));
      if (stored.run.id !== id) throw new TeamError(409, "invalid-team-record", "A team record cannot be authenticated.");
      this.records.set(id, stored);
      if (stored.pending) {
        for (const check of stored.run.checks) if (check.status === "running") { check.status = "interrupted"; check.finishedAt = timestamp(); }
        if (stored.run.status === "cancelled") {
          stored.halt = "cancel";
          this.event(stored, "The host restarted with an unresolved operation from a cancelled team. The intent remains retained and will not be replayed.");
        } else {
          stored.run.status = "blocked"; stored.halt = "block";
          stored.run.reason = "The host restarted during a workspace or verification operation. Inspect the isolated workspace before starting a new team; the operation will not be replayed.";
          this.event(stored, stored.run.reason);
        }
        // Retain the intent so resume cannot disguise an ambiguous operation.
        this.save(stored); this.trackBlocked(stored);
      }
      for (const decision of stored.run.permissionDecisions ?? []) if (decision.status === "answering") {
        decision.status = "uncertain";
        decision.reason = "The host restarted while an answer was in flight. Inspect the target session before taking any further action.";
        this.event(stored, decision.reason);
        this.save(stored);
      }
      if (stored.pending) for (const decision of stored.run.permissionDecisions ?? []) if (["pending", "reviewing", "approved"].includes(decision.status)) {
        decision.status = "stale";
        decision.reason = "The host restarted during a team operation. Review this request with the user.";
        this.save(stored);
      }
    }
  }
  /** The usage ledger this service prices member usage from; its tick also drives the ledger's reads. */
  useUsage(service: UsageService) { this.usage = service; }
  /** MissionService supplies active-subteam and pending-launch reservations without a reverse import. */
  useMissionReservations(lookup: MissionReservationLookup) { this.missionReservations = lookup; }
  /** Active host-level provider limits; new members of a limited provider launch on their fallback. */
  providerLimits() { return this.limits.active(); }
  private enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const next = this.serial.then(task); this.serial = next.catch(() => {}); return next;
  }
  private record(id: string) {
    const stored = this.records.get(id);
    if (!stored) throw new TeamError(404, "team-not-found", "This team does not exist.");
    return stored;
  }
  private assertRunPath(stored: Stored, path: string, create = false) {
    const root = stored.root ?? this.config.teams?.workspaceDir;
    if (!root) throw new TeamError(409, "invalid-workspace", "The team workspace is outside its configured root.");
    if (!stored.anchor && root !== this.config.teams?.workspaceDir)
      throw new TeamError(409, "team-root-unsafe", "A team root outside the configured workspace directory requires a trusted anchor.");
    const canonical = stored.anchor ? ensureHostDirectory(stored.anchor, root, 0o750, create) : ensureDefaultTeamRoot(root, create);
    assertTeamPath(canonical, path);
  }
  private canResume(stored: Stored, linearStatus = stored.run.linear?.status) {
    const run = stored.run;
    return blockedTeamCanResume({
      status: run.status,
      reason: run.reason,
      pending: Boolean(stored.pending),
      deliveryAttempt: Boolean(stored.deliveryAttempt),
      deliveryReceipt: Boolean(run.deliveryReceipt),
      prepared: stored.prepared,
      stopReason: run.stopReason,
      linearStatus,
    });
  }
  private view(stored: Stored): TeamView {
    const { members, ...run } = structuredClone(stored.run);
    // Queue evidence from this exact state before a goal can use its sync gate
    // to continue from a newly reviewed or no-change result.
    const tracking = this.linear?.updateTeam(stored.run, stored.run.linearTracking === true, this.canResume(stored));
    run.linear = this.linear?.getTeam(run.id) ?? tracking ?? run.linear;
    const safeRun = {
      ...run,
      resumable: this.canResume(stored, run.linear?.status),
      ...(run.permissionDecisions ? { permissionDecisions: run.permissionDecisions.map(({ prompt: _prompt, ...decision }) => decision) } : {}),
    };
    const withUsage = teamUsage(members.map(({ prompt: _prompt, ...member }) => member), run.provider, this.usage);
    const max = run.handoff ? 2 : 4;
    const ready = run.tasks.filter(task => task.status === "pending" && task.dependsOn.every(id => run.tasks.find(item => item.id === id)?.status === "integrated")).length +
      (run.discovery && run.discovery.revision === run.revision && !run.discovery.completedAt ? run.discovery.tasks.filter(task => task.status === "pending").length : 0);
    const workers = { limit: run.parallelism, max, running: members.filter(member => holdsWorkerSlot(member, run.revision)).length, ready };
    return { ...safeRun, tasks: safeRun.tasks.map(task => { // Older records predate task.revision; steering clears the task list, so the retained run revision identifies their plan.
      const revision = task.revision ?? safeRun.revision;
      const attempts = withUsage.members.filter(member => member.taskId === task.id && member.revision === revision);
      const usage = attempts.flatMap(member => member.usage?.messages ? [member.usage] : []);
      return { ...task, revision, ...(usage.length ? { usage: { usd: Math.round(usage.reduce((n, row) => n + row.cost, 0) * 1_000_000) / 1_000_000, unpriced: usage.reduce((n, row) => n + row.pricing.unknown, 0), tokens: usage.reduce((n, row) => n + Object.values(row.tokens).reduce((a, b) => a + b, 0), 0), attempts: attempts.length, profiles: [...new Set(attempts.map(member => member.modelProfile?.id).filter((id): id is string => Boolean(id)))].sort() } } : {}) };
    }), members: withUsage.members, usage: withUsage.rollup, providerLimits: this.limits.active(), workers };
  }
  private save(stored: Stored) {
    stored.run.updatedAt = timestamp();
    writeSealed(join(this.directory, `${stored.run.id}.sealed`), this.key, `team:${stored.run.id}`, stored);
  }
  private async nameRequest(id: string, objective: string) {
    try {
      const title = (await this.titler!.requestTitle(objective))?.text;
      if (!title) return;
      await this.enqueue(() => {
        const stored = this.records.get(id), run = stored?.run;
        if (this.closed || !stored || !run || run.titleSource !== "request" || !["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering", "needs-input", "paused"].includes(run.status)) return;
        run.title = title;
        run.titleSource = "model";
        this.save(stored);
      });
    } catch { /* Best-effort naming never affects team creation or execution. */ }
  }
  private event(stored: Stored, text: string) { runEvent(stored.run, text); }
  list(): TeamView[] { return [...this.records.values()].map(record => this.view(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  /** Status rows for owner alerts. Unlike list(), reading them does not refresh tracker state. */
  statuses() { return [...this.records.values()].map(stored => ({ id: stored.run.id, title: stored.run.title, status: stored.run.status, reason: stored.run.reason, resumable: this.canResume(stored) && !stored.run.goal && !stored.run.missionId, goal: Boolean(stored.run.goal), mission: Boolean(stored.run.missionId) })); }
  /** Read mission ownership without building a view or updating external tracking. */
  missionIdOf(id: string): string | undefined { return this.record(id).run.missionId; }
  get(id: string): TeamView { return this.view(this.record(id)); }
  rateTask(id: string, taskId: string, input: { requestId: string; score: number; note?: string }) {
    const stored = this.record(id), task = stored.run.tasks.find(item => item.id === taskId);
    if (!task) throw new TeamError(404, "task-not-found", "The team task was not found.");
    const fingerprint = digest({ taskId, score: input.score, ...(input.note ? { note: input.note } : {}) });
    const prior = stored.ratings?.[input.requestId];
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-id-reused", "This request ID was already used for a different task rating.");
      return task;
    }
    const rating = { score: input.score as 1 | 2 | 3 | 4 | 5, ...(input.note ? { note: input.note } : {}), at: timestamp() };
    task.ownerRating = rating;
    (stored.ratings ??= {})[input.requestId] = { fingerprint, result: rating };
    this.event(stored, `The owner rated task ${taskId}.`); this.save(stored);
    return task;
  }
  async bundle(id: string) {
    const stored = this.record(id), run = stored.run;
    if (run.status !== "ready-for-review") throw new TeamError(409, "team-not-ready", "This team is not ready to pull.");
    const { revision, headCommit, branch, workspace } = run;
    if (!headCommit) throw new TeamError(409, "team-no-result", "This team has no recorded result to pull.");
    this.assertRunPath(stored, workspace);
    const head = await teamCommand({ command: "git", args: teamGitArgs(workspace, ["rev-parse", "--verify", `refs/heads/${branch}`]) }, workspace, undefined, 30000, this.config.teams?.commandPrefix).catch(() => {
      throw new TeamError(409, "team-branch-changed", "The team's integration branch no longer matches its recorded result.");
    });
    if (run.status !== "ready-for-review" || run.revision !== revision || run.headCommit !== headCommit)
      throw new TeamError(409, "team-not-ready", "This team changed while its result was being prepared. Refresh team status and retry.");
    if (head.exitCode !== 0 || head.interrupted || head.truncated || head.stdout.trim() !== headCommit)
      throw new TeamError(409, "team-branch-changed", "The team's integration branch no longer matches its recorded result.");
    return { workspace, branch, head: headCommit };
  }
  activeForProject(projectId: string) {
    return [...this.records.values()].some(({ run }) => run.projectId === projectId && activeTeamRun(run.status));
  }
  isActiveRun(id: string) { const stored = this.records.get(id); return Boolean(stored && activeTeamRun(stored.run.status)); }
  create(request: CreateTeam): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    return this.createRun(parsed);
  }
  /** Goal authority and model snapshots come from the host, never from a public create body. */
  createForGoal(request: CreateTeam, goal: TeamGoalContext, lineup: TeamLineup, linearTracking = false): Promise<TeamView> {
    return this.createRun(createTeamSchema.parse(request), { goal: teamGoalContextSchema.parse(goal), lineup: teamLineupSchema.parse(lineup) }, linearTracking);
  }
  /** A mission subteam is an ordinary run of one repository under that repository's own policies; the mission pins its lineup. */
  createForMission(request: CreateTeam, missionId: string, lineup: TeamLineup, options: { baseRunId?: string } = {}): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    const project = this.config.projects.find(item => item.id === parsed.projectId);
    return this.createRun(parsed, { missionId, ...(options.baseRunId ? { baseRunId: options.baseRunId } : {}), lineup: teamLineupSchema.parse(lineup) }, Boolean(project?.linear));
  }
  assertHandoffPolicy(policy: HandoffPolicy) {
    const project = this.config.projects.find(item => item.id === policy.projectId);
    if (!project || JSON.stringify(project.team) !== JSON.stringify(policy.project) || JSON.stringify(project.linear) !== JSON.stringify(policy.linear) || realpathSync(project.path) !== policy.path || this.config.teams?.workspaceDir !== policy.workspaceDir || JSON.stringify(this.config.teams?.commandPrefix) !== JSON.stringify(policy.commandPrefix))
      throw new TeamError(409, "handoff-policy-changed", "Project authority changed after the source session started; inspect the checkpoint before creating a new team.");
    for (const selection of lineupProfiles(policy.lineup)) {
      const profile = this.config.agents[selection.provider];
      if (!profile || (/(^|\/)sudo$/.test(profile.command) && !policy.commandPrefix)) throw new TeamError(409, "handoff-provider-unavailable", "A snapshotted provider execution profile is unavailable.");
      teamModelLaunch(profile, selection);
    }
  }
  createForHandoff(request: CreateTeam, handoff: TeamHandoffContext, policy: HandoffPolicy): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    if (policy.sourceSessionId !== handoff.sourceSessionId || policy.projectId !== parsed.projectId || JSON.stringify(policy.project) !== JSON.stringify(handoff.project))
      throw new TeamError(409, "handoff-identity-mismatch", "The handoff policy, source, and team project must match before a team can start.");
    this.assertHandoffPolicy(policy);
    return this.createRun(parsed, { handoff, handoffPolicy: policy, lineup: policy.lineup }, Boolean(policy.linear));
  }
  private createRun(parsed: CreateTeam, internal?: { goal?: TeamGoalContext; missionId?: string; baseRunId?: string; handoff?: TeamHandoffContext; handoffPolicy?: HandoffPolicy; lineup: TeamLineup }, linearTracking = false): Promise<TeamView> {
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
      const reservedBy = this.missionReservations?.(parsed.projectId, internal?.missionId);
      if (reservedBy) throw new TeamError(409, "mission-repository-reserved", `Mission ${reservedBy} holds repository ${parsed.projectId} for an active subteam or pending launch.`);
      if (internal?.missionId && this.activeForProject(parsed.projectId))
        throw new TeamError(409, "project-team-active", `An active team run already holds repository ${parsed.projectId}; this mission subtask cannot start until it finishes or is cancelled.`);
      if (!this.config.teams || !project.team || (!project.team.checks.length && !project.team.establishChecks)) throw new TeamError(409, "teams-not-configured", "Configure a team workspace directory and required checks, or authorize the team to establish checks, before starting a team.");
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
      if (project.team.permissions && (!lineup || lineup.coordinator.tier !== "strong" ||
          lineup.coordinator.limitFallback !== undefined && lineupProfiles(lineup).find(profile => profile.id === lineup.coordinator.limitFallback)?.tier !== "strong"))
        throw new TeamError(409, "permission-lineup-required", "Delegated permissions require a strong coordinator and any configured coordinator fallback must also be strong.");
      const parentId = goal?.parentRunId ?? internal?.baseRunId;
      const parent = parentId ? this.record(parentId).run : undefined;
      if (parent && (goal
        ? parent.goal?.id !== goal.id || parent.projectId !== parsed.projectId || !["ready-for-review", "merged"].includes(parent.status) || !parent.headCommit
        : parent.projectId !== parsed.projectId || parent.missionId !== internal?.missionId || !["ready-for-review", "merged", "no-change"].includes(parent.status) || !parent.headCommit))
        throw new TeamError(409, goal ? "invalid-goal-parent" : "invalid-mission-base", goal ? "Continue only from a ready, recorded run of this goal and project." : "Continue only from a completed subtask in this mission and project with a recorded workspace head.");
      if (parent) this.assertRunPath(this.record(parent.id), parent.workspace);
      const source = { path: parent?.workspace ?? project.path, ...(parent ? { head: parent.headCommit!, ...(parent.status === "merged" ? { startCommit: parent.deliveryReceipt!.mergeCommit } : {}) } : internal?.handoff ? { head: internal.handoff.checkpointHead } : {}) };
      const parentRevision = parent?.revision;
      const at = timestamp();
      const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "team";
      const suffix = parsed.requestId.slice(0, 8);
      const directoryName = `${project.teamworkDir ? "" : `${project.id}-`}${at.slice(0, 10)}-${slug}-${suffix}`;
      // The `infinite/team-` prefix keeps constrained launchers that allow only team branches working.
      const branch = `infinite/team-${slug}-${suffix}`;
      const root = project.teamworkDir ?? this.config.teams.workspaceDir;
      const fallbackTitle = parsed.objective.trim().split("\n")[0]!.slice(0, 100).trim();
      const titleSource = !internal?.goal && !internal?.handoff && !internal?.missionId && parsed.title === fallbackTitle ? "request" as const : undefined;
      const run: TeamRun = { linearTracking: internal ? linearTracking : Boolean(project.linear), id: parsed.requestId, projectId: parsed.projectId, provider: parsed.provider, ...(lineup ? { lineup } : {}), ...(project.team.permissions ? { permissions: structuredClone(project.team.permissions), permissionDecisions: [] } : {}), ...(goal ? { goal } : {}), ...(internal?.missionId ? { missionId: internal.missionId } : {}), ...(internal?.handoff ? { handoff: structuredClone(internal.handoff) } : {}), ...(titleSource ? { titleSource } : {}), title: parsed.title, objective: parsed.objective, parallelism: parsed.parallelism, revision: 1, status: "planning", createdAt: at, updatedAt: at, workspace: teamWorkspacePath(root, directoryName), branch, baseCommit: "", tasks: [], members: [], decisions: [], checks: [], steering: [], events: [], round: 0 };
      if (project.team.delivery) {
        if (!lineup || lineup.coordinator.tier !== "strong" || lineup.reviewer.tier !== "strong")
          throw new TeamError(409, "delivery-lineup-required", "Automatic merge requires a configured strong coordinator and independent strong reviewer.");
        run.delivery = structuredClone(project.team.delivery);
      }
      if (parent?.establishChecks || project.team.establishChecks) {
        run.establishChecks = true;
        if (parent?.verification) run.verification = structuredClone(parent.verification);
      }
      this.assertBudget(run);
      const anchor = project.teamworkDir ? realpathSync(this.config.sync?.homeDir ?? homedir()) : undefined;
      if (anchor) {
        assertTeamworkPath(this.config, root);
        ensureHostDirectory(anchor, root, 0o750);
      } else ensureDefaultTeamRoot(root, true);
      const stored: Stored = { run, fingerprint, receipts: {}, prepared: false, root, ...(anchor ? { anchor } : {}), source, ...(internal?.handoffPolicy ? { handoffPolicy: structuredClone(internal.handoffPolicy) } : {}) };
      this.records.set(run.id, stored); this.event(stored, "Team created; preparing an isolated copy of the configured project."); this.save(stored);
      if (run.titleSource === "request" && this.titler) void this.nameRequest(run.id, parsed.objective);
      this.operation(stored, "prepare", async signal => this.startInProject(run.projectId, async () => {
        const assertParent = () => {
          if (parent && (!["ready-for-review", "merged", "no-change"].includes(parent.status) || parent.revision !== parentRevision || parent.headCommit !== source.head))
            throw new TeamError(409, "parent-workspace-changed", "The predecessor run changed while its continuation was being prepared.");
        };
        assertParent();
        if (project.teamworkDir) assertTeamworkPath(this.config, root);
        this.assertRunPath(stored, teamWorkspacePath(root, directoryName), true);
        const workspace = await prepareTeamWorkspace(source.path, root, directoryName, branch, this.config.teams?.commandPrefix, signal, source.head, anchor, source.startCommit);
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
  private replay(stored: Stored, operation: string, body: Action | Mutation | TeamParallelism) {
    const prior = stored.receipts[body.requestId];
    if (!prior) return false;
    if (prior !== digest({ operation, ...body })) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team action.");
    return true;
  }
  private mutation(stored: Stored, operation: string, body: Action | Mutation | TeamParallelism) {
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
    return this.enqueue(async () => {
      const stored = this.record(id);
      if (this.replay(stored, "steer", body)) return this.view(stored);
      if (stored.deliveryAttempt || stored.run.deliveryReceipt) throw new TeamError(409, "delivery-reconciliation-required", "Inspect the recorded pull request before starting another run; steering cannot replay a started delivery.");
      if (stored.pending && !this.commands.has(id)) throw new TeamError(409, "team-reconciliation-required", "This team has an unresolved workspace or verification operation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (stored.pending && stored.pending.kind !== "check") throw new TeamError(409, "team-operation-running", "A workspace operation is in progress. Retry steering after it settles.");
      if (Buffer.byteLength(stored.run.steering.map(item => item.text).join("")) + Buffer.byteLength(body.text) > 32 * 1024) throw new TeamError(409, "team-steering-limit", "This team reached its 32 KiB steering limit. Start a new team with consolidated requirements.");
      if (stored.run.steering.length >= 20) throw new TeamError(409, "team-steering-limit", "This team reached its steering limit. Start a new team from the reviewed integration branch.");
      if (!this.mutation(stored, "steer", body)) return this.view(stored);
      this.commands.get(id)?.abort();
      await this.invalidatePermissionDecisions(stored, "The team revision changed before the permission request could be answered.");
      stored.run.revision++; stored.run.steering.push({ text: body.text, revision: stored.run.revision, at: timestamp() });
      stored.run.status = "planning"; stored.halt = "steer"; stored.run.reason = "Stopping earlier members before planning the updated request.";
      stored.run.tasks = []; stored.run.review = undefined; stored.run.round = 0; stored.checkHead = undefined;
      stored.run.brief = undefined; stored.run.noChange = undefined;
      if (stored.run.discovery && !stored.run.discovery.completedAt) stored.run.discovery.completedAt = timestamp();
      this.event(stored, "User steering recorded. Earlier reports cannot satisfy the new revision."); this.save(stored);
      return this.view(stored);
    });
  }
  setParallelism(id: string, input: TeamParallelism) {
    const body = teamParallelismSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, "parallelism", body)) return this.view(stored);
      if (body.revision !== run.revision) throw new TeamError(409, "stale-team-revision", "The team changed. Refresh it before sending this action.");
      if (["cancelled", "ready-for-review", "merged", "no-change"].includes(run.status))
        throw new TeamError(409, "team-not-running", "The worker limit can only change while the team is running.");
      if (run.handoff && body.parallelism > 2)
        throw new TeamError(409, "team-parallelism-limit", "Handoff teams support at most two workers.");
      if (!this.mutation(stored, "parallelism", body)) return this.view(stored);
      if (run.parallelism !== body.parallelism) {
        const previous = run.parallelism;
        run.parallelism = body.parallelism;
        this.event(stored, `The owner changed the worker limit from ${previous} to ${body.parallelism}.`);
      }
      this.save(stored);
      return this.view(stored);
    });
  }
  answer(id: string, decisionId: string, input: Mutation, authorizeNewAnswer?: () => void, by: "owner" | "coordinator" = "owner") {
    const body = teamMutationSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, `answer:${decisionId}`, body)) return this.view(stored);
      authorizeNewAnswer?.();
      const decision = run.decisions.find(item => item.id === decisionId && item.revision === run.revision);
      if (!decision) throw new TeamError(404, "decision-not-found", "This decision is no longer current.");
      if (stored.receipts[body.requestId]) { this.mutation(stored, `answer:${decisionId}`, body); return this.view(stored); }
      if (decision.answer) throw new TeamError(409, "decision-answered", "This decision already has an answer.");
      if (stored.halt || run.status === "paused") throw new TeamError(409, "team-paused", "Resume the team before answering its decision.");
      if (!this.mutation(stored, `answer:${decisionId}`, body)) return this.view(stored);
      decision.answer = body.text; decision.answeredBy = by; decision.answeredAt = timestamp();
      this.event(stored, by === "coordinator" ? "A mission coordinator decision was recorded. The requesting member will continue in a new attempt." : "A user decision was recorded. The requesting member will continue in a new attempt."); this.save(stored);
      return this.view(stored);
    });
  }
  revokePermissions(id: string, input: Action) {
    const body = teamActionSchema.parse(input);
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (!run.permissions) throw new TeamError(409, "permissions-not-enabled", "This team has no delegated permission policy to revoke.");
      if (this.replay(stored, "revoke-permissions", body)) return this.view(stored);
      if (!this.mutation(stored, "revoke-permissions", body)) return this.view(stored);
      run.permissionsRevokedAt ??= timestamp();
      await this.invalidatePermissionDecisions(stored, "The owner revoked delegated permission decisions.");
      this.event(stored, "Delegated permission decisions were revoked by the owner.");
      this.save(stored);
      return this.view(stored);
    });
  }
  private async invalidatePermissionDecisions(stored: Stored, reason: string) {
    const inFlight: TeamPermissionDecision[] = [];
    for (const decision of stored.run.permissionDecisions ?? []) if (["pending", "reviewing", "approved", "answering"].includes(decision.status)) {
      if (decision.status === "answering") { decision.status = "uncertain"; inFlight.push(decision); }
      else decision.status = "stale";
      decision.reason = reason;
    }
    if (inFlight.length) this.save(stored);
    let uncertain = false;
    for (const decision of inFlight) {
      try {
        const fence = await this.manager.invalidateTeamPermission(decision.targetSessionId, decision.id);
        if (fence !== "invalidated") uncertain = true;
      } catch { uncertain = true; }
    }
    if (uncertain) this.event(stored, "An in-flight delegated permission answer could not be conclusively fenced. Its decision remains uncertain; inspect the target session.");
    this.save(stored);
  }
  pause(id: string, input: Action) { return this.action(id, "pause", teamActionSchema.parse(input)); }
  resume(id: string, input: Action) { return this.action(id, "resume", teamActionSchema.parse(input)); }
  cancel(id: string, input: Action) { return this.action(id, "cancel", teamActionSchema.parse(input)); }
  private action(id: string, action: "pause" | "resume" | "cancel", body: Action) {
    return this.enqueue(async () => {
      const stored = this.record(id), run = stored.run;
      if (this.replay(stored, action, body)) return this.view(stored);
      if (action === "pause" && ["blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) throw new TeamError(409, "team-not-running", "This team is not running and cannot be paused.");
      if (action === "resume" && (stored.pending || stored.deliveryAttempt || run.deliveryReceipt || !stored.prepared || (run.status === "blocked" && !this.canResume(stored))))
        throw new TeamError(409, "team-reconciliation-required", "This team requires workspace reconciliation. Inspect its evidence and start a new team rather than replaying uncertain work.");
      if (action === "resume" && stored.halt) throw new TeamError(409, "members-stopping", "Wait for the team's active members to stop before resuming.");
      if (!this.mutation(stored, action, body)) return this.view(stored);
      if (action === "resume") {
        if (run.status !== "paused" && !this.canResume(stored)) { this.save(stored); return this.view(stored); }
        // Pausing stopped native agents. Replan from the confirmed integration head, preserving stopped copies for inspection.
        run.revision++; run.tasks = []; run.review = undefined; run.round = 0; stored.checkHead = undefined;
        run.brief = undefined; run.noChange = undefined;
        if (run.discovery && !run.discovery.completedAt) run.discovery.completedAt = timestamp();
        await this.invalidatePermissionDecisions(stored, "The team resumed under a new revision.");
        run.status = "planning"; run.reason = undefined;
      } else {
        run.status = action === "pause" ? "paused" : "cancelled"; stored.halt = action;
        await this.invalidatePermissionDecisions(stored, `The team was ${action} before the permission request could be answered.`);
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
        try {
          // One session listing every 2 s feeds the usage ledger and the limit memory, which follows
          // every session on the host, not only team members.
          if (Date.now() - this.reconciledAt >= 2000) {
            this.reconciledAt = Date.now();
            const rows = await this.manager.list().catch(() => undefined);
            if (rows) {
              await this.usage?.tick(rows).catch(() => {});
              await this.limits.reconcile(this.manager, rows).catch(() => {});
            }
          }
          for (const stored of this.records.values()) await this.step(stored);
        }
        finally { this.tickQueued = false; }
      }).catch(() => { this.tickQueued = false; });
    };
    this.timer = setInterval(tick, 500); this.timer.unref(); tick();
  }
  close() { this.closed = true; this.running = false; if (this.timer) clearInterval(this.timer); for (const controller of this.commands.values()) controller.abort(); }
  /** Settles once work queued before now has finished, so a caller can stop sessions it may still launch. */
  idle() { return this.serial.then(() => undefined); }
  private stallWindow() { return (this.config.teams?.stallMinutes ?? 30) * 60000; }
  /**
   * Extends a deadline only under the owner's recorded policy, and only while an active member of this
   * revision showed activity within the stall window. The extension never passes the policy's ceiling.
   */
  private extendDeadline(run: TeamRun, budget: TeamGoalContext | TeamHandoffContext) {
    if (!budget.extendMinutes || !budget.ceilingAt) return false;
    const ceiling = Date.parse(budget.ceilingAt);
    if (Date.now() >= ceiling) return false;
    const windowMs = this.stallWindow();
    if (!run.members.some(member => member.revision === run.revision && member.status === "running" && !member.report && !member.pendingLimit && member.lastActivityAt && Date.now() - Date.parse(member.lastActivityAt) <= windowMs)) return false;
    const requested = Math.max(Date.now(), Date.parse(budget.deadlineAt)) + budget.extendMinutes * 60000;
    budget.deadlineAt = new Date(Math.min(requested, ceiling)).toISOString();
    runEvent(run, `The time limit was extended by ${budget.extendMinutes} minutes under the approved extension policy (ceiling ${clock(budget.ceilingAt)}) because an agent showed activity within the ${this.config.teams?.stallMinutes ?? 30}-minute stall window.`);
    const stored = this.records.get(run.id);
    if (stored) this.save(stored);
    return true;
  }
  /** Owner extensions reach the active goal team, so its own deadline check and the goal agree. */
  goalExtension(teamId: string, requestId: string) {
    const stored = this.record(teamId), receipt = stored.goalExtensions?.[requestId];
    return receipt && { ...receipt, stopReason: stored.run.stopReason };
  }
  extendGoalTime(teamId: string, requestId: string, minutes: number, goalDeadlineAt: string, goalCeilingAt: string,
    intent?: { deadlineAt: string; ceilingAt: string }) {
    return this.enqueue(() => {
      const stored = this.record(teamId);
      const recorded = this.goalExtension(teamId, requestId);
      if (recorded) return recorded;
      if (!stored.run.goal) throw new TeamError(409, "not-a-goal-team", "This team does not belong to a goal.");
      if (stored.run.stopReason && stored.run.stopReason !== "deadline") throw new TeamError(409, "team-stopped-at-limit", "The active team has already stopped at its member limit.");
      const deadline = intent?.deadlineAt ?? new Date(Math.max(Date.now(), Date.parse(stored.run.goal.deadlineAt), Date.parse(goalDeadlineAt)) + minutes * 60000).toISOString();
      const ceiling = intent?.ceilingAt ?? new Date(Math.max(Date.parse(stored.run.goal.ceilingAt ?? goalCeilingAt), Date.parse(goalCeilingAt), Date.parse(deadline))).toISOString();
      const goal = { ...stored.run.goal };
      goal.deadlineAt = new Date(Math.max(Date.parse(goal.deadlineAt), Date.parse(deadline))).toISOString();
      goal.ceilingAt = new Date(Math.max(Date.parse(goal.ceilingAt ?? goalCeilingAt), Date.parse(ceiling), Date.parse(goal.deadlineAt))).toISOString();
      goal.ownerExtendedDeadlineAt = goal.deadlineAt;
      const receipt = { deadlineAt: goal.deadlineAt, ceilingAt: goal.ceilingAt };
      const next = { ...stored, run: { ...stored.run, goal }, goalExtensions: { ...stored.goalExtensions, [requestId]: receipt } };
      // Publish only after persistence: a failed write must not leave a replayable in-memory receipt.
      this.save(next);
      Object.assign(stored.run, next.run); stored.goalExtensions = next.goalExtensions;
      return { ...receipt, stopReason: stored.run.stopReason };
    });
  }
  private assertBudget(run: TeamRun, addingMember = false) {
    const policy = this.records.get(run.id)?.handoffPolicy;
    if (policy) this.assertHandoffPolicy(policy);
    const budget = run.goal ?? run.handoff;
    if (budget && Date.now() >= Date.parse(budget.deadlineAt) && !this.extendDeadline(run, budget)) {
      run.stopReason = "deadline";
      throw new TeamError(409, "goal-deadline", "The goal reached its deadline. Active work is being stopped and retained for inspection.");
    }
    const limit = (run.goal ?? run.handoff)?.maxMembers ?? 60;
    if (run.members.length + (addingMember ? 1 : 0) > limit) {
      if (run.goal || run.handoff) run.stopReason = "member-limit";
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
    void this.invalidatePermissionDecisions(stored, "The team became blocked before the permission request could be answered.");
    if (!["paused", "cancelled"].includes(stored.run.status)) { stored.run.status = "blocked"; stored.halt = "block"; }
    stored.run.reason = stored.run.stopReason === "deadline" ? "The goal reached its deadline. Active work is being stopped and retained for inspection."
      : stored.run.stopReason === "member-limit" ? "The goal reached this run's agent attempt limit. Active work is being stopped and retained for inspection."
        : error instanceof TeamError ? error.message : "A team operation failed. Its workspaces and recorded evidence were preserved for inspection.";
    this.event(stored, stored.run.reason); this.save(stored); this.trackBlocked(stored);
  }
  /** Queue the blocked evidence with the host's resume answer, so it is written even when no client is reading. */
  private trackBlocked(stored: Stored) {
    if (stored.run.status === "blocked") this.linear?.updateTeam(stored.run, stored.run.linearTracking === true, this.canResume(stored));
  }
  private hasLaunch(member: TeamMember) {
    try { this.manager.meta(member.sessionId); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  private async stopped(member: TeamMember) {
    const state = await this.manager.stopTeamSession(member.sessionId, member.stopRequestId, assignment(member));
    if (state.status !== "exited") return undefined;
    member.status = "stopped"; return state;
  }
  private async stopObsoletePermissionCoordinators(stored: Stored) {
    const run = stored.run;
    for (const member of run.members.filter(item => item.revision === run.revision && item.role === "permission-coordinator" && activeMember(item))) {
      const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
      const target = decision && run.members.find(item => item.memberId === decision.targetMemberId && item.sessionId === decision.targetSessionId);
      let obsolete = !decision || decision.status !== "reviewing" || run.permissionsRevokedAt || !run.permissions ||
        ["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status) || !target || !activeMember(target);
      if (!obsolete && decision && target) {
        try {
          const state = await this.manager.state(target.sessionId, true), prompt = state.attention.prompt;
          obsolete = state.status !== "running" || state.attention.state !== "needs-you" || !prompt ||
            prompt.id !== decision.promptId || prompt.hash !== decision.promptHash ||
            permissionEvidenceHash(prompt) !== decision.evidenceHash;
        } catch { obsolete = true; }
      }
      if (!obsolete) continue;
      const decisionChanged = decision?.status === "reviewing";
      if (decision && decisionChanged) {
        decision.status = "escalated";
        decision.reason = "The target request or team stage changed while the read-only permission review was running.";
      }
      const wasUnavailable = member.status === "unavailable";
      let stopConfirmed = false;
      try { stopConfirmed = Boolean(await this.stopped(member)); }
      catch { /* Keep the member visible as unavailable until its process is confirmed stopped. */ }
      if (!stopConfirmed) {
        member.status = "unavailable";
        if (!wasUnavailable) {
          this.event(stored, "The obsolete permission coordinator could not be confirmed stopped and remains unavailable for inspection.");
        }
        if (decisionChanged || !wasUnavailable) this.save(stored);
        continue;
      }
      this.event(stored, "The obsolete permission coordinator was confirmed stopped; it cannot authorize a later request."); this.save(stored);
    }
  }
  private async step(stored: Stored) {
    const run = stored.run;
    try {
      const tracking = this.linear?.updateTeam(run, run.linearTracking === true) ?? run.linear;
      if (JSON.stringify(run.linear) !== JSON.stringify(tracking)) { run.linear = tracking; this.save(stored); }
      if (tracking?.status === "blocked" && !stored.halt && !["cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) {
        this.block(stored, new TeamError(409, "linear-issue-changed", tracking.reason ?? "The Linear issue no longer permits this work. Review its requirements before starting another team."));
      }
      const trackingReady = !tracking || tracking.status === "synced";
      const budget = run.goal ?? run.handoff;
      if (!stored.halt && budget?.extendMinutes && budget.ceilingAt && Date.now() >= Date.parse(budget.deadlineAt) && Date.now() < Date.parse(budget.ceilingAt)) {
        for (const member of run.members.filter(item => item.revision === run.revision && item.status === "running" && !item.report)) {
          const state = await this.manager.state(member.sessionId);
          if (state.status !== "running") member.status = "unavailable";
          member.lastActivityAt = state.attention.lastActivityAt;
          member.pendingLimit = Boolean(state.attention.limit);
        }
        this.save(stored);
      }
      if (!stored.halt && !["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) this.assertBudget(run);
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
      if (!stored.prepared) return;
      if (["paused", "cancelled", "blocked", "ready-for-review", "merged", "no-change"].includes(run.status)) {
        await this.stopObsoletePermissionCoordinators(stored); return;
      }
      if ([providerInputReason, permissionReviewReason, runtimeUnavailableReason].includes(run.reason ?? "")) {
        const observedMembers = run.members.filter(member => member.revision === run.revision && activeMember(member) && member.status !== "queued" && !member.report);
        const states = await Promise.all(observedMembers.map(member => this.manager.state(member.sessionId)));
        if (this.closed) return;
        const held = states.flatMap((state, index) => state.status !== "exited" && state.attention.state === "needs-you"
          ? [underReview(run, observedMembers[index].sessionId, state.attention.prompt?.id)] : []);
        const reason = states.some(state => ["unavailable", "recording-error"].includes(state.status)) ? runtimeUnavailableReason
          : held.includes(false) ? providerInputReason : held.length ? permissionReviewReason : undefined;
        if (run.reason !== reason) { run.reason = reason; this.save(stored); }
      }
      if (stored.pending) return;
      this.assertRunPath(stored, run.workspace);
      for (const member of run.members.filter(item => item.revision === run.revision && activeMember(item))) {
        if (member.status === "queued") { await this.launch(stored, member); continue; }
        if (!member.report) {
          if (member.role === "permission-coordinator" && member.startedAt && Date.now() - Date.parse(member.startedAt) > 5 * 60 * 1000) {
            const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
            const decisionChanged = decision?.status === "reviewing", before = member.status;
            if (decision && decisionChanged) { decision.status = "escalated"; decision.reason = "The five-minute review window expired without a decision."; }
            try { if (!await this.stopped(member)) member.status = "unavailable"; }
            catch { member.status = "unavailable"; }
            // A coordinator that will not exit is retried each pass; report the expiry once.
            if (decisionChanged || before !== "unavailable") this.event(stored, "The permission coordinator exceeded its review window; the request remains with the user.");
            if (decisionChanged || member.status !== before) this.save(stored);
            continue;
          }
          const { page, limit } = this.readMemberJournal(run, member);
          if (!member.report && limit) {
            await this.switchLimitedMember(stored, member, limit);
            if (stored.pending || run.status === "blocked") return;
            continue;
          }
          if (!member.report) {
            const state = await this.manager.state(member.sessionId);
            member.lastActivityAt = state.attention.lastActivityAt;
            member.pendingLimit = Boolean(state.attention.limit);
            const journalDrained = !page.more && member.cursor >= state.seq;
            if (state.status === "exited" && (page.more || member.cursor < state.seq)) { this.save(stored); continue; }
            if (state.status === "exited") {
              if (member.stalledAt && journalDrained) {
                await this.replaceStalledMember(stored, member);
                if (stored.pending || run.status === "blocked") return;
                continue;
              }
              member.status = "stopped";
              if (member.role === "permission-coordinator") {
                const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
                if (decision && ["pending", "reviewing"].includes(decision.status)) {
                  decision.status = "escalated"; decision.reason = "The permission coordinator exited without its assigned decision report.";
                }
                this.event(stored, "The permission coordinator exited without a decision; the provider request remains with the user."); this.save(stored); continue;
              }
              this.block(stored, new TeamError(409, "missing-agent-report", "An agent exited without a valid structured report. Its task is unresolved.")); return;
            }
            // A member back from an outage may come back straight into a prompt; it is running again.
            if (state.status === "running" && member.status === "unavailable" && member.role !== "permission-coordinator") member.status = "running";
            if (state.attention.state === "needs-you" && await this.maybeStartPermissionReview(stored, member)) return;
            if (["unavailable", "recording-error"].includes(state.status)) { member.status = "unavailable"; run.reason = runtimeUnavailableReason; }
            // A prompt that waits on a person outranks one the coordinator is still reviewing.
            else if (state.attention.state === "needs-you")
              run.reason = underReview(run, member.sessionId, state.attention.prompt?.id) && run.reason !== providerInputReason ? permissionReviewReason : providerInputReason;
            // A coordinator back from an outage runs again only while its review is current; an obsolete or
            // expired one (its decision already moved on) stays unavailable until its exit is confirmed.
            else if (member.status !== "unavailable" || member.role !== "permission-coordinator" ||
              run.permissionDecisions?.some(item => item.coordinatorMemberId === member.memberId && item.status === "reviewing")) member.status = "running";
            this.save(stored);
            if (state.status === "running" && journalDrained && member.role !== "permission-coordinator" &&
                (member.stalledAt || state.attention.state !== "needs-you" && !member.pendingLimit && quietFor(member) > this.stallWindow())) {
              await this.replaceStalledMember(stored, member);
              if (stored.pending || run.status === "blocked") return;
            }
            continue;
          }
          this.save(stored);
        }
        try { if (!await this.stopped(member)) continue; }
        catch { member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); continue; }
        if (!trackingReady) { member.status = "reported"; member.exitConfirmedAt ??= timestamp(); this.save(stored); continue; }
        if (member.role === "implementer" && member.report?.kind === "result") {
          const position = run.tasks.findIndex(task => task.id === member.taskId);
          if (run.tasks.slice(0, position).some(task => task.status !== "integrated")) { member.status = "reported"; member.exitConfirmedAt ??= timestamp(); this.save(stored); continue; }
        }
        this.consume(stored, member);
        if (stored.pending || run.status === "blocked" || run.status === "no-change") return;
      }
      await this.stopObsoletePermissionCoordinators(stored);
      if (!trackingReady) return;
      // A recorded answer creates one replacement only after the original has confirmed exit.
      for (const decision of run.decisions.filter(item => item.revision === run.revision && item.answer)) {
        const prior = run.members.find(member => member.memberId === decision.memberId)!;
        if (prior.status !== "waiting") continue;
        // An answered scout or implementer keeps waiting, answer intact, until a worker slot frees under the current limit.
        if ((prior.role === "scout" || prior.role === "implementer") && run.members.filter(member => holdsWorkerSlot(member, run.revision)).length >= run.parallelism) continue;
        const answeredBy = decision.answeredBy === "coordinator" ? "Mission coordinator" : "User";
        const next = this.newMember(run, prior.role, prior.cwd, prior.baseCommit, prior.taskId, `${prior.prompt}\n\n${answeredBy} answered: ${decision.answer}`, prior.modelProfile);
        // A limit substitution may have pinned a fallback profile on another provider.
        next.provider = next.modelProfile?.provider ?? prior.provider ?? run.provider;
        prior.status = "stopped"; run.members.push(next);
        if (prior.role === "delivery" && stored.deliveryAttempt?.memberId === prior.memberId)
          stored.deliveryAttempt.memberId = next.memberId;
        const task = prior.role === "scout" ? run.discovery?.tasks.find(item => item.id === prior.taskId) : run.tasks.find(item => item.id === prior.taskId);
        if (task) { task.memberId = next.memberId; task.status = "running"; }
        this.save(stored);
      }
      if (run.discovery && !run.discovery.completedAt && run.discovery.revision === run.revision) {
        const scouts = run.discovery.tasks;
        const active = run.members.filter(member => member.role === "scout" && holdsWorkerSlot(member, run.revision)).length;
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
      if (run.members.some(member => member.revision === run.revision && activeMember(member) && member.role !== "implementer" && member.role !== "permission-coordinator")) return;
      if (run.members.some(member => member.revision === run.revision && member.status === "waiting" && member.role !== "implementer" && member.role !== "permission-coordinator")) { run.status = "needs-input"; this.save(stored); return; }
      if (!run.tasks.length) {
        if (run.members.some(member => member.revision === run.revision && member.role === "project-manager" && member.status === "waiting")) { run.status = "needs-input"; this.save(stored); return; }
        this.prepareMember(stored, "project-manager"); return;
      }
      const pendingTasks = run.tasks.filter(task => task.status === "pending");
      const activeCount = run.members.filter(member => member.revision === run.revision && activeMember(member) && member.role !== "permission-coordinator").length;
      const workerCount = run.members.filter(member => holdsWorkerSlot(member, run.revision)).length;
      const nextTask = pendingTasks.find(task => task.dependsOn.every(id => run.tasks.find(item => item.id === id)?.status === "integrated"));
      if (nextTask && workerCount < run.parallelism) { this.prepareMember(stored, "implementer", nextTask); return; }
      if (run.tasks.some(task => task.status !== "integrated")) {
        run.status = run.decisions.some(decision => decision.revision === run.revision && !decision.answer) ? "needs-input" : "implementing";
        this.save(stored); return;
      }
      if (activeCount) return;
      if (run.establishChecks && !run.verification?.checks.length)
        throw new TeamError(409, "verification-required", "Required verification commands have not been established; review cannot start.");
      if (stored.checkHead !== run.headCommit) { this.check(stored); return; }
      if (!run.review || run.review.revision !== run.revision) { this.prepareMember(stored, "reviewer"); return; }
      if (run.review.verdict === "approved") {
        await assertMemberReadOnly(run.workspace, run.headCommit!, this.config.teams?.commandPrefix);
        this.assertBudget(run);
        if (run.delivery) {
          this.assertDelivery(stored);
          if (stored.deliveryAttempt) throw new TeamError(409, "delivery-reconciliation-required", "Delivery started without a confirmed report. Inspect the recorded branch and pull request before retrying.");
          this.prepareMember(stored, "delivery");
        } else {
          run.status = "ready-for-review"; run.reason = undefined;
          this.event(stored, "The reviewer approved the integrated change and configured checks passed. Ready for human review; nothing was published."); this.save(stored);
        }
      }
    } catch (error) { this.block(stored, error); }
  }
  private escalatePermissionDecision(stored: Stored, decision: TeamPermissionDecision, reason: string, event: string) {
    decision.status = "escalated";
    decision.reason = reason;
    this.event(stored, event);
    this.save(stored);
  }
  private async maybeStartPermissionReview(stored: Stored, target: TeamMember) {
    const run = stored.run;
    if (!run.permissions || run.permissionsRevokedAt || target.status !== "running" ||
        stored.halt || ["paused", "cancelled", "blocked"].includes(run.status) || target.revision !== run.revision)
      return false;
    if (run.members.some(member => member.memberId !== target.memberId && member.revision === run.revision && member.role === "permission-coordinator" && activeMember(member))) return false;
    if (run.permissionDecisions?.length && run.permissionDecisions.length >= run.permissions.maxDecisions) return false;

    const state = await this.manager.state(target.sessionId, true);
    const prompt = state.attention.prompt;
    if (state.status !== "running" || state.attention.state !== "needs-you" || !prompt || oneShotPermissionOption(prompt) === undefined) return false;
    const evidenceHash = permissionEvidenceHash(prompt);
    const existing = (run.permissionDecisions ?? []).find(decision => decision.targetMemberId === target.memberId &&
      decision.targetSessionId === target.sessionId && decision.promptId === prompt.id && decision.promptHash === prompt.hash &&
      decision.evidenceHash === evidenceHash);
    if (existing) return false;
    if (!run.lineup || run.lineup.coordinator.tier !== "strong") return false;
    const makeDecision = (targetCwd: string): TeamPermissionDecision => ({
      id: randomUUID(), revision: run.revision, policyHash: digest(run.permissions!), targetMemberId: target.memberId,
      targetSessionId: target.sessionId, targetCwd, promptId: prompt.id, promptHash: prompt.hash!,
      evidenceHash, prompt: structuredClone(prompt), option: oneShotPermissionOption(prompt)!,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), answerRequestId: randomUUID(), status: "pending",
    });

    if (target.role === "permission-coordinator") {
      const decision = makeDecision(target.cwd);
      (run.permissionDecisions ??= []).push(decision);
      this.escalatePermissionDecision(stored, decision, "A permission request from the permission coordinator cannot be delegated again.", "The permission request remains with the user because it came from the permission coordinator.");
      return false;
    }

    let targetCwd: string;
    try { targetCwd = realpathSync(target.cwd); }
    catch {
      const decision = makeDecision(target.cwd);
      (run.permissionDecisions ??= []).push(decision);
      this.escalatePermissionDecision(stored, decision, "The target workspace could not be resolved for permission review.", "The permission request remains with the user because its workspace could not be resolved for review.");
      return false;
    }
    const decision = makeDecision(targetCwd);
    (run.permissionDecisions ??= []).push(decision);
    if (!this.config.agents[run.lineup.coordinator.provider]) {
      this.escalatePermissionDecision(stored, decision, "The pinned permission coordinator provider is not configured on this host.", "The permission request remains with the user because its pinned coordinator provider is not configured on this host.");
      return false;
    }
    try { this.assertBudget(run, true); }
    catch (error) {
      this.escalatePermissionDecision(stored, decision,
        error instanceof TeamError ? error.message : "The team has no remaining agent or deadline budget for a permission review.",
        "A permission request remains with the user because the team has no review budget.");
      return false;
    }
    if (run.lineup.coordinator.provider !== "claude") {
      this.escalatePermissionDecision(stored, decision, "The pinned permission coordinator provider is not qualified for report-only permission review.", "The permission request remains with the user because the selected coordinator provider is not qualified for report-only review.");
      return false;
    }

    const task = target.role === "scout" ? run.discovery?.tasks.find(item => item.id === target.taskId) : run.tasks.find(item => item.id === target.taskId);
    let changedPaths: string[];
    try { changedPaths = await memberChangedPaths(targetCwd, target.baseCommit, this.config.teams?.commandPrefix); }
    catch {
      this.escalatePermissionDecision(stored, decision, "The target's changed files could not be listed for review.", "The permission request remains with the user because its changed files could not be listed for review.");
      return false;
    }
    const feedback = JSON.stringify({ decisionId: decision.id, ownerScope: run.permissions.scope, objective: run.objective,
      targetAssignment: assignment(target), targetCwd: decision.targetCwd, targetTask: task ?? null,
      targetChangedPaths: changedPaths.slice(0, 100), targetChangedPathCount: changedPaths.length,
      acceptedChecks: this.requiredChecks(run) ?? null, prompt: decision.prompt });
    if (Buffer.byteLength(feedback, "utf8") > 16_000) {
      this.escalatePermissionDecision(stored, decision, "The recorded permission evidence exceeds the coordinator prompt limit and cannot be reviewed without truncation.", "The permission request remains with the user because its complete evidence exceeds the review limit.");
      return false;
    }
    const member = this.newMember(run, "permission-coordinator", "", run.headCommit!, undefined, undefined, run.lineup.coordinator);
    member.prompt = teamPrompt(run, "permission-coordinator", undefined, feedback, member.provider ?? run.provider, member.modelProfile);
    decision.coordinatorMemberId = member.memberId;
    const selectedProfile = this.config.agents[member.provider ?? run.provider];
    if (member.provider !== "claude" || !selectedProfile) {
      this.escalatePermissionDecision(stored, decision, "The selected permission coordinator provider is not qualified for report-only review.", "The permission request remains with the user because the selected coordinator provider is not qualified for report-only review.");
      return false;
    }
    try {
      permissionCoordinatorLaunch("claude", teamModelLaunch(selectedProfile, member.modelProfile!));
    } catch (error) {
      decision.status = "escalated";
      decision.reason = error instanceof Error ? error.message : "The selected coordinator profile cannot launch in report-only mode.";
      this.event(stored, "The permission request remains with the user because the pinned coordinator profile cannot launch safely in report-only mode.");
      this.save(stored);
      return false;
    }
    this.save(stored);
    this.operation(stored, "member", async signal => {
      this.assertRunPath(stored, run.workspace);
      const cwd = await prepareMemberWorkspace(run.workspace, member.memberId, member.baseCommit, this.config.teams?.commandPrefix, signal);
      await assertMemberReadOnly(cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
      return cwd;
    }, cwd => {
      member.cwd = cwd; run.members.push(member); decision.status = "reviewing";
      this.event(stored, "A screen-verified one-shot permission request was assigned to the pinned strong coordinator for read-only review.");
    });
    return true;
  }
  private async permissionAnswerInvalidReason(stored: Stored, decision: TeamPermissionDecision, coordinator: TeamMember) {
    const run = stored.run;
    if (!run.permissions || run.permissionsRevokedAt || stored.halt || ["paused", "cancelled", "blocked"].includes(run.status)) return "The team is paused, stopped, blocked, or its permission policy was revoked.";
    if (decision.status !== "approved" || decision.revision !== run.revision || coordinator.revision !== run.revision ||
        decision.coordinatorMemberId !== coordinator.memberId || decision.targetMemberId === coordinator.memberId)
      return "The decision or coordinator assignment is no longer current.";
    if (decision.policyHash !== digest(run.permissions))
      return "The pinned permission policy no longer matches this decision.";
    if (Date.now() >= Date.parse(decision.expiresAt)) return "The five-minute permission review window expired.";
    if (!run.lineup || run.lineup.coordinator.tier !== "strong") return "The pinned coordinator profile is no longer eligible.";
    try {
      this.assertBudget(run);
      const target = run.members.find(member => member.memberId === decision.targetMemberId && member.sessionId === decision.targetSessionId);
      if (!target || target.revision !== run.revision || target.status === "stopped" || !activeMember(target) || target.role === "permission-coordinator")
        return "The target member assignment is no longer active.";
      const canonicalCwd = realpathSync(target.cwd);
      if (canonicalCwd !== decision.targetCwd) return "The target working directory changed.";
      this.assertRunPath(stored, canonicalCwd);
      const metadata = this.manager.meta(target.sessionId).session;
      const sessionAssignment = metadata.team;
      if (!sessionAssignment || sessionAssignment.runId !== run.id || sessionAssignment.memberId !== target.memberId ||
          sessionAssignment.revision !== target.revision || sessionAssignment.role !== target.role || metadata.cwd !== canonicalCwd)
        return "The target session no longer matches its recorded assignment and working directory.";
      const state = await this.manager.state(target.sessionId, true);
      if (state.status !== "running" || state.control && state.control.expiresAt > Date.now()) return "The target is unavailable or a human control lease is active.";
      const prompt = state.attention.prompt;
      if (!prompt || state.attention.state !== "needs-you" || prompt.id !== decision.promptId || prompt.hash !== decision.promptHash ||
          permissionEvidenceHash(prompt) !== decision.evidenceHash || oneShotPermissionOption(prompt) !== decision.option)
        return "The target permission prompt or its one-shot option changed.";
    } catch (error) {
      return error instanceof TeamError ? error.message : "The current target session could not be verified.";
    }
    return undefined;
  }
  private consumePermissionCoordinator(stored: Stored, member: TeamMember) {
    const run = stored.run, report = member.report!;
    const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId && item.revision === member.revision);
    if (!decision) { this.block(stored, new TeamError(409, "invalid-permission-decision", "The permission coordinator has no recorded decision assignment.")); return; }
    const verdict = report.kind === "permission-decision" && report.decisionId === decision.id ? report.verdict : "escalate";
    const summary = report.kind === "permission-decision" ? report.summary : report.kind === "blocked" ? report.summary
      : report.kind === "question" ? report.question : "The coordinator did not submit the assigned permission decision report.";
    this.operation(stored, "result", async signal => {
      await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
      if (verdict !== "approve-once") return { status: "escalated" as const, reason: summary };
      decision.status = "approved";
      decision.reason = summary;
      this.save(stored);
      const reason = await this.permissionAnswerInvalidReason(stored, decision, member);
      if (reason) return { status: "escalated" as const, reason };
      if (decision.status !== "approved" || !run.permissions || run.permissionsRevokedAt || stored.halt ||
          ["paused", "cancelled", "blocked"].includes(run.status) || decision.revision !== run.revision ||
          decision.coordinatorMemberId !== member.memberId || decision.policyHash !== digest(run.permissions) ||
          Date.now() >= Date.parse(decision.expiresAt))
        return { status: "escalated" as const, reason: "The permission decision changed while the target session was being checked." };
      decision.status = "answering";
      decision.reason = summary;
      this.save(stored);
      try {
        const receipt = await this.manager.answerTeamPermission(decision.targetSessionId, decision.answerRequestId,
          assignment(run.members.find(target => target.memberId === decision.targetMemberId)!), decision);
        return receipt.state === "delivered" && receipt.result === "closed"
          ? { status: "answered" as const, receipt }
          : receipt.state === "uncertain" ? { status: "uncertain" as const, receipt, reason: "The host could not confirm whether the target prompt closed. Inspect the target session before acting." }
            : { status: "escalated" as const, receipt, reason: `The target prompt did not close (${receipt.result ?? receipt.state}). The request remains with the user.` };
      } catch (error) {
        if (refusedBeforeSend(error))
          return { status: "escalated" as const, reason: "The target prompt changed or became unavailable before the answer, and nothing was sent. The request remains with the user." };
        return { status: "uncertain" as const, reason: "The host could not confirm whether the target prompt was answered. Inspect the target session before acting." };
      }
    }, result => {
      if (["reviewing", "approved", "answering"].includes(decision.status)) { decision.status = result.status; decision.reason = result.reason ?? summary; }
      else decision.reason = "The decision changed while the answer was in flight. Inspect the target session before acting.";
      if ("receipt" in result) decision.receipt = result.receipt;
      member.status = "stopped";
      this.event(stored, result.status === "answered" ? "A one-shot permission option was delivered and the prompt closed." : "The permission request remains with the user.");
    });
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
  private assertDelivery(stored: Stored) {
    const run = stored.run, configured = this.config.projects.find(project => project.id === run.projectId)?.team?.delivery;
    if (!run.delivery || !configured || digest(configured) !== digest(run.delivery))
      throw new TeamError(409, "delivery-policy-changed", "The repository delivery policy changed or was removed; publication is blocked.");
    if (!run.headCommit || stored.checkHead !== run.headCommit || run.review?.revision !== run.revision || run.review.verdict !== "approved")
      throw new TeamError(409, "delivery-not-reviewed", "Delivery requires passing checks and independent approval for the current integration commit.");
  }
  private memberProfile(run: TeamRun, role: TeamMember["role"], task?: TeamTask | TeamScout): TeamModelProfile | undefined {
    if (!run.lineup) return undefined;
    if (role === "project-manager" || role === "delivery" || role === "permission-coordinator") return run.lineup.coordinator;
    if (role === "integrator") return run.lineup.integrator;
    if (role === "reviewer") return run.lineup.reviewer;
    if (!task) throw new TeamError(409, "invalid-agent-profile", "An implementer requires an assigned task and allowed model profile.");
    this.taskProfiles(run, [task]);
    return run.lineup.implementers.find(profile => profile.id === task.agentProfileId)!;
  }
  private newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, prompt?: string, pinnedProfile?: TeamModelProfile): TeamMember {
    this.assertBudget(run, true);
    const memberId = randomUUID();
    const task = role === "scout" ? run.discovery?.tasks.find(task => task.id === taskId) : run.tasks.find(task => task.id === taskId);
    let selected = pinnedProfile ?? this.memberProfile(run, role, task);
    const limit = selected && this.limits.active().find(item => item.provider === selected!.provider);
    const fallback = limit && run.lineup ? resolveLimitFallback(run.lineup, selected!.id, this.limits.limited()) : undefined;
    const retargeted = fallback && prompt !== undefined ? retargetPrompt(prompt, { provider: fallback.provider, profile: fallback }) : undefined;
    // Without a resolvable fallback, or with a passed prompt it cannot carry, the launch proceeds: the limit may have lifted.
    if (selected && limit && fallback && (prompt === undefined || retargeted !== undefined)) {
      runEvent(run, `${selected.label} launched on ${fallback.label}: ${PROVIDER_NAMES[limit.provider]} is limited until ${clock(limit.expiresAt)}`);
      prompt = retargeted; selected = fallback;
    }
    const modelProfile = selected ? structuredClone(selected) : undefined;
    const provider = modelProfile?.provider ?? run.provider;
    const configuredProject = this.config.projects.find(project => project.id === run.projectId)?.team;
    const instructions = prompt === undefined ? teamPrompt(run, role, task, undefined, provider, modelProfile, configuredProject) : refreshReportingInstructions(prompt, provider);
    if (Buffer.byteLength(instructions) > 80 * 1024) throw new TeamError(409, "team-prompt-too-large", "The accumulated team requirements exceed the prompt limit. Start a new team with consolidated requirements.");
    return { runId: run.id, memberId, revision: run.revision, role, ...(role === "project-manager" && !run.establishChecks && !run.verification ? { verificationRefused: true as const } : {}), provider, ...(modelProfile ? { modelProfile } : {}), ...(taskId ? { taskId } : {}), sessionId: randomUUID(), title: `${role}: ${taskId ?? run.title}`.slice(0, 100), status: "queued", cwd, baseCommit, prompt: instructions, cursor: 0, stopRequestId: randomUUID() };
  }
  /**
   * A limit acts only on the whole journal: a report or recovery in an unread tail wins.
   * After a confirmed exit, drain the tail even without a limit before considering replacement.
   */
  private readMemberJournal(run: TeamRun, member: TeamMember, exited = false) {
    let page: ReturnType<Manager["events"]>, limit: LimitSwitch | undefined;
    do {
      page = this.manager.events(member.sessionId, member.cursor, 200, new Set(["team-report", "signal"]));
      member.cursor = page.cursor;
      for (const event of page.events) {
        if (event.type === "signal") {
          const data = event.data;
          // Prefer a corroborated observation; a later successful turn means the member recovered.
          if (switchesMember(data)) { if (!limit || (limit.confidence !== "corroborated" && data.confidence === "corroborated")) limit = { ...data, at: event.at, seq: event.seq }; }
          else if (recoveryTurnEnd(data as unknown as SignalData) || (data.kind === "notice" && data.type === "quota_auto_resume_fired")) limit = undefined;
          continue;
        }
        const parsed = teamReportEnvelopeSchema.safeParse(event.data);
        if (!parsed.success) continue;
        const envelope = parsed.data;
        if (envelope.runId !== run.id || envelope.memberId !== member.memberId || envelope.revision !== member.revision) continue;
        member.report = envelope.report; member.status = "reported"; member.reportedAt = timestamp(); member.stalledAt = undefined;
        if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined;
        break;
      }
    } while (!member.report && (exited || limit) && page.more);
    return { page, limit };
  }
  /**
   * Stops a member with no attention activity for the stall window and continues its assignment once in
   * the same working copy. A second stall on the same assignment blocks the run for the owner.
   */
  private async replaceStalledMember(stored: Stored, member: TeamMember) {
    const run = stored.run, minutes = this.stallWindow() / 60000;
    const earlierStop = Boolean(member.stalledAt);
    member.stalledAt ??= timestamp();
    member.stoppedReason ??= `No activity for ${minutes} minutes`;
    this.save(stored);
    let exited;
    try { exited = await this.stopped(member); if (!exited) { this.save(stored); return; } }
    catch (error) {
      // A preflight or lease refusal proves only this attempt sent nothing, not an earlier uncertain attempt.
      const refused = error instanceof TeamStopRefused || error instanceof Error && ["control-busy", "control-lost"].includes((error as WorkerError).code ?? "");
      if (refused && !earlierStop) {
        member.stalledAt = undefined;
        if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined;
      }
      member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); return;
    }
    const { page, limit } = this.readMemberJournal(run, member, true);
    if (member.report) { this.save(stored); return; }
    if (page.more || member.cursor < exited.seq) { member.status = "unavailable"; this.save(stored); return; }
    if (limit) {
      member.stalledAt = undefined;
      if (member.stoppedReason?.startsWith("No activity for ")) member.stoppedReason = undefined;
      await this.switchLimitedMember(stored, member, limit); return;
    }
    // A delivery member may already have published; a replacement must not repeat it unseen.
    if (member.role === "delivery" && stored.deliveryAttempt) {
      this.block(stored, new TeamError(409, "delivery-reconciliation-required", "The delivery agent stalled after a publication attempt. Inspect the remote branch and PR before replacing it.")); return;
    }
    if (run.members.some(item => item !== member && item.revision === member.revision && item.role === member.role && item.taskId === member.taskId && item.stalledAt)) {
      this.block(stored, new TeamError(409, "member-stalled", memberStallReason)); return;
    }
    const task = member.role === "implementer" ? run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    const scout = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    const prefix = this.config.teams?.commandPrefix, editing = member.role === "implementer" || member.role === "integrator";
    const note = `The previous ${member.role} stalled with no activity for ${minutes} minutes before reporting. Its workspace was preserved. ${editing ? "Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing." : "Its working copy was checked unchanged; complete the same assignment."}`;
    this.operation(stored, "result", signal => editing ? assertMemberScope(member.cwd, member.baseCommit, task ? task.paths : run.goal?.allowedPaths, prefix, signal) : assertMemberReadOnly(member.cwd, member.baseCommit, prefix, signal), () => {
      const next = this.newMember(run, member.role, member.cwd, member.baseCommit, member.taskId, `${member.prompt}\n\n${note}`, member.modelProfile);
      if (task) { task.memberId = next.memberId; task.status = "running"; }
      if (scout) scout.memberId = next.memberId;
      run.members.push(next);
      this.event(stored, `${member.title} stalled with no activity for ${minutes} minutes; its workspace was preserved and a replacement continues the assignment.`);
    });
  }
  /**
   * Stops a member whose provider hit a limit and continues its assignment on the profile's limit
   * fallback in the same working copy. The host only stops the member; it never sends it input.
   */
  private async switchLimitedMember(stored: Stored, member: TeamMember, limit: LimitSwitch) {
    const run = stored.run, provider = member.provider ?? run.provider, name = PROVIDER_NAMES[provider];
    const kind = limit.limit === "credits" ? "credit limit" : "usage limit", resets = limit.resetsAt ? clock(limit.resetsAt) : undefined;
    if (limit.confidence === "corroborated") this.limits.observe({ provider, detectedAt: limit.at, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), sessionId: member.sessionId, runId: run.id, confidence: "corroborated" });
    // Until the member's exit is confirmed, the next tick reads this observation again.
    try { if (!await this.stopped(member)) { member.cursor = limit.seq - 1; this.save(stored); return; } }
    catch { member.cursor = limit.seq - 1; member.status = "unavailable"; run.reason = "An agent could not be stopped. Release its input control or inspect its terminal before integration."; this.save(stored); return; }
    member.stoppedReason = `${name} ${kind}${resets ? `, resets ${resets}` : ""}`;
    // A delivery member may already have published; a replacement must not repeat it unseen.
    if (member.role === "delivery" && stored.deliveryAttempt) {
      this.block(stored, new TeamError(409, "delivery-reconciliation-required", "The delivery provider stopped at a limit. Inspect the remote branch and PR before replacing a possibly completed publication.")); return;
    }
    const from = member.modelProfile, selected = from && run.lineup ? switchFallback(run.lineup, from.id, provider, this.limits.limited()) : undefined;
    // Only a Claude profile can run report-only permission review.
    const fallback = member.role === "permission-coordinator" && selected?.provider !== "claude" ? undefined : selected;
    if (!from || !fallback) {
      if (member.role === "permission-coordinator") {
        const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
        if (decision) { decision.status = "escalated"; decision.reason = "The coordinator provider reached a limit and no eligible strong fallback is available."; }
        member.status = "stopped"; this.save(stored);
        this.event(stored, "The permission review could not continue on an eligible coordinator profile; the request remains with the user.");
        return;
      }
      this.block(stored, new TeamError(409, "provider-limit", `${name} ${kind} reached at ${clock(limit.at)}${resets ? `, resets ${resets}` : ""}; no fallback profile is configured for ${from?.id ?? provider}.`));
      return;
    }
    const task = member.role === "implementer" ? run.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    if (member.role === "implementer" && !task) throw new TeamError(409, "invalid-task", "The implementer has no current task assignment.");
    const scout = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId && item.memberId === member.memberId) : undefined;
    const prefix = this.config.teams?.commandPrefix, editing = member.role === "implementer" || member.role === "integrator";
    const note = editing ? `The previous ${member.role} stopped at a ${name} ${kind}. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.`
      : `The previous ${member.role} stopped at a ${name} ${kind} before reporting. Its working copy was checked unchanged; complete the same assignment.`;
    // Editing roles keep in-scope partial work; read-only roles must have left their copy unchanged.
    this.operation(stored, "result", signal => editing ? assertMemberScope(member.cwd, member.baseCommit, task ? task.paths : run.goal?.allowedPaths, prefix, signal) : assertMemberReadOnly(member.cwd, member.baseCommit, prefix, signal), () => {
      // The prompt keeps its feedback and user answers. An unrecognized prompt is rebuilt with its answers.
      const configuredProject = this.config.projects.find(project => project.id === run.projectId)?.team;
      const carried = retargetPrompt(member.prompt, { provider: fallback.provider, profile: fallback }) ?? [teamPrompt(run, member.role, task ?? scout, undefined, fallback.provider, fallback, configuredProject),
        ...run.decisions.filter(decision => decision.answer && run.members.some(prior => prior.memberId === decision.memberId && prior.role === member.role && prior.taskId === member.taskId && prior.revision === member.revision)).map(decision => `${decision.answeredBy === "coordinator" ? "Mission coordinator" : "User"} answered: ${decision.answer}`)].join("\n\n");
      const next = this.newMember(run, member.role, member.cwd, member.baseCommit, member.taskId, `${carried}\n\n${note}`, fallback);
      if (task) {
        (task.limitSwitches ??= []).push({ fromProfileId: from.id, toProfileId: fallback.id, reason: limit.message, ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}), memberId: member.memberId, at: timestamp() });
        task.memberId = next.memberId; task.status = "running";
      }
      if (scout) scout.memberId = next.memberId;
      if (member.role === "permission-coordinator") {
        const decision = run.permissionDecisions?.find(item => item.coordinatorMemberId === member.memberId);
        if (decision && decision.status === "reviewing") decision.coordinatorMemberId = next.memberId;
      }
      run.members.push(next);
      this.event(stored, `${from.label} hit a ${name} ${kind}${resets ? ` (resets ${resets})` : ""}; ${task?.title ?? member.title} continues on ${fallback.label}${editing ? " with partial work preserved" : ""}.`);
    });
  }
  private prepareMember(stored: Stored, role: TeamMember["role"], task?: TeamTask | TeamScout, feedback?: string) {
    const run = stored.run, member = this.newMember(run, role, "", run.headCommit!, task?.id);
    if (feedback) member.prompt = teamPrompt(run, role, task, feedback, member.provider ?? run.provider, member.modelProfile, this.config.projects.find(project => project.id === run.projectId)?.team);
    if (role !== "permission-coordinator") run.status = role === "project-manager" ? "planning" : role === "scout" ? "discovering" : role === "reviewer" ? "reviewing" : role === "delivery" ? "delivering" : role === "integrator" ? "integrating" : "implementing";
    this.operation(stored, "member", async signal => {
      this.assertRunPath(stored, run.workspace);
      const cwd = await prepareMemberWorkspace(run.workspace, member.memberId, member.baseCommit, this.config.teams?.commandPrefix, signal);
      // Bootstrap dependencies exist only after the first implementation. A failed
      // setup must not prevent the integrator from repairing the project.
      const setup = role === "permission-coordinator" ? undefined : run.establishChecks
        ? role === "reviewer" ? run.verification?.setup : undefined
        : this.config.projects.find(project => project.id === run.projectId)!.team!.setup;
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
    this.assertRunPath(stored, member.cwd);
    // Recover an already-created assignment even while Linear is unavailable. A new
    // process requires the bridge's fresh feature and parent issue observations.
    if (!this.hasLaunch(member)) {
      const tracking = this.linear?.updateTeam(stored.run, stored.run.linearTracking === true) ?? stored.run.linear;
      if (JSON.stringify(stored.run.linear) !== JSON.stringify(tracking)) { stored.run.linear = tracking; this.save(stored); }
      if (tracking?.status === "blocked") throw new TeamError(409, "linear-issue-changed", tracking.reason ?? "The Linear issue no longer permits this work.");
      if (tracking && tracking.status !== "synced") return;
    }
    if (!this.hasLaunch(member) && (await this.manager.list()).filter(session => session.status === "running" || session.status === "starting").length >= this.config.maxSessions) { stored.run.reason = "Waiting for an available host session slot."; this.save(stored); return; }
    if (member.role === "delivery") {
      this.assertDelivery(stored);
      const attempt = stored.deliveryAttempt;
      if (attempt && (attempt.memberId !== member.memberId || attempt.revision !== member.revision || attempt.headCommit !== member.baseCommit))
        throw new TeamError(409, "delivery-reconciliation-required", "A different delivery attempt is unresolved; inspect the remote pull request before continuing.");
      await assertMemberReadOnly(stored.run.workspace, member.baseCommit, this.config.teams?.commandPrefix);
      stored.deliveryAttempt = { memberId: member.memberId, revision: member.revision, headCommit: member.baseCommit };
      this.save(stored);
    }
    // All launch fields were persisted with the queued member before this call.
    let result;
    try { result = await this.startInProject(stored.run.projectId, () => this.manager.createTeamSession({ requestId: member.sessionId, provider: member.provider ?? stored.run.provider, projectId: stored.run.projectId, title: member.title, prompt: member.prompt }, assignment(member), member.cwd, member.modelProfile, stored.root, this.config.teams?.trustWorkspaces === true)); }
    catch (error) { if (error instanceof Error && /configured session limit/.test(error.message)) { stored.run.reason = "Waiting for an available host session slot."; this.save(stored); return; } throw error; }
    member.status = result.status === "unavailable" ? "unavailable" : "running"; member.startedAt ??= timestamp(); this.save(stored);
  }
  private consume(stored: Stored, member: TeamMember) {
    const run = stored.run, report = member.report!;
    if (member.role === "permission-coordinator") { this.consumePermissionCoordinator(stored, member); return; }
    if (report.kind === "blocked") { this.block(stored, new TeamError(409, "agent-blocked", report.summary)); return; }
    if (report.kind === "question") {
      if (run.decisions.length >= 40) { this.block(stored, new TeamError(409, "team-decision-limit", "The team reached its limit of 40 decisions. Review its evidence before starting another team.")); return; }
      member.status = "waiting";
      run.decisions.push({ id: randomUUID(), memberId: member.memberId, revision: run.revision, question: report.question, options: report.options, createdAt: timestamp() });
      const task = member.role === "scout" ? run.discovery?.tasks.find(item => item.id === member.taskId) : run.tasks.find(item => item.id === member.taskId); if (task) task.status = "waiting";
      run.status = "needs-input"; this.event(stored, `${member.title} requested a user decision.`); this.save(stored); return;
    }
    const expected = member.role === "project-manager" ? ["plan", "explore", "no-change"] : member.role === "scout" ? ["findings"] : member.role === "reviewer" ? ["review"] : member.role === "delivery" ? ["delivery", "delivery-repair"] : member.role === "implementer" ? ["result", "escalate"] : ["result"];
    if (!expected.includes(report.kind)) { this.block(stored, new TeamError(409, "wrong-agent-report", "An agent's report does not match its assigned role.")); return; }
    if (report.kind === "no-change") {
      if ((!run.goal && !run.handoff) || run.tasks.length) throw new TeamError(409, "invalid-no-change", "Only a goal coordinator can conclude that discovery found no justified change.");
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
        const next = this.newMember(run, "implementer", member.cwd, member.baseCommit, task.id, undefined, profile);
        next.prompt = teamPrompt(run, "implementer", task, `The previous implementer requested escalation: ${report.reason}. Its partial edits are present in this working copy and have passed the host's path-scope check. Inspect them before continuing.`, next.provider ?? run.provider, next.modelProfile);
        run.members.push(next); task.memberId = next.memberId; task.status = "running";
        run.status = "implementing";
        this.event(stored, `${task.title} escalated to ${profile.label}; the stopped member's partial work was preserved.`);
      }); return;
    }
    if (report.kind === "plan") {
      validateTeamPlan(report.tasks);
      this.taskProfiles(run, report.tasks);
      if (report.verification && !run.establishChecks && !run.verification) {
        if (run.verificationCorrections?.includes(run.revision)) {
          this.block(stored, new TeamError(409, "verification-not-authorized", "A plan cannot replace the project's configured checks."));
          return;
        }
        run.verificationCorrections = [...(run.verificationCorrections ?? []), run.revision];
        const message = "Plan rejected: this run uses the project's configured checks. Remove verification and submit a corrected plan. If the checks seem insufficient, explain that in the summary and assign tasks to run additional commands themselves and report results.";
        this.event(stored, "The project manager's plan included unauthorized verification; requesting a corrected plan.");
        this.save(stored);
        // Carry the owner's answers to this revision's planning questions into the corrected plan.
        const answers = run.decisions.filter(decision => decision.answer && decision.revision === run.revision && run.members.some(prior => prior.memberId === decision.memberId && prior.role === "project-manager"))
          .map(decision => `Earlier planning question: ${decision.question}\n${decision.answeredBy === "coordinator" ? "Mission coordinator" : "User"} answered: ${decision.answer}`);
        this.prepareMember(stored, "project-manager", undefined, [message, ...answers].join("\n\n"));
        return;
      }
      if (run.establishChecks && !run.verification && !report.verification)
        throw new TeamError(409, "verification-required", "The first plan must establish project verification commands before implementation.");
      if (run.verification && report.verification && digest(run.verification) !== digest(report.verification))
        throw new TeamError(409, "verification-changed", "The accepted verification commands cannot change during this run or its goal continuation.");
      if (run.goal && !report.brief) throw new TeamError(409, "goal-brief-required", "A goal plan must include an evidence-backed brief with acceptance criteria.");
      if (run.goal && report.tasks.some(task => task.paths.some(path => !teamPathAllowed(path, run.goal!.allowedPaths))))
        throw new TeamError(409, "goal-scope-violation", "The plan proposes paths outside the approved goal scope.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        const remaining = [...report.tasks];
        run.tasks = [];
        while (remaining.length) {
          const index = remaining.findIndex(task => task.dependsOn.every(id => run.tasks.some(done => done.id === id)));
          run.tasks.push({ ...remaining.splice(index, 1)[0], revision: member.revision, reviewRounds: 0, status: "pending" });
        }
        applyTeamBriefTitle(run, report.brief, member.revision);
        if (report.verification && !run.verification) {
          run.verification = structuredClone(report.verification);
          this.event(stored, "The coordinator established verification commands under the owner's project opt-in.");
        }
        run.status = "implementing";
        this.event(stored, `Project manager planned ${run.tasks.length} tasks.`);
      }); return;
    }
    if (report.kind === "delivery" || report.kind === "delivery-repair") {
      this.assertDelivery(stored);
      if (report.headCommit !== run.headCommit || member.baseCommit !== run.headCommit || stored.deliveryAttempt?.memberId !== member.memberId)
        throw new TeamError(409, "stale-delivery", "Delivery evidence must name the checked and independently reviewed commit for this attempt.");
      if (report.kind === "delivery") {
        let url: URL;
        try { url = new URL(report.pullRequestUrl); } catch { throw new TeamError(409, "delivery-target-mismatch", "The delivery report must name a valid pull request URL."); }
        const prefix = `/${run.delivery!.repository}/pull/`.toLowerCase();
        if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash || !url.pathname.toLowerCase().startsWith(prefix) || !/^[1-9][0-9]*$/.test(url.pathname.slice(prefix.length)))
          throw new TeamError(409, "delivery-target-mismatch", "The pull request must belong to the configured repository.");
      }
      this.operation(stored, "result", async signal => {
        await assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal);
        await assertMemberReadOnly(run.workspace, member.baseCommit, this.config.teams?.commandPrefix, signal);
        if (report.kind === "delivery") {
          await this.enqueue(() => {
            if (this.closed) return;
            run.deliveryReceipt = { revision: run.revision, headCommit: report.headCommit, pullRequestUrl: report.pullRequestUrl, mergeCommit: report.mergeCommit, summary: report.summary, reportedAt: timestamp() };
            this.save(stored);
          });
          await captureDeliveryBaseline(run.workspace, member.cwd, member.baseCommit, report.mergeCommit, this.config.teams?.commandPrefix, signal);
        }
      }, () => {
        stored.deliveryAttempt = undefined;
        if (report.kind === "delivery-repair") {
          this.repair(stored, `Delivery requires a scoped repair before checks and independent review run again. No merge was reported.\n${report.summary}`);
        } else {
          run.status = "merged"; run.reason = undefined;
          this.event(stored, "The delivery agent reported a merged pull request for the reviewed commit. This is agent-reported delivery evidence, not proof of product impact.");
        }
      }); return;
    }
    if (report.kind === "review") {
      if (member.baseCommit !== run.headCommit || stored.checkHead !== run.headCommit) { this.block(stored, new TeamError(409, "stale-review", "The reviewer did not review the currently verified integration commit.")); return; }
      if (run.brief?.uiChanges && report.verdict === "approved" && !report.uiEvidence)
        throw new TeamError(409, "ui-review-evidence-required", "Approval of UI changes requires the reviewer's evidence from inspecting the runnable interface.");
      this.operation(stored, "result", signal => assertMemberReadOnly(member.cwd, member.baseCommit, this.config.teams?.commandPrefix, signal), () => {
        run.review = { verdict: report.verdict, summary: report.summary, revision: run.revision, ...(report.uiEvidence ? { uiEvidence: report.uiEvidence } : {}) };
        if (report.verdict === "approved" && report.rubric?.length) {
          const reviewer = member.modelProfile ?? this.memberProfile(run, "reviewer");
          for (const entry of report.rubric) {
            const task = run.tasks.find(item => item.id === entry.taskId && item.status === "integrated");
            if (!task) continue;
            const implementer = run.members.find(candidate => candidate.memberId === task.memberId)?.modelProfile;
            if (reviewer && implementer && reviewer.model === implementer.model) {
              this.event(stored, `The rubric for task ${task.id} was dropped because reviewer and implementer use the same model.`);
              continue;
            }
            task.rubric = { version: 1, correctness: entry.correctness, cleanliness: entry.cleanliness, extensibility: entry.extensibility, docs: entry.docs, reviewerProfileId: reviewer?.id ?? "unknown" };
          }
        }
        if (report.verdict === "changes-requested") {
          for (const task of run.tasks) if (task.status === "integrated") task.reviewRounds = (task.reviewRounds ?? 0) + 1;
          this.repair(stored, report.summary);
        }
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
      // Diff stats are scorecard evidence only: a launcher that refuses the command must not block integration.
      const diff = commit ? await teamCommand({ command: "git", args: teamGitArgs(run.workspace, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--no-renames", "-z", member.baseCommit, commit, "--"]) }, run.workspace, signal, 30000, this.config.teams?.commandPrefix).catch(() => undefined) : undefined;
      return { commit, head, diff: diff?.exitCode === 0 ? diff.stdout : undefined };
    }, ({ commit, head, diff }) => {
      run.headCommit = head; stored.checkHead = undefined; run.review = undefined;
      if (task) { task.status = "integrated"; task.commit = commit; task.summary = report.summary; task.diffStat = diffStat(diff); }
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
  /** The checks the host runs after integration: established by the plan, or configured for the project. */
  private requiredChecks(run: TeamRun) {
    return run.establishChecks ? run.verification?.checks : run.handoff?.project.checks ?? this.config.projects.find(project => project.id === run.projectId)?.team?.checks;
  }
  private check(stored: Stored) {
    const run = stored.run, revision = run.revision, head = run.headCommit!;
    const required = this.requiredChecks(run);
    if (!required?.length) throw new TeamError(409, "verification-required", "Required verification commands have not been established; the team cannot be ready for review.");
    const setup = run.establishChecks ? run.verification?.setup : undefined;
    const commands = [...(setup ? [{ command: setup, phase: "setup" as const }] : []), ...required.map(command => ({ command }))];
    run.status = "verifying";
    this.operation(stored, "check", async signal => {
      const results: typeof run.checks = [];
      for (const entry of commands) {
        const check: TeamRun["checks"][number] = { ...entry, status: "running", startedAt: timestamp(), output: "", revision };
        await this.enqueue(() => { if (!this.closed) { run.checks.push(check); this.save(stored); } });
        const result = await teamCommand(entry.command, run.workspace, signal, (this.config.teams?.checkMinutes ?? 60) * 60000, this.config.teams?.commandPrefix);
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
      } else if (results.some(result => result.status === "interrupted")) {
        // A timeout is host evidence about the check, not the agents' work; it must not spend a correction round.
        this.block(stored, new TeamError(409, "check-timeout", checkTimeoutReason));
      } else this.repair(stored, `Configured verification failed:\n${JSON.stringify(results)}`);
    });
  }
}
