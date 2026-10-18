#!/usr/bin/env node
import { HANDOFF_INSTRUCTIONS, handoffRequestSchema } from "./handoff-types.js";
import { submitHandoff } from "./handoff-report-client.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { teamReportSchema } from "./team-types.js";
import { reportErrorMessage, submitTeamReport } from "./team-report-client.js";

const MAX_FRAME_BYTES = 256 * 1024;
const PROTOCOL_VERSION = "2025-11-25";
const COMPATIBLE_VERSIONS = new Set([PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"]);
const argumentsSchema = z.object({ report: teamReportSchema }).strict();
const tool = {
  name: "report",
  description: "Record this assigned team member's final structured report. Wait for the durable success receipt, then stop work. A refusal requires user attention; never bypass it through a shell command or another tool.",
  inputSchema: z.toJSONSchema(argumentsSchema, { target: "draft-7" }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
type RequestId = string | number;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is RequestId => typeof value === "string" ? value.length <= 200 : typeof value === "number" && Number.isSafeInteger(value);

/** A narrow newline-delimited MCP transport. Awaiting each frame also bounds stdin backpressure. */
export async function runTeamMcp() {
  const handoff = Boolean(process.env.INFINITE_HANDOFF_SESSION);
  const selectedTool = handoff ? { name: "handoff", description: HANDOFF_INSTRUCTIONS,
    inputSchema: z.toJSONSchema(handoffRequestSchema, { target: "draft-7" }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } } : tool;
  let initialized = false;
  const send = async (message: unknown) => {
    const frame = JSON.stringify(message) + "\n";
    await new Promise<void>((done, reject) => process.stdout.write(frame, error => error ? reject(error) : done()));
  };
  const error = (id: RequestId | null, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const result = (id: RequestId, value: unknown) => send({ jsonrpc: "2.0", id, result: value });
  const handle = async (bytes: Buffer) => {
    let request: unknown;
    try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { await error(null, -32700, "Invalid JSON-RPC JSON."); return; }
    if (!isObject(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string" || request.method.length > 100 || (request.id !== undefined && !isId(request.id))) {
      await error(isObject(request) && isId(request.id) ? request.id : null, -32600, "Invalid JSON-RPC request."); return;
    }
    // Notifications never execute a tool, including a malformed tools/call without an ID.
    if (request.id === undefined) return;
    const id = request.id as RequestId;
    if (request.method === "ping") { await result(id, {}); return; }
    if (request.method === "initialize") {
      if (initialized) { await error(id, -32600, "This MCP connection is already initialized."); return; }
      const params = request.params;
      if (!isObject(params) || typeof params.protocolVersion !== "string" || params.protocolVersion.length > 64 || !isObject(params.capabilities) || !isObject(params.clientInfo) || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string") {
        await error(id, -32602, "Initialization requires a protocol version, client capabilities, and client name/version."); return;
      }
      initialized = true;
      await result(id, {
        protocolVersion: COMPATIBLE_VERSIONS.has(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "infinite-team", version: "1.0.0" },
        instructions: handoff ? HANDOFF_INSTRUCTIONS : "Use the report tool for the assigned member only. Permission decisions require owner authorization; a delegated coordinator may report only its assigned decision. Never approve your own request or bypass a denial. Stop on a denial; never attempt a shell workaround.",
      });
      return;
    }
    if (!initialized) { await error(id, -32002, "Initialize this MCP connection before requesting tools."); return; }
    if (request.method === "tools/list") {
      if (request.params !== undefined && (!isObject(request.params) || request.params.cursor !== undefined)) {
        await error(id, -32602, "This tool list has no pagination cursor."); return;
      }
      await result(id, { tools: [selectedTool] }); return;
    }
    if (request.method !== "tools/call") { await error(id, -32601, "Unknown MCP method."); return; }
    const params = request.params;
    if (!isObject(params) || typeof params.name !== "string" || !isObject(params.arguments)) {
      await error(id, -32602, "A tool call requires a name and arguments object."); return;
    }
    if (params.name !== selectedTool.name) { await error(id, -32602, "Unknown tool. Only report is available."); return; }
    try {
      if (handoff) {
        const envelope = await submitHandoff(params.arguments);
        await result(id, { content: [{ type: "text", text: "Handoff recorded. Stop work now; the host waits for client control to detach before transferring the clean checkpoint." }], structuredContent: { sessionId: envelope.sessionId }, isError: false });
        return;
      }
      const input = argumentsSchema.parse(params.arguments);
      const envelope = await submitTeamReport(input.report);
      await result(id, {
        content: [{ type: "text", text: "Team report recorded. Stop work on this assignment." }],
        structuredContent: { requestId: envelope.requestId, runId: envelope.runId, memberId: envelope.memberId, revision: envelope.revision },
        isError: false,
      });
    } catch (failure) {
      await result(id, { content: [{ type: "text", text: reportErrorMessage(failure) }], isError: true });
    }
  };
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = Buffer.concat([pending, buffer]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_FRAME_BYTES) { await error(null, -32600, "MCP frame exceeds 256 KiB."); process.exitCode = 1; return; }
      const frame = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      await handle(frame);
    }
    if (pending.length > MAX_FRAME_BYTES) { await error(null, -32600, "MCP frame exceeds 256 KiB."); process.exitCode = 1; return; }
  }
  if (pending.length) { await error(null, -32700, "Incomplete MCP frame; each message must end with a newline."); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTeamMcp().catch(() => {
    process.stderr.write("The team MCP transport stopped without confirming the pending request.\n");
    process.exitCode = 1;
  });
}
