import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkspace, type WorkspaceManifest } from "./workspace-checkpoint.js";
import { uploadMissingChunks } from "./chunk-upload.js";

export interface SyncServiceOptions {
  origin: string; token: string; projectId: string; root: string; stateFile: string; storeDir: string;
  /** Startup inactivity bound in milliseconds; defaults to 60 s. */
  startupInactivityMs?: number;
}
export interface SyncState { pid: number; projectId: string; root: string; origin: string; startedAt: string; lastCommitAt?: string; lastManifest?: string; problem?: string; skipped?: number }
/** Special files the first capture left out: how many, and up to 20 of their root-relative paths. */
export interface SyncStart { skipped: { count: number; paths: string[] } }

/** Startup inactivity bound: the child reports capture progress, each phase and uploaded chunk, and every report restarts it. */
const STARTUP_TIMEOUT = 60000;
/** The host applies the tree inside the commit request; a first apply of a large project can take minutes. */
const COMMIT_TIMEOUT = 30 * 60 * 1000;
const STARTUP_ERROR = "The workspace sync service did not complete its first upload. Nothing was applied on the host.";
const STALLED = "Run infinite sync again to resume; chunks already uploaded are kept.";
const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300);
/**
 * A recorded pid names this service only while that process still runs with `--sync-service`.
 * After a crash the OS may reuse the pid; pid 0 or -1 would signal a whole process group or every process.
 */
function runningService(pid: unknown): pid is number {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return false;
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).includes("--sync-service"); }
  catch { return false; }
}
/** Canonical form of a path that may not exist yet: its nearest existing ancestor resolved, the rest appended. */
function canonical(path: string): string {
  const missing: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try { return join(realpathSync(current), ...missing); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      missing.unshift(basename(current));
    }
  }
}
/** Manifest ids hash capture times, so content, layout, and modes alone decide whether a push is due. */
const fingerprint = (manifest: WorkspaceManifest) =>
  createHash("sha256").update(JSON.stringify(manifest.entries.map(({ sourceStamp: _stamp, ...entry }) => entry))).digest("hex");

function validateOptions(options: SyncServiceOptions): SyncServiceOptions {
  const origin = new URL(options.origin);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) ||
      !/^[a-z0-9-]{1,80}$/.test(options.projectId) || !/^[\x21-\x7e]{32,200}$/.test(options.token) ||
      (options.startupInactivityMs !== undefined && (!Number.isInteger(options.startupInactivityMs) || options.startupInactivityMs < 100 || options.startupInactivityMs > STARTUP_TIMEOUT)))
    throw new Error("Invalid sync pairing.");
  const root = realpathSync(options.root);
  if (!statSync(root).isDirectory() || root === sep || root === realpathSync(homedir())) throw new Error("Select a project directory, not the entire home or filesystem.");
  const storeDir = canonical(options.storeDir), stateFile = canonical(options.stateFile);
  if (inside(root, storeDir) || inside(root, stateFile)) throw new Error("Sync storage must be outside the synced project.");
  return { ...options, origin: origin.origin, root, storeDir, stateFile };
}

