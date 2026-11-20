import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { canonicalBytes, cappedBytes, objectiveRecordSchema, recordDigest } from "../packages/host/src/objective-types.js";
import type { Assumption, Criterion, Direction, LogEntry, ObjectiveRecord, Question } from "../packages/host/src/objective-types.js";
import { INTENT_OPS, OBJECTIVE_ERRORS, goalRecord, logValue, objectiveError, readStoredRecord, rebuildVersion, recordView, runRecord, syncDirections } from "../packages/host/src/objective-record.js";
import type { ObjectiveErrorCode } from "../packages/host/src/objective-record.js";

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

/** Request ids of the corrections that wrote the log, one per version after the first, as the host writes them. */
const REQUEST_IDS = [
  "2b7e1c90-4d3a-4f6b-8a21-5c9d0e7f1a34",
  "6a0f3d52-9e1b-4c7d-b8e4-2f5a6c7d8e90",
  "c4d8e6f1-0a2b-4e3c-9d5f-7a8b9c0d1e2f",
  "e9f1a3b5-6c7d-4e8f-a0b1-c2d3e4f5a6b7",
] as const;

function withEntry(record: ObjectiveRecord, seq: number, extra: Partial<LogEntry>): ObjectiveRecord {
  const changed = { ...record, log: record.log.map(item => (item.seq === seq ? { ...item, ...extra } : item)) } as ObjectiveRecord;
  changed.digest = recordDigest(changed);
  return changed;
}

test("a rebuild undoes owner corrections", () => {
  const base = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;
  const c0 = base.criteria[0];
  const c1: Criterion = {
    id: "c1", origin: "owner", statement: "Each source has a date.", check: { kind: "judgement", item: "dates" },
    producer: "evaluator", threshold: { kind: "pass" }, state: "active",
  };
  const c2: Criterion = {
    id: "c2", origin: "owner", statement: "Two sources agree.", check: { kind: "judgement", item: "agreement" },
    producer: "evaluator", threshold: { kind: "pass" }, state: "active",
  };
  const c1Edited: Criterion = { ...c1, statement: "Each source has a date and a URL." };
  const c2Retired: Criterion = { ...c2, state: "retired" };
  const direction: Direction = { id: "s2", text: "Use primary sources.", source: "steering", at: at(2) };
  const entry = (seq: number, version: number, op: string, target: string, handle: string, extra: Partial<LogEntry>): LogEntry =>
    ({ seq, at: AT, version, actor: "owner", authority: "direction", op, target, handle, ...extra });
  const log: LogEntry[] = [
    base.log[0],
    entry(2, 1, "criterion.added", "c2", REQUEST_IDS[1], { after: { inline: c2 } }),
    entry(3, 2, "criterion.added", "c1", REQUEST_IDS[2], { after: { inline: c1 } }),
    entry(4, 3, "direction.appended", "s2", REQUEST_IDS[3], { after: logValue(direction, "record:direction:s2") }),
    entry(5, 4, "criterion.retired", "c2", REQUEST_IDS[4], { before: { inline: c2 }, after: { inline: c2Retired } }),
    entry(6, 4, "criterion.edited", "c1", REQUEST_IDS[4], { before: { inline: c1 }, after: { inline: c1Edited } }),
  ];
  const record = {
    ...base, version: 4, criteria: [c0, c2Retired, c1Edited], statement: { ...base.statement, directions: [direction] }, log, digest: "",
  } as ObjectiveRecord;
  record.digest = recordDigest(record);
  assert.equal(objectiveRecordSchema.safeParse(record).success, true);

  const expected = (version: number, criteria: Criterion[], directions: Direction[]): ObjectiveRecord => {
    const snapshot = {
      ...base, version, criteria, statement: { ...base.statement, directions }, log: log.filter(item => item.version <= version), digest: "",
    } as ObjectiveRecord;
    snapshot.digest = recordDigest(snapshot);
    return snapshot;
  };
  assert.deepEqual(rebuildVersion(record, 3), expected(3, [c0, c2, c1], [direction]));
  assert.deepEqual(rebuildVersion(record, 2), expected(2, [c0, c2, c1], []));
  assert.deepEqual(rebuildVersion(record, 1), expected(1, [c0, c2], []));

  const drifted = {
    ...record,
    log: record.log.map(item => (item.seq === 6 ? { ...item, after: { inline: { ...c1Edited, statement: "Each source has a date and a URL!" } } } : item)),
  } as ObjectiveRecord;
  assert.throws(() => rebuildVersion(drifted, 3), { status: 409, code: "objective-version-unavailable" });

  // An edit whose logged `before` names another criterion would restore a version that never existed.
  const renamed = withEntry(record, 6, { before: { inline: { ...c1, id: "c9" } }, after: { inline: c1Edited } });
  assert.equal(objectiveRecordSchema.safeParse(renamed).success, true);
  assert.throws(() => rebuildVersion(renamed, 3), { status: 409, code: "objective-version-unavailable" });

  // An edit whose logged `before` breaks the producer rule: the restored record would not parse.
  const misfit = withEntry(record, 6, { before: { inline: { ...c1, producer: "host" } }, after: { inline: c1Edited } });
  assert.equal(objectiveRecordSchema.safeParse(misfit).success, true);
  assert.throws(() => rebuildVersion(misfit, 3), { status: 409, code: "objective-version-unavailable" });
});

