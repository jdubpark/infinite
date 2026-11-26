import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { MemberEntry, MemberHead, MemberList, PendingEntry } from "../packages/host/src/evidence/entry-types.js";
import {
  entryPostResultSchema,
  handoffResultSchema,
  memberEntrySchema,
  memberHeadSchema,
  memberListSchema,
  missionReportResultSchema,
  outputSchemas,
  pendingEntrySchema,
  reportResultSchema,
  type Check,
  type Exact,
  type NoExplicitUndefined,
  type WireSchemaMatches,
} from "../packages/host/src/team-mcp-results.js";
import { schemaRefusals } from "./wire-schema.js";

const exactOptionalSchema = pendingEntrySchema.extend({ at: pendingEntrySchema.shape.entryId.exactOptional() }).strict();
const looseOptionalSchema = pendingEntrySchema.extend({ at: pendingEntrySchema.shape.entryId.optional() }).strict();
const partialPendingSchema = pendingEntrySchema.partial();
const nestedLooseOptionalSchema = pendingEntrySchema.extend({ nested: looseOptionalSchema }).strict();
const arrayLooseOptionalSchema = pendingEntrySchema.extend({ items: looseOptionalSchema.array() }).strict();
const nullableLooseOptionalSchema = looseOptionalSchema.nullable();
const readonlyLooseOptionalSchema = looseOptionalSchema.readonly();
const transformedSchema = pendingEntrySchema.shape.entryId.transform(value => value);
const defaultedSchema = pendingEntrySchema.shape.entryId.default("11111111-1111-4111-8111-111111111111");
const looseObjectSchema = pendingEntrySchema.passthrough();
const catchallOptionalSchema = pendingEntrySchema.catchall(looseOptionalSchema);
const cleanPipeSchema = pendingEntrySchema.shape.entryId.pipe(pendingEntrySchema.shape.entryId);
const optionalInputPipeSchema = pendingEntrySchema.shape.entryId.optional().pipe(pendingEntrySchema.shape.entryId);

export type WireShapeTypeTests = [
  Check<Exact<[], readonly []>>,
  Check<Exact<[string, number], readonly [string, number]>>,
  Check<Exact<[string, ...number[]], readonly [string, ...number[]]>>,
  Check<Exact<[...string[], number], readonly [...string[], number]>>,
  Check<Exact<[string, number?], readonly [string, number?]>>,
  Check<Exact<[unknown?, ...number[]], readonly [unknown?, ...number[]]>>,
  Check<Exact<[{ id: string }, { count: number }], readonly [{ id: string }, { count: number }]>>,
  Check<NoExplicitUndefined<typeof cleanPipeSchema>>,
  Check<WireSchemaMatches<typeof exactOptionalSchema, { entryId: string; state: "pending"; at?: string }>>,
  Check<WireSchemaMatches<typeof pendingEntrySchema, PendingEntry>>,
  Check<WireSchemaMatches<typeof memberHeadSchema, MemberHead>>,
  Check<WireSchemaMatches<typeof memberListSchema, MemberList>>,
  Check<WireSchemaMatches<typeof memberEntrySchema, MemberEntry>>,
  Check<NoExplicitUndefined<typeof reportResultSchema>>,
  Check<NoExplicitUndefined<typeof missionReportResultSchema>>,
  Check<NoExplicitUndefined<typeof handoffResultSchema>>,
  Check<NoExplicitUndefined<typeof entryPostResultSchema>>,
  // @ts-expect-error Swapped tuple element positions fail Exact.
  Check<Exact<[string, number], [number, string]>>,
  // @ts-expect-error Extra tuple element fails Exact.
  Check<Exact<[string, number], [string, number, boolean]>>,
  // @ts-expect-error Missing tuple element fails Exact.
  Check<Exact<[string, number], [string]>>,
  // @ts-expect-error Tuple does not match union array.
  Check<Exact<[string, number], (string | number)[]>>,
  // @ts-expect-error Single-element tuple does not match array.
  Check<Exact<[string], string[]>>,
  // @ts-expect-error Empty tuple does not match array.
  Check<Exact<[], string[]>>,
  // @ts-expect-error Variadic tuple element order mismatch fails Exact.
  Check<Exact<[string, ...number[]], [number, ...string[]]>>,
  // @ts-expect-error Variadic tuple does not match plain array.
  Check<Exact<[string, ...string[]], string[]>>,
  // @ts-expect-error Trailing variadic tuple does not match leading variadic tuple.
  Check<Exact<[...string[], number], [number, ...string[]]>>,
  // @ts-expect-error Variadic tuple with optional unknown head and different rest element fails Exact.
  Check<Exact<[unknown?, ...number[]], [unknown?, ...string[]]>>,
  // @ts-expect-error Variadic tuple with optional unknown head does not match unknown array.
  Check<Exact<[unknown?, ...number[]], unknown[]>>,
  // @ts-expect-error Variadic tuple with optional any head and different rest element fails Exact.
  Check<Exact<[any?, ...number[]], [any?, ...string[]]>>,
  // @ts-expect-error Variadic tuple with optional any head does not match any array.
  Check<Exact<[any?, ...number[]], any[]>>,
  // @ts-expect-error Optional tuple element does not match required element.
  Check<Exact<[string, number?], [string, number]>>,
  // @ts-expect-error Nested object mismatch inside tuple slot fails Exact.
  Check<Exact<[{ id: string }, { count: number }], [{ id: string }, { count: number; extra?: boolean }]>>,
  // @ts-expect-error Nested object mismatch inside optional tuple slot fails Exact.
  Check<Exact<[{ id: string }?], [{ id: string; extra?: boolean }?]>>,
  // @ts-expect-error Tuple containing any does not match unknown.
  Check<Exact<[any, string], [unknown, string]>>,
  // @ts-expect-error Required property does not match optional property.
  Check<Exact<{ id: string }, { id?: string }>>,
  // @ts-expect-error Required property allowing undefined does not match optional property.
  Check<Exact<{ id: string | undefined }, { id?: string }>>,
  // @ts-expect-error Required property does not match required undefined union.
  Check<Exact<{ id: string }, { id: string | undefined }>>,
  // @ts-expect-error Wire schema using .optional() instead of .exactOptional() fails WireSchemaMatches.
  Check<WireSchemaMatches<typeof looseOptionalSchema, { entryId: string; state: "pending"; at?: string }>>,
  // @ts-expect-error Partial wire schema using .optional() fails NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof partialPendingSchema>>,
  // @ts-expect-error Nested .optional() property fails NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof nestedLooseOptionalSchema>>,
  // @ts-expect-error Array element containing .optional() property fails NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof arrayLooseOptionalSchema>>,
  // @ts-expect-error Nullable wrapper containing .optional() property fails NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof nullableLooseOptionalSchema>>,
  // @ts-expect-error Readonly wrapper containing .optional() property fails NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof readonlyLooseOptionalSchema>>,
  // @ts-expect-error Uninspected ZodTransform fails closed in NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof transformedSchema>>,
  // @ts-expect-error Uninspected ZodDefault fails closed in NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof defaultedSchema>>,
  // @ts-expect-error Loose passthrough object fails NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof looseObjectSchema>>,
  // @ts-expect-error Catchall schema allowing explicit undefined fails NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof catchallOptionalSchema>>,
  // @ts-expect-error Pipe schema whose input accepts undefined fails NoExplicitUndefined.
  Check<NoExplicitUndefined<typeof optionalInputPipeSchema>>,
];

