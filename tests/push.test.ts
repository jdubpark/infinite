import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PushStore, expoSender } from "../packages/host/src/push.js";
import { Notifier } from "../packages/host/src/notifier.js";
import type { Attention } from "@infinite/attention";

const att = (state: Attention["state"], promptId?: number): Attention => ({
  state, since: "t", source: "hook", now: state === "needs-you" ? "Do you want to proceed? rm -rf build" : "Finished a turn",
  prompt: promptId ? { id: promptId, kind: "permission", title: "Do you want to proceed?", options: [], acceptsText: false, source: "hook" } : undefined,
  lastActivityAt: "t", hooks: "active", hookErrors: 0, sawTurnEnd: false,
});

test("store adds once per token and removes", () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("controller", "ExponentPushToken[a]", "android");
  store.add("controller", "ExponentPushToken[a]", "android");
  store.add("viewer", "ExponentPushToken[b]", "ios");
  assert.equal(store.list().length, 2);
  store.remove("ExponentPushToken[a]");
  assert.deepEqual(store.list().map((d) => d.token), ["ExponentPushToken[b]"]);
  rmSync(dir, { recursive: true, force: true });
});

test("notifier sends once per transition, minimal body, prunes unregistered tokens", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("controller", "ExponentPushToken[a]", "android");
  store.add("viewer", "ExponentPushToken[dead]", "android");
  const sent: unknown[][] = [];
  const sessions = [{ id: "s1", title: "Retry logic", provider: "claude", status: "running", attention: att("working") }];
  const manager = { list: async () => sessions } as never;
  const sender = async (messages: { to: string }[]) => { sent.push(messages); return messages.map((m) => m.to.includes("dead") ? { status: "error" as const, details: { error: "DeviceNotRegistered" } } : { status: "ok" as const, id: "x" }); };
  const notifier = new Notifier(manager, store, sender, { detail: "minimal", events: ["needs-you", "turn-finished", "exited", "recording-error"], intervalMs: 100000 });
  await notifier.tick();                 // baseline, no sends
  sessions[0].attention = att("needs-you", 7);
  await notifier.tick();
  await notifier.tick();                 // same prompt: no second send
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 2);
  const first = sent[0][0] as { title: string; body: string; data: { url: string }; collapseId: string; priority: string };
  assert.equal(first.title, "Needs your approval");
  assert.equal(first.body, "Claude Code needs your approval in Retry logic");
  assert.equal(first.data.url, "/session/s1");
  assert.equal(first.collapseId, "s1");
  assert.equal(first.priority, "high");
  assert.deepEqual(store.list().map((d) => d.token), ["ExponentPushToken[a]"]);
  sessions[0].attention = att("needs-you", 8);
  await notifier.tick();                 // new prompt id: a new send
  assert.equal(sent.length, 2);
  sessions[0].attention = att("turn-finished");
  await notifier.tick();
  assert.equal((sent[2][0] as { body: string }).body, "Retry logic finished a turn");
  sessions[0].attention = att("working");
  await notifier.tick();                 // working is not a push event
  assert.equal(sent.length, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("notifier prunes absent listings and does not reannounce returning ids", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("owner", "ExponentPushToken[a]", "ios");
  const sent: unknown[][] = [];
  const sender = async (messages: unknown[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
  const session = { id: "s1", title: "Retry logic", provider: "claude", status: "running", attention: att("working") };
  const sessions = [session];
  const teams = [{ id: "t1", title: "Build", status: "planning" }];
  const goals = [{ id: "g1", title: "Ship", status: "running" }];
  let listFails = false;
  const notifier = new Notifier(
    { list: async () => { if (listFails) throw new Error("listing unavailable"); return sessions; } } as never,
    store, sender, { detail: "minimal", events: ["needs-you", "team-stuck", "goal-stuck"], intervalMs: 100000 },
    { statuses: () => teams }, { statuses: () => goals },
  );
  const maps = notifier as unknown as { seen: Map<string, string>; teamStatus: Map<string, string>; goalStatus: Map<string, string> };
  try {
    await notifier.tick();
    session.attention = att("needs-you", 1);
    teams[0].status = "blocked";
    goals[0].status = "blocked";
    await notifier.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 3);

    listFails = true;
    sessions.length = 0;
    await notifier.tick();
    assert.equal(maps.seen.size, 1, "a failed session listing keeps its previous baseline");
    listFails = false;
    sessions.push(session);
    await notifier.tick();
    assert.equal(sent.length, 1, "a failed listing does not make the same attention state look new");

    sessions.length = 0;
    teams.length = 0;
    goals.length = 0;
    await notifier.tick();
    assert.deepEqual([maps.seen.size, maps.teamStatus.size, maps.goalStatus.size], [0, 0, 0]);

    sessions.push(session);
    teams.push({ id: "t1", title: "Build", status: "blocked" });
    goals.push({ id: "g1", title: "Ship", status: "blocked" });
    await notifier.tick();
    assert.equal(sent.length, 1, "returning ids keep their last state and do not repeat the same push");

    session.attention = att("working");
    teams[0].status = "planning";
    goals[0].status = "running";
    await notifier.tick();
    session.attention = att("needs-you", 2);
    teams[0].status = "blocked";
    goals[0].status = "blocked";
    await notifier.tick();
    assert.equal(sent.length, 2, "new transitions after a return still send");
    assert.equal(sent[1].length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full-detail turn-finished push prefers the cached phone reading", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("owner", "ExponentPushToken[a]", "android");
  const sent: { body: string }[][] = [];
  const sessions = [{ id: "s1", title: "Retry logic", provider: "claude", status: "running", attention: att("working"), reading: { now: { text: "The retry path now preserves worker state.", source: "jev" as const, for: "hash", at: "t" } } }];
  const notifier = new Notifier({ list: async () => sessions } as never, store,
    async (messages: { body: string }[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); },
    { detail: "full", events: ["turn-finished"], intervalMs: 100000 });
  await notifier.tick();
  sessions[0].attention = att("turn-finished");
  await notifier.tick();
  assert.equal(sent[0][0].body, "The retry path now preserves worker state.");
  rmSync(dir, { recursive: true, force: true });
});

test("expo sender posts the Expo push payload with a bearer token", async () => {
  let seen: { auth?: string; body: unknown } | undefined;
  const server = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { seen = { auth: req.headers.authorization, body: JSON.parse(b) }; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ status: "ok", id: "t1" }] })); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const send = expoSender({ endpoint: `http://127.0.0.1:${port}/push/send`, accessToken: "exp-token" });
  const tickets = await send([{ to: "ExponentPushToken[a]", title: "T", body: "B", data: { url: "/session/x" }, channelId: "attention", priority: "high", collapseId: "x" }]);
  assert.deepEqual(tickets, [{ status: "ok", id: "t1" }]);
  assert.equal(seen?.auth, "Bearer exp-token");
  assert.equal((seen?.body as unknown[]).length, 1);
  server.close();
});

