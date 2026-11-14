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
async function intakeHost(withSlack: boolean) {
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
      linear: { teamIds: [linear.teamId], creatorId: linear.ownerId, label: "infinite", commentsMirrorToSlack: false },
      ...(slack ? { slack: { appTokenFile: slack.appTokenFile, botTokenFile: slack.botTokenFile, teamId: "T00000000", ownerUserId: OWNER,
        linearAgentUserId: AGENT, bindByMention: false, endpoint: slack.endpoint } } : {}),
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
    const question = await waitFor(async () => texts(), list => list.some(text => text.startsWith("Q1: The API subteam asks: Which response format should the endpoint use?")), 120000);
    assert.ok(question.some(text => text === "Q1: The API subteam asks: Which response format should the endpoint use?\n1. JSON   2. Text\nReply with a mention and your answer."));

    const { body: before } = await host.fetchApi("/intake");
    const missionId = before.records[0].missionId as string;
    const asked = await host.fetchApi(`/missions/${missionId}`);
    assert.equal(asked.body.status, "needs-input");
    assert.equal(asked.body.decisions.find((item: { answer?: string }) => !item.answer)?.options.join(","), "JSON,Text");

    // The owner's tagged reply arrives on the Socket Mode connection, in the bound thread.
    await slack!.emit({ type: "app_mention", user: OWNER, channel: BINDING.channelId, ts: "1700000900.000100", thread_ts: BINDING.threadTs, text: `<@${slack!.botUserId}> JSON` });

    const answered = await waitFor(async () => (await host.fetchApi(`/missions/${missionId}`)).body,
      mission => mission.decisions.some((item: { answer?: string }) => item.answer === "JSON"), 60000);
    assert.ok(answered.decisions.some((item: { answer?: string }) => item.answer === "JSON"), "The mission decision holds the owner's answer");
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
