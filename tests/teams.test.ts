import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createRemoteClient, type RemoteClient } from "@infinite/remote";
import { claimControl, startHost, waitFor, type Host } from "./helpers.js";
import { Journal, unseal, writeSealed } from "../packages/host/src/vault.js";
import { checkTimeoutReason, memberStallReason } from "../packages/host/src/teams.js";
import type { CreateTeam, TeamLineup, TeamModelProfile, TeamRun, TeamView } from "../packages/host/src/team-types.js";
import { refreshReportingInstructions, retargetPrompt, teamPrompt } from "../packages/host/src/team-prompts.js";
import { reportErrorMessage, submitTeamReport } from "../packages/host/src/team-report-client.js";

// The shared fallback lineup used by delivery and permission tests; the limit tests below define their own.
import { git, limitLineup as fallbackLineup, mixedLineup, fixture } from "./team-fixture.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { Manager } from "../packages/host/src/manager.js";

test("team runs use readable names and exact root permissions under a strict umask", { timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-team-modes-"));
  const workspaceDir = join(root, "first", "second", "teams");
  const previousUmask = process.umask(0o077);
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    // The API subprocess inherits this umask, including after enrollment restarts it.
    f = await fixture("success", undefined, { teams: { workspaceDir,
      commandPrefix: { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", root] },
    } });
    const firstRequest = f.create();
    const firstCreated = await f.host.fetchApi("/teams", "owner", firstRequest);
    const first = await f.settled(firstCreated.body.id);
    assert.equal(first.status, "ready-for-review", JSON.stringify(first));
    const firstName = `${first.createdAt.slice(0, 10)}-implement-a-small-feature-${first.id.slice(0, 8)}`;
    assert.equal(realpathSync(first.workspace), realpathSync(join(f.host.config.teams!.workspaceDir, `rehearsal-${firstName}`, "integration")));
    assert.equal(first.branch, `infinite/team-implement-a-small-feature-${first.id.slice(0, 8)}`);
    for (const directory of [workspaceDir, dirname(workspaceDir), dirname(dirname(workspaceDir))])
      assert.equal(statSync(directory).mode & 0o777, 0o750);

    const teamworkRoot = await f.enrollTeamwork({ sharedGroup: true }, "Projects/teamwork");
    const secondRequest = f.create();
    const secondCreated = await f.host.fetchApi("/teams", "owner", secondRequest);
    const second = await f.settled(secondCreated.body.id);
    assert.equal(second.status, "ready-for-review", JSON.stringify(second));
    const secondName = `${second.createdAt.slice(0, 10)}-implement-a-small-feature-${second.id.slice(0, 8)}`;
    assert.equal(realpathSync(second.workspace), realpathSync(join(teamworkRoot, secondName, "integration")));
    assert.equal(second.branch, `infinite/team-implement-a-small-feature-${second.id.slice(0, 8)}`);
    assert.equal(statSync(teamworkRoot).mode & 0o777, 0o750);
    assert.equal(statSync(dirname(teamworkRoot)).mode & 0o777, 0o750);
  } finally {
    process.umask(previousUmask);
    try { await f?.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

for (const unsafe of ["root", "parent"] as const)
test(`default runs refuse a group-writable ${unsafe} until its permissions are repaired`, { timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-team-root-"));
  const parent = join(root, "parent"), workspaceDir = join(parent, "teams");
  mkdirSync(parent, { mode: 0o750 });
  mkdirSync(workspaceDir, { mode: 0o750 });
  chmodSync(parent, 0o750);
  chmodSync(workspaceDir, 0o750);
  const unsafeDirectory = unsafe === "root" ? workspaceDir : parent;
  chmodSync(unsafeDirectory, 0o770);
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture("success", undefined, { teams: { workspaceDir,
      commandPrefix: { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", root] },
    } });
    const refused = await f.host.fetchApi("/teams", "owner", f.create());
    assert.deepEqual([refused.status, refused.body.code], [409, "team-root-unsafe"]);
    assert.deepEqual(readdirSync(workspaceDir), []);
    assert.equal(statSync(unsafeDirectory).mode & 0o777, 0o770, "the host must not repair an existing unsafe directory");

    chmodSync(unsafeDirectory, 0o750);
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const finished = await f.settled(created.body.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
  } finally { try { await f?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
});

for (const unsafe of ["parent", "anchor"] as const)
test(`teamwork preparation refuses a group-writable ${unsafe}`, { timeout: 120000 }, async () => {
  const f = await fixture("success");
  try {
    const parent = join(dirname(f.source), "Projects");
    mkdirSync(parent);
    const teamworkRoot = await f.enrollTeamwork({ sharedGroup: true }, "Projects/teamwork");
    assert.ok(teamworkRoot);
    chmodSync(unsafe === "parent" ? parent : dirname(f.source), 0o770);
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.deepEqual([created.status, created.body.code], [409, "team-root-unsafe"]);
  } finally { await f.close(); }
});

test("a lifecycle run cannot be bundled before review", { timeout: 60000 }, async () => {
  const f = await fixture("lifecycle");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status));
    const checking = await waitFor(() => f.get(created.body.id), run => run.status === "verifying" && run.checks.some(check => check.status === "running"), 30000);
    const response = await f.host.fetchApi(`/teams/${checking.id}/bundle`);
    assert.deepEqual([response.status, response.body.code], [409, "team-not-ready"]);
  } finally { await f.close(); }
});

test("legacy team records without a saved root retain their workspace and branch", { timeout: 120000 }, async () => {
  const f = await fixture("success");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const finished = await f.settled(created.body.id);
    await f.host.stopApi();
    const file = join(f.host.config.stateDir, "teams", `${finished.id}.sealed`);
    const key = readFileSync(f.host.config.keyFile);
    const stored = unseal<any>(key, `team:${finished.id}`, readFileSync(file, "utf8"));
    const legacyDirectory = join(f.host.config.teams!.workspaceDir, finished.id);
    renameSync(dirname(finished.workspace), legacyDirectory);
    stored.run.workspace = join(legacyDirectory, "integration");
    stored.run.branch = `infinite/team-${finished.id}`;
    delete stored.root;
    writeSealed(file, key, `team:${finished.id}`, stored);
    await f.host.start();
    const restored = await f.get(finished.id);
    assert.equal(restored.workspace, join(legacyDirectory, "integration"));
    assert.equal(restored.branch, `infinite/team-${finished.id}`);
    assert.equal(restored.status, "ready-for-review");
  } finally { await f.close(); }
});

test("team bundle route requires an owner CLI and a recorded result", { timeout: 120000 }, async () => {
  const f = await fixture("success");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const finished = await f.settled(created.body.id);
    const endpoint = `/teams/${finished.id}/bundle`;
    for (const role of ["viewer", "controller"] as const)
      assert.equal((await f.host.fetchApi(endpoint, role)).status, 403);
    const login = await f.host.fetchApi("/login", null, { token: f.host.tokens.owner }, { Origin: f.host.config.origin });
    assert.equal(login.status, 200);
    const browser = { Cookie: login.headers.get("set-cookie")!.split(";")[0], Origin: f.host.config.origin };
    assert.equal((await f.host.fetchApi(endpoint, null, undefined, browser)).status, 403);

    await f.host.stopApi();
    const file = join(f.host.config.stateDir, "teams", `${finished.id}.sealed`);
    const key = readFileSync(f.host.config.keyFile);
    const stored = unseal<any>(key, `team:${finished.id}`, readFileSync(file, "utf8"));
    delete stored.run.headCommit;
    writeSealed(file, key, `team:${finished.id}`, stored);
    await f.host.start();
    const noResult = await f.host.fetchApi(endpoint);
    assert.equal(noResult.status, 409);
    assert.equal(noResult.body.code, "team-no-result");
  } finally { await f.close(); }
});

test("an opted-in blank project accepts coordinator checks and reaches review only after verifying the implemented invariant", { timeout: 120000 }, async () => {
  const f = await fixture("bootstrap");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const finished = await f.settled(created.body.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.ok(finished.checks.some(check => check.phase === "setup" && check.status === "passed" && check.output.includes("Bootstrap setup completed")));
    assert.ok(finished.checks.some(check => check.status === "passed" && check.phase !== "setup"));
    assert.equal(readFileSync(join(finished.workspace, "a.txt"), "utf8"), readFileSync(join(finished.workspace, "b.txt"), "utf8"));
  } finally { await f.close(); }
});

test("an opted-in blank project must receive checks before any implementer launches", { timeout: 60000 }, async () => {
  const f = await fixture("bootstrap-missing");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.match(blocked.reason ?? "", /verification|check/i);
    assert.equal(blocked.tasks.length, 0);
    assert.deepEqual(blocked.members.map(member => member.role), ["project-manager"]);
  } finally { await f.close(); }
});

test("a project manager corrects an unauthorized verification report and uses configured checks", { timeout: 120000 }, async () => {
  const f = await fixture("bootstrap-override");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const finished = await f.settled(created.body.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.verification, undefined, "the project manager cannot replace or establish verification");
    assert.ok(finished.tasks.every(task => task.status === "integrated"));
    assert.equal(finished.checks.length, 1);
    assert.equal(finished.checks[0].status, "passed");
    assert.ok(finished.checks[0].command.args.includes("check.mjs"), "the configured project check ran after integration");
    const manager = finished.members.find(member => member.role === "project-manager");
    assert.ok(manager);
    assert.match(readFileSync(join(f.receipts, `${manager.memberId}.rejection.txt`), "utf8"), /Plan rejected: .*configured checks\. Remove verification and submit a corrected plan/i);
  } finally { await f.close(); }
});

