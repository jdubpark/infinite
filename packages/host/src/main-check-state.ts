import { createHash } from "node:crypto";
import { z } from "zod";
import { WITNESS_LIMIT, type ProcessWitness } from "./process-census.js";
import { teamCommandSchema, type TeamCommand } from "./team-types.js";
import type { Config, Project } from "./types.js";

export type CheckSummary = {
  head: string;
  checks: string;
  observedAt: string;
  outcome: "passed" | "failed";
  finishedAt: string;
  expected: number;
  failed?: { index: number; exitCode: number | null };
};
export type MainCheckCommand = {
  phase: "setup" | "verification";
  command: TeamCommand;
  status: "passed" | "failed" | "interrupted";
  exitCode: number | null;
  failures?: string[];
};
export type MainCheckInterruptReason = "time-limit" | "halt" | "host-stop";
export type MainCheckErrorReason = "workspace" | "copy-changed" | "command-unavailable" | "stop-unconfirmed";
export type MainCheckReason = MainCheckInterruptReason | MainCheckErrorReason;

type MainCheckResultBase = {
  head: string;
  checks: string;
  startedAt: string;
  finishedAt: string;
  expected: number;
  commands: MainCheckCommand[];
};

export type MainCheckResult =
  | (MainCheckResultBase & { outcome: "passed" | "failed"; reason?: never })
  | (MainCheckResultBase & { outcome: "interrupted"; reason: MainCheckInterruptReason })
  | (MainCheckResultBase & { outcome: "error"; reason: MainCheckErrorReason });

export type Retiring = { directory: string; root: string; witness: ProcessWitness; recording?: true };
export type MainCheckRunning = Retiring & { head: string; checks: string; startedAt: string };
export type MainCheckWaiting = "execution-identity" | "census-unavailable" | "halt" | "host-load" | "storage" | "another-check" | "processes" | "cleanup" | "attempts";
export type MainCheckRecord = {
  version: 1;
  observed?: { head: string; at: string };
  attempts?: { head: string; checks: string; count: number }[];
  running?: MainCheckRunning;
  retiring?: Retiring[];
  last?: MainCheckResult;
  results?: CheckSummary[];
  health?: CheckSummary;
  notice?: number;
  told?: { notice: number; outcome: "passed" | "failed" };
  waiting?: MainCheckWaiting;
};
export type MainCheckSetting = { minutes?: number };

export const MAX_ATTEMPTS = 3;
export const MAX_ATTEMPT_ENTRIES = 20;
export const MAX_RESULTS = 20;
export const MAX_RETIRING = 8;
export const MAX_FAILURES = 8;
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
const resultBase = {
  head,
  checks: digest,
  startedAt: stamp,
  finishedAt: stamp,
  expected: z.number().int().min(0).max(MAX_COMMANDS),
  commands: z.array(commandSchema).max(MAX_COMMANDS),
};
const resultSchema: z.ZodType<MainCheckResult> = z.discriminatedUnion("outcome", [
  z.strictObject({ ...resultBase, outcome: z.literal("passed") }),
  z.strictObject({ ...resultBase, outcome: z.literal("failed") }),
  z.strictObject({ ...resultBase, outcome: z.literal("interrupted"), reason: z.enum(["time-limit", "halt", "host-stop"]) }),
  z.strictObject({ ...resultBase, outcome: z.literal("error"), reason: z.enum(["workspace", "copy-changed", "command-unavailable", "stop-unconfirmed"]) }),
]);
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

