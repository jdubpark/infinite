import type { MemberStopReason } from "./run-events.js";
import { teamPathAllowed } from "./team-workspace.js";

export type Disposition = "open" | "integrated" | "completed" | "escalated" | "stalled" | "no-report" | "question"
  | "blocked" | "wrong-report" | "out-of-scope" | "limit" | "owner-stop" | "host-stop";
export type Exclusion = "limit" | "owner" | "host";
export type Level = 0 | 1 | null;
export type Flag = "backfilled" | "gap" | "empty-result" | "same-model-review" | "scan-gap";
export type LinkState = "pending" | "attributed" | "clear" | "unknown";
export type LandingMethod = "merge-commit" | "merge-parent" | "tree-equal";
export type ScanGap = "first" | "bound" | "rewrite" | "source";
export type Coverage = "open" | "covered" | "gap";
export type ScanPoint = { seq: number; at: string; checkedAt: string; gap: ScanGap | null };
export interface RowSignals { excluded: boolean; negative: boolean; landing?: Coverage }
export interface RowState { role: "implementer" | "scout"; disposition: Disposition; accepted: Level; links: readonly LinkState[]; signals?: RowSignals }
export interface Levels { integrated: Level; accepted: Level; firstPass: Level; held: Level }

export const BLOCK_DISPOSITIONS: Readonly<Record<string, Disposition>> = {
  "wrong-agent-report": "wrong-report",
  "task-scope-violation": "out-of-scope",
  "read-only-role-changed-files": "out-of-scope",
  "integration-conflict": "host-stop",
  "integration-changed-files": "host-stop",
  "workspace-operation-failed": "host-stop",
  "invalid-workspace-baseline": "host-stop",
  "workspace-copy-changed": "host-stop",
};

const STOP_DISPOSITIONS: Readonly<Record<MemberStopReason, Disposition>> = {
  stall: "stalled",
  limit: "limit",
  "no-report": "no-report",
  owner: "owner-stop",
  host: "host-stop",
};

const EXCLUSIONS: Readonly<Partial<Record<Disposition, Exclusion>>> = {
  limit: "limit",
  "owner-stop": "owner",
  "host-stop": "host",
};

export function stopDisposition(reason: MemberStopReason): Disposition {
  return STOP_DISPOSITIONS[reason];
}

export function reportDisposition(kind: string): Disposition | undefined {
  if (kind === "question" || kind === "blocked") return kind;
  return undefined;
}

export function exclusionOf(disposition: Disposition): Exclusion | undefined {
  return EXCLUSIONS[disposition];
}

export function replaces(current: Disposition, next: Disposition): boolean {
  if (next === "integrated") return current !== "completed";
  if (next === "completed") return current !== "integrated";
  if (next === "wrong-report" || next === "out-of-scope") return current === "open" || current === "host-stop";
  if (next === "question" || next === "blocked") return current === "open" || current === "host-stop" || current === "owner-stop";
  return current === "open";
}

function countedFailure(disposition: Disposition): boolean {
  return disposition !== "open" && disposition !== "integrated" && disposition !== "completed" && exclusionOf(disposition) === undefined;
}

export function rowExclusion(disposition: Disposition, signals?: RowSignals): Exclusion | undefined {
  return exclusionOf(disposition) ?? (signals?.excluded ? "owner" : undefined);
}

function heldOf(accepted: Level, signals: RowSignals | undefined): Level {
  if (accepted === 0 || signals?.negative) return 0;
  if (accepted === 1 && signals?.landing === "covered") return 1;
  return null;
}

export function levels(state: RowState): Levels {
  const unknown: Levels = { integrated: null, accepted: null, firstPass: null, held: null };
  if (state.role !== "implementer" || state.disposition === "open" || rowExclusion(state.disposition, state.signals) !== undefined) return unknown;
  if (countedFailure(state.disposition)) return { integrated: 0, accepted: 0, firstPass: 0, held: 0 };
  if (state.disposition !== "integrated") return unknown;
  const accepted = state.accepted;
  let firstPass: Level = null;
  if (accepted === 0 || state.links.includes("attributed")) firstPass = 0;
  else if (accepted === 1 && state.links.every(link => link === "clear")) firstPass = 1;
  return {
    integrated: 1,
    accepted,
    firstPass,
    held: heldOf(accepted, state.signals),
  };
}

export function scanGap(state: RowState): boolean {
  return state.role === "implementer" && state.disposition === "integrated" && rowExclusion(state.disposition, state.signals) === undefined
    && state.accepted === 1 && state.signals?.negative !== true && state.signals?.landing === "gap";
}

export function freezeAccepted(accepted: Level, lastReview: "approved" | "changes-requested" | undefined, status: string): Level {
  if (accepted !== null) return accepted;
  if (lastReview === "changes-requested" && status !== "cancelled") return 0;
  return null;
}

export function linkAfterPaths(owned: readonly string[] | undefined, changed: readonly string[] | "omitted"): LinkState {
  if (owned === undefined || changed === "omitted") return "unknown";
  if (changed.some(path => teamPathAllowed(path, [...owned]))) return "attributed";
  return "clear";
}

export function roundCounts(links: readonly LinkState[]): { run: number; attributed: number; unknown: number } {
  return {
    run: links.length,
    attributed: links.filter(link => link === "attributed").length,
    unknown: links.filter(link => link === "pending" || link === "unknown").length,
  };
}
