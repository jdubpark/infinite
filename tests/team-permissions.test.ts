import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimControl, waitFor } from "./helpers.js";
import { fixture, limitLineup } from "./team-fixture.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";
import { refusedBeforeSend } from "../packages/host/src/team-permissions.js";
import { ContentError } from "../packages/host/src/session-content.js";

const permissionLineup: TeamLineup = {
  ...limitLineup,
  coordinator: { ...limitLineup.coordinator, id: "claude-coordinator", label: "Claude coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

test("only a preflight or named worker refusal counts as an answer that sent nothing", () => {
  assert.equal(refusedBeforeSend(new ContentError("The assigned team member has no running managed terminal")), true);
  for (const code of ["prompt-changed", "control-busy", "control-lost"])
    assert.equal(refusedBeforeSend(Object.assign(new Error(code), { code })), true, code);
  // A socket error can follow a delivered key, like a lost acknowledgement.
  for (const code of ["ECONNRESET", "EPIPE", undefined])
    assert.equal(refusedBeforeSend(Object.assign(new Error("Worker connection failed"), { code })), false, String(code));
});

test("an explicit permission policy reviews and answers only the recorded one-shot prompt", { timeout: 120000 }, async () => {
  const f = await fixture("permissions", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const answered = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.some(decision => decision.status === "answered"), 60000);
    const decision = answered.permissionDecisions[0];
    assert.equal(decision.status, "answered");
    assert.equal(decision.receipt?.state, "delivered");
    assert.equal(decision.receipt?.result, "closed");
    assert.equal("prompt" in decision, false, "raw provider prompt evidence stays in sealed team state");
    const coordinator = answered.members.find(member => member.memberId === decision.coordinatorMemberId);
    assert.equal(coordinator?.role, "permission-coordinator");
    assert.ok(coordinator);
    const setup = readFileSync(join(f.receipts, "permission-setup.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(setup.some((entry: { cwd: string }) => entry.cwd === coordinator.cwd), false, "the read-only permission clone skips project setup");
    const finished = await f.settled(created.body.id);
    const runtime = await Promise.all(finished.members.map(async member => ({
      memberId: member.memberId, role: member.role, session: member.sessionId,
      state: (await f.host.fetchApi(`/sessions/${member.sessionId}`)).body,
    })));
    assert.equal(finished.status, "ready-for-review", JSON.stringify({ run: finished, runtime }));
  } finally { await f.close(); }
});

test("a Codex permission review preserves a large objective and complete request evidence", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex", permissionLineup);
  try {
    const objective = `Create independent files. ${"Keep the assigned scope. ".repeat(800)}Verify their integrated contents.`;
    const created = await f.host.fetchApi("/teams", "owner", { ...f.create(), objective });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const reviewing = await waitFor(() => f.get(created.body.id), run =>
      run.permissionDecisions?.some(decision => decision.status === "escalated") ||
      run.permissionDecisions?.some(decision => decision.status === "reviewing") &&
        existsSync(join(f.receipts, `${run.id}.judge-ready`)) &&
        existsSync(join(f.receipts, `${run.id}.permission-feedback.json`)), 60000);
    assert.equal(reviewing.permissionDecisions[0].status, "reviewing", reviewing.permissionDecisions[0].reason);
    const coordinator = reviewing.members.find(member => member.memberId === reviewing.permissionDecisions[0].coordinatorMemberId)!;
    const launchPrompt = JSON.parse(readFileSync(join(f.receipts, `${coordinator.memberId}.json`), "utf8")).argv.at(-1) as string;
    assert.equal(launchPrompt.split(objective).length, 2, "the complete owner objective reaches the reviewer once");
    assert.equal(launchPrompt.split(reviewing.permissions!.scope).length, 2, "the pinned scope reaches the reviewer once");
    const feedbackText = readFileSync(join(f.receipts, `${reviewing.id}.permission-feedback.json`), "utf8");
    assert.equal(launchPrompt.split(feedbackText).length, 2, "the complete request evidence reaches the reviewer once");
    const feedback = JSON.parse(feedbackText);
    const target = reviewing.members.find(member => member.memberId === reviewing.permissionDecisions[0].targetMemberId)!;
    assert.deepEqual(feedback.prompt, (await f.host.fetchApi(`/sessions/${target.sessionId}`)).body.attention.prompt);
    assert.equal(feedback.targetTask.instructions, reviewing.tasks.find(task => task.id === target.taskId)!.instructions);
    // While the coordinator reviews, the run does not tell the person to answer the prompt.
    await waitFor(() => f.get(reviewing.id), run => run.reason === "The permission coordinator is reviewing a provider request.", 10000);
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });

    const answered = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "answered", 30000);
    assert.equal(answered.permissionDecisions[0].receipt?.state, "delivered");
    assert.equal(answered.permissionDecisions[0].receipt?.result, "closed");
    assert.ok(feedback.targetChangedPaths.includes("a.txt"), JSON.stringify(feedback.targetChangedPaths));
    assert.equal(feedback.targetChangedPathCount, feedback.targetChangedPaths.length);
    assert.deepEqual(feedback.acceptedChecks, [{ command: process.execPath, args: ["check.mjs"] }]);
  } finally { await f.close(); }
});

