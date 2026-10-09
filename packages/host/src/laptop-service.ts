import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { forwardExecutor, type ExecutorControl } from "./executor-tunnel.js";
import { captureWorkspace, hasWorkspaceBlobs, materializeWorkspace, putWorkspaceBlob, readWorkspaceBlob, validateWorkspaceManifest, type WorkspaceManifest } from "./workspace-checkpoint.js";

interface LaptopServiceOptions {
  origin: string;
  token: string;
  sessionId: string;
  workspaceToken: string;
  cwd: string;
  roots: string[];
  configFile: string;
}

const STARTUP_TIMEOUT = 30000;
const STARTUP_ERROR = "The laptop executor did not connect. Inspect the session before trying again; no command was replayed.";

/** One incremental transfer at a time, independent of the terminal and first tool. */
async function synchronizeWorkspace(options: LaptopServiceOptions, control: ExecutorControl, signal: AbortSignal) {
  const inside = (root: string, path: string) => { const rel = relative(root, path); return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  let directory = join(dirname(options.configFile), "workspaces", options.sessionId);
  if (options.roots.some(root => inside(root, directory))) directory = join(homedir(), ".infinite", "workspaces", options.sessionId);
  if (options.roots.some(root => inside(root, directory))) throw new Error("Workspace cache must be outside the selected project");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const storeDir = join(directory, "objects");
  let previous: WorkspaceManifest | undefined, recovered: string | undefined, lastFull = 0;
  while (!signal.aborted) {
    try {
      const status = await control("sync/status");
      if (status.location === "cloud") {
        const exported = await control("sync/export");
        const manifest = validateWorkspaceManifest(exported.manifest);
        const fingerprint = createHash("sha256").update(JSON.stringify(manifest.entries)).digest("hex");
        if (fingerprint !== recovered) {
          const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
          for (let offset = 0; offset < hashes.length; offset += 512) {
            const missing = await hasWorkspaceBlobs(storeDir, hashes.slice(offset, offset + 512));
            for (const hash of missing) {
              if (signal.aborted) return;
              const { base64 } = await control("sync/blob", { hash });
              await putWorkspaceBlob(storeDir, hash, base64);
            }
          }
          const destination = join(directory, "recovered", manifest.id);
          await materializeWorkspace({ manifest, storeDir, destination });
          await writeFile(join(directory, "recovery.json"), JSON.stringify({ checkpoint: status.checkpoint, cloudCheckpoint: manifest.id,
            capturedAt: manifest.capturedAt, destination, originalRoots: options.roots }), { mode: 0o600 });
          recovered = fingerprint;
        }
      } else {
        const begin = await control("sync/begin");
        const forceFull = Date.now() - lastFull > 60000;
        const manifest = await captureWorkspace({ roots: options.roots, cwd: options.cwd, storeDir, signal, previous, forceFull });
        const hashes = [...new Set(manifest.entries.flatMap(entry => entry.chunks ?? []))];
        for (let offset = 0; offset < hashes.length; offset += 512) {
          const { missing } = await control("sync/has", { hashes: hashes.slice(offset, offset + 512) });
          if (!Array.isArray(missing) || missing.some(hash => !hashes.includes(hash))) throw new Error("Invalid workspace transfer reply");
          for (const hash of missing) {
            if (signal.aborted) return;
            await control("sync/blob", { hash, base64: await readWorkspaceBlob(storeDir, hash) });
          }
        }
        await control("sync/commit", { ...begin, manifest });
        previous = manifest;
        if (forceFull) lastFull = Date.now();
      }
    } catch (error) {
      if (!signal.aborted) await control("sync/problem", { reason: error instanceof Error ? error.message.slice(0, 200) : "Workspace preparation is retrying" }).catch(() => {});
    }
    await delay(3000, undefined, { signal }).catch(() => {});
  }
}

/** Check the installed executable before creating a cloud session. */
export async function checkLaptopExecutor(): Promise<void> {
  if (process.platform === "win32") throw new Error("Laptop execution currently requires macOS or Linux.");
  let help: string;
  try {
    const { stdout, stderr } = await promisify(execFile)("codex", ["exec-server", "--help"], { timeout: 10000, maxBuffer: 65536 });
    help = stdout + stderr;
  } catch {
    throw new Error("The local Codex executor check failed. Install a Codex CLI with authenticated exec-server support.");
  }
  if (!help.includes("--ws-token-sha256") || !help.includes("--ws-auth"))
    throw new Error("The installed Codex lacks authenticated exec-server support. Update Codex before using laptop execution.");
}

function validateOptions(options: LaptopServiceOptions): LaptopServiceOptions {
  const origin = new URL(options.origin);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))) ||
      !/^[a-f0-9-]{36}$/.test(options.sessionId) ||
      !/^[\x21-\x7e]{32,200}$/.test(options.token) || !/^[\x21-\x7e]{32,200}$/.test(options.workspaceToken))
    throw new Error("Invalid laptop execution pairing.");
  const cwd = realpathSync(options.cwd);
  if (!statSync(cwd).isDirectory() || !Array.isArray(options.roots) || !options.roots.length || options.roots.length > 32)
    throw new Error("Invalid laptop workspace.");
  const roots = options.roots.map(root => {
    const path = realpathSync(root);
    if (!statSync(path).isDirectory()) throw new Error("Invalid laptop workspace.");
    if (path === sep || path === realpathSync(homedir())) throw new Error("Select a project directory, not the entire home or filesystem.");
    return path;
  });
  if (!roots.some(root => {
    const path = relative(root, cwd);
    return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  })) throw new Error("The laptop working directory is outside the selected workspace.");
  return { ...options, origin: origin.origin, cwd, roots };
}

