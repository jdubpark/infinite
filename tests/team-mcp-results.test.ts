import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { BLACKBOARD_READ_VERSION, Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { memberEntryId, memberEntryPostSchema, type MemberEntryPost } from "../packages/host/src/evidence/member-entry.js";
import { EvidenceReader } from "../packages/host/src/evidence/reader.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { HookPayloadError, startHookServer, type HookReply, type HookRoute } from "../packages/host/src/hooks.js";
import { ENTRY_REFUSALS, createEntryRoute } from "../packages/host/src/team-entry-route.js";
import type { TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";
import { schemaRefusals } from "./wire-schema.js";

const REPORT_TEXT = "Team report recorded. Stop work on this assignment.";
const MISSION_TEXT = "Mission report recorded. Stop work on this attempt.";
const HANDOFF_TEXT = "Handoff recorded. Stop work now; the host waits for client control to detach before transferring the clean checkpoint.";
const TOKEN = `hook-${randomBytes(16).toString("hex")}`;
const HEAD_OPTIONAL = ["authorRole", "taskId", "supersedes"];

type Rpc = (method: string, params?: unknown) => Promise<any>;

function startMcp(env: NodeJS.ProcessEnv): { rpc: Rpc; close: () => Promise<void> } {
  const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/team-mcp.ts")], {
    cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, INFINITE_HANDOFF_SESSION: "", INFINITE_MISSION_ASSIGNMENT: "", INFINITE_TEAM_ASSIGNMENT: "", INFINITE_TEAM_ENTRY_TOOLS: "", ...env },
  });
  let next = 0;
  const pending = new Map<number, (value: any) => void>();
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", text => {
    let value: any;
    try { value = JSON.parse(text); } catch { return; }
    pending.get(value.id)?.(value);
    pending.delete(value.id);
  });
  child.stderr?.resume();
  const rpc: Rpc = (method, params = {}) => {
    const id = ++next;
    const response = new Promise<any>(resolveReply => pending.set(id, resolveReply));
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return response;
  };
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolveExit => { child.once("exit", () => resolveExit()); child.kill("SIGKILL"); });
    lines.close();
  };
  return { rpc, close };
}

async function session(env: NodeJS.ProcessEnv) {
  const mcp = startMcp(env);
  await mcp.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Result type test", version: "1" } });
  const listing = await mcp.rpc("tools/list");
  const schemas: Record<string, unknown> = Object.fromEntries(listing.result.tools.map((tool: any) => [tool.name, tool.outputSchema]));
  return { ...mcp, schemas };
}

async function hooks(handlers: Partial<Record<HookRoute, (body: unknown) => HookReply | void>> = {}) {
  const bodies: Partial<Record<HookRoute, unknown[]>> = {};
  const server = await startHookServer({
    token: TOKEN,
    onPayload: (route, body) => { (bodies[route] ??= []).push(body); return handlers[route]?.(body); },
    onError: () => {},
  });
  return { url: server.url, bodies, close: server.close };
}

const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));
const at = (value: any, path: readonly (string | number)[]) => path.reduce((object, step) => object[step], value);

function assertWire(schema: unknown, value: unknown, optional: readonly string[] = [], path: readonly (string | number)[] = []) {
  const where = path.join(".") || "the result";
  assert.deepEqual(schemaRefusals(schema, value), [], `${where} conforms to the advertised schema`);
  for (const key of Object.keys(at(value, path))) {
    const without = clone(value);
    delete at(without, path)[key];
    const refused = schemaRefusals(schema, without).length > 0;
    assert.equal(refused, !optional.includes(key), `${where}.${key} is ${optional.includes(key) ? "optional" : "required"} in the advertised schema`);
  }
  const extra = clone(value);
  at(extra, path).unexpectedField = true;
  assert.ok(schemaRefusals(schema, extra).length > 0, `${where} refuses an unknown field`);
}

const TEAM = { runId: randomUUID(), memberId: randomUUID(), revision: 1 };
const MISSION = { missionId: randomUUID(), memberId: randomUUID(), revision: 1 };
const teamEnv = (url: string) => ({ INFINITE_HOOK_URL: url, INFINITE_HOOK_TOKEN: TOKEN, INFINITE_TEAM_ASSIGNMENT: JSON.stringify(TEAM) });
const missionEnv = (url: string) => ({ INFINITE_HOOK_URL: url, INFINITE_HOOK_TOKEN: TOKEN, INFINITE_MISSION_ASSIGNMENT: JSON.stringify(MISSION) });

