import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { passReads, passSubjects, receiptsFor } from "../packages/host/src/objective-receipts.js";
import type { BlobResult, PassInput, Subject } from "../packages/host/src/objective-receipts.js";
import type { Assumption, AssumptionTest, Check, Criterion, ObjectiveRecord, Threshold } from "../packages/host/src/objective-types.js";
import type { TeamCheck, TeamCommand } from "../packages/host/src/team-types.js";

const HEAD = "1".repeat(40);
const OTHER = "2".repeat(40);
const AT = "2026-11-18T00:00:00.000Z";
const RANK: TeamCommand = { command: "npm", args: ["run", "rank-verify"] };
const TESTS: TeamCommand = { command: "npm", args: ["test"] };
const RANK_DIGEST = commandDigest(RANK);
const TESTS_DIGEST = commandDigest(TESTS);
const ENTRIES = "research/entries.json";

function record(parts: { criteria?: Criterion[]; assumptions?: Assumption[] }): ObjectiveRecord {
  return {
    schemaVersion: 1, owner: { kind: "run", runId: "run-1" }, version: 1, digest: "0".repeat(64),
    statement: { objective: "Ship the record", directions: [] }, definitions: [],
    constraints: { allowedPaths: [], excludedPaths: [], rules: [] }, nonGoals: [], ownerEvidence: [],
    criteria: parts.criteria ?? [], assumptions: parts.assumptions ?? [], questions: [], rubricVersion: 1, log: [],
  };
}

function criterion(id: string, check: Check, threshold: Threshold = { kind: "pass" }): Criterion {
  return { id, origin: "owner", statement: `Criterion ${id}`, check, producer: "host", threshold, state: "active" };
}

function assumption(id: string, test: AssumptionTest, origin: Assumption["origin"] = "intent-check"): Assumption {
  return { id, statement: `Assumption ${id}`, status: "assumed", origin, criticality: "plan", refutedBy: "The test fails", test, evidence: [], proposals: [] };
}

function check(command: TeamCommand, status: TeamCheck["status"], round?: number, extra: Partial<TeamCheck> = {}): TeamCheck {
  return { command, status, startedAt: AT, output: "", revision: 1, headCommit: HEAD, ...(round === undefined ? {} : { round }), ...extra };
}

function passInput(parts: Partial<PassInput> = {}): PassInput {
  return { runId: "run-1", revision: 1, kind: "reviewed", head: HEAD, at: AT, checks: [], configured: [RANK], blobs: new Map(), ...parts };
}

function receiptsOf(criteria: Criterion[], assumptions: Assumption[], parts: Partial<PassInput> = {}) {
  return receiptsFor(passSubjects(record({ criteria, assumptions }), "reviewed"), passInput(parts));
}

function blobAt(path: string, result: BlobResult, commit = HEAD): Map<string, BlobResult> {
  return new Map([[`${commit}:${path}`, result]]);
}

function json(value: unknown): BlobResult {
  return { state: "read", bytes: Buffer.from(JSON.stringify(value)) };
}

test("command tests read the final round and run nothing", () => {
  const rankFails = [check(RANK, "passed", 1), check(TESTS, "passed", 2), check(RANK, "passed", 2, { phase: "setup" }), check(RANK, "failed", 2)];
  const criteria = [criterion("c1", { kind: "command", command: RANK_DIGEST })];
  const assumptions = [
    assumption("a4", { kind: "command", command: RANK_DIGEST, refutesOn: "fail" }),
    assumption("a5", { kind: "command", command: RANK_DIGEST, refutesOn: "pass" }),
  ];

  const failed = receiptsOf(criteria, assumptions, { checks: rankFails, configured: [RANK, TESTS] });
  const a4 = failed.find(receipt => receipt.id === "a4");
  assert.deepStrictEqual(a4, {
    handle: "receipt:run-1:1:a4", kind: "command", subject: "assumption", id: "a4", commit: HEAD, outcome: "fail", at: AT,
    detail: { kind: "command", observed: "failed", round: 2 },
  });
  assert.equal(failed.find(receipt => receipt.id === "a5")?.outcome, "pass");
  assert.equal(failed.find(receipt => receipt.id === "c1")?.outcome, "fail");

  const passed = receiptsOf(criteria, [], { checks: [check(RANK, "passed", 2)], configured: [RANK] });
  assert.equal(passed[0]?.outcome, "pass");
  assert.deepStrictEqual(passed[0]?.detail, { kind: "command", observed: "passed", round: 2 });

  const unconfigured = receiptsOf([], assumptions.slice(0, 1), { checks: rankFails, configured: [TESTS] });
  assert.deepStrictEqual(unconfigured[0]?.detail, { kind: "command", observed: "not-configured", round: 2 });
  assert.equal(unconfigured[0]?.outcome, "unknown");

  for (const [rows, observed] of [
    [[check(RANK, "interrupted", 2)], "interrupted"],
    [[check(RANK, "running", 2)], "running"],
    [[check(TESTS, "passed", 2)], "absent"],
  ] as const) {
    const receipt = receiptsOf([], assumptions.slice(0, 1), { checks: rows, configured: [RANK] })[0];
    assert.equal(receipt?.outcome, "unknown", observed);
    assert.deepStrictEqual(receipt?.detail, { kind: "command", observed, round: 2 }, observed);
  }

  const source = readFileSync(new URL("../packages/host/src/objective-receipts.ts", import.meta.url), "utf8");
  assert.equal(source.includes("child_process"), false);
});

