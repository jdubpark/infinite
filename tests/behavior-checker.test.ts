import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BehaviorDefinition, BehaviorModel } from "@infinite/remote";
import { behaviorDefinitionHash, checkBehaviorModel, validateBehaviorDefinition } from "../packages/host/src/behavior-checker.js";
import { exportBehaviorSuite } from "../packages/host/src/behavior-suite.js";

const evidence = [{ repositoryId: "repo", source: "src/flow.ts", line: 1 }];
const operand = (variable: string) => ({ variable });
const literal = (value: string | number | boolean) => ({ value });
const eq = (left: ReturnType<typeof operand> | ReturnType<typeof literal>, right: ReturnType<typeof operand> | ReturnType<typeof literal>) => ({ op: "eq" as const, left, right });
const neq = (left: ReturnType<typeof operand> | ReturnType<typeof literal>, right: ReturnType<typeof operand> | ReturnType<typeof literal>) => ({ op: "neq" as const, left, right });
const all = (...args: BehaviorModel["properties"][number]["predicate"][]) => ({ op: "and" as const, args });

function modelWith(
  states: BehaviorModel["states"],
  variables: BehaviorModel["variables"],
  transitions: BehaviorModel["transitions"],
  properties: BehaviorModel["properties"],
  initial = states[0]!.id,
): BehaviorModel {
  return { initial, states, variables, transitions, properties };
}

function prop(id: string, predicate: BehaviorModel["properties"][number]["predicate"], states: string[] = [], kind: "safety" | "liveness" = "safety") {
  return { id, title: id, kind, states, predicate, requirement: "The declared finite-state safety condition holds.", basis: "proposed" as const, evidence };
}

function definition(current: BehaviorModel, planned: BehaviorModel | null = null): BehaviorDefinition {
  return {
    schemaVersion: 1,
    id: "checker-fixture",
    title: "Finite checker fixture",
    componentId: "component-fixture",
    repositoryId: "repo",
    sourceSnapshotId: "snapshot-fixture",
    planRevisions: [],
    requirementRevision: "fixture-v1",
    assumptions: [],
    exclusions: [],
    current,
    planned,
  };
}

function modelForBoundChecks(): BehaviorModel {
  return modelWith(
    [{ id: "a", label: "Initial" }, { id: "b", label: "Middle" }, { id: "c", label: "End" }],
    [{ id: "n", domain: [0, 1, 2], initial: 0 }],
    [
      { id: "a-b", from: "a", to: "b", label: "advance", actor: "worker", event: "step", guard: { op: "true" }, effects: { n: { value: 1 } }, evidence },
      { id: "b-c", from: "b", to: "c", label: "finish", actor: "worker", event: "step", guard: { op: "true" }, effects: { n: { value: 2 } }, evidence },
    ],
    [prop("always-valid", { op: "true" })],
  );
}

test("BFS explores enabled interleavings and retains a shortest safety counterexample", async () => {
  const model = modelWith(
    [{ id: "ready", label: "Ready" }, { id: "unsafe", label: "Unsafe" }],
    [{ id: "x", domain: [0, 1], initial: 0 }, { id: "y", domain: [0, 1], initial: 0 }],
    [
      { id: "set-x", from: "ready", to: "ready", label: "set x", actor: "worker", event: "update", guard: eq(operand("x"), literal(0)), effects: { x: { value: 1 } }, evidence },
      { id: "set-y", from: "ready", to: "ready", label: "set y", actor: "worker", event: "update", guard: eq(operand("y"), literal(0)), effects: { y: { value: 1 } }, evidence },
      { id: "violate", from: "ready", to: "unsafe", label: "short unsafe branch", actor: "worker", event: "finish", guard: { op: "true" }, effects: { x: { value: 1 }, y: { value: 1 } }, evidence },
    ],
    [prop("not-both-set", { op: "not", arg: all(eq(operand("x"), literal(1)), eq(operand("y"), literal(1))) })],
  );
  const result = await checkBehaviorModel(model);
  const safety = result.properties[0]!;
  assert.equal(result.status, "counterexample");
  assert.equal(result.exhaustive, true);
  assert.equal(result.exploredStates, 5, "both update orders and the unsafe control state must be explored");
  assert.equal(safety.status, "failed");
  assert.equal(safety.trace.length, 2, "the direct violation is the shortest path");
  assert.equal(safety.trace[1]?.transitionId, "violate");
});

