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
 */
export type ObservationHolder = { run: TeamRun; checkHead?: string; checkObservations?: CheckObservation[] };

/**
 * One check's metric scan. It sees every chunk the failure scanner sees. A scanner that throws voids that check's
 * numbers and never stops a chunk reaching the other observer.
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
      let scan: CheckMetricScan | undefined;
      try { scan = scanner.finish(); } catch { broken = true; }
      if (!broken && scan) recordObservations(holder, check, scan);
    },
  };
}

/**
 * Keeps a passed check's numbers when the check is the first non-setup row of its command at its (revision, round,
 * head), the row `commandResult` reads for a receipt. A failed or interrupted check, a setup row and a later
 * occurrence of the same command keep nothing. A row of another (revision, round, head) replaces what the holder keeps;
 * a row older than it changes nothing.
 */
export function recordObservations(holder: ObservationHolder, check: TeamCheck, scan: CheckMetricScan): void {
  const head = check.headCommit, at = check.finishedAt;
  if (check.status !== "passed" || check.phase !== undefined || head === undefined || at === undefined) return;
  const command = commandDigest(check.command), round = check.round ?? 0;
  const first = holder.run.checks.find(row => row.phase === undefined && row.revision === check.revision &&
    (row.round ?? 0) === round && row.headCommit === head && commandDigest(row.command) === command);
  if (first !== check) return;
  const kept = holder.checkObservations ?? [];
  const held = kept[0];
  if (held && (held.revision > check.revision || (held.revision === check.revision && held.round > round))) return;
  const same = kept.filter(item => item.revision === check.revision && item.round === round && item.head === head);
  const rows = scan.metrics.map((metric): CheckObservation => ({ command, name: metric.name, revision: check.revision, round, head, at,
    state: metric.state, ...(metric.state === "value" && metric.value !== undefined ? { value: metric.value } : {}) }));
  const next = [...same, ...rows];
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
  return (holder.checkObservations ?? []).filter(item => item.revision === run.revision && item.round === round && item.head === head)
    .map(item => ({ ...item }));
}
