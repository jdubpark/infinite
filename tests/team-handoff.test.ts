import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawn as spawnPty } from "node-pty";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost, waitFor, claimControl } from "./helpers.js";
import { git, mixedLineup } from "./team-fixture.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";

async function fixture(optIn = true, externalCmux = false, teamOptions: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync("/tmp/inf-handoff-")), source = join(root, "source"), receipts = join(root, "receipts");
  mkdirSync(source); mkdirSync(receipts);
  git(source, "init", "--initial-branch=main"); writeFileSync(join(source, "original.txt"), "Preserve the source.\n");
  git(source, "add", "original.txt"); git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
  const base = git(source, "rev-parse", "HEAD");
  const profile = { command: process.execPath, args: [resolve("tests/fixtures/handoff-agent.mjs"), receipts] };
  const lineup = { ...mixedLineup, implementers: [mixedLineup.implementers[1]] };
  let external: ReturnType<typeof spawnPty> | undefined, externalExited = false;
  let externalStopped: Promise<void> | undefined;
  const hooksDir = join(root, "hooks"), cmuxCommand = join(root, "cmux-fixture.mjs");
  const nativeId = randomUUID();
  if (externalCmux) {
    mkdirSync(hooksDir);
    writeFileSync(cmuxCommand, `#!${process.execPath}\n${readFileSync(resolve("tests/fixtures/handoff-agent.mjs"), "utf8")}`);
    chmodSync(cmuxCommand, 0o700);
    external = spawnPty(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: source, env: process.env, cols: 80, rows: 24 });
    externalStopped = new Promise(done => external!.onExit(() => { externalExited = true; done(); }));
    writeFileSync(join(hooksDir, "claude-hook-sessions.json"), JSON.stringify({ sessions: { [nativeId]: {
      sessionId: nativeId, surfaceId: "external-surface", workspaceId: "external-workspace", cwd: source,
      pid: external.pid, agentLifecycle: "running", updatedAt: Date.now() / 1000,
    } } }));
  }
  const host = await startHost({ agents: { claude: profile, codex: profile }, config: {
    projects: [...(externalCmux ? [{ id: "source-alias", name: "Source alias", path: source }] : []), { id: "rehearsal", name: "Rehearsal", path: source, team: { ...(optIn ? { handoff: "auto" as const } : {}), ...teamOptions, checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }] } }],
    teams: { workspaceDir: join(root, "teams"), lineup },
    ...(externalCmux ? { cmux: { enabled: true, command: cmuxCommand, hooksDir } } : {}),
  } });
  const create = async (nativeArgs: string[] = [], provider = "claude") => {
    const response = await host.fetchApi("/sessions", "owner", { requestId: randomUUID(), projectId: "rehearsal", provider, title: "Bounded task", prompt: "", nativeArgs });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = response.body.id;
    const receipt = await waitFor(async () => {
      const state = await host.fetchApi(`/sessions/${id}`);
      const file = join(receipts, `${state.body.pid}.json`);
      try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
    }, Boolean);
    return { id, receipt };
  };
  const view = async (id: string) => (await host.fetchApi(`/sessions/${id}/handoff`)).body;
  return { host, source, receipts, base, create, view, nativeId, external, close: async () => {
    try { await host.stop(); } finally {
      if (external && !externalExited) external.kill();
      await externalStopped;
      rmSync(root, { recursive: true, force: true });
    }
  } };
}
async function tool(server: any, request: unknown) {
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; child.stdout.on("data", value => stdout += value); child.stderr.resume();
  child.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Handoff process test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "handoff", arguments: request } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try { await new Promise<void>((done, reject) => { child.once("error", reject); child.once("exit", () => done()); }); }
  finally { clearTimeout(timer); }
  const reply = stdout.trim().split("\n").map(value => JSON.parse(value)).find(value => value.id === 2);
  assert.ok(reply?.result, "The generated MCP command must return a tool receipt");
  return reply.result;
}
const request = (head: string) => ({ backgroundWorkStopped: true, objective: "Inspect whether the source needs parallel implementation", reason: "Independent review may resolve the task", summary: "No partial edits remain", checkpointHead: head, parallelism: 2 });

