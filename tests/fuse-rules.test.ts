import test from "node:test";
import assert from "node:assert/strict";
import type { FuseLaunchRecord, FuseTripRecord, FuseLimits, FuseOpen, FuseCheck, FuseAdmission } from "../packages/host/src/fuse/types.js";
import {
  EXEMPT_ROLES,
  HOUR_MS,
  applyFuseReason,
  fuseCheck,
  fuseReason,
  isFuseReason,
  projectLimit,
  rollingCount,
  scopeState,
  utcDay,
  workLaunch,
} from "../packages/host/src/fuse/rules.js";

const now = Date.parse("2026-11-13T10:00:00.000Z");

function launch(launchId: string, projectId: string, admittedAt: number, state: FuseLaunchRecord["state"] = "admitted"): FuseLaunchRecord {
  return { launchId, projectId, purpose: "work", role: "implementer", profileId: "p", state, admittedAt, seq: 0 };
}

function trip(overrides: Partial<FuseTripRecord> & Pick<FuseTripRecord, "tripId" | "scope" | "cause" | "openedAt">): FuseTripRecord {
  return { ownerClose: false, seq: 0, ...overrides };
}

function launches(projectId: string, count: number, admittedAt: number): FuseLaunchRecord[] {
  return Array.from({ length: count }, (_, index) => launch(`${projectId}-${index}`, projectId, admittedAt));
}

const limits: FuseLimits = { project: 30, host: 80, projects: { a: 5 } };

test("the rolling hour counts the last hour after the last owner close", () => {
  const edges = [
    launch("old", "a", now - HOUR_MS),
    launch("edge", "a", now - HOUR_MS + 1),
    launch("future", "a", now + 300_000),
  ];
  assert.equal(rollingCount(edges, [], "project", "a", now), 2);

  const closed = [trip({ tripId: "owner", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 7_200_000, closedAt: now - 1_800_000, closedBy: "owner", ownerClose: true })];
  const beforeClose = launch("before", "a", now - 2_000_000);
  const afterClose = launch("after", "a", now - 1_000_000);
  assert.equal(rollingCount([beforeClose, afterClose], closed, "project", "a", now), 1);

  const released = [launch("released", "a", now - 1_000, "released")];
  assert.equal(rollingCount(released, [], "project", "a", now), 1);

  const mixed = [launch("a1", "a", now - 1_000), launch("b1", "b", now - 1_000), launch("a2", "a", now - 2_000)];
  assert.equal(rollingCount(mixed, [], "host", undefined, now), 3);
  assert.equal(rollingCount(mixed, [], "project", "a", now), 2);
});

test("a rate trip opens at the limit and closes below half", () => {
  assert.deepEqual(scopeState(launches("a", 29, now - 1_000), [], "project", "a", 30, now), { state: "closed" });

  const pending = scopeState(launches("a", 30, now - 1_000), [], "project", "a", 30, now);
  assert.equal(pending.state, "open");
  assert.equal(pending.state === "open" && pending.tripId, undefined);
  assert.equal(pending.state === "open" && pending.ownerClose, false);

  const open30 = [trip({ tripId: "r30", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 1_000 })];
  assert.equal(scopeState(launches("a", 15, now - 1_000), open30, "project", "a", 30, now).state, "open");
  assert.equal(scopeState(launches("a", 14, now - 1_000), open30, "project", "a", 30, now).state, "closed");

  const open7 = [trip({ tripId: "r7", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 1_000 })];
  assert.equal(scopeState(launches("a", 4, now - 1_000), open7, "project", "a", 7, now).state, "open");
  assert.equal(scopeState(launches("a", 3, now - 1_000), open7, "project", "a", 7, now).state, "closed");
});

test("a second rate trip in one UTC day needs the owner", () => {
  const earlier = [trip({ tripId: "first", scope: "project", projectId: "a", cause: "launch-rate", openedAt: Date.parse("2026-11-13T01:00:00.000Z"), closedAt: Date.parse("2026-11-13T02:00:00.000Z"), closedBy: "rate" })];
  const lateSameDay = Date.parse("2026-11-13T23:59:00.000Z");
  const sameDay = scopeState(launches("a", 30, lateSameDay - 1_000), earlier, "project", "a", 30, lateSameDay);
  assert.equal(sameDay.state === "open" && sameDay.ownerClose, true);

  const nextDay = Date.parse("2026-11-14T00:00:00.000Z");
  const nextDayState = scopeState(launches("a", 30, nextDay - 1_000), earlier, "project", "a", 30, nextDay);
  assert.equal(nextDayState.state === "open" && nextDayState.ownerClose, false);

  const ownerOpen = [trip({ tripId: "owner-open", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 1_000, ownerClose: true })];
  assert.deepEqual(scopeState([], ownerOpen, "project", "a", 30, now), {
    state: "open",
    scope: "project",
    projectId: "a",
    cause: "launch-rate",
    tripId: "owner-open",
    ownerClose: true,
  });
});

