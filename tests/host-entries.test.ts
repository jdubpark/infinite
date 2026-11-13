import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { entrySummary, hostEntry, hostEntryId, hostEntrySources } from "../packages/host/src/evidence/host-entries.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";

const NOW = "2026-11-13T12:00:00.000Z";
const COMMIT = "c".repeat(40);
const HEAD = "d".repeat(40);
const MISSION = "00000000-0000-4000-8000-0000000000e1";

test("sources follow the record in a fixed order", () => {
  const run = hostEntryRun();
  const before = structuredClone(run);
  const sources = hostEntrySources(run);
  assert.deepEqual(sources, [
    "steering:0",
    "steering:1",
    `answer:${hostEntryIds.d1}`,
    `report:${hostEntryIds.pm}`,
    `report:${hostEntryIds.implA}`,
    `report:${hostEntryIds.rev}`,
    `integration:${hostEntryIds.implA}`,
    "check:0",
  ]);
  for (const source of sources) {
    assert.match(source, /^(steering|check):\d+$|^(answer|report|integration):[0-9a-f-]{36}$/);
  }
  assert.deepEqual(run, before);

  const mission = { ...hostEntryRun(), missionId: MISSION };
  assert.equal(hostEntrySources(mission).some(source => source.startsWith("steering:")), false);
});

test("entry ids are deterministic and opaque", () => {
  const run = hostEntryRun();
  const id = hostEntryId(run.id, "integration", `integration:${hostEntryIds.implA}`);
  assert.equal(hostEntryId(run.id, "integration", `integration:${hostEntryIds.implA}`), id);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(hostEntryId(run.id, "report", `integration:${hostEntryIds.implA}`), id);
  assert.notEqual(hostEntryId(randomUUID(), "integration", `integration:${hostEntryIds.implA}`), id);
});

test("a report entry is a member claim without a rubric", () => {
  const run = hostEntryRun();
  const entry = hostEntry(run, `report:${hostEntryIds.rev}`, NOW);
  assert.ok(entry);
  assert.equal(entry.kind, "report");
  assert.equal(entry.author, "member");
  assert.equal(entry.authority, "claim");
  assert.equal(entry.authorMemberId, hostEntryIds.rev);
  assert.equal(entry.authorRole, "reviewer");
  assert.equal(entry.at, "2026-11-13T10:08:00.000Z");
  assert.equal((entry.body.report as { kind: string }).kind, "review");
  const json = JSON.stringify(entry);
  assert.equal(json.includes("rubric"), false);
  assert.equal(json.includes("correctness"), false);
  assert.equal("status" in entry.body, false);
});

test("an integration entry is a host receipt with no scores", () => {
  const run = hostEntryRun();
  const entry = hostEntry(run, `integration:${hostEntryIds.implA}`, NOW);
  assert.ok(entry);
  assert.deepEqual(entry.body, { taskId: "a", commit: COMMIT, changedPaths: { paths: ["a.txt"], truncated: false } });
  assert.equal(entry.author, "host");
  assert.equal(entry.authority, "receipt");
  assert.equal(entry.taskId, "a");
  assert.equal(entry.at, NOW);
  const json = JSON.stringify(entry);
  assert.equal(json.includes("diffStat"), false);
  assert.equal(json.includes("rubric"), false);
  assert.equal(json.includes("ownerRating"), false);

  const noCommit = structuredClone(run);
  delete noCommit.tasks[0].commit;
  const bare = hostEntry(noCommit, `integration:${hostEntryIds.implA}`, NOW);
  assert.ok(bare);
  assert.equal("commit" in bare.body, false);
  assert.equal(bare.summary, "task a integrated with no change");

  const continued = structuredClone(run);
  const [task] = continued.tasks.splice(0, 1);
  continued.continuations = [{ revision: 3, requestId: randomUUID(), at: NOW, reason: "continue", headCommit: HEAD, tasks: [task] }];
  assert.ok(hostEntrySources(continued).includes(`integration:${hostEntryIds.implA}`));
  assert.equal(hostEntry(continued, `integration:${hostEntryIds.implA}`, NOW)?.taskId, "a");
});

test("a check entry carries its output", () => {
  const run = hostEntryRun();
  const entry = hostEntry(run, "check:0", NOW);
  assert.ok(entry);
  assert.deepEqual(entry.body, {
    command: { command: "npm", args: ["test"] },
    status: "passed",
    exitCode: 0,
    round: 0,
    headCommit: HEAD,
    output: "ok\n",
  });
  assert.equal(entry.at, "2026-11-13T10:10:00.000Z");
  assert.equal(entry.summary, "check passed (exit 0): npm test");

  const setup = structuredClone(run);
  setup.checks[0] = { ...setup.checks[0], phase: "setup", status: "failed", exitCode: 1 };
  assert.match(hostEntry(setup, "check:0", NOW)?.summary ?? "", /^setup failed \(exit 1\)/);

  assert.equal(hostEntry(run, "check:1", NOW), undefined);
});

test("directions come only from the owner", () => {
  const run = hostEntryRun();
  const steering = hostEntry(run, "steering:1", NOW);
  assert.ok(steering);
  assert.deepEqual(steering.body, { source: "steering", text: "Prefer small PRs" });
  assert.equal(steering.revision, 3);
  assert.equal(steering.author, "owner");
  assert.equal(steering.authority, "direction");
  assert.equal("taskId" in steering, false);

  const answer = hostEntry(run, `answer:${hostEntryIds.d1}`, NOW);
  assert.ok(answer);
  assert.deepEqual(answer.body, { source: "answer", question: "Which store?", text: "Use SQLite" });
  assert.equal(answer.author, "owner");
  assert.equal(answer.authority, "direction");

  assert.equal(hostEntry(run, `answer:${hostEntryIds.d2}`, NOW), undefined);
  assert.equal(hostEntry(run, `answer:${hostEntryIds.d3}`, NOW), undefined);
});

test("summaries are one bounded line", () => {
  assert.equal(entrySummary("a\nb\t c\u0007d", "x"), "a b c d");
  assert.equal(entrySummary("é".repeat(300), "x"), "é".repeat(120));
  assert.equal(entrySummary(" \n", "fallback"), "fallback");
  // A 4-byte character that would cross the 240-byte limit is dropped whole.
  const emoji = "\u{1F600}";
  const summary = entrySummary("a".repeat(239) + emoji, "x");
  assert.equal(summary, "a".repeat(239));
  assert.ok(Buffer.byteLength(entrySummary("é".repeat(300) + emoji, "x"), "utf8") <= 240);
});

test("a source the record does not hold builds nothing", () => {
  const run = hostEntryRun();
  const missing = [
    `report:${hostEntryIds.implB}`,
    "check:9",
    `integration:${randomUUID()}`,
    "steering:-1",
    "bogus",
  ];
  for (const source of missing) {
    assert.equal(hostEntry(run, source, NOW), undefined, source);
  }
});
