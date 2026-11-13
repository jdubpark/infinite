import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FuseConfig } from "../config.js";
import type { EvidenceStore } from "../evidence/store.js";
import type { EvidenceModule, EvidenceTx } from "../evidence/types.js";
import type { Config } from "../types.js";
import { BASELINE_FILE, type FuseBaseline, mergeBaselines, pruneBaseline, readBaseline, writeBaseline } from "./baseline.js";
import { DEFAULT_LAUNCHES_PER_HOUR, EXEMPT_ROLES, HOUR_MS, fuseCheck, projectLimit, rollingCount, scopeState, utcDay } from "./rules.js";
import type {
  FuseAdmission,
  FuseCause,
  FuseCheck,
  FuseGate,
  FuseLaunch,
  FuseLaunchRecord,
  FuseLimits,
  FuseOpen,
  FuseScope,
  FuseTripRecord,
  FuseWindow,
  LaunchRole,
} from "./types.js";

export type FuseServiceOptions = {
  config: Config;
  key: Buffer;
  store: EvidenceStore;
  sessionExists(sessionId: string): boolean;
  now?: () => number;
};

export type FuseScopeView = {
  state: "open" | "closed";
  trip?: { tripId?: string; cause: FuseCause; window?: FuseWindow; openedAt?: string; ownerClose: boolean };
  hour: { launches: number; limit: number };
};

export type FuseView = {
  authoritative: boolean;
  host: FuseScopeView;
  projects: (FuseScopeView & { projectId: string })[];
};

export type FuseInterrupt = {
  tripId: string;
  scope: FuseScope;
  projectId?: string;
  label: string;
  cause: FuseCause;
  ownerClose: boolean;
  openedAt: string;
};

const MODULE = "fuse";
const TICK_MS = 60_000;
const LAUNCH_RETENTION_MS = 48 * HOUR_MS;
const TRIP_RETENTION_MS = 30 * 24 * HOUR_MS;

const TABLES = `
CREATE TABLE fuse_launches (
  launch_id   TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  role        TEXT NOT NULL,
  state       TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  sealed      TEXT NOT NULL
);
CREATE INDEX fuse_launches_by_admitted ON fuse_launches (admitted_at);
CREATE TABLE fuse_trips (
  trip_id      TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,
  project_key  TEXT,
  cause        TEXT NOT NULL,
  fuse_window  TEXT,
  opened_at    INTEGER NOT NULL,
  closed_at    INTEGER,
  closed_by    TEXT,
  owner_close  INTEGER NOT NULL,
  announced_at INTEGER,
  seq          INTEGER NOT NULL,
  sealed       TEXT NOT NULL
);
`;

const LAUNCH_UPSERT = "INSERT INTO fuse_launches (launch_id, project_key, purpose, role, state, admitted_at, seq, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
  + "ON CONFLICT(launch_id) DO UPDATE SET state=excluded.state, admitted_at=excluded.admitted_at, seq=excluded.seq, sealed=excluded.sealed";
const TRIP_UPSERT = "INSERT INTO fuse_trips (trip_id, scope, project_key, cause, fuse_window, opened_at, closed_at, closed_by, owner_close, announced_at, seq, sealed) "
  + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
  + "ON CONFLICT(trip_id) DO UPDATE SET closed_at=excluded.closed_at, closed_by=excluded.closed_by, announced_at=excluded.announced_at, seq=excluded.seq, sealed=excluded.sealed";

const FUSE_MODULE: EvidenceModule = {
  name: MODULE,
  version: 1,
  readVersion: 1,
  migrate(tx: EvidenceTx) {
    tx.exec(TABLES);
  },
  counts(db) {
    return {
      launches: db.get<{ n: number }>("SELECT count(*) AS n FROM fuse_launches")?.n ?? 0,
      trips: db.get<{ n: number }>("SELECT count(*) AS n FROM fuse_trips")?.n ?? 0,
      openTrips: db.get<{ n: number }>("SELECT count(*) AS n FROM fuse_trips WHERE closed_at IS NULL")?.n ?? 0,
    };
  },
};

type LaunchPayload = { projectId: string; profileId: string; assignment?: FuseLaunchRecord["assignment"] };
type TripPayload = { projectId?: string; launches?: number };

