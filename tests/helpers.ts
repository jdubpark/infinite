import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { hashToken } from "../packages/host/src/config.js";
import { createApp } from "../packages/host/src/server.js";
import { readRecordedSocketPath, workerCall, type SocketTarget } from "../packages/host/src/ipc.js";
import { unseal } from "../packages/host/src/vault.js";
import type { Config, Role, ControlLease } from "../packages/host/src/types.js";

const HOST_STARTUP_TIMEOUT_MS = 45_000;

export const waitFor = async <T>(
  fn: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeout = 10000,
): Promise<T> => {
  const until = performance.now() + timeout;
  let last: T | undefined;
  while (performance.now() < until) {
    last = await fn();
    if (accepts(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Condition was not reached; last state: ${JSON.stringify(last)}`);
};

export async function moveWorkerClock(worker: ChildProcess, file: string, ms: number) {
  writeFileSync(file, String(ms));
  worker.kill("SIGUSR2");
  await waitFor(async () => readFileSync(file, "utf8"), text => text === `moved ${ms}`);
}

export function processes(): { pid: number; parent: number; command: string }[] {
  return execFileSync("ps", ["-ww", "-eo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return row ? [{ pid: Number(row[1]), parent: Number(row[2]), command: row[3]! }] : [];
  });
}

export const WORKER_ENTRY = "/packages/host/src/worker.";

function hostWorkers(config: Config, workers: readonly { pid: number }[], listed: readonly number[]): number[] {
  const running = new Set(workers.map(row => row.pid));
  const pids = new Set(listed.filter(pid => running.has(pid)));
  let key: Buffer, ids: string[];
  try { key = readFileSync(config.keyFile); ids = readdirSync(join(config.stateDir, "sessions")); } catch { return [...pids]; }
  for (const id of ids) try {
    const pid = unseal<{ workerPid?: number }>(key, `${id}:status`, readFileSync(join(config.stateDir, "sessions", id, "status.sealed"), "utf8")).workerPid;
    if (pid !== undefined && running.has(pid)) pids.add(pid);
  } catch { }
  return [...pids];
}

const WORKER_START_MS = 10000;

function launching(config: Config) {
  const sessions = join(config.stateDir, "sessions");
  try { return readdirSync(sessions).some(id => !existsSync(join(sessions, id, "status.sealed"))); } catch { return false; }
}

export async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export const demoProfile = () => ({
  command: process.execPath,
  args: ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/demo.ts")],
});

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
}

export interface Host {
  origin: string;
  root: string;
  config: Config;
  tokens: Record<Role, string>;
  fetchApi: (path: string, role?: Role | null, body?: unknown, headers?: Record<string, string>, method?: string) => Promise<ApiResponse>;
  start: () => Promise<void>;
  stopApi: () => Promise<void>;
  stop: () => Promise<void>;
}

export function apiClient(origin: string, tokens: Record<Role, string>, signal?: AbortSignal): Host["fetchApi"] {
  return async (path, role = "owner", body, headers = {}, method) => {
    const response = await fetch(origin + "/api" + path, {
      signal,
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        connection: "close",
        ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

export async function stopSessionWorkers(config: Config) {
  let ids: string[] = [], answered = 0, key: Buffer | undefined;
  try {
    ids = readdirSync(join(config.stateDir, "sessions")).filter((n) => /^[a-f0-9-]{36}$/i.test(n));
  } catch {
  }
  try { key = readFileSync(config.keyFile); } catch { }
  const target: SocketTarget = key ? { runDir: config.runDir, socketDir: config.socketDir, recordedSocket: id => readRecordedSocketPath(config.stateDir, key!, id) } : config;
  for (const id of ids)
    try {
      const actor = { id: "test-cleanup", label: "Test cleanup" };
      const state = await workerCall<{ capabilities?: { inputControl?: number } }>(target, id, { op: "state" });
      answered++;
      const lease = state.capabilities?.inputControl
        ? await workerCall<ControlLease>(target, id, { op: "control", action: "claim", actor, takeover: true }) : undefined;
      await workerCall(target, id, { op: "stop", requestId: randomUUID(), ...(lease ? { actor, leaseId: lease.id } : {}) });
    } catch {
    }
  return answered;
}

export async function endSessionWorkers(config: Config, started?: readonly number[], limitMs = 30000) {
  const until = Date.now() + limitMs, heardBy = Date.now() + Math.min(limitMs, WORKER_START_MS);
  for (;;) {
    await stopSessionWorkers(config);
    const unheard = !started && Date.now() < heardBy && launching(config);
    const workers = processes().filter(row => row.command.includes(WORKER_ENTRY));
    const mine = hostWorkers(config, workers, started ?? []);
    const starting = unheard ? workers.filter(row => row.parent === process.pid && !mine.includes(row.pid)) : [];
    if (mine.length + starting.length === 0) return;
    if (Date.now() > until) {
      for (const pid of mine) try { process.kill(pid, "SIGKILL"); } catch { }
      throw new Error(`Session workers still ran ${limitMs} ms after the test stopped them and were killed: ${mine.join(", ")}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export async function startHost(options: { agents?: Config["agents"]; config?: Partial<Config>; env?: NodeJS.ProcessEnv } = {}): Promise<Host> {
  const root = mkdtempSync(join(tmpdir(), "inf-"));
  const initialPort = options.config?.port ?? await freePort();
  let listenerOrigin = `http://127.0.0.1:${initialPort}`;
  const tokens: Record<Role, string> = {
    owner: randomBytes(32).toString("base64url"),
    controller: randomBytes(32).toString("base64url"),
    viewer: randomBytes(32).toString("base64url"),
  };
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const keyFile = join(root, "key");
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const config: Config = {
    port: initialPort,
    origin: listenerOrigin,
    keyFile,
    stateDir: join(root, "state"),
    runDir: join(root, "run"),
    environment: "local",
    enableDemo: true,
    maxSessions: 24,
    projects: [{ id: "rehearsal", name: "Rehearsal", path: cwd }],
    tokens: (Object.keys(tokens) as Role[]).map((role) => ({ id: role, label: role, role, hash: hashToken(tokens[role]) })),
    agents: options.agents ?? { demo: demoProfile() },
    ...options.config,
  };
  const syncConfigOrigin = options.config?.origin === undefined || options.config.origin === listenerOrigin;
  const configFile = join(root, "config.json");
  writeFileSync(configFile, JSON.stringify(config));
  let child: ChildProcess | undefined;

  let client = apiClient(listenerOrigin, tokens);
  const fetchApi: Host["fetchApi"] = (...args) => client(...args);
  const bindPort = (nextPort: number) => {
    const previousListener = listenerOrigin;
    config.port = nextPort;
    listenerOrigin = `http://127.0.0.1:${nextPort}`;
    if (syncConfigOrigin || config.origin === previousListener) config.origin = listenerOrigin;
    writeFileSync(configFile, JSON.stringify(config));
    client = apiClient(listenerOrigin, tokens);
  };
  const stopApi = async () => {
    const api = child;
    if (!api || api.exitCode !== null || api.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      api.once("exit", () => resolve());
      api.kill("SIGKILL");
    });
  };
  const start = async () => {
    const api = spawn(process.execPath, ["--import", "tsx", resolve("packages/host/src/cli.ts"), "serve", "--config", configFile], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });
    child = api;
    let diagnostics = "";
    const stderrDone = new Promise<void>((resolveStderr) => {
      api.stderr!.once("end", resolveStderr);
      api.stderr!.once("close", resolveStderr);
    });
    api.stderr!.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const exited = new AbortController();
    const abortProbe = () => exited.abort();
    api.once("exit", abortProbe);
    const signal = AbortSignal.any([exited.signal, AbortSignal.timeout(HOST_STARTUP_TIMEOUT_MS)]);
    const probe = apiClient(listenerOrigin, tokens, signal);
    try {
      await waitFor(async () => {
        const response = await probe("/me").catch(() => undefined);
        if (api.exitCode !== null || api.signalCode !== null) {
          await Promise.race([stderrDone, new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1000))]);
          throw new Error(diagnostics || `Host exited before listening (${api.signalCode ?? api.exitCode})`);
        }
        return response?.status ?? 0;
      }, status => status === 200, HOST_STARTUP_TIMEOUT_MS);
    } finally {
      api.off("exit", abortProbe);
    }
  };
  const stop = async () => {
    const floor = new Promise((resolve) => setTimeout(resolve, 1700));
    const api = child;
    let started: number[] = [];
    if (api?.pid !== undefined && api.exitCode === null && api.signalCode === null) {
      api.kill("SIGSTOP");
      try { started = processes().filter(row => row.parent === api.pid && row.command.includes(WORKER_ENTRY)).map(row => row.pid); } catch { }
    }
    try {
      await stopApi();
      await endSessionWorkers(config, started);
      await floor;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  const canRebind = options.config?.port === undefined;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await start();
        break;
      } catch (error) {
        if (!canRebind || attempt >= 4 || !/EADDRINUSE/.test(String(error))) throw error;
        await stopApi();
        bindPort(await freePort());
      }
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin: listenerOrigin, root, config, tokens, fetchApi, start, stopApi, stop };
}

