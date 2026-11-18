import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceTx, RunEvent } from "../packages/host/src/evidence/types.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import {
  decisionKey,
  insertDecision,
  readDecision,
  registerRouting,
  routingModule,
  routingProjector,
} from "../packages/host/src/routing-store.js";
import type { DecisionRow, RoutingPayload, RoutingPoint } from "../packages/host/src/routing-types.js";

const NOW = "2026-11-15T12:00:00.000Z";
const RUN = "run-r";
const OTHER_RUN = "run-other";
const PROFILE = "astra-xhigh";
const OTHER_PROFILE = "light-other";

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-projector-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture): EvidenceStore {
  return new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
}

function payload(taskId: string): RoutingPayload {
  return {
    projectId: "proj-a",
    taskId,
    area: "core",
    featureMap: "default",
    coordinatorProfileId: null,
    knobs: ROUTING_DEFAULTS,
    costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" },
    headroom: "not-modelled",
    chosenWeight: 0.5,
    current: [],
    candidates: [],
    elapsedMs: 1,
  };
}

/** A pending `auto` start row for the task's first implementer, as the host writes it before the member exists. */
function pendingRow(tx: EvidenceTx, runId: string, taskId: string, profileId: string, revision = 1, state: DecisionRow["state"] = "pending"): DecisionRow {
  return {
    key: decisionKey(runId, revision, tx.index("task", taskId), "start", 1),
    runId,
    revision,
    taskKey: tx.index("task", taskId),
    point: "start",
    ordinal: 1,
    projectRef: tx.index("project", "proj-a"),
    role: "implementer",
    areaRef: tx.index("area", "core"),
    kind: null,
    risk: "normal",
    featureVersion: 1,
    featureMapRef: tx.index("feature-map", "default"),
    mode: "auto",
    algorithmVersion: 1,
    rewardVersion: 1,
    policyDigest: "d".repeat(64),
    seed: "s".repeat(64),
    basis: "greedy-risk",
    chosenProfileId: profileId,
    chosenIdentity: "i".repeat(64),
    greedyProfileId: profileId,
    coordinatorProfileId: null,
    explore: false,
    state,
    memberId: null,
    decidedAt: NOW,
  };
}

function seedRows(store: EvidenceStore, rows: { runId: string; taskId: string; profileId: string; revision?: number; state?: DecisionRow["state"] }[]): void {
  store.write(tx => {
    for (const row of rows) insertDecision(tx, pendingRow(tx, row.runId, row.taskId, row.profileId, row.revision, row.state), payload(row.taskId));
  });
}

let sequence = 0;

/** A run event with a unique key. `seq` is what the projector sees. */
function runEvent(kind: string, runId: string, fields: {
  revision?: number; memberId?: string; taskId?: string; data?: Record<string, unknown>;
} = {}): RunEvent {
  sequence += 1;
  return {
    seq: sequence,
    key: `${kind}:${runId}:${sequence}`,
    runId,
    revision: fields.revision ?? 1,
    at: NOW,
    kind,
    ...(fields.memberId === undefined ? {} : { memberId: fields.memberId }),
    ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
    data: fields.data ?? {},
  };
}

const started = (runId: string, taskId: string, memberId: string, profileId: string, extra: Record<string, unknown> = {}, revision = 1) =>
  runEvent("member.started", runId, { taskId, memberId, revision, data: { role: "implementer", profileId, ...extra } });

/** Projects events one at a time in one write each, the way the outbox calls the projector. */
function project(store: EvidenceStore, events: RunEvent[]): void {
  const projector = routingProjector();
  for (const event of events) store.write(tx => projector.project(tx, event));
}

function stateOf(store: EvidenceStore, runId: string, taskId: string, revision = 1): { state: string | undefined; memberId: string | null | undefined } {
  const row = store.read(db => readDecision(db, decisionKey(runId, revision, db.index("task", taskId), "start", 1)));
  return { state: row?.state, memberId: row?.memberId };
}

