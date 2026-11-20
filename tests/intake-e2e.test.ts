import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { inProcessHost, waitFor } from "./helpers.js";
import { lineup } from "./mission-harness.js";
import { startIntakeLinearServer } from "./fixtures/intake-linear-server.js";
import { startSlackServer } from "./fixtures/slack-server.js";
import { unseal } from "../packages/host/src/vault.js";
import type { IntakeRecord, IntakeThread } from "../packages/host/src/intake-types.js";
import type { Config } from "../packages/host/src/types.js";

const OWNER = "U00000000", AGENT = "U11111111";
const BINDING: IntakeThread = { channelId: "C0000000000", threadTs: "1700000000.000100" };

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
/** A Slack message link whose thread timestamp names the binding's root, as Slack writes it. */
const slackLink = (thread: IntakeThread) => `https://example.slack.com/archives/${thread.channelId}/p${thread.threadTs.replace(".", "")}`;

/**
 * A real host through createApp, with Linear and (optionally) Slack fakes and two repository projects the mission
 * fixture agent can work in. Intake polls Linear every 30 seconds, so each issue is filed after the host starts.
 */
async function intakeHost(withSlack: boolean, options: {
  direct?: boolean; answerQuestions?: boolean; requestChannelIds?: string[]; ownerOnlyInJoinedChannels?: boolean;
} = {}) {
  const { direct, answerQuestions, requestChannelIds, ownerOnlyInJoinedChannels } = options;
  const root = realpathSync(mkdtempSync("/tmp/inf-intake-e2e-"));
  const receipts = join(root, "receipts");
  mkdirSync(receipts, { mode: 0o700 });
  const repos = ["api", "web"].map(name => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "check.mjs"), "process.exit(0);\n");
    git(path, "init", "--initial-branch=main");
    git(path, "add", "check.mjs");
    git(path, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", `Initial ${name}`);
    return { id: name, path };
  });

  const linear = await startIntakeLinearServer();
  const slack = withSlack ? await startSlackServer() : undefined;
  const agent = { command: process.execPath, args: [resolve("tests/fixtures/mission-agent.mjs"), "mission", receipts, "claude"] };
  const host = await inProcessHost({ configure: (config: Config) => {
    config.agents = { claude: agent, codex: agent };
    config.projects = repos.map(repo => ({ id: repo.id, name: repo.id.toUpperCase(), path: repo.path, team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] } }));
    config.teams = { workspaceDir: join(root, "teams"), lineup };
    config.linear = { apiKeyFile: linear.apiKeyFile, endpoint: linear.endpoint };
    config.intake = {
      linear: { teamIds: [linear.teamId], creatorId: linear.ownerId, label: "infinite", commentsMirrorToSlack: false, ...(direct ? { admitIssues: false } : {}) },
      ...(slack ? { slack: { appTokenFile: slack.appTokenFile, botTokenFile: slack.botTokenFile, teamId: "T00000000", ownerUserId: OWNER,
        linearAgentUserId: AGENT, bindByMention: false, endpoint: slack.endpoint, ...(direct ? { directRequests: true } : {}),
        ...(answerQuestions ? { answerQuestions: true } : {}), ...(requestChannelIds ? { requestChannelIds } : {}),
        ...(ownerOnlyInJoinedChannels ? { ownerOnlyInJoinedChannels } : {}) } } : {}),
      mission: { groupId: "api", maxSubtasks: 8, maxMinutes: 30 },
      maxActive: 3,
      requireSlackThread: slack !== undefined,
    };
  } });
  return {
    host, linear, slack, receipts,
    close: async () => {
      await host.stop();
      await slack?.close();
      await linear.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a Slack-filed answer-only issue is acknowledged and reported in its thread", { timeout: 150 * 1000 }, async () => {
  const world = await intakeHost(true);
  const { host, linear, slack } = world;
  try {
    slack!.seedThread(BINDING, [{ user: OWNER, text: `<@${AGENT}> file this: ANSWER-ONLY which exports failed?` }]);
    const issue = linear.file({ attachmentUrls: [slackLink(BINDING)] });
    const texts = () => slack!.posts(BINDING).map(post => post.text);

    await waitFor(async () => texts(), list => list.some(text => text.startsWith("Started on TEST-1")), 60000);
    await waitFor(async () => texts(), list => list.some(text => text.startsWith("Answer (agent report):") && text.includes("Rows 14, 90 and 212 were empty.")), 120000);
    await waitFor(async () => linear.comments(issue.id), comments => comments.length === 2, 60000);
    const { body } = await waitFor(async () => (await host.fetchApi("/intake")), response => response.body.records[0]?.state === "finished", 60000);

    assert.equal(body.records.length, 1);
    assert.equal(body.records[0].state, "finished");
    assert.ok(body.records[0].messages.every((message: { status: string }) => message.status === "sent"));
    assert.equal(body.slack.connected, true);
    assert.equal(body.slack.dropped, 0);
    assert.deepEqual(linear.comments(issue.id).map(comment => comment.body.split("\n")[0]), [
      "Infinite agent report: a mission started on this issue. Questions and the result will follow.",
      "Infinite agent report: ready for review.",
    ]);
    // Every chat.postMessage call the bot made went into the bound thread: the fake keeps all posts, and only this thread was seeded.
    const postCalls = slack!.calls.filter(call => call.method === "chat.postMessage").length;
    assert.equal(postCalls, texts().length, "Each post the bot sent landed in the bound thread");
  } finally {
    await world.close();
  }
});

