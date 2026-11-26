import type { RepairEventCoverage, RepairLoopCause, RepairLoopOutcome, RepairLoopReport, RepairLoopSample } from "./api";

export const DEFAULT_REPAIR_WINDOW_DAYS = 30;
export const EXPERIMENT_MIN_LOOPS = 20;
export const EXPERIMENT_MIN_COVERAGE = 0.8;

export type RepairLoopErrorKind = "unsupported" | "unavailable" | "failed";

export type RepairLoopLoadError = {
  kind: RepairLoopErrorKind;
  status?: number;
  message: string;
};

export type RepairExperimentGate = {
  loopsTotal: number;
  minLoops: number;
  measuredLoops: number;
  unmeasuredLoops: number;
  unfinishedLoops: number;
  unmeasuredMembers: number;
  coverageRatio: number | null;
  coveragePercent: number | null;
  hasMinLoops: boolean;
  hasMeasuredCoverage: boolean;
  hasCompleteCoverage: boolean;
  baselineGateMet: boolean;
  statusLabel: string;
  detailText: string;
};

export type RepairSampleCostView = {
  measured: boolean;
  unfinished: boolean;
  label: string;
  tokensText: string;
  usdText: string;
};

export type RepairLoopSampleView = {
  key: string;
  runId: string;
  shortRunId: string;
  projectId: string;
  revision: number;
  cause: RepairLoopCause;
  causeLabel: string;
  outcome: RepairLoopOutcome;
  outcomeLabel: string;
  outcomeTone: "resolved" | "active" | "unresolved";
  rounds: number;
  attempts: number;
  coldReplacements: number;
  failedResumes: number;
  startedAt: string;
  startedDate: string;
  durationText: string;
  failedCommitShort?: string;
  passingCommitShort?: string;
  cost: RepairSampleCostView;
};

export type RepairMetricsViewModel = {
  windowDays: number;
  projectId?: string;
  runsExamined: number;
  loopsTotal: number;
  eventCoverage: RepairEventCoverage;
  incompleteRuns: number;
  incompleteCoverageNotice: string | null;
  unfinishedLoops: number;
  unfinishedLoopsNotice: string | null;
  emptyLoopsMessage: string;
  outcomes: {
    resolved: number;
    inProgress: number;
    unresolved: number;
    resolvedPercent: number | null;
  };
  causes: {
    cause: RepairLoopCause;
    label: string;
    count: number;
  }[];
  overhead: {
    coldReplacements: number;
    failedResumes: number;
  };
  coverage: {
    measuredLoops: number;
    unmeasuredLoops: number;
    unfinishedLoops: number;
    unmeasuredMembers: number;
    coveragePercent: number | null;
  };
  latency: {
    medianText: string;
    p90Text: string;
    hasResolvedLatency: boolean;
  };
  cost: {
    medianTokensText: string;
    medianUsdText: string;
    hasMeasuredCost: boolean;
  };
  gate: RepairExperimentGate;
  samples: RepairLoopSampleView[];
};

const CAUSE_LABELS: Record<RepairLoopCause, string> = {
  review: "Review",
  check: "Check",
  delivery: "Delivery",
};

const OUTCOME_LABELS: Record<RepairLoopOutcome, string> = {
  resolved: "Resolved",
  "in-progress": "In progress",
  blocked: "Blocked",
  cancelled: "Cancelled",
  superseded: "Superseded",
  unresolved: "Unresolved",
};

export function repairLoopsPath(options?: { projectId?: string; days?: number }): string {
  const days = options?.days ?? DEFAULT_REPAIR_WINDOW_DAYS;
  const params = new URLSearchParams();
  if (options?.projectId) params.set("project", options.projectId);
  params.set("days", String(days));
  return `/usage/repair-loops?${params.toString()}`;
}

export function classifyRepairLoopError(error: unknown): RepairLoopLoadError {
  const status = typeof error === "object" && error !== null && "status" in error && typeof (error as { status: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
  const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
  if (status === 404 || (status === 403 && code === "remote-endpoint-denied")) {
    return {
      kind: "unsupported",
      status,
      message: "Repair-loop metrics are not available on this host.",
    };
  }
  if (status === 503) {
    return {
      kind: "unavailable",
      status: 503,
      message: "Repair-loop metrics are unavailable because the usage ledger cannot be read.",
    };
  }
  return {
    kind: "failed",
    ...(status !== undefined ? { status } : {}),
    message: "Repair-loop metrics could not be loaded.",
  };
}

export function formatRepairMinutes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 90) return `${(value / 60).toFixed(1)} h`;
  return `${value.toFixed(1)} min`;
}

export function formatRepairDurationMs(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  return formatRepairMinutes(durationMs / 60_000);
}

