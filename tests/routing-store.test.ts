import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { EvidenceDb, EvidenceModule, EvidenceTx } from "../packages/host/src/evidence/types.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import {
  appliedOutcomeIds,
  computedPeriodEnd,
  decisionKey,
  insertDecision,
  markPeriodEnded,
  projectDecisions,
  readDecision,
  readProjectState,
  releaseRun,
  releaseStalePending,
  routingModule,
  settleStart,
  setExplorePause,
  shadowProgress,
  shareWindow,
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
  state?: DecisionRow["state"];
  memberId?: string | null;
  identity?: string;
  mode?: "shadow" | "auto";
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
    mode: spec.mode ?? "shadow",
    algorithmVersion: 1,
    rewardVersion: 1,
    policyDigest: "d".repeat(64),
    seed: "s".repeat(64),
    basis: "single-candidate",
    chosenProfileId: "astra-xhigh",
    chosenIdentity: spec.identity ?? "i".repeat(64),
    greedyProfileId: "astra-xhigh",
    coordinatorProfileId: "astra-xhigh",
    explore: spec.explore ?? false,
    state: spec.state ?? "recorded",
    memberId: spec.memberId ?? null,
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
      assert.ok(/routing_by_task|routing_by_project|routing_by_time|routing_by_state|sqlite_autoindex_routing_decisions/.test(text), `${plan.sql}: ${text}`);
    }
    // Shadow progress counts recorded rows only, so its statements seek routing_by_state.
    assert.ok(plans.some(plan => /routing_by_state/.test(plan.details.join(" | "))), "shadowProgress seeks routing_by_state");
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

test("the module is version 2 with no run hooks", () => {
  const module = routingModule();
  assert.deepEqual([module.name, module.version, module.readVersion], ["routing", 2, 1]);
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
    // A pending start row is not a recorded decision: it neither counts nor moves the first time.
    insertSpec(store, { projectId: "proj-a", taskId: "pend", state: "pending", decidedAt: daysBefore(60) });
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

/** Step 1's table set, copied here so a version 1 store can be built after the module changed. */
const V1_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS routing_decisions (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL, "
  + "task_key TEXT NOT NULL, point TEXT NOT NULL, ordinal INTEGER NOT NULL, project_ref TEXT NOT NULL, role TEXT NOT NULL, "
  + "area_ref TEXT, kind TEXT, risk TEXT NOT NULL, feature_version INTEGER NOT NULL, feature_map_ref TEXT NOT NULL, "
  + "mode TEXT NOT NULL, algorithm_version INTEGER NOT NULL, reward_version INTEGER NOT NULL, policy_digest TEXT NOT NULL, "
  + "seed TEXT NOT NULL, basis TEXT NOT NULL, chosen_profile_id TEXT NOT NULL, chosen_identity TEXT NOT NULL, "
  + "greedy_profile_id TEXT NOT NULL, coordinator_profile_id TEXT, explore INTEGER NOT NULL, state TEXT NOT NULL, "
  + "member_id TEXT, decided_at TEXT NOT NULL, encrypted_payload TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS routing_by_task ON routing_decisions (run_id, task_key, revision, point, ordinal)",
  "CREATE INDEX IF NOT EXISTS routing_by_project ON routing_decisions (project_ref, point, decided_at, key)",
  "CREATE INDEX IF NOT EXISTS routing_by_time ON routing_decisions (decided_at, key)",
];

function version1Module(): EvidenceModule {
  return {
    name: "routing",
    version: 1,
    readVersion: 1,
    migrate(tx) {
      for (const statement of V1_STATEMENTS) tx.exec(statement);
    },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const ALL_ROWS = "SELECT * FROM routing_decisions ORDER BY key";

function reopen(f: Fixture, module: EvidenceModule): EvidenceStore {
  const store = new EvidenceStore({ databasePath: f.path, vaultKey: f.key });
  store.register(module);
  return store;
}

test("a version 1 store migrates to version 2 and keeps every row", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = reopen(f, version1Module());
    for (let ordinal = 1; ordinal <= 3; ordinal++) insertSpec(store, { ordinal, decidedAt: daysBefore(ordinal) });
    const before = store.read(db => db.all(ALL_ROWS));
    store.close();
    store = reopen(f, routingModule());
    assert.equal(store.status().modules.routing, "ready");
    assert.deepEqual(store.read(db => db.all(ALL_ROWS)), before);
    assert.equal(before.length, 3);
    const names = store.read(db => db.all<{ name: string }>("SELECT name FROM sqlite_master").map(row => row.name));
    for (const name of ["routing_projects", "routing_by_state", "routing_by_identity"]) assert.ok(names.includes(name), name);
    assert.equal(store.read(db => db.get<{ version: number }>("SELECT version FROM schema_modules WHERE name='routing'"))?.version, 2);
  } finally {
    store?.close();
    f.close();
  }
});

test("a version 1 host leaves a version 2 store alone", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    insertSpec(store, { decidedAt: daysBefore(1) });
    store.close();
    store = reopen(f, version1Module());
    assert.equal(store.status().modules.routing, "unavailable");
    assert.equal(store.read(db => db.get<{ version: number }>("SELECT version FROM schema_modules WHERE name='routing'"))?.version, 2);
    assert.equal(store.read(db => db.all(ALL_ROWS)).length, 1);
  } finally {
    store?.close();
    f.close();
  }
});

