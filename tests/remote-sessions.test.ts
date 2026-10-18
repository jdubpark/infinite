import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimControl, startHost, waitFor } from "./helpers.js";
import { readConfig, hashToken } from "../packages/host/src/config.js";

test("machine setup persists private device and relay registrations without disclosing keys", () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-machine-setup-"));
  const configFile = join(root, "config.json"), relayFile = join(root, "relay.json");
  const project = join(root, "project"), additional = join(root, "additional");
  mkdirSync(project); mkdirSync(additional);
  const cli = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", "packages/host/src/cli.ts", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    for (const [index, name] of ["   ", "x".repeat(81)].entries()) {
      const invalidRoot = join(root, `invalid-${index}`);
      const args = ["--config", join(invalidRoot, "config.json"), "--state-dir", join(invalidRoot, "state"), "--run-dir", join(invalidRoot, "run"), "--project", project];
      assert.throws(() => cli("init", "--local", "--name", name, ...args));
      assert.equal(existsSync(invalidRoot), false, "invalid init labels must not leave keys or directories behind");
      cli("init", "--local", "--name", " Corrected machine ", ...args);
      assert.equal(readConfig(join(invalidRoot, "config.json")).config.machine!.label, "Corrected machine");
    }
    cli("init", "--local", "--remote", "--name", "Test machine", "--project", project, "--config", configFile, "--state-dir", join(root, "state"), "--run-dir", join(root, "run"));
    const initial = readConfig(configFile).config;
    const info = JSON.parse(cli("machine-info", "--config", configFile));
    assert.equal(info.id, initial.machine!.id);
    const phoneKey = join(root, "phone.key");
    const unchanged = readFileSync(configFile, "utf8");
    for (const name of ["   ", "x".repeat(81)]) {
      assert.throws(() => cli("device-add", "--name", name, "--token-file", phoneKey, "--config", configFile));
      assert.equal(existsSync(phoneKey), false, "validation must precede writing the new device key");
      assert.equal(readFileSync(configFile, "utf8"), unchanged);
    }
    const output = cli("device-add", "--role", "owner", "--name", "Phone", "--token-file", phoneKey, "--config", configFile);
    const token = readFileSync(phoneKey, "utf8").trim();
    assert.ok(!output.includes(token));
    assert.equal(statSync(phoneKey).mode & 0o077, 0);
    const added = readConfig(configFile).config.tokens.find(device => device.hash === hashToken(token))!;
    assert.equal(added.role, "owner");
    cli("device-revoke", added.id, "--config", configFile);
    assert.ok(!readConfig(configFile).config.tokens.some(device => device.id === added.id));
    assert.throws(() => cli("device-revoke", initial.tokens.find(device => device.role === "owner")!.id, "--config", configFile));
    cli("project-add", "additional", additional, "--config", configFile);
    cli("relay-init", "--config", relayFile);
    const registration = join(root, "registration.key");
    cli("relay-add", "--machine", info.id, "--token-file", registration, "--config", relayFile);
    cli("connect-relay", "http://127.0.0.1:4790", "--token-file", registration, "--config", configFile);
    const final = readConfig(configFile).config;
    assert.equal(final.machine!.id, initial.machine!.id);
    assert.equal(final.projects.at(-1)!.path, additional);
    assert.equal(final.remote!.relay!.tokenFile, registration);
    assert.equal(statSync(configFile).mode & 0o077, 0);
    assert.equal(statSync(relayFile).mode & 0o077, 0);
    assert.throws(() => cli("connect-relay", "http://relay.example.com", "--token-file", registration, "--config", configFile));
    assert.equal(readConfig(configFile).config.remote!.relay!.url, "http://127.0.0.1:4790", "invalid configuration never replaces the working pairing");
    const fullRelay = JSON.parse(readFileSync(relayFile, "utf8"));
    fullRelay.registrations = Array.from({ length: 256 }, () => ({ machineId: randomUUID(), tokenHash: hashToken(randomUUID()) }));
    writeFileSync(relayFile, JSON.stringify(fullRelay), { mode: 0o600 });
    const fullConfig = readFileSync(relayFile, "utf8"), overflowKey = join(root, "overflow.key");
    assert.throws(() => cli("relay-add", "--machine", randomUUID(), "--token-file", overflowKey, "--config", relayFile));
    assert.equal(readFileSync(relayFile, "utf8"), fullConfig, "a full relay retains its valid configuration");
    assert.equal(existsSync(overflowKey), false, "a rejected registration does not orphan a key");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two registered machines create and steer independently, with scoped file previews and recorded chat", async () => {
  const hosts = await Promise.all([startHost(), startHost()]);
  try {
    const machines = await Promise.all(hosts.map(host => host.fetchApi("/me")));
    assert.notEqual(machines[0].body.machine.id, machines[1].body.machine.id);
    const identity = machines[0].body.machine.id;
    await hosts[0].stopApi(); await hosts[0].start();
    assert.equal((await hosts[0].fetchApi("/me")).body.machine.id, identity);
    const requestId = randomUUID();
    const request = { requestId, provider: "demo", backend: "infinite", projectId: "rehearsal", title: "Remote task", prompt: "Initial request" };
    const invalid = await hosts[0].fetchApi("/sessions", "owner", { ...request, title: "   " });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "invalid-create", "clients can distinguish a schema rejection from uncertain delivery");
    assert.equal((await hosts[0].fetchApi("/sessions")).body.sessions.length, 0);
    assert.equal((await hosts[0].fetchApi("/sessions", "controller", request)).status, 403);
    assert.equal((await hosts[0].fetchApi("/sessions", "viewer", request)).status, 403);
    const created = await Promise.all(hosts.map(host => host.fetchApi("/sessions", "owner", request)));
    assert.ok(created.every(result => result.status === 201));
    assert.notEqual(created[0].body.runtime.id, created[1].body.runtime.id);
    const retry = await hosts[0].fetchApi("/sessions", "owner", request);
    assert.equal(retry.body.runtime.id, created[0].body.runtime.id);
    const controls = await Promise.all(hosts.map(host => claimControl(host, requestId, "owner")));
    const input = { requestId: randomUUID(), text: "A delivered follow-up", submit: true };
    const sent = await hosts[0].fetchApi(`/sessions/${requestId}/input`, "owner", input, controls[0].headers);
    assert.equal(sent.body.state, "delivered");
    const refused = await hosts[1].fetchApi(`/sessions/${requestId}/input`, "owner", input, controls[0].headers);
    assert.equal(refused.status, 409);
    const chat = await hosts[0].fetchApi(`/sessions/${requestId}/messages`);
    assert.ok(chat.body.messages.some((m: any) => m.role === "user" && m.text === "A delivered follow-up"));
    assert.ok(!chat.body.messages.some((m: any) => m.role === "assistant"), "PTY output is never fabricated as an assistant message");
    const other = await hosts[1].fetchApi(`/sessions/${requestId}/messages`);
    assert.ok(!other.body.messages.some((m: any) => m.text === input.text));
    const project = hosts[0].config.projects[0].path;
    writeFileSync(join(project, "review.md"), "# Project review\n");
    writeFileSync(join(hosts[0].root, "private.txt"), "outside-project");
    symlinkSync(join(hosts[0].root, "private.txt"), join(project, "escape.txt"));
    const preview = await hosts[0].fetchApi(`/sessions/${requestId}/file?path=review.md`, "viewer");
    assert.equal(preview.body.text, "# Project review\n");
    assert.equal(preview.body.path, "review.md");
    const fifo = join(project, "idle.pipe");
    execFileSync("mkfifo", [fifo]);
    const pendingPreview = hosts[0].fetchApi(`/sessions/${requestId}/file?path=idle.pipe`, "viewer");
    let fifoResult: Awaited<typeof pendingPreview> | "blocked";
    let deadline: ReturnType<typeof setTimeout>;
    try {
      fifoResult = await Promise.race([pendingPreview, new Promise<"blocked">(resolve => { deadline = setTimeout(() => resolve("blocked"), 1500); })]);
    } finally {
      clearTimeout(deadline!);
      // Unblock the pre-fix read after the deadline so this regression cannot
      // leave a libuv worker or the test process hanging on failure.
      try { closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK)); } catch {}
      await pendingPreview;
    }
    assert.notEqual(fifoResult, "blocked", "an idle FIFO must be rejected without waiting for a writer");
    assert.equal((fifoResult as Awaited<typeof pendingPreview>).status, 413);
    assert.equal((await hosts[0].fetchApi(`/sessions/${requestId}/file?path=review.md`, "viewer")).body.text, "# Project review\n");
    for (const path of ["../private.txt", "escape.txt"]) {
      const denied = await hosts[0].fetchApi(`/sessions/${requestId}/file?path=${encodeURIComponent(path)}`);
      assert.equal(denied.status, 403);
      assert.ok(!JSON.stringify(denied.body).includes("outside-project"));
    }
    await hosts[0].stopApi();
    const stillOnline = await hosts[1].fetchApi(`/sessions/${requestId}/input`, "owner", { ...input, requestId: randomUUID(), text: "Cloud continues" }, controls[1].headers);
    assert.equal(stillOnline.body.state, "delivered");
  } finally { await Promise.all(hosts.map(host => host.stop())); }
});

