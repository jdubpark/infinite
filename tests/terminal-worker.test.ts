import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import headless from "@xterm/headless";
import { WebSocket } from "ws";
import { hashToken } from "../packages/host/src/config.js";
import { workerCall } from "../packages/host/src/ipc.js";
import { Manager } from "../packages/host/src/manager.js";
import { connectTerminals, terminalPages } from "../packages/host/src/terminal-stream.js";
import { readEvents, unseal, writeSealed } from "../packages/host/src/vault.js";
import { permissionEvidenceHash, oneShotPermissionOption } from "../packages/host/src/team-permissions.js";
import { requesterNotice } from "../packages/host/src/permission-policy.js";
import { moveWorkerClock, settleAll, waitFor } from "./helpers.js";
import type { Bootstrap, Config, ControlActor, ControlLease, Event, Receipt, TerminalSnapshot, WorkerRequest, WorkerState } from "../packages/host/src/types.js";
import type { TeamAssignment } from "../packages/host/src/team-types.js";

async function fixture(provider: "demo" | "claude" | "codex" = "demo", initialPrompt = "", team?: TeamAssignment) {
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

async function fixtures(count: number, start: () => ReturnType<typeof fixture>) {
  const started = await Promise.allSettled(Array.from({ length: count }, start));
  const workers = started.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  const failure = started.find(result => result.status === "rejected");
  if (failure?.status === "rejected") {
    await Promise.all(workers.map(worker => worker.stop()));
    throw failure.reason;
  }
  return workers;
}

async function dialogHold() {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((_request, response) => {
    arrive();
    void released.then(() => response.end());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
    reached: (answer: Promise<unknown>) => Promise.race([arrived, answer.then(() => { throw new Error("The answer ended before its first key reached the dialog"); })]),
    release,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}
type DialogHold = Awaited<ReturnType<typeof dialogHold>>;

function teamAnswerRequest(worker: Awaited<ReturnType<typeof fixture>>, team: TeamAssignment, prompt: NonNullable<WorkerState["attention"]["prompt"]>, requestId: string, actor: ControlActor, leaseId: string, decisionId: string) {
  const option = oneShotPermissionOption(prompt);
  assert.equal(option, 1, "the fixture exposes one explicit one-shot option");
  return {
    op: "team-answer" as const, requestId, decisionId,
    coordinatorMemberId: randomUUID(), targetSessionId: worker.id,
    assignment: team, targetCwd: worker.cwd,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    policyHash: "a".repeat(64), promptId: prompt.id,
    promptHash: prompt.hash!, evidenceHash: permissionEvidenceHash(prompt),
    option, actor, leaseId,
  };
}

function teamPermissionExpansionRequest(
  worker: Awaited<ReturnType<typeof fixture>>,
  team: TeamAssignment,
  prompt: NonNullable<WorkerState["attention"]["prompt"]>,
  requestId: string,
  actor: ControlActor,
  leaseId: string,
) {
  return {
    op: "team-permission-expand" as const,
    requestId,
    targetSessionId: worker.id,
    assignment: team,
    expected: {
      promptId: prompt.id,
      promptHash: prompt.hash!,
      evidenceHash: permissionEvidenceHash(prompt),
      targetCwd: worker.cwd,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    actor,
    leaseId,
  };
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

const unsupportedSnapshotStates = [
  ...["4:3", "4:2", "21", "4;58;2;11;22;33"].map(code => ({ kind: "sgr", code })),
  ...["8", "4", "10", "11"].map(code => ({ kind: "osc", code })),
];

for (const { kind, code } of unsupportedSnapshotStates) test(`worker snapshots refuse ${kind.toUpperCase()} ${code} state across resets`, { timeout: 35_000 }, async () => {
  const worker = await fixture();
  try {
    await worker.command(`${kind} ${code}`);
    await waitFor(async () => worker.output(), output => output.includes(`${kind.toUpperCase()} DONE ${code}`));
    await assert.rejects(worker.call({ op: "snapshot" }), { code: "snapshot-unavailable" }, `${kind.toUpperCase()} ${code} state cannot be restored by the cell serializer`);
    await worker.command("reset");
    await waitFor(async () => worker.output(), output => output.includes("RESET DONE"));
    await assert.rejects(worker.call({ op: "snapshot" }), { code: "snapshot-unavailable" }, "unsupported styling keeps the worker on full replay");
  } finally { await worker.stop(); }
});

test("worker snapshots preserve titles and icons after supported RGB styling", { timeout: 35_000 }, async () => {
  const worker = await fixture();
  const restored = new headless.Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  let title = "";
  restored.onTitleChange(value => { title = value; });
  try {
    await worker.command("reset");
    await waitFor(async () => worker.output(), output => output.includes("RESET DONE"));
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
    const renewedWithLegacyFlag = await worker.call<ControlLease>({ op: "control", action: "renew", actor: b, leaseId: leaseB.id, takeover: false } as unknown as WorkerRequest);
    assert.equal(renewedWithLegacyFlag.id, leaseB.id);
    await assert.rejects(worker.call({ op: "control", action: "claim", actor: b, leaseId: "" }), /Invalid session control/);
    for (const action of ["renew", "release"] as const)
      await assert.rejects(worker.call({ op: "control", action, actor: b } as unknown as WorkerRequest), { code: "control-lost" });
    await assert.rejects(worker.call({ op: "control", action: "renew", actor: b, leaseId: leaseB.id, takeover: true } as unknown as WorkerRequest), /Invalid session control/);
    await assert.rejects(worker.call({ op: "workspace-export", method: "sync/unknown" } as unknown as WorkerRequest), { code: "unsupported" });
    await assert.rejects(worker.call({ op: "workspace-export", method: "sync/blob", hash: "A".repeat(64) } as unknown as WorkerRequest), /Invalid workspace export request/);
    await assert.rejects(worker.call({ op: "workspace-export", method: "sync/export", extra: true } as unknown as WorkerRequest), /Invalid workspace export request/);
    await assert.rejects(worker.call({ op: "workspace-export", method: "sync/blob" } as unknown as WorkerRequest), /A content hash is required/);
    await assert.rejects(worker.call({ op: "workspace-export", method: "sync/export" }), { code: "unsupported" });
    await worker.call({ op: "control", action: "release", actor: b, leaseId: leaseB.id, takeover: false } as unknown as WorkerRequest);
    await worker.command("released");
    const lease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: a });
    const observing = await worker.call({ op: "state" });
    assert.deepEqual(observing.runtime, worker.runtime);
    assert.equal(observing.pid, before.pid);
    assert.deepEqual(observing.control, { id: lease.id, label: a.label, expiresAt: lease.expiresAt });
    assert.deepEqual(worker.persisted().runtime, worker.runtime);
    await worker.moveClock(lease.expiresAt - Date.now() + 60);
    assert.equal((await worker.call({ op: "state" })).control, null);
    await assert.rejects(worker.call({ op: "raw", requestId: randomUUID(), text: "expired\n", actor: a, leaseId: lease.id }), { code: "control-lost" });
    await worker.command("after expiry");
    await waitFor(async () => worker.output(), output => output.includes("RECEIVED after expiry"));
    assert.doesNotMatch(worker.output(), /RECEIVED (stale|expired|unclaimed|unleased)/);
  } finally { await worker.stop(); }
});

test("team permission expansion is Codex-only, bound to the live collapsed prompt, and delivered once", { timeout: 30_000 }, async () => {
  const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer", taskId: "task-expand" };
  const worker = await fixture("codex", "", team);
  try {
    await worker.command("collapsed-permission");
    const open = await waitFor(() => worker.call({ op: "state" }), state =>
      state.attention.state === "needs-you" && state.attention.prompt?.source === "screen" &&
      Boolean(state.attention.prompt.hash && state.attention.prompt.pinned));
    const prompt = open.attention.prompt!;
    const expansionIntents = () => worker.events().filter(event => event.type === "input-intent" && event.data.op === "team-permission-expand");
    const requestFor = (requestId: string) => {
      const actor = { id: `team-permission-expand:${requestId}`, label: "Team permission display expansion" };
      return { actor, request: teamPermissionExpansionRequest(worker, team, prompt, requestId, actor, "lease-not-yet-held") };
    };

    const human = { id: "human-expansion-control", label: "Human" };
    const humanLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: human });
    const blocked = requestFor(randomUUID());
    await assert.rejects(worker.call(blocked.request), { code: "control-lost" });
    assert.equal(expansionIntents().length, 0, "a human lease refuses before any durable intent or key");
    await worker.call({ op: "control", action: "release", actor: human, leaseId: humanLease.id });

    const stale = requestFor(randomUUID());
    const staleLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: stale.actor });
    await assert.rejects(worker.call({ ...stale.request, leaseId: staleLease.id, expected: { ...stale.request.expected, promptHash: "0".repeat(64) } }), { code: "prompt-changed" });
    await worker.call({ op: "control", action: "release", actor: stale.actor, leaseId: staleLease.id });

    const changedAssignment = requestFor(randomUUID());
    const changedLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: changedAssignment.actor });
    await assert.rejects(worker.call({ ...changedAssignment.request, leaseId: changedLease.id, assignment: { ...team, memberId: randomUUID() } }), { code: "unsupported" });
    await worker.call({ op: "control", action: "release", actor: changedAssignment.actor, leaseId: changedLease.id });
    assert.equal(expansionIntents().length, 0, "stale evidence and a different team assignment never write an intent");

    const valid = requestFor(randomUUID());
    const hostLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: valid.actor });
    const request = { ...valid.request, leaseId: hostLease.id };
    const delivered = await worker.call<Receipt>(request);
    assert.equal(delivered.state, "delivered");
    assert.equal(expansionIntents().length, 1);
    await waitFor(async () => worker.output(), output => output.includes("EXPANDED ONCE 1"));
    const expanded = await waitFor(() => worker.call({ op: "state" }), state =>
      state.attention.state === "needs-you" && state.attention.prompt?.id !== prompt.id &&
      state.attention.prompt?.hash !== prompt.hash && state.attention.prompt?.pinned === true);
    assert.equal(expanded.attention.prompt?.source, "screen");
    assert.equal(oneShotPermissionOption(expanded.attention.prompt!), 0,
      "review uses the fresh expanded screen prompt, whose identity differs from the collapsed prompt");
    const repeated = await worker.call<Receipt>(request);
    assert.deepEqual(repeated, delivered, "a request replay returns its durable receipt without toggling again");
    await assert.rejects(worker.call({ ...request, expected: { ...request.expected, expiresAt: new Date(Date.now() + 90_000).toISOString() } }), /different input/);
    assert.equal(expansionIntents().length, 1);
    assert.equal(worker.output().match(/EXPANDED ONCE/g)?.length, 1);
    assert.doesNotMatch(worker.output(), /COLLAPSED ENTER RECEIVED/);
    assert.doesNotMatch(worker.output(), /APPROVED/);
    assert.equal(worker.events().some(event => event.type === "input-result" && event.data.requestId === request.requestId && event.data.op === "team-permission-expand"), true);
    await worker.call({ op: "control", action: "release", actor: valid.actor, leaseId: hostLease.id });
  } finally { await worker.stop(); }

  const otherProvider = await fixture("demo", "", team);
  try {
    const requestId = randomUUID();
    const actor = { id: `team-permission-expand:${requestId}`, label: "Team permission display expansion" };
    const expected = {
      promptId: 1, promptHash: "a".repeat(64), evidenceHash: "b".repeat(64),
      targetCwd: otherProvider.cwd, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await assert.rejects(otherProvider.call({
      op: "team-permission-expand", requestId, targetSessionId: otherProvider.id,
      assignment: team, expected, actor, leaseId: "no-lease",
    }), { code: "unsupported" });
    assert.equal(otherProvider.events().some(event => event.type === "input-intent" && event.data.op === "team-permission-expand"), false,
      "a non-Codex worker cannot receive the display key");
  } finally { await otherProvider.stop(); }
});

