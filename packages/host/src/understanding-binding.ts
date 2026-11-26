import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { UnderstandingArtifact, UnderstandingPinnedSource } from "@infinite/remote";
import { expectedIdentity, readGit, readGitResult, type GitResultReader } from "./checkout-identity.js";
import { isMissingSessionError } from "./mission-coordinator.js";
import type { Mission } from "./mission-types.js";
import type { ProjectGroup, ProjectGroupRepo } from "./project-group-types.js";
import type { Project, Session } from "./types.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const projectIdSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
export const commitHeadSchema = z.string().regex(/^[a-f0-9]{40,64}$/).nullable();
export const pinnedSourceSchema = z.object({
  head: commitHeadSchema,
  repoIdentity: z.string().min(1).max(128),
}).strict();
export const pinnedSourcesSchema = z.record(projectIdSchema, pinnedSourceSchema)
  .refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 64);

export const pinnedRepositoryBindingSchema = z.object({
  enrolledPath: z.string().min(1).max(4096),
  projectDevice: z.string().max(80),
  projectInode: z.string().max(80),
  repoIdentity: z.string().min(1).max(128),
  head: commitHeadSchema,
}).strict();
export const pinnedRepositoriesSchema = z.record(projectIdSchema, pinnedRepositoryBindingSchema)
  .refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 64);

export const bindingSchema = z.object({
  projectId: projectIdSchema,
  sourceKind: z.enum(["project", "team"]),
  enrolledPath: z.string().min(1).max(4096),
  root: z.string().min(1).max(4096),
  sourceCwd: z.string().min(1).max(4096),
  projectDevice: z.string().max(80),
  projectInode: z.string().max(80),
  rootDevice: z.string().max(80),
  rootInode: z.string().max(80),
  repoIdentity: z.string().max(128),
  sourceCwdDevice: z.string().max(80),
  sourceCwdInode: z.string().max(80),
  runId: z.string().uuid().optional(),
  memberId: z.string().uuid().optional(),
  missionRole: z.literal("mission-coordinator").optional(),
  pinnedRepositories: pinnedRepositoriesSchema.optional(),
}).strict();

export type PinnedRepositoryBinding = z.infer<typeof pinnedRepositoryBindingSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type ProjectBinding = { enrolledPath: string; projectDevice: string; projectInode: string; repoIdentity: string };

export function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

export function readGitHead(cwd: string, git: GitResultReader = readGitResult): string | null | undefined {
  let canonicalCwd: string;
  try { canonicalCwd = realpathSync(cwd); } catch { return undefined; }
  const toplevel = git(canonicalCwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok || !toplevel.stdout) return undefined;
  try { if (realpathSync(toplevel.stdout) !== canonicalCwd) return undefined; } catch { return undefined; }
  const head = git(canonicalCwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.ok) return /^[a-f0-9]{40,64}$/i.test(head.stdout) ? head.stdout.toLowerCase() : undefined;
  if (head.status !== 1 || head.stderr !== "" || head.errorCode !== undefined || head.signal !== undefined) return undefined;
  const symbolic = git(canonicalCwd, ["symbolic-ref", "--quiet", "HEAD"]);
  if (!symbolic.ok || !symbolic.stdout.startsWith("refs/heads/")) return undefined;
  const refCheck = git(canonicalCwd, ["show-ref", "--verify", "--quiet", symbolic.stdout]);
  if (refCheck.ok) return undefined;
  if (refCheck.status !== 1 || refCheck.stderr !== "" || refCheck.errorCode !== undefined || refCheck.signal !== undefined) return undefined;
  const refPathResult = git(canonicalCwd, ["rev-parse", "--git-path", symbolic.stdout]);
  if (!refPathResult.ok || !refPathResult.stdout) return undefined;
  const refPath = isAbsolute(refPathResult.stdout) ? refPathResult.stdout : resolve(canonicalCwd, refPathResult.stdout);
  try {
    lstatSync(refPath);
    return undefined;
  } catch (error) {
    return isMissingSessionError(error) ? null : undefined;
  }
}

export function captureProjectBinding(project: Project, expectedKey: string | undefined): ProjectBinding | undefined {
  try {
    const enrolledPath = realpathSync(project.path), info = statSync(enrolledPath);
    const identity = expectedIdentity({ ...project, path: enrolledPath }, readGit);
    if (!identity || (expectedKey && identity.key !== expectedKey)) return undefined;
    return { enrolledPath, projectDevice: String(info.dev), projectInode: String(info.ino), repoIdentity: digest(identity.key) };
  } catch { return undefined; }
}