export function mainCheckSetting(team: unknown): MainCheckSetting | undefined {
  const value = (team as { mainCheck?: unknown } | undefined)?.mainCheck;
  if (value === undefined) return undefined;
  const parsed = settingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function mainCheckRunnable(config: Pick<Config, "teams">, project: Pick<Project, "id" | "team" | "source">): boolean {
  return project.team !== undefined && project.team.checks.length > 0 && config.teams !== undefined &&
    project.source?.mode === "github" && PROJECT_ID.test(project.id);
}

export const isCommit = (value: string) => COMMIT.test(value);
export const emptyRecord = (): MainCheckRecord => ({ version: 1 });
export const outcomeOf = (summary?: { outcome: "passed" | "failed" }) => summary?.outcome ?? "passed";

export function checksDigest(team: { setup?: TeamCommand; checks: readonly TeamCommand[] }): string {
  return createHash("sha256").update(JSON.stringify({ setup: team.setup ?? null, checks: team.checks })).digest("hex");
}

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

export function observe(record: MainCheckRecord, head: string, at: string): MainCheckRecord {
  if (record.observed && Date.parse(at) < Date.parse(record.observed.at)) return record;
  const next: MainCheckRecord = { ...record, observed: { head, at } };
  if (!record.results?.some(result => result.head === head)) return next;
  next.results = record.results.map(result => result.head === head ? { ...result, observedAt: at } : result);
  return next;
}

export function candidate(record: MainCheckRecord, digest: string): { head: string } | { waiting: "attempts" } | undefined {
  if (record.running || !record.observed) return undefined;
  const head = record.observed.head;
  if (record.results?.some(result => result.head === head && result.checks === digest)) return undefined;
  if (chargedAdmissions(record, head, digest) >= MAX_ATTEMPTS) return { waiting: "attempts" };
  return { head };
}

export function admit(record: MainCheckRecord, running: MainCheckRunning): MainCheckRecord {
  const count = chargedAdmissions(record, running.head, running.checks) + 1;
  const others = (record.attempts ?? []).filter(entry => !sameAttempt(running.head, running.checks)(entry));
  const attempts = [...others, { head: running.head, checks: running.checks, count }].slice(-MAX_ATTEMPT_ENTRIES);
  return assign({ ...record, running, attempts }, "waiting", undefined);
}

function summaryOf(result: Extract<MainCheckResult, { outcome: "passed" | "failed" }>, observedAt: string): CheckSummary {
  const outcome = result.outcome;
  const index = result.commands.findIndex(command => command.status === "failed");
  const failed = outcome === "failed" && index >= 0 ? { failed: { index: index + 1, exitCode: result.commands[index]!.exitCode } } : {};
  return { head: result.head, checks: result.checks, observedAt, outcome, finishedAt: result.finishedAt, expected: result.expected, ...failed };
}

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

export function hostStart(record: MainCheckRecord, finishedAt: string, expected: number): MainCheckRecord {
  if (!record.running) return record;
  const { head, checks, startedAt, directory, root, witness, recording } = record.running;
  const { running: _running, ...rest } = record;
  const entry: Retiring = { directory, root, witness, ...(recording ? { recording } : {}) };
  const last: MainCheckResult = { head, checks, startedAt, finishedAt, outcome: "interrupted", reason: "host-stop", expected, commands: [] };
  return { ...rest, retiring: [...(record.retiring ?? []), entry], last };
}

export function entryOf(record: MainCheckRecord, directory: string): Retiring | undefined {
  if (record.running?.directory === directory) return record.running;
  return record.retiring?.find(entry => entry.directory === directory);
}

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

export function retire(record: MainCheckRecord, directory: string): MainCheckRecord {
  return assign(record, "retiring", record.retiring?.filter(entry => entry.directory !== directory));
}

export function setWaiting(record: MainCheckRecord, waiting: MainCheckWaiting | undefined): MainCheckRecord {
  return assign(record, "waiting", waiting);
}

export function noticeDue(record: MainCheckRecord): record is MainCheckRecord & { health: CheckSummary } {
  return record.health !== undefined && record.health.outcome !== outcomeOf(record.told);
}

export function accept(record: MainCheckRecord, notice: number, outcome: "passed" | "failed"): MainCheckRecord {
  if (notice < (record.told?.notice ?? 0) || notice > (record.notice ?? 0)) return record;
  if (record.told?.notice === notice && record.told.outcome === outcome) return record;
  return { ...record, told: { notice, outcome } };
}

export type MainCheckView =
  | { readable: false }
  | {
    readable: true;
    enabled: boolean;
    observed?: { head: string; at: string };
    running?: { head: string; checks: string; startedAt: string };
    retiring: number;
    attempts: { head: string; checks: string; count: number }[];
    last?: MainCheckResult;
    results: CheckSummary[];
    health?: CheckSummary;
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
