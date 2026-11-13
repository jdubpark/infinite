import { z } from "zod";

/** A project's autonomy mode: whether the host may act without the owner in the loop. Stored only by the owner. */
export const AUTONOMY_MODES = ["supervised", "autonomous"] as const;
export type AutonomyMode = typeof AUTONOMY_MODES[number];
export const autonomyModeSchema = z.enum(AUTONOMY_MODES);
export type AutonomySource = "saved" | "host-default" | "not-enrolled";

/** "autonomous" only when value.autonomy is exactly "autonomous". Missing, null, or unknown is "supervised". */
export function autonomyOf(value: { autonomy?: unknown } | undefined): AutonomyMode {
  return value?.autonomy === "autonomous" ? "autonomous" : "supervised";
}

/**
 * An applied enrollment: a valid saved mode, else config.autonomy.defaultMode, else "autonomous".
 * A saved non-mode is "supervised" (fails closed).
 */
export function enrollmentAutonomy(saved: { autonomy?: unknown }, config: { autonomy?: { defaultMode?: AutonomyMode } }): { mode: AutonomyMode; source: "saved" | "host-default" } {
  if (saved.autonomy !== undefined) return { mode: autonomyOf(saved), source: "saved" };
  return { mode: config.autonomy?.defaultMode ?? "autonomous", source: "host-default" };
}
