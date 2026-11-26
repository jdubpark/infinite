import test from "node:test";
import assert from "node:assert/strict";
import type { RepairLoopReport } from "../apps/web/src/api";
import {
  buildRepairMetricsViewModel,
  classifyRepairLoopError,
  evaluateExperimentGate,
  formatMedianTokens,
  formatMedianUsd,
  formatRepairDurationMs,
  formatRepairMinutes,
  formatSampleCost,
  formatTokenCount,
  repairLoopsPath,
} from "../apps/web/src/repair-metrics-model";

function makeReport(overrides: Partial<RepairLoopReport> = {}): RepairLoopReport {
  return {
    windowDays: 30,
    totals: {
      runsExamined: 12,
      eventCoverage: "complete",
      incompleteRuns: 0,
      loopsTotal: 4,
      resolved: 2,
      unresolved: 1,
      inProgress: 1,
      byCause: { review: 2, check: 1, delivery: 1 },
      coldReplacements: 2,
      failedResumes: 1,
      measuredLoops: 2,
      unmeasuredLoops: 2,
      unfinishedLoops: 0,
      unmeasuredMembers: 3,
      medianMinutes: 14.5,
      p90Minutes: 32,
      medianTokens: 45200,
      medianUsd: 0.42,
    },
    loops: [
      {
        runId: "11111111-1111-4111-8111-111111111111",
        projectId: "proj-alpha",
        revision: 2,
        cause: "check",
        outcome: "resolved",
        rounds: 1,
        attempts: 3,
        coldReplacements: 1,
        failedResumes: 0,
        startedAt: "2026-11-25T10:00:00.000Z",
        finishedAt: "2026-11-25T10:14:30.000Z",
        durationMs: 870_000,
        failedCommit: "aaaa1111",
        passingCommit: "bbbb2222",
        measured: true,
        tokens: 45200,
        usd: 0.42,
      },
      {
        runId: "22222222-2222-4222-8222-222222222222",
        projectId: "proj-beta",
        revision: 1,
        cause: "review",
        outcome: "blocked",
        rounds: 2,
        attempts: 5,
        coldReplacements: 1,
        failedResumes: 1,
        startedAt: "2026-11-24T08:00:00.000Z",
        measured: false,
      },
    ],
    ...overrides,
  };
}

test("repairLoopsPath builds overview and project-scoped query URLs", () => {
  assert.equal(repairLoopsPath(), "/usage/repair-loops?days=30");
  assert.equal(repairLoopsPath({ days: 14 }), "/usage/repair-loops?days=14");
  assert.equal(
    repairLoopsPath({ projectId: "proj-alpha", days: 30 }),
    "/usage/repair-loops?project=proj-alpha&days=30",
  );
  assert.equal(
    repairLoopsPath({ projectId: "a/b", days: 7 }),
    "/usage/repair-loops?project=a%2Fb&days=7",
  );
});

test("unmeasured honesty invariant: null medians and unmeasured samples never coerce to 0 or $0", () => {
  assert.equal(formatRepairMinutes(null), "—");
  assert.equal(formatRepairDurationMs(undefined), "—");
  assert.equal(formatRepairDurationMs(-100), "—");
  assert.equal(formatRepairDurationMs(Number.NaN), "—");
  assert.equal(formatMedianTokens(null), "Unmeasured");
  assert.equal(formatMedianUsd(null), "Unmeasured");
  assert.equal(formatTokenCount(45200), "45.2K");
  assert.equal(formatTokenCount(125000), "125K");

  const unmeasuredSample = formatSampleCost({ measured: false, tokens: 0, usd: 0 });
  assert.equal(unmeasuredSample.measured, false);
  assert.equal(unmeasuredSample.label, "Unmeasured");
  assert.equal(unmeasuredSample.tokensText, "Unmeasured");
  assert.equal(unmeasuredSample.usdText, "Unmeasured");

  const missingFieldsSample = formatSampleCost({ measured: true, tokens: undefined, usd: undefined });
  assert.equal(missingFieldsSample.measured, false);
  assert.equal(missingFieldsSample.label, "Unmeasured");

  const nonFiniteSample = formatSampleCost({ measured: true, tokens: Number.NaN, usd: Number.POSITIVE_INFINITY });
  assert.equal(nonFiniteSample.measured, false);
  assert.equal(nonFiniteSample.label, "Unmeasured");

  const zeroMeasuredSample = formatSampleCost({ measured: true, tokens: 0, usd: 0 });
  assert.equal(zeroMeasuredSample.measured, true);
  assert.equal(zeroMeasuredSample.usdText, "$0.00");

  const vm = buildRepairMetricsViewModel(makeReport({
    totals: {
      runsExamined: 3,
      loopsTotal: 2,
      resolved: 0,
      unresolved: 2,
      inProgress: 0,
      byCause: { review: 1, check: 1, delivery: 0 },
      coldReplacements: 0,
      failedResumes: 0,
      measuredLoops: 0,
      unmeasuredLoops: 2,
      unmeasuredMembers: 4,
      medianMinutes: null,
      p90Minutes: null,
      medianTokens: null,
      medianUsd: null,
    },
  }));
  assert.equal(vm.latency.medianText, "—");
  assert.equal(vm.latency.p90Text, "—");
  assert.equal(vm.cost.medianTokensText, "Unmeasured");
  assert.equal(vm.cost.medianUsdText, "Unmeasured");
  assert.equal(vm.coverage.unmeasuredLoops, 2);
  assert.equal(vm.coverage.unmeasuredMembers, 4);
  assert.equal(vm.samples[1]!.cost.label, "Unmeasured");
  assert.equal(vm.samples[1]!.durationText, "—");
});