test("the period end is the later of 14 days and the 50th recorded start, stored once", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  const DAY = DAY_MS;
  const first = Date.parse("2026-10-01T00:00:00.000Z");
  try {
    store = open(f);
    assert.equal(store.read(db => computedPeriodEnd(db, "proj-p")), undefined);
    for (let index = 0; index < 49; index++) insertSpec(store, { projectId: "proj-p", taskId: `t-${index}`, decidedAt: iso(first + index * 60_000) });
    // Rows that must not count: pending, applied, released, an escalation, and another project's start.
    insertSpec(store, { projectId: "proj-p", taskId: "pend", state: "pending", decidedAt: iso(first - DAY) });
    insertSpec(store, { projectId: "proj-p", taskId: "appl", state: "applied", decidedAt: iso(first - DAY) });
    insertSpec(store, { projectId: "proj-p", taskId: "rel", state: "released", decidedAt: iso(first - DAY) });
    insertSpec(store, { projectId: "proj-p", taskId: "esc", point: "escalation", decidedAt: iso(first - 2 * DAY) });
    insertSpec(store, { projectId: "proj-q", taskId: "other", decidedAt: iso(first - 2 * DAY) });
    assert.equal(store.read(db => computedPeriodEnd(db, "proj-p")), undefined, "49 recorded starts give no end");
    insertSpec(store, { projectId: "proj-p", taskId: "t-49", decidedAt: iso(first + 2 * DAY) });
    assert.deepEqual(store.read(db => computedPeriodEnd(db, "proj-p")), {
      firstAt: iso(first), fiftiethAt: iso(first + 2 * DAY), endsAt: iso(first + 14 * DAY),
    });
    // A 50th row 20 days after the first: the 50th's time is the later one.
    for (let index = 0; index < 49; index++) insertSpec(store, { projectId: "proj-late", taskId: `l-${index}`, decidedAt: iso(first + index * 60_000) });
    insertSpec(store, { projectId: "proj-late", taskId: "l-49", decidedAt: iso(first + 20 * DAY) });
    assert.equal(store.read(db => computedPeriodEnd(db, "proj-late"))?.endsAt, iso(first + 20 * DAY));
    // Stored once: the first mark wins, and it survives a sweep of the oldest rows.
    const X = iso(first + 30 * DAY);
    const Y = iso(first + 40 * DAY);
    assert.equal(store.write(tx => markPeriodEnded(tx, "proj-p", X, NOW)), X);
    assert.equal(store.write(tx => markPeriodEnded(tx, "proj-p", Y, NOW)), X);
    assert.equal(sweepExpiredDecisions(store, iso(first + 200 * DAY), 10), 10);
    assert.equal(store.read(db => readProjectState(db, "proj-p")).periodEndedAt, X);
  } finally {
    store?.close();
    f.close();
  }
});

