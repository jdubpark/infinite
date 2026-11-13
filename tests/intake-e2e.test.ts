import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inProcessHost, waitFor } from "./helpers.js";
import { lineup } from "./mission-harness.js";
import { startIntakeLinearServer } from "./fixtures/intake-linear-server.js";
import { startSlackServer } from "./fixtures/slack-server.js";
import type { IntakeThread } from "../packages/host/src/intake-types.js";
import type { Config } from "../packages/host/src/types.js";

const OWNER = "U00000000", AGENT = "U11111111";
const BINDING: IntakeThread = { channelId: "C0000000000", threadTs: "1700000000.000100" };

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
/** A Slack message link whose thread timestamp names the binding's root, as Slack writes it. */
const slackLink = (thread: IntakeThread) => `https://example.slack.com/archives/${thread.channelId}/p${thread.threadTs.replace(".", "")}`;

/**
 * A real host through createApp, with Linear and (optionally) Slack fakes and one repository project the mission
 * fixture agent can answer from. Intake polls Linear every 30 seconds, so each issue is filed after the host starts.
 */
async function intakeHost(withSlack: boolean) {
  const root = realpathSync(mkdtempSync("/tmp/inf-intake-e2e-"));
  const receipts = join(root, "receipts");
  mkdirSync(receipts, { mode: 0o700 });
  const repo = join(root, "api");
  mkdirSync(repo);
  writeFileSync(join(repo, "check.mjs"), "process.exit(0);\n");
  git(repo, "init", "--initial-branch=main");
  git(repo, "add", "check.mjs");
  git(repo, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial api");

  const linear = await startIntakeLinearServer();
  const slack = withSlack ? await startSlackServer() : undefined;
  const agent = { command: process.execPath, args: [resolve("tests/fixtures/mission-agent.mjs"), "mission", receipts, "claude"] };
  const host = await inProcessHost({ configure: (config: Config) => {
    config.agents = { claude: agent, codex: agent };
    config.projects = [{ id: "api", name: "API", path: repo, team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] } }];
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
    host, linear, slack,
    close: async () => {
      await host.stop();
      await slack?.close();
      await linear.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a Slack-filed issue is acknowledged, asked about, answered, and reported in its thread", { timeout: 150 * 1000 }, async () => {
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
