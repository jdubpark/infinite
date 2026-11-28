import test from "node:test";
import assert from "node:assert/strict";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { definitionDigest } from "../packages/host/src/objective-receipts.js";
import type { ObjectiveReceipt } from "../packages/host/src/objective-receipts.js";
import { rebuildVersion } from "../packages/host/src/objective-record.js";
import { canonicalBytes, objectiveRecordSchema, recordDigest } from "../packages/host/src/objective-types.js";
import type { Criterion, LogEntry, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { composeVerdict, deliveryReceiptOf, resolveHandle, verdictRecord } from "../packages/host/src/verdict-compose.js";
import type { ComposeInput, ComposedCriterion } from "../packages/host/src/verdict-compose.js";
import type { AssessedState, DeliveryFact, VerdictReport } from "../packages/host/src/verdict-types.js";

const RUN = "5f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const VERDICT = "0b9d7c1e-2f3a-4b5c-9d6e-1a2b3c4d5e6f";
const AT = "2026-11-21T00:00:00.000Z";
const HEAD = "1".repeat(40);
const OLD = "2".repeat(40);
const BLOB = "3".repeat(40);
const SHORTLIST = "research/founders/shortlist.json";
const PINNED = "research/founders/rank-verify.mjs";
const DIGEST = commandDigest({ command: "npm", args: ["run", "rank:verify"] });

const base = (id: string, rest: Partial<Criterion> & Pick<Criterion, "check" | "producer" | "threshold">): Criterion => ({
  id, origin: "owner", statement: `Statement ${id}`, state: "active", ...rest,
});

function part9(): Criterion[] {
  return [
    { id: "c0", origin: "owner", statement: "", statementOf: "objective", check: { kind: "judgement", item: "owner-text" },
      producer: "evaluator", threshold: { kind: "pass" }, state: "active" },
    base("c1", { check: { kind: "artifact", path: SHORTLIST, count: "/entries" }, producer: "host", threshold: { kind: "count", min: 10, max: 25 } }),
    base("c2", { check: { kind: "citation-form", path: SHORTLIST, entries: "/entries", perEntry: 2 }, producer: "host", threshold: { kind: "share", min: 1 } }),
    base("c3", { check: { kind: "judgement", item: "method-applied" }, producer: "evaluator", threshold: { kind: "pass" } }),
    base("c4", { check: { kind: "command", command: DIGEST }, producer: "host", threshold: { kind: "pass" }, pinned: [{ path: PINNED, blob: BLOB }] }),
    base("c5", { check: { kind: "owner-rating", subject: "top-10" }, producer: "owner", threshold: { kind: "score", min: 4, of: 5 } }),
  ];
}

function record(criteria: Criterion[], extra: LogEntry[] = [], entries = 1): ObjectiveRecord {
  const log: LogEntry[] = Array.from({ length: entries }, (_, index) => ({
    seq: index + 1, at: AT, version: 1, actor: "owner", authority: "direction", op: "record.created", target: RUN,
  }));
  const withExtra = [...log, ...extra.map((entry, index) => ({ ...entry, seq: log.length + index + 1 }))];
  const body: Omit<ObjectiveRecord, "digest"> = {
    schemaVersion: 1, owner: { kind: "run", runId: RUN }, version: 1,
    statement: { objective: "Rank founders", directions: [] }, definitions: [],
    constraints: { allowedPaths: ["."], excludedPaths: [], rules: [] }, nonGoals: [], ownerEvidence: [],
    criteria, assumptions: [], questions: [], rubricVersion: 1, log: withExtra,
  };
  return { ...body, digest: recordDigest(body) } as ObjectiveRecord;
}

function rating(subject: string, score: number, commit: string): LogEntry {
  return {
    seq: 0, at: AT, version: 1, actor: "owner", authority: "direction", op: "rating.recorded", target: subject, handle: "req-1",
    after: { inline: { subject, score, commit, cycle: 1, changed: [] } },
  };
}

function receipt(id: string, outcome: ObjectiveReceipt["outcome"], commit = HEAD): ObjectiveReceipt {
  return {
    handle: `receipt:${RUN}:1:${id}`, kind: "command", subject: "criterion", id, commit, outcome, at: AT,
    digest: definitionDigest(part9().find(item => item.id === id)!),
    detail: { kind: "command", observed: outcome === "pass" ? "passed" : outcome === "fail" ? "failed" : "absent", round: 1 },
  };
}

function report(states: Record<string, AssessedState>, evidence: string[] = [`file:${SHORTLIST}`], result: AssessedState = "met"): VerdictReport {
  return { kind: "verdict", result, criteria: Object.entries(states).map(([id, state]) => ({ id, state, evidence })) };
}

function input(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    record: record(part9()), head: HEAD, kind: "reviewed", configured: [], facts: {},
    changedPaths: { paths: [], truncated: false }, ...overrides,
  };
}