test("delegated answers stay bound to the assigned one-shot prompt and stop after a control takeover", { timeout: 30_000 }, async () => {
  const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer", taskId: "task-one" };
  const decisionId = randomUUID();
  const actor = { id: `team-permission:${decisionId}`, label: "Team permission" };
  const workers = await fixtures(3, () => fixture("demo", "", team));
  const [worker, takeoverWorker, invalidationWorker] = workers;
  let takeoverHold: DialogHold | undefined;
  let invalidationHold: DialogHold | undefined;
  try {
    {
      await worker.command("permission");
      const open = await waitFor(() => worker.call({ op: "state" }), state => state.attention.state === "needs-you" && Boolean(state.attention.prompt?.hash && state.attention.prompt.tool?.name));
      const prompt = open.attention.prompt!;
      const lease = await worker.call<ControlLease>({ op: "control", action: "claim", actor });
      const stale = { ...teamAnswerRequest(worker, team, prompt, randomUUID(), actor, lease.id, decisionId), promptHash: "0".repeat(64) };
      await assert.rejects(worker.call(stale), { code: "prompt-changed" });
      const staleEvidence = { ...teamAnswerRequest(worker, team, prompt, randomUUID(), actor, lease.id, decisionId), evidenceHash: "0".repeat(64) };
      await assert.rejects(worker.call(staleEvidence), { code: "prompt-changed" });
      const wrongTarget = { ...teamAnswerRequest(worker, team, prompt, randomUUID(), actor, lease.id, decisionId), assignment: { ...team, memberId: randomUUID() } };
      await assert.rejects(worker.call(wrongTarget), { code: "unsupported" });
      const wrongSession = { ...teamAnswerRequest(worker, team, prompt, randomUUID(), actor, lease.id, decisionId), targetSessionId: randomUUID() };
      await assert.rejects(worker.call(wrongSession), /Invalid delegated answer request/);
      const wrongCwd = { ...teamAnswerRequest(worker, team, prompt, randomUUID(), actor, lease.id, decisionId), targetCwd: `${worker.cwd}/other` };
      await assert.rejects(worker.call(wrongCwd), { code: "unsupported" });
      for (const assignment of [null, [], {}]) {
        const malformed = { ...teamAnswerRequest(worker, team, prompt, randomUUID(), actor, lease.id, decisionId), assignment } as unknown as WorkerRequest;
        await assert.rejects(worker.call(malformed), /Invalid delegated answer request/);
      }
      const answerIntents = () => worker.events().filter(event => event.type === "input-intent" && event.data.op === "answer");
      assert.equal(answerIntents().length, 0, "stale hashes and foreign assignments never journal or type an answer");

      const valid = teamAnswerRequest(worker, team, prompt, randomUUID(), actor, lease.id, decisionId);
      const answer = await worker.call<Receipt & { result?: string }>(valid);
      assert.equal(answer.state, "delivered");
      assert.equal(answer.result, "closed");
      assert.equal(answerIntents().length, 1);
      const again = await worker.call<Receipt & { result?: string }>(valid);
      assert.deepEqual(again, answer);
      assert.equal(answerIntents().length, 1, "receipt replay does not type the permission twice");
      const intent = answerIntents()[0];
      assert.equal((intent.data.delegation as { decisionId: string }).decisionId, valid.decisionId);
      assert.equal(worker.output().match(/APPROVED/g)?.length, 1);
    }

    {
      takeoverHold = await dialogHold();
      await takeoverWorker.command(`permission ${takeoverHold.url}`);
      const open = await waitFor(() => takeoverWorker.call({ op: "state" }), state => state.attention.state === "needs-you" && Boolean(state.attention.prompt?.hash && state.attention.prompt.tool?.name));
      const human = { id: "human-control", label: "Human" };
      const humanLease = await takeoverWorker.call<ControlLease>({ op: "control", action: "claim", actor: human });
      await assert.rejects(takeoverWorker.call({ op: "control", action: "claim", actor }), { code: "control-busy" });
      await takeoverWorker.call({ op: "control", action: "release", actor: human, leaseId: humanLease.id });
      const hostLease = await takeoverWorker.call<ControlLease>({ op: "control", action: "claim", actor });
      const request = teamAnswerRequest(takeoverWorker, team, open.attention.prompt!, randomUUID(), actor, hostLease.id, decisionId);
      const pending = takeoverWorker.call(request);
      await takeoverHold.reached(pending);
      const takeover = await takeoverWorker.call<ControlLease>({ op: "control", action: "claim", actor: human, takeover: true });
      takeoverHold.release();
      const interrupted = await pending as Receipt & { result?: string };
      assert.equal(interrupted.state, "uncertain");
      assert.equal(interrupted.result, undefined);
      assert.equal((await takeoverWorker.call({ op: "state" })).control?.id, takeover.id);
      const repeated = await takeoverWorker.call<Receipt & { result?: string }>(request);
      assert.equal(repeated.state, "uncertain");
      assert.equal(takeoverWorker.events().filter(event => event.type === "input-intent" && event.data.requestId === request.requestId).length, 1);
      assert.equal(takeoverWorker.events().filter(event => event.type === "input-result" && event.data.requestId === request.requestId).length, 0);
      assert.doesNotMatch(takeoverWorker.output(), /APPROVED/);
    }

    {
      invalidationHold = await dialogHold();
      await invalidationWorker.command(`permission ${invalidationHold.url}`);
      const open = await waitFor(() => invalidationWorker.call({ op: "state" }), state => state.attention.state === "needs-you" && Boolean(state.attention.prompt?.hash && state.attention.prompt.tool?.name));
      const hostLease = await invalidationWorker.call<ControlLease>({ op: "control", action: "claim", actor });
      const request = teamAnswerRequest(invalidationWorker, team, open.attention.prompt!, randomUUID(), actor, hostLease.id, decisionId);
      const pending = invalidationWorker.call<Receipt & { result?: string }>(request);
      await invalidationHold.reached(pending);
      assert.deepEqual(await invalidationWorker.call({ op: "team-answer-invalidate", decisionId }), { invalidated: true });
      invalidationHold.release();
      const interrupted = await pending;
      assert.equal(interrupted.state, "uncertain");
      assert.equal(interrupted.result, undefined);
      assert.equal(invalidationWorker.events().filter(event => event.type === "input-result" && event.data.requestId === request.requestId).length, 0);
      assert.doesNotMatch(invalidationWorker.output(), /APPROVED/);
      const afterInvalidation = await invalidationWorker.call({ op: "state", screen: true });
      assert.equal(afterInvalidation.attention.prompt?.id, open.attention.prompt?.id);
      assert.equal(afterInvalidation.attention.state, "needs-you");
      assert.equal(afterInvalidation.control, null);
      await assert.rejects(invalidationWorker.call({ ...request, requestId: randomUUID() }), { code: "unsupported" });
    }
  } finally {
    takeoverHold?.close();
    invalidationHold?.close();
    await Promise.all(workers.map(started => started.stop()));
  }
});

