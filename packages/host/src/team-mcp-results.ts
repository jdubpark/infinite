import { z } from "zod";
import { ENTRY_KINDS, type MemberHead } from "./evidence/entry-types.js";
import type { MemberEntry, MemberList } from "./evidence/entry-reads.js";
import type { PendingEntry } from "./team-entry-route.js";
import type { TeamRole } from "./team-types.js";

/**
 * A type's wire shape. Each object becomes its key set and its fields, every key made required and tagged with
 * whether it was optional, recursively through nested objects, array elements, and union members. Readonly and
 * mutable arrays have the same shape. `unknown` stays `unknown`; `any` gets a shape of its own, so it matches only `any`.
 */
type Shape<T> = 0 extends 1 & T ? { any: true }
  : unknown extends T ? T
  : T extends readonly (infer E)[] ? readonly Shape<E>[]
  : T extends object ? { keys: keyof T; fields: { -readonly [K in keyof T]-?: { optional: {} extends Pick<T, K> ? true : false; value: Shape<T[K]> } } }
  : T;

/**
 * Whether two types have the same wire shape: mutual assignability of their shapes. A key on one side only, required
 * or optional, a key optional on one side only, or a different field type makes it `false`, at any depth.
 * `exactOptionalPropertyTypes` is off in this package, so `x?: T` and `x?: T | undefined` are one type and this check
 * cannot tell them apart. Tuples compare as arrays of their element union.
 */
export type Exact<A, B> = [Shape<A>] extends [Shape<B>] ? ([Shape<B>] extends [Shape<A>] ? true : false) : false;
/** Fails the typecheck unless its argument is `true`. */
type Check<T extends true> = T;

// Compile-time cases for `Exact`. A case under `@ts-expect-error` fails the typecheck if it ever compiles.
type Head = { id: string; tags: string[]; body: unknown; kind: "a" | "b"; at?: string };
export type ExactCases = [
  Check<Exact<Head, { id: string; tags: readonly string[]; body: unknown; kind: "b" | "a"; at?: string | undefined }>>,
  Check<Exact<{ heads: Head[]; next?: number }, { heads: readonly Head[]; next?: number }>>,
];
// @ts-expect-error An optional key added on the second side.
type ExactOptionalAdded = Check<Exact<{ id: string }, { id: string; added?: number }>>;
// @ts-expect-error An optional key added on the first side.
type ExactOptionalRemoved = Check<Exact<{ id: string; added?: number }, { id: string }>>;
// @ts-expect-error A required key made optional.
type ExactOptionalMade = Check<Exact<{ id: string }, { id?: string }>>;
// @ts-expect-error An optional key added inside a nested object.
type ExactNestedOptional = Check<Exact<{ head: { id: string } }, { head: { id: string; added?: string } }>>;
// @ts-expect-error An optional key added inside an array element.
type ExactElementOptional = Check<Exact<{ heads: { id: string }[] }, { heads: { id: string; added?: string }[] }>>;
// @ts-expect-error A literal member added to an enum.
type ExactEnumWidened = Check<Exact<{ kind: "a" | "b" }, { kind: "a" | "b" | "c" }>>;
// @ts-expect-error A known type in place of `unknown`.
type ExactUnknownNarrowed = Check<Exact<{ body: unknown }, { body: string }>>;
// @ts-expect-error `any` in place of a known type.
type ExactAny = Check<Exact<{ id: any }, { id: string }>>;
// @ts-expect-error A key added to one object member of a union.
type ExactUnionMember = Check<Exact<{ a: string } | { a: string; b: string }, { a: string } | { a: string; b: string; c?: string }>>;

const TEAM_ROLES = ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker"] as const satisfies readonly TeamRole[];
const uuid = z.uuid();
const revision = z.number().int().min(1);

/** The receipt sentence every structured write result carries in `message`, equal to its text content. */
const message = z.string();

/** The `report` answer: the durable receipt's binding and the receipt sentence. */
export const reportResultSchema = z.object({ requestId: uuid, runId: uuid, memberId: uuid, revision, message }).strict();

/** The `mission_report` answer: the durable receipt's binding and the receipt sentence. */
export const missionReportResultSchema = z.object({ requestId: uuid, missionId: uuid, memberId: uuid, revision, message }).strict();

/** The `handoff` answer: the session that the handoff names and the receipt sentence. */
export const handoffResultSchema = z.object({ sessionId: uuid, message }).strict();

/** The session worker's answer to a post: the entry id and its state before the host stores it. */
export const pendingEntrySchema = z.object({ entryId: uuid, state: z.literal("pending") }).strict();
export type PendingEntryMatches = Check<Exact<z.output<typeof pendingEntrySchema>, PendingEntry>>;

/** The `entry_post` answer: the worker's pending receipt and the receipt sentence. */
export const entryPostResultSchema = pendingEntrySchema.extend({ message }).strict();

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
export type MemberHeadMatches = Check<Exact<z.output<typeof memberHeadSchema>, MemberHead>>;

/** The `entry_list` answer, as `listForMember` builds it. */
export const memberListSchema = z.object({
  notice: z.string(),
  heads: z.array(memberHeadSchema),
  more: z.boolean(),
  cursor: z.number().int().min(0).optional(),
  unreadable: z.number().int().min(0),
}).strict();
export type MemberListMatches = Check<Exact<z.output<typeof memberListSchema>, MemberList>>;

/** The `entry_get` answer, as `getForMember` builds it. */
export const memberEntrySchema = z.object({
  notice: z.string(),
  head: memberHeadSchema,
  body: z.unknown(),
}).strict();
export type MemberEntryMatches = Check<Exact<z.output<typeof memberEntrySchema>, MemberEntry>>;

/**
 * The result a write tool answers, by tool name. team-mcp.ts builds each write result as this type, so the compiler
 * checks the returned object against the schema that `outputSchemas` advertises for the same name.
 */
export type WriteResults = {
  report: z.output<typeof reportResultSchema>;
  mission_report: z.output<typeof missionReportResultSchema>;
  handoff: z.output<typeof handoffResultSchema>;
  entry_post: z.output<typeof entryPostResultSchema>;
};

/** The `tools/list` `outputSchema` of each result. Each root is an object. */
export const outputSchemas = {
  report: z.toJSONSchema(reportResultSchema, { target: "draft-7", io: "output" }),
  mission_report: z.toJSONSchema(missionReportResultSchema, { target: "draft-7", io: "output" }),
  handoff: z.toJSONSchema(handoffResultSchema, { target: "draft-7", io: "output" }),
  entry_post: z.toJSONSchema(entryPostResultSchema, { target: "draft-7", io: "output" }),
  entry_list: z.toJSONSchema(memberListSchema, { target: "draft-7", io: "output" }),
  entry_get: z.toJSONSchema(memberEntrySchema, { target: "draft-7", io: "output" }),
} as const;
