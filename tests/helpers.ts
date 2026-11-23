import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { hashToken } from "../packages/host/src/config.js";
import { createApp } from "../packages/host/src/server.js";
import { workerCall } from "../packages/host/src/ipc.js";
import { unseal } from "../packages/host/src/vault.js";
import type { Config, Role, ControlLease } from "../packages/host/src/types.js";

export const waitFor = async <T>(
  fn: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeout = 10000,
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

/** The running processes, for a test that must see what a host has started or left behind. `age` is in seconds. */
export function processes(): { pid: number; parent: number; age: number; command: string }[] {
  return execFileSync("ps", ["-ww", "-eo", "pid=,ppid=,etime=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").flatMap(line => {
    // The elapsed time reads [[days-]hours:]minutes:seconds.
    const row = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(line);
    return row ? [{ pid: Number(row[1]), parent: Number(row[2]), age: ((Number(row[3] ?? 0) * 24 + Number(row[4] ?? 0)) * 60 + Number(row[5])) * 60 + Number(row[6]), command: row[7]! }] : [];
  });
}

/** What a session worker's command line holds. Its command line names no session. */
export const WORKER_ENTRY = "/packages/host/src/worker.";
/** A worker that has not listened after this many seconds is not waited for: the host that started it gave up after about four. */
const WORKER_START_SECONDS = 6;
/** The hosts that run in this process. A worker of another one is never taken for a worker that is still starting. */
const hostsHere = new Set<Config>();
/** Names a host that runs in this process, so that the stop of another one can tell their workers apart. */
export function hostInThisProcess(config: Config): Config { hostsHere.add(config); return config; }

/** The worker processes among `workers` that belong to this host: the pid each listening worker recorded, and every listed pid. */
function hostWorkers(config: Config, workers: readonly { pid: number }[], listed: readonly number[] = []): number[] {
  const running = new Set(workers.map(row => row.pid));
  const pids = new Set(listed.filter(pid => running.has(pid)));
  let key: Buffer, ids: string[];
  try { key = readFileSync(config.keyFile); ids = readdirSync(join(config.stateDir, "sessions")); } catch { return [...pids]; }
  for (const id of ids) try {
    const pid = unseal<{ workerPid?: number }>(key, `${id}:status`, readFileSync(join(config.stateDir, "sessions", id, "status.sealed"), "utf8")).workerPid;
    if (pid !== undefined && running.has(pid)) pids.add(pid);
  } catch { /* no status record: the worker has not listened yet, or a test stands a socket in for it */ }
  return [...pids];
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
  // Response bodies are untyped JSON in these tests.
  body: any;
}

export interface Host {
  origin: string;
  root: string;
  config: Config;
  tokens: Record<Role, string>;
  fetchApi: (path: string, role?: Role | null, body?: unknown, headers?: Record<string, string>, method?: string) => Promise<ApiResponse>;
  /** Start (or restart) the API process; detached session workers keep running across restarts. */
  start: () => Promise<void>;
  /** Kill only the API process. */
  stopApi: () => Promise<void>;
  /** Stop every session worker and the API, then remove the temporary state. */
  stop: () => Promise<void>;
}

/** JSON requests to an API at `origin`, authenticated with the named role's device key. */
export function apiClient(origin: string, tokens: Record<Role, string>): Host["fetchApi"] {
  return async (path, role = "owner", body, headers = {}, method) => {
    const response = await fetch(origin + "/api" + path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
}

/** Stop every session worker recorded under `config.stateDir`, then wait for them to exit. */
/** Asks every session worker under the state directory to stop; returns how many were still answering. */
export async function stopSessionWorkers(config: Config) {
  let ids: string[] = [], answered = 0;
  try {
    ids = readdirSync(join(config.stateDir, "sessions")).filter((n) => /^[a-f0-9-]{36}$/.test(n));
  } catch {
    /* no sessions were created */
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
      /* already exited */
    }
  return answered;
}

/**
 * Stops the session workers of a host and returns when none of them runs. Stop whatever starts sessions before the call.
 *
 * One request is not enough: a worker that is not listening yet does not hear it, and a worker whose provider is still
 * starting refuses it. So the request repeats while a worker process of this host runs. A worker counts by its process,
 * never by an answer: a test may stand a socket in for a worker, and that answers for as long as the test runs.
 *
 * `started` lists the workers of a host that ran in a child process. Without it the host ran in this process: a worker
 * that is not listening yet has no record there, so the call also waits while a worker child of this process is young
 * and no host of this process has recorded it. After `limitMs` the workers of this host that still run are killed and
 * the call throws.
 */
export async function endSessionWorkers(config: Config, started?: readonly number[], limitMs = 30000) {
  const until = Date.now() + limitMs;
  try {
    for (;;) {
      await stopSessionWorkers(config);
      const workers = processes().filter(row => row.command.includes(WORKER_ENTRY));
      const mine = hostWorkers(config, workers, started);
      const known = new Set([...mine, ...[...hostsHere].filter(host => host !== config).flatMap(host => hostWorkers(host, workers))]);
      const starting = started ? [] : workers.filter(row => row.parent === process.pid && !known.has(row.pid) && row.age < WORKER_START_SECONDS);
      if (mine.length + starting.length === 0) return;
      if (Date.now() > until) {
        // A worker that starts and is never recorded belongs to no host this call can name, so it is not a failure here.
        if (!mine.length) return;
        for (const pid of mine) try { process.kill(pid, "SIGKILL"); } catch { /* it ended meanwhile */ }
        throw new Error(`Session workers still ran ${limitMs} ms after the test stopped them and were killed: ${mine.join(", ")}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    hostsHere.delete(config);
  }
}

/** Boots a real API (`cli.ts serve`) on a free port with owner, controller and viewer device keys. */
export async function startHost(options: { agents?: Config["agents"]; config?: Partial<Config>; env?: NodeJS.ProcessEnv } = {}): Promise<Host> {
  // Unix socket paths are short-limited, so the state lives under /tmp rather than os.tmpdir().
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
    await waitFor(
      async () => {
        try {
          return (await fetchApi("/me")).status;
        } catch {
          if (api.exitCode !== null) throw new Error(diagnostics);
          return 0;
        }
      },
      (status) => status === 200,
    );
  };
  const stop = async () => {
    // The stop takes no less time than the fixed wait it had before: other processes of the host may still be writing.
    const floor = new Promise((resolve) => setTimeout(resolve, 1700));
    const api = child;
    let started: number[] = [];
    if (api?.pid !== undefined && api.exitCode === null && api.signalCode === null) {
      // A suspended API starts nothing more, so the list of its workers is complete. It holds a worker that is not listening yet.
      api.kill("SIGSTOP");
      try { started = processes().filter(row => row.parent === api.pid && row.command.includes(WORKER_ENTRY)).map(row => row.pid); } catch { /* no process list: the workers that recorded themselves are still stopped */ }
    }
    try {
      // The API ends first: while it runs, it can start a session after the workers were asked.
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
    throw error;
  }
  return { origin, root, config, tokens, fetchApi, start, stopApi, stop };
}

/**
 * Claims a session's input lease for `role` as one client instance. Input from that client must
 * carry the returned headers; the worker refuses input from anyone else while the lease lasts.
 */
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

/** An API served from this process, so a test can hold the sync queue open through the ProjectSync it returns. */
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
  hostInThisProcess(config);
  const origin = `http://127.0.0.1:${config.port}`;
  return {
    ...host, root, config, origin, tokens, fetchApi: apiClient(origin, tokens),
    stop: async () => {
      // The stop takes no less time than the fixed wait it had before: other processes of the host may still be writing.
      const floor = new Promise(resolve => setTimeout(resolve, 1700));
      // The services end first, as in the host's own shutdown: while they run, they can start a session after the workers were asked.
      try {
        const closing = host.closeConnections();
        await new Promise<void>(resolve => host.server.close(() => resolve()));
        await closing;
        // A step already under way can still start a session after close().
        await host.missions.idle(); await host.teams.idle();
        await endSessionWorkers(config);
        await floor;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
