import { createHash } from "node:crypto";
import { canonicalJson } from "./evidence/crypto.js";
import type { StreamRead } from "./git-stream.js";
import { parseCitation, qualifyingEntries, quotePresent } from "./objective-citations.js";
import { commandDigest } from "./objective-input.js";
import type { AssumptionTest, Check, Criterion, ObjectiveRecord, Threshold } from "./objective-types.js";
import type { TeamCheck, TeamCommand } from "./team-types.js";

export const PASS_LIMITS = { subjects: 40, reads: 40 } as const;
export type PassKind = "reviewed" | "check";
export type ReceiptKind = "command" | "artifact" | "citation";
export type ReceiptOutcome = "pass" | "fail" | "unknown";
export type ReadState = "read" | "too-large" | "read-failed" | "not-run";
export type ReceiptDetail =
  | { kind: "command"; observed: "passed" | "failed" | "interrupted" | "running" | "absent" | "not-configured"; round?: number }
  | { kind: "artifact"; read: ReadState; problem?: "not-text" | "not-json" | "no-array" | "threshold-misfit" | "schema-deferred" | "empty" | "deadline" | "stalled";
      total?: number; qualifying?: number }
  | { kind: "citation"; read: ReadState; problem?: "outside-unchecked" | "malformed" | "not-text" | "deadline" | "stalled"; present?: boolean };
export type ObjectiveReceipt = {
  handle: string;
  kind: ReceiptKind; subject: "criterion" | "assumption"; id: string;
  commit: string; outcome: ReceiptOutcome; at: string; detail: ReceiptDetail; digest?: string;
};
export type Subject =
  | { subject: "criterion"; id: string; check: Extract<Check, { kind: "command" | "artifact" }>; threshold: Threshold; pinned?: Criterion["pinned"] }
  | { subject: "assumption"; id: string; test: Extract<AssumptionTest, { kind: "command" | "artifact" | "citation" }> };
export type BlobResult = StreamRead | { state: "not-run"; why: "deadline" | "stalled" };
export type PassInput = {
  runId: string; revision: number; kind: PassKind; head: string; at: string;
  checks: readonly TeamCheck[]; configured: readonly TeamCommand[]; blobs: ReadonlyMap<string, BlobResult>;
};

type CommandObserved = Extract<ReceiptDetail, { kind: "command" }>["observed"];
type Target = { commit: string; path: string };
type Rounds = { number?: number; rows: readonly TeamCheck[]; configured: ReadonlySet<string> };
type Result = { commit: string; outcome: ReceiptOutcome; detail: ReceiptDetail };

const isCommandOrArtifact = (check: Check): check is Extract<Check, { kind: "command" | "artifact" }> =>
  check.kind === "command" || check.kind === "artifact";

export function passSubjects(record: ObjectiveRecord, kind: PassKind): Subject[] {
  const subjects: Subject[] = [];
  for (const criterion of record.criteria) {
    if (criterion.state !== "active" || !isCommandOrArtifact(criterion.check)) continue;
    if (kind === "check" && criterion.check.kind !== "command") continue;
    subjects.push({ subject: "criterion", id: criterion.id, check: criterion.check, threshold: criterion.threshold, ...(criterion.pinned === undefined ? {} : { pinned: criterion.pinned }) });
  }
  for (const assumption of record.assumptions) {
    const { test } = assumption;
    if (assumption.origin === "member" || test.kind === "owner") continue;
    if (kind === "check" && test.kind !== "command") continue;
    subjects.push({ subject: "assumption", id: assumption.id, test });
  }
  return subjects.slice(0, PASS_LIMITS.subjects);
}

