import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import {
  CODEX_ENVIRONMENT_STATE_FILE,
  CodexEnvironmentError,
  openCodexEnvironmentStore,
} from "../packages/host/src/codex-environment.js";
import { prepareCodexWorkerExecution, startNativeCodex } from "../packages/host/src/native-codex.js";
import { startLaptopService } from "../packages/host/src/laptop-service.js";
import { unseal } from "../packages/host/src/vault.js";
import type { Session } from "../packages/host/src/types.js";
import { makeExecutor, startFakeExecServer } from "./fixtures/codex-environment-harness.js";
import { claimControl, startHost, waitFor } from "./helpers.js";

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

    await assert.rejects(
      nativeDrifted.reconcileExecution(makeExecutor("native-drift-1", exec1)),
      (error: unknown) => error instanceof CodexEnvironmentError && error.code === "conflict",
    );
    const reconciled = await nativeDrifted.reconcileExecution(makeExecutor("native-reconciled-3", exec3));
    assert.equal(reconciled.future, "verified");
    assert.equal(reconciled.generation, 3);
    assert.equal(nativeDrifted.supportsExecutionSelection, true);
    assert.equal(nativeDrifted.info().sessionId, driftThreadId);
    const recoveredTurn = await obsDrifted.rpc("turn/start", { threadId: driftThreadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(recoveredTurn.error, undefined);
    await waitFor(async () => obsDrifted!.messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === recoveredTurn.result.turn.id), Boolean, 10000);
    assert.equal(exec3.received.filter(item => item.method === "fixture/read-write").length, 1);
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

test("startNativeCodex scopes thread/read by generation, reverifies resumes omitting environments, bounds held startup frames, and clears startRequest", { timeout: 30000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-native-p2-")));
  const hostCwd = join(root, "host"), cwd1 = join(root, "w1"), cwd2 = join(root, "w2");
  mkdirSync(hostCwd); mkdirSync(cwd1); mkdirSync(cwd2);
  writeFileSync(join(cwd1, "marker.txt"), "W1");
  writeFileSync(join(cwd2, "marker.txt"), "W2");
  const key = randomBytes(32);
  const scope = `session-${randomUUID()}:codex-environments`;
  const fixture = resolve("tests/fixtures/native-codex.mjs");
  const profile = { command: process.execPath, args: [fixture] };
  const exec1 = await startFakeExecServer(cwd1);
  const exec2 = await startFakeExecServer(cwd2);
  const holdReadFile = join(root, "hold-read.flag");
  const omitReadFlagFile = join(root, "omit-read.flag");
  let native: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let floodNative: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let obs: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let obsAfterFail: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let floodWs: WebSocket | undefined;
  try {
    native = await startNativeCodex({
      profile,
      cwd: hostCwd,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_OMIT_RESUME_ENVIRONMENTS: "1",
        FIXTURE_HOLD_FRONTEND_READ_FILE: holdReadFile,
        FIXTURE_OMIT_READ_FLAG_FILE: omitReadFlagFile,
      },
      execution: makeExecutor("native-p2-1", exec1),
      environmentState: { file: join(root, "p2.sealed"), key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    obs = await connectObserver(native.url, native.observerToken);

    obs.ws.send(JSON.stringify({ id: 11, method: "thread/start", params: {} }));
    const started = await waitFor(async () => obs!.messages.find(item => item.id === 11 && !item.method), Boolean, 10000);
    assert.equal(started.error, undefined);
    const threadId = started.result.thread.id as string;

    obs.messages.length = 0;
    obs.ws.send(JSON.stringify({ id: 11, method: "thread/list", params: {} }));
    const listed = await waitFor(async () => obs!.messages.find(item => item.id === 11 && !item.method), Boolean, 10000);
    assert.equal(listed.result.data.length, 1, "reusing thread/start RPC ID must still filter thread/list");
    assert.equal(listed.result.data[0].id, threadId);

    writeFileSync(holdReadFile, "1");
    const staleReadPromise = obs.rpc("thread/read", { threadId });
    await new Promise(done => setTimeout(done, 50));
    const handoff = await native.selectExecution(makeExecutor("native-p2-2", exec2), () => {});
    assert.equal(handoff.generation, 2);
    rmSync(holdReadFile, { force: true });
    const staleRead = await staleReadPromise;
    assert.equal(staleRead.result.thread.environments[0].environmentId, "native-p2-1");

    const turnAfterStaleRead = await obs.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(turnAfterStaleRead.error, undefined, "superseded gen-1 thread/read must not mark gen-2 uncertain");
    await waitFor(async () => obs!.messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === turnAfterStaleRead.result.turn.id), Boolean, 10000);
    assert.equal(exec2.received.filter(item => item.method === "fixture/read-write").length, 1);

    const resumedConfirmed = await obs.rpc("thread/resume", { threadId });
    assert.equal(resumedConfirmed.error, undefined);
    assert.equal(resumedConfirmed.result.thread.environments, undefined);
    const turnAfterResume = await obs.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(turnAfterResume.error, undefined);
    await waitFor(async () => obs!.messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === turnAfterResume.result.turn.id), Boolean, 10000);
    assert.equal(exec2.received.filter(item => item.method === "fixture/read-write").length, 2);

    writeFileSync(omitReadFlagFile, "1");
    const resumedUnverified = await obs.rpc("thread/resume", { threadId });
    assert.equal(resumedUnverified.error?.code, -32000, "thread/resume omitting environments must fail closed when thread/read also omits them");
    await waitFor(async () => obs!.ws.readyState, state => state === WebSocket.CLOSED, 5000);
    assert.equal(native.info().sessionId, undefined);
    obsAfterFail = await connectObserver(native.url, native.observerToken);
    const blockedTurn = await obsAfterFail.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.ok(blockedTurn.error, "turn/start must stay fenced after failed resume reverification");
    assert.equal(exec2.received.filter(item => item.method === "fixture/read-write").length, 2);

    floodNative = await startNativeCodex({
      profile,
      cwd: hostCwd,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_OMIT_START_ENVIRONMENTS: "1",
        FIXTURE_FLOOD_DURING_START_READ: "1",
      },
      execution: makeExecutor("native-flood-1", exec1),
      environmentState: { file: join(root, "flood.sealed"), key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    const floodObs = await connectObserver(floodNative.url, floodNative.observerToken);
    floodWs = floodObs.ws;
    const closedPromise = new Promise<void>(done => floodObs.ws.once("close", () => done()));
    floodObs.ws.send(JSON.stringify({ id: 99, method: "thread/start", params: {} }));
    await waitFor(async () => floodObs.ws.readyState, state => state === WebSocket.CLOSED, 10000);
    await closedPromise;
  } finally {
    obs?.ws.terminate();
    obsAfterFail?.ws.terminate();
    floodWs?.terminate();
    native?.stop();
    floodNative?.stop();
    await exec1.close();
    await exec2.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live worker recovers persisted Codex placement across real provider restart, resumes saved thread, and fails closed on drift", { timeout: 60000 }, async () => {
  const fixture = resolve("tests/fixtures/native-codex.mjs");
  const rootTmp = realpathSync(mkdtempSync(join(tmpdir(), "infinite-worker-recovery-")));
  const threadStateFile = join(rootTmp, "provider-thread-state.json");
  const wrapper = join(rootTmp, "codex-wrapper.sh");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(wrapper, `#!/bin/sh\nexport FIXTURE_THREAD_STATE_FILE=${quote(threadStateFile)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });

  const host = await startHost({ agents: { codex: { command: wrapper, args: [] } } });
  const laptop = join(host.root, "laptop"), cwd = join(laptop, "work");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "marker.txt"), "WORKER_RECOVERY_VALUE");
  const bin = join(host.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${quote(wrapper)} "$@"\n`, { mode: 0o700 });
  const prevPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${prevPath}`;

  const executorPids = new Set<number>();
  let nativeWs: WebSocket | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readProviderPid = () => Number(readFileSync(join(host.config.projects[0].path, "provider-pid"), "utf8"));
  try {
    const sessionId = randomUUID();
    const workspaceToken = randomBytes(32).toString("hex");
    const created = await host.fetchApi("/sessions", "owner", {
      requestId: sessionId,
      provider: "codex",
      projectId: "rehearsal",
      title: "Worker Recovery",
      prompt: "",
      nativeArgs: ["workspace edit"],
      localUi: true,
      workspace: { cwd, roots: [laptop], token: workspaceToken },
    });
    assert.equal(created.status, 201);
    const configPath = join(host.root, "client.json");
    writeFileSync(configPath, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    await startLaptopService({
      origin: host.origin,
      token: host.tokens.owner,
      sessionId,
      workspaceToken,
      cwd,
      roots: [laptop],
      configFile: configPath,
    });
    await waitFor(async () => existsSync(join(cwd, "agent-edit.txt")), Boolean, 20000);
    assert.equal(readFileSync(join(cwd, "agent-edit.txt"), "utf8"), "WORKER_RECOVERY_VALUE\n");
    const executorPid = Number(readFileSync(join(cwd, "executor-pid"), "utf8"));
    executorPids.add(executorPid);

    const sessionPath = `/sessions/${sessionId}`;
    const nativeInfo1 = await waitFor(async () => (await host.fetchApi(`${sessionPath}/native`)).body, value => Boolean(value?.sessionId), 15000);
    const threadId = nativeInfo1.sessionId as string;
    const key = readFileSync(host.config.keyFile);
    const sessionDir = join(host.config.stateDir, "sessions", sessionId);
    const meta = unseal<{ session: Session }>(key, `${sessionId}:meta`, readFileSync(join(sessionDir, "meta.sealed"), "utf8"));
    const providerPid1 = readProviderPid();

    const prepared = prepareCodexWorkerExecution({
      file: join(sessionDir, CODEX_ENVIRONMENT_STATE_FILE),
      key,
      scope: `${sessionId}:codex-environments`,
      workspace: meta.session.workspace!,
    });
    assert.equal(prepared.resumeThreadId, threadId);
    assert.ok(prepared.environmentId);

    process.kill(providerPid1, "SIGKILL");
    const providerPid2 = await waitFor(async () => readProviderPid(), pid => pid !== providerPid1 && alive(pid), 15000);
    assert.notEqual(providerPid2, providerPid1, "provider process must have restarted");
    const nativeInfo2 = await waitFor(async () => (await host.fetchApi(`${sessionPath}/native`)).body, value => value?.sessionId === threadId, 15000);
    assert.equal(nativeInfo2.sessionId, threadId);

    const requestsAfterRecovery = readFileSync(join(host.config.projects[0].path, "provider-requests.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line));
    assert.equal(requestsAfterRecovery.filter(req => req.method === "thread/start").length, 1, "provider restart must resume saved thread instead of starting a new one");
    assert.ok(requestsAfterRecovery.some(req => req.method === "thread/resume" && req.params?.threadId === threadId));

    const control = await claimControl(host, sessionId, "owner");
    const url = new URL(`/api/sessions/${sessionId}/native`, host.origin);
    url.protocol = "ws:";
    url.searchParams.set("client", control.headers["X-Infinite-Client"]);
    url.searchParams.set("lease", control.lease.id);
    const nativeConn = await connectObserver(url.href, host.tokens.owner);
    nativeWs = nativeConn.ws;
    const postRestartTurn = await nativeConn.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(postRestartTurn.error, undefined);
    await waitFor(async () => readFileSync(join(cwd, "agent-edit.txt"), "utf8"), text => text === "WORKER_RECOVERY_VALUE\n".repeat(2), 15000);
    nativeConn.ws.terminate();
    nativeWs = undefined;

    const savedProvider = JSON.parse(readFileSync(threadStateFile, "utf8"));
    savedProvider.selections = [{ environmentId: "drifted-env-id", cwd, runtimeWorkspaceRoots: [laptop] }];
    writeFileSync(threadStateFile, JSON.stringify(savedProvider));
    process.kill(providerPid2, "SIGKILL");

    const providerPid3 = await waitFor(async () => readProviderPid(), pid => pid !== providerPid2 && alive(pid), 15000);
    assert.notEqual(providerPid3, providerPid2);
    await waitFor(
      async () => (await host.fetchApi(`${sessionPath}/native`)).body,
      body => body?.sessionId === undefined,
      15000,
    );
    const driftedState = (await host.fetchApi(sessionPath)).body;
    assert.equal(driftedState.status, "running");
    assert.equal(driftedState.execution.cloudReady, false);
    assert.equal(readFileSync(join(cwd, "agent-edit.txt"), "utf8"), "WORKER_RECOVERY_VALUE\n".repeat(2));
  } finally {
    process.env.PATH = prevPath;
    nativeWs?.terminate();
    for (const pid of executorPids) if (alive(pid)) try { process.kill(pid, "SIGTERM"); } catch {}
    await host.stop();
    rmSync(rootTmp, { recursive: true, force: true });
  }
});

test("startNativeCodex preserves paginated history and placement verification across detach, rejoin, handoff, and legacy fallback", { timeout: 35000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-native-paginated-env-")));
  const hostPaginatedCwd = join(root, "host-paginated"), hostFallbackCwd = join(root, "host-fallback"), hostLegacyCwd = join(root, "host-legacy");
  const laptopCwd = join(root, "laptop"), cloudCwd = join(root, "cloud");
  mkdirSync(hostPaginatedCwd); mkdirSync(hostFallbackCwd); mkdirSync(hostLegacyCwd); mkdirSync(laptopCwd); mkdirSync(cloudCwd);
  writeFileSync(join(laptopCwd, "marker.txt"), "PAGINATED_LAPTOP");
  writeFileSync(join(cloudCwd, "marker.txt"), "PAGINATED_CLOUD");
  const key = randomBytes(32);
  const scope = `session-${randomUUID()}:codex-environments`;
  const fixture = resolve("tests/fixtures/native-codex.mjs");
  const profile = { command: process.execPath, args: [fixture] };
  const exec1 = await startFakeExecServer(laptopCwd);
  const exec2 = await startFakeExecServer(cloudCwd);
  const execFallback = await startFakeExecServer(laptopCwd);
  const execLegacy = await startFakeExecServer(laptopCwd);
  const omitReadFlagFile = join(root, "omit-read.flag");
  let nativePaginated: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let nativeFallback: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let nativeLegacy: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
  let obs1: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let client2: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let obsAfterFail: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let obsFallback: Awaited<ReturnType<typeof connectObserver>> | undefined;
  let obsLegacy: Awaited<ReturnType<typeof connectObserver>> | undefined;
  try {
    nativePaginated = await startNativeCodex({
      profile,
      cwd: hostPaginatedCwd,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_USER_AGENT: "infinite_execution/0.172.0 (Linux 6.8; x86_64)",
        FIXTURE_DEFAULT_HISTORY_MODE: "paginated",
        FIXTURE_OMIT_RESUME_ENVIRONMENTS: "1",
        FIXTURE_OMIT_READ_FLAG_FILE: omitReadFlagFile,
      },
      execution: makeExecutor("paginated-laptop-1", exec1),
      environmentState: { file: join(root, "paginated.sealed"), key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    obs1 = await connectObserver(nativePaginated.url, nativePaginated.observerToken);
    const started = await obs1.rpc("thread/start", { historyMode: "paginated" });
    assert.equal(started.error, undefined);
    const threadId = started.result.thread.id as string;
    assert.equal(started.result.thread.historyMode, "paginated");

    const turn1 = await obs1.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.equal(turn1.error, undefined);
    await waitFor(async () => obs1!.messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === turn1.result.turn.id), Boolean, 10000);
    await waitFor(async () => nativePaginated!.info().sessionId, value => value === threadId, 10000);
    assert.equal(exec1.received.filter(item => item.method === "fixture/read-write").length, 1);

    const reqsAfterStart = readFileSync(join(hostPaginatedCwd, "provider-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const startReq = reqsAfterStart.find(req => req.method === "thread/start");
    assert.equal(startReq?.params?.historyMode, "paginated");
    assert.equal(startReq?.params?.cwd, laptopCwd);
    assert.equal(startReq?.params?.environments?.[0]?.environmentId, "paginated-laptop-1");
    assert.ok(reqsAfterStart.some(req => req.method === "thread/turns/list" && req.params?.threadId === threadId && req.params?.limit === 1));
    assert.ok(reqsAfterStart.some(req => req.method === "thread/read" && req.params?.threadId === threadId && req.params?.includeTurns === false));

    obs1.ws.terminate();
    await waitFor(async () => obs1!.ws.readyState, state => state === WebSocket.CLOSED, 5000);

    const attach = nativePaginated.connect({ actor: { id: "owner-1", label: "Owner" }, leaseId: "lease-paginated-1" });
    client2 = await connectObserver(attach.url, attach.token);
    const resumed = await client2.rpc("thread/resume", { threadId, excludeTurns: true, cwd: hostPaginatedCwd });
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result.thread.historyMode, "paginated");
    assert.equal(resumed.result.thread.environments, undefined);
    assert.deepEqual(resumed.result.thread.turns, []);
    assert.equal(typeof resumed.result.turnsBackwardsCursor, "string");
    assert.equal(typeof resumed.result.itemsBackwardsCursor, "string");

    const turnsPage = await client2.rpc("thread/turns/list", { threadId, cursor: resumed.result.turnsBackwardsCursor, sortDirection: "desc", itemsView: "full" });
    assert.equal(turnsPage.error, undefined);
    assert.deepEqual(turnsPage.result.data.map((turn: { text: string; status: string }) => [turn.text, turn.status]), [["workspace edit", "completed"]]);
    const itemsPage = await client2.rpc("thread/items/list", { threadId, cursor: resumed.result.itemsBackwardsCursor, sortDirection: "desc" });
    assert.equal(itemsPage.error, undefined);
    assert.deepEqual(itemsPage.result.data.map((entry: { item: { text: string } }) => entry.item.text), ["reply:workspace edit", "workspace edit"]);

    for (const method of ["thread/turns/list", "thread/items/list"] as const) {
      assert.equal((await client2.rpc(method, { threadId: randomUUID() })).error?.code, -32600);
      assert.equal((await client2.rpc(method, {})).error?.code, -32600);
    }

    const turn2 = await client2.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit held" }] });
    assert.equal(turn2.error, undefined);
    await waitFor(async () => client2!.messages.some(item => item.method === "fixture/turn-held" && item.params?.turnId === turn2.result.turn.id), Boolean, 10000);
    const heldTurns = await client2.rpc("thread/turns/list", { threadId, sortDirection: "desc", limit: 1 });
    assert.equal(heldTurns.result.data[0]?.status, "inProgress", "held turn must stay inProgress in paginated history until completion");
    assert.equal((await client2.rpc("fixture/release-turn", {})).result.released, true);
    await waitFor(async () => client2!.messages.some(item => item.method === "turn/completed" && item.params?.turn?.id === turn2.result.turn.id), Boolean, 10000);
    const finishedTurns = await client2.rpc("thread/turns/list", { threadId, sortDirection: "desc", limit: 1 });
    assert.equal(finishedTurns.result.data[0]?.status, "completed");
    assert.equal(exec1.received.filter(item => item.method === "fixture/read-write").length, 2);

    const reqsAfterResume = readFileSync(join(hostPaginatedCwd, "provider-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const resumeReq = reqsAfterResume.find(req => req.method === "thread/resume");
    assert.equal(resumeReq?.params?.cwd, undefined, "paginated thread/resume must still strip cwd");
    assert.equal(resumeReq?.params?.excludeTurns, true, "paginated thread/resume must preserve excludeTurns");

    const handoff = await nativePaginated.selectExecution(makeExecutor("paginated-cloud-2", exec2), () => {});
    assert.equal(handoff.generation, 2);

    const stateFile = join(root, "paginated-restore.json");
    const restoreCwd = join(root, "host-restore");
    mkdirSync(restoreCwd);
    const execRestore = await startFakeExecServer(laptopCwd);
    let nativeRestore1: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
    let nativeRestore2: Awaited<ReturnType<typeof startNativeCodex>> | undefined;
    let obsRestore: Awaited<ReturnType<typeof connectObserver>> | undefined;
    try {
      const restoreEnvState = { file: join(root, "restore.sealed"), key, scope: `session-${randomUUID()}:codex-environments` };
      const restoreEnv = {
        PATH: process.env.PATH ?? "",
        FIXTURE_USER_AGENT: "infinite_execution/0.172.0 (Linux 6.8; x86_64)",
        FIXTURE_DEFAULT_HISTORY_MODE: "paginated",
        FIXTURE_THREAD_STATE_FILE: stateFile,
      };
      nativeRestore1 = await startNativeCodex({
        profile, cwd: restoreCwd, env: restoreEnv, execution: makeExecutor("restore-laptop-1", execRestore),
        environmentState: restoreEnvState, checkControl: () => {}, onThread: () => {}, onExit: () => {}, onSignal: () => {}, noAltScreen: false, record: () => {},
      });
      obsRestore = await connectObserver(nativeRestore1.url, nativeRestore1.observerToken);
      const restoreStarted = await obsRestore.rpc("thread/start", {});
      const restoreThreadId = restoreStarted.result.thread.id as string;
      await obsRestore.rpc("turn/start", { threadId: restoreThreadId, input: [{ type: "text", text: "complete" }] });
      await waitFor(async () => nativeRestore1!.info().sessionId, value => value === restoreThreadId, 10000);
      obsRestore.ws.terminate();
      nativeRestore1.stop();
      nativeRestore1 = undefined;
      writeFileSync(join(restoreCwd, "provider-requests.jsonl"), "");

      nativeRestore2 = await startNativeCodex({
        profile, cwd: restoreCwd, env: restoreEnv, execution: makeExecutor("restore-laptop-1", execRestore),
        environmentState: restoreEnvState, resumeThreadId: restoreThreadId,
        checkControl: () => {}, onThread: () => {}, onExit: () => {}, onSignal: () => {}, noAltScreen: false, record: () => {},
      });
      assert.equal(nativeRestore2.info().sessionId, restoreThreadId);
      const restoreReqs = readFileSync(join(restoreCwd, "provider-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      const internalResume = restoreReqs.find(req => req.method === "thread/resume");
      assert.equal(internalResume?.params?.threadId, restoreThreadId);
      assert.equal(internalResume?.params?.excludeTurns, true, "internal restoreThread must pass excludeTurns: true on pagination-capable backends");
    } finally {
      obsRestore?.ws.terminate();
      nativeRestore1?.stop();
      nativeRestore2?.stop();
      await execRestore.close();
    }

    writeFileSync(omitReadFlagFile, "1");
    const unverifiedResume = await client2.rpc("thread/resume", { threadId, excludeTurns: true });
    assert.equal(unverifiedResume.error?.code, -32000, "paginated thread/resume omitting environments must still fail closed when thread/read cannot verify placement");
    await waitFor(async () => client2!.ws.readyState, state => state === WebSocket.CLOSED, 5000);
    assert.equal(nativePaginated.info().sessionId, undefined);
    obsAfterFail = await connectObserver(nativePaginated.url, nativePaginated.observerToken);
    const fencedTurn = await obsAfterFail.rpc("turn/start", { threadId, input: [{ type: "text", text: "workspace edit" }] });
    assert.ok(fencedTurn.error);
    assert.equal(exec2.received.filter(item => item.method === "fixture/read-write").length, 0);

    nativeFallback = await startNativeCodex({
      profile,
      cwd: hostFallbackCwd,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_USER_AGENT: "infinite_execution/0.172.0 (Linux 6.8; x86_64)",
        FIXTURE_UNSUPPORTED_PAGINATION: "1",
      },
      execution: makeExecutor("fallback-laptop-1", execFallback),
      environmentState: { file: join(root, "fallback.sealed"), key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    obsFallback = await connectObserver(nativeFallback.url, nativeFallback.observerToken);
    const fallbackStarted = await obsFallback.rpc("thread/start", {});
    assert.equal(fallbackStarted.error, undefined);
    const fallbackReqs = readFileSync(join(hostFallbackCwd, "provider-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const fallbackStarts = fallbackReqs.filter(req => req.method === "thread/start");
    assert.equal(fallbackStarts.length, 2);
    assert.equal(fallbackStarts[0].params?.historyMode, undefined);
    assert.equal(fallbackStarts[1].params?.historyMode, "legacy");
    assert.equal(fallbackStarts[1].params?.environments?.[0]?.environmentId, "fallback-laptop-1");

    nativeLegacy = await startNativeCodex({
      profile,
      cwd: hostLegacyCwd,
      env: {
        PATH: process.env.PATH ?? "",
        FIXTURE_USER_AGENT: "infinite_execution/0.162.0 (Linux 6.8; x86_64)",
        FIXTURE_REQUIRE_LEGACY_HISTORY: "1",
      },
      execution: makeExecutor("legacy-laptop-1", execLegacy),
      environmentState: { file: join(root, "legacy.sealed"), key, scope },
      checkControl: () => {},
      onThread: () => {},
      onExit: () => {},
      onSignal: () => {},
      noAltScreen: false,
      record: () => {},
    });
    obsLegacy = await connectObserver(nativeLegacy.url, nativeLegacy.observerToken);
    const legacyStarted = await obsLegacy.rpc("thread/start", { historyMode: "paginated" });
    assert.equal(legacyStarted.error, undefined);
    const legacyReqs = readFileSync(join(hostLegacyCwd, "provider-requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const legacyStart = legacyReqs.find(req => req.method === "thread/start");
    assert.equal(legacyStart?.params?.historyMode, "legacy");
    assert.equal(legacyStart?.params?.environments?.[0]?.environmentId, "legacy-laptop-1");
  } finally {
    obs1?.ws.terminate();
    client2?.ws.terminate();
    obsAfterFail?.ws.terminate();
    obsFallback?.ws.terminate();
    obsLegacy?.ws.terminate();
    nativePaginated?.stop();
    nativeFallback?.stop();
    nativeLegacy?.stop();
    await exec1.close();
    await exec2.close();
    await execFallback.close();
    await execLegacy.close();
    rmSync(root, { recursive: true, force: true });
  }
});
