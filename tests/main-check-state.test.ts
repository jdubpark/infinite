import test from "node:test";
import assert from "node:assert/strict";
import { accept, admit, chargedAdmissions, checksDigest, emptyRecord, finish, MAX_ATTEMPT_ENTRIES, MAX_RESULTS, mainCheckRecordSchema, noticeDue, observe, settle, viewOf, type MainCheckRecord, type MainCheckResult, type Retiring } from "../packages/host/src/main-check-state.js";

/* Examples for the pure main-check rules (INF-388). The seeded simulator covers their interplay; these pin the edges. */

const DIGEST = checksDigest({ checks: [{ command: "npm", args: ["test"] }] });
const OTHER_DIGEST = checksDigest({ setup: { command: "npm", args: ["ci"] }, checks: [{ command: "npm", args: ["test"] }] });
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const headOf = (index: number) => index.toString(16).padStart(40, "0");
const witness = { boot: "boot-1", processes: [], sessions: [], groups: [] };
const entryOf = (directory: string): Retiring => ({ directory, root: "/srv/main-check-example/teams", witness });

function result(head: string, outcome: MainCheckResult["outcome"], seconds: number, checks = DIGEST): MainCheckResult {
  const base = { head, checks, startedAt: at(seconds), finishedAt: at(seconds + 1), expected: 1, commands: [] };
  if (outcome === "error") return { ...base, outcome, reason: "workspace" };
  if (outcome === "interrupted") return { ...base, outcome, reason: "halt" };
  return { ...base, outcome };
}

/** Admits `head`, finishes it with `outcome`, and retires nothing: the record as the service would write it, settled. */
function checked(record: MainCheckRecord, head: string, outcome: MainCheckResult["outcome"], seconds: number): MainCheckRecord {
  const directory = `alpha-2026-11-20-main-check-${seconds.toString(16).padStart(8, "0")}`;
  const observed = observe(record, head, at(seconds));
  const running = admit(observed, { ...entryOf(directory), recording: true, head, checks: DIGEST, startedAt: at(seconds) });
  const { retiring: _retiring, ...rest } = finish(running, result(head, outcome, seconds), entryOf(directory), at(seconds));
  return settle(rest, DIGEST);
}

test("results past 20 keep the newest 20, and settle still finds health among them", () => {
  let record = emptyRecord();
  for (let index = 1; index <= MAX_RESULTS + 1; index += 1) record = checked(record, headOf(index), index === MAX_RESULTS + 1 ? "failed" : "passed", index * 10);
  assert.equal(record.results?.length, MAX_RESULTS);
  assert.equal(record.results?.[0]?.head, headOf(2), "the oldest result left");
  assert.equal(record.results?.at(-1)?.head, headOf(MAX_RESULTS + 1));
  assert.equal(record.health?.head, headOf(MAX_RESULTS + 1));
  assert.equal(record.health?.outcome, "failed");
  assert.equal(mainCheckRecordSchema.safeParse(record).success, true);
  // A head observed again, inside the kept 20, becomes health again.
  const again = settle(observe(record, headOf(5), at(1_000)), DIGEST);
  assert.equal(again.health?.head, headOf(5));
  assert.equal(again.health?.outcome, "passed");
  assert.equal(again.notice, (record.notice ?? 0) + 1, "the outcome changed, so the generation rose");
});

test("attempt entries past 20 keep the newest 20, and a dropped head counts as never charged", () => {
  let record = emptyRecord();
  for (let index = 1; index <= MAX_ATTEMPT_ENTRIES + 1; index += 1) record = checked(record, headOf(index), "error", index * 10);
  assert.equal(record.attempts?.length, MAX_ATTEMPT_ENTRIES);
  assert.equal(chargedAdmissions(record, headOf(1), DIGEST), 0);
  assert.equal(chargedAdmissions(record, headOf(2), DIGEST), 1);
  assert.equal(chargedAdmissions(record, headOf(MAX_ATTEMPT_ENTRIES + 1), DIGEST), 1);
  assert.equal(mainCheckRecordSchema.safeParse(record).success, true);
});

