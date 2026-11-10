import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, limitLineup } from "./team-fixture.js";
import { waitFor } from "./helpers.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";
import type { Routine } from "../packages/host/src/routine-types.js";
import { RoutineService } from "../packages/host/src/routines.js";
import { GoalService } from "../packages/host/src/goals.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

test("queued goal admission rechecks routine authority and the full execution window", async () => {
  for (const change of ["authority", "expiry"] as const) {
    const f = schedulerFixture(), realNow = Date.now, started = realNow();
    f.config.teams!.lineup = limitLineup;
    f.config.projects[0].team = { checks: [{ command: "node", args: ["check.mjs"] }] };
    const goals = new GoalService(f.config, f.key, f.openTeam());
    const routines = new RoutineService(f.config, f.key, goals, {
      isProjectBusy: async () => false,
      startGoal: (request, admit) => {
        const queued = goals.create(request, admit);
        // Invalidate after create was called but before its serialized transaction.
        if (change === "authority") f.config.agents.claude = { command: "changed-provider", args: [] };
        else Date.now = () => started + 2 * 60000;
        return queued;
      },
    });
    try {
      const routine = await routines.create({ requestId: randomUUID(), intervalMinutes: 5, maxOccurrences: 1,
        startsAt: new Date(started + 1000).toISOString(), expiresAt: new Date(started + 6 * 60000).toISOString(),
        goal: { projectId: "fixture", title: "Bounded task", objective: "Inspect the fixture", successCriteria: "Report inspected evidence",
          allowedPaths: ["."], nonGoals: [], evidence: [], maxRuns: 1, maxMinutes: 5, maxMembers: 4, parallelism: 1 },
      });
      Date.now = () => started + 2000;
      await routines.tick();
      assert.equal(routines.get(routine.id).status, "blocked");
      assert.match(routines.get(routine.id).reason ?? "", change === "authority" ? /policy changed/ : /approval window/);
      assert.equal(goals.list().length, 0, "invalidated admission must not persist a new goal or replenish its budget");
    } finally { Date.now = realNow; routines.close(); goals.close(); f.close(); }
  }
});

// This boundary owns the composition: a due routine must pass through the real
// goal, worker, permission-decision, host-check, and independent-review services.
test("an owner-approved routine self-triggers a bounded goal through scoped permission approval and independent review", { timeout: 150000 }, async () => {
  const lineup: TeamLineup = { ...limitLineup, coordinator: {
    ...limitLineup.coordinator, id: "claude-coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong",
  } };
  const f = await fixture("permissions-routine", lineup);
  const request = {
    requestId: randomUUID(), intervalMinutes: 5, maxOccurrences: 2,
    startsAt: new Date(Date.now() + 10000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    goal: { projectId: "rehearsal", title: "Check matching output files", objective: "Create independent matching files and verify their integrated contents.",
      successCriteria: "Both files pass the configured check and independent review.", allowedPaths: ["a.txt", "b.txt"],
      maxRuns: 1, maxMinutes: 5, maxMembers: 16, parallelism: 2 },
  };
  const read = async (): Promise<Routine> => {
    const response = await f.host.fetchApi(`/routines/${request.requestId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  try {
    for (const role of ["controller", "viewer"] as const)
      assert.equal((await f.host.fetchApi("/routines", role, request)).status, 403);
    const requestFile = join(f.host.root, "routine.json"), clientFile = join(f.host.root, "routine-client.json");
    writeFileSync(requestFile, JSON.stringify(request), { mode: 0o600 });
    writeFileSync(clientFile, JSON.stringify({ origin: f.host.origin, token: f.host.tokens.owner, projectId: "rehearsal" }), { mode: 0o600 });
    const cli = (...args: string[]) => promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "routine", ...args, "--client-config", clientFile], { timeout: 15000 });
    const created = { body: JSON.parse((await cli("create", "--file", requestFile, "--json")).stdout) as Routine };
    assert.equal(created.body.id, request.requestId);
    assert.match((await cli("status", request.requestId)).stdout, /revision 1/i);
    assert.equal((await f.host.fetchApi("/routines", "owner", request)).body.id, request.requestId);
    const stale = { requestId: randomUUID(), revision: created.body.revision + 100 };
    assert.equal((await f.host.fetchApi(`/routines/${request.requestId}/pause`, "owner", stale)).status, 409);
    for (const action of ["pause", "resume", "cancel"])
      assert.equal((await f.host.fetchApi(`/routines/${request.requestId}/${action}`, "controller", { requestId: randomUUID(), revision: created.body.revision })).status, 403);
    // A due trigger survives an API restart; no client posts a goal or team.
    await f.host.stopApi();
    await f.host.start();
    const active = await waitFor(read, value => Boolean(value.activeGoalId), 15000);
    const goalId = active.activeGoalId!;
    const goal = await waitFor(async () => (await f.host.fetchApi(`/goals/${goalId}`)).body, value => Boolean(value.activeTeamId), 20000);
    const teamId = goal.activeTeamId;
    await waitFor(() => f.get(teamId), value => Boolean(value.permissionDecisions?.length), 60000);
    writeFileSync(join(f.receipts, `${teamId}.judge-release`), "review current request", { mode: 0o600 });
    const reviewed = await f.settled(teamId);
    assert.equal(reviewed.status, "ready-for-review", JSON.stringify(reviewed));
    assert.equal(reviewed.review?.verdict, "approved");
    assert.ok(reviewed.checks.length > 0 && reviewed.checks.every(check => check.status === "passed"));
    const permission = reviewed.permissionDecisions?.find(decision => decision.status === "answered");
    assert.equal(permission?.receipt?.state, "delivered");
    assert.ok(reviewed.members.some(member => member.role === "permission-coordinator" && member.memberId === permission?.coordinatorMemberId));
    assert.ok(reviewed.members.some(member => member.role === "reviewer"));
    const stopped = await waitFor(read, value => value.status === "blocked", 15000);
    assert.match(stopped.reason ?? "", /review|deliver|merge/i);
    assert.equal(stopped.occurrences.length, 1, "unmerged work cannot trigger another improvement on the stale project base");
    assert.equal((await f.host.fetchApi(`/goals/${goalId}`)).body.outcomes.length, 0);
    await f.host.stopApi(); await f.host.start();
    assert.equal((await read()).occurrences.length, 1);
    assert.equal((await f.host.fetchApi("/goals")).body.goals.length, 1);
  } finally {
    try {
      const routine = await read();
      await f.host.fetchApi(`/routines/${routine.id}/cancel`, "owner", { requestId: randomUUID(), revision: routine.revision });
      for (const goal of (await f.host.fetchApi("/goals")).body.goals ?? [])
        await f.host.fetchApi(`/goals/${goal.id}/cancel`, "owner", { requestId: randomUUID(), revision: goal.revision });
    } finally { await f.close(); }
  }
});
