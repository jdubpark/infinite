import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import type { GoalRecordPort } from "../packages/host/src/objective-intent.js";
import type { ObjectiveReceipt } from "../packages/host/src/objective-receipts.js";
import { objectiveError } from "../packages/host/src/objective-record.js";
import { recordDigest } from "../packages/host/src/objective-types.js";
import type { Criterion, LogEntry, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { evaluatorPrompt } from "../packages/host/src/verdict-prompt.js";
import type { VerdictEventData } from "../packages/host/src/verdict-store.js";
import type { AssessedState, VerdictReport } from "../packages/host/src/verdict-types.js";
import { TeamVerdicts, VERDICT_EVENTS, VERDICT_TESTING_WAIT_MS } from "../packages/host/src/team-verdicts.js";
import type { VerdictHolder, VerdictHost } from "../packages/host/src/team-verdicts.js";
import type { TeamCommand, TeamLineup, TeamMember, TeamModelProfile, TeamReport, TeamRole, TeamRun } from "../packages/host/src/team-types.js";
import type { Provider } from "../packages/host/src/types.js";
import { RUN, PARENT, GOAL, AT, HEAD, BASE, SHORTLIST, MARK, RANK, DIGEST, CLAUDE, SONNET, ASTRA, DEEP, LINEUP, SAME_FAMILY, ONE_ASTRA, clone, uuidOf, criteria, recordOf, receiptOf, reportOf, newWorld, goalPort, sequence, memberOf, runOf, holderOf, FakeHost, finishPass, fixture, noChangeFixture, recordIn, reportEvaluator, settle, drive, countOf, eventTexts, evaluating } from "./fixtures/verdict-runtime.js";
import type { FakeHolder, Fixture, PassEntry, Pending, World } from "./fixtures/verdict-runtime.js";

test("a reviewed revision gets one verdict", () => {
  const plain = fixture({ run: { verdicts: undefined } });
  assert.equal(plain.verdicts.reviewed(plain.holder), false, "an unpinned run is not held");
  assert.equal(plain.holder.verdict, undefined);
  assert.equal(plain.host.saves, 0);
  assert.equal(plain.holder.run.events.length, 0);

  const f = fixture();
  assert.equal(f.verdicts.reviewed(f.holder), true);
  assert.equal(f.holder.verdict?.status, "testing");
  assert.equal(f.world.marks, 1, "the register is asked once");
  assert.deepEqual(f.host.log, [`event:${VERDICT_EVENTS.held}`, "mark"], "held is said before the register saves");
  assert.deepEqual(eventTexts(f.holder), [VERDICT_EVENTS.held]);
  f.verdicts.step(f.holder);
  f.verdicts.reviewed(f.holder);
  assert.equal(f.holder.verdict?.status, "testing", "it waits while the pass is pending");
  assert.equal(f.host.prepared.length, 0);

  finishPass(f.world, RUN, [receiptOf("c1", "pass")]);
  f.verdicts.step(f.holder);
  assert.equal(f.holder.verdict?.status, "queued");
  assert.equal(f.host.prepared.length, 0);
  f.verdicts.step(f.holder);
  assert.equal(f.holder.verdict?.status, "evaluating");
  assert.equal(f.host.prepared.length, 1);
  assert.equal(f.host.prepared[0]!.profile.id, ASTRA.id);
  assert.equal(f.host.prepared[0]!.prompt === evaluatorPrompt("codex", ASTRA), true, "the prompt is the fixed text");
  f.verdicts.step(f.holder);
  f.verdicts.reviewed(f.holder);
  assert.equal(f.host.prepared.length, 1, "prepare runs once");

  const member = f.host.prepared[0]!.member;
  assert.equal(f.verdicts.context(f.holder, member)?.kind, "verdict-context");
  reportEvaluator(f, member, reportOf({ c0: "met", c1: "met" }));
  settle(f.host);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(recordIn(f).version, 2, "the record is one version up");
  const assessment = f.holder.run.assessment!;
  assert.equal(assessment.result, "met");
  assert.equal(assessment.verdictId, f.holder.verdict?.verdictId);
  assert.equal(assessment.counts.met, 2);
  assert.equal(assessment.counts.pendingOwner, 1);
  assert.equal(f.holder.outbox.length, 1);
  assert.equal(f.holder.outbox[0]!.met, 2);
  assert.equal(f.holder.outbox[0]!.projectId, "research");
  assert.equal(f.holder.outbox[0]!.recordVersion, 2);
  assert.equal(f.holder.outbox[0]!.profileId, ASTRA.id);
  const texts = eventTexts(f.holder);
  assert.equal(countOf(texts, VERDICT_EVENTS.held), 1);
  assert.equal(countOf(texts, VERDICT_EVENTS.recorded("met", assessment.counts)), 1);
  assert.equal(texts.length, 2);
  assert.equal(f.verdicts.reviewed(f.holder), false, "a second review is not held");
  assert.equal(f.verdicts.detail(RUN)?.verdictId, assessment.verdictId);
  assert.equal(f.verdicts.detail(RUN)?.criteria.length, 3);
});

test("a no-change cycle is held and released", () => {
  const f = noChangeFixture();
  const parent = holderOf(runOf({ id: PARENT, headCommit: BASE }), undefined);
  f.host.holders.set(PARENT, parent);
  f.world.passes.set(PARENT, { head: BASE, pending: false, receipts: [receiptOf("c1", "pass", PARENT, BASE)] });
  const pm = memberOf(f.holder.run, "project-manager", { status: "reported", report: { kind: "no-change", summary: "Nothing to change.", evidence: [] } as never });
  f.holder.run.members.push(pm);

  assert.equal(f.verdicts.holdNoChange(f.holder, pm), true, "the report is held");
  assert.equal(f.holder.verdict?.status, "testing", "it waits for the parent run's pass, which is done");
  assert.equal(f.holder.verdict?.kind, "no-change");
  assert.equal(f.holder.verdict?.receiptsFrom, PARENT);
  assert.equal(f.holder.verdict?.heldMemberId, pm.memberId);
  assert.equal(f.verdicts.holdNoChange(f.holder, pm), true, "a second report of the revision stays held");
  assert.equal(countOf(eventTexts(f.holder), VERDICT_EVENTS.held), 1, "held is said once");
  assert.equal(f.world.marks, 0, "a no-change verdict asks the register for nothing");

  drive(f, "evaluating");
  assert.equal(f.host.prepared.length, 1);
  assert.equal(f.verdicts.context(f.holder, f.host.prepared[0]!.member)?.verdictKind, "no-change");
  reportEvaluator(f, f.host.prepared[0]!.member, reportOf({ c0: "met" }));
  settle(f.host);
  assert.equal(f.holder.verdict?.status, "releasing");
  assert.equal(f.holder.run.assessment?.kind, "no-change");
  assert.equal(f.holder.run.assessment?.counts.met, 1, "c1 reads the parent run's receipt; c0's file handle is not in a change list the cycle does not have");
  assert.equal(f.host.consumed.length, 0, "the held report is not consumed before the step");

  f.verdicts.step(f.holder);
  assert.deepEqual(f.host.consumed, [pm.memberId], "the held report is consumed again once");
  assert.deepEqual(f.host.holds, [false], "the second hold lets the report through");
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.verdicts.holdNoChange(f.holder, pm), false);
  assert.equal(f.holder.outbox.length, 1);

  const without = noChangeFixture({ goal: { id: GOAL, revision: 1, cycle: 1 } as never });
  const other = memberOf(without.holder.run, "project-manager", { status: "reported" });
  assert.equal(without.verdicts.holdNoChange(without.holder, other), false, "a first cycle is not held");
  assert.equal(without.holder.verdict, undefined);
  assert.equal(without.host.saves, 0);
});

