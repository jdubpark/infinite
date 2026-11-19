import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";
import { scriptedMissionHarness as scripted } from "./mission-harness.js";
import { recommendationLine } from "../packages/host/src/question-recommendation.js";
import { createMissionReportEnvelope, createReportEnvelope } from "../packages/host/src/team-report-client.js";
import type { Mission } from "../packages/host/src/mission-types.js";

const until = (read: () => Mission, accepts: (mission: Mission) => boolean) => waitFor(async () => read(), accepts, 60000);

test("a retry envelope is read in its recorded form but cannot skip the recommendation the report tool requires", () => {
  const runId = randomUUID(), memberId = randomUUID(), requestId = randomUUID();
  const team = { INFINITE_HOOK_URL: "http://127.0.0.1:9/hook", INFINITE_HOOK_TOKEN: "capability", INFINITE_TEAM_ASSIGNMENT: JSON.stringify({ runId, memberId, revision: 1 }) };
  const mission = { ...team, INFINITE_MISSION_ASSIGNMENT: JSON.stringify({ missionId: runId, memberId, revision: 1 }) };
  const question = { kind: "question", question: "Which format?", options: ["JSON", "Text"] };
  const recommended = { ...question, recommendation: { answers: ["JSON"], reason: "Clients parse it." } };
  assert.throws(() => createReportEnvelope({ requestId, runId, memberId, revision: 1, report: question }, team), /recommendation/);
  assert.equal(createReportEnvelope({ requestId, runId, memberId, revision: 1, report: recommended }, team).requestId, requestId);
  assert.throws(() => createMissionReportEnvelope({ requestId, missionId: runId, memberId, revision: 1, report: question }, mission), /recommendation/);
  assert.equal(createMissionReportEnvelope({ requestId, missionId: runId, memberId, revision: 1, report: recommended }, mission).requestId, requestId);
});

test("a subteam's recommendation reaches the coordinator, whose forwarded question keeps its own, and the owner's answer records how it compared", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One API subtask", subtasks: [{ id: "api-work", repoProjectId: "api", title: "API work", objective: "Do the API work", size: "solo", parallelism: 1, dependsOn: [] }] });
    const dispatched = await until(() => h.get(id), mission => Boolean(mission.subtasks[0]?.teamId));
    const decisionId = randomUUID(), olderId = randomUUID(), options = ["JSON", "Text", "CSV"], question = "Which formats should the export offer?";
    const member = { answers: ["JSON", "CSV"], reason: "Both clients already parse them." }, at = new Date().toISOString();
    // The second decision comes from a member started before recommendations were required, and takes one option.
    h.set(dispatched.subtasks[0].teamId!, { status: "needs-input", decisions: [
      { id: decisionId, memberId: randomUUID(), revision: 1, question, options, answerMode: "multiple", recommendation: member, createdAt: at },
      { id: olderId, memberId: randomUUID(), revision: 1, question: "Which format is the default?", options, createdAt: at }] });

    const open = (await h.state(2)).openChildDecisions;
    assert.equal(open[0].recommendation, recommendationLine(member), "The coordinator reads the member's recommendation as the agent's");
    assert.equal(open[1].recommendation, undefined);
    const delivered = h.stored(id).attempts[1].consumedInbox.find(message => message.type === "child-decision");
    assert.deepEqual(delivered?.type === "child-decision" && delivered.recommendation, member, "The inbox message carries the answers and the reason");

    // A forwarded question that names no mode takes the subteam decision's: one option for a single choice, several for a multiple one.
    const own = { answers: ["JSON", "CSV"], reason: "Every mission client reads one of them." };
    await h.report(2, { kind: "question", question: "Which format is the default?", options, subtaskId: "api-work", childDecisionId: olderId, recommendation: own });
    assert.ok((await h.messages(3)).some((message: { type: string; reason?: string }) => message.type === "refused" && /Recommend exactly one option/.test(message.reason ?? "")));
    await h.report(3, { kind: "question", question, options, subtaskId: "api-work", childDecisionId: decisionId, recommendation: own });
    const waiting = await until(() => h.get(id), mission => mission.status === "needs-input");
    assert.equal(waiting.decisions[0].answerMode, "multiple");
    assert.deepEqual(waiting.decisions[0].recommendation, own, "The coordinator's question stores its own recommendation");
    const answered = await h.missions.answer(id, waiting.decisions[0].id, { requestId: randomUUID(), revision: waiting.revision, text: "1. CSV\n2. JSON" });
    assert.deepEqual(answered.decisions[0].recommendation, { ...own, outcome: "matched" });
    assert.equal(answered.decisions[0].answer, "1. CSV\n2. JSON", "The owner's words are the answer; the recommendation answers nothing");
  } finally { h.close(); }
});
