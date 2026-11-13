import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../packages/host/src/config.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { BASELINE_FILE, BASELINE_SCOPE, readBaseline, writeBaseline } from "../packages/host/src/fuse/baseline.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import type { FuseAdmission, FuseCheck, FuseLaunch, FuseOpen, FuseTripRecord } from "../packages/host/src/fuse/types.js";
import type { Config } from "../packages/host/src/types.js";
import { writeSealed } from "../packages/host/src/vault.js";

const START = Date.parse("2026-11-13T10:00:00.000Z");
const HOUR = 3_600_000;

type Rig = {
  root: string;
  config: Config;
  key: Buffer;
  file: string;
  clock: { now: number };
  live: Set<string>;
  store: EvidenceStore;
  stores: EvidenceStore[];
  close(): void;
};

function hostConfig(root: string, fuse?: unknown) {
  return {
    port: 4780,
    origin: "http://127.0.0.1:4780",
    stateDir: join(root, "state"),
    runDir: join(root, "run"),
    keyFile: join(root, "key"),
    environment: "local",
    tokens: [{ id: "owner", label: "Owner", role: "owner", hash: "a".repeat(64) }],
    projects: [
      { id: "p", name: "Project P", path: join(root, "project-p") },
      { id: "q", name: "Project Q", path: join(root, "project-q") },
    ],
    ...(fuse === undefined ? {} : { autonomy: { fuse } }),
  };
}

/** Writes a host configuration with the given fuse block and reads it through the real parser. */
function parseConfig(root: string, fuse?: unknown): { config: Config; key: Buffer } {
  mkdirSync(join(root, "project-p"), { recursive: true });
  mkdirSync(join(root, "project-q"), { recursive: true });
  writeFileSync(join(root, "key"), randomBytes(32), { mode: 0o600 });
  const file = join(root, "config.json");
  writeFileSync(file, JSON.stringify(hostConfig(root, fuse)));
  return readConfig(file);
}

function openStore(r: { stores: EvidenceStore[]; config: Config }, key: Buffer): EvidenceStore {
  mkdirSync(r.config.stateDir, { recursive: true });
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(r.config.stateDir), vaultKey: key });
  r.stores.push(store);
  return store;
}

