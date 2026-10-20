import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createTeamSchema, gitBranchSchema, githubRepositorySchema, teamDeliverySchema, teamPermissionsSchema, type ProjectSource, type TeamDelivery } from "./team-types.js";
import { describeSource } from "./client.js";
import type { ProjectSourceStatus } from "./project-source.js";
import { captureWorkspace } from "./workspace-checkpoint.js";
import { uploadMissingChunks } from "./chunk-upload.js";
import { localProjectPath } from "./mirrored-projects.js";
import { readSyncState, syncServiceRunning } from "./sync-service.js";
import { canAskForBrief, chooseTeamBrief, failedTeamBriefRow, orderedTeamMembers, summaryMember, teamLogsText, teamMonitorText, teamSummaryText, teamWatchCommand, teamWatchFrame, teamWatchScreen, wrapText, type TeamBriefRow, type TeamBriefStatus, type TeamWatchCommand } from "./team-watch.js";

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
function gitStatus(cwd: string, args: string[]) {
  try { execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"], env: isolatedGitEnv({ LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" }) }); return 0; }
  catch (error) { return (error as NodeJS.ErrnoException & { status?: number }).status ?? 128; }
}
function inferGitHubRepository(root: string): string {
  let remote: string;
  try { remote = git(root, ["config", "--get", "remote.origin.url"]); }
  catch { throw new Error("Could not infer a GitHub repository from origin; supply --repository OWNER/REPO."); }
  let ownerRepo: string | undefined;
  if (/^git@github\.com:[^/?#]+\/[^/?#]+$/.test(remote)) ownerRepo = remote.slice("git@github.com:".length);
  else {
    try {
      const url = new URL(remote);
      if ((url.protocol === "https:" || url.protocol === "ssh:") && url.hostname === "github.com" && !url.port && !url.search && !url.hash &&
        !url.password && (url.protocol === "https:" ? !url.username : url.username === "git")) {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length === 2) ownerRepo = parts.join("/");
      }
    } catch { /* The bounded error below avoids echoing remote URLs or credentials. */ }
  }
  if (ownerRepo?.endsWith(".git")) ownerRepo = ownerRepo.slice(0, -4);
  const parsed = githubRepositorySchema.safeParse(ownerRepo);
  if (!parsed.success) throw new Error("Git origin must be an HTTPS or SSH github.com OWNER/REPO URL without credentials; supply --repository OWNER/REPO.");
  return parsed.data;
}
function inferBaseBranch(root: string): string {
  let ref: string | undefined;
  try { ref = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]); } catch { /* Fall back only to a local main/master branch. */ }
  if (ref !== undefined) {
    const prefix = "refs/remotes/origin/";
    if (!ref.startsWith(prefix) || ref.length === prefix.length)
      throw new Error("origin/HEAD does not name an origin branch; supply --base-branch BRANCH.");
    const branch = ref.slice(prefix.length);
    return gitBranchSchema.parse(branch);
  }
  let branch: string | undefined;
  try { branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]); } catch { /* Detached HEAD requires explicit configuration. */ }
  if (branch === "main" || branch === "master") return branch;
  throw new Error("Could not infer the default branch from origin/HEAD or a local main/master branch; supply --base-branch BRANCH.");
}
export function inferProjectSource(root: string, option: string | undefined): ProjectSource {
  if (option === "laptop") return { mode: "laptop" };
  if (option === "github") return { mode: "github", repository: inferGitHubRepository(root), baseBranch: inferBaseBranch(root) };
  if (option !== undefined) throw new Error("--source must be github or laptop.");
  try {
    return { mode: "github", repository: inferGitHubRepository(root), baseBranch: inferBaseBranch(root) };
  } catch {
    return { mode: "laptop" };
  }
}

