import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { canonicalBytes, cappedBytes, objectiveRecordSchema, recordDigest } from "../packages/host/src/objective-types.js";
import type { Criterion, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { goalRecord, logValue, readStoredRecord, rebuildVersion, recordView, runRecord, syncDirections } from "../packages/host/src/objective-record.js";

const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const OTHER_GOAL_ID = "4b2d5f60-1c3e-4a7b-8d9f-a0b1c2d3e4f5";
const RUN_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const AT = "2026-11-14T10:00:00.000Z";
const MEMBER = "pm-member";

const at = (revision: number) => new Date(Date.UTC(2026, 10, 14, 10, 0, revision)).toISOString();
const steer = (revision: number, text: string) => ({ text, revision, at: at(revision) });

function goalFixture(overrides: Record<string, unknown> = {}): ProductGoal {
  return {
    id: GOAL_ID,
    objective: "Find ranked sources for the research brief.",
    successCriteria: "A ranked shortlist with reasons and sources",
    nonGoals: ["no paid sources", "no personal data"],
    allowedPaths: ["research"],
    evidence: ["notes.md"],
    steering: [],
    ...overrides,
  } as unknown as ProductGoal;
}

function runFixture(objective: string): TeamRun {
  return { id: RUN_ID, objective, steering: [] } as unknown as TeamRun;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("a goal record holds the owner's words as c0", () => {
  const built = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;
  assert.notEqual(built, "source-invalid");
  assert.equal(built.version, 1);
  assert.deepEqual(built.criteria, [{
    id: "c0",
    origin: "owner",
    statement: "A ranked shortlist with reasons and sources",
    check: { kind: "judgement", item: "owner-text" },
    producer: "evaluator",
    threshold: { kind: "pass" },
    state: "active",
  }]);
  assert.deepEqual(built.nonGoals, [{ id: "n1", text: "no paid sources" }, { id: "n2", text: "no personal data" }]);
  assert.deepEqual(built.ownerEvidence, ["notes.md"]);
  assert.deepEqual(built.constraints, { allowedPaths: ["research"], excludedPaths: [], rules: [] });
  assert.deepEqual(built.definitions, []);
  assert.deepEqual(built.assumptions, []);
  assert.deepEqual(built.questions, []);
  assert.deepEqual(built.statement.directions, []);
  assert.equal(built.rubricVersion, 1);
  assert.deepEqual(built.log, [{
    seq: 1, at: AT, version: 1, actor: "owner", authority: "direction", op: "record.created", target: "record", handle: GOAL_ID,
  }]);
  assert.equal(objectiveRecordSchema.safeParse(built).success, true);

  const migrated = goalRecord(goalFixture(), AT, "migrated") as ObjectiveRecord;
  assert.deepEqual(migrated.log, [{
    seq: 1, at: AT, version: 1, actor: "host", authority: "receipt", op: "record.migrated", target: "record",
  }]);
  assert.deepEqual({ ...migrated, log: [] }, { ...built, log: [] });
});

test("a run record refers to its objective", () => {
  const objective = "a".repeat(24000);
  const record = runRecord(runFixture(objective), AT, MEMBER) as ObjectiveRecord;
  assert.notEqual(record, "source-invalid");
  assert.equal(record.criteria[0].statement, "");
  assert.equal(record.criteria[0].statementOf, "objective");
  assert.equal(record.statement.objective, objective);
  assert.deepEqual(record.constraints.allowedPaths, ["."]);
  assert.deepEqual(record.log, [{
    seq: 1, at: AT, version: 1, actor: "host", authority: "receipt", op: "record.created", target: "record", handle: MEMBER,
  }]);
  assert.ok(cappedBytes(record) < 2048);
});

test("directions follow steering however the record was built", () => {
  const steering = [steer(2, "Use primary sources."), steer(3, "Drop paywalled pages."), steer(4, "Cite dates.")];
  const reference = syncDirections(
    goalRecord(goalFixture(), AT, "created") as ObjectiveRecord,
    steering,
    AT,
  ) as ObjectiveRecord;
  assert.deepEqual(reference.statement.directions, [
    { id: "s2", text: "Use primary sources.", source: "steering", at: at(2) },
    { id: "s3", text: "Drop paywalled pages.", source: "steering", at: at(3) },
    { id: "s4", text: "Cite dates.", source: "steering", at: at(4) },
  ]);
  assert.equal(reference.version, 4);

  for (let built = 0; built <= 3; built++) {
    let record = goalRecord(goalFixture({ steering: steering.slice(0, built) }), AT, "created") as ObjectiveRecord;
    for (let index = built; index < 3; index++) {
      record = syncDirections(record, steering.slice(0, index + 1), AT, {
        revision: steering[index].revision,
        handle: `member-${index}`,
      }) as ObjectiveRecord;
    }
    assert.deepEqual(record.statement.directions, reference.statement.directions);
    assert.equal(record.version, 4);
    assert.equal(record.digest, reference.digest);
    assert.equal(record.log.filter(entry => entry.op === "direction.copied").length, built);
    assert.equal(record.log.filter(entry => entry.op === "direction.appended").length, 3 - built);
    assert.equal(syncDirections(record, steering, AT), record);
  }

  const partial = goalRecord(goalFixture({ steering: [steering[0]] }), AT, "created") as ObjectiveRecord;
  const snapshot = structuredClone(partial);
  const synced = syncDirections(partial, steering, AT) as ObjectiveRecord;
  assert.deepEqual(partial, snapshot);
  assert.deepEqual(synced.statement.directions.map(item => item.id), ["s2", "s3", "s4"]);
  assert.deepEqual(synced.log.slice(-2).map(entry => [entry.op, entry.target, entry.actor]), [
    ["direction.copied", "s3", "host"],
    ["direction.copied", "s4", "host"],
  ]);
});

test("a long direction is logged by reference to the record", () => {
  const record = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;

  const long = "é".repeat(2000);
  const longRecord = syncDirections(record, [{ text: long, revision: 2, at: AT }], AT) as ObjectiveRecord;
  const direction = longRecord.statement.directions[0];
  const canonical = canonicalJson(JSON.parse(JSON.stringify(direction)));
  assert.deepEqual(longRecord.log[1].after, {
    ref: "record:direction:s2",
    digest: createHash("sha256").update(canonical).digest("hex"),
    bytes: Buffer.byteLength(canonical, "utf8"),
  });

  const shortRecord = syncDirections(record, [{ text: "Keep it short.", revision: 2, at: AT }], AT) as ObjectiveRecord;
  assert.deepEqual(shortRecord.log[1].after, { inline: shortRecord.statement.directions[0] });
  assert.deepEqual(logValue({ a: 1 }, "record:unused"), { inline: { a: 1 } });
});

test("every version rebuilds to what it was", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const random = mulberry32(seed);
    const count = Math.floor(random() * 21);
    const steering = Array.from({ length: count }, (_, index) => ({
      text: Array.from({ length: 1 + Math.floor(random() * 8000) }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join(""),
      revision: index + 1,
      at: at(index + 1),
    }));
    let record = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;
    const snapshots: ObjectiveRecord[] = [structuredClone(record)];
    for (let index = 0; index < count; index++) {
      const live = random() < 0.5 ? { revision: index + 1, handle: `member-${index + 1}` } : undefined;
      record = syncDirections(record, steering.slice(0, index + 1), AT, live) as ObjectiveRecord;
      snapshots.push(structuredClone(record));
    }
    assert.equal(snapshots.length, record.version);
    for (let version = 1; version <= record.version; version++) {
      const rebuilt = rebuildVersion(record, version);
      assert.deepEqual(rebuilt, snapshots[version - 1], `seed ${seed}, version ${version}`);
      assert.equal(rebuilt.digest, recordDigest(rebuilt), `seed ${seed}, version ${version}`);
    }
  }
});

test("a rebuild refuses what it cannot undo", () => {
  const synced = goalRecord(goalFixture({ steering: [steer(2, "Use primary sources.")] }), AT, "created") as ObjectiveRecord;
  assert.equal(synced.version, 2);
  const derived: Criterion = {
    id: "c1",
    origin: "derived",
    derivedFrom: "Find ranked",
    statement: "Each source has a date.",
    check: { kind: "command", command: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" },
    producer: "host",
    threshold: { kind: "pass" },
    state: "active",
  };
  const log = [
    ...synced.log.slice(0, 2),
    { seq: 3, at: AT, version: 3, actor: "host" as const, authority: "receipt" as const, op: "criterion.derived", target: "c1" },
  ];
  const record: ObjectiveRecord = { ...synced, version: 3, criteria: [...synced.criteria, derived], log, digest: "" };
  record.digest = recordDigest(record);
  assert.equal(objectiveRecordSchema.safeParse(record).success, true);

  assert.equal(rebuildVersion(record, 3).version, 3);
  assert.throws(() => rebuildVersion(record, 2), { status: 409, code: "objective-version-unavailable" });
  const missing = { ...record, log: [...record.log.slice(0, 2), { ...record.log[2], op: "direction.appended", authority: "direction" as const, actor: "owner" as const, target: "s9" }] } as ObjectiveRecord;
  assert.throws(() => rebuildVersion(missing, 2), { status: 409, code: "objective-version-unavailable" }, "an undo of a direction the record does not hold");
  assert.throws(() => rebuildVersion(record, 0), { status: 404, code: "objective-version-not-found" });
  assert.throws(() => rebuildVersion(record, 4), { status: 404, code: "objective-version-not-found" });

  const late = { ...record, log: record.log.slice(2) };
  assert.throws(() => rebuildVersion(late, 2), { status: 409, code: "objective-version-unavailable" });
});

test("a stored record is read strictly", () => {
  const owner = { kind: "goal", goalId: GOAL_ID } as const;
  const record = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;
  assert.deepEqual(readStoredRecord(undefined, owner), { kind: "absent" });
  assert.deepEqual(readStoredRecord(record, owner), { kind: "ready", record });

  const invalid = { kind: "unavailable", reason: "record-invalid" };
  const threeSteer = goalRecord(goalFixture({ steering: [steer(2, "Use primary sources."), steer(3, "Cite dates.")] }), AT, "created") as ObjectiveRecord;
  const historyOff = { ...threeSteer, log: threeSteer.log.map(entry => (entry.target === "s3" && entry.op.startsWith("direction.") ? { ...entry, target: "s2" } : entry)) };
  const damaged: unknown[] = [
    historyOff,
    { ...record, future: true },
    { ...record, digest: "0".repeat(64) },
    "a string",
    { schemaVersion: "2" },
  ];
  for (const raw of damaged) assert.deepEqual(readStoredRecord(raw, owner), invalid);
  assert.deepEqual(readStoredRecord(record, { kind: "goal", goalId: OTHER_GOAL_ID }), invalid);
  assert.deepEqual(readStoredRecord({ schemaVersion: 2, future: true }, owner), { kind: "unavailable", reason: "record-newer" });
});

test("the view returns a version and its log", () => {
  const record = goalRecord(goalFixture({ steering: [steer(2, "Use primary sources."), steer(3, "Cite dates.")] }), AT, "created") as ObjectiveRecord;

  const latest = recordView(record);
  assert.equal(latest.version, 3);
  assert.equal(latest.latestVersion, 3);
  assert.equal(latest.rebuilt, false);
  assert.equal("log" in latest.record, false);
  assert.equal(latest.log.length, 3);

  const older = recordView(record, 2);
  assert.equal(older.version, 2);
  assert.equal(older.latestVersion, 3);
  assert.equal(older.rebuilt, true);
  assert.equal(older.log.length, 2);
  assert.equal(older.record.statement.directions.length, 1);
});

test("a source outside the record's bounds is refused", () => {
  assert.equal(goalRecord(goalFixture({ successCriteria: "a".repeat(16001) }), AT, "created"), "source-invalid");
  assert.equal(goalRecord(goalFixture({ nonGoals: Array.from({ length: 21 }, (_, index) => `non-goal ${index}`) }), AT, "created"), "source-invalid");
  assert.equal(goalRecord(goalFixture({ allowedPaths: ["../x"] }), AT, "created"), "source-invalid");
  assert.equal(goalRecord(goalFixture({ objective: "o".repeat(12001) }), AT, "created"), "source-invalid");
  assert.equal(
    goalRecord(goalFixture({ steering: Array.from({ length: 41 }, (_, index) => steer(index + 1, `Direction ${index + 1}.`)) }), AT, "created"),
    "source-invalid",
  );

  const record = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;
  const before = structuredClone(record);
  assert.equal(syncDirections(record, [{ text: "Revision zero.", revision: 0, at: AT }], AT), "source-invalid");
  assert.deepEqual(record, before);
  assert.equal(syncDirections(record, Array.from({ length: 41 }, (_, index) => steer(index + 1, `Direction ${index + 1}.`)), AT), "source-invalid");
  assert.deepEqual(record, before);
});

test("the steering limit fits the log", () => {
  let record = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;
  const steering = Array.from({ length: 20 }, (_, index) => ({ text: "d".repeat(8000), revision: index + 1, at: at(index + 1) }));
  for (let index = 0; index < steering.length; index++) {
    record = syncDirections(record, steering.slice(0, index + 1), AT, { revision: index + 1, handle: "member-1" }) as ObjectiveRecord;
  }
  assert.equal(objectiveRecordSchema.safeParse(record).success, true);
  assert.equal(record.log.length, 21);
  assert.ok(canonicalBytes(record.log) < 16 * 1024);
});
