import { z } from "zod";
import { ENTRY_KINDS, type MemberHead } from "./evidence/entry-types.js";
import type { MemberEntry, MemberList } from "./evidence/entry-reads.js";
import type { PendingEntry } from "./team-entry-route.js";
import type { TeamRole } from "./team-types.js";
import type { Check, Exact } from "./wire-shape.js";

export type { Check, Exact, Shape } from "./wire-shape.js";

type OutputAllowsUndefined<T> = 0 extends 1 & T ? true
  : unknown extends T ? false
  : [Extract<T, undefined>] extends [never] ? false : true;

type SchemaListNoUndefined<T extends readonly unknown[]> =
  T extends readonly [infer Head, ...infer Tail]
    ? NoExplicitUndefined<Head> extends true ? SchemaListNoUndefined<Tail> : false
    : T extends readonly (infer Item)[] ? NoExplicitUndefined<Item>
    : true;

export type NoExplicitUndefined<S> =
  S extends z.ZodExactOptional<infer Inner>
    ? OutputAllowsUndefined<z.output<S>> extends true ? false : NoExplicitUndefined<Inner>
  : S extends z.ZodOptional<any> ? false
  : S extends z.ZodUndefined ? false
  : S extends z.ZodObject<infer Fields, any>
    ? false extends { [K in keyof Fields]: NoExplicitUndefined<Fields[K]> }[keyof Fields] ? false : true
  : S extends z.ZodArray<infer Item> ? NoExplicitUndefined<Item>
  : S extends z.ZodTuple<infer Items, infer Rest>
    ? SchemaListNoUndefined<Items> extends true
      ? Rest extends z.ZodType ? NoExplicitUndefined<Rest> : true
      : false
  : S extends z.ZodUnion<infer Options> ? SchemaListNoUndefined<Options>
  : S extends z.ZodNullable<infer Inner> ? NoExplicitUndefined<Inner>
  : S extends z.ZodReadonly<infer Inner> ? NoExplicitUndefined<Inner>
  : S extends z.ZodRecord<any, infer Value> ? NoExplicitUndefined<Value>
  : S extends z.ZodType
    ? OutputAllowsUndefined<z.output<S>> extends true ? false : true
  : false;

export type WireSchemaMatches<S extends z.ZodType, T> =
  NoExplicitUndefined<S> extends true ? Exact<z.output<S>, T> : false;

type Head = { id: string; tags: string[]; body: unknown; kind: "a" | "b"; at?: string };
type SampleOptionalSchema = z.ZodObject<{ id: z.ZodString; at: z.ZodOptional<z.ZodString> }>;
type SampleExactOptionalSchema = z.ZodObject<{ id: z.ZodString; at: z.ZodExactOptional<z.ZodString> }>;
type SampleUndefinedUnionSchema = z.ZodObject<{ id: z.ZodString; at: z.ZodUnion<[z.ZodString, z.ZodUndefined]> }>;
type SampleTupleSchema = z.ZodObject<{ pair: z.ZodTuple<[z.ZodString, z.ZodNumber], null> }>;
type SampleTupleOptionalSchema = z.ZodObject<{ pair: z.ZodTuple<[z.ZodString, z.ZodOptional<z.ZodNumber>], null> }>;

export type ExactCases = [
  Check<Exact<Head, { id: string; tags: readonly string[]; body: unknown; kind: "b" | "a"; at?: string }>>,
  Check<Exact<{ heads: Head[]; next?: number }, { heads: readonly Head[]; next?: number }>>,
  Check<Exact<{ pair: [string, number] }, { pair: readonly [string, number] }>>,
  Check<Exact<{ rest: [string, ...number[]] }, { rest: readonly [string, ...number[]] }>>,
  Check<WireSchemaMatches<SampleExactOptionalSchema, { id: string; at?: string }>>,
  Check<WireSchemaMatches<SampleTupleSchema, { pair: [string, number] }>>,
  // @ts-expect-error An optional key added on the second side.
  Check<Exact<{ id: string }, { id: string; added?: number }>>,
  // @ts-expect-error An optional key added on the first side.
  Check<Exact<{ id: string; added?: number }, { id: string }>>,
  // @ts-expect-error A required key made optional.
  Check<Exact<{ id: string }, { id?: string }>>,
  // @ts-expect-error A required undefined-allowing key made optional.
  Check<Exact<{ id: string | undefined }, { id?: string }>>,
  // @ts-expect-error An optional key added inside a nested object.
  Check<Exact<{ head: { id: string } }, { head: { id: string; added?: string } }>>,
  // @ts-expect-error An optional key added inside an array element.
  Check<Exact<{ heads: { id: string }[] }, { heads: { id: string; added?: string }[] }>>,
  // @ts-expect-error A literal member added to an enum.
  Check<Exact<{ kind: "a" | "b" }, { kind: "a" | "b" | "c" }>>,
  // @ts-expect-error A known type in place of `unknown`.
  Check<Exact<{ body: unknown }, { body: string }>>,
  // @ts-expect-error `any` in place of a known type.
  Check<Exact<{ id: any }, { id: string }>>,
  // @ts-expect-error A key added to one object member of a union.
  Check<Exact<{ a: string } | { a: string; b: string }, { a: string } | { a: string; b: string; c?: string }>>,
  // @ts-expect-error Swapped tuple element positions.
  Check<Exact<[string, number], [number, string]>>,
  // @ts-expect-error Mismatched tuple arity.
  Check<Exact<[string, number], [string, number, boolean]>>,
  // @ts-expect-error Tuple collapsed to an array.
  Check<Exact<[string, number], (string | number)[]>>,
  // @ts-expect-error Wire schema using `.optional()` instead of `.exactOptional()`.
  Check<WireSchemaMatches<SampleOptionalSchema, { id: string; at?: string }>>,
  // @ts-expect-error Wire schema allowing explicit `undefined` via union.
  Check<WireSchemaMatches<SampleUndefinedUnionSchema, { id: string; at: string | undefined }>>,
  // @ts-expect-error Wire schema tuple with swapped positions.
  Check<WireSchemaMatches<SampleTupleSchema, { pair: [number, string] }>>,
  // @ts-expect-error Wire schema tuple containing `.optional()`.
  Check<WireSchemaMatches<SampleTupleOptionalSchema, { pair: [string, number?] }>>,
];

