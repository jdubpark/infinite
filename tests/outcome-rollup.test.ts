import test from "node:test";
import assert from "node:assert/strict";
import { SOURCES, buildCells, type CostLookup, type SessionCost } from "../packages/host/src/outcome-cells.js";
import { buildRollup, latestAssessment, rollupMissing, type RollupTarget } from "../packages/host/src/outcome-rollup.js";
import type {
  MemberResultRow,
  OutcomeRow,
  OutcomePayload,
  RollupRecords,
  RunSummaryPayload,
  RunSummaryRow,
} from "../packages/host/src/outcome-store.js";
import { exclusionOf, type Disposition, type Flag, type Level } from "../packages/host/src/outcome-rules.js";
import type { RunSummaryCounts } from "../packages/host/src/run-events.js";

const FROZEN = "2026-11-01T00:00:00.000Z";
const GOAL: RollupTarget = { kind: "goal", id: "11111111-1111-4111-8111-111111111111" };

/** One outcome row. Every required field is filled; the overrides win. The exclusion follows the disposition. */
function row(
  overrides: Partial<Omit<OutcomeRow, "payload">> & { payload?: Partial<OutcomePayload> } = {},
): OutcomeRow {
  const { payload: payloadOverrides, ...rest } = overrides;
  const disposition: Disposition = rest.disposition ?? "integrated";
  const payload: OutcomePayload = {
    projectId: "p",
    taskId: "t",
    area: "a",
    featureMap: "default",
    rounds: { run: 0, attributed: 0, unknown: 0 },
    limitEvents: 0,
    costCoverage: "none",
    ...payloadOverrides,
  };
  return {
    outcomeId: "o",
    source: "production",
    projectRef: "pref",
    taskRef: "tref",
    areaRef: "aref",
    runId: "R1",
    revision: 1,
    memberId: "m",
    sessionId: null,
    attemptIndex: 0,
    inherited: false,
    role: "implementer",
    profileId: "light",
    provider: "claude",
    model: "model-a",
    effort: null,
    profileEpoch: 1,
    configId: null,
    experimentRef: null,
    kind: null,
    risk: "low",
    featureVersion: 1,
    disposition,
    exclusion: exclusionOf(disposition) ?? null,
    flags: [] as Flag[],
    integrated: null as Level,
    accepted: null as Level,
    firstPass: null as Level,
    held: null as Level,
    startedAt: null,
    endedAt: null,
    frozenAt: FROZEN,
    holdUntil: null,
    runDeletedAt: null,
    ...rest,
    payload,
  };
}

/** One run summary. Settled-looking fields are null; the overrides win. */
function summary(
  overrides: Partial<Omit<RunSummaryRow, "payload">> & { payload?: Partial<RunSummaryPayload> } = {},
): RunSummaryRow {
  const { payload: payloadOverrides, ...rest } = overrides;
  const payload: RunSummaryPayload = {
    projectId: "p",
    attempts: {},
    rounds: { total: 0, attributed: 0, unattributed: 0, unknown: 0 },
    ...payloadOverrides,
  };
  return {
    runId: "R1",
    source: "production",
    projectRef: "pref",
    revision: 1,
    status: null,
    blockCode: null,
    flags: [] as Flag[],
    createdAt: null,
    settledAt: null,
    approvedAt: null,
    runDeletedAt: null,
    ...rest,
    payload,
  };
}

/** One member result. */
function member(overrides: Partial<Omit<MemberResultRow, "payload">> = {}): MemberResultRow {
  return {
    resultId: "x1",
    source: "production",
    projectRef: "pref",
    runId: "R1",
    revision: 1,
    memberId: "m",
    sessionId: null,
    role: "scout",
    profileId: "light",
    provider: "claude",
    model: "model-a",
    effort: null,
    profileEpoch: 1,
    configId: null,
    reportKind: null,
    disposition: "reported",
    flags: [] as Flag[],
    startedAt: null,
    endedAt: null,
    runDeletedAt: null,
    payload: { projectId: "p" },
    ...overrides,
  };
}