test("an unauthorized plan gets one correction per run revision before blocking", () => {
  const f = schedulerFixture();
  try {
    f.writeTeam();
    const service = f.openTeam() as unknown as {
      records: Map<string, { run: TeamRun; [key: string]: unknown }>;
      consume(stored: { run: TeamRun; [key: string]: unknown }, member: any): void;
      prepareMember(stored: unknown, role: string, task: unknown, feedback: string): void;
    };
    const stored = service.records.get(f.run.id)!;
    let corrections = 0;
    service.prepareMember = (_stored, role, _task, feedback) => {
      assert.equal(role, "project-manager");
      assert.match(feedback, /Remove verification and submit a corrected plan/);
      assert.match(feedback, /Earlier planning question: Which API\?\nUser answered: The public one/, "answered planning decisions reach the corrected plan");
      assert.doesNotMatch(feedback, /Unanswered question/);
      corrections++;
    };
    const managerId = stored.run.members[0].memberId;
    stored.run.decisions = [
      { id: randomUUID(), memberId: managerId, revision: f.run.revision, question: "Which API?", options: ["The public one", "The private one"], createdAt: new Date().toISOString(), answer: "The public one", answeredAt: new Date().toISOString() },
      { id: randomUUID(), memberId: managerId, revision: f.run.revision, question: "Unanswered question", options: ["Yes", "No"], createdAt: new Date().toISOString() },
    ];
    const report = { kind: "plan", summary: "Plan with unauthorized verification", tasks: [
      { id: "task-a", title: "Create the example file", instructions: "Create example.txt", paths: ["example.txt"], dependsOn: [] },
    ], verification: { checks: [{ command: "npm", args: ["run", "check"] }] } };
    const first = { ...stored.run.members[0], memberId: randomUUID(), report };
    service.consume(stored, first);
    assert.equal(corrections, 1);
    const afterCorrection = f.readRecord<{ run: TeamRun }>("team", f.run.id);
    assert.deepEqual((afterCorrection.run as any).verificationCorrections, [f.run.revision]);

    const second = { ...first, memberId: randomUUID(), sessionId: randomUUID() };
    service.consume(stored, second);
    assert.equal(corrections, 1, "the same revision cannot request another project-manager correction");
    const blocked = f.readRecord<{ run: TeamRun }>("team", f.run.id);
    assert.equal(blocked.run.status, "blocked");
    assert.equal(blocked.run.reason, "A plan cannot replace the project's configured checks.");
    assert.deepEqual((blocked.run as any).verificationCorrections, [f.run.revision]);
  } finally { f.close(); }
});

test("failed coordinator checks stay blocked after the bounded repair attempts", { timeout: 120000 }, async () => {
  const f = await fixture("bootstrap-fail");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.equal(blocked.review, undefined);
    assert.ok(blocked.checks.some(check => check.status === "failed" && check.exitCode === 17));
    assert.ok(blocked.members.filter(member => member.role === "integrator").length <= 2);
  } finally { await f.close(); }
});

test("accepted coordinator verification survives restart and a later plan that omits it", { timeout: 120000 }, async () => {
  const f = await fixture("bootstrap-replan");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const waiting = await waitFor(() => f.get(created.body.id), run => run.status === "needs-input" && run.decisions.length === 1, 30000);
    const accepted = waiting.verification;
    assert.ok(accepted?.checks?.length);
    await f.host.stopApi(); await f.host.start();
    const recovered = await f.get(waiting.id);
    assert.deepEqual(recovered.verification, accepted);
    const steer = { requestId: randomUUID(), revision: recovered.revision, text: "Keep the original acceptance criteria." };
    let replanned = await f.host.fetchApi(`/teams/${waiting.id}/steer`, "controller", steer);
    for (let attempt = 0; attempt < 40 && replanned.status === 409 && replanned.body.code === "team-operation-running"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      replanned = await f.host.fetchApi(`/teams/${waiting.id}/steer`, "controller", steer);
    }
    assert.equal(replanned.status, 200, JSON.stringify(replanned.body));
    const finished = await f.settled(waiting.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.deepEqual(finished.verification, accepted);
    assert.ok(finished.checks.some(check => check.status === "passed"));
  } finally { await f.close(); }
});

test("a replanned coordinator cannot change accepted verification commands", { timeout: 120000 }, async () => {
  const f = await fixture("bootstrap-change");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const waiting = await waitFor(() => f.get(created.body.id), run => run.status === "needs-input" && run.decisions.length === 1, 30000);
    const accepted = waiting.verification;
    assert.ok(accepted?.checks?.length);
    await f.host.stopApi(); await f.host.start();
    const recovered = await f.get(waiting.id);
    const steer = { requestId: randomUUID(), revision: recovered.revision, text: "Replan without changing accepted checks." };
    let replanned = await f.host.fetchApi(`/teams/${waiting.id}/steer`, "controller", steer);
    for (let attempt = 0; attempt < 40 && replanned.status === 409 && replanned.body.code === "team-operation-running"; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      replanned = await f.host.fetchApi(`/teams/${waiting.id}/steer`, "controller", steer);
    }
    assert.equal(replanned.status, 200, JSON.stringify(replanned.body));
    const blocked = await f.settled(waiting.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.match(blocked.reason ?? "", /verification.*(changed|different)|commands/i);
    assert.deepEqual(blocked.verification, accepted);
    assert.equal(blocked.members.some(member => member.revision === 2 && member.role === "implementer"), false);
  } finally { await f.close(); }
});

