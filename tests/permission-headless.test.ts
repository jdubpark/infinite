import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Manager } from "../packages/host/src/manager.js";
import { workerCall } from "../packages/host/src/ipc.js";
import { headlessChannelArgs } from "../packages/host/src/launch.js";
import {
  HeadlessPermissionChannel, channelToken, deferredCallOpen, deliveryKey, type ChannelReply,
} from "../packages/host/src/permission-headless.js";
import {
  claudeTurnSignals, DEFERRAL_RETENTION_MS, HeadlessChannelWorker, OPEN_CALL_KEYS, OWNER_DENIED, PENDING_NOTICE, type ChannelWorkerHost,
} from "../packages/host/src/permission-headless-worker.js";
import { hookOutput } from "../packages/host/src/permission-hook.js";
import { requesterNotice } from "../packages/host/src/permission-policy.js";
import type { PermissionAgentServices, PermissionOutcome, PermissionPipeline, PermissionRequest } from "../packages/host/src/permission-agent-types.js";
import type { Config, Event, Session } from "../packages/host/src/types.js";
import { stopSessionWorkers, waitFor } from "./helpers.js";

const FAKE = resolve("tests/fixtures/headless-claude.mjs");

function fakePipeline(overrides: Partial<PermissionPipeline> = {}) {
  const deliveries: Array<{ decisionId: string; kind: string; detail?: string }> = [];
  const decided: PermissionRequest[] = [];
  const classOf = (request: PermissionRequest) =>
    /production/.test(request.action) ? { interruptClass: "production-or-staging" as const, rule: "production-deploy" } : undefined;
  const pipeline: PermissionPipeline = {
    serves: () => ({ served: true }),
    classOf,
    async decide(request): Promise<PermissionOutcome> {
      decided.push(request);
      const decisionId = randomUUID();
      const match = classOf(request);
      if (match) return { kind: "owner", decisionId, interruptClass: match.interruptClass };
      if (/safe-build/.test(request.action)) return { kind: "allow", decisionId, strongTier: false };
      return { kind: "reject", decisionId, code: "unsafe", notice: "MODEL TEXT that must never reach the agent" };
    },
    applicable: () => true,
    recordDelivery: (decisionId, kind, detail) => { deliveries.push({ decisionId, kind, ...(detail ? { detail } : {}) }); },
    taskEnded() {},
    ...overrides,
  };
  return { pipeline, deliveries, decided };
}

async function rig(options: { args?: string[]; pipeline?: PermissionPipeline; overrides?: Partial<PermissionPipeline> } = {}) {
  const root = realpathSync(mkdtempSync("/tmp/inf-headless-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const key = randomBytes(32);
  const keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const config: Config = {
    port: 0, origin: "http://127.0.0.1", keyFile, stateDir: join(root, "state"), runDir: join(root, "run"),
    environment: "local", enableDemo: false, maxSessions: 8,
    agents: { claude: { command: process.execPath, args: [FAKE, "--print", ...(options.args ?? [])] } },
    projects: [{ id: "rehearsal", name: "Rehearsal", path: workspace }],
    tokens: [],
    attention: { hooks: { claude: true, codex: false }, idleAfterMs: 3000, limitConfirmMs: 30000 },
  } as Config;
  const manager = new Manager(config, key);
  const fake = fakePipeline(options.overrides);
  const services: PermissionAgentServices = { pipeline: options.pipeline ?? fake.pipeline };
  const channel = new HeadlessPermissionChannel({ key, runDir: config.runDir, sessions: manager, services });
  manager.useHeadlessChannel(channel);
  await channel.listen();
  return {
    root, workspace, config, key, manager, channel, services, ...fake,
    log: (name: string) => existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), "utf8") : "",
    channelEvents: (id: string) => manager.events(id, 0, 500, new Set(["lifecycle"])).events
      .map(event => (event.data as { permissionChannel?: Record<string, unknown> }).permissionChannel).filter(Boolean) as Array<Record<string, unknown>>,
    stop: async () => {
      await stopSessionWorkers(config);
      channel.close();
      await new Promise(done => setTimeout(done, 1700));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Live = Session & { status: string; attention: { state: string; prompt?: { id: number; source: string; options: Array<{ label: string }> } }; permissionChannel?: { served: boolean; waiting?: { interruptClass: string; tool: string }; notice?: { id: string; interruptClass?: string } } };
const live = async (r: Awaited<ReturnType<typeof rig>>, id: string) => ({ ...r.manager.meta(id).session, ...(await r.manager.state(id)) }) as unknown as Live;

test("a class call waits for the owner, and the owner's allow runs that one call once in the same session", { timeout: 90_000 }, async () => {
  const r = await rig();
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "mixed" });
    assert.deepEqual(r.manager.meta(id).session.headless, { channel: true });
    const waiting = await waitFor(() => live(r, id), s => s.attention.state === "needs-you" && Boolean(s.permissionChannel?.waiting), 40_000);
    assert.equal(r.log("ran.log"), "make safe-build\n");
    assert.equal(r.log("denied.log"), `rm -rf scratch: ${requesterNotice("unsafe")}\n`);
    assert.doesNotMatch(r.log("denied.log"), /MODEL TEXT/);
    assert.equal(waiting.status, "running");
    assert.equal(waiting.permissionChannel?.waiting?.interruptClass, "production-or-staging");
    const prompt = waiting.attention.prompt!;
    assert.equal(prompt.source, "protocol");
    assert.match((prompt as { hash?: string }).hash ?? "", /^[a-f0-9]{64}$/);
    const row = (await r.manager.list()).find(item => item.id === id) as unknown as { attention: { prompt: { delegable?: boolean } } };
    assert.equal(row.attention.prompt.delegable, undefined);
    assert.deepEqual(prompt.options.map(option => option.label), ["Yes, allow once", "No", "No, and tell Claude what to do differently"]);
    await assert.rejects(workerCall(r.config.runDir, id, { op: "input", requestId: randomUUID(), text: "hello", submit: true }), /prompt-open/);
    const requestId = randomUUID();
    const answer = await workerCall<{ state: string; result: string }>(r.config.runDir, id, { op: "answer", requestId, promptId: prompt.id, option: 0 });
    assert.equal(answer.state, "delivered");
    assert.deepEqual(await workerCall(r.config.runDir, id, { op: "answer", requestId, promptId: prompt.id, option: 0 }), answer);
    await assert.rejects(workerCall(r.config.runDir, id, { op: "answer", requestId: randomUUID(), promptId: prompt.id, option: 1 }), /prompt-changed/);
    await waitFor(() => live(r, id), s => s.status === "exited", 30_000);
    assert.equal(r.log("ran.log"), "make safe-build\ndeploy production\n");
    const events = r.channelEvents(id).map(event => event.event);
    assert.deepEqual(events.filter(event => event !== "pending"), ["deferred", "waiting", "answer", "resumed", "delivered"]);
    const turns = r.manager.events(id, 0, 500, new Set(["signal"])).events.map(event => event.data as { kind?: string; prompt?: string; automatic?: true })
      .filter(data => data.kind === "turn-start").map(data => [data.prompt, data.automatic]);
    assert.deepEqual(turns, [["mixed", undefined], ["Continue from where you left off.", true]]);
    const owner = r.decided.find(request => /production/.test(request.action))!;
    assert.equal(owner.requester.kind, "headless");
    assert.equal(owner.requester.sessionRoot, realpathSync(r.workspace));
    assert.deepEqual(r.deliveries.filter(d => /deferred|owner allowed|returned to the resumed/.test(d.detail ?? "")).map(d => d.kind), ["intent", "intent", "receipt"]);
    assert.equal(deferredCallOpen((after, limit) => r.manager.events(id, after, limit)), false);
  } finally { await r.stop(); }
});