function rig(fuse?: unknown): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fuse-service-")));
  const { config, key } = parseConfig(root, fuse);
  const r = {
    root,
    config,
    key,
    file: join(config.stateDir, BASELINE_FILE),
    clock: { now: START },
    live: new Set<string>(),
    stores: [] as EvidenceStore[],
    store: undefined as unknown as EvidenceStore,
    close() {
      for (const store of r.stores) {
        try { store.close(); } catch { /* already closed by a restart */ }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  r.store = openStore(r, key);
  return r;
}

/** A service on the rig's current store. Each store takes one service, as a host has one. */
function service(r: Rig): FuseService {
  return new FuseService({ config: r.config, key: r.key, store: r.store, sessionExists: id => r.live.has(id), now: () => r.clock.now });
}

/** A restarted host: a new store object on the same path, then a new service. */
function restart(r: Rig): FuseService {
  r.store.close();
  r.store = openStore(r, r.key);
  return service(r);
}

/** A store that cannot read the rows: the database exists, but the key that opens it is wrong. */
function unreadable(r: Rig): FuseService {
  r.store.close();
  r.store = openStore(r, randomBytes(32));
  return service(r);
}

function launch(id: string, projectId = "p", role: FuseLaunch["role"] = "implementer"): FuseLaunch {
  return { launchId: id, projectId, purpose: "work", role, profileId: "claude-haiku" };
}

function assertOpen(result: FuseCheck): asserts result is FuseOpen {
  assert.equal(result.state, "open");
}

function refusal(result: FuseAdmission): FuseOpen {
  assert.equal(result.ok, false);
  if (result.ok || !("open" in result)) assert.fail("expected a refusal with an open trip");
  return result.open;
}

function baselineOf(r: Rig) {
  const baseline = readBaseline(r.file, r.key);
  assert.ok(baseline, "the baseline file is readable");
  return baseline;
}

test("check writes nothing and admit charges a launch once", () => {
  const r = rig();
  try {
    const fuse = service(r);
    const before = readFileSync(r.file);
    for (let i = 0; i < 10; i++) fuse.check({ projectId: "p" });
    assert.deepEqual(readFileSync(r.file), before);

    const seq = baselineOf(r).seq;
    assert.deepEqual(fuse.admit(launch("A")), { ok: true, launchId: "A" });
    assert.equal(baselineOf(r).seq, seq + 1);

    const bytes = readFileSync(r.file);
    assert.deepEqual(fuse.admit(launch("A")), { ok: true, launchId: "A", repeat: true });
    assert.deepEqual(readFileSync(r.file), bytes);

    assert.equal(fuse.view().projects.find(p => p.projectId === "p")?.hour.launches, 1);
    assert.equal(fuse.view().host.hour.launches, 1);
  } finally {
    r.close();
  }
});

test("the 31st launch in an hour waits", () => {
  const r = rig();
  try {
    const fuse = service(r);
    for (let i = 0; i < 30; i++) {
      r.clock.now = START + i * 10_000;
      assert.equal(fuse.admit(launch(`a${i}`)).ok, true);
    }
    const tripA = fuse.check({ projectId: "p" });
    assertOpen(tripA);
    assert.equal(tripA.cause, "launch-rate");
    assert.equal(tripA.ownerClose, false);
    assert.ok(tripA.tripId);

    const refused = refusal(fuse.admit(launch("a30")));
    assert.equal(refused.tripId, tripA.tripId);
    assert.equal(fuse.check({ projectId: "q" }).state, "closed");

    assert.equal(fuse.interrupts().length, 1);
    fuse.markAnnounced(fuse.interrupts().map(item => item.tripId));
    assert.equal(fuse.interrupts().length, 0);

    // 14 launches remain in the rolling window: the check closes.
    r.clock.now = START + 3_750_000;
    assert.equal(fuse.check({ projectId: "p" }).state, "closed");
    assert.equal(fuse.admit(launch("late")).ok, true);
    assert.equal(baselineOf(r).trips.find(t => t.tripId === tripA.tripId)?.closedBy, "rate");

    // Reaching 30 again in the same UTC day opens a trip that needs the owner.
    for (let i = 0; i < 15; i++) assert.equal(fuse.admit(launch(`b${i}`)).ok, true);
    const tripB = fuse.check({ projectId: "p" });
    assertOpen(tripB);
    assert.equal(tripB.ownerClose, true);
    r.clock.now += 2 * HOUR;
    assert.equal(fuse.check({ projectId: "p" }).state, "open");

    assert.equal(fuse.close({ scope: "project", projectId: "p" }), "closed");
    assert.equal(fuse.admit(launch("after-close")).ok, true);
  } finally {
    r.close();
  }
});

test("an admission closes every open rate trip that its scope no longer holds", () => {
  const r = rig();
  try {
    const trip = (tripId: string, projectId: string, ownerClose: boolean): FuseTripRecord =>
      ({ tripId, scope: "project", projectId, cause: "launch-rate", window: "hour", openedAt: START - 60_000, ownerClose, seq: 1 });
    writeBaseline(r.file, r.key, {
      version: 1,
      seq: 1,
      launches: [],
      trips: [trip("p1", "p", false), trip("p2", "p", false), trip("q1", "q", true)],
    });
    const fuse = service(r);
    assert.equal(fuse.admit(launch("A")).ok, true);
    const trips = baselineOf(r).trips;
    assert.equal(trips.find(t => t.tripId === "p1")?.closedBy, "rate");
    assert.equal(trips.find(t => t.tripId === "p2")?.closedBy, "rate");
    assert.equal(fuse.check({ projectId: "q" }).state, "open");
  } finally {
    r.close();
  }
});

test("a trip that needs the owner always sends its push", () => {
  const r = rig({ project: { launchesPerHour: 2 } });
  try {
    const fuse = service(r);
    fuse.admit(launch("a1"));
    fuse.admit(launch("a2"));
    const [first] = fuse.interrupts();
    assert.ok(first, "the first trip is offered");
    assert.equal(first.ownerClose, false);
    fuse.markAnnounced([first.tripId]);
    assert.equal(fuse.interrupts().length, 0);

    // The first trip closes by rate, and the limit is reached again on the same UTC day.
    r.clock.now += HOUR + 1;
    fuse.admit(launch("b1"));
    fuse.admit(launch("b2"));
    const open = fuse.check({ projectId: "p" });
    assertOpen(open);
    assert.equal(open.ownerClose, true);
    // Every launch of the project now waits for the owner, so the owner is told at once and not a day later.
    const second = fuse.interrupts();
    assert.equal(second.length, 1);
    assert.equal(second[0]!.ownerClose, true);
    assert.equal(second[0]!.tripId, open.tripId);
  } finally { r.close(); }
});

test("an owner close clears launches stamped after it", () => {
  const r = rig({ project: { launchesPerHour: 3 } });
  try {
    const fuse = service(r);
    for (const id of ["a1", "a2", "a3"]) fuse.admit(launch(id));
    assertOpen(fuse.check({ projectId: "p" }));
    // The clock steps back, so every counted launch now lies after the time of the owner's close.
    r.clock.now -= 90 * 60_000;
    assert.equal(fuse.close({ scope: "project", projectId: "p" }), "closed");
    assert.equal(fuse.check({ projectId: "p" }).state, "closed");
    // A launch after the close counts again, as the first of a fresh count.
    r.clock.now += 1000;
    assert.deepEqual(fuse.admit(launch("after")), { ok: true, launchId: "after" });
    assert.equal(fuse.view().projects.find(project => project.projectId === "p")!.hour.launches, 1);
    assert.equal(fuse.check({ projectId: "p" }).state, "closed", "the close cleared the count, and no new trip opened");
  } finally { r.close(); }
});

test("a failed write is visible and sends one interrupt", () => {
  const r = rig();
  try {
    const fuse = service(r);
    assert.equal(fuse.view().writeFailedAt, undefined);
    rmSync(r.file, { force: true });
    mkdirSync(r.file);
    const refused = fuse.admit(launch("A"));
    assert.equal(refused.ok, false);
    assert.equal("failure" in refused && refused.failure, "write-failed");
    assert.equal(fuse.view().writeFailedAt, new Date(r.clock.now).toISOString());
    const interrupts = fuse.interrupts();
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0]!.cause, "write-failed");
    assert.equal(interrupts[0]!.scope, "host");
    fuse.markAnnounced([interrupts[0]!.tripId]);
    assert.equal(fuse.interrupts().length, 0, "one interrupt per UTC day while writes fail");

    rmSync(r.file, { recursive: true, force: true });
    assert.deepEqual(fuse.admit(launch("A")), { ok: true, launchId: "A" });
    assert.equal(fuse.view().writeFailedAt, undefined, "a successful write clears it");
  } finally { r.close(); }
});

