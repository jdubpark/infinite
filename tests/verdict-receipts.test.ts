import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { VERDICT_OPS } from "../packages/host/src/objective-record.js";
import type { Criterion } from "../packages/host/src/objective-types.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { TeamVerdicts, VERDICT_EVENTS } from "../packages/host/src/team-verdicts.js";
import { deliveryPort } from "../packages/host/src/verdict-delivery.js";
import { AT, FakeHost, HEAD, RUN, SAME_FAMILY, drive, evaluating, eventTexts, finishPass, fixture, goalPort, recordIn, recordOf, reportEvaluator, reportOf, settle } from "./fixtures/verdict-runtime.js";
import type { FakeHolder, Fixture } from "./fixtures/verdict-runtime.js";

const MERGED: Criterion = { id: "c3", origin: "owner", statement: "The run is merged", check: { kind: "receipt", receipt: "merged" }, producer: "host", threshold: { kind: "pass" }, state: "active" };
const LANDED: Criterion = { id: "c4", origin: "owner", statement: "The run stays landed", check: { kind: "receipt", receipt: "landed" }, producer: "host", threshold: { kind: "pass" }, state: "active" };

const sha = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const recorded = (f: Fixture) => recordIn(f).log.filter(entry => entry.op === VERDICT_OPS.recorded);
const stateOf = (f: Fixture, id: string) => f.verdicts.detail(RUN)!.criteria.find(item => item.id === id)?.state;

/** A reviewed run whose first verdict is composed and saved, then delivered: the status is `merged` and saved. */
function delivered(options: { goal?: boolean; criteria?: Criterion[] } = {}): Fixture {
  const f = fixture({ run: { lineup: SAME_FAMILY }, record: recordOf(RUN, 1, options.criteria ?? [MERGED, LANDED]), ...(options.goal === true ? { goal: true } : {}) });
  assert.equal(f.verdicts.reviewed(f.holder), true);
  finishPass(f.world, RUN, []);
  drive(f, "done");
  assert.equal(f.holder.verdict?.status, "done");
  f.holder.run.status = "merged";
  f.host.save(f.holder);
  return f;
}

/** A restart: the holder as last saved, a new host and service, the world (passes, goal record, uuids) kept. */
function reopen(f: Fixture, fact = f.host.deliveryFact): Fixture {
  const holder = JSON.parse(f.host.persisted.get(RUN)!) as FakeHolder;
  const host = new FakeHost(f.world, new Map([[RUN, holder]]));
  host.deliveryFact = fact;
  const verdicts = new TeamVerdicts(host);
  host.verdicts = verdicts;
  if (f.world.store) verdicts.goals = goalPort(f.world);
  return { world: f.world, host, verdicts, holder };
}

/** What a pass must not touch: lengths first, then one digest of each large part. */
function unchanged(f: Fixture, before: { saves: number; uuids: number; events: number; record: string; holder: string }): void {
  assert.equal(f.host.saves, before.saves, "nothing is saved");
  assert.equal(f.world.uuids, before.uuids, "no id is drawn");
  assert.equal(f.holder.run.events.length, before.events, "no event is added");
  assert.equal(sha(recordIn(f)), before.record, "the record is as it was");
  assert.equal(sha(f.holder), before.holder, "the holder is as it was");
}
const snapshot = (f: Fixture) => ({ saves: f.host.saves, uuids: f.world.uuids, events: f.holder.run.events.length, record: sha(recordIn(f)), holder: sha(f.holder) });

