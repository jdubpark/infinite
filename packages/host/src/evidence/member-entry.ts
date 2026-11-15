import { createHash } from "node:crypto";
import { z } from "zod";
import type { TeamAssignment, TeamMember, TeamRole, TeamRun, TeamTask } from "../team-types.js";
import { ownedPathSchema, taskIdSchema, teamEvidenceSchema } from "../team-types.js";
import { canonicalJson } from "./crypto.js";
import { ENTRY_KINDS } from "./entry-types.js";
import type { MemberEntryKind } from "./entry-types.js";
export { ENTRY_ROLES, entryToolsFor } from "../entry-roles.js";

/** Which member kinds each role may post (spec part 4). */
export const ROLE_KINDS: Readonly<Record<"project-manager" | "scout" | "implementer" | "integrator" | "reviewer", readonly MemberEntryKind[]>> = {
  "project-manager": ["contract", "blocker"],
  scout: ["finding", "blocker"],
  implementer: ["contract", "finding", "blocker", "handoff"],
  integrator: ["contract", "finding", "blocker", "handoff"],
  reviewer: ["finding", "blocker"],
};

export const MAX_ENTRY_SUMMARY_BYTES = 240;
export const MAX_ENTRY_BODY_BYTES = 12 * 1024;
export const MAX_ENTRY_REQUEST_BYTES = 16 * 1024;
export const MAX_ENTRY_PATHS = 16;
export const MAX_ENTRY_PATH_BYTES = 1024;

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A trimmed, non-empty string of at most `max` characters. */
const text = (max: number) => z.string().trim().min(1).max(max);
const idString = z.string().min(1).max(200);
const uuid = z.uuid();

/** A summary: no control character, trimmed, at most 240 bytes as JSON string content (escapes count). */
const summarySchema = z.string()
  .refine(value => !CONTROL.test(value), "Use no control character")
  .transform(value => value.trim())
  .pipe(z.string().min(1).refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") - 2 <= MAX_ENTRY_SUMMARY_BYTES, "Use at most 240 bytes"));

/** The paths: no control character, and at most 1,024 bytes as a JSON array (escapes count). */
const pathsSchema = z.array(ownedPathSchema).max(MAX_ENTRY_PATHS).default([])
  .refine(paths => paths.every(path => !CONTROL.test(path)), "Use no control character")
  .refine(paths => Buffer.byteLength(JSON.stringify(paths), "utf8") <= MAX_ENTRY_PATH_BYTES, "Use at most 1024 path bytes");

const contractBody = z.object({
  interface: text(2000),
  change: text(4000),
  sources: z.array(text(500)).max(8).default([]),
}).strict();

const findingBody = z.object({
  items: z.array(teamEvidenceSchema).min(1).max(8),
}).strict();

const blockerBody = z.object({
  cause: z.object({ status: z.enum(["observed", "hypothesis", "unknown"]), detail: text(1200) }).strict(),
  issueRefs: z.array(text(300)).max(8).default([]),
  sourceRefs: z.array(text(500)).max(12).default([]),
  attemptedFixes: z.array(z.object({ fix: text(800), outcome: text(800) }).strict()).max(8).default([]),
  proposedRecovery: text(1200),
  prevention: text(1200),
  validationEvidence: z.array(z.object({ sourceRef: text(500), observation: text(1000) }).strict()).min(1).max(8),
}).strict();

const handoffBody = z.object({
  done: z.array(text(500)).max(12).default([]),
  remaining: z.array(text(500)).max(12).default([]),
  notes: text(4000).optional(),
  commands: z.array(text(300)).max(8).default([]),
}).strict();

const common = { summary: summarySchema, paths: pathsSchema, taskId: taskIdSchema.optional() };

/** A member's post. Each kind has its own strict shape. The canonical body is at most 12 KiB. */
export const memberEntryPostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contract"), ...common, supersedes: uuid.optional(), body: contractBody }).strict(),
  z.object({ kind: z.literal("finding"), ...common, supersedes: uuid.optional(), body: findingBody }).strict(),
  z.object({ kind: z.literal("blocker"), ...common, supersedes: uuid.optional(), body: blockerBody }).strict(),
  z.object({ kind: z.literal("handoff"), ...common, taskId: taskIdSchema, body: handoffBody }).strict(),
]).refine(entry => Buffer.byteLength(canonicalJson(entry.body), "utf8") <= MAX_ENTRY_BODY_BYTES, "Use a body of at most 12 KiB");
export type MemberEntryPost = z.infer<typeof memberEntryPostSchema>;

