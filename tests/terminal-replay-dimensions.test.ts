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
  type ResolveReplaySizeOptions,
  type TerminalSizeEntry,
  type TerminalSizeIndexRead,
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
process.stdout.on("resize", () => {
  process.stdout.write("SIGWINCH_" + process.stdout.columns + "x" + process.stdout.rows + "\r\n");
});
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
    executionIdentity: "production",
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
    executionIdentity: "production",
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

test("worker drains pending xterm writes across the resize barrier, orders SIGWINCH output after resize, and rejects stale leases before child.resize", { timeout: 25_000 }, async () => {
  const f = await startFixture();
  const terminals: headless.Terminal[] = [];
  try {
    const actor = { id: "barrier-owner", label: "Barrier" };
    const lease = await f.call<ControlLease>({ op: "control", action: "claim", actor });
    await f.call<Receipt>({ op: "raw", requestId: randomUUID(), text: "wideburst\n", actor, leaseId: lease.id });
    await waitFor(async () => f.output(), text => text.includes("WIDEBURST_END"));
    await f.call({ op: "resize", cols: 70, rows: 20, actor, leaseId: lease.id });
    await f.call<Receipt>({ op: "raw", requestId: randomUUID(), text: "POST_BARRIER\n", actor, leaseId: lease.id });
    await waitFor(async () => f.output(), text => text.includes("SIGWINCH_70x20") && text.includes("ECHO:POST_BARRIER"));

    const allEvents = f.events();
    const preBurstEvent = allEvents.find(event => event.type === "output" && String(event.data.text).includes("WIDEBURST_END"))!;
    const resizeEvent = allEvents.find(event => event.type === "lifecycle" && event.data.event === "resize" && event.data.cols === 70 && event.data.rows === 20)!;
    const sigwinchEvent = allEvents.find(event => event.type === "output" && String(event.data.text).includes("SIGWINCH_70x20"))!;
    assert.ok(preBurstEvent.seq < resizeEvent.seq, "pre-resize output stays strictly before the resize lifecycle event");
    assert.ok(resizeEvent.seq < sigwinchEvent.seq, "post-resize SIGWINCH output lands strictly after the resize lifecycle event");

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

    const intruder = { id: "takeover-owner", label: "Takeover" };
    await f.call<ControlLease>({ op: "control", action: "claim", actor: intruder, takeover: true });
    await assert.rejects(f.call({ op: "resize", cols: 95, rows: 28, actor, leaseId: lease.id }), { code: "control-lost" });
    assert.deepEqual((await f.call({ op: "state" })).terminalSize, { cols: 70, rows: 20 });
    assert.equal(f.output().includes("SIGWINCH_95x28"), false, "rejected stale lease never reaches child.resize");
  } finally {
    terminals.forEach(terminal => terminal.dispose());
    await f.stop();
  }
});

