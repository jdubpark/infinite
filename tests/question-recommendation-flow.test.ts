import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { waitFor } from "./helpers.js";
import { scriptedMissionHarness as scripted } from "./mission-harness.js";
import { HookPayloadError, startHookServer } from "../packages/host/src/hooks.js";
import { recommendationLine } from "../packages/host/src/question-recommendation.js";
import { createMissionReportEnvelope, createReportEnvelope, ReportError, submitMissionReport, submitTeamReport } from "../packages/host/src/team-report-client.js";
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

test("a question still reaches a worker started before recommendations, without its recommendation", async () => {
  const seen: { requestId: string; report: Record<string, unknown> }[] = [];
  let responseHeaders: Record<string, string> = {};
  const worker = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      seen.push(JSON.parse(body));
      const status = "recommendation" in seen.at(-1)!.report ? 400 : 204;
      response.writeHead(status, responseHeaders).end();
    });
  });
  await new Promise<void>(resolve => worker.listen(0, "127.0.0.1", resolve));
  try {
    const runId = randomUUID(), memberId = randomUUID(), question = { kind: "question", question: "Which format?", options: ["JSON", "Text"] };
    const env = { INFINITE_HOOK_URL: `http://127.0.0.1:${(worker.address() as AddressInfo).port}/hook`, INFINITE_HOOK_TOKEN: "capability",
      INFINITE_TEAM_ASSIGNMENT: JSON.stringify({ runId, memberId, revision: 1 }), INFINITE_MISSION_ASSIGNMENT: JSON.stringify({ missionId: runId, memberId, revision: 1 }) };
    for (const headers of [{}, { "X-Infinite-Hook-Capabilities": "transcript, question-recommendation-v2" }] as Record<string, string>[]) {
      responseHeaders = headers;
      for (const submit of [submitTeamReport, submitMissionReport]) {
        seen.length = 0;
        const recorded = await submit({ ...question, recommendation: { answers: ["JSON"], reason: "Clients parse it." } }, env);
        assert.deepEqual(seen.map(envelope => "recommendation" in envelope.report), [true, false], "the question is sent once more without the field");
        assert.deepEqual(recorded.report, question);
        assert.equal(recorded.requestId, seen[1].requestId);
        assert.notEqual(seen[0].requestId, seen[1].requestId, "a different report has a different identity");
      }
    }
  } finally { worker.close(); }
});

