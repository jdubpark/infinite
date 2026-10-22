import { createHash } from "node:crypto";
import type {
  BehaviorCheckResult,
  BehaviorDefinition,
  BehaviorModel,
  BehaviorOperand,
  BehaviorPredicate,
  BehaviorPropertyResult,
  BehaviorTraceStep,
  BehaviorValue,
} from "@infinite/remote";

export const BEHAVIOR_CHECKER_VERSION = "1.0.0";

const DEFAULT_LIMITS = { maxStates: 50_000, maxTransitions: 250_000, timeoutMs: 30_000, maxTraceSteps: 100 } as const;
const MAX_LIMITS = { maxStates: 50_000, maxTransitions: 500_000, timeoutMs: 300_000, maxTraceSteps: 10_000 } as const;
const MAX_STATES = 256;
const MAX_VARIABLES = 64;
const MAX_DOMAIN = 128;
const MAX_TRANSITIONS = 4_096;
const MAX_PROPERTIES = 128;
const MAX_EVIDENCE = 100;
const MAX_PREDICATE_DEPTH = 32;
const MAX_PREDICATE_NODES = 2_048;
const MAX_TOTAL_PREDICATE_NODES = 10_000;
const MAX_ID_LENGTH = 80;

type PlainObject = Record<string, unknown>;
type ValidationContext = { totalPredicateNodes: number };
type InternalState = { state: string; values: Record<string, BehaviorValue> };
type Predecessor = { previous: string | null; transitionId: string | null };
type Limits = { maxStates: number; maxTransitions: number; timeoutMs: number; maxTraceSteps: number };

function fail(path: string, message: string): never {
  throw new Error(`Invalid behavior definition at ${path}: ${message}`);
}

function objectAt(value: unknown, path: string): PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "expected a plain data object");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(path, "symbol keys are not allowed");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${path}.${key}`, "accessors and hidden fields are not allowed");
  }
  return value as PlainObject;
}

function exactKeys(value: PlainObject, path: string, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "required field is missing");
}

function arrayAt(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(path, "expected a plain array");
  if (value.length < min || value.length > max) fail(path, `expected between ${min} and ${max} items`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
    fail(path, "expected a dense array without extra fields");
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${path}[${index}]`, "expected a plain data item");
  }
  return value;
}

function stringAt(value: unknown, path: string, max: number, min = 1): string {
  if (typeof value !== "string") fail(path, "expected a string");
  if (value.length < min || value.length > max) fail(path, `expected a string of length ${min}..${max}`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(path, "control characters are not allowed");
  return value;
}

function idAt(value: unknown, path: string): string {
  const result = stringAt(value, path, MAX_ID_LENGTH);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(result)) fail(path, "expected a stable identifier starting with a letter and using letters, numbers, dot, underscore, colon, or hyphen");
  return result;
}

function scopeIdAt(value: unknown, path: string): string {
  const result = stringAt(value, path, MAX_ID_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) fail(path, "expected a bounded scope identifier using letters, numbers, dot, underscore, colon, or hyphen");
  return result;
}

function safeIntegerAt(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(path, `expected a safe integer in ${min}..${max}`);
  return value;
}

function behaviorValueAt(value: unknown, path: string): BehaviorValue {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return stringAt(value, path, 256, 0);
  // JSON, state keys, and the TLA integer encoding identify -0 with 0.
  if (typeof value === "number" && Number.isSafeInteger(value)) return value === 0 ? 0 : value;
  fail(path, "expected a string, boolean, or finite safe integer");
}

function valueKey(value: BehaviorValue): string {
  return JSON.stringify(value);
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, "identifiers must be unique");
}

function relativeEvidencePath(value: unknown, path: string): string {
  const result = stringAt(value, path, 1_024);
  if (result.startsWith("/") || result.includes("\\") || result.split("/").some(part => part === ".." || part === "")) {
    fail(path, "expected a repository-relative path without parent traversal");
  }
  if (/^[A-Za-z]:/.test(result)) fail(path, "absolute paths are not allowed");
  return result;
}

function validateEvidence(value: unknown, path: string): BehaviorModel["transitions"][number]["evidence"][number] {
  const obj = objectAt(value, path);
  exactKeys(obj, path, ["repositoryId", "source", "line"], ["text"]);
  const result: BehaviorModel["transitions"][number]["evidence"][number] = {
    repositoryId: scopeIdAt(obj.repositoryId, `${path}.repositoryId`),
    source: relativeEvidencePath(obj.source, `${path}.source`),
    line: obj.line === null ? null : safeIntegerAt(obj.line, `${path}.line`, 1),
  };
  if (Object.hasOwn(obj, "text")) result.text = stringAt(obj.text, `${path}.text`, 2_000, 0);
  return result;
}

