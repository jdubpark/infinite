/**
 * The phone's shared reading of work state as icons and avatars. No React Native imports, so the
 * mappings can be tested under Node.
 */
import type { AttentionState } from "@infinite/attention";

/** Linear-style work states drawn by StatusIcon. */
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

/** Short state names for compact rows; the full sentences stay in detail views. */
export const SESSION_LABELS: Record<AttentionState, string> = {
  "needs-you": "Needs you",
  working: "Working",
  "turn-finished": "Turn finished",
  idle: "Idle",
  exited: "Exited",
  unavailable: "Unreachable",
  "recording-error": "Recording error",
};

/**
 * Two characters that identify an agent's model or provider: "Opus 5.5" → "O5",
 * "DeepSeek V4.1" → "DS", "Muse Spark" → "MS", "Codex" → "Co".
 */
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

/** "now", "4m", "3h", "2d" since `iso`, measured at `now`. */
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
