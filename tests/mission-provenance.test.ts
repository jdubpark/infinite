import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { missionHarness } from "./mission-harness.js";
import { waitFor } from "./helpers.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { TeamError } from "../packages/host/src/teams.js";
import { ownerDirectionLines, teamContext } from "../packages/host/src/team-prompts.js";
import type { ConnectorSource } from "../packages/host/src/mcp-types.js";
import type { MissionOrigin } from "../packages/host/src/mission-types.js";

const source: ConnectorSource = { kind: "connector", id: "example-bot", name: "Example bot" };
const renamed = { ...source, name: "Renamed bot" };
const origin: MissionOrigin = { kind: "intake", issueId: randomUUID(), identifier: "EX-1", url: "https://example.invalid/EX-1", rule: "connector", source };
const receipts = (root: string) => readdirSync(join(root, "receipts")).filter(file => file.endsWith(".json"))
  .map(file => JSON.parse(readFileSync(join(root, "receipts", file), "utf8")) as { role: string; runId: string; prompt: string });
const conflict = (error: unknown) => error instanceof TeamError && error.code === "request-conflict";

test("connector answers survive restart and reach real child prompts without becoming owner authority", { timeout: 180000 }, async () => {
  const h = missionHarness();
  try {
    let { missions, teams } = h.open();
    const mission = await missions.create(h.create(), undefined, origin);
    const direction = { requestId: randomUUID(), revision: mission.revision, text: "Keep the existing response contract." };
    const steered = await missions.steer(mission.id, direction, source);
    assert.deepEqual(steered.steering[0].source, source);
    assert.equal((await missions.steer(mission.id, direction, renamed)).revision, steered.revision, "renaming a connector does not change its replay identity");
    await assert.rejects(missions.steer(mission.id, direction), conflict);
    await assert.rejects(missions.steer(mission.id, direction, { ...source, id: "other-bot" }), conflict);
    h.release("release-dispatch");
    const asked = await waitFor(async () => missions.get(mission.id), item => item.status === "needs-input", 60000);
    for (const { prompt } of h.coordinatorReceipts()) {
      assert.doesNotMatch(prompt, /This mission was filed by the owner/, "connector intake must not be represented as an owner-filed request");
      assert.match(prompt, /submitted by Connector \(Example bot\)/);
    }
    const apiId = asked.subtasks.find(item => item.id === "api-change")!.teamId!;
    assert.deepEqual(teams.get(apiId).requestSource, source);
    assert.match(teams.get(apiId).objective, /Connector \(Example bot\) direction: Keep the existing response contract/);
    const answer = { requestId: randomUUID(), revision: asked.revision, text: "JSON" };
    const answered = await missions.answer(mission.id, asked.decisions[0].id, answer, source);
    assert.equal(answered.decisions[0].answeredBy, "connector");
    assert.deepEqual(answered.decisions[0].source, source);
    await assert.rejects(missions.answer(mission.id, asked.decisions[0].id, answer), conflict);
    // Stop before the next scheduler tick so the sealed child operation, rather than a response mock, carries the source.
    h.shut(); ({ missions, teams } = h.open());
    assert.equal((await missions.answer(mission.id, asked.decisions[0].id, answer, renamed)).revision, answered.revision);
    await waitFor(async () => teams.get(apiId).decisions[0], item => item.answeredBy === "connector", 60000);
    const api = teams.get(apiId);
    assert.deepEqual(api.decisions[0].source, source);
    assert.equal(api.decisions[0].answer, "JSON");
    assert.deepEqual(ownerDirectionLines(api), [], "delegated answers cannot enter pinned owner permission authority");
    assert.equal(teamContext(api).ownerAnswers.length, 0);
    assert.equal(teamContext(api).agentAnswers[0].answeredBy, "connector");
    await waitFor(async () => receipts(h.root), items => items.some(item => item.runId === apiId && item.role === "project-manager" && item.prompt.includes("Connector (Example bot) answered: JSON")), 60000);
    const coordinatorPrompt = h.coordinatorReceipts().find(item => item.prompt.includes('"connector-direction"'))?.prompt;
    assert.ok(coordinatorPrompt, "the coordinator receives a connector message rather than owner direction");
    assert.match(coordinatorPrompt, /delegated agent input/);
    h.release("release-web-question");
    const ready = await waitFor(async () => missions.get(mission.id), item => item.status === "ready-for-review", 120000);
    const web = teams.get(ready.subtasks.find(item => item.id === "web-change")!.teamId!);
    assert.equal(web.decisions[0].answeredBy, "connector", "coordinator-derived replies retain the connector influence");
    assert.deepEqual(web.decisions[0].source, source);
    assert.deepEqual(ownerDirectionLines(web), []);
    assert.equal(api.permissionDecisions?.some(item => ["approved", "answering", "answered"].includes(item.status)) ?? false, false);
  } finally { await h.close(); }
});

