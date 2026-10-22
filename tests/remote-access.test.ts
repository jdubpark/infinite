import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createRemoteClient, RemoteError, type RemoteClient } from "@infinite/remote";
import { MAX_REQUEST_BYTES, MAX_EVENTS_BUFFERED_BYTES, MAX_EVENTS_EVENT_BYTES } from "@infinite/remote/protocol";
import { connectRemoteAccess } from "../packages/host/src/remote-access.js";
import { createRelayServer } from "../packages/host/src/relay.js";
import { hashToken } from "../packages/host/src/config.js";
import type { Config } from "../packages/host/src/types.js";
import { inProcessHost, startHost, waitFor } from "./helpers.js";
import { httpRunner, listen, wireProxy } from "./remote-fixture.js";

test("encrypted relay creates and steers real sessions while retaining roles and device control", { timeout: 45000 }, async () => {
  const privateFiles = mkdtempSync(join(tmpdir(), "infinite-remote-"));
  const machineId = randomUUID(), registration = randomBytes(32).toString("base64url");
  const tokenFile = join(privateFiles, "registration.key");
  writeFileSync(tokenFile, registration, { mode: 0o600 });
  const relay = createRelayServer({ registrations: [{ machineId, tokenHash: hashToken(registration) }] });
  const relayUrl = await listen(relay.server), proxy = await wireProxy(relayUrl);
  const clients: RemoteClient[] = [];
  let live: { close(): void } | undefined;
  const host = await startHost({ config: { machine: { id: machineId, label: "Test machine" }, remote: { enabled: true, relay: { url: relayUrl, tokenFile } } } });
  try {
    const connect = (role: "owner" | "viewer" | "controller") => {
      const client = createRemoteClient({ url: proxy.url, token: host.tokens[role], relay: { machineId } }); clients.push(client); return client;
    };
    const owner = connect("owner"), viewer = connect("viewer"), controller = connect("controller");
    const me = await waitFor(() => owner.request<{ machine: { id: string }; role: string }>("/me").catch(() => null), value => value?.role === "owner");
    assert.equal(me!.machine.id, machineId);
    const title = "Remote private content sentinel";
    const create = { requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title, prompt: "remote rehearsal" };
    await assert.rejects(viewer.request("/sessions", { body: create }), (error: RemoteError) => error.status === 403);
    const session = await owner.request<{ id: string }>("/sessions", { body: create });
    assert.equal((await owner.request<{ id: string }>("/sessions", { body: create })).id, session.id, "the existing creation receipt still deduplicates retries");
    assert.equal((await viewer.request<{ sessions: { id: string }[] }>("/sessions")).sessions.some(item => item.id === session.id), true);
    const sessionLists: { sessions: { id: string }[] }[] = [];
    live = await owner.openEvents({ topics: ["sessions"], onEvent: event => sessionLists.push(event.data as { sessions: { id: string }[] }), onClose: () => {} });
    await waitFor(async () => sessionLists, values => values.some(value => value.sessions.some(item => item.id === session.id)));
    const pushStarted = Date.now();
    const pushed = await owner.request<{ id: string }>("/sessions", { body: { ...create, requestId: randomUUID(), title: "Pushed session" } });
    await waitFor(async () => sessionLists, values => values.some(value => value.sessions.some(item => item.id === pushed.id)), 4000);
    assert.ok(Date.now() - pushStarted < 4000, "the encrypted relay stream delivers before the four-second polling interval");
    const ownerHeaders = { "X-Infinite-Client": randomUUID() }, controllerHeaders = { "X-Infinite-Client": randomUUID() };
    const control = await owner.request<{ control: { id: string } }>(`/sessions/${session.id}/control`, { body: { action: "claim" }, headers: ownerHeaders });
    const steeringHeaders = { ...ownerHeaders, "X-Infinite-Control": control.control.id };
    await assert.rejects(controller.request(`/sessions/${session.id}/control`, { body: { action: "claim" }, headers: controllerHeaders }), (error: RemoteError) => error.status === 409 && error.code === "control-busy");
    const input = { requestId: randomUUID(), text: "private steering sentinel", submit: true };
    await owner.request(`/sessions/${session.id}/input`, { body: input, headers: steeringHeaders });
    const next = await controller.request<{ control: { id: string } }>(`/sessions/${session.id}/control`, { body: { action: "claim", takeover: true }, headers: controllerHeaders });
    assert.notEqual(next.control.id, control.control.id);
    await assert.rejects(owner.request(`/sessions/${session.id}/input`, { body: { ...input, requestId: randomUUID() }, headers: steeringHeaders }), (error: RemoteError) => error.code === "control-lost");
    for (const endpoint of ["raw", "native", "workspace-export", "opencode/config", "stream"]) {
      await assert.rejects(owner.request(`/sessions/${session.id}/${endpoint}`, { method: ["native", "opencode/config", "stream"].includes(endpoint) ? "GET" : "POST", body: ["native", "opencode/config", "stream"].includes(endpoint) ? undefined : {} }),
        (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    }
    await assert.rejects(owner.request("/sessions", { body: { ...create, requestId: randomUUID(), nativeArgs: ["--help"] } }), (error: RemoteError) => error.status === 403);
    const visibleToRelay = proxy.frames.join("\n");
    for (const plaintext of [title, input.text, host.tokens.owner, hashToken(host.tokens.owner), "/api/sessions", registration]) {
      assert.equal(visibleToRelay.includes(plaintext), false, "the relay receives neither content nor endpoint encryption secrets");
    }
    const health = await fetch(`${relayUrl}/health`);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal((await fetch(`${relayUrl}/api/sessions`)).status, 404, "the relay does not expose runner APIs");
    for (const path of ["/", "/index.html"]) assert.equal((await fetch(`${relayUrl}${path}`)).status, 404, "the relay does not publish the web client");
  } finally {
    live?.close();
    for (const client of clients) client.close();
    await host.stop(); proxy.close(); relay.close(); rmSync(privateFiles, { recursive: true, force: true });
  }
});

test("encrypted terminals carry real PTY output and receipts, enforce leases and roles, and stop on revocation", { timeout: 30000 }, async () => {
  const host = await inProcessHost();
  host.config.remote = { enabled: true };
  const closeRemote = connectRemoteAccess(host.server, host.config);
  const proxy = await wireProxy(host.origin);
  const owner = createRemoteClient({ url: proxy.url, token: host.tokens.owner });
  const viewer = createRemoteClient({ url: proxy.url, token: host.tokens.viewer });
  type Page = {
    events?: { data: { text?: string } }[];
    state?: { status: string };
    receipt?: { requestId: string; state: string };
    refusal?: { requestId: string; code: string };
    requestId?: string;
    control?: { id: string };
  };
  const pages: Page[] = [], viewerPages: Page[] = [], closed: number[] = [], viewerClosed: number[] = [];
  try {
    const session = await owner.request<{ id: string }>("/sessions", { body: {
      requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Encrypted terminal", prompt: "Terminal rehearsal",
    } });
    const clientId = randomUUID();
    const terminal = await owner.openTerminal(session.id, { clientId, snapshot: false, onMessage: page => pages.push(page as Page), onClose: event => closed.push(event.code) });
    await waitFor(async () => pages, value => value.some(page => page.events?.some(event => event.data.text?.includes("local continuity rehearsal"))));
    const refused = randomUUID();
    terminal.send({ op: "raw", requestId: refused, text: "must not arrive\r" });
    await waitFor(async () => pages.find(page => page.refusal?.requestId === refused), value => value?.refusal?.code === "control-lost");
    const claim = randomUUID();
    terminal.send({ op: "control", requestId: claim, action: "claim" });
    const control = await waitFor(async () => pages.find(page => page.requestId === claim), value => Boolean(value?.control?.id));
    const leaseId = control!.control!.id;
    const text = "encrypted terminal input sentinel", requestId = randomUUID();
    terminal.send({ op: "raw", requestId, text: text + "\r", leaseId });
    await waitFor(async () => pages.find(page => page.receipt?.requestId === requestId), value => value?.receipt?.state === "delivered");
    await waitFor(async () => pages, value => value.some(page => page.events?.some(event => event.data.text?.includes(`You: ${text}`))));
    const beforeReplay = (await owner.request<{ events: unknown[] }>(`/sessions/${session.id}/events?types=input-intent`)).events.length;
    terminal.send({ op: "raw", requestId, text: text + "\r", leaseId });
    await waitFor(async () => pages.filter(page => page.receipt?.requestId === requestId).length, value => value === 2);
    assert.equal((await owner.request<{ events: unknown[] }>(`/sessions/${session.id}/events?types=input-intent`)).events.length, beforeReplay, "the gateway retains durable input deduplication through encryption");

    const viewerTerminal = await viewer.openTerminal(session.id, { clientId: randomUUID(), snapshot: false, onMessage: page => viewerPages.push(page as Page), onClose: event => viewerClosed.push(event.code) });
    await waitFor(async () => viewerPages, value => value.some(page => page.events?.some(event => event.data.text?.includes(text))));
    viewerTerminal.send({ op: "raw", requestId: randomUUID(), text: "viewer must not type\r", leaseId });
    await waitFor(async () => viewerClosed, value => value.includes(1008));
    assert.equal((await owner.request<{ events: unknown[] }>(`/sessions/${session.id}/events?types=input-intent`)).events.length, beforeReplay, "viewer input never reaches the worker");

    const otherId = randomUUID();
    const takeover = await owner.request<{ control: { id: string } }>(`/sessions/${session.id}/control`, { headers: { "X-Infinite-Client": otherId }, body: { action: "claim", takeover: true } });
    assert.notEqual(takeover.control.id, leaseId);
    const stale = randomUUID();
    terminal.send({ op: "raw", requestId: stale, text: "stale lease must not type\r", leaseId });
    await waitFor(async () => pages.find(page => page.refusal?.requestId === stale), value => value?.refusal?.code === "control-lost");

    const attachments = await Promise.all(Array.from({ length: 3 }, () => owner.openTerminal(session.id, {
      clientId: randomUUID(), onMessage: () => {}, onClose: () => {},
    })));
    await assert.rejects(owner.openTerminal(session.id, { clientId: randomUUID(), onMessage: () => {}, onClose: () => {} }), (error: RemoteError) => error.code === "busy");
    attachments.forEach(attachment => attachment.close());
    assert.equal((await owner.request<{ status: string }>(`/sessions/${session.id}`)).status, "running", "closing a display does not stop the server process");
    const visible = proxy.frames.join("\n");
    for (const privateValue of [text, host.tokens.owner, session.id, leaseId, "terminal-open", "terminal-event"])
      assert.equal(visible.includes(privateValue), false, "stream metadata and terminal contents remain encrypted");

    host.config.tokens = host.config.tokens.filter(device => device.role !== "owner");
    await waitFor(async () => closed, value => value.length === 1, 2500);
    assert.throws(() => terminal.send({ op: "raw", requestId: randomUUID(), text: "revoked\r", leaseId }), (error: RemoteError) => error.code === "disconnected");
    assert.equal((await viewer.request<{ status: string }>(`/sessions/${session.id}`)).status, "running", "device revocation closes its subscriptions without killing work");
  } finally { owner.close(); viewer.close(); closeRemote(); proxy.close(); await host.stop(); }
});

test("remote event streams replace oversized snapshots with refetch and keep delivering", { timeout: 30000 }, async () => {
  const host = await inProcessHost();
  host.config.remote = { enabled: true };
  const closeRemote = connectRemoteAccess(host.server, host.config);
  const owner = createRemoteClient({ url: host.origin, token: host.tokens.owner });
  const streams: { close(): void }[] = [];
  try {
    await owner.request("/me");
    for (let index = 0; index < 4; index++) streams.push(await owner.openEvents({ topics: ["sessions"], onEvent: () => {}, onClose: () => {} }));
    await assert.rejects(owner.openEvents({ topics: ["sessions"], onEvent: () => {}, onClose: () => {} }), (error: RemoteError) => error.status === 429 && error.code === "busy");
    streams.splice(0).forEach(stream => stream.close());
    await new Promise(resolve => setTimeout(resolve, 100));

    const teams = host.teams as unknown as { list(): unknown };
    const originalList = teams.list;
    const manager = host.manager as unknown as { events(id: string, after: number, limit: number, types?: Set<string>): { events: unknown[]; cursor: number; more: boolean } };
    const originalEvents = manager.events;
    const session = await owner.request<{ id: string }>("/sessions", { body: {
      requestId: randomUUID(), provider: "demo", projectId: "rehearsal", title: "Live cursor", prompt: "Cursor check",
    } });
    const journalEvent = { seq: 1, type: "signal", data: { text: "x".repeat(391203) } };
    assert.equal(Buffer.byteLength(JSON.stringify(journalEvent)), 391247);
    let journalCursor = 1;
    manager.events = (_id, after) => ({
      events: (journalCursor === 1 ? [journalEvent] : [{ seq: journalCursor, type: "signal", data: { text: `event-${journalCursor}` } }]).filter(event => event.seq > after),
      cursor: journalCursor, more: false,
    });
    const oversized = [{ title: "💥".repeat(Math.ceil(MAX_EVENTS_EVENT_BYTES / 4)) }];
    teams.list = () => oversized;
    const sessionTopic = `session/${session.id}`;
    const updates: { topic: string; data: any }[] = [], freshSessionUpdates: { topic: string; data: any }[] = [];
    const stream = await owner.openEvents({ topics: ["teams", sessionTopic], onEvent: event => updates.push(event as { topic: string; data: any }), onClose: () => {} });
    await waitFor(async () => updates, values => values.some(value => value.topic === "refetch" && value.data.topic === "teams") && values.some(value => value.topic === "refetch" && value.data.topic === sessionTopic), 4000);
    assert.deepEqual(updates.find(value => value.topic === "refetch"), { topic: "refetch", data: { topic: "teams" } }, "UTF-8 serialized event size triggers a topic refetch");
    const rest = await owner.request<{ teams: unknown[] }>("/teams");
    assert.deepEqual(rest.teams, oversized, "the REST snapshot still returns the full source data");
    const journal = await owner.request<{ events: unknown[]; cursor: number }>(`/sessions/${session.id}/events?after=0`);
    assert.deepEqual(journal.events, [journalEvent], "REST retains the oversized journal event");
    const before = updates.filter(value => value.topic === "refetch" && value.data.topic === sessionTopic).length;
    teams.list = () => [{ title: "small snapshot" }];
    journalCursor = 2;
    const freshSession = await owner.openEvents({ topics: [sessionTopic], after: journal.cursor, onEvent: event => freshSessionUpdates.push(event as { topic: string; data: any }), onClose: () => {} });
    await waitFor(async () => freshSessionUpdates, values => values.some(value => value.topic === sessionTopic && value.data.events.events.some((event: { seq: number }) => event.seq === 2)), 4000);
    assert.equal(freshSessionUpdates.filter(value => value.topic === sessionTopic && value.data.events.events.some((event: { seq: number }) => event.seq === 2)).length, 1,
      "a listener starting after the oversized journal event gets the next inline sequence once");
    await waitFor(async () => updates.filter(value => value.topic === "refetch" && value.data.topic === sessionTopic).length, count => count > before, 4000);
    assert.equal(updates.some(value => value.topic === sessionTopic), false, "the older listener never advances the phone's cursor through inline updates after refetch");
    assert.equal(updates.filter(value => value.topic === "teams" || (value.topic === "refetch" && value.data.topic === "teams")).every(value => value.topic === "refetch"), true,
      "once refetch is required, later team changes on this subscription never send an inline snapshot");
    stream.close();
    freshSession.close();
    teams.list = originalList;
    manager.events = originalEvents;

    host.config.tokens = host.config.tokens.filter(device => device.role !== "owner");
    await assert.rejects(owner.openEvents({ topics: ["sessions"], onEvent: () => {}, onClose: () => {} }), (error: RemoteError) => error.code === "disconnected");
  } finally {
    for (const stream of streams) stream.close();
    owner.close(); closeRemote(); await host.stop();
  }
});

test("remote event parsing accepts coalesced frames within the outstanding event budget", { timeout: 15000 }, async () => {
  const token = randomBytes(32).toString("base64url"), machineId = randomUUID();
  const payloads = Array.from({ length: 3 }, (_, index) => JSON.stringify({ topic: "sessions", data: { value: `${index}${"x".repeat(87334)}` } }));
  const wireChunk = payloads.map(data => `event: update\ndata: ${data}\n\n`).join("");
  assert.ok(payloads.every(data => Buffer.byteLength(data) <= MAX_EVENTS_EVENT_BYTES));
  assert.ok(payloads.reduce((size, data) => size + Buffer.byteLength(data), 0) <= MAX_EVENTS_BUFFERED_BYTES);
  assert.ok(Buffer.byteLength(wireChunk) > MAX_EVENTS_BUFFERED_BYTES, "SSE framing makes the coalesced chunk larger than the pending event budget");
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.end(wireChunk);
    } else { res.writeHead(404); res.end(); }
  });
  const config = {
    origin: "http://127.0.0.1", port: 0, environment: "local", machine: { id: machineId, label: "Test runner" }, remote: { enabled: true },
    tokens: [{ id: "test-owner", label: "Test owner", role: "owner", hash: hashToken(token) }],
  } as Config;
  const closeRemote = connectRemoteAccess(server, config), url = await listen(server);
  const client = createRemoteClient({ url, token });
  const events: unknown[] = [];
  try {
    await client.openEvents({ topics: ["sessions"], onEvent: event => events.push(event), onClose: () => {} });
    await waitFor(async () => events, values => values.length === payloads.length, 3000);
    assert.equal(events.length, payloads.length);
  } finally {
    client.close(); closeRemote(); server.closeAllConnections(); server.close();
  }
});

