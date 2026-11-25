import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { NATIVE_COMPRESSION, NATIVE_MAX_BUFFERED, NATIVE_MAX_MESSAGE } from "./native-transport.js";

const MAX_CHANNELS = 16;
const MAX_PENDING_MESSAGES = 128;
const CONNECT_TIMEOUT = 10000;
const HEARTBEAT_INTERVAL = 15000;

type Frame = { type: "ready"; cwd: string } | { type: "open" | "close"; id: string } | { type: "data"; id: string; data: string }
  | { type: "request"; id: string; method: string; params: unknown }
  | { type: "response"; id: string; result?: unknown; error?: string };
export type ExecutorControl = (method: string, params?: unknown) => Promise<any>;
export interface ExecutorActivity { revision: number; busy: boolean; uncertain: boolean }

type DevicePhase =
  | { state: "disconnected"; initialReady: boolean; retired: boolean; paused: boolean }
  | { state: "connecting"; socket: WebSocket; timeout: ReturnType<typeof setTimeout>; initialReady: boolean; retired: boolean; paused: boolean }
  | { state: "ready"; socket: WebSocket; retired: boolean; paused: boolean }
  | { state: "closed" };

type ForwardPhase =
  | { state: "connecting"; cloud: WebSocket; timeout: ReturnType<typeof setTimeout> }
  | { state: "ready"; cloud: WebSocket }
  | { state: "finished" };

function parseFrame(text: string): Frame {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid executor tunnel frame");
  const frame = value as Record<string, unknown>;
  if (frame.type === "ready" && typeof frame.cwd === "string" && Object.keys(frame).length === 2) return frame as Frame;
  if (typeof frame.id !== "string" || !frame.id.length || frame.id.length > 128) throw new Error("Invalid executor tunnel channel");
  if ((frame.type === "open" || frame.type === "close") && Object.keys(frame).length === 2) return frame as Frame;
  if (frame.type === "data" && typeof frame.data === "string" && Object.keys(frame).length === 3) return frame as Frame;
  if (frame.type === "request" && typeof frame.method === "string" && frame.method.startsWith("sync/") && frame.method.length < 64) return frame as Frame;
  if (frame.type === "response" && (frame.error === undefined || typeof frame.error === "string")) return frame as Frame;
  throw new Error("Invalid executor tunnel frame");
}

function authorized(header: string | undefined, token: string) {
  const given = Buffer.from(header ?? ""), expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function heartbeat(socket: WebSocket, failed: () => void) {
  let alive = true;
  socket.on("pong", () => { alive = true; });
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN || !alive) { failed(); return; }
    alive = false;
    try { socket.ping(); } catch { failed(); }
  }, HEARTBEAT_INTERVAL);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
}

function send(socket: WebSocket, text: string, buffered: number, failed: () => void) {
  const bytes = Buffer.byteLength(text);
  if (socket.readyState !== WebSocket.OPEN || bytes > NATIVE_MAX_MESSAGE || buffered + bytes > NATIVE_MAX_BUFFERED) { failed(); return false; }
  try { socket.send(text, error => { if (error) failed(); }); return true; }
  catch { failed(); return false; }
}

export interface ExecutorTunnel {
  environment: { environmentId: string; url: string; token: string; cwd: string };
  ready: Promise<void>;
  attach: () => { url: string; token: string };
  retire: () => void;
  pause: (value: boolean) => void;
  close: () => void;
}

