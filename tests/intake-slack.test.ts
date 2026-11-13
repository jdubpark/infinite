import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { splitSlackText } from "../packages/host/src/slack-text.js";
import { IntakeSlackSurface } from "../packages/host/src/intake-slack.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { SlackClient } from "../packages/host/src/slack-client.js";
import { deterministicUuid, type IntakeRecord, type IntakeThread } from "../packages/host/src/intake-types.js";
import type { MissionOrigin } from "../packages/host/src/mission-types.js";
import type { Config } from "../packages/host/src/types.js";
import { waitFor } from "./helpers.js";
import { missionHarness as harness, scriptedMissionHarness as scripted } from "./mission-harness.js";
import type { MissionService } from "../packages/host/src/missions.js";
import type { TeamService } from "../packages/host/src/teams.js";
import type { Mission, MissionReport, MissionSubtaskPlan } from "../packages/host/src/mission-types.js";
import type { TeamPublication } from "../packages/host/src/team-types.js";
import { startSlackServer } from "./fixtures/slack-server.js";

test("a long result is split without losing text or cutting a code block", () => {
  const parts = splitSlackText(`intro\n\`\`\`sql\n${"select 1;\n".repeat(600)}\`\`\`\nend`);
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 3000));
  for (const part of parts) assert.equal((part.match(/^```/gm) ?? []).length % 2, 0, "every fence opened in a part is closed in it");
  assert.equal(parts.flatMap(p => p.split("\n")).filter(line => line === "select 1;").length, 600);
  assert.ok(parts[0].startsWith("intro\n```sql\n") && parts.at(-1)!.endsWith("```\nend"));
  assert.ok(parts.slice(1).every(p => p.startsWith("```sql\n")));
});

test("text within the limit is returned unchanged", () => {
  assert.deepEqual(splitSlackText("one\ntwo\n"), ["one\ntwo\n"]);
  assert.deepEqual(splitSlackText("x".repeat(3000)), ["x".repeat(3000)]);
});

test("a single line over the limit is cut at the limit, and no character is lost", () => {
  const line = "y".repeat(7001);
  const parts = splitSlackText(line);
  assert.deepEqual(parts.map(part => part.length), [3000, 3000, 1001]);
  assert.equal(parts.join(""), line);
});

test("a split between lines keeps every line in order", () => {
  const lines = Array.from({ length: 900 }, (_, index) => `line ${index} ${"z".repeat(10)}`);
  const parts = splitSlackText(lines.join("\n"));
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 3000));
  assert.deepEqual(parts.join("\n").split("\n"), lines);
});

const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
const OWNER = "U00000000", TEAMMATE = "U00000002", BOT = "U00000001";
const BINDING: IntakeThread = { channelId: "C0000000000", threadTs: "1700000000.000100" };
const OTHER: IntakeThread = { channelId: "C0000000001", threadTs: "1700000000.000200" };
const ISSUE = randomUUID();
const NOW = new Date().toISOString();
const ACK = 'Started on TEST-1 "Export fails on empty rows". I\'ll post questions and the result here.\nReply with a mention to answer or steer.';
const QUEUED = 'Queued TEST-1 "Export fails on empty rows". It starts when a running request finishes. I\'ll post questions and the result here.';
const FINISHED = "This request has finished. File a follow-up with Linear's agent in this thread.";
const ALREADY = "That question was already answered.";
const CANCEL_REASON = "Cancelled by the owner. Subteam workspaces remain available for inspection.";

type Harness = ReturnType<typeof harness>;
type Services = { missions: MissionService; teams: TeamService };

let sequence = 0;
const stamp = () => `1700000100.${String(++sequence).padStart(6, "0")}`;
const mention = (text: string, overrides: Record<string, unknown> = {}) =>
  ({ type: "app_mention", user: OWNER, channel: BINDING.channelId, ts: stamp(), thread_ts: BINDING.threadTs, text: `<@${BOT}> ${text}`, ...overrides });
