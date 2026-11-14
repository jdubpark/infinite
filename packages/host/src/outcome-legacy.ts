import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./evidence/crypto.js";
import type { Disposition, Exclusion, Flag, Level } from "./outcome-rules.js";
import type { LegacyLineState, LegacyPayload, OutcomePayload, OutcomeRow } from "./outcome-store.js";

export const LEGACY_BATCH_MAX = 50, LEGACY_LINE_BYTES = 1024, LEGACY_FILE_LINES = 20_000, LEGACY_LINE_CAP = 50_000, LEGACY_ERRORS_SHOWN = 20;
export const LEGACY_PROFILE_ID = "(legacy)", LEGACY_MEMBER_ID = "legacy";
export type LegacyOutcome = { id: string; projectId: string; profile: { provider: string; model: string; effort?: string };
  label?: string; result: "accepted" | "rejected" | "excluded"; attempts: number; totalTokens?: number; elapsedMs?: number;
  reviewerModel?: string; recordedAt: string; supersedes?: string };   // spec part 8

const DAY_MS = 86_400_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const PROJECT_RE = /^[a-z0-9-]{1,80}$/;
const WORD_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/;
const LABEL_RE = /^[^\x00-\x1f\x7f-\x9f]{1,40}$/u;

export function legacyLineSchema(now: number): z.ZodType<LegacyOutcome> {
  return z.strictObject({
    id: z.string().regex(ID_RE),
    projectId: z.string().regex(PROJECT_RE),
    profile: z.strictObject({
      provider: z.string().regex(WORD_RE),
      model: z.string().regex(MODEL_RE),
      effort: z.string().regex(WORD_RE).optional(),
    }),
    label: z.string().regex(LABEL_RE).optional(),
    result: z.enum(["accepted", "rejected", "excluded"]),
    attempts: z.number().int().min(1).max(100),
    totalTokens: z.number().int().min(0).max(1e12).optional(),
    elapsedMs: z.number().int().min(0).max(31_536_000_000).optional(),
    reviewerModel: z.string().regex(MODEL_RE).optional(),
    recordedAt: z.iso.datetime({ offset: true })
      .refine(value => Date.parse(value) <= now, "recordedAt is later than now")
      .transform(value => new Date(value).toISOString()),
    supersedes: z.string().regex(ID_RE).optional(),
  }).superRefine((value, ctx) => {
    if (value.supersedes === value.id) ctx.addIssue({ code: "custom", path: ["supersedes"], message: "supersedes equals id" });
  });
}

export function legacyBatchSchema(now: number): z.ZodType<{ dryRun: boolean; lines: LegacyOutcome[] }> {
  return z.strictObject({
    dryRun: z.boolean(),
    lines: z.array(legacyLineSchema(now)).min(1).max(LEGACY_BATCH_MAX),
  });
}

export type LegacyFileError = { line: number; reason: "file-too-long" | "blank-line" | "line-too-long" | "not-json" | "invalid" | "id-conflict"; path?: string };

export function parseLegacyFile(text: string, now: number): { lines: LegacyOutcome[]; numbers: number[] } | { errors: LegacyFileError[] } {
  const segments = text.split("\n");
  if (segments[segments.length - 1] === "") segments.pop();
  if (segments.length > LEGACY_FILE_LINES) return { errors: [{ line: LEGACY_FILE_LINES + 1, reason: "file-too-long" }] };

  const schema = legacyLineSchema(now);
  const lines: LegacyOutcome[] = [];
  const numbers: number[] = [];
  const errors: LegacyFileError[] = [];
  const hashById = new Map<string, string>();
  segments.forEach((segment, index) => {
    const number = index + 1;
    const content = segment.endsWith("\r") ? segment.slice(0, -1) : segment;
    const fail = (reason: LegacyFileError["reason"], path?: string) => {
      errors.push(path ? { line: number, reason, path } : { line: number, reason });
    };
    if (content === "") return fail("blank-line");
    if (Buffer.byteLength(content, "utf8") > LEGACY_LINE_BYTES) return fail("line-too-long");
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      return fail("not-json");
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.map(String).join(".");
      return fail("invalid", path || undefined);
    }
    const hash = legacyLineHash(parsed.data);
    const earlier = hashById.get(parsed.data.id);
    if (earlier !== undefined && earlier !== hash) return fail("id-conflict");
    hashById.set(parsed.data.id, hash);
    lines.push(parsed.data);
    numbers.push(number);
  });
  if (errors.length > 0) return { errors: errors.slice(0, LEGACY_ERRORS_SHOWN) };
  return { lines, numbers };
}