/** Counts with every key at zero, for a summary that settled. */
function counts(overrides: Partial<RunSummaryCounts> = {}): RunSummaryCounts {
  return {
    tasks: 0, integrated: 0, members: 0, round: 0, checks: 0, recoveries: 0, decisionsByOwner: 0,
    decisionsByCoordinator: 0, steering: 0, permissionEscalations: 0, continuations: 0,
    ...overrides,
  };
}

/** Records of one goal. Every list defaults to empty. */
function records(overrides: Partial<RollupRecords> = {}): RollupRecords {
  return {
    runIds: [],
    summaries: [],
    rows: [],
    members: [],
    unreadable: { summaries: 0, rows: 0, members: 0 },
    unindexed: 0,
    ...overrides,
  };
}

/** A rollup with no assessment and no cost lookup, for the tests that do not need them. */
function rollupOf(input: RollupRecords, known = true, cost?: CostLookup) {
  return buildRollup(input, { target: GOAL, known, assessment: null, cost });
}

test("levels come from the cell rules", () => {
  const rows = [
    row({ outcomeId: "o1", integrated: 1, accepted: 1, firstPass: 1, held: 0 }),
    row({ outcomeId: "o2", disposition: "stalled", held: 0 }),
    row({ outcomeId: "o3", disposition: "owner-stop" }),
    row({ outcomeId: "o4", disposition: "open" }),
    row({ outcomeId: "o5", role: "scout", disposition: "completed" }),
    row({ outcomeId: "o6", source: "replay", integrated: 1, accepted: 0, firstPass: 0, held: 1 }),
  ];
  const rollup = rollupOf(records({ runIds: ["R1"], rows }));
  assert.deepEqual(
    rollup.implementer,
    buildCells(rows, { use: "display", sources: [...SOURCES], by: [], role: "implementer" }),
  );
  assert.deepEqual(
    rollup.scout,
    buildCells(rows, { use: "display", sources: [...SOURCES], by: [], role: "scout" }),
  );
  const replay = rollup.implementer.find(cell => cell.key.source === "replay");
  assert.ok(replay, "a replay row gets a cell of its own");
  assert.equal(replay.attempts, 1);
});

test("run facts sum settled summaries only", () => {
  const summaries = [
    summary({
      runId: "R1",
      status: "merged",
      payload: {
        counts: counts({ tasks: 2, integrated: 2, recoveries: 1, decisionsByOwner: 1 }),
        rounds: { total: 1, attributed: 1, unattributed: 0, unknown: 0 },
      },
    }),
    summary({
      runId: "R2",
      status: "blocked",
      blockCode: "delivery-recovery",
      payload: {
        counts: counts({ tasks: 1 }),
        rounds: { total: 2, attributed: 0, unattributed: 0, unknown: 2 },
      },
    }),
    summary({ runId: "R3", status: null }),
  ];
  const runs = rollupOf(records({ runIds: ["R1", "R2", "R3"], summaries })).runs;
  assert.equal(runs.withCounts, 2);
  assert.equal(runs.counts?.tasks, 3);
  assert.equal(runs.counts?.recoveries, 1);
  assert.deepEqual(runs.rounds, { total: 3, attributed: 1, unattributed: 0, unknown: 2 });
  assert.deepEqual(runs.status, { merged: 1, blocked: 1, unsettled: 1 });
  assert.deepEqual(runs.blockCodes, { "delivery-recovery": 1 });

  const unsettledOnly = rollupOf(records({ runIds: ["R3"], summaries: [summary({ runId: "R3" })] })).runs;
  assert.equal(unsettledOnly.counts, null);
  assert.equal(unsettledOnly.rounds, null);
  assert.equal(unsettledOnly.withCounts, 0);
});

test("attempts count every row by disposition", () => {
  const rows = [
    row({ outcomeId: "o1", disposition: "integrated" }),
    row({ outcomeId: "o2", disposition: "integrated" }),
    row({ outcomeId: "o3", disposition: "stalled" }),
    row({ outcomeId: "o4", role: "scout", disposition: "completed" }),
  ];
  assert.deepEqual(rollupOf(records({ runIds: ["R1"], rows })).attempts, { integrated: 2, stalled: 1, completed: 1 });
});