/** The recorded service still runs; a record left by a killed service or a reboot does not. */
export const syncServiceRunning = (state: SyncState) => runningService(state.pid);
export function readSyncState(stateFile: string): SyncState | undefined {
  try { return JSON.parse(readFileSync(stateFile, "utf8")) as SyncState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function writeState(stateFile: string, state: SyncState) {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, stateFile);
}
/**
 * Stop the recorded service. A state file whose pid no longer runs the service is stale: it is removed and nothing is signaled.
 * Removing the file also stops a service the signal cannot reach; it exits before its next capture.
 */
export function stopSyncService(stateFile: string): boolean {
  const state = readSyncState(stateFile);
  if (!state) return false;
  const running = runningService(state.pid);
  if (running) try { process.kill(state.pid, "SIGTERM"); } catch { /* Already gone. */ }
  rmSync(stateFile, { force: true });
  return running;
}

/** Launch the detached service and resolve after its first committed generation. */
export async function startSyncService(options: SyncServiceOptions): Promise<SyncStart> {
  const validated = validateOptions(options);
  const existing = readSyncState(validated.stateFile);
  if (existing) {
    if (runningService(existing.pid)) throw new Error("A sync service already runs for this project. Stop it first.");
    rmSync(validated.stateFile, { force: true });
  }
  const file = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...(file.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []), file, "--sync-service"], {
    cwd: validated.root, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  // The device key is passed only through private IPC, never copied into the
  // service's arguments, environment, or state file.
  const result: SyncStart = { skipped: { count: 0, paths: [] } };
  await new Promise<void>((resolve, reject) => {
    let started = false, ready = false, detached = false, finished = false;
    const timer = setTimeout(() => fail(undefined, true), validated.startupInactivityMs ?? STARTUP_TIMEOUT);
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("disconnect", disconnected); child.off("exit", exited); child.off("error", failed); };
    const fail = (reason?: string, stalled = false) => {
      if (finished) return;
      finished = true; cleanup();
      if (child.connected) try { child.disconnect(); } catch { /* Already disconnected. */ }
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 4000); killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
      reject(new Error(reason ? `${STARTUP_ERROR} ${reason}` : stalled ? `${STARTUP_ERROR} ${STALLED}` : STARTUP_ERROR));
    };
    const failed = () => fail();
    // A final message can still be queued when the exit arrives; the disconnect that follows it decides.
    const exited = () => { if (!child.connected) fail(); };
    const disconnected = () => {
      if (!detached) { fail(); return; }
      if (finished) return;
      finished = true; cleanup(); child.unref(); resolve();
    };
    const message = (value: unknown) => {
      timer.refresh();
      const { type, reason } = (value ?? {}) as { type?: unknown; reason?: unknown };
      if (type === "progress" && started && !ready) return;
      if (type === "failed") { fail(typeof reason === "string" ? printable(reason) : undefined); return; }
      if (type === "boot" && !started) {
        started = true;
        try { child.send({ type: "start", options: validated }, error => { if (error) fail(); }); } catch { fail(); }
        return;
      }
      if (type === "detached" && ready && !detached) { detached = true; return; }
      if (type !== "ready" || !started || ready) { fail(); return; }
      ready = true;
      const { skipped } = value as { skipped?: { count?: unknown; paths?: unknown } };
      if (Number.isSafeInteger(skipped?.count) && Array.isArray(skipped?.paths))
        result.skipped = { count: skipped.count as number, paths: skipped.paths.filter((path): path is string => typeof path === "string").slice(0, 20).map(printable) };
      try { child.send({ type: "detach" }, error => { if (error) fail(); }); } catch { fail(); }
    };
    child.on("error", () => {});
    child.on("error", failed); child.on("exit", exited); child.on("disconnect", disconnected); child.on("message", message);
  });
  return result;
}

class FatalSyncError extends Error {}
/** A host older than a route answers its catch-all 404 without a code. */
class MissingRouteError extends FatalSyncError {}
/** A refusal the host explained: its status and code, and for a failed sync operation, a category. */
class SyncRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly category?: string) { super(message); }
}
const POLL = 3000;
const BATCH_TIMEOUT = 120000;
const BACKOFF_LIMIT = 5 * 60 * 1000;
/** Apply failures the same content meets again; it is not pushed again until the laptop changes or the owner applies it. */
const LASTING = new Set(["permission", "cross-device", "special-file", "missing-path"]);
async function refusal(response: Response): Promise<never> {
  const reply = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown; category?: unknown };
  const reason = typeof reply.error === "string" ? reply.error : `HTTP ${response.status}`;
  // A revoked key, a removed project, or a manifest over the host's bound will not recover by retrying.
  if (response.status === 404 && reply.code === undefined) throw new MissingRouteError(`Host refused sync (${response.status}): ${reason}`);
  if ([401, 403, 404, 413].includes(response.status)) throw new FatalSyncError(`Host refused sync (${response.status}): ${reason}`);
  throw new SyncRequestError(reason, response.status, typeof reply.code === "string" ? reply.code : undefined, typeof reply.category === "string" ? reply.category : undefined);
}
async function api<T>(options: SyncServiceOptions, path: string, signal: AbortSignal, body: unknown, raw?: Buffer, timeout = 60000): Promise<T> {
  const response = await fetch(`${options.origin}/api/projects/${options.projectId}/sync/${path}`, {
    method: raw ? "PUT" : "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    headers: { Authorization: `Bearer ${options.token}`, "Content-Type": raw ? "application/octet-stream" : "application/json" },
    body: raw ? new Uint8Array(raw) : JSON.stringify(body),
  });
  if (!response.ok) await refusal(response);
  return await response.json() as T;
}
async function pendingReason(options: SyncServiceOptions, signal: AbortSignal): Promise<string | undefined> {
  const response = await fetch(`${options.origin}/api/projects/${options.projectId}`, {
    redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), headers: { Authorization: `Bearer ${options.token}` },
  });
  if (!response.ok) await refusal(response);
  const reason = ((await response.json()) as { sync?: { pendingGeneration?: { reason?: unknown } } }).sync?.pendingGeneration?.reason;
  return typeof reason === "string" ? reason : undefined;
}

