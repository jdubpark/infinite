import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configId } from "../packages/host/src/config-identity.js";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { EventOutbox, type EventProjector, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { EvidenceError, type EvidenceDb, type RunEvent } from "../packages/host/src/evidence/types.js";
import type { Landing, LandingCandidate, RevertMatch } from "../packages/host/src/outcome-hold.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import {
  type OutcomeRow,
  outcomeModule,
  readOutcome,
  readScanState,
  readSignal,
  readSummary,
  runOutcomes,
  runSignals,
  type RunSummaryRow,
  type SignalRow,
  writeSummary,
} from "../packages/host/src/outcome-store.js";
import {
  applyCheck,
  applyScan,
  landingSignalId,
  ownerSignal,
  ownerSignalId,
  type OwnerSignalInput,
  ratingSignalId,
  recomputeRun,
  revertSignalId,
  type ScanInputs,
  type ScanWrite,
  scanInputs,
  SignalRequestError,
} from "../packages/host/src/outcome-signals.js";
import type { LandingMethod, ScanGap } from "../packages/host/src/outcome-rules.js";
import { runEventKey } from "../packages/host/src/run-events.js";

// The harness and the event builders below are copied from tests/outcome-projector.test.ts, which this file does not
// import. The landing, verdict, and revert helpers drive the real scan functions with fixed times.

const RUN = "run-1";
const RUN_B = "run-b";
const RUN_2 = "run-2";
const RUN_E = "run-e";
const PROJECT = "example";
const REPO = "example-repo";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const MERGE = "m".repeat(40);
const REVERT = "f".repeat(40);
const COMMIT_2 = "d".repeat(40);
const TREE = "7".repeat(40);
const SCAN_HEAD = "5".repeat(40);
const HEX_A = "a".repeat(64);
const HEX_B = "e".repeat(64);
const DIFF = { added: 3, removed: 1, files: 1, docs: false, tests: true };
const FEATURES = { role: "implementer", area: "core", kind: null, risk: "normal", featureVersion: 1, featureMap: "default" };
const DAY_MS = 86_400_000;

/** A minute on the fixed clock. Events carry their own times; the projector never reads the clock. */
const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;
/** Day N of the scan clock: day 0 is 2026-11-13T00:00:00.000Z, and `ms` adds to it. */
const day = (n: number, ms = 0) => new Date(Date.parse("2026-11-13T00:00:00.000Z") + n * DAY_MS + ms).toISOString();

type Harness = {
  store: EvidenceStore;
  outbox: EventOutbox;
  projector: EventProjector;
  flush(events: readonly OutboxEvent[]): void;
  close(): void;
};

