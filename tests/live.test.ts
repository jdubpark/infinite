import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LiveFeed } from "../packages/host/src/live.js";
import { claimControl, inProcessHost, startHost, waitFor } from "./helpers.js";

const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve)); };

test("the live feed shares topic reads, emits only changed snapshots, and stops when empty", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let sessionsRead = 0, value = 1;
  const source = {
    sessions: async () => { sessionsRead++; return { sessions: [value] }; },
    teams: () => ({ teams: [] }),
    session: async () => ({}),
    events: async () => ({ events: [], cursor: 0, more: false }),
  };
  const feed = new LiveFeed(source, 750), first: unknown[] = [], second: unknown[] = [];
  const stopFirst = feed.subscribe(["sessions"], 0, update => first.push(update.data));
  const stopSecond = feed.subscribe(["sessions"], 0, update => second.push(update.data));
  await flush();
  assert.deepEqual(first, [{ sessions: [1] }]);
  assert.deepEqual(second, [{ sessions: [1] }]);
  assert.equal(sessionsRead, 1, "one initial tick reads the shared topic once for every subscriber");
  t.mock.timers.tick(750);
  await flush();
  assert.equal(first.length, 1, "unchanged snapshots are suppressed");
  value = 2;
  t.mock.timers.tick(750);
  await flush();
  assert.deepEqual(first.at(-1), { sessions: [2] });
  assert.deepEqual(second.at(-1), { sessions: [2] });
  stopFirst(); stopSecond();
  assert.equal(feed.running, false);
  assert.equal(feed.subscriberCount, 0);
  t.mock.timers.reset();
});

const buffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, string>();
async function readSse(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = buffers.get(reader) ?? "";
  for (;;) {
    const boundary = text.indexOf("\n\n");
    if (boundary >= 0) {
      const frame = text.slice(0, boundary), rest = text.slice(boundary + 2);
      if (frame.startsWith("event: update")) { buffers.set(reader, rest); return { update: JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)), rest }; }
      text = rest;
    }
    const next = await reader.read();
    if (next.done) throw new Error("SSE stream closed before an update");
    text += new TextDecoder().decode(next.value);
  }
}

test("HTTP live events require authentication, send heartbeats, and resume session cursors", { timeout: 45000 }, async t => {
  const host = await inProcessHost();
  let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const denied = await fetch(`${host.origin}/api/events?topics=sessions`);
    assert.equal(denied.status, 401);
    const response = await fetch(`${host.origin}/api/events?topics=sessions`, { headers: { Authorization: `Bearer ${host.tokens.owner}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    stream = response.body!.getReader();
    const initial = await readSse(stream);
    assert.ok(Array.isArray(initial.update.data.sessions));
    await stream.cancel();

    const created = await host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Live cursor", prompt: "cursor test" });
    const id = created.body.id as string;
    const before = await host.fetchApi(`/sessions/${id}/events?limit=200`);
    const after = before.body.cursor as number;
    const liveResponse = await fetch(`${host.origin}/api/events?topics=session%2F${id}&after=${after}`, { headers: { Authorization: `Bearer ${host.tokens.owner}` } });
    const reader = liveResponse.body!.getReader();
    const control = await claimControl(host, id, "owner");
    await host.fetchApi(`/sessions/${id}/input`, "owner", { requestId: randomUUID(), text: "cursor wakeup", submit: true }, control.headers);
    const first = await waitFor(async () => readSse(reader), event => (event.update.data.events.events as { seq: number }[]).some(item => item.seq > after), 3000);
    const events = first.update.data.events.events as { seq: number }[];
    assert.ok(events.every(event => event.seq > after));
    const cursor = first.update.data.events.cursor as number;
    await reader.cancel();

    const resumed = await fetch(`${host.origin}/api/events?topics=session%2F${id}&after=${cursor}`, { headers: { Authorization: `Bearer ${host.tokens.owner}` } });
    const resumedReader = resumed.body!.getReader();
    const replay = await readSse(resumedReader);
    assert.equal(replay.update.data.events.events.length, 0, "the received cursor resumes without replaying an event");
    await resumedReader.cancel();

    t.mock.timers.enable({ apis: ["setInterval"] });
    const heartbeatResponse = await fetch(`${host.origin}/api/events?topics=teams`, { headers: { Authorization: `Bearer ${host.tokens.owner}` } });
    const heartbeatReader = heartbeatResponse.body!.getReader();
    await readSse(heartbeatReader);
    const waiting = heartbeatReader.read();
    t.mock.timers.tick(15000);
    const heartbeat = await waiting;
    assert.match(new TextDecoder().decode(heartbeat.value), /: heartbeat/);
    t.mock.timers.reset();
    await heartbeatReader.cancel();
  } finally {
    t.mock.timers.reset();
    stream?.cancel().catch(() => {});
    await host.stop();
  }
});

test("a session list change arrives from the host feed without waiting for the old poll interval", { timeout: 45000 }, async () => {
  const host = await startHost();
  try {
    const response = await fetch(`${host.origin}/api/events?topics=sessions`, { headers: { Authorization: `Bearer ${host.tokens.owner}` } });
    const reader = response.body!.getReader();
    await readSse(reader);
    const started = Date.now();
    const created = await host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Push proof", prompt: "state change" });
    const received = await waitFor(async () => readSse(reader), event => (event.update.data.sessions as { id: string }[]).some(session => session.id === created.body.id), 2000);
    assert.ok(Date.now() - started < 2000, "the push arrives before the four-second polling interval");
    assert.ok(received.update.data.sessions.some((session: { id: string }) => session.id === created.body.id));
    await reader.cancel();
  } finally { await host.stop(); }
});
