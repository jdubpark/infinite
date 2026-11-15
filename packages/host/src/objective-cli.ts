import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { correctionSchema } from "./objective-input.js";
import type { Correction, CorrectionOp } from "./objective-input.js";
import { OBJECTIVE_ERRORS } from "./objective-record.js";
import type { ObjectiveErrorCode, ObjectiveRecordView } from "./objective-record.js";

type GoalApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;

export const GOAL_RECORD_USAGE = [
  "Usage: infinite goal record ID [--version N] [--json]",
  "       infinite goal record ID retire CID|confirm CID [--version N] [--request-id ID] [--json]",
  "       infinite goal record ID apply --file PATH [--version N] [--request-id ID] [--json]",
].join("\n");
/** A correction file is read whole, so it is capped before it is read. */
export const CORRECTION_FILE_BYTES = 64 * 1024;
const VERSION = /^[1-9][0-9]{0,5}$/;
const UUID = z.uuid();
// The body of a file is checked with this ID and version, which only the request body later fills in.
const PLACEHOLDER_REQUEST_ID = "00000000-0000-4000-8000-000000000000";
// Every printed text passes through this one function. The record bounds each text; nothing is cut here.
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");

function faultOf(error: unknown): { status?: unknown; code?: unknown } {
  return typeof error === "object" && error !== null ? error as { status?: unknown; code?: unknown } : {};
}

// The goal's sentences for the four record-state codes. Reads and corrections both use them, so they are written once.
function recordStateFailure(status: unknown, code: unknown): Error | undefined {
  if (status === 409 && code === "objective-source-invalid") return new Error("This goal's fields do not fit an objective record. The goal works as before, without one.");
  if (status === 409 && code === "objective-record-invalid") return new Error("The stored objective record cannot be read. The host keeps it unchanged.");
  if (status === 409 && code === "objective-record-newer") return new Error("A newer host wrote this objective record. Upgrade the host to read it.");
  if (status === 404 && code === "objective-record-absent") return new Error("This goal has no objective record yet.");
  return undefined;
}

// The client's HttpError carries the status and the code, never the host's message, so each reason has a fixed sentence.
function readFailure(error: unknown, version: string | undefined): Error | undefined {
  const { status, code } = faultOf(error);
  if (status === 404 && code === "goal-not-found") return new Error("No goal has this ID.");
  if (status === 404 && code === "objective-version-not-found") return new Error(`The record has no version ${version}.`);
  if (status === 409 && code === "objective-version-unavailable") return new Error(`This host cannot rebuild version ${version} of the record.`);
  const state = recordStateFailure(status, code);
  if (state) return state;
  if (status === 400) return new Error("The host refused the record query.");
  if (status === 404) return new Error("This host has no objective records. Upgrade the host.");
  return undefined;
}

/**
 * A failed correction. A reply with a status and a known code gets that code's fixed sentence. A post that got no
 * reply, or a server error, may have been applied, so the sentence names the retry with the same version and request ID.
 */
function correctionFailure(error: unknown, retry: string): Error {
  const { status, code } = faultOf(error);
  if (status === undefined || (typeof status === "number" && status >= 500)) {
    return new Error(`The correction may have been applied. Retry it safely with: ${clean(retry)}`);
  }
  if (status === 403) return new Error("Corrections need an owner device key.");
  if (status === 409 && code === "request-conflict") return new Error("This request ID was used for another correction. Leave out --request-id to send a new one.");
  const state = recordStateFailure(status, code);
  if (state) return state;
  if (typeof code === "string" && Object.hasOwn(OBJECTIVE_ERRORS, code)) return new Error(OBJECTIVE_ERRORS[code as ObjectiveErrorCode].message);
  if (status === 404 && code === "goal-not-found") return new Error("No goal has this ID.");
  // An older host has no correction route, so its answer carries no code.
  if (status === 404 && code === undefined) return new Error("This host does not accept corrections. Upgrade the host.");
  return new Error("The host refused the correction.");
}

const short = (hash: string) => hash.slice(0, 12);
const list = (values: string[]) => values.length ? values.join(", ") : "none";

