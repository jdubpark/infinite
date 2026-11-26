import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const [kind, delay] = process.argv.slice(2);
const answers = delay !== "never";
const say = line => process.stdout.write(line + "\n");
const later = action => { say("request"); if (answers) setTimeout(action, Number(delay)); };
const listening = server => server.listen(0, "127.0.0.1", () => say(`port ${server.address().port}`));

if (kind === "http") {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => later(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }));
  });
  listening(server);
} else {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", socket => {
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      if (kind === "codex") {
        if (message.method === "thread/read") later(() => socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "thread-1", environments: [] } } })));
        else if (typeof message.id === "number") socket.send(JSON.stringify({ id: message.id, result: {} }));
      } else if (message.op === "raw" || message.op === "input") later(() => socket.send(JSON.stringify({ receipt: { requestId: message.requestId, state: "delivered" } })));
      else if (message.op === "control") later(() => socket.send(JSON.stringify({ requestId: message.requestId, control: null })));
    });
  });
  listening(server);
}
