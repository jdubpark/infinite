import type { TeamRun } from "./team-types.js";
import { type LiveDirection, type ObjectiveRecordView, type ObjectiveUnavailable, noticeFor, objectiveError, readStoredRecord, recordView, runRecord, syncDirections } from "./objective-record.js";
import type { ObjectiveRecord } from "./objective-types.js";

export type { ObjectiveUnavailable } from "./objective-record.js";
/** A standalone run and the record beside it in its sealed `Stored`. */
export type RunHolder = { run: TeamRun; objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable };
export type RunObjectiveResult = "built" | "synced" | "unchanged" | "goal-owned" | "mission-owned" | ObjectiveUnavailable;

export const RUN_OBJECTIVE_EVENTS: Record<ObjectiveUnavailable, string> = {
  "source-invalid": "The objective record could not be built from this run's fields. The run works as before, without a record.",
  "record-invalid": "The stored objective record cannot be read. It is kept unchanged, and the run works as before.",
  "record-newer": "A newer host wrote this run's objective record. It is kept unchanged; upgrade the host to read it.",
};

const ownerOf = (run: TeamRun) => ({ kind: "run" as const, runId: run.id });

/** A goal cycle run and a mission subteam never hold a record of their own. */
function ownership(run: TeamRun): "goal-owned" | "mission-owned" | undefined {
  if (run.goal) return "goal-owned";
  if (run.missionId) return "mission-owned";
  return undefined;
}

/** Syncs a ready record into the holder. Writes only when the sync added a direction. */
function syncInto(holder: RunHolder, record: ObjectiveRecord, at: string, live?: LiveDirection): RunObjectiveResult {
  const synced = syncDirections(record, holder.run.steering, at, live);
  if (synced === "source-invalid") return "source-invalid";
  if (synced === record) return "unchanged";
  holder.objectiveRecord = synced;
  return "synced";
}

/** At an accepted plan. Builds the record when absent, otherwise syncs. Never throws. */
export function planRunObjective(holder: RunHolder, handle: string, at: string): RunObjectiveResult {
  try {
    const owned = ownership(holder.run);
    if (owned) return owned;
    const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.run));
    if (state.kind === "unavailable") return state.reason;
    if (state.kind === "absent") {
      const built = runRecord(holder.run, at, handle);
      if (built === "source-invalid") return "source-invalid";
      holder.objectiveRecord = built;
      return "built";
    }
    return syncInto(holder, state.record, at);
  } catch {
    return "record-invalid";
  }
}

/** After a steer or a continuation with text. Syncs a ready record, live for the newest entry; an absent record waits for the next plan. Never throws. */
export function steerRunObjective(holder: RunHolder, requestId: string, at: string): RunObjectiveResult {
  try {
    const owned = ownership(holder.run);
    if (owned) return owned;
    const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.run));
    if (state.kind === "unavailable") return state.reason;
    // An absent record keeps its notice, so the event is not repeated by a steer.
    if (state.kind === "absent") return holder.objectiveNotice ?? "unchanged";
    const newest = holder.run.steering[holder.run.steering.length - 1];
    const live: LiveDirection | undefined = newest ? { revision: newest.revision, handle: requestId } : undefined;
    return syncInto(holder, state.record, at, live);
  } catch {
    return "record-invalid";
  }
}

export function runObjectiveNote(holder: RunHolder, result: RunObjectiveResult): string | undefined {
  return noticeFor(holder, result, RUN_OBJECTIVE_EVENTS);
}

/** 409 objective-record-of-goal or objective-record-of-mission first; then as goalObjectiveView. */
export function runObjectiveView(holder: RunHolder, version?: number): ObjectiveRecordView {
  if (holder.run.goal) throw objectiveError("objective-record-of-goal");
  if (holder.run.missionId) throw objectiveError("objective-record-of-mission");
  const state = readStoredRecord(holder.objectiveRecord, ownerOf(holder.run));
  if (state.kind === "absent") {
    throw objectiveError(holder.objectiveNotice === "source-invalid" ? "objective-source-invalid" : "objective-record-absent");
  }
  if (state.kind === "unavailable") {
    throw objectiveError(state.reason === "record-newer" ? "objective-record-newer" : "objective-record-invalid");
  }
  return recordView(state.record, version);
}