function checkText(check: ObjectiveRecordView["record"]["criteria"][number]["check"]): string {
  switch (check.kind) {
    case "judgement": return `judgement ${check.item}`;
    case "command": return `command ${short(check.command)}`;
    case "receipt": return `receipt ${check.receipt}`;
    case "artifact": return check.count === undefined ? `artifact ${check.path}` : `artifact ${check.path} count ${check.count}`;
    case "citations": case "citation-form": return `${check.kind} ${check.path}`;
    case "owner-rating": return `owner rating ${check.subject}`;
  }
}

function thresholdText(threshold: ObjectiveRecordView["record"]["criteria"][number]["threshold"]): string {
  switch (threshold.kind) {
    case "pass": return "pass";
    case "count":
      if (threshold.min !== undefined && threshold.max !== undefined) return `count ${threshold.min} to ${threshold.max}`;
      return threshold.min !== undefined ? `count at least ${threshold.min}` : `count at most ${threshold.max}`;
    case "share": return `share at least ${threshold.min}`;
    case "score": return `score at least ${threshold.min} of ${threshold.of}`;
  }
}

/** The text lines of `infinite goal record`. No line shows a log value. */
export function objectiveRecordLines(view: ObjectiveRecordView, goalId: string): string[] {
  const { record } = view;
  const lines = [
    `Goal ${goalId} · record version ${view.version} of ${view.latestVersion}${view.rebuilt ? " · rebuilt" : ""} · digest ${short(record.digest)}`,
    `Objective: ${record.statement.objective}`,
    "Criteria:",
    ...record.criteria.map(criterion => {
      const statement = criterion.statementOf === "objective" ? "(the objective)" : criterion.statement;
      return `  ${criterion.id} ${criterion.origin} ${criterion.state} · ${checkText(criterion.check)} · ${criterion.producer} · ${thresholdText(criterion.threshold)}: ${statement}`;
    }),
  ];
  const directions = record.statement.directions;
  lines.push(directions.length ? "Directions:" : "Directions: none");
  for (const direction of directions) lines.push(`  ${direction.id} ${direction.source} at ${direction.at}: ${direction.text}`);
  lines.push(record.nonGoals.length ? "Non-goals:" : "Non-goals: none");
  for (const nonGoal of record.nonGoals) lines.push(`  ${nonGoal.id}: ${nonGoal.text}`);
  lines.push(`Allowed paths: ${list(record.constraints.allowedPaths)}`);
  lines.push(`Excluded paths: ${list(record.constraints.excludedPaths)}`);
  lines.push(record.ownerEvidence.length ? "Owner evidence:" : "Owner evidence: none");
  for (const evidence of record.ownerEvidence) lines.push(`  - ${evidence}`);
  const open = record.questions.filter(question => question.state === "open").length;
  lines.push(`Definitions ${record.definitions.length} · rules ${record.constraints.rules.length} · assumptions ${record.assumptions.length} · open questions ${open} of ${record.questions.length}`);
  lines.push("Log:");
  for (const entry of view.log) lines.push(`  #${entry.seq} v ${entry.version} ${entry.at} ${entry.actor} ${entry.authority} ${entry.op} ${entry.target}`);
  return lines.map(clean);
}

/**
 * Reads a correction file `{ "ops": [...] }` and checks every op with the host's schema before any request.
 * Errors name the op's index, never its text: a zod message for an unknown key names the key.
 */
export function readCorrectionFile(path: string): CorrectionOp[] {
  let size = 0;
  let text = "";
  try {
    size = statSync(path).size;
    if (size <= CORRECTION_FILE_BYTES) text = readFileSync(path, "utf8");
  } catch {
    throw new Error("The correction file cannot be read. Nothing was sent.");
  }
  if (size > CORRECTION_FILE_BYTES) throw new Error("The correction file is over 64 KiB. Nothing was sent.");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("The correction file is not JSON. Nothing was sent."); }
  const ops = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { ops?: unknown }).ops) ? (parsed as { ops: unknown[] }).ops : undefined;
  if (ops === undefined) throw new Error("The correction file needs an ops array. Nothing was sent.");
  const checked = correctionSchema.safeParse({ requestId: PLACEHOLDER_REQUEST_ID, version: 1, ops });
  if (checked.success) return checked.data.ops;
  const [head, index] = checked.error.issues[0].path;
  if (head === "ops" && typeof index === "number") throw new Error(`Correction op ${index} is invalid. Nothing was sent.`);
  throw new Error("The correction file is invalid. Nothing was sent.");
}

