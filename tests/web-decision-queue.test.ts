import assert from "node:assert/strict";
import test from "node:test";
import type { Prompt } from "@infinite/attention";
import type { QueueDecision } from "../apps/web/src/api.ts";
import {
  applyDecisionQueueKey, createDecisionQueueState, formatWaitDuration, moveDecisionQueue,
  reconcileDecisionQueue, removeAnsweredDecision, selectableOptions, selectDecisionAnswers,
} from "../apps/web/src/decision-queue-model.ts";

function session(key: string, prompt: Prompt, terminalOnly = false): QueueDecision {
  return { kind: "session", key, since: "2026-11-21T12:00:00.000Z", origin: { id: key, title: `Session ${key}` }, answerPath: "/answer", prompt, ...(terminalOnly ? { terminalOnly: true } : {}) };
}

function team(key: string, overrides: Partial<Extract<QueueDecision, { kind: "team" }>["decision"]> = {}): QueueDecision {
  return { kind: "team", key, since: "2026-11-21T12:00:00.000Z", origin: { id: key, title: `Team ${key}`, team: { id: "team", title: "Build team", role: "reviewer" } }, answerPath: "/answer", revision: 1,
    decision: { id: key, question: `Choose ${key}`, options: ["North", "South", "East"], answerMode: "single", createdAt: "2026-11-21T12:00:00.000Z", ...overrides } };
}

const prompt = (options: Prompt["options"], overrides: Partial<Prompt> = {}): Prompt => ({
  id: 1, kind: "permission", title: "Run the command?", options, acceptsText: false, source: "hook", hash: "block", ...overrides,
});

test("refresh keeps the active key and received ordering", () => {
  let state = createDecisionQueueState([team("a"), team("b"), team("c")]);
  state = moveDecisionQueue(state, 1);
  state = selectDecisionAnswers(state, ["South"]);
  const refreshed = reconcileDecisionQueue(state, [team("c"), team("b"), team("a")]);
  assert.equal(refreshed.activeKey, "b");
  assert.deepEqual(refreshed.decisions.map(item => item.key), ["c", "b", "a"]);
  assert.deepEqual(refreshed.selectedAnswers, ["South"]);
});

test("navigation is bounded and a real move clears selection", () => {
  let state = createDecisionQueueState([team("a"), team("b"), team("c")]);
  state = selectDecisionAnswers(state, ["North"]);
  assert.equal(moveDecisionQueue(state, -1).activeKey, "a");
  assert.deepEqual(moveDecisionQueue(state, -1).selectedAnswers, ["North"]);
  state = moveDecisionQueue(state, 1);
  assert.equal(state.activeKey, "b");
  assert.deepEqual(state.selectedAnswers, []);
  state = selectDecisionAnswers(state, ["South"]);
  state = moveDecisionQueue(moveDecisionQueue(state, 1), 1);
  assert.equal(state.activeKey, "c");
  assert.deepEqual(state.selectedAnswers, []);
  assert.equal(moveDecisionQueue(state, 1).activeKey, "c");
});

test("own answer removes the active row and advances immediately", () => {
  let state = createDecisionQueueState([team("a"), team("b"), team("c")]);
  state = moveDecisionQueue(state, 1);
  state = selectDecisionAnswers(state, ["South"]);
  const next = removeAnsweredDecision(state, "b");
  assert.deepEqual(next.decisions.map(item => item.key), ["a", "c"]);
  assert.equal(next.activeKey, "c");
  assert.deepEqual(next.selectedAnswers, []);
  assert.equal(next.answeredElsewhere, false);
});

test("refresh reports another answer and chooses the row at the removed position", () => {
  let state = createDecisionQueueState([team("a"), team("b"), team("c")]);
  state = moveDecisionQueue(state, 1);
  state = selectDecisionAnswers(state, ["South"]);
  const next = reconcileDecisionQueue(state, [team("a"), team("c")]);
  assert.equal(next.activeKey, "c");
  assert.equal(next.answeredElsewhere, true);
  assert.deepEqual(next.selectedAnswers, []);
  const sameQueue = reconcileDecisionQueue(next, [team("a"), team("c")]);
  assert.equal(sameQueue.answeredElsewhere, true);
  assert.equal(moveDecisionQueue(sameQueue, -1).answeredElsewhere, false);
  const empty = reconcileDecisionQueue(sameQueue, []);
  assert.equal(empty.activeKey, undefined);
  assert.equal(empty.answeredElsewhere, true);
});

test("a changed decision revision clears a stale selection while keeping its key active", () => {
  const state = selectDecisionAnswers(createDecisionQueueState([team("a")]), ["North"]);
  const changed = { ...team("a"), revision: 2 } as Extract<QueueDecision, { kind: "team" }>;
  const next = reconcileDecisionQueue(state, [changed]);
  assert.equal(next.activeKey, "a");
  assert.deepEqual(next.selectedAnswers, []);
});