export async function createExecutorTunnel(options: {
  cwd: string; onConnection?: (online: boolean) => void;
  onControl?: ExecutorControl; onActivity?: (activity: ExecutorActivity) => void;
  record?: (data: Record<string, unknown>) => void;
}): Promise<ExecutorTunnel> {
  const providerToken = randomBytes(32).toString("hex"), deviceToken = randomBytes(32).toString("hex");
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: NATIVE_MAX_MESSAGE, perMessageDeflate: false });
  const channels = new Map<string, WebSocket>();
  const requests = new Map<string, { method: string; processId?: string; handleId?: string; writable?: boolean }>();
  const processes = new Set<string>(), handles = new Set<string>();
  const held = new Map<string, { channel: string; id: string | number }>();
  let revision = 0, uncertain = false, controls = 0;
  const activity = () => options.onActivity?.({ revision, busy: requests.size > 0 || processes.size > 0 || handles.size > 0, uncertain });
  const rpcKey = (channel: string, id: unknown) => `${channel}:${JSON.stringify(id)}`;
  const trackRequest = (channel: string, text: string) => {
    const rpc = JSON.parse(text);
    if (rpc.id === undefined || typeof rpc.method !== "string" || ["initialize", "environment/info", "environment/status"].includes(rpc.method)) return;
    const key = rpcKey(channel, rpc.id);
    if (requests.has(key)) throw new Error("Duplicate executor operation");
    if (requests.size >= 1024) throw new Error("Too many executor operations");
    options.record?.({ phase: "dispatch", operation: key, method: rpc.method, revision: ++revision });
    requests.set(key, { method: rpc.method, processId: rpc.params?.processId, handleId: rpc.params?.handleId, writable: rpc.params?.mode !== undefined && rpc.params.mode !== "read" });
    if (rpc.method === "process/start" && typeof rpc.params?.processId === "string") processes.add(rpc.params.processId);
    if (rpc.method === "fs/open" && rpc.params?.mode && rpc.params.mode !== "read" && typeof rpc.params.handleId === "string") handles.add(rpc.params.handleId);
    activity();
  };
  const trackResponse = (channel: string, text: string) => {
    const rpc = JSON.parse(text);
    const key = rpcKey(channel, rpc.id), request = requests.get(key);
    if (request && !rpc.method) {
      options.record?.({ phase: "result", operation: key, failed: Boolean(rpc.error), revision: ++revision });
      requests.delete(key);
      if (request.processId && (rpc.result?.exited || (rpc.error && request.method === "process/start"))) processes.delete(request.processId);
      if (request.handleId && (request.method === "fs/close" || (request.method === "fs/open" && rpc.error))) handles.delete(request.handleId);
    }
    if (rpc.method === "process/exited" && typeof rpc.params?.processId === "string") {
      options.record?.({ phase: "process-exited", processId: rpc.params.processId, revision: ++revision });
      processes.delete(rpc.params.processId);
    }
    activity();
  };
  let phase: DevicePhase = { state: "disconnected", initialReady: false, retired: false, paused: false };
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const buffered = () => {
    const deviceBytes = phase.state === "connecting" || phase.state === "ready" ? phase.socket.bufferedAmount : 0;
    return [...channels.values()].reduce((bytes, socket) => bytes + socket.bufferedAmount, deviceBytes);
  };
  const notify = (online: boolean) => { try { options.onConnection?.(online); } catch { close(); } };
  const dropDevice = (socket: WebSocket) => {
    if ((phase.state !== "connecting" && phase.state !== "ready") || phase.socket !== socket) return;
    const wasReady = phase.state === "ready";
    const initialReady = phase.state === "ready" ? true : phase.initialReady;
    if (phase.state === "connecting") clearTimeout(phase.timeout);
    phase = {
      state: "disconnected",
      initialReady,
      retired: phase.retired,
      paused: true,
    };
    if (requests.size || processes.size || handles.size) uncertain = true;
    socket.terminate();
    activity();
    if (wasReady) notify(false);
  };
  const sendDevice = (frame: Frame) => {
    if (phase.state !== "connecting" && phase.state !== "ready") return false;
    const target = phase.socket;
    return send(target, JSON.stringify(frame), buffered(), () => dropDevice(target));
  };
  const dropChannel = (id: string, tellDevice: boolean) => {
    const provider = channels.get(id);
    if (!provider) return;
    channels.delete(id); provider.terminate();
    if ([...requests.keys()].some(key => key.startsWith(`${id}:`))) { uncertain = true; activity(); }
    if (tellDevice && phase.state === "ready") sendDevice({ type: "close", id });
  };
  function close() {
    if (phase.state === "closed") return;
    const prev = phase;
    phase = { state: "closed" };
    if ((prev.state === "disconnected" || prev.state === "connecting") && !prev.initialReady) {
      rejectReady(new Error("Executor tunnel closed before the laptop connected"));
    }
    if (prev.state === "connecting") clearTimeout(prev.timeout);
    if (prev.state === "connecting" || prev.state === "ready") {
      if (requests.size || processes.size || handles.size) uncertain = true;
      prev.socket.terminate();
      activity();
      if (prev.state === "ready") notify(false);
    }
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    server.close();
  }
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const isDevice = req.url === "/device", isProvider = req.url === "/executor";
    if (phase.state === "closed" || req.headers.origin !== undefined || (!isDevice && !isProvider) ||
        !authorized(req.headers.authorization, isDevice ? deviceToken : providerToken) ||
        (isDevice ? phase.state !== "disconnected" : phase.retired || channels.size >= MAX_CHANNELS)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, connection => {
      if (isDevice) {
        if (phase.state !== "disconnected") { connection.terminate(); return; }
        const timeout = setTimeout(() => dropDevice(connection), CONNECT_TIMEOUT);
        timeout.unref();
        phase = {
          state: "connecting",
          socket: connection,
          timeout,
          initialReady: phase.initialReady,
          retired: phase.retired,
          paused: phase.paused,
        };
        heartbeat(connection, () => dropDevice(connection));
        connection.on("error", () => dropDevice(connection));
        connection.on("close", () => { clearTimeout(timeout); dropDevice(connection); });
        connection.on("message", (data, binary) => {
          try {
            if (binary || (phase.state !== "connecting" && phase.state !== "ready") || phase.socket !== connection) {
              throw new Error("Invalid executor tunnel frame");
            }
            const frame = parseFrame(data.toString());
            if (phase.state === "connecting") {
              if (frame.type !== "ready" || frame.cwd !== options.cwd) throw new Error("Executor workspace does not match");
              clearTimeout(phase.timeout);
              phase = { state: "ready", socket: connection, retired: phase.retired, paused: phase.paused };
              if (!sendDevice({ type: "ready", cwd: options.cwd })) return;
              resolveReady();
              notify(true);
              if (phase.state === "ready" && !phase.paused && !uncertain && !phase.retired) {
                for (const id of channels.keys()) dropChannel(id, false);
              }
              return;
            }
            if (frame.type === "request") {
              if (!options.onControl || controls >= 8) throw new Error("Executor control unavailable");
              controls++;
              void options.onControl(frame.method, frame.params).then(
                result => { if (phase.state === "ready" && phase.socket === connection) sendDevice({ type: "response", id: frame.id, result }); },
                error => { if (phase.state === "ready" && phase.socket === connection) sendDevice({ type: "response", id: frame.id, error: error instanceof Error ? error.message.slice(0, 300) : "Workspace transfer failed" }); },
              ).finally(() => { controls--; });
            } else if (frame.type === "close") dropChannel(frame.id, false);
            else if (frame.type === "data") {
              const provider = channels.get(frame.id);
              if (provider && !phase.retired) { trackResponse(frame.id, frame.data); send(provider, frame.data, buffered(), () => dropChannel(frame.id, true)); }
            } else throw new Error("Invalid executor tunnel frame");
          } catch { dropDevice(connection); }
        });
      } else {
        const id = randomUUID();
        channels.set(id, connection);
        heartbeat(connection, () => dropChannel(id, true));
        connection.on("error", () => dropChannel(id, true));
        connection.on("close", () => dropChannel(id, true));
        connection.on("message", (data, binary) => {
          if (binary) { dropChannel(id, true); return; }
          if (channels.get(id) !== connection || phase.state === "closed") return;
          try {
            const text = data.toString();
            if (phase.retired) {
              const rpc = JSON.parse(text);
              if (rpc.id !== undefined) send(connection, JSON.stringify({ id: rpc.id, error: { code: -32000, message: "This request was not executed. The conversation now uses the cloud environment; use its current workspace." } }), buffered(), () => dropChannel(id, false));
              return;
            }
            if (phase.state !== "ready" || phase.paused || uncertain) {
              const rpc = JSON.parse(text);
              if (rpc.id !== undefined) {
                if (held.size >= MAX_PENDING_MESSAGES) throw new Error("Executor wait queue is full");
                held.set(rpcKey(id, rpc.id), { channel: id, id: rpc.id });
              }
              return;
            }
            trackRequest(id, text);
            if (!sendDevice({ type: "data", id, data: text })) activity();
          } catch { dropChannel(id, true); }
        });
        if (phase.state === "ready" && !sendDevice({ type: "open", id })) dropChannel(id, false);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new Error("Could not start executor tunnel"));
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
    });
  } catch (error) { close(); throw error; }
  server.on("error", close);
  const base = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    environment: { environmentId: randomUUID(), url: `${base}/executor`, token: providerToken, cwd: options.cwd },
    ready,
    attach: () => { if (phase.state === "closed") throw new Error("Executor tunnel is closed"); return { url: `${base}/device`, token: deviceToken }; },
    retire: () => {
      if (phase.state === "closed") return;
      phase.retired = true;
      for (const request of held.values()) {
        const provider = channels.get(request.channel);
        if (provider) send(provider, JSON.stringify({ id: request.id, error: { code: -32000, message: "This request was not executed. The conversation now uses the cloud environment; use its current workspace." } }), buffered(), () => {});
      }
      held.clear();
    },
    pause: value => {
      if (phase.state === "closed") return;
      phase.paused = value;
      if (!value && phase.state === "ready" && !uncertain && !phase.retired) {
        for (const id of new Set([...held.values()].map(request => request.channel))) dropChannel(id, true);
        held.clear();
      }
    },
    close,
  };
}

