import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { splitSlackText } from "../packages/host/src/slack-text.js";
import { IntakeSlackSurface, type DirectRequest } from "../packages/host/src/intake-slack.js";
import { IntakeStore } from "../packages/host/src/intake-store.js";
import { SlackClient, SlackError } from "../packages/host/src/slack-client.js";
import { deterministicUuid, type IntakeRecord, type IntakeThread } from "../packages/host/src/intake-types.js";
import type { MissionOrigin } from "../packages/host/src/mission-types.js";
import type { Config } from "../packages/host/src/types.js";
import { waitFor } from "./helpers.js";
import { missionHarness as harness, scriptedMissionHarness as scripted } from "./mission-harness.js";
import type { MissionService } from "../packages/host/src/missions.js";
import { TeamError, type TeamService } from "../packages/host/src/teams.js";
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

test("an opening fence is admitted only with room for its closing fence", () => {
  const text = `${"x".repeat(2992)}\n\`\`\`sql\nselect 1;\n\`\`\``;
  const parts = splitSlackText(text);
  assert.ok(parts.every(part => part.length <= 3000), `part lengths ${parts.map(part => part.length)}`);
  for (const part of parts) assert.equal((part.match(/^```/gm) ?? []).length % 2, 0, "every fence opened in a part is closed in it");
  assert.equal(parts.flatMap(part => part.split("\n")).filter(line => line === "select 1;").length, 1);
  assert.equal(parts.join("\n"), text);
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
const THIRD: IntakeThread = { channelId: "C0000000002", threadTs: "1700000000.000300" };
/** A configured project path that no general path rule covers. */
const PROJECT_PATH = "/data/instances/work/api";
const ISSUE = randomUUID();
const NOW = new Date().toISOString();
const ACK = 'Started on TEST-1 "Export fails on empty rows". I\'ll post questions and the result here.\nReply with a mention to answer or steer.';
const QUEUED = 'Queued TEST-1 "Export fails on empty rows". It starts when a running request finishes. I\'ll post questions and the result here.';
const FINISHED = "This request has finished. File a follow-up with Linear's agent in this thread.";
const ALREADY = "That question was already answered.";
const CANCEL_REASON = "Cancelled by the owner. Subteam workspaces remain available for inspection.";
const CANCELLED = `Cancelled: ${CANCEL_REASON}\nFile a follow-up with Linear's agent in this thread.`;

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

type LogLine = { line: string; error: unknown };
const collector = () => { const calls: LogLine[] = []; return { calls, log: (line: string, error: unknown) => { calls.push({ line, error }); } }; };

async function surfaceFor(services: Services, stateRoot: string, options: { bindByMention?: boolean; serverTeamId?: string; wrapClient?: (client: SlackClient) => SlackClient; log?: (line: string, error: unknown) => void;
  directRequests?: boolean; direct?: (store: IntakeStore) => DirectRequest } = {}) {
  const slack = await startSlackServer({ teamId: options.serverTeamId });
  // Every bound thread has its root, as in Slack; the fake stores posts only into a thread it knows.
  for (const thread of [BINDING, OTHER]) slack.seedThread(thread, [{ user: OWNER, text: "Export fails on empty rows" }]);
  const realClient = new SlackClient({ botTokenFile: slack.botTokenFile, appTokenFile: slack.appTokenFile, endpoint: slack.endpoint, timeoutMs: 2000 });
  const client = options.wrapClient ? options.wrapClient(realClient) : realClient;
  const config = { stateDir: join(stateRoot, "intake"), runDir: join(stateRoot, "run"), projects: [{ id: "api", name: "API", path: PROJECT_PATH }], intake: {
    linear: { teamIds: [randomUUID()], creatorId: randomUUID(), label: "infinite", commentsMirrorToSlack: false },
    slack: { appTokenFile: slack.appTokenFile, botTokenFile: slack.botTokenFile, teamId: "T00000000", ownerUserId: OWNER,
      bindByMention: options.bindByMention ?? false, endpoint: slack.endpoint, ...(options.directRequests !== undefined ? { directRequests: options.directRequests } : {}) },
    mission: { groupId: "shop", maxSubtasks: 8, maxMinutes: 30 }, maxActive: 3, requireSlackThread: true,
  } } as unknown as Config;
  const store = new IntakeStore({ stateDir: join(stateRoot, "intake") } as Config, randomBytes(32));
  const surface = new IntakeSlackSurface(config, store, services.missions, services.teams, client,
    { log: options.log ?? collector().log, ...(options.direct ? { direct: options.direct(store) } : {}) });
  return {
    slack, store, surface, client, realClient, config,
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

test("status, pause, resume, and cancel are mission actions, in any case", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    await sh.report(1, { kind: "question", question: "Skip empty rows?", options: ["Skip", "Write blanks"] });
    await until(() => sh.get(id), mission => mission.status === "needs-input");
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.some(text => text.startsWith("Q1: Skip empty rows?")));
    await s.slack.emit(mention("STATUS"));
    await waitFor(async () => s.texts(), list => list.at(-1) === "needs-input\nQ1: Skip empty rows?");
    await s.slack.emit(mention("Pause"));
    await until(() => sh.get(id), mission => mission.status === "paused");
    await s.slack.emit(mention("resume"));
    await until(() => sh.get(id), mission => mission.status !== "paused");
    await s.slack.emit(mention("CANCEL"));
    await until(() => sh.get(id), mission => mission.status === "cancelled");
    await waitFor(async () => s.texts(), list => list.at(-1) === CANCELLED);
  } finally { await close(); }
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

test("a redelivered envelope yields one answer", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    await sh.report(1, { kind: "question", question: "Skip empty rows?", options: ["Skip", "Write blanks"] });
    await until(() => sh.get(id), mission => mission.status === "needs-input");
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length === 2);
    const before = sh.get(id).revision;
    const envelope = await s.slack.emit(mention("1"));
    await until(() => sh.get(id), mission => Boolean(mission.decisions[0].answer));
    await s.slack.redeliver(envelope);
    await delay(500);
    assert.equal(s.store.get(ISSUE)!.inbound.length, 1, "The redelivered envelope adds no entry");
    assert.equal(sh.get(id).decisions[0].answer, "Skip", "The question is answered once");
    assert.equal(sh.get(id).revision, before + 1, "The answer advanced the revision once");
  } finally { await close(); }
});

test("a redelivered event applies an entry that a failed store write left unhandled, exactly once", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length === 1);
    // The write that marks an entry handled fails once per arming, after the entry's work was done.
    const update = s.store.update.bind(s.store);
    let armed = 0;
    s.store.update = (issueId, change) => update(issueId, draft => {
      const handled = draft.inbound.filter(item => item.handledAt).length;
      change(draft);
      if (armed > 0 && draft.inbound.filter(item => item.handledAt).length > handled) { armed -= 1; throw new Error("The disk is full."); }
    });
    const handledAt = (index: number) => s.store.get(ISSUE)!.inbound[index]?.handledAt;

    // A mission action: the steer reached the mission, and the entry stayed unhandled.
    const before = sh.get(id).revision;
    armed = 1;
    const steer = await s.slack.emit(mention("also cover the CSV export"));
    await until(() => armed, left => left === 0);
    await delay(300);
    assert.equal(sh.get(id).steering.length, 1);
    assert.equal(handledAt(0), undefined, "The failed write left the steer unhandled");
    await s.slack.redeliver(steer);
    await until(() => handledAt(0), handled => Boolean(handled), 10000);
    assert.equal(sh.get(id).steering.length, 1, "The steer reaches the mission once");
    assert.equal(sh.get(id).revision, before + 1, "The steer advances the revision once");
    assert.equal(s.store.get(ISSUE)!.inbound[0].outcome, "steered");

    // A reply: nothing was posted, and the redelivery posts it once.
    const posts = s.texts().length;
    armed = 1;
    const status = await s.slack.emit(mention("status"));
    await until(() => armed, left => left === 0);
    await delay(300);
    assert.equal(handledAt(1), undefined, "The failed write left the status request unhandled");
    assert.equal(s.texts().length, posts, "No reply was composed");
    await s.slack.redeliver(status);
    await until(() => handledAt(1), handled => Boolean(handled), 10000);
    await waitFor(async () => s.texts(), list => list.length === posts + 1, 10000);

    // A redelivery of a handled event still does nothing.
    await s.slack.redeliver(steer);
    await s.slack.redeliver(status);
    await delay(500);
    assert.equal(s.texts().length, posts + 1, "The status reply is posted once");
    assert.equal(sh.get(id).steering.length, 1);
    assert.equal(s.store.get(ISSUE)!.inbound.length, 2);
  } finally { await close(); }
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
    const posted = await s.client.post(BINDING, ACK, `${ISSUE}:ack`);
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
    s.store.update(ISSUE, record => { record.inbound[0].call = { action: "steer", text: "also cover the CSV export", revision: before }; });
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
    await waitFor(async () => s.texts(), list => list.at(-1) === CANCELLED);
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

test("a Slack outage blocks no mission, and messages arrive when it ends", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length === 1);
    s.slack.unavailable(true);
    await sh.report(1, { kind: "question", question: "Skip empty rows?", options: ["Skip", "Write blanks"] });
    const asked = await until(() => sh.get(id), mission => mission.status === "needs-input");
    await waitFor(async () => s.store.get(ISSUE)!.messages.find(message => message.key.startsWith("q:"))?.uncertain, uncertain => uncertain === true, 15000);
    await sh.missions.answer(id, asked.decisions[0].id, { requestId: randomUUID(), revision: sh.get(id).revision, text: "Skip" });
    assert.equal(sh.get(id).decisions[0].answer, "Skip", "The owner answers through the apps during the outage");
    assert.notEqual(sh.get(id).status, "blocked", "The outage blocks no mission");
    s.slack.unavailable(false);
    await waitFor(async () => s.texts(), list => list.some(text => text.startsWith("Q1: Skip empty rows?")), 20000);
    assert.deepEqual(s.texts(), [ACK, s.texts()[1]]);
    assert.equal(s.texts()[1], "Q1: Skip empty rows?\n1. Skip   2. Write blanks\nReply with a mention and your answer.");
  } finally { await close(); }
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

async function scriptedSurface(options: { bindByMention?: boolean; wrapClient?: (client: SlackClient) => SlackClient; wrapTeams?: (teams: TeamService) => TeamService; wrapMissions?: (missions: MissionService) => MissionService; log?: (line: string, error: unknown) => void } = {}) {
  const sh = scripted();
  const stateRoot = mkdtempSync(join(tmpdir(), "intake-scripted-"));
  const teams = options.wrapTeams ? options.wrapTeams(sh.teams as unknown as TeamService) : sh.teams as unknown as TeamService;
  const missions = sh.missions as unknown as MissionService;
  const s = await surfaceFor({ missions: options.wrapMissions ? options.wrapMissions(missions) : missions, teams }, stateRoot, options);
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
    await s.slack.emit(mention("Q2 maybe"));
    await waitFor(async () => s.texts(), list => list.at(-1) === ALREADY, 20000);
    assert.equal(sh.get(id).decisions[0].answer, undefined, "A Qn naming an answered question changes nothing");
    await s.slack.emit(mention("skip them"));
    await until(() => sh.get(id), mission => mission.decisions[0].answer === "skip them");
  } finally { await close(); }
});

