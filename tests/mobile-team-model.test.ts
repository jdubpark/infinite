import test from "node:test";
import assert from "node:assert/strict";
import { approvalOwner, blockedTeamsFirst, canContinueBlockedTeam, canResumeBlockedTeam, goalControls, goalGroup, groupRuns, newer, openDecisions, pendingApprovals, taskKind, teamControls, teamGroup, teamKind, teamPhases, workerStatus, type PermissionDecision, type ProductGoal, type TeamMember, type TeamTask, type TeamView } from "../apps/mobile/src/features/teams/model.ts";
import { age, initials } from "../apps/mobile/src/status.ts";
import { runRequests } from "../apps/mobile/src/store/requests.ts";

const team = (overrides: Partial<TeamView> = {}) => ({
  id: "team", projectId: "rehearsal", provider: "demo", title: "Team", objective: "Build it", parallelism: 2,
  revision: 2, status: "implementing", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z",
  workspace: "/srv/team", branch: "infinite/team", baseCommit: "base", tasks: [], members: [], decisions: [], checks: [],
  steering: [], events: [], round: 0, ...overrides,
}) as TeamView;
const goal = (overrides: Partial<ProductGoal> = {}) => ({
  id: "goal", projectId: "rehearsal", title: "Goal", objective: "Improve it", successCriteria: "Measured", nonGoals: [], allowedPaths: ["."],
  evidence: [], maxRuns: 3, maxMinutes: 60, maxMembers: 24, parallelism: 3, revision: 1, status: "running",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", deadlineAt: "2026-01-01T01:00:00.000Z",
  cycles: [], memberCount: 1, steering: [], events: [], outcomes: [], activeTeamId: "team", ...overrides,
}) as ProductGoal;

