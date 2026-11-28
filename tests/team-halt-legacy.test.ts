import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HaltService } from "../packages/host/src/halt/service.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

test("a persisted halt without resumeStage resumes an answered queued replacement at its stage", async () => {
  const f = schedulerFixture();
  const target = { scope: "project", projectId: "fixture" } as const, owner = { deviceId: "owner-device", label: "Owner phone" };
  const run: TeamRun = structuredClone(f.run);
  const prior = { ...run.members[0]!, status: "waiting" as const };
  const decision = { id: randomUUID(), memberId: prior.memberId, revision: run.revision, question: "Which file should change?", options: ["a.txt", "b.txt"], createdAt: new Date().toISOString() };
  run.status = "needs-input"; run.members = [prior]; run.decisions = [decision];
  f.writeRecord("team", run.id, { run, prepared: true, fingerprint: "fixture", receipts: {} });
  let teams = f.openTeam();
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noRoutines, goals: noRoutines, missions: noRoutines, teams }, () => false);
  try {

    await teams.answer(run.id, decision.id, { requestId: randomUUID(), revision: run.revision, text: "Change a.txt" });
    const internal = teams as unknown as { record(id: string): unknown; step(stored: unknown): Promise<void> };
    await internal.step(internal.record(run.id)); await teams.idle();
    await halt.engage(target, { requestId: randomUUID() }, owner);

    const legacy = f.readRecord<{ run: TeamRun; ownerHalt?: { reason: string; waiting: true; resumeStage?: TeamRun["status"] }; ledgerReplaces?: unknown }>("team", run.id);
    assert.ok(legacy.run.members.some(member => member.status === "queued"));
    assert.equal(legacy.run.status, "paused");
    delete legacy.ownerHalt?.resumeStage;
    delete legacy.ledgerReplaces;
    f.writeRecord("team", run.id, legacy);

    teams.close();
    teams = f.openTeam();
    halt.stop();
    const resumedHalt = new HaltService({ config: f.config, key: f.key });
    resumedHalt.useServices({ routines: noRoutines, goals: noRoutines, missions: noRoutines, teams }, () => false);
    try {
      const released = await resumedHalt.release(target, { requestId: randomUUID() }, owner);
      assert.deepEqual(released.resumed.map(item => item.id), [run.id]);
      assert.equal(teams.get(run.id).status, "planning");
      assert.equal(teams.get(run.id).revision, run.revision);
    } finally { resumedHalt.stop(); }
  } finally { halt.stop(); f.close(); }
});

const noRoutines = { haltPause: async () => [], haltResume: async () => [] };
