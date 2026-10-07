// Provider-boundary fixture. Real Codex commissioning is a separate manual check.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (args.includes("--help")) { console.log("--remote --remote-auth-token-env"); process.exit(0); }
if (args[0] === "app-server") {
  const expectedHash = option("--ws-token-sha256");
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const history = [];
  let threadId;
  const foreignId = randomUUID();
  const broadcast = message => { for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); };
  const thread = () => ({ id: threadId, turns: history.map(text => ({ text })) });
  http.on("upgrade", (req, socket, head) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (createHash("sha256").update(token).digest("hex") !== expectedHash) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upgrade = () => {
      if (socket.destroyed) return;
      if (existsSync("hold-upgrades")) { writeFileSync("upgrade-held", "held"); setTimeout(upgrade, 10); return; }
      wss.handleUpgrade(req, socket, head, client => {
      client.on("error", () => {});
      client.on("message", data => {
        const message = JSON.parse(data.toString());
        const { method, params, id } = message;
        if (method) appendFileSync("provider-requests.jsonl", JSON.stringify({ method, params }) + "\n");
        const reply = result => client.send(JSON.stringify({ id, result }));
        if (method === "initialize") reply({ userAgent: "native-fixture" });
        else if (method === "thread/start") { threadId = randomUUID(); reply({ thread: thread() }); }
        else if (method === "thread/read" || method === "thread/resume") reply({ thread: thread(), pid: process.pid });
        else if (method === "thread/list") reply({ data: [thread(), { id: foreignId }], nextCursor: "next" });
        else if (method === "thread/loaded/list") reply({ data: [threadId, foreignId] });
        else if (method === "turn/start") {
          const text = params.input.map(item => item.text ?? "").join(""); history.push(text);
          reply({ turn: { id: randomUUID(), status: "inProgress" } });
          broadcast({ method: "turn/started", params: { threadId } });
          broadcast({ method: "item/completed", params: { threadId, item: { text } } });
          if (text === "work") setTimeout(() => { writeFileSync("work-complete", "done"); broadcast({ method: "turn/completed", params: { threadId } }); }, 1200);
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
      if (resuming) console.log("LOCAL NATIVE READY");
      else call("turn/start", { threadId, input: [{ type: "text", text: args.at(-1) }] });
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
    input += data.toString().replace(/\x1b\[20[01]~/g, "");
    if (input.includes("\r") && threadId) { call("turn/start", { threadId, input: [{ type: "text", text: input.split("\r")[0] }] }); input = ""; }
  });
  process.stdout.write("\x1b[?2004h");
}
