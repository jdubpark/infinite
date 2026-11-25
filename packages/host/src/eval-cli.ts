import { closeSync, openSync, readSync } from "node:fs";
import {
  EVAL_STATES,
  type BaselineJobView,
  type ComparisonJobView,
  type ComparisonReport,
  type EvalJobView,
  type EvalState,
  type EvalSummary,
  type PairResult,
  type ReplayPrior,
} from "./eval-types.js";

type Options = Record<string, string | boolean>;
export { handleDuelClientCommand } from "./duel-cli.js";
export type EvalApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };

const USAGE = "Usage: infinite eval status PROJECT [--json] | infinite eval run PROJECT --file job.json --request-id UUID [--json] | infinite eval job JOB [--json] | infinite eval pause|resume|cancel JOB | infinite eval retire TASK | infinite eval report JOB [--json] | infinite eval priors PROJECT [--json]";
const JOB_FILE_LIMIT = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = new Map([
  ["unknown-project", "No project has this ID."],
  ["unknown-job", "No job has this ID."],
  ["unknown-task", "No task has this ID."],
]);
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const count = (value: number | null | undefined) => value === null || value === undefined ? "unknown" : String(value);
const stateCounts = (byState: Record<EvalState, number>) => EVAL_STATES.map(state => `${state} ${count(byState[state])}`).join(" · ");

function baselineCountLine(job: BaselineJobView): string {
  const { tasks, trials } = job;
  return `tasks ${count(tasks.reached)} of ${count(tasks.planned)} (skipped ${count(tasks.skipped)}) · trials started ${count(trials.started)} of ${count(trials.planned)}, graded ${count(trials.graded)}, resolved ${count(trials.resolved)}, ended ${count(trials.ended)}, void ${count(trials.void)}`;
}

const fixed = (value: number | null | undefined, digits: number) => typeof value === "number" ? value.toFixed(digits) : "unknown";
const signed = (value: number | null | undefined, digits: number) =>
  typeof value === "number" ? `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(digits)}` : "unknown";
const intervalText = (interval: [number, number] | null) =>
  interval === null ? "unknown" : `[${signed(interval[0], 3)}, ${signed(interval[1], 3)}]`;

function comparisonCountLine(job: ComparisonJobView): string {
  const { tasks, trials } = job;
  const resolved = job.report === "ready" ? count(trials.resolved) : "hidden";
  const report = job.report === null || job.report === undefined ? "" : ` · report ${clean(job.report)}`;
  return `tasks ${count(tasks.reached)} of ${count(tasks.planned)} (skipped ${count(tasks.skipped)}) · trials started ${count(trials.started)} of ${count(trials.planned)}, graded ${count(trials.graded)}, resolved ${resolved}, ended ${count(trials.ended)}, void ${count(trials.void)}, reused ${count(trials.reused)}${report}`;
}

export function evalJobLines(job: EvalJobView): string[] {
  const reason = job.reason ? ` · ${clean(job.reason)}` : "";
  const waiting = job.waiting ? ` · waiting ${clean(job.waiting)}` : "";
  const header = `job ${clean(job.jobId)} ${clean(job.status)}${reason}${waiting}`;
  if (job.kind === "baseline") return [header, baselineCountLine(job)];
  if (job.kind === "compare" || job.kind === "confirm") return [header, comparisonCountLine(job)];
  if (job.kind !== "validate") return [header];
  const { counts } = job;
  return [
    header,
    `visited ${count(counts.visited)}, valid ${count(counts.valid)}, rejected ${count(counts.rejected)}, retired ${count(counts.retired)}, undecided ${count(counts.undecided)}`,
  ];
}

const graderLine = (grader: EvalSummary["grader"]) =>
  grader.state === "ready" && typeof grader.version === "number" && grader.version < 2
    ? "grader ready (version 1: no trials)"
    : `grader ${clean(grader.state)}`;

function identityLine(identity: EvalSummary["evalIdentity"]): string {
  const state = `eval identity ${clean(identity.state)}`;
  if (identity.state !== "unavailable") return state;
  if (identity.lastProbe === undefined) return state;
  if (identity.lastProbe === null) return `${state} (not probed)`;
  return `${state} (last probe ${clean(identity.lastProbe.state)}, ${clean(identity.lastProbe.at)})`;
}

