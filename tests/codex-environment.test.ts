import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  CODEX_ENVIRONMENT_STATE_FILE,
  CodexEnvironmentError,
  connectCodexEnvironments,
  openCodexEnvironmentStore,
  type CodexEnvironmentSelection,
  type CodexEnvironmentStore,
  type CodexExecutor,
} from "../packages/host/src/codex-environment.js";
import { startNativeCodex } from "../packages/host/src/native-codex.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { waitFor } from "./helpers.js";

interface FakeExecServer {
  url: string;
  token: string;
  cwd: string;
  received: Array<{ id?: string | number; method?: string; params?: unknown }>;
  holdUpgrade: boolean;
  releaseUpgrades: () => void;
  close: () => Promise<void>;
}

async function startFakeExecServer(cwd: string): Promise<FakeExecServer> {
  const token = randomBytes(32).toString("hex");
  const received: Array<{ id?: string | number; method?: string; params?: unknown }> = [];
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  const pendingUpgrades: Array<() => void> = [];
  const state: FakeExecServer = {
    url: "",
    token,
    cwd,
    received,
    holdUpgrade: false,
    releaseUpgrades: () => {
      state.holdUpgrade = false;
      for (const run of pendingUpgrades.splice(0, pendingUpgrades.length)) run();
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const complete = () => {
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, ws => {
        ws.on("error", () => {});
        ws.on("message", data => {
          const msg = JSON.parse(data.toString()) as { id?: string | number; method?: string; params?: unknown };
          received.push(msg);
          if (msg.method === "environment/info") {
            ws.send(JSON.stringify({ id: msg.id, result: { cwd: pathToFileURL(cwd).href } }));
          } else if (msg.id !== undefined) {
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true, cwd, method: msg.method, contents: cwd } }));
          }
        });
      });
    };
    if (state.holdUpgrade) pendingUpgrades.push(complete);
    else complete();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  state.url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  return state;
}

interface FakeProvider {
  endpoint: string;
  token: string;
  environments: Map<string, { environmentId: string; execServerUrl: string; authBearerToken: string }>;
  threads: Map<string, CodexEnvironmentSelection[]>;
  failThreadUpdate: boolean;
  failTurnUpdate: boolean;
  tamperReadEnvironments?: (threadId: string) => CodexEnvironmentSelection[];
  invokeTool: (environmentId: string, method: string, params?: unknown) => Promise<{ result?: any; error?: { code: number; message: string } }>;
  openPersistentToolChannel: (environmentId: string) => Promise<{
    send: (method: string, params?: unknown) => Promise<{ result?: any; error?: { code: number; message: string } }>;
    close: () => void;
  }>;
  close: () => Promise<void>;
}