test("a short ticket array becomes per-message errors and prunes nothing", async () => {
  const server = createServer((req, res) => { req.resume(); req.on("end", () => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] })); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const send = expoSender({ endpoint: `http://127.0.0.1:${port}/push/send` });
  const message = (to: string) => ({ to, title: "T", body: "B", data: { url: "/session/x" }, channelId: "attention" as const, priority: "high" as const, collapseId: "x" });
  const tickets = await send([message("ExponentPushToken[a]"), message("ExponentPushToken[b]")]);
  assert.deepEqual(tickets, [{ status: "error", message: "unexpected ticket count" }, { status: "error", message: "unexpected ticket count" }]);
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("controller", "ExponentPushToken[a]", "android");
  store.add("viewer", "ExponentPushToken[b]", "android");
  const sessions = [{ id: "s1", title: "R", provider: "claude", status: "running", attention: att("working") }];
  const notifier = new Notifier({ list: async () => sessions } as never, store, send, { detail: "minimal", events: ["needs-you"], intervalMs: 100000 });
  await notifier.tick();
  sessions[0].attention = att("needs-you", 1);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { warnings.push(m); };
  try { await notifier.tick(); } finally { console.warn = warn; }
  assert.deepEqual(warnings, ["push: unexpected ticket count"]);
  assert.equal(store.list().length, 2);
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a team run is flagged once when it becomes blocked, never for a run already blocked at startup", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("owner", "ExponentPushToken[a]", "ios");
  const sent: { title: string; body: string; data: { url: string; machineId?: string }; collapseId: string; priority: string }[][] = [];
  const sender = async (messages: never[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
  const teams = [
    { id: "t-old", title: "Old run", status: "blocked", reason: "Stopped earlier.", resumable: true },
    { id: "t-new", title: "Smart alarm", status: "implementing", reason: undefined as string | undefined, resumable: false },
    { id: "t-child", title: "Mission child", status: "implementing", reason: undefined as string | undefined, resumable: false, mission: true },
  ];
  const source = { statuses: () => teams };
  const notifier = new Notifier({ list: async () => [] } as never, store, sender, { detail: "minimal", events: ["needs-you", "team-blocked", "team-started"], intervalMs: 100000, machineId: "m1" }, source);
  await notifier.tick();                 // baseline: the run blocked before startup is not flagged
  assert.equal(sent.length, 0);
  teams[1].status = "blocked"; teams[1].reason = "An agent showed no activity twice on the same assignment."; teams[1].resumable = true;
  await notifier.tick();
  await notifier.tick();                 // still blocked: no second push
  assert.equal(sent.length, 1);
  teams[2].status = "blocked"; teams[2].reason = "Needs a decision.";
  await notifier.tick();
  assert.equal(sent.length, 1, "Mission children escalate through their coordinator, not owner lifecycle pushes");
  assert.deepEqual(sent[0][0], { to: "ExponentPushToken[a]", title: "Team needs you", body: "Smart alarm is blocked and waiting for you. It can resume.",
    data: { url: "/team/t-new", machineId: "m1" }, channelId: "attention", priority: "high", collapseId: "team:t-new" });
  teams[1].status = "planning"; await notifier.tick();
  teams[1].status = "blocked"; teams[1].resumable = false; await notifier.tick();
  assert.equal(sent.length, 2, "A run that blocks again after resuming is flagged again");
  assert.equal(sent[1][0].body, "Smart alarm is blocked and waiting for you.");
  teams.push({ id: "t-fresh", title: "Fresh run", status: "blocked", reason: "The Linear issue changed.", resumable: false });
  await notifier.tick();
  assert.equal(sent.length, 3, "A run created after startup sends its started event even if first seen blocked");
  assert.equal(sent[2][0].title, "Team started");

  const full = new Notifier({ list: async () => [] } as never, store, sender, { detail: "full", events: ["team-blocked"], intervalMs: 100000 }, source);
  teams[1].status = "planning"; await full.tick();
  teams[1].status = "blocked"; teams[1].resumable = true; await full.tick();
  assert.equal(sent.at(-1)![0].body, "Smart alarm: An agent showed no activity twice on the same assignment. It can resume.");
  const off = new Notifier({ list: async () => [] } as never, store, sender, { detail: "full", events: ["needs-you"], intervalMs: 100000 }, source);
  teams[1].status = "planning"; await off.tick();
  const before = sent.length;
  teams[1].status = "blocked"; await off.tick();
  assert.equal(sent.length, before, "Without the team-blocked event nothing is sent");
  rmSync(dir, { recursive: true, force: true });
});

test("goal and team lifecycle events fire once per category transition with priority routing", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("owner", "ExponentPushToken[a]", "ios");
  const sent: { title: string; body: string; data: { url: string }; priority: string; collapseId: string }[][] = [];
  const sender = async (messages: never[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
  const goals = [{ id: "11111111-1111-4111-8111-111111111111", title: "Ship feature", status: "running", reason: undefined as string | undefined }];
  const teams = [{ id: "21111111-1111-4111-8111-111111111111", title: "Build feature", status: "implementing", reason: undefined as string | undefined, resumable: false, goal: false }];
  const events = ["goal-started", "goal-finished", "goal-stuck", "goal-cancelled", "team-started", "team-finished", "team-stuck", "team-cancelled"];
  const notifier = new Notifier({ list: async () => [] } as never, store, sender, { detail: "minimal", events, intervalMs: 100000 }, { statuses: () => teams }, { statuses: () => goals });
  await notifier.tick(); // Items already present are primed silently.
  assert.equal(sent.length, 0);

  goals.push({ id: "31111111-1111-4111-8111-111111111111", title: "New goal", status: "running", reason: undefined });
  teams.push({ id: "41111111-1111-4111-8111-111111111111", title: "New team", status: "planning", reason: undefined, resumable: false, goal: false });
  await notifier.tick();
  await notifier.tick();
  assert.deepEqual(sent[0].map(message => [message.title, message.body, message.data.url]), [
    ["Team started", "New team started", "/team/41111111-1111-4111-8111-111111111111"],
    ["Goal started", "New goal started", "/goal/31111111-1111-4111-8111-111111111111"],
  ]);
  assert.equal(sent.length, 1, "unchanged statuses do not repeat");

  const transitions: ["goal" | "team", string, string, string][] = [
    ["goal", "needs-input", "Goal needs you", "high"],
    ["goal", "blocked", "Goal needs you", "high"],
    ["goal", "achieved", "Goal finished", "default"],
    ["goal", "cancelled", "Goal cancelled", "default"],
    ["goal", "ready-for-review", "Goal finished", "default"],
    ["goal", "no-opportunity", "Goal finished", "default"],
    ["goal", "limit-reached", "Goal needs you", "high"],
    ["team", "needs-input", "Team needs you", "high"],
    ["team", "blocked", "Team needs you", "high"],
    ["team", "ready-for-review", "Team finished", "default"],
    ["team", "merged", "Team finished", "default"],
    ["team", "no-change", "Team finished", "default"],
    ["team", "cancelled", "Team cancelled", "default"],
  ];
  for (const [kind, status, title, priority] of transitions) {
    const target = kind === "goal" ? goals[0] : teams[0];
    const other = kind === "goal" ? teams[0] : goals[0];
    const before = sent.length;
    target.status = kind === "goal" ? "running" : "implementing";
    other.status = kind === "goal" ? "implementing" : "running";
    await notifier.tick();
    target.status = status;
    target.reason = "Review needed";
    await notifier.tick();
    assert.equal(sent.length, before + 1, `${kind} ${status} transition sends once`);
    const message = sent.at(-1)![0];
    assert.equal(message.title, title);
    assert.equal(message.priority, priority);
    assert.equal(message.data.url, `/${kind}/${target.id}`);
    assert.equal(message.collapseId, `${kind}:${target.id}`);
    await notifier.tick();
    assert.equal(sent.length, before + 1, `${kind} ${status} remains quiet`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("goal-owned team runs do not send lifecycle messages", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("owner", "ExponentPushToken[a]", "ios");
  const sent: unknown[][] = [];
  const sender = async (messages: never[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
  const teams = [{ id: "t-11111111-1111-4111-8111-111111111111", title: "Goal worker", status: "implementing", goal: true }];
  const notifier = new Notifier({ list: async () => [] } as never, store, sender, { detail: "minimal", events: ["team-started", "team-stuck", "team-finished", "team-cancelled"], intervalMs: 100000 }, { statuses: () => teams });
  await notifier.tick();
  teams[0].status = "blocked";
  await notifier.tick();
  teams[0].status = "merged";
  await notifier.tick();
  assert.equal(sent.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a failing lifecycle source does not stop other sources", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("owner", "ExponentPushToken[a]", "ios");
  const sent: { title: string; data: { url: string } }[][] = [];
  const sender = async (messages: never[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
  const goals = [{ id: "51111111-1111-4111-8111-111111111111", title: "Independent goal", status: "running", reason: undefined as string | undefined }];
  const notifier = new Notifier({ list: async () => { throw new Error("session source unavailable"); } } as never, store, sender,
    { detail: "minimal", events: ["goal-started"], intervalMs: 100000 }, { statuses: () => { throw new Error("team source unavailable"); } }, { statuses: () => goals });
  await notifier.tick();
  goals.push({ id: "61111111-1111-4111-8111-111111111111", title: "Still available", status: "running", reason: undefined });
  await notifier.tick();
  assert.deepEqual(sent[0].map(message => [message.title, message.data.url]), [["Goal started", "/goal/61111111-1111-4111-8111-111111111111"]]);
  rmSync(dir, { recursive: true, force: true });
});

test("a record first seen already stuck or finished announces that status too", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("owner", "ExponentPushToken[a]", "ios");
  const sent: { title: string; priority: string }[][] = [];
  const sender = async (messages: never[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
  const teams: { id: string; title: string; status: string; goal: boolean }[] = [];
  const goals: { id: string; title: string; status: string }[] = [];
  const notifier = new Notifier({ list: async () => [] } as never, store, sender, { detail: "minimal", events: ["team-started", "team-stuck", "goal-finished"], intervalMs: 100000 }, { statuses: () => teams }, { statuses: () => goals });
  await notifier.tick();
  // A run can fail preparation, and a goal can finish, between two polls.
  teams.push({ id: "71111111-1111-4111-8111-111111111111", title: "Failed setup", status: "blocked", goal: false });
  goals.push({ id: "81111111-1111-4111-8111-111111111111", title: "Quick goal", status: "achieved" });
  await notifier.tick();
  assert.deepEqual(sent[0].map(message => [message.title, message.priority]), [["Team started", "default"], ["Team needs you", "high"], ["Goal finished", "default"]]);

  const alias = new Notifier({ list: async () => [] } as never, store, sender, { detail: "minimal", events: ["team-blocked"], intervalMs: 100000 }, { statuses: () => teams });
  await alias.tick();
  teams.push({ id: "91111111-1111-4111-8111-111111111111", title: "Another failure", status: "blocked", goal: false });
  await alias.tick();
  assert.deepEqual(sent.at(-1)!.map(message => message.title), ["Team needs you"]);
  rmSync(dir, { recursive: true, force: true });
});

test("start() takes lifecycle baselines, so a change before the first poll is announced", async () => {
  const dir = mkdtempSync("/tmp/inf-push-");
  const store = new PushStore(dir, randomBytes(32));
  store.add("owner", "ExponentPushToken[a]", "ios");
  const sent: { title: string }[][] = [];
  const sender = async (messages: never[]) => { sent.push(messages); return messages.map(() => ({ status: "ok" as const, id: "x" })); };
  const goals = [{ id: "a1111111-1111-4111-8111-111111111111", title: "Running goal", status: "running" }];
  const notifier = new Notifier({ list: async () => [] } as never, store, sender, { detail: "minimal", events: ["goal-stuck"], intervalMs: 100000 }, undefined, { statuses: () => goals });
  notifier.start();
  try {
    goals[0].status = "blocked";
    await notifier.tick();
    assert.deepEqual(sent.map(batch => batch.map(message => message.title)), [["Goal needs you"]]);
  } finally {
    notifier.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
