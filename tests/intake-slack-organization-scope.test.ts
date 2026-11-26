import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeSlackSurface } from "../packages/host/src/intake-slack.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { SlackClient } from "../packages/host/src/slack-client.js";
import type { IntakeRecord, IntakeThread } from "../packages/host/src/intake-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { MissionService } from "../packages/host/src/missions.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { scriptedMissionHarness } from "./mission-harness.js";
import { startSlackServer } from "./fixtures/slack-server.js";
import { waitFor } from "./helpers.js";

const OWNER = "U00000000", BOT = "U00000001";
const BINDING: IntakeThread = { channelId: "C0000000000", threadTs: "1700000000.000100" };
const OTHER: IntakeThread = { channelId: "C0000000001", threadTs: "1700000000.000200" };
const NOW = new Date().toISOString();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function record(issueId: string, state: "queued" | "started", extra: Record<string, unknown> = {}): IntakeRecord {
  const base = {
    issueId, identifier: "TEST-1", url: "https://linear.example.invalid/issue/TEST-1", title: "Export fails",
    description: "The export fails.", issueCreatedAt: NOW, issueUpdatedAt: NOW, comments: {}, messages: [], questions: [],
    inbound: [], createdAt: NOW, updatedAt: NOW,
  };
  if (state === "queued") return { ...base, ...extra, state } as IntakeRecord;
  return { ...base, rule: "owner Slack request", missionId: "mission-1", ...extra, state } as IntakeRecord;
}