/** A store with both modules, an outbox, and both projectors. */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "infinite-outcome-signals-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => at(59) }));
  const outbox = new EventOutbox(store);
  const projector = outcomeProjector(store);
  outbox.registerProjector(configurationProjector());
  outbox.registerProjector(projector);
  return {
    store,
    outbox,
    projector,
    flush(events) {
      const result = outbox.flush(events);
      assert.equal(result.stored, true);
      assert.equal(result.refused, 0);
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let counter = 0;

/** One event with a unique key. `parts` add to the key so that a replayed event has the same key. */
function ev(kind: string, runId: string, time: string, fields: {
  revision?: number; memberId?: string; taskId?: string; data?: Record<string, unknown>; parts?: (string | number)[];
} = {}): OutboxEvent {
  counter += 1;
  return {
    key: runEventKey(kind, runId, [counter, ...(fields.parts ?? [])]),
    runId,
    revision: fields.revision ?? 1,
    at: time,
    kind,
    ...(fields.memberId === undefined ? {} : { memberId: fields.memberId }),
    ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
    data: { v: 1, ...(fields.data ?? {}) },
  };
}

const created = (runId: string, time = at(0)) => ev("run.created", runId, time, { data: { projectId: "example", purpose: "work" } });
const prepared = (runId: string) => ev("run.prepared", runId, at(0), { data: { baseCommit: BASE } });

function planned(runId: string, taskId: string, paths: string[], minute = 1, revision = 1): OutboxEvent {
  return ev("task.planned", runId, at(minute), { taskId, revision, data: { profileId: "impl", paths, features: FEATURES } });
}

function started(runId: string, memberId: string, minute: number, fields: {
  role?: string; taskId?: string; model?: string; effort?: string; revision?: number; provider?: string;
} = {}): OutboxEvent {
  const role = fields.role ?? "implementer";
  return ev("member.started", runId, at(minute), {
    memberId,
    taskId: fields.taskId,
    revision: fields.revision ?? 1,
    data: {
      role, purpose: "work", sessionId: `session-${memberId}`, startedAt: at(minute), baseCommit: BASE,
      provider: fields.provider ?? "claude", profileId: `profile-${fields.model ?? "m-1"}`,
      model: fields.model ?? "m-1", ...(fields.effort ? { effort: fields.effort } : {}),
    },
  });
}

function stopped(runId: string, memberId: string, minute: number, reason: string, role = "implementer", taskId?: string): OutboxEvent {
  return ev("member.stopped", runId, at(minute), { memberId, taskId, data: { role, reason, reported: false } });
}

function integrated(runId: string, memberId: string, taskId: string, minute: number, commit: string | undefined = "c".repeat(40)): OutboxEvent {
  return ev("task.integrated", runId, at(minute), {
    memberId, taskId,
    data: { ...(commit === undefined ? {} : { commit }), headCommit: HEAD, baseCommit: BASE, memberBaseCommit: BASE, diff: DIFF },
  });
}

function review(runId: string, minute: number, verdict: "approved" | "changes-requested", reviewer: { profileId: string; model: string },
  options: { rubric?: Record<string, unknown>[]; head?: string } = {}): OutboxEvent {
  return ev("review.recorded", runId, at(minute), {
    memberId: "reviewer-1",
    data: {
      verdict, headCommit: options.head ?? HEAD, baseCommit: BASE,
      reviewer: { provider: "claude", ...reviewer },
      ...(options.rubric ? { rubric: options.rubric } : {}),
    },
  });
}

function settled(runId: string, minute: number, status: string, summary: Record<string, number> = {}): OutboxEvent {
  return ev("run.settled", runId, at(minute), { parts: [status], data: { status, summary } });
}

/** The row of one implementer or scout in the run. */
function rowOf(store: EvidenceStore, runId: string, memberId: string) {
  return store.read(db => readOutcome(db, `${runId}:${memberId}`));
}

function summaryOf(store: EvidenceStore, runId: string) {
  return store.read(db => readSummary(db, runId));
}

function levelsOf(row: { integrated: unknown; accepted: unknown; firstPass: unknown; held: unknown } | undefined) {
  assert.ok(row, "the row exists");
  return [row.integrated, row.accepted, row.firstPass, row.held];
}

/** A row without its blind indexes, which differ between two stores. */
function plain(row: OutcomeRow | undefined) {
  assert.ok(row, "the row exists");
  const { projectRef: _p, taskRef: _t, areaRef: _a, ...rest } = row;
  return rest;
}

/**
 * Three members on one run. `m1` is integrated and approved, so its acceptance is 1. `m2` is integrated after the
 * review, so no review reaches it and its acceptance stays null. `m3` stalls.
 */
function standardRun(runId: string): OutboxEvent[] {
  return [
    created(runId), prepared(runId),
    planned(runId, "a", ["a.txt"]), planned(runId, "b", ["b.txt"]), planned(runId, "c", ["c.txt"]),
    started(runId, "m1", 2, { taskId: "a" }), integrated(runId, "m1", "a", 3),
    started(runId, "m2", 4, { taskId: "b" }),
    review(runId, 5, "approved", { profileId: "rev", model: "r-1" }),
    integrated(runId, "m2", "b", 6),
    started(runId, "m3", 7, { taskId: "c" }), stopped(runId, "m3", 8, "stall", "implementer", "c"),
    settled(runId, 9, "ready-for-review"),
  ];
}

/** The next `expectedSeq` of the project: the stored state's seq, or 0 before the first scan. */
function nextSeq(tx: EvidenceDb): number {
  return readScanState(tx, tx.index("project", PROJECT))?.seq ?? 0;
}

/** One scan of the project. Each helper below calls it with the next seq, so the project's scans move forward. */
function scanOf(h: Harness, fields: Partial<ScanWrite> & { at: string }): { applied: boolean; seq: number } {
  return h.store.write(tx => applyScan(tx, {
    projectId: PROJECT, repository: REPO, baseBranch: "main", head: SCAN_HEAD, commits: 1, gap: null,
    expectedSeq: nextSeq(tx), landings: [], reverts: [], holdDays: 30, ...fields,
  }));
}

/** The window check at `at`, at the state's seq and head. */
function checkAt(h: Harness, at: string): { applied: boolean } {
  return h.store.write(tx => applyCheck(tx, {
    projectId: PROJECT, head: SCAN_HEAD, at, expectedSeq: nextSeq(tx),
  }));
}

/** The run's landing, as the scan records it. Every helper below asserts that its scan applied. */
function land(h: Harness, runId: string, landedAt: string, method: LandingMethod = "merge-commit", holdDays = 30): void {
  const landing: Landing = { runId, commit: MERGE, method, position: 0 };
  assert.equal(scanOf(h, { at: landedAt, landings: [landing], holdDays }).applied, true);
}

/**
 * The window's verdict. `covered` is a check at `decidedAt`. `gap` is a scan inside the window (day 5) with a gap, then
 * the check at `decidedAt`.
 */
function decide(h: Harness, runId: string, state: "covered" | "gap", decidedAt: string): void {
  const signal = h.store.read(db => readSignal(db, landingSignalId(runId)));
  if (!signal || signal.payload.kind !== "landing") throw new Error("the run has no landing");
  if (state === "gap") assert.equal(scanOf(h, { at: day(5), gap: "bound", commits: 0 }).applied, true);
  assert.equal(checkAt(h, decidedAt).applied, true);
}

/** A revert of the run's landing, recorded by a scan at `revertedAt`. */
function revert(h: Harness, runId: string, revertedAt: string): void {
  const match: RevertMatch = { runId, signalId: landingSignalId(runId), commit: REVERT, reverts: MERGE };
  assert.equal(scanOf(h, { at: revertedAt, reverts: [match] }).applied, true);
}

/** Every run event of the store, in `seq` order. */
function allEvents(store: EvidenceStore): RunEvent[] {
  const found: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = store.events({ after, limit: 500 });
    found.push(...page.events);
    if (!page.more) return found;
    after = page.cursor;
  }
}

/** Applies every stored event of the projector's kinds again, in one write, as a replayed page does. */
function replay(h: Harness): void {
  const kinds: readonly string[] = h.projector.kinds;
  const events = allEvents(h.store).filter(event => kinds.includes(event.kind));
  h.store.write(tx => {
    for (const event of events) h.projector.project(tx, event);
  });
}

/** Everything the signals and the projector write for the runs, with the blind indexes left out. */
function snapshot(h: Harness, runIds: readonly string[]) {
  return h.store.read(db => ({
    rows: runIds.flatMap(runId => runOutcomes(db, runId)).map(row => plain(row)),
    summaries: runIds.map(runId => {
      const summary = readSummary(db, runId);
      assert.ok(summary, "the summary exists");
      const { projectRef: _p, ...rest } = summary;
      return rest;
    }),
    signals: runIds.flatMap(runId => runSignals(db, runId)),
    rounds: db.all("SELECT * FROM outcome_rounds ORDER BY run_id, revision, round"),
    links: db.all("SELECT * FROM outcome_round_links ORDER BY outcome_id, revision, round"),
  }));
}

function signalsOf(store: EvidenceStore, runId: string): SignalRow[] {
  return store.read(db => runSignals(db, runId));
}

/** A store with only the configurations module, so the `outcomes` module is not ready. */
function storeWithoutOutcomes(): { store: EvidenceStore; close(): void } {
  const root = mkdtempSync(join(tmpdir(), "infinite-outcome-signals-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(configurationModule());
  return {
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function assertRequestError(fn: () => unknown, code: string): void {
  assert.throws(fn, error => error instanceof SignalRequestError && error.code === code);
}

test("a landing gives accepted rows their window", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    land(h, RUN, day(0));
    const m1 = rowOf(h.store, RUN, "m1");
    const m2 = rowOf(h.store, RUN, "m2");
    const m3 = rowOf(h.store, RUN, "m3");
    assert.equal(m1?.acceptance, 1);
    assert.equal(m1?.holdUntil, day(30));
    assert.deepEqual(m1?.payload.landing, { at: day(0), method: "merge-commit" });
    assert.equal(m1?.held, null);
    assert.equal(m2?.acceptance, null);
    assert.equal(m2?.holdUntil, null);
    assert.deepEqual(levelsOf(m2), [1, null, null, null]);
    assert.equal(m3?.holdUntil, null);
    assert.deepEqual(levelsOf(m3), [0, 0, 0, 0]);
  } finally {
    h.close();
  }
});

test("a quiet window holds and a reverted one does not", () => {
  const h = harness();
  try {
    h.flush([...standardRun(RUN), ...standardRun(RUN_B), ...standardRun(RUN_2)]);
    // Reordered for Task 4b: the three landings are scanned first, so the project's scans move forward in time. The
    // draft landed RUN_2 after RUN_B's day 10 revert and day 31 check, which would have been a scan going back in time.
    land(h, RUN, day(0));
    land(h, RUN_B, day(0));
    land(h, RUN_2, day(0));
    revert(h, RUN_B, day(10));
    assert.equal(rowOf(h.store, RUN_B, "m1")?.held, 0);

    decide(h, RUN, "covered", day(30, 60_000));
    assert.equal(rowOf(h.store, RUN, "m1")?.held, 1);

    // A revert recorded after the close is outside the window: the row held. The scan writes no revert signal.
    revert(h, RUN_2, day(30, 120_000));
    assert.equal(rowOf(h.store, RUN_2, "m1")?.held, 1);
    assert.equal(signalsOf(h.store, RUN_2).some(signal => signal.kind === "revert"), false);

    // The day 31 check leaves the reverted run at 0: its verdict is stored once, and the revert stands.
    decide(h, RUN_B, "covered", day(31));
    assert.equal(rowOf(h.store, RUN_B, "m1")?.held, 0);

    // A verdict is stored once: the later scan and check did not decide RUN's window again.
    const first = h.store.read(db => readSignal(db, landingSignalId(RUN)));
    assert.deepEqual(first?.payload.kind === "landing" ? first.payload.window : undefined, { state: "covered", decidedAt: day(30, 60_000) });
  } finally {
    h.close();
  }
});

test("a gap in the window flags the row", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    land(h, RUN, day(0));
    decide(h, RUN, "gap", day(31));
    const gapped = rowOf(h.store, RUN, "m1");
    assert.equal(gapped?.held, null);
    assert.ok(gapped?.flags.includes("scan-gap"));

    revert(h, RUN, day(20));
    const reverted = rowOf(h.store, RUN, "m1");
    assert.equal(reverted?.held, 0);
    assert.equal(reverted?.flags.includes("scan-gap"), false);
  } finally {
    h.close();
  }
});

test("a signal and a later event commute", () => {
  const components = {
    profile: { provider: "claude", model: "m-1", effort: null },
    promptVersion: HEX_A, guidance: HEX_B, knowledge: "none" as const, routing: "off" as const, shape: "team" as const,
  };
  // The same events in both orders, so the event keys and the rows are the same.
  const late = [
    ev("rating.recorded", RUN, at(10), { memberId: "m1", data: { score: 4 } }),
    ev("member.configured", RUN, at(11), {
      memberId: "m1", taskId: "a",
      data: {
        configId: configId(components), provider: "claude", model: "m-1",
        promptVersion: HEX_A, guidance: HEX_B, knowledge: "none", routing: "off", shape: "team",
      },
    }),
  ];
  const first = harness();
  const second = harness();
  try {
    first.flush(standardRun(RUN));
    land(first, RUN, day(0));
    decide(first, RUN, "covered", day(31));
    first.flush(late);

    second.flush(standardRun(RUN));
    second.flush(late);
    land(second, RUN, day(0));
    decide(second, RUN, "covered", day(31));

    const a = rowOf(first.store, RUN, "m1");
    const b = rowOf(second.store, RUN, "m1");
    assert.deepEqual(plain(a), plain(b));
    assert.equal(a?.held, 1);
    assert.equal(a?.holdUntil, day(30));
    assert.equal(a?.payload.ownerRating?.score, 4);
    assert.equal(a?.configId, configId(components));
  } finally {
    first.close();
    second.close();
  }
});

test("a replayed page keeps the signals", () => {
  const h = harness();
  try {
    h.flush([...standardRun(RUN), ...standardRun(RUN_2)]);
    land(h, RUN, day(0));
    decide(h, RUN, "covered", day(31));
    ownerSignal(h.store, { action: "record", kind: "exclusion", requestId: "excl-1", runId: RUN, memberId: "m1", reason: "trial" }, at(12));
    land(h, RUN_2, day(0));
    decide(h, RUN_2, "gap", day(31));

    const before = snapshot(h, [RUN, RUN_2]);
    replay(h);
    assert.deepEqual(snapshot(h, [RUN, RUN_2]), before);

    // The exclusion is still in force, the landed row keeps its window, and the gap flag stays.
    const excluded = rowOf(h.store, RUN, "m1");
    assert.equal(excluded?.exclusion, "owner");
    assert.equal(excluded?.held, null);
    assert.equal(excluded?.holdUntil, day(30));
    assert.ok(rowOf(h.store, RUN_2, "m1")?.flags.includes("scan-gap"));
  } finally {
    h.close();
  }
});

test("an owner exclusion and its withdrawal", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    land(h, RUN, day(0));
    decide(h, RUN, "covered", day(30, 60_000));
    const attemptsBefore = summaryOf(h.store, RUN)?.payload.attempts;

    const { signal, repeated } = ownerSignal(h.store, {
      action: "record", kind: "exclusion", requestId: "excl-1", runId: RUN, memberId: "m1", reason: "outside-cause",
    }, at(12));
    assert.equal(repeated, false);
    assert.equal(signal.author, "owner");
    const excluded = rowOf(h.store, RUN, "m1");
    assert.equal(excluded?.exclusion, "owner");
    assert.deepEqual(levelsOf(excluded), [null, null, null, null]);
    assert.equal(excluded?.acceptance, 1);
    // The landing still applies to the row, so its close is kept. The plan does not require a change.
    assert.equal(excluded?.holdUntil, day(30));
    assert.deepEqual(summaryOf(h.store, RUN)?.payload.attempts, attemptsBefore);

    const withdrawn = ownerSignal(h.store, { action: "withdraw", kind: "exclusion", requestId: "excl-2", signalId: ownerSignalId("excl-1") }, at(13));
    assert.equal(withdrawn.repeated, false);
    assert.equal(withdrawn.signal.state, "withdrawn");
    const restored = rowOf(h.store, RUN, "m1");
    assert.equal(restored?.exclusion, null);
    assert.deepEqual(levelsOf(restored), [1, 1, 1, 1]);
    assert.equal(restored?.accepted, 1);

    const again = ownerSignal(h.store, { action: "withdraw", kind: "exclusion", requestId: "excl-3", signalId: ownerSignalId("excl-1") }, at(14));
    assert.equal(again.repeated, true);
  } finally {
    h.close();
  }
});

