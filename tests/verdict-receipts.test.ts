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

function reopen(f: Fixture, fact = f.host.deliveryFact): Fixture {
  const holder = JSON.parse(f.host.persisted.get(RUN)!) as FakeHolder;
  const host = new FakeHost(f.world, new Map([[RUN, holder]]));
  host.deliveryFact = fact;
  const verdicts = new TeamVerdicts(host);
  host.verdicts = verdicts;
  if (f.world.store) verdicts.goals = goalPort(f.world);
  return { world: f.world, host, verdicts, holder };
}

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

  before = snapshot(f);
  assert.equal(f.verdicts.settleReceipt(f.holder), false);
  f.host.deliveryFact = "none";
  assert.equal(f.verdicts.settleReceipt(f.holder), false);
  unchanged(f, before);
  assert.equal(f.holder.outbox.length, outbox + 1);

  f.host.deliveryFact = "reverted";
  assert.equal(f.verdicts.settleReceipt(f.holder), true);
  assert.equal(recorded(f).length, 3);
  assert.equal(stateOf(f, "c3"), "met");
  assert.equal(stateOf(f, "c4"), "not-met");
});

test("a restart at any save of a late verdict writes nothing twice", () => {
  const counts = (f: Fixture, total: number): string[] => {
    const handles = recorded(f).map(entry => entry.handle!);
    assert.equal(recorded(f).length, total, "entries in the log");
    assert.equal(new Set(handles).size, total, "each handle appears once");
    assert.equal(f.holder.outbox.length, total, "rows");
    assert.equal(new Set(f.holder.outbox.map(row => row.verdictId)).size, total, "each row id appears once");
    assert.equal(f.holder.run.assessment?.verdictId, f.holder.outbox.at(-1)!.verdictId, "the assessment is the newest row's");
    return handles;
  };

  const a = delivered();
  a.host.deliveryFact = "landed";
  a.host.failSaveAt = 1;
  assert.throws(() => a.verdicts.settleReceipt(a.holder));
  const a2 = reopen(a);
  assert.equal(a2.holder.verdict?.delivery, undefined);
  assert.equal(a2.verdicts.settleReceipt(a2.holder), true);
  counts(a2, 2);
  assert.equal(a2.host.deliveryReads, 1);
  assert.equal(a2.verdicts.settleReceipt(a2.holder), false);

  const b = delivered();
  b.host.deliveryFact = "landed";
  b.host.failSaveAt = 2;
  assert.throws(() => b.verdicts.settleReceipt(b.holder));
  const b2 = reopen(b);
  assert.notEqual(b2.holder.verdict?.verdictId, b2.holder.run.assessment?.verdictId, "the new id is saved and not yet the assessment");
  assert.equal(b2.verdicts.settleReceipt(b2.holder), true);
  counts(b2, 2);
  assert.equal(b2.host.deliveryReads, 0, "the saved fact is composed without a read");

  for (const failing of [2, 3]) {
    const c = delivered({ goal: true });
    c.host.deliveryFact = "landed";
    c.host.failSaveAt = failing;
    assert.throws(() => c.verdicts.settleReceipt(c.holder));
    assert.equal(recorded(c).length, failing === 3 ? 2 : 1, failing === 3 ? "the goal's record holds the entry already" : "nothing is written before the pending verdict is saved");
    const c2 = reopen(c);
    assert.equal(c2.holder.outbox.length, 1, "no row reached the saved holder");
    assert.equal(c2.verdicts.settleReceipt(c2.holder), true);
    assert.equal(recorded(c2).length, 2, "no second entry");
    assert.equal(recorded(c2).at(-1)!.handle, `verdict:${c2.holder.verdict!.verdictId}`);
    assert.equal(c2.holder.outbox.length, 2);
    assert.equal(c2.holder.run.assessment?.verdictId, c2.holder.verdict!.verdictId);
  }

  const d = delivered();
  d.host.deliveryFact = "landed";
  assert.equal(d.verdicts.settleReceipt(d.holder), true);
  const d2 = reopen(d);
  const before = snapshot(d2);
  for (let pass = 0; pass < 3; pass += 1) assert.equal(d2.verdicts.settleReceipt(d2.holder), false);
  unchanged(d2, before);
  counts(d2, 2);

  const e = delivered();
  e.host.deliveryFact = "landed";
  assert.equal(e.verdicts.settleReceipt(e.holder), true);
  const e2 = reopen(e, "reverted");
  assert.equal(e2.verdicts.settleReceipt(e2.holder), true);
  assert.equal(e2.verdicts.settleReceipt(e2.holder), false);
  counts(reopen(e2), 3);
  assert.equal(stateOf(e2, "c4"), "not-met");

  const f = delivered();
  f.host.deliveryFact = "landed";
  f.host.failSaveAt = 1;
  assert.throws(() => f.verdicts.settleReceipt(f.holder));
  const reads = f.host.deliveryReads;
  assert.equal(f.verdicts.settleReceipt(f.holder), true);
  assert.equal(f.host.deliveryReads, reads, "no store read");
  counts(f, 2);

  for (const failing of [2, 3]) {
    const g = delivered();
    g.host.deliveryFact = "landed";
    g.host.failSaveAt = failing;
    assert.throws(() => g.verdicts.settleReceipt(g.holder));
    const read = g.host.deliveryReads;
    assert.equal(g.verdicts.settleReceipt(g.holder), true, "the retry in the same process finishes the late verdict");
    assert.equal(g.host.deliveryReads, read, "no second store read");
    counts(g, 2);
    assert.equal(g.verdicts.settleReceipt(g.holder), false);
  }
});

