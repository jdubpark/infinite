import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { startHost, waitFor, claimControl, type Host } from "./helpers.js";

function nativeUrl(host: Host, id: string, control: Awaited<ReturnType<typeof claimControl>>) {
  const url = new URL(`/api/sessions/${id}/native`, host.origin);
  url.protocol = "ws:";
  url.searchParams.set("client", control.headers["X-Infinite-Client"]);
  url.searchParams.set("lease", control.lease.id);
  return url;
}

async function connect(url: URL, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const messages: any[] = [];
  ws.on("message", data => messages.push(JSON.parse(data.toString())));
  ws.on("error", () => {});
  let next = 1;
  const rpc = async (method: string, params: unknown = {}) => {
    const id = next++;
    ws.send(JSON.stringify({ id, method, params }));
    return waitFor(async () => messages.find(message => message.id === id && !message.method), Boolean);
  };
  await rpc("initialize", { clientInfo: { name: "infinite_test", version: "1" } });
  ws.send(JSON.stringify({ method: "initialized" }));
  return { ws, rpc, messages };
}

test("native Codex attachment fences device control, pins its conversation, and survives API and client loss", { timeout: 35000 }, async () => {
  const host = await startHost({ agents: { codex: { command: process.execPath, args: [resolve("tests/fixtures/native-codex.mjs")] } } });
  const clients: WebSocket[] = [];
  const id = randomUUID();
  const path = `/sessions/${id}`;
  const workspace = host.config.projects[0].path;
  const bearer = { Authorization: `Bearer ${host.tokens.owner}` };
  const create = { provider: "codex", projectId: "rehearsal", title: "Native UI", localUi: true };
  try {
    // Invalid opt-ins are refused before creating a worker or a conversation.
    for (const change of [{ nativeArgs: [] }, { nativeArgs: ["--resume", "foreign"] }, { provider: "grok", nativeArgs: ["prompt"] }])
      assert.notEqual((await host.fetchApi("/sessions", "owner", { ...create, ...change, requestId: randomUUID() })).status, 201);
    assert.equal((await host.fetchApi("/sessions")).body.sessions.length, 0);
    assert.equal((await host.fetchApi("/sessions", "owner", { ...create, requestId: id, nativeArgs: ["initial prompt"] })).status, 201);
    const info = await waitFor(async () => (await host.fetchApi(`${path}/native`)).body, body => Boolean(body?.sessionId));
    const initialPid = readFileSync(workspace + "/provider-pid", "utf8");
    const controller = await claimControl(host, id, "owner");
    const url = nativeUrl(host, id, controller);
    for (const headers of [{}, { Authorization: `Bearer ${host.tokens.viewer}` }, { Authorization: `Bearer ${host.tokens.controller}` }, { ...bearer, Origin: host.origin }])
      await assert.rejects(connect(url, headers), /403/);
    assert.equal((await host.fetchApi(`${path}/native`, "viewer")).status, 403);
    assert.equal((await host.fetchApi(`${path}/native`, "controller")).status, 403);
    const first = await connect(url, bearer); clients.push(first.ws);
    const resumed = await first.rpc("thread/resume", { threadId: info.sessionId });
    assert.equal(resumed.result.thread.id, info.sessionId);
    assert.deepEqual(resumed.result.thread.turns, [{ text: "initial prompt" }]);
    for (const [method, params] of [
      ["thread/start", {}], ["thread/fork", { threadId: info.sessionId }],
      ["thread/resume", { threadId: info.sessionId, path: "/fixture/other-rollout" }],
      ["thread/resume", { threadId: info.sessionId, history: [] }],
      ["turn/start", { threadId: randomUUID(), input: [] }],
    ] as const) assert.ok((await first.rpc(method, params)).error, `${method} must not escape the pinned conversation`);
    assert.deepEqual((await first.rpc("thread/loaded/list")).result.data, [info.sessionId]);
    assert.deepEqual((await first.rpc("thread/list")).result, { data: [{ id: info.sessionId, turns: [{ text: "initial prompt" }] }], nextCursor: null });

    await first.rpc("turn/start", { threadId: info.sessionId, input: [{ type: "text", text: "approval" }] });
    await waitFor(async () => first.messages.some(message => message.method === "item/commandExecution/requestApproval"), Boolean);
    assert.equal(existsSync(workspace + "/approval-result.json"), false, "the wrapper must not approve provider requests");
    const phone = await claimControl(host, id, "controller", { takeover: true });
    // Immediately race a stale native response against the takeover, without waiting
    // for the periodic socket close. The worker must check every individual frame.
    first.ws.send(JSON.stringify({ id: "approval", result: { decision: "accept" } }));
    await waitFor(async () => first.ws.readyState, state => state === WebSocket.CLOSED);
    assert.equal(existsSync(workspace + "/approval-result.json"), false);
    await assert.rejects(connect(url, bearer), /403/);
    assert.equal((await host.fetchApi(`${path}/input`, "controller", { requestId: randomUUID(), text: "phone follow-up", submit: true }, phone.headers)).status, 200);

    const nextControl = await claimControl(host, id, "owner", { takeover: true });
    const second = await connect(nativeUrl(host, id, nextControl), bearer); clients.push(second.ws);
    const next = await second.rpc("thread/resume", { threadId: info.sessionId });
    assert.equal(next.result.pid, Number(initialPid));
    assert.ok(next.result.thread.turns.some((turn: { text: string }) => turn.text === "phone follow-up"));
    await second.rpc("turn/start", { threadId: info.sessionId, input: [{ type: "text", text: "work" }] });
    second.ws.terminate();
    await host.stopApi();
    await waitFor(async () => existsSync(workspace + "/work-complete"), Boolean);
    await host.start();
    assert.equal((await host.fetchApi(`${path}/native`)).body.sessionId, info.sessionId);
    await waitFor(async () => (await host.fetchApi(path)).body.screen, screen => screen.includes("Observer redraw after turn completed"));
    const state = (await host.fetchApi(path)).body;
    assert.equal(state.attention.state, "turn-finished");
    assert.equal(state.attention.source, "protocol");
    const signals = (await host.fetchApi(`${path}/events?types=signal`)).body.events;
    assert.equal(signals.filter((event: any) => event.data.source === "protocol" && event.data.kind === "turn-end").length, 1, "multiple native clients must not duplicate provider lifecycle events");
    const third = await connect(nativeUrl(host, id, nextControl), bearer); clients.push(third.ws);
    const restored = (await third.rpc("thread/resume", { threadId: info.sessionId })).result;
    assert.equal(restored.pid, Number(initialPid));
    assert.deepEqual(restored.thread.turns.map((turn: { text: string }) => turn.text), ["initial prompt", "approval", "phone follow-up", "work"]);

    // Delay the provider handshake so the worker admits frames into its bounded
    // queue, then changes device control before it can forward them.
    writeFileSync(workspace + "/hold-upgrades", "hold");
    const beforeQueue = (await host.fetchApi(path)).body.seq;
    const queued = new WebSocket(nativeUrl(host, id, nextControl), { headers: bearer }); clients.push(queued);
    queued.on("error", () => {});
    await new Promise<void>(resolve => queued.once("open", resolve));
    queued.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "queue_test", version: "1" } } }));
    queued.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: info.sessionId, input: [{ type: "text", text: "stale queued prompt" }] } }));
    await waitFor(async () => (await host.fetchApi(`${path}/events?after=${beforeQueue}&types=input-intent`)).body.events, events => events.some((event: any) => event.data.op === "native" && event.data.method === "turn/start"));
    await waitFor(async () => existsSync(workspace + "/upgrade-held"), Boolean);
    await claimControl(host, id, "controller", { takeover: true });
    unlinkSync(workspace + "/hold-upgrades");
    await waitFor(async () => queued.readyState, state => state === WebSocket.CLOSED);
    const finalControl = await claimControl(host, id, "owner", { takeover: true });
    const final = await connect(nativeUrl(host, id, finalControl), bearer); clients.push(final.ws);
    const finalHistory = (await final.rpc("thread/resume", { threadId: info.sessionId })).result.thread.turns;
    assert.ok(!finalHistory.some((turn: { text: string }) => turn.text === "stale queued prompt"), "takeover must also fence frames queued before the provider handshake");
    const requests = readFileSync(workspace + "/provider-requests.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(requests.filter(request => request.method === "thread/start").length, 1);
    assert.equal(requests.filter(request => request.method === "turn/start").length, 4, "attachment must not replay an uncertain prompt");
  } finally { for (const client of clients) client.terminate(); await host.stop(); }
});

