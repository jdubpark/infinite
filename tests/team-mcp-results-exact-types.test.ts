import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import type { MemberEntry, MemberHead, MemberList, PendingEntry } from "../packages/host/src/evidence/entry-types.js";
import type {
  Check,
  Exact,
  WireSchemaMatches,
  memberEntrySchema,
  memberHeadSchema,
  memberListSchema,
  pendingEntrySchema,
} from "../packages/host/src/team-mcp-results.js";

export type ExactOptionalContractTests = [
  Check<Exact<{ at?: string }, { at?: string }>>,
  Check<Exact<{ at?: string | undefined }, { at?: string | undefined }>>,
  Check<Exact<[string, number?], readonly [string, number?]>>,
  Check<Exact<[string, (number | undefined)?], readonly [string, (number | undefined)?]>>,
  Check<WireSchemaMatches<typeof pendingEntrySchema, PendingEntry>>,
  Check<WireSchemaMatches<typeof memberHeadSchema, MemberHead>>,
  Check<WireSchemaMatches<typeof memberListSchema, MemberList>>,
  Check<WireSchemaMatches<typeof memberEntrySchema, MemberEntry>>,
  // @ts-expect-error Optional property without undefined does not match optional property with explicit undefined.
  Check<Exact<{ at?: string }, { at?: string | undefined }>>,
  // @ts-expect-error Optional undefined does not match optional never.
  Check<Exact<{ at?: undefined }, { at?: never }>>,
  // @ts-expect-error Optional tuple element without undefined does not match optional tuple element with undefined.
  Check<Exact<[string, number?], [string, (number | undefined)?]>>,
  // @ts-expect-error Optional variadic tuple head without undefined does not match optional head with undefined.
  Check<Exact<[string?, ...number[]], [(string | undefined)?, ...number[]]>>,
  // @ts-expect-error Widening MemberList.cursor to number | undefined fails exactOptionalPropertyTypes contract check.
  Check<WireSchemaMatches<typeof memberListSchema, Omit<MemberList, "cursor"> & { cursor?: number | undefined }>>,
  // @ts-expect-error Widening MemberHead.taskId to string | undefined fails exactOptionalPropertyTypes contract check.
  Check<WireSchemaMatches<typeof memberHeadSchema, Omit<MemberHead, "taskId"> & { taskId?: string | undefined }>>,
  // @ts-expect-error Widening MemberHead.authorRole to allow explicit undefined fails exactOptionalPropertyTypes contract check.
  Check<WireSchemaMatches<typeof memberHeadSchema, Omit<MemberHead, "authorRole"> & { authorRole?: MemberHead["authorRole"] | undefined }>>,
  // @ts-expect-error Widening MemberHead.supersedes to allow explicit undefined fails exactOptionalPropertyTypes contract check.
  Check<WireSchemaMatches<typeof memberHeadSchema, Omit<MemberHead, "supersedes"> & { supersedes?: string | undefined }>>,
];

function compileExactWithOverrides(entryFiles: readonly string[], overrides: ReadonlyMap<string, string>): readonly ts.Diagnostic[] {
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
    fileExists: fileName => overrides.has(fileName) || baseHost.fileExists(fileName),
    readFile: fileName => overrides.get(fileName) ?? baseHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const override = overrides.get(fileName);
      return override !== undefined
        ? ts.createSourceFile(fileName, override, languageVersion, true)
        : baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
  };
  const program = ts.createProgram([...entryFiles], options, host);
  return ts.getPreEmitDiagnostics(program);
}

test("actual team-mcp-results.ts contracts pass under exactOptionalPropertyTypes and fail if MemberList or MemberHead widens an optional key with undefined", () => {
  const resultsFile = resolve("packages/host/src/team-mcp-results.ts");
  const entryTypesFile = resolve("packages/host/src/evidence/entry-types.ts");
  const originalEntryTypes = readFileSync(entryTypesFile, "utf8");

  const baseline = compileExactWithOverrides([resultsFile], new Map());
  assert.deepEqual(baseline.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);

  const widenedCursor = originalEntryTypes.replace("cursor?: number;", "cursor?: number | undefined;");
  assert.notEqual(widenedCursor, originalEntryTypes);
  const cursorDiagnostics = compileExactWithOverrides([resultsFile], new Map([[entryTypesFile, widenedCursor]]));
  assert.ok(cursorDiagnostics.some(d => d.code === 2344 && d.file?.fileName === resultsFile), `expected TS2344 in team-mcp-results.ts for widened cursor, got ${cursorDiagnostics.map(d => d.code).join(",")}`);

  const widenedTaskId = originalEntryTypes.replace("taskId?: string;", "taskId?: string | undefined;");
  assert.notEqual(widenedTaskId, originalEntryTypes);
  const taskIdDiagnostics = compileExactWithOverrides([resultsFile], new Map([[entryTypesFile, widenedTaskId]]));
  assert.ok(taskIdDiagnostics.some(d => d.code === 2344 && d.file?.fileName === resultsFile), `expected TS2344 in team-mcp-results.ts for widened taskId, got ${taskIdDiagnostics.map(d => d.code).join(",")}`);

  const virtualProbe = resolve("packages/host/src/__mcp_wire_schema_probe__.ts");
  const failingSnippets = [
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.lazy(() => z.object({ at: z.string().optional() }));\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.object({ body: z.unknown() });\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.object({ body: z.any() });\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.object({ at: z.string().optional() }).readonly().nullable();\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.string().transform(value => value);\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.object({ ok: z.boolean() }).catchall(z.unknown());\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.looseObject({ ok: z.boolean() });\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.object({ x: z.coerce.string().exactOptional() });\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
    'import { z } from "zod";\nimport type { Check, NoExplicitUndefined } from "./team-mcp-results.js";\nconst s = z.object({ x: z.pipe(z.unknown(), z.string()) });\nexport type Fail = Check<NoExplicitUndefined<typeof s>>;\n',
  ];
  for (const snippet of failingSnippets) {
    const diagnostics = compileExactWithOverrides([virtualProbe], new Map([[virtualProbe, snippet]]));
    assert.ok(diagnostics.some(d => d.code === 2344 && d.file?.fileName === virtualProbe), `expected TS2344 for ${snippet}, got ${diagnostics.map(d => `${d.code}:${ts.flattenDiagnosticMessageText(d.messageText, " ")}`).join("; ")}`);
  }
});