test("the projector applies or releases each pending row once", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(routingModule());
    seedRows(store, [
      { runId: RUN, taskId: "a", profileId: PROFILE },
      { runId: RUN, taskId: "b", profileId: PROFILE },
      { runId: RUN, taskId: "c", profileId: PROFILE },
      { runId: RUN, taskId: "d", profileId: PROFILE },
      { runId: RUN, taskId: "e", profileId: PROFILE, revision: 2 },
      { runId: RUN, taskId: "rec", profileId: PROFILE, state: "recorded" },
      { runId: OTHER_RUN, taskId: "x", profileId: PROFILE },
    ]);
    project(store, [
      started(RUN, "a", "m-a", PROFILE),
      started(RUN, "b", "m-b", OTHER_PROFILE),
      started(RUN, "c", "m-c", PROFILE, { replaces: "m-old" }),
      runEvent("member.started", RUN, { taskId: "d", memberId: "m-scout", data: { role: "scout", profileId: PROFILE } }),
      runEvent("member.started", RUN, { taskId: "e", memberId: "m-rev", revision: 2, data: { role: "reviewer", profileId: PROFILE } }),
      started(RUN, "a", "m-a2", PROFILE),
      started(RUN, "rec", "m-rec", OTHER_PROFILE),
    ]);
    assert.deepEqual(stateOf(store, RUN, "a"), { state: "applied", memberId: "m-a" }, "a starts on its chosen profile");
    assert.deepEqual(stateOf(store, RUN, "b"), { state: "released", memberId: null }, "b starts on another profile");
    assert.deepEqual(stateOf(store, RUN, "c"), { state: "pending", memberId: null }, "a replacement keeps the row pending");
    assert.deepEqual(stateOf(store, RUN, "d"), { state: "pending", memberId: null }, "a scout start keeps the row pending");
    assert.deepEqual(stateOf(store, RUN, "e", 2), { state: "pending", memberId: null }, "a reviewer start keeps the row pending");
    assert.deepEqual(stateOf(store, RUN, "rec"), { state: "recorded", memberId: null }, "a recorded row never changes");
    project(store, [runEvent("run.deleted", OTHER_RUN)]);
    assert.deepEqual(stateOf(store, OTHER_RUN, "x"), { state: "released", memberId: null }, "a deleted run's rows are released");
    project(store, [runEvent("run.revision-advanced", RUN, { revision: 2 })]);
    assert.equal(stateOf(store, RUN, "c").state, "released", "a revision advance releases lower revisions");
    assert.equal(stateOf(store, RUN, "d").state, "released");
    assert.equal(stateOf(store, RUN, "e", 2).state, "pending", "the new revision keeps its rows");
    project(store, [runEvent("run.settled", RUN)]);
    assert.equal(stateOf(store, RUN, "e", 2).state, "released", "a settled run releases its rows");
    assert.deepEqual(stateOf(store, RUN, "a"), { state: "applied", memberId: "m-a" }, "an applied row keeps its first member");
  } finally {
    store?.close();
    f.close();
  }
});

test("projecting again, in each order of three events or after a restart, changes nothing", () => {
  const orders: number[][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const order of orders) {
    const f = fixture();
    let store: EvidenceStore | undefined;
    try {
      store = open(f);
      store.register(routingModule());
      seedRows(store, [
        { runId: RUN, taskId: "a", profileId: PROFILE },
        { runId: RUN, taskId: "b", profileId: PROFILE },
      ]);
      const events = [
        started(RUN, "a", "m-a", PROFILE),
        started(RUN, "b", "m-b", OTHER_PROFILE),
        runEvent("run.settled", RUN),
      ];
      const sequenceEvents = order.map(index => events[index]);
      project(store, sequenceEvents);
      const once = [stateOf(store, RUN, "a"), stateOf(store, RUN, "b")];
      project(store, sequenceEvents);
      assert.deepEqual([stateOf(store, RUN, "a"), stateOf(store, RUN, "b")], once, `order ${order.join(",")} is idempotent`);
      const aStartedFirst = order.indexOf(0) < order.indexOf(2);
      assert.deepEqual(once[0], aStartedFirst
        ? { state: "applied", memberId: "m-a" }
        : { state: "released", memberId: null }, `order ${order.join(",")} for a`);
      assert.deepEqual(once[1], { state: "released", memberId: null }, `order ${order.join(",")} for b`);
    } finally {
      store?.close();
      f.close();
    }
  }

  // A restart: events stored before the projector existed are projected by the first advance after it, and a
  // reopened store projects nothing again.
  const f = fixture();
  try {
    let store = open(f);
    store.register(routingModule());
    const storing = new EventOutbox(store);
    seedRows(store, [
      { runId: RUN, taskId: "a", profileId: PROFILE },
      { runId: RUN, taskId: "b", profileId: PROFILE },
    ]);
    const events: OutboxEvent[] = [
      { key: "start-a", runId: RUN, revision: 1, at: NOW, kind: "member.started", taskId: "a", memberId: "m-a", data: { role: "implementer", profileId: PROFILE } },
      { key: "start-b", runId: RUN, revision: 1, at: NOW, kind: "member.started", taskId: "b", memberId: "m-b", data: { role: "implementer", profileId: OTHER_PROFILE } },
    ];
    assert.equal(storing.flush(events).stored, true);
    store.close();

    store = open(f);
    const outbox = new EventOutbox(store);
    registerRouting(store, outbox);
    const first = outbox.advance();
    assert.equal(first.projected, 2, "the stored events are projected by the first advance");
    const after = [stateOf(store, RUN, "a"), stateOf(store, RUN, "b")];
    assert.deepEqual(after, [{ state: "applied", memberId: "m-a" }, { state: "released", memberId: null }]);
    store.close();

    store = open(f);
    const reopened = new EventOutbox(store);
    registerRouting(store, reopened);
    const again = reopened.advance();
    assert.equal(again.projected, 0, "a reopened store projects nothing again");
    assert.deepEqual([stateOf(store, RUN, "a"), stateOf(store, RUN, "b")], after);
    store.close();
  } finally {
    f.close();
  }
});

