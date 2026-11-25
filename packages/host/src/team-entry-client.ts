import { z } from "zod";
import { MAX_ENTRY_REQUEST_BYTES, memberEntryId, memberEntryPostSchema, memberListQuerySchema, refusalPath, type EntryBinding } from "./evidence/member-entry.js";
import { ReportError, hookCapability } from "./team-report-client.js";

export const ENTRY_TOOLS_ENV = "INFINITE_TEAM_ENTRY_TOOLS";
export class EntryError extends Error {}
export type EntryCall = { op: "post"; entry: unknown } | { op: "list"; query?: unknown } | { op: "get"; entryId: unknown };

const NOT_CONFIRMED = "Entry delivery was not confirmed: the endpoint gave no answer. A post may still be recorded; send the identical post again to learn its id.";
const entryIdSchema = z.uuid();

function invalid(error: z.ZodError): EntryError {
  return new EntryError(`entry-invalid at ${refusalPath(error.issues[0]?.path ?? []) || "request"}: the request does not match the entry schema.`);
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(result.error);
  return result.data;
}
function envelopeFor(call: EntryCall, binding: EntryBinding): Record<string, unknown> {
  if (call.op === "post") {
    const entry = parsed(memberEntryPostSchema, call.entry);
    return { op: "post", requestId: memberEntryId(binding, entry), ...binding, entry };
  }
  if (call.op === "list") return { op: "list", ...binding, query: parsed(memberListQuerySchema, call.query ?? {}) };
  return { op: "get", ...binding, entryId: parsed(entryIdSchema, call.entryId) };
}

export async function submitEntryCall(call: EntryCall, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const { endpoint, token, binding } = hookCapability(env, "team-entry");
  const body = JSON.stringify(envelopeFor(call, binding));
  if (Buffer.byteLength(body, "utf8") > MAX_ENTRY_REQUEST_BYTES) throw new EntryError("entry-too-large: a request is at most 16 KiB.");
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body, signal: AbortSignal.timeout(10000), redirect: "error",
    });
  } catch {
    throw new EntryError(NOT_CONFIRMED);
  }
  if (response.status >= 400) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 2000);
    throw new EntryError(detail || `Entry refused (${response.status}). Do not bypass the refusal.`);
  }
  if (response.status !== 200) throw new EntryError(NOT_CONFIRMED);
  let answer: unknown;
  try { answer = JSON.parse(await response.text()); } catch { throw new EntryError(NOT_CONFIRMED); }
  const entry = (answer as { entry?: unknown } | null)?.entry;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new EntryError(NOT_CONFIRMED);
  return entry as Record<string, unknown>;
}

export function entryErrorMessage(error: unknown): string {
  if (error instanceof EntryError || error instanceof ReportError) return error.message.slice(0, 2000);
  if (error instanceof z.ZodError) return invalid(error).message;
  if (error instanceof SyntaxError) return "Invalid JSON. Submit one JSON object.";
  return "Entry was not confirmed. Check your entries with entry_list before you post again.";
}
