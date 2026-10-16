import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as ptySpawn } from "node-pty";
import { CmuxSessions } from "../packages/host/src/cmux/index.js";
import type { Config, ControlLease, Receipt } from "../packages/host/src/types.js";
import { claimControl, startHost, waitFor } from "./helpers.js";

// A real executable stands at the cmux process boundary. It supplies terminal
// observations, but all authorization, journals and receipts belong to the adapter.
const CLI = String.raw`
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const file=join(root,'fixture.json');
const state=JSON.parse(readFileSync(file,'utf8'));
const method=process.argv[3], params=JSON.parse(process.argv[4]??'{}');
const trace=(phase)=>appendFileSync(join(root,'calls.jsonl'),JSON.stringify({method,phase,at:Date.now()})+'\n');
trace('started');
if(method==='system.tree') while(true){try{readFileSync(join(root,'hold-tree'));}catch{break;}await new Promise(resolve=>setTimeout(resolve,10));}
const reply=(value)=>{trace('replied');console.log(JSON.stringify(value));};
if(state.offline) process.exit(2);
if(method==='system.tree') {
  if(state.starting){delete state.starting;writeFileSync(file,JSON.stringify(state));process.exit(2);}
  reply({windows:[{workspaces:state.workspaces}]});
}
else if(method==='vault.sessions') reply({sessions:state.vault});
else if(method==='feed.list') {
  if(state.feedOffline) process.exit(2);
  if(state.feedChanges){state.feed=state.feedChanges;delete state.feedChanges;writeFileSync(file,JSON.stringify(state));}
  reply({items:state.feed});
}
else if(method==='surface.read_text') reply({text:state.screen??'> '});
else if(method==='terminal.replay') reply({columns:80,rows:24,...(state.renderGrid?{render_grid:state.renderGrid}:{})});
else {
  appendFileSync(join(root,'mutations.jsonl'),JSON.stringify({method,params})+'\n');
  if(state.failAfter===method) process.exit(2);
  if(method==='workspace.create'){
    const n=(state.created??0)+1;state.created=n;
    state.workspaces.push({id:'created-workspace-'+n,panes:[{surfaces:[{id:'created-surface-'+n,type:'terminal',title:'New session'}]}]});
    writeFileSync(file,JSON.stringify(state));reply({workspace_id:'created-workspace-'+n,surface_id:'created-surface-'+n});
  } else if(method==='terminal.paste')reply({submitted:params.submit_key==='return'});
  else if(method.startsWith('feed.')&&method.endsWith('.reply')){
    state.feed=state.feed.filter(row=>row.request_id!==params.request_id);writeFileSync(file,JSON.stringify(state));reply({});
  } else if(method==='surface.close'){
    state.workspaces=state.workspaces.map(w=>({...w,panes:w.panes.map(p=>({...p,surfaces:p.surfaces.filter(s=>s.id!==params.surface_id)}))}));
    writeFileSync(file,JSON.stringify(state));reply({});
  } else reply({});
}
`;