test("accept ignores an older generation, a generation the record never reached, and a repeat", () => {
  let record = checked(emptyRecord(), headOf(1), "failed", 10);
  record = checked(record, headOf(2), "passed", 20);
  record = checked(record, headOf(3), "failed", 30);
  assert.equal(record.notice, 3);
  const told = accept(record, 2, "passed");
  assert.deepEqual(told.told, { notice: 2, outcome: "passed" });
  assert.equal(accept(told, 1, "failed"), told, "an older generation than told changes nothing");
  assert.equal(accept(told, 4, "failed"), told, "a generation the record never reached changes nothing");
  assert.equal(accept(told, 2, "passed"), told, "a repeat changes nothing");
  assert.deepEqual(accept(told, 3, "failed").told, { notice: 3, outcome: "failed" });
});

test("observe ignores a fetch older than the observed one, and moves a head's results to the newer stamp", () => {
  const record = checked(emptyRecord(), headOf(1), "passed", 10);
  assert.equal(observe(record, headOf(2), at(5)), record);
  const later = observe(record, headOf(1), at(60));
  assert.deepEqual(later.observed, { head: headOf(1), at: at(60) });
  assert.equal(later.results?.[0]?.observedAt, at(60));
});

test("a notice is due only while health is present: a told failure under changed checks waits for the next result", () => {
  const failed = accept(checked(emptyRecord(), headOf(1), "failed", 10), 1, "failed");
  assert.equal(noticeDue(failed), false, "the owner was told");
  const changed = settle(failed, OTHER_DIGEST);
  assert.equal(changed.health, undefined);
  assert.equal(changed.notice, 2, "absent health still counts as passed for the generation");
  assert.equal(noticeDue(changed), false, "nothing passed, so nothing says main passes again");
  const fixed = settle(finish(admit(changed, { ...entryOf("alpha-2026-11-20-main-check-0000aaaa"), recording: true, head: headOf(1), checks: OTHER_DIGEST, startedAt: at(40) }), result(headOf(1), "passed", 40, OTHER_DIGEST), entryOf("alpha-2026-11-20-main-check-0000aaaa"), at(10)), OTHER_DIGEST);
  assert.equal(fixed.health?.outcome, "passed");
  assert.equal(noticeDue(fixed), true);
});

test("the owner's view holds no directory, root or witness", () => {
  const directory = "alpha-2026-11-20-main-check-0badc0de";
  const root = "/srv/main-check-example/a-root-only-the-host-knows";
  const secretWitness = { boot: "boot-only-the-host-knows", processes: [{ pid: 424242, start: "start-only-the-host-knows" }], sessions: [434343], groups: [454545] };
  const retired = checked(emptyRecord(), headOf(1), "passed", 10);
  const record: MainCheckRecord = {
    ...retired,
    running: { directory, root, witness: secretWitness, recording: true, head: headOf(2), checks: DIGEST, startedAt: at(30) },
    retiring: [{ directory: `${directory}-old`, root, witness: secretWitness }],
  };
  assert.equal(mainCheckRecordSchema.safeParse(record).success, true);
  const text = JSON.stringify(viewOf(record, true));
  for (const secret of [directory, root, "boot-only-the-host-knows", "start-only-the-host-knows", "424242", "434343", "454545", "witness", "recording"]) {
    assert.equal(text.includes(secret), false, `the view shows ${secret}`);
  }
  assert.match(text, /"retiring":1/);
});

test("the record schema refuses an unknown key, also inside a nested entry", () => {
  assert.equal(mainCheckRecordSchema.safeParse({ version: 1 }).success, true);
  assert.equal(mainCheckRecordSchema.safeParse({ version: 1, extra: true }).success, false);
  assert.equal(mainCheckRecordSchema.safeParse({ version: 1, observed: { head: headOf(1), at: at(0), extra: true } }).success, false);
  assert.equal(mainCheckRecordSchema.safeParse({ version: 2 }).success, false);
});
