import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPSULE_MAX_BYTES, buildCapsule, captureStart, capsuleBytes, evalTestPath, laterChange, promotion, referenceVerdict, startVerdict,
  type PromotionFacts,
} from "../packages/host/src/eval-rules.js";
import type { OutcomeRow } from "../packages/host/src/outcome-store.js";
import type { TeamBrief, TeamMember, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";

const COMMIT = "c".repeat(40);
const HEAD = "d".repeat(40);
const MEMBER_START = "2026-11-13T10:01:30.000Z";

function implementer(run: TeamRun, startedAt: string | null = MEMBER_START): TeamMember {
  const found = run.members.find(member => member.memberId === hostEntryIds.implA);
  if (!found) throw new Error("fixture member missing");
  return startedAt === null ? { ...found, startedAt: undefined } : { ...found, startedAt };
}

function integratedTask(run: TeamRun): TeamTask {
  const found = run.tasks.find(task => task.id === "a");
  if (!found) throw new Error("fixture task missing");
  return found;
}

function brief(uiChanges: boolean): TeamBrief {
  return {
    title: "Brief", problem: "Problem", evidence: [{ source: "src", observation: "obs" }], dataShape: "shape",
    acceptance: ["done"], expectedOutcome: "outcome", uiChanges,
  };
}

function facts(run: TeamRun) {
  return { commit: COMMIT, head: HEAD, at: "2026-11-13T10:10:00.000Z" };
}

const EMPTY_OBJECTIVE = "";

function capsuleSize(run: TeamRun, objective: string): number {
  const capsule = buildCapsule({ ...run, objective }, integratedTask(run), implementer(run));
  if (capsule === null) throw new Error("capsule missing");
  return capsuleBytes(capsule);
}

function row(overrides: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    outcomeId: "o".repeat(64), source: "production", projectRef: "p".repeat(64), taskRef: "t".repeat(64),
    areaRef: "a".repeat(64), runId: hostEntryIds.run, revision: 1, memberId: hostEntryIds.implA, sessionId: null,
    attemptIndex: 0, inherited: false, role: "implementer", profileId: "impl", provider: "claude", model: "m",
    effort: null, profileEpoch: 1, configId: null, experimentRef: null, kind: "feature", risk: "normal",
    featureVersion: 1, disposition: "integrated", exclusion: null, flags: [], integrated: 1, accepted: 1,
    acceptance: 1, firstPass: 1, held: null, startedAt: null, endedAt: null, frozenAt: "2026-11-13T11:00:00.000Z",
    holdUntil: null, runDeletedAt: null,
    payload: { projectId: "project-one", taskId: "a", area: "host", featureMap: "f", rounds: { run: 0, attributed: 0, unknown: 0 }, limitEvents: 0, costCoverage: "none" },
    ...overrides,
  };
}

function promotionFacts(overrides: Partial<PromotionFacts> = {}): PromotionFacts {
  return {
    state: "captured", material: "stored", approval: "read", base: "proven", runDeletedAt: null,
    payload: {
      projectId: "project-one", anchorCommit: HEAD, memberBaseCommit: HEAD, commit: COMMIT, integratedHead: HEAD,
      files: ["a.txt"], hiddenFiles: ["tests/a.test.ts"], laterFiles: ["b.txt"],
    },
    ...overrides,
  };
}

test("a capsule keeps only what came before the member started", () => {
  const run = hostEntryRun();
  const task = integratedTask(run);

  const early = buildCapsule(run, task, implementer(run, "2026-11-13T10:01:30.000Z"));
  assert.ok(early);
  assert.deepEqual(early.steering, ["Keep the API stable"]);
  assert.deepEqual(early.ownerAnswers, []);

  const late = buildCapsule(run, task, implementer(run, "2026-11-13T10:05:00.000Z"));
  assert.ok(late);
  assert.deepEqual(late.steering, ["Keep the API stable", "Prefer small PRs"]);
  assert.deepEqual(late.ownerAnswers, [{ question: "Which store?", answer: "Use SQLite" }]);
  assert.deepEqual(late.task, { id: "a", title: "Task a", instructions: "Write a.txt", paths: ["a.txt"] });

  assert.equal(buildCapsule(run, task, implementer(run, null)), null);
});

