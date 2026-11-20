import { findSecret } from "./evidence/secret-scan.js";
import { commandDigest, CORRECTION_LIMITS } from "./objective-input.js";
import type { CheckInput, Correction, CorrectionOp, CriterionInput } from "./objective-input.js";
import { objectiveError, logValue, type ObjectiveErrorCode } from "./objective-record.js";
import { OBJECTIVE_LIMITS, canonicalBytes, cappedBytes, objectiveRecordSchema, producerOf, recordDigest, thresholdFits } from "./objective-types.js";
import type { Assumption, Check, Criterion, LogEntry, ObjectiveRecord, Threshold } from "./objective-types.js";
import { recordDigestFor } from "./objective-digest.js";
import { RECORD_DIGEST_BYTES, recordDigestBytes } from "./team-types.js";
import type { TeamCommand } from "./team-types.js";

/** Corrections leave this much of OBJECTIVE_LIMITS' log for steering: 20 entries and 46 KiB. */
export const CORRECTION_LOG = { entries: 380, bytes: 210 * 1024 } as const;
export type OwnerOpContext = { configured: readonly TeamCommand[]; requestId: string; at: string;
  /** The goal's latest reviewed cycle; a rating without it is refused. */
  rating?: { commit: string; cycle: number } };
/** The two register ops, which need the register switch on. */
export const REGISTER_OP_NAMES: ReadonlySet<CorrectionOp["op"]> = new Set<CorrectionOp["op"]>(["assumption.set", "rating.record"]);
/** Assumptions and ratings write at most this many changed assumptions per log entry. */
const CHANGES_PER_ENTRY = 8;

const L = OBJECTIVE_LIMITS;
type EditOp = Extract<CorrectionOp, { op: "criterion.edit" }>;

function fail(code: ObjectiveErrorCode): never {
  throw objectiveError(code);
}

/** Every op or none, one version up. Throws objectiveError with a fixed code; the input record is never changed. */
export function applyOwnerOps(record: ObjectiveRecord, correction: Pick<Correction, "version" | "ops">, context: OwnerOpContext): ObjectiveRecord {
  if (correction.version !== record.version) fail("objective-version-stale");
  return applyOps(record, correction.ops, record.version + 1, context);
}

/** Owner criteria of version 1: ids c1 onward, each logged `criterion.added` at version 1. */
export function addCreationCriteria(record: ObjectiveRecord, inputs: readonly CriterionInput[], context: OwnerOpContext): ObjectiveRecord {
  return applyOps(record, inputs.map(criterion => ({ op: "criterion.add", criterion })), record.version, context);
}

/** One criterion from an add: its check resolved, its producer and threshold fitted, and its size bounded. */
export function criterionFromInput(input: CriterionInput, id: string, configured: readonly TeamCommand[]): Criterion {
  const check = checkOf(input.check, configured);
  if (input.producer !== undefined && input.producer !== producerOf(check)) fail("objective-criterion-misfit");
  return verified({ id, origin: "owner", statement: input.statement, check, producer: producerOf(check), threshold: input.threshold, state: "active" });
}

/**
 * Takes `prefix` off the evidence and puts `handle` last. The earlier handle with that prefix, if any, is `replaced` with its
 * index, so the rebuild can put it back. Each writer keeps one handle per prefix.
 */
export function withHandle(evidence: readonly string[], prefix: string, handle: string): { evidence: string[]; replaced?: { handle: string; at: number } } {
  const at = evidence.findIndex(item => item.startsWith(prefix));
  const kept = evidence.filter((_, index) => index !== at);
  if (at === -1) return { evidence: [...kept, handle] };
  return { evidence: [...kept, handle], replaced: { handle: evidence[at]!, at } };
}

/** `c` and one more than the highest number among every criterion id, retired ones included. Ids are never reused. */
export function nextCriterionId(record: ObjectiveRecord): string {
  return nextId(record.criteria);
}

