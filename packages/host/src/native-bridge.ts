import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { controlActor, type PairedDevice } from "./device-control.js";
import { workerCall } from "./ipc.js";
import type { Manager } from "./manager.js";
import { NATIVE_COMPRESSION, NATIVE_MAX_BUFFERED, NATIVE_MAX_MESSAGE } from "./native-transport.js";

/** Native protocols grant owner capabilities. Browser cookies and narrower device roles cannot attach. */
export function connectNativeFrontends(server: Server, manager: Manager, authenticate: (token: string) => PairedDevice | undefined) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: NATIVE_COMPRESSION });
  const upstreams = new Set<WebSocket>();
  const origin = new URL(manager.config.origin);
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", origin); } catch { return; }
    if (!url.pathname.endsWith("/native") && !url.pathname.endsWith("/executor")) return;
    socket.on("error", () => {});
    const match = /^\/api\/sessions\/([a-f\d-]{36})\/(native|executor)$/.exec(url.pathname);
    const executor = match?.[2] === "executor";
    const executorToken = req.headers["x-infinite-executor"];
    const token = req.headers.authorization?.match(/^Bearer (.{32,200})$/)?.[1];
    const device = token ? authenticate(token) : undefined;
    const clientId = url.searchParams.get("client"), leaseId = url.searchParams.get("lease");
    const deny = () => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    if (!match || !z.uuid().safeParse(match[1]).success ||
        (executor ? typeof executorToken !== "string" || !/^[a-f0-9]{64}$/.test(executorToken) : !z.uuid().safeParse(clientId).success || !z.uuid().safeParse(leaseId).success) ||
        !device || device.role !== "owner" || req.headers.origin || sockets.clients.size >= 16 ||
        ![origin.host, `127.0.0.1:${manager.config.port}`, `localhost:${manager.config.port}`].includes(req.headers.host ?? "")) { deny(); return; }
    void (async () => {
      try {
        manager.meta(match[1]);
        const backend = await workerCall<{ url: string; token: string }>(manager.config.runDir, match[1], executor ? {
          op: "executor-connect", token: executorToken as string,
        } : {
          op: "native-connect", actor: controlActor(device, clientId!), leaseId: leaseId!,
        });
        if (socket.destroyed) return;
        // The worker supplies an authenticated loopback gate, never an arbitrary owner URL.
        if (!(executor ? /^ws:\/\/127\.0\.0\.1:\d+\/device$/ : /^ws:\/\/127\.0\.0\.1:\d+\/$/).test(backend.url)) throw new Error("Invalid native endpoint");
        sockets.handleUpgrade(req, socket, head, frontend => {
          const upstream = new WebSocket(backend.url, { headers: { Authorization: `Bearer ${backend.token}` }, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: false, handshakeTimeout: 10000 });
          upstreams.add(upstream);
          const queued: string[] = [];
          let bytes = 0, alive = true;
          const close = () => { frontend.terminate(); upstream.terminate(); };
          const timer = setInterval(() => { if (!alive) { close(); return; } alive = false; frontend.ping(); }, 15000);
          frontend.on("pong", () => { alive = true; });
          const send = (to: WebSocket, text: string) => {
            if (to.bufferedAmount + Buffer.byteLength(text) > NATIVE_MAX_BUFFERED) throw new Error("Slow native client");
            to.send(text);
          };
          frontend.on("message", (data, binary) => {
            try {
              if (binary) throw new Error("Invalid native frame");
              if (upstream.readyState === WebSocket.OPEN) send(upstream, data.toString());
              else if (upstream.readyState === WebSocket.CONNECTING) { bytes += Buffer.byteLength(data.toString()); if (bytes > 256 * 1024) throw new Error("Native queue is full"); queued.push(data.toString()); }
              else close();
            } catch { close(); }
          });
          upstream.on("open", () => { try { for (const text of queued) send(upstream, text); queued.length = 0; bytes = 0; } catch { close(); } });
          upstream.on("message", (data, binary) => { try { if (binary || frontend.readyState !== WebSocket.OPEN) throw new Error("Disconnected"); send(frontend, data.toString()); } catch { close(); } });
          frontend.on("close", () => { clearInterval(timer); upstream.close(); });
          upstream.on("close", () => { clearInterval(timer); upstreams.delete(upstream); frontend.close(); });
          frontend.on("error", close); upstream.on("error", close);
        });
      } catch { if (!socket.destroyed) deny(); }
    })();
  });
  return () => { for (const socket of [...sockets.clients, ...upstreams]) socket.terminate(); };
}