function find(items: readonly ComposedCriterion[], id: string): ComposedCriterion {
  const found = items.find(item => item.id === id);
  assert.ok(found, `criterion ${id} is composed`);
  return found;
}

const META = { verdictId: VERDICT, kind: "reviewed" as const, revision: 1, head: HEAD, at: AT };

test("acceptance 6: a failing receipt overrides the evaluator", () => {
  const receipts = [receipt("c1", "pass"), receipt("c4", "fail")];
  const everyMet = report({ c0: "met", c1: "met", c2: "met", c3: "met", c4: "met", c5: "met" }, [`file:${SHORTLIST}`, receipts[0]!.handle]);
  const composed = composeVerdict(input({ receipts, report: everyMet }));
  const c4 = find(composed.criteria, "c4");
  assert.equal(c4.state, "not-met");
  assert.equal(c4.contradicted, true);
  assert.equal(composed.result, "not-met");
  assert.equal(composed.evaluatorResult, "met");
  assert.equal(find(composed.criteria, "c1").contradicted, undefined);

  const written = verdictRecord(record(part9()), composed, META);
  assert.notEqual(written, "log-full");
  if (written === "log-full") return;
  const recorded = written.log.filter(entry => entry.op === "verdict.recorded");
  const contradicted = written.log.filter(entry => entry.op === "evaluator-contradicted-receipt");
  assert.equal(recorded.length, 1);
  assert.equal(contradicted.length, 1);
  assert.equal(contradicted[0]!.target, "c4");
  assert.equal(written.version, 2);
  assert.equal(objectiveRecordSchema.safeParse(written).success, true);
});

test("a receipt is judged only against the definition it measured", () => {
  const receipts = [receipt("c1", "pass"), receipt("c4", "pass")];
  const edited = (id: string, change: (item: Criterion) => Criterion) => record(part9().map(item => (item.id === id ? change(item) : item)));
  const judged = (rec: ObjectiveRecord, id: string) => find(composeVerdict(input({ record: rec, receipts })).criteria, id);
  assert.equal(judged(record(part9()), "c1").state, "met");
  const edits: [string, string, (item: Criterion) => Criterion][] = [
    ["c1", "path", item => ({ ...item, check: { kind: "artifact", path: "research/other.json", count: "/entries" } })],
    ["c1", "threshold", item => ({ ...item, threshold: { kind: "count", min: 11, max: 25 } })],
    ["c4", "command", item => ({ ...item, check: { kind: "command", command: "f".repeat(64) } })],
    ["c4", "pinned", item => ({ ...item, pinned: [{ path: PINNED, blob: "4".repeat(40) }] })],
  ];
  for (const [id, what, change] of edits) {
    const stale = judged(edited(id, change), id);
    assert.equal(stale.state, "inconclusive", what);
    assert.equal(stale.reason, "receipt-stale", what);
    assert.equal(stale.receipt, undefined, what);
  }
  const reworded = judged(edited("c1", item => ({ ...item, statement: "Another wording", producer: "host" })), "c1");
  assert.equal(reworded.state, "met");
  const undigested = receipts.map(({ digest: _digest, ...rest }) => rest);
  const missing = find(composeVerdict(input({ receipts: undigested })).criteria, "c1");
  assert.equal(missing.state, "inconclusive");
  assert.equal(missing.reason, "receipt-stale");
});

