import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { initialAttention } from "@infinite/attention";
import type { LinearService } from "../packages/host/src/linear.js";
import type { LinearIssueView, LinearTrackingView } from "../packages/host/src/linear-types.js";
import { unavailableState } from "../packages/host/src/session-listing.js";
import { TeamSaveTracker } from "../packages/host/src/team-activity.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import type { Stored, TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Internal = {
  save(stored: Stored): void;
  event(stored: Stored, text: string): void;
  record(id: string): Stored;
  step(stored: Stored): Promise<void>;
};
const internal = (teams: TeamService) => teams as unknown as Internal;

function sampleIssue(overrides: Partial<LinearIssueView> = {}): LinearIssueView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    identifier: "INF-446",
    url: "https://linear.app/example/issue/INF-446",
    title: "Persist authoritative lastActivityAt",
    description: "Keep settled timestamps stable.",
    state: { name: "In Progress", type: "started" },
    updatedAt: "2026-10-18T01:00:00.000Z",
    ...overrides,
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("settled no-op saves, Linear freshness cycles, and housekeeping preserve updatedAt and lastActivityAt while issue changes bump updatedAt", async t => {
  const f = schedulerFixture();
  const created = "2026-10-18T00:00:00.000Z";
  const settledAt = "2026-10-18T02:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T06:00:00.000Z") });
  try {
    const issue = sampleIssue();
    let tracking: LinearTrackingView = { status: "synced", issue, checkedAt: settledAt };
    f.run.status = "ready-for-review";
    f.run.createdAt = created;
    f.run.updatedAt = settledAt;
    f.run.lastActivityAt = settledAt;
    f.run.linearTracking = true;
    f.run.linear = structuredClone(tracking);
    f.run.members[0]!.status = "stopped";
    f.run.members[0]!.startedAt = "2026-10-18T00:10:00.000Z";
    f.run.members[0]!.lastActivityAt = "2026-10-18T01:55:00.000Z";
    f.run.events = [{ at: settledAt, text: "Ready for human review." }];
    f.writeTeam();

    const linear = {
      updateTeam: () => structuredClone(tracking),
      getTeam: () => structuredClone(tracking),
      confirmTeam: async () => undefined,
    } as unknown as LinearService;

    const teams = f.openTeam({ linear });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);

    scheduler.save(stored);
    await scheduler.step(stored);

    t.mock.timers.tick(31_000);
    tracking = {
      status: "pending",
      reason: "Waiting for Linear to confirm current requirements and execution evidence.",
      checkedAt: settledAt,
      issue,
    };
    await scheduler.step(stored);
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.linear?.status, "pending");

    t.mock.timers.tick(2_000);
    tracking = { status: "synced", issue, checkedAt: new Date().toISOString() };
    await scheduler.step(stored);

    t.mock.timers.tick(31_000);
    tracking = {
      status: "pending",
      reason: "Linear is rate-limiting this host's requests.",
      retryAt: "2026-10-18T06:02:00Z",
      checkedAt: tracking.checkedAt,
      issue,
    };
    await scheduler.step(stored);

    t.mock.timers.tick(60_000);
    const refreshedAt = new Date().toISOString();
    tracking = { status: "synced", issue, checkedAt: refreshedAt };
    await scheduler.step(stored);

    stored.permissionTaskEnded = true;
    scheduler.save(stored);

    const view = teams.get(f.run.id);
    const listed = teams.listItems().find(item => item.id === f.run.id)!;
    const sealed = f.readRecord<{ run: TeamRun }>("team", f.run.id).run;
    assert.equal(view.updatedAt, settledAt);
    assert.equal(view.lastActivityAt, settledAt);
    assert.equal(listed.updatedAt, settledAt);
    assert.equal(listed.lastActivityAt, settledAt);
    assert.equal(sealed.updatedAt, settledAt);
    assert.equal(sealed.lastActivityAt, settledAt);
    assert.equal(sealed.linear?.checkedAt, refreshedAt);

    t.mock.timers.tick(60_000);
    const issueChangedAt = new Date().toISOString();
    tracking = {
      status: "synced",
      checkedAt: issueChangedAt,
      issue: sampleIssue({ title: "Persist authoritative lastActivityAt (updated)", state: { name: "In Review", type: "started" }, updatedAt: issueChangedAt }),
    };
    await scheduler.step(stored);
    assert.equal(teams.get(f.run.id).updatedAt, issueChangedAt);
    assert.equal(teams.get(f.run.id).lastActivityAt, settledAt);
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.updatedAt, issueChangedAt);
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.lastActivityAt, settledAt);
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});