async function fixture(t: TestContext, starting = false) {
  const root = mkdtempSync(join(tmpdir(), "infinite-cmux-"));
  const cwd = join(root, "project");
  const hooksDir = join(root, "hooks");
  mkdirSync(cwd); mkdirSync(hooksDir);
  const command = join(root, "cmux-fixture.mjs");
  writeFileSync(command, `#!${process.execPath}\n${CLI}`); chmodSync(command, 0o700);
  const config: Config = {
    port: 0, origin: "http://127.0.0.1", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile: join(root, "key"),
    tokens: [], projects: [{ id: "project", name: "Project", path: cwd }], environment: "local", enableDemo: false, maxSessions: 20,
    agents: { claude: { command: process.execPath, args: [] }, codex: { command: process.execPath, args: [] } },
    cmux: { enabled: true, command, hooksDir },
  };
  const key = randomBytes(32);
  const provider = ptySpawn(process.execPath, ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { cols: 80, rows: 24, cwd, env: process.env });
  let sessions: CmuxSessions | undefined;
  let providerExited = false;
  const exited = new Promise<void>((resolve) => provider.onExit(() => { providerExited = true; resolve(); }));
  t.after(async () => {
    await sessions?.close();
    if (!providerExited) provider.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const failed = provider.onExit(({ exitCode, signal }) => {
      data.dispose();
      reject(new Error(`Fixture provider exited before readiness (exit=${exitCode}, signal=${signal})`));
    });
    const data = provider.onData((text) => {
      output += text;
      if (!output.includes("ready")) return;
      data.dispose(); failed.dispose(); resolve();
    });
  });
  const transcript = join(root, "claude.jsonl");
  writeFileSync(transcript, "");
  const nativeId = randomUUID();
  const state: any = { starting, workspaces: [{ id: "workspace", panes: [{ surfaces: [{ id: "surface", type: "terminal", title: "✳ Conversation" }] }] }], vault: [], feed: [], screen: "> " };
  const setState = (changes: Record<string, unknown>) => {
    const next = { ...JSON.parse(readFileSync(join(root, "fixture.json"), "utf8")), ...changes };
    writeFileSync(join(root, "fixture.json"), JSON.stringify(next));
  };
  writeFileSync(join(root, "fixture.json"), JSON.stringify(state));
  const hooks: Record<string, any> = {
    [nativeId]: { sessionId: nativeId, surfaceId: "surface", workspaceId: "workspace", cwd, pid: provider.pid, agentLifecycle: "running", transcriptPath: transcript, updatedAt: Date.now() / 1000 },
  };
  const writeHooks = () => writeFileSync(join(hooksDir, "claude-hook-sessions.json"), JSON.stringify({ sessions: hooks }));
  writeHooks();
  sessions = new CmuxSessions(config, key);
  const mutations = () => existsSync(join(root, "mutations.jsonl")) ? readFileSync(join(root, "mutations.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const restart = async () => { await sessions!.close(); sessions = new CmuxSessions(config, key); return sessions; };
  // An unavailable CLI is a valid discovery result. Establish fixture readiness
  // with read-only observations before testing actions; never retry a mutation.
  let row = (await sessions.list()).find(row => row.nativeSession?.id === nativeId);
  if (!row) row = (await sessions.list()).find(row => row.nativeSession?.id === nativeId);
  const trace = existsSync(join(root, "calls.jsonl")) ? readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n").slice(-12).join("; ") : "no fixture CLI started";
  assert.ok(row, `Fixture session was not discovered after two read-only observations. Provider exited: ${providerExited}. CLI trace: ${trace}`);
  const id = row.id;
  const claim = async (actor = { id: "phone", label: "Phone" }, takeover = false) => {
    const lease = await sessions!.call<ControlLease>(id, { op: "control", action: "claim", actor, takeover });
    return { actor, leaseId: lease.id };
  };
  return { root, cwd, hooksDir, config, key, provider, transcript, nativeId, hooks, writeHooks, setState, id, claim, mutations, restart, get sessions() { return sessions!; } };
}

test("cmux discovery keeps native identities and paginates transcripts without claiming task completion", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, true);
  const codexId = randomUUID(), codexTranscript = join(f.root, "codex.jsonl");
  writeFileSync(codexTranscript, [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please inspect the change" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "Private reasoning" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", channel: "final", content: [{ type: "output_text", text: "Review result" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const sibling = join(f.root, "project-other"); mkdirSync(sibling);
  f.setState({ vault: [
    { agent: "codex", session_id: codexId, cwd: f.cwd, title: "Codex conversation", file: codexTranscript },
    { agent: "claude", session_id: randomUUID(), cwd: sibling, title: "Outside configured project" },
  ] });
  writeFileSync(f.transcript, JSON.stringify({ type: "assistant", uuid: "reply", message: { content: [{ type: "text", text: "First reply 🦊" }, { type: "text", text: "Second reply" }, { type: "tool_use", name: "Read", input: { file_path: "src/app.ts" } }] } }) + "\n");
  appendFileSync(f.transcript, JSON.stringify({ type: "attachment", uuid: "queued", attachment: { type: "queued_command", prompt: "Please use the new direction" } }) + "\n");
  const rows = await f.sessions.list();
  assert.equal(rows.length, 2, "discovery is scoped to configured roots, not similarly named siblings");
  const current = rows.find(row => row.id === f.id)!;
  assert.equal(current.attention.state, "working", "an idle-looking terminal title does not establish a completed turn");
  const first = await f.sessions.messages(f.id, "0", 1);
  assert.deepEqual(first.messages.map(message => message.text), ["First reply 🦊"]);
  assert.equal(first.more, true);
  const second = await f.sessions.messages(f.id, first.cursor, 1);
  assert.deepEqual(second.messages.map(message => message.text), ["Second reply"]);
  const rest = await f.sessions.messages(f.id, second.cursor, 10);
  assert.deepEqual(rest.messages.map(message => message.role), ["tool", "user"]);
  const incomplete = JSON.stringify({ type: "user", uuid: "partial", message: { content: "Appended later" } });
  appendFileSync(f.transcript, incomplete);
  assert.equal((await f.sessions.messages(f.id, rest.cursor)).cursor, rest.cursor);
  appendFileSync(f.transcript, "\n");
  assert.deepEqual((await f.sessions.messages(f.id, rest.cursor)).messages.map(message => message.text), ["Appended later"]);
  const codex = rows.find(row => row.provider === "codex")!;
  assert.deepEqual((await f.sessions.messages(codex.id)).messages.map(message => message.text), ["Please inspect the change", "Review result"]);
  await f.restart();
  assert.deepEqual((await f.sessions.list()).map(row => row.id).sort(), rows.map(row => row.id).sort());
  assert.equal(f.mutations().length, 0, "discovery and history reads never send input");
});

test("cmux input serializes leases and retains delivered and uncertain receipts across restart", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.sessions.call(f.id, { op: "input", requestId: randomUUID(), text: "unowned", submit: true }), { code: "control-lost" });
  const phone = await f.claim();
  const request = { op: "input" as const, requestId: randomUUID(), text: "Sensitive fixture instruction", submit: true, ...phone };
  const [first, duplicate] = await Promise.all([f.sessions.call<Receipt>(f.id, request), f.sessions.call<Receipt>(f.id, request)]);
  assert.equal(first.state, "delivered");
  assert.deepEqual(duplicate, first);
  assert.equal(f.mutations().filter(row => row.method === "terminal.paste").length, 1);
  const browser = { id: "browser", label: "Browser" };
  await assert.rejects(f.sessions.call(f.id, { op: "control", action: "claim", actor: browser }), { code: "control-busy" });
  const next = await f.claim(browser, true);
  await assert.rejects(f.sessions.call(f.id, { ...request, requestId: randomUUID() }), { code: "control-lost" });
  assert.deepEqual(await f.sessions.call(f.id, request), first, "receipt lookup remains available after control moves");
  f.setState({ failAfter: "terminal.paste" });
  const uncertainRequest = { ...request, requestId: randomUUID(), text: "Do not replay this instruction", ...next };
  const uncertain = await f.sessions.call<Receipt>(f.id, uncertainRequest);
  assert.equal(uncertain.state, "uncertain");
  await f.restart();
  f.setState({ failAfter: null });
  assert.deepEqual(await f.sessions.call(f.id, uncertainRequest), uncertain);
  assert.equal(f.mutations().filter(row => row.method === "terminal.paste").length, 2, "a lost CLI acknowledgement never causes replay");
  await assert.rejects(f.sessions.call(f.id, { ...uncertainRequest, text: "different content" }), { code: "request-conflict" });
  const sealed = readFileSync(join(f.config.stateDir, "cmux", f.id, "meta.sealed"), "utf8");
  const journalDir = join(f.config.stateDir, "cmux", f.id, "events");
  const journals = readdirSync(journalDir).map(file => readFileSync(join(journalDir, file), "utf8")).join("");
  assert.equal((sealed + journals).includes(request.text), false);
  assert.equal((sealed + journals).includes(uncertainRequest.text), false);
  const events = f.sessions.events(f.id, 0, 200).events;
  assert.equal(events.filter(event => event.type === "input-intent").length, 2);
});

test("cmux refuses unknown foreground, stale surfaces, and dialog bypasses", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  let control = await f.claim();
  const send = () => f.sessions.call(f.id, { op: "input", requestId: randomUUID(), text: "must never reach a shell", submit: true, ...control });
  f.hooks[f.nativeId].pid = process.pid; f.writeHooks();
  await assert.rejects(send(), { code: "agent-not-foreground" });
  f.hooks[f.nativeId].pid = f.provider.pid; f.hooks[f.nativeId].agentLifecycle = "needsInput"; f.writeHooks();
  await assert.rejects(send(), { code: "prompt-open" });
  await assert.rejects(f.sessions.call(f.id, { op: "input", requestId: randomUUID(), text: "yes", submit: true, force: true, ...control }), { code: "prompt-open" });
  f.hooks[f.nativeId].agentLifecycle = "running"; f.writeHooks();
  f.setState({ screen: "> Unfinished local direction" });
  await assert.rejects(send(), { code: "draft-present" });
  assert.equal(f.mutations().length, 0, "remote control does not overwrite someone's local prompt draft");
  f.setState({ screen: "> " });
  // A different native conversation takes over the same terminal locally.
  const replacement = randomUUID();
  f.hooks[replacement] = { ...f.hooks[f.nativeId], sessionId: replacement, updatedAt: Date.now() / 1000 + 1 }; f.writeHooks();
  assert.equal((await f.sessions.get(f.id)).status, "exited");
  control = await f.claim();
  await assert.rejects(send(), { code: "control-lost" });
  assert.equal(f.mutations().length, 0);
  f.setState({ offline: true });
  assert.equal((await f.sessions.get(f.id)).status, "unavailable");
  f.config.cmux!.command = join(f.root, "missing-cmux");
  await f.restart();
  assert.equal((await f.sessions.get(f.id)).status, "unavailable");
});

test("cmux answers only a fresh explicit native approval and never approves on discovery", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const permission = { request_id: "permission-one", kind: "permission", source: "claude", session_id: f.nativeId, surface_id: "surface", status: "pending", title: "Run tool", tool_input: { command: "echo fixture" } };
  f.setState({ feed: [permission] });
  const first = await f.sessions.get(f.id);
  assert.equal(first.attention.state, "needs-you");
  assert.equal(f.mutations().length, 0);
  const control = await f.claim();
  const originalPrompt = first.attention.prompt!.id;
  f.setState({ feed: [{ ...permission, tool_input: { command: "echo changed" } }] });
  await assert.rejects(f.sessions.call(f.id, { op: "answer", requestId: randomUUID(), promptId: originalPrompt, option: 0, ...control }), { code: "prompt-changed" });
  assert.equal(f.mutations().length, 0);
  const pending = await f.sessions.get(f.id);
  const answered = await f.sessions.call<Receipt & { result: string }>(f.id, { op: "answer", requestId: randomUUID(), promptId: pending.attention.prompt!.id, option: 2, ...control });
  assert.equal(answered.state, "delivered"); assert.equal(answered.result, "closed");
  assert.deepEqual(f.mutations().filter(row => row.method.startsWith("feed.")).map(row => row.params), [{ request_id: "permission-one", mode: "deny" }]);
  f.setState({ feed: [{ request_id: "question-one", kind: "question", source: "claude", session_id: f.nativeId, status: "pending", questions: [{ prompt: "Choose a target", options: [{ id: "a", label: "Laptop" }, { id: "b", label: "Cloud" }] }] }] });
  const question = await f.sessions.get(f.id);
  await f.sessions.call(f.id, { op: "answer", requestId: randomUUID(), promptId: question.attention.prompt!.id, option: 1, ...control });
  assert.deepEqual(f.mutations().at(-1), { method: "feed.question.reply", params: { request_id: "question-one", selections: ["Cloud"] } });
  f.setState({ feed: [{ request_id: "plan-one", kind: "plan", source: "claude", session_id: f.nativeId, status: "pending", plan: "Change the project" }] });
  const plan = await f.sessions.get(f.id);
  await f.sessions.call(f.id, { op: "answer", requestId: randomUUID(), promptId: plan.attention.prompt!.id, text: "Please narrow the change", ...control });
  assert.deepEqual(f.mutations().at(-1), { method: "feed.exit_plan.reply", params: { request_id: "plan-one", mode: "deny", feedback: "Please narrow the change" } });
  f.setState({ feed: [{ request_id: "questions", kind: "question", source: "claude", session_id: f.nativeId, status: "pending", questions: [{ prompt: "Targets", multi_select: true, options: [{ label: "Laptop" }, { label: "Cloud" }] }, { prompt: "When?", options: [{ label: "Now" }] }] }] });
  const questions = await f.sessions.get(f.id);
  await f.sessions.call(f.id, { op: "answer", requestId: randomUUID(), promptId: questions.attention.prompt!.id, text: "Laptop, Cloud\nNow", ...control });
  assert.deepEqual(f.mutations().at(-1), { method: "feed.question.reply", params: { request_id: "questions", selections: ["Laptop, Cloud", "Now"] } });
  f.setState({ feed: [], screen: "Continue? [y/N]" });
  const screenQuestion = await f.sessions.get(f.id);
  assert.equal((await f.sessions.call<Receipt>(f.id, { op: "answer", requestId: randomUUID(), promptId: screenQuestion.attention.prompt!.id, option: 1, ...control })).state, "delivered");
  assert.deepEqual(f.mutations().at(-1), { method: "surface.send_text", params: { surface_id: "surface", workspace_id: "workspace", text: "n\r" } });
  f.setState({ screen: "> " });
  f.setState({ workspaces: [{ id: "workspace", panes: [{ surfaces: [{ id: "surface", type: "terminal", title: "Conversation" }, { id: "adjacent", type: "terminal", title: "Other terminal" }] }] }] });
  assert.equal((await f.sessions.call<Receipt>(f.id, { op: "stop", requestId: randomUUID(), ...control })).state, "delivered");
  assert.equal((await f.sessions.get(f.id)).status, "exited");
  assert.equal(f.mutations().some(row => row.method === "workspace.close"), false, "ending one agent must preserve adjacent terminals");
});

