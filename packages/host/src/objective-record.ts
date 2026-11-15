import { z } from "zod";
import type { ProductGoal } from "./goal-types.js";
import type { TeamRun } from "./team-types.js";
import { TeamError } from "./team-workspace.js";
import { canonicalJson } from "./evidence/crypto.js";
import {
  OBJECTIVE_LIMITS,
  OBJECTIVE_SCHEMA_VERSION,
  RUBRIC_VERSION_DEFAULT,
  logValueOf,
  objectiveRecordSchema,
  recordDigest,
} from "./objective-types.js";
import type { Criterion, Direction, LogEntry, LogValue, ObjectiveOwner, ObjectiveRecord } from "./objective-types.js";

export type ObjectiveUnavailable = "source-invalid" | "record-invalid" | "record-newer";
export type ObjectiveState = { kind: "absent" } | { kind: "ready"; record: ObjectiveRecord }
  | { kind: "unavailable"; reason: "record-invalid" | "record-newer" };
export type SteeringEntry = { text: string; revision: number; at: string };
/** The steering entry that a live request appended, logged as the owner's direction. */
export type LiveDirection = { revision: number; handle: string };
export type ObjectiveRecordView = { owner: ObjectiveOwner; version: number; latestVersion: number; rebuilt: boolean;
  record: Omit<ObjectiveRecord, "log">; log: LogEntry[] };
export type ObjectiveErrorCode = "objective-record-absent" | "objective-source-invalid" | "objective-record-invalid" | "objective-record-newer"
  | "objective-record-of-goal" | "objective-record-of-mission" | "objective-record-of-handoff" | "objective-version-not-found" | "objective-version-unavailable"
  | "objective-prompts-off" | "objective-op-invalid" | "objective-op-target" | "objective-op-c0" | "objective-op-refused"
  | "objective-version-stale" | "objective-criterion-misfit" | "objective-criterion-too-large" | "objective-command-unknown"
  | "objective-secret" | "objective-criteria-limit" | "objective-too-large" | "objective-log-full" | "objective-digest-too-large";

export const OBJECTIVE_ERRORS: Record<ObjectiveErrorCode, { status: 400 | 404 | 409; message: string }> = {
  "objective-record-absent": { status: 404, message: "This run has no objective record yet. It gets one at its next accepted plan." },
  "objective-source-invalid": { status: 409, message: "The objective record could not be built from these fields." },
  "objective-record-invalid": { status: 409, message: "The stored objective record cannot be read. It is kept unchanged." },
  "objective-record-newer": { status: 409, message: "A newer host wrote this objective record. Upgrade the host to read it." },
  "objective-record-of-goal": { status: 409, message: "This run belongs to a goal. Read the goal's record." },
  "objective-record-of-mission": { status: 409, message: "A mission subteam has no objective record." },
  "objective-record-of-handoff": { status: 409, message: "A handoff run has no objective record." },
  "objective-version-not-found": { status: 404, message: "The record has no such version." },
  "objective-version-unavailable": { status: 409, message: "This host cannot rebuild that version of the record." },
  "objective-prompts-off": { status: 409, message: "Turn on objective prompts for this goal's project before changing its criteria." },
  "objective-op-invalid": { status: 400, message: "The correction is invalid." },
  "objective-op-target": { status: 409, message: "A correction names a criterion that is missing or in another state." },
  "objective-op-c0": { status: 409, message: "Criterion c0 is the goal's success text and cannot be edited or retired." },
  "objective-op-refused": { status: 409, message: "The corrected record would be invalid, so nothing was changed." },
  "objective-version-stale": { status: 409, message: "The record changed since it was read. Read it again and resend the correction." },
  "objective-criterion-misfit": { status: 400, message: "A criterion's producer or threshold does not fit its check." },
  "objective-criterion-too-large": { status: 400, message: "A criterion is over 2,048 bytes." },
  "objective-command-unknown": { status: 400, message: "A command criterion must name one of the project's configured checks." },
  "objective-secret": { status: 400, message: "A criterion looks like it holds a secret, so nothing was changed." },
  "objective-criteria-limit": { status: 409, message: "A record holds at most 8 active criteria and 64 in all." },
  "objective-too-large": { status: 409, message: "The corrected record would be over its size limit." },
  "objective-log-full": { status: 409, message: "The record's log is full. Start a new goal with consolidated criteria." },
  "objective-digest-too-large": { status: 409, message: "The active criteria would be over the 6 KiB prompt digest." },
};

const L = OBJECTIVE_LIMITS;
const steeringEntry = z.strictObject({
  text: z.string().refine(value => value.length >= 1 && value.length <= L.directionChars, "Steering text is out of bounds"),
  revision: z.number().int().min(1),
  at: z.iso.datetime(),
});

export function objectiveError(code: ObjectiveErrorCode): TeamError {
  return new TeamError(OBJECTIVE_ERRORS[code].status, code, OBJECTIVE_ERRORS[code].message);
}