test("real changes on a settled run update and persist updatedAt and lastActivityAt", async t => {
  const f = schedulerFixture();
  const settledAt = "2026-10-18T02:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T05:00:00.000Z") });
  try {
    f.run.status = "ready-for-review";
    f.run.createdAt = "2026-10-18T00:00:00.000Z";
    f.run.updatedAt = settledAt;
    f.run.lastActivityAt = settledAt;
    f.run.members[0]!.status = "stopped";
    f.run.members[0]!.startedAt = "2026-10-18T00:10:00.000Z";
    f.run.members[0]!.lastActivityAt = "2026-10-18T01:55:00.000Z";
    f.run.tasks = [{
      id: "t1", title: "Task 1", instructions: "Do work", paths: ["a.ts"], dependsOn: [],
      revision: 1, status: "integrated", memberId: f.run.members[0]!.memberId,
    }];
    f.writeTeam();

    const teams = f.openTeam();
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);

    scheduler.event(stored, "Published head to GitHub.");
    stored.run.publication = { repository: "example/app", branch: "infinite/team-x", commit: f.run.baseCommit, publishedAt: "2026-10-18T05:00:00.000Z" };
    scheduler.save(stored);
    assert.equal(teams.get(f.run.id).updatedAt, "2026-10-18T05:00:00.000Z");
    assert.equal(teams.get(f.run.id).lastActivityAt, "2026-10-18T05:00:00.000Z");

    t.mock.timers.tick(600_000);
    teams.rateTask(f.run.id, "t1", { requestId: randomUUID(), score: 5 });
    assert.equal(teams.get(f.run.id).updatedAt, "2026-10-18T05:10:00.000Z");
    assert.equal(teams.get(f.run.id).lastActivityAt, "2026-10-18T05:10:00.000Z");

    t.mock.timers.tick(600_000);
    const steered = await teams.steer(f.run.id, { requestId: randomUUID(), revision: 1, text: "Refine edge cases." });
    assert.equal(steered.updatedAt, "2026-10-18T05:20:00.000Z");
    assert.equal(steered.lastActivityAt, "2026-10-18T05:20:00.000Z");
    const sealed = f.readRecord<{ run: TeamRun }>("team", f.run.id).run;
    assert.equal(sealed.updatedAt, "2026-10-18T05:20:00.000Z");
    assert.equal(sealed.lastActivityAt, "2026-10-18T05:20:00.000Z");
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});

