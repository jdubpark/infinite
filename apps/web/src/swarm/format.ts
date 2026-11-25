
export function usd(value: number | undefined): string {
  if (value === undefined) return "";
  if (value >= 100) return `$${Math.round(value)}`;
  if (value >= 10) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

export function cost(value: number | undefined, unmeasured: number): { text: string; title?: string } {
  if (unmeasured <= 0) return { text: usd(value) };
  if (value) return { text: `${usd(value)}+`, title: `${unmeasured} ${unmeasured === 1 ? "agent" : "agents"} not measured` };
  return { text: "—", title: "cost not measured" };
}

export function elapsed(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function shortModel(label: string | undefined, provider: string): string {
  const name = (label ?? provider).trim().split(/\s+/)[0] ?? provider;
  return name.toLowerCase().slice(0, 10);
}

export function clockTime(iso: string): string {
  return new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