export function captureMissionPinnedRepositories(
  repoProjectIds: readonly string[],
  projects: readonly Project[],
  group: ProjectGroup,
  recordedPaths?: Record<string, string>,
): Record<string, PinnedRepositoryBinding> {
  const ids = [...new Set(repoProjectIds)].sort((a, b) => a.localeCompare(b));
  if (!ids.length || ids.length > 64 || ids.some(id => !projectIdSchema.safeParse(id).success)) {
    throw new Error("mission-brief-source-unavailable");
  }
  if (recordedPaths !== undefined) {
    const recordedIds = Object.keys(recordedPaths).sort((a, b) => a.localeCompare(b));
    if (!sameSortedIds(recordedIds, ids)) throw new Error("mission-brief-source-unavailable");
  }
  const projectById = new Map(projects.map(project => [project.id, project] as const));
  const groupRepoByCheckout = new Map<string, ProjectGroupRepo>();
  for (const repo of group.repos) {
    for (const checkout of repo.checkouts) groupRepoByCheckout.set(checkout.projectId, repo);
  }
  const pinned: Record<string, PinnedRepositoryBinding> = {};
  for (const projectId of ids) {
    const project = projectById.get(projectId);
    const groupRepo = groupRepoByCheckout.get(projectId);
    if (!project || !groupRepo) throw new Error("mission-brief-source-unavailable");
    let enrolledPath: string, info: Stats;
    try {
      enrolledPath = realpathSync(resolve(project.path));
      info = statSync(enrolledPath);
    } catch { throw new Error("mission-brief-source-unavailable"); }
    if (recordedPaths !== undefined) {
      let recordedPath: string;
      try { recordedPath = realpathSync(resolve(recordedPaths[projectId]!)); }
      catch { throw new Error("mission-brief-source-unavailable"); }
      if (recordedPath !== enrolledPath) throw new Error("mission-brief-source-unavailable");
    }
    const identity = expectedIdentity({ ...project, path: enrolledPath }, readGit);
    if (!identity || (groupRepo.key && identity.key !== groupRepo.key)) throw new Error("source-identity-changed");
    const head = readGitHead(enrolledPath);
    if (head === undefined) throw new Error("mission-brief-source-unavailable");
    pinned[projectId] = {
      enrolledPath,
      projectDevice: String(info.dev),
      projectInode: String(info.ino),
      repoIdentity: digest(identity.key),
      head,
    };
  }
  return pinned;
}

export function pinnedSourcesFromBinding(
  pinnedRepositories: Record<string, PinnedRepositoryBinding>,
): Record<string, UnderstandingPinnedSource> {
  const sources: Record<string, UnderstandingPinnedSource> = {};
  for (const projectId of Object.keys(pinnedRepositories).sort((a, b) => a.localeCompare(b))) {
    const entry = pinnedRepositories[projectId]!;
    sources[projectId] = { head: entry.head, repoIdentity: entry.repoIdentity };
  }
  return sources;
}

export function isMissionBindingEntry(
  binding: Binding,
  pinnedSources: Record<string, UnderstandingPinnedSource> | undefined,
): boolean {
  return binding.missionRole !== undefined || binding.pinnedRepositories !== undefined || pinnedSources !== undefined;
}

export function entryMatchesCheckouts(
  binding: Binding,
  sourceProjectId: string,
  checkouts: ReadonlySet<string>,
): boolean {
  if (binding.pinnedRepositories) {
    return Object.keys(binding.pinnedRepositories).some(projectId => checkouts.has(projectId));
  }
  return checkouts.has(sourceProjectId);
}

export function sessionAppliesToRepository(
  session: Session,
  checkouts: ReadonlySet<string>,
  groupRepoByCheckout: ReadonlyMap<string, ProjectGroupRepo>,
  missionsById: ReadonlyMap<string, Mission>,
): boolean {
  if (session.team?.role !== "mission-coordinator") return checkouts.has(session.projectId);
  const mission = missionsById.get(session.team.runId);
  if (!mission) return checkouts.has(session.projectId);
  return mission.repoProjectIds.length > 0
    && mission.repoProjectIds.every(projectId => groupRepoByCheckout.has(projectId))
    && mission.repoProjectIds.some(projectId => checkouts.has(projectId));
}

export type SessionMetaLookup =
  | { state: "found"; session: Session }
  | { state: "missing" }
  | { state: "unreadable" };

