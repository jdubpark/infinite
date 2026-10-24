import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { claimControl, waitFor } from "./helpers.js";
import { fixture, git, limitLineup } from "./team-fixture.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";
import { refusedBeforeSend } from "../packages/host/src/team-permissions.js";
import { permissionEvidenceDigest } from "../packages/host/src/team-permission-evidence.js";
import { ContentError } from "../packages/host/src/session-content.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";

const permissionLineup: TeamLineup = {
  ...limitLineup,
  coordinator: { ...limitLineup.coordinator, id: "claude-coordinator", label: "Claude coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

function addInspectableCheckPackage(f: Awaited<ReturnType<typeof fixture>>) {
  const source = f.host.config.projects.find(project => project.id === "rehearsal")!.path;
  const packageManifest = `${JSON.stringify({ scripts: { check: "node check.mjs" } }, null, 2)}\n`;
  writeFileSync(join(source, "package.json"), packageManifest);
  git(source, "add", "package.json");
  git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "commit", "-m", "Add inspectable check script");
  return { packageManifest, checkSource: readFileSync(join(source, "check.mjs"), "utf8") };
}

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
    const inspectable = addInspectableCheckPackage(f);
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
    const permissionEvidence = feedback.permissionEvidence as { files: Array<{ path: string; content: string; sha256: string }>; limitations: string[]; digest: string };
    const scriptEvidence = permissionEvidence.files.find(file => file.path === "check.mjs");
    assert.ok(scriptEvidence, "the package command's local script source reaches the reviewer");
    assert.equal(scriptEvidence.content, inspectable.checkSource, "the reviewer receives full source contents");
    assert.equal(scriptEvidence.sha256, createHash("sha256").update(inspectable.checkSource).digest("hex"));
    assert.deepEqual(permissionEvidence.limitations, [], "the mapped command source is complete within the evidence bounds");
    assert.equal(permissionEvidence.digest, permissionEvidenceDigest(permissionEvidence));
    const expectedWorkspaceEvidenceHash = createHash("sha256").update(JSON.stringify({
      changedPaths: feedback.targetChangedPaths, evidence: permissionEvidence.digest,
    })).digest("hex");
    assert.equal(reviewing.permissionDecisions[0].workspaceEvidenceHash, expectedWorkspaceEvidenceHash,
      "the stored guard hash covers changed paths and the bounded source snapshot");
    const target = reviewing.members.find(member => member.memberId === reviewing.permissionDecisions[0].targetMemberId)!;
    assert.deepEqual(feedback.prompt, (await f.host.fetchApi(`/sessions/${target.sessionId}`)).body.attention.prompt);
    assert.equal(feedback.targetTask.instructions, reviewing.tasks.find(task => task.id === target.taskId)!.instructions);
    assert.equal(typeof feedback.targetScratchDirectory, "string");
    assert.ok(existsSync(feedback.targetScratchDirectory), "the host-assigned temporary directory exists for the reviewed target");
    const scratchRelativeToTarget = relative(target.cwd, feedback.targetScratchDirectory);
    assert.ok(scratchRelativeToTarget.startsWith(`..${sep}`), "the target scratch directory stays outside its Git checkout");
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

test("changed command source during a held review escalates without answering the prompt", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex-evidence-change", permissionLineup);
  try {
    addInspectableCheckPackage(f);
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const reviewing = await waitFor(() => f.get(created.body.id), run =>
      run.permissionDecisions?.[0]?.status === "reviewing" && existsSync(join(f.receipts, `${run.id}.judge-ready`)) &&
        existsSync(join(f.receipts, `${run.id}.target-ready`)), 60000);
    const decision = reviewing.permissionDecisions![0]!;
    const target = reviewing.members.find(member => member.memberId === decision.targetMemberId)!;
    const before = await f.host.fetchApi(`/sessions/${target.sessionId}`);
    const prompt = before.body.attention.prompt;
    assert.equal(before.body.attention.state, "needs-you");
    assert.ok(prompt?.id !== undefined && prompt.hash);

    writeFileSync(join(target.cwd, "check.mjs"), `${readFileSync(join(target.cwd, "check.mjs"), "utf8")}\n// changed while permission review was held\n`);
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    const escalated = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.match(escalated.permissionDecisions![0]!.reason ?? "", /inspected command sources or changed paths changed/i);
    assert.equal(escalated.permissionDecisions![0]!.receipt, undefined);
    assert.equal(existsSync(join(f.receipts, `${reviewing.id}.target-key`)), false, "no input key reaches the provider prompt");

    const after = await f.host.fetchApi(`/sessions/${target.sessionId}`);
    assert.equal(after.body.attention.state, "needs-you");
    assert.equal(after.body.attention.prompt.id, prompt.id);
    assert.equal(after.body.attention.prompt.hash, prompt.hash);
  } finally { await f.close(); }
});

