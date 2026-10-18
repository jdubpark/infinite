import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import type { TeamCommand, TeamTaskPlan } from "./team-types.js";

export class TeamError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export interface CommandResult { exitCode: number | null; output: string; stdout: string; interrupted: boolean; truncated: boolean }
export function teamCommandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"])
    if (process.env[name]) env[name] = process.env[name];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  return env;
}
export function teamGitArgs(cwd: string, args: string[]) {
  return ["-c", `safe.directory=${cwd}`, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "user.name=Infinite", "-c", "user.email=agent@example.invalid", ...args];
}
/** Commands are argv arrays, from owner configuration or an explicitly authorized plan. */
export function teamCommand(command: TeamCommand, cwd: string, signal?: AbortSignal, timeoutMs = 600000, prefix?: TeamCommand): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const env = teamCommandEnvironment();
    const child = spawn(prefix?.command ?? command.command, prefix ? [...prefix.args, command.command, ...command.args] : command.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "", stdout = "", interrupted = false, settled = false, truncated = false;
    const stop = () => {
      interrupted = true;
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };
    const capture = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      truncated ||= output.length + text.length > 65536;
      output = (output + text).slice(-65536);
    };
    child.stdout.on("data", chunk => { capture(chunk); stdout = (stdout + chunk.toString("utf8")).slice(-65536); }); child.stderr.on("data", capture);
    const timer = setTimeout(stop, timeoutMs); timer.unref();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.once("error", () => { if (settled) return; settled = true; finish(); reject(new TeamError(409, "command-unavailable", "A configured team command could not be started.")); });
    child.once("close", exitCode => { if (settled) return; settled = true; finish(); resolveResult({ exitCode, output, stdout, interrupted, truncated }); });
  });
}
/** Streams a full bundle of one branch on stdout, with the same restricted Git invocation as other team operations. */
export function spawnTeamBundle(workspace: string, branch: string, prefix?: TeamCommand) {
  const args = teamGitArgs(workspace, ["bundle", "create", "-", `refs/heads/${branch}`]);
  return spawn(prefix?.command ?? "git", prefix ? [...prefix.args, "git", ...args] : args, { cwd: workspace, env: teamCommandEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
}
async function git(cwd: string, args: string[], prefix?: TeamCommand, timeoutMs = 30000, signal?: AbortSignal) {
  const result = await teamCommand({ command: "git", args: teamGitArgs(cwd, args) }, cwd, signal, timeoutMs, prefix);
  if (result.exitCode !== 0 || result.interrupted || result.truncated) throw new TeamError(409, "workspace-operation-failed", "A team Git operation failed. The isolated workspace was preserved for inspection.");
  return args.includes("-z") ? result.stdout : result.stdout.trim();
}
function lines(value: string) { return value.split("\0").filter(Boolean); }
export function teamWorkspacePath(root: string, directoryName: string) { return join(root, directoryName, "integration"); }
const hostOwned = (stat: ReturnType<typeof lstatSync>) => {
  if (!stat) return false;
  return typeof process.getuid !== "function" || stat.uid === process.getuid() || stat.uid === 0;
};
const unsafeTeamRoot = () => new TeamError(409, "team-root-unsafe", "Team roots must contain only host-owned real directories that are not writable by group or others.");
function ensureHostDirectoryComponent(path: string, mode: number, create: boolean) {
  if (mode & 0o022) throw unsafeTeamRoot();
  let info, created = false;
  try { info = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw unsafeTeamRoot();
    try { mkdirSync(path, { mode }); created = true; } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
    try { info = lstatSync(path); } catch { throw unsafeTeamRoot(); }
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !hostOwned(info) || (info.mode & 0o022) !== 0) throw unsafeTeamRoot();
  if (created) chmodDirectoryNoFollow(path, (mode & 0o777) | (info.mode & 0o2000));
}
/** The configured default root is protected just like an anchored teamwork root. */
export function ensureDefaultTeamRoot(root: string, create = false) {
  // The parent belongs to the operator, as before; only the root itself must be protected.
  if (create) mkdirSync(dirname(root), { recursive: true, mode: 0o750 });
  ensureHostDirectoryComponent(root, 0o750, create);
  return realpathSync(root);
}
/** Create/check each component below a trusted anchor without traversing an unsafe parent. */
export function ensureHostDirectory(anchor: string, target: string, mode: number, create = true) {
  const base = realpathSync(anchor), destination = resolve(target), rel = relative(base, destination);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw unsafeTeamRoot();
  let current = base;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    ensureHostDirectoryComponent(current, mode, create);
  }
  return realpathSync(destination);
}
/** Change directory modes through an opened no-follow descriptor, never through a redirected path. */
export function chmodDirectoryNoFollow(path: string, mode: number) {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isDirectory() || !hostOwned(info)) throw unsafeTeamRoot();
    fchmodSync(fd, mode);
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** A source handoff must preserve every tracked and untracked edit and pin the actual root. */
export async function cleanTeamCheckpoint(source: string, expectedHead: string, prefix?: TeamCommand) {
  const canonical = realpathSync(source);
  const top = await git(canonical, ["rev-parse", "--show-toplevel"], prefix);
  if (realpathSync(top) !== canonical) throw new TeamError(409, "project-not-git-root", "Handoff requires the configured Git repository root.");
  await assertMemberReadOnly(canonical, expectedHead, prefix);
  return expectedHead;
}
export async function prepareTeamWorkspace(source: string, root: string, directoryName: string, branch: string, prefix?: TeamCommand, signal?: AbortSignal, expectedHead?: string, anchor?: string) {
  let canonical: string, top: string;
  try { canonical = realpathSync(source); top = await git(canonical, ["rev-parse", "--show-toplevel"], prefix, 30000, signal); }
  catch { throw new TeamError(409, "project-not-git-root", "The configured team project must be an accessible Git repository with a committed HEAD."); }
  if (realpathSync(top) !== canonical) throw new TeamError(409, "project-not-git-root", "The configured team project must be a Git repository root.");
  if (await git(canonical, ["status", "--porcelain=v1", "--untracked-files=all"], prefix, 30000, signal))
    throw new TeamError(409, "project-dirty", "Commit or separately preserve the configured project's changes before starting a team.");
  const baseCommit = await git(canonical, ["rev-parse", "HEAD"], prefix, 30000, signal);
  if (expectedHead !== undefined && baseCommit !== expectedHead)
    throw new TeamError(409, "parent-workspace-changed", "The previous goal run no longer matches its recorded integration commit. Its workspace must be reconciled before continuing.");
  if (anchor) ensureHostDirectory(anchor, root, 0o750);
  else ensureDefaultTeamRoot(root, true);
  const canonicalRoot = realpathSync(root);
  const directory = join(canonicalRoot, directoryName);
  if (existsSync(directory)) throw new TeamError(409, "workspace-exists", "This team workspace already exists and needs explicit reconciliation.");
  mkdirSync(directory, { mode: 0o700 });
  const members = join(directory, "members");
  mkdirSync(members, { mode: 0o700 });
  chmodDirectoryNoFollow(members, 0o2770);
  chmodDirectoryNoFollow(directory, 0o2770);
  const workspace = join(directory, "integration");
  await git(directory, ["clone", "--no-local", "--no-hardlinks", "--", canonical, workspace], prefix, 120000, signal);
  await git(workspace, ["remote", "remove", "origin"], prefix, 30000, signal);
  await git(workspace, ["checkout", "-b", branch, baseCommit], prefix, 30000, signal);
  if (await git(canonical, ["rev-parse", "HEAD"], prefix, 30000, signal) !== baseCommit || await git(canonical, ["status", "--porcelain=v1", "--untracked-files=all"], prefix, 30000, signal))
    throw new TeamError(409, "project-changed", "The source project changed during capture. The team remains blocked with its isolated copy preserved.");
  return { workspace, branch, baseCommit };
}
export async function prepareMemberWorkspace(workspace: string, memberId: string, baseCommit: string, prefix?: TeamCommand, signal?: AbortSignal) {
  const parent = join(workspace, "..", "members");
  let info;
  try { info = lstatSync(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; mkdirSync(parent, { mode: 0o700 }); }
  try { info = lstatSync(parent); } catch { throw unsafeTeamRoot(); }
  if (!info.isDirectory() || info.isSymbolicLink() || !hostOwned(info)) throw unsafeTeamRoot();
  chmodDirectoryNoFollow(parent, 0o2770);
  const cwd = join(parent, memberId);
  if (existsSync(cwd)) throw new TeamError(409, "workspace-exists", "A member workspace already exists and needs explicit reconciliation.");
  await git(parent, ["clone", "--no-local", "--no-hardlinks", "--", workspace, cwd], prefix, 120000, signal);
  await git(cwd, ["remote", "remove", "origin"], prefix, 30000, signal);
  await git(cwd, ["checkout", "--detach", baseCommit], prefix, 30000, signal);
  return realpathSync(cwd);
}
export async function teamHead(cwd: string, prefix?: TeamCommand, signal?: AbortSignal) { return git(cwd, ["rev-parse", "HEAD"], prefix, 30000, signal); }
export async function assertMemberReadOnly(cwd: string, base: string, prefix?: TeamCommand, signal?: AbortSignal) {
  if (await teamHead(cwd, prefix, signal) !== base || await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], prefix, 30000, signal))
    throw new TeamError(409, "read-only-role-changed-files", "A read-only agent changed its working copy. Its report cannot advance the team.");
}
export function teamPathAllowed(path: string, allowed: string[]) { return allowed.some(prefix => prefix === "." || path === prefix || path.startsWith(`${prefix}/`)); }
/** A continuation may retain partial edits only after their ownership is checked. */
export async function assertMemberScope(cwd: string, base: string, paths?: string[], prefix?: TeamCommand, signal?: AbortSignal) {
  await git(cwd, ["merge-base", "--is-ancestor", base, "HEAD"], prefix, 30000, signal);
  const changed = [
    ...lines(await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, "--"], prefix, 30000, signal)),
    ...lines(await git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, "--"], prefix, 30000, signal)),
    ...lines(await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], prefix, 30000, signal)),
  ];
  if (paths && changed.some(path => !teamPathAllowed(path, paths)))
    throw new TeamError(409, "task-scope-violation", "An agent changed files outside its assigned paths. Its changes were retained in its isolated workspace.");
}
/** Validate the full result (including agent-created commits), then make one host-owned commit. */
export async function captureMemberResult(cwd: string, base: string, paths?: string[], prefix?: TeamCommand, signal?: AbortSignal) {
  await assertMemberScope(cwd, base, paths, prefix, signal);
  // Stage only this disposable member copy; the user's source checkout is never modified.
  await git(cwd, ["add", "-A", "--", "."], prefix, 30000, signal);
  const tree = await git(cwd, ["write-tree"], prefix, 30000, signal);
  const staged = lines(await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, tree, "--"], prefix, 30000, signal));
  if (paths && staged.some(path => !teamPathAllowed(path, paths))) throw new TeamError(409, "task-scope-violation", "The staged task result contains changes outside its assigned paths.");
  const baseTree = await git(cwd, ["rev-parse", `${base}^{tree}`], prefix, 30000, signal);
  if (tree === baseTree) return undefined;
  // commit-tree avoids provider-authored hooks and folds any child commits into one delta.
  const commit = await git(cwd, ["commit-tree", tree, "-p", base, "-m", "Implement assigned team work"], prefix, 30000, signal);
  await git(cwd, ["update-ref", "refs/heads/infinite-result", commit], prefix, 30000, signal);
  return commit;
}
export async function integrateMemberResult(workspace: string, memberCwd: string, commit: string, prefix?: TeamCommand, signal?: AbortSignal) {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new TeamError(409, "invalid-commit", "The task commit is invalid.");
  await git(workspace, ["fetch", "--no-tags", "--", memberCwd, commit], prefix, 30000, signal);
  const result = await teamCommand({ command: "git", args: teamGitArgs(workspace, ["cherry-pick", commit]) }, workspace, signal, 30000, prefix);
  if (result.exitCode !== 0 || result.interrupted || result.truncated) {
    // A failed integration is preserved; no reset, forced cleanup, or automatic retry.
    throw new TeamError(409, "integration-conflict", "Task integration encountered a conflict. The team is blocked with the isolated conflict preserved.");
  }
  return teamHead(workspace, prefix, signal);
}
export function validateTeamPlan(tasks: TeamTaskPlan[]) {
  if (Buffer.byteLength(JSON.stringify(tasks)) > 48 * 1024) throw new TeamError(409, "plan-too-large", "The project manager produced a plan larger than the 48 KiB limit.");
  const byId = new Map(tasks.map(task => [task.id, task]));
  if (byId.size !== tasks.length) throw new TeamError(409, "invalid-plan", "The project manager repeated a task ID.");
  const ancestors = (id: string, visiting = new Set<string>()): Set<string> => {
    if (visiting.has(id)) throw new TeamError(409, "invalid-plan", "The project manager proposed a dependency cycle.");
    const task = byId.get(id);
    if (!task) throw new TeamError(409, "invalid-plan", "A task depends on an unknown task.");
    const next = new Set(visiting).add(id), result = new Set<string>();
    for (const dependency of task.dependsOn) { result.add(dependency); for (const ancestor of ancestors(dependency, next)) result.add(ancestor); }
    return result;
  };
  const ancestry = new Map(tasks.map(task => [task.id, ancestors(task.id)]));
  for (let first = 0; first < tasks.length; first++) for (let second = first + 1; second < tasks.length; second++) {
    const a = tasks[first], b = tasks[second];
    const overlap = a.paths.some(path => b.paths.some(other => teamPathAllowed(path, [other]) || teamPathAllowed(other, [path])));
    if (overlap && !ancestry.get(a.id)!.has(b.id) && !ancestry.get(b.id)!.has(a.id))
      throw new TeamError(409, "invalid-plan", "Parallel tasks must have separate owned paths, or an explicit dependency ordering.");
  }
}
/** Every retained child path must remain beneath the configured workspace root, without symlinks. */
export function assertTeamPath(root: string, path: string) {
  const rel = relative(realpathSync(root), resolve(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new TeamError(409, "invalid-workspace", "The team workspace is outside its configured root.");
  let current = realpathSync(root);
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new TeamError(409, "invalid-workspace", "A team workspace path contains a symbolic link.");
  }
}
