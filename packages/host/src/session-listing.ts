import { readFileSync, statSync } from "node:fs";
import { applyLifecycle, initialAttention } from "@infinite/attention";
import type { Session, WorkerState } from "./types.js";

/**
 * A parse of a file younger than this may be followed by another write in the same timestamp
 * tick, with the same size and the same identity, so it is read again instead of kept. The rule
 * reads the newer of mtime and ctime, because a writer that keeps an old mtime still gives the file a new ctime.
 */
export const SETTLED_MS = 2000;

export type ListedSession = Omit<Session, "context" | "initialPrompt" | "generatedTitle" | "nativeArgs" | "handoff">;

/** The part of a session record that a listing row shows. Destructuring keeps the key order. */
export function listedSession(session: Session): ListedSession {
  const {
    context: _context,
    initialPrompt: _prompt,
    generatedTitle: _generatedTitle,
    nativeArgs: _nativeArgs,
    handoff: _handoff,
    ...summary
  } = session;
  return summary;
}

/** No worker answers and no status was saved: unavailable since `at`. */
export const unavailableState = (at: string): WorkerState => ({
  status: "unavailable",
  seq: 0,
  screen: "",
  attention: applyLifecycle(initialAttention(at, false), "unavailable", at),
});

/**
 * The state a saved status gives when no worker answers: `exited` stays, anything else is `unavailable`. Its attention
 * is dated `at`: `lastActivityAt` always, and `since` when the lifecycle state changes here.
 */
export function savedState(saved: WorkerState, at: string): WorkerState {
  const status = saved.status === "exited" ? "exited" : "unavailable";
  return {
    ...saved,
    status,
    screen: "",
    attention: applyLifecycle(saved.attention ?? initialAttention(at, false), status, at),
  };
}

/** A saved status and when its file was last written (its mtime), which survives a host restart. */
export type SavedStatus = { state: WorkerState; savedAt: string };

/**
 * A listing row for a saved status. Its times are recorded ones, never the time of the read, so an unchanged record
 * reads the same on every call and after a restart: `lastActivityAt` stays the saved attention's, and when the
 * lifecycle state changes here (a worker gone without recording its exit), `since` is `savedAt`, the last time the
 * worker wrote its status. An exited worker records its own exit, so an exited row keeps its saved `since`.
 */
export function listedSavedState({ state, savedAt }: SavedStatus): WorkerState {
  const listed = savedState(state, savedAt);
  return { ...listed, attention: { ...listed.attention, lastActivityAt: state.attention?.lastActivityAt ?? savedAt } };
}

interface Entry<T> {
  key: string;
  value: T;
}

/**
 * Parsed sealed files, one per session id, reused while the file keeps its identity. The cache
 * never holds a row: each caller builds its own row. A parse receives the file's mtime, which is
 * part of that identity. Every value that leaves the cache is a copy.
 */
export class SealedFileCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private lastNow = -Infinity;

  constructor(private readonly parse: (id: string, raw: string, mtimeMs: number) => T) {}

  /** A copy no other caller holds, or undefined when the file is missing. A failure is not kept. */
  read(id: string, file: string, now: number): T | undefined {
    const info = statSync(file, { throwIfNoEntry: false });
    if (!info) {
      this.entries.delete(id);
      return undefined;
    }
    const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const hit = this.entries.get(id);
    if (hit && hit.key === key) return structuredClone(hit.value);
    this.entries.delete(id);
    const value = this.parse(id, readFileSync(file, "utf8"), info.mtimeMs);
    if (now - Math.max(info.mtimeMs, info.ctimeMs) >= SETTLED_MS) this.entries.set(id, { key, value });
    return structuredClone(value);
  }

  /** Forgets the ids that are not listed, and every entry when the clock went back. */
  retain(ids: ReadonlySet<string>, now: number) {
    if (now < this.lastNow) this.entries.clear();
    this.lastNow = now;
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }

  /** The identity of the file whose parse is kept for this id, or undefined when no parse is kept. */
  revision(id: string): string | undefined {
    return this.entries.get(id)?.key;
  }
}
