import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createRemoteClient, RemoteError, type RemoteClient } from "@infinite/remote";
import { MAX_REQUEST_BYTES, MAX_EVENTS_BUFFERED_BYTES, MAX_EVENTS_EVENT_BYTES } from "@infinite/remote/protocol";
import { connectRemoteAccess } from "../packages/host/src/remote-access.js";
import { createRelayServer } from "../packages/host/src/relay.js";
import { hashToken } from "../packages/host/src/config.js";
import { createGoalSchema, type ProductGoal } from "../packages/host/src/goal-types.js";
import type { Config } from "../packages/host/src/types.js";
import { writeSealed } from "../packages/host/src/vault.js";
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
    for (const action of ["renew", "release"] as const)
      await assert.rejects(owner.request(`/sessions/${session.id}/control`, { body: { action }, headers: ownerHeaders }), (error: RemoteError) => error.status === 409 && error.code === "control-lost");
    const renewedHttp = await owner.request<{ control: { id: string } }>(`/sessions/${session.id}/control`, { body: { action: "renew", leaseId: control.control.id, takeover: false }, headers: ownerHeaders });
    assert.equal(renewedHttp.control.id, control.control.id);
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
    for (const action of ["renew", "release"] as const) {
      const missingLease = randomUUID();
      terminal.send({ op: "control", requestId: missingLease, action });
      await waitFor(async () => pages.find(page => page.refusal?.requestId === missingLease), value => value?.refusal?.code === "control-lost");
    }
    assert.deepEqual(closed, []);
    const claim = randomUUID();
    terminal.send({ op: "control", requestId: claim, action: "claim" });
    const control = await waitFor(async () => pages.find(page => page.requestId === claim), value => Boolean(value?.control?.id));
    const leaseId = control!.control!.id;
    const legacyRenew = randomUUID();
    terminal.send({ op: "control", requestId: legacyRenew, action: "renew", leaseId, takeover: false });
    await waitFor(async () => pages.find(page => page.requestId === legacyRenew), value => value?.control?.id === leaseId);
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
    const hash = "a".repeat(64);
    for (const [method, path] of [["POST", "/projects/project/sync/begin"], ["POST", "/projects/project/sync/has"], ["PUT", `/projects/project/sync/blob/${hash}`], ["PUT", "/projects/project/sync/blobs"],
      ["GET", `/projects/project/sync/blob/${hash}`], ["POST", "/projects/project/sync/commit"], ["POST", "/projects/project/sync/export"], ["POST", "/outcomes/signals"],
      ["GET", `/outcomes/rollup?goal=${randomUUID()}`], ["POST", "/outcomes/legacy"], ["GET", "/projects/project/main-check"]] as const)
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
    assert.deepEqual(await client.request("/dictation/cleanup", { body: { text: "um add retries" } }), { count: 10, method: "POST", path: "/api/dictation/cleanup" });
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
    const contextTeam = randomUUID(), contextSession = randomUUID();
    assert.deepEqual(await client.request("/projects/project/graph/map"), { count: 17, method: "GET", path: "/api/projects/project/graph/map" });
    assert.deepEqual(await client.request(`/teams/${contextTeam}/context`), { count: 18, method: "GET", path: `/api/teams/${contextTeam}/context` });
    assert.deepEqual(await client.request(`/sessions/${contextSession}/context`), { count: 19, method: "GET", path: `/api/sessions/${contextSession}/context` });
    for (const [method, path] of [["POST", "/projects/project/graph/map"], ["GET", "/projects/project/graph"], ["POST", `/teams/${contextTeam}/context`], ["GET", "/teams/not-a-uuid/context"], ["POST", `/sessions/${contextSession}/context`]] as const)
      await assert.rejects(client.request(path, { method, body: method === "GET" ? undefined : {} }), (error: RemoteError) => error.status === 403);
    assert.deepEqual(await client.request(`/missions/${missionId}/extend`, { body: {} }), { count: 20, method: "POST", path: `/api/missions/${missionId}/extend` });
    await assert.rejects(client.request(`/missions/${missionId}/extend`, { method: "GET" }), (error: RemoteError) => error.status === 403);
    assert.deepEqual(await client.request("/halt"), { count: 21, method: "GET", path: "/api/halt" });
    for (const [method, path] of [["POST", "/halt"], ["POST", "/halt/release"], ["GET", "/halt/release"]] as const)
      await assert.rejects(client.request(path, { method, body: method === "GET" ? undefined : {} }), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.deepEqual(await client.request("/decision-queue"), { count: 22, method: "GET", path: "/api/decision-queue" });
    await assert.rejects(client.request("/decision-queue", { method: "POST", body: {} }), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
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

test("the relay refuses signal writes", { timeout: 20000 }, async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    await assert.rejects(client.request("/outcomes/signals", { method: "POST", body: {} }), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.equal(runner.requests.length, 1, "a refused signal write does not reach the host");
  } finally { client.close(); runner.close(); }
});

test("the relay refuses entry withdrawals", { timeout: 20000 }, async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    await assert.rejects(client.request(`/teams/${randomUUID()}/entries/${randomUUID()}/withdraw`, { method: "POST", body: { requestId: randomUUID() } }),
      (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.equal(runner.requests.length, 1, "a refused withdrawal does not reach the host");
  } finally { client.close(); runner.close(); }
});

test("the relay refuses roll-ups and imports", { timeout: 20000 }, async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    for (const path of [`/outcomes/rollup?goal=${randomUUID()}`, `/outcomes/rollup?mission=${randomUUID()}`])
      await assert.rejects(client.request(path), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    await assert.rejects(client.request("/outcomes/legacy", { method: "POST", body: { dryRun: true, lines: [] } }), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.equal(runner.requests.length, 1, "a refused roll-up or import does not reach the host");
  } finally { client.close(); runner.close(); }
});

test("the relay carries the permission decision log and a mark, and refuses the owner's delegation acts", { timeout: 20000 }, async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    await client.request("/permissions/log?rejected=1&limit=50");
    await client.request("/permissions/candidates");
    await client.request("/permissions/decisions/pd-0123456789abcdef0123456789abcdef");
    await client.request("/permissions/marks", { method: "POST", body: { requestId: randomUUID(), decisionId: "pd-0123456789abcdef0123456789abcdef", label: "wrong", note: "Should have asked." } });
    assert.equal(runner.requests.length, 5, "the phone's review reads and its mark reach the host");
    for (const [method, path] of [["POST", "/permissions/delegations"], ["POST", "/permissions/revocations"], ["POST", "/permissions/reopenings"],
      ["POST", "/permissions/unlocks"], ["GET", "/permissions/status"], ["GET", "/permissions/decisions/pd-1/../../me"], ["POST", "/permissions/log"]] as const)
      await assert.rejects(client.request(path, { method, body: method === "GET" ? undefined : {} }), (error: RemoteError) => error.status === 403);
    assert.equal(runner.requests.length, 5, "an act that changes what the permission agent may decide never passes the relay");
  } finally { client.close(); runner.close(); }
});