test("a linked fix makes held no where it applies", () => {
  // Named on m2, which has no acceptance: held is no at once, with or without a landing.
  const named = harness();
  // Run-wide on m1, and m2 keeps its unknown held level.
  const runWide = harness();
  // With a landing: a fix one millisecond after the close changes nothing, and a fix at the close does.
  const late = harness();
  const atClose = harness();
  // Without a landing, a run-wide fix still counts.
  const unlanded = harness();
  try {
    named.flush(standardRun(RUN));
    assert.deepEqual(levelsOf(rowOf(named.store, RUN, "m2")), [1, null, null, null]);
    ownerSignal(named.store, { action: "record", kind: "linked-fix", requestId: "fix-1", runId: RUN, memberId: "m2" }, at(20));
    assert.equal(rowOf(named.store, RUN, "m2")?.held, 0);

    runWide.flush(standardRun(RUN));
    land(runWide, RUN, day(0));
    decide(runWide, RUN, "covered", day(31));
    assert.equal(rowOf(runWide.store, RUN, "m1")?.held, 1);
    ownerSignal(runWide.store, { action: "record", kind: "linked-fix", requestId: "fix-1", runId: RUN }, at(20));
    assert.equal(rowOf(runWide.store, RUN, "m1")?.held, 0);
    assert.equal(rowOf(runWide.store, RUN, "m2")?.held, null);

    late.flush(standardRun(RUN));
    land(late, RUN, day(0));
    const closeMs = Date.parse(day(30));
    ownerSignal(late.store, { action: "record", kind: "linked-fix", requestId: "fix-late", runId: RUN, at: new Date(closeMs + 1).toISOString() }, at(20));
    assert.equal(rowOf(late.store, RUN, "m1")?.held, null);

    atClose.flush(standardRun(RUN));
    land(atClose, RUN, day(0));
    ownerSignal(atClose.store, { action: "record", kind: "linked-fix", requestId: "fix-close", runId: RUN, at: day(30) }, at(20));
    assert.equal(rowOf(atClose.store, RUN, "m1")?.held, 0);

    unlanded.flush(standardRun(RUN));
    ownerSignal(unlanded.store, { action: "record", kind: "linked-fix", requestId: "fix-1", runId: RUN }, at(20));
    assert.equal(rowOf(unlanded.store, RUN, "m1")?.held, 0);
  } finally {
    named.close();
    runWide.close();
    late.close();
    atClose.close();
    unlanded.close();
  }
});

