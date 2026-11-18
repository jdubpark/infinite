import test from "node:test";
import assert from "node:assert/strict";
import { expandedTotal, stepKey, type ReadRequest, type ReadStep } from "../packages/host/src/read-request.js";
import {
  applyReadEvent,
  emptyReadsState,
  joinCandidates,
  parseReadsState,
  type ReadsState,
  type ReadStepState,
  type ReadTransition,
} from "../packages/host/src/read-phases.js";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REQ_A = uid(1);
const REQ_B = uid(2);
const REQ_C = uid(3);
const PM = uid(100);
const LEAD = uid(101);
const member = (n: number) => uid(1000 + n);
const handle = (n: number) => uid(2000 + n);

type Event = Record<string, unknown>;

function step(id: string, extra: Partial<ReadStep> = {}): ReadStep {
  return { id, title: `Read ${id}`, instructions: `Read the ${id} code.`, agentProfileId: "reader-a", output: "findings", ...extra };
}
const list = (id: string) => step(id, { output: "list", instructions: `List the ${id} items.` });
const fan = (id: string, source: string, maxItems: number) => step(id, { forEach: { step: source, maxItems } });

function request(...phases: ReadStep[][]): ReadRequest {
  return { kind: "read", summary: "Gather evidence before planning.", phases: phases.map((steps, index) => ({ id: `phase-${index + 1}`, steps })) };
}

function admit(requestId: string, body: ReadRequest, options: { allowance?: number; revision?: number; role?: "project-manager" | "scout-lead" } = {}): Event {
  const role = options.role ?? "project-manager";
  return {
    type: "admit",
    requestId,
    revision: options.revision ?? 1,
    requester: { role, memberId: role === "project-manager" ? PM : LEAD },
    request: body,
    keys: Object.fromEntries(body.phases.flatMap(phase => phase.steps).map(item => [item.id, stepKey(item)])),
    phaseTotals: expandedTotal(body).phases,
    allowanceLeft: options.allowance ?? 40,
  };
}
const start = (requestId: string, stepId: string, n = 1): Event => ({ type: "start", requestId, stepId, memberId: member(n) });
const settle = (requestId: string, stepId: string, status: string, extra: Event = {}): Event => ({ type: "settle", requestId, stepId, status, ...extra });
const done = (requestId: string, stepId: string, n: number, extra: Event = {}) => settle(requestId, stepId, "complete", { output: handle(n), ...extra });

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

function ok(result: ReadTransition): ReadsState {
  if (!result.ok) assert.fail(`refused ${result.code}: ${result.message}`);
  return result.state;
}

/** Applies events to deep-frozen inputs and checks that neither the state nor the event changed. */
function run(state: ReadsState, ...events: unknown[]): ReadsState {
  for (const event of events) {
    deepFreeze(state);
    deepFreeze(event);
    const before = JSON.stringify([state, event]);
    const result = applyReadEvent(state, event);
    assert.equal(JSON.stringify([state, event]), before);
    state = ok(result);
  }
  return state;
}

function requestOf(state: ReadsState, requestId: string) {
  const found = state.requests.find(item => item.id === requestId);
  assert.ok(found, `request ${requestId}`);
  return found;
}
function stepOf(state: ReadsState, requestId: string, stepId: string): ReadStepState {
  const found = requestOf(state, requestId).phases.flatMap(phase => phase.steps).find(item => item.id === stepId);
  assert.ok(found, `step ${stepId}`);
  return found;
}
const phasesOf = (state: ReadsState, requestId: string) => requestOf(state, requestId).phases.map(phase => phase.status);
const statusesOf = (state: ReadsState, requestId: string) =>
  Object.fromEntries(requestOf(state, requestId).phases.flatMap(phase => phase.steps).map(item => [item.id, item.status]));
const childIds = (state: ReadsState, requestId: string, parent: string) =>
  requestOf(state, requestId).phases.flatMap(phase => phase.steps).filter(item => item.id.startsWith(`${parent}.`)).map(item => item.id);
const empty = () => emptyReadsState();

test("admission takes whole phases in order while their running sum fits the allowance", () => {
  const body = request([step("a"), step("b")], [step("c"), step("d"), step("e")], [step("f")]);
  const cases: [number, string[], string][] = [
    [6, ["started", "pending", "pending"], "running"],
    [5, ["started", "pending", "refused"], "running"],
    [3, ["started", "refused", "refused"], "running"],
    [2, ["started", "refused", "refused"], "running"],
    [1, ["refused", "refused", "refused"], "refused"],
    [0, ["refused", "refused", "refused"], "refused"],
  ];
  for (const [allowance, phases, status] of cases) {
    const state = run(empty(), admit(REQ_A, body, { allowance }));
    assert.deepEqual(phasesOf(state, REQ_A), phases, `allowance ${allowance}`);
    assert.equal(requestOf(state, REQ_A).status, status);
    for (const phase of requestOf(state, REQ_A).phases) {
      assert.equal(phase.reason, phase.status === "refused" ? "allowance" : undefined);
      if (phase.status === "refused") assert.deepEqual(phase.steps.map(item => item.status), phase.steps.map(() => "refused"));
    }
  }
  const all = run(empty(), admit(REQ_A, body, { allowance: 6 }));
  assert.deepEqual(statusesOf(all, REQ_A), { a: "queued", b: "queued", c: "pending", d: "pending", e: "pending", f: "pending" });
  // A forEach phase costs maxItems.
  const listed = request([list("items")], [fan("fan", "items", 8)]);
  assert.deepEqual(phasesOf(run(empty(), admit(REQ_A, listed, { allowance: 8 })), REQ_A), ["started", "refused"]);
  assert.deepEqual(phasesOf(run(empty(), admit(REQ_A, listed, { allowance: 9 })), REQ_A), ["started", "pending"]);
});

