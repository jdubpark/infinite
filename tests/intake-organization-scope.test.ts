import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { IntakeLinear, parseSlackThreadLink, type IntakeIssue } from "../packages/host/src/intake-linear.js";
import { IntakeService } from "../packages/host/src/intake.js";
import { LinearService } from "../packages/host/src/linear.js";
import { SlackError } from "../packages/host/src/slack-client.js";
import type { Config } from "../packages/host/src/types.js";
import type { IntakeRecord, IntakeThread, IntakeThreadReader, SlackThreadMessage } from "../packages/host/src/intake-types.js";
import { missionHarness } from "./mission-harness.js";
import { startIntakeLinearServer, type IntakeFixtureIssue } from "./fixtures/intake-linear-server.js";

const OWNER = "U00000000", BOT = "U11111111";
const slackTs = (ms: number) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`;
const linkFor = (ts: string) => `https://example.slack.com/archives/C0000000000/p${ts.replace(".", "")}`;

class ScopedThreads implements IntakeThreadReader {
  readonly threads = new Map<string, SlackThreadMessage[]>();
  readonly unreadable = new Set<string>();
  readonly deniedChannels = new Set<string>();
  allowed = true;
  reads = 0;
  async organizationChannelAllowed(channelId: string) { return this.allowed && !this.deniedChannels.has(channelId); }
  async thread(binding: IntakeThread): Promise<SlackThreadMessage[] | "unreadable"> {
    this.reads += 1;
    if (this.unreadable.has(binding.threadTs)) return "unreadable";
    return this.threads.get(binding.threadTs) ?? [];
  }
  async permalink(binding: IntakeThread, ts: string) { return `https://example.slack.com/archives/${binding.channelId}/p${ts.replace(".", "")}`; }
}

async function setup(options: { requireSlackThread?: boolean; answerQuestions?: boolean } = {}) {
  const linearServer = await startIntakeLinearServer();
  const threads = new ScopedThreads();
  let config!: Config;
  const harness = missionHarness({ configure: target => {
    config = target;
    target.linear = { apiKeyFile: linearServer.apiKeyFile, endpoint: linearServer.endpoint };
    target.intake = {
      linear: { teamIds: [linearServer.teamId], creatorId: linearServer.ownerId, label: "infinite", commentsMirrorToSlack: false },
      slack: { appTokenFile: "/srv/infinite-data/slack-app-token", botTokenFile: "/srv/infinite-data/slack-bot-token", teamId: "T00000000",
        ownerUserId: OWNER, linearAgentUserId: BOT, bindByMention: false, directRequests: true, answerQuestions: options.answerQuestions ?? false,
        organizationScope: {} },
      mission: { groupId: "shop", maxSubtasks: 8, maxMinutes: 30 }, maxActive: 3,
      requireSlackThread: options.requireSlackThread ?? true,
    };
  } });
  const { missions } = harness.open();
  const key = randomBytes(32), store = new IntakeStore(config, key);
  const enabled = Date.parse(store.enabledAt());
  const linear = new LinearService(config, randomBytes(32));
  const service = (client = new IntakeLinear(linear)) => new IntakeService(config, store, missions, client, {
    threads, pollMs: 3600000, create: (request, origin) => missions.create(request, undefined, origin),
  });
  const intake = service();
  const addThread = (offset: number) => {
    const ts = slackTs(enabled + offset);
    threads.threads.set(ts, [{ ts, user: OWNER, text: `Please export this <@${BOT}>` }]);
    return { ts, link: linkFor(ts) };
  };
  const issue = (overrides: Partial<IntakeFixtureIssue> = {}) => {
    const thread = addThread(2000);
    return linearServer.file({ createdAt: new Date(enabled + 3000).toISOString(), attachmentUrls: [thread.link], ...overrides });
  };
  return {
    config, threads, store, enabled, missions, linear, linearServer, intake, service, issue,
    close: async () => { intake.close(); linear.close(); await linearServer.close(); await harness.close(); },
  };
}

function direct(ctx: Awaited<ReturnType<typeof setup>>, text = "Export fails on empty rows", offset = 2000) {
  const ts = slackTs(ctx.enabled + offset), thread = { channelId: "C0000000000", threadTs: ts };
  ctx.threads.threads.set(ts, [{ ts, user: OWNER, text }]);
  return { thread, ts, eventId: `Ev${randomUUID().slice(0, 8)}`, text };
}

function record(issue: IntakeIssue, thread: IntakeThread, comments: IntakeRecord["comments"] = {}): IntakeRecord {
  const now = new Date().toISOString();
  return { issueId: issue.id, identifier: issue.identifier, url: issue.url, title: issue.title, description: issue.description,
    issueCreatedAt: issue.createdAt, issueUpdatedAt: issue.updatedAt, state: "started", rule: "owner Slack request", missionId: randomUUID(),
    thread, comments, messages: [], questions: [], inbound: [], createdAt: now, updatedAt: now };
}

test("queued Slack work waits for source scope before Linear filing and retries after a grant returns", { timeout: 60000 }, async () => {
  const ctx = await setup({ requireSlackThread: false });
  try {
    ctx.threads.allowed = false;
    const request = direct(ctx);
    ctx.intake.requestFromSlack(request);
    await ctx.intake.poll();
    const [held] = ctx.store.list();
    assert.equal(held.state, "queued");
    assert.match(held.holdReason ?? "", /organization_scope_denied/);
    assert.equal(ctx.linearServer.allIssues().length, 0);
    assert.equal(ctx.missions.list().length, 0);

    ctx.threads.allowed = true;
    await ctx.intake.poll();
    assert.equal(ctx.linearServer.allIssues().length, 1);
    assert.equal(ctx.missions.list().length, 1);
    assert.equal(ctx.store.get(held.issueId)!.state, "started");
  } finally { await ctx.close(); }
});

