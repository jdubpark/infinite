const SHORT_FIELDS = new Set(["content", "old_string", "new_string"]);
const CAP_BYTES = 16 * 1024;
const MIN_CHARS = 200;

export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} … [+${text.length - max} chars]`;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

interface Slot { container: Record<string, unknown> | unknown[]; key: string | number; raw: string; limit: number }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const set = (slot: Slot, value: string) => { (slot.container as Record<string | number, unknown>)[slot.key] = value; };

/** Bounds a tool input for storage: per-field limits first, then a 16 KiB (UTF-8) cap on the whole record. */
export function truncateInput(input: Record<string, unknown>): Record<string, unknown> {
  const slots: Slot[] = [];

  const copyValue = (container: Record<string, unknown> | unknown[], key: string | number, value: unknown, depth: number, limit: number): unknown => {
    if (typeof value === "string") {
      slots.push({ container, key, raw: value, limit });
      return cut(value, limit);
    }
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      value.slice(0, 50).forEach((item, i) => { arr[i] = copyValue(arr, i, item, depth + 1, 4000); });
      return arr;
    }
    if (isObject(value) && depth < 3) return copyObject(value, depth + 1);
    return value;
  };
  const copyObject = (src: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) out[key] = copyValue(out, key, value, depth, SHORT_FIELDS.has(key) ? 2000 : 4000);
    return out;
  };

  const out = copyObject(input, 0);
  const size = () => utf8Length(JSON.stringify(out));
  if (size() <= CAP_BYTES) return out;

  // Halve the largest string anywhere until the record fits, always re-cutting from the original text.
  while (size() > CAP_BYTES) {
    let best: Slot | undefined;
    let bestLen = MIN_CHARS;
    for (const slot of slots) {
      const len = Math.min(slot.raw.length, slot.limit);
      if (len > bestLen) { best = slot; bestLen = len; }
    }
    if (!best) break;
    best.limit = Math.max(MIN_CHARS, Math.floor(bestLen / 2));
    set(best, cut(best.raw, best.limit));
  }
  if (size() <= CAP_BYTES) return out;

  const collapse = (node: Record<string, unknown> | unknown[], depth: number) => {
    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key];
      if (child && typeof child === "object") {
        if (depth + 1 >= 2) (node as Record<string, unknown>)[key] = "[truncated]";
        else collapse(child as Record<string, unknown>, depth + 1);
      }
    }
  };
  collapse(out, 0);
  return out;
}
