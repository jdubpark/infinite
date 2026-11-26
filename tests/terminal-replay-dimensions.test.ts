import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import headless from "@xterm/headless";
import { WebSocket } from "ws";
import { initialAttention } from "@infinite/attention";
import { hashToken } from "../packages/host/src/config.js";
import { workerCall } from "../packages/host/src/ipc.js";
import { Manager } from "../packages/host/src/manager.js";
import {
  readTerminalSizeIndex,
  resolveReplayTerminalSize,
  TERMINAL_SIZE_INDEX_FILE,
  TerminalSizeIndex,
  terminalSizeFromEvent,
  type TerminalSizeEntry,
} from "../packages/host/src/terminal-size.js";
import { connectTerminals, terminalPages } from "../packages/host/src/terminal-stream.js";
import { Journal, readEvents, unseal, writeSealed } from "../packages/host/src/vault.js";
import { waitFor } from "./helpers.js";
import type { Bootstrap, Config, ControlLease, Event, Receipt, TerminalOpen, TerminalSize, TerminalSnapshot, WorkerRequest, WorkerState } from "../packages/host/src/types.js";

type StreamFrame = {
  open?: TerminalOpen;
  snapshot?: TerminalSnapshot;
  events?: Event[];
  cursor?: number;
  more?: boolean;
  cols?: number;
  rows?: number;
  state?: Partial<WorkerState>;
};

const AGENT = String.raw`
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("READY\r\n");
let pending = "";
process.stdin.on("data", data => {
  pending += data;
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
    const command = pending.slice(0, end);
    pending = pending.slice(end + 1);
    if (command === "sgr21") {
      process.stdout.write("\x1b[21mEXTENDED_SGR\x1b[0m\r\n");
    } else if (command === "wideburst") {
      for (let i = 1; i <= 40; i++) process.stdout.write("B" + String(i).padStart(2, "0") + "_" + "X".repeat(104) + "\r\n");
      process.stdout.write("WIDEBURST_END\r\n");
    } else if (command === "exit") {
      process.stdout.write("GOODBYE\r\n");
      setTimeout(() => process.exit(0), 20);
    } else {
      process.stdout.write("ECHO:" + command + "\r\n");
    }
  }
});
`;

