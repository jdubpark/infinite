import { useCallback, useSyncExternalStore } from "react";

/** A text send whose delivery is unconfirmed; Retry keeps the same requestId. */
export type PendingInput = {
  requestId: string;
  text: string;
  submit: boolean;
  force?: boolean;
};
type Draft = { text: string; pending: PendingInput | null };
const EMPTY: Draft = { text: "", pending: null };
// Drafts never leave process memory. Receipts settle here even after a screen unmounts.
const drafts = new Map<string, Draft>();
const listeners = new Map<string, Set<() => void>>();

export function readDraft(key: string): Draft {
  return drafts.get(key) ?? EMPTY;
}

export function writeDraft(key: string, draft: Draft) {
  const previous = readDraft(key);
  if (previous.text === draft.text && previous.pending === draft.pending) return;
  if (!draft.text && !draft.pending) drafts.delete(key);
  else drafts.set(key, draft);
  listeners.get(key)?.forEach(listener => listener());
}

/** A delayed receipt can settle its own request, never a newer draft or send. */
export function settleDraft(key: string, requestId: string, delivered: boolean) {
  const draft = readDraft(key);
  if (draft.pending?.requestId !== requestId) return;
  writeDraft(key, {
    text: delivered && draft.text === draft.pending.text ? "" : draft.text,
    pending: null,
  });
}

export function useSessionDraft(key: string) {
  const subscribe = useCallback((listener: () => void) => {
    let group = listeners.get(key);
    if (!group) { group = new Set(); listeners.set(key, group); }
    group.add(listener);
    return () => { group.delete(listener); if (!group.size) listeners.delete(key); };
  }, [key]);
  const snapshot = useCallback(() => readDraft(key), [key]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function clearDrafts(machine?: string) {
  for (const key of drafts.keys()) if (!machine || key.startsWith(`${machine}/`)) writeDraft(key, EMPTY);
}