test("a denied routable request stays held without blocking another eligible Slack request", { timeout: 60000 }, async () => {
  const ctx = await setup({ requireSlackThread: false, answerQuestions: true });
  try {
    const denied = direct(ctx, "Which export failed?", 2000);
    const eligible = direct(ctx, "Which endpoint failed?", 3000);
    eligible.thread.channelId = "C0000000001";
    ctx.threads.deniedChannels.add(denied.thread.channelId);
    ctx.intake.requestFromSlack(denied);
    ctx.intake.requestFromSlack(eligible);
    await ctx.intake.poll();
    const held = ctx.store.list().find(item => item.direct?.ts === denied.ts)!;
    const filed = ctx.store.list().find(item => item.direct?.ts === eligible.ts)!;
    assert.equal(held.direct?.route, undefined);
    assert.match(held.holdReason ?? "", /verified source access/);
    assert.ok(filed.direct?.route);
    assert.equal(ctx.linearServer.allIssues().length, 1);
    assert.equal(ctx.missions.list().length, 1);
    ctx.threads.deniedChannels.delete(denied.thread.channelId);
    await ctx.intake.poll();
    assert.equal(ctx.linearServer.allIssues().length, 2);
    assert.equal(ctx.missions.list().length, 2);
  } finally { await ctx.close(); }
});

test("an optional denied linked Slack thread is not treated as an unlinked Linear request", { timeout: 60000 }, async () => {
  const ctx = await setup({ requireSlackThread: false });
  try {
    const linked = ctx.issue();
    const unlinked = ctx.linearServer.file({ createdAt: new Date(ctx.enabled + 4000).toISOString(), attachmentUrls: [] });
    ctx.threads.allowed = false;
    await ctx.intake.poll();
    assert.equal(ctx.store.get(linked.id), undefined);
    assert.equal(ctx.threads.reads, 0);
    assert.equal(ctx.store.get(unlinked.id)?.state, "started");
    assert.equal(ctx.missions.list().length, 1);

    const binding = parseSlackThreadLink(linked.attachmentUrls[0]!)!;
    ctx.threads.allowed = true;
    ctx.threads.unreadable.add(binding.threadTs);
    await ctx.intake.poll();
    assert.equal(ctx.store.get(linked.id), undefined);
    assert.equal(ctx.threads.reads, 1);
    assert.equal(ctx.missions.list().length, 1);
  } finally { await ctx.close(); }
});

test("Linear comment outbox rechecks Slack grant and current allowed team before posting", { timeout: 60000 }, async () => {
  const ctx = await setup({ requireSlackThread: false });
  const issue = ctx.linearServer.file({ createdAt: new Date(ctx.enabled + 4000).toISOString() });
  const thread = { channelId: "C0000000000", threadTs: "1700000000.000100" };
  const receipt = { id: randomUUID(), body: "Started receipt", delivered: false, attempts: 0 };
  ctx.store.create(record(issue, thread, { started: receipt }));
  const linear = new IntakeLinear(ctx.linear), getStates = linear.states.bind(linear);
  let calls = 0;
  linear.states = async ids => {
    const result = await getStates(ids);
    if (++calls === 2) ctx.threads.allowed = false;
    return result;
  };
  const intake = ctx.service(linear);
  try {
    await intake.poll();
    assert.equal(ctx.linearServer.comments(issue.id).length, 0);
    assert.equal(ctx.store.get(issue.id)!.comments.started!.delivered, false);
    ctx.threads.allowed = true;
    ctx.linearServer.edit(issue.id, { teamId: randomUUID() });
    await intake.poll();
    assert.equal(ctx.linearServer.comments(issue.id).length, 0);
    assert.equal(ctx.store.get(issue.id)!.comments.started!.delivered, false);
    ctx.linearServer.edit(issue.id, { teamId: ctx.linearServer.teamId });
    await intake.poll();
    assert.equal(ctx.linearServer.comments(issue.id).length, 1);
    assert.equal(ctx.store.get(issue.id)!.comments.started!.delivered, true);
  } finally { intake.close(); await ctx.close(); }
});

test("direct Linear filing rechecks Slack scope after label resolution", { timeout: 60000 }, async () => {
  const ctx = await setup({ requireSlackThread: false });
  try {
    const request = direct(ctx), original = ctx.linear.request.bind(ctx.linear);
    let revoke = true;
    ctx.linear.request = async (operation, query, variables) => {
      const result = await original(operation, query, variables);
      if (operation === "InfiniteIntakeLabel" && revoke) { revoke = false; ctx.threads.allowed = false; }
      return result;
    };
    ctx.intake.requestFromSlack(request);
    await ctx.intake.poll();
    assert.equal(ctx.linearServer.allIssues().length, 0);
    assert.equal(ctx.linearServer.calls.some(call => call.operation === "InfiniteIntakeIssueCreate"), false);
    assert.equal(ctx.missions.list().length, 0);
    ctx.threads.allowed = true;
    await ctx.intake.poll();
    assert.equal(ctx.linearServer.allIssues().length, 1);
    assert.equal(ctx.missions.list().length, 1);
  } finally { await ctx.close(); }
});