test("a changed delivery fact composes one new verdict and a repeat composes none", () => {
  const f = evaluating({ record: recordOf(RUN, 1, [MERGED, LANDED]) });
  reportEvaluator(f, f.member, reportOf({ c0: "met" }));
  settle(f.host);
  assert.equal(f.holder.verdict?.status, "done");
  f.holder.run.status = "merged";
  f.host.save(f.holder);
  const first = f.holder.verdict!.verdictId;
  assert.equal(stateOf(f, "c3"), "inconclusive", "before the delivery is seen");
  const run = { status: f.holder.run.status, revision: f.holder.run.revision, head: f.holder.run.headCommit, members: f.holder.run.members.length, pending: f.holder.run.pending };

  // A ledger without the landing changes nothing.
  f.host.deliveryFact = "none";
  let before = snapshot(f);
  assert.equal(f.verdicts.settleReceipt(f.holder), false);
  unchanged(f, before);

  f.host.deliveryFact = "landed";
  const outbox = f.holder.outbox.length;
  assert.equal(f.verdicts.settleReceipt(f.holder), true);
  const second = f.holder.verdict!.verdictId;
  assert.notEqual(second, first, "one new verdict id");
  assert.equal(f.holder.run.assessment?.verdictId, second);
  assert.equal(f.holder.run.assessment?.revision, 1);
  assert.equal(recorded(f).length, 2, "one more verdict.recorded entry");
  assert.equal(recorded(f).at(-1)!.handle, `verdict:${second}`);
  assert.equal(f.holder.outbox.length, outbox + 1, "one more row");
  assert.equal(f.holder.outbox.at(-1)!.verdictId, second);
  assert.equal(eventTexts(f.holder).filter(text => text === VERDICT_EVENTS.delivery).length, 1);
  assert.equal(stateOf(f, "c3"), "met");
  assert.equal(stateOf(f, "c4"), "met");
  assert.equal(f.verdicts.detail(RUN)?.evaluatorResult, "met", "the evaluator's answer is composed again, not asked again");
  assert.deepEqual({ status: f.holder.run.status, revision: f.holder.run.revision, head: f.holder.run.headCommit, members: f.holder.run.members.length, pending: f.holder.run.pending }, run);

  // A repeat draws no id and writes nothing; the fact never moves back.
  before = snapshot(f);
  assert.equal(f.verdicts.settleReceipt(f.holder), false);
  f.host.deliveryFact = "none";
  assert.equal(f.verdicts.settleReceipt(f.holder), false);
  unchanged(f, before);
  assert.equal(f.holder.outbox.length, outbox + 1);

  // A revert is a third verdict: the landed criterion turns, the merged one does not.
  f.host.deliveryFact = "reverted";
  assert.equal(f.verdicts.settleReceipt(f.holder), true);
  assert.equal(recorded(f).length, 3);
  assert.equal(stateOf(f, "c3"), "met");
  assert.equal(stateOf(f, "c4"), "not-met");
});

test("a restart at either save of a late verdict writes nothing twice", () => {
  const counts = (f: Fixture, total: number): string[] => {
    const handles = recorded(f).map(entry => entry.handle!);
    assert.equal(recorded(f).length, total, "entries in the log");
    assert.equal(new Set(handles).size, total, "each handle appears once");
    assert.equal(f.holder.outbox.length, total, "rows");
    assert.equal(new Set(f.holder.outbox.map(row => row.verdictId)).size, total, "each row id appears once");
    assert.equal(f.holder.run.assessment?.verdictId, f.holder.outbox.at(-1)!.verdictId, "the assessment is the newest row's");
    return handles;
  };

  // A: save 1 throws; a restart finds the old id and no fact, and one pass gives one late verdict.
  const a = delivered();
  a.host.deliveryFact = "landed";
  a.host.failSaveIn = 1;
  assert.throws(() => a.verdicts.settleReceipt(a.holder));
  const a2 = reopen(a);
  assert.equal(a2.holder.verdict?.delivery, undefined);
  assert.equal(a2.verdicts.settleReceipt(a2.holder), true);
  counts(a2, 2);
  assert.equal(a2.host.deliveryReads, 1);
  assert.equal(a2.verdicts.settleReceipt(a2.holder), false);

  // B: save 1 passes, the record write passes, save 2 throws; the restart finds the new id and composes it with no store read.
  const b = delivered();
  b.host.deliveryFact = "landed";
  b.host.failSaveIn = 2;
  assert.throws(() => b.verdicts.settleReceipt(b.holder));
  const b2 = reopen(b);
  assert.notEqual(b2.holder.verdict?.verdictId, b2.holder.run.assessment?.verdictId, "the new id is saved and not yet the assessment");
  assert.equal(b2.verdicts.settleReceipt(b2.holder), true);
  counts(b2, 2);
  assert.equal(b2.host.deliveryReads, 0, "the saved fact is composed without a read");

  // C: as B on a goal run, where the record write saved the goal's file before the restart: the entry exists and is not written again.
  const c = delivered({ goal: true });
  c.host.deliveryFact = "landed";
  c.host.failSaveIn = 2;
  assert.throws(() => c.verdicts.settleReceipt(c.holder));
  assert.equal(recorded(c).length, 2, "the goal's record holds the entry already");
  const c2 = reopen(c);
  assert.equal(c2.holder.outbox.length, 1, "no row reached the saved holder");
  assert.equal(c2.verdicts.settleReceipt(c2.holder), true);
  assert.equal(recorded(c2).length, 2, "no second entry");
  assert.equal(recorded(c2).at(-1)!.handle, `verdict:${c2.holder.verdict!.verdictId}`);
  assert.equal(c2.holder.outbox.length, 2);
  assert.equal(c2.holder.run.assessment?.verdictId, c2.holder.verdict!.verdictId);

  // D: a restart after save 2; the next three passes write nothing.
  const d = delivered();
  d.host.deliveryFact = "landed";
  assert.equal(d.verdicts.settleReceipt(d.holder), true);
  const d2 = reopen(d);
  const before = snapshot(d2);
  for (let pass = 0; pass < 3; pass += 1) assert.equal(d2.verdicts.settleReceipt(d2.holder), false);
  unchanged(d2, before);
  counts(d2, 2);

  // E: landed, restart, reverted: three verdicts in all, each id once.
  const e = delivered();
  e.host.deliveryFact = "landed";
  assert.equal(e.verdicts.settleReceipt(e.holder), true);
  const e2 = reopen(e, "reverted");
  assert.equal(e2.verdicts.settleReceipt(e2.holder), true);
  assert.equal(e2.verdicts.settleReceipt(e2.holder), false);
  counts(reopen(e2), 3);
  assert.equal(stateOf(e2, "c4"), "not-met");

  // F: save 1 throws and the process lives; the next pass finishes through the saved fact with no store read.
  const f = delivered();
  f.host.deliveryFact = "landed";
  f.host.failSaveIn = 1;
  assert.throws(() => f.verdicts.settleReceipt(f.holder));
  const reads = f.host.deliveryReads;
  assert.equal(f.verdicts.settleReceipt(f.holder), true);
  assert.equal(f.host.deliveryReads, reads, "no store read");
  counts(f, 2);

  // F2: save 2 throws and the process lives; memory holds the verdict, and a pass adds nothing to it.
  const g = delivered();
  g.host.deliveryFact = "landed";
  g.host.failSaveIn = 2;
  assert.throws(() => g.verdicts.settleReceipt(g.holder));
  const kept = snapshot(g);
  assert.equal(g.verdicts.settleReceipt(g.holder), false);
  unchanged(g, kept);
  counts(g, 2);
});

