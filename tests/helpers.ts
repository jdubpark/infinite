import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { hashToken } from "../packages/host/src/config.js";
import { createApp } from "../packages/host/src/server.js";
import { workerCall } from "../packages/host/src/ipc.js";
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
    await stopSessionWorkers(config);
    await stopApi();
    // Workers exit 1.5 s after their child; wait so they never write into a removed directory.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    rmSync(root, { recursive: true, force: true });
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
export async function inProcessHost() {
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
  const host = createApp(config, key);
  await new Promise<void>(resolve => host.server.listen(0, "127.0.0.1", resolve));
  config.port = (host.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${config.port}`;
  return {
    ...host, root, config, origin, tokens, fetchApi: apiClient(origin, tokens),
    stop: async () => {
      await stopSessionWorkers(config);
      host.closeConnections();
      await new Promise<void>(resolve => host.server.close(() => resolve()));
      // Workers exit 1.5 s after their child; wait so they never write into a removed directory.
      await new Promise(resolve => setTimeout(resolve, 1700));
      rmSync(root, { recursive: true, force: true });
    },
  };
}
