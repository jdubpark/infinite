import type { InterruptedTaskReport } from "./interrupted-task-metrics.js";
import type { RepairLoopReport, RepairLoopSample } from "./repair-metrics.js";
import { formatUsd } from "./usage.js";

type Options = Record<string, string | boolean>;
export type RepairMetricsApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };

const PROJECT_ID = /^[a-z0-9-]{1,80}$/;
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const formatMinutes = (value: number | null) => value === null ? "unknown" : `${value.toFixed(1)} min`;
const formatDuration = (durationMs: number | undefined) => durationMs === undefined ? "—" : `${(durationMs / 60_000).toFixed(1)}m`;

function httpStatusOf(error: unknown): number | undefined {
  return error instanceof Error && "status" in error && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : undefined;
}

function buildMetricsParams(positional: string[], options: Options, usageMessage: string): URLSearchParams {
  if (positional.length > 0) throw new Error(usageMessage);
  const params = new URLSearchParams();
  if (options["--project"] !== undefined) {
    const project = String(options["--project"]);
    if (!PROJECT_ID.test(project)) throw new Error("Project ID must match /^[a-z0-9-]{1,80}$/.");
    params.set("project", project);
  }
  if (options["--days"] !== undefined) {
    const raw = String(options["--days"]);
    const days = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(days) || days < 1 || days > 366) {
      throw new Error("--days must be an integer between 1 and 366.");
    }
    params.set("days", String(days));
  }
  return params;
}

function sampleCost(loop: RepairLoopSample): string {
  if (!loop.measured || loop.tokens === undefined || loop.usd === undefined) return "unmeasured";
  return `${loop.tokens} tok / $${formatUsd(loop.usd)}`;
}

export function formatRepairLoopReport(report: RepairLoopReport): string[] {
  const { totals } = report;
  const header = `Repair loops · last ${report.windowDays}d${report.projectId ? ` · project ${clean(report.projectId)}` : ""}`;
  const lines = [
    header,
    `Runs examined ${totals.runsExamined} · loops ${totals.loopsTotal} (resolved ${totals.resolved}, unresolved ${totals.unresolved}, in-progress ${totals.inProgress})`,
    `Causes: review ${totals.byCause.review}, check ${totals.byCause.check}, delivery ${totals.byCause.delivery}`,
    `Denominator overhead: cold replacements ${totals.coldReplacements}, failed resumes ${totals.failedResumes}`,
    `Duration (resolved): median ${formatMinutes(totals.medianMinutes)} · p90 ${formatMinutes(totals.p90Minutes)}`,
    `Measured cost: median ${totals.medianTokens === null ? "unknown" : `${totals.medianTokens} tokens`} · ${totals.medianUsd === null ? "unknown" : `$${formatUsd(totals.medianUsd)}`} (${totals.measuredLoops} measured loops, ${totals.unmeasuredLoops} unmeasured loops, ${totals.unmeasuredMembers} unmeasured members — unmeasured omitted, never zero)`,
  ];
  if (!report.loops.length) {
    lines.push("No repair loops recorded in this window.");
    return lines;
  }
  if (totals.unmeasuredLoops > 0) {
    lines.push(`Warning: ${totals.unmeasuredLoops} of ${totals.loopsTotal} loops have unmeasured member usage and are excluded from token/USD medians.`);
  }
  lines.push("", `Recent loops (${report.loops.length} of ${totals.loopsTotal}):`);
  lines.push("RUN         PROJECT               REV  CAUSE     OUTCOME      ROUNDS  ATTEMPTS  COLD  RESUME  DUR    COST");
  for (const loop of report.loops) {
    const runCol = clean(loop.runId.slice(0, 10)).padEnd(10);
    const projectCol = clean(loop.projectId.slice(0, 20)).padEnd(20);
    const revCol = `r${loop.revision}`.padEnd(3);
    const causeCol = clean(loop.cause).padEnd(8);
    const outcomeCol = clean(loop.outcome).padEnd(11);
    const roundsCol = String(loop.rounds).padStart(6);
    const attemptsCol = String(loop.attempts).padStart(8);
    const coldCol = String(loop.coldReplacements).padStart(4);
    const resumeCol = String(loop.failedResumes).padStart(6);
    const durCol = formatDuration(loop.durationMs).padStart(5);
    lines.push(`${runCol}  ${projectCol}  ${revCol}  ${causeCol}  ${outcomeCol}  ${roundsCol}  ${attemptsCol}  ${coldCol}  ${resumeCol}  ${durCol}  ${sampleCost(loop)}`);
  }
  return lines;
}

