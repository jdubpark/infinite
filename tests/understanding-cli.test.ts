import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLocalBehaviorCheckCommand, handleUnderstandingCommand, renderUnderstanding } from "../packages/host/src/understanding-cli.js";
import { parseClientArgs } from "../packages/host/src/client.js";
import { behaviorDefinitionHash } from "../packages/host/src/behavior-checker.js";
import type { BehaviorDefinition, BehaviorSuite, KnowledgeBehavior, WorkspaceUnderstanding } from "@infinite/remote";

const value: WorkspaceUnderstanding = {
  schemaVersion: 1, workspace: { id: "sample", name: "Sample", revision: 2 }, observedAt: "2026-10-21T12:00:00.000Z",
  work: [{ id: "mission:m1", sourceId: "m1", kind: "mission", title: "Fix the build", objective: "Repair CI", reportedSummary: "The owner reports green CI", status: "ready-for-review", column: "review", updatedAt: "2026-10-21T11:00:00.000Z", scope: "complete", repositoryIds: ["repo"], briefIds: [], links: [] }],
  repositories: [{ id: "repo", name: "Repo", checkoutIds: ["repo", "repo-copy"], state: "ready", current: [{ id: "00000000-0000-4000-8000-000000000001", sourceProjectId: "repo", sessionId: "00000000-0000-4000-8000-000000000002", sourceKind: "project", head: "a".repeat(40), base: null, fingerprint: "b".repeat(40), generatedAt: "2026-10-21T11:00:00.000Z", retainedAt: "2026-10-21T11:01:00.000Z", coverage: ["repository files"], brief: { summary: "Current architecture\u0001", architecture: [{ text: "A module owns sessions", citations: [{ source: "src/session.ts", line: 3 }] }], changes: [], checks: [{ text: "Typecheck passes", citations: [] }], review: [], guidance: [], unknowns: [] }, evidence: [] }], planned: [{ workId: "mission:m1", kind: "mission", title: "Fix the build", text: "Repair CI", status: "ready-for-review", updatedAt: "2026-10-21T11:00:00.000Z", source: "request" }], warnings: [], coverage: ["repository files"] }], coverage: [],
};

function behaviorDefinition(violates = false): BehaviorDefinition {
  return {
    schemaVersion: 1, id: "login-flow", title: "Login flow", componentId: "auth", repositoryId: "sample",
    sourceSnapshotId: "snapshot-1", planRevisions: [{ id: "plan-auth", revision: 2 }], requirementRevision: "req-3",
    assumptions: ["The identity provider response is trusted after signature verification."], exclusions: ["Provider availability is outside this model."],
    current: {
      initial: "locked", states: [{ id: "locked", label: "Locked" }, { id: "open", label: "Open" }],
      variables: [{ id: "authorized", domain: [false, true], initial: false }],
      transitions: [{ id: "grant-access", from: "locked", to: "open", label: "Grant access", actor: "owner", event: "grant", guard: { op: "true" }, effects: { authorized: { value: true } }, evidence: [{ repositoryId: "sample", source: "src/auth.ts", line: 12, text: "Authorization transition" }] }],
      properties: [{ id: "authorization-required", title: "Authorization required", kind: "safety", states: ["open"], predicate: violates ? { op: "eq", left: { variable: "authorized" }, right: { value: false } } : { op: "true" }, requirement: "An open session requires authorization.", basis: "accepted", evidence: [{ repositoryId: "sample", source: "docs/auth.md", line: 8, text: "Accepted access rule" }] }],
    },
    planned: null,
  };
}
function storedBehavior(): KnowledgeBehavior {
  const definition = behaviorDefinition(true);
  const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  };
  const modelHash = createHash("sha256").update(canonicalJson(definition.current)).digest("hex");
  return {
    id: "login-flow", revision: 1, definition,
    sources: [{ repositoryId: "sample", path: "src/auth.ts", hash: "a".repeat(64), lines: 120 }],
    updatedAt: "2026-10-21T12:00:00.000Z", freshness: "current", status: "counterexample", coverage: ["One repository snapshot"],
    runs: [{ id: "run-one", definitionRevision: 1, definitionHash: behaviorDefinitionHash(definition), startedAt: "2026-10-21T11:00:00.000Z", finishedAt: "2026-10-21T11:00:01.000Z", state: "finished",
      current: { tool: "infinite-finite-state", toolVersion: "1.0.0", status: "counterexample", checkedAt: "2026-10-21T11:00:01.000Z", modelHash, exhaustive: true, exploredStates: 2, exploredTransitions: 1,
        limits: { maxStates: 100, maxTransitions: 200, timeoutMs: 1_000, maxTraceSteps: 20 }, properties: [{ id: "authorization-required", status: "failed", reachableStates: 2, trace: [
          { state: "locked", values: { authorized: false }, transitionId: null, summary: "Initial state" },
          { state: "open", values: { authorized: true }, transitionId: "grant-access", summary: "owner grant: Grant access" },
        ], traceTruncated: false }], message: "A safety property failed." }, planned: null, message: null }],
  };
}

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