test("native resume converges across devices and API restarts without replaying prompts or uncertain continuations", async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-resume-"));
  const fixture = join(root, "agent.mjs");
  const nativeId = randomUUID();
  writeFileSync(fixture, `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(root, "argv.jsonl"))}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.INFINITE_HOOK_URL) await fetch(process.env.INFINITE_HOOK_URL + '/claude', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.INFINITE_HOOK_TOKEN },
  body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: ${JSON.stringify(nativeId)}, prompt: 'First prompt' })
});
setInterval(() => {}, 1000);
`);
  const host = await startHost({ agents: { claude: { command: process.execPath, args: [fixture] } } });
  try {
    const directory = join(host.config.projects[0].path, "nested"); mkdirSync(directory);
    const initial = { requestId: randomUUID(), provider: "claude", projectId: "rehearsal", cwd: "nested", title: "Resumable", prompt: "NEVER REPLAY THIS PROMPT" };
    const first = await host.fetchApi("/sessions", "owner", initial);
    assert.equal(first.status, 201);
    await waitFor(() => host.fetchApi(`/sessions/${initial.requestId}`), r => r.body.nativeSession?.id === nativeId);
    const resumeRequest = { requestId: randomUUID() };
    const liveRequest = { requestId: randomUUID() };
    const live = await host.fetchApi(`/sessions/${initial.requestId}/resume`, "owner", liveRequest);
    assert.equal(live.body.id, initial.requestId, "live resume attaches to the existing session");
    const control = await claimControl(host, initial.requestId, "owner");
    await host.fetchApi(`/sessions/${initial.requestId}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${initial.requestId}`), r => r.body.status === "exited");
    assert.equal((await host.fetchApi(`/sessions/${initial.requestId}/resume`, "controller", resumeRequest)).status, 403);
    const competingRequest = { requestId: randomUUID() };
    const [resumed, competing] = await Promise.all([
      host.fetchApi(`/sessions/${initial.requestId}/resume`, "owner", resumeRequest),
      host.fetchApi(`/sessions/${initial.requestId}/resume`, "owner", competingRequest),
    ]);
    assert.equal(resumed.status, 200);
    assert.equal(competing.status, 200);
    assert.ok([resumeRequest.requestId, competingRequest.requestId].includes(resumed.body.id));
    assert.equal(competing.body.id, resumed.body.id, "different device requests converge on one runtime");
    assert.equal(resumed.body.resumedFrom, initial.requestId);
    assert.equal(resumed.body.cwd, realpathSync(directory), "native resumption preserves the launch subdirectory");
    assert.notEqual(resumed.body.runtime.id, first.body.runtime.id);
    assert.equal(resumed.body.initialPrompt, "");
    assert.deepEqual(resumed.body.nativeArgs, ["--resume", nativeId]);
    const again = await host.fetchApi(`/sessions/${initial.requestId}/resume`, "owner", resumeRequest);
    assert.equal(again.body.runtime.id, resumed.body.runtime.id);
    assert.equal((await host.fetchApi("/sessions")).body.sessions.length, 2);
    await host.stopApi(); await host.start();
    const attached = await host.fetchApi(`/sessions/${initial.requestId}/resume`, "owner", { requestId: randomUUID() });
    assert.equal(attached.body.runtime.id, resumed.body.runtime.id, "admission survives API restart");
    const socket = join(host.config.runDir, `${resumed.body.id}.sock`);
    renameSync(socket, `${socket}.held`);
    try {
      const refused = await host.fetchApi(`/sessions/${initial.requestId}/resume`, "owner", { requestId: randomUUID() });
      assert.equal(refused.status, 409, "an unreachable continuation must not be presumed exited");
      assert.equal((await host.fetchApi("/sessions")).body.sessions.length, 2);
    } finally { renameSync(`${socket}.held`, socket); }
    const resumedControl = await claimControl(host, resumed.body.id, "owner");
    await host.fetchApi(`/sessions/${resumed.body.id}/stop`, "owner", { requestId: randomUUID() }, resumedControl.headers);
    await waitFor(() => host.fetchApi(`/sessions/${resumed.body.id}`), response => response.body.status === "exited");
    await host.stopApi(); await host.start();
    for (const request of [resumeRequest, competingRequest]) {
      const retry = await host.fetchApi(`/sessions/${initial.requestId}/resume`, "owner", request);
      assert.equal(retry.body.runtime.id, resumed.body.runtime.id, "even the other device's alias retains its original result after exit");
      assert.equal(retry.body.status, "exited");
    }
    assert.equal((await host.fetchApi(`/sessions/${initial.requestId}/resume`, "owner", liveRequest)).body.id, initial.requestId);
    assert.equal((await host.fetchApi("/sessions")).body.sessions.length, 2);
    const next = await host.fetchApi(`/sessions/${resumed.body.id}/resume`, "owner", { requestId: randomUUID() });
    assert.equal(next.status, 200);
    assert.notEqual(next.body.runtime.id, resumed.body.runtime.id, "a fresh explicit request may resume a confirmed exited continuation");
  } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
});
