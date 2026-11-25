import { CheckMetricScanner, type CheckMetricScan, type CheckMetricState } from "./check-metrics.js";
import { commandDigest } from "./objective-input.js";
import { reviewedHead } from "./team-register.js";
import type { TeamCheck, TeamRun } from "./team-types.js";

export type CheckObservation = {
  command: string;
  name: string;
  revision: number; round: number; head: string;
  at: string;
  state: CheckMetricState;
  value?: number;
};

export type ObservationHolder = { run: TeamRun; checkHead?: string; checkObservations?: unknown };

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

export function storedObservations(value: unknown): CheckObservation[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every(isObservation) ? value : undefined;
}

export function metricObserver() {
  const scanner = new CheckMetricScanner();
  let broken = false;
  return {
    push(chunk: Buffer, stream: "stdout" | "stderr") {
      if (broken) return;
      try { scanner.push(chunk, stream); } catch { broken = true; }
    },
    record(holder: ObservationHolder, check: TeamCheck) {
      if (broken) return;
      try { recordObservations(holder, check, scanner.finish()); } catch { broken = true; }
    },
  };
}

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

export function reviewedObservationsOf(holder: ObservationHolder | undefined): CheckObservation[] | undefined {
  if (!holder || !reviewedHead(holder)) return undefined;
  const run = holder.run, head = run.headCommit;
  const rounds = run.checks.filter(check => check.revision === run.revision).map(check => check.round ?? 0);
  if (!rounds.length) return [];
  const round = Math.max(...rounds);
  return (storedObservations(holder.checkObservations) ?? []).filter(item => item.revision === run.revision && item.round === round && item.head === head)
    .map(item => ({ ...item }));
}
