import { watch } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { workerCall, type WorkerError } from "./ipc.js";
import { controlActor, type PairedDevice } from "./device-control.js";
import type { Manager } from "./manager.js";
import type { ControlActor, ControlLease, Receipt, TerminalSnapshot, WorkerState } from "./types.js";

// A snapshot is a rendered journal prefix. Watch before capturing it; every
// subsequent delta starts strictly after its cursor, even during heavy output.
export async function* terminalPages(manager: Manager, sessionId: string, after: number, signal: AbortSignal, snapshot = false) {
  let cursor = after, changed = true, wake: (() => void) | undefined, lastState = 0;
  const notify = () => { changed = true; wake?.(); };
  const watcher = watch(join(manager.config.stateDir, "sessions", sessionId, "events"), notify);
  watcher.on("error", notify);
  signal.addEventListener("abort", notify);
  try {
    if (snapshot && (await manager.state(sessionId)).capabilities?.terminalSnapshot === 1) {
      try {
        const screen = await workerCall<TerminalSnapshot>(manager.config.runDir, sessionId, { op: "snapshot" });
        if (screen.seq >= cursor) {
          cursor = screen.seq;
          yield { snapshot: screen, cursor };
        }
      } catch {
        // Existing workers, exited processes, and unsupported terminal state
        // use the lossless recording path. Never guess a screen's cursor.
      }
    }
    while (!signal.aborted) {
      changed = false;
      const page = manager.events(sessionId, cursor, 200, new Set(["output", "lifecycle"]));
      for (const event of page.events) yield { events: [event], cursor: event.seq };
      if (cursor !== page.cursor) yield { events: [], cursor: page.cursor, more: page.more };
      cursor = page.cursor;
      if (page.more) continue;
      if (Date.now() - lastState >= 1000) {
        const { status, pid, exitCode, control, capabilities, runtime, nativeSession } = await manager.state(sessionId);
        yield { state: { status, pid, exitCode, control, capabilities, runtime, nativeSession } };
        lastState = Date.now();
        if (status === "exited" || status === "unavailable") {
          const final = manager.events(sessionId, cursor, 200, new Set(["output", "lifecycle"]));
          yield final;
          if (!final.more) return;
          cursor = final.cursor;
          continue;
        }
      }
      if (!changed && !signal.aborted) await new Promise<void>(resolve => {
        const timer = setTimeout(done, 1000);
        function done() { clearTimeout(timer); wake = undefined; resolve(); }
        wake = done;
      });
    }
  } finally { watcher.close(); signal.removeEventListener("abort", notify); }
}

const authSchema = z.object({ token: z.string().regex(/^[\x21-\x7e]{32,200}$/), clientId: z.uuid().optional() }).strict();
const inputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("raw"), requestId: z.uuid(), text: z.string().min(1).max(8192), leaseId: z.uuid().optional() }).strict(),
  z.object({ op: z.literal("input"), requestId: z.uuid(), text: z.string().min(1).max(32000).regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/), submit: z.literal(false), leaseId: z.uuid().optional() }).strict(),
  z.object({ op: z.literal("resize"), cols: z.number().int().min(20).max(240), rows: z.number().int().min(5).max(100), leaseId: z.uuid().optional() }).strict(),
  z.object({ op: z.literal("control"), requestId: z.uuid(), action: z.enum(["claim", "renew", "release"]), leaseId: z.uuid().optional(), takeover: z.boolean().optional() }).strict(),
]);

