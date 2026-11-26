import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HaltService } from "../packages/host/src/halt/service.js";
import { KEPT_PAUSED } from "../packages/host/src/halt/rules.js";
import { Manager } from "../packages/host/src/manager.js";
import { MissionService } from "../packages/host/src/missions.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { lineup as missionLineup } from "./mission-harness.js";

const owner = { deviceId: "test-device", label: "Test owner" };
const scope = { scope: "project", projectId: "fixture" } as const;
const noTargets = { haltPause: async () => [], haltResume: async () => [] };

type StoredHaltState = {
  ownerHalt?: { haltId: string; token: string; children: string[] };
  ops: { kind: string; teamId: string; halt?: { token: string } }[];
};

function open(f: ReturnType<typeof schedulerFixture>, missionId: string) {
  const teams = f.openTeam();
  const manager = {
    list: async () => [],
    meta: () => { throw Object.assign(new Error("No session."), { code: "ENOENT" }); },
    hostLoad: { held: () => undefined },
  } as unknown as Manager;
  const missions = new MissionService(f.config, f.key, manager, teams, {
    get: () => { throw new Error("The test mission has no group lookup."); },
  });
  const halt = new HaltService({ config: f.config, key: f.key });
  halt.useServices({ routines: noTargets, goals: noTargets, missions, teams }, id => missions.ownsActiveSubteam(id));
  const internal = missions as unknown as {
    records: Map<string, { mission: Mission }>;
    applyOps(stored: unknown): Promise<void>;
  };
  return {
    teams,
    missions,
    halt,
    applyOps: () => internal.applyOps(internal.records.get(missionId)!),
    close: () => { halt.stop(); missions.close(); teams.close(); },
  };
}

test("a halt release after restart settles a subteam whose pause reached it before the mission save", async () => {
  for (const keepPaused of [false, true]) {
    const f = schedulerFixture();
    const missionId = randomUUID(), teamId = randomUUID(), at = new Date().toISOString();
    const run: TeamRun = { ...structuredClone(f.run), id: teamId, missionId, title: "Subteam", status: "implementing", members: [] };
    f.writeRecord("team", teamId, { run, prepared: true, fingerprint: "fixture", receipts: {} });
    const mission: Mission = {
      id: missionId, groupId: "fixture-group", groupName: "Fixture", repoProjectIds: ["fixture"],
      title: "Mission", objective: "Complete one subtask", maxSubtasks: 1, maxMinutes: 60,
      deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), revision: 1, status: "working",
      createdAt: at, updatedAt: at, lineup: missionLineup,
      subtasks: [{ id: "a", repoProjectId: "fixture", title: "Subteam", objective: "Complete the task", size: "team", parallelism: 1, dependsOn: [], status: "running", teamId }],
      decisions: [], steering: [], events: [],
    };
    const missionDirectory = join(f.config.stateDir, "missions");
    mkdirSync(missionDirectory, { recursive: true, mode: 0o700 });
    writeSealed(join(missionDirectory, `${missionId}.sealed`), f.key, `mission:${missionId}`, {
      mission, fingerprint: "fixture", receipts: {}, folder: f.run.workspace, repos: [], attempts: [],
      inbox: [], notes: [], notified: [], launches: {}, ops: [], refusals: 0,
    });

    const first = open(f, missionId);
    let restarted: ReturnType<typeof open> | undefined;
    try {
      await first.halt.engage(scope, { requestId: randomUUID() }, owner);

      const deliver = first.teams.haltPauseChild.bind(first.teams);
      first.teams.haltPauseChild = async (id, token, reason) => {
        const reached = await deliver(id, token, reason);
        if (reached) throw new Error("Simulated host restart after the child save.");
        return reached;
      };
      await assert.rejects(first.applyOps(), /Simulated host restart/);
      const durableMission = unseal<StoredHaltState>(f.key, `mission:${missionId}`,
        readFileSync(join(missionDirectory, `${missionId}.sealed`), "utf8"));
      assert.deepEqual(durableMission.ownerHalt?.children, [], "the parent's acknowledgement has not been saved");
      assert.deepEqual(durableMission.ops.map(op => [op.kind, op.teamId]), [["pause", teamId]], "the durable pause op retains the reached subteam ID");
      assert.equal(f.readRecord<{ run: TeamRun; ownerHalt?: { haltId?: string } }>("team", teamId).ownerHalt?.haltId,
        durableMission.ownerHalt?.token, "the child saved the halt token before the parent acknowledgement");
      first.close();

      restarted = open(f, missionId);
      const settleTeam = restarted.teams as unknown as { record(id: string): unknown; step(stored: unknown): Promise<void> };
      await settleTeam.step(settleTeam.record(teamId));
      await restarted.teams.idle();

      await restarted.halt.release(scope, { requestId: randomUUID(), ...(keepPaused ? { keepPaused: true } : {}) }, owner);
      const releasedMission = unseal<StoredHaltState>(f.key, `mission:${missionId}`,
        readFileSync(join(missionDirectory, `${missionId}.sealed`), "utf8"));
      if (keepPaused) {
        assert.equal(restarted.teams.get(teamId).status, "paused");
        assert.equal(restarted.teams.get(teamId).reason, KEPT_PAUSED, "the keep-paused release replaces the vanished halt reason");
        assert.equal(f.readRecord<{ ownerHalt?: { haltId?: string } }>("team", teamId).ownerHalt?.haltId, undefined,
          "the child no longer carries the released halt token");
        assert.ok(releasedMission.ops.every(op => !op.halt), "only the ordinary mission pause can remain queued");
      } else {
        assert.deepEqual(releasedMission.ops.map(op => [op.kind, op.teamId, op.halt?.token]),
          [["resume", teamId, durableMission.ownerHalt?.token]], "the running release queues a token-checked resume");
        await restarted.applyOps();
        assert.notEqual(f.readRecord<{ ownerHalt?: { haltId?: string } }>("team", teamId).ownerHalt?.haltId,
          durableMission.ownerHalt?.token, "the subteam decides against and clears the released token");
        assert.equal(restarted.teams.get(teamId).status, "planning", "the running release resumes the subteam");
      }
    } finally {
      first.close();
      restarted?.close();
      f.close();
    }
  }
});