test("owner requests are idempotent and checked", () => {
  const h = harness();
  const bare = storeWithoutOutcomes();
  try {
    h.flush(standardRun(RUN));
    const input: OwnerSignalInput = { action: "record", kind: "exclusion", requestId: "excl-1", runId: RUN, memberId: "m1", reason: "trial" };
    const first = ownerSignal(h.store, input, at(12));
    const repeat = ownerSignal(h.store, input, at(13));
    assert.equal(repeat.repeated, true);
    assert.equal(repeat.signal.signalId, first.signal.signalId);
    assert.equal(signalsOf(h.store, RUN).filter(signal => signal.kind === "exclusion").length, 1);

    assertRequestError(() => ownerSignal(h.store, { ...input, memberId: "m2" }, at(12)), "request-conflict");
    assertRequestError(() => ownerSignal(h.store, { action: "record", kind: "linked-fix", requestId: "fix-x", runId: "missing" }, at(12)), "outcome-not-found");
    assertRequestError(() => ownerSignal(h.store, { ...input, requestId: "excl-9", memberId: "nobody" }, at(12)), "outcome-not-found");

    land(h, RUN, day(0));
    assertRequestError(() => ownerSignal(h.store, { action: "withdraw", kind: "linked-fix", requestId: "w-1", signalId: landingSignalId(RUN) }, at(12)), "signal-not-withdrawable");
    assertRequestError(() => ownerSignal(h.store, { action: "withdraw", kind: "linked-fix", requestId: "w-2", signalId: first.signal.signalId }, at(12)), "signal-not-withdrawable");
    assertRequestError(() => ownerSignal(h.store, { action: "withdraw", kind: "exclusion", requestId: "w-3", signalId: "0".repeat(64) }, at(12)), "signal-not-found");

    assert.throws(
      () => ownerSignal(bare.store, { action: "record", kind: "exclusion", requestId: "excl-1", runId: RUN, memberId: "m1", reason: "trial" }, at(12)),
      error => error instanceof EvidenceError && error.code === "unavailable",
    );
  } finally {
    h.close();
    bare.close();
  }
});

