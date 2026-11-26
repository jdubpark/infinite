import type { LogEvent } from "./api";

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export function readTerminalDimensions(value: unknown): TerminalDimensions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const cols = record.cols;
  const rows = record.rows;
  if (
    typeof cols === "number" &&
    typeof rows === "number" &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    cols <= 1000 &&
    rows > 0 &&
    rows <= 1000
  ) {
    return { cols, rows };
  }
  return undefined;
}

export function eventTerminalDimensions(event: LogEvent): TerminalDimensions | undefined {
  if (event.type !== "lifecycle" && event.type !== "output") return undefined;
  return readTerminalDimensions(event.data) ?? readTerminalDimensions(event.data.terminalSize);
}
