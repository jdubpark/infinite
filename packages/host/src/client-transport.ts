import { randomUUID } from "node:crypto";
import type { ControlLease, Event, Receipt, TerminalSnapshot, WorkerState } from "./types.js";

export type TerminalPage = {
  events?: Event[]; cursor?: number; more?: boolean;
  state?: Pick<WorkerState, "status" | "exitCode" | "control" | "capabilities" | "runtime" | "nativeSession">;
  snapshot?: TerminalSnapshot; receipt?: Receipt; error?: string;
  requestId?: string; control?: ControlLease | null;
  refusal?: { requestId?: string; code: string };
};
export class TerminalAccessError extends Error {}
export class TerminalControlError extends Error {
  constructor(readonly code: string) {
    super(code === "control-busy" ? "Another device controls this session. Press Ctrl+T to take over." : "Control changed or expired. This input was not sent.");
  }
}

type ConnectionOptions = { snapshot?: boolean; control?: boolean; clientId?: string };
export function terminalConnection(origin: string, token: string, sessionId: string, after: number, signal: AbortSignal, options: ConnectionOptions = {}) {
  const url = new URL(`/api/sessions/${sessionId}/terminal?after=${after}`, origin);
  if (options.snapshot) url.searchParams.set("snapshot", "1");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  let ended = false, error: Error | undefined, wake: (() => void) | undefined, bytes = 0, pendingBytes = 0;
  let lease: ControlLease | null = null;
  const queue: { page: TerminalPage; size: number }[] = [];
  const pending = new Map<string, { at: number; size: number; resolve: () => void; reject: (error: Error) => void }>();
  const controls = new Map<string, { at: number; resolve: (lease: ControlLease | null) => void; reject: (error: Error) => void }>();
  const finish = (reason?: Error) => {
    if (ended) return;
    ended = true; error = reason;
    clearInterval(deadline);
    signal.removeEventListener("abort", abort);
    for (const item of pending.values()) item.reject(new Error("Input delivery is uncertain"));
    for (const item of controls.values()) item.reject(new Error("Control acknowledgement was not received"));
    pending.clear(); controls.clear(); pendingBytes = 0; lease = null;
    wake?.();
  };
  const fail = (reason: Error) => { finish(reason); socket.close(); };
  const abort = () => fail(new Error("Terminal disconnected"));
  const deadline = setInterval(() => {
    const first = pending.values().next().value ?? controls.values().next().value;
    if (first && Date.now() - first.at >= 15000) fail(new Error("Terminal acknowledgement timed out"));
  }, 1000);
  deadline.unref();
  socket.addEventListener("open", () => {
    if (ended) { socket.close(); return; }
    socket.send(JSON.stringify({ token, ...(options.control ? { clientId: options.clientId ?? randomUUID() } : {}) }));
  });
  socket.addEventListener("message", event => {
    if (ended) return;
    try {
      if (typeof event.data !== "string") throw new Error("Invalid terminal frame");
      const page = JSON.parse(event.data) as TerminalPage;
      if (page.receipt) {
        const item = pending.get(page.receipt.requestId);
        if (!item || page.receipt.state !== "delivered") throw new Error("Uncertain input receipt");
        pending.delete(page.receipt.requestId); pendingBytes -= item.size; item.resolve();
        return;
      }
      if (page.requestId && Object.hasOwn(page, "control")) {
        const item = controls.get(page.requestId);
        if (!item) throw new Error("Unexpected control response");
        controls.delete(page.requestId); lease = page.control ?? null; item.resolve(lease);
        return;
      }
      if (page.refusal) {
        const id = page.refusal.requestId, refusal = new TerminalControlError(page.refusal.code);
        if (page.refusal.code === "control-lost") lease = null;
        const input = id ? pending.get(id) : undefined, control = id ? controls.get(id) : undefined;
        if (input) { pending.delete(id!); pendingBytes -= input.size; input.reject(refusal); return; }
        if (control) { controls.delete(id!); control.reject(refusal); return; }
        // Resize has no receipt; deliver its refusal to the attachment loop.
      }
      const size = Buffer.byteLength(event.data);
      if (bytes + size > 8 * 1024 * 1024) throw new Error("Terminal output buffer limit reached");
      queue.push({ page, size }); bytes += size; wake?.();
    } catch { fail(new Error("Terminal stream interrupted")); }
  });
  socket.addEventListener("error", () => fail(new Error("Terminal connection failed")));
  socket.addEventListener("close", event => finish(event.code === 1000 ? undefined : event.code === 1008 ? new TerminalAccessError("Terminal access was refused. Check the paired device key and its role.") : new Error("Terminal disconnected")));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const send = (value: unknown) => {
    if (ended || socket.readyState !== WebSocket.OPEN) throw new Error("Terminal disconnected");
    socket.send(JSON.stringify(value));
  };
  const write = (op: "raw" | "input", text: string): Promise<void> => {
    const size = Buffer.byteLength(text), requestId = randomUUID();
    if (pendingBytes + size > 256 * 1024 || pending.size >= 128 || socket.bufferedAmount > 256 * 1024) return Promise.reject(new Error("Input buffer limit reached"));
    return new Promise<void>((resolve, reject) => {
      pending.set(requestId, { at: Date.now(), size, resolve, reject }); pendingBytes += size;
      try { send({ op, requestId, text, ...(op === "input" ? { submit: false } : {}), ...(lease ? { leaseId: lease.id } : {}) }); }
      catch (error) { pending.delete(requestId); pendingBytes -= size; reject(error); }
    });
  };
  return {
    get lease() { return lease; },
    control(action: "claim" | "renew" | "release", takeover = false): Promise<ControlLease | null> {
      const requestId = randomUUID();
      if (controls.size >= 4) return Promise.reject(new Error("A control request is already pending"));
      return new Promise((resolve, reject) => {
        controls.set(requestId, { at: Date.now(), resolve, reject });
        try { send({ op: "control", requestId, action, ...(lease ? { leaseId: lease.id } : {}), ...(takeover ? { takeover: true } : {}) }); }
        catch (error) { controls.delete(requestId); reject(error); }
      });
    },
    async *pages(): AsyncGenerator<TerminalPage> {
      try {
        while (!ended || queue.length) {
          const item = queue.shift();
          if (item) { bytes -= item.size; yield item.page; continue; }
          await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
        }
        if (error) throw error;
      } finally { abort(); }
    },
    raw: (text: string) => write("raw", text),
    input: (text: string) => write("input", text),
    resize(cols: number, rows: number) { send({ op: "resize", cols, rows, ...(lease ? { leaseId: lease.id } : {}) }); },
    close: abort,
  };
}
