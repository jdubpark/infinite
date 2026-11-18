import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { correctionSchema } from "../packages/host/src/objective-input.js";
import type { CheckInput, Correction, CorrectionOp, CriterionInput } from "../packages/host/src/objective-input.js";
import {
  CORRECTION_LOG,
  addCreationCriteria,
  applyOwnerOps,
  criterionFromInput,
  nextCriterionId,
} from "../packages/host/src/objective-ops.js";
import type { OwnerOpContext } from "../packages/host/src/objective-ops.js";
import { OBJECTIVE_ERRORS, goalRecord, rebuildVersion, syncDirections } from "../packages/host/src/objective-record.js";
import type { ObjectiveErrorCode } from "../packages/host/src/objective-record.js";
import { canonicalBytes, objectiveRecordSchema, recordDigest } from "../packages/host/src/objective-types.js";
import type { Assumption, Criterion, LogEntry, ObjectiveRecord, Threshold } from "../packages/host/src/objective-types.js";
import { RECORD_DIGEST_BYTES, recordDigestBytes } from "../packages/host/src/team-types.js";
import type { TeamCommand } from "../packages/host/src/team-types.js";
import { recordDigestFor } from "../packages/host/src/objective-digest.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";

const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const REQUEST = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const AT = "2026-11-14T10:00:00.000Z";
const at = (revision: number) => new Date(Date.UTC(2026, 10, 14, 10, 0, revision)).toISOString();

const LINT: TeamCommand = { command: "npm", args: ["run", "lint"] };
const configured: TeamCommand[] = [LINT];
const context: OwnerOpContext = { configured, requestId: REQUEST, at: AT };
const judgement: CheckInput = { kind: "judgement", item: "method-applied" };
const pass: Threshold = { kind: "pass" };
const add = (statement: string, check: CheckInput = judgement, threshold: Threshold = pass): CorrectionOp =>
  ({ op: "criterion.add", criterion: { statement, check, threshold } });
const correction = (version: number, ops: CorrectionOp[]): Pick<Correction, "version" | "ops"> => ({ version, ops });

function goalFixture(): ProductGoal {
  return {
    id: GOAL_ID,
    objective: "Find ranked sources for the research brief.",
    successCriteria: "A ranked shortlist with reasons and sources",
    nonGoals: ["no paid sources"],
    allowedPaths: ["research"],
    evidence: ["notes.md"],
    steering: [],
  } as unknown as ProductGoal;
}

/** Version 1 of a goal's record: c0 only, one log entry. */
function v1(): ObjectiveRecord {
  const record = goalRecord(goalFixture(), AT, "created");
  if (typeof record === "string") throw new Error(`the fixture record is ${record}`);
  return record;
}

/** The record with its criteria replaced and its digest recomputed. The log is kept as it is. */
function withCriteria(record: ObjectiveRecord, criteria: Criterion[]): ObjectiveRecord {
  const body = { ...record, criteria };
  return { ...body, digest: recordDigest(body) };
}

function refusal(run: () => unknown): TeamError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof TeamError, "the refusal is a TeamError");
    return error;
  }
  assert.fail("the correction was accepted");
}

const normal = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)));

test("owner ops add, edit, retire, and confirm criteria", () => {
  const derived: Criterion = {
    id: "c1", origin: "derived", derivedFrom: "ranked sources", statement: "The shortlist is ranked.",
    check: { kind: "artifact", path: "research/shortlist.md", count: "/items" }, producer: "host",
    threshold: { kind: "count", min: 1 }, state: "active",
  };
  const base = v1();
  const start = withCriteria(base, [base.criteria[0]!, derived]);
  assert.ok(objectiveRecordSchema.safeParse(start).success, "the fixture record parses");

  const lint = { kind: "command", run: LINT } as const;
  const first = applyOwnerOps(start, correction(1, [
    { op: "criterion.add", criterion: { statement: "Lint passes.", check: lint, threshold: pass } },
    { op: "criterion.edit", id: "c1", statement: "The shortlist is ranked by fit." },
  ]), context);
  assert.equal(first.version, 2);
  assert.ok(objectiveRecordSchema.safeParse(first).success, "the corrected record parses");
  assert.deepEqual(first.criteria.find(item => item.id === "c2"), {
    id: "c2", origin: "owner", statement: "Lint passes.",
    check: { kind: "command", command: commandDigest(LINT) }, producer: "host", threshold: pass, state: "active",
  });
  const edited = first.criteria.find(item => item.id === "c1")!;
  assert.equal(edited.origin, "owner", "an edited derived criterion becomes the owner's");
  assert.equal("derivedFrom" in edited, false, "its derivedFrom is dropped");
  assert.deepEqual(edited.check, derived.check, "the check stays when the edit names none");
  assert.deepEqual(
    first.log.slice(-2).map(entry => [entry.op, entry.target, entry.version, entry.actor, entry.authority, entry.handle, entry.before !== undefined]),
    [["criterion.added", "c2", 2, "owner", "direction", REQUEST, false], ["criterion.edited", "c1", 2, "owner", "direction", REQUEST, true]],
    "one log entry per op, all at the new version",
  );

  const second = applyOwnerOps(first, correction(2, [{ op: "criterion.retire", id: "c2" }]), context);
  assert.equal(second.version, 3);
  assert.equal(second.criteria.find(item => item.id === "c2")!.state, "retired");
  assert.equal(nextCriterionId(second), "c3", "a retired id is not reused");

  const confirmed = applyOwnerOps(start, correction(1, [{ op: "criterion.confirm", id: "c1" }]), context);
  const confirmedC1 = confirmed.criteria.find(item => item.id === "c1")!;
  assert.equal(confirmedC1.origin, "owner");
  assert.equal("derivedFrom" in confirmedC1, false);
  assert.equal(confirmed.log.at(-1)!.op, "criterion.confirmed");
});

