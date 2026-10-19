import { createHash } from "node:crypto";
import { z } from "zod";
import { teamReportEnvelopeSchema, teamReportSchema, type TeamReportEnvelope } from "./team-types.js";
import { missionReportEnvelopeSchema, missionReportSchema } from "./mission-types.js";

type MissionReportEnvelope = z.infer<typeof missionReportEnvelopeSchema>;

export class ReportError extends Error {}
export const MAX_TEAM_REPORT_BYTES = 64 * 1024;
const bindingSchema = teamReportEnvelopeSchema.pick({ runId: true, memberId: true, revision: true }).strip();
function reportEnvironment(env: NodeJS.ProcessEnv) {
  const { INFINITE_HOOK_URL: url, INFINITE_HOOK_TOKEN: token, INFINITE_TEAM_ASSIGNMENT: assignment } = env;
  if (!url || !token || !assignment) throw new ReportError("Team reporting is unavailable in this process.");
  if (url.length > 2048 || token.length > 512 || /[\x00-\x20\x7f]/.test(token) || assignment.length > 4096)
    throw new ReportError("Invalid team reporting capability.");
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new ReportError("Invalid team report endpoint."); }
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/hook" || endpoint.search || endpoint.hash)
    throw new ReportError("Invalid team report endpoint.");
  endpoint.pathname = "/hook/team-report";
  let binding: z.infer<typeof bindingSchema>;
  try { binding = bindingSchema.parse(JSON.parse(assignment)); }
  catch { throw new ReportError("Invalid team assignment."); }
  return { endpoint, token, binding };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ReportError("Invalid report value.");
  return encoded;
}
/** A custom UUIDv8 pins retries to the same validated assignment and report, across processes. */
function reportIdentity(value: unknown) {
  const bytes = createHash("sha256").update("infinite-team-report:v1\0").update(canonical(value)).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Whether this process reports for a mission coordinator, whose envelope names the mission instead of a run. */
export function missionReporter(env: NodeJS.ProcessEnv = process.env) {
  try { return z.object({ role: z.literal("mission-coordinator") }).safeParse(JSON.parse(env.INFINITE_TEAM_ASSIGNMENT ?? "null")).success; }
  catch { return false; }
}
function createMissionEnvelope(input: unknown, binding: z.infer<typeof bindingSchema>): MissionReportEnvelope {
  const { runId: missionId, memberId, revision } = binding;
  let envelope: MissionReportEnvelope;
  if (input !== null && typeof input === "object" && !Array.isArray(input) && "report" in input) envelope = missionReportEnvelopeSchema.parse(input);
  else {
    const report = missionReportSchema.parse(input);
    envelope = missionReportEnvelopeSchema.parse({ missionId, memberId, revision, report, requestId: reportIdentity({ missionId, memberId, revision, report }) });
  }
  if (envelope.missionId !== missionId || envelope.memberId !== memberId || envelope.revision !== revision)
    throw new ReportError("The report does not match this coordinator's assigned mission and revision.");
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_TEAM_REPORT_BYTES) throw new ReportError("Report exceeds 64 KiB.");
  return envelope;
}
/** Accept a raw report or an explicit retry envelope, always bound to this worker's assignment. */
export function createReportEnvelope(input: unknown, env: NodeJS.ProcessEnv = process.env): TeamReportEnvelope | MissionReportEnvelope {
  const { binding } = reportEnvironment(env);
  if (missionReporter(env)) return createMissionEnvelope(input, binding);
  let envelope: TeamReportEnvelope;
  if (input !== null && typeof input === "object" && !Array.isArray(input) && "report" in input) {
    envelope = teamReportEnvelopeSchema.parse(input);
  } else {
    const report = teamReportSchema.parse(input);
    envelope = teamReportEnvelopeSchema.parse({ ...binding, report, requestId: reportIdentity({ ...binding, report }) });
  }
  if (envelope.runId !== binding.runId || envelope.memberId !== binding.memberId || envelope.revision !== binding.revision)
    throw new ReportError("The report does not match this worker's assigned team member and revision.");
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_TEAM_REPORT_BYTES) throw new ReportError("Report exceeds 64 KiB.");
  return envelope;
}
/** HTTP 204 is sent by the worker only after its authenticated journal append has succeeded. */
export async function submitTeamReport(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<TeamReportEnvelope | MissionReportEnvelope> {
  const { endpoint, token } = reportEnvironment(env);
  const envelope = createReportEnvelope(input, env);
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(envelope), signal: AbortSignal.timeout(10000), redirect: "error",
  });
  await response.body?.cancel();
  if (response.status !== 204)
    throw new ReportError(`Report refused or unconfirmed (${response.status}). Stop and inspect this member's recorded report; do not bypass the refusal or submit a different report.`);
  return envelope;
}
export function reportErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return ("Invalid team report: " + error.issues.map(issue => `${issue.path.join(".") || "report"}: ${issue.message}`).join("; ")).slice(0, 2000);
  if (error instanceof ReportError) return error.message;
  if (error instanceof SyntaxError) return "Invalid JSON. Submit one JSON object.";
  return "Team report was not confirmed. Inspect the team before retrying the identical report; do not assume completion or submit a different report.";
}
