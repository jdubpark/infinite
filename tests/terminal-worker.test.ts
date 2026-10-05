import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import headless from "@xterm/headless";
import { workerCall } from "../packages/host/src/ipc.js";
import { readEvents, unseal } from "../packages/host/src/vault.js";
import { waitFor } from "./helpers.js";
import type { Bootstrap, ControlActor, ControlLease, Event, Receipt, TerminalSnapshot, WorkerRequest, WorkerState } from "../packages/host/src/types.js";

// This process supplies actual PTY output and authenticated hooks. Assertions below use only
// worker IPC and its encrypted journal, never internal queues, timers, or a substituted clock.
const AGENT = String.raw`
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("READY\r\n\x1b[?2004h\x1b[?25l\x1b[?1006h");
let pending = "";
process.stdin.on("data", data => {
  pending += data;
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
    const command = pending.slice(0, end); pending = pending.slice(end + 1);
    if (command === "burst") {
      for (let i = 1; i <= 320; i++) process.stdout.write("\x1b[32mROW " + i + " café 界\x1b[0m\r\n");
    } else if (command === "split") process.stdout.write("\x1b[");
    else if (command === "finish") process.stdout.write("31mSPLIT COMPLETE\x1b[0m\r\n");
    else if (command === "alt") process.stdout.write("\x1b[?1049h\x1b[H\x1b[34mALTERNATE 界\x1b[0m\r\nNative prompt> ");
    else if (command === "leavealt") process.stdout.write("\x1b[?1049lBACK FROM ALTERNATE\r\n");
    else if (command === "reset") process.stdout.write("\x1bcRESET DONE\r\n");
    else if (command === "title") process.stdout.write("\x1b]0;Initial title\x07\x1b]1;Infinite icon\x1b\\\x1b]2;Infinite workspace\x07TITLE DONE\r\n");
    else if (command.startsWith("sgr ")) {
      const params = command.slice(4);
      process.stdout.write("\x1b[" + params + "mSTYLED TEXT\x1b[0mSGR DONE " + params + "\r\n");
    }
    else if (command.startsWith("osc ")) {
      const code = command.slice(4);
      const sequence = {
        8: "\x1b]8;;https://example.test/task\x07Task link\x1b]8;;\x07",
        4: "\x1b]4;1;rgb:11/22/33\x1b\\",
        10: "\x1b]10;rgb:11/22/33\x07",
        11: "\x1b]11;rgb:11/22/33\x07",
      }[code];
      process.stdout.write(sequence + "OSC DONE " + code + "\r\n");
    }
    else if (command === "stream") {
      let i = 0;
      const timer = setInterval(() => {
        process.stdout.write("LIVE " + (++i) + "\r\n");
        if (i === 150) { clearInterval(timer); process.stdout.write("STREAM DONE\r\n"); }
      }, 2);
    } else if (command.startsWith("hook ")) {
      const [, kind, id] = command.split(" ");
      fetch(process.env.INFINITE_HOOK_URL + "/" + (kind === "wrong" ? "codex" : "claude"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + (kind === "bad" ? "wrong-token" : process.env.INFINITE_HOOK_TOKEN) },
        body: JSON.stringify({ hook_event_name: "Stop", session_id: id, ...(kind === "agent" ? { agent_id: "subagent-1" } : {}) }),
      }).then(() => process.stdout.write("HOOK DONE " + kind + " " + id + "\r\n"));
    } else process.stdout.write("RECEIVED " + command + "\r\n");
  }
});
`;