test("a transition applies all assignments from the old valuation", async () => {
  const model = modelWith(
    [{ id: "before", label: "Before swap" }, { id: "after", label: "After swap" }],
    [{ id: "x", domain: [0, 1], initial: 0 }, { id: "y", domain: [0, 1], initial: 1 }],
    [{ id: "swap", from: "before", to: "after", label: "swap values", actor: "worker", event: "swap", guard: { op: "true" }, effects: { x: operand("y"), y: operand("x") }, evidence }],
    [prop("values-remain-distinct", neq(operand("x"), operand("y")), ["after"])],
  );
  const result = await checkBehaviorModel(model);
  assert.equal(result.status, "passed");
  assert.equal(result.exploredStates, 2);
  assert.equal(result.properties[0]?.reachableStates, 1);
});

test("unreachable safety properties and liveness never produce a vacuous pass", async () => {
  const model = modelWith(
    [{ id: "start", label: "Start" }, { id: "never-seen", label: "Never reached" }],
    [{ id: "ready", domain: [false, true], initial: false }],
    [],
    [prop("never-seen", { op: "true" }, ["never-seen"]), prop("eventually-ready", eq(operand("ready"), literal(true)), [], "liveness")],
  );
  const result = await checkBehaviorModel(model);
  assert.equal(result.exhaustive, true);
  assert.equal(result.status, "inconclusive");
  assert.deepEqual(result.properties.map(item => item.status), ["unreachable", "unsupported"]);
  assert.equal(result.properties[0]?.reachableStates, 0);
});

test("state, transition, deadline, and abort bounds stay inconclusive", async () => {
  const model = modelForBoundChecks();
  const stateBound = await checkBehaviorModel(model, { maxStates: 1 });
  assert.equal(stateBound.status, "inconclusive");
  assert.equal(stateBound.exhaustive, false);
  assert.equal(stateBound.properties[0]?.status, "incomplete");

  const transitionBound = await checkBehaviorModel(model, { maxTransitions: 1 });
  assert.equal(transitionBound.status, "inconclusive");
  assert.equal(transitionBound.exhaustive, false);
  assert.equal(transitionBound.properties[0]?.status, "incomplete");

  const originalNow = Date.now;
  let clockCalls = 0;
  Date.now = () => clockCalls++ === 0 ? 100 : 101;
  try {
    const deadline = await checkBehaviorModel(model, { timeoutMs: 1 });
    assert.equal(deadline.status, "inconclusive");
    assert.equal(deadline.exhaustive, false);
    assert.match(deadline.message, /time limit reached/);
  } finally {
    Date.now = originalNow;
  }

  const controller = new AbortController();
  controller.abort();
  const aborted = await checkBehaviorModel(model, { signal: controller.signal });
  assert.equal(aborted.status, "inconclusive");
  assert.equal(aborted.exhaustive, false);
  assert.match(aborted.message, /aborted/);
});

test("counterexample output is bounded and keeps both endpoints", async () => {
  const model = modelWith(
    ["a", "b", "c", "d", "bad"].map(id => ({ id, label: id })),
    [],
    [
      { id: "ab", from: "a", to: "b", label: "ab", actor: "worker", event: "move", guard: { op: "true" }, effects: {}, evidence },
      { id: "bc", from: "b", to: "c", label: "bc", actor: "worker", event: "move", guard: { op: "true" }, effects: {}, evidence },
      { id: "cd", from: "c", to: "d", label: "cd", actor: "worker", event: "move", guard: { op: "true" }, effects: {}, evidence },
      { id: "db", from: "d", to: "bad", label: "bad", actor: "worker", event: "move", guard: { op: "true" }, effects: {}, evidence },
    ],
    [prop("bad-is-unsafe", { op: "false" }, ["bad"])],
  );
  const result = await checkBehaviorModel(model, { maxTraceSteps: 3 });
  const trace = result.properties[0]!.trace;
  assert.equal(result.status, "counterexample");
  assert.equal(result.properties[0]?.traceTruncated, true);
  assert.equal(trace.length, 3);
  assert.equal(trace[0]?.state, "a");
  assert.equal(trace.at(-1)?.state, "bad");
  assert.match(trace.at(-1)?.summary ?? "", /omitted/);
  assert.match(trace.at(-1)?.summary ?? "", /bad/);
});

