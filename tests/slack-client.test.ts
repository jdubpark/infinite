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
const workspaceScope = (channelIds?: string[]) => ({
  workspaces: [{ projectId: "work-repo", path: "/srv/work/work-repo", repository: "Example/work-repo" }],
  ...(channelIds !== undefined ? { channelIds } : {}),
});
const workspaceAllowed = () => true;

async function setup(options?: { teamId?: string; botUserId?: string; organizationScope?: { channelIds?: string[] } }) {
  const slack = await startSlackServer(options);
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint, timeoutMs: 2000,
    teamId: slack.teamId, organizationScope: workspaceScope(options?.organizationScope?.channelIds), workspaceAllowed });
  return { slack, client };
}

test("authTest returns the workspace and bot identity", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  assert.deepEqual(await client.authTest(), { teamId: slack.teamId, userId: slack.botUserId, botId: slack.botId });
});

test("organization scope admits the documented joined local channel shape and guards thread reads and sends", async t => {
  const { slack } = await setup({ organizationScope: {} });
  t.after(() => slack.close());
  slack.seedThread(binding, [{ user: "U00000000", text: "owner request" }]);
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint,
    timeoutMs: 2000, teamId: slack.teamId, organizationScope: workspaceScope(), workspaceAllowed });

  assert.equal(await client.organizationChannelAllowed(binding.channelId), true);
  assert.ok(Array.isArray(await client.thread(binding)), "Slack's documented local-channel response omits the optional external-workspace flag");
  await client.post(binding, "allowed reply", "scope:1");
  assert.equal(slack.posts(binding).length, 1);
  assert.ok(slack.calls.filter(call => call.method === "conversations.info").length >= 3,
    "Each admission, read, and send boundary checks current provider state");
});

test("organization scope denies external, pending, mixed, private-message, and uncertain provider records", async t => {
  const { slack } = await setup({ organizationScope: {} });
  t.after(() => slack.close());
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint,
    timeoutMs: 2000, teamId: slack.teamId, organizationScope: workspaceScope(), workspaceAllowed });
  const denied: Record<string, unknown>[] = [
    { is_shared: true, is_ext_shared: true },
    { is_pending_ext_shared: true, pending_shared: [{ team_id: "TOTHER" }] },
    { context_team_id: "TOTHER", shared_team_ids: ["TOTHER"] },
    { shared_team_ids: [slack.teamId, "TOTHER"] },
    { is_im: true },
    { is_mpim: true },
    { is_member: false },
    { context_team_id: undefined },
  ];
  for (const info of denied) {
    slack.setConversationInfo(binding.channelId, info);
    assert.equal(await client.organizationChannelAllowed(binding.channelId), false, JSON.stringify(info));
    assert.equal(await client.thread(binding), "unreadable", JSON.stringify(info));
    await assert.rejects(client.post(binding, "denied", "scope:denied"),
      (error: SlackError) => error.code === "organization_scope_denied", JSON.stringify(info));
  }
  slack.setConversationError(binding.channelId, "missing_scope");
  assert.equal(await client.organizationChannelAllowed(binding.channelId), false, "A missing scope is not treated as authorization");
  assert.equal(await client.thread(binding), "unreadable");
  assert.equal(slack.posts(binding).length, 0, "No denied read or send reached Slack");
});

test("an empty explicit channel grant closes organization scope without provider fallback", async t => {
  const { slack } = await setup({ organizationScope: { channelIds: [] } });
  t.after(() => slack.close());
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint,
    timeoutMs: 2000, teamId: slack.teamId, organizationScope: workspaceScope([]), workspaceAllowed });
  assert.equal(await client.organizationChannelAllowed(binding.channelId), false);
  assert.equal(slack.calls.filter(call => call.method === "conversations.info").length, 0);
  await assert.rejects(client.post(binding, "denied", "scope:empty"),
    (error: SlackError) => error.code === "organization_scope_denied");
  assert.equal(slack.posts(binding).length, 0);
});

test("Slack operations deny missing workspace scope or checkout validation", async t => {
  const { slack } = await setup();
  t.after(() => slack.close());
  const scope = { workspaces: [{ projectId: "work-repo", path: "/srv/work/work-repo", repository: "Example/work-repo" }] };
  const clients = [
    new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint,
      timeoutMs: 2000, teamId: slack.teamId, organizationScope: scope } as unknown as ConstructorParameters<typeof SlackClient>[0]),
    new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint,
      timeoutMs: 2000, teamId: slack.teamId, organizationScope: undefined, workspaceAllowed: () => true } as unknown as ConstructorParameters<typeof SlackClient>[0]),
  ];

  assert.deepEqual(await Promise.all(clients.map(client => client.organizationChannelAllowed(binding.channelId))), [false, false]);
  for (const client of clients) await assert.rejects(client.post(binding, "denied", "scope:missing"),
    (error: SlackError) => error.code === "organization_scope_denied");
  assert.equal(slack.calls.filter(call => call.method === "conversations.info").length, 0);
  assert.equal(slack.posts(binding).length, 0);
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