test("an unanswered Feed approval remains guarded through repeated Feed outages and restart", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  f.setState({ feed: [{ request_id: "approval", kind: "permission", source: "claude", session_id: f.nativeId, status: "pending", title: "Run tool" }] });
  assert.equal((await f.sessions.get(f.id)).attention.state, "needs-you");
  f.setState({ feedOffline: true });
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await f.sessions.get(f.id)).status, "unavailable");
  await f.restart();
  assert.equal((await f.sessions.get(f.id)).status, "unavailable");
  const control = await f.claim();
  for (const action of [{ op: "input" as const, text: "yes", submit: true }, { op: "key" as const, key: "enter" as const }]) {
    await assert.rejects(f.sessions.call(f.id, { ...action, requestId: randomUUID(), ...control }));
  }
  assert.equal(f.mutations().length, 0, "an unavailable approval never permits generic terminal input");
  f.setState({ feedOffline: false, feed: [] });
  assert.equal((await f.sessions.get(f.id)).status, "running", "only a successful fresh Feed observation can resolve the latch");
  const freshControl = await f.claim();
  assert.equal((await f.sessions.call<Receipt>(f.id, { op: "input", requestId: randomUUID(), text: "New direction", submit: true, ...freshControl })).state, "delivered");
});

test("cmux resume respects capacity before recording intent while existing receipts stay retryable", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  f.config.maxSessions = 1;
  const history = randomUUID();
  f.setState({ vault: [{ agent: "claude", session_id: history, cwd: f.cwd, title: "Earlier conversation" }] });
  const saved = (await f.sessions.list()).find(row => row.nativeSession?.id === history)!;
  const requestId = randomUUID();
  await assert.rejects(f.sessions.resume(saved.id, requestId), { code: "session-limit" });
  assert.equal(f.mutations().length, 0);
  assert.equal(f.sessions.events(saved.id).events.some(event => event.type === "input-intent"), false);
  assert.equal((await f.sessions.resume(f.id, randomUUID())).id, f.id, "attaching to the existing live session consumes no capacity");
  f.setState({ workspaces: [] });
  const resumed = await f.sessions.resume(saved.id, requestId);
  assert.equal(resumed.status, "running");
  assert.equal((await f.sessions.resume(saved.id, requestId)).runtime!.id, resumed.runtime!.id);
  assert.equal(f.mutations().filter(row => row.method === "workspace.create").length, 1);
});

