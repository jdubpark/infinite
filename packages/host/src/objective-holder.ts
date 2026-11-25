import type { GoalRecordPort } from "./objective-intent.js";
import { type ObjectiveState, readStoredRecord } from "./objective-record.js";
import type { ObjectiveRecord } from "./objective-types.js";
import type { TeamRun } from "./team-types.js";

export type RecordHolder = { run: TeamRun; objectiveRecord?: unknown };

const UNAVAILABLE: ObjectiveState = { kind: "unavailable", reason: "record-invalid" };

export function heldRecordState(holder: RecordHolder, goals: GoalRecordPort | undefined): ObjectiveState {
  try {
    if (holder.run.goal) return goals ? goals.read(holder.run.goal.id) : UNAVAILABLE;
    return readStoredRecord(holder.objectiveRecord, { kind: "run", runId: holder.run.id });
  } catch {
    return UNAVAILABLE;
  }
}

export function writeHeldRecord(holder: RecordHolder, goals: GoalRecordPort | undefined, previous: ObjectiveRecord, next: ObjectiveRecord): void {
  if (holder.run.goal) {
    if (!goals) throw new Error("the goal has no record port");
    goals.write(holder.run.goal.id, previous.version, next);
    return;
  }
  holder.objectiveRecord = next;
}
