import test from "node:test";
import { ProviderLimits } from "../packages/host/src/provider-limits.js";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRemoteClient, type RemoteClient } from "@infinite/remote";
import { claimControl, startHost, waitFor, type Host } from "./helpers.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { memberTimeLimitReason } from "../packages/host/src/teams.js";
import type { CreateTeam, TeamLineup, TeamView } from "../packages/host/src/team-types.js";

import { git, limitLineup, mixedLineup, fixture } from "./team-fixture.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";

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

test("a coordinator cannot replace checks configured by the project owner", { timeout: 60000 }, async () => {
  const f = await fixture("bootstrap-override");
  try {
    const created = await f.host.fetchApi("/teams", "owner", f.create());
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const blocked = await f.settled(created.body.id);
    assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
    assert.match(blocked.reason ?? "", /verification|check|configured/i);
    assert.equal(blocked.tasks.length, 0);
    assert.deepEqual(blocked.members.map(member => member.role), ["project-manager"]);
  } finally { await f.close(); }
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

test("mixed teams pin real worker launches across configuration changes, restart, and a question retry", { timeout: 120000 }, async () => {
  const f = await fixture("mixed", mixedLineup);
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
      } else {
        assert.equal(worker.model, expected.model);
        assert.equal(worker.variant, expected.variant);
        assert.match(worker.prompt, /You are the team's implementer/);
        assert.ok(!args.includes("--prompt") && !args.includes("--effort") && !args.includes("--auto"));
      }
      const session = await f.host.fetchApi(`/sessions/${member.sessionId}`);
      assert.equal(session.status, 200);
      assert.equal(session.body.provider, expected.provider);
    }
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
    }
  } finally { await f.close(); }
});

test("a Claude usage limit preserves partial work on its fallback and informs later runs", { timeout: 120000 }, async () => {
  const run = await fixture("limit", limitLineup);
  try {
    const created = await run.host.fetchApi("/teams", "owner", run.create());
    const team = await run.settled(created.body.id);
    assert.equal(team.status, "ready-for-review", JSON.stringify(team));
    const task = team.tasks.find(value => value.id === "a")!;
    assert.equal(task.limitSwitches?.length, 1);
    assert.equal(task.limitSwitches![0].fromProfileId, "haiku");
    assert.equal(task.limitSwitches![0].toProfileId, "deepseek-light");
    assert.equal(task.limitSwitches![0].resetsAt?.slice(11, 16), "15:45");
    assert.equal(team.members.filter(member => member.taskId === "a").length, 2);
    assert.match(team.members.find(member => member.modelProfile?.id === "haiku")!.stoppedReason!, /usage limit/);
    assert.equal(team.providerLimits[0]?.provider, "claude");
    const receipts = readdirSync(run.receipts).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(run.receipts, name), "utf8")));
    assert.ok(receipts.some(receipt => receipt.runId === team.id && receipt.model === "deepseek/deepseek-flash" && receipt.sawPartial === true));

    const nextCreated = await run.host.fetchApi("/teams", "owner", run.create());
    const next = await run.settled(nextCreated.body.id);
    assert.equal(next.status, "ready-for-review", JSON.stringify(next));
    assert.ok(next.events.some(event => /launched on DeepSeek Flash/.test(event.text)));
    assert.equal(next.members.filter(member => member.modelProfile?.provider === "claude").length, 0);
  } finally { await run.close(); }
});

test("a Claude usage limit blocks the run when no fallback profile is configured", { timeout: 90000 }, async () => {
  const lineup = structuredClone(limitLineup);
  delete lineup.implementers[0].limitFallback;
  delete lineup.fallbacks;
  const run = await fixture("limit-no-fallback", lineup);
  try {
    const created = await run.host.fetchApi("/teams", "owner", run.create());
    const team = await run.settled(created.body.id);
    assert.equal(team.status, "blocked", JSON.stringify(team));
    assert.match(team.reason!, /usage limit reached.*no fallback profile is configured for haiku/);
    assert.match(team.members.find(member => member.modelProfile?.id === "haiku")!.stoppedReason!, /usage limit/);
    assert.equal(team.tasks.find(task => task.id === "a")?.limitSwitches?.length ?? 0, 0);
    assert.equal(team.tasks.find(task => task.id === "a")?.status, "running");
  } finally { await run.close(); }
});

