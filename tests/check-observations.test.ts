import test from "node:test";
import assert from "node:assert/strict";
import { CheckMetricScanner } from "../packages/host/src/check-metrics.js";
import { metricObserver, recordObservations, reviewedObservationsOf, type CheckObservation, type ObservationHolder } from "../packages/host/src/check-observations.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import type { TeamCheck, TeamCommand, TeamRun } from "../packages/host/src/team-types.js";

/*
 * What a run keeps of the numbers its checks print, and the one read the goal makes of them
 * (packages/host/src/check-observations.ts). The real check runner is covered in tests/goal-metrics-host.test.ts.
 */

const HEAD = "a".repeat(40), OTHER = "b".repeat(40), AT = "2026-11-23T08:00:00.000Z";
const lint: TeamCommand = { command: "npm", args: ["run", "lint"] };
const unit: TeamCommand = { command: "npm", args: ["test"] };

type Run = Pick<TeamRun, "revision" | "headCommit" | "review" | "checks">;
function holderOf(run: Partial<Run> = {}, checkHead: string | undefined = HEAD): ObservationHolder {
  const value: Run = { revision: 1, headCommit: HEAD, review: { verdict: "approved", summary: "Approved.", revision: 1 }, checks: [], ...run };
  return { run: value as TeamRun, ...(checkHead === undefined ? {} : { checkHead }) };
}
function row(command: TeamCommand, status: TeamCheck["status"], fields: Partial<TeamCheck> = {}): TeamCheck {
  return { command, status, startedAt: AT, finishedAt: AT, exitCode: status === "passed" ? 0 : 1, output: "", revision: 1, round: 0, headCommit: HEAD, ...fields };
}
/** Appends the row as the check loop does, then finishes it with this stdout through the observer teams.ts uses. */
function finish(holder: ObservationHolder, check: TeamCheck, stdout: string, stderr = "") {
  holder.run.checks.push(check);
  const observer = metricObserver();
  observer.push(Buffer.from(stdout), "stdout");
  if (stderr) observer.push(Buffer.from(stderr), "stderr");
  observer.record(holder, check);
}
const scanOf = (stdout: string) => { const scanner = new CheckMetricScanner(); scanner.push(Buffer.from(stdout), "stdout"); return scanner.finish(); };
const pairs = (items: readonly CheckObservation[] | undefined) => (items ?? []).map(item => [item.command === commandDigest(lint) ? "lint" : "unit", item.name, item.state, item.value ?? null]);

test("a passed check keeps its numbers with their identity; stderr lines are not read", () => {
  const holder = holderOf(), check = row(lint, "passed", { round: 2 });
  finish(holder, check, "warming up\ninfinite-metric bundle.kb 412.5\ninfinite-metric flaky 1\ninfinite-metric flaky 2\ninfinite-metric bad x\n",
    "infinite-metric from_stderr 9\n");
  assert.deepEqual(holder.checkObservations, [
    { command: commandDigest(lint), name: "bundle.kb", revision: 1, round: 2, head: HEAD, at: AT, state: "value", value: 412.5 },
    { command: commandDigest(lint), name: "flaky", revision: 1, round: 2, head: HEAD, at: AT, state: "ambiguous" },
    { command: commandDigest(lint), name: "bad", revision: 1, round: 2, head: HEAD, at: AT, state: "invalid" },
  ]);
  assert.equal("value" in holder.checkObservations![1]!, false, "an ambiguous number stores no value key");
});

test("a failed, interrupted or setup check keeps nothing, and leaves what the holder kept", () => {
  for (const [status, fields] of [["failed", {}], ["interrupted", {}], ["passed", { phase: "setup" as const }]] as const) {
    const holder = holderOf();
    finish(holder, row(lint, status, fields), "infinite-metric speed 3\n");
    assert.equal("checkObservations" in holder, false, `${status} ${JSON.stringify(fields)} kept numbers`);
    finish(holder, row(unit, "passed"), "infinite-metric speed 4\n");
    finish(holder, row(lint, status, fields), "infinite-metric speed 5\n");
    assert.deepEqual(pairs(holder.checkObservations), [["unit", "speed", "value", 4]]);
  }
});

test("a check without a head or a finish time keeps nothing", () => {
  const holder = holderOf(), check = row(lint, "passed", { headCommit: undefined });
  finish(holder, check, "infinite-metric speed 3\n");
  const late = row(unit, "passed", { finishedAt: undefined });
  finish(holder, late, "infinite-metric speed 3\n");
  assert.equal("checkObservations" in holder, false);
});

test("the first occurrence of a command at a (revision, round, head) decides, as for its receipt", () => {
  const holder = holderOf();
  finish(holder, row(lint, "passed"), "infinite-metric speed 1\n");
  finish(holder, row(lint, "passed"), "infinite-metric speed 2\ninfinite-metric extra 3\n");
  assert.deepEqual(pairs(holder.checkObservations), [["lint", "speed", "value", 1]], "a later occurrence of the same command adds nothing");

  const failedFirst = holderOf();
  finish(failedFirst, row(lint, "failed"), "infinite-metric speed 1\n");
  finish(failedFirst, row(lint, "passed"), "infinite-metric speed 2\n");
  assert.equal("checkObservations" in failedFirst, false, "a failed first occurrence decides: no numbers for that command");

  const setupFirst = holderOf();
  finish(setupFirst, row(lint, "passed", { phase: "setup" }), "infinite-metric speed 1\n");
  finish(setupFirst, row(lint, "passed"), "infinite-metric speed 2\n");
  assert.deepEqual(pairs(setupFirst.checkObservations), [["lint", "speed", "value", 2]], "a setup row is not an occurrence");

  const otherHead = holderOf();
  finish(otherHead, row(lint, "failed", { headCommit: OTHER }), "");
  finish(otherHead, row(lint, "passed"), "infinite-metric speed 2\n");
  assert.deepEqual(pairs(otherHead.checkObservations), [["lint", "speed", "value", 2]], "a row at another head is another occurrence");
});

