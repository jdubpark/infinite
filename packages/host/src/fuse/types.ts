import type { TeamAssignment } from "../team-types.js";
import type { LaunchHalted } from "../halt/rules.js";

export type FuseScope = "project" | "host";
export type FuseWindow = "hour" | "day" | "week";
export type FuseCause = "launch-rate" | "unmeasurable";
export type SessionPurpose = "work" | "duel" | "replay" | "gate";
export type LaunchRole = TeamAssignment["role"];

export type FuseLaunch = {
  launchId: string;
  projectId: string;
  purpose: SessionPurpose;
  role: LaunchRole;
  profileId: string;
  assignment?: Pick<TeamAssignment, "runId" | "memberId" | "revision">;
};

export type FuseOpen = {
  state: "open";
  scope: FuseScope;
  projectId?: string;
  window?: FuseWindow;
  cause: FuseCause;
  tripId?: string;
  ownerClose: boolean;
};

/** The fuse's own judgement of a scope. */
export type FuseState = { state: "closed"; exempt?: true } | FuseOpen;
/** What a gate answers. `halted` comes only from the owner's halt, which the host puts in front of the fuse. */
export type FuseCheck = FuseState | LaunchHalted;

export type FuseAdmission =
  | { ok: true; launchId: string; repeat?: true; exempt?: true }
  | { ok: false; launchId: string; open: FuseOpen }
  | { ok: false; launchId: string; failure: "write-failed" }
  | { ok: false; launchId: string; halted: LaunchHalted };

export type LaunchState = "admitted" | "started" | "released";

export type FuseLaunchRecord = FuseLaunch & { state: LaunchState; admittedAt: number; seq: number };

export type FuseTripRecord = {
  tripId: string;
  scope: FuseScope;
  projectId?: string;
  cause: FuseCause;
  window?: FuseWindow;
  openedAt: number;
  closedAt?: number;
  closedBy?: "rate" | "owner" | "baseline";
  ownerClose: boolean;
  announcedAt?: number;
  launches?: number;
  seq: number;
};

/** Launches per rolling hour. */
export type FuseLimits = { project: number; host: number; projects: Record<string, number> };

export interface FuseGate {
  check(input: { projectId: string; role?: LaunchRole }): FuseCheck;
  admit(launch: FuseLaunch): FuseAdmission;
  release(launchId: string): void;
  started(launchId: string): void;
  /** The owner's halt over any of these projects, for work that spans several. Only the halt's gate has it. */
  held?(projectIds: readonly string[]): LaunchHalted | undefined;
}
