import type { Event, TerminalSize } from "./types.js";

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 32 };

function validDimension(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function isValidTerminalSize(cols: unknown, rows: unknown): boolean {
  return validDimension(cols, 1, 1000) && validDimension(rows, 1, 1000);
}

export function isPtyTerminalSize(cols: unknown, rows: unknown): boolean {
  return validDimension(cols, 20, 240) && validDimension(rows, 5, 100);
}

export function terminalSizeOf(value: unknown): TerminalSize | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { cols, rows } = value as Record<string, unknown>;
  return validDimension(cols, 1, 1000) && validDimension(rows, 1, 1000) ? { cols, rows } : undefined;
}

export function terminalSizeFromEvent(event: Event): TerminalSize | undefined {
  if (event.type !== "lifecycle" && event.type !== "output") return undefined;
  return terminalSizeOf(event.data) ?? terminalSizeOf(event.data.terminalSize);
}

type EventPageReader = (
  after: number,
  limit: number,
  types?: Set<string>,
) => { events: Event[]; cursor: number; more: boolean };

const MAX_SIZE_SCAN_PAGES = 32;

export function resolveReplayTerminalSize(
  readPage: EventPageReader,
  after: number,
  fallback?: TerminalSize,
): TerminalSize | undefined {
  if (after === 0) {
    const page = readPage(0, 200, new Set(["output", "lifecycle"]));
    for (const event of page.events) {
      const size = terminalSizeFromEvent(event);
      if (size) return size;
      if (event.type === "output") break;
    }
    return fallback ? terminalSizeOf(fallback) : undefined;
  }
  let cursor = 0;
  let resolved: TerminalSize | undefined;
  for (let scanned = 0; scanned < MAX_SIZE_SCAN_PAGES && cursor < after; scanned++) {
    const page = readPage(cursor, 200, new Set(["lifecycle"]));
    for (const event of page.events) {
      if (event.seq > after) return resolved ?? (fallback ? terminalSizeOf(fallback) : undefined);
      const size = terminalSizeFromEvent(event);
      if (size) resolved = size;
    }
    if (!page.more || page.cursor <= cursor) break;
    cursor = page.cursor;
  }
  return resolved ?? (fallback ? terminalSizeOf(fallback) : undefined);
}