export async function forwardExecutor(options: {
  url: string; token: string; executorUrl: string; executorToken: string; cwd: string;
  deviceHeaders?: Record<string, string>; signal?: AbortSignal; onReady?: (control: ExecutorControl) => void;
}): Promise<void> {
  if (options.signal?.aborted) return;
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(options.executorUrl)) throw new Error("Invalid local executor endpoint");
  return new Promise<void>((resolve, reject) => {
    let cloud: WebSocket;
    try {
      const deviceHeaders = Object.fromEntries(Object.entries(options.deviceHeaders ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"));
      cloud = new WebSocket(options.url, {
        headers: { ...deviceHeaders, Authorization: `Bearer ${options.token}` }, maxPayload: NATIVE_MAX_MESSAGE,
        perMessageDeflate: NATIVE_COMPRESSION, handshakeTimeout: CONNECT_TIMEOUT,
      });
    } catch { reject(new Error("Could not connect executor tunnel")); return; }
    const channels = new Map<string, { socket: WebSocket; queued: string[]; bytes: number }>();
    const controls = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let queuedBytes = 0;
    const timeout = setTimeout(() => finish(new Error("Executor tunnel did not become ready")), CONNECT_TIMEOUT);
    timeout.unref();
    let phase: ForwardPhase = { state: "connecting", cloud, timeout };
    const buffered = () => {
      const cloudBytes = phase.state === "finished" ? 0 : phase.cloud.bufferedAmount;
      return [...channels.values()].reduce((bytes, channel) => bytes + channel.socket.bufferedAmount, cloudBytes + queuedBytes);
    };
    function finish(error?: Error) {
      if (phase.state === "finished") return;
      const prev = phase;
      phase = { state: "finished" };
      if (prev.state === "connecting") clearTimeout(prev.timeout);
      options.signal?.removeEventListener("abort", abort);
      prev.cloud.terminate();
      for (const channel of channels.values()) channel.socket.terminate();
      channels.clear(); queuedBytes = 0;
      for (const call of controls.values()) call.reject(new Error("Workspace connection closed"));
      controls.clear();
      if (error) reject(error); else resolve();
    }
    const abort = () => finish();
    const sendCloud = (frame: Frame) => {
      if (phase.state === "finished") return false;
      return send(phase.cloud, JSON.stringify(frame), buffered(), () => finish(new Error("Executor tunnel disconnected or exceeded its buffer limit")));
    };
    const control: ExecutorControl = (method, params = {}) => new Promise((resolve, reject) => {
      if (phase.state !== "ready" || controls.size >= 8) { reject(new Error("Workspace connection unavailable")); return; }
      const id = randomUUID();
      const timer = setTimeout(() => { controls.delete(id); reject(new Error("Workspace request timed out")); }, 120000);
      controls.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      sendCloud({ type: "request", id, method, params });
    });
    const dropChannel = (id: string, tellCloud: boolean) => {
      const channel = channels.get(id);
      if (!channel) return;
      channels.delete(id); queuedBytes -= channel.bytes; channel.queued.length = 0; channel.bytes = 0; channel.socket.terminate();
      if (tellCloud && phase.state !== "finished") sendCloud({ type: "close", id });
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    cloud.on("error", () => finish(new Error("Executor tunnel connection failed")));
    cloud.on("close", () => finish(phase.state === "ready" ? undefined : new Error("Executor tunnel closed before it became ready")));
    cloud.on("open", () => {
      if (phase.state === "finished") return;
      heartbeat(cloud, () => finish(new Error("Executor tunnel heartbeat expired")));
      sendCloud({ type: "ready", cwd: options.cwd });
    });
    cloud.on("message", (data, binary) => {
      if (phase.state === "finished") return;
      try {
        if (binary) throw new Error("Invalid executor tunnel frame");
        const frame = parseFrame(data.toString());
        if (phase.state === "connecting") {
          if (frame.type !== "ready" || frame.cwd !== options.cwd) throw new Error("Executor workspace does not match");
          clearTimeout(phase.timeout);
          phase = { state: "ready", cloud: phase.cloud };
          options.onReady?.(control);
          return;
        }
        if (frame.type === "response") {
          const call = controls.get(frame.id);
          if (call) { controls.delete(frame.id); if (frame.error) call.reject(new Error(frame.error)); else call.resolve(frame.result); }
        } else if (frame.type === "open") {
          if (channels.has(frame.id) || channels.size >= MAX_CHANNELS) throw new Error("Executor channel limit reached");
          const socket = new WebSocket(options.executorUrl, {
            headers: { Authorization: `Bearer ${options.executorToken}` }, maxPayload: NATIVE_MAX_MESSAGE,
            perMessageDeflate: false, handshakeTimeout: CONNECT_TIMEOUT,
          });
          const channel = { socket, queued: [] as string[], bytes: 0 };
          channels.set(frame.id, channel);
          const failed = () => { if (channels.get(frame.id) === channel) dropChannel(frame.id, true); };
          socket.on("error", failed);
          socket.on("close", failed);
          socket.on("open", () => {
            if (phase.state === "finished" || channels.get(frame.id) !== channel) { socket.terminate(); return; }
            heartbeat(socket, failed);
            const queued = channel.queued;
            channel.queued = [];
            for (const text of queued) {
              const bytes = Buffer.byteLength(text);
              queuedBytes -= bytes; channel.bytes -= bytes;
              if (!send(socket, text, buffered(), failed)) break;
            }
          });
          socket.on("message", (message, isBinary) => {
            if (isBinary) { failed(); return; }
            if (phase.state !== "finished" && channels.get(frame.id) === channel) sendCloud({ type: "data", id: frame.id, data: message.toString() });
          });
        } else if (frame.type === "close") dropChannel(frame.id, false);
        else if (frame.type === "data") {
          const channel = channels.get(frame.id);
          if (!channel) return;
          if (channel.socket.readyState === WebSocket.OPEN) send(channel.socket, frame.data, buffered(), () => dropChannel(frame.id, true));
          else if (channel.socket.readyState === WebSocket.CONNECTING) {
            const bytes = Buffer.byteLength(frame.data);
            if (channel.queued.length >= MAX_PENDING_MESSAGES || buffered() + bytes > NATIVE_MAX_BUFFERED) throw new Error("Executor buffer limit reached");
            channel.bytes += bytes; queuedBytes += bytes; channel.queued.push(frame.data);
          } else dropChannel(frame.id, true);
        } else throw new Error("Invalid executor tunnel frame");
      } catch { finish(new Error("Executor tunnel protocol failed")); }
    });
    if (options.signal?.aborted) finish();
  });
}
