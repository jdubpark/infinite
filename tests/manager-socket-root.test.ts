import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  legacySocketPath,
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

function makeConfig(root: string, options: { runDir: string; socketDir?: string; script?: string }): { config: Config; key: Buffer } {
  const projectDir = join(root, "project");
  const stateDir = join(root, "state");
  const keyFile = join(root, "key");
  const key = randomBytes(32);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(keyFile, key, { mode: 0o600 });
  const agents = options.script ? { demo: { command: process.execPath, args: [options.script] } } : {};
  const config: Config = {
    port: 0,
    origin: "http://127.0.0.1:4780",
    keyFile,
    stateDir,
    runDir: options.runDir,
    ...(options.socketDir !== undefined ? { socketDir: options.socketDir } : {}),
    environment: "local",
    enableDemo: true,
    maxSessions: 4,
    tokens: [{ id: "owner", label: "Owner", role: "owner", hash: hashToken("token-value") }],
    projects: [{ id: "fixture", name: "Fixture", path: projectDir }],
    agents,
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

test("Manager supports custom socketDir with strict 0700 enforcement and cleans up sockets on exit", { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-sock-root-")));
  const longRunDir = join(root, "nested-long-runtime-directory-name-exceeding-unix-socket-limit", "run");
  const shortSocketDir = mkdtempSync(join(tmpdir(), "is-"));
  const optionSocketDir = mkdtempSync(join(tmpdir(), "io-"));
  const script = join(root, "agent.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  chmodSync(shortSocketDir, 0o755);
  let activeConfig: Config | undefined;
  let manager: Manager | undefined;
  let overrideManager: Manager | undefined;
  try {
    const withoutSocketDir = makeConfig(root, { runDir: longRunDir, script });
    assert.throws(() => new Manager(withoutSocketDir.config, withoutSocketDir.key), /runDir is too long for a Unix socket/);
    assert.equal(existsSync(longRunDir), false);

    const { config, key } = makeConfig(root, { runDir: longRunDir, socketDir: shortSocketDir, script });
    activeConfig = config;
    manager = new Manager(config, key);
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

    overrideManager = new Manager(withoutSocketDir.config, withoutSocketDir.key, undefined, { socketDir: optionSocketDir });
    assert.equal(overrideManager.socketDir, optionSocketDir);
    assert.equal(statSync(optionSocketDir).mode & 0o777, 0o700);
  } finally {
    if (activeConfig) await endSessionWorkers(activeConfig).catch(() => {});
    manager?.close();
    overrideManager?.close();
    rmSync(shortSocketDir, { recursive: true, force: true });
    rmSync(optionSocketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureSocketDir rejects overly long paths, symlinks, trailing-slash symlinks, relative segments, and shared roots", () => {
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
  let manager: Manager | undefined;
  try {
    const id = randomUUID();
    assert.ok(Buffer.byteLength(legacySocketPath(runDir, id)) > MAX_SOCKET_PATH_BYTES);
    assert.ok(Buffer.byteLength(socketPath(runDir, id)) <= MAX_SOCKET_PATH_BYTES);

    const { config, key } = makeConfig(root, { runDir, script });
    activeConfig = config;
    manager = new Manager(config, key);
    const created = await manager.create({ requestId: id, provider: "demo", projectId: "fixture", title: "Long tmpdir", prompt: "" });
    assert.equal(created.status, "running");
    assert.equal((await manager.state(id)).status, "running");
    await endSessionWorkers(config);
    await waitFor(async () => existsSync(socketPath(runDir, id)), present => !present, 10_000);
  } finally {
    if (activeConfig) await endSessionWorkers(activeConfig).catch(() => {});
    manager?.close();
    rmSync(outer, { recursive: true, force: true });
  }
});

test("Manager and workerCall remain compatible with legacy runDir UUID sockets", async () => {
  mkdirSync(".local", { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(".local", "lg-"));
  const runDir = join(root, "r");
  const customSocketDir = mkdtempSync(join(tmpdir(), "il-"));
  const { config, key } = makeConfig(root, { runDir, socketDir: customSocketDir });
  const id = randomUUID();
  const legacyFile = legacySocketPath(runDir, id);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  writeFakeMeta(config, key, id);
  const server = await listenFakeWorker(legacyFile, 4242);
  let manager: Manager | undefined;
  try {
    manager = new Manager(config, key);
    assert.equal(existsSync(socketPath(config, id)), false);
    assert.equal(existsSync(legacyFile), true);
    const state = await manager.state(id);
    assert.equal(state.status, "running");
    assert.equal(state.pid, 4242);
    const listed = await manager.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.pid, 4242);
    const direct = await workerCall<{ pid: number }>(manager.socketTarget, id, { op: "state" });
    assert.equal(direct.pid, 4242);
  } finally {
    manager?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(customSocketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("existingWorkerSocket rejects fallback sockets in symlinked or untrusted runDir and symlinked fallback sockets", async () => {
  mkdirSync(".local", { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(".local", "ut-"));
  const socketDir = mkdtempSync(join(tmpdir(), "iu-"));
  const realDir = join(root, "real");
  const linkRunDir = join(root, "link");
  const permRunDir = join(root, "wide");
  const trustedRunDir = join(root, "priv");
  const externalDir = join(root, "ext");
  mkdirSync(realDir, { mode: 0o700 });
  symlinkSync(realDir, linkRunDir);
  mkdirSync(permRunDir, { mode: 0o755 });
  chmodSync(permRunDir, 0o755);
  mkdirSync(trustedRunDir, { mode: 0o700 });
  mkdirSync(externalDir, { mode: 0o700 });
  const idA = randomUUID(), idB = randomUUID(), idC = randomUUID();
  const servers: Server[] = [];
  try {
    servers.push(await listenFakeWorker(legacySocketPath(realDir, idA), 5001));
    assert.equal(existingWorkerSocket({ runDir: linkRunDir, socketDir }, idA), undefined);
    await assert.rejects(workerCall({ runDir: linkRunDir, socketDir }, idA, { op: "state" }), /Worker unavailable/);

    servers.push(await listenFakeWorker(legacySocketPath(permRunDir, idB), 5002));
    assert.equal(existingWorkerSocket({ runDir: permRunDir, socketDir }, idB), undefined);
    await assert.rejects(workerCall({ runDir: permRunDir, socketDir }, idB, { op: "state" }), /Worker unavailable/);

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

test("restarting Manager with socketDir enabled reconnects workers started in runDir", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "im-"));
  const runDir = join(root, "run");
  const newSocketDir = mkdtempSync(join(tmpdir(), "in-"));
  const script = join(root, "agent.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const { config: beforeConfig, key } = makeConfig(root, { runDir, script });
  const afterConfig: Config = { ...beforeConfig, socketDir: newSocketDir };
  let beforeManager: Manager | undefined;
  let afterManager: Manager | undefined;
  try {
    beforeManager = new Manager(beforeConfig, key);
    const id = randomUUID();
    const created = await beforeManager.create({ requestId: id, provider: "demo", projectId: "fixture", title: "Upgrade worker", prompt: "" });
    assert.equal(created.status, "running");
    assert.equal(existsSync(socketPath(runDir, id)), true);
    beforeManager.close();
    beforeManager = undefined;

    afterManager = new Manager(afterConfig, key);
    assert.equal(existsSync(socketPath(newSocketDir, id)), false);
    assert.equal((await afterManager.state(id)).status, "running");
    assert.equal((await afterManager.list()).find(row => row.id === id)?.status, "running");

    await endSessionWorkers(afterConfig);
    await waitFor(async () => existsSync(socketPath(runDir, id)), present => !present, 10_000);
  } finally {
    await endSessionWorkers(afterConfig).catch(() => {});
    await endSessionWorkers(beforeConfig).catch(() => {});
    beforeManager?.close();
    afterManager?.close();
    rmSync(newSocketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("two hosts with distinct runDirs cannot claim the same socketDir or clobber permission-channel.sock", { timeout: 30_000 }, async () => {
  const rootA = mkdtempSync(join(tmpdir(), "ha-"));
  const rootB = mkdtempSync(join(tmpdir(), "hb-"));
  const sharedSocketDir = mkdtempSync(join(tmpdir(), "hs-"));
  const { config: configA, key: keyA } = makeConfig(rootA, { runDir: join(rootA, "run"), socketDir: sharedSocketDir });
  const { config: configB, key: keyB } = makeConfig(rootB, { runDir: join(rootB, "run"), socketDir: sharedSocketDir });
  let appA: ReturnType<typeof createApp> | undefined;
  let managerB: Manager | undefined;
  try {
    appA = createApp(configA, keyA);
    await new Promise<void>(resolve => appA!.server.listen(0, "127.0.0.1", resolve));
    const channelPath = channelSocketPath(sharedSocketDir);
    await waitFor(async () => existsSync(channelPath), present => present, 5_000);
    const originalIno = statSync(channelPath).ino;

    assert.throws(() => createApp(configB, keyB), /Another host owns this socket directory/);
    assert.throws(() => new Manager(configB, keyB), /Another host owns this socket directory/);
    assert.equal(existsSync(channelPath), true);
    assert.equal(statSync(channelPath).ino, originalIno);

    const closing = appA.closeConnections();
    await new Promise<void>(resolve => appA!.server.close(() => resolve()));
    await closing;
    await appA.missions.idle();
    await appA.teams.idle();
    appA = undefined;

    managerB = new Manager(configB, keyB);
    assert.equal(managerB.socketDir, sharedSocketDir);
    managerB.close();
    managerB = undefined;

    const liveChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      assert.ok(liveChild.pid && liveChild.pid > 0);
      writeFileSync(join(sharedSocketDir, "host.lock"), JSON.stringify({ pid: liveChild.pid, runDir: join(rootA, "run"), token: randomUUID() }), { mode: 0o600 });
      assert.throws(() => new Manager(configB, keyB), /Another host owns this socket directory/);
    } finally {
      liveChild.kill("SIGKILL");
      await new Promise<void>(resolve => liveChild.once("exit", () => resolve()));
    }
    managerB = new Manager(configB, keyB);
    assert.equal(managerB.socketDir, sharedSocketDir);
    managerB.close();
    managerB = undefined;

    const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.ok(deadChild.pid && deadChild.pid > 0);
    writeFileSync(join(sharedSocketDir, "host.lock"), JSON.stringify({ pid: deadChild.pid, runDir: join(rootA, "run"), token: randomUUID() }), { mode: 0o600 });
    managerB = new Manager(configB, keyB);
    assert.equal(managerB.socketDir, sharedSocketDir);
  } finally {
    managerB?.close();
    if (appA) {
      const closing = appA.closeConnections();
      await new Promise<void>(resolve => appA!.server.close(() => resolve()));
      await closing;
      await appA.missions.idle();
      await appA.teams.idle();
    }
    rmSync(sharedSocketDir, { recursive: true, force: true });
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("HeadlessPermissionChannel serves both socketDir and legacy runDir permission-channel.sock during migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "hp-"));
  const runDir = join(root, "run");
  const socketDir = mkdtempSync(join(tmpdir(), "hc-"));
  mkdirSync(runDir, { mode: 0o700 });
  const { config, key } = makeConfig(root, { runDir, socketDir });
  const id = randomUUID();
  const session: Session = {
    id,
    provider: "claude",
    title: "Legacy headless",
    projectId: "fixture",
    cwd: config.projects[0]!.path,
    createdAt: "2026-11-26T00:00:00.000Z",
    status: "running",
    contextVersion: 0,
    context: "",
    initialPrompt: "Run check",
    headless: { channel: true },
  };
  const pipeline: PermissionPipeline = {
    serves: () => ({ served: true }),
    classOf: () => undefined,
    decide: async () => ({ kind: "allow", decisionId: randomUUID(), strongTier: false }),
    applicable: () => true,
    recordDelivery: () => {},
    taskEnded: () => {},
  };
  const channel = new HeadlessPermissionChannel({
    key,
    runDir: socketDir,
    legacyRunDir: runDir,
    sessions: { meta: () => ({ session }), list: async () => [] },
    services: { pipeline },
  });
  await channel.listen();
  try {
    const request = {
      v: 1 as const,
      op: "class" as const,
      sessionId: id,
      token: channelToken(key, id),
      call: { toolName: "Bash", toolInput: { command: "echo ok" } },
    };
    const primaryReply = await channelCall(channelSocketPath(socketDir), request, 4000);
    assert.equal(primaryReply.result, "none");
    const legacyReply = await channelCall(channelSocketPath(runDir), request, 4000);
    assert.equal(legacyReply.result, "none");
    const legacyDecide = await channelCall(channelSocketPath(runDir), { ...request, op: "decide", requestId: `headless:${id}:tool-1` }, 4000);
    assert.equal(legacyDecide.result, "allow");
  } finally {
    channel.close();
    rmSync(socketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
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
