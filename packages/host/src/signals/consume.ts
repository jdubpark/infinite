import type { ProjectSignal, SignalKind, SignalReader } from "./types.js";

export const WAKE_PAGE = 50;

export function readSignals(
  reader: SignalReader,
  projectId: string,
  cursor: number | undefined,
  kinds?: readonly SignalKind[],
  limit = WAKE_PAGE,
): { cursor: number; signals: ProjectSignal[]; more: boolean } | undefined {
  const head = reader.head();
  if (head === undefined) return undefined;
  if (cursor === undefined || cursor > head) return { cursor: head, signals: [], more: false };
  if (cursor === head) return { cursor, signals: [], more: false };
  const page = Math.min(200, Math.max(1, Math.floor(limit)));
  const signals = reader.after(projectId, cursor, { ...(kinds === undefined ? {} : { kinds }), limit: page });
  if (reader.head() === undefined) return undefined;
  const last = signals[signals.length - 1];
  const more = signals.length >= page && last !== undefined && last.seq < head;
  return { cursor: more ? last.seq : head, signals, more };
}
