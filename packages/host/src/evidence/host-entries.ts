import { createHash } from "node:crypto";
import type { TeamDecision, TeamMember, TeamRun, TeamTask } from "../team-types.js";
import { canonicalJson } from "./crypto.js";
import type { HostEntry, HostEntryKind } from "./entry-types.js";

/** A summary is one line of at most this many UTF-8 bytes (spec part 3). */
export const ENTRY_SUMMARY_BYTES = 240;

type EntryFields = Omit<HostEntry, "entryId" | "kind" | "runId" | "missionId">;

const SOURCE = /^(steering|answer|report|integration|check):(.+)$/;
const INDEX = /^(0|[1-9]\d{0,5})$/;

/**
 * The source keys the run record holds, in record order: steering, owner answers, reports, integrations,
 * then finished checks. A key holds only a host-issued UUID or a list index. Pure, and never mutates `run`.
 */
export function hostEntrySources(run: TeamRun): string[] {
  return [
    ...steeringIndexes(run).map(index => `steering:${index}`),
    ...answeredDecisions(run).map(decision => `answer:${decision.id}`),
    ...reportingMembers(run).map(member => `report:${member.memberId}`),
    ...integratedTasks(run).map(item => `integration:${item.memberId}`),
    ...checkIndexes(run).map(index => `check:${index}`),
  ];
}

/** The entry one source names, or undefined when the record does not hold it. Pure, and never mutates `run`. */
export function hostEntry(run: TeamRun, source: string, now: string): HostEntry | undefined {
  const match = typeof source === "string" ? SOURCE.exec(source) : null;
  if (!match) return undefined;
  const id = match[2];
  switch (match[1]) {
    case "steering": return steeringEntry(run, id, now);
    case "answer": return answerEntry(run, id, now);
    case "report": return reportEntry(run, id, now);
    case "integration": return integrationEntry(run, id, now);
    case "check": return checkEntry(run, id, now);
    default: return undefined;
  }
}

