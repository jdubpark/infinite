import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { hashToken } from "../packages/host/src/config.js";
import { createApp } from "../packages/host/src/server.js";
import { workerCall } from "../packages/host/src/ipc.js";
import { unseal } from "../packages/host/src/vault.js";
import type { Config, Role, ControlLease } from "../packages/host/src/types.js";

const DEFAULT_WAIT_MS = 10_000;

export const waitFor = async <T>(
  fn: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeout = DEFAULT_WAIT_MS,
): Promise<T> => {
  const until = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < until) {
    last = await fn();
    if (accepts(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Condition was not reached; last state: ${JSON.stringify(last)}`);
};

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
  let ids: string[] = [], answered = 0;
  try {
    ids = readdirSync(join(config.stateDir, "sessions")).filter((n) => /^[a-f0-9-]{36}$/i.test(n));
  } catch {
  }
  for (const id of ids)
    try {
      const actor = { id: "test-cleanup", label: "Test cleanup" };
      const state = await workerCall<{ capabilities?: { inputControl?: number } }>(config.runDir, id, { op: "state" });
      answered++;
      const lease = state.capabilities?.inputControl
        ? await workerCall<ControlLease>(config.runDir, id, { op: "control", action: "claim", actor, takeover: true }) : undefined;
      await workerCall(config.runDir, id, { op: "stop", requestId: randomUUID(), ...(lease ? { actor, leaseId: lease.id } : {}) });
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

type HostOptions = { agents?: Config["agents"]; config?: Partial<Config>; env?: NodeJS.ProcessEnv };

export function startHost(options: HostOptions = {}): Promise<Host> {
  return startHostWithPort(options, 3);
}

async function startHostWithPort(options: HostOptions, attemptsLeft: number): Promise<Host> {
  const root = mkdtempSync("/tmp/inf-test-");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
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
    port,
    origin,
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
  const configFile = join(root, "config.json");
  writeFileSync(configFile, JSON.stringify(config));
  let child: ChildProcess | undefined;

  const fetchApi = apiClient(origin, tokens);
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
    api.stderr!.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const exited = new AbortController();
    const abortProbe = () => exited.abort();
    api.once("exit", abortProbe);
    const signal = AbortSignal.any([exited.signal, AbortSignal.timeout(DEFAULT_WAIT_MS)]);
    const probe = apiClient(origin, tokens, signal);
    try {
      await waitFor(async () => {
        const response = await probe("/me").catch(() => undefined);
        if (api.exitCode !== null || api.signalCode !== null) throw new Error(diagnostics);
        return response?.status ?? 0;
      }, status => status === 200);
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

  try {
    await start();
  } catch (error) {
    await stop();
    const collision = `listen EADDRINUSE: address already in use 127.0.0.1:${port}`;
    if (attemptsLeft > 1 && options.config?.port === undefined && error instanceof Error && error.message.includes(collision)) {
      return startHostWithPort(options, attemptsLeft - 1);
    }
    throw error;
  }
  return { origin, root, config, tokens, fetchApi, start, stopApi, stop };
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

export async function inProcessHost(options?: { configure?: (config: Config) => void }) {
  const root = realpathSync(mkdtempSync("/tmp/inf-psync-guard-"));
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
  const host = createApp(config, key);
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
