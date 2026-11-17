import type { ProductGoal } from "./goal-types.js";
import {
  goalRecord,
  noticeFor,
  objectiveError,
  readStoredRecord,
  recordView,
  syncDirections,
  type LiveDirection,
  type ObjectiveRecordView,
  type ObjectiveUnavailable,
} from "./objective-record.js";
import type { GoalRecordPort } from "./objective-intent.js";
import type { ObjectiveRecord } from "./objective-types.js";
import { recordDigestFor } from "./objective-digest.js";
import type { Correction, CriterionInput } from "./objective-input.js";
import { addCreationCriteria, applyOwnerOps, type OwnerOpContext } from "./objective-ops.js";
import { RECORD_DIGEST_BYTES, recordDigestBytes, recordDigestSchema, type RecordDigest } from "./team-types.js";
import type { TeamCommand } from "./team-types.js";
import { TeamError } from "./team-workspace.js";

export type { ObjectiveUnavailable } from "./objective-record.js";

/** A goal's sealed record holder: the goal, the stored objective record, and the reason its last read failed. */
export type GoalHolder = { goal: ProductGoal; objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable };
export type GoalObjectiveResult = "built" | "synced" | "unchanged" | ObjectiveUnavailable;

export const GOAL_OBJECTIVE_EVENTS: Record<ObjectiveUnavailable, string> = {
  "source-invalid": "The objective record could not be built from this goal's fields. The goal works as before, without a record.",
  "record-invalid": "The stored objective record cannot be read. It is kept unchanged, and the goal works as before.",
  "record-newer": "A newer host wrote this goal's objective record. It is kept unchanged; upgrade the host to read it.",
};

const ownerOf = (goal: ProductGoal) => ({ kind: "goal" as const, goalId: goal.id });

/** Stores a built record, or reports why none could be built. A result other than a record leaves the holder unchanged. */
function store(holder: GoalHolder, built: ObjectiveRecord | "source-invalid", result: "built"): GoalObjectiveResult {
  if (built === "source-invalid") return "source-invalid";
  holder.objectiveRecord = built;
  return result;
}

/**
 * Builds the goal's first record, then adds the creation criteria as version 1's `criterion.added` entries. A refusal
 * throws its own code. Any other failure throws `objective-op-refused`, so no criterion is ever dropped silently.
 * Used by `GoalService.create`, which stores nothing when this throws.
 */
export function createGoalObjective(holder: GoalHolder, at: string, criteria?: { inputs: readonly CriterionInput[]; context: OwnerOpContext }): GoalObjectiveResult {
  const built = goalRecord(holder.goal, at, "created");
  if (criteria !== undefined && built === "source-invalid") throw objectiveError("objective-source-invalid");
  if (criteria === undefined || built === "source-invalid") return store(holder, built, "built");
  let record: ObjectiveRecord;
  try { record = addCreationCriteria(built, criteria.inputs, criteria.context); }
  catch (error) {
    if (error instanceof TeamError) throw error;
    throw objectiveError("objective-op-refused");
  }
  return store(holder, record, "built");
}

/** Builds a missing record at load, or copies missing directions into an existing one. Never throws. */
export function loadGoalObjective(holder: GoalHolder, at: string): GoalObjectiveResult {
  const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.goal));
  if (state.kind === "unavailable") return state.reason;
  if (state.kind === "absent") return store(holder, goalRecord(holder.goal, at, "migrated"), "built");
  const next = syncDirections(state.record, holder.goal.steering, at);
  if (next === "source-invalid") return "source-invalid";
  if (next === state.record) return "unchanged";
  holder.objectiveRecord = next;
  return "synced";
}

/** Adds the newest steering entry as the owner's direction, then copies any other missing ones. Never throws. */
export function steerGoalObjective(holder: GoalHolder, requestId: string, at: string): GoalObjectiveResult {
  const newest = holder.goal.steering.at(-1);
  const live: LiveDirection | undefined = newest ? { revision: newest.revision, handle: requestId } : undefined;
  const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.goal));
  if (state.kind === "unavailable") return state.reason;
  if (state.kind === "absent") return store(holder, goalRecord(holder.goal, at, "migrated", live), "built");
  const next = syncDirections(state.record, holder.goal.steering, at, live);
  if (next === "source-invalid") return "source-invalid";
  if (next === state.record) return "unchanged";
  holder.objectiveRecord = next;
  return "synced";
}

/**
 * A goal's record for the intent check. `read` answers the held record's state, and `absent` for a goal not held. `write`
 * checks the held version, sets the held object's record in place, and saves the holder; a failed save restores the
 * previous record and rethrows. It writes no goal event.
 */