export function passReads(subjects: readonly Subject[], head: string): Target[] {
  const seen = new Set<string>();
  const reads: Target[] = [];
  for (const subject of subjects) {
    const target = targetOf(subject, head);
    if (target === undefined) continue;
    const key = `${target.commit}:${target.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reads.push(target);
    if (reads.length === PASS_LIMITS.reads) break;
  }
  return reads;
}

function targetOf(subject: Subject, head: string): Target | undefined {
  if (subject.subject === "criterion") {
    return subject.check.kind === "artifact" ? { commit: head, path: subject.check.path } : undefined;
  }
  const { test } = subject;
  if (test.kind === "artifact") return { commit: head, path: test.path };
  if (test.kind === "citation") {
    const citation = parseCitation(test.source);
    if (citation?.kind === "repository") return { commit: citation.commit ?? head, path: citation.path };
  }
  return undefined;
}

export function definitionDigest(criterion: Pick<Criterion, "check" | "threshold" | "pinned">): string {
  return createHash("sha256").update(canonicalJson({ check: criterion.check, threshold: criterion.threshold, pinned: criterion.pinned ?? null })).digest("hex");
}

export function receiptsFor(subjects: readonly Subject[], input: PassInput): ObjectiveReceipt[] {
  const rounds = roundsOf(input);
  return subjects.map(subject => {
    const result = resultOf(subject, input, rounds);
    return {
      handle: `receipt:${input.runId}:${input.revision}:${subject.id}`,
      kind: result.detail.kind, subject: subject.subject, id: subject.id,
      commit: result.commit, outcome: result.outcome, at: input.at, detail: result.detail,
      ...(subject.subject === "criterion" ? { digest: definitionDigest(subject) } : {}),
    };
  });
}

function roundsOf(input: PassInput): Rounds {
  const atRevision = input.checks.filter(check => check.revision === input.revision);
  const number = atRevision.length === 0 ? undefined : Math.max(...atRevision.map(check => check.round ?? 0));
  const final = atRevision.filter(check => (check.round ?? 0) === number);
  const rows = input.kind === "reviewed" ? final.filter(check => check.headCommit === input.head) : final;
  return { number, rows, configured: new Set(input.configured.map(commandDigest)) };
}

function resultOf(subject: Subject, input: PassInput, rounds: Rounds): Result {
  if (subject.subject === "criterion") {
    const { check } = subject;
    if (check.kind === "command") return commandResult(subject, check.command, input, rounds);
    return artifactResult({
      path: check.path, pointer: check.count, schema: check.schema, threshold: subject.threshold, criterion: true,
    }, input);
  }
  const { test } = subject;
  if (test.kind === "command") return commandResult(subject, test.command, input, rounds);
  if (test.kind === "artifact") {
    return artifactResult({
      path: test.path, pointer: test.count, threshold: test.threshold, citedPerEntry: test.citedPerEntry, criterion: false,
    }, input);
  }
  return citationResult(test, input);
}

function commandResult(subject: Subject, digest: string, input: PassInput, rounds: Rounds): Result {
  const configured = rounds.configured.has(digest);
  const entry = rounds.rows.find(check => check.phase === undefined && commandDigest(check.command) === digest);
  const observed = !configured ? "not-configured" : entry === undefined ? "absent" : entry.status;
  const detail: ReceiptDetail = rounds.number === undefined
    ? { kind: "command", observed }
    : { kind: "command", observed, round: rounds.number };
  return { commit: entry?.headCommit ?? input.head, outcome: configured ? commandOutcome(subject, observed) : "unknown", detail };
}

function commandOutcome(subject: Subject, observed: CommandObserved): ReceiptOutcome {
  if (observed !== "passed" && observed !== "failed") return "unknown";
  const passed = observed === "passed";
  if (subject.subject === "criterion") return passed ? "pass" : "fail";
  if (subject.test.kind !== "command") return "unknown";
  return (subject.test.refutesOn === "fail") === passed ? "pass" : "fail";
}

type ArtifactSpec = {
  path: string; pointer?: string; schema?: string; threshold: Threshold; citedPerEntry?: number; criterion: boolean;
};

function artifactResult(spec: ArtifactSpec, input: PassInput): Result {
  const blob = blobOf(input, input.head, spec.path);
  const unknown = (detail: ReceiptDetail): Result => ({ commit: input.head, outcome: "unknown", detail });
  if (blob.state !== "read") return unknown({ kind: "artifact", ...unreadOf(blob) });
  if (spec.schema !== undefined) return unknown({ kind: "artifact", read: "read", problem: "schema-deferred" });
  if (spec.pointer === undefined) return { commit: input.head, outcome: "pass", detail: { kind: "artifact", read: "read" } };
  const { threshold } = spec;
  if (threshold.kind === "pass" || threshold.kind === "score" || (threshold.kind === "share" && spec.citedPerEntry === undefined)) {
    return unknown({ kind: "artifact", read: "read", problem: "threshold-misfit" });
  }
  const text = decodeStrict(blob.bytes);
  if (text === undefined) return unknown({ kind: "artifact", read: "read", problem: "not-text" });
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return unknown({ kind: "artifact", read: "read", problem: "not-json" });
  }
  const array = pointerTarget(document, spec.pointer);
  if (!Array.isArray(array)) return unknown({ kind: "artifact", read: "read", problem: "no-array" });
  const total = array.length;
  if (threshold.kind === "share" && total === 0) return unknown({ kind: "artifact", read: "read", problem: "empty" });
  const qualifying = spec.citedPerEntry === undefined ? undefined : qualifyingEntries(array, spec.citedPerEntry);
  const counts = qualifying === undefined ? { total } : { total, qualifying };
  const compared = qualifying ?? total;
  const holds = threshold.kind === "share"
    ? (qualifying ?? 0) / total >= threshold.min
    : (threshold.min === undefined || compared >= threshold.min) && (threshold.max === undefined || compared <= threshold.max);
  return { commit: input.head, outcome: holds ? "pass" : "fail", detail: { kind: "artifact", read: "read", ...counts } };
}

function citationResult(test: Extract<AssumptionTest, { kind: "citation" }>, input: PassInput): Result {
  const citation = parseCitation(test.source);
  if (citation === undefined) return { commit: input.head, outcome: "unknown", detail: { kind: "citation", read: "not-run", problem: "malformed" } };
  if (citation.kind === "outside") {
    return { commit: input.head, outcome: "unknown", detail: { kind: "citation", read: "not-run", problem: "outside-unchecked" } };
  }
  const commit = citation.commit ?? input.head;
  const blob = blobOf(input, commit, citation.path);
  if (blob.state !== "read") {
    return { commit, outcome: "unknown", detail: { kind: "citation", ...unreadOf(blob) } };
  }
  const text = decodeStrict(blob.bytes);
  if (text === undefined) return { commit, outcome: "unknown", detail: { kind: "citation", read: "read", problem: "not-text" } };
  const present = quotePresent(text, test.quote, citation.lines);
  const holds = test.refutesOn === "absent" ? present : !present;
  return { commit, outcome: holds ? "pass" : "fail", detail: { kind: "citation", read: "read", present } };
}

function blobOf(input: PassInput, commit: string, path: string): BlobResult {
  return input.blobs.get(`${commit}:${path}`) ?? { state: "not-run", why: "deadline" };
}

function unreadOf(blob: BlobResult): { read: ReadState; problem?: "deadline" | "stalled" } {
  if (blob.state === "not-run") return { read: "not-run", problem: blob.why };
  if (blob.state === "failed") return { read: "read-failed" };
  if (blob.state === "read") return { read: "read" };
  return { read: "too-large" };
}

function decodeStrict(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function pointerTarget(document: unknown, pointer: string): unknown {
  if (pointer !== "" && !pointer.startsWith("/")) return undefined;
  const segments = pointer === "" ? [] : pointer.slice(1).split("/");
  let current: unknown = document;
  for (const raw of segments) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (typeof current === "object" && current !== null && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
