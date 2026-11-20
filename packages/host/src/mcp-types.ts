import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9-]{1,80}$/);
const projectIds = z.array(identifier).min(1).max(128).refine(ids => new Set(ids).size === ids.length, "List each project once.");
export const mcpConnectorSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  projectIds,
}).strict();
export const mcpConfigSchema = z.object({
  port: z.number().int().min(0).max(65535),
  origin: z.url().refine(value => {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  }, "Use an HTTPS origin, or HTTP loopback for local verification."),
  connectors: z.array(mcpConnectorSchema).min(1).max(16)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, "Connector IDs must be unique.")
    .refine(items => new Set(items.map(item => item.tokenHash)).size === items.length, "Connector credentials must be unique."),
}).strict();
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpConnector = z.infer<typeof mcpConnectorSchema>;
/** The authenticated connector's identity, never supplied by tool arguments. */
export interface ConnectorSource { kind: "connector"; id: string; name: string }

export const mcpStartSchema = z.object({
  requestId: z.uuid(),
  projectId: identifier,
  objective: z.string().trim().min(1).max(24000),
  title: z.string().trim().min(1).max(100).optional(),
}).strict();
export const mcpGetSchema = z.object({ runId: z.uuid() }).strict();
export const mcpReplySchema = z.object({
  runId: z.uuid(), requestId: z.uuid(), revision: z.number().int().min(1),
  text: z.string().trim().min(1).max(8000), decisionId: z.uuid().optional(),
}).strict();
export const mcpControlSchema = z.object({
  runId: z.uuid(), requestId: z.uuid(), revision: z.number().int().min(1),
  action: z.enum(["pause", "resume", "cancel"]),
}).strict();
export type McpStartInput = z.infer<typeof mcpStartSchema>;
export type McpReplyInput = z.infer<typeof mcpReplySchema>;
export type McpControlInput = z.infer<typeof mcpControlSchema>;
export interface McpProjectList { projects: { id: string; name: string }[] }
export interface McpRequestView {
  runId: string;
  projectId: string;
  title: string;
  status: "queued" | "planning" | "working" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "cancelled";
  revision?: number;
  tracking: { state: "pending" | "linked"; identifier?: string; url?: string };
  /** `recommendation` is what the asking agent would answer and why. It is never the person's answer. */
  questions: { id: string; question: string; options: string[]; recommendation?: { answers: string[]; reason: string } }[];
  result?: { kind: "agent-report"; summary: string };
  message?: string;
  availableActions: ("reply" | "pause" | "resume" | "cancel")[];
}
type Result<T> = T | Promise<T>;
/** Only the authenticated connector ID crosses from transport into the domain. */
export interface McpRequestApi {
  listProjects(connectorId: string): Result<McpProjectList>;
  startRequest(connectorId: string, input: McpStartInput): Result<McpRequestView>;
  getRequest(connectorId: string, runId: string): Result<McpRequestView>;
  replyToRequest(connectorId: string, input: McpReplyInput): Result<McpRequestView>;
  controlRequest(connectorId: string, input: McpControlInput): Result<McpRequestView>;
}
/** Fixed public errors; unexpected host/provider errors are never forwarded. */
export class McpRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "McpRequestError"; }
}
