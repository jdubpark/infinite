import type { TeamAssignment, TeamModelProfile } from "../team-types.js";
import type {
  FuseAdmission,
  FuseCheck,
  FuseLaunch,
  FuseLaunchRecord,
  FuseLimits,
  FuseOpen,
  FuseScope,
  FuseTripRecord,
  LaunchRole,
} from "./types.js";

export const HOUR_MS = 3_600_000;
export const DEFAULT_LAUNCHES_PER_HOUR = { project: 30, host: 80 } as const;
export const EXEMPT_ROLES: ReadonlySet<LaunchRole> = new Set<LaunchRole>(["permission-coordinator"]);

const FUSE_PREFIX = "Waiting for the spend fuse:";

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function projectLimit(limits: FuseLimits, projectId: string): number {
  return Object.hasOwn(limits.projects, projectId) ? limits.projects[projectId] : limits.project;
}

/** Launches admitted in the last hour, after the scope's latest owner close. */
export function rollingCount(
  launches: readonly FuseLaunchRecord[],
  trips: readonly FuseTripRecord[],
  scope: FuseScope,
  projectId: string | undefined,
  now: number,
): number {
  let cutoff = Number.NEGATIVE_INFINITY;
  for (const trip of trips) {
    if (trip.closedBy === "owner" && trip.closedAt !== undefined && trip.scope === scope && (scope === "host" || trip.projectId === projectId)) {
      cutoff = Math.max(cutoff, trip.closedAt);
    }
  }
  const windowStart = now - HOUR_MS;
  return launches.filter(
    (launch) => (scope === "host" || launch.projectId === projectId) && launch.admittedAt > windowStart && launch.admittedAt > cutoff,
  ).length;
}

function openResult(trip: FuseTripRecord): FuseOpen {
  const result: FuseOpen = {
    state: "open",
    scope: trip.scope,
    cause: trip.cause,
    tripId: trip.tripId,
    ownerClose: trip.ownerClose,
  };
  if (trip.window !== undefined) result.window = trip.window;
  if (trip.projectId !== undefined) result.projectId = trip.projectId;
  return result;
}

/**
 * Judges one scope only: its own trips against its own count and limit. Within the
 * scope an open unmeasurable trip wins over a rate trip. A recorded open rate trip
 * stays open while 2 * count >= limit, or while it carries ownerClose.
 */
export function scopeState(
  launches: readonly FuseLaunchRecord[],
  trips: readonly FuseTripRecord[],
  scope: FuseScope,
  projectId: string | undefined,
  limit: number,
  now: number,
): FuseCheck {
  const open = trips.filter(
    (trip) => trip.closedAt === undefined && (scope === "host" ? trip.scope === "host" : trip.scope === "project" && trip.projectId === projectId),
  );
  // Two open rate trips can share a scope after a baseline merge. The one that needs the owner decides.
  const winner = open.find((trip) => trip.cause === "unmeasurable") ?? open.find((trip) => trip.ownerClose) ?? open[0];

  if (winner) {
    if (winner.cause === "unmeasurable" || winner.ownerClose) return openResult(winner);
    const count = rollingCount(launches, trips, scope, projectId, now);
    return 2 * count >= limit ? openResult(winner) : { state: "closed" };
  }

  const count = rollingCount(launches, trips, scope, projectId, now);
  if (count < limit) return { state: "closed" };
  const sameDay = trips.some(
    (trip) =>
      trip.scope === scope &&
      trip.cause === "launch-rate" &&
      trip.projectId === (scope === "host" ? undefined : projectId) &&
      utcDay(trip.openedAt) === utcDay(now),
  );
  const pending: FuseOpen = { state: "open", scope, window: "hour", cause: "launch-rate", ownerClose: sameDay };
  if (scope === "project") pending.projectId = projectId;
  return pending;
}

/** The host decides first with `limits.host`; the project is judged only when the host is closed. */
export function fuseCheck(
  launches: readonly FuseLaunchRecord[],
  trips: readonly FuseTripRecord[],
  projectId: string,
  limits: FuseLimits,
  now: number,
): FuseCheck {
  const host = scopeState(launches, trips, "host", undefined, limits.host, now);
  if (host.state === "open") return host;
  return scopeState(launches, trips, "project", projectId, projectLimit(limits, projectId), now);
}

export function workLaunch(input: {
  launchId: string;
  projectId: string;
  provider: string;
  team: TeamAssignment;
  profile?: Pick<TeamModelProfile, "id">;
}): FuseLaunch {
  return {
    launchId: input.launchId,
    projectId: input.projectId,
    purpose: "work",
    role: input.team.role,
    profileId: input.profile?.id ?? input.provider,
    assignment: { runId: input.team.runId, memberId: input.team.memberId, revision: input.team.revision },
  };
}

export function fuseReason(result: FuseOpen | "write-failed"): string {
  if (result === "write-failed") return `${FUSE_PREFIX} the host could not record the launch.`;
  let text: string;
  if (result.cause === "unmeasurable") {
    text = `${FUSE_PREFIX} the host cannot read its fuse baseline.`;
  } else if (result.scope === "project") {
    text = `${FUSE_PREFIX} this project reached its hourly launch limit.`;
  } else {
    text = `${FUSE_PREFIX} the host reached its hourly launch limit.`;
  }
  return result.ownerClose && result.cause === "launch-rate" ? `${text} It stays open until the owner closes it.` : text;
}

export function isFuseReason(text: string | undefined): boolean {
  return text !== undefined && text.startsWith(FUSE_PREFIX);
}

/**
 * Sets or clears only a fuse reason on the holder. `changed` is true only when the value changed.
 * A closed check clears a fuse reason, except the write failure, which only `admit` can judge: an accepted
 * admission clears that one. So a failing baseline write gives one steady reason, not one that flips each pass.
 */
export function applyFuseReason(
  holder: { reason?: string },
  result: FuseCheck | FuseAdmission | undefined,
): { wait: boolean; changed: boolean } {
  if (result === undefined) return { wait: false, changed: false };
  if ("exempt" in result && result.exempt === true) return { wait: false, changed: false };

  const before = holder.reason;
  let wait: boolean;
  if ("state" in result) {
    if (result.state === "open") {
      holder.reason = fuseReason(result);
      wait = true;
    } else {
      if (isFuseReason(holder.reason) && holder.reason !== fuseReason("write-failed")) holder.reason = undefined;
      wait = false;
    }
  } else if (!result.ok) {
    holder.reason = fuseReason("open" in result ? result.open : "write-failed");
    wait = true;
  } else {
    if (isFuseReason(holder.reason)) holder.reason = undefined;
    wait = false;
  }
  return { wait, changed: holder.reason !== before };
}