test("acceptance 2: misfits and unknown commands are refused", () => {
  const start = v1();
  const artifact: CheckInput = { kind: "artifact", path: "research/shortlist.md", count: "/items" };
  const judgementAsHost = refusal(() => applyOwnerOps(start, correction(1, [
    { op: "criterion.add", criterion: { statement: "A rule.", check: judgement, threshold: pass, producer: "host" } },
  ]), context));
  assert.equal(judgementAsHost.status, 400);
  assert.equal(judgementAsHost.code, "objective-criterion-misfit");

  const countUnderPass = refusal(() => applyOwnerOps(start, correction(1, [add("A count.", artifact, pass)]), context));
  assert.equal(countUnderPass.code, "objective-criterion-misfit");
  assert.equal(countUnderPass.status, 400);

  const unknown = refusal(() => applyOwnerOps(start, correction(1, [
    add("A command.", { kind: "command", run: { command: "make", args: ["test"] } }, pass),
  ]), context));
  assert.equal(unknown.code, "objective-command-unknown");
  assert.equal(unknown.status, 400);
});

test("refusals change nothing and echo nothing", () => {
  const ECHO = "QUARTZ-REFUSED-TEXT";
  const base = v1();
  const withC1 = applyOwnerOps(base, correction(1, [add("First criterion.")]), context);
  const withRetired = applyOwnerOps(withC1, correction(2, [{ op: "criterion.retire", id: "c1" }]), context);
  const eightActive = applyOwnerOps(base, correction(1, Array.from({ length: 7 }, (_, index) => add(`Seven ${index}.`))), context);
  const secret = "-----BEGIN " + "OPENSSH PRIVATE" + " KEY----- " + ECHO;
  const oversize = "\u0001".repeat(1000) + ECHO;

  const cases: { name: string; record: ObjectiveRecord; version: number; op: CorrectionOp; code: ObjectiveErrorCode }[] = [
    { name: "a missing target", record: base, version: 1, op: { op: "criterion.edit", id: "c9", statement: ECHO }, code: "objective-op-target" },
    { name: "a retired target", record: withRetired, version: 3, op: { op: "criterion.edit", id: "c1", statement: ECHO }, code: "objective-op-target" },
    { name: "c0", record: base, version: 1, op: { op: "criterion.retire", id: "c0" }, code: "objective-op-c0" },
    { name: "an unknown command", record: base, version: 1, op: add(ECHO, { kind: "command", run: { command: "make", args: [] } }), code: "objective-command-unknown" },
    { name: "a misfit", record: base, version: 1, op: { op: "criterion.add", criterion: { statement: ECHO, check: judgement, threshold: pass, producer: "host" } }, code: "objective-criterion-misfit" },
    { name: "an oversize criterion", record: base, version: 1, op: add(oversize), code: "objective-criterion-too-large" },
    { name: "a secret", record: base, version: 1, op: add(secret), code: "objective-secret" },
    { name: "the active limit", record: eightActive, version: 2, op: add(ECHO), code: "objective-criteria-limit" },
  ];
  for (const item of cases) {
    const before = structuredClone(item.record);
    const error = refusal(() => applyOwnerOps(item.record, correction(item.version, [add("First ok."), item.op, add("Last ok.")]), context));
    assert.equal(error.code, item.code, item.name);
    assert.equal(error.status, OBJECTIVE_ERRORS[item.code].status, item.name);
    const text = JSON.stringify(error) + error.message;
    assert.ok(!text.includes(ECHO), `${item.name}: the refusal holds no input text`);
    assert.deepEqual(item.record, before, `${item.name}: the input record is unchanged`);
  }
  const stale = refusal(() => applyOwnerOps(withC1, correction(1, [add(ECHO)]), context));
  assert.equal(stale.code, "objective-version-stale");
  assert.ok(!(JSON.stringify(stale) + stale.message).includes(ECHO));
});

test("c0 stays", () => {
  const base = v1();
  const edit = refusal(() => applyOwnerOps(base, correction(1, [{ op: "criterion.edit", id: "c0", statement: "Changed." }]), context));
  assert.equal(edit.code, "objective-op-c0");
  assert.equal(edit.status, 409);
  const retire = refusal(() => applyOwnerOps(base, correction(1, [{ op: "criterion.retire", id: "c0" }]), context));
  assert.equal(retire.code, "objective-op-c0");
  assert.equal(retire.status, 409);
});

