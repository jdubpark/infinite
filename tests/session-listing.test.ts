import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net, { createServer, type Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initialAttention } from "@infinite/attention";
import { Manager, publicAttention, withDefaultAttention } from "../packages/host/src/manager.js";
import { socketPath } from "../packages/host/src/ipc.js";
import { writeSealed } from "../packages/host/src/vault.js";
import type { Config, Session, WorkerState } from "../packages/host/src/types.js";

const ID = () => randomUUID();
const SETTLED_AGO_MS = 10_000;

/** A root with a relative path: a Unix socket path must stay under 100 bytes for the Manager. */
async function fixture() {
  mkdirSync(".local", { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(".local", "sl-"));
  const stateDir = join(root, "state"), runDir = join(root, "r");
  mkdirSync(runDir, { recursive: true });
  const key = Buffer.alloc(32, 7);
  const config = { stateDir, runDir, enableDemo: true, agents: {} } as Config;
  return { root, stateDir, runDir, key, config, close: () => rmSync(root, { recursive: true, force: true }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function sessionOf(id: string, extra: Partial<Session> = {}): Session {
  return {
    id, provider: "demo", title: `Title ${id.slice(0, 4)}`, projectId: "api", cwd: "/work",
    createdAt: "2026-11-14T00:00:00.000Z", status: "exited", contextVersion: 0, context: "", initialPrompt: "Say hello",
    ...extra,
  } as Session;
}

const now = () => new Date().toISOString();
const exitedState = (seq: number, extra: Record<string, unknown> = {}) =>
  ({ status: "exited", seq, screen: "", attention: initialAttention(now(), false), ...extra });

const recordDir = (f: Fixture, id: string) => join(f.stateDir, "sessions", id);
/** Sets a file 10 s into the past, so a read of it is settled. */
function settle(file: string) {
  const past = new Date(Date.now() - SETTLED_AGO_MS);
  utimesSync(file, past, past);
}
function writeMeta(f: Fixture, id: string, session: Session) {
  mkdirSync(recordDir(f, id), { recursive: true });
  const file = join(recordDir(f, id), "meta.sealed");
  writeSealed(file, f.key, `${id}:meta`, { session, fingerprint: "fixture" });
  settle(file);
}
function writeStatus(f: Fixture, id: string, state: unknown, settled = true) {
  mkdirSync(recordDir(f, id), { recursive: true });
  const file = join(recordDir(f, id), "status.sealed");
  writeSealed(file, f.key, `${id}:status`, state);
  if (settled) settle(file);
  return file;
}

/** A worker that answers `state` on the session's socket, as the worker does. */
function fakeWorker(runDir: string, id: string, state: unknown) {
  const server: Server = createServer(socket => {
    socket.on("error", () => {});
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk;
      if (buffered.includes("\n")) socket.end(`${JSON.stringify({ result: state })}\n`);
    });
  });
  return new Promise<{ close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath(runDir, id), () =>
      resolve({
        close: () => new Promise<void>(done => server.close(() => { rmSync(socketPath(runDir, id), { force: true }); done(); })),
      }),
    );
  });
}

/** Today's list() body, rebuilt from meta() and state(). */
async function oracle(manager: Manager, options: { includeFullMessage?: boolean } = {}) {
  const ids = readdirSync(join(manager.config.stateDir, "sessions")).filter(
    n => /^[a-f0-9-]{36}$/.test(n) && !existsSync(join(manager.config.stateDir, "deleted-sessions", `${n}.sealed`)),
  );
  const rows = await Promise.allSettled(ids.map(async id => {
    const { session } = manager.meta(id);
    const { screen: _screen, ...state } = await manager.state(id).catch(() =>
      withDefaultAttention({ status: "unavailable", seq: 0, screen: "" }));
    const { context: _context, initialPrompt: _prompt, generatedTitle: _generatedTitle, nativeArgs: _nativeArgs, handoff: _handoff, ...summary } = session;
    return { ...summary, ...state, attention: options.includeFullMessage ? state.attention : publicAttention(state.attention) };
  }));
  return rows.flatMap(row => (row.status === "fulfilled" ? [row.value] : []));
}