test("a changed delivery workspace head during permission review cannot authorize publication", { timeout: 180000 }, async () => {
  const f = await fixture("delivery-permission", permissionLineup, {}, { deliveryMode: "pr" });
  try {
    const configured = await f.host.fetchApi("/projects/rehearsal/team", "owner");
    const optedIn = await f.host.fetchApi("/projects/rehearsal/team", "owner", {
      requestId: randomUUID(), revision: configured.body.revision,
      team: { ...configured.body.team, permissions: {
        mode: "coordinator", scope: "Review the exact owner-authorized delivery action for this run.", maxDecisions: 2,
      } },
    }, {}, "PUT");
    assert.equal(optedIn.status, 200, JSON.stringify(optedIn.body));

    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const targetReady = await waitFor(() => f.get(created.body.id), run => run.status === "blocked" ||
      run.permissionDecisions?.[0]?.status === "reviewing" && existsSync(join(f.receipts, `${run.id}.delivery-target-ready`)), 60000);
    assert.notEqual(targetReady.status, "blocked", JSON.stringify(targetReady));
    const target = targetReady.members.find(member => member.role === "delivery")!;
    const targetState = (await f.host.fetchApi(`/sessions/${target.sessionId}`)).body;
    assert.equal(targetReady.permissionDecisions?.[0]?.status, "reviewing", JSON.stringify({ decisions: targetReady.permissionDecisions,
      attention: targetState.attention, screen: targetState.screen }));
    const reviewing = await waitFor(() => f.get(created.body.id), run =>
      run.permissionDecisions?.[0]?.status === "reviewing" && existsSync(join(f.receipts, `${run.id}.judge-ready`)), 30000);
    const decision = reviewing.permissionDecisions![0]!;
    const coordinator = reviewing.members.find(member => member.memberId === decision.coordinatorMemberId)!;
    const delivery = reviewing.members.find(member => member.memberId === decision.targetMemberId)!;
    assert.equal(delivery.role, "delivery");
    const targetBefore = await f.host.fetchApi(`/sessions/${delivery.sessionId}`);
    const prompt = targetBefore.body.attention.prompt;
    assert.equal(targetBefore.body.attention.state, "needs-you");
    const expectedPush = [`git push https://github.com/example/app.git \\`, `${reviewing.headCommit}:refs/heads/\\`, reviewing.branch].join("\n");
    assert.equal(prompt?.tool?.input?.command, expectedPush,
      "the delivery request names the pinned repository URL, literal reviewed commit, and exact branch ref");
    const feedback = JSON.parse(readFileSync(join(f.receipts, `${reviewing.id}.permission-feedback.json`), "utf8"));
    assert.equal(feedback.deliveryAuthority.branch, reviewing.branch);
    assert.equal(feedback.deliveryAuthority.headCommit, reviewing.headCommit);
    assert.deepEqual(feedback.deliveryAuthority.policy, reviewing.delivery);

    const changedHead = git(delivery.cwd, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid",
      "commit", "--allow-empty", "-m", "Change delivery head during review");
    assert.notEqual(changedHead, reviewing.headCommit);
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    const escalated = await waitFor(() => f.get(reviewing.id), run => run.permissionDecisions?.[0]?.status === "escalated", 30000);
    assert.match(escalated.permissionDecisions![0]!.reason ?? "", /head|workspace|reviewed/i);
    assert.equal(escalated.permissionDecisions![0]!.receipt, undefined);
    assert.equal(existsSync(join(f.receipts, `${reviewing.id}.delivery-target-key`)), false,
      "the host does not send a key after the delivery head changed");
    assert.equal(existsSync(join(f.receipts, "delivery-receipt.json")), false, "no delivery receipt is recorded");

    const targetAfter = await f.host.fetchApi(`/sessions/${delivery.sessionId}`);
    assert.equal(targetAfter.body.attention.state, "needs-you");
    assert.equal(targetAfter.body.attention.prompt.id, prompt.id);
    assert.equal(targetAfter.body.attention.prompt.hash, prompt.hash);
    assert.equal(coordinator.role, "permission-coordinator");
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

test("an owner answer supersedes a late permission report when the obsolete reviewer cannot stop", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex", permissionLineup);
  let reviewerControl: Awaited<ReturnType<typeof claimControl>> | undefined;
  let reviewerSessionId: string | undefined;
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const reviewing = await waitFor(() => f.get(created.body.id), run =>
      run.permissionDecisions?.[0]?.status === "reviewing" && existsSync(join(f.receipts, `${run.id}.judge-ready`)), 60000);
    const decision = reviewing.permissionDecisions![0]!;
    const coordinator = reviewing.members.find(member => member.memberId === decision.coordinatorMemberId)!;
    reviewerSessionId = coordinator.sessionId;
    const target = reviewing.members.find(member => member.memberId === decision.targetMemberId)!;
    const targetSession = await waitFor(() => f.host.fetchApi(`/sessions/${target.sessionId}`),
      result => result.body?.attention?.state === "needs-you" && result.body?.attention?.prompt?.kind === "permission", 15000);

    // Keep the report-only reviewer from stopping immediately after its target becomes obsolete.
    reviewerControl = await claimControl(f.host, coordinator.sessionId, "controller");
    const ownerAnswer = await f.host.fetchApi(`/sessions/${target.sessionId}/answer`, "owner", {
      requestId: randomUUID(), promptId: targetSession.body.attention.prompt.id, option: 0,
    });
    assert.equal(ownerAnswer.status, 200, JSON.stringify(ownerAnswer.body));
    await waitFor(() => f.host.fetchApi(`/sessions/${target.sessionId}`), result => !result.body?.attention?.prompt, 15000);

    // If the stale report reaches the ordinary result validator, this violates the reviewer's
    // read-only workspace check. It must be ignored because the owner's answer already won.
    writeFileSync(join(coordinator.cwd, "late-review-write.txt"), "outside the reviewer assignment\n");
    writeFileSync(join(f.receipts, `${reviewing.id}.judge-release`), "release", { mode: 0o600 });
    const lateReport = await waitFor(() => f.get(reviewing.id), run =>
      run.members.some(member => member.memberId === coordinator.memberId && member.report?.kind === "permission-decision") &&
      run.members.some(member => member.memberId === coordinator.memberId && member.status === "unavailable"), 30000);
    assert.equal(lateReport.permissionDecisions?.[0]?.status, "escalated");
    assert.equal(lateReport.permissionDecisions?.[0]?.receipt, undefined);
    assert.notEqual(lateReport.status, "blocked", JSON.stringify(lateReport));

    await f.host.fetchApi(`/sessions/${coordinator.sessionId}/control`, "controller",
      { action: "release", leaseId: reviewerControl.lease.id }, reviewerControl.headers);
    reviewerControl = undefined;
    const finished = await f.settled(reviewing.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.permissionDecisions?.[0]?.status, "escalated");
    assert.equal(finished.permissionDecisions?.[0]?.receipt, undefined, "a late reviewer report cannot deliver a second answer");
    assert.deepEqual(finished.tasks.map(task => task.status), ["integrated", "integrated"]);

    // Reproduce a legacy host record that stopped during a generic result operation after
    // the permission coordinator and an implementation sibling had both reported. Without
    // operation provenance, restart must retain both reports and ask the PM to reconcile
    // them instead of either accepting one or leaving the same run wedged.
    await f.host.stopApi();
    const stateFile = join(f.host.config.stateDir, "teams", `${finished.id}.sealed`);
    const key = readFileSync(f.host.config.keyFile);
    const stored = unseal<any>(key, `team:${finished.id}`, readFileSync(stateFile, "utf8"));
    const priorReviewer = stored.run.members.find((member: any) => member.memberId === decision.coordinatorMemberId)!;
    const sibling = stored.run.members.find((member: any) => member.revision === stored.run.revision && member.role === "implementer" && member.report?.kind === "result");
    assert.ok(sibling, "the legacy intent overlaps a reported implementation sibling");
    priorReviewer.status = "unavailable";
    stored.run.status = "blocked";
    stored.run.reason = "A team operation failed. Its workspaces and recorded evidence were preserved for inspection.";
    stored.run.blockCode = undefined;
    stored.pending = { id: randomUUID(), kind: "result", revision: stored.run.revision };
    stored.run.recovery = { attempts: 1, status: "stopping", source: { code: "unattributed-result", memberId: "unattributed",
      revision: stored.run.revision, reason: stored.run.reason, at: new Date().toISOString() } };
    writeSealed(stateFile, key, `team:${finished.id}`, stored);

    const firstRestore = await f.openTeamService({ start: false });
    const firstRecovered = firstRestore.get(finished.id);
    assert.equal(firstRecovered.recovery?.attempts, 1);
    assert.equal(firstRecovered.recovery?.status, "stopping");
    firstRestore.close(); await firstRestore.idle();
    const secondRestore = await f.openTeamService({ start: false });
    const secondRecovered = secondRestore.get(finished.id);
    assert.equal(secondRecovered.recovery?.attempts, 1, "reopening before scheduling must not consume another reserved attempt");
    assert.equal(secondRecovered.recovery?.source.memberId, "unattributed");
    assert.ok(secondRecovered.events.some(event => /reservation was restored without consuming another attempt/i.test(event.text)));
    secondRestore.close(); await secondRestore.idle();

    await f.host.start();
    const recovered = await waitFor(() => f.get(finished.id), run =>
      run.members.some(member => member.role === "project-manager" && member.revision > finished.revision) || run.status === "blocked", 15000);
    assert.notEqual(recovered.status, "blocked", JSON.stringify(recovered));
    assert.equal(recovered.id, finished.id, "reconciliation continues the same durable run");
    assert.equal(recovered.recovery?.source.memberId, "unattributed", "the generic legacy intent is resolved by bounded PM recovery");
    assert.equal(recovered.recovery?.source.code, "unattributed-result");
    assert.equal(recovered.recovery?.attempts, 1);
    assert.ok(recovered.continuations?.some(item => item.revision === finished.revision), "the prior revision remains in run history");
    assert.equal(recovered.permissionDecisions?.[0]?.status, "escalated");
    assert.equal(recovered.permissionDecisions?.[0]?.receipt, undefined, "the retained reviewer report is never treated as an owner answer");
    assert.equal(recovered.members.find(member => member.memberId === coordinator.memberId)?.status, "unavailable");
    assert.equal(recovered.members.find(member => member.memberId === coordinator.memberId)?.report?.kind, "permission-decision");
    assert.equal(recovered.members.find(member => member.memberId === sibling.memberId)?.report?.kind, "result", "the sibling implementation report remains evidence");
    assert.ok(recovered.members.some(member => member.role === "project-manager" && member.revision > finished.revision), "PM diagnosis is scheduled in the same run");
  } finally {
    if (reviewerControl && reviewerSessionId) await f.host.fetchApi(`/sessions/${reviewerSessionId}/control`, "controller",
      { action: "release", leaseId: reviewerControl.lease.id }, reviewerControl.headers);
    await f.close();
  }
});

test("an unavailable reviewer with a terminal decision does not fence a later permission review", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const reviewing = await waitFor(() => f.get(created.body.id), run =>
      run.permissionDecisions?.[0]?.status === "reviewing" && existsSync(join(f.receipts, `${run.id}.judge-ready`)), 60000);
    const target = reviewing.members.find(member => member.memberId === reviewing.permissionDecisions![0]!.targetMemberId)!;
    const targetPrompt = await waitFor(() => f.host.fetchApi(`/sessions/${target.sessionId}`), result =>
      result.body?.attention?.state === "needs-you" && result.body?.attention?.prompt?.kind === "permission", 15000);

    // Model a new prompt after the first review became terminal, while retaining the old
    // report-only member as unavailable. The current prompt identity remains independently
    // validated by maybeStartPermissionReview before its new coordinator can answer it.
    const service = await f.openTeamService({ start: false });
    const internal = service as unknown as {
      records: Map<string, { run: typeof reviewing }>;
      save(stored: unknown): void;
      maybeStartPermissionReview(stored: unknown, member: unknown): Promise<boolean>;
      get(id: string): typeof reviewing;
    };
    const stored = internal.records.get(reviewing.id)!;
    const oldDecision = stored.run.permissionDecisions![0]!;
    const oldCoordinator = stored.run.members.find(member => member.memberId === oldDecision.coordinatorMemberId)!;
    oldDecision.status = "escalated";
    oldDecision.promptId = targetPrompt.body.attention.prompt.id - 1;
    oldCoordinator.status = "unavailable";
    internal.save(stored);

    assert.equal(await internal.maybeStartPermissionReview(stored, target), true,
      "a terminal reviewer cannot fence review of a later permission prompt");
    const restarted = await waitFor(() => Promise.resolve(internal.get(reviewing.id)), run =>
      run.permissionDecisions?.length === 2 && run.permissionDecisions[1]?.status === "reviewing", 30000);
    assert.equal(restarted.members.find(member => member.memberId === oldCoordinator.memberId)?.status, "unavailable",
      "the stale reviewer remains visible until its exit is confirmed");
    assert.equal(restarted.permissionDecisions![0]!.status, "escalated");
    assert.equal(restarted.permissionDecisions![1]!.targetSessionId, target.sessionId);
    assert.equal(restarted.permissionDecisions![1]!.promptId, targetPrompt.body.attention.prompt.id);

    const successor = stored.run.members.find(member => member.memberId === restarted.permissionDecisions![1]!.coordinatorMemberId)!;
    const successorDecision = stored.run.permissionDecisions![1]!;
    successor.status = "unavailable";
    for (const status of ["pending", "reviewing", "approved", "answering", "uncertain"] as const) {
      successorDecision.status = status;
      successorDecision.promptId = targetPrompt.body.attention.prompt.id - status.length - 1;
      internal.save(stored);
      assert.equal(await internal.maybeStartPermissionReview(stored, target), false,
        `${status} reviewer decisions must continue to fence another review`);
    }
    successorDecision.status = "escalated";
    successorDecision.promptId = targetPrompt.body.attention.prompt.id - 99;
    successorDecision.coordinatorMemberId = "missing-review-assignment";
    internal.save(stored);
    assert.equal(await internal.maybeStartPermissionReview(stored, target), false,
      "an active reviewer without a matching decision remains fenced as unknown work");
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
    const memberCount = recovered.members.length;
    await new Promise(resolve => setTimeout(resolve, 1200));
    const stillUncertain = await f.get(answering.id);
    assert.equal(stillUncertain.status, "blocked");
    assert.equal(stillUncertain.permissionDecisions?.[0]?.status, "uncertain");
    assert.equal(stillUncertain.recovery, undefined, "automatic recovery must not retry around an uncertain permission side effect");
    assert.equal(stillUncertain.members.length, memberCount, "uncertain permission state does not launch another coordinator or worker");
  } finally { await f.close(); }
});

for (const action of ["pause", "cancel"] as const)
test(`a ${action} with an unresolved verification operation stays in force after restart`, { timeout: 90000 }, async () => {
  const f = await fixture("lifecycle");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const checking = await waitFor(() => f.get(created.body.id), run => run.status === "verifying" && run.checks.some(check => check.status === "running"), 30000);
    const result = await f.host.fetchApi(`/teams/${checking.id}/${action}`, "owner", { requestId: randomUUID(), revision: checking.revision });
    assert.equal(result.status, 200);
    await f.host.stopApi();
    await f.host.start();
    const recovered = await f.get(checking.id);
    assert.equal(recovered.status, action === "pause" ? "paused" : "cancelled");
    assert.ok(recovered.checks.some(check => check.status === "interrupted"));
    assert.equal(recovered.members.length, checking.members.length, "restart cannot launch recovery workers for a held or cancelled run");
    assert.equal(recovered.recovery, undefined);
    assert.equal((await f.host.fetchApi("/teams")).body.teams.find((team: { id: string }) => team.id === checking.id).status, recovered.status);
  } finally { await f.close(); }
});
