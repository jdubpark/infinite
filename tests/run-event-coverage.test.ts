import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { MEMBER_STOP_REASONS } from "../packages/host/src/run-events.js";
import { teamReportSchema, type TeamReport } from "../packages/host/src/team-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

const spec = readFileSync(fileURLToPath(new URL("../docs/superpowers/specs/2026-11-12-outcome-ledger-design.md", import.meta.url)), "utf8");
const teamsSource = readFileSync(fileURLToPath(new URL("../packages/host/src/teams.ts", import.meta.url)), "utf8");

const LITERAL_KIND = /^"[a-z.-]+"$/;

/** Kinds named in the first cell of each row of the part 1 table. */
function specKinds(): string[] {
  const start = spec.indexOf("### Part 1."), end = spec.indexOf("### Part 2.");
  assert.ok(start >= 0 && end > start, "the spec has a part 1 table");
  return spec.slice(start, end).split("\n")
    .map(line => /^\| `([a-z.-]+)` \|/.exec(line)?.[1])
    .filter((kind): kind is string => kind !== undefined);
}

test("every spec event kind has an emission site, and every emitted kind is in the spec", () => {
  const calls = [...teamsSource.matchAll(/this\.emit(?:With)?\(\s*[\w.]+\s*,\s*([^,\s)]+)/g)];
  const emitted = calls.filter(call => LITERAL_KIND.test(call[1]!)).map(call => call[1]!.slice(1, -1));
  const computed = calls.filter(call => !LITERAL_KIND.test(call[1]!)).map(call => call[0]);
  // The one forwarding call inside emitWith is the only place a kind is passed on as a variable.
  assert.deepEqual(computed, ["this.emit(stored, kind"], "every other emit call names its kind as a literal");

  const declared = specKinds();
  assert.equal(new Set(declared).size, declared.length, "no kind is listed twice");
  assert.equal(declared.length, 26, "the part 1 table lists 26 kinds");
  const sourceKinds = new Set(emitted);
  // Both directions in one assertion, so a failure names every kind on either side.
  assert.deepEqual({
    emittedButNotInSpec: [...sourceKinds].filter(kind => !declared.includes(kind)),
    inSpecButNotEmitted: declared.filter(kind => !sourceKinds.has(kind)),
  }, { emittedButNotInSpec: [], inSpecButNotEmitted: [] }, "the spec table and the emission sites list the same kinds");
});

test("every member.stopped reason has an emission site", () => {
  const sentenceStart = spec.indexOf("The reason classes of `member.stopped`");
  assert.ok(sentenceStart >= 0, "the spec names the member.stopped reason classes");
  const sentence = spec.slice(sentenceStart).split(/\.\s/)[0]!;
  const declared = [...sentence.slice(sentence.indexOf(" are ")).matchAll(/`([a-z-]+)`/g)].map(match => match[1]!);
  assert.deepEqual(declared, [...MEMBER_STOP_REASONS]);

  const stopLiterals = new Set(teamsSource.split("\n")
    .filter(line => line.includes("this.memberStopped("))
    .flatMap(line => [...line.slice(line.indexOf("this.memberStopped(")).matchAll(/"([a-z-]+)"/g)].map(match => match[1]!)));
  for (const reason of MEMBER_STOP_REASONS) assert.ok(stopLiterals.has(reason), `a memberStopped call names ${reason}`);
});

// One sample per report kind. The record type forces an entry for every kind the schema accepts.
const HASH = "a".repeat(40), MERGE = "b".repeat(40), BASE = "c".repeat(40);
const REPORT_SAMPLES: Record<TeamReport["kind"], TeamReport> = {
  "permission-decision": { kind: "permission-decision", decisionId: randomUUID(), verdict: "approve-once", summary: "The check needs the file." },
  plan: { kind: "plan", summary: "One task", tasks: [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [] }] },
  explore: { kind: "explore", summary: "One scout", tasks: [{ id: "scout", title: "Survey", instructions: "Read the module", agentProfileId: "scout-profile" }] },
  findings: { kind: "findings", summary: "Found it", evidence: [{ source: "src/a.ts", observation: "Exports a" }] },
  "no-change": { kind: "no-change", summary: "Already done", evidence: [{ source: "src/a.ts", observation: "Exports a" }] },
  escalate: { kind: "escalate", agentProfileId: "stronger-agent", reason: "Needs more capability" },
  result: { kind: "result", summary: "Wrote a.txt" },
  review: { kind: "review", verdict: "approved", summary: "Looks right" },
  delivery: { kind: "delivery", headCommit: HASH, pullRequestUrl: "https://example.invalid/pull/1", mergeCommit: MERGE, summary: "Merged" },
  "delivery-repair": { kind: "delivery-repair", headCommit: HASH, summary: "Fix the merge" },
  "delivery-reconciliation": { kind: "delivery-reconciliation", headCommit: HASH, repository: "example/app", branch: "feature-a",
    baseHeadCommit: BASE, disposition: "no-publication", summary: "Nothing to publish" },
  "pull-request": { kind: "pull-request", headCommit: HASH, pullRequestUrl: "https://example.invalid/pull/1", summary: "Opened" },
  question: { kind: "question", question: "Which file?", options: [] },
  blocked: { kind: "blocked", summary: "Cannot proceed" },
};

test("every report kind reaches member.reported", async () => {
  const schemaKinds = teamReportSchema.options.map(option => option.shape.kind.value).sort();
  assert.deepEqual(Object.keys(REPORT_SAMPLES).sort(), schemaKinds, "one sample per report kind");
  for (const sample of Object.values(REPORT_SAMPLES)) assert.doesNotThrow(() => teamReportSchema.parse(sample));

  for (const kind of schemaKinds) {
    const f = schedulerFixture();
    const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
    try {
      f.writeTeam();
      const pm = f.run.members[0]!;
      f.report(pm.sessionId, { requestId: randomUUID(), runId: f.run.id, memberId: pm.memberId, revision: pm.revision,
        report: REPORT_SAMPLES[kind as TeamReport["kind"]] });
      const teams = f.openTeam({ events: new EventOutbox(store) });
      const scheduler = teams as unknown as { step(stored: unknown): Promise<void>; record(id: string): unknown };
      await scheduler.step(scheduler.record(f.run.id));
      await teams.idle();
      const reported = store.events({ runId: f.run.id, limit: 50 }).events.filter(event => event.kind === "member.reported");
      assert.equal(reported.length, 1, `one member.reported for ${kind}`);
      assert.equal(reported[0]!.data.reportKind, kind);
    } finally { store.close(); f.close(); }
  }
});
