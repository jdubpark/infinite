import { createHash } from "node:crypto";
import { z } from "zod";
import { WITNESS_LIMIT, type ProcessWitness } from "./process-census.js";
import { teamCommandSchema, type TeamCommand } from "./team-types.js";

/*
 * The durable record of the main check (INF-388) and its rules as pure functions. Nothing here reads a file or a
 * clock: times, digests and witnesses come in as arguments, so the simulator and the service apply the same rules.
 */

/** A final result: the check ran to its end at this commit in a clean copy. */
export type CheckSummary = {
  head: string;
  /** Digest of the configured setup and checks the result was measured with. */
  checks: string;
  /** Stamp of the latest observation of this head (MirrorFetch.fetchedAt). */
  observedAt: string;
  outcome: "passed" | "failed";
  finishedAt: string;
  /** How many commands the check had (setup counts as one). */
  expected: number;
  /** For a failure: the 1-based position of the command that failed, and its exit code. */
  failed?: { index: number; exitCode: number | null };
};
export type MainCheckCommand = {
  phase: "setup" | "verification";
  command: TeamCommand;
  status: "passed" | "failed" | "interrupted";
  exitCode: number | null;
  /** Untrusted text from the command's output, at most 8 entries. For the owner's eyes only: never in a prompt or a push. */
  failures?: string[];
};
export type MainCheckReason = "time-limit" | "halt" | "host-stop" | "workspace" | "copy-changed" | "command-unavailable" | "stop-unconfirmed";
export type MainCheckResult = {
  head: string;
  checks: string;
  startedAt: string;
  finishedAt: string;
  outcome: "passed" | "failed" | "interrupted" | "error";
  /** Why a check without a final result ended. */
  reason?: MainCheckReason;
  expected: number;
  commands: MainCheckCommand[];
};
/** A run directory that is not yet proven quiet and removed. `directory` is the run directory's name under the team root. */
export type Retiring = { directory: string; root: string; witness: ProcessWitness; recording?: true };
export type MainCheckRunning = Retiring & { head: string; checks: string; startedAt: string };
export type MainCheckWaiting = "execution-identity" | "census-unavailable" | "halt" | "host-load" | "storage" | "another-check" | "processes" | "cleanup" | "attempts";
export type MainCheckRecord = {
  version: 1;
  /** Newest head the mirror reported, ordered by fetch stamp. */
  observed?: { head: string; at: string };
  /** Charged admissions per head and checks digest, newest last, at most 20. */
  attempts?: { head: string; checks: string; count: number }[];
  /** The check in progress. Written before its copy exists. */
  running?: MainCheckRunning;
  /** At most 8. */
  retiring?: Retiring[];
  /** Detail of the newest finished check. */
  last?: MainCheckResult;
  /** Final results, newest last, at most 20. */
  results?: CheckSummary[];
  /** Derived by `settle`: the result of the most recently observed head that has a result with the current checks digest. */
  health?: CheckSummary;
  /** Generation of the health outcome: +1 each time the outcome changes. Absent health counts as passed. */
  notice?: number;
  /** The newest notice the push service accepted for a device. */
  told?: { notice: number; outcome: "passed" | "failed" };
  waiting?: MainCheckWaiting;
};
/** The project setting. The schema key is added by the wiring task; until then it is read through `mainCheckSetting`. */
export type MainCheckSetting = { minutes?: number };

/** A head is checked at most this many times per checks digest without a result. */
export const MAX_ATTEMPTS = 3;
export const MAX_ATTEMPT_ENTRIES = 20;
export const MAX_RESULTS = 20;
export const MAX_RETIRING = 8;
export const MAX_FAILURES = 8;
/** Setup and the at most eight configured checks. */
const MAX_COMMANDS = 9;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const PROJECT_ID = /^[a-z0-9-]+$/;