test("a plain-text answer that reached the mission is replayed as that answer, not re-routed", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    await sh.report(1, { kind: "question", question: "Skip empty rows?", options: ["Skip", "Write blanks"] });
    const asked = await until(() => sh.get(id), mission => mission.status === "needs-input");
    const decisionId = asked.decisions[0].id;
    s.store.create(intakeRecord(ISSUE, "started", {
      thread: BINDING, missionId: id,
      inbound: [{ eventId: "Ev-answer", ts: "1700000100.777777", text: "skip them", receivedAt: NOW }],
    }));
    // The crash: the answer reached the mission at this revision, and the surface stopped before marking the entry handled.
    const before = sh.get(id).revision;
    await sh.missions.answer(id, decisionId, { requestId: deterministicUuid("intake-slack-event", "Ev-answer"), revision: before, text: "skip them" }, "slack");
    s.store.update(ISSUE, record => { record.inbound[0].call = { action: "answer", decisionId, text: "skip them", revision: before }; });
    await s.surface.start();
    await waitFor(async () => s.store.get(ISSUE)!.inbound[0].handledAt, handled => Boolean(handled), 30000);
    // Routed afresh, "skip them" would now steer, because the question is answered. The saved call is replayed instead.
    assert.equal(sh.get(id).revision, before + 1, "The replay advances the revision once");
    assert.equal(sh.get(id).steering.length, 0, "No steering entry exists");
    assert.equal(sh.get(id).decisions[0].answer, "skip them", "The answer is the original text");
    assert.ok(!s.texts().some(text => text.includes("different mission action")), "The replay posts no refusal");
  } finally { await close(); }
});

test("a post is marked uncertain before it is sent, so a crash inside the send is found, not posted again", { timeout: 60000 }, async () => {
  const observed: boolean[] = [];
  let current: { store: IntakeStore; surface: IntakeSlackSurface } | undefined;
  let died = false;
  const { sh, s, close } = await scriptedSurface({ wrapClient: real => ({
    authTest: () => real.authTest(),
    connect: handle => real.connect(handle),
    thread: binding => real.thread(binding),
    post: async (binding: IntakeThread, text: string, key: string) => {
      if (died) return new Promise<never>(() => undefined);
      observed.push(current!.store.get(ISSUE)!.messages.find(message => message.key === "ack")?.uncertain === true);
      await real.post(binding, text, key);
      // The post reaches Slack; the process dies before the receipt comes back.
      died = true;
      current!.surface.close();
      return new Promise<never>(() => undefined);
    },
  }) as unknown as SlackClient });
  try {
    current = s;
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING }));
    await s.surface.start();
    await waitFor(async () => died, done => done, 15000);
    const second = new IntakeSlackSurface(s.config, s.store, sh.missions, sh.teams, s.realClient);
    await second.start();
    await waitFor(async () => s.store.get(ISSUE)!.messages[0]?.status, status => status === "sent", 20000);
    second.close();
    const posts = s.slack.posts(BINDING);
    assert.equal(posts.length, 1, "The fake holds exactly one post for the message");
    assert.equal(s.store.get(ISSUE)!.messages[0].ts, posts[0].ts, "The record holds the post's ts");
    assert.deepEqual(observed, [true], "The message was uncertain when its post was made");
  } finally { await close(); }
});

test("two records in one thread keep their Slack receipts apart", { timeout: 90000 }, async () => {
  const { s, close } = await scriptedSurface();
  try {
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length === 1);
    const second = randomUUID();
    s.store.create(intakeRecord(second, "started", { thread: BINDING, identifier: "TEST-2", title: "Second request" }));
    s.slack.unavailable(true);
    s.store.update(second, record => { record.updatedAt = new Date().toISOString(); });
    await waitFor(async () => s.store.get(second)!.messages[0]?.uncertain, uncertain => uncertain === true, 15000);
    s.slack.unavailable(false);
    await waitFor(async () => s.texts(), list => list.length === 2, 20000);
    const posts = s.slack.posts(BINDING);
    assert.match(posts[0].text, /^Started on TEST-1 /);
    assert.match(posts[1].text, /^Started on TEST-2 /);
    assert.equal(s.store.get(ISSUE)!.messages[0].ts, posts[0].ts);
    assert.equal(s.store.get(second)!.messages[0].ts, posts[1].ts);
  } finally { await close(); }
});

test("a result whose composition fails is retried for its record until it is posted", { timeout: 90000 }, async () => {
  let failing = true;
  const { sh, s, close } = await scriptedSurface({ log: collector().log, wrapTeams: teams => ({ get: (id: string) => {
    if (failing) { failing = false; throw new Error("The team service is unavailable."); }
    return teams.get(id);
  } }) as typeof teams });
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
    const error = await waitFor(async () => s.surface.status().lastError, message => message !== undefined, 15000);
    assert.equal(error, "TEST-1: Error", "The status carries the summary, not the message");
    assert.ok(!s.texts().some(text => text.startsWith("Answer (agent report)")), "No result is posted while composition fails");
    await waitFor(async () => s.texts(), list => list.includes("Answer (agent report):\nThe API already had the endpoint."), 30000);
    assert.equal(s.surface.status().lastError, undefined, "A later success clears the error");
  } finally { await close(); }
});

