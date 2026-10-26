import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { closeSync, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { rm as rmAsync } from "node:fs/promises";
import { basename, dirname, join, resolve, relative, isAbsolute, parse, sep } from "node:path";
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
export function teamCommand(command: TeamCommand, cwd: string, signal?: AbortSignal, timeoutMs = 600000, prefix?: TeamCommand, input?: string): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const env = teamCommandEnvironment();
    const child = spawn(prefix?.command ?? command.command, prefix ? [...prefix.args, command.command, ...command.args] : command.args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "", stdout = "", interrupted = false, settled = false, truncated = false;
    const stop = () => {
      interrupted = true;
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch (error) {
        // A prefixed launcher such as sudo leads a group the host may not signal; say so rather than imply the command stopped.
        if ((error as NodeJS.ErrnoException).code === "EPERM") capture(Buffer.from("\n[The host could not stop this command (EPERM); it was left to finish and its result is not used.]\n"));
      }
    };
    const capture = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      truncated ||= output.length + text.length > 65536;
      output = (output + text).slice(-65536);
    };
    child.stdout!.on("data", chunk => { capture(chunk); stdout = (stdout + chunk.toString("utf8")).slice(-65536); }); child.stderr!.on("data", capture);
    if (input !== undefined) {
      child.stdin!.on("error", error => {
        truncated = true;
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") capture(Buffer.from("\n[The host could not send configured team input.]\n"));
      });
      child.stdin!.end(input, "utf8");
    }
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
function strictlyInside(root: string, target: string) {
  const rel = relative(root, target);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Validate a host-owned run directory before any recursive removal. Missing targets are already removed. */
function checkedRemovalDirectory(runDirectory: string, configuredRoot: string) {
  const root = resolve(configuredRoot), target = resolve(runDirectory);
  if (!strictlyInside(root, target)) throw unsafeTeamRoot();
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || !hostOwned(info)) throw unsafeTeamRoot();
  let rootInfo: ReturnType<typeof lstatSync>, canonicalRoot: string, canonicalTarget: string;
  try {
    rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw unsafeTeamRoot();
    canonicalRoot = realpathSync(root);
    canonicalTarget = realpathSync(target);
  } catch { throw unsafeTeamRoot(); }
  if (!strictlyInside(canonicalRoot, canonicalTarget)) throw unsafeTeamRoot();
  return { root: canonicalRoot, target: canonicalTarget };
}
function removalFailed(result: CommandResult) {
  if (result.exitCode === 0 && !result.interrupted && !result.truncated) return;
  throw new TeamError(409, "workspace-removal-failed", "The host could not remove the agent-owned team workspace through its configured command prefix.");
}
function safeRemovalName(name: string) {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || basename(name) !== name || isAbsolute(name))
    throw new TeamError(409, "team-root-unsafe", "Team workspace removal found an unsafe top-level entry name.");
  return name;
}
/** Remove both team clones, then the host-owned run directory. `configuredRoot` is required to fail closed. */
export async function removeTeamWorkspace(runDirectory: string, prefix?: TeamCommand, signal?: AbortSignal, configuredRoot?: string) {
  if (!configuredRoot) throw new TeamError(409, "team-root-unsafe", "Team workspace removal requires its configured team root.");
  const safe = checkedRemovalDirectory(runDirectory, configuredRoot);
  if (!safe) return;
  if (prefix) {
    const entries = readdirSync(safe.target).map(safeRemovalName);
    if (entries.length) {
      const result = await teamCommand({ command: "rm", args: ["-rf", "--", ...entries] }, safe.target, signal, 600000, prefix);
      removalFailed(result);
    }
  } else {
    await rmAsync(join(safe.target, "integration"), { recursive: true, force: true });
    await rmAsync(join(safe.target, "members"), { recursive: true, force: true });
  }
  await rmAsync(safe.target, { recursive: true, force: true });
}
/** Remove the recorded member clone without following a redirected run or parent directory. */
export async function removeMemberWorkspace(runDirectory: string, memberCwd: string, prefix?: TeamCommand, signal?: AbortSignal, configuredRoot?: string): Promise<boolean> {
  if (!configuredRoot) throw new TeamError(409, "team-root-unsafe", "Member workspace removal requires its configured team root.");
  const safe = checkedRemovalDirectory(runDirectory, configuredRoot);
  if (!safe) return false;
  const target = resolve(memberCwd), rel = relative(safe.target, target), parts = rel.split(sep);
  if (!strictlyInside(safe.target, target) || !parts.every(part => safeRemovalName(part))) throw unsafeTeamRoot();
  const allowedLayout = (parts.length === 2 && parts[0] === "members") ||
    (parts.length === 3 && parts[0] === "recovery" && parts[1] === "members") ||
    (parts.length === 4 && parts[0] === "recovery" && parts[2] === "members");
  if (!allowedLayout) throw unsafeTeamRoot();
  if (parts[0] === "recovery" && parts.length === 4) safeWorkspaceId(parts[1]!);
  safeWorkspaceId(parts.at(-1)!);
  const parent = dirname(target);
  let current = safe.target;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || !hostOwned(info)) throw unsafeTeamRoot();
    let canonical: string;
    try { canonical = realpathSync(current); } catch { throw unsafeTeamRoot(); }
    if (canonical !== current || !strictlyInside(safe.root, canonical)) throw unsafeTeamRoot();
  }
  if (current !== parent) throw unsafeTeamRoot();
  const memberName = safeRemovalName(basename(target));
  let memberInfo: ReturnType<typeof lstatSync>;
  try { memberInfo = lstatSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!memberInfo.isDirectory() || memberInfo.isSymbolicLink() || !prefix && !hostOwned(memberInfo)) throw unsafeTeamRoot();
  if (prefix) {
    const result = await teamCommand({ command: "rm", args: ["-rf", "--", memberName] }, parent, signal, 600000, prefix);
    removalFailed(result);
  } else await rmAsync(join(parent, memberName), { recursive: true, force: true });
  return true;
}
const hostOwned = (stat: ReturnType<typeof lstatSync>) => {
  if (!stat) return false;
  return typeof process.getuid !== "function" || stat.uid === process.getuid() || stat.uid === 0;
};
const unsafeTeamRoot = () => new TeamError(409, "team-root-unsafe", "Team roots must contain only host-owned real directories that are not writable by group or others.");
function assertSecureAncestors(path: string) {
  try {
    const canonical = realpathSync(path), root = parse(canonical).root;
    let current = root;
    for (const part of ["", ...relative(root, canonical).split(/[\\/]/).filter(Boolean)]) {
      current = join(current, part);
      const info = lstatSync(current);
      if (!info.isDirectory() || !hostOwned(info) || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) throw unsafeTeamRoot();
    }
  } catch { throw unsafeTeamRoot(); }
}
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
  let anchor = dirname(resolve(root));
  while (true) {
    try { lstatSync(anchor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create || dirname(anchor) === anchor) throw unsafeTeamRoot();
      anchor = dirname(anchor);
    }
  }
  return ensureHostDirectory(anchor, root, 0o750, create);
}
/** Create/check each component below a trusted anchor without traversing an unsafe parent. */
export function ensureHostDirectory(anchor: string, target: string, mode: number, create = true) {
  let base: string;
  try { base = realpathSync(anchor); } catch { throw unsafeTeamRoot(); }
  assertSecureAncestors(base);
  // Keep the suffix relative to the supplied anchor when a system alias resolves elsewhere.
  const rel = relative(resolve(anchor), resolve(target));
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw unsafeTeamRoot();
  let current = base;
  for (const part of rel.split(/[\\/]/)) {
    current = join(current, part);
    ensureHostDirectoryComponent(current, mode, create);
  }
  return realpathSync(current);
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
export async function prepareTeamWorkspace(source: string, root: string, directoryName: string, branch: string, prefix?: TeamCommand, signal?: AbortSignal, expectedHead?: string, anchor?: string, startCommit?: string) {
  let canonical: string, top: string;
  try { canonical = realpathSync(source); top = await git(canonical, ["rev-parse", "--show-toplevel"], prefix, 30000, signal); }
  catch { throw new TeamError(409, "project-not-git-root", "The configured team project must be an accessible Git repository with a committed HEAD."); }
  if (realpathSync(top) !== canonical) throw new TeamError(409, "project-not-git-root", "The configured team project must be a Git repository root.");
  if (await git(canonical, ["status", "--porcelain=v1", "--untracked-files=all"], prefix, 30000, signal))
    throw new TeamError(409, "project-dirty", "Commit or separately preserve the configured project's changes before starting a team.");
  const sourceHead = await git(canonical, ["rev-parse", "HEAD"], prefix, 30000, signal);
  const baseCommit = startCommit ?? sourceHead;
  if (startCommit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(startCommit)) throw new TeamError(409, "invalid-delivery-baseline", "The recorded merge baseline is invalid.");
  if (expectedHead !== undefined && sourceHead !== expectedHead)
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
  if (startCommit) await git(workspace, ["fetch", "--no-tags", "--", canonical, startCommit], prefix, 30000, signal);
  await git(workspace, ["checkout", "-b", branch, baseCommit], prefix, 30000, signal);
  if (await git(canonical, ["rev-parse", "HEAD"], prefix, 30000, signal) !== sourceHead || await git(canonical, ["status", "--porcelain=v1", "--untracked-files=all"], prefix, 30000, signal))
    throw new TeamError(409, "project-changed", "The source project changed during capture. The team remains blocked with its isolated copy preserved.");
  return { workspace, branch, baseCommit };
}
export async function prepareTeamWorkspaceFromMirror(mirror: string, head: string, root: string, directoryName: string, branch: string, prefix?: TeamCommand, signal?: AbortSignal, anchor?: string): Promise<{ workspace: string; branch: string; baseCommit: string }> {
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
  await git(directory, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", mirror, workspace], prefix, 120000, signal);
  await git(workspace, ["remote", "remove", "origin"], prefix, 30000, signal);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head) || (await git(workspace, ["cat-file", "-t", head], prefix, 30000, signal)) !== "commit")
    throw new TeamError(409, "source-unavailable", "The host has no copy of this repository from GitHub yet; check the project's source status.");
  await git(workspace, ["checkout", "-b", branch, head], prefix, 30000, signal);
  return { workspace, branch, baseCommit: head };
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
/** Assign scratch outside the Git checkout; prompt-supplied temporary paths never establish ownership. */
export function prepareMemberScratch(workspace: string, memberId: string) {
  safeWorkspaceId(memberId);
  const anchor = dirname(realpathSync(workspace));
  const parent = join(anchor, "scratch");
  try { mkdirSync(parent, { mode: 0o750 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !hostOwned(parentInfo) || (parentInfo.mode & 0o022) !== 0 || realpathSync(parent) !== parent)
    throw unsafeTeamRoot();
  // Preserve the run root's shared group for newly assigned child directories.
  chmodDirectoryNoFollow(parent, 0o2750);
  const target = join(parent, memberId);
  try { mkdirSync(target, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink() || !hostOwned(info) || realpathSync(target) !== target)
    throw unsafeTeamRoot();
  // Team roots carry the agent's shared group. Keep the parent host-owned and non-writable.
  chmodDirectoryNoFollow(target, 0o2770);
  return target;
}
const writeTeamContextScript = `
const fs = require("node:fs");
const path = require("node:path");
const metadata = path.join(process.cwd(), ".git");
const name = process.argv[1];
const chunks = [];
let directoryFd, fileFd, temporary;
function fail() { throw new Error("unsafe context destination"); }
function targetInfo(target) {
  try {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || !info.isFile()) fail();
    return info;
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const noFollow = fs.constants.O_NOFOLLOW;
    if (!noFollow) fail();
    const metadataInfo = fs.lstatSync(metadata);
    if (!metadataInfo.isDirectory() || metadataInfo.isSymbolicLink() || fs.realpathSync(metadata) !== metadata) fail();
    directoryFd = fs.openSync(metadata, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | noFollow);
    const openedInfo = fs.fstatSync(directoryFd);
    if (!openedInfo.isDirectory() || openedInfo.dev !== metadataInfo.dev || openedInfo.ino !== metadataInfo.ino) fail();
    const target = path.join(metadata, "infinite-team-context.json");
    targetInfo(target);
    temporary = path.join(metadata, ".infinite-team-context." + name + ".tmp");
    fileFd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    const content = Buffer.concat(chunks);
    JSON.parse(content.toString("utf8"));
    fs.writeFileSync(fileFd, content);
    fs.fchmodSync(fileFd, 0o400);
    fs.fsyncSync(fileFd);
    fs.closeSync(fileFd);
    fileFd = undefined;
    const currentMetadata = fs.lstatSync(metadata);
    if (!currentMetadata.isDirectory() || currentMetadata.isSymbolicLink() || currentMetadata.dev !== openedInfo.dev || currentMetadata.ino !== openedInfo.ino || fs.realpathSync(metadata) !== metadata) fail();
    targetInfo(target);
    fs.renameSync(temporary, target);
    temporary = undefined;
    fs.fsyncSync(directoryFd);
    fs.closeSync(directoryFd);
    directoryFd = undefined;
    process.stdout.write("INFINITE_TEAM_CONTEXT_WRITTEN:" + name);
  } catch {
    try { if (fileFd !== undefined) fs.closeSync(fileFd); } catch {}
    try { if (temporary) fs.unlinkSync(temporary); } catch {}
    try { if (directoryFd !== undefined) fs.closeSync(directoryFd); } catch {}
    process.stderr.write("The host refused an unsafe Git metadata context write.\\n");
    process.exitCode = 1;
  }
});
`;
/** Store complete agent context in ignored Git metadata, atomically replacing only a regular prior snapshot. */
export async function writeTeamContext(cwd: string, context: unknown, prefix?: TeamCommand, signal?: AbortSignal): Promise<void> {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(context, null, 2); } catch { throw new TeamError(409, "team-context-invalid", "The team context could not be serialized safely."); }
  if (serialized === undefined) throw new TeamError(409, "team-context-invalid", "The team context must be a JSON value.");
  let info: ReturnType<typeof lstatSync>, canonical: string;
  try { info = lstatSync(cwd); canonical = realpathSync(cwd); }
  catch { throw new TeamError(409, "invalid-workspace", "The member workspace must be an accessible real Git repository."); }
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== resolve(cwd))
    throw new TeamError(409, "invalid-workspace", "The member workspace must be a real directory without a symlink path.");
  if (await git(canonical, ["rev-parse", "--show-toplevel"], prefix, 30000, signal) !== canonical)
    throw new TeamError(409, "invalid-workspace", "The member workspace must be a Git repository root.");
  const nonce = randomUUID();
  const result = await teamCommand({ command: process.execPath, args: ["-e", writeTeamContextScript, nonce] }, canonical, signal, 30000, prefix, `${serialized}\n`);
  if (result.exitCode !== 0 || result.interrupted || result.truncated || !result.stdout.includes(`INFINITE_TEAM_CONTEXT_WRITTEN:${nonce}`))
    throw new TeamError(409, "team-context-write-failed", "The complete team context could not be stored safely in Git metadata; do not launch this member.");
}
/** Retain the reported merge object without changing the reviewed working tree. */
export async function captureDeliveryBaseline(workspace: string, memberCwd: string, reviewedHead: string, mergeCommit: string, prefix?: TeamCommand, signal?: AbortSignal) {
  await git(workspace, ["fetch", "--no-tags", "--", memberCwd, mergeCommit], prefix, 30000, signal);
  if (await git(workspace, ["cat-file", "-t", mergeCommit], prefix, 30000, signal) !== "commit")
    throw new TeamError(409, "invalid-delivery-baseline", "The reported merge must identify a commit. Its receipt is retained for reconciliation.");
  const reviewedTree = await git(workspace, ["rev-parse", `${reviewedHead}^{tree}`], prefix, 30000, signal);
  const mergedTree = await git(workspace, ["rev-parse", `${mergeCommit}^{tree}`], prefix, 30000, signal);
  if (reviewedTree !== mergedTree)
    throw new TeamError(409, "delivery-baseline-changed", "The reported merge includes changes beyond the reviewed tree. Its receipt is retained; inspect the merged baseline before another goal cycle.");
  await git(workspace, ["update-ref", "refs/infinite/delivery", mergeCommit], prefix, 30000, signal);
}
export async function teamHead(cwd: string, prefix?: TeamCommand, signal?: AbortSignal) { return git(cwd, ["rev-parse", "HEAD"], prefix, 30000, signal); }
export type ReadOnlyWorkspaceContext = "verification" | "setup" | "integration" | "member";
export const LEGACY_READ_ONLY_ROLE_CHANGED_FILES_REASON = "A read-only agent changed its working copy. Its report cannot advance the team.";
const readOnlyContextCode: Record<ReadOnlyWorkspaceContext, string> = {
  verification: "verification-changed-files",
  setup: "setup-changed-files",
  integration: "integration-changed-files",
  member: "read-only-role-changed-files",
};
const readOnlyContextLabel: Record<ReadOnlyWorkspaceContext, string> = {
  verification: "verification workspace",
  setup: "setup workspace",
  integration: "integration workspace",
  member: "read-only member workspace",
};
const MAX_DIAGNOSTIC_PATHS = 8;
const MAX_DIAGNOSTIC_PATH_LENGTH = 96;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
function quotedDiagnosticPath(path: string) {
  const safe = path.replace(CONTROL_OR_BIDI, character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
  const bounded = [...safe].length > MAX_DIAGNOSTIC_PATH_LENGTH ? `${[...safe].slice(0, MAX_DIAGNOSTIC_PATH_LENGTH - 1).join("")}…` : safe;
  return JSON.stringify(bounded);
}
/** Parse NUL-delimited porcelain paths without ever interpreting filenames as records or terminal text. */
function changedPathsFromStatus(status: string) {
  const records = status.split("\0").filter(Boolean), paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") continue;
    paths.push(record.slice(3));
    if (/[RC]/.test(record.slice(0, 2)) && records[index + 1] !== undefined) paths.push(records[++index]);
  }
  return paths;
}
function shortCommit(commit: string) { return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit) ? commit.slice(0, 12) : "unknown"; }
function readOnlyDiagnostic(context: ReadOnlyWorkspaceContext, base: string, head: string, paths: string[]) {
  const headDrift = head !== base
    ? `HEAD changed from ${shortCommit(base)} to ${shortCommit(head)}.`
    : `HEAD still matches pinned commit ${shortCommit(base)}.`;
  const shown = paths.slice(0, MAX_DIAGNOSTIC_PATHS).map(quotedDiagnosticPath);
  const omitted = Math.max(0, paths.length - shown.length);
  const changed = paths.length
    ? `Changed paths (${paths.length}): ${shown.join(", ")}${omitted ? `; ${omitted} additional changed path${omitted === 1 ? "" : "s"} omitted` : ""}.`
    : "There are no working-tree paths in the change; the difference is in HEAD only.";
  return `The ${readOnlyContextLabel[context]} is not read-only. ${headDrift} ${changed} Its report cannot advance the team.`;
}
/** Keep verification diagnostics separate from member blame, while refusing every HEAD or file mutation. */
export async function assertMemberReadOnly(cwd: string, base: string, prefix?: TeamCommand, signal?: AbortSignal, context: ReadOnlyWorkspaceContext = "member") {
  const head = await teamHead(cwd, prefix, signal);
  const repositoryRoot = await git(cwd, ["rev-parse", "--show-toplevel"], prefix, 30000, signal);
  const status = await git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], prefix, 30000, signal);
  const changed = changedPathsFromStatus(status);
  if (head !== base || changed.length)
    throw new TeamError(409, readOnlyContextCode[context], readOnlyDiagnostic(context, base, head, changed));
}

