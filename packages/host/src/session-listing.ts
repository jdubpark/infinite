import { readFileSync, statSync } from "node:fs";
import { applyLifecycle, initialAttention } from "@infinite/attention";
import type { Session, WorkerState } from "./types.js";

export const SETTLED_MS = 2000;

export type ListedSession = Omit<Session, "context" | "initialPrompt" | "generatedTitle" | "nativeArgs" | "handoff" | "codeMode">;

export function withoutCodeMode<T extends Session>(session: T): Omit<T, "codeMode"> {
  const { codeMode: _codeMode, ...visible } = session;
  return visible;
}

export function listedSession(session: Session): ListedSession {
  const {
    context: _context,
    initialPrompt: _prompt,
    generatedTitle: _generatedTitle,
    nativeArgs: _nativeArgs,
    handoff: _handoff,
    ...summary
  } = withoutCodeMode(session);
  return summary;
}

export const unavailableState = (at: string): WorkerState => ({
  status: "unavailable",
  seq: 0,
  screen: "",
  attention: applyLifecycle(initialAttention(at, false), "unavailable", at),
});

export function savedState(saved: WorkerState, at: string): WorkerState {
  const { socketPath: _socketPath, permissionSocketPath: _permissionSocketPath, ...visible } = saved;
  const status = visible.status === "exited" ? "exited" : "unavailable";
  return {
    ...visible,
    status,
    screen: "",
    attention: applyLifecycle(visible.attention ?? initialAttention(at, false), status, at),
  };
}

export type SavedStatus = { state: WorkerState; savedAt: string; socketPath?: string; permissionSocketPath?: string };

export function listedSavedState({ state, savedAt }: SavedStatus): WorkerState {
  const listed = savedState(state, savedAt);
  return { ...listed, attention: { ...listed.attention, lastActivityAt: state.attention?.lastActivityAt ?? savedAt } };
}

interface Entry<T> {
  key: string;
  value: T;
}

export class SealedFileCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private lastNow = -Infinity;

  constructor(private readonly parse: (id: string, raw: string, mtimeMs: number) => T) {}

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

  retain(ids: ReadonlySet<string>, now: number) {
    if (now < this.lastNow) this.entries.clear();
    this.lastNow = now;
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }

  revision(id: string): string | undefined {
    return this.entries.get(id)?.key;
  }
}