test("a verdict without an evaluator is inconclusive and releases the run", () => {
  type Case = { name: string; reason: "no-independent-evaluator" | "evaluator-unavailable" | "record-unavailable" | "context-too-large";
    options: Parameters<typeof fixture>[0]; limit?: Provider; readable: boolean };
  const many = Array.from({ length: 12_000 }, (_, index) => ({ path: `research/${"d".repeat(90)}/${index}.json`, status: "added", added: 1, removed: 0 }));
  const cases: Case[] = [
    { name: "same family", reason: "no-independent-evaluator", options: { run: { lineup: SAME_FAMILY } }, readable: true },
    { name: "provider limited", reason: "evaluator-unavailable", options: { run: { lineup: ONE_ASTRA } }, limit: "codex", readable: true },
    { name: "unreadable record", reason: "record-unavailable", options: { record: { junk: true } as unknown as ObjectiveRecord }, readable: false },
    { name: "context over 1 MiB", reason: "context-too-large", options: { run: { changes: { headCommit: HEAD, recordedAt: AT, files: many, truncated: false } as never } }, readable: true },
  ];
  for (const item of cases) {
    const f = fixture(item.options);
    if (item.limit) f.host.limitedSet.add(item.limit);
    assert.equal(f.verdicts.reviewed(f.holder), true, item.name);
    finishPass(f.world, RUN, [receiptOf("c1", "pass")]);
    drive(f, "done");
    assert.equal(f.holder.verdict?.status, "done", item.name);
    assert.equal(f.holder.verdict?.reason, item.reason, item.name);
    assert.equal(f.host.prepared.length, 0, `${item.name}: no member started`);
    assert.equal(f.holder.run.assessment?.result, "inconclusive", `${item.name}: no evaluator never gives met`);
    assert.equal(f.holder.run.assessment?.reason, item.reason, item.name);
    const texts = eventTexts(f.holder);
    assert.equal(countOf(texts, VERDICT_EVENTS.skipped[item.reason]), 1, `${item.name}: one skip event`);
    if (item.readable) {
      assert.equal(f.holder.run.assessment?.criteria.length, 3, `${item.name}: host criteria composed`);
      assert.equal(f.holder.run.assessment?.criteria.find(row => row.id === "c1")?.state, "met", `${item.name}: the receipt counts`);
      assert.equal(recordIn(f).version, 2, `${item.name}: the record was written`);
      assert.equal(f.holder.outbox.length, 1, `${item.name}: one row`);
      assert.equal(f.holder.outbox[0]!.reason, item.reason);
    } else {
      assert.equal(f.holder.run.assessment?.criteria.length, 0, `${item.name}: nothing to compose`);
      assert.equal(f.holder.outbox.length, 0, `${item.name}: no row without a record version`);
      assert.equal(f.holder.run.assessment?.counts.met, 0, `${item.name}: the assessment is set and empty`);
    }
    assert.equal(f.verdicts.reviewed(f.holder), false, `${item.name}: the run proceeds`);
  }
});

test("a run at its attempt limit gets no evaluator", () => {
  // The evaluator is one more member of the run. The fixture's run has one member, its author.
  const budget = (maxMembers: number) => ({ id: GOAL, revision: 1, cycle: 2, parentRunId: PARENT, maxMembers }) as never;
  const full = fixture({ goal: true, run: { goal: budget(1) } });
  assert.equal(full.verdicts.reviewed(full.holder), true);
  finishPass(full.world, RUN, [receiptOf("c1", "pass")]);
  drive(full, "done");
  assert.equal(full.host.prepared.length, 0, "no member is added at the limit");
  assert.equal(full.holder.verdict?.status, "done");
  assert.equal(full.holder.verdict?.reason, "evaluator-unavailable");
  assert.equal(full.holder.run.assessment?.result, "inconclusive");
  assert.equal(full.holder.run.assessment?.criteria.find(row => row.id === "c1")?.state, "met", "the receipt still counts");
  assert.equal(full.holder.outbox.length, 1, "one row");
  assert.equal(full.verdicts.reviewed(full.holder), false, "the run proceeds");

  // Room for one more: the evaluator starts. Its replacement would be a third member, so none starts.
  const room = fixture({ goal: true, run: { goal: budget(2) } });
  assert.equal(room.verdicts.reviewed(room.holder), true);
  finishPass(room.world, RUN, [receiptOf("c1", "pass")]);
  drive(room, "evaluating");
  assert.equal(room.host.prepared.length, 1, "the evaluator starts in the last place");
  assert.equal(room.verdicts.failed(room.holder, room.host.prepared[0]!.member), true);
  drive(room, "done");
  assert.equal(room.host.prepared.length, 1, "no replacement is added past the limit");
  assert.equal(room.holder.verdict?.reason, "evaluator-unavailable");
  assert.equal(countOf(eventTexts(room.holder), VERDICT_EVENTS.replaced), 0, "no replacement is announced");
  assert.equal(room.verdicts.reviewed(room.holder), false, "the run proceeds");
});

