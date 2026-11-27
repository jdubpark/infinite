import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialAttention } from "@infinite/attention";
import { assertPrivateCredentialFile, hashToken, readConfig } from "../packages/host/src/config.js";
import {
  MAX_SOCKET_PATH_BYTES,
  ensureSocketDir,
  existingWorkerSocket,
  legacyHashSocketName,
  legacySocketPath,
  permissionChannelPath,
  socketPath,
  workerCall,
} from "../packages/host/src/ipc.js";
import { Manager } from "../packages/host/src/manager.js";
import { HeadlessPermissionChannel, channelCall, channelSocketPath, channelToken } from "../packages/host/src/permission-headless.js";
import type { PermissionPipeline } from "../packages/host/src/permission-agent-types.js";
import { createApp } from "../packages/host/src/server.js";
import { writeSealed } from "../packages/host/src/vault.js";
import type { Config, Session } from "../packages/host/src/types.js";
import { endSessionWorkers, waitFor } from "./helpers.js";

function makeConfig(root: string, options: { runDir: string; socketDir?: string; script?: string; claudeScript?: string }): { config: Config; key: Buffer } {
  const projectDir = join(root, "project");
  const stateDir = join(root, "state");
  const keyFile = join(root, "key");
  const key = randomBytes(32);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(keyFile, key, { mode: 0o600 });
  const agents: Config["agents"] = {
    ...(options.script ? { demo: { command: process.execPath, args: [options.script] } } : {}),
    ...(options.claudeScript ? { claude: { command: process.execPath, args: [options.claudeScript, "--print"] } } : {}),
  };
  const config: Config = {
    port: 0,
    origin: "http://127.0.0.1:4780",
    keyFile,
    stateDir,
    runDir: options.runDir,
    ...(options.socketDir !== undefined ? { socketDir: options.socketDir } : {}),
    environment: "local",
    enableDemo: true,
    maxSessions: 8,
    tokens: [{ id: "owner", label: "Owner", role: "owner", hash: hashToken("token-value") }],
    projects: [{ id: "fixture", name: "Fixture", path: projectDir }],
    agents,
    attention: { hooks: { claude: true, codex: false }, idleAfterMs: 3000, limitConfirmMs: 30000 },
  };
  return { config, key };
}

function writeFakeMeta(config: Config, key: Buffer, id: string, extra: Partial<Session> = {}) {
  mkdirSync(join(config.stateDir, "sessions", id), { recursive: true, mode: 0o700 });
  writeSealed(join(config.stateDir, "sessions", id, "meta.sealed"), key, `${id}:meta`, {
    session: {
      id,
      provider: "demo",
      title: "Fixture worker",
      projectId: "fixture",
      cwd: config.projects[0]!.path,
      createdAt: "2026-11-26T00:00:00.000Z",
      status: "running",
      contextVersion: 0,
      context: "",
      initialPrompt: "",
      ...extra,
    } as Session,
    fingerprint: `fp-${id}`,
  });
}