test("a capsule keeps the goal's other fields and leaves out its criteria rows", () => {
  const base = hostEntryRun();
  const goal = {
    id: "7d2c1f3e-5a4b-4c6d-8e9f-0a1b2c3d4e5f", revision: 1, cycle: 1, successCriteria: "Tests pass", nonGoals: [], allowedPaths: ["."],
    evidence: [], previousWork: [], deadlineAt: "2026-11-14T10:00:00.000Z", maxMembers: 4,
    criteria: [{ criterion: "c0", status: "not-met", check: "npm test" }],
  } as unknown as NonNullable<TeamRun["goal"]>;
  const run = { ...base, goal };
  const capsule = buildCapsule(run, integratedTask(run), implementer(run, "2026-11-13T10:05:00.000Z"));
  const { criteria: _criteria, ...expected } = goal;
  assert.deepEqual(capsule?.goal, expected);
  assert.equal(Object.hasOwn(capsule?.goal ?? {}, "criteria"), false);
});

test("a start is refused before any read", () => {
  const run = hostEntryRun();
  const start = (objective: string, uiChanges = false) => captureStart(
    { ...run, objective, brief: uiChanges ? brief(true) : undefined }, integratedTask(run), implementer(run), facts(run),
  );

  assert.equal(startVerdict({ ...start(EMPTY_OBJECTIVE, true), capsule: null }, {}, undefined), "ui-changes");
  assert.equal(startVerdict({ ...start(EMPTY_OBJECTIVE), capsule: null }, {}, undefined), "start-unknown");

  const base = capsuleSize(run, EMPTY_OBJECTIVE);
  const fits = start("x".repeat(CAPSULE_MAX_BYTES - base));
  const over = start("x".repeat(CAPSULE_MAX_BYTES - base + 1));
  assert.equal(capsuleBytes(fits.capsule!), CAPSULE_MAX_BYTES);
  assert.equal(startVerdict(fits, {}, undefined), undefined);
  assert.equal(startVerdict(over, {}, undefined), "capsule-too-large");

  const plain = start(EMPTY_OBJECTIVE);
  const map = { areas: [{ id: "host", paths: ["packages/host"] }] };
  assert.equal(startVerdict(plain, { excludeAreas: ["web"] }, map), "excluded-area-unknown");
  assert.equal(startVerdict(plain, { excludeAreas: ["web"] }, undefined), "excluded-area-unknown");
  assert.equal(startVerdict(plain, { excludeAreas: ["host"] }, map), undefined);
});

test("the reference verdict", () => {
  const ok = referenceVerdict({ state: "read", names: ["tests/y.test.ts", "a.txt"] }, {}, undefined);
  assert.deepEqual(ok, { files: ["a.txt", "tests/y.test.ts"], hiddenFiles: ["tests/y.test.ts"] });

  assert.deepEqual(referenceVerdict({ state: "read", names: ["tests/y.test.ts"] }, {}, undefined), { reason: "no-hidden-tests" });
  assert.deepEqual(referenceVerdict({ state: "read", names: ["a.txt"] }, {}, undefined), { reason: "no-hidden-tests" });

  const wide = Array.from({ length: 501 }, (_, i) => `f${i}.txt`);
  assert.deepEqual(referenceVerdict({ state: "read", names: wide }, {}, undefined), { reason: "reference-too-wide" });
  assert.deepEqual(referenceVerdict({ state: "too-wide" }, {}, undefined), { reason: "reference-too-wide" });
  assert.deepEqual(referenceVerdict({ state: "failed" }, {}, undefined), { reason: "capture-failed" });

  const map = { areas: [{ id: "web", paths: ["apps/web"] }] };
  assert.deepEqual(
    referenceVerdict({ state: "read", names: ["apps/web/a.ts", "apps/web/a.test.ts"] }, { excludeAreas: ["web"] }, map),
    { reason: "excluded-area" },
  );

  const configured = { prefixes: ["spec"], suffixes: ["_test.go"] };
  assert.equal(evalTestPath("spec/a.rb", configured), true);
  assert.equal(evalTestPath("pkg/x_test.go", configured), true);
  assert.equal(evalTestPath("specs/a.rb", configured), false);
  assert.equal(evalTestPath("tests/y.test.ts", configured), false);
  assert.equal(evalTestPath("tests/y.test.ts", undefined), true);
});