async function fixture(provider: "demo" | "claude" = "demo", initialPrompt = "") {
  const root = mkdtempSync("/tmp/inf-worker-");
  const id = randomUUID();
  const key = randomBytes(32);
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  const script = join(root, "agent.mjs");
  mkdirSync(runDir);
  writeFileSync(script, AGENT);
  const runtime = { id: randomUUID(), location: "cloud" as const, transport: "pty" as const };
  const bootstrap: Bootstrap = {
    session: { id, provider, title: "Terminal contract", projectId: "fixture", cwd: root, createdAt: new Date().toISOString(), status: "starting", contextVersion: 0, context: "", initialPrompt, runtime },
    profile: { command: process.execPath, args: [script] },
    runDir, stateDir, key: key.toString("base64"), prompt: initialPrompt,
    attention: { idleAfterMs: 60_000, hooks: { claude: true, codex: true } },
  };
  const worker = spawn(process.execPath, ["--import", "tsx", resolve("packages/host/src/worker.ts")], { stdio: ["pipe", "ignore", "pipe"] });
  let diagnostics = "";
  worker.stderr.on("data", data => { diagnostics += data; });
  worker.stdin.end(JSON.stringify(bootstrap));
  const call = <T = WorkerState>(request: WorkerRequest) => workerCall<T>(runDir, id, request, 6000);
  const events = () => {
    const out: Event[] = [];
    let cursor = 0;
    for (;;) {
      const page = readEvents(join(stateDir, "sessions", id, "events"), key, id, cursor);
      out.push(...page.events); cursor = page.cursor;
      if (!page.more) return out;
    }
  };
  const output = () => events().filter(event => event.type === "output").map(event => String(event.data.text)).join("");
  const command = (text: string) => call<Receipt>({ op: "raw", requestId: randomUUID(), text: text + "\n" });
  const stop = async () => {
    try {
      const actor = { id: "test-cleanup", label: "Cleanup" };
      const lease = await call<ControlLease>({ op: "control", action: "claim", actor, takeover: true });
      await call({ op: "stop", requestId: randomUUID(), actor, leaseId: lease.id });
    } catch {
      try { await call({ op: "stop", requestId: randomUUID() }); } catch { /* already stopped */ }
    }
    if (worker.exitCode === null && worker.signalCode === null)
      await Promise.race([new Promise(resolve => worker.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3500))]);
    worker.kill();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await waitFor(async () => {
      try { return await call({ op: "state", screen: true }); }
      catch (error) { if (worker.exitCode !== null) throw new Error(diagnostics || String(error)); return undefined; }
    }, state => Boolean(state?.screen.includes("READY")));
  } catch (error) { await stop(); throw error; }
  return { id, runtime, call, events, output, command, stop, persisted: () => unseal<WorkerState>(key, `${id}:status`, readFileSync(join(stateDir, "sessions", id, "status.sealed"), "utf8")) };
}

function terminalImage(terminal: headless.Terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buffer.length - 200); i < buffer.length; i++) {
    const line = buffer.getLine(i)!;
    const cells = [];
    for (let col = 0; col < terminal.cols; col++) {
      const cell = line.getCell(col)!;
      cells.push([cell.getChars(), cell.getWidth(), cell.getFgColor(), cell.getBgColor(), cell.isBold()]);
    }
    lines.push(cells);
  }
  return { lines, cursorX: buffer.cursorX, cursorY: buffer.cursorY, type: buffer.type, modes: terminal.modes };
}

test("worker snapshots restore a bounded rendered prefix and contiguous live deltas; split escapes fall back", { timeout: 25_000 }, async () => {
  const worker = await fixture("demo", "Prepare a build");
  const terminals: headless.Terminal[] = [];
  try {
    const initial = await worker.call({ op: "state" });
    assert.equal(initial.status, "running");
    assert.equal(initial.attention.state, "working");
    assert.notEqual(initial.attention.now, "Starting", "a running process must not keep the startup summary");
    await worker.command("burst");
    await waitFor(async () => worker.output(), output => output.includes("ROW 320"));
    const first = await worker.call<TerminalSnapshot>({ op: "snapshot" });
    assert.match(first.ansi, /ROW 320/);
    assert.doesNotMatch(first.ansi, /ROW 1 café/);
    assert.match(first.ansi, /\x1b\[\?25l/);
    assert.match(first.ansi, /\x1b\[\?1006h/);

    await worker.command("split");
    await waitFor(async () => worker.output(), output => output.endsWith("\x1b["));
    await assert.rejects(worker.call({ op: "snapshot" }), { code: "snapshot-unavailable" });
    await worker.command("finish");
    await waitFor(async () => worker.output(), output => output.includes("SPLIT COMPLETE"));

    await worker.command("stream");
    await waitFor(async () => worker.output(), output => output.includes("LIVE 10"));
    const snapshot = await worker.call<TerminalSnapshot>({ op: "snapshot" });
    await waitFor(async () => worker.output(), output => output.includes("STREAM DONE"));
    const events = worker.events();
    const deltas = events.filter(event => event.seq > snapshot.seq && event.type === "output");
    assert.ok(deltas.length > 0, "output continued after the snapshot fence");
    assert.ok(events.filter(event => event.seq <= snapshot.seq && event.type === "output").map(event => String(event.data.text)).join("").includes("LIVE 10"));
    const replay = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 5000, allowProposedApi: true });
    const restored = new headless.Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 5000, allowProposedApi: true });
    terminals.push(replay, restored);
    await new Promise<void>(resolve => replay.write(events.filter(event => event.type === "output").map(event => String(event.data.text)).join(""), resolve));
    await new Promise<void>(resolve => restored.write(snapshot.ansi + deltas.map(event => String(event.data.text)).join(""), resolve));
    assert.deepEqual(terminalImage(restored), terminalImage(replay));

    await worker.command("alt");
    await waitFor(async () => worker.output(), output => output.includes("ALTERNATE 界"));
    const alternate = await worker.call<TerminalSnapshot>({ op: "snapshot" });
    const altReplay = new headless.Terminal({ cols: alternate.cols, rows: alternate.rows, scrollback: 5000, allowProposedApi: true });
    const altRestored = new headless.Terminal({ cols: alternate.cols, rows: alternate.rows, scrollback: 5000, allowProposedApi: true });
    terminals.push(altReplay, altRestored);
    await new Promise<void>(resolve => altReplay.write(worker.events().filter(event => event.type === "output").map(event => String(event.data.text)).join(""), resolve));
    await new Promise<void>(resolve => altRestored.write(alternate.ansi, resolve));
    assert.equal(altRestored.buffer.active.type, "alternate");
    assert.deepEqual(terminalImage(altRestored), terminalImage(altReplay));
    await worker.command("leavealt");
    await waitFor(async () => worker.output(), output => output.includes("BACK FROM ALTERNATE"));
    const leave = worker.events().filter(event => event.seq > alternate.seq && event.type === "output").map(event => String(event.data.text)).join("");
    await new Promise<void>(resolve => altReplay.write(leave, resolve));
    await new Promise<void>(resolve => altRestored.write(leave, resolve));
    assert.equal(altRestored.buffer.active.type, "normal");
    assert.deepEqual(terminalImage(altRestored), terminalImage(altReplay));
  } finally { terminals.forEach(terminal => terminal.dispose()); await worker.stop(); }
});