test("experiment gate thresholds evaluate 20-loop minimum and 80% coverage or 20 measured loops", () => {
  const empty = evaluateExperimentGate(makeReport({
    totals: {
      runsExamined: 0,
      loopsTotal: 0,
      resolved: 0,
      unresolved: 0,
      inProgress: 0,
      byCause: { review: 0, check: 0, delivery: 0 },
      coldReplacements: 0,
      failedResumes: 0,
      measuredLoops: 0,
      unmeasuredLoops: 0,
      unmeasuredMembers: 0,
      medianMinutes: null,
      p90Minutes: null,
      medianTokens: null,
      medianUsd: null,
    },
  }));
  assert.equal(empty.baselineGateMet, false);
  assert.equal(empty.statusLabel, "No baseline loops");

  const collecting = evaluateExperimentGate(makeReport());
  assert.equal(collecting.hasMinLoops, false);
  assert.equal(collecting.baselineGateMet, false);
  assert.equal(collecting.statusLabel, "Collecting baseline");
  assert.equal(collecting.coveragePercent, 50);

  const lowCoverage = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      loopsTotal: 24,
      measuredLoops: 15,
      unmeasuredLoops: 9,
    },
  }));
  assert.equal(lowCoverage.hasMinLoops, true);
  assert.equal(lowCoverage.hasMeasuredCoverage, false);
  assert.equal(lowCoverage.baselineGateMet, false);
  assert.equal(lowCoverage.statusLabel, "Coverage below threshold");

  const metByRatio = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      loopsTotal: 20,
      measuredLoops: 16,
      unmeasuredLoops: 4,
    },
  }));
  assert.equal(metByRatio.baselineGateMet, true);
  assert.equal(metByRatio.coveragePercent, 80);
  assert.equal(metByRatio.statusLabel, "Baseline sample met");

  const metByMeasuredCount = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      loopsTotal: 30,
      measuredLoops: 20,
      unmeasuredLoops: 10,
    },
  }));
  assert.equal(metByMeasuredCount.hasMeasuredCoverage, true);
  assert.equal(metByMeasuredCount.baselineGateMet, true);
});

test("buildRepairMetricsViewModel projects denominator counts, cause breakdown, and formatting", () => {
  const vm = buildRepairMetricsViewModel(makeReport());
  assert.equal(vm.loopsTotal, 4);
  assert.equal(vm.runsExamined, 12);
  assert.deepEqual(vm.outcomes, { resolved: 2, inProgress: 1, unresolved: 1, resolvedPercent: 50 });
  assert.deepEqual(vm.causes, [
    { cause: "review", label: "Review", count: 2 },
    { cause: "check", label: "Check", count: 1 },
    { cause: "delivery", label: "Delivery", count: 1 },
  ]);
  assert.deepEqual(vm.overhead, { coldReplacements: 2, failedResumes: 1 });
  assert.equal(vm.latency.medianText, "14.5 min");
  assert.equal(vm.latency.p90Text, "32.0 min");
  assert.equal(vm.cost.medianTokensText, "45.2K");
  assert.equal(vm.cost.medianUsdText, "$0.42");
  assert.equal(vm.samples[0]!.cost.label, "45.2K tok · $0.42");
  assert.equal(vm.samples[0]!.startedDate, "2026-11-25");
  assert.equal(vm.samples[0]!.failedCommitShort, "aaaa111");
  assert.equal(vm.samples[0]!.passingCommitShort, "bbbb222");

  const malformed = buildRepairMetricsViewModel(makeReport({
    loops: [
      {
        ...makeReport().loops[1]!,
        startedAt: "not-a-date",
        durationMs: -50,
      },
    ],
  }));
  assert.equal(malformed.samples[0]!.startedDate, "—");
  assert.equal(malformed.samples[0]!.durationText, "—");
});

