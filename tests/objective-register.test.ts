import test from "node:test";
import assert from "node:assert/strict";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { CORRECTION_LOG } from "../packages/host/src/objective-ops.js";
import { rebuildVersion } from "../packages/host/src/objective-record.js";
import { applyReceipts } from "../packages/host/src/objective-register.js";
import type { ReceiptContext } from "../packages/host/src/objective-register.js";
import type { ObjectiveReceipt } from "../packages/host/src/objective-receipts.js";
import { canonicalBytes, objectiveRecordSchema, recordDigest } from "../packages/host/src/objective-types.js";
import type { Assumption, LogEntry, ObjectiveRecord } from "../packages/host/src/objective-types.js";

const RUN = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const AT = "2026-11-18T00:00:00.000Z";
const HEAD = "1".repeat(40);
const DIGEST = commandDigest({ command: "npm", args: ["test"] });
const CONTEXT: ReceiptContext = { runId: RUN, revision: 3, kind: "reviewed", at: AT };

function baseRecord(assumptions: Assumption[], entries = 1): ObjectiveRecord {
  const log: LogEntry[] = Array.from({ length: entries }, (_, index) => ({
    seq: index + 1, at: AT, version: 1, actor: "owner", authority: "direction", op: "record.created", target: RUN,
  }));
  const body: Omit<ObjectiveRecord, "digest"> = {
    schemaVersion: 1, owner: { kind: "run", runId: RUN }, version: 1,
    statement: { objective: "Ship the record", directions: [] }, definitions: [],
    constraints: { allowedPaths: ["."], excludedPaths: [], rules: [] }, nonGoals: [], ownerEvidence: [],
    criteria: [{
      id: "c0", origin: "owner", statement: "", statementOf: "objective", check: { kind: "judgement", item: "owner-text" },
      producer: "evaluator", threshold: { kind: "pass" }, state: "active",
    }],
    assumptions, questions: [], rubricVersion: 1, log,
  };
  return { ...body, digest: recordDigest(body) } as ObjectiveRecord;
}

function assumption(id: string, status: Assumption["status"], extra: Partial<Assumption> = {}): Assumption {
  return {
    id, statement: `Assumption ${id}`, status, origin: "intent-check", criticality: "plan", refutedBy: "The test fails",
    test: { kind: "command", command: DIGEST, refutesOn: "fail" }, evidence: [], proposals: [], ...extra,
  };
}

function receipt(id: string, outcome: ObjectiveReceipt["outcome"]): ObjectiveReceipt {
  const observed = outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : "absent";
  return {
    handle: `receipt:${RUN}:3:${id}`, kind: "command", subject: "assumption", id, commit: HEAD, outcome, at: AT,
    detail: { kind: "command", observed, round: 1 },
  };
}

function byId(record: ObjectiveRecord, id: string): Assumption {
  const found = record.assumptions.find(item => item.id === id);
  assert.ok(found, `assumption ${id} exists`);
  return found;
}

test("receipts set statuses only where the outcome differs", () => {
  const base = baseRecord([
    assumption("a1", "unchecked"),
    assumption("a2", "assumed", { criticality: "outcome", evidence: [`receipt:${RUN}:2:a2`] }),
    assumption("a3", "verified", { evidence: [`receipt:${RUN}:2:a3`] }),
    assumption("a4", "assumed"),
  ]);
  const applied = applyReceipts(base, [receipt("a1", "pass"), receipt("a2", "fail"), receipt("a3", "pass"), receipt("a4", "unknown")], CONTEXT);

  assert.ok(applied, "two receipts change a status");
  assert.deepStrictEqual(applied.changed, ["a1", "a2"]);
  assert.deepStrictEqual(applied.refutedOutcome, ["a2"]);
  assert.deepStrictEqual(byId(applied.record, "a1"), { ...byId(base, "a1"), status: "verified", evidence: [`receipt:${RUN}:3:a1`] });
  assert.deepStrictEqual(byId(applied.record, "a2"), {
    ...byId(base, "a2"), status: "refuted", evidence: [`receipt:${RUN}:3:a2`],
  });
  assert.deepStrictEqual(byId(applied.record, "a3"), byId(base, "a3"));
  assert.deepStrictEqual(byId(applied.record, "a4"), byId(base, "a4"));

  assert.equal(applied.record.version, 2);
  assert.equal(applied.record.log.length, base.log.length + 1);
  assert.deepStrictEqual(applied.record.log[applied.record.log.length - 1], {
    seq: 2, at: AT, version: 2, actor: "host", authority: "receipt", op: "test.recorded", target: RUN, handle: `receipt:${RUN}:3`,
    before: { inline: { assumptions: [
      { id: "a1", status: "unchecked" },
      { id: "a2", status: "assumed", replaced: { handle: `receipt:${RUN}:2:a2`, at: 0 } },
    ] } },
    after: { inline: { revision: 3, kind: "reviewed", changed: [{ id: "a1", status: "verified" }, { id: "a2", status: "refuted" }] } },
  });
  assert.doesNotThrow(() => objectiveRecordSchema.parse(applied.record));

  assert.deepStrictEqual(rebuildVersion(applied.record, base.version), base, "rebuilding undoes the statuses and puts the old handle back");

  assert.equal(applyReceipts(base, [receipt("a3", "pass"), receipt("a4", "unknown")], CONTEXT), undefined);

  const plan = applyReceipts(base, [receipt("a4", "fail")], CONTEXT);
  assert.ok(plan, "a fail refutes the plan assumption");
  assert.equal(byId(plan.record, "a4").status, "refuted");
  assert.deepStrictEqual(plan.refutedOutcome, [], "only an outcome assumption counts as a refuted outcome");

  const cited = baseRecord([
    assumption("a5", "assumed", { test: { kind: "citation", source: "docs/plan.md", quote: "The plan", refutesOn: "absent" } }),
  ]);
  assert.equal(applyReceipts(cited, [receipt("a5", "fail")], CONTEXT), undefined);
});

