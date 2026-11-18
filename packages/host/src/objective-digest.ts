import { commandDigest } from "./objective-input.js";
import { autonomyOf, type AutonomyMode } from "./autonomy.js";
import type { Assumption, Check, Criterion, ObjectiveRecord } from "./objective-types.js";
import type { Project } from "./types.js";
import { RECORD_LABEL_BYTES, RECORD_REGISTER_BYTES, registerDigestBytes } from "./team-types.js";
import type { RecordDigest, RegisterDigest, TeamCommand, TeamRun } from "./team-types.js";

/** True only when `team.objective.prompts` is "on". */
export function objectivePromptsOn(project: Pick<Project, "team"> | undefined): boolean {
  return project?.team?.objective?.prompts === "on";
}

/** `kind:detail`, at most RECORD_LABEL_BYTES bytes, with each control character replaced by a space. */
export function checkLabel(check: Check, configured: readonly TeamCommand[]): string {
  return bounded(plain(labelOf(check, configured)));
}

/**
 * The active criteria, c0 first with an empty statement, in record order. The result passes recordDigestSchema
 * except for the byte cap, which the writer and `prepare` check.
 */
export function recordDigestFor(record: ObjectiveRecord, configured: readonly TeamCommand[]): RecordDigest {
  const active = record.criteria.filter(item => item.state === "active");
  const ordered = [...active.filter(item => item.id === "c0"), ...active.filter(item => item.id !== "c0")];
  return {
    version: record.version,
    criteria: ordered.map((item: Criterion) => ({
      id: item.id,
      statement: item.id === "c0" ? "" : item.statement,
      check: checkLabel(item.check, configured),
      producer: item.producer,
      // Only a derived criterion carries the marker, so a record without one keeps today's bytes.
      ...(item.origin === "derived" ? { derived: true as const } : {}),
    })),
  };
}

function labelOf(check: Check, configured: readonly TeamCommand[]): string {
  switch (check.kind) {
    case "command": {
      const match = configured.find(command => commandDigest(command) === check.command);
      return match ? `command:${[match.command, ...match.args].join(" ")}` : `command:${check.command.slice(0, 12)} (not configured)`;
    }
    case "receipt": return `receipt:${check.receipt}`;
    case "artifact": return `artifact:${check.path}`;
    case "citations":
    case "citation-form": return `${check.kind}:${check.path}`;
    case "judgement": return `judgement:${check.item}`;
    case "owner-rating": return `owner-rating:${check.subject}`;
  }
}

/**
 * Replaces each C0 and C1 control character, and the line and paragraph separators, with a space, so a label stays
 * one line. The set matches the CLI's `clean` (objective-cli.ts).
 */
function plain(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}

/** Cuts at a character boundary so that the label, with its three dots, fits RECORD_LABEL_BYTES. */
function bounded(text: string): string {
  if (Buffer.byteLength(text) <= RECORD_LABEL_BYTES) return text;
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > RECORD_LABEL_BYTES - 3) break;
    out += char;
    bytes += size;
  }
  return `${out}...`;
}

/** True only when `team.objective.register` is "on". */
export function objectiveRegisterOn(project: Pick<Project, "team"> | undefined): boolean {
  return project?.team?.objective?.register === "on";
}

/** The run pin: true only for setting "on" on a run that is neither a mission subteam nor a handoff run. */
export function registerPin(input: { setting?: "on" | "off"; mission: boolean; handoff: boolean }): boolean {
  return input.setting === "on" && !input.mission && !input.handoff;
}

const STATUS_RANK: Record<Assumption["status"], number> = { refuted: 0, unchecked: 1, assumed: 2, verified: 3 };
const CRITICALITY_RANK: Record<Assumption["criticality"], number> = { outcome: 0, plan: 1, detail: 2 };
const idNumber = (id: string): number => Number(id.match(/\d+$/)?.[0] ?? 0);

/**
 * Intent-check and owner assumptions, by status, criticality, and id number, then open questions in record order.
 * Each item enters whole or not at all: the first that would pass RECORD_REGISTER_BYTES, or the caps of 32 assumptions
 * and 8 questions, stops the list, and `omitted` counts every item left out. Member assumptions never enter and are
 * not counted.
 */
export function registerDigestFor(record: ObjectiveRecord): RegisterDigest {
  const assumptions = record.assumptions.filter(item => item.origin !== "member")
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || CRITICALITY_RANK[a.criticality] - CRITICALITY_RANK[b.criticality] || idNumber(a.id) - idNumber(b.id))
    .map(item => ({ id: item.id, status: item.status, criticality: item.criticality, statement: item.statement }));
  const questions = record.questions.filter(item => item.state === "open").map(item => ({ id: item.id, text: item.text }));
  const register: RegisterDigest = { assumptions: [], questions: [] };
  let stopped = false;
  let omitted = 0;
  for (const item of assumptions) {
    const next = { ...register, assumptions: [...register.assumptions, item] };
    if (!stopped && next.assumptions.length <= 32 && registerDigestBytes(next) <= RECORD_REGISTER_BYTES) register.assumptions.push(item);
    else { stopped = true; omitted += 1; }
  }
  for (const item of questions) {
    const next = { ...register, questions: [...register.questions, item] };
    if (!stopped && next.questions.length <= 8 && registerDigestBytes(next) <= RECORD_REGISTER_BYTES) register.questions.push(item);
    else { stopped = true; omitted += 1; }
  }
  return omitted > 0 ? { ...register, omitted } : register;
}

/** false: no record digest. true: a criteria digest without a register. "register" or "register-autonomous": with one. */
export type ObjectivePrompt = boolean | "register" | "register-autonomous";

/** A live run's prompt shape: false without a record digest; true with a digest without a register; else by the run's pinned mode. */
export function objectivePromptOf(run: Pick<TeamRun, "goal" | "autonomy">): ObjectivePrompt {
  const digest = run.goal?.record;
  if (!digest) return false;
  if (!digest.register) return true;
  return autonomyOf(run) === "autonomous" ? "register-autonomous" : "register";
}

/** The shape a new run of `project` would render in `mode`: false with prompts off; true with the register off; else by `mode`. */
export function objectivePromptFor(project: Pick<Project, "team"> | undefined, mode: AutonomyMode): ObjectivePrompt {
  if (!objectivePromptsOn(project)) return false;
  if (!objectiveRegisterOn(project)) return true;
  return mode === "autonomous" ? "register-autonomous" : "register";
}