test("mixed canceled-read support preserves request order on new and established channels", { timeout: 15000 }, async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    for (const phase of ["initial", "established"]) {
      const signal = new AbortController().signal;
      const results = await Promise.all([
        client.request<{ path: string }>("/me", { signal }),
        client.request<{ path: string }>("/sessions"),
      ]);
      assert.deepEqual(results.map(result => result.path), ["/api/me", "/api/sessions"], phase);
    }
    assert.equal(runner.requests.length, 4, "every admitted read reaches the HTTP boundary once");
  } finally { client.close(); runner.close(); }
});

test("relay tampering and replay fail closed; a lost mutation receipt is never resent", { timeout: 20000 }, async () => {
  const runner = await httpRunner(), proxy = await wireProxy(runner.url);
  const client = createRemoteClient({ url: proxy.url, token: runner.token }, { requestTimeoutMs: 5000 });
  try {
    proxy.forgeWelcome();
    await assert.rejects(client.request("/me"), (error: RemoteError) => error.code === "integrity-failed");
    assert.equal(runner.requests.length, 0, "the client verifies the machine before sending its bearer or request");
    assert.equal((await client.request<{ count: number }>("/me")).count, 1);
    const heldResponse = runner.holdNext();
    const order: string[] = [];
    const slow = client.request<{ path: string }>("/me").then(value => { order.push("slow"); return value; });
    const release = await heldResponse;
    let fast: { path: string };
    try {
      fast = await client.request<{ path: string }>("/sessions").then(value => { order.push("fast"); return value; });
    } finally { release(); }
    const replies = [await slow, fast];
    assert.deepEqual(order, ["fast", "slow"]);
    assert.deepEqual(replies.map(reply => reply.path), ["/api/me", "/api/sessions"], "concurrent replies preserve request identity and cipher sequence");
    const beforeReplay = runner.requests.length;
    await proxy.replay();
    assert.equal(runner.requests.length, beforeReplay, "a recorded ciphertext cannot execute twice");
    await waitFor(() => client.request("/me").then(() => true).catch(() => false), value => value);
    const beforeTamper = runner.requests.length;
    proxy.corrupt();
    await assert.rejects(client.request("/projects/project/context", { method: "PUT", body: { text: "must not arrive", expectedVersion: 0 } }), (error: RemoteError) => error.code === "delivery-unknown");
    assert.equal(runner.requests.length, beforeTamper, "unauthenticated ciphertext never crosses the HTTP boundary");
    await client.request("/me");
    proxy.loseResponse();
    const mutation = { text: "delivered but receipt lost", expectedVersion: 0 };
    await assert.rejects(client.request("/projects/project/context", { method: "PUT", body: mutation }), (error: RemoteError) => error.code === "delivery-unknown");
    assert.deepEqual(runner.requests.at(-1)?.body, mutation, "the interruption happened after delivery");
    const delivered = runner.requests.length;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(runner.requests.length, delivered, "disconnect does not reopen or resend an operation");
    await client.request("/me");
    assert.equal(runner.requests.filter(request => (request.body as { text?: string })?.text === mutation.text).length, 1);
    assert.equal(runner.requests.every(request => request.authorization === `Bearer ${runner.token}`), true, "ordinary paired HTTP auth remains in the forwarding path");
    const hellos = proxy.frames.map(frame => JSON.parse(frame)).filter(frame => frame.type === "hello");
    assert.equal(new Set(hellos.map(frame => frame.nonce)).size, hellos.length, "reconnections receive independent key schedules");
  } finally { client.close(); proxy.close(); runner.close(); }
});