test("an API restart between the owner's answer and the resume runs the call once, and its receipt reaches the restarted API", { timeout: 90_000 }, async () => {
  const r = await rig();
  let restarted: HeadlessPermissionChannel | undefined;
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "allowlisted" });
    const waiting = await waitFor(() => live(r, id), s => s.attention.state === "needs-you" && Boolean(s.permissionChannel?.waiting), 40_000);
    writeFileSync(join(r.workspace, "hold-resume"), "");
    const promptId = waiting.attention.prompt!.id;
    const requestId = randomUUID();
    const receipt = await workerCall(r.config.runDir, id, { op: "answer", requestId, promptId, option: 0 });
    await waitFor(async () => r.deliveries, list => list.some(d => /owner allowed/.test(d.detail ?? "")), 10_000);
    r.channel.close();
    const manager = new Manager(r.config, r.key);
    const after = fakePipeline();
    restarted = new HeadlessPermissionChannel({ key: r.key, runDir: r.config.runDir, sessions: manager, services: { pipeline: after.pipeline } });
    manager.useHeadlessChannel(restarted);
    await restarted.listen();
    const now = { ...r, manager };
    assert.deepEqual(await workerCall(r.config.runDir, id, { op: "answer", requestId, promptId, option: 0 }), receipt);
    await assert.rejects(workerCall(r.config.runDir, id, { op: "answer", requestId: randomUUID(), promptId, option: 0 }), /prompt-changed/);
    rmSync(join(r.workspace, "hold-resume"));
    await waitFor(() => live(now, id), s => s.status === "exited", 30_000);
    assert.equal(r.log("ran.log"), "deploy production\n");
    assert.deepEqual(now.channelEvents(id).map(event => event.event).filter(event => event !== "pending"), ["deferred", "waiting", "answer", "resumed", "delivered"]);
    const decisionId = r.deliveries.find(d => /deferred/.test(d.detail ?? ""))!.decisionId;
    await waitFor(async () => after.deliveries, list => list.length > 0, 10_000);
    assert.deepEqual(after.deliveries.map(d => [d.decisionId, d.kind]), [[decisionId, "receipt"]]);
  } finally { restarted?.close(); await r.stop(); }
});

test("an owner halt engaged after the owner's allow and before the resumed call withholds the allow, and the call never runs", { timeout: 90_000 }, async () => {
  let halt = false;
  const r = await rig({ overrides: { halted: () => halt, applicable: () => !halt } });
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "allowlisted" });
    const waiting = await waitFor(() => live(r, id), s => s.attention.state === "needs-you" && Boolean(s.permissionChannel?.waiting), 40_000);
    writeFileSync(join(r.workspace, "hold-resume"), "");
    await workerCall(r.config.runDir, id, { op: "answer", requestId: randomUUID(), promptId: waiting.attention.prompt!.id, option: 0 });
    await waitFor(async () => r.deliveries, list => list.some(d => /owner allowed/.test(d.detail ?? "")), 10_000);
    halt = true;
    rmSync(join(r.workspace, "hold-resume"));
    await waitFor(() => live(r, id), s => s.status === "exited", 30_000);
    assert.equal(r.log("ran.log"), "");
    assert.equal(r.log("denied.log"), `deploy production: ${requesterNotice("unavailable")}\n`);
    const delivered = r.channelEvents(id).filter(event => event.event === "delivered");
    assert.deepEqual(delivered.map(event => event.decision), ["withheld"]);
    assert.equal(deferredCallOpen((after, limit) => r.manager.events(id, after, limit)), false);
    const decisionId = r.deliveries.find(d => /deferred/.test(d.detail ?? ""))!.decisionId;
    await waitFor(async () => r.deliveries, list => list.some(d => d.decisionId === decisionId && d.kind === "stale"), 10_000);
    assert.equal(r.deliveries.some(d => d.decisionId === decisionId && d.kind === "receipt"), false);
  } finally { await r.stop(); }
});

test("a class call that arrives during an owner halt is denied as unavailable and never waits for an answer", { timeout: 90_000 }, async () => {
  const r = await rig({ overrides: { halted: () => true, decide: async () => ({ kind: "held" }) } });
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "allowlisted" });
    const ended = await waitFor(() => live(r, id), s => s.status === "exited", 30_000);
    assert.equal(r.log("ran.log"), "");
    assert.equal(r.log("denied.log"), `deploy production: ${requesterNotice("unavailable")}\n`);
    assert.equal(ended.permissionChannel?.waiting, undefined);
    assert.deepEqual(r.channelEvents(id).filter(event => event.event === "deferred"), []);
  } finally { await r.stop(); }
});

test("an owner's refusal reaches the call with the host's notice and the owner's direction, and the call never runs", { timeout: 90_000 }, async () => {
  const r = await rig({ args: ["--allowedTools", "Bash(deploy production)"] });
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "allowlisted" });
    const status = await r.channel.status();
    assert.deepEqual(status.shadowed.map(rule => [rule.rule, rule.interruptClass]), [["Bash(deploy production)", "production-or-staging"]]);
    const waiting = await waitFor(() => live(r, id), s => Boolean(s.permissionChannel?.waiting) && s.attention.state === "needs-you", 40_000);
    assert.equal(r.log("ran.log"), "");
    await workerCall(r.config.runDir, id, { op: "answer", requestId: randomUUID(), promptId: waiting.attention.prompt!.id, option: 2, text: "Use the staging checklist" });
    await waitFor(() => live(r, id), s => s.status === "exited", 30_000);
    assert.equal(r.log("ran.log"), "");
    assert.equal(r.log("denied.log"), `deploy production: ${OWNER_DENIED} Owner direction: Use the staging checklist\n`);
  } finally { await r.stop(); }
});