test("the request records its requester and depth", () => {
  const state = run(empty(), admit(REQ_A, request([step("a")]), { role: "scout-lead", revision: 3 }));
  const { id, revision, requester, depth, status } = requestOf(state, REQ_A);
  assert.deepEqual({ id, revision, requester, depth, status }, { id: REQ_A, revision: 3, requester: { role: "scout-lead", memberId: LEAD }, depth: 2, status: "running" });
  assert.equal(requestOf(run(empty(), admit(REQ_A, request([step("a")]))), REQ_A).depth, 1);
});

test("refused phases never start, and the request ends when its admitted phases settle", () => {
  let state = run(empty(), admit(REQ_A, request([step("a")], [step("b")]), { allowance: 1 }));
  const refused = applyReadEvent(state, start(REQ_A, "b"));
  assert.equal(refused.ok ? "ok" : refused.code, "not-startable");
  state = run(state, start(REQ_A, "a"), done(REQ_A, "a", 1));
  assert.deepEqual(phasesOf(state, REQ_A), ["settled", "refused"]);
  assert.equal(requestOf(state, REQ_A).status, "ended");
  assert.equal(stepOf(state, REQ_A, "b").status, "refused");
});

test("phase k+1 starts only when every step of phase k is complete, partial or failed", () => {
  let state = run(empty(), admit(REQ_A, request([step("a"), step("b"), step("c")], [step("d")])));
  state = run(state, start(REQ_A, "a", 1), start(REQ_A, "b", 2), start(REQ_A, "c", 3), done(REQ_A, "a", 1));
  assert.deepEqual(statusesOf(state, REQ_A), { a: "complete", b: "running", c: "running", d: "pending" });
  state = run(state, settle(REQ_A, "b", "partial", { output: handle(2) }));
  assert.deepEqual(phasesOf(state, REQ_A), ["started", "pending"]);
  state = run(state, settle(REQ_A, "c", "failed"));
  assert.deepEqual(phasesOf(state, REQ_A), ["settled", "started"]);
  assert.deepEqual(statusesOf(state, REQ_A), { a: "complete", b: "partial", c: "failed", d: "queued" });
  state = run(state, start(REQ_A, "d", 4), done(REQ_A, "d", 4));
  assert.equal(requestOf(state, REQ_A).status, "ended");
  assert.deepEqual(stepOf(state, REQ_A, "b"), { id: "b", key: stepKey(step("b")), status: "partial", memberIds: [member(2)], output: handle(2) });
  assert.deepEqual(stepOf(state, REQ_A, "c").memberIds, [member(3)]);
  assert.equal(stepOf(state, REQ_A, "c").output, undefined);
});

test("a late duplicate joins the earlier step and settles with its status and handle", () => {
  for (const [status, extra] of [["complete", { output: handle(7) }], ["partial", { output: handle(7) }], ["failed", {}]] as const) {
    let state = run(empty(), admit(REQ_A, request([step("scan")])), start(REQ_A, "scan"));
    state = run(state, admit(REQ_B, request([step("again", { title: "Other title", instructions: "Read  the scan code." })], [step("next")])));
    const again = stepOf(state, REQ_B, "again");
    assert.deepEqual({ status: again.status, join: again.join, memberIds: again.memberIds, output: again.output },
      { status: "joined", join: { requestId: REQ_A, stepId: "scan" }, memberIds: [], output: undefined });
    assert.equal(again.key, stepKey(step("scan")));
    assert.deepEqual(phasesOf(state, REQ_B), ["started", "pending"]);
    assert.equal(stepOf(state, REQ_B, "next").status, "pending");
    state = run(state, settle(REQ_A, "scan", status, extra));
    assert.equal(stepOf(state, REQ_B, "again").status, status);
    assert.equal(stepOf(state, REQ_B, "again").output, status === "failed" ? undefined : handle(7));
    assert.deepEqual(stepOf(state, REQ_B, "again").memberIds, []);
    assert.deepEqual(phasesOf(state, REQ_B), ["settled", "started"]);
    assert.equal(stepOf(state, REQ_B, "next").status, "queued");
  }
});

test("a joined step mirrors a settled target only once its own phase starts", () => {
  let state = run(empty(), admit(REQ_A, request([step("scan")])), start(REQ_A, "scan"));
  state = run(state, admit(REQ_B, request([step("first")], [step("again", { instructions: "Read the scan code." })])));
  state = run(state, done(REQ_A, "scan", 3));
  assert.deepEqual({ status: stepOf(state, REQ_B, "again").status, join: stepOf(state, REQ_B, "again").join }, { status: "pending", join: { requestId: REQ_A, stepId: "scan" } });
  state = run(state, start(REQ_B, "first", 2), done(REQ_B, "first", 4));
  assert.deepEqual(statusesOf(state, REQ_B), { first: "complete", again: "complete" });
  assert.equal(stepOf(state, REQ_B, "again").output, handle(3));
  assert.equal(requestOf(state, REQ_B).status, "ended");
  // A target that settled before admission settles the joined step at admission.
  state = run(state, admit(REQ_C, request([step("late", { instructions: "Read the scan code." })])));
  assert.deepEqual({ status: stepOf(state, REQ_C, "late").status, output: stepOf(state, REQ_C, "late").output }, { status: "complete", output: handle(3) });
  assert.equal(requestOf(state, REQ_C).status, "ended");
});