export interface MissionBindingContext {
  missionsById: ReadonlyMap<string, Mission>;
  recordedRepoPaths?(missionId: string): Record<string, string> | undefined;
  liveProjectBinding(projectId: string): ProjectBinding | undefined;
  liveRepoHead(enrolledPath: string): string | null | undefined;
  readSession(sessionId: string): SessionMetaLookup;
  ownedTeamSession(session: Session): { runId: string; memberId: string } | undefined;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sameSortedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function validateMissionPinnedBinding(
  binding: Binding,
  artifact: Pick<UnderstandingArtifact, "sourceProjectId" | "sessionId" | "sourceKind" | "head" | "pinnedSources">,
  context: MissionBindingContext,
): boolean {
  if (binding.missionRole !== "mission-coordinator" || !binding.pinnedRepositories || !artifact.pinnedSources) return false;
  if (binding.sourceKind !== "team" || artifact.sourceKind !== "team" || !binding.runId || !binding.memberId) return false;
  if (binding.projectId !== artifact.sourceProjectId) return false;

  const pinnedRepos = binding.pinnedRepositories;
  const pinnedSources = artifact.pinnedSources;
  const bindingIds = Object.keys(pinnedRepos).sort((a, b) => a.localeCompare(b));
  const artifactIds = Object.keys(pinnedSources).sort((a, b) => a.localeCompare(b));
  if (!bindingIds.length || !sameSortedIds(bindingIds, artifactIds)) return false;
  if (!Object.hasOwn(pinnedRepos, binding.projectId)) return false;

  const primary = pinnedRepos[binding.projectId]!;
  if (
    primary.enrolledPath !== binding.enrolledPath
    || primary.projectDevice !== binding.projectDevice
    || primary.projectInode !== binding.projectInode
    || primary.repoIdentity !== binding.repoIdentity
    || artifact.head !== primary.head
  ) return false;

  for (const projectId of bindingIds) {
    const repoBinding = pinnedRepos[projectId]!;
    const artifactSource = pinnedSources[projectId]!;
    if (artifactSource.head !== repoBinding.head || artifactSource.repoIdentity !== repoBinding.repoIdentity) return false;
  }

  const mission = context.missionsById.get(binding.runId);
  if (!mission || !sameSortedIds(sortedUnique(mission.repoProjectIds), bindingIds)) return false;
  const recordedPaths = context.recordedRepoPaths?.(binding.runId);
  if (recordedPaths !== undefined) {
    const recordedIds = Object.keys(recordedPaths).sort((a, b) => a.localeCompare(b));
    if (!sameSortedIds(recordedIds, bindingIds)) return false;
  }

  for (const projectId of bindingIds) {
    const expected = pinnedRepos[projectId]!;
    if (recordedPaths !== undefined) {
      let recordedPath: string;
      try { recordedPath = realpathSync(resolve(recordedPaths[projectId]!)); }
      catch { return false; }
      if (recordedPath !== expected.enrolledPath) return false;
    }
    const liveProject = context.liveProjectBinding(projectId);
    if (
      !liveProject
      || liveProject.enrolledPath !== expected.enrolledPath
      || liveProject.projectDevice !== expected.projectDevice
      || liveProject.projectInode !== expected.projectInode
      || liveProject.repoIdentity !== expected.repoIdentity
    ) return false;
    const liveHead = context.liveRepoHead(liveProject.enrolledPath);
    if (liveHead === undefined || liveHead !== expected.head) return false;
  }

  const retained = bindingIds.every(projectId => pinnedRepos[projectId]!.head !== null);
  const lookup = context.readSession(artifact.sessionId);
  if (lookup.state === "unreadable") return false;
  if (lookup.state === "missing") return retained;
  const session = lookup.session;
  if (
    session.team?.role !== "mission-coordinator"
    || session.projectId !== binding.projectId
    || session.team.runId !== binding.runId
    || session.team.memberId !== binding.memberId
  ) return false;

  const owner = context.ownedTeamSession(session);
  if (!owner || owner.runId !== binding.runId || owner.memberId !== binding.memberId) return false;

  let root: string, sourceCwd: string, rootStat: Stats, cwdStat: Stats;
  try {
    root = realpathSync(binding.root);
    sourceCwd = realpathSync(session.cwd);
    rootStat = statSync(root);
    cwdStat = statSync(sourceCwd);
  } catch (error) { return isMissingSessionError(error) ? retained : false; }

  if (!pathInside(binding.enrolledPath, root)) return false;
  return root === binding.root
    && String(rootStat.dev) === binding.rootDevice
    && String(rootStat.ino) === binding.rootInode
    && sourceCwd === binding.sourceCwd
    && String(cwdStat.dev) === binding.sourceCwdDevice
    && String(cwdStat.ino) === binding.sourceCwdInode;
}