test("stop retires a waiting call unanswered, and the session cannot be resumed past it", { timeout: 90_000 }, async () => {
  const r = await rig();
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "allowlisted" });
    await waitFor(() => live(r, id), s => Boolean(s.permissionChannel?.waiting), 40_000);
    await workerCall(r.config.runDir, id, { op: "stop", requestId: randomUUID() });
    await waitFor(() => live(r, id), s => s.status === "exited", 20_000);
    assert.equal(r.log("ran.log"), "");
    assert.deepEqual(r.channelEvents(id).map(event => [event.event, event.reason]).at(-1), ["retired", "stopped"]);
    await assert.rejects(r.manager.resume(id, randomUUID()), /waited for the owner's answer/);
  } finally { await r.stop(); }
});

test("a session the pipeline does not serve launches exactly as before", { timeout: 60_000 }, async () => {
  const r = await rig({ args: ["--allowedTools", "Bash(deploy production)"], pipeline: { ...fakePipeline().pipeline, serves: () => ({ served: false, reason: "not-covered" }) } });
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "allowlisted" });
    assert.deepEqual(r.manager.meta(id).session.headless, { channel: false, reason: "No owner act covers this project.", allowlist: ["Bash(deploy production)"] });
    await waitFor(() => live(r, id), s => s.status === "exited", 30_000);
    assert.equal(r.log("ran.log"), "deploy production\n");
  } finally { await r.stop(); }
});

function workerRig(replies: Array<ChannelReply | Error>) {
  const records: Array<Record<string, unknown>> = [];
  const requests: unknown[] = [];
  const prompts: number[] = [];
  const closed: Array<[number, string]> = [];
  let now = Date.parse("2026-11-14T10:00:00.000Z");
  let ended = 0, resumed = 0, resumeFails = false;
  let resumeReply: ChannelReply | Error = { result: "ok" };
  const host: ChannelWorkerHost = {
    sessionId: randomUUID(), token: "0".repeat(64), socket: "/nonexistent",
    record: data => { records.push(data); return records.length; },
    openPrompt: () => { prompts.push(100 + prompts.length); return prompts.at(-1)!; },
    closePrompt: (id, label) => { closed.push([id, label]); },
    publish: () => {},
    resume: () => { resumed++; if (resumeFails) throw new Error("spawn failed"); },
    end: () => { ended++; },
    refusal: code => Object.assign(new Error(code), { code }),
    call: async (_socket, request) => {
      requests.push(request);
      if (request.op === "delivery") return { result: "recorded" };
      const reply = request.op === "resume" ? resumeReply : replies.shift() ?? { result: "none" };
      if (reply instanceof Error) throw reply;
      return reply;
    },
    now: () => now,
  };
  const channel = new HeadlessChannelWorker(host);
  const pre = (command: string, id: string, extra: Record<string, unknown> = {}) =>
    channel.check({ hook_event_name: "PreToolUse", session_id: "native-1", tool_name: "Bash", tool_input: { command }, tool_use_id: id, ...extra });
  return {
    channel, records, requests, prompts, closed, pre,
    get ended() { return ended; }, get resumed() { return resumed; },
    failResume() { resumeFails = true; }, advance(ms: number) { now += ms; },
    answerResume(reply: ChannelReply | Error) { resumeReply = reply; },
  };
}
const owner: ChannelReply = { result: "owner", interruptClass: "production-or-staging", rule: "production-deploy", sessionRoot: "/workspace", decisionId: randomUUID(), deliveryKey: "d".repeat(64) };

const claudeModeHooks = (name: string) => readFileSync(new URL(`./fixtures/claude-code-mode/${name}`, import.meta.url), "utf8")
  .trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);

test("Code Mode deferred Write resumes the same captured call id", async () => {
  const rows = claudeModeHooks("defer-hooks.jsonl");
  const w = workerRig([{ result: "none" }, { ...owner, rule: "write-owner" }]);
  const launchArgs = headlessChannelArgs("/repo/hook-relay.js", true);
  const settings: { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> } = JSON.parse(launchArgs[launchArgs.indexOf("--settings") + 1]!);
  const routes = (event: string) => settings.hooks[event]?.[0]?.hooks.map(({ command }) => command.split(" ").slice(-2).join(" ")) ?? [];
  assert.deepEqual(routes("PreToolUse"), ["/repo/hook-relay.js claude", "/repo/permission-hook.js check"]);
  assert.deepEqual(routes("PermissionRequest"), ["/repo/permission-hook.js request"]);
  assert.deepEqual(routes("PostToolUse"), ["/repo/hook-relay.js claude"]);
  assert.deepEqual(routes("UserPromptSubmit"), ["/repo/hook-relay.js claude"]);
  const bash = rows.find(row => row.hook_event_name === "PreToolUse" && row.tool_name === "Bash")!;
  const original = rows.find(row => row.hook_event_name === "PreToolUse" && row.tool_name === "Write")!;
  const resumed = rows.find(row => row.hook_event_name === "PreToolUse" && row.tool_name === "Write" && row !== original)!;
  const callId = original.tool_use_id;
  assert.equal(typeof callId, "string");
  assert.equal(resumed.tool_use_id, callId);

  assert.deepEqual(await w.channel.check(bash), { decision: "none" });
  assert.deepEqual(await w.channel.check(original), { decision: "defer", reason: "This call waits for the owner's answer. The session resumes with that answer." });
  const deferred = w.records.find(record => record.event === "deferred");
  assert.equal(deferred?.callId, callId);
  assert.equal(deferred?.rule, "write-owner");
  assert.equal(w.channel.exited(0), true);
  w.channel.answer({ requestId: "fixture-owner-answer", promptId: w.prompts[0]!, option: 0 });
  assert.deepEqual(await w.channel.check(resumed), { decision: "allow" });
  assert.equal(w.records.find(record => record.event === "delivered")?.callId, callId);
  assert.equal(w.channel.waiting(), false);
});

test("Code Mode PermissionRequest without an id inherits its nested call id", async () => {
  const rows = claudeModeHooks("hooks.jsonl");
  const w = workerRig([{ result: "none" }, { result: "none" }, { result: "deny", code: "unsafe", notice: "ignored" }]);
  const check = rows.find(row => row.hook_event_name === "PreToolUse" && row.tool_name === "Bash")!;
  await w.channel.check(check);
  const write = rows.find(row => row.hook_event_name === "PreToolUse" && row.tool_name === "Write")!;
  await w.channel.check(write);
  const permission = rows.find(row => row.hook_event_name === "PermissionRequest")!;
  assert.equal("tool_use_id" in permission, false);
  await w.channel.request(permission);
  const decide = w.requests.find(request => (request as { op?: string }).op === "decide") as { call: { toolUseId?: string } };
  assert.equal(decide.call.toolUseId, write.tool_use_id);
});