const origin = (issueId: string): MissionOrigin => ({
  kind: "intake", issueId, identifier: "TEST-1", url: "https://linear.example.invalid/issue/TEST-1", rule: 'label "infinite", owner creator',
});

function intakeRecord(issueId: string, state: IntakeRecord["state"], extra: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    issueId, identifier: "TEST-1", url: "https://linear.example.invalid/issue/TEST-1", title: "Export fails on empty rows",
    description: "Rows with no values fail the export.", issueCreatedAt: NOW, issueUpdatedAt: NOW, state,
    comments: {}, messages: [], questions: [], inbound: [], createdAt: NOW, updatedAt: NOW, ...extra,
  };
}

async function surfaceFor(services: Services, stateRoot: string, options: { bindByMention?: boolean; serverTeamId?: string } = {}) {
  const slack = await startSlackServer({ teamId: options.serverTeamId });
  // Every bound thread has its root, as in Slack; the fake stores posts only into a thread it knows.
  for (const thread of [BINDING, OTHER]) slack.seedThread(thread, [{ user: OWNER, text: "Export fails on empty rows" }]);
  const client = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint, timeoutMs: 2000 });
  const config = { intake: {
    linear: { teamIds: [randomUUID()], label: "infinite", commentsMirrorToSlack: false },
    slack: { appTokenFile: slack.appTokenFile, botTokenFile: slack.botTokenFile, teamId: "T00000000", ownerUserId: OWNER,
      bindByMention: options.bindByMention ?? false, endpoint: slack.endpoint },
    mission: { groupId: "shop", maxSubtasks: 8, maxMinutes: 30 }, maxActive: 3, requireSlackThread: true,
  } } as unknown as Config;
  const store = new IntakeStore({ stateDir: join(stateRoot, "intake") } as Config, randomBytes(32));
  const surface = new IntakeSlackSurface(config, store, services.missions, services.teams, client);
  return {
    slack, store, surface, client,
    texts: (binding: IntakeThread = BINDING) => slack.posts(binding).map(post => post.text),
    connected: () => waitFor(async () => surface.status().connected, connected => connected, 10000),
    close: async () => { surface.close(); await slack.close(); },
  };
}

/** Starts a mission whose subteam asks the owner a question, which the coordinator escalates to a mission decision. */
async function questionFlow(h: Harness, missions: Services["missions"]) {
  const { id } = await missions.create(h.create(), undefined, origin(ISSUE));
  h.release("release-dispatch");
  const asked = await waitFor(async () => missions.peek(id)!, mission => mission.status === "needs-input", 90000);
  return { id, decision: asked.decisions[0] };
}

test("a started record gets one acknowledgement in its thread", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length >= 1);
    await delay(300);
    assert.deepEqual(s.texts(), [ACK]);
  } finally { await s.close(); await h.close(); }
});

test("a queued record says queued, then started", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    s.store.create(intakeRecord(ISSUE, "queued", { thread: BINDING, holdReason: "max-active" }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length >= 1);
    assert.equal(s.texts()[0], QUEUED);
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.update(ISSUE, record => { record.state = "started"; delete record.holdReason; record.missionId = id; });
    await waitFor(async () => s.texts(), list => list.length >= 2);
    await delay(300);
    assert.deepEqual(s.texts(), [QUEUED, "Started on TEST-1."]);
  } finally { await s.close(); await h.close(); }
});

test("a question is posted with its number and options, and an option number answers it", { timeout: 150000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id, decision } = await questionFlow(h, services.missions);
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    const question = `Q1: ${decision.question}\n1. JSON   2. Text\nReply with a mention and your answer.`;
    await waitFor(async () => s.texts(), list => list.includes(question));
    await s.slack.emit(mention("1"));
    const answered = await waitFor(async () => services.missions.peek(id)!, mission => Boolean(mission.decisions[0].answer), 30000);
    assert.equal(answered.decisions[0].answer, "JSON");
    assert.equal(answered.decisions[0].answeredBy, "owner");
    assert.ok(answered.events.some(event => /^The owner answered a question from Slack; the answer is being forwarded to subtask /.test(event.text)));
    assert.equal(s.texts().at(-1), question, "Answering posts nothing further");
  } finally { await s.close(); await h.close(); }
});