test("a composition failure keeps no part of the error's text", { timeout: 90000 }, async () => {
  const log = collector();
  const leak = Object.assign(new Error("connect ECONNRESET 192.0.2.7 /srv/infinite-data/work/checkout"), { code: "ECONNRESET" });
  const leaks = (text: string) => !text.includes("192.0.2.7") && !text.includes("/srv/infinite-data/work/checkout");
  let failing = true;
  const { sh, s, close } = await scriptedSurface({ log: log.log, wrapTeams: teams => ({ get: (id: string) => {
    if (failing) { failing = false; throw leak; }
    return teams.get(id);
  } }) as typeof teams });
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
    const lastError = await waitFor(async () => s.surface.status().lastError, message => message !== undefined, 15000);
    assert.equal(lastError, "TEST-1: Error (ECONNRESET)", "The status carries the summary and the identifier");
    assert.ok(leaks(JSON.stringify(s.surface.status())), "The status holds no part of the error's text");
    assert.ok(leaks(JSON.stringify(s.store.get(ISSUE))), "The stored record holds no part of the error's text");
    await waitFor(async () => s.texts(), list => list.includes("Answer (agent report):\nThe API already had the endpoint."), 30000);
    assert.ok(s.texts().every(leaks), "No post holds part of the error's text");
    assert.ok(log.calls.some(call => call.error === leak && call.line === "Intake Slack compose failed for TEST-1."), "The log received the error itself");
  } finally { await close(); }
});

test("a delivery failure that is not Slack's keeps no part of the error's text", { timeout: 90000 }, async () => {
  const log = collector();
  const leak = Object.assign(new Error("connect ECONNRESET 192.0.2.7 /srv/infinite-data/work/checkout"), { code: "ECONNRESET" });
  const leaks = (text: string) => !text.includes("192.0.2.7") && !text.includes("/srv/infinite-data/work/checkout");
  let calls = 0;
  const { s, close } = await scriptedSurface({ log: log.log, wrapClient: real => ({
    authTest: () => real.authTest(),
    connect: handle => real.connect(handle),
    thread: binding => real.thread(binding),
    post: async (binding: IntakeThread, text: string, key: string) => {
      calls += 1;
      if (calls === 1) throw leak;
      if (calls === 2) throw new SlackError("ratelimited", true);
      return real.post(binding, text, key);
    },
  }) as unknown as SlackClient });
  try {
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING }));
    await s.surface.start();
    const first = await waitFor(async () => s.store.get(ISSUE)!.messages[0]?.error, error => error !== undefined, 15000);
    assert.equal(first, "Error (ECONNRESET)", "A non-Slack error is stored as its summary");
    assert.ok(!JSON.stringify(s.store.get(ISSUE)).includes("192.0.2.7"), "The record holds no part of the error's text");
    assert.ok(!JSON.stringify(s.surface.status()).includes("192.0.2.7"), "The status holds no part of the error's text");
    const second = await waitFor(async () => s.store.get(ISSUE)!.messages[0]?.error, error => error === "Slack request failed: ratelimited", 60000);
    assert.equal(second, "Slack request failed: ratelimited", "A Slack error is stored with Slack's code");
    await waitFor(async () => s.store.get(ISSUE)!.messages[0]?.status, status => status === "sent", 60000);
    assert.ok(log.calls.some(call => call.error === leak && call.line === "Intake Slack deliver failed for TEST-1."), "The log received the error itself");
  } finally { await close(); }
});

test("questions, results, and blocked reasons reach Slack without host paths or addresses", { timeout: 60000 }, async () => {
  const leak = `/srv/infinite-data/instances/work/workspaces/api/src/a.ts, ${PROJECT_PATH}/src/b.ts and 192.0.2.7`;
  const leaks = (text: string) => ["/srv/infinite-data", PROJECT_PATH, "192.0.2.7"].filter(value => text.includes(value));
  const base = { revision: 1, decisions: [], subtasks: [], steering: [], events: [] };
  const missions = new Map<string, Mission>([
    ["m-question", { ...base, id: "m-question", status: "needs-input",
      decisions: [{ id: "d1", question: `Keep ${leak}?`, options: ["Keep", `Move it from ${leak}`] }] } as unknown as Mission],
    ["m-result", { ...base, id: "m-result", status: "ready-for-review", result: { revision: 1, summary: `Changed ${leak}. Docs: https://example.com/opt/x` },
      subtasks: [{ id: "a", status: "done", teamStatus: "ready-for-review", teamId: "team-a" }] } as unknown as Mission],
    ["m-blocked", { ...base, id: "m-blocked", status: "blocked", reason: `Cannot reach ${leak}` } as unknown as Mission],
  ]);
  const services = {
    missions: { peek: (id: string) => missions.get(id), onChange: () => () => undefined } as unknown as MissionService,
    teams: { get: () => ({ pullRequest: { pullRequestUrl: "https://github.com/example/api/pull/1" } }) } as unknown as TeamService,
  };
  const stateRoot = mkdtempSync(join(tmpdir(), "intake-outbound-"));
  const s = await surfaceFor(services, stateRoot);
  try {
    s.slack.seedThread(THIRD, [{ user: OWNER, text: "Export fails on empty rows" }]);
    const second = randomUUID(), third = randomUUID();
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: "m-question" }));
    s.store.create(intakeRecord(second, "started", { thread: OTHER, missionId: "m-result", identifier: "TEST-2" }));
    s.store.create(intakeRecord(third, "started", { thread: THIRD, missionId: "m-blocked", identifier: "TEST-3" }));
    await s.surface.start();
    for (const thread of [BINDING, OTHER, THIRD]) await waitFor(async () => s.texts(thread), list => list.length === 2, 15000);
    const stored = [ISSUE, second, third].flatMap(id => s.store.get(id)!.messages.map(message => message.text));
    const posted = [BINDING, OTHER, THIRD].flatMap(thread => s.texts(thread));
    for (const text of [...stored, ...posted]) assert.deepEqual(leaks(text), [], text);
    assert.equal(s.texts(BINDING)[1], "Q1: Keep [local path omitted], [local path omitted] and [address omitted]?\n1. Keep   2. Move it from [local path omitted], [local path omitted] and [address omitted]\nReply with a mention and your answer.");
    assert.equal(s.texts(OTHER)[1], "Ready for review (agent report):\nChanged [local path omitted], [local path omitted] and [address omitted]. Docs: https://example.com/opt/x\nPull request: https://github.com/example/api/pull/1");
    assert.match(s.texts(THIRD)[1], /^Blocked: Cannot reach \[local path omitted\]/);
  } finally { await s.close(); rmSync(stateRoot, { recursive: true, force: true }); }
});

const AMBIGUOUS = "More than one request is open in this thread: TEST-1, TEST-2. Start your reply with an identifier or a question number.";
const SECOND = "8d2c4f1a-6b3e-4a5d-9c7f-0e1d2c3b4a59";

/**
 * Two requests bound to one thread: A (TEST-1, older) asked Q1, and B (TEST-2, newer) asked Q2, or B is still queued.
 * Question numbers are given up front, so each test addresses them without waiting on composition order.
 */
async function sharedThread(options: { secondQueued?: boolean } = {}) {
  const { sh, s, close } = await scriptedSurface();
  const a = await sh.create();
  await sh.report(1, { kind: "question", question: "Skip empty rows?", options: ["Skip", "Write blanks"] });
  const askedA = await until(() => sh.get(a.id), mission => mission.status === "needs-input");
  s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: a.id, issueCreatedAt: "2026-11-13T09:00:00.000Z",
    questions: [{ decisionId: askedA.decisions[0].id, n: 1 }] }));
  let b: string | undefined;
  if (options.secondQueued) {
    s.store.create(intakeRecord(SECOND, "queued", { thread: BINDING, identifier: "TEST-2", title: "Second request", issueCreatedAt: "2026-11-13T10:00:00.000Z", holdReason: "max-active" }));
  } else {
    b = (await sh.create()).id;
    await sh.report(2, { kind: "question", question: "Keep the header row?", options: [] });
    const askedB = await until(() => sh.get(b!), mission => mission.status === "needs-input");
    s.store.create(intakeRecord(SECOND, "started", { thread: BINDING, missionId: b, identifier: "TEST-2", title: "Second request", issueCreatedAt: "2026-11-13T10:00:00.000Z",
      questions: [{ decisionId: askedB.decisions[0].id, n: 2 }] }));
  }
  await s.surface.start(); await s.connected();
  await waitFor(async () => s.texts(), list => list.length === (options.secondQueued ? 3 : 4), 20000);
  /** Emits the event and resolves once the surface has handled it, which is when the envelope is acknowledged. */
  const send = async (event: Record<string, unknown>, eventId?: string) => {
    const envelope = await s.slack.emit(event, eventId ? { eventId } : {});
    await waitFor(async () => s.slack.acks(), acks => acks.includes(envelope), 10000);
  };
  return { sh, s, close, a: a.id, b, send };
}

