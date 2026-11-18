import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { ownedPathSchema, taskIdSchema, teamEvidenceSchema } from "./team-types.js";

// Part 2 of the read-pools design: request and result shapes.
// Part 3: the pure validator, run again by the host before launch.

const NOTE_BYTES = 240;

// PROPOSED: a reference is at most 2,048 characters, and evidence:N names an item from 1 to 9999; the
// design states neither. The bound aborts, so an over-long reference gets one error, not two.
const sourceRef = z.string().max(2048, { abort: true }).refine(value => {
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
  concurrency: z.number().int().min(1).max(8).optional(), // at most the largest listConcurrency (part 1)
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

// PROPOSED: the design bounds the result lists but not these strings: the list and locations summaries
// (4,000, as today's findings), key 120, title 200, source 1,000, path 512, 16 symbols of 200, role 240,
// and a verdict's criterion 1,000.
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
const setting = (max: number) => z.number().int().min(1).max(max);

// PROPOSED: the host fills the grant within these caps (64 profiles, 64 outside profiles, 256 active
// steps, 100 requests sent), and a grant outside them refuses every read as a host fault. An absent
// lineage refuses every source step, and an absent reservation refuses a scout lead's request.
export const readGrantSchema = z.strictObject({
  requester: z.enum(["project-manager", "scout-lead", "reader", "quarantined-reader"]),
  poolOn: z.boolean(),
  profiles: z.array(taskIdSchema).max(64),
  routerCoversScout: z.boolean(),
  // Part 1 settings table: the ranges a run may pin.
  limits: z.strictObject({
    concurrency: setting(5),
    listConcurrency: setting(8),
    requestAttempts: setting(40),
    outside: z.boolean(),
  }),
  // The run's read allowance after reservations, at most runAttempts (0 to 200). A project manager's
  // request is charged to it. PROPOSED: the grant's allowanceLeft excludes every scout lead's reservation.
  allowanceLeft: count(200),
  // Scout lead only, at most lead.maxAttempts (12): what remains of the attempts the host reserved for
  // this lead at admission. Part 5: a scout lead's request and its own second attempt are funded by
  // its reservation alone.
  reservation: count(12).optional(),
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
  // PROPOSED: the design's table has no code for a request whose shape is wrong. A parse issue is
  // over-ceiling only on the table's list (CEILING_PATHS); every other parse issue is malformed.
  | "malformed"
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

/**
 * Part 2: a step's key ignores profile, id, title and effort, so the same work is recognized however it is labelled.
 * PROPOSED: paths and refs count as sets, so order and repeats do not change the key; the design says only
 * "sorted paths" and "source refs". The step is never mutated.
 */
export function stepKey(step: ReadStep): string {
  const instructions = step.instructions.replace(/\s+/g, " ").trim().toLowerCase();
  const paths = [...new Set(step.paths ?? [])].sort();
  const refs = [...new Set(step.source?.refs ?? [])].sort();
  const material = JSON.stringify([instructions, paths, step.output, step.forEach?.step ?? null, refs]);
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Part 3: a step costs its forEach maxItems times its lead attempts (1 plus maxAttempts); each defaults to 1.
 * PROPOSED: a step with both forEach and lead costs the product; the design gives each factor alone.
 */
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

/**
 * Parses the grant (an invalid one is a host fault), then the request (one error per schema issue, and
 * no rule runs), then returns every rule violation in one pass, so the member fixes the request once.
 * Never throws for any JSON value.
 */
export function validateReadRequest(requestInput: unknown, grantInput: unknown): ReadRequestResult {
  const parsedGrant = readGrantSchema.safeParse(grantInput);
  if (!parsedGrant.success) {
    return { ok: false, errors: [error("not-granted", "grant", "The host's read grant is invalid, so no read can start.",
      "This is a host fault: report it as a blocker instead of sending another read request.")] };
  }
  const parsedRequest = readRequestSchema.safeParse(requestInput);
  if (!parsedRequest.success) return { ok: false, errors: ownIssues(parsedRequest.error.issues).map(issueError) };
  const request = parsedRequest.data;
  const grant = parsedGrant.data;
  const errors: ReadRequestError[] = [];
  const steps = locate(request);
  const { total, phases } = expandedTotal(request);
  const keyById = new Map<string, string>();
  const firstIdPath = new Map<string, string>();
  const firstKeyStep = new Map<string, string>();
  const isLead = grant.requester === "project-manager";

  if (!grant.poolOn) {
    // Acceptance 15: the pool may be off because the evidence store was unavailable, so the text names explore.
    errors.push(error("not-granted", "request", "The read pool is not available for this run.",
      "Send an explore report instead; it runs as before."));
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
    // PROPOSED: part 11 gives a verifier an artifact-only context and a quarantined reader only its
    // brief, with no clone and no entries. One step cannot be both.
    if (step.verify && step.source) {
      errors.push(error("not-granted", `${path}.source`, "A verifier step cannot read outside content.",
        "Remove source from the verifier step, or remove verify."));
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

  // The request-level value is accepted against the list ceiling when any phase has forEach. The
  // scheduler must still hold a phase without forEach to the concurrency setting (part 1).
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
  // Part 5: the host reserved a scout lead's attempts from the run's allowance at admission, so its
  // request and its own second attempt are charged to the reservation alone. The per-request
  // ceiling above counts only the request's own steps.
  if (grant.requester === "scout-lead") {
    const reservation = grant.reservation ?? 0;
    if (total + 1 > reservation) {
      errors.push({ ...error("over-ceiling", "phases",
        `The expanded request is ${total} steps, plus 1 for the scout lead's second attempt; the scout lead's reservation is ${reservation}.`,
        sendAtMost(reservation - 1)), limit: "reservation" });
    }
  } else if (total > grant.allowanceLeft) {
    errors.push({ ...error("over-ceiling", "phases",
      `The expanded request is ${total} steps; the run has ${grant.allowanceLeft} left.`,
      sendAtMost(grant.allowanceLeft)), limit: "allowance" });
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, total, phases, keys: Object.fromEntries(keyById) };
}

function error(code: ReadErrorCode, path: string, message: string, fix: string): ReadRequestError {
  return { code, path, message, fix };
}

function sendAtMost(room: number): string {
  return room > 0 ? `Send at most ${room} expanded steps.` : "No read step fits; continue with the evidence you have.";
}

type RequestIssue = z.ZodError["issues"][number];
const KEY = /^[A-Za-z][A-Za-z0-9]*$/;

/** Renders an issue path the way the rule paths are written; a root issue is at `request`. */
function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "request";
  return path.map((part, index) => (typeof part === "number" ? `[${part}]`
    : `${index === 0 ? "" : "."}${typeof part === "string" && KEY.test(part) ? part : "?"}`)).join("");
}

// Part 3's table puts too many phases or steps, and maxItems, concurrency or a lead's maxAttempts above
// its bound, under over-ceiling. Paths are written with # for an array index; the value says what the
// field must be for its size to count.
const CEILING_PATHS = new Map<string, "list" | "number">([["phases", "list"], ["phases.#.steps", "list"],
  ["phases.#.steps.#.forEach.maxItems", "number"], ["concurrency", "number"], ["phases.#.steps.#.lead.maxAttempts", "number"]]);

/**
 * A value of the wrong type gets one error. The schema library also reports a size issue for it (a
 * string where a list belongs has a length), which names nothing the member can fix.
 */
function ownIssues(issues: RequestIssue[]): RequestIssue[] {
  const wrongType = new Set(issues.filter(issue => issue.code === "invalid_type").map(issue => JSON.stringify(issue.path)));
  return issues.filter(issue => issue.code === "invalid_type" || !wrongType.has(JSON.stringify(issue.path)));
}

/**
 * A too-big list or number on its own CEILING_PATHS field is over-ceiling; every other parse issue is
 * malformed. The text names schema keys and bounds only, never a value taken from the request.
 */
function issueError(issue: RequestIssue): ReadRequestError {
  const path = issuePath(issue.path);
  const shape = issue.path.map(part => (typeof part === "number" ? "#" : String(part))).join(".");
  const key = issue.path.filter(part => typeof part === "string").at(-1);
  const name = typeof key === "string" && KEY.test(key) ? `\`${key}\`` : "the request";
  const subject = issue.path.length === 0 ? "the request" : typeof issue.path.at(-1) === "number" ? `an item of ${name}` : name;
  const sized = issue.code !== "too_big" ? undefined : issue.origin === "array" ? "list" : issue.origin === "number" || issue.origin === "int" ? "number" : undefined;
  const code = sized !== undefined && CEILING_PATHS.get(shape) === sized ? "over-ceiling" : "malformed";
  const [message, fix] = issueText(issue, subject);
  return error(code, path, message.charAt(0).toUpperCase() + message.slice(1), fix);
}

function issueText(issue: RequestIssue, subject: string): [string, string] {
  const plural = (count: number | bigint, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  switch (issue.code) {
    case "invalid_type":
      return issue.path.length === 0
        ? ["the read request is not an object.", "Send an object with kind, summary and phases."]
        : [`${subject} is missing or is not of type ${issue.expected}.`, `Send ${subject} with type ${issue.expected}.`];
    case "unrecognized_keys":
      return [`${subject} has a field the read request schema does not define.`, "Remove every field the schema does not list."];
    case "too_small": {
      const unit = issue.origin === "array" ? "item" : issue.origin === "string" ? "character" : "";
      return unit
        ? [`${subject} needs at least ${plural(issue.minimum, unit)}.`, `Give ${subject} at least ${plural(issue.minimum, unit)}.`]
        : [`${subject} is below ${issue.minimum}.`, `Set ${subject} to ${issue.minimum} or more.`];
    }
    case "too_big": {
      const unit = issue.origin === "array" ? "items" : issue.origin === "string" ? "characters" : "";
      return unit
        ? [`${subject} has more than ${issue.maximum} ${unit}.`, `Cut ${subject} to ${issue.maximum} ${unit} or fewer.`]
        : [`${subject} is above ${issue.maximum}.`, `Set ${subject} to ${issue.maximum} or less.`];
    }
    case "invalid_value":
      return [`${subject} is not an allowed value.`, `Use one of: ${issue.values.map(String).join(", ")}.`];
    case "invalid_format":
      return [`${subject} does not have the required format.`, issue.pattern ? `Match the pattern ${issue.pattern}.` : "Use the format the schema gives."];
    case "custom":
      return [`${subject} is not accepted.`, subject.endsWith("`refs`") ? "Use an https URL or evidence:N."
        : subject.endsWith("`paths`") ? "Use a repository-relative path without glob syntax." : "Check it against the read request schema."];
    default:
      return [`${subject} is not valid.`, "Check it against the read request schema."];
  }
}

/**
 * One line per error, then the sentence that tells the member a refusal is recoverable. The size of the
 * 409 body returned to a member is the host slice's decision.
 */
export function refusalText(errors: ReadRequestError[]): string {
  const lines = errors.map(item => `- ${item.path}: ${item.message} Fix: ${item.fix}`);
  return [
    ...lines,
    "The request was not recorded. This is not a denial: correct the request and report again in this same session.",
  ].join("\n");
}