export function connectTerminals(server: Server, manager: Manager, authenticate: (token: string) => PairedDevice | undefined) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 192 * 1024, perMessageDeflate: false });
  const origin = new URL(manager.config.origin);
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", origin); }
    catch { socket.destroy(); return; }
    const match = /^\/api\/sessions\/([a-f0-9-]{36})\/terminal$/.exec(url.pathname);
    const after = Number(url.searchParams.get("after") ?? 0);
    const hosts = [origin.host, `127.0.0.1:${manager.config.port}`, `localhost:${manager.config.port}`];
    if (!match || !z.uuid().safeParse(match[1]).success || !Number.isSafeInteger(after) || after < 0 ||
        !hosts.includes(req.headers.host ?? "") || (req.headers.origin && req.headers.origin !== origin.origin) || sockets.clients.size >= 32) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const abort = new AbortController();
      let device: PairedDevice | undefined, actor: ControlActor, legacy = true;
      let ready: Promise<WorkerState>, leaseId: string | undefined;
      let serial = Promise.resolve(), pendingBytes = 0, pendingFrames = 0, alive = true;
      const fail = (code: number) => { abort.abort(); ws.close(code); };
      const authTimeout = setTimeout(() => fail(1008), 10000);
      const heartbeat = setInterval(() => {
        if (!alive) { abort.abort(); ws.terminate(); return; }
        alive = false; ws.ping();
      }, 15000);
      ws.on("pong", () => {
        alive = true;
        if (legacy && leaseId) {
          const held = leaseId;
          serial = serial.then(async () => {
            await workerCall(manager.config.runDir, match[1], { op: "control", action: "renew", actor, leaseId: held });
          }).catch(() => { leaseId = undefined; fail(1011); });
        }
      });
      ws.on("error", () => abort.abort());
      ws.on("close", () => {
        abort.abort(); clearTimeout(authTimeout); clearInterval(heartbeat);
        // Let any in-flight claim settle before releasing. A stale release can
        // never clear a newer owner's lease (the worker checks its generation).
        void serial.then(async () => {
          if (leaseId) await workerCall(manager.config.runDir, match[1], { op: "control", action: "release", actor, leaseId });
        }).catch(() => {});
      });
      const send = (value: unknown) => new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error("Terminal disconnected")); return; }
        ws.send(JSON.stringify(value), error => error ? reject(error) : resolve());
      });
      ws.on("message", (data, binary) => {
        try {
          if (binary || abort.signal.aborted) { fail(1008); return; }
          const message: unknown = JSON.parse(data.toString());
          if (!device) {
            const auth = authSchema.parse(message);
            device = authenticate(auth.token);
            if (!device) { fail(1008); return; }
            actor = controlActor(device, auth.clientId ?? randomUUID());
            legacy = !auth.clientId;
            manager.meta(match[1]);
            ready = manager.state(match[1]);
            clearTimeout(authTimeout);
            void (async () => {
              try {
                for await (const page of terminalPages(manager, match[1], after, abort.signal, url.searchParams.get("snapshot") === "1")) await send(page);
                if (!abort.signal.aborted) ws.close(1000);
              } catch { fail(1011); }
            })();
            return;
          }
          if (device.role !== "owner") { fail(1008); return; }
          const input = inputSchema.parse(message);
          const size = Buffer.byteLength(data.toString());
          if (pendingBytes + size > 256 * 1024 || ++pendingFrames > 128) { fail(1008); return; }
          pendingBytes += size;
          serial = serial.then(async () => {
            if (abort.signal.aborted) return;
            const state = await ready;
            if (input.op === "control") {
              if (!state.capabilities?.inputControl) {
                await send({ refusal: { requestId: input.requestId, code: "unsupported" } }); return;
              }
              const { requestId, ...request } = input;
              const control = await workerCall<ControlLease | null>(manager.config.runDir, match[1], { ...request, actor });
              leaseId = control?.id;
              await send({ requestId, control });
              return;
            }
            if (state.capabilities?.inputControl && legacy && !leaseId) {
              leaseId = (await workerCall<ControlLease>(manager.config.runDir, match[1], { op: "control", action: "claim", actor })).id;
            }
            const suppliedLease = legacy ? leaseId : input.leaseId;
            if (state.capabilities?.inputControl && !suppliedLease) {
              await send({ refusal: { requestId: "requestId" in input ? input.requestId : undefined, code: "control-lost" } }); return;
            }
            const { leaseId: _leaseId, ...legacyInput } = input;
            // This is a terminal surface: the person sees any open dialog, so text is not held back.
            const request = {
              ...(state.capabilities?.inputControl ? { ...input, actor, leaseId: suppliedLease } : legacyInput),
              ...(input.op === "input" ? { force: true } : {}),
            };
            const receipt = await workerCall<Receipt>(manager.config.runDir, match[1], request);
            if (input.op !== "resize") await send({ receipt });
          }).catch(async (error: WorkerError) => {
            if (error.code === "control-busy" || error.code === "control-lost") {
              await send({ refusal: { requestId: "requestId" in input ? input.requestId : undefined, code: error.code } }).catch(() => fail(1011));
            } else fail(1011);
          }).finally(() => { pendingBytes -= size; pendingFrames--; });
        } catch { fail(1008); }
      });
    });
  });
  return () => { for (const ws of sockets.clients) ws.terminate(); };
}