test("active member activity advances lastActivityAt while unchanged and repeated unavailable-worker polls do not", async t => {
  const f = schedulerFixture();
  const baseMs = Date.parse("2026-10-18T10:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: baseMs });
  try {
    const startAt = "2026-10-18T09:58:00.000Z";
    f.config.teams!.stallMinutes = 60;
    f.run.status = "planning";
    f.run.parallelismCeiling = 4;
    f.run.parallelism = 4;
    f.run.createdAt = startAt;
    f.run.updatedAt = startAt;
    f.run.lastActivityAt = startAt;
    f.run.members[0]!.startedAt = startAt;
    f.run.members[0]!.lastActivityAt = startAt;
    f.state.attention.lastActivityAt = startAt;
    f.writeTeam();

    const teams = f.openTeam();
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);

    await scheduler.step(stored);
    assert.equal(teams.get(f.run.id).updatedAt, startAt);
    assert.equal(teams.get(f.run.id).lastActivityAt, startAt);

    t.mock.timers.tick(30_000);
    const activeAt = "2026-10-18T10:00:30.000Z";
    f.state.attention.lastActivityAt = activeAt;
    await scheduler.step(stored);
    assert.equal(teams.get(f.run.id).updatedAt, activeAt);
    assert.equal(teams.get(f.run.id).lastActivityAt, activeAt);

    t.mock.timers.tick(30_000);
    await scheduler.step(stored);
    assert.equal(teams.get(f.run.id).updatedAt, activeAt);
    assert.equal(teams.get(f.run.id).lastActivityAt, activeAt);

    t.mock.timers.tick(30_000);
    const unavailableAt = new Date().toISOString();
    Object.assign(f.state, unavailableState(unavailableAt));
    await scheduler.step(stored);
    assert.equal(stored.run.members[0]!.status, "unavailable");
    assert.equal(stored.run.members[0]!.lastActivityAt, activeAt);
    assert.equal(teams.get(f.run.id).updatedAt, unavailableAt);
    assert.equal(teams.get(f.run.id).lastActivityAt, unavailableAt);

    t.mock.timers.tick(60_000);
    Object.assign(f.state, unavailableState(new Date().toISOString()));
    await scheduler.step(stored);
    assert.equal(stored.run.members[0]!.lastActivityAt, activeAt);
    assert.equal(teams.get(f.run.id).updatedAt, unavailableAt);
    assert.equal(teams.get(f.run.id).lastActivityAt, unavailableAt);

    t.mock.timers.tick(60_000);
    Object.assign(f.state, { ...unavailableState(new Date().toISOString()), status: "recording-error" });
    await scheduler.step(stored);
    assert.equal(stored.run.members[0]!.lastActivityAt, activeAt);
    assert.equal(teams.get(f.run.id).updatedAt, unavailableAt);
    assert.equal(teams.get(f.run.id).lastActivityAt, unavailableAt);

    t.mock.timers.tick(60_000);
    const recoveredAt = new Date().toISOString();
    Object.assign(f.state, { status: "running", seq: 0, screen: "", attention: initialAttention(recoveredAt, true) });
    await scheduler.step(stored);
    assert.equal(stored.run.members[0]!.status, "running");
    assert.equal(stored.run.members[0]!.lastActivityAt, recoveredAt);
    assert.equal(teams.get(f.run.id).updatedAt, recoveredAt);
    assert.equal(teams.get(f.run.id).lastActivityAt, recoveredAt);
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});

test("legacy records derive activity ignoring churned updatedAt and failed post-rename writes reconcile disk on rollback", t => {
  const f = schedulerFixture();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T12:00:00.000Z") });
  try {
    f.run.status = "merged";
    f.run.createdAt = "2026-10-15T00:00:00.000Z";
    f.run.updatedAt = "2026-10-18T11:59:00.000Z";
    delete f.run.lastActivityAt;
    f.run.members[0]!.status = "stopped";
    f.run.members[0]!.startedAt = "2026-10-15T00:05:00.000Z";
    f.run.members[0]!.lastActivityAt = "2026-10-15T01:00:00.000Z";
    f.run.events = [{ at: "2026-10-15T01:30:00.000Z", text: "Merged." }];
    f.writeTeam();

    const teams = f.openTeam();
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);

    assert.equal(teams.get(f.run.id).lastActivityAt, "2026-10-15T01:30:00.000Z");
    assert.equal(teams.listItems().find(item => item.id === f.run.id)?.lastActivityAt, "2026-10-15T01:30:00.000Z");

    scheduler.save(stored);
    assert.equal(teams.get(f.run.id).updatedAt, "2026-10-18T11:59:00.000Z");
    assert.equal(teams.get(f.run.id).lastActivityAt, "2026-10-15T01:30:00.000Z");

    const restore = f.blockRecordWrites("team", f.run.id);
    try {
      scheduler.event(stored, "Post-rename fsync failure note.");
      assert.throws(() => scheduler.save(stored));
      assert.equal(stored.run.updatedAt, "2026-10-18T11:59:00.000Z");
      assert.equal(stored.run.lastActivityAt, undefined);
    } finally {
      restore();
    }

    f.writeRecord("team", f.run.id, structuredClone(stored));
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.events.length, 2);

    stored.run.events.pop();
    scheduler.save(stored);
    const reconciled = f.readRecord<{ run: TeamRun }>("team", f.run.id).run;
    assert.equal(reconciled.events.length, 1);
    assert.equal(reconciled.updatedAt, "2026-10-18T11:59:00.000Z");
    assert.equal(reconciled.lastActivityAt, undefined);

    teams.close();
    const restarted = f.openTeam();
    assert.equal(restarted.get(f.run.id).events.length, 1);
    assert.equal(restarted.get(f.run.id).updatedAt, "2026-10-18T11:59:00.000Z");
    assert.equal(restarted.get(f.run.id).lastActivityAt, "2026-10-15T01:30:00.000Z");

    const tracker = new TeamSaveTracker();
    const record: Stored = structuredClone(internal(restarted).record(f.run.id));
    record.run.lastActivityAt = "2026-10-15T01:30:00.000Z";
    tracker.seed(record);
    let disk = JSON.stringify(record);
    let writes = 0;

    assert.equal(tracker.commit(record, () => { writes++; disk = JSON.stringify(record); }, () => "2026-10-18T12:01:00.000Z"), false);
    assert.equal(writes, 0);

    record.run.events.push({ at: "2026-10-18T12:02:00.000Z", text: "Renamed before fsync error." });
    assert.throws(() => tracker.commit(record, () => {
      writes++;
      disk = JSON.stringify(record);
      throw new Error("EIO: fsync failed");
    }, () => "2026-10-18T12:02:00.000Z"));
    assert.equal(writes, 1);
    assert.equal((JSON.parse(disk) as Stored).run.events.length, 2);
    assert.equal(record.run.updatedAt, "2026-10-18T11:59:00.000Z");
    assert.equal(record.run.lastActivityAt, "2026-10-15T01:30:00.000Z");

    record.run.events.pop();
    assert.equal(tracker.commit(record, () => { writes++; disk = JSON.stringify(record); }, () => "2026-10-18T12:03:00.000Z"), true);
    assert.equal(writes, 2);
    const diskAfterRollback = (JSON.parse(disk) as Stored).run;
    assert.equal(diskAfterRollback.events.length, 1);
    assert.equal(diskAfterRollback.updatedAt, "2026-10-18T11:59:00.000Z");
    assert.equal(diskAfterRollback.lastActivityAt, "2026-10-15T01:30:00.000Z");
    assert.equal(tracker.commit(record, () => { writes++; disk = JSON.stringify(record); }, () => "2026-10-18T12:04:00.000Z"), false);
    assert.equal(writes, 2);
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});