test("remote access rejects wrong keys, revoked keys, privileged paths and excessive payloads", { timeout: 20000 }, async () => {
  const runner = await httpRunner(), clients: RemoteClient[] = [];
  const connect = (token = runner.token) => { const client = createRemoteClient({ url: runner.url, token }); clients.push(client); return client; };
  try {
    await assert.rejects(connect(randomBytes(32).toString("base64url")).request("/me"), RemoteError);
    assert.equal(runner.requests.length, 0);
    const client = connect();
    await client.request("/me");
    for (const path of ["/login", "/sessions/../me", "/sessions/%2e%2e/me", "/sessions/" + randomUUID() + "/raw", "/events?topics=sessions"]) {
      await assert.rejects(client.request(path), (error: RemoteError) => error.status === 403);
    }
    // Workspace content moves only over a direct owner connection.
    const hash = "a".repeat(64);
    for (const [method, path] of [["POST", "/projects/project/sync/begin"], ["POST", "/projects/project/sync/has"], ["PUT", `/projects/project/sync/blob/${hash}`], ["PUT", "/projects/project/sync/blobs"],
      ["GET", `/projects/project/sync/blob/${hash}`], ["POST", "/projects/project/sync/commit"], ["POST", "/projects/project/sync/export"]] as const)
      await assert.rejects(client.request(path, { method, body: method === "GET" ? undefined : {} }), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    await assert.rejects(client.request("/projects/project/context", { method: "PUT", body: { text: "x".repeat(MAX_REQUEST_BYTES) } }), (error: RemoteError) => error.status === 413);
    assert.equal(runner.requests.length, 1);
    assert.deepEqual(await client.request("/projects/project"), { count: 2, method: "GET", path: "/api/projects/project" });
    assert.deepEqual(await client.request("/projects/project/sync/apply", { body: {} }), { count: 3, method: "POST", path: "/api/projects/project/sync/apply" });
    const missionId = randomUUID(), decisionId = randomUUID();
    assert.deepEqual(await client.request("/board"), { count: 4, method: "GET", path: "/api/board" });
    assert.deepEqual(await client.request("/project-groups"), { count: 5, method: "GET", path: "/api/project-groups" });
    assert.deepEqual(await client.request("/missions", { body: {} }), { count: 6, method: "POST", path: "/api/missions" });
    assert.deepEqual(await client.request(`/missions/${missionId}`), { count: 7, method: "GET", path: `/api/missions/${missionId}` });
    assert.deepEqual(await client.request(`/missions/${missionId}/answer/${decisionId}`, { body: {} }), { count: 8, method: "POST", path: `/api/missions/${missionId}/answer/${decisionId}` });
    assert.deepEqual(await client.request("/project-groups/shop", { method: "DELETE", body: {} }), { count: 9, method: "DELETE", path: "/api/project-groups/shop" });
    // The phone dictates over this channel; transcript cleanup is a POST only.
    assert.deepEqual(await client.request("/dictation/cleanup", { body: { text: "um add retries" } }), { count: 10, method: "POST", path: "/api/dictation/cleanup" });
    // A project, by its id or by one of its checkouts' host project ids, is readable by any paired role.
    assert.deepEqual(await client.request("/project-groups/shop"), { count: 11, method: "GET", path: "/api/project-groups/shop" });
    assert.deepEqual(await client.request("/project-groups/shop/understanding"), { count: 12, method: "GET", path: "/api/project-groups/shop/understanding" });
    assert.deepEqual(await client.request("/project-groups/shop/understanding/catalog"), { count: 13, method: "GET", path: "/api/project-groups/shop/understanding/catalog" });
    assert.deepEqual(await client.request("/project-groups/shop/understanding/components/cmp_123"), { count: 14, method: "GET", path: "/api/project-groups/shop/understanding/components/cmp_123" });
    assert.deepEqual(await client.request("/project-groups/shop/understanding/catalog/plans", { body: {} }), { count: 15, method: "POST", path: "/api/project-groups/shop/understanding/catalog/plans" });
    assert.deepEqual(await client.request("/project-groups/shop/understanding/refresh", { body: {} }), { count: 16, method: "POST", path: "/api/project-groups/shop/understanding/refresh" });
    for (const [method, path] of [["DELETE", "/project-groups/shop/understanding/catalog/plans"], ["GET", "/project-groups/shop/understanding/refresh"], ["POST", "/project-groups/shop/understanding/catalog/credentials"], ["GET", "/project-groups/shop/understanding/components/cmp_123/extra"]] as const)
      await assert.rejects(client.request(path, { method, body: method === "GET" ? undefined : {} }), (error: RemoteError) => error.status === 403);
    for (const [method, path] of [["POST", `/missions/${missionId}/answer/not-a-uuid`], ["GET", `/missions/${missionId}/steer`], ["GET", "/project-groups/Shop"], ["PUT", "/project-groups/Shop"], ["GET", "/project-groups/shop/understanding/extra"], ["POST", "/project-groups/shop/understanding"], ["GET", "/dictation/cleanup"]] as const)
      await assert.rejects(client.request(path, { method, body: method === "GET" ? undefined : {} }), (error: RemoteError) => error.status === 403);
    runner.oversized();
    await assert.rejects(client.request("/me"), (error: RemoteError) => error.status === 413 && error.code === "response-too-large");
    const beforeRevoke = runner.requests.length;
    runner.config.tokens.splice(0);
    await assert.rejects(client.request("/me"), RemoteError);
    assert.equal(runner.requests.length, beforeRevoke, "revocation stops an already authenticated channel before forwarding");
    assert.throws(() => createRemoteClient({ url: "http://remote.example", token: runner.token }), /HTTPS/);
  } finally { for (const client of clients) client.close(); runner.close(); }
});

function openSocket(url: string, token?: string, headers: Record<string, string> = {}) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url.replace("http:", "ws:"), { headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    socket.once("open", () => resolve(socket));
    socket.on("error", reject);
  });
}

