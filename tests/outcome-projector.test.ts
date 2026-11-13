import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configId } from "../packages/host/src/config-identity.js";
import { advanceEpoch, configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import { EventOutbox, type EventProjector, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import {
  outcomeModule,
  readMemberResult,
  readOutcome,
  readSummary,
  runOutcomes,
  writeOutcome,
} from "../packages/host/src/outcome-store.js";
import { runEventKey } from "../packages/host/src/run-events.js";

const RUN = "run-1";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const OTHER_HEAD = "o".repeat(40);
const TREE = "t".repeat(40);
const COMMIT = "c".repeat(40);
const COMMIT_2 = "d".repeat(40);
const MERGE = "m".repeat(40);
const HEX_A = "a".repeat(64);
const HEX_B = "e".repeat(64);
const DIFF = { added: 3, removed: 1, files: 1, docs: false, tests: true };
const SUMMARY_COUNTS = {
  tasks: 2, integrated: 2, members: 4, round: 1, checks: 0, recoveries: 0, decisionsByOwner: 0,
  decisionsByCoordinator: 0, steering: 0, permissionEscalations: 0, continuations: 0,
};
const FEATURES = { role: "implementer", area: "core", kind: null, risk: "normal", featureVersion: 1, featureMap: "default" };

/** A minute on the fixed clock. Events carry their own times; the projector never reads the clock. */
const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, "0")}:00.000Z`;

type Harness = {
  store: EvidenceStore;
  outbox: EventOutbox;
  flush(events: readonly OutboxEvent[]): void;
  close(): void;
};

/** A store with both modules, an outbox, and both projectors. `wrap` may replace the outcomes projector. */
function harness(wrap: (projector: EventProjector) => EventProjector = projector => projector): Harness {
  const root = mkdtempSync(join(tmpdir(), "infinite-outcome-projector-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => at(59) }));
  const outbox = new EventOutbox(store);
  outbox.registerProjector(configurationProjector());
  outbox.registerProjector(wrap(outcomeProjector(store)));
  return {
    store,
    outbox,
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
  role?: string; taskId?: string; model?: string; effort?: string; replaces?: { memberId: string; cause: string };
  revision?: number; provider?: string;
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
      ...(fields.replaces ? { replaces: fields.replaces } : {}),
    },
  });
}

function stopped(runId: string, memberId: string, minute: number, reason: string, role = "implementer", taskId?: string): OutboxEvent {
  return ev("member.stopped", runId, at(minute), { memberId, taskId, data: { role, reason, reported: false } });
}

function integrated(runId: string, memberId: string, taskId: string, minute: number, commit: string | undefined = COMMIT): OutboxEvent {
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

function settled(runId: string, minute: number, status: string, summary: Record<string, number> = SUMMARY_COUNTS): OutboxEvent {
  return ev("run.settled", runId, at(minute), { parts: [status], data: { status, summary } });
}

function repairStarted(runId: string, minute: number, round: number, revision = 1): OutboxEvent {
  return ev("repair.started", runId, at(minute), { revision, parts: [round], data: { round, cause: "review", headCommit: HEAD } });
}

function repairIntegrated(runId: string, minute: number, round: number, commit: string | undefined, revision = 1): OutboxEvent {
  return ev("repair.integrated", runId, at(minute), {
    memberId: "integrator-1", revision, parts: [round],
    data: { round, ...(commit === undefined ? {} : { commit }), headCommit: HEAD, baseCommit: BASE },
  });
}

function repairPaths(runId: string, minute: number, round: number, paths: string[] | "omitted", revision = 1): OutboxEvent {
  const data = paths === "omitted" ? { round, commit: COMMIT_2, pathsOmitted: true } : { round, commit: COMMIT_2, paths };
  return ev("repair.paths", runId, at(minute), { memberId: "integrator-1", revision, parts: [round], data });
}

/** The row of one implementer or scout in the run. */
function rowOf(store: EvidenceStore, runId: string, memberId: string) {
  return store.read(db => readOutcome(db, `${runId}:${memberId}`));
}

function summaryOf(store: EvidenceStore, runId: string) {
  return store.read(db => readSummary(db, runId));
}

function resultOf(store: EvidenceStore, runId: string, memberId: string) {
  return store.read(db => readMemberResult(db, `${runId}:${memberId}`));
}

function levelsOf(row: { integrated: unknown; accepted: unknown; firstPass: unknown; held: unknown } | undefined) {
  assert.ok(row, "the row exists");
  return [row.integrated, row.accepted, row.firstPass, row.held];
}

/**
 * Two tasks, a changes-requested review, and one repair round that touches only `a.txt`, then an approval.
 * `answer` says what the round reports: the paths, omitted paths, an integration without paths, an integration
 * without a commit, or nothing at all. The approval follows unless `approve` is false.
 */
function repairScenario(runId: string, options: {
  answer?: "paths" | "omitted" | "integrated" | "no-commit" | "none"; approve?: boolean;
} = {}): OutboxEvent[] {
  const answer = options.answer ?? "paths";
  const events: OutboxEvent[] = [
    created(runId), prepared(runId),
    planned(runId, "a", ["a.txt"]), planned(runId, "b", ["b.txt"]),
    started(runId, "m-a", 2, { taskId: "a" }), integrated(runId, "m-a", "a", 3),
    started(runId, "m-b", 4, { taskId: "b" }), integrated(runId, "m-b", "b", 5),
    review(runId, 6, "changes-requested", { profileId: "rev", model: "r-1" }),
    repairStarted(runId, 7, 1),
  ];
  if (answer === "paths" || answer === "omitted" || answer === "integrated") {
    events.push(repairIntegrated(runId, 8, 1, COMMIT_2));
  } else if (answer === "no-commit") {
    events.push(repairIntegrated(runId, 8, 1, undefined));
  }
  if (answer === "paths") events.push(repairPaths(runId, 9, 1, ["a.txt"]));
  if (answer === "omitted") events.push(repairPaths(runId, 9, 1, "omitted"));
  if (options.approve !== false) events.push(review(runId, 10, "approved", { profileId: "rev", model: "r-1" }));
  return events;
}

test("a stalled attempt and its replacement", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN),
      planned(RUN, "a", ["a.txt"]), planned(RUN, "b", ["b.txt"]),
      started(RUN, "m1", 2, { taskId: "a" }),
      stopped(RUN, "m1", 3, "stall", "implementer", "a"),
      started(RUN, "m2", 4, { taskId: "a", replaces: { memberId: "m1", cause: "stall" } }),
      integrated(RUN, "m2", "a", 5),
      started(RUN, "m3", 6, { taskId: "b" }),
      integrated(RUN, "m3", "b", 7),
      review(RUN, 8, "approved", { profileId: "rev", model: "r-1" }),
      settled(RUN, 9, "ready-for-review"),
    ]);
    const m1 = rowOf(h.store, RUN, "m1");
    const m2 = rowOf(h.store, RUN, "m2");
    const m3 = rowOf(h.store, RUN, "m3");
    assert.equal(m1?.disposition, "stalled");
    assert.deepEqual(levelsOf(m1), [0, 0, 0, 0]);
    assert.equal(m1?.attemptIndex, 1);
    assert.deepEqual(levelsOf(m2), [1, 1, 1, null]);
    assert.equal(m2?.attemptIndex, 2);
    assert.equal(m2?.inherited, true);
    assert.deepEqual(levelsOf(m3), [1, 1, 1, null]);
    assert.equal(m2?.frozenAt, at(9));
    assert.equal(m3?.frozenAt, at(9));
  } finally {
    h.close();
  }
});

test("a repair is attributed to the task that owns its path", () => {
  const h = harness();
  try {
    h.flush(repairScenario(RUN));
    const a = rowOf(h.store, RUN, "m-a");
    const b = rowOf(h.store, RUN, "m-b");
    assert.equal(a?.accepted, 1);
    assert.equal(a?.firstPass, 0);
    assert.deepEqual(a?.payload.rounds, { run: 1, attributed: 1, unknown: 0 });
    assert.equal(b?.firstPass, 1);
  } finally {
    h.close();
  }
});

test("a late path event resolves a frozen row", () => {
  const h = harness();
  try {
    const events = repairScenario(RUN, { answer: "integrated" });
    // Approval and freeze arrive before the paths, so the round is still pending when the run settles.
    h.flush([...events, settled(RUN, 11, "ready-for-review")]);
    const before = rowOf(h.store, RUN, "m-b");
    assert.equal(before?.firstPass, null);
    assert.equal(before?.frozenAt, at(11));
    h.flush([repairPaths(RUN, 12, 1, ["a.txt"])]);
    const after = rowOf(h.store, RUN, "m-b");
    assert.equal(after?.firstPass, 1);
    assert.equal(after?.frozenAt, at(11));
    assert.equal(rowOf(h.store, RUN, "m-a")?.firstPass, 0);
  } finally {
    h.close();
  }
});

test("missing repair facts leave rounds unknown", () => {
  const h = harness();
  try {
    // Paths omitted: the links of the round are unknown.
    h.flush(repairScenario("run-omitted", { answer: "omitted" }));
    for (const id of ["m-a", "m-b"]) {
      const row = rowOf(h.store, "run-omitted", id);
      assert.equal(row?.firstPass, null);
      assert.deepEqual(row?.payload.rounds, { run: 1, attributed: 0, unknown: 1 });
    }
    // The round is never answered: the links stay pending.
    h.flush(repairScenario("run-unanswered", { answer: "none" }));
    assert.equal(rowOf(h.store, "run-unanswered", "m-b")?.firstPass, null);
    assert.deepEqual(rowOf(h.store, "run-unanswered", "m-b")?.payload.rounds, { run: 1, attributed: 0, unknown: 1 });
    // An answer without a commit: every pending link is clear.
    h.flush(repairScenario("run-no-commit", { answer: "no-commit" }));
    assert.equal(rowOf(h.store, "run-no-commit", "m-b")?.firstPass, 1);
    assert.equal(rowOf(h.store, "run-no-commit", "m-a")?.firstPass, 1);
  } finally {
    h.close();
  }
});

test("a changes-requested review freezes as not accepted", () => {
  const h = harness();
  try {
    h.flush([
      created("run-rejected"), prepared("run-rejected"), planned("run-rejected", "a", ["a.txt"]),
      started("run-rejected", "m1", 2, { taskId: "a" }), integrated("run-rejected", "m1", "a", 3),
      review("run-rejected", 4, "changes-requested", { profileId: "rev", model: "r-1" }),
      settled("run-rejected", 5, "ready-for-review"),
      created("run-cancelled"), prepared("run-cancelled"), planned("run-cancelled", "a", ["a.txt"]),
      started("run-cancelled", "m1", 2, { taskId: "a" }), integrated("run-cancelled", "m1", "a", 3),
      review("run-cancelled", 4, "changes-requested", { profileId: "rev", model: "r-1" }),
      settled("run-cancelled", 5, "cancelled"),
    ]);
    assert.deepEqual(levelsOf(rowOf(h.store, "run-rejected", "m1")), [1, 0, 0, 0]);
    assert.deepEqual(levelsOf(rowOf(h.store, "run-cancelled", "m1")), [1, null, null, null]);
  } finally {
    h.close();
  }
});

test("owner and host stops are excluded", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), planned(RUN, "b", ["b.txt"]),
      started(RUN, "m1", 2, { taskId: "a" }), stopped(RUN, "m1", 3, "owner", "implementer", "a"),
      started(RUN, "m2", 4, { taskId: "b" }), stopped(RUN, "m2", 5, "host", "implementer", "b"),
    ]);
    const m1 = rowOf(h.store, RUN, "m1");
    const m2 = rowOf(h.store, RUN, "m2");
    assert.equal(m1?.disposition, "owner-stop");
    assert.equal(m1?.exclusion, "owner");
    assert.deepEqual(levelsOf(m1), [null, null, null, null]);
    assert.equal(m2?.disposition, "host-stop");
    assert.equal(m2?.exclusion, "host");
    assert.deepEqual(levelsOf(m2), [null, null, null, null]);
  } finally {
    h.close();
  }
});

test("a scope violation names its attempt", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), planned(RUN, "b", ["b.txt"]), planned(RUN, "c", ["c.txt"]),
      started(RUN, "m", 2, { taskId: "a" }), stopped(RUN, "m", 3, "host", "implementer", "a"),
      ev("run.revision-advanced", RUN, at(4), {
        revision: 2,
        data: { cause: "automatic-recovery", fromRevision: 1, baseChanged: false, sourceCode: "task-scope-violation", sourceMemberId: "m" },
      }),
      started(RUN, "m2", 5, { taskId: "b", revision: 2 }),
      ev("run.blocked", RUN, at(6), { data: { code: "integration-conflict", sourceMemberId: "m2" } }),
      started(RUN, "m3", 7, { taskId: "c", revision: 2 }),
      ev("run.blocked", RUN, at(8), { data: { code: "repair-limit", sourceMemberId: "m3" } }),
    ]);
    const m = rowOf(h.store, RUN, "m");
    assert.equal(m?.disposition, "out-of-scope");
    assert.equal(m?.exclusion, null);
    assert.deepEqual(levelsOf(m), [0, 0, 0, 0]);
    const m2 = rowOf(h.store, RUN, "m2");
    assert.equal(m2?.disposition, "host-stop");
    assert.equal(m2?.exclusion, "host");
    assert.equal(rowOf(h.store, RUN, "m3")?.disposition, "open");
  } finally {
    h.close();
  }
});

test("a stop with no start writes a gap row", () => {
  const h = harness();
  try {
    h.flush([created(RUN), stopped(RUN, "m9", 2, "stall", "implementer", "a")]);
    const row = rowOf(h.store, RUN, "m9");
    assert.equal(row?.role, "implementer");
    assert.equal(row?.profileId, "unknown");
    assert.equal(row?.attemptIndex, 0);
    assert.deepEqual(row?.flags, ["gap"]);
    assert.equal(row?.disposition, "stalled");
  } finally {
    h.close();
  }
});

test("configuration and epoch reach the row", () => {
  const h = harness();
  try {
    const profile = { provider: "claude", model: "m-1", effort: null };
    const epochAdvance = advanceEpoch(h.store, { profile, requestId: "request-epoch-2", now: at(2) });
    assert.equal(epochAdvance.epoch, 2);
    const components = {
      profile, promptVersion: HEX_A, guidance: HEX_B, knowledge: "none" as const, routing: "off" as const, shape: "team" as const,
    };
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]),
      started(RUN, "m1", 3, { taskId: "a", model: "m-1" }),
      stopped(RUN, "m1", 4, "stall", "implementer", "a"),
      ev("member.configured", RUN, at(5), {
        memberId: "m1", taskId: "a",
        data: {
          configId: configId(components), provider: "claude", model: "m-1",
          promptVersion: HEX_A, guidance: HEX_B, knowledge: "none", routing: "off", shape: "team",
        },
      }),
    ]);
    const row = rowOf(h.store, RUN, "m1");
    assert.equal(row?.profileEpoch, 2);
    assert.equal(row?.configId, configId(components));
    assert.equal(row?.disposition, "stalled");
  } finally {
    h.close();
  }
});

test("a same-model approval is flagged", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), planned(RUN, "b", ["b.txt"]),
      started(RUN, "m2", 2, { taskId: "a", model: "shared-model" }), integrated(RUN, "m2", "a", 3),
      started(RUN, "m3", 4, { taskId: "b", model: "other-model" }), integrated(RUN, "m3", "b", 5),
      review(RUN, 6, "approved", { profileId: "rev", model: "shared-model" }),
    ]);
    assert.deepEqual(rowOf(h.store, RUN, "m2")?.flags, ["same-model-review"]);
    assert.deepEqual(rowOf(h.store, RUN, "m3")?.flags, []);
  } finally {
    h.close();
  }
});

test("a replayed page writes the same rows", () => {
  // A member result, a changes-requested review, one repair round with its paths, an approval, and a settle, so
  // every table of the module holds something.
  const events = [
    ...repairScenario(RUN),
    started(RUN, "reviewer-1", 11, { role: "reviewer" }),
    ev("member.reported", RUN, at(12), { memberId: "reviewer-1", data: { role: "reviewer", reportKind: "review" } }),
    settled(RUN, 13, "ready-for-review"),
  ];
  const clean = harness();
  let seen = 0;
  const applied: Parameters<EventProjector["project"]>[1][] = [];
  let inner: EventProjector | undefined;
  const flaky = harness(projector => {
    inner = projector;
    return {
      name: projector.name,
      module: projector.module,
      kinds: projector.kinds,
      project(tx, event) {
        seen += 1;
        if (seen === 5) throw new Error("injected failure");
        projector.project(tx, event);
        if (seen > 5) applied.push(event);
      },
    };
  });
  try {
    clean.flush(events);
    // The injected failure rolls the whole page back, so the cursor stays where it was.
    flaky.flush(events);
    assert.equal(seen, 5);
    flaky.outbox.advance();
    assert.ok(seen > 5);
    // Blind indexes are keyed per store, so two stores never agree on them. Everything else must match.
    const tables = (h: Harness) => h.store.read(db => ({
      rows: runOutcomes(db, RUN).map(({ projectRef: _p, taskRef: _t, areaRef: _a, ...row }) => row),
      summary: (({ projectRef: _p, ...summary }) => summary)(readSummary(db, RUN)!),
      members: db.all<{ result_id: string }>("SELECT result_id FROM member_results WHERE run_id=? ORDER BY result_id", RUN)
        .map(({ result_id: id }) => (({ projectRef: _p, ...result }) => result)(readMemberResult(db, id)!)),
      rounds: db.all("SELECT * FROM outcome_rounds ORDER BY run_id, revision, round").map(row => ({ ...row })),
      links: db.all("SELECT * FROM outcome_round_links ORDER BY outcome_id, revision, round").map(row => ({ ...row })),
      state: db.all("SELECT * FROM outcome_state ORDER BY key").map(row => ({ ...row })),
    }));
    const expected = tables(clean);
    assert.equal(expected.rows.length, 2);
    assert.equal(expected.members.length, 1);
    assert.equal(expected.rounds.length, 1);
    assert.equal(expected.links.length, 2);
    assert.equal(expected.state.length, 1);
    assert.deepEqual(tables(flaky), expected);

    // Every write is a set or a recount: applying the whole page a second time, in order, changes nothing.
    // The projector receives its own kinds only; `task.planned` is read on demand and never projected.
    assert.equal(applied.length, events.filter(event => inner!.kinds.includes(event.kind)).length);
    assert.ok(applied.length > 10);
    flaky.store.write(tx => { for (const event of applied) inner!.project(tx, event); });
    assert.deepEqual(tables(flaky), expected);
  } finally {
    clean.close();
    flaky.close();
  }
});

test("a ledger gap marks the run", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), planned(RUN, "b", ["b.txt"]),
      started(RUN, "m1", 2, { taskId: "a" }),
      ev("ledger.gap", RUN, at(3), { data: { dropped: 2 } }),
      started(RUN, "m2", 4, { taskId: "b" }),
    ]);
    assert.ok(rowOf(h.store, RUN, "m1")?.flags.includes("gap"));
    assert.ok(rowOf(h.store, RUN, "m2")?.flags.includes("gap"));
    assert.ok(summaryOf(h.store, RUN)?.flags.includes("gap"));
  } finally {
    h.close();
  }
});

test("the summary keeps review and delivery facts", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), planned(RUN, "b", ["b.txt"]),
      started(RUN, "m1", 2, { taskId: "a" }), integrated(RUN, "m1", "a", 3),
      started(RUN, "m2", 4, { taskId: "b" }), integrated(RUN, "m2", "b", 5),
      review(RUN, 6, "approved", { profileId: "rev", model: "r-1" }),
      ev("review.tree", RUN, at(7), { memberId: "reviewer-1", data: { headCommit: HEAD, tree: TREE } }),
      ev("review.tree", RUN, at(8), { memberId: "reviewer-1", data: { headCommit: OTHER_HEAD, tree: "x".repeat(40) } }),
      ev("delivery.recorded", RUN, at(9), { memberId: "integrator-1", data: { method: "merge", headCommit: HEAD, mergeCommit: MERGE } }),
      settled(RUN, 10, "merged"),
    ]);
    const summary = summaryOf(h.store, RUN);
    assert.equal(summary?.approvedAt, at(6));
    assert.equal(summary?.payload.reviewedHead, HEAD);
    assert.equal(summary?.payload.reviewedTree, TREE);
    assert.equal(summary?.payload.mergeCommit, MERGE);
    assert.equal(summary?.payload.deliveryMethod, "merge");
    assert.deepEqual(summary?.payload.attempts, { integrated: 2 });
    assert.deepEqual(summary?.payload.counts, SUMMARY_COUNTS);
    assert.equal(summary?.status, "merged");
  } finally {
    h.close();
  }
});

test("no table holds a path or text", () => {
  const h = harness();
  try {
    h.flush(repairScenario(RUN));
    const dump = h.store.read(db => JSON.stringify({
      rows: runOutcomes(db, RUN),
      summary: readSummary(db, RUN),
      plain: db.all("SELECT * FROM outcomes"),
      rounds: db.all("SELECT * FROM outcome_rounds"),
      links: db.all("SELECT * FROM outcome_round_links"),
      summaries: db.all("SELECT * FROM run_summaries"),
      results: db.all("SELECT * FROM member_results"),
    }));
    assert.ok(!dump.includes("a.txt"));
    assert.ok(!dump.includes("b.txt"));
  } finally {
    h.close();
  }
});

test("members without a task get member results", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN),
      started(RUN, "reviewer-1", 2, { role: "reviewer" }),
      ev("member.reported", RUN, at(3), { memberId: "reviewer-1", data: { role: "reviewer", reportKind: "review" } }),
      started(RUN, "integrator-1", 4, { role: "integrator" }),
      stopped(RUN, "integrator-1", 5, "stall", "integrator"),
    ]);
    const reviewer = resultOf(h.store, RUN, "reviewer-1");
    assert.equal(reviewer?.disposition, "reported");
    assert.equal(reviewer?.reportKind, "review");
    const integrator = resultOf(h.store, RUN, "integrator-1");
    assert.equal(integrator?.disposition, "stalled");
    assert.equal(rowOf(h.store, RUN, "reviewer-1"), undefined);
  } finally {
    h.close();
  }
});

test("the summary counts rounds, not links", () => {
  const h = harness();
  try {
    // One round, attributed to task a, in its own run.
    h.flush([...repairScenario("run-one"), settled("run-one", 11, "ready-for-review")]);
    assert.deepEqual(summaryOf(h.store, "run-one")?.payload.rounds, { total: 1, attributed: 1, unattributed: 0, unknown: 0 });

    // Four rounds: attributed, resolved with no owner, omitted paths, and no answer at all.
    const run = "run-four";
    h.flush([
      created(run), prepared(run), planned(run, "a", ["a.txt"]), planned(run, "b", ["b.txt"]),
      started(run, "m-a", 2, { taskId: "a" }), integrated(run, "m-a", "a", 3),
      started(run, "m-b", 4, { taskId: "b" }), integrated(run, "m-b", "b", 5),
      review(run, 6, "changes-requested", { profileId: "rev", model: "r-1" }),
      repairStarted(run, 7, 1), repairIntegrated(run, 8, 1, COMMIT_2), repairPaths(run, 9, 1, ["a.txt"]),
      repairStarted(run, 10, 2), repairIntegrated(run, 11, 2, COMMIT_2), repairPaths(run, 12, 2, ["c.txt"]),
      repairStarted(run, 13, 3), repairIntegrated(run, 14, 3, COMMIT_2), repairPaths(run, 15, 3, "omitted"),
      repairStarted(run, 16, 4),
      settled(run, 17, "ready-for-review"),
    ]);
    assert.deepEqual(summaryOf(h.store, run)?.payload.rounds, { total: 4, attributed: 1, unattributed: 1, unknown: 2 });

    // A path event after the settle moves its round from unknown to its result, with no second settle.
    h.flush([repairPaths(run, 18, 4, ["c.txt"])]);
    // Round 3 stays unknown: its paths were omitted, so nothing later can answer it.
    assert.deepEqual(summaryOf(h.store, run)?.payload.rounds, { total: 4, attributed: 1, unattributed: 2, unknown: 1 });
  } finally {
    h.close();
  }
});

test("an integration after a failure starts with no acceptance", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), started(RUN, "m1", 2, { taskId: "a" }),
      ev("member.reported", RUN, at(3), { memberId: "m1", taskId: "a", data: { role: "implementer", reportKind: "question" } }),
    ]);
    assert.deepEqual(levelsOf(rowOf(h.store, RUN, "m1")), [0, 0, 0, 0]);
    h.flush([integrated(RUN, "m1", "a", 4)]);
    assert.deepEqual(levelsOf(rowOf(h.store, RUN, "m1")), [1, null, null, null]);
    h.flush([review(RUN, 5, "approved", { profileId: "rev", model: "r-1" })]);
    assert.equal(rowOf(h.store, RUN, "m1")?.accepted, 1);
  } finally {
    h.close();
  }
});

test("a review of a new head drops the old tree and approval", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), started(RUN, "m1", 2, { taskId: "a" }),
      integrated(RUN, "m1", "a", 3),
      review(RUN, 4, "approved", { profileId: "rev", model: "r-1" }),
      ev("review.tree", RUN, at(5), { memberId: "reviewer-1", data: { headCommit: HEAD, tree: TREE } }),
    ]);
    assert.equal(summaryOf(h.store, RUN)?.payload.reviewedTree, TREE);
    h.flush([review(RUN, 6, "changes-requested", { profileId: "rev", model: "r-1" }, { head: OTHER_HEAD })]);
    const summary = summaryOf(h.store, RUN);
    assert.equal(summary?.payload.reviewedHead, OTHER_HEAD);
    assert.equal(summary?.payload.reviewedTree, undefined);
    assert.equal(summary?.approvedAt, null);
    // A late tree for the old head changes nothing.
    h.flush([ev("review.tree", RUN, at(7), { memberId: "reviewer-1", data: { headCommit: HEAD, tree: TREE } })]);
    assert.equal(summaryOf(h.store, RUN)?.payload.reviewedTree, undefined);
  } finally {
    h.close();
  }
});

test("a rating for an unknown member writes no row", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), started(RUN, "m1", 2, { taskId: "a" }),
      ev("rating.recorded", RUN, at(3), { memberId: "ghost", taskId: "a", data: { score: 3 } }),
    ]);
    assert.equal(rowOf(h.store, RUN, "ghost"), undefined);
    h.flush([ev("rating.recorded", RUN, at(4), { memberId: "m1", taskId: "a", data: { score: 5 } })]);
    assert.equal(rowOf(h.store, RUN, "m1")?.payload.ownerRating?.score, 5);
  } finally {
    h.close();
  }
});

test("a settled run drops an earlier block code", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN),
      ev("run.blocked", RUN, at(2), { data: { code: "repair-limit" } }),
      settled(RUN, 3, "ready-for-review"),
    ]);
    assert.equal(summaryOf(h.store, RUN)?.blockCode, null);
    h.flush([
      ev("run.blocked", "run-kept", at(4), { data: { code: "repair-limit" } }),
      settled("run-kept", 5, "blocked"),
    ]);
    assert.equal(summaryOf(h.store, "run-kept")?.blockCode, "repair-limit");
  } finally {
    h.close();
  }
});

test("a later event keeps a backfilled row's unknown rounds", () => {
  const h = harness();
  try {
    const run = "run-backfilled";
    const id = `${run}:m1`;
    // Written as Task 4 writes it: an accepted row at the member's revision with no base commit, one round at
    // revision 0, and one unknown link to it.
    h.store.write(tx => {
      writeOutcome(tx, {
        outcomeId: id, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: run, revision: 1,
        memberId: "m1", sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: "p",
        provider: "claude", model: "m-1", effort: null, profileEpoch: 1, configId: null, experimentRef: null,
        kind: null, risk: "normal", featureVersion: 1, disposition: "integrated", exclusion: null,
        flags: ["backfilled"], integrated: 1, accepted: 1, firstPass: null, held: null, startedAt: null,
        endedAt: null, frozenAt: null, holdUntil: null, runDeletedAt: null,
        payload: {
          projectId: "example", taskId: "a", area: "core", featureMap: "default",
          rounds: { run: 1, attributed: 0, unknown: 1 }, limitEvents: 0, costCoverage: "none",
        },
      });
      tx.run(
        "INSERT INTO outcome_rounds (run_id, revision, round, cause, state, started_at, run_deleted_at) VALUES (?, 0, 1, 'unknown', 'unknown', ?, NULL)",
        run, at(0),
      );
      tx.run(
        "INSERT INTO outcome_round_links (outcome_id, run_id, revision, round, state) VALUES (?, ?, 0, 1, 'unknown')",
        id, run,
      );
    });
    h.flush([ev("rating.recorded", run, at(2), { memberId: "m1", taskId: "a", data: { score: 4 } })]);
    const row = rowOf(h.store, run, "m1");
    assert.equal(row?.firstPass, null);
    assert.deepEqual(row?.payload.rounds, { run: 1, attributed: 0, unknown: 1 });
    assert.ok(row?.flags.includes("backfilled"));
  } finally {
    h.close();
  }
});

test("a row that ends has an end time", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), planned(RUN, "b", ["b.txt"]), planned(RUN, "c", ["c.txt"]),
      started(RUN, "m-question", 2, { taskId: "a" }),
      ev("member.reported", RUN, at(3), { memberId: "m-question", taskId: "a", data: { role: "implementer", reportKind: "question" } }),
      // A host stop ends the attempt. The scope violation that follows names its fault and keeps that time.
      started(RUN, "m-scope", 4, { taskId: "b" }), stopped(RUN, "m-scope", 5, "host", "implementer", "b"),
      ev("run.blocked", RUN, at(6), { data: { code: "task-scope-violation", sourceMemberId: "m-scope" } }),
      // A block that finds the attempt still open ends it at the block.
      started(RUN, "m-wrong", 7, { taskId: "c" }),
      ev("run.blocked", RUN, at(8), { data: { code: "wrong-agent-report", sourceMemberId: "m-wrong" } }),
      started(RUN, "reviewer-1", 9, { role: "reviewer" }),
      ev("member.reported", RUN, at(10), { memberId: "reviewer-1", data: { role: "reviewer", reportKind: "review" } }),
    ]);
    const question = rowOf(h.store, RUN, "m-question");
    assert.equal(question?.disposition, "question");
    assert.equal(question?.endedAt, at(3));
    const scope = rowOf(h.store, RUN, "m-scope");
    assert.equal(scope?.disposition, "out-of-scope");
    assert.equal(scope?.endedAt, at(5));
    const wrong = rowOf(h.store, RUN, "m-wrong");
    assert.equal(wrong?.disposition, "wrong-report");
    assert.equal(wrong?.endedAt, at(8));
    assert.equal(resultOf(h.store, RUN, "reviewer-1")?.endedAt, at(10));
  } finally {
    h.close();
  }
});

test("a settle never turns a backfilled row to not accepted", () => {
  const h = harness();
  try {
    const run = "run-backfilled-review";
    // A record can keep a review that requested changes. The backfill claims no acceptance from it, and a later
    // settle must not add that claim.
    h.store.write(tx => {
      writeOutcome(tx, {
        outcomeId: `${run}:m1`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: run, revision: 1,
        memberId: "m1", sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: "p",
        provider: "claude", model: "m-1", effort: null, profileEpoch: 1, configId: null, experimentRef: null,
        kind: null, risk: "normal", featureVersion: 1, disposition: "integrated", exclusion: null,
        flags: ["backfilled"], integrated: 1, accepted: null, firstPass: null, held: null, startedAt: null,
        endedAt: null, frozenAt: null, holdUntil: null, runDeletedAt: null,
        payload: {
          projectId: "example", taskId: "a", area: "core", featureMap: "default", lastReview: "changes-requested",
          rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none",
        },
      });
    });
    h.flush([settled(run, 5, "ready-for-review")]);
    const row = rowOf(h.store, run, "m1");
    assert.deepEqual(levelsOf(row), [1, null, null, null]);
    assert.equal(row?.frozenAt, at(5));
  } finally {
    h.close();
  }
});

test("a replacement of a sentinel is attempt 2", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]),
      stopped(RUN, "m1", 2, "stall", "implementer", "a"),
      started(RUN, "m2", 3, { taskId: "a", replaces: { memberId: "m1", cause: "stall" } }),
    ]);
    assert.equal(rowOf(h.store, RUN, "m1")?.attemptIndex, 0);
    const replacement = rowOf(h.store, RUN, "m2");
    assert.equal(replacement?.attemptIndex, 2);
    assert.equal(replacement?.inherited, true);
  } finally {
    h.close();
  }
});

test("a report read after a halt's stop still counts", () => {
  const h = harness();
  try {
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), planned(RUN, "b", ["b.txt"]),
      // A halt stops a member before the host has read its whole journal, so the report can follow the stop.
      started(RUN, "m1", 2, { taskId: "a" }), stopped(RUN, "m1", 3, "host", "implementer", "a"),
      ev("member.reported", RUN, at(4), { memberId: "m1", taskId: "a", data: { role: "implementer", reportKind: "question" } }),
      started(RUN, "m2", 2, { taskId: "b" }), stopped(RUN, "m2", 3, "owner", "implementer", "b"),
      ev("member.reported", RUN, at(5), { memberId: "m2", taskId: "b", data: { role: "implementer", reportKind: "blocked" } }),
    ]);
    const first = rowOf(h.store, RUN, "m1");
    assert.equal(first?.disposition, "question");
    assert.equal(first?.exclusion, null);
    assert.deepEqual(levelsOf(first), [0, 0, 0, 0]);
    assert.equal(first?.endedAt, at(3), "the stop ended the attempt, and its time is kept");
    const second = rowOf(h.store, RUN, "m2");
    assert.equal(second?.disposition, "blocked");
    assert.equal(second?.exclusion, null);

    // A member with no task follows the same rule: a report read after the halt's stop still stands.
    h.flush([
      started(RUN, "reviewer-1", 6, { role: "reviewer" }), stopped(RUN, "reviewer-1", 7, "host", "reviewer"),
      ev("member.reported", RUN, at(8), { memberId: "reviewer-1", data: { role: "reviewer", reportKind: "review" } }),
      started(RUN, "integrator-1", 6, { role: "integrator" }), stopped(RUN, "integrator-1", 7, "stall", "integrator"),
      ev("member.reported", RUN, at(8), { memberId: "integrator-1", data: { role: "integrator", reportKind: "result" } }),
    ]);
    const reviewer = resultOf(h.store, RUN, "reviewer-1");
    assert.equal(reviewer?.disposition, "reported");
    assert.equal(reviewer?.reportKind, "review");
    assert.equal(reviewer?.endedAt, at(7));
    assert.equal(resultOf(h.store, RUN, "integrator-1")?.disposition, "stalled");
  } finally {
    h.close();
  }
});

test("a run deleted while the projector is behind keeps and flags its rows", () => {
  let behind = false;
  const h = harness(projector => ({
    name: projector.name,
    module: projector.module,
    kinds: projector.kinds,
    project(tx, event) {
      if (behind) throw new Error("the projector is behind");
      projector.project(tx, event);
    },
  }));
  try {
    h.flush([created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]), started(RUN, "m1", 2, { taskId: "a" })]);
    assert.equal(rowOf(h.store, RUN, "m1")?.disposition, "open");
    // The integration is stored, and the projector never applies it.
    behind = true;
    h.flush([integrated(RUN, "m1", "a", 5)]);
    assert.equal(rowOf(h.store, RUN, "m1")?.disposition, "open");

    assert.equal(h.store.deleteRun(RUN), true);
    const row = rowOf(h.store, RUN, "m1");
    assert.equal(row?.disposition, "open", "a fact that never arrived stays unknown");
    assert.equal(row?.runDeletedAt, at(59));
    assert.ok(row?.flags.includes("gap"));
    const summary = summaryOf(h.store, RUN);
    assert.equal(summary?.runDeletedAt, at(59));
    assert.ok(summary?.flags.includes("gap"));
    assert.equal(h.store.events({ runId: RUN, after: 0, limit: 10 }).events.length, 0);
    const dump = h.store.read(db => JSON.stringify([
      db.all("SELECT * FROM outcomes"), db.all("SELECT * FROM run_summaries"), db.all("SELECT * FROM outcome_rounds"),
      db.all("SELECT * FROM outcome_round_links"), db.all("SELECT * FROM member_results"),
      runOutcomes(db, RUN), readSummary(db, RUN),
    ]));
    assert.equal(dump.includes("a.txt"), false);
  } finally {
    h.close();
  }
});

test("a stop after the settle updates the summary's attempts", () => {
  const h = harness();
  try {
    // An owner cancel settles the run first; the halt loop stops its members afterwards.
    h.flush([
      created(RUN), prepared(RUN), planned(RUN, "a", ["a.txt"]),
      started(RUN, "m1", 2, { taskId: "a" }),
      settled(RUN, 3, "cancelled"),
    ]);
    assert.deepEqual(summaryOf(h.store, RUN)?.payload.attempts, { open: 1 });
    h.flush([stopped(RUN, "m1", 4, "owner", "implementer", "a")]);
    assert.deepEqual(summaryOf(h.store, RUN)?.payload.attempts, { "owner-stop": 1 });
    h.flush([ev("rating.recorded", RUN, at(5), { memberId: "m1", taskId: "a", data: { score: 3 } })]);
    assert.deepEqual(summaryOf(h.store, RUN)?.payload.attempts, { "owner-stop": 1 });

    // A backfilled failure keeps the levels of a counted failure when a later event touches it.
    const run = "run-backfilled-failure";
    h.store.write(tx => {
      writeOutcome(tx, {
        outcomeId: `${run}:m1`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: run, revision: 1,
        memberId: "m1", sessionId: null, attemptIndex: 1, inherited: false, role: "implementer", profileId: "p",
        provider: "claude", model: "m-1", effort: null, profileEpoch: 1, configId: null, experimentRef: null,
        kind: null, risk: "normal", featureVersion: 1, disposition: "stalled", exclusion: null,
        flags: ["backfilled"], integrated: 0, accepted: 0, firstPass: 0, held: 0, startedAt: null,
        endedAt: null, frozenAt: null, holdUntil: null, runDeletedAt: null,
        payload: {
          projectId: "example", taskId: "a", area: "core", featureMap: "default",
          rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none",
        },
      });
    });
    h.flush([ev("rating.recorded", run, at(6), { memberId: "m1", taskId: "a", data: { score: 2 } })]);
    assert.deepEqual(levelsOf(rowOf(h.store, run, "m1")), [0, 0, 0, 0]);
  } finally {
    h.close();
  }
});