test("pinned and member assumptions keep their status", () => {
  const base = baseRecord([
    assumption("p1", "verified", { ownerPinned: true, criticality: "outcome", evidence: ["owner:req-1"] }),
    assumption("p3", "refuted", { ownerPinned: true, criticality: "outcome", evidence: ["owner:req-2"] }),
    assumption("m1", "assumed", { origin: "member" }),
  ]);

  const applied = applyReceipts(base, [receipt("p1", "fail"), receipt("p3", "pass"), receipt("m1", "fail")], CONTEXT);
  assert.ok(applied, "pinned assumptions gain their handles");
  assert.deepStrictEqual(applied.changed, ["p1", "p3"]);
  assert.deepStrictEqual(applied.refutedOutcome, []);
  assert.deepStrictEqual(byId(applied.record, "p1"), {
    ...byId(base, "p1"), evidence: ["owner:req-1", `receipt:${RUN}:3:p1`],
  });
  assert.equal(byId(applied.record, "p1").status, "verified");
  assert.deepStrictEqual(byId(applied.record, "p3"), {
    ...byId(base, "p3"), evidence: ["owner:req-2", `receipt:${RUN}:3:p3`],
  });
  assert.equal(byId(applied.record, "p3").status, "refuted");
  assert.deepStrictEqual(byId(applied.record, "m1"), byId(base, "m1"));
  assert.deepStrictEqual(rebuildVersion(applied.record, base.version), base, "rebuilding takes the pinned handles off");

  assert.equal(applyReceipts(base, [receipt("p1", "pass"), receipt("m1", "fail")], CONTEXT), undefined);
});

test("a pass writes entries of at most eight at one version", () => {
  const ids = Array.from({ length: 20 }, (_, index) => `a${index + 1}`);
  const base = baseRecord(ids.map(id => assumption(id, "unchecked")));
  const applied = applyReceipts(base, ids.map(id => receipt(id, "pass")), CONTEXT);

  assert.ok(applied, "twenty changes are written");
  assert.equal(applied.changed.length, 20);
  const written = applied.record.log.slice(base.log.length);
  assert.equal(written.length, 3, "20 changes give 3 entries of at most 8");
  assert.deepStrictEqual(written.map(entry => entry.version), [2, 2, 2]);
  assert.deepStrictEqual(written.map(entry => entry.seq), [2, 3, 4], "consecutive seqs after the base log");
  assert.deepStrictEqual(written.map(entry => (entry.after as { inline: { changed: unknown[] } }).inline.changed.length), [8, 8, 4]);
  for (const entry of written) {
    for (const value of [entry.before, entry.after]) {
      assert.ok(value !== undefined && "inline" in value, "every value is inline");
      assert.ok(Buffer.byteLength(JSON.stringify(value.inline), "utf8") <= 2048, "an entry value is at most 2,048 bytes");
    }
  }
  assert.equal(applied.record.version, 2);
  assert.doesNotThrow(() => objectiveRecordSchema.parse(applied.record));
});

test("a full log keeps the receipts and writes nothing", () => {
  const full = baseRecord([assumption("a1", "unchecked")], CORRECTION_LOG.entries);
  const before = structuredClone(full);
  assert.throws(() => applyReceipts(full, [receipt("a1", "pass")], CONTEXT), { code: "objective-log-full" });
  assert.deepStrictEqual(full, before, "the input record is unchanged");

  const room = baseRecord([assumption("a1", "unchecked")], CORRECTION_LOG.entries - 1);
  const applied = applyReceipts(room, [receipt("a1", "pass")], CONTEXT);
  assert.ok(applied, "the last entry of the share is written");
  assert.equal(applied.record.log.length, CORRECTION_LOG.entries);
  assert.ok(canonicalBytes(applied.record.log) <= CORRECTION_LOG.bytes);
});