type SiblingWorkspaceKind = "verification" | "recovery";
function safeWorkspaceId(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new TeamError(409, "invalid-workspace", "A copied workspace needs a path-safe identity.");
  return id;
}
function ensureSiblingWorkspaceParent(workspace: string, kind: SiblingWorkspaceKind, id: string) {
  safeWorkspaceId(id);
  let workspaceInfo: ReturnType<typeof lstatSync>, canonicalWorkspace: string;
  try { workspaceInfo = lstatSync(workspace); canonicalWorkspace = realpathSync(workspace); }
  catch { throw new TeamError(409, "invalid-workspace", "The source workspace is not an accessible real directory."); }
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink())
    throw new TeamError(409, "invalid-workspace", "The source workspace must be a real directory.");
  const sourceParent = dirname(canonicalWorkspace);
  const parentName = basename(sourceParent);
  const runDirectory = basename(canonicalWorkspace) === "integration"
    ? sourceParent
    : parentName === "recovery" || parentName === "verification"
      ? dirname(sourceParent)
      : undefined;
  if (!runDirectory) throw new TeamError(409, "invalid-workspace", "A copied workspace must be an integration or recovery checkout inside its original run.");
  if (runDirectory !== sourceParent) {
    let copiedParent: ReturnType<typeof lstatSync>;
    try { copiedParent = lstatSync(sourceParent); } catch { throw unsafeTeamRoot(); }
    if (!copiedParent.isDirectory() || copiedParent.isSymbolicLink() || !hostOwned(copiedParent)) throw unsafeTeamRoot();
  }
  let runInfo: ReturnType<typeof lstatSync>;
  try { runInfo = lstatSync(runDirectory); } catch { throw unsafeTeamRoot(); }
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || !hostOwned(runInfo)) throw unsafeTeamRoot();

  const parent = join(runDirectory, kind);
  let parentInfo: ReturnType<typeof lstatSync> | undefined;
  try { parentInfo = lstatSync(parent); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unsafeTeamRoot();
    try { mkdirSync(parent, { mode: 0o700 }); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
    try { parentInfo = lstatSync(parent); } catch { throw unsafeTeamRoot(); }
  }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || !hostOwned(parentInfo)) throw unsafeTeamRoot();
  chmodDirectoryNoFollow(parent, 0o2770);

  const destination = join(parent, id);
  try { lstatSync(destination); throw new TeamError(409, "workspace-exists", `A ${kind} workspace already exists and needs explicit reconciliation.`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { source: canonicalWorkspace, destination };
}
async function preparePinnedWorkspaceClone(workspace: string, kind: SiblingWorkspaceKind, id: string, baseCommit: string, prefix?: TeamCommand, signal?: AbortSignal, branch?: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseCommit)) throw new TeamError(409, "invalid-workspace-baseline", "The copied workspace baseline is invalid.");
  const { source, destination } = ensureSiblingWorkspaceParent(workspace, kind, id);
  const top = await git(source, ["rev-parse", "--show-toplevel"], prefix, 30000, signal);
  if (realpathSync(top) !== source) throw new TeamError(409, "project-not-git-root", "The copied workspace source must be a Git repository root.");
  if (await git(source, ["cat-file", "-t", baseCommit], prefix, 30000, signal) !== "commit")
    throw new TeamError(409, "invalid-workspace-baseline", "The copied workspace baseline must identify a commit.");
  await git(dirname(destination), ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", source, destination], prefix, 120000, signal);
  await git(destination, ["remote", "remove", "origin"], prefix, 30000, signal);
  if (branch) {
    await git(destination, ["check-ref-format", "--branch", branch], prefix, 30000, signal);
    await git(destination, ["checkout", "-B", branch, baseCommit], prefix, 30000, signal);
  } else await git(destination, ["checkout", "--detach", baseCommit], prefix, 30000, signal);
  if (await teamHead(destination, prefix, signal) !== baseCommit || await git(destination, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], prefix, 30000, signal))
    throw new TeamError(409, "workspace-copy-changed", `The ${kind} workspace did not match its requested clean baseline. The copy was preserved for inspection.`);
  return { workspace: realpathSync(destination), ...(branch ? { branch } : {}), baseCommit };
}
/** Create a disposable, detached checkout of exactly the requested integration commit. */
export async function prepareVerificationWorkspace(workspace: string, id: string, baseCommit: string, prefix?: TeamCommand, signal?: AbortSignal) {
  const prepared = await preparePinnedWorkspaceClone(workspace, "verification", id, baseCommit, prefix, signal);
  return { workspace: prepared.workspace, baseCommit: prepared.baseCommit };
}
/** Create a recovery copy beside the original integration checkout; retries never nest under a prior copy. */
export async function prepareRecoveredWorkspace(workspace: string, id: string, baseCommit: string, prefix?: TeamCommand, signal?: AbortSignal, branch?: string) {
  const prepared = await preparePinnedWorkspaceClone(workspace, "recovery", id, baseCommit, prefix, signal, branch);
  return { workspace: prepared.workspace, ...(prepared.branch ? { branch: prepared.branch } : {}), baseCommit: prepared.baseCommit };
}
/** Create a clean sibling from a host-refreshed source mirror, preserving the old integration copy. */
export async function prepareRecoveryWorkspaceFromSource(workspace: string, source: string, id: string, baseCommit: string, prefix?: TeamCommand, signal?: AbortSignal, branch?: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(baseCommit)) throw new TeamError(409, "invalid-workspace-baseline", "The copied workspace baseline is invalid.");
  const { destination } = ensureSiblingWorkspaceParent(workspace, "recovery", id);
  // The source mirror is only a clone argument: the restricted launcher allows no Git inspection inside it.
  await git(dirname(destination), ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--", source, destination], prefix, 120000, signal);
  await git(destination, ["remote", "remove", "origin"], prefix, 30000, signal);
  if (await git(destination, ["cat-file", "-t", baseCommit], prefix, 30000, signal) !== "commit")
    throw new TeamError(409, "invalid-workspace-baseline", "The refreshed source must contain the recorded base commit. The copy was preserved for inspection.");
  if (branch) {
    await git(destination, ["check-ref-format", "--branch", branch], prefix, 30000, signal);
    await git(destination, ["checkout", "-B", branch, baseCommit], prefix, 30000, signal);
  } else await git(destination, ["checkout", "--detach", baseCommit], prefix, 30000, signal);
  if (await teamHead(destination, prefix, signal) !== baseCommit || await git(destination, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], prefix, 30000, signal))
    throw new TeamError(409, "workspace-copy-changed", "The source recovery workspace did not match its requested clean baseline. The copy was preserved for inspection.");
  return { workspace: realpathSync(destination), ...(branch ? { branch } : {}), baseCommit };
}
export function teamPathAllowed(path: string, allowed: string[]) { return allowed.some(prefix => prefix === "." || path === prefix || path.startsWith(`${prefix}/`)); }
/** List all tracked, staged, and untracked paths changed from a member's base commit. */
export async function memberChangedPaths(cwd: string, base: string, prefix?: TeamCommand, signal?: AbortSignal) {
  const changed = [
    ...lines(await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, "--"], prefix, 30000, signal)),
    ...lines(await git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, "--"], prefix, 30000, signal)),
    ...lines(await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], prefix, 30000, signal)),
  ];
  return [...new Set(changed)].sort();
}
/** A continuation may retain partial edits only after their ownership is checked. */
export async function assertMemberScope(cwd: string, base: string, paths?: string[], prefix?: TeamCommand, signal?: AbortSignal) {
  await git(cwd, ["merge-base", "--is-ancestor", base, "HEAD"], prefix, 30000, signal);
  const changed = await memberChangedPaths(cwd, base, prefix, signal);
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