test("while a call waits, every other call of the session is denied as pending", async () => {
  const w = workerRig([owner]);
  assert.equal((await w.pre("deploy production", "toolu_1")).decision, "defer");
  for (const answer of [await w.pre("ls", "toolu_2"), await w.channel.request({ tool_name: "Bash", tool_input: { command: "ls" } })])
    assert.deepEqual(answer, { decision: "deny", reason: PENDING_NOTICE });
  assert.deepEqual(w.requests.map(request => (request as { op: string }).op).filter(op => op !== "delivery"), ["class"]);
});

test("a subagent's class call is denied as needs-owner and the owner is told; it is never deferred", async () => {
  const w = workerRig([owner]);
  assert.deepEqual(await w.pre("deploy production", "toolu_1", { agent_id: "agent-1" }), { decision: "deny", reason: requesterNotice("needs-owner") });
  assert.equal(w.channel.view().notice?.interruptClass, "production-or-staging");
  assert.equal(w.channel.view().waiting, undefined);
});

test("the owner's answer is returned once, only to the call it was given for", async () => {
  const w = workerRig([owner]);
  await w.pre("deploy production", "toolu_1");
  assert.equal(w.channel.exited(0), true);
  const promptId = w.prompts[0];
  w.channel.answer({ requestId: "a1", promptId, option: 0 });
  assert.equal(w.resumed, 1);
  await assert.rejects(async () => w.channel.answer({ requestId: "a2", promptId, option: 1 }), /prompt-changed/);
  assert.deepEqual(await w.pre("ls", "toolu_9"), { decision: "deny", reason: PENDING_NOTICE });
  assert.deepEqual(await w.pre("deploy production", "toolu_1"), { decision: "allow" });
  assert.deepEqual(await w.pre("deploy production", "toolu_1"), { decision: "deny", reason: requesterNotice("needs-owner") });
});

test("a class call the host denies is never deferred, and the owner is told with its class unless a halt denied it", async () => {
  const w = workerRig([{ result: "deny", code: "needs-owner", notice: "MODEL TEXT", interruptClass: "production-or-staging" }]);
  assert.deepEqual(await w.pre("deploy production", "toolu_1"), { decision: "deny", reason: requesterNotice("needs-owner") });
  assert.deepEqual([w.channel.view().notice?.interruptClass, w.channel.view().waiting, w.channel.exited(0)], ["production-or-staging", undefined, false]);
  const halted = workerRig([{ result: "deny", code: "unavailable", notice: requesterNotice("unavailable") }]);
  assert.deepEqual(await halted.pre("deploy production", "toolu_1"), { decision: "deny", reason: requesterNotice("unavailable") });
  assert.deepEqual([halted.channel.view().notice, halted.channel.exited(0)], [undefined, false]);
});

test("an owner's allow is withheld, and still used once, when the host refuses it at the resume or cannot be reached", async () => {
  for (const reply of [{ result: "withheld", reason: "halted" } as ChannelReply, new Error("ECONNREFUSED")]) {
    const w = workerRig([owner]);
    w.answerResume(reply);
    await w.pre("deploy production", "toolu_1");
    w.channel.exited(0);
    w.channel.answer({ requestId: "a1", promptId: w.prompts[0], option: 0 });
    assert.deepEqual(await w.pre("deploy production", "toolu_1"), { decision: "deny", reason: requesterNotice("unavailable") });
    assert.deepEqual([w.records.at(-1)?.event, w.records.at(-1)?.decision], ["delivered", "withheld"]);
    const ops = w.requests as Array<{ op: string; sessionRoot?: string; decisionId?: string; deliveryKey?: string; kind?: string }>;
    const resume = ops.find(request => request.op === "resume")!;
    assert.deepEqual([resume.sessionRoot, resume.decisionId, resume.deliveryKey], ["/workspace", (owner as { decisionId: string }).decisionId, "d".repeat(64)]);
    const { toolName, toolInput, toolUseId } = (resume as { call?: Record<string, unknown> }).call ?? {};
    assert.deepEqual([toolName, toolInput, toolUseId], ["Bash", { command: "deploy production" }, "toolu_1"]);
    assert.equal(ops.filter(request => request.op === "delivery").at(-1)?.kind, "stale");
    assert.deepEqual(await w.pre("deploy production", "toolu_1"), { decision: "deny", reason: requesterNotice("needs-owner") });
  }
  const refused = workerRig([owner]);
  refused.answerResume(new Error("ECONNREFUSED"));
  await refused.pre("deploy production", "toolu_1");
  refused.channel.exited(0);
  refused.channel.answer({ requestId: "a1", promptId: refused.prompts[0], option: 1 });
  assert.deepEqual(await refused.pre("deploy production", "toolu_1"), { decision: "deny", reason: OWNER_DENIED });
  assert.equal((refused.requests as Array<{ op: string }>).some(request => request.op === "resume"), false);
});

test("a resumed call that differs from the answered one is denied", async () => {
  const w = workerRig([owner]);
  await w.pre("deploy production", "toolu_1");
  w.channel.exited(0);
  w.channel.answer({ requestId: "a1", promptId: w.prompts[0], option: 0 });
  assert.deepEqual(await w.pre("deploy production --force", "toolu_1"), { decision: "deny", reason: requesterNotice("needs-owner") });
  assert.equal(w.records.at(-1)?.decision, "changed");
});

test("a waiting call is retired at the retention limit and the session ends", async () => {
  const w = workerRig([owner]);
  await w.pre("deploy production", "toolu_1");
  w.channel.exited(0);
  w.advance(DEFERRAL_RETENTION_MS - 60_000);
  w.channel.tick();
  assert.equal(w.ended, 0);
  w.advance(60_000);
  w.channel.tick();
  assert.equal(w.ended, 1);
  assert.deepEqual([w.records.at(-1)?.event, w.records.at(-1)?.reason], ["retired", "expired"]);
  assert.equal(w.channel.waiting(), false);
});

test("a provider that fails after deferring, or a resume that fails, retires the call", async () => {
  const failed = workerRig([owner]);
  await failed.pre("deploy production", "toolu_1");
  assert.equal(failed.channel.exited(1), false);
  assert.equal(failed.records.at(-1)?.reason, "provider-exited");
  const unresumable = workerRig([owner]);
  unresumable.failResume();
  await unresumable.pre("deploy production", "toolu_1");
  unresumable.channel.exited(0);
  unresumable.channel.answer({ requestId: "a1", promptId: unresumable.prompts[0], option: 0 });
  assert.equal(unresumable.ended, 1);
  assert.equal(unresumable.records.at(-1)?.reason, "resume-failed");
});

test("a host that cannot be reached denies the call as unavailable; a call the host does not serve is left to the provider", async () => {
  const w = workerRig([new Error("ECONNREFUSED"), { result: "not-served" }, new Error("timeout")]);
  assert.deepEqual(await w.pre("deploy production", "toolu_1"), { decision: "deny", reason: requesterNotice("unavailable") });
  assert.deepEqual(await w.pre("ls", "toolu_2"), { decision: "none" });
  assert.deepEqual(await w.channel.request({ tool_name: "Bash", tool_input: { command: "ls" } }), { decision: "deny", reason: requesterNotice("unavailable") });
});