function assertRows(actual: unknown[], expected: unknown[], message?: string) {
  assert.deepStrictEqual(actual, expected, message);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${message ?? "rows"}: key order`);
}

/** Counts sealed-file reads and socket connects until restore(). */
function spy() {
  const reads: string[] = [], connects: string[] = [];
  const realRead = fs.readFileSync, realConnect = net.createConnection;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const path = String(file);
    if (/\/(meta|status)\.sealed$/.test(path)) reads.push(path);
    return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  net.createConnection = ((...args: unknown[]) => {
    connects.push(String(args[0]));
    return (realConnect as (...args: unknown[]) => unknown)(...args);
  }) as typeof net.createConnection;
  syncBuiltinESMExports();
  return {
    reads, connects,
    restore() {
      fs.readFileSync = realRead;
      net.createConnection = realConnect;
      syncBuiltinESMExports();
    },
  };
}

test("listing rows equal the rows built from meta and state, cold, warm, and after a restart", { timeout: 30_000 }, async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const workers: { close: () => Promise<void> }[] = [];
  try {
    const E = ID(), U1 = ID(), U2 = ID(), L = ID(), S = ID(), X = ID(), N = ID(), D = ID();
    writeMeta(f, E, sessionOf(E, { contextSources: [], runtime: { id: "rt-e", location: "local", transport: "pty" } } as Partial<Session>));
    writeStatus(f, E, exitedState(3, { exitCode: 0, capabilities: { transcript: 1 }, attention: { ...initialAttention(now(), false), lastMessage: "m".repeat(400) } }));
    writeMeta(f, U1, sessionOf(U1, { status: "running" }));
    writeStatus(f, U1, { status: "running", seq: 2, screen: "", attention: initialAttention(now(), false) });
    writeMeta(f, U2, sessionOf(U2, { status: "running" }));
    writeMeta(f, L, sessionOf(L, { status: "running" }));
    writeMeta(f, S, sessionOf(S, { status: "running" }));
    writeStatus(f, S, { status: "x", seq: 1, screen: "", attention: initialAttention(now(), false) });
    mkdirSync(recordDir(f, X), { recursive: true });
    writeFileSync(join(recordDir(f, X), "meta.sealed"), "x");
    mkdirSync(recordDir(f, N), { recursive: true });
    writeMeta(f, D, sessionOf(D));
    mkdirSync(join(f.stateDir, "deleted-sessions"), { recursive: true });
    writeSealed(join(f.stateDir, "deleted-sessions", `${D}.sealed`), f.key, `deleted:${D}`, { id: D, fingerprint: "fixture" });
    workers.push(await fakeWorker(f.runDir, L, {
      status: "running", seq: 5, screen: "", capabilities: { transcript: 1 },
      attention: { ...initialAttention(now(), false), state: "needs-you", prompt: { id: 1, kind: "permission", title: "Run a command", options: [{ index: 1, label: "Yes", role: "accept" }], acceptsText: false, tool: { name: "Bash", input: { command: "ls" } } } },
    }));

    const manager = new Manager(f.config, f.key);
    const expectedIds = [E, U1, U2, L, S].sort();
    const cold = await manager.list();
    assert.deepEqual(cold.map(row => row.id).sort(), expectedIds);
    assertRows(cold, await oracle(manager), "cold");
    assertRows(await manager.list(), await oracle(manager), "warm");
    assertRows(await manager.list({ includeFullMessage: true }), await oracle(manager, { includeFullMessage: true }), "warm, full message");

    mock.timers.setTime(Date.now() + 60_000);
    const later = await manager.list();
    assertRows(later, await oracle(manager), "after the clock moves on");
    const exitedAt = (rows: typeof later) => rows.find(row => row.id === E)!.attention.lastActivityAt;
    assert.notEqual(exitedAt(later), exitedAt(cold), "the exited row's lastActivityAt is the call time");

    const restarted = new Manager(f.config, f.key);
    assertRows(await restarted.list(), await oracle(restarted), "after a restart");
  } finally {
    mock.timers.reset();
    for (const worker of workers) await worker.close();
    f.close();
  }
});

test("every change shows in the next listing", { timeout: 30_000 }, async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const workers: { close: () => Promise<void> }[] = [];
  try {
    const E = ID(), E2 = ID(), E3 = ID(), U1 = ID(), U2 = ID(), W = ID();
    writeMeta(f, E, sessionOf(E));
    writeStatus(f, E, exitedState(1));
    writeMeta(f, U1, sessionOf(U1, { status: "running" }));
    writeStatus(f, U1, { status: "running", seq: 1, screen: "", attention: initialAttention(now(), false) });
    writeMeta(f, U2, sessionOf(U2, { status: "running" }));
    writeMeta(f, W, sessionOf(W));
    writeStatus(f, W, exitedState(1));
    const manager = new Manager(f.config, f.key);
    assertRows(await manager.list(), await oracle(manager), "warm before the changes");
    assertRows(await manager.list(), await oracle(manager), "warm");

    await manager.setArchived(E, true);
    const archived = await manager.list();
    assertRows(archived, await oracle(manager), "after archive");
    assert.ok(archived.find(row => row.id === E)!.archivedAt, "archivedAt shows");

    writeMeta(f, E2, sessionOf(E2, { title: "Title A" }));
    writeStatus(f, E2, exitedState(1));
    writeMeta(f, E3, sessionOf(E3));
    writeStatus(f, E3, exitedState(1));
    assertRows(await manager.list(), await oracle(manager), "after two more records");

    const e2File = join(recordDir(f, E2), "meta.sealed");
    const { mtime } = statSync(e2File);
    writeSealed(e2File, f.key, `${E2}:meta`, { session: sessionOf(E2, { title: "Title B" }), fingerprint: "fixture" });
    utimesSync(e2File, mtime, mtime);
    const rewritten = await manager.list();
    assertRows(rewritten, await oracle(manager), "after a same-size rewrite with the old mtime");
    assert.equal(rewritten.find(row => row.id === E2)!.title, "Title B");

    await manager.remove(E3);
    assertRows(await manager.list(), await oracle(manager), "after remove");

    rmSync(recordDir(f, U1), { recursive: true });
    assertRows(await manager.list(), await oracle(manager), "after a folder is removed");

    writeStatus(f, U2, exitedState(1));
    const firstStatus = await manager.list();
    assertRows(firstStatus, await oracle(manager), "after a first status.sealed");
    assert.equal(firstStatus.find(row => row.id === U2)!.status, "exited");

    workers.push(await fakeWorker(f.runDir, W, { status: "running", seq: 9, screen: "", attention: initialAttention(now(), false) }));
    const live = await manager.list();
    assertRows(live, await oracle(manager), "with a worker on the socket");
    assert.equal(live.find(row => row.id === W)!.status, "running", "the worker answers");

    await workers.pop()!.close();
    const spied = spy();
    try {
      const closed = await manager.list();
      assert.deepEqual(spied.reads.filter(path => path.includes(W)), [], "the saved state comes with no sealed read");
      assert.equal(closed.find(row => row.id === W)!.status, "exited");
    } finally {
      spied.restore();
    }
    assertRows(await manager.list(), await oracle(manager), "after the worker closed");
  } finally {
    mock.timers.reset();
    for (const worker of workers) await worker.close();
    f.close();
  }
});

test("a second listing of exited records reads no sealed file and connects to no worker", { timeout: 60_000 }, async t => {
  const f = await fixture();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const frozen = Date.now();
  const spied = spy();
  try {
    const ids = Array.from({ length: 200 }, () => ID());
    for (const id of ids) {
      writeMeta(f, id, sessionOf(id));
      writeStatus(f, id, exitedState(1));
    }
    const manager = new Manager(f.config, f.key);

    let started = performance.now();
    await manager.list();
    const coldMs = performance.now() - started;
    assert.equal(spied.reads.length, 400, "cold: meta and status of each record");
    assert.equal(spied.connects.length, 0, "cold: no socket file, no connect");
    spied.reads.length = 0;

    started = performance.now();
    const warm = await manager.list();
    const warmMs = performance.now() - started;
    assert.equal(warm.length, 200);
    assert.equal(spied.reads.length, 0, "warm: no sealed read");
    assert.equal(spied.connects.length, 0, "warm: no connect");
    t.diagnostic(`200 exited records: cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms`);

    const socketFile = socketPath(f.runDir, ids[0]);
    writeFileSync(socketFile, "");
    await manager.list();
    assert.equal(spied.connects.length, 1, "a socket file is connected");
    assert.equal(spied.reads.length, 0, "a failed connect reads no sealed file");
    rmSync(socketFile);
    spied.connects.length = 0;

    const freshFile = writeStatus(f, ids[1], exitedState(2), false);
    await manager.list();
    assert.equal(spied.reads.filter(path => path === freshFile).length, 1, "a fresh status is read");
    spied.reads.length = 0;
    await manager.list();
    assert.equal(spied.reads.filter(path => path === freshFile).length, 1, "a fresh status is not kept");
    spied.reads.length = 0;

    settle(freshFile);
    await manager.list();
    assert.equal(spied.reads.filter(path => path === freshFile).length, 1, "a changed file is read once");
    spied.reads.length = 0;
    await manager.list();
    assert.equal(spied.reads.length, 0, "a settled file is kept");

    mock.timers.setTime(frozen - 60_000);
    spied.reads.length = 0;
    await manager.list();
    assert.equal(spied.reads.length, 400, "a clock that stepped back reads every record again");
  } finally {
    spied.restore();
    mock.timers.reset();
    f.close();
  }
});

test("a caller that changes its rows changes no later listing", { timeout: 30_000 }, async () => {
  const f = await fixture();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const E = ID();
    writeMeta(f, E, sessionOf(E, { contextSources: [], runtime: { id: "rt-e", location: "local", transport: "pty" } } as Partial<Session>));
    writeStatus(f, E, exitedState(3, { capabilities: { transcript: 1 }, attention: { ...initialAttention(now(), false), lastMessage: "kept" } }));
    const manager = new Manager(f.config, f.key);

    const first = await manager.list();
    const row = first.find(item => item.id === E)! as Record<string, any>;
    row.title = "changed";
    row.attention.lastMessage = "changed";
    row.runtime.id = "changed";
    (row.contextSources as unknown[]).push("changed");
    row.capabilities.transcript = 9;

    const second = await manager.list();
    assertRows(second, await oracle(manager), "after the caller changed its rows");
    assert.notEqual(second.find(item => item.id === E)!.title, "changed");
  } finally {
    mock.timers.reset();
    f.close();
  }
});
