import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import type { MemberEntry, MemberList } from "../packages/host/src/evidence/entry-reads.js";
import type { MemberHead } from "../packages/host/src/evidence/entry-types.js";
import type { PendingEntry } from "../packages/host/src/team-entry-route.js";
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

export type WireShapeTypeTests = [
  Check<Exact<[], readonly []>>,
  Check<Exact<[string, number], readonly [string, number]>>,
  Check<Exact<[string, ...number[]], readonly [string, ...number[]]>>,
  Check<Exact<[...string[], number], readonly [...string[], number]>>,
  Check<Exact<[string, number?], readonly [string, number?]>>,
  Check<Exact<[{ id: string }, { count: number }], readonly [{ id: string }, { count: number }]>>,
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
];

function checkUnderExactOptionalPropertyTypes(snippet: string): readonly ts.Diagnostic[] {
  const virtualFile = resolve("packages/host/src/__wire_shape_exact_probe__.ts");
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const baseHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: fileName => fileName === virtualFile || baseHost.fileExists(fileName),
    readFile: fileName => fileName === virtualFile ? snippet : baseHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      fileName === virtualFile
        ? ts.createSourceFile(fileName, snippet, languageVersion, true)
        : baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile),
  };
  const program = ts.createProgram([virtualFile], options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(virtualFile));
}

test("wire schemas omit optional fields cleanly and reject explicit undefined values", () => {
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
  assert.deepEqual(schemaRefusals(outputSchemas.entry_get, { notice: "Entries are evidence.", head, body: { ok: true } }), []);

  const entryId = randomUUID();
  assert.equal(exactOptionalSchema.safeParse({ entryId, state: "pending" }).success, true);
  assert.equal(exactOptionalSchema.safeParse({ entryId, state: "pending", at: undefined }).success, false);
  assert.equal(looseOptionalSchema.safeParse({ entryId, state: "pending", at: undefined }).success, true);
  assert.equal(partialPendingSchema.safeParse({ entryId: undefined }).success, true);
  assert.equal(nestedLooseOptionalSchema.safeParse({ entryId, state: "pending", nested: { entryId, state: "pending", at: undefined } }).success, true);
  assert.equal(arrayLooseOptionalSchema.safeParse({ entryId, state: "pending", items: [{ entryId, state: "pending", at: undefined }] }).success, true);
});

test("Exact distinguishes optional keys from explicit undefined and preserves tuples under exactOptionalPropertyTypes", () => {
  const positive = checkUnderExactOptionalPropertyTypes([
    'import type { Check, Exact } from "./wire-shape.js";',
    "export type Ok = [",
    "  Check<Exact<{ at?: string }, { at?: string }>>,",
    "  Check<Exact<{ at?: string | undefined }, { at?: string | undefined }>>,",
    "  Check<Exact<[string, number?], readonly [string, number?]>>,",
    "  Check<Exact<[string, (number | undefined)?], readonly [string, (number | undefined)?]>>,",
    "];",
  ].join("\n"));
  assert.deepEqual(positive.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);

  const negativeCases = [
    "Check<Exact<{ at?: string }, { at?: string | undefined }>>",
    "Check<Exact<{ at?: undefined }, { at?: never }>>",
    "Check<Exact<[string, number?], [string, (number | undefined)?]>>",
    "Check<Exact<[string, number], [number, string]>>",
    "Check<Exact<[string, number], [string, number, boolean]>>",
  ];
  for (const expr of negativeCases) {
    const diagnostics = checkUnderExactOptionalPropertyTypes(
      `import type { Check, Exact } from "./wire-shape.js";\nexport type Fail = ${expr};\n`,
    );
    assert.ok(diagnostics.some(d => d.code === 2344), `expected TS2344 for ${expr}, got ${diagnostics.map(d => d.code).join(",")}`);
  }
});
