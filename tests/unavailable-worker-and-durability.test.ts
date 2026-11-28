import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { applyLifecycle, initialAttention } from "@infinite/attention";
import { Manager, TeamStopRefused } from "../packages/host/src/manager.js";
import { confirmDeadTeamRuntime, type RuntimeProcess } from "../packages/host/src/team-retirement.js";
import { LinearService } from "../packages/host/src/linear.js";
import { applyOwnerOps } from "../packages/host/src/objective-ops.js";
import { goalRecord } from "../packages/host/src/objective-record.js";
import { objectiveRecordSchema, recordDigest, type Criterion, type ObjectiveRecord } from "../packages/host/src/objective-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamAssignment, TeamCommand, TeamRun } from "../packages/host/src/team-types.js";
import type { Config, WorkerState } from "../packages/host/src/types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { startLinearServer } from "./fixtures/linear-server.js";

function makeState(status: WorkerState["status"], overrides: Partial<WorkerState> = {}): WorkerState {
  const now = "2026-11-28T00:00:00.000Z";
  return {
    status,
    seq: 12,
    screen: "",
    attention: applyLifecycle(initialAttention(now, false), status === "exited" || status === "recording-error" ? status : "unavailable", now),
    ...overrides,
  };
}

function row(pid: number, parent = 1, state = "S"): RuntimeProcess {
  return { pid, parent, group: pid, ruid: 1000, euid: 1000, born: "Sat Nov 28 00:00:00 2026", state };
}