test("a rebuild undoes the intent check", () => {
  const CHECKER = "intent-checker-1";
  const DECISION = "9d3f2b1a-5c4e-4f70-8a1b-2c3d4e5f6a7b";
  const DECISION_TWO = "1e2f3a4b-5c6d-4e7f-8091-a2b3c4d5e6f7";
  const digestOf = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");
  /** Seals a hand-built record the way the host does: the digest covers the record, not its log's digest. */
  const sealed = (record: Omit<ObjectiveRecord, "digest">): ObjectiveRecord => {
    const body = { ...record, digest: "" } as ObjectiveRecord;
    body.digest = recordDigest(body);
    return body;
  };

  const base = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;
  const c1: Criterion = {
    id: "c1", origin: "derived", derivedFrom: "Find ranked", statement: "Each source has a date.",
    check: { kind: "judgement", item: "dates" }, producer: "evaluator", threshold: { kind: "pass" }, state: "active",
  };
  const a1: Assumption = {
    id: "a1", statement: "Sources carry dates.", status: "unchecked", origin: "intent-check", criticality: "outcome",
    refutedBy: "A source has no date.", test: { kind: "owner" }, evidence: [], proposals: [], question: "q1",
  };
  const q1: Question = {
    id: "q1", text: "Outcome: must sources be dated? No default.", assumptions: ["a1"], waits: true, decisionId: DECISION, state: "open",
  };
  const a2: Assumption = { ...a1, id: "a2", statement: "Sources are recent.", question: "q2" };
  const q2: Question = {
    id: "q2", text: "Plan: how recent? No default.", assumptions: ["a2"], waits: true, decisionId: DECISION_TWO, state: "open",
  };
  const steered: Direction = { id: "s3", text: "Use primary sources.", source: "steering", at: at(3) };
  const answer: Direction = { id: "ans1", text: "Sources must be dated.", source: "correction", at: at(4) };

  // Version 2: the check adds a1, q1 (waiting on DECISION), and the derived criterion c1.
  const applied2 = {
    revision: 2, mode: "supervised", added: { assumptions: ["a1"], questions: ["q1"], criteria: ["c1"] },
    addedDigest: digestOf({ assumptions: [a1], questions: [q1], criteria: [c1] }),
    released: [], closed: [], waiting: ["q1"], converted: 0, dropped: {}, ignored: {},
  };
  const entry2: LogEntry = {
    seq: 2, at: at(2), version: 2, actor: "intent-check", authority: "claim", op: INTENT_OPS.applied, target: RUN_ID,
    handle: CHECKER, before: { inline: { questions: [] } }, after: { inline: applied2 },
  };
  const v2 = sealed({ ...base, version: 2, criteria: [...base.criteria, c1], assumptions: [a1], questions: [q1], log: [...base.log, entry2] });

  // Version 3: a steered direction.
  const entry3: LogEntry = {
    seq: 3, at: at(3), version: 3, actor: "owner", authority: "direction", op: "direction.appended", target: "s3",
    after: logValue(steered, "record:direction:s3"),
  };
  const v3 = sealed({ ...v2, version: 3, statement: { ...v2.statement, directions: [steered] }, log: [...v2.log, entry3] });

  // Version 4: a text answer on DECISION sets q1 answered, drops its wait, and appends the correction ans1.
  const entry4: LogEntry = {
    seq: 4, at: at(4), version: 4, actor: "owner", authority: "direction", op: INTENT_OPS.answered, target: DECISION, handle: RUN_ID,
    before: { inline: { questions: [{ id: "q1", state: "open", waits: true, decisionId: DECISION }] } },
    after: { inline: { mode: "text", questions: ["q1"], direction: answer } },
  };
  const q1Answered: Question = { id: "q1", text: q1.text, assumptions: ["a1"], waits: false, state: "answered" };
  const v4 = sealed({
    ...v3, version: 4, questions: [q1Answered], statement: { ...v3.statement, directions: [steered, answer] }, log: [...v3.log, entry4],
  });

  // Version 5: a second check adds a2 and q2 (waiting on DECISION_TWO), then writes a skip at the same version.
  const applied5 = {
    revision: 5, mode: "supervised", added: { assumptions: ["a2"], questions: ["q2"], criteria: [] },
    addedDigest: digestOf({ assumptions: [a2], questions: [q2], criteria: [] }),
    released: [], closed: [], waiting: ["q2"], converted: 0, dropped: {}, ignored: {},
  };
  const entry5: LogEntry = {
    seq: 5, at: at(5), version: 5, actor: "intent-check", authority: "claim", op: INTENT_OPS.applied, target: RUN_ID,
    handle: CHECKER, before: { inline: { questions: [] } }, after: { inline: applied5 },
  };
  const entry6: LogEntry = {
    seq: 6, at: at(5), version: 5, actor: "host", authority: "receipt", op: INTENT_OPS.skipped, target: RUN_ID,
    after: { inline: { revision: 5, reason: "checker-failed" } },
  };
  const v5 = sealed({ ...v4, version: 5, assumptions: [a1, a2], questions: [q1Answered, q2], log: [...v4.log, entry5, entry6] });

  // Version 6: the owner cancels the wait on DECISION_TWO.
  const entry7: LogEntry = {
    seq: 7, at: at(6), version: 6, actor: "host", authority: "receipt", op: INTENT_OPS.released, target: DECISION_TWO, handle: RUN_ID,
    before: { inline: { questions: [{ id: "q2", state: "open", waits: true, decisionId: DECISION_TWO }] } },
    after: { inline: { cause: "cancelled", questions: ["q2"] } },
  };
  const q2Released: Question = { id: "q2", text: q2.text, assumptions: ["a2"], waits: false, state: "open" };
  const v6 = sealed({ ...v5, version: 6, questions: [q1Answered, q2Released], log: [...v5.log, entry7] });

  for (const snapshot of [base, v2, v3, v4, v5, v6]) assert.equal(objectiveRecordSchema.safeParse(snapshot).success, true);
  for (const [index, snapshot] of [base, v2, v3, v4, v5].entries()) {
    assert.deepEqual(rebuildVersion(v6, index + 1), snapshot, `version ${index + 1}`);
  }

  // The applied entry's digest must match the objects it names: one byte off is a version this host cannot rebuild.
  const after2Flipped = applied2.addedDigest.replace(/.$/, last => (last === "0" ? "1" : "0"));
  const drifted = withEntry(v6, 2, { after: { inline: { ...applied2, addedDigest: after2Flipped } } });
  assert.throws(() => rebuildVersion(drifted, 1), { status: 409, code: "objective-version-unavailable" });

  // A `before` that names a question the record does not hold cannot be restored.
  const missingQuestion = withEntry(v6, 4, { before: { inline: { questions: [{ id: "q9", state: "open", waits: true, decisionId: DECISION }] } } });
  assert.throws(() => rebuildVersion(missingQuestion, 3), { status: 409, code: "objective-version-unavailable" });

  // An answer's correction that is no longer in the record cannot be undone.
  const noCorrection = sealed({ ...v6, statement: { ...v6.statement, directions: [steered] } });
  assert.throws(() => rebuildVersion(noCorrection, 3), { status: 409, code: "objective-version-unavailable" });
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

test("a rebuild undoes the register", () => {
  const COMMAND = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const COMMIT = "a".repeat(40);
  const OWNER_REQUEST = REQUEST_IDS[2];
  const RATING_REQUEST = REQUEST_IDS[3];
  const FINDING = "finding-3";
  const OLD_HANDLE = `receipt:${RUN_ID}:1:a1`;
  const digestOf = (value: unknown) => createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");
  const sealed = (record: Omit<ObjectiveRecord, "digest">): ObjectiveRecord => {
    const body = { ...record, digest: "" } as ObjectiveRecord;
    body.digest = recordDigest(body);
    return body;
  };
  const draft = (id: string, extra: Partial<Assumption>): Assumption => ({
    id, statement: `Assumption ${id} holds.`, status: "unchecked", origin: "intent-check", criticality: "plan",
    refutedBy: `Assumption ${id} fails.`, test: { kind: "owner" }, evidence: [], proposals: [], ...extra,
  });
  const base = goalRecord(goalFixture(), AT, "created") as ObjectiveRecord;

  // Version 1: four assumptions. a1 already holds an earlier receipt handle, which version 2 replaces at index 0.
  const a1v1 = draft("a1", { test: { kind: "command", command: COMMAND, refutesOn: "fail" }, evidence: [OLD_HANDLE] });
  const a2v1 = draft("a2", { test: { kind: "command", command: COMMAND, refutesOn: "fail" } });
  const a4v1 = draft("a4", { origin: "owner", test: { kind: "owner" } });
  const a5v1 = draft("a5", { origin: "owner", test: { kind: "owner", rating: { subject: "quality", below: 4 } } });
  const v1 = [a1v1, a2v1, a4v1, a5v1];

  // Version 2: a test sets a1 verified and a2 refuted, and each new handle is last in its evidence.
  const test2 = {
    revision: 2, kind: "command",
    changed: [{ id: "a1", status: "verified" }, { id: "a2", status: "refuted" }],
  };
  const entry2: LogEntry = {
    seq: 2, at: at(2), version: 2, actor: "host", authority: "receipt", op: "test.recorded", target: RUN_ID, handle: `receipt:${RUN_ID}:2`,
    before: { inline: { assumptions: [
      { id: "a1", status: "unchecked", replaced: { handle: OLD_HANDLE, at: 0 } },
      { id: "a2", status: "unchecked" },
    ] } },
    after: { inline: test2 },
  };
  const a1v2 = { ...a1v1, status: "verified" as const, evidence: [`receipt:${RUN_ID}:2:a1`] };
  const a2v2 = { ...a2v1, status: "refuted" as const, evidence: [`receipt:${RUN_ID}:2:a2`] };
  const v2 = [a1v2, a2v2, a4v1, a5v1];

  // Version 3: a member proposes a6 and attaches a stance to a2.
  const a6 = draft("a6", { origin: "member", criticality: "detail", statement: "Members keep the export format." });
  const proposal = {
    revision: 3, added: ["a6"], addedDigest: digestOf([a6]),
    attached: [{ id: "a2", entryId: FINDING }],
  };
  const entry3: LogEntry = {
    seq: 3, at: at(3), version: 3, actor: "member", authority: "claim", op: "proposal.recorded", target: MEMBER, handle: RUN_ID,
    after: { inline: proposal },
  };
  const stance = { entryId: FINDING, stance: "contradicts" as const, summary: "The export has no dates.", authorRole: "researcher" };
  const a2v3 = { ...a2v2, proposals: [stance] };
  const v3 = [a1v2, a2v3, a4v1, a5v1, a6];

  // Version 4: the owner pins a4 verified.
  const entry4: LogEntry = {
    seq: 4, at: at(4), version: 4, actor: "owner", authority: "direction", op: "assumption.set", target: "a4", handle: OWNER_REQUEST,
    before: { inline: { status: "unchecked" } },
    after: { inline: { status: "verified" } },
  };
  const a4v4 = { ...a4v1, status: "verified" as const, ownerPinned: true, evidence: [`owner:${OWNER_REQUEST}`] };
  const v4 = [a1v2, a2v3, a4v4, a5v1, a6];

  // Version 5: the owner rates quality 3, which refutes a5 (below 4).
  const entry5: LogEntry = {
    seq: 5, at: at(5), version: 5, actor: "owner", authority: "direction", op: "rating.recorded", target: "quality", handle: RATING_REQUEST,
    before: { inline: { assumptions: [{ id: "a5", status: "unchecked" }] } },
    after: { inline: { subject: "quality", score: 3, commit: COMMIT, cycle: 2, changed: [{ id: "a5", status: "refuted" }] } },
  };
  const a5v5 = { ...a5v1, status: "refuted" as const, evidence: [`rating:${RATING_REQUEST}`] };
  const v5Assumptions = [a1v2, a2v3, a4v4, a5v5, a6];
  const log = [base.log[0], entry2, entry3, entry4, entry5];
  const v5 = sealed({ ...base, version: 5, assumptions: v5Assumptions, log });
  assert.equal(objectiveRecordSchema.safeParse(v5).success, true);

  const snapshot = (version: number, assumptions: Assumption[]): ObjectiveRecord =>
    sealed({ ...base, version, assumptions, log: log.filter(item => item.version <= version) });
  assert.deepEqual(rebuildVersion(v5, 1), snapshot(1, v1));
  assert.deepEqual(rebuildVersion(v5, 2), snapshot(2, v2));
  assert.deepEqual(rebuildVersion(v5, 3), snapshot(3, v3));
  assert.deepEqual(rebuildVersion(v5, 4), snapshot(4, v4));

  // An addedDigest one byte off.
  const flipped = digestOf([a6]).replace(/.$/, last => (last === "0" ? "1" : "0"));
  const drifted = withEntry(v5, 3, { after: { inline: { ...proposal, addedDigest: flipped } } });
  assert.throws(() => rebuildVersion(drifted, 2), { status: 409, code: "objective-version-unavailable" });

  // A stance that is not the assumption's last proposal.
  const stanceNotLast = sealed({
    ...v5, assumptions: v5.assumptions.map(item => (item.id === "a2" ? { ...item, proposals: [stance, { ...stance, entryId: "finding-9" }] } : item)),
  });
  assert.throws(() => rebuildVersion(stanceNotLast, 2), { status: 409, code: "objective-version-unavailable" });

  // A last handle that differs from the entry's, for an owner pin and for a rating.
  const pinHandleDiffers = sealed({
    ...v5, assumptions: v5.assumptions.map(item => (item.id === "a4" ? { ...item, evidence: ["owner:other-request"] } : item)),
  });
  assert.throws(() => rebuildVersion(pinHandleDiffers, 3), { status: 409, code: "objective-version-unavailable" });
  const ratingHandleDiffers = sealed({
    ...v5, assumptions: v5.assumptions.map(item => (item.id === "a5" ? { ...item, evidence: ["rating:other-request"] } : item)),
  });
  assert.throws(() => rebuildVersion(ratingHandleDiffers, 4), { status: 409, code: "objective-version-unavailable" });

  // A current status that differs from the entry's `after`, for a rating and for an owner pin.
  const rated = { subject: "quality", score: 3, commit: COMMIT, cycle: 2 };
  const ratingStatusDiffers = withEntry(v5, 5, { after: { inline: { ...rated, changed: [{ id: "a5", status: "verified" }] } } });
  assert.throws(() => rebuildVersion(ratingStatusDiffers, 4), { status: 409, code: "objective-version-unavailable" });
  const pinStatusDiffers = withEntry(v5, 4, { after: { inline: { status: "refuted" } } });
  assert.throws(() => rebuildVersion(pinStatusDiffers, 3), { status: 409, code: "objective-version-unavailable" });

  // A test whose `changed` names an assumption its `before` does not, and a proposal that carries a `before`.
  const extraChanged = withEntry(v5, 2, { after: { inline: { ...test2, changed: [...test2.changed, { id: "a5", status: "refuted" }] } } });
  assert.throws(() => rebuildVersion(extraChanged, 1), { status: 409, code: "objective-version-unavailable" });
  const proposalWithBefore = withEntry(v5, 3, { before: { inline: { assumptions: [] } } });
  assert.throws(() => rebuildVersion(proposalWithBefore, 2), { status: 409, code: "objective-version-unavailable" });
});

test("register refusals have fixed codes and sentences", () => {
  const expected: [ObjectiveErrorCode, number, string][] = [
    ["objective-register-off", 409, "Turn on the assumption register for this goal's project before recording owner results."],
    ["objective-assumption-target", 409, "A correction names an assumption that is missing, has no owner test, or was proposed by a member."],
    ["objective-rating-subject", 409, "A rating names a subject that no active criterion or owner test names."],
    ["objective-rating-no-head", 409, "The goal has no reviewed cycle to rate yet."],
  ];
  for (const [code, status, message] of expected) {
    assert.deepEqual(OBJECTIVE_ERRORS[code], { status, message }, code);
    const error = objectiveError(code);
    assert.equal(error.status, status, code);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
  }
});