test("an owner-close trip wins over another open rate trip of its scope", () => {
  // A merge of two baselines can leave two open rate trips in one scope. The one that needs the owner decides.
  const both = [
    trip({ tripId: "plain", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 3_000_000, window: "hour" }),
    trip({ tripId: "owner", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 1_000, window: "hour", ownerClose: true }),
  ];
  for (const trips of [both, [...both].reverse()]) {
    const state = scopeState([], trips, "project", "a", 30, now);
    assert.equal(state.state === "open" && state.tripId, "owner");
  }
});

test("unmeasurable wins, then the host, then the project", () => {
  const defaults: FuseLimits = { project: 30, host: 80, projects: {} };
  const project = trip({ tripId: "project-rate", scope: "project", projectId: "a", cause: "launch-rate", openedAt: now - 1_000 });
  const hostRate = trip({ tripId: "host-rate", scope: "host", cause: "launch-rate", openedAt: now - 1_000, ownerClose: true });
  const unmeasurable = trip({ tripId: "unmeasurable", scope: "host", cause: "unmeasurable", openedAt: now - 1_000 });
  const load = launches("a", 20, now - 1_000);

  const allThree = fuseCheck(load, [project, hostRate, unmeasurable], "a", defaults, now);
  assert.equal(allThree.state === "open" && allThree.cause, "unmeasurable");

  const hostOnly = fuseCheck(load, [project, hostRate], "a", defaults, now);
  assert.equal(hostOnly.state === "open" && hostOnly.scope, "host");
  assert.equal(hostOnly.state === "open" && hostOnly.tripId, "host-rate");

  const projectOnly = fuseCheck(load, [project], "a", defaults, now);
  assert.equal(projectOnly.state === "open" && projectOnly.scope, "project");
  assert.equal(projectOnly.state === "open" && projectOnly.tripId, "project-rate");

  for (const trips of [[project, hostRate, unmeasurable], [project, hostRate], [project]]) {
    const check = scopeState(load, trips, "project", "a", 30, now);
    assert.equal(check.state === "open" && check.tripId, "project-rate");
  }
});

test("a host rate trip closes for a project check when the host count falls", () => {
  const defaults: FuseLimits = { project: 30, host: 80, projects: {} };
  const hostTrip = trip({ tripId: "host-rate", scope: "host", cause: "launch-rate", openedAt: now - 1_000 });
  const others = launches("b", 40, now - 1_000);
  const open = fuseCheck(others, [hostTrip], "a", defaults, now);
  assert.equal(open.state === "open" && open.scope, "host");
  assert.equal(fuseCheck(others.slice(1), [hostTrip], "a", defaults, now).state, "closed");
  assert.equal(scopeState(others, [hostTrip], "project", "a", 30, now).state, "closed");
  assert.equal(scopeState(others.slice(1), [hostTrip], "project", "a", 30, now).state, "closed");
});

test("wait reasons name the scope and cause and hold no figure", () => {
  const prefix = "Waiting for the spend fuse:";
  const reasons = [
    fuseReason({ state: "open", scope: "project", projectId: "a", window: "hour", cause: "launch-rate", ownerClose: false }),
    fuseReason({ state: "open", scope: "project", projectId: "a", window: "hour", cause: "launch-rate", ownerClose: true }),
    fuseReason({ state: "open", scope: "host", window: "hour", cause: "launch-rate", ownerClose: false }),
    fuseReason({ state: "open", scope: "host", cause: "unmeasurable", ownerClose: false }),
    fuseReason("write-failed"),
  ];
  for (const reason of reasons) {
    assert.ok(reason.startsWith(prefix), reason);
    assert.doesNotMatch(reason, /\d/, reason);
    assert.equal(isFuseReason(reason), true);
  }
  const ownerClosed = fuseReason({ state: "open", scope: "project", projectId: "a", cause: "launch-rate", ownerClose: true });
  assert.ok(ownerClosed.endsWith(" It stays open until the owner closes it."), ownerClosed);
  assert.ok(fuseReason({ state: "open", scope: "host", cause: "launch-rate", ownerClose: true }).endsWith(" It stays open until the owner closes it."));
  const unmeasurableOwned = fuseReason({ state: "open", scope: "host", cause: "unmeasurable", ownerClose: true });
  assert.equal(unmeasurableOwned, "Waiting for the spend fuse: the host cannot read its fuse baseline.");
  assert.equal(isFuseReason("Waiting for an available host session slot."), false);
  assert.equal(isFuseReason(undefined), false);
});

