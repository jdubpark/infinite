import { closeSync, openSync, readSync } from "node:fs";
import { EVAL_STATES, type EvalJobView, type EvalState, type EvalSummary } from "./eval-types.js";

type Options = Record<string, string | boolean>;
export type EvalApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };

const USAGE = "Usage: infinite eval status PROJECT [--json] | infinite eval run --file job.json --request-id UUID [--json] | infinite eval job JOB [--json] | infinite eval pause|resume|cancel JOB | infinite eval retire TASK";
/** A job file is read at most this many bytes; a larger one is refused before any call. */
const JOB_FILE_LIMIT = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_FOUND = new Map([
  ["unknown-project", "No project has this ID."],
  ["unknown-job", "No job has this ID."],
  ["unknown-task", "No task has this ID."],
]);
const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
/** A count the host did not compute prints as unknown, never as zero. */
const count = (value: number | null | undefined) => value === null || value === undefined ? "unknown" : String(value);
const stateCounts = (byState: Record<EvalState, number>) => EVAL_STATES.map(state => `${state} ${count(byState[state])}`).join(" · ");

/** One job as two lines: its header, then its counts. Every text value passes through `clean`. */
export function evalJobLines(job: EvalJobView): string[] {
  const reason = job.reason ? ` · ${clean(job.reason)}` : "";
  const waiting = job.waiting ? ` · waiting ${clean(job.waiting)}` : "";
  const { counts } = job;
  return [
    `job ${clean(job.jobId)} ${clean(job.status)}${reason}${waiting}`,
    `visited ${count(counts.visited)}, valid ${count(counts.valid)}, rejected ${count(counts.rejected)}, retired ${count(counts.retired)}, undecided ${count(counts.undecided)}`,
  ];
}

/** The status of one project, in the order the plan fixes. Plain columns only: ids, states, counts, and hashes. */
export function evalStatusLines(summary: EvalSummary): string[] {
  const mining = summary.mining;
  const lines = [
    clean(summary.projectId),
    `capture ${summary.capture.on ? "on" : "off"} · mining ${clean(mining.state)} (visited ${count(mining.visited)}, mined ${count(mining.mined)}, skipped ${count(mining.skipped)}, failures ${count(mining.failures)})`,
    `states: ${stateCounts(summary.tasks.byState)}`,
    `mined: ${stateCounts(summary.tasks.byOrigin.mined)}`,
    `groups ${count(summary.groups.total)} (dev-only ${count(summary.groups.devOnly)}, largest ${count(summary.groups.largest)})`,
    summary.coverage === null
      ? "coverage unknown"
      : `coverage ${Math.round(summary.coverage.share * 100)}% of ${count(summary.coverage.accepted)} accepted attempts over ${count(summary.coverage.days)} days`,
    `grader ${clean(summary.grader.state)}`,
  ];
  for (const job of summary.jobs) lines.push(...evalJobLines(job));
  return lines;
}

/** Maps the host's fixed answers to the plan's sentences. An absent route, an older host, answers 404 without a known code. */
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

/** Reads the job file, at most 64 KiB, and checks the request ID, all before any call. */
function jobRequest(options: Options): { requestId: string; job: unknown } {
  const file = options["--file"], requestId = options["--request-id"];
  if (typeof file !== "string" || typeof requestId !== "string" || !UUID.test(requestId)) {
    throw new Error("Usage: infinite eval run --file job.json --request-id UUID [--json]");
  }
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    throw new Error("The job file cannot be read.");
  }
  let text: string;
  try {
    // Reads until the end or one byte past the limit; a pipe can answer in pieces.
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
  if (verb === "run" && positional.length === 1) {
    const body = jobRequest(options);
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
  if (verb === "retire" && positional.length === 2) {
    const result = await read(() => api.json<{ taskId: string; state: string }>(`/eval/tasks/${encodeURIComponent(first!)}/retire`, undefined, undefined, undefined, "POST"));
    print(result, () => [`Task ${clean(result.taskId)} is ${clean(result.state)}.`]);
    return true;
  }
  throw new Error(USAGE);
}
