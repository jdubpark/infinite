import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { ENTRY_NOTICE } from "../packages/host/src/evidence/entry-reads.js";
import { claimControl, waitFor } from "./helpers.js";
import { fixture } from "./team-fixture.js";
import { schemaRefusals } from "./wire-schema.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Child = { rpc: (method: string, params?: unknown) => Promise<any>; initialize: () => Promise<void>; close: () => Promise<void> };

/** A `team-mcp` child with the member's capability in its environment, as the launch gives it. */
function startChild(env: NodeJS.ProcessEnv, cwd: string): Child {
  const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/team-mcp.ts")], {
    cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env },
  });
  let next = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", text => {
    let value: any;
    try { value = JSON.parse(text); } catch { return; }
    const item = pending.get(value.id);
    if (item) { pending.delete(value.id); clearTimeout(item.timer); item.resolve(value); }
  });
  // Diagnostics stay out of the test output: they may name the capability.
  child.stderr?.resume();
  child.on("exit", () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("MCP helper exited before replying")); }
    pending.clear();
  });
  const rpc = (method: string, params: unknown = {}) => {
    const id = ++next;
    const response = new Promise<any>((resolveReply, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} did not reply`)); }, 10000);
      pending.set(id, { resolve: resolveReply, reject, timer });
    });
    void response.catch(() => {});
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return response;
  };
  const initialize = async () => {
    const response = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Infinite boundary test", version: "1" } });
    assert.equal(response.result.protocolVersion, "2025-11-25");
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  };
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolveExit => { child.once("exit", () => resolveExit()); child.kill("SIGKILL"); });
    lines.close();
  };
  return { rpc, initialize, close };
}

/** The structured answer of a tool call. */
const answerOf = (response: any) => response.result.structuredContent ?? JSON.parse(response.result.content[0].text);

/** Starts a run with the member's MCP child, after the member's capability receipt exists. */
async function runningMember(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.host.fetchApi("/teams", "owner", f.create());
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const running = await waitFor(() => f.get(created.body.id), run => run.members.some(member => member.status === "running") && existsSync(join(f.receipts, "mcp-capability.json")), 30000);
  const member = running.members[0]!;
  // A human lease keeps the scheduler from stopping the member while the test drives its capability.
  await claimControl(f.host, member.sessionId, "owner");
  const capability = JSON.parse(readFileSync(join(f.receipts, "mcp-capability.json"), "utf8")) as { url: string; token: string; assignment: Record<string, unknown> };
  return { id: created.body.id as string, member, capability };
}

test("a member posts, lists, and reads through the MCP tools", { timeout: 60000 }, async () => {
  const f = await fixture("mcp", undefined, { teams: { blackboard: { tools: true } } } as never);
  const children: Child[] = [];
  try {
    const { id, member, capability } = await runningMember(f);
    const child = startChild({ INFINITE_HOOK_URL: capability.url, INFINITE_HOOK_TOKEN: capability.token,
      INFINITE_TEAM_ASSIGNMENT: JSON.stringify(capability.assignment), INFINITE_TEAM_ENTRY_TOOLS: "1" }, f.source);
    children.push(child);
    await child.initialize();
    const listing = await child.rpc("tools/list");
    const names = listing.result.tools.map((tool: { name: string }) => tool.name);
    for (const name of ["entry_post", "entry_list", "entry_get"]) assert.ok(names.includes(name), `${name} is listed`);
    // Each answer below is checked against the result type this same child advertised.
    const advertised: Record<string, unknown> = Object.fromEntries(listing.result.tools.map((tool: { name: string; outputSchema?: unknown }) => [tool.name, tool.outputSchema]));
    for (const name of ["entry_post", "entry_list", "entry_get"]) assert.ok(advertised[name], `${name} declares a result type`);

    const entry = { kind: "contract", summary: "Interface for the report", paths: [],
      body: { interface: "report(entry)", change: "Add the entry tools", sources: [] } };
    const first = await child.rpc("tools/call", { name: "entry_post", arguments: { entry } });
    assert.notEqual(first.result.isError, true);
    const entryId = answerOf(first).entryId as string;
    assert.match(entryId, UUID);
    assert.deepEqual(schemaRefusals(advertised.entry_post, first.result.structuredContent), [], "entry_post answers its declared result");
    assert.deepEqual(first.result.structuredContent, { entryId, state: "pending", message: first.result.content[0].text });
    assert.equal(first.result.structuredContent.message, first.result.content[0].text, "the receipt sentence is in message and in the text");
    const receipt = String(first.result.content[0].text);
    assert.ok(receipt.includes(entryId), "the receipt names the entry id");
    assert.ok(receipt.includes("waits for the host to store it"), "the receipt says the host has not stored the entry yet");
    assert.equal(receipt.includes("within a few seconds"), false, "the receipt promises no delay the host cannot keep");
    const second = await child.rpc("tools/call", { name: "entry_post", arguments: { entry } });
    assert.equal(answerOf(second).entryId, entryId, "the identical post gets the same id");

    await waitFor(async () => (await f.host.fetchApi(`/teams/${id}/entries?kind=contract`, "owner")).body.entries.length,
      count => count === 1, 30000);
    const [head] = (await f.host.fetchApi(`/teams/${id}/entries?kind=contract`, "owner")).body.entries;
    assert.equal(head.author, "member");
    assert.equal(head.authority, "claim");

    const got = await child.rpc("tools/call", { name: "entry_get", arguments: { entryId } });
    assert.match(JSON.stringify(answerOf(got)), /Add the entry tools/);
    assert.deepEqual(schemaRefusals(advertised.entry_get, got.result.structuredContent), [], "entry_get answers its declared result");
    assert.equal(got.result.content[0].text, JSON.stringify(got.result.structuredContent), "entry_get text is the answer");
    const listed = await child.rpc("tools/call", { name: "entry_list", arguments: {} });
    assert.equal(answerOf(listed).notice, ENTRY_NOTICE);
    assert.equal(JSON.stringify(answerOf(listed)).includes(entryId), false, "the member does not list its own entry");
    assert.deepEqual(schemaRefusals(advertised.entry_list, listed.result.structuredContent), [], "entry_list answers its declared result");
    assert.equal(listed.result.content[0].text, JSON.stringify(listed.result.structuredContent), "entry_list text is the answer");
    // A filtered list keeps the member's own entry, so one head carries every field of a real MemberHead.
    const filtered = await child.rpc("tools/call", { name: "entry_list", arguments: { kinds: ["contract"] } });
    assert.ok(filtered.result.structuredContent.heads.some((head: { entryId: string }) => head.entryId === entryId));
    assert.deepEqual(schemaRefusals(advertised.entry_list, filtered.result.structuredContent), [], "a filtered entry_list answers its declared result");

    const context = JSON.parse(readFileSync(join(member.cwd, ".git", "infinite-team-context.json"), "utf8")) as { entries?: { notice?: string } };
    assert.equal(context.entries?.notice, ENTRY_NOTICE);
    await waitFor(async () => (await f.host.fetchApi(`/teams/${id}/context-usage`, "owner")).body.members,
      rows => rows.some((row: { memberId: string; listCalls: number; getCalls: number; digestBytes: number }) =>
        row.memberId === member.memberId && row.listCalls === 2 && row.getCalls === 1 && row.digestBytes > 0), 30000);
  } finally {
    await Promise.all(children.map(child => child.close()));
    await f.close();
  }
});

test("a secret post is refused without echo, and tools off answers 403", { timeout: 60000 }, async () => {
  const on = await fixture("mcp", undefined, { teams: { blackboard: { tools: true } } } as never);
  const children: Child[] = [];
  try {
    const { id, capability } = await runningMember(on);
    const child = startChild({ INFINITE_HOOK_URL: capability.url, INFINITE_HOOK_TOKEN: capability.token,
      INFINITE_TEAM_ASSIGNMENT: JSON.stringify(capability.assignment), INFINITE_TEAM_ENTRY_TOOLS: "1" }, on.source);
    children.push(child);
    await child.initialize();

    // Built at run time so that the test source holds no token-shaped text.
    const token = "gh" + "p_" + "A".repeat(36);
    const secret = await child.rpc("tools/call", { name: "entry_post", arguments: { entry: { kind: "contract", summary: "Secret check", paths: [],
      body: { interface: "none", change: `token ${token}`, sources: [] } } } });
    assert.equal(secret.result.isError, true);
    assert.equal(secret.result.structuredContent, undefined, "a refused post has no structured answer");
    const secretText = JSON.stringify(secret);
    assert.match(secretText, /entry-secret at entry\.body\.change/);
    assert.equal(secretText.includes(token), false, "the token is in no answer");

    const hookToken = await child.rpc("tools/call", { name: "entry_post", arguments: { entry: { kind: "contract", summary: `hook ${capability.token}`, paths: [],
      body: { interface: "none", change: "none", sources: [] } } } });
    assert.equal(hookToken.result.isError, true);
    assert.equal(hookToken.result.structuredContent, undefined, "a refused post has no structured answer");
    assert.equal(JSON.stringify(hookToken).includes(capability.token), false, "the hook token is in no answer");

    const stored = await on.host.fetchApi(`/teams/${id}/entries?kind=contract`, "owner");
    assert.equal(stored.body.entries.length, 0, "no refused contract is stored");
  } finally {
    await Promise.all(children.map(child => child.close()));
    await on.close();
  }

  const off = await fixture("mcp");
  try {
    const { capability, member } = await runningMember(off);
    const response = await fetch(`${capability.url}/team-entry`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${capability.token}` },
      body: JSON.stringify({ op: "list", runId: capability.assignment.runId, memberId: capability.assignment.memberId, revision: capability.assignment.revision }),
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /entry-tools-off/);
    const context = JSON.parse(readFileSync(join(member.cwd, ".git", "infinite-team-context.json"), "utf8")) as Record<string, unknown>;
    assert.equal("entries" in context, false, "tools off adds no entries key");
  } finally {
    await off.close();
  }
});