test("an unmeasurable result has no window key", () => {
  const unmeasurable = trip({ tripId: "u", scope: "host", cause: "unmeasurable", openedAt: now - 1_000 });
  const result = scopeState([], [unmeasurable], "host", undefined, 80, now);
  assert.equal(result.state, "open");
  assert.equal("window" in result, false);
});

test("applying a result sets and clears only a fuse reason", () => {
  const open: FuseOpen = { state: "open", scope: "project", projectId: "a", window: "hour", cause: "launch-rate", ownerClose: false };
  const holder: { reason?: string } = { reason: "Waiting for an available host session slot." };

  assert.deepEqual(applyFuseReason(holder, open), { wait: true, changed: true });
  assert.equal(isFuseReason(holder.reason), true);
  assert.deepEqual(applyFuseReason(holder, open), { wait: true, changed: false });

  assert.deepEqual(applyFuseReason(holder, { state: "closed" }), { wait: false, changed: true });
  assert.equal(holder.reason, undefined);

  const other = { reason: "Waiting for an available host session slot." };
  assert.deepEqual(applyFuseReason(other, { state: "closed" }), { wait: false, changed: false });
  assert.equal(other.reason, "Waiting for an available host session slot.");

  const exempt = { reason: undefined as string | undefined };
  const exemptCheck: FuseCheck = { state: "closed", exempt: true };
  assert.deepEqual(applyFuseReason(exempt, exemptCheck), { wait: false, changed: false });
  assert.deepEqual(applyFuseReason(exempt, undefined), { wait: false, changed: false });

  const failed: { reason?: string } = {};
  const writeFailed: FuseAdmission = { ok: false, launchId: "x", failure: "write-failed" };
  assert.equal(applyFuseReason(failed, writeFailed).wait, true);
});

test("a closed check leaves a write failure for the admission to clear", () => {
  // `check` reads memory and cannot see a failing baseline write. Only `admit` can, so only an admission clears it.
  const writeFailed: FuseAdmission = { ok: false, launchId: "x", failure: "write-failed" };
  const holder: { reason?: string } = {};
  assert.deepEqual(applyFuseReason(holder, writeFailed), { wait: true, changed: true });
  const text = holder.reason;

  // The next pass: the check is closed, the admission fails again. Nothing changes, so nothing is saved.
  assert.deepEqual(applyFuseReason(holder, { state: "closed" }), { wait: false, changed: false });
  assert.equal(holder.reason, text);
  assert.deepEqual(applyFuseReason(holder, writeFailed), { wait: true, changed: false });

  assert.deepEqual(applyFuseReason(holder, { ok: true, launchId: "x" }), { wait: false, changed: true });
  assert.equal(holder.reason, undefined);
});

test("limits and days follow the configuration and UTC", () => {
  assert.equal(projectLimit(limits, "a"), 5);
  assert.equal(projectLimit(limits, "b"), 30);
  assert.equal(utcDay(Date.parse("2026-11-13T23:59:59.999Z")), "2026-11-13");
  assert.equal(utcDay(Date.parse("2026-11-14T00:00:00.000Z")), "2026-11-14");
  assert.equal(EXEMPT_ROLES.has("permission-coordinator"), true);
  assert.equal(EXEMPT_ROLES.has("project-manager"), false);
});

test("workLaunch builds one launch shape", () => {
  const team = { runId: "run-1", memberId: "member-1", revision: 3, role: "implementer" as const };
  assert.deepEqual(
    workLaunch({ launchId: "session-1", projectId: "a", provider: "claude", team, profile: { id: "profile-1" } }),
    {
      launchId: "session-1",
      projectId: "a",
      purpose: "work",
      role: "implementer",
      profileId: "profile-1",
      assignment: { runId: "run-1", memberId: "member-1", revision: 3 },
    },
  );
  assert.equal(workLaunch({ launchId: "session-2", projectId: "a", provider: "codex", team }).profileId, "codex");
});
