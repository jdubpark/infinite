export const PAGE_MAX_ITEMS = 50;
export const PAGE_MAX_BYTES = 512 * 1024;

/** The cursor names the last item of the previous page, so a list that grew in front still resumes after it. */
export function encodeCursor(index: number, key: string): string { return Buffer.from(`${index}:${key}`).toString("base64url"); }

export function decodeCursor(value: string): { index: number; key: string } | null {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(value)) return null;
  const text = Buffer.from(value, "base64url").toString("utf8"), split = text.indexOf(":");
  const index = Number(text.slice(0, split));
  return split > 0 && Number.isSafeInteger(index) && index >= 0 ? { index, key: text.slice(split + 1) } : null;
}

export function pageOf<T>(items: T[], cursor: string | undefined, key: (item: T) => string): { items: T[]; next: string | null } {
  const decoded = cursor ? decodeCursor(cursor) : null;
  let start = 0;
  if (decoded) {
    const at = items[decoded.index] && key(items[decoded.index]!) === decoded.key ? decoded.index : items.findIndex(item => key(item) === decoded.key);
    start = at >= 0 ? at + 1 : Math.min(decoded.index + 1, items.length);
  }
  const page: T[] = [];
  let used = 0;
  for (let index = start; index < items.length && page.length < PAGE_MAX_ITEMS; index++) {
    const size = Buffer.byteLength(JSON.stringify(items[index])) + 1;
    if (page.length && used + size > PAGE_MAX_BYTES) break;
    page.push(items[index]!); used += size;
  }
  const last = start + page.length - 1;
  return { items: page, next: page.length && last + 1 < items.length ? encodeCursor(last, key(items[last]!)) : null };
}
