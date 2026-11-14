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
  type ScanGap,
  scanGap,
} from "./outcome-rules.js";
import {
  APPROVAL_DAYS,
  COMMIT_ID,
  HOLD_DAYS_MAX,
  holdUntil,
  type Landing,
  type LandingCandidate,
  type LandedRun,
  landedIds,
  type RevertMatch,
  windowCoverage,
} from "./outcome-hold.js";
import {
  checkScan,
  type ExclusionReason,
  landingCandidates,
  lastScan,
  type OutcomeRow,
  OUTCOMES_MODULE,
  projectLandings,
  readOutcome,
  readScanState,
  readSignal,
  readSummary,
  runOutcomes,
  runSignals,
  type RunSummaryPayload,
  scanPoints,
  type ScanRow,
  type SignalRow,
  writeOutcome,
  writeScan,
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

const DAY_MS = 86_400_000;
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

/** What a base branch scan needs from the store before it reads Git. Summaries and landings are read in one pass. */
export type ScanInputs = {
  state?: { seq: number; head: string; repository: string; baseBranch: string; lastAt: string };
  candidates: LandingCandidate[];
  open: LandedRun[];
};

/**
 * The scan's inputs for a project at `at`. A candidate is a run approved in the last `APPROVAL_DAYS` with no active
 * landing. A reported id is used only when it is a commit id, since the reported merge commit is agent-reported text.
 */
export function scanInputs(db: EvidenceDb, projectId: string, at: string): ScanInputs {
  const ref = db.index("project", projectId);
  const stored = readScanState(db, ref);
  const last = lastScan(db, ref);
  const state = stored === undefined || last === undefined ? undefined : {
    seq: stored.seq,
    head: stored.payload.head,
    repository: stored.payload.repository,
    baseBranch: stored.payload.baseBranch,
    lastAt: last.at,
  };
  const candidates = landingCandidates(db, ref, daysBefore(at, APPROVAL_DAYS))
    .map(({ runId, payload }) => candidateOf(runId, payload));
  const atMs = Date.parse(at);
  const open: LandedRun[] = [];
  for (const signal of projectLandings(db, ref, daysBefore(at, HOLD_DAYS_MAX + APPROVAL_DAYS))) {
    if (signal.payload.kind !== "landing") continue;
    const { commit, method, reviewedHead, holdUntil: close } = signal.payload;
    if (Date.parse(close) < atMs) continue;
    open.push({ runId: signal.runId, signalId: signal.signalId, ids: landedIds(method, commit, reviewedHead), holdUntil: close });
  }
  return { ...(state === undefined ? {} : { state }), candidates, open };
}

function candidateOf(runId: string, payload: RunSummaryPayload): LandingCandidate {
  const { reviewedHead, reviewedTree, mergeCommit } = payload;
  return {
    runId,
    ...(reviewedHead !== undefined && COMMIT_ID.test(reviewedHead) ? { reviewedHead } : {}),
    ...(reviewedTree !== undefined && COMMIT_ID.test(reviewedTree) ? { reviewedTree } : {}),
    ...(mergeCommit !== undefined && COMMIT_ID.test(mergeCommit) ? { mergeCommit } : {}),
  };
}

export type ScanWrite = {
  projectId: string;
  repository: string;
  baseBranch: string;
  at: string;
  head: string;
  from?: string;
  oldest?: string;
  commits: number;
  gap: ScanGap | null;
  expectedSeq: number;
  landings: readonly Landing[];
  reverts: readonly RevertMatch[];
  holdDays: number;
};

/**
 * One base branch scan, written in the caller's transaction. It applies only when the stored seq is `expectedSeq` and
 * `at` is not before the last scan's. A run keeps its first landing. A revert counts only while its landing is open at
 * `at`. Verdicts are stored once, and then the touched runs are recomputed.
 */
export function applyScan(tx: EvidenceTx, scan: ScanWrite): { applied: boolean; seq: number } {
  const ref = tx.index("project", scan.projectId);
  const current = readScanState(tx, ref)?.seq ?? 0;
  const last = lastScan(tx, ref);
  const time = Date.parse(scan.at);
  if (scan.expectedSeq !== current || Number.isNaN(time) || (last !== undefined && time < Date.parse(last.at))) {
    return { applied: false, seq: current };
  }
  const seq = current + 1;
  const payload: ScanRow["payload"] = {
    ...(scan.from === undefined ? {} : { from: scan.from }),
    to: scan.head,
    ...(scan.oldest === undefined ? {} : { oldest: scan.oldest }),
  };
  writeScan(
    tx,
    { projectRef: ref, seq, at: scan.at, checkedAt: scan.at, commits: scan.commits, gap: scan.gap, payload },
    { projectRef: ref, seq, payload: { head: scan.head, repository: scan.repository, baseBranch: scan.baseBranch } },
  );
  const touched = new Set<string>();
  for (const landing of scan.landings) {
    const signalId = landingSignalId(landing.runId);
    if (hasSignal(tx, signalId)) continue;
    writeSignal(tx, {
      signalId,
      runId: landing.runId,
      outcomeId: null,
      kind: "landing",
      author: "host",
      authority: "receipt",
      state: "active",
      at: scan.at,
      payload: {
        kind: "landing",
        commit: landing.commit,
        method: landing.method,
        scanSeq: seq,
        holdDays: scan.holdDays,
        holdUntil: holdUntil(scan.at, scan.holdDays),
        ...(landing.reviewedHead === undefined ? {} : { reviewedHead: landing.reviewedHead }),
      },
    });
    touched.add(landing.runId);
  }
  for (const match of scan.reverts) {
    const landing = readSignal(tx, match.signalId);
    if (landing === undefined || landing.state !== "active" || landing.payload.kind !== "landing") continue;
    if (Date.parse(landing.payload.holdUntil) < time) continue;
    const signalId = revertSignalId(match.signalId, match.commit);
    if (hasSignal(tx, signalId)) continue;
    writeSignal(tx, {
      signalId,
      runId: match.runId,
      outcomeId: null,
      kind: "revert",
      author: "host",
      authority: "receipt",
      state: "active",
      at: scan.at,
      payload: {
        kind: "revert",
        commit: match.commit,
        reverts: match.reverts,
        landingSignalId: match.signalId,
        scanSeq: seq,
      },
    });
    touched.add(match.runId);
  }
  for (const runId of decideWindows(tx, ref, scan.at)) touched.add(runId);
  for (const runId of touched) recomputeRun(tx, runId);
  return { applied: true, seq };
}

/**
 * A check that a refresh confirmed the project's newest scan at `at`. It applies only at the stored seq and head. It
 * then stores the window verdicts that are now decided, and recomputes their runs.
 */
export function applyCheck(tx: EvidenceTx, check: { projectId: string; head: string; at: string; expectedSeq: number }): { applied: boolean } {
  const ref = tx.index("project", check.projectId);
  const state = readScanState(tx, ref);
  if (state === undefined || state.seq !== check.expectedSeq || state.payload.head !== check.head) return { applied: false };
  if (Number.isNaN(Date.parse(check.at))) return { applied: false };
  checkScan(tx, ref, state.seq, check.at);
  for (const runId of decideWindows(tx, ref, check.at)) recomputeRun(tx, runId);
  return { applied: true };
}

/**
 * Stores the verdict of each active landing of the project that has none yet, when its window is covered or has a gap.
 * An open window stores nothing. Returns the runs decided.
 */
function decideWindows(tx: EvidenceTx, ref: string, at: string): string[] {
  const decided: string[] = [];
  for (const signal of projectLandings(tx, ref, daysBefore(at, HOLD_DAYS_MAX + APPROVAL_DAYS))) {
    if (signal.payload.kind !== "landing" || signal.payload.window !== undefined) continue;
    const payload = signal.payload;
    const coverage = windowCoverage(scanPoints(tx, ref, payload.scanSeq, payload.holdUntil), payload.holdUntil);
    if (coverage === "open") continue;
    writeSignal(tx, { ...signal, payload: { ...payload, window: { state: coverage, decidedAt: at } } });
    decided.push(signal.runId);
  }
  return decided;
}

/** Whether a signal row exists, whatever its payload reads as. */
function hasSignal(tx: EvidenceDb, signalId: string): boolean {
  return tx.get("SELECT 1 AS found FROM outcome_signals WHERE signal_id=?", signalId) !== undefined;
}

function daysBefore(at: string, days: number): string {
  return new Date(Date.parse(at) - days * DAY_MS).toISOString();
}
