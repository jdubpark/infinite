import { readFileSync } from "node:fs";
import { z } from "zod";
import { unseal, writeSealed } from "../vault.js";
import { HOUR_MS, utcDay } from "./rules.js";
import type { FuseLaunchRecord, FuseTripRecord, LaunchRole } from "./types.js";

export const BASELINE_FILE = "fuse-baseline.sealed";
export const BASELINE_SCOPE = "fuse-baseline";

export type FuseBaseline = { version: 1; seq: number; launches: FuseLaunchRecord[]; trips: FuseTripRecord[] };

const LAUNCH_ROLES = ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker", "evaluator", "judge", "mission-coordinator"] as const satisfies readonly LaunchRole[];
const everyRoleListed: Exclude<LaunchRole, typeof LAUNCH_ROLES[number]> extends never ? true : never = true;
void everyRoleListed;

const id = z.string().min(1).max(128);
const projectId = z.string().min(1);
const seq = z.number().int().min(0);
const time = z.number().int();

const launchSchema = z.object({
  launchId: id,
  projectId,
  purpose: z.enum(["work", "duel", "replay", "gate"]),
  role: z.enum(LAUNCH_ROLES),
  profileId: id,
  assignment: z.object({ runId: id, memberId: id, revision: z.number().int().min(1) }).strict().optional(),
  state: z.enum(["admitted", "started", "released"]),
  admittedAt: time,
  seq,
}).strict();

const tripBase = {
  tripId: id,
  cause: z.enum(["launch-rate", "tokens", "list-usd", "spent-usd", "unmeasurable"]),
  window: z.enum(["hour", "day", "week"]).optional(),
  openedAt: time,
  ownerClose: z.boolean(),
  announcedAt: time.optional(),
  launches: z.number().int().min(0).optional(),
  seq,
};

const closedFields = { closedAt: time, closedBy: z.enum(["rate", "owner", "baseline"]) };

const tripSchema: z.ZodType<FuseTripRecord> = z.union([
  z.object({ ...tripBase, scope: z.literal("host") }).strict(),
  z.object({ ...tripBase, scope: z.literal("host"), ...closedFields }).strict(),
  z.object({ ...tripBase, scope: z.literal("project"), projectId }).strict(),
  z.object({ ...tripBase, scope: z.literal("project"), projectId, ...closedFields }).strict(),
]);

const baselineSchema: z.ZodType<FuseBaseline> = z.object({
  version: z.literal(1),
  seq,
  launches: z.array(launchSchema).max(5000),
  trips: z.array(tripSchema).max(1000),
}).strict();

export function readBaseline(file: string, key: Buffer): FuseBaseline | undefined {
  try {
    const parsed = baselineSchema.safeParse(unseal<unknown>(key, BASELINE_SCOPE, readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeBaseline(file: string, key: Buffer, baseline: FuseBaseline): boolean {
  try {
    if (!baselineSchema.safeParse(baseline).success) return false;
    writeSealed(file, key, BASELINE_SCOPE, baseline);
    return true;
  } catch {
    return false;
  }
}

export function mergeBaselines(file: FuseBaseline | undefined, store: FuseBaseline | undefined, now: number): FuseBaseline | undefined {
  if (!file) return store && pruneBaseline(store, now);
  if (!store) return pruneBaseline(file, now);
  return pruneBaseline(
    {
      version: 1,
      seq: Math.max(file.seq, store.seq),
      launches: mergeById(file.launches, store.launches, (item) => item.launchId, file.seq),
      trips: mergeById(file.trips, store.trips, (item) => item.tripId, file.seq),
    },
    now,
  );
}

export function pruneBaseline(baseline: FuseBaseline, now: number): FuseBaseline {
  const today = utcDay(now);
  const weekAgo = now - 7 * 86_400_000;
  return {
    ...baseline,
    launches: baseline.launches.filter((item) => item.state === "admitted" || item.admittedAt > now - HOUR_MS),
    trips: baseline.trips.filter(
      (item) =>
        item.closedAt === undefined ||
        utcDay(item.openedAt) >= today ||
        item.closedAt >= now - HOUR_MS ||
        (item.closedBy === "owner" && item.window === "day" && utcDay(item.closedAt) >= today) ||
        (item.closedBy === "owner" && item.window === "week" && item.closedAt > weekAgo),
    ),
  };
}

function mergeById<T extends { seq: number }>(file: T[], store: T[], idOf: (item: T) => string, fileSeq: number): T[] {
  const merged = new Map<string, T>();
  for (const item of file) merged.set(idOf(item), item);
  for (const item of store) {
    const existing = merged.get(idOf(item));
    if (existing === undefined) { if (item.seq > fileSeq) merged.set(idOf(item), item); }
    else if (item.seq > existing.seq) merged.set(idOf(item), item);
  }
  return [...merged.values()];
}