/** Stamps the digest over everything but the log and the digest itself. */
function seal(body: Omit<ObjectiveRecord, "digest"> & Partial<Pick<ObjectiveRecord, "digest">>): ObjectiveRecord {
  return { ...body, digest: recordDigest(body) };
}

function sameOwner(left: ObjectiveOwner, right: ObjectiveOwner): boolean {
  if (left.kind === "goal" && right.kind === "goal") return left.goalId === right.goalId;
  if (left.kind === "run" && right.kind === "run") return left.runId === right.runId;
  return false;
}

/** A goal's record: the owner's words as c0, then one direction per steering entry. */
export function goalRecord(goal: ProductGoal, at: string, origin: "created" | "migrated", live?: LiveDirection): ObjectiveRecord | "source-invalid" {
  try {
    const entry: LogEntry = origin === "created"
      ? { seq: 1, at, version: 1, actor: "owner", authority: "direction", op: "record.created", target: "record", handle: goal.id }
      : { seq: 1, at, version: 1, actor: "host", authority: "receipt", op: "record.migrated", target: "record" };
    const base = seal({
      schemaVersion: OBJECTIVE_SCHEMA_VERSION,
      owner: { kind: "goal", goalId: goal.id },
      version: 1,
      statement: { objective: goal.objective, directions: [] },
      definitions: [],
      constraints: { allowedPaths: [...goal.allowedPaths], excludedPaths: [], rules: [] },
      nonGoals: goal.nonGoals.map((text, index) => ({ id: `n${index + 1}`, text })),
      ownerEvidence: [...goal.evidence],
      criteria: [{
        id: "c0",
        origin: "owner",
        statement: goal.successCriteria,
        check: { kind: "judgement", item: "owner-text" },
        producer: "evaluator",
        threshold: { kind: "pass" },
        state: "active",
      }],
      assumptions: [],
      questions: [],
      rubricVersion: RUBRIC_VERSION_DEFAULT,
      log: [entry],
    });
    if (!objectiveRecordSchema.safeParse(base).success) return "source-invalid";
    return syncDirections(base, goal.steering, at, live);
  } catch {
    return "source-invalid";
  }
}

/** A standalone run's record: the objective as its text, c0 pointing at it, and the paths left open to the whole project. */
export function runRecord(run: TeamRun, at: string, handle: string): ObjectiveRecord | "source-invalid" {
  try {
    const base = seal({
      schemaVersion: OBJECTIVE_SCHEMA_VERSION,
      owner: { kind: "run", runId: run.id },
      version: 1,
      statement: { objective: run.objective, directions: [] },
      definitions: [],
      constraints: { allowedPaths: ["."], excludedPaths: [], rules: [] },
      nonGoals: [],
      ownerEvidence: [],
      criteria: [{
        id: "c0",
        origin: "owner",
        statement: "",
        statementOf: "objective",
        check: { kind: "judgement", item: "owner-text" },
        producer: "evaluator",
        threshold: { kind: "pass" },
        state: "active",
      }],
      assumptions: [],
      questions: [],
      rubricVersion: RUBRIC_VERSION_DEFAULT,
      log: [{ seq: 1, at, version: 1, actor: "host", authority: "receipt", op: "record.created", target: "record", handle }],
    });
    if (!objectiveRecordSchema.safeParse(base).success) return "source-invalid";
    return syncDirections(base, run.steering, at);
  } catch {
    return "source-invalid";
  }
}

/** Appends one direction per steering entry that has none. Returns the same object when nothing is missing; never mutates its input. */
export function syncDirections(record: ObjectiveRecord, steering: readonly SteeringEntry[], at: string, live?: LiveDirection): ObjectiveRecord | "source-invalid" {
  try {
    if (!steering.every(entry => steeringEntry.safeParse(entry).success)) return "source-invalid";
    const directions: Direction[] = [...record.statement.directions];
    const log: LogEntry[] = [...record.log];
    const present = new Set(directions.map(item => item.id));
    let version = record.version;
    let seq = log.length === 0 ? 1 : log[log.length - 1].seq + 1;
    for (const entry of steering) {
      const id = `s${entry.revision}`;
      if (present.has(id)) continue;
      present.add(id);
      const direction: Direction = { id, text: entry.text, source: "steering", at: entry.at };
      directions.push(direction);
      version += 1;
      const appended = live !== undefined && live.revision === entry.revision;
      const logEntry: LogEntry = {
        seq,
        at,
        version,
        actor: appended ? "owner" : "host",
        authority: appended ? "direction" : "receipt",
        op: appended ? "direction.appended" : "direction.copied",
        target: id,
        after: logValue(direction, `record:direction:${id}`),
      };
      if (live !== undefined && appended) logEntry.handle = live.handle;
      log.push(logEntry);
      seq += 1;
    }
    if (directions.length === record.statement.directions.length) return record;
    const next = seal({ ...record, version, statement: { ...record.statement, directions }, log });
    return objectiveRecordSchema.safeParse(next).success ? next : "source-invalid";
  } catch {
    return "source-invalid";
  }
}