/** UUIDv8 of SHA-256("infinite-host-entry:v1" + NUL + canonical JSON of run, kind, and source). Never covers a task id. */
export function hostEntryId(runId: string, kind: HostEntryKind, source: string): string {
  const bytes = createHash("sha256")
    .update("infinite-host-entry:v1\0", "utf8")
    .update(canonicalJson({ runId, kind, source }), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One line with control characters and line breaks turned into spaces and white space collapsed. Cut at
 * ENTRY_SUMMARY_BYTES on a code point. The fallback is used when the text is empty after cleaning.
 */
export function entrySummary(text: string, fallback: string): string {
  const cleaned = flatten(text);
  return cut(cleaned.length > 0 ? cleaned : flatten(fallback), ENTRY_SUMMARY_BYTES);
}

function steeringIndexes(run: TeamRun): number[] {
  if (run.missionId !== undefined) return [];
  return list(run.steering).map((_, index) => index);
}

function answeredDecisions(run: TeamRun): TeamDecision[] {
  return list(run.decisions).filter(decision => decision.answer !== undefined && decision.answeredBy === "owner");
}

function reportingMembers(run: TeamRun): TeamMember[] {
  return list(run.members).filter(member => member.report !== undefined && member.role !== "permission-coordinator");
}

/** Continuation tasks, then the run's own tasks. The first integrated task of each member wins. */
function integratedTasks(run: TeamRun): { task: TeamTask; memberId: string }[] {
  const seen = new Set<string>();
  const found: { task: TeamTask; memberId: string }[] = [];
  const tasks = [...list(run.continuations).flatMap(continuation => list(continuation.tasks)), ...list(run.tasks)];
  for (const task of tasks) {
    if (task.status !== "integrated" || typeof task.memberId !== "string" || seen.has(task.memberId)) continue;
    seen.add(task.memberId);
    found.push({ task, memberId: task.memberId });
  }
  return found;
}

/** Finished checks only. A running check has no output yet and gets an entry when it finishes. */
function checkIndexes(run: TeamRun): number[] {
  return list(run.checks).flatMap((check, index) => (check.status === "running" ? [] : [index]));
}

function steeringEntry(run: TeamRun, id: string, now: string): HostEntry | undefined {
  const index = indexOf(id);
  if (index === undefined || !steeringIndexes(run).includes(index)) return undefined;
  const item = run.steering[index];
  return build(run, "direction", `steering:${index}`, {
    author: "owner",
    authority: "direction",
    revision: item.revision,
    at: item.at ?? now,
    summary: entrySummary(`owner steering: ${item.text}`, "owner steering"),
    body: { source: "steering", text: item.text },
  });
}

function answerEntry(run: TeamRun, id: string, now: string): HostEntry | undefined {
  const decision = answeredDecisions(run).find(item => item.id === id);
  if (!decision) return undefined;
  const answer = decision.answer ?? "";
  return build(run, "direction", `answer:${decision.id}`, {
    author: "owner",
    authority: "direction",
    revision: decision.revision,
    at: decision.answeredAt ?? now,
    summary: entrySummary(`owner answer: ${answer}`, "owner answer"),
    body: { source: "answer", question: decision.question, text: answer },
  });
}

function reportEntry(run: TeamRun, id: string, now: string): HostEntry | undefined {
  const member = reportingMembers(run).find(item => item.memberId === id);
  if (!member || member.report === undefined) return undefined;
  const report = withoutRubric(member.report);
  const kind = String(report.kind);
  const text = firstText(report, ["summary", "question", "reason"]);
  return build(run, "report", `report:${member.memberId}`, {
    author: "member",
    authority: "claim",
    revision: member.revision,
    at: member.reportedAt ?? now,
    authorMemberId: member.memberId,
    authorRole: member.role,
    ...(member.taskId === undefined ? {} : { taskId: member.taskId }),
    summary: entrySummary(`${kind}: ${text}`, kind),
    body: {
      memberId: member.memberId,
      role: member.role,
      revision: member.revision,
      ...(member.taskId === undefined ? {} : { taskId: member.taskId }),
      baseCommit: member.baseCommit,
      report,
    },
  });
}

function integrationEntry(run: TeamRun, id: string, now: string): HostEntry | undefined {
  const found = integratedTasks(run).find(item => item.memberId === id);
  if (!found) return undefined;
  const { task } = found;
  const commit = task.commit;
  const changed = task.changedPaths;
  return build(run, "integration", `integration:${id}`, {
    author: "host",
    authority: "receipt",
    revision: task.revision ?? run.revision,
    at: now,
    taskId: task.id,
    summary: entrySummary(
      commit === undefined
        ? `task ${task.id} integrated with no change`
        : `task ${task.id} integrated at ${commit.slice(0, 12)}`,
      "integration",
    ),
    body: {
      taskId: task.id,
      ...(commit === undefined ? {} : { commit }),
      ...(changed === undefined ? {} : { changedPaths: { paths: [...changed.paths], truncated: changed.truncated } }),
    },
  });
}

function checkEntry(run: TeamRun, id: string, now: string): HostEntry | undefined {
  const index = indexOf(id);
  if (index === undefined || !checkIndexes(run).includes(index)) return undefined;
  const check = run.checks[index];
  const args = [...(check.command.args ?? [])];
  const exitCode = check.exitCode ?? null;
  const label = check.phase === "setup" ? "setup" : "check";
  return build(run, "check", `check:${index}`, {
    author: "host",
    authority: "receipt",
    revision: check.revision,
    at: check.finishedAt ?? check.startedAt ?? now,
    summary: entrySummary(
      `${label} ${check.status} (exit ${exitCode ?? "none"}): ${[check.command.command, ...args].join(" ")}`,
      label,
    ),
    body: {
      command: { command: check.command.command, args },
      ...(check.phase === undefined ? {} : { phase: check.phase }),
      status: check.status,
      exitCode,
      ...(check.round === undefined ? {} : { round: check.round }),
      ...(check.headCommit === undefined ? {} : { headCommit: check.headCommit }),
      output: check.output,
    },
  });
}

function build(run: TeamRun, kind: HostEntryKind, source: string, fields: EntryFields): HostEntry {
  return {
    entryId: hostEntryId(run.id, kind, source),
    kind,
    runId: run.id,
    ...(run.missionId === undefined ? {} : { missionId: run.missionId }),
    ...fields,
  };
}

/** A review report keeps its verdict and summary, and loses its rubric for every reader (C9 rule 3). */
function withoutRubric(report: object): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...report };
  delete copy.rubric;
  return copy;
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function indexOf(id: string): number | undefined {
  return INDEX.test(id) ? Number(id) : undefined;
}

function list<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function flatten(value: string): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function cut(value: string, limit: number): string {
  let bytes = 0;
  let out = "";
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > limit) break;
    bytes += size;
    out += char;
  }
  return out.trimEnd();
}