test("CLI opens a local native frontend with a loopback credential and detaches without ending the backend", { timeout: 20000 }, async () => {
  const fixture = resolve("tests/fixtures/native-codex.mjs");
  const host = await startHost({ agents: { codex: { command: process.execPath, args: [fixture] } } });
  let client: IPty | undefined;
  try {
    const bin = host.root + "/bin"; mkdirSync(bin);
    // A fixture executable at the normal local CLI boundary; production has no test flag.
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(bin + "/codex", `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
    const config = host.root + "/client.json";
    writeFileSync(config, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    client = ptySpawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", config,
      "--local-ui", "codex", "--model", "fixture-model", "--no-alt-screen", "login"], {
      cols: 120, rows: 30, cwd: host.root, env: { ...process.env, PATH: bin + ":" + process.env.PATH },
    });
    let output = "", exited = false; client.onData(data => output += data); client.onExit(() => exited = true);
    await waitFor(async () => output, value => value.includes("LOCAL NATIVE READY"));
    const sessions = (await host.fetchApi("/sessions")).body.sessions;
    assert.equal(sessions.length, 1);
    const id = sessions[0].id, pid = sessions[0].pid;
    const info = (await host.fetchApi(`/sessions/${id}/native`)).body;
    const native = JSON.parse(readFileSync(host.root + "/native-client.json", "utf8"));
    const url = new URL(native.args[native.args.indexOf("--remote") + 1]);
    assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/"); assert.equal(url.search, "");
    assert.equal(native.args.at(-1), info.sessionId);
    assert.ok(native.args.includes("--no-alt-screen"), "local display flags must reach the local provider frontend");
    assert.notEqual(native.tokenHash, createHash("sha256").update(host.tokens.owner).digest("hex"), "the provider frontend must not receive the owner's device key");
    assert.ok(!JSON.stringify(native.args).includes(host.tokens.owner));
    await assert.rejects(connect(url, {}), /403/);
    client.write("local follow-up\r");
    await waitFor(async () => (await host.fetchApi(`/sessions/${id}`)).body.screen, value => value.includes("local follow-up"));
    client.kill("SIGTERM"); await waitFor(async () => exited, Boolean);
    const after = (await host.fetchApi(`/sessions/${id}`)).body;
    assert.equal(after.status, "running"); assert.equal(after.pid, pid); assert.equal(after.control, null);
    const requests = readFileSync(host.config.projects[0].path + "/provider-requests.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(requests.filter(r => r.method === "turn/start").map(r => r.params.input[0].text), ["login", "local follow-up"]);
  } finally { try { client?.kill("SIGKILL"); } catch {} await host.stop(); }
});
