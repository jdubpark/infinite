import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceDb, EvidenceTx } from "../packages/host/src/evidence/types.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import {
  decisionKey,
  insertDecision,
  projectDecisions,
  readDecision,
  routingModule,
  shadowProgress,
  sweepExpiredDecisions,
  taskDecisions,
  projectCells,
  ROUTING_RETENTION_DAYS,
  PAYLOAD_LIMIT_BYTES,
} from "../packages/host/src/routing-store.js";
import { ROUTING_DEFAULTS } from "../packages/host/src/routing-policy.js";
import type { DecisionRow, RoutingPayload, RoutingPoint } from "../packages/host/src/routing-types.js";

const NOW = "2026-11-15T12:00:00.000Z";
const DAY_MS = 86_400_000;
const daysBefore = (days: number) => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

type Fixture = { root: string; path: string; key: Buffer; close: () => void };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "infinite-routing-store-"));
  return {
    root,
    path: evidenceDatabasePath(join(root, "state")),
    key: randomBytes(32),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function open(f: Fixture): EvidenceStore {
  const store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => NOW }));
  store.register(routingModule());
  return store;
}

type Spec = {
  runId?: string;
  taskId?: string;
  ordinal?: number;
  revision?: number;
  decidedAt?: string;
  projectId?: string;
  area?: string;
  featureMap?: string;
  explore?: boolean;
  point?: RoutingPoint;
  elapsedMs?: number;
};

const PLAIN_SECRETS = ["proj-alpha-secret", "task-beta-secret", "area-gamma-secret", "map-delta-secret"];

function payloadOf(spec: Spec): RoutingPayload {
  return {
    projectId: spec.projectId ?? "proj-alpha-secret",
    taskId: spec.taskId ?? "task-beta-secret",
    area: spec.area ?? "area-gamma-secret",
    featureMap: spec.featureMap ?? "map-delta-secret",
    coordinatorProfileId: "astra-xhigh",
    knobs: ROUTING_DEFAULTS,
    costs: { lightUsd: 0.4, strongUsd: 2.2, rescueUsd: 1.5, basis: "tier-default" },
    headroom: "not-modelled",
    chosenWeight: 0.5,
    current: [],
    candidates: [],
    elapsedMs: spec.elapsedMs ?? 1,
  };
}

/** The plain row of a spec, with its blind indexes computed inside the write. */
function rowOf(tx: EvidenceTx, spec: Spec): DecisionRow {
  const runId = spec.runId ?? "run-1";
  const taskId = spec.taskId ?? "task-beta-secret";
  const ordinal = spec.ordinal ?? 1;
  const revision = spec.revision ?? 1;
  const featureMap = spec.featureMap ?? "map-delta-secret";
  return {
    key: decisionKey(runId, revision, tx.index("task", taskId), spec.point ?? "start", ordinal),
    runId,
    revision,
    taskKey: tx.index("task", taskId),
    point: spec.point ?? "start",
    ordinal,
    projectRef: tx.index("project", spec.projectId ?? "proj-alpha-secret"),
    role: "implementer",
    areaRef: tx.index("area", spec.area ?? "area-gamma-secret"),
    kind: "feature",
    risk: "normal",
    featureVersion: 1,
    featureMapRef: tx.index("feature-map", featureMap),
    mode: "shadow",
    algorithmVersion: 1,
    rewardVersion: 1,
    policyDigest: "d".repeat(64),
    seed: "s".repeat(64),
    basis: "single-candidate",
    chosenProfileId: "astra-xhigh",
    chosenIdentity: "i".repeat(64),
    greedyProfileId: "astra-xhigh",
    coordinatorProfileId: "astra-xhigh",
    explore: spec.explore ?? false,
    state: "recorded",
    memberId: null,
    decidedAt: spec.decidedAt ?? NOW,
  };
}

function insertSpec(store: EvidenceStore, spec: Spec): boolean {
  return store.write(tx => insertDecision(tx, rowOf(tx, spec), payloadOf(spec)));
}

