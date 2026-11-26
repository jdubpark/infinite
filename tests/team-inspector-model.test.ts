import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSupersessionIndex,
  buildTeamEntryHash,
  deriveOutcomeGroups,
  entryAuthorityMeta,
  filterEntries,
  mergeEntryPage,
  orderWaitReasons,
  parseTeamEntryHash,
  partitionRoster,
  waitReasonMeta,
} from "../apps/web/src/team-inspector/model.ts";
import type { TeamEntryHead, TeamWaitReason, TeamWaitReasonKind } from "../apps/web/src/team-inspector/types.ts";
import type { TeamMember, TeamView } from "../apps/web/src/teams.tsx";

function baseTeam(): TeamView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "proj-1",
    provider: "claude",
    title: "Repair trace",
    objective: "Keep the inspector honest.",
    parallelism: 2,
    revision: 2,
    status: "implementing",
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:10:00.000Z",
    workspace: "/work/repo",
    branch: "infinite/repair",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    tasks: [],
    members: [],
    decisions: [],
    checks: [],
    steering: [],
    events: [],
    round: 1,
  };
}

test("deriveOutcomeGroups groups tasks by pinned criteria and keeps provisional assessment and reviewer claims separate", () => {
  const team: TeamView = {
    ...baseTeam(),
    goal: {
      id: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      cycle: 1,
      successCriteria: "Ship reliable team inspector",
      nonGoals: [],
      allowedPaths: ["."],
      evidence: [],
      previousWork: [],
      deadlineAt: "2026-11-27T00:00:00.000Z",
      maxMembers: 10,
      record: {
        version: 1,
        criteria: [
          { id: "c0", statement: "", check: "All checks pass", producer: "host" },
          { id: "c1", statement: "Inspector renders repair trace", check: "Playwright trace", producer: "evaluator" },
        ],
      },
    },
    tasks: [
      {
        id: "t1",
        title: "Build model",
        instructions: "Model",
        paths: ["apps/web/src/team-inspector/model.ts"],
        dependsOn: [],
        status: "integrated",
        criterionRefs: { objectiveVersion: 1, criteria: ["c0", "c1"] },
      },
      {
        id: "t2",
        title: "Build UI",
        instructions: "UI",
        paths: ["apps/web/src/team-inspector/TeamEvidenceBoard.tsx"],
        dependsOn: ["t1"],
        status: "running",
        criterionRefs: { objectiveVersion: 1, criteria: ["c1"] },
      },
    ],
    assessment: {
      verdictId: "33333333-3333-4333-8333-333333333333",
      revision: 2,
      head: "b".repeat(40),
      kind: "reviewed",
      result: "inconclusive",
      counts: { met: 1, notMet: 0, inconclusive: 1, pendingOwner: 0 },
      criteria: [
        { id: "c0", state: "met" },
        { id: "c1", state: "inconclusive" },
      ],
      at: "2026-11-26T00:12:00.000Z",
    },
    brief: {
      title: "Inspector brief",
      problem: "Need inspector",
      evidence: [{ source: "src", observation: "obs" }],
      dataShape: "types",
      acceptance: ["Shows host receipts distinctly", "Links replacement attempts"],
      expectedOutcome: "Clean inspector",
      uiChanges: true,
    },
    review: {
      verdict: "approved",
      summary: "Looks good",
      revision: 2,
      acceptance: [
        { criterion: 1, verdict: "verified", evidence: "Host receipt pill rendered" },
        { criterion: 2, verdict: "inconclusive", evidence: "Pending second click" },
      ],
    },
  };

  const overview = deriveOutcomeGroups(team);
  assert.equal(overview.mode, "criteria");
  assert.equal(overview.groups.length, 2);
  assert.equal(overview.groups[0]!.label, "Ship reliable team inspector");
  assert.equal(overview.groups[0]!.progressText, "1 of 1 tasks integrated");
  assert.equal(overview.groups[0]!.provisionalState, "met");
  assert.equal(overview.groups[1]!.label, "Inspector renders repair trace");
  assert.equal(overview.groups[1]!.progressText, "1 of 2 tasks integrated");
  assert.equal(overview.groups[1]!.provisionalState, "inconclusive");
  assert.equal(overview.reviewerClaims.length, 2);
  assert.equal(overview.reviewerClaims[0]!.label, "Shows host receipts distinctly");
  assert.equal(overview.reviewerClaims[0]!.verdict, "verified");
});

