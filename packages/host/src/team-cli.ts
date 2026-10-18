import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createTeamSchema } from "./team-types.js";
import { captureWorkspace, readWorkspaceBlob } from "./workspace-checkpoint.js";
import { localProjectPath } from "./mirrored-projects.js";
import { readSyncState, syncServiceRunning } from "./sync-service.js";

type ClientConfig = { origin: string; token: string; projectId?: string };
type Api = {
  request(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<Response>;
  json<T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T>;
};
type Options = Record<string, string | boolean>;
const commandSchema = z.object({ command: z.string().min(1).max(4096).refine(value => !value.includes("\0")), args: z.array(z.string().max(4096).refine(value => !value.includes("\0"))).max(64).default([]) }).strict();
const projectConfigSchema = z.object({ setup: commandSchema.optional(), checks: z.array(commandSchema).max(8), establishChecks: z.literal(true).optional() }).strict();
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const projectIdPattern = /^[a-z0-9-]{1,80}$/;
const directoryDefaultsSchema = z.object({
  version: z.literal(1),
  directories: z.record(z.string(), z.object({ teamId: z.uuid(), projectId: z.uuid().optional() }).strict()),
}).strict();

function privateJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
function readPrivateJson(path: string, fallback: unknown) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error("Private CLI state is unreadable; preserve it and inspect the file before retrying.");
  }
}
function gitEnv(overrides: NodeJS.ProcessEnv = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), ...overrides };
}
function isolatedGitEnv(overrides: NodeJS.ProcessEnv = {}) {
  return gitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", ...overrides });
}
function git(cwd: string, args: string[], timeout = 10000) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], env: gitEnv({ GIT_OPTIONAL_LOCKS: "0" }) }).trim();
}
function inspectSourceHead(root: string): { commit: string; branch?: string } {
  try {
    const commit = execFileSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], env: gitEnv({ GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }) }).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Git did not report a valid commit.");
    return { commit };
  } catch (headError) {
    const headFailure = headError as NodeJS.ErrnoException & { status?: number; stderr?: Buffer | string };
    const headErrorText = String(headFailure.stderr ?? headFailure.message);
    if (headFailure.status !== 128 || !/Needed a single revision/i.test(headErrorText))
      throw new Error(`Could not inspect Git HEAD: ${clean(headErrorText)}.`);
    let branch: string;
    try { branch = git(root, ["symbolic-ref", "--quiet", "HEAD"]); }
    catch { throw new Error(`Could not inspect Git HEAD: ${clean(headErrorText)}.`); }
    let validBranch = branch.startsWith("refs/heads/");
    if (validBranch) {
      try { execFileSync("git", ["-C", root, "check-ref-format", branch], { stdio: "ignore", timeout: 10000, env: gitEnv({ GIT_OPTIONAL_LOCKS: "0" }) }); }
      catch { validBranch = false; }
    }
    if (!validBranch)
      throw new Error("Git HEAD is not a valid unborn branch reference.");
    let found = false, failure: unknown;
    try { execFileSync("git", ["-C", root, "show-ref", "--verify", "--quiet", branch], { stdio: "ignore", timeout: 10000, env: gitEnv({ GIT_OPTIONAL_LOCKS: "0" }) }); found = true; }
    catch (error) { failure = error; }
    if (found) throw new Error("Git HEAD names a branch with an unreadable commit; repair the repository before onboarding.");
    if ((failure as NodeJS.ErrnoException & { status?: number } | undefined)?.status !== 1)
      throw new Error(`Could not verify the unborn Git branch: ${clean((failure as Error | undefined)?.message ?? "Git inspection failed")}.`);
    return { commit: "", branch };
  }
}
function canonicalRoot(directory: string) {
  const path = realpathSync(directory);
  if (!statSync(path).isDirectory()) throw new Error("Choose a repository directory.");
  const root = realpathSync(git(path, ["rev-parse", "--show-toplevel"]));
  if (root === realpathSync(homedir()) || root === dirname(root)) throw new Error("Run this inside a project repository; the home directory and filesystem root are not supported.");
  return root;
}
function canonicalDirectory(directory: string) {
  const path = realpathSync(directory);
  if (!statSync(path).isDirectory()) throw new Error("Choose a directory.");
  if (path === realpathSync(homedir()) || path === dirname(path)) throw new Error("The home directory and filesystem root are not supported.");
  return path;
}
function gitRootOrNonGit(directory: string): { root: string } | { nonGit: true } {
  let stderr = "";
  let reportedRoot = "";
  try {
    reportedRoot = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], env: gitEnv({ GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }) }).trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
    stderr = String(failure.stderr ?? "");
    if (!/not a git repository/i.test(stderr))
      throw new Error(`Could not inspect Git metadata for ${directory}: ${clean(stderr || failure.message)}.`);
  }
  if (reportedRoot) {
    let root: string;
    try { root = realpathSync(reportedRoot); }
    catch (error) { throw new Error(`Git reported an inaccessible repository root: ${clean((error as Error).message)}.`); }
    if (!statSync(root).isDirectory()) throw new Error("Git reported a repository root that is not a directory.");
    if (root === realpathSync(homedir()) || root === dirname(root)) throw new Error("The home directory and filesystem root are not supported.");
    return { root };
  }
  // Git can describe a broken or inaccessible repository as "not a git repository".
  // A .git marker anywhere on the ancestor chain means the directory is not a plain folder.
  for (let current = directory; ; current = dirname(current)) {
    try {
      const marker = join(current, ".git");
      const markerStat = lstatSync(marker);
      if (markerStat) throw new Error(`Git metadata exists at ${marker}, but Git cannot read it. Repair or remove that metadata before continuing.`);
    } catch (error) {
      if (error instanceof Error && /Git metadata exists/.test(error.message)) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new Error(`Could not inspect Git metadata in ${current}: ${clean((error as Error).message)}.`);
    }
    if (current === dirname(current)) break;
  }
  return { nonGit: true };
}
function readDirectoryDefaults(path: string) {
  const raw = readPrivateJson(path, { version: 1, directories: {} });
  const parsed = directoryDefaultsSchema.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data?.directories ?? {}).some(directory => !isAbsolute(directory) || resolve(directory) !== directory || directory === dirname(directory) || directory === realpathSync(homedir())))
    throw new Error("Saved directory Linear defaults are invalid; preserve private team CLI state and inspect it before retrying.");
  return parsed.data;
}
async function saveDirectoryDefault(path: string, directory: string, value: { teamId: string; projectId?: string }) {
  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let locked = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { mkdirSync(lockPath, { mode: 0o700 }); locked = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await delay(100);
    }
  }
  if (!locked) throw new Error("Timed out waiting for directory Linear defaults to be updated. Retry after the other repo init finishes.");
  try {
    const current = readDirectoryDefaults(path);
    current.directories[directory] = value;
    privateJson(path, current);
  } finally {
    try { rmdirSync(lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function nearestDirectoryDefault(defaults: z.infer<typeof directoryDefaultsSchema>, directory: string) {
  for (let current = directory; ; current = dirname(current)) {
    const value = defaults.directories[current];
    if (value) return { ...value, origin: current };
    if (current === dirname(current)) break;
  }
  return undefined;
}
export function boundTeamProject(config: ClientConfig, configPath: string, directory = process.cwd()): string | undefined {
  let root: string;
  try {
    root = canonicalRoot(directory);
  } catch { return undefined; }
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const file = join(dirname(configPath), "team-cli", identity, "repo-mappings.json");
  const stored = (readPrivateJson(file, {}) as Record<string, unknown>)[`${config.origin}\n${root}`];
  const projectId = typeof stored === "string" ? stored : (stored as { projectId?: unknown } | undefined)?.projectId;
  if (projectId === undefined) return undefined;
  if (typeof projectId !== "string" || !projectIdPattern.test(projectId)) throw new Error("Saved repository binding is invalid; inspect private team CLI state before launching.");
  return projectId;
}
export function forgetBoundTeamProject(config: ClientConfig, configPath: string, projectId: string): void {
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const file = join(dirname(configPath), "team-cli", identity, "repo-mappings.json");
  const mappings = readPrivateJson(file, {}) as Record<string, unknown>;
  let changed = false;
  for (const [key, value] of Object.entries(mappings)) {
    const bound = typeof value === "string" ? value : (value as { projectId?: unknown } | undefined)?.projectId;
    if (bound === projectId) { delete mappings[key]; changed = true; }
  }
  if (changed) privateJson(file, mappings);
}
function commandArray(text: string, flag: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${flag} must contain a JSON command array.`); }
  if (!Array.isArray(value)) throw new Error(`${flag} must contain a JSON command array.`);
  return value.map(item => commandSchema.parse(item));
}
function inferredProjectConfig(root: string, options: Options, allowUnconfiguredChecks = false) {
  const pkgFile = join(root, "package.json");
  let pkg: { scripts?: Record<string, unknown> } | undefined;
  try { pkg = JSON.parse(readFileSync(pkgFile, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("package.json is unreadable; supply explicit setup and check JSON.");
  }
  const hasLock = ["package-lock.json", "npm-shrinkwrap.json"].some(name => { try { return statSync(join(root, name)).isFile(); } catch { return false; } });
  const setup = options["--setup-json"] !== undefined ? commandArray(String(options["--setup-json"]), "--setup-json") : hasLock ? [{ command: "npm", args: ["ci"] }] : [];
  const checks = options["--check-json"] !== undefined ? commandArray(String(options["--check-json"]), "--check-json") : pkg?.scripts?.check ? [{ command: "npm", args: ["run", "check"] }] : [];
  if (!checks.length && !allowUnconfiguredChecks) throw new Error("No package check script was found. Supply --check-json with a JSON array of command objects.");
  if (setup.length > 1) throw new Error("--setup-json contains one setup command at most.");
  return projectConfigSchema.parse({ ...(setup[0] ? { setup: setup[0] } : {}), checks, ...(!checks.length ? { establishChecks: true } : {}) });
}
function outputTeam(team: any, json: boolean) {
  if (json) { console.log(JSON.stringify(team, null, 2)); return; }
  console.log(`${clean(team.id)}  ${clean(team.status)}  ${clean(team.title)}`);
  console.log(`Project ${clean(team.projectId)} · workspace ${clean(team.workspace)} · branch ${clean(team.branch)}`);
  if (team.linear?.issue?.url) console.log(`Linear ${clean(team.linear.issue.url)}`);
  else if (team.linear?.url) console.log(`Linear ${clean(team.linear.url)}`);
  if (team.reason) console.log(`Reason: ${clean(team.reason)}`);
  for (const question of team.decisions ?? []) if (!question.answer) console.log(`Question ${clean(question.id)}: ${clean(question.question)}`);
}
function receipt(path: string, key: string, body: unknown) {
  const records = readPrivateJson(path, {}) as Record<string, unknown>;
  const record = { requestId: (body as { requestId: string }).requestId, body, createdAt: new Date().toISOString(), state: "pending" };
  records[key] = record;
  privateJson(path, records);
}
function shellQuote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'`; }
function requireSamePendingIntent(path: string, prefix: string, endpoint: string, intent: (body: any) => boolean, requestId: string | undefined, rawArgs: string[]) {
  const records = readPrivateJson(path, {}) as Record<string, any>;
  const prior = Object.entries(records).find(([key, value]) => key.startsWith(prefix) && value?.state === "pending" && value.endpoint === endpoint && intent(value.body));
  if (!prior) return;
  if (requestId === prior[1].requestId) return;
  const commandArgs = rawArgs.filter((value, index) => value !== "--request-id" && rawArgs[index - 1] !== "--request-id");
  const retry = `infinite ${[...commandArgs, "--request-id", prior[1].requestId].map(shellQuote).join(" ")}`;
  throw new Error(`An earlier request has an uncertain result. Inspect the current state first. If this is the same operation, retry with its saved request ID: ${retry}`);
}
async function postMutation(api: Api, receiptPath: string, key: string, endpoint: string, body: Record<string, unknown>, method = "POST", logRequest = true) {
  const records = readPrivateJson(receiptPath, {}) as Record<string, any>;
  const prior = records[key];
  if (prior?.requestId === body.requestId) {
    if (prior.endpoint !== endpoint || prior.method !== method) throw new Error("This request ID was already used for a different mutation.");
    if (prior.state === "confirmed") {
      const readPath = method === "PUT" ? endpoint : endpoint === "/teams" ? `/teams/${prior.resultId}` : `/${endpoint.split("/").filter(Boolean).slice(0, 2).join("/")}`;
      return api.json<any>(readPath);
    }
    body = prior.body;
  } else {
    records[key] = { requestId: body.requestId, endpoint, method, body, createdAt: new Date().toISOString(), state: "pending" };
    privateJson(receiptPath, records);
  }
  if (logRequest) process.stderr.write(`[Infinite] Request ${String(body.requestId)}\n`);
  const result = await api.json<any>(endpoint, body, undefined, undefined, method);
  records[key] = { ...records[key], state: "confirmed", resultId: result.id };
  privateJson(receiptPath, records);
  return result;
}

async function uploadCommit(api: Api, projectId: string, root: string, commit: string, tempStore: string, captured: (manifestId: string) => void) {
  const detail = await api.json<any>(`/projects/${projectId}`);
  if (detail.sync?.pendingGeneration) throw new Error("The cloud project has a pending sync generation. Resolve it before capturing local source.");
  const cloned = mkdtempSync(join(tmpdir(), "infinite-team-source-"));
  rmSync(cloned, { recursive: true, force: true });
  const source = join(cloned, "repo");
  try {
    const env = isolatedGitEnv();
    execFileSync("git", ["clone", "--template=", "--no-local", "--no-hardlinks", "--no-checkout", root, source], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "ignore", "pipe"], env });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", source, "checkout", "--detach", commit], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "ignore", "pipe"], env });
    try { execFileSync("git", ["-C", source, "remote", "remove", "origin"], { stdio: "ignore", timeout: 5000, env }); } catch { /* No remote is safe. */ }
    const cwd = realpathSync(source);
    const manifest = await captureWorkspace({ roots: [cwd], cwd, storeDir: tempStore });
    captured(manifest.id);
    const { generation } = await api.json<{ generation: string }>(`/projects/${projectId}/sync/begin`, {});
    const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
    for (let offset = 0; offset < hashes.length; offset += 512) {
      const batch = hashes.slice(offset, offset + 512);
      const { missing } = await api.json<{ missing: string[] }>(`/projects/${projectId}/sync/has`, { hashes: batch });
      if (!Array.isArray(missing) || missing.some(hash => !batch.includes(hash))) throw new Error("Host returned an invalid source upload request.");
      for (const hash of missing) {
        const bytes = Buffer.from(await readWorkspaceBlob(tempStore, hash), "base64");
        const response = await api.request(`/projects/${projectId}/sync/blob/${hash}`, bytes, undefined, { "Content-Type": "application/octet-stream" }, "PUT");
        await response.body?.cancel();
      }
    }
    const commitResponse = await api.request(`/projects/${projectId}/sync/commit`, { generation, manifest }, AbortSignal.timeout(300000));
    const committed = await commitResponse.json() as any;
    const current = await api.json<any>(`/projects/${projectId}`);
    return { manifestId: manifest.id, committed, sync: current.sync };
  } finally { rmSync(cloned, { recursive: true, force: true }); }
}

async function uploadEmptyBaseline(api: Api, projectId: string, sourceRoot: string, tempStore: string, captured: (manifestId: string) => void) {
  const baseline = mkdtempSync(join(tmpdir(), "infinite-team-empty-baseline-"));
  try {
    const objectFormat = git(sourceRoot, ["rev-parse", "--show-object-format=storage"]);
    if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Git reported an unsupported object format.");
    const neutralEnv = isolatedGitEnv({
      GIT_AUTHOR_NAME: "Infinite",
      GIT_AUTHOR_EMAIL: "baseline@infinite.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Infinite",
      GIT_COMMITTER_EMAIL: "baseline@infinite.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    execFileSync("git", ["init", "--quiet", "--template=", "--initial-branch=main", `--object-format=${objectFormat}`], { cwd: baseline, stdio: "ignore", timeout: 10000, env: neutralEnv });
    execFileSync("git", ["-c", "user.name=Infinite", "-c", "user.email=baseline@infinite.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", baseline, "commit", "--allow-empty", "-m", "Initial empty cloud baseline"], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 10000, env: neutralEnv });
    const commit = execFileSync("git", ["-C", baseline, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], env: neutralEnv }).trim();
    return await uploadCommit(api, projectId, baseline, commit, tempStore, captured);
  } finally { rmSync(baseline, { recursive: true, force: true }); }
}

export async function handleTeamClientCommand(command: "repo" | "team", positional: string[], options: Options, config: ClientConfig, api: Api, configPath: string, rawArgs: string[]): Promise<boolean> {
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const stateDir = join(dirname(configPath), "team-cli", identity);
  const mappingsPath = join(stateDir, "repo-mappings.json"), receiptsPath = join(stateDir, "receipts.json");
  if (command === "repo") {
    if (positional[0] !== "init" || positional.length > 2) throw new Error("Usage: infinite repo init [DIRECTORY] [--project ID] [--setup-json JSON] [--check-json JSON] [--linear-team UUID] [--linear-project UUID]");
    const requestedDirectory = canonicalDirectory(positional[1] ?? process.cwd());
    const gitResult = gitRootOrNonGit(requestedDirectory);
    const defaultsPath = join(stateDir, "directory-defaults.json");
    const directoryDefaults = readDirectoryDefaults(defaultsPath);
    const inheritedDefault = nearestDirectoryDefault(directoryDefaults, requestedDirectory);
    const explicitLinearTeam = options["--linear-team"] === undefined ? undefined : z.uuid().parse(String(options["--linear-team"]));
    const explicitLinearProject = options["--linear-project"] === undefined ? undefined : z.uuid().parse(String(options["--linear-project"]));
    if ("nonGit" in gitResult) {
      const unsupported = ["--project", "--setup-json", "--check-json", "--handoff", "--request-id"].filter(flag => options[flag] !== undefined);
      if (unsupported.length) throw new Error(`This directory is not a Git repository, so ${unsupported.join(", ")} cannot be used here. Run repo init in a Git repository for enrollment, or use only --linear-team and --linear-project to save directory defaults.`);
      if (!explicitLinearTeam && explicitLinearProject && !inheritedDefault?.teamId)
        throw new Error("--linear-project requires --linear-team or an inherited directory Linear team.");
      if (!explicitLinearTeam && !explicitLinearProject && !inheritedDefault)
        throw new Error("This directory has no inherited Linear defaults. Set them once with --linear-team UUID and --linear-project UUID.");
      const teamId = explicitLinearTeam ?? inheritedDefault!.teamId;
      const projectId = explicitLinearProject ?? (inheritedDefault?.teamId === teamId ? inheritedDefault.projectId : undefined);
      await saveDirectoryDefault(defaultsPath, requestedDirectory, { teamId, ...(projectId ? { projectId } : {}) });
      const inheritedUsed = (!explicitLinearTeam && !explicitLinearProject)
        || (!explicitLinearTeam && Boolean(explicitLinearProject) && inheritedDefault?.teamId === teamId)
        || (Boolean(explicitLinearTeam) && !explicitLinearProject && Boolean(inheritedDefault?.projectId) && inheritedDefault?.teamId === teamId && inheritedDefault.projectId === projectId);
      const defaultsFrom = inheritedUsed && inheritedDefault ? inheritedDefault.origin : requestedDirectory;
      console.log(JSON.stringify({ kind: "directory", path: requestedDirectory, linear: { teamId, ...(projectId ? { projectId } : {}) }, defaultsFrom }, null, 2));
      return true;
    }
    const root = gitResult.root;
    const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
    if (status) throw new Error("Repository must be clean before onboarding. Commit or remove tracked and untracked changes first.");
    const head = inspectSourceHead(root);
    const sourceRevision = head.commit || "unborn";
    const repoConfig = inferredProjectConfig(root, options, !head.commit && options["--check-json"] === undefined);
    const requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
    const linearTeam = explicitLinearTeam;
    const linearProject = explicitLinearProject;
    const handoff = String(options["--handoff"] ?? "auto");
    if (handoff !== "auto" && handoff !== "off") throw new Error("--handoff must be auto or off.");
    const me = await api.json<any>("/me");
    if (me.teams?.repoEnrollment !== 1) throw new Error("This host does not support repository enrollment. Upgrade the host before running repo init.");
    const mappings = readPrivateJson(mappingsPath, {}) as Record<string, unknown>;
    const key = `${config.origin}\n${root}`;
    const stored = mappings[key];
    const storedProject = typeof stored === "string" ? stored : (stored as { projectId?: unknown } | undefined)?.projectId;
    const explicitProject = options["--project"] !== undefined;
    const localSource = !explicitProject && !storedProject;
    const project = localSource ? await api.json<{ id: string; name: string; path: string }>("/projects/resolve", { path: localProjectPath(root) }) : undefined;
    const selected = String(options["--project"] ?? storedProject ?? project?.id ?? "");
    if (!projectIdPattern.test(selected)) throw new Error("Invalid project ID.");
    const target = await api.json<any>(`/projects/${selected}/team`);
    if (!target.hostSetup?.ready) throw new Error(`Host team configuration is incomplete: ${clean((target.hostSetup?.missing ?? ["teams.workspaceDir"]).join(", "))}. Configure the host before enrolling a repository.`);
    const detail = await api.json<any>(`/projects/${selected}`);
    const sourceKind = explicitProject ? "project" : localSource ? "local" : (stored as { source?: string } | undefined)?.source ?? "project";
    const preserveTargetChecks = Boolean(repoConfig.establishChecks && target.team?.checks?.length);
    const projectConfig = projectConfigSchema.parse(preserveTargetChecks
      ? { ...(options["--setup-json"] !== undefined ? (repoConfig.setup ? { setup: repoConfig.setup } : {}) : target.team.setup ? { setup: target.team.setup } : {}), checks: target.team.checks }
      : repoConfig);
    if (projectConfig.establishChecks && me.teams?.establishChecks !== 1)
      throw new Error("This host does not support establishing team checks for an empty repository. Upgrade the host before running repo init.");
    const uploadKey = `${key}:source-upload:${selected}:${sourceRevision}`;
    const assertSourceUnchanged = () => {
      if (git(root, ["status", "--porcelain", "--untracked-files=all"]) !== status)
        throw new Error("The source repository changed during onboarding. No team configuration was written; inspect it and retry.");
      const current = inspectSourceHead(root);
      if (current.commit !== head.commit || current.branch !== head.branch)
        throw new Error("Git HEAD changed during onboarding. No team configuration was written; inspect it and retry.");
    };
    const records = readPrivateJson(receiptsPath, {}) as Record<string, any>;
    let sourceReceipt = records[uploadKey];
    if (sourceKind === "local" && sourceReceipt?.state === "pending-apply") {
      if (!detail.sync?.pendingGeneration && detail.sync?.appliedManifest === sourceReceipt.manifestId) {
        sourceReceipt = { ...sourceReceipt, state: "confirmed" };
        records[uploadKey] = sourceReceipt; privateJson(receiptsPath, records);
      } else {
        const reason = clean(detail.sync?.pendingGeneration?.reason ?? "sync-state-changed");
        throw new Error(`The source snapshot is not applied (${reason}). No team configuration was written. After the project is safe to apply, run infinite sync --apply --project ${selected}, then rerun repo init for this directory with --request-id ${sourceReceipt.requestId}. Do not force apply over cloud changes.`);
      }
    }
    const uploadSource = sourceKind === "local" && !detail.sync?.appliedManifest && sourceReceipt?.state !== "confirmed";
    if (uploadSource && detail.sync?.pendingGeneration) throw new Error("The cloud project has a pending sync generation. Resolve it before capturing local source.");
    if (uploadSource) {
      const state = readSyncState(join(dirname(configPath), "sync", `${selected}.json`));
      if (state && syncServiceRunning(state) && state.origin === config.origin && state.root === root)
        throw new Error("Continuous sync is active for this checkout. Stop it before one-time team source capture.");
    }
    const rootDefault = nearestDirectoryDefault(directoryDefaults, root);
    const targetLinear = target.linear?.teamId ? { teamId: target.linear.teamId, ...(target.linear.projectId ? { projectId: target.linear.projectId } : {}) } : undefined;
    let effectiveLinear = targetLinear;
    let linearDefaultsFrom: string | undefined;
    if (linearTeam) {
      const retainedProject = linearTeam === targetLinear?.teamId ? targetLinear.projectId : linearTeam === rootDefault?.teamId ? rootDefault.projectId : undefined;
      effectiveLinear = { teamId: linearTeam, ...(linearProject ? { projectId: linearProject } : retainedProject ? { projectId: retainedProject } : {}) };
      if (!linearProject && !targetLinear?.projectId && rootDefault?.teamId === linearTeam && retainedProject) linearDefaultsFrom = rootDefault.origin;
    } else if (linearProject) {
      const teamId = targetLinear?.teamId ?? rootDefault?.teamId;
      if (!teamId) throw new Error("--linear-project requires an existing target Linear team or inherited directory Linear team.");
      effectiveLinear = { teamId, projectId: linearProject };
      if (!targetLinear?.teamId) linearDefaultsFrom = rootDefault?.origin;
    } else if (!targetLinear && rootDefault) {
      effectiveLinear = { teamId: rootDefault.teamId, ...(rootDefault.projectId ? { projectId: rootDefault.projectId } : {}) };
      linearDefaultsFrom = rootDefault.origin;
    }
    const sendLinear = Boolean(linearTeam || linearProject || (!targetLinear && rootDefault));
    const body: Record<string, any> = { requestId, revision: target.revision, team: { ...projectConfig, handoff }, ...(sendLinear && effectiveLinear ? { linear: effectiveLinear } : {}) };
    // After a lost reply, inherited settings may already be the host's mapping.
    // An omitted mapping preserves that value; compare that intent while replay
    // still sends the original receipt body and request ID unchanged.
    const linearIntent = (request: Record<string, any>) => request.linear === undefined ? targetLinear ?? null : request.linear;
    requireSamePendingIntent(receiptsPath, `${key}:repo-init:`, `/projects/${selected}/team`, prior => JSON.stringify(prior.team) === JSON.stringify(body.team) && JSON.stringify(linearIntent(prior)) === JSON.stringify(linearIntent(body)), options["--request-id"] === undefined ? undefined : requestId, rawArgs);
    if (uploadSource) {
      assertSourceUnchanged();
      process.stderr.write(`[Infinite] Request ${requestId}\n`);
      const temp = mkdtempSync(join(tmpdir(), "infinite-team-blobs-"));
      sourceReceipt = readPrivateJson(receiptsPath, {})[uploadKey];
      if (sourceReceipt?.state === "pending") {
        rmSync(temp, { recursive: true, force: true });
        throw new Error("A prior source upload has an uncertain result. Inspect the cloud project before attempting another capture.");
      }
      const alreadyUploaded = sourceReceipt?.state === "confirmed";
      if (!alreadyUploaded) receipt(receiptsPath, uploadKey, { requestId, projectId: selected, commit: sourceRevision });
      try {
        if (!alreadyUploaded) {
          const captured = (manifestId: string) => {
            const prepared = readPrivateJson(receiptsPath, {}) as Record<string, any>;
            prepared[uploadKey] = { ...prepared[uploadKey], manifestId };
            privateJson(receiptsPath, prepared);
          };
          const result = head.commit
            ? await uploadCommit(api, selected, root, head.commit, join(temp, "objects"), captured)
            : await uploadEmptyBaseline(api, selected, root, join(temp, "objects"), captured);
          if (result.committed.pendingGeneration || result.committed.appliedManifest !== result.manifestId || result.sync?.pendingGeneration || result.sync?.appliedManifest !== result.manifestId) {
            const reason = clean(result.sync?.pendingGeneration?.reason ?? result.committed.pendingGeneration?.reason ?? "not-applied");
            const pending = readPrivateJson(receiptsPath, {}) as Record<string, any>;
            pending[uploadKey] = { ...pending[uploadKey], state: "pending-apply", pendingReason: reason };
            privateJson(receiptsPath, pending);
            throw new Error(`The source snapshot is pending (${reason}); repo init stopped before team configuration. After the project is safe to apply, run infinite sync --apply --project ${selected}, then rerun repo init for this directory with --request-id ${requestId}. Do not force apply over cloud changes.`);
          }
          const completed = readPrivateJson(receiptsPath, {}) as Record<string, any>;
          completed[uploadKey] = { ...completed[uploadKey], state: "confirmed" };
          privateJson(receiptsPath, completed);
        }
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    assertSourceUnchanged();
    await postMutation(api, receiptsPath, `${key}:repo-init:${requestId}`, `/projects/${selected}/team`, body, "PUT", !uploadSource);
    const output = await api.json<any>(`/projects/${selected}/team`);
    mappings[key] = { projectId: selected, source: sourceKind }; privateJson(mappingsPath, mappings);
    if (output.linear?.teamId) {
      await saveDirectoryDefault(defaultsPath, root, { teamId: z.uuid().parse(output.linear.teamId), ...(output.linear.projectId ? { projectId: z.uuid().parse(output.linear.projectId) } : {}) });
    }
    if (explicitProject || uploadSource) { config.projectId = selected; privateJson(configPath, config); }
    const source = uploadSource && !head.commit ? "empty cloud baseline" : uploadSource ? `local commit ${head.commit}` : detail.sync?.appliedManifest ? "existing cloud checkout retained" : "configured project checkout";
    console.log(JSON.stringify({ kind: "repository", id: selected, name: clean(output.name), path: clean(output.path), team: output.team, linear: output.linear, revision: output.revision, execution: output.execution, ...(linearDefaultsFrom ? { linearDefaultsFrom } : {}), source }, null, 2));
    return true;
  }
  const [subcommand, id, ...rest] = positional;
  if (subcommand === "start") {
    if (rest.length) throw new Error("Usage: infinite team start [OBJECTIVE] [--prd FILE] [--provider PROVIDER]");
    const prd = options["--prd"] === undefined ? "" : readFileSync(String(options["--prd"]), "utf8");
    const objective = [id ?? "", prd].filter(Boolean).join("\n\n").trim();
    if (!objective) throw new Error("Provide an objective or --prd FILE.");
    const projectId = String(options["--project"] ?? (() => {
      const root = canonicalRoot(process.cwd()), mappings = readPrivateJson(mappingsPath, {}) as Record<string, unknown>;
      const entry = mappings[`${config.origin}\n${root}`];
      return typeof entry === "string" ? entry : (entry as { projectId?: string } | undefined)?.projectId ?? "";
    })());
    if (!projectIdPattern.test(projectId)) throw new Error("No repository project is bound to this directory. Run infinite repo init or use --project ID.");
    const project = await api.json<any>(`/projects/${projectId}/team`);
    if (!project.hostSetup?.ready) throw new Error(`Host team configuration is incomplete: ${clean((project.hostSetup?.missing ?? ["teams.workspaceDir"]).join(", "))}. Configure the host before starting a team.`);
    if (!project.team?.checks?.length && project.team?.establishChecks !== true) throw new Error("Team setup is missing. Run infinite repo init with setup/check commands before starting a team.");
    const me = await api.json<any>("/me");
    const provider = String(options["--provider"] ?? me.teams?.lineup?.coordinator?.provider ?? "");
    if (!provider) throw new Error("The host has no configured team lineup. Set one up on the host or use --provider PROVIDER for a single-provider team.");
    const requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
    const body = createTeamSchema.parse({ requestId, projectId, provider, useConfiguredLineup: options["--provider"] === undefined, title: String(options["--title"] ?? objective.split("\n")[0].slice(0, 100)), objective, parallelism: 2 });
    requireSamePendingIntent(receiptsPath, "team-start:", "/teams", prior => prior.projectId === body.projectId && prior.provider === body.provider && prior.useConfiguredLineup === body.useConfiguredLineup && prior.title === body.title && prior.objective === body.objective, options["--request-id"] === undefined ? undefined : requestId, rawArgs);
    const team = await postMutation(api, receiptsPath, `team-start:${requestId}`, "/teams", body);
    outputTeam(team, Boolean(options["--json"])); return true;
  }
  if (subcommand === "status" || subcommand === "watch") {
    if (subcommand === "watch" && !id) throw new Error("Usage: infinite team watch ID");
    if (id && rest.length) throw new Error(`Usage: infinite team ${subcommand} [ID]`);
    const abort = new AbortController(), stop = () => abort.abort();
    process.once("SIGINT", stop);
    try {
      do {
        const teams = id ? [await api.json<any>(`/teams/${id}`, undefined, abort.signal)] : (await api.json<{ teams: any[] }>("/teams", undefined, abort.signal)).teams;
        if (options["--json"]) console.log(JSON.stringify(id ? teams[0] : teams, null, subcommand === "watch" ? undefined : 2));
        else for (const team of teams) outputTeam(team, false);
        if (subcommand !== "watch") break;
        await delay(2000, undefined, { signal: abort.signal });
      } while (!abort.signal.aborted);
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally { process.off("SIGINT", stop); }
    return true;
  }
  if (["steer", "answer", "pause", "resume", "cancel"].includes(subcommand ?? "")) {
    if (!id) throw new Error(`Usage: infinite team ${subcommand} ID ...`);
    const current = await api.json<any>(`/teams/${id}`);
    const requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
    let endpoint = `/teams/${id}/${subcommand}`, body: Record<string, unknown>;
    if (subcommand === "steer") {
      const text = rest.join(" "); if (!text) throw new Error("Provide steering text.");
      body = { requestId, revision: current.revision, text };
    } else if (subcommand === "answer") {
      const [questionId, ...answer] = rest, text = answer.join(" ");
      if (!questionId || !text) throw new Error("Usage: infinite team answer ID QUESTION_ID TEXT");
      endpoint = `/teams/${id}/decisions/${questionId}/answer`; body = { requestId, revision: current.revision, text };
    } else {
      if (rest.length) throw new Error(`Usage: infinite team ${subcommand} ID`);
      body = { requestId, revision: current.revision };
    }
    requireSamePendingIntent(receiptsPath, `team-${subcommand}:`, endpoint, prior => subcommand === "steer" || subcommand === "answer" ? prior.text === body.text : true, options["--request-id"] === undefined ? undefined : requestId, rawArgs);
    outputTeam(await postMutation(api, receiptsPath, `team-${subcommand}:${requestId}`, endpoint, body), Boolean(options["--json"])); return true;
  }
  throw new Error("Usage: infinite team start|status|watch|steer|answer|pause|resume|cancel ...");
}