test("a step joins only a queued, running, complete or partial step of the same revision", () => {
  const dup = (id: string) => step(id, { instructions: "Read the scan code." });
  const running = run(empty(), admit(REQ_A, request([step("scan")])), start(REQ_A, "scan"));
  assert.equal(stepOf(run(running, admit(REQ_B, request([dup("x")]), { revision: 2 })), REQ_B, "x").join, undefined);
  const failed = run(running, settle(REQ_A, "scan", "failed"));
  assert.deepEqual(stepOf(run(failed, admit(REQ_B, request([dup("x")]))), REQ_B, "x").status, "queued");
  const pendingTarget = run(empty(), admit(REQ_A, request([step("first")], [step("scan")])));
  assert.equal(stepOf(run(pendingTarget, admit(REQ_B, request([dup("x")]))), REQ_B, "x").join, undefined);
  const queuedTarget = run(empty(), admit(REQ_A, request([step("scan")])));
  assert.deepEqual(stepOf(run(queuedTarget, admit(REQ_B, request([dup("x")]))), REQ_B, "x").join, { requestId: REQ_A, stepId: "scan" });
  // A third duplicate joins the original step, never a joined one.
  const chained = run(queuedTarget, admit(REQ_B, request([dup("x")])), admit(REQ_C, request([dup("y")])));
  assert.deepEqual(stepOf(chained, REQ_C, "y").join, { requestId: REQ_A, stepId: "scan" });
  // A refused phase joins nothing.
  assert.equal(stepOf(run(running, admit(REQ_B, request([step("first")], [dup("x")]), { allowance: 1 })), REQ_B, "x").join, undefined);
});

test("joinCandidates lists the steps the grant's activeSteps come from", () => {
  let state = run(empty(), admit(REQ_A, request([step("scan"), list("items")], [fan("fan", "items", 2), step("later")])), start(REQ_A, "scan"));
  assert.deepEqual(joinCandidates(state, 1), [
    { key: stepKey(step("scan")), requestId: REQ_A, stepId: "scan", status: "running" },
    { key: stepKey(list("items")), requestId: REQ_A, stepId: "items", status: "queued" },
  ]);
  assert.deepEqual(joinCandidates(state, 2), []);
  state = run(state, done(REQ_A, "scan", 1), start(REQ_A, "items", 2), settle(REQ_A, "items", "partial", { output: handle(2), items: 3 }));
  assert.deepEqual(joinCandidates(state, 1), [
    { key: stepKey(step("scan")), requestId: REQ_A, stepId: "scan", status: "complete", output: handle(1) },
    { key: stepKey(list("items")), requestId: REQ_A, stepId: "items", status: "partial", output: handle(2) },
    { key: stepKey(step("later")), requestId: REQ_A, stepId: "later", status: "queued" },
  ]);
});

test("a forEach over a joined list expands from the item count its target returned", () => {
  let state = run(empty(), admit(REQ_A, request([list("items")])), start(REQ_A, "items"));
  state = run(state, admit(REQ_B, request([step("mine", { output: "list", instructions: "List the items items." })], [fan("fan", "mine", 8)])));
  assert.deepEqual(stepOf(state, REQ_B, "mine").join, { requestId: REQ_A, stepId: "items" });
  assert.deepEqual(childIds(state, REQ_B, "fan"), []);
  assert.equal(stepOf(state, REQ_B, "fan").status, "pending");
  state = run(state, done(REQ_A, "items", 5, { items: 11 }));
  const mine = stepOf(state, REQ_B, "mine");
  assert.deepEqual({ status: mine.status, output: mine.output, items: mine.items }, { status: "complete", output: handle(5), items: 11 });
  assert.deepEqual(stepOf(state, REQ_B, "fan").forEach, { source: "mine", maxItems: 8, truncated: 3 });
  assert.deepEqual(childIds(state, REQ_B, "fan"), ["fan.0", "fan.1", "fan.2", "fan.3", "fan.4", "fan.5", "fan.6", "fan.7"]);
  // A failed target expands the forEach to nothing.
  let failed = run(empty(), admit(REQ_A, request([list("items")])), start(REQ_A, "items"));
  failed = run(failed, admit(REQ_B, request([step("mine", { output: "list", instructions: "List the items items." })], [fan("fan", "mine", 8)])), settle(REQ_A, "items", "failed"));
  assert.deepEqual(stepOf(failed, REQ_B, "fan").forEach, { source: "mine", maxItems: 8, truncated: 0 });
  assert.equal(requestOf(failed, REQ_B).status, "ended");
});

test("a forEach expands to one child per item up to maxItems and records the rest as truncated", () => {
  const cases: [number, number, number, number, string][] = [
    [0, 8, 0, 0, "ended"], [1, 8, 1, 0, "running"], [8, 8, 8, 0, "running"], [11, 8, 8, 3, "running"], [16, 8, 8, 8, "running"], [16, 16, 16, 0, "running"],
  ];
  for (const [items, maxItems, children, truncated, status] of cases) {
    let state = run(empty(), admit(REQ_A, request([list("items")], [fan("fan", "items", maxItems)])), start(REQ_A, "items"));
    assert.deepEqual(childIds(state, REQ_A, "fan"), []);
    state = run(state, done(REQ_A, "items", 1, { items }));
    const ids = childIds(state, REQ_A, "fan");
    assert.equal(ids.length, children, `${items} items`);
    assert.deepEqual(ids.slice(0, 2), ["fan.0", "fan.1"].slice(0, children));
    assert.equal(stepOf(state, REQ_A, "fan").forEach?.truncated, truncated);
    assert.equal(stepOf(state, REQ_A, "fan").status, "expanded");
    assert.equal(requestOf(state, REQ_A).status, status);
  }
});

test("a failed source expands to nothing and the phase goes on", () => {
  let state = run(empty(), admit(REQ_A, request([list("items")], [fan("fan", "items", 8), step("other")])), start(REQ_A, "items"));
  state = run(state, settle(REQ_A, "items", "failed"));
  assert.deepEqual(statusesOf(state, REQ_A), { items: "failed", fan: "expanded", other: "queued" });
  assert.deepEqual(stepOf(state, REQ_A, "fan").forEach, { source: "items", maxItems: 8, truncated: 0 });
  assert.deepEqual(phasesOf(state, REQ_A), ["settled", "started"]);
  state = run(state, start(REQ_A, "other"), done(REQ_A, "other", 1));
  assert.equal(requestOf(state, REQ_A).status, "ended");
});

