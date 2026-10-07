import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { request } from "node:http";
import { spawn, type IPty } from "node-pty";
import { startHost, waitFor, claimControl } from "./helpers.js";

const fixture = resolve("tests/fixtures/native-opencode.mjs");
test("OpenCode HTTP attachment pins context and fences delayed writes and approvals across takeover", { timeout: 30000 }, async () => {
  const host = await startHost({ agents: { opencode: { command: process.execPath, args: [fixture] } } });
  const id = randomUUID(), path = `/sessions/${id}`, workspace = host.config.projects[0].path;
  try {
    assert.notEqual((await host.fetchApi("/sessions", "owner", { requestId: randomUUID(), provider: "opencode", title: "Invalid", projectId: "rehearsal", localUi: true, nativeArgs: ["--fork"] })).status, 201);
    assert.equal((await host.fetchApi("/sessions", "owner", { requestId: id, provider: "opencode", title: "Native OpenCode", projectId: "rehearsal", localUi: true, nativeArgs: [] })).status, 201);
    const info = await waitFor(async () => (await host.fetchApi(path + "/native")).body, body => !!body?.sessionId);
    const pid = readFileSync(workspace + "/opencode-pid", "utf8");
    const owner = await claimControl(host, id, "owner");
    const api = (route: string, body?: unknown, headers = owner.headers, role: "owner" | "controller" | "viewer" = "owner") => host.fetchApi(path + "/opencode" + route, role, body, headers);
    for (const role of ["controller", "viewer"] as const) assert.equal((await api("/session", undefined, owner.headers, role)).status, 403);
    assert.equal((await api("/session", undefined, { ...owner.headers, Origin: host.origin })).status, 403);
    assert.deepEqual((await api("/session")).body.map((s: any) => s.id), [info.sessionId]);
    assert.deepEqual(Object.keys((await api("/session/status")).body), [info.sessionId]);
    assert.equal((await api("/session/ses_foreign")).status, 403);
    assert.equal((await api("/session", {})).status, 403);
    assert.equal((await api(`/session/${info.sessionId}/fork`, {})).status, 403);
    assert.equal((await api("/instance/dispose", {})).status, 403);
    assert.equal((await api("/permission/per_foreign/reply", { reply: "once" })).status, 403);
    assert.deepEqual((await api("/permission")).body.map((p: any) => p.id), ["per_current"]);
    assert.equal((await api("/path?directory=%2Ffixture%2Fother&workspace=foreign")).status, 200);
    const prompt = await fetch(host.origin + "/api" + path + `/opencode/session/${info.sessionId}/prompt_async`, { method: "POST", headers: { Authorization: `Bearer ${host.tokens.owner}`, ...owner.headers, "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "approval" }] }) });
    assert.equal(prompt.status, 204);
    const attention = await waitFor(async () => (await host.fetchApi(path)).body.attention, a => a.state === "needs-you");
    assert.equal(attention.prompt.source, "protocol");
    assert.deepEqual(attention.prompt.options, [], "compact choices require a verified native dialog mapping");
    assert.equal(existsSync(workspace + "/opencode-approval.json"), false);
    const events = await fetch(host.origin + "/api" + path + "/opencode/global/event", { headers: { Authorization: `Bearer ${host.tokens.owner}`, ...owner.headers } });
    assert.equal(events.status, 200); const reader = events.body!.getReader();
    assert.ok(!new TextDecoder().decode((await reader.read()).value).includes("ses_foreign"));
    await reader.cancel();
    // Start sending a body, then change control before the request is complete.
    const slow = request(host.origin + "/api" + path + `/opencode/session/${info.sessionId}/prompt_async`, { method: "POST", headers: { Authorization: `Bearer ${host.tokens.owner}`, ...owner.headers, "Content-Type": "application/json" } });
    const response = new Promise<number>(resolve => slow.on("response", res => { res.resume(); resolve(res.statusCode!); }));
    slow.write('{"parts":[');
    const phone = await claimControl(host, id, "controller", { takeover: true });
    slow.end('{"type":"text","text":"stale"}]}'); assert.notEqual(await response, 200);
    assert.notEqual((await api("/permission/per_current/reply", { reply: "once" })).status, 200);
    assert.equal(existsSync(workspace + "/opencode-approval.json"), false);
    assert.equal((await host.fetchApi(path + "/input", "controller", { requestId: randomUUID(), text: "phone follow-up", submit: true }, phone.headers)).status, 200);
    await waitFor(async () => (await host.fetchApi(path)).body.attention, a => a.lastMessage === "Reply to phone follow-up");
    const next = await claimControl(host, id, "owner", { takeover: true });
    const history = (await api(`/session/${info.sessionId}/message`, undefined, next.headers)).body;
    assert.deepEqual(history.filter((m: any) => m.info.role === "user").map((m: any) => m.parts[0].text), ["approval", "phone follow-up"]);
    const accepted = await fetch(host.origin + "/api" + path + `/opencode/session/${info.sessionId}/prompt_async`, { method: "POST", headers: { Authorization: `Bearer ${host.tokens.owner}`, ...next.headers, "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "delayed work" }] }) });
    assert.equal(accepted.status, 204);
    await host.stopApi();
    await waitFor(async () => readFileSync(workspace + "/opencode-work-complete", "utf8"), text => text === "delayed work");
    await host.start();
    assert.equal((await host.fetchApi(path + "/native")).body.sessionId, info.sessionId);
    assert.equal(readFileSync(workspace + "/opencode-pid", "utf8"), pid);
    const calls = readFileSync(workspace + "/opencode-requests.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.filter(c => c.method === "POST" && c.path === "/session").length, 1);
    assert.ok(calls.every(c => realpathSync(c.directory) === realpathSync(workspace)));
    assert.equal((await host.fetchApi(path)).body.attention.source, "protocol");
  } finally { await host.stop(); }
});

test("OpenCode CLI uses a local credential and rejoins history without starting another server", { timeout: 25000 }, async () => {
  const host = await startHost({ agents: { opencode: { command: process.execPath, args: [fixture] } } });
  const children: IPty[] = [];
  try {
    const bin = host.root + "/bin"; mkdirSync(bin);
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(bin + "/opencode", `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
    const config = host.root + "/client.json"; writeFileSync(config, JSON.stringify({ origin: host.origin, token: host.tokens.owner }), { mode: 0o600 });
    const launch = (args: string[]) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/client-entry.ts"), "--client-config", config, ...args], { cols: 120, rows: 32, cwd: host.root, env: { ...process.env, PATH: bin + ":" + process.env.PATH } });
      children.push(child); let text = "", exited = false; child.onData(data => text += data); child.onExit(() => exited = true); return { child, text: () => text, exited: () => exited };
    };
    const first = launch(["--local-ui", "opencode"]);
    await waitFor(async () => first.text(), text => text.includes("LOCAL OPENCODE READY"));
    const sessions = (await host.fetchApi("/sessions")).body.sessions; assert.equal(sessions.length, 1);
    const id = sessions[0].id, info = (await host.fetchApi(`/sessions/${id}/native`)).body;
    const local = JSON.parse(readFileSync(host.root + "/opencode-client.json", "utf8"));
    assert.notEqual(local.tokenHash, createHash("sha256").update(host.tokens.owner).digest("hex"));
    assert.ok(!JSON.stringify(local.args).includes(host.tokens.owner));
    assert.equal(new URL(local.args[local.args.indexOf("attach") + 1]).hostname, "127.0.0.1");
    assert.equal((await fetch(local.args[local.args.indexOf("attach") + 1] + "/session")).status, 403);
    first.child.write("local follow-up\r");
    await waitFor(async () => (await host.fetchApi(`/sessions/${id}`)).body.attention, a => a.lastMessage === "Reply to local follow-up");
    first.child.kill("SIGTERM"); await waitFor(async () => first.exited(), Boolean);
    const second = launch(["resume", id]);
    await waitFor(async () => second.text(), text => text.includes("LOCAL OPENCODE READY") && text.includes("local follow-up"));
    assert.equal((await host.fetchApi(`/sessions/${id}/native`)).body.sessionId, info.sessionId);
    assert.equal((await host.fetchApi("/sessions")).body.sessions.length, 1);
  } finally { for (const child of children) { try { child.kill("SIGKILL"); } catch {} } await host.stop(); }
});