test("a decision is stored once per key", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const first = store.write(tx => {
      const row = rowOf(tx, { explore: true });
      return { row, stored: insertDecision(tx, row, payloadOf({})) };
    });
    assert.equal(first.stored, true);
    assert.equal(store.write(tx => insertDecision(tx, rowOf(tx, { explore: true }), payloadOf({}))), false);
    const stored = store.read(db => readDecision(db, first.row.key));
    assert.deepEqual(stored, first.row);
    // An exploratory decision is stored as 0 or 1 and read back as a boolean.
    assert.equal(stored?.explore, true);
    assert.equal(store.read(db => db.get<{ explore: number }>("SELECT explore FROM routing_decisions")?.explore), 1);
    assert.equal(store.read(db => routingModule().counts?.(db).decisions), 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("plain columns hold no clear text", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    insertSpec(store, { taskId: "task-beta-secret" });
    const plain = store.read(db => db.all<Record<string, unknown>>("SELECT * FROM routing_decisions"));
    assert.equal(plain.length, 1);
    const { encrypted_payload: sealed, ...columns } = plain[0]!;
    assert.equal(typeof sealed, "string");
    for (const [name, value] of Object.entries(columns)) {
      for (const secret of PLAIN_SECRETS) assert.ok(!String(value).includes(secret), `${name} holds ${secret}`);
    }
    for (const secret of PLAIN_SECRETS) assert.ok(!String(sealed).includes(secret), "the sealed payload holds clear text");
    // The payload opens to the clear values through the task read.
    const opened = store.read(db => taskDecisions(db, "run-1", "task-beta-secret"));
    assert.equal(opened.rows[0]?.payload?.taskId, "task-beta-secret");
    assert.equal(opened.rows[0]?.payload?.projectId, "proj-alpha-secret");
    assert.equal(opened.rows[0]?.payload?.area, "area-gamma-secret");
    assert.equal(opened.rows[0]?.payload?.featureMap, "map-delta-secret");
  } finally {
    store?.close();
    f.close();
  }
});

test("task decisions are bounded and survive an unreadable payload", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    for (let ordinal = 1; ordinal <= 21; ordinal++) insertSpec(store, { ordinal });
    const bounded = store.read(db => taskDecisions(db, "run-1", "task-beta-secret"));
    assert.equal(bounded.rows.length, 20);
    assert.equal(bounded.capped, true);

    store.write(tx => tx.run("UPDATE routing_decisions SET encrypted_payload='x' WHERE ordinal=1"));
    const mixed = store.read(db => taskDecisions(db, "run-1", "task-beta-secret"));
    assert.equal(mixed.rows.length, 20);
    assert.equal(mixed.rows[0]?.ordinal, 1);
    assert.equal(mixed.rows[0]?.payload, null);
    assert.equal(mixed.rows[1]?.payload?.taskId, "task-beta-secret");
    assert.equal(mixed.rows[19]?.payload?.taskId, "task-beta-secret");
  } finally {
    store?.close();
    f.close();
  }
});

test("a payload over its limit is refused and stores nothing", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const big = { ...payloadOf({}), area: "x".repeat(PAYLOAD_LIMIT_BYTES) };
    assert.throws(() => store!.write(tx => insertDecision(tx, rowOf(tx, {}), big)), RangeError);
    assert.equal(store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM routing_decisions")?.n), 0);
  } finally {
    store?.close();
    f.close();
  }
});