const root = "/project-groups/w/understanding";
function fakeApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  return { calls, json: async (path: string) => { calls.push(path); if (!(path in routes)) throw new Error(`unexpected request ${path}`); return routes[path]; } } as { calls: string[]; json: <T>(path: string) => Promise<T> };
}
async function runUnderstand(api: ReturnType<typeof fakeApi>, options: Record<string, string | boolean>, positional: string[] = []) {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { lines.push(String(line)); };
  try { await handleUnderstandingCommand(positional, options, api); } finally { console.log = log; }
  return lines.join("\n");
}
const fullPlan = (id: string) => ({ workId: id, kind: "mission", title: id, text: `${id} full text`, status: "ready-for-review", updatedAt: "2026-10-21T11:00:00.000Z", source: "request", excerpt: false });
const diagram = (title: string, edges: [string, string][]) => ({ id: "d", title, kind: "system", direction: "LR", nodes: [...new Set(edges.flat())].map(id => ({ id, label: id, group: null, componentId: null })), groups: [], edges: edges.map(([from, to]) => ({ from, to, label: null })), source: "mermaid", sourceText: null, parseError: null, repositoryId: "repo", head: null, observedAt: "2026-10-21T12:00:00.000Z" });
const briefWith = (...diagrams: unknown[]) => ({ repositoryId: "repo", head: "a".repeat(40), base: null, generatedAt: "2026-10-21T11:00:00.000Z", observedAt: "2026-10-21T12:00:00.000Z", state: "ready", brief: { summary: "Repo summary", architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] }, diagrams, evidence: [], coverage: [] });
const withBriefs = (briefs: unknown[]) => ({ ...value, workspace: { ...value.workspace, id: "w" }, knowledge: { schemaVersion: 1, catalog: { revision: 1, policy: { enabled: false, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 }, projects: [], features: [], plans: [], componentOverrides: [], coverage: [] }, components: [], relationships: [], delivery: [], maintenance: { state: "idle", message: null }, coverage: [], briefs } });

test("understand follows planned cursors and prints diagram edges", async () => {
  const api = fakeApi({ [root]: withBriefs([briefWith(diagram("System shape", [["a", "b"]]))]),
    [`${root}/planned?repository=repo`]: { items: [fullPlan("p1")], next: "c2" },
    [`${root}/planned?repository=repo&cursor=c2`]: { items: [fullPlan("p2")], next: null } });
  const out = await runUnderstand(api, { "--workspace": "w" });
  assert.match(out, /Repository brief repo · ready · head a+\n\s*Repo summary/);
  assert.match(out, /Diagram System shape \(2 nodes, 1 edges\)\n\s*a -> b/);
  assert.match(out, /p1 full text/);
  assert.match(out, /p2 full text/);
});

test("understand reports an unparsed diagram instead of edges", async () => {
  const broken = { ...diagram("Broken", []), parseError: "unexpected token" };
  const api = fakeApi({ [root]: withBriefs([briefWith(broken)]), [`${root}/planned?repository=repo`]: { items: [], next: null } });
  assert.match(await runUnderstand(api, { "--workspace": "w" }), /Diagram Broken \(0 nodes, 0 edges\)\n\s*diagram not parsed: unexpected token/);
});

test("a repeating planned cursor stops paging and is reported as unavailable", async () => {
  const api = fakeApi({ [root]: withBriefs([]), [`${root}/planned?repository=repo`]: { items: [], next: "c" }, [`${root}/planned?repository=repo&cursor=c`]: { items: [], next: "c" } });
  assert.match(await runUnderstand(api, { "--workspace": "w" }), /Planned requests unavailable: The host returned a repeating page cursor/);
});

