// Provider HTTP boundary fixture; real native UI commissioning is separate.
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { writeFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2), value = key => args[args.indexOf(key) + 1];
if (args.includes("--help")) { console.error("--session --password"); process.exit(0); }
const authorization = `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
if (args.includes("serve")) {
  let session; const messages = [], streams = new Set();
  const emit = payload => { for (const res of streams) res.write(`data: ${JSON.stringify(res.global ? { directory: process.cwd(), payload } : payload)}\n\n`); };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== authorization) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url, "http://127.0.0.1"), path = url.pathname;
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    appendFileSync("opencode-requests.jsonl", JSON.stringify({ method: req.method, path, body, directory: url.searchParams.get("directory") }) + "\n");
    const reply = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(data === undefined ? undefined : JSON.stringify(data)); };
    if (path === "/session" && req.method === "POST") { session = { id: "ses_" + randomUUID().replaceAll("-", ""), title: body.title }; reply(session); }
    else if (path === "/event" || path === "/global/event") {
      res.global = path === "/global/event"; streams.add(res); res.writeHead(200, { "Content-Type": "text/event-stream" });
      emit({ type: "server.connected", properties: {} });
      emit({ type: "message.updated", properties: { info: { id: "foreign", sessionID: "ses_foreign", role: "assistant" } } });
      res.on("close", () => streams.delete(res));
    } else if (path === "/session") reply([session, { id: "ses_foreign" }]);
    else if (path === "/session/status") reply({ [session.id]: { type: "idle" }, ses_foreign: { type: "busy" } });
    else if (path === "/permission") reply([{ id: "per_current", sessionID: session.id }, { id: "per_foreign", sessionID: "ses_foreign" }]);
    else if (path === "/permission/per_current/reply") { writeFileSync("opencode-approval.json", JSON.stringify(body)); emit({ type: "permission.replied", properties: { sessionID: session.id, requestID: "per_current" } }); reply(true); }
    else if (path === `/session/${session.id}/message`) reply(messages);
    else if (path === `/session/${session.id}`) reply(session);
    else if (path === `/session/${session.id}/prompt_async`) {
      const text = body.parts[0].text; messages.push({ info: { role: "user", sessionID: session.id }, parts: [{ type: "text", text }] });
      reply(undefined, 204); emit({ type: "session.status", properties: { sessionID: session.id, status: { type: "busy" } } });
      if (text === "approval") { emit({ type: "permission.asked", properties: { id: "per_current", sessionID: session.id, permission: "bash" } }); return; }
      const messageID = randomUUID();
      emit({ type: "message.updated", properties: { info: { id: messageID, sessionID: session.id, role: "assistant" } } });
      setTimeout(() => {
        writeFileSync("opencode-work-complete", text);
        const part = { type: "text", text: `Reply to ${text}`, messageID, sessionID: session.id };
        messages.push({ info: { role: "assistant", sessionID: session.id }, parts: [part] });
        emit({ type: "message.part.updated", properties: { part } });
        emit({ type: "session.status", properties: { sessionID: session.id, status: { type: "idle" } } });
      }, text === "delayed work" ? 1500 : 20);
    } else reply({});
  });
  server.listen(0, "127.0.0.1", () => { writeFileSync("opencode-pid", String(process.pid)); console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`); });
} else {
  const base = args[args.indexOf("attach") + 1], id = value("--session");
  const request = (path, body) => fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: authorization, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const session = await (await request(`/session/${id}`)).json();
  if (session.id !== id) process.exit(1);
  writeFileSync("opencode-client.json", JSON.stringify({ args, tokenHash: createHash("sha256").update(process.env.OPENCODE_SERVER_PASSWORD).digest("hex") }));
  const history = await (await request(`/session/${id}/message`)).json();
  console.log(JSON.stringify(history)); console.log("LOCAL OPENCODE READY");
  const events = await request("/event");
  void (async () => { for await (const chunk of events.body) process.stdout.write(new TextDecoder().decode(chunk)); })();
  process.stdin.setRawMode(true); process.stdout.write("\x1b[?2004h"); let input = "";
  process.stdin.on("data", data => {
    input += data.toString().replace(/\x1b\[20[01]~/g, "");
    if (input.includes("\r")) { void request(`/session/${id}/prompt_async`, { parts: [{ type: "text", text: input.split("\r")[0] }] }); input = ""; }
  });
}
