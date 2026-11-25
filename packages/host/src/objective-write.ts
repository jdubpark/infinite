import { CORRECTION_LOG } from "./objective-ops.js";
import { objectiveError } from "./objective-record.js";
import { canonicalBytes, objectiveRecordSchema, recordDigest } from "./objective-types.js";
import type { LogEntry, ObjectiveRecord } from "./objective-types.js";

export type LogRoom = { entries: number; bytes: number };

export function nextRecordId(prefix: string, existing: readonly string[]): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const highest = existing.reduce((max, id) => {
    const match = pattern.exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `${prefix}${highest + 1}`;
}

export function nextSeq(record: ObjectiveRecord): number {
  return (record.log[record.log.length - 1]?.seq ?? 0) + 1;
}

export function assertLogRoom(record: ObjectiveRecord, entries: readonly LogEntry[], room: LogRoom = CORRECTION_LOG): void {
  const log = [...record.log, ...entries];
  if (log.length > room.entries || canonicalBytes(log) > room.bytes) throw objectiveError("objective-log-full");
}

export function sealRecord(record: ObjectiveRecord, changes: Partial<ObjectiveRecord>, entries: readonly LogEntry[]): ObjectiveRecord {
  const version = entries[0]?.version ?? record.version;
  if (entries.some(entry => entry.version !== version)) throw objectiveError("objective-op-refused");
  const body = { ...record, ...changes, version, log: [...record.log, ...entries] };
  const next = { ...body, digest: recordDigest(body) } as ObjectiveRecord;
  if (!objectiveRecordSchema.safeParse(next).success) throw objectiveError("objective-op-refused");
  return next;
}
