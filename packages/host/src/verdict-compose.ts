import type { ObjectiveReceipt, ReceiptOutcome } from "./objective-receipts.js";
import { VERDICT_OPS } from "./objective-record.js";
import { canonicalBytes } from "./objective-types.js";
import type { Criterion, LogEntry, ObjectiveRecord } from "./objective-types.js";
import { nextSeq, sealRecord } from "./objective-write.js";
import type { TeamCommand } from "./team-types.js";
import type { AssessedState, ComposedState, CriterionReason, DeliveryFact, VerdictCounts, VerdictReason, VerdictReport } from "./verdict-types.js";
import { VERDICT_LIMITS } from "./verdict-types.js";

/** A verdict writes only while the log stays within these bounds; otherwise the record write is skipped. */
const VERDICT_LOG = { entries: 300, bytes: 160 * 1024 } as const;

export type ComposeInput = {
  record: ObjectiveRecord;
  head: string;
  kind: "reviewed" | "no-change";
  configured: readonly TeamCommand[];
  /** Step 4's receipts at `head`; undefined when no pass ran there. */
  receipts?: readonly ObjectiveReceipt[];
  /** Host facts at `head`; undefined when the host cannot tell. */
  facts: { checksPassed?: boolean; reviewApproved?: boolean; delivery?: DeliveryFact };
  changedPaths: { paths: readonly string[]; truncated: boolean };
  /** The evaluator's screened report; absent when no evaluator answered, with `reason`. */
  report?: VerdictReport;
  reason?: VerdictReason;
};

export type ComposedCriterion = {
  id: string;
  producer: "host" | "evaluator" | "owner";
  state: ComposedState;
  reason?: CriterionReason;
  evaluatorState?: AssessedState;
  receipt?: { handle: string; outcome: ReceiptOutcome };
  handles: string[];
  note?: string;
  contradicted?: true;
};

export type ComposedVerdict = {
  result: AssessedState;
  evaluatorResult?: AssessedState;
  reason?: VerdictReason;
  criteria: ComposedCriterion[];
  counts: VerdictCounts;
  dropped: { unknownIds: number; handles: number };
};

