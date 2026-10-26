import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Prompt } from "@infinite/attention";
import { claimControl, waitFor } from "./helpers.js";
import { fixture, git, limitLineup } from "./team-fixture.js";
import { DEFAULT_PERMISSION_LIMIT, DEFAULT_PERMISSION_SCOPE, LEGACY_DEFAULT_PERMISSION_SCOPES, currentPermissions, type TeamLineup } from "../packages/host/src/team-types.js";
import { isCollapsedPermissionPrompt, permissionEvidenceHash, refusedBeforeSend } from "../packages/host/src/team-permissions.js";
import { permissionEvidenceDigest } from "../packages/host/src/team-permission-evidence.js";
import { ContentError } from "../packages/host/src/session-content.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { Manager } from "../packages/host/src/manager.js";
import { socketPath } from "../packages/host/src/ipc.js";
import type { Config, ControlLease, Receipt, Session, WorkerRequest, WorkerState } from "../packages/host/src/types.js";

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

test("a saved default policy follows the current default; an owner-written scope or lowered limit is kept", () => {
  for (const scope of LEGACY_DEFAULT_PERMISSION_SCOPES) {
    assert.deepEqual(currentPermissions({ mode: "coordinator", scope, maxDecisions: 10 }), { mode: "coordinator", scope: DEFAULT_PERMISSION_SCOPE, maxDecisions: DEFAULT_PERMISSION_LIMIT });
    assert.deepEqual(currentPermissions({ mode: "coordinator", scope, maxDecisions: 3 }), { mode: "coordinator", scope: DEFAULT_PERMISSION_SCOPE, maxDecisions: 3 });
  }
  const custom = { mode: "coordinator" as const, scope: "Read files and run the configured check only.", maxDecisions: 10 };
  assert.deepEqual(currentPermissions(custom), custom);
  assert.match(DEFAULT_PERMISSION_SCOPE, /Escalate only production or staging actions such as deploy, promote, roll out, release or publish/);
  assert.match(DEFAULT_PERMISSION_SCOPE, /may run outside the provider sandbox and use network access, local sockets, IPC/);
});

test("only a preflight or named worker refusal counts as an answer that sent nothing", () => {
  assert.equal(refusedBeforeSend(new ContentError("The assigned team member has no running managed terminal")), true);
  for (const code of ["prompt-changed", "control-busy", "control-lost"])
    assert.equal(refusedBeforeSend(Object.assign(new Error(code), { code })), true, code);
  // A socket error can follow a delivered key, like a lost acknowledgement.
  for (const code of ["ECONNRESET", "EPIPE", undefined])
    assert.equal(refusedBeforeSend(Object.assign(new Error("Worker connection failed"), { code })), false, String(code));
});

test("collapsed permission expansion requires the pinned Codex one-shot command dialog", () => {
  const base: Prompt = {
    id: 7,
    kind: "menu",
    title: "[… 4 lines] ^a view all",
    detail: "Reason: Inspect the requested files.\n$ npm run check",
    options: [
      { index: 0, label: "Yes, proceed (y)", role: "accept" },
      { index: 1, label: "No, and tell Codex what to do differently (esc)", role: "reject-with-feedback" },
    ],
    acceptsText: true,
    pinned: true,
    source: "screen",
    hash: "a".repeat(64),
  };
  assert.equal(isCollapsedPermissionPrompt(base), true);
  assert.equal(isCollapsedPermissionPrompt({
    ...base,
    title: "Reason: May I run npm run check outside the sandbox?",
    detail: "• Running npm run check\n$ npm run check\n[… 4 lines] ^a view all",
  }), true, "the live Codex parser puts the combined collapsed marker at the end of detail under a Reason title");
  assert.equal(isCollapsedPermissionPrompt({ ...base, title: "[... 12 lines] Ctrl+A to view all" }), true,
    "the alternate ASCII ellipsis and Ctrl+A hint remain supported");
  assert.equal(isCollapsedPermissionPrompt({ ...base, title: "Press Ctrl-A to view all", detail: "$ npm run check\n[... 12 lines]" }), true,
    "the split marker and spelled key hint variant remains supported");

  for (const candidate of [
    { ...base, pinned: false },
    { ...base, source: "hook" as const, pinned: undefined },
    { ...base, title: "Would you like to make this edit?", detail: "$ npm run check\n[… 4 lines] ^a view all" },
    { ...base, title: "4 lines hidden", detail: "$ npm run check" },
    { ...base, title: "Would you like to run the following command?", detail: "$ npm run check\n^a view all" },
    { ...base, multiSelect: true },
    { ...base, options: [{ index: 0, label: "Yes", role: "accept" as const }, base.options[1]] },
    { ...base, options: [...base.options, { index: 2, label: "Yes, and don't ask again", role: "accept-always" as const }] },
    { ...base, options: [base.options[0], { index: 1, label: "No", role: "reject" as const }] },
  ]) assert.equal(isCollapsedPermissionPrompt(candidate), false, JSON.stringify(candidate));
});

