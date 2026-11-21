import test from "node:test";
import assert from "node:assert/strict";
import { RUBRIC_V1, VERDICT_CONTEXT_BYTES, VERDICT_PROMPT_BYTES, evaluatorPrompt, verdictContext } from "../packages/host/src/verdict-prompt.js";
import { VERDICT_LIMITS, criteriaRowsText } from "../packages/host/src/verdict-types.js";
import type { ObjectiveReceipt } from "../packages/host/src/objective-receipts.js";
import type { ObjectiveRecord } from "../packages/host/src/objective-types.js";
import type { TeamMember, TeamModelProfile, TeamRun } from "../packages/host/src/team-types.js";
import { codexMemberToolInstructions, codexSandboxInstructions, contextAccessInstructions, profileInstructions, readOnlyWorkspaceInstructions, reportingInstructions } from "../packages/host/src/team-prompts.js";

// Markers are built at run time, so the source holds no run-specific text.
const marker = (name: string): string => ["verdict", "marker", name].join("-");
const RUN_ID = "00000000-0000-4000-8000-000000000031";
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const BASE = "c".repeat(40);
const PROFILE: TeamModelProfile = { id: "astra-high", label: "Astra evaluator", provider: "codex", model: "gpt-6-astra", effort: "high" };

const criterion = (id: string, extra: Record<string, unknown> = {}) => ({
  id, origin: "derived", statement: `Statement ${id}.`, check: { kind: "judgement", item: "owner-text" }, producer: "evaluator",
  threshold: { kind: "pass" }, state: "active", ...extra,
});

function recordFixture(): ObjectiveRecord {
  return {
    schemaVersion: 1, owner: { kind: "run", runId: RUN_ID }, version: 4, digest: "digest",
    statement: { objective: "Ship the export.", directions: [{ id: "d1", text: "Keep CSV.", source: "steering", at: "2026-11-16T00:00:00.000Z" }] },
    definitions: [{ id: "t1", term: "export", meaning: "A CSV file." }],
    constraints: { allowedPaths: [], excludedPaths: [], rules: [{ id: "r1", text: "No new dependencies." }] },
    nonGoals: [{ id: "n1", text: "No Excel output." }], ownerEvidence: [],
    criteria: [
      criterion("c0", { origin: "owner", statementOf: "objective", statement: "", check: { kind: "receipt", receipt: "checks-passed" }, producer: "host",
        latest: { state: "met", verdictId: marker("latest") } }),
      criterion("c1", { derivedFrom: marker("derived-from"), pinned: [{ path: marker("pinned-path"), blob: "d".repeat(40) }] }),
      criterion("c2", { state: "retired", statement: marker("retired") }),
    ],
    assumptions: [{ id: "a1", statement: marker("assumption"), status: "assumed", origin: "member", criticality: "plan", refutedBy: marker("refuted"),
      test: { kind: "owner" }, evidence: [], proposals: [{ entryId: "e1", stance: "supports", summary: marker("proposal"), authorRole: "scout" }] }],
    questions: [{ id: "q1", text: marker("question"), assumptions: [], waits: false, state: "open" }],
    rubricVersion: 1,
    log: [{ seq: 1, at: "2026-11-16T00:00:00.000Z", version: 2, actor: "member", authority: "claim", op: "note", target: RUN_ID, handle: marker("log") }],
  } as unknown as ObjectiveRecord;
}

const member = (id: string, role: TeamMember["role"], report: unknown) => ({ memberId: id, role, title: marker("brief"), status: "reported", report }) as unknown as TeamMember;

function runFixture(extra: Record<string, unknown> = {}): TeamRun {
  return {
    id: RUN_ID, revision: 2, projectId: "project", title: "Export", objective: "Ship the export.", status: "reviewing", provider: "claude",
    baseCommit: BASE, headCommit: HEAD,
    members: [
      member("m-impl", "implementer", { kind: "result", summary: marker("member-report") }),
      member("m-scout", "scout", { kind: "findings", summary: marker("finding"), evidence: [] }),
    ],
    steering: [{ text: marker("steering"), revision: 1, at: "2026-11-16T00:00:00.000Z" }],
    decisions: [], tasks: [], events: [{ at: "2026-11-16T00:00:00.000Z", text: marker("event") }],
    routing: { mode: "auto", pin: marker("routing") }, blackboard: { tools: true, digest: marker("blackboard") },
    assessment: { verdictId: marker("assessment"), note: marker("assessment-note") },
    verdicts: [{ id: marker("verdict-row") }],
    changes: { headCommit: HEAD, recordedAt: "2026-11-16T00:00:00.000Z", truncated: false,
      files: [{ path: "src/export.ts", status: "added", added: 10, removed: 0 }, { path: "tests/export.test.ts", status: "added", added: 5, removed: 0 }] },
    checks: [
      { command: { command: "npm", args: ["run", "lint"] }, status: "failed", startedAt: "t", output: marker("check-output"), revision: 2, round: 0, headCommit: OLD_HEAD },
      { command: { command: "npm", args: ["test"] }, status: "passed", startedAt: "t", output: marker("check-output"), revision: 2, round: 1, headCommit: HEAD },
      { command: { command: "npm", args: ["run", "build"] }, status: "failed", startedAt: "t", output: marker("check-output"), revision: 2, round: 1, headCommit: HEAD },
      { command: { command: "npm", args: ["ci"] }, phase: "setup", status: "passed", startedAt: "t", output: "", revision: 2, round: 1, headCommit: HEAD },
      { command: { command: "npm", args: ["run", "old"] }, status: "passed", startedAt: "t", output: "", revision: 1, round: 5, headCommit: HEAD },
    ],
    ...extra,
  } as unknown as TeamRun;
}

