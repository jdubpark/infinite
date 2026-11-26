import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Config, WorkerRequest } from "./types.js";

export const MAX_SOCKET_PATH_BYTES = 100;
const SAMPLE_SESSION_ID = "00000000-0000-0000-0000-000000000000";
const HOST_LOCK_FILE = "host.lock";
const SYSTEM_SYMLINK_PREFIXES = new Set(["/tmp", "/var", "/var/run"]);

export type SocketTarget = string | Pick<Config, "runDir" | "socketDir">;

export const socketDirOf = (target: SocketTarget): string =>
  typeof target === "string" ? target : target.socketDir ?? target.runDir;

export const workerSocketName = (id: string): string =>
  `${createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 16)}.sock`;

export const socketPath = (target: SocketTarget, id: string): string =>
  join(socketDirOf(target), workerSocketName(id));

export const legacySocketPath = (runDir: string, id: string): string =>
  join(runDir, `${id}.sock`);

function normalizeDirPath(dir: string, label: string): string {
  if (!dir || dir.includes("\0")) throw new Error(`${label} must be a valid directory path`);
  const trimmed = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
  if (!trimmed) throw new Error(`${label} must be a valid directory path`);
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  if (collapsed.split("/").some(part => part === "." || part === ".."))
    throw new Error(`${label} must not contain relative path segments`);
  return collapsed;
}