async function runSyncService(): Promise<void> {
  const abort = new AbortController();
  let released = false, reported = false, options: SyncServiceOptions | undefined, reason: string | undefined;
  const stop = () => abort.abort();
  const disconnected = () => { if (!released) stop(); };
  const detach = (value: unknown) => {
    if (!reported || released || (value as { type?: unknown } | null)?.type !== "detach") return;
    released = true; clearTimeout(startup);
    try {
      process.send?.({ type: "detached" }, error => {
        if (error) { stop(); return; }
        if (process.connected) process.disconnect();
      });
    } catch { stop(); }
  };
  let inactivity = STARTUP_TIMEOUT, startup = setTimeout(stop, inactivity);
  // Until detach, capture progress, each phase and each uploaded chunk restart both sides' inactivity timers.
  const progress = () => {
    if (reported) return;
    startup.refresh();
    try { process.send?.({ type: "progress" }, () => {}); } catch { /* A lost parent is handled by disconnect. */ }
  };
  process.on("disconnect", disconnected); process.on("message", detach);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, stop);
  try {
    const config = options = await new Promise<SyncServiceOptions>((resolve, reject) => {
      const failed = () => { process.off("message", receive); reject(new Error(STARTUP_ERROR)); };
      const receive = (message: unknown) => {
        abort.signal.removeEventListener("abort", failed); process.off("message", receive);
        try {
          const value = message as { type?: unknown; options?: SyncServiceOptions } | null;
          if (value?.type !== "start" || !value.options) throw new Error(STARTUP_ERROR);
          resolve(validateOptions(value.options));
        } catch (error) { reject(error); }
      };
      process.on("message", receive); abort.signal.addEventListener("abort", failed, { once: true });
      if (abort.signal.aborted) failed();
      else try { process.send?.({ type: "boot" }, error => { if (error) failed(); }); } catch { failed(); }
    });
    if (config.startupInactivityMs) { inactivity = config.startupInactivityMs; clearTimeout(startup); startup = setTimeout(stop, inactivity); }
    const state: SyncState = { pid: process.pid, projectId: config.projectId, root: config.root, origin: config.origin, startedAt: new Date().toISOString() };
    writeState(config.stateFile, state);
    // After a stop removed the file, a late write must not bring it back.
    const record = () => { if (!abort.signal.aborted && readSyncState(config.stateFile)?.pid === process.pid) writeState(config.stateFile, state); };
    // Special files the latest capture left out; the first capture's are reported once, at startup.
    let skipped: string[] = [];
    const ready = () => {
      if (reported) return;
      reported = true;
      process.send?.({ type: "ready", skipped: { count: skipped.length, paths: skipped.slice(0, 20) } }, error => { if (error) stop(); });
    };
    // `held`: the host kept the last pushed content but cannot apply it for a lasting reason.
    let previous: WorkspaceManifest | undefined, committed: string | undefined, lastFull = 0, failures = 0, pushFailures = 0, held = false;
    while (!abort.signal.aborted && readSyncState(config.stateFile)?.pid === process.pid) {
      let content: string | undefined, pushing = false;
      try {
        const forceFull = Date.now() - lastFull > 60000;
        progress();
        const left: string[] = [];
        const manifest = await captureWorkspace({ roots: [config.root], cwd: config.root, storeDir: config.storeDir, signal: abort.signal, previous, forceFull, onProgress: progress, onSkipped: path => left.push(path) });
        previous = manifest;
        if (left.length !== skipped.length) { if (left.length) state.skipped = left.length; else delete state.skipped; record(); }
        skipped = left;
        if (forceFull) lastFull = Date.now();
        content = fingerprint(manifest);
        if (content !== committed) {
          pushing = true; held = false;
          progress();
          const { generation } = await api<{ generation: string }>(config, "begin", abort.signal, {});
          await uploadMissingChunks({ storeDir: config.storeDir, hashes: manifest.entries.flatMap(entry => entry.chunks ?? []), signal: abort.signal, progress, transport: {
            has: async (hashes, signal) => (await api<{ missing: unknown }>(config, "has", signal, { hashes })).missing,
            putBatch: async (body, signal) => {
              try { await api(config, "blobs", signal, undefined, body, BATCH_TIMEOUT); }
              catch (error) { if (error instanceof MissingRouteError) return "unsupported"; throw error; }
            },
            put: async (hash, bytes, signal) => { await api(config, `blob/${hash}`, signal, undefined, bytes); },
          } });
          // The host applies inside this request and reports nothing until it finishes; a heartbeat keeps startup alive meanwhile.
          const heartbeat = setInterval(progress, Math.min(5000, Math.floor(inactivity / 4)));
          try { await api(config, "commit", abort.signal, { generation, manifest }, undefined, COMMIT_TIMEOUT); }
          finally { clearInterval(heartbeat); }
          committed = content; pushFailures = 0;
          state.lastCommitAt = new Date().toISOString(); state.lastManifest = manifest.id; delete state.problem;
          record();
        } else if (held) {
          // An explicit apply on the host, or a reset, replaces the failure marker; then normal pushing resumes.
          if (await pendingReason(config, abort.signal) !== "apply-failed") { held = false; pushFailures = 0; delete state.problem; record(); }
        } else if (state.problem) { delete state.problem; record(); }
        failures = 0;
        ready();
      } catch (error) {
        if (abort.signal.aborted) break;
        if (error instanceof FatalSyncError) { reason = error.message; break; }
        failures += 1;
        if (pushing) pushFailures += 1;
        // A held apply failure stays the reported problem until it is resolved or new content is pushed.
        if (!held || pushing) state.problem = (error instanceof Error ? error.message : "Workspace sync is retrying").slice(0, 200);
        // The host received this content and kept it pending; pushing the same content again would fail the same way.
        if (pushing && error instanceof SyncRequestError && error.code === "apply-failed" && LASTING.has(error.category ?? "")) { committed = content; held = true; }
        record();
        if (held) ready();
        else if (!reported && failures > 5) { reason = state.problem; break; }
      }
      // After startup, consecutive failed pushes back off exponentially, from the poll interval to five minutes.
      const wait = reported && pushFailures ? Math.min(BACKOFF_LIMIT, POLL * 2 ** (pushFailures - 1)) : POLL;
      await delay(wait, undefined, { signal: abort.signal }).catch(() => {});
    }
  } catch (error) { process.exitCode = 1; if (error instanceof Error && error.message !== STARTUP_ERROR) reason ??= error.message; }
  finally {
    stop(); clearTimeout(startup);
    process.off("disconnect", disconnected); process.off("message", detach);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(name, stop);
    try { if (options && readSyncState(options.stateFile)?.pid === process.pid) rmSync(options.stateFile, { force: true }); } catch { /* Unreadable state is left for the owner. */ }
    if (process.connected && process.send) try { process.send({ type: "failed", reason }, () => { if (process.connected) process.disconnect(); }); } catch { /* Parent already exited. */ }
  }
}

if (process.argv[2] === "--sync-service" && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.send)
  void runSyncService();
