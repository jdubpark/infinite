import { handoffEnvelopeSchema } from "./handoff-types.js";
import { ReportError } from "./team-report-client.js";
export async function submitHandoff(request: unknown, env: NodeJS.ProcessEnv = process.env) {
  const { INFINITE_HOOK_URL: url, INFINITE_HOOK_TOKEN: token, INFINITE_HANDOFF_SESSION: sessionId } = env;
  if (!url || !token || !sessionId || token.length > 512 || /[\x00-\x20\x7f]/.test(token)) throw new ReportError("Handoff is unavailable in this process.");
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/hook" || endpoint.search || endpoint.hash) throw new ReportError("Invalid handoff endpoint.");
  endpoint.pathname = "/hook/team-handoff";
  const envelope = handoffEnvelopeSchema.parse({ sessionId, request });
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(60000), redirect: "error" });
  await response.body?.cancel();
  if (response.status !== 204) throw new ReportError(`Handoff refused or unconfirmed (${response.status}). Preserve your edits and inspect the session. Do not bypass a refusal or permission denial.`);
  return envelope;
}