test("the relay refuses objective records", async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    for (const path of [`/goals/${randomUUID()}/record`, `/goals/${randomUUID()}/record?version=1`, `/teams/${randomUUID()}/record`])
      await assert.rejects(client.request(path), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.equal(runner.requests.length, 1, "a refused record read does not reach the host");
  } finally { client.close(); runner.close(); }
});

test("the relay refuses the verdicts read", async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    await assert.rejects(client.request(`/goals/${randomUUID()}/verdicts`), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.equal(runner.requests.length, 1, "a refused verdicts read does not reach the host");
  } finally { client.close(); runner.close(); }
});

test("the relay carries the reported-numbers curve read and nothing beside it", async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  const id = randomUUID();
  const denied = (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied";
  try {
    await client.request("/me");
    assert.deepEqual(await client.request(`/goals/${id}/metrics`), { count: 2, method: "GET", path: `/api/goals/${id}/metrics` });
    for (const method of ["POST", "PUT", "DELETE"] as const)
      await assert.rejects(client.request(`/goals/${id}/metrics`, { method, body: {} }), denied);
    await assert.rejects(client.request(`/goals/${id}/metrics/extra`), denied);
    await assert.rejects(client.request(`/goals/not-a-uuid/metrics`), denied);
    await assert.rejects(client.request(`/goals/${id}/verdicts`), denied);
    assert.equal(runner.requests.length, 2, "only the one allowed curve read reached the host");
  } finally { client.close(); runner.close(); }
});