test("deriveOutcomeGroups provides honest fallback summary without pinned goal criteria", () => {
  const team: TeamView = {
    ...baseTeam(),
    tasks: [
      { id: "t1", title: "One", instructions: "a", paths: ["a.ts"], dependsOn: [], status: "integrated" },
      { id: "t2", title: "Two", instructions: "b", paths: ["b.ts"], dependsOn: [], status: "blocked" },
    ],
  };
  const overview = deriveOutcomeGroups(team);
  assert.equal(overview.mode, "summary");
  assert.equal(overview.integratedSummary, "1 of 2 tasks integrated");
  assert.equal(overview.taskCounts.blocked, 1);
});

test("partitionRoster collapses finished members and links stopped attempts to replacements", () => {
  const members: TeamMember[] = [
    { memberId: "m-pm-1", sessionId: "s-pm-1", role: "project-manager", revision: 1, title: "Plan r1", status: "stopped", cwd: "/w", baseCommit: "a".repeat(40), startedAt: "2026-11-26T00:01:00.000Z" },
    { memberId: "m-pm-2", sessionId: "s-pm-2", role: "project-manager", revision: 2, title: "Plan r2", status: "running", cwd: "/w", baseCommit: "a".repeat(40), startedAt: "2026-11-26T00:05:00.000Z" },
    { memberId: "m-t1-fail", sessionId: "s-t1-1", role: "implementer", revision: 2, title: "Attempt 1", status: "stopped", taskId: "t1", cwd: "/w", baseCommit: "a".repeat(40), stoppedReason: "check failed", startedAt: "2026-11-26T00:06:00.000Z" },
    { memberId: "m-t1-fix", sessionId: "s-t1-2", role: "integrator", revision: 2, title: "Repair t1", status: "waiting", taskId: "t1", cwd: "/w", baseCommit: "a".repeat(40), startedAt: "2026-11-26T00:07:00.000Z" },
    { memberId: "m-scout-1", sessionId: "s-sc-1", role: "scout", revision: 2, title: "Scout A", status: "running", cwd: "/w", baseCommit: "a".repeat(40) },
    { memberId: "m-scout-2", sessionId: "s-sc-2", role: "scout", revision: 2, title: "Scout B", status: "running", cwd: "/w", baseCommit: "a".repeat(40) },
  ];
  const roster = partitionRoster(members, 2);
  assert.deepEqual(roster.active.map(n => n.member.memberId).sort(), ["m-pm-2", "m-scout-1", "m-scout-2", "m-t1-fix"].sort());
  assert.deepEqual(roster.finished.map(n => n.member.memberId), ["m-t1-fail", "m-pm-1"]);
  assert.equal(roster.byMemberId["m-pm-1"]!.replacedByMemberId, "m-pm-2");
  assert.equal(roster.byMemberId["m-pm-2"]!.replacesMemberId, "m-pm-1");
  assert.equal(roster.byMemberId["m-t1-fail"]!.replacedByMemberId, "m-t1-fix");
  assert.equal(roster.byMemberId["m-t1-fix"]!.replacesMemberId, "m-t1-fail");
  assert.equal(roster.byMemberId["m-scout-1"]!.replacedByMemberId, undefined);
  assert.equal(roster.byMemberId["m-scout-2"]!.replacesMemberId, undefined);
});