test("a team builds concurrently in isolated copies and produces checked, reviewed work without changing its source", { timeout: 120000 }, async () => {
  const f = await fixture();
  const owner = createRemoteClient({ url: f.host.origin, token: f.host.tokens.owner });
  const viewer = createRemoteClient({ url: f.host.origin, token: f.host.tokens.viewer });
  try {
    const request = f.create();
    for (const role of ["controller", "viewer"] as const)
      assert.equal((await f.host.fetchApi("/teams", role, request)).status, 403);
    const created = await owner.request<TeamView>("/teams", { body: request });
    const id = created.id;
    assert.equal(id, request.requestId);
    const retry = await f.host.fetchApi("/teams", "owner", request);
    assert.equal(retry.body.id, id);
    assert.equal((await f.host.fetchApi("/teams", "owner", { ...request, useConfiguredLineup: false })).body.id, id, "Explicit single-provider selection must retain legacy request identity");
    assert.equal((await f.host.fetchApi("/teams", "owner", { ...request, objective: "A different task" })).status, 409);
    for (const action of ["pause", "resume", "cancel"])
      assert.equal((await f.host.fetchApi(`/teams/${id}/${action}`, "controller", { requestId: randomUUID(), revision: 1 })).status, 403);
    assert.equal((await f.host.fetchApi(`/teams/${id}/steer`, "viewer", { requestId: randomUUID(), revision: 1, text: "Unauthorized steering" })).status, 403);
    assert.equal((await viewer.request<TeamView>(`/teams/${id}`)).id, id);
    const finished = await f.settled(id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.review?.verdict, "approved");
    assert.ok(finished.checks.length > 0 && finished.checks.every(check => check.status === "passed"));
    assert.deepEqual(finished.tasks.map(task => task.status), ["integrated", "integrated"]);
    assert.equal(readFileSync(join(finished.workspace, "a.txt"), "utf8"), "revision 1\n");
    assert.equal(readFileSync(join(finished.workspace, "b.txt"), "utf8"), "revision 1\n");
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
    assert.equal(git(f.source, "status", "--porcelain"), "");
    assert.equal(readFileSync(join(f.source, "original.txt"), "utf8"), "The configured project remains unchanged.\n");
    const workers = readdirSync(f.receipts).filter(name => name.endsWith(".json"))
      .map(name => JSON.parse(readFileSync(join(f.receipts, name), "utf8")))
      .filter(value => value.role === "implementer");
    assert.equal(workers.length, 2, "A retried creation must not launch duplicate implementers");
    assert.equal(new Set(workers.map(worker => worker.cwd)).size, 2);
    assert.ok(workers.every(worker => worker.cwd !== f.source && worker.finishedAt));
    assert.ok(Math.max(...workers.map(worker => worker.startedAt)) < Math.min(...workers.map(worker => worker.finishedAt)), "The implementers must actually overlap");
    assert.equal((await viewer.request<{ teams: TeamView[] }>("/teams")).teams.filter(run => run.id === id).length, 1);
    const commands = readFileSync(join(f.receipts, "commands.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(commands.some(command => command.cwd === f.source && command.command === "git"), "Source Git inspection must use the configured execution identity");
    for (const worker of workers)
      assert.ok(commands.some(command => command.cwd === worker.cwd && command.command === "git" && command.args.includes("add")), "Git must not stage agent-controlled files as the API identity");
    assert.ok(commands.some(command => command.cwd === finished.workspace && command.command === process.execPath && command.args.includes("check.mjs")), "Configured checks must use the execution identity");
  } finally { owner.close(); viewer.close(); await f.close(); }
});

test("review rubrics drop self-grading, integration records docs/tests, and owner ratings are idempotent", { timeout: 120000 }, async () => {
  const { limitFallback: _limitFallback, ...implementerProfile } = fallbackLineup.implementers[0];
  const reviewerProfile = { ...implementerProfile, id: "rubric-reviewer", label: "Rubric reviewer", tier: "strong" as const };
  const lineup: TeamLineup = { ...fallbackLineup, reviewer: reviewerProfile };
  const f = await fixture("rubric", lineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const finished = await f.settled(created.body.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    const taskA = finished.tasks.find(task => task.id === "a")!;
    const taskB = finished.tasks.find(task => task.id === "b")!;
    assert.equal(taskA.rubric, undefined);
    assert.equal(taskB.rubric?.version, 1);
    assert.equal(taskB.rubric?.reviewerProfileId, reviewerProfile.id);
    assert.equal(taskA.diffStat?.docs, true);
    assert.equal(taskA.diffStat?.tests, true);
    assert.ok(finished.events.some(event => /rubric for task a was dropped/.test(event.text)));

    const path = `/teams/${finished.id}/tasks/a/rating`, requestId = randomUUID();
    const input = { requestId, score: 4, note: "Useful result" };
    assert.equal((await f.host.fetchApi(path, "viewer", input)).status, 403);
    const first = await f.host.fetchApi(path, "owner", input);
    assert.equal(first.status, 200);
    const at = first.body.ownerRating.at;
    const retry = await f.host.fetchApi(path, "owner", input);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.ownerRating.at, at);
    assert.equal((await f.host.fetchApi(path, "owner", { ...input, score: 5 })).status, 409);
  } finally { await f.close(); }
});

test("mixed teams pin real worker launches across configuration changes, restart, and a question retry", { timeout: 120000 }, async () => {
  const f = await fixture("mixed", mixedLineup, {}, { trustWorkspaces: true });
  try {
    const request = f.create();
    const created = await f.host.fetchApi("/teams", "owner", request);
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const permission = await waitFor(() => f.get(created.body.id), run => run.reason?.startsWith("A provider needs user input.") === true, 30000);
    const coordinator = permission.members.find(member => member.role === "project-manager")!;
    const session = await f.host.fetchApi(`/sessions/${coordinator.sessionId}`);
    assert.equal(session.status, 200);
    assert.equal(session.body.attention.state, "needs-you");
    assert.equal(session.body.attention.prompt.kind, "permission");
    assert.equal(session.body.attention.prompt.source, "hook");
    writeFileSync(join(f.receipts, `${coordinator.memberId}.permission-release`), "continue", { mode: 0o600 });
    const waiting = await waitFor(() => f.get(created.body.id), run => run.status === "needs-input"
      && run.decisions.length === 1 && run.tasks.find(task => task.id === "a")?.status === "integrated", 45000);
    const reportedCoordinator = waiting.members.find(member => member.memberId === coordinator.memberId)!;
    assert.equal(reportedCoordinator.status, "stopped");
    assert.equal(reportedCoordinator.report?.kind, "plan");
    assert.equal(waiting.reason, undefined, "A stopped provider's permission notice must not remain while another member awaits a product decision");
    const decision = waiting.decisions[0];
    const original = waiting.members.find(member => member.memberId === decision.memberId)!;
    assert.equal(original.taskId, "b");
    assert.deepEqual(original.modelProfile, mixedLineup.implementers[1]);
    const changed = structuredClone(mixedLineup);
    const replacement = (profile: TeamLineup["coordinator"]): TeamLineup["coordinator"] => ({ id: profile.id, label: profile.label,
      provider: "codex", model: "gpt-6-sol", effort: "medium" });
    changed.coordinator = replacement(changed.coordinator);
    changed.integrator = replacement(changed.integrator);
    changed.reviewer = replacement(changed.reviewer);
    changed.implementers = changed.implementers.map(replacement);
    await f.host.stopApi();
    f.host.config.teams!.lineup = changed;
    writeFileSync(join(f.host.root, "config.json"), JSON.stringify(f.host.config));
    await f.host.start();
    const recovered = await f.get(waiting.id);
    assert.deepEqual(recovered.lineup, mixedLineup);
    assert.equal(recovered.members.length, waiting.members.length);
    const retriedCreation = await f.host.fetchApi("/teams", "owner", request);
    assert.equal(retriedCreation.status, 200, JSON.stringify(retriedCreation.body));
    assert.deepEqual(retriedCreation.body.lineup, mixedLineup, "The new host coordinator must not change an existing request's lineup");
    const answerPath = `/teams/${waiting.id}/decisions/${decision.id}/answer`;
    const answer = { requestId: randomUUID(), revision: waiting.revision, text: "Compact" };
    assert.equal((await f.host.fetchApi(answerPath, "controller", answer)).status, 200);
    assert.equal((await f.host.fetchApi(answerPath, "controller", answer)).status, 200);
    assert.equal((await f.get(waiting.id)).decisions.find(item => item.id === decision.id)?.answeredBy, "owner");
    const finished = await f.settled(waiting.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.deepEqual(finished.lineup, mixedLineup);
    const attempts = finished.members.filter(member => member.taskId === "b");
    assert.equal(attempts.length, 2, "An answer retry must create exactly one replacement worker");
    assert.equal(attempts[0].cwd, attempts[1].cwd);
    assert.equal(finished.members.filter(member => member.role === "integrator").length, 1);
    assert.equal(finished.review?.verdict, "approved");
    assert.ok(finished.checks.some(check => check.status === "failed" && check.exitCode === 18));
    assert.ok(finished.checks.some(check => check.status === "passed"));

    for (const member of finished.members) {
      const expected = member.role === "project-manager" ? mixedLineup.coordinator
        : member.role === "reviewer" ? mixedLineup.reviewer
        : member.role === "integrator" ? mixedLineup.integrator
        : mixedLineup.implementers[member.taskId === "a" ? 0 : 1];
      assert.deepEqual(member.modelProfile, expected);
      assert.equal(member.provider, expected.provider);
      const worker = JSON.parse(readFileSync(join(f.receipts, `${member.memberId}.json`), "utf8"));
      assert.equal(worker.provider, expected.provider, "The selected provider profile must reach the actual child process");
      const args: string[] = worker.argv;
      assert.equal(args.filter(arg => arg === "--model").length, 1);
      assert.equal(args[args.indexOf("--model") + 1], expected.model);
      if (expected.provider === "claude") {
        assert.equal(args[args.indexOf("--effort") + 1], expected.effort);
        assert.ok(args.includes("--mcp-config"));
      } else if (expected.provider === "codex") {
        const effortIndex = args.indexOf(`model_reasoning_effort="${expected.effort}"`);
        assert.ok(effortIndex > 0);
        assert.equal(args[effortIndex - 1], "-c");
        assert.ok(!args.includes("--effort") && !args.includes("--mcp-config"));
        const settings = new Map<string, unknown>();
        for (let index = 0; index < args.length - 1; index++) {
          if (args[index] === "-c" && args[index + 1].startsWith("mcp_servers.infinite_team.")) {
            const override = args[++index].slice("mcp_servers.infinite_team.".length), equals = override.indexOf("=");
            settings.set(override.slice(0, equals), JSON.parse(override.slice(equals + 1)));
          }
        }
        assert.equal(settings.get("command"), process.execPath);
        assert.deepEqual(settings.get("env_vars"), ["INFINITE_HOOK_URL", "INFINITE_HOOK_TOKEN", "INFINITE_TEAM_ASSIGNMENT", "INFINITE_MISSION_ASSIGNMENT"]);
        assert.equal(settings.get("tools.report.approval_mode"), "approve");
        assert.match(worker.prompt ?? "", /report tool of the infinite_team MCP server/);
      } else {
        assert.equal(worker.model, expected.model);
        assert.equal(worker.variant, expected.variant);
        assert.match(worker.prompt, /You are the team's implementer/);
        assert.ok(!args.includes("--prompt") && !args.includes("--effort") && !args.includes("--auto"));
      }
      const session = await f.host.fetchApi(`/sessions/${member.sessionId}`);
      assert.equal(session.status, 200);
      assert.equal(session.body.provider, expected.provider);
      // A trusted root covers each member's own clone: the exact folder, never a parent.
      assert.equal(session.body.workspaceTrusted, true);
      assert.equal(worker.trustedWorkspace, worker.cwd);
      const override = args.indexOf(`projects={${JSON.stringify(worker.cwd)}={trust_level="trusted"}}`);
      assert.equal(override > 0 && args[override - 1] === "-c", expected.provider === "codex");
    }
    const claudeConfig = JSON.parse(readFileSync(join(f.home, ".claude.json"), "utf8"));
    const claudeFolders = finished.members.filter(member => member.provider === "claude").map(member =>
      JSON.parse(readFileSync(join(f.receipts, `${member.memberId}.json`), "utf8")).cwd);
    assert.ok(claudeFolders.length >= 2);
    assert.deepEqual(Object.keys(claudeConfig.projects).sort(), [...new Set(claudeFolders)].sort());
    for (const folder of claudeFolders) assert.equal(claudeConfig.projects[folder].hasTrustDialogAccepted, true);
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
    assert.equal(git(f.source, "status", "--porcelain"), "");
  } finally { await f.close(); }
});

test("mixed plans reject absent, unknown, and fixed-role model selections before launching any implementer", { timeout: 120000 }, async () => {
  const f = await fixture("mixed-invalid", mixedLineup);
  try {
    const forged = await f.host.fetchApi("/sessions", "owner", {
      requestId: randomUUID(), projectId: "rehearsal", provider: "claude", title: "Untrusted model override", prompt: "Do not launch",
      teamModelProfile: mixedLineup.coordinator,
    });
    assert.equal(forged.status, 400, "Public session requests cannot supply the scheduler's internal model selection");
    const mismatch = await f.host.fetchApi("/teams", "owner", { ...f.create(), provider: "codex" });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.code, "team-provider-mismatch");
    assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 0);
    for (const selection of [{}, { agentProfileId: "unknown-profile" }, { agentProfileId: "opus-coordinator" }]) {
      writeFileSync(join(f.receipts, "invalid-profile.json"), JSON.stringify(selection));
      const created = await f.host.fetchApi("/teams", "owner", f.create());
      assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
      const blocked = await f.settled(created.body.id);
      assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
      assert.match(blocked.reason ?? "", /agentProfileId.*implementer pool/);
      assert.equal(blocked.members.length, 1, "The valid first task must not launch before the rest of the plan is validated");
      assert.equal(blocked.members[0].role, "project-manager");
      assert.equal(blocked.tasks.length, 0);
      assert.equal(blocked.checks.length, 0);
      assert.equal((await f.host.fetchApi(`/teams/${blocked.id}/cancel`, "owner", { requestId: randomUUID(), revision: blocked.revision })).status, 200);
    }
  } finally { await f.close(); }
});

test("questions and steering survive API restart with durable retries and stale revision refusals", { timeout: 120000 }, async () => {
  const f = await fixture("question");
  let controller: RemoteClient | undefined;
  try {
    const request = f.create();
    const created = await f.host.fetchApi("/teams", "owner", request);
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const waiting = await waitFor(() => f.get(created.body.id), run => run.decisions.length === 1 && run.status === "needs-input", 30000);
    const decision = waiting.decisions[0];
    await f.host.stopApi(); await f.host.start();
    const recovered = await f.get(waiting.id);
    assert.equal(recovered.decisions[0].id, decision.id);
    assert.equal(recovered.decisions[0].question, decision.question);
    assert.equal(recovered.decisions[0].answer, undefined);
    assert.equal(recovered.members.length, waiting.members.length, "Restart must not duplicate the waiting child");
    const answer = { requestId: randomUUID(), revision: recovered.revision, text: "Compact" };
    const answerPath = `/teams/${waiting.id}/decisions/${decision.id}/answer`;
    assert.equal((await f.host.fetchApi(answerPath, "viewer", answer)).status, 403);
    controller = createRemoteClient({ url: f.host.origin, token: f.host.tokens.controller });
    const answered = await controller.request<TeamView>(answerPath, { body: answer });
    assert.equal(answered.decisions.find(item => item.id === decision.id)?.answer, "Compact");
    assert.equal((await f.host.fetchApi(answerPath, "controller", answer)).status, 200);
    assert.equal((await f.host.fetchApi(answerPath, "controller", { ...answer, text: "Detailed" })).status, 409);
    const steer = { requestId: randomUUID(), revision: recovered.revision, text: "Use the revised requirements for both files." };
    const steered = await controller.request<TeamView>(`/teams/${waiting.id}/steer`, { body: steer });
    assert.equal(steered.revision, recovered.revision + 1);
    const repeated = await f.host.fetchApi(`/teams/${waiting.id}/steer`, "controller", steer);
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.revision, steered.revision);
    assert.equal((await f.host.fetchApi(`/teams/${waiting.id}/steer`, "controller", { ...steer, requestId: randomUUID() })).status, 409);
    assert.ok([404, 409].includes((await f.host.fetchApi(answerPath, "controller", { ...answer, requestId: randomUUID() })).status));
    await waitFor(() => f.get(waiting.id), run => run.members.filter(member => member.revision === 2 && member.role === "implementer" && member.status === "running").length === 2, 30000);
    await f.host.stopApi(); await f.host.start();
    const durableRetry = await f.host.fetchApi(`/teams/${waiting.id}/steer`, "controller", steer);
    assert.equal(durableRetry.status, 200);
    assert.equal(durableRetry.body.revision, steered.revision);
    writeFileSync(join(f.receipts, `${waiting.id}.release`), "continue", { mode: 0o600 });
    const finished = await f.settled(waiting.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.revision, 2);
    assert.equal(readFileSync(join(finished.workspace, "a.txt"), "utf8"), "revision 2\n");
    assert.equal(readFileSync(join(finished.workspace, "b.txt"), "utf8"), "revision 2\n");
    assert.equal(finished.review?.revision, 2);
    assert.ok(finished.checks.length > 0 && finished.checks.every(check => check.revision === 2));
  } finally { controller?.close(); await f.close(); }
});

test("foreign reports and a successful process exit cannot substitute for an explicit bound report", { timeout: 60000 }, async () => {
  const f = await fixture("unreported");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const stopped = await f.settled(created.body.id);
    assert.equal(stopped.status, "blocked", JSON.stringify(stopped));
    assert.equal(stopped.tasks.length, 0);
    assert.equal(stopped.review, undefined);
    assert.ok(stopped.members.every(member => !member.report));
    assert.equal(git(f.source, "status", "--porcelain"), "");
  } finally { await f.close(); }
});

