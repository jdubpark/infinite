import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "./helpers.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { TeamLineup, TeamView } from "../packages/host/src/team-types.js";
import { GoalService } from "../packages/host/src/goals.js";
import { TeamService } from "../packages/host/src/teams.js";
import type { Manager } from "../packages/host/src/manager.js";

const EVENT = "A feature passed checks and independent review. The next feature will use its recorded commit.";
const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function endedRunFixture() {
  const f = schedulerFixture(), at = new Date().toISOString();
  const goal: ProductGoal = { id: randomUUID(), projectId: f.run.projectId, title: "Inspect the fixture", objective: "Choose scoped work",
    successCriteria: "The owner has evidence", nonGoals: [], allowedPaths: ["."], evidence: [], maxRuns: 1, maxMinutes: 60,
    maxMembers: 4, parallelism: 1, revision: 1, status: "running", createdAt: at, updatedAt: at,
    deadlineAt: new Date(Date.now() + 60 * 60000).toISOString(), lineup, activeTeamId: f.run.id, memberCount: 1,
    cycles: [{ teamId: f.run.id, cycle: 1, goalRevision: 1, status: "ready-for-review", startedAt: at, memberCount: 1 }],
    steering: [], events: [], outcomes: [] };
  f.run.goal = { id: goal.id, revision: 1, cycle: 1, successCriteria: goal.successCriteria, nonGoals: [], allowedPaths: ["."], evidence: [], previousWork: [], deadlineAt: goal.deadlineAt, maxMembers: 1 };
  f.run.status = "ready-for-review";
  f.run.members[0].status = "running";
  f.writeTeam();
  f.writeRecord("goal", goal.id, { goal, receipts: {}, fingerprint: "fixture" });
  return { ...f, goal };
}

test("an ended run with a running member writes its event once and leaves the goal file unchanged, across restart, until the member stops", { timeout: 60000 }, async () => {
  const f = endedRunFixture();
  const file = join(f.config.stateDir, "goals", `${f.goal.id}.sealed`);
  const record = () => f.readRecord<{ goal: ProductGoal }>("goal", f.goal.id).goal;
  const eventCount = (goal: ProductGoal) => goal.events.filter(event => event.text === EVENT).length;
  let memberStatus: TeamView["members"][number]["status"] = "running";
  let goals: GoalService | undefined;
  let teams: TeamService | undefined;
  try {
    teams = new TeamService(f.config, f.key, f.manager as unknown as Manager, (_project, start) => start(), undefined, undefined, { ownerActive: () => false });
    const getTeam = teams.get.bind(teams);
    teams.get = id => {
      const view = getTeam(id);
      return { ...view, members: view.members.map(member => ({ ...member, status: memberStatus })) };
    };
    goals = new GoalService(f.config, f.key, teams);
    goals.start();

    await waitFor(async () => record(), goal => eventCount(goal) >= 1, 10000);
    await sleep(1000);
    const passTwo = readFileSync(file);
    await sleep(1500);
    const passFive = readFileSync(file);
    assert.equal(eventCount(record()), 1, "The ended run writes its event once");
    assert.equal(JSON.stringify(goals.get(f.goal.id)).includes("endedAs"), false, "The client read of the goal carries no scheduler marker");
    assert.ok(passFive.equals(passTwo), "The goal file bytes do not change while nothing changes");

    goals.close();
    goals = new GoalService(f.config, f.key, teams);
    goals.start();
    await sleep(1200);
    const afterRestart = readFileSync(file);
    await sleep(1200);
    assert.ok(readFileSync(file).equals(afterRestart), "A restart does not rewrite the goal file while nothing changes");
    assert.equal(eventCount(record()), 1, "A restart does not repeat the event");

    memberStatus = "stopped";
    const detached = await waitFor(async () => record(), goal => goal.activeTeamId === undefined, 10000);
    assert.equal(eventCount(detached), 1, "The detaching pass does not write the event again");
    assert.equal(detached.status, "ready-for-review", "The run detaches and the goal reaches its feature-run limit as before");
  } finally { goals?.close(); teams?.close(); f.close(); }
});