test("permission evidence exceeding the full UTF-8 prompt budget escalates without launching a reviewer", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex", permissionLineup);
  try {
    const project = await f.host.fetchApi("/projects/rehearsal/team", "owner");
    const configured = await f.host.fetchApi("/projects/rehearsal/team", "owner", {
      requestId: randomUUID(), revision: project.body.revision,
      team: { ...project.body.team, permissions: { ...project.body.team.permissions, scope: "界".repeat(4000) } },
    }, {}, "PUT");
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    const created = await f.host.fetchApi("/teams", "owner", { ...f.create(), objective: "界".repeat(23000) });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const escalated = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.[0]?.status === "escalated", 60000);
    assert.match(escalated.permissionDecisions[0].reason ?? "", /evidence exceeds.*prompt limit.*without truncation/);
    assert.equal(escalated.permissionDecisions[0].receipt, undefined);
    assert.equal(escalated.members.some(member => member.role === "permission-coordinator"), false);
    assert.notEqual(escalated.status, "blocked");
    const target = escalated.members.find(member => member.memberId === escalated.permissionDecisions[0].targetMemberId)!;
    assert.equal((await f.host.fetchApi(`/sessions/${target.sessionId}`)).body.attention.state, "needs-you");
  } finally { await f.close(); }
});

test("a Codex command redrawn with different spacing is not answered with the reviewed approval", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex-respace", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const reviewing = await waitFor(() => f.get(created.body.id), run =>
      run.permissionDecisions?.some(decision => decision.status === "reviewing") &&
      existsSync(join(f.receipts, `${run.id}.judge-ready`)) && existsSync(join(f.receipts, `${run.id}.target-ready`)), 60000);
    const target = reviewing.members.find(member => member.memberId === reviewing.permissionDecisions[0].targetMemberId)!;
    writeFileSync(join(f.receipts, `${reviewing.id}.target-change`), "change", { mode: 0o600 });
    await waitFor(async () => (await f.host.fetchApi(`/sessions/${target.sessionId}`)).body.screen ?? "", screen => screen.includes("$ npm run  check"), 10000);
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    const escalated = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.equal(escalated.permissionDecisions[0].receipt, undefined);
    assert.match(escalated.permissionDecisions[0].reason ?? "", /nothing was sent/);
    assert.equal(escalated.permissionDecisions.length, 1, "the redrawn prompt keeps its identity and stays with the user");
  } finally { await f.close(); }
});

test("a Codex command redrawn while the answer is in progress receives no Enter", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex-midway", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const reviewing = await waitFor(() => f.get(created.body.id), run =>
      run.permissionDecisions?.some(decision => decision.status === "reviewing") && existsSync(join(f.receipts, `${run.id}.judge-ready`)), 60000);
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    // Arrow keys reached the dialog before it changed, so the host cannot say nothing was sent.
    const uncertain = await waitFor(() => f.get(reviewing.id), run => !["pending", "reviewing", "approved", "answering"].includes(run.permissionDecisions?.[0]?.status ?? "pending"), 30000);
    assert.equal(uncertain.permissionDecisions[0].status, "uncertain", JSON.stringify(uncertain.permissionDecisions[0]));
    assert.equal(uncertain.permissionDecisions[0].receipt?.state, "uncertain");
    assert.equal(existsSync(join(f.receipts, `${reviewing.id}.enter`)), false, "the changed command must not be confirmed");
  } finally { await f.close(); }
});

