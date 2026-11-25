import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceDeliveryReviewLineage,
  automaticMergeReviewReason,
  deliveryReviewLineageAtBase,
  inheritDeliveryReviewLineage,
  includeDeliveryReviewContributors,
  potentialRecoveryContributorFamilies,
  rebaseDeliveryReviewLineage,
  workspaceContributorFamilies,
  type DeliveryReviewApproval,
  type DeliveryReviewLineage,
} from "../packages/host/src/delivery-review.js";
import type { TeamMember } from "../packages/host/src/team-types.js";

const BASE = "1".repeat(40), HEAD = "2".repeat(40), NEXT = "3".repeat(40);
const approvedReview = { verdict: "approved", summary: "Reviewed the checked head.", revision: 4 } as const;

function reviewer(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    runId: "run", memberId: "reviewer-1", revision: 4, role: "reviewer", provider: "opencode",
    modelProfile: { id: "muse-reviewer", label: "Muse reviewer", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high" },
    sessionId: "session", title: "reviewer", status: "stopped", cwd: "members/reviewer", baseCommit: HEAD,
    prompt: "", cursor: 0, stopRequestId: "stop", report: { kind: "review", verdict: "approved", summary: "Reviewed the checked head." },
    ...overrides,
  };
}

function approval(overrides: Partial<DeliveryReviewApproval> = {}): DeliveryReviewApproval {
  return { reviewerMemberId: "reviewer-1", revision: 4, round: 2, headCommit: HEAD, ...overrides };
}

function gate(lineage: DeliveryReviewLineage, members: TeamMember[] = [reviewer()], accepted = approval(), runOverrides: Record<string, unknown> = {}) {
  const headCommit = accepted.headCommit;
  return automaticMergeReviewReason({
    run: { headCommit, revision: 4, round: 2, checkHead: headCommit, review: approvedReview, ...runOverrides } as never,
    lineage,
    approval: accepted,
    members,
  });
}

test("a validated reviewer from a different known family can approve the exact integrated head", () => {
  const lineage = advanceDeliveryReviewLineage(deliveryReviewLineageAtBase(BASE), {
    headBefore: BASE, headAfter: HEAD, contributorFamilies: ["gpt"],
  });
  assert.deepEqual(lineage, { headCommit: HEAD, families: ["gpt"], unknown: false });
  assert.equal(gate(lineage), undefined);
});

test("a known but same-family reviewer cannot authorize automatic merge", () => {
  const lineage = { headCommit: HEAD, families: ["muse"], unknown: false };
  assert.equal(gate(lineage), "reviewer-family-required");
});

test("fallback and partial-work contributor families both remain in the checked-head lineage", () => {
  const first = advanceDeliveryReviewLineage(deliveryReviewLineageAtBase(BASE), {
    headBefore: BASE, headAfter: HEAD, contributorFamilies: ["claude", "deepseek"],
  });
  const repaired = advanceDeliveryReviewLineage(first, {
    headBefore: HEAD, headAfter: NEXT, contributorFamilies: ["gpt"],
  });
  assert.deepEqual(repaired, { headCommit: NEXT, families: ["claude", "deepseek", "gpt"], unknown: false });

  const approvedByMuse = gate(repaired, [reviewer({ baseCommit: NEXT })], approval({ headCommit: NEXT }));
  assert.equal(approvedByMuse, undefined, "the actual fallback and integrator families are all covered");

  const approvedByClaude = gate(repaired, [reviewer({ baseCommit: NEXT, modelProfile: {
    id: "claude-reviewer", label: "Claude reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high",
  } })], approval({ headCommit: NEXT }));
  assert.equal(approvedByClaude, "reviewer-family-required");
});

test("a missing non-base predecessor record and an unknown contributor fail closed", () => {
  const missing = advanceDeliveryReviewLineage(undefined, {
    headBefore: HEAD, headAfter: NEXT, contributorFamilies: ["gpt"],
  });
  assert.equal(missing.unknown, true);
  assert.equal(gate(missing, [reviewer({ baseCommit: NEXT })], approval({ headCommit: NEXT })), "reviewer-family-required");

  const unknownAuthor = advanceDeliveryReviewLineage(deliveryReviewLineageAtBase(BASE), {
    headBefore: BASE, headAfter: HEAD, contributorFamilies: [undefined],
  });
  assert.equal(unknownAuthor.unknown, true);
  assert.equal(gate(unknownAuthor), "reviewer-family-required");
});

test("contribution families come from all attempts sharing the captured assignment workspace", () => {
  const base = reviewer({ memberId: "implementer-original", role: "implementer", taskId: "task-1", cwd: "members/task-1",
    modelProfile: { id: "claude-author", label: "Claude author", provider: "claude", model: "claude-haiku-5-5", effort: "medium" } });
  const fallback = reviewer({ memberId: "implementer-fallback", role: "implementer", taskId: "task-1", cwd: "members/task-1",
    modelProfile: { id: "deepseek-author", label: "DeepSeek author", provider: "opencode", model: "deepseek/deepseek-flash", variant: "medium" } });
  const unrelatedTask = reviewer({ memberId: "implementer-other-task", role: "implementer", taskId: "task-2", cwd: "members/task-2",
    modelProfile: { id: "gpt-author", label: "GPT author", provider: "codex", model: "gpt-6-astra", effort: "high" } });
  assert.deepEqual(workspaceContributorFamilies({ members: [base, fallback, unrelatedTask] }, fallback), ["claude", "deepseek"]);
  assert.deepEqual(workspaceContributorFamilies({ members: [base, { ...fallback, modelProfile: undefined }] }, fallback), ["claude", undefined]);
});