test("post sends standard Markdown in a block with a plain fallback", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  const markdown = "## Summary\n\nFirst paragraph.\n\n- **Ready**: see [the guide](https://example.org/@alice/docs).\n- @here as plain text.\n\n```js\nconst x = a < b && c > d;\n```";
  await client.post(binding, markdown, "format:1");
  const payload = slack.postPayloads(binding)[0];
  assert.equal(payload?.text, markdown);
  assert.equal(payload?.mrkdwn, false);
  assert.equal(payload?.parse, "none");
  assert.deepEqual(payload?.blocks, [{ type: "markdown", text: markdown }]);
  assert.deepEqual(payload?.metadata, { event_type: "infinite_intake", event_payload: { key: "format:1" } });
  assert.equal(slack.posts(binding)[0]?.text, markdown);
});

test("post accepts caller-supplied blocks while preserving its fallback, thread, and idempotency metadata", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  const blocks = [{ type: "section", text: { type: "plain_text", text: "Choose" } }];
  await client.post(binding, "Choose", "interaction:1", blocks);
  const payload = slack.postPayloads(binding)[0];
  assert.deepEqual(payload?.blocks, blocks);
  assert.equal(payload?.text, "Choose");
  assert.equal(payload?.thread_ts, binding.threadTs);
  assert.deepEqual(payload?.metadata, { event_type: "infinite_intake", event_payload: { key: "interaction:1" } });
});

test("acknowledgeProposal sends only the eyes reaction and treats a repeated acknowledgement as a no-op", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  await client.acknowledgeProposal(binding.channelId, binding.threadTs);
  await client.acknowledgeProposal(binding.channelId, binding.threadTs);
  const calls = slack.calls.filter(call => call.method === "reactions.add");
  assert.deepEqual(calls.map(call => call.body), [
    { channel: binding.channelId, timestamp: binding.threadTs, name: "eyes" },
    { channel: binding.channelId, timestamp: binding.threadTs, name: "eyes" },
  ]);
  assert.equal(slack.calls.filter(call => call.method === "chat.postMessage").length, 0);
  slack.unavailable(true);
  await assert.rejects(client.acknowledgeProposal(binding.channelId, binding.threadTs), (error: SlackError) => error instanceof SlackError && error.transient);
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

test("Socket Mode projects admission metadata and fails closed on malformed fields", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  const seen: SlackEnvelope[] = [];
  const connection = client.connect(async envelope => { seen.push(envelope); });
  t.after(() => connection.close());
  await waitFor(async () => connection.connected(), connected => connected);
  const valid = await slack.emit({ ...mention(), type: "message", subtype: undefined, channel_type: "channel", app_id: undefined });
  await waitFor(async () => slack.acks(), acks => acks.includes(valid));
  const projected = seen.find(envelope => envelope.envelopeId === valid)?.event;
  assert.deepEqual(projected, {
    type: "message", user: "U00000000", channelType: "channel", channel: binding.channelId,
    ts: "1700000100.000001", threadTs: binding.threadTs, text: "<@U00000001> build it",
  });
  for (const fields of [{ channel_type: 7 }, { hidden: true }, { edited: { user: "U00000000" } }]) {
    const id = await slack.emit({ ...mention(), type: "message", ...fields });
    await waitFor(async () => slack.acks(), acks => acks.includes(id));
    assert.equal(seen.find(envelope => envelope.envelopeId === id)?.event, undefined);
  }
});

test("a socket address outside Slack is refused before any TCP connection", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
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

test("block action payloads normalize identifiers, action values, multi-select values, and state without retaining payload data", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  const seen: SlackEnvelope[] = [];
  const connection = client.connect(async envelope => { seen.push(envelope); });
  t.after(() => connection.close());
  await waitFor(async () => connection.connected(), connected => connected);
  const envelopeId = await slack.emitInteraction({
    type: "block_actions",
    user: { id: "U00000009" }, team: { id: "T00000009" },
    channel: { id: "C00000009" },
    message: { thread_ts: "1700000000.000100" },
    container: { message_ts: "1700000100.000010" },
    actions: [
      { action_id: "approve", block_id: "decision", action_ts: "1700000101.000001", value: "yes" },
      { action_id: "labels", block_id: "filters", action_ts: "1700000101.000002", selected_options: [{ value: "a" }, { value: "b" }] },
      { action_id: "single", block_id: "filters", action_ts: "1700000101.000003", selected_option: { value: "one" } },
    ],
    state: { values: {
      filters: {
        choices: { type: "multi_static_select", selected_options: [{ value: "x" }, { value: "y" }] },
        choice: { type: "static_select", selected_option: { value: "one" } },
        keyword: { type: "plain_text_input", value: "safe text" },
      },
    } },
    response_url: "https://hooks.slack.com/actions/private",
    token: "private-token",
  });
  await waitFor(async () => seen.map(envelope => envelope.envelopeId), ids => ids.includes(envelopeId));
  const envelope = seen.find(item => item.envelopeId === envelopeId);
  assert.deepEqual(envelope?.interaction, {
    type: "block_actions", userId: "U00000009", teamId: "T00000009", channelId: "C00000009",
    messageTs: "1700000100.000010", threadTs: "1700000000.000100",
    actions: [
      { actionId: "approve", blockId: "decision", actionTs: "1700000101.000001", value: "yes" },
      { actionId: "labels", blockId: "filters", actionTs: "1700000101.000002", selectedValues: ["a", "b"] },
      { actionId: "single", blockId: "filters", actionTs: "1700000101.000003", value: "one" },
    ],
    state: { filters: {
      choices: { type: "multi_static_select", selectedValues: ["x", "y"] },
      choice: { type: "static_select", value: "one" },
      keyword: { type: "plain_text_input", value: "safe text" },
    } },
  });
  assert.equal(JSON.stringify(envelope).includes("response_url"), false);
  assert.equal(JSON.stringify(envelope).includes("private-token"), false);
  await waitFor(async () => slack.acks(), acks => acks.includes(envelopeId));
});

