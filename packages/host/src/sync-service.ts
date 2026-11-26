import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkspace, type WorkspaceManifest, type WorkspaceStoreTarget } from "./workspace-checkpoint.js";
import {
  collectSharedPool, currentBootId, currentProcessStart, discoverClientWorkspaceScopes,
  hasLegacyClientWriters, manifestChunkHashes, pruneScopeRefs,
} from "./workspace-pool-gc.js";
import { uploadMissingChunks } from "./chunk-upload.js";
import { shouldCaptureWorkspace, watchWorkspaceChanges } from "./workspace-changes.js";

export interface SyncServiceOptions {
  origin: string; token: string; projectId: string; root: string; stateFile: string; storeDir: string;
  sharedPoolDirectory?: string;
  publisherId?: string;
  startupInactivityMs?: number;
}
export interface SyncState {
  pid: number; projectId: string; root: string; origin: string; startedAt: string;
  publisherId?: string; lastCommitAt?: string; lastManifest?: string; problem?: string; skipped?: number;
  poolLeases?: true; bootId?: string; processStart?: string;
}
export interface SyncStart { skipped: { count: number; paths: string[] } }

const STARTUP_TIMEOUT = 60000;
const COMMIT_TIMEOUT = 30 * 60 * 1000;
const STARTUP_ERROR = "The workspace sync service did not complete its first upload. Nothing was applied on the host.";
const STALLED = "Run infinite sync again to resume; chunks already uploaded are kept.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 300);
function runningService(pid: unknown): pid is number {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return false;
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).includes("--sync-service"); }
  catch { return false; }
}
function canonical(path: string): string {
  const missing: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try { return join(realpathSync(current), ...missing); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw error;
      missing.unshift(basename(current));
    }
  }
}
const fingerprint = (manifest: WorkspaceManifest) =>
  createHash("sha256").update(JSON.stringify(manifest.entries.map(({ sourceStamp: _stamp, ...entry }) => entry))).digest("hex");

function validateOptions(options: SyncServiceOptions): SyncServiceOptions {
  const origin = new URL(options.origin);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) ||
      !/^[a-z0-9-]{1,80}$/.test(options.projectId) || !/^[\x21-\x7e]{32,200}$/.test(options.token) ||
      (options.startupInactivityMs !== undefined && (!Number.isInteger(options.startupInactivityMs) || options.startupInactivityMs < 100 || options.startupInactivityMs > STARTUP_TIMEOUT)))
    throw new Error("Invalid sync pairing.");
  if (options.publisherId !== undefined && !UUID.test(options.publisherId)) throw new Error("Invalid sync publisher identity.");
  const root = realpathSync(options.root);
  if (!statSync(root).isDirectory() || root === sep || root === realpathSync(homedir())) throw new Error("Select a project directory, not the entire home or filesystem.");
  const storeDir = canonical(options.storeDir), stateFile = canonical(options.stateFile);
  if (options.sharedPoolDirectory !== undefined && (typeof options.sharedPoolDirectory !== "string" || !options.sharedPoolDirectory))
    throw new Error("Invalid shared workspace storage.");
  const sharedPoolDirectory = options.sharedPoolDirectory === undefined ? undefined : canonical(options.sharedPoolDirectory);
  if ([storeDir, stateFile, ...(sharedPoolDirectory ? [sharedPoolDirectory] : [])].some(path => inside(root, path)))
    throw new Error("Sync storage must be outside the synced project.");
  return { ...options, origin: origin.origin, root, storeDir, stateFile, sharedPoolDirectory };
}

