import type { Provider } from "./types.js";
import { cleanLine } from "./prompts.js";

export interface DetectedLimit {
  limit: "usage" | "credits";
  resetsAt?: string;
  message: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function hour24(h: string, meridiem: string): number | undefined {
  const n = Number(h);
  if (n < 1 || n > 12) return undefined;
  return (n % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
}

/**
 * Parses a provider reset hint into an ISO time: `resets 3:45pm`, `resets Mon 12:00am`, or
 * `Try again at Oct 18, 2026 3:45 PM`. Clock times are read as UTC (the host runs in UTC) and
 * resolve to the next occurrence after `now`. Returns undefined when the text has no known shape.
 */
export function parseResetTime(text: string, now: Date): string | undefined {
  const dated = /Try again at\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])/.exec(text);
  if (dated) {
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    const hour = hour24(dated[4], dated[6]);
    if (month < 0 || hour === undefined) return undefined;
    return new Date(Date.UTC(Number(dated[3]), month, Number(dated[2]), hour, Number(dated[5]))).toISOString();
  }
  const clock = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+)?(\d{1,2}):(\d{2})\s*([AaPp][Mm])/.exec(text);
  if (!clock) return undefined;
  const hour = hour24(clock[2], clock[4]);
  const minute = Number(clock[3]);
  if (hour === undefined || minute > 59) return undefined;
  const at = (dayOffset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, minute));
  if (clock[1]) {
    const day = DAYS.indexOf(clock[1].toLowerCase());
    if (day < 0) return undefined;
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = at(offset);
      if (candidate.getUTCDay() === day && candidate.getTime() > now.getTime()) return candidate.toISOString();
    }
    return undefined;
  }
  for (let offset = 0; offset <= 1; offset += 1) {
    const candidate = at(offset);
    if (candidate.getTime() > now.getTime()) return candidate.toISOString();
  }
  return undefined;
}

/**
 * Reads a provider usage limit off the screen. Codex only counts when its own status row (the last
 * non-empty row, as a whole `·`-separated segment) says `usage limited`: transcript text can be printed by a member
 * with cat or grep and must never trigger on its own.
 */
export function detectLimit(lines: string[], provider: Provider, now: Date): DetectedLimit | null {
  const clean = lines.map(cleanLine);
  if (provider === "claude") {
    const line = clean.find((l) => /You've hit your .* limit/.test(l));
    if (!line) return null;
    return { limit: "usage", resetsAt: parseResetTime(line, now), message: line.slice(0, 300) };
  }
  if (provider === "codex") {
    const last = clean.filter((l) => l !== "").at(-1);
    if (last === undefined || /^[›$%]/.test(last)) return null;
    if (!last.split(/[·|]/).some((segment) => segment.trim().toLowerCase() === "usage limited")) return null;
    const credits = clean.find((l) => /out of credits/i.test(l));
    const reached = clean.find((l) => /usage limit reached/i.test(l));
    const reset = clean.map((l) => parseResetTime(l, now)).filter((t) => t !== undefined).at(-1);
    return {
      limit: credits ? "credits" : "usage",
      resetsAt: reset,
      message: (credits ?? reached ?? "Codex reported a usage limit").slice(0, 300),
    };
  }
  return null;
}