test("JSON mode emits the overview plus briefs, complete planned pages and the generated catalog", async () => {
  const overview = withBriefs([briefWith(diagram("S", [["a", "b"]]))]);
  const api = fakeApi({ [root]: overview,
    [`${root}/planned?repository=repo`]: { items: [fullPlan("p1")], next: null },
    [`${root}/generated`]: { projects: [{ id: "g1", name: "G", repositoryIds: ["repo"], planIds: [], basis: "repository" }], plans: [], next: "g2", coverage: ["c"] },
    [`${root}/generated?cursor=g2`]: { projects: [], plans: [], next: null, coverage: ["c"] } });
  const printed = JSON.parse(await runUnderstand(api, { "--workspace": "w", "--json": true, "--client-config": "client.json" }));
  const { briefs, planned, generated, ...overviewOnly } = printed;
  assert.deepEqual(overviewOnly, overview);
  assert.deepEqual(printed.planned, { repo: [fullPlan("p1")] });
  assert.deepEqual(printed.briefs, overview.knowledge.briefs);
  assert.equal(printed.generated.projects[0].id, "g1");
  assert.equal(printed.generated.next, null);
  assert.deepEqual(printed.generated.coverage, ["c"]);
  assert.deepEqual(printed.workspace, overview.workspace);
});

test("a failing planned request keeps the overview and falls back to its excerpts", async () => {
  const api = fakeApi({ [root]: withBriefs([]) });
  const out = await runUnderstand(api, { "--workspace": "w" });
  assert.match(out, /Understanding · Sample \(w\)/);
  assert.match(out, /Planned: Fix the build/);
  assert.match(out, /Planned requests unavailable: unexpected request/);
  const json = JSON.parse(await runUnderstand(api, { "--workspace": "w", "--json": true }));
  assert.equal(json.generated, null);
  assert.match(json.generatedUnavailable, /unexpected request/);
  assert.equal(json.repositories[0].id, "repo");
});