test("classifyRepairLoopError separates 404/remote-403 unsupported, 503 unavailable ledger, and generic errors", () => {
  assert.deepEqual(classifyRepairLoopError({ status: 404 }), {
    kind: "unsupported",
    status: 404,
    message: "Repair-loop metrics are not available on this host.",
  });
  assert.deepEqual(classifyRepairLoopError({ status: 403, code: "remote-endpoint-denied" }), {
    kind: "unsupported",
    status: 403,
    message: "Repair-loop metrics are not available on this host.",
  });
  assert.deepEqual(classifyRepairLoopError({ status: 403, code: "forbidden" }), {
    kind: "failed",
    status: 403,
    message: "Repair-loop metrics could not be loaded.",
  });
  assert.deepEqual(classifyRepairLoopError({ status: 503 }), {
    kind: "unavailable",
    status: 503,
    message: "Repair-loop metrics are unavailable because the usage ledger cannot be read.",
  });
  assert.deepEqual(classifyRepairLoopError(new Error("network failed")), {
    kind: "failed",
    message: "Repair-loop metrics could not be loaded.",
  });
});

test("formatSampleCost distinguishes unfinished loops from unmeasured finished loops", () => {
  const inProgress = formatSampleCost({ measured: false, unfinished: true, outcome: "in-progress" });
  assert.equal(inProgress.measured, false);
  assert.equal(inProgress.unfinished, true);
  assert.equal(inProgress.label, "In progress");
  assert.equal(inProgress.tokensText, "In progress");
  assert.equal(inProgress.usdText, "In progress");

  const unfinishedSuperseded = formatSampleCost({ measured: false, unfinished: true, outcome: "superseded" });
  assert.equal(unfinishedSuperseded.measured, false);
  assert.equal(unfinishedSuperseded.unfinished, true);
  assert.equal(unfinishedSuperseded.label, "Unfinished");

  const unmeasured = formatSampleCost({ measured: false, outcome: "blocked" });
  assert.equal(unmeasured.measured, false);
  assert.equal(unmeasured.unfinished, false);
  assert.equal(unmeasured.label, "Unmeasured");
});