test("a deleted run's rows take signals", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    assert.equal(h.store.deleteRun(RUN), true);
    land(h, RUN, day(0));
    assert.equal(rowOf(h.store, RUN, "m1")?.holdUntil, day(30));
    decide(h, RUN, "covered", day(31));
    assert.equal(rowOf(h.store, RUN, "m1")?.held, 1);
    ownerSignal(h.store, { action: "record", kind: "exclusion", requestId: "excl-1", runId: RUN, memberId: "m1", reason: "other" }, at(12));
    assert.equal(rowOf(h.store, RUN, "m1")?.exclusion, "owner");
    assert.ok(rowOf(h.store, RUN, "m1")?.runDeletedAt !== null);
  } finally {
    h.close();
  }
});

test("a rating is a signal", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    land(h, RUN, day(0));
    decide(h, RUN, "covered", day(31));
    const before = levelsOf(rowOf(h.store, RUN, "m1"));

    const rating = ev("rating.recorded", RUN, at(10), { memberId: "m1", data: { score: 4 } });
    h.flush([rating]);
    const ratings = signalsOf(h.store, RUN).filter(signal => signal.kind === "rating");
    assert.equal(ratings.length, 1);
    assert.deepEqual(ratings[0], {
      signalId: ratingSignalId(rating.key),
      runId: RUN,
      outcomeId: `${RUN}:m1`,
      kind: "rating",
      author: "owner",
      authority: "claim",
      state: "active",
      at: at(10),
      payload: { kind: "rating", score: 4 },
    });
    assert.deepEqual(levelsOf(rowOf(h.store, RUN, "m1")), before);

    // A replayed event writes the same signal, so the count stays at one.
    replay(h);
    assert.equal(signalsOf(h.store, RUN).filter(signal => signal.kind === "rating").length, 1);
    assert.deepEqual(levelsOf(rowOf(h.store, RUN, "m1")), before);
  } finally {
    h.close();
  }
});