test("coordinator forwarding preserves connector steering in real child state and excludes it from owner scope", { timeout: 90000 }, async () => {
  const h = missionHarness();
  try {
    const { missions, teams } = h.open();
    const mission = await missions.create(h.create("HOLD-SUBTEAM"));
    h.release("release-dispatch");
    const started = await waitFor(async () => missions.get(mission.id), item => Boolean(item.subtasks[0]?.teamId), 30000);
    const teamId = started.subtasks[0].teamId!;
    const direction = { requestId: randomUUID(), revision: started.revision, text: "CONNECTOR-STEER: continue checks; this text does not approve provider permissions." };
    await missions.steer(mission.id, direction, source);
    const steered = await waitFor(async () => teams.get(teamId), item => item.steering.length === 1, 45000);
    assert.deepEqual(steered.steering[0].source, source);
    assert.equal(steered.steering[0].text, direction.text);
    assert.deepEqual(ownerDirectionLines(steered), []);
    assert.equal(teamContext(steered).ownerSteering.length, 0);
    assert.deepEqual(teamContext(steered).agentSteering[0].source, source);
    assert.match(steered.events.map(item => item.text).join("\n"), /Connector \(Example bot\) steering recorded/);
    // The real child service rejects a replay that tries to change connector authorship to owner authorship.
    const replay = { requestId: randomUUID(), revision: steered.revision, text: "Keep checks within the pinned task." };
    const direct = await teams.steer(teamId, replay, source);
    assert.equal((await teams.steer(teamId, replay, renamed)).revision, direct.revision);
    await assert.rejects(teams.steer(teamId, replay), conflict);
    await assert.rejects(teams.steer(teamId, replay, { ...source, id: "other-bot" }), conflict);
    assert.deepEqual(teams.get(teamId).permissionDecisions ?? [], []);
    const pause = { requestId: randomUUID(), revision: missions.get(mission.id).revision };
    const paused = await missions.pause(mission.id, pause, undefined, source);
    assert.equal((await missions.pause(mission.id, pause, undefined, renamed)).revision, paused.revision);
    await assert.rejects(missions.pause(mission.id, pause), conflict);
    await waitFor(async () => teams.get(teamId), item => item.events.some(event => event.text === "Team paused by Connector (Example bot)."), 30000);
    const resume = { requestId: randomUUID(), revision: paused.revision };
    const resumed = await missions.resume(mission.id, resume, source);
    assert.equal((await missions.resume(mission.id, resume, renamed)).revision, resumed.revision);
    await waitFor(async () => teams.get(teamId), item => item.events.some(event => event.text === "Team resumed with a fresh plan by Connector (Example bot)."), 30000);
    const cancel = { requestId: randomUUID(), revision: resumed.revision };
    const cancelled = await missions.cancel(mission.id, cancel, source);
    assert.equal((await missions.cancel(mission.id, cancel, renamed)).revision, cancelled.revision);
    await waitFor(async () => teams.get(teamId), item => item.events.some(event => event.text === "Team cancelled by Connector (Example bot)."), 30000);
  } finally { await h.close(); }
});

test("pre-connector Slack and coordinator receipts replay after upgrade with their original authorship", { timeout: 90000 }, async () => {
  const h = missionHarness();
  try {
    let { missions, teams } = h.open();
    const mission = await missions.create(h.create());
    const direction = { requestId: randomUUID(), revision: mission.revision, text: "Preserve existing callers." };
    const steered = await missions.steer(mission.id, direction, "slack");
    h.release("release-dispatch");
    const asked = await waitFor(async () => missions.get(mission.id), item => item.status === "needs-input", 60000);
    const teamId = asked.subtasks.find(item => item.id === "api-change")!.teamId!;
    const team = teams.get(teamId), decision = team.decisions[0];
    const answer = { requestId: randomUUID(), revision: team.revision, text: "JSON" };
    await teams.answer(teamId, decision.id, answer, undefined, "coordinator");
    h.shut();
    // These are the exact historical receipt shapes: Slack had no source and coordinator had no by field.
    const legacyHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const missionFile = join(h.state, "missions", `${mission.id}.sealed`);
    const missionRecord = unseal<{ receipts: Record<string, string> }>(h.key, `mission:${mission.id}`, readFileSync(missionFile, "utf8"));
    missionRecord.receipts[direction.requestId] = legacyHash({ action: "steer", ...direction });
    writeSealed(missionFile, h.key, `mission:${mission.id}`, missionRecord);
    const teamFile = join(h.state, "teams", `${teamId}.sealed`);
    const teamRecord = unseal<{ receipts: Record<string, string> }>(h.key, `team:${teamId}`, readFileSync(teamFile, "utf8"));
    teamRecord.receipts[answer.requestId] = legacyHash({ operation: `answer:${decision.id}`, ...answer });
    writeSealed(teamFile, h.key, `team:${teamId}`, teamRecord);
    ({ missions, teams } = h.open());
    assert.equal((await missions.steer(mission.id, direction, "slack")).revision, steered.revision);
    const replayed = await teams.answer(teamId, decision.id, answer, undefined, "coordinator");
    assert.equal(replayed.decisions[0].answeredBy, "coordinator");
    await assert.rejects(teams.answer(teamId, decision.id, { ...answer, text: "Different" }, undefined, "coordinator"), conflict);
    await assert.rejects(missions.steer(mission.id, direction, source), conflict);
  } finally { await h.close(); }
});