test("acceptance 5, test side: an artifact test counts qualifying entries", () => {
  const entries = Array.from({ length: 45 }, (_, index) =>
    index < 31 ? { sources: ["research/a.md#L1", `https://example.org/${index}`] } : { sources: ["research/a.md#L1"] });
  const blobs = blobAt(ENTRIES, json({ entries }));
  const a2 = (min: number) => assumption("a2", { kind: "artifact", path: ENTRIES, count: "/entries", citedPerEntry: 2, threshold: { kind: "count", min } });

  const refuted = receiptsOf([], [a2(40)], { blobs })[0];
  assert.deepStrictEqual(refuted, {
    handle: "receipt:run-1:1:a2", kind: "artifact", subject: "assumption", id: "a2", commit: HEAD, outcome: "fail", at: AT,
    detail: { kind: "artifact", read: "read", total: 45, qualifying: 31 },
  });
  assert.equal(receiptsOf([], [a2(30)], { blobs })[0]?.outcome, "pass");
});

test("unknown is never a number", () => {
  const artifact = (threshold: Threshold = { kind: "count", min: 1 }, citedPerEntry?: number): Assumption =>
    assumption("a2", { kind: "artifact", path: ENTRIES, count: "/entries", threshold, ...(citedPerEntry === undefined ? {} : { citedPerEntry }) });
  const cases: { name: string; blob: BlobResult; assumption: Assumption; criteria?: Criterion[] }[] = [
    { name: "too large", blob: { state: "too-large" }, assumption: artifact() },
    { name: "failed", blob: { state: "failed" }, assumption: artifact() },
    { name: "not run, deadline", blob: { state: "not-run", why: "deadline" }, assumption: artifact() },
    { name: "not run, stalled", blob: { state: "not-run", why: "stalled" }, assumption: artifact() },
    { name: "not UTF-8", blob: { state: "read", bytes: Buffer.from([0xff, 0xfe, 0x00]) }, assumption: artifact() },
    { name: "not JSON", blob: { state: "read", bytes: Buffer.from("[1,") }, assumption: artifact() },
    { name: "a pointer to an object", blob: json({ entries: { a: 1 } }), assumption: artifact() },
    { name: "a share with total 0", blob: json({ entries: [] }), assumption: artifact({ kind: "share", min: 0.5 }, 2) },
    { name: "a pass threshold on an assumption", blob: json({ entries: [{ sources: [] }] }), assumption: artifact({ kind: "pass" }) },
    {
      name: "a criterion with schema", blob: json({ entries: [] }), assumption: artifact(),
      criteria: [criterion("c1", { kind: "artifact", path: ENTRIES, schema: "schema.json", count: "/entries" }, { kind: "count", min: 1 })],
    },
  ];
  for (const testCase of cases) {
    const blobs = blobAt(ENTRIES, testCase.blob);
    const receipts = receiptsOf(testCase.criteria ?? [], testCase.criteria ? [] : [testCase.assumption], { blobs });
    const receipt = receipts[0];
    assert.equal(receipt?.outcome, "unknown", testCase.name);
    assert.ok(receipt?.detail.kind === "artifact" || receipt?.detail.kind === "citation", testCase.name);
    assert.equal(Object.hasOwn(receipt?.detail ?? {}, "total"), false, testCase.name);
    assert.equal(Object.hasOwn(receipt?.detail ?? {}, "qualifying"), false, testCase.name);
    assert.equal(Object.hasOwn(receipt?.detail ?? {}, "present"), false, testCase.name);
  }
});