test("malformed models and definitions fail validation instead of returning a result", async () => {
  const model = modelForBoundChecks();
  const badReference = structuredClone(model);
  badReference.transitions[0]!.guard = eq(operand("missing"), literal(0));
  await assert.rejects(checkBehaviorModel(badReference), /must reference a declared variable/);

  const badDomain = structuredClone(model);
  badDomain.variables[0]!.initial = Number.NaN;
  await assert.rejects(checkBehaviorModel(badDomain), /finite safe integer/);

  const sparseStates = structuredClone(model);
  sparseStates.states = new Array(model.states.length);
  await assert.rejects(checkBehaviorModel(sparseStates), /dense array/);
  let accessorRead = false;
  const accessorStates = [...model.states];
  Object.defineProperty(accessorStates, "0", { enumerable: true, configurable: true, get: () => { accessorRead = true; return model.states[0]; } });
  await assert.rejects(checkBehaviorModel({ ...model, states: accessorStates }), /plain data item/);
  assert.equal(accessorRead, false, "validation must reject accessors without invoking them");

  const badDefinition = { ...definition(model), unknown: true };
  assert.throws(() => validateBehaviorDefinition(badDefinition), /unknown field/);
  assert.throws(() => validateBehaviorDefinition({ ...definition(model), id: "123-behavior" }), /starting with a letter/);
  assert.throws(() => validateBehaviorDefinition({ ...definition(model), sourceSnapshotId: "/private/snapshot" }), /bounded scope identifier/);
  const actualIdentifierShapes = validateBehaviorDefinition({
    ...definition(model),
    repositoryId: "1234567890",
    sourceSnapshotId: "0".repeat(64),
    planRevisions: [{ id: "123e4567-e89b-12d3-a456-426614174000", revision: 1 }],
  });
  assert.equal(actualIdentifierShapes.sourceSnapshotId.length, 64);
  assert.equal(actualIdentifierShapes.planRevisions[0]?.id, "123e4567-e89b-12d3-a456-426614174000");
  const numericRepository = structuredClone(actualIdentifierShapes);
  for (const item of [...numericRepository.current.transitions, ...numericRepository.current.properties])
    for (const source of item.evidence) source.repositoryId = numericRepository.repositoryId;
  assert.equal(validateBehaviorDefinition(numericRepository).current.properties[0]?.evidence[0]?.repositoryId, "1234567890");

  let deep: BehaviorModel["properties"][number]["predicate"] = { op: "true" };
  for (let index = 0; index < 40; index++) deep = { op: "not", arg: deep };
  const tooDeep = structuredClone(model);
  tooDeep.properties[0]!.predicate = deep;
  await assert.rejects(checkBehaviorModel(tooDeep), /predicate depth exceeds/);
});

