import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpServer } from "../packages/host/src/mcp-server.js";
import { hashToken } from "../packages/host/src/config.js";
import { McpRequestError, type McpRequestApi } from "../packages/host/src/mcp-types.js";
import type { Config } from "../packages/host/src/types.js";

async function fixture(apiOverrides: Partial<McpRequestApi> = {}) {
  const token = randomBytes(32).toString("base64url");
  const ownerToken = randomBytes(32).toString("base64url");
  const calls: string[] = [];
  const api: McpRequestApi = {
    listProjects: id => { calls.push(id); return { projects: [{ id: "work", name: "Work" }] }; },
    startRequest: () => { calls.push("start"); throw new Error("private host diagnostic"); },
    getRequest: () => { throw new McpRequestError("request-unavailable", "private host diagnostic"); },
    replyToRequest: () => { throw new McpRequestError("private host diagnostic", "private host diagnostic"); },
    controlRequest: () => { throw new Error("private host diagnostic"); },
    ...apiOverrides,
  };
  const config = { tokens: [{ id: "owner", label: "Owner", role: "owner", hash: hashToken(ownerToken) }], mcp: { port: 0, origin: "https://connector.example", connectors: [{ id: "assistant", name: "Assistant", tokenHash: hashToken(token), projectIds: ["work"] }] } } as Config;
  const listener = createMcpServer(config, api);
  await new Promise<void>(resolve => listener.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(listener.server.address() as { port: number }).port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  const call = (body: unknown, extra: Record<string, string> = {}): Promise<Response> => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    if (extra.host) return new Promise((resolve, reject) => {
      const wire = request(origin + "/mcp", { method: "POST", headers: { ...headers, ...extra } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      });
      wire.on("error", reject);
      wire.end(payload);
    });
    return fetch(origin + "/mcp", { method: "POST", headers: { ...headers, ...extra }, body: payload });
  };
  return { ...listener, token, ownerToken, origin, headers, call, calls, config };
}
const rpc = (method: string, params = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

for (const era of ["legacy", "modern"] as const) {
  test(`official SDK ${era} initialize, discovery and dispatch use the authenticated connector`, { timeout: 10000 }, async () => {
    const host = await fixture();
    const requests: { method: string; params?: { protocolVersion?: string } }[] = [];
    const client = new Client({ name: "connector-test", version: "1" }, era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
    const transport = new StreamableHTTPClientTransport(new URL(host.origin + "/mcp"), {
      requestInit: { headers: host.headers },
      fetch: async (url, init) => { if (typeof init?.body === "string") requests.push(JSON.parse(init.body)); return fetch(url, init); },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["control_request", "get_request", "list_projects", "reply_to_request", "start_request"]);
      assert.deepEqual((await client.callTool({ name: "list_projects", arguments: {} })).structuredContent, { projects: [{ id: "work", name: "Work" }] });
      assert.deepEqual(host.calls, ["assistant"]);
      if (era === "legacy") assert.match(requests.find(request => request.method === "initialize")!.params!.protocolVersion!, /^2025-/);
      else assert.ok(requests.some(request => request.method === "tools/call"));
    } finally { await client.close(); await host.close(); }
  });
}

test("HTTP gates reject untrusted input before dispatch or JSON parsing", async () => {
  const host = await fixture();
  try {
    const valid = rpc("tools/call", { name: "list_projects", arguments: {} });
    for (const [extra, status] of [
      [{ authorization: `Bearer ${host.ownerToken}` }, 401],
      [{ authorization: "Bearer invalid" }, 401],
      [{ origin: "https://evil.example" }, 403],
      [{ origin: "null" }, 403],
      [{ host: "evil.example", "x-forwarded-host": "connector.example" }, 403],
      [{ host: "127.0.0.1:1" }, 403],
      [{ "content-type": "text/plain" }, 415],
    ] as [Record<string, string>, number][]) {
      const response = await host.call(valid, extra);
      assert.equal(response.status, status, JSON.stringify(extra));
      await response.text();
    }
    assert.equal((await host.call("{invalid", { authorization: "Bearer invalid" })).status, 401);
    assert.equal((await host.call("{invalid")).status, 400);
    assert.equal((await host.call({ ...valid, padding: "x".repeat(96 * 1024) })).status, 413);
    assert.equal((await host.call({ ...valid, padding: "x".repeat(96 * 1024) }, { host: new URL(host.origin).host })).status, 413, "chunked bodies obey the same byte limit");
    assert.equal((await fetch(host.origin + "/api/me", { headers: host.headers })).status, 404);
    assert.equal((await fetch(host.origin + "/mcp?alternate=1", { headers: host.headers })).status, 404);
    assert.deepEqual(host.calls, []);
    const publicHost = await host.call(valid, { host: "connector.example", origin: "https://connector.example" });
    assert.equal(publicHost.status, 200);
    await publicHost.text();
    assert.deepEqual(host.calls, ["assistant"]);
  } finally { await host.close(); }
});

test("SDK notifications have no tool side effects and invalid arguments never enter the domain", async () => {
  const host = await fixture();
  try {
    for (const body of [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "tools/call", params: { name: "list_projects", arguments: {} } },
    ]) {
      const response = await host.call(body);
      assert.equal(response.status, 202);
      assert.equal(await response.text(), "");
    }
    const invalid = await host.call(rpc("tools/call", { name: "start_request", arguments: { requestId: randomUUID(), projectId: "work", objective: "Work", connectorId: "other" } }));
    assert.match(await invalid.text(), /error|isError/);
    for (const method of ["GET", "DELETE"]) assert.equal((await fetch(host.origin + "/mcp", { method, headers: host.headers })).status, 405);
    assert.deepEqual(host.calls, []);
  } finally { await host.close(); }
});

test("tool errors use a fixed public catalog and shutdown closes the listener", async () => {
  const host = await fixture();
  const client = new Client({ name: "connector-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(host.origin + "/mcp"), { requestInit: { headers: host.headers } }));
  try {
    for (const [name, args, code] of [
      ["start_request", { requestId: randomUUID(), projectId: "work", objective: "Work" }, "request-action-unavailable"],
      ["get_request", { runId: randomUUID() }, "request-unavailable"],
      ["reply_to_request", { runId: randomUUID(), requestId: randomUUID(), revision: 1, text: "Continue" }, "request-action-unavailable"],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent!.code, code);
      assert.doesNotMatch(JSON.stringify(result), /private host diagnostic/);
    }
  } finally { await client.close(); await host.close(); }
  assert.equal(host.server.listening, false);
  await host.close();
  await assert.rejects(fetch(host.origin + "/mcp"));
});

test("the connector bounds simultaneous domain operations", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  const host = await fixture({ listProjects: async () => { entered++; await gate; return { projects: [] }; } });
  const pending: Promise<Response>[] = [];
  try {
    for (let i = 0; i < 32; i++) pending.push(host.call(rpc("tools/call", { name: "list_projects", arguments: {} })));
    const until = Date.now() + 5000;
    while (entered < 32 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(entered, 32);
    assert.equal((await host.call(rpc("tools/call", { name: "list_projects", arguments: {} }))).status, 503);
    assert.equal(entered, 32);
  } finally { release(); await Promise.all(pending.map(async response => (await response).text())); await host.close(); }
});

test("credential replacement and disabling immediately revoke authentication", async () => {
  const host = await fixture();
  try {
    const valid = rpc("tools/call", { name: "list_projects", arguments: {} });
    const replacement = randomBytes(32).toString("base64url");
    host.config.mcp = { ...host.config.mcp!, connectors: [{ ...host.config.mcp!.connectors[0], tokenHash: hashToken(replacement) }] };
    assert.equal((await host.call(valid)).status, 401);
    const accepted = await host.call(valid, { authorization: `Bearer ${replacement}` });
    assert.equal(accepted.status, 200);
    await accepted.text();
    host.config.mcp = undefined;
    assert.equal((await host.call(valid, { authorization: `Bearer ${replacement}` })).status, 503);
    assert.deepEqual(host.calls, ["assistant"]);
  } finally { await host.close(); }
});

test("host startup rechecks a mirror grant forgotten after configuration validation", async () => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { readConfig } = await import("../packages/host/src/config.js");
  const { createApp } = await import("../packages/host/src/server.js");
  const { MirroredProjects } = await import("../packages/host/src/mirrored-projects.js");
  const root = mkdtempSync("/tmp/inf-mcp-grant-");
  let active: ReturnType<typeof createApp> | undefined;
  try {
    const file = join(root, "config.json");
    const raw = {
      port: 0, origin: "http://127.0.0.1", environment: "local",
      stateDir: join(root, "state"), runDir: join(root, "run"), keyFile: join(root, "key"),
      sync: { homeDir: join(root, "home") },
      tokens: [{ id: "owner", label: "Owner", role: "owner", hash: "a".repeat(64) }],
      projects: [{ id: "work", name: "Work", path: join(root, "workspace") }],
      linear: { apiKeyFile: join(root, "linear-key") },
      intake: { linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "infinite", admitIssues: true }, mission: { groupId: "work" }, requireSlackThread: false },
    };
    writeFileSync(raw.keyFile, randomBytes(32), { mode: 0o600 });
    writeFileSync(raw.linear.apiKeyFile, "fixture-credential", { mode: 0o600 });
    writeFileSync(file, JSON.stringify(raw));
    const initial = readConfig(file);
    const mirrors = new MirroredProjects(initial.config, initial.key);
    const project = mirrors.resolve("Projects/sample");
    const mcp = { port: 0, origin: "https://connector.example", connectors: [{ id: "assistant", name: "Assistant", tokenHash: "b".repeat(64), projectIds: [project.id] }] };
    writeFileSync(file, JSON.stringify({ ...raw, mcp }));
    const loaded = readConfig(file);
    mirrors.forget(project.id);
    assert.throws(() => { active = createApp(loaded.config, loaded.key); }, /MCP grants must name configured projects/);
    assert.equal(existsSync(join(raw.stateDir, "sessions")), false, "rejected grants must not start host services");
    assert.equal(existsSync(raw.runDir), false);
  } finally { await active?.closeConnections(); rmSync(root, { recursive: true, force: true }); }
});

test("CLI releases both listeners on startup failure and graceful shutdown", { timeout: 20000 }, async () => {
  const { spawn } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const root = mkdtempSync("/tmp/inf-mcp-");
  const reserve = async () => {
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
    return { socket, port: (socket.address() as { port: number }).port };
  };
  try {
    for (const occupied of ["mcp", "owner", "shutdown"] as const) {
      const blocked = await reserve();
      if (occupied === "shutdown") await new Promise<void>(resolve => blocked.socket.close(() => resolve()));
      const spare = await reserve();
      await new Promise<void>(resolve => spare.socket.close(() => resolve()));
      const directory = join(root, occupied);
      mkdirSync(directory);
      mkdirSync(join(directory, "workspace"));
      writeFileSync(join(directory, "key"), randomBytes(32), { mode: 0o600 });
      writeFileSync(join(directory, "linear-key"), "fixture-credential", { mode: 0o600 });
      const config = {
        port: occupied === "mcp" ? spare.port : blocked.port, origin: "http://127.0.0.1", environment: "local",
        stateDir: join(directory, "state"), runDir: join(directory, "run"), keyFile: join(directory, "key"),
        tokens: [{ id: "owner", label: "Owner", role: "owner", hash: hashToken(randomBytes(32).toString("base64url")) }],
        projects: [{ id: "work", name: "Work", path: join(directory, "workspace") }],
        linear: { apiKeyFile: join(directory, "linear-key"), endpoint: "http://127.0.0.1:9/graphql" },
        intake: { linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "infinite", admitIssues: false }, mission: { groupId: "work" }, requireSlackThread: false },
        mcp: { port: occupied === "mcp" ? blocked.port : spare.port, origin: "https://connector.example", connectors: [{ id: "assistant", name: "Assistant", tokenHash: hashToken(randomBytes(32).toString("base64url")), projectIds: ["work"] }] },
      };
      const file = join(directory, "config.json");
      writeFileSync(file, JSON.stringify(config));
      const child = spawn(process.execPath, ["--import", "tsx", resolve("packages/host/src/cli.ts"), "serve", "--config", file], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      try {
        const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
        if (occupied === "shutdown") {
          const until = Date.now() + 10000;
          while (!output.includes("Closing this API") && child.exitCode === null && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
          assert.match(output, /Closing this API/);
          const response = await fetch(`http://127.0.0.1:${config.mcp.port}/mcp`, { method: "POST", headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` } });
          assert.equal(response.status, 401, "the separate loopback MCP listener is bound");
          child.kill("SIGTERM");
        }
        const exitCode = await exited;
        assert.equal(exitCode, occupied === "shutdown" ? 0 : 1);
        if (occupied !== "shutdown") assert.match(output, /EADDRINUSE/);
        assert.equal(existsSync(join(directory, "run", "server.lock")), false);
        const probe = createServer();
        await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(spare.port, "127.0.0.1", resolve); });
        await new Promise<void>(resolve => probe.close(() => resolve()));
      } finally { child.kill("SIGKILL"); await new Promise<void>(resolve => blocked.socket.close(() => resolve())); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