/** A member's list query. Every field is optional, and a kinds list has no repeats. */
export const memberListQuerySchema = z.object({
  kinds: z.array(z.enum(ENTRY_KINDS)).min(1).max(8)
    .refine(kinds => new Set(kinds).size === kinds.length, "Use each kind once")
    .optional(),
  taskId: taskIdSchema.optional(),
  path: ownedPathSchema.optional(),
  since: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

const binding = { runId: idString, memberId: idString, revision: z.number().int().min(0) };

/** The worker's request envelope. Every operation carries the binding. */
export const memberEntryEnvelopeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("post"), ...binding, requestId: uuid, entry: memberEntryPostSchema }).strict(),
  z.object({ op: z.literal("list"), ...binding, query: memberListQuerySchema.optional() }).strict(),
  z.object({ op: z.literal("get"), ...binding, entryId: uuid }).strict(),
]);
export type MemberEntryEnvelope = z.infer<typeof memberEntryEnvelopeSchema>;

export type EntryBinding = { runId: string; memberId: string; revision: number };

/** A UUIDv8 of SHA-256 over the domain and the canonical binding and entry. Same bit layout as `reportIdentity`. */
export function memberEntryId(entryBinding: EntryBinding, entry: MemberEntryPost): string {
  const bytes = createHash("sha256")
    .update("infinite-member-entry:v1\0", "utf8")
    .update(canonicalJson({ runId: entryBinding.runId, memberId: entryBinding.memberId, revision: entryBinding.revision, entry }), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether the assignment may post this entry, by role and kind, then by task. */
export function postAllowed(
  assignment: Pick<TeamAssignment, "role" | "taskId">,
  entry: MemberEntryPost,
): "ok" | "entry-kind-forbidden" | "entry-task-forbidden" {
  const kinds: readonly MemberEntryKind[] = (ROLE_KINDS as Readonly<Record<string, readonly MemberEntryKind[]>>)[assignment.role] ?? [];
  if (!kinds.includes(entry.kind)) return "entry-kind-forbidden";
  // Only an implementer or an integrator names a task. A scout's assignment id is a discovery id, not a task.
  const namesTask = assignment.role === "implementer" || assignment.role === "integrator";
  if (entry.taskId !== undefined && (!namesTask || entry.taskId !== assignment.taskId)) return "entry-task-forbidden";
  if (entry.kind === "handoff" && assignment.taskId === undefined) return "entry-task-forbidden";
  return "ok";
}

export type MemberScope = {
  runId: string;
  memberId: string;
  role: TeamRole;
  launchSeq: number;
  taskId?: string;
  paths: string[];
  dependsOn: string[];
};

/** Task, owned paths, and dependencies from `run.tasks`. A member without a known task has none. */
export function memberScopeOf(run: TeamRun, member: TeamMember, launchSeq: number): MemberScope {
  const task: TeamTask | undefined = member.taskId ? run.tasks.find(candidate => candidate.id === member.taskId) : undefined;
  return {
    runId: run.id,
    memberId: member.memberId,
    role: member.role,
    launchSeq,
    ...(task ? { taskId: task.id } : {}),
    paths: task?.paths ?? [],
    dependsOn: task?.dependsOn ?? [],
  };
}

/** Schema field names that a refusal path may show. Any other key becomes `?`. */
const FIELD_NAMES: ReadonlySet<string> = new Set([
  "entry", "body", "kind", "summary", "paths", "taskId", "supersedes", "items", "source", "observation",
  "interface", "change", "sources", "cause", "status", "detail", "issueRefs", "sourceRefs", "attemptedFixes",
  "fix", "outcome", "proposedRecovery", "prevention", "validationEvidence", "sourceRef", "done", "remaining",
  "notes", "commands", "op", "runId", "memberId", "revision", "requestId", "query", "kinds", "path", "since",
  "limit", "entryId",
]);

/** A zod issue path as `entry.body.items.0.source`: indexes and schema field names only. */
export function refusalPath(path: readonly PropertyKey[]): string {
  return path.map(segment => {
    if (typeof segment === "number") return String(segment);
    if (typeof segment === "string" && FIELD_NAMES.has(segment)) return segment;
    return "?";
  }).join(".");
}