function nextId(criteria: readonly Criterion[]): string {
  const highest = criteria.reduce((max, item) => {
    const match = /^c(\d+)$/.exec(item.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `c${highest + 1}`;
}

/** The check an owner names, as the record stores it: a command by its digest, which must be one of the configured checks. */
function checkOf(input: CheckInput, configured: readonly TeamCommand[]): Check {
  if (input.kind !== "command") return input;
  const digest = commandDigest(input.run);
  if (!configured.some(command => commandDigest(command) === digest)) fail("objective-command-unknown");
  return { kind: "command", command: digest };
}

/**
 * A criterion's threshold must fit its check, and it must fit one log value in its retired form too: a retire logs the
 * active criterion as `before`, and the retired one as `after`, so the retired form is the larger one (`retired` is a
 * byte longer than `active`). A criterion that passes here can always be retired inline.
 */
function verified(criterion: Criterion): Criterion {
  if (!thresholdFits(criterion.check, criterion.threshold)) fail("objective-criterion-misfit");
  if (canonicalBytes({ ...criterion, state: "retired" }) > CORRECTION_LIMITS.criterionCanonicalBytes) fail("objective-criterion-too-large");
  return criterion;
}

function editOf(current: Criterion, op: EditOp, configured: readonly TeamCommand[]): Criterion {
  const check = op.check !== undefined ? checkOf(op.check, configured) : current.check;
  return verified({
    id: current.id,
    origin: "owner",
    statement: op.statement ?? current.statement,
    check,
    producer: producerOf(check),
    threshold: op.threshold ?? current.threshold,
    state: "active",
  });
}

/**
 * The ops, applied in order to a copy of the record, which is then sealed at `version`. The order of the checks is fixed:
 * the secret scan over every op, then each op's target, check, fit, and size, then the whole record's counts, log room,
 * bytes, digest, and schema. The first refusal is the one reported, and nothing is returned for it.
 */
function applyOps(record: ObjectiveRecord, ops: readonly CorrectionOp[], version: number, context: OwnerOpContext): ObjectiveRecord {
  if (findSecret(ops, { token: "", url: "" })) fail("objective-secret");

  let criteria: Criterion[] = [...record.criteria];
  let assumptions: Assumption[] = [...record.assumptions];
  const entries: LogEntry[] = [];
  let seq = (record.log[record.log.length - 1]?.seq ?? 0) + 1;
  const log = (op: string, id: string, before: Criterion | undefined, after: Criterion): void => {
    const entry: LogEntry = {
      seq: seq++, at: context.at, version, actor: "owner", authority: "direction", op, target: id, handle: context.requestId,
      after: logValue(after, `record:criterion:${id}`),
    };
    if (before !== undefined) entry.before = logValue(before, `record:criterion:${id}`);
    entries.push(entry);
  };
  const register = (op: string, target: string, before: unknown, after: unknown, ref: string): void => {
    const entry: LogEntry = {
      seq: seq++, at: context.at, version, actor: "owner", authority: "direction", op, target, handle: context.requestId,
      after: logValue(after, ref),
    };
    if (before !== undefined) entry.before = logValue(before, ref);
    entries.push(entry);
  };

  for (const op of ops) {
    if (op.op === "assumption.set") {
      // An owner test is the only kind no host test reaches, so only it takes an owner's status. A member's assumption waits for adoption.
      const target = record.assumptions.find(item => item.id === op.id);
      if (target?.test.kind !== "owner" || target.origin === "member") fail("objective-assumption-target");
      const index = assumptions.findIndex(item => item.id === op.id);
      const current = assumptions[index]!;
      const handle = withHandle(current.evidence, "owner:", `owner:${context.requestId}`);
      const before: Record<string, unknown> = { status: current.status };
      if (current.ownerPinned !== undefined) before.ownerPinned = current.ownerPinned;
      if (handle.replaced !== undefined) before.replaced = handle.replaced;
      assumptions = assumptions.map((item, position) => (position === index ? { ...current, status: op.status, ownerPinned: true, evidence: handle.evidence } : item));
      register("assumption.set", op.id, before, { status: op.status }, `record:assumption:${op.id}`);
      continue;
    }
    if (op.op === "rating.record") {
      const named = record.criteria.some(item => item.state === "active" && item.check.kind === "owner-rating" && item.check.subject === op.subject)
        || record.assumptions.some(item => item.origin !== "member" && item.test.kind === "owner" && item.test.rating?.subject === op.subject);
      if (!named) fail("objective-rating-subject");
      if (context.rating === undefined) fail("objective-rating-no-head");
      // Unpinned owner tests that name the subject take the rating; a pinned one keeps its owner value, and a member's waits for adoption.
      const affected: { index: number; below: number }[] = [];
      assumptions.forEach((item, index) => {
        if (item.ownerPinned !== true && item.origin !== "member" && item.test.kind === "owner" && item.test.rating?.subject === op.subject) {
          affected.push({ index, below: item.test.rating.below });
        }
      });
      const chunks: { index: number; below: number }[][] = [];
      for (let start = 0; start < affected.length; start += CHANGES_PER_ENTRY) chunks.push(affected.slice(start, start + CHANGES_PER_ENTRY));
      if (chunks.length === 0) chunks.push([]);
      for (const chunk of chunks) {
        const before: { id: string; status: Assumption["status"]; replaced?: { handle: string; at: number } }[] = [];
        const changed: { id: string; status: Assumption["status"] }[] = [];
        for (const { index, below } of chunk) {
          const current = assumptions[index]!;
          const status = op.score < below ? "refuted" : "verified";
          const handle = withHandle(current.evidence, "rating:", `rating:${context.requestId}`);
          before.push(handle.replaced === undefined ? { id: current.id, status: current.status } : { id: current.id, status: current.status, replaced: handle.replaced });
          changed.push({ id: current.id, status });
          assumptions = assumptions.map((item, position) => (position === index ? { ...current, status, evidence: handle.evidence } : item));
        }
        const score = op.score;
        register("rating.recorded", op.subject, { assumptions: before }, {
          subject: op.subject, score, commit: context.rating.commit, cycle: context.rating.cycle, changed,
        }, `record:rating:${op.subject}`);
      }
      continue;
    }
    if (op.op === "criterion.add") {
      const created = criterionFromInput(op.criterion, nextId(criteria), context.configured);
      criteria = [...criteria, created];
      log("criterion.added", created.id, undefined, created);
      continue;
    }
    // Targets resolve against the input record, so an op cannot act on a criterion that an earlier op of the same correction adds.
    const current = record.criteria.find(item => item.id === op.id);
    if (current === undefined || current.state !== "active") fail("objective-op-target");
    const index = criteria.findIndex(item => item.id === op.id);
    if (op.op === "criterion.confirm") {
      if (current.origin !== "derived") fail("objective-op-target");
      const confirmed: Criterion = { ...current, origin: "owner" };
      delete confirmed.derivedFrom;
      criteria[index] = confirmed;
      log("criterion.confirmed", current.id, current, confirmed);
      continue;
    }
    if (current.id === "c0") fail("objective-op-c0");
    if (op.op === "criterion.retire") {
      const retired: Criterion = { ...current, state: "retired" };
      criteria[index] = retired;
      log("criterion.retired", current.id, current, retired);
      continue;
    }
    const edited = editOf(current, op, context.configured);
    criteria[index] = edited;
    log("criterion.edited", current.id, current, edited);
  }

  if (criteria.filter(item => item.state === "active").length > L.activeCriteria || criteria.length > L.criteria) {
    fail("objective-criteria-limit");
  }
  const fullLog = [...record.log, ...entries];
  if (record.log.length + entries.length > CORRECTION_LOG.entries || canonicalBytes(fullLog) > CORRECTION_LOG.bytes) {
    fail("objective-log-full");
  }

  const body = { ...record, version, criteria, assumptions, log: fullLog };
  const sealed: ObjectiveRecord = { ...body, digest: recordDigest(body) };
  if (cappedBytes(sealed) > L.cappedBytes) fail("objective-too-large");
  if (recordDigestBytes(recordDigestFor(sealed, context.configured)) > RECORD_DIGEST_BYTES) fail("objective-digest-too-large");
  if (!objectiveRecordSchema.safeParse(sealed).success) fail("objective-op-refused");
  return sealed;
}