test("the relay refuses routing reads", async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    for (const path of [`/routing/projects/rehearsal`, `/teams/${randomUUID()}/routing/task-1`])
      await assert.rejects(client.request(path), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.equal(runner.requests.length, 1, "a refused routing read does not reach the host");
  } finally { client.close(); runner.close(); }
});

test("the relay refuses routing writes", async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    for (const [method, path] of [["POST", `/routing/projects/rehearsal/explore/pause`], ["POST", `/routing/projects/rehearsal/explore/resume`], ["POST", `/teams/${randomUUID()}/routing/revoke`]] as const)
      await assert.rejects(client.request(path, { method, body: {} }), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.equal(runner.requests.length, 1, "a refused routing write does not reach the host");
  } finally { client.close(); runner.close(); }
});

test("the relay refuses corrections", async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    await assert.rejects(client.request(`/goals/${randomUUID()}/record`, { method: "POST", body: {} }), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    assert.equal(runner.requests.length, 1, "a refused correction does not reach the host");
  } finally { client.close(); runner.close(); }
});

test("remote router round-trips valid percent-encoded path segments to Express and rejects traversal, separator, control, malformed, and double-encoded segments", { timeout: 30000 }, async () => {
  const encodedAccounts = [
    { id: "team alpha", encoded: "team%20alpha", planUsd: 11.25 },
    { id: "claude+work", encoded: "claude%2Bwork", planUsd: 22.5 },
    { id: "alice@example.com", encoded: "alice%40example.com", planUsd: 33.75 },
    { id: "café", encoded: "caf%C3%A9", planUsd: 44 },
    { id: "100%", encoded: "100%25", planUsd: 55 },
    { id: "a%b", encoded: "a%25b", planUsd: 66 },
    { id: "a".repeat(201), encoded: "a".repeat(201), planUsd: 77 },
  ];
  const host = await inProcessHost({
    configure: config => {
      config.remote = { enabled: true };
      config.usage = {
        prices: {},
        budgets: {},
        accounts: Object.fromEntries(encodedAccounts.map(account => [account.id, { kind: "subscription" as const, match: [], planUsd: 10 }])),
      };
    },
  });
  const owner = createRemoteClient({ url: host.origin, token: host.tokens.owner });
  const runner = await httpRunner();
  const runnerClient = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    for (const account of encodedAccounts) {
      const reply = await owner.request<{ accounts: { id: string; planUsd?: number; planSource?: string }[] }>(
        `/usage/accounts/${account.encoded}/plan`,
        { method: "PUT", body: { planUsd: account.planUsd } },
      );
      const updated = reply.accounts.find(item => item.id === account.id);
      assert.equal(updated?.planUsd, account.planUsd, `Express decoded ${account.encoded} once to ${account.id}`);
      assert.equal(updated?.planSource, "owner");
    }

    assert.deepEqual(
      await runnerClient.request("/permissions/decisions/pd%3A123"),
      { count: 1, method: "GET", path: "/api/permissions/decisions/pd%3A123" },
    );
    assert.deepEqual(
      await runnerClient.request("/project-groups/shop/understanding/behaviors/account%3Aflow.v2"),
      { count: 2, method: "GET", path: "/api/project-groups/shop/understanding/behaviors/account%3Aflow.v2" },
    );
    assert.deepEqual(
      await runnerClient.request("/usage/projects/my-project?tz=America%2FNew_York"),
      { count: 3, method: "GET", path: "/api/usage/projects/my-project?tz=America%2FNew_York" },
    );

    const beforeRejections = runner.requests.length;
    const rejected: readonly [method: "GET" | "PUT", path: string][] = [
      ["PUT", "/usage/accounts/%2e%2e/plan"],
      ["PUT", "/usage/accounts/%2E%2E/plan"],
      ["PUT", "/usage/accounts/.%2e/plan"],
      ["PUT", "/usage/accounts/%2e./plan"],
      ["PUT", "/usage/accounts/../plan"],
      ["PUT", "/usage/accounts/%2e/plan"],
      ["PUT", "/usage/accounts/%2E/plan"],
      ["PUT", "/usage/accounts/./plan"],
      ["PUT", "/usage/accounts/a%2fb/plan"],
      ["PUT", "/usage/accounts/a%2Fb/plan"],
      ["PUT", "/usage/accounts/a%5cb/plan"],
      ["PUT", "/usage/accounts/a%5Cb/plan"],
      ["PUT", "/usage/accounts/a%00b/plan"],
      ["PUT", "/usage/accounts/a%0ab/plan"],
      ["PUT", "/usage/accounts/a%0db/plan"],
      ["PUT", "/usage/accounts/a%1fb/plan"],
      ["PUT", "/usage/accounts/a%7fb/plan"],
      ["PUT", "/usage/accounts/a%ZZb/plan"],
      ["PUT", "/usage/accounts/a%2/plan"],
      ["PUT", "/usage/accounts/a%/plan"],
      ["PUT", "/usage/accounts/%C0%AF/plan"],
      ["PUT", "/usage/accounts/%FF/plan"],
      ["PUT", "/usage/accounts/%252e%252e/plan"],
      ["PUT", "/usage/accounts/%252e/plan"],
      ["PUT", "/usage/accounts/%252f/plan"],
      ["PUT", "/usage/accounts/%255c/plan"],
      ["PUT", "/usage/accounts/%2500/plan"],
      ["PUT", "/usage/accounts/%25252e%25252e/plan"],
      ["PUT", "/usage/accounts/a%2520b/plan"],
      ["PUT", "/usage/accounts//plan"],
      ["PUT", `/usage/accounts/${"a".repeat(8200)}/plan`],
      ["PUT", "/usage/%61ccounts/claude/plan"],
      ["PUT", "/usage/accounts/claude/%70lan"],
      ["GET", "/%6de"],
      ["GET", "/sessions/%2e%2e/me"],
      ["GET", "/sessions/%252e%252e/me"],
      ["GET", "/permissions/decisions/pd%2f1"],
      ["GET", "/usage/projects/a%2Fb?tz=UTC"],
    ];
    for (const [method, path] of rejected) {
      await assert.rejects(
        runnerClient.request(path, { method, body: method === "PUT" ? { planUsd: 1 } : undefined }),
        (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied",
        `${method} ${path} must be denied`,
      );
    }
    assert.equal(runner.requests.length, beforeRejections, "rejected encoded paths never reach the upstream HTTP server");
  } finally {
    owner.close();
    runnerClient.close();
    runner.close();
    await host.stop();
  }
});

