import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LiveFeed } from "../packages/host/src/live.js";
import { MAX_EVENTS_BUFFERED_BYTES, MAX_EVENTS_EVENT_BYTES, MAX_EVENTS_STREAMS } from "../packages/remote/src/protocol.js";
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

test("unchanged refetch notifications retry failed REST loads without resending oversized data", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const feed = new LiveFeed({
    sessions: async () => ({ sessions: [{ title: "x".repeat(MAX_EVENTS_EVENT_BYTES) }] }),
    teams: () => ({}), session: async () => ({}), events: async () => ({ events: [], cursor: 0, more: false }),
  });
  const updates: unknown[] = [];
  try {
    feed.subscribe(["sessions"], 0, update => updates.push(update));
    await flush();
    assert.deepEqual(updates, [{ topic: "refetch", data: { topic: "sessions" } }]);
    now = 14999; t.mock.timers.tick(750); await flush();
    assert.equal(updates.length, 1, "unchanged refetches do not run on every feed tick");
    now = 15000; t.mock.timers.tick(750); await flush();
    assert.deepEqual(updates, Array(2).fill({ topic: "refetch", data: { topic: "sessions" } }), "a client whose first REST load failed receives another notification");
  } finally { feed.close(); t.mock.timers.reset(); }
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
      continue;
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

test("HTTP live buffer limits include the next frame and report overflow", { timeout: 10000 }, async t => {
  const host = await inProcessHost(), controller = new AbortController();
  let buffered = 0;
  host.server.prependListener("request", (req, res) => {
    if (!req.url?.startsWith("/api/events?")) return;
    Object.defineProperty(res, "writableLength", { get: () => buffered });
    const write = res.write.bind(res);
    t.mock.method(res, "write", (frame: string) => {
      const result = write(frame);
      if (frame.startsWith(": connected")) buffered = MAX_EVENTS_BUFFERED_BYTES - 50;
      return result;
    });
  });
  const deadline = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`${host.origin}/api/events?topics=sessions`, {
      headers: { Authorization: `Bearer ${host.tokens.owner}` }, signal: controller.signal,
    });
    const body = await response.text();
    assert.match(body, /event: close\ndata: \{"reason":"buffer-limit"\}/);
    assert.doesNotMatch(body, /event: update/, "the frame that would exceed the cap is never written");
  } finally { clearTimeout(deadline); controller.abort(); await host.stop(); }
});

test("HTTP live stream limits are per paired credential and recover after close", { timeout: 45000 }, async t => {
  const host = await inProcessHost();
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const login = await fetch(`${host.origin}/api/login`, { method: "POST", headers: { Origin: host.config.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token: host.tokens.owner }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    async function open(token: string) {
      const response = await fetch(`${host.origin}/api/events?topics=sessions`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 200) {
        const reader = response.body!.getReader(); readers.push(reader); await readSse(reader);
      }
      return response;
    }
    for (let i = 0; i < MAX_EVENTS_STREAMS; i++) assert.equal((await open(host.tokens.owner)).status, 200);
    assert.equal((await fetch(`${host.origin}/api/events?topics=sessions`, { headers: { Cookie: cookie } })).status, 429, "browser cookies share their paired device's quota");
    assert.equal((await open(host.tokens.owner)).status, 429);
    for (let i = 0; i < MAX_EVENTS_STREAMS; i++) assert.equal((await open(host.tokens.controller)).status, 200, "a separate paired credential has its own quota");
    await readers[0].cancel();
    await flush();
    assert.equal((await open(host.tokens.owner)).status, 200, "closing a stream releases its slot");
  } finally {
    await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
    await host.stop();
  }
});

test("HTTP live streams stop after cookie logout or paired-token revocation", { timeout: 45000 }, async t => {
  const host = await inProcessHost();
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let revision = 0;
  t.mock.method(host.teams, "list", () => [{ title: `Revision ${revision}` }] as ReturnType<typeof host.teams.list>);
  try {
    async function cookieFor(token: string) {
      const login = await fetch(`${host.origin}/api/login`, { method: "POST", headers: { Origin: host.config.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      assert.equal(login.status, 200);
      return login.headers.get("set-cookie")!.split(";")[0];
    }
    async function open(headers: Record<string, string>) {
      const response = await fetch(`${host.origin}/api/events?topics=teams`, { headers });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader(); readers.push(reader); await readSse(reader); return reader;
    }
    async function expectClosed(reader: ReadableStreamDefaultReader<Uint8Array>) {
      revision++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([reader.read().then(value => value.done), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2500); })]);
        assert.equal(result, true, "revoked stream closes before another live update is delivered");
      } finally { clearTimeout(timer); }
    }
    const cookie = await cookieFor(host.tokens.owner);
    const loggedOut = await open({ Cookie: cookie });
    assert.equal((await fetch(`${host.origin}/api/logout`, { method: "POST", headers: { Origin: host.config.origin, Cookie: cookie } })).status, 200);
    await expectClosed(loggedOut);

    const ownerReader = await open({ Authorization: `Bearer ${host.tokens.owner}` });
    host.config.tokens = host.config.tokens.filter(token => token.id !== "owner");
    await expectClosed(ownerReader);

    const controllerReader = await open({ Authorization: `Bearer ${host.tokens.controller}` });
    host.config.tokens = host.config.tokens.filter(token => token.id !== "controller");
    await expectClosed(controllerReader);

    const deviceCookie = await cookieFor(host.tokens.viewer);
    const deviceReader = await open({ Cookie: deviceCookie });
    host.config.tokens = host.config.tokens.filter(token => token.id !== "viewer");
    await expectClosed(deviceReader);
  } finally {
    await Promise.all(readers.map(reader => reader.cancel().catch(() => {})));
    await host.stop();
  }
});

test("HTTP live heartbeats recheck revoked owner and device credentials and expired cookies", { timeout: 45000 }, async t => {
  const host = await inProcessHost();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const originalNow = Date.now;
  try {
    async function stream(headers: Record<string, string>) {
      const response = await fetch(`${host.origin}/api/events?topics=teams`, { headers });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader(); await readSse(reader); return reader;
    }
    const ownerReader = await stream({ Authorization: `Bearer ${host.tokens.owner}` });
    const ownerWaiting = ownerReader.read();
    host.config.tokens = host.config.tokens.filter(token => token.id !== "owner");
    t.mock.timers.tick(15000);
    assert.equal((await ownerWaiting).done, true, "heartbeat closes a bearer stream after owner-key removal");

    async function login(token: string) {
      const response = await fetch(`${host.origin}/api/login`, { method: "POST", headers: { Origin: host.config.origin, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie")!.split(";")[0];
    }
    const deviceCookie = await login(host.tokens.viewer);
    const deviceReader = await stream({ Cookie: deviceCookie });
    const deviceWaiting = deviceReader.read();
    host.config.tokens = host.config.tokens.filter(token => token.id !== "viewer");
    t.mock.timers.tick(15000);
    assert.equal((await deviceWaiting).done, true, "heartbeat closes a cookie stream after viewer-key removal");

    const expiringCookie = await login(host.tokens.controller);
    const expiringReader = await stream({ Cookie: expiringCookie });
    const expiryWaiting = expiringReader.read();
    Date.now = () => originalNow() + 13 * 60 * 60 * 1000;
    t.mock.timers.tick(15000);
    assert.equal((await expiryWaiting).done, true, "heartbeat closes an expired browser-cookie stream");
  } finally {
    Date.now = originalNow;
    t.mock.timers.reset();
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