test("a secret-shaped statement is refused", () => {
  // Each shape is built at run time, so the test file holds no credential-shaped literal.
  const shapes = [
    "-----BEGIN " + "OPENSSH PRIVATE" + " KEY-----",
    "gh" + "p_" + "a".repeat(36),
    "v1." + "eyJ" + "a".repeat(20) + "." + "b".repeat(43),
    "v1." + "1700000000" + "." + "c".repeat(43),
  ];
  for (const shape of shapes) {
    const error = refusal(() => applyOwnerOps(v1(), correction(1, [add(`Use ${shape} for the check.`)]), context));
    assert.equal(error.code, "objective-secret");
    assert.equal(error.status, 400);
    assert.ok(!(JSON.stringify(error) + error.message).includes(shape), "the refusal holds no secret text");
  }
});

test("limits refuse before anything changes", () => {
  const base = v1();
  const seven = applyOwnerOps(base, correction(1, Array.from({ length: 7 }, (_, index) => add(sized("a", 700, index)))), context);
  assert.equal(seven.criteria.filter(item => item.state === "active").length, 8, "7 added criteria of 700 bytes each fit");
  assert.ok(recordDigestBytes(recordDigestFor(seven, configured)) <= RECORD_DIGEST_BYTES);

  const nine = refusal(() => applyOwnerOps(seven, correction(2, [add("One more.")]), context));
  assert.equal(nine.code, "objective-criteria-limit");

  const sixtyFour: Criterion[] = [base.criteria[0]!];
  for (let index = 1; index <= 56; index += 1) {
    sixtyFour.push({ id: `c${index}`, origin: "owner", statement: "Retired.", check: judgement, producer: "evaluator", threshold: pass, state: "retired" });
  }
  for (let index = 57; index <= 63; index += 1) {
    sixtyFour.push({ id: `c${index}`, origin: "owner", statement: "Active.", check: judgement, producer: "evaluator", threshold: pass, state: "active" });
  }
  const full = withCriteria(base, sixtyFour);
  assert.ok(objectiveRecordSchema.safeParse(full).success, "a record of 64 criteria parses");
  const sixtyFive = refusal(() => applyOwnerOps(full, correction(1, [add("A 65th.")]), context));
  assert.equal(sixtyFive.code, "objective-criteria-limit");

  // Five statements of 1,000 bytes make a digest of about 5.5 KiB; a sixth makes it about 6.6 KiB.
  const five = applyOwnerOps(base, correction(1, Array.from({ length: 5 }, (_, index) => add(sized("b", 1000, index)))), context);
  assert.ok(recordDigestBytes(recordDigestFor(five, configured)) <= RECORD_DIGEST_BYTES);
  const digest = refusal(() => applyOwnerOps(five, correction(2, [add(sized("b", 1000, 6))]), context));
  assert.equal(digest.code, "objective-digest-too-large");
  assert.equal(digest.status, 409);
});

/** A string of exactly `bytes` ASCII bytes that ends in `index` (two digits), so every such statement has the same size. */
function sized(fill: string, bytes: number, index: number): string {
  return fill.repeat(bytes - 2) + String(index).padStart(2, "0");
}

/** A log entry that is not a criterion or direction op: it counts toward the room and the bytes only. */
const note = (seq: number): LogEntry => ({ seq, at: AT, version: 1, actor: "host", authority: "receipt", op: "record.noted", target: "record" });

/** Pads the log with entries carrying `size` characters of inline value, so that its canonical bytes are exactly `bytes`. */
function logOfBytes(record: ObjectiveRecord, bytes: number): ObjectiveRecord {
  const log = [...record.log];
  const padded = (size: number): LogEntry => ({ ...note(log.length + 1), after: { inline: "x".repeat(size) } });
  while (canonicalBytes([...log, padded(2000)]) < bytes) log.push(padded(2000));
  let low = 0;
  let high = 2000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (canonicalBytes([...log, padded(middle)]) <= bytes) low = middle; else high = middle - 1;
  }
  log.push(padded(low));
  assert.equal(canonicalBytes(log), bytes, "the padded log has the exact byte count");
  return { ...record, log };
}

