#!/usr/bin/env node
// Experimental provider qualification. This does not qualify general process
// fencing, workspace replication, or automatic recovery after an uncertain effect.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket, WebSocketServer } from "ws";

const { values } = parseArgs({ options: {
  "app-server": { type: "string" }, codex: { type: "string", default: "codex" },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log(`Qualify the experimental Codex 0.162.0 environment patch.

node scripts/qualify-codex-handoff.mjs --app-server PATH [--codex PATH]

Use the alternate app-server built by scripts/build-codex-handoff.mjs.
The installed Codex supplies real, authenticated loopback exec-servers.
Two fixture-model scenarios verify same-turn and next-turn environment adoption
and a command refused before dispatch. Runtime data stays in ignored .local/.
No model credentials, existing conversation, or production settings are used.
This is not proof of arbitrary process migration or general outage recovery.`);
  process.exit(0);
}
const suppliedServer = values["app-server"] ?? process.env.INFINITE_CODEX_HANDOFF_APP_SERVER;
if (!suppliedServer) throw new Error("Provide --app-server PATH. See --help.");
if (!["darwin", "linux"].includes(process.platform)) throw new Error("This qualification supports macOS and Linux");
const appServer = resolve(suppliedServer);
await access(appServer, constants.X_OK);
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const local = join(repository, ".local");
await mkdir(local, { recursive: true, mode: 0o700 });
const output = await mkdtemp(join(local, "codex-handoff-qualification-"));
await chmod(output, 0o700);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

async function runScenario(mode) {
  const directory = join(output, mode);
  const paths = Object.fromEntries(["home", "host", "laptop", "cloud"].map(name => [name, join(directory, name)]));
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 });
  for (const [name, marker] of [["laptop", "LAPTOP_MARKER"], ["cloud", "CLOUD_MARKER"]]) {
    await writeFile(join(paths[name], "marker.txt"), marker);
    await writeFile(join(paths[name], "AGENTS.md"), `# Fixture instructions\nEnvironment marker: ${marker}. Continue the original task.\n`);
  }
  await writeFile(join(paths.host, "marker.txt"), "APP_SERVER_HOST_MARKER");
  const environment = {
    PATH: process.env.PATH, HOME: paths.home, CODEX_HOME: paths.home,
    TMPDIR: directory, RUST_LOG: "error",
  };
  const children = [], peers = [], proxies = [], pending = new Map(), events = [], requests = [];
  const abort = new AbortController();
  const receipt = { scenario: mode };
  let modelRequests = 0, threadId, turnId, call, nextRequestId = 0, failure;
  const selection = name => [{ environmentId: name, cwd: paths[name], runtimeWorkspaceRoots: [paths[name]] }];

  async function waitFor(predicate, label) {
    const deadline = Date.now() + 20000;
    while (true) {
      if (abort.signal.aborted) throw abort.signal.reason;
      const value = predicate();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`${label} timed out`);
      await delay(20);
    }
  }
  function child(command, args, cwd) {
    const process = spawn(command, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const state = { process, stderr: "", output: "" };
    state.exited = new Promise(resolve => process.once("close", resolve));
    process.on("error", error => abort.abort(error));
    process.stdin.on("error", error => abort.abort(error));
    process.stderr.on("data", data => { state.stderr = (state.stderr + data).slice(-16384); });
    children.push(state);
    return state;
  }
  async function version(command) {
    const state = child(command, ["--version"], paths.home);
    state.process.stdout.on("data", data => { state.output += data; });
    await state.exited;
    assert.equal(state.process.exitCode, 0, `${command} --version failed`);
    assert(/\b0\.162\.0\s*$/.test(state.output), "Use Codex 0.162.0 for this pinned qualification");
    return state.output.trim();
  }
  function result(response) {
    if (response.error) throw new Error(`Provider rejected request: ${JSON.stringify(response.error)}`);
    return response.result;
  }
  async function selectCloud() {
    const response = result(await call("turn/settings/update", { threadId, turnId, environments: selection("cloud") }));
    assert.equal(response.status, "applied");
    result(await call("thread/settings/update", { threadId, cwd: paths.cloud, environments: selection("cloud") }));
    const thread = result(await call("thread/read", { threadId, includeTurns: false })).thread;
    assert.equal(thread.environments.length, 1);
    assert.equal(thread.environments[0].environmentId, "cloud");
    assert.equal(thread.environments[0].cwd.startsWith("file:") ? fileURLToPath(thread.environments[0].cwd) : thread.environments[0].cwd, paths.cloud);
    receipt.environmentUpdateApplied = true;
  }

  async function executor(name) {
    const token = randomBytes(32).toString("hex");
    const state = child(values.codex, ["exec-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token",
      "--ws-token-sha256", createHash("sha256").update(token).digest("hex")], paths[name]);
    state.process.stdout.on("data", data => { state.output = (state.output + data).slice(-16384); });
    const endpoint = await waitFor(() => (state.output + state.stderr).match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0], "Executor startup");
    let url = endpoint;
    if (mode === "refused-operation" && name === "laptop") {
      const server = createServer();
      const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
      proxies.push({ server, sockets });
      server.on("upgrade", (request, socket, head) => {
        if (request.headers.authorization !== `Bearer ${token}`) { socket.destroy(); return; }
        sockets.handleUpgrade(request, socket, head, incoming => sockets.emit("connection", incoming));
      });
      sockets.on("connection", incoming => {
        const upstream = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10000 });
        peers.push(incoming, upstream);
        const queued = [];
        upstream.on("open", () => { for (const frame of queued) upstream.send(frame); });
        upstream.on("message", data => { if (incoming.readyState === WebSocket.OPEN) incoming.send(data.toString()); });
        upstream.on("error", error => { abort.abort(error); incoming.terminate(); });
        incoming.on("error", error => abort.abort(error));
        incoming.on("close", () => upstream.terminate());
        incoming.on("message", async data => {
          try {
            const frame = JSON.parse(data.toString());
            // This recognizes only the fixed qualification command. It is not
            // a production classifier for whether an arbitrary shell is safe.
            if (turnId && frame.method === "process/start" && JSON.stringify(frame.params).includes("cat marker.txt") && !receipt.refusedBeforeDispatch) {
              receipt.refusedBeforeDispatch = true;
              const heldAt = modelRequests;
              await selectCloud();
              await delay(100);
              assert.equal(modelRequests, heldAt, "Model progressed while the tool result was withheld");
              receipt.noProgressWhileHeld = true;
              incoming.send(JSON.stringify({ id: frame.id, error: { code: -32000,
                message: "Fixture executor unavailable; command refused before dispatch" } }));
              return;
            }
            if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
            else queued.push(data.toString());
          } catch (error) { abort.abort(error); incoming.terminate(); }
        });
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      url = `ws://127.0.0.1:${server.address().port}`;
    }
    return { environmentId: name, execServerUrl: url, authBearerToken: token, connectTimeoutMs: 10000 };
  }

  function emit(response, type, body) {
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
  }
  const model = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    let body = "";
    request.on("data", data => { body += data; if (body.length > 4 * 1024 * 1024) request.destroy(); });
    request.on("error", error => abort.abort(error));
    request.on("end", async () => {
      try {
        const input = JSON.parse(body), index = ++modelRequests;
        requests.push(input);
        await save(join(directory, `model-request-${index}.json`), input);
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        emit(response, "response.created", { response: { id: `response-${index}`, status: "in_progress", output: [] } });
        if (index === 1) {
          await waitFor(() => turnId, "Turn startup");
          if (mode === "captured-step") await selectCloud();
        }
        assert(input.tools.some(tool => tool.name === "exec_command"), "Native exec_command was not offered");
        const item = [1, 2, 4].includes(index)
          ? { id: `call-${index}`, type: "function_call", call_id: `call-${index}`, name: "exec_command",
              arguments: JSON.stringify({ cmd: "cat marker.txt", yield_time_ms: 10000, max_output_tokens: 200 }) }
          : { id: `message-${index}`, type: "message", role: "assistant", status: "completed",
              content: [{ type: "output_text", text: "Fixture complete.", annotations: [] }] };
        emit(response, "response.output_item.done", { output_index: 0, item });
        emit(response, "response.completed", { response: { id: `response-${index}`, status: "completed", output: [item],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        response.end();
      } catch (error) { abort.abort(error); response.destroy(); }
    });
  });

  try {
    receipt.providerVersion = await version(appServer);
    receipt.executorVersion = await version(values.codex);
    await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
    // Only the fixed fixture command runs, against the disposable roots above.
    // This configuration belongs only to the disposable fixture HOME.
    await writeFile(join(paths.home, "config.toml"), `model = "gpt-5.1-codex"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "danger-full-access"
[analytics]
enabled = false
[feedback]
enabled = false
[model_providers.fixture]
name = "Fixture"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
`, { mode: 0o600 });
    const laptop = await executor("laptop"), cloud = await executor("cloud");
    const app = child(appServer, ["--listen", "stdio://"], paths.host);
    createInterface({ input: app.process.stdout }).on("line", line => {
      try {
        const message = JSON.parse(line);
        if (message.method) events.push(message);
        else pending.get(message.id)?.resolve(message);
      } catch (error) { abort.abort(error); }
    });
    call = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextRequestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out; the request was not retried`));
      }, 20000);
      pending.set(id, { reject, timer, resolve: response => { clearTimeout(timer); pending.delete(id); resolve(response); } });
      app.process.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
        if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    });
    result(await call("initialize", { clientInfo: { name: "infinite_handoff_qualification", version: "0.1.0" }, capabilities: { experimentalApi: true } }));
    app.process.stdin.write('{"method":"initialized"}\n');
    assert.equal(result(await call("server/diagnostics", {})).executionEnvironmentUpdates, 1, "Provider handoff capability is missing");
    for (const environment of [laptop, cloud]) result(await call("environment/add", environment));
    threadId = result(await call("thread/start", { cwd: paths.laptop, ephemeral: true, environments: selection("laptop"),
      baseInstructions: "Fixture boundary probe. Read marker.txt twice and report the results. Follow repository AGENTS.md." })).thread.id;
    turnId = result(await call("turn/start", { threadId, input: [{ type: "text", text: "Read the current marker using the shell." }] })).turn.id;
    const completion = await waitFor(() => events.find(event => event.method === "turn/completed"), "Turn completion");
    assert.equal(completion.params.turn.status, "completed");
    assert.equal(events.filter(event => event.method === "turn/started").length, 1, "Qualification started another turn");
    assert.equal(modelRequests, 3);
    assert(JSON.stringify(requests[0]).includes("Environment marker: LAPTOP_MARKER"), "First step missed laptop instructions");
    assert(JSON.stringify(requests[1]).includes("Environment marker: CLOUD_MARKER"), "Next step missed destination instructions");
    const outputs = requests.map(request => request.input.filter(item => item.type === "function_call_output").map(item => JSON.stringify(item.output)));
    if (mode === "captured-step") {
      assert(outputs[1].some(output => output.includes("LAPTOP_MARKER")), "Already-captured command was retargeted");
      receipt.oldCaptureStayedOnLaptop = true;
    } else {
      assert(receipt.refusedBeforeDispatch && receipt.noProgressWhileHeld);
      assert(outputs[1].some(output => output.includes("refused before dispatch")), "Provider missed the determinate refusal");
      assert(!outputs[1].some(output => output.includes("LAPTOP_MARKER")), "Refused command ran on the laptop");
    }
    assert(outputs[2].some(output => output.includes("CLOUD_MARKER")), "Next command missed the cloud executor");
    Object.assign(receipt, { sameTurn: true, firstInstructionsFromLaptop: true, nextInstructionsFromCloud: true,
      nextToolAtCloud: true, completed: true });
    const followupId = result(await call("turn/start", { threadId, input: [{ type: "text", text: "Read the current marker again." }] })).turn.id;
    const followup = await waitFor(() => events.find(event => event.method === "turn/completed" && event.params.turn.id === followupId), "Follow-up completion");
    assert.equal(followup.params.turn.status, "completed");
    assert.equal(modelRequests, 5);
    assert(JSON.stringify(requests[3]).includes("Environment marker: CLOUD_MARKER"), "Future turn lost cloud instructions");
    const followupOutput = requests[4].input.filter(item => item.type === "function_call_output").map(item => JSON.stringify(item.output));
    assert(followupOutput.some(output => output.includes("CLOUD_MARKER")), "Future turn lost cloud execution");
    receipt.nextTurnAtCloud = true;
  } catch (error) {
    failure = error;
    receipt.error = error instanceof Error ? error.message : String(error);
  } finally {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Qualification stopped")); }
    pending.clear();
    for (const socket of peers) socket.terminate();
    for (const { server, sockets } of proxies) { sockets.close(); server.closeAllConnections(); server.close(); }
    model.closeAllConnections(); model.close();
    await Promise.all(children.map(async state => {
      if (state.process.exitCode === null && state.process.signalCode === null) {
        state.process.kill("SIGTERM");
        const timer = setTimeout(() => state.process.kill("SIGKILL"), 3000);
        await state.exited;
        clearTimeout(timer);
      }
    }));
    await save(join(directory, "receipt.json"), receipt);
    await save(join(directory, "provider-errors.json"), children.map(state => state.stderr));
  }
  if (failure) throw failure;
  return receipt;
}

try {
  const receipts = [];
  for (const mode of ["captured-step", "refused-operation"]) receipts.push(await runScenario(mode));
  await save(join(output, "receipt.json"), { status: "qualified-narrow-boundary", receipts,
    limits: ["same operating system", "single native command", "no uncertain effect", "no persistent checkpoint or general process fence"] });
  console.log("Passed: first-step laptop context, preserved old capture, next-step cloud execution, and held determinate refusal in the same turn.");
  console.log("Scope: one native command on the same operating system. General outage recovery and process fencing remain unqualified.");
  console.log(`Private receipts: ${output}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Private evidence: ${output}`);
  process.exitCode = 1;
}