test("confirmDeadTeamRuntime confirms dead unavailable and recording-error workers safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-dead-runtime-"));
  const stateDir = join(root, "state");
  const runDir = join(root, "run");
  const key = randomBytes(32);
  try {
    const unavailableId = randomUUID();
    const unavailableSealed = makeState("running", { workerPid: 420001, pid: 420002 });
    writeSealed(join(stateDir, "sessions", unavailableId, "status.sealed"), key, `${unavailableId}:status`, unavailableSealed);
    const confirmed = await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: unavailableId,
      state: makeState("unavailable"),
      inventory: async () => [row(process.pid)],
    });
    assert.ok(confirmed);
    assert.equal(confirmed.status, "exited");
    assert.equal(confirmed.outputTailIncomplete, true);
    assert.equal(confirmed.control, null);
    const persisted = unseal<WorkerState>(key, `${unavailableId}:status`, readFileSync(join(stateDir, "sessions", unavailableId, "status.sealed"), "utf8"));
    assert.equal(persisted.status, "exited");
    assert.equal(persisted.outputTailIncomplete, true);

    const liveWorkerId = randomUUID();
    writeSealed(join(stateDir, "sessions", liveWorkerId, "status.sealed"), key, `${liveWorkerId}:status`, makeState("running", { workerPid: process.pid, pid: 420010 }));
    assert.equal(await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: liveWorkerId,
      state: makeState("unavailable"),
      inventory: async () => [row(process.pid)],
    }), undefined);

    const livePtyId = randomUUID();
    writeSealed(join(stateDir, "sessions", livePtyId, "status.sealed"), key, `${livePtyId}:status`, makeState("running", { workerPid: 420020, pid: process.pid }));
    assert.equal(await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: livePtyId,
      state: makeState("unavailable"),
      inventory: async () => [row(process.pid)],
    }), undefined);

    const grandchildId = randomUUID();
    writeSealed(join(stateDir, "sessions", grandchildId, "status.sealed"), key, `${grandchildId}:status`, makeState("running", { workerPid: 420021, pid: 420022 }));
    assert.equal(await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: grandchildId,
      state: makeState("unavailable"),
      inventory: async () => [row(process.pid), row(420022, 420021, "Z"), row(420023, 420022, "S")],
    }), undefined);

    const statePidId = randomUUID();
    writeSealed(join(stateDir, "sessions", statePidId, "status.sealed"), key, `${statePidId}:status`, makeState("running", { workerPid: 420024 }));
    assert.equal(await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: statePidId,
      state: makeState("unavailable", { pid: 420025 }),
      inventory: async () => [row(process.pid), row(420025, 1, "S")],
    }), undefined);

    const sealedControlId = randomUUID();
    writeSealed(join(stateDir, "sessions", sealedControlId, "status.sealed"), key, `${sealedControlId}:status`, makeState("running", {
      workerPid: 420026,
      control: { deviceId: "d1", deviceName: "Owner", expiresAt: Date.now() + 60_000 },
    }));
    assert.equal(await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: sealedControlId,
      state: makeState("unavailable"),
      inventory: async () => [row(process.pid)],
    }), undefined);

    const alreadyExitedId = randomUUID();
    writeSealed(join(stateDir, "sessions", alreadyExitedId, "status.sealed"), key, `${alreadyExitedId}:status`, makeState("exited", { workerPid: 420027, exitCode: 0 }));
    const cleanExited = await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: alreadyExitedId,
      state: makeState("unavailable"),
      inventory: async () => [row(process.pid)],
    });
    assert.ok(cleanExited);
    assert.equal(cleanExited.status, "exited");
    assert.equal(cleanExited.exitCode, 0);
    assert.equal(cleanExited.outputTailIncomplete, undefined);

    const recDeadId = randomUUID();
    const recSealed = makeState("recording-error", { workerPid: 420030, pid: 420031 });
    writeSealed(join(stateDir, "sessions", recDeadId, "status.sealed"), key, `${recDeadId}:status`, recSealed);
    assert.equal(await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: recDeadId,
      state: makeState("recording-error"),
      probeAlive: async () => true,
      inventory: async () => [row(process.pid)],
    }), undefined);
    const recConfirmed = await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: recDeadId,
      state: makeState("recording-error"),
      probeAlive: async () => false,
      inventory: async () => [row(process.pid)],
    });
    assert.ok(recConfirmed);
    assert.equal(recConfirmed.status, "exited");
    assert.equal(recConfirmed.outputTailIncomplete, true);
    const recStillPreserved = unseal<WorkerState>(key, `${recDeadId}:status`, readFileSync(join(stateDir, "sessions", recDeadId, "status.sealed"), "utf8"));
    assert.equal(recStillPreserved.status, "recording-error");

    const stoppingId = randomUUID();
    writeSealed(join(stateDir, "sessions", stoppingId, "status.sealed"), key, `${stoppingId}:status`, makeState("running", { workerPid: 420035 }));
    writeSealed(join(stateDir, "sessions", stoppingId, "retirement.sealed"), key, `${stoppingId}:retirement`, {
      state: "stopping", requestId: randomUUID(), identity: "b".repeat(64), sessionId: stoppingId, seq: 12,
      agentUid: null, known: [row(420036, 1, "S")], at: "2026-11-28T00:00:00.000Z",
    });
    assert.equal(await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: stoppingId,
      state: makeState("unavailable"),
      inventory: async () => [row(process.pid)],
    }), undefined);

    const corruptRetireId = randomUUID();
    writeSealed(join(stateDir, "sessions", corruptRetireId, "status.sealed"), key, `${corruptRetireId}:status`, makeState("running", { workerPid: 420038 }));
    writeFileSync(join(stateDir, "sessions", corruptRetireId, "retirement.sealed"), "corrupt");
    assert.equal(await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: corruptRetireId,
      state: makeState("unavailable"),
      inventory: async () => [row(process.pid)],
    }), undefined);

    const retiredId = randomUUID();
    writeSealed(join(stateDir, "sessions", retiredId, "status.sealed"), key, `${retiredId}:status`, makeState("recording-error", { workerPid: 420040 }));
    writeSealed(join(stateDir, "sessions", retiredId, "retirement.sealed"), key, `${retiredId}:retirement`, {
      state: "retired", requestId: randomUUID(), identity: "a".repeat(64), sessionId: retiredId, seq: 12,
      agentUid: null, known: [], at: "2026-11-28T00:00:00.000Z", stoppedAt: "2026-11-28T00:00:01.000Z",
    });
    const retiredConfirmed = await confirmDeadTeamRuntime({
      stateDir, key, socketTarget: runDir, sessionId: retiredId,
      state: makeState("recording-error"),
    });
    assert.ok(retiredConfirmed);
    assert.equal(retiredConfirmed.status, "exited");
    assert.equal(retiredConfirmed.outputTailIncomplete, true);
    assert.equal(unseal<WorkerState>(key, `${retiredId}:status`, readFileSync(join(stateDir, "sessions", retiredId, "status.sealed"), "utf8")).status, "recording-error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Manager.prototype.stopTeamSession rejects lightweight mocks without config or key", async () => {
  const team: TeamAssignment = { runId: randomUUID(), memberId: "m1", revision: 1, role: "implementer", taskId: "t1" };
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const plainMock = {
    meta: () => ({ session: { team } }),
    state: async () => makeState("unavailable"),
  } as unknown as Manager;
  await assert.rejects(Manager.prototype.stopTeamSession.call(plainMock, sessionId, requestId, team), TeamStopRefused);

  const protoMock = Object.assign(Object.create(Manager.prototype), {
    meta: () => ({ session: { team } }),
    state: async () => makeState("unavailable"),
  }) as Manager;
  await assert.rejects(protoMock.stopTeamSession(sessionId, requestId, team), TeamStopRefused);
});