test("in a thread shared by two requests, a question number reaches the request that asked it", { timeout: 120000 }, async () => {
  const { sh, a, b, send, close } = await sharedThread();
  try {
    await send(mention("Q1 skip"));
    await until(() => sh.get(a), mission => mission.decisions[0].answer === "skip", 20000);
    assert.equal(sh.get(b!).decisions[0].answer, undefined, "Q1 leaves the newer request untouched");
    await send(mention("Q2 yes"));
    await until(() => sh.get(b!), mission => mission.decisions[0].answer === "yes", 20000);
    assert.equal(sh.get(a).decisions[0].answer, "skip");
  } finally { await close(); }
});

test("in a thread shared by two open requests, an unprefixed action applies to neither, and an identifier picks one", { timeout: 120000 }, async () => {
  const { sh, s, a, b, send, close } = await sharedThread();
  try {
    await send(mention("cancel"));
    await waitFor(async () => s.texts(), list => list.at(-1) === AMBIGUOUS, 20000);
    assert.equal(sh.get(a).status, "needs-input", "The older request is not cancelled");
    assert.equal(sh.get(b!).status, "needs-input", "The newer request is not cancelled");
    assert.deepEqual(s.store.get(SECOND)!.inbound.map(item => item.outcome), ["ambiguous"]);
    await send(mention("TEST-1 cancel"));
    await until(() => sh.get(a), mission => mission.status === "cancelled", 20000);
    assert.equal(sh.get(b!).status, "needs-input", "Naming TEST-1 leaves TEST-2 running");
    assert.equal(s.store.get(ISSUE)!.inbound.at(-1)!.text, "cancel", "The identifier is removed from the stored text");
  } finally { await close(); }
});

test("with the newer request still queued, Q1 answers the older one", { timeout: 120000 }, async () => {
  const { sh, a, send, close } = await sharedThread({ secondQueued: true });
  try {
    await send(mention("Q1 skip"));
    await until(() => sh.get(a), mission => mission.decisions[0].answer === "skip", 20000);
  } finally { await close(); }
});

test("in a shared thread, a second event for the same message and a redelivered event change nothing", { timeout: 120000 }, async () => {
  const { sh, s, a, b, send, close } = await sharedThread();
  try {
    const first = mention("Q2 yes");
    await send(first, "Ev-first");
    await until(() => sh.get(b!), mission => mission.decisions[0].answer === "yes", 20000);
    const posts = s.texts().length;
    // A new event ID for the same message, as Slack may send for an edit.
    await send(mention("status", { ts: first.ts }), "Ev-edited");
    // The same event ID delivered again, here with different text, as a redelivery must not be re-read.
    await send(mention("Q1 skip"), "Ev-first");
    await delay(500);
    assert.equal(s.texts().length, posts, "Neither duplicate gets a reply");
    assert.equal(sh.get(a).decisions[0].answer, undefined, "Neither duplicate reaches the other request");
    assert.equal(s.store.get(ISSUE)!.inbound.length, 0);
    assert.equal(s.store.get(SECOND)!.inbound.length, 1);
  } finally { await close(); }
});

test("an unexpected failure of a mission action from a reply is logged and gets the fixed reply", { timeout: 90000 }, async () => {
  const log = collector();
  const failure = new Error("Steering failed at /srv/infinite-data/work/checkout");
  const { sh, s, close } = await scriptedSurface({ log: log.log, wrapMissions: missions => new Proxy(missions, {
    get: (target, property) => {
      if (property === "steer") return async () => { throw failure; };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) });
  try {
    const { id } = await sh.create();
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("also cover the CSV export"));
    await waitFor(async () => s.texts(), list => list.at(-1) === "The request could not be applied.", 20000);
    assert.ok(log.calls.some(call => call.error === failure && call.line === "Intake Slack action failed for TEST-1."), "The log received the error itself");
  } finally { await close(); }
});

const HELD = "This project does not exist.";
const RECEIVED = `Received TEST-1 "Export fails on empty rows". It has not started: ${HELD}\nI'll post questions and the result here once it starts.`;

test("a request whose start is refused is acknowledged once with the hold reason, then told when it starts", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    s.store.create(intakeRecord(ISSUE, "queued", { thread: BINDING, holdReason: HELD }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length >= 1, 15000);
    s.store.update(ISSUE, record => { record.holdReason = "The start failed and will be retried: Error"; });
    s.store.update(ISSUE, record => { record.holdReason = "max-active"; });
    s.store.update(ISSUE, record => { record.updatedAt = new Date().toISOString(); });
    await delay(500);
    assert.deepEqual(s.texts(), [RECEIVED], "A later hold reason posts nothing");
    const { id } = await sh.create();
    s.store.update(ISSUE, record => { record.state = "started"; delete record.holdReason; record.missionId = id; });
    await waitFor(async () => s.texts(), list => list.length >= 2, 15000);
    await delay(300);
    assert.deepEqual(s.texts(), [RECEIVED, "Started on TEST-1."]);
  } finally { await close(); }
});

test("a request that starts on its first attempt gets one acknowledgement", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    // Admission's record, before the first start attempt has set a state or a hold reason.
    s.store.create(intakeRecord(ISSUE, "queued", { thread: BINDING }));
    await s.surface.start(); await s.connected();
    await delay(300);
    assert.deepEqual(s.texts(), []);
    const { id } = await sh.create();
    s.store.update(ISSUE, record => { record.state = "started"; record.missionId = id; });
    await waitFor(async () => s.texts(), list => list.length >= 1, 15000);
    await delay(300);
    assert.deepEqual(s.texts(), [ACK]);
  } finally { await close(); }
});

/** A title long enough that every acknowledgement naming it is split into parts. */
const LONG_TITLE = "Export fails on empty rows ".repeat(120).trim();
const sentMessages = (s: Awaited<ReturnType<typeof surfaceFor>>, count: number) =>
  waitFor(async () => s.store.get(ISSUE)!.messages, list => list.length >= count && list.every(message => message.status === "sent"), 15000);

test("a held request whose notice is split into parts gets one started line when it starts", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const notice = splitSlackText(`Received TEST-1 "${LONG_TITLE}". It has not started: ${HELD}\nI'll post questions and the result here once it starts.`);
    assert.ok(notice.length > 1, "The notice is split");
    s.store.create(intakeRecord(ISSUE, "queued", { thread: BINDING, holdReason: HELD, title: LONG_TITLE }));
    await s.surface.start(); await s.connected();
    await sentMessages(s, notice.length);
    assert.deepEqual(s.texts(), notice);
    const { id } = await sh.create();
    s.store.update(ISSUE, record => { record.state = "started"; delete record.holdReason; record.missionId = id; });
    await waitFor(async () => s.texts(), list => list.length > notice.length, 15000);
    await delay(300);
    assert.deepEqual(s.texts(), [...notice, "Started on TEST-1."]);
  } finally { await close(); }
});

test("a request that starts on its first attempt with a split acknowledgement gets no separate started line", { timeout: 90000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const ack = splitSlackText(`Started on TEST-1 "${LONG_TITLE}". I'll post questions and the result here.\nReply with a mention to answer or steer.`);
    assert.ok(ack.length > 1, "The acknowledgement is split");
    s.store.create(intakeRecord(ISSUE, "queued", { thread: BINDING, title: LONG_TITLE }));
    await s.surface.start(); await s.connected();
    const { id } = await sh.create();
    s.store.update(ISSUE, record => { record.state = "started"; record.missionId = id; });
    await sentMessages(s, ack.length);
    await delay(300);
    assert.deepEqual(s.texts(), ack);
  } finally { await close(); }
});