function sessionAnswerRequest(worker: Awaited<ReturnType<typeof fixture>>, prompt: NonNullable<WorkerState["attention"]["prompt"]>, actor: ControlActor, leaseId: string, decisionId: string, option: number) {
  return {
    op: "session-permission-answer" as const, requestId: randomUUID(), decisionId, targetSessionId: worker.id, targetCwd: worker.cwd,
    promptId: prompt.id, promptHash: prompt.hash!, evidenceHash: permissionEvidenceHash(prompt), option, actor, leaseId,
  };
}

test("a session permission answer types one recognised option outside any run, only under the host's own lease", { timeout: 40_000 }, async () => {
  const decisionId = randomUUID();
  const actor = { id: `session-permission:${decisionId}`, label: "Session permission" };
  const opened = (worker: Awaited<ReturnType<typeof fixture>>) => waitFor(() => worker.call({ op: "state" }),
    state => state.attention.state === "needs-you" && Boolean(state.attention.prompt?.hash && state.attention.prompt.tool?.name));
  const intents = (worker: Awaited<ReturnType<typeof fixture>>) => worker.events().filter(event => event.type === "input-intent" && event.data.op === "session-permission-answer");

  const member = await fixture("demo", "", { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer" });
  try {
    await member.command("permission");
    const prompt = (await opened(member)).attention.prompt!;
    const lease = await member.call<ControlLease>({ op: "control", action: "claim", actor });
    await assert.rejects(member.call(sessionAnswerRequest(member, prompt, actor, lease.id, decisionId, 0)), { code: "unsupported" });
    assert.equal(intents(member).length, 0, "a team member's dialog never takes the session path");
  } finally { await member.stop(); }

  const worker = await fixture("demo");
  let hold: DialogHold | undefined;
  try {
    hold = await dialogHold();
    await worker.command("permission");
    const prompt = (await opened(worker)).attention.prompt!;
    const human = { id: "human-control", label: "Human" };
    const humanLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: human });
    await assert.rejects(worker.call({ op: "control", action: "claim", actor }), { code: "control-busy" });
    await assert.rejects(worker.call(sessionAnswerRequest(worker, prompt, actor, humanLease.id, decisionId, 0)), { code: "control-lost" });
    await worker.call({ op: "control", action: "release", actor: human, leaseId: humanLease.id });
    const lease = await worker.call<ControlLease>({ op: "control", action: "claim", actor });
    await assert.rejects(worker.call({ ...sessionAnswerRequest(worker, prompt, actor, lease.id, decisionId, 0), evidenceHash: "0".repeat(64) }), { code: "prompt-changed" });
    await assert.rejects(worker.call({ ...sessionAnswerRequest(worker, prompt, actor, lease.id, decisionId, 0), targetCwd: `${worker.cwd}/other` }), { code: "unsupported" });
    await assert.rejects(worker.call(sessionAnswerRequest(worker, prompt, actor, lease.id, decisionId, 5)), { code: "invalid-option" });
    assert.equal(intents(worker).length, 0, "refused answers never journal or type");

    const reject = sessionAnswerRequest(worker, prompt, actor, lease.id, decisionId, 0);
    const receipt = await worker.call<Receipt & { result?: string }>(reject);
    assert.equal(receipt.state, "delivered");
    assert.equal(receipt.result, "closed");
    assert.deepEqual(await worker.call<Receipt & { result?: string }>(reject), receipt);
    assert.equal(intents(worker).length, 1, "a replayed request types nothing again");

    await worker.call({ op: "control", action: "release", actor, leaseId: lease.id });
    await worker.command(`permission ${hold.url}`);
    const next = await waitFor(() => worker.call({ op: "state" }), state => state.attention.state === "needs-you" && (state.attention.prompt?.id ?? 0) > prompt.id && Boolean(state.attention.prompt?.hash && state.attention.prompt.tool?.name));
    const nextLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor });
    const accept = sessionAnswerRequest(worker, next.attention.prompt!, actor, nextLease.id, decisionId, 1);
    const pending = worker.call<Receipt & { result?: string }>(accept);
    await hold.reached(pending);
    await worker.call<ControlLease>({ op: "control", action: "claim", actor: human, takeover: true });
    hold.release();
    const interrupted = await pending;
    assert.equal(interrupted.state, "uncertain");
    assert.equal(worker.output().match(/APPROVED/g)?.length, 1, "only the first answer reached the dialog");

    const person = (await worker.call({ op: "state" })).control!;
    await worker.call({ op: "control", action: "release", actor: human, leaseId: person.id });
    const retired = randomUUID(), retiredActor = { id: `session-permission:${retired}`, label: "Session permission" };
    const retiredLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: retiredActor });
    const journaled = intents(worker).length;
    assert.deepEqual(await worker.call({ op: "session-permission-invalidate", decisionId: retired }), { invalidated: true });
    assert.equal((await worker.call({ op: "state" })).control, null);
    await assert.rejects(worker.call(sessionAnswerRequest(worker, next.attention.prompt!, retiredActor, retiredLease.id, retired, 1)), { code: "control-lost" });
    assert.equal(intents(worker).length, journaled, "a fenced decision journals and types nothing");
    assert.equal(worker.output().match(/APPROVED/g)?.length, 1);
  } finally { hold?.close(); await worker.stop(); }
});