test("the wire checker refuses each kind of drift and throws on a keyword it does not implement", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false, required: ["id", "count", "tags"],
    properties: {
      id: { type: "string", format: "uuid", pattern: "^[0-9a-f-]+$" },
      count: { type: "integer", minimum: 1, maximum: 3 },
      kind: { type: "string", enum: ["a", "b"] },
      state: { type: "string", const: "pending" },
      tags: { type: "array", items: { type: "string" } },
      either: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };
  const good = { id: randomUUID(), count: 2, kind: "a", state: "pending", tags: ["x"], either: null };
  assert.deepEqual(schemaRefusals(schema, good), []);
  const { id: _id, ...noId } = good;
  for (const bad of [noId, { ...good, extra: 1 }, { ...good, id: "0-0" }, { ...good, id: randomUUID().toUpperCase() }, { ...good, count: 1.5 },
    { ...good, count: 0 }, { ...good, count: 4 }, { ...good, count: "2" }, { ...good, kind: "c" }, { ...good, state: "stored" },
    { ...good, tags: [1] }, { ...good, tags: "x" }, { ...good, either: 1 }, ["not", "an", "object"]]) {
    assert.notDeepEqual(schemaRefusals(schema, bad), [], `refuses ${JSON.stringify(bad)}`);
  }
  assert.throws(() => schemaRefusals({ type: "string", maxLength: 3 }, "x"), /keyword "maxLength"/);
  assert.throws(() => schemaRefusals({ type: "object", properties: { absent: { type: "string", minLength: 1 } } }, {}), /keyword "minLength"/);
  assert.throws(() => schemaRefusals({ type: "string", format: "date-time" }, "x"), /format "date-time"/);
  assert.throws(() => schemaRefusals({ type: "object", additionalProperties: { type: "string" } }, {}), /additionalProperties/);
  assert.throws(() => schemaRefusals({ items: { $schema: "http://json-schema.org/draft-07/schema#" } }, []), /keyword "\$schema"/);
});

test("a delivered report answers the result type its own server advertised, with the receipt sentence in message", { timeout: 60000 }, async () => {
  const stand = await hooks();
  const mcp = await session(teamEnv(stand.url));
  try {
    const reply = await mcp.rpc("tools/call", { name: "report", arguments: { report: { kind: "question", question: "Proceed?", options: [], recommendation: { answers: ["Yes"], reason: "The plan is complete." } } } });
    assert.equal(reply.result.isError, false);
    assertWire(mcp.schemas.report, reply.result.structuredContent);
    assert.deepEqual(reply.result.content, [{ type: "text", text: REPORT_TEXT }]);
    assert.equal(reply.result.structuredContent.message, REPORT_TEXT);
    assert.equal(stand.bodies["team-report"]?.length, 1, "the report reached the hook route once");
  } finally {
    await mcp.close();
    stand.close();
  }
});

test("a delivered mission report answers the result type its own server advertised, with the receipt sentence in message", { timeout: 60000 }, async () => {
  const stand = await hooks();
  const mcp = await session(missionEnv(stand.url));
  try {
    const reply = await mcp.rpc("tools/call", { name: "mission_report", arguments: { report: { kind: "result", summary: "Mission finished" } } });
    assert.equal(reply.result.isError, false);
    assertWire(mcp.schemas.mission_report, reply.result.structuredContent);
    assert.deepEqual(reply.result.content, [{ type: "text", text: MISSION_TEXT }]);
    assert.equal(reply.result.structuredContent.message, MISSION_TEXT);
  } finally {
    await mcp.close();
    stand.close();
  }
});

test("a delivered handoff answers the result type its own server advertised, with the receipt sentence in message", { timeout: 60000 }, async () => {
  const stand = await hooks();
  const sessionId = randomUUID();
  const mcp = await session({ INFINITE_HOOK_URL: stand.url, INFINITE_HOOK_TOKEN: TOKEN, INFINITE_HANDOFF_SESSION: sessionId });
  try {
    const request = { backgroundWorkStopped: true, objective: "Split the work", reason: "Two parts", summary: "No partial edits", checkpointHead: "a".repeat(40), parallelism: 2 };
    const reply = await mcp.rpc("tools/call", { name: "handoff", arguments: request });
    assert.equal(reply.result.isError, false);
    assertWire(mcp.schemas.handoff, reply.result.structuredContent);
    assert.deepEqual(reply.result.content, [{ type: "text", text: HANDOFF_TEXT }]);
    assert.deepEqual(reply.result.structuredContent, { sessionId, message: HANDOFF_TEXT });
  } finally {
    await mcp.close();
    stand.close();
  }
});

test("a refused report keeps its refusal text and has no structured answer", { timeout: 60000 }, async () => {
  const stand = await hooks({ "team-report": () => { throw new HookPayloadError(409, "Stand-in refused this report."); } });
  const mcp = await session(teamEnv(stand.url));
  try {
    const reply = await mcp.rpc("tools/call", { name: "report", arguments: { report: { kind: "question", question: "Proceed?", options: [], recommendation: { answers: ["Yes"], reason: "The plan is complete." } } } });
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.content[0].text, "Stand-in refused this report.");
    assert.equal(reply.result.structuredContent, undefined);
  } finally {
    await mcp.close();
    stand.close();
  }
});