/** Inline when the canonical value fits 2 KiB; otherwise a reference with the digest and size. */
export function logValue(value: unknown, ref: string): LogValue {
  return logValueOf(value, ref);
}

/** Reads a sealed record strictly. Never repairs: a damaged or newer value is reported, not changed. */
export function readStoredRecord(raw: unknown, owner: ObjectiveOwner): ObjectiveState {
  if (raw === undefined) return { kind: "absent" };
  try {
    if (typeof raw === "object" && raw !== null && "schemaVersion" in raw) {
      const version = (raw as { schemaVersion: unknown }).schemaVersion;
      if (typeof version === "number" && Number.isInteger(version) && version > OBJECTIVE_SCHEMA_VERSION) {
        return { kind: "unavailable", reason: "record-newer" };
      }
    }
    const parsed = objectiveRecordSchema.safeParse(raw);
    if (!parsed.success || !sameOwner(parsed.data.owner, owner)) return { kind: "unavailable", reason: "record-invalid" };
    return { kind: "ready", record: parsed.data };
  } catch {
    return { kind: "unavailable", reason: "record-invalid" };
  }
}

const CRITERION_OPS = new Set(["criterion.added", "criterion.edited", "criterion.retired", "criterion.confirmed"]);

/** Undoes one criterion entry: the criterion its `after` names goes back to its `before`, or is removed for an add. */
function undoCriterion(criteria: Criterion[], entry: LogEntry): Criterion[] {
  const after = entry.after;
  if (after === undefined || !("inline" in after)) throw objectiveError("objective-version-unavailable");
  const wanted = canonicalJson(JSON.parse(JSON.stringify(after.inline)));
  const index = criteria.findIndex(item => canonicalJson(JSON.parse(JSON.stringify(item))) === wanted);
  if (index === -1) throw objectiveError("objective-version-unavailable");
  if (entry.op === "criterion.added") return criteria.filter((_, position) => position !== index);
  const before = entry.before;
  if (before === undefined || !("inline" in before)) throw objectiveError("objective-version-unavailable");
  return criteria.map((item, position) => (position === index ? (before.inline as Criterion) : item));
}

/** Rebuilds the record as it was at `version` by undoing each later entry in descending seq. Throws objectiveError. */
export function rebuildVersion(record: ObjectiveRecord, version: number): ObjectiveRecord {
  if (!Number.isInteger(version) || version < 1 || version > record.version) throw objectiveError("objective-version-not-found");
  const first = record.log[0];
  if (first === undefined || version < first.version) throw objectiveError("objective-version-unavailable");
  const undone = record.log.filter(entry => entry.version > version).sort((left, right) => right.seq - left.seq);
  let directions = record.statement.directions;
  let criteria = record.criteria;
  for (const entry of undone) {
    if (CRITERION_OPS.has(entry.op)) {
      criteria = undoCriterion(criteria, entry);
      continue;
    }
    if (entry.op !== "direction.appended" && entry.op !== "direction.copied") throw objectiveError("objective-version-unavailable");
    if (!record.statement.directions.some(item => item.id === entry.target)) throw objectiveError("objective-version-unavailable");
    directions = directions.filter(item => item.id !== entry.target);
  }
  const rebuilt = seal({
    ...record,
    version,
    criteria,
    statement: { ...record.statement, directions },
    log: record.log.filter(entry => entry.version <= version),
  });
  if (!objectiveRecordSchema.safeParse(rebuilt).success) throw objectiveError("objective-version-unavailable");
  return rebuilt;
}

/** The record at `version` (default: the latest) with its log. A version other than the latest is rebuilt. */
export function recordView(record: ObjectiveRecord, version: number = record.version): ObjectiveRecordView {
  const target = version === record.version ? record : rebuildVersion(record, version);
  const body: Partial<ObjectiveRecord> = { ...target };
  delete body.log;
  return {
    owner: record.owner,
    version: target.version,
    latestVersion: record.version,
    rebuilt: version !== record.version,
    record: body as Omit<ObjectiveRecord, "log">,
    log: target.log,
  };
}

/** The event text to add once, or undefined. Sets `objectiveNotice` on a new reason and clears it when the record is readable. */
export function noticeFor(holder: { objectiveNotice?: ObjectiveUnavailable }, result: string, events: Record<ObjectiveUnavailable, string>): string | undefined {
  if (result === "built" || result === "synced" || result === "unchanged") {
    delete holder.objectiveNotice;
    return undefined;
  }
  if (result === "source-invalid" || result === "record-invalid" || result === "record-newer") {
    if (holder.objectiveNotice === result) return undefined;
    holder.objectiveNotice = result;
    return events[result];
  }
  return undefined;
}
