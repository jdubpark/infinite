import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationModule } from "../packages/host/src/configuration-store.js";
import type { EvidenceIndexClass } from "../packages/host/src/evidence/crypto.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { backfillRun, backfillTick, outcomeBackfill } from "../packages/host/src/outcome-backfill.js";
import { type OutcomeRow, type RunSummaryRow, outcomeModule, readOutcome, readSummary, writeOutcome, writeSummary } from "../packages/host/src/outcome-store.js";
import { runEventKey } from "../packages/host/src/run-events.js";
import type { TeamContinuation, TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";

const AT = "2026-11-13T00:00:00.000Z";
const PATH_MARKER = "secret-path";

const index = (cls: EvidenceIndexClass, value: string) => `${cls}:${value}`;
const context = { epoch: () => 1, index };

function member(memberId: string, taskId: string | undefined, extra: Partial<TeamMember> = {}): TeamMember {
  return {
    runId: "run-1", memberId, sessionId: `session-${memberId}`, revision: 1, role: "implementer", taskId,
    title: memberId, status: "reported", cwd: "/work/a", baseCommit: "base", prompt: "prompt", cursor: 0,
    stopRequestId: "stop", startedAt: AT, reportedAt: AT, ...extra,
  } as TeamMember;
}

function task(id: string, memberId: string | undefined, extra: Partial<TeamTask> = {}): TeamTask {
  return {
    id, title: id, instructions: "do the work", paths: [`packages/host/src/${id}.ts`], dependsOn: [], revision: 1,
    status: "integrated", memberId, commit: "a".repeat(40), ...extra,
  } as TeamTask;
}

function run(extra: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "run-1", projectId: "project-a", provider: "claude", title: "Run", objective: "Objective", parallelism: 2,
    revision: 1, status: "ready-for-review", createdAt: AT, updatedAt: AT, workspace: "/work", branch: "branch",
    baseCommit: "base", tasks: [], members: [], decisions: [], checks: [], steering: [], events: [], round: 0,
    ...extra,
  } as TeamRun;
}

/** Two integrated implementers under an approved review of the same snapshot. */
function approvedRun(id: string): TeamRun {
  return run({
    id,
    tasks: [task("a", "m1"), task("b", "m2")],
    members: [member("m1", "a"), member("m2", "b")],
    review: { verdict: "approved", summary: "Looks right.", revision: 1 },
  });
}

test("an approved run backfills accepted rows", () => {
  const result = backfillRun(approvedRun("run-1"), context);
  assert.equal(result.rows.length, 2);
  assert.equal(result.skipped, 0);
  for (const row of result.rows) {
    assert.deepEqual([row.integrated, row.accepted, row.firstPass, row.held], [1, 1, 1, null]);
    assert.deepEqual(row.flags, ["backfilled"]);
    assert.equal(row.attemptIndex, 1);
    assert.equal(row.source, "production");
    assert.equal(row.disposition, "integrated");
  }
  assert.deepEqual(result.summary.flags, ["backfilled"]);
  assert.equal(result.summary.source, "production");
});

test("a correction round leaves firstPass unknown", () => {
  const source = approvedRun("run-1");
  source.tasks.forEach(item => { item.reviewRounds = 1; });
  const result = backfillRun(source, context);
  assert.equal(result.rows.length, 2);
  for (const row of result.rows) {
    assert.deepEqual([row.integrated, row.accepted, row.firstPass, row.held], [1, 1, null, null]);
    assert.deepEqual(row.payload.rounds, { run: 1, attributed: 0, unknown: 1 });
  }
});

test("a steered run keeps its earlier attempt", () => {
  const continuation: TeamContinuation = {
    revision: 1, requestId: "00000000-0000-4000-8000-000000000001", at: AT, reason: "steer", headCommit: "b".repeat(40),
    tasks: [task("a", "m1")], review: { verdict: "approved", summary: "Approved before the steer.", revision: 1 },
  };
  const source = run({
    revision: 2,
    tasks: [task("b", "m2", { revision: 2 })],
    continuations: [continuation],
    members: [member("m1", "a", { revision: 1 }), member("m2", "b", { revision: 2 })],
  });
  const result = backfillRun(source, context);
  const first = result.rows.find(row => row.memberId === "m1");
  assert.ok(first, "the earlier attempt keeps its row");
  assert.equal(first.disposition, "integrated");
  assert.equal(first.accepted, 1);
  assert.equal(first.revision, 1);
});