test("the pause is kept per project, and a second pause keeps the first time", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  const A = "2026-11-15T09:00:00.000Z";
  const B = "2026-11-15T10:00:00.000Z";
  try {
    store = open(f);
    assert.deepEqual(store.read(db => readProjectState(db, "proj-x")), { periodEndedAt: null, explorePausedAt: null });
    assert.equal(store.write(tx => setExplorePause(tx, "proj-x", A, NOW)), A);
    assert.equal(store.write(tx => setExplorePause(tx, "proj-x", B, NOW)), A);
    assert.equal(store.read(db => readProjectState(db, "proj-x")).explorePausedAt, A);
    assert.equal(store.write(tx => setExplorePause(tx, "proj-x", null, NOW)), null);
    assert.equal(store.read(db => readProjectState(db, "proj-x")).explorePausedAt, null);
    // A stored period end survives a pause and a resume.
    store.write(tx => markPeriodEnded(tx, "proj-x", A, NOW));
    store.write(tx => setExplorePause(tx, "proj-x", B, NOW));
    store.write(tx => setExplorePause(tx, "proj-x", null, NOW));
    assert.equal(store.read(db => readProjectState(db, "proj-x")).periodEndedAt, A);
  } finally {
    store?.close();
    f.close();
  }
});

test("the share window counts the newest pending and applied starts, and stale pending rows are released", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    const P = "proj-s";
    insertSpec(store, { projectId: P, taskId: "fp-1", state: "pending", explore: true, decidedAt: daysBefore(1) });
    insertSpec(store, { projectId: P, taskId: "fp-2", state: "pending", explore: true, decidedAt: daysBefore(2) });
    insertSpec(store, { projectId: P, taskId: "ap-1", state: "applied", explore: true, decidedAt: daysBefore(20) });
    insertSpec(store, { projectId: P, taskId: "ap-2", state: "applied", explore: false, decidedAt: daysBefore(40) });
    insertSpec(store, { projectId: P, taskId: "ap-3", state: "applied", explore: false, decidedAt: daysBefore(90) });
    insertSpec(store, { projectId: P, taskId: "rel-1", state: "released", explore: true, decidedAt: daysBefore(1) });
    insertSpec(store, { projectId: P, taskId: "rec-1", state: "recorded", explore: true, decidedAt: daysBefore(1) });
    insertSpec(store, { projectId: P, taskId: "esc-1", point: "escalation", state: "applied", explore: true, decidedAt: daysBefore(1) });
    insertSpec(store, { projectId: "proj-other", taskId: "oth-1", state: "applied", explore: true, decidedAt: daysBefore(1) });
    insertSpec(store, { projectId: P, taskId: "stale-1", state: "pending", explore: true, decidedAt: daysBefore(8) });
    assert.deepEqual(store.read(db => shareWindow(db, P, 10, NOW)), { exploratory: 3, of: 5 });
    // Twelve applied starts: window 10 caps the share at 9, the newest by time.
    for (let index = 0; index < 12; index++) {
      insertSpec(store, { projectId: "proj-q", taskId: `q-${index}`, state: "applied", explore: index < 2, decidedAt: daysBefore(30 + index) });
    }
    assert.deepEqual(store.read(db => shareWindow(db, "proj-q", 10, NOW)), { exploratory: 2, of: 9 });
    // 101 stale pending rows: 100 are released, oldest first.
    const stale = Date.parse(NOW) - 8 * DAY_MS;
    for (let index = 0; index <= 100; index++) {
      insertSpec(store, { projectId: "proj-stale", taskId: `sp-${index}`, state: "pending", decidedAt: iso(stale - index * 1000) });
    }
    assert.equal(store.write(tx => releaseStalePending(tx, "proj-stale", NOW)), 100);
    const stateOf = (taskId: string) => store?.read(db => readDecision(db, decisionKey("run-1", 1, db.index("task", taskId), "start", 1))?.state);
    assert.equal(stateOf("sp-0"), "pending");
    assert.equal(stateOf("sp-1"), "released");
    assert.equal(stateOf("sp-100"), "released");
  } finally {
    store?.close();
    f.close();
  }
});