test("a row of a newer (revision, round, head) replaces the kept set; an older one changes nothing", () => {
  const holder = holderOf({ revision: 2 });
  finish(holder, row(lint, "passed", { revision: 2, round: 1 }), "infinite-metric speed 1\n");
  finish(holder, row(unit, "passed", { revision: 2, round: 1 }), "infinite-metric size 2\n");
  assert.deepEqual(pairs(holder.checkObservations), [["lint", "speed", "value", 1], ["unit", "size", "value", 2]]);

  finish(holder, row(lint, "passed", { revision: 2, round: 2 }), "infinite-metric speed 7\n");
  assert.deepEqual(pairs(holder.checkObservations), [["lint", "speed", "value", 7]], "a later round replaces the set");

  finish(holder, row(lint, "passed", { revision: 2, round: 2, headCommit: OTHER }), "infinite-metric speed 8\n");
  assert.deepEqual(pairs(holder.checkObservations), [["lint", "speed", "value", 8]], "the same round at another head replaces the set");

  for (const stale of [{ revision: 2, round: 1 }, { revision: 1, round: 5 }]) {
    const check = row(unit, "passed", stale);
    holder.run.checks.push(check);
    recordObservations(holder, check, scanOf("infinite-metric size 9\n"));
    assert.deepEqual(pairs(holder.checkObservations), [["lint", "speed", "value", 8]], `${JSON.stringify(stale)} changed the set`);
  }

  finish(holder, row(lint, "passed", { revision: 3, round: 0 }), "no numbers\n");
  assert.equal("checkObservations" in holder, false, "a newer passed row without numbers leaves no field");
});

test("a scanner that throws voids that check's numbers and never throws into the check loop", () => {
  const push = CheckMetricScanner.prototype.push;
  const finishScan = CheckMetricScanner.prototype.finish;
  try {
    CheckMetricScanner.prototype.push = () => { throw new Error("scanner failed"); };
    const holder = holderOf();
    assert.doesNotThrow(() => finish(holder, row(lint, "passed"), "infinite-metric speed 1\n"));
    assert.equal("checkObservations" in holder, false);
    CheckMetricScanner.prototype.push = push;

    CheckMetricScanner.prototype.finish = () => { throw new Error("scanner failed"); };
    assert.doesNotThrow(() => finish(holder, row(unit, "passed"), "infinite-metric speed 1\n"));
    assert.equal("checkObservations" in holder, false);
  } finally {
    CheckMetricScanner.prototype.push = push;
    CheckMetricScanner.prototype.finish = finishScan;
  }
});

test("the goal's read answers only at a reviewed head, with the final round of that revision at that head", () => {
  const reviewed = () => {
    const holder = holderOf({ revision: 2, review: { verdict: "approved", summary: "Approved.", revision: 2 } });
    finish(holder, row(lint, "passed", { revision: 2, round: 3 }), "infinite-metric speed 1\n");
    return holder;
  };
  const answer = reviewedObservationsOf(reviewed());
  assert.deepEqual(pairs(answer), [["lint", "speed", "value", 1]]);

  const copy = reviewed(), read = reviewedObservationsOf(copy)!;
  read[0]!.name = "changed";
  assert.equal(copy.checkObservations![0]!.name, "speed", "the read is a copy");

  assert.equal(reviewedObservationsOf(undefined), undefined, "an unknown run");
  const wrongCheckHead = reviewed(); wrongCheckHead.checkHead = OTHER;
  assert.equal(reviewedObservationsOf(wrongCheckHead), undefined, "the checks passed at another head");
  const noCheckHead = reviewed(); delete noCheckHead.checkHead;
  assert.equal(reviewedObservationsOf(noCheckHead), undefined, "no head passed its checks");
  const oldReview = reviewed(); oldReview.run.review = { verdict: "approved", summary: "Approved.", revision: 1 };
  assert.equal(reviewedObservationsOf(oldReview), undefined, "the review approved an earlier revision");
  const changes = reviewed(); changes.run.review = { verdict: "changes-requested", summary: "Fix it.", revision: 2 };
  assert.equal(reviewedObservationsOf(changes), undefined, "the review asked for changes");
  const noReview = reviewed(); delete noReview.run.review;
  assert.equal(reviewedObservationsOf(noReview), undefined, "no review");

  const olderRound = reviewed();
  olderRound.run.checks.push(row(lint, "failed", { revision: 2, round: 4 }));
  assert.deepEqual(reviewedObservationsOf(olderRound), [], "numbers from an earlier round than the revision's final one");

  const otherHead = reviewed();
  otherHead.run.headCommit = OTHER; otherHead.checkHead = OTHER;
  assert.deepEqual(reviewedObservationsOf(otherHead), [], "numbers from another head than the run's");

  const noChecks = holderOf({ revision: 3, review: { verdict: "approved", summary: "Approved.", revision: 3 } });
  noChecks.run.checks.push(row(lint, "passed", { revision: 2 }));
  noChecks.checkObservations = [{ command: commandDigest(lint), name: "speed", revision: 2, round: 0, head: HEAD, at: AT, state: "value", value: 1 }];
  assert.deepEqual(reviewedObservationsOf(noChecks), [], "a revision without checks has no numbers");
});