test("configured verification failures exhaust bounded repair rounds without becoming ready for review", { timeout: 120000 }, async () => {
  const f = await fixture("failed-check");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.ok(blocked.checks.length > 0);
    assert.ok(blocked.checks.every(check => check.status === "failed" && check.exitCode === 17));
    assert.ok(blocked.checks.some(check => check.output.includes("Configured verification failed")));
    assert.equal(blocked.review, undefined);
    assert.ok(blocked.members.filter(member => member.role === "integrator").length <= 2, "Repairs must have a finite attempt budget");
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  } finally { await f.close(); }
});

test("task ownership preserves filename bytes and refuses an out-of-scope file before integration", { timeout: 60000 }, async () => {
  const f = await fixture("scope-escape");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.match(blocked.reason ?? "", /outside its assigned paths/);
    assert.equal(blocked.checks.length, 0, "The scope violation must be detected before verification can fail for a missing file");
    assert.notEqual(blocked.tasks.find(task => task.id === "a")?.status, "integrated");
    assert.equal(git(f.source, "status", "--porcelain"), "");
  } finally { await f.close(); }
});

test("review approval cannot make an integration checkout changed after verification ready", { timeout: 60000 }, async () => {
  const f = await fixture("changed-after-check");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.ok(blocked.checks.some(check => check.status === "passed"), "The checkout changes only after real verification passes");
    assert.equal(readFileSync(join(blocked.workspace, "a.txt"), "utf8"), "Changed after verification\n");
    assert.equal(git(f.source, "status", "--porcelain"), "");
  } finally { await f.close(); }
});

test("a check past teams.checkMinutes blocks a resumable run without spending a correction round", { timeout: 120000 }, async () => {
  const f = await fixture("lifecycle", undefined, { teams: { checkMinutes: 0.05 } });
  let checkPid: number | undefined;
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id;
    await waitFor(async () => existsSync(join(f.receipts, "check-ready.json")), Boolean, 30000);
    checkPid = JSON.parse(readFileSync(join(f.receipts, "check-ready.json"), "utf8")).pid;
    const checking = await f.get(id);
    const blocked = await waitFor(() => f.get(id), run => run.status === "blocked", 30000);
    assert.equal(blocked.reason, checkTimeoutReason, JSON.stringify(blocked));
    assert.equal(blocked.round, 0, "A host timeout is not an agent correction round");
    assert.equal(blocked.members.length, checking.members.length, "No repair member is started for a timeout");
    assert.equal(blocked.checks.at(-1)?.status, "interrupted", JSON.stringify(blocked.checks.map(check => check.status)));
    await waitFor(async () => { try { process.kill(checkPid!, 0); return false; } catch { return true; } }, exited => exited, 5000);
    writeFileSync(join(f.receipts, "check-release"), "continue", { mode: 0o600 });
    const resume = { requestId: randomUUID(), revision: blocked.revision };
    const resumed = await waitFor(() => f.host.fetchApi(`/teams/${id}/resume`, "owner", resume), response => response.body?.code !== "members-stopping", 15000);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.revision, blocked.revision + 1);
  } finally {
    if (checkPid) { try { process.kill(-checkPid, "SIGKILL"); } catch { /* Already exited. */ } }
    await f.close();
  }
});

test("pausing a running check waits for its abort and resumes once without a late completion reopening the paused run", { timeout: 120000 }, async () => {
  const f = await fixture("lifecycle");
  let checkPid: number | undefined;
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id;
    const checking = await waitFor(() => f.get(id), run => run.status === "verifying" && run.checks.some(check => check.status === "running") && existsSync(join(f.receipts, "check-ready.json")), 30000);
    checkPid = JSON.parse(readFileSync(join(f.receipts, "check-ready.json"), "utf8")).pid;
    assert.ok(checkPid && checkPid > 1);
    const pause = { requestId: randomUUID(), revision: checking.revision };
    const paused = await f.host.fetchApi(`/teams/${id}/pause`, "owner", pause);
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.status, "paused");
    const settled = await waitFor(() => f.get(id), run => run.status === "paused" && run.reason === undefined && run.checks.some(check => check.status === "interrupted"), 10000);
    await waitFor(async () => { try { process.kill(checkPid!, 0); return false; } catch { return true; } }, exited => exited, 5000);
    assert.equal(settled.review, undefined);
    assert.ok(settled.members.every(member => member.role !== "reviewer"));
    const duplicatePause = await f.host.fetchApi(`/teams/${id}/pause`, "owner", pause);
    assert.equal(duplicatePause.body.status, "paused");
    assert.equal(duplicatePause.body.revision, checking.revision);
    // Allow the new revision's check to finish. The aborted process cannot turn
    // this marker into a late success receipt for the paused revision.
    writeFileSync(join(f.receipts, "check-release"), "continue", { mode: 0o600 });
    const resume = { requestId: randomUUID(), revision: checking.revision };
    const resumed = await f.host.fetchApi(`/teams/${id}/resume`, "owner", resume);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.revision, checking.revision + 1);
    assert.equal((await f.host.fetchApi(`/teams/${id}/resume`, "owner", resume)).body.revision, resumed.body.revision);
    const oldPauseRetry = await f.host.fetchApi(`/teams/${id}/pause`, "owner", pause);
    assert.equal(oldPauseRetry.body.revision, resumed.body.revision);
    assert.notEqual(oldPauseRetry.body.status, "paused", "Replaying an accepted old action must not apply it to the new revision");
    const finished = await f.settled(id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    assert.equal(finished.review?.revision, 2);
    assert.ok(finished.checks.some(check => check.revision === 1 && check.status === "interrupted"));
    assert.ok(finished.checks.filter(check => check.revision === 2).every(check => check.status === "passed"));
  } finally {
    if (checkPid) { try { process.kill(-checkPid, "SIGKILL"); } catch { /* Already exited. */ } }
    await f.close();
  }
});

test("steering cannot disguise a check interrupted by API restart as a new planning run", { timeout: 60000 }, async () => {
  const f = await fixture("lifecycle");
  let checkPid: number | undefined;
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id;
    const checking = await waitFor(() => f.get(id), run => run.status === "verifying" && run.checks.some(check => check.status === "running") && existsSync(join(f.receipts, "check-ready.json")), 30000);
    checkPid = JSON.parse(readFileSync(join(f.receipts, "check-ready.json"), "utf8")).pid;
    assert.ok(checkPid && checkPid > 1);
    await f.host.stopApi(); await f.host.start();
    const recovered = await f.get(id);
    assert.equal(recovered.status, "blocked");
    assert.ok(recovered.checks.some(check => check.status === "interrupted"));
    const response = await f.host.fetchApi(`/teams/${id}/steer`, "owner", {
      requestId: randomUUID(), revision: checking.revision, text: "Continue with the revised request.",
    });
    assert.equal(response.status, 409, "An orphaned check must require reconciliation rather than claim replanning");
    assert.equal(response.body.code, "team-reconciliation-required");
    const unchanged = await f.get(id);
    assert.equal(unchanged.status, "blocked");
    assert.equal(unchanged.revision, checking.revision);
    assert.deepEqual(unchanged.steering, checking.steering);
    assert.equal(unchanged.members.length, checking.members.length);
    assert.equal(unchanged.review, undefined);
  } finally {
    if (checkPid) { try { process.kill(-checkPid, "SIGKILL"); } catch { /* Already exited. */ } }
    await f.close();
  }
});