test("a question reaches the thread and the owner's tagged reply answers it", { timeout: 210 * 1000 }, async () => {
  const world = await intakeHost(true);
  const { host, linear, slack, receipts } = world;
  try {
    // The fixture coordinator dispatches its subtasks once this file exists.
    writeFileSync(join(receipts, "release-dispatch"), "go", { mode: 0o600 });
    // The request's two subtasks run in two repositories, so the intake group holds both.
    const group = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Shop", repos: ["api", "web"] });
    assert.equal(group.status, 200, JSON.stringify(group.body));
    host.config.intake!.mission.groupId = group.body.id;

    slack!.seedThread(BINDING, [{ user: OWNER, text: `<@${AGENT}> file this: which response format should the endpoint use?` }]);
    const issue = linear.file({ attachmentUrls: [slackLink(BINDING)] });
    const texts = () => slack!.posts(BINDING).map(post => post.text);

    await waitFor(async () => texts(), list => list.some(text => text.startsWith("Started on TEST-1")), 60000);
    const question = await waitFor(async () => texts(), list => list.some(text => text.startsWith("**Q1: The API subteam asks: Which response format should the endpoint use?**")), 120000);
    assert.ok(question.some(text => text === "**Q1: The API subteam asks: Which response format should the endpoint use?**\n\nThe asking agent recommends: JSON. Reason: The subteam recommends it, and the web client parses JSON.\n\n1. JSON (recommended)\n2. Text\n\nChoose below, or reply with a mention and your answer."));

    const { body: before } = await host.fetchApi("/intake");
    const missionId = before.records[0].missionId as string;
    const asked = await host.fetchApi(`/missions/${missionId}`);
    assert.equal(asked.body.status, "needs-input");
    assert.equal(asked.body.decisions.find((item: { answer?: string }) => !item.answer)?.options.join(","), "JSON,Text");

    // The owner's tagged reply arrives on the Socket Mode connection, in the bound thread.
    await slack!.emit({ type: "app_mention", user: OWNER, channel: BINDING.channelId, ts: "1700000900.000100", thread_ts: BINDING.threadTs, text: `<@${slack!.botUserId}> JSON` });

    const answered = await waitFor(async () => (await host.fetchApi(`/missions/${missionId}`)).body,
      mission => mission.decisions.some((item: { answer?: string }) => item.answer === "JSON"), 60000);
    await waitFor(async () => texts(), list => list.includes("Received your answer to Q1."), 30000);
    assert.ok(answered.decisions.some((item: { answer?: string }) => item.answer === "JSON"), "The mission decision holds the owner's answer");
    assert.equal(answered.decisions.find((item: { answer?: string }) => item.answer === "JSON")?.recommendation?.outcome, "matched");
    assert.notEqual(answered.status, "ready-for-review");

    // The record keeps the reply as handled; read from the sealed record, since the API does not expose inbound entries.
    const sealed = unseal<IntakeRecord>(readFileSync(world.host.config.keyFile), `intake-record:${issue.id}`,
      readFileSync(join(world.host.config.stateDir, "intake", "records", `${issue.id}.sealed`), "utf8"));
    const reply = sealed.inbound.find(entry => entry.text === "JSON");
    assert.ok(reply?.handledAt, "The owner's reply is recorded as handled");
    assert.equal(reply?.outcome, "answered");

    // Nothing was posted outside the bound thread.
    const postCalls = slack!.calls.filter(call => call.method === "chat.postMessage").length;
    assert.equal(postCalls, texts().length, "Each post the bot sent landed in the bound thread");
  } finally {
    await world.close();
  }
});