function listenFakeWorker(path: string, pid: number): Promise<Server> {
  const server: Server = createServer(socket => {
    socket.on("error", () => {});
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      socket.end(`${JSON.stringify({ result: { status: "running", pid, seq: 9, screen: "", attention: initialAttention("2026-11-26T00:00:00.000Z", false) } })}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

function allowPipeline(): PermissionPipeline {
  return {
    serves: () => ({ served: true }),
    classOf: () => undefined,
    decide: async () => ({ kind: "allow", decisionId: randomUUID(), strongTier: false }),
    applicable: () => true,
    recordDelivery: () => {},
    taskEnded: () => {},
  };
}

test("Manager supports custom socketDir with strict 0700 enforcement and cleans up sockets on exit", { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-sock-root-")));
  const longRunDir = join(root, "nested-long-runtime-directory-name-exceeding-unix-socket-limit", "run");
  const shortSocketDir = mkdtempSync(join(tmpdir(), "is-"));
  const optionSocketDir = mkdtempSync(join(tmpdir(), "io-"));
  const script = join(root, "agent.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  chmodSync(shortSocketDir, 0o755);
  let activeConfig: Config | undefined;
  try {
    const withoutSocketDir = makeConfig(root, { runDir: longRunDir, script });
    assert.throws(() => new Manager(withoutSocketDir.config, withoutSocketDir.key), /runDir is too long for a Unix socket/);
    assert.equal(existsSync(longRunDir), false);

    const { config, key } = makeConfig(root, { runDir: longRunDir, socketDir: shortSocketDir, script });
    activeConfig = config;
    const manager = new Manager(config, key);
    assert.equal(manager.socketDir, shortSocketDir);
    assert.equal(statSync(shortSocketDir).mode & 0o777, 0o700);

    const id = randomUUID();
    const created = await manager.create({ requestId: id, provider: "demo", projectId: "fixture", title: "Socket dir", prompt: "" });
    assert.equal(created.status, "running");
    const expectedSocket = socketPath(config, id);
    assert.ok(expectedSocket.startsWith(shortSocketDir));
    assert.ok(Buffer.byteLength(expectedSocket) <= MAX_SOCKET_PATH_BYTES);
    assert.equal(existsSync(expectedSocket), true);
    assert.equal(statSync(expectedSocket).mode & 0o777, 0o600);
    assert.equal(existsSync(legacySocketPath(longRunDir, id)), false);
    assert.equal((await manager.state(id)).status, "running");
    assert.equal((await manager.list()).find(row => row.id === id)?.status, "running");

    await endSessionWorkers(config);
    await waitFor(async () => existsSync(expectedSocket), present => !present, 10_000);

    const overrideManager = new Manager(withoutSocketDir.config, withoutSocketDir.key, undefined, { socketDir: optionSocketDir });
    assert.equal(overrideManager.socketDir, optionSocketDir);
    assert.equal(statSync(optionSocketDir).mode & 0o777, 0o700);
  } finally {
    if (activeConfig) await endSessionWorkers(activeConfig).catch(() => {});
    rmSync(shortSocketDir, { recursive: true, force: true });
    rmSync(optionSocketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureSocketDir rejects overly long paths, symlinks, relative segments, shared roots, and non-sticky writable parents", () => {
  const root = mkdtempSync(join(tmpdir(), "sv-"));
  try {
    const tooLong = join(root, "a".repeat(90));
    assert.throws(() => ensureSocketDir(tooLong, "socketDir"), /socketDir is too long for a Unix socket/);
    assert.equal(existsSync(tooLong), false);

    const realTarget = join(root, "real");
    mkdirSync(realTarget, { mode: 0o700 });
    const linkDir = join(root, "link");
    symlinkSync(realTarget, linkDir);
    assert.throws(() => ensureSocketDir(linkDir, "socketDir"), /symlink/);
    assert.throws(() => ensureSocketDir(`${linkDir}/`, "socketDir"), /symlink/);
    assert.throws(() => ensureSocketDir(join(linkDir, "sub"), "socketDir"), /symlink/);
    assert.throws(() => ensureSocketDir(`${linkDir}/..`, "socketDir"), /relative path segments/);
    assert.throws(() => ensureSocketDir(`${realTarget}/../real`, "socketDir"), /relative path segments/);

    const brokenLink = join(root, "broken");
    symlinkSync(join(root, "missing"), brokenLink);
    assert.throws(() => ensureSocketDir(brokenLink, "socketDir"), /symlink/);
    assert.throws(() => ensureSocketDir(`${brokenLink}/`, "socketDir"), /symlink/);

    const worldWritableParent = join(root, "ww");
    mkdirSync(worldWritableParent, { mode: 0o700 });
    chmodSync(worldWritableParent, 0o777);
    const childUnderWorld = join(worldWritableParent, "s");
    mkdirSync(childUnderWorld, { mode: 0o700 });
    assert.throws(() => ensureSocketDir(childUnderWorld, "socketDir"), /writable non-sticky parent/);

    const groupWritableParent = join(root, "gw");
    mkdirSync(groupWritableParent, { mode: 0o700 });
    chmodSync(groupWritableParent, 0o770);
    const childUnderGroup = join(groupWritableParent, "s");
    mkdirSync(childUnderGroup, { mode: 0o700 });
    assert.throws(() => ensureSocketDir(childUnderGroup, "socketDir"), /writable non-sticky parent/);

    const stickyParent = join(root, "st");
    mkdirSync(stickyParent, { mode: 0o700 });
    chmodSync(stickyParent, 0o1777);
    const childUnderSticky = join(stickyParent, "s");
    mkdirSync(childUnderSticky, { mode: 0o700 });
    assert.equal(ensureSocketDir(childUnderSticky, "socketDir"), childUnderSticky);

    assert.equal(ensureSocketDir(`${realTarget}/`, "socketDir"), realTarget);

    for (const shared of ["/", tmpdir()]) {
      assert.throws(() => ensureSocketDir(shared, "socketDir"), /shared root/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("short deterministic socket paths fit within 100 bytes under a macOS-length temp directory", { timeout: 30_000 }, async () => {
  const outer = mkdtempSync(join(tmpdir(), "s-"));
  let simTmp = outer;
  if (Buffer.byteLength(simTmp) < 56) {
    const needed = 56 - Buffer.byteLength(simTmp) - 3;
    simTmp = join(simTmp, "f", "x".repeat(Math.max(1, needed)));
    mkdirSync(simTmp, { recursive: true, mode: 0o700 });
  }
  assert.ok(Buffer.byteLength(simTmp) >= 56, `expected >= 56 bytes, got ${Buffer.byteLength(simTmp)}`);
  const root = mkdtempSync(join(simTmp, "inf-"));
  const runDir = join(root, "run");
  const script = join(root, "agent.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  let activeConfig: Config | undefined;
  try {
    const id = randomUUID();
    assert.ok(Buffer.byteLength(legacySocketPath(runDir, id)) > MAX_SOCKET_PATH_BYTES);
    assert.ok(Buffer.byteLength(socketPath(runDir, id)) <= MAX_SOCKET_PATH_BYTES);
    assert.ok(Buffer.byteLength(permissionChannelPath({ runDir, socketDir: join(simTmp, "sk") })) <= MAX_SOCKET_PATH_BYTES);

    const { config, key } = makeConfig(root, { runDir, script });
    activeConfig = config;
    const manager = new Manager(config, key);
    const created = await manager.create({ requestId: id, provider: "demo", projectId: "fixture", title: "Long tmpdir", prompt: "" });
    assert.equal(created.status, "running");
    assert.equal((await manager.state(id)).status, "running");
    await endSessionWorkers(config);
    await waitFor(async () => existsSync(socketPath(runDir, id)), present => !present, 10_000);
  } finally {
    if (activeConfig) await endSessionWorkers(activeConfig).catch(() => {});
    rmSync(outer, { recursive: true, force: true });
  }
});

test("Manager and workerCall remain compatible with legacy runDir UUID and un-scoped hash sockets", async () => {
  mkdirSync(".local", { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(".local", "lg-"));
  const runDir = join(root, "r");
  const customSocketDir = mkdtempSync(join(tmpdir(), "il-"));
  const { config, key } = makeConfig(root, { runDir, socketDir: customSocketDir });
  const uuidId = randomUUID(), hashId = randomUUID();
  const legacyUuidFile = legacySocketPath(runDir, uuidId);
  const legacyHashFile = join(runDir, legacyHashSocketName(hashId));
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  writeFakeMeta(config, key, uuidId);
  writeFakeMeta(config, key, hashId);
  const servers: Server[] = [];
  try {
    servers.push(await listenFakeWorker(legacyUuidFile, 4242));
    servers.push(await listenFakeWorker(legacyHashFile, 4343));
    const manager = new Manager(config, key);
    assert.equal((await manager.state(uuidId)).pid, 4242);
    assert.equal((await manager.state(hashId)).pid, 4343);
    const listed = await manager.list();
    assert.equal(listed.find(row => row.id === uuidId)?.pid, 4242);
    assert.equal(listed.find(row => row.id === hashId)?.pid, 4343);
    assert.equal((await workerCall<{ pid: number }>(manager.socketTarget, uuidId, { op: "state" })).pid, 4242);
    assert.equal((await workerCall<{ pid: number }>(manager.socketTarget, hashId, { op: "state" })).pid, 4343);
  } finally {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(customSocketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("existingWorkerSocket rejects untrusted runDirs, symlinked fallback sockets, and short-circuits missing entries without dir walks", async () => {
  mkdirSync(".local", { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(".local", "ut-"));
  const socketDir = mkdtempSync(join(tmpdir(), "iu-"));
  const realDir = join(root, "real");
  const linkRunDir = join(root, "link");
  const permRunDir = join(root, "wide");
  const badParent = join(root, "wparent");
  const badParentRunDir = join(badParent, "run");
  const trustedRunDir = join(root, "priv");
  const externalDir = join(root, "ext");
  mkdirSync(realDir, { mode: 0o700 });
  symlinkSync(realDir, linkRunDir);
  mkdirSync(permRunDir, { mode: 0o755 });
  chmodSync(permRunDir, 0o755);
  mkdirSync(badParent, { mode: 0o700 });
  chmodSync(badParent, 0o777);
  mkdirSync(badParentRunDir, { mode: 0o700 });
  mkdirSync(trustedRunDir, { mode: 0o700 });
  mkdirSync(externalDir, { mode: 0o700 });
  const idA = randomUUID(), idB = randomUUID(), idC = randomUUID(), idD = randomUUID(), idMissing = randomUUID();
  const servers: Server[] = [];
  try {
    const emptyCache = new Map<string, boolean>();
    assert.equal(existingWorkerSocket({ runDir: trustedRunDir, socketDir }, idMissing, join(trustedRunDir, "absent.sock"), emptyCache), undefined);
    assert.equal(emptyCache.size, 0);

    servers.push(await listenFakeWorker(legacySocketPath(realDir, idA), 5001));
    assert.equal(existingWorkerSocket({ runDir: linkRunDir, socketDir }, idA), undefined);
    await assert.rejects(workerCall({ runDir: linkRunDir, socketDir }, idA, { op: "state" }), /Worker unavailable/);

    servers.push(await listenFakeWorker(legacySocketPath(permRunDir, idB), 5002));
    const untrustedCache = new Map<string, boolean>();
    assert.equal(existingWorkerSocket({ runDir: permRunDir, socketDir }, idB, undefined, untrustedCache), undefined);
    assert.equal(untrustedCache.get(permRunDir), false);
    await assert.rejects(workerCall({ runDir: permRunDir, socketDir }, idB, { op: "state" }), /Worker unavailable/);

    servers.push(await listenFakeWorker(legacySocketPath(badParentRunDir, idD), 5004));
    assert.equal(existingWorkerSocket({ runDir: badParentRunDir, socketDir }, idD), undefined);

    const externalSocket = join(externalDir, "target.sock");
    servers.push(await listenFakeWorker(externalSocket, 5003));
    symlinkSync(externalSocket, legacySocketPath(trustedRunDir, idC));
    assert.equal(existingWorkerSocket({ runDir: trustedRunDir, socketDir }, idC), undefined);
    await assert.rejects(workerCall({ runDir: trustedRunDir, socketDir }, idC, { op: "state" }), /Worker unavailable/);
  } finally {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(socketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("two hosts sharing one socketDir or overlapping socketDirA === runDirB keep disjoint worker and permission sockets", { timeout: 30_000 }, async () => {
  const rootA = mkdtempSync(join(tmpdir(), "ha-"));
  const rootB = mkdtempSync(join(tmpdir(), "hb-"));
  const rootC = mkdtempSync(join(tmpdir(), "hc-"));
  const sharedSocketDir = mkdtempSync(join(tmpdir(), "hs-"));
  const scriptA = join(rootA, "agent.mjs");
  const scriptB = join(rootB, "agent.mjs");
  writeFileSync(scriptA, "setInterval(() => {}, 1000);\n");
  writeFileSync(scriptB, "setInterval(() => {}, 1000);\n");
  const { config: configA, key: keyA } = makeConfig(rootA, { runDir: join(rootA, "run"), socketDir: sharedSocketDir, script: scriptA });
  const { config: configB, key: keyB } = makeConfig(rootB, { runDir: join(rootB, "run"), socketDir: sharedSocketDir, script: scriptB });
  const overlapDir = join(rootC, "run");
  const { config: configC, key: keyC } = makeConfig(rootC, { runDir: overlapDir });
  const { config: configOverlap, key: keyOverlap } = makeConfig(rootA, { runDir: join(rootA, "run-ov"), socketDir: overlapDir });
  let appA: ReturnType<typeof createApp> | undefined;
  let appB: ReturnType<typeof createApp> | undefined;
  let appC: ReturnType<typeof createApp> | undefined;
  let appOverlap: ReturnType<typeof createApp> | undefined;
  const closeApp = async (app: ReturnType<typeof createApp> | undefined) => {
    if (!app) return;
    const closing = app.closeConnections();
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    await closing;
    await app.missions.idle();
    await app.teams.idle();
  };
  try {
    appA = createApp(configA, keyA);
    appB = createApp(configB, keyB);
    await new Promise<void>(resolve => appA!.server.listen(0, "127.0.0.1", resolve));
    const channelA = permissionChannelPath(appA.manager.socketTarget);
    const channelB = permissionChannelPath(appB.manager.socketTarget);
    assert.notEqual(channelA, channelB);
    await waitFor(async () => existsSync(channelA), present => present, 5_000);
    const inoA = statSync(channelA).ino;

    await new Promise<void>(resolve => appB!.server.listen(0, "127.0.0.1", resolve));
    await waitFor(async () => existsSync(channelB), present => present, 5_000);
    assert.equal(statSync(channelA).ino, inoA);

    const sameSessionId = randomUUID();
    assert.notEqual(socketPath(appA.manager.socketTarget, sameSessionId), socketPath(appB.manager.socketTarget, sameSessionId));
    const createdA = await appA.manager.create({ requestId: sameSessionId, provider: "demo", projectId: "fixture", title: "Host A", prompt: "" });
    const createdB = await appB.manager.create({ requestId: sameSessionId, provider: "demo", projectId: "fixture", title: "Host B", prompt: "" });
    assert.equal(createdA.status, "running");
    assert.equal(createdB.status, "running");
    assert.notEqual(createdA.pid, createdB.pid);

    const cliReader = new Manager(configA, keyA);
    assert.equal((await cliReader.state(sameSessionId)).pid, createdA.pid);
    assert.equal((await appA.manager.state(sameSessionId)).pid, createdA.pid);

    appC = createApp(configC, keyC);
    await new Promise<void>(resolve => appC!.server.listen(0, "127.0.0.1", resolve));
    const channelC = permissionChannelPath(appC.manager.socketTarget);
    assert.equal(channelC, channelSocketPath(overlapDir));
    await waitFor(async () => existsSync(channelC), present => present, 5_000);
    const inoC = statSync(channelC).ino;

    appOverlap = createApp(configOverlap, keyOverlap);
    const channelOverlap = permissionChannelPath(appOverlap.manager.socketTarget);
    assert.notEqual(channelOverlap, channelC);
    await new Promise<void>(resolve => appOverlap!.server.listen(0, "127.0.0.1", resolve));
    await waitFor(async () => existsSync(channelOverlap), present => present, 5_000);
    assert.equal(statSync(channelC).ino, inoC);
  } finally {
    await endSessionWorkers(configA).catch(() => {});
    await endSessionWorkers(configB).catch(() => {});
    await closeApp(appOverlap);
    await closeApp(appC);
    await closeApp(appB);
    await closeApp(appA);
    rmSync(sharedSocketDir, { recursive: true, force: true });
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
    rmSync(rootC, { recursive: true, force: true });
  }
});

test("restarting across socketDir migrations preserves surviving workers and their permission channel", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mg-"));
  const runDir = join(root, "run");
  const dirA = mkdtempSync(join(tmpdir(), "ma-"));
  const dirB = mkdtempSync(join(tmpdir(), "mb-"));
  const script = join(root, "agent.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const { config: configA, key } = makeConfig(root, { runDir, socketDir: dirA, claudeScript: script });
  const configB: Config = { ...configA, socketDir: dirB };
  const configNone: Config = { ...configA };
  delete configNone.socketDir;
  let channelA: HeadlessPermissionChannel | undefined;
  let channelB: HeadlessPermissionChannel | undefined;
  let channelNone: HeadlessPermissionChannel | undefined;
  try {
    const managerA = new Manager(configA, key);
    channelA = new HeadlessPermissionChannel({
      key,
      target: managerA.socketTarget,
      legacySockets: () => managerA.activePermissionSockets(),
      sessions: managerA,
      services: { pipeline: allowPipeline() },
    });
    managerA.useHeadlessChannel(channelA);
    await channelA.listen();

    const id = randomUUID();
    const created = await managerA.create({ requestId: id, provider: "claude", projectId: "fixture", title: "Migrating headless", prompt: "Run check" });
    assert.equal(created.status, "running");
    assert.equal(existsSync(socketPath(managerA.socketTarget, id)), true);
    const originalPermPath = channelA.primarySocketPath();
    assert.ok(originalPermPath.startsWith(dirA));
    channelA.close();
    channelA = undefined;

    const managerB = new Manager(configB, key);
    assert.equal(existsSync(socketPath(managerB.socketTarget, id)), false);
    assert.equal((await managerB.state(id)).status, "running");
    assert.equal((await managerB.list()).find(row => row.id === id)?.status, "running");
    assert.ok(managerB.activePermissionSockets().includes(originalPermPath));

    channelB = new HeadlessPermissionChannel({
      key,
      target: managerB.socketTarget,
      legacySockets: () => managerB.activePermissionSockets(),
      sessions: managerB,
      services: { pipeline: allowPipeline() },
    });
    await channelB.listen();
    const permRequest = {
      v: 1 as const,
      op: "decide" as const,
      requestId: `headless:${id}:tool-1`,
      sessionId: id,
      token: channelToken(key, id),
      call: { toolName: "Bash", toolInput: { command: "echo ok" } },
    };
    assert.equal((await channelCall(originalPermPath, permRequest, 4000)).result, "allow");
    assert.equal((await channelCall(channelB.primarySocketPath(), permRequest, 4000)).result, "allow");
    assert.equal((await channelCall(channelSocketPath(runDir), permRequest, 4000)).result, "allow");
    channelB.close();
    channelB = undefined;

    const managerNone = new Manager(configNone, key);
    assert.equal((await managerNone.state(id)).status, "running");
    assert.equal((await managerNone.list()).find(row => row.id === id)?.status, "running");
    channelNone = new HeadlessPermissionChannel({
      key,
      target: managerNone.socketTarget,
      legacySockets: () => managerNone.activePermissionSockets(),
      sessions: managerNone,
      services: { pipeline: allowPipeline() },
    });
    await channelNone.listen();
    assert.equal((await channelCall(originalPermPath, permRequest, 4000)).result, "allow");
    assert.equal((await channelCall(channelSocketPath(runDir), permRequest, 4000)).result, "allow");

    await endSessionWorkers(configNone);
    await waitFor(async () => existsSync(socketPath(managerA.socketTarget, id)), present => !present, 10_000);
  } finally {
    await endSessionWorkers(configNone).catch(() => {});
    await endSessionWorkers(configA).catch(() => {});
    channelA?.close();
    channelB?.close();
    channelNone?.close();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("seeded socket-root simulator verifies migration, overlap isolation, and catches broken mutants", async () => {
  type Mutant = "none" | "unnamespaced-permission-channel" | "ignore-recorded-socket-on-migration" | "allow-nonsticky-writable-parent";

  function lcg(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  async function simulate(seed: number, mutant: Mutant) {
    const rand = lcg(seed);
    const root = mkdtempSync(join(tmpdir(), `sm-${seed}-`));
    const runDirA = join(root, "rA");
    const runDirB = join(root, "rB");
    const dirA = join(root, "dA");
    const dirB = join(root, "dB");
    const unsafeParent = join(root, "up");
    const unsafeChild = join(unsafeParent, "s");
    for (const dir of [runDirA, runDirB, dirA, dirB]) mkdirSync(dir, { mode: 0o700 });
    mkdirSync(unsafeParent, { mode: 0o700 });
    chmodSync(unsafeParent, 0o777);
    mkdirSync(unsafeChild, { mode: 0o700 });

    const coverage = {
      migrations: 0,
      sharedDirOverlap: 0,
      runDirOverlap: 0,
      cliAttachDetach: 0,
      untrustedParentRejected: 0,
    };
    const servers: Server[] = [];

    try {
      const modes: Array<string | undefined> = [undefined, dirA, dirB, undefined];
      const hostA: { socketDir?: string; live: Map<string, { workerSocket: string; permSocket: string }> } = {
        socketDir: undefined,
        live: new Map(),
      };

      const permFor = (runDir: string, socketDir?: string) => {
        if (mutant === "unnamespaced-permission-channel") return join(socketDir ?? runDir, "permission-channel.sock");
        return permissionChannelPath({ runDir, ...(socketDir ? { socketDir } : {}) });
      };

      for (let step = 0; step < 32; step++) {
        const pick = step < 8 ? step % 5 : Math.floor(rand() * 5);
        if (pick === 0 || step < modes.length) {
          const next = step < modes.length ? modes[step] : modes[Math.floor(rand() * modes.length)];
          const prev = hostA.socketDir;
          hostA.socketDir = next;
          if (prev !== next) coverage.migrations++;
          const id = randomUUID();
          const target = { runDir: runDirA, ...(next ? { socketDir: next } : {}) };
          const workerSock = socketPath(target, id);
          const permSock = permFor(runDirA, next);
          assert.ok(Buffer.byteLength(workerSock) <= MAX_SOCKET_PATH_BYTES);
          assert.ok(Buffer.byteLength(permSock) <= MAX_SOCKET_PATH_BYTES);
          if (hostA.live.size < 6) {
            servers.push(await listenFakeWorker(workerSock, 7000 + step));
            hostA.live.set(id, { workerSocket: workerSock, permSocket: permSock });
          }

          const cache = new Map<string, boolean>();
          for (const [liveId, rec] of hostA.live) {
            const recorded = mutant === "ignore-recorded-socket-on-migration" ? undefined : rec.workerSocket;
            const resolved = existingWorkerSocket(target, liveId, recorded, cache);
            assert.equal(resolved, rec.workerSocket, `lost surviving worker ${liveId} after migration to ${next ?? "runDir"}`);
          }
        } else if (pick === 1) {
          const sharedId = randomUUID();
          const sockA = socketPath({ runDir: runDirA, socketDir: dirA }, sharedId);
          const sockB = socketPath({ runDir: runDirB, socketDir: dirA }, sharedId);
          assert.notEqual(sockA, sockB, "two hosts sharing socketDir must not collide on worker sockets");
          assert.notEqual(permFor(runDirA, dirA), permFor(runDirB, dirA), "two hosts sharing socketDir must not collide on permission channels");
          coverage.sharedDirOverlap++;
        } else if (pick === 2) {
          assert.notEqual(permFor(runDirA, runDirB), permFor(runDirB, undefined), "socketDirA === runDirB must not collide on permission channels");
          coverage.runDirOverlap++;
        } else if (pick === 3) {
          const readerTarget = { runDir: runDirA, ...(hostA.socketDir ? { socketDir: hostA.socketDir } : {}) };
          assert.equal(ensureSocketDir(hostA.socketDir ?? runDirA), hostA.socketDir ?? runDirA);
          for (const [liveId, rec] of hostA.live) {
            const resolved = existingWorkerSocket(readerTarget, liveId, rec.workerSocket);
            assert.equal(resolved, rec.workerSocket);
          }
          coverage.cliAttachDetach++;
        } else {
          let rejected = false;
          if (mutant !== "allow-nonsticky-writable-parent") {
            try { ensureSocketDir(unsafeChild, "socketDir"); } catch { rejected = true; }
          }
          assert.equal(rejected, true, "non-sticky writable parent must be rejected");
          coverage.untrustedParentRejected++;
        }
      }
      return coverage;
    } finally {
      for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }

  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const cov = await simulate(seed, "none");
    assert.ok(cov.migrations > 0, `seed ${seed}: migrations`);
    assert.ok(cov.sharedDirOverlap > 0, `seed ${seed}: sharedDirOverlap`);
    assert.ok(cov.runDirOverlap > 0, `seed ${seed}: runDirOverlap`);
    assert.ok(cov.cliAttachDetach > 0, `seed ${seed}: cliAttachDetach`);
    assert.ok(cov.untrustedParentRejected > 0, `seed ${seed}: untrustedParentRejected`);
  }

  for (const mutant of ["unnamespaced-permission-channel", "ignore-recorded-socket-on-migration", "allow-nonsticky-writable-parent"] as const) {
    await assert.rejects(() => simulate(1, mutant), `simulator must catch mutant ${mutant}`);
  }
});

test("readConfig validates socketDir as an absolute protected host path", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-cfg-sock-")));
  const customSocketDir = join(root, "sock");
  mkdirSync(customSocketDir, { mode: 0o700 });
  try {
    const { config } = makeConfig(root, { runDir: join(root, "run"), socketDir: customSocketDir });
    const configFile = join(root, "config.json");
    writeFileSync(configFile, JSON.stringify(config));
    assert.equal(readConfig(configFile).config.socketDir, customSocketDir);

    const secretInsideSocketDir = join(customSocketDir, "secret.key");
    writeFileSync(secretInsideSocketDir, "secret", { mode: 0o600 });
    assert.throws(() => assertPrivateCredentialFile(config, secretInsideSocketDir, "credential blocked"), /credential blocked/);

    const relativeConfigFile = join(root, "relative-config.json");
    writeFileSync(relativeConfigFile, JSON.stringify({ ...config, socketDir: "relative/sock" }));
    assert.throws(() => readConfig(relativeConfigFile), /Configuration paths must be absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
