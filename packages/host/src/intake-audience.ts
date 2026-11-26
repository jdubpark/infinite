import { realpathSync } from "node:fs";
import type { CreateMission, Mission, MissionOrigin } from "./mission-types.js";
import type { ProjectGroup } from "./project-group-types.js";
import { normalizeRemote, readGit, type GitReader } from "./checkout-identity.js";
import { TeamError } from "./team-workspace.js";
import type { MissionService } from "./missions.js";
import type { Config } from "./types.js";

type GroupReader = { get(id: string): ProjectGroup };
type AudienceConfig = Pick<Config, "intake" | "projects">;
type AudienceDependencies = { config: AudienceConfig; groups: GroupReader; git?: GitReader; realpath?: (path: string) => string; sourceAppliedHead?: (projectId: string) => string | undefined };

const repositoryKey = (repository: string) => normalizeRemote(`https://github.com/${repository}.git`)?.key;

export function createIntakeAudienceGuard({ config, groups, git = readGit, realpath = realpathSync, sourceAppliedHead }: AudienceDependencies) {
  const scope = config.intake?.slack?.organizationScope;
  const configuredGroupId = config.intake?.mission.groupId;

  const workspacesAllowed = (): boolean => {
    if (!scope) return true;
    const pins = scope.workspaces;
    if (!pins?.length || !configuredGroupId) return false;
    let group: ProjectGroup;
    try { group = groups.get(configuredGroupId); } catch { return false; }
    if (group.id !== configuredGroupId || group.hidden || group.repos.length === 0) return false;

    const checkoutRows = group.repos.flatMap(repo => repo.checkouts.map(checkout => ({ repo, checkout })));
    if (checkoutRows.length === 0 || checkoutRows.length !== pins.length) return false;
    const pinsByProject = new Map(pins.map(pin => [pin.projectId, pin]));
    if (pinsByProject.size !== pins.length) return false;
    const seen = new Set<string>();

    for (const { repo, checkout } of checkoutRows) {
      if (seen.has(checkout.projectId)) return false;
      seen.add(checkout.projectId);
      const pin = pinsByProject.get(checkout.projectId);
      const project = config.projects.find(value => value.id === checkout.projectId);
      if (!pin || !project || pin.path !== project.path || checkout.path !== project.path) return false;
      try { if (realpath(project.path) !== project.path) return false; } catch { return false; }

      const configuredRepositories = [
        project.source?.mode === "github" ? project.source.repository : undefined,
        project.team?.delivery?.repository,
      ].filter((value): value is string => value !== undefined);
      const configuredKeys = configuredRepositories.map(repositoryKey);
      if (configuredKeys.some(key => !key) || new Set(configuredKeys.map(key => key!.toLowerCase())).size > 1) return false;

      const expectedKey = configuredKeys[0];
      if (expectedKey && pin.repository?.toLowerCase() !== configuredRepositories[0]!.toLowerCase()) return false;
      const top = git(project.path, ["rev-parse", "--show-toplevel"]);
      const head = git(project.path, ["rev-parse", "--verify", "HEAD"]);
      if (!top || !head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return false;
      try { if (realpath(top) !== project.path) return false; } catch { return false; }
      const remotes = git(project.path, ["remote", "-v"]);
      if (remotes === undefined) return false;
      const remoteUrls = remotes?.split("\n").map(line => line.trim().split(/\s+/)[1]).filter((value): value is string => Boolean(value)) ?? [];
      if (pin.repository === null) {
        if (expectedKey || remoteUrls.length || !pin.rootCommit) return false;
        const roots = git(project.path, ["rev-list", "--max-parents=0", "HEAD"]);
        const rootValues = roots?.split(/\s+/).map(value => value.trim()).filter(value => /^[0-9a-f]{40,64}$/i.test(value)) ?? [];
        if (rootValues.length !== 1) return false;
        const root = rootValues[0];
        if (!root || root.toLowerCase() !== pin.rootCommit.toLowerCase() || repo.key?.toLowerCase() !== `root:${root.toLowerCase()}`) return false;
      } else {
        const pinKey = repositoryKey(pin.repository);
        if (!pinKey || (expectedKey && pinKey !== expectedKey)) return false;
        if (remoteUrls.length) {
          if (remoteUrls.some(url => normalizeRemote(url)?.key.toLowerCase() !== pinKey.toLowerCase())) return false;
        } else {
          if (project.source?.mode !== "github" || !sourceAppliedHead) return false;
          let appliedHead: string | undefined;
          try { appliedHead = sourceAppliedHead(project.id); } catch { return false; }
          if (!appliedHead || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(appliedHead) || head.toLowerCase() !== appliedHead.toLowerCase()) return false;
        }
      }

      if (repo.key?.startsWith("remote:")) {
        if (!pin.repository || repo.key.toLowerCase() !== repositoryKey(pin.repository)?.toLowerCase()) return false;
      } else if (pin.repository !== null) return false;
    }
    if (seen.size !== pins.length) return false;

    const answerProjectId = config.intake?.mission.answerProjectId;
    if (answerProjectId && !pinsByProject.has(answerProjectId)) return false;
    return true;
  };

  return {
    workspacesAllowed,
    missionAllowed(request: CreateMission): boolean {
      if (!scope) return true;
      if (request.groupId !== configuredGroupId || !workspacesAllowed()) return false;
      const pins = new Set(scope.workspaces?.map(pin => pin.projectId) ?? []);
      return !request.checkouts?.some(projectId => !pins.has(projectId));
    },
  };
}

export function createIntakeMissionCreator({ config, missions, groups, audience, assertNoHandoff }: {
  config: Config; missions: MissionService; groups: GroupReader; audience: ReturnType<typeof createIntakeAudienceGuard>;
  assertNoHandoff: (projectId: string) => void;
}) {
  return async (body: CreateMission, origin?: MissionOrigin, authorize?: () => void): Promise<Mission> => {
    authorize?.();
    const recorded = missions.replayCreate(body);
    if (recorded) return recorded;
    const authorizeCreate = () => {
      authorize?.();
      if (origin?.kind === "intake" && config.intake?.slack?.organizationScope && !missions.replayCreate(body) && !audience.missionAllowed(body))
        throw new TeamError(403, "intake-audience-denied", "The intake mission is outside the configured Slack workspace audience.");
    };
    const group = groups.get(body.groupId);
    for (const repo of group.repos) for (const checkout of repo.checkouts) assertNoHandoff(checkout.projectId);
    return missions.create({ ...body, groupId: group.id }, body, origin, authorizeCreate);
  };
}