test("a PermissionRequest carries the call id of its PreToolUse and only host text back", async () => {
  const w = workerRig([{ result: "none" }, { result: "deny", code: "unsafe", notice: "MODEL TEXT" }]);
  await w.pre("rm -rf scratch", "toolu_7");
  assert.deepEqual(await w.channel.request({ tool_name: "Bash", tool_input: { command: "rm -rf scratch" } }), { decision: "deny", reason: requesterNotice("unsafe") });
  const decide = w.requests[1] as { requestId: string; call: { toolUseId?: string } };
  assert.equal(decide.call.toolUseId, "toolu_7");
  assert.match(decide.requestId, /:toolu_7$/);
});

const decides = (w: ReturnType<typeof workerRig>) =>
  w.requests.filter(request => (request as { op?: string }).op === "decide") as Array<{ requestId: string; call: { toolUseId?: string } }>;
const raise = (w: ReturnType<typeof workerRig>, command: string, extra: Record<string, unknown> = {}) =>
  w.channel.request({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command }, ...extra });
const ownOrNone = (id: string | undefined, own: string) => assert.ok(id === undefined || id === own, `the request took ${id}, and its call is ${own}`);
async function resumeAfterDeferral(w: ReturnType<typeof workerRig>) {
  assert.equal((await w.pre("deploy production", "toolu_owner")).decision, "defer");
  assert.equal(w.channel.exited(0), true);
  w.channel.answer({ requestId: "a1", promptId: w.prompts[0]!, option: 0 });
  assert.deepEqual(await w.pre("deploy production", "toolu_owner"), { decision: "allow" });
}

test("identical calls open together: no PermissionRequest takes a call id until all of them are counted off", async () => {
  const w = workerRig([]);
  await w.pre("git status", "toolu_a");
  await w.pre("git status", "toolu_b");
  await raise(w, "git status");
  await w.pre("git status", "toolu_c");
  await raise(w, "git status");
  await raise(w, "git status");
  assert.deepEqual(decides(w).map(decide => decide.call.toolUseId), [undefined, undefined, undefined]);
  assert.equal(new Set(decides(w).map(decide => decide.requestId)).size, 3, "each request has an id of its own");
  assert.equal(decides(w).some(decide => /toolu_/.test(decide.requestId)), false);

  await w.pre("git status", "toolu_d");
  await raise(w, "git status");
  assert.equal(decides(w)[3]!.call.toolUseId, "toolu_d");
  assert.match(decides(w)[3]!.requestId, /:toolu_d$/);
});

test("every identical call open together is counted: a fourth call is not alone while one of three is still open", async () => {
  const w = workerRig([]);
  for (const id of ["toolu_a", "toolu_b", "toolu_c"]) await w.pre("git status", id);
  await raise(w, "git status");
  await raise(w, "git status");
  await w.pre("git status", "toolu_d");
  await raise(w, "git status");
  assert.deepEqual(decides(w).map(decide => decide.call.toolUseId), [undefined, undefined, undefined]);
});

test("identical calls one after the other each keep their own id, and a call id seen again while it alone is held is one call", async () => {
  const w = workerRig([]);
  await w.pre("git status", "toolu_a");
  await raise(w, "git status");
  await w.pre("git status", "toolu_b");
  await w.pre("git status", "toolu_b");
  await raise(w, "git status");
  assert.deepEqual(decides(w).map(decide => decide.call.toolUseId), ["toolu_a", "toolu_b"]);
});

test("a call id repeated among identical open calls gives no request another call's id", async () => {
  const w = workerRig([]);
  await w.pre("git status", "toolu_a");
  await w.pre("git status", "toolu_b");
  await w.pre("git status", "toolu_a");
  await raise(w, "git status");
  await raise(w, "git status");
  await w.pre("git status", "toolu_c");
  await raise(w, "git status");
  const ids = decides(w).map(decide => decide.call.toolUseId);
  assert.deepEqual(ids.slice(0, 2), [undefined, undefined]);
  ownOrNone(ids[2], "toolu_c");
});

test("a call the worker denied is not held, so its retry is alone and its request takes the retry's id", async () => {
  const w = workerRig([new Error("ECONNREFUSED")]);
  assert.deepEqual(await w.pre("ls", "toolu_1"), { decision: "deny", reason: requesterNotice("unavailable") });
  assert.deepEqual(await w.pre("ls", "toolu_2"), { decision: "none" });
  await raise(w, "ls");
  assert.equal(decides(w)[0]!.call.toolUseId, "toolu_2");
});

test("a PermissionRequest that names its call keeps that id and counts none of the identical calls off", async () => {
  const w = workerRig([]);
  await w.pre("git status", "toolu_a");
  await w.pre("git status", "toolu_b");
  await raise(w, "git status", { tool_use_id: "toolu_z" });
  await raise(w, "git status");
  await w.pre("git status", "toolu_c");
  await raise(w, "git status");
  assert.deepEqual(decides(w).map(decide => decide.call.toolUseId), ["toolu_z", undefined, undefined]);
});

test("a PermissionRequest that names a call takes the held call off only when it names that call", async () => {
  const w = workerRig([]);
  await w.pre("git status", "toolu_a");
  await raise(w, "git status", { tool_use_id: "toolu_z" });
  await raise(w, "git status");
  await w.pre("git status", "toolu_b");
  await raise(w, "git status", { tool_use_id: "toolu_b" });
  await raise(w, "git status");
  assert.deepEqual(decides(w).map(decide => decide.call.toolUseId), ["toolu_z", "toolu_a", "toolu_b", undefined]);
});

test("a call without an id is counted as open too, so its request never takes an identical call's id", async () => {
  const w = workerRig([]);
  const bare = (command: string) => w.channel.check({ hook_event_name: "PreToolUse", session_id: "native-1", tool_name: "Bash", tool_input: { command } });
  await w.pre("git status", "toolu_a");
  await bare("git status");
  await raise(w, "git status");
  await raise(w, "git status");
  await bare("git status");
  await raise(w, "git status");
  await w.pre("git status", "toolu_b");
  await raise(w, "git status");
  assert.deepEqual(decides(w).map(decide => decide.call.toolUseId), [undefined, undefined, undefined, "toolu_b"]);
});

test("a PermissionRequest denied as pending still counts its call off, so the retry's request takes the retry's id", async () => {
  const w = workerRig([{ result: "none" }, owner]);
  await w.pre("npm test", "toolu_1");
  assert.equal((await w.pre("deploy production", "toolu_2")).decision, "defer");
  assert.deepEqual(await raise(w, "npm test"), { decision: "deny", reason: PENDING_NOTICE });
  w.channel.retire("stopped");
  await w.pre("npm test", "toolu_3");
  await raise(w, "npm test");
  assert.deepEqual(decides(w).map(decide => decide.call.toolUseId), ["toolu_3"]);
});