test("keyboard navigation aliases work and modifiers or editors leave state alone", () => {
  let state = createDecisionQueueState([team("a"), team("b")]);
  const context = { options: selectableOptions(state.decisions[0]), canAnswer: true };
  for (const key of ["j", "ArrowDown", "s"]) {
    const result = applyDecisionQueueKey(state, { key }, context);
    assert.equal(result.handled, true);
    assert.equal(result.state.activeKey, "b");
  }
  for (const key of ["k", "ArrowUp"]) {
    const result = applyDecisionQueueKey(state, { key }, context);
    assert.equal(result.state.activeKey, "a");
  }
  for (const input of [{ key: "j", altKey: true }, { key: "j", ctrlKey: true }, { key: "j", metaKey: true }, { key: "j", shiftKey: true }, { key: "j", targetTagName: "INPUT" },
    { key: "j", targetTagName: "TEXTAREA" }, { key: "j", targetTagName: "SELECT" }, { key: "j", targetIsContentEditable: true }]) {
    const result = applyDecisionQueueKey(state, input, context);
    assert.equal(result.handled, false);
    assert.equal(result.state.activeKey, "a");
  }
  const selected = selectDecisionAnswers(state, ["North"]);
  assert.equal(applyDecisionQueueKey(selected, { key: "Enter", targetTagName: "BUTTON" }, context).handled, false);
  assert.equal(applyDecisionQueueKey(selected, { key: "Enter", targetTagName: "A" }, context).handled, false);
});

test("number keys follow displayed positions and preserve PromptOption.index", () => {
  const row = session("s", prompt([
    { index: 8, label: "Reject", role: "reject" }, { index: 3, label: "Allow", role: "accept" },
  ]));
  const state = createDecisionQueueState([row]);
  const result = applyDecisionQueueKey(state, { key: "1" }, { options: selectableOptions(row), canAnswer: true });
  assert.deepEqual(result.state.selectedAnswers, ["8"]);
  assert.equal(selectableOptions(row)[1].sessionIndex, 3);
});

test("destructive keyboard selection blocks only accepting roles", () => {
  const row = session("s", prompt([
    { index: 0, label: "No", role: "reject" }, { index: 5, label: "Yes", role: "accept" }, { index: 9, label: "Always", role: "accept-always" },
  ], { destructive: { pattern: "rm -rf" } }));
  const state = createDecisionQueueState([row]);
  const context = { options: selectableOptions(row), canAnswer: true, destructive: true };
  assert.deepEqual(applyDecisionQueueKey(state, { key: "1" }, context).state.selectedAnswers, ["0"]);
  assert.deepEqual(applyDecisionQueueKey(state, { key: "2" }, context).state.selectedAnswers, []);
  assert.deepEqual(applyDecisionQueueKey(state, { key: "3" }, context).state.selectedAnswers, []);
});

test("terminal-only and read-only rows ignore option, recommendation, and Enter keys", () => {
  const row = team("held", { recommendation: { answers: ["South"], reason: "Best fit" } });
  const state = selectDecisionAnswers(createDecisionQueueState([row]), ["North"]);
  const terminal = { options: selectableOptions(row), recommendedAnswers: ["South"], canAnswer: true, terminalOnly: true };
  for (const key of ["1", "r", "Enter"]) assert.equal(applyDecisionQueueKey(state, { key }, terminal).handled, false);
  const readOnly = { ...terminal, terminalOnly: false, canAnswer: false };
  assert.deepEqual(applyDecisionQueueKey(state, { key: "r" }, readOnly).state.selectedAnswers, ["North"]);
});

test("recommendation options display first and Enter returns only an explicit selection", () => {
  const row = team("a", { recommendation: { answers: ["East"], reason: "Fits the evidence" } });
  const state = createDecisionQueueState([row]);
  const context = { options: selectableOptions(row), recommendedAnswers: ["East"], canAnswer: true };
  assert.deepEqual(context.options.map(option => option.value), ["East", "North", "South"]);
  assert.deepEqual(applyDecisionQueueKey(state, { key: "Enter" }, context).submit, undefined);
  const recommended = applyDecisionQueueKey(state, { key: "r" }, context).state;
  assert.deepEqual(recommended.selectedAnswers, ["East"]);
  const result = applyDecisionQueueKey(recommended, { key: "Enter" }, context);
  assert.deepEqual(result.submit, { key: "a", answers: ["East"] });
  assert.equal(applyDecisionQueueKey({ ...recommended, activeKey: undefined }, { key: "Enter" }, context).handled, false);
});

test("multiple-answer selection toggles and recommendation selects the full recommendation", () => {
  const row = team("multi", { answerMode: "multiple", recommendation: { answers: ["East", "North"], reason: "Both" } });
  const context = { options: selectableOptions(row), recommendedAnswers: ["East", "North"], canAnswer: true, multiple: true };
  let state = applyDecisionQueueKey(createDecisionQueueState([row]), { key: "1" }, context).state;
  assert.deepEqual(state.selectedAnswers, ["East"]);
  state = applyDecisionQueueKey(state, { key: "1" }, context).state;
  assert.deepEqual(state.selectedAnswers, []);
  state = applyDecisionQueueKey(state, { key: "r" }, context).state;
  assert.deepEqual(state.selectedAnswers, ["East", "North"]);
});

test("wait duration uses readable units", () => {
  const now = Date.parse("2026-11-21T12:02:01.000Z");
  assert.equal(formatWaitDuration("2026-11-21T12:01:59.000Z", now), "2 seconds");
  assert.equal(formatWaitDuration("2026-11-21T12:00:00.000Z", now), "2 minutes");
});