test("plain text answers the open question verbatim", { timeout: 150000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id, decision } = await questionFlow(h, services.missions);
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.some(text => text.startsWith(`Q1: ${decision.question}`)));
    await s.slack.emit(mention("Text"));
    const answered = await waitFor(async () => services.missions.peek(id)!, mission => Boolean(mission.decisions[0].answer), 30000);
    assert.equal(answered.decisions[0].answer, "Text");
  } finally { await s.close(); await h.close(); }
});

test("a question answered in the apps closes it for Slack", { timeout: 150000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id, decision } = await questionFlow(h, services.missions);
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.some(text => text.startsWith(`Q1: ${decision.question}`)));
    const asked = services.missions.peek(id)!;
    await services.missions.answer(id, decision.id, { requestId: randomUUID(), revision: asked.revision, text: "Text" });
    await s.slack.emit(mention("Q1 2"));
    await waitFor(async () => s.texts(), list => list.at(-1) === ALREADY);
    assert.equal(services.missions.peek(id)!.decisions[0].answer, "Text", "The Slack reply does not change the answer");
  } finally { await s.close(); await h.close(); }
});

test("text with no open question steers the coordinator with the owner's words only", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("also cover the CSV export"));
    const steered = await waitFor(async () => services.missions.peek(id)!, mission => mission.steering.at(-1)?.text === "also cover the CSV export", 30000);
    assert.ok(steered.events.some(event => event.text === "Owner direction recorded from Slack for the coordinator. Subtasks started later include it; the coordinator decides whether to forward it to running ones."));
  } finally { await s.close(); await h.close(); }
});

test("status, pause, resume, and cancel are mission actions, in any case", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("STATUS"));
    await waitFor(async () => s.texts(), list => list.at(-1) === "planning");
    await s.slack.emit(mention("Pause"));
    await waitFor(async () => services.missions.peek(id)!, mission => mission.status === "paused", 30000);
    await s.slack.emit(mention("resume"));
    await waitFor(async () => services.missions.peek(id)!, mission => mission.status === "planning", 30000);
    await s.slack.emit(mention("CANCEL"));
    await waitFor(async () => services.missions.peek(id)!, mission => mission.status === "cancelled", 30000);
    await waitFor(async () => s.texts(), list => list.at(-1) === `Cancelled: ${CANCEL_REASON}`);
  } finally { await s.close(); await h.close(); }
});

test("a teammate's mention in a bound thread stores nothing and gets no reply", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length === 1);
    await s.slack.emit(mention("cancel", { user: TEAMMATE }));
    await waitFor(() => Promise.resolve(s.surface.status().dropped), dropped => dropped === 1);
    await delay(300);
    assert.equal(s.store.get(ISSUE)!.inbound.length, 0);
    assert.equal(services.missions.peek(id)!.status, "planning");
    assert.deepEqual(s.texts(), [ACK]);
  } finally { await s.close(); await h.close(); }
});

test("a mention from another workspace, from a bot, or that is not a mention is dropped", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("cancel"), { teamId: "T99999999" });
    await s.slack.emit(mention("cancel", { bot_id: "B00000000" }));
    await s.slack.emit({ ...mention("cancel"), type: "message" });
    await waitFor(() => Promise.resolve(s.surface.status().dropped), dropped => dropped === 3);
    await delay(300);
    assert.equal(s.store.get(ISSUE)!.inbound.length, 0);
    assert.equal(services.missions.peek(id)!.status, "planning");
  } finally { await s.close(); await h.close(); }
});

