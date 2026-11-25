import { createHash } from "node:crypto";
import { z } from "zod";
import { expandedTotal, readRequestSchema, stepKey, type ReadRequest } from "./read-request.js";
import { taskIdSchema } from "./team-types.js";

export const READS_LIMITS = {
  requests: 32,
  memberIds: 4,
  listItems: 32,
  stepsPerPhase: 6 + 6 * 16,
} as const;

const uuid = z.uuid();
const keySchema = z.string().regex(/^[0-9a-f]{64}$/);
const stepIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}(?:\.(?:1[0-5]|[0-9]))?$/);
const itemCount = z.number().int().min(0).max(READS_LIMITS.listItems);
const revisionSchema = z.number().int().min(1);
const requesterSchema = z.strictObject({ role: z.enum(["project-manager", "scout-lead"]), memberId: uuid });

export const readStepStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "joined",
  "complete", "partial", "failed",
  "expanded",
  "refused",
]);
export type ReadStepStatus = z.infer<typeof readStepStatusSchema>;

const stepStateSchema = z.strictObject({
  id: stepIdSchema,
  key: keySchema,
  status: readStepStatusSchema,
  memberIds: z.array(uuid).max(READS_LIMITS.memberIds),
  output: uuid.optional(),
  join: z.strictObject({ requestId: uuid, stepId: taskIdSchema }).optional(),
  list: z.literal(true).optional(),
  items: itemCount.optional(),
  forEach: z.strictObject({ source: taskIdSchema, maxItems: z.number().int().min(1).max(16), truncated: itemCount.optional() }).optional(),
  item: z.number().int().min(0).max(15).optional(),
});

const phaseStateSchema = z.strictObject({
  id: taskIdSchema,
  status: z.enum(["pending", "started", "settled", "refused"]),
  reason: z.literal("allowance").optional(),
  steps: z.array(stepStateSchema).min(1).max(READS_LIMITS.stepsPerPhase),
});

const requestStateSchema = z.strictObject({
  id: uuid,
  revision: revisionSchema,
  requester: requesterSchema,
  depth: z.union([z.literal(1), z.literal(2)]),
  digest: keySchema,
  status: z.enum(["running", "ended", "refused"]),
  phases: z.array(phaseStateSchema).min(1).max(4),
});

const readsShape = z.strictObject({ v: z.literal(1), requests: z.array(requestStateSchema).max(READS_LIMITS.requests) });
export type ReadsState = z.infer<typeof readsShape>;
export type ReadRequestState = ReadsState["requests"][number];
export type ReadPhaseState = ReadRequestState["phases"][number];
export type ReadStepState = ReadPhaseState["steps"][number];

export const readsStateSchema = readsShape.superRefine((state, context) => {
  const problem = integrity(state);
  if (problem) context.addIssue({ code: "custom", message: problem });
});

export function emptyReadsState(): ReadsState {
  return { v: 1, requests: [] };
}

export function parseReadsState(value: unknown): { ok: true; state: ReadsState } | { ok: false; error: string } {
  const parsed = readsStateSchema.safeParse(value);
  if (parsed.success) return { ok: true, state: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue.path.map(part => (typeof part === "number" ? `[${part}]` : typeof part === "string" && /^[a-zA-Z]{1,20}$/.test(part) ? `.${part}` : ".?")).join("");
  const detail = issue.code === "custom" ? issue.message : issue.code;
  return { ok: false, error: `${parsed.error.issues.length} issue(s); first at state${path}: ${detail}` };
}

export const readPhaseEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("admit"),
    requestId: uuid,
    revision: revisionSchema,
    requester: requesterSchema,
    request: readRequestSchema,
    keys: z.record(taskIdSchema, keySchema).refine(keys => Object.keys(keys).length <= 24),
    phaseTotals: z.array(z.number().int().min(0)).min(1).max(4),
    allowanceLeft: z.number().int().min(0).max(200),
  }),
  z.strictObject({ type: z.literal("start"), requestId: uuid, stepId: stepIdSchema, memberId: uuid }),
  z.strictObject({
    type: z.literal("settle"),
    requestId: uuid,
    stepId: stepIdSchema,
    status: z.enum(["complete", "partial", "failed"]),
    output: uuid.optional(),
    items: itemCount.optional(),
  }),
]);
export type ReadPhaseEvent = z.infer<typeof readPhaseEventSchema>;
type AdmitEvent = Extract<ReadPhaseEvent, { type: "admit" }>;