export async function claimControl(
  host: Host,
  sessionId: string,
  role: Role,
  options: { takeover?: boolean; clientId?: string } = {},
) {
  const clientId = options.clientId ?? randomUUID();
  const claimed = await host.fetchApi(
    `/sessions/${sessionId}/control`,
    role,
    { action: "claim", ...(options.takeover ? { takeover: true } : {}) },
    { "X-Infinite-Client": clientId },
  );
  if (claimed.status !== 200) throw new Error(`Control claim failed: ${JSON.stringify(claimed.body)}`);
  const lease = claimed.body.control as ControlLease;
  return { lease, headers: { "X-Infinite-Client": clientId, "X-Infinite-Control": lease.id } };
}

export async function inProcessHost(options?: { configure?: (config: Config) => void; appOptions?: Parameters<typeof createApp>[2] }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-")));
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const key = randomBytes(32);
  const keyFile = join(root, "key"); writeFileSync(keyFile, key, { mode: 0o600 });
  const roles: Role[] = ["owner", "controller", "viewer"];
  const tokens = Object.fromEntries(roles.map(role => [role, randomBytes(32).toString("base64url")])) as Record<Role, string>;
  const config: Config = {
    port: 0, origin: "http://127.0.0.1", keyFile, stateDir: join(root, "state"), runDir: join(root, "run"),
    environment: "local", enableDemo: true, maxSessions: 24, agents: { demo: demoProfile() },
    projects: [{ id: "rehearsal", name: "Rehearsal", path: workspace }],
    tokens: roles.map(role => ({ id: role, label: role, role, hash: hashToken(tokens[role]) })),
  };
  options?.configure?.(config);
  const host = createApp(config, key, options?.appOptions);
  await new Promise<void>(resolve => host.server.listen(0, "127.0.0.1", resolve));
  config.port = (host.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`;
  return {
    ...host, root, config, origin, tokens, fetchApi: apiClient(origin, tokens),
    stop: async () => {
      const floor = new Promise(resolve => setTimeout(resolve, 1700));
      try {
        const closing = host.closeConnections();
        await new Promise<void>(resolve => host.server.close(() => resolve()));
        await closing;
        await host.missions.idle(); await host.teams.idle();
        await endSessionWorkers(config);
        await floor;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function hasSecureAncestors(directory: string, trustedUid: number): boolean {
  let current = directory;
  for (; ; current = dirname(current)) {
    let info;
    try { info = lstatSync(current); } catch { return false; }
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    if ((info.uid !== 0 && info.uid !== trustedUid) || (info.mode & 0o022) !== 0) return false;
    if (current === "/") return true;
  }
}

function isOutsideDirectory(candidate: string, boundary: string): boolean {
  const rel = relative(boundary, candidate);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function mkdtempSecure(prefix: string): string {
  const uid = process.getuid!();
  let home: string | undefined;
  try { home = realpathSync(homedir()); } catch { }
  const candidates = [
    process.env.INFINITE_TEST_STAGING_ROOT,
    process.env.XDG_RUNTIME_DIR,
    process.platform === "linux" ? `/run/user/${uid}` : undefined,
    tmpdir(),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const canonical = realpathSync(candidate);
      if (home && !isOutsideDirectory(canonical, home)) continue;
      accessSync(canonical, fsConstants.W_OK | fsConstants.X_OK);
      if (!hasSecureAncestors(canonical, uid)) continue;
      const root = realpathSync(mkdtempSync(join(canonical, prefix)));
      chmodSync(root, 0o700);
      return root;
    } catch { }
  }
  throw new Error("No writable non-home directory with secure ancestors is available; set INFINITE_TEST_STAGING_ROOT or XDG_RUNTIME_DIR.");
}