function validateOperand(value: unknown, path: string): BehaviorOperand {
  const obj = objectAt(value, path);
  const hasVariable = Object.hasOwn(obj, "variable");
  const hasValue = Object.hasOwn(obj, "value");
  if (hasVariable === hasValue) fail(path, "expected exactly one of variable or value");
  if (hasVariable) {
    exactKeys(obj, path, ["variable"]);
    return { variable: idAt(obj.variable, `${path}.variable`) };
  }
  exactKeys(obj, path, ["value"]);
  return { value: behaviorValueAt(obj.value, `${path}.value`) };
}

function validatePredicate(value: unknown, path: string, context: ValidationContext, depth = 1, localNodes = { count: 0 }): BehaviorPredicate {
  if (depth > MAX_PREDICATE_DEPTH) fail(path, `predicate depth exceeds ${MAX_PREDICATE_DEPTH}`);
  context.totalPredicateNodes++;
  localNodes.count++;
  if (context.totalPredicateNodes > MAX_TOTAL_PREDICATE_NODES) fail(path, `model predicate nodes exceed ${MAX_TOTAL_PREDICATE_NODES}`);
  if (localNodes.count > MAX_PREDICATE_NODES) fail(path, `predicate nodes exceed ${MAX_PREDICATE_NODES}`);
  const obj = objectAt(value, path);
  const op = obj.op;
  if (op === "eq" || op === "neq") {
    exactKeys(obj, path, ["op", "left", "right"]);
    return { op, left: validateOperand(obj.left, `${path}.left`), right: validateOperand(obj.right, `${path}.right`) };
  }
  if (op === "and" || op === "or") {
    exactKeys(obj, path, ["op", "args"]);
    const args = arrayAt(obj.args, `${path}.args`, 64, 1).map((item, index) => validatePredicate(item, `${path}.args[${index}]`, context, depth + 1, localNodes));
    return { op, args };
  }
  if (op === "not") {
    exactKeys(obj, path, ["op", "arg"]);
    return { op, arg: validatePredicate(obj.arg, `${path}.arg`, context, depth + 1, localNodes) };
  }
  if (op === "true" || op === "false") {
    exactKeys(obj, path, ["op"]);
    return { op };
  }
  fail(`${path}.op`, "expected eq, neq, and, or, not, true, or false");
}

