import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectPrompt, type Prompt } from "@infinite/attention";
import { permissionRequestShape } from "../packages/host/src/team-permissions.js";
import { teamPermissionTarget, type TeamTargetDeps } from "../packages/host/src/team-permission-adapter.js";
import type { PermissionRequest } from "../packages/host/src/permission-agent-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { limitLineup } from "./team-fixture.js";

function codeModePrompt(): Prompt {
  const detected = detectPrompt(readFileSync(resolve("tests/fixtures/screens/claude-code-mode.txt"), "utf8").split("\n"), "claude");
  assert.ok(detected);
  return { ...detected, id: 2, source: "screen", hash: "d".repeat(64) };
}

test("a delegated team member's Code Mode prompt stays with the owner despite a live decision", () => {
  const f = schedulerFixture();
  try {
    const member = f.run.members[0];
    const prompt = codeModePrompt();
    f.run.permissions = { mode: "coordinator", scope: "Approve one-time runs of accepted checks.", maxDecisions: 2 };
    f.run.lineup = { ...limitLineup, coordinator: { ...limitLineup.coordinator, provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" } };
    f.run.permissionDecisions = [{
      id: randomUUID(), revision: 1, policyHash: "a".repeat(64), targetMemberId: member.memberId,
      targetSessionId: member.sessionId, targetCwd: member.cwd, promptId: prompt.id, promptHash: prompt.hash!,
      evidenceHash: "b".repeat(64), prompt, option: 1, expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
      answerRequestId: randomUUID(), status: "reviewing",
    }];
    f.writeTeam();
    const teams = f.openTeam();
    assert.equal(teams.promptOwner(member.sessionId, prompt), "user");
  } finally {
    f.close();
  }
});

test("a permission agent's Code Mode reject has no deliverable option", async () => {
  const prompt = codeModePrompt();
  const request: PermissionRequest = {
    id: "code-mode-request",
    requester: { kind: "team-member", sessionId: "member-session", projectId: "project", taskId: "run", assignment: "team:run:implementer",
      role: "implementer", provider: "claude", sessionRoot: "/workspace", scratchRoots: [], task: { title: "Task", text: "Work" } },
    tool: "dialog", action: prompt.title, prompt, shape: permissionRequestShape(prompt), evidenceHash: "e".repeat(64),
  };
  let answerCalls = 0;
  const manager: TeamTargetDeps["manager"] = {
    meta: () => { throw new Error("invalid choice must not inspect the session"); },
    state: async () => { throw new Error("invalid choice must not inspect the session"); },
    answerAgentPermission: async () => { answerCalls++; throw new Error("invalid choice must not reach delivery"); },
  };
  const target = teamPermissionTarget(request, {
    manager, assignment: { runId: "run", memberId: "member", revision: 1, role: "implementer" },
    runCheck: () => undefined, sessionRoot: () => request.requester.sessionRoot,
    workspace: async () => ({ changedPaths: [], evidence: { files: [], limitations: [], digest: "empty" } }),
  });
  assert.equal(await target.answer(0, "decision", "fixed reject notice"), "refused");
  assert.equal(answerCalls, 0);
});