test("the result follows the composition rules", () => {
  const good = [`file:${SHORTLIST}`];
  const receiptsAllPass = [receipt("c1", "pass"), receipt("c4", "pass")];
  for (const [outcome, state, reason] of [["pass", "met", undefined], ["fail", "not-met", undefined], ["unknown", "inconclusive", "receipt-unknown"]] as const) {
    const composed = composeVerdict(input({ receipts: [receipt("c1", outcome)] }));
    const c1 = find(composed.criteria, "c1");
    assert.equal(c1.state, state);
    assert.equal(c1.reason, reason);
    assert.equal(c1.receipt?.outcome, outcome);
  }
  const noReceipt = find(composeVerdict(input()).criteria, "c1");
  assert.equal(noReceipt.state, "inconclusive");
  assert.equal(noReceipt.reason, "no-receipt");
  assert.equal(find(composeVerdict(input({ receipts: [] })).criteria, "c1").reason, "no-receipt");
  assert.equal(find(composeVerdict(input({ receipts: [receipt("c1", "pass", OLD)] })).criteria, "c1").state, "inconclusive");
  const assumptionReceipt: ObjectiveReceipt = { ...receipt("c1", "pass"), subject: "assumption" };
  assert.equal(find(composeVerdict(input({ receipts: [assumptionReceipt] })).criteria, "c1").state, "inconclusive");

  for (const [item, facts] of [["checks-passed", { checksPassed: true }], ["review-approved", { reviewApproved: true }]] as const) {
    const criteria = part9().map(entry => (entry.id === "c2" ? { ...entry, check: { kind: "receipt", receipt: item } as const, threshold: { kind: "pass" } as const } : entry));
    const subject = (value: ComposeInput["facts"]) => find(composeVerdict(input({ record: record(criteria), facts: value })).criteria, "c2");
    assert.equal(subject(facts).state, "met");
    const falsy = Object.fromEntries(Object.entries(facts).map(([key]) => [key, false]));
    assert.equal(subject(falsy).state, "not-met");
    assert.equal(subject({}).state, "inconclusive");
    assert.equal(subject({}).reason, "no-receipt");
  }
  for (const item of ["merged", "landed"] as const) {
    const criteria = part9().map(entry => (entry.id === "c2" ? { ...entry, check: { kind: "receipt", receipt: item } as const, threshold: { kind: "pass" } as const } : entry));
    const c2 = find(composeVerdict(input({ record: record(criteria), facts: { checksPassed: true, reviewApproved: true } })).criteria, "c2");
    assert.equal(c2.state, "inconclusive");
    assert.equal(c2.reason, "before-delivery");
  }
  const deliveryCriteria = (kind: "merged" | "landed") => part9().map(entry => (entry.id === "c2" ? { ...entry, check: { kind: "receipt", receipt: kind } as const, threshold: { kind: "pass" } as const } : entry));
  const delivered = (kind: "merged" | "landed", delivery: DeliveryFact | undefined, extra: Partial<ComposeInput> = {}) =>
    find(composeVerdict(input({ record: record(deliveryCriteria(kind)), facts: { checksPassed: true, reviewApproved: true, ...(delivery === undefined ? {} : { delivery }) }, ...extra })).criteria, "c2");
  for (const [kind, delivery, state, reason] of [
    ["merged", "none", "inconclusive", "before-delivery"], ["merged", "landed", "met", undefined], ["merged", "reverted", "met", undefined],
    ["landed", "none", "inconclusive", "before-delivery"], ["landed", "landed", "met", undefined], ["landed", "reverted", "not-met", undefined],
  ] as const) {
    assert.equal(delivered(kind, delivery).state, state, `${kind} with ${delivery}`);
    assert.equal(delivered(kind, delivery).reason, reason, `${kind} with ${delivery}`);
  }
  assert.equal(deliveryReceiptOf(deliveryCriteria("merged")[2]!), "merged");
  assert.equal(deliveryReceiptOf(part9()[2]!), undefined);
  const pinnedDelivery = deliveryCriteria("merged").map(entry => (entry.id === "c2" ? { ...entry, pinned: [{ path: PINNED, blob: BLOB }] } : entry));
  const voided = find(composeVerdict(input({ record: record(pinnedDelivery), facts: { delivery: "landed" }, changedPaths: { paths: [PINNED], truncated: false } })).criteria, "c2");
  assert.equal(voided.state, "inconclusive");
  assert.equal(voided.reason, "pinned-changed");
  assert.equal(find(composeVerdict(input()).criteria, "c2").reason, "no-receipt");

  const noReport = composeVerdict(input({ receipts: receiptsAllPass, reason: "evaluator-unavailable" }));
  assert.equal(find(noReport.criteria, "c0").reason, "no-evaluator");
  assert.equal(find(noReport.criteria, "c3").reason, "no-evaluator");
  assert.equal(find(noReport.criteria, "c1").state, "met");
  assert.equal(find(noReport.criteria, "c4").state, "met");
  assert.equal(noReport.result, "inconclusive");
  assert.equal(noReport.reason, "evaluator-unavailable");
  assert.equal(noReport.evaluatorResult, undefined);

  const partial = composeVerdict(input({ receipts: receiptsAllPass, report: report({ c0: "met" }, good) }));
  assert.equal(find(partial.criteria, "c3").reason, "not-assessed");
  assert.equal(find(partial.criteria, "c0").state, "met");
  assert.equal(partial.reason, undefined);

  const bareInconclusive = composeVerdict(input({ report: report({ c0: "inconclusive" }, []) }));
  assert.equal(find(bareInconclusive.criteria, "c0").state, "inconclusive");
  assert.equal(find(bareInconclusive.criteria, "c0").reason, undefined);

  const allMet = report({ c0: "met", c3: "met" }, good);
  const withCitation = part9().map(entry => (entry.id === "c2" ? { ...entry, check: { kind: "receipt", receipt: "checks-passed" } as const, threshold: { kind: "pass" } as const } : entry));
  const full = (facts: ComposeInput["facts"], extra: Partial<ComposeInput> = {}) =>
    composeVerdict(input({ record: record(withCitation, [rating("top-10", 4, HEAD)]), receipts: [receipt("c1", "pass"), receipt("c4", "pass")], facts, report: allMet, ...extra }));
  assert.equal(full({ checksPassed: true }, { changedPaths: { paths: [], truncated: false } }).result, "met");
  const pending = composeVerdict(input({
    record: record(withCitation), receipts: [receipt("c1", "pass"), receipt("c4", "pass")], facts: { checksPassed: true }, report: allMet,
  }));
  assert.equal(find(pending.criteria, "c5").state, "pending-owner");
  assert.equal(pending.result, "met");
  assert.equal(pending.counts.pendingOwner, 1);
  const ownerNo = composeVerdict(input({
    record: record(withCitation, [rating("top-10", 3, HEAD)]), receipts: [receipt("c1", "pass"), receipt("c4", "pass")], facts: { checksPassed: true }, report: allMet,
  }));
  assert.equal(ownerNo.result, "not-met");
  assert.equal(full({}).result, "inconclusive");
  const mixed = composeVerdict(input({ receipts: [receipt("c1", "fail")], report: allMet }));
  assert.equal(mixed.result, "not-met");
  assert.equal(mixed.counts.notMet, 1);
  assert.ok(mixed.counts.inconclusive > 0);
});