test("the owner can close a scope that is open without a recorded trip", () => {
  const r = rig({ project: { launchesPerHour: 5 } });
  try {
    const fuse = service(r);
    for (const id of ["a1", "a2", "a3", "a4"]) assert.equal(fuse.admit(launch(id)).ok, true);
    // The limit is lowered below the count and the host restarts. The scope is open, and no trip was recorded,
    // because every caller stops at the check.
    r.store.close();
    r.store = openStore(r, r.key);
    const lowered = { ...r.config, autonomy: { fuse: { project: { launchesPerHour: 2 } } } } as Config;
    const again = new FuseService({ config: lowered, key: r.key, store: r.store, sessionExists: id => r.live.has(id), now: () => r.clock.now });
    const open = again.check({ projectId: "p" });
    assertOpen(open);
    assert.equal(open.tripId, undefined);
    assert.equal(again.close({ scope: "project", projectId: "p" }), "closed");
    assert.equal(again.check({ projectId: "p" }).state, "closed");
    assert.equal(again.close({ scope: "project", projectId: "p" }), "not-open");
    // The close is on record: the next trip that day needs the owner.
    r.clock.now += 1000;
    again.admit(launch("b1"));
    again.admit(launch("b2"));
    const next = again.check({ projectId: "p" });
    assertOpen(next);
    assert.equal(next.ownerClose, true);
  } finally { r.close(); }
});