test("wire schemas omit optional fields cleanly and reject explicit undefined values including memberEntrySchema.body", () => {
  const head = {
    entryId: randomUUID(),
    seq: 1,
    at: "2026-11-26T00:00:00.000Z",
    kind: "finding" as const,
    author: "member" as const,
    authority: "claim" as const,
    paths: ["packages/host/src/team-mcp-results.ts"],
    summary: "Check exactOptional wire validation",
    bodyBytes: 32,
    state: "active" as const,
  };
  assert.equal(memberHeadSchema.safeParse(head).success, true);
  assert.equal(memberHeadSchema.safeParse({ ...head, taskId: "task-1", authorRole: "implementer", supersedes: randomUUID() }).success, true);
  assert.equal(memberHeadSchema.safeParse({ ...head, taskId: undefined }).success, false);
  assert.equal(memberHeadSchema.safeParse({ ...head, authorRole: undefined }).success, false);
  assert.equal(memberHeadSchema.safeParse({ ...head, supersedes: undefined }).success, false);

  const list = { notice: "Entries are evidence.", heads: [head], more: false, unreadable: 0 };
  assert.equal(memberListSchema.safeParse(list).success, true);
  assert.equal(memberListSchema.safeParse({ ...list, cursor: 4 }).success, true);
  assert.equal(memberListSchema.safeParse({ ...list, cursor: undefined }).success, false);
  assert.deepEqual(schemaRefusals(outputSchemas.entry_list, list), []);
  assert.deepEqual(schemaRefusals(outputSchemas.entry_list, { ...list, cursor: 4 }), []);

  const entryBase = { notice: "Entries are evidence.", head };
  for (const body of [null, 0, "", false, {}, [], { ok: true, items: [1, null, "x"] }]) {
    const entry = { ...entryBase, body };
    assert.equal(memberEntrySchema.safeParse(entry).success, true, `accepts body ${JSON.stringify(body)}`);
    assert.deepEqual(schemaRefusals(outputSchemas.entry_get, entry), [], `outputSchema accepts body ${JSON.stringify(body)}`);
  }
  assert.equal(memberEntrySchema.safeParse({ ...entryBase, body: undefined }).success, false);
  assert.equal(memberEntrySchema.safeParse({ ...entryBase, body: { nested: undefined } }).success, false);
  assert.equal(memberEntrySchema.safeParse({ ...entryBase, body: [1, undefined] }).success, false);

  const entryId = randomUUID();
  assert.equal(exactOptionalSchema.safeParse({ entryId, state: "pending" }).success, true);
  assert.equal(exactOptionalSchema.safeParse({ entryId, state: "pending", at: undefined }).success, false);
  assert.equal(looseOptionalSchema.safeParse({ entryId, state: "pending", at: undefined }).success, true);
  assert.equal(partialPendingSchema.safeParse({ entryId: undefined }).success, true);
  assert.equal(nestedLooseOptionalSchema.safeParse({ entryId, state: "pending", nested: { entryId, state: "pending", at: undefined } }).success, true);
  assert.equal(arrayLooseOptionalSchema.safeParse({ entryId, state: "pending", items: [{ entryId, state: "pending", at: undefined }] }).success, true);
  assert.equal(nullableLooseOptionalSchema.safeParse({ entryId, state: "pending", at: undefined }).success, true);
  assert.equal(readonlyLooseOptionalSchema.safeParse({ entryId, state: "pending", at: undefined }).success, true);
  assert.equal(transformedSchema.safeParse(entryId).success, true);
  assert.equal(defaultedSchema.safeParse(undefined).success, true);
  assert.equal(looseObjectSchema.safeParse({ entryId, state: "pending", extra: undefined }).success, true);
  assert.equal(catchallOptionalSchema.safeParse({ entryId, state: "pending", extra: { entryId, state: "pending", at: undefined } }).success, true);
  assert.equal(cleanPipeSchema.safeParse(entryId).success, true);
  assert.equal(optionalInputPipeSchema.safeParse(entryId).success, true);
});