test("a late verdict judges only what its earlier verdict held, and replaces what any earlier id wrote", () => {
  const latest = (f: Fixture, id: string) => recordIn(f).criteria.find(item => item.id === id)?.latest;
  const drop = (f: Fixture, id: string) => { f.holder.verdict!.composed!.criteria = f.holder.verdict!.composed!.criteria.filter(item => item.id !== id); };

  const merged = delivered({ criteria: [MERGED] });
  merged.host.deliveryFact = "landed";
  assert.equal(merged.verdicts.settleReceipt(merged.holder), true);
  merged.host.deliveryFact = "reverted";
  const kept = snapshot(merged);
  assert.equal(merged.verdicts.settleReceipt(merged.holder), false);
  assert.equal(merged.verdicts.settleReceipt(merged.holder), false);
  unchanged(merged, kept);
  assert.equal(recorded(merged).length, 2);

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

  const failed = delivered();
  const before = structuredClone(failed.holder.objectiveRecord);
  failed.host.deliveryFact = "landed";
  assert.equal(failed.verdicts.settleReceipt(failed.holder), true);
  failed.holder.objectiveRecord = before;
  failed.holder.verdict!.written = "write-failed";
  failed.host.deliveryFact = "reverted";
  assert.equal(failed.verdicts.settleReceipt(failed.holder), true);
  assert.deepEqual([latest(failed, "c4")?.verdictId, latest(failed, "c4")?.state], [failed.holder.verdict!.verdictId, "not-met"]);

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

  const lost = delivered();
  lost.host.deliveryFact = "landed";
  lost.host.failSaveAt = 2;
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

  const reads = delivered();
  reads.holder.run.status = "ready-for-review";
  reads.host.deliveryFact = "landed";
  assert.equal(reads.verdicts.settleReceipt(reads.holder), true);
  assert.equal(reads.host.deliveryReads, 1);

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

test("a late verdict interrupted at its pending save keeps the earlier assessment until the record reads again", () => {
  const a = delivered();
  const earlier = a.holder.run.assessment!.verdictId;
  a.host.deliveryFact = "landed";
  a.host.failSaveAt = 3;
  assert.throws(() => a.verdicts.settleReceipt(a.holder));
  const b = reopen(a);
  assert.equal(b.holder.verdict?.status, "recording");
  const record = b.holder.objectiveRecord;
  delete b.holder.objectiveRecord;
  for (let pass = 0; pass < 2; pass += 1) {
    b.verdicts.restore([b.holder]);
    b.verdicts.settleReceipt(b.holder);
    assert.equal(b.holder.run.assessment?.verdictId, earlier, "the earlier assessment stands");
    assert.equal(b.holder.verdict?.status, "recording", "the late verdict stays retryable");
  }
  b.holder.objectiveRecord = record;
  assert.equal(b.verdicts.settleReceipt(b.holder), true);
  assert.notEqual(b.holder.run.assessment?.verdictId, earlier, "the late verdict's assessment");
  assert.equal(b.holder.run.assessment?.verdictId, b.holder.verdict!.verdictId);
  assert.equal(stateOf(b, "c3"), "met");
});
