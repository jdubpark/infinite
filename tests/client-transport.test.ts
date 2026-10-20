import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { terminalConnection } from "../packages/host/src/client-transport.js";

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor() { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  emit(type: string, event: unknown = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open() { this.readyState = FakeSocket.OPEN; this.emit("open"); }
}

function withFakeSocket(run: () => Promise<void> | void) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
  return Promise.resolve().then(run).finally(() => {
    if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
    else delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });
}

test("an idle terminal attachment does not keep a periodic acknowledgement timer", () => withFakeSocket(() => {
  const interval = globalThis.setInterval;
  let intervals = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    intervals++;
    return interval(...args);
  }) as typeof setInterval;
  const connection = terminalConnection("https://example.invalid", "token", "session", 0, new AbortController().signal);
  try {
    assert.equal(intervals, 0);
  } finally {
    connection.close();
    globalThis.setInterval = interval;
  }
}));

test("input without an acknowledgement ends the attachment after 15 seconds; acknowledged input does not", () => withFakeSocket(async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const connection = terminalConnection("https://example.invalid", "token", "session", 0, new AbortController().signal);
  try {
    const socket = FakeSocket.last!;
    socket.open();
    const delivered = connection.input("first");
    const first = socket.sent.at(-1)!;
    socket.emit("message", { data: JSON.stringify({ receipt: { requestId: first.requestId, state: "delivered" } }) });
    await delivered;
    mock.timers.tick(20_000);

    const unacknowledged = connection.input("second");
    const outcome = unacknowledged.then(() => "delivered", (error: Error) => error.message);
    mock.timers.tick(14_999);
    assert.equal(await Promise.race([outcome, Promise.resolve("pending")]), "pending");
    mock.timers.tick(1);
    assert.equal(await outcome, "Input delivery is uncertain");
    await assert.rejects(async () => { for await (const _ of connection.pages()) { /* drain */ } }, /acknowledgement timed out/);
  } finally {
    connection.close();
    mock.timers.reset();
  }
}));
