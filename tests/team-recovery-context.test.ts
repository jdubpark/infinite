import test from "node:test";
import assert from "node:assert/strict";
import type { TeamRun } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Internal = { record(id: string): unknown; step(stored: unknown): Promise<void> };

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

test("a project manager recovery lists an implementer's working copy and not an evaluator's", async () => {
  const f = schedulerFixture();
  try {
    const manager = f.run.members[0]!;
    manager.status = "stopped";
    const member = { ...structuredClone(manager), memberId: "implementer-1", role: "implementer" as const, cwd: "/implementer/working/copy" };
    const evaluator = { ...structuredClone(manager), memberId: "evaluator-1", role: "evaluator" as const, cwd: "/evaluator/working/copy" };
    f.run.members.push(member, evaluator);
    const reason = "A change left the assigned scope.";
    f.run.recovery = { attempts: 1, status: "stopping", source: { code: "task-scope-violation", memberId: manager.memberId, revision: 1, reason, at: new Date().toISOString() } };
    f.run.status = "planning"; f.run.blockCode = "task-scope-violation"; f.run.reason = reason;
    f.run.headCommit = f.run.baseCommit;
    Object.assign(f.config.projects[0]!, { team: { checks: [], establishChecks: true } });
    f.writeTeam();
    const scheduler = f.openTeam() as unknown as TeamService & Internal;
    await scheduler.step(scheduler.record(f.run.id));
    const members = () => f.readRecord<{ run: TeamRun }>("team", f.run.id).run.members;
    await waitFor(() => members().some(item => item.role === "project-manager" && item.revision === 2), "the recovery manager is queued");
    const feedback = members().find(item => item.role === "project-manager" && item.contextFeedback)?.contextFeedback ?? "";
    assert.ok(feedback.includes(member.cwd), "the implementer's working copy is listed");
    assert.equal(feedback.includes(evaluator.cwd), false, "the evaluator's working copy is not listed");
  } finally { f.close(); }
});
