import { commandDigest } from "./objective-input.js";
import type { Check, Criterion, ObjectiveRecord } from "./objective-types.js";
import type { Project } from "./types.js";
import { RECORD_LABEL_BYTES } from "./team-types.js";
import type { RecordDigest, TeamCommand } from "./team-types.js";

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
