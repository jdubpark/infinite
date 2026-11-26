import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LinearService } from "../packages/host/src/linear.js";
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

test("settled no-op saves, scheduler ticks, and Linear check polls preserve updatedAt and lastActivityAt", async t => {
  const f = schedulerFixture();
  const created = "2026-10-18T00:00:00.000Z";
  const settledAt = "2026-10-18T02:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T06:00:00.000Z") });
  try {
    f.run.status = "ready-for-review";
    f.run.createdAt = created;
    f.run.updatedAt = settledAt;
    f.run.lastActivityAt = settledAt;
    f.run.linearTracking = true;
    f.run.linear = { status: "synced", checkedAt: settledAt };
    f.run.members[0]!.status = "stopped";
    f.run.members[0]!.startedAt = "2026-10-18T00:10:00.000Z";
    f.run.members[0]!.lastActivityAt = "2026-10-18T01:55:00.000Z";
    f.run.events = [{ at: settledAt, text: "Ready for human review." }];
    f.writeTeam();

    let linearCheckedAt = "2026-10-18T06:00:00.000Z";
    const linear = {
      updateTeam: () => ({ status: "synced" as const, checkedAt: linearCheckedAt }),
      getTeam: () => ({ status: "synced" as const, checkedAt: linearCheckedAt }),
      confirmTeam: async () => undefined,
    } as unknown as LinearService;

    const teams = f.openTeam({ linear });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);

    scheduler.save(stored);
    await scheduler.step(stored);
    t.mock.timers.tick(3_600_000);
    linearCheckedAt = "2026-10-18T07:00:00.000Z";
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
    assert.equal(sealed.linear?.checkedAt, "2026-10-18T07:00:00.000Z");
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

test("active member activity advances lastActivityAt while unchanged polls do not", async t => {
  const f = schedulerFixture();
  const baseMs = Date.parse("2026-10-18T10:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: baseMs });
  try {
    const startAt = "2026-10-18T09:58:00.000Z";
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
    f.state.attention.lastActivityAt = "2026-10-18T10:00:30.000Z";
    await scheduler.step(stored);
    assert.equal(teams.get(f.run.id).updatedAt, "2026-10-18T10:00:30.000Z");
    assert.equal(teams.get(f.run.id).lastActivityAt, "2026-10-18T10:00:30.000Z");

    t.mock.timers.tick(30_000);
    await scheduler.step(stored);
    assert.equal(teams.get(f.run.id).updatedAt, "2026-10-18T10:00:30.000Z");
    assert.equal(teams.get(f.run.id).lastActivityAt, "2026-10-18T10:00:30.000Z");
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});

test("legacy records without lastActivityAt derive activity ignoring churned updatedAt and roll back failed writes", t => {
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
      scheduler.event(stored, "Unpersisted note.");
      assert.throws(() => scheduler.save(stored));
      assert.equal(stored.run.updatedAt, "2026-10-18T11:59:00.000Z");
      assert.equal(stored.run.lastActivityAt, undefined);
    } finally {
      restore();
    }

    scheduler.save(stored);
    assert.equal(teams.get(f.run.id).updatedAt, "2026-10-18T12:00:00.000Z");
    assert.equal(teams.get(f.run.id).lastActivityAt, "2026-10-18T12:00:00.000Z");
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});