function assertNoUntrustedSymlinkAncestors(normalized: string, label: string): void {
  const absolute = normalized.startsWith("/");
  const parts = normalized.split("/").filter(Boolean);
  let current = absolute ? "" : ".";
  for (let index = 0; index < parts.length; index++) {
    current = absolute ? `${current}/${parts[index]}` : index === 0 ? parts[index]! : `${current}/${parts[index]}`;
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const isFinal = index === parts.length - 1;
    if (info.isSymbolicLink()) {
      if (isFinal || !SYSTEM_SYMLINK_PREFIXES.has(current))
        throw new Error(`${label} must be a real directory, not a symlink`);
    } else if (!info.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a symlink`);
    }
  }
}

function sharedRootPaths(): Set<string> {
  const roots = new Set(["/", "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", resolve(tmpdir())]);
  try {
    roots.add(realpathSync(tmpdir()));
  } catch {
  }
  return roots;
}

function canonicalOrResolved(dir: string): string {
  const resolved = resolve(dir);
  const tail: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const base = realpathSync(current);
      return tail.length ? join(base, ...tail.reverse()) : base;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return resolved;
    }
    const parent = dirname(current);
    if (parent === current) return resolved;
    tail.push(basename(current));
    current = parent;
  }
}

export function isTrustedPrivateDir(dir: string): string | undefined {
  let normalized: string;
  try {
    normalized = normalizeDirPath(dir, "directory");
    assertNoUntrustedSymlinkAncestors(normalized, "directory");
  } catch {
    return undefined;
  }
  const sharedRoots = sharedRootPaths();
  if (sharedRoots.has(resolve(normalized))) return undefined;
  let info;
  try {
    info = lstatSync(normalized);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
  try {
    if (sharedRoots.has(realpathSync(normalized))) return undefined;
  } catch {
    return undefined;
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return undefined;
  if ((info.mode & 0o1000) !== 0) return undefined;
  if ((info.mode & 0o777) !== 0o700) return undefined;
  return normalized;
}

function isOwnedNonSymlinkEntry(path: string, requireSocket: boolean): boolean {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return false;
    if (requireSocket && !info.isSocket()) return false;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return false;
    return true;
  } catch {
    return false;
  }
}

export function existingWorkerSocket(target: SocketTarget, id: string): string | undefined {
  const primaryDir = socketDirOf(target);
  const primary = socketPath(target, id);
  if (isOwnedNonSymlinkEntry(primary, false)) return primary;
  const fallbackDir = typeof target === "string" ? target : target.runDir;
  const trustedFallback = isTrustedPrivateDir(fallbackDir);
  if (!trustedFallback) return undefined;
  if (canonicalOrResolved(trustedFallback) !== canonicalOrResolved(primaryDir)) {
    const previousShort = join(trustedFallback, workerSocketName(id));
    if (Buffer.byteLength(previousShort) <= MAX_SOCKET_PATH_BYTES && isOwnedNonSymlinkEntry(previousShort, true))
      return previousShort;
  }
  const legacy = legacySocketPath(trustedFallback, id);
  if (Buffer.byteLength(legacy) <= MAX_SOCKET_PATH_BYTES && isOwnedNonSymlinkEntry(legacy, true))
    return legacy;
  return undefined;
}

export function removeWorkerSockets(target: SocketTarget, id: string): void {
  const paths = new Set<string>([socketPath(target, id)]);
  const fallbackDir = typeof target === "string" ? target : target.runDir;
  const trustedFallback = isTrustedPrivateDir(fallbackDir);
  if (trustedFallback) {
    paths.add(join(trustedFallback, workerSocketName(id)));
    paths.add(legacySocketPath(trustedFallback, id));
  }
  for (const path of paths) {
    if (isOwnedNonSymlinkEntry(path, true)) {
      try {
        rmSync(path, { force: true });
      } catch {
      }
    }
  }
}

export function ensureSocketDir(dir: string, label: "runDir" | "socketDir" = "socketDir"): string {
  const normalized = normalizeDirPath(dir, label);
  const bytes = Buffer.byteLength(socketPath(normalized, SAMPLE_SESSION_ID));
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new Error(`${label} is too long for a Unix socket (${bytes} bytes > ${MAX_SOCKET_PATH_BYTES}); choose a shorter path`);
  const sharedRoots = sharedRootPaths();
  if (sharedRoots.has(resolve(normalized)))
    throw new Error(`${label} must be a private subdirectory, not a shared root`);
  assertNoUntrustedSymlinkAncestors(normalized, label);
  let existing;
  try {
    existing = lstatSync(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new Error(`${label} must be a real directory, not a symlink`);
  if (!existing) mkdirSync(normalized, { recursive: true, mode: 0o700 });
  assertNoUntrustedSymlinkAncestors(normalized, label);
  let info = lstatSync(normalized);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${label} must be a real directory, not a symlink`);
  if (sharedRoots.has(realpathSync(normalized)))
    throw new Error(`${label} must be a private subdirectory, not a shared root`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(`${label} must be owned by the current user`);
  if ((info.mode & 0o1000) !== 0)
    throw new Error(`${label} must not be a sticky shared directory`);
  if ((info.mode & 0o777) !== 0o700) {
    chmodSync(normalized, 0o700);
    info = lstatSync(normalized);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700)
      throw new Error(`${label} must have mode 0700`);
  }
  return normalized;
}

interface SocketDirLockRecord {
  pid: number;
  runDir: string;
  token: string;
}

const activeSocketDirClaims = new Map<string, { runDir: string; lockPath: string; ownerToken?: string; refs: Set<string> }>();

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readSocketDirLock(lockPath: string): SocketDirLockRecord | undefined {
  try {
    const info = lstatSync(lockPath);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return undefined;
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<SocketDirLockRecord>;
    if (typeof parsed.pid === "number" && typeof parsed.runDir === "string" && typeof parsed.token === "string")
      return { pid: parsed.pid, runDir: parsed.runDir, token: parsed.token };
  } catch {
  }
  return undefined;
}

export function claimSocketDir(socketDir: string, runDir: string): () => void {
  const canonicalSocket = canonicalOrResolved(socketDir);
  const canonicalRun = canonicalOrResolved(runDir);
  const lockPath = join(socketDir, HOST_LOCK_FILE);
  const token = randomUUID();
  const inProcess = activeSocketDirClaims.get(canonicalSocket);
  if (inProcess && inProcess.refs.size > 0) {
    if (inProcess.runDir !== canonicalRun)
      throw new Error("Another host owns this socket directory");
    inProcess.refs.add(token);
    return () => releaseSocketDirClaim(canonicalSocket, token);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, runDir: canonicalRun, token } satisfies SocketDirLockRecord));
      } finally {
        closeSync(fd);
      }
      activeSocketDirClaims.set(canonicalSocket, { runDir: canonicalRun, lockPath, ownerToken: token, refs: new Set([token]) });
      return () => releaseSocketDirClaim(canonicalSocket, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = readSocketDirLock(lockPath);
    if (existing && pidAlive(existing.pid)) {
      if (existing.runDir !== canonicalRun)
        throw new Error("Another host owns this socket directory");
      if (existing.pid !== process.pid) return () => {};
      activeSocketDirClaims.set(canonicalSocket, { runDir: canonicalRun, lockPath, refs: new Set([token]) });
      return () => releaseSocketDirClaim(canonicalSocket, token);
    }
    try {
      const info = lstatSync(lockPath);
      if (info.isSymbolicLink() || !info.isFile())
        throw new Error("Invalid host lock entry in socket directory");
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error("Another user owns the host lock in this socket directory");
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Another host owns this socket directory");
}

function releaseSocketDirClaim(canonicalSocket: string, token: string): void {
  const entry = activeSocketDirClaims.get(canonicalSocket);
  if (!entry || !entry.refs.delete(token)) return;
  if (entry.refs.size > 0) return;
  activeSocketDirClaims.delete(canonicalSocket);
  if (!entry.ownerToken) return;
  const current = readSocketDirLock(entry.lockPath);
  if (current && current.pid === process.pid && current.token === entry.ownerToken) {
    try {
      unlinkSync(entry.lockPath);
    } catch {
    }
  }
}

export type WorkerError = Error & { code?: string };

export function workerCall<T>(
  target: SocketTarget,
  id: string,
  request: WorkerRequest,
  timeoutMs = 4000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const path = existingWorkerSocket(target, id);
    if (!path) {
      reject(Object.assign(new Error("Worker unavailable"), { code: "ENOENT" }));
      return;
    }
    const socket = createConnection(path);
    let data = "";
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(
        new Error("Worker response timed out; delivery may be uncertain"),
      ),
    );
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.length > (request.op === "workspace-export" ? 40 : 2) * 1024 * 1024)
        return socket.destroy(new Error("Oversized worker response"));
      const end = data.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        socket.end();
        if (response.error) {
          const error: WorkerError = new Error(response.error);
          if (typeof response.code === "string") error.code = response.code;
          reject(error);
        } else resolve(response.result);
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (!data.includes("\n")) reject(new Error("Worker unavailable"));
    });
  });
}
