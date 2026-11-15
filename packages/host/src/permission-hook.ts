// The headless permission channel's hook command. Unlike the signal relay (hook-relay.ts), its stdout is a provider
// decision, so it prints only what the session's own worker answered on the channel routes, and a deny when the
// worker cannot answer in time. It runs inside the agent's account with the session's hook token, which reaches
// that session's worker and no other.
import { request as httpRequest } from "node:http";
import { requesterNotice } from "./permission-policy.js";

export type ChannelRoute = "check" | "request";
/** The worker's answer on a channel route. `none` leaves the call to the provider's own rules. */
export interface ChannelAnswer { decision: "defer" | "allow" | "deny" | "none"; reason?: string }

const MAX_BODY = 256 * 1024;
/** Below the hook timeouts in launch.ts, so the relay's deny always lands before the provider gives up on it. */
export const RELAY_DEADLINE_MS: Record<ChannelRoute, number> = { check: 15_000, request: 345_000 };
const UNAVAILABLE = requesterNotice("unavailable");

const clean = (text: unknown) => String(text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").slice(0, 2000);

/** The provider hook output for an answer. An empty string prints nothing. */
export function hookOutput(route: ChannelRoute, answer: ChannelAnswer): string {
  if (route === "check") {
    if (answer.decision === "none") return "";
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: answer.decision,
      ...(answer.decision === "allow" ? {} : { permissionDecisionReason: clean(answer.reason || UNAVAILABLE) }),
    } });
  }
  if (answer.decision === "none") return "";
  // A PermissionRequest hook cannot defer; anything but an allow is a deny.
  const behavior = answer.decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: clean(answer.reason || UNAVAILABLE) };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: behavior } });
}

/** One POST to the worker's loopback hook server. Node's fetch gives up on response headers after five minutes. */
export type ChannelPost = (url: string, token: string, body: string, timeoutMs: number) => Promise<{ status: number; text: string }>;

const post: ChannelPost = (url, token, body, timeoutMs) => new Promise((resolve, reject) => {
  const request = httpRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: `Bearer ${token}` },
  }, response => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => { text += chunk; if (text.length > MAX_BODY) request.destroy(new Error("oversized")); });
    response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
    response.on("error", reject);
  });
  request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
  request.on("error", reject);
  request.end(body);
});

/** Asks the worker. Every failure is a deny with the host's fixed notice. */
export async function ask(route: ChannelRoute, body: string, options: { url: string; token: string; post?: ChannelPost }): Promise<ChannelAnswer> {
  const denied: ChannelAnswer = { decision: "deny", reason: UNAVAILABLE };
  try {
    const response = await (options.post ?? post)(`${options.url}/permission-${route}`, options.token, body, RELAY_DEADLINE_MS[route] - 1000);
    if (response.status !== 200) return denied;
    let parsed: Partial<ChannelAnswer> | null = null;
    try { parsed = JSON.parse(response.text) as Partial<ChannelAnswer>; } catch { return denied; }
    if (!parsed || !["defer", "allow", "deny", "none"].includes(parsed.decision ?? "")) return denied;
    if (route === "request" && parsed.decision === "defer") return denied;
    return { decision: parsed.decision!, ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}) };
  } catch { return denied; }
}

const entry = process.argv[1] ?? "";
if (/permission-hook\.(?:ts|js)$/.test(entry)) {
  const route = process.argv[2] === "request" ? "request" : "check";
  let printed = false;
  const finish = (answer: ChannelAnswer) => {
    if (printed) return;
    printed = true;
    const output = hookOutput(route, answer);
    if (output) process.stdout.write(output);
    process.exit(0);
  };
  const deadline = setTimeout(() => finish({ decision: "deny", reason: UNAVAILABLE }), RELAY_DEADLINE_MS[route]);
  const main = async (): Promise<ChannelAnswer> => {
    const url = process.env.INFINITE_HOOK_URL, token = process.env.INFINITE_HOOK_TOKEN;
    if (!url || !token) return { decision: "deny", reason: UNAVAILABLE };
    let body = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > MAX_BODY) return { decision: "deny", reason: UNAVAILABLE };
    }
    return ask(route, body, { url, token });
  };
  main().catch((): ChannelAnswer => ({ decision: "deny", reason: UNAVAILABLE })).then(answer => { clearTimeout(deadline); finish(answer); });
}