test("past its bound the worker no longer trusts what it holds: an identical call does not look alone", async () => {
  const w = workerRig([]);
  await w.pre("git status", "toolu_a");
  for (let other = 0; other < OPEN_CALL_KEYS; other++) await w.pre(`echo ${other}`, `toolu_other_${other}`);
  await w.pre("git status", "toolu_b");
  await raise(w, "git status");
  await raise(w, "git status");
  await w.pre("npm test", "toolu_c");
  await raise(w, "npm test");
  const ids = decides(w).map(decide => decide.call.toolUseId);
  assert.deepEqual(ids.slice(0, 2), [undefined, undefined]);
  ownOrNone(ids[2], "toolu_c");
});

test("a late PermissionRequest of a provider that exited does not take the id of the next provider's identical call", async () => {
  const w = workerRig([{ result: "none" }, owner]);
  await w.pre("git status", "toolu_a");
  await resumeAfterDeferral(w);
  await w.pre("git status", "toolu_b");
  await raise(w, "git status");
  await raise(w, "git status");
  const ids = decides(w).map(decide => decide.call.toolUseId);
  ownOrNone(ids[0], "toolu_a");
  ownOrNone(ids[1], "toolu_b");
});

test("a call left open by a provider that exited gives its id to no request of the next provider", async () => {
  const w = workerRig([{ result: "none" }, owner]);
  await w.pre("git status", "toolu_a");
  await resumeAfterDeferral(w);
  await w.pre("git status", "toolu_b");
  await raise(w, "git status");
  ownOrNone(decides(w)[0]!.call.toolUseId, "toolu_b");
});

function hostRig(pipeline: PermissionPipeline, headless: Session["headless"] = { channel: true },
  extra: { team?: Session["team"]; teamLive?: (session: Session) => boolean } = {}) {
  const root = realpathSync(mkdtempSync("/tmp/inf-headless-host-"));
  const key = randomBytes(32);
  const session = { id: randomUUID(), projectId: "rehearsal", provider: "claude", cwd: root, title: "T", initialPrompt: "do it", headless, ...(extra.team ? { team: extra.team } : {}) } as Session;
  const channel = new HeadlessPermissionChannel({
    key, runDir: root, services: { pipeline },
    sessions: { meta: () => ({ session }), list: async () => [{ id: session.id, status: "running", headless }] },
    ...(extra.teamLive ? { teamLive: extra.teamLive } : {}),
    ...(extra.team ? { teamTask: () => ({ title: "Team task", text: "Run objective" }) } : {}),
  });
  const ask = (request: Record<string, unknown>) => channel.handle({ v: 1, sessionId: session.id, token: channelToken(key, session.id), ...request });
  return { channel, session, key, ask, done: () => rmSync(root, { recursive: true, force: true }) };
}
const bash = (command: string, toolUseId = "toolu_1") => ({ toolName: "Bash", toolInput: { command }, toolUseId });

test("the channel answers only the session its key was made for", async () => {
  const fake = fakePipeline();
  const h = hostRig(fake.pipeline);
  try {
    await assert.rejects(h.channel.handle({ v: 1, sessionId: h.session.id, token: channelToken(randomBytes(32), h.session.id), op: "class", call: bash("ls") }), /unbound/);
    const decisionId = randomUUID();
    await assert.rejects(h.ask({ op: "delivery", decisionId, kind: "receipt" }), /unbound/);
    await assert.rejects(h.ask({ op: "delivery", decisionId, deliveryKey: deliveryKey(h.key, randomUUID(), decisionId), kind: "receipt" }), /unbound/);
    assert.deepEqual(await h.ask({ op: "delivery", decisionId, deliveryKey: deliveryKey(h.key, h.session.id, decisionId), kind: "receipt" }), { result: "recorded" });
    assert.deepEqual(fake.deliveries.map(d => d.decisionId), [decisionId]);
  } finally { h.done(); }
});

const member = { runId: "run-1", memberId: "member-1", revision: 1, role: "implementer", taskId: "task-a" } as NonNullable<Session["team"]>;

test("a team member's call is decided only while its run is live, checked again before an allow", async () => {
  for (const teamLive of [undefined, () => false, () => { throw new Error("no run"); }]) {
    const fake = fakePipeline();
    const h = hostRig(fake.pipeline, { channel: true }, { team: member, ...(teamLive ? { teamLive } : {}) });
    try {
      assert.deepEqual(await h.ask({ op: "class", call: bash("deploy production") }), { result: "not-served" });
      assert.deepEqual(await h.ask({ op: "decide", call: bash("make safe-build"), requestId: `headless:${h.session.id}:toolu_1` }), { result: "not-served" });
      assert.equal(fake.decided.length, 0);
    } finally { h.done(); }
  }
  const served = hostRig(fakePipeline().pipeline, { channel: true }, { team: member, teamLive: () => true });
  try {
    assert.equal((await served.ask({ op: "class", call: bash("deploy production") })).result, "owner");
    assert.equal((await served.ask({ op: "decide", call: bash("make safe-build"), requestId: `headless:${served.session.id}:toolu_1` })).result, "allow");
  } finally { served.done(); }
  let checks = 0;
  const stopped = fakePipeline();
  const h = hostRig(stopped.pipeline, { channel: true }, { team: member, teamLive: () => ++checks === 1 });
  try {
    assert.deepEqual(await h.ask({ op: "decide", call: bash("make safe-build"), requestId: `headless:${h.session.id}:toolu_1` }), { result: "not-served" });
    assert.deepEqual([checks, stopped.deliveries.map(d => d.kind)], [2, ["stale"]]);
  } finally { h.done(); }
});

test("a team member's headless seat is the interactive team adapter's, so their rejects and locks are shared", async () => {
  const fake = fakePipeline();
  for (const team of [member, { ...member, taskId: undefined }]) {
    const h = hostRig(fake.pipeline, { channel: true }, { team, teamLive: () => true });
    try { await h.ask({ op: "decide", call: bash("make safe-build"), requestId: `headless:${h.session.id}:toolu_1` }); }
    finally { h.done(); }
  }
  assert.deepEqual(fake.decided.map(request => request.requester.assignment), ["team:run-1:implementer:task:task-a", "team:run-1:implementer"]);
});