test("later changes", () => {
  assert.equal(laterChange(["a", "b"], ["c"]), "none");
  assert.equal(laterChange(["a", "b"], ["b"]), "changed");
  assert.equal(laterChange(["a", "b"], []), "none");
  assert.equal(laterChange(["a", "b"], undefined), "unknown");
});

test("promotion follows the ledger's decision rule", () => {
  assert.deepEqual(promotion(promotionFacts({ material: "pending" }), row()), { kind: "wait" });
  assert.deepEqual(promotion(promotionFacts({ approval: "pending" }), row()), { kind: "wait" });
  assert.deepEqual(promotion(promotionFacts({ base: "pending" }), row()), { kind: "wait" });
  assert.deepEqual(promotion(promotionFacts(), row({ disposition: "open" })), { kind: "wait" });
  assert.deepEqual(promotion(promotionFacts(), row({ frozenAt: null })), { kind: "wait" });

  assert.deepEqual(promotion(promotionFacts({ runDeletedAt: "2026-11-14T00:00:00.000Z" }), undefined), { kind: "reject", reason: "ledger-missing" });
  assert.deepEqual(promotion(promotionFacts({ state: "candidate", runDeletedAt: "2026-11-14T00:00:00.000Z" }), undefined), { kind: "wait" });
  assert.deepEqual(promotion(promotionFacts(), undefined), { kind: "wait" });

  assert.deepEqual(promotion(promotionFacts(), row({ flags: ["backfilled"] })), { kind: "reject", reason: "ledger-withheld" });
  assert.deepEqual(promotion(promotionFacts(), row({ flags: ["gap"] })), { kind: "reject", reason: "ledger-withheld" });
  assert.deepEqual(promotion(promotionFacts(), row({ exclusion: "owner" })), { kind: "reject", reason: "excluded" });

  assert.deepEqual(promotion(promotionFacts(), row({ flags: ["same-model-review"] })), { kind: "reject", reason: "same-model-review" });
  assert.deepEqual(promotion(promotionFacts(), row({ accepted: 0, held: 0 })), { kind: "reject", reason: "not-accepted" });
  assert.deepEqual(promotion(promotionFacts(), row({ accepted: null })), { kind: "reject", reason: "acceptance-unknown" });

  assert.deepEqual(promotion(promotionFacts({ material: "partial" }), row()), { kind: "reject", reason: "patch-missing" });
  assert.deepEqual(promotion(promotionFacts({ approval: null }), row()), { kind: "reject", reason: "reference-unknown" });
  assert.deepEqual(promotion(promotionFacts({ approval: "unknown" }), row()), { kind: "reject", reason: "reference-unknown" });
  const overlap = promotionFacts({ payload: { ...promotionFacts().payload, files: ["a.txt"], laterFiles: ["a.txt"] } });
  assert.deepEqual(promotion(overlap, row()), { kind: "reject", reason: "reference-ambiguous" });
  assert.deepEqual(promotion(promotionFacts({ base: "not-proven" }), row()), { kind: "reject", reason: "base-not-proven" });

  assert.deepEqual(promotion(promotionFacts(), row({ risk: "unknown" })), { kind: "reject", reason: "features-unknown" });
  assert.deepEqual(promotion(promotionFacts(), row()), {
    kind: "candidate",
    features: { role: "implementer", area: "host", kind: "feature", risk: "normal", featureVersion: 1 },
  });
});
