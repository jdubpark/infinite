import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { CreateMission, Mission, MissionOrigin } from "./mission-types.js";
import type { ProjectGroup, ProjectGroupCheckout, ProjectGroupRepo } from "./project-group-types.js";
import type { IntakeRecord } from "./intake-types.js";
import { normalizeRemote, readGit, type GitReader, type WorkspaceRepositoryBinding } from "./checkout-identity.js";
import { TeamError } from "./team-workspace.js";
import type { SlackOrganizationScope } from "./intake-types.js";
import type { MissionService } from "./missions.js";
import type { Config } from "./types.js";

type GroupReader = { get(id: string): ProjectGroup };
type AudienceConfig = Pick<Config, "intake" | "projects">;
type AudienceDependencies = { config: AudienceConfig; groups: GroupReader; git?: GitReader; realpath?: (path: string) => string; sourceAppliedHead?: (projectId: string) => string | undefined };

const repositoryKey = (repository: string) => normalizeRemote(`https://github.com/${repository}.git`)?.key;

export function slackAudienceIdentity(config: Pick<Config, "intake">): string | undefined {
  const intake = config.intake, slack = intake?.slack, scope = slack?.organizationScope;
  if (!slack) return undefined;
  if (!scope?.workspaces?.length || !intake?.mission.groupId || !slack.teamId || !slack.ownerUserId) return undefined;
  const workspaces = scope.workspaces.map(pin => ({
    projectId: pin.projectId,
    path: pin.path,
    repository: pin.repository?.toLowerCase() ?? null,
    rootCommit: pin.rootCommit?.toLowerCase() ?? null,
  })).sort((a, b) => a.projectId.localeCompare(b.projectId));
  if (new Set(workspaces.map(pin => pin.projectId)).size !== workspaces.length
    || new Set(workspaces.map(pin => pin.path)).size !== workspaces.length) return undefined;
  const canonical = {
    teamId: slack.teamId,
    ownerUserId: slack.ownerUserId,
    groupId: intake.mission.groupId,
    workspaces,
    channelIds: scope.channelIds === undefined ? null : [...scope.channelIds].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function intakeRecordAudienceIdentityMatches(config: Pick<Config, "intake">, record: IntakeRecord): boolean {
  if (!config.intake?.slack) return record.slackAudienceId === undefined && record.thread === undefined && record.direct === undefined;
  if (record.external && !record.thread && !record.direct && record.slackAudienceId === undefined) return true;
  const identity = slackAudienceIdentity(config);
  return identity !== undefined && record.slackAudienceId === identity;
}

export function intakeRecordAudienceAllowed(config: Pick<Config, "intake">, record: IntakeRecord, mission?: Mission): boolean {
  if (!intakeRecordAudienceIdentityMatches(config, record)) return false;
  if (!config.intake?.slack || record.external && !record.thread && !record.direct && record.slackAudienceId === undefined) return true;
  const pins = new Set(config.intake.slack.organizationScope.workspaces.map(pin => pin.projectId));
  if (record.request && (record.request.groupId !== config.intake.mission.groupId
    || record.request.checkouts?.some(projectId => !pins.has(projectId)))) return false;
  if (record.missionId !== undefined) {
    if (!mission || mission.id !== record.missionId || mission.groupId !== config.intake.mission.groupId
      || mission.repoProjectIds.length === 0 || new Set(mission.repoProjectIds).size !== mission.repoProjectIds.length
      || mission.repoProjectIds.some(projectId => !pins.has(projectId))) return false;
    if (record.request && record.request.requestId !== mission.id) return false;
  }
  return true;
}

export function createIntakeAudienceGuard({ config, groups, git = readGit, realpath = realpathSync, sourceAppliedHead }: AudienceDependencies) {
  const slackConfigured = () => config.intake?.slack !== undefined;
  const organizationScope = () => config.intake?.slack?.organizationScope;
  const configuredGroupId = () => config.intake?.mission.groupId;

  const repositoryBinding = (repo: ProjectGroupRepo, checkout: ProjectGroupCheckout, pin: SlackOrganizationScope["workspaces"][number], project: Config["projects"][number], expectedCompanyId: string): WorkspaceRepositoryBinding | undefined => {
    if (pin.path !== project.path || checkout.path !== project.path) return undefined;
    try { if (realpath(project.path) !== project.path) return undefined; } catch { return undefined; }

    const configuredRepositories = [
      project.source?.mode === "github" ? project.source.repository : undefined,
      project.team?.delivery?.repository,
    ].filter((value): value is string => value !== undefined);
    const configuredKeys = configuredRepositories.map(repositoryKey);
    if (configuredKeys.some(key => !key) || new Set(configuredKeys.map(key => key!.toLowerCase())).size > 1) return undefined;

    const expectedKey = configuredKeys[0];
    if (expectedKey && pin.repository?.toLowerCase() !== configuredRepositories[0]!.toLowerCase()) return undefined;
    const top = git(project.path, ["rev-parse", "--show-toplevel"]);
    const head = git(project.path, ["rev-parse", "--verify", "HEAD"]);
    if (!top || !head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return undefined;
    try { if (realpath(top) !== project.path) return undefined; } catch { return undefined; }
    const remotes = git(project.path, ["remote", "-v"]);
    if (remotes === undefined) return undefined;
    const remoteUrls = remotes.split("\n").map(line => line.trim().split(/\s+/)[1]).filter((value): value is string => Boolean(value));
    if (pin.repository === null) {
      if (expectedKey || remoteUrls.length || !pin.rootCommit) return undefined;
      const roots = git(project.path, ["rev-list", "--max-parents=0", "HEAD"]);
      const rootValues = roots?.split(/\s+/).map(value => value.trim()).filter(value => /^[0-9a-f]{40,64}$/i.test(value)) ?? [];
      if (rootValues.length !== 1) return undefined;
      const root = rootValues[0];
      if (!root || root.toLowerCase() !== pin.rootCommit.toLowerCase() || repo.key?.toLowerCase() !== `root:${root.toLowerCase()}`) return undefined;
    } else {
      const pinKey = repositoryKey(pin.repository);
      if (!pinKey || (expectedKey && pinKey !== expectedKey)) return undefined;
      if (remoteUrls.length) {
        if (remoteUrls.some(url => normalizeRemote(url)?.key.toLowerCase() !== pinKey.toLowerCase())) return undefined;
      } else {
        if (project.source?.mode !== "github" || !sourceAppliedHead) return undefined;
        let appliedHead: string | undefined;
        try { appliedHead = sourceAppliedHead(project.id); } catch { return undefined; }
        if (!appliedHead || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(appliedHead) || head.toLowerCase() !== appliedHead.toLowerCase()) return undefined;
      }
    }

    if (repo.key?.startsWith("remote:")) {
      if (!pin.repository || repo.key.toLowerCase() !== repositoryKey(pin.repository)?.toLowerCase()) return undefined;
    } else if (pin.repository !== null) return undefined;
    if (!repo.key) return undefined;
    return { companyId: expectedCompanyId, repositoryId: repo.key.toLowerCase() };
  };

  const verifyWorkspaces = (): { bindings: Map<string, WorkspaceRepositoryBinding>; allowed: boolean } => {
    const bindings = new Map<string, WorkspaceRepositoryBinding>();
    const slack = config.intake?.slack;
    if (!slack) return { bindings, allowed: true };
    const scope = organizationScope();
    if (!scope) return { bindings, allowed: false };
    const pins = scope.workspaces;
    const groupId = configuredGroupId();
    if (!pins?.length || !groupId) return { bindings, allowed: false };
    let group: ProjectGroup;
    try { group = groups.get(groupId); } catch { return { bindings, allowed: false }; }
    if (group.id !== groupId || group.hidden || group.repos.length === 0) return { bindings, allowed: false };

    const checkoutRows = group.repos.flatMap(repo => repo.checkouts.map(checkout => ({ repo, checkout })));
    let allowed = checkoutRows.length > 0 && checkoutRows.length === pins.length;
    const pinsByProject = new Map(pins.map(pin => [pin.projectId, pin]));
    if (pinsByProject.size !== pins.length || new Set(pins.map(pin => pin.path)).size !== pins.length)
      return { bindings, allowed: false };
    const seen = new Set<string>();
    const companyId = createHash("sha256").update(JSON.stringify({ teamId: slack.teamId, groupId })).digest("hex");

    for (const { repo, checkout } of checkoutRows) {
      if (seen.has(checkout.projectId)) { allowed = false; bindings.delete(checkout.projectId); continue; }
      seen.add(checkout.projectId);
      const pin = pinsByProject.get(checkout.projectId);
      const project = config.projects.find(value => value.id === checkout.projectId);
      if (!pin || !project) { allowed = false; continue; }
      const binding = repositoryBinding(repo, checkout, pin, project, companyId);
      if (!binding) { allowed = false; continue; }
      bindings.set(project.id, binding);
    }
    if (seen.size !== pins.length || bindings.size !== pins.length) allowed = false;

    const answerProjectId = config.intake?.mission.answerProjectId;
    if (answerProjectId && !pinsByProject.has(answerProjectId)) allowed = false;
    return { bindings, allowed };
  };
  const workspaceBindings = (): Map<string, WorkspaceRepositoryBinding> => verifyWorkspaces().bindings;
  const workspacesAllowed = (): boolean => !slackConfigured() || verifyWorkspaces().allowed;

  const recordAllowedWith = (record: IntakeRecord, mission: Mission | undefined, allowed: () => boolean): boolean => {
    if (!intakeRecordAudienceIdentityMatches(config, record)) return false;
    if (!config.intake?.slack || record.external && !record.thread && !record.direct && record.slackAudienceId === undefined) return true;
    return allowed() && intakeRecordAudienceAllowed(config, record, mission);
  };

  return {
    workspaceBindings,
    workspacesAllowed,
    missionAllowed(request: CreateMission): boolean {
      if (!slackConfigured()) return true;
      const scope = organizationScope();
      if (!scope) return false;
      if (request.groupId !== configuredGroupId() || !workspacesAllowed()) return false;
      const pins = new Set(scope.workspaces?.map(pin => pin.projectId) ?? []);
      return !request.checkouts?.some(projectId => !pins.has(projectId));
    },
    recordAllowed(record: IntakeRecord, mission?: Mission): boolean {
      return recordAllowedWith(record, mission, workspacesAllowed);
    },
    snapshotRecordAllowed(): (record: IntakeRecord, mission?: Mission) => boolean {
      let checked = false, snapshot = false;
      const allowed = () => {
        if (!checked) { snapshot = workspacesAllowed(); checked = true; }
        return snapshot;
      };
      return (record, mission) => recordAllowedWith(record, mission, allowed);
    },
  };
}

export function createIntakeMissionCreator({ config, missions, groups, audience, assertNoHandoff }: {
  config: Config; missions: MissionService; groups: GroupReader; audience: ReturnType<typeof createIntakeAudienceGuard>;
  assertNoHandoff: (projectId: string) => void;
}) {
  return async (body: CreateMission, origin?: MissionOrigin, authorize?: () => void): Promise<Mission> => {
    const authorizeRequest = () => {
      authorize?.();
      if (origin?.kind === "intake" && origin.source === undefined && config.intake?.slack && !audience.missionAllowed(body))
        throw new TeamError(403, "intake-audience-denied", "The intake mission is outside the configured Slack workspace audience.");
    };
    authorizeRequest();
    const recorded = missions.replayCreate(body);
    if (recorded) return recorded;
    const group = groups.get(body.groupId);
    for (const repo of group.repos) for (const checkout of repo.checkouts) assertNoHandoff(checkout.projectId);
    return missions.create({ ...body, groupId: group.id }, body, origin, authorizeRequest);
  };
}
