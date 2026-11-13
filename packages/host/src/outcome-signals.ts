import { createHash } from "node:crypto";
import { canonicalJson } from "./evidence/crypto.js";
import type { EvidenceStore } from "./evidence/store.js";
import { EvidenceError, type EvidenceDb, type EvidenceTx } from "./evidence/types.js";
import {
  type Coverage,
  type Flag,
  type LandingMethod,
  type LinkState,
  levels,
  type Levels,
  type RowSignals,
  type RowState,
  rowExclusion,
  roundCounts,
  scanGap,
} from "./outcome-rules.js";
import {
  type ExclusionReason,
  type OutcomeRow,
  OUTCOMES_MODULE,
  readOutcome,
  readSignal,
  readSummary,
  runOutcomes,
  runSignals,
  type SignalRow,
  writeOutcome,
  writeSignal,
} from "./outcome-store.js";

/** The signals of one row and, for an applied landing, its facts. Pure reads of the stored signals. */
export type RowSignalFacts = { signals: RowSignals; landing?: { at: string; method: LandingMethod; holdUntil: string } };

export type OwnerSignalInput =
  | { action: "record"; kind: "linked-fix"; requestId: string; runId: string; memberId?: string; issue?: string; commit?: string; at?: string }
  | { action: "record"; kind: "exclusion"; requestId: string; runId: string; memberId: string; reason: ExclusionReason }
  | { action: "withdraw"; kind: "linked-fix" | "exclusion"; requestId: string; signalId: string };

export type SignalRequestCode = "request-conflict" | "outcome-not-found" | "signal-not-found" | "signal-not-withdrawable";

export class SignalRequestError extends Error {
  constructor(readonly code: SignalRequestCode, message: string) {
    super(message);
    this.name = "SignalRequestError";
  }
}

const TIME_INVALID = "The signal time is not a date.";
const UNAVAILABLE = "The outcome signals are unavailable.";

type LandingPayload = Extract<SignalRow["payload"], { kind: "landing" }>;

export function landingSignalId(runId: string): string {
  return sha256(`landing:${runId}`);
}

export function revertSignalId(landingSignalId: string, commit: string): string {
  return sha256(`revert:${landingSignalId}:${commit}`);
}

export function ownerSignalId(requestId: string): string {
  return sha256(`owner:${requestId}`);
}

export function ratingSignalId(eventKey: string): string {
  return sha256(`rating:${eventKey}`);
}

/**
 * The signals that apply to one row, from the run's active signals only. The run's landing applies when the row's
 * review accepted it. A fix counts when the run has no landing, or when it is no later than the landing's close.
 */
export function rowSignals(db: EvidenceDb, row: OutcomeRow): RowSignalFacts {
  const active = runSignals(db, row.runId).filter(signal => signal.state === "active");
  const excluded = active.some(signal => signal.payload.kind === "exclusion" && signal.outcomeId === row.outcomeId);
  let landing: { signal: SignalRow; payload: LandingPayload } | undefined;
  for (const signal of active) {
    if (signal.payload.kind === "landing") landing = { signal, payload: signal.payload };
  }
  const close = landing === undefined ? undefined : Date.parse(landing.payload.holdUntil);
  const counts = (fix: SignalRow) => close === undefined || Date.parse(fix.at) <= close;
  const accepted = row.acceptance === 1;
  let negative = false;
  for (const signal of active) {
    if (signal.payload.kind === "revert") {
      const reverts = accepted && landing !== undefined && signal.payload.landingSignalId === landing.signal.signalId;
      if (reverts && Date.parse(signal.at) <= (close ?? Number.NaN)) negative = true;
    } else if (signal.payload.kind === "linked-fix" && counts(signal)) {
      if (signal.outcomeId === row.outcomeId && row.disposition === "integrated") negative = true;
      if (signal.outcomeId === null && accepted) negative = true;
    }
  }
  if (landing === undefined || !accepted) return { signals: { excluded, negative } };
  const coverage: Coverage = landing.payload.window?.state ?? "open";
  return {
    signals: { excluded, negative, landing: coverage },
    landing: { at: landing.signal.at, method: landing.payload.method, holdUntil: landing.payload.holdUntil },
  };
}

/**
 * Writes a row with its levels, exclusion, round counts, scan-gap flag, and hold fields recomputed from the stored
 * facts. It never changes `acceptance`, the review's own fact. A row without `acceptance` takes `accepted` first.
 */