const receipt = (handle: string, id: string, commit: string, subject: "criterion" | "assumption" = "criterion"): ObjectiveReceipt => ({
  handle, kind: "command", subject, id, commit, outcome: "pass", at: "2026-11-16T00:00:00.000Z",
  detail: { kind: "command", observed: "passed", round: 1 },
});

test("the evaluator prompt is fixed and bounded", () => {
  assert.equal(VERDICT_PROMPT_BYTES, 8192);
  for (const provider of ["claude", "codex", "opencode"] as const) {
    const prompt = evaluatorPrompt(provider);
    assert.ok(Buffer.byteLength(prompt, "utf8") <= VERDICT_PROMPT_BYTES, `${provider}: at most 8 KiB`);
    assert.ok(Buffer.byteLength(evaluatorPrompt(provider, PROFILE), "utf8") <= VERDICT_PROMPT_BYTES, `${provider}: at most 8 KiB with a profile`);
    assert.ok(prompt.includes('"verdict"'), `${provider}: names the verdict report`);
    for (const state of ["met", "not-met", "inconclusive"]) assert.ok(prompt.includes(`"${state}"`), `${provider}: names ${state}`);
    assert.ok(prompt.includes("receipt:"), `${provider}: names the receipt handle`);
    assert.ok(prompt.includes("file:PATH#Lfrom-Lto"), `${provider}: names the line-range handle`);
    assert.ok(prompt.includes("file:PATH"), `${provider}: names the file handle`);
    for (const limit of [VERDICT_LIMITS.criteria, VERDICT_LIMITS.handles, VERDICT_LIMITS.handleChars, VERDICT_LIMITS.noteBytes]) assert.ok(prompt.includes(String(limit)), `${provider}: names the limit ${limit}`);
    for (const item of RUBRIC_V1) assert.ok(prompt.includes(item), `${provider}: names the rubric item ${item}`);
    assert.ok(prompt.includes(contextAccessInstructions()), `${provider}: context access`);
    assert.ok(prompt.includes(readOnlyWorkspaceInstructions), `${provider}: read-only`);
    assert.ok(prompt.includes(reportingInstructions(provider)), `${provider}: reporting`);
    assert.equal(prompt.includes(codexSandboxInstructions), provider === "codex", `${provider}: sandbox text only for Codex`);
    assert.equal(prompt.includes("Requested runtime profile"), false, `${provider}: no profile line without a profile`);
    const own = [contextAccessInstructions(), readOnlyWorkspaceInstructions, reportingInstructions(provider), codexSandboxInstructions, codexMemberToolInstructions(false)]
      .reduce((text, shared) => text.split(shared).join(""), prompt);
    assert.equal(/implementer|scout|project manager|earlier verdict|previous verdict/i.test(own), false, `${provider}: its own text names no member or earlier verdict`);
  }
  assert.ok(evaluatorPrompt("claude", PROFILE).includes(profileInstructions(PROFILE)), "the profile line is carried");
  assert.equal(evaluatorPrompt("claude"), evaluatorPrompt("claude"), "the same bytes every call");
});

