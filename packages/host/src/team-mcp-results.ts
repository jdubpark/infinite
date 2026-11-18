import { z } from "zod";
import { ENTRY_KINDS, type MemberHead } from "./evidence/entry-types.js";
import type { MemberEntry, MemberList } from "./evidence/entry-reads.js";
import { handoffEnvelopeSchema } from "./handoff-types.js";
import { missionReportEnvelopeSchema } from "./mission-types.js";
import type { TeamReportEnvelope, TeamRole } from "./team-types.js";

/** Whether two types are mutually assignable. A field added to one side only makes the check `false`, and `tsc` fails. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const TEAM_ROLES = ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker"] as const satisfies readonly TeamRole[];
const uuid = z.uuid();
const revision = z.number().int().min(1);

/** The receipt sentence every structured write result carries in `message`, equal to its text content. */
const message = z.string();

/** The `report` answer: the durable receipt's binding and the receipt sentence. */
export const reportResultSchema = z.object({ requestId: uuid, runId: uuid, memberId: uuid, revision, message }).strict();
export const reportResultMatches: Exact<z.output<typeof reportResultSchema>, Pick<TeamReportEnvelope, "requestId" | "runId" | "memberId" | "revision"> & { message: string }> = true;

/** The `mission_report` answer: the durable receipt's binding and the receipt sentence. */
export const missionReportResultSchema = z.object({ requestId: uuid, missionId: uuid, memberId: uuid, revision, message }).strict();
export const missionReportResultMatches: Exact<z.output<typeof missionReportResultSchema>, Pick<z.infer<typeof missionReportEnvelopeSchema>, "requestId" | "missionId" | "memberId" | "revision"> & { message: string }> = true;

/** The `handoff` answer: the session that the handoff names and the receipt sentence. */
export const handoffResultSchema = z.object({ sessionId: uuid, message }).strict();
export const handoffResultMatches: Exact<z.output<typeof handoffResultSchema>, Pick<z.infer<typeof handoffEnvelopeSchema>, "sessionId"> & { message: string }> = true;

/** The `entry_post` answer: the entry id, its state before the host stores it, and the receipt sentence. */
export const entryPostResultSchema = z.object({ entryId: uuid, state: z.literal("pending"), message }).strict();
export type EntryPostResult = z.infer<typeof entryPostResultSchema>;
export const entryPostResultMatches: Exact<EntryPostResult, { entryId: string; state: "pending"; message: string }> = true;

/** A member's view of one head. Field-for-field the `MemberHead` pick of `EntryHead`. */
export const memberHeadSchema = z.object({
  entryId: uuid,
  seq: z.number().int().min(0),
  at: z.string(),
  kind: z.enum(ENTRY_KINDS),
  author: z.enum(["host", "member", "owner"]),
  authority: z.enum(["receipt", "claim", "direction"]),
  authorRole: z.enum([...TEAM_ROLES, "mission-coordinator"]).optional(),
  taskId: z.string().optional(),
  paths: z.array(z.string()),
  summary: z.string(),
  bodyBytes: z.number().int().min(0),
  supersedes: uuid.optional(),
  state: z.enum(["active", "superseded", "withdrawn"]),
}).strict();
export const memberHeadMatches: Exact<z.output<typeof memberHeadSchema>, MemberHead> = true;

/** The `entry_list` answer, as `listForMember` builds it. */
export const memberListSchema = z.object({
  notice: z.string(),
  heads: z.array(memberHeadSchema),
  more: z.boolean(),
  cursor: z.number().int().min(0).optional(),
  unreadable: z.number().int().min(0),
}).strict();
export const memberListMatches: Exact<z.output<typeof memberListSchema>, MemberList> = true;

/** The `entry_get` answer, as `getForMember` builds it. */
export const memberEntrySchema = z.object({
  notice: z.string(),
  head: memberHeadSchema,
  body: z.unknown(),
}).strict();
export const memberEntryMatches: Exact<z.output<typeof memberEntrySchema>, MemberEntry> = true;

/** The `tools/list` `outputSchema` of each result. Each root is an object. */
export const outputSchemas = {
  report: z.toJSONSchema(reportResultSchema, { target: "draft-7", io: "output" }),
  mission_report: z.toJSONSchema(missionReportResultSchema, { target: "draft-7", io: "output" }),
  handoff: z.toJSONSchema(handoffResultSchema, { target: "draft-7", io: "output" }),
  entry_post: z.toJSONSchema(entryPostResultSchema, { target: "draft-7", io: "output" }),
  entry_list: z.toJSONSchema(memberListSchema, { target: "draft-7", io: "output" }),
  entry_get: z.toJSONSchema(memberEntrySchema, { target: "draft-7", io: "output" }),
} as const;