export type ReadRefusalCode =
  | "invalid-event" | "inconsistent-input" | "nested-for-each" | "conflicting-admission" | "request-limit"
  | "unknown-request" | "unknown-step" | "not-startable" | "member-limit" | "not-running" | "conflicting-settle"
  | "invalid-result";

export type ReadTransition =
  | { ok: true; state: ReadsState; changed: boolean }
  | { ok: false; code: ReadRefusalCode; message: string };

const SETTLED: ReadonlySet<string> = new Set(["complete", "partial", "failed"]);
const JOINABLE: ReadonlySet<string> = new Set(["queued", "running", "complete", "partial"]);

export type ReadJoinCandidate = { key: string; requestId: string; stepId: string; status: ReadStepStatus; list?: true; output?: string };

export function joinCandidates(state: ReadsState, revision: number): ReadJoinCandidate[] {
  return state.requests.filter(request => request.revision === revision).flatMap(request => request.phases.flatMap(phase => phase.steps
    .filter(step => step.join === undefined && step.forEach === undefined && step.item === undefined && JOINABLE.has(step.status))
    .map(step => ({ key: step.key, requestId: request.id, stepId: step.id, status: step.status, ...(step.list ? { list: true as const } : {}),
      ...(step.output ? { output: step.output } : {}) }))));
}

export function applyReadEvent(state: ReadsState, eventInput: unknown): ReadTransition {
  const parsed = readPhaseEventSchema.safeParse(eventInput);
  if (!parsed.success) return refuse("invalid-event", "The event does not match the read phase event schema.");
  const event = parsed.data;
  if (event.type === "admit") return admit(state, event);
  const request = state.requests.find(candidate => candidate.id === event.requestId);
  if (!request) return refuse("unknown-request", `No read request ${event.requestId} is recorded.`);
  const step = findStep(request, event.stepId);
  if (!step) return refuse("unknown-step", `Request ${event.requestId} has no step ${event.stepId}.`);
  if (event.type === "start") {
    if (step.memberIds.includes(event.memberId)) return { ok: true, state, changed: false };
    if (step.status === "running" && step.memberIds.length >= READS_LIMITS.memberIds) {
      return refuse("member-limit", `Step ${step.id} already holds ${READS_LIMITS.memberIds} member ids.`);
    }
    if (step.status !== "queued" && step.status !== "running") return refuse("not-startable", `Step ${step.id} is ${step.status}; only a queued step starts.`);
    return change(state, event.requestId, event.stepId, next => {
      next.status = "running";
      next.memberIds.push(event.memberId);
    });
  }
  if (SETTLED.has(step.status) && step.join === undefined) {
    return step.status === event.status && step.output === event.output && step.items === event.items
      ? { ok: true, state, changed: false }
      : refuse("conflicting-settle", `Step ${step.id} already settled ${step.status} with another result.`);
  }
  if (step.status !== "running") return refuse("not-running", `Step ${step.id} is ${step.status}; only a running step settles.`);
  const shaped = event.status === "failed"
    ? event.output === undefined && event.items === undefined
    : event.output !== undefined && (step.list ? event.items !== undefined : event.items === undefined);
  if (!shaped) return refuse("invalid-result", `A ${event.status} result for step ${step.id} has the wrong fields.`);
  return change(state, event.requestId, event.stepId, next => {
    next.status = event.status;
    if (event.output !== undefined) next.output = event.output;
    if (event.items !== undefined) next.items = event.items;
  });
}

