import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { unseal } from "./vault.js";
import type { Config, WorkerRequest, WorkerState } from "./types.js";

export const MAX_SOCKET_PATH_BYTES = 100;
const SAMPLE_SESSION_ID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_PERMISSION_SOCKET = "permission-channel.sock";
const SYSTEM_SYMLINK_PREFIXES = new Set(["/tmp", "/var", "/var/run"]);

export type SocketTarget =
  | string
  | (Pick<Config, "runDir" | "socketDir"> & {
      hostKey?: string;
      recordedSocket?: (id: string) => string | undefined;
    });

export const socketDirOf = (target: SocketTarget): string =>
  typeof target === "string" ? target : target.socketDir ?? target.runDir;

export const runDirOf = (target: SocketTarget): string =>
  typeof target === "string" ? target : target.runDir;

export function canonicalOrResolved(dir: string): string {
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

export const hostKeyOf = (target: SocketTarget): string =>
  typeof target !== "string" && target.hostKey ? target.hostKey : canonicalOrResolved(runDirOf(target));

export const legacyHashSocketName = (id: string): string =>
  `${createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 16)}.sock`;

export const workerSocketName = (id: string, hostKey: string): string =>
  `${createHash("sha256").update(`${hostKey}\0${id.toLowerCase()}`).digest("hex").slice(0, 16)}.sock`;

export const socketPath = (target: SocketTarget, id: string): string =>
  join(socketDirOf(target), workerSocketName(id, hostKeyOf(target)));

export const legacySocketPath = (runDir: string, id: string): string =>
  join(runDir, `${id}.sock`);

export function permissionChannelPath(target: SocketTarget): string {
  const dir = socketDirOf(target);
  const hostKey = hostKeyOf(target);
  if (typeof target === "string" || target.socketDir === undefined || canonicalOrResolved(dir) === hostKey)
    return join(dir, DEFAULT_PERMISSION_SOCKET);
  const tag = createHash("sha256").update(hostKey).digest("hex").slice(0, 12);
  return join(dir, `p-${tag}.sock`);
}

function normalizeDirPath(dir: string, label: string): string {
  if (!dir || dir.includes("\0")) throw new Error(`${label} must be a valid directory path`);
  const trimmed = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
  if (!trimmed) throw new Error(`${label} must be a valid directory path`);
  const collapsed = trimmed.replace(/\/{2,}/g, "/");
  if (collapsed.split("/").some(part => part === "." || part === ".."))
    throw new Error(`${label} must not contain relative path segments`);
  return collapsed;
}

function assertTrustedParentMode(info: { uid: number; mode: number }, uid: number | undefined, label: string): void {
  if (uid !== undefined && info.uid !== 0 && info.uid !== uid)
    throw new Error(`${label} has an untrusted parent directory owner`);
  if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    throw new Error(`${label} must not live beneath a writable non-sticky parent directory`);
}

function assertTrustedAncestors(normalized: string, label: string, allowMissing: boolean): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const rootInfo = lstatSync("/");
  if (!rootInfo.isDirectory()) throw new Error(`${label} has an invalid root directory`);
  assertTrustedParentMode(rootInfo, uid, label);
  const abs = normalized.startsWith("/") ? normalized : resolve(normalized);
  const parts = abs.split("/").filter(Boolean);
  let current = "";
  for (let index = 0; index < parts.length; index++) {
    current = `${current}/${parts[index]}`;
    const isFinal = index === parts.length - 1;
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      if (isFinal || !SYSTEM_SYMLINK_PREFIXES.has(current) || (uid !== undefined && info.uid !== 0))
        throw new Error(`${label} must be a real directory, not a symlink`);
      const targetInfo = statSync(current);
      if (!targetInfo.isDirectory())
        throw new Error(`${label} must be a real directory, not a symlink`);
      assertTrustedParentMode(targetInfo, uid, label);
      continue;
    }
    if (!info.isDirectory())
      throw new Error(`${label} must be a real directory, not a symlink`);
    if (!isFinal) assertTrustedParentMode(info, uid, label);
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

export function isTrustedPrivateDir(dir: string): string | undefined {
  let normalized: string;
  try {
    normalized = normalizeDirPath(dir, "directory");
    assertTrustedAncestors(normalized, "directory", false);
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

function isTrustedDirCached(dir: string, dirTrustCache?: Map<string, boolean>): boolean {
  const cached = dirTrustCache?.get(dir);
  if (cached !== undefined) return cached;
  const trusted = isTrustedPrivateDir(dir) !== undefined;
  dirTrustCache?.set(dir, trusted);
  return trusted;
}

export function trustedWorkerSocket(path: string, dirTrustCache?: Map<string, boolean>): string | undefined {
  if (!path || path.includes("\0") || Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) return undefined;
  if (!isOwnedNonSymlinkEntry(path, true)) return undefined;
  return isTrustedDirCached(dirname(path), dirTrustCache) ? path : undefined;
}

export function existingWorkerSocket(
  target: SocketTarget,
  id: string,
  recordedSocketPath?: string,
  dirTrustCache?: Map<string, boolean>,
): string | undefined {
  const primary = socketPath(target, id);
  if (isOwnedNonSymlinkEntry(primary, false) && isTrustedDirCached(dirname(primary), dirTrustCache)) return primary;
  const fallbackDir = runDirOf(target);
  const hostKey = hostKeyOf(target);
  const candidates = [
    join(fallbackDir, workerSocketName(id, hostKey)),
    join(fallbackDir, legacyHashSocketName(id)),
    legacySocketPath(fallbackDir, id),
  ];
  const seen = new Set<string>([primary]);
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const trusted = trustedWorkerSocket(candidate, dirTrustCache);
    if (trusted) return trusted;
  }
  const recorded = recordedSocketPath ?? (typeof target === "string" ? undefined : target.recordedSocket?.(id));
  if (recorded && !seen.has(recorded)) return trustedWorkerSocket(recorded, dirTrustCache);
  return undefined;
}

export function removeWorkerSockets(target: SocketTarget, id: string, recordedSocketPath?: string): void {
  const fallbackDir = runDirOf(target);
  const hostKey = hostKeyOf(target);
  const paths = new Set<string>([
    socketPath(target, id),
    join(fallbackDir, workerSocketName(id, hostKey)),
    join(fallbackDir, legacyHashSocketName(id)),
    legacySocketPath(fallbackDir, id),
  ]);
  if (recordedSocketPath) paths.add(recordedSocketPath);
  const dirTrustCache = new Map<string, boolean>();
  for (const path of paths) {
    if (trustedWorkerSocket(path, dirTrustCache)) {
      try {
        rmSync(path, { force: true });
      } catch {
      }
    }
  }
}

export function readRecordedSocketPath(stateDir: string, key: Buffer, id: string): string | undefined {
  const file = join(stateDir, "sessions", id, "status.sealed");
  try {
    const saved = unseal<WorkerState>(key, `${id}:status`, readFileSync(file, "utf8"));
    return typeof saved.socketPath === "string" ? saved.socketPath : undefined;
  } catch {
    return undefined;
  }
}

export function collectLivePermissionSockets(stateDir: string, key: Buffer): string[] {
  const sessionsDir = join(stateDir, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const deletedDir = join(stateDir, "deleted-sessions");
  const sockets = new Set<string>();
  const dirTrustCache = new Map<string, boolean>();
  for (const id of readdirSync(sessionsDir).filter(name => /^[a-f0-9-]{36}$/i.test(name))) {
    if (existsSync(join(deletedDir, `${id}.sealed`))) continue;
    const file = join(sessionsDir, id, "status.sealed");
    if (!existsSync(file)) continue;
    try {
      const saved = unseal<WorkerState>(key, `${id}:status`, readFileSync(file, "utf8"));
      if (saved.status === "exited") continue;
      const path = saved.permissionSocketPath;
      if (typeof path !== "string" || !path || path.includes("\0") || Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) continue;
      const name = basename(path);
      if (!name.endsWith(".sock") || name === "." || name === "..") continue;
      const dir = dirname(path);
      if (isTrustedDirCached(dir, dirTrustCache)) sockets.add(join(dir, name));
    } catch {
    }
  }
  return [...sockets];
}

export function ensureSocketDir(dir: string, label: "runDir" | "socketDir" = "socketDir"): string {
  const normalized = normalizeDirPath(dir, label);
  const bytes = Buffer.byteLength(socketPath(normalized, SAMPLE_SESSION_ID));
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new Error(`${label} is too long for a Unix socket (${bytes} bytes > ${MAX_SOCKET_PATH_BYTES}); choose a shorter path`);
  const sharedRoots = sharedRootPaths();
  if (sharedRoots.has(resolve(normalized)))
    throw new Error(`${label} must be a private subdirectory, not a shared root`);
  assertTrustedAncestors(normalized, label, true);
  let existing;
  try {
    existing = lstatSync(normalized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new Error(`${label} must be a real directory, not a symlink`);
  if (!existing) mkdirSync(normalized, { recursive: true, mode: 0o700 });
  assertTrustedAncestors(normalized, label, false);
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

export type WorkerError = Error & { code?: string };

export function destroyWhenSilent(socket: Socket, timeoutMs: number, message: string) {
  let events = 0;
  const count = () => {
    events += 1;
  };
  socket.on("connect", count);
  socket.on("data", count);
  socket.setTimeout(timeoutMs);
  socket.on("timeout", () => {
    const seen = events;
    setImmediate(() => {
      if (events === seen) socket.destroy(new Error(message));
    });
  });
}

export function workerCallAt<T>(
  path: string,
  request: WorkerRequest,
  timeoutMs = 4000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let data = "";
    destroyWhenSilent(
      socket,
      timeoutMs,
      "Worker response timed out; delivery may be uncertain",
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

export function workerCall<T>(
  target: SocketTarget,
  id: string,
  request: WorkerRequest,
  timeoutMs = 4000,
): Promise<T> {
  const path = existingWorkerSocket(target, id);
  if (!path) return Promise.reject(Object.assign(new Error("Worker unavailable"), { code: "ENOENT" }));
  return workerCallAt(path, request, timeoutMs);
}