test("worker snapshots preserve titles and refuse unhandled OSC or extended SGR state across resets", { timeout: 35_000 }, async () => {
  const unsupported = [
    ...["4:3", "4:2", "21", "4;58;2;11;22;33"].map(code => ({ kind: "sgr", code })),
    ...["8", "4", "10", "11"].map(code => ({ kind: "osc", code })),
  ];
  for (const { kind, code } of unsupported) {
    const worker = await fixture();
    try {
      await worker.command(`${kind} ${code}`);
      await waitFor(async () => worker.output(), output => output.includes(`${kind.toUpperCase()} DONE ${code}`));
      await assert.rejects(worker.call({ op: "snapshot" }), { code: "snapshot-unavailable" }, `${kind.toUpperCase()} ${code} state cannot be restored by the cell serializer`);
      await worker.command("reset");
      await waitFor(async () => worker.output(), output => output.includes("RESET DONE"));
      await assert.rejects(worker.call({ op: "snapshot" }), { code: "snapshot-unavailable" }, "unsupported styling keeps the worker on full replay");
    } finally { await worker.stop(); }
  }
  const worker = await fixture();
  const restored = new headless.Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  let title = "";
  restored.onTitleChange(value => { title = value; });
  try {
    // Components equal to extended SGR codes are ordinary RGB data, not underline settings.
    await worker.command("sgr 38;2;21;58;59;48:2::58:21:59");
    await waitFor(async () => worker.output(), output => output.includes("SGR DONE 38;2;21;58;59;48:2::58:21:59"));
    await worker.command("title");
    await waitFor(async () => worker.output(), output => output.includes("TITLE DONE"));
    const snapshot = await worker.call<TerminalSnapshot>({ op: "snapshot" });
    await new Promise<void>(resolve => restored.write(snapshot.ansi, resolve));
    assert.equal(title, "Infinite workspace");
    assert.match(snapshot.ansi, /\x1b\]1;Infinite icon(?:\x07|\x1b\\)/);
  } finally { restored.dispose(); await worker.stop(); }
});