/** Launch once per session. The service and its executor survive terminal detachment. */
export async function startLaptopService(options: LaptopServiceOptions): Promise<void> {
  let validated: LaptopServiceOptions;
  try { validated = validateOptions(options); }
  catch { throw new Error("The laptop workspace or execution pairing is invalid. No executor was started."); }
  const file = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...(file.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []), file, "--laptop-service"], {
    cwd: validated.cwd, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  // Device credentials are passed only through private IPC, never copied into
  // the service's arguments or environment.
  await new Promise<void>((resolve, reject) => {
    let started = false, ready = false, detached = false, finished = false;
    const timer = setTimeout(() => fail(), STARTUP_TIMEOUT);
    const cleanup = () => {
      clearTimeout(timer); child.off("message", message); child.off("disconnect", disconnected); child.off("exit", exited); child.off("error", failed);
    };
    const fail = () => {
      if (finished) return;
      finished = true; cleanup();
      if (child.connected) try { child.disconnect(); } catch { /* Already disconnected. */ }
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 4000); killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
      reject(new Error(STARTUP_ERROR));
    };
    const failed = () => fail();
    const exited = () => fail();
    const disconnected = () => {
      if (!detached) { fail(); return; }
      if (finished) return;
      finished = true; cleanup(); child.unref(); resolve();
    };
    const message = (value: unknown) => {
      if (!value || typeof value !== "object") { fail(); return; }
      const type = (value as { type?: unknown }).type;
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

// An inherited pipe keeps the executor tied to its service even if the service
// is killed. Its own process group is cleaned up on exit. This is lifecycle
// cleanup; it does not establish fencing for tools that escape that group.
const EXECUTOR_SUPERVISOR = `
  const {spawn}=require('node:child_process');
  const child=spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:['ignore','pipe','pipe']});
  let stopping=false;
  const kill=signal=>{if(child.pid)try{process.kill(-child.pid,signal)}catch{}};
  const stop=()=>{if(stopping)return;stopping=true;kill('SIGTERM');setTimeout(()=>{kill('SIGKILL');process.exit(1)},2000)};
  process.on('exit',()=>kill('SIGKILL'));process.stdout.on('error',stop);process.stderr.on('error',stop);
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  process.stdin.resume();process.stdin.on('end',stop);process.stdin.on('error',stop);
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,stop);
  child.on('error',()=>process.exit(1));child.on('exit',code=>{kill('SIGKILL');process.exit(code??1)});
`;

function executorEndpoint(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "", done = false;
    const finish = (url?: string) => {
      if (done) return;
      done = true; signal.removeEventListener("abort", abort);
      child.stdout?.off("data", read); child.stderr?.off("data", read);
      child.stdout?.resume(); child.stderr?.resume();
      if (url) resolve(url); else reject(new Error(STARTUP_ERROR));
    };
    const abort = () => finish();
    const read = (data: Buffer) => {
      text = (text + data.toString()).slice(-16384);
      const match = /ws:\/\/127\.0\.0\.1:(\d+)(?:\/)?(?=[\s"'])/.exec(text);
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) finish(`ws://127.0.0.1:${match[1]}`);
    };
    child.stdout?.on("data", read); child.stderr?.on("data", read);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) finish();
  });
}

async function runLaptopService(): Promise<void> {
  const abort = new AbortController();
  let released = false, reported = false, executor: ChildProcess | undefined, monitor: ReturnType<typeof setInterval> | undefined;
  const stop = () => abort.abort();
  const disconnected = () => { if (!released) stop(); };
  const detach = (value: unknown) => {
    if (reported && value && typeof value === "object" && (value as { type?: unknown }).type === "detach") {
      released = true; clearTimeout(startup);
      try {
        process.send?.({ type: "detached" }, error => {
          if (error) { stop(); return; }
          if (process.connected) process.disconnect();
        });
      } catch { stop(); }
    }
  };
  const startup = setTimeout(stop, STARTUP_TIMEOUT);
  process.on("disconnect", disconnected); process.on("message", detach);
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, stop);
  try {
    const options = await new Promise<LaptopServiceOptions>((resolve, reject) => {
      const failed = () => { process.off("message", receive); reject(new Error(STARTUP_ERROR)); };
      const receive = (message: unknown) => {
        abort.signal.removeEventListener("abort", failed);
        process.off("message", receive);
        try {
          const value = message as { type?: unknown; options: LaptopServiceOptions };
          if (value?.type !== "start") throw new Error(STARTUP_ERROR);
          resolve(validateOptions(value.options));
        } catch { reject(new Error(STARTUP_ERROR)); }
      };
      process.on("message", receive); abort.signal.addEventListener("abort", failed, { once: true });
      if (abort.signal.aborted) failed();
      else try { process.send?.({ type: "boot" }, error => { if (error) failed(); }); } catch { failed(); }
    });
    if (abort.signal.aborted) throw new Error(STARTUP_ERROR);
    const executorToken = randomBytes(32).toString("hex");
    executor = spawn(process.execPath, ["-e", EXECUTOR_SUPERVISOR, "codex", "exec-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token",
      "--ws-token-sha256", createHash("sha256").update(executorToken).digest("hex")], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    executor.on("error", stop); executor.on("exit", stop);
    executor.stdin?.on("error", stop);
    const executorUrl = await executorEndpoint(executor, abort.signal);
    const url = new URL(`/api/sessions/${options.sessionId}/executor`, options.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let checking = false;
    const checkSession = async () => {
      if (checking || abort.signal.aborted) return;
      checking = true;
      try {
        const response = await fetch(new URL(`/api/sessions/${options.sessionId}`, options.origin), {
          headers: { Authorization: `Bearer ${options.token}` }, redirect: "error", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
        });
        if ([401, 403, 404, 410].includes(response.status)) stop();
        if (response.ok) {
          const state = await response.json() as { status?: unknown };
          if (state.status === "exited") stop();
        } else await response.body?.cancel();
      } catch { /* A network outage does not replace the executor or replay work. */ }
      finally { checking = false; }
    };
    monitor = setInterval(() => { void checkSession(); }, 15000);
    let retryDelay = 1000;
    while (!abort.signal.aborted) {
      const transfer = new AbortController();
      try {
        await forwardExecutor({
          url: url.href, token: options.token, deviceHeaders: { "X-Infinite-Executor": options.workspaceToken }, executorUrl, executorToken, cwd: options.cwd, signal: abort.signal,
          onReady: control => {
            retryDelay = 1000;
            void synchronizeWorkspace(options, control, AbortSignal.any([abort.signal, transfer.signal])).catch(() => {});
            if (reported) return;
            reported = true;
            if (!process.connected || !process.send) { stop(); return; }
            process.send({ type: "ready" }, error => { if (error) stop(); });
          },
        });
      } catch { /* Only transport reconnection is retried, against this same exec-server. */ }
      finally { transfer.abort(); }
      if (!abort.signal.aborted) {
        await checkSession();
        await delay(retryDelay, undefined, { signal: abort.signal }).catch(() => {});
        retryDelay = Math.min(retryDelay * 2, 15000);
      }
    }
  } catch { process.exitCode = 1; }
  finally {
    stop(); clearTimeout(startup); clearInterval(monitor);
    process.off("disconnect", disconnected); process.off("message", detach);
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(name, stop);
    if (process.connected && process.send) try { process.send({ type: "failed" }, () => { if (process.connected) process.disconnect(); }); } catch { /* Parent already exited. */ }
    if (executor && executor.exitCode === null && executor.signalCode === null) {
      const child = executor;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3500);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.stdin?.end(); child.kill("SIGTERM");
      });
    }
  }
}

if (process.argv[2] === "--laptop-service" && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.send)
  void runLaptopService();