test("seeded randomized durable-state simulator preserves timestamp and persistence invariants across polls, failures, and restarts", async t => {
  const seed = Number(process.env.TEAM_ACTIVITY_SEED ?? 0x5eed446);
  t.diagnostic(`seed=${seed}`);
  const rng = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;

  for (const phase of ["settled", "active"] as const) {
    const f = schedulerFixture();
    const startAt = "2026-10-18T02:00:00.000Z";
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T06:00:00.000Z") });
    try {
      let issueVersion = 1;
      let issue = sampleIssue({ title: `Issue v${issueVersion}` });
      let tracking: LinearTrackingView = { status: "synced", issue, checkedAt: startAt };
      let linearStatusKind: "synced" | "error" = "synced";
      f.config.teams!.stallMinutes = 24 * 60;
      f.run.status = phase === "settled" ? "ready-for-review" : "planning";
      f.run.parallelismCeiling = 4;
      f.run.parallelism = 4;
      f.run.createdAt = "2026-10-18T00:00:00.000Z";
      f.run.updatedAt = startAt;
      f.run.lastActivityAt = startAt;
      f.run.linearTracking = true;
      f.run.linear = structuredClone(tracking);
      f.run.members[0]!.status = phase === "settled" ? "stopped" : "running";
      f.run.members[0]!.startedAt = "2026-10-18T00:10:00.000Z";
      f.run.members[0]!.lastActivityAt = startAt;
      f.run.events = [{ at: startAt, text: "Initial event." }];
      f.run.tasks = [{
        id: "t1", title: "Task 1", instructions: "Do work", paths: ["a.ts"], dependsOn: [],
        revision: 1, status: phase === "settled" ? "integrated" : "running", memberId: f.run.members[0]!.memberId,
      }];
      Object.assign(f.state, { status: "running", seq: 0, screen: "", attention: initialAttention(startAt, true) });
      f.writeTeam();

      const linear = {
        updateTeam: () => structuredClone(tracking),
        getTeam: () => structuredClone(tracking),
        confirmTeam: async () => undefined,
      } as unknown as LinearService;

      let teams = f.openTeam({ linear });
      let scheduler = internal(teams);
      let stored = scheduler.record(f.run.id);

      let expectedUpdatedAt = startAt;
      let expectedLastActivityAt = startAt;
      let expectedMemberLastActivityAt = startAt;
      let expectedEvents = 1;
      let memberUnavailable = false;
      let publicationSeq = 0;

      const settledOps = [
        "noop-save",
        "noop-step",
        "linear-freshness",
        "linear-issue-change",
        "linear-error-toggle",
        "housekeeping",
        "event",
        "publication",
        "rate-task",
        "failed-write-rollback",
        "failed-write-retry",
        "restart",
      ] as const;
      const activeOps = [
        "noop-save",
        "noop-step",
        "linear-freshness",
        "linear-issue-change",
        "housekeeping",
        "unavailable-poll",
        "active-activity",
        "event",
        "failed-write-rollback",
        "failed-write-retry",
        "restart",
      ] as const;

      for (let step = 0; step < 50; step++) {
        t.mock.timers.tick(15_000 + Math.floor(rng() * 45_000));
        const now = new Date().toISOString();
        const op = phase === "settled" ? pick(settledOps) : pick(activeOps);
        const ctx = `seed=${seed} phase=${phase} step=${step} op=${op}`;

        if (op === "noop-save") {
          scheduler.save(stored);
        } else if (op === "noop-step") {
          await scheduler.step(stored);
        } else if (op === "linear-freshness") {
          if (linearStatusKind === "synced") {
            tracking = rng() < 0.5
              ? { status: "pending", reason: "Waiting for Linear to confirm current requirements and execution evidence.", checkedAt: tracking.checkedAt, issue }
              : { status: "synced", issue, checkedAt: now };
            await scheduler.step(stored);
          }
        } else if (op === "linear-issue-change") {
          issueVersion++;
          issue = sampleIssue({ title: `Issue v${issueVersion}`, updatedAt: now });
          tracking = { status: "synced", issue, checkedAt: now };
          linearStatusKind = "synced";
          await scheduler.step(stored);
          expectedUpdatedAt = now;
        } else if (op === "linear-error-toggle") {
          if (linearStatusKind === "synced") {
            tracking = { status: "error", reason: "Linear could not confirm synchronization.", checkedAt: now, issue };
            linearStatusKind = "error";
          } else {
            tracking = { status: "synced", issue, checkedAt: now };
            linearStatusKind = "synced";
          }
          await scheduler.step(stored);
          expectedUpdatedAt = now;
        } else if (op === "housekeeping") {
          stored.permissionTaskEnded = !stored.permissionTaskEnded;
          scheduler.save(stored);
        } else if (op === "unavailable-poll") {
          const kind = rng() < 0.5 ? "unavailable" : "recording-error";
          Object.assign(f.state, { ...unavailableState(now), status: kind });
          await scheduler.step(stored);
          if (!memberUnavailable) {
            memberUnavailable = true;
            expectedUpdatedAt = now;
            expectedLastActivityAt = now;
          }
        } else if (op === "active-activity") {
          Object.assign(f.state, { status: "running", seq: 0, screen: "", attention: initialAttention(now, true) });
          await scheduler.step(stored);
          memberUnavailable = false;
          expectedMemberLastActivityAt = now;
          expectedUpdatedAt = now;
          expectedLastActivityAt = now;
        } else if (op === "event") {
          scheduler.event(stored, `Event ${step}`);
          scheduler.save(stored);
          expectedEvents++;
          expectedUpdatedAt = now;
          expectedLastActivityAt = now;
        } else if (op === "publication") {
          publicationSeq++;
          stored.run.publication = { repository: "example/app", branch: `infinite/sim-${publicationSeq}`, commit: f.run.baseCommit, publishedAt: now };
          scheduler.save(stored);
          expectedUpdatedAt = now;
          expectedLastActivityAt = now;
        } else if (op === "rate-task") {
          const score = (1 + (step % 5)) as 1 | 2 | 3 | 4 | 5;
          teams.rateTask(f.run.id, "t1", { requestId: randomUUID(), score });
          expectedEvents++;
          expectedUpdatedAt = now;
          expectedLastActivityAt = now;
        } else if (op === "failed-write-rollback") {
          const postRename = rng() < 0.5;
          const restore = f.blockRecordWrites("team", f.run.id);
          try {
            scheduler.event(stored, `Failed rollback ${step}`);
            assert.throws(() => scheduler.save(stored), ctx);
            assert.equal(stored.run.updatedAt, expectedUpdatedAt, ctx);
            assert.equal(stored.run.lastActivityAt, expectedLastActivityAt, ctx);
          } finally {
            restore();
          }
          if (postRename) f.writeRecord("team", f.run.id, structuredClone(stored));
          stored.run.events.pop();
          scheduler.save(stored);
        } else if (op === "failed-write-retry") {
          const restore = f.blockRecordWrites("team", f.run.id);
          try {
            scheduler.event(stored, `Failed retry ${step}`);
            assert.throws(() => scheduler.save(stored), ctx);
            assert.equal(stored.run.updatedAt, expectedUpdatedAt, ctx);
            assert.equal(stored.run.lastActivityAt, expectedLastActivityAt, ctx);
          } finally {
            restore();
          }
          t.mock.timers.tick(5_000);
          const retryAt = new Date().toISOString();
          scheduler.save(stored);
          expectedEvents++;
          expectedUpdatedAt = retryAt;
          expectedLastActivityAt = retryAt;
        } else if (op === "restart") {
          teams.close();
          teams = f.openTeam({ linear });
          scheduler = internal(teams);
          stored = scheduler.record(f.run.id);
          t.mock.timers.tick(5_000);
          scheduler.save(stored);
        }

        const view = teams.get(f.run.id);
        const listed = teams.listItems().find(item => item.id === f.run.id)!;
        const sealed = f.readRecord<{ run: TeamRun }>("team", f.run.id).run;
        assert.equal(view.updatedAt, expectedUpdatedAt, ctx);
        assert.equal(view.lastActivityAt, expectedLastActivityAt, ctx);
        assert.equal(listed.updatedAt, expectedUpdatedAt, ctx);
        assert.equal(listed.lastActivityAt, expectedLastActivityAt, ctx);
        assert.equal(sealed.updatedAt, expectedUpdatedAt, ctx);
        assert.equal(sealed.lastActivityAt, expectedLastActivityAt, ctx);
        assert.equal(sealed.events.length, expectedEvents, ctx);
        assert.ok(Date.parse(view.updatedAt) >= Date.parse(view.lastActivityAt), ctx);
        if (phase === "active") {
          assert.equal(stored.run.members[0]!.lastActivityAt, expectedMemberLastActivityAt, ctx);
          assert.equal(sealed.members[0]!.lastActivityAt, expectedMemberLastActivityAt, ctx);
        }
      }
      if (phase === "settled") {
        t.mock.timers.tick(30_000);
        const steerAt = new Date().toISOString();
        const steerCtx = `seed=${seed} phase=settled op=steer`;
        const steered = await teams.steer(f.run.id, { requestId: randomUUID(), revision: stored.run.revision, text: "Follow-up direction." });
        assert.equal(steered.updatedAt, steerAt, steerCtx);
        assert.equal(steered.lastActivityAt, steerAt, steerCtx);
        teams.close();
        teams = f.openTeam({ linear });
        scheduler = internal(teams);
        stored = scheduler.record(f.run.id);
        t.mock.timers.tick(15_000);
        scheduler.save(stored);
        const afterSteer = teams.get(f.run.id);
        const afterSteerSealed = f.readRecord<{ run: TeamRun }>("team", f.run.id).run;
        assert.equal(afterSteer.updatedAt, steerAt, steerCtx);
        assert.equal(afterSteer.lastActivityAt, steerAt, steerCtx);
        assert.equal(afterSteerSealed.updatedAt, steerAt, steerCtx);
        assert.equal(afterSteerSealed.lastActivityAt, steerAt, steerCtx);
      }
    } finally {
      t.mock.timers.reset();
      f.close();
    }
  }
});
