import { readFileSync } from "node:fs";
import { z } from "zod";
import { unseal, writeSealed } from "../vault.js";
import { HOUR_MS, utcDay } from "./rules.js";
import type { FuseLaunchRecord, FuseTripRecord, LaunchRole } from "./types.js";

export const BASELINE_FILE = "fuse-baseline.sealed";
export const BASELINE_SCOPE = "fuse-baseline";

export type FuseBaseline = { version: 1; seq: number; launches: FuseLaunchRecord[]; trips: FuseTripRecord[] };

/** Every launch role. The check below fails the build when `LaunchRole` gains a role this list lacks. */
const LAUNCH_ROLES = ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "mission-coordinator"] as const satisfies readonly LaunchRole[];
const everyRoleListed: Exclude<LaunchRole, typeof LAUNCH_ROLES[number]> extends never ? true : never = true;
void everyRoleListed;

const id = z.string().min(1).max(128);
const seq = z.number().int().min(0);
const time = z.number().int();

const launchSchema = z.object({
  launchId: id,
  projectId: id,
  purpose: z.enum(["work", "duel", "replay", "gate"]),
  role: z.enum(LAUNCH_ROLES),
  profileId: id,
  assignment: z.object({ runId: id, memberId: id, revision: z.number().int().min(1) }).strict().optional(),
  state: z.enum(["admitted", "started", "released"]),
  admittedAt: time,
  seq,
}).strict();

const tripSchema = z.object({
  tripId: id,
  scope: z.enum(["project", "host"]),
  projectId: id.optional(),
  cause: z.enum(["launch-rate", "unmeasurable"]),
  window: z.enum(["hour", "day", "week"]).optional(),
  openedAt: time,
  closedAt: time.optional(),
  closedBy: z.enum(["rate", "owner", "baseline"]).optional(),
  ownerClose: z.boolean(),
  announcedAt: time.optional(),
  launches: z.number().int().min(0).optional(),
  seq,
}).strict();

const baselineSchema: z.ZodType<FuseBaseline> = z.object({
  version: z.literal(1),
  seq,
  launches: z.array(launchSchema).max(5000),
  trips: z.array(tripSchema).max(1000),
}).strict();

/** Undefined when the file is missing, fails authentication, or fails the schema. Never throws. */
export function readBaseline(file: string, key: Buffer): FuseBaseline | undefined {
  try {
    const parsed = baselineSchema.safeParse(unseal<unknown>(key, BASELINE_SCOPE, readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** `writeSealed` under BASELINE_SCOPE. False on any failure, including a baseline outside the schema. Never throws. */
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
      launches: mergeById(file.launches, store.launches, (item) => item.launchId, pickLaunch),
      trips: mergeById(file.trips, store.trips, (item) => item.tripId, pickTrip),
    },
    now,
  );
}

export function pruneBaseline(baseline: FuseBaseline, now: number): FuseBaseline {
  const today = utcDay(now);
  return {
    ...baseline,
    launches: baseline.launches.filter((item) => item.state === "admitted" || item.admittedAt > now - HOUR_MS),
    trips: baseline.trips.filter(
      (item) => item.closedAt === undefined || utcDay(item.openedAt) >= today || item.closedAt >= now - HOUR_MS,
    ),
  };
}

/** Items from `file` come first, so `pick` gets the file copy first; a tie keeps the file copy. */
function mergeById<T>(file: T[], store: T[], idOf: (item: T) => string, pick: (file: T, store: T) => T): T[] {
  const merged = new Map<string, T>();
  for (const item of file) merged.set(idOf(item), item);
  for (const item of store) {
    const existing = merged.get(idOf(item));
    merged.set(idOf(item), existing === undefined ? item : pick(existing, item));
  }
  return [...merged.values()];
}

function pickLaunch(file: FuseLaunchRecord, store: FuseLaunchRecord): FuseLaunchRecord {
  return store.seq > file.seq ? store : file;
}

/**
 * A trip open in either copy stays open, except that an owner close is final: a trip never reopens, so the copy
 * that still has it open is the older one, and reopening it would hold every launch until the owner acted again.
 * Otherwise the higher seq wins, and a tie keeps the file copy.
 */
function pickTrip(file: FuseTripRecord, store: FuseTripRecord): FuseTripRecord {
  const fileOpen = file.closedAt === undefined;
  const storeOpen = store.closedAt === undefined;
  if (fileOpen !== storeOpen) {
    const closed = fileOpen ? store : file;
    return closed.closedBy === "owner" ? closed : fileOpen ? file : store;
  }
  return store.seq > file.seq ? store : file;
}
