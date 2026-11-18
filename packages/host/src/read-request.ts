import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { ownedPathSchema, taskIdSchema, teamEvidenceSchema } from "./team-types.js";

// Part 2 of the read-pools design: request and result shapes.
// Part 3: the pure validator, run again by the host before launch.

const NOTE_BYTES = 240;

const sourceRef = z.string().max(2048).refine(value => {
  if (/^evidence:[1-9]\d{0,3}$/.test(value)) return true;
  if (/\s/.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "Use an https URL or evidence:N");

export const readOutputSchema = z.enum(["findings", "list", "verdict", "locations"]);
export type ReadOutput = z.infer<typeof readOutputSchema>;

export const readStepSchema = z.strictObject({
  id: taskIdSchema,
  title: z.string().trim().min(1).max(100),
  instructions: z.string().trim().min(1).max(4000),
  agentProfileId: taskIdSchema.optional(),
  paths: z.array(ownedPathSchema).max(16).optional(),
  output: readOutputSchema,
  effort: z.enum(["small", "standard", "large"]).optional(),
  forEach: z.strictObject({ step: taskIdSchema, maxItems: z.number().int().min(1).max(16) }).optional(),
  lead: z.strictObject({ maxAttempts: z.number().int().min(1).max(12) }).optional(),
  verify: z.literal(true).optional(),
  source: z.strictObject({ refs: z.array(sourceRef).min(1).max(8) }).optional(),
});
export type ReadStep = z.infer<typeof readStepSchema>;

export const readRequestSchema = z.strictObject({
  kind: z.literal("read"),
  summary: z.string().trim().min(1).max(2000),
  concurrency: z.number().int().min(1).optional(),
  phases: z.array(z.strictObject({
    id: taskIdSchema,
    steps: z.array(readStepSchema).min(1).max(6),
  })).min(1).max(4),
});
export type ReadRequest = z.infer<typeof readRequestSchema>;

const noteText = z.string().trim().min(1).refine(value => Buffer.byteLength(value, "utf8") <= NOTE_BYTES, `Keep each note under ${NOTE_BYTES} bytes.`);

export const readNotesSchema = z.strictObject({
  decisions: z.array(z.strictObject({ what: noteText, why: noteText })).max(6).optional(),
  forSiblings: z.array(z.strictObject({ note: noteText, paths: z.array(ownedPathSchema).max(16).optional() })).max(4).optional(),
  open: z.array(noteText).max(4).optional(),
});

const resultBase = {
  kind: z.literal("read-result"),
  partial: z.boolean(),
  notes: readNotesSchema.optional(),
};

const listItemSchema = z.strictObject({
  key: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(200),
  source: z.string().trim().min(1).max(1000),
});

const locationItemSchema = z.strictObject({
  path: z.string().trim().min(1).max(512),
  symbols: z.array(z.string().trim().min(1).max(200)).max(16),
  role: z.string().trim().min(1).max(240),
});

export const readResultSchema = z.discriminatedUnion("output", [
  z.strictObject({
    ...resultBase,
    output: z.literal("findings"),
    summary: z.string().trim().min(1).max(4000),
    evidence: z.array(teamEvidenceSchema).min(1).max(12),
  }),
  z.strictObject({
    ...resultBase,
    output: z.literal("list"),
    summary: z.string().trim().min(1).max(4000),
    items: z.array(listItemSchema).min(1).max(32),
  }),
  z.strictObject({
    ...resultBase,
    output: z.literal("verdict"),
    verdict: z.enum(["met", "not-met", "inconclusive"]),
    criterion: z.string().trim().min(1).max(1000),
    evidence: z.array(teamEvidenceSchema).min(1).max(8),
  }),
  z.strictObject({
    ...resultBase,
    output: z.literal("locations"),
    summary: z.string().trim().min(1).max(4000),
    items: z.array(locationItemSchema).min(1).max(24),
  }),
]);
export type ReadResult = z.infer<typeof readResultSchema>;

const count = (max: number) => z.number().int().min(0).max(max);

export const readGrantSchema = z.strictObject({
  requester: z.enum(["project-manager", "scout-lead", "reader", "quarantined-reader"]),
  poolOn: z.boolean(),
  profiles: z.array(taskIdSchema).max(64),
  routerCoversScout: z.boolean(),
  limits: z.strictObject({
    concurrency: count(64),
    listConcurrency: count(64),
    requestAttempts: count(100),
    outside: z.boolean(),
  }),
  allowanceLeft: count(1000),
  reservation: count(100).optional(),
  outsideProfiles: z.array(taskIdSchema).max(64),
  // Set by the host. The validator only reads it.
  lineage: z.strictObject({
    state: z.enum(["extends", "new", "capped"]),
    uncleared: z.array(z.strictObject({ runId: z.uuid(), head: z.string().regex(/^[0-9a-f]{40,64}$/) })).max(3),
  }).optional(),
  requestsSent: count(100),
  activeSteps: z.array(z.strictObject({ key: z.string().regex(/^[0-9a-f]{64}$/), stepId: taskIdSchema })).max(256),
});
export type ReadGrant = z.infer<typeof readGrantSchema>;

export type ReadErrorCode =
  | "not-granted"
  | "unknown-profile"
  | "forward-reference"
  | "repeated-step"
  | "duplicate-running"
  | "over-ceiling"
  | "outside-off";

export type ReadRequestError = {
  code: ReadErrorCode;
  path: string;
  message: string;
  fix: string;
  limit?: "concurrency" | "request" | "allowance" | "reservation";
  duplicateOf?: string;
};

export type ReadRequestResult =
  | { ok: true; total: number; phases: number[]; keys: Record<string, string> }
  | { ok: false; errors: ReadRequestError[] };

/** Part 2: a step's key ignores profile, id, title and effort, so the same work is recognized however it is labelled. */
export function stepKey(step: ReadStep): string {
  const instructions = step.instructions.replace(/\s+/g, " ").trim().toLowerCase();
  const paths = [...(step.paths ?? [])].sort();
  const refs = [...(step.source?.refs ?? [])].sort();
  const material = JSON.stringify([instructions, paths, step.output, step.forEach?.step ?? null, refs]);
  return createHash("sha256").update(material).digest("hex");
}

/** Part 3: a step costs its forEach maxItems times its lead attempts (1 plus maxAttempts); each defaults to 1. */
export function expandedTotal(request: ReadRequest): { total: number; phases: number[] } {
  const phases = request.phases.map(phase => phase.steps.reduce((sum, step) => sum + stepCost(step), 0));
  return { total: phases.reduce((sum, count) => sum + count, 0), phases };
}

function stepCost(step: ReadStep): number {
  const fanOut = step.forEach?.maxItems ?? 1;
  const attempts = step.lead ? 1 + step.lead.maxAttempts : 1;
  return fanOut * attempts;
}

type LocatedStep = { step: ReadStep; phase: number; path: string };

function locate(request: ReadRequest): LocatedStep[] {
  return request.phases.flatMap((phase, phaseIndex) =>
    phase.steps.map((step, stepIndex) => ({ step, phase: phaseIndex, path: `phases[${phaseIndex}].steps[${stepIndex}]` })));
}

/** Returns every rule violation in one pass, so the member fixes the request once. */
export function validateReadRequest(request: ReadRequest, grantInput: unknown): ReadRequestResult {
  const parsedGrant = readGrantSchema.safeParse(grantInput);
  if (!parsedGrant.success) {
    return { ok: false, errors: [error("not-granted", "grant", "The host's read grant is invalid, so no read can start.",
      "This is a host fault: report it as a blocker instead of sending another read request.")] };
  }
  const grant = parsedGrant.data;
  const errors: ReadRequestError[] = [];
  const steps = locate(request);
  const { total, phases } = expandedTotal(request);
  const keyById = new Map<string, string>();
  const firstIdPath = new Map<string, string>();
  const firstKeyStep = new Map<string, string>();
  const isLead = grant.requester === "project-manager";

  if (!grant.poolOn) {
    errors.push(error("not-granted", "request", "The read pool is off for this run.",
      "Do the work without a read request; the owner has not turned the pool on."));
  }
  if (grant.requester === "reader" || grant.requester === "quarantined-reader") {
    errors.push(error("not-granted", "request", `A ${grant.requester} cannot send a read request.`,
      "Report your findings directly; only a project manager or a scout lead sends read requests."));
  }
  if (grant.requester === "scout-lead" && grant.requestsSent >= 1) {
    errors.push(error("not-granted", "request", "A scout lead sends one read request per run revision, and this one is used.",
      "Report with the evidence you have."));
  }
  if (isLead && grant.requestsSent >= 3) {
    errors.push(error("not-granted", "request", "A project manager sends three read requests per run revision, and all three are used.",
      "Plan with the evidence you have; do not send another read request in this revision."));
  }

  for (const { step, phase, path } of steps) {
    const stepKeyValue = stepKey(step);
    if (!keyById.has(step.id)) keyById.set(step.id, stepKeyValue);

    if (step.lead !== undefined && !isLead) {
      errors.push(error("not-granted", `${path}.lead`, "Only a project manager may set lead.",
        "Remove the lead field."));
    }
    if (step.verify !== undefined && !isLead) {
      errors.push(error("not-granted", `${path}.verify`, "Only a project manager may set verify.",
        "Remove the verify field."));
    }

    if (step.source && step.lead) {
      errors.push(error("not-granted", `${path}.lead`, "An outside-content step cannot be a lead.",
        "Remove lead, or remove source from this step."));
    }
    if (step.agentProfileId !== undefined && !grant.profiles.includes(step.agentProfileId)) {
      errors.push(error("unknown-profile", `${path}.agentProfileId`, `Profile "${step.agentProfileId}" is not in this run's pool.`,
        `Name one of the profiles in the pool: ${grant.profiles.join(", ") || "none"}.`));
    } else if (step.agentProfileId === undefined && !grant.routerCoversScout) {
      errors.push(error("unknown-profile", `${path}.agentProfileId`, "The step names no profile, and the router does not cover scout.",
        `Name one of the profiles in the pool: ${grant.profiles.join(", ") || "none"}.`));
    }

    if (step.forEach) {
      const target = steps.find(candidate => candidate.step.id === step.forEach?.step);
      const forEachPath = `${path}.forEach.step`;
      if (!target) {
        errors.push(error("forward-reference", forEachPath, `forEach names "${step.forEach.step}", which is not a step in this request.`,
          "Name a list step from an earlier phase."));
      } else {
        if (target.phase >= phase) {
          errors.push(error("forward-reference", forEachPath, `forEach names "${step.forEach.step}", which is in the same or a later phase.`,
            "Move the list step into an earlier phase."));
        }
        if (target.step.output !== "list") {
          errors.push(error("forward-reference", forEachPath, `forEach names "${step.forEach.step}", whose output is ${target.step.output}, not list.`,
            "Name a step whose output is list."));
        }
      }
    }

    const earlierId = firstIdPath.get(step.id);
    if (earlierId !== undefined) {
      errors.push({ ...error("repeated-step", `${path}.id`, `Step id "${step.id}" is already used at ${earlierId}.`,
        "Give each step its own id."), duplicateOf: step.id });
    } else {
      firstIdPath.set(step.id, path);
    }

    const earlierKeyStep = firstKeyStep.get(stepKeyValue);
    if (earlierKeyStep !== undefined) {
      errors.push({ ...error("repeated-step", path, `Step "${step.id}" repeats step "${earlierKeyStep}": same instructions, paths, output and source.`,
        "Merge the two steps, or change the brief if the work differs."), duplicateOf: earlierKeyStep });
    } else {
      firstKeyStep.set(stepKeyValue, step.id);
    }

    const active = grant.activeSteps.find(candidate => candidate.key === stepKeyValue);
    if (active) {
      errors.push({ ...error("duplicate-running", path, `This work already runs or completed as step "${active.stepId}"; the requester receives that step's output.`,
        `Remove this step and use the output of "${active.stepId}", or change the brief if the work differs.`), duplicateOf: active.stepId });
    }

    if (step.source) {
      const sourcePath = `${path}.source`;
      if (!grant.limits.outside) {
        errors.push(error("outside-off", sourcePath, "Outside reads are off for this run.",
          "Remove the source field and read the repository instead."));
      }
      if (step.agentProfileId === undefined || !grant.outsideProfiles.includes(step.agentProfileId)) {
        errors.push(error("outside-off", sourcePath, "The step's profile has no verified outside-read tool.",
          "Use a profile that can read outside sources, or remove the source field."));
      }
      if (grant.lineage === undefined) {
        errors.push(error("outside-off", sourcePath, "The host has not established whether this run may read outside content.",
          "Report a blocker; outside reads wait for the host to set the lineage state."));
      } else if (grant.lineage.state === "capped") {
        const heads = grant.lineage.uncleared.map(item => `run ${item.runId} head ${item.head}`).join("; ");
        errors.push(error("outside-off", sourcePath, `This run already holds the cap of uncleared outside lineages: ${heads}.`,
          "The owner must clear one of these heads before a new outside lineage can start."));
      }
    }
  }

  const hasListFanout = steps.some(({ step }) => step.forEach !== undefined);
  if (request.concurrency !== undefined) {
    const cap = hasListFanout ? grant.limits.listConcurrency : grant.limits.concurrency;
    if (request.concurrency > cap) {
      errors.push({ ...error("over-ceiling", "concurrency",
        `Concurrency ${request.concurrency} is above the ${hasListFanout ? "list" : "run"} ceiling of ${cap}.`,
        `Set concurrency to ${cap} or less.`), limit: "concurrency" });
    }
  }
  if (total > grant.limits.requestAttempts) {
    errors.push({ ...error("over-ceiling", "phases",
      `The expanded request is ${total} steps; the per-request limit is ${grant.limits.requestAttempts}.`,
      `Cut the steps or maxItems so the expanded total is ${grant.limits.requestAttempts} or less.`), limit: "request" });
  }
  if (total > grant.allowanceLeft) {
    errors.push({ ...error("over-ceiling", "phases",
      `The expanded request is ${total} steps; the run has ${grant.allowanceLeft} left.`,
      `Send at most ${grant.allowanceLeft} expanded steps.`), limit: "allowance" });
  }
  if (grant.requester === "scout-lead") {
    const reservation = grant.reservation ?? 0;
    if (total > reservation) {
      errors.push({ ...error("over-ceiling", "phases",
        `The expanded request is ${total} steps; the scout lead's reservation is ${reservation}.`,
        `Send at most ${reservation} expanded steps.`), limit: "reservation" });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, total, phases, keys: Object.fromEntries(keyById) };
}

function error(code: ReadErrorCode, path: string, message: string, fix: string): ReadRequestError {
  return { code, path, message, fix };
}

/** One line per error, then the sentence that tells the member a refusal is recoverable. */
export function refusalText(errors: ReadRequestError[]): string {
  const lines = errors.map(item => `- ${item.path}: ${item.message} Fix: ${item.fix}`);
  return [
    ...lines,
    "The request was not recorded. This is not a denial: correct the request and report again in this same session.",
  ].join("\n");
}