export function evalStatusLines(summary: EvalSummary): string[] {
  const mining = summary.mining;
  const lines = [
    clean(summary.projectId),
    `capture ${summary.capture.on ? "on" : "off"} · mining ${clean(mining.state)} (visited ${count(mining.visited)}, mined ${count(mining.mined)}, skipped ${count(mining.skipped)}, failures ${count(mining.failures)})`,
    `states: ${stateCounts(summary.tasks.byState)}`,
    `mined: ${stateCounts(summary.tasks.byOrigin.mined)}`,
    ...(summary.tasks.bySet ? [`sets dev ${count(summary.tasks.bySet.dev)} · holdout ${count(summary.tasks.bySet.holdout)}`] : []),
    `groups ${count(summary.groups.total)} (dev-only ${count(summary.groups.devOnly)}, largest ${count(summary.groups.largest)}, holdout ${count(summary.groups.holdout)}, exposed ${count(summary.groups.exposed)})`,
    summary.coverage === null
      ? "coverage unknown"
      : `coverage ${Math.round(summary.coverage.share * 100)}% of ${count(summary.coverage.accepted)} accepted attempts over ${count(summary.coverage.days)} days`,
    graderLine(summary.grader),
  ];
  if (summary.evalIdentity) lines.push(identityLine(summary.evalIdentity));
  if (summary.trials) {
    lines.push(summary.trials.dailyCap === null
      ? "trials off"
      : `trials today ${count(summary.trials.today)} of ${count(summary.trials.dailyCap)}`);
  }
  for (const job of summary.jobs) lines.push(...evalJobLines(job));
  return lines;
}

const pairText = (pair: PairResult) =>
  `${pair.b} vs ${pair.a}: ${signed(pair.mean, 3)} ${intervalText(pair.interval)} · sign ${count(pair.sign.wins)}-${count(pair.sign.losses)}-${count(pair.sign.ties)}, p ${fixed(pair.sign.p, 4)} (Holm ${fixed(pair.holm, 4)}) · detectable ${fixed(pair.detectable.observed, 3)} (${pair.detectable.planning === null ? "planning unknown" : `planning ${fixed(pair.detectable.planning[0], 3)} to ${fixed(pair.detectable.planning[1], 3)}`})`;
const groupPairs = (pairs: PairResult[]) =>
  pairs.map(pair => `${pair.b} vs ${pair.a} ${signed(pair.mean, 3)} ${intervalText(pair.interval)}, p ${fixed(pair.sign.p, 4)}`).join("; ");

export function evalReportLines(report: ComparisonReport): string[] {
  const { tasks } = report;
  const share = tasks.planned > 0 ? `${Math.floor(tasks.analysed / tasks.planned * 100)}%` : "unknown";
  const verdict = report.conclusive ? "share rule met" : "inconclusive: under 90% of tasks kept every valid trial";
  const reason = report.reason ? ` · ${clean(report.reason)}` : "";
  return [
    `report ${clean(report.jobId)} ${clean(report.kind)} (${clean(report.set)} set) · ${clean(report.status)}${reason} · ${count(report.trialsPerTask)} trials per task`,
    `tasks ${count(tasks.analysed)} of ${count(tasks.planned)} analysed (${share}) · ${verdict}`,
    ...report.configurations.map(c => `configuration ${c.index}: ${clean(c.profileId)} (${clean(c.provider)}, epoch ${count(c.profileEpoch)})`),
    ...report.pairs.map(pairText),
    ...report.sensitivity.map(s => `sensitivity ${s.b} vs ${s.a}: ${signed(s.mean, 3)} over ${count(s.n)} tasks`),
    ...report.attrition.map(a => `attrition ${a.configuration}: void-limit ${count(a.void["void-limit"])}, void-host ${count(a.void["void-host"])}, void-owner ${count(a.void["void-owner"])}, changed ${count(a.changed)}, short ${count(a.short)}`),
    ...report.cost.map(c => `cost ${c.configuration}: ${count(c.trials)} trials, ${count(c.resolved)} resolved · per resolved: tokens ${c.tokensPerResolved === null ? "unknown" : Math.round(c.tokensPerResolved)}, spent USD ${fixed(c.spentUsdPerResolved, 2)}, list USD unknown, minutes ${fixed(c.minutesPerResolved, 1)} (complete cost for ${count(c.costed)} of ${count(c.trials)})`),
    ...report.byPromptOrigin.map(g => `by prompt origin ${clean(g.promptOrigin)} (n ${count(g.n)}): ${groupPairs(g.pairs)}`),
    ...report.byArea.map(g => `by area ${clean(g.area)} (n ${count(g.n)}): ${groupPairs(g.pairs)}`),
  ];
}