async function startFakeProvider(initialThreads?: Map<string, CodexEnvironmentSelection[]>): Promise<FakeProvider> {
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

  const openPersistentToolChannel = async (environmentId: string) => {
    const env = environments.get(environmentId);
    if (!env) throw new Error(`Unknown environment ${environmentId}`);
    const ws = new WebSocket(env.execServerUrl, { headers: { Authorization: `Bearer ${env.authBearerToken}` } });
    await new Promise<void>((done, fail) => { ws.once("open", done); ws.once("error", fail); });
    const pending = new Map<number, (response: { result?: any; error?: { code: number; message: string } }) => void>();
    let nextId = 1;
    ws.on("message", data => {
      const response = JSON.parse(data.toString());
      const handler = pending.get(response.id);
      if (handler) { pending.delete(response.id); handler(response); }
    });
    return {
      send: (method: string, params?: unknown) => new Promise<{ result?: any; error?: { code: number; message: string } }>((done, fail) => {
        const id = nextId++;
        pending.set(id, done);
        ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }), error => {
          if (error) { pending.delete(id); fail(error); }
        });
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
    invokeTool: callExecutor,
    openPersistentToolChannel,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
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
          } else if (msg.method === "thread/read") {
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

function makeExecutor(id: string, exec: FakeExecServer, roots = [exec.cwd]): CodexExecutor {
  return { environmentId: id, url: exec.url, token: exec.token, cwd: exec.cwd, roots };
}

test("persists verified Codex environment selection across provider restarts and fences unverified or stale tool dispatch", { timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-codex-env-")));
  const cwd1 = join(root, "laptop"), cwd2 = join(root, "cloud");
  mkdirSync(cwd1); mkdirSync(cwd2);
  const stateFile = join(root, CODEX_ENVIRONMENT_STATE_FILE);
  const key = randomBytes(32);
  const scope = `session-${randomUUID()}:codex-environments`;
  const persistence = { file: stateFile, key, scope };
  const threadId = `thread-${randomUUID()}`;
  const exec1 = await startFakeExecServer(cwd1);
  const exec2 = await startFakeExecServer(cwd2);
  const provider1 = await startFakeProvider();
  const fencedEvents: Array<{ environmentId: string; method?: string; code: string }> = [];
  let client1: Awaited<ReturnType<typeof connectCodexEnvironments>> | undefined;
  let provider2: FakeProvider | undefined;
  let client2: Awaited<ReturnType<typeof connectCodexEnvironments>> | undefined;
  try {
    client1 = await connectCodexEnvironments({
      endpoint: provider1.endpoint,
      token: provider1.token,
      persistence,
      onDispatchFenced: event => fencedEvents.push(event),
    });
    assert.equal(client1.supportsSelection, true);
    assert.equal(client1.storeStatus, "ok");

    const env1 = makeExecutor("env-laptop-1", exec1);
    const env2 = makeExecutor("env-cloud-2", exec2);
    await client1.register(env1);
    assert.equal(exec1.received.filter(item => item.method === "environment/info").length, 1);

    const blockedBeforeVerify = await provider1.invokeTool(env1.environmentId, "process/start", { cmd: "id" });
    assert.ok(blockedBeforeVerify.error, "tool RPC must be refused before placement is verified");
    assert.equal(blockedBeforeVerify.error.code, -32000);
    assert.equal(exec1.received.filter(item => item.method === "process/start").length, 0);
    assert.equal(client1.checkDispatch({ threadId, environmentId: env1.environmentId }).allowed, false);

    client1.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    const receipt1 = await client1.select({ threadId, executor: env1 });
    assert.equal(receipt1.future, "verified");
    assert.equal(receipt1.live, "idle");
    assert.equal(receipt1.generation, 1);
    assert.equal(receipt1.environmentId, env1.environmentId);

    const rawCiphertext = readFileSync(stateFile, "utf8");
    assert.equal(rawCiphertext.includes(env1.token), false, "sealed state must never persist executor bearer tokens");
    assert.equal(rawCiphertext.includes(env1.environmentId), false, "sealed state must be encrypted on disk");

    const allowed1 = await provider1.invokeTool(env1.environmentId, "process/start", { cmd: "echo 1" });
    assert.equal(allowed1.error, undefined);
    assert.equal(allowed1.result.cwd, cwd1);
    assert.equal(exec1.received.filter(item => item.method === "process/start").length, 1);

    const persistentEnv1 = await provider1.openPersistentToolChannel(env1.environmentId);
    try {
      const turnId = `turn-${randomUUID()}`;
      client1.observe({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
      let fencedDuringRelease = false;
      let persistedBeforeRelease = false;
      const receipt2 = await client1.select({
        threadId,
        turnId,
        executor: env2,
        releaseHeldOperation: async () => {
          const snapshot = openCodexEnvironmentStore(persistence).read();
          const saved = snapshot.state === "readable" ? snapshot.record.threads[threadId] : undefined;
          persistedBeforeRelease = saved?.status === "verified" &&
            saved.generation === 2 &&
            saved.placement.environmentId === env2.environmentId;
          const staleCall = await persistentEnv1.send("process/start", { cmd: "stale-on-old-env" });
          fencedDuringRelease = Boolean(staleCall.error && staleCall.error.code === -32000);
        },
      });
      assert.equal(persistedBeforeRelease, true, "verified placement must be durably persisted before releasing held operations");
      assert.equal(fencedDuringRelease, true, "stale placement must be fenced before reporting future verified");
      assert.equal(receipt2.future, "verified");
      assert.equal(receipt2.live, "published");
      assert.equal(receipt2.generation, 2);
      assert.equal(receipt2.environmentId, env2.environmentId);

      const staleAfterSelect = await persistentEnv1.send("fs/writeFile", { path: "stale.txt" });
      assert.equal(staleAfterSelect.error?.code, -32000);
      assert.equal(exec1.received.filter(item => item.method !== "environment/info").length, 1);
    } finally {
      persistentEnv1.close();
    }

    assert.equal(client1.checkDispatch({ threadId, environmentId: env1.environmentId }).allowed, false);
    assert.equal(client1.checkDispatch({ threadId, environmentId: env2.environmentId, generation: 1 }).allowed, false);
    const dispatched = await client1.dispatchTool({ threadId, environmentId: env2.environmentId, generation: 2 }, placement => ({
      env: placement.environmentId,
      gen: placement.generation,
    }));
    assert.deepEqual(dispatched, { env: env2.environmentId, gen: 2 });
    const allowed2 = await provider1.invokeTool(env2.environmentId, "process/start", { cmd: "echo 2" });
    assert.equal(allowed2.error, undefined);
    assert.equal(allowed2.result.cwd, cwd2);
    assert.ok(fencedEvents.some(event => event.environmentId === env1.environmentId));

    const persistedThreads = new Map(provider1.threads);
    client1.close();
    await provider1.close();

    provider2 = await startFakeProvider(persistedThreads);
    client2 = await connectCodexEnvironments({ endpoint: provider2.endpoint, token: provider2.token, persistence });
    const pendingView = client2.placement(threadId);
    assert.equal(pendingView.status, "pending-verification");
    if (pendingView.status === "pending-verification") {
      assert.equal(pendingView.generation, 2);
      assert.equal(pendingView.expected.environmentId, env2.environmentId);
    }

    await client2.register(env2);
    const blockedAfterRestart = await provider2.invokeTool(env2.environmentId, "process/start", { cmd: "before-verify" });
    assert.equal(blockedAfterRestart.error?.code, -32000, "restarted provider must fence tool dispatch until placement is re-verified");
    assert.equal(exec2.received.filter(item => item.method === "process/start").length, 1);
    await assert.rejects(
      client2.dispatchTool({ threadId, environmentId: env2.environmentId }, () => "should-not-run"),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
    );

    client2.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await assert.rejects(
      client2.select({ threadId, executor: env1 }),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "conflict",
      "retired environment IDs must remain rejected across provider restarts",
    );

    const verifiedAfterRestart = await client2.verify(threadId);
    assert.equal(verifiedAfterRestart.environmentId, env2.environmentId);
    assert.equal(verifiedAfterRestart.generation, 2);
    assert.equal(client2.placement(threadId).status, "verified");

    const allowedAfterVerify = await provider2.invokeTool(env2.environmentId, "process/start", { cmd: "after-verify" });
    assert.equal(allowedAfterVerify.error, undefined);
    assert.equal(allowedAfterVerify.result.cwd, cwd2);
    assert.equal(exec2.received.filter(item => item.method === "process/start").length, 2);
    assert.equal(client2.checkDispatch({ threadId, environmentId: env2.environmentId, generation: 1 }).allowed, false);
    assert.equal(client2.checkDispatch({ threadId, environmentId: env2.environmentId, generation: 2 }).allowed, true);
  } finally {
    client1?.close();
    client2?.close();
    await provider1.close();
    await provider2?.close();
    await exec1.close();
    await exec2.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-restart environment drift fails closed, fences all dispatch, and recovers only via explicit reconciliation", { timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-codex-drift-")));
  const cwd1 = join(root, "laptop"), cwd2 = join(root, "cloud-a"), cwd3 = join(root, "cloud-b");
  mkdirSync(cwd1); mkdirSync(cwd2); mkdirSync(cwd3);
  const persistence = { file: join(root, CODEX_ENVIRONMENT_STATE_FILE), key: randomBytes(32), scope: `session-${randomUUID()}:codex-environments` };
  const threadId = `thread-${randomUUID()}`;
  const exec1 = await startFakeExecServer(cwd1);
  const exec2 = await startFakeExecServer(cwd2);
  const exec3 = await startFakeExecServer(cwd3);
  const provider1 = await startFakeProvider();
  let client1: Awaited<ReturnType<typeof connectCodexEnvironments>> | undefined;
  let provider2: FakeProvider | undefined;
  let client2: Awaited<ReturnType<typeof connectCodexEnvironments>> | undefined;
  try {
    client1 = await connectCodexEnvironments({ endpoint: provider1.endpoint, token: provider1.token, persistence });
    const env1 = makeExecutor("env-1", exec1);
    const env2 = makeExecutor("env-2", exec2);
    const env3 = makeExecutor("env-3", exec3);
    client1.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await client1.select({ threadId, executor: env1 });
    await client1.select({ threadId, executor: env2 });
    client1.close();
    await provider1.close();

    const driftedThreads = new Map<string, CodexEnvironmentSelection[]>([
      [threadId, [{ environmentId: env1.environmentId, cwd: env1.cwd, runtimeWorkspaceRoots: env1.roots }]],
    ]);
    provider2 = await startFakeProvider(driftedThreads);
    client2 = await connectCodexEnvironments({ endpoint: provider2.endpoint, token: provider2.token, persistence });
    await client2.register(env1);
    await client2.register(env2);

    await assert.rejects(
      client2.verify(threadId),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "conflict",
    );
    assert.equal(client2.placement(threadId).status, "uncertain");
    const persistedAfterDrift = openCodexEnvironmentStore(persistence).read();
    assert.equal(persistedAfterDrift.state, "readable");
    if (persistedAfterDrift.state === "readable") {
      assert.equal(persistedAfterDrift.record.threads[threadId]?.status, "uncertain");
    }

    assert.equal((await provider2.invokeTool(env1.environmentId, "process/start")).error?.code, -32000);
    assert.equal((await provider2.invokeTool(env2.environmentId, "process/start")).error?.code, -32000);
    assert.equal(exec1.received.filter(item => item.method === "process/start").length, 0);
    assert.equal(exec2.received.filter(item => item.method === "process/start").length, 0);

    client2.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await assert.rejects(
      client2.select({ threadId, executor: env3 }),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
    );
    await assert.rejects(
      client2.reconcile({ threadId, executor: env1 }),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "conflict",
    );

    const reconciled = await client2.reconcile({ threadId, executor: env3 });
    assert.equal(reconciled.future, "verified");
    assert.equal(reconciled.generation, 3);
    assert.equal(reconciled.environmentId, env3.environmentId);

    const ok = await provider2.invokeTool(env3.environmentId, "process/start", { cmd: "ok" });
    assert.equal(ok.error, undefined);
    assert.equal(ok.result.cwd, cwd3);
    assert.equal((await provider2.invokeTool(env2.environmentId, "process/start")).error?.code, -32000);
  } finally {
    client1?.close();
    client2?.close();
    await provider1.close();
    await provider2?.close();
    await exec1.close();
    await exec2.close();
    await exec3.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("mid-selection crash, interrupted selecting state, and store write failure all fail closed without reporting future verified", { timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-codex-crash-")));
  const cwd1 = join(root, "w1"), cwd2 = join(root, "w2"), cwd3 = join(root, "w3");
  mkdirSync(cwd1); mkdirSync(cwd2); mkdirSync(cwd3);
  const key = randomBytes(32);
  const scope = `session-${randomUUID()}:codex-environments`;
  const threadId = `thread-${randomUUID()}`;
  const exec1 = await startFakeExecServer(cwd1);
  const exec2 = await startFakeExecServer(cwd2);
  const exec3 = await startFakeExecServer(cwd3);
  const provider = await startFakeProvider();
  const clients: Array<Awaited<ReturnType<typeof connectCodexEnvironments>>> = [];
  try {
    const env1 = makeExecutor("env-1", exec1);
    const env2 = makeExecutor("env-2", exec2);
    const env3 = makeExecutor("env-3", exec3);

    const unconfigured = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token });
    clients.push(unconfigured);
    assert.equal(unconfigured.supportsSelection, false);
    assert.equal(unconfigured.storeStatus, "unconfigured");
    unconfigured.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await assert.rejects(
      unconfigured.select({ threadId, executor: env1 }),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "unavailable",
    );
    unconfigured.close();

    const failPersistence = { file: join(root, "fail-select.sealed"), key, scope };
    const clientA = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, persistence: failPersistence });
    clients.push(clientA);
    clientA.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await clientA.select({ threadId, executor: env1 });
    provider.failThreadUpdate = true;
    let released = false;
    await assert.rejects(
      clientA.select({ threadId, executor: env2, releaseHeldOperation: () => { released = true; } }),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
    );
    assert.equal(released, false);
    assert.equal(clientA.placement(threadId).status, "uncertain");
    assert.equal((await provider.invokeTool(env1.environmentId, "process/start")).error?.code, -32000);
    assert.equal((await provider.invokeTool(env2.environmentId, "process/start")).error?.code, -32000);
    clientA.close();
    provider.failThreadUpdate = false;

    const clientARestart = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, persistence: failPersistence });
    clients.push(clientARestart);
    assert.equal(clientARestart.placement(threadId).status, "uncertain");
    await assert.rejects(
      clientARestart.verify(threadId),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
    );
    clientARestart.close();

    const interruptedFile = join(root, "interrupted.sealed");
    const now = new Date().toISOString();
    writeSealed(interruptedFile, key, scope, {
      version: 1,
      scope,
      threads: {
        [threadId]: {
          status: "selecting",
          generation: 2,
          revision: 3,
          target: { environmentId: env2.environmentId, cwd: env2.cwd, runtimeWorkspaceRoots: env2.roots },
          previous: { environmentId: env1.environmentId, cwd: env1.cwd, runtimeWorkspaceRoots: env1.roots },
          usedEnvironmentIds: [env1.environmentId, env2.environmentId],
          updatedAt: now,
        },
      },
    });
    const clientInterrupted = await connectCodexEnvironments({
      endpoint: provider.endpoint,
      token: provider.token,
      persistence: { file: interruptedFile, key, scope },
    });
    clients.push(clientInterrupted);
    assert.equal(clientInterrupted.placement(threadId).status, "uncertain");
    await assert.rejects(
      clientInterrupted.verify(threadId),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
    );
    assert.equal(clientInterrupted.checkDispatch({ threadId, environmentId: env2.environmentId }).allowed, false);
    clientInterrupted.close();

    const backing = openCodexEnvironmentStore({ file: join(root, "write-fail.sealed"), key, scope });
    let failOnVerifiedWrite = false;
    const flakyStore: CodexEnvironmentStore = {
      scope: backing.scope,
      read: () => backing.read(),
      write: record => {
        if (failOnVerifiedWrite && record.threads[threadId]?.status === "verified") {
          throw new Error("Simulated disk write failure");
        }
        backing.write(record);
      },
    };
    const clientFlaky = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, store: flakyStore });
    clients.push(clientFlaky);
    clientFlaky.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await clientFlaky.select({ threadId, executor: env1 });
    failOnVerifiedWrite = true;
    let flakyReleased = false;
    await assert.rejects(
      clientFlaky.select({ threadId, executor: env3, releaseHeldOperation: () => { flakyReleased = true; } }),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
    );
    assert.equal(flakyReleased, false, "must not release held operation when durable commit fails");
    assert.equal(clientFlaky.checkDispatch({ threadId, environmentId: env1.environmentId }).allowed, false);
    assert.equal(clientFlaky.checkDispatch({ threadId, environmentId: env3.environmentId }).allowed, false);
    assert.equal((await provider.invokeTool(env3.environmentId, "process/start")).error?.code, -32000);
    clientFlaky.close();
  } finally {
    for (const client of clients) client.close();
    await provider.close();
    await exec1.close();
    await exec2.close();
    await exec3.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupted, tampered, wrong-key, wrong-scope, loose-mode, and symlinked state files fail closed", { timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-codex-corrupt-")));
  const cwd1 = join(root, "work");
  mkdirSync(cwd1);
  const key = randomBytes(32);
  const scope = `session-${randomUUID()}:codex-environments`;
  const threadId = `thread-${randomUUID()}`;
  const exec1 = await startFakeExecServer(cwd1);
  const provider = await startFakeProvider();
  try {
    const env1 = makeExecutor("env-corrupt-1", exec1);
    const seedFile = join(root, "seed.sealed");
    const seeder = await connectCodexEnvironments({
      endpoint: provider.endpoint,
      token: provider.token,
      persistence: { file: seedFile, key, scope },
    });
    seeder.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await seeder.select({ threadId, executor: env1 });
    seeder.close();
    const validRaw = readFileSync(seedFile, "utf8");

    const truncatedFile = join(root, "truncated.sealed");
    writeFileSync(truncatedFile, validRaw.slice(0, 20), { mode: 0o600 });

    const looseFile = join(root, "loose.sealed");
    writeFileSync(looseFile, validRaw, { mode: 0o600 });
    chmodSync(looseFile, 0o644);

    const symlinkFile = join(root, "symlink.sealed");
    symlinkSync(seedFile, symlinkFile);

    const invalidSchemaFile = join(root, "invalid-schema.sealed");
    writeSealed(invalidSchemaFile, key, scope, { version: 1, scope, threads: { [threadId]: { status: "verified", generation: 0 } } });

    const cases = [
      { label: "truncated ciphertext", persistence: { file: truncatedFile, key, scope } },
      { label: "wrong key", persistence: { file: seedFile, key: randomBytes(32), scope } },
      { label: "wrong scope", persistence: { file: seedFile, key, scope: "foreign-session:codex-environments" } },
      { label: "loose permissions", persistence: { file: looseFile, key, scope } },
      { label: "symlinked state file", persistence: { file: symlinkFile, key, scope } },
      { label: "invalid schema", persistence: { file: invalidSchemaFile, key, scope } },
    ];

    for (const item of cases) {
      assert.equal(openCodexEnvironmentStore(item.persistence).read().state, "unreadable", item.label);
      const client = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, persistence: item.persistence });
      try {
        assert.equal(client.storeStatus, "corrupted", item.label);
        assert.equal(client.supportsSelection, false, item.label);
        assert.equal(client.placement(threadId).status, "corrupted", item.label);
        const decision = client.checkDispatch({ threadId, environmentId: env1.environmentId });
        assert.equal(decision.allowed, false, item.label);
        if (!decision.allowed) assert.equal(decision.code, "uncertain", item.label);
        await assert.rejects(client.verify(threadId), (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain", item.label);
        client.observe({ method: "thread/started", params: { thread: { id: threadId } } });
        await assert.rejects(client.select({ threadId, executor: env1 }), (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain", item.label);
        await assert.rejects(client.reconcile({ threadId, executor: env1 }), (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain", item.label);
        await client.register(env1);
        const fenced = await provider.invokeTool(env1.environmentId, "process/start");
        assert.equal(fenced.error?.code, -32000, item.label);
      } finally {
        client.close();
      }
    }
    assert.equal(exec1.received.filter(item => item.method === "process/start").length, 0);
  } finally {
    await provider.close();
    await exec1.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("queued tool dispatch frames before upstream executor handshake are fenced when placement is superseded", { timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-codex-queue-")));
  const cwd1 = join(root, "e1"), cwd2 = join(root, "e2");
  mkdirSync(cwd1); mkdirSync(cwd2);
  const persistence = { file: join(root, CODEX_ENVIRONMENT_STATE_FILE), key: randomBytes(32), scope: `session-${randomUUID()}:codex-environments` };
  const threadId = `thread-${randomUUID()}`;
  const exec1 = await startFakeExecServer(cwd1);
  const exec2 = await startFakeExecServer(cwd2);
  const provider = await startFakeProvider();
  const client = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, persistence });
  try {
    const env1 = makeExecutor("env-queue-1", exec1);
    const env2 = makeExecutor("env-queue-2", exec2);
    client.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await client.select({ threadId, executor: env1 });

    exec1.holdUpgrade = true;
    const channel = await provider.openPersistentToolChannel(env1.environmentId);
    try {
      const inflight = channel.send("process/start", { cmd: "queued-before-handoff" });
      await new Promise(done => setTimeout(done, 40));
      await client.select({ threadId, executor: env2 });
      const response = await inflight;
      assert.equal(response.error?.code, -32000);
      exec1.releaseUpgrades();
      await new Promise(done => setTimeout(done, 40));
      assert.equal(exec1.received.filter(item => item.method === "process/start").length, 0);
    } finally {
      channel.close();
    }
  } finally {
    exec1.releaseUpgrades();
    client.close();
    await provider.close();
    await exec1.close();
    await exec2.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startNativeCodex persists placements and fences turn/start when environment state is corrupted or uncertain", { timeout: 25000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-native-codex-fence-")));
  const hostCwd = join(root, "host"), laptopCwd = join(root, "laptop"), cloudCwd = join(root, "cloud");
  mkdirSync(hostCwd); mkdirSync(laptopCwd); mkdirSync(cloudCwd);
  writeFileSync(laptopCwd + "/marker.txt", "LAPTOP_VALUE");
  writeFileSync(cloudCwd + "/marker.txt", "CLOUD_VALUE");
  const key = randomBytes(32);
  const scope = `session-${randomUUID()}:codex-environments`;
  const stateFile = join(root, CODEX_ENVIRONMENT_STATE_FILE);
  const exec1 = await startFakeExecServer(laptopCwd);
  const exec2 = await startFakeExecServer(cloudCwd);
  const fixture = resolve("tests/fixtures/native-codex.mjs");
  const profile = { command: process.execPath, args: [fixture] };

  let observedThread: string | undefined;
  const native = await startNativeCodex({
    profile,
    cwd: hostCwd,
    env: { PATH: process.env.PATH ?? "" },
    execution: makeExecutor("native-laptop-1", exec1),
    environmentState: { file: stateFile, key, scope },
    checkControl: () => {},
    onThread: id => { observedThread = id; },
    onExit: () => {},
    onSignal: () => {},
    noAltScreen: false,
    record: () => {},
  });
  let observer: WebSocket | undefined;
  let corruptNative: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let corruptObserver: WebSocket | undefined;
  try {
    assert.equal(native.supportsExecutionSelection, true);
    observer = new WebSocket(native.url, { headers: { Authorization: `Bearer ${native.observerToken}` } });
    await new Promise<void>((done, fail) => { observer!.once("open", done); observer!.once("error", fail); });
    const messages: any[] = [];
    observer.on("message", data => messages.push(JSON.parse(data.toString())));
    let nextId = 1;
    const rpc = async (ws: WebSocket, list: any[], method: string, params: unknown = {}) => {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return waitFor(async () => list.find(item => item.id === id && !item.method), Boolean, 10000);
    };
    await rpc(observer, messages, "initialize", { clientInfo: { name: "observer", version: "1" } });
    observer.send(JSON.stringify({ method: "initialized" }));
    const started = await rpc(observer, messages, "thread/start", {});
    const threadId = started.result.thread.id as string;
    assert.equal(observedThread, threadId);

    const initialStored = openCodexEnvironmentStore({ file: stateFile, key, scope }).read();
    assert.equal(initialStored.state, "readable");
    if (initialStored.state === "readable") {
      const entry = initialStored.record.threads[threadId];
      assert.equal(entry?.status, "verified");
      if (entry?.status === "verified") {
        assert.equal(entry.generation, 1);
        assert.equal(entry.placement.environmentId, "native-laptop-1");
      }
    }

    const turn1 = await rpc(observer, messages, "turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(turn1.error, undefined);
    await waitFor(async () => messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === turn1.result.turn.id), Boolean, 10000);
    assert.equal(exec1.received.filter(item => item.method === "fixture/read-write").length, 1);

    const receipt = await native.selectExecution(makeExecutor("native-cloud-2", exec2), () => {});
    assert.equal(receipt.future, "verified");
    assert.equal(receipt.generation, 2);
    const updatedStored = openCodexEnvironmentStore({ file: stateFile, key, scope }).read();
    assert.equal(updatedStored.state, "readable");
    if (updatedStored.state === "readable") {
      const entry = updatedStored.record.threads[threadId];
      assert.equal(entry?.status, "verified");
      if (entry?.status === "verified") {
        assert.equal(entry.generation, 2);
        assert.equal(entry.placement.environmentId, "native-cloud-2");
      }
    }

    const turn2 = await rpc(observer, messages, "turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(turn2.error, undefined);
    await waitFor(async () => messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === turn2.result.turn.id), Boolean, 10000);
    assert.equal(exec2.received.filter(item => item.method === "fixture/read-write").length, 1);
    assert.equal(exec1.received.filter(item => item.method === "fixture/read-write").length, 1);

    const exec3 = await startFakeExecServer(cloudCwd);
    try {
      await assert.rejects(
        native.selectExecution(makeExecutor("native-cloud-3", exec3), () => { throw new Error("release failure"); }),
        (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
      );
      const fencedTurn = await rpc(observer, messages, "turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
      assert.ok(fencedTurn.error, "turn/start must be refused after selection leaves placement uncertain");
      assert.equal(exec2.received.filter(item => item.method === "fixture/read-write").length, 1);
      assert.equal(exec3.received.filter(item => item.method === "fixture/read-write").length, 0);
    } finally {
      await exec3.close();
    }

    const badFile = join(root, "corrupt-native.sealed");
    writeFileSync(badFile, "not-valid-sealed-json", { mode: 0o600 });
    corruptNative = await startNativeCodex({
      profile,
      cwd: hostCwd,
      env: { PATH: process.env.PATH ?? "" },
      execution: makeExecutor("native-corrupt-1", exec1),
      environmentState: { file: badFile, key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    assert.equal(corruptNative.supportsExecutionSelection, false);
    corruptObserver = new WebSocket(corruptNative.url, { headers: { Authorization: `Bearer ${corruptNative.observerToken}` } });
    await new Promise<void>((done, fail) => { corruptObserver!.once("open", done); corruptObserver!.once("error", fail); });
    const corruptMessages: any[] = [];
    const corruptClosed = new Promise<void>(done => corruptObserver!.once("close", () => done()));
    corruptObserver.on("message", data => corruptMessages.push(JSON.parse(data.toString())));
    await rpc(corruptObserver, corruptMessages, "initialize", { clientInfo: { name: "observer", version: "1" } });
    corruptObserver.send(JSON.stringify({ method: "initialized" }));
    corruptObserver.send(JSON.stringify({ id: ++nextId, method: "thread/start", params: {} }));
    await corruptClosed;
    assert.equal(corruptNative.info().sessionId, undefined, "corrupted persisted placement must refuse initial session activation");
  } finally {
    observer?.terminate();
    corruptObserver?.terminate();
    native.stop();
    corruptNative?.stop();
    await exec1.close();
    await exec2.close();
    rmSync(root, { recursive: true, force: true });
  }
});
