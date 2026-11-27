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

export type FuseState = { state: "closed"; exempt?: true } | FuseOpen;
export type FuseCheck = FuseState | LaunchHalted;

export type FuseAdmission =
  | { ok: true; launchId: string; repeat?: true; exempt?: true }
  | { ok: false; launchId: string; open: FuseOpen }
  | { ok: false; launchId: string; failure: "write-failed" }
  | { ok: false; launchId: string; halted: LaunchHalted };

export type LaunchState = "admitted" | "started" | "released";

export type FuseLaunchRecord = FuseLaunch & { state: LaunchState; admittedAt: number; seq: number };

type FuseTripBase = {
  tripId: string;
  cause: FuseCause;
  window?: FuseWindow;
  openedAt: number;
  ownerClose: boolean;
  announcedAt?: number;
  launches?: number;
  seq: number;
};

type FuseTripScope =
  | { scope: "host"; projectId?: never }
  | { scope: "project"; projectId: string };

type FuseTripClosure =
  | { closedAt?: never; closedBy?: never }
  | { closedAt: number; closedBy: "rate" | "owner" | "baseline" };

export type FuseTripRecord = FuseTripBase & FuseTripScope & FuseTripClosure;

export type FuseLimits = { project: number; host: number; projects: Record<string, number> };

export interface FuseGate {
  check(input: { projectId: string; role?: LaunchRole }): FuseCheck;
  admit(launch: FuseLaunch): FuseAdmission;
  release(launchId: string): void;
  started(launchId: string): void;
  held?(projectIds: readonly string[]): LaunchHalted | undefined;
  refund?(launchId: string): void;
}