export function evalPriorLines(priors: ReplayPrior[]): string[] {
  if (priors.length === 0) return ["no priors"];
  return priors.map(p => `${clean(p.profileId)} ${clean(p.profile.provider)}/${clean(p.profile.model ?? "unknown")}/${clean(p.profile.effort ?? "unknown")} epoch ${count(p.profileEpoch)} · prompt ${clean(p.promptVersion).slice(0, 8)} · area ${clean(p.area)} · kind ${clean(p.kind ?? "none")} · origin ${clean(p.promptOrigin)}: ${count(p.resolved)} of ${count(p.trials)} trials resolved over ${count(p.tasks)} tasks · ${clean(p.jobId)} · ${clean(p.generatedAt)}`);
}

async function read<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const failure = typeof error === "object" && error !== null ? error as { status?: unknown; code?: unknown } : {};
    if (failure.status === 503) throw new Error("The evidence store is unavailable.");
    if (failure.status === 404) {
      const known = typeof failure.code === "string" ? NOT_FOUND.get(failure.code) : undefined;
      throw new Error(known ?? "This host has no eval routes. Upgrade the host first.");
    }
    throw error;
  }
}

function jobRequest(options: Options): { requestId: string; job: unknown } {
  const file = options["--file"], requestId = options["--request-id"];
  if (typeof file !== "string" || typeof requestId !== "string" || !UUID.test(requestId)) {
    throw new Error("Usage: infinite eval run PROJECT --file job.json --request-id UUID [--json]");
  }
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    throw new Error("The job file cannot be read.");
  }
  let text: string;
  try {
    const buffer = Buffer.alloc(JOB_FILE_LIMIT + 1);
    let bytes = 0;
    for (let n = -1; n !== 0 && bytes < buffer.length; bytes += n) n = readSync(fd, buffer, bytes, buffer.length - bytes, null);
    if (bytes > JOB_FILE_LIMIT) throw new Error("The job file is larger than 64 KiB.");
    text = buffer.toString("utf8", 0, bytes);
  } finally {
    closeSync(fd);
  }
  try {
    return { requestId, job: JSON.parse(text) };
  } catch {
    throw new Error("The job file is not valid JSON.");
  }
}

export async function handleEvalClientCommand(positional: string[], options: Options, api: EvalApi): Promise<boolean> {
  const [verb, first] = positional;
  const json = options["--json"] === true;
  const print = (value: unknown, lines: () => string[]) => {
    if (json) console.log(JSON.stringify(value, null, 2));
    else for (const line of lines()) console.log(line);
  };
  if (verb === "status" && positional.length === 2) {
    const summary = await read(() => api.json<EvalSummary>(`/eval/projects/${encodeURIComponent(first!)}`));
    print(summary, () => evalStatusLines(summary));
    return true;
  }
  if (verb === "run" && positional.length === 2) {
    const body = { projectId: first!, ...jobRequest(options) };
    const result = await read(() => api.json<{ created: boolean; job: EvalJobView }>("/eval/jobs", body, undefined, undefined, "POST"));
    print(result, () => [
      ...(result.created ? [] : ["This request ID already created a job. Its existing job follows."]),
      ...evalJobLines(result.job),
    ]);
    return true;
  }
  if (verb === "job" && positional.length === 2) {
    const job = await read(() => api.json<EvalJobView>(`/eval/jobs/${encodeURIComponent(first!)}`));
    print(job, () => evalJobLines(job));
    return true;
  }
  if ((verb === "pause" || verb === "resume" || verb === "cancel") && positional.length === 2) {
    const job = await read(() => api.json<EvalJobView>(`/eval/jobs/${encodeURIComponent(first!)}/${verb}`, undefined, undefined, undefined, "POST"));
    print(job, () => evalJobLines(job));
    return true;
  }
  if (verb === "report" && positional.length === 2) {
    const report = await read(() => api.json<ComparisonReport>(`/eval/jobs/${encodeURIComponent(first!)}/report`));
    print(report, () => evalReportLines(report));
    return true;
  }
  if (verb === "priors" && positional.length === 2) {
    const result = await read(() => api.json<{ projectId: string; priors: ReplayPrior[] }>(`/eval/projects/${encodeURIComponent(first!)}/priors`));
    print(result, () => evalPriorLines(result.priors));
    return true;
  }
  if (verb === "retire" && positional.length === 2) {
    const result = await read(() => api.json<{ taskId: string; state: string }>(`/eval/tasks/${encodeURIComponent(first!)}/retire`, undefined, undefined, undefined, "POST"));
    print(result, () => [`Task ${clean(result.taskId)} is ${clean(result.state)}.`]);
    return true;
  }
  throw new Error(USAGE);
}