test("a correction keeps room for steering", () => {
  const STEER = Array.from({ length: 20 }, (_, index) => ({ text: "steer ".repeat(1200).slice(0, 8000), revision: index + 1, at: at(index + 1) }));
  const base = v1();

  // 380 entries: a one-op correction would make 381.
  const full = { ...base, log: [...base.log, ...Array.from({ length: 379 }, (_, index) => note(index + 2))] };
  assert.equal(full.log.length, 380);
  assert.equal(refusal(() => applyOwnerOps(full, correction(1, [add("One op.")]), context)).code, "objective-log-full");

  // 379 entries: one op fits and leaves room for 20 steers.
  const room = { ...base, log: [...base.log, ...Array.from({ length: 378 }, (_, index) => note(index + 2))] };
  const corrected = applyOwnerOps(room, correction(1, [add("One op.")]), context);
  assert.equal(corrected.log.length, 380);
  const steered = syncDirections(corrected, STEER, AT);
  assert.notEqual(steered, "source-invalid");
  if (steered === "source-invalid") return;
  assert.equal(steered.log.length, 400);
  assert.ok(objectiveRecordSchema.safeParse(steered).success, "20 maximal steers fit after the correction");

  // Bytes: a correction that would pass 210 KiB is refused; one that stays under it leaves room for 20 steers at the inline limit.
  const direction = { id: "s10", text: "", source: "steering", at: at(10) };
  const inlineText = "y".repeat(2048 - canonicalBytes(direction));
  const inlineSteer = Array.from({ length: 20 }, (_, index) => ({ text: inlineText, revision: index + 10, at: at(index + 10) }));
  assert.equal(canonicalBytes({ ...direction, text: inlineText }), 2048, "a direction at the 2,048-byte inline limit");

  const nearlyFull = logOfBytes(base, CORRECTION_LOG.bytes - 100);
  assert.equal(refusal(() => applyOwnerOps(nearlyFull, correction(1, [add("One op.")]), context)).code, "objective-log-full");

  const roomy = logOfBytes(base, CORRECTION_LOG.bytes - 1000);
  const accepted = applyOwnerOps(roomy, correction(1, [add("One op.")]), context);
  assert.ok(canonicalBytes(accepted.log) <= CORRECTION_LOG.bytes);
  const bytesSteered = syncDirections(accepted, inlineSteer, AT);
  assert.notEqual(bytesSteered, "source-invalid");
  if (bytesSteered === "source-invalid") return;
  for (const entry of bytesSteered.log.slice(-20)) assert.ok(entry.after !== undefined && "inline" in entry.after, "each steer is logged inline");
  assert.ok(objectiveRecordSchema.safeParse(bytesSteered).success, "20 steers at the inline limit fit after the correction");
});

test("three corrections of distinct criteria give one record in every order", () => {
  const artifact: CheckInput = { kind: "artifact", path: "research/shortlist.md", count: "/items" };
  const seeded = applyOwnerOps(v1(), correction(1, [
    add("Rule one."), add("Rule two."), add("Rule three.", artifact, { kind: "count", min: 1 }),
  ]), context);
  const edits: CorrectionOp[] = [
    { op: "criterion.edit", id: "c1", statement: "Rule one, edited." },
    { op: "criterion.retire", id: "c2" },
    { op: "criterion.edit", id: "c3", threshold: { kind: "count", min: 2 } },
  ];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const outcomes = orders.map(order => {
    let record = seeded;
    for (const index of order) record = applyOwnerOps(record, correction(record.version, [edits[index]!]), context);
    return { criteria: normal(record.criteria), version: record.version, digest: record.digest };
  });
  for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0], "every order gives the same criteria, version, and digest");
  assert.equal(outcomes[0]!.version, 5, "the seeded record is version 2, then three corrections");
});

/** A small deterministic generator, so a failing seed can be replayed. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("every version rebuilds after random corrections and steering", () => {
  const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = generator(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const phrase = (): string => Array.from({ length: 3 }, () => pick(WORDS)).join(" ");
    const steering: { text: string; revision: number; at: string }[] = [];
    const snapshots = new Map<number, string>();
    let record = v1();
    snapshots.set(record.version, normal(record));

    for (let step = 0; step < 14; step += 1) {
      if (random() < 0.4 && steering.length < 20) {
        steering.push({ text: `Direction ${phrase()}`, revision: steering.length + 1, at: at(steering.length + 1) });
        const synced = syncDirections(record, steering, AT);
        assert.notEqual(synced, "source-invalid", `seed ${seed} step ${step}`);
        if (synced === "source-invalid") return;
        record = synced;
      } else {
        const active = record.criteria.filter(item => item.state === "active");
        const editable = active.filter(item => item.id !== "c0");
        const choice = random();
        let ops: CorrectionOp[] | undefined;
        if (choice < 0.4 && active.length < 8 && record.criteria.length < 64) ops = [add(phrase())];
        else if (choice < 0.7 && editable.length > 0) ops = [{ op: "criterion.edit", id: pick(editable).id, statement: phrase() }];
        else if (editable.length > 0) ops = [{ op: "criterion.retire", id: pick(editable).id }];
        if (ops !== undefined) record = applyOwnerOps(record, correction(record.version, ops), context);
      }
      // A restart: the record is read back from disk and parsed, so its keys come in schema order, not the order they were written.
      record = objectiveRecordSchema.parse(JSON.parse(JSON.stringify(record)));
      snapshots.set(record.version, normal(record));
    }

    for (let version = 1; version <= record.version; version += 1) {
      const expected = snapshots.get(version);
      assert.notEqual(expected, undefined, `seed ${seed}: a snapshot for version ${version}`);
      assert.ok(objectiveRecordSchema.safeParse(JSON.parse(expected!)).success, `seed ${seed}: version ${version} parses`);
      assert.equal(normal(rebuildVersion(record, version)), expected, `seed ${seed}: version ${version} rebuilds`);
    }
  }
});

/** A statement that makes the retired form of a criterion exactly `bytes` canonical bytes. Each quote adds two bytes, each letter one. */
function statementForRetired(check: CheckInput, threshold: Threshold, bytes: number): string {
  const base = canonicalBytes({ id: "c1", origin: "owner", statement: "", check, producer: "host", threshold, state: "retired" });
  const extra = bytes - base;
  for (let quotes = 0; quotes <= 1000; quotes += 1) {
    const plain = extra - 2 * quotes;
    if (plain >= 1 && quotes + plain <= 1000) return '"'.repeat(quotes) + "s".repeat(plain);
  }
  throw new Error("no statement of the requested size");
}