test("mission view sets canAnswerPaused only while an owner halt matches the paused revision", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID();
  const decision1 = randomUUID();
  const decision2 = randomUUID();
  const at = new Date().toISOString();
  const mission: Mission = {
    id: missionId,
    groupId: "fixture-group",
    groupName: "Fixture",
    repoProjectIds: ["fixture"],
    title: "Mission with decisions",
    objective: "Answer questions cleanly",
    maxSubtasks: 1,
    maxMinutes: 60,
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(),
    revision: 1,
    status: "needs-input",
    createdAt: at,
    updatedAt: at,
    lineup: missionLineup,
    subtasks: [],
    decisions: [
      { id: decision1, question: "First choice?", options: ["A", "B"], createdAt: at },
      { id: decision2, question: "Second choice?", options: ["C", "D"], createdAt: at },
    ],
    steering: [],
    events: [],
  };
  const missionDirectory = join(f.config.stateDir, "missions");
  mkdirSync(missionDirectory, { recursive: true, mode: 0o700 });
  writeSealed(join(missionDirectory, `${missionId}.sealed`), f.key, `mission:${missionId}`, {
    mission,
    fingerprint: "fixture",
    receipts: {},
    folder: f.run.workspace,
    repos: [],
    attempts: [],
    inbox: [],
    notes: [],
    notified: [],
    launches: {},
    ops: [],
    refusals: 0,
  });

  const host = open(f, missionId);
  try {
    assert.equal(host.missions.get(missionId).canAnswerPaused, undefined);

    await host.missions.pause(missionId, { requestId: randomUUID(), revision: host.missions.get(missionId).revision });
    const manuallyPaused = host.missions.get(missionId);
    assert.equal(manuallyPaused.status, "paused");
    assert.equal(manuallyPaused.canAnswerPaused, undefined);
    await assert.rejects(
      host.missions.answer(missionId, decision1, { requestId: randomUUID(), revision: manuallyPaused.revision, text: "A" }),
      /Resume the mission before answering/,
    );

    await host.missions.resume(missionId, { requestId: randomUUID(), revision: host.missions.get(missionId).revision });
    await host.halt.engage(scope, { requestId: randomUUID() }, owner);
    const haltPaused = host.missions.get(missionId);
    assert.equal(haltPaused.status, "paused");
    assert.equal(haltPaused.canAnswerPaused, true);

    const answered = await host.missions.answer(missionId, decision1, { requestId: randomUUID(), revision: haltPaused.revision, text: "A" });
    assert.equal(answered.status, "paused");
    assert.equal(answered.canAnswerPaused, true);

    await host.halt.release(scope, { requestId: randomUUID(), keepPaused: true }, owner);
    const keptPaused = host.missions.get(missionId);
    assert.equal(keptPaused.status, "paused");
    assert.equal(keptPaused.canAnswerPaused, undefined);
    await assert.rejects(
      host.missions.answer(missionId, decision2, { requestId: randomUUID(), revision: keptPaused.revision, text: "C" }),
      /Resume the mission before answering/,
    );
  } finally {
    host.close();
    f.close();
  }
});