test("without a Slack block intake still starts missions and comments in Linear", { timeout: 150 * 1000 }, async () => {
  const world = await intakeHost(false);
  const { host, linear } = world;
  try {
    const issue = linear.file({ description: "ANSWER-ONLY which exports failed?" });
    await waitFor(async () => linear.comments(issue.id), comments => comments.length === 2, 120000);
    const { body } = await waitFor(async () => (await host.fetchApi("/intake")), response => response.body.records[0]?.state === "finished", 60000);

    assert.equal(body.records[0].state, "finished");
    assert.ok(body.records[0].missionId, "A mission started for the issue");
    assert.deepEqual(linear.comments(issue.id).map(comment => comment.body.split("\n")[0]), [
      "Infinite agent report: a mission started on this issue. Questions and the result will follow.",
      "Infinite agent report: ready for review.",
    ]);
    assert.equal("slack" in body, false, "The API has no slack member without an intake Slack block");
  } finally {
    await world.close();
  }
});

test("a teammate proposes work and checks its progress while the owner runs the swarm from the thread", { timeout: 210_000 }, async () => {
  const world = await intakeHost(true, { direct: true, answerQuestions: true, requestChannelIds: [BINDING.channelId] });
  const { host, linear, receipts } = world, slack = world.slack!;
  const teammate = "U22222222";
  const proposal = "Exports need to include empty rows.";
  const sponsor = "work: Update the export and its API.";
  const messages = () => slack.posts(BINDING).map(post => post.text);
  const channelEvent = (user: string, ts: string, text: string, thread?: string) => ({
    type: "message", channel_type: "channel", user, channel: BINDING.channelId, ts, text, ...(thread ? { thread_ts: thread } : {}),
  });
  const send = async (event: Record<string, unknown>) => {
    const id = await slack.emit(event);
    await waitFor(async () => slack.acks().includes(id), Boolean, 5000);
  };
  try {
    const group = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Shop", repos: ["api", "web"] });
    assert.equal(group.status, 200);
    host.config.intake!.mission.groupId = group.body.id;
    writeFileSync(join(receipts, "release-dispatch"), "go");
    writeFileSync(join(receipts, "release-web-question"), "go");
    await waitFor(async () => (await host.fetchApi("/intake")).body.slack?.connected, Boolean, 30_000);

    slack.seedThread(BINDING, [{ user: teammate, text: proposal }]);
    await send({ ...channelEvent(OWNER, BINDING.threadTs, "work: Update the export."), channel: "C1111111111" });
    for (const fields of [{ subtype: "message_changed" }, { bot_profile: { name: "Example" } }, { channel_type: "im" }]) {
      await send({ ...channelEvent(OWNER, BINDING.threadTs, "work: Update the export."), ...fields });
    }
    await send(channelEvent(teammate, BINDING.threadTs, proposal));
    assert.ok(slack.calls.some(call => call.method === "reactions.add"));
    await send(channelEvent(OWNER, "1700000900.000001", "Thanks for spotting that.", BINDING.threadTs));
    assert.deepEqual((await host.fetchApi("/intake")).body.records, []);
    assert.equal(linear.allIssues().length, 0);

    const sponsorship = channelEvent(OWNER, "1700000900.000002", sponsor, BINDING.threadTs);
    const earlyAnswer = channelEvent(OWNER, "1700000900.000003", "Q1 Text", BINDING.threadTs);
    slack.seedThread(BINDING, [sponsorship, earlyAnswer]);
    await send(sponsorship);
    await send(sponsorship); // A second event ID for the same Slack message.
    await waitFor(async () => messages(), list => list.some(text => text.startsWith("**Q1:")), 90_000);
    const dispatch = messages().find(text => /\b2 subtasks\b/i.test(text));
    assert.ok(dispatch, "The thread reports the first dispatch and its subtask count");
    const [issue] = linear.allIssues();
    assert.equal(linear.allIssues().length, 1);
    assert.ok(issue);
    assert.ok(issue.description.includes("Update the export and its API."));
    assert.ok(!issue.description.includes(proposal), "Teammate context stays in the Slack thread and sealed mission");
    const { records } = (await host.fetchApi("/intake")).body;
    assert.equal(records.length, 1);
    const mission = async () => (await host.fetchApi(`/missions/${records[0].missionId}`)).body;
    assert.equal((await mission()).origin.rule, "owner message in Slack request channel");
    assert.ok((await mission()).objective.includes(`other 1 | ${proposal}`));
    // Slack delivered these after the question appeared. One predates sponsorship and the other predates the question.
    await send(channelEvent(OWNER, "1700000900.000000", "cancel", BINDING.threadTs));
    await send(earlyAnswer);
    await waitFor(async () => messages(), list => list.some(text => text.includes("new reply")), 10_000);
    assert.equal((await mission()).status, "needs-input");
    assert.equal((await mission()).decisions[0].answer, undefined);
    const beforeStatus = messages().length;

    await send(channelEvent(teammate, "1700000900.000020", "cancel", BINDING.threadTs));
    await send(channelEvent(teammate, "1700000900.000021", "Q1 Text", BINDING.threadTs));
    await send(channelEvent(teammate, "1700000900.000022", "status", "1700000000.000099"));
    assert.equal((await mission()).status, "needs-input");
    assert.equal(messages().length, beforeStatus);
    const status = channelEvent(teammate, "1700000900.000023", "status", BINDING.threadTs);
    await send(status);
    await send(status);
    const afterStatus = await waitFor(async () => messages(), list => list.length > beforeStatus, 10_000);
    const summary = afterStatus[beforeStatus]!;
    assert.match(summary, /\b1 running\b/i);
    assert.match(summary, /\b1 queued\b/i);
    assert.match(summary, /(?:1\s+(?:open )?(?:question|decision)|(?:question|decision)s?\D{0,8}1)/i);
    assert.doesNotMatch(summary, /Which response format|api\.txt|Build the API first|Exports need/);

    const answer = channelEvent(OWNER, "1700000900.000024", "Q1 JSON", BINDING.threadTs);
    await send(answer);
    await send(answer);
    await waitFor(async () => messages(), list => list.some(text => text.startsWith("Ready for review (agent report):")), 100_000);
    assert.equal((await mission()).decisions[0].answer, "JSON");
    assert.equal(messages().filter(text => text === "Received your answer to Q1.").length, 1);
    assert.equal(messages().filter(text => text === dispatch).length, 1);
    assert.equal(messages().filter(text => text === summary).length, 1);
    assert.equal(slack.calls.filter(call => call.method === "chat.postMessage").length, messages().length);
    await send(channelEvent(OWNER, "1700000900.000025", "Thanks!", BINDING.threadTs));
    assert.equal((await host.fetchApi("/intake")).body.records.length, 1);
    assert.equal(linear.allIssues().length, 1);

    const next = { ...channelEvent(OWNER, "1700000900.000040", `<@${slack.botUserId}> work: HOLD-SUBTEAM review the export`, BINDING.threadTs), type: "app_mention" };
    await send({ ...next, type: "message" }); // Slack can also deliver the ordinary message copy of a mention.
    await send(next);
    const requests = await waitFor(async () => (await host.fetchApi("/intake")).body.records, rows => rows.some((row: { identifier: string; missionId?: string }) => row.identifier === "TEST-2" && row.missionId), 30_000);
    const followUp = requests.find((row: { identifier: string }) => row.identifier === "TEST-2");
    await send(channelEvent(OWNER, "1700000900.000026", "cancel", BINDING.threadTs));
    const saved = unseal<IntakeRecord>(readFileSync(host.config.keyFile), `intake-record:${followUp.issueId}`,
      readFileSync(join(host.config.stateDir, "intake", "records", `${followUp.issueId}.sealed`), "utf8"));
    assert.equal(saved.inbound.length, 0, "A late reply to the first request never enters the follow-up's command log");
    assert.equal((await host.fetchApi(`/missions/${followUp.missionId}`)).body.origin.rule, "owner Slack mention of the bot");
    assert.equal(linear.allIssues().length, 2);
  } finally {
    await world.close();
  }
});