test("replacements number their attempts", () => {
  const source = run({
    tasks: [task("a", "m2")],
    members: [
      member("m1", "a", { stalledAt: AT, status: "stopped", reportedAt: undefined }),
      member("m2", "a", { startedAt: "2026-11-13T00:05:00.000Z" }),
    ],
  });
  const result = backfillRun(source, context);
  const first = result.rows.find(row => row.memberId === "m1");
  const second = result.rows.find(row => row.memberId === "m2");
  assert.ok(first && second);
  assert.equal(first.disposition, "stalled");
  assert.equal(first.attemptIndex, 1);
  assert.equal(first.inherited, false);
  assert.equal(second.disposition, "integrated");
  assert.equal(second.attemptIndex, 2);
  assert.equal(second.inherited, true);
});

test("unknown endings are skipped and counted", () => {
  const source = run({
    tasks: [task("a", undefined, { status: "pending", commit: undefined })],
    members: [member("m1", "a", { status: "stopped", stoppedReason: "stopped by owner", reportedAt: undefined })],
  });
  const result = backfillRun(source, context);
  assert.deepEqual(result.rows, []);
  assert.equal(result.skipped, 1);
});

test("the tick never overwrites and stops when done", () => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-backfill-"));
  try {
    const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(dir, "state")), vaultKey: randomBytes(32) });
    store.register(outcomeModule());
    store.register(configurationModule());
    const options = { mapOf: () => undefined, limit: 1, now: () => AT };

    // R1 has a run.created event, so it is not a backfill candidate.
    store.write(tx => store.appendEvent(tx, {
      key: runEventKey("run.created", "run-1"), runId: "run-1", revision: 1, at: AT, kind: "run.created", data: { v: 1 },
    }));

    // R2 has an event-derived row for m1 that must survive the tick unchanged. It has no run.created event.
    const seeded: OutcomeRow = {
      ...backfillRun(approvedRun("run-2"), context).rows[0],
      disposition: "host-stop", exclusion: "host", integrated: null, accepted: null, flags: [],
    };
    store.write(tx => writeOutcome(tx, seeded));
    const before = store.read(db => readOutcome(db, "run-2:m1"));
    assert.ok(before, "the event-derived row is stored");

    const runs = () => [run({ id: "run-1", tasks: [task("a", "m1")], members: [member("m1", "a")] }), approvedRun("run-2"), approvedRun("run-3")];
    assert.deepEqual(backfillTick(store, runs, options), { written: 1, remaining: 1 });
    assert.deepEqual(backfillTick(store, runs, options), { written: 1, remaining: 0 });
    assert.deepEqual(backfillTick(store, runs, options), { written: 0, remaining: 0 });

    const after = store.read(db => readOutcome(db, "run-2:m1"));
    assert.deepEqual(after, before);
    assert.equal(store.read(db => readOutcome(db, "run-1:m1")), undefined);
    assert.equal(store.read(db => readSummary(db, "run-1")), undefined);
    assert.ok(store.read(db => readOutcome(db, "run-3:m1")));
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no backfilled row holds a path", () => {
  const dir = mkdtempSync(join(tmpdir(), "infinite-backfill-"));
  try {
    const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(dir, "state")), vaultKey: randomBytes(32) });
    store.register(outcomeModule());
    store.register(configurationModule());
    const source = run({
      id: "run-p",
      tasks: [task("a", "m1", { paths: [`packages/host/src/${PATH_MARKER}.ts`] })],
      members: [member("m1", "a", { cwd: `/work/checkout-${PATH_MARKER}` })],
      review: { verdict: "approved", summary: "Approved.", revision: 1 },
    });
    assert.deepEqual(backfillTick(store, () => [source], { mapOf: () => undefined, now: () => AT }), { written: 1, remaining: 0 });
    const plain = store.read(db => JSON.stringify([db.all("SELECT * FROM outcomes"), db.all("SELECT * FROM run_summaries")]));
    const opened = store.read(db => JSON.stringify([readOutcome(db, "run-p:m1"), readSummary(db, "run-p")]));
    assert.ok(opened.includes("integrated"), "the row was written");
    assert.equal(plain.includes(PATH_MARKER), false, "no plain column holds a path");
    assert.equal(opened.includes(PATH_MARKER), false, "no opened payload holds a path");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function openStore(withConfigurations = true): { store: EvidenceStore; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "infinite-backfill-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(dir, "state")), vaultKey: randomBytes(32) });
  store.register(outcomeModule());
  if (withConfigurations) store.register(configurationModule());
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("unknown rounds are stored as links", () => {
  const { store, close } = openStore();
  try {
    const rounds = approvedRun("run-rounds");
    rounds.tasks.forEach(item => { item.reviewRounds = 2; });
    const plain = approvedRun("run-plain");
    assert.deepEqual(backfillTick(store, () => [rounds, plain], { mapOf: () => undefined, now: () => AT }), { written: 2, remaining: 0 });

    const roundRows = store.read(db => db.all<{ revision: number; round: number; state: string; cause: string; started_at: string; run_deleted_at: string | null }>(
      "SELECT revision, round, state, cause, started_at, run_deleted_at FROM outcome_rounds WHERE run_id=? ORDER BY round", "run-rounds"));
    assert.deepEqual(roundRows.map(row => [row.revision, row.round, row.state, row.cause, row.started_at, row.run_deleted_at]),
      [[0, 1, "unknown", "unknown", AT, null], [0, 2, "unknown", "unknown", AT, null]]);

    const links = store.read(db => db.all<{ outcome_id: string; state: string; revision: number }>(
      "SELECT outcome_id, state, revision FROM outcome_round_links WHERE run_id=? ORDER BY outcome_id, round", "run-rounds"));
    assert.equal(links.length, 4, "two inserted rows, two links each");
    assert.ok(links.every(link => link.state === "unknown" && link.revision === 0));
    assert.deepEqual([...new Set(links.map(link => link.outcome_id))].sort(), ["run-rounds:m1", "run-rounds:m2"]);

    assert.equal(store.read(db => db.get("SELECT count(*) AS n FROM outcome_rounds WHERE run_id=?", "run-plain"))?.n, 0);
    assert.equal(store.read(db => db.get("SELECT count(*) AS n FROM outcome_round_links WHERE run_id=?", "run-plain"))?.n, 0);
  } finally {
    close();
  }
});

test("an unreadable record is marked and never blocks the rest", () => {
  const { store, close } = openStore();
  try {
    const bad = run({ id: "run-bad", members: "not-an-array" as unknown as TeamMember[] });
    const good = approvedRun("run-good");
    const options = { mapOf: () => undefined, limit: 1, now: () => AT };
    const runs = () => [bad, good];
    assert.deepEqual(backfillTick(store, runs, options), { written: 1, remaining: 1 });
    const marked = store.read(db => db.get<{ rows: number; skipped: number }>("SELECT rows, skipped FROM backfill_runs WHERE run_id=?", "run-bad"));
    assert.deepEqual({ ...marked }, { rows: 0, skipped: -1 });
    assert.equal(store.read(db => readSummary(db, "run-bad")), undefined);
    assert.equal(store.read(db => readOutcome(db, "run-bad:m1")), undefined);
    assert.deepEqual(backfillTick(store, runs, options), { written: 1, remaining: 0 });
    assert.deepEqual(backfillTick(store, runs, options), { written: 0, remaining: 0 });
    assert.ok(store.read(db => readOutcome(db, "run-good:m1")));
  } finally {
    close();
  }
});

test("a record with a missing field is marked, not left pending", () => {
  const { store, close } = openStore();
  try {
    // A legacy record: the types require these fields, and an old record can lack them.
    const noSession = approvedRun("run-no-session");
    delete (noSession.members[0] as Partial<TeamMember>).sessionId;
    const noCreation = approvedRun("run-no-creation");
    delete (noCreation as Partial<TeamRun>).createdAt;
    noCreation.members.forEach(item => { delete (item as Partial<TeamMember>).startedAt; });
    // The rating has no time, so the row's payload is not canonical JSON and cannot be sealed.
    const noRatingTime = approvedRun("run-no-rating-time");
    noRatingTime.tasks[0]!.ownerRating = { score: 4 } as TeamTask["ownerRating"];
    const good = approvedRun("run-good");
    const options = { mapOf: () => undefined, limit: 1, now: () => AT };
    const runs = () => [noSession, noCreation, noRatingTime, good];
    assert.deepEqual(backfillTick(store, runs, options), { written: 1, remaining: 3 });
    assert.deepEqual(backfillTick(store, runs, options), { written: 1, remaining: 2 });
    assert.deepEqual(backfillTick(store, runs, options), { written: 1, remaining: 1 });
    for (const id of ["run-no-session", "run-no-creation", "run-no-rating-time"]) {
      const marked = store.read(db => db.get<{ rows: number; skipped: number }>("SELECT rows, skipped FROM backfill_runs WHERE run_id=?", id));
      assert.deepEqual({ ...marked }, { rows: 0, skipped: -1 }, id);
      assert.equal(store.read(db => readSummary(db, id)), undefined, id);
      assert.equal(store.read(db => readOutcome(db, `${id}:m1`)), undefined, id);
    }
    assert.deepEqual(backfillTick(store, runs, options), { written: 1, remaining: 0 });
    assert.ok(store.read(db => readOutcome(db, "run-good:m1")), "a record that cannot be written never keeps a later run out");
  } finally {
    close();
  }
});

test("a backfilled failure has the levels of any counted failure", () => {
  const source = run({
    tasks: [
      task("a", "m-done"),
      task("b", undefined, { status: "pending", commit: undefined,
        escalation: { toProfileId: "strong", reason: "needs a stronger model", memberId: "m-escalated", at: AT } }),
      task("c", undefined, { status: "pending", commit: undefined,
        limitSwitches: [{ toProfileId: "other", reason: "provider limit", memberId: "m-limit", at: AT }] }),
      task("d", undefined, { status: "pending", commit: undefined }),
      task("e", undefined, { status: "pending", commit: undefined }),
    ],
    members: [
      member("m-stalled", "a", { stalledAt: AT, status: "stopped", reportedAt: undefined }),
      member("m-done", "a"),
      member("m-escalated", "b"),
      member("m-limit", "c"),
      member("m-question", "d", { report: { kind: "question", question: "Which way?", options: [] } as TeamMember["report"] }),
      member("m-blocked", "e", { report: { kind: "blocked", summary: "The dependency is missing." } as TeamMember["report"] }),
    ],
    review: { verdict: "changes-requested", summary: "Not yet.", revision: 1 },
  });
  const result = backfillRun(source, context);
  const levelsOf = (memberId: string) => {
    const row = result.rows.find(item => item.memberId === memberId);
    assert.ok(row, memberId);
    assert.deepEqual(row.flags, ["backfilled"], memberId);
    return [row.disposition, row.exclusion, row.integrated, row.accepted, row.firstPass, row.held];
  };
  // Spec part 4: a counted failure is no on every level. That follows from the disposition, not from a review.
  assert.deepEqual(levelsOf("m-stalled"), ["stalled", null, 0, 0, 0, 0]);
  assert.deepEqual(levelsOf("m-escalated"), ["escalated", null, 0, 0, 0, 0]);
  assert.deepEqual(levelsOf("m-question"), ["question", null, 0, 0, 0, 0]);
  assert.deepEqual(levelsOf("m-blocked"), ["blocked", null, 0, 0, 0, 0]);
  // An excluded row has no levels.
  assert.deepEqual(levelsOf("m-limit"), ["limit", "limit", null, null, null, null]);
  // An integrated row never claims a refusal: the record cannot show which review covered it.
  assert.deepEqual(levelsOf("m-done"), ["integrated", null, 1, null, null, null]);
});

test("a changes-requested review is not kept", () => {
  const source = approvedRun("run-1");
  source.review = { verdict: "changes-requested", summary: "Not yet.", revision: 1 };
  const result = backfillRun(source, context);
  assert.equal(result.rows.length, 2);
  for (const row of result.rows) {
    assert.equal(row.accepted, null);
    assert.equal(Object.hasOwn(row.payload, "lastReview"), false, "a later settle would freeze it as not accepted");
  }
});

test("a summary that an event made first takes the record's facts", () => {
  const { store, close } = openStore();
  try {
    const eventMade = (runId: string, projectId: string): RunSummaryRow => ({
      runId, source: "production", projectRef: "", revision: 1, status: "ready-for-review", blockCode: null,
      flags: ["gap"], createdAt: null, settledAt: "2026-11-12T08:00:00.000Z", approvedAt: null, runDeletedAt: null,
      payload: { projectId, attempts: {}, rounds: { total: 0, attributed: 0, unattributed: 0, unknown: 0 } },
    });
    store.write(tx => {
      writeSummary(tx, eventMade("run-early", "unknown"));
      writeSummary(tx, eventMade("run-lost", "unknown"));
      writeSummary(tx, eventMade("run-known", "project-z"));
    });
    // This run really lost events: the ledger says so, and its flag stays.
    const stored = new EventOutbox(store).flush([{
      key: runEventKey("ledger.gap", "run-lost", ["first"]), runId: "run-lost", revision: 1, at: AT, kind: "ledger.gap", data: { v: 1, dropped: 3 },
    }]);
    assert.equal(stored.stored, true);
    const options = { mapOf: () => undefined, now: () => AT };
    const runs = () => [approvedRun("run-early"), approvedRun("run-lost"), approvedRun("run-known")];
    assert.deepEqual(backfillTick(store, runs, options), { written: 3, remaining: 0 });

    const early = store.read(db => readSummary(db, "run-early"));
    assert.equal(early?.payload.projectId, "project-a");
    assert.equal(early?.createdAt, AT);
    // The flag stood for the missing `run.created` facts. The record supplied them, and no event was lost.
    assert.deepEqual(early?.flags, ["backfilled"]);
    assert.deepEqual(store.read(db => readSummary(db, "run-lost"))?.flags, ["backfilled", "gap"]);
    assert.equal(early?.status, "ready-for-review");
    assert.equal(early?.settledAt, "2026-11-12T08:00:00.000Z");
    assert.ok(store.read(db => readOutcome(db, "run-early:m1")));
    assert.ok(store.read(db => readOutcome(db, "run-early:m2")));

    const known = store.read(db => readSummary(db, "run-known"));
    assert.equal(known?.payload.projectId, "project-z");
    assert.equal(known?.createdAt, null);
    assert.deepEqual(known?.flags, ["gap"]);
  } finally {
    close();
  }
});

test("the first backfill call writes every run", () => {
  const { store, close } = openStore();
  try {
    const all = Array.from({ length: 25 }, (_, index) => approvedRun(`run-${String(index).padStart(2, "0")}`));
    let calls = 0;
    const drive = outcomeBackfill(store, () => { calls += 1; return all; }, { mapOf: () => undefined, limit: 20, now: () => AT });
    // The scorecard reads these rows, so the first call leaves no run for a later minute.
    drive();
    assert.equal(calls, 1);
    for (const item of all) assert.ok(store.read(db => readSummary(db, item.id)), item.id);
    drive();
    assert.equal(calls, 1, "nothing remained, so the driver stopped for good");
  } finally {
    close();
  }

  const unready = openStore(false);
  try {
    let calls = 0;
    const drive = outcomeBackfill(unready.store, () => { calls += 1; return [approvedRun("run-x")]; }, { mapOf: () => undefined, now: () => AT });
    drive();
    drive();
    assert.equal(calls, 0);
  } finally {
    unready.close();
  }
});

test("every unsettled run is written in one tick", () => {
  const { store, close } = openStore();
  try {
    const unsettled = ["blocked", "paused", "implementing"].map(status => {
      const item = approvedRun(`run-${status}`);
      item.status = status as TeamRun["status"];
      return item;
    });
    const runs = () => [approvedRun("run-settled-a"), ...unsettled, approvedRun("run-settled-b")];
    assert.deepEqual(backfillTick(store, runs, { mapOf: () => undefined, limit: 1, now: () => AT }), { written: 4, remaining: 1 });
    for (const item of unsettled) assert.ok(store.read(db => readSummary(db, item.id)), item.id);
    assert.ok(store.read(db => readSummary(db, "run-settled-a")));
    assert.equal(store.read(db => readSummary(db, "run-settled-b")), undefined);
  } finally {
    close();
  }
});

test("active runs come first, and a module that is not ready ends the tick", () => {
  const { store, close } = openStore();
  try {
    const settled = approvedRun("run-settled");
    const later = approvedRun("run-settled-later");
    const active = approvedRun("run-active");
    active.status = "implementing";
    const options = { mapOf: () => undefined, limit: 1, now: () => AT };
    assert.deepEqual(backfillTick(store, () => [settled, later, active], options), { written: 2, remaining: 1 });
    assert.ok(store.read(db => readOutcome(db, "run-active:m1")), "the active run is written first");
    assert.ok(store.read(db => readSummary(db, "run-settled")), "one settled run follows it");
    assert.equal(store.read(db => readSummary(db, "run-settled-later")), undefined);
  } finally {
    close();
  }

  const unready = openStore(false);
  try {
    let called = false;
    const runs = () => { called = true; return [approvedRun("run-x")]; };
    assert.deepEqual(backfillTick(unready.store, runs, { mapOf: () => undefined, now: () => AT }), { written: 0, remaining: 0 });
    assert.equal(called, false, "runs() is not called while the configurations module is not ready");
  } finally {
    unready.close();
  }
});