const ESCALATION_PROFILE = "sonnet-escalation";
const SCOUT_PROFILE = "haiku-light";

/** A pending row at `point` for the task (or scout), as the host writes it before its member starts. */
function pendingAt(tx: EvidenceTx, runId: string, taskId: string, profileId: string, point: RoutingPoint, revision = 1, state: DecisionRow["state"] = "pending"): DecisionRow {
  const row = pendingRow(tx, runId, taskId, profileId, revision, state);
  return { ...row, key: decisionKey(runId, revision, row.taskKey, point, 1), point, role: point === "scout" ? "scout" : "implementer" };
}

function seedAt(store: EvidenceStore, rows: { runId: string; taskId: string; profileId: string; point: RoutingPoint; revision?: number }[]): void {
  store.write(tx => {
    for (const row of rows) insertDecision(tx, pendingAt(tx, row.runId, row.taskId, row.profileId, row.point, row.revision), payload(row.taskId));
  });
}

function stateAt(store: EvidenceStore, runId: string, taskId: string, point: RoutingPoint, revision = 1): { state: string | undefined; memberId: string | null | undefined } {
  const row = store.read(db => readDecision(db, decisionKey(runId, revision, db.index("task", taskId), point, 1)));
  return { state: row?.state, memberId: row?.memberId };
}