/** Every stored row of the scan and signal tables, as raw values. */
function rawRows(h: Harness): { table: string; values: unknown[] }[] {
  const tables = ["outcomes", "run_summaries", "outcome_signals", "base_scans", "base_scan_state"];
  return h.store.read(db => tables.map(table => ({
    table,
    values: db.all<Record<string, unknown>>(`SELECT * FROM ${table}`).flatMap(row => Object.values(row)),
  })));
}

test("a scan applies once and a run lands once", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    const landing: Landing = { runId: RUN, commit: MERGE, method: "merge-commit", position: 0 };

    // A stale expectedSeq writes nothing: no scan row, no signal.
    const stale = h.store.write(tx => applyScan(tx, {
      projectId: PROJECT, repository: REPO, baseBranch: "main", head: SCAN_HEAD, at: day(0), commits: 1, gap: null,
      expectedSeq: 5, landings: [landing], reverts: [], holdDays: 30,
    }));
    assert.deepEqual(stale, { applied: false, seq: 0 });
    assert.equal(h.store.read(db => db.all("SELECT * FROM base_scans")).length, 0);
    assert.equal(signalsOf(h.store, RUN).length, 0);

    land(h, RUN, day(0));
    assert.equal(h.store.read(db => readScanState(db, db.index("project", PROJECT)))?.seq, 1);

    // A second landing of the same run in a later scan does not replace the first.
    const second = scanOf(h, { at: day(1), landings: [{ runId: RUN, commit: COMMIT_2, method: "tree-equal", position: 0 }] });
    assert.deepEqual(second, { applied: true, seq: 2 });
    const landed = h.store.read(db => readSignal(db, landingSignalId(RUN)));
    assert.equal(landed?.payload.kind === "landing" ? landed.payload.commit : undefined, MERGE);
    assert.equal(signalsOf(h.store, RUN).filter(signal => signal.kind === "landing").length, 1);
  } finally {
    h.close();
  }
});

