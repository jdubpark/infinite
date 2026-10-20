import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_FRAME_BYTES, MAX_RESPONSE_BYTES } from "@infinite/remote/protocol";
import { connectRemoteAccess } from "../packages/host/src/remote-access.js";
import { hashToken } from "../packages/host/src/config.js";
import type { Config } from "../packages/host/src/types.js";

export async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Real wire interception models an untrusted relay, without access to endpoint keys. */
export async function wireProxy(origin: string) {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 1024 });
  const live = new Set<WebSocket>();
  const frames: string[] = [];
  let corruptNext = false, corruptWelcome = false, dropResponse = false;
  let lastRequest = "", lastUpstream: WebSocket | undefined;
  server.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head, downstream => {
    const upstream = new WebSocket(origin.replace("http:", "ws:") + req.url);
    lastUpstream = upstream; live.add(upstream); live.add(downstream);
    const queue: string[] = [];
    upstream.on("open", () => { for (const text of queue) upstream.send(text); queue.length = 0; });
    downstream.on("message", data => {
      let text = data.toString(); frames.push(text);
      const frame = JSON.parse(text);
      if (frame.type === "ciphertext") {
        lastRequest = text;
        if (corruptNext) {
          corruptNext = false;
          frame.data = (frame.data[0] === "0" ? "1" : "0") + frame.data.slice(1);
          text = JSON.stringify(frame);
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else queue.push(text);
    });
    upstream.on("message", data => {
      let text = data.toString(); frames.push(text);
      const frame = JSON.parse(text);
      if (corruptWelcome && frame.type === "welcome") {
        corruptWelcome = false;
        frame.proof = (frame.proof[0] === "0" ? "1" : "0") + frame.proof.slice(1);
        text = JSON.stringify(frame);
      }
      if (dropResponse && JSON.parse(text).type === "ciphertext") {
        dropResponse = false; downstream.terminate(); upstream.terminate(); return;
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(text);
    });
    const close = () => { live.delete(upstream); live.delete(downstream); upstream.terminate(); downstream.terminate(); };
    upstream.on("error", close); upstream.on("close", close);
    downstream.on("error", close); downstream.on("close", close);
  }));
  return {
    url: await listen(server), frames,
    corrupt: () => { corruptNext = true; },
    forgeWelcome: () => { corruptWelcome = true; },
    loseResponse: () => { dropResponse = true; },
    replay: async () => {
      const upstream = lastUpstream!;
      const closed = new Promise<void>(resolve => upstream.once("close", () => resolve()));
      upstream.send(lastRequest); await closed;
    },
    close: () => { for (const socket of live) socket.terminate(); sockets.close(); server.closeAllConnections(); server.close(); },
  };
}

/** `answer` may reply to a request in place of the default echo by returning a JSON body. */
export async function httpRunner(answer?: (request: { path: string; body: unknown }) => unknown) {
  const token = randomBytes(32).toString("base64url"), machineId = randomUUID();
  const requests: { path: string; authorization?: string; body: unknown }[] = [];
  let oversized = false;
  let holdNextResponse: ((release: () => void) => void) | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const request = { path: req.url!, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null };
      requests.push(request);
      res.setHeader("Content-Type", "application/json");
      const answered = answer?.(request);
      let response = answered !== undefined
        ? JSON.stringify(answered)
        : JSON.stringify({ count: requests.length, method: req.method, path: req.url });
      if (oversized) { oversized = false; response = JSON.stringify({ value: "x".repeat(MAX_RESPONSE_BYTES) }); }
      if (holdNextResponse) {
        const held = holdNextResponse; holdNextResponse = undefined;
        held(() => res.end(response));
      } else res.end(response);
    });
  });
  const config = {
    origin: "http://127.0.0.1", port: 0, environment: "local", machine: { id: machineId, label: "Test runner" }, remote: { enabled: true },
    tokens: [{ id: "test-owner", label: "Test owner", role: "owner", hash: hashToken(token) }],
  } as Config;
  const closeRemote = connectRemoteAccess(server, config), url = await listen(server);
  return {
    token, machineId, requests, config, url,
    holdNext: () => new Promise<() => void>(resolve => { holdNextResponse = resolve; }),
    oversized: () => { oversized = true; },
    close: () => { closeRemote(); server.closeAllConnections(); server.close(); },
  };
}