test("retention removes decisions after 180 days, at most the limit per call", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    assert.equal(ROUTING_RETENTION_DAYS, 180);
    insertSpec(store, { ordinal: 1, decidedAt: daysBefore(181) });
    insertSpec(store, { ordinal: 2, decidedAt: daysBefore(179) });
    assert.equal(sweepExpiredDecisions(store, NOW), 1);
    const left = store.read(db => db.all<{ ordinal: number }>("SELECT ordinal FROM routing_decisions"));
    assert.deepEqual(left.map(row => row.ordinal), [2]);

    for (let ordinal = 3; ordinal <= 5; ordinal++) insertSpec(store, { ordinal, decidedAt: daysBefore(200) });
    assert.equal(sweepExpiredDecisions(store, NOW, 2), 2);
    assert.equal(sweepExpiredDecisions(store, NOW), 1);
    assert.equal(store.read(db => db.get<{ n: number }>("SELECT count(*) AS n FROM routing_decisions")?.n), 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("decision reads seek their indexes", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    for (let ordinal = 1; ordinal <= 3; ordinal++) insertSpec(store, { ordinal, decidedAt: daysBefore(ordinal) });
    // Record every statement the reads issue, then ask SQLite for its plan.
    const statements: { sql: string; params: unknown[] }[] = [];
    store.read(db => {
      const recording: EvidenceDb = {
        ...db,
        get: <T>(sql: string, ...params: unknown[]) => { statements.push({ sql, params }); return db.get<T>(sql, ...(params as never[])); },
        all: <T>(sql: string, ...params: unknown[]) => { statements.push({ sql, params }); return db.all<T>(sql, ...(params as never[])); },
      } as EvidenceDb;
      readDecision(recording, decisionKey("run-1", 1, db.index("task", "task-beta-secret"), "start", 1));
      taskDecisions(recording, "run-1", "task-beta-secret");
      projectDecisions(recording, "proj-alpha-secret", daysBefore(180));
      projectCells(recording, "proj-alpha-secret", daysBefore(180), 10);
      shadowProgress(recording, "proj-alpha-secret");
    });
    const plans = store.read(db => statements.map(({ sql, params }) => ({
      sql: sql.split(/\s+/).slice(0, 4).join(" "),
      details: db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(params as never[])).map(row => row.detail),
    })));
    assert.ok(plans.length >= 5, "the reads issue statements");
    for (const plan of plans) {
      const text = plan.details.join(" | ");
      assert.ok(!/SCAN routing_decisions\b/.test(text), `${plan.sql}: ${text}`);
      assert.ok(!/TEMP B-TREE/.test(text), `${plan.sql}: ${text}`);
      assert.ok(/routing_by_task|routing_by_project|routing_by_time|sqlite_autoindex_routing_decisions/.test(text), `${plan.sql}: ${text}`);
    }
    // The sweep's inner select seeks the time index.
    const sweep = store.read(db => db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT key FROM routing_decisions WHERE decided_at < ? ORDER BY decided_at, key LIMIT ?",
      NOW, 100,
    ).map(row => row.detail).join(" | "));
    assert.ok(/routing_by_time/.test(sweep), sweep);
    assert.ok(!/TEMP B-TREE/.test(sweep), sweep);
  } finally {
    store?.close();
    f.close();
  }
});

test("the decision key is the sha256 of the plan's formula, revision included", () => {
  // Golden: sha256 of "run-1|2|tref|start|1", computed with shasum -a 256.
  assert.equal(decisionKey("run-1", 2, "tref", "start", 1), "680d338d30412343f58997852609c82ff8f6e9ea6aa07dccaffe29fa364c6c82");
  assert.notEqual(decisionKey("run-1", 2, "tref", "start", 1), decisionKey("run-1", 1, "tref", "start", 1));
});

test("the module is version 1 with no run hooks", () => {
  const module = routingModule();
  assert.deepEqual([module.name, module.version, module.readVersion], ["routing", 1, 1]);
  assert.equal(module.deleteRun, undefined);
  assert.equal(module.runIds, undefined);
});

test("project decisions are start rows of the project since the bound, newest first, at most 500", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const since = daysBefore(30);
    const insert = (spec: Spec) => insertSpec(store!, { projectId: "proj-a", ...spec });
    insert({ taskId: "t1", decidedAt: daysBefore(1) });
    insert({ taskId: "t2", decidedAt: daysBefore(2) });
    insert({ taskId: "t3", decidedAt: since });
    insert({ taskId: "t4", decidedAt: daysBefore(31) });
    insert({ taskId: "t5", point: "escalation", decidedAt: daysBefore(1) });
    insert({ taskId: "t6", projectId: "proj-b", decidedAt: daysBefore(1) });
    const keyOf = (taskId: string) => store!.read(db => decisionKey("run-1", 1, db.index("task", taskId), "start", 1));
    const read = store.read(db => projectDecisions(db, "proj-a", since));
    // The bound is inclusive; escalation rows and other projects are left out.
    assert.deepEqual(read.rows.map(row => row.key), ["t1", "t2", "t3"].map(keyOf));
    assert.equal(read.capped, false);
    for (let index = 0; index < 498; index++) insert({ taskId: `bulk-${index}`, decidedAt: daysBefore(3) });
    const full = store.read(db => projectDecisions(db, "proj-a", since));
    assert.deepEqual([full.rows.length, full.capped, full.rows[0]!.key], [500, true, keyOf("t1")]);
  } finally {
    store?.close();
    f.close();
  }
});

