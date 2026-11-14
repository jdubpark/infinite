export type HaltScope = "host" | "project";
export type HaltTarget = { scope: "host" } | { scope: "project"; projectId: string };

/**
 * The owner's halt covers the launch. It is not a fuse state: nothing is counted, charged, or recorded as a trip.
 * `unreadable` means the host cannot read its halt record, so it treats the whole host as halted.
 */
export type LaunchHalted = { state: "halted"; scope: HaltScope; projectId?: string; haltId: string; at: number; reason?: string; unreadable?: true };
export type HaltCheck = { state: "clear" } | LaunchHalted;

/** What a service records on an item that a halt paused, and the reason the item shows while it stays paused. */
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
/** The team statuses a halt pauses: work in progress, not paused, blocked, waiting for input, or ended. */
export const HALT_RUNNING_TEAM: ReadonlySet<string> = new Set(["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering"]);

/** Whether an item that works in these projects is in the halt's scope. */
export type HaltCovers = (projectIds: readonly string[], id: string) => boolean;
/** The halt that still covers an item in these projects after a release, if any. */
export type HaltHeldBy = (projectIds: readonly string[]) => HaltMark | undefined;

/** The host-internal entry points that each service gives the halt. Neither records an owner request. */
export interface HaltTargets {
  /** Pauses each running item in scope through the service's pause path, and marks it with the halt. */
  haltPause(mark: HaltMark, covers: HaltCovers): Promise<HaltOutcome[]>;
  /**
   * Resumes each item still paused, unchanged, under this halt's mark, through the service's resume rules. With `keep`,
   * resumes nothing: each such item loses the mark and says that the owner kept it paused.
   */
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

/** Only the exact texts above: a halt never clears a reason that something else wrote. */
export function isHaltReason(text: string | undefined): boolean {
  return text !== undefined && REASONS.has(text);
}

/** The reason an item keeps when the release could not resume it. */
export function releaseRefusal(error: string): string {
  return `The owner released the halt, but this could not resume: ${error} Resume it when it is ready.`;
}

/** The outcome text for an item that changed during the halt and is left as it is. */
export const LEFT_AS_IS = "It changed during the halt and is left as it is.";
/** The reason an item that changed during the halt shows when it is still paused after the release. */
export const LEFT_PAUSED = "The owner released the halt. This changed during the halt, so it stays paused. Resume it when it is ready.";
/** The reason an item shows when the owner released the halt and chose to keep it paused. */
export const KEPT_PAUSED = "The owner released the halt and kept this paused. Resume it when it is ready.";
/** The outcome text for an item that another halt still covers. */
export const STILL_HALTED = "Another halt still covers it.";

/** A pause that failed. The pass continues with the next item and the gate stays engaged. */
export function pauseFailure(kind: HaltItemKind, id: string, title: string, error: unknown): HaltOutcome {
  return { kind, id, title, result: "failed", reason: error instanceof Error ? error.message : "The host could not pause it." };
}
