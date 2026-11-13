import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { SlackClient, SlackError, type SlackEnvelope } from "../packages/host/src/slack-client.js";
import type { IntakeThread } from "../packages/host/src/intake-types.js";
import { startSlackServer } from "./fixtures/slack-server.js";
import { waitFor } from "./helpers.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const binding: IntakeThread = { channelId: "C0000000000", threadTs: "1700000000.000100" };
const other: IntakeThread = { channelId: "C0000000001", threadTs: "1700000000.000200" };
const mention = (text = "<@U00000001> build it") => ({
  type: "app_mention", user: "U00000000", channel: binding.channelId, ts: "1700000100.000001", thread_ts: binding.threadTs, text,
});

async function setup(options?: { teamId?: string; botUserId?: string }) {
  const slack = await startSlackServer(options);
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint, timeoutMs: 2000 });
  return { slack, client };
}

test("authTest returns the workspace and bot identity", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  assert.deepEqual(await client.authTest(), { teamId: slack.teamId, userId: slack.botUserId, botId: slack.botId });
});

test("thread pages through replies and keeps the outbound key", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  const seeded = Array.from({ length: 250 }, (_, index) => ({ user: "U00000000", text: `message ${index}` }));
  slack.seedThread(binding, seeded);
  const { ts } = await client.post(binding, "bot reply", "k");
  const messages = await client.thread(binding);
  assert.ok(messages !== "unreadable");
  assert.equal(messages.length, 251);
  assert.deepEqual(messages.slice(0, 250).map(message => message.text), seeded.map(message => message.text));
  assert.deepEqual(messages.map(message => message.ts), [...messages.map(message => message.ts)].sort());
  const last = messages[250];
  assert.equal(last.ts, ts);
  assert.equal(last.text, "bot reply");
  assert.equal(last.key, "k");
});

test("the root carries the binding's timestamp and a post sorts after explicitly timed replies", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  slack.seedThread(binding, [{ user: "U00000000", text: "root" }, { user: "U00000000", text: "later", ts: "1700000900.000000" }]);
  const { ts } = await client.post(binding, "reply", "k");
  const messages = await client.thread(binding);
  assert.ok(messages !== "unreadable");
  assert.equal(messages[0].ts, binding.threadTs);
  assert.equal(messages[0].text, "root");
  assert.equal(messages[1].ts, "1700000900.000000");
  assert.equal(messages.at(-1)?.ts, ts);
  assert.ok(Number(ts) > 1700000900);
});

test("a long thread keeps the root and the newest 999 replies, oldest first", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  slack.seedThread(binding, Array.from({ length: 1300 }, (_, index) => ({ user: "U00000000", text: `message ${index}` })));
  const messages = await client.thread(binding);
  assert.ok(messages !== "unreadable");
  assert.equal(messages.length, 1000);
  assert.equal(messages[0].text, "message 0");
  assert.equal(messages[1].text, "message 301");
  assert.equal(messages.at(-1)?.text, "message 1299");
  assert.deepEqual(messages.slice(1).map(message => message.text), Array.from({ length: 999 }, (_, index) => `message ${index + 301}`));
});

test("a channel the bot is not in is unreadable, and an outage throws a transient error", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  slack.seedThread(binding, [{ user: "U00000000", text: "hello" }]);
  slack.hide(binding.channelId);
  assert.equal(await client.thread(binding), "unreadable");
  slack.unavailable(true);
  await assert.rejects(client.thread(other), (error: SlackError) => error instanceof SlackError && error.transient);
});

test("a missing thread is unreadable, and a refused token is a permanent error", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  assert.equal(await client.thread(other), "unreadable");
  writeFileSync(slack.botTokenFile, "not-a-bot-token\n", { mode: 0o600 });
  await assert.rejects(client.thread(binding), (error: SlackError) => error.code === "invalid_auth" && !error.transient);
});

test("rate limiting is a transient error", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  slack.rateLimited(true);
  await assert.rejects(client.thread(binding), (error: SlackError) => error.code === "ratelimited" && error.transient);
});