test("a lost expansion acknowledgement is sealed uncertain and a fresh Manager never dispatches it again", { timeout: 20_000 }, async () => {
  mkdirSync(".local", { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(".local", "ie-"));
  const stateDir = join(root, "state"), runDir = join(root, "r"), sessionId = randomUUID();
  mkdirSync(runDir);
  const key = Buffer.alloc(32, 17);
  const team = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer" as const, taskId: "task-expand" };
  const cwd = realpathSync(root);
  const runtime = { id: randomUUID(), location: "cloud" as const, transport: "pty" as const };
  const session = {
    id: sessionId, team, provider: "codex" as const, title: "Collapsed permission", projectId: "fixture", cwd,
    createdAt: new Date().toISOString(), status: "running" as const, contextVersion: 0, context: "", initialPrompt: "",
    runtime,
  } as Session;
  const config = {
    stateDir, runDir, enableDemo: true, agents: { codex: { command: process.execPath, args: [] } },
  } as Config;
  const prompt: Prompt = {
    id: 9, kind: "menu", title: "[… 58 lines] ^a view all", detail: "Reason: Read the request.\n$ npm run check",
    options: [
      { index: 0, label: "Yes, proceed (y)", role: "accept" },
      { index: 1, label: "No, and tell Codex what to do differently (esc)", role: "reject-with-feedback" },
    ], acceptsText: true, pinned: true, source: "screen", hash: "c".repeat(64),
  };
  const liveState = {
    status: "running", seq: 11, screen: "", runtime, control: null,
    attention: { state: "needs-you", prompt },
  } as WorkerState;
  mkdirSync(join(stateDir, "sessions", sessionId), { recursive: true });
  writeSealed(join(stateDir, "sessions", sessionId, "meta.sealed"), key, `${sessionId}:meta`, { session, fingerprint: "fixture" });

  let control: ControlLease | null = null;
  let expansionDispatches = 0;
  let intentWasDurable = false;
  const server = createServer(socket => {
    let data = "";
    socket.on("data", chunk => {
      data += chunk.toString();
      const end = data.indexOf("\n");
      if (end < 0) return;
      const request = JSON.parse(data.slice(0, end)) as WorkerRequest;
      if (request.op === "state") {
        socket.end(JSON.stringify({ result: { ...liveState, control } }) + "\n");
      } else if (request.op === "control" && request.action === "claim") {
        control = { id: randomUUID(), label: request.actor.label, expiresAt: Date.now() + 60_000 };
        socket.end(JSON.stringify({ result: control }) + "\n");
      } else if (request.op === "control" && request.action === "release") {
        control = null;
        socket.end(JSON.stringify({ result: null }) + "\n");
      } else if (request.op === "team-permission-expand") {
        expansionDispatches++;
        const ledger = unseal<{ requests: Record<string, { receipt: Receipt }> }>(key, `${sessionId}:team-permission-expansions`,
          readFileSync(join(stateDir, "sessions", sessionId, "team-permission-expansions.sealed"), "utf8"));
        intentWasDurable = ledger.requests[request.requestId]?.receipt.state === "uncertain";
        socket.destroy(); // The worker accepted the one-key request; its acknowledgement is lost.
      } else socket.end(JSON.stringify({ error: "unexpected request" }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath(runDir, sessionId), resolve);
  });
  try {
    const manager = new Manager(config, key);
    const requestId = randomUUID();
    const expected = {
      promptId: prompt.id, promptHash: prompt.hash!, evidenceHash: permissionEvidenceHash(prompt), targetCwd: cwd,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const uncertain = await manager.expandTeamPermission(sessionId, requestId, team, expected);
    assert.equal(uncertain.state, "uncertain");
    assert.equal(expansionDispatches, 1);
    assert.equal(intentWasDurable, true, "the manager sealed its at-most-once intent before worker dispatch");

    await new Promise<void>(resolve => server.close(() => resolve()));
    const restarted = new Manager(config, key);
    assert.deepEqual(await restarted.expandTeamPermission(sessionId, requestId, team, expected), uncertain);
    await assert.rejects(restarted.expandTeamPermission(sessionId, requestId, team, {
      ...expected, expiresAt: new Date(Date.now() + 90_000).toISOString(),
    }), /different permission expansion arguments/);
    assert.equal(expansionDispatches, 1, "same-request replay after host restart never toggles twice");
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
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

test("collapsed Codex evidence is expanded before review and only the fresh pinned prompt is answered", { timeout: 120000 }, async () => {
  const f = await fixture("permissions-codex-collapsed", permissionLineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const runId = created.body.id as string;
    const collapsed = await waitFor(async () => {
      const run = await f.get(runId);
      const target = run.members.find(member => member.taskId === "a");
      const session = target?.sessionId ? await f.host.fetchApi(`/sessions/${target.sessionId}`) : undefined;
      return { run, target, session };
    }, value => existsSync(join(f.receipts, `${runId}.collapsed-ready`)) && Boolean(value.target &&
      value.session?.body.attention?.state === "needs-you" && value.session.body.attention.prompt), 60000);
    const target = collapsed.target!;
    const collapsedPrompt = collapsed.session!.body.attention.prompt as Prompt;
    assert.ok(collapsedPrompt.id !== undefined && collapsedPrompt.hash);
    assert.equal(collapsedPrompt.kind, "menu", "the collapsed Codex screen is a menu in the real host parser");
    assert.equal(isCollapsedPermissionPrompt(collapsedPrompt), true, JSON.stringify(collapsedPrompt));
    assert.equal(collapsed.run.permissionDecisions?.length ?? 0, 0, "collapsed evidence has not been assigned to a coordinator for approval");

    const reviewed = await waitFor(async () => {
      const run = await f.get(runId);
      const session = await f.host.fetchApi(`/sessions/${target.sessionId}`);
      return { run, session };
    }, value => existsSync(join(f.receipts, `${runId}.expanded-key`)) && existsSync(join(f.receipts, `${runId}.expanded-ready`)) &&
      existsSync(join(f.receipts, `${runId}.judge-ready`)) && value.session.body.attention?.state === "needs-you" &&
      value.session.body.attention.prompt?.id !== collapsedPrompt.id &&
      value.run.permissionDecisions?.[0]?.status === "reviewing" &&
      value.run.permissionDecisions[0].promptId === value.session.body.attention.prompt.id, 60000);
    const expandedPrompt = reviewed.session.body.attention.prompt as Prompt;
    assert.notEqual(expandedPrompt.id, collapsedPrompt.id, "Ctrl+A redraws a new attention prompt identity");
    assert.notEqual(expandedPrompt.hash, collapsedPrompt.hash);
    assert.equal(expandedPrompt.source, "screen");
    assert.equal(expandedPrompt.pinned, true);
    assert.equal(isCollapsedPermissionPrompt(expandedPrompt), false);
    assert.equal(reviewed.run.permissionDecisions?.length, 1);
    const decision = reviewed.run.permissionDecisions![0]!;
    assert.equal(decision.promptId, expandedPrompt.id, "the review is bound to the fresh screen identity");
    assert.equal(decision.promptHash, expandedPrompt.hash);
    assert.equal(decision.option, 0, "only the expanded one-shot option is eligible for a later answer");
    assert.equal(reviewed.run.permissionDecisions?.some(item => item.promptId === collapsedPrompt.id), false,
      "the collapsed display identity never receives a permission decision");
    const feedback = JSON.parse(readFileSync(join(f.receipts, `${runId}.permission-feedback.json`), "utf8"));
    assert.deepEqual(feedback.prompt, expandedPrompt, "the coordinator receives the actual expanded prompt evidence");
    assert.notEqual(feedback.prompt.id, collapsedPrompt.id);
    assert.equal(existsSync(join(f.receipts, `${runId}.permission-answer`)), false,
      "the provider receives no answer while its fresh prompt is held for coordinator review");

    writeFileSync(join(f.receipts, `${runId}.judge-release`), "release", { mode: 0o600 });
    const answered = await waitFor(() => f.get(runId), run => run.permissionDecisions?.[0]?.status === "answered" &&
      existsSync(join(f.receipts, `${runId}.permission-answer`)), 30000);
    assert.equal(answered.permissionDecisions?.[0]?.receipt?.state, "delivered");
    assert.equal(answered.permissionDecisions?.[0]?.receipt?.result, "closed");

    const auditService = await f.openTeamService({ start: false });
    const audited = auditService.understandingRecords().find(run => run.id === runId)!;
    const recovery = audited.permissionRecovery!;
    assert.equal(recovery.requests.length, 1);
    assert.equal(recovery.requests[0]!.promptId, expandedPrompt.id, "the live recovery request advances to the fresh prompt identity");
    assert.equal(recovery.requests[0]!.expansion?.status, "expanded");
    assert.equal(recovery.requests[0]!.expansion?.promptId, collapsedPrompt.id, "the expansion record retains the original collapsed identity");
    assert.equal(recovery.requests[0]!.expansion?.observedPromptId, expandedPrompt.id,
      "the expansion record binds the new prompt identity");
    assert.equal(recovery.requests[0]!.expansion?.observedPromptHash, expandedPrompt.hash);
    assert.ok(recovery.steps.some(step => step.action === "expand-display" && step.decision === "display-expansion-delivered" &&
      step.receipt?.state === "delivered" && step.execution === "unknown"), "the audit records key delivery without claiming command execution");
    assert.ok(recovery.steps.some(step => step.action === "bind-expanded-prompt" && step.decision === "review-new-screen-identity"),
      "the audit records review of the newly observed screen");
    assert.equal(recovery.outcomes.length, 1);
    assert.equal(recovery.outcomes[0]!.promptId, expandedPrompt.id);
    assert.equal(recovery.outcomes[0]!.status, "complete");
    assert.equal(recovery.outcomes[0]!.decision, "one-shot-answer-delivered");
    assert.match(recovery.outcomes[0]!.consequence, /command's execution result remains unknown/i);
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
    assert.match(escalated.permissionDecisions[0].reason ?? "", /pinned permission reviewer provider is not configured/i);
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
      if (scenario === "permissions-escalate") {
        await new Promise(resolve => setTimeout(resolve, 1800)); // Let several 500 ms TeamService passes observe the held prompt.
        const stillEscalated = await f.get(reviewing.id);
        assert.equal(stillEscalated.permissionDecisions?.length, 1,
          "a terminal escalation for this exact prompt cannot launch another ordinary review on later ticks");
        assert.equal(stillEscalated.members.filter(member => member.role === "permission-coordinator").length, 1);
        assert.equal(existsSync(join(f.receipts, `${reviewing.id}.permission-answer`)), false);
        assert.equal((await f.host.fetchApi(`/sessions/${target.sessionId}`)).body.attention?.state, "needs-you");
      }
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
