/** Compact figures for a view with little text. */

export function usd(value: number | undefined): string {
  if (value === undefined) return "";
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

/** Elapsed time since an ISO instant: 42s, 3m, 2h, 4d. Empty when the instant is unknown. */
export function elapsed(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** A short lowercase model name for a tile: the label up to its first space, at most ten characters. */
export function shortModel(label: string | undefined, provider: string): string {
  const name = (label ?? provider).trim().split(/\s+/)[0] ?? provider;
  return name.toLowerCase().slice(0, 10);
}

/** Wall-clock HH:MM in the viewer's time zone. */
export function clockTime(iso: string): string {
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** Keeps the tail of a path so the file or deepest directory stays visible. */
export function shortPath(path: string, max = 28): string {
  return path.length <= max ? path : `…${path.slice(path.length - max + 1)}`;
}