test("an owner mention in an unbound thread gets no reply and stores nothing", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("cancel", { channel: OTHER.channelId, thread_ts: OTHER.threadTs }));
    await waitFor(() => Promise.resolve(s.surface.status().dropped), dropped => dropped === 1);
    assert.equal(s.texts(OTHER).length, 0);
    assert.equal(s.store.get(ISSUE)!.inbound.length, 0);
    assert.equal(services.missions.peek(id)!.status, "planning");
  } finally { await s.close(); await h.close(); }
});

test("a redelivered envelope yields one answer", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    const before = services.missions.peek(id)!.revision;
    const envelope = await s.slack.emit(mention("also cover the CSV export"));
    await waitFor(async () => services.missions.peek(id)!, mission => mission.steering.length === 1, 30000);
    await s.slack.redeliver(envelope);
    await delay(500);
    assert.equal(s.store.get(ISSUE)!.inbound.length, 1);
    assert.equal(services.missions.peek(id)!.steering.length, 1);
    assert.equal(services.missions.peek(id)!.revision, before + 1, "The redelivered reply advanced the revision once");
  } finally { await s.close(); await h.close(); }
});

test("a lost send response yields one message", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.slack.loseNextPostResponse();
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start();
    await waitFor(async () => s.store.get(ISSUE)!.messages.find(message => message.key === "ack")?.status, status => status === "sent", 20000);
    await delay(500);
    assert.equal(s.slack.posts(BINDING).length, 1);
    assert.equal(s.texts()[0], ACK);
  } finally { await s.close(); await h.close(); }
});

test("a restart applies a stored reply once and finds its unconfirmed message in the thread", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    // The first post reached Slack, but the record never recorded it: the thread holds the message under its key.
    const posted = await s.client.post(BINDING, ACK, "ack");
    s.store.create(intakeRecord(ISSUE, "started", {
      thread: BINDING, missionId: id,
      messages: [{ key: "ack", kind: "ack", text: ACK, createdAt: NOW, status: "pending", attempts: 1, uncertain: true }],
      inbound: [{ eventId: "Ev-restart", ts: "1700000100.999999", text: "also cover the CSV export", receivedAt: NOW }],
    }));
    await s.surface.start();
    await waitFor(async () => services.missions.peek(id)!, mission => mission.steering.length === 1, 30000);
    await waitFor(async () => s.store.get(ISSUE)!.messages[0].status, status => status === "sent", 20000);
    assert.equal(services.missions.peek(id)!.steering.length, 1, "The stored reply applies once");
    assert.equal(s.slack.posts(BINDING).length, 1, "The unconfirmed message is found in the thread, not posted again");
    assert.equal(s.store.get(ISSUE)!.messages[0].ts, posted.ts, "The lookup records the message's ts");
  } finally { await s.close(); await h.close(); }
});

test("an entry that reached the mission before a crash is applied once, with no refusal", { timeout: 60000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    s.store.create(intakeRecord(ISSUE, "started", {
      thread: BINDING, missionId: id,
      inbound: [{ eventId: "Ev-crash", ts: "1700000100.888888", text: "also cover the CSV export", receivedAt: NOW }],
    }));
    // The crash: the mission took the reply at this revision, and the surface stopped before it marked the entry handled.
    const before = sh.get(id).revision;
    await sh.missions.steer(id, { requestId: deterministicUuid("intake-slack-event", "Ev-crash"), revision: before, text: "also cover the CSV export" }, "slack");
    s.store.update(ISSUE, record => { record.inbound[0].revision = before; });
    await s.surface.start();
    await waitFor(async () => s.store.get(ISSUE)!.inbound[0].handledAt, handled => Boolean(handled), 30000);
    assert.equal(sh.get(id).steering.length, 1, "The reply applies once");
    assert.equal(sh.get(id).revision, before + 1, "The replay advances the revision once");
    assert.deepEqual(s.texts(), [ACK], "A replayed reply posts no refusal");
  } finally { await close(); }
});

