import { request as httpRequest } from "node:http";
import { requesterNotice } from "./permission-policy.js";

export type ChannelRoute = "check" | "request";
export interface ChannelAnswer { decision: "defer" | "allow" | "deny" | "none"; reason?: string }

const MAX_BODY = 256 * 1024;
export const RELAY_DEADLINE_MS: Record<ChannelRoute, number> = { check: 15_000, request: 345_000 };
const UNAVAILABLE = requesterNotice("unavailable");

const clean = (text: unknown) => String(text ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ").slice(0, 2000);

export function hookOutput(route: ChannelRoute, answer: ChannelAnswer): string {
  if (route === "check") {
    if (answer.decision === "none") return "";
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: answer.decision,
      ...(answer.decision === "allow" ? {} : { permissionDecisionReason: clean(answer.reason || UNAVAILABLE) }),
    } });
  }
  if (answer.decision === "none") return "";
  const behavior = answer.decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: clean(answer.reason || UNAVAILABLE) };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: behavior } });
}

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

export async function ask(route: ChannelRoute, body: string, options: { url: string; token: string; run: string; post?: ChannelPost }): Promise<ChannelAnswer> {
  const denied: ChannelAnswer = { decision: "deny", reason: UNAVAILABLE };
  try {
    const response = await (options.post ?? post)(`${options.url}/permission-${route}/${options.run}`, options.token, body, RELAY_DEADLINE_MS[route] - 1000);
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
    const url = process.env.INFINITE_HOOK_URL, token = process.env.INFINITE_HOOK_TOKEN, run = process.argv[3];
    if (!url || !token || !run) return { decision: "deny", reason: UNAVAILABLE };
    let body = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      body += chunk;
      if (body.length > MAX_BODY) return { decision: "deny", reason: UNAVAILABLE };
    }
    return ask(route, body, { url, token, run });
  };
  main().catch((): ChannelAnswer => ({ decision: "deny", reason: UNAVAILABLE })).then(answer => { clearTimeout(deadline); finish(answer); });
}