test("the inbox hides only the same live cmux process, preserving separate and resumed runtimes", { timeout: 25000 }, async (t) => {
  const f = await fixture(t);
  const agent = join(f.root, "managed.mjs");
  writeFileSync(agent, `
await fetch(process.env.INFINITE_HOOK_URL + '/claude', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.INFINITE_HOOK_TOKEN },
  body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: ${JSON.stringify(f.nativeId)}, prompt: 'Continue' })
});
setInterval(() => {}, 1000);
`);
  const host = await startHost({ agents: { claude: { command: process.execPath, args: [agent] } }, config: { projects: f.config.projects, cmux: f.config.cmux } });
  try {
    const managedId = randomUUID();
    assert.equal((await host.fetchApi("/sessions", "owner", { requestId: managedId, provider: "claude", projectId: "project", title: "Managed" })).status, 201);
    const managed = await waitFor(() => host.fetchApi(`/sessions/${managedId}`), response => response.body.nativeSession?.id === f.nativeId);
    const rows = async () => (await host.fetchApi("/sessions")).body.sessions.filter((row: any) => row.nativeSession?.id === f.nativeId);
    assert.equal((await rows()).length, 2, "matching conversation IDs alone do not establish the same runtime");
    f.hooks[f.nativeId].pid = managed.body.pid; f.writeHooks();
    assert.equal((await rows()).length, 1, "a current worker and its cmux hook can represent the same live PID");
    f.hooks[f.nativeId].pid = f.provider.pid; f.writeHooks();
    const control = await claimControl(host, managedId, "owner");
    await host.fetchApi(`/sessions/${managedId}/stop`, "owner", { requestId: randomUUID() }, control.headers);
    await waitFor(() => host.fetchApi(`/sessions/${managedId}`), response => response.body.status === "exited");
    const after = await rows();
    assert.equal(after.length, 2);
    assert.ok(after.some((row: any) => row.backend === "cmux" && row.status === "running"), "an exited managed recording never hides a live cmux continuation");
  } finally { await host.stop(); }
});