test("the owner's mention files one issue, starts the mission, and is acknowledged in the thread", { timeout: 150 * 1000 }, async () => {
  const world = await intakeHost(true, { direct: true });
  const { host, linear, slack } = world;
  try {
    slack!.seedThread(BINDING, [{ user: OWNER, text: "ANSWER-ONLY which exports failed?" }]);
    const texts = () => slack!.posts(BINDING).map(post => post.text);
    const event = { type: "app_mention", user: OWNER, channel: BINDING.channelId, ts: "1700000900.000100", thread_ts: BINDING.threadTs, text: `<@${slack!.botUserId}> ANSWER-ONLY which exports failed?` };
    await waitFor(async () => (await host.fetchApi("/intake")).body, body => body.slack?.connected === true, 30000);
    const envelope = await slack!.emit(event);

    await waitFor(async () => texts(), list => list.some(text => text.startsWith('Started on TEST-1 "ANSWER-ONLY which exports failed?" (')), 90000);
    await waitFor(async () => texts(), list => list.some(text => text.startsWith("Answer (agent report):")), 120000);
    await slack!.redeliver(envelope);
    const { body } = await waitFor(async () => (await host.fetchApi("/intake")), response => response.body.records[0]?.state === "finished", 60000);

    assert.equal(linear.allIssues().length, 1, "One issue is filed in Linear");
    assert.equal(body.records.length, 1);
    assert.ok(body.records[0].missionId, "A mission started for the request");
    assert.equal(body.slack.dropped, 0);
    assert.equal(texts().filter(text => text.startsWith("Started on TEST-1")).length, 1, "One acknowledgement");
    const postCalls = slack!.calls.filter(call => call.method === "chat.postMessage").length;
    assert.equal(postCalls, texts().length, "Each post the bot sent landed in the thread");
  } finally {
    await world.close();
  }
});

