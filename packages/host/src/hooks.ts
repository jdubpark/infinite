import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export type HookRoute = "claude" | "codex" | "codex-notify" | "transcript";
const ROUTES = new Set<string>(["claude", "codex", "codex-notify", "transcript"]);
const MAX_BODY = 256 * 1024;

/**
 * What the worker wants back from the relay. Only the relay reads this reply; the provider
 * sees the relay's empty stdout, so a reply can never become a hook decision.
 */
export interface HookReply {
  /** Send the transcript file at `path` from byte `after` to the `transcript` route. */
  transcript?: { path: string; after: number };
  /** Acknowledged transcript bytes; the relay continues from here. */
  after?: number;
}

export function startHookServer(opts: {
  token: string;
  onPayload: (route: HookRoute, body: unknown) => HookReply | void;
  onError: () => void;
}): Promise<{ port: number; url: string; close: () => void }> {
  const expected = Buffer.from(opts.token);
  const server = createServer((req, res) => {
    const route = (req.url ?? "").replace(/^\/hook\//, "").replace(/^\//, "");
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
    let body = "";
    let bytes = 0;
    let tooBig = false;
    // A multi-byte character can straddle two TCP chunks; the stream decoder joins them.
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
    req.on("end", () => {
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
      let reply: HookReply | void = undefined;
      try {
        reply = opts.onPayload(route as HookRoute, parsed);
      } catch {
        opts.onError();
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
