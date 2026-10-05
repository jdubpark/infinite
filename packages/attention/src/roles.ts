import type { OptionRole } from "./types.js";

export function roleForLabel(label: string): OptionRole {
  const text = label.trim();
  if (/^Yes, and (don'?t ask again|allow|switch|grant)/i.test(text)) return "accept-always";
  if (/^Yes\b/i.test(text)) return "accept";
  if (/^No, and tell/i.test(text)) return "reject-with-feedback";
  if (/^No\b/i.test(text)) return "reject";
  return "other";
}