test("PM recovery carries every started prior writer family, including partial unintegrated work", () => {
  const partial = reviewer({ memberId: "partial-implementer", revision: 3, role: "implementer", taskId: "task-partial", cwd: "members/partial",
    status: "stopped", startedAt: "2026-11-24T00:00:00.000Z", modelProfile: {
      id: "claude-author", label: "Claude author", provider: "claude", model: "claude-haiku-5-5", effort: "medium",
    } });
  const integrator = reviewer({ memberId: "partial-integrator", revision: 3, role: "integrator", taskId: undefined,
    status: "stopped", startedAt: "2026-11-24T00:00:01.000Z", modelProfile: {
      id: "gpt-integrator", label: "GPT integrator", provider: "codex", model: "gpt-6-astra", effort: "high",
    } });
  const neverStarted = reviewer({ memberId: "queued-implementer", revision: 3, role: "implementer", taskId: "task-queued",
    status: "queued", startedAt: undefined });
  const priorReviewer = reviewer({ memberId: "prior-reviewer", revision: 3, role: "reviewer" });
  const run = { members: [partial, integrator, neverStarted, priorReviewer] };
  const writers = potentialRecoveryContributorFamilies(run, 3);
  assert.deepEqual(writers, ["claude", "gpt"]);

  const recovered = includeDeliveryReviewContributors({ headCommit: HEAD, families: ["claude"], unknown: false }, HEAD, writers);
  assert.deepEqual(recovered, { headCommit: HEAD, families: ["claude", "gpt"], unknown: false });
  const nextHead = advanceDeliveryReviewLineage(recovered, { headBefore: HEAD, headAfter: NEXT, contributorFamilies: ["muse"] });
  assert.deepEqual(nextHead, { headCommit: NEXT, families: ["claude", "gpt", "muse"], unknown: false });
  assert.equal(gate(nextHead, [reviewer({ baseCommit: NEXT })], approval({ headCommit: NEXT })), "reviewer-family-required",
    "the reviewer family that could have authored copied partial work cannot auto-merge it");
  assert.equal(gate(nextHead, [reviewer({ baseCommit: NEXT, modelProfile: {
    id: "independent", label: "Independent reviewer", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high",
  } })], approval({ headCommit: NEXT })), "reviewer-family-required", "the later Muse contribution also requires a different family");
});

test("PM recovery marks missing or unknown prior writer provenance as unknown", () => {
  const prior = reviewer({ memberId: "legacy-implementer", revision: 3, role: "implementer", taskId: "task", status: "stopped", startedAt: "started",
    modelProfile: undefined });
  const families = potentialRecoveryContributorFamilies({ members: [prior] }, 3);
  assert.deepEqual(families, [undefined]);
  assert.equal(includeDeliveryReviewContributors(undefined, HEAD, families).unknown, true);
  assert.equal(includeDeliveryReviewContributors({ headCommit: BASE, families: ["claude"], unknown: false }, HEAD, ["gpt"]).unknown, true,
    "recovery cannot repair a missing/mismatched existing head record");
});

test("inherited and moved-base evidence keeps its source coverage only for the exact source head", () => {
  const original = { headCommit: HEAD, families: ["claude"], unknown: false };
  assert.deepEqual(inheritDeliveryReviewLineage(original, HEAD), original);
  assert.equal(inheritDeliveryReviewLineage(original, NEXT).unknown, true);
  assert.deepEqual(rebaseDeliveryReviewLineage(original, HEAD, NEXT), { headCommit: NEXT, families: ["claude"], unknown: false });
  assert.equal(rebaseDeliveryReviewLineage(undefined, HEAD, NEXT).unknown, true);
});

test("stale, unaccepted, queued, or unknown-family reviewer evidence does not authorize merge", () => {
  const lineage = { headCommit: HEAD, families: ["gpt"], unknown: false };
  const failures: Array<{ members?: TeamMember[]; accepted?: DeliveryReviewApproval; run?: Record<string, unknown> }> = [
    { run: { checkHead: BASE } },
    { run: { review: { verdict: "approved", revision: 3 } } },
    { accepted: approval({ revision: 3 }) },
    { accepted: approval({ reviewerMemberId: "another-reviewer" }) },
    { accepted: approval({ round: 1 }) },
    { members: [reviewer({ status: "queued" })] },
    { members: [reviewer({ baseCommit: BASE })] },
    { members: [reviewer({ report: { kind: "review", verdict: "changes-requested", summary: "Needs work." } })] },
    { members: [reviewer({ modelProfile: undefined })] },
    { members: [reviewer({ modelProfile: { id: "unknown", label: "Unknown", provider: "opencode", model: "vendor/unmapped-model", variant: "high" } })] },
  ];
  for (const scenario of failures) {
    assert.equal(gate(lineage, scenario.members, scenario.accepted, scenario.run), "reviewer-family-required");
  }
});