function validateModel(value: unknown, path: string): BehaviorModel {
  const model = objectAt(value, path);
  exactKeys(model, path, ["initial", "states", "variables", "transitions", "properties"]);
  const states = arrayAt(model.states, `${path}.states`, MAX_STATES, 1).map((item, index) => {
    const entryPath = `${path}.states[${index}]`;
    const entry = objectAt(item, entryPath);
    exactKeys(entry, entryPath, ["id", "label"]);
    return { id: idAt(entry.id, `${entryPath}.id`), label: stringAt(entry.label, `${entryPath}.label`, 240) };
  });
  assertUnique(states.map(item => item.id), `${path}.states`);
  const stateIds = new Set(states.map(item => item.id));
  const initial = idAt(model.initial, `${path}.initial`);
  if (!stateIds.has(initial)) fail(`${path}.initial`, "must reference a declared state");

  const variables = arrayAt(model.variables, `${path}.variables`, MAX_VARIABLES).map((item, index) => {
    const entryPath = `${path}.variables[${index}]`;
    const entry = objectAt(item, entryPath);
    exactKeys(entry, entryPath, ["id", "domain", "initial"]);
    const domain = arrayAt(entry.domain, `${entryPath}.domain`, MAX_DOMAIN, 1).map((itemValue, valueIndex) => behaviorValueAt(itemValue, `${entryPath}.domain[${valueIndex}]`));
    if (new Set(domain.map(valueKey)).size !== domain.length) fail(`${entryPath}.domain`, "domain values must be unique");
    const initialValue = behaviorValueAt(entry.initial, `${entryPath}.initial`);
    if (!domain.some(value => valueKey(value) === valueKey(initialValue))) fail(`${entryPath}.initial`, "must be a member of its variable domain");
    return { id: idAt(entry.id, `${entryPath}.id`), domain, initial: initialValue };
  });
  assertUnique(variables.map(item => item.id), `${path}.variables`);
  const variableById = new Map(variables.map(variable => [variable.id, variable]));

  const validationContext: ValidationContext = { totalPredicateNodes: 0 };
  const transitions = arrayAt(model.transitions, `${path}.transitions`, MAX_TRANSITIONS).map((item, index) => {
    const entryPath = `${path}.transitions[${index}]`;
    const entry = objectAt(item, entryPath);
    exactKeys(entry, entryPath, ["id", "from", "to", "label", "actor", "event", "guard", "effects", "evidence"]);
    const effectsObj = objectAt(entry.effects, `${entryPath}.effects`);
    const effects: Record<string, BehaviorOperand> = {};
    for (const [key, operand] of Object.entries(effectsObj)) effects[idAt(key, `${entryPath}.effects key`)] = validateOperand(operand, `${entryPath}.effects.${key}`);
    const evidence = arrayAt(entry.evidence, `${entryPath}.evidence`, MAX_EVIDENCE).map((itemEvidence, evidenceIndex) => validateEvidence(itemEvidence, `${entryPath}.evidence[${evidenceIndex}]`));
    return {
      id: idAt(entry.id, `${entryPath}.id`),
      from: idAt(entry.from, `${entryPath}.from`),
      to: idAt(entry.to, `${entryPath}.to`),
      label: stringAt(entry.label, `${entryPath}.label`, 240),
      actor: stringAt(entry.actor, `${entryPath}.actor`, 120),
      event: stringAt(entry.event, `${entryPath}.event`, 120),
      guard: validatePredicate(entry.guard, `${entryPath}.guard`, validationContext),
      effects,
      evidence,
    };
  });
  assertUnique(transitions.map(item => item.id), `${path}.transitions`);
  for (const [index, transition] of transitions.entries()) {
    const entryPath = `${path}.transitions[${index}]`;
    if (!stateIds.has(transition.from)) fail(`${entryPath}.from`, "must reference a declared state");
    if (!stateIds.has(transition.to)) fail(`${entryPath}.to`, "must reference a declared state");
    for (const variableId of Object.keys(transition.effects)) if (!variableById.has(variableId)) fail(`${entryPath}.effects.${variableId}`, "must reference a declared variable");
    const validateReferences = (predicate: BehaviorPredicate, predicatePath: string): void => {
      if (predicate.op === "eq" || predicate.op === "neq") {
        for (const [side, operand] of [["left", predicate.left], ["right", predicate.right]] as const) {
          if ("variable" in operand && !variableById.has(operand.variable)) fail(`${predicatePath}.${side}.variable`, "must reference a declared variable");
        }
      } else if (predicate.op === "not") validateReferences(predicate.arg, `${predicatePath}.arg`);
      else if (predicate.op === "and" || predicate.op === "or") predicate.args.forEach((arg, argIndex) => validateReferences(arg, `${predicatePath}.args[${argIndex}]`));
    };
    validateReferences(transition.guard, `${entryPath}.guard`);
    for (const [variableId, operand] of Object.entries(transition.effects)) {
      const target = variableById.get(variableId)!;
      if ("value" in operand) {
        if (!target.domain.some(value => valueKey(value) === valueKey(operand.value))) fail(`${entryPath}.effects.${variableId}.value`, "assignment value must belong to the target variable domain");
      } else {
        const source = variableById.get(operand.variable);
        if (!source) fail(`${entryPath}.effects.${variableId}.variable`, "must reference a declared variable");
        const outside = source.domain.find(value => !target.domain.some(targetValue => valueKey(targetValue) === valueKey(value)));
        if (outside !== undefined) fail(`${entryPath}.effects.${variableId}.variable`, `source domain includes a value outside target variable ${variableId}'s domain`);
      }
    }
  }

  const properties = arrayAt(model.properties, `${path}.properties`, MAX_PROPERTIES, 1).map((item, index) => {
    const entryPath = `${path}.properties[${index}]`;
    const entry = objectAt(item, entryPath);
    exactKeys(entry, entryPath, ["id", "title", "kind", "states", "predicate", "requirement", "basis", "evidence"]);
    if (entry.kind !== "safety" && entry.kind !== "liveness") fail(`${entryPath}.kind`, "expected safety or liveness");
    if (entry.basis !== "accepted" && entry.basis !== "proposed") fail(`${entryPath}.basis`, "expected accepted or proposed");
    const selectedStates = arrayAt(entry.states, `${entryPath}.states`, MAX_STATES).map((state, stateIndex) => idAt(state, `${entryPath}.states[${stateIndex}]`));
    assertUnique(selectedStates, `${entryPath}.states`);
    for (const [stateIndex, stateId] of selectedStates.entries()) if (!stateIds.has(stateId)) fail(`${entryPath}.states[${stateIndex}]`, "must reference a declared state");
    const predicate = validatePredicate(entry.predicate, `${entryPath}.predicate`, validationContext);
    const validateReferences = (pred: BehaviorPredicate, predicatePath: string): void => {
      if (pred.op === "eq" || pred.op === "neq") {
        for (const [side, operand] of [["left", pred.left], ["right", pred.right]] as const) {
          if ("variable" in operand && !variableById.has(operand.variable)) fail(`${predicatePath}.${side}.variable`, "must reference a declared variable");
        }
      } else if (pred.op === "not") validateReferences(pred.arg, `${predicatePath}.arg`);
      else if (pred.op === "and" || pred.op === "or") pred.args.forEach((arg, argIndex) => validateReferences(arg, `${predicatePath}.args[${argIndex}]`));
    };
    validateReferences(predicate, `${entryPath}.predicate`);
    const evidence = arrayAt(entry.evidence, `${entryPath}.evidence`, MAX_EVIDENCE).map((itemEvidence, evidenceIndex) => validateEvidence(itemEvidence, `${entryPath}.evidence[${evidenceIndex}]`));
    return {
      id: idAt(entry.id, `${entryPath}.id`),
      title: stringAt(entry.title, `${entryPath}.title`, 240),
      kind: entry.kind as "safety" | "liveness",
      states: selectedStates,
      predicate,
      requirement: stringAt(entry.requirement, `${entryPath}.requirement`, 2_000),
      basis: entry.basis as "accepted" | "proposed",
      evidence,
    };
  });
  assertUnique(properties.map(item => item.id), `${path}.properties`);

  return { initial, states, variables, transitions, properties };
}