export function formatRepairDate(iso: string | undefined): string {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return "—";
  return iso.slice(0, 10);
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "Unmeasured";
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

export function formatUsdAmount(value: number): string {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs >= 1000 ? 0 : abs >= 0.01 ? 2 : 4;
  const figure = abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${sign}$${figure}`;
}

export function formatMedianTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unmeasured";
  return formatTokenCount(value);
}

export function formatMedianUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unmeasured";
  return formatUsdAmount(value);
}

export function formatSampleCost(
  sample: Pick<RepairLoopSample, "measured" | "tokens" | "usd"> & Partial<Pick<RepairLoopSample, "unfinished" | "outcome">>,
): RepairSampleCostView {
  if (
    sample.measured
    && sample.tokens !== undefined
    && sample.usd !== undefined
    && Number.isFinite(sample.tokens)
    && Number.isFinite(sample.usd)
  ) {
    const tokensText = `${formatTokenCount(sample.tokens)} tok`;
    const usdText = formatUsdAmount(sample.usd);
    return {
      measured: true,
      unfinished: false,
      label: `${tokensText} · ${usdText}`,
      tokensText,
      usdText,
    };
  }
  if (sample.unfinished) {
    const label = sample.outcome === "in-progress" ? "In progress" : "Unfinished";
    return {
      measured: false,
      unfinished: true,
      label,
      tokensText: label,
      usdText: label,
    };
  }
  return {
    measured: false,
    unfinished: false,
    label: "Unmeasured",
    tokensText: "Unmeasured",
    usdText: "Unmeasured",
  };
}

export function evaluateExperimentGate(report: Pick<RepairLoopReport, "windowDays" | "totals">): RepairExperimentGate {
  const { totals, windowDays } = report;
  const incompleteRuns = totals.incompleteRuns ?? 0;
  const unfinishedLoops = totals.unfinishedLoops ?? 0;
  const eventCoverage: RepairEventCoverage = totals.eventCoverage ?? (incompleteRuns > 0 ? "incomplete" : "complete");
  const hasCompleteCoverage = eventCoverage === "complete" && incompleteRuns === 0;
  const coverageRatio = totals.loopsTotal > 0 ? totals.measuredLoops / totals.loopsTotal : null;
  const coveragePercent = coverageRatio === null ? null : Math.round(coverageRatio * 100);
  const hasMinLoops = totals.loopsTotal >= EXPERIMENT_MIN_LOOPS;
  const hasMeasuredCoverage = totals.loopsTotal > 0 && (
    (totals.measuredLoops / totals.loopsTotal) >= EXPERIMENT_MIN_COVERAGE || totals.measuredLoops >= EXPERIMENT_MIN_LOOPS
  );
  const baselineGateMet = hasCompleteCoverage && hasMinLoops && hasMeasuredCoverage;
  const coverageSuffix = coveragePercent !== null ? `, ${coveragePercent}% coverage` : "";
  const unfinishedSuffix = unfinishedLoops > 0 ? `, ${unfinishedLoops} unfinished` : "";

  let statusLabel: string;
  let detailText: string;

  if (!hasCompleteCoverage) {
    statusLabel = "Incomplete event coverage";
    const gapPrefix = incompleteRuns > 0
      ? `Event coverage is incomplete for ${incompleteRuns} of ${totals.runsExamined} examined ${totals.runsExamined === 1 ? "run" : "runs"}`
      : "Event coverage is incomplete for examined runs";
    detailText = `${gapPrefix}; ${totals.loopsTotal} of ${EXPERIMENT_MIN_LOOPS} minimum repair loops observed (${totals.measuredLoops} measured${coverageSuffix}${unfinishedSuffix}); loop counts may undercount actual repairs.`;
  } else if (totals.loopsTotal === 0) {
    statusLabel = "No baseline loops";
    detailText = `0 of ${EXPERIMENT_MIN_LOOPS} minimum repair loops observed in the ${windowDays}-day window.`;
  } else if (baselineGateMet) {
    statusLabel = "Baseline sample met";
    detailText = `${totals.loopsTotal} repair loops observed (${totals.measuredLoops} measured${coverageSuffix}; ${totals.unmeasuredLoops} unmeasured${unfinishedSuffix}).`;
  } else if (!hasMinLoops) {
    statusLabel = "Collecting baseline";
    detailText = `${totals.loopsTotal} of ${EXPERIMENT_MIN_LOOPS} minimum repair loops observed (${totals.measuredLoops} measured${coverageSuffix}${unfinishedSuffix}).`;
  } else {
    statusLabel = "Coverage below threshold";
    detailText = `${totals.loopsTotal} repair loops observed with ${totals.measuredLoops} measured (${coveragePercent}% coverage${unfinishedSuffix}; threshold is >= 80% coverage or ${EXPERIMENT_MIN_LOOPS} measured loops).`;
  }

  return {
    loopsTotal: totals.loopsTotal,
    minLoops: EXPERIMENT_MIN_LOOPS,
    measuredLoops: totals.measuredLoops,
    unmeasuredLoops: totals.unmeasuredLoops,
    unfinishedLoops,
    unmeasuredMembers: totals.unmeasuredMembers,
    coverageRatio,
    coveragePercent,
    hasMinLoops,
    hasMeasuredCoverage,
    hasCompleteCoverage,
    baselineGateMet,
    statusLabel,
    detailText,
  };
}

function outcomeTone(outcome: RepairLoopOutcome): "resolved" | "active" | "unresolved" {
  if (outcome === "resolved") return "resolved";
  if (outcome === "in-progress") return "active";
  return "unresolved";
}

export function buildRepairMetricsViewModel(report: RepairLoopReport): RepairMetricsViewModel {
  const { totals } = report;
  const incompleteRuns = totals.incompleteRuns ?? 0;
  const unfinishedLoops = totals.unfinishedLoops ?? 0;
  const eventCoverage: RepairEventCoverage = totals.eventCoverage ?? (incompleteRuns > 0 ? "incomplete" : "complete");
  const incompleteCoverageNotice = incompleteRuns > 0
    ? `Event coverage is incomplete for ${incompleteRuns} of ${totals.runsExamined} examined ${totals.runsExamined === 1 ? "run" : "runs"}; loop counts may undercount actual repairs.`
    : eventCoverage === "incomplete"
      ? "Event coverage is incomplete for examined runs; loop counts may undercount actual repairs."
      : null;
  const unfinishedLoopsNotice = unfinishedLoops > 0
    ? `${unfinishedLoops} of ${totals.loopsTotal} ${totals.loopsTotal === 1 ? "loop" : "loops"} ${unfinishedLoops === 1 ? "is" : "are"} unfinished and excluded from token/USD medians until final session usage settles.`
    : null;
  const emptyLoopsMessage = incompleteRuns > 0 || eventCoverage === "incomplete"
    ? "No repair loops reconstructed from complete ledger events in this window."
    : "No repair loops recorded in this window.";
  const coveragePercent = totals.loopsTotal > 0 ? Math.round((totals.measuredLoops / totals.loopsTotal) * 100) : null;
  const resolvedPercent = totals.loopsTotal > 0 ? Math.round((totals.resolved / totals.loopsTotal) * 100) : null;

  return {
    windowDays: report.windowDays,
    ...(report.projectId ? { projectId: report.projectId } : {}),
    runsExamined: totals.runsExamined,
    loopsTotal: totals.loopsTotal,
    eventCoverage,
    incompleteRuns,
    incompleteCoverageNotice,
    unfinishedLoops,
    unfinishedLoopsNotice,
    emptyLoopsMessage,
    outcomes: {
      resolved: totals.resolved,
      inProgress: totals.inProgress,
      unresolved: totals.unresolved,
      resolvedPercent,
    },
    causes: (["review", "check", "delivery"] as const).map(cause => ({
      cause,
      label: CAUSE_LABELS[cause],
      count: totals.byCause[cause] ?? 0,
    })),
    overhead: {
      coldReplacements: totals.coldReplacements,
      failedResumes: totals.failedResumes,
    },
    coverage: {
      measuredLoops: totals.measuredLoops,
      unmeasuredLoops: totals.unmeasuredLoops,
      unfinishedLoops,
      unmeasuredMembers: totals.unmeasuredMembers,
      coveragePercent,
    },
    latency: {
      medianText: formatRepairMinutes(totals.medianMinutes),
      p90Text: formatRepairMinutes(totals.p90Minutes),
      hasResolvedLatency: totals.medianMinutes !== null,
    },
    cost: {
      medianTokensText: formatMedianTokens(totals.medianTokens),
      medianUsdText: formatMedianUsd(totals.medianUsd),
      hasMeasuredCost: totals.medianTokens !== null && totals.medianUsd !== null,
    },
    gate: evaluateExperimentGate(report),
    samples: report.loops.map((loop, index) => ({
      key: `${loop.runId}:${loop.revision}:${loop.startedAt}:${index}`,
      runId: loop.runId,
      shortRunId: loop.runId.slice(0, 8),
      projectId: loop.projectId,
      revision: loop.revision,
      cause: loop.cause,
      causeLabel: CAUSE_LABELS[loop.cause],
      outcome: loop.outcome,
      outcomeLabel: OUTCOME_LABELS[loop.outcome],
      outcomeTone: outcomeTone(loop.outcome),
      rounds: loop.rounds,
      attempts: loop.attempts,
      coldReplacements: loop.coldReplacements,
      failedResumes: loop.failedResumes,
      startedAt: loop.startedAt,
      startedDate: formatRepairDate(loop.startedAt),
      durationText: formatRepairDurationMs(loop.durationMs),
      ...(loop.failedCommit ? { failedCommitShort: loop.failedCommit.slice(0, 7) } : {}),
      ...(loop.passingCommit ? { passingCommitShort: loop.passingCommit.slice(0, 7) } : {}),
      cost: formatSampleCost(loop),
    })),
  };
}
