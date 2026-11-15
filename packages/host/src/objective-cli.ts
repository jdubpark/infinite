import type { ObjectiveRecordView } from "./objective-record.js";

type GoalApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
type Options = Record<string, string | boolean>;

export const GOAL_RECORD_USAGE = "Usage: infinite goal record ID [--version N] [--json]";
const VERSION = /^[1-9][0-9]{0,5}$/;
// Every printed text passes through this one function. The record bounds each text; nothing is cut here.
const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

function faultOf(error: unknown): { status?: unknown; code?: unknown } {
  return typeof error === "object" && error !== null ? error as { status?: unknown; code?: unknown } : {};
}

// The client's HttpError carries the status and the code, never the host's message, so each reason has a fixed sentence.
function readFailure(error: unknown, version: string | undefined): Error | undefined {
  const { status, code } = faultOf(error);
  if (status === 404 && code === "goal-not-found") return new Error("No goal has this ID.");
  if (status === 404 && code === "objective-version-not-found") return new Error(`The record has no version ${version}.`);
  if (status === 409 && code === "objective-version-unavailable") return new Error(`This host cannot rebuild version ${version} of the record.`);
  if (status === 409 && code === "objective-source-invalid") return new Error("This goal's fields do not fit an objective record. The goal works as before, without one.");
  if (status === 409 && code === "objective-record-invalid") return new Error("The stored objective record cannot be read. The host keeps it unchanged.");
  if (status === 409 && code === "objective-record-newer") return new Error("A newer host wrote this objective record. Upgrade the host to read it.");
  if (status === 404 && code === "objective-record-absent") return new Error("This goal has no objective record yet.");
  if (status === 400) return new Error("The host refused the record query.");
  if (status === 404) return new Error("This host has no objective records. Upgrade the host.");
  return undefined;
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

export async function handleGoalClientCommand(positional: string[], options: Options, api: GoalApi): Promise<boolean> {
  const [verb, goalId, extra] = positional;
  if (verb !== "record" || !goalId || positional.length !== 2 || extra !== undefined) throw new Error(GOAL_RECORD_USAGE);
  const requested = options["--version"];
  // Checked before the first request, so a typo never reads the record.
  if (requested !== undefined && (typeof requested !== "string" || !VERSION.test(requested))) throw new Error("Give --version as a whole number of 1 or more.");
  const version = typeof requested === "string" ? requested : undefined;
  const path = `/goals/${encodeURIComponent(goalId)}/record${version === undefined ? "" : `?version=${version}`}`;
  let view: ObjectiveRecordView;
  try { view = await api.json<ObjectiveRecordView>(path); }
  catch (error) {
    const failure = readFailure(error, version);
    if (failure) throw failure;
    throw error;
  }
  if (options["--json"] === true) { console.log(JSON.stringify(view, null, 2)); return true; }
  for (const line of objectiveRecordLines(view, goalId)) console.log(line);
  return true;
}