test("a limited Claude integrator continues the same repair with its partial changes", { timeout: 120000 }, async () => {
  const lineup = structuredClone(limitLineup);
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

test("a failed Claude turn in another session does not clear the corroborated provider limit", { timeout: 120000 }, async () => {
  const lineup = structuredClone(limitLineup);
  lineup.implementers[1] = {
    id: "haiku-b", label: "Second Claude implementer", provider: "claude", model: "claude-haiku-5-5",
    effort: "medium", tier: "light", limitFallback: "deepseek-light",
  };
  const run = await fixture("limit-other-failed", lineup);
  try {
    const firstCreated = await run.host.fetchApi("/teams", "owner", run.create());
    const first = await run.settled(firstCreated.body.id);
    assert.equal(first.status, "ready-for-review", JSON.stringify(first));
    assert.ok(first.providerLimits.some(limit => limit.provider === "claude" && limit.confidence === "corroborated"), "The screen and hook preserve a corroborated Claude limit");

    const nextCreated = await run.host.fetchApi("/teams", "owner", run.create());
    const next = await run.settled(nextCreated.body.id);
    assert.equal(next.status, "ready-for-review", JSON.stringify(next));
    assert.ok(next.events.some(event => /launched on DeepSeek Flash/.test(event.text)), "A failed turn from the other Claude session does not release the limit for a later run");
    assert.equal(next.members.filter(member => member.modelProfile?.provider === "claude").length, 0);
  } finally { await run.close(); }
});

test("provider limit memory expires and successful clearing survives restart without stale replay", () => {
  const root = mkdtempSync("/tmp/inf-limits-");
  try {
    const file = join(root, "limits.sealed"), key = Buffer.alloc(32, 7);
    const observation = { provider: "claude" as const, detectedAt: "2026-10-18T10:00:00.000Z", sessionId: randomUUID(), confidence: "corroborated" as const };
    let limits = new ProviderLimits(file, key);
    limits.observe(observation);
    assert.equal(limits.active(new Date("2026-10-18T10:14:59Z")).length, 1);
    assert.equal(limits.active(new Date("2026-10-18T10:15:00Z")).length, 0);
    limits.observe({ ...observation, detectedAt: "2026-10-18T11:00:00.000Z", resetsAt: "2026-10-21T10:00:00.000Z" });
    assert.equal(limits.active(new Date("2026-10-18T12:00:00Z"))[0].expiresAt, "2026-10-19T11:00:00.000Z");
    limits.clear("claude", "2026-10-18T12:00:00.000Z");
    limits = new ProviderLimits(file, key);
    limits.observe(observation);
    assert.deepEqual(limits.active(new Date("2026-10-18T12:01:00Z")), []);
    limits.observe({ ...observation, detectedAt: "2026-10-18T12:02:00.000Z" });
    assert.equal(limits.active(new Date("2026-10-18T12:03:00Z")).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a team blocked by the one-hour member limit resumes into a fresh plan", { timeout: 60000 }, async () => {
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
    const blocked = await waitFor(() => f.get(id), run => run.status === "blocked" && run.reason === memberTimeLimitReason && run.resumable === true && run.members.every(member => !["queued", "running", "reported", "unavailable"].includes(member.status)), 30000);
    const head = blocked.headCommit;
    const resumed = await f.host.fetchApi(`/teams/${id}/resume`, "owner", { requestId: randomUUID(), revision: blocked.revision });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.status, "planning");
    assert.equal(resumed.body.revision, blocked.revision + 1);
    assert.equal(resumed.body.reason, undefined);
    assert.equal(resumed.body.resumable, false);
    assert.equal(resumed.body.headCommit, head);
    assert.equal(resumed.body.members.length, blocked.members.length);
  } finally { await f.close(); }
});