test("the projector applies or releases escalation and scout rows once", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    store.register(routingModule());
    seedAt(store, [
      { runId: RUN, taskId: "a", profileId: PROFILE, point: "start" },
      { runId: RUN, taskId: "a", profileId: ESCALATION_PROFILE, point: "escalation" },
      { runId: RUN, taskId: "s1", profileId: SCOUT_PROFILE, point: "scout" },
      { runId: RUN, taskId: "c", profileId: ESCALATION_PROFILE, point: "escalation" },
      { runId: RUN, taskId: "s2", profileId: SCOUT_PROFILE, point: "scout" },
      { runId: RUN, taskId: "e", profileId: ESCALATION_PROFILE, point: "escalation", revision: 2 },
      { runId: OTHER_RUN, taskId: "x", profileId: PROFILE, point: "start" },
      { runId: OTHER_RUN, taskId: "x", profileId: ESCALATION_PROFILE, point: "escalation" },
      { runId: OTHER_RUN, taskId: "sx", profileId: SCOUT_PROFILE, point: "scout" },
    ]);
    const events = [
      started(RUN, "a", "m-a", PROFILE),
      started(RUN, "a", "m-stall", ESCALATION_PROFILE, { replaces: { cause: "stall" } }),
      started(RUN, "a", "m-esc", ESCALATION_PROFILE, { replaces: { cause: "escalation" } }),
      runEvent("member.started", RUN, { taskId: "s1", memberId: "m-s1", data: { role: "scout", profileId: OTHER_PROFILE } }),
    ];
    project(store, events);
    assert.deepEqual(stateAt(store, RUN, "a", "start"), { state: "applied", memberId: "m-a" }, "a first start applies its start row");
    assert.deepEqual(stateAt(store, RUN, "a", "escalation"), { state: "applied", memberId: "m-esc" }, "an escalated start applies its escalation row");
    assert.deepEqual(stateAt(store, RUN, "s1", "scout"), { state: "released", memberId: null }, "a scout on a limit fallback releases its row");
    project(store, events);
    assert.deepEqual(stateAt(store, RUN, "a", "escalation"), { state: "applied", memberId: "m-esc" }, "a replayed escalated start changes nothing");
    assert.deepEqual(stateAt(store, RUN, "s1", "scout"), { state: "released", memberId: null }, "a replayed scout start changes nothing");
    project(store, [runEvent("member.started", RUN, { taskId: "c", memberId: "m-c", data: { role: "implementer", profileId: PROFILE, replaces: { cause: "stall" } } })]);
    assert.deepEqual(stateAt(store, RUN, "c", "escalation"), { state: "pending", memberId: null }, "a stall replacement keeps the escalation row pending");
    project(store, [runEvent("run.revision-advanced", RUN, { revision: 2 })]);
    assert.equal(stateAt(store, RUN, "c", "escalation").state, "released", "a revision advance releases lower-revision escalation rows");
    assert.equal(stateAt(store, RUN, "s2", "scout").state, "released", "a revision advance releases lower-revision scout rows");
    assert.equal(stateAt(store, RUN, "e", "escalation", 2).state, "pending", "the new revision keeps its escalation row");
    assert.deepEqual(stateAt(store, RUN, "a", "escalation"), { state: "applied", memberId: "m-esc" }, "an applied escalation row keeps its member");
    project(store, [runEvent("run.deleted", OTHER_RUN)]);
    assert.equal(stateAt(store, OTHER_RUN, "x", "start").state, "released", "a deleted run releases its start row");
    assert.equal(stateAt(store, OTHER_RUN, "x", "escalation").state, "released", "a deleted run releases its escalation row");
    assert.equal(stateAt(store, OTHER_RUN, "sx", "scout").state, "released", "a deleted run releases its scout row");
    project(store, [runEvent("run.settled", RUN)]);
    assert.equal(stateAt(store, RUN, "e", "escalation", 2).state, "released", "a settled run releases its escalation rows");
  } finally {
    store?.close();
    f.close();
  }
});

test("projecting the new points again, in each order of three events or after a restart, changes nothing", () => {
  const orders: number[][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const expected = [
    { state: "applied", memberId: "m-a" },
    { state: "applied", memberId: "m-esc" },
    { state: "applied", memberId: "m-s1" },
  ];
  for (const order of orders) {
    const f = fixture();
    let store: EvidenceStore | undefined;
    try {
      store = open(f);
      store.register(routingModule());
      seedAt(store, [
        { runId: RUN, taskId: "a", profileId: PROFILE, point: "start" },
        { runId: RUN, taskId: "a", profileId: ESCALATION_PROFILE, point: "escalation" },
        { runId: RUN, taskId: "s1", profileId: SCOUT_PROFILE, point: "scout" },
      ]);
      const events = [
        started(RUN, "a", "m-a", PROFILE),
        started(RUN, "a", "m-esc", ESCALATION_PROFILE, { replaces: { cause: "escalation" } }),
        runEvent("member.started", RUN, { taskId: "s1", memberId: "m-s1", data: { role: "scout", profileId: SCOUT_PROFILE } }),
      ];
      const sequenceEvents = order.map(index => events[index]);
      project(store, sequenceEvents);
      const once = [stateAt(store, RUN, "a", "start"), stateAt(store, RUN, "a", "escalation"), stateAt(store, RUN, "s1", "scout")];
      assert.deepEqual(once, expected, `order ${order.join(",")} applies each row once`);
      project(store, sequenceEvents);
      assert.deepEqual([stateAt(store, RUN, "a", "start"), stateAt(store, RUN, "a", "escalation"), stateAt(store, RUN, "s1", "scout")], once, `order ${order.join(",")} is idempotent`);
      store.close();
      store = open(f);
      store.register(routingModule());
      project(store, sequenceEvents);
      assert.deepEqual([stateAt(store, RUN, "a", "start"), stateAt(store, RUN, "a", "escalation"), stateAt(store, RUN, "s1", "scout")], once, `order ${order.join(",")} after a restart`);
    } finally {
      store?.close();
      f.close();
    }
  }
});