test("the host never upgrades: the report cannot lift an unknown, a missing input, or an owner wait", () => {
  const everyMet = report({ c0: "met", c1: "met", c2: "met", c3: "met", c4: "met", c5: "met" });
  const composed = composeVerdict(input({ receipts: [receipt("c1", "unknown")], report: everyMet }));
  const c1 = find(composed.criteria, "c1");
  assert.equal(c1.state, "inconclusive");
  assert.equal(c1.contradicted, undefined);
  assert.equal(find(composed.criteria, "c2").state, "inconclusive");
  assert.equal(find(composed.criteria, "c4").state, "inconclusive");
  assert.equal(find(composed.criteria, "c5").state, "pending-owner");
  assert.equal(composed.result, "inconclusive");
  assert.equal(composed.evaluatorResult, "met");
  const soft = composeVerdict(input({ receipts: [receipt("c1", "pass")], report: report({ c1: "inconclusive" }) }));
  assert.equal(find(soft.criteria, "c1").state, "met");
  assert.equal(find(soft.criteria, "c1").contradicted, undefined);
  const opposite = composeVerdict(input({ receipts: [receipt("c1", "pass")], report: report({ c1: "not-met" }) }));
  assert.equal(find(opposite.criteria, "c1").state, "met");
  assert.equal(find(opposite.criteria, "c1").contradicted, true);
  assert.equal(find(opposite.criteria, "c1").evaluatorState, "not-met");
});