test("a button interaction remains valid when unrelated select state has been cleared", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  const seen: SlackEnvelope[] = [];
  const connection = client.connect(async envelope => { seen.push(envelope); });
  t.after(() => connection.close());
  await waitFor(async () => connection.connected(), connected => connected);
  const stateValues = Object.fromEntries([["__proto__", Object.fromEntries([
    ["__proto__", { type: "static_select", selected_option: null }],
    ["cleared_multi", { type: "multi_static_select", selected_options: null }],
  ])]]);
  const envelopeId = await slack.emitInteraction({
    type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" },
    message: { ts: "1.0" },
    actions: [{ action_id: "approve", block_id: "decision", action_ts: "2.0", value: "yes" }],
    state: { values: stateValues },
  });
  await waitFor(async () => seen.map(envelope => envelope.envelopeId), ids => ids.includes(envelopeId));
  const interaction = seen.find(envelope => envelope.envelopeId === envelopeId)?.interaction;
  assert.equal(interaction?.actions[0]?.value, "yes");
  assert.ok(interaction?.state);
  assert.equal(Object.getPrototypeOf(interaction.state), Object.prototype);
  assert.ok(Object.hasOwn(interaction.state, "__proto__"));
  assert.ok(Object.hasOwn(interaction.state.__proto__!, "__proto__"));
  assert.deepEqual(interaction.state.__proto__?.__proto__, { type: "static_select" });
  assert.deepEqual(interaction.state.__proto__?.cleared_multi, { type: "multi_static_select", selectedValues: [] });
  await waitFor(async () => slack.acks(), acks => acks.includes(envelopeId));
});

test("malformed block actions are delivered as envelope-ID-only and remain redeliverable", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  const seen: SlackEnvelope[] = [];
  const connection = client.connect(async envelope => { seen.push(envelope); });
  t.after(() => connection.close());
  await waitFor(async () => connection.connected(), connected => connected);
  const malformed = [
    { type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" }, message: { ts: "1.0" }, actions: [{ action_id: "x", block_id: "b", action_ts: "1.0", selected_options: "bad" }] },
    { type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" }, container: { message_ts: "1.0" }, actions: [{ action_id: "x", block_id: "b" }] },
    { type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" }, message: { ts: "1.0" }, actions: [{ action_id: "x", block_id: "b", action_ts: "1.0" }], state: { values: { b: { x: { type: "plain_text_input", value: 42 } } } } },
  ];
  for (const payload of malformed) {
    const envelopeId = await slack.emitInteraction(payload);
    await waitFor(async () => seen.map(envelope => envelope.envelopeId), ids => ids.includes(envelopeId));
    assert.deepEqual(seen.find(envelope => envelope.envelopeId === envelopeId), { envelopeId });
    await waitFor(async () => slack.acks(), acks => acks.includes(envelopeId));
    await slack.redeliver(envelopeId);
  }
  await waitFor(async () => seen.length, count => count === malformed.length * 2);
  assert.ok(seen.every(envelope => envelope.interaction === undefined));
});

test("interactive envelope acknowledgement waits for handler completion and rejected work stays unacknowledged", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  let release!: () => void;
  const deferred = new Promise<void>(resolve => { release = resolve; });
  let reject = false;
  const seen: string[] = [];
  const connection = client.connect(async envelope => {
    if (!envelope.interaction) return;
    seen.push(envelope.envelopeId);
    if (reject) throw new Error("handler rejected before durable save");
    await deferred;
  });
  t.after(() => connection.close());
  await waitFor(async () => connection.connected(), connected => connected);
  const payload = {
    type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: "C1" },
    message: { ts: "1.0" }, actions: [],
  };
  const pending = await slack.emitInteraction(payload);
  await delay(100);
  assert.ok(!slack.acks().includes(pending));
  release();
  await waitFor(async () => slack.acks(), acks => acks.includes(pending));
  reject = true;
  const failed = await slack.emitInteraction(payload);
  await waitFor(async () => seen, ids => ids.includes(failed));
  await delay(100);
  assert.ok(!slack.acks().includes(failed));
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

test("permalink returns the message's link and sends the channel and message timestamp", async t => {
  const { slack, client } = await setup();
  t.after(() => slack.close());
  assert.equal(await client.permalink(binding, "1700000100.000001"), "https://example.slack.com/archives/C0000000000/p1700000100000001");
});
