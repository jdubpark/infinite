import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config, WorkerRequest } from "./types.js";

export const MAX_SOCKET_PATH_BYTES = 100;
const SAMPLE_SESSION_ID = "00000000-0000-0000-0000-000000000000";

export type SocketTarget = string | Pick<Config, "runDir" | "socketDir">;

export const socketDirOf = (target: SocketTarget): string =>
  typeof target === "string" ? target : target.socketDir ?? target.runDir;

export const workerSocketName = (id: string): string =>
  `${createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 16)}.sock`;

export const socketPath = (target: SocketTarget, id: string): string =>
  join(socketDirOf(target), workerSocketName(id));

export const legacySocketPath = (runDir: string, id: string): string =>
  join(runDir, `${id}.sock`);

export function existingWorkerSocket(target: SocketTarget, id: string): string | undefined {
  const primary = socketPath(target, id);
  if (existsSync(primary)) return primary;
  const fallbackDir = typeof target === "string" ? target : target.runDir;
  const legacy = legacySocketPath(fallbackDir, id);
  if (Buffer.byteLength(legacy) <= MAX_SOCKET_PATH_BYTES && existsSync(legacy)) return legacy;
  return undefined;
}

export function removeWorkerSockets(target: SocketTarget, id: string): void {
  const fallbackDir = typeof target === "string" ? target : target.runDir;
  const paths = new Set([socketPath(target, id), legacySocketPath(fallbackDir, id)]);
  for (const path of paths) {
    try {
      if (lstatSync(path).isSocket()) rmSync(path, { force: true });
    } catch {
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

export function ensureSocketDir(dir: string, label: "runDir" | "socketDir" = "socketDir"): string {
  if (!dir || dir.includes("\0")) throw new Error(`${label} must be a valid directory path`);
  const bytes = Buffer.byteLength(socketPath(dir, SAMPLE_SESSION_ID));
  if (bytes > MAX_SOCKET_PATH_BYTES)
    throw new Error(`${label} is too long for a Unix socket (${bytes} bytes > ${MAX_SOCKET_PATH_BYTES}); choose a shorter path`);
  const sharedRoots = sharedRootPaths();
  if (sharedRoots.has(resolve(dir)))
    throw new Error(`${label} must be a private subdirectory, not a shared root`);
  let existing;
  try {
    existing = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new Error(`${label} must be a real directory, not a symlink`);
  if (!existing) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${label} must be a real directory, not a symlink`);
  if (sharedRoots.has(realpathSync(dir)))
    throw new Error(`${label} must be a private subdirectory, not a shared root`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error(`${label} must be owned by the current user`);
  if ((info.mode & 0o1000) !== 0)
    throw new Error(`${label} must not be a sticky shared directory`);
  if ((info.mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700);
    info = lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700)
      throw new Error(`${label} must have mode 0700`);
  }
  return dir;
}

export type WorkerError = Error & { code?: string };

export function workerCall<T>(
  target: SocketTarget,
  id: string,
  request: WorkerRequest,
  timeoutMs = 4000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(existingWorkerSocket(target, id) ?? socketPath(target, id));
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