test("reconnect geometry stays exact past 32 encrypted pages with zero-scan covered index, zero-resize sessions, and async legacy scan", { timeout: 30_000 }, async () => {
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
    const lastNoResizeSeq = journal.seq;

    let zeroResizeReads = 0;
    const beforeResizeIndex = readTerminalSizeIndex(indexFile, key, id);
    assert.equal(beforeResizeIndex.intact, true);
    const zeroResizeResolved = await resolveReplayTerminalSize(
      (after, limit, types) => {
        zeroResizeReads++;
        return readEvents(eventsDir, key, id, after, limit, types);
      },
      lastNoResizeSeq,
      { index: beforeResizeIndex, coveredSeq: sizeIndex.coveredSeq(lastNoResizeSeq) },
    );
    assert.deepEqual(zeroResizeResolved, { cols: 120, rows: 32 });
    assert.equal(zeroResizeReads, 0, "a long zero-resize session resolves directly from sizeIndex + sizeIndexCoveredSeq with zero journal reads");

    const resized = journal.append("lifecycle", { event: "resize", cols: 94, rows: 30 });
    sizeIndex.append(resized.seq, { cols: 94, rows: 30 });
    const afterResize = journal.append("output", { text: "AFTER_LONG_HISTORY\r\n" });

    let indexedReads = 0;
    const entries = readTerminalSizeIndex(indexFile, key, id);
    const fromIndex = await resolveReplayTerminalSize(
      (after, limit, types) => {
        indexedReads++;
        return readEvents(eventsDir, key, id, after, limit, types);
      },
      afterResize.seq,
      { index: entries, coveredSeq: sizeIndex.coveredSeq(afterResize.seq) },
    );
    assert.deepEqual(fromIndex, { cols: 94, rows: 30 });
    assert.equal(indexedReads, 0);

    const midHistory = await resolveReplayTerminalSize(
      (after, limit, types) => {
        indexedReads++;
        return readEvents(eventsDir, key, id, after, limit, types);
      },
      resized.seq - 1,
      { index: entries, coveredSeq: sizeIndex.coveredSeq(afterResize.seq) },
    );
    assert.deepEqual(midHistory, { cols: 120, rows: 32 });
    assert.equal(indexedReads, 0);

    let legacyPages = 0;
    const fromLegacyScan = await resolveReplayTerminalSize(
      (after, limit, types) => {
        legacyPages++;
        return readEvents(eventsDir, key, id, after, limit, types);
      },
      afterResize.seq,
      { index: { entries: [], intact: false } },
    );
    assert.ok(legacyPages > 32, `recording must exceed 32 encrypted readEvents pages (saw ${legacyPages})`);
    assert.deepEqual(fromLegacyScan, { cols: 94, rows: 30 });

    const brokenPath = join(root, "unwritable-dir");
    mkdirSync(brokenPath);
    const failingIndex = new TerminalSizeIndex(brokenPath, key, id);
    assert.equal(failingIndex.append(2, { cols: 120, rows: 32 }), false);
    assert.equal(failingIndex.isDisabled, true);
    assert.equal(failingIndex.coveredSeq(100), undefined);
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
  options: ResolveReplaySizeOptions,
) => Promise<TerminalSize | undefined>;

async function runDurableGeometrySimulation(
  resolver: Resolver,
  seeds: readonly number[],
  opts: { allowIndexAppendAfterMiss?: boolean } = {},
) {
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
    missedIndexAppendThenLaterResize: 0,
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
      let missedAppendOccurred = false;
      const runEvent = journal.append("lifecycle", { status: "running", pid: 100 + seed, cols: current.cols, rows: current.rows });
      history.push({ seq: runEvent.seq, cols: current.cols, rows: current.rows });
      sizeIndex.append(runEvent.seq, current);
      const persistStatus = () => {
        const covered = sizeIndex.coveredSeq(journal.seq);
        writeSealed(statusFile, key, `${id}:status`, {
          status: "running",
          seq: journal.seq,
          screen: "",
          terminalSize: statusSize,
          ...(covered !== undefined ? { sizeIndexCoveredSeq: covered } : {}),
          attention: initialAttention("2026-11-26T00:00:00.000Z", false),
        });
      };
      persistStatus();

      const readPage = (after: number, limit: number, types?: Set<string>) => readEvents(eventsDir, key, id, after, limit, types);
      const verifyCursor = async (after: number, useIndex: boolean) => {
        const persisted = unseal<WorkerState>(key, `${id}:status`, readFileSync(statusFile, "utf8"));
        const index: TerminalSizeIndexRead = useIndex ? readTerminalSizeIndex(indexFile, key, id) : { entries: [], intact: false };
        const actual = await resolver(readPage, after, {
          fallback: persisted.terminalSize,
          index,
          coveredSeq: useIndex ? persisted.sizeIndexCoveredSeq : undefined,
        });
        const expected = oracleSizeAt(history, after);
        assert.deepEqual(actual, expected, `seed=${seed} after=${after} useIndex=${useIndex}`);
      };

      const steps = 32;
      let crashed = false;
      for (let step = 0; step < steps && !crashed; step++) {
        const roll = rng();
        if (roll < 0.40) {
          const isLarge = rng() < 0.12;
          const text = isLarge ? "L".repeat(64 * 1024) : `step-${step}-${"x".repeat(Math.floor(rng() * 80))}\r\n`;
          journal.append("output", { text });
          coverage.outputs++;
          if (isLarge) coverage.largeBursts++;
        } else if (roll < 0.74) {
          const next: TerminalSize = rng() < 0.1
            ? current
            : { cols: 20 + Math.floor(rng() * 200), rows: 5 + Math.floor(rng() * 80) };
          if (next.cols !== current.cols || next.rows !== current.rows) {
            current = next;
            const resized = journal.append("lifecycle", { event: "resize", cols: current.cols, rows: current.rows });
            history.push({ seq: resized.seq, cols: current.cols, rows: current.rows });
            coverage.resizes++;
            if (missedAppendOccurred) {
              if (opts.allowIndexAppendAfterMiss) {
                const brokenReopened = new TerminalSizeIndex(indexFile, key, id);
                brokenReopened.append(resized.seq, current);
              } else {
                sizeIndex.append(resized.seq, current);
              }
              statusSize = current;
              persistStatus();
              coverage.missedIndexAppendThenLaterResize++;
              continue;
            }
            const fault = rng();
            if (fault < 0.10) {
              coverage.crashAfterJournal++;
              crashed = true;
            } else if (fault < 0.20) {
              appendFileSync(indexFile, "{\"v\":1,\"n\":\"torn");
              coverage.tornSizeIndex++;
              crashed = true;
            } else if (fault < 0.30) {
              sizeIndex.append(resized.seq, current);
              coverage.crashAfterIndex++;
              crashed = true;
            } else if (fault < 0.45) {
              missedAppendOccurred = true;
              if (!opts.allowIndexAppendAfterMiss) sizeIndex.invalidate(resized.seq - 1);
              statusSize = current;
              persistStatus();
            } else {
              sizeIndex.append(resized.seq, current);
              statusSize = current;
              persistStatus();
            }
          }
        } else {
          const targetKind = rng();
          if (targetKind < 0.25) {
            await verifyCursor(0, true);
            coverage.reconnectAtZero++;
          } else if (targetKind < 0.65) {
            const pick = history[Math.floor(rng() * history.length)];
            for (const candidate of [pick.seq - 1, pick.seq, Math.min(journal.seq, pick.seq + 1)]) {
              await verifyCursor(candidate, true);
            }
            coverage.reconnectAtResizeBoundary++;
          } else {
            const mid = 1 + Math.floor(rng() * journal.seq);
            await verifyCursor(mid, true);
            coverage.reconnectMidStream++;
          }
        }
      }

      await verifyCursor(0, true);
      coverage.reconnectAtZero++;
      for (const entry of history) {
        for (const candidate of [entry.seq - 1, entry.seq, Math.min(journal.seq, entry.seq + 1)]) {
          await verifyCursor(candidate, true);
        }
      }
      coverage.reconnectAtResizeBoundary++;
      await verifyCursor(journal.seq, true);
      await verifyCursor(journal.seq, false);
      coverage.legacyNoIndex++;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return coverage;
}

test("seeded durable-state simulator verifies replay geometry across crashes, missed index appends, and broken mutants", { timeout: 35_000 }, async () => {
  const seeds = Array.from({ length: 24 }, (_, index) => 1001 + index);
  const coverage = await runDurableGeometrySimulation(resolveReplayTerminalSize, seeds);
  for (const [metric, count] of Object.entries(coverage)) {
    assert.ok(count > 0, `expected non-zero coverage for ${metric}, got ${count}`);
  }

  await assert.rejects(
    () => runDurableGeometrySimulation(resolveReplayTerminalSize, seeds, { allowIndexAppendAfterMiss: true }),
    "continuing to append to terminal-sizes.sealed after a missed append must fail reconnects between the missed and later resize",
  );

  const indexOnlyNoTailMutant: Resolver = async (readPage, after, options) => {
    if (after === 0) return resolveReplayTerminalSize(readPage, 0, options);
    let found: TerminalSize | undefined;
    for (const entry of options.index?.entries ?? []) if (entry.seq <= after) found = { cols: entry.cols, rows: entry.rows };
    return found ?? options.fallback;
  };
  await assert.rejects(
    () => runDurableGeometrySimulation(indexOnlyNoTailMutant, seeds),
    "index-only mutant without journal tail catch-up must fail on crash-after-journal and torn-size-index faults",
  );

  const finalSizeForZeroMutant: Resolver = async (readPage, after, options) => {
    if (after === 0) return options.fallback;
    return resolveReplayTerminalSize(readPage, after, options);
  };
  await assert.rejects(
    () => runDurableGeometrySimulation(finalSizeForZeroMutant, seeds),
    "using final status.sealed terminalSize for after=0 must fail after any resize",
  );

  const strictLessBoundaryMutant: Resolver = async (readPage, after, options) => {
    if (after === 0) return resolveReplayTerminalSize(readPage, 0, options);
    return resolveReplayTerminalSize(readPage, Math.max(0, after - 1), options);
  };
  await assert.rejects(
    () => runDurableGeometrySimulation(strictLessBoundaryMutant, seeds),
    "strict < boundary mutant must fail at exact resize seq boundaries",
  );

  const staleBoundedScanMutant: Resolver = async (readPage, after, options) => {
    if (after === 0) return resolveReplayTerminalSize(readPage, 0, options);
    let cursor = 0;
    let resolved: TerminalSize | undefined;
    for (let scanned = 0; scanned < 2 && cursor < after; scanned++) {
      const page = readPage(cursor, 200, new Set(["lifecycle"]));
      for (const event of page.events) {
        if (event.seq > after) return resolved ?? options.fallback;
        const size = terminalSizeFromEvent(event);
        if (size) resolved = size;
      }
      if (!page.more || page.cursor <= cursor) break;
      cursor = page.cursor;
    }
    return resolved ?? options.fallback;
  };
  await assert.rejects(async () => {
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
      const actual = await staleBoundedScanMutant(
        (after, limit, types) => readEvents(eventsDir, key, id, after, limit, types),
        tail.seq,
        {},
      );
      assert.deepEqual(actual, { cols: 84, rows: 24 });
      assert.ok(resized.seq < tail.seq);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, "bounded forward scan mutant must fail when output exceeds page budget before resize");
});