test("only the owner can get a response in joined public and private channels", { timeout: 150_000 }, async () => {
  const world = await intakeHost(true, {
    direct: true, answerQuestions: true, ownerOnlyInJoinedChannels: true, requestChannelIds: [BINDING.channelId],
  });
  const { host, linear, slack: peer } = world, slack = peer!;
  const teammate = "U22222222";
  const question = "ask: ANSWER-DIRECT which exports failed?";
  const bindings = [
    { channelId: "C0000000041", threadTs: "1700000100.000001", channelType: "channel" },
    { channelId: "C0000000042", threadTs: "1700000100.000002", channelType: "group" },
    { channelId: "G0000000043", threadTs: "1700000100.000003", channelType: "group" },
  ];
  const send = async (event: Record<string, unknown>) => {
    const envelope = await slack.emit(event);
    await waitFor(async () => slack.acks().includes(envelope), Boolean, 5000);
  };
  try {
    await waitFor(async () => (await host.fetchApi("/intake")).body.slack?.connected, Boolean);
    for (const type of ["message", "app_mention"]) {
      await send({ type, channel_type: "channel", user: teammate, channel: BINDING.channelId, ts: BINDING.threadTs,
        text: type === "message" ? question : `<@${slack.botUserId}> ${question}` });
    }
    assert.equal(slack.calls.filter(call => call.method === "reactions.add").length, 0, "Even a listed channel stays owner-only");
    for (const binding of bindings) {
      slack.seedThread(binding, [{ user: OWNER, text: question }]);
      await send({ type: "message", channel_type: binding.channelType, user: OWNER, channel: binding.channelId, ts: binding.threadTs, text: question });
      await waitFor(async () => slack.posts(binding), posts => posts.some(post => post.text.startsWith("Answer (agent report)")), 60_000);
      const before = slack.posts(binding).length;
      const reply = { channel_type: binding.channelType, channel: binding.channelId, thread_ts: binding.threadTs };
      await send({ ...reply, type: "message", user: teammate, ts: "1700000999.000001", text: "status" });
      const mention = { type: "app_mention", channel: binding.channelId, thread_ts: binding.threadTs, text: `<@${slack.botUserId}> status` };
      await send({ ...mention, user: teammate, ts: "1700000999.000002" });
      await send({ ...mention, user: OWNER, ts: "1700000999.000003" });
      const posts = await waitFor(async () => slack.posts(binding), list => list.length > before);
      assert.equal(posts.length, before + 1, "Only the owner's status query gets a reply");
      assert.match(posts.at(-1)!.text, /Question ·/);
    }
    const { records } = (await host.fetchApi("/intake")).body;
    assert.equal(records.length, bindings.length);
    for (const { issueId } of records) {
      const stored = unseal<IntakeRecord>(readFileSync(host.config.keyFile), `intake-record:${issueId}`,
        readFileSync(join(host.config.stateDir, "intake", "records", `${issueId}.sealed`), "utf8"));
      assert.equal(stored.messages.filter(message => message.kind === "reply").length, 1, "Only one status reply can be delivered or retried");
    }
    assert.deepEqual(linear.calls, []);
  } finally { await world.close(); }
});

