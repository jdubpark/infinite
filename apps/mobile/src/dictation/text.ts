/**
 * Adds a dictated addition to the end of a field's draft. `dropped` counts the addition's
 * characters that did not fit under `maxLength`; the draft itself is never clipped.
 */
export function appendDictation(draft: string, addition: string, maxLength: number): { text: string; dropped: number } {
  const spoken = addition.trim();
  if (!spoken) return { text: draft, dropped: 0 };
  const separator = draft === "" || /\s$/.test(draft) ? "" : " ";
  const room = Math.max(0, maxLength - draft.length - separator.length);
  const kept = spoken.slice(0, room);
  if (!kept) return { text: draft, dropped: spoken.length };
  return { text: draft + separator + kept, dropped: spoken.length - kept.length };
}