export function validateBehaviorDefinition(value: unknown): BehaviorDefinition {
  const definition = objectAt(value, "definition");
  exactKeys(definition, "definition", ["schemaVersion", "id", "title", "componentId", "repositoryId", "sourceSnapshotId", "planRevisions", "requirementRevision", "assumptions", "exclusions", "current", "planned"]);
  if (definition.schemaVersion !== 1) fail("definition.schemaVersion", "expected schema version 1");
  const planRevisions = arrayAt(definition.planRevisions, "definition.planRevisions", 256).map((item, index) => {
    const path = `definition.planRevisions[${index}]`;
    const plan = objectAt(item, path);
    exactKeys(plan, path, ["id", "revision"]);
    return { id: scopeIdAt(plan.id, `${path}.id`), revision: safeIntegerAt(plan.revision, `${path}.revision`, 1) };
  });
  assertUnique(planRevisions.map(plan => plan.id), "definition.planRevisions");
  const assumptions = arrayAt(definition.assumptions, "definition.assumptions", 64).map((item, index) => stringAt(item, `definition.assumptions[${index}]`, 2_000));
  const exclusions = arrayAt(definition.exclusions, "definition.exclusions", 64).map((item, index) => stringAt(item, `definition.exclusions[${index}]`, 2_000));
  return {
    schemaVersion: 1,
    id: idAt(definition.id, "definition.id"),
    title: stringAt(definition.title, "definition.title", 240),
    componentId: scopeIdAt(definition.componentId, "definition.componentId"),
    repositoryId: scopeIdAt(definition.repositoryId, "definition.repositoryId"),
    sourceSnapshotId: scopeIdAt(definition.sourceSnapshotId, "definition.sourceSnapshotId"),
    planRevisions,
    requirementRevision: scopeIdAt(definition.requirementRevision, "definition.requirementRevision"),
    assumptions,
    exclusions,
    current: validateModel(definition.current, "definition.current"),
    planned: definition.planned === null ? null : validateModel(definition.planned, "definition.planned"),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function behaviorDefinitionHash(definition: BehaviorDefinition): string {
  return sha256(validateBehaviorDefinition(definition));
}

function resolveOperand(operand: BehaviorOperand, values: Record<string, BehaviorValue>): BehaviorValue {
  return "variable" in operand ? values[operand.variable]! : operand.value;
}

function evaluatePredicate(predicate: BehaviorPredicate, values: Record<string, BehaviorValue>): boolean {
  switch (predicate.op) {
    case "eq": return Object.is(resolveOperand(predicate.left, values), resolveOperand(predicate.right, values));
    case "neq": return !Object.is(resolveOperand(predicate.left, values), resolveOperand(predicate.right, values));
    case "and": return predicate.args.every(item => evaluatePredicate(item, values));
    case "or": return predicate.args.some(item => evaluatePredicate(item, values));
    case "not": return !evaluatePredicate(predicate.arg, values);
    case "true": return true;
    case "false": return false;
  }
}

function stateKey(state: InternalState): string {
  return canonicalJson({ state: state.state, values: state.values });
}

function inPropertyScope(property: BehaviorModel["properties"][number], state: InternalState): boolean {
  return property.states.length === 0 || property.states.includes(state.state);
}

function resolveLimits(value: unknown): { limits: Limits; signal?: AbortSignal } {
  const options = value === undefined ? {} : objectAt(value, "options");
  for (const key of Reflect.ownKeys(options)) if (typeof key !== "string" || !["signal", "maxStates", "maxTransitions", "timeoutMs", "maxTraceSteps"].includes(key)) fail(`options.${String(key)}`, "unknown field");
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of ["maxStates", "maxTransitions", "timeoutMs", "maxTraceSteps"] as const) {
    if (Object.hasOwn(options, key)) limits[key] = safeIntegerAt(options[key], `options.${key}`, 1, MAX_LIMITS[key]);
  }
  let signal: AbortSignal | undefined;
  if (Object.hasOwn(options, "signal")) {
    const candidate = options.signal;
    if (typeof candidate !== "object" || candidate === null || typeof (candidate as AbortSignal).aborted !== "boolean") fail("options.signal", "expected an AbortSignal");
    signal = candidate as AbortSignal;
  }
  return { limits, signal };
}

function traceFor(target: string, states: Map<string, InternalState>, predecessors: Map<string, Predecessor>, transitionById: Map<string, BehaviorModel["transitions"][number]>, maxSteps: number): { trace: BehaviorTraceStep[]; truncated: boolean } {
  const reversed: { key: string; transitionId: string | null }[] = [];
  let key: string | null = target;
  while (key !== null) {
    const predecessor: Predecessor = predecessors.get(key)!;
    reversed.push({ key, transitionId: predecessor.transitionId });
    key = predecessor.previous;
  }
  reversed.reverse();
  const truncated = reversed.length > maxSteps;
  let retained = reversed;
  if (truncated) {
    if (maxSteps === 1) retained = [reversed.at(-1)!];
    else {
      const prefix = Math.ceil(maxSteps / 2);
      const suffix = maxSteps - prefix;
      retained = [...reversed.slice(0, prefix), ...reversed.slice(-suffix)];
    }
  }
  const trace = retained.map((item, index): BehaviorTraceStep => {
    const state = states.get(item.key)!;
    const transition = item.transitionId ? transitionById.get(item.transitionId)! : null;
    let summary = transition ? `${transition.actor} ${transition.event}: ${transition.label}` : "Initial state";
    if (truncated && maxSteps === 1) summary = "Counterexample endpoint; preceding steps omitted.";
    else if (truncated && index === Math.ceil(maxSteps / 2)) summary = `Intermediate steps omitted before ${summary}`;
    return { state: state.state, values: { ...state.values }, transitionId: item.transitionId, summary };
  });
  return { trace, truncated };
}

export async function checkBehaviorModel(
  model: BehaviorModel,
  options?: { signal?: AbortSignal; maxStates?: number; maxTransitions?: number; timeoutMs?: number; maxTraceSteps?: number },
): Promise<BehaviorCheckResult> {
  const normalized = validateModel(model, "model");
  const resolved = resolveLimits(options);
  const { limits, signal } = resolved;
  const modelHash = sha256(normalized);
  const started = Date.now();
  const deadline = started + limits.timeoutMs;
  const variables = [...normalized.variables].sort((a, b) => a.id.localeCompare(b.id));
  const initial: InternalState = { state: normalized.initial, values: Object.fromEntries(variables.map(variable => [variable.id, variable.initial])) };
  const initialKey = stateKey(initial);
  const states = new Map<string, InternalState>([[initialKey, initial]]);
  const predecessors = new Map<string, Predecessor>([[initialKey, { previous: null, transitionId: null }]]);
  const queue = [initialKey];
  const targetCounts = new Map(normalized.properties.map(property => [property.id, 0]));
  const violations = new Map<string, string>();
  const propertyById = new Map(normalized.properties.map(property => [property.id, property]));
  const discover = (key: string, state: InternalState) => {
    for (const property of normalized.properties) {
      if (!inPropertyScope(property, state)) continue;
      targetCounts.set(property.id, targetCounts.get(property.id)! + 1);
      if (property.kind === "safety" && !evaluatePredicate(property.predicate, state.values) && !violations.has(property.id)) violations.set(property.id, key);
    }
  };
  discover(initialKey, initial);
  const transitionsBySource = new Map<string, BehaviorModel["transitions"]>();
  for (const state of normalized.states) transitionsBySource.set(state.id, normalized.transitions.filter(transition => transition.from === state.id));
  const transitionById = new Map(normalized.transitions.map(transition => [transition.id, transition]));
  let exploredTransitions = 0;
  let exhausted = true;
  let stopReason = "";
  let workUnits = 0;

  outer: for (let cursor = 0; cursor < queue.length; cursor++) {
    if (signal?.aborted) { exhausted = false; stopReason = "aborted"; break; }
    if (Date.now() >= deadline) { exhausted = false; stopReason = "time limit reached"; break; }
    const currentKey = queue[cursor]!;
    const current = states.get(currentKey)!;
    for (const transition of transitionsBySource.get(current.state) ?? []) {
      if (signal?.aborted) { exhausted = false; stopReason = "aborted"; break outer; }
      if (Date.now() >= deadline) { exhausted = false; stopReason = "time limit reached"; break outer; }
      if (exploredTransitions >= limits.maxTransitions) { exhausted = false; stopReason = "transition limit reached"; break outer; }
      exploredTransitions++;
      workUnits++;
      if (!evaluatePredicate(transition.guard, current.values)) {
        if (workUnits >= 256) {
          workUnits = 0;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        continue;
      }
      const nextValues = { ...current.values };
      for (const [variableId, operand] of Object.entries(transition.effects)) nextValues[variableId] = resolveOperand(operand, current.values);
      const successor: InternalState = { state: transition.to, values: nextValues };
      const successorKey = stateKey(successor);
      if (!states.has(successorKey)) {
        if (states.size >= limits.maxStates) { exhausted = false; stopReason = "state limit reached"; break outer; }
        states.set(successorKey, successor);
        predecessors.set(successorKey, { previous: currentKey, transitionId: transition.id });
        queue.push(successorKey);
        discover(successorKey, successor);
      }
      if (workUnits >= 256) {
        workUnits = 0;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    if (workUnits >= 256) {
      workUnits = 0;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  const properties: BehaviorPropertyResult[] = normalized.properties.map(property => {
    if (property.kind === "liveness") return { id: property.id, status: "unsupported", reachableStates: targetCounts.get(property.id)!, trace: [], traceTruncated: false };
    const violationKey = violations.get(property.id);
    if (violationKey) {
      const path = traceFor(violationKey, states, predecessors, transitionById, limits.maxTraceSteps);
      return { id: property.id, status: "failed", reachableStates: targetCounts.get(property.id)!, trace: path.trace, traceTruncated: path.truncated };
    }
    if (!exhausted) return { id: property.id, status: "incomplete", reachableStates: targetCounts.get(property.id)!, trace: [], traceTruncated: false };
    if (targetCounts.get(property.id) === 0) return { id: property.id, status: "unreachable", reachableStates: 0, trace: [], traceTruncated: false };
    return { id: property.id, status: "passed", reachableStates: targetCounts.get(property.id)!, trace: [], traceTruncated: false };
  });
  const hasFailure = properties.some(property => property.status === "failed");
  const hasInconclusiveProperty = properties.some(property => property.status !== "passed" && property.status !== "failed");
  const status: BehaviorCheckResult["status"] = hasFailure ? "counterexample" : (!exhausted || hasInconclusiveProperty) ? "inconclusive" : "passed";
  const limitSummary = `Explored ${states.size} states and ${exploredTransitions} transitions.`;
  const message = stopReason ? `${limitSummary} Checking is inconclusive because the ${stopReason}.` : hasFailure ? `${limitSummary} At least one reachable safety property has a counterexample.` : hasInconclusiveProperty ? `${limitSummary} At least one property is unreachable or unsupported.` : `${limitSummary} All reachable safety properties passed exhaustively.`;
  return {
    tool: "infinite-finite-state",
    toolVersion: BEHAVIOR_CHECKER_VERSION,
    status,
    checkedAt: new Date().toISOString(),
    modelHash,
    exhaustive: exhausted,
    exploredStates: states.size,
    exploredTransitions,
    limits,
    properties,
    message,
  };
}