test("acceptance 4: a list of 11 items under maxItems 8 yields 8 steps and records truncated 3", () => {
  const review = fan("review", "modules", 8);
  let state = run(empty(), admit(REQ_A, request([list("modules")], [review])), start(REQ_A, "modules"));
  state = run(state, done(REQ_A, "modules", 1, { items: 11 }));
  const phase = requestOf(state, REQ_A).phases[1];
  assert.deepEqual(phase.steps[0], { id: "review", key: stepKey(review), status: "expanded", memberIds: [], forEach: { source: "modules", maxItems: 8, truncated: 3 } });
  assert.deepEqual(phase.steps.slice(1), [0, 1, 2, 3, 4, 5, 6, 7].map(item => ({ id: `review.${item}`, key: stepKey(review), status: "queued", memberIds: [], item })));
  for (let item = 0; item < 8; item += 1) state = run(state, start(REQ_A, `review.${item}`, 10 + item), done(REQ_A, `review.${item}`, 10 + item));
  assert.deepEqual(phasesOf(state, REQ_A), ["settled", "settled"]);
  assert.equal(requestOf(state, REQ_A).status, "ended");
});

/** A state with every step status: complete, expanded, queued, running (4 members), pending, refused and joined. */
function fixture(): ReadsState {
  const body = request([step("a"), list("items")], [fan("fan", "items", 2), step("b"), list("more")], [step("c")], [step("d")]);
  // Phase totals 2, 4, 1 and 1: an allowance of 7 admits three phases.
  let state = run(empty(), admit(REQ_A, body, { allowance: 7 }));
  state = run(state, start(REQ_A, "a", 1), start(REQ_A, "items", 2), done(REQ_A, "items", 2, { items: 2 }), done(REQ_A, "a", 1));
  state = run(state, start(REQ_A, "b", 3), start(REQ_A, "b", 4), start(REQ_A, "b", 5), start(REQ_A, "b", 6), start(REQ_A, "more", 7));
  return run(state, admit(REQ_B, request([step("joiner", { instructions: "Read the b code." })])));
}

test("the fixture holds every step status", () => {
  const state = fixture();
  assert.deepEqual(statusesOf(state, REQ_A), {
    a: "complete", items: "complete", fan: "expanded", "fan.0": "queued", "fan.1": "queued", b: "running", more: "running", c: "pending", d: "refused",
  });
  assert.deepEqual(statusesOf(state, REQ_B), { joiner: "joined" });
  assert.deepEqual(stepOf(state, REQ_A, "b").memberIds, [member(3), member(4), member(5), member(6)]);
});

test("events that do not apply return a named refusal and leave the state as it was", () => {
  const state = deepFreeze(fixture());
  const before = JSON.stringify(state);
  const body = request([step("x")]);
  const admitted = admit(REQ_C, body);
  const parts = (target: string, source: string) => request([list("items"), step(target)], [fan("fan", source, 2)]);
  const cases: [string, unknown, string][] = [
    ["unknown request", start(uid(99), "a"), "unknown-request"],
    ["unknown step", start(REQ_A, "ghost"), "unknown-step"],
    ["unknown child", settle(REQ_A, "fan.5", "failed"), "unknown-step"],
    ["start a pending step", start(REQ_A, "c", 9), "not-startable"],
    ["start a refused step", start(REQ_A, "d", 9), "not-startable"],
    ["start a settled step", start(REQ_A, "a", 9), "not-startable"],
    ["start an expanded step", start(REQ_A, "fan", 9), "not-startable"],
    ["start a joined step", start(REQ_B, "joiner", 9), "not-startable"],
    ["a fifth member id", start(REQ_A, "b", 9), "member-limit"],
    ["settle a queued step", done(REQ_A, "fan.0", 9), "not-running"],
    ["settle a pending step", settle(REQ_A, "c", "failed"), "not-running"],
    ["settle a refused step", settle(REQ_A, "d", "failed"), "not-running"],
    ["settle a joined step", done(REQ_B, "joiner", 9), "not-running"],
    ["settle an expanded step", settle(REQ_A, "fan", "failed"), "not-running"],
    ["settle again with another status", settle(REQ_A, "a", "failed"), "conflicting-settle"],
    ["settle again with another handle", done(REQ_A, "a", 9), "conflicting-settle"],
    ["settle again with another item count", done(REQ_A, "items", 2, { items: 3 }), "conflicting-settle"],
    ["complete without a handle", settle(REQ_A, "b", "complete"), "invalid-result"],
    ["partial without a handle", settle(REQ_A, "b", "partial"), "invalid-result"],
    ["failed with a handle", settle(REQ_A, "b", "failed", { output: handle(9) }), "invalid-result"],
    ["findings with an item count", done(REQ_A, "b", 9, { items: 2 }), "invalid-result"],
    ["a list without an item count", done(REQ_A, "more", 9), "invalid-result"],
    ["a failed list with an item count", settle(REQ_A, "more", "failed", { items: 1 }), "invalid-result"],
    ["the same id with other steps", admit(REQ_A, body), "conflicting-admission"],
    ["the same id in another revision", { ...admit(REQ_B, request([step("joiner", { instructions: "Read the b code." })])), revision: 2 }, "conflicting-admission"],
    ["the same id from another requester", admit(REQ_B, request([step("joiner", { instructions: "Read the b code." })]), { role: "scout-lead" }), "conflicting-admission"],
    ["a missing key", { ...admitted, keys: {} }, "inconsistent-input"],
    ["a wrong key", { ...admitted, keys: { x: "0".repeat(64) } }, "inconsistent-input"],
    ["an extra key", { ...admitted, keys: { x: stepKey(step("x")), y: "0".repeat(64) } }, "inconsistent-input"],
    ["wrong phase totals", { ...admitted, phaseTotals: [2] }, "inconsistent-input"],
    ["a forEach over a missing step", admit(REQ_C, request([list("items")], [fan("fan", "ghost", 2)])), "inconsistent-input"],
    ["a forEach over a step that is not a list", admit(REQ_C, parts("other", "other")), "inconsistent-input"],
    ["a forEach over a list of the same phase", admit(REQ_C, request([list("items"), fan("fan", "items", 2)])), "inconsistent-input"],
    ["a forEach over a forEach", admit(REQ_C, request([list("items")], [{ ...fan("fan", "items", 2), output: "list" }], [fan("deep", "fan", 2)])), "nested-for-each"],
    ["a request that fails its schema", { ...admitted, request: { kind: "read", summary: "S", phases: [] } }, "invalid-event"],
    ["an allowance above 200", { ...admitted, allowanceLeft: 201 }, "invalid-event"],
    ["null", null, "invalid-event"],
    ["undefined", undefined, "invalid-event"],
    ["a number", 42, "invalid-event"],
    ["a string", "start", "invalid-event"],
    ["an array", [start(REQ_A, "fan.0", 9)], "invalid-event"],
    ["an empty object", {}, "invalid-event"],
    ["an unknown type", { ...start(REQ_A, "fan.0", 9), type: "cancel" }, "invalid-event"],
    ["an extra field", { ...start(REQ_A, "fan.0", 9), extra: true }, "invalid-event"],
    ["a __proto__ key", JSON.parse(`{"type":"start","requestId":"${REQ_A}","stepId":"fan.0","memberId":"${member(9)}","__proto__":{"x":1}}`), "invalid-event"],
    ["an oversized member id", { ...start(REQ_A, "fan.0"), memberId: "m".repeat(5000) }, "invalid-event"],
    ["an oversized step id", start(REQ_A, `a${"b".repeat(40)}`), "invalid-event"],
    ["a child index above 15", start(REQ_A, "fan.16"), "invalid-event"],
    ["a handle that is not an entry id", done(REQ_A, "b", 9, { output: "x".repeat(200) }), "invalid-event"],
    ["a negative item count", done(REQ_A, "more", 9, { items: -1 }), "invalid-event"],
    ["an item count above 32", done(REQ_A, "more", 9, { items: 33 }), "invalid-event"],
    ["an unknown status", settle(REQ_A, "b", "done", { output: handle(9) }), "invalid-event"],
  ];
  for (const [name, event, code] of cases) {
    const result = applyReadEvent(state, event);
    assert.equal(result.ok ? "ok" : result.code, code, name);
    assert.equal(JSON.stringify(state), before, name);
  }
});