test("a failed write does not repeat a trip's push", () => {
  const r = rig({ project: { launchesPerHour: 2 } });
  try {
    const fuse = service(r);
    fuse.admit(launch("a1"));
    fuse.admit(launch("a2"));
    const [trip] = fuse.interrupts();
    assert.ok(trip, "the trip waits to be announced");
    // Writes fail from here on, as on a full disk.
    rmSync(r.file, { force: true });
    mkdirSync(r.file);
    fuse.markAnnounced([trip.tripId]);
    // The announcement could not be written. It is kept in memory, so the notifier does not send the trip again
    // on every tick.
    assert.equal(fuse.interrupts().some(item => item.tripId === trip.tripId), false);
    const failed = fuse.interrupts();
    assert.deepEqual(failed.map(item => item.cause), ["write-failed"]);
    fuse.markAnnounced(failed.map(item => item.tripId));
    assert.equal(fuse.interrupts().length, 0);
  } finally { r.close(); }
});

test("a write failure clears when the host can write again", () => {
  const r = rig();
  try {
    const fuse = service(r);
    rmSync(r.file, { force: true });
    mkdirSync(r.file);
    assert.equal(fuse.admit(launch("A")).ok, false);
    assert.notEqual(fuse.view().writeFailedAt, undefined);
    assert.equal(fuse.tick(), true);
    assert.notEqual(fuse.view().writeFailedAt, undefined, "the write still fails");
    // The path works again. No launch arrives, and the next tick writes the baseline and clears the report.
    rmSync(r.file, { recursive: true, force: true });
    assert.equal(fuse.tick(), true);
    assert.equal(fuse.view().writeFailedAt, undefined);
    assert.ok(readBaseline(r.file, r.key), "the baseline file is back");
    assert.equal(fuse.interrupts().length, 0);
  } finally { r.close(); }
});

test("a restart heals a store row that a failed mirror left open", () => {
  const r = rig({ project: { launchesPerHour: 2 } });
  try {
    const fuse = service(r);
    fuse.admit(launch("a1"));
    fuse.admit(launch("a2"));
    const open = fuse.check({ projectId: "p" });
    assertOpen(open);
    r.store.close();
    assert.equal(fuse.close({ scope: "project", projectId: "p" }), "closed");
    // The file holds the close, and the store row is still open. A restart writes the close to the store.
    restart(r);
    const row = r.store.read(db => db.get<{ closed_at: number | null; closed_by: string | null }>("SELECT closed_at, closed_by FROM fuse_trips WHERE trip_id=?", open.tripId!));
    assert.equal(row?.closed_by, "owner");
    assert.notEqual(row?.closed_at, null);
  } finally { r.close(); }
});

test("a restart does not bring back a trip the file dropped", () => {
  const r = rig({ project: { launchesPerHour: 2 } });
  try {
    const fuse = service(r);
    fuse.admit(launch("a1"));
    fuse.admit(launch("a2"));
    r.clock.now += HOUR + 1;
    fuse.admit(launch("b1"));
    fuse.admit(launch("b2"));
    const open = fuse.check({ projectId: "p" });
    assertOpen(open);
    assert.equal(open.ownerClose, true);

    // The owner closes the trip while store writes fail: the file holds the close, and the store row stays open.
    r.store.close();
    assert.equal(fuse.close({ scope: "project", projectId: "p" }), "closed");
    // The next day a write prunes the closed trip from the file.
    r.clock.now += 25 * HOUR;
    assert.equal(fuse.admit(launch("c1")).ok, true);
    assert.equal(baselineOf(r).trips.some(trip => trip.tripId === open.tripId), false, "the file dropped the closed trip");

    const again = restart(r);
    assert.equal(again.check({ projectId: "p" }).state, "closed", "the store's stale open row does not come back");
    assert.equal(again.interrupts().length, 0);
  } finally { r.close(); }
});

