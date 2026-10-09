import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
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
    assert.ok(first.ws.extensions.includes("permessage-deflate"), "native cloud connections must negotiate compression");
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
      "--cloud", "--local-ui", "codex", "--model", "fixture-model", "--no-alt-screen", "login"], {
      cols: 120, rows: 30, cwd: host.root, env: { ...process.env, PATH: bin + ":" + process.env.PATH },
    });
    let output = "", exited = false; client.onData(data => output += data); client.onExit(() => exited = true);
    await waitFor(async () => output, value => value.includes("LOCAL NATIVE READY") || exited);
    assert.equal(exited, false, "loading a large provider catalog must not disconnect the native frontend");
    assert.equal(JSON.parse(readFileSync(host.root + "/native-catalog.json", "utf8")).bytes, 13 * 1024 * 1024);
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

test("default Codex uses the laptop project, hands off a verified checkpoint, and pauses uncertain effects", { timeout: 60000 }, async () => {
  const fixture = resolve("tests/fixtures/native-codex.mjs");
  const host = await startHost({ agents: { codex: { command: process.execPath, args: [fixture] } } });
  const clients: WebSocket[] = [];
  const executorPids = new Set<number>();
  let launch: ChildProcess | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const bin = host.root + "/bin", laptop = host.root + "/laptop", cwd = laptop + "/work", included = host.root + "/included";
    mkdirSync(bin); mkdirSync(cwd, { recursive: true }); mkdirSync(included);
    writeFileSync(cwd + "/marker.txt", "COMMITTED");
    execFileSync("git", ["init", "--quiet", laptop]);
    execFileSync("git", ["-C", laptop, "add", "work/marker.txt"]);
    execFileSync("git", ["-C", laptop, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Fixture baseline"]);
    writeFileSync(cwd + "/marker.txt", "LAPTOP_UNCOMMITTED");
    writeFileSync(cwd + "/untracked.txt", "UNTRACKED_CONTEXT");
    writeFileSync(included + "/included.txt", "INCLUDED_CONTEXT");
    writeFileSync(host.config.projects[0].path + "/marker.txt", "UNRELATED_HOST");
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(bin + "/codex", `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
    const config = host.root + "/client.json";
    writeFileSync(config, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    const launchIn = async (directory: string, title: string, include?: string) => {
      const cli = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"),
        "--client-config", config, "--title", title, ...(include ? ["--include", include] : []), "--detach", "codex", "workspace edit"], {
        cwd: directory, env: { ...process.env, PATH: bin + ":" + process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
      });
      launch = cli;
      let output = "";
      cli.stdout.on("data", data => { output += data; }); cli.stderr.on("data", data => { output += data; });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => { cli.kill("SIGTERM"); reject(new Error(`CLI launch timed out: ${output}`)); }, 20000);
        cli.once("error", error => { clearTimeout(timeout); reject(error); });
        cli.once("exit", code => { clearTimeout(timeout); resolve(code); });
      });
      assert.equal(code, 0, output);
      assert.ok(!output.includes(host.tokens.owner));
    };
    await launchIn(cwd, "Default project", included);
    const sessions = (await host.fetchApi("/sessions")).body.sessions;
    assert.equal(sessions.length, 1);
    const id = sessions[0].id, path = `/sessions/${id}`;
    await waitFor(async () => existsSync(cwd + "/agent-edit.txt"), Boolean);
    assert.equal(readFileSync(cwd + "/agent-edit.txt", "utf8"), "LAPTOP_UNCOMMITTED\n");
    assert.equal(existsSync(host.config.projects[0].path + "/agent-edit.txt"), false);
    const state = (await host.fetchApi(path)).body;
    assert.equal(state.workspace.cwd, realpathSync(cwd));
    assert.deepEqual(state.workspace.roots, [realpathSync(laptop), realpathSync(included)]);
    assert.equal(state.execution.location, "laptop"); assert.equal(state.execution.state, "online");
    const executorPid = Number(readFileSync(cwd + "/executor-pid", "utf8")); executorPids.add(executorPid);
    assert.ok(alive(executorPid), "closing the launch CLI must leave the laptop service alive");
    const ready = await waitFor(async () => (await host.fetchApi(path)).body, value => value.execution?.cloudReady === true, 20000);
    assert.ok(ready.execution.checkpoint?.id); assert.ok(ready.execution.checkpoint?.capturedAt);
    const providerPid = readFileSync(host.config.projects[0].path + "/provider-pid", "utf8");
    await host.stopApi();
    await host.start();
    const reconnected = await waitFor(async () => (await host.fetchApi(path)).body.execution, value => value?.state === "online");
    assert.equal(reconnected.location, "laptop", "an API restart must let the live laptop relay reconnect before cloud handoff");
    assert.equal(Number(readFileSync(cwd + "/executor-pid", "utf8")), executorPid, "relay reconnection must reuse the admitted executor");
    assert.equal((await host.fetchApi(path)).body.pid, state.pid, "API restart must retain the session worker");

    const executorUrl = new URL(`/api/sessions/${id}/executor`, host.origin); executorUrl.protocol = "ws:";
    await assert.rejects(connect(executorUrl, { Authorization: `Bearer ${host.tokens.owner}`, "X-Infinite-Executor": "0".repeat(64) }), /403/);
    const info = await waitFor(async () => (await host.fetchApi(`${path}/native`)).body, value => Boolean(value?.sessionId));
    const control = await claimControl(host, id, "owner");
    const native = await connect(nativeUrl(host, id, control), { Authorization: `Bearer ${host.tokens.owner}` }); clients.push(native.ws);
    const local = (await native.rpc("thread/resume", { threadId: info.sessionId, cwd: host.config.projects[0].path })).result.thread.environments[0];
    await native.rpc("thread/settings/update", { threadId: info.sessionId, cwd: host.config.projects[0].path });
    assert.ok((await native.rpc("environment/add", { environmentId: "foreign" })).error);
    assert.ok((await native.rpc("fs/readFile", { path: "marker.txt" })).error);
    for (const method of ["command/exec", "command/exec/write", "fuzzyFileSearch", "fuzzyFileSearch/sessionStart", "gitDiffToRemote", "thread/shellCommand"])
      assert.ok((await native.rpc(method, { threadId: info.sessionId, cwd: host.config.projects[0].path })).error, `${method} must not operate on the host workspace`);
    await native.rpc("turn/start", { threadId: info.sessionId, cwd: host.config.projects[0].path, input: [{ type: "text", text: "workspace edit" }] });
    await waitFor(async () => readFileSync(cwd + "/agent-edit.txt", "utf8"), value => value === "LAPTOP_UNCOMMITTED\n".repeat(2));
    await waitFor(async () => (await host.fetchApi(path)).body.execution, value => value.cloudReady && value.checkpoint?.id !== ready.execution.checkpoint.id, 20000);
    const requests = readFileSync(host.config.projects[0].path + "/provider-requests.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(requests.filter(request => request.method === "thread/start").length, 1);
    for (const request of requests.filter(request => ["thread/start", "turn/start"].includes(request.method))) {
      assert.equal(request.params.cwd, realpathSync(cwd));
      assert.equal(request.params.environments.length, 1);
    }
    for (const request of requests.filter(request => ["thread/resume", "thread/settings/update"].includes(request.method))) assert.equal(request.params.cwd, undefined);
    process.kill(executorPid, "SIGTERM");
    const cloud = await waitFor(async () => (await host.fetchApi(path)).body.execution, value => value?.location === "cloud" && value.state === "online", 20000);
    assert.ok(cloud.checkpoint?.id); assert.ok(cloud.checkpoint?.capturedAt);
    assert.equal((await host.fetchApi(path)).body.status, "running", "executor loss must not replace or end the cloud conversation");
    assert.equal((await host.fetchApi(`${path}/native`)).body.sessionId, info.sessionId);
    assert.equal(readFileSync(host.config.projects[0].path + "/provider-pid", "utf8"), providerPid);
    const destination = (await native.rpc("thread/read", { threadId: info.sessionId })).result.thread.environments[0];
    assert.notEqual(destination.environmentId, local.environmentId, "a placement must use a fresh provider environment");
    assert.notEqual(destination.cwd, realpathSync(cwd));
    assert.equal(readFileSync(destination.cwd + "/marker.txt", "utf8"), "LAPTOP_UNCOMMITTED");
    assert.equal(readFileSync(destination.cwd + "/untracked.txt", "utf8"), "UNTRACKED_CONTEXT");
    assert.ok(destination.runtimeWorkspaceRoots.some((root: string) => existsSync(root + "/included.txt") && readFileSync(root + "/included.txt", "utf8") === "INCLUDED_CONTEXT"));
    writeFileSync(cwd + "/marker.txt", "LAPTOP_OFFLINE_EDIT");
    await native.rpc("turn/start", { threadId: info.sessionId, input: [{ type: "text", text: "workspace edit" }] });
    await waitFor(async () => readFileSync(destination.cwd + "/agent-edit.txt", "utf8"), value => value === "LAPTOP_UNCOMMITTED\n".repeat(3));
    assert.equal(readFileSync(cwd + "/agent-edit.txt", "utf8"), "LAPTOP_UNCOMMITTED\n".repeat(2));
    assert.equal(readFileSync(cwd + "/marker.txt", "utf8"), "LAPTOP_OFFLINE_EDIT");
    assert.equal(existsSync(host.config.projects[0].path + "/agent-edit.txt"), false);

    for (const role of ["viewer", "controller"] as const)
      assert.equal((await host.fetchApi(`${path}/workspace-export`, role, { method: "sync/export" })).status, 403);
    assert.equal((await host.fetchApi(`${path}/workspace-export`, "owner", { method: "sync/export" }, { Origin: host.origin })).status, 403);
    assert.equal((await host.fetchApi(`${path}/workspace-export`, "owner", { method: "sync/begin" })).status, 400);
    const recovery = host.root + "/recovery";
    const downloaded = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"),
      "--client-config", config, "recover", id, "--output", recovery], { cwd, timeout: 30000 });
    const recoveredCwd = downloaded.stdout.trim();
    assert.ok(realpathSync(recoveredCwd).startsWith(realpathSync(recovery) + "/"));
    assert.ok(recoveredCwd.endsWith("/work"), "recovery must retain the nested working directory");
    assert.equal(readFileSync(recoveredCwd + "/agent-edit.txt", "utf8"), "LAPTOP_UNCOMMITTED\n".repeat(3));
    assert.equal(readFileSync(recoveredCwd + "/marker.txt", "utf8"), "LAPTOP_UNCOMMITTED");
    assert.equal(readFileSync(recoveredCwd + "/untracked.txt", "utf8"), "UNTRACKED_CONTEXT");
    assert.equal(readFileSync(resolve(recoveredCwd, "../../included/included.txt"), "utf8"), "INCLUDED_CONTEXT");
    assert.equal(readFileSync(cwd + "/marker.txt", "utf8"), "LAPTOP_OFFLINE_EDIT", "recovery must preserve unsynced laptop edits");
    assert.equal(readFileSync(cwd + "/agent-edit.txt", "utf8"), "LAPTOP_UNCOMMITTED\n".repeat(2));
    assert.equal((await host.fetchApi(path)).body.execution.location, "cloud", "downloading a copy must not move execution");

    // A second real relay exercises the opposite boundary: an effect without
    // its response is unresolved, so readiness cannot authorize a replay.
    const uncertainCwd = host.root + "/uncertain"; mkdirSync(uncertainCwd);
    writeFileSync(uncertainCwd + "/marker.txt", "UNCERTAIN_PROJECT");
    await launchIn(uncertainCwd, "Uncertain operation");
    const uncertainSession = (await host.fetchApi("/sessions")).body.sessions.find((session: any) => session.title === "Uncertain operation");
    const uncertainPath = `/sessions/${uncertainSession.id}`;
    const uncertainPid = Number(readFileSync(uncertainCwd + "/executor-pid", "utf8")); executorPids.add(uncertainPid);
    await waitFor(async () => (await host.fetchApi(uncertainPath)).body.execution?.cloudReady, Boolean, 20000);
    const uncertainInfo = (await host.fetchApi(`${uncertainPath}/native`)).body;
    const uncertainControl = await claimControl(host, uncertainSession.id, "owner");
    const uncertain = await connect(nativeUrl(host, uncertainSession.id, uncertainControl), { Authorization: `Bearer ${host.tokens.owner}` }); clients.push(uncertain.ws);
    const previous = (await uncertain.rpc("thread/read", { threadId: uncertainInfo.sessionId })).result.thread.environments;
    await uncertain.rpc("turn/start", { threadId: uncertainInfo.sessionId, input: [{ type: "text", text: "uncertain edit" }] });
    await waitFor(async () => existsSync(uncertainCwd + "/uncertain-effect.txt"), Boolean);
    process.kill(uncertainPid, "SIGTERM");
    const paused = await waitFor(async () => (await host.fetchApi(uncertainPath)).body.execution, value => value?.state === "paused");
    assert.equal(paused.location, "laptop");
    assert.deepEqual((await uncertain.rpc("thread/read", { threadId: uncertainInfo.sessionId })).result.thread.environments, previous);
    assert.equal(readFileSync(uncertainCwd + "/uncertain-effect.txt", "utf8"), "performed\n");
    assert.equal((await host.fetchApi(`${uncertainPath}/native`)).body.sessionId, uncertainInfo.sessionId);
  } finally {
    if (launch && launch.exitCode === null && launch.signalCode === null) launch.kill("SIGKILL");
    for (const client of clients) client.terminate();
    for (const pid of executorPids) if (alive(pid)) process.kill(pid, "SIGTERM");
    await host.stop();
  }
});