const FILE_HANDLE = /^file:([^#]+)(?:#L[1-9][0-9]{0,6}(?:-L[1-9][0-9]{0,6})?)?$/;

function safePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** Form and membership only (call 7): the host reads nothing here. */
export function resolveHandle(handle: string, input: Pick<ComposeInput, "receipts" | "changedPaths" | "record">): boolean {
  if (handle.length < 1 || handle.length > VERDICT_LIMITS.handleChars) return false;
  if (handle.startsWith("receipt:")) return (input.receipts ?? []).some(item => item.handle === handle);
  const match = FILE_HANDLE.exec(handle);
  if (match === null) return false;
  const path = match[1]!;
  if (!safePath(path)) return false;
  if (input.changedPaths.paths.includes(path)) return true;
  return input.record.criteria.some(item => item.state === "active" && item.check.kind === "artifact" && item.check.path === path);
}

type Judged = { state: ComposedState; reason?: CriterionReason; receipt?: ComposedCriterion["receipt"] };

/** The receipt kind of a delivery criterion; undefined for every other criterion. */
export function deliveryReceiptOf(criterion: Criterion): "merged" | "landed" | undefined {
  const check = criterion.check;
  return check.kind === "receipt" && (check.receipt === "merged" || check.receipt === "landed") ? check.receipt : undefined;
}

function judgeHost(criterion: Criterion, input: ComposeInput): Judged {
  const check = criterion.check;
  if (check.kind === "command" || check.kind === "artifact") {
    const found = (input.receipts ?? []).filter(item => item.subject === "criterion" && item.id === criterion.id && item.commit === input.head).at(-1);
    if (found === undefined) return { state: "inconclusive", reason: "no-receipt" };
    const receipt = { handle: found.handle, outcome: found.outcome };
    if (found.outcome === "pass") return { state: "met", receipt };
    if (found.outcome === "fail") return { state: "not-met", receipt };
    return { state: "inconclusive", reason: "receipt-unknown", receipt };
  }
  if (check.kind === "receipt") {
    if (check.receipt === "merged" || check.receipt === "landed") {
      const delivery = input.facts.delivery;
      if (delivery === undefined || delivery === "none") return { state: "inconclusive", reason: "before-delivery" };
      return { state: check.receipt === "landed" && delivery === "reverted" ? "not-met" : "met" };
    }
    const fact = check.receipt === "checks-passed" ? input.facts.checksPassed : input.facts.reviewApproved;
    if (fact === undefined) return { state: "inconclusive", reason: "no-receipt" };
    return { state: fact ? "met" : "not-met" };
  }
  return { state: "inconclusive", reason: "no-receipt" };
}

function judgeOwner(criterion: Criterion, input: ComposeInput): Judged {
  const check = criterion.check;
  const threshold = criterion.threshold;
  if (check.kind !== "owner-rating" || threshold.kind !== "score") return { state: "inconclusive", reason: "no-receipt" };
  let newest: { seq: number; score: number } | undefined;
  for (const entry of input.record.log) {
    if (entry.op !== "rating.recorded" || entry.actor !== "owner" || entry.authority !== "direction") continue;
    if (entry.after === undefined || !("inline" in entry.after)) continue;
    const value = entry.after.inline;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const { subject, commit, score } = value as Record<string, unknown>;
    if (subject !== check.subject || commit !== input.head) continue;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    if (newest === undefined || entry.seq > newest.seq) newest = { seq: entry.seq, score };
  }
  if (newest === undefined) return { state: "pending-owner" };
  return { state: newest.score >= threshold.min ? "met" : "not-met" };
}

export function composeVerdict(input: ComposeInput): ComposedVerdict {
  const active = input.record.criteria.filter(item => item.state === "active");
  const activeIds = new Set(active.map(item => item.id));
  const entries = new Map<string, VerdictReport["criteria"][number]>();
  let unknownIds = 0;
  for (const item of input.report?.criteria ?? []) {
    if (!activeIds.has(item.id)) {
      unknownIds += 1;
      continue;
    }
    if (!entries.has(item.id)) entries.set(item.id, item);
  }

  let droppedHandles = 0;
  const criteria: ComposedCriterion[] = [];
  for (const criterion of active) {
    const entry = entries.get(criterion.id);
    const kept: string[] = [];
    let unresolved = false;
    for (const handle of entry?.evidence ?? []) {
      if (resolveHandle(handle, input)) {
        kept.push(handle);
      } else {
        unresolved = true;
        droppedHandles += 1;
      }
    }

    let judged: Judged;
    if (criterion.producer === "host") {
      judged = judgeHost(criterion, input);
    } else if (criterion.producer === "owner") {
      judged = judgeOwner(criterion, input);
    } else if (input.report === undefined) {
      judged = { state: "inconclusive", reason: "no-evaluator" };
    } else if (entry === undefined) {
      judged = { state: "inconclusive", reason: "not-assessed" };
    } else if (unresolved || (entry.state === "met" && kept.length === 0)) {
      judged = { state: "inconclusive", reason: "unresolved-evidence" };
    } else {
      judged = { state: entry.state };
    }

    // Rule 1: a changed pinned file voids `met`. An unknown change list voids it for every pinned criterion.
    const pinned = criterion.pinned ?? [];
    const changed = pinned.length > 0 && (input.changedPaths.truncated || pinned.some(item => input.changedPaths.paths.includes(item.path)));
    if (judged.state === "met" && changed) judged = { ...judged, state: "inconclusive", reason: "pinned-changed" };

    const composed: ComposedCriterion = { id: criterion.id, producer: criterion.producer, state: judged.state, handles: kept };
    if (judged.reason !== undefined) composed.reason = judged.reason;
    if (judged.receipt !== undefined) composed.receipt = judged.receipt;
    if (entry !== undefined) {
      composed.evaluatorState = entry.state;
      if (entry.note !== undefined) composed.note = entry.note;
    }
    // Rule 2: the host state stands; the report's opposite is recorded. An evaluator `inconclusive` is no contradiction.
    if (criterion.producer === "host" && entry !== undefined && deliveryReceiptOf(criterion) === undefined) {
      const hostState = judged.state;
      if ((hostState === "met" && entry.state === "not-met") || (hostState === "not-met" && entry.state === "met")) composed.contradicted = true;
    }
    criteria.push(composed);
  }

  const counts: VerdictCounts = { met: 0, notMet: 0, inconclusive: 0, pendingOwner: 0 };
  for (const item of criteria) {
    if (item.state === "met") counts.met += 1;
    else if (item.state === "not-met") counts.notMet += 1;
    else if (item.state === "inconclusive") counts.inconclusive += 1;
    else counts.pendingOwner += 1;
  }

  // Rule 3. An empty list is never `met`.
  let result: AssessedState = "met";
  if (counts.notMet > 0) result = "not-met";
  else if (counts.inconclusive > 0 || criteria.length === 0) result = "inconclusive";

  const verdict: ComposedVerdict = { result, criteria, counts, dropped: { unknownIds, handles: droppedHandles } };
  if (input.report !== undefined) verdict.evaluatorResult = input.report.result;
  else if (input.reason !== undefined) verdict.reason = input.reason;
  return verdict;
}

type Meta = { verdictId: string; kind: "reviewed" | "no-change"; revision: number; head: string; at: string; supersedes?: string };

/** `latest` on every active criterion and the log entries, sealed at one version with sealRecord; "log-full" when the entries
 *  would pass 300 log entries or 160 KiB. Never writes a note. */
export function verdictRecord(record: ObjectiveRecord, verdict: ComposedVerdict, meta: Meta): ObjectiveRecord | "log-full" {
  const version = record.version + 1;
  const handle = `verdict:${meta.verdictId}`;
  const before: Record<string, { state: ComposedState; verdictId: string } | null> = {};
  const after: Record<string, { state: ComposedState; verdictId: string }> = {};
  const activeIds = new Set(record.criteria.filter(item => item.state === "active").map(item => item.id));
  for (const item of verdict.criteria) {
    const current = record.criteria.find(candidate => candidate.id === item.id);
    if (current === undefined || !activeIds.has(item.id)) continue;
    if (meta.supersedes !== undefined && current.latest?.verdictId !== meta.supersedes) continue;
    before[item.id] = current.latest === undefined ? null : { state: current.latest.state, verdictId: current.latest.verdictId };
    after[item.id] = { state: item.state, verdictId: meta.verdictId };
  }

  const base = nextSeq(record);
  const entries: LogEntry[] = [{
    seq: base, at: meta.at, version, actor: "host", authority: "receipt", op: VERDICT_OPS.recorded, target: "c0", handle,
    before: { inline: { latest: before } },
    after: { inline: { latest: after, result: verdict.result, kind: meta.kind, revision: meta.revision, head: meta.head } },
  }];
  for (const item of verdict.criteria) {
    if (item.contradicted !== true || (item.state !== "met" && item.state !== "not-met")) continue;
    if (item.evaluatorState !== "met" && item.evaluatorState !== "not-met") continue;
    const value: { evaluator: "met" | "not-met"; receipt: "met" | "not-met"; handle?: string } = { evaluator: item.evaluatorState, receipt: item.state };
    if (item.receipt !== undefined) value.handle = item.receipt.handle;
    entries.push({
      seq: base + entries.length, at: meta.at, version, actor: "host", authority: "receipt", op: VERDICT_OPS.contradicted, target: item.id, handle,
      after: { inline: value },
    });
  }

  const log = [...record.log, ...entries];
  if (log.length > VERDICT_LOG.entries || canonicalBytes(log) > VERDICT_LOG.bytes) return "log-full";

  const criteria = record.criteria.map(item => {
    const written = after[item.id];
    return written === undefined ? item : { ...item, latest: written };
  });
  return sealRecord(record, { criteria }, entries);
}
