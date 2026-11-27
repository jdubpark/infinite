import type { ConnectorSource } from "./mcp-types.js";
import { withoutMainCheck, type HandoffPolicy, type TeamHandoffContext } from "./handoff-types.js";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { autonomyOf, type AutonomyMode } from "./autonomy.js";
import { createTeamSchema, currentPermissions, DEFAULT_STORAGE_FLOOR, lineupProfiles, teamGoalContextSchema, teamLineupSchema, type CreateTeam, type TeamGoalContext, type TeamLineup, type TeamRun, type TeamView } from "./team-types.js";
import { teamModelLaunch } from "./launch.js";
import type { KeyedQueue, PendingCreates } from "./keyed-queue.js";
import type { RoutingRecorder } from "./routing-recorder.js";
import type { Readings } from "./readings.js";
import { TeamError, assertMemberReadOnly, ensureDefaultTeamRoot, ensureHostDirectory, prepareTeamWorkspace, prepareTeamWorkspaceFromMirror, teamCommand, teamGitArgs, teamOperationCommand, teamWorkspacePath, type CommandResult } from "./team-workspace.js";
import { assertTeamworkPath } from "./repo-enrollment.js";
import { storageShortfall, volumeUsage, type VolumeUsage } from "./storage.js";
import { digest, timestamp, type TeamKernel } from "./team-kernel.js";
import { isBenignFenceError, isBenignSourceRefreshError, type TeamDiagnostics } from "./team-diagnostics.js";
import { registerPin } from "./team-register.js";
import { autonomyStartEvent, intentCheckPin, startMode, verdictPin } from "./evaluator-profiles.js";
import { deliveryReviewLineageAtBase, inheritDeliveryReviewLineage } from "./delivery-review.js";
import type { MissionReservationLookup, StartInProject, Stored, TeamServiceOptions } from "./teams.js";