test("a run holds at most 32 requests, and a replayed admission at the cap is unchanged", () => {
  let state = empty();
  for (let index = 0; index < 32; index += 1) state = run(state, admit(uid(500 + index), request([step(`s${index}`)]), { allowance: 1 }));
  const refused = applyReadEvent(state, admit(uid(600), request([step("late")])));
  assert.equal(refused.ok ? "ok" : refused.code, "request-limit");
  const replay = applyReadEvent(state, admit(uid(500), request([step("s0")]), { allowance: 0 }));
  assert.ok(replay.ok && !replay.changed && replay.state === state);
});

test("applying a valid event twice gives the state of applying it once, and replaying a journal changes nothing", () => {
  const journal: Event[] = [
    admit(REQ_A, request([list("items")], [fan("fan", "items", 4)]), { allowance: 5 }),
    start(REQ_A, "items", 1),
    done(REQ_A, "items", 1, { items: 6 }),
    start(REQ_A, "fan.0", 2),
    start(REQ_A, "fan.0", 3),
    settle(REQ_A, "fan.0", "partial", { output: handle(2) }),
    start(REQ_A, "fan.1", 4),
    admit(REQ_B, request([step("dup", { output: "list", instructions: "List the items items." })]), { allowance: 1 }),
    settle(REQ_A, "fan.1", "failed"),
  ];
  let state = empty();
  for (const event of journal) {
    const once = run(state, event);
    const twice = applyReadEvent(once, event);
    assert.ok(twice.ok && !twice.changed, JSON.stringify(event));
    assert.deepEqual(twice.state, once);
    state = once;
  }
  assert.deepEqual(stepOf(state, REQ_A, "fan.0").memberIds, [member(2), member(3)]);
  for (const event of journal) {
    const replay = applyReadEvent(state, event);
    assert.ok(replay.ok && !replay.changed && replay.state === state, JSON.stringify(event));
  }
});

test("transitions never mutate deep-frozen inputs", () => {
  const state = deepFreeze(fixture());
  const snapshot = JSON.stringify(state);
  const events = [done(REQ_A, "b", 3), start(REQ_A, "fan.0", 8), settle(REQ_A, "more", "failed"), admit(REQ_C, request([step("z")]))].map(deepFreeze);
  for (const event of events) {
    const result = applyReadEvent(state, event);
    assert.ok(result.ok && result.changed);
    assert.notEqual(result.state, state);
  }
  assert.equal(JSON.stringify(state), snapshot);
  assert.deepEqual(statusesOf(ok(applyReadEvent(state, events[0])), REQ_B), { joiner: "complete" });
});

function parseError(value: unknown): string {
  const parsed = parseReadsState(value);
  assert.equal(parsed.ok, false);
  return parsed.ok ? "" : parsed.error;
}

function edited(edit: (state: ReadsState) => void): unknown {
  const copy = structuredClone(fixture()) as ReadsState;
  edit(copy);
  return JSON.parse(JSON.stringify(copy));
}

