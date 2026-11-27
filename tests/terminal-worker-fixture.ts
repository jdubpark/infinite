import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { workerCall } from "../packages/host/src/ipc.js";
import { readEvents, unseal } from "../packages/host/src/vault.js";
import { moveWorkerClock, waitFor } from "./helpers.js";
import type { Bootstrap, ControlLease, Event, Receipt, WorkerRequest, WorkerState } from "../packages/host/src/types.js";
import type { TeamAssignment } from "../packages/host/src/team-types.js";

export async function fixture(provider: "demo" | "claude" | "codex" = "demo", initialPrompt = "", team?: TeamAssignment) {
  const root = mkdtempSync(join(tmpdir(), "inf-worker-"));
  const id = randomUUID();
  const key = randomBytes(32);
  const runDir = join(root, "run");
  const stateDir = join(root, "state");
  const script = join(root, "agent.mjs");
  mkdirSync(runDir);
  copyFileSync(new URL("./fixtures/terminal-worker-agent.mjs", import.meta.url), script);
  const runtime = { id: randomUUID(), location: "cloud" as const, transport: "pty" as const };
  const bootstrap: Bootstrap = {
    session: { id, ...(team ? { team } : {}), executionIdentity: "production", provider, title: "Terminal contract", projectId: "fixture", cwd: root, createdAt: new Date().toISOString(), status: "starting", contextVersion: 0, context: "", initialPrompt, runtime },
    executionIdentity: "production", profile: { command: process.execPath, args: [script] },
    runDir, stateDir, key: key.toString("base64"), prompt: initialPrompt, codeMode: false,
    attention: { idleAfterMs: 60_000, limitConfirmMs: 30_000, hooks: { claude: true, codex: true } },
  };
  const worker = spawn(process.execPath, ["--import", "tsx", "--import", resolve("tests/fixtures/worker-clock.mjs"), resolve("packages/host/src/worker.ts")], { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, INFINITE_TEST_CLOCK_FILE: join(root, "clock") } });
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
      try { await call({ op: "stop", requestId: randomUUID() }); } catch { }
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
    }, state => Boolean(state?.screen.includes("READY")), 15_000);
  } catch (error) { await stop(); throw error; }
  return { id, root, stateDir, runDir, key, session: bootstrap.session, cwd: realpathSync(root), runtime, call, events, output, command, moveClock: (ms: number) => moveWorkerClock(worker, join(root, "clock"), ms), stop, persisted: () => unseal<WorkerState>(key, `${id}:status`, readFileSync(join(stateDir, "sessions", id, "status.sealed"), "utf8")) };
}

export async function fixtures(count: number, start: () => ReturnType<typeof fixture>) {
  const started = await Promise.allSettled(Array.from({ length: count }, start));
  const workers = started.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  const failure = started.find(result => result.status === "rejected");
  if (failure?.status === "rejected") {
    await Promise.all(workers.map(worker => worker.stop()));
    throw failure.reason;
  }
  return workers;
}
