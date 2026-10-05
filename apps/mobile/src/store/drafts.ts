/** A text send whose delivery is unconfirmed; "Retry" resends it with the same requestId. */
export type PendingInput = {
  requestId: string;
  text: string;
  submit: boolean;
  force?: boolean;
};
type Draft = { text: string; pending: PendingInput | null };

// Unsent drafts never leave process memory. Disconnecting the phone clears them.
const drafts = new Map<string, Draft>();

/** The composer's text and unconfirmed request, kept across navigation within one app run. */
export function readDraft(key: string): Draft {
  return drafts.get(key) ?? { text: "", pending: null };
}

export function writeDraft(key: string, draft: Draft) {
  if (!draft.text && !draft.pending) drafts.delete(key);
  else drafts.set(key, draft);
}

export function clearDrafts() {
  drafts.clear();
}
