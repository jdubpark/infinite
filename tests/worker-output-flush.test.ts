import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { workerCall, type WorkerError } from "../packages/host/src/ipc.js";
import { readEvents } from "../packages/host/src/vault.js";
import { waitFor } from "./helpers.js";
import type { Bootstrap, ControlLease, Event, Receipt, WorkerRequest, WorkerState } from "../packages/host/src/types.js";

const BURST = 4 * 1024 * 1024;
const AGENT = String.raw`
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdout.write("READY\r\n");
let pending = "";
process.stdin.on("data", data => {
  pending += data;
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
    const size = Number(pending.slice(0, end));
    pending = pending.slice(end + 1);
    let text = "";
    for (let row = 1; text.length < size; row++) text += "\x1b[3" + (row % 7 + 1) + "mROW " + row + " café 界 " + "lorem ipsum dolor sit amet ".repeat(3) + "\x1b[0m\r\n";
    process.stdout.write(text + "BURST DONE\r\n");
  }
});
`;

async function start(env: Record<string, string>) {
  const root = mkdtempSync("/tmp/inf-flush-");
  const id = randomUUID();
  const key = randomBytes(32);
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  const report = join(root, "journal-sync.json");
  mkdirSync(runDir);
  writeFileSync(join(root, "agent.mjs"), AGENT);
  const bootstrap: Bootstrap = {
    session: { id, provider: "demo", title: "Output flush", projectId: "fixture", cwd: root, createdAt: new Date().toISOString(), status: "starting", contextVersion: 0, context: "", initialPrompt: "", runtime: { id: randomUUID(), location: "cloud", transport: "pty" } },
    profile: { command: process.execPath, args: [join(root, "agent.mjs")] },
    runDir, stateDir, key: key.toString("base64"), prompt: "",
    attention: { idleAfterMs: 60_000, hooks: { claude: true, codex: true } },
  };
  const worker = spawn(process.execPath, ["--import", "tsx", resolve("packages/host/src/worker.ts")], {
    stdio: ["pipe", "ignore", "pipe"],
    env: {
      ...process.env, ...env, INFINITE_TEST_JOURNAL_SYNC_REPORT: report,
      NODE_OPTIONS: ["journal-sync.mjs", "terminal-drain.mjs"].map(file => `--import=${pathToFileURL(resolve("tests/fixtures", file)).href}`).join(" "),
    },
  });
  let diagnostics = "";
  worker.stderr.on("data", data => { diagnostics += data; });
  worker.stdin.end(JSON.stringify(bootstrap));
  const call = <T = WorkerState>(request: WorkerRequest, timeout?: number) => workerCall<T>(runDir, id, request, timeout);
  const output = () => {
    const events: Event[] = [];
    for (let cursor = 0, more = true; more;) {
      const page = readEvents(join(stateDir, "sessions", id, "events"), key, id, cursor, 200, new Set(["output"]));
      events.push(...page.events);
      cursor = page.cursor;
      more = page.more;
    }
    return events.map(event => String(event.data.text));
  };
  const stop = async (agent?: number) => {
    if (agent) try { process.kill(agent, "SIGKILL"); } catch {}
    try {
      const actor = { id: "test-cleanup", label: "Cleanup" };
      const lease = await call<ControlLease>({ op: "control", action: "claim", actor, takeover: true });
      await call({ op: "stop", requestId: randomUUID(), actor, leaseId: lease.id });
    } catch {}
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
  return {
    call, output, stop,
    burst: (size: number) => call<Receipt>({ op: "raw", requestId: randomUUID(), text: `${size}\n` }),
    synced: () => JSON.parse(readFileSync(report, "utf8")) as { synced: number; largest: number },
  };
}

test("a 4 MiB output burst on a slow journal disk is synced in bounded flushes while state calls answer within the host's timeout", { timeout: 150_000 }, async () => {
  const worker = await start({ INFINITE_TEST_JOURNAL_SYNC_DELAY_MS: "100" });
  try {
    await worker.burst(BURST);
    const failures: string[] = [];
    const until = Date.now() + 120_000;
    let screen = "";
    while (!screen.includes("BURST DONE") && !failures.length && Date.now() < until) {
      try { screen = (await worker.call({ op: "state", screen: true })).screen; }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(failures, []);
    assert.match(screen, /BURST DONE/);
    await waitFor(async () => worker.output().join("").includes("BURST DONE"), Boolean);
    const chunks = worker.output();
    assert.ok(chunks.join("").length > BURST, "the whole burst is recorded");
    assert.ok(chunks.every(text => text.length <= 8192), "output events keep their 8192-character chunks");
    assert.ok(worker.synced().largest > 1, "a flush syncs its output events together, not one at a time");
    assert.ok(worker.synced().largest <= 40, `one sync holds at most 256 Ki characters of output plus one read, not ${worker.synced().largest} events`);
  } finally {
    await worker.stop();
  }
});

test("a full snapshot queue on a slow journal disk is released in order while state calls answer between its flushes", { timeout: 150_000 }, async () => {
  const worker = await start({ INFINITE_TEST_JOURNAL_SYNC_DELAY_MS: "700", INFINITE_TEST_TERMINAL_DRAIN_DELAY_MS: "900" });
  try {
    await worker.burst(BURST);
    const failures: string[] = [];
    const until = Date.now() + 120_000;
    let screen = "", refused = 0;
    const running = () => !screen.includes("BURST DONE") && !failures.length && Date.now() < until;
    await Promise.all([
      (async () => {
        while (running()) {
          try { screen = (await worker.call({ op: "state", screen: true })).screen; }
          catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      })(),
      (async () => {
        while (running()) {
          try { await worker.call({ op: "snapshot" }, 60_000); }
          catch (error) {
            if ((error as WorkerError).code === "snapshot-unavailable") refused++;
            else failures.push(error instanceof Error ? error.message : String(error));
          }
        }
      })(),
    ]);
    assert.deepEqual(failures, []);
    assert.ok(refused > 0, "a snapshot's output queue filled before the renderer drained");
    await waitFor(async () => worker.output().join("").includes("BURST DONE"), Boolean);
    const rows = [...worker.output().join("").matchAll(/ROW (\d+) /g)].map(match => Number(match[1]));
    assert.ok(rows.length > 1000 && rows.every((row, index) => row === index + 1), "every row is recorded once, in order");
  } finally {
    await worker.stop();
  }
});

test("a failed journal sync during an output flush enters recording-error and reports none of that flush", { timeout: 40_000 }, async () => {
  const worker = await start({ INFINITE_TEST_JOURNAL_SYNC_FAIL: "1" });
  let agent: number | undefined;
  try {
    agent = (await worker.call({ op: "state" })).pid;
    await worker.burst(256 * 1024);
    const state = await waitFor(() => worker.call({ op: "state" }), state => state.status === "recording-error");
    assert.equal(state.seq, worker.synced().synced, "the worker reports only events whose sync succeeded");
  } finally {
    await worker.stop(agent);
  }
});
