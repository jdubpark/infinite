import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  answerGate, answerSend, apiPath, controlStep, createQueueState, decisionForPath, hideCompleted, formatAnswer, kindLabel, moveQueue, orderedChoices, queueEntryLabel, reconcileQueue,
  removeAnswered, settleAnsweredKeys, toggleChoice, visibleDecisions, QUEUE_SCREEN_POLL_MS, type QueueDecision,
} from "../apps/mobile/src/features/queue/model.ts";

const origin = { id: "o1", title: "Origin" };
const team = (id: string, since: string, extra: Partial<Extract<QueueDecision, { kind: "team" }>["decision"]> = {}): QueueDecision => ({
  kind: "team", key: `team:t:${id}`, since, origin, answerPath: `/api/teams/t/decisions/${id}/answer`, revision: 3,
  decision: { id, question: "Q", options: ["a", "b"], createdAt: since, ...extra },
});
const mission = (id: string): QueueDecision => ({ kind: "mission", key: `mission:m:${id}`, since: "2026-11-27T10:00:00.000Z", origin, answerPath: `/api/missions/m/answer/${id}`, revision: 1,
  decision: { id, question: "Q", options: [], createdAt: "2026-11-27T10:00:00.000Z" } });
const session = (terminalOnly?: true, team?: { id: string; title: string; role: string }): QueueDecision => ({
  kind: "session", key: "session:s:1", since: "2026-11-27T10:00:00.000Z", origin: { ...origin, ...(team ? { team } : {}) }, answerPath: "/api/sessions/s/answer",
  prompt: { id: 1, kind: "approval", title: "Run it?", options: [], highlighted: 0, acceptsText: false } as never, ...(terminalOnly ? { terminalOnly } : {}),
});
const stamp = "2026-11-27T10:00:00.000Z";

test("the screen polls no faster than the web queue page, and the hook uses that interval", () => {
  assert.ok(QUEUE_SCREEN_POLL_MS >= 1800);
  const hook = readFileSync(new URL("../apps/mobile/src/features/queue/useDecisionQueue.ts", import.meta.url), "utf8");
  assert.match(hook, /usePoll\(async \(\): Promise<Read> => \{[\s\S]*?\}, QUEUE_SCREEN_POLL_MS, \[connection\]\)/);
  const session = readFileSync(new URL("../apps/mobile/src/features/queue/QueueSessionAnswer.tsx", import.meta.url), "utf8");
  assert.match(session, /\}, QUEUE_SESSION_POLL_MS, \[connection, id\]\)/);
});

test("a team or mission answer sends the trimmed text to the host path with the decision's revision, and nothing for blank text", () => {
  const decision = team("1", stamp) as Extract<QueueDecision, { kind: "team" }>;
  assert.deepEqual(answerSend(decision, "  b \n"), { path: "/teams/t/decisions/1/answer", label: "Answer", revision: 3, fields: { text: "b" } });
  assert.equal(answerSend(decision, "   "), undefined);
  assert.equal(apiPath("/api/missions/m/answer/9"), "/missions/m/answer/9");
  assert.equal(apiPath("/missions/m"), "/missions/m");
  const decisions = [team("1", stamp), mission("2")];
  assert.equal(decisionForPath(decisions, "/missions/m/answer/2")?.key, "mission:m:2");
  assert.equal(decisionForPath(decisions, "/missions/m/answer/3"), undefined);
});

test("a decision whose answer completed while the screen was closed stays hidden when it is read again", () => {
  const done = (key: string) => key === "k2";
  assert.deepEqual([...hideCompleted(new Map(), 7, ["k1", "k2"], done)], [["k2", 7]]);
  assert.deepEqual([...hideCompleted(new Map([["k1", 9]]), 7, ["k1"], () => false)], [["k1", 9]]);
});

test("answering an input-control session needs an explicit take-control step and never takes over silently", () => {
  assert.deepEqual(controlStep({ requiresControl: false, hasLease: false }), { kind: "none" });
  assert.deepEqual(controlStep({ requiresControl: true, hasLease: false }), { kind: "take", takeover: false });
  assert.deepEqual(controlStep({ requiresControl: true, hasLease: false, holderLabel: "Laptop" }), { kind: "take", takeover: true });
  assert.deepEqual(controlStep({ requiresControl: true, hasLease: true }), { kind: "ready" });
});

test("the recommended answer comes first except in approval mode", () => {
  const recommendation = { answers: ["b"], reason: "safer" };
  assert.deepEqual(orderedChoices({ options: ["a", "b", "c"], recommendation }), ["b", "a", "c"]);
  assert.deepEqual(orderedChoices({ options: ["a", "b", "c"], answerMode: "approval", recommendation }), ["a", "b", "c"]);
  assert.deepEqual(orderedChoices({ options: [], recommendation: { answers: ["x", "x"], reason: "r" } }), ["x"]);
  assert.deepEqual(orderedChoices({ options: ["a"] }), ["a"]);
});

test("a multiple-answer decision numbers its answers and a single one sends the text as is", () => {
  assert.equal(formatAnswer(["a", "b"], "multiple"), "1. a\n2. b");
  assert.equal(formatAnswer(["a", "b"], "single"), "a");
  assert.equal(formatAnswer(["a"]), "a");
});

