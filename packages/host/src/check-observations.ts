import { CheckMetricScanner, type CheckMetricScan, type CheckMetricState } from "./check-metrics.js";
import { commandDigest } from "./objective-input.js";
import { reviewedHead } from "./team-register.js";
import type { TeamCheck, TeamRun } from "./team-types.js";

/**
 * A number one configured check printed as `infinite-metric NAME NUMBER` on stdout, with its identity. The host observed
 * only that the check ran at `head`, passed, and printed the line; it does not establish that the quantity was measured.
 */
export type CheckObservation = {
  command: string;   // commandDigest of the check command
  name: string;
  revision: number; round: number; head: string;
  at: string;        // the check's finishedAt
  state: CheckMetricState;
  value?: number;    // only with state "value"
};

/**
 * The run's stored holder as this module reads it. `checkObservations` sits beside `run`, never in it: views, member
 * context files, prompts, Understanding records and events select `run`, so none of them carries an observation.
 * It holds one (revision, round, head): per command digest, the first non-setup occurrence of that command there.
 * It is `unknown` because a later release may have stored another shape before a rollback to this one; every read
 * goes through `storedObservations`.
 */
export type ObservationHolder = { run: TeamRun; checkHead?: string; checkObservations?: unknown };

/** Rows kept per (revision, round, head): 8 configured checks of 8 names each. A larger set keeps its first 64. */
export const OBSERVATIONS_MAX = 64;
const STATES: ReadonlySet<unknown> = new Set<CheckMetricState>(["value", "ambiguous", "invalid"]);
const ROW_KEYS = new Set(["command", "name", "revision", "round", "head", "at", "state", "value"]);

function isObservation(value: unknown): value is CheckObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every(key => ROW_KEYS.has(key)) && typeof row.command === "string" && typeof row.name === "string"
    && Number.isSafeInteger(row.revision) && Number.isSafeInteger(row.round) && typeof row.head === "string" && typeof row.at === "string"
    && STATES.has(row.state) && (row.value === undefined || (typeof row.value === "number" && Number.isFinite(row.value)));
}

/**
 * The stored rows as this version writes them: none when the field is absent, and undefined when it holds anything
 * else. A value this version does not recognise is never read and never overwritten, so a later release's rows
 * survive a rollback to this one.
 */
export function storedObservations(value: unknown): CheckObservation[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every(isObservation) ? value : undefined;
}

/**
 * One check's metric scan. It sees every chunk the failure scanner sees. A scanner or a record that throws voids that
 * check's numbers, never stops a chunk reaching the other observer, and never throws into the check loop.
 */
export function metricObserver() {
  const scanner = new CheckMetricScanner();
  let broken = false;
  return {
    push(chunk: Buffer, stream: "stdout" | "stderr") {
      if (broken) return;
      try { scanner.push(chunk, stream); } catch { broken = true; }
    },
    /** Finishes the scan, for every check, and records it on the holder. Call it in the same synchronous step that finishes the row. */
    record(holder: ObservationHolder, check: TeamCheck) {
      if (broken) return;
      try { recordObservations(holder, check, scanner.finish()); } catch { broken = true; }
    },
  };
}

/**
 * Keeps a passed check's numbers when the check is the first non-setup row of its command at its (revision, round,
 * head), the row `commandResult` reads for a receipt. A failed or interrupted check, a setup row and a later
 * occurrence of the same command keep nothing. A row of another (revision, round, head) replaces what the holder keeps;
 * a row older than it changes nothing. A stored value this version does not recognise stays as it is, and the run
 * keeps no numbers. Only the last statement changes the holder, so a throw before it leaves the holder as it was.
 */
export function recordObservations(holder: ObservationHolder, check: TeamCheck, scan: CheckMetricScan): void {
  const head = check.headCommit, at = check.finishedAt;
  if (check.status !== "passed" || check.phase !== undefined || head === undefined || at === undefined) return;
  const kept = storedObservations(holder.checkObservations);
  if (!kept) return;
  const command = commandDigest(check.command), round = check.round ?? 0;
  const first = holder.run.checks.find(row => row.phase === undefined && row.revision === check.revision &&
    (row.round ?? 0) === round && row.headCommit === head && commandDigest(row.command) === command);
  if (first !== check) return;
  const held = kept[0];
  if (held && (held.revision > check.revision || (held.revision === check.revision && held.round > round))) return;
  const same = kept.filter(item => item.revision === check.revision && item.round === round && item.head === head);
  const rows = scan.metrics.map((metric): CheckObservation => ({ command, name: metric.name, revision: check.revision, round, head, at,
    state: metric.state, ...(metric.state === "value" && metric.value !== undefined ? { value: metric.value } : {}) }));
  const next = [...same, ...rows].slice(0, OBSERVATIONS_MAX);
  if (next.length) holder.checkObservations = next;
  else delete holder.checkObservations;
}

/**
 * The goal's one read of a run's numbers. It answers only when the reviewed-head rule holds (the check head is the
 * run's head and the review approved this revision), and then only with the observations of that revision's final
 * round at that head. Undefined means no reviewed head; an empty list means a reviewed head without numbers.
 */
export function reviewedObservationsOf(holder: ObservationHolder | undefined): CheckObservation[] | undefined {
  if (!holder || !reviewedHead(holder)) return undefined;
  const run = holder.run, head = run.headCommit;
  const rounds = run.checks.filter(check => check.revision === run.revision).map(check => check.round ?? 0);
  if (!rounds.length) return [];
  const round = Math.max(...rounds);
  return (storedObservations(holder.checkObservations) ?? []).filter(item => item.revision === run.revision && item.round === round && item.head === head)
    .map(item => ({ ...item }));
}
