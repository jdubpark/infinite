import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASELINE_FILE,
  BASELINE_SCOPE,
  mergeBaselines,
  pruneBaseline,
  readBaseline,
  writeBaseline,
  type FuseBaseline,
} from "../packages/host/src/fuse/baseline.js";
import { seal, writeSealed } from "../packages/host/src/vault.js";
import type { FuseLaunchRecord, FuseTripRecord, LaunchState } from "../packages/host/src/fuse/types.js";

const now = Date.parse("2026-11-13T10:00:00.000Z");
const minute = 60_000;

function launch(launchId: string, projectId: string, admittedAt: number, state: LaunchState = "admitted", seq = 1): FuseLaunchRecord {
  return { launchId, projectId, purpose: "work", role: "implementer", profileId: "p", state, admittedAt, seq };
}

function trip(overrides: Partial<FuseTripRecord> & Pick<FuseTripRecord, "tripId" | "scope" | "cause" | "openedAt">): FuseTripRecord {
  return { ownerClose: false, seq: 1, ...overrides };
}

function baseline(overrides: Partial<FuseBaseline> = {}): FuseBaseline {
  return { version: 1, seq: 1, launches: [], trips: [], ...overrides };
}

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "infinite-fuse-baseline-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a baseline round-trips through the sealed file", () => {
  withDirectory((directory) => {
    const key = randomBytes(32);
    const file = join(directory, BASELINE_FILE);
    const value = baseline({
      seq: 7,
      launches: [launch("L1", "a", now - minute)],
      trips: [trip({ tripId: "T1", scope: "host", cause: "launch-rate", openedAt: now - minute, window: "hour" })],
    });

    assert.equal(writeBaseline(file, key, value), true);
    assert.deepEqual(readBaseline(file, key), value);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    assert.equal(readBaseline(file, randomBytes(32)), undefined, "another key");
    writeSealed(file, key, "fuse-other", value);
    assert.equal(readBaseline(file, key), undefined, "another scope");
    writeFileSync(file, seal(key, BASELINE_SCOPE, value).slice(0, -20));
    assert.equal(readBaseline(file, key), undefined, "truncated JSON");
    assert.equal(readBaseline(join(directory, "missing.sealed"), key), undefined, "missing file");
    writeSealed(file, key, BASELINE_SCOPE, { ...value, version: 2 });
    assert.equal(readBaseline(file, key), undefined, "version 2");
    writeSealed(file, key, BASELINE_SCOPE, { ...value, unexpected: true });
    assert.equal(readBaseline(file, key), undefined, "unknown key");
  });
});

test("writing a baseline never throws", () => {
  withDirectory((directory) => {
    const blocker = join(directory, "blocker");
    writeFileSync(blocker, "not a directory");
    assert.equal(writeBaseline(join(blocker, BASELINE_FILE), randomBytes(32), baseline()), false);
  });
});

test("merge takes the union and the later copy of each item", () => {
  const file = baseline({
    seq: 3,
    launches: [launch("A", "a", now - 10 * minute, "admitted", 3), launch("C", "a", now - 9 * minute, "admitted", 5)],
    trips: [trip({ tripId: "T", scope: "host", cause: "launch-rate", openedAt: now - 30 * minute, closedAt: now - 20 * minute, closedBy: "rate", seq: 3 })],
  });
  const store = baseline({
    seq: 5,
    launches: [
      launch("A", "a", now - 10 * minute, "started", 4),
      launch("B", "b", now - 5 * minute, "released", 5),
      launch("C", "a", now - 9 * minute, "started", 5),
    ],
    trips: [trip({ tripId: "T", scope: "host", cause: "launch-rate", openedAt: now - 30 * minute, seq: 2 })],
  });

  const merged = mergeBaselines(file, store, now);
  assert.ok(merged);
  assert.equal(merged.seq, 5);
  assert.equal(merged.launches.find((item) => item.launchId === "A")?.state, "started");
  assert.equal(merged.launches.find((item) => item.launchId === "B")?.state, "released", "a store-only item newer than the file is kept");
  assert.equal(merged.launches.find((item) => item.launchId === "C")?.state, "admitted", "file wins a seq tie");
  assert.equal(merged.trips.length, 1);
  assert.equal(merged.trips[0].closedBy, "rate", "the later copy of the trip is the closed one");

  const fromStore = mergeBaselines(undefined, store, now);
  assert.equal(fromStore?.launches.length, 3);
  const fromFile = mergeBaselines(file, undefined, now);
  assert.equal(fromFile?.launches.length, 2);
  assert.equal(mergeBaselines(undefined, undefined, now), undefined);
});

