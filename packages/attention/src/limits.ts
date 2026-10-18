import type { Provider } from "./types.js";

export type DetectedLimit = { limit: "usage" | "credits"; resetsAt?: string; message: string };

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
  sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const WEEKDAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

function clock(text: string): { hour: number; minute: number } | undefined {
  const match = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour > 23)) return undefined;
  if (meridiem) hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
  return { hour, minute };
}

function isoUtc(year: number, month: number, day: number, time: { hour: number; minute: number }): string | undefined {
  const date = new Date(Date.UTC(year, month, day, time.hour, time.minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  return date.toISOString();
}

function nextClockOccurrence(now: Date, time: { hour: number; minute: number }, days = 0, weekly = false): string {
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days, time.hour, time.minute));
  if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + (weekly ? 7 : 1));
  return candidate.toISOString();
}

/** Parses the provider's reset text as UTC and returns its next occurrence after `now`. */
export function parseResetTime(text: string, now: Date): string | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const time = clock(normalized);
  if (!time) return undefined;

  const dated = normalized.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (dated) return isoUtc(Number(dated[3]), MONTHS[dated[1].toLowerCase()], Number(dated[2]), time);

  const weekday = normalized.match(/\b(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b/i);
  const base = new Date(now);
  if (weekday) {
    const target = WEEKDAYS[weekday[1].toLowerCase()];
    const days = (target - base.getUTCDay() + 7) % 7;
    return nextClockOccurrence(now, time, days, true);
  }
  return nextClockOccurrence(now, time);
}

/** Detects only visible provider limit indicators; Codex transcript prose is never sufficient. */
export function detectLimit(lines: string[], provider: Provider, now: Date): DetectedLimit | null {
  const nonempty = lines.map((line) => line.trim()).filter(Boolean);
  if (provider === "claude") {
    const notice = nonempty.find((line) => /you've hit your .*? limit\b/i.test(line));
    if (!notice) return null;
    const resetClause = notice.match(/\bresets?\b.*$/i)?.[0];
    return { limit: "usage", ...(resetClause ? { resetsAt: parseResetTime(resetClause, now) } : {}), message: notice.slice(0, 500) };
  }
  if (provider !== "codex") return null;
  // The installed protocol schema does not describe the TUI footer, and no authentic
  // screen sample establishes a footer grammar. Treating a near-bottom phrase as status
  // text can reroute other work, so screen-only Codex observations stay disabled until
  // the provider's actual footer structure is verified.
  return null;
}