function admit(state: ReadsState, event: AdmitEvent): ReadTransition {
  const existing = state.requests.find(request => request.id === event.requestId);
  const problem = inputProblem(event);
  if (problem) return problem;
  const digest = admissionDigest(event);
  if (existing) {
    return existing.digest === digest ? { ok: true, state, changed: false }
      : refuse("conflicting-admission", `Request ${event.requestId} was admitted with other content.`);
  }
  if (state.requests.length >= READS_LIMITS.requests) return refuse("request-limit", `The run already holds ${READS_LIMITS.requests} read requests.`);
  const next = structuredClone(state);
  let spent = 0;
  let admitting = true;
  const phases = event.request.phases.map((phase, index): ReadPhaseState => {
    spent += event.phaseTotals[index];
    admitting = admitting && spent <= event.allowanceLeft;
    return {
      id: phase.id,
      status: admitting ? "pending" : "refused",
      ...(admitting ? {} : { reason: "allowance" as const }),
      steps: phase.steps.map(step => newStep(state, event, step, admitting)),
    };
  });
  const { role } = event.requester;
  next.requests.push({
    id: event.requestId, revision: event.revision, requester: { ...event.requester }, depth: role === "project-manager" ? 1 : 2, digest, status: "running", phases,
  });
  advance(next);
  return { ok: true, state: next, changed: true };
}

function newStep(state: ReadsState, event: AdmitEvent, step: ReadRequest["phases"][number]["steps"][number], admitted: boolean): ReadStepState {
  const key = event.keys[step.id];
  const base: ReadStepState = { id: step.id, key, status: admitted ? "pending" : "refused", memberIds: [], ...(step.output === "list" ? { list: true as const } : {}) };
  if (step.forEach) return { ...base, forEach: { source: step.forEach.step, maxItems: step.forEach.maxItems } };
  const list = step.output === "list";
  const target = admitted ? joinCandidates(state, event.revision).find(candidate => candidate.key === key && (candidate.list === true) === list) : undefined;
  return target ? { ...base, join: { requestId: target.requestId, stepId: target.stepId } } : base;
}

function inputProblem(event: AdmitEvent): ReadTransition | undefined {
  const steps = event.request.phases.flatMap((phase, index) => phase.steps.map(step => ({ step, phase: index })));
  const ids = new Set(steps.map(({ step }) => step.id));
  const keysMatch = ids.size === steps.length && Object.keys(event.keys).length === steps.length
    && steps.every(({ step }) => Object.hasOwn(event.keys, step.id) && event.keys[step.id] === stepKey(step));
  if (!keysMatch || JSON.stringify(expandedTotal(event.request).phases) !== JSON.stringify(event.phaseTotals)) {
    return refuse("inconsistent-input", "The step keys or phase totals do not match the request.");
  }
  if (new Set(steps.map(({ step }) => event.keys[step.id])).size !== steps.length) return refuse("inconsistent-input", "Two steps of the request share a key.");
  for (const { step, phase } of steps) {
    if (!step.forEach) continue;
    const source = steps.find(candidate => candidate.step.id === step.forEach?.step);
    if (!source || source.phase >= phase || source.step.output !== "list") {
      return refuse("inconsistent-input", `Step ${step.id} names a forEach source that is not a list of an earlier phase.`);
    }
    if (source.step.forEach) return refuse("nested-for-each", `Step ${step.id} iterates over forEach step ${source.step.id}.`);
  }
  return undefined;
}