test("the stored state round-trips through JSON and the parser", () => {
  const state = fixture();
  const parsed = parseReadsState(JSON.parse(JSON.stringify(state)));
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.state, state);
  assert.deepEqual(parseReadsState({ v: 1, requests: [] }), { ok: true, state: { v: 1, requests: [] } });
});

test("the stored-state parser enforces every bound", () => {
  const a = (state: ReadsState) => state.requests[0];
  const cases: [string, (state: ReadsState) => void, RegExp][] = [
    ["33 requests", state => { for (let index = 0; index < 31; index += 1) state.requests.push({ ...structuredClone(a(state)), id: uid(700 + index) }); }, /requests: too_big/],
    ["5 phases", state => { a(state).phases.push(structuredClone(a(state).phases[3])); }, /phases: too_big/],
    ["0 phases", state => { a(state).phases = []; }, /phases: too_small/],
    ["103 steps in a phase", state => { a(state).phases[2].steps = Array.from({ length: 103 }, () => structuredClone(a(state).phases[2].steps[0])); }, /steps: too_big/],
    ["0 steps in a phase", state => { a(state).phases[2].steps = []; }, /steps: too_small/],
    ["5 member ids", state => { a(state).phases[1].steps[3].memberIds.push(member(9)); }, /memberIds: too_big/],
    ["a 41-character step id", state => { a(state).phases[2].steps[0].id = `c${"x".repeat(40)}`; }, /\.id: invalid_format/],
    ["a child index of 16", state => { a(state).phases[1].steps[1].id = "fan.16"; }, /\.id: invalid_format/],
    ["a short key", state => { a(state).phases[0].steps[0].key = "a".repeat(63); }, /\.key: invalid_format/],
    ["an oversized handle", state => { a(state).phases[0].steps[0].output = "h".repeat(10_000); }, /\.output: invalid_format/],
    ["33 items", state => { a(state).phases[0].steps[1].items = 33; }, /\.items: too_big/],
    ["maxItems 17", state => { a(state).phases[1].steps[0].forEach!.maxItems = 17; }, /\.maxItems: too_big/],
    ["truncated 33", state => { a(state).phases[1].steps[0].forEach!.truncated = 33; }, /\.truncated: too_big/],
    ["an item index of 16", state => { a(state).phases[1].steps[1].item = 16; }, /\.item: too_big/],
    ["revision 0", state => { a(state).revision = 0; }, /revision: too_small/],
    ["a fractional revision", state => { a(state).revision = 1.5; }, /revision: invalid_type/],
    ["depth 3", state => { (a(state) as { depth: number }).depth = 3; }, /depth: invalid_union/],
  ];
  for (const [name, edit, expected] of cases) assert.match(parseError(edited(edit)), expected, name);
});

