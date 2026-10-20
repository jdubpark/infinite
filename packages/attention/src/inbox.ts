import type { Attention } from "./types.js";

export type InboxGroup = "Needs you" | "Working" | "Finished" | "Exited" | "Archived";

type Row = { attention: Attention; createdAt: string; archivedAt?: string };

/** An archived record leaves the live groups whatever its last state was. */
function groupFor(row: Row): InboxGroup {
  if (row.archivedAt) return "Archived";
  switch (row.attention.state) {
    case "needs-you": return "Needs you";
    case "working": return "Working";
    case "turn-finished": case "idle": return "Finished";
    default: return "Exited";
  }
}

export function groupSessions<T extends Row>(rows: T[]): { title: InboxGroup; rows: T[] }[] {
  const order: InboxGroup[] = ["Needs you", "Working", "Finished", "Exited", "Archived"];
  const byGroup = new Map<InboxGroup, T[]>(order.map((g) => [g, []]));
  for (const row of rows) byGroup.get(groupFor(row))!.push(row);
  return order
    .map((title) => ({ title, rows: byGroup.get(title)!.sort((a, b) => (a.attention.since < b.attention.since ? 1 : -1)) }))
    .filter((g) => g.rows.length);
}
