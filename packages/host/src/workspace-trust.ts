import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const exists = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function staleLockStatus(path: string): "missing" | "fresh" | "stale" {
  let info: ReturnType<typeof statSync>;
  try { info = statSync(path); }
  catch (error) {
    if (gone(error)) return "missing";
    throw error;
  }
  return Date.now() - info.mtimeMs > LOCK_STALE_MS ? "stale" : "fresh";
}

interface HeldLock {
  fd: number;
  dev: bigint;
  ino: bigint;
}

function pinLock(lock: string): HeldLock | undefined {
  let fd: number;
  try { fd = openSync(lock, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); }
  catch (error) {
    if (gone(error)) return undefined;
    throw error;
  }
  try {
    const info = fstatSync(fd, { bigint: true });
    return { fd, dev: info.dev, ino: info.ino };
  } catch (error) {
    try { closeSync(fd); } catch {}
    throw error;
  }
}

function lockMatches(lock: string, held: HeldLock): boolean {
  let info: ReturnType<typeof statSync>;
  try { info = statSync(lock, { bigint: true }); }
  catch (error) {
    if (gone(error)) return false;
    throw error;
  }
  return info.dev === held.dev && info.ino === held.ino;
}

function assertLockOwner(lock: string, held: HeldLock) {
  if (!lockMatches(lock, held)) throw new Error("Claude config lock was lost to another process");
}

function releaseLock(lock: string, held: HeldLock) {
  try {
    if (lockMatches(lock, held)) {
      try { rmdirSync(lock); }
      catch (error) { if (!gone(error)) throw error; }
    }
  } finally {
    try { closeSync(held.fd); } catch {}
  }
}

function tryRecoverStaleLock(lock: string): { acquired: HeldLock } | "retry" | "busy" {
  const initial = staleLockStatus(lock);
  if (initial === "missing") return "retry";
  if (initial === "fresh") return "busy";
  const recover = `${lock}.recover`;
  try { mkdirSync(recover); }
  catch (error) {
    if (exists(error)) return "busy";
    throw error;
  }
  let acquired: HeldLock | undefined;
  try {
    const current = staleLockStatus(lock);
    if (current === "missing") return "retry";
    if (current === "fresh") return "busy";
    try { rmdirSync(lock); }
    catch (error) {
      if (gone(error)) return "retry";
      throw error;
    }
    try {
      mkdirSync(lock);
      acquired = pinLock(lock);
      if (acquired === undefined) return "busy";
      return { acquired };
    } catch (error) {
      if (exists(error)) return "busy";
      throw error;
    }
  } finally {
    try { rmdirSync(recover); }
    catch (error) {
      if (!gone(error)) {
        if (acquired !== undefined) try { releaseLock(lock, acquired); } catch {}
        throw error;
      }
    }
  }
}

function withClaudeConfigLock<T>(configPath: string, waitMs: number, update: (assertOwned: () => void) => T): T {
  const lock = `${configPath}.lock`, deadline = Date.now() + waitMs;
  let held: HeldLock | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      mkdirSync(lock);
      held = pinLock(lock);
      if (held !== undefined) break;
      continue;
    } catch (error) { if (!exists(error)) throw error; }
    if (Date.now() >= deadline) throw new Error("Claude config is locked by another process");
    const recovered = tryRecoverStaleLock(lock);
    if (typeof recovered === "object") { held = recovered.acquired; break; }
    if (recovered === "retry") continue;
    pause(Math.min(200, 20 * attempt));
  }
  try { return update(() => assertLockOwner(lock, held!)); } finally { releaseLock(lock, held!); }
}

export async function withClaudeConfigLockAsync<T>(configPath: string, waitMs: number, update: (assertOwned: () => void) => T | Promise<T>): Promise<T> {
  const lock = `${configPath}.lock`, deadline = Date.now() + waitMs;
  let held: HeldLock | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      mkdirSync(lock);
      held = pinLock(lock);
      if (held !== undefined) break;
      continue;
    } catch (error) { if (!exists(error)) throw error; }
    if (Date.now() >= deadline) throw new Error("Claude config is locked by another process");
    const recovered = tryRecoverStaleLock(lock);
    if (typeof recovered === "object") { held = recovered.acquired; break; }
    if (recovered === "retry") continue;
    await delay(Math.min(200, 20 * attempt));
  }
  try { return await update(() => assertLockOwner(lock, held!)); } finally { releaseLock(lock, held!); }
}

function applyClaudeTrust(configPath: string, cwd: string, assertOwned?: () => void): boolean {
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
  try {
    assertOwned?.();
    renameSync(temporary, target);
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
  return true;
}

export function recordClaudeTrust(configPath: string, cwd: string, lockWaitMs = 5000): boolean {
  if (!trustable(cwd)) throw new Error("Workspace trust requires an absolute folder path");
  return withClaudeConfigLock(configPath, lockWaitMs, assertOwned => applyClaudeTrust(configPath, cwd, assertOwned));
}

export function recordClaudeTrustAsync(configPath: string, cwd: string, lockWaitMs = 5000): Promise<boolean> {
  if (!trustable(cwd)) throw new Error("Workspace trust requires an absolute folder path");
  return withClaudeConfigLockAsync(configPath, lockWaitMs, assertOwned => applyClaudeTrust(configPath, cwd, assertOwned));
}

const entry = process.argv[1] ? resolve(process.argv[1]) : undefined;
const self = fileURLToPath(import.meta.url);
if (/^workspace-trust\.(?:js|ts)$/.test(basename(self)) && entry && existsSync(entry) && existsSync(self) && realpathSync(entry) === realpathSync(self)) {
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