test("applied outcome ids are one identity's applied starts, newest first, at most 2,000", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  const base = Date.parse("2026-11-01T00:00:00.000Z");
  try {
    store = open(f);
    store.write(tx => {
      for (let index = 0; index <= 2000; index++) {
        insertDecision(tx, rowOf(tx, {
          projectId: "proj-a", runId: `run-${index}`, taskId: `ai-${index}`, state: "applied", memberId: `m-${index}`,
          identity: "ident-x", decidedAt: iso(base + index * 1000),
        }), payloadOf({ projectId: "proj-a" }));
      }
    });
    const newer = iso(base + 5_000_000);
    insertSpec(store, { projectId: "proj-a", runId: "pend-run", taskId: "pn", state: "pending", memberId: "pend-m", identity: "ident-x", decidedAt: newer });
    insertSpec(store, { projectId: "proj-a", runId: "rel-run", taskId: "rn", state: "released", memberId: "rel-m", identity: "ident-x", decidedAt: newer });
    insertSpec(store, { projectId: "proj-a", runId: "esc-run", taskId: "en", point: "escalation", state: "applied", memberId: "esc-m", identity: "ident-x", decidedAt: newer });
    insertSpec(store, { projectId: "proj-a", runId: "other-run", taskId: "on", state: "applied", memberId: "other-m", identity: "ident-y", decidedAt: newer });
    insertSpec(store, { projectId: "proj-a", runId: "old-run", taskId: "old", state: "applied", memberId: "old-m", identity: "ident-x", decidedAt: iso(base - 1000) });
    const ids = store.read(db => appliedOutcomeIds(db, "ident-x", iso(base)));
    assert.equal(ids.size, 2000);
    assert.ok(ids.has("run-2000:m-2000"));
    assert.ok(ids.has("run-1:m-1"));
    assert.ok(!ids.has("run-0:m-0"), "the oldest applied start is past the limit");
    for (const excluded of ["pend-run:pend-m", "rel-run:rel-m", "esc-run:esc-m", "other-run:other-m", "old-run:old-m"]) {
      assert.ok(!ids.has(excluded), excluded);
    }
  } finally {
    store?.close();
    f.close();
  }
});

/** Records every statement a read or a write issues, so its plan can be checked. */
type Recorded = { sql: string; params: unknown[] };
function recording<T extends EvidenceDb>(target: T, log: Recorded[]): T {
  const wrapped: Record<string, unknown> = {
    ...target,
    get: (sql: string, ...params: unknown[]) => { log.push({ sql, params }); return target.get(sql, ...(params as never[])); },
    all: (sql: string, ...params: unknown[]) => { log.push({ sql, params }); return target.all(sql, ...(params as never[])); },
  };
  if ("run" in target) {
    const tx = target as unknown as EvidenceTx;
    wrapped.run = (sql: string, ...params: unknown[]) => { log.push({ sql, params }); return tx.run(sql, ...(params as never[])); };
  }
  return wrapped as T;
}

