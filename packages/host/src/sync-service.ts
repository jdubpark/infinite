import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkspace, readWorkspaceBlob, type WorkspaceManifest } from "./workspace-checkpoint.js";

export interface SyncServiceOptions { origin: string; token: string; projectId: string; root: string; stateFile: string; storeDir: string }
export interface SyncState { pid: number; projectId: string; root: string; origin: string; startedAt: string; lastCommitAt?: string; lastManifest?: string; problem?: string }

/** Startup inactivity bound: the child reports each phase and uploaded chunk, and every report restarts it. */
const STARTUP_TIMEOUT = 60000;
const STARTUP_ERROR = "The workspace sync service did not complete its first upload. Nothing was applied on the host.";
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
      !/^[a-z0-9-]{1,80}$/.test(options.projectId) || !/^[\x21-\x7e]{32,200}$/.test(options.token)) throw new Error("Invalid sync pairing.");
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
export async function startSyncService(options: SyncServiceOptions): Promise<void> {
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
  await new Promise<void>((resolve, reject) => {
    let started = false, ready = false, detached = false, finished = false;
    const timer = setTimeout(() => fail(), STARTUP_TIMEOUT);
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("disconnect", disconnected); child.off("exit", exited); child.off("error", failed); };
    const fail = (reason?: string) => {
      if (finished) return;
      finished = true; cleanup();
      if (child.connected) try { child.disconnect(); } catch { /* Already disconnected. */ }
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 4000); killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
      reject(new Error(reason ? `${STARTUP_ERROR} ${reason}` : STARTUP_ERROR));
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
      try { child.send({ type: "detach" }, error => { if (error) fail(); }); } catch { fail(); }
    };
    child.on("error", () => {});
    child.on("error", failed); child.on("exit", exited); child.on("disconnect", disconnected); child.on("message", message);
  });
}

class FatalSyncError extends Error {}
async function api<T>(options: SyncServiceOptions, path: string, signal: AbortSignal, body: unknown, raw?: Buffer): Promise<T> {
  const response = await fetch(`${options.origin}/api/projects/${options.projectId}/sync/${path}`, {
    method: raw ? "PUT" : "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    headers: { Authorization: `Bearer ${options.token}`, "Content-Type": raw ? "application/octet-stream" : "application/json" },
    body: raw ? new Uint8Array(raw) : JSON.stringify(body),
  });
  if (!response.ok) {
    const reply = await response.json().catch(() => ({})) as { error?: unknown };
    const reason = typeof reply.error === "string" ? reply.error : `HTTP ${response.status}`;
    // A revoked key or a removed project will not recover by retrying.
    throw [401, 403, 404].includes(response.status) ? new FatalSyncError(`Host refused sync (${response.status}): ${reason}`) : new Error(reason);
  }
  return await response.json() as T;
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
  const startup = setTimeout(stop, STARTUP_TIMEOUT);
  // Until detach, each phase and uploaded chunk restarts both sides' inactivity timers.
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
    const state: SyncState = { pid: process.pid, projectId: config.projectId, root: config.root, origin: config.origin, startedAt: new Date().toISOString() };
    writeState(config.stateFile, state);
    // After a stop removed the file, a late write must not bring it back.
    const record = () => { if (!abort.signal.aborted && readSyncState(config.stateFile)?.pid === process.pid) writeState(config.stateFile, state); };
    let previous: WorkspaceManifest | undefined, committed: string | undefined, lastFull = 0, failures = 0;
    while (!abort.signal.aborted && readSyncState(config.stateFile)?.pid === process.pid) {
      try {
        const forceFull = Date.now() - lastFull > 60000;
        progress();
        const manifest = await captureWorkspace({ roots: [config.root], cwd: config.root, storeDir: config.storeDir, signal: abort.signal, previous, forceFull });
        previous = manifest;
        if (forceFull) lastFull = Date.now();
        const content = fingerprint(manifest);
        if (content !== committed) {
          progress();
          const { generation } = await api<{ generation: string }>(config, "begin", abort.signal, {});
          const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
          for (let offset = 0; offset < hashes.length; offset += 512) {
            const batch = hashes.slice(offset, offset + 512);
            progress();
            const { missing } = await api<{ missing: unknown }>(config, "has", abort.signal, { hashes: batch });
            // Upload only chunks this manifest named; the reply never selects other local content.
            if (!Array.isArray(missing) || missing.some(hash => !batch.includes(hash))) throw new Error("Invalid sync transfer reply");
            for (const hash of missing as string[]) {
              await api(config, `blob/${hash}`, abort.signal, undefined, Buffer.from(await readWorkspaceBlob(config.storeDir, hash), "base64"));
              progress();
            }
          }
          await api(config, "commit", abort.signal, { generation, manifest });
          committed = content;
          state.lastCommitAt = new Date().toISOString(); state.lastManifest = manifest.id; delete state.problem;
          record();
        } else if (state.problem) { delete state.problem; record(); }
        failures = 0;
        if (!reported) { reported = true; process.send?.({ type: "ready" }, error => { if (error) stop(); }); }
      } catch (error) {
        if (abort.signal.aborted) break;
        if (error instanceof FatalSyncError) { reason = error.message; break; }
        failures += 1;
        state.problem = (error instanceof Error ? error.message : "Workspace sync is retrying").slice(0, 200); record();
        if (!reported && failures > 5) { reason = state.problem; break; }
      }
      await delay(3000, undefined, { signal: abort.signal }).catch(() => {});
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
