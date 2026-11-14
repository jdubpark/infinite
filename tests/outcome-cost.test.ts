import test from "node:test";
import assert from "node:assert/strict";
import { EvidenceError } from "../packages/host/src/evidence/types.js";
import { sessionCostOf } from "../packages/host/src/outcome-cost.js";
import { buildRollup } from "../packages/host/src/outcome-rollup.js";
import type { OutcomeRow, RollupRecords } from "../packages/host/src/outcome-store.js";
import type { SessionUsage, UnmeasuredUsage } from "../packages/host/src/usage-service.js";

/** A measured session of 24 tokens and 0.5 USD, with the coverage and the unpriced steps given. */
function measured(coverage: "partial" | "complete", unpriced = 0): SessionUsage {
  return {
    measured: true, coverage, cost: 0.5, messages: 2,
    tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 4 },
    pricing: { configured: 2 - unpriced, catalog: 0, provider: 0, unknown: unpriced },
  };
}

test("a session's cost is complete only with complete coverage and every step priced", () => {
  assert.deepEqual(sessionCostOf(measured("complete")), { usd: 0.5, tokens: 24, complete: true });
  // The ledger read only a part of the session: its usage is known to be understated.
  assert.deepEqual(sessionCostOf(measured("partial")), { usd: 0.5, tokens: 24, complete: false });
  assert.deepEqual(sessionCostOf(measured("complete", 1)), { usd: 0.5, tokens: 24, complete: false });
});

test("no measurement is no cost, and an unreadable ledger fails the read", () => {
  const unmeasured: UnmeasuredUsage = { measured: false, coverage: "none" };
  assert.equal(sessionCostOf(unmeasured), undefined);
  assert.throws(
    () => sessionCostOf({ measured: false, coverage: "none", unavailable: true }),
    (error: unknown) => error instanceof EvidenceError && error.code === "unavailable",
  );
});

test("a roll-up leaves a partly covered session out of its sums and counts it as left out", () => {
  const row = (memberId: string, sessionId: string): OutcomeRow => ({
    outcomeId: `run-1:${memberId}`, source: "production", projectRef: "", taskRef: "", areaRef: "", runId: "run-1", revision: 1, memberId, sessionId,
    attemptIndex: 1, inherited: false, role: "implementer", profileId: "profile-a", provider: "opencode", model: "model-one", effort: null, profileEpoch: 1,
    configId: null, experimentRef: null, kind: null, risk: "unknown", featureVersion: 1, disposition: "integrated", exclusion: null, flags: [],
    integrated: 1, accepted: 1, firstPass: 1, held: null, startedAt: "2026-11-13T10:00:00.000Z", endedAt: "2026-11-13T10:30:00.000Z", frozenAt: null,
    holdUntil: null, runDeletedAt: null,
    payload: { projectId: "example", taskId: "task-a", area: "core", featureMap: "default", rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none" },
  });
  const records: RollupRecords = { runIds: ["run-1"], summaries: [], rows: [row("m1", "whole"), row("m2", "part")], members: [],
    unreadable: { summaries: 0, rows: 0, members: 0 }, unindexed: 0 };
  const usage: Record<string, SessionUsage> = { whole: measured("complete"), part: measured("partial") };
  const rollup = buildRollup(records, { target: { kind: "goal", id: "goal-1" }, known: true, assessment: null, cost: sessionId => sessionCostOf(usage[sessionId]!) });
  assert.deepEqual(rollup.cost, { sessions: 2, complete: 1, noSession: 0, tokens: 24, spentUsd: 0.5 });
});