async function startFixture() {
  const root = mkdtempSync("/tmp/inf-replay-dims-");
  const id = randomUUID();
  const key = randomBytes(32);
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  const script = join(root, "agent.mjs");
  const keyFile = join(root, "key");
  mkdirSync(runDir);
  mkdirSync(join(stateDir, "sessions", id), { recursive: true });
  writeFileSync(script, AGENT);
  writeFileSync(keyFile, key, { mode: 0o600 });
  const token = randomBytes(32).toString("base64url");
  const device = { id: "owner-1", label: "Owner", role: "owner" as const, hash: hashToken(token) };
  const runtime = { id: randomUUID(), location: "cloud" as const, transport: "pty" as const };
  const session: Bootstrap["session"] = {
    id,
    provider: "demo",
    title: "Replay dimensions",
    projectId: "fixture",
    cwd: root,
    createdAt: new Date().toISOString(),
    status: "starting",
    contextVersion: 0,
    context: "",
    initialPrompt: "",
    runtime,
  };
  writeSealed(join(stateDir, "sessions", id, "meta.sealed"), key, `${id}:meta`, {
    session,
    fingerprint: "replay-dims-fixture",
  });
  const bootstrap: Bootstrap = {
    session,
    profile: { command: process.execPath, args: [script] },
    runDir,
    stateDir,
    key: key.toString("base64"),
    prompt: "",
    codeMode: false,
    attention: { idleAfterMs: 60_000, limitConfirmMs: 30_000, hooks: { claude: false, codex: false } },
  };
  const worker = spawn(process.execPath, ["--import", "tsx", resolve("packages/host/src/worker.ts")], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  worker.stderr.on("data", chunk => { stderr += chunk; });
  worker.stdin.end(JSON.stringify(bootstrap));
  const server = createServer();
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as { port: number }).port;
  const config = {
    port,
    origin: `http://127.0.0.1:${port}`,
    stateDir,
    runDir,
    keyFile,
    environment: "local",
    enableDemo: true,
    maxSessions: 4,
    tokens: [device],
    projects: [],
    agents: {},
  } as Config;
  const manager = new Manager(config, key);
  const closeTerminals = connectTerminals(server, manager, value => value === token ? device : undefined);
  const call = <T = WorkerState>(request: WorkerRequest) => workerCall<T>(runDir, id, request, 6000);
  const events = () => {
    const all: Event[] = [];
    let cursor = 0;
    for (;;) {
      const page = readEvents(join(stateDir, "sessions", id, "events"), key, id, cursor);
      all.push(...page.events);
      cursor = page.cursor;
      if (!page.more) return all;
    }
  };
  const output = () => events().filter(event => event.type === "output").map(event => String(event.data.text)).join("");
  const persisted = () => unseal<WorkerState>(key, `${id}:status`, readFileSync(join(stateDir, "sessions", id, "status.sealed"), "utf8"));
  const collectWsFrames = (query: string, stopWhen: (frames: StreamFrame[]) => boolean) => new Promise<StreamFrame[]>((resolveFrames, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/terminal?${query}`);
    const frames: StreamFrame[] = [];
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`Timed out waiting for frames (${query}), got ${frames.length}`)); }, 8000);
    ws.once("open", () => ws.send(JSON.stringify({ token, clientId: randomUUID() })));
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as StreamFrame;
      frames.push(frame);
      if (stopWhen(frames)) {
        clearTimeout(timer);
        ws.close();
        resolveFrames(frames);
      }
    });
    ws.on("error", error => { clearTimeout(timer); reject(error); });
  });
  const stop = async () => {
    closeTerminals();
    server.closeAllConnections();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    if (worker.exitCode === null && worker.signalCode === null) {
      try {
        const actor = { id: "cleanup", label: "Cleanup" };
        const lease = await call<ControlLease>({ op: "control", action: "claim", actor, takeover: true });
        await call({ op: "stop", requestId: randomUUID(), actor, leaseId: lease.id });
      } catch {}
      await Promise.race([
        new Promise(resolveExit => worker.once("exit", resolveExit)),
        new Promise(resolveWait => setTimeout(resolveWait, 3500)),
      ]);
    }
    worker.kill();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await waitFor(async () => {
      try { return await call({ op: "state", screen: true }); }
      catch (error) { if (worker.exitCode !== null) throw new Error(stderr || String(error)); return undefined; }
    }, state => Boolean(state?.screen.includes("READY")));
  } catch (error) {
    await stop();
    throw error;
  }
  return { id, root, stateDir, runDir, key, manager, worker, call, events, output, persisted, collectWsFrames, stop };
}

test("host open and replay frames attach authoritative server PTY dimensions across live, resized, snapshot-fallback, reconnect, and exited sessions", { timeout: 35_000 }, async () => {
  const f = await startFixture();
  try {
    const initialState = await f.call({ op: "state" });
    assert.deepEqual(initialState.terminalSize, { cols: 120, rows: 32 });
    assert.deepEqual(f.persisted().terminalSize, { cols: 120, rows: 32 });
    const runningLifecycle = f.events().find(event => event.type === "lifecycle" && event.data.status === "running");
    assert.ok(runningLifecycle);
    assert.equal(runningLifecycle.data.cols, 120);
    assert.equal(runningLifecycle.data.rows, 32);

    const actor = { id: "owner-client", label: "Owner" };
    const lease = await f.call<ControlLease>({ op: "control", action: "claim", actor });
    await f.call<Receipt>({ op: "raw", requestId: randomUUID(), text: "BEFORE_RESIZE\n", actor, leaseId: lease.id });
    await waitFor(async () => f.output(), text => text.includes("ECHO:BEFORE_RESIZE"));

    const initialReplay = await f.collectWsFrames("after=0&snapshot=0", frames =>
      frames.some(frame => frame.events?.some(event => event.type === "output" && String(event.data.text).includes("ECHO:BEFORE_RESIZE"))));
    assert.deepEqual(initialReplay[0]?.open, { cursor: 0, cols: 120, rows: 32 });
    assert.equal(initialReplay[0]?.cols, 120);
    assert.equal(initialReplay[0]?.rows, 32);
    const beforeOutputFrame = initialReplay.find(frame =>
      frame.events?.some(event => event.type === "output" && String(event.data.text).includes("ECHO:BEFORE_RESIZE")));
    assert.equal(beforeOutputFrame?.cols, 120);
    assert.equal(beforeOutputFrame?.rows, 32);

    await f.call({ op: "resize", cols: 88, rows: 26, actor, leaseId: lease.id });
    const resizedState = await f.call({ op: "state" });
    assert.deepEqual(resizedState.terminalSize, { cols: 88, rows: 26 });
    assert.deepEqual(f.persisted().terminalSize, { cols: 88, rows: 26 });

    await f.call<Receipt>({ op: "raw", requestId: randomUUID(), text: "AFTER_RESIZE\n", actor, leaseId: lease.id });
    await waitFor(async () => f.output(), text => text.includes("ECHO:AFTER_RESIZE"));

    const allEvents = f.events();
    const preResizeOutput = allEvents.find(event => event.type === "output" && String(event.data.text).includes("ECHO:BEFORE_RESIZE"))!;
    const resizeLifecycle = allEvents.find(event => event.type === "lifecycle" && event.data.event === "resize")!;
    const postResizeOutput = allEvents.find(event => event.type === "output" && String(event.data.text).includes("ECHO:AFTER_RESIZE"))!;
    assert.ok(preResizeOutput.seq < resizeLifecycle.seq);
    assert.ok(resizeLifecycle.seq < postResizeOutput.seq);
    assert.equal(resizeLifecycle.data.cols, 88);
    assert.equal(resizeLifecycle.data.rows, 26);

    const snapshotFrames = await f.collectWsFrames("after=0&snapshot=1", frames => Boolean(frames[0]?.snapshot));
    assert.equal(snapshotFrames[0]?.snapshot?.cols, 88);
    assert.equal(snapshotFrames[0]?.snapshot?.rows, 26);
    assert.equal(snapshotFrames[0]?.open?.cols, 88);
    assert.equal(snapshotFrames[0]?.open?.rows, 26);
    assert.equal(snapshotFrames[0]?.cols, 88);
    assert.equal(snapshotFrames[0]?.rows, 26);

    await f.call<Receipt>({ op: "raw", requestId: randomUUID(), text: "sgr21\n", actor, leaseId: lease.id });
    await waitFor(async () => f.output(), text => text.includes("EXTENDED_SGR"));
    await assert.rejects(f.call({ op: "snapshot" }), { code: "snapshot-unavailable" });

    const fallbackFrames = await f.collectWsFrames("after=0&snapshot=1", frames =>
      frames.some(frame => frame.events?.some(event => event.type === "output" && String(event.data.text).includes("EXTENDED_SGR"))));
    assert.equal(fallbackFrames.some(frame => Boolean(frame.snapshot)), false);
    assert.deepEqual(fallbackFrames[0]?.open, { cursor: 0, cols: 120, rows: 32 });
    const fallbackPre = fallbackFrames.find(frame =>
      frame.events?.some(event => event.type === "output" && String(event.data.text).includes("ECHO:BEFORE_RESIZE")));
    const fallbackResize = fallbackFrames.find(frame =>
      frame.events?.some(event => event.type === "lifecycle" && event.data.event === "resize"));
    const fallbackPost = fallbackFrames.find(frame =>
      frame.events?.some(event => event.type === "output" && String(event.data.text).includes("ECHO:AFTER_RESIZE")));
    assert.deepEqual([fallbackPre?.cols, fallbackPre?.rows], [120, 32]);
    assert.deepEqual([fallbackResize?.cols, fallbackResize?.rows], [88, 26]);
    assert.deepEqual([fallbackPost?.cols, fallbackPost?.rows], [88, 26]);

    const reconnectFrames = await f.collectWsFrames(`after=${resizeLifecycle.seq}&snapshot=1`, frames =>
      frames.some(frame => frame.events?.some(event => event.type === "output" && String(event.data.text).includes("EXTENDED_SGR"))));
    assert.deepEqual(reconnectFrames[0]?.open, { cursor: resizeLifecycle.seq, cols: 88, rows: 26 });
    const reconnectPost = reconnectFrames.find(frame =>
      frame.events?.some(event => event.type === "output" && String(event.data.text).includes("ECHO:AFTER_RESIZE")));
    assert.deepEqual([reconnectPost?.cols, reconnectPost?.rows], [88, 26]);

    await f.call<Receipt>({ op: "raw", requestId: randomUUID(), text: "exit\n", actor, leaseId: lease.id });
    await waitFor(async () => f.worker.exitCode, code => code !== null, 10_000);

    const exitedFull: StreamFrame[] = [];
    for await (const page of terminalPages(f.manager, f.id, 0, new AbortController().signal, true)) {
      exitedFull.push(page as StreamFrame);
    }
    assert.deepEqual(exitedFull[0]?.open, { cursor: 0, cols: 120, rows: 32 });
    const exitedPre = exitedFull.find(frame =>
      frame.events?.some(event => event.type === "output" && String(event.data.text).includes("ECHO:BEFORE_RESIZE")));
    const exitedPost = exitedFull.find(frame =>
      frame.events?.some(event => event.type === "output" && String(event.data.text).includes("GOODBYE")));
    const exitedState = exitedFull.find(frame => frame.state?.status === "exited");
    assert.deepEqual([exitedPre?.cols, exitedPre?.rows], [120, 32]);
    assert.deepEqual([exitedPost?.cols, exitedPost?.rows], [88, 26]);
    assert.deepEqual(exitedState?.state?.terminalSize, { cols: 88, rows: 26 });

    const exitedMid: StreamFrame[] = [];
    for await (const page of terminalPages(f.manager, f.id, resizeLifecycle.seq, new AbortController().signal, false)) {
      exitedMid.push(page as StreamFrame);
    }
    assert.deepEqual(exitedMid[0]?.open, { cursor: resizeLifecycle.seq, cols: 88, rows: 26 });
  } finally {
    await f.stop();
  }
});

test("legacy unsized exited sessions omit cols and rows cleanly without failing replay", { timeout: 10_000 }, async () => {
  const root = mkdtempSync("/tmp/inf-legacy-replay-");
  const id = randomUUID();
  const key = randomBytes(32);
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  const keyFile = join(root, "key");
  mkdirSync(runDir);
  mkdirSync(join(stateDir, "sessions", id, "events"), { recursive: true });
  writeFileSync(keyFile, key, { mode: 0o600 });
  const now = new Date().toISOString();
  writeSealed(join(stateDir, "sessions", id, "meta.sealed"), key, `${id}:meta`, {
    session: {
      id,
      provider: "demo",
      title: "Legacy session",
      projectId: "fixture",
      cwd: root,
      createdAt: now,
      status: "exited",
      contextVersion: 0,
      context: "",
      initialPrompt: "",
    },
    fingerprint: "legacy-replay-fixture",
  });
  const journal = new Journal(join(stateDir, "sessions", id, "events"), key, id);
  journal.append("lifecycle", { status: "running", pid: 99999 });
  journal.append("output", { text: "LEGACY_OUTPUT\r\n" });
  journal.append("lifecycle", { status: "exited", exitCode: 0 });
  writeSealed(join(stateDir, "sessions", id, "status.sealed"), key, `${id}:status`, {
    status: "exited",
    exitCode: 0,
    seq: journal.seq,
    screen: "",
    attention: initialAttention(now, false),
  });
  const manager = new Manager({
    port: 0,
    origin: "http://127.0.0.1:0",
    stateDir,
    runDir,
    keyFile,
    environment: "local",
    enableDemo: true,
    maxSessions: 4,
    tokens: [],
    projects: [],
    agents: {},
  } as Config, key);
  try {
    const frames: StreamFrame[] = [];
    for await (const page of terminalPages(manager, id, 0, new AbortController().signal, true)) {
      frames.push(page as StreamFrame);
    }
    assert.deepEqual(frames[0]?.open, { cursor: 0 });
    assert.equal(frames[0]?.cols, undefined);
    assert.equal(frames[0]?.rows, undefined);
    const out = frames.find(frame => frame.events?.some(event => event.type === "output" && event.data.text === "LEGACY_OUTPUT\r\n"));
    assert.ok(out);
    assert.equal(out.cols, undefined);
    assert.equal(out.rows, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function terminalImage(terminal: headless.Terminal) {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = Math.max(0, buffer.length - 120); i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  return { lines, cols: terminal.cols, rows: terminal.rows, cursorX: buffer.cursorX, cursorY: buffer.cursorY, type: buffer.type };
}

test("worker drains pending xterm writes across the resize barrier so snapshot and journal replay render identically", { timeout: 25_000 }, async () => {
  const f = await startFixture();
  const terminals: headless.Terminal[] = [];
  try {
    const actor = { id: "barrier-owner", label: "Barrier" };
    const lease = await f.call<ControlLease>({ op: "control", action: "claim", actor });
    await f.call<Receipt>({ op: "raw", requestId: randomUUID(), text: "wideburst\n", actor, leaseId: lease.id });
    await f.call({ op: "resize", cols: 70, rows: 20, actor, leaseId: lease.id });
    await f.call<Receipt>({ op: "raw", requestId: randomUUID(), text: "POST_BARRIER\n", actor, leaseId: lease.id });
    await waitFor(async () => f.output(), text => text.includes("WIDEBURST_END") && text.includes("ECHO:POST_BARRIER"));

    const snap = await f.call<TerminalSnapshot>({ op: "snapshot" });
    assert.deepEqual([snap.cols, snap.rows], [70, 20]);

    const events = f.events().filter(event => event.seq <= snap.seq && (event.type === "output" || event.type === "lifecycle"));
    const initialSize = terminalSizeFromEvent(events.find(event => event.type === "lifecycle" && terminalSizeFromEvent(event))!)!;
    const replayed = new headless.Terminal({ cols: initialSize.cols, rows: initialSize.rows, scrollback: 5000, allowProposedApi: true });
    const restored = new headless.Terminal({ cols: snap.cols, rows: snap.rows, scrollback: 5000, allowProposedApi: true });
    terminals.push(replayed, restored);

    for (const event of events) {
      if (event.type === "lifecycle") {
        const size = terminalSizeFromEvent(event);
        if (size && (replayed.cols !== size.cols || replayed.rows !== size.rows)) {
          replayed.resize(size.cols, size.rows);
        }
      } else if (event.type === "output") {
        await new Promise<void>(resolveWrite => replayed.write(String(event.data.text), resolveWrite));
      }
    }
    await new Promise<void>(resolveWrite => restored.write(snap.ansi, resolveWrite));
    assert.deepEqual(terminalImage(replayed), terminalImage(restored));
  } finally {
    terminals.forEach(terminal => terminal.dispose());
    await f.stop();
  }
});

test("reconnect geometry stays exact past 32 encrypted readEvents pages with size index and in legacy scan mode", { timeout: 25_000 }, () => {
  const root = mkdtempSync("/tmp/inf-long-replay-");
  const id = randomUUID();
  const key = randomBytes(32);
  const eventsDir = join(root, "events");
  const indexFile = join(root, TERMINAL_SIZE_INDEX_FILE);
  try {
    const journal = new Journal(eventsDir, key, id);
    const sizeIndex = new TerminalSizeIndex(indexFile, key, id);
    const running = journal.append("lifecycle", { status: "running", pid: 42, cols: 120, rows: 32 });
    sizeIndex.append(running.seq, { cols: 120, rows: 32 });
    const chunk = "P".repeat(260 * 1024);
    for (let i = 0; i < 68; i++) journal.append("output", { text: chunk });
    const resized = journal.append("lifecycle", { event: "resize", cols: 94, rows: 30 });
    sizeIndex.append(resized.seq, { cols: 94, rows: 30 });
    const afterResize = journal.append("output", { text: "AFTER_LONG_HISTORY\r\n" });

    let indexedReads = 0;
    const entries = readTerminalSizeIndex(indexFile, key, id);
    const fromIndex = resolveReplayTerminalSize(
      (after, limit, types) => {
        indexedReads++;
        return readEvents(eventsDir, key, id, after, limit, types);
      },
      afterResize.seq,
      undefined,
      entries,
    );
    assert.deepEqual(fromIndex, { cols: 94, rows: 30 });
    assert.ok(indexedReads <= 1, `size index jumps past earlier pages (reads=${indexedReads})`);

    const midHistory = resolveReplayTerminalSize(
      (after, limit, types) => {
        indexedReads++;
        return readEvents(eventsDir, key, id, after, limit, types);
      },
      resized.seq - 1,
      undefined,
      entries,
    );
    assert.deepEqual(midHistory, { cols: 120, rows: 32 });

    let legacyPages = 0;
    const fromLegacyScan = resolveReplayTerminalSize(
      (after, limit, types) => {
        legacyPages++;
        return readEvents(eventsDir, key, id, after, limit, types);
      },
      afterResize.seq,
      undefined,
      [],
    );
    assert.ok(legacyPages > 32, `recording must exceed 32 encrypted readEvents pages (saw ${legacyPages})`);
    assert.deepEqual(fromLegacyScan, { cols: 94, rows: 30 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function oracleSizeAt(history: readonly TerminalSizeEntry[], after: number): TerminalSize | undefined {
  if (after === 0) return history[0] ? { cols: history[0].cols, rows: history[0].rows } : undefined;
  let found: TerminalSize | undefined;
  for (const entry of history) {
    if (entry.seq <= after) found = { cols: entry.cols, rows: entry.rows };
    else break;
  }
  return found;
}

type Resolver = (
  readPage: (after: number, limit: number, types?: Set<string>) => { events: Event[]; cursor: number; more: boolean },
  after: number,
  fallback: TerminalSize | undefined,
  entries: readonly TerminalSizeEntry[],
) => TerminalSize | undefined;

function runDurableGeometrySimulation(resolver: Resolver, seeds: readonly number[]) {
  const coverage = {
    resizes: 0,
    outputs: 0,
    largeBursts: 0,
    reconnectAtZero: 0,
    reconnectAtResizeBoundary: 0,
    reconnectMidStream: 0,
    crashAfterJournal: 0,
    tornSizeIndex: 0,
    crashAfterIndex: 0,
    legacyNoIndex: 0,
  };
  for (const seed of seeds) {
    const rng = mulberry32(seed);
    const root = mkdtempSync(`/tmp/inf-sim-${seed}-`);
    const id = randomUUID();
    const key = randomBytes(32);
    const eventsDir = join(root, "events");
    const indexFile = join(root, TERMINAL_SIZE_INDEX_FILE);
    const statusFile = join(root, "status.sealed");
    try {
      const journal = new Journal(eventsDir, key, id);
      const sizeIndex = new TerminalSizeIndex(indexFile, key, id);
      const history: TerminalSizeEntry[] = [];
      let current: TerminalSize = {
        cols: 40 + Math.floor(rng() * 160),
        rows: 10 + Math.floor(rng() * 60),
      };
      let statusSize: TerminalSize = current;
      const runEvent = journal.append("lifecycle", { status: "running", pid: 100 + seed, cols: current.cols, rows: current.rows });
      history.push({ seq: runEvent.seq, cols: current.cols, rows: current.rows });
      sizeIndex.append(runEvent.seq, current);
      writeSealed(statusFile, key, `${id}:status`, {
        status: "running",
        seq: journal.seq,
        screen: "",
        terminalSize: statusSize,
        attention: initialAttention("2026-11-26T00:00:00.000Z", false),
      });

      const readPage = (after: number, limit: number, types?: Set<string>) => readEvents(eventsDir, key, id, after, limit, types);
      const verifyCursor = (after: number, useIndex: boolean) => {
        const persisted = unseal<WorkerState>(key, `${id}:status`, readFileSync(statusFile, "utf8"));
        const entries = useIndex ? readTerminalSizeIndex(indexFile, key, id) : [];
        const actual = resolver(readPage, after, persisted.terminalSize, entries);
        const expected = oracleSizeAt(history, after);
        assert.deepEqual(actual, expected, `seed=${seed} after=${after} useIndex=${useIndex}`);
      };

      const steps = 28;
      let crashed = false;
      for (let step = 0; step < steps && !crashed; step++) {
        const roll = rng();
        if (roll < 0.42) {
          const isLarge = rng() < 0.12;
          const text = isLarge ? "L".repeat(64 * 1024) : `step-${step}-${"x".repeat(Math.floor(rng() * 80))}\r\n`;
          journal.append("output", { text });
          coverage.outputs++;
          if (isLarge) coverage.largeBursts++;
        } else if (roll < 0.72) {
          const next: TerminalSize = rng() < 0.1
            ? current
            : { cols: 20 + Math.floor(rng() * 200), rows: 5 + Math.floor(rng() * 80) };
          if (next.cols !== current.cols || next.rows !== current.rows) {
            current = next;
            const resized = journal.append("lifecycle", { event: "resize", cols: current.cols, rows: current.rows });
            history.push({ seq: resized.seq, cols: current.cols, rows: current.rows });
            coverage.resizes++;
            const fault = rng();
            if (fault < 0.12) {
              coverage.crashAfterJournal++;
              crashed = true;
            } else if (fault < 0.24) {
              appendFileSync(indexFile, "{\"v\":1,\"n\":\"torn");
              coverage.tornSizeIndex++;
              crashed = true;
            } else if (fault < 0.36) {
              sizeIndex.append(resized.seq, current);
              coverage.crashAfterIndex++;
              crashed = true;
            } else {
              sizeIndex.append(resized.seq, current);
              statusSize = current;
              writeSealed(statusFile, key, `${id}:status`, {
                status: "running",
                seq: journal.seq,
                screen: "",
                terminalSize: statusSize,
                attention: initialAttention("2026-11-26T00:00:00.000Z", false),
              });
            }
          }
        } else {
          const targetKind = rng();
          if (targetKind < 0.25) {
            verifyCursor(0, true);
            coverage.reconnectAtZero++;
          } else if (targetKind < 0.65) {
            const pick = history[Math.floor(rng() * history.length)];
            for (const candidate of [pick.seq - 1, pick.seq, Math.min(journal.seq, pick.seq + 1)]) {
              verifyCursor(candidate, true);
            }
            coverage.reconnectAtResizeBoundary++;
          } else {
            const mid = 1 + Math.floor(rng() * journal.seq);
            verifyCursor(mid, true);
            coverage.reconnectMidStream++;
          }
        }
      }

      verifyCursor(0, true);
      coverage.reconnectAtZero++;
      const lastResize = history.at(-1)!;
      for (const candidate of [lastResize.seq - 1, lastResize.seq, journal.seq]) {
        verifyCursor(candidate, true);
      }
      coverage.reconnectAtResizeBoundary++;
      verifyCursor(journal.seq, false);
      coverage.legacyNoIndex++;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return coverage;
}

test("seeded durable-state simulator verifies replay geometry across crashes and rejects broken mutants", { timeout: 30_000 }, () => {
  const seeds = Array.from({ length: 24 }, (_, index) => 1001 + index);
  const coverage = runDurableGeometrySimulation(resolveReplayTerminalSize, seeds);
  for (const [metric, count] of Object.entries(coverage)) {
    assert.ok(count > 0, `expected non-zero coverage for ${metric}, got ${count}`);
  }

  const indexOnlyNoTailMutant: Resolver = (readPage, after, fallback, entries) => {
    if (after === 0) return resolveReplayTerminalSize(readPage, 0, fallback, entries);
    let found: TerminalSize | undefined;
    for (const entry of entries) if (entry.seq <= after) found = { cols: entry.cols, rows: entry.rows };
    return found ?? fallback;
  };
  assert.throws(
    () => runDurableGeometrySimulation(indexOnlyNoTailMutant, seeds),
    "index-only mutant without journal tail catch-up must fail on crash-after-journal and torn-size-index faults",
  );

  const finalSizeForZeroMutant: Resolver = (readPage, after, fallback, entries) => {
    if (after === 0) return fallback;
    return resolveReplayTerminalSize(readPage, after, fallback, entries);
  };
  assert.throws(
    () => runDurableGeometrySimulation(finalSizeForZeroMutant, seeds),
    "using final status.sealed terminalSize for after=0 must fail after any resize",
  );

  const strictLessBoundaryMutant: Resolver = (readPage, after, fallback, entries) => {
    if (after === 0) return resolveReplayTerminalSize(readPage, 0, fallback, entries);
    return resolveReplayTerminalSize(readPage, Math.max(0, after - 1), fallback, entries);
  };
  assert.throws(
    () => runDurableGeometrySimulation(strictLessBoundaryMutant, seeds),
    "strict < boundary mutant must fail at exact resize seq boundaries",
  );

  const staleBoundedScanMutant: Resolver = (readPage, after, fallback) => {
    if (after === 0) return resolveReplayTerminalSize(readPage, 0, fallback, []);
    let cursor = 0;
    let resolved: TerminalSize | undefined;
    for (let scanned = 0; scanned < 2 && cursor < after; scanned++) {
      const page = readPage(cursor, 200, new Set(["lifecycle"]));
      for (const event of page.events) {
        if (event.seq > after) return resolved ?? fallback;
        const size = terminalSizeFromEvent(event);
        if (size) resolved = size;
      }
      if (!page.more || page.cursor <= cursor) break;
      cursor = page.cursor;
    }
    return resolved ?? fallback;
  };
  assert.throws(() => {
    const root = mkdtempSync("/tmp/inf-mutant-bounded-");
    const id = randomUUID();
    const key = randomBytes(32);
    const eventsDir = join(root, "events");
    try {
      const journal = new Journal(eventsDir, key, id);
      journal.append("lifecycle", { status: "running", pid: 7, cols: 120, rows: 32 });
      const big = "M".repeat(260 * 1024);
      for (let i = 0; i < 6; i++) journal.append("output", { text: big });
      const resized = journal.append("lifecycle", { event: "resize", cols: 84, rows: 24 });
      const tail = journal.append("output", { text: "TAIL" });
      const actual = staleBoundedScanMutant(
        (after, limit, types) => readEvents(eventsDir, key, id, after, limit, types),
        tail.seq,
        undefined,
        [],
      );
      assert.deepEqual(actual, { cols: 84, rows: 24 });
      assert.ok(resized.seq < tail.seq);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, "bounded forward scan mutant must fail when output exceeds page budget before resize");
});
