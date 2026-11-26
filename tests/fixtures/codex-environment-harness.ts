import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { CodexEnvironmentSelection, CodexExecutor } from "../../packages/host/src/codex-environment.js";

export interface FakeExecServer {
  url: string;
  token: string;
  cwd: string;
  reportedCwd?: string;
  received: Array<{ id?: string | number; method?: string; params?: unknown }>;
  holdNextUpgrades: number;
  waitForHeldUpgrade: () => Promise<void>;
  releaseUpgrades: () => void;
  close: () => Promise<void>;
}

export async function startFakeExecServer(cwd: string): Promise<FakeExecServer> {
  const token = randomBytes(32).toString("hex");
  const received: Array<{ id?: string | number; method?: string; params?: unknown }> = [];
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const pendingUpgrades: Array<{ complete: () => void; abort: () => void }> = [];
  const heldWaiters: Array<() => void> = [];
  const state: FakeExecServer = {
    url: "",
    token,
    cwd,
    received,
    holdNextUpgrades: 0,
    waitForHeldUpgrade: () => {
      if (pendingUpgrades.length > 0) return Promise.resolve();
      return new Promise<void>(done => heldWaiters.push(done));
    },
    releaseUpgrades: () => {
      state.holdNextUpgrades = 0;
      for (const entry of pendingUpgrades.splice(0, pendingUpgrades.length)) entry.complete();
    },
    close: async () => {
      state.holdNextUpgrades = 0;
      for (const entry of pendingUpgrades.splice(0, pendingUpgrades.length)) entry.abort();
      for (const wake of heldWaiters.splice(0, heldWaiters.length)) wake();
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    if (req.headers.authorization !== `Bearer ${token}`) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const complete = () => {
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => {
        ws.on("error", () => {});
        ws.on("message", data => {
          const msg = JSON.parse(data.toString()) as { id?: string | number; method?: string; params?: any };
          received.push(msg);
          if (msg.method === "environment/info") {
            ws.send(JSON.stringify({ id: msg.id, result: { cwd: pathToFileURL(state.reportedCwd ?? cwd).href } }));
          } else if (msg.method === "fs/getMetadata") {
            const target = typeof msg.params?.path === "string" ? msg.params.path : join(cwd, "AGENTS.md");
            ws.send(JSON.stringify({ id: msg.id, result: { exists: existsSync(target), isFile: existsSync(target) } }));
          } else if (msg.method === "fs/readFile") {
            const target = typeof msg.params?.path === "string" ? msg.params.path : join(cwd, "AGENTS.md");
            ws.send(JSON.stringify({ id: msg.id, result: { contents: existsSync(target) ? readFileSync(target, "utf8") : "" } }));
          } else if (msg.id !== undefined) {
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true, cwd, method: msg.method, contents: cwd } }));
          }
        });
      });
    };
    if (state.holdNextUpgrades > 0) {
      state.holdNextUpgrades -= 1;
      pendingUpgrades.push({ complete, abort: () => socket.destroy() });
      for (const wake of heldWaiters.splice(0, heldWaiters.length)) wake();
    } else {
      complete();
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  state.url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  return state;
}

export interface FakeProvider {
  endpoint: string;
  token: string;
  environments: Map<string, { environmentId: string; execServerUrl: string; authBearerToken: string }>;
  threads: Map<string, CodexEnvironmentSelection[]>;
  failThreadUpdate: boolean;
  failTurnUpdate: boolean;
  omitReadEnvironments: boolean;
  tamperReadEnvironments?: (threadId: string) => CodexEnvironmentSelection[];
  invokeTool: (environmentId: string, method: string, params?: unknown) => Promise<{ result?: any; error?: { code: number; message: string } }>;
  openPersistentToolChannel: (environmentId: string, overrideTarget?: { url: string; token: string }) => Promise<{
    send: (method: string, params?: unknown) => Promise<{ result?: any; error?: { code: number; message: string } }>;
    close: () => void;
  }>;
  close: () => Promise<void>;
}