test("relay registration, offline routing and machine channel ownership are enforced at real sockets", { timeout: 15000 }, async () => {
  const firstId = randomUUID(), secondId = randomUUID(), firstToken = randomBytes(32).toString("base64url"), secondToken = randomBytes(32).toString("base64url");
  const relay = createRelayServer({ registrations: [{ machineId: firstId, tokenHash: hashToken(firstToken) }, { machineId: secondId, tokenHash: hashToken(secondToken) }], maxClientsPerMachine: 1 });
  const url = await listen(relay.server), live: WebSocket[] = [];
  try {
    await assert.rejects(openSocket(`${url}/relay/hosts/${firstId}`, secondToken), /403/);
    await assert.rejects(openSocket(`${url}/relay/clients/${firstId}`), /503/);
    const first = await openSocket(`${url}/relay/hosts/${firstId}`, firstToken); live.push(first);
    await assert.rejects(openSocket(`${url}/relay/hosts/${firstId}`, firstToken), /409/);
    const opened = new Promise<string>(resolve => first.once("message", data => resolve(JSON.parse(data.toString()).id)));
    const client = await openSocket(`${url}/relay/clients/${firstId}`); live.push(client);
    const channel = await opened;
    await assert.rejects(openSocket(`${url}/relay/clients/${firstId}`), /429/);
    const second = await openSocket(`${url}/relay/hosts/${secondId}`, secondToken); live.push(second);
    const secondClosed = new Promise<void>(resolve => second.once("close", () => resolve()));
    second.send(JSON.stringify({ type: "data", id: channel, data: "wrong machine" }));
    await secondClosed;
    assert.equal(client.readyState, WebSocket.OPEN, "another registered host cannot inject into this machine's channel");
    const disconnected = new Promise<void>(resolve => client.once("close", () => resolve()));
    first.terminate(); await disconnected;
    await assert.rejects(openSocket(`${url}/relay/clients/${firstId}`), /503/);
  } finally { for (const socket of live) socket.terminate(); relay.close(); }
});

