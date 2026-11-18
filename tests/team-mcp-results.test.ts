import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { AddressInfo } from "node:net";
import { handoffResultSchema, missionReportResultSchema, reportResultSchema } from "../packages/host/src/team-mcp-results.js";

const REPORT_TEXT = "Team report recorded. Stop work on this assignment.";
const MISSION_TEXT = "Mission report recorded. Stop work on this attempt.";

type Rpc = (method: string, params?: unknown) => Promise<any>;

/** A `team-mcp` child with the given environment. The helper copies the stdio harness of team-entry-tools.test.ts. */
function startMcp(env: NodeJS.ProcessEnv): { rpc: Rpc; close: () => Promise<void> } {
  const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/team-mcp.ts")], {
    cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, INFINITE_HANDOFF_SESSION: "", INFINITE_MISSION_ASSIGNMENT: "", INFINITE_TEAM_ASSIGNMENT: "", ...env },
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

/** Initializes a child and returns its tools by name. */
async function toolsOf(env: NodeJS.ProcessEnv): Promise<Record<string, any>> {
  const mcp = startMcp(env);
  try {
    await mcp.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Result type test", version: "1" } });
    const listing = await mcp.rpc("tools/list");
    return Object.fromEntries(listing.result.tools.map((tool: any) => [tool.name, tool]));
  } finally {
    await mcp.close();
  }
}

/** A stand-in hook listener on loopback. Each route answers with the status it was given, and records each body. */
async function listener(status: Record<string, { code: number; body?: string }>) {
  const bodies: Record<string, unknown[]> = {};
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const route = request.url ?? "";
      (bodies[route] ??= []).push(JSON.parse(raw));
      const answer = status[route] ?? { code: 404 };
      response.writeHead(answer.code, { "Content-Type": "text/plain" });
      response.end(answer.body ?? "");
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", () => resolveListen()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/hook`, bodies, close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())) };
}

const TEAM = { runId: randomUUID(), memberId: randomUUID(), revision: 1 };
const MISSION = { missionId: randomUUID(), memberId: randomUUID(), revision: 1 };
const teamEnv = (url: string) => ({ INFINITE_HOOK_URL: url, INFINITE_HOOK_TOKEN: "stand-in-token", INFINITE_TEAM_ASSIGNMENT: JSON.stringify(TEAM) });
const missionEnv = (url: string) => ({ INFINITE_HOOK_URL: url, INFINITE_HOOK_TOKEN: "stand-in-token", INFINITE_MISSION_ASSIGNMENT: JSON.stringify(MISSION) });

test("tools/list declares a result type with the receipt message for each write tool", { timeout: 60000 }, async () => {
  const team = await toolsOf({ INFINITE_HOOK_URL: "http://127.0.0.1:9/hook", INFINITE_HOOK_TOKEN: "placeholder", INFINITE_TEAM_ASSIGNMENT: JSON.stringify(TEAM) });
  assert.equal(team.report.outputSchema.type, "object");
  assert.ok(team.report.outputSchema.properties.requestId);
  assert.ok(team.report.outputSchema.properties.message);

  const mission = await toolsOf({ INFINITE_HOOK_URL: "http://127.0.0.1:9/hook", INFINITE_HOOK_TOKEN: "placeholder", INFINITE_MISSION_ASSIGNMENT: JSON.stringify(MISSION) });
  assert.equal(mission.mission_report.outputSchema.type, "object");
  assert.ok(mission.mission_report.outputSchema.properties.missionId);
  assert.ok(mission.mission_report.outputSchema.properties.message);

  const handoff = await toolsOf({ INFINITE_HOOK_URL: "http://127.0.0.1:9/hook", INFINITE_HOOK_TOKEN: "placeholder", INFINITE_HANDOFF_SESSION: randomUUID() });
  assert.equal(handoff.handoff.outputSchema.type, "object");
  assert.ok(handoff.handoff.outputSchema.properties.sessionId);
  assert.ok(handoff.handoff.outputSchema.properties.message);
});

test("a delivered report answers its declared result with the receipt sentence in message", { timeout: 60000 }, async () => {
  const stand = await listener({ "/hook/team-report": { code: 204 } });
  const mcp = startMcp(teamEnv(stand.url));
  try {
    await mcp.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Result type test", version: "1" } });
    const reply = await mcp.rpc("tools/call", { name: "report", arguments: { report: { kind: "question", question: "Proceed?", options: [] } } });
    assert.notEqual(reply.result.isError, true);
    assert.equal(reportResultSchema.safeParse(reply.result.structuredContent).success, true, "the report answer matches its declared result type");
    assert.equal(reply.result.content[0].text, REPORT_TEXT);
    assert.equal(reply.result.structuredContent.message, REPORT_TEXT);
    assert.equal(stand.bodies["/hook/team-report"]?.length, 1, "the report reached the stand-in route once");
  } finally {
    await mcp.close();
    await stand.close();
  }
});

test("a delivered mission report answers its declared result with the receipt sentence in message", { timeout: 60000 }, async () => {
  const stand = await listener({ "/hook/mission-report": { code: 204 } });
  const mcp = startMcp(missionEnv(stand.url));
  try {
    await mcp.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Result type test", version: "1" } });
    const reply = await mcp.rpc("tools/call", { name: "mission_report", arguments: { report: { kind: "result", summary: "Mission finished" } } });
    assert.notEqual(reply.result.isError, true);
    assert.equal(missionReportResultSchema.safeParse(reply.result.structuredContent).success, true, "the mission answer matches its declared result type");
    assert.equal(reply.result.content[0].text, MISSION_TEXT);
    assert.equal(reply.result.structuredContent.message, MISSION_TEXT);
  } finally {
    await mcp.close();
    await stand.close();
  }
});

test("a refused report keeps its refusal text and has no structured answer", { timeout: 60000 }, async () => {
  const stand = await listener({ "/hook/team-report": { code: 409, body: "Stand-in refused this report." } });
  const mcp = startMcp(teamEnv(stand.url));
  try {
    await mcp.rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Result type test", version: "1" } });
    const reply = await mcp.rpc("tools/call", { name: "report", arguments: { report: { kind: "question", question: "Proceed?", options: [] } } });
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.content[0].text, "Stand-in refused this report.");
    assert.equal(reply.result.structuredContent, undefined);
  } finally {
    await mcp.close();
    await stand.close();
  }
});
