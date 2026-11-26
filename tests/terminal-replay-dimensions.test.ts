import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { initialAttention } from "@infinite/attention";
import { hashToken } from "../packages/host/src/config.js";
import { workerCall } from "../packages/host/src/ipc.js";
import { Manager } from "../packages/host/src/manager.js";
import { connectTerminals, terminalPages } from "../packages/host/src/terminal-stream.js";
import { Journal, readEvents, unseal, writeSealed } from "../packages/host/src/vault.js";
import { waitFor } from "./helpers.js";
import type { Bootstrap, Config, ControlLease, Event, Receipt, TerminalOpen, TerminalSnapshot, WorkerRequest, WorkerState } from "../packages/host/src/types.js";

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