test("a record over the message bound keeps its composed messages, so nothing is posted again", { timeout: 60000 }, async () => {
  const { s, close } = await scriptedSurface();
  try {
    const sent = (key: string, kind: IntakeRecord["messages"][number]["kind"], text: string, n: number) =>
      ({ key, kind, text, createdAt: NOW, status: "sent" as const, attempts: 1, ts: `1700000300.${String(n).padStart(6, "0")}` });
    const replies = Array.from({ length: 400 }, (_, index) => sent(`reply:Ev-${index}`, "reply", "That question was already answered.", index + 2));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, editNotedAt: NOW,
      messages: [sent("ack", "ack", ACK, 0), sent("edit-note", "edit-note", "TEST-1 was edited after the run started.", 1), ...replies] }));
    const kept = s.store.get(ISSUE)!.messages;
    assert.equal(kept.length, 400);
    assert.deepEqual(kept.slice(0, 2).map(message => message.key), ["ack", "edit-note"], "The trim keeps composed messages");
    assert.equal(kept[2].key, "reply:Ev-2", "The trim drops the oldest replies");
    await s.surface.start(); await s.connected();
    s.store.update(ISSUE, record => { record.updatedAt = new Date().toISOString(); });
    await delay(500);
    assert.equal(s.slack.posts(BINDING).length, 0, "A reconcile after the trim posts nothing");
    assert.equal(s.store.get(ISSUE)!.messages.length, 400);
  } finally { await close(); }
});

test("a record with more than 400 composed messages still accepts a reply and delivers it", { timeout: 60000 }, async () => {
  const { sh, s, close } = await scriptedSurface();
  try {
    const { id } = await sh.create();
    const composed = Array.from({ length: 401 }, (_, index) => ({ key: `status:blocked:${index}`, kind: "status" as const, text: "Blocked: earlier.",
      createdAt: NOW, status: "sent" as const, attempts: 1, ts: `1700000400.${String(index).padStart(6, "0")}` }));
    s.store.create(intakeRecord(ISSUE, "finished", { thread: BINDING, missionId: id, messages: composed }));
    assert.equal(s.store.get(ISSUE)!.messages.length, 401, "Composed messages are kept above the bound");
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("also cover the CSV export"));
    await waitFor(async () => s.texts(), list => list.includes(FINISHED), 15000);
    await delay(300);
    assert.deepEqual(s.texts(), [FINISHED], "The reply is posted once");
    // Once sent, the reply will not be sent again, so the next write may drop it; the composed messages all stay.
    const kept = s.store.get(ISSUE)!.messages;
    assert.deepEqual(kept.map(message => message.key), composed.map(message => message.key));
  } finally { await close(); }
});

test("a permanent Slack identity failure sets a reason that names Slack's code, and a transient one sets none", { timeout: 60000 }, async () => {
  const sh = scripted();
  const services = { missions: sh.missions as unknown as MissionService, teams: sh.teams as unknown as TeamService };
  const roots: string[] = [], surfaces: Awaited<ReturnType<typeof surfaceFor>>[] = [];
  const open = async () => {
    const root = mkdtempSync(join(tmpdir(), "intake-identity-"));
    roots.push(root);
    const s = await surfaceFor(services, root);
    surfaces.push(s);
    return s;
  };
  try {
    for (const [token, reason] of [["not-a-bot-token\n", "The Slack identity check failed: invalid_auth."], ["\n", "The Slack identity check failed: credential_unavailable."]]) {
      const s = await open();
      writeFileSync(s.slack.botTokenFile, token, { mode: 0o600 });
      await s.surface.start();
      assert.equal(s.surface.status().reason, reason);
      assert.equal(s.surface.status().connected, false);
    }
    const s = await open();
    s.slack.unavailable(true);
    await s.surface.start();
    assert.equal(s.surface.status().reason, undefined, "A transient failure is retried with no reason");
  } finally {
    for (const s of surfaces) await s.close();
    sh.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

// Direct requests

const URL1 = "https://linear.example.invalid/issue/TEST-1";
const FINISHED_DIRECT = "This request has finished. Mention me in this thread to file a follow-up.";

/** A stand-in for the service: it records each call and creates the unfiled record, as `requestFromSlack` does. */
function directStub(store: IntakeStore) {
  const calls: Parameters<DirectRequest>[0][] = [];
  const direct: DirectRequest = input => {
    calls.push(input);
    store.create(intakeRecord(randomUUID(), "queued", { identifier: "", url: "", thread: input.thread, direct: { eventId: input.eventId, ts: input.ts, text: input.text } }));
    return "accepted";
  };
  return { calls, direct };
}

async function directSurface(options: { directRequests?: boolean } = {}) {
  const h = harness(); const services = h.open();
  const stub: { calls: Parameters<DirectRequest>[0][] } = { calls: [] };
  const s = await surfaceFor(services, h.root, { directRequests: options.directRequests ?? true,
    direct: store => { const made = directStub(store); stub.calls = made.calls; return made.direct; } });
  return { s, calls: () => stub.calls, close: async () => { await s.close(); await h.close(); } };
}
const inOther = (text: string, overrides: Record<string, unknown> = {}) => mention(text, { channel: OTHER.channelId, thread_ts: OTHER.threadTs, ...overrides });

test("an owner mention in an unbound thread files one request, and a mention by anyone else does not", { timeout: 60000 }, async () => {
  const { s, calls, close } = await directSurface();
  try {
    await s.surface.start(); await s.connected();
    await s.slack.emit(inOther("fix the export", { user: TEAMMATE }));
    await waitFor(() => Promise.resolve(s.surface.status().dropped), dropped => dropped === 1);
    assert.equal(calls().length, 0);
    const event = inOther("fix the export");
    await s.slack.emit(event, { eventId: "EvDirect1" });
    await waitFor(async () => calls(), list => list.length === 1);
    assert.deepEqual(calls()[0], { thread: OTHER, ts: event.ts, eventId: "EvDirect1", text: "fix the export" });
    assert.equal(s.surface.status().dropped, 1, "The accepted mention is not counted as dropped");
  } finally { await close(); }
});

test("a redelivered triggering event makes no second call, no inbound entry and no reply", { timeout: 60000 }, async () => {
  const { s, calls, close } = await directSurface();
  try {
    await s.surface.start(); await s.connected();
    const envelope = await s.slack.emit(inOther("fix the export"));
    await waitFor(async () => calls(), list => list.length === 1);
    await s.slack.redeliver(envelope);
    // The same message under a new event ID is the same request.
    await s.slack.emit(inOther("fix the export", { ts: calls()[0].ts }), { eventId: "EvOther" });
    await delay(500);
    assert.equal(calls().length, 1);
    const records = s.store.boundTo(OTHER);
    assert.equal(records.length, 1);
    assert.equal(records[0].inbound.length, 0);
    assert.deepEqual(s.texts(OTHER), [], "Nothing is posted");
  } finally { await close(); }
});

test("a bare top-level mention is dropped, and a bare mention inside a thread files", { timeout: 60000 }, async () => {
  const { s, calls, close } = await directSurface();
  try {
    await s.surface.start(); await s.connected();
    await s.slack.emit(inOther("", { thread_ts: undefined }));
    await waitFor(() => Promise.resolve(s.surface.status().dropped), dropped => dropped === 1);
    assert.equal(calls().length, 0);
    await s.slack.emit(inOther(""));
    await waitFor(async () => calls(), list => list.length === 1);
    assert.equal(calls()[0].text, "");
  } finally { await close(); }
});

test("in a thread whose request has finished, a plain mention files a follow-up while Q, identifier and command prefixes keep the old routing", { timeout: 60000 }, async () => {
  const { s, calls, close } = await directSurface();
  try {
    s.store.create(intakeRecord(ISSUE, "finished", { thread: BINDING }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("Q1 which one"));
    await s.slack.emit(mention("TEST-1 also the CSV"));
    await s.slack.emit(mention("Status"));
    await waitFor(async () => s.texts(), list => list.length === 3);
    assert.equal(calls().length, 0);
    assert.deepEqual(s.texts().sort(), ["There is no question Q1.", FINISHED_DIRECT, FINISHED_DIRECT].sort());
    const event = mention("also cover the CSV export");
    await s.slack.emit(event);
    await waitFor(async () => calls(), list => list.length === 1);
    assert.deepEqual(calls()[0], { thread: BINDING, ts: event.ts, eventId: calls()[0].eventId, text: "also cover the CSV export" });
  } finally { await close(); }
});

test("a thread with an unfinished record keeps today's routing for a plain mention", { timeout: 60000 }, async () => {
  const { s, calls, close } = await directSurface();
  try {
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(mention("also cover the CSV export"));
    await waitFor(async () => s.store.get(ISSUE)!.inbound.length, count => count === 1);
    assert.equal(calls().length, 0);
  } finally { await close(); }
});

test("a direct record's acknowledgement carries the issue link, and an unfiled one is told as your request", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root, { directRequests: true, direct: () => () => "accepted" });
  try {
    const direct = { eventId: "EvA", ts: "1700000000.000100", text: "Export fails on empty rows" };
    s.store.create(intakeRecord(ISSUE, "queued", { identifier: "", url: "", thread: BINDING, direct, holdReason: "It could not be filed in Linear and will be retried: timeout" }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length === 1);
    assert.equal(s.texts()[0], 'Received your request "Export fails on empty rows". It has not started: It could not be filed in Linear and will be retried: timeout\nI\'ll post questions and the result here once it starts.');
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.update(ISSUE, record => { Object.assign(record, { identifier: "TEST-1", url: URL1, state: "started", missionId: id }); delete record.holdReason; });
    await waitFor(async () => s.texts(), list => list.length === 2);
    assert.equal(s.texts()[1], `Started on TEST-1 (${URL1}).`);
  } finally { await s.close(); await h.close(); }
});

test("a filed direct record is acknowledged with its issue link", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root, { directRequests: true, direct: () => () => "accepted" });
  try {
    const { id } = await services.missions.create(h.create(), undefined, origin(ISSUE));
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING, missionId: id, direct: { eventId: "EvA", ts: "1700000000.000100", text: "x", filedAt: NOW } }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length >= 1);
    await delay(300);
    assert.deepEqual(s.texts(), [`Started on TEST-1 "Export fails on empty rows" (${URL1}). I'll post questions and the result here.\nReply with a mention to answer or steer.`]);
  } finally { await s.close(); await h.close(); }
});