export function saveOutcomeRow(tx: EvidenceTx, row: OutcomeRow): void {
  row.acceptance = row.acceptance === undefined ? row.accepted : row.acceptance;
  const links = linksOf(tx, row.outcomeId);
  const facts = rowSignals(tx, row);
  const state: RowState = {
    role: row.role,
    disposition: row.disposition,
    accepted: row.acceptance,
    links,
    signals: facts.signals,
  };
  const computed: Levels = levels(state);
  row.integrated = computed.integrated;
  row.accepted = computed.accepted;
  row.firstPass = computed.firstPass;
  row.held = computed.held;
  row.exclusion = rowExclusion(row.disposition, facts.signals) ?? null;
  row.payload.rounds = roundCounts(links);
  const flags: Flag[] = row.flags.filter(flag => flag !== "scan-gap");
  if (scanGap(state)) flags.push("scan-gap");
  row.flags = flags.sort();
  row.holdUntil = facts.landing?.holdUntil ?? null;
  if (facts.landing) row.payload.landing = { at: facts.landing.at, method: facts.landing.method };
  else delete row.payload.landing;
  writeOutcome(tx, row);
}

/** Saves every row of a run, deleted runs included. It writes no summary. */
export function recomputeRun(tx: EvidenceTx, runId: string): void {
  for (const row of runOutcomes(tx, runId)) saveOutcomeRow(tx, row);
}

/** The owner's claim with one request id. It is recorded or withdrawn in one write, and repeats are idempotent. */
export function ownerSignal(store: EvidenceStore, input: OwnerSignalInput, now: string): { signal: SignalRow; repeated: boolean } {
  if (store.status().modules[OUTCOMES_MODULE] !== "ready") throw new EvidenceError("unavailable", UNAVAILABLE);
  return store.write(tx => {
    if (input.action === "withdraw") return withdrawSignal(tx, input, now);
    return recordSignal(tx, input, now);
  });
}

function recordSignal(
  tx: EvidenceTx,
  input: Extract<OwnerSignalInput, { action: "record" }>,
  now: string,
): { signal: SignalRow; repeated: boolean } {
  const signalId = ownerSignalId(input.requestId);
  const request = sha256(canonicalJson(withoutRequestId(input)));
  const stored = readSignal(tx, signalId);
  if (stored !== undefined) {
    if ("request" in stored.payload && stored.payload.request === request) return { signal: stored, repeated: true };
    throw new SignalRequestError("request-conflict", "The request id names another request.");
  }
  const summary = readSummary(tx, input.runId);
  const rows = runOutcomes(tx, input.runId);
  if (summary === undefined && rows.length === 0) {
    throw new SignalRequestError("outcome-not-found", "The run has no outcome rows.");
  }
  const outcomeId = input.memberId === undefined ? null : `${input.runId}:${input.memberId}`;
  if (outcomeId !== null && readOutcome(tx, outcomeId) === undefined) {
    throw new SignalRequestError("outcome-not-found", "The member has no outcome row.");
  }
  const at = input.kind === "exclusion" ? now : (input.at ?? now);
  const time = Date.parse(at);
  if (Number.isNaN(time)) throw new EvidenceError("invalid-event", TIME_INVALID);
  const payload: SignalRow["payload"] = input.kind === "exclusion"
    ? { kind: "exclusion", reason: input.reason, request }
    : {
      kind: "linked-fix",
      ...(input.issue === undefined ? {} : { issue: input.issue }),
      ...(input.commit === undefined ? {} : { commit: input.commit }),
      request,
    };
  const signal: SignalRow = {
    signalId,
    runId: input.runId,
    outcomeId,
    kind: input.kind,
    author: "owner",
    authority: "claim",
    state: "active",
    at: new Date(time).toISOString(),
    payload,
  };
  writeSignal(tx, signal);
  recomputeRun(tx, input.runId);
  return { signal, repeated: false };
}

function withdrawSignal(
  tx: EvidenceTx,
  input: Extract<OwnerSignalInput, { action: "withdraw" }>,
  now: string,
): { signal: SignalRow; repeated: boolean } {
  const stored = readSignal(tx, input.signalId);
  if (stored === undefined) throw new SignalRequestError("signal-not-found", "The signal does not exist.");
  const payload = stored.payload;
  if (stored.author !== "owner" || stored.kind !== input.kind || (payload.kind !== "linked-fix" && payload.kind !== "exclusion")) {
    throw new SignalRequestError("signal-not-withdrawable", "The signal cannot be withdrawn.");
  }
  if (stored.state === "withdrawn") return { signal: stored, repeated: true };
  const signal: SignalRow = { ...stored, state: "withdrawn", payload: { ...payload, withdrawnAt: now } };
  writeSignal(tx, signal);
  recomputeRun(tx, stored.runId);
  return { signal, repeated: false };
}

/** The input without its request id and without the keys that are undefined, so that the request hash is stable. */
function withoutRequestId(input: Extract<OwnerSignalInput, { action: "record" }>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => key !== "requestId" && value !== undefined));
}

/** The link states of one row, in revision and round order. */
export function linksOf(tx: EvidenceDb, id: string): LinkState[] {
  return tx.all<{ state: string }>("SELECT state FROM outcome_round_links WHERE outcome_id=? ORDER BY revision, round", id)
    .map(row => row.state as LinkState);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
