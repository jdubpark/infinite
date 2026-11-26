import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import {
  CODEX_ENVIRONMENT_STATE_FILE,
  CodexEnvironmentError,
  openCodexEnvironmentStore,
} from "../packages/host/src/codex-environment.js";
import { startNativeCodex } from "../packages/host/src/native-codex.js";
import { makeExecutor, startFakeExecServer } from "./fixtures/codex-environment-harness.js";
import { waitFor } from "./helpers.js";

async function connectObserver(url: string, token: string) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((done, fail) => { ws.once("open", done); ws.once("error", fail); });
  const messages: any[] = [];
  ws.on("message", data => messages.push(JSON.parse(data.toString())));
  let nextId = 1;
  const rpc = async (method: string, params: unknown = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return waitFor(async () => messages.find(item => item.id === id && !item.method), Boolean, 10000);
  };
  await rpc("initialize", { clientInfo: { name: "observer", version: "1" } });
  ws.send(JSON.stringify({ method: "initialized" }));
  return { ws, messages, rpc };
}

test("startNativeCodex allows startup AGENTS.md discovery while blocking writes, verifies omitted start environments via thread/read, and persists across restart", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-native-restart-")));
  const hostCwd = join(root, "host"), laptopCwd = join(root, "laptop"), cloudCwd = join(root, "cloud");
  mkdirSync(hostCwd); mkdirSync(laptopCwd); mkdirSync(cloudCwd);
  writeFileSync(join(laptopCwd, "AGENTS.md"), "LAPTOP_AGENTS_RULES");
  writeFileSync(join(cloudCwd, "AGENTS.md"), "CLOUD_AGENTS_RULES");
  writeFileSync(join(laptopCwd, "marker.txt"), "LAPTOP_VALUE");
  writeFileSync(join(cloudCwd, "marker.txt"), "CLOUD_VALUE");
  const key = randomBytes(32);
  const scope = `session-${randomUUID()}:codex-environments`;
  const stateFile = join(root, CODEX_ENVIRONMENT_STATE_FILE);
  const providerThreadFile = join(root, "provider-thread.json");
  const fixture = resolve("tests/fixtures/native-codex.mjs");
  const profile = { command: process.execPath, args: [fixture] };
  const exec1 = await startFakeExecServer(laptopCwd);
  const exec2 = await startFakeExecServer(cloudCwd);
  const exec3 = await startFakeExecServer(cloudCwd);
  let native1: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let native2: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let nativeDrifted: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let obs1: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let obs2: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let obsDrifted: Awaited<ReturnType<typeof connectObserver>> | undefined;
  try {
    native1 = await startNativeCodex({
      profile,
      cwd: hostCwd,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_THREAD_STATE_FILE: providerThreadFile,
        FIXTURE_STARTUP_DISCOVERY: "1",
        FIXTURE_STARTUP_WRITE_ATTEMPT: "1",
        FIXTURE_OMIT_START_ENVIRONMENTS: "1",
      },
      execution: makeExecutor("native-laptop-1", exec1),
      environmentState: { file: stateFile, key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    assert.equal(native1.supportsExecutionSelection, true);
    obs1 = await connectObserver(native1.url, native1.observerToken);
    const started = await obs1.rpc("thread/start", {});
    assert.equal(started.error, undefined);
    const threadId = started.result.thread.id as string;
    assert.equal(started.result.thread.environments, undefined, "fixture omitted environments from thread/start");
    assert.equal(started.result.thread.discoveredInstructions, "LAPTOP_AGENTS_RULES", "startup discovery must read AGENTS.md");
    assert.equal(started.result.thread.startupWriteBlocked, true, "writes must stay blocked during startup discovery");

    const storedAfterStart = openCodexEnvironmentStore({ file: stateFile, key, scope }).read();
    assert.equal(storedAfterStart.state, "readable");
    if (storedAfterStart.state === "readable") {
      const entry = storedAfterStart.record.threads[threadId];
      assert.equal(entry?.status, "verified");
      if (entry?.status === "verified") {
        assert.equal(entry.generation, 1);
        assert.equal(entry.placement.environmentId, "native-laptop-1");
      }
    }

    const turn1 = await obs1.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(turn1.error, undefined);
    await waitFor(async () => obs1!.messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === turn1.result.turn.id), Boolean, 10000);
    assert.equal(exec1.received.filter(item => item.method === "fixture/read-write").length, 1);

    const receipt = await native1.selectExecution(makeExecutor("native-cloud-2", exec2), () => {});
    assert.equal(receipt.future, "verified");
    assert.equal(receipt.generation, 2);

    obs1.ws.terminate();
    native1.stop();

    let restoredThread: string | undefined;
    native2 = await startNativeCodex({
      profile,
      cwd: hostCwd,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_THREAD_STATE_FILE: providerThreadFile,
        FIXTURE_STARTUP_DISCOVERY: "1",
      },
      resumeThreadId: threadId,
      execution: makeExecutor("native-cloud-2", exec2),
      environmentState: { file: stateFile, key, scope },
      checkControl: () => {},
      onThread: id => { restoredThread = id; },
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    assert.equal(restoredThread, threadId);
    assert.equal(native2.info().sessionId, threadId);
    assert.equal(native2.supportsExecutionSelection, true);
    obs2 = await connectObserver(native2.url, native2.observerToken);
    const resumed = await obs2.rpc("thread/resume", { threadId });
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.thread.discoveredInstructions, "CLOUD_AGENTS_RULES");

    const turn2 = await obs2.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(turn2.error, undefined);
    await waitFor(async () => obs2!.messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === turn2.result.turn.id), Boolean, 10000);
    assert.equal(exec2.received.filter(item => item.method === "fixture/read-write").length, 1);
    assert.equal(exec1.received.filter(item => item.method === "fixture/read-write").length, 1);

    await assert.rejects(
      native2.selectExecution(makeExecutor("native-cloud-3", exec3), () => { throw new Error("release failure"); }),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "uncertain",
    );
    const fencedTurn = await obs2.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.ok(fencedTurn.error);
    assert.equal(exec3.received.filter(item => item.method === "fixture/read-write").length, 0);
    obs2.ws.terminate();
    native2.stop();

    const driftStateFile = join(root, "drift-native.sealed");
    const driftProviderFile = join(root, "drift-provider.json");
    const cleanSeed = await startNativeCodex({
      profile,
      cwd: hostCwd,
      env: { PATH: process.env.PATH ?? "", FIXTURE_THREAD_STATE_FILE: driftProviderFile },
      execution: makeExecutor("native-drift-1", exec1),
      environmentState: { file: driftStateFile, key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    const seedObs = await connectObserver(cleanSeed.url, cleanSeed.observerToken);
    const driftThreadId = (await seedObs.rpc("thread/start", {})).result.thread.id as string;
    await cleanSeed.selectExecution(makeExecutor("native-drift-2", exec2), () => {});
    seedObs.ws.terminate();
    cleanSeed.stop();

    const savedDrift = JSON.parse(readFileSync(driftProviderFile, "utf8"));
    savedDrift.selections = [{ environmentId: "native-drift-1", cwd: laptopCwd, runtimeWorkspaceRoots: [laptopCwd] }];
    writeFileSync(driftProviderFile, JSON.stringify(savedDrift));

    let unavailableSignaled = false;
    nativeDrifted = await startNativeCodex({
      profile,
      cwd: hostCwd,
      env: { PATH: process.env.PATH ?? "", FIXTURE_THREAD_STATE_FILE: driftProviderFile },
      resumeThreadId: driftThreadId,
      execution: makeExecutor("native-drift-2", exec2),
      environmentState: { file: driftStateFile, key, scope },
      onExecutionUnavailable: () => { unavailableSignaled = true; },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    assert.equal(unavailableSignaled, true);
    assert.equal(nativeDrifted.info().sessionId, undefined);
    assert.equal(nativeDrifted.supportsExecutionSelection, false);
    obsDrifted = await connectObserver(nativeDrifted.url, nativeDrifted.observerToken);
    const refusedTurn = await obsDrifted.rpc("turn/start", { threadId: driftThreadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.ok(refusedTurn.error, "drifted restart must refuse turn/start");
    assert.equal(exec2.received.filter(item => item.method === "fixture/read-write").length, 1);
  } finally {
    obs1?.ws.terminate();
    obs2?.ws.terminate();
    obsDrifted?.ws.terminate();
    native1?.stop();
    native2?.stop();
    nativeDrifted?.stop();
    await exec1.close();
    await exec2.close();
    await exec3.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startNativeCodex fails closed when both thread/start and thread/read omit environments or when state is corrupted", { timeout: 25000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-native-omit-")));
  const hostCwd = join(root, "host"), laptopCwd = join(root, "laptop");
  mkdirSync(hostCwd); mkdirSync(laptopCwd);
  const key = randomBytes(32);
  const scope = `session-${randomUUID()}:codex-environments`;
  const fixture = resolve("tests/fixtures/native-codex.mjs");
  const profile = { command: process.execPath, args: [fixture] };
  const exec1 = await startFakeExecServer(laptopCwd);
  let omitNative: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let corruptNative: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let omitObs: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let corruptObs: Awaited<ReturnType<typeof connectObserver>> | undefined;
  try {
    const omitStateFile = join(root, "omit.sealed");
    omitNative = await startNativeCodex({
      profile,
      cwd: hostCwd,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_OMIT_START_ENVIRONMENTS: "1",
        FIXTURE_OMIT_READ_ENVIRONMENTS: "1",
      },
      execution: makeExecutor("native-omit-1", exec1),
      environmentState: { file: omitStateFile, key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    omitObs = await connectObserver(omitNative.url, omitNative.observerToken);
    const omitResult = await omitObs.rpc("thread/start", {});
    assert.ok(omitResult.error, "missing environments in both thread/start and thread/read must fail closed");
    assert.equal(omitNative.info().sessionId, undefined);
    const storedOmit = openCodexEnvironmentStore({ file: omitStateFile, key, scope }).read();
    assert.equal(storedOmit.state, "readable");
    if (storedOmit.state === "readable") {
      const entries = Object.values(storedOmit.record.threads);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.status, "uncertain");
    }

    const badFile = join(root, "corrupt.sealed");
    writeFileSync(badFile, "corrupted-sealed-content", { mode: 0o600 });
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
    corruptObs = await connectObserver(corruptNative.url, corruptNative.observerToken);
    const corruptStart = await corruptObs.rpc("thread/start", {});
    assert.ok(corruptStart.error, "corrupted persisted state must refuse thread/start");
    assert.equal(corruptNative.info().sessionId, undefined);
  } finally {
    omitObs?.ws.terminate();
    corruptObs?.ws.terminate();
    omitNative?.stop();
    corruptNative?.stop();
    await exec1.close();
    rmSync(root, { recursive: true, force: true });
  }
});