const head = z.string().regex(COMMIT);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const stamp = z.string().min(1).max(40).refine(value => !Number.isNaN(Date.parse(value)));
const pass = z.enum(["passed", "failed"]);
const witnessSchema = z.strictObject({
  boot: z.string().min(1).max(200),
  processes: z.array(z.strictObject({ pid: z.number().int(), start: z.string().max(200) })).max(WITNESS_LIMIT),
  sessions: z.array(z.number().int()).max(WITNESS_LIMIT),
  groups: z.array(z.number().int()).max(WITNESS_LIMIT),
  overflow: z.literal(true).optional(),
});
const retiringShape = {
  directory: z.string().regex(/^[a-z0-9-]{1,200}$/),
  root: z.string().min(1).max(4096),
  witness: witnessSchema,
  recording: z.literal(true).optional(),
};
const summarySchema = z.strictObject({
  head,
  checks: digest,
  observedAt: stamp,
  outcome: pass,
  finishedAt: stamp,
  expected: z.number().int().min(0).max(MAX_COMMANDS),
  failed: z.strictObject({ index: z.number().int().min(1).max(MAX_COMMANDS), exitCode: z.number().int().nullable() }).optional(),
});
const commandSchema = z.strictObject({
  phase: z.enum(["setup", "verification"]),
  command: teamCommandSchema,
  status: z.enum(["passed", "failed", "interrupted"]),
  exitCode: z.number().int().nullable(),
  failures: z.array(z.string().max(4000)).max(MAX_FAILURES).optional(),
});
const resultSchema = z.strictObject({
  head,
  checks: digest,
  startedAt: stamp,
  finishedAt: stamp,
  outcome: z.enum(["passed", "failed", "interrupted", "error"]),
  reason: z.enum(["time-limit", "halt", "host-stop", "workspace", "copy-changed", "command-unavailable", "stop-unconfirmed"]).optional(),
  expected: z.number().int().min(0).max(MAX_COMMANDS),
  commands: z.array(commandSchema).max(MAX_COMMANDS),
});
export const mainCheckRecordSchema: z.ZodType<MainCheckRecord> = z.strictObject({
  version: z.literal(1),
  observed: z.strictObject({ head, at: stamp }).optional(),
  attempts: z.array(z.strictObject({ head, checks: digest, count: z.number().int().min(1).max(MAX_ATTEMPTS) })).max(MAX_ATTEMPT_ENTRIES).optional(),
  running: z.strictObject({ ...retiringShape, head, checks: digest, startedAt: stamp }).optional(),
  retiring: z.array(z.strictObject(retiringShape)).max(MAX_RETIRING).optional(),
  last: resultSchema.optional(),
  results: z.array(summarySchema).max(MAX_RESULTS).optional(),
  health: summarySchema.optional(),
  notice: z.number().int().min(0).optional(),
  told: z.strictObject({ notice: z.number().int().min(0), outcome: pass }).optional(),
  waiting: z.enum(["execution-identity", "census-unavailable", "halt", "host-load", "storage", "another-check", "processes", "cleanup", "attempts"]).optional(),
});
const settingSchema = z.strictObject({ minutes: z.number().int().min(1).max(240).optional() });