test("authenticated handoff refuses dirty source, waits for its lease, and survives restart as one bounded team", { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const { id, receipt } = await f.create([]);
    assert.ok(receipt.server, "An empty ordinary Claude launch must expose the scoped handoff tool");
    assert.equal((await f.view(id)).status, "available");
    assert.ok(!receipt.argv.some((arg: string) => /allowedTools|dangerously-skip-permissions/.test(arg)), "Handoff must not grant tool permission");
    const lease = await claimControl(f.host, id, "owner");
    assert.equal((await tool({ ...receipt.server, env: { ...receipt.server.env, INFINITE_HANDOFF_SESSION: randomUUID() } }, request(f.base))).isError, true, "A valid capability cannot target another session");
    assert.equal((await tool(receipt.server, { ...request(f.base), backgroundWorkStopped: false })).isError, true);
    assert.equal((await tool(receipt.server, { ...request(f.base), summary: "x".repeat(4001) })).isError, true);
    assert.equal((await f.view(id)).status, "available", "Oversized or unacknowledged work must be refused before yield");
    writeFileSync(join(f.source, "owned.txt"), "Keep partial work.\n");
    assert.equal((await tool(receipt.server, request(f.base))).isError, true);
    assert.equal((await f.view(id)).status, "available");
    assert.equal(readFileSync(join(f.source, "owned.txt"), "utf8"), "Keep partial work.\n");
    git(f.source, "add", "owned.txt"); git(f.source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Checkpoint owned work");
    const head = git(f.source, "rev-parse", "HEAD");
    assert.equal((await tool(receipt.server, request(head))).isError, false);
    assert.equal((await tool(receipt.server, request(head))).isError, false, "An identical MCP retry is acknowledged without another transfer");
    assert.equal((await tool(receipt.server, { ...request(head), summary: "Conflicting retry" })).isError, true);
    const waiting = await waitFor(() => f.view(id), value => value.status === "waiting-for-control");
    assert.equal((await f.host.fetchApi(`/sessions/${id}`)).body.status, "running");
    assert.equal((await f.host.fetchApi(`/sessions/${id}/resume`, "owner", { requestId: randomUUID() })).status, 409);
    const denied = await f.host.fetchApi("/sessions", "owner", { requestId: randomUUID(), projectId: "rehearsal", provider: "claude", title: "Competing task", prompt: "" });
    assert.equal(denied.status, 409);
    await f.host.stopApi(); await f.host.start();
    assert.equal((await f.view(id)).teamId, waiting.teamId);
    assert.equal((await f.host.fetchApi(`/sessions/${id}/control`, "owner", { action: "release", leaseId: lease.lease.id }, lease.headers)).status, 200);
    const transferred = await waitFor(() => f.view(id), value => ["started", "blocked"].includes(value.status), 30000);
    assert.equal(transferred.status, "started", JSON.stringify(transferred));
    const team = await waitFor(async () => (await f.host.fetchApi(`/teams/${waiting.teamId}`)).body, value => ["no-change", "blocked"].includes(value.status), 30000);
    assert.equal(team.status, "no-change", JSON.stringify(team));
    assert.equal(team.handoff.sourceSessionId, id); assert.equal(team.handoff.maxMembers, 16);
    assert.equal(team.parallelism, 2); assert.equal(team.workers.max, 2); assert.equal(team.baseCommit, head);
    assert.ok(Date.parse(team.handoff.deadlineAt) - Date.parse(team.createdAt) <= 3600000);
    assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 1);
    assert.equal((await f.host.fetchApi(`/sessions/${id}`)).body.status, "exited");
    assert.equal(git(f.source, "rev-parse", "HEAD"), head); assert.equal(git(f.source, "status", "--porcelain"), "");
  } finally { await f.close(); }
});

