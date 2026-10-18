import express from "express";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createSocketServer, isIP, type Server as SocketServer, type Socket } from "node:net";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_FRAME_BYTES, MAX_REQUEST_BYTES, parseRelayEnvelope, UUID, type RelayEnvelope } from "@infinite/remote/protocol";

export interface RelayOptions {
  /** Only relay registration hashes. Never put device keys or their hashes here. */
  registrations: { machineId: string; tokenHash: string }[];
  maxClients?: number;
  maxClientsPerMachine?: number;
  maxHosts?: number;
  /** Concurrent client channels from one address (an IPv6 /64), so one source cannot fill a machine's slots. */
  maxClientsPerAddress?: number;
  /**
   * A tunnel or reverse proxy on this machine connects through `relay.proxy`, a listener for a
   * Unix socket whose permissions admit only that proxy. `addressHeader` names the header it sets
   * to the real client address (for Cloudflare, `cf-connecting-ip`). Client channels are then
   * accepted only through the proxy, so other local processes reach only the host route.
   */
  proxy?: { addressHeader: string };
}

const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES * 4;
const MAX_REQUEST_FRAME = MAX_REQUEST_BYTES * 2 + 4096;
const MAX_TRACKED_ADDRESSES = 1024;

/** An IPv4 address, or the /64 of an IPv6 address, since one client can hold a whole /64. */
function addressKey(value: string) {
  const address = value.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (isIP(address) !== 6) return address;
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

/**
 * An untrusted router: the only exposed content is ciphertext and routing metadata.
 * It serves no web client; the browser client is for local development only.
 */
export function createRelayServer(options: RelayOptions) {
  const registrations = new Map<string, Buffer>();
  for (const registration of options.registrations) {
    if (!UUID.test(registration.machineId) || !/^[a-f0-9]{64}$/.test(registration.tokenHash) || registrations.has(registration.machineId)) throw new Error("Invalid relay registration");
    registrations.set(registration.machineId, Buffer.from(registration.tokenHash, "hex"));
  }
  // Without a proxy, every proxied client shares the proxy's address; only a proxy makes a per-address cap meaningful.
  const limits = { clients: options.maxClients ?? 128, perMachine: options.maxClientsPerMachine ?? 16, hosts: options.maxHosts ?? 64, perAddress: options.maxClientsPerAddress ?? (options.proxy ? 4 : 1024) };
  if (Object.values(limits).some(limit => !Number.isInteger(limit) || limit < 1 || limit > 1024)) throw new Error("Invalid relay connection limit");
  const addressHeader = options.proxy?.addressHeader.toLowerCase();
  if (addressHeader !== undefined && !/^[a-z0-9-]{1,64}$/.test(addressHeader)) throw new Error("Invalid relay client address header");
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    }); next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/relay", (_req, res) => res.status(404).json({ error: "WebSocket connection required" }));
  app.use((_req, res) => res.status(404).json({ error: "Connect to a machine using its relay profile" }));
  const server = createServer(app);
  const hostSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 1024, perMessageDeflate: false });
  const clientSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_FRAME, perMessageDeflate: false });
  const hosts = new Map<string, WebSocket>();
  const clients = new Map<string, { machineId: string; address: string; socket: WebSocket }>();
  const attempts = new Map<string, { count: number; start: number }>();
  const proxied = new WeakSet<Socket>();
  const proxy: SocketServer | undefined = options.proxy ? createSocketServer(socket => { proxied.add(socket); server.emit("connection", socket); }) : undefined;
  let closed = false;

  function buffered() {
    let total = 0;
    for (const socket of hostSockets.clients) total += socket.bufferedAmount;
    for (const socket of clientSockets.clients) total += socket.bufferedAmount;
    return total;
  }
  function send(socket: WebSocket, text: string): boolean {
    if (socket.readyState !== WebSocket.OPEN || Buffer.byteLength(text) > MAX_FRAME_BYTES + 1024 || buffered() + Buffer.byteLength(text) > MAX_BUFFERED_BYTES) return false;
    socket.send(text, error => { if (error) socket.terminate(); }); return true;
  }
  function sendHost(socket: WebSocket, frame: RelayEnvelope) { return send(socket, JSON.stringify(frame)); }
  function dropClient(id: string, notify = true) {
    const client = clients.get(id);
    if (!client) return;
    clients.delete(id); client.socket.terminate();
    const host = hosts.get(client.machineId);
    if (notify && host && !sendHost(host, { type: "close", id })) host.terminate();
  }
  function heartbeat(socket: WebSocket) {
    let alive = true;
    socket.on("pong", () => { alive = true; });
    const timer = setInterval(() => {
      if (!alive || socket.readyState !== WebSocket.OPEN) { socket.terminate(); return; }
      alive = false; socket.ping();
    }, 15000); timer.unref();
    socket.once("close", () => clearInterval(timer));
    socket.on("error", () => socket.terminate());
  }

  function clientAddress(req: IncomingMessage) {
    if (!addressHeader || !proxied.has(req.socket)) return addressKey(req.socket.remoteAddress ?? "unknown");
    const forwarded = req.headers[addressHeader];
    return typeof forwarded === "string" && isIP(forwarded.trim()) ? addressKey(forwarded) : "proxy";
  }
  /** Counts an attempt; false once an address has made 60 in a minute. */
  function admit(address: string, now: number) {
    for (const [key, entry] of attempts) if (now - entry.start > 60000) attempts.delete(key);
    const attempt = attempts.get(address);
    if (attempt) return ++attempt.count <= 60;
    // Forget the oldest address rather than refuse new ones, so rotating addresses cannot lock everyone out.
    // A client rotating through more addresses can reset its own count; the edge gate in front bounds that.
    if (attempts.size >= MAX_TRACKED_ADDRESSES) attempts.delete(attempts.keys().next().value!);
    attempts.set(address, { start: now, count: 1 });
    return true;
  }

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const reject = (status: number) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    const route = /^\/relay\/(hosts|clients)\/([^/?#]+)$/.exec(req.url ?? "");
    if (closed || !route || !UUID.test(route[2])) { reject(404); return; }
    const now = Date.now(), ip = clientAddress(req);
    const machineId = route[2];
    if (route[1] === "hosts") {
      // A registered runner is never throttled by other traffic on its address; failed attempts are.
      const hash = registrations.get(machineId), token = req.headers.authorization?.match(/^Bearer ([\x21-\x7e]{32,200})$/)?.[1];
      if (!hash || !token || req.headers.origin || !timingSafeEqual(createHash("sha256").update(token).digest(), hash)) { reject(admit(ip, now) ? 403 : 429); return; }
      if (hosts.has(machineId)) { reject(409); return; }
      if (hosts.size >= limits.hosts) { reject(429); return; }
      hostSockets.handleUpgrade(req, socket, head, ws => {
        hosts.set(machineId, ws); heartbeat(ws);
        ws.on("close", () => {
          if (hosts.get(machineId) !== ws) return;
          hosts.delete(machineId);
          for (const [id, client] of clients) if (client.machineId === machineId) dropClient(id, false);
        });
        ws.on("message", (data, binary) => {
          try {
            if (binary) throw new Error("Invalid relay frame");
            const frame = parseRelayEnvelope(data.toString());
            if (frame.type === "open") throw new Error("Only the relay opens channels");
            const client = clients.get(frame.id);
            if (!client) return;
            if (client.machineId !== machineId) throw new Error("Invalid relay channel owner");
            if (frame.type === "close") dropClient(frame.id, false);
            else if (!send(client.socket, frame.data)) dropClient(frame.id);
          } catch { ws.terminate(); }
        });
      });
    } else {
      if (proxy && !proxied.has(req.socket)) { reject(403); return; }
      if (!admit(ip, now)) { reject(429); return; }
      const host = hosts.get(machineId);
      if (!host || host.readyState !== WebSocket.OPEN) { reject(503); return; }
      const active = [...clients.values()];
      if (clients.size >= limits.clients || active.filter(client => client.machineId === machineId).length >= limits.perMachine ||
        active.filter(client => client.address === ip).length >= limits.perAddress) { reject(429); return; }
      clientSockets.handleUpgrade(req, socket, head, ws => {
        const id = randomUUID();
        clients.set(id, { machineId, address: ip, socket: ws }); heartbeat(ws);
        if (!sendHost(host, { type: "open", id })) { dropClient(id); return; }
        let rateStart = Date.now(), frames = 0;
        ws.on("message", (data, binary) => {
          const time = Date.now();
          if (time - rateStart >= 1000) { rateStart = time; frames = 0; }
          if (binary || ++frames > 128 || !sendHost(host, { type: "data", id, data: data.toString() })) dropClient(id);
        });
        ws.on("close", () => dropClient(id));
      });
    }
  });
  function close() {
    if (closed) return;
    closed = true;
    for (const id of clients.keys()) dropClient(id, false);
    for (const socket of hostSockets.clients) socket.terminate();
    hosts.clear(); hostSockets.close(); clientSockets.close(); server.closeAllConnections(); server.close(); proxy?.close();
    for (const hash of registrations.values()) hash.fill(0);
  }
  server.once("close", close);
  return { server, proxy, close };
}