test("a direct request that cannot be recorded is logged, counted and not acknowledged, and its redelivery files once", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const logs = collector();
  let failing = true;
  const calls: Parameters<DirectRequest>[0][] = [];
  const s = await surfaceFor(services, h.root, { directRequests: true, log: logs.log, direct: store => input => {
    if (failing) throw new Error("store write failed");
    calls.push(input);
    store.create(intakeRecord(randomUUID(), "queued", { identifier: "", url: "", thread: input.thread, direct: { eventId: input.eventId, ts: input.ts, text: input.text } }));
    return "accepted";
  } });
  try {
    await s.surface.start(); await s.connected();
    const event = inOther("fix the export");
    const envelope = await s.slack.emit(event, { eventId: "EvLost" });
    await waitFor(() => Promise.resolve(s.surface.status().dropped), dropped => dropped === 1);
    assert.equal(logs.calls.length, 1);
    assert.deepEqual(s.texts(OTHER), []);
    assert.equal(s.slack.acks().includes(envelope), false, "The envelope is not acknowledged, so Slack redelivers it");
    failing = false;
    await s.slack.redeliver(envelope);
    await waitFor(async () => calls, list => list.length === 1);
    assert.equal(s.store.boundTo(OTHER).length, 1);
    assert.deepEqual(s.texts(OTHER), []);
  } finally { await s.close(); await h.close(); }
});

test("with direct requests off, mentions behave as before", { timeout: 60000 }, async () => {
  const { s, calls, close } = await directSurface({ directRequests: false });
  try {
    s.store.create(intakeRecord(ISSUE, "finished", { thread: BINDING }));
    await s.surface.start(); await s.connected();
    await s.slack.emit(inOther("fix the export"));
    await waitFor(() => Promise.resolve(s.surface.status().dropped), dropped => dropped === 1);
    await s.slack.emit(mention("also cover the CSV export"));
    await waitFor(async () => s.texts(), list => list.length === 1);
    assert.equal(s.texts()[0], FINISHED);
    assert.equal(calls().length, 0);
  } finally { await close(); }
});

test("a redelivered earlier reply never files a follow-up once its record has finished", { timeout: 60000 }, async () => {
  const { s, calls, close } = await directSurface();
  try {
    s.store.create(intakeRecord(ISSUE, "started", { thread: BINDING }));
    await s.surface.start(); await s.connected();
    const reply = mention("also cover the CSV export");
    const envelope = await s.slack.emit(reply, { eventId: "EvReply" });
    await waitFor(async () => s.store.get(ISSUE)!.inbound.length, count => count === 1);
    await waitFor(async () => s.store.get(ISSUE)!.inbound[0].handledAt, handled => Boolean(handled));
    await waitFor(async () => s.texts(), list => list.includes("This request has not started yet."));
    s.store.update(ISSUE, record => { record.state = "finished"; });
    const before = s.texts();
    await s.slack.redeliver(envelope);
    await s.slack.emit(reply, { eventId: "EvOtherId" });
    await delay(500);
    assert.equal(calls().length, 0, "No request is filed");
    assert.equal(s.store.list().length, 1);
    assert.equal(s.store.get(ISSUE)!.inbound.length, 1);
    assert.deepEqual(s.texts(), before, "Nothing is posted");
  } finally { await close(); }
});

// Answer records (INF-238)

const ANSWER_START = "Answering this from the repositories, read-only. No issue was filed.";
const ANSWER_FOOTER = 'No issue was filed. To start work, mention me with the change you want, or begin with "work:".';
const answerOrigin = (issueId: string): MissionOrigin => ({ kind: "intake", issueId, identifier: "", url: "", rule: "owner Slack mention of the bot (question)" });
const answerDirect = { eventId: "EvAsk", ts: "1700000000.000100", text: "which exports failed?", filedAt: NOW, route: { kind: "answer" as const, by: "owner" as const, at: NOW } };

/** A scripted surface with one running answer mission whose record is bound to the thread; direct requests are stubbed. */
async function answerSurface(state: IntakeRecord["state"] = "started") {
  const sh = scripted();
  const stateRoot = mkdtempSync(join(tmpdir(), "intake-answer-"));
  const calls: Parameters<DirectRequest>[0][] = [];
  const s = await surfaceFor({ missions: sh.missions as unknown as MissionService, teams: sh.teams as unknown as TeamService }, stateRoot,
    { directRequests: true, direct: () => input => { calls.push(input); return "accepted"; } });
  const mission = await sh.missions.create({ requestId: randomUUID(), groupId: "shop", objective: "Question asked from Slack: which exports failed?", mode: "answer", maxSubtasks: 1, maxMinutes: 30 }, undefined, answerOrigin(ISSUE));
  s.store.create(intakeRecord(ISSUE, state, { identifier: "", url: "", title: "which exports failed?", thread: BINDING, missionId: mission.id, direct: answerDirect }));
  return { sh, s, calls, id: mission.id, close: async () => { s.surface.close(); await s.slack.close(); sh.close(); rmSync(stateRoot, { recursive: true, force: true }); } };
}
const noIssueTraces = (texts: string[]) => {
  for (const text of texts) {
    assert.ok(!text.includes("()") && !/linear\.|https?:\/\/\S*issue/i.test(text) && !text.includes("TEST-") && !text.includes('""'), text);
  }
};

test("an answer's start message and footer are the exact texts, with no issue identifier or link", { timeout: 90000 }, async () => {
  const { sh, s, id, close } = await answerSurface();
  try {
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length >= 1);
    await delay(300);
    assert.deepEqual(s.texts(), [ANSWER_START]);
    await sh.report(1, { kind: "result", summary: "Rows 14 and 90 were empty." });
    await waitFor(async () => sh.missions.peek(id)?.status, status => status === "ready-for-review", 60000);
    await waitFor(async () => s.texts(), list => list.length === 2, 30000);
    assert.equal(s.texts()[1], `Answer (agent report):\nRows 14 and 90 were empty.\n\n${ANSWER_FOOTER}`);
    noIssueTraces(s.texts());
  } finally { await close(); }
});

test("status and cancel work on a running answer, and a held answer names the question", { timeout: 90000 }, async () => {
  const { sh, s, id, close } = await answerSurface();
  try {
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length === 1);
    await s.slack.emit(mention("status"));
    await waitFor(async () => s.texts(), list => list.length === 2);
    assert.match(s.texts()[1], /^(planning|working)$/);
    await s.slack.emit(mention("cancel"));
    await waitFor(async () => sh.missions.peek(id)?.status, status => status === "cancelled", 60000);
    await waitFor(async () => s.texts(), list => list.some(text => text.startsWith("Cancelled: ")), 30000);
    assert.ok(s.texts().includes(`Cancelled: ${CANCEL_REASON}\nMention me in this thread to file a follow-up.`));
    noIssueTraces(s.texts());
  } finally { await close(); }
});

