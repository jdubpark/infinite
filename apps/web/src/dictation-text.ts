export function appendDictation(draft: string, addition: string, maxLength: number): { text: string; dropped: number } {
  const trimmed = addition.trim();
  if (!trimmed) return { text: draft, dropped: 0 };
  if (draft.length >= maxLength) return { text: draft, dropped: trimmed.length };
  const separator = draft && !/\s$/.test(draft) ? " " : "";
  const available = Math.max(0, maxLength - draft.length - separator.length);
  const inserted = trimmed.slice(0, available);
  return { text: draft + separator + inserted, dropped: trimmed.length - inserted.length };
}