test("one replacement, then evaluator-unavailable", () => {
  const f = evaluating();
  const first = f.member;
  assert.equal(f.verdicts.failed(f.holder, memberOf(f.holder.run, "reviewer")), false, "another role is not handled");
  const stranger = memberOf(f.holder.run, "evaluator");
  const before = canonicalJson(f.holder.verdict);
  assert.equal(f.verdicts.failed(f.holder, stranger), true, "an evaluator that is not current is handled");
  assert.equal(canonicalJson(f.holder.verdict) === before, true, "and changes nothing");

  assert.equal(f.verdicts.failed(f.holder, first), true);
  assert.equal(f.holder.verdict?.status, "queued");
  assert.equal(f.holder.verdict?.failures, 1);
  assert.deepEqual(f.holder.verdict?.excluded, [ASTRA.id]);
  assert.equal(f.holder.verdict?.evaluatorMemberId, undefined);
  assert.equal(countOf(eventTexts(f.holder), VERDICT_EVENTS.replaced), 0, "no replacement has started yet");
  assert.equal(f.verdicts.failed(f.holder, first), true, "the old evaluator failing again changes nothing");
  assert.equal(f.holder.verdict?.failures, 1);

  drive(f, "evaluating");
  assert.equal(countOf(eventTexts(f.holder), VERDICT_EVENTS.replaced), 1, "the replacement says so once");
  assert.equal(f.host.prepared.length, 2);
  assert.equal(f.host.prepared[1]!.profile.id, DEEP.id, "the excluded profile is not chosen again");
  assert.equal(f.verdicts.failed(f.holder, f.host.prepared[1]!.member), true);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.holder.verdict?.reason, "evaluator-unavailable");
  assert.equal(countOf(eventTexts(f.holder), VERDICT_EVENTS.skipped["evaluator-unavailable"]), 1);
  assert.equal(f.holder.run.assessment?.result, "inconclusive");
  assert.equal(f.verdicts.reviewed(f.holder), false);
});

test("a wrong report kind is a failure, never text", () => {
  const f = evaluating();
  const wrong = { kind: "review", verdict: "approved", summary: `Fine. ${MARK}` } as unknown as TeamReport;
  f.member.report = f.verdicts.screen(f.holder, f.member, wrong);
  assert.equal(f.member.report.kind, "blocked");
  assert.equal(JSON.stringify(f.member.report).includes(MARK), false, "the wrong report's text is withheld");
  f.verdicts.consume(f.holder, f.member);
  assert.equal(f.holder.verdict?.failures, 1);
  assert.equal(f.holder.verdict?.status, "queued");
  assert.equal(f.host.pending.length, 0, "no operation ran for a wrong report");

  drive(f, "evaluating");
  assert.equal(countOf(eventTexts(f.holder), VERDICT_EVENTS.replaced), 1);
  const second = f.host.prepared.at(-1)!.member;
  const full = reportOf({ c0: "met", c1: "met" }, `note ${MARK}`, [`file:${SHORTLIST}`]);
  second.report = f.verdicts.screen(f.holder, second, full);
  const stub = JSON.stringify(second.report);
  assert.equal(stub.includes(MARK), false, "no note in the stub");
  assert.equal(stub.includes(SHORTLIST), false, "no handle in the stub");
  assert.equal(second.report.kind, "verdict");
  assert.equal(f.holder.verdict?.report?.criteria.length, 2, "the full report waits in the state");
  assert.equal(JSON.stringify(f.holder.run).includes(MARK), false, "nothing of it reaches the run");
});

test("a verdict never outlives its revision", () => {
  const f = evaluating();
  reportEvaluator(f, f.member, reportOf({ c0: "met", c1: "met" }));
  assert.equal(f.host.pending.length, 1);
  f.holder.run.revision = 2;
  f.holder.run.headCommit = "2".repeat(40);
  settle(f.host);
  assert.equal(recordIn(f).version, 1, "nothing is written");
  assert.equal(f.holder.verdict, undefined, "the state is discarded");
  assert.equal(f.holder.run.assessment, undefined);
  assert.equal(f.holder.outbox.length, 0);

  const g = evaluating();
  reportEvaluator(g, g.member, reportOf({ c0: "met", c1: "met" }));
  settle(g.host);
  assert.equal(g.holder.run.assessment?.revision, 1);
  g.holder.run.revision = 2;
  g.holder.run.headCommit = "2".repeat(40);
  g.holder.checkHead = g.holder.run.headCommit;
  g.holder.run.review = { verdict: "approved", summary: "ok", revision: 2 };
  g.verdicts.step(g.holder);
  assert.equal(g.holder.verdict, undefined, "a tick discards the old verdict");
  assert.equal(g.holder.run.assessment, undefined, "and its assessment");
  assert.equal(g.verdicts.reviewed(g.holder), true, "the new revision is held again");
  assert.equal(g.holder.verdict?.revision, 2);
  assert.equal(g.holder.verdict?.status, "testing");
  assert.equal(g.holder.outbox.length, 1, "the old row stays");
});