test("behind a local tunnel, clients enter only through its socket and one address cannot take every slot", { timeout: 15000 }, async () => {
  const machineId = randomUUID(), token = randomBytes(32).toString("base64url");
  const registrations = [{ machineId, tokenHash: hashToken(token) }];
  const relay = createRelayServer({ registrations, maxClientsPerMachine: 8, maxClientsPerAddress: 1, proxy: { addressHeader: "CF-Connecting-IP" } });
  const direct = createRelayServer({ registrations, maxClientsPerMachine: 8 });
  const files = mkdtempSync(join(tmpdir(), "infinite-relay-")), socketPath = join(files, "proxy.sock");
  await new Promise<void>(resolve => relay.proxy!.listen(socketPath, resolve));
  const [url, directUrl] = [await listen(relay.server), await listen(direct.server)], live: WebSocket[] = [];
  try {
    live.push(await openSocket(`${url}/relay/hosts/${machineId}`, token));
    const viaTunnel = (address: string) => openSocket(`ws+unix:${socketPath}:/relay/clients/${machineId}`, undefined, { "CF-Connecting-IP": address });
    await assert.rejects(openSocket(`${url}/relay/clients/${machineId}`, undefined, { "CF-Connecting-IP": "192.0.2.30" }), /403/, "a local process cannot bypass the tunnel or choose its address");
    live.push(await viaTunnel("192.0.2.10"));
    await assert.rejects(viaTunnel("192.0.2.10"), /429/);
    live.push(await viaTunnel("192.0.2.11"), await viaTunnel("2001:db8:0:1::1"));
    await assert.rejects(viaTunnel("2001:db8:0:1:ffff::9"), /429/, "addresses in one IPv6 /64 share a limit");
    live.push(await viaTunnel("not an address"));
    await assert.rejects(viaTunnel("also not an address"), /429/, "malformed headers share one limit");
    live.push(await openSocket(`${directUrl}/relay/hosts/${machineId}`, token));
    live.push(await openSocket(`${directUrl}/relay/clients/${machineId}`), await openSocket(`${directUrl}/relay/clients/${machineId}`));
  } finally { for (const socket of live) socket.terminate(); relay.close(); direct.close(); rmSync(files, { recursive: true, force: true }); }
});

test("a configured access token is sent as relay upgrade headers", { timeout: 15000 }, async () => {
  const sockets = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise(resolve => sockets.once("listening", resolve));
  const access = { clientId: `${randomBytes(16).toString("hex")}.access`, clientSecret: randomBytes(32).toString("hex") };
  const seen = new Promise<{ id?: string; secret?: string; path?: string }>(resolve => sockets.once("connection", (_socket, req) =>
    resolve({ id: req.headers["cf-access-client-id"] as string, secret: req.headers["cf-access-client-secret"] as string, path: req.url })));
  const machineId = randomUUID();
  const client = createRemoteClient({ url: `http://127.0.0.1:${(sockets.address() as { port: number }).port}`, token: randomBytes(32).toString("base64url"), relay: { machineId }, access });
  try {
    void client.request("/me").catch(() => {});
    assert.deepEqual(await seen, { id: access.clientId, secret: access.clientSecret, path: `/relay/clients/${machineId}` });
    assert.throws(() => createRemoteClient({ url: "https://relay.example", token: randomBytes(32).toString("base64url"), relay: { machineId }, access: { clientId: "short", clientSecret: access.clientSecret } }), /access token/);
  } finally { client.close(); sockets.close(); }
});