test("project cells keep the newest row of each four-part cell, at most the limit", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    insertSpec(store, { projectId: "proj-a", taskId: "new", decidedAt: daysBefore(1), elapsedMs: 11 });
    insertSpec(store, { projectId: "proj-a", taskId: "old", decidedAt: daysBefore(2), elapsedMs: 22 });
    insertSpec(store, { projectId: "proj-a", taskId: "map", decidedAt: daysBefore(3), featureMap: "f".repeat(64), elapsedMs: 33 });
    const two = store.read(db => projectCells(db, "proj-a", daysBefore(30), 2));
    assert.deepEqual([two.cells.map(cell => cell.payload?.elapsedMs), two.capped], [[11, 33], false]);
    const one = store.read(db => projectCells(db, "proj-a", daysBefore(30), 1));
    assert.deepEqual([one.cells.map(cell => cell.payload?.elapsedMs), one.capped], [[11], true]);
  } finally {
    store?.close();
    f.close();
  }
});

test("shadow progress counts start rows up to 50 and names the first time", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    for (let index = 0; index < 49; index++) insertSpec(store, { projectId: "proj-a", taskId: `t-${index}`, decidedAt: daysBefore(index + 1) });
    insertSpec(store, { projectId: "proj-a", taskId: "esc", point: "escalation", decidedAt: daysBefore(90) });
    assert.deepEqual(store.read(db => shadowProgress(db, "proj-a")), { decisions: 49, capped: false, firstAt: daysBefore(49) });
    for (let index = 0; index < 3; index++) insertSpec(store, { projectId: "proj-a", taskId: `late-${index}` });
    assert.deepEqual(store.read(db => shadowProgress(db, "proj-a")), { decisions: 50, capped: true, firstAt: daysBefore(49) });
    assert.deepEqual(store.read(db => shadowProgress(db, "proj-b")), { decisions: 0, capped: false, firstAt: null });
  } finally {
    store?.close();
    f.close();
  }
});

test("the sweep keeps 180 days, removes the oldest first and 100 by default, never throws, and a deleted run keeps its rows", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    insertSpec(store, { ordinal: 1, decidedAt: daysBefore(180) });
    insertSpec(store, { ordinal: 2, decidedAt: daysBefore(180.5) });
    insertSpec(store, { ordinal: 3, decidedAt: daysBefore(300) });
    const left = () => store!.read(db => db.all<{ ordinal: number }>("SELECT ordinal FROM routing_decisions ORDER BY ordinal")).map(row => row.ordinal);
    // Exactly 180 days old is kept; the oldest (300 days) goes first.
    assert.equal(sweepExpiredDecisions(store, NOW, 1), 1);
    assert.deepEqual(left(), [1, 2]);
    assert.equal(sweepExpiredDecisions(store, NOW), 1);
    assert.deepEqual(left(), [1]);
    assert.equal(store.deleteRun("run-1"), true);
    assert.deepEqual(left(), [1], "a deleted run keeps its decision rows");
    for (let index = 0; index < 101; index++) insertSpec(store, { runId: "run-2", ordinal: index + 1, decidedAt: daysBefore(200) });
    assert.equal(sweepExpiredDecisions(store, NOW), 100);
    store.close();
    assert.equal(sweepExpiredDecisions(store, NOW), 0, "never throws on a closed store");
    store = undefined;
  } finally {
    store?.close();
    f.close();
  }
});