test("record failures never hold the run", () => {
  const failing = evaluating({ goal: true });
  failing.world.store!.failing = true;
  reportEvaluator(failing, failing.member, reportOf({ c0: "met", c1: "met" }));
  settle(failing.host);
  assert.equal(failing.holder.verdict?.written, "write-failed");
  assert.equal(failing.holder.verdict?.status, "done");
  assert.ok(failing.holder.run.assessment);
  assert.equal(countOf(eventTexts(failing.holder), VERDICT_EVENTS.writeFailed), 1);
  assert.equal(failing.holder.outbox.length, 1);
  assert.equal(recordIn(failing).version, 1);

  const full = evaluating({ record: recordOf(RUN, 300) });
  reportEvaluator(full, full.member, reportOf({ c0: "met", c1: "met" }));
  settle(full.host);
  assert.equal(full.holder.verdict?.written, "log-full");
  assert.equal(full.holder.verdict?.status, "done");
  assert.ok(full.holder.run.assessment);
  assert.equal(countOf(eventTexts(full.holder), VERDICT_EVENTS.logFull), 1);
  assert.equal(recordIn(full).version, 1);
});

test("a stopped run judges no evaluator and writes nothing", () => {
  const f = evaluating();
  reportEvaluator(f, f.member, reportOf({ c0: "met", c1: "met" }));
  f.holder.run.status = "paused";
  settle(f.host);
  assert.equal(f.holder.verdict?.status, "evaluating");
  assert.equal(recordIn(f).version, 1);
  assert.equal(f.holder.run.assessment, undefined);
  f.holder.run.status = "reviewing";
  f.verdicts.consume(f.holder, f.member);
  settle(f.host);
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(recordIn(f).version, 2);
});

test("an evaluator that reports but is not read-only is a failure", () => {
  const f = evaluating();
  reportEvaluator(f, f.member, reportOf({ c0: "met", c1: "met" }));
  settle(f.host, false);
  assert.equal(f.holder.verdict?.failures, 1);
  assert.equal(f.holder.verdict?.status, "queued");
  assert.equal(recordIn(f).version, 1);
});

test("the contradiction is said once", () => {
  const f = evaluating();
  finishPass(f.world, RUN, [receiptOf("c1", "fail")]);
  reportEvaluator(f, f.member, reportOf({ c0: "met", c1: "met" }));
  settle(f.host);
  const counts = f.holder.run.assessment!.counts;
  assert.equal(f.holder.run.assessment?.result, "not-met");
  assert.equal(f.holder.run.assessment?.evaluatorResult, "met");
  assert.equal(countOf(eventTexts(f.holder), VERDICT_EVENTS.contradicted(1)), 1);
  assert.equal(countOf(eventTexts(f.holder), VERDICT_EVENTS.recorded("not-met", counts)), 1);
});

test("the context is the evaluator's, and null once the verdict finished without it", () => {
  const f = evaluating();
  assert.equal(f.verdicts.context(f.holder, f.member)?.head, HEAD);
  const stranger = memberOf(f.holder.run, "evaluator");
  assert.equal(f.verdicts.context(f.holder, stranger), null, "only the current evaluator has a context");
  f.holder.objectiveRecord = { junk: true };
  assert.equal(f.verdicts.context(f.holder, f.member), null, "a record that no longer reads stops the evaluator");
  assert.equal(f.member.status, "stopped");
  assert.equal(f.holder.verdict?.status, "done");
  assert.equal(f.holder.verdict?.reason, "record-unavailable");
});
const GONE = "7".repeat(40);
test("an earlier revision's implementer still counts as an author", () => {
  const f = fixture({ run: { revision: 2, lineup: ONE_ASTRA } });
  f.holder.run.tasks.length = 0;
  f.holder.run.members.push(memberOf(f.holder.run, "implementer", { revision: 1, status: "stopped", modelProfile: ASTRA, report: { kind: "result", summary: "Done." } as never }));
  assert.equal(f.verdicts.reviewed(f.holder), true);
  finishPass(f.world, RUN, [receiptOf("c1", "pass")]);
  drive(f, "done");
  assert.equal(f.holder.verdict?.reason, "no-independent-evaluator", "the author's model is not chosen");
  assert.equal(f.host.prepared.length, 0);
});

const judgeable = (): Criterion[] => [{
  id: "c3", origin: "owner", statement: "The method is applied", check: { kind: "judgement", item: "method-applied" },
  producer: "evaluator", threshold: { kind: "pass" }, state: "active",
}];

test("an answer for a criterion that changed after the context is not applied", () => {
  const f = evaluating({ record: recordOf(RUN, 1, judgeable()) });
  const current = f.holder.objectiveRecord as ObjectiveRecord;
  const changed = { ...current, criteria: current.criteria.map(item => item.id === "c3" ? { ...item, statement: "A different method" } : item) };
  f.holder.objectiveRecord = { ...changed, digest: recordDigest(changed as never) };
  reportEvaluator(f, f.member, reportOf({ c0: "met", c3: "met" }));
  settle(f.host);
  const rows = f.verdicts.detail(RUN)!.criteria;
  assert.equal(rows.find(item => item.id === "c3")?.state, "inconclusive");
  assert.equal(rows.find(item => item.id === "c3")?.reason, "not-assessed");
  assert.equal(rows.find(item => item.id === "c0")?.state, "met", "an unchanged criterion keeps its answer");
});

test("the context saves only when what the evaluator reads changed", () => {
  const f = evaluating({ record: recordOf(RUN, 1, judgeable()) });
  const saved = f.host.saves;
  assert.ok(f.verdicts.context(f.holder, f.member));
  assert.ok(f.verdicts.context(f.holder, f.member));
  assert.equal(f.host.saves, saved, "an unchanged record saves nothing");
  const current = f.holder.objectiveRecord as ObjectiveRecord;
  const changed = { ...current, criteria: current.criteria.map(item => item.id === "c3" ? { ...item, statement: "A different method" } : item) };
  const before = f.holder.verdict?.judged?.c3;
  f.holder.objectiveRecord = { ...changed, digest: recordDigest(changed as never) };
  assert.ok(f.verdicts.context(f.holder, f.member));
  assert.equal(f.host.saves, saved + 1, "a changed criterion saves once");
  assert.equal(f.holder.verdict?.judged?.c3 !== before, true, "judged holds the new digest");
});

