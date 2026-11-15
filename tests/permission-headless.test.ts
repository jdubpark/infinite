// The headless permission channel (INF-246). The first tests run the real worker, hook commands and channel socket
// against a scripted `claude --print` (tests/fixtures/headless-claude.mjs) and a fake pipeline. The rest drive the
// channel's two halves directly. Run alone: node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 FILE
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Manager } from "../packages/host/src/manager.js";
import { workerCall } from "../packages/host/src/ipc.js";
import {
  HeadlessPermissionChannel, channelToken, deferredCallOpen, type ChannelReply,
} from "../packages/host/src/permission-headless.js";
import {
  DEFERRAL_RETENTION_MS, HeadlessChannelWorker, OWNER_DENIED, PENDING_NOTICE, type ChannelWorkerHost,
} from "../packages/host/src/permission-headless-worker.js";
import { hookOutput } from "../packages/host/src/permission-hook.js";
import { requesterNotice } from "../packages/host/src/permission-policy.js";
import type { PermissionAgentServices, PermissionOutcome, PermissionPipeline, PermissionRequest } from "../packages/host/src/permission-agent-types.js";
import type { Config, Event, Session } from "../packages/host/src/types.js";
import { stopSessionWorkers, waitFor } from "./helpers.js";

const FAKE = resolve("tests/fixtures/headless-claude.mjs");

/** Production calls belong to the owner; `safe-build` is allowed; anything else is rejected with a model's note. */
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

/** An in-process Manager and channel with a real worker per session, under a short /tmp path for Unix sockets. */
async function rig(options: { args?: string[]; pipeline?: PermissionPipeline } = {}) {
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
  const fake = fakePipeline();
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
    // The open call the pipeline allowed ran; the rejected one got the host's fixed notice, never the model's text.
    assert.equal(r.log("ran.log"), "make safe-build\n");
    assert.equal(r.log("denied.log"), `rm -rf scratch: ${requesterNotice("unsafe")}\n`);
    assert.doesNotMatch(r.log("denied.log"), /MODEL TEXT/);
    // The provider ended its run; the session stays open with one owner prompt that no delegated review can take.
    assert.equal(waiting.status, "running");
    assert.equal(waiting.permissionChannel?.waiting?.interruptClass, "production-or-staging");
    const prompt = waiting.attention.prompt!;
    assert.equal(prompt.source, "protocol");
    // The clients offer options for a prompt with a hash; no delegated review takes a `protocol` prompt.
    assert.match((prompt as { hash?: string }).hash ?? "", /^[a-f0-9]{64}$/);
    const row = (await r.manager.list()).find(item => item.id === id) as unknown as { attention: { prompt: { delegable?: boolean } } };
    assert.equal(row.attention.prompt.delegable, undefined);
    assert.deepEqual(prompt.options.map(option => option.label), ["Yes, allow once", "No", "No, and tell Claude what to do differently"]);
    // Input cannot reach a provider that is not running: it is refused, not lost.
    await assert.rejects(workerCall(r.config.runDir, id, { op: "input", requestId: randomUUID(), text: "hello", submit: true }), /prompt-open/);
    const requestId = randomUUID();
    const answer = await workerCall<{ state: string; result: string }>(r.config.runDir, id, { op: "answer", requestId, promptId: prompt.id, option: 0 });
    assert.equal(answer.state, "delivered");
    // A retry gets the same receipt; a second answer finds no prompt.
    assert.deepEqual(await workerCall(r.config.runDir, id, { op: "answer", requestId, promptId: prompt.id, option: 0 }), answer);
    await assert.rejects(workerCall(r.config.runDir, id, { op: "answer", requestId: randomUUID(), promptId: prompt.id, option: 1 }), /prompt-changed/);
    await waitFor(() => live(r, id), s => s.status === "exited", 30_000);
    assert.equal(r.log("ran.log"), "make safe-build\ndeploy production\n");
    const events = r.channelEvents(id).map(event => event.event);
    assert.deepEqual(events.filter(event => event !== "pending"), ["deferred", "waiting", "answer", "resumed", "delivered"]);
    // The owner decision is linked to its delivery events: deferral, the owner's answer, and the resumed call.
    const owner = r.decided.find(request => /production/.test(request.action))!;
    assert.equal(owner.requester.kind, "headless");
    assert.equal(owner.requester.sessionRoot, realpathSync(r.workspace));
    assert.deepEqual(r.deliveries.filter(d => /deferred|owner allowed|returned to the resumed/.test(d.detail ?? "")).map(d => d.kind), ["intent", "intent", "receipt"]);
    // The conversation has no call left open, so an ordinary resume is not refused for it.
    assert.equal(deferredCallOpen((after, limit) => r.manager.events(id, after, limit)), false);
  } finally { await r.stop(); }
});

