import type { AttentionState } from "@infinite/attention";

export type StatusKind =
  | "backlog" | "todo" | "progress" | "review" | "done" | "attention" | "paused" | "blocked"
  | "stopped" | "cancelled" | "error";

export const SESSION_KIND: Record<AttentionState, StatusKind> = {
  "needs-you": "attention",
  working: "progress",
  "turn-finished": "review",
  idle: "todo",
  exited: "stopped",
  unavailable: "error",
  "recording-error": "error",
};

export const SESSION_LABELS: Record<AttentionState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  "turn-finished": "Turn finished",
  idle: "Idle",
  exited: "Exited",
  unavailable: "Unreachable",
  "recording-error": "Recording error",
};

export function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";
  if (!first) return "?";
  const capitals = first.match(/[A-Z]/g) ?? [];
  if (capitals.length >= 2) return capitals[0]! + capitals[1]!;
  const second = words[1];
  if (second && /^[A-Z]/.test(second)) return first[0]!.toUpperCase() + second[0]!;
  const digit = label.match(/\d/)?.[0];
  if (digit) return first[0]!.toUpperCase() + digit;
  return first[0]!.toUpperCase() + (first[1] ?? "");
}

export function age(iso: string, now: number): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