test("the stored-state parser refuses hostile values without echoing them", () => {
  const huge = "Z".repeat(100_000);
  const json = JSON.stringify(fixture());
  const swap = (from: string, to: string) => {
    assert.ok(json.includes(from), from);
    return JSON.parse(json.replace(from, to));
  };
  const cases: unknown[] = [
    null, undefined, 42, "state", [], {}, { v: 2, requests: [] }, { v: 1 }, { v: 1, requests: {} }, { v: 1, requests: [null] },
    { v: 1, requests: [], extra: 1 },
    { v: 1, requests: [], [huge]: 1 },
    JSON.parse('{"v":1,"requests":[],"__proto__":{"polluted":true}}'),
    swap('"status":"running"', '"status":"running","__proto__":{"x":1}'),
    swap('"id":"a",', '"id":"a","note":"x",'),
    swap('"memberIds":[]', '"memberIds":"none"'),
    swap('"status":"pending"', `"status":"${huge}"`),
    swap('"reason":"allowance"', '"reason":"budget"'),
    swap(`"requestId":"${REQ_A}"`, `"requestId":"${huge}"`),
  ];
  for (const [index, value] of cases.entries()) {
    const error = parseError(value);
    assert.ok(error.length < 300 && !error.includes("ZZZZ"), `case ${index}: ${error.slice(0, 120)}`);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("the stored-state parser refuses a state that breaks a cross-field rule", () => {
  const a = (state: ReadsState) => state.requests[0];
  const step = (state: ReadsState, phase: number, index: number) => a(state).phases[phase].steps[index];
  const cases: [string, (state: ReadsState) => void, string][] = [
    ["a repeated request id", state => { state.requests[1].id = REQ_A; }, "repeats a request id"],
    ["a depth that does not match", state => { a(state).depth = 2; }, "depth that does not match"],
    ["phases out of order", state => { a(state).phases[0].status = "pending"; }, "phases out of order"],
    ["a status that does not match", state => { a(state).status = "ended"; }, "status that does not match its phases"],
    ["a repeated step id", state => { step(state, 2, 0).id = "a"; }, "repeats a step id"],
    ["a refused phase without a reason", state => { delete a(state).phases[3].reason; }, "reason that does not match"],
    ["a settled step in a pending phase", state => { step(state, 2, 0).status = "complete"; }, "status its phase does not allow"],
    ["a started phase with every step settled", state => { a(state).phases[1].steps = [step(state, 1, 0)]; }, "started with every step settled"],
    ["a handle on a running step", state => { step(state, 1, 3).output = handle(1); }, "output handle"],
    ["an item count on a findings step", state => { step(state, 0, 0).items = 2; }, "item count"],
    ["member ids on a queued step", state => { step(state, 1, 1).memberIds = [member(1)]; }, "member ids"],
    ["a repeated member id", state => { step(state, 1, 3).memberIds = [member(3), member(3)]; }, "repeats a member id"],
    ["a joined status without a target", state => { delete state.requests[1].phases[0].steps[0].join; }, "joined without a target"],
    ["a join to a later request", state => { state.requests[1].phases[0].steps[0].join = { requestId: uid(98), stepId: "b" }; }, "joins a step that is not"],
    ["a joined step that runs itself", state => { state.requests[1].phases[0].steps[0].status = "queued"; }, "does not mirror"],
    ["an extra child", state => { a(state).phases[1].steps.splice(3, 0, { ...structuredClone(step(state, 1, 2)), id: "fan.2", item: 2 }); }, "do not match its source"],
    ["a wrong truncated count", state => { step(state, 1, 0).forEach!.truncated = 1; }, "do not match its source"],
    ["a child with another key than its parent", state => { step(state, 1, 1).key = "b".repeat(64); }, "without a matching expanded parent"],
    ["a child that is not a list when its parent is", state => { step(state, 1, 1).list = true; }, "without a matching expanded parent"],
    ["a child id without an item", state => { delete step(state, 1, 1).item; }, "do not match its source"],
    ["a child of another parent", state => { step(state, 1, 1).id = "ghost.0"; }, "do not match its source"],
    ["an expanded step without forEach", state => { delete step(state, 1, 0).forEach; }, "expanded without forEach"],
    ["a forEach step that runs", state => { step(state, 1, 0).status = "running"; step(state, 1, 0).memberIds = [member(1)]; }, "forEach step that ran itself"],
    ["a forEach over a findings step", state => { step(state, 1, 0).forEach!.source = "a"; }, "names a source that is not a list"],
  ];
  for (const [name, edit, expected] of cases) assert.ok(parseError(edited(edit)).includes(expected), name);
});

// ---- Seeded simulator ----

const SETTLED = new Set(["complete", "partial", "failed"]);
const FINAL = new Set(["complete", "partial", "failed", "expanded"]);
const BRIEFS = ["session", "slot", "launch", "event", "prompt", "ingest", "digest", "store", "fuse", "lead"].map(word => `Read the ${word} code.`);

type Sim = { random: () => number; counter: number; settled: Map<string, { status: string; items?: number }>; admitted: Event[] };
type Located = { requestId: string; step: ReadStepState };

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(sim: Sim, items: readonly T[]): T => items[Math.floor(sim.random() * items.length)];
const fresh = (sim: Sim) => uid(10_000 + (sim.counter += 1));

function randomRequest(sim: Sim): ReadRequest {
  const briefs = [...BRIEFS].sort(() => sim.random() - 0.5);
  const lists: string[] = [];
  const phases: ReadStep[][] = [];
  for (let phase = 0, count = 1 + Math.floor(sim.random() * 3); phase < count; phase += 1) {
    const steps: ReadStep[] = [];
    for (let index = 0, size = 1 + Math.floor(sim.random() * 3); index < size; index += 1) {
      const id = `s${phase}${index}`;
      const instructions = briefs[phase * 3 + index];
      if (lists.length > 0 && sim.random() < 0.5) {
        steps.push(step(id, { instructions, forEach: { step: pick(sim, lists), maxItems: 1 + Math.floor(sim.random() * 16) } }));
      } else {
        const output = sim.random() < 0.5 ? "list" : "findings";
        steps.push(step(id, { instructions, output, ...(sim.random() < 0.1 ? { lead: { maxAttempts: 1 + Math.floor(sim.random() * 2) } } : {}) }));
      }
    }
    phases.push(steps);
    lists.push(...steps.filter(item => item.output === "list" && !item.forEach).map(item => item.id));
  }
  return request(...phases);
}

function randomSettle(sim: Sim, target: Located): Event {
  const status = pick(sim, ["complete", "complete", "partial", "failed"]);
  if (status === "failed") return settle(target.requestId, target.step.id, status);
  return settle(target.requestId, target.step.id, status, { output: fresh(sim), ...(target.step.list ? { items: Math.floor(sim.random() * 33) } : {}) });
}

function nextEvent(sim: Sim, state: ReadsState): unknown {
  const steps: Located[] = state.requests.flatMap(item => item.phases.flatMap(phase => phase.steps.map(entry => ({ requestId: item.id, step: entry }))));
  const having = (status: string) => steps.filter(item => item.step.status === status);
  const roll = sim.random();
  if (roll < 0.12 || steps.length === 0) {
    const event = admit(fresh(sim), randomRequest(sim), {
      allowance: Math.floor(sim.random() * 41), revision: 1 + Math.floor(sim.random() * 2), role: sim.random() < 0.7 ? "project-manager" : "scout-lead",
    });
    sim.admitted.push(event);
    return event;
  }
  const queued = having("queued");
  const running = having("running");
  if (roll < 0.45) {
    const target = queued.length > 0 && sim.random() < 0.85 ? pick(sim, queued) : running.length > 0 ? pick(sim, running) : pick(sim, steps);
    return { type: "start", requestId: target.requestId, stepId: target.step.id, memberId: fresh(sim) };
  }
  if (roll < 0.8) return randomSettle(sim, running.length > 0 ? pick(sim, running) : pick(sim, steps));
  const any = pick(sim, steps);
  const settled = steps.filter(item => SETTLED.has(item.step.status));
  switch (Math.floor(sim.random() * 10)) {
    case 0: return { type: "start", requestId: any.requestId, stepId: any.step.id, memberId: fresh(sim) };
    case 1: return randomSettle(sim, any);
    case 2: return randomSettle(sim, settled.length > 0 ? pick(sim, settled) : any);
    case 3: return sim.random() < 0.5
      ? { type: "start", requestId: fresh(sim), stepId: any.step.id, memberId: fresh(sim) }
      : { type: "start", requestId: any.requestId, stepId: "ghost", memberId: fresh(sim) };
    case 4: return pick(sim, [null, {}, "start", 7, { type: "start" }, { type: "settle", requestId: any.requestId, stepId: any.step.id, status: "complete", extra: 1 }]);
    case 5: {
      const target = queued.length > 0 ? pick(sim, queued) : any;
      return { type: "start", requestId: target.requestId, stepId: target.step.id, memberId: "m".repeat(5000) };
    }
    case 6: return sim.admitted.length > 0 ? { ...pick(sim, sim.admitted), allowanceLeft: Math.floor(sim.random() * 41) } : null;
    case 7: return sim.admitted.length > 0 ? { ...pick(sim, sim.admitted), request: randomRequest(sim) } : null;
    case 8: return { ...admit(fresh(sim), randomRequest(sim)), phaseTotals: [99] };
    default: return settle(any.requestId, any.step.id, "complete");
  }
}

function located(state: ReadsState): Map<string, ReadStepState> {
  return new Map(state.requests.flatMap(item => item.phases.flatMap(phase => phase.steps.map(entry => [`${item.id}/${entry.id}`, entry] as const))));
}

function overlong(value: unknown, field = ""): boolean {
  if (typeof value === "string") return value.length > (field === "key" ? 64 : 43);
  if (Array.isArray(value)) return value.some(item => overlong(item, field));
  if (value && typeof value === "object") return Object.entries(value).some(([name, inner]) => overlong(inner, name));
  return false;
}

/** Every invariant, computed from the states and the simulator's own record of what it settled. */
function violations(previous: ReadsState, next: ReadsState, sim: Sim): string[] {
  const broken = new Set<string>();
  const before = located(previous);
  const after = located(next);
  for (const [where, earlier] of before) {
    const now = after.get(where);
    if (FINAL.has(earlier.status) && (now?.status !== earlier.status || now.output !== earlier.output || now.items !== earlier.items)) broken.add("settled-changed");
    if (earlier.status === "refused" && now?.status !== "refused") broken.add("refused-started");
  }
  for (const item of next.requests) {
    let unsettledEarlier = false;
    for (const phase of item.phases) {
      if (phase.status === "refused" && phase.steps.some(entry => entry.status !== "refused" || entry.memberIds.length > 0)) broken.add("refused-started");
      if (unsettledEarlier && phase.steps.some(entry => entry.status !== "pending" && entry.status !== "refused")) broken.add("phase-order");
      if (phase.steps.some(entry => !FINAL.has(entry.status) && entry.status !== "refused")) unsettledEarlier = true;
      for (const entry of phase.steps) {
        if (entry.forEach) {
          const forEach = entry.forEach;
          const source = after.get(`${item.id}/${forEach.source}`);
          const children = phase.steps.filter(candidate => candidate.id.startsWith(`${entry.id}.`));
          if ((entry.status === "expanded" || children.length > 0) && !SETTLED.has(source?.status ?? "")) broken.add("foreach-early");
          if (entry.status === "expanded") {
            const origin = source?.join ? `${source.join.requestId}/${source.join.stepId}` : `${item.id}/${forEach.source}`;
            const result = sim.settled.get(origin);
            const count = result && result.status !== "failed" ? result.items ?? 0 : 0;
            if (children.length > forEach.maxItems || children.length !== Math.min(count, forEach.maxItems)
              || forEach.truncated !== Math.max(0, count - forEach.maxItems)) broken.add("children-bound");
          }
        }
        if (entry.join) {
          const target = after.get(`${entry.join.requestId}/${entry.join.stepId}`);
          const mirrors = target !== undefined && entry.memberIds.length === 0 && (SETTLED.has(target.status)
            ? entry.status === "pending" || (entry.status === target.status && entry.output === target.output)
            : entry.status === "pending" || entry.status === "joined");
          if (!mirrors) broken.add("join-mirror");
        }
      }
    }
  }
  if (!parseReadsState(JSON.parse(JSON.stringify(next))).ok) broken.add("schema");
  if (overlong(next)) broken.add("string-bound");
  return [...broken].sort();
}

function simulate(seed: number): void {
  const sim: Sim = { random: mulberry32(seed), counter: 0, settled: new Map(), admitted: [] };
  let state = emptyReadsState();
  const journal: unknown[] = [];
  for (let index = 0; index < 60; index += 1) {
    const event = nextEvent(sim, state);
    const result = applyReadEvent(state, event);
    const again = applyReadEvent(result.ok ? result.state : state, event);
    const label = `event ${index} ${JSON.stringify(event)?.slice(0, 160)}`;
    if (!result.ok) {
      assert.equal(again.ok ? "ok" : again.code, result.code, `${label}: a refusal was not repeated`);
      continue;
    }
    assert.ok(again.ok && !again.changed, `${label}: a second application changed the state`);
    assert.deepEqual(again.state, result.state);
    const settled = event as Event;
    if (result.changed && settled.type === "settle") {
      sim.settled.set(`${settled.requestId}/${settled.stepId}`, { status: String(settled.status), items: settled.items as number | undefined });
    }
    const broken = violations(state, result.state, sim);
    assert.deepEqual(broken, [], `${label} broke: ${broken.join(", ")}`);
    if (result.changed) journal.push(event);
    state = result.state;
  }
  for (const event of journal) {
    const replay = applyReadEvent(state, event);
    assert.ok(replay.ok && !replay.changed, `replaying ${JSON.stringify(event).slice(0, 160)} changed the final state`);
  }
}

test("seeded simulator: random requests and event interleavings keep every invariant", () => {
  const only = process.env.READ_PHASES_SEED;
  const seeds = only ? [Number(only)] : Array.from({ length: 300 }, (_, index) => index + 1);
  for (const seed of seeds) {
    try {
      simulate(seed);
    } catch (error) {
      assert.fail(`seed ${seed} failed (replay with READ_PHASES_SEED=${seed}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
});