export const syncServiceRunning = (state: SyncState) => runningService(state.pid);
export function readSyncState(stateFile: string): SyncState | undefined {
  try { return JSON.parse(readFileSync(stateFile, "utf8")) as SyncState; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function publisherFile(stateFile: string) { return `${stateFile}.publisher`; }
function readPublisherId(stateFile: string, previous?: SyncState) {
  try {
    const saved = readFileSync(publisherFile(stateFile), "utf8").trim();
    if (UUID.test(saved)) return saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return previous?.publisherId && UUID.test(previous.publisherId) ? previous.publisherId : undefined;
}
function writePublisherId(stateFile: string, publisherId: string) {
  const file = publisherFile(stateFile);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${publisherId}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}
function writeState(stateFile: string, state: SyncState) {
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, stateFile);
}
export function stopSyncService(stateFile: string): boolean {
  const state = readSyncState(stateFile);
  if (!state) return false;
  const running = runningService(state.pid);
  if (running) try { process.kill(state.pid, "SIGTERM"); } catch {}
  rmSync(stateFile, { force: true });
  return running;
}

export async function startSyncService(options: SyncServiceOptions): Promise<SyncStart> {
  const validated = validateOptions(options);
  const existing = readSyncState(validated.stateFile);
  if (existing) {
    if (runningService(existing.pid)) throw new Error("A sync service already runs for this project. Stop it first.");
    rmSync(validated.stateFile, { force: true });
  }
  const existingPublisher = readPublisherId(validated.stateFile, existing);
  const publisherId = existingPublisher ?? randomUUID();
  if (!existingPublisher) writePublisherId(validated.stateFile, publisherId);
  const serviceOptions = { ...validated, publisherId };
  const file = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...(file.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []), file, "--sync-service"], {
    cwd: validated.root, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const result: SyncStart = { skipped: { count: 0, paths: [] } };
  await new Promise<void>((resolve, reject) => {
    let started = false, ready = false, detached = false, finished = false;
    const timer = setTimeout(() => fail(undefined, true), validated.startupInactivityMs ?? STARTUP_TIMEOUT);
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("disconnect", disconnected); child.off("exit", exited); child.off("error", failed); };
    const fail = (reason?: string, stalled = false) => {
      if (finished) return;
      finished = true; cleanup();
      if (child.connected) try { child.disconnect(); } catch {}
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 4000); killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
      reject(new Error(reason ? `${STARTUP_ERROR} ${reason}` : stalled ? `${STARTUP_ERROR} ${STALLED}` : STARTUP_ERROR));
    };
    const failed = () => fail();
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
        try { child.send({ type: "start", options: serviceOptions }, error => { if (error) fail(); }); } catch { fail(); }
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
class MissingRouteError extends FatalSyncError {}
class SyncRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly category?: string) { super(message); }
}
const POLL = 3000;
const BATCH_TIMEOUT = 120000;
const BACKOFF_LIMIT = 5 * 60 * 1000;
const LASTING = new Set(["permission", "cross-device", "special-file", "missing-path"]);
async function refusal(response: Response): Promise<never> {
  const reply = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown; category?: unknown };
  const reason = typeof reply.error === "string" ? reply.error : `HTTP ${response.status}`;
  if (response.status === 404 && (reply.code === undefined || reply.code === "route-not-found")) throw new MissingRouteError(`Host refused sync (${response.status}): ${reason}`);
  if ([401, 403, 404, 413].includes(response.status)) throw new FatalSyncError(`Host refused sync (${response.status}): ${reason}`);
  throw new SyncRequestError(reason, response.status, typeof reply.code === "string" ? reply.code : undefined, typeof reply.category === "string" ? reply.category : undefined);
}
async function api<T>(options: SyncServiceOptions, path: string, signal: AbortSignal, body: unknown, raw?: Buffer, timeout = 60000, generation?: string): Promise<T> {
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": raw ? "application/octet-stream" : "application/json",
    ...(options.publisherId ? { "X-Infinite-Sync-Publisher": options.publisherId } : {}),
    ...(generation ? { "X-Infinite-Sync-Generation": generation } : {}),
  };
  const response = await fetch(`${options.origin}/api/projects/${options.projectId}/sync/${path}`, {
    method: raw ? "PUT" : "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    headers,
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
  let changeDetector: Awaited<ReturnType<typeof watchWorkspaceChanges>>;
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
  const progress = () => {
    if (reported) return;
    startup.refresh();
    try { process.send?.({ type: "progress" }, () => {}); } catch {}
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
    const storeDir: WorkspaceStoreTarget = config.sharedPoolDirectory
      ? { directory: config.storeDir, sharedPoolDirectory: config.sharedPoolDirectory } : config.storeDir;
    const hostBoot = currentBootId();
    const procStart = await currentProcessStart();
    const state: SyncState = {
      pid: process.pid, projectId: config.projectId, root: config.root, origin: config.origin,
      startedAt: new Date().toISOString(), publisherId: config.publisherId, poolLeases: true,
      ...(hostBoot !== "unsupported" ? { bootId: hostBoot } : {}),
      ...(procStart !== undefined ? { processStart: procStart } : {}),
    };
    writeState(config.stateFile, state);
    const record = () => { if (!abort.signal.aborted && readSyncState(config.stateFile)?.pid === process.pid) writeState(config.stateFile, state); };
    let skipped: string[] = [];
    const ready = () => {
      if (reported) return;
      reported = true;
      process.send?.({ type: "ready", skipped: { count: skipped.length, paths: skipped.slice(0, 20) } }, error => { if (error) stop(); });
    };
    let previous: WorkspaceManifest | undefined, committed: string | undefined, lastFull = 0, failures = 0, pushFailures = 0, held = false;
    let firstIteration = true, previousIterationFailed = false, lastCaptureStartedAt = 0, lastPendingCheckAt = 0, lastPoolGcAt = Date.now();
    changeDetector = await watchWorkspaceChanges([config.root], join(config.storeDir, "watch-cache"));
    while (!abort.signal.aborted && readSyncState(config.stateFile)?.pid === process.pid) {
      let content: string | undefined, pushing = false;
      try {
        progress();
        const changed = await changeDetector?.take() ?? true;
        const capture = firstIteration || shouldCaptureWorkspace({ changed, previousFailed: previousIterationFailed, lastCaptureStartedAt, checkpointCurrent: true });
        firstIteration = false;
        if (capture) {
          lastCaptureStartedAt = Date.now();
          const forceFull = Date.now() - lastFull > 60000;
          const left: string[] = [];
          const manifest = await captureWorkspace({ roots: [config.root], cwd: config.root, storeDir, signal: abort.signal, previous, forceFull, onProgress: progress, onSkipped: path => left.push(path) });
          previous = manifest;
          if (left.length !== skipped.length) { if (left.length) state.skipped = left.length; else delete state.skipped; record(); }
          skipped = left;
          if (forceFull) lastFull = Date.now();
          content = fingerprint(manifest);
          if (content !== committed) {
            pushing = true; held = false;
            progress();
            const { generation } = await api<{ generation: string }>(config, "begin", abort.signal, {});
            const uploading = setInterval(progress, Math.min(5000, Math.floor(inactivity / 4)));
            try {
              await uploadMissingChunks({ storeDir, hashes: manifest.entries.flatMap(entry => entry.chunks ?? []), signal: abort.signal, progress, transport: {
                has: async (hashes, signal) => (await api<{ missing: unknown }>(config, "has", signal, { hashes }, undefined, 60000, generation)).missing,
                putBatch: async (body, signal) => {
                  try { await api(config, "blobs", signal, undefined, body, BATCH_TIMEOUT, generation); }
                  catch (error) { if (error instanceof MissingRouteError) return "unsupported"; throw error; }
                },
                put: async (hash, bytes, signal) => { await api(config, `blob/${hash}`, signal, undefined, bytes, 60000, generation); },
              } });
            } finally { clearInterval(uploading); }
            const heartbeat = setInterval(progress, Math.min(5000, Math.floor(inactivity / 4)));
            try { await api(config, "commit", abort.signal, { generation, manifest }, undefined, COMMIT_TIMEOUT, generation); }
            finally { clearInterval(heartbeat); }
            committed = content; pushFailures = 0;
            state.lastCommitAt = new Date().toISOString(); state.lastManifest = manifest.id; delete state.problem;
            record();
          } else if (state.problem && !held) { delete state.problem; record(); }
        }
        if (held && Date.now() - lastPendingCheckAt >= 30000) {
          lastPendingCheckAt = Date.now();
          if (await pendingReason(config, abort.signal) !== "apply-failed") { held = false; pushFailures = 0; delete state.problem; record(); }
        } else if (capture && !held && state.problem) { delete state.problem; record(); }
        failures = 0;
        const hadReported = reported;
        ready();
        if (hadReported && config.sharedPoolDirectory && previous && content === committed) {
          await pruneScopeRefs({ scopeDirectory: config.storeDir, keepHashes: manifestChunkHashes([previous]), sharedPoolDirectory: config.sharedPoolDirectory, signal: abort.signal }).catch(() => {});
          if (Date.now() - lastPoolGcAt >= 60 * 60 * 1000) {
            lastPoolGcAt = Date.now();
            await discoverClientWorkspaceScopes(config.sharedPoolDirectory)
              .then(clientScopes => collectSharedPool({
                sharedPoolDirectory: config.sharedPoolDirectory!,
                scopeDirectories: [...new Set([config.storeDir, ...clientScopes])],
                hasLegacyWriters: () => hasLegacyClientWriters(dirname(config.sharedPoolDirectory!), process.pid),
                signal: abort.signal,
              }))
              .catch(() => {});
          }
        }
        previousIterationFailed = false;
      } catch (error) {
        if (abort.signal.aborted) break;
        if (error instanceof FatalSyncError) { reason = error.message; break; }
        previousIterationFailed = true;
        failures += 1;
        if (pushing) pushFailures += 1;
        if (!held || pushing) state.problem = (error instanceof Error ? error.message : "Workspace sync is retrying").slice(0, 200);
        if (pushing && error instanceof SyncRequestError && error.code === "apply-failed" && LASTING.has(error.category ?? "")) { committed = content; held = true; pushFailures = 0; }
        record();
        if (held) ready();
        else if (!reported && failures > 5) { reason = state.problem; break; }
      }
      const wait = reported && pushFailures ? Math.min(BACKOFF_LIMIT, POLL * 2 ** (pushFailures - 1)) : POLL;
      await delay(wait, undefined, { signal: abort.signal }).catch(() => {});
    }
  } catch (error) { process.exitCode = 1; if (error instanceof Error && error.message !== STARTUP_ERROR) reason ??= error.message; }
  finally {
    await changeDetector?.close();
    stop(); clearTimeout(startup);
    process.off("disconnect", disconnected); process.off("message", detach);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(name, stop);
    try { if (options && readSyncState(options.stateFile)?.pid === process.pid) rmSync(options.stateFile, { force: true }); } catch {}
    if (process.connected && process.send) try { process.send({ type: "failed", reason }, () => { if (process.connected) process.disconnect(); }); } catch {}
  }
}

if (process.argv[2] === "--sync-service" && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.send)
  void runSyncService();