export function formatInterruptedTaskReport(report: InterruptedTaskReport): string[] {
  const header = `Interrupted tasks · last ${report.windowDays}d${report.projectId ? ` · project ${clean(report.projectId)}` : ""}`;
  const lines = [
    header,
    `Counted ${report.interruptedTasksTotal} interrupted tasks (trigger threshold ${report.triggerThreshold}: ${report.triggerMet ? "MET" : "not met"})`,
    `Sources: agent-question ${report.bySourceCode["agent-question"]}, agent-blocked ${report.bySourceCode["agent-blocked"]}`,
    `Events: ${report.recoveriesCounted} recoveries counted (${report.unknownRecoveries} unknown) · ${report.blocksCounted} blocks counted (${report.unknownBlocks} unknown)`,
  ];
  const totalUnknown = report.unknownRecoveries + report.unknownBlocks;
  if (totalUnknown > 0) {
    lines.push(`Warning: ${totalUnknown} recovery/block events lacked attribution and are reported as unknown, never zero.`);
  }
  if (!report.samples.length) {
    lines.push("No qualifying automatic recoveries or blocked runs recorded in this window.");
    return lines;
  }
  lines.push("", `Recent events (${report.samples.length}):`);
  lines.push("RUN         PROJECT               KIND      REV  CODE            TASK          COUNT  AT");
  for (const sample of report.samples) {
    const runCol = clean(sample.runId.slice(0, 10)).padEnd(10);
    const projectCol = clean(sample.projectId.slice(0, 20)).padEnd(20);
    const kindCol = clean(sample.kind).padEnd(8);
    const revCol = `r${sample.revision}`.padEnd(3);
    const codeCol = clean(sample.sourceCode).padEnd(14);
    const taskCol = clean((sample.sourceTaskId ?? "—").slice(0, 10)).padEnd(10);
    const countCol = (sample.unknown ? "unknown" : String(sample.interruptedCount)).padStart(7);
    const note = sample.unknown && sample.unknownReason ? `  (${clean(sample.unknownReason)})` : "";
    lines.push(`${runCol}  ${projectCol}  ${kindCol}  ${revCol}  ${codeCol}  ${taskCol}  ${countCol}  ${clean(sample.at)}${note}`);
  }
  return lines;
}

export async function handleUsageRepairsCommand(positional: string[], options: Options, api: RepairMetricsApi): Promise<boolean> {
  const params = buildMetricsParams(positional, options, "Usage: infinite usage repairs [--project ID] [--days N] [--json]");
  let report: RepairLoopReport;
  try {
    report = await api.json<RepairLoopReport>(`/usage/repair-loops${params.size ? `?${params}` : ""}`);
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 503) throw new Error("The usage ledger is unavailable.");
    if (status === 400) throw new Error("The host refused the repair-loop query. Check --project and --days.");
    throw error;
  }
  if (options["--json"]) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatRepairLoopReport(report)) console.log(line);
  return true;
}

export async function handleUsageInterruptedCommand(positional: string[], options: Options, api: RepairMetricsApi): Promise<boolean> {
  const params = buildMetricsParams(positional, options, "Usage: infinite usage interrupted [--project ID] [--days N] [--json]");
  let report: InterruptedTaskReport;
  try {
    report = await api.json<InterruptedTaskReport>(`/usage/interrupted-tasks${params.size ? `?${params}` : ""}`);
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 503) throw new Error("The evidence store is unavailable.");
    if (status === 400) throw new Error("The host refused the interrupted-task query. Check --project and --days.");
    throw error;
  }
  if (options["--json"]) console.log(JSON.stringify(report, null, 2));
  else for (const line of formatInterruptedTaskReport(report)) console.log(line);
  return true;
}