test("cmux creates once, resumes native history without replaying its prompt, and retains uncertain creates", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const captured = join(f.cwd, "argv.json");
  f.config.agents.claude = { command: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))", "--", captured] };
  const request = { requestId: randomUUID(), provider: "claude" as const, projectId: "project", title: "Created remotely", prompt: "literal ' $(touch should-not-exist)\nsecond line" };
  const created = await f.sessions.create(request);
  assert.equal(created.id, request.requestId);
  assert.equal((await f.sessions.create(request)).id, created.id);
  let launches = f.mutations().filter(row => row.method === "workspace.create");
  assert.equal(launches.length, 1);
  execFileSync("sh", ["-c", launches[0].params.initial_input.replace(/\r$/, "")], { cwd: f.cwd });
  assert.deepEqual(JSON.parse(readFileSync(captured, "utf8")), [request.prompt], "shell metacharacters remain one literal provider argument");
  assert.equal(existsSync(join(f.cwd, "should-not-exist")), false);
  // Native identity arrives after a newly created workspace, while the Vault
  // also begins listing it. The Infinite ID remains the original request ID.
  const launchedNative = randomUUID();
  f.hooks[launchedNative] = { ...f.hooks[f.nativeId], sessionId: launchedNative, surfaceId: "created-surface-1", workspaceId: "created-workspace-1", updatedAt: Date.now() / 1000 + 1 };
  f.writeHooks(); f.setState({ vault: [{ agent: "claude", session_id: launchedNative, cwd: f.cwd, file: f.transcript }] });
  assert.equal((await f.sessions.list()).length, 2);
  assert.equal((await f.sessions.get(created.id)).nativeSession!.id, launchedNative);
  f.hooks[f.nativeId].pid = 99999999; f.writeHooks();
  f.setState({ workspaces: [{ id: "workspace", panes: [{ surfaces: [{ id: "surface", type: "terminal", title: "Returned shell" }] }] }] });
  f.config.agents.claude = { command: process.execPath, args: [] };
  const before = await f.sessions.get(f.id);
  assert.equal(before.status, "exited");
  const resumed = await f.sessions.resume(f.id, randomUUID());
  assert.equal(resumed.id, f.id); assert.notEqual(resumed.runtime!.id, before.runtime!.id);
  assert.equal(resumed.status, "running", "a stale hook for the old shell cannot replace the new resume surface");
  launches = f.mutations().filter(row => row.method === "workspace.create");
  assert.match(launches.at(-1).params.initial_input, /'--resume'/);
  assert.ok(launches.at(-1).params.initial_input.includes(f.nativeId));
  assert.equal(launches.at(-1).params.initial_input.includes(request.prompt), false);
  f.setState({ failAfter: "workspace.create" });
  const uncertain = { ...request, requestId: randomUUID() };
  await assert.rejects(f.sessions.create(uncertain), { code: "delivery-uncertain" });
  const count = f.mutations().length;
  await f.restart(); f.setState({ failAfter: null });
  await assert.rejects(f.sessions.create(uncertain), { code: "delivery-uncertain" });
  assert.equal(f.mutations().length, count);
  writeFileSync(join(f.config.stateDir, "cmux", uncertain.requestId, "meta.sealed"), "invalid ciphertext");
  await f.restart();
  await assert.rejects(f.sessions.create(uncertain), { code: "recording-error" });
  assert.equal(f.mutations().length, count, "unreadable receipts cannot turn an uncertain launch into a new launch");
});