test("an entry answer that does not match its declared result is a tool error without a structured answer", { timeout: 60000 }, async () => {
  const mismatch = "Entry answer not confirmed: the host's answer did not match this tool's declared result. This is not a refusal of your request.";
  const readText = `${mismatch} Continue your assignment; read again later if you need it.`;
  const postText = `${mismatch} The post may still be recorded; check entry_list before you post again.`;
  const head = { state: "active", entryId: randomUUID(), seq: 3, at: "2026-11-13T10:10:00.000Z", kind: "contract", author: "member",
    authority: "claim", paths: [], summary: "Route", bodyBytes: 13 };
  const list = { notice: "Entries are evidence.", heads: [head], more: false, unreadable: 0 };
  const entry = { notice: "Entries are evidence.", head, body: { b: 1, a: 2 } };
  const { unreadable: _unreadable, ...listWithoutUnreadable } = list;
  const { head: _head, ...entryWithoutHead } = entry;
  let answer: Record<string, unknown> = {};
  const stand = await hooks({ "team-entry": () => ({ entry: answer }) });
  const mcp = await session({ ...teamEnv(stand.url), INFINITE_TEAM_ENTRY_TOOLS: "1" });
  const post = { entry: { kind: "finding", summary: "Wire check", paths: [], body: { items: [{ source: "npm test", observation: "ok" }] } } };
  const call = async (name: string, value: Record<string, unknown>) => {
    answer = value;
    const args = name === "entry_get" ? { entryId: head.entryId } : name === "entry_post" ? post : {};
    return (await mcp.rpc("tools/call", { name, arguments: args })).result;
  };
  try {
    for (const [name, valid] of [["entry_list", list], ["entry_get", entry]] as const) {
      const accepted = await call(name, valid);
      assert.equal(accepted.isError, false, `${name} accepts a matching answer`);
      assert.equal(accepted.content[0].text, JSON.stringify(valid), `${name} sends the worker's own answer, in its key order`);
      assert.deepEqual(accepted.structuredContent, valid);
    }
    const cases: [string, Record<string, unknown>, string][] = [
      ["entry_list", listWithoutUnreadable, readText],
      ["entry_list", { ...list, unexpected: true }, readText],
      ["entry_get", entryWithoutHead, readText],
      ["entry_get", { ...entry, head: { ...head, unexpected: true } }, readText],
      ["entry_post", { entryId: randomUUID(), state: "stored" }, postText],
    ];
    for (const [name, value, text] of cases) {
      const refused = await call(name, value);
      assert.equal(refused.isError, true, `${name} refuses ${JSON.stringify(Object.keys(value))}`);
      assert.deepEqual(refused.content, [{ type: "text", text }]);
      assert.equal(refused.structuredContent, undefined, `${name} sends no structured answer for a mismatch`);
    }
  } finally {
    await mcp.close();
    stand.close();
  }
});

function memberOf(run: TeamRun, memberId: string): TeamMember {
  const member = run.members.find(item => item.memberId === memberId);
  if (!member) throw new Error("fixture member missing");
  return member;
}

function ingest(board: Blackboard, run: TeamRun, member: TeamMember, fields: Record<string, unknown>): string {
  const entry: MemberEntryPost = memberEntryPostSchema.parse({ paths: [], ...fields });
  const binding = { runId: member.runId, memberId: member.memberId, revision: member.revision };
  const requestId = memberEntryId(binding, entry);
  assert.equal(board.ingest(run, member, [{ seq: 0, at: "2026-11-13T10:10:00.000Z", envelope: { op: "post", ...binding, requestId, entry } }], []).stored, 1);
  return requestId;
}