test("version 2 reads seek their indexes", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  try {
    store = open(f);
    for (let index = 0; index < 3; index++) insertSpec(store, { projectId: "proj-a", taskId: `r-${index}`, decidedAt: daysBefore(index + 1) });
    insertSpec(store, { projectId: "proj-a", taskId: "pend", state: "pending", identity: "ident-x", decidedAt: daysBefore(1) });
    insertSpec(store, { projectId: "proj-a", taskId: "appl", state: "applied", identity: "ident-x", memberId: "m-1", decidedAt: daysBefore(1) });
    const key = store.read(db => decisionKey("run-1", 1, db.index("task", "pend"), "start", 1));
    const log: Recorded[] = [];
    store.read(db => {
      const reader = recording(db, log);
      readProjectState(reader, "proj-a");
      computedPeriodEnd(reader, "proj-a");
      shareWindow(reader, "proj-a", 10, NOW);
      appliedOutcomeIds(reader, "ident-x", daysBefore(180));
      shadowProgress(reader, "proj-a");
    });
    store.write(tx => {
      const writer = recording(tx, log);
      markPeriodEnded(writer, "proj-a", NOW, NOW);
      setExplorePause(writer, "proj-a", NOW, NOW);
      releaseStalePending(writer, "proj-a", NOW);
      settleStart(writer, key as string, "m-2", "astra-xhigh");
      releaseRun(writer, "run-1", 2);
    });
    // The inner selects of the two release statements, as the plan writes them.
    log.push({ sql: "SELECT key FROM routing_decisions WHERE project_ref=? AND point='start' AND state='pending' AND decided_at < ? ORDER BY decided_at, key LIMIT 100", params: ["x", NOW] });
    log.push({ sql: "SELECT key FROM routing_decisions WHERE run_id=? AND state='pending' AND revision < ? LIMIT 200", params: ["run-1", 2] });
    assert.ok(log.length >= 12, "the reads and writes issue statements");
    // A read of many decision rows carries a bounded row limit, so its cost does not grow with the project's history.
    for (const { sql, params } of log) {
      if (!/^SELECT\b/.test(sql) || !/\bFROM routing_decisions\b/.test(sql) || /\bkey\s*=\s*\?/.test(sql)) continue;
      assert.match(sql, /\bLIMIT\b/, `${sql}: no row limit`);
      for (const value of params) if (typeof value === "number") assert.ok(value >= 0 && value <= 10_000, `${sql}: bound ${value}`);
    }
    const plans = store.read(db => log.map(({ sql, params }) => ({
      sql,
      text: db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(params as never[])).map(row => row.detail).join(" | "),
    })));
    const seek = /SEARCH .*(routing_by_state|routing_by_identity|routing_by_task|sqlite_autoindex_routing_(decisions|projects)_\d+)/;
    for (const plan of plans) {
      assert.ok(!/SCAN routing_(decisions|projects)\b/.test(plan.text), `${plan.sql}: ${plan.text}`);
      assert.ok(!/TEMP B-TREE/.test(plan.text), `${plan.sql}: ${plan.text}`);
      if (!plan.sql.startsWith("INSERT")) assert.ok(seek.test(plan.text), `${plan.sql}: ${plan.text}`);
    }
  } finally {
    store?.close();
    f.close();
  }
});

test("applied ids at the escalation point seek routing_by_identity", () => {
  const f = fixture();
  let store: EvidenceStore | undefined;
  const since = daysBefore(30);
  const sql = "SELECT run_id, member_id FROM routing_decisions WHERE chosen_identity=? AND point=? AND state='applied' "
    + "AND decided_at>=? ORDER BY decided_at DESC LIMIT 2000";
  try {
    store = open(f);
    insertSpec(store, { projectId: "proj-a", runId: "r-start", taskId: "t1", state: "applied", memberId: "m-start", identity: "ident-e", decidedAt: daysBefore(1) });
    insertSpec(store, { projectId: "proj-a", runId: "r-esc", taskId: "t2", point: "escalation", state: "applied", memberId: "m-esc", identity: "ident-e", decidedAt: daysBefore(1) });
    const escalation = store.read(db => appliedOutcomeIds(db, "ident-e", since, "escalation"));
    assert.deepEqual([...escalation], ["r-esc:m-esc"], "an applied escalation row is not an applied start");
    const start = store.read(db => appliedOutcomeIds(db, "ident-e", since));
    assert.deepEqual([...start], ["r-start:m-start"], "an applied start row is not an applied escalation");
    const plan = store.read(db => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, "ident-e", "escalation", since).map(row => row.detail).join(" | "));
    assert.match(plan, /SEARCH .*routing_by_identity/, plan);
    assert.doesNotMatch(plan, /SCAN routing_decisions/, plan);
    assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
  } finally {
    store?.close();
    f.close();
  }
});