export function goalRecordPort(holderOf: (goalId: string) => GoalHolder | undefined, save: (holder: GoalHolder) => void): GoalRecordPort {
  return {
    read(goalId) {
      const holder = holderOf(goalId);
      return holder ? readStoredRecord(holder.objectiveRecord, ownerOf(holder.goal)) : { kind: "absent" };
    },
    write(goalId, expectedVersion, next) {
      const holder = holderOf(goalId);
      if (!holder) throw objectiveError("objective-record-absent");
      const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.goal));
      if (state.kind === "absent") throw objectiveError("objective-record-absent");
      if (state.kind === "unavailable") throw objectiveError(state.reason === "record-newer" ? "objective-record-newer" : "objective-record-invalid");
      if (state.record.version !== expectedVersion) throw objectiveError("objective-version-stale");
      const previous = holder.objectiveRecord;
      holder.objectiveRecord = next;
      try { save(holder); }
      catch (error) { holder.objectiveRecord = previous; throw error; }
    },
  };
}

/** The event text to add once for this result, or undefined. */
export function goalObjectiveNote(holder: GoalHolder, result: GoalObjectiveResult): string | undefined {
  return noticeFor(holder, result, GOAL_OBJECTIVE_EVENTS);
}

/** The goal's record at `version` (default: the latest). Throws objectiveError; reads touch memory only. */
export function goalObjectiveView(holder: GoalHolder, version?: number): ObjectiveRecordView {
  const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.goal));
  if (state.kind === "ready") return recordView(state.record, version);
  if (state.kind === "unavailable") throw objectiveError(state.reason === "record-newer" ? "objective-record-newer" : "objective-record-invalid");
  throw objectiveError(holder.objectiveNotice === "source-invalid" ? "objective-source-invalid" : "objective-record-absent");
}

/**
 * Applies a correction to the holder's record and returns the corrected record. It stores nothing: the caller saves
 * the result with its receipt and event, so a failed write leaves the holder as it was. One parse of the stored
 * record, then the result is checked against the schema. Throws objectiveError.
 */
export function correctGoalObjective(holder: GoalHolder, correction: Correction, context: OwnerOpContext): ObjectiveRecord {
  const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.goal));
  if (state.kind === "unavailable") throw objectiveError(state.reason === "record-newer" ? "objective-record-newer" : "objective-record-invalid");
  if (state.kind === "absent") throw objectiveError(holder.objectiveNotice === "source-invalid" ? "objective-source-invalid" : "objective-record-absent");
  return applyOwnerOps(state.record, correction, context);
}

export type GoalDigestResult = { digest: RecordDigest } | { skipped: "record-unavailable" | "digest-too-large" };
export const GOAL_DIGEST_EVENTS: Record<"record-unavailable" | "digest-too-large", string> = {
  "record-unavailable": "The objective record could not be read, so this cycle's members read the success text without its criteria.",
  "digest-too-large": "The active criteria exceed the prompt digest, so this cycle's members read the success text without them.",
};
export const GOAL_DIGEST_RESTORED = "The active criteria reach this cycle's members again.";

const DIGEST_TEXTS = new Set<string>([...Object.values(GOAL_DIGEST_EVENTS), GOAL_DIGEST_RESTORED]);

/**
 * The event a cycle adds for its digest, or undefined. The newest digest event of `events` decides: a skip is added
 * unless it is the newest, and a digest is announced as restored only when it follows a skip. No persisted field.
 * With the switch off (`pinned` undefined) nothing is added.
 * It compares with the visible event list, which keeps its newest 200 events. Once the newest digest event has left that
 * list, the next skip is told again and a recovery is not announced, which keeps the visible list truthful.
 */
export function digestEvent(events: readonly { text: string }[], pinned: GoalDigestResult | undefined): string | undefined {
  if (pinned === undefined) return undefined;
  const newest = [...events].reverse().find(event => DIGEST_TEXTS.has(event.text))?.text;
  if ("skipped" in pinned) return newest === GOAL_DIGEST_EVENTS[pinned.skipped] ? undefined : GOAL_DIGEST_EVENTS[pinned.skipped];
  return newest !== undefined && Object.values(GOAL_DIGEST_EVENTS).includes(newest) ? GOAL_DIGEST_RESTORED : undefined;
}

/**
 * The digest of the holder's latest record, for one cycle's goal context. One parse of the record. A digest that is
 * too large, or that the full digest schema refuses, is skipped with its reason; the record is never changed.
 */
export function goalRecordDigest(holder: GoalHolder, configured: readonly TeamCommand[]): GoalDigestResult {
  const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.goal));
  if (state.kind !== "ready") return { skipped: "record-unavailable" };
  try {
    const digest = recordDigestFor(state.record, configured);
    if (recordDigestBytes(digest) > RECORD_DIGEST_BYTES) return { skipped: "digest-too-large" };
    const parsed = recordDigestSchema.safeParse(digest);
    return parsed.success ? { digest: parsed.data } : { skipped: "record-unavailable" };
  } catch {
    return { skipped: "record-unavailable" };
  }
}