test("a queued answer that could not start is acknowledged as your question, and a work route chosen by a reading says how to ask", { timeout: 60000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root, { directRequests: true, direct: () => () => "accepted" });
  try {
    s.store.create(intakeRecord(ISSUE, "queued", { identifier: "", url: "", title: "which exports failed?", thread: BINDING, direct: answerDirect, holdReason: "The project is busy." }));
    const other = randomUUID();
    const { id } = await services.missions.create(h.create(), undefined, origin(other));
    s.store.create(intakeRecord(other, "started", { thread: OTHER, missionId: id, direct: { eventId: "EvW", ts: "1700000000.000200", text: "x", filedAt: NOW, route: { kind: "work", by: "model", confidence: 0.7, at: NOW } } }));
    await s.surface.start();
    await waitFor(async () => s.texts(), list => list.length === 1);
    assert.equal(s.texts()[0], 'Received your question "which exports failed?". It has not started: The project is busy.\nI\'ll post questions and the result here once it starts.');
    await waitFor(async () => s.texts(OTHER), list => list.length === 1);
    assert.match(s.texts(OTHER)[0], /^Started on TEST-1 [\s\S]*\nI took this as a request for a change\. If you only wanted an answer, reply with a mention and "cancel", then mention me again starting with "ask:"\.$/);
  } finally { await s.close(); await h.close(); }
});

test("a mention in a thread whose answer has finished is routed again, and a colon or comma alone does not name the answer", { timeout: 90000 }, async () => {
  const { sh, s, calls, id, close } = await answerSurface();
  try {
    await s.surface.start(); await s.connected();
    await sh.report(1, { kind: "result", summary: "Rows 14 and 90 were empty." });
    await waitFor(async () => sh.missions.peek(id)?.status, status => status === "ready-for-review", 60000);
    s.store.update(ISSUE, record => { record.state = "finished"; });
    const event = mention("ask: and what about Tuesday?");
    await s.slack.emit(event, { eventId: "EvAgain" });
    await waitFor(async () => calls, list => list.length === 1);
    assert.deepEqual(calls[0], { thread: BINDING, ts: event.ts, eventId: "EvAgain", text: "ask: and what about Tuesday?" });
    assert.equal(s.store.get(ISSUE)!.inbound.length, 0, "The new question is a new record, not an inbound entry of the old one");
  } finally { await close(); }
});

test("with two open records one of them an answer, the ambiguity reply names the question instead of an empty identifier", { timeout: 90000 }, async () => {
  const { sh, s, close, id: answerId } = await answerSurface();
  try {
    const other = randomUUID();
    const { id } = await sh.missions.create({ requestId: randomUUID(), groupId: "shop", objective: "Change the API and the web client", maxSubtasks: 8, maxMinutes: 30 }, undefined, origin(other));
    const otherMissionId = id;
    s.store.create(intakeRecord(other, "started", { thread: BINDING, missionId: id }));
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length === 2);
    await s.slack.emit(mention("go on"));
    await waitFor(async () => s.texts(), list => list.length === 3);
    assert.match(s.texts()[2], /^More than one request is open in this thread: .*\. Start your reply with an identifier, "answer", or a question number\.$/);
    assert.ok(s.texts()[2].includes('answer (your question "which exports failed?")') && s.texts()[2].includes("TEST-1"));
    assert.ok(!s.texts()[2].includes(", ,") && !s.texts()[2].includes(": ,"), "No empty identifier is listed");
    await s.slack.emit(mention("answer status"));
    await waitFor(async () => s.texts(), list => list.length === 4);
    assert.match(s.texts()[3], /^(planning|working)$/);
    await s.slack.emit(mention("Answer: cancel"));
    await waitFor(async () => sh.missions.peek(answerId)?.status, status => status === "cancelled", 60000);
    assert.notEqual(sh.missions.peek(otherMissionId)?.status, "cancelled", "The other request's mission is untouched");
  } finally { await close(); }
});

test("a held answer announces its start once, and queued work keeps the ask hint through its start", { timeout: 90000 }, async () => {
  const h = harness(); const services = h.open(); const s = await surfaceFor(services, h.root, { directRequests: true, direct: () => () => "accepted" });
  try {
    s.store.create(intakeRecord(ISSUE, "queued", { identifier: "", url: "", title: "which exports failed?", thread: BINDING, direct: answerDirect, holdReason: "The project is busy." }));
    const work = randomUUID();
    s.store.create(intakeRecord(work, "queued", { thread: OTHER, holdReason: "max-active", direct: { eventId: "EvW", ts: "1700000000.000200", text: "x", filedAt: NOW, route: { kind: "work", by: "default", at: NOW } } }));
    await s.surface.start();
    await waitFor(async () => [s.texts().length, s.texts(OTHER).length], counts => counts[0] === 1 && counts[1] === 1);
    const { id } = await services.missions.create({ requestId: randomUUID(), groupId: "shop", objective: "Question asked from Slack: q", mode: "answer", maxSubtasks: 1, maxMinutes: 30 }, undefined, answerOrigin(ISSUE));
    s.store.update(ISSUE, record => { record.state = "started"; record.missionId = id; delete record.holdReason; });
    const other = await services.missions.create(h.create(), undefined, origin(work));
    s.store.update(work, record => { record.state = "started"; record.missionId = other.id; delete record.holdReason; });
    await waitFor(async () => [s.texts().length, s.texts(OTHER).length], counts => counts[0] === 2 && counts[1] === 2);
    // A further change to each record composes again and must add nothing.
    s.store.update(ISSUE, record => { record.updatedAt = new Date().toISOString(); });
    s.store.update(work, record => { record.updatedAt = new Date().toISOString(); });
    await delay(400);
    assert.deepEqual(s.texts().map(text => text === ANSWER_START), [false, true]);
    assert.equal(s.texts().filter(text => text === ANSWER_START).length, 1);
    const hint = 'If you only wanted an answer, reply with a mention and "cancel" once it starts, then mention me again starting with "ask:".';
    assert.equal(s.texts(OTHER).length, 2);
    assert.equal(s.texts(OTHER).filter(text => text.includes(hint)).length, 1, "The hint reaches the owner exactly once");
    assert.ok(s.texts(OTHER)[0].startsWith("Queued ") && s.texts(OTHER)[0].includes(hint));
  } finally { await s.close(); await h.close(); }
});

test("with a single unfinished record the word answer is ordinary text, not a selector", { timeout: 90000 }, async () => {
  const { s, close } = await answerSurface();
  try {
    await s.surface.start(); await s.connected();
    await waitFor(async () => s.texts(), list => list.length === 1);
    await s.slack.emit(mention("answer status"));
    await waitFor(async () => s.store.get(ISSUE)!.inbound[0]?.outcome, outcome => outcome !== undefined, 30000);
    assert.equal(s.store.get(ISSUE)!.inbound[0].outcome, "steered");
    assert.equal(s.texts().length, 1, "It was steering text, so it drew no status reply");
  } finally { await close(); }
});

// Extend replies. The mission is a stub stopped at its time limit: the real extend is a placeholder until it lands.

const DEADLINE_STOP = "Approved time ran out after 30 minutes.";
const STOPPED = `Stopped at its time limit: ${DEADLINE_STOP}\nReply with a mention and \`extend\` (or \`extend 6h\`) to give it more time, or \`cancel\`.`;
const EXTEND_HELP = "Extend by 5 minutes to 24 hours, for example `extend 6h` or `extend 90m`.";
const DEADLINE_MISSION = "m-deadline";

/**
 * A mission service whose one mission is stopped at its time limit. `extend` records each call and moves the stop to
 * 2026-11-15 12:00 UTC unless it refuses; `steer` records the text. Nothing else about the mission is modelled.
 */