const LONG_CHECK: CheckInput = { kind: "artifact", path: "research/" + "p".repeat(280) + ".md", count: "/" + "q".repeat(60) + "/" + "r".repeat(60) };
const LONG_THRESHOLD: Threshold = { kind: "count", min: 1 };

test("a retired criterion of 2,048 bytes stays inline, and one byte more is refused at add", () => {
  const inputAt = (bytes: number): CriterionInput => ({ statement: statementForRetired(LONG_CHECK, LONG_THRESHOLD, bytes), check: LONG_CHECK, threshold: LONG_THRESHOLD });
  const start = v1();
  const added = applyOwnerOps(start, correction(1, [{ op: "criterion.add", criterion: inputAt(2048) }]), context);
  const criterion = added.criteria.find(item => item.id === "c1")!;
  assert.equal(canonicalBytes({ ...criterion, state: "retired" }), 2048, "the retired form is 2,048 bytes");
  assert.equal(canonicalBytes(criterion), 2047, "the active form is one byte shorter");

  const retired = applyOwnerOps(added, correction(2, [{ op: "criterion.retire", id: "c1" }]), context);
  assert.ok(objectiveRecordSchema.safeParse(retired).success, "the retired record parses");
  const entry = retired.log.at(-1)!;
  assert.ok(entry.before !== undefined && "inline" in entry.before && entry.after !== undefined && "inline" in entry.after, "the retire logs both values inline");
  assert.deepEqual(normal(rebuildVersion(retired, 2)), normal(added), "version 2 rebuilds");
  assert.deepEqual(normal(rebuildVersion(retired, 1)), normal(start), "version 1 rebuilds");

  const over = refusal(() => applyOwnerOps(start, correction(1, [{ op: "criterion.add", criterion: inputAt(2049) }]), context));
  assert.equal(over.code, "objective-criterion-too-large", "a criterion whose retired form is 2,049 bytes is refused at add");
  assert.equal(over.status, 400);
});

test("the whole-record refusals change nothing and echo nothing", () => {
  const ECHO = "QUARTZ-REFUSED-TEXT";
  const base = v1();
  const sizedOp = (text: string, index: number): CorrectionOp => add(text + "a".repeat(1000 - Buffer.byteLength(text) - 2) + String(index).padStart(2, "0"));
  const retiredHeavy = Array.from({ length: 22 }, (_, index): Criterion => ({
    id: `c${index + 1}`, origin: "owner", statement: statementForRetired(LONG_CHECK, LONG_THRESHOLD, 1460),
    check: LONG_CHECK, producer: "host", threshold: LONG_THRESHOLD, state: "retired",
  }));
  const heavy = withCriteria(base, [base.criteria[0]!, ...retiredHeavy]);
  assert.ok(objectiveRecordSchema.safeParse(heavy).success, "22 retired criteria of about 1.46 KB parse");
  const four = applyOwnerOps(base, correction(1, Array.from({ length: 4 }, (_, index) => sizedOp("b", index))), context);
  const crowded = { ...base, log: [...base.log, ...Array.from({ length: 377 }, (_, index) => note(index + 2))] };
  assert.equal(crowded.log.length, 378);

  const cases: { name: string; record: ObjectiveRecord; ops: CorrectionOp[]; code: ObjectiveErrorCode }[] = [
    // 378 entries and three adds make 381.
    { name: "log-full", record: crowded, ops: [add("First ok."), add(ECHO), add("Last ok.")], code: "objective-log-full" },
    // Retired criteria of 1.46 KB and three adds of 1,000 bytes pass 32 KiB.
    { name: "too-large", record: heavy, ops: [sizedOp("", 1), sizedOp(ECHO, 2), sizedOp("", 3)], code: "objective-too-large" },
    // Five active statements of 1,000 bytes plus two more make a digest over 6 KiB.
    { name: "digest-too-large", record: four, ops: [sizedOp("", 7), sizedOp(ECHO, 8)], code: "objective-digest-too-large" },
    // A 1,500-byte statement passes the size check, and the record's own rule refuses it.
    { name: "op-refused", record: base, ops: [add("First ok."), add(ECHO + "a".repeat(1500 - ECHO.length)), add("Last ok.")], code: "objective-op-refused" },
  ];
  for (const item of cases) {
    const before = structuredClone(item.record);
    const error = refusal(() => applyOwnerOps(item.record, correction(item.record.version, item.ops), context));
    assert.equal(error.code, item.code, item.name);
    assert.equal(error.status, OBJECTIVE_ERRORS[item.code].status, item.name);
    assert.ok(!(JSON.stringify(error) + error.message).includes(ECHO), `${item.name}: the refusal holds no input text`);
    assert.deepEqual(item.record, before, `${item.name}: the input record is unchanged`);
  }
});

