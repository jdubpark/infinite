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
  legacySocketPath,
  socketPath,
  workerCall,
} from "../packages/host/src/ipc.js";
import { Manager } from "../packages/host/src/manager.js";
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

test("Manager supports custom socketDir with strict 0700 enforcement and cleans up sockets on exit", { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-sock-root-")));
  const longRunDir = join(root, "nested-long-runtime-directory-name-exceeding-unix-socket-limit", "run");
  const shortSocketDir = mkdtempSync(join(tmpdir(), "is-"));
  const optionSocketDir = mkdtempSync(join(tmpdir(), "io-"));
  const script = join(root, "agent.mjs");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  chmodSync(shortSocketDir, 0o755);
  try {
    const withoutSocketDir = makeConfig(root, { runDir: longRunDir, script });
    assert.throws(() => new Manager(withoutSocketDir.config, withoutSocketDir.key), /runDir is too long for a Unix socket/);
    assert.equal(existsSync(longRunDir), false);

    const { config, key } = makeConfig(root, { runDir: longRunDir, socketDir: shortSocketDir, script });
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
    rmSync(shortSocketDir, { recursive: true, force: true });
    rmSync(optionSocketDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureSocketDir rejects overly long paths, symlinks, and shared roots", () => {
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

    const brokenLink = join(root, "broken");
    symlinkSync(join(root, "missing"), brokenLink);
    assert.throws(() => ensureSocketDir(brokenLink, "socketDir"), /symlink/);

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
  try {
    const id = randomUUID();
    assert.ok(Buffer.byteLength(legacySocketPath(runDir, id)) > MAX_SOCKET_PATH_BYTES);
    assert.ok(Buffer.byteLength(socketPath(runDir, id)) <= MAX_SOCKET_PATH_BYTES);

    const { config, key } = makeConfig(root, { runDir, script });
    const manager = new Manager(config, key);
    const created = await manager.create({ requestId: id, provider: "demo", projectId: "fixture", title: "Long tmpdir", prompt: "" });
    assert.equal(created.status, "running");
    assert.equal((await manager.state(id)).status, "running");
    await endSessionWorkers(config);
    await waitFor(async () => existsSync(socketPath(runDir, id)), present => !present, 10_000);
  } finally {
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
  mkdirSync(join(config.stateDir, "sessions", id), { recursive: true, mode: 0o700 });
  writeSealed(join(config.stateDir, "sessions", id, "meta.sealed"), key, `${id}:meta`, {
    session: {
      id,
      provider: "demo",
      title: "Legacy worker",
      projectId: "fixture",
      cwd: config.projects[0]!.path,
      createdAt: "2026-11-26T00:00:00.000Z",
      status: "running",
      contextVersion: 0,
      context: "",
      initialPrompt: "",
    } as Session,
    fingerprint: "legacy-fp",
  });
  const server: Server = createServer(socket => {
    socket.on("error", () => {});
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      if (!buffered.includes("\n")) return;
      socket.end(`${JSON.stringify({ result: { status: "running", pid: 4242, seq: 9, screen: "", attention: initialAttention("2026-11-26T00:00:00.000Z", false) } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(legacyFile, resolve);
  });
  try {
    const manager = new Manager(config, key);
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
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(customSocketDir, { recursive: true, force: true });
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