test("unknown and retired ids and unresolved handles are dropped and counted", () => {
  const retired = part9().map(item => (item.id === "c3" ? { ...item, state: "retired" as const } : item));
  const given: VerdictReport = {
    kind: "verdict", result: "met",
    criteria: [
      { id: "c0", state: "met", evidence: [`file:${SHORTLIST}`, "file:../a", "citation:x"] },
      { id: "c3", state: "met", evidence: [`file:${SHORTLIST}`] },
      { id: "zz", state: "met", evidence: [] },
    ],
  };
  const composed = composeVerdict(input({ record: record(retired), report: given }));
  assert.equal(composed.dropped.unknownIds, 2);
  assert.equal(composed.dropped.handles, 2);
  assert.equal(composed.criteria.some(item => item.id === "c3"), false);
  assert.equal(composed.criteria.length, 5);
  assert.equal(find(composed.criteria, "c0").state, "inconclusive");
  assert.equal(find(composed.criteria, "c0").reason, "unresolved-evidence");
  assert.deepEqual(find(composed.criteria, "c0").handles, [`file:${SHORTLIST}`]);
});

test("handles resolve by form and membership", () => {
  const criteria = [
    ...part9().filter(item => item.id === "c0"),
    base("c1", { check: { kind: "artifact", path: "research/x.json" }, producer: "host", threshold: { kind: "pass" } }),
  ];
  const long = `file:${"a".repeat(396)}`;
  const context = {
    record: record(criteria),
    receipts: [receipt("c1", "pass")],
    changedPaths: { paths: ["src/a.ts", long.slice(5)], truncated: false },
  };
  const resolves = (handle: string) => resolveHandle(handle, context);
  for (const handle of [`receipt:${RUN}:1:c1`, "file:src/a.ts", "file:src/a.ts#L1-L9", "file:src/a.ts#L7", "file:research/x.json"]) {
    assert.equal(resolves(handle), true, handle);
  }
  for (const handle of [
    "file:../a", "file:/abs", "file:src/b.ts", `receipt:${"9".repeat(8)}-0000-4000-8000-000000000000:1:c1`, "citation:https://example.com/a",
    "file:src/../src/a.ts", "file:src/a.ts#L0", "file:src/a.ts#x", "file:", "", long,
  ]) {
    assert.equal(resolves(handle), false, handle);
  }
  assert.equal(long.length, 401);
  assert.equal(resolveHandle("file:src/a.ts", { ...context, receipts: undefined }), true);
  assert.equal(resolveHandle(`receipt:${RUN}:1:c1`, { ...context, receipts: undefined }), false);

  const empty = composeVerdict(input({ report: report({ c0: "met" }, []) }));
  assert.equal(find(empty.criteria, "c0").state, "inconclusive");
  assert.equal(find(empty.criteria, "c0").reason, "unresolved-evidence");
  const oneBad = composeVerdict(input({ report: report({ c0: "not-met" }, [`file:${SHORTLIST}`, "file:/abs"]) }));
  assert.equal(find(oneBad.criteria, "c0").state, "inconclusive");
  assert.equal(find(oneBad.criteria, "c0").reason, "unresolved-evidence");
  const ok = composeVerdict(input({ report: report({ c0: "not-met" }, [`file:${SHORTLIST}`]) }));
  assert.equal(find(ok.criteria, "c0").state, "not-met");
});

test("a changed pinned file voids met", () => {
  const receipts = [receipt("c4", "pass")];
  const state = (changedPaths: ComposeInput["changedPaths"]) => find(composeVerdict(input({ receipts, changedPaths })).criteria, "c4");
  const changed = state({ paths: [PINNED], truncated: false });
  assert.equal(changed.state, "inconclusive");
  assert.equal(changed.reason, "pinned-changed");
  assert.equal(state({ paths: [], truncated: true }).reason, "pinned-changed");
  assert.equal(state({ paths: ["src/a.ts"], truncated: false }).state, "met");
  assert.equal(state({ paths: [], truncated: false }).state, "met");
  assert.equal(find(composeVerdict(input({ receipts: [receipt("c4", "fail")], changedPaths: { paths: [PINNED], truncated: false } })).criteria, "c4").state, "not-met");
  assert.equal(find(composeVerdict(input({ receipts: [receipt("c1", "pass")], changedPaths: { paths: [], truncated: true } })).criteria, "c1").state, "met");
  const voided = composeVerdict(input({ receipts, changedPaths: { paths: [PINNED], truncated: false }, report: report({ c4: "not-met" }) }));
  assert.equal(find(voided.criteria, "c4").state, "inconclusive");
  assert.equal(find(voided.criteria, "c4").contradicted, undefined);
});

