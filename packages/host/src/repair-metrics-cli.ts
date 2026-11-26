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

function sampleCost(loop: RepairLoopSample): string {
  if (loop.measured && loop.tokens !== undefined && loop.usd !== undefined) return `${loop.tokens} tok / $${formatUsd(loop.usd)}`;
  if (loop.unfinished) return loop.outcome === "in-progress" ? "in-progress" : "unfinished";
  return "unmeasured";
}

export function formatRepairLoopReport(report: RepairLoopReport): string[] {
  const { totals } = report;
  const header = `Repair loops · last ${report.windowDays}d${report.projectId ? ` · project ${clean(report.projectId)}` : ""}`;
  const unfinishedPart = totals.unfinishedLoops > 0 ? `, ${totals.unfinishedLoops} unfinished loops` : "";
  const lines = [
    header,
    `Runs examined ${totals.runsExamined} · loops ${totals.loopsTotal} (resolved ${totals.resolved}, unresolved ${totals.unresolved}, in-progress ${totals.inProgress})`,
    `Causes: review ${totals.byCause.review}, check ${totals.byCause.check}, delivery ${totals.byCause.delivery}`,
    `Denominator overhead: cold replacements ${totals.coldReplacements}, failed resumes ${totals.failedResumes}`,
    `Duration (resolved): median ${formatMinutes(totals.medianMinutes)} · p90 ${formatMinutes(totals.p90Minutes)}`,
    `Measured cost: median ${totals.medianTokens === null ? "unknown" : `${totals.medianTokens} tokens`} · ${totals.medianUsd === null ? "unknown" : `$${formatUsd(totals.medianUsd)}`} (${totals.measuredLoops} measured loops, ${totals.unmeasuredLoops} unmeasured loops${unfinishedPart}, ${totals.unmeasuredMembers} unmeasured members — unmeasured omitted, never zero)`,
  ];
  if (totals.incompleteRuns > 0) {
    lines.push(`Warning: event coverage is incomplete for ${totals.incompleteRuns} of ${totals.runsExamined} examined runs (ledger gap or missing repair/review events); loop counts may undercount actual repairs.`);
  }
  if (!report.loops.length) {
    lines.push(totals.incompleteRuns > 0
      ? "No repair loops reconstructed from complete ledger events in this window."
      : "No repair loops recorded in this window.");
    return lines;
  }
  if (totals.unmeasuredLoops > 0) {
    lines.push(`Warning: ${totals.unmeasuredLoops} of ${totals.loopsTotal} loops have unmeasured member usage and are excluded from token/USD medians.`);
  }
  if (totals.unfinishedLoops > 0) {
    lines.push(`Note: ${totals.unfinishedLoops} of ${totals.loopsTotal} loops are still unfinished (in-progress or active members) and are excluded from final token/USD medians.`);
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

export async function handleUsageRepairsCommand(positional: string[], options: Options, api: RepairMetricsApi): Promise<boolean> {
  if (positional.length > 0) throw new Error("Usage: infinite usage repairs [--project ID] [--days N] [--json]");
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