test("an answer without a recorded context is not applied", () => {
  const f = fixture();
  f.verdicts.reviewed(f.holder);
  finishPass(f.world, RUN, [receiptOf("c1", "pass")]);
  drive(f, "evaluating");
  reportEvaluator(f, f.host.prepared[0]!.member, reportOf({ c0: "met" }));
  settle(f.host);
  const row = f.verdicts.detail(RUN)!.criteria.find(item => item.id === "c0");
  assert.equal(row?.state, "inconclusive");
  assert.equal(row?.reason, "not-assessed");
  const g = evaluating();
  assert.equal(g.verdicts.failed(g.holder, g.member), true);
  drive(g, "evaluating");
  assert.equal(g.holder.verdict?.judged, undefined, "the replacement starts with no judged criteria");
  reportEvaluator(g, g.host.prepared.at(-1)!.member, reportOf({ c0: "met" }));
  settle(g.host);
  const second = g.verdicts.detail(RUN)!.criteria.find(item => item.id === "c0");
  assert.equal(second?.reason, "not-assessed", "a replacement's answer is not checked against the first evaluator's context");
});

test("an invalid no-change report is not held", () => {
  const withTask = noChangeFixture();
  withTask.holder.run.tasks.push({ id: "t2", revision: 1, status: "pending" } as never);
  const pm = memberOf(withTask.holder.run, "project-manager", { status: "reported" });
  assert.equal(withTask.verdicts.holdNoChange(withTask.holder, pm), false);
  assert.equal(withTask.holder.verdict, undefined);
  assert.equal(withTask.holder.run.events.length, 0);
  const moved = noChangeFixture({ headCommit: HEAD });
  assert.equal(moved.verdicts.holdNoChange(moved.holder, memberOf(moved.holder.run, "project-manager", { status: "reported" })), false);
  assert.equal(moved.holder.verdict, undefined);
  assert.equal(moved.holder.run.events.length, 0);
});

test("a pass that never ends holds the verdict no longer than the bound", () => {
  const f = fixture({ run: { lineup: SAME_FAMILY } });
  f.verdicts.reviewed(f.holder);
  f.host.clock = new Date(Date.parse(AT) + VERDICT_TESTING_WAIT_MS - 1000).toISOString();
  f.verdicts.step(f.holder);
  assert.equal(f.holder.verdict?.status, "testing", "inside the bound it waits");
  f.host.clock = new Date(Date.parse(AT) + VERDICT_TESTING_WAIT_MS).toISOString();
  drive(f, "done");
  assert.equal(f.holder.verdict?.status, "done");
  const c1 = f.verdicts.detail(RUN)!.criteria.find(item => item.id === "c1");
  assert.equal(c1?.state, "inconclusive");
  assert.equal(c1?.reason, "no-receipt");
  const unparsable = fixture({ run: { lineup: SAME_FAMILY } });
  unparsable.verdicts.reviewed(unparsable.holder);
  delete unparsable.holder.verdict!.since;
  unparsable.verdicts.step(unparsable.holder);
  assert.equal(unparsable.holder.verdict?.status, "queued", "a missing time counts as expired");
});

test("a no-change verdict waits for the parent's pass", () => {
  const f = noChangeFixture();
  f.host.holders.set(PARENT, holderOf(runOf({ id: PARENT, headCommit: BASE })));
  f.world.passes.set(PARENT, { head: BASE, pending: true });
  const pm = memberOf(f.holder.run, "project-manager", { status: "reported" });
  assert.equal(f.verdicts.holdNoChange(f.holder, pm), true);
  assert.equal(f.holder.verdict?.status, "testing");
  assert.equal(f.world.marks, 0);
  f.verdicts.step(f.holder);
  assert.equal(f.holder.verdict?.status, "testing");
  finishPass(f.world, PARENT, [receiptOf("c1", "pass", PARENT, BASE)]);
  f.verdicts.step(f.holder);
  assert.equal(f.holder.verdict?.status, "queued");
});

test("a check without a result is a failure unless the run is stopped", () => {
  const running = evaluating();
  reportEvaluator(running, running.member, reportOf({ c0: "met" }));
  settle(running.host, undefined);
  assert.equal(running.holder.verdict?.failures, 1);
  assert.equal(running.holder.verdict?.status, "queued");
  const paused = evaluating();
  reportEvaluator(paused, paused.member, reportOf({ c0: "met" }));
  paused.holder.run.status = "paused";
  settle(paused.host, undefined);
  assert.equal(paused.holder.verdict?.failures, 0);
  assert.equal(paused.holder.verdict?.status, "evaluating");
});

test("a skipped replacement says no replacement started", () => {
  const f = evaluating({ run: { lineup: ONE_ASTRA } });
  assert.equal(f.verdicts.failed(f.holder, f.member), true);
  drive(f, "done");
  assert.equal(f.holder.verdict?.reason, "evaluator-unavailable");
  const texts = eventTexts(f.holder);
  assert.equal(countOf(texts, VERDICT_EVENTS.replaced), 0);
  assert.equal(countOf(texts, VERDICT_EVENTS.skipped["evaluator-unavailable"]), 1);
});