test("worker control fences input and resize, keeps retry receipts stable, and releases expired control", { timeout: 45_000 }, async () => {
  const worker = await fixture();
  const a: ControlActor = { id: "laptop", label: "Laptop" };
  const b: ControlActor = { id: "phone", label: "Phone" };
  try {
    const before = await worker.call({ op: "state" });
    const firstLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: a });
    const leaseA = await worker.call<ControlLease>({ op: "control", action: "claim", actor: a });
    assert.notEqual(leaseA.id, firstLease.id, "same-device reconnect fences its previous socket");
    await assert.rejects(worker.call({ op: "raw", requestId: randomUUID(), text: "old socket\n", actor: a, leaseId: firstLease.id }), { code: "control-lost" });
    await assert.rejects(worker.call({ op: "control", action: "claim", actor: b }), { code: "control-busy" });
    await assert.rejects(worker.command("unclaimed"), { code: "control-busy" });
    await assert.rejects(worker.call({ op: "raw", requestId: randomUUID(), text: "unleased\n", actor: a }), { code: "control-busy" });
    const input = { op: "raw" as const, requestId: randomUUID(), text: "once\n" };
    const receipt = await worker.call<Receipt>({ ...input, actor: a, leaseId: leaseA.id });
    const leaseB = await worker.call<ControlLease>({ op: "control", action: "claim", actor: b, takeover: true });
    assert.notEqual(leaseB.id, leaseA.id);
    for (const action of ["renew", "release"] as const)
      await assert.rejects(worker.call({ op: "control", action, actor: a, leaseId: leaseA.id }), { code: "control-lost" });
    await assert.rejects(worker.call({ op: "raw", requestId: randomUUID(), text: "stale\n", actor: a, leaseId: leaseA.id }), { code: "control-lost" });
    await assert.rejects(worker.call({ op: "resize", cols: 77, rows: 17, actor: a, leaseId: leaseA.id }), { code: "control-lost" });
    const unchangedSize = await worker.call<TerminalSnapshot>({ op: "snapshot" });
    assert.deepEqual([unchangedSize.cols, unchangedSize.rows], [120, 32]);
    const repeated = await worker.call<Receipt>({ ...input, actor: b, leaseId: leaseB.id });
    assert.equal(repeated.seq, receipt.seq);
    await waitFor(async () => worker.output(), output => output.includes("RECEIVED once"));
    assert.equal(worker.output().split("RECEIVED once").length - 1, 1);
    assert.equal(worker.events().filter(event => event.type === "input-intent").length, 1, "refusals and receipt retries do not journal another delivery");
    await worker.call({ op: "resize", cols: 88, rows: 26, actor: b, leaseId: leaseB.id });
    const resized = await worker.call<TerminalSnapshot>({ op: "snapshot" });
    assert.deepEqual([resized.cols, resized.rows], [88, 26]);
    await worker.call({ op: "control", action: "release", actor: b, leaseId: leaseB.id });
    await worker.command("released");
    const lease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: a });
    const observing = await worker.call({ op: "state" });
    assert.deepEqual(observing.runtime, worker.runtime);
    assert.equal(observing.pid, before.pid);
    assert.deepEqual(observing.control, { id: lease.id, label: a.label, expiresAt: lease.expiresAt });
    assert.deepEqual(worker.persisted().runtime, worker.runtime);
    // The real lease deadline is intentional: observers must not keep a disconnected owner alive.
    await new Promise(resolve => setTimeout(resolve, lease.expiresAt - Date.now() + 60));
    assert.equal((await worker.call({ op: "state" })).control, null);
    await assert.rejects(worker.call({ op: "raw", requestId: randomUUID(), text: "expired\n", actor: a, leaseId: lease.id }), { code: "control-lost" });
    await worker.command("after expiry");
    await waitFor(async () => worker.output(), output => output.includes("RECEIVED after expiry"));
    assert.doesNotMatch(worker.output(), /RECEIVED (stale|expired|unclaimed|unleased)/);
  } finally { await worker.stop(); }
});

test("native conversation identity comes only from authenticated matching provider hooks", { timeout: 15_000 }, async () => {
  const worker = await fixture("claude");
  try {
    for (const kind of ["bad", "wrong", "agent"]) {
      await worker.command(`hook ${kind} unrelated-thread`);
      await waitFor(async () => worker.output(), output => output.includes(`HOOK DONE ${kind} unrelated-thread`));
      assert.equal((await worker.call({ op: "state" })).nativeSession, undefined);
    }
    await worker.command("hook main native-main");
    const identified = await waitFor(() => worker.call({ op: "state" }), state => state.nativeSession?.id === "native-main");
    assert.deepEqual(identified.nativeSession, { id: "native-main", source: "hook" });
    await worker.command("hook agent child-thread");
    await waitFor(async () => worker.output(), output => output.includes("HOOK DONE agent child-thread"));
    assert.deepEqual((await worker.call({ op: "state" })).nativeSession, identified.nativeSession);
    assert.deepEqual(worker.persisted().nativeSession, identified.nativeSession);
    assert.deepEqual(worker.persisted().runtime, worker.runtime);
  } finally { await worker.stop(); }
});