test("definition hashes are stable and TLA export keeps definitions as data", () => {
  const swap = modelWith(
    [{ id: "before", label: "Before" }, { id: "after", label: "After" }],
    [{ id: "x", domain: [0, 1], initial: 0 }, { id: "y", domain: [0, 1], initial: 1 }],
    [{ id: "swap", from: "before", to: "after", label: "Injected\"\nMODULE Bad", actor: "worker", event: "swap", guard: eq(literal("MODULE Bad"), literal("MODULE Bad")), effects: { x: operand("y"), y: operand("x") }, evidence }],
    [prop("swap-safe", neq(operand("x"), operand("y")), ["after"])],
  );
  const valid = definition(swap, structuredClone(swap));
  const reordered = Object.fromEntries(Object.entries(valid).reverse()) as BehaviorDefinition;
  assert.equal(behaviorDefinitionHash(valid), behaviorDefinitionHash(reordered));
  const suite = exportBehaviorSuite(valid);
  const files = new Map(suite.files.map(file => [file.path, file.content]));
  const currentTla = files.get("verification/Current.tla")!;
  const plannedTla = files.get("verification/Planned.tla")!;
  assert.ok(files.has("definition.json"));
  assert.ok(files.has("README.md"));
  assert.ok(files.has("SKILL.md"));
  assert.ok(files.has("verification/Current.cfg"));
  assert.ok(files.has("verification/Planned.cfg"));
  assert.notEqual(currentTla, plannedTla);
  assert.doesNotMatch(currentTla, /MODULE Bad|Injected/);
  assert.match(currentTla, /v_x_[a-f0-9]{10}' = v_y_[a-f0-9]{10}/);
  assert.match(currentTla, /v_y_[a-f0-9]{10}' = v_x_[a-f0-9]{10}/);
  assert.match(files.get("verification/Current.cfg")!, /SPECIFICATION Spec[\s\S]*INVARIANT TypeOK[\s\S]*CHECK_DEADLOCK FALSE/);
});

test("signed zero has identical integer semantics before and after persistence and TLA export", async () => {
  const signed = modelWith(
    [{ id: "idle", label: "Idle" }],
    [{ id: "x", domain: [0], initial: -0 }],
    [{ id: "assign", from: "idle", to: "idle", label: "Assign zero", actor: "worker", event: "assign", guard: { op: "true" }, effects: { x: literal(-0) }, evidence }],
    [prop("integer-zero", eq(operand("x"), literal(0)))],
  );
  const persisted = JSON.parse(JSON.stringify(signed)) as BehaviorModel;
  const direct = await checkBehaviorModel(signed);
  const reloaded = await checkBehaviorModel(persisted);
  assert.equal(direct.status, "passed");
  assert.equal(direct.exhaustive, true);
  assert.equal(direct.modelHash, reloaded.modelHash);
  assert.equal(direct.status, reloaded.status);
  assert.equal(direct.exploredStates, reloaded.exploredStates);
  assert.deepEqual(direct.properties, reloaded.properties);
  assert.equal(Object.is(validateBehaviorDefinition(definition(signed)).current.variables[0]!.initial, -0), false);
  assert.deepEqual(exportBehaviorSuite(definition(signed)), exportBehaviorSuite(definition(persisted)));
});

test("prototype-named variables keep their value when an exported transition has no assignment", async () => {
  const model = modelWith(
    [{ id: "idle", label: "Idle" }],
    [{ id: "constructor", domain: [0], initial: 0 }, { id: "toString", domain: [0], initial: 0 }],
    [{ id: "stay", from: "idle", to: "idle", label: "Stay", actor: "worker", event: "stay", guard: { op: "true" }, effects: {}, evidence }],
    [prop("unchanged", { op: "and", args: [eq(operand("constructor"), literal(0)), eq(operand("toString"), literal(0))] })],
  );
  assert.equal((await checkBehaviorModel(model)).status, "passed");
  const tla = exportBehaviorSuite(definition(model)).files.find(file => file.path === "verification/Current.tla")!.content;
  for (const name of ["constructor", "toString"])
    assert.match(tla, new RegExp(`(v_${name}_[a-f0-9]{10})' = \\1(?:\\n|$)`));
});

test("refresh publication pilot passes after the workspace plan fence and its old-order negative control fails", async () => {
  const pilotPath = new URL("../verification/understanding-refresh/definition.json", import.meta.url);
  const negativePath = new URL("../verification/understanding-refresh/negative-control/definition.json", import.meta.url);
  const pilot = validateBehaviorDefinition(JSON.parse(readFileSync(pilotPath, "utf8")));
  const negative = validateBehaviorDefinition(JSON.parse(readFileSync(negativePath, "utf8")));
  const [current, planned, broken] = await Promise.all([
    checkBehaviorModel(pilot.current),
    checkBehaviorModel(pilot.planned!),
    checkBehaviorModel(negative.current),
  ]);
  assert.equal(current.status, "passed");
  assert.equal(current.exhaustive, true);
  assert.equal(planned.status, "passed");
  assert.equal(broken.status, "counterexample");
  const property = broken.properties.find(item => item.id === "published_plans_match_captured_revisions")!;
  assert.equal(property.status, "failed");
  assert.equal(property.trace.at(-1)?.state, "published");
  assert.ok(property.trace.some(step => step.transitionId === "edit_repo_a_plan_during_repo_b_context"));
});
