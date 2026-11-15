import type { ProjectSignal, SignalKind, SignalReader } from "./types.js";

/** The page a consumer reads on one scheduler pass. */
export const WAKE_PAGE = 50;

/**
 * One consumer read of the inbox: the signals after `cursor` and the cursor to save with them. Undefined means the
 * inbox cannot be read now; the consumer keeps its cursor and reads on a later pass.
 *
 * - An unset cursor starts at the head and reads nothing, so a new consumer never wakes on old signals.
 * - A cursor at the head costs no database read.
 * - A page shorter than `limit` holds every matching signal up to the head, so the cursor moves to the head, past
 *   other projects' and other kinds' signals. A full page moves it to the last signal returned and sets `more`:
 *   signals recorded before this read may still be waiting, so a consumer that starts work on a batch reads again first.
 * - A failed read makes `head()` report the inbox unreadable, so an empty page from a failed read never moves the
 *   cursor. `SignalService.reader()` behaves this way.
 * - A cursor above the head means the inbox was replaced; the consumer starts again at the new head.
 */
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
  // The reader serves at most 200 a page, so a larger limit would read a full page as a short one.
  const page = Math.min(200, Math.max(1, Math.floor(limit)));
  const signals = reader.after(projectId, cursor, { ...(kinds === undefined ? {} : { kinds }), limit: page });
  if (reader.head() === undefined) return undefined;
  const last = signals[signals.length - 1];
  const more = signals.length >= page && last !== undefined && last.seq < head;
  return { cursor: more ? last.seq : head, signals, more };
}