export type CreatorHost = Pick<TeamKernel, "records" | "config" | "closed" | "save" | "event" | "record" | "enqueue" | "operation" | "assertRunPath" | "assertBudget"> & {
  readonly options: TeamServiceOptions | undefined;
  readonly diag: Pick<TeamDiagnostics, "warnUnexpected">;
  readonly router: Pick<RoutingRecorder, "pin"> | undefined;
  readonly titler: Pick<Readings, "requestTitle"> | undefined;
  readonly missionReservations: MissionReservationLookup | undefined;
  readonly startInProject: StartInProject;
  readonly queues: KeyedQueue;
  readonly pendingCreates: PendingCreates;
  readonly retiredRunIds: ReadonlySet<string>;
  readonly removingRuns: ReadonlySet<string>;
  activeForProject(projectId: string): boolean;
  ensureMissionCapacityCeiling(id: string, missionId: string, ceiling: number): number | undefined;
  view(stored: Stored): TeamView;
  emit(stored: Stored, kind: string, keyParts: readonly (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void;
  noteLeftover(stored: Stored, result: CommandResult): Promise<void>;
};

export class TeamCreator {
  constructor(private readonly host: CreatorHost) {}
  create(request: CreateTeam): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    return this.createRun(parsed);
  }
  createForGoal(request: CreateTeam, goal: TeamGoalContext, lineup: TeamLineup, linearTracking = false, autonomy: AutonomyMode = "supervised"): Promise<TeamView> {
    return this.createRun(createTeamSchema.parse(request), { goal: teamGoalContextSchema.parse(goal), lineup: teamLineupSchema.parse(lineup), autonomy }, linearTracking);
  }
  createForMission(request: CreateTeam, missionId: string, lineup: TeamLineup, options: { baseRunId?: string; parallelismCeiling?: number; linearTracking?: boolean; requestSource?: ConnectorSource } = {}): Promise<TeamView> {
    const parsed = createTeamSchema.parse(request);
    const project = this.host.config.projects.find(item => item.id === parsed.projectId);
    return this.createRun(parsed, { missionId, ...(options.requestSource ? { requestSource: structuredClone(options.requestSource) } : {}), ...(options.baseRunId ? { baseRunId: options.baseRunId } : {}), parallelismCeiling: options.parallelismCeiling ?? 4, lineup: teamLineupSchema.parse(lineup) }, options.linearTracking ?? Boolean(project?.linear));
  }
  assertHandoffPolicy(policy: HandoffPolicy) {
    const project = this.host.config.projects.find(item => item.id === policy.projectId);
    if (!project || JSON.stringify(withoutMainCheck(project.team)) !== JSON.stringify(withoutMainCheck(policy.project)) || JSON.stringify(project.linear) !== JSON.stringify(policy.linear) || realpathSync(project.path) !== policy.path || this.host.config.teams?.workspaceDir !== policy.workspaceDir || JSON.stringify(this.host.config.teams?.commandPrefix) !== JSON.stringify(policy.commandPrefix))
      throw new TeamError(409, "handoff-policy-changed", "Project authority changed after the source session started; inspect the checkpoint before creating a new team.");
    for (const selection of lineupProfiles(policy.lineup)) {
      const profile = this.host.config.agents[selection.provider];
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
  createRun(parsed: CreateTeam, internal?: { goal?: TeamGoalContext; missionId?: string; requestSource?: ConnectorSource; parallelismCeiling?: number; baseRunId?: string; handoff?: TeamHandoffContext; handoffPolicy?: HandoffPolicy; lineup: TeamLineup; autonomy?: AutonomyMode }, linearTracking = false): Promise<TeamView> {
    return this.host.pendingCreates.track(parsed.requestId, [parsed.projectId], this.host.enqueue(parsed.requestId, () => {
      const { useConfiguredLineup, ...singleProviderRequest } = parsed;
      const { parallelismCeiling: _ceiling, autonomy: _autonomy, ...creationContext } = internal ?? {};
      const prior = this.host.records.get(parsed.requestId), fingerprint = digest(internal ? { request: parsed, ...creationContext } : useConfiguredLineup ? parsed : singleProviderRequest);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TeamError(409, "request-conflict", "This request ID belongs to a different team request.");
        if (internal?.missionId) this.host.ensureMissionCapacityCeiling(parsed.requestId, internal.missionId, internal.parallelismCeiling ?? 4);
        return this.host.view(prior);
      }
      return this.host.queues.enqueue(`project:${parsed.projectId}`, async () => {
        if (this.host.retiredRunIds.has(parsed.requestId))
          throw new TeamError(409, "team-deleted", "This request's run was deleted under the retention policy. Start a new run with a new request id.");
        const project = this.host.config.projects.find(item => item.id === parsed.projectId);
        if (!project) throw new TeamError(404, "unknown-project", "The selected project is not configured.");
        const reservedBy = this.host.missionReservations?.(parsed.projectId, internal?.missionId);
        if (reservedBy) throw new TeamError(409, "mission-repository-reserved", `Mission ${reservedBy} holds repository ${parsed.projectId} for an active subteam or pending launch.`);
        if (internal?.missionId && this.host.activeForProject(parsed.projectId))
          throw new TeamError(409, "project-team-active", `An active team run already holds repository ${parsed.projectId}; this mission subtask cannot start until it finishes or is cancelled.`);
        if (!this.host.config.teams || !project.team || (!project.team.checks.length && !project.team.establishChecks)) throw new TeamError(409, "teams-not-configured", "Configure a team workspace directory and required checks, or authorize the team to establish checks, before starting a team.");
        const goal = internal ? structuredClone(internal.goal) : undefined;
        const lineup = internal ? structuredClone(internal.lineup) : useConfiguredLineup ? structuredClone(this.host.config.teams.lineup) : undefined;
        if (useConfiguredLineup && !lineup) throw new TeamError(409, "team-lineup-not-configured", "The requested team lineup is not configured on this host.");
        if (lineup && parsed.provider !== lineup.coordinator.provider)
          throw new TeamError(409, "team-provider-mismatch", "The selected provider must match the configured coordinator provider.");
        const profiles = lineup ? lineupProfiles(lineup) : [];
        const providers = new Set(lineup ? profiles.map(profile => profile.provider) : [parsed.provider]);
        for (const provider of providers) {
          const profile = this.host.config.agents[provider];
          if (!profile || (provider === "demo" && !this.host.config.enableDemo)) throw new TeamError(409, "provider-not-configured", "Every selected team provider must be configured and available on this host.");
          if (/(^|\/)sudo$/.test(profile.command) && !this.host.config.teams.commandPrefix)
            throw new TeamError(409, "team-execution-identity-required", "Configure a team command prefix using the provider's execution identity before starting this team.");
        }
        for (const selection of profiles) {
          try { teamModelLaunch(this.host.config.agents[selection.provider]!, selection); }
          catch { throw new TeamError(409, "team-model-profile-conflict", "Move model, effort, and fallback-model arguments from provider profiles into the team lineup before starting this team."); }
        }
        if (project.team.permissions && (!lineup || !lineup.permissionReviewer && (lineup.coordinator.tier !== "strong" ||
            lineup.coordinator.limitFallback !== undefined && lineupProfiles(lineup).find(profile => profile.id === lineup.coordinator.limitFallback)?.tier !== "strong")))
          throw new TeamError(409, "permission-lineup-required", "Delegated permissions require a strong coordinator fallback unless a permission reviewer profile is configured.");
        const parentId = goal?.parentRunId ?? internal?.baseRunId;
        const parent = parentId ? this.host.record(parentId).run : undefined;
        if (parent?.workspaceRemovedAt || parent && this.host.removingRuns.has(parent.id))
          throw new TeamError(409, "team-workspace-removed", "This run's workspaces are being removed under the retention policy; start a new run.");
        if (parent && (goal
          ? parent.goal?.id !== goal.id || parent.projectId !== parsed.projectId || !["ready-for-review", "merged"].includes(parent.status) || !parent.headCommit
          : parent.projectId !== parsed.projectId || parent.missionId !== internal?.missionId || !["ready-for-review", "merged", "no-change"].includes(parent.status) || !parent.headCommit))
          throw new TeamError(409, goal ? "invalid-goal-parent" : "invalid-mission-base", goal ? "Continue only from a ready, recorded run of this goal and project." : "Continue only from a completed subtask in this mission and project with a recorded workspace head.");
        if (parent) this.host.assertRunPath(this.host.record(parent.id), parent.workspace);
        const source = { path: parent?.workspace ?? project.path, ...(parent ? { head: parent.headCommit!, ...(parent.status === "merged" ? { startCommit: parent.deliveryReceipt!.mergeCommit } : {}) } : internal?.handoff ? { head: internal.handoff.checkpointHead } : {}) };
        const githubProject = project.source?.mode === "github" || this.host.options?.source?.isGithub(project.id) === true;
        const parentRevision = parent?.revision;
        const at = timestamp();
        const slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "team";
        const suffix = parsed.requestId.slice(0, 8);
        const directoryName = `${project.teamworkDir ? "" : `${project.id}-`}${at.slice(0, 10)}-${slug}-${suffix}`;
        const branch = `infinite/team-${slug}-${suffix}`;
        const root = project.teamworkDir ?? this.host.config.teams.workspaceDir;
        let samplePath = resolve(root);
        while (!existsSync(samplePath)) {
          const ancestor = dirname(samplePath);
          if (ancestor === samplePath) throw new TeamError(507, "host-storage-unavailable", "The host could not measure free space for the team workspace volume.");
          samplePath = ancestor;
        }
        let usage: VolumeUsage;
        try { usage = await (this.host.options?.volumeUsage ?? volumeUsage)(samplePath); }
        catch { throw new TeamError(507, "host-storage-unavailable", "The host could not measure free space for the team workspace volume."); }
        if (parent && (parent.workspaceRemovedAt || this.host.removingRuns.has(parent.id)))
          throw new TeamError(409, "team-workspace-removed", "This run's workspaces are being removed under the retention policy; start a new run.");
        const reason = storageShortfall(usage, this.host.config.teams.storageFloor ?? DEFAULT_STORAGE_FLOOR);
        if (reason) throw new TeamError(507, "host-storage-low", reason);
        const fallbackTitle = parsed.objective.trim().split("\n")[0]!.slice(0, 100).trim();
        const titleSource = !internal?.goal && !internal?.handoff && !internal?.missionId && parsed.title === fallbackTitle ? "request" as const : undefined;
        const ceiling = internal?.parallelismCeiling ?? (internal?.handoff ? 2 : 4);
        if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 4 || internal?.handoff && ceiling > 2)
          throw new TeamError(409, "team-parallelism-limit", "The assigned worker capacity ceiling must be between one and the host limit.");
        const initialParallelism = internal?.missionId ? parsed.parallelism : ceiling;
        if (initialParallelism > ceiling)
          throw new TeamError(409, "team-parallelism-limit", "The initial worker limit exceeds this run's capacity ceiling.");
        const run: TeamRun = { linearTracking: internal ? linearTracking : Boolean(project.linear), id: parsed.requestId, projectId: parsed.projectId, provider: parsed.provider, ...(lineup ? { lineup } : {}), ...(project.team.permissions ? { permissions: currentPermissions(structuredClone(project.team.permissions)), permissionDecisions: [] } : {}), ...(goal ? { goal } : {}), ...(internal?.missionId ? { missionId: internal.missionId } : {}), ...(internal?.requestSource ? { requestSource: internal.requestSource } : {}), ...(internal?.handoff ? { handoff: structuredClone(internal.handoff) } : {}), ...(titleSource ? { titleSource } : {}), title: parsed.title, objective: parsed.objective, parallelismCeiling: ceiling, parallelism: initialParallelism, revision: 1, status: "planning", createdAt: at, updatedAt: at, lastActivityAt: at, workspace: teamWorkspacePath(root, directoryName), branch, baseCommit: "", tasks: [], members: [], decisions: [], checks: [], steering: [], events: [], round: 0 };
        const start = startMode(project, lineup); run.autonomy = goal ? autonomyOf(internal) : start.mode;
        const routing = this.host.router?.pin(project.team.routing, run.autonomy, lineup, run.projectId);
        if (routing) run.routing = routing;
        run.intentCheck = intentCheckPin({ autonomy: run.autonomy, setting: project.team.objective?.intentCheck, mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) });
        if (this.host.config.teams?.blackboard?.tools === true && this.host.options?.entries?.available()) run.blackboard = { tools: true };
        if (registerPin({ setting: project.team.objective?.register, mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) })) run.register = "on";
        if (verdictPin({ evaluator: project.team.objective?.evaluator, register: project.team.objective?.register, mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) })) run.verdicts = "on";
        if (project.team.delivery) {
          if (!lineup || lineup.coordinator.tier !== "strong" || lineup.reviewer.tier !== "strong")
            throw new TeamError(409, "delivery-lineup-required", "Automatic delivery requires a configured strong coordinator and independent strong reviewer.");
          run.delivery = structuredClone(project.team.delivery);
        }
        if (parent?.establishChecks || project.team.establishChecks) {
          run.establishChecks = true;
          if (parent?.verification) run.verification = structuredClone(parent.verification);
        }
        this.host.assertBudget(run);
        const anchor = project.teamworkDir ? realpathSync(this.host.config.sync?.homeDir ?? homedir()) : undefined;
        if (anchor) {
          assertTeamworkPath(this.host.config, root);
          ensureHostDirectory(anchor, root, 0o750);
        } else ensureDefaultTeamRoot(root, true);
        const stored: Stored = { run, fingerprint, receipts: {}, prepared: false, root, retention: { status: run.status, statusAt: at, integratedAt: {}, removalErrors: {} }, ...(anchor ? { anchor } : {}), source, ...(internal?.handoffPolicy ? { handoffPolicy: structuredClone(internal.handoffPolicy) } : {}) };
        this.host.records.set(run.id, stored); this.host.event(stored, "Team created; preparing an isolated copy of the configured project.");
        if (!goal && start.reason) this.host.event(stored, autonomyStartEvent("run", start.reason));
        this.host.emit(stored, "run.created", [], { revision: 1 }, { projectId: run.projectId, purpose: "work", goalId: goal?.id, goalCycle: goal?.cycle,
          missionId: internal?.missionId, handoff: Boolean(internal?.handoff), parentRunId: internal?.baseRunId, lineup: Boolean(lineup), deliveryMode: run.delivery?.mode });
        this.host.save(stored);
        if (run.titleSource === "request" && this.host.titler) void this.nameRequest(run.id, parsed.objective).catch(error => console.warn("Best-effort team naming failed.", error));
        this.host.operation(stored, "prepare", async signal => {
          const assertParent = () => {
            if (parent && (parent.workspaceRemovedAt || !["ready-for-review", "merged", "no-change"].includes(parent.status) || parent.revision !== parentRevision || parent.headCommit !== source.head))
              throw new TeamError(409, "parent-workspace-changed", "The predecessor run changed while its continuation was being prepared.");
          };
          assertParent();
          if (project.teamworkDir) assertTeamworkPath(this.host.config, root);
          this.host.assertRunPath(stored, teamWorkspacePath(root, directoryName), true);
          let workspaceSource = source;
          let fromMirror = false;
          if (githubProject && !parent && !internal?.handoff) {
            const projectSource = this.host.options?.source;
            if (!projectSource) throw new TeamError(409, "source-unavailable", "The host has no copy of this repository from GitHub yet; check the project's source status.");
            const status = await projectSource.refresh(project.id);
            if (!status.mirrorHead) throw new TeamError(409, "source-unavailable", "The host has no copy of this repository from GitHub yet; check the project's source status.");
            workspaceSource = { path: projectSource.mirrorPath(project.id), head: status.mirrorHead };
            fromMirror = true;
            if (status.pending?.reason === "fetch-failed") {
              const pendingCategory = status.pending.category;
              const category = pendingCategory === "auth" || pendingCategory === "network" || pendingCategory === "not-found" || pendingCategory === "other" ? pendingCategory : "other";
              run.baseStale = { ...(status.fetchedAt ? { fetchedAt: status.fetchedAt } : {}), reason: "fetch-failed", category };
              this.host.event(stored, "GitHub could not be reached; the run starts from the last fetched base.");
            }
          } else if (githubProject && parent && this.host.options?.source) {
            try { await this.host.options.source.refresh(project.id, { maxAgeMs: 60_000 }); }
            catch (error) { if (!isBenignSourceRefreshError(error, signal.aborted)) this.host.diag.warnUnexpected("source-refresh", error); }
            try {
              const mirrorHead = this.host.options.source.status(project.id).mirrorHead;
              if (mirrorHead && mirrorHead !== parent.headCommit) {
                const fetched = await teamCommand({ command: "git", args: teamGitArgs(source.path, ["fetch", "--no-tags", "--", this.host.options.source.mirrorPath(project.id), mirrorHead]) }, source.path, signal, 30000, this.host.config.teams?.commandPrefix);
                if (fetched.exitCode === 0 && !fetched.interrupted && !fetched.truncated) {
                  const ancestry = await teamCommand({ command: "git", args: teamGitArgs(source.path, ["merge-base", "--is-ancestor", parent.headCommit!, mirrorHead]) }, source.path, signal, 30000, this.host.config.teams?.commandPrefix);
                  if (ancestry.exitCode === 0 && !ancestry.interrupted && !ancestry.truncated) run.baseBehind = { mirrorHead };
                }
              }
            } catch (error) { if (!isBenignSourceRefreshError(error, signal.aborted) && (error as NodeJS.ErrnoException)?.code !== "ENOENT") this.host.diag.warnUnexpected("source-ancestry", error); }
          }
          const prepareWorkspace = async () => {
            assertParent();
            if (project.teamworkDir) assertTeamworkPath(this.host.config, root);
            this.host.assertRunPath(stored, teamWorkspacePath(root, directoryName), true);
            const workspace = fromMirror
              ? await prepareTeamWorkspaceFromMirror(workspaceSource.path, workspaceSource.head!, root, directoryName, branch, this.host.config.teams?.commandPrefix, signal, anchor)
              : await prepareTeamWorkspace(workspaceSource.path, root, directoryName, branch, this.host.config.teams?.commandPrefix, signal, workspaceSource.head, anchor, workspaceSource.startCommit);
            assertParent();
            if (project.team?.setup) {
              const setup = await teamOperationCommand(project.team.setup, workspace.workspace, signal, 600000, this.host.config.teams?.commandPrefix);
              await this.host.noteLeftover(stored, setup);
              if (setup.exitCode !== 0 || setup.interrupted) throw new TeamError(409, "team-setup-failed", "The configured setup command failed. Inspect the isolated workspace before restarting.");
              await assertMemberReadOnly(workspace.workspace, workspace.baseCommit, this.host.config.teams?.commandPrefix, signal, "setup");
            }
            assertParent();
            if (workspaceSource.head && !fromMirror) await assertMemberReadOnly(workspaceSource.path, workspaceSource.head, this.host.config.teams?.commandPrefix, signal, "integration");
            return workspace;
          };
          return this.host.startInProject(run.projectId, prepareWorkspace);
        }, workspace => {
          Object.assign(run, workspace); run.headCommit = workspace.baseCommit; stored.prepared = true;
          stored.deliveryReviewLineage = internal?.handoff || (parent && parent.status !== "merged")
            ? inheritDeliveryReviewLineage(parent && this.host.record(parent.id).deliveryReviewLineage, workspace.baseCommit)
            : deliveryReviewLineageAtBase(workspace.baseCommit);
          this.host.emit(stored, "run.prepared", [], {}, { baseCommit: run.baseCommit }); this.host.event(stored, "Isolated project ready. Starting the project manager.");
        });
        return this.host.view(stored);
      });
    }));
  }
  async nameRequest(id: string, objective: string) {
    try {
      const title = (await this.host.titler!.requestTitle(objective))?.text;
      if (!title) return;
      await this.host.enqueue(id, () => {
        const stored = this.host.records.get(id), run = stored?.run;
        if (this.host.closed || !stored || !run || run.titleSource !== "request" || !["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering", "needs-input", "paused"].includes(run.status)) return;
        run.title = title;
        run.titleSource = "model";
        this.host.save(stored);
      });
    } catch (error) { if (!isBenignFenceError(error, this.host.closed)) this.host.diag.warnUnexpected("name-request", error); }
  }
}