test("the secret scan covers every op before the per-op checks", () => {
  const token = "gh" + "p_" + "a".repeat(36);
  const secretInPath: CorrectionOp = {
    op: "criterion.add",
    criterion: { statement: "An artifact check.", check: { kind: "artifact", path: `docs/${token}.md`, count: "/items" }, threshold: { kind: "count", min: 1 } },
  };
  const error = refusal(() => applyOwnerOps(v1(), correction(1, [{ op: "criterion.edit", id: "c9", statement: "Unknown." }, secretInPath]), context));
  assert.equal(error.code, "objective-secret", "the secret wins over the missing target");
  assert.equal(error.status, 400);
  assert.ok(!(JSON.stringify(error) + error.message).includes(token), "the refusal holds no secret text");
});

test("targets resolve against the input record, in either order", () => {
  const addFirst = add("Added first.");
  const editNew: CorrectionOp = { op: "criterion.edit", id: "c1", statement: "Edited." };
  const addThenEdit = refusal(() => applyOwnerOps(v1(), correction(1, [addFirst, editNew]), context));
  assert.equal(addThenEdit.code, "objective-op-target");
  assert.equal(addThenEdit.status, 409);
  const editThenAdd = refusal(() => applyOwnerOps(v1(), correction(1, [editNew, addFirst]), context));
  assert.equal(editThenAdd.code, "objective-op-target");
});

// The ops file's own helpers are exercised above; these two keep the creation path and the digest in view.
test("creation criteria are version 1 and never stale", () => {
  const inputs: CriterionInput[] = [
    { statement: "Lint passes.", check: { kind: "command", run: LINT }, threshold: pass },
    { statement: "A ranked list.", check: judgement, threshold: pass },
  ];
  const created = addCreationCriteria(v1(), inputs, context);
  assert.equal(created.version, 1);
  assert.deepEqual(created.criteria.map(item => item.id), ["c0", "c1", "c2"]);
  assert.ok(created.log.slice(1).every(entry => entry.op === "criterion.added" && entry.version === 1));
  assert.ok(objectiveRecordSchema.safeParse(created).success);
  assert.equal(criterionFromInput(inputs[1]!, "c9", configured).id, "c9");
});

const REQUEST_TWO = "0b1e2d3c-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const COMMIT = "a".repeat(40);
const COMMIT_TWO = "b".repeat(40);

/** The record with its assumptions replaced and its digest recomputed. The log is kept as it is. */
function withAssumptions(record: ObjectiveRecord, assumptions: Assumption[]): ObjectiveRecord {
  const body = { ...record, assumptions };
  return { ...body, digest: recordDigest(body) };
}

function assumptionOf(id: string, test: Assumption["test"], patch: Partial<Assumption> = {}): Assumption {
  return {
    id, statement: `Assumption ${id}.`, status: "unchecked", origin: "intent-check", criticality: "plan",
    refutedBy: `A fact that refutes ${id}.`, test, evidence: [], proposals: [], ...patch,
  };
}

/** Version 1 with a2 (artifact test), a4 (owner test), a5 and a6 (owner tests rating quality below 4 and 3), and a7 (pinned). */
function register(): ObjectiveRecord {
  const artifact: Assumption["test"] = { kind: "artifact", path: "research/shortlist.md", count: "/items", threshold: { kind: "count", min: 1 } };
  return withAssumptions(v1(), [
    assumptionOf("a2", artifact),
    assumptionOf("a4", { kind: "owner" }),
    assumptionOf("a5", { kind: "owner", rating: { subject: "quality", below: 4 } }),
    assumptionOf("a6", { kind: "owner", rating: { subject: "quality", below: 3 } }),
    assumptionOf("a7", { kind: "owner", rating: { subject: "quality", below: 4 } }, { status: "verified", ownerPinned: true, evidence: ["owner:seed"] }),
  ]);
}