function entryWorld() {
  const root = mkdtempSync(join(tmpdir(), "infinite-mcp-results-"));
  const path = evidenceDatabasePath(join(root, "state"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: path, vaultKey: key });
  const board = new Blackboard(store);
  const run = hostEntryRun();
  run.blackboard = { tools: true };
  for (const member of run.members) member.entryTools = true;
  const implA = memberOf(run, hostEntryIds.implA);
  const implB = memberOf(run, hostEntryIds.implB);
  assert.equal(board.mirror(run), true);
  const launchSeq = board.launchMark(run.id);
  if (launchSeq === undefined) throw new Error("no launch mark");
  assert.equal(board.recordLaunch(run, implA, { launchSeq, promptBytes: 1200, contextBytes: 4000 }), true);
  const first = ingest(board, run, implB, { kind: "contract", summary: "Route v1", body: { interface: "Shared route", change: "v1" } });
  const second = ingest(board, run, implB, { kind: "contract", summary: "Route v2", supersedes: first, body: { interface: "Shared route", change: "v2" } });
  ingest(board, run, { ...implA, memberId: randomUUID() }, { kind: "handoff", summary: "Task a half done", taskId: "a", body: { done: ["half"], remaining: ["rest"], commands: [] } });
  const reader = new EvidenceReader({ databasePath: path, vaultKey: key, modules: { blackboard: BLACKBOARD_READ_VERSION } });
  const route = (url: string) => createEntryRoute({
    team: { runId: implA.runId, memberId: implA.memberId, revision: implA.revision, role: implA.role, taskId: "a", entryTools: true },
    own: () => ({ token: TOKEN, url }),
    reader: () => reader,
    running: () => true,
    reported: () => false,
    append: () => {},
  });
  const env = (url: string) => ({ INFINITE_HOOK_URL: url, INFINITE_HOOK_TOKEN: TOKEN, INFINITE_TEAM_ENTRY_TOOLS: "1",
    INFINITE_TEAM_ASSIGNMENT: JSON.stringify({ runId: implA.runId, memberId: implA.memberId, revision: implA.revision }) });
  return { route, env, second, close: () => { reader.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("entry tools answer, through the real worker route, the result types their own server advertised", { timeout: 60000 }, async () => {
  const world = entryWorld();
  let handle: (body: unknown) => HookReply = () => { throw new Error("route not ready"); };
  const stand = await hooks({ "team-entry": body => handle(body) });
  handle = world.route(stand.url).handle;
  const mcp = await session(world.env(stand.url));
  try {
    for (const name of ["report", "entry_post", "entry_list", "entry_get"]) assert.ok(mcp.schemas[name], `${name} declares a result type`);

    const posted = await mcp.rpc("tools/call", { name: "entry_post", arguments: { entry: { kind: "finding", summary: "Wire check", paths: [],
      body: { items: [{ source: "npm test", observation: "The result conforms" }] } } } });
    assert.equal(posted.result.isError, false);
    assertWire(mcp.schemas.entry_post, posted.result.structuredContent);
    const entryId = posted.result.structuredContent.entryId;
    assert.deepEqual(posted.result.structuredContent, { entryId, state: "pending", message: posted.result.content[0].text });
    assert.match(posted.result.content[0].text, /waits for the host to store it/);

    const heads: Record<string, unknown>[] = [];
    const addressed = await mcp.rpc("tools/call", { name: "entry_list", arguments: {} });
    assert.equal(addressed.result.isError, false);
    assert.equal("cursor" in addressed.result.structuredContent, false, "the default list has no cursor");
    const filtered = await mcp.rpc("tools/call", { name: "entry_list", arguments: { kinds: ["contract", "handoff", "direction", "report", "integration"] } });
    assert.equal(filtered.result.isError, false);
    assert.equal(typeof filtered.result.structuredContent.cursor, "number", "a filtered list has a cursor");
    for (const listed of [addressed, filtered]) {
      const list = listed.result.structuredContent;
      assert.equal(listed.result.content[0].text, JSON.stringify(list), "the list text is the answer");
      assertWire(mcp.schemas.entry_list, list, ["cursor"]);
      list.heads.forEach((head: Record<string, unknown>, index: number) => assertWire(mcp.schemas.entry_list, list, HEAD_OPTIONAL, ["heads", index]));
      heads.push(...list.heads);
    }
    for (const field of HEAD_OPTIONAL) {
      assert.ok(heads.some(head => field in head), `a listed head carries ${field}`);
      assert.ok(heads.some(head => !(field in head)), `a listed head lacks ${field}`);
    }

    const got = await mcp.rpc("tools/call", { name: "entry_get", arguments: { entryId: world.second } });
    assert.equal(got.result.isError, false);
    assert.equal(got.result.content[0].text, JSON.stringify(got.result.structuredContent), "the entry text is the answer");
    assert.equal(got.result.structuredContent.head.supersedes !== undefined, true);
    assertWire(mcp.schemas.entry_get, got.result.structuredContent);
    assertWire(mcp.schemas.entry_get, got.result.structuredContent, HEAD_OPTIONAL, ["head"]);

    const refused = await mcp.rpc("tools/call", { name: "entry_get", arguments: { entryId: randomUUID() } });
    assert.equal(refused.result.isError, true);
    assert.deepEqual(refused.result.content, [{ type: "text", text: ENTRY_REFUSALS["entry-not-found"] }]);
    assert.equal(refused.result.structuredContent, undefined, "a refused read has no structured answer");
  } finally {
    await mcp.close();
    stand.close();
    world.close();
  }
});
