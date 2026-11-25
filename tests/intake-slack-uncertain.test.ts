import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IntakeSlackSurface } from "../packages/host/src/intake-slack.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { SlackClient } from "../packages/host/src/slack-client.js";
import type { IntakeRecord, IntakeThread } from "../packages/host/src/intake-types.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { MissionService } from "../packages/host/src/missions.js";
import type { TeamService } from "../packages/host/src/teams.js";
import type { Config } from "../packages/host/src/types.js";
import { waitFor } from "./helpers.js";
import { startSlackServer } from "./fixtures/slack-server.js";

const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
const OWNER = "U00000000";
const BINDING: IntakeThread = { channelId: "C0000000000", threadTs: "1700000000.000100" };
const ACK = 'Started on TEST-1 "Export fails on empty rows". I\'ll post questions and the result here.\nReply with a mention to answer or steer.';

let sequence = 0;
const stamp = () => `1700000100.${String(++sequence).padStart(6, "0")}`;

test("an uncertain failed question message reconciles on matching button click and drops mismatched ts", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "infinite-intake-uncertain-"));
  const slack = await startSlackServer();
  const issueId = randomUUID();
  const now = new Date().toISOString();
  const decision: { id: string; memberId: string; revision: number; question: string; options: string[]; answerMode: "single"; createdAt: string; answer?: string } = {
    id: randomUUID(), memberId: randomUUID(), revision: 1, question: "Skip empty rows?", options: ["Skip", "Write blanks"], answerMode: "single", createdAt: now,
  };
  const mission = { id: randomUUID(), revision: 1, status: "needs-input", decisions: [decision], subtasks: [], events: [] } as unknown as Mission;
  const listeners = new Set<(value: Mission) => void>();
  let answers = 0;
  const missions = {
    peek: (id: string) => (id === mission.id ? structuredClone(mission) : undefined),
    onChange: (listener: (value: Mission) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    answer: async (_id: string, _decisionId: string, input: { text: string }) => {
      answers += 1;
      Object.assign(decision, { answer: input.text });
      mission.revision += 1;
      for (const listener of listeners) listener(mission);
    },
    pause: async () => undefined, resume: async () => undefined, cancel: async () => undefined, steer: async () => undefined,
  } as unknown as MissionService;
  const teams = { get: () => { throw new Error("unused"); } } as unknown as TeamService;
  slack.seedThread(BINDING, [{ user: OWNER, text: "Export fails on empty rows" }]);
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint, timeoutMs: 2000 });
  const config = {
    stateDir: join(root, "intake"),
    runDir: join(root, "run"),
    projects: [{ id: "api", name: "API", path: "/data/instances/work/api" }],
    intake: {
      linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "infinite", commentsMirrorToSlack: false },
      slack: { appTokenFile: slack.appTokenFile, botTokenFile: slack.botTokenFile, teamId: "T00000000", ownerUserId: OWNER, bindByMention: false, endpoint: slack.endpoint },
      mission: { groupId: "shop", maxSubtasks: 8, maxMinutes: 30 },
      maxActive: 3,
      requireSlackThread: true,
    },
  } as unknown as Config;
  const store = new IntakeStore({ stateDir: join(root, "intake") } as Config, randomBytes(32));
  const surface = new IntakeSlackSurface(config, store, missions, teams, client, { log: () => {} });
  try {
    const questionKey = `q:${decision.id}`;
    const blockId = `infinite-decision:${issueId}:${decision.id}`;
    const ackPost = await client.post(BINDING, ACK, `${issueId}:ack`);
    const questionPost = await client.post(BINDING, "**Q1: Skip empty rows?**\n\n1. Skip\n2. Write blanks", `${issueId}:${questionKey}`);
    const record: IntakeRecord = {
      issueId,
      identifier: "TEST-1",
      url: "https://linear.example.invalid/issue/TEST-1",
      title: "Export fails on empty rows",
      description: "Rows with no values fail the export.",
      issueCreatedAt: now,
      issueUpdatedAt: now,
      comments: {},
      state: "started",
      rule: 'label "infinite", owner creator',
      missionId: mission.id,
      thread: BINDING,
      questions: [{ decisionId: decision.id, n: 1 }],
      inbound: [],
      createdAt: now,
      updatedAt: now,
      messages: [
        { key: "ack", kind: "ack", text: ACK, createdAt: now, status: "sent", attempts: 1, ts: ackPost.ts },
        {
          key: questionKey,
          kind: "question",
          text: "**Q1: Skip empty rows?**\n\n1. Skip\n2. Write blanks",
          createdAt: now,
          status: "failed",
          attempts: 4,
          uncertain: true,
          error: "Request timed out.",
          blocks: [{
            type: "actions",
            block_id: blockId,
            elements: [
              { type: "button", text: { type: "plain_text", text: "1. Skip" }, action_id: "infinite_decision_choice_0", value: "0" },
              { type: "button", text: { type: "plain_text", text: "2. Write blanks" }, action_id: "infinite_decision_choice_1", value: "1" },
            ],
          }],
        },
      ],
    };
    store.create(record);
    await surface.start();
    await waitFor(async () => surface.status().connected, connected => connected, 10000);
    const click = (messageTs: string) => slack.emitInteraction({
      type: "block_actions",
      team: { id: "T00000000" },
      user: { id: OWNER },
      channel: { id: BINDING.channelId },
      message: { ts: messageTs, thread_ts: BINDING.threadTs },
      container: { channel_id: BINDING.channelId, message_ts: messageTs, thread_ts: BINDING.threadTs },
      actions: [{ action_id: "infinite_decision_choice_0", block_id: blockId, action_ts: stamp(), value: "0" }],
    });
    await click(ackPost.ts);
    await waitFor(async () => surface.status().dropped, dropped => dropped === 1, 10000);
    await delay(150);
    assert.equal(answers, 0);
    assert.equal(store.get(issueId)!.messages.find(item => item.key === questionKey)?.status, "failed");
    await click(questionPost.ts);
    await waitFor(async () => decision.answer, Boolean, 15000);
    assert.equal(answers, 1);
    assert.equal(decision.answer, "Skip");
    const reconciled = store.get(issueId)!.messages.find(item => item.key === questionKey);
    assert.equal(reconciled?.status, "sent");
    assert.equal(reconciled?.ts, questionPost.ts);
  } finally {
    surface.close();
    await slack.close();
    rmSync(root, { recursive: true, force: true });
  }
});