test("buildRepairMetricsViewModel projects incompleteRuns, unfinishedLoops, notices, and older-host defaults", () => {
  const withGaps = buildRepairMetricsViewModel(makeReport({
    totals: {
      ...makeReport().totals,
      runsExamined: 5,
      eventCoverage: "incomplete",
      incompleteRuns: 2,
      loopsTotal: 3,
      measuredLoops: 1,
      unmeasuredLoops: 0,
      unfinishedLoops: 2,
      unmeasuredMembers: 0,
    },
    loops: [
      {
        ...makeReport().loops[1]!,
        outcome: "in-progress",
        measured: false,
        unfinished: true,
      },
      {
        ...makeReport().loops[1]!,
        outcome: "superseded",
        measured: false,
        unfinished: true,
      },
    ],
  }));
  assert.equal(withGaps.eventCoverage, "incomplete");
  assert.equal(withGaps.incompleteRuns, 2);
  assert.equal(
    withGaps.incompleteCoverageNotice,
    "Event coverage is incomplete for 2 of 5 examined runs; loop counts may undercount actual repairs.",
  );
  assert.equal(withGaps.unfinishedLoops, 2);
  assert.equal(withGaps.coverage.unfinishedLoops, 2);
  assert.equal(
    withGaps.unfinishedLoopsNotice,
    "2 of 3 loops are unfinished and excluded from token/USD medians until final session usage settles.",
  );
  assert.equal(
    withGaps.emptyLoopsMessage,
    "No repair loops reconstructed from complete ledger events in this window.",
  );
  assert.equal(withGaps.samples[0]!.cost.label, "In progress");
  assert.equal(withGaps.samples[0]!.cost.unfinished, true);
  assert.equal(withGaps.samples[1]!.cost.label, "Unfinished");
  assert.equal(withGaps.samples[1]!.cost.unfinished, true);

  const legacyTotals = { ...makeReport().totals };
  delete legacyTotals.eventCoverage;
  delete legacyTotals.incompleteRuns;
  delete legacyTotals.unfinishedLoops;
  const legacy = buildRepairMetricsViewModel(makeReport({ totals: legacyTotals, loops: [] }));
  assert.equal(legacy.eventCoverage, "complete");
  assert.equal(legacy.incompleteRuns, 0);
  assert.equal(legacy.incompleteCoverageNotice, null);
  assert.equal(legacy.unfinishedLoops, 0);
  assert.equal(legacy.unfinishedLoopsNotice, null);
  assert.equal(legacy.emptyLoopsMessage, "No repair loops recorded in this window.");

  const gateWithIncompleteAndUnfinished = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      runsExamined: 30,
      eventCoverage: "incomplete",
      incompleteRuns: 2,
      loopsTotal: 22,
      measuredLoops: 20,
      unmeasuredLoops: 0,
      unfinishedLoops: 2,
    },
  }));
  assert.equal(gateWithIncompleteAndUnfinished.hasCompleteCoverage, false);
  assert.equal(gateWithIncompleteAndUnfinished.baselineGateMet, false);
  assert.equal(gateWithIncompleteAndUnfinished.statusLabel, "Incomplete event coverage");
  assert.equal(gateWithIncompleteAndUnfinished.unfinishedLoops, 2);
  assert.match(gateWithIncompleteAndUnfinished.detailText, /2 of 30 examined runs/);
  assert.match(gateWithIncompleteAndUnfinished.detailText, /22 of 20 minimum repair loops observed/);
  assert.match(gateWithIncompleteAndUnfinished.detailText, /2 unfinished/);
  assert.match(gateWithIncompleteAndUnfinished.detailText, /loop counts may undercount actual repairs/);

  const gateWithIncompleteFlagOnly = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      eventCoverage: "incomplete",
      incompleteRuns: 0,
      loopsTotal: 25,
      measuredLoops: 25,
      unmeasuredLoops: 0,
      unfinishedLoops: 0,
    },
  }));
  assert.equal(gateWithIncompleteFlagOnly.hasCompleteCoverage, false);
  assert.equal(gateWithIncompleteFlagOnly.baselineGateMet, false);
  assert.equal(gateWithIncompleteFlagOnly.statusLabel, "Incomplete event coverage");
  assert.match(gateWithIncompleteFlagOnly.detailText, /Event coverage is incomplete for examined runs/);

  const gateZeroLoopsIncomplete = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      runsExamined: 4,
      eventCoverage: "incomplete",
      incompleteRuns: 3,
      loopsTotal: 0,
      measuredLoops: 0,
      unmeasuredLoops: 0,
      unfinishedLoops: 0,
    },
  }));
  assert.equal(gateZeroLoopsIncomplete.hasCompleteCoverage, false);
  assert.equal(gateZeroLoopsIncomplete.baselineGateMet, false);
  assert.equal(gateZeroLoopsIncomplete.statusLabel, "Incomplete event coverage");
  assert.match(gateZeroLoopsIncomplete.detailText, /3 of 4 examined runs/);

  const gateCollectingWithUnfinished = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      loopsTotal: 5,
      measuredLoops: 3,
      unmeasuredLoops: 1,
      unfinishedLoops: 1,
    },
  }));
  assert.equal(gateCollectingWithUnfinished.statusLabel, "Collecting baseline");
  assert.match(gateCollectingWithUnfinished.detailText, /1 unfinished/);

  const gateLowCoverageWithUnfinished = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      loopsTotal: 24,
      measuredLoops: 15,
      unmeasuredLoops: 6,
      unfinishedLoops: 3,
    },
  }));
  assert.equal(gateLowCoverageWithUnfinished.statusLabel, "Coverage below threshold");
  assert.match(gateLowCoverageWithUnfinished.detailText, /3 unfinished/);

  const gateMetWithUnfinished = evaluateExperimentGate(makeReport({
    totals: {
      ...makeReport().totals,
      loopsTotal: 20,
      measuredLoops: 16,
      unmeasuredLoops: 2,
      unfinishedLoops: 2,
    },
  }));
  assert.equal(gateMetWithUnfinished.hasCompleteCoverage, true);
  assert.equal(gateMetWithUnfinished.baselineGateMet, true);
  assert.equal(gateMetWithUnfinished.statusLabel, "Baseline sample met");
  assert.match(gateMetWithUnfinished.detailText, /2 unfinished/);
});
