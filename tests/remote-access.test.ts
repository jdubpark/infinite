import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createRemoteClient, RemoteError, type RemoteClient } from "@infinite/remote";
import { MAX_FRAME_BYTES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from "@infinite/remote/protocol";
import { connectRemoteAccess } from "../packages/host/src/remote-access.js";
import { createRelayServer } from "../packages/host/src/relay.js";
import { hashToken } from "../packages/host/src/config.js";
import type { Config } from "../packages/host/src/types.js";
import { inProcessHost, startHost, waitFor } from "./helpers.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Real wire interception models an untrusted relay, without access to endpoint keys. */
async function wireProxy(origin: string) {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 1024 });
  const live = new Set<WebSocket>();
  const frames: string[] = [];
  let corruptNext = false, corruptWelcome = false, dropResponse = false;
  let lastRequest = "", lastUpstream: WebSocket | undefined;
  server.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head, downstream => {
    const upstream = new WebSocket(origin.replace("http:", "ws:") + req.url);
    lastUpstream = upstream; live.add(upstream); live.add(downstream);
    const queue: string[] = [];
    upstream.on("open", () => { for (const text of queue) upstream.send(text); queue.length = 0; });
    downstream.on("message", data => {
      let text = data.toString(); frames.push(text);
      const frame = JSON.parse(text);
      if (frame.type === "ciphertext") {
        lastRequest = text;
        if (corruptNext) {
          corruptNext = false;
          frame.data = (frame.data[0] === "0" ? "1" : "0") + frame.data.slice(1);
          text = JSON.stringify(frame);
        }
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else queue.push(text);
    });
    upstream.on("message", data => {
      let text = data.toString(); frames.push(text);
      const frame = JSON.parse(text);
      if (corruptWelcome && frame.type === "welcome") {
        corruptWelcome = false;
        frame.proof = (frame.proof[0] === "0" ? "1" : "0") + frame.proof.slice(1);
        text = JSON.stringify(frame);
      }
      if (dropResponse && JSON.parse(text).type === "ciphertext") {
        dropResponse = false; downstream.terminate(); upstream.terminate(); return;
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(text);
    });
    const close = () => { live.delete(upstream); live.delete(downstream); upstream.terminate(); downstream.terminate(); };
    upstream.on("error", close); upstream.on("close", close);
    downstream.on("error", close); downstream.on("close", close);
  }));
  return {
    url: await listen(server), frames,
    corrupt: () => { corruptNext = true; },
    forgeWelcome: () => { corruptWelcome = true; },
    loseResponse: () => { dropResponse = true; },
    replay: async () => {
      const upstream = lastUpstream!;
      const closed = new Promise<void>(resolve => upstream.once("close", () => resolve()));
      upstream.send(lastRequest); await closed;
    },
    close: () => { for (const socket of live) socket.terminate(); sockets.close(); server.closeAllConnections(); server.close(); },
  };
}

test("encrypted relay creates and steers real sessions while retaining roles and device control", { timeout: 45000 }, async () => {
  const privateFiles = mkdtempSync(join(tmpdir(), "infinite-remote-"));
  const machineId = randomUUID(), registration = randomBytes(32).toString("base64url");
  const tokenFile = join(privateFiles, "registration.key");
  writeFileSync(tokenFile, registration, { mode: 0o600 });
  const relay = createRelayServer({ registrations: [{ machineId, tokenHash: hashToken(registration) }] });
  const relayUrl = await listen(relay.server), proxy = await wireProxy(relayUrl);
  const clients: RemoteClient[] = [];
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
    assert.equal((await fetch(`${relayUrl}/api/sessions`)).status, 404, "the portal does not expose runner APIs");
  } finally {
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

async function httpRunner() {
  const token = randomBytes(32).toString("base64url"), machineId = randomUUID();
  const requests: { path: string; authorization?: string; body: unknown }[] = [];
  let oversized = false;
  let holdNextResponse: ((release: () => void) => void) | undefined;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url!, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader("Content-Type", "application/json");
      if (oversized) { oversized = false; res.end(JSON.stringify({ value: "x".repeat(MAX_RESPONSE_BYTES) })); }
      else {
        const response = JSON.stringify({ count: requests.length, method: req.method, path: req.url });
        if (holdNextResponse) {
          const held = holdNextResponse; holdNextResponse = undefined;
          held(() => res.end(response));
        } else res.end(response);
      }
    });
  });
  const config = {
    origin: "http://127.0.0.1", port: 0, environment: "local", machine: { id: machineId, label: "Test runner" }, remote: { enabled: true },
    tokens: [{ id: "test-owner", label: "Test owner", role: "owner", hash: hashToken(token) }],
  } as Config;
  const closeRemote = connectRemoteAccess(server, config), url = await listen(server);
  return {
    token, machineId, requests, config, url,
    holdNext: () => new Promise<() => void>(resolve => { holdNextResponse = resolve; }),
    oversized: () => { oversized = true; },
    close: () => { closeRemote(); server.closeAllConnections(); server.close(); },
  };
}

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
    for (const path of ["/login", "/sessions/../me", "/sessions/%2e%2e/me", "/sessions/" + randomUUID() + "/raw"]) {
      await assert.rejects(client.request(path), (error: RemoteError) => error.status === 403);
    }
    // Workspace content moves only over a direct owner connection.
    const hash = "a".repeat(64);
    for (const [method, path] of [["POST", "/projects/project/sync/begin"], ["POST", "/projects/project/sync/has"], ["PUT", `/projects/project/sync/blob/${hash}`],
      ["GET", `/projects/project/sync/blob/${hash}`], ["POST", "/projects/project/sync/commit"], ["POST", "/projects/project/sync/export"]] as const)
      await assert.rejects(client.request(path, { method, body: method === "GET" ? undefined : {} }), (error: RemoteError) => error.status === 403 && error.code === "remote-endpoint-denied");
    await assert.rejects(client.request("/projects/project/context", { method: "PUT", body: { text: "x".repeat(MAX_REQUEST_BYTES) } }), (error: RemoteError) => error.status === 413);
    assert.equal(runner.requests.length, 1);
    assert.deepEqual(await client.request("/projects/project"), { count: 2, method: "GET", path: "/api/projects/project" });
    assert.deepEqual(await client.request("/projects/project/sync/apply", { body: {} }), { count: 3, method: "POST", path: "/api/projects/project/sync/apply" });
    runner.oversized();
    await assert.rejects(client.request("/me"), (error: RemoteError) => error.status === 413 && error.code === "response-too-large");
    const beforeRevoke = runner.requests.length;
    runner.config.tokens.splice(0);
    await assert.rejects(client.request("/me"), RemoteError);
    assert.equal(runner.requests.length, beforeRevoke, "revocation stops an already authenticated channel before forwarding");
    assert.throws(() => createRemoteClient({ url: "http://remote.example", token: runner.token }), /HTTPS/);
  } finally { for (const client of clients) client.close(); runner.close(); }
});

function openSocket(url: string, token?: string) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url.replace("http:", "ws:"), token ? { headers: { Authorization: `Bearer ${token}` } } : {});
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