for (const entry of ["mention", "request channel"] as const) {
  test(`a read-only question through a ${entry} gets a thread answer without contacting Linear`, { timeout: 150 * 1000 }, async () => {
    const fromChannel = entry === "request channel";
    const world = await intakeHost(true, { direct: true, answerQuestions: true, requestChannelIds: fromChannel ? [BINDING.channelId] : [] });
    const { host, linear, slack } = world;
    try {
      const question = "ask: ANSWER-DIRECT which exports failed?";
      slack!.seedThread(BINDING, [{ user: OWNER, text: question }]);
      const texts = () => slack!.posts(BINDING).map(post => post.text);
      const event = fromChannel
        ? { type: "message", channel_type: "channel", user: OWNER, channel: BINDING.channelId, ts: BINDING.threadTs, text: question }
        : { type: "app_mention", user: OWNER, channel: BINDING.channelId, ts: "1700000900.000100", thread_ts: BINDING.threadTs, text: `<@${slack!.botUserId}> ${question}` };
      await waitFor(async () => (await host.fetchApi("/intake")).body, body => body.slack?.connected === true, 30000);
      await slack!.emit(event);

      await waitFor(async () => texts(), list => list.length >= 2, 120000);
      const { body } = await waitFor(async () => (await host.fetchApi("/intake")), response => response.body.records[0]?.state === "finished", 60000);
      assert.equal(texts().length, 2);
      assert.equal(texts()[0], "Answering this from the repositories, read-only. No issue was filed.");
      assert.match(texts()[1]!, /^Answer \(agent report\):\nRows 14, 90 and 212 were empty\./);
      if (!fromChannel) assert.ok(texts()[1]!.endsWith('No issue was filed. To start work, mention me with the change you want, or begin with "work:".'));
      assert.deepEqual(linear.calls, [], "Linear received no request of any kind");
      assert.equal(linear.allIssues().length, 0);
      assert.equal(body.records.length, 1);
      assert.deepEqual([body.records[0].identifier, body.records[0].route.kind, body.records[0].route.by], ["", "answer", "owner"]);
      assert.ok(body.records[0].missionId);
      const mission = (await host.fetchApi(`/missions/${body.records[0].missionId}`)).body;
      assert.equal(mission.origin.rule, fromChannel ? "owner message in Slack request channel (question)" : "owner Slack mention of the bot (question)");
    } finally {
      await world.close();
    }
  });
}

test("the correction the bot advertises works: cancel the mistaken request, then ask in the same thread", { timeout: 240 * 1000 }, async () => {
  const world = await intakeHost(true, { direct: true, answerQuestions: true });
  const { host, linear, slack } = world;
  try {
    slack!.seedThread(BINDING, [{ user: OWNER, text: "HOLD-SUBTEAM which exports failed?" }]);
    const texts = () => slack!.posts(BINDING).map(post => post.text);
    const mention = (ts: string, text: string) => ({ type: "app_mention", user: OWNER, channel: BINDING.channelId, ts, thread_ts: BINDING.threadTs, text: `<@${slack!.botUserId}> ${text}` });
    await waitFor(async () => (await host.fetchApi("/intake")).body, body => body.slack?.connected === true, 30000);
    await slack!.emit(mention("1700000900.000100", "HOLD-SUBTEAM which exports failed?"));
    const started = await waitFor(async () => texts(), list => list.some(text => text.startsWith("Started on TEST-1")), 90000);
    assert.ok(started.some(text => text.endsWith('I took this as a request for a change. If you only wanted an answer, reply with a mention and "cancel", then mention me again starting with "ask:".')));

    await slack!.emit(mention("1700000900.000200", "cancel"));
    const finished = await waitFor(async () => (await host.fetchApi("/intake")).body, body => body.records[0]?.state === "finished", 90000);
    assert.equal(finished.records.length, 1);

    await slack!.emit(mention("1700000900.000300", "ask: ANSWER-DIRECT which exports failed?"));
    await waitFor(async () => texts(), list => list.some(text => text.startsWith("Answer (agent report):")), 120000);
    const { records } = (await host.fetchApi("/intake")).body;
    assert.equal(records.length, 2);
    assert.deepEqual([records[1].route.kind, records[1].route.by, records[1].identifier], ["answer", "owner", ""]);
    assert.equal(linear.allIssues().length, 1, "Only the first request has an issue");
    assert.ok(texts().includes("Answering this from the repositories, read-only. No issue was filed."));
  } finally {
    await world.close();
  }
});