test("citation tests follow refutesOn", () => {
  const blobs = blobAt("docs/a.md", { state: "read", bytes: Buffer.from("a\nhello   world\n") });
  const citation = (source: string, quote: string, refutesOn: "absent" | "present") =>
    assumption("a3", { kind: "citation", source, quote, refutesOn });
  const outcomeOf = (item: Assumption, parts: Partial<PassInput> = {}) => receiptsOf([], [item], parts)[0];

  assert.deepStrictEqual(outcomeOf(citation("docs/a.md#L1-L2", "hello world", "absent"), { blobs }), {
    handle: "receipt:run-1:1:a3", kind: "citation", subject: "assumption", id: "a3", commit: HEAD, outcome: "pass", at: AT,
    detail: { kind: "citation", read: "read", present: true },
  });
  assert.equal(outcomeOf(citation("docs/a.md#L1-L2", "missing", "absent"), { blobs })?.outcome, "fail");
  assert.equal(outcomeOf(citation("docs/a.md#L1-L2", "hello world", "present"), { blobs })?.outcome, "fail");
  assert.equal(outcomeOf(citation("docs/a.md#L1-L2", "missing", "present"), { blobs })?.outcome, "pass");

  const outside = outcomeOf(citation("https://example.com/x", "hello", "absent"), { blobs });
  assert.deepStrictEqual(outside?.detail, { kind: "citation", read: "not-run", problem: "outside-unchecked" });
  assert.equal(outside?.outcome, "unknown");
  const malformed = outcomeOf(citation("../a.md", "hello", "absent"), { blobs });
  assert.deepStrictEqual(malformed?.detail, { kind: "citation", read: "not-run", problem: "malformed" });
  assert.equal(malformed?.outcome, "unknown");

  const pinned = new Map([[`${OTHER}:docs/a.md`, { state: "read", bytes: Buffer.from("hello world") } as BlobResult]]);
  const fromCommit = outcomeOf(citation(`docs/a.md@${OTHER}`, "hello world", "absent"), { blobs: pinned });
  assert.equal(fromCommit?.commit, OTHER);
  assert.equal(fromCommit?.outcome, "pass");
});

test("a pass plans at most 40 subjects and 40 distinct reads", () => {
  const criteria = Array.from({ length: 30 }, (_, index) => criterion(`c${index + 1}`, { kind: "command", command: RANK_DIGEST }));
  const assumptions = [
    ...Array.from({ length: 20 }, (_, index) => assumption(`a${index + 1}`, { kind: "command", command: TESTS_DIGEST, refutesOn: "fail" })),
    assumption("a21", { kind: "command", command: RANK_DIGEST, refutesOn: "fail" }, "member"),
    assumption("a22", { kind: "owner" }, "owner"),
  ];
  const planned = passSubjects(record({ criteria, assumptions }), "reviewed");
  assert.deepStrictEqual(planned.map(subject => subject.id), [
    ...criteria.map(item => item.id),
    ...assumptions.slice(0, 10).map(item => item.id),
  ]);

  const shared = [criterion("c1", { kind: "artifact", path: "data/x.json", count: "/n" }), criterion("c2", { kind: "artifact", path: "data/x.json", count: "/n" })];
  const sharedReads = passReads(passSubjects(record({ criteria: shared }), "reviewed"), HEAD);
  assert.deepStrictEqual(sharedReads, [{ commit: HEAD, path: "data/x.json" }]);

  const many = Array.from({ length: 45 }, (_, index) => criterion(`c${index + 1}`, { kind: "artifact", path: `data/${index}.json` }));
  const manyReads = passReads(passSubjects(record({ criteria: many }), "reviewed"), HEAD);
  assert.equal(manyReads.length, 40);

  const checkSubjects: Subject[] = passSubjects(record({
    criteria: [criterion("c1", { kind: "command", command: RANK_DIGEST }), criterion("c2", { kind: "artifact", path: "data/x.json" })],
    assumptions: [assumption("a1", { kind: "command", command: RANK_DIGEST, refutesOn: "fail" }), assumption("a2", { kind: "artifact", path: "data/x.json", count: "/n", threshold: { kind: "count", min: 1 } })],
  }), "check");
  assert.deepStrictEqual(checkSubjects.map(subject => subject.id), ["c1", "a1"]);
  assert.deepStrictEqual(passReads(checkSubjects, HEAD), []);
});