test("the owner sets an owner-test assumption and pins it", () => {
  const start = register();
  const first = applyOwnerOps(start, correction(1, [{ op: "assumption.set", id: "a4", status: "verified" }]), context);
  const a4 = first.assumptions.find(item => item.id === "a4")!;
  assert.equal(a4.status, "verified");
  assert.equal(a4.ownerPinned, true);
  assert.deepEqual(a4.evidence, [`owner:${REQUEST}`], "the owner handle is last");
  const setEntries = first.log.filter(entry => entry.op === "assumption.set");
  assert.equal(setEntries.length, 1, "one entry for the set");
  assert.deepEqual(setEntries[0], {
    seq: 2, at: AT, version: 2, actor: "owner", authority: "direction", op: "assumption.set", target: "a4", handle: REQUEST,
    before: { inline: { status: "unchecked" } }, after: { inline: { status: "verified" } },
  }, "the entry holds the status before and after, with no pin before");
  assert.deepEqual(rebuildVersion(first, 1), start, "the rebuild undoes the set");

  const second = applyOwnerOps(first, correction(2, [{ op: "assumption.set", id: "a4", status: "refuted" }]), { ...context, requestId: REQUEST_TWO, at: at(2) });
  const again = second.assumptions.find(item => item.id === "a4")!;
  assert.deepEqual(again.evidence, [`owner:${REQUEST_TWO}`], "a second set replaces the earlier owner handle");
  assert.deepEqual(second.log.at(-1)!.before, {
    inline: { status: "verified", ownerPinned: true, replaced: { handle: `owner:${REQUEST}`, at: 0 } },
  }, "the replaced handle and its index are logged");
  assert.deepEqual(rebuildVersion(second, 2), first, "the rebuild undoes the second set");

  const seeded = withAssumptions(start, start.assumptions.map(item => (item.id === "a4"
    ? { ...item, evidence: ["rating:seed", "owner:old"] } : item)));
  const replacing = applyOwnerOps(seeded, correction(1, [{ op: "assumption.set", id: "a4", status: "verified" }]), context);
  assert.deepEqual(replacing.log.at(-1)!.before, {
    inline: { status: "unchecked", replaced: { handle: "owner:old", at: 1 } },
  }, "the replaced owner handle is at index 1");
  assert.deepEqual(replacing.assumptions.find(item => item.id === "a4")!.evidence, ["rating:seed", `owner:${REQUEST}`],
    "the new owner handle goes last and the rating handle stays");
  assert.deepEqual(rebuildVersion(replacing, 1), seeded, "the rebuild puts the replaced handle back at index 1");

  const refuted = refusal(() => applyOwnerOps(start, correction(1, [{ op: "assumption.set", id: "a2", status: "verified" }]), context));
  assert.equal(refuted.status, 409);
  assert.equal(refuted.code, "objective-assumption-target", "an artifact test is not an owner test");
  const missing = refusal(() => applyOwnerOps(start, correction(1, [{ op: "assumption.set", id: "a9", status: "verified" }]), context));
  assert.equal(missing.status, 409);
  assert.equal(missing.code, "objective-assumption-target", "a missing assumption");
  assert.equal(correctionSchema.safeParse({ requestId: REQUEST, version: 1, ops: [{ op: "assumption.set", id: "a4", status: "assumed" }] }).success, false,
    "the schema refuses status assumed");
});

test("a rating stamps the reviewed head and moves unpinned owner tests", () => {
  const start = withCriteria(register(), [v1().criteria[0]!, {
    id: "c1", origin: "owner", statement: "Speed is rated.", check: { kind: "owner-rating", subject: "speed" },
    producer: "owner", threshold: { kind: "score", min: 3, of: 5 }, state: "active",
  }]);
  const stamp = { commit: COMMIT, cycle: 2 };
  const rated = applyOwnerOps(start, correction(1, [{ op: "rating.record", subject: "quality", score: 3.5 }]), { ...context, rating: stamp });
  const find = (record: ObjectiveRecord, id: string) => record.assumptions.find(item => item.id === id)!;
  assert.equal(find(rated, "a5").status, "refuted", "3.5 is below 4");
  assert.deepEqual(find(rated, "a5").evidence, [`rating:${REQUEST}`]);
  assert.equal(find(rated, "a6").status, "verified", "3.5 is not below 3");
  assert.deepEqual(find(rated, "a6").evidence, [`rating:${REQUEST}`]);
  assert.deepEqual(find(rated, "a7"), find(start, "a7"), "a pinned test is unchanged");
  const entry = rated.log.at(-1)!;
  assert.equal(entry.op, "rating.recorded");
  assert.equal(entry.target, "quality");
  assert.equal(entry.handle, REQUEST);
  assert.deepEqual(entry.before, { inline: { assumptions: [{ id: "a5", status: "unchecked" }, { id: "a6", status: "unchecked" }] } });
  assert.deepEqual(entry.after, {
    inline: { subject: "quality", score: 3.5, commit: COMMIT, cycle: 2, changed: [{ id: "a5", status: "refuted" }, { id: "a6", status: "verified" }] },
  });
  assert.deepEqual(rebuildVersion(rated, 1), start, "the rebuild undoes the rating");

  const again = applyOwnerOps(rated, correction(2, [{ op: "rating.record", subject: "quality", score: 4.5 }]), {
    ...context, requestId: REQUEST_TWO, at: at(2), rating: { commit: COMMIT_TWO, cycle: 3 },
  });
  assert.equal(find(again, "a5").status, "verified", "4.5 is not below 4");
  assert.deepEqual(find(again, "a5").evidence, [`rating:${REQUEST_TWO}`], "a second rating replaces the earlier handle");
  assert.deepEqual(rebuildVersion(again, 2), rated, "the rebuild undoes the second rating");

  const speed = applyOwnerOps(start, correction(1, [{ op: "rating.record", subject: "speed", score: 4 }]), { ...context, rating: stamp });
  assert.deepEqual(speed.log.at(-1)!.after, { inline: { subject: "speed", score: 4, commit: COMMIT, cycle: 2, changed: [] } },
    "an owner-rating criterion names the subject, and an entry is logged even when nothing changes");
  assert.equal(speed.log.length, start.log.length + 1);

  const boundary = applyOwnerOps(start, correction(1, [{ op: "rating.record", subject: "quality", score: 3 }]), { ...context, rating: stamp });
  assert.equal(find(boundary, "a5").status, "refuted", "3 is below 4");
  assert.equal(find(boundary, "a6").status, "verified", "3 is not below 3");

  const retiredOnly = withCriteria(register(), [v1().criteria[0]!, {
    id: "c2", origin: "owner", statement: "Tone is rated.", check: { kind: "owner-rating", subject: "tone" },
    producer: "owner", threshold: { kind: "score", min: 3, of: 5 }, state: "retired",
  }]);
  const retired = refusal(() => applyOwnerOps(retiredOnly, correction(1, [{ op: "rating.record", subject: "tone", score: 4 }]), { ...context, rating: stamp }));
  assert.equal(retired.status, 409);
  assert.equal(retired.code, "objective-rating-subject", "a retired owner-rating criterion names nothing");

  const noHead = refusal(() => applyOwnerOps(start, correction(1, [{ op: "rating.record", subject: "quality", score: 3.5 }]), context));
  assert.equal(noHead.status, 409);
  assert.equal(noHead.code, "objective-rating-no-head");
  const unnamed = refusal(() => applyOwnerOps(start, correction(1, [{ op: "rating.record", subject: "tone", score: 3.5 }]), { ...context, rating: stamp }));
  assert.equal(unnamed.status, 409);
  assert.equal(unnamed.code, "objective-rating-subject");

  const scoreAt = (score: number) => ({ op: "rating.record", subject: "quality", score });
  for (const score of [0, 5.5, 3.3]) {
    assert.equal(correctionSchema.safeParse({ requestId: REQUEST, version: 1, ops: [scoreAt(score)] }).success, false, `the schema refuses ${score}`);
  }
  for (const score of [1, 2.5, 5]) {
    assert.equal(correctionSchema.safeParse({ requestId: REQUEST, version: 1, ops: [scoreAt(score)] }).success, true, `the schema accepts ${score}`);
  }
});