test("an approved permission shown as a yes-no line stays with the user without a key", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-yesno", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const decided = await waitFor(() => f.get(created.body.id), run => ["escalated", "uncertain", "answered"].includes(run.permissionDecisions?.[0]?.status ?? ""), 60000);
    const decision = decided.permissionDecisions[0];
    assert.equal(decision.status, "escalated", JSON.stringify(decision));
    assert.match(decision.reason ?? "", /nothing was sent/);
    const target = decided.members.find(member => member.memberId === decision.targetMemberId)!;
    assert.match((await f.host.fetchApi(`/sessions/${target.sessionId}`)).body.screen, /Run this command\? \[Y\/n\] *$/m);
  } finally { await f.close(); }
});

test("a missing pinned coordinator provider records an escalation", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex-profile-missing", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const waiting = await waitFor(() => f.get(created.body.id), run =>
      run.members.some(member => member.role === "implementer" && member.taskId === "a") &&
      existsSync(join(f.receipts, `${run.id}.target-ready`)), 60000);

    await f.host.stopApi();
    delete f.host.config.agents.claude;
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    writeFileSync(join(f.receipts, `${waiting.id}.target-release`), "release", { mode: 0o600 });

    const escalated = await waitFor(() => f.get(waiting.id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.match(escalated.permissionDecisions[0].reason ?? "", /pinned permission coordinator provider is not configured/i);
    assert.equal(escalated.members.some(member => member.role === "permission-coordinator"), false);
  } finally { await f.close(); }
});

test("an unresolved target workspace records an escalation", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex-realpath", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const waiting = await waitFor(() => f.get(created.body.id), run =>
      run.members.some(member => member.role === "implementer" && member.taskId === "a") &&
      existsSync(join(f.receipts, `${run.id}.target-ready`)), 60000);
    const target = waiting.members.find(member => member.role === "implementer" && member.taskId === "a")!;
    const receipt = JSON.parse(readFileSync(join(f.receipts, `${target.memberId}.json`), "utf8"));
    const movedWorkspace = `${receipt.cwd}.moved`;
    renameSync(receipt.cwd, movedWorkspace);
    writeFileSync(join(f.receipts, `${waiting.id}.target-release`), "release", { mode: 0o600 });

    const escalated = await waitFor(() => f.get(waiting.id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.match(escalated.permissionDecisions[0].reason ?? "", /workspace could not be resolved/i);
  } finally { await f.close(); }
});

test("a screen permission prompt remains with the user when the project did not opt in", { timeout: 90000 }, async () => {
  const f = await fixture("permissions-off", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const waiting = await waitFor(async () => {
      const run = await f.get(created.body.id);
      const target = run.members.find(member => member.role === "implementer" && member.taskId === "a");
      if (!target) return { run, prompt: undefined };
      const session = await f.host.fetchApi(`/sessions/${target.sessionId}`);
      return { run, prompt: session.body.attention?.prompt };
    }, value => value.prompt?.kind === "permission" && Boolean(value.prompt.hash), 45000);
    assert.equal(waiting.run.permissions, undefined);
    assert.equal(waiting.run.permissionDecisions?.length ?? 0, 0);
    assert.equal(waiting.run.members.some(member => member.role === "permission-coordinator"), false);
  } finally { await f.close(); }
});

test("an unqualified permission coordinator records escalation without launching an interactive judge", { timeout: 90000 }, async () => {
  const f = await fixture("permissions-unqualified", limitLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const escalated = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.[0]?.status === "escalated", 45000);
    assert.match(escalated.permissionDecisions[0].reason ?? "", /not qualified/i);
    assert.equal(escalated.members.some(member => member.role === "permission-coordinator"), false);
    const target = escalated.members.find(member => member.memberId === escalated.permissionDecisions[0].targetMemberId)!;
    const session = await f.host.fetchApi(`/sessions/${target.sessionId}`);
    assert.equal(session.body.attention?.state, "needs-you");
  } finally { await f.close(); }
});