export function requestedDelivery(root: string, options: Options, current: { revision: number; team?: { delivery?: TeamDelivery } }): TeamDelivery | undefined {
  const mode = options["--delivery"] === undefined ? undefined : String(options["--delivery"]);
  if (mode === undefined) {
    if (options["--merge-method"] !== undefined) throw new Error("--merge-method requires --delivery merge.");
    if (options["--repository"] !== undefined || options["--base-branch"] !== undefined)
      throw new Error("--repository and --base-branch require --delivery merge or pr.");
    return current.revision > 0 ? current.team?.delivery : undefined;
  }
  if (mode !== "merge" && mode !== "pr" && mode !== "review") throw new Error("--delivery must be merge, pr, or review.");
  if (mode === "review") {
    if (options["--merge-method"] !== undefined) throw new Error("--merge-method applies only to --delivery merge.");
    if (options["--repository"] !== undefined || options["--base-branch"] !== undefined)
      throw new Error("--repository and --base-branch apply only to --delivery merge or pr.");
    return undefined;
  }
  if (mode === "pr" && options["--merge-method"] !== undefined)
    throw new Error("--merge-method applies only to --delivery merge.");
  const retained = current.revision > 0 ? current.team?.delivery : undefined;
  const repository = options["--repository"] === undefined ? retained?.repository ?? inferGitHubRepository(root) : String(options["--repository"]);
  const baseBranch = options["--base-branch"] === undefined ? retained?.baseBranch ?? inferBaseBranch(root) : String(options["--base-branch"]);
  if (mode === "pr") return teamDeliverySchema.parse({ mode, repository, baseBranch });
  return teamDeliverySchema.parse({
    mode,
    repository,
    baseBranch,
    mergeMethod: options["--merge-method"] === undefined ? (retained?.mode === "merge" ? retained.mergeMethod : undefined) : String(options["--merge-method"]),
  });
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
function canonicalTeamworkPath(value: string, cwd: string, repository: string) {
  const requested = resolve(cwd, value);
  let ancestor = requested;
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("The teamwork path has no existing ancestor.");
    missing.unshift(basename(ancestor)); ancestor = parent;
  }
  const canonical = join(realpathSync(ancestor), ...missing);
  const home = realpathSync(homedir());
  const homeRelative = relative(home, canonical);
  if (!homeRelative || homeRelative === ".." || homeRelative.startsWith(`..${sep}`) || isAbsolute(homeRelative))
    throw new Error("The teamwork folder must be below the local home directory.");
  const repoRel = relative(repository, canonical), targetRel = relative(canonical, repository);
  const within = (path: string) => path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  if (within(repoRel) || within(targetRel)) throw new Error("The teamwork folder must be outside and separate from the repository.");
  return localProjectPath(canonical);
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
type BriefRow = TeamBriefRow;

function eventLine(event: { type?: string; data?: Record<string, unknown> }) {
  const data = event.data ?? {};
  const label = event.type === "signal" ? String(data.kind ?? "Signal")
    : event.type === "input-result" ? (data.state === "delivered" ? "Input delivered" : "Input")
    : event.type === "lifecycle" ? String(data.status ?? "Session updated")
    : String(event.type ?? "Event");
  const detail = data.message ?? data.text ?? data.error;
  return typeof detail === "string" && detail.trim() ? `${label}: ${detail}` : label;
}

async function teamBriefRows(api: Api, team: any, signal: AbortSignal, previous: BriefRow[] = []): Promise<BriefRow[]> {
  const ordered = orderedTeamMembers(team).filter(member => member?.sessionId);
  const current = ordered.filter(member => member?.revision === team?.revision);
  const targets = (current.length ? current : ordered).slice(0, 6);
  return Promise.all(targets.map(async member => {
    const sessionId = String(member.sessionId);
    try {
      return { sessionId, status: await api.json<TeamBriefStatus>(`/sessions/${sessionId}/summary?status=1`, undefined, signal) };
    } catch (error) {
      if (signal.aborted) throw error;
      return failedTeamBriefRow(sessionId, clean((error as Error).message), previous);
    }
  }));
}

async function memberLog(api: Api, member: any, signal: AbortSignal) {
  const sessionId = String(member.sessionId);
  const detail = await api.json<{ screen?: string; seq?: number }>(`/sessions/${sessionId}`, undefined, signal);
  const after = Math.max(0, Number(detail?.seq ?? 0) - 80);
  const page = await api.json<{ events?: { at?: string; type?: string; data?: Record<string, unknown> }[] }>(
    `/sessions/${sessionId}/events?after=${after}&types=lifecycle,signal,input-result&limit=80`,
    undefined,
    signal,
  );
  return { screen: detail?.screen, events: (page.events ?? []).map(event => ({ at: event.at, text: eventLine(event) })) };
}

function shiftMember(members: any[], memberId: string, direction: 1 | -1) {
  const index = members.findIndex(member => member?.memberId === memberId);
  if (index < 0) return String(members[0]?.memberId ?? "");
  return String(members[(index + direction + members.length) % members.length]?.memberId ?? "");
}

function preferredMember(team: any, memberId: string, followRunning: boolean) {
  const ordered = orderedTeamMembers(team).filter(member => member?.sessionId);
  const current = ordered.filter(member => member?.revision === team?.revision);
  const pool = current.length ? current : ordered;
  if (!followRunning && memberId) {
    const selected = ordered.find(member => member?.memberId === memberId);
    if (selected) return selected;
  }
  return pool.find(member => member?.status === "running" || member?.status === "waiting") ?? pool[0];
}

async function printTeamLogs(api: Api, team: any, signal: AbortSignal) {
  const current = orderedTeamMembers(team).filter(member => member?.revision === team?.revision && member?.sessionId);
  const shown = current.slice(0, 8);
  if (!shown.length) {
    console.log(`${clean(team?.id)} · review logs\n\nNo agents are in this revision.\n`);
    return;
  }
  const recorded = await Promise.all(shown.map(async member => {
    try { return { member, ...(await memberLog(api, member, signal)) }; }
    catch (error) {
      if (signal.aborted) throw error;
      return { member, screen: `Log unavailable: ${clean((error as Error).message)}`, events: [] as { at?: string; text?: string }[] };
    }
  }));
  for (const item of recorded) console.log(`${teamLogsText(team, shown, item.member, item.screen, item.events)}\n`);
  if (current.length > shown.length) console.log(`+ ${current.length - shown.length} more agents. Follow one with infinite team watch ${clean(team?.id)} --logs\n`);
}

async function askForBrief(api: Api, team: any, rows: BriefRow[], signal: AbortSignal, show: (text: string) => void, checkedAt: string): Promise<BriefRow[]> {
  const chosen = chooseTeamBrief(rows, summaryMember(team)?.sessionId);
  if (!chosen || !canAskForBrief(team, rows)) return rows;
  const card = teamSummaryText(team, rows, checkedAt, true, Date.now()).split("\n");
  const footer = card.pop() ?? "";
  show([...card, "", "Asking Jevcode for a summary. This can take a few minutes.", "", footer].join("\n"));
  try {
    // json() caps every call at 15 seconds. A repository brief can take longer, so this uses request().
    const response = await api.request(`/sessions/${chosen.sessionId}/summary?after=0`, undefined, AbortSignal.any([signal, AbortSignal.timeout(180000)]));
    const summary = await response.json() as TeamBriefStatus["summary"];
    const ready = Boolean(summary?.repository?.brief?.summary || summary?.text);
    const next: BriefRow = { sessionId: chosen.sessionId, status: { state: ready ? "ready" : "empty", summary, ...(ready ? {} : { error: "No recorded chat is available for a repository brief." }) } };
    return [...rows.filter(row => row.sessionId !== chosen.sessionId), next];
  } catch (error) {
    if (signal.aborted) throw error;
    return [...rows.filter(row => row.sessionId !== chosen.sessionId), { sessionId: chosen.sessionId, status: { state: "failed", error: clean((error as Error).message) } }];
  }
}

function outputTeam(team: any, json: boolean) {
  if (json) { console.log(JSON.stringify(team, null, 2)); return; }
  console.log(`${clean(team.id)}  ${clean(team.status)}  ${clean(team.title)}`);
  console.log(`Project ${clean(team.projectId)} · workspace ${clean(team.workspace)} · branch ${clean(team.branch)}`);
  if (team.linear?.issue?.url) console.log(`Linear ${clean(team.linear.issue.url)}`);
  else if (team.linear?.url) console.log(`Linear ${clean(team.linear.url)}`);
  if (team.reason) console.log(`Reason: ${clean(team.reason)}`);
  if (team.permissions) console.log(`Permissions: ${team.permissionsRevokedAt ? "revoked" : "delegated to coordinator"} · ${(team.permissionDecisions ?? []).length}/${team.permissions.maxDecisions} decisions`);
  for (const decision of (team.permissionDecisions ?? []).slice(-5))
    console.log(`Permission ${clean(decision.id)}: ${clean(decision.status)} · member ${clean(decision.targetMemberId)}${decision.receipt ? ` · ${clean(decision.receipt.state)}/${clean(decision.receipt.result ?? "unconfirmed")}` : ""}`);
  for (const question of team.decisions ?? []) if (!question.answer) console.log(`Question ${clean(question.id)}: ${clean(question.question)}`);
}
function receipt(path: string, key: string, body: unknown) {
  const records = readPrivateJson(path, {}) as Record<string, unknown>;
  const record = { requestId: (body as { requestId: string }).requestId, body, createdAt: new Date().toISOString(), state: "pending" };
  records[key] = record;
  privateJson(path, records);
}
function shellQuote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'`; }
/**
 * The request ID to send. An earlier request with the same intent and an unconfirmed result is
 * resumed under its own ID, so the host applies it at most once; only a different explicit ID is refused.
 */
function resumePendingIntent(path: string, prefix: string, endpoint: string, intent: (body: any) => boolean, requestId: string, explicit: boolean, rawArgs: string[]): string {
  const records = readPrivateJson(path, {}) as Record<string, any>;
  const prior = Object.entries(records).find(([key, value]) => key.startsWith(prefix) && value?.state === "pending" && value.endpoint === endpoint && intent(value.body));
  if (!prior || requestId === prior[1].requestId) return requestId;
  // A later confirmed request to the same endpoint may have superseded it; then the owner decides.
  const superseded = Object.values(records).some(value => value?.state === "confirmed" && value.endpoint === endpoint && String(value.createdAt) > String(prior[1].createdAt));
  if (!explicit && !superseded) {
    process.stderr.write(`[Infinite] Resuming earlier request ${prior[1].requestId}; its result was not confirmed.\n`);
    return prior[1].requestId;
  }
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

const BATCH_TIMEOUT = 120000, CHUNK_TIMEOUT = 60000;
/** A host without an endpoint answers its catch-all 404, which carries no code. */
const olderHost = (error: unknown) => (error as { status?: unknown; code?: unknown })?.status === 404 && (error as { code?: unknown }).code === undefined;
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
    const octets = { "Content-Type": "application/octet-stream" };
    await uploadMissingChunks({ storeDir: tempStore, hashes: manifest.entries.flatMap(entry => entry.chunks ?? []), transport: {
      has: async (hashes, signal) => (await api.json<{ missing: unknown }>(`/projects/${projectId}/sync/has`, { hashes }, signal)).missing,
      putBatch: async (body, signal) => {
        try { await (await api.request(`/projects/${projectId}/sync/blobs`, body, AbortSignal.any([signal, AbortSignal.timeout(BATCH_TIMEOUT)]), octets, "PUT")).body?.cancel(); }
        catch (error) { if (olderHost(error)) return "unsupported"; throw error; }
      },
      put: async (hash, bytes, signal) => { await (await api.request(`/projects/${projectId}/sync/blob/${hash}`, bytes, AbortSignal.any([signal, AbortSignal.timeout(CHUNK_TIMEOUT)]), octets, "PUT")).body?.cancel(); },
    } });
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
    if (positional[0] === "refresh") {
      if (positional.length !== 1) throw new Error("Usage: infinite repo refresh [--project ID]");
      const selected = options["--project"] === undefined ? boundTeamProject(config, configPath, process.cwd()) ?? "" : String(options["--project"]);
      if (!projectIdPattern.test(selected)) throw new Error("No repository project is bound to this directory. Run infinite repo init or use --project ID.");
      const status = await api.json<ProjectSourceStatus>(`/projects/${selected}/source/refresh`, {}, undefined, undefined, "POST");
      process.stderr.write(`[Infinite] ${describeSource(status)}\n`);
      return true;
    }
    if (["link", "unlink", "links"].includes(positional[0])) {
      const action = positional[0];
      if (positional.length !== (action === "links" ? 1 : 2))
        throw new Error("Usage: infinite repo link PROJECT_OR_DIRECTORY --relationship TEXT | repo unlink PROJECT_OR_DIRECTORY | repo links [--project ID]");
      const bound = (directory: string) => boundTeamProject(config, configPath, directory);
      const selected = options["--project"] === undefined ? bound(process.cwd()) : String(options["--project"]);
      if (!selected || !projectIdPattern.test(selected)) throw new Error("No repository project is bound to this directory. Run infinite repo init or use --project ID.");
      const endpoint = `/projects/${selected}/context-links`;
      const current = await api.json<{ version: number; binding?: "review-required"; links: { projectId: string; relationship: string }[] }>(endpoint);
      if (action === "links") { console.log(JSON.stringify(current, null, 2)); return true; }
      const target = projectIdPattern.test(positional[1]) ? positional[1] : bound(positional[1]);
      if (!target || !projectIdPattern.test(target)) throw new Error("The linked directory must already be enrolled. Use its project ID or run repo init there first.");
      const relationship = String(options["--relationship"] ?? "").trim();
      if (action === "link" && (!relationship || relationship.length > 300)) throw new Error("Describe the relationship with --relationship TEXT (1–300 characters).");
      const existing = current.links.find(link => link.projectId === target);
      if (!current.binding && ((action === "link" && existing?.relationship === relationship) || (action === "unlink" && !existing))) {
        console.log(JSON.stringify(current, null, 2)); return true;
      }
      const links = current.links.filter(link => link.projectId !== target);
      if (action === "link") links.push({ projectId: target, relationship });
      const result = await api.json(endpoint, { expectedVersion: current.version, links }, undefined, undefined, "PUT");
      console.log(JSON.stringify(result, null, 2));
      return true;
    }
    if (positional[0] !== "init" || positional.length > 2) throw new Error("Usage: infinite repo init [DIRECTORY] [--project ID] [--source github|laptop] [--teamwork PATH|none] [--setup-json JSON] [--check-json JSON] [--delivery merge|pr|review] [--repository OWNER/REPO] [--base-branch BRANCH] [--merge-method squash|merge|rebase] [--linear-team UUID] [--linear-project UUID]");
    const requestedDirectory = canonicalDirectory(positional[1] ?? process.cwd());
    const gitResult = gitRootOrNonGit(requestedDirectory);
    const defaultsPath = join(stateDir, "directory-defaults.json");
    const directoryDefaults = readDirectoryDefaults(defaultsPath);
    const inheritedDefault = nearestDirectoryDefault(directoryDefaults, requestedDirectory);
    const explicitLinearTeam = options["--linear-team"] === undefined ? undefined : z.uuid().parse(String(options["--linear-team"]));
    const explicitLinearProject = options["--linear-project"] === undefined ? undefined : z.uuid().parse(String(options["--linear-project"]));
    if ("nonGit" in gitResult) {
      const unsupported = ["--project", "--source", "--teamwork", "--setup-json", "--check-json", "--handoff", "--request-id", "--delivery", "--repository", "--base-branch", "--merge-method", "--permissions", "--permission-scope", "--permission-limit"].filter(flag => options[flag] !== undefined);
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
    const projectSource = inferProjectSource(root, options["--source"] === undefined ? undefined : String(options["--source"]));
    const teamwork = options["--teamwork"] === undefined ? undefined : String(options["--teamwork"]) === "none" ? null : canonicalTeamworkPath(String(options["--teamwork"]), process.cwd(), root);
    const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
    if (status) throw new Error("Repository must be clean before onboarding. Commit or remove tracked and untracked changes first.");
    const head = inspectSourceHead(root);
    const sourceRevision = head.commit || "unborn";
    const repoConfig = inferredProjectConfig(root, options, !head.commit && options["--check-json"] === undefined);
    let requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
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
    const delivery = requestedDelivery(root, options, target);
    const permissionMode = options["--permissions"];
    if (permissionMode !== undefined && permissionMode !== "coordinator" && permissionMode !== "off")
      throw new Error("--permissions must be coordinator or off.");
    const defaultCoordinatorPermissions = permissionMode === undefined && target.revision === 0 && target.team?.permissions === undefined;
    const configureCoordinatorPermissions = permissionMode === "coordinator" || defaultCoordinatorPermissions;
    if (permissionMode !== "coordinator" && (options["--permission-scope"] !== undefined || options["--permission-limit"] !== undefined))
      throw new Error("Permission scope and limit require --permissions coordinator.");
    if (configureCoordinatorPermissions && me.teams?.permissionDelegation !== 1)
      throw new Error("This host does not support delegated permissions. Upgrade it or use --permissions off before running repo init.");
    const permissions = permissionMode === "off" ? undefined : configureCoordinatorPermissions ? teamPermissionsSchema.parse({
      mode: "coordinator",
      scope: String(options["--permission-scope"] ?? "Approve one-time repository read, edit, build and test operations required by the accepted task within its assigned workspace, including a one-time run of the task's tests or accepted checks outside the provider sandbox. Delivery operations require the run's separate pinned delivery policy. Escalate new credentials, other repositories, global settings, deployment, destructive operations, persistent approvals, other permission bypasses and unclear effects."),
      maxDecisions: Number(options["--permission-limit"] ?? 10),
    }) : target.team?.permissions;

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
        throw new Error(`The source snapshot is not applied (${reason}). No team configuration was written. After the project is safe to apply, run infinite sync --apply --project ${selected}, then rerun the same repo init command. Do not force apply over cloud changes.`);
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
    const sourceSupported = me.teams?.projectSource === 1;
    const enrolledSource: ProjectSource = sourceSupported ? projectSource : { mode: "laptop" };
    const body: Record<string, any> = { requestId, revision: target.revision, team: { ...projectConfig, handoff, ...(delivery ? { delivery } : {}), ...(permissions ? { permissions } : {}) }, ...(sourceSupported ? { source: projectSource } : {}), ...(sendLinear && effectiveLinear ? { linear: effectiveLinear } : {}), ...(teamwork !== undefined ? { teamwork } : {}) };
    // After a lost reply, inherited settings may already be the host's mapping.
    // An omitted mapping preserves that value; compare that intent while replay
    // still sends the original receipt body and request ID unchanged.
    const linearIntent = (request: Record<string, any>) => request.linear === undefined ? targetLinear ?? null : request.linear;
    const teamworkIntent = (request: Record<string, any>) => request.teamwork === undefined ? target.teamwork ?? null : request.teamwork;
    requestId = body.requestId = resumePendingIntent(receiptsPath, `${key}:repo-init:`, `/projects/${selected}/team`, prior => JSON.stringify(prior.team) === JSON.stringify(body.team) && JSON.stringify(prior.source) === JSON.stringify(body.source) && JSON.stringify(linearIntent(prior)) === JSON.stringify(linearIntent(body)) && JSON.stringify(teamworkIntent(prior)) === JSON.stringify(teamworkIntent(body)), requestId, options["--request-id"] !== undefined, rawArgs);
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
            throw new Error(`The source snapshot is pending (${reason}); repo init stopped before team configuration. After the project is safe to apply, run infinite sync --apply --project ${selected}, then rerun the same repo init command. Do not force apply over cloud changes.`);
          }
          const completed = readPrivateJson(receiptsPath, {}) as Record<string, any>;
          completed[uploadKey] = { ...completed[uploadKey], state: "confirmed" };
          privateJson(receiptsPath, completed);
        }
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    assertSourceUnchanged();
    await postMutation(api, receiptsPath, `${key}:repo-init:${requestId}`, `/projects/${selected}/team`, body, "PUT", !uploadSource);
    if (sourceSupported && projectSource.mode === "github") {
      try {
        const refreshed = await api.json<ProjectSourceStatus>(`/projects/${selected}/source/refresh`, {}, undefined, undefined, "POST");
        process.stderr.write(`[Infinite] ${describeSource(refreshed)}\n`);
      } catch (error) {
        const message = error instanceof Error ? clean(error.message) : "unknown error";
        process.stderr.write(`[Infinite] Warning: source refresh failed: ${message}\n`);
      }
    }
    const output = await api.json<any>(`/projects/${selected}/team`);
    mappings[key] = { projectId: selected, source: sourceKind }; privateJson(mappingsPath, mappings);
    if (output.linear?.teamId) {
      await saveDirectoryDefault(defaultsPath, root, { teamId: z.uuid().parse(output.linear.teamId), ...(output.linear.projectId ? { projectId: z.uuid().parse(output.linear.projectId) } : {}) });
    }
    if (explicitProject || uploadSource) { config.projectId = selected; privateJson(configPath, config); }
    const sourceSnapshot = uploadSource && !head.commit ? "empty cloud baseline" : uploadSource ? `local commit ${head.commit}` : detail.sync?.appliedManifest ? "existing cloud checkout retained" : "configured project checkout";
    console.log(JSON.stringify({ kind: "repository", id: selected, name: clean(output.name), path: clean(output.path), team: output.team, linear: output.linear, teamwork: output.teamwork, revision: output.revision, execution: output.execution, projectSource: enrolledSource, ...(linearDefaultsFrom ? { linearDefaultsFrom } : {}), source: sourceSnapshot }, null, 2));
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
    let requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
    const body = createTeamSchema.parse({ requestId, projectId, provider, useConfiguredLineup: options["--provider"] === undefined, title: String(options["--title"] ?? objective.split("\n")[0].slice(0, 100)), objective, parallelism: 2 });
    requestId = body.requestId = resumePendingIntent(receiptsPath, "team-start:", "/teams", prior => prior.projectId === body.projectId && prior.provider === body.provider && prior.useConfiguredLineup === body.useConfiguredLineup && prior.title === body.title && prior.objective === body.objective, requestId, options["--request-id"] !== undefined, rawArgs);
    const team = await postMutation(api, receiptsPath, `team-start:${requestId}`, "/teams", body);
    outputTeam(team, Boolean(options["--json"])); return true;
  }
  if (subcommand === "status" || subcommand === "watch") {
    if (subcommand === "watch" && !id) throw new Error("Usage: infinite team watch ID [--logs]");
    if (options["--logs"] && !id) throw new Error("Usage: infinite team status ID --logs");
    if (id && rest.length) throw new Error(`Usage: infinite team ${subcommand} ${subcommand === "watch" ? "ID" : "[ID]"} [--logs]`);
    const abort = new AbortController(), stop = () => abort.abort();
    const json = Boolean(options["--json"]);
    const logs = Boolean(options["--logs"]);
    const tty = subcommand === "watch" && Boolean(process.stdout.isTTY) && !json;
    const interactive = tty && Boolean(process.stdin.isTTY && process.stdin.setRawMode);
    let mode: "summary" | "logs" = logs ? "logs" : "summary";
    let memberId = "";
    let previous: string | null = null;
    let pending: ReturnType<typeof teamWatchCommand> = null;
    let wake = new AbortController();
    // A full-screen watch keeps the last card so scrolling and resizing repaint without a request.
    let card = "";
    let notice = "";
    let status = "";
    let briefRows: BriefRow[] = [];
    let view = "";
    let offset = 0;
    let page = 1;
    const paint = () => {
      if (!card) return;
      const screen = teamWatchScreen(card, { rows: process.stdout.rows || 24, columns: process.stdout.columns || 80, offset, color: !process.env.NO_COLOR, status: notice || status });
      offset = screen.offset;
      page = screen.page;
      process.stdout.write(screen.frame);
    };
    const scrolls: Partial<Record<TeamWatchCommand, () => number>> = {
      up: () => offset - 1, down: () => offset + 1, pageUp: () => offset - page, pageDown: () => offset + page,
      top: () => 0, bottom: () => Number.MAX_SAFE_INTEGER,
    };
    const onData = (data: string | Buffer) => {
      const command = teamWatchCommand(String(data));
      if (command === "detach") { stop(); return; }
      if (!command) return;
      const scroll = scrolls[command];
      if (scroll) { offset = scroll(); paint(); return; }
      pending = command;
      wake.abort();
    };
    const clock = () => tty ? new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    const show = (text: string, fixedStatus = "") => {
      const output = fixedStatus ? `${text}\n${fixedStatus}` : text;
      if (subcommand !== "watch") console.log(`${process.stdout.isTTY ? wrapText(output, process.stdout.columns || 80).join("\n") : output}\n`);
      else if (!tty) {
        const frame = teamWatchFrame(previous, output, false);
        if (frame) process.stdout.write(frame);
        previous = output;
      } else {
        // Switching view or agent starts at the top; a refresh of the same view keeps the reader's place.
        const key = `${mode}/${mode === "logs" ? memberId : ""}`;
        if (key !== view) { view = key; offset = 0; }
        card = text;
        notice = "";
        status = fixedStatus;
        paint();
      }
    };
    process.once("SIGINT", stop);
    if (tty) {
      process.stdout.write("\x1b[?1049h\x1b[?25l");
      process.stdout.on("resize", paint);
    }
    if (interactive) {
      process.stdin.setRawMode(true);
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.on("data", onData);
    }
    try {
      do {
        try {
          const teams = id ? [await api.json<any>(`/teams/${id}`, undefined, abort.signal)] : (await api.json<{ teams: any[] }>("/teams", undefined, abort.signal)).teams;
          if (json) {
            const text = JSON.stringify(id ? teams[0] : teams, null, subcommand === "watch" ? undefined : 2);
            if (subcommand !== "watch" || text !== previous) console.log(text);
            previous = text;
          } else if (!id) {
            for (const team of teams) console.log(`${teamMonitorText(team)}\n`);
            if (teams.length) console.log("Open one team for the Jevcode summary: infinite team status ID\n");
          } else {
            const team = teams[0];
            const action = pending;
            pending = null;
            if (action === "logs") mode = "logs";
            else if (action === "summary") mode = "summary";
            else if (action === "next" || action === "prev") {
              mode = "logs";
              const ordered = orderedTeamMembers(team).filter(member => member?.sessionId);
              const known = ordered.some(member => member?.memberId === memberId);
              memberId = known ? shiftMember(ordered, memberId, action === "next" ? 1 : -1) : String(ordered[0]?.memberId ?? "");
            }
            if (subcommand === "status" && logs) await printTeamLogs(api, team, abort.signal);
            else if (mode === "logs") {
              const member = preferredMember(team, memberId, !interactive);
              if (member?.memberId) memberId = String(member.memberId);
              if (!member) show(`${clean(team?.id)} · review logs\n\nNo agent session is available.\n\n${interactive ? "s summary · q quit" : "Summary: infinite team status " + clean(team?.id)}`);
              else {
                const recorded = await memberLog(api, member, abort.signal);
                show(teamLogsText(team, orderedTeamMembers(team).filter(item => item?.sessionId), member, recorded.screen, recorded.events, clock(), interactive, process.stdout.columns || 80));
              }
            } else {
              let rows = await teamBriefRows(api, team, abort.signal, briefRows);
              briefRows = rows;
              if (action === "ask" && interactive) rows = await askForBrief(api, team, rows, abort.signal, show, clock());
              const chosen = chooseTeamBrief(rows, summaryMember(team)?.sessionId);
              const failed = rows.find(row => row.fetchError);
              const briefInProgress = chosen && (chosen.status.state === "pending" || chosen.status.state === "running");
              const hasBrief = Boolean(chosen?.status.summary?.repository?.brief?.summary || chosen?.status.summary?.text);
              const progress = briefInProgress ? hasBrief ? "Jevcode is updating this summary." : "Jevcode is writing the summary." : "";
              const failureStatus = failed ? `Summary refresh failed: ${failed.fetchError}` : "";
              show(teamSummaryText(team, rows, clock(), interactive, interactive ? Date.now() : undefined, tty), failureStatus || (tty ? progress : ""));
            }
          }
        } catch (error) {
          if (abort.signal.aborted || subcommand !== "watch") throw error;
          const failure = `Update failed: ${clean((error as Error).message)}`;
          if (tty && card) { notice = `${failure}. Showing the last received card.`; status = ""; paint(); }
          else show(`${failure}\n\n${interactive ? "q quit" : "Ctrl+C detaches"}`);
        }
        if (subcommand !== "watch") break;
        if (wake.signal.aborted) wake = new AbortController();
        else {
          try { await delay(2000, undefined, { signal: AbortSignal.any([abort.signal, wake.signal]) }); }
          catch { if (abort.signal.aborted) break; }
          if (wake.signal.aborted) wake = new AbortController();
        }
      } while (!abort.signal.aborted);
    } catch (error) { if (!abort.signal.aborted) throw error; }
    finally {
      if (interactive) {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      if (tty) {
        process.stdout.off("resize", paint);
        process.stdout.write("\x1b[?25h\x1b[?1049l");
      }
      process.off("SIGINT", stop);
    }
    return true;
  }
  if (subcommand === "pull") {
    if (!id || rest.length) throw new Error("Usage: infinite team pull TEAM_ID [--json]");
    const team = await api.json<any>(`/teams/${id}`);
    if (team.status !== "ready-for-review") throw new Error("This team is not ready to pull.");
    const localProject = boundTeamProject(config, configPath);
    if (localProject !== team.projectId)
      throw new Error(`This repository is bound to project ${localProject ?? "<unbound>"}, but team ${id} belongs to project ${clean(team.projectId)}.`);
    const root = canonicalRoot(process.cwd());
    const branch = String(team.branch ?? ""), teamHead = String(team.headCommit ?? "");
    if (!branch || !teamHead || !/^[a-f0-9]{40,64}$/.test(teamHead)) throw new Error("This team has no recorded result to pull.");
    const ref = `refs/heads/${branch}`;
    try { execFileSync("git", ["-C", root, "check-ref-format", ref], { stdio: "ignore", timeout: 10000, env: isolatedGitEnv() }); }
    catch { throw new Error("The team reported an invalid integration branch."); }
    if (gitStatus(root, ["show-ref", "--verify", "--quiet", ref]) === 0
      && gitStatus(root, ["cat-file", "-e", `${teamHead}^{commit}`]) === 0
      && gitStatus(root, ["merge-base", "--is-ancestor", teamHead, ref]) === 0) {
      const result = { teamId: id, branch, head: teamHead, upToDate: true };
      if (options["--json"]) console.log(JSON.stringify(result));
      else { console.log(`${branch} already contains team result ${teamHead}`); console.log(`Switch with: git switch ${branch}`); }
      return true;
    }

    const response = await api.request(`/teams/${id}/bundle`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
      throw new Error(body.error ?? `Could not download team result (${response.status}).`);
    }
    const headerBranch = response.headers.get("X-Infinite-Branch"), headerHead = response.headers.get("X-Infinite-Head");
    if (headerBranch !== branch || headerHead !== teamHead) {
      await response.body?.cancel();
      throw new Error("The team result changed while it was being prepared. Refresh team status and retry.");
    }
    const tempRoot = join(stateDir, "pull-");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(tempRoot); chmodSync(temporary, 0o700);
    const bundlePath = join(temporary, "team.bundle");
    try {
      if (!response.body) throw new Error("The host returned an empty team bundle.");
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(bundlePath, { flags: "wx", mode: 0o600 }));
      try { execFileSync("git", ["-C", root, "bundle", "verify", bundlePath], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env: isolatedGitEnv({ LC_ALL: "C" }) }); }
      catch (error) { throw new Error(`The downloaded team bundle failed verification: ${clean(String((error as NodeJS.ErrnoException & { stderr?: Buffer | string }).stderr ?? (error as Error).message))}.`); }
      let heads = "";
      try { heads = execFileSync("git", ["-C", root, "bundle", "list-heads", bundlePath, ref], { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env: isolatedGitEnv({ LC_ALL: "C" }) }); }
      catch { throw new Error("The team result changed while it was being prepared. Refresh team status and retry."); }
      // Refuse a branch that moved after the host's preflight, before fetching it locally.
      if (heads.trim().split(/\r?\n/).length !== 1 || heads.trim() !== `${teamHead} ${ref}`)
        throw new Error("The team result changed while it was being prepared. Refresh team status and retry.");
      try {
        execFileSync("git", ["-C", root, "fetch", "--no-tags", "--no-write-fetch-head", bundlePath, `${ref}:${ref}`], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"], env: isolatedGitEnv({ LC_ALL: "C" }) });
      } catch (error) {
        const detail = clean(String((error as NodeJS.ErrnoException & { stderr?: Buffer | string }).stderr ?? (error as Error).message));
        throw new Error(`Git refused to update ${branch}; it may be checked out or have diverged. The local branch was left unchanged. ${detail}`);
      }
      const localHead = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
      if (localHead !== headerHead || localHead !== teamHead) throw new Error("The fetched branch did not resolve to the recorded team result.");
      const result = { teamId: id, branch, head: teamHead };
      if (options["--json"]) console.log(JSON.stringify(result));
      else { console.log(`Pulled ${branch} at ${teamHead}`); console.log(`Switch with: git switch ${branch}`); }
      return true;
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  if (["steer", "answer", "pause", "resume", "cancel", "revoke-permissions"].includes(subcommand ?? "")) {
    if (!id) throw new Error(`Usage: infinite team ${subcommand} ID ...`);
    const current = await api.json<any>(`/teams/${id}`);
    const requestId = z.uuid().parse(String(options["--request-id"] ?? randomUUID()));
    let endpoint = subcommand === "revoke-permissions" ? `/teams/${id}/permissions/revoke` : `/teams/${id}/${subcommand}`, body: Record<string, unknown>;
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
    // These actions can repeat on purpose (pause, resume, pause), so an unconfirmed one is never resumed implicitly.
    resumePendingIntent(receiptsPath, `team-${subcommand}:`, endpoint, prior => subcommand === "steer" || subcommand === "answer" ? prior.text === body.text : true, requestId, true, rawArgs);
    outputTeam(await postMutation(api, receiptsPath, `team-${subcommand}:${requestId}`, endpoint, body), Boolean(options["--json"])); return true;
  }
  throw new Error("Usage: infinite team start|status|watch|pull|steer|answer|pause|resume|cancel|revoke-permissions ...");
}
