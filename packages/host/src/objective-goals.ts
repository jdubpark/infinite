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
import type { ObjectiveRecord } from "./objective-types.js";

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

/** Builds the goal's first record. Used by `GoalService.create`; the goal's steering is empty there. */
export function createGoalObjective(holder: GoalHolder, at: string): GoalObjectiveResult {
  return store(holder, goalRecord(holder.goal, at, "created"), "built");
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