test("understand generated follows cursors and lists projects and plans", async () => {
  const api = fakeApi({ [`${root}/generated`]: { projects: [{ id: "g1", name: "Gen", repositoryIds: ["repo"], planIds: ["x"], basis: "repository" }], plans: [], next: "n", coverage: [] },
    [`${root}/generated?cursor=n`]: { projects: [], plans: [{ id: "x", workId: "m", kind: "mission", title: "Plan X", objective: "", repositoryIds: ["repo"], status: "ready", column: "review", outcome: null, links: [], updatedAt: "t", basis: "work" }], next: null, coverage: [] } });
  const out = await runUnderstand(api, { "--workspace": "w" }, ["generated"]);
  assert.match(out, /Project g1 · Gen/);
  assert.match(out, /Plan x · review\/ready · Plan X/);
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

test("behavior-run sends the exact caller request identity and emits the returned run unchanged", async () => {
  const response = storedBehavior();
  const calls: unknown[][] = [];
  let printed = "";
  const log = console.log;
  console.log = value => { printed = String(value); };
  try {
    await handleUnderstandingCommand(["behavior-run", "login-flow"], { "--workspace": "sample", "--revision": "1", "--request-id": "123e4567-e89b-42d3-a456-426614174000", "--json": true }, {
      json: async (...args: unknown[]) => { calls.push(args); return response; },
    } as never);
  } finally { console.log = log; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "/project-groups/sample/understanding/behaviors/login-flow/run");
  assert.deepEqual(calls[0]?.[1], { requestId: "123e4567-e89b-42d3-a456-426614174000", revision: 1 });
  assert.equal(calls[0]?.[4], "POST");
  assert.deepEqual(JSON.parse(printed), response);
});

test("behavior text preserves source assumptions, checker limits, and ordered replay evidence", async () => {
  const response = storedBehavior();
  let printed = "";
  const log = console.log;
  console.log = value => { printed += `${String(value)}\n`; };
  try {
    await handleUnderstandingCommand(["behavior", "login-flow"], { "--workspace": "sample" }, { json: async () => response });
  } finally { console.log = log; }
  const idle = printed.indexOf("1. locked");
  const open = printed.indexOf("2. open");
  assert.ok(idle >= 0 && open > idle, "counterexample steps remain in causal order");
  assert.match(printed, /source snapshot snapshot-1/);
  assert.match(printed, /Assumption: The identity provider response is trusted after signature verification/);
  assert.match(printed, /Limits: 100 states · 200 transitions · 1000 ms · 20 trace steps/);
  assert.match(printed, /accepted · safety · failed · Authorization required/);
  assert.match(printed, /authorization-required/);
  assert.match(printed, /does not prove the implementation/);
});

test("CLI keeps old-definition results as raw history without current property associations", async () => {
  const response = storedBehavior();
  response.revision = 2;
  response.definition.current.states[0] = { id: "secured", label: "Secured under the newer definition" };
  response.runs[0]!.planned = structuredClone(response.runs[0]!.current);
  response.runs[0]!.planned!.modelHash = "c".repeat(64);
  response.definition.planned = null;
  let printed = "";
  const log = console.log;
  console.log = value => { printed += `${String(value)}\n`; };
  try {
    await handleUnderstandingCommand(["behavior", "login-flow"], { "--workspace": "sample" }, { json: async () => response });
  } finally { console.log = log; }
  assert.match(printed, /definition revision 1 · historical definition; model\/property associations are unavailable/);
  assert.match(printed, /Historical property authorization-required · failed/);
  assert.match(printed, /1\. locked.*2\. open/s);
  assert.doesNotMatch(printed, /Property authorization-required · accepted/);
  assert.doesNotMatch(printed, /State secured · Secured under the newer definition/);
  assert.match(printed, /Planned historical result · counterexample · model is absent from the active definition[\s\S]*Historical property authorization-required · failed/);
});

test("behavior commands accept stable IDs containing dots and colons", async () => {
  const response = storedBehavior();
  response.id = "account:flow.v2";
  let requested = "";
  const log = console.log;
  console.log = () => {};
  try {
    await handleUnderstandingCommand(["behavior", "account:flow.v2"], { "--workspace": "sample", "--json": true }, {
      json: async path => { requested = path; return response; },
    });
  } finally { console.log = log; }
  assert.equal(requested, "/project-groups/sample/understanding/behaviors/account%3Aflow.v2");
});

test("behavior-save validates the definition and posts one explicit revisioned payload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "understanding-behavior-"));
  const file = join(directory, "definition.json");
  const definition = behaviorDefinition();
  writeFileSync(file, JSON.stringify(definition));
  const response = storedBehavior();
  const calls: unknown[][] = [];
  const log = console.log;
  console.log = () => {};
  try {
    await handleUnderstandingCommand(["behavior-save"], { "--workspace": "sample", "--revision": "0", "--request-id": "123e4567-e89b-42d3-a456-426614174000", "--file": file, "--json": true }, {
      json: async (...args: unknown[]) => { calls.push(args); return response; },
    } as never);
  } finally { console.log = log; rmSync(directory, { recursive: true, force: true }); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "/project-groups/sample/understanding/behaviors");
  assert.deepEqual(calls[0]?.[1], { requestId: "123e4567-e89b-42d3-a456-426614174000", revision: 0, definition });
  assert.equal(calls[0]?.[4], "POST");
});

test("behavior-suite GET keeps the safe exported files and local-check instruction", async () => {
  const suite: BehaviorSuite = { schemaVersion: 1, files: [{ path: "tests/login.behavior.json", content: "{\"schemaVersion\":1}" }], coverage: ["1 property"] };
  let requested = "";
  let printed = "";
  const log = console.log;
  console.log = value => { printed += `${String(value)}\n`; };
  try {
    await handleUnderstandingCommand(["behavior-suite", "login-flow"], { "--workspace": "sample" }, { json: async path => { requested = path; return suite; } });
  } finally { console.log = log; }
  assert.equal(requested, "/project-groups/sample/understanding/behaviors/login-flow/suite");
  assert.match(printed, /tests\/login\.behavior\.json/);
  assert.match(printed, /infinite understand check --file definition\.json --json/);
});

test("local check runs without an API and exits successfully only when both requested models pass", async () => {
  const directory = mkdtempSync(join(tmpdir(), "understanding-check-"));
  const file = join(directory, "definition.json");
  writeFileSync(file, JSON.stringify(behaviorDefinition()));
  let printed = "";
  const log = console.log;
  const originalExitCode = process.exitCode;
  console.log = value => { printed = String(value); };
  try {
    assert.equal(await handleLocalBehaviorCheckCommand(["understand", "check", "--file", file, "--json"]), true);
    const output = JSON.parse(printed) as { current: { status: string }; planned: null };
    assert.equal(output.current.status, "passed");
    assert.equal(output.planned, null);
    assert.equal(process.exitCode, 0);
  } finally { console.log = log; process.exitCode = originalExitCode; rmSync(directory, { recursive: true, force: true }); }
});

test("local check returns a counterexample and nonzero exit status for a failed property", async () => {
  const directory = mkdtempSync(join(tmpdir(), "understanding-check-"));
  const file = join(directory, "definition.json");
  writeFileSync(file, JSON.stringify(behaviorDefinition(true)));
  let printed = "";
  const log = console.log;
  const originalExitCode = process.exitCode;
  console.log = value => { printed = String(value); };
  try {
    await handleLocalBehaviorCheckCommand(["understand", "check", "--file", file, "--json"]);
    const output = JSON.parse(printed) as { current: { status: string; properties: { status: string; trace: { state: string }[] }[] } };
    assert.equal(output.current.status, "counterexample");
    assert.equal(output.current.properties[0]?.status, "failed");
    assert.deepEqual(output.current.properties[0]?.trace.map(step => step.state), ["locked", "open"]);
    assert.equal(process.exitCode, 1);
  } finally { console.log = log; process.exitCode = originalExitCode; rmSync(directory, { recursive: true, force: true }); }
});