test("host facts compose from this run, or from the parent run", () => {
  const facts = (): Criterion[] => [
    { id: "c4", origin: "owner", statement: "Checks pass", check: { kind: "receipt", receipt: "checks-passed" }, producer: "host", threshold: { kind: "pass" }, state: "active" },
    { id: "c5", origin: "owner", statement: "Review approves", check: { kind: "receipt", receipt: "review-approved" }, producer: "host", threshold: { kind: "pass" }, state: "active" },
  ];
  const states = (f: Fixture): string => f.verdicts.detail(RUN)!.criteria.filter(item => item.id === "c4" || item.id === "c5").map(item => item.state).join(",");
  const reviewed = (change: (f: Fixture) => void): Fixture => {
    const f = fixture({ run: { lineup: SAME_FAMILY }, record: recordOf(RUN, 1, facts()) });
    change(f);
    f.verdicts.reviewed(f.holder);
    finishPass(f.world, RUN, []);
    drive(f, "done");
    return f;
  };
  assert.equal(states(reviewed(() => undefined)), "met,met");
  assert.equal(states(reviewed(f => {
    f.holder.run.checks[0]!.status = "failed";
    f.holder.run.review = { verdict: "changes-requested", summary: "no", revision: 1 };
  })), "not-met,not-met");
  assert.equal(states(reviewed(f => { f.holder.checkHead = GONE; })), "inconclusive,met", "checks at another head are not a fact");
  assert.equal(states(reviewed(f => {
    f.holder.run.checks.push({ command: { command: "npm", args: ["ci"] }, phase: "setup", status: "failed", startedAt: AT, output: "", revision: 1, round: 1, headCommit: HEAD } as never);
  })), "not-met,met", "a failed setup row in the final round is a round that did not pass");

  const noChange = (parent: boolean): Fixture => {
    const f = fixture({ goal: true, run: { status: "planning", review: undefined, headCommit: BASE, lineup: SAME_FAMILY }, record: recordOf(RUN, 1, facts()) });
    f.holder.run.tasks.length = 0;
    if (parent) f.host.holders.set(PARENT, holderOf(runOf({ id: PARENT, headCommit: BASE })));
    f.world.passes.set(PARENT, { head: BASE, pending: false, receipts: [] });
    f.verdicts.holdNoChange(f.holder, memberOf(f.holder.run, "project-manager", { status: "reported" }));
    drive(f, "releasing");
    return f;
  };
  assert.equal(states(noChange(true)), "met,met", "the parent run's facts");
  assert.equal(states(noChange(false)), "inconclusive,inconclusive", "a parent that is gone gives no fact");
});

test("a member that is gone while evaluating goes back to queued without a failure", () => {
  const f = evaluating();
  f.holder.run.members = f.holder.run.members.filter(member => member.memberId !== f.member.memberId);
  f.verdicts.step(f.holder);
  assert.equal(f.holder.verdict?.status, "queued");
  assert.equal(f.holder.verdict?.failures, 0);
  assert.equal(f.holder.verdict?.evaluatorMemberId, undefined);
});

test("releasing with the held report gone ends done", () => {
  const f = noChangeFixture({ lineup: SAME_FAMILY });
  const pm = memberOf(f.holder.run, "project-manager", { status: "reported", report: { kind: "no-change", summary: "None.", evidence: [] } as never });
  f.holder.run.members.push(pm);
  f.world.passes.set(PARENT, { head: BASE, pending: false, receipts: [] });
  f.verdicts.holdNoChange(f.holder, pm);
  drive(f, "releasing");
  assert.equal(f.holder.verdict?.status, "releasing");
  f.holder.run.members = f.holder.run.members.filter(member => member.memberId !== pm.memberId);
  f.verdicts.step(f.holder);
  assert.equal(f.holder.verdict?.status, "done");
});

test("a new revision or head drops the state in testing, queued, and releasing", () => {
  for (const stage of ["testing", "queued", "releasing"] as const) {
    const f = stage === "releasing" ? noChangeFixture({ lineup: SAME_FAMILY }) : fixture({ run: { lineup: SAME_FAMILY } });
    if (stage === "releasing") {
      f.world.passes.set(PARENT, { head: BASE, pending: false, receipts: [] });
      f.verdicts.holdNoChange(f.holder, memberOf(f.holder.run, "project-manager", { status: "reported" }));
    } else {
      f.verdicts.reviewed(f.holder);
    }
    if (stage === "queued") {
      finishPass(f.world, RUN, []);
      f.verdicts.step(f.holder);
    }
    if (stage === "releasing") drive(f, "releasing");
    assert.equal(f.holder.verdict?.status, stage, stage);
    f.holder.run.revision = 2;
    f.holder.run.headCommit = GONE;
    f.verdicts.step(f.holder);
    assert.equal(f.holder.verdict, undefined, `${stage}: the state is dropped`);
    assert.equal(f.holder.run.assessment, undefined, `${stage}: and its assessment`);
  }
});

// ---- Seeded sequences with restarts ----
const SEEDS = 100;
const crashes = { afterWrite: 0 };
const seen = { c0Met: 0, c0NotMet: 0, contradicted: 0 };

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

type SimKind = "standalone" | "goal" | "nochange";
type Op = { name: string; a: number; clean: boolean };
const BAG = [
  "hold", "hold", "hold", "hold", "step", "step", "step", "register", "register", "report", "report", "report",
  "settle", "settle", "settle", "fail", "revision", "restart", "restart", "crash", "limit",
] as const;

/** At most 40 steps, drawn before anything runs, so the same seed gives the same sequence with and without restarts. */
function opsOf(seed: number): Op[] {
  const random = mulberry32(seed);
  const count = 12 + Math.floor(random() * 29);
  return Array.from({ length: count }, () => ({ name: BAG[Math.floor(random() * BAG.length)]!, a: random(), clean: random() < 0.85 }));
}

type Sim = { world: World; host: FakeHost; verdicts: TeamVerdicts; kind: SimKind; parent?: FakeHolder };
const holderOfSim = (sim: Sim): FakeHolder => sim.host.holders.get(RUN)!;
const recordOfSim = (sim: Sim): ObjectiveRecord => sim.world.store ? sim.world.store.record : holderOfSim(sim).objectiveRecord as ObjectiveRecord;
const headFor = (revision: number): string => String(revision % 10 === 0 ? 9 : revision % 10).repeat(40);