test("a project added while the host runs is in the view", () => {
  const r = rig();
  try {
    const fuse = service(r);
    assert.equal(fuse.view().projects.some(project => project.projectId === "late"), false);
    r.config.projects.push({ id: "late", name: "Late project", path: join(r.root, "project-late") } as Config["projects"][number]);
    const late = fuse.view().projects.find(project => project.projectId === "late");
    assert.ok(late, "the view reads the project list when asked");
    assert.equal(late.hour.limit, 30);
    assert.equal(late.state, "closed");
  } finally { r.close(); }
});

test("the host limit spans projects", () => {
  const r = rig({ project: { launchesPerHour: 50 } });
  try {
    const fuse = service(r);
    for (const [projectId, count] of [["a", 27], ["b", 27], ["c", 26]] as const) {
      for (let i = 0; i < count; i++) assert.equal(fuse.admit(launch(`${projectId}${i}`, projectId)).ok, true);
    }
    const host = fuse.check({ projectId: "d" });
    assertOpen(host);
    assert.equal(host.scope, "host");
  } finally {
    r.close();
  }
});

test("the permission coordinator is exempt", () => {
  const r = rig();
  try {
    const fuse = service(r);
    for (let i = 0; i < 30; i++) fuse.admit(launch(`p${i}`));
    assert.equal(fuse.check({ projectId: "p" }).state, "open");
    const exempt = fuse.check({ projectId: "p", role: "permission-coordinator" });
    assert.deepEqual(exempt, { state: "closed", exempt: true });

    const bytes = readFileSync(r.file);
    const counts = fuse.view().projects.find(p => p.projectId === "p")?.hour.launches;
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(fuse.admit(launch(`x${i}`, "p", "permission-coordinator")), { ok: true, launchId: `x${i}`, exempt: true });
    }
    assert.deepEqual(readFileSync(r.file), bytes);
    assert.equal(fuse.view().projects.find(p => p.projectId === "p")?.hour.launches, counts);
  } finally {
    r.close();
  }

  const unmeasurable = rig();
  try {
    const fuse = unreadable(unmeasurable);
    assert.equal(fuse.check({ projectId: "p" }).state, "open");
    assert.deepEqual(fuse.check({ projectId: "p", role: "permission-coordinator" }), { state: "closed", exempt: true });
    for (let i = 0; i < 50; i++) assert.equal(fuse.admit(launch(`x${i}`, "p", "permission-coordinator")).ok, true);
    assert.equal(existsSync(unmeasurable.file), false);
  } finally {
    unmeasurable.close();
  }
});

test("a launch that never starts is released and keeps its count", () => {
  const r = rig();
  try {
    const fuse = service(r);
    assert.equal(fuse.admit(launch("A")).ok, true);
    fuse.release("A");
    assert.equal(baselineOf(r).launches.find(l => l.launchId === "A")?.state, "released");
    assert.equal(fuse.view().host.hour.launches, 1);

    assert.deepEqual(fuse.admit(launch("A")), { ok: true, launchId: "A" });
    assert.equal(fuse.view().host.hour.launches, 1);

    assert.equal(fuse.admit(launch("B")).ok, true);
    fuse.started("B");
    const bytes = readFileSync(r.file);
    fuse.release("B");
    fuse.release("nobody");
    assert.deepEqual(readFileSync(r.file), bytes);

    for (let i = 0; i < 28; i++) fuse.admit(launch(`fill${i}`));
    assert.equal(fuse.check({ projectId: "p" }).state, "open");
    fuse.release("A");
    refusal(fuse.admit(launch("A")));
  } finally {
    r.close();
  }
});

test("a failed baseline write refuses and changes nothing", () => {
  const r = rig();
  try {
    const fuse = service(r);
    const before = fuse.view();
    rmSync(r.file);
    mkdirSync(r.file);
    assert.deepEqual(fuse.admit(launch("A")), { ok: false, launchId: "A", failure: "write-failed" });
    // Counts, limits, and states are as before. The view only adds that a write failed.
    const { writeFailedAt, ...after } = fuse.view();
    assert.deepEqual(after, before);
    assert.equal(writeFailedAt, new Date(r.clock.now).toISOString());
    assert.equal(fuse.check({ projectId: "p" }).state, "closed");
  } finally {
    r.close();
  }
});