test("the relay carries mission progress and team entry reads and denies mutations or unrelated subpaths", { timeout: 20000 }, async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  const missionId = randomUUID();
  const teamId = randomUUID();
  const entryId = randomUUID();
  const v8EntryId = "12345678-1234-8123-8123-123456789abc";
  const cursor = `mp1.${randomUUID()}.${missionId}.${randomUUID()}.4`;
  try {
    assert.deepEqual(
      await client.request(`/missions/${missionId}/progress`),
      { count: 1, method: "GET", path: `/api/missions/${missionId}/progress` },
    );
    assert.deepEqual(
      await client.request(`/missions/${missionId}/progress?cursor=${encodeURIComponent(cursor)}`),
      { count: 2, method: "GET", path: `/api/missions/${missionId}/progress?cursor=${encodeURIComponent(cursor)}` },
    );
    assert.deepEqual(
      await client.request(`/teams/${teamId}/entries`),
      { count: 3, method: "GET", path: `/api/teams/${teamId}/entries` },
    );
    assert.deepEqual(
      await client.request(`/teams/${teamId}/entries?kind=check&since=10`),
      { count: 4, method: "GET", path: `/api/teams/${teamId}/entries?kind=check&since=10` },
    );
    assert.deepEqual(
      await client.request(`/teams/${teamId}/entries/${entryId}`),
      { count: 5, method: "GET", path: `/api/teams/${teamId}/entries/${entryId}` },
    );
    assert.deepEqual(
      await client.request(`/teams/${teamId}/entries/${v8EntryId}`),
      { count: 6, method: "GET", path: `/api/teams/${teamId}/entries/${v8EntryId}` },
    );

    const denied: readonly [method: "GET" | "POST" | "PUT" | "DELETE", path: string][] = [
      ["POST", `/missions/${missionId}/progress`],
      ["GET", `/missions/${missionId}/progress/extra`],
      ["GET", "/missions/not-a-uuid/progress"],
      ["GET", `/missions/${missionId}/%70rogress`],
      ["POST", `/teams/${teamId}/entries`],
      ["PUT", `/teams/${teamId}/entries/${entryId}`],
      ["POST", `/teams/${teamId}/entries/${entryId}`],
      ["DELETE", `/teams/${teamId}/entries/${entryId}`],
      ["GET", `/teams/${teamId}/entries/not-a-uuid`],
      ["GET", `/teams/${teamId}/entries/${entryId}/withdraw`],
      ["POST", `/teams/${teamId}/entries/${entryId}/withdraw`],
      ["GET", `/teams/${teamId}/entries/${entryId}/extra`],
      ["GET", "/teams/not-a-uuid/entries"],
      ["GET", `/teams/${teamId}/%65ntries`],
    ];
    for (const [method, path] of denied) {
      await assert.rejects(
        client.request(path, { method, body: method === "GET" ? undefined : {} }),
        (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied",
        `${method} ${path} must be denied`,
      );
    }
    assert.equal(runner.requests.length, 6, "denied inspector mutations and subpaths never reach the host");
  } finally {
    client.close();
    runner.close();
  }
});