test("LinearService prunes delivered comments past 256, deduplicates delivered keys, and blocks on 256 undelivered comments", { timeout: 60000 }, async () => {
  const linear = await startLinearServer();
  const root = mkdtempSync(join(tmpdir(), "infinite-linear-pruning-"));
  const key = randomBytes(32);
  const config = {
    stateDir: join(root, "state"),
    linear: { apiKeyFile: join(root, "linear-key"), endpoint: linear.endpoint },
    projects: [{ id: "durability", name: "Durability", path: root, linear: { teamId: linear.teamId } }],
  } as unknown as Config;
  writeFileSync(config.linear!.apiKeyFile, linear.apiKey, { mode: 0o600 });
  const service = new LinearService(config, key);
  const pump = () => (service as unknown as { pump(): Promise<void> }).pump();
  const sealedFor = (id: string) => unseal<{ blocked?: string; comments: Record<string, { delivered: boolean }>; deliveredComments?: string[] }>(
    key, `linear:team:${id}`, readFileSync(join(root, "state", "linear", `team-${id}.sealed`), "utf8"),
  );
  try {
    const steering = Array.from({ length: 256 }, (_, index) => ({
      revision: index + 1,
      text: `Steering message ${index + 1}`,
      at: "2026-11-28T00:00:00.000Z",
    }));
    const run = {
      id: randomUUID(), projectId: "durability", title: "Outbox pruning", objective: "Keep Linear sync healthy.",
      status: "implementing", revision: 1, members: [], checks: [], steering, decisions: [],
    } as unknown as TeamRun;
    service.updateTeam(run, true);
    for (let i = 0; i < 40; i++) {
      await pump();
      const stored = sealedFor(run.id);
      if (Object.keys(stored.comments).length === 256 && Object.values(stored.comments).every(comment => comment.delivered)) break;
    }
    const beforePrune = sealedFor(run.id);
    assert.equal(Object.values(beforePrune.comments).filter(comment => comment.delivered).length, 256);

    const extra = [
      { revision: 257, text: "Steering message 257", at: "2026-11-28T00:01:00.000Z" },
      { revision: 258, text: "Steering message 258", at: "2026-11-28T00:02:00.000Z" },
    ];
    service.updateTeam({ ...run, steering: [...steering, ...extra] } as unknown as TeamRun, true);
    const afterPruneView = service.getTeam(run.id, true);
    assert.notEqual(afterPruneView?.status, "blocked");
    const afterPrune = sealedFor(run.id);
    assert.equal(afterPrune.blocked, undefined);
    assert.equal(afterPrune.deliveredComments?.length, 256);
    assert.equal(Object.keys(afterPrune.comments).length, 2);

    await pump();
    const createsBeforeReplay = linear.calls.filter(call => call.operation === "InfiniteLinearCommentCreate").length;
    assert.equal(createsBeforeReplay, 258);
    service.updateTeam({ ...run, steering: [steering[0]!, ...extra] } as unknown as TeamRun, true);
    await pump();
    const createsAfterReplay = linear.calls.filter(call => call.operation === "InfiniteLinearCommentCreate").length;
    assert.equal(createsAfterReplay, 258);

    const overflowSteering = Array.from({ length: 257 }, (_, index) => ({
      revision: index + 1,
      text: `Undelivered steering ${index + 1}`,
      at: "2026-11-28T00:00:00.000Z",
    }));
    const overflowRun = {
      id: randomUUID(), projectId: "durability", title: "Outbox overflow", objective: "Block on undelivered overflow.",
      status: "implementing", revision: 1, members: [], checks: [], steering: overflowSteering, decisions: [],
    } as unknown as TeamRun;
    service.updateTeam(overflowRun, true);
    const overflowView = service.getTeam(overflowRun.id, true);
    assert.equal(overflowView?.status, "blocked");
    assert.match(overflowView?.reason ?? "", /exceeded its bounded outbox/);
  } finally {
    service.close();
    await linear.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyOwnerOps criterion.edit preserves pinned and latest selectively", () => {
  const AT = "2026-11-28T00:00:00.000Z";
  const LINT: TeamCommand = { command: "npm", args: ["run", "lint"] };
  const TEST: TeamCommand = { command: "npm", args: ["test"] };
  const goal = {
    id: randomUUID(),
    objective: "Keep criterion evidence aligned with edits.",
    successCriteria: "Shortlist meets checks",
    nonGoals: [],
    allowedPaths: ["research"],
    evidence: [],
    steering: [],
  } as unknown as ProductGoal;
  const base = goalRecord(goal, AT, "created");
  if (typeof base === "string") throw new Error(base);
  const pinned = [{ path: "research/shortlist.md", blob: "a".repeat(40) }];
  const latest = { state: "met" as const, verdictId: randomUUID() };
  const c1: Criterion = {
    id: "c1",
    origin: "owner",
    statement: "Shortlist has entries.",
    check: { kind: "artifact", path: "research/shortlist.md", count: "/items" },
    producer: "host",
    threshold: { kind: "count", min: 1 },
    pinned,
    latest,
    state: "active",
  };
  const body = { ...base, criteria: [base.criteria[0]!, c1] };
  const start: ObjectiveRecord = { ...body, digest: recordDigest(body) };
  assert.ok(objectiveRecordSchema.safeParse(start).success);

  const context = { configured: [LINT, TEST], requestId: randomUUID(), at: AT };
  const wordingOnly = applyOwnerOps(start, {
    version: 1,
    ops: [{ op: "criterion.edit", id: "c1", statement: "Shortlist has ranked entries." }],
  }, context);
  const wordingC1 = wordingOnly.criteria.find(item => item.id === "c1")!;
  assert.deepEqual(wordingC1.pinned, pinned);
  assert.equal(wordingC1.latest, undefined);

  const thresholdOnly = applyOwnerOps(wordingOnly, {
    version: 2,
    ops: [{ op: "criterion.edit", id: "c1", threshold: { kind: "count", min: 2 } }],
  }, context);
  const thresholdC1 = thresholdOnly.criteria.find(item => item.id === "c1")!;
  assert.deepEqual(thresholdC1.pinned, pinned);
  assert.equal(thresholdC1.latest, undefined);

  const checkEdited = applyOwnerOps(wordingOnly, {
    version: 2,
    ops: [{ op: "criterion.edit", id: "c1", check: { kind: "command", run: LINT } }],
  }, context);
  const checkC1 = checkEdited.criteria.find(item => item.id === "c1")!;
  assert.equal(checkC1.pinned, undefined);
  assert.equal(checkC1.latest, undefined);
});
