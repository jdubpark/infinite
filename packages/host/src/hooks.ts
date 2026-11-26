import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { SecondaryRequest } from "./transcript-secondary.js";

export type HookRoute = "claude" | "codex" | "codex-notify" | "team-report" | "mission-report" | "team-handoff" | "transcript" | "drain" | "team-entry" |
  "permission-check" | "permission-request";
const ROUTES = new Set<string>(["claude", "codex", "codex-notify", "team-report", "mission-report", "team-handoff", "transcript", "drain", "team-entry",
  "permission-check", "permission-request"]);
const MAX_BODY = 256 * 1024;
export const HOOK_CAPABILITIES_HEADER = "X-Infinite-Hook-Capabilities";
export const QUESTION_RECOMMENDATION_CAPABILITY = "question-recommendation";
export class HookPayloadError extends Error {
  constructor(readonly status: number, message = "Hook payload was refused") { super(message); }
}

export interface HookReply {
  transcript?: { path: string; after: number; drain?: number; secondaries?: boolean };
  after?: number;
  secondaries?: SecondaryRequest[];
  entry?: Record<string, unknown>;
}

export type HookAnswer = import("./permission-hook.js").ChannelAnswer;

export function startHookServer(opts: {
  token: string;
  onPayload: (route: HookRoute, body: unknown, run?: string) => HookReply | HookAnswer | void | Promise<HookReply | HookAnswer | void>;
  onError: () => void;
}): Promise<{ port: number; url: string; close: () => void }> {
  const expected = Buffer.from(opts.token);
  const server = createServer((req, res) => {
    const path = (req.url ?? "").replace(/^\/hook\//, "").replace(/^\//, "");
    const marked = /^(permission-check|permission-request)\/([0-9]{1,9})$/.exec(path);
    const route = marked?.[1] ?? path;
    if (req.method !== "POST" || !ROUTES.has(route)) {
      res.writeHead(404).end();
      return;
    }
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(
      header.startsWith("Bearer ") ? header.slice(7) : "",
    );
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      opts.onError();
      res.writeHead(401).end();
      return;
    }
    res.setHeader(HOOK_CAPABILITIES_HEADER, QUESTION_RECOMMENDATION_CAPABILITY);
    let body = "";
    let bytes = 0;
    let tooBig = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (tooBig) return;
      body += chunk;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY) {
        tooBig = true;
        body = "";
        opts.onError();
        res.writeHead(413, { Connection: "close" }).end();
      }
    });
    req.on("end", async () => {
      if (tooBig) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
      } catch {
        opts.onError();
        res.writeHead(400).end();
        return;
      }
      let reply: HookReply | HookAnswer | void = undefined;
      try {
        reply = await opts.onPayload(route as HookRoute, parsed, marked?.[2]);
      } catch (error) {
        opts.onError();
        if (error instanceof HookPayloadError && error.message !== "Hook payload was refused")
          res.writeHead(error.status, { "Content-Type": "text/plain; charset=utf-8" }).end(error.message);
        else res.writeHead(error instanceof HookPayloadError ? error.status : 500).end();
        return;
      }
      if (reply && Object.keys(reply).length) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply));
      else res.writeHead(204).end();
    });
    req.on("error", () => {});
  });
  server.keepAliveTimeout = 1000;
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        port,
        url: `http://127.0.0.1:${port}/hook`,
        close: () => server.close(),
      });
    });
  });
}