test("cost sums complete sessions and never counts a missing one as zero", () => {
  const costs = new Map<string, SessionCost>([
    ["s1", { usd: 0.5, tokens: 1000, complete: true }],
    ["s2", { usd: 9, tokens: 9, complete: false }],
    // A subscription session has a cost figure too. It adds tokens and never spend.
    ["s4", { usd: 7, tokens: 400, complete: true }],
  ]);
  const calls: string[] = [];
  const lookup: CostLookup = sessionId => {
    calls.push(sessionId);
    return costs.get(sessionId);
  };
  const rows = [
    row({ outcomeId: "o1", sessionId: "s1", provider: "opencode" }),
    row({ outcomeId: "o2", sessionId: "s2", provider: "codex" }),
    row({ outcomeId: "o3", sessionId: "s3", provider: "codex" }),
    row({ outcomeId: "o4", sessionId: "s1", provider: "codex" }),
    row({ outcomeId: "o5", sessionId: null, provider: "codex" }),
  ];
  const members = [member({ resultId: "x1", sessionId: "s4", provider: "codex" })];
  const cost = rollupOf(records({ runIds: ["R1"], rows, members }), true, lookup).cost;
  assert.deepEqual(cost, { sessions: 4, complete: 2, noSession: 1, tokens: 1400, spentUsd: 0.5 });
  assert.deepEqual([...calls].sort(), ["s1", "s2", "s3", "s4"], "the lookup runs once per distinct session");

  const none = rollupOf(records({ runIds: ["R1"], rows, members }), true, () => undefined).cost;
  assert.equal(none.complete, 0);
  assert.equal(none.tokens, null);
  assert.equal(none.spentUsd, null);

  const noLookup = rollupOf(records({ runIds: ["R1"], rows, members })).cost;
  assert.equal(noLookup.complete, 0);
  assert.equal(noLookup.tokens, null);
  assert.equal(noLookup.spentUsd, null);
});

test("runs known by rows, deleted runs, and flags", () => {
  const rows = [row({ outcomeId: "o1", runId: "R2", runDeletedAt: "2026-11-02T00:00:00.000Z" })];
  const summaries = [summary({ runId: "R1", flags: ["backfilled"] })];
  const runs = rollupOf(records({ runIds: ["R1", "R2"], summaries, rows })).runs;
  assert.equal(runs.total, 2);
  assert.equal(runs.withSummary, 1);
  assert.equal(runs.deleted, 1);
  assert.equal(runs.flagged.backfilled, 1);
  assert.equal(runs.flagged.gap, 0);
});

test("unreadable and unindexed records are reported", () => {
  const rollup = rollupOf(
    records({ runIds: ["R1"], unreadable: { summaries: 1, rows: 2, members: 0 }, unindexed: 3 }),
  );
  assert.deepEqual(rollup.unreadable, { summaries: 1, rows: 2, members: 0 });
  assert.equal(rollup.unindexed, 3);
});

test("the latest assessment", () => {
  const entries = [
    { result: "not-achieved" as const, summary: "old text", evidence: "old proof", at: "2026-11-01T00:00:00.000Z", revision: 1 },
    { result: "achieved" as const, summary: "new text", evidence: "new proof", at: "2026-11-02T00:00:00.000Z", revision: 2 },
  ];
  assert.deepEqual(latestAssessment(entries), { result: "achieved", at: "2026-11-02T00:00:00.000Z", revision: 2 });
  assert.equal(latestAssessment([]), null);
});

test("an empty roll-up", () => {
  const rollup = rollupOf(records(), true);
  assert.equal(rollup.runs.total, 0);
  assert.equal(rollup.runs.counts, null);
  assert.equal(rollup.runs.rounds, null);
  assert.deepEqual(rollup.implementer, []);
  assert.deepEqual(rollup.scout, []);
  assert.deepEqual(rollup.cost, { sessions: 0, complete: 0, noSession: 0, tokens: null, spentUsd: null });
  assert.equal(rollupMissing(rollup), false);

  assert.equal(rollupMissing(rollupOf(records(), false)), true, "an id the host and the ledger do not hold is missing");
  assert.equal(rollupMissing(rollupOf(records({ runIds: ["R1"] }), false)), false, "a run of the target is not missing");
});