test("phone team controls follow the documented roles and goal ownership", () => {
  assert.deepEqual(teamControls(team(), "owner", true), { answer: true, steer: true, pause: true, resume: false, cancel: true });
  assert.deepEqual(teamControls(team(), "controller", true), { answer: true, steer: true, pause: false, resume: false, cancel: false });
  assert.deepEqual(teamControls(team(), "viewer", true), { answer: false, steer: false, pause: false, resume: false, cancel: false });
  assert.deepEqual(teamControls(team({ goal: { id: "goal", revision: 1, cycle: 1 } }), "owner", true), { answer: true, steer: false, pause: false, resume: false, cancel: false });
  assert.deepEqual(teamControls(team({ missionId: "mission", status: "blocked", resumable: true }), "owner", true), { answer: false, steer: false, pause: false, resume: false, cancel: true });
  assert.deepEqual(teamControls(team(), "owner", false), { answer: false, steer: false, pause: false, resume: false, cancel: false });
  assert.deepEqual(teamControls(team({ status: "paused" }), "owner", true), { answer: false, steer: true, pause: false, resume: true, cancel: true });
  assert.deepEqual(teamControls(team({ status: "blocked", resumable: true }), "owner", true), { answer: true, steer: true, pause: false, resume: true, cancel: true });
  assert.equal(teamControls(team({ status: "blocked", resumable: true }), "controller", true).resume, false);
  assert.deepEqual(teamControls(team({ status: "delivering" }), "owner", true), { answer: true, steer: false, pause: true, resume: false, cancel: true });
  assert.deepEqual(teamControls(team({ status: "merged" }), "owner", true), { answer: true, steer: false, pause: false, resume: false, cancel: true });
  const receipt = { revision: 2, headCommit: "a".repeat(40), pullRequestUrl: "https://github.com/owner/repo/pull/12", mergeCommit: "b".repeat(40), summary: "Merged", reportedAt: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(teamControls(team({ status: "paused", deliveryReceipt: receipt }), "owner", true), { answer: false, steer: false, pause: false, resume: false, cancel: true });
  assert.deepEqual(teamControls(team({ status: "blocked", deliveryReceipt: receipt }), "owner", true), { answer: true, steer: false, pause: false, resume: false, cancel: true });
  for (const status of ["blocked", "ready-for-review", "no-change"] as const) assert.equal(teamControls(team({ status }), "owner", true).pause, false, status);
  assert.deepEqual(teamControls(team({ status: "cancelled" }), "owner", true), { answer: false, steer: false, pause: false, resume: false, cancel: false });
});

test("an owner may cancel a blocked goal or mission run only while the view is fresh", () => {
  const goalRun = { id: "goal", revision: 1, cycle: 1 };
  assert.equal(teamControls(team({ status: "blocked", goal: goalRun }), "owner", true).cancel, true);
  assert.equal(teamControls(team({ status: "implementing", goal: goalRun }), "owner", true).cancel, false);
  assert.equal(teamControls(team({ status: "blocked", goal: goalRun }), "controller", true).cancel, false);
  assert.equal(teamControls(team({ status: "blocked", goal: goalRun }), "owner", false).cancel, false);
  assert.equal(teamControls(team({ status: "blocked", missionId: "mission" }), "owner", true).cancel, true);
  assert.equal(teamControls(team({ status: "blocked", missionId: "mission" }), "viewer", true).cancel, false);
  assert.equal(teamControls(team({ status: "blocked" }), "owner", true).cancel, true);
});

test("phone worker status reports live capacity and waiting ready tasks", () => {
  assert.equal(workerStatus(team({ parallelism: 3 })), "Up to 3 workers");
  assert.equal(workerStatus(team({ workers: { limit: 2, max: 4, running: 1, ready: 1 } })), "1 of 2 workers running");
  assert.equal(workerStatus(team({ workers: { limit: 2, max: 4, running: 2, ready: 0 } })), "2 of 2 workers running");
  assert.equal(workerStatus(team({ workers: { limit: 2, max: 4, running: 2, ready: 1 } })), "2 of 2 workers running · 1 ready task waiting for a worker");
  assert.equal(workerStatus(team({ workers: { limit: 2, max: 4, running: 2, ready: 3 } })), "2 of 2 workers running · 3 ready tasks waiting for a worker");
});

test("phone goal controls allow an outcome only after the goal has stopped", () => {
  const beforeDeadline = Date.parse("2026-01-01T00:30:00.000Z");
  assert.deepEqual(goalControls(goal(), "owner", true), { steer: true, pause: true, resume: false, cancel: true, outcome: false });
  assert.deepEqual(goalControls(goal(), "controller", true), { steer: true, pause: false, resume: false, cancel: false, outcome: false });
  assert.deepEqual(goalControls(goal({ status: "paused" }), "owner", true, beforeDeadline), { steer: false, pause: false, resume: true, cancel: true, outcome: false });
  assert.equal(goalControls(goal({ status: "paused" }), "owner", true, Date.parse("2026-01-01T01:00:00.000Z")).resume, false);
  assert.equal(goalControls(goal({ status: "cancelled" }), "owner", true).outcome, false);
  assert.deepEqual(goalControls(goal({ status: "ready-for-review", activeTeamId: undefined }), "controller", true), { steer: false, pause: false, resume: false, cancel: false, outcome: true });
  assert.equal(goalControls(goal({ status: "ready-for-review", activeTeamId: undefined }), "viewer", true).outcome, false);
});

test("a late poll cannot replace a newer recorded revision, and only current questions are open", () => {
  const recorded = team({ revision: 3, updatedAt: "2026-01-01T00:02:00.000Z" });
  assert.equal(newer(recorded, team()), recorded);
  const later = team({ revision: 3, updatedAt: "2026-01-01T00:03:00.000Z" });
  assert.equal(newer(recorded, later), later);
  assert.equal(newer(null, recorded), recorded);
  const decisions = [
    { id: "old", memberId: "m", revision: 1, question: "Earlier?", options: [], createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "answered", memberId: "m", revision: 2, question: "Done?", options: [], createdAt: "2026-01-01T00:00:00.000Z", answer: "Yes" },
    { id: "open", memberId: "m", revision: 2, question: "Which?", options: ["A"], createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.deepEqual(openDecisions(team({ decisions })).map(decision => decision.id), ["open"]);
});

test("an unconfirmed run request stays pending for an identical retry until the host answers it", () => {
  const key = "machine/team/run";
  const first = runRequests.begin(key, { requestId: "first", revision: 2, path: "/teams/run/steer", label: "Direction", fields: { text: "Keep the layout" } });
  assert.equal(runRequests.begin(key, { requestId: "second", revision: 3, path: "/teams/run/pause", label: "Pause", fields: {} }), first);
  runRequests.fail(key, "first", "The host did not respond.");
  assert.equal(runRequests.read(key).pending, first);
  assert.equal(runRequests.complete(key, "second", { id: "run" }), false);
  assert.equal(runRequests.read(key).pending, first);
  assert.equal(runRequests.complete(key, "first", { id: "run" }, "Direction recorded"), true);
  assert.equal(runRequests.read(key).pending, undefined);
  runRequests.begin(key, { requestId: "third", revision: 3, path: "/teams/run/pause", label: "Pause", fields: {} });
  runRequests.fail(key, "third", "This team is not running and cannot be paused.", true);
  assert.equal(runRequests.read(key).pending, undefined);
  runRequests.clearMachine("machine");
});

const task = (id: string, status: TeamTask["status"], dependsOn: string[] = []) => ({ id, title: id, instructions: "", paths: [], dependsOn, status }) as TeamTask;
const question = { id: "q", memberId: "m", revision: 2, question: "Which?", options: [], createdAt: "2026-01-01T00:00:00.000Z" };

test("phone run lists put work waiting on a person first and fold stopped runs together", () => {
  assert.equal(teamGroup(team({ status: "needs-input" })), "attention");
  assert.equal(teamGroup(team({ status: "blocked" })), "attention");
  assert.equal(teamGroup(team({ decisions: [question] })), "attention");
  assert.equal(teamGroup(team({ status: "cancelled", decisions: [question] })), "closed");
  assert.equal(teamGroup(team({ status: "no-change" })), "closed");
  assert.equal(teamGroup(team({ status: "merged" })), "review");
  assert.equal(teamGroup(team({ status: "paused" })), "active");
  assert.equal(goalGroup(goal({ status: "limit-reached" })), "attention");
  assert.equal(goalGroup(goal({ status: "achieved" })), "closed");
  const runs = [team({ id: "a", status: "cancelled" }), team({ id: "b" }), team({ id: "c", status: "needs-input" }), team({ id: "d" })];
  assert.deepEqual(groupRuns(runs, teamGroup).map(group => [group.group, group.items.map(item => item.id)]), [["attention", ["c"]], ["active", ["b", "d"]], ["closed", ["a"]]]);
});

test("blocked team runs lead the list stably and only eligible owners can resume them", () => {
  const runs = [team({ id: "active-1" }), team({ id: "blocked-1", status: "blocked" }), team({ id: "closed", status: "cancelled" }), team({ id: "blocked-2", status: "blocked" })];
  assert.deepEqual(blockedTeamsFirst(runs).map(item => item.id), ["blocked-1", "blocked-2", "active-1", "closed"]);
  const eligible = team({ status: "blocked", resumable: true });
  assert.equal(canResumeBlockedTeam(eligible, "owner"), true);
  assert.equal(canResumeBlockedTeam(eligible, "controller"), false);
  assert.equal(canResumeBlockedTeam(team({ ...eligible, goal: { id: "goal", revision: 1, cycle: 1 } }), "owner"), false);
  assert.equal(canResumeBlockedTeam(team({ ...eligible, deliveryReceipt: { revision: 2, headCommit: "head", pullRequestUrl: "https://example.com/pr", mergeCommit: "merge", summary: "Reported", reportedAt: "2026-01-01T00:00:00.000Z" } }), "owner"), false);
  assert.equal(canResumeBlockedTeam(team({ status: "blocked" }), "owner"), false);
  const continuable = team({ status: "blocked", resumable: true, continuable: true });
  assert.equal(canContinueBlockedTeam(continuable, "owner"), true);
  assert.equal(canContinueBlockedTeam(continuable, "controller"), false);
  assert.equal(canContinueBlockedTeam(continuable, "viewer"), false);
  assert.equal(canContinueBlockedTeam(team({ ...continuable, status: "implementing" }), "owner"), false);
  assert.equal(canContinueBlockedTeam(team({ ...continuable, goal: { id: "goal", revision: 1, cycle: 1 } }), "owner"), false);
  assert.equal(canContinueBlockedTeam(team({ ...continuable, missionId: "mission" }), "owner"), false);
  assert.equal(canContinueBlockedTeam(team({ ...continuable, deliveryReceipt: { revision: 2, headCommit: "head", pullRequestUrl: "https://example.com/pr", mergeCommit: "merge", summary: "Reported", reportedAt: "2026-01-01T00:00:00.000Z" } }), "owner"), false);
  assert.equal(canContinueBlockedTeam(team({ ...continuable, pullRequest: { revision: 2, headCommit: "head", pullRequestUrl: "https://example.com/pr", summary: "Open", reportedAt: "2026-01-01T00:00:00.000Z" } }), "owner"), false);
  assert.equal(canResumeBlockedTeam(continuable, "owner"), false);
  assert.equal(teamControls(continuable, "owner", true).resume, false);
  assert.equal(teamControls(continuable, "owner", true).steer, false);
});

test("phone status icons show plan progress without reading a full ring as completion", () => {
  assert.deepEqual(teamKind(team({ tasks: [task("t1", "integrated"), task("t2", "integrated"), task("t3", "running"), task("t4", "pending")] })), { kind: "progress", fraction: 0.5 });
  assert.deepEqual(teamKind(team({ status: "planning" })), { kind: "progress", fraction: 0.25 });
  assert.equal(teamKind(team({ status: "ready-for-review" })).kind, "review");
  assert.equal(teamKind(team({ missionId: "mission", status: "needs-input" })).kind, "progress");
  assert.equal(teamKind(team({ missionId: "mission", status: "needs-input" }), 1).kind, "attention");
  assert.equal(teamKind(team({ status: "paused", decisions: [question] })).kind, "paused");
  assert.equal(teamKind(team({ decisions: [question] })).kind, "attention");
  const tasks = [task("t1", "integrated"), task("t2", "pending", ["t1"]), task("t3", "pending", ["t2"]), task("t4", "waiting")];
  assert.deepEqual(tasks.map(item => taskKind(item, tasks)), ["done", "todo", "backlog", "paused"]);
});

test("phone avatars and ages stay short and stable", () => {
  assert.equal(initials("Opus 5.5 xhigh"), "O5");
  assert.equal(initials("DeepSeek V4.1 Flash high"), "DS");
  assert.equal(initials("Muse Spark 1.3 Contributor"), "MS");
  assert.equal(initials("Codex"), "Co");
  assert.equal(initials("  "), "?");
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  assert.equal(age("2026-01-01T11:59:30.000Z", now), "now");
  assert.equal(age("2026-01-01T11:15:00.000Z", now), "45m");
  assert.equal(age("2026-01-01T09:00:00.000Z", now), "3h");
  assert.equal(age("2025-12-30T12:00:00.000Z", now), "2d");
  assert.equal(age("not a date", now), "");
});

const member = (memberId: string, status = "running") => ({ memberId, sessionId: `s-${memberId}`, role: "implementer", revision: 2, title: memberId, status }) as TeamMember;
const waiting = (memberId: string, prompt: { id: number; kind: string; destructive?: unknown; multiSelect?: boolean; delegable?: boolean }) => ({ id: `s-${memberId}`, attention: { state: "needs-you", prompt } });
const decided = (memberId: string, promptId: number, status: PermissionDecision["status"]) =>
  ({ id: `d-${memberId}-${promptId}`, revision: 2, targetMemberId: memberId, targetSessionId: `s-${memberId}`, promptId, expiresAt: "2026-01-01T00:05:00.000Z", status }) as PermissionDecision;
const lineup = (tier?: "light" | "strong") => ({ coordinator: { id: "pm", label: "Coordinator", provider: "codex", model: "gpt", tier }, integrator: { id: "int", label: "Integrator", provider: "codex", model: "gpt" }, reviewer: { id: "rev", label: "Reviewer", provider: "codex", model: "gpt" }, implementers: [] });
const delegated = { permissions: { mode: "coordinator" as const, scope: "Read access", maxDecisions: 3 }, lineup: lineup("strong") };

test("agent prompts reach a person only when the coordinator cannot or did not decide them", () => {
  const permission = { id: 7, kind: "permission", delegable: true };
  assert.equal(approvalOwner(team(), "s-a", permission), "person");
  assert.equal(approvalOwner(team(delegated), "s-a", permission), "coordinator");
  assert.equal(approvalOwner(team({ ...delegated, permissionDecisions: [decided("a", 7, "reviewing")] }), "s-a", permission), "coordinator");
  assert.equal(approvalOwner(team({ ...delegated, permissionDecisions: [decided("a", 7, "escalated")] }), "s-a", permission), "person");
  assert.equal(approvalOwner(team({ ...delegated, permissionDecisions: [decided("a", 7, "stale")] }), "s-a", permission), "person");
  assert.equal(approvalOwner(team({ ...delegated, permissionDecisions: [decided("a", 6, "answered")] }), "s-a", permission), "coordinator");
  assert.equal(approvalOwner(team(delegated), "s-a", { id: 7, kind: "question", delegable: true }), "person");
  assert.equal(approvalOwner(team(delegated), "s-a", { id: 7, kind: "permission", delegable: true, destructive: { pattern: "rm-rf" } }), "person");
  assert.equal(approvalOwner(team(delegated), "s-a", { id: 7, kind: "permission", delegable: true, multiSelect: true }), "person");
  assert.equal(approvalOwner(team({ ...delegated, permissionsRevokedAt: "2026-01-01T00:00:00.000Z" }), "s-a", permission), "person");
  const spent = ["x", "y", "z"].map((id, index) => decided(id, index, "answered"));
  assert.equal(approvalOwner(team({ ...delegated, permissionDecisions: spent }), "s-a", permission), "person");
  assert.equal(approvalOwner(team(delegated), "s-a", { id: 7, kind: "permission" }), "person");
  assert.equal(approvalOwner(team({ ...delegated, lineup: lineup("light") }), "s-a", permission), "person");
  assert.equal(approvalOwner(team({ permissions: delegated.permissions }), "s-a", permission), "person");

  const run = team({ ...delegated, members: [member("a"), member("b"), member("c", "stopped"), { ...member("d"), revision: 1 }], permissionDecisions: [decided("b", 9, "escalated")] });
  const sessions = [waiting("a", permission), waiting("b", { id: 9, kind: "permission", delegable: true }), waiting("c", { id: 1, kind: "question" }), waiting("d", { id: 2, kind: "question" })];
  assert.deepEqual(pendingApprovals(run, sessions).map(item => item.member.memberId), ["b"]);
  assert.equal(teamGroup(run, 1), "attention");
  assert.equal(teamKind(run, 1).kind, "attention");
  assert.equal(teamGroup(team({ status: "cancelled" }), 1), "closed");
});

test("the coordinator card's phase track follows the recorded work, with delivery only when configured", () => {
  const states = (run: TeamView) => teamPhases(run).map(phase => `${phase.label}:${phase.state}`).join(" ");
  assert.equal(states(team({ status: "planning" })), "Plan:current Build:todo Integrate:todo Check:todo Review:todo");
  assert.equal(states(team({ status: "verifying", tasks: [task("t1", "integrated")] })), "Plan:done Build:done Integrate:done Check:current Review:todo");
  assert.equal(states(team({ status: "needs-input", tasks: [task("t1", "integrated"), task("t2", "running")] })), "Plan:done Build:current Integrate:todo Check:todo Review:todo");
  const review = { verdict: "approved" as const, summary: "Looks right", revision: 2 };
  assert.equal(states(team({ status: "ready-for-review", review })), "Plan:done Build:done Integrate:done Check:done Review:done");
  const delivery = { mode: "merge" as const, repository: "owner/app", baseBranch: "main" };
  assert.equal(states(team({ status: "delivering", review, delivery })), "Plan:done Build:done Integrate:done Check:done Review:done Deliver:current");
  assert.equal(states(team({ status: "merged", review, delivery })), "Plan:done Build:done Integrate:done Check:done Review:done Deliver:done");
});