export function legacyLineHash(line: LegacyOutcome): string {     // SHA-256 hex of canonicalJson(line)
  // JSON drops absent keys, which canonicalJson refuses; the time is normalized so its written form cannot matter.
  const plain = JSON.parse(JSON.stringify({ ...line, recordedAt: new Date(line.recordedAt).toISOString() })) as unknown;
  return createHash("sha256").update(canonicalJson(plain)).digest("hex");
}

export function legacyOutcomeId(ref: string): string {             // "legacy:" + ref
  return `legacy:${ref}`;
}

export function legacyRow(line: LegacyOutcome, ref: string): OutcomeRow {
  const id = legacyOutcomeId(ref);
  const recordedAt = new Date(line.recordedAt).toISOString();
  const isAccepted = line.result === "accepted";
  const isRejected = line.result === "rejected";
  const isExcluded = line.result === "excluded";
  const legacy: LegacyPayload = {
    id: line.id,
    result: line.result,
    attempts: line.attempts,
    ...(line.label !== undefined ? { label: line.label } : {}),
    ...(line.totalTokens !== undefined ? { totalTokens: line.totalTokens } : {}),
    ...(line.reviewerModel !== undefined ? { reviewerModel: line.reviewerModel } : {}),
    ...(line.supersedes !== undefined ? { supersedes: line.supersedes } : {}),
  };
  const payload: OutcomePayload = {
    projectId: line.projectId,
    taskId: "unknown",
    area: "(unknown)",
    featureMap: "unknown",
    rounds: { run: 0, attributed: 0, unknown: 0 },
    limitEvents: 0,
    costCoverage: "none",
    ...(line.elapsedMs !== undefined ? { wallMs: line.elapsedMs } : {}),
    legacy,
  };
  const flags: Flag[] = isAccepted && line.reviewerModel === line.profile.model ? ["same-model-review"] : [];
  const disposition: Disposition = isExcluded ? "host-stop" : "integrated";
  const exclusion: Exclusion | null = isExcluded ? "host" : null;
  const integrated: Level = isAccepted ? 1 : null;
  const accepted: Level = isAccepted ? 1 : isRejected ? 0 : null;
  const firstPass: Level = isAccepted ? (line.attempts === 1 ? 1 : 0) : isRejected ? 0 : null;
  const held: Level = isRejected ? 0 : null;
  return {
    outcomeId: id,
    source: "legacy",
    projectRef: "",
    taskRef: "",
    areaRef: "",
    runId: id,
    revision: 0,
    memberId: LEGACY_MEMBER_ID,
    sessionId: null,
    attemptIndex: line.attempts,
    inherited: false,
    role: "implementer",
    profileId: LEGACY_PROFILE_ID,
    provider: line.profile.provider,
    model: line.profile.model,
    effort: line.profile.effort ?? null,
    profileEpoch: 0,
    configId: null,
    experimentRef: null,
    kind: null,
    risk: "unknown",
    featureVersion: 0,
    disposition,
    exclusion,
    flags,
    integrated,
    accepted,
    acceptance: accepted,
    firstPass,
    held,
    startedAt: null,
    endedAt: recordedAt,
    frozenAt: recordedAt,
    holdUntil: null,
    runDeletedAt: recordedAt,
    payload,
  };
}

export type LegacyLineOutcome = "imported" | "repeated" | "superseded" | "expired" | "changed" | "conflict";
export type LegacyEffect = { kind: "insert"; ref: string; row: OutcomeRow; state: LegacyLineState }
  | { kind: "supersede"; ref: string; state: LegacyLineState; removeRow: boolean };
export type LegacyPlan = { outcomes: LegacyLineOutcome[]; effects: LegacyEffect[]; removed: number; newLines: number };