test("post sends the key as message metadata into the thread", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  slack.seedThread(binding, [{ user: "U00000000", text: "question" }]);
  const { ts } = await client.post(binding, "hello", "m1:ack");
  assert.deepEqual(slack.posts(binding).map(p => [p.text, p.key, p.ts]), [["hello", "m1:ack", ts]]);
});

test("a lost post response is a transient error and the message exists once", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  slack.seedThread(binding, [{ user: "U00000000", text: "question" }]);
  slack.loseNextPostResponse();
  await assert.rejects(client.post(binding, "hello", "m1:ack"), (error: SlackError) => error.transient);
  assert.equal(slack.posts(binding).length, 1);
});

test("an envelope is acknowledged after the handler resolves and not when it rejects", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  let fail = false;
  const connection = client.connect(async () => { if (fail) throw new Error("handler failed"); });
  t.after(() => connection.close());
  await waitFor(async () => connection.connected(), connected => connected);
  const first = await slack.emit(mention());
  await waitFor(async () => slack.acks(), acks => acks.includes(first));
  fail = true;
  const second = await slack.emit(mention());
  await delay(200);
  assert.ok(!slack.acks().includes(second));
});

test("the client reconnects after the socket drops", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  const received: SlackEnvelope[] = [];
  const connection = client.connect(async envelope => { received.push(envelope); });
  t.after(() => connection.close());
  await waitFor(async () => connection.connected(), connected => connected);
  slack.dropSocket();
  await waitFor(async () => connection.connected(), connected => !connected);
  await waitFor(async () => connection.connected(), connected => connected, 5000);
  const envelope = await slack.emit(mention());
  await waitFor(async () => received.map(item => item.envelopeId), ids => ids.includes(envelope));
  assert.equal(received.at(-1)?.event?.type, "app_mention");
});

test("a socket address outside Slack is refused before any TCP connection", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  // A raw TCP listener on loopback counts every connection attempt. A client without the address check would dial it.
  let attempts = 0;
  const forbidden = createServer(socket => { attempts++; socket.destroy(); });
  await new Promise<void>(resolve => forbidden.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => forbidden.close(() => resolve())));
  const { port } = forbidden.address() as AddressInfo;
  slack.returnSocketAddress(`wss://127.0.0.1:${port}/`);
  const connection = client.connect(async () => undefined);
  t.after(() => connection.close());
  await delay(500);
  assert.equal(connection.connected(), false);
  assert.equal(attempts, 0);
});

test("an envelope of another type reaches the handler and is acknowledged only when the handler resolves", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  let fail = false;
  const seen: SlackEnvelope[] = [];
  const connection = client.connect(async envelope => { seen.push(envelope); if (fail) throw new Error("handler failed"); });
  t.after(() => connection.close());
  await waitFor(async () => connection.connected(), connected => connected);
  const first = await slack.emitRaw("interactive", { type: "block_actions", event: { type: "message", channel: binding.channelId, ts: "1700000100.000001", text: "not an event" } });
  await waitFor(async () => slack.acks(), acks => acks.includes(first));
  const delivered = seen.find(envelope => envelope.envelopeId === first);
  assert.ok(delivered);
  assert.equal(delivered.event, undefined);
  fail = true;
  const second = await slack.emitRaw("slash_commands", { command: "/infinite" });
  await waitFor(async () => seen.map(envelope => envelope.envelopeId), ids => ids.includes(second));
  await delay(200);
  assert.ok(!slack.acks().includes(second));
});

test("tokens are read from their files on every call", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  await client.authTest();
  const first = slack.calls.at(-1)?.token;
  writeFileSync(slack.botTokenFile, "xoxb-rotated-token\n", { mode: 0o600 });
  await client.authTest();
  assert.equal(first?.startsWith("xoxb-"), true);
  assert.equal(slack.calls.at(-1)?.token, "xoxb-rotated-token");
});