test("skip moves forward and previous moves back without wrapping", () => {
  const state = createQueueState([team("1", stamp), team("2", stamp), team("3", stamp)]);
  assert.equal(state.activeKey, "team:t:1");
  const skipped = moveQueue(state, 1);
  assert.equal(skipped.activeKey, "team:t:2");
  assert.equal(moveQueue(moveQueue(skipped, 1), 1).activeKey, "team:t:3");
  assert.equal(moveQueue(state, -1).activeKey, "team:t:1");
  assert.equal(moveQueue(createQueueState(), 1).activeKey, undefined);
});

test("moving or answering clears the selection, and a skipped decision keeps its place in the queue", () => {
  let state = createQueueState([team("1", stamp, { answerMode: "multiple" }), team("2", stamp)]);
  state = toggleChoice(toggleChoice(state, "a"), "b");
  assert.deepEqual(state.selected, ["a", "b"]);
  assert.deepEqual(toggleChoice(state, "a").selected, ["b"]);
  const moved = moveQueue(state, 1);
  assert.deepEqual(moved.selected, []);
  assert.deepEqual(moved.decisions.map(item => item.key), ["team:t:1", "team:t:2"]);
  const removed = removeAnswered(state, "team:t:1");
  assert.equal(removed.activeKey, "team:t:2");
  assert.deepEqual(removed.selected, []);
});

test("answering a decision that is not shown leaves the shown one and its selection alone", () => {
  let state = createQueueState([team("1", stamp), team("2", stamp)]);
  state = toggleChoice(state, "a");
  const next = removeAnswered(state, "team:t:2");
  assert.equal(next.activeKey, "team:t:1");
  assert.deepEqual(next.selected, ["a"]);
  assert.equal(removeAnswered(state, "missing"), state);
});

test("a decision answered elsewhere leaves the queue and says so", () => {
  const state = createQueueState([team("1", stamp), team("2", stamp), team("3", stamp)]);
  const next = reconcileQueue(moveQueue(state, 1), [team("1", stamp), team("3", stamp)]);
  assert.equal(next.activeKey, "team:t:3");
  assert.equal(next.activeLeft, true);
  assert.equal(reconcileQueue(next, [team("1", stamp), team("3", stamp)]).activeLeft, true);
  assert.equal(reconcileQueue(createQueueState([team("1", stamp)]), []).activeKey, undefined);
});

test("a changed decision under the same key drops the selection", () => {
  let state = toggleChoice(createQueueState([team("1", stamp, { answerMode: "multiple" })]), "a");
  assert.deepEqual(reconcileQueue(state, [team("1", stamp, { answerMode: "multiple" })]).selected, ["a"]);
  state = reconcileQueue(state, [team("1", stamp, { answerMode: "multiple", options: ["a", "z"] })]);
  assert.deepEqual(state.selected, []);
});

test("an answered key stays hidden until reads that began after the answer stop listing it", () => {
  const hidden = new Map([["k", 4]]);
  assert.equal(settleAnsweredKeys(hidden, 3, new Set(["k"])).has("k"), true);
  assert.equal(settleAnsweredKeys(hidden, 5, new Set(["k"])).has("k"), true);
  assert.equal(settleAnsweredKeys(hidden, 6, new Set()).has("k"), false);
  assert.equal(settleAnsweredKeys(hidden, 8, new Set(["k"])).has("k"), false);
  const queue = { decisions: [team("1", stamp), team("2", stamp)] };
  assert.deepEqual(visibleDecisions(queue, new Map([["team:t:1", 1]])).map(item => item.key), ["team:t:2"]);
});

test("the phone offers an answer only to the owner's choice and says why it cannot", () => {
  const online = { role: "owner" as const, promptAnswers: true, online: true };
  assert.deepEqual(answerGate({ ...online, decision: team("1", stamp) }), { kind: "answer" });
  assert.deepEqual(answerGate({ ...online, decision: session(true) }), { kind: "blocked", terminal: true, note: "Only this session's terminal can answer this prompt." });
  assert.equal(answerGate({ ...online, role: "viewer", decision: team("1", stamp) }).kind, "blocked");
  assert.equal(answerGate({ ...online, role: "controller", decision: mission("1") }).kind, "blocked");
  assert.equal(answerGate({ ...online, role: "controller", decision: team("1", stamp) }).kind, "answer");
  assert.equal(answerGate({ ...online, promptAnswers: false, decision: session() }).kind, "blocked");
  assert.equal(answerGate({ ...online, promptAnswers: false, decision: team("1", stamp) }).kind, "answer");
  assert.equal(answerGate({ ...online, online: false, decision: team("1", stamp) }).kind, "blocked");
});

test("the entry shows the count only when it is known", () => {
  assert.equal(queueEntryLabel(undefined), "Decisions");
  assert.equal(queueEntryLabel(0), "Decisions · none waiting");
  assert.equal(queueEntryLabel(3), "Decisions · 3 waiting");
  assert.equal(kindLabel(session()), "Session prompt");
  assert.equal(kindLabel(session(undefined, { id: "t", title: "T", role: "builder" })), "Member approval");
  assert.equal(kindLabel(mission("1")), "Mission decision");
});