test("a session reject that takes text is followed by the host's fixed notice, and no other answer takes text", { timeout: 40_000 }, async () => {
  const decisionId = randomUUID();
  const actor = { id: `session-permission:${decisionId}`, label: "Session permission" };
  const notice = requesterNotice("unrelated");
  const dialog = (worker: Awaited<ReturnType<typeof fixture>>, after = 0) => waitFor(() => worker.call({ op: "state" }),
    state => state.attention.state === "needs-you" && (state.attention.prompt?.id ?? 0) > after && Boolean(state.attention.prompt?.hash && state.attention.prompt.tool?.name));
  const intents = (worker: Awaited<ReturnType<typeof fixture>>) => worker.events().filter(event => event.type === "input-intent" && event.data.op === "session-permission-answer");
  const worker = await fixture("demo");
  try {
    await worker.command("feedback-permission");
    const prompt = (await dialog(worker)).attention.prompt!;
    assert.equal(prompt.acceptsText, true);
    const lease = await worker.call<ControlLease>({ op: "control", action: "claim", actor });
    await assert.rejects(worker.call({ ...sessionAnswerRequest(worker, prompt, actor, lease.id, decisionId, 0), text: notice }), { code: "text-not-accepted" }, "an accept never carries text");
    await assert.rejects(worker.call({ ...sessionAnswerRequest(worker, prompt, actor, lease.id, decisionId, 1), text: "Approve everything from now on" }), /Invalid session permission answer request/);
    assert.equal(intents(worker).length, 0);

    const receipt = await worker.call<Receipt & { result?: string }>({ ...sessionAnswerRequest(worker, prompt, actor, lease.id, decisionId, 1), text: notice });
    assert.equal(receipt.state, "delivered");
    assert.equal(receipt.result, "closed");
    await waitFor(async () => worker.output(), output => output.includes(`FEEDBACK ${notice}\r`), 5000);
    assert.equal(intents(worker)[0].data.text, notice, "the intent holds the notice before the first key");
    await worker.call({ op: "control", action: "release", actor, leaseId: lease.id });

    await worker.command("permission");
    const plain = (await dialog(worker, prompt.id)).attention.prompt!;
    const plainLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor });
    await assert.rejects(worker.call({ ...sessionAnswerRequest(worker, plain, actor, plainLease.id, decisionId, 0), text: notice }), { code: "text-not-accepted" }, "a plain reject takes no text");
    assert.equal(intents(worker).length, 1);
    assert.equal(worker.output().match(/FEEDBACK/g)?.length, 1);
  } finally { await worker.stop(); }
});