test("concurrent cmux observations share work and do not delay control", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const control = await f.claim();
  const calls = () => readFileSync(join(f.root, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const before = calls().length;
  const gate = join(f.root, "hold-tree");
  writeFileSync(gate, "hold");
  const reading = f.sessions.get(f.id);
  while (!calls().slice(before).some(row => row.method === "system.tree" && row.phase === "started")) await new Promise(resolve => setTimeout(resolve, 10));
  const polls = Array.from({ length: 20 }, () => f.sessions.list());
  const input = f.sessions.call<Receipt>(f.id, { op: "input", requestId: randomUUID(), text: "Fresh direction", submit: true, ...control });
  rmSync(gate);
  const receipt = await input;
  await Promise.all([reading, ...polls]);
  assert.equal(receipt.state, "delivered");
  const trace = calls().slice(before);
  const delivered = trace.findIndex(row => row.method === "terminal.paste" && row.phase === "started");
  assert.equal(trace.slice(0, delivered).filter(row => row.method === "system.tree" && row.phase === "started").length, 2, "Control must run before queued observations");
  assert.equal(trace.filter(row => row.method === "system.tree" && row.phase === "started").length, 3, "Concurrent inbox polls share one observation");
  const next = calls().length;
  writeFileSync(gate, "hold");
  const blocked = f.sessions.get(f.id);
  await waitFor(async () => calls().slice(next).some(row => row.method === "system.tree" && row.phase === "started"), Boolean);
  const rejected: string[] = [];
  const pending = Array.from({ length: 24 }, () => f.sessions.get(randomUUID()).catch(error => { rejected.push(error.code); }));
  try {
    await Promise.resolve();
    assert.equal(rejected.filter(code => code === "cmux-busy").length, 16, "excess unique reads are rejected before subprocess admission");
    const overloaded = await f.sessions.list();
    assert.equal(overloaded.find(row => row.id === f.id)!.status, "unavailable", "an overloaded inbox never presents cached cmux state as fresh");
    assert.equal(overloaded.find(row => row.id === f.id)!.control, null);
  } finally { rmSync(gate); await Promise.all([blocked, ...pending]); }

  const last = calls().length;
  writeFileSync(gate, "hold");
  const active = f.sessions.get(f.id);
  await waitFor(async () => calls().slice(last).some(row => row.method === "system.tree" && row.phase === "started"), Boolean);
  const expired = f.sessions.messages(f.id).then(() => "refreshed", error => error.code);
  const admitted = f.sessions.call<Receipt>(f.id, { op: "input", requestId: randomUUID(), text: "Explicit input survives observation expiry", submit: true, ...control });
  try { await new Promise(resolve => setTimeout(resolve, 5100)); }
  finally { rmSync(gate); }
  await active;
  assert.equal((await admitted).state, "delivered", "admitted mutations retain their own safety checks and receipt");
  assert.equal(await expired, "cmux-busy", "abandoned queued observations expire without another CLI refresh");
});
