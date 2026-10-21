// Provider-boundary fixture. Real Codex commissioning is a separate manual check.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (args.includes("--help")) { console.log("--remote --remote-auth-token-env --ws-token-sha256 --ws-auth"); process.exit(0); }
if (args[0] === "exec-server") {
  const server = createServer(), sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (req.headers.origin || createHash("sha256").update(token).digest("hex") !== option("--ws-token-sha256")) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    sockets.handleUpgrade(req, socket, head, client => {
      client.on("error", () => {});
      client.on("message", data => {
        const request = JSON.parse(data.toString());
        if (request.method === "fixture/read-write") {
          const contents = readFileSync("marker.txt", "utf8");
          appendFileSync("agent-edit.txt", contents + "\n");
          client.send(JSON.stringify({ id: request.id, result: { contents, cwd: process.cwd() } }));
        } else if (request.method === "fixture/uncertain-edit") {
          // An observable effect without a reply exercises the real broker's
          // uncertain-operation guard. The fixture never supplies its decision.
          appendFileSync("uncertain-effect.txt", "performed\n");
        } else client.send(JSON.stringify({ id: request.id, result: { cwd: pathToFileURL(process.cwd()).href } }));
      });
    });
  });
  server.listen(0, "127.0.0.1", () => {
    writeFileSync("executor-pid", String(process.pid));
    console.log(`listening on: ws://127.0.0.1:${server.address().port}`);
  });
} else if (args[0] === "app-server") {
  const expectedHash = option("--ws-token-sha256");
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const history = [];
  let threadId, activeTurn, selections, activeSelections, releaseHeldTurn, replayCompletedTurn;
  const environments = new Map();
  const execute = (environmentId, method) => new Promise((resolve, reject) => {
    const environment = environments.get(environmentId);
    const ws = new WebSocket(environment.execServerUrl, { headers: { Authorization: `Bearer ${environment.authBearerToken}` } });
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method })));
    ws.on("message", data => {
      const response = JSON.parse(data.toString());
      if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
      ws.close();
    });
  });
  const foreignId = randomUUID();
  const broadcast = message => { for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); };
  const thread = () => ({ id: threadId, turns: history.map(text => ({ text })), ...(selections ? { environments: selections, cwd: selections[0].cwd } : {}) });
  http.on("upgrade", (req, socket, head) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (createHash("sha256").update(token).digest("hex") !== expectedHash) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upgrade = () => {
      if (socket.destroyed) return;
      if (existsSync("hold-upgrades")) { writeFileSync("upgrade-held", "held"); setTimeout(upgrade, 10); return; }
      wss.handleUpgrade(req, socket, head, client => {
      client.on("error", () => {});
      let clientName;
      client.on("message", async data => {
        const message = JSON.parse(data.toString());
        const { method, params, id } = message;
        if (method) appendFileSync("provider-requests.jsonl", JSON.stringify({ method, params }) + "\n");
        const reply = result => client.send(JSON.stringify({ id, result }));
        if (method === "initialize") { clientName = params?.clientInfo?.name; reply({ userAgent: "native-fixture" }); }
        else if (method === "server/diagnostics") reply({ executionEnvironmentUpdates: 1 });
        else if (method === "environment/add") {
          environments.set(params.environmentId, params); reply({});
          if (clientName === "infinite_execution" && replayCompletedTurn) {
            const replay = { threadId, turnId: replayCompletedTurn };
            // Delay this connection's copy until selection registration; the
            // persistent observer has already recorded this turn's completion.
            client.send(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: replay.turnId, status: "inProgress" } } }));
            client.send(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: replay.turnId, status: "completed" } } }));
            writeFileSync("provider-lifecycle-replay.json", JSON.stringify(replay));
            replayCompletedTurn = undefined;
          }
        }
        else if (method === "environment/info") reply(await execute(params.environmentId, "fixture/info"));
        else if (method === "thread/start") {
          threadId = randomUUID(); selections = params.environments;
          reply({ thread: thread() }); broadcast({ method: "thread/started", params: { thread: thread() } });
        }
        else if (method === "thread/settings/update") { if (params.environments) selections = params.environments; reply({}); }
        else if (method === "fixture/release-turn") {
          const release = releaseHeldTurn;
          if (!release) { reply({ released: false }); return; }
          releaseHeldTurn = undefined; release(); reply({ released: true });
        }
        else if (method === "turn/settings/update") {
          if (params.turnId !== activeTurn) reply({ status: "targetUnavailable" });
          else { if (params.environments) activeSelections = params.environments; reply({ status: "applied" }); }
        }
        else if (method === "thread/read" || method === "thread/resume") reply({ thread: thread(), pid: process.pid });
        else if (method === "thread/list") reply({ data: [thread(), { id: foreignId }], nextCursor: "next" });
        else if (method === "thread/loaded/list") reply({ data: [threadId, foreignId] });
        // Real provider plugin catalogs can exceed 12 MB before a turn starts.
        else if (method === "plugin/list") reply({ catalog: "a".repeat(13 * 1024 * 1024) });
        else if (method === "turn/start") {
          const text = params.input.map(item => item.text ?? "").join(""); history.push(text);
          const turnId = randomUUID(); activeTurn = turnId; activeSelections = params.environments ?? selections;
          const complete = (status = "completed", error) => {
            if (activeTurn === turnId) activeTurn = undefined;
            broadcast({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, ...(error ? { error } : {}) } } });
          };
          reply({ turn: { id: turnId, status: "inProgress" } });
          broadcast({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
          broadcast({ method: "item/completed", params: { threadId, item: { text } } });
          if (["workspace edit", "workspace edit held", "uncertain edit"].includes(text) && activeSelections?.length) {
            try {
              const result = await execute(activeSelections[0].environmentId, text === "uncertain edit" ? "fixture/uncertain-edit" : "fixture/read-write");
              broadcast({ method: "item/completed", params: { threadId, item: { text: result.contents } } });
              if (text === "workspace edit held") await new Promise(resolve => {
                releaseHeldTurn = resolve;
                broadcast({ method: "fixture/turn-held", params: { threadId, turnId } });
              });
              if (text === "workspace edit held") replayCompletedTurn = turnId;
              complete();
            } catch { complete("failed"); }
          }
          if (text === "usage-limit") complete("failed", { codexErrorInfo: "usageLimitExceeded" });
          if (text === "rate-limit-transient") complete("failed", { codexErrorInfo: "rateLimitExceeded" });
          if (text === "work") setTimeout(() => { writeFileSync("work-complete", "done"); complete(); }, 1200);
          if (text === "approval") broadcast({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId, command: "fixture" } });
        } else if (!method && id === "approval") writeFileSync("approval-result.json", JSON.stringify(message));
        else if (id !== undefined) reply({});
      });
      });
    };
    upgrade();
  });
  http.listen(0, "127.0.0.1", () => {
    writeFileSync("provider-pid", String(process.pid));
    console.log(`listening on: ws://127.0.0.1:${http.address().port}`);
  });
} else {
  const resuming = args.includes("resume");
  const prompt = args.includes("--") ? args[args.indexOf("--") + 1] : undefined;
  if (resuming) writeFileSync("native-client.json", JSON.stringify({ args, tokenHash: createHash("sha256").update(process.env[option("--remote-auth-token-env")] ?? "").digest("hex") }));
  const ws = new WebSocket(option("--remote"), { headers: { Authorization: `Bearer ${process.env[option("--remote-auth-token-env")]}` } });
  let threadId, next = 10;
  const call = (method, params) => ws.send(JSON.stringify({ id: next++, method, params }));
  ws.on("open", () => call("initialize", { clientInfo: { name: "fixture", version: "1" } }));
  ws.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.id === 10) { ws.send(JSON.stringify({ method: "initialized" })); call(resuming ? "thread/resume" : "thread/start", resuming ? { threadId: args.at(-1) } : {}); }
    if (message.id === 11) {
      threadId = message.result.thread.id;
      if (resuming) call("plugin/list", {});
      else if (prompt !== undefined) call("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
    }
    if (resuming && message.id === 12) {
      writeFileSync("native-catalog.json", JSON.stringify({ bytes: message.result.catalog.length }));
      console.log("LOCAL NATIVE READY");
    }
    if (message.method === "item/completed") console.log(message.params.item.text);
    if (message.method === "turn/completed") setTimeout(() => console.log("Observer redraw after turn completed"), 80);
    if (message.method === "item/commandExecution/requestApproval") console.log("Approval requested; awaiting explicit input");
  });
  ws.on("error", () => process.exit(1));
  ws.on("close", () => process.exit(0));
  process.stdin.setRawMode(true);
  let input = "";
  process.stdin.on("data", data => {
    if (resuming && data.toString() === "\x04") process.exit(0);
    if (resuming && data.toString() === "\x18") process.kill(process.pid, "SIGKILL");
    input += data.toString().replace(/\x1b\[20[01]~/g, "");
    if (input.includes("\r") && threadId) { call("turn/start", { threadId, input: [{ type: "text", text: input.split("\r")[0] }] }); input = ""; }
  });
  // A native TUI can exit without cleaning up its terminal modes.
  process.stdout.write("\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?25l");
}