test("a class call waits only on a recorded owner decision: a halt denies it as unavailable, any other outcome needs the owner", async () => {
  const held = fakePipeline({ decide: async () => ({ kind: "held" }) });
  const h = hostRig(held.pipeline);
  try {
    assert.deepEqual(await h.ask({ op: "class", call: bash("deploy production") }), { result: "deny", code: "unavailable", notice: requesterNotice("unavailable") });
    assert.equal(held.deliveries.length, 0);
  } finally { h.done(); }
  const needsOwner = { result: "deny", code: "needs-owner", notice: requesterNotice("needs-owner"), interruptClass: "production-or-staging" };
  for (const decide of [async () => ({ kind: "undeliverable", reason: "no ledger" }), async () => { throw new Error("journal down"); }]) {
    const other = hostRig(fakePipeline({ decide: decide as PermissionPipeline["decide"] }).pipeline);
    try { assert.deepEqual(await other.ask({ op: "class", call: bash("deploy production") }), needsOwner); }
    finally { other.done(); }
  }
  const decisionId = randomUUID();
  const allowed = fakePipeline({ decide: async () => ({ kind: "allow", decisionId, strongTier: true }) });
  const a = hostRig(allowed.pipeline);
  try {
    assert.deepEqual(await a.ask({ op: "class", call: bash("deploy production") }), { ...needsOwner, decisionId, deliveryKey: deliveryKey(a.key, a.session.id, decisionId) });
    assert.deepEqual(allowed.deliveries.map(d => [d.decisionId, d.kind]), [[decisionId, "refusal"]]);
  } finally { a.done(); }
});

test("an allow is returned only while it still applies, and a destructive one only from the strong tier", async () => {
  const stale = fakePipeline({ applicable: () => false, decide: async () => ({ kind: "allow", decisionId: randomUUID(), strongTier: false }) });
  const h = hostRig(stale.pipeline);
  try {
    assert.deepEqual(await h.ask({ op: "decide", call: bash("make safe-build"), requestId: `headless:${h.session.id}:toolu_1` }), { result: "not-served" });
    assert.equal(stale.deliveries[0].kind, "stale");
  } finally { h.done(); }
  const weak = hostRig(fakePipeline({ decide: async () => ({ kind: "allow", decisionId: randomUUID(), strongTier: false }) }).pipeline);
  try {
    const reply = await weak.ask({ op: "decide", call: bash("rm -rf build"), requestId: `headless:${weak.session.id}:toolu_1` });
    assert.equal(reply.result === "deny" && reply.code, "uncertain");
  } finally { weak.done(); }
});

test("a reject is returned only while it still applies, and a halt recorded while the call was decided denies it as unavailable", async () => {
  const stale = fakePipeline({ applicable: () => false });
  const h = hostRig(stale.pipeline);
  try {
    assert.deepEqual(await h.ask({ op: "decide", call: bash("npm publish"), requestId: `headless:${h.session.id}:toolu_1` }), { result: "not-served" });
    assert.deepEqual(stale.deliveries.map(entry => entry.kind), ["stale"]);
  } finally { h.done(); }
  let halted = false;
  const halting = fakePipeline({
    decide: async () => { halted = true; return { kind: "reject", decisionId: randomUUID(), code: "unsafe", notice: "MODEL TEXT" }; },
    applicable: () => !halted,
    halted: () => halted,
  });
  const g = hostRig(halting.pipeline);
  try {
    const reply = await g.ask({ op: "decide", call: bash("npm publish"), requestId: `headless:${g.session.id}:toolu_2` });
    assert.deepEqual(reply, { result: "deny", code: "unavailable", notice: requesterNotice("unavailable") });
    assert.deepEqual(halting.deliveries.map(entry => entry.kind), ["stale"]);
  } finally { g.done(); }
});

test("the resume check withholds an owner's allow from a team member whose run is no longer live", async () => {
  let live = true;
  const h = hostRig(fakePipeline().pipeline, { channel: true },
    { team: { runId: "run-1", memberId: "m-1", revision: 1, role: "implementer", taskId: "task-a" }, teamLive: () => live });
  try {
    const decisionId = randomUUID();
    const resume = () => h.ask({ op: "resume", sessionRoot: h.session.cwd, decisionId, deliveryKey: deliveryKey(h.key, h.session.id, decisionId) });
    assert.deepEqual(await resume(), { result: "ok" });
    live = false;
    assert.deepEqual(await resume(), { result: "withheld", reason: "stale" });
  } finally { h.done(); }
});

test("the resume check confirms an owner's allow only without a halt, while its decision applies, for the session it was issued to", async () => {
  let halted: () => boolean = () => false;
  let applies = true;
  const h = hostRig(fakePipeline({ halted: projectId => halted() && projectId === "rehearsal", applicable: () => applies }).pipeline);
  try {
    const decisionId = randomUUID();
    const resume = (extra: Record<string, unknown> = {}) =>
      h.ask({ op: "resume", sessionRoot: h.session.cwd, decisionId, deliveryKey: deliveryKey(h.key, h.session.id, decisionId), ...extra });
    assert.deepEqual(await resume(), { result: "ok" });
    assert.deepEqual(await resume({ decisionId: undefined, deliveryKey: undefined }), { result: "withheld", reason: "stale" });
    halted = () => true;
    assert.deepEqual(await resume(), { result: "withheld", reason: "halted" });
    assert.deepEqual(await resume({ decisionId: undefined, deliveryKey: undefined }), { result: "withheld", reason: "halted" });
    halted = () => { throw new Error("halt unreadable"); };
    assert.deepEqual(await resume(), { result: "withheld", reason: "halted" });
    halted = () => false;
    applies = false;
    assert.deepEqual(await resume(), { result: "withheld", reason: "stale" });
    applies = true;
    assert.deepEqual(await resume({ sessionRoot: "/elsewhere" }), { result: "withheld", reason: "stale" });
    await assert.rejects(resume({ deliveryKey: undefined }), /unbound/);
    await assert.rejects(resume({ deliveryKey: deliveryKey(h.key, randomUUID(), decisionId) }), /unbound/);
    await assert.rejects(resume({ sessionRoot: undefined }), /invalid/);
  } finally { h.done(); }
});

test("the resume check reads the resumed call again, with the task as it is now", async () => {
  const seen: Array<PermissionRequest | undefined> = [];
  let applies = true;
  const fake = fakePipeline({ applicable: (_id, request) => { seen.push(request); return applies; } });
  const h = hostRig(fake.pipeline);
  try {
    await h.ask({ op: "class", call: { ...bash("deploy production", "toolu_8"), nativeSessionId: "native-1" } });
    const first = randomUUID();
    await h.ask({ op: "resume", sessionRoot: h.session.cwd, decisionId: first, deliveryKey: deliveryKey(h.key, h.session.id, first), call: { ...bash("deploy production", "toolu_8"), nativeSessionId: "native-2" } });
    assert.deepEqual(seen.at(-1), fake.decided.at(-1));
    const decisionId = randomUUID();
    const resume = (extra: Record<string, unknown> = {}) =>
      h.ask({ op: "resume", sessionRoot: h.session.cwd, decisionId, deliveryKey: deliveryKey(h.key, h.session.id, decisionId), ...extra });
    assert.deepEqual(await resume({ call: bash("deploy production", "toolu_9") }), { result: "ok" });
    const again = seen.at(-1)!;
    assert.deepEqual([again.id, again.action, again.requester.task], [`headless:${h.session.id}:toolu_9`, "deploy production", { title: "T", text: "do it" }]);
    h.session.title = "Another task";
    await resume({ call: bash("deploy production", "toolu_9") });
    assert.equal(seen.at(-1)!.requester.task.title, "Another task");
    applies = false;
    assert.deepEqual(await resume({ call: bash("deploy production", "toolu_9") }), { result: "withheld", reason: "stale" });
    applies = true;
    await assert.rejects(resume({ call: { toolName: "Bash" } }), /invalid/);
    assert.deepEqual(await resume(), { result: "ok" });
    assert.equal(seen.at(-1), undefined);
  } finally { h.done(); }
});

