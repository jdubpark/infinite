import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net, { createServer, type Server } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { initialAttention } from "@infinite/attention";
import { Manager, publicAttention, withDefaultAttention } from "../packages/host/src/manager.js";
import { socketPath, workerCall } from "../packages/host/src/ipc.js";
import { listedSavedState, unavailableState } from "../packages/host/src/session-listing.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import type { Config, Session, WorkerState } from "../packages/host/src/types.js";
import { inProcessHost } from "./helpers.js";

const ID = () => randomUUID();
const SETTLED_AGO_MS = 60_000;

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
/** Moves the mocked clock on, so every file written so far is settled: its newer time is old. */
function settle() {
  mock.timers.setTime(Date.now() + SETTLED_AGO_MS);
}
function writeMeta(f: Fixture, id: string, session: Session) {
  mkdirSync(recordDir(f, id), { recursive: true });
  writeSealed(join(recordDir(f, id), "meta.sealed"), f.key, `${id}:meta`, { session, fingerprint: "fixture" });
  settle();
}
function writeStatus(f: Fixture, id: string, state: unknown, settled = true) {
  mkdirSync(recordDir(f, id), { recursive: true });
  const file = join(recordDir(f, id), "status.sealed");
  writeSealed(file, f.key, `${id}:status`, state);
  if (settled) settle();
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

/**
 * The list() body, rebuilt without the caches from meta() and the worker's answer, else the saved status dated by its
 * file, else unavailable since the session's creation.
 */
async function oracle(manager: Manager, options: { includeFullMessage?: boolean } = {}) {
  const ids = readdirSync(join(manager.config.stateDir, "sessions")).filter(
    n => /^[a-f0-9-]{36}$/.test(n) && !existsSync(join(manager.config.stateDir, "deleted-sessions", `${n}.sealed`)),
  );
  const rows = await Promise.allSettled(ids.map(async id => {
    const { session } = manager.meta(id);
    const saved = () => {
      const file = join(manager.config.stateDir, "sessions", id, "status.sealed");
      if (!existsSync(file)) return unavailableState(session.createdAt);
      const state = unseal<WorkerState>(manager.key, `${id}:status`, fs.readFileSync(file, "utf8"));
      return listedSavedState({ state, savedAt: new Date(statSync(file).mtimeMs).toISOString() });
    };
    const { screen: _screen, ...state } = await workerCall<WorkerState>(manager.config.runDir, id, { op: "state", screen: false })
      .then(answer => withDefaultAttention(answer), saved)
      .catch(() => unavailableState(session.createdAt));
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
    const savedAttention = { ...initialAttention(now(), false), lastMessage: "m".repeat(400) };
    writeStatus(f, E, exitedState(3, { exitCode: 0, capabilities: { transcript: 1 }, attention: savedAttention }));
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
    // A row without a worker carries recorded times, never the time of the call: nothing changed, so nothing differs.
    assert.equal(JSON.stringify(later), JSON.stringify(cold), "a minute later the listing is byte-identical");
    const row = (id: string) => later.find(listed => listed.id === id)!.attention;
    assert.equal(row(E).lastActivityAt, savedAttention.lastActivityAt, "the exited row keeps its saved lastActivityAt");
    const savedAt = new Date(statSync(join(recordDir(f, U1), "status.sealed")).mtimeMs).toISOString();
    assert.deepEqual([row(U1).state, row(U1).since], ["unavailable", savedAt], "a worker gone without recording its exit is unavailable since its status was saved");
    assert.deepEqual([row(U2).state, row(U2).since], ["unavailable", "2026-11-14T00:00:00.000Z"], "without a saved status, since its creation");
    // Kept on purpose, pending the owner's decision: state() dates a worker that does not answer at the call. A
    // mission's stall check reads lastActivityAt from it, and a worker does not save its status on every activity.
    for (const id of [E, U1, U2]) assert.equal((await manager.state(id)).attention.lastActivityAt, new Date().toISOString(), `state() dates ${id === E ? "an exited" : "an unavailable"} row at the call`);

    const restarted = new Manager(f.config, f.key);
    const afterRestart = await restarted.list();
    assertRows(afterRestart, await oracle(restarted), "after a restart");
    assert.equal(JSON.stringify(afterRestart), JSON.stringify(cold), "after a restart the listing is byte-identical");
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

    // Rewrite the status of E in place: the same byte length, the same mtime (whole milliseconds, so
    // that utimesSync restores it exactly), a new ctime. The listing before the rewrite keeps its parse.
    const eStatus = join(recordDir(f, E), "status.sealed");
    const eStatusMtime = new Date(Math.floor(statSync(eStatus).mtimeMs));
    utimesSync(eStatus, eStatusMtime, eStatusMtime);
    const eStatusNs = statSync(eStatus, { bigint: true }).mtimeNs;
    assertRows(await manager.list(), await oracle(manager), "warm, after the status mtime was set");
    const otherStatus = join(f.root, "status-other.sealed");
    writeSealed(otherStatus, f.key, `${E}:status`, exitedState(2));
    const otherText = fs.readFileSync(otherStatus, "utf8");
    assert.equal(Buffer.byteLength(otherText), statSync(eStatus).size, "the rewrite has the same byte length");
    writeFileSync(eStatus, otherText);
    utimesSync(eStatus, eStatusMtime, eStatusMtime);
    assert.equal(statSync(eStatus, { bigint: true }).mtimeNs, eStatusNs, "the mtime is back to its value");
    const reseq = await manager.list();
    assertRows(reseq, await oracle(manager), "after an in-place rewrite with the same size and the old mtime");
    assert.equal(reseq.find(row => row.id === E)!.seq, 2, "the new status shows");

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

    // E's status is kept now. Make its read fail: the kept state is not served.
    writeFileSync(eStatus, "x");
    assertRows(await manager.list(), await oracle(manager), "after an unreadable status");
  } finally {
    mock.timers.reset();
    for (const worker of workers) await worker.close();
    f.close();
  }
});

test("a second listing of exited records reads no sealed file and connects to no worker", { timeout: 60_000 }, async t => {
  const f = await fixture();
  const spied = spy();
  // This test runs on the real clock until its last step: it needs files that are really fresh and files that are
  // really settled, in turn. `age` waits until every file written so far is older than the settle rule asks.
  const age = () => new Promise<void>(resolve => setTimeout(resolve, 2_200));
  const write = (id: string, name: "meta" | "status", value: unknown) => {
    mkdirSync(recordDir(f, id), { recursive: true });
    const file = join(recordDir(f, id), `${name}.sealed`);
    writeSealed(file, f.key, `${id}:${name}`, value);
    return file;
  };
  try {
    const ids = Array.from({ length: 200 }, () => ID());
    for (const id of ids) {
      write(id, "meta", { session: sessionOf(id), fingerprint: "fixture" });
      write(id, "status", exitedState(1));
    }
    // One more record. Its meta file gets an old mtime and a new ctime below, as a restore that keeps times leaves it.
    const probeId = ID();
    const probeMeta = write(probeId, "meta", { session: sessionOf(probeId), fingerprint: "fixture" });
    write(probeId, "status", exitedState(1));
    await age();
    utimesSync(probeMeta, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const manager = new Manager(f.config, f.key);

    let started = performance.now();
    await manager.list();
    const coldMs = performance.now() - started;
    assert.equal(spied.reads.length, 402, "cold: meta and status of each record");
    assert.equal(spied.connects.length, 0, "cold: no socket file, no connect");
    spied.reads.length = 0;

    await manager.list();
    assert.deepEqual(spied.reads, [probeMeta], "an old mtime with a new ctime is not kept; every settled file is");
    spied.reads.length = 0;

    await age();
    await manager.list();
    assert.deepEqual(spied.reads, [probeMeta], "once its ctime is old too, the file is read once more");
    spied.reads.length = 0;

    started = performance.now();
    const warm = await manager.list();
    const warmMs = performance.now() - started;
    assert.equal(warm.length, 201);
    assert.equal(spied.reads.length, 0, "warm: no sealed read");
    assert.equal(spied.connects.length, 0, "warm: no connect");
    t.diagnostic(`201 exited records: cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms`);

    const socketFile = socketPath(f.runDir, ids[0]);
    writeFileSync(socketFile, "");
    await manager.list();
    assert.equal(spied.connects.length, 1, "a socket file is connected");
    assert.equal(spied.reads.length, 0, "a failed connect reads no sealed file");
    rmSync(socketFile);
    spied.connects.length = 0;

    const freshFile = write(ids[1], "status", exitedState(2));
    await manager.list();
    assert.equal(spied.reads.filter(path => path === freshFile).length, 1, "a fresh status is read");
    spied.reads.length = 0;
    await manager.list();
    assert.equal(spied.reads.filter(path => path === freshFile).length, 1, "a fresh status is not kept");
    spied.reads.length = 0;

    await age();
    await manager.list();
    assert.equal(spied.reads.filter(path => path === freshFile).length, 1, "a changed file is read once");
    spied.reads.length = 0;
    await manager.list();
    assert.equal(spied.reads.length, 0, "a settled file is kept");

    // Only now the clock is mocked: it starts a minute in the past, as a clock that stepped back.
    mock.timers.enable({ apis: ["Date"], now: Date.now() - 60_000 });
    spied.reads.length = 0;
    await manager.list();
    assert.equal(spied.reads.length, 402, "a clock that stepped back reads every record again");
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

    const spoil = (row: Record<string, any>) => {
      row.title = "changed";
      row.attention.lastMessage = "changed";
      row.runtime.id = "changed";
      (row.contextSources as unknown[]).push("changed");
      row.capabilities.transcript = 9;
    };

    const first = await manager.list();
    spoil(first.find(item => item.id === E)! as Record<string, any>);

    const second = await manager.list();
    assertRows(second, await oracle(manager), "after the caller changed its rows");
    assert.notEqual(second.find(item => item.id === E)!.title, "changed");
    spoil(second.find(item => item.id === E)! as Record<string, any>);

    const third = await manager.list();
    assertRows(third, await oracle(manager), "after the caller changed a warm listing");
    assert.notEqual(third.find(item => item.id === E)!.title, "changed");
  } finally {
    mock.timers.reset();
    f.close();
  }
});

test("a kept parse has a revision, and a replaced file a new one", { timeout: 60_000 }, async () => {
  const f = await fixture();
  // Real clock: a file is settled only when its newer time is 2 s old, so the test waits between its steps.
  const age = () => new Promise<void>(resolve => setTimeout(resolve, 2_200));
  const writeRecord = (id: string, session: Session) => {
    mkdirSync(recordDir(f, id), { recursive: true });
    const meta = join(recordDir(f, id), "meta.sealed");
    writeSealed(meta, f.key, `${id}:meta`, { session, fingerprint: "fixture" });
    writeStatus(f, id, exitedState(1), false);
    return meta;
  };
  try {
    const E = ID(), Y = ID();
    const eMeta = writeRecord(E, sessionOf(E));
    writeRecord(Y, sessionOf(Y));
    const manager = new Manager(f.config, f.key);

    await manager.list();
    assert.equal(manager.metaRevision(E), undefined, "a file younger than the settle time keeps no parse");
    assert.equal(manager.metaRevision(Y), undefined, "a second young file keeps no parse");

    await age();
    await manager.list();
    const first = manager.metaRevision(E);
    assert.equal(typeof first, "string", "a settled parse has a revision");
    assert.notEqual(first, "");
    assert.equal(typeof manager.metaRevision(Y), "string", "the second file settled too");

    await manager.list();
    assert.equal(manager.metaRevision(E), first, "another listing keeps the same revision");

    writeSealed(eMeta, f.key, `${E}:meta`, { session: sessionOf(E, { title: "Replaced" }), fingerprint: "fixture" });
    await manager.list();
    assert.equal(manager.metaRevision(E), undefined, "a replaced file that is still young keeps no parse");
    await age();
    const rows = await manager.list();
    const second = manager.metaRevision(E);
    assert.equal(typeof second, "string");
    assert.notEqual(second, first, "a replaced file has a new revision");
    assert.equal(rows.find(row => row.id === E)!.title, "Replaced");

    rmSync(recordDir(f, E), { recursive: true, force: true });
    await manager.list();
    assert.equal(manager.metaRevision(E), undefined, "a deleted id that is no longer listed has no revision");
  } finally {
    f.close();
  }
});

test("a warm session list reads no session record", { timeout: 60_000 }, async t => {
  let host: Awaited<ReturnType<typeof inProcessHost>>;
  try {
    host = await inProcessHost();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "EADDRNOTAVAIL") {
      t.skip(`the in-process host cannot listen on loopback here (${code})`);
      return;
    }
    throw error;
  }
  const key = fs.readFileSync(host.config.keyFile);
  const dir = (id: string) => join(host.config.stateDir, "sessions", id);
  let spied: ReturnType<typeof spy> | undefined;
  try {
    const ids = Array.from({ length: 30 }, () => ID());
    for (const id of ids) {
      mkdirSync(dir(id), { recursive: true });
      // A record as the host writes it: the stored session carries `backend`.
      writeSealed(join(dir(id), "meta.sealed"), key, `${id}:meta`, { session: sessionOf(id, { backend: "infinite" }), fingerprint: "fixture" });
      writeSealed(join(dir(id), "status.sealed"), key, `${id}:status`, exitedState(1));
    }
    // The files settle, and the handoff poller runs twice; then the listing is warm.
    await new Promise(resolve => setTimeout(resolve, 2_300));
    await host.sessions.list();
    await new Promise(resolve => setTimeout(resolve, 1_000));
    await host.sessions.list();
    // A client with one session open reads its detail again and again. That read is no listing: it must leave the
    // other 29 sessions as the last listing left them.
    assert.equal((await host.fetchApi(`/sessions/${ids[0]}`)).status, 200);

    spied = spy();
    const rows = await host.sessions.list();
    assert.ok(rows.length >= 30, `the warm listing returns the 30 rows (got ${rows.length})`);
    assert.deepEqual(spied.reads.filter(path => path.includes("/sessions/")), [], "a warm listing reads no meta.sealed or status.sealed");
  } finally {
    spied?.restore();
    await host.stop();
  }
});
