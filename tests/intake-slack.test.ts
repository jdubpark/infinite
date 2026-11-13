import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { splitSlackText } from "../packages/host/src/slack-text.js";
import { IntakeSlackSurface } from "../packages/host/src/intake-slack.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { SlackClient } from "../packages/host/src/slack-client.js";
import type { IntakeRecord, IntakeThread } from "../packages/host/src/intake-types.js";
import type { MissionOrigin } from "../packages/host/src/mission-types.js";
import type { Config } from "../packages/host/src/types.js";
import { waitFor } from "./helpers.js";
import { missionHarness as harness } from "./mission-harness.js";
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
type Services = ReturnType<Harness["open"]>;

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

async function surfaceFor(h: Harness, services: Services, options: { bindByMention?: boolean; serverTeamId?: string } = {}) {
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
  const store = new IntakeStore({ stateDir: join(h.root, "intake") } as Config, randomBytes(32));
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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

test("a restart applies a stored reply once and posts an unconfirmed message once", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", {
      thread: BINDING, missionId: id,
      messages: [{ key: "ack", kind: "ack", text: ACK, createdAt: NOW, status: "pending", attempts: 1, uncertain: true }],
      inbound: [{ eventId: "Ev-restart", ts: "1700000100.999999", text: "also cover the CSV export", receivedAt: NOW }],
    }));
    await s.surface.start();
    await waitFor(async () => services.missions.peek(id)!, mission => mission.steering.length === 1, 30000);
    await waitFor(async () => s.store.get(ISSUE)!.messages[0].status, status => status === "sent", 20000);
    s.surface.close();
    s.store.update(ISSUE, record => { for (const entry of record.inbound) { delete entry.handledAt; delete entry.outcome; } });
    const second = new IntakeSlackSurface({ intake: { slack: { bindByMention: false, ownerUserId: OWNER, teamId: "T00000000" } } } as unknown as Config,
      s.store, services.missions, services.teams, s.client);
    await second.start();
    await delay(1500);
    second.close();
    assert.equal(services.missions.peek(id)!.steering.length, 1, "The stored reply applies once");
    assert.equal(s.slack.posts(BINDING).length, 1, "The unconfirmed message is posted once");
  } finally { await s.close(); await h.close(); }
});

test("a reply to a finished request gets one line", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services, { serverTeamId: "T99999999" });
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services);
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
  const h = harness(); const services = h.open(); const s = await surfaceFor(h, services, { bindByMention: true });
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