const TEAM_ROLES = ["permission-coordinator", "project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker"] as const satisfies readonly TeamRole[];
const uuid = z.uuid();
const revision = z.number().int().min(1);

const message = z.string();

export const reportResultSchema = z.object({ requestId: uuid, runId: uuid, memberId: uuid, revision, message }).strict();
export type ReportResultWireSafe = Check<NoExplicitUndefined<typeof reportResultSchema>>;

export const missionReportResultSchema = z.object({ requestId: uuid, missionId: uuid, memberId: uuid, revision, message }).strict();
export type MissionReportResultWireSafe = Check<NoExplicitUndefined<typeof missionReportResultSchema>>;

export const handoffResultSchema = z.object({ sessionId: uuid, message }).strict();
export type HandoffResultWireSafe = Check<NoExplicitUndefined<typeof handoffResultSchema>>;

export const pendingEntrySchema = z.object({ entryId: uuid, state: z.literal("pending") }).strict();
export type PendingEntryMatches = Check<WireSchemaMatches<typeof pendingEntrySchema, PendingEntry>>;

export const entryPostResultSchema = pendingEntrySchema.extend({ message }).strict();
export type EntryPostResultWireSafe = Check<NoExplicitUndefined<typeof entryPostResultSchema>>;

export const memberHeadSchema = z.object({
  entryId: uuid,
  seq: z.number().int().min(0),
  at: z.string(),
  kind: z.enum(ENTRY_KINDS),
  author: z.enum(["host", "member", "owner"]),
  authority: z.enum(["receipt", "claim", "direction"]),
  authorRole: z.enum([...TEAM_ROLES, "mission-coordinator"]).exactOptional(),
  taskId: z.string().exactOptional(),
  paths: z.array(z.string()),
  summary: z.string(),
  bodyBytes: z.number().int().min(0),
  supersedes: uuid.exactOptional(),
  state: z.enum(["active", "superseded", "withdrawn"]),
}).strict();
export type MemberHeadMatches = Check<WireSchemaMatches<typeof memberHeadSchema, MemberHead>>;

export const memberListSchema = z.object({
  notice: z.string(),
  heads: z.array(memberHeadSchema),
  more: z.boolean(),
  cursor: z.number().int().min(0).exactOptional(),
  unreadable: z.number().int().min(0),
}).strict();
export type MemberListMatches = Check<WireSchemaMatches<typeof memberListSchema, MemberList>>;

export const memberEntrySchema = z.object({
  notice: z.string(),
  head: memberHeadSchema,
  body: z.unknown(),
}).strict();
export type MemberEntryMatches = Check<WireSchemaMatches<typeof memberEntrySchema, MemberEntry>>;

export type WriteResults = {
  report: z.output<typeof reportResultSchema>;
  mission_report: z.output<typeof missionReportResultSchema>;
  handoff: z.output<typeof handoffResultSchema>;
  entry_post: z.output<typeof entryPostResultSchema>;
};

export const outputSchemas = {
  report: z.toJSONSchema(reportResultSchema, { target: "draft-7", io: "output" }),
  mission_report: z.toJSONSchema(missionReportResultSchema, { target: "draft-7", io: "output" }),
  handoff: z.toJSONSchema(handoffResultSchema, { target: "draft-7", io: "output" }),
  entry_post: z.toJSONSchema(entryPostResultSchema, { target: "draft-7", io: "output" }),
  entry_list: z.toJSONSchema(memberListSchema, { target: "draft-7", io: "output" }),
  entry_get: z.toJSONSchema(memberEntrySchema, { target: "draft-7", io: "output" }),
} as const;