test("register ops and criterion ops share one version", () => {
  const retirable: Criterion = {
    id: "c1", origin: "owner", statement: "A ranked list.", check: { kind: "judgement", item: "method-applied" },
    producer: "evaluator", threshold: { kind: "pass" }, state: "active",
  };
  const start = withCriteria(register(), [v1().criteria[0]!, retirable]);
  const next = applyOwnerOps(start, correction(1, [
    { op: "criterion.retire", id: "c1" },
    { op: "assumption.set", id: "a4", status: "verified" },
  ]), context);
  assert.equal(next.version, 2);
  assert.deepEqual(next.log.slice(-2).map(entry => [entry.op, entry.target, entry.version]), [
    ["criterion.retired", "c1", 2],
    ["assumption.set", "a4", 2],
  ]);
  assert.equal(next.criteria.find(item => item.id === "c1")!.state, "retired");
  assert.equal(next.assumptions.find(item => item.id === "a4")!.status, "verified");

  const stale = refusal(() => applyOwnerOps(start, correction(7, [{ op: "assumption.set", id: "a4", status: "verified" }]), context));
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "objective-version-stale");
});

test("a rating writes entries of eight changes and rebuilds", () => {
  const nine = withAssumptions(v1(), Array.from({ length: 9 }, (_, index) =>
    assumptionOf(`a${index + 1}`, { kind: "owner", rating: { subject: "quality", below: 4 } })));
  const rated = applyOwnerOps(nine, correction(1, [{ op: "rating.record", subject: "quality", score: 3.5 }]), { ...context, rating: { commit: COMMIT, cycle: 2 } });
  const entries = rated.log.filter(entry => entry.op === "rating.recorded");
  assert.equal(entries.length, 2, "nine changes make two entries");
  assert.ok(entries.every(entry => entry.version === 2), "both entries share one version");
  assert.deepEqual(entries.map(entry => (entry.after as { inline: { changed: unknown[] } }).inline.changed.length), [8, 1]);
  assert.ok(entries.every(entry => entry.seq > nine.log.at(-1)!.seq), "the seqs follow the record's log");
  assert.ok(rated.assumptions.every(item => item.status === "refuted" && item.evidence.length === 1), "all nine take the rating");
  assert.deepEqual(rebuildVersion(rated, 1), nine, "the rebuild undoes both entries");
});

test("a correction names each assumption and each rating subject once", () => {
  const twice = (ops: CorrectionOp[]) => correctionSchema.safeParse({ requestId: REQUEST, version: 1, ops }).success;
  assert.equal(twice([{ op: "assumption.set", id: "a4", status: "verified" }, { op: "assumption.set", id: "a4", status: "refuted" }]), false,
    "two sets on one assumption are refused");
  assert.equal(twice([{ op: "rating.record", subject: "quality", score: 3 }, { op: "rating.record", subject: "quality", score: 4 }]), false,
    "two ratings on one subject are refused");
  assert.equal(twice([{ op: "assumption.set", id: "a4", status: "verified" }, { op: "rating.record", subject: "quality", score: 3 }]), true,
    "one set and one rating are accepted");
});
