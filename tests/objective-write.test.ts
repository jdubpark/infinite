import test from "node:test";
import assert from "node:assert/strict";
import { runRecord } from "../packages/host/src/objective-record.js";
import type { LogEntry, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { recordDigest } from "../packages/host/src/objective-types.js";
import { assertLogRoom, nextRecordId, nextSeq, sealRecord } from "../packages/host/src/objective-write.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { TeamError } from "../packages/host/src/team-workspace.js";

const RUN_ID = "7a2d3b4f-9c5e-4d6f-8a71-8293a4b5c6d7";
const AT = "2026-11-17T09:00:00.000Z";

/** A standalone run's record at version 1, one log entry. */
function v1(): ObjectiveRecord {
  const run = { id: RUN_ID, objective: "Find ranked sources for the research brief.", steering: [] } as unknown as TeamRun;
  const record = runRecord(run, AT, "run-handle");
  if (typeof record === "string") throw new Error(`the fixture record is ${record}`);
  return record;
}

/** A log padded with skipped entries to `length` entries, all at the record's version. */
function padded(record: ObjectiveRecord, length: number): ObjectiveRecord {
  const log = [...record.log];
  while (log.length < length) {
    log.push({
      seq: (log[log.length - 1]?.seq ?? 0) + 1, at: AT, version: record.version, actor: "host", authority: "receipt",
      op: "intent-check.skipped", target: RUN_ID,
    });
  }
  return { ...record, log };
}

/** One host entry at `version`, numbered after the record's log; `index` offsets its seq. */
function entryAt(record: ObjectiveRecord, version: number, index = 0): LogEntry {
  return {
    seq: nextSeq(record) + index, at: AT, version, actor: "host", authority: "receipt", op: "intent-check.skipped", target: RUN_ID,
  };
}

function assertCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof TeamError, "the error is a TeamError");
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`the call was accepted, expected ${code}`);
}

test("record writes seal one version with every entry", () => {
  const record = v1();
  const entries = [entryAt(record, 2, 0), entryAt(record, 2, 1), entryAt(record, 2, 2)];
  const next = sealRecord(record, {}, entries);
  assert.equal(next.version, 2);
  assert.equal(next.log.length, record.log.length + 3);
  assert.deepEqual(next.log.slice(-3), entries);
  assert.equal(next.digest, recordDigest(next));

  // An entry at another version is refused, and so is a result the schema refuses.
  assertCode(() => sealRecord(record, {}, [entryAt(record, 2, 0), entryAt(record, 3, 1)]), "objective-op-refused");
  assertCode(() => sealRecord(record, {}, [entryAt(record, 2, 0), entryAt(record, 1, 1)]), "objective-op-refused");
  assertCode(() => sealRecord(record, { owner: { kind: "nope" } as unknown as ObjectiveRecord["owner"] }, entries), "objective-op-refused");

  // The log room: 380 entries plus one is full; 300 entries plus one is full at a 300-entry room of 160 KiB.
  assertCode(() => assertLogRoom(padded(record, 380), [entryAt(record, 2)]), "objective-log-full");
  assertCode(() => assertLogRoom(padded(record, 300), [entryAt(record, 2)], { entries: 300, bytes: 160 * 1024 }), "objective-log-full");
  assert.doesNotThrow(() => assertLogRoom(padded(record, 299), [entryAt(record, 2)], { entries: 300, bytes: 160 * 1024 }));
  // The byte limit holds on its own: two entries pass a 380-entry room of 64 bytes.
  assertCode(() => assertLogRoom(record, [entryAt(record, 2)], { entries: 380, bytes: 64 }), "objective-log-full");
  assert.equal(nextRecordId("a", ["a3", "a1"]), "a4", "the highest number, not the last");

  assert.equal(nextRecordId("a", ["a1", "a3", "q9"]), "a4");
  assert.equal(nextRecordId("a", []), "a1");
  assert.equal(nextSeq(record), 2, "one more than the last seq");
});
