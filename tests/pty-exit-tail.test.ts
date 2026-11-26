import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, constants, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn as ptySpawn } from "node-pty";
import { workerCall } from "../packages/host/src/ipc.js";
import { Manager } from "../packages/host/src/manager.js";
import { drainDescriptor } from "../packages/host/src/pty-tail.js";
import { terminalPages } from "../packages/host/src/terminal-stream.js";
import { readEvents, writeSealed } from "../packages/host/src/vault.js";
import { waitFor } from "./helpers.js";
import type { Bootstrap, Config, ControlLease, Event, Receipt, WorkerRequest, WorkerState } from "../packages/host/src/types.js";

const BURST = Array.from({ length: 96 }, (_, row) => `ROW ${row} `.padEnd(63, "x") + "\r").join("");
const AGENT = String.raw`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("READY\r\n");
process.stdin.once("data", command => {
  if (command === "quit") process.exit(0);
  if (command === "go") process.stdout.write(${JSON.stringify(BURST)} + "FINAL LINE\r\n", () => process.exit(0));
  if (command !== "hold") return;
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
  writeFileSync("holder.pid", String(holder.pid));
  holder.unref();
  process.stdout.write("HELD\r\n", () => process.exit(0));
});
`;

async function start(env: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "inf-tail-"));
  const id = randomUUID();
  const key = randomBytes(32);
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  mkdirSync(runDir);
  writeFileSync(join(root, "agent.mjs"), AGENT);
  const bootstrap: Bootstrap = {
    session: { id, provider: "demo", title: "Exit tail", projectId: "fixture", cwd: root, createdAt: new Date().toISOString(), status: "starting", contextVersion: 0, context: "", initialPrompt: "", runtime: { id: randomUUID(), location: "cloud", transport: "pty" } },
    profile: { command: process.execPath, args: [join(root, "agent.mjs")] },
    runDir, stateDir, key: key.toString("base64"), prompt: "",
    attention: { idleAfterMs: 60_000, hooks: { claude: true, codex: true } },
  };
  const worker = spawn(process.execPath, ["--import", "tsx", resolve("packages/host/src/worker.ts")], {
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, ...env, NODE_OPTIONS: `--import=${pathToFileURL(resolve("tests/fixtures/journal-sync.mjs")).href}` },
  });
  let diagnostics = "";
  worker.stderr.on("data", data => { diagnostics += data; });
  const ended = new Promise(resolve => worker.once("exit", resolve));
  worker.stdin.end(JSON.stringify(bootstrap));
  const call = <T = WorkerState>(request: WorkerRequest, timeout?: number) => workerCall<T>(runDir, id, request, timeout);
  const events = () => {
    const found: Event[] = [];
    for (let cursor = 0, more = true; more;) {
      const page = readEvents(join(stateDir, "sessions", id, "events"), key, id, cursor, 200, new Set(["output", "lifecycle"]));
      found.push(...page.events);
      cursor = page.cursor;
      more = page.more;
    }
    return found;
  };
  const exited = async () => (await waitFor(async () => events().find(event => event.type === "lifecycle" && event.data.status === "exited"), Boolean, 30_000))!;
  const stop = async () => {
    try {
      const actor = { id: "test-cleanup", label: "Cleanup" };
      const lease = await call<ControlLease>({ op: "control", action: "claim", actor, takeover: true });
      await call({ op: "stop", requestId: randomUUID(), actor, leaseId: lease.id });
    } catch {}
    if (worker.exitCode === null && worker.signalCode === null) await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 5000))]);
    worker.kill();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    await waitFor(async () => {
      try { return await call({ op: "state", screen: true }); }
      catch (error) { if (worker.exitCode !== null) throw new Error(diagnostics || String(error)); return undefined; }
    }, state => Boolean(state?.screen.includes("READY")), 30_000);
  } catch (error) { await stop(); throw error; }
  return {
    root, id, key, stateDir, runDir, session: bootstrap.session, events, exited, ended, stop,
    send: (text: string) => call<Receipt>({ op: "raw", requestId: randomUUID(), text }, 10_000),
  };
}

