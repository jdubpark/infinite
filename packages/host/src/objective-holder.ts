import type { GoalRecordPort } from "./objective-intent.js";
import { type ObjectiveState, readStoredRecord } from "./objective-record.js";
import type { ObjectiveRecord } from "./objective-types.js";
import type { TeamRun } from "./team-types.js";

/** A run and the record beside it in its sealed `Stored`. A goal run's record lives with its goal instead. */
export type RecordHolder = { run: TeamRun; objectiveRecord?: unknown };

const UNAVAILABLE: ObjectiveState = { kind: "unavailable", reason: "record-invalid" };

/** A goal run's record through the port; a standalone run's from its holder. Unreadable, or a goal run without a port, is unavailable. Never throws. */
export function heldRecordState(holder: RecordHolder, goals: GoalRecordPort | undefined): ObjectiveState {
  try {
    if (holder.run.goal) return goals ? goals.read(holder.run.goal.id) : UNAVAILABLE;
    return readStoredRecord(holder.objectiveRecord, { kind: "run", runId: holder.run.id });
  } catch {
    return UNAVAILABLE;
  }
}

/** A goal run's through the port, which throws objectiveError("objective-version-stale") or rethrows a failed save after restoring;
 *  a standalone run's on the holder. Throws Error when a goal run has no port. */
export function writeHeldRecord(holder: RecordHolder, goals: GoalRecordPort | undefined, previous: ObjectiveRecord, next: ObjectiveRecord): void {
  if (holder.run.goal) {
    if (!goals) throw new Error("the goal has no record port");
    goals.write(holder.run.goal.id, previous.version, next);
    return;
  }
  holder.objectiveRecord = next;
}