test("real HTTP 400 validation errors on a question report are never masked or retried without recommendation", async () => {
  const runId = randomUUID(), memberId = randomUUID();
  const question = { kind: "question", question: "Which format?", options: ["JSON", "Text"], recommendation: { answers: ["JSON"], reason: "Clients parse it." } };
  const makeEnv = (url: string) => ({
    INFINITE_HOOK_URL: url,
    INFINITE_HOOK_TOKEN: "capability",
    INFINITE_TEAM_ASSIGNMENT: JSON.stringify({ runId, memberId, revision: 1 }),
    INFINITE_MISSION_ASSIGNMENT: JSON.stringify({ missionId: runId, memberId, revision: 1 }),
  });

  const hookSeen: { route: string; body: { requestId: string; report: Record<string, unknown> } }[] = [];
  let hookError = new HookPayloadError(400);
  const hookServer = await startHookServer({
    token: "capability",
    onPayload: (route, body) => {
      hookSeen.push({ route, body: body as { requestId: string; report: Record<string, unknown> } });
      throw hookError;
    },
    onError: () => {},
  });
  try {
    for (const [error, expectedPattern] of [
      [new HookPayloadError(400), /Report refused(?: or unconfirmed)? \(400\)/],
      [new HookPayloadError(400, "Invalid question: options conflict"), /^Invalid question: options conflict$/],
    ] as const) {
      hookError = error;
      for (const submit of [submitTeamReport, submitMissionReport]) {
        hookSeen.length = 0;
        await assert.rejects(
          () => submit(question, makeEnv(hookServer.url)),
          caught => caught instanceof ReportError && expectedPattern.test(caught.message),
        );
        assert.equal(hookSeen.length, 1, "current hook server 400 must not retry or strip recommendation");
        assert.equal("recommendation" in hookSeen[0].body.report, true);
      }
    }
  } finally { hookServer.close(); }

  const rawSeen: { requestId: string; report: Record<string, unknown> }[] = [];
  let replySpec: { headers?: Record<string, string>; body: string } = { body: "" };
  const rawServer = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      rawSeen.push(JSON.parse(body));
      response.writeHead(400, replySpec.headers).end(replySpec.body);
    });
  });
  await new Promise<void>(resolve => rawServer.listen(0, "127.0.0.1", resolve));
  try {
    const rawUrl = `http://127.0.0.1:${(rawServer.address() as AddressInfo).port}/hook`;
    const noRetryCases: { label: string; headers?: Record<string, string>; body: string; expected: RegExp }[] = [
      { label: "capability header with empty body", headers: { "X-Infinite-Hook-Capabilities": "transcript, QUESTION-RECOMMENDATION" }, body: "", expected: /Report refused(?: or unconfirmed)? \(400\)/ },
      { label: "plain-text validation body without capability header", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Invalid question: duplicate options", expected: /^Invalid question: duplicate options$/ },
      { label: "whitespace-only body without capability header", body: "   ", expected: /Report refused(?: or unconfirmed)? \(400\)/ },
    ];
    for (const testCase of noRetryCases) {
      replySpec = { headers: testCase.headers, body: testCase.body };
      for (const submit of [submitTeamReport, submitMissionReport]) {
        rawSeen.length = 0;
        await assert.rejects(
          () => submit(question, makeEnv(rawUrl)),
          caught => caught instanceof ReportError && testCase.expected.test(caught.message),
          testCase.label,
        );
        assert.equal(rawSeen.length, 1, `${testCase.label}: must send exactly one request`);
        assert.equal("recommendation" in rawSeen[0].report, true, `${testCase.label}: must preserve recommendation`);
      }
    }

    replySpec = { body: "" };
    for (const submit of [submitTeamReport, submitMissionReport]) {
      rawSeen.length = 0;
      await assert.rejects(
        () => submit(question, makeEnv(rawUrl)),
        caught => caught instanceof ReportError && /Report refused(?: or unconfirmed)? \(400\)/.test(caught.message),
      );
      assert.deepEqual(rawSeen.map(envelope => "recommendation" in envelope.report), [true, false], "legacy fallback retries at most once");
      assert.notEqual(rawSeen[0].requestId, rawSeen[1].requestId);

      rawSeen.length = 0;
      await assert.rejects(
        () => submit({ kind: "result", summary: "Finished." }, makeEnv(rawUrl)),
        caught => caught instanceof ReportError && /Report refused(?: or unconfirmed)? \(400\)/.test(caught.message),
      );
      assert.equal(rawSeen.length, 1, "non-question bare 400 never retries");
    }
  } finally { rawServer.close(); }
});

test("a subteam's recommendation reaches the coordinator, whose forwarded question keeps its own, and the owner's answer records how it compared", { timeout: 60000 }, async () => {
  const h = scripted();
  try {
    const { id } = await h.create();
    await h.report(1, { kind: "dispatch", summary: "One API subtask", subtasks: [{ id: "api-work", repoProjectId: "api", title: "API work", objective: "Do the API work", size: "solo", parallelism: 1, dependsOn: [] }] });
    const dispatched = await until(() => h.get(id), mission => Boolean(mission.subtasks[0]?.teamId));
    const decisionId = randomUUID(), olderId = randomUUID(), options = ["JSON", "Text", "CSV"], question = "Which formats should the export offer?";
    const member = { answers: ["JSON", "CSV"], reason: "Both clients already parse them." }, at = new Date().toISOString();
    h.set(dispatched.subtasks[0].teamId!, { status: "needs-input", decisions: [
      { id: decisionId, memberId: randomUUID(), revision: 1, question, options, answerMode: "multiple", recommendation: member, createdAt: at },
      { id: olderId, memberId: randomUUID(), revision: 1, question: "Which format is the default?", options, createdAt: at }] });

    const open = (await h.state(2)).openChildDecisions;
    assert.equal(open[0].recommendation, recommendationLine(member), "The coordinator reads the member's recommendation as the agent's");
    assert.equal(open[1].recommendation, undefined);
    const delivered = h.stored(id).attempts[1].consumedInbox.find(message => message.type === "child-decision");
    assert.deepEqual(delivered?.type === "child-decision" && delivered.recommendation, member, "The inbox message carries the answers and the reason");

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