test("a verdict is withheld when the session's task changed while the call was decided", async () => {
  let rig: ReturnType<typeof hostRig>;
  const changing = fakePipeline({ decide: async () => { rig.session.initialPrompt = "do something else"; return { kind: "allow", decisionId: randomUUID(), strongTier: false }; } });
  const h = rig = hostRig(changing.pipeline);
  try {
    assert.deepEqual(await h.ask({ op: "decide", call: bash("make safe-build"), requestId: `headless:${h.session.id}:toolu_1` }), { result: "not-served" });
    assert.deepEqual(changing.deliveries.map(entry => entry.kind), ["stale"]);
  } finally { h.done(); }
});

test("a session admitted without the channel is not served even when the pipeline serves its project", async () => {
  const h = hostRig(fakePipeline().pipeline, { channel: false, reason: "x" });
  try { assert.deepEqual(await h.ask({ op: "class", call: bash("deploy production") }), { result: "not-served" }); }
  finally { h.done(); }
});

test("admission serves only a Claude --print launch in the default permission mode, with the host's hooks", () => {
  const { pipeline } = fakePipeline();
  const channel = new HeadlessPermissionChannel({ key: randomBytes(32), runDir: "/tmp", services: { pipeline }, sessions: { meta: () => { throw new Error(); }, list: async () => [] } });
  const session = { id: randomUUID(), projectId: "rehearsal" } as Session;
  const admit = (args: string[], extra: Partial<Parameters<typeof channel.admit>[0]> = {}) =>
    channel.admit({ provider: "claude", profile: { command: "claude", args }, session, hooks: true, ...extra });
  assert.equal(admit(["--model", "opus"]), undefined);
  assert.equal(admit(["-p"])?.record.channel, true);
  assert.equal(admit(["-p", "--resume", "abc"])?.record.channel, true);
  assert.match(admit(["-p", "--permission-mode", "dontAsk"])?.record.reason ?? "", /dontAsk/);
  assert.match(admit(["-p", "--dangerously-skip-permissions"])?.record.reason ?? "", /skip-permissions/);
  assert.match(admit(["-p", "--settings", "x.json"])?.record.reason ?? "", /--settings/);
  assert.match(admit(["-p"], { hooks: false })?.record.reason ?? "", /hooks/);
  assert.match(admit(["-p"], { session: { ...session, team: { role: "permission-coordinator" } } as Session })?.record.reason ?? "", /never served/);
  assert.match(channel.admit({ provider: "codex", profile: { command: "codex", args: ["exec"] }, session, hooks: true })?.record.reason ?? "", /Codex/);
  const none = new HeadlessPermissionChannel({ key: randomBytes(32), runDir: "/tmp", services: {}, sessions: { meta: () => { throw new Error(); }, list: async () => [] } });
  assert.match(none.admit({ provider: "claude", profile: { command: "claude", args: ["-p"] }, session, hooks: true })?.record.reason ?? "", /not on this host/);
});

test("an open deferred call is found in the journal until it is delivered", () => {
  const events = (...data: Array<Record<string, unknown>>) => (after: number) =>
    ({ events: data.slice(after).map((d, i) => ({ seq: after + i + 1, type: "lifecycle", data: { permissionChannel: d } }) as unknown as Event), cursor: data.length, more: false });
  assert.equal(deferredCallOpen(events({ event: "deferred", callId: "a" })), true);
  assert.equal(deferredCallOpen(events({ event: "deferred", callId: "a" }, { event: "retired", callId: "a" })), true);
  assert.equal(deferredCallOpen(events({ event: "deferred", callId: "a" }, { event: "delivered", callId: "a" })), false);
});

test("the channel hook prints a provider decision only for a decision", () => {
  assert.equal(hookOutput("check", { decision: "none" }), "");
  assert.deepEqual(JSON.parse(hookOutput("check", { decision: "defer", reason: "wait" })), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer", permissionDecisionReason: "wait" } });
  assert.deepEqual(JSON.parse(hookOutput("request", { decision: "defer" })).hookSpecificOutput.decision, { behavior: "deny", message: requesterNotice("unavailable") });
});

test("each resume the worker performed owes one continue: the first prompt after it is marked, and nothing else", async () => {
  const w = workerRig([owner, { ...owner, decisionId: randomUUID() }]);
  const mark = (signals: Parameters<typeof claudeTurnSignals>[0]) => claudeTurnSignals(signals, () => w.channel.takeContinue());
  const prompt = { kind: "turn-start" as const, prompt: "Continue from where you left off." };
  const next = { kind: "turn-start" as const, prompt: "next" };
  const toolEnd = { kind: "tool-end" as const, tool: "Bash", ok: true };
  assert.deepEqual(mark([prompt]), [prompt], "before any resume a prompt is a person's");
  await resumeAfterDeferral(w);
  assert.deepEqual(mark([toolEnd]), [toolEnd]);
  assert.deepEqual(mark([prompt, next]), [{ ...prompt, automatic: true }, next], "only the first prompt after the resume is the provider's");
  assert.deepEqual(mark([prompt]), [prompt], "the answer is taken once");
  assert.equal((await w.pre("deploy staging", "toolu_second")).decision, "defer");
  assert.equal(w.channel.exited(0), true);
  w.channel.answer({ requestId: "a2", promptId: w.prompts[1]!, option: 1 });
  assert.deepEqual(await w.pre("deploy staging", "toolu_second"), { decision: "deny", reason: OWNER_DENIED });
  assert.equal(w.resumed, 2);
  assert.deepEqual(mark([toolEnd, prompt]), [toolEnd, { ...prompt, automatic: true }], "the second resume owes one too");
  const unresumable = workerRig([owner]);
  unresumable.failResume();
  await unresumable.pre("deploy production", "toolu_1");
  unresumable.channel.exited(0);
  unresumable.channel.answer({ requestId: "a1", promptId: unresumable.prompts[0]!, option: 0 });
  assert.equal(unresumable.channel.takeContinue(), false, "a resume that fails owes no continue");
});