async function scopedSurface(options: { workspaceAllowed?: () => boolean; direct?: boolean } = {}) {
  const harness = scriptedMissionHarness();
  const root = mkdtempSync(join(tmpdir(), "intake-scope-"));
  const slack = await startSlackServer();
  for (const thread of [BINDING, OTHER]) slack.seedThread(thread, [{ user: OWNER, text: "Export context" }]);
  const scope = {};
  const config = {
    stateDir: join(root, "state"), runDir: join(root, "run"),
    projects: [{ id: "api", name: "API", path: join(root, "api") }],
    intake: {
      linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "infinite", commentsMirrorToSlack: false },
      slack: { appTokenFile: slack.appTokenFile, botTokenFile: slack.botTokenFile, endpoint: slack.endpoint,
        teamId: slack.teamId, ownerUserId: OWNER, directRequests: true, organizationScope: scope },
      mission: { groupId: "shop", maxSubtasks: 8, maxMinutes: 30 }, maxActive: 3, requireSlackThread: true,
    },
  } as unknown as Config;
  const store = new IntakeStore(config, randomBytes(32));
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint,
    timeoutMs: 2000, teamId: slack.teamId, organizationScope: scope, workspaceAllowed: options.workspaceAllowed });
  const direct = options.direct ? (input: { thread: IntakeThread; ts: string; eventId: string; text: string }) => {
    const issueId = randomUUID();
    store.create(record(issueId, "queued", { thread: input.thread,
      direct: { eventId: input.eventId, ts: input.ts, text: input.text } }));
    return "accepted" as const;
  } : undefined;
  const surface = new IntakeSlackSurface(config, store, harness.missions as unknown as MissionService,
    harness.teams as unknown as TeamService, client, { ...(direct ? { direct } : {}) });
  return {
    harness, root, slack, config, store, client, surface,
    async connect() { await surface.start(); await waitFor(async () => surface.status().connected, Boolean, 10000); },
    async close() {
      surface.close();
      await slack.close();
      harness.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const mention = (channel: string, ts: string, text: string, threadTs?: string) => ({
  type: "app_mention", user: OWNER, channel, ts, ...(threadTs ? { thread_ts: threadTs } : {}), text: `<@${BOT}> ${text}`,
});

test("verified internal mentions are admitted and external Slack Connect mentions are dropped", { timeout: 60000 }, async () => {
  const s = await scopedSurface({ direct: true });
  try {
    s.slack.setConversationInfo(OTHER.channelId, { is_shared: true, is_ext_shared: true,
      shared_team_ids: [s.slack.teamId, "TEXTERNAL"] });
    await s.connect();
    await s.slack.emit(mention(OTHER.channelId, "1700000100.000001", "work: Ignore this source."));
    assert.equal(s.store.list().length, 0, "The external channel never reaches durable intake");
    await s.slack.emit(mention(BINDING.channelId, "1700000100.000002", "work: Update the exporter."));
    await waitFor(async () => s.store.list().length, count => count === 1, 10000);
    assert.equal(s.store.list()[0]!.thread?.channelId, BINDING.channelId);
  } finally { await s.close(); }
});

test("a persisted inbound action waits through revocation and applies once after an authorized replay", { timeout: 60000 }, async () => {
  const s = await scopedSurface();
  try {
    const { id } = await s.harness.create();
    const eventId = "Ev-durable-replay", ts = "1700000900.000001";
    const revisionBeforeReplay = s.harness.get(id)!.revision;
    s.store.create(record(id, "started", { thread: BINDING, missionId: id,
      inbound: [{ eventId, ts, text: "cancel", receivedAt: NOW }] }));
    s.slack.setConversationInfo(BINDING.channelId, { is_shared: true, is_ext_shared: true,
      shared_team_ids: [s.slack.teamId, "TEXTERNAL"] });
    await s.connect();
    await delay(150);
    assert.notEqual(s.harness.get(id)?.status, "cancelled", "A durable reply cannot act under a revoked grant");
    assert.equal(s.store.get(id)!.inbound[0]!.handledAt, undefined);

    s.slack.setConversationInfo(BINDING.channelId, {});
    await s.slack.emit(mention(BINDING.channelId, ts, "cancel", BINDING.threadTs), { eventId });
    await waitFor(async () => s.harness.get(id), mission => mission.status === "cancelled" && Boolean(s.store.get(id)!.inbound[0]!.handledAt), 10000);
    assert.ok(s.store.get(id)!.inbound[0]!.handledAt);
    const appliedRevision = s.harness.get(id)!.revision;
    assert.equal(appliedRevision, revisionBeforeReplay + 1, "The authorized replay applies exactly one mutation");
    await s.slack.emit(mention(BINDING.channelId, ts, "cancel", BINDING.threadTs), { eventId });
    await delay(150);
    assert.equal(s.harness.get(id)!.revision, appliedRevision, "A duplicate event does not repeat the mutation");
    assert.equal(s.store.get(id)!.inbound.length, 1);
  } finally { await s.close(); }
});

test("a block action is not persisted after its Slack channel becomes shared", { timeout: 60000 }, async () => {
  const s = await scopedSurface();
  try {
    const { id } = await s.harness.create();
    await s.harness.report(1, { kind: "question", question: "Which format should the endpoint use?", options: ["CSV", "JSON"] });
    const asked = await waitFor(async () => s.harness.get(id), mission => mission.status === "needs-input", 15000);
    const decision = asked.decisions[0]!;
    s.store.create(record(id, "started", { thread: BINDING, missionId: id, questions: [{ decisionId: decision.id, n: 1 }] }));
    await s.connect();
    await waitFor(async () => s.slack.postPayloads(BINDING), posts => posts.some(post => String(post.text).includes("Which format")), 10000);
    const question = s.slack.posts(BINDING).find(post => post.text.includes("Which format"))!;
    const payload = s.slack.postPayloads(BINDING).find(post => String(post.text).includes("Which format"))!;
    const blocks = payload.blocks as Record<string, any>[];
    const targetBlock = blocks.find(block => Array.isArray(block.elements)
      && block.elements.some((element: Record<string, unknown>) => element.action_id === "infinite_decision_choice_0"))!;
    const control = (targetBlock.elements as Record<string, any>[]).find(element => element.action_id === "infinite_decision_choice_0")!;
    s.slack.setConversationInfo(BINDING.channelId, { is_shared: true, is_ext_shared: true,
      shared_team_ids: [s.slack.teamId, "TEXTERNAL"] });
    await s.slack.emitInteraction({ type: "block_actions", team: { id: s.slack.teamId }, user: { id: OWNER },
      channel: { id: BINDING.channelId }, message: { ts: question.ts, thread_ts: BINDING.threadTs },
      container: { channel_id: BINDING.channelId, message_ts: question.ts, thread_ts: BINDING.threadTs },
      actions: [{ action_id: control.action_id, block_id: targetBlock.block_id, action_ts: "1700000900.000010", value: "0" }] });
    await delay(150);
    assert.equal(s.harness.get(id)?.decisions[0]?.answer, undefined);
    assert.equal(s.store.get(id)!.inbound.length, 0, "The denied interactive action leaves no durable answer");
  } finally { await s.close(); }
});

test("an uncertain Slack outbox waits through revocation and recovers once after grant restoration", { timeout: 60000 }, async () => {
  const s = await scopedSurface();
  const entry = { key: "ack", kind: "ack" as const, text: "Started on TEST-1.", createdAt: NOW,
    status: "pending" as const, attempts: 1, uncertain: true };
  try {
    s.store.create(record(randomUUID(), "started", { thread: BINDING, messages: [entry] }));
    s.slack.setConversationInfo(BINDING.channelId, { is_shared: true, is_ext_shared: true,
      shared_team_ids: [s.slack.teamId, "TEXTERNAL"] });
    await s.connect();
    await delay(150);
    assert.equal(s.store.list()[0]!.messages[0]!.status, "pending");
    assert.equal(s.slack.posts(BINDING).length, 0);
    assert.equal(s.slack.calls.some(call => call.method === "conversations.replies" || call.method === "chat.postMessage"), false,
      "Neither recovery reads nor writes bypass revocation");

    s.surface.close();
    s.slack.setConversationInfo(BINDING.channelId, {});
    const resumed = new IntakeSlackSurface(s.config, s.store, s.harness.missions as unknown as MissionService,
      s.harness.teams as unknown as TeamService, s.client);
    await resumed.start();
    await waitFor(async () => s.store.list()[0]!.messages[0]!.status, status => status === "sent", 10000);
    assert.equal(s.slack.posts(BINDING).length, 1, "The restored grant recovers one post");
    resumed.close();
  } finally { await s.close(); }
});

test("a final mission result is composed after transient source metadata recovers without restart", { timeout: 90000 }, async () => {
  let audienceOpen = false;
  const s = await scopedSurface({ workspaceAllowed: () => audienceOpen });
  try {
    const { id } = await s.harness.create();
    await s.harness.report(1, { kind: "dispatch", summary: "One change", subtasks: [
      { id: "a", repoProjectId: "api", title: "Add the endpoint", objective: "Add one endpoint", size: "solo", parallelism: 1, dependsOn: [] },
    ] });
    const dispatched = await waitFor(async () => s.harness.get(id), mission => Boolean(mission.subtasks[0]?.teamId), 15000);
    s.harness.set(dispatched.subtasks[0]!.teamId!, { status: "no-change" });
    await waitFor(async () => s.harness.get(id), mission => mission.subtasks[0]?.status === "done", 15000);
    await s.harness.report(2, { kind: "result", summary: "The endpoint already exists." });
    await waitFor(async () => s.harness.get(id), mission => mission.status === "ready-for-review", 15000);
    s.store.create(record(id, "started", { thread: BINDING, missionId: id }));
    await s.connect();
    await delay(150);
    assert.equal(s.store.get(id)!.messages.length, 0, "The result is not composed under uncertain metadata");

    audienceOpen = true;
    await waitFor(async () => s.store.get(id)!.messages.find(message => message.kind === "result")?.status,
      status => status === "sent", 12000);
    assert.ok(s.slack.posts(BINDING).some(post => post.text.includes("The endpoint already exists.")));
  } finally { await s.close(); }
});
