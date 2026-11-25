import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function trustable(cwd: string) {
  return isAbsolute(cwd) && normalize(cwd) === cwd && cwd !== "/" && !/[\x00-\x1f\x7f]/.test(cwd);
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function inspected(path: string, follow = false) {
  try { return follow ? statSync(path) : lstatSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new Error(`Cannot check ${path} for repository Codex configuration (${code ?? "error"})`);
  }
}

function gitRootMarker(dir: string) {
  const git = inspected(join(dir, ".git"), true);
  return git !== undefined && (!git.isDirectory() || inspected(join(dir, ".git", "HEAD"), true) !== undefined);
}

export function repositoryCodexConfig(cwd: string): string[] {
  const chain: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    chain.push(dir);
    if (gitRootMarker(dir)) break;
    if (dirname(dir) === dir) { chain.length = 1; break; }
  }
  return chain.map(dir => join(dir, ".codex")).filter(path => inspected(path) !== undefined);
}

export function codexTrustArgs(cwd: string): string[] {
  if (!trustable(cwd)) throw new Error("Workspace trust requires an absolute folder path");
  const planted = repositoryCodexConfig(cwd);
  if (planted.length)
    throw new Error(`Codex member not started: the repository carries Codex project configuration (${planted.join(", ")}), which a trusted Codex launch would load. Remove it from the repository to start Codex members here.`);
  return ["-c", 'project_root_markers=[".git"]', "-c", `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`];
}

export function claudeConfigPath(home: string, configDir?: string): string {
  const primary = join(configDir || home, ".claude.json");
  const legacy = join(configDir || join(home, ".claude"), ".config.json");
  try {
    const info = statSync(legacy);
    if (info.isFile() && (info.size > 0 || ((info.mode & 0o222) !== 0 && !existsSync(primary)))) return legacy;
  } catch {}
  return primary;
}

const LOCK_STALE_MS = 10_000;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withClaudeConfigLock<T>(configPath: string, waitMs: number, update: () => T): T {
  const lock = `${configPath}.lock`, deadline = Date.now() + waitMs;
  const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
  for (let attempt = 1; ; attempt++) {
    try { mkdirSync(lock); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (Date.now() >= deadline) throw new Error("Claude config is locked by another process");
    try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmdirSync(lock); continue; } }
    catch (error) { if (!gone(error)) throw error; continue; }
    pause(Math.min(200, 20 * attempt));
  }
  try { return update(); } finally { rmdirSync(lock); }
}

export function recordClaudeTrust(configPath: string, cwd: string, lockWaitMs = 5000): boolean {
  if (!trustable(cwd)) throw new Error("Workspace trust requires an absolute folder path");
  return withClaudeConfigLock(configPath, lockWaitMs, () => {
    let existing: string | undefined;
    try { existing = readFileSync(configPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const data: unknown = existing?.trim() ? JSON.parse(existing) : {};
    if (!isObject(data)) throw new Error("Claude config is not a JSON object");
    const projects = isObject(data.projects) ? data.projects : {};
    const current = isObject(projects[cwd]) ? projects[cwd] : {};
    if (current.hasTrustDialogAccepted === true) return false;
    const next = { ...data, projects: { ...projects, [cwd]: { ...current, hasTrustDialogAccepted: true } } };
    const target = existing === undefined ? configPath : realpathSync(configPath);
    const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600, flag: "wx" });
    try { renameSync(temporary, target); }
    catch (error) { rmSync(temporary, { force: true }); throw error; }
    return true;
  });
}

const entry = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entry && existsSync(entry) && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const requested = process.env.INFINITE_TRUSTED_WORKSPACE;
  const home = process.env.HOME;
  if (process.argv[2] !== "claude" || process.argv.length !== 3 || !requested || !home) {
    console.error("Usage: INFINITE_TRUSTED_WORKSPACE=DIR workspace-trust claude");
    process.exit(64);
  }
  if (realpathSync(process.cwd()) !== requested) {
    console.error("The trusted workspace must be the current folder.");
    process.exit(65);
  }
  recordClaudeTrust(claudeConfigPath(home, process.env.CLAUDE_CONFIG_DIR), requested);
}