test("the relay carries understanding work brief reads and refreshes, enforces roles, and denies invalid work paths", { timeout: 30000 }, async () => {
  const goalId = randomUUID();
  const workId = `goal:${goalId}`;
  const encodedWorkId = encodeURIComponent(workId);
  const host = await inProcessHost({
    configure: config => {
      config.remote = { enabled: true };
      const request = createGoalSchema.parse({
        requestId: goalId,
        projectId: "rehearsal",
        title: "Remote work brief goal",
        objective: "Verify remote work brief access",
        successCriteria: "Work brief opens over remote channel",
      });
      const { requestId: id, ...input } = request;
      const at = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
      const strong = { id: "fixture-strong", label: "Fixture reviewer", provider: "codex" as const, model: "fixture", tier: "strong" as const };
      const goal: ProductGoal = {
        ...input, id, revision: 1, status: "cancelled", createdAt: at, updatedAt: at, deadlineAt: at,
        lineup: { coordinator: strong, integrator: strong, reviewer: strong, implementers: [], escalations: [] },
        cycles: [], memberCount: 0, steering: [], events: [], outcomes: [],
      };
      mkdirSync(join(config.stateDir, "goals"), { recursive: true });
      writeSealed(join(config.stateDir, "goals", `${id}.sealed`), readFileSync(config.keyFile), `goal:${id}`, { goal, fingerprint: "fixture", receipts: {} });
    },
  });
  const owner = createRemoteClient({ url: host.origin, token: host.tokens.owner });
  const controller = createRemoteClient({ url: host.origin, token: host.tokens.controller });
  const viewer = createRemoteClient({ url: host.origin, token: host.tokens.viewer });
  let runner: Awaited<ReturnType<typeof httpRunner>> | undefined;
  let runnerClient: RemoteClient | undefined;
  try {
    runner = await httpRunner();
    runnerClient = createRemoteClient({ url: runner.url, token: runner.token });
    const listed = await owner.request<{ groups: { id: string; repos: { checkouts: { projectId: string }[] }[] }[] }>("/project-groups");
    const workspace = listed.groups.find(group => group.repos.some(repo => repo.checkouts.some(checkout => checkout.projectId === "rehearsal")));
    assert.ok(workspace, "rehearsal checkout has a canonical workspace");
    const workPath = `/project-groups/${encodeURIComponent(workspace.id)}/understanding/work/${encodedWorkId}`;

    for (const reader of [owner, controller, viewer]) {
      const brief = await reader.request<{ schemaVersion: number; workId: string; narrative: { state: string } }>(workPath);
      assert.equal(brief.schemaVersion, 1);
      assert.equal(brief.workId, workId);
      assert.equal(brief.narrative.state, "unavailable");
    }

    for (const writer of [owner, controller]) {
      const refreshed = await writer.request<{ narrative: { state: string } }>(`${workPath}/refresh`, { method: "POST", body: {} });
      assert.equal(refreshed.narrative.state, "unavailable");
    }

    await assert.rejects(
      viewer.request(`${workPath}/refresh`, { method: "POST", body: {} }),
      (error: RemoteError) => error.status === 403 && error.code !== "remote-endpoint-denied",
      "viewer refresh reaches Express role enforcement instead of the remote allowlist",
    );

    await assert.rejects(
      viewer.request(`/project-groups/${encodeURIComponent(workspace.id)}/understanding/work/${encodeURIComponent(`team:${randomUUID()}`)}`),
      (error: RemoteError) => error.status === 404 && error.code === "understanding-work",
      "missing work briefs return 404 understanding-work through remote transport",
    );

    const teamId = randomUUID();
    const missionId = randomUUID();
    const allowed: readonly [method: "GET" | "POST", path: string][] = [
      ["GET", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}`],
      ["GET", `/project-groups/shop/understanding/work/${encodeURIComponent(`mission:${missionId}`)}`],
      ["GET", `/project-groups/shop/understanding/work/${encodeURIComponent(`goal:${goalId}`)}`],
      ["GET", `/project-groups/shop/understanding/work/team:${teamId}`],
      ["POST", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}/refresh`],
      ["POST", `/project-groups/shop/understanding/work/${encodeURIComponent(`mission:${missionId}`)}/refresh`],
      ["POST", `/project-groups/shop/understanding/work/${encodeURIComponent(`goal:${goalId}`)}/refresh`],
    ];
    for (let index = 0; index < allowed.length; index++) {
      const [method, path] = allowed[index]!;
      assert.deepEqual(
        await runnerClient.request(path, { method, body: method === "POST" ? {} : undefined }),
        { count: index + 1, method, path: `/api${path}` },
      );
    }

    const denied: readonly [method: "GET" | "POST" | "PUT" | "DELETE", path: string][] = [
      ["POST", "/project-groups/shop/understanding/work"],
      ["POST", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}`],
      ["PUT", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}`],
      ["DELETE", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}`],
      ["GET", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}/refresh`],
      ["PUT", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}/refresh`],
      ["DELETE", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}/refresh`],
      ["GET", `/project-groups/shop/understanding/work/${encodeURIComponent(`session:${teamId}`)}`],
      ["GET", "/project-groups/shop/understanding/work/goal%3Anot-a-uuid"],
      ["GET", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId.toUpperCase()}`)}`],
      ["GET", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}/extra`],
      ["POST", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}/extra`],
      ["POST", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}/refresh/extra`],
      ["GET", `/project-groups/shop/understanding/%77ork/${encodeURIComponent(`team:${teamId}`)}`],
      ["POST", `/project-groups/shop/understanding/work/${encodeURIComponent(`team:${teamId}`)}/%72efresh`],
      ["GET", `/project-groups/shop/understanding/work/team%253A${teamId}`],
    ];
    for (const [method, path] of denied) {
      await assert.rejects(
        runnerClient.request(path, { method, body: method === "GET" ? undefined : {} }),
        (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied",
        `${method} ${path} must be denied`,
      );
    }
    assert.equal(runner.requests.length, allowed.length, "denied work brief requests never reach the host");
  } finally {
    owner.close();
    controller.close();
    viewer.close();
    runnerClient?.close();
    runner?.close();
    await host.stop();
  }
});

test("remote access allows GET /api/usage/interrupted-tasks and rejects mutations", async () => {
  const runner = await httpRunner();
  const client = createRemoteClient({ url: runner.url, token: runner.token });
  try {
    await client.request("/me");
    assert.deepEqual(
      await client.request("/usage/interrupted-tasks?project=shop&days=14"),
      { count: 2, method: "GET", path: "/api/usage/interrupted-tasks?project=shop&days=14" },
    );
    await assert.rejects(
      client.request("/usage/interrupted-tasks", { method: "POST", body: {} }),
      (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied",
    );
    assert.equal(runner.requests.length, 2);
  } finally {
    client.close();
    runner.close();
  }
});
