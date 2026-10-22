import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUnderstandingCommand, renderUnderstanding } from "../packages/host/src/understanding-cli.js";
import { parseClientArgs } from "../packages/host/src/client.js";
import type { WorkspaceUnderstanding } from "@infinite/remote";

const value: WorkspaceUnderstanding = {
  schemaVersion: 1, workspace: { id: "sample", name: "Sample", revision: 2 }, observedAt: "2026-10-21T12:00:00.000Z",
  work: [{ id: "mission:m1", sourceId: "m1", kind: "mission", title: "Fix the build", objective: "Repair CI", reportedSummary: "The owner reports green CI", status: "ready-for-review", column: "review", updatedAt: "2026-10-21T11:00:00.000Z", scope: "complete", repositoryIds: ["repo"], briefIds: [], links: [] }],
  repositories: [{ id: "repo", name: "Repo", checkoutIds: ["repo", "repo-copy"], state: "ready", current: [{ id: "00000000-0000-4000-8000-000000000001", sourceProjectId: "repo", sessionId: "00000000-0000-4000-8000-000000000002", sourceKind: "project", head: "a".repeat(40), base: null, fingerprint: "b".repeat(40), generatedAt: "2026-10-21T11:00:00.000Z", retainedAt: "2026-10-21T11:01:00.000Z", coverage: ["repository files"], brief: { summary: "Current architecture\u0001", architecture: [{ text: "A module owns sessions", citations: [{ source: "src/session.ts", line: 3 }] }], changes: [], checks: [{ text: "Typecheck passes", citations: [] }], review: [], guidance: [], unknowns: [] }, evidence: [] }], planned: [{ workId: "mission:m1", kind: "mission", title: "Fix the build", text: "Repair CI", status: "ready-for-review", updatedAt: "2026-10-21T11:00:00.000Z", source: "request" }], warnings: [], coverage: ["repository files"] }], coverage: [],
};

test("CLI text keeps current facts separate from planned requests and strips control characters", () => {
  const output = renderUnderstanding(value).join("\n");
  assert.match(output, /Current: A module owns sessions/);
  assert.match(output, /Check: Typecheck passes/);
  assert.match(output, /Planned: Fix the build/);
  assert.doesNotMatch(output, /\u0001/);
});

test("CLI text discloses repository omissions when a bounded response contains no snapshots or requests", () => {
  const bounded = structuredClone(value);
  bounded.repositories[0]!.current = [];
  bounded.repositories[0]!.planned = [];
  bounded.repositories[0]!.coverage = [
    "Retained snapshots: 0 of 3 included; 3 omitted from this response to fit its byte limit.",
    "Planned requests: 0 of 4 included; 4 omitted from this response to fit its byte limit.",
  ];
  const output = renderUnderstanding(bounded).join("\n");
  assert.match(output, /Retained snapshots: 0 of 3 included; 3 omitted/);
  assert.match(output, /Planned requests: 0 of 4 included; 4 omitted/);
});

test("CLI rejects a missing workspace selector and mismatched or unsupported host responses", async () => {
  let calls = 0;
  const api = { json: async () => { calls++; return value; } };
  await assert.rejects(handleUnderstandingCommand([], { "--workspace": true }, api), /requires an ID/);
  assert.equal(calls, 0);
  await assert.rejects(handleUnderstandingCommand([], { "--workspace": "other" }, api), /mismatched Understanding response/);
  await assert.rejects(Promise.resolve().then(() => renderUnderstanding({ ...value, schemaVersion: 2 } as never)), /unsupported Understanding response/);
});

test("JSON mode emits the validated workspace DTO without reshaping its source facts", async () => {
  let printed = "";
  const log = console.log;
  console.log = value => { printed = String(value); };
  try {
    await handleUnderstandingCommand([], { "--workspace": "sample", "--json": true, "--client-config": "client.json" }, { json: async () => value });
  } finally { console.log = log; }
  assert.deepEqual(JSON.parse(printed), value);
});

test("catalog mutation reads a JSON value file and sends one explicit revisioned request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "understanding-cli-"));
  const file = join(directory, "feature.json");
  const value = { projectId: null, title: "Improve errors", description: "", repositoryIds: ["repo"], workIds: ["mission:m1"], componentIds: ["cmp_0123456789abcdef01234567"], status: "planned", sourceUrl: null };
  writeFileSync(file, JSON.stringify(value));
  const catalog = { revision: 4, projects: [], features: [], plans: [], componentOverrides: [], policy: { enabled: false, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 }, coverage: [] };
  const calls: unknown[][] = [];
  const log = console.log;
  console.log = () => {};
  try {
    await handleUnderstandingCommand(["create", "features"], { "--workspace": "sample", "--revision": "3", "--request-id": "123e4567-e89b-42d3-a456-426614174000", "--file": file, "--json": true }, {
      json: async (...args: unknown[]) => { calls.push(args); return catalog; },
    } as never);
  } finally { console.log = log; rmSync(directory, { recursive: true, force: true }); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "/project-groups/sample/understanding/catalog/features");
  assert.deepEqual(calls[0]?.[1], { requestId: "123e4567-e89b-42d3-a456-426614174000", revision: 3, action: "create", value });
  assert.equal(calls[0]?.[4], "POST");
});

test("mutation validation rejects malformed identity, revision, and archive input before any request", async () => {
  let calls = 0;
  const api = { json: async () => { calls++; throw new Error("must not call host"); } };
  await assert.rejects(handleUnderstandingCommand(["create", "projects"], { "--workspace": "sample", "--revision": "1.5", "--request-id": "123e4567-e89b-42d3-a456-426614174000", "--file": "missing" }, api), /nonnegative integer/);
  await assert.rejects(handleUnderstandingCommand(["archive", "projects", "p1"], { "--workspace": "sample", "--revision": "1", "--request-id": "not-a-uuid" }, api), /UUID/);
  await assert.rejects(handleUnderstandingCommand(["archive", "projects", "p1"], { "--workspace": "sample", "--revision": "1", "--request-id": "123e4567-e89b-42d3-a456-426614174000", "--file": "input" }, api), /does not accept --file/);
  assert.equal(calls, 0);
});

test("component IDs with underscore are accepted and auth conflicts retain host guidance", async () => {
  let requested = "";
  await assert.rejects(handleUnderstandingCommand(["component", "cmp_0123456789abcdef01234567"], { "--workspace": "sample", "--json": true }, { json: async path => { requested = path; throw Object.assign(new Error("Catalog revision conflict. Refresh and inspect the returned state."), { status: 409 }); } }), /Catalog revision conflict/);
  assert.match(requested, /components\/cmp_0123456789abcdef01234567$/);
});

test("shared CLI parser accepts the Understanding mutation flags", () => {
  const parsed = parseClientArgs(["understand", "create", "projects", "--workspace", "sample", "--file", "project.json", "--revision", "2", "--request-id", "123e4567-e89b-42d3-a456-426614174000"]);
  assert.deepEqual(parsed.args, ["create", "projects"]);
  assert.equal(parsed.options["--file"], "project.json");
  assert.equal(parsed.options["--revision"], "2");
});