test("a late verdict judges only what its earlier verdict held, and replaces what any earlier id wrote", () => {
  const latest = (f: Fixture, id: string) => recordIn(f).criteria.find(item => item.id === id)?.latest;
  const drop = (f: Fixture, id: string) => { f.holder.verdict!.composed!.criteria = f.holder.verdict!.composed!.criteria.filter(item => item.id !== id); };

  // Only `merged` waits: a revert of the landing changes nothing, on this pass or the next.
  const merged = delivered({ criteria: [MERGED] });
  merged.host.deliveryFact = "landed";
  assert.equal(merged.verdicts.settleReceipt(merged.holder), true);
  merged.host.deliveryFact = "reverted";
  const kept = snapshot(merged);
  assert.equal(merged.verdicts.settleReceipt(merged.holder), false);
  assert.equal(merged.verdicts.settleReceipt(merged.holder), false);
  unchanged(merged, kept);
  assert.equal(recorded(merged).length, 2);

  // The record names `landed`, but the first verdict did not hold it: the late verdict leaves it out, and a revert composes nothing.
  const later = delivered();
  const first = later.holder.verdict!.verdictId;
  drop(later, "c4");
  later.host.deliveryFact = "landed";
  assert.equal(later.verdicts.settleReceipt(later.holder), true);
  assert.deepEqual(later.verdicts.detail(RUN)!.criteria.map(item => item.id).includes("c4"), false);
  assert.equal(latest(later, "c4")?.verdictId, first, "the record keeps the first verdict's answer for it");
  assert.equal(latest(later, "c3")?.verdictId, later.holder.verdict!.verdictId);
  later.host.deliveryFact = "reverted";
  assert.equal(later.verdicts.settleReceipt(later.holder), false, "a criterion the verdicts never held starts no third verdict");

  // The second verdict's record write failed: the third replaces what the first wrote.
  const failed = delivered();
  const before = structuredClone(failed.holder.objectiveRecord);
  failed.host.deliveryFact = "landed";
  assert.equal(failed.verdicts.settleReceipt(failed.holder), true);
  failed.holder.objectiveRecord = before;
  failed.holder.verdict!.written = "write-failed";
  failed.host.deliveryFact = "reverted";
  assert.equal(failed.verdicts.settleReceipt(failed.holder), true);
  assert.deepEqual([latest(failed, "c4")?.verdictId, latest(failed, "c4")?.state], [failed.holder.verdict!.verdictId, "not-met"]);

  // A refused report kept beside a reason is no answer: the late verdict reads the reason.
  const refused = evaluating({ record: recordOf(RUN, 1, [MERGED]) });
  reportEvaluator(refused, refused.member, reportOf({ c0: "met" }));
  settle(refused.host);
  assert.equal(stateOf(refused, "c0"), "met");
  refused.holder.verdict!.reason = "evaluator-unavailable";
  refused.holder.run.status = "merged";
  refused.host.deliveryFact = "landed";
  assert.equal(refused.verdicts.settleReceipt(refused.holder), true);
  assert.equal(stateOf(refused, "c0"), "inconclusive");
  assert.equal(refused.verdicts.detail(RUN)?.evaluatorResult, undefined);

  // A restart between the two saves, and the record is gone: the assessment stays.
  const lost = delivered();
  lost.host.deliveryFact = "landed";
  lost.host.failSaveIn = 2;
  assert.throws(() => lost.verdicts.settleReceipt(lost.holder));
  const again = reopen(lost);
  delete again.holder.objectiveRecord;
  const assessed = again.holder.run.assessment?.verdictId;
  assert.notEqual(again.holder.verdict!.verdictId, assessed, "the new id was saved");
  assert.equal(again.verdicts.settleReceipt(again.holder), false);
  assert.equal(again.holder.run.assessment?.verdictId, assessed);
});