test("a provider that writes a burst and a final line and exits during a slow journal sync has all of it recorded before its exit", { timeout: 90_000 }, async () => {
  const worker = await start({ INFINITE_TEST_JOURNAL_SYNC_DELAY_MS: "700" });
  try {
    await worker.send("go");
    const exited = await worker.exited();
    const recorded = worker.events().filter(event => event.type === "output" && event.seq < exited.seq).map(event => String(event.data.text)).join("");
    assert.ok(recorded.endsWith(`${BURST}FINAL LINE\r\r\n`), `the recording before the exit ends with ${JSON.stringify(recorded.slice(-48))}`);
    assert.equal(exited.data.outputTailIncomplete, undefined, "a terminal read until it closed carries no marker");
  } finally {
    await worker.stop();
  }
});

test("a provider that exits with nothing left to read, so that the terminal reports its close as a read error, leaves no marker", { timeout: 60_000 }, async () => {
  const worker = await start({});
  try {
    await worker.send("quit");
    const exited = await worker.exited();
    assert.equal(exited.data.outputTailIncomplete, undefined);
  } finally {
    await worker.stop();
  }
});

test("an exit while another process still holds the terminal is marked as possibly missing its last output, in the journal and in the saved state that the terminal stream reports", { timeout: 90_000 }, async () => {
  const worker = await start({});
  let holder = 0;
  try {
    await worker.send("hold");
    holder = Number(await waitFor(async () => { try { return readFileSync(join(worker.root, "holder.pid"), "utf8"); } catch { return ""; } }, Boolean));
    const exited = await worker.exited();
    assert.equal(exited.data.outputTailIncomplete, true);
    await worker.ended;
    const keyFile = join(worker.root, "key");
    writeFileSync(keyFile, worker.key, { mode: 0o600 });
    writeSealed(join(worker.stateDir, "sessions", worker.id, "meta.sealed"), worker.key, `${worker.id}:meta`, { session: worker.session, fingerprint: "exit-tail-fixture" });
    const manager = new Manager({
      port: 0, origin: "http://127.0.0.1:0", stateDir: worker.stateDir, runDir: worker.runDir, keyFile, environment: "local",
      enableDemo: true, maxSessions: 4, tokens: [], projects: [], agents: {},
    } as Config, worker.key);
    let state: { status?: string; outputTailIncomplete?: true } | undefined;
    for await (const page of terminalPages(manager, worker.id, 0, new AbortController().signal)) {
      if ("state" in page && page.state) { state = page.state; break; }
    }
    assert.deepEqual({ status: state?.status, outputTailIncomplete: state?.outputTailIncomplete }, { status: "exited", outputTailIncomplete: true });
  } finally {
    if (holder) try { process.kill(holder, "SIGKILL"); } catch {}
    await worker.stop();
  }
});

test("the exit drain reads a descriptor to its end and tells a writer that closed from one that still holds it open", () => {
  const dir = mkdtempSync(join(tmpdir(), "inf-drain-"));
  const fifo = join(dir, "fifo");
  execFileSync("mkfifo", [fifo]);
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  const writer = openSync(fifo, constants.O_WRONLY);
  let writing = true;
  try {
    writeSync(writer, "HELD OPEN\n");
    const held = drainDescriptor(reader);
    assert.deepEqual({ text: held.data.toString(), closed: held.closed }, { text: "HELD OPEN\n", closed: false });
    writeSync(writer, "LAST LINE\n");
    closeSync(writer);
    writing = false;
    const ended = drainDescriptor(reader);
    assert.deepEqual({ text: ended.data.toString(), closed: ended.closed }, { text: "LAST LINE\n", closed: true });
  } finally {
    if (writing) closeSync(writer);
    closeSync(reader);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("node-pty keeps the terminal's read stream and a non-blocking descriptor where the exit drain reads them", { timeout: 30_000 }, async () => {
  const pty = ptySpawn(process.execPath, ["-e", "process.stdout.write('HELD\\r\\n'); setTimeout(() => {}, 30000)"], { cols: 80, rows: 24, name: "xterm-256color" });
  let seen = "";
  pty.onData(data => { seen += data; });
  try {
    const { _socket: socket, _fd: fd } = pty as unknown as { _socket?: unknown; _fd?: unknown };
    assert.ok(socket instanceof Socket, "node-pty's _socket is the terminal's read stream");
    assert.equal(typeof fd, "number", "node-pty's _fd is the terminal's descriptor");
    await waitFor(async () => seen, text => text.includes("HELD"));
    assert.equal(drainDescriptor(fd as number).closed, false, "a drain of a terminal that its process still holds returns without closing");
  } finally {
    pty.kill("SIGKILL");
  }
});
