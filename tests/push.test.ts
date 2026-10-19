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
  ];
  const source = { statuses: () => teams };
  const notifier = new Notifier({ list: async () => [] } as never, store, sender, { detail: "minimal", events: ["needs-you", "team-blocked"], intervalMs: 100000, machineId: "m1" }, source);
  await notifier.tick();                 // baseline: the run blocked before startup is not flagged
  assert.equal(sent.length, 0);
  teams[1].status = "blocked"; teams[1].reason = "An agent showed no activity twice on the same assignment."; teams[1].resumable = true;
  await notifier.tick();
  await notifier.tick();                 // still blocked: no second push
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][0], { to: "ExponentPushToken[a]", title: "Team blocked", body: "Smart alarm is blocked and waiting for you. It can resume.",
    data: { url: "/team/t-new", machineId: "m1" }, channelId: "attention", priority: "high", collapseId: "team:t-new" });
  teams[1].status = "planning"; await notifier.tick();
  teams[1].status = "blocked"; teams[1].resumable = false; await notifier.tick();
  assert.equal(sent.length, 2, "A run that blocks again after resuming is flagged again");
  assert.equal(sent[1][0].body, "Smart alarm is blocked and waiting for you.");
  teams.push({ id: "t-fresh", title: "Fresh run", status: "blocked", reason: "The Linear issue changed.", resumable: false });
  await notifier.tick();
  assert.equal(sent.length, 3, "A run created after startup is flagged even if it is first seen blocked");

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