test("the final round, the pointer, and the thresholds follow the plan", () => {
  const a4Fail = assumption("a4", { kind: "command", command: RANK_DIGEST, refutesOn: "fail" });

  const otherHead = [check(RANK, "failed", 2, { headCommit: OTHER })];
  const reviewed = receiptsOf([], [a4Fail], { checks: otherHead });
  assert.deepStrictEqual(reviewed[0]?.detail, { kind: "command", observed: "absent", round: 2 });
  assert.equal(reviewed[0]?.outcome, "unknown");

  const checkPass = receiptsFor(passSubjects(record({ assumptions: [a4Fail] }), "check"), passInput({ kind: "check", checks: otherHead }));
  assert.equal(checkPass[0]?.outcome, "fail");
  assert.equal(checkPass[0]?.commit, OTHER);
  assert.deepStrictEqual(checkPass[0]?.detail, { kind: "command", observed: "failed", round: 2 });

  const otherRevision = [check(RANK, "passed", 1), check(RANK, "failed", 3, { revision: 2 })];
  const revisionOne = receiptsOf([], [a4Fail], { checks: otherRevision });
  assert.deepStrictEqual(revisionOne[0]?.detail, { kind: "command", observed: "passed", round: 1 });
  assert.equal(revisionOne[0]?.outcome, "pass");

  const noRound = receiptsOf([], [a4Fail], { checks: [check(RANK, "failed"), check(RANK, "passed", 1)] });
  assert.deepStrictEqual(noRound[0]?.detail, { kind: "command", observed: "passed", round: 1 });
  assert.equal(noRound[0]?.outcome, "pass");

  const entries = Array.from({ length: 45 }, (_, index) =>
    index < 31 ? { sources: ["research/a.md#L1", `https://example.org/${index}`] } : { sources: ["research/a.md#L1"] });
  const blobs = blobAt(ENTRIES, json({ entries }));
  const artifact = (threshold: Threshold, citedPerEntry?: number) => assumption("a2", {
    kind: "artifact", path: ENTRIES, count: "/entries", threshold, ...(citedPerEntry === undefined ? {} : { citedPerEntry }),
  });
  const outcome = (item: Assumption) => receiptsOf([], [item], { blobs })[0]?.outcome;
  assert.equal(outcome(artifact({ kind: "count", max: 30 }, 2)), "fail");
  assert.equal(outcome(artifact({ kind: "count", max: 31 }, 2)), "pass");
  assert.equal(outcome(artifact({ kind: "share", min: 0.6 }, 2)), "pass");
  assert.equal(outcome(artifact({ kind: "share", min: 0.7 }, 2)), "fail");

  const total45 = receiptsOf([], [artifact({ kind: "count", min: 45 })], { blobs })[0];
  assert.deepStrictEqual(total45?.detail, { kind: "artifact", read: "read", total: 45 });
  assert.equal(total45?.outcome, "pass");
  assert.equal(outcome(artifact({ kind: "count", min: 46 })), "fail");

  const noCount = receiptsOf([criterion("c1", { kind: "artifact", path: ENTRIES })], [], { blobs });
  assert.equal(noCount[0]?.outcome, "pass");
  assert.deepStrictEqual(noCount[0]?.detail, { kind: "artifact", read: "read" });

  const nested = blobAt(ENTRIES, json({ "a/b": [{ "x~y": [1, 2, 3] }] }));
  const pointer = (path: string) => receiptsOf([], [assumption("a2", { kind: "artifact", path: ENTRIES, count: path, threshold: { kind: "count", min: 1 } })], { blobs: nested })[0];
  assert.deepStrictEqual(pointer("/a~1b/0/x~0y")?.detail, { kind: "artifact", read: "read", total: 3 });
  assert.deepStrictEqual(pointer("/a~1b/first/x~0y")?.detail, { kind: "artifact", read: "read", problem: "no-array" });
  assert.equal(pointer("/a~1b/first/x~0y")?.outcome, "unknown");

  const retired: Criterion = { ...criterion("c1", { kind: "command", command: RANK_DIGEST }), state: "retired" };
  assert.deepStrictEqual(passSubjects(record({ criteria: [retired] }), "reviewed").map(subject => subject.id), []);
});

test("member and owner tests are never planned, reads keep their own cap, and a missing blob is a deadline", () => {
  const planned = passSubjects(record({
    criteria: [criterion("c1", { kind: "command", command: RANK_DIGEST })],
    assumptions: [
      assumption("a1", { kind: "command", command: RANK_DIGEST, refutesOn: "fail" }, "member"),
      assumption("a2", { kind: "owner" }, "owner"),
      assumption("a3", { kind: "command", command: RANK_DIGEST, refutesOn: "fail" }, "owner"),
    ],
  }), "reviewed");
  assert.deepStrictEqual(planned.map(subject => subject.id), ["c1", "a3"]);

  const subjects: Subject[] = Array.from({ length: 45 }, (_, index) => ({
    subject: "criterion", id: `c${index + 1}`, check: { kind: "artifact", path: `data/${index}.json` }, threshold: { kind: "pass" },
  }));
  assert.equal(passReads(subjects, HEAD).length, 40);

  const [missing] = receiptsOf([], [assumption("a2", { kind: "artifact", path: ENTRIES, count: "/entries", threshold: { kind: "count", min: 1 } })]);
  assert.equal(missing?.outcome, "unknown");
  assert.deepStrictEqual(missing?.detail, { kind: "artifact", read: "not-run", problem: "deadline" });
});