test("a restart merges the file and the store", () => {
  const r = rig();
  try {
    const first = service(r);
    first.admit(launch("A"));
    first.admit(launch("B"));

    const second = restart(r);
    assert.equal(second.view().host.hour.launches, 2);

    rmSync(r.file);
    const third = restart(r);
    assert.equal(third.view().host.hour.launches, 2);

    writeSealed(r.file, randomBytes(32), BASELINE_SCOPE, { version: 1, seq: 99, launches: [], trips: [] });
    const fourth = restart(r);
    assert.equal(fourth.view().host.hour.launches, 2);
    assert.equal(fourth.admit(launch("C")).ok, true);
    assert.ok(readBaseline(r.file, r.key), "the next admit leaves a readable file");
  } finally {
    r.close();
  }
});

test("a cold start releases launches that never started", () => {
  const r = rig();
  try {
    const first = service(r);
    first.admit(launch("A"));
    first.admit(launch("B"));
    r.live.add("A");

    const second = restart(r);
    assert.equal(baselineOf(r).launches.find(l => l.launchId === "A")?.state, "started");
    assert.equal(baselineOf(r).launches.find(l => l.launchId === "B")?.state, "released");
    assert.equal(second.view().host.hour.launches, 2);
  } finally {
    r.close();
  }
});

test("no authoritative baseline opens the fuse as unmeasurable", () => {
  const r = rig();
  try {
    const fuse = unreadable(r);
    const check = fuse.check({ projectId: "p" });
    assertOpen(check);
    assert.equal(check.scope, "host");
    assert.equal(check.cause, "unmeasurable");
    assert.equal(fuse.admit(launch("A")).ok, false);
    assert.equal(fuse.interrupts().length, 1);
    assert.equal(existsSync(r.file), false);
    assert.equal(fuse.close({ scope: "host" }), "unmeasurable");
    assert.equal(existsSync(r.file), false);

    writeBaseline(r.file, r.key, { version: 1, seq: 0, launches: [], trips: [] });
    assert.equal(fuse.tick(), true);
    assert.equal(fuse.check({ projectId: "p" }).state, "closed");
    assert.equal(baselineOf(r).trips.find(t => t.cause === "unmeasurable")?.closedBy, "baseline");

    for (let i = 0; i < 30; i++) assert.equal(fuse.admit(launch(`u${i}`)).ok, true);
    refusal(fuse.admit(launch("u30")));
  } finally {
    r.close();
  }
});

test("the configuration sets the limits and adds no key", () => {
  const plain = rig();
  try {
    assert.equal(Object.hasOwn(plain.config, "autonomy"), false);
    const view = service(plain).view();
    assert.equal(view.host.hour.limit, 80);
    assert.equal(view.projects.find(p => p.projectId === "p")?.hour.limit, 30);
  } finally {
    plain.close();
  }

  const tuned = rig({ projects: { p: { launchesPerHour: 5 } } });
  try {
    const view = service(tuned).view();
    assert.equal(view.projects.find(p => p.projectId === "p")?.hour.limit, 5);
    assert.equal(view.projects.find(p => p.projectId === "q")?.hour.limit, 30);
  } finally {
    tuned.close();
  }

  for (const fuse of [
    { project: { launchesPerHour: 0 } },
    { project: { launchesPerHour: 1001 } },
    { project: { launchesPerHour: 5, bogus: 1 } },
    { projects: { nobody: { launchesPerHour: 5 } } },
  ]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "fuse-config-")));
    try {
      assert.throws(() => parseConfig(root, fuse));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the module counts and prunes its rows", () => {
  const r = rig({ project: { launchesPerHour: 2 } });
  try {
    const fuse = service(r);
    fuse.admit(launch("A"));
    fuse.admit(launch("B"));
    const counts = r.store.describe().counts;
    assert.equal(counts["fuse.launches"], 2);
    assert.equal(counts["fuse.trips"], 1);

    r.clock.now = START + 49 * HOUR;
    fuse.tick();
    assert.equal(r.store.describe().counts["fuse.launches"], 0);
  } finally {
    r.close();
  }
});