/**
 * Walks the lines in array order. Each line sees the effects of the earlier lines. The tables that result depend on
 * the set of lines, never on their order or on how a client cut its batches: a line has a row when the host saw it and
 * no seen line names it, and it is superseded when a seen line names it. Only the answer for each line depends on
 * what came before it. Never reads or writes the store.
 */
export function planLegacyBatch(lines: readonly LegacyOutcome[],
  known: { lines: ReadonlyMap<string, LegacyLineState>; rows: ReadonlyMap<string, string> },   // by ref; outcome id -> source
  context: { now: string; retentionDays: number; ref: (id: string) => string }): LegacyPlan {
  const states = new Map(known.lines);
  const rows = new Map(known.rows);
  const outcomes: LegacyLineOutcome[] = [];
  const effects: LegacyEffect[] = [];
  let removed = 0;
  const cutoff = Date.parse(context.now) - context.retentionDays * DAY_MS;

  /**
   * A line replaces the line it names when the host first sees the line, whether the line is stored or only
   * completes its own mark. So a chain keeps its last line in every order, and a cycle keeps none.
   */
  const supersede = (line: LegacyOutcome): void => {
    if (line.supersedes === undefined) return;
    const oldRef = context.ref(line.supersedes);
    const old = states.get(oldRef);
    if (old === undefined) {
      const mark: LegacyLineState = { state: "superseded", lineHash: null, recordedAt: line.recordedAt };
      effects.push({ kind: "supersede", ref: oldRef, state: mark, removeRow: false });
      states.set(oldRef, mark);
    } else if (old.state === "imported") {
      const mark: LegacyLineState = { state: "superseded", lineHash: old.lineHash, recordedAt: old.recordedAt };
      effects.push({ kind: "supersede", ref: oldRef, state: mark, removeRow: true });
      states.set(oldRef, mark);
      rows.delete(legacyOutcomeId(oldRef));
      removed++;
    } else if (old.lineHash === null && Date.parse(old.recordedAt) < Date.parse(line.recordedAt)) {
      // The host has not seen the named line. Its mark holds the latest time among the lines that name it, so two
      // such lines leave one mark in either order.
      const mark: LegacyLineState = { ...old, recordedAt: line.recordedAt };
      effects.push({ kind: "supersede", ref: oldRef, state: mark, removeRow: false });
      states.set(oldRef, mark);
    }
  };

  for (const line of lines) {
    const ref = context.ref(line.id);
    const id = legacyOutcomeId(ref);
    const hash = legacyLineHash(line);

    if (Date.parse(line.recordedAt) <= cutoff) {
      outcomes.push("expired");
      continue;
    }
    const current = states.get(ref);
    if (current?.state === "superseded") {
      if (current.lineHash === null) {
        // A mark made before its line was seen has no hash. The line completes it with its own hash and time, so the
        // mark is the same whichever line came first. The line is not stored, and it still replaces the line it names.
        const mark: LegacyLineState = { state: "superseded", lineHash: hash, recordedAt: line.recordedAt };
        effects.push({ kind: "supersede", ref, state: mark, removeRow: false });
        states.set(ref, mark);
        supersede(line);
        outcomes.push("superseded");
      } else {
        // The mark holds the hash of the body the host saw. Another body is an edit, refused as under an imported id.
        outcomes.push(current.lineHash === hash ? "superseded" : "changed");
      }
      continue;
    }
    if (current) {
      outcomes.push(current.lineHash === hash ? "repeated" : "changed");
      continue;
    }
    if (rows.has(id)) {
      outcomes.push("conflict");
      continue;
    }
    supersede(line);
    const state: LegacyLineState = { state: "imported", lineHash: hash, recordedAt: line.recordedAt };
    effects.push({ kind: "insert", ref, row: legacyRow(line, ref), state });
    states.set(ref, state);
    rows.set(id, "legacy");
    outcomes.push("imported");
  }

  const newLines = new Set(effects.map(effect => effect.ref).filter(effectRef => !known.lines.has(effectRef))).size;
  return { outcomes, effects, removed, newLines };
}