test("an owner's refusal reaches the call with the host's notice and the owner's direction, and the call never runs", { timeout: 90_000 }, async () => {
  const r = await rig({ args: ["--allowedTools", "Bash(deploy production)"] });
  try {
    const id = randomUUID();
    await r.manager.create({ requestId: id, provider: "claude", projectId: "rehearsal", title: "Headless", prompt: "allowlisted" });
    // The profile's allow rule is outranked: `permissions status` lists it, and the call still waits.
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
    // An ordinary resume has no channel: the provider's allow list would decide the call the owner was asked about.
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
    // Without the channel the allow list decides, as it did before.
    assert.equal(r.log("ran.log"), "deploy production\n");
  } finally { await r.stop(); }
});

/* ------------------------------------------------------------------ the worker half, with a fake host */

function workerRig(replies: Array<ChannelReply | Error>) {
  const records: Array<Record<string, unknown>> = [];
  const requests: unknown[] = [];
  const prompts: number[] = [];
  const closed: Array<[number, string]> = [];
  let now = Date.parse("2026-11-14T10:00:00.000Z");
  let ended = 0, resumed = 0, resumeFails = false;
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
      const reply = replies.shift() ?? { result: "none" };
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
  };
}
const owner: ChannelReply = { result: "owner", interruptClass: "production-or-staging", rule: "production-deploy", decisionId: randomUUID() };

test("while a call waits, every other call of the session is denied as pending", async () => {
  const w = workerRig([owner]);
  assert.equal((await w.pre("deploy production", "toolu_1")).decision, "defer");
  for (const answer of [await w.pre("ls", "toolu_2"), await w.channel.request({ tool_name: "Bash", tool_input: { command: "ls" } })])
    assert.deepEqual(answer, { decision: "deny", reason: PENDING_NOTICE });
  // Only the class check asked the host: a pending call starts no review.
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
  // A different call id waiting behind the resumed one is still pending.
  assert.deepEqual(await w.pre("ls", "toolu_9"), { decision: "deny", reason: PENDING_NOTICE });
  assert.deepEqual(await w.pre("deploy production", "toolu_1"), { decision: "allow" });
  // The same call again, once the answer was used, is the owner's again.
  assert.deepEqual(await w.pre("deploy production", "toolu_1"), { decision: "deny", reason: requesterNotice("needs-owner") });
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

/* ------------------------------------------------------------------ the host half */

function hostRig(pipeline: PermissionPipeline, headless: Session["headless"] = { channel: true }) {
  const root = realpathSync(mkdtempSync("/tmp/inf-headless-host-"));
  const key = randomBytes(32);
  const session = { id: randomUUID(), projectId: "rehearsal", provider: "claude", cwd: root, title: "T", initialPrompt: "do it", headless } as Session;
  const channel = new HeadlessPermissionChannel({
    key, runDir: root, services: { pipeline },
    sessions: { meta: () => ({ session }), list: async () => [{ id: session.id, status: "running", headless }] },
  });
  const ask = (request: Record<string, unknown>) => channel.handle({ v: 1, sessionId: session.id, token: channelToken(key, session.id), ...request });
  return { channel, session, key, ask, done: () => rmSync(root, { recursive: true, force: true }) };
}
const bash = (command: string, toolUseId = "toolu_1") => ({ toolName: "Bash", toolInput: { command }, toolUseId });

test("the channel answers only the session its key was made for", async () => {
  const h = hostRig(fakePipeline().pipeline);
  try {
    await assert.rejects(h.channel.handle({ v: 1, sessionId: h.session.id, token: channelToken(randomBytes(32), h.session.id), op: "class", call: bash("ls") }), /unbound/);
    await assert.rejects(h.ask({ op: "delivery", decisionId: randomUUID(), kind: "receipt" }), /unbound/);
  } finally { h.done(); }
});

test("a class rule sends the call to the owner whatever else the pipeline returns", async () => {
  const h = hostRig(fakePipeline({ decide: async () => ({ kind: "allow", decisionId: randomUUID(), strongTier: true }) }).pipeline);
  try {
    assert.deepEqual(await h.ask({ op: "class", call: bash("deploy production") }), { result: "owner", interruptClass: "production-or-staging", rule: "production-deploy" });
  } finally { h.done(); }
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
  // A PermissionRequest hook cannot defer: anything but an allow is a deny.
  assert.deepEqual(JSON.parse(hookOutput("request", { decision: "defer" })).hookSpecificOutput.decision, { behavior: "deny", message: requesterNotice("unavailable") });
});