test("owner criteria read only a rating on the head", () => {
  const state = (entries: LogEntry[], head = HEAD) => find(composeVerdict(input({ record: record(part9(), entries), head })).criteria, "c5").state;
  assert.equal(state([rating("top-10", 4.5, HEAD)]), "met");
  assert.equal(state([rating("top-10", 4, HEAD)]), "met");
  assert.equal(state([rating("top-10", 3.5, HEAD)]), "not-met");
  assert.equal(state([rating("top-10", 5, OLD)]), "pending-owner");
  assert.equal(state([]), "pending-owner");
  assert.equal(state([rating("other", 5, HEAD)]), "pending-owner");
  assert.equal(state([rating("top-10", 5, HEAD), rating("top-10", 2, HEAD)]), "not-met");
  assert.equal(state([rating("top-10", 2, HEAD), rating("top-10", 5, HEAD)]), "met");
  const forged: LogEntry = { ...rating("top-10", 5, HEAD), actor: "evaluator", authority: "claim" };
  assert.equal(state([forged]), "pending-owner");
  const text: LogEntry = { ...rating("top-10", 5, HEAD), after: { inline: { subject: "top-10", score: "5", commit: HEAD } } };
  assert.equal(state([text]), "pending-owner");
  const lifted = composeVerdict(input({ report: report({ c5: "met" }) }));
  assert.equal(find(lifted.criteria, "c5").state, "pending-owner");
  assert.equal(find(lifted.criteria, "c5").contradicted, undefined);
});

function eightCriteria(): Criterion[] {
  const items: Criterion[] = part9().slice(0, 1);
  for (let index = 1; index < 8; index++) {
    items.push(base(`c${index}`, { check: { kind: "judgement", item: `item-${index}` }, producer: "evaluator", threshold: { kind: "pass" } }));
  }
  return items;
}