test("no plain column holds a commit id or an issue key", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    land(h, RUN, day(0));
    revert(h, RUN, day(10));
    ownerSignal(h.store, { action: "record", kind: "linked-fix", requestId: "fix-1", runId: RUN, issue: "ABC-12", commit: MERGE }, at(20));
    ownerSignal(h.store, { action: "record", kind: "exclusion", requestId: "excl-1", runId: RUN, memberId: "m1", reason: "trial" }, at(21));

    const needles = [MERGE, REVERT, BASE, HEAD, COMMIT_2, "c".repeat(40), TREE, SCAN_HEAD, "ABC-12", "trial"];
    const found: string[] = [];
    for (const { table, values } of rawRows(h)) {
      for (const value of values) {
        for (const needle of needles) {
          if (typeof value === "string" && value.includes(needle)) found.push(`${table}:${needle.slice(0, 6)}`);
          if (value instanceof Uint8Array && Buffer.from(value).includes(Buffer.from(needle))) {
            found.push(`${table}:${needle.slice(0, 6)}:bytes`);
          }
        }
      }
    }
    assert.deepEqual(found, []);
  } finally {
    h.close();
  }
});

test("scan inputs list candidates and open landings", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    land(h, RUN, day(0));
    h.flush(standardRun(RUN_E));
    land(h, RUN_E, day(0), "merge-commit", 0);

    // The commit ids of the candidates must be lower-case hex, so these differ from the non-hex constants above.
    const candHead = "1".repeat(40);
    const candMerge = "2".repeat(40);
    // Summaries of runs with no outcome rows. A candidate's approval must fall within the last APPROVAL_DAYS of `at`.
    const summary = (runId: string, approvedAt: string, mergeCommit: string | undefined): RunSummaryRow => ({
      runId, source: "test", projectRef: "", revision: 1, status: "approved", blockCode: null, flags: [], createdAt: null,
      settledAt: null, approvedAt, runDeletedAt: null,
      payload: {
        projectId: PROJECT, attempts: {}, rounds: { total: 0, attributed: 0, unattributed: 0, unknown: 0 },
        reviewedHead: candHead, reviewedTree: TREE, ...(mergeCommit === undefined ? {} : { mergeCommit }),
      },
    });
    h.store.write(tx => {
      writeSummary(tx, summary("cand-a", day(-9), candMerge));
      writeSummary(tx, summary("cand-old", day(-90), candMerge));
      // An uppercase merge commit is not a commit id, so the candidate keeps no mergeCommit.
      writeSummary(tx, summary("cand-odd", day(-9), "A".repeat(40)));
    });

    const at1 = day(1);
    const inputs: ScanInputs = h.store.read(db => scanInputs(db, PROJECT, at1));
    assert.deepEqual(inputs.state, { seq: 2, head: SCAN_HEAD, repository: REPO, baseBranch: "main", lastAt: day(0) });
    assert.deepEqual(inputs.candidates, [
      { runId: "cand-a", reviewedHead: candHead, reviewedTree: TREE, mergeCommit: candMerge },
      { runId: "cand-odd", reviewedHead: candHead, reviewedTree: TREE },
    ] satisfies LandingCandidate[]);
    // RUN has an active landing, so it is not a candidate though its approval is in range.
    assert.equal(inputs.candidates.some(candidate => candidate.runId === RUN), false);

    // RUN's hold runs to day 30, so it is open. RUN_E's hold ended at day 0, before `at`.
    assert.deepEqual(inputs.open, [{ runId: RUN, signalId: landingSignalId(RUN), ids: [MERGE], holdUntil: day(30) }]);
  } finally {
    h.close();
  }
});

test("a window of the longest hold is decided", () => {
  const h = harness();
  try {
    h.flush(standardRun(RUN));
    land(h, RUN, day(0), "merge-commit", 365);
    decide(h, RUN, "covered", day(365, 60_000));
    const landed = h.store.read(db => readSignal(db, landingSignalId(RUN)));
    assert.equal(landed?.payload.kind === "landing" ? landed.payload.window?.state : undefined, "covered");
    assert.equal(rowOf(h.store, RUN, "m1")?.held, 1);
  } finally {
    h.close();
  }
});
