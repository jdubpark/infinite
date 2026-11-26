import { watch } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { workerCall, type WorkerError } from "./ipc.js";
import { controlActor, type PairedDevice } from "./device-control.js";
import type { Manager } from "./manager.js";
import { normalizeControlRequest, type ControlActor, type Event, type Receipt, type TerminalSize, type TerminalSnapshot, type WorkerState } from "./types.js";
import { readTerminalSizeIndex, resolveReplayTerminalSize, TERMINAL_SIZE_INDEX_FILE, terminalSizeFromEvent, terminalSizeOf } from "./terminal-size.js";

export async function* terminalPages(
  manager: Manager,
  sessionId: string,
  after: number,
  signal: AbortSignal,
  snapshot = false,
  initialState?: WorkerState,
) {
  let cursor = after, changed = true, wake: (() => void) | undefined, lastState = 0, unavailable = 0;
  let activeSize: TerminalSize | undefined;
  const sizeFields = () => (activeSize ? { cols: activeSize.cols, rows: activeSize.rows } : {});
  const observeEventSize = (event: Event) => {
    const next = terminalSizeFromEvent(event);
    if (next) activeSize = next;
  };
  const notify = () => { changed = true; wake?.(); };
  const watcher = watch(join(manager.config.stateDir, "sessions", sessionId, "events"), notify);
  watcher.on("error", notify);
  signal.addEventListener("abort", notify);
  try {
    let opened = false;
    let state = initialState;
    let snapshotSize: TerminalSize | undefined;
    if (snapshot) {
      state ??= await manager.state(sessionId);
      if (state.capabilities?.terminalSnapshot === 1) {
        try {
          const screen = await workerCall<TerminalSnapshot>(manager.socketTarget, sessionId, { op: "snapshot" });
          snapshotSize = terminalSizeOf(screen);
          if (screen.seq >= cursor) {
            cursor = screen.seq;
            activeSize = snapshotSize;
            opened = true;
            yield {
              open: { cursor, ...sizeFields() },
              snapshot: screen,
              cursor,
              ...sizeFields(),
            };
          }
        } catch {}
      }
    }
    if (!opened) {
      const sizeIndex = readTerminalSizeIndex(
        join(manager.config.stateDir, "sessions", sessionId, TERMINAL_SIZE_INDEX_FILE),
        manager.key,
        sessionId,
      );
      if (cursor > 0 && sizeIndex.intact && !state) {
        try {
          state = await manager.state(sessionId);
        } catch {}
      }
      activeSize = await resolveReplayTerminalSize(
        (from, limit, types) => manager.events(sessionId, from, limit, types),
        cursor,
        {
          fallback: state?.terminalSize ?? snapshotSize,
          index: sizeIndex,
          coveredSeq: state?.sizeIndexCoveredSeq,
          signal,
        },
      );
      if (!activeSize && !state) {
        try {
          state = await manager.state(sessionId);
          activeSize = terminalSizeOf(state.terminalSize);
        } catch {}
      }
      yield {
        open: { cursor, ...sizeFields() },
        cursor,
        ...sizeFields(),
      };
    }
    while (!signal.aborted) {
      changed = false;
      const page = manager.events(sessionId, cursor, 200, new Set(["output", "lifecycle"]));
      for (const event of page.events) {
        observeEventSize(event);
        yield { events: [event], cursor: event.seq, ...sizeFields() };
      }
      if (cursor !== page.cursor) yield { events: [], cursor: page.cursor, more: page.more, ...sizeFields() };
      cursor = page.cursor;
      if (page.more) continue;
      if (Date.now() - lastState >= 1000) {
        const { status, pid, exitCode, outputTailIncomplete, control, capabilities, runtime, nativeSession, terminalSize } = await manager.state(sessionId);
        const liveSize = terminalSizeOf(terminalSize);
        if (!activeSize && liveSize) activeSize = liveSize;
        yield { state: { status, pid, exitCode, outputTailIncomplete, control, capabilities, runtime, nativeSession, ...(liveSize ? { terminalSize: liveSize } : {}) } };
        lastState = Date.now();
        unavailable = status === "unavailable" ? unavailable + 1 : 0;
        if (status === "exited" || unavailable >= 3) {
          const final = manager.events(sessionId, cursor, 200, new Set(["output", "lifecycle"]));
          for (const event of final.events) {
            observeEventSize(event);
            yield { events: [event], cursor: event.seq, ...sizeFields() };
          }
          if (!final.events.length || cursor !== final.cursor) {
            yield { events: [], cursor: final.cursor, more: final.more, ...sizeFields() };
          }
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
export const terminalInputSchema = z.union([
  z.object({ op: z.literal("raw"), requestId: z.uuid(), text: z.string().min(1).max(8192), leaseId: z.uuid().optional() }).strict(),
  z.object({ op: z.literal("input"), requestId: z.uuid(), text: z.string().min(1).max(32000).regex(/^[^\x00-\x08\x0b-\x1f\x7f]*$/), submit: z.literal(false), leaseId: z.uuid().optional() }).strict(),
  z.object({ op: z.literal("resize"), cols: z.number().int().min(20).max(240), rows: z.number().int().min(5).max(100), leaseId: z.uuid().optional() }).strict(),
  z.object({ op: z.literal("control"), requestId: z.uuid(), action: z.literal("claim"), leaseId: z.uuid().optional(), takeover: z.boolean().optional() }).strict(),
  z.object({ op: z.literal("control"), requestId: z.uuid(), action: z.literal("renew"), leaseId: z.uuid().optional(), takeover: z.literal(false).optional() }).strict(),
  z.object({ op: z.literal("control"), requestId: z.uuid(), action: z.literal("release"), leaseId: z.uuid().optional(), takeover: z.literal(false).optional() }).strict(),
]);

type TerminalInput = z.infer<typeof terminalInputSchema>;
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_PENDING_FRAMES = 128;

export function connectTerminals(server: Server, manager: Manager, authenticate: (token: string) => PairedDevice | undefined, missionManaged?: (sessionId: string) => boolean | Promise<boolean>) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 192 * 1024, perMessageDeflate: false });
  const origin = new URL(manager.config.origin);
  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", origin); }
    catch { socket.destroy(); return; }
    const match = /^\/api\/sessions\/([a-f0-9-]{36})\/terminal$/.exec(url.pathname);
    if (url.pathname === "/api/remote" || url.pathname.endsWith("/native") || url.pathname.endsWith("/executor")) return;
    const after = Number(url.searchParams.get("after") ?? 0);
    const hosts = [origin.host, `127.0.0.1:${manager.config.port}`, `localhost:${manager.config.port}`];
    if (!match || !z.uuid().safeParse(match[1]).success || !Number.isSafeInteger(after) || after < 0 ||
        !hosts.includes(req.headers.host ?? "") || (req.headers.origin && req.headers.origin !== origin.origin) || sockets.clients.size >= 32) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      const abort = new AbortController();
      let device: PairedDevice | undefined, actor: ControlActor, legacy = true;
      let ready: Promise<WorkerState>, leaseId: string | undefined, managed = false;
      let alive = true, open = true;
      let renewInFlight: Promise<void> | undefined;
      let drainPromise: Promise<void> | undefined;
      let pendingBytes = 0;
      const queue: Array<{ input: TerminalInput; size: number }> = [];
      const discardQueue = () => { queue.length = 0; pendingBytes = 0; };
      const fail = (code: number) => {
        open = false;
        abort.abort();
        discardQueue();
        ws.close(code);
      };
      const authTimeout = setTimeout(() => fail(1008), 10000);
      const heartbeat = setInterval(() => {
        if (!alive) {
          open = false;
          abort.abort();
          discardQueue();
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 15000);
      ws.on("pong", () => {
        alive = true;
        if (!legacy || !leaseId || renewInFlight || !open || abort.signal.aborted) return;
        const held = leaseId;
        let renewal!: Promise<void>;
        renewal = (async () => {
          try {
            if (managed && (await manager.state(match[1])).attention?.state !== "needs-you") return;
            if (!open || abort.signal.aborted || leaseId !== held) return;
            await manager.controlSession(match[1], { op: "control", action: "renew", actor, leaseId: held });
          } catch {
            if (leaseId === held) leaseId = undefined;
            fail(1011);
          } finally {
            if (renewInFlight === renewal) renewInFlight = undefined;
          }
        })();
        renewInFlight = renewal;
      });
      ws.on("error", () => { open = false; abort.abort(); discardQueue(); });
      ws.on("close", () => {
        open = false;
        abort.abort();
        clearTimeout(authTimeout);
        clearInterval(heartbeat);
        discardQueue();
        void Promise.allSettled([drainPromise, renewInFlight]).then(async () => {
          if (leaseId) await manager.controlSession(match[1], { op: "control", action: "release", actor, leaseId });
        }).catch(() => {});
      });
      const active = () => open && !abort.signal.aborted && ws.readyState === WebSocket.OPEN;
      const send = (value: unknown) => new Promise<void>((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) { reject(new Error("Terminal disconnected")); return; }
        ws.send(JSON.stringify(value), error => error ? reject(error) : resolve());
      });
      const processFrame = async (input: TerminalInput) => {
        const state = await ready;
        if (!active()) return;
        const promptScopedWrite = input.op === "raw" || input.op === "input" || input.op === "control" && input.action !== "release";
        if (managed && promptScopedWrite) {
          const live = await manager.state(match[1]);
          if (!active()) return;
          if (live.attention?.state !== "needs-you") {
            await send({ refusal: {
              requestId: "requestId" in input ? input.requestId : undefined,
              code: "mission-managed",
              error: "This session is run by its mission coordinator. Talk to the coordinator from the mission.",
            } });
            return;
          }
        }
        if (input.op === "control") {
          if (!state.capabilities?.inputControl) {
            await send({ refusal: { requestId: input.requestId, code: "unsupported" } }); return;
          }
          const normalized = normalizeControlRequest(input, actor);
          if (!normalized.ok) {
            await send({ refusal: { requestId: input.requestId, code: normalized.code } }); return;
          }
          const control = await manager.controlSession(match[1], normalized.request);
          leaseId = control?.id;
          if (!active()) return;
          await send({ requestId: input.requestId, control });
          return;
        }
        if (state.capabilities?.inputControl && legacy && !leaseId && !(managed && input.op === "resize")) {
          leaseId = (await manager.controlSession(match[1], { op: "control", action: "claim", actor }))!.id;
          if (!active()) return;
        }
        const suppliedLease = legacy ? leaseId : input.leaseId;
        if (state.capabilities?.inputControl && !suppliedLease) {
          await send({ refusal: { requestId: "requestId" in input ? input.requestId : undefined, code: "control-lost" } }); return;
        }
        const { leaseId: _leaseId, ...legacyInput } = input;
        const request = {
          ...(state.capabilities?.inputControl ? { ...input, actor, leaseId: suppliedLease } : legacyInput),
          ...(input.op === "input" ? { force: true } : {}),
        };
        const receipt = await workerCall<Receipt>(manager.socketTarget, match[1], request);
        if (input.op !== "resize" && active()) await send({ receipt });
      };
      const drain = () => {
        if (drainPromise || !active()) return;
        drainPromise = (async () => {
          try {
            while (queue.length > 0 && active()) {
              const frame = queue.shift()!;
              try {
                await processFrame(frame.input);
              } catch (error) {
                if (!active()) break;
                const workerError = error as WorkerError;
                if (workerError.code === "control-busy" || workerError.code === "control-lost" || workerError.code === "resize-refused") {
                  await send({ refusal: { requestId: "requestId" in frame.input ? frame.input.requestId : undefined, code: workerError.code } }).catch(() => fail(1011));
                } else {
                  fail(1011);
                  break;
                }
              } finally {
                pendingBytes = Math.max(0, pendingBytes - frame.size);
              }
            }
          } finally {
            if (!active()) discardQueue();
            drainPromise = undefined;
            if (queue.length > 0 && active()) drain();
          }
        })();
      };
      ws.on("message", (data, binary) => {
        try {
          if (binary || !active()) { fail(1008); return; }
          const message: unknown = JSON.parse(data.toString());
          if (!device) {
            const auth = authSchema.parse(message);
            device = authenticate(auth.token);
            if (!device) { fail(1008); return; }
            actor = controlActor(device, auth.clientId ?? randomUUID());
            legacy = !auth.clientId;
            manager.meta(match[1]);
            ready = (async () => {
              managed = Boolean(await missionManaged?.(match[1]));
              return manager.state(match[1]);
            })();
            clearTimeout(authTimeout);
            void (async () => {
              try {
                const initialState = await ready;
                if (!active()) return;
                for await (const page of terminalPages(manager, match[1], after, abort.signal, url.searchParams.get("snapshot") === "1", initialState)) await send(page);
                if (!abort.signal.aborted) {
                  open = false;
                  abort.abort();
                  discardQueue();
                  ws.close(1000);
                }
              } catch { if (active()) fail(1011); }
            })();
            return;
          }
          if (device.role !== "owner") { fail(1008); return; }
          const input = terminalInputSchema.parse(message);
          const size = Buffer.byteLength(data.toString());
          if (pendingBytes + size > MAX_PENDING_BYTES || queue.length + (drainPromise ? 1 : 0) >= MAX_PENDING_FRAMES) { fail(1008); return; }
          pendingBytes += size;
          queue.push({ input, size });
          drain();
        } catch { fail(1008); }
      });
    });
  });
  return () => { for (const ws of sockets.clients) ws.terminate(); };
}
