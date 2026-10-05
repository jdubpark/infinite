import type { Attention } from "./types.js";

export type InboxGroup = "Needs you" | "Working" | "Finished" | "Exited";

export function groupFor(att: Attention): InboxGroup {
  switch (att.state) {
    case "needs-you": return "Needs you";
    case "working": return "Working";
    case "turn-finished": case "idle": return "Finished";
    default: return "Exited";
  }
}

export function groupSessions<T extends { attention: Attention; createdAt: string }>(rows: T[]): { title: InboxGroup; rows: T[] }[] {
  const order: InboxGroup[] = ["Needs you", "Working", "Finished", "Exited"];
  const byGroup = new Map<InboxGroup, T[]>(order.map((g) => [g, []]));
  for (const row of rows) byGroup.get(groupFor(row.attention))!.push(row);
  return order
    .map((title) => ({ title, rows: byGroup.get(title)!.sort((a, b) => (a.attention.since < b.attention.since ? 1 : -1)) }))
    .filter((g) => g.rows.length);
}