function limitsOf(fuse: FuseConfig | undefined): FuseLimits {
  const projects: Record<string, number> = {};
  for (const [id, ceiling] of Object.entries(fuse?.projects ?? {})) {
    if (ceiling.launchesPerHour !== undefined) projects[id] = ceiling.launchesPerHour;
  }
  return {
    project: fuse?.project?.launchesPerHour ?? DEFAULT_LAUNCHES_PER_HOUR.project,
    host: fuse?.host?.launchesPerHour ?? DEFAULT_LAUNCHES_PER_HOUR.host,
    projects,
  };
}

/** The subject a push is about: one per scope. A second trip for the same subject waits for the next UTC day. */
function subjectOf(trip: FuseTripRecord): string {
  return trip.scope === "host" ? "host" : `project:${trip.projectId ?? ""}`;
}

/**
 * The launch-rate fuse. Memory is the working copy. The sealed file is the authority: each change is written there
 * first, then memory, then the evidence store, whose mirror may fail. Without an authoritative baseline the fuse holds
 * one unmeasurable host trip in memory and writes nothing until `tick` loads one.
 */
export class FuseService implements FuseGate {
  private readonly key: Buffer;
  private readonly store: EvidenceStore;
  private readonly now: () => number;
  private readonly file: string;
  private readonly limits: FuseLimits;
  private readonly projectIds: string[];
  private readonly projectNames: Map<string, string>;
  private readonly sessionExistsOf: (sessionId: string) => boolean;
  private launches = new Map<string, FuseLaunchRecord>();
  private trips = new Map<string, FuseTripRecord>();
  private seq = 0;
  private authoritative = false;
  private unmeasurableId: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: FuseServiceOptions) {
    const config = options.config;
    this.key = options.key;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.file = join(config.stateDir, BASELINE_FILE);
    this.limits = limitsOf(config.autonomy?.fuse);
    this.projectIds = config.projects.map(project => project.id);
    this.projectNames = new Map(config.projects.map(project => [project.id, project.name]));
    this.sessionExistsOf = (sessionId) => {
      try {
        return options.sessionExists(sessionId);
      } catch {
        return true;
      }
    };
    this.store.register(FUSE_MODULE);
    if (!this.load()) this.holdUnmeasurable();
  }

  /** Reads memory only. An exempt role is never judged. */
  check(input: { projectId: string; role?: LaunchRole }): FuseCheck {
    if (input.role !== undefined && EXEMPT_ROLES.has(input.role)) return { state: "closed", exempt: true };
    return fuseCheck([...this.launches.values()], [...this.trips.values()], input.projectId, this.limits, this.now());
  }

  admit(launch: FuseLaunch): FuseAdmission {
    const { launchId, projectId } = launch;
    if (EXEMPT_ROLES.has(launch.role)) return { ok: true, launchId, exempt: true };
    const prior = this.launches.get(launchId);
    if (prior !== undefined && (prior.state === "admitted" || prior.state === "started")) return { ok: true, launchId, repeat: true };

    const now = this.now();
    const launches = [...this.launches.values()];
    const trips = [...this.trips.values()];
    const check = fuseCheck(launches, trips, projectId, this.limits, now);
    if (check.state === "open") {
      if (!this.authoritative || check.tripId !== undefined) return { ok: false, launchId, open: check };
      // A rate trip is judged but not yet recorded: record it now, so the owner can see and close it.
      const seq = this.seq + 1;
      const trip: FuseTripRecord = {
        tripId: randomUUID(),
        scope: check.scope,
        ...(check.projectId === undefined ? {} : { projectId: check.projectId }),
        cause: "launch-rate",
        window: "hour",
        openedAt: now,
        ownerClose: check.ownerClose,
        launches: rollingCount(launches, trips, check.scope, check.projectId, now),
        seq,
      };
      if (!this.persist(seq, [], [trip])) return { ok: false, launchId, failure: "write-failed" };
      return { ok: false, launchId, open: { ...check, tripId: trip.tripId } };
    }

    const seq = this.seq + 1;
    const record: FuseLaunchRecord = {
      launchId,
      projectId,
      purpose: launch.purpose,
      role: launch.role,
      profileId: launch.profileId,
      ...(launch.assignment === undefined ? {} : { assignment: launch.assignment }),
      state: "admitted",
      admittedAt: prior?.state === "released" ? prior.admittedAt : now,
      seq,
    };
    const counted = [...launches.filter(item => item.launchId !== launchId), record];
    const changed = this.settle(launches, counted, trips, projectId, now, seq);
    if (!this.persist(seq, [record], changed)) return { ok: false, launchId, failure: "write-failed" };
    return { ok: true, launchId };
  }

  release(launchId: string): void {
    this.transition(launchId, "released");
  }

  started(launchId: string): void {
    this.transition(launchId, "started");
  }

  close(input: { scope: "host" } | { scope: "project"; projectId: string }): "closed" | "not-open" | "unmeasurable" | "write-failed" {
    if (!this.authoritative) return "unmeasurable";
    const scope: FuseScope = input.scope;
    const projectId = input.scope === "project" ? input.projectId : undefined;
    const now = this.now();
    const seq = this.seq + 1;
    const closing = [...this.trips.values()]
      .filter(trip => trip.closedAt === undefined && trip.cause === "launch-rate" && trip.scope === scope && (scope === "host" || trip.projectId === projectId))
      .map((trip): FuseTripRecord => ({ ...trip, closedAt: now, closedBy: "owner", seq }));
    if (closing.length === 0) return "not-open";
    return this.persist(seq, [], closing) ? "closed" : "write-failed";
  }

  view(): FuseView {
    const now = this.now();
    const launches = [...this.launches.values()];
    const trips = [...this.trips.values()];
    return {
      authoritative: this.authoritative,
      host: this.scopeView(launches, trips, "host", undefined, this.limits.host, now),
      projects: this.projectIds.map(projectId => ({
        projectId,
        ...this.scopeView(launches, trips, "project", projectId, projectLimit(this.limits, projectId), now),
      })),
    };
  }

  /** Open trips not yet announced, one per subject per UTC day. */
  interrupts(): FuseInterrupt[] {
    const today = utcDay(this.now());
    const trips = [...this.trips.values()];
    const announced = new Set(trips.filter(trip => trip.announcedAt !== undefined && utcDay(trip.announcedAt) === today).map(subjectOf));
    return trips
      .filter(trip => trip.closedAt === undefined && trip.announcedAt === undefined && !announced.has(subjectOf(trip)))
      .map(trip => ({
        tripId: trip.tripId,
        scope: trip.scope,
        ...(trip.projectId === undefined ? {} : { projectId: trip.projectId }),
        label: trip.scope === "host" ? "the host" : (this.projectNames.get(trip.projectId ?? "") ?? trip.projectId ?? ""),
        cause: trip.cause,
        ownerClose: trip.ownerClose,
        openedAt: new Date(trip.openedAt).toISOString(),
      }));
  }

  markAnnounced(tripIds: readonly string[]): void {
    const now = this.now();
    const ids = new Set(tripIds);
    const targets = [...this.trips.values()].filter(trip => ids.has(trip.tripId) && trip.announcedAt === undefined);
    if (targets.length === 0) return;
    if (!this.authoritative) {
      // The unmeasurable trip is not in the file, so its announcement is kept in memory only.
      for (const trip of targets) this.trips.set(trip.tripId, { ...trip, announcedAt: now });
      return;
    }
    const seq = this.seq + 1;
    this.persist(seq, [], targets.map((trip): FuseTripRecord => ({ ...trip, announcedAt: now, seq })));
  }

  /** Retries the load while no baseline is authoritative, and prunes the store. True when authoritative. */
  tick(): boolean {
    if (!this.authoritative) this.load();
    this.prune();
    return this.authoritative;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private transition(launchId: string, to: "released" | "started"): void {
    if (!this.authoritative) return;
    const launch = this.launches.get(launchId);
    if (!launch || launch.state !== "admitted") return;
    const seq = this.seq + 1;
    this.persist(seq, [{ ...launch, state: to, seq }], []);
  }

  /**
   * One accepted admission. First, each open rate trip without ownerClose of a scope that the check judged closed
   * before the launch counts is closed. Then the launch counts. Then a new trip is recorded for each scope whose
   * count now reached its limit. Returns the trip records that changed.
   */
  private settle(before: FuseLaunchRecord[], counted: FuseLaunchRecord[], trips: FuseTripRecord[], projectId: string, now: number, seq: number): FuseTripRecord[] {
    const scopes: [FuseScope, string | undefined, number][] = [
      ["host", undefined, this.limits.host],
      ["project", projectId, projectLimit(this.limits, projectId)],
    ];
    const working = [...trips];
    const changed = new Map<string, FuseTripRecord>();
    for (const [scope, id, limit] of scopes) {
      if (scopeState(before, working, scope, id, limit, now).state !== "closed") continue;
      for (let index = 0; index < working.length; index++) {
        const trip = working[index]!;
        const sameScope = trip.scope === scope && (scope === "host" || trip.projectId === id);
        if (trip.closedAt !== undefined || !sameScope || trip.cause !== "launch-rate" || trip.ownerClose) continue;
        const closed: FuseTripRecord = { ...trip, closedAt: now, closedBy: "rate", seq };
        working[index] = closed;
        changed.set(closed.tripId, closed);
      }
    }
    for (const [scope, id, limit] of scopes) {
      const state = scopeState(counted, working, scope, id, limit, now);
      if (state.state !== "open" || state.tripId !== undefined) continue;
      const trip: FuseTripRecord = {
        tripId: randomUUID(),
        scope,
        ...(id === undefined ? {} : { projectId: id }),
        cause: "launch-rate",
        window: "hour",
        openedAt: now,
        ownerClose: state.ownerClose,
        launches: rollingCount(counted, working, scope, id, now),
        seq,
      };
      working.push(trip);
      changed.set(trip.tripId, trip);
    }
    return [...changed.values()];
  }

  /** Writes the file first, then memory, then mirrors the changed rows (a failed mirror is tolerated). */
  private persist(seq: number, launches: FuseLaunchRecord[], trips: FuseTripRecord[]): boolean {
    const launchMap = new Map(this.launches);
    for (const launch of launches) launchMap.set(launch.launchId, launch);
    const tripMap = new Map(this.trips);
    for (const trip of trips) tripMap.set(trip.tripId, trip);
    const next = pruneBaseline({ version: 1, seq, launches: [...launchMap.values()], trips: [...tripMap.values()] }, this.now());
    if (!writeBaseline(this.file, this.key, next)) return false;
    this.adopt(next);
    this.mirror(launches, trips);
    return true;
  }

  private adopt(baseline: FuseBaseline): void {
    this.seq = baseline.seq;
    this.launches = new Map(baseline.launches.map(launch => [launch.launchId, launch]));
    this.trips = new Map(baseline.trips.map(trip => [trip.tripId, trip]));
  }

  /**
   * Reads the file and the store, merges them, and settles admitted launches: a launch whose session exists is
   * started, and any other is released. Returns false when no baseline is authoritative; then nothing changes.
   */
  private load(): boolean {
    const now = this.now();
    const file = readBaseline(this.file, this.key);
    const merged = mergeBaselines(file, this.readStore(), now);
    if (merged === undefined) return false;

    const seq = merged.seq + 1;
    const settling = merged.launches.filter(launch => launch.state === "admitted");
    const settled = new Set(settling.map(launch => launch.launchId));
    const launches = merged.launches.map((launch): FuseLaunchRecord =>
      launch.state === "admitted" ? { ...launch, state: this.sessionExistsOf(launch.launchId) ? "started" : "released", seq } : launch,
    );
    const held = this.unmeasurableId === undefined ? undefined : this.trips.get(this.unmeasurableId);
    const closedHeld: FuseTripRecord[] = held === undefined ? [] : [{ ...held, closedAt: now, closedBy: "baseline", seq }];
    const changed = settling.length > 0 || closedHeld.length > 0;
    const next = pruneBaseline({
      version: 1,
      seq: changed ? seq : merged.seq,
      launches,
      trips: [...merged.trips, ...closedHeld],
    }, now);
    if (changed || file === undefined) writeBaseline(this.file, this.key, next);
    this.authoritative = true;
    this.unmeasurableId = undefined;
    this.adopt(next);
    this.mirror(launches.filter(launch => settled.has(launch.launchId)), closedHeld);
    return true;
  }

  private holdUnmeasurable(): void {
    const trip: FuseTripRecord = { tripId: randomUUID(), scope: "host", cause: "unmeasurable", openedAt: this.now(), ownerClose: false, seq: 0 };
    this.launches = new Map();
    this.trips = new Map([[trip.tripId, trip]]);
    this.seq = 0;
    this.authoritative = false;
    this.unmeasurableId = trip.tripId;
  }

  /** Reads the committed rows, or undefined when the store or its module is unavailable or unreadable. */
  private readStore(): FuseBaseline | undefined {
    const status = this.store.status();
    if (status.state !== "ready" || status.modules[MODULE] !== "ready") return undefined;
    try {
      return this.store.read((db): FuseBaseline => {
        const launches = db.all<{ launch_id: string; purpose: FuseLaunchRecord["purpose"]; role: LaunchRole; state: FuseLaunchRecord["state"]; admitted_at: number; seq: number; sealed: string }>(
          "SELECT launch_id, purpose, role, state, admitted_at, seq, sealed FROM fuse_launches ORDER BY launch_id",
        ).map((row): FuseLaunchRecord => {
          const payload = db.open<LaunchPayload>("fuse_launches", row.launch_id, row.sealed);
          return {
            launchId: row.launch_id,
            projectId: payload.projectId,
            purpose: row.purpose,
            role: row.role,
            profileId: payload.profileId,
            ...(payload.assignment === undefined ? {} : { assignment: payload.assignment }),
            state: row.state,
            admittedAt: row.admitted_at,
            seq: row.seq,
          };
        });
        const trips = db.all<{ trip_id: string; scope: FuseScope; cause: FuseCause; fuse_window: FuseWindow | null; opened_at: number; closed_at: number | null; closed_by: FuseTripRecord["closedBy"] | null; owner_close: number; announced_at: number | null; seq: number; sealed: string }>(
          "SELECT trip_id, scope, cause, fuse_window, opened_at, closed_at, closed_by, owner_close, announced_at, seq, sealed FROM fuse_trips ORDER BY trip_id",
        ).map((row): FuseTripRecord => {
          const payload = db.open<TripPayload>("fuse_trips", row.trip_id, row.sealed);
          return {
            tripId: row.trip_id,
            scope: row.scope,
            ...(payload.projectId === undefined ? {} : { projectId: payload.projectId }),
            cause: row.cause,
            ...(row.fuse_window === null ? {} : { window: row.fuse_window }),
            openedAt: row.opened_at,
            ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
            ...(row.closed_by === null ? {} : { closedBy: row.closed_by }),
            ownerClose: row.owner_close === 1,
            ...(row.announced_at === null ? {} : { announcedAt: row.announced_at }),
            ...(payload.launches === undefined ? {} : { launches: payload.launches }),
            seq: row.seq,
          };
        });
        const seq = Math.max(0, ...launches.map(launch => launch.seq), ...trips.map(trip => trip.seq));
        return { version: 1, seq, launches, trips };
      });
    } catch {
      return undefined;
    }
  }

  /** Mirrors changed rows. The file is the authority, so a failed mirror is tolerated. */
  private mirror(launches: FuseLaunchRecord[], trips: FuseTripRecord[]): void {
    if (launches.length === 0 && trips.length === 0) return;
    this.store.tryWrite(tx => {
      for (const launch of launches) {
        tx.run(
          LAUNCH_UPSERT,
          launch.launchId,
          tx.index("project", launch.projectId),
          launch.purpose,
          launch.role,
          launch.state,
          launch.admittedAt,
          launch.seq,
          tx.seal("fuse_launches", launch.launchId, {
            projectId: launch.projectId,
            profileId: launch.profileId,
            ...(launch.assignment === undefined ? {} : { assignment: launch.assignment }),
          } satisfies LaunchPayload),
        );
      }
      for (const trip of trips) {
        tx.run(
          TRIP_UPSERT,
          trip.tripId,
          trip.scope,
          trip.projectId === undefined ? null : tx.index("project", trip.projectId),
          trip.cause,
          trip.window ?? null,
          trip.openedAt,
          trip.closedAt ?? null,
          trip.closedBy ?? null,
          trip.ownerClose ? 1 : 0,
          trip.announcedAt ?? null,
          trip.seq,
          tx.seal("fuse_trips", trip.tripId, {
            ...(trip.projectId === undefined ? {} : { projectId: trip.projectId }),
            ...(trip.launches === undefined ? {} : { launches: trip.launches }),
          } satisfies TripPayload),
        );
      }
    });
  }

  private prune(): void {
    const now = this.now();
    this.store.tryWrite(tx => {
      tx.run("DELETE FROM fuse_launches WHERE admitted_at < ?", now - LAUNCH_RETENTION_MS);
      tx.run("DELETE FROM fuse_trips WHERE closed_at IS NOT NULL AND closed_at < ?", now - TRIP_RETENTION_MS);
    });
  }

  private scopeView(launches: FuseLaunchRecord[], trips: FuseTripRecord[], scope: FuseScope, projectId: string | undefined, limit: number, now: number): FuseScopeView {
    const hour = { launches: rollingCount(launches, trips, scope, projectId, now), limit };
    const state = scopeState(launches, trips, scope, projectId, limit, now);
    if (state.state === "closed") return { state: "closed", hour };
    const trip = state.tripId === undefined ? undefined : trips.find(item => item.tripId === state.tripId);
    return {
      state: "open",
      trip: {
        tripId: state.tripId,
        cause: state.cause,
        window: state.window,
        openedAt: trip === undefined ? undefined : new Date(trip.openedAt).toISOString(),
        ownerClose: state.ownerClose,
      },
      hour,
    };
  }
}