test("an unsafe pinned coordinator launch profile escalates without blocking the team", { timeout: 90000 }, async () => {
  const f = await fixture("permissions-launch-invalid", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const escalated = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.[0]?.status === "escalated", 45000);
    assert.match(escalated.permissionDecisions[0].reason ?? "", /dangerously-skip-permissions/i);
    assert.notEqual(escalated.status, "blocked");
    assert.equal(escalated.members.some(member => member.role === "permission-coordinator"), false);
    const target = escalated.members.find(member => member.memberId === escalated.permissionDecisions[0].targetMemberId)!;
    const session = await f.host.fetchApi(`/sessions/${target.sessionId}`);
    assert.equal(session.body.attention?.state, "needs-you");
  } finally { await f.close(); }
});

test("an explicit escalation or a foreign decision report never answers the target prompt", { timeout: 120000 }, async () => {
  for (const scenario of ["permissions-escalate", "permissions-foreign"]) {
    const f = await fixture(scenario, permissionLineup);
    try {
      const created = await f.host.fetchApi("/teams", "owner", f.create());
      const reviewing = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") && existsSync(join(f.receipts, `${run.id}.judge-ready`)), 45000);
      writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
      const escalated = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
      assert.equal(escalated.permissionDecisions[0].receipt, undefined);
      const target = escalated.members.find(member => member.memberId === escalated.permissionDecisions[0].targetMemberId)!;
      const session = await f.host.fetchApi(`/sessions/${target.sessionId}`);
      assert.equal(session.body.attention?.state, "needs-you");
    } finally { await f.close(); }
  }
});

test("a permission coordinator that exits without a report escalates only its request", { timeout: 90000 }, async () => {
  const f = await fixture("permissions-judge-exit", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const escalated = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.[0]?.status === "escalated", 60000);
    assert.notEqual(escalated.status, "blocked");
    assert.equal(escalated.permissionDecisions[0].receipt, undefined);
    const target = escalated.members.find(member => member.memberId === escalated.permissionDecisions[0].targetMemberId)!;
    const session = await f.host.fetchApi(`/sessions/${target.sessionId}`);
    assert.equal(session.body.attention?.state, "needs-you");
  } finally { await f.close(); }
});

test("revocation invalidates a reviewing decision before its coordinator report can answer", { timeout: 90000 }, async () => {
  const f = await fixture("permissions-revoke", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const reviewing = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") && existsSync(join(f.receipts, `${run.id}.judge-ready`)), 45000);
    const revoked = await f.host.fetchApi(`/teams/${reviewing.id}/permissions/revoke`, "owner", { requestId: randomUUID(), revision: reviewing.revision });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    const settled = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "stale", 30000);
    assert.ok(settled.permissionsRevokedAt);
    assert.equal(settled.permissionDecisions[0].receipt, undefined);
  } finally { await f.close(); }
});