test("Codex handoff blocks changed checkpoints without stopping or overwriting the source", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const { id, receipt } = await f.create(["--model", "gpt-6-astra", "Inspect this task"], "codex");
    assert.ok(receipt.server, "The generated Codex config must carry a usable scoped MCP command");
    const lease = await claimControl(f.host, id, "owner");
    assert.equal((await tool(receipt.server, request(f.base))).isError, false);
    await waitFor(() => f.view(id), value => value.status === "waiting-for-control");
    writeFileSync(join(f.source, "late.txt"), "A later edit must survive.\n");
    await f.host.fetchApi(`/sessions/${id}/control`, "owner", { action: "release", leaseId: lease.lease.id }, lease.headers);
    await waitFor(() => f.view(id), value => value.status === "blocked");
    assert.equal((await f.host.fetchApi(`/sessions/${id}`)).body.status, "running");
    assert.equal(readFileSync(join(f.source, "late.txt"), "utf8"), "A later edit must survive.\n");
    assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 0);
  } finally { await f.close(); }
});

test("handoff limits default to one hour without extension, and configured project minutes reach the policy", { timeout: 90000 }, async () => {
  const policyOf = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => {
    const key = readFileSync(f.host.config.keyFile);
    const file = join(f.host.config.stateDir, "sessions", id, "meta.sealed");
    return unseal<{ session: { handoff: { policy: Record<string, unknown> } } }>(key, `${id}:meta`, readFileSync(file, "utf8")).session.handoff.policy;
  };
  const defaults = await fixture();
  try {
    const { id } = await defaults.create([]);
    const policy = await policyOf(defaults, id);
    assert.equal(policy.maxMinutes, 60);
    assert.equal(policy.extendMinutes, undefined);
    assert.equal(policy.maxTotalMinutes, undefined);
  } finally { await defaults.close(); }
  const configured = await fixture(true, false, { handoffMinutes: 10, handoffExtendMinutes: 5, handoffMaxTotalMinutes: 20 });
  try {
    const { id } = await configured.create([]);
    const policy = await policyOf(configured, id);
    assert.equal(policy.maxMinutes, 10);
    assert.equal(policy.extendMinutes, 5);
    assert.equal(policy.maxTotalMinutes, 20);
  } finally { await configured.close(); }
});

test("handoff admission blocks policy source or project mismatches before stopping the source", { timeout: 60000 }, async () => {
  for (const mismatch of ["sourceSessionId", "projectId"] as const) {
    const f = await fixture();
    try {
      const { id, receipt } = await f.create([]);
      const key = readFileSync(f.host.config.keyFile);
      const file = join(f.host.config.stateDir, "sessions", id, "meta.sealed");
      const stored = unseal<{ session: { handoff: { policy: Record<string, unknown> } } }>(key, `${id}:meta`, readFileSync(file, "utf8"));
      stored.session.handoff.policy[mismatch] = mismatch === "sourceSessionId" ? randomUUID() : "another-project";
      writeSealed(file, key, `${id}:meta`, stored);

      assert.equal((await tool(receipt.server, request(f.base))).isError, false);
      const view = await waitFor(() => f.view(id), value => value.status === "blocked");
      assert.match(view.reason, /policy does not belong to its source session and project/);
      assert.equal((await f.host.fetchApi(`/sessions/${id}`)).body.status, "running", "invalid policy is refused before the source process stops");
      assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 0);
    } finally { await f.close(); }
  }
});