test("a reply to a finished request gets one line", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "finished", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("also cover the CSV export"));
    await waitFor(async () => s.texts(), list => list.length === 1);
    assert.equal(s.texts().at(-1), FINISHED);
    assert.equal(services.missions.peek(id)!.steering.length, 0);
  } finally { await s.close(); await h.close(); }
});

test("a stray number on a request with no open question gets one line", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("2"));
    await waitFor(async () => s.texts(), list => list.length === 2);
    assert.equal(s.texts()[1], ALREADY);
    assert.equal(services.missions.peek(id)!.steering.length, 0);
  } finally { await s.close(); await h.close(); }
});

test("a cancelled mission and an intake pause each post their status and the next step", { timeout: 90000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const cancelled = await services.missions.create(h.create(), undefined, origin(ISSUE));
    const paused = await services.missions.create(h.create(), undefined, origin("9b1f0c5e-3d2a-4c7b-8e6f-1a2b3c4d5e6f"));
    const pausedIssue = "9b1f0c5e-3d2a-4c7b-8e6f-1a2b3c4d5e6f";
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: cancelled.id }));
    s.store.create(intakeRecord(pausedIssue, "started", { thread: OTHER, missionId: paused.id, identifier: "TEST-2" }));
    await s.surface.start(); await s.connected();
    await services.missions.cancel(cancelled.id, { requestId: randomUUID(), revision: cancelled.revision });
    await waitFor(async () => s.texts(), list => list.at(-1) === `Cancelled: ${CANCEL_REASON}`);
    const reason = "The Linear issue was closed.";
    s.store.update(pausedIssue, record => { record.closure = { reason, at: NOW }; });
    await services.missions.pause(paused.id, { requestId: randomUUID(), revision: paused.revision }, reason);
    const pausedText = `Paused: ${reason}\nReply with a mention and "resume" or "cancel".`;
    await waitFor(async () => s.texts(OTHER), list => list.at(-1) === pausedText);
  } finally { await s.close(); await h.close(); }
});

test("an edited issue gets one note", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length === 1);
    s.store.update(ISSUE, record => { record.editNotedAt = new Date().toISOString(); });
    await delay(50);
    s.store.update(ISSUE, record => { record.editNotedAt = new Date().toISOString(); });
    await waitFor(async () => s.texts(), list => list.some(text => text.includes("was edited")));
    await delay(300);
    assert.equal(s.texts().filter(text => text.includes("was edited")).length, 1);
    assert.equal(s.texts()[1], "TEST-1 was edited after the run started. The run keeps the original text; reply with a mention to steer it.");
  } finally { await s.close(); await h.close(); }
});

test("a token for another workspace stops the surface and nothing is posted", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root, { serverTeamId: "T99999999" });
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start();
    assert.equal(s.surface.status().reason, "The Slack token belongs to a different workspace.");
    assert.equal(s.surface.status().connected, false);
    await delay(300);
    assert.equal(s.slack.calls.filter(call => call.method === "chat.postMessage").length, 0);
  } finally { await s.close(); await h.close(); }
});

test("a Slack outage blocks no mission, and messages arrive when it ends", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root);
  try {
    await s.surface.start(); await s.connected();
    s.slack.unavailable(true);
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    s.store.update(ISSUE, record => { record.updatedAt = new Date().toISOString(); });
    await waitFor(async () => s.store.get(ISSUE)!.messages[0]?.uncertain, uncertain => uncertain === true, 15000);
    assert.equal(services.missions.peek(id)!.status, "planning", "The outage pauses no mission");
    s.slack.unavailable(false);
    await waitFor(async () => s.store.get(ISSUE)!.messages[0]?.status, status => status === "sent", 20000);
    assert.deepEqual(s.texts(), [ACK]);
  } finally { await s.close(); await h.close(); }
});