test("an active run keeps its pinned permission policy until enrollment can change", { timeout: 90000 }, async () => {
  const f = await fixture("permissions-future-policy", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const reviewing = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") && existsSync(join(f.receipts, `${run.id}.judge-ready`)), 45000);
    const configured = await f.host.fetchApi("/projects/rehearsal/team", "owner");
    const updated = await f.host.fetchApi("/projects/rehearsal/team", "owner", {
      requestId: randomUUID(), revision: configured.body.revision,
      team: { ...configured.body.team, permissions: { ...configured.body.team.permissions, scope: "Future runs may inspect this project without delegated provider approval." } },
    }, {}, "PUT");
    assert.equal(updated.status, 409, JSON.stringify(updated.body));
    assert.equal(updated.body.code, "project-busy");
    assert.equal((await f.host.fetchApi("/projects/rehearsal/team", "owner")).body.team.permissions.scope,
      "Approve only read access needed to inspect this project for the stated objective.");
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    const answered = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "answered", 30000);
    assert.equal(answered.permissionDecisions[0].policyHash, reviewing.permissionDecisions[0].policyHash);
    assert.equal(answered.permissionDecisions[0].receipt?.result, "closed");
    const settled = await f.settled(reviewing.id);
    const nowConfigured = await f.host.fetchApi("/projects/rehearsal/team", "owner");
    const changedAfterRun = await f.host.fetchApi("/projects/rehearsal/team", "owner", {
      requestId: randomUUID(), revision: nowConfigured.body.revision,
      team: { ...nowConfigured.body.team, permissions: { ...nowConfigured.body.team.permissions, scope: "Future runs may inspect this project without delegated provider approval." } },
    }, {}, "PUT");
    assert.equal(changedAfterRun.status, 200, JSON.stringify(changedAfterRun.body));
    assert.match(changedAfterRun.body.team.permissions.scope, /Future runs/);
    assert.equal((await f.get(settled.id)).permissions?.scope,
      "Approve only read access needed to inspect this project for the stated objective.");
  } finally { await f.close(); }
});

test("a human control lease prevents a permission coordinator from applying its recommendation", { timeout: 90000 }, async () => {
  const f = await fixture("permissions-lease", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const reviewing = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") && existsSync(join(f.receipts, `${run.id}.judge-ready`)), 45000);
    const target = reviewing.members.find(member => member.memberId === reviewing.permissionDecisions[0].targetMemberId)!;
    const control = await claimControl(f.host, target.sessionId, "controller");
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    const escalated = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.equal(escalated.permissionDecisions[0].receipt, undefined);
    await f.host.fetchApi(`/sessions/${target.sessionId}/control`, "controller", { action: "release", leaseId: control.lease.id }, control.headers);
  } finally { await f.close(); }
});

test("a changed target prompt makes a pending approval ineligible", { timeout: 90000 }, async () => {
  const f = await fixture("permissions-stale", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const reviewing = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.some(decision => decision.status === "reviewing") && existsSync(join(f.receipts, `${run.id}.judge-ready`)) && existsSync(join(f.receipts, `${run.id}.target-ready`)), 45000);
    writeFileSync(join(f.receipts, `${reviewing.id}.target-change`), "change", { mode: 0o600 });
    const target = reviewing.members.find(member => member.memberId === reviewing.permissionDecisions[0].targetMemberId)!;
    await waitFor(async () => (await f.host.fetchApi(`/sessions/${target.sessionId}`)).body.attention?.prompt, prompt => prompt === undefined, 10000);
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    const escalated = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.equal(escalated.permissionDecisions[0].receipt, undefined);
  } finally { await f.close(); }
});

test("an answering decision is recovered as uncertain after an API restart", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-restart", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const answering = await waitFor(() => f.get(created.body.id), run => run.permissionDecisions?.some(decision => decision.status === "answering"), 60000);
    await f.host.stopApi();
    await f.host.start();
    const recovered = await waitFor(() => f.get(answering.id), run => run.permissionDecisions?.[0]?.status === "uncertain", 10000);
    assert.equal(recovered.permissionDecisions[0].receipt, undefined);
    assert.equal(recovered.status, "blocked", "the in-flight operation remains subject to existing restart reconciliation");
  } finally { await f.close(); }
});

test("a cancelled team with an unresolved verification operation stays cancelled after restart", { timeout: 90000 }, async () => {
  const f = await fixture("lifecycle");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const checking = await waitFor(() => f.get(created.body.id), run => run.status === "verifying" && run.checks.some(check => check.status === "running"), 30000);
    const cancelled = await f.host.fetchApi(`/teams/${checking.id}/cancel`, "owner", { requestId: randomUUID(), revision: checking.revision });
    assert.equal(cancelled.status, 200);
    await f.host.stopApi();
    await f.host.start();
    const recovered = await f.get(checking.id);
    assert.equal(recovered.status, "cancelled");
    assert.ok(recovered.checks.some(check => check.status === "interrupted"));
    assert.equal((await f.host.fetchApi("/teams")).body.teams.find((team: { id: string }) => team.id === checking.id).status, "cancelled");
  } finally { await f.close(); }
});