function deadlineMissions(options: { maxMinutes?: number; refuse?: TeamError } = {}) {
  const extendCalls: { requestId: string; revision: number; minutes: number }[] = [];
  const steers: string[] = [];
  let mission = { id: DEADLINE_MISSION, revision: 3, status: "blocked", stopReason: "deadline", reason: DEADLINE_STOP,
    maxMinutes: options.maxMinutes ?? 30, deadlineAt: "2026-11-15T11:30:00.000Z", decisions: [], subtasks: [], steering: [], events: [] } as unknown as Mission;
  const missions = {
    peek: (id: string) => (id === DEADLINE_MISSION ? mission : undefined),
    onChange: () => () => undefined,
    extend: async (_id: string, input: { requestId: string; revision: number; minutes: number }) => {
      extendCalls.push({ requestId: input.requestId, revision: input.revision, minutes: input.minutes });
      if (options.refuse) throw options.refuse;
      mission = { ...mission, status: "working", stopReason: undefined, deadlineAt: "2026-11-15T12:00:00.000Z" } as unknown as Mission;
      return mission;
    },
    steer: async (_id: string, input: { text: string }) => { steers.push(input.text); return mission; },
  } as unknown as MissionService;
  return { missions, extendCalls, steers };
}

/** Resolves once the record has handled `count` owner replies, and returns their outcomes, oldest first. */
const handledOutcomes = (s: Awaited<ReturnType<typeof surfaceFor>>, count: number) =>
  waitFor(async () => s.store.get(ISSUE)!.inbound.filter(item => item.handledAt).map(item => item.outcome), outcomes => outcomes.length === count, 30000);

/**
 * A started (or finished) record on a mission stopped at its time limit, with the surface running. The acknowledgement
 * (started only) and the stop notice are posted first; `posts` returns only what came after them.
 */
async function deadlineSurface(options: { maxMinutes?: number; refuse?: TeamError; directRequests?: boolean; direct?: (store: IntakeStore) => DirectRequest; state?: IntakeRecord["state"] } = {}) {
  const deadline = deadlineMissions(options);
  const stateRoot = mkdtempSync(join(tmpdir(), "intake-deadline-"));
  const s = await surfaceFor({ missions: deadline.missions, teams: {} as unknown as TeamService }, stateRoot,
    { ...(options.directRequests !== undefined ? { directRequests: options.directRequests } : {}), ...(options.direct ? { direct: options.direct } : {}) });
  const state = options.state ?? "started";
  s.store.create(intakeRecord(ISSUE, state, { thread: BINDING, missionId: DEADLINE_MISSION }));
  await s.surface.start(); await s.connected();
  const setup = state === "started" ? 2 : 1;
  await waitFor(async () => s.texts(), list => list.length === setup, 30000);
  return { s, deadline, posts: () => s.texts().slice(setup), close: async () => { s.surface.close(); await s.slack.close(); rmSync(stateRoot, { recursive: true, force: true }); } };
}

test("extend commands parse to minutes: bare extend uses the mission's maxMinutes, and units and bare numbers are hours or minutes", { timeout: 120000 }, async () => {
  const { s, deadline, close } = await deadlineSurface();
  try {
    const cases: [string, number][] = [["extend", 30], ["EXTEND", 30], ["extend 6", 360], ["extend 6h", 360], ["extend 6 hours", 360],
      ["extend 1 hour", 60], ["extend 2hr", 120], ["extend 2 hrs", 120], ["extend 90m", 90], ["extend 90 min", 90],
      ["extend 90 minutes", 90], ["extend 45mins", 45], ["extend 30 minute", 30], ["extend 5m", 5], ["extend 24", 1440], ["extend 1440m", 1440]];
    for (const [index, [text, minutes]] of cases.entries()) {
      await s.slack.emit(mention(text));
      await handledOutcomes(s, index + 1);
      assert.equal(deadline.extendCalls.at(-1)?.minutes, minutes, text);
    }
    assert.equal(deadline.extendCalls.length, cases.length, "Every command made exactly one call");
    assert.equal(deadline.extendCalls[0].revision, 3, "The call carries the mission's revision");
  } finally { await close(); }
});

test("a bare extend is capped at 1440 minutes when the mission's maxMinutes is larger", { timeout: 60000 }, async () => {
  const { s, deadline, close } = await deadlineSurface({ maxMinutes: 2000 });
  try {
    await s.slack.emit(mention("extend"));
    await handledOutcomes(s, 1);
    assert.equal(deadline.extendCalls[0].minutes, 1440);
  } finally { await close(); }
});

test("out-of-range and malformed extend commands get the help reply and make no call", { timeout: 120000 }, async () => {
  const { s, deadline, posts, close } = await deadlineSurface();
  try {
    const bad = ["extend 4m", "extend 25", "extend 0", "extend 6x", "extend 1.5h", "extend 6 days", "extend 6h please", "extend 1440",
      "extend -1h", "extend .5h", "extend +2h"];
    for (const [index, text] of bad.entries()) {
      await s.slack.emit(mention(text));
      await handledOutcomes(s, index + 1);
    }
    await waitFor(async () => posts(), list => list.length === bad.length, 30000);
    assert.deepEqual([...new Set(posts())], [EXTEND_HELP]);
    assert.deepEqual(deadline.extendCalls, [], "No call was made");
    assert.deepEqual(s.store.get(ISSUE)!.inbound.map(item => item.outcome), bad.map(() => "invalid-extend"));
  } finally { await close(); }
});

test("a sentence that begins with extend is steering, not a command", { timeout: 60000 }, async () => {
  const { s, deadline, posts, close } = await deadlineSurface();
  try {
    await s.slack.emit(mention("extend the API to cover CSV exports"));
    await s.slack.emit(mention("extended the deadline for the CSV work"));
    await handledOutcomes(s, 2);
    assert.deepEqual(deadline.steers, ["extend the API to cover CSV exports", "extended the deadline for the CSV work"]);
    assert.deepEqual(deadline.extendCalls, [], "No extend call was made");
    assert.deepEqual(posts(), [], "Steering draws no reply");
  } finally { await close(); }
});

test("a successful extend replies with the amount added and the new stop time", { timeout: 120000 }, async () => {
  const { s, posts, close } = await deadlineSurface();
  try {
    await s.slack.emit(mention("extend 6h"));
    await waitFor(async () => posts(), list => list.length === 1, 30000);
    assert.equal(posts()[0], "Extended by 6 hours. The mission now stops at 2026-11-15 12:00 UTC.");
    await s.slack.emit(mention("extend 90m"));
    await waitFor(async () => posts(), list => list.length === 2, 30000);
    assert.equal(posts()[1], "Extended by 90 minutes. The mission now stops at 2026-11-15 12:00 UTC.");
    await s.slack.emit(mention("extend 1h"));
    await waitFor(async () => posts(), list => list.length === 3, 30000);
    assert.equal(posts()[2], "Extended by 1 hour. The mission now stops at 2026-11-15 12:00 UTC.");
  } finally { await close(); }
});

test("a refused extend replies with the mission's refusal and nothing else", { timeout: 60000 }, async () => {
  const refusal = new TeamError(409, "mission-not-extendable", "This mission cannot be extended.");
  const { s, posts, close } = await deadlineSurface({ refuse: refusal });
  try {
    await s.slack.emit(mention("extend 6h"));
    await waitFor(async () => posts(), list => list.length === 1, 30000);
    assert.equal(posts()[0], "This mission cannot be extended.");
    assert.equal(s.store.get(ISSUE)!.inbound[0].outcome, "refused");
  } finally { await close(); }
});

test("a mission stopped at its time limit posts the stop, the reason, and how to extend it", { timeout: 60000 }, async () => {
  const { s, close } = await deadlineSurface();
  try {
    assert.equal(s.texts().at(-1), STOPPED);
    assert.equal(s.store.get(ISSUE)!.state, "started", "The record stays started while the owner may extend");
  } finally { await close(); }
});

test("in a finished thread an extend command gets the finished line, and a sentence that begins with extend files a follow-up", { timeout: 60000 }, async () => {
  const filed: string[] = [];
  const direct: DirectRequest = input => { filed.push(input.text); return "accepted"; };
  const { s, deadline, posts, close } = await deadlineSurface({ directRequests: true, direct: () => direct, state: "finished" });
  try {
    await s.slack.emit(mention("extend 6h"));
    await waitFor(async () => posts(), list => list.length === 1, 30000);
    assert.equal(posts()[0], FINISHED_DIRECT);
    await s.slack.emit(mention("extend the API to cover CSV exports"));
    await waitFor(async () => filed, list => list.length === 1, 30000);
    assert.deepEqual(filed, ["extend the API to cover CSV exports"]);
    assert.deepEqual(deadline.extendCalls, []);
  } finally { await close(); }
});