test("saved Claude missions stay enabled and actionable after restart when the default coordinator changes to Codex", async () => {
  const f = schedulerFixture();
  const missionId = randomUUID();
  const decisionId = randomUUID();
  const at = new Date().toISOString();
  const mission: Mission = {
    id: missionId,
    groupId: "fixture-group",
    groupName: "Fixture",
    repoProjectIds: ["fixture"],
    title: "Saved Claude mission",
    objective: "Keep saved mission accessible after coordinator switch",
    maxSubtasks: 1,
    maxMinutes: 60,
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(),
    revision: 1,
    status: "needs-input",
    createdAt: at,
    updatedAt: at,
    lineup: missionLineup,
    subtasks: [],
    decisions: [{ id: decisionId, question: "Continue rollout?", options: ["A", "B"], createdAt: at }],
    steering: [],
    events: [],
  };
  const missionDirectory = join(f.config.stateDir, "missions");
  mkdirSync(missionDirectory, { recursive: true, mode: 0o700 });
  writeSealed(join(missionDirectory, `${missionId}.sealed`), f.key, `mission:${missionId}`, {
    mission,
    fingerprint: "fixture",
    receipts: {},
    folder: f.run.workspace,
    repos: [],
    attempts: [],
    inbox: [],
    notes: [],
    notified: [],
    launches: {},
    ops: [],
    refusals: 0,
  });

  f.config.teams = {
    ...f.config.teams!,
    lineup: {
      coordinator: { id: "codex-lead", label: "Codex lead", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
      integrator: missionLineup.integrator,
      reviewer: missionLineup.reviewer,
      implementers: missionLineup.implementers,
    },
  };

  const host = open(f, missionId);
  try {
    assert.equal(host.missions.enabled(), true, "saved missions keep missions.enabled true after default coordinator switches to Codex");
    assert.deepEqual(host.missions.list().map(item => item.id), [missionId]);
    assert.equal(host.missions.get(missionId).lineup.coordinator.provider, "claude");

    await assert.rejects(
      host.missions.create({ requestId: randomUUID(), groupId: "fixture-group", objective: "New mission", maxSubtasks: 1, maxMinutes: 30 }),
      (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "mission-coordinator-unsupported" && /Codex merges inherited MCP server tables/.test(error.message),
    );

    const paused = await host.missions.pause(missionId, { requestId: randomUUID(), revision: host.missions.get(missionId).revision });
    assert.equal(paused.status, "paused");

    const resumed = await host.missions.resume(missionId, { requestId: randomUUID(), revision: paused.revision });
    assert.equal(resumed.status, "needs-input");

    const answered = await host.missions.answer(missionId, decisionId, { requestId: randomUUID(), revision: resumed.revision, text: "A" });
    assert.equal(answered.status, "planning");
    assert.equal(answered.decisions[0]?.answer, "A");

    const cancelled = await host.missions.cancel(missionId, { requestId: randomUUID(), revision: answered.revision });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(host.missions.get(missionId).status, "cancelled");
  } finally {
    host.close();
    f.close();
  }
});