const snapshotOf = (f: Fixture) => ({ saves: f.host.saves, uuids: f.world.uuids, holder: sha(f.holder) });

test("a run outside the rule is returned before any store read", () => {
  const refused: [string, (f: Fixture) => void][] = [
    ["not pinned", f => { delete f.holder.run.verdicts; }],
    ["delivering", f => { f.holder.run.status = "delivering"; }],
    ["blocked", f => { f.holder.run.status = "blocked"; }],
    ["paused", f => { f.holder.run.status = "paused"; }],
    ["cancelled", f => { f.holder.run.status = "cancelled"; }],
    ["not done", f => { f.holder.verdict!.status = "queued"; }],
    ["no-change", f => { f.holder.verdict!.kind = "no-change"; }],
    ["another revision", f => { f.holder.run.revision = 2; }],
    ["another head", f => { f.holder.run.headCommit = "2".repeat(40); }],
    ["no assessment", f => { delete f.holder.run.assessment; }],
    ["no since", f => { delete f.holder.verdict!.since; }],
    ["record unavailable", f => { f.holder.verdict!.reason = "record-unavailable"; }],
    // The record names delivery criteria, but none of this verdict's criteria waited for the delivery.
    ["nothing waited", f => { for (const item of f.holder.verdict!.composed!.criteria) if (item.reason === "before-delivery") item.reason = "no-receipt"; }],
  ];
  for (const [name, change] of refused) {
    const f = delivered();
    change(f);
    f.host.deliveryFact = "landed";
    const before = { saves: f.host.saves, holder: sha(f.holder) };
    assert.equal(f.verdicts.settleReceipt(f.holder), false, name);
    assert.equal(f.host.deliveryReads, 0, `${name}: no store read`);
    assert.equal(sha(f.holder), before.holder, `${name}: the holder is as it was`);
    assert.equal(f.host.saves, before.saves, `${name}: no save`);
  }
  // A record that is gone is seen after the ledger is asked: nothing is saved and no id is drawn.
  const gone = delivered();
  delete gone.holder.objectiveRecord;
  gone.host.deliveryFact = "landed";
  const kept = snapshotOf(gone);
  assert.equal(gone.verdicts.settleReceipt(gone.holder), false, "no record");
  assert.deepEqual(snapshotOf(gone), kept, "no record: nothing is saved and no id is drawn");
  const noCriterion = delivered({ criteria: [] });
  noCriterion.host.deliveryFact = "landed";
  assert.equal(noCriterion.verdicts.settleReceipt(noCriterion.holder), false);
  assert.equal(noCriterion.host.deliveryReads, 0, "no delivery criterion: no store read");

  // The same run, unchanged, is the one that reads; a ready-for-review run reads too.
  const reads = delivered();
  reads.holder.run.status = "ready-for-review";
  reads.host.deliveryFact = "landed";
  assert.equal(reads.verdicts.settleReceipt(reads.holder), true);
  assert.equal(reads.host.deliveryReads, 1);

  // The port over a store with no outcome module reads nothing and says so; over one with it, an unseen run is none.
  const root = mkdtempSync(join(tmpdir(), "infinite-verdict-receipts-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  try {
    store.register(configurationModule());
    assert.equal(deliveryPort(store)(RUN, HEAD, AT), undefined);
    store.register(outcomeModule({ now: () => AT }));
    assert.equal(deliveryPort(store)(RUN, HEAD, AT), "none");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
