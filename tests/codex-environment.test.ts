import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_ENVIRONMENT_STATE_FILE,
  CodexEnvironmentError,
  MAX_CODEX_ENVIRONMENT_STATE_BYTES,
  connectCodexEnvironments,
  openCodexEnvironmentStore,
  type CodexEnvironmentSelection,
  type CodexEnvironmentStore,
  type PersistedCodexEnvironmentState,
} from "../packages/host/src/codex-environment.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { makeExecutor, startFakeExecServer, startFakeProvider, type FakeProvider } from "./fixtures/codex-environment-harness.js";

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
    assert.equal(blockedBeforeVerify.error?.code, -32000);
    assert.equal(exec1.received.filter(item => item.method === "process/start").length, 0);
    assert.equal(client1.checkDispatch({ threadId, environmentId: env1.environmentId }).allowed, false);

    client1.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    const receipt1 = await client1.select({ threadId, executor: env1 });
    assert.equal(receipt1.future, "verified");
    assert.equal(receipt1.live, "idle");
    assert.equal(receipt1.generation, 1);

    const rawCiphertext = readFileSync(stateFile, "utf8");
    assert.equal(rawCiphertext.includes(env1.token), false);
    assert.equal(rawCiphertext.includes(env1.environmentId), false);

    const allowed1 = await provider1.invokeTool(env1.environmentId, "process/start", { cmd: "echo 1" });
    assert.equal(allowed1.error, undefined);
    assert.equal(allowed1.result.cwd, cwd1);

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
      assert.equal(persistedBeforeRelease, true);
      assert.equal(fencedDuringRelease, true);
      assert.equal(receipt2.future, "verified");
      assert.equal(receipt2.live, "published");
      assert.equal(receipt2.generation, 2);
      assert.equal((await persistentEnv1.send("fs/writeFile", { path: "stale.txt" })).error?.code, -32000);
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
    assert.equal((await provider1.invokeTool(env2.environmentId, "process/start", { cmd: "echo 2" })).result.cwd, cwd2);
    assert.ok(fencedEvents.some(event => event.environmentId === env1.environmentId));

    const persistedThreads = new Map(provider1.threads);
    client1.close();
    await provider1.close();

    provider2 = await startFakeProvider(persistedThreads);
    client2 = await connectCodexEnvironments({ endpoint: provider2.endpoint, token: provider2.token, persistence });
    assert.equal(client2.placement(threadId).status, "pending-verification");

    await client2.register(env2);
    assert.equal((await provider2.invokeTool(env2.environmentId, "process/start", { cmd: "before-verify" })).error?.code, -32000);
    await assert.rejects(
      client2.dispatchTool({ threadId, environmentId: env2.environmentId }, () => "should-not-run"),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
    );

    client2.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await assert.rejects(
      client2.select({ threadId, executor: env1 }),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "conflict",
    );

    const verifiedAfterRestart = await client2.verify(threadId);
    assert.equal(verifiedAfterRestart.environmentId, env2.environmentId);
    assert.equal(verifiedAfterRestart.generation, 2);
    assert.equal((await provider2.invokeTool(env2.environmentId, "process/start", { cmd: "after-verify" })).result.cwd, cwd2);
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