test("non-opted launch preserves argv and native history selection is rejected", { timeout: 60000 }, async () => {
  for (const optIn of [false, true]) {
    const f = await fixture(optIn);
    try {
      if (optIn) {
        const response = await f.host.fetchApi("/sessions", "owner", { requestId: randomUUID(), projectId: "rehearsal", provider: "claude", title: "Must remain fresh", nativeArgs: ["--resume", "conversation-id"] });
        assert.equal(response.status, 400);
        assert.match(response.body.error, /infinite resume SESSION_ID/);
        assert.equal((await f.host.fetchApi("/sessions")).body.sessions.length, 0);
      } else {
        const args = ["--model", "claude-opus-5-5", "A normal prompt"];
        const { id, receipt } = await f.create(args);
        assert.deepEqual(receipt.argv, args);
        assert.equal(receipt.server, undefined); assert.equal((await f.view(id)).status, "unavailable");
      }
    } finally { await f.close(); }
  }
});

test("handoff waits for a HUP and TERM ignoring source descendant before preparing its team", { timeout: 60000 }, async () => {
  const f = await fixture(); let descendant: number | undefined;
  try {
    const { id, receipt } = await f.create(["Exercise delayed child"]);
    descendant = await waitFor(async () => { try { return Number(readFileSync(join(f.receipts, "child-pid"), "utf8")); } catch { return undefined; } }, Boolean);
    assert.equal((await tool(receipt.server, request(f.base))).isError, false);
    const handoff = await waitFor(() => f.view(id), value => ["started", "blocked"].includes(value.status), 30000);
    assert.equal(handoff.status, "started", JSON.stringify(handoff));
    assert.throws(() => process.kill(descendant!, 0), /ESRCH/, "The source parent exiting cannot count as descendant quiescence");
    const state = (await f.host.fetchApi(`/sessions/${id}`)).body;
    assert.equal(state.handoffQuiescence.scope, "process-group-and-observed-descendants");
    assert.equal(existsSync(join(f.source, "late-child.txt")), false);
    const team = (await f.host.fetchApi(`/teams/${handoff.teamId}`)).body;
    assert.equal(team.baseCommit, f.base);
  } finally { if (descendant) try { process.kill(descendant, "SIGKILL"); } catch {} await f.close(); }
});

test("a second live project session blocks handoff without stopping either source", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(["First task"]), second = await f.create(["Second task"], "codex");
    assert.equal((await tool(first.receipt.server, request(f.base))).isError, false);
    const blocked = await waitFor(() => f.view(first.id), value => value.status === "blocked");
    assert.match(blocked.reason, /another session/i);
    for (const id of [first.id, second.id]) assert.equal((await f.host.fetchApi(`/sessions/${id}`)).body.status, "running");
    assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 0);
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
  } finally { await f.close(); }
});

test("a live cmux session under a same-root project alias blocks transfer without taking over its terminal", { timeout: 60000 }, async () => {
  const f = await fixture(true, true);
  try {
    const external = await waitFor(async () => (await f.host.fetchApi("/sessions")).body.sessions.find((session: any) => session.nativeSession?.id === f.nativeId), Boolean);
    assert.equal(external.backend, "cmux");
    assert.equal(external.projectId, "source-alias", "The regression must exercise a different project identity for the same canonical source");
    assert.equal(external.status, "running");
    const source = await f.create(["Inspect the authorized task"]);
    assert.equal((await tool(source.receipt.server, request(f.base))).isError, false);
    const result = await waitFor(() => f.view(source.id), value => ["started", "blocked"].includes(value.status), 30000);
    assert.equal(result.status, "blocked", "A different configured project ID cannot hide a live native writer in the source root");
    assert.match(result.reason, /another native session|project.*busy|using this project/i);
    assert.equal((await f.host.fetchApi(`/sessions/${source.id}`)).body.status, "running", "The source must not be stopped before external-writer admission is checked");
    process.kill(f.external!.pid, 0);
    const after = (await f.host.fetchApi("/sessions")).body.sessions.find((session: any) => session.id === external.id);
    assert.equal(after.status, "running"); assert.equal(after.control, null);
    assert.equal((await f.host.fetchApi("/teams")).body.teams.length, 0);
    assert.equal(git(f.source, "rev-parse", "HEAD"), f.base);
    assert.equal(git(f.source, "status", "--porcelain"), "");
  } finally { await f.close(); }
});