function admissionDigest(event: AdmitEvent): string {
  const material = JSON.stringify([event.revision, event.requester, event.request], (_, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value);
  return createHash("sha256").update(material).digest("hex");
}

function change(state: ReadsState, requestId: string, stepId: string, edit: (step: ReadStepState) => void): ReadTransition {
  const next = structuredClone(state);
  const step = findStep(next.requests.find(request => request.id === requestId), stepId);
  if (step) edit(step);
  advance(next);
  return { ok: true, state: next, changed: true };
}

function advance(state: ReadsState): void {
  for (const request of state.requests) {
    let ready = true;
    for (const phase of request.phases) {
      if (phase.status === "refused" || !ready) break;
      if (phase.status === "pending") startPhase(request, phase);
      for (const step of phase.steps) if (step.status === "joined") mirror(state, step);
      if (phase.steps.every(step => SETTLED.has(step.status) || step.status === "expanded")) phase.status = "settled";
      ready = phase.status === "settled";
    }
    const statuses = request.phases.map(phase => phase.status);
    request.status = statuses.every(status => status === "refused") ? "refused"
      : statuses.every(status => status === "settled" || status === "refused") ? "ended" : "running";
  }
}

function startPhase(request: ReadRequestState, phase: ReadPhaseState): void {
  phase.status = "started";
  phase.steps = phase.steps.flatMap((step): ReadStepState[] => {
    if (!step.forEach) {
      step.status = step.join ? "joined" : "queued";
      return [step];
    }
    const source = findStep(request, step.forEach.source);
    const count = source && (source.status === "complete" || source.status === "partial") ? source.items ?? 0 : 0;
    const children = Math.min(count, step.forEach.maxItems);
    step.status = "expanded";
    step.forEach.truncated = count - children;
    return [step, ...Array.from({ length: children }, (_, item): ReadStepState => ({
      id: `${step.id}.${item}`, key: step.key, status: "queued", memberIds: [], ...(step.list ? { list: true as const } : {}), item,
    }))];
  });
}

function mirror(state: ReadsState, step: ReadStepState): void {
  const target = findStep(state.requests.find(request => request.id === step.join?.requestId), step.join?.stepId);
  if (!target || !SETTLED.has(target.status)) return;
  step.status = target.status;
  if (target.output !== undefined) step.output = target.output;
  if (target.items !== undefined) step.items = target.items;
}

function findStep(request: ReadRequestState | undefined, stepId: string | undefined): ReadStepState | undefined {
  for (const phase of request?.phases ?? []) {
    const step = phase.steps.find(candidate => candidate.id === stepId);
    if (step) return step;
  }
  return undefined;
}

function refuse(code: ReadRefusalCode, message: string): ReadTransition {
  return { ok: false, code, message };
}

const PHASE_CODE = { pending: "p", started: "t", settled: "s", refused: "r" } as const;
const IN_PHASE: Record<ReadPhaseState["status"], ReadonlySet<string>> = {
  pending: new Set(["pending"]),
  refused: new Set(["refused"]),
  started: new Set(["queued", "running", "joined", "complete", "partial", "failed", "expanded"]),
  settled: new Set(["complete", "partial", "failed", "expanded"]),
};
const RAN: ReadonlySet<string> = new Set(["running", "complete", "partial", "failed"]);
const JOIN_TARGET: ReadonlySet<string> = new Set(["queued", "running", "complete", "partial", "failed"]);

function integrity(state: ReadsState): string | undefined {
  const seen = new Set<string>();
  for (const [r, request] of state.requests.entries()) {
    const at = `requests[${r}]`;
    if (seen.has(request.id)) return `${at} repeats a request id`;
    seen.add(request.id);
    if ((request.depth === 1) !== (request.requester.role === "project-manager")) return `${at} has a depth that does not match its requester`;
    const shape = request.phases.map(phase => PHASE_CODE[phase.status]).join("");
    if (!/^s*(?:tp*)?r*$/.test(shape)) return `${at} has phases out of order`;
    if (request.status !== (/^r+$/.test(shape) ? "refused" : shape.includes("t") ? "running" : "ended")) return `${at} has a status that does not match its phases`;
    const all = request.phases.flatMap(phase => phase.steps);
    if (new Set(all.map(step => step.id)).size !== all.length) return `${at} repeats a step id`;
    const tops = all.filter(step => !step.id.includes("."));
    if (new Set(tops.map(step => step.key)).size !== tops.length) return `${at} repeats a step key`;
    for (const [p, phase] of request.phases.entries()) {
      const where = `${at}.phases[${p}]`;
      if ((phase.status === "refused") !== (phase.reason === "allowance")) return `${where} has a reason that does not match its status`;
      if (phase.steps.filter(step => !step.id.includes(".")).length > 6) return `${where} holds more than 6 steps`;
      if (phase.status === "started" && phase.steps.every(step => SETTLED.has(step.status) || step.status === "expanded")) return `${where} is started with every step settled`;
      for (const [s, step] of phase.steps.entries()) {
        const problem = stepProblem(state, r, p, step);
        if (problem) return `${where}.steps[${s}] ${problem}`;
      }
    }
  }
  return undefined;
}

function stepProblem(state: ReadsState, r: number, p: number, step: ReadStepState): string | undefined {
  const request = state.requests[r];
  const phase = request.phases[p];
  if (!IN_PHASE[phase.status].has(step.status)) return "has a status its phase does not allow";
  const withOutput = step.status === "complete" || step.status === "partial";
  if ((step.output !== undefined) !== withOutput) return "has an output handle that does not match its status";
  if ((step.items !== undefined) !== (withOutput && step.list === true)) return "has an item count that does not match its status";
  if ((step.memberIds.length > 0) !== (step.join === undefined && RAN.has(step.status))) return "has member ids that do not match its status";
  if (new Set(step.memberIds).size !== step.memberIds.length) return "repeats a member id";
  if (step.status === "joined" && !step.join) return "is joined without a target";
  if (step.forEach) return parentProblem(request, p, step);
  if (step.status === "expanded") return "is expanded without forEach";
  if (step.item !== undefined || step.id.includes(".")) {
    const parent = phase.steps.find(candidate => candidate.id === step.id.slice(0, step.id.lastIndexOf(".")));
    const matches = parent?.forEach && parent.status === "expanded" && step.id === `${parent.id}.${step.item}` && step.key === parent.key
      && step.join === undefined && step.list === parent.list;
    return matches ? undefined : "is a forEach child without a matching expanded parent";
  }
  if (!step.join) return undefined;
  const targetIndex = state.requests.findIndex(candidate => candidate.id === step.join?.requestId);
  const target = findStep(state.requests[targetIndex], step.join.stepId);
  if (!target || targetIndex >= r || state.requests[targetIndex].revision !== request.revision || target.key !== step.key
    || target.join || target.forEach || target.item !== undefined) return "joins a step that is not an earlier step of its revision with its key";
  if (!JOIN_TARGET.has(target.status)) return "joins a step that can no longer settle";
  if (step.list !== target.list) return "disagrees on the list flag with the step it joined";
  if (step.status === "pending") return undefined;
  const mirrored = SETTLED.has(target.status)
    ? step.status === target.status && step.output === target.output && step.items === target.items
    : step.status === "joined";
  return mirrored ? undefined : "does not mirror the step it joined";
}

function parentProblem(request: ReadRequestState, p: number, step: ReadStepState): string | undefined {
  const forEach = step.forEach;
  if (!forEach || step.join || step.item !== undefined || step.id.includes(".")) return "is a forEach step with a join or an item";
  if (!["pending", "refused", "expanded"].includes(step.status)) return "is a forEach step that ran itself";
  if ((forEach.truncated !== undefined) !== (step.status === "expanded")) return "has a truncated count that does not match its status";
  const sourcePhase = request.phases.findIndex(phase => phase.steps.some(candidate => candidate.id === forEach.source));
  const source = findStep(request, forEach.source);
  if (!source || sourcePhase >= p || source.list !== true || source.forEach || source.item !== undefined) return "names a source that is not a list of an earlier phase";
  const children = request.phases[p].steps.filter(candidate => candidate.item !== undefined && candidate.id.startsWith(`${step.id}.`));
  if (step.status !== "expanded") return children.length > 0 ? "has children before it expanded" : undefined;
  if (!SETTLED.has(source.status)) return "expanded before its source settled";
  const count = source.status === "failed" ? 0 : source.items ?? 0;
  const shaped = children.length === Math.min(count, forEach.maxItems) && forEach.truncated === count - children.length
    && children.every((child, index) => child.item === index);
  return shaped ? undefined : "has children that do not match its source";
}