function addPm(run: TeamRun): TeamMember {
  const pm = memberOf(run, "project-manager", { status: "reported", report: { kind: "no-change", summary: "Nothing to change.", evidence: [] } as never });
  run.members.push(pm);
  return pm;
}

function build(kind: SimKind): Sim {
  const world = newWorld();
  const goal = kind !== "standalone";
  const run = runOf(goal ? { goal: { id: GOAL, revision: 1, cycle: 2, parentRunId: PARENT } as never } : {});
  if (kind === "nochange") {
    run.status = "planning";
    run.tasks.length = 0;
    run.headCommit = BASE;
    addPm(run);
  }
  const record = recordOf(RUN);
  const holder = holderOf(run, goal ? undefined : record);
  if (goal) world.store = { record, failing: false };
  const holders = new Map<string, FakeHolder>([[RUN, holder]]);
  const host = new FakeHost(world, holders);
  const verdicts = new TeamVerdicts(host);
  host.verdicts = verdicts;
  if (goal) verdicts.goals = goalPort(world);
  const sim: Sim = { world, host, verdicts, kind };
  if (kind === "nochange") {
    sim.parent = holderOf(runOf({ id: PARENT }));
    holders.set(PARENT, sim.parent);
    world.passes.set(PARENT, { head: BASE, pending: false, receipts: [receiptOf("c1", "pass", PARENT, BASE)] });
  }
  host.save(holder);
  return sim;
}

/**
 * A restart: a new service over a JSON round trip of the holders as last saved and of the goal's record; the host's recovery then
 * consumes reported evaluators again. This replay is harsher than the real host, which fences an interrupted operation and never
 * replays it (ruling 22), so the guard that looks for the verdict's own record entry is exercised.
 */
function restart(sim: Sim): void {
  const old = sim.host;
  if (sim.world.store) sim.world.store = { record: JSON.parse(JSON.stringify(sim.world.store.record)) as ObjectiveRecord, failing: sim.world.store.failing };
  const holders = new Map<string, FakeHolder>();
  for (const [runId, json] of old.persisted) holders.set(runId, JSON.parse(json) as FakeHolder);
  if (sim.parent) holders.set(PARENT, sim.parent);
  const host = new FakeHost(sim.world, holders);
  for (const provider of old.limitedSet) host.limitedSet.add(provider);
  for (const [runId, json] of old.persisted) host.persisted.set(runId, json);
  const verdicts = new TeamVerdicts(host);
  host.verdicts = verdicts;
  if (sim.world.store) verdicts.goals = goalPort(sim.world);
  sim.host = host;
  sim.verdicts = verdicts;
  const holder = holderOfSim(sim);
  for (const member of holder.run.members) {
    const state = holder.verdict;
    if (member.role === "evaluator" && member.status === "reported" && state?.status === "evaluating" && state.evaluatorMemberId === member.memberId) {
      verdicts.consume(holder, member);
    }
  }
}

function currentEvaluator(sim: Sim): TeamMember | undefined {
  const holder = holderOfSim(sim);
  const id = holder.verdict?.evaluatorMemberId;
  return id === undefined ? undefined : holder.run.members.find(member => member.memberId === id);
}

const STATES: AssessedState[] = ["met", "not-met", "inconclusive"];

function report(sim: Sim, a: number): void {
  const holder = holderOfSim(sim);
  const member = currentEvaluator(sim);
  if (!member || holder.verdict?.status !== "evaluating" || member.report !== undefined) return;
  const wrong = a < 0.15;
  const full: TeamReport = wrong
    ? { kind: "review", verdict: "approved", summary: "A review." } as unknown as TeamReport
    : reportOf({ c0: STATES[Math.floor(a * 3) % 3]!, c1: STATES[Math.floor((a * 9) % 3)]! });
  member.status = "reported";
  member.report = sim.verdicts.screen(holder, member, full);
  sim.host.save(holder);
  sim.verdicts.consume(holder, member);
}

function bump(sim: Sim): void {
  const holder = holderOfSim(sim);
  const run = holder.run;
  run.revision += 1;
  run.headCommit = sim.kind === "nochange" ? BASE : headFor(run.revision);
  holder.checkHead = run.headCommit;
  run.review = { verdict: "approved", summary: "ok", revision: run.revision } as never;
  if (sim.kind === "nochange") addPm(run);
  sim.host.save(holder);
}

function hold(sim: Sim): void {
  const holder = holderOfSim(sim);
  if (sim.kind !== "nochange") {
    sim.verdicts.reviewed(holder);
    return;
  }
  const pm = holder.run.members.filter(member => member.role === "project-manager").at(-1)!;
  sim.verdicts.holdNoChange(holder, pm);
}

function passes(sim: Sim, pass: boolean): void {
  for (const [runId, entry] of sim.world.passes) {
    if (entry.pending) finishPass(sim.world, runId, [receiptOf("c1", pass ? "pass" : "fail", runId, entry.head)]);
  }
}

/** The host builds the evaluator's context at its launch, before it can report: once the verdict is evaluating and nothing was judged yet. */
function contextStep(sim: Sim): void {
  const holder = holderOfSim(sim);
  const member = currentEvaluator(sim);
  if (holder.verdict?.status === "evaluating" && holder.verdict.judged === undefined && member) sim.verdicts.context(holder, member);
}

function apply(sim: Sim, op: Op, withRestarts: boolean): void {
  applyOp(sim, op, withRestarts);
  contextStep(sim);
}