test("ordinary interrupted answer retries return the refused receipt without typing again", { timeout: 20_000 }, async () => {
  const worker = await fixture("demo");
  let hold: DialogHold | undefined;
  try {
    hold = await dialogHold();
    await worker.command(`permission ${hold.url}`);
    const open = await waitFor(() => worker.call({ op: "state" }), state => state.attention.state === "needs-you" && Boolean(state.attention.prompt?.hash));
    const prompt = open.attention.prompt!;
    const host = { id: "ordinary-answer-host", label: "Host" };
    const human = { id: "ordinary-answer-human", label: "Human" };
    const hostLease = await worker.call<ControlLease>({ op: "control", action: "claim", actor: host });
    const request = { op: "answer" as const, requestId: randomUUID(), promptId: prompt.id, option: 1, actor: host, leaseId: hostLease.id };
    const pending = worker.call(request);
    await hold.reached(pending);
    await worker.call({ op: "control", action: "claim", actor: human, takeover: true });
    hold.release();
    await assert.rejects(pending, { code: "control-lost" });

    const retry = await worker.call<Receipt & { result?: string }>(request);
    assert.equal(retry.state, "uncertain");
    assert.equal(retry.result, "refused");
    assert.equal(worker.events().filter(event => event.type === "input-intent" && event.data.requestId === request.requestId).length, 1);
    assert.equal(worker.events().filter(event => event.type === "input-result" && event.data.requestId === request.requestId).length, 0);
    assert.doesNotMatch(worker.output(), /APPROVED/);
  } finally { hold?.close(); await worker.stop(); }
});