test("the record write holds latest without notes and fits one entry", () => {
  const criteria = eightCriteria();
  const note = "n".repeat(500);
  const given: VerdictReport = {
    kind: "verdict", result: "met",
    criteria: criteria.map(item => ({ id: item.id, state: "met" as const, evidence: ["file:src/a.ts"], note })),
  };
  const composed = composeVerdict(input({ record: record(criteria), report: given, changedPaths: { paths: ["src/a.ts"], truncated: false } }));
  assert.equal(composed.criteria.length, 8);
  assert.equal(find(composed.criteria, "c3").note?.length, 500);
  const start = record(criteria);
  const written = verdictRecord(start, composed, META);
  assert.notEqual(written, "log-full");
  if (written === "log-full") return;
  assert.equal(written.version, start.version + 1);
  assert.equal(written.log.length, start.log.length + 1);
  const entry = written.log[written.log.length - 1]!;
  assert.equal(entry.op, "verdict.recorded");
  assert.equal(entry.target, "c0");
  assert.equal(entry.version, written.version);
  for (const value of [entry.before, entry.after]) {
    assert.ok(value !== undefined && "inline" in value);
    assert.ok(canonicalBytes(value.inline) <= 2048);
  }
  for (const item of written.criteria) {
    assert.equal(item.latest?.state, "met");
    assert.equal(item.latest?.verdictId, VERDICT);
    assert.equal("note" in (item.latest ?? {}), false);
  }
  assert.equal(objectiveRecordSchema.safeParse(written).success, true);
  const rebuilt = rebuildVersion(written, start.version);
  assert.equal(rebuilt.criteria.every(item => item.latest === undefined), true);

  const second = verdictRecord(written, composed, { ...META, verdictId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" });
  assert.notEqual(second, "log-full");
  if (second === "log-full") return;
  const secondEntry = second.log[second.log.length - 1]!;
  assert.ok(secondEntry.before !== undefined && "inline" in secondEntry.before);
  assert.equal(JSON.stringify(secondEntry.before.inline).includes(VERDICT), true);
  assert.equal(rebuildVersion(second, written.version).criteria[0]!.latest?.verdictId, VERDICT);

  const crowded = record(part9(), [], 299);
  assert.equal(crowded.log.length, 299);
  const receipts = [receipt("c1", "pass"), receipt("c4", "fail")];
  const contradictedOnce = composeVerdict(input({ record: crowded, receipts, report: report({ c0: "met", c4: "met" }) }));
  assert.equal(find(contradictedOnce.criteria, "c4").contradicted, true);
  assert.equal(verdictRecord(crowded, contradictedOnce, META), "log-full");
  const quiet = composeVerdict(input({ record: crowded, report: report({ c0: "met" }) }));
  const single = verdictRecord(crowded, quiet, META);
  assert.notEqual(single, "log-full");
  if (single !== "log-full") assert.equal(single.log.length, 300);
});

test("composition is pure and leaves its inputs unchanged", () => {
  const given = input({ receipts: [receipt("c1", "pass")], report: report({ c0: "met", c1: "not-met" }) });
  given.facts.delivery = "reverted";
  const before = JSON.stringify(given);
  const first = composeVerdict(given);
  const second = composeVerdict(given);
  assert.equal(JSON.stringify(given), before);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("a superseding verdict replaces latest only where it names the superseded verdict", () => {
  const SECOND = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const THIRD = "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
  const criteria = part9().map(entry => (entry.id === "c2" ? { ...entry, check: { kind: "receipt", receipt: "merged" } as const, threshold: { kind: "pass" } as const } : entry));
  const start = record(criteria);
  const first = verdictRecord(start, composeVerdict(input({ record: start, receipts: [receipt("c1", "pass")] })), META);
  assert.notEqual(first, "log-full");
  if (first === "log-full") return;
  const partial = composeVerdict(input({ record: first, receipts: [receipt("c1", "fail")] }));
  const later = verdictRecord(first, { ...partial, criteria: partial.criteria.filter(item => item.id === "c1") }, { ...META, verdictId: SECOND });
  assert.notEqual(later, "log-full");
  if (later === "log-full") return;
  const latestOf = (item: ObjectiveRecord, id: string) => item.criteria.find(entry => entry.id === id)?.latest?.verdictId;
  assert.equal(latestOf(later, "c1"), SECOND);
  assert.equal(latestOf(later, "c2"), VERDICT);
  const mixed = later;
  const composed = composeVerdict(input({ record: mixed, facts: { delivery: "landed" }, receipts: [receipt("c1", "pass")] }));
  const answered = { ...composed, criteria: composed.criteria.map(item => (item.id === "c1" ? { ...item, contradicted: true as const, evaluatorState: "not-met" as const } : item)) };
  const superseding = verdictRecord(mixed, answered, { ...META, verdictId: THIRD, supersedes: ["0d4e5f6a-7b8c-4d9e-9fa0-2b3c4d5e6f70", VERDICT] });
  assert.notEqual(superseding, "log-full");
  if (superseding === "log-full") return;
  assert.equal(latestOf(superseding, "c2"), THIRD);
  assert.equal(latestOf(superseding, "c1"), SECOND);
  assert.equal(superseding.criteria.find(entry => entry.id === "c2")?.latest?.state, "met");
  assert.equal(superseding.log.filter(entry => entry.handle === `verdict:${THIRD}`).length, 1, "no contradiction entry for a criterion this verdict does not write");
  const empty = verdictRecord(superseding, composed, { ...META, verdictId: "9c3d4e5f-6a7b-4c8d-8e9f-1a2b3c4d5e6f", supersedes: ["0d4e5f6a-7b8c-4d9e-9fa0-2b3c4d5e6f70"] });
  assert.notEqual(empty, "log-full");
  if (empty === "log-full") return;
  assert.equal(empty.log.length, superseding.log.length + 1);
  assert.equal(objectiveRecordSchema.safeParse(empty).success, true);
  for (let version = 1; version <= empty.version; version += 1) assert.equal(rebuildVersion(empty, version).version, version);
  assert.equal(latestOf(rebuildVersion(empty, later.version), "c1"), SECOND);
  assert.equal(latestOf(rebuildVersion(empty, first.version), "c1"), VERDICT);
});

test("a delivery receipt never records an evaluator contradiction", () => {
  const criteria = part9().map(entry => (entry.id === "c2" ? { ...entry, check: { kind: "receipt", receipt: "landed" } as const, threshold: { kind: "pass" } as const } : entry));
  for (const delivery of ["landed", "reverted"] as const) {
    const withReport = report({ c0: "met", c2: delivery === "landed" ? "not-met" : "met" });
    const composed = composeVerdict(input({ record: record(criteria), facts: { delivery }, report: withReport }));
    const c2 = find(composed.criteria, "c2");
    assert.equal(c2.state, delivery === "landed" ? "met" : "not-met");
    assert.equal(c2.contradicted, undefined);
  }
});
