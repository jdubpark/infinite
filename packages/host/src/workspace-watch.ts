import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const BARRIER_TIMEOUT_MS = 15000;
const MAX_LINE_BYTES = 512;
const MAX_PENDING = 16;

export interface WorkspaceWatchRevision {
  revision: number;
  /** Complete vnode registration remains intact; not a certificate for mmap writes. */
  valid: boolean;
}
export interface WorkspaceWatch {
  flush(): Promise<WorkspaceWatchRevision>;
  close(): Promise<void>;
}

async function helper(cacheDir: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const cache = await lstat(cacheDir);
  if (!cache.isDirectory() || cache.uid !== process.getuid?.() || (cache.mode & 0o077)) {
    throw new Error("Workspace watch requires a private, owner-controlled cache directory");
  }
  const sourcePath = fileURLToPath(new URL("../../../scripts/native/workspace-watch.c", import.meta.url));
  const source = await readFile(sourcePath).catch(() => readFile(new URL("./workspace-watch.c", import.meta.url)));
  const hash = createHash("sha256").update(source).update(`\0${process.platform}\0${process.arch}`).digest("hex");
  const binary = join(cacheDir, `workspace-watch-${hash}`);
  try {
    const existing = await lstat(binary);
    if (!existing.isFile() || existing.uid !== cache.uid || (existing.mode & 0o077) || !(existing.mode & 0o100)) {
      throw new Error("Workspace watch cache contains an unsafe helper");
    }
    return binary;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${binary}-${randomUUID()}`;
  const sourceCopy = `${temporary}.c`;
  try {
    // Compile exactly the bytes named by the cache hash, even during an update.
    await writeFile(sourceCopy, source, { flag: "wx", mode: 0o600 });
    await run("xcrun", ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", sourceCopy,
      "-o", temporary], { timeout: 60000, maxBuffer: 65536 });
    await chmod(temporary, 0o700);
    await rename(temporary, binary);
    return binary;
  } catch {
    throw new Error("Workspace watch helper compilation failed; macOS command line developer tools are required");
  } finally {
    await rm(temporary, { force: true });
    await rm(sourceCopy, { force: true });
  }
}

/**
 * Start only from background preparation: the first build can invoke clang.
 * Compare revisions from this same live watch around the complete capture.
 * Any revision change requires discarding the capture. Loss is sticky:
 * recreate the watch and repeat the entire capture after an invalid revision.
 * Registers a kernel vnode filter for every entry on local APFS, including
 * ignored/build files. Directory topology changes require watch recreation.
 * Resource limits, special files and nested mounts are explicit blockers.
 * Equal valid revisions detect ordinary write/metadata syscalls, NOT writable
 * shared mappings: real MAP_SHARED writes can change bytes without vnode events.
 * A best-effort capture must report its observation span and stable-read/hash
 * evidence separately. Atomic consistency requires a filesystem snapshot or
 * enforced exclusion of every writer; this watcher cannot certify that property.
 */
export async function createWorkspaceWatch(roots: string[], cacheDir: string): Promise<WorkspaceWatch> {
  if (process.platform !== "darwin") throw new Error("Workspace change watch is unsupported on this platform");
  if (!roots.length || roots.length > 64 || roots.some(root => !isAbsolute(root) || root.includes("\0"))) {
    throw new Error("Workspace watch requires between one and 64 absolute directory roots");
  }
  const canonicalRoots = await Promise.all(roots.map(root => realpath(root)));
  const binary = await helper(cacheDir);
  const child = spawn(binary, [...new Set(canonicalRoots)], { stdio: ["pipe", "pipe", "pipe"] });
  let closed = false, failure: Error | undefined, nextId = 1, lastRevision = -1, input = "";
  let closing: Promise<void> | undefined;
  const pending = new Map<number, {
    resolve: (value: WorkspaceWatchRevision) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  const exited = new Promise<void>(resolve => { child.once("close", () => resolve()); });
  function fail(message: string) {
    failure ??= new Error(message);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure); }
    pending.clear();
    child.kill("SIGKILL");
  }
  function awaitReply(id: number): Promise<WorkspaceWatchRevision> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail("Workspace watch barrier timed out"), BARRIER_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
  }
  const ready = awaitReply(0);
  child.on("error", () => fail("Workspace watch helper could not start"));
  child.stdin.on("error", () => fail("Workspace watch control channel failed"));
  child.stdout.on("error", () => fail("Workspace watch event channel failed"));
  child.stderr.on("data", () => {});
  child.once("close", () => {
    if (!closed || pending.size) fail("Workspace watch helper stopped before capture completed");
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_LINE_BYTES * MAX_PENDING) { fail("Workspace watch reply exceeded its bound"); return; }
    for (;;) {
      const end = input.indexOf("\n");
      if (end < 0) {
        if (Buffer.byteLength(input) > MAX_LINE_BYTES) fail("Workspace watch reply exceeded its bound");
        return;
      }
      const line = input.slice(0, end);
      input = input.slice(end + 1);
      try {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error();
        const value = JSON.parse(line) as { id: number; revision: number; overflow: boolean; error?: unknown };
        if (value && typeof value.error === "string" && /^[a-z-]{1,40}$/.test(value.error)) {
          fail(`Workspace watch unavailable: ${value.error}`); return;
        }
        if (!value || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.revision) || value.revision < lastRevision ||
            value.revision < 0 || typeof value.overflow !== "boolean" || !pending.has(value.id)) throw new Error();
        const item = pending.get(value.id)!;
        pending.delete(value.id);
        clearTimeout(item.timer);
        lastRevision = value.revision;
        item.resolve({ revision: value.revision, valid: !value.overflow });
      } catch { fail("Workspace watch returned an invalid barrier"); return; }
    }
  });
  async function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    fail("Workspace watch is closed");
    closing = exited;
    await closing;
  }
  try {
    if (!(await ready).valid) throw new Error("Workspace watch lost events during startup");
  } catch (error) { await close(); throw error; }
  return {
    async flush() {
      if (failure) throw failure;
      if (closed) throw new Error("Workspace watch is closed");
      if (pending.size >= MAX_PENDING || nextId > Number.MAX_SAFE_INTEGER) throw new Error("Workspace watch barrier capacity exceeded");
      const id = nextId++;
      const result = awaitReply(id);
      child.stdin.write(`flush ${id}\n`);
      return result;
    },
    close,
  };
}
