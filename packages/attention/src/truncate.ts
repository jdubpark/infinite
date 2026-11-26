const SHORT_FIELDS = new Set(["content", "old_string", "new_string"]);
const CAP_BYTES = 16 * 1024;
const MIN_CHARS = 200;
export const MAX_ARRAY_ITEMS = 50;

export interface TruncatedArrayMarker {
  "[truncated]": true;
  omitted: number;
}

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

export function isTruncatedArrayMarker(value: unknown): value is TruncatedArrayMarker {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && value["[truncated]"] === true &&
    typeof value.omitted === "number" && Number.isInteger(value.omitted) && value.omitted > 0;
}

export function truncateInput(input: Record<string, unknown>): Record<string, unknown> {
  const slots: Slot[] = [];

  const copyValue = (container: Record<string, unknown> | unknown[], key: string | number, value: unknown, depth: number, limit: number): unknown => {
    if (typeof value === "string") {
      slots.push({ container, key, raw: value, limit });
      return cut(value, limit);
    }
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      const kept = Math.min(value.length, MAX_ARRAY_ITEMS);
      for (let i = 0; i < kept; i++) arr[i] = copyValue(arr, i, value[i], depth + 1, 4000);
      if (value.length > MAX_ARRAY_ITEMS) arr.push({ "[truncated]": true, omitted: value.length - MAX_ARRAY_ITEMS } satisfies TruncatedArrayMarker);
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
  if (size() <= CAP_BYTES) return out;

  const markerBytes = utf8Length(JSON.stringify("[truncated]"));
  const topObjects = Object.keys(out)
    .filter(key => out[key] && typeof out[key] === "object")
    .map(key => ({ key, bytes: utf8Length(JSON.stringify(out[key])) }))
    .sort((a, b) => b.bytes - a.bytes);
  let current = size();
  for (const entry of topObjects) {
    if (current <= CAP_BYTES) break;
    out[entry.key] = "[truncated]";
    current -= entry.bytes - markerBytes;
  }
  if (size() <= CAP_BYTES) return out;

  const topValues = Object.keys(out)
    .map(key => ({ key, bytes: utf8Length(JSON.stringify(out[key])) }))
    .filter(entry => entry.bytes > markerBytes)
    .sort((a, b) => b.bytes - a.bytes);
  current = size();
  for (const entry of topValues) {
    if (current <= CAP_BYTES) break;
    out[entry.key] = "[truncated]";
    current -= entry.bytes - markerBytes;
  }
  if (size() <= CAP_BYTES) return out;

  const keys = Object.keys(out);
  out["[truncated]"] = "[truncated]";
  current = size();
  for (let i = keys.length - 1; i >= 0 && current > CAP_BYTES; i--) {
    const key = keys[i]!;
    if (key === "[truncated]") continue;
    const entryBytes = utf8Length(JSON.stringify(key)) + 1 + utf8Length(JSON.stringify(out[key])) + 1;
    delete out[key];
    current -= entryBytes;
  }
  if (size() > CAP_BYTES) return { "[truncated]": "[truncated]" };
  return out;
}