test("mergeEntryPage deduplicates, orders by global seq, and filters cleanly", () => {
  const mk = (overrides: Partial<TeamEntryHead>): TeamEntryHead => ({
    entryId: "e1",
    seq: 10,
    scope: "run",
    runId: "r1",
    revision: 1,
    at: "2026-11-26T00:00:00.000Z",
    kind: "check",
    author: "host",
    authority: "receipt",
    paths: [],
    summary: "check failed",
    bodyBytes: 100,
    state: "active",
    ...overrides,
  });
  const first = mergeEntryPage([], { entries: [mk({ entryId: "e2", seq: 42 }), mk({ entryId: "e1", seq: 15, state: "active" })], cursor: 42, more: true });
  const merged = mergeEntryPage(first, {
    entries: [
      mk({ entryId: "e1", seq: 15, state: "superseded" }),
      mk({ entryId: "e3", seq: 88, kind: "report", author: "member", authority: "claim", authorMemberId: "m2", taskId: "t1", headCommit: "1234567abcdef", supersedes: "e1", summary: "repair report" }),
    ],
    cursor: 88,
    more: false,
  });
  assert.deepEqual(merged.map(e => [e.seq, e.state]), [[15, "superseded"], [42, "active"], [88, "active"]]);
  assert.equal(filterEntries(merged, { kind: "report", taskId: "t1", memberId: "m2", query: "1234567" }).length, 1);
  assert.equal(filterEntries(merged, { query: "88" })[0]!.entryId, "e3");
  assert.equal(buildSupersessionIndex(merged).get("e1")![0]!.entryId, "e3");
});

test("entryAuthorityMeta and deep-link hash helpers distinguish authorities and parse machine routes", () => {
  assert.equal(entryAuthorityMeta("receipt").label, "Host receipt");
  assert.equal(entryAuthorityMeta("claim").label, "Agent claim");
  assert.equal(entryAuthorityMeta("direction").label, "Owner direction");
  const tid = "11111111-1111-4111-8111-111111111111";
  const eid = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(parseTeamEntryHash(`#/teams/${tid}/entries/${eid}`), { machine: "direct", teamId: tid, entryId: eid });
  assert.deepEqual(parseTeamEntryHash(`#/machines/box-1/teams/${tid}/entries/${eid}`, tid), { machine: "box-1", teamId: tid, entryId: eid });
  assert.equal(parseTeamEntryHash(`#/teams/${tid}/entries/${eid}`, "other"), null);
  assert.equal(buildTeamEntryHash("box-1", tid, eid), `#/machines/box-1/teams/${tid}/entries/${eid}`);
  assert.equal(buildTeamEntryHash("direct", tid), `#/teams/${tid}`);
});

test("waitReasonMeta and orderWaitReasons classify and prioritize host wait reasons", () => {
  assert.deepEqual(waitReasonMeta("owner-decision"), { label: "Owner decision", tone: "attention" });
  assert.deepEqual(waitReasonMeta("provider-prompt"), { label: "Provider prompt", tone: "attention" });
  assert.deepEqual(waitReasonMeta("stalled"), { label: "Stalled", tone: "attention" });
  assert.deepEqual(waitReasonMeta("spinner-only"), { label: "Spinner-only screen", tone: "warning" });
  assert.deepEqual(waitReasonMeta("provider-limit"), { label: "Provider limit", tone: "warning" });
  assert.deepEqual(waitReasonMeta("worker-slot"), { label: "Worker slot", tone: "muted" });
  assert.deepEqual(waitReasonMeta("dependency"), { label: "Task dependency", tone: "muted" });
  assert.deepEqual(waitReasonMeta("integration-order"), { label: "Integration order", tone: "muted" });
  assert.deepEqual(waitReasonMeta("linear-sync"), { label: "Linear sync", tone: "muted" });
  assert.deepEqual(waitReasonMeta("custom-kind" as TeamWaitReasonKind), { label: "custom-kind", tone: "muted" });

  const input: TeamWaitReason[] = [
    { kind: "linear-sync", summary: "Linear sync" },
    { kind: "dependency", summary: "Task dependency" },
    { kind: "worker-slot", summary: "Worker slot" },
    { kind: "provider-limit", summary: "Provider limit" },
    { kind: "spinner-only", summary: "Spinner only" },
    { kind: "stalled", summary: "Stalled" },
    { kind: "provider-prompt", summary: "Provider prompt" },
    { kind: "owner-decision", summary: "Owner decision" },
    { kind: "integration-order", summary: "Integration order" },
  ];
  assert.deepEqual(
    orderWaitReasons(input).map(item => item.kind),
    [
      "owner-decision",
      "provider-prompt",
      "stalled",
      "spinner-only",
      "provider-limit",
      "worker-slot",
      "dependency",
      "integration-order",
      "linear-sync",
    ],
  );
});
