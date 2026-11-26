import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const [kind, delay, target] = process.argv.slice(2);
const answers = delay !== "never";
const say = line => process.stdout.write(line + "\n");
const later = action => { say("request"); if (answers) setTimeout(action, Number(delay)); };
const listening = server => server.listen(0, "127.0.0.1", () => say(`port ${server.address().port}`));

if (kind === "httpstream") {
  const chunk = Buffer.alloc(1024 * 1024, "x");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => later(() => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.write(chunk);
      setTimeout(() => { res.write(chunk); setTimeout(() => res.end(chunk), 100); }, 100);
    }));
  });
  listening(server);
} else if (kind === "catalog") {
  const socket = new WebSocket(`ws://127.0.0.1:${target}`);
  socket.on("message", data => {
    const frame = Buffer.from(data);
    later(() => {
      const ack = Buffer.alloc(8);
      ack.writeUInt32BE(frame.readUInt32BE(0), 0);
      ack.writeUInt32BE(frame.readUInt32BE(4) + frame.length - 12, 4);
      socket.send(ack);
    });
  });
} else if (kind === "http") {
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
