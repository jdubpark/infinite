import { z } from "zod";

export const AUTONOMY_MODES = ["supervised", "autonomous"] as const;
export type AutonomyMode = typeof AUTONOMY_MODES[number];
export const autonomyModeSchema = z.enum(AUTONOMY_MODES);
export type AutonomySource = "saved" | "host-default" | "not-enrolled";

export function autonomyOf(value: { autonomy?: unknown } | undefined): AutonomyMode {
  return value?.autonomy === "autonomous" ? "autonomous" : "supervised";
}

export function enrollmentAutonomy(saved: { autonomy?: unknown }, config: { autonomy?: { defaultMode?: AutonomyMode } }): { mode: AutonomyMode; source: "saved" | "host-default" } {
  if (saved.autonomy !== undefined) return { mode: autonomyOf(saved), source: "saved" };
  return { mode: config.autonomy?.defaultMode ?? "autonomous", source: "host-default" };
}
