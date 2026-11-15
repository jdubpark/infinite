import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { z } from "zod";
import { createMcpHandler, McpServer, type AuthInfo, type CallToolResult } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Config } from "./types.js";
import { mcpStartSchema, mcpGetSchema, mcpReplySchema, mcpControlSchema, McpRequestError, type McpRequestApi } from "./mcp-types.js";
import { mcpRequestErrorMessages } from "./mcp-requests.js";

const BODY_LIMIT = 96 * 1024;
const MAX_REQUESTS = 32;

/** A separate, unbound listener: the CLI binds it to loopback, never the owner API. */
export function createMcpServer(config: Config, api: McpRequestApi) {
  if (!config.mcp) throw new Error("MCP is not configured");
  const app = express();
  app.disable("x-powered-by");
  let closing = false;
  let active = 0;
  const handler = createMcpHandler(ctx => {
    const connectorId = ctx.authInfo!.clientId;
    const protocol = new McpServer({ name: "infinite-requests", version: "1.0.0" });
    const result = async (operation: () => unknown): Promise<CallToolResult> => {
      try {
        const value = await operation() as Record<string, unknown>;
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        const code = error instanceof McpRequestError && Object.hasOwn(mcpRequestErrorMessages, error.code) ? error.code : "request-action-unavailable";
        const value = { code, error: mcpRequestErrorMessages[code] };
        return { isError: true, content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      }
    };
    protocol.registerTool("list_projects", { description: "List the projects available to this connector.", inputSchema: z.object({}).strict() }, () => result(() => api.listProjects(connectorId)));
    protocol.registerTool("start_request", { description: "Queue a tracked work request. Reuse requestId only for identical retries.", inputSchema: mcpStartSchema }, input => result(() => api.startRequest(connectorId, input)));
    protocol.registerTool("get_request", { description: "Read request progress, current questions and permitted actions.", inputSchema: mcpGetSchema }, input => result(() => api.getRequest(connectorId, input.runId)));
    protocol.registerTool("reply_to_request", { description: "Reply at the current revision. This never approves a provider permission.", inputSchema: mcpReplySchema }, input => result(() => api.replyToRequest(connectorId, input)));
    protocol.registerTool("control_request", { description: "Pause, resume or cancel a started request at its current revision.", inputSchema: mcpControlSchema }, input => result(() => api.controlRequest(connectorId, input)));
    return protocol;
  }, { legacy: "stateless", maxRequestBodySize: BODY_LIMIT, maxSubscriptions: 0 });
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: BODY_LIMIT });
  const server = createServer(app);
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.timeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  const reject = (res: express.Response, status: number, error: string) => res.status(status).json({ error });
  app.use((req, res, next) => {
    if (req.url !== "/mcp") { reject(res, 404, "Not found."); return; }
    const settings = config.mcp;
    if (!settings) { reject(res, 503, "Connector is unavailable."); return; }
    const address = server.address();
    const localAuthority = address && typeof address === "object" ? `127.0.0.1:${address.port}` : undefined;
    if (req.headers.host !== new URL(settings.origin).host && req.headers.host !== localAuthority) { reject(res, 403, "Host is not allowed."); return; }
    if (req.headers.origin !== undefined && req.headers.origin !== new URL(settings.origin).origin && req.headers.origin !== `http://${localAuthority}`) { reject(res, 403, "Origin is not allowed."); return; }
    const bearer = /^Bearer ([A-Za-z0-9._~+\/-]{32,4096}=*)$/.exec(req.headers.authorization ?? "");
    const digest = createHash("sha256").update(bearer?.[1] ?? "").digest();
    let connectorId: string | undefined;
    for (const connector of settings.connectors) {
      if (timingSafeEqual(digest, Buffer.from(connector.tokenHash, "hex"))) connectorId = connector.id;
    }
    if (!bearer || !connectorId) { reject(res, 401, "Connector authentication required."); return; }
    if (closing || active >= MAX_REQUESTS) { reject(res, 503, "Connector is busy. Retry later."); return; }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    res.locals.release = release;
    const releaseBeforeDispatch = () => { if (!res.locals.handling) release(); };
    res.once("finish", releaseBeforeDispatch);
    res.once("close", releaseBeforeDispatch);
    (req as express.Request & { auth: AuthInfo }).auth = { token: "", clientId: connectorId, scopes: [] };
    if (req.method === "POST" && !req.is("application/json")) { reject(res, 415, "JSON content type required."); return; }
    next();
  });
  // Enforce the bound here: the SDK cannot apply its byte limit to a parsed body.
  app.use(express.json({ limit: BODY_LIMIT, inflate: false }));
  app.use(async (req, res) => {
    res.locals.handling = true;
    try { await nodeHandler(req, res, req.body); }
    catch { if (!res.headersSent) reject(res, 500, "Request could not be completed."); else res.end(); }
    finally { res.locals.release(); }
  });
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error.status === 413 ? 413 : error.status === 415 ? 415 : 400;
    reject(res, status, status === 413 ? "Request body is too large." : "Invalid request body.");
  });
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    closing = true;
    await handler.close();
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped;
  })();
  return { server, close };
}