export async function startFakeProvider(initialThreads?: Map<string, CodexEnvironmentSelection[]>): Promise<FakeProvider> {
  const token = randomBytes(32).toString("hex");
  const server: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const environments = new Map<string, { environmentId: string; execServerUrl: string; authBearerToken: string }>();
  const threads = new Map<string, CodexEnvironmentSelection[]>(initialThreads ?? []);

  const callExecutor = (environmentId: string, method: string, params?: unknown) =>
    new Promise<{ result?: any; error?: { code: number; message: string } }>((resolveCall, rejectCall) => {
      const env = environments.get(environmentId);
      if (!env) { rejectCall(new Error(`Unknown environment ${environmentId}`)); return; }
      const ws = new WebSocket(env.execServerUrl, { headers: { Authorization: `Bearer ${env.authBearerToken}` } });
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        ws.close();
        fn();
      };
      ws.on("error", error => done(() => rejectCall(error)));
      ws.on("open", () => {
        ws.send(JSON.stringify({ id: 1, method, ...(params !== undefined ? { params } : {}) }));
      });
      ws.on("message", data => {
        const response = JSON.parse(data.toString());
        done(() => resolveCall(response));
      });
    });

  const openPersistentToolChannel = async (environmentId: string, overrideTarget?: { url: string; token: string }) => {
    const env = environments.get(environmentId);
    if (!env && !overrideTarget) throw new Error(`Unknown environment ${environmentId}`);
    const targetUrl = overrideTarget?.url ?? env!.execServerUrl;
    const targetToken = overrideTarget?.token ?? env!.authBearerToken;
    const ws = new WebSocket(targetUrl, { headers: { Authorization: `Bearer ${targetToken}` } });
    const queuedBeforeOpen: Array<{ text: string; id: number; fail: (error: Error) => void }> = [];
    const pending = new Map<number, (response: { result?: any; error?: { code: number; message: string } }) => void>();
    let nextId = 1;
    ws.on("error", error => {
      for (const item of queuedBeforeOpen.splice(0, queuedBeforeOpen.length)) {
        pending.delete(item.id);
        item.fail(error);
      }
    });
    ws.on("open", () => {
      for (const item of queuedBeforeOpen.splice(0, queuedBeforeOpen.length)) {
        ws.send(item.text, error => {
          if (error) { pending.delete(item.id); item.fail(error); }
        });
      }
    });
    if (!overrideTarget) {
      await new Promise<void>((done, fail) => { ws.once("open", done); ws.once("error", fail); });
    }
    ws.on("message", data => {
      const response = JSON.parse(data.toString());
      const handler = pending.get(response.id);
      if (handler) { pending.delete(response.id); handler(response); }
    });
    return {
      send: (method: string, params?: unknown) => new Promise<{ result?: any; error?: { code: number; message: string } }>((done, fail) => {
        const id = nextId++;
        const text = JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) });
        pending.set(id, done);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(text, error => {
            if (error) { pending.delete(id); fail(error); }
          });
        } else if (ws.readyState === WebSocket.CONNECTING) {
          queuedBeforeOpen.push({ text, id, fail });
        } else {
          pending.delete(id);
          fail(new Error("Tool channel closed"));
        }
      }),
      close: () => ws.terminate(),
    };
  };

  const provider: FakeProvider = {
    endpoint: "",
    token,
    environments,
    threads,
    failThreadUpdate: false,
    failTurnUpdate: false,
    omitReadEnvironments: false,
    invokeTool: callExecutor,
    openPersistentToolChannel,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>(done => server.close(() => done()));
    },
  };

  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on("error", () => {});
      ws.on("message", async data => {
        const msg = JSON.parse(data.toString()) as { id?: number; method?: string; params?: any };
        if (msg.id === undefined) return;
        const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
        const fail = (message: string) => ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message } }));
        try {
          if (msg.method === "initialize") reply({ userAgent: "fake-provider" });
          else if (msg.method === "server/diagnostics") reply({ executionEnvironmentUpdates: 1 });
          else if (msg.method === "environment/add") {
            environments.set(msg.params.environmentId, {
              environmentId: msg.params.environmentId,
              execServerUrl: msg.params.execServerUrl,
              authBearerToken: msg.params.authBearerToken,
            });
            reply({});
          } else if (msg.method === "environment/info") {
            const response = await callExecutor(msg.params.environmentId, "environment/info");
            if (response.error) fail(response.error.message);
            else reply(response.result);
          } else if (msg.method === "turn/settings/update") {
            if (provider.failTurnUpdate) reply({ status: "targetUnavailable" });
            else reply({ status: "applied" });
          } else if (msg.method === "thread/settings/update") {
            if (provider.failThreadUpdate) fail("thread update failed");
            else {
              threads.set(msg.params.threadId, msg.params.environments);
              reply({});
            }
          } else if (msg.method === "thread/read" || msg.method === "thread/resume") {
            if (provider.omitReadEnvironments && msg.method === "thread/read") {
              reply({ thread: { id: msg.params.threadId } });
              return;
            }
            const selected = provider.tamperReadEnvironments
              ? provider.tamperReadEnvironments(msg.params.threadId)
              : threads.get(msg.params.threadId) ?? [];
            reply({ thread: { id: msg.params.threadId, environments: selected } });
          } else {
            reply({});
          }
        } catch (error) {
          fail(error instanceof Error ? error.message : "provider failure");
        }
      });
    });
  });

  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  provider.endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  return provider;
}

export function makeExecutor(id: string, exec: FakeExecServer, roots = [exec.cwd]): CodexExecutor {
  return { environmentId: id, url: exec.url, token: exec.token, cwd: exec.cwd, roots };
}