test("the stdio MCP report tool validates input, waits for the worker receipt, and deduplicates across helper restarts", { timeout: 60000 }, async () => {
  const f = await fixture("mcp");
  const children: { close: () => Promise<void> }[] = [];
  let releaseResponse: (() => void) | undefined;
  let forwardTarget = "";
  let requests = 0;
  let acknowledge!: () => void;
  const accepted = new Promise<void>(resolve => { acknowledge = resolve; });
  const proxy = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests++;
      const upstream = await fetch(`${forwardTarget}/team-report`, { method: "POST", headers: {
        "Content-Type": "application/json", Authorization: request.headers.authorization ?? "",
      }, body });
      const text = await upstream.text();
      const reply = () => { response.writeHead(upstream.status); response.end(text); };
      if (requests === 1 && upstream.status === 204) {
        releaseResponse = reply;
        acknowledge();
      } else reply();
    } catch { response.writeHead(502).end(); }
  });
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const running = await waitFor(() => f.get(created.body.id), run => run.members.some(member => member.status === "running") && existsSync(join(f.receipts, "mcp-capability.json")), 30000);
    const member = running.members[0];
    // A human lease keeps the scheduler from stopping the reported worker while
    // its receipt is retried. This uses the real worker's report ledger.
    await claimControl(f.host, member.sessionId, "owner");
    const capability = JSON.parse(readFileSync(join(f.receipts, "mcp-capability.json"), "utf8"));
    forwardTarget = capability.url;
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const port = (proxy.address() as { port: number }).port;

    function startMcp() {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/team-mcp.ts")], {
        cwd: f.source, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, INFINITE_HOOK_URL: `http://127.0.0.1:${port}/hook`,
          INFINITE_HOOK_TOKEN: capability.token, INFINITE_TEAM_ASSIGNMENT: JSON.stringify(capability.assignment) },
      });
      let next = 0;
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
      const lines = createInterface({ input: child.stdout });
      lines.on("line", text => {
        let value: any;
        try { value = JSON.parse(text); } catch {
          for (const item of pending.values()) item.reject(new Error("MCP stdout contained a non-JSON message"));
          return;
        }
        const item = pending.get(value.id);
        if (item) { pending.delete(value.id); clearTimeout(item.timer); item.resolve(value); }
      });
      // Drain diagnostics without exposing private runtime capabilities on failure.
      child.stderr.resume();
      child.on("exit", () => {
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("MCP helper exited before replying")); }
        pending.clear();
      });
      const rpc = (method: string, params: unknown = {}) => {
        const id = ++next;
        const response = new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} did not reply`)); }, 10000);
          pending.set(id, { resolve, reject, timer });
        });
        void response.catch(() => {});
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        return response;
      };
      const initialize = async () => {
        const response = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Infinite boundary test", version: "1" } });
        assert.equal(response.result.protocolVersion, "2025-11-25");
        assert.ok(response.result.capabilities.tools);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      };
      const close = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
        lines.close();
      };
      const client = { rpc, initialize, close };
      children.push(client);
      return client;
    }

    const client = startMcp();
    await client.initialize();
    const listing = await client.rpc("tools/list");
    assert.equal(listing.result.tools.length, 1);
    assert.equal(listing.result.tools[0].name, "report");
    assert.ok(listing.result.tools[0].inputSchema.properties.report);
    const invalid = await client.rpc("tools/call", { name: "report", arguments: { report: { kind: "plan", summary: "No tasks supplied" } } });
    assert.equal(invalid.result.isError, true);
    assert.equal(requests, 0, "Malformed report input must not reach the worker");
    const report = { kind: "blocked", summary: "MCP report boundary evidence" };
    const forged = await client.rpc("tools/call", { name: "report", arguments: { report, memberId: randomUUID() } });
    assert.equal(forged.result.isError, true);
    assert.equal(requests, 0, "Tool callers cannot substitute an assignment identity");
    let settled = false;
    const delivery = client.rpc("tools/call", { name: "report", arguments: { report } });
    void delivery.then(() => { settled = true; }, () => { settled = true; });
    assert.equal(await Promise.race([accepted.then(() => true), delivery.then(() => false)]), true, "The report must reach the durable worker endpoint");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, "A tool result cannot claim success before the durable endpoint acknowledgment arrives");
    const eventsBeforeAck = await f.host.fetchApi(`/sessions/${member.sessionId}/events`);
    const recorded = eventsBeforeAck.body.events.filter((event: any) => event.type === "team-report");
    assert.equal(recorded.length, 1, "The real worker already journaled the held receipt");
    assert.equal(recorded[0].data.runId, running.id);
    assert.equal(recorded[0].data.memberId, member.memberId);
    assert.equal(recorded[0].data.revision, running.revision);
    const release = releaseResponse!;
    releaseResponse = undefined;
    release();
    const delivered = await delivery;
    assert.notEqual(delivered.result.isError, true);
    assert.equal(delivered.result.structuredContent.requestId, recorded[0].data.requestId);
    assert.equal(delivered.result.structuredContent.memberId, member.memberId);
    await client.close();

    const restarted = startMcp();
    await restarted.initialize();
    const repeated = await restarted.rpc("tools/call", { name: "report", arguments: { report: { summary: report.summary, kind: report.kind } } });
    assert.notEqual(repeated.result.isError, true);
    assert.equal(repeated.result.structuredContent.requestId, delivered.result.structuredContent.requestId, "The same validated report retains its request identity across helper processes");
    const conflict = await restarted.rpc("tools/call", { name: "report", arguments: { report: { ...report, summary: "A conflicting result" } } });
    assert.equal(conflict.result.isError, true);
    const eventsAfterRetry = await f.host.fetchApi(`/sessions/${member.sessionId}/events`);
    assert.equal(eventsAfterRetry.body.events.filter((event: any) => event.type === "team-report").length, 1, "A retry or conflict must not create another recorded report");
    assert.equal(requests, 3);
  } finally {
    releaseResponse?.();
    await Promise.all(children.map(child => child.close()));
    proxy.closeAllConnections(); proxy.close();
    await f.close();
  }
});

test("OpenCode team members journal each step with its tokens and cost", { timeout: 120000 }, async () => {
  const lineup = structuredClone(mixedLineup);
  lineup.implementers = [
    lineup.implementers[0],
    { id: "deepseek-high", label: "DeepSeek implementer", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light", dataUse: "contributor" },
  ];
  const f = await fixture("usage", lineup);
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const finished = await f.settled(created.body.id);
    assert.equal(finished.status, "ready-for-review", JSON.stringify(finished));
    const implementers = finished.members.filter(member => member.role === "implementer");
    assert.equal(implementers.length, 2);
    for (const member of implementers) {
      const worker = JSON.parse(readFileSync(join(f.receipts, `${member.memberId}.json`), "utf8"));
      assert.equal(worker.provider, "opencode");
      assert.ok(worker.argv.join(" ").includes("--format json"), "Headless OpenCode must be launched with JSON output");
      const usage: any[] = [];
      for (let after = 0, more = true; more;) {
        const page = await f.host.fetchApi(`/sessions/${member.sessionId}/events?types=usage&after=${after}&limit=200`);
        assert.equal(page.status, 200);
        usage.push(...page.body.events.filter((event: any) => event.type === "usage"));
        ({ cursor: after, more } = page.body);
      }
      assert.equal(usage.length, 2, "Each step-finish is journaled once; text and plain lines are not");
      assert.equal(new Set(usage.map(event => event.data.partId)).size, 2);
      assert.ok(usage.every(event => event.data.messageId === `msg_${member.taskId}` && event.data.modelSource === "requested"));
      const [providerId, modelId] = member.modelProfile!.model.split("/");
      assert.ok(usage.every(event => event.data.providerId === providerId && event.data.modelId === modelId));
      assert.equal(usage.reduce((sum, event) => sum + event.data.tokens.input, 0), 1000);
      assert.equal(usage.reduce((sum, event) => sum + event.data.tokens.output, 0), 500);
      assert.ok(Math.abs(usage.reduce((sum, event) => sum + event.data.reportedCost, 0) - 0.5) < 1e-9);
      const signals = (await f.host.fetchApi(`/sessions/${member.sessionId}/events?types=signal&limit=200`)).body.events.map((event: any) => event.data);
      const tools = signals.filter((data: any) => data.kind === "tool-start" || data.kind === "tool-end");
      assert.deepEqual(tools.map((data: any) => [data.kind, data.tool, data.toolUseId, data.source]),
        [["tool-start", "bash", `call_${member.taskId}`, "protocol"], ["tool-end", "bash", `call_${member.taskId}`, "protocol"]],
        "A finished OpenCode tool call is journaled as activity so a long headless turn is not taken for a stall");
      assert.deepEqual(tools[0].input, {}, "Activity signals do not copy tool input into the journal");
    }
  } finally { await f.close(); }
});

const limitLineup: TeamLineup = {
  coordinator: { id: "astra-coordinator", label: "Astra coordinator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
  integrator: { id: "astra-integrator", label: "Astra integrator", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" },
  reviewer: { id: "astra-reviewer", label: "Astra reviewer", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
  implementers: [
    { id: "haiku", label: "Haiku implementer", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light", limitFallback: "deepseek-light" },
    { id: "astra-light", label: "Astra light implementer", provider: "codex", model: "gpt-6-astra", effort: "low", tier: "light" },
  ],
  fallbacks: [{ id: "deepseek-light", label: "DeepSeek Flash", provider: "opencode", model: "deepseek/deepseek-flash", variant: "high", tier: "light" }],
};
const readReceipts = (dir: string) => readdirSync(dir).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(dir, name), "utf8")));
const sessionEvents = async (host: Host, id: string, types: string) => (await host.fetchApi(`/sessions/${id}/events?types=${types}&after=0&limit=200`)).body.events as unknown[];

test("a Claude member that hits a usage limit continues on its fallback with its answers and partial work, and later Claude members launch on the fallback directly", { timeout: 120000 }, async () => {
  const run = await fixture("limit", limitLineup);
  try {
    const created = (await run.host.fetchApi("/teams", "owner", run.create())).body;
    const waiting = await waitFor(() => run.get(created.id), t => t.status === "needs-input" && t.decisions.length === 1, 45000);
    const answer = { requestId: randomUUID(), revision: waiting.revision, text: "Compact" };
    assert.equal((await run.host.fetchApi(`/teams/${waiting.id}/decisions/${waiting.decisions[0].id}/answer`, "controller", answer)).status, 200);
    const team = await run.settled(waiting.id);
    assert.equal(team.status, "ready-for-review", JSON.stringify(team));
    const task = team.tasks.find(t => t.id === "a")!;
    assert.equal(task.limitSwitches?.length, 1);
    const [switched] = task.limitSwitches!;
    const limited = team.members.find(m => m.memberId === switched.memberId)!;
    const receipts = readReceipts(run.receipts);
    const expected: string = receipts.find(r => r.memberId === limited.memberId).expectedResetsAt, hhmm = expected.slice(11, 16) + " UTC";
    assert.equal(limited.modelProfile?.id, "haiku");
    assert.equal(switched.fromProfileId, "haiku");
    assert.equal(switched.toProfileId, "deepseek-light");
    assert.equal(switched.resetsAt, expected, "The reset time comes from the provider's notice");
    assert.equal(task.escalation, undefined, "A limit switch does not use the task's escalation");
    const attempts = team.members.filter(m => m.taskId === "a");
    assert.deepEqual(attempts.map(m => m.modelProfile?.id), ["haiku", "haiku", "deepseek-light"], "The question retry and the switch are each a new member attempt");
    assert.equal(new Set(attempts.map(m => m.cwd)).size, 1);
    assert.equal(limited.status, "stopped");
    assert.equal(limited.stoppedReason, `Claude Code usage limit, resets ${hhmm}`);
    assert.deepEqual((await sessionEvents(run.host, limited.sessionId, "input-intent") as { data: { op: string } }[]).map(event => event.data.op), ["stop"], "Stopping is the only action the host takes on a limited member");
    assert.ok(team.events.some(e => e.text === `Haiku implementer hit a Claude Code usage limit (resets ${hhmm}); Build the first file continues on DeepSeek Flash with partial work preserved.`), JSON.stringify(team.events));
    assert.equal(team.providerLimits[0]?.provider, "claude");
    assert.equal(team.providerLimits[0]?.runId, team.id);
    assert.equal(team.providerLimits[0]?.expiresAt, expected, "The host entry lasts until the stated reset");
    assert.equal((await run.host.fetchApi("/me")).body.providerLimits[0]?.expiresAt, expected);
    const replacement = receipts.find(r => r.memberId === attempts[2].memberId);
    assert.equal(replacement?.model, "deepseek/deepseek-flash");
    assert.equal(replacement?.sawPartial, true, "The fallback starts in the limited member's working copy");
    const prompt: string = replacement.prompt;
    assert.match(prompt, /\n\nUser answered: Compact\n\n/, "The fallback keeps the user's recorded answer");
    assert.match(prompt, /partial edits are present in this working copy and have passed the host's path-scope check/);
    assert.ok(prompt.includes("Pipe a JSON object matching the above schema to this command:") && !prompt.includes("mcp__infinite_team__report"), "The fallback reports the OpenCode way");
    assert.ok(prompt.includes(`Requested runtime profile: ${JSON.stringify(attempts[2].modelProfile)}.`) && !prompt.includes('Requested runtime profile: {"id":"haiku"'));
    assert.equal(readFileSync(join(team.workspace, "a.txt"), "utf8"), "revision 1\n");
    assert.ok(receipts.every(receipt => receipt.trustedWorkspace === undefined && !(receipt.argv ?? []).some((arg: string) => arg.startsWith("projects="))),
      "Without owner trust in the team roots, members must keep their providers' folder prompts");

    const second = await run.settled((await run.host.fetchApi("/teams", "owner", run.create())).body.id);
    assert.ok(second.events.some(e => e.text === `Haiku implementer launched on DeepSeek Flash: Claude Code is limited until ${hhmm}`), JSON.stringify(second.events));
    assert.equal(second.members.filter(m => m.modelProfile?.provider === "claude").length, 0);
    assert.equal(second.members.find(m => m.taskId === "a")?.modelProfile?.id, "deepseek-light");
  } finally { await run.close(); }
});

test("a limited Claude integrator continues the same repair with its partial changes", { timeout: 120000 }, async () => {
  const lineup = structuredClone(fallbackLineup);
  lineup.integrator = {
    id: "haiku-integrator", label: "Claude integrator", provider: "claude", model: "claude-haiku-5-5",
    effort: "medium", tier: "light", limitFallback: "deepseek-light",
  };
  const run = await fixture("integrator-limit", lineup);
  try {
    const created = await run.host.fetchApi("/teams", "owner", run.create());
    const team = await run.settled(created.body.id);
    assert.equal(team.status, "ready-for-review", JSON.stringify(team));
    assert.ok(team.checks.some(check => check.status === "failed"), "The integrator starts only after a failed verification run");
    assert.ok(team.checks.some(check => check.status === "passed"), "The fallback finishes the repair and verification passes");
    const original = team.members.find(member => member.role === "integrator" && member.modelProfile?.id === "haiku-integrator")!;
    const fallback = team.members.find(member => member.role === "integrator" && member.modelProfile?.id === "deepseek-light")!;
    assert.match(original.stoppedReason!, /usage limit/);
    const receipts = readdirSync(run.receipts).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(run.receipts, name), "utf8")));
    const fallbackReceipt = receipts.find(receipt => receipt.memberId === fallback.memberId);
    assert.ok(fallbackReceipt?.sawPartial === true, "The fallback sees the limited integrator's partial repair");
    assert.match(fallbackReceipt.prompt, /Configured verification failed/, "The replacement receives the check feedback");
    assert.match(fallbackReceipt.prompt, /team-report\.(?:ts|js)/, "The replacement receives the host's structured report helper");
    assert.doesNotMatch(fallbackReceipt.prompt, /mcp__infinite_team__report/, "OpenCode must not inherit Claude's reporting instructions");
    assert.ok(team.members.some(member => member.role === "reviewer"));
  } finally { await run.close(); }
});

test("a usage limit with no configured fallback blocks the run with its reason and keeps the partial work", { timeout: 90000 }, async () => {
  const lineup = structuredClone(limitLineup);
  delete lineup.implementers[0].limitFallback;
  delete lineup.fallbacks;
  const run = await fixture("limit-no-fallback", lineup);
  try {
    const team = await run.settled((await run.host.fetchApi("/teams", "owner", run.create())).body.id);
    assert.equal(team.status, "blocked", JSON.stringify(team));
    const limited = team.members.find(m => m.modelProfile?.id === "haiku")!;
    const expected: string = readReceipts(run.receipts).find(r => r.memberId === limited.memberId).expectedResetsAt;
    assert.equal(team.reason, `Claude Code usage limit reached at ${team.providerLimits[0]?.detectedAt.slice(11, 16)} UTC, resets ${expected.slice(11, 16)} UTC; no fallback profile is configured for haiku.`);
    assert.equal(team.members.filter(m => m.taskId === "a").length, 1);
    assert.equal(limited.status, "stopped");
    assert.equal(readFileSync(join(limited.cwd, "a.txt"), "utf8"), "partial\n");
  } finally { await run.close(); }
});

test("permission coordinator prompt reviews Codex command dialogs against changed-path and accepted-check evidence", () => {
  const run = { provider: "codex", revision: 1, objective: "Run the task checks", projectId: "project", permissions: { mode: "coordinator", scope: "Pinned one-time task scope" }, steering: [], tasks: [], checks: [] } as unknown as TeamRun;
  const evidence = JSON.stringify({
    targetChangedPaths: ["src/task.ts"],
    targetChangedPathCount: 1,
    acceptedChecks: [{ command: "npm", args: ["test"] }],
  });
  const prompt = teamPrompt(run, "permission-coordinator", undefined, evidence, "claude", limitLineup.coordinator);
  assert.match(prompt, /Would you like to run the following command\?/);
  assert.match(prompt, /feedback\.targetChangedPaths, feedback\.targetChangedPathCount, and feedback\.acceptedChecks/);
  assert.match(prompt, /targetChangedPathCount exceeds the number of listed targetChangedPaths/);
  assert.match(prompt, /package manifests or scripts, lockfiles, Makefiles, test\/build\/tsconfig configuration, or files under scripts directories/);
  assert.match(prompt, /exact command only runs the assigned task's tests or exactly matches an accepted check in the target workspace/);
  assert.match(prompt, /no install, download, publish, deploy, credential, or global-setting effect/);
  assert.match(prompt, /Owner-authorized permission scope \(pinned for this run\):\nPinned one-time task scope/);
  assert.match(prompt, /host rechecks the exact prompt and all current authority and alone applies any answer/);
  assert.ok(prompt.includes(evidence));
});

test("Codex sandbox guidance covers members but excludes the permission coordinator", () => {
  const run = { provider: "codex", revision: 1, objective: "Run task checks", projectId: "project", permissions: { mode: "coordinator", scope: "Pinned scope" }, steering: [], tasks: [], checks: [] } as unknown as TeamRun;
  const member = teamPrompt(run, "implementer", undefined, undefined, "codex", limitLineup.implementers[1]);
  assert.match(member, /no network access and cannot start local listeners or IPC sockets/);
  assert.match(member, /typecheck, lint, and unit tests that need no server/);
  assert.match(member, /one-time run of this task's tests or an accepted check that cannot run in the sandbox/);
  assert.match(member, /Never request persistent approval/);
  assert.match(member, /Report skipped checks and why; the host runs accepted checks after integration/);
  const coordinator = teamPrompt(run, "permission-coordinator", undefined, "evidence", "codex", limitLineup.coordinator);
  assert.doesNotMatch(coordinator, /Codex sandbox guidance:/);
  const switchedCoordinator = retargetPrompt(
    teamPrompt(run, "permission-coordinator", undefined, "evidence", "claude", limitLineup.coordinator),
    { provider: "codex", profile: limitLineup.coordinator },
  );
  assert.doesNotMatch(switchedCoordinator!, /Codex sandbox guidance:/);
});

test("retargeting a member prompt keeps its answers, swaps reporting and profile, and refuses an unrecognized prompt", () => {
  const run = { provider: "codex", revision: 1, objective: "Create a.txt", baseCommit: "base", headCommit: "head", steering: [], tasks: [], checks: [], lineup: limitLineup } as unknown as TeamRun;
  const [haiku, astra] = limitLineup.implementers, deepseek = limitLineup.fallbacks![0];
  const answered = (provider: TeamModelProfile["provider"], profile: TeamModelProfile) => `${teamPrompt(run, "implementer", undefined, undefined, provider, profile)}\n\nUser answered: Compact`;
  assert.equal(retargetPrompt(answered("claude", haiku), { provider: "opencode", profile: deepseek }), answered("opencode", deepseek));
  const oldHelper = teamPrompt(run, "implementer", undefined, undefined, "opencode", astra);
  const refreshed = refreshReportingInstructions(oldHelper, "codex");
  assert.match(refreshed, /report tool of the infinite_team MCP server/);
  assert.doesNotMatch(refreshed, /Pipe a JSON object matching the above schema to this command:/);
  assert.equal(retargetPrompt(oldHelper, { provider: "codex", profile: astra }), teamPrompt(run, "implementer", undefined, undefined, "codex", astra));
  assert.match(retargetPrompt(oldHelper, { provider: "codex", profile: astra })!, /Codex sandbox guidance:/);
  // A Codex prompt written by an earlier release names its helper, at another release's path.
  const older = oldHelper.replace(/to this command: [^\n]+?\. The helper/, "to this command: 'node' 'dist/team-report.js'. The helper");
  assert.notEqual(older, oldHelper);
  assert.equal(refreshReportingInstructions(`${older}\n\nUser answered: Compact`, "codex"), `${refreshed}\n\nUser answered: Compact`);
  assert.equal(retargetPrompt(answered("claude", haiku), { provider: "codex", profile: astra }), answered("codex", astra));
  const oldCodex = teamPrompt(run, "implementer", undefined, undefined, "codex", astra).replace(/Codex sandbox guidance:[^\n]+\n\n/, "");
  assert.match(retargetPrompt(oldCodex, { provider: "codex", profile: astra })!, /Codex sandbox guidance:/, "an older accumulated Codex prompt gains the current paragraph");
  const switchedAway = retargetPrompt(answered("codex", astra), { provider: "opencode", profile: deepseek });
  assert.equal(switchedAway, answered("opencode", deepseek));
  assert.doesNotMatch(switchedAway!, /Codex sandbox guidance:/);
  assert.equal(retargetPrompt("Do the work and say when you are done.", { provider: "opencode", profile: deepseek }), undefined);
});

test("project-manager prompts list configured setup and checks and forbid unauthorized verification", () => {
  const run = { provider: "demo", revision: 1, projectId: "example-project", objective: "Implement a small feature", baseCommit: "base", headCommit: "base", steering: [], tasks: [], checks: [] } as unknown as TeamRun;
  const configuredProject = {
    setup: { command: "npm", args: ["ci"] },
    checks: [{ command: "npm", args: ["run", "check"] }],
  };
  const prompt = teamPrompt(run, "project-manager", undefined, undefined, "demo", undefined, configuredProject);
  assert.ok(prompt.includes(JSON.stringify(configuredProject)));
  assert.match(prompt, /checks run after integration and are fixed/);
  assert.match(prompt, /plan MUST NOT include verification/);
  assert.match(prompt, /say so in the summary and have tasks run additional commands \(such as a workspace's lint or typecheck\) themselves and report results/);
});

test("a rejected team report exposes the host's actionable 4xx response", async () => {
  const message = "Plan rejected: remove verification and submit a corrected plan.";
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" }).end(message));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const env = {
      INFINITE_HOOK_URL: `http://127.0.0.1:${port}/hook`,
      INFINITE_HOOK_TOKEN: "fixture-token",
      INFINITE_TEAM_ASSIGNMENT: JSON.stringify({ runId: randomUUID(), memberId: randomUUID(), revision: 1 }),
    } as NodeJS.ProcessEnv;
    await assert.rejects(submitTeamReport({ kind: "result", summary: "Fixture report" }, env), error => {
      assert.equal(reportErrorMessage(error), message);
      return true;
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("an unanswered report stays unconfirmed: a refused connection or a lost acknowledgement names the sandbox and requires inspection", async () => {
  const env = (port: number) => ({
    INFINITE_HOOK_URL: `http://127.0.0.1:${port}/hook`,
    INFINITE_HOOK_TOKEN: "fixture-token",
    INFINITE_TEAM_ASSIGNMENT: JSON.stringify({ runId: randomUUID(), memberId: randomUUID(), revision: 1 }),
  } as NodeJS.ProcessEnv);
  const unconfirmed = (error: unknown) => {
    const message = reportErrorMessage(error);
    assert.match(message, /delivery was not confirmed/);
    assert.match(message, /sandbox or network policy may block local connections, or the acknowledgement was lost/);
    assert.match(message, /inspect this member's recorded report before retrying the identical report, and do not bypass/);
    return true;
  };
  // Nothing listens: the request never left this process.
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => closed.close(error => error ? reject(error) : resolve()));
  await assert.rejects(submitTeamReport({ kind: "result", summary: "The fixture could not reach its closed endpoint." }, env(closedPort)), unconfirmed);
  // The endpoint read the whole report, then dropped the connection before answering.
  let received = 0;
  const lost = createServer((request, response) => { request.resume(); request.on("end", () => { received++; response.destroy(); }); });
  await new Promise<void>(resolve => lost.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(submitTeamReport({ kind: "result", summary: "The fixture lost its acknowledgement." }, env((lost.address() as { port: number }).port)), unconfirmed);
    assert.equal(received, 1);
  } finally { lost.closeAllConnections(); await new Promise<void>(resolve => lost.close(() => resolve())); }
});

for (const limited of [false, true])
test(`a report written during a stall stop wins over replacement${limited ? " and a provider limit" : ""}`, async () => {
  const f = schedulerFixture();
  try {
    const member = f.run.members[0];
    const report = { kind: "question", question: "Which scope should this assignment use?", options: ["Keep the current scope"] };
    f.manager.stopTeamSession = async () => {
      if (f.state.status !== "exited") {
        // The pre-stop journal is empty. The report arrives only while the stop RPC is in flight.
        if (limited) f.journal.append("signal", { kind: "provider-limit", limit: "usage", confidence: "corroborated", provider: "demo", source: "protocol", message: "Usage exhausted" });
        for (let index = 0; index < 205; index++) f.journal.append("signal", { kind: "notice", type: "fixture" });
        const envelope = { requestId: randomUUID(), runId: f.run.id, memberId: member.memberId, revision: member.revision, report };
        f.journal.append("team-report", { ...envelope, runId: randomUUID() });
        f.journal.append("team-report", { ...envelope, memberId: randomUUID() });
        f.journal.append("team-report", { ...envelope, revision: member.revision + 1 });
        f.journal.append("team-report", envelope);
        f.journal.append("lifecycle", { status: "exited" });
        f.state.status = "exited";
      }
      return f.manager.state();
    };
    f.writeTeam();
    const teams = f.openTeam(); teams.start();
    const result = await waitFor(async () => teams.get(f.run.id), run => run.decisions.length > 0 || run.members.length > 1 || run.status === "blocked");
    assert.equal(result.members.length, 1, "A final report must prevent a replacement launch");
    assert.deepEqual(result.members[0].report, report);
    assert.equal(result.members[0].stalledAt, undefined);
    assert.equal(result.members[0].stoppedReason, undefined);
    assert.equal(result.status, "needs-input");
    assert.equal(result.decisions[0].question, report.question, "The ordinary reported path must consume the late report");
  } finally { f.close(); }
});

for (const protection of ["activity", "needs-you", "pending-limit"] as const)
test(`a refused stall stop rechecks ${protection} after the human lease is released`, async () => {
  const f = schedulerFixture();
  try {
    let stops = 0;
    f.manager.stopTeamSession = async () => {
      stops++;
      throw Object.assign(new Error("Input control is held"), { code: "control-busy" });
    };
    f.writeTeam();
    const teams = f.openTeam(); teams.start();
    const refused = await waitFor(async () => teams.get(f.run.id), run => run.members[0].status === "unavailable");
    assert.equal(stops, 1);
    assert.equal(refused.members[0].stalledAt, undefined, "A refused stop must not authorize a later stop");
    assert.equal(refused.members[0].stoppedReason, undefined);
    if (protection === "activity") f.state.attention.lastActivityAt = new Date().toISOString();
    if (protection === "needs-you") f.state.attention.state = "needs-you";
    if (protection === "pending-limit") f.state.attention.limit = { limit: "usage", confidence: "single-source", since: new Date().toISOString(), message: "Limit pending" };
    f.manager.stopTeamSession = async () => { stops++; f.state.status = "exited"; return f.manager.state(); };
    const reads = f.reads();
    await waitFor(async () => f.reads(), value => value >= reads + 2);
    const current = teams.get(f.run.id);
    assert.equal(stops, 1, "Releasing the lease must not override current eligibility");
    assert.equal(current.members.length, 1);
    assert.equal(f.state.status, "running");
  } finally { f.close(); }
});

for (const [protection, earlierStop, refusal] of [
  ["activity", false, "manager"], ["needs-you", false, "manager"],
  ["activity", true, "manager"], ["needs-you", true, "manager"], ["activity", true, "lease"],
] as const)
test(`a ${refusal} pre-delivery refusal with ${protection} ${earlierStop ? "retains an earlier uncertain stop" : "requires fresh eligibility"}`, async () => {
  const f = schedulerFixture();
  try {
    let stops = 0;
    const member = f.run.members[0];
    f.manager.stopTeamSession = async () => {
      stops++;
      if (earlierStop && stops === 1) throw new Error("Worker response timed out; delivery may be uncertain");
      if (refusal === "lease") throw Object.assign(new Error("Input control is held"), { code: "control-busy" });
      // Exercise Manager's own state check after the scheduler observed a running member.
      return Manager.prototype.stopTeamSession.call({
        meta: () => ({ session: { team: member } }),
        state: async () => ({ ...await f.manager.state(), status: "unavailable" }),
      } as unknown as Manager, member.sessionId, member.stopRequestId, member);
    };
    f.writeTeam();
    const teams = f.openTeam(); teams.start();
    await waitFor(async () => teams.get(f.run.id), run => run.members[0].status === "unavailable");
    if (protection === "activity") f.state.attention.lastActivityAt = new Date().toISOString();
    else f.state.attention.state = "needs-you";
    if (earlierStop) {
      await waitFor(async () => stops, count => count >= 2);
      assert.ok(teams.get(f.run.id).members[0].stalledAt, "An uncertain earlier delivery cannot be undone by a later preflight refusal");
    } else {
      assert.equal(teams.get(f.run.id).members[0].stalledAt, undefined);
      assert.equal(teams.get(f.run.id).members[0].stoppedReason, undefined);
      f.manager.stopTeamSession = async () => { stops++; f.state.status = "exited"; return f.manager.state(); };
      const reads = f.reads();
      await waitFor(async () => f.reads(), count => count >= reads + 2);
      assert.equal(stops, 1, "Manager sent no stop, so eligibility must be checked again");
      assert.equal(f.state.status, "running");
      assert.equal(teams.get(f.run.id).members.length, 1);
    }
  } finally { f.close(); }
});

test("a member back from an outage into a delegable prompt runs again and gets a permission decision", async () => {
  const f = schedulerFixture();
  try {
    f.run.members[0].status = "unavailable";
    f.run.permissions = { mode: "coordinator", scope: "Approve one-time runs of the accepted checks.", maxDecisions: 2 };
    f.run.lineup = { ...fallbackLineup, coordinator: { ...fallbackLineup.coordinator, provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" } };
    f.state.attention.state = "needs-you";
    f.state.attention.prompt = { id: 1, kind: "permission", source: "screen", hash: "a".repeat(64), pinned: true, acceptsText: false,
      title: "Would you like to run the following command?", detail: "Environment: local\n$ npm run check",
      options: [{ index: 0, label: "Yes, proceed (y)", role: "accept" }, { index: 1, label: "No, and tell Codex what to do differently (esc)", role: "reject-with-feedback" }] };
    f.writeTeam();
    const teams = f.openTeam(); teams.start();
    const result = await waitFor(async () => teams.get(f.run.id), run => (run.permissionDecisions?.length ?? 0) > 0);
    assert.equal(result.members[0].status, "running");
    assert.equal(result.permissionDecisions?.[0].status, "escalated");
    assert.match(result.permissionDecisions?.[0].reason ?? "", /coordinator provider is not configured/);
  } finally { f.close(); }
});

test("an old member that still shows activity is not stalled after a restart", { timeout: 60000 }, async () => {
  const f = await fixture("mcp");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const id = created.body.id;
    await waitFor(() => f.get(id), run => run.members.some(member => member.status === "running" && member.startedAt), 30000);
    await f.host.stopApi();
    const key = readFileSync(f.host.config.keyFile);
    const file = join(f.host.config.stateDir, "teams", `${id}.sealed`);
    const stored = unseal<{ run: { members: { startedAt?: string }[] } }>(key, `team:${id}`, readFileSync(file, "utf8"));
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    for (const member of stored.run.members) member.startedAt = startedAt;
    writeSealed(file, key, `team:${id}`, stored);
    await f.host.start();
    // The host observes attention activity before deciding a member is stalled, so the observation is the proof.
    const observed = await waitFor(() => f.get(id), run => run.members.some(member => member.lastActivityAt), 30000);
    assert.notEqual(observed.status, "blocked", JSON.stringify(observed));
    assert.ok(observed.members.some(member => member.status === "running"), JSON.stringify(observed.members));
  } finally { await f.close(); }
});

test("stall detection drains the report tail before replacing a member", { timeout: 90000 }, async () => {
  const root = mkdtempSync("/tmp/inf-stall-tail-");
  const offset = join(root, "offset"), preload = join(root, "clock.mjs");
  writeFileSync(offset, "0");
  writeFileSync(preload, `import { readFileSync } from "node:fs";
const offsetFile = process.env.INFINITE_TEST_CLOCK_FILE;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  static now() { return RealDate.now() + Number(readFileSync(offsetFile, "utf8")); }
  constructor(...args) { super(...(args.length ? args : [globalThis.Date.now()])); }
};
`);
  const env = { INFINITE_TEST_CLOCK_FILE: offset, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" ") };
  const f = await fixture("mcp", undefined, { teams: { stallMinutes: 5 } }, { env });
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create()), id = created.body.id;
    const initial = await waitFor(() => f.get(id), run => run.members.some(member => member.status === "running" && member.startedAt), 30000);
    const member = initial.members[0];
    const capabilityFile = join(f.receipts, "mcp-capability.json");
    await waitFor(async () => existsSync(capabilityFile), Boolean, 10000);
    const capability = JSON.parse(readFileSync(capabilityFile, "utf8"));
    await f.host.stopApi();
    for (let index = 0; index < 110; index++) {
      for (const hook_event_name of ["PreToolUse", "PostToolUse"]) {
        const response = await fetch(`${capability.url}/claude`, { method: "POST", headers: { Authorization: `Bearer ${capability.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ hook_event_name, tool_name: "Read", tool_input: { file_path: "original.txt" }, tool_response: { type: "text" } }) });
        assert.equal(response.status, 204);
      }
    }
    writeFileSync(offset, String(6 * 60 * 1000));
    const report = { requestId: randomUUID(), runId: member.runId, memberId: member.memberId, revision: member.revision,
      report: { kind: "plan", summary: "Read the project and prepare two scoped tasks", tasks: [
        { id: "a", title: "Build the first file", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [] },
        { id: "b", title: "Build the second file", instructions: "Write b.txt", paths: ["b.txt"], dependsOn: [] },
      ] } };
    const reported = await fetch(`${capability.url}/team-report`, { method: "POST", headers: { Authorization: `Bearer ${capability.token}`, "Content-Type": "application/json" }, body: JSON.stringify(report) });
    assert.equal(reported.status, 204);
    await f.host.start();
    const drained = await waitFor(() => f.get(id), run => Boolean(run.members[0]?.report) || run.members.length > initial.members.length || run.status === "blocked", 30000);
    assert.equal(drained.members.length, initial.members.length, "An unread event tail must not trigger a replacement");
    assert.equal(drained.members[0].report?.kind, "plan", JSON.stringify(drained));
    assert.notEqual(drained.status, "blocked", JSON.stringify(drained));
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a stalled member is replaced once, and a second stall blocks a resumable run", { timeout: 90000 }, async () => {
  const root = mkdtempSync("/tmp/inf-stall-clock-");
  const offset = join(root, "offset");
  const preload = join(root, "clock.mjs");
  writeFileSync(offset, "0");
  writeFileSync(preload, `import { readFileSync } from "node:fs";
const offsetFile = process.env.INFINITE_TEST_CLOCK_FILE;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  static now() { return RealDate.now() + Number(readFileSync(offsetFile, "utf8")); }
  constructor(...args) { super(...(args.length ? args : [globalThis.Date.now()])); }
};
`);
  const env = {
    INFINITE_TEST_CLOCK_FILE: offset,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(" "),
  };
  const f = await fixture("stall-slow-stop", undefined, { teams: { stallMinutes: 5 } }, { env });
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    const id = created.body.id;
    const first = await waitFor(() => f.get(id), run => run.members.some(member => member.status === "running" && member.startedAt), 30000);
    await f.host.stopApi();
    const key = readFileSync(f.host.config.keyFile);
    const file = join(f.host.config.stateDir, "teams", `${id}.sealed`);
    const scope = `team:${id}`;
    const stored = unseal<{ run: { members: { startedAt?: string; lastActivityAt?: string }[] } }>(key, scope, readFileSync(file, "utf8"));
    const lastActivityAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    for (const member of stored.run.members) { member.startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); member.lastActivityAt = lastActivityAt; }
    writeSealed(file, key, scope, stored);
    writeFileSync(offset, String(6 * 60 * 1000));
    await f.host.start();
    const stopping = await waitFor(() => f.get(id), run => Boolean(run.members[0]?.stalledAt) && run.members.length === first.members.length, 10000);
    const stillRunning = await f.host.fetchApi(`/sessions/${first.members[0].sessionId}`);
    assert.equal(stillRunning.status, 200);
    assert.equal(stillRunning.body.status, "running", "The stall intent is durable while SIGTERM is still settling");
    assert.ok(stopping.members[0].stalledAt);
    const replaced = await waitFor(() => f.get(id), run => run.members.length === first.members.length + 1, 30000);
    const replacement = replaced.members.at(-1)!;
    assert.equal(replacement.role, first.members[0].role);
    assert.equal(replacement.taskId, first.members[0].taskId);
    assert.equal(replacement.cwd, first.members[0].cwd, "The replacement uses the preserved workspace");
    const saved = unseal<{ run: { members: { memberId: string; prompt: string }[] } }>(key, scope, readFileSync(file, "utf8"));
    assert.match(saved.run.members.find(member => member.memberId === replacement.memberId)!.prompt, /stalled with no activity for 5 minutes.*workspace was preserved/);
    assert.ok(replaced.members[0].stalledAt);
    assert.ok(replaced.events.some(event => event.text.includes("workspace was preserved")));

    await waitFor(() => f.get(id), run => run.members.some(member => member.memberId === replacement.memberId && member.status === "running" && member.startedAt), 30000);
    writeFileSync(offset, String(12 * 60 * 1000));
    const blocked = await waitFor(() => f.get(id), run => run.status === "blocked" && run.reason === memberStallReason && run.resumable && run.members.every(member => ["stopped", "waiting"].includes(member.status)), 30000);
    assert.equal(blocked.members.filter(member => member.taskId === replacement.taskId).length, 2);
    assert.equal(blocked.resumable, true);
    const body = { requestId: randomUUID(), revision: blocked.revision };
    const resumed = await waitFor(() => f.host.fetchApi(`/teams/${id}/resume`, "owner", body), response => response.status === 200, 30000);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "planning");
    assert.equal(resumed.body.revision, blocked.revision + 1);
  } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