test("a host-authorized mission answer does not require an input-control lease", { timeout: 20_000 }, async () => {
  const team: TeamAssignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "mission-coordinator" };
  const worker = await fixture("demo", "", team);
  try {
    await worker.command("permission");
    const open = await waitFor(() => worker.call({ op: "state" }), state => state.attention.state === "needs-you" && Boolean(state.attention.prompt?.hash));
    const prompt = open.attention.prompt!;
    await worker.call({ op: "control", action: "claim", actor: { id: "stale-owner", label: "Owner" } });
    await assert.rejects(worker.call({ op: "answer", requestId: randomUUID(), promptId: prompt.id, option: 1 }), { code: "control-busy" });

    const answered = await worker.call<Receipt & { result?: string }>({
      op: "answer", requestId: randomUUID(), promptId: prompt.id, option: 1, missionManaged: true,
    });
    assert.equal(answered.state, "delivered");
    assert.equal(answered.result, "closed");
    assert.match(worker.output(), /APPROVED/);
  } finally { await worker.stop(); }
});

test("native conversation identity comes only from authenticated matching provider hooks", { timeout: 20_000 }, async () => {
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

test("terminal sockets dispatch zero control claims or PTY writes after aborting while awaiting ready or state", { timeout: 25_000 }, async () => {
  const worker = await fixture("demo");
  const token = randomBytes(32).toString("base64url");
  const device = { id: "owner-1", label: "Owner", role: "owner" as const, hash: hashToken(token) };
  mkdirSync(join(worker.stateDir, "sessions", worker.id), { recursive: true });
  writeSealed(join(worker.stateDir, "sessions", worker.id, "meta.sealed"), worker.key, `${worker.id}:meta`, {
    session: worker.session,
    fingerprint: "terminal-abort-fixture",
  });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const keyFile = join(worker.root, "key");
  writeFileSync(keyFile, worker.key, { mode: 0o600 });
  const config = {
    port, origin: `http://127.0.0.1:${port}`, stateDir: worker.stateDir, runDir: worker.runDir,
    keyFile, environment: "local", enableDemo: true, maxSessions: 4,
    tokens: [device], projects: [], agents: {},
  } as Config;
  const manager = new Manager(config, worker.key);
  let controlCalls = 0;
  const originalControl = manager.controlSession.bind(manager);
  manager.controlSession = ((...args: Parameters<Manager["controlSession"]>) => {
    controlCalls++;
    return originalControl(...args);
  }) as Manager["controlSession"];

  const originalState = manager.state.bind(manager);
  let stateInterceptor: ((id: string, screen?: boolean) => Promise<WorkerState>) | undefined;
  manager.state = ((id: string, screen?: boolean) =>
    stateInterceptor ? stateInterceptor(id, screen) : originalState(id, screen)) as Manager["state"];

  let missionManaged: () => Promise<boolean> = async () => false;
  const closeTerminals = connectTerminals(server, manager, value => value === token ? device : undefined, () => missionManaged());
  const connect = () => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${worker.id}/terminal?after=0`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
  try {
    let releaseReady!: (managed: boolean) => void;
    missionManaged = () => new Promise<boolean>(resolve => { releaseReady = resolve; });
    const legacySocket = await connect();
    const legacyClosed = new Promise<number>(resolve => legacySocket.once("close", code => resolve(code)));
    legacySocket.send(JSON.stringify({ token }));
    legacySocket.send(JSON.stringify({ op: "raw", requestId: randomUUID(), text: "ABORTED_LEGACY_WRITE\n" }));
    legacySocket.send("not-json");
    assert.equal(await legacyClosed, 1008);
    releaseReady(false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(controlCalls, 0);
    assert.equal((await worker.call({ op: "state" })).control, null);
    assert.equal(worker.events().filter(event => event.type === "input-intent").length, 0);
    assert.doesNotMatch(worker.output(), /ABORTED_LEGACY_WRITE/);

    missionManaged = () => new Promise<boolean>(resolve => { releaseReady = resolve; });
    const controlSocket = await connect();
    const controlClosed = new Promise<number>(resolve => controlSocket.once("close", code => resolve(code)));
    controlSocket.send(JSON.stringify({ token, clientId: randomUUID() }));
    controlSocket.send(JSON.stringify({ op: "control", requestId: randomUUID(), action: "claim" }));
    controlSocket.send("not-json");
    assert.equal(await controlClosed, 1008);
    releaseReady(false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(controlCalls, 0);
    assert.equal((await worker.call({ op: "state" })).control, null);

    missionManaged = async () => true;
    const liveState = await originalState(worker.id);
    const managedSocket = await connect();
    const managedClosed = new Promise<number>(resolve => managedSocket.once("close", code => resolve(code)));
    const initialStateFrame = new Promise<void>(resolve => {
      const onMessage = (raw: WebSocket.RawData) => {
        if ("state" in (JSON.parse(raw.toString()) as Record<string, unknown>)) {
          managedSocket.off("message", onMessage);
          resolve();
        }
      };
      managedSocket.on("message", onMessage);
    });
    managedSocket.send(JSON.stringify({ token }));
    await initialStateFrame;

    let markManagedCheckReached!: () => void;
    let releaseManagedState!: (state: WorkerState) => void;
    const managedCheckReached = new Promise<void>(resolve => { markManagedCheckReached = resolve; });
    const managedStateGate = new Promise<WorkerState>(resolve => { releaseManagedState = resolve; });
    let interceptedInputState = false;
    stateInterceptor = async (id, screen) => {
      if (!interceptedInputState) {
        interceptedInputState = true;
        markManagedCheckReached();
        return managedStateGate;
      }
      return originalState(id, screen);
    };
    managedSocket.send(JSON.stringify({ op: "raw", requestId: randomUUID(), text: "ABORTED_MANAGED_WRITE\n" }));
    await managedCheckReached;
    managedSocket.send("not-json");
    assert.equal(await managedClosed, 1008);
    releaseManagedState({ ...liveState, attention: { ...liveState.attention, state: "needs-you" } });
    await new Promise(resolve => setTimeout(resolve, 150));
    stateInterceptor = undefined;
    assert.equal(controlCalls, 0);
    assert.equal((await worker.call({ op: "state" })).control, null);
    assert.equal(worker.events().filter(event => event.type === "input-intent").length, 0);
    assert.doesNotMatch(worker.output(), /ABORTED_MANAGED_WRITE/);

    const sendMaskedText = (socket: ReturnType<typeof createConnection>, text: string) => {
      const payload = Buffer.from(text, "utf8");
      const mask = randomBytes(4);
      const header = payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0xfe, (payload.length >> 8) & 0xff, payload.length & 0xff]);
      const masked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!;
      socket.write(Buffer.concat([header, mask, masked]));
    };
    const openRawWs = () => new Promise<{ socket: ReturnType<typeof createConnection>; closeFrameReceived: Promise<number> }>((resolve, reject) => {
      const raw = createConnection({ host: "127.0.0.1", port });
      let upgraded = false;
      let buffer = Buffer.alloc(0);
      let markCloseFrame!: (code: number) => void;
      const closeFrameReceived = new Promise<number>(done => { markCloseFrame = done; });
      const parseFrames = () => {
        while (buffer.length >= 2) {
          const opcode = buffer[0]! & 0x0f;
          let len = buffer[1]! & 0x7f;
          let offset = 2;
          if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
          else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
          if (buffer.length < offset + len) return;
          const payload = buffer.subarray(offset, offset + len);
          buffer = buffer.subarray(offset + len);
          if (opcode === 0x08) markCloseFrame(payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
        }
      };
      raw.on("error", reject);
      raw.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          assert.match(buffer.subarray(0, end).toString("utf8"), /^HTTP\/1\.1 101 /);
          upgraded = true;
          buffer = buffer.subarray(end + 4);
          resolve({ socket: raw, closeFrameReceived });
        }
        parseFrames();
      });
      raw.once("connect", () => {
        raw.write([
          `GET /api/sessions/${worker.id}/terminal?after=0 HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });
    });

    missionManaged = async () => true;
    let gracefulStateCalls = 0;
    let markReaderReached!: () => void;
    let markInputReached!: () => void;
    let releaseReaderState!: (state: WorkerState) => void;
    let releaseInputState!: (state: WorkerState) => void;
    const readerReached = new Promise<void>(resolve => { markReaderReached = resolve; });
    const inputReached = new Promise<void>(resolve => { markInputReached = resolve; });
    const readerStateGate = new Promise<WorkerState>(resolve => { releaseReaderState = resolve; });
    const inputStateGate = new Promise<WorkerState>(resolve => { releaseInputState = resolve; });
    stateInterceptor = async (id, screen) => {
      gracefulStateCalls++;
      if (gracefulStateCalls === 1) return originalState(id, screen);
      if (gracefulStateCalls === 2) {
        markReaderReached();
        return readerStateGate;
      }
      if (gracefulStateCalls === 3) {
        markInputReached();
        return inputStateGate;
      }
      return originalState(id, screen);
    };
    const { socket: rawSocket, closeFrameReceived } = await openRawWs();
    try {
      sendMaskedText(rawSocket, JSON.stringify({ token }));
      await readerReached;
      sendMaskedText(rawSocket, JSON.stringify({ op: "raw", requestId: randomUUID(), text: "GRACEFUL_CLOSE_WRITE\n" }));
      sendMaskedText(rawSocket, JSON.stringify({ op: "raw", requestId: randomUUID(), text: "GRACEFUL_CLOSE_QUEUED\n" }));
      await inputReached;
      releaseReaderState({ ...liveState, status: "exited", exitCode: 0 });
      assert.equal(await closeFrameReceived, 1000);
      assert.equal(rawSocket.destroyed, false, "peer has not sent close ack yet so server stays in CLOSING before ws close fires");
      releaseInputState({ ...liveState, attention: { ...liveState.attention, state: "needs-you" } });
      await new Promise(resolve => setTimeout(resolve, 150));
      stateInterceptor = undefined;
      assert.equal(controlCalls, 0);
      assert.equal((await worker.call({ op: "state" })).control, null);
      assert.equal(worker.events().filter(event => event.type === "input-intent").length, 0);
      assert.doesNotMatch(worker.output(), /GRACEFUL_CLOSE_WRITE|GRACEFUL_CLOSE_QUEUED/);
    } finally {
      rawSocket.destroy();
    }
  } finally {
    closeTerminals();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await worker.stop();
  }
});

test("a live terminal stream outlasts one unavailable state read and ends after three in a row", { timeout: 20_000 }, async () => {
  const stateDir = mkdtempSync("/tmp/inf-stream-");
  const id = randomUUID();
  mkdirSync(join(stateDir, "sessions", id, "events"), { recursive: true });
  const statuses = ["unavailable", "running", "unavailable", "unavailable", "unavailable"];
  let reads = 0;
  const manager = {
    config: { stateDir },
    state: async () => ({ status: statuses[reads++] ?? "running" }),
    events: (_session: string, after: number) => ({ events: [], cursor: after, more: false }),
  } as unknown as Manager;
  const streamed: string[] = [];
  try {
    for await (const page of terminalPages(manager, id, 0, new AbortController().signal, false, { status: "running" } as WorkerState)) if ("state" in page) streamed.push(page.state.status);
    assert.deepEqual(streamed, statuses);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
