export type HaltScope = "host" | "project";
export type HaltTarget = { scope: "host" } | { scope: "project"; projectId: string };

export type LaunchHalted =
  | { state: "halted"; scope: "host"; projectId?: undefined; haltId: string; at: number; reason?: string; unreadable?: true }
  | { state: "halted"; scope: "project"; projectId: string; haltId: string; at: number; reason?: string; unreadable?: undefined };
export type HaltCheck = { state: "clear" } | LaunchHalted;

export type HaltMark = { haltId: string; reason: string };
export const HALT_ITEM_KINDS = ["routine", "goal", "mission", "team"] as const;
export type HaltItemKind = typeof HALT_ITEM_KINDS[number];
export const HALT_RESULTS = ["paused", "failed", "resumed", "held", "kept", "left", "refused"] as const;
export type HaltOutcome = {
  kind: HaltItemKind;
  id: string;
  title: string;
  result: typeof HALT_RESULTS[number];
  reason?: string;
};
export const HALT_RUNNING_TEAM: ReadonlySet<string> = new Set(["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering"]);
export const HALT_PAUSED_TEAM: ReadonlySet<string> = new Set([...HALT_RUNNING_TEAM, "needs-input"]);

export type HaltCovers = (projectIds: readonly string[], id: string) => boolean;
export type HaltHeldBy = (projectIds: readonly string[]) => HaltMark | undefined;

export interface HaltTargets {
  haltPause(mark: HaltMark, covers: HaltCovers): Promise<HaltOutcome[]>;
  haltResume(haltId: string, heldBy: HaltHeldBy, keep: boolean): Promise<HaltOutcome[]>;
}

const HOST_REASON = "Halted by the owner for the whole host.";
const PROJECT_REASON = "Halted by the owner for this project.";
const UNREADABLE_REASON = "Halted: the host cannot read the owner's halt record.";
const REASONS = new Set([HOST_REASON, PROJECT_REASON, UNREADABLE_REASON]);

export function haltReason(hold: { scope: HaltScope; unreadable?: true }): string {
  if (hold.unreadable) return UNREADABLE_REASON;
  return hold.scope === "host" ? HOST_REASON : PROJECT_REASON;
}

export function isHaltReason(text: string | undefined): boolean {
  return text !== undefined && REASONS.has(text);
}

export function releaseRefusal(error: string): string {
  return `The owner released the halt, but this could not resume: ${error} Resume it when it is ready.`;
}

export const LEFT_AS_IS = "It changed during the halt and is left as it is.";
export const LEFT_PAUSED = "The owner released the halt. This changed during the halt, so it stays paused. Resume it when it is ready.";
export const KEPT_PAUSED = "The owner released the halt and kept this paused. Resume it when it is ready.";
export const STILL_HALTED = "Another halt still covers it.";

export function pauseFailure(kind: HaltItemKind, id: string, title: string, error: unknown): HaltOutcome {
  return { kind, id, title, result: "failed", reason: error instanceof Error ? error.message : "The host could not pause it." };
}