test("binding by mention attaches a thread to an admitted record that has none", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root, { bindByMention: true });
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { missionId: id }));
    await s.surface.start(); await s.connected();
    const threadTs = "1700000200.000001";
    await s.slack.emit({ type: "app_mention", user: OWNER, channel: BINDING.channelId, ts: threadTs, text: `<@${BOT}> TEST-1` });
    await waitFor(async () => s.store.get(ISSUE)!.thread, thread => thread?.threadTs === threadTs, 15000);
    assert.deepEqual(s.store.get(ISSUE)!.thread, { channelId: BINDING.channelId, threadTs });
    await waitFor(async () => s.texts({ channelId: BINDING.channelId, threadTs }), list => list.length === 1, 15000);
    assert.equal(s.texts({ channelId: BINDING.channelId, threadTs })[0], ACK);
    assert.equal(s.store.get(ISSUE)!.inbound.length, 0, "Binding applies nothing else");
    assert.equal(services.missions.peek(id)!.steering.length, 0);
  } finally { await s.close(); await h.close(); }
});

// Scripted-harness tests: the coordinator and subteams are scripted, so the mission reaches states real sessions cannot.
const until = <T,>(read: () => T, accepts: (value: T) => boolean, timeout = 30000) => waitFor(async () => read(), accepts, timeout);
const plan = (id: string, repoProjectId: string) =>
  ({ id, repoProjectId, title: `Subtask ${id}`, objective: `Do ${id}`, size: "solo" as const, parallelism: 1, dependsOn: [] as string[] });
const teamOf = (mission: Mission, subtaskId: string) => mission.subtasks.find(item => item.id === subtaskId)?.teamId;

async function scriptedSurface(options: { bindByMention?: boolean } = {}) {
  const sh = scripted();
  const stateRoot = mkdtempSync(join(tmpdir(), "intake-scripted-"));
  const s = await surfaceFor({ missions: sh.missions, teams: sh.teams }, stateRoot, options);
  return { sh, s, close: async () => { s.surface.close(); await s.slack.close(); sh.close(); rmSync(stateRoot, { recursive: true, force: true }); } };
}

test("a result with every finished subtask unchanged is posted as an answer", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    await sh.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const teamId = (await until(() => sh.get(id), mission => Boolean(teamOf(mission, "a")))).subtasks[0].teamId!;
    sh.set(teamId, { status: "no-change" });
    await until(() => sh.get(id), mission => mission.subtasks[0].status === "done");
    await sh.report(2, { kind: "result", summary: "The API already had the endpoint." });
    await until(() => sh.get(id), mission => mission.status === "ready-for-review");
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length === 2, 30000);
    assert.equal(s.texts()[1], "Answer (agent report):\nThe API already had the endpoint.");
  } finally { await close(); }
});

test("a result with recorded pull requests and published branches lists each link", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    await sh.report(1, { kind: "dispatch", summary: "Two changes", subtasks: [plan("a", "api"), plan("b", "web")] });
    const started = await until(() => sh.get(id), mission => Boolean(teamOf(mission, "a") && teamOf(mission, "b")));
    const apiTeam = teamOf(started, "a")!, webTeam = teamOf(started, "b")!;
    const pullRequest = { revision: 1, headCommit: "a".repeat(40), pullRequestUrl: "https://github.com/example/api/pull/1", summary: "Adds the endpoint", reportedAt: new Date().toISOString() };
    const publication: TeamPublication = { repository: "example/web", branch: "infinite/web-change", commit: "b".repeat(40), publishedAt: new Date().toISOString() };
    Object.assign(sh.runs.get(apiTeam)!, { pullRequest });
    Object.assign(sh.runs.get(webTeam)!, { publication });
    sh.set(apiTeam, { status: "ready-for-review" });
    sh.set(webTeam, { status: "ready-for-review" });
    await until(() => sh.get(id), mission => mission.subtasks.every(subtask => subtask.status === "done"));
    await sh.report(2, { kind: "result", summary: "Both changes are ready." });
    await until(() => sh.get(id), mission => mission.status === "ready-for-review");
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length === 2, 30000);
    assert.equal(s.texts()[1], "Ready for review (agent report):\nBoth changes are ready.\nPull request: https://github.com/example/api/pull/1\nBranch: example/web infinite/web-change");
  } finally { await close(); }
});