test("post-restart drift fails closed, failed register cannot authorize traffic even after verify, and reconcile recovers", { timeout: 20000 }, async () => {
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
  let provider3: FakeProvider | undefined;
  let client3: Awaited<ReturnType<typeof connectCodexEnvironments>> | undefined;
  try {
    client1 = await connectCodexEnvironments({ endpoint: provider1.endpoint, token: provider1.token, persistence });
    const env1 = makeExecutor("env-1", exec1);
    const env2 = makeExecutor("env-2", exec2);
    const env3 = makeExecutor("env-3", exec3);
    client1.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await client1.select({ threadId, executor: env1 });
    await client1.select({ threadId, executor: env2 });
    const savedProviderThreads = new Map(provider1.threads);
    client1.close();
    await provider1.close();

    provider2 = await startFakeProvider(savedProviderThreads);
    client2 = await connectCodexEnvironments({ endpoint: provider2.endpoint, token: provider2.token, persistence });
    exec2.reportedCwd = cwd1;
    await assert.rejects(
      client2.register(env2),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "rejected",
    );
    await assert.rejects(provider2.invokeTool(env2.environmentId, "process/start"), /403/);
    await assert.rejects(
      client2.verify(threadId),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "conflict",
    );
    assert.equal(client2.checkDispatch({ threadId, environmentId: env2.environmentId }).allowed, false);
    assert.equal(exec2.received.filter(item => item.method === "process/start").length, 0);
    exec2.reportedCwd = undefined;
    client2.close();
    await provider2.close();

    const freshPersistence = { file: join(root, "drift.sealed"), key: randomBytes(32), scope: `session-${randomUUID()}:codex-environments` };
    const providerSeed = await startFakeProvider();
    const seeder = await connectCodexEnvironments({ endpoint: providerSeed.endpoint, token: providerSeed.token, persistence: freshPersistence });
    seeder.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await seeder.select({ threadId, executor: env1 });
    await seeder.select({ threadId, executor: env2 });
    seeder.close();
    await providerSeed.close();

    const driftedThreads = new Map<string, CodexEnvironmentSelection[]>([
      [threadId, [{ environmentId: env1.environmentId, cwd: env1.cwd, runtimeWorkspaceRoots: env1.roots }]],
    ]);
    provider3 = await startFakeProvider(driftedThreads);
    client3 = await connectCodexEnvironments({ endpoint: provider3.endpoint, token: provider3.token, persistence: freshPersistence });
    await client3.register(env1);
    await client3.register(env2);

    await assert.rejects(
      client3.verify(threadId),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "conflict",
    );
    assert.equal(client3.placement(threadId).status, "uncertain");
    assert.equal((await provider3.invokeTool(env1.environmentId, "process/start")).error?.code, -32000);
    assert.equal((await provider3.invokeTool(env2.environmentId, "process/start")).error?.code, -32000);

    client3.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await assert.rejects(client3.select({ threadId, executor: env3 }), (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain");
    await assert.rejects(client3.reconcile({ threadId, executor: env1 }), (error: unknown) => error instanceof CodexEnvironmentError && error.code === "conflict");

    const reconciled = await client3.reconcile({ threadId, executor: env3 });
    assert.equal(reconciled.future, "verified");
    assert.equal(reconciled.generation, 3);
    assert.equal((await provider3.invokeTool(env3.environmentId, "process/start", { cmd: "ok" })).result.cwd, cwd3);
    assert.equal((await provider3.invokeTool(env2.environmentId, "process/start")).error?.code, -32000);
  } finally {
    client1?.close();
    client2?.close();
    client3?.close();
    await provider1.close();
    await provider2?.close();
    await provider3?.close();
    await exec1.close();
    await exec2.close();
    await exec3.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup discovery admits read-only workspace reads while blocking writes/escapes, and confirmInitialPlacement requires provider evidence", { timeout: 20000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-codex-startup-")));
  const cwd1 = join(root, "ws"), outside = join(root, "outside");
  mkdirSync(cwd1); mkdirSync(outside);
  writeFileSync(join(cwd1, "AGENTS.md"), "Workspace instructions");
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE");
  const persistence = { file: join(root, CODEX_ENVIRONMENT_STATE_FILE), key: randomBytes(32), scope: `session-${randomUUID()}:codex-environments` };
  const threadOk = `thread-ok-${randomUUID()}`;
  const threadOmitted = `thread-omit-${randomUUID()}`;
  const exec1 = await startFakeExecServer(cwd1);
  const provider = await startFakeProvider();
  const client = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, persistence });
  try {
    const env1 = makeExecutor("env-startup-1", exec1);
    await client.register(env1);

    assert.equal((await provider.invokeTool(env1.environmentId, "fs/readFile", { path: join(cwd1, "AGENTS.md") })).error?.code, -32000);
    const endDiscovery = client.beginStartupDiscovery(env1.environmentId);
    try {
      const meta = await provider.invokeTool(env1.environmentId, "fs/getMetadata", { path: join(cwd1, "AGENTS.md") });
      assert.equal(meta.error, undefined);
      assert.equal(meta.result.exists, true);
      const file = await provider.invokeTool(env1.environmentId, "fs/readFile", { path: join(cwd1, "AGENTS.md") });
      assert.equal(file.error, undefined);
      assert.equal(file.result.contents, "Workspace instructions");

      assert.equal((await provider.invokeTool(env1.environmentId, "fs/readFile", { path: join(outside, "secret.txt") })).error?.code, -32000);
      assert.equal((await provider.invokeTool(env1.environmentId, "fs/writeFile", { path: join(cwd1, "AGENTS.md"), contents: "mutated" })).error?.code, -32000);
      assert.equal((await provider.invokeTool(env1.environmentId, "process/start", { cmd: "id" })).error?.code, -32000);
    } finally {
      endDiscovery();
    }
    assert.equal((await provider.invokeTool(env1.environmentId, "fs/readFile", { path: join(cwd1, "AGENTS.md") })).error?.code, -32000);

    provider.threads.set(threadOk, [{ environmentId: env1.environmentId, cwd: env1.cwd, runtimeWorkspaceRoots: env1.roots }]);
    const confirmedViaRead = await client.confirmInitialPlacement({ threadId: threadOk, executor: env1 });
    assert.equal(confirmedViaRead.environmentId, env1.environmentId);
    assert.equal(confirmedViaRead.generation, 1);
    assert.equal((await provider.invokeTool(env1.environmentId, "process/start", { cmd: "ok" })).error, undefined);

    const exec2 = await startFakeExecServer(cwd1);
    try {
      const env2 = makeExecutor("env-startup-2", exec2);
      await client.register(env2);
      provider.omitReadEnvironments = true;
      await assert.rejects(
        client.confirmInitialPlacement({ threadId: threadOmitted, executor: env2 }),
        (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
      );
      assert.equal(client.placement(threadOmitted).status, "uncertain");
      assert.equal(client.checkDispatch({ threadId: threadOmitted, environmentId: env2.environmentId }).allowed, false);
      assert.equal((await provider.invokeTool(env2.environmentId, "process/start")).error?.code, -32000);
    } finally {
      await exec2.close();
    }
  } finally {
    client.close();
    await provider.close();
    await exec1.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("queued pre-handshake tool frames are fenced on both environment switch and same-ID reselection", { timeout: 20000 }, async () => {
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

    exec1.holdNextUpgrades = 1;
    const sameIdChannel = await provider.openPersistentToolChannel(env1.environmentId);
    try {
      const staleGen1 = sameIdChannel.send("process/start", { cmd: "queued-gen-1-before-reselect" });
      await exec1.waitForHeldUpgrade();
      const reselected = await client.select({ threadId, executor: env1 });
      assert.equal(reselected.generation, 2);
      const response = await staleGen1;
      assert.equal(response.error?.code, -32000);
      exec1.releaseUpgrades();
      await new Promise(done => setTimeout(done, 40));
      assert.equal(exec1.received.filter(item => item.method === "process/start").length, 0);
      const gen2Call = await sameIdChannel.send("process/start", { cmd: "fresh-gen-2" });
      assert.equal(gen2Call.error, undefined);
      assert.equal(exec1.received.filter(item => item.method === "process/start").length, 1);
    } finally {
      sameIdChannel.close();
    }

    exec1.holdNextUpgrades = 1;
    const switchChannel = await provider.openPersistentToolChannel(env1.environmentId);
    try {
      const inflight = switchChannel.send("process/start", { cmd: "queued-before-handoff" });
      await exec1.waitForHeldUpgrade();
      await client.select({ threadId, executor: env2 });
      assert.equal((await inflight).error?.code, -32000);
      exec1.releaseUpgrades();
      await new Promise(done => setTimeout(done, 40));
      assert.equal(exec1.received.filter(item => item.method === "process/start").length, 1);
    } finally {
      switchChannel.close();
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

test("crash, write failure, oversized sealed state, unconfigured store, and corrupted files all fail closed", { timeout: 25000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-codex-failclosed-")));
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
    await assert.rejects(unconfigured.select({ threadId, executor: env1 }), (e: unknown) => e instanceof CodexEnvironmentError && e.code === "unavailable");
    unconfigured.close();

    const sizeFile = join(root, "size-limit.sealed");
    const sizeStore = openCodexEnvironmentStore({ file: sizeFile, key, scope });
    const now = new Date().toISOString();
    const validRecord: PersistedCodexEnvironmentState = {
      version: 1,
      scope,
      threads: {
        [threadId]: {
          status: "verified",
          generation: 1,
          revision: 1,
          placement: { environmentId: env1.environmentId, cwd: env1.cwd, runtimeWorkspaceRoots: env1.roots },
          usedEnvironmentIds: [env1.environmentId],
          verifiedAt: now,
          updatedAt: now,
        },
      },
    };
    sizeStore.write(validRecord);
    const beforeOversize = readFileSync(sizeFile, "utf8");
    const bigUsedIds = Array.from({ length: 1200 }, (_, i) => `env-${String(i).padStart(4, "0")}-${"x".repeat(140)}`);
    const oversizedThreads: PersistedCodexEnvironmentState["threads"] = {};
    for (let t = 0; t < 10; t++) {
      oversizedThreads[`thread-oversized-${t}`] = {
        status: "verified",
        generation: 1,
        revision: 1,
        placement: { environmentId: bigUsedIds[0], cwd: env1.cwd, runtimeWorkspaceRoots: env1.roots },
        usedEnvironmentIds: bigUsedIds,
        verifiedAt: now,
        updatedAt: now,
      };
    }
    assert.throws(() => sizeStore.write({ version: 1, scope, threads: oversizedThreads }), /maximum size limit/);
    assert.equal(readFileSync(sizeFile, "utf8"), beforeOversize);
    assert.equal(sizeStore.read().state, "readable");
    assert.ok(Buffer.byteLength(beforeOversize, "utf8") <= MAX_CODEX_ENVIRONMENT_STATE_BYTES);

    const backing = openCodexEnvironmentStore({ file: join(root, "write-fail.sealed"), key, scope });
    let failOnVerifiedWrite = false;
    const flakyStore: CodexEnvironmentStore = {
      scope: backing.scope,
      read: () => backing.read(),
      write: record => {
        if (failOnVerifiedWrite && record.threads[threadId]?.status === "verified") throw new Error("Simulated write failure");
        backing.write(record);
      },
    };
    const clientFlaky = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, store: flakyStore });
    clients.push(clientFlaky);
    clientFlaky.observe({ method: "thread/started", params: { thread: { id: threadId } } });
    await clientFlaky.select({ threadId, executor: env1 });
    failOnVerifiedWrite = true;
    let released = false;
    await assert.rejects(
      clientFlaky.select({ threadId, executor: env3, releaseHeldOperation: () => { released = true; } }),
      (e: unknown) => e instanceof CodexEnvironmentError && e.code === "uncertain",
    );
    assert.equal(released, false);
    assert.equal((await provider.invokeTool(env3.environmentId, "process/start")).error?.code, -32000);
    clientFlaky.close();

    const interruptedFile = join(root, "interrupted.sealed");
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
    const clientInterrupted = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, persistence: { file: interruptedFile, key, scope } });
    clients.push(clientInterrupted);
    assert.equal(clientInterrupted.placement(threadId).status, "uncertain");
    await assert.rejects(clientInterrupted.verify(threadId), (e: unknown) => e instanceof CodexEnvironmentError && e.code === "uncertain");
    clientInterrupted.close();

    const truncatedFile = join(root, "truncated.sealed");
    writeFileSync(truncatedFile, beforeOversize.slice(0, 20), { mode: 0o600 });
    const looseFile = join(root, "loose.sealed");
    writeFileSync(looseFile, beforeOversize, { mode: 0o600 });
    chmodSync(looseFile, 0o644);
    const symlinkFile = join(root, "symlink.sealed");
    symlinkSync(sizeFile, symlinkFile);
    const invalidSchemaFile = join(root, "invalid-schema.sealed");
    writeSealed(invalidSchemaFile, key, scope, { version: 1, scope, threads: { [threadId]: { status: "verified", generation: 0 } } });

    for (const item of [
      { label: "truncated", persistence: { file: truncatedFile, key, scope } },
      { label: "wrong key", persistence: { file: sizeFile, key: randomBytes(32), scope } },
      { label: "wrong scope", persistence: { file: sizeFile, key, scope: "foreign-session:codex-environments" } },
      { label: "loose permissions", persistence: { file: looseFile, key, scope } },
      { label: "symlink", persistence: { file: symlinkFile, key, scope } },
      { label: "invalid schema", persistence: { file: invalidSchemaFile, key, scope } },
    ]) {
      assert.equal(openCodexEnvironmentStore(item.persistence).read().state, "unreadable", item.label);
      const client = await connectCodexEnvironments({ endpoint: provider.endpoint, token: provider.token, persistence: item.persistence });
      try {
        assert.equal(client.storeStatus, "corrupted", item.label);
        assert.equal(client.supportsSelection, false, item.label);
        assert.equal(client.placement(threadId).status, "corrupted", item.label);
        assert.equal(client.checkDispatch({ threadId, environmentId: env1.environmentId }).allowed, false, item.label);
        await client.register(env1);
        assert.equal((await provider.invokeTool(env1.environmentId, "process/start")).error?.code, -32000, item.label);
      } finally {
        client.close();
      }
    }
  } finally {
    for (const client of clients) client.close();
    await provider.close();
    await exec1.close();
    await exec2.close();
    await exec3.close();
    rmSync(root, { recursive: true, force: true });
  }
});