test("the verdict context holds owner text and host facts only", () => {
  const receipts = [
    receipt(`receipt:${RUN_ID}:2:1`, "c0", HEAD),
    receipt(`receipt:${RUN_ID}:2:2`, "c1", OLD_HEAD),
    receipt(`receipt:${RUN_ID}:2:3`, "a1", HEAD, "assumption"),
  ];
  const context = verdictContext({ run: runFixture(), record: recordFixture(), head: HEAD, kind: "reviewed", receipts });
  assert.ok(context, "a context is built");
  assert.equal(context.kind, "verdict-context");
  assert.equal(context.verdictKind, "reviewed");
  assert.equal(context.head, HEAD);
  assert.equal(context.base, BASE);
  assert.equal(context.record.objective, "Ship the export.");
  assert.deepEqual(context.record.directions, ["Keep CSV."]);
  assert.deepEqual(context.record.definitions, [{ term: "export", meaning: "A CSV file." }]);
  assert.deepEqual(context.record.rules, ["No new dependencies."]);
  assert.deepEqual(context.record.nonGoals, ["No Excel output."]);
  assert.deepEqual(context.record.criteria.map(item => item.id), ["c0", "c1"], "active criteria only");
  assert.equal(context.record.criteria[0]!.statement, "Ship the export.", "c0's statement is resolved");
  assert.equal(context.record.criteria[1]!.statement, "Statement c1.");
  assert.equal(context.rubric.version, 1);
  assert.deepEqual([...context.rubric.items], [...RUBRIC_V1]);
  assert.deepEqual(context.changedPaths.paths, ["src/export.ts", "tests/export.test.ts"]);
  assert.equal(context.changedPaths.truncated, false);
  assert.deepEqual(context.checks, [{ name: "npm test", status: "passed" }, { name: "npm run build", status: "failed" }], "the final round at the head, no setup rows");
  assert.equal(context.receipts.length, 1, "criterion receipts at the head only");
  assert.equal(context.receipts[0]!.id, "c0");
  assert.equal(context.receipts[0]!.handle, `receipt:${RUN_ID}:2:1`);
  assert.deepEqual(Object.keys(context.receipts[0]!).sort(), ["handle", "id", "kind", "outcome"]);

  const json = JSON.stringify(context);
  for (const name of ["latest", "derived-from", "pinned-path", "retired", "assumption", "refuted", "proposal", "question", "log", "member-report",
    "finding", "brief", "steering", "event", "routing", "blackboard", "assessment", "assessment-note", "verdict-row", "check-output"]) {
    assert.equal(json.includes(marker(name)), false, `${name} marker is absent`);
  }
  for (const word of ["score", "threshold-count", "evaluator identity"]) assert.equal(json.includes(word), false, `${word} is absent`);
  assert.deepEqual(Object.keys(context.record.criteria[1]!).sort(), ["check", "id", "producer", "statement", "threshold"]);
  assert.deepEqual(Object.keys(context).sort(), ["base", "changedPaths", "checks", "head", "kind", "receipts", "record", "rubric", "verdictKind"]);
});

test("a later round that holds only a failed setup row lists no checks", () => {
  const setup = { command: { command: "npm", args: ["ci"] }, phase: "setup", status: "failed", startedAt: "t", output: "", revision: 2, round: 2, headCommit: HEAD };
  const base = runFixture();
  const run = runFixture({ checks: [...base.checks, setup] });
  const context = verdictContext({ run, record: recordFixture(), head: HEAD, kind: "reviewed" });
  assert.ok(context);
  assert.deepEqual(context.checks, [], "the final round is round 2, and it shows no setup row");
});

test("a change record from another head leaves no changed paths", () => {
  const stale = runFixture({ changes: { headCommit: OLD_HEAD, recordedAt: "t", truncated: false, files: [{ path: "src/old.ts", status: "added", added: 1, removed: 0 }] } });
  const context = verdictContext({ run: stale, record: recordFixture(), head: HEAD, kind: "no-change" });
  assert.ok(context);
  assert.equal(context.verdictKind, "no-change");
  assert.equal(context.changedPaths.paths.length, 0);
  assert.equal(context.changedPaths.truncated, true, "an unknown list is marked incomplete");
  assert.equal(context.receipts.length, 0, "no receipts given");
});

test("an oversized context is undefined", () => {
  const count = 2000;
  const padded = (extra: number) => Array.from({ length: count }, (_, index) => receipt(`receipt:${RUN_ID}:2:${index}:${"é".repeat(extra)}`, "c1", HEAD));
  const build = (extra: number) => verdictContext({ run: runFixture(), record: recordFixture(), head: HEAD, kind: "reviewed", receipts: padded(extra) });
  const plain = build(0);
  assert.ok(plain, "the unpadded context fits");
  const baseChars = JSON.stringify(plain).length;
  assert.ok(baseChars < VERDICT_CONTEXT_BYTES);
  // Pick the padding so the JSON is under the limit in characters and over it in bytes.
  const extra = Math.floor((0.75 * (VERDICT_CONTEXT_BYTES - baseChars)) / count);
  const fits = build(Math.floor(extra / 3));
  assert.ok(fits, "a smaller padding still fits");
  const probe = JSON.stringify({ ...plain, receipts: padded(extra).map(({ handle, kind, id, outcome }) => ({ handle, kind, id, outcome })) });
  assert.ok(probe.length < VERDICT_CONTEXT_BYTES, "under the limit counted as characters");
  assert.ok(Buffer.byteLength(probe, "utf8") > VERDICT_CONTEXT_BYTES, "over the limit counted as bytes");
  assert.equal(build(extra), undefined, "over the limit in bytes is refused, though under it in characters");
});

test("criteria rows print labelled an agent assessment", () => {
  const text = criteriaRowsText([
    { criterion: "c0", status: "met", check: "receipt:checks-passed" },
    { criterion: "c1", status: "pending-owner", check: "owner-rating:taste" },
  ]);
  const lines = text.split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "Agent assessment, provisional, of the previous cycle:");
  assert.equal(lines[1], "- c0: met (receipt:checks-passed)");
  assert.equal(lines[2], "- c1: pending-owner (owner-rating:taste)");
  assert.equal(/note|threshold|count|score/i.test(text), false, "no note, threshold, count, or score");
});