test("a blocked mission posts its reason and the next step", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    await sh.report(1, { kind: "dispatch", summary: "One API change", subtasks: [plan("a", "api")] });
    const teamId = (await until(() => sh.get(id), mission => Boolean(teamOf(mission, "a")))).subtasks[0].teamId!;
    // The subteam's blocked status wakes the coordinator for its next attempt.
    sh.set(teamId, { status: "blocked" });
    await sh.report(2, { kind: "blocked", summary: "The API repository is unavailable" });
    const blocked = await until(() => sh.get(id), mission => mission.status === "blocked");
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start();
    const expected = `Blocked: ${blocked.reason}\nFile a follow-up with Linear's agent in this thread.`;
    await waitFor(async () => s.texts(), list => list.at(-1) === expected, 30000);
    assert.match(blocked.reason ?? "", /The API repository is unavailable/);
  } finally { await close(); }
});

test("a question with no options takes the owner's text literally", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    await sh.report(1, { kind: "question", question: "How many rows should the export keep?", options: [] });
    const asked = await until(() => sh.get(id), mission => mission.status === "needs-input");
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length === 2, 30000);
    assert.equal(s.texts()[1], "Q1: How many rows should the export keep?\nReply with a mention and your answer.");
    await s.slack.emit(mention("2"));
    const answered = await until(() => sh.get(id), mission => Boolean(mission.decisions[0].answer));
    assert.equal(answered.decisions[0].answer, "2");
    assert.equal(answered.decisions[0].id, asked.decisions[0].id);
    assert.ok(answered.events.some(event => event.text === "The owner answered the coordinator's question from Slack."));
  } finally { await close(); }
});

test("with two questions open, Qn addresses one and plain text answers the oldest", { timeout: 120000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    await sh.report(1, { kind: "dispatch", summary: "Two changes", subtasks: [plan("a", "api"), plan("b", "web")] });
    const started = await until(() => sh.get(id), mission => Boolean(teamOf(mission, "a") && teamOf(mission, "b")));
    const apiTeam = teamOf(started, "a")!, webTeam = teamOf(started, "b")!;
    const now = new Date().toISOString();
    const first = randomUUID(), second = randomUUID();
    // Each subteam asks; the coordinator escalates each question to an owner decision in its own attempt.
    sh.set(apiTeam, { status: "needs-input", decisions: [{ id: first, memberId: randomUUID(), revision: 1, question: "Skip empty rows?", options: ["Skip", "Write blanks"], createdAt: now }] });
    await sh.report(2, { kind: "question", question: "Skip empty rows?", options: ["Skip", "Write blanks"], subtaskId: "a", childDecisionId: first });
    await until(() => sh.get(id), mission => mission.status === "needs-input");
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.some(text => text.startsWith("Q1: Skip empty rows?")), 30000);
    sh.set(webTeam, { status: "needs-input", decisions: [{ id: second, memberId: randomUUID(), revision: 1, question: "Keep the header row?", options: [], createdAt: now }] });
    await sh.report(3, { kind: "question", question: "Keep the header row?", options: [], subtaskId: "b", childDecisionId: second });
    await until(() => sh.get(id), mission => mission.decisions.length === 2);
    await waitFor(async () => s.texts(), list => list.some(text => text.startsWith("Q2: Keep the header row?")), 30000);
    await s.slack.emit(mention("Q2 yes"));
    await until(() => sh.get(id), mission => mission.decisions[1].answer === "yes");
    assert.equal(sh.get(id).decisions[0].answer, undefined, "Qn leaves the oldest question open");
    await s.slack.emit(mention("skip them"));
    await until(() => sh.get(id), mission => mission.decisions[0].answer === "skip them");
  } finally { await close(); }
});