/** `project.team.mainCheck`, or undefined when it is absent or not a valid setting. */
export function mainCheckSetting(team: unknown): MainCheckSetting | undefined {
  const value = (team as { mainCheck?: unknown } | undefined)?.mainCheck;
  if (value === undefined) return undefined;
  const parsed = settingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const isCommit = (value: string) => COMMIT.test(value);
export const emptyRecord = (): MainCheckRecord => ({ version: 1 });
/** Absent health, and an absent `told`, count as passed. */
export const outcomeOf = (summary?: { outcome: "passed" | "failed" }) => summary?.outcome ?? "passed";

/** The digest a result is measured with: the configured setup and checks, in order. */
export function checksDigest(team: { setup?: TeamCommand; checks: readonly TeamCommand[] }): string {
  return createHash("sha256").update(JSON.stringify({ setup: team.setup ?? null, checks: team.checks })).digest("hex");
}

/** The record with `key` set, or removed when `value` is undefined or an empty list. */
function assign<K extends keyof MainCheckRecord>(record: MainCheckRecord, key: K, value: MainCheckRecord[K]): MainCheckRecord {
  const next = { ...record };
  if (value === undefined || Array.isArray(value) && value.length === 0) delete next[key];
  else next[key] = value;
  return next;
}

const sameAttempt = (head: string, checks: string) => (entry: { head: string; checks: string }) => entry.head === head && entry.checks === checks;

export function chargedAdmissions(record: MainCheckRecord, head: string, checks: string): number {
  return record.attempts?.find(sameAttempt(head, checks))?.count ?? 0;
}

/**
 * settle, the one health transition: among results with the current digest, the one with the newest `observedAt`
 * (the later entry on a tie). `notice` goes up by one when its outcome differs from the recorded health's.
 */
export function settle(record: MainCheckRecord, digest: string): MainCheckRecord {
  let best: CheckSummary | undefined;
  for (const result of record.results ?? []) {
    if (result.checks !== digest) continue;
    if (best === undefined || Date.parse(result.observedAt) >= Date.parse(best.observedAt)) best = result;
  }
  const next = assign(record, "health", best);
  if (outcomeOf(best) === outcomeOf(record.health)) return next;
  return { ...next, notice: (record.notice ?? 0) + 1 };
}

/** R1. A fetch older than the observed one changes nothing; the caller settles. */
export function observe(record: MainCheckRecord, head: string, at: string): MainCheckRecord {
  if (record.observed && Date.parse(at) < Date.parse(record.observed.at)) return record;
  const next: MainCheckRecord = { ...record, observed: { head, at } };
  if (!record.results?.some(result => result.head === head)) return next;
  next.results = record.results.map(result => result.head === head ? { ...result, observedAt: at } : result);
  return next;
}

/** R2: the observed head when it needs a check, `attempts` when it used them up, or undefined. */
export function candidate(record: MainCheckRecord, digest: string): { head: string } | { waiting: "attempts" } | undefined {
  if (record.running || !record.observed) return undefined;
  const head = record.observed.head;
  if (record.results?.some(result => result.head === head && result.checks === digest)) return undefined;
  if (chargedAdmissions(record, head, digest) >= MAX_ATTEMPTS) return { waiting: "attempts" };
  return { head };
}

/** R4, one write: the check is recorded before its copy exists, and the head is charged one admission. */
export function admit(record: MainCheckRecord, running: MainCheckRunning): MainCheckRecord {
  const count = chargedAdmissions(record, running.head, running.checks) + 1;
  const others = (record.attempts ?? []).filter(entry => !sameAttempt(running.head, running.checks)(entry));
  const attempts = [...others, { head: running.head, checks: running.checks, count }].slice(-MAX_ATTEMPT_ENTRIES);
  return assign({ ...record, running, attempts }, "waiting", undefined);
}

/** The summary a final result adds to `results`. */
function summaryOf(result: MainCheckResult, observedAt: string): CheckSummary {
  const outcome = result.outcome === "passed" ? "passed" : "failed";
  const index = result.commands.findIndex(command => command.status === "failed");
  const failed = outcome === "failed" && index >= 0 ? { failed: { index: index + 1, exitCode: result.commands[index]!.exitCode } } : {};
  return { head: result.head, checks: result.checks, observedAt, outcome, finishedAt: result.finishedAt, expected: result.expected, ...failed };
}

/**
 * R6, one write: `last` is set and the run directory moves to `retiring` with the witness given. A final result is
 * added with `observedAt` and drops the head's attempts; a halt or a host stop gives the admission back. The caller
 * settles.
 */
export function finish(record: MainCheckRecord, result: MainCheckResult, entry: Retiring, observedAt: string): MainCheckRecord {
  const { running: _running, ...rest } = record;
  let next: MainCheckRecord = { ...rest, last: result, retiring: [...(record.retiring ?? []), entry] };
  const own = sameAttempt(result.head, result.checks);
  if (result.outcome === "passed" || result.outcome === "failed") {
    next = assign(next, "results", [...(record.results ?? []), summaryOf(result, observedAt)].slice(-MAX_RESULTS));
    return assign(next, "attempts", record.attempts?.filter(attempt => !own(attempt)));
  }
  if (result.outcome !== "interrupted" || result.reason !== "halt" && result.reason !== "host-stop") return next;
  const attempts = (record.attempts ?? []).map(attempt => own(attempt) ? { ...attempt, count: attempt.count - 1 } : attempt);
  return assign(next, "attempts", attempts.filter(attempt => attempt.count > 0));
}

/**
 * R8: a record that still holds `running` was left by a host that stopped during the check. The run directory moves
 * to `retiring` as it is and the admission stays charged, so a commit whose check stops the host is tried at most
 * three times. The caller settles.
 */
export function hostStart(record: MainCheckRecord, finishedAt: string, expected: number): MainCheckRecord {
  if (!record.running) return record;
  const { head, checks, startedAt, directory, root, witness, recording } = record.running;
  const { running: _running, ...rest } = record;
  const entry: Retiring = { directory, root, witness, ...(recording ? { recording } : {}) };
  const last: MainCheckResult = { head, checks, startedAt, finishedAt, outcome: "interrupted", reason: "host-stop", expected, commands: [] };
  return { ...rest, retiring: [...(record.retiring ?? []), entry], last };
}

/** The entry of `directory`, in `running` or in `retiring`. */
export function entryOf(record: MainCheckRecord, directory: string): Retiring | undefined {
  if (record.running?.directory === directory) return record.running;
  return record.retiring?.find(entry => entry.directory === directory);
}

/** The record with the witness of `directory` replaced, wherever its entry is; undefined when no entry holds it. */
export function withWitness(record: MainCheckRecord, directory: string, witness: ProcessWitness, recording: boolean): MainCheckRecord | undefined {
  const flag = recording ? { recording: true as const } : {};
  if (record.running?.directory === directory) {
    const { recording: _recording, ...running } = record.running;
    return { ...record, running: { ...running, witness, ...flag } };
  }
  if (!record.retiring?.some(entry => entry.directory === directory)) return undefined;
  const retiring = record.retiring.map(entry => {
    if (entry.directory !== directory) return entry;
    return { directory: entry.directory, root: entry.root, witness, ...flag };
  });
  return { ...record, retiring };
}

/** R7's bookkeeping: a removed directory leaves `retiring`. */
export function retire(record: MainCheckRecord, directory: string): MainCheckRecord {
  return assign(record, "retiring", record.retiring?.filter(entry => entry.directory !== directory));
}

export function setWaiting(record: MainCheckRecord, waiting: MainCheckWaiting | undefined): MainCheckRecord {
  return assign(record, "waiting", waiting);
}

/** R9: health's outcome differs from what the owner was told. The caller checks that the setting is present. */
export function noticeDue(record: MainCheckRecord): boolean {
  return outcomeOf(record.health) !== outcomeOf(record.told);
}

/**
 * R9's acceptance: records what the owner was really told, also when health changed since the send. An older
 * generation than `told` changes nothing, and so does a generation the record never reached.
 */
export function accept(record: MainCheckRecord, notice: number, outcome: "passed" | "failed"): MainCheckRecord {
  if (notice < (record.told?.notice ?? 0) || notice > (record.notice ?? 0)) return record;
  if (record.told?.notice === notice && record.told.outcome === outcome) return record;
  return { ...record, told: { notice, outcome } };
}

/** What the owner's read route shows: no directory, root or witness. */
export type MainCheckView =
  | { readable: false }
  | {
    readable: true;
    enabled: boolean;
    observed?: { head: string; at: string };
    running?: { head: string; checks: string; startedAt: string };
    /** Run directories not yet proven quiet and removed. */
    retiring: number;
    attempts: { head: string; checks: string; count: number }[];
    last?: MainCheckResult;
    results: CheckSummary[];
    health?: CheckSummary;
    /** True when `health` was measured at the observed head. */
    current: boolean;
    notice: number;
    told?: { notice: number; outcome: "passed" | "failed" };
    waiting?: MainCheckWaiting;
  };

export function viewOf(record: MainCheckRecord, enabled: boolean): MainCheckView {
  const running = record.running ? { head: record.running.head, checks: record.running.checks, startedAt: record.running.startedAt } : undefined;
  return structuredClone({
    readable: true as const,
    enabled,
    ...(record.observed ? { observed: record.observed } : {}),
    ...(running ? { running } : {}),
    retiring: record.retiring?.length ?? 0,
    attempts: record.attempts ?? [],
    ...(record.last ? { last: record.last } : {}),
    results: record.results ?? [],
    ...(record.health ? { health: record.health } : {}),
    current: record.health !== undefined && record.health.head === record.observed?.head,
    notice: record.notice ?? 0,
    ...(record.told ? { told: record.told } : {}),
    ...(record.waiting ? { waiting: record.waiting } : {}),
  });
}