function applyOp(sim: Sim, op: Op, withRestarts: boolean): void {
  const holder = holderOfSim(sim);
  switch (op.name) {
    case "hold": hold(sim); return;
    case "step": sim.verdicts.step(holder); return;
    case "register": passes(sim, op.a < 0.7); return;
    case "report": report(sim, op.a); return;
    case "settle": settle(sim.host, op.clean); return;
    case "fail": {
      const member = currentEvaluator(sim);
      if (!member) return;
      member.status = "stopped";
      sim.verdicts.failed(holder, member);
      sim.host.save(holder);
      return;
    }
    case "revision": bump(sim); return;
    case "limit":
      if (sim.host.limitedSet.has("codex")) sim.host.limitedSet.delete("codex");
      else sim.host.limitedSet.add("codex");
      return;
    case "restart":
      if (withRestarts) restart(sim);
      return;
    case "crash": {
      if (!withRestarts) {
        settle(sim.host, op.clean);
        return;
      }
      const before = recordOfSim(sim).version;
      sim.host.failNextSave = true;
      let crashed = false;
      try {
        settle(sim.host, op.clean);
      } catch {
        crashed = true;
      }
      sim.host.failNextSave = false;
      if (!crashed) return;
      if (recordOfSim(sim).version > before) crashes.afterWrite += 1;
      restart(sim);
      settle(sim.host, op.clean);
      return;
    }
    default:
      throw new Error(`unknown op ${op.name}`);
  }
}

/** Everything lets go, then each held step runs until the verdict is done. */
function drain(sim: Sim, seed: number): void {
  sim.host.limitedSet.clear();
  for (let index = 0; index < 60; index += 1) {
    const holder = holderOfSim(sim);
    if (holder.verdict?.status === "done" && holder.verdict.revision === holder.run.revision) return;
    hold(sim);
    passes(sim, true);
    sim.verdicts.step(holder);
    contextStep(sim);
    // The last evaluator's answer follows the seed, so the plain and the restarted run compare a verdict that holds an answer.
    report(sim, 0.15 + ((seed * 37) % 85) / 100);
    const member = currentEvaluator(sim);
    if (holder.verdict?.status === "evaluating" && member?.report !== undefined && sim.host.pending.length === 0) sim.verdicts.consume(holder, member);
    settle(sim.host, true);
  }
  assert.fail(`seed ${seed}: the verdict did not finish: ${holderOfSim(sim).verdict?.status ?? "no state"}`);
}

function checkInvariants(sim: Sim, seed: number): void {
  const holder = holderOfSim(sim);
  const record = recordOfSim(sim);
  const ids = holder.outbox.map(row => row.verdictId);
  assert.equal(new Set(ids).size === ids.length, true, `seed ${seed}: a row event repeated`);
  const entries = record.log.filter(entry => entry.op === "verdict.recorded");
  const handles = entries.map(entry => entry.handle);
  assert.equal(new Set(handles).size === handles.length, true, `seed ${seed}: a verdict.recorded entry repeated`);
  assert.equal(record.version, 1 + entries.length, `seed ${seed}: one version per verdict`);
  for (const row of holder.outbox) {
    const entry = entries.find(item => item.handle === `verdict:${row.verdictId}`);
    assert.equal(entry !== undefined, true, `seed ${seed}: a row without a record entry`);
    assert.equal(entry?.version, row.recordVersion, `seed ${seed}: the row names the entry's version`);
  }
  const recorded = holder.run.events.filter(event => event.text.startsWith("Agent assessment, provisional")).length;
  assert.equal(recorded, ids.length, `seed ${seed}: one recorded event per row`);
  assert.equal(ids.length <= sim.world.uuids, true, `seed ${seed}: no more rows than verdicts`);
  assert.equal(holder.verdict?.status, "done", `seed ${seed}: the state ends done`);
  assert.equal(holder.run.assessment?.revision, holder.run.revision, `seed ${seed}: the assessment is the current revision's`);
  assert.equal(holder.run.assessment?.verdictId, holder.verdict?.verdictId, `seed ${seed}: the assessment is the state's`);
}

function summary(sim: Sim): Record<string, string> {
  const holder = holderOfSim(sim);
  return {
    record: canonicalJson(recordOfSim(sim)),
    assessment: canonicalJson(holder.run.assessment ?? null),
    outbox: canonicalJson(holder.outbox),
    events: canonicalJson(holder.run.events),
    counts: `${sim.world.uuids}/${sim.world.marks}`,
  };
}

function simulate(seed: number, withRestarts: boolean): Sim {
  const kind: SimKind = (["standalone", "goal", "nochange"] as const)[seed % 3]!;
  const sim = build(kind);
  const ops = opsOf(seed);
  ops.forEach((op, index) => {
    try {
      apply(sim, op, withRestarts);
    } catch (error) {
      throw new Error(`seed ${seed}, step ${index} (${op.name}, ${withRestarts ? "restarts" : "plain"}): ${(error as Error).message}`);
    }
  });
  drain(sim, seed);
  checkInvariants(sim, seed);
  return sim;
}

test("seeded verdicts with restarts compose each verdict once", () => {
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const plainSim = simulate(seed, false);
    for (const entry of recordOfSim(plainSim).log) {
      if (entry.op === "evaluator-contradicted-receipt") seen.contradicted += 1;
      const latest = entry.op === "verdict.recorded" && entry.after && "inline" in entry.after
        ? (entry.after.inline as { latest?: Record<string, { state: string }> }).latest
        : undefined;
      if (latest?.c0?.state === "met") seen.c0Met += 1;
      if (latest?.c0?.state === "not-met") seen.c0NotMet += 1;
    }
    const plain = summary(plainSim);
    const restarted = summary(simulate(seed, true));
    for (const key of Object.keys(plain)) {
      assert.equal(plain[key] === restarted[key], true, `seed ${seed}: ${key} differs with restarts`);
    }
  }
  assert.equal(seen.c0Met > 0, true, "no verdict recorded c0 met, so the evaluator's answers never reached the record");
  assert.equal(seen.c0NotMet > 0, true, "no verdict recorded c0 not-met");
  assert.equal(seen.contradicted > 0, true, "the contradiction path never ran");
  assert.equal(crashes.afterWrite > 0, true, "no seed crashed inside a finish after the record write, so the replay guard was never exercised");
});
