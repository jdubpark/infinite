import { readFileSync, statSync } from "node:fs";
import type { Session } from "./types.js";

/**
 * A parse of a file younger than this may be followed by another write in the same timestamp
 * tick, with the same size and the same identity, so it is read again instead of kept.
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

interface Entry<T> {
  key: string;
  value: T;
}

/**
 * Parsed sealed files, one per session id, reused while the file keeps its identity. The cache
 * never holds a row: each caller builds its own row, with its own time. Every value that leaves
 * the cache is a copy.
 */
export class SealedFileCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private lastNow = -Infinity;

  constructor(private readonly parse: (id: string, raw: string) => T) {}

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
    const value = this.parse(id, readFileSync(file, "utf8"));
    if (now - info.mtimeMs >= SETTLED_MS) this.entries.set(id, { key, value });
    return structuredClone(value);
  }

  /** Forgets the ids that are not listed, and every entry when the clock went back. */
  retain(ids: ReadonlySet<string>, now: number) {
    if (now < this.lastNow) this.entries.clear();
    this.lastNow = now;
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }
}