test("the file has seen everything up to its own seq", () => {
  // The file is written first. An item that only the store holds, from before the file's seq, is one the file dropped.
  const staleTrip = trip({ tripId: "T", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 30 * minute, ownerClose: true, seq: 7 });
  const staleLaunch = launch("L", "a", now - 10 * minute, "started", 6);
  const newerTrip = trip({ tripId: "N", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 5 * minute, seq: 10 });
  const store = baseline({ seq: 10, launches: [staleLaunch], trips: [staleTrip, newerTrip] });
  const merged = mergeBaselines(baseline({ seq: 9 }), store, now);
  assert.deepEqual(merged?.trips.map((item) => item.tripId), ["N"], "the trip the file dropped stays dropped");
  assert.deepEqual(merged?.launches, []);
  // With no file, the store is all there is.
  const alone = mergeBaselines(undefined, store, now);
  assert.deepEqual(alone?.trips.map((item) => item.tripId).sort(), ["N", "T"]);
  assert.equal(alone?.launches.length, 1);
});

test("a closed trip stays closed in a merge", () => {
  for (const closedBy of ["owner", "rate"] as const) {
    const closed = trip({ tripId: "T", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 30 * minute, closedAt: now - 5 * minute, closedBy, ownerClose: closedBy === "owner", announcedAt: now - 29 * minute, seq: 9 });
    const open = trip({ tripId: "T", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 30 * minute, ownerClose: closedBy === "owner", announcedAt: now - 29 * minute, seq: 7 });
    for (const [file, store] of [[closed, open], [open, closed]] as const) {
      const merged = mergeBaselines(baseline({ seq: 9, trips: [file] }), baseline({ seq: 9, trips: [store] }), now);
      assert.equal(merged?.trips.length, 1);
      assert.equal(merged?.trips[0].closedBy, closedBy);
      assert.equal(merged?.trips[0].closedAt, now - 5 * minute);
    }
  }
});

test("prune keeps only what the windows need", () => {
  const yesterday = Date.parse("2026-11-12T20:00:00.000Z");
  const lastWeek = Date.parse("2026-11-06T10:00:00.000Z");
  const pruned = pruneBaseline(
    baseline({
      launches: [
        launch("started-61-minutes", "a", now - 61 * minute, "started"),
        launch("admitted-3-hours", "a", now - 180 * minute, "admitted"),
      ],
      trips: [
        trip({ tripId: "closed-yesterday", scope: "host", cause: "launch-rate", openedAt: yesterday, closedAt: now - 120 * minute, closedBy: "rate" }),
        trip({ tripId: "opened-today", scope: "host", cause: "launch-rate", openedAt: now - 180 * minute, closedAt: now - 120 * minute, closedBy: "rate" }),
        trip({ tripId: "owner-yesterday", scope: "host", cause: "launch-rate", openedAt: yesterday, closedAt: now - 30 * minute, closedBy: "owner", ownerClose: true }),
        trip({ tripId: "open-last-week", scope: "project", projectId: "a", cause: "launch-rate", openedAt: lastWeek }),
      ],
    }),
    now,
  );

  assert.deepEqual(pruned.launches.map((item) => item.launchId), ["admitted-3-hours"]);
  assert.deepEqual(pruned.trips.map((item) => item.tripId), ["opened-today", "owner-yesterday", "open-last-week"]);
});

test("a long project id is stored", () => {
  withDirectory((directory) => {
    const key = randomBytes(32);
    const file = join(directory, BASELINE_FILE);
    // The host configuration sets no length limit on a project id.
    const projectId = "p".repeat(300);
    const value = baseline({ launches: [launch("A", projectId, now)], trips: [trip({ tripId: "T", scope: "project", projectId, cause: "launch-rate", openedAt: now })] });
    assert.equal(writeBaseline(file, key, value), true);
    assert.deepEqual(readBaseline(file, key), value);
  });
});

test("an oversized baseline is unreadable", () => {
  withDirectory((directory) => {
    const key = randomBytes(32);
    const file = join(directory, BASELINE_FILE);
    const launches = Array.from({ length: 5001 }, (_, index) => launch(`L${index}`, "a", now));
    writeSealed(file, key, BASELINE_SCOPE, baseline({ launches }));
    assert.equal(readBaseline(file, key), undefined);
  });
});