type Form =
  | { kind: "read" }
  | { kind: "op"; verb: "retire" | "confirm"; id: string }
  | { kind: "apply" };

/** The three forms of `infinite goal record`. Anything else is a usage error, checked before any request. */
function formOf(positional: string[]): Form {
  const [verb, goalId, form, target, ...rest] = positional;
  if (verb !== "record" || !goalId || rest.length > 0) throw new Error(GOAL_RECORD_USAGE);
  if (positional.length === 2) return { kind: "read" };
  if (positional.length === 3 && form === "apply") return { kind: "apply" };
  if (positional.length === 4 && (form === "retire" || form === "confirm") && target !== undefined) return { kind: "op", verb: form, id: target };
  throw new Error(GOAL_RECORD_USAGE);
}

async function readView(api: GoalApi, goalId: string, version: string | undefined): Promise<ObjectiveRecordView> {
  const path = `/goals/${encodeURIComponent(goalId)}/record${version === undefined ? "" : `?version=${version}`}`;
  try { return await api.json<ObjectiveRecordView>(path); }
  catch (error) {
    const failure = readFailure(error, version);
    if (failure) throw failure;
    throw error;
  }
}

export async function handleGoalClientCommand(positional: string[], options: Options, api: GoalApi): Promise<boolean> {
  const form = formOf(positional);
  const goalId = positional[1];
  const requested = options["--version"];
  // Every check runs before the first request, so a typo never reads the record.
  if (requested !== undefined && (typeof requested !== "string" || !VERSION.test(requested))) throw new Error("Give --version as a whole number of 1 or more.");
  const version = typeof requested === "string" ? requested : undefined;
  if (form.kind === "read") {
    if (options["--request-id"] !== undefined || options["--file"] !== undefined) throw new Error(GOAL_RECORD_USAGE);
    const view = await readView(api, goalId, version);
    if (options["--json"] === true) { console.log(JSON.stringify(view, null, 2)); return true; }
    for (const line of objectiveRecordLines(view, goalId)) console.log(line);
    return true;
  }

  const requestedId = options["--request-id"];
  if (requestedId !== undefined && (typeof requestedId !== "string" || !UUID.safeParse(requestedId).success)) throw new Error("Give --request-id as a UUID.");
  const requestId = typeof requestedId === "string" ? requestedId : randomUUID();
  const file = options["--file"];
  if (form.kind !== "apply" && file !== undefined) throw new Error(GOAL_RECORD_USAGE);
  if (form.kind === "apply" && typeof file !== "string") throw new Error(GOAL_RECORD_USAGE);
  let ops: CorrectionOp[];
  let formText: string;
  if (form.kind === "apply") {
    ops = readCorrectionFile(file as string);
    formText = `apply --file ${file}`;
  } else {
    const single = { op: form.verb === "retire" ? "criterion.retire" as const : "criterion.confirm" as const, id: form.id };
    if (!correctionSchema.safeParse({ requestId, version: 1, ops: [single] }).success) throw new Error(OBJECTIVE_ERRORS["objective-op-invalid"].message);
    ops = [single];
    formText = `${form.verb} ${form.id}`;
  }

  // The version the correction applies to: the one named, or the latest one read now.
  const target = version !== undefined ? Number(version) : (await readView(api, goalId, undefined)).latestVersion;
  const retry = `infinite goal record ${goalId} ${formText} --version ${target} --request-id ${requestId}`;
  const body: Correction = { requestId, version: target, ops };
  let view: ObjectiveRecordView;
  try { view = await api.json<ObjectiveRecordView>(`/goals/${encodeURIComponent(goalId)}/record`, body, undefined, undefined, "POST"); }
  catch (error) { throw correctionFailure(error, retry); }
  if (options["--json"] === true) { console.log(JSON.stringify(view, null, 2)); return true; }
  console.log(`Record version ${view.latestVersion}.`);
  for (const line of objectiveRecordLines(view, goalId)) console.log(line);
  return true;
}
