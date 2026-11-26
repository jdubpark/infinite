import test from "node:test";
import assert from "node:assert/strict";
import {
  authorityLabel,
  deriveMobileOutcomeGroups,
  filterMobileEntries,
  formatEntryBodySummary,
  mergeMobileEntries,
  partitionMobileRoster,
} from "../apps/mobile/src/features/teams/inspector-model.ts";
import {
  applyMissionProgressPage,
  createMissionProgressState,
  dismissMissionProgressNotice,
  linkedTeamIdOf,
  partitionMissionSubtasks,
} from "../apps/mobile/src/features/board/mission-progress-model.ts";
import type { MissionProgressPage, TeamEntryHead } from "../apps/mobile/src/api/client.ts";
import type { TeamMember, TeamTask, TeamView } from "../apps/mobile/src/features/teams/model.ts";

const makeTask = (id: string, status: TeamTask["status"], criteria?: string[], objectiveVersion = 3): TeamTask => ({
  id,
  title: `Task ${id}`,
  instructions: "Do work",
  paths: ["apps/mobile/src/app.tsx"],
  dependsOn: [],
  status,
  ...(criteria ? { criterionRefs: { objectiveVersion, criteria } } : {}),
});

const makeTeam = (overrides: Partial<TeamView> = {}): TeamView => ({
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "proj-1",
  provider: "codex",
  title: "Mobile inspector",
  objective: "Build inspector",
  parallelism: 2,
  revision: 2,
  status: "reviewing",
  createdAt: "2026-11-26T00:00:00.000Z",
  updatedAt: "2026-11-26T00:05:00.000Z",
  workspace: "/srv/team",
  branch: "infinite/team",
  baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  tasks: [],
  members: [],
  decisions: [],
  checks: [],
  steering: [],
  events: [],
  round: 1,
  ...overrides,
});

const makeMember = (memberId: string, overrides: Partial<TeamMember> = {}): TeamMember => ({
  memberId,
  sessionId: `s-${memberId}`,
  role: "implementer",
  revision: 2,
  title: `Member ${memberId}`,
  status: "running",
  ...overrides,
});

const makeEntry = (entryId: string, seq: number, overrides: Partial<TeamEntryHead> = {}): TeamEntryHead => ({
  entryId,
  seq,
  revision: 2,
  at: "2026-11-26T00:02:00.000Z",
  kind: "check",
  author: "host",
  authority: "receipt",
  summary: `Entry ${entryId}`,
  bodyBytes: 120,
  state: "active",
  ...overrides,
});

const makeProgressPage = (overrides: Partial<MissionProgressPage> = {}): MissionProgressPage => ({
  missionId: "mission-1",
  generation: "gen-1",
  cursor: "mp1.gen-1.mission-1.inst-1.2",
  observedAt: "2026-11-26T00:05:00.000Z",
  resync: { required: false },
  observations: [],
  snapshot: {
    mission: { id: "mission-1", title: "Mission One", status: "working", revision: 1 },
    subtasks: [],
  },
  ...overrides,
});

test("deriveMobileOutcomeGroups uses c0 successCriteria and keeps provisional assessment and reviewer claims separate", () => {
  const noCriteria = deriveMobileOutcomeGroups(makeTeam({ tasks: [makeTask("t1", "integrated")] }));
  assert.deepEqual(noCriteria, []);

  const team = makeTeam({
    goal: {
      id: "goal-1",
      revision: 1,
      cycle: 1,
      successCriteria: "Owner-pinned top-level criterion text",
      record: {
        version: 3,
        criteria: [
          { id: "c0", statement: "", check: "owner-text", producer: "evaluator" },
          { id: "c1", statement: "Unit tests pass", check: "npm test", producer: "host" },
        ],
      },
    },
    tasks: [
      makeTask("t1", "integrated", ["c0"]),
      makeTask("t2", "integrated", ["c0", "c1"]),
      makeTask("t3", "running", ["c0"]),
      makeTask("t4", "integrated", ["c0"]),
      makeTask("stale", "integrated", ["c1"], 2),
    ],
    assessment: {
      verdictId: "v-1",
      revision: 2,
      head: "b".repeat(40),
      kind: "reviewed",
      result: "inconclusive",
      counts: { met: 1, notMet: 0, inconclusive: 0, pendingOwner: 1 },
      criteria: [
        { id: "c0", state: "pending-owner" },
        { id: "c1", state: "met" },
      ],
      at: "2026-11-26T00:04:00.000Z",
    },
    review: {
      verdict: "approved",
      summary: "Verified",
      revision: 2,
      acceptance: [
        { criterion: 1, verdict: "inconclusive", evidence: "Waiting on owner sign-off" },
        { criterion: 2, verdict: "verified", evidence: "Tests passed on cloud runner" },
      ],
    },
  });

  const groups = deriveMobileOutcomeGroups(team);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.id, "c0");
  assert.equal(groups[0]!.statement, "Owner-pinned top-level criterion text");
  assert.equal(groups[0]!.done, 3);
  assert.equal(groups[0]!.total, 4);
  assert.equal(groups[0]!.integrationSummary, "3 of 4 tasks integrated");
  assert.deepEqual(groups[0]!.provisionalAssessment, { state: "pending-owner", label: "Provisional", revision: 2 });
  assert.deepEqual(groups[0]!.reviewerClaim, {
    verdict: "inconclusive",
    evidence: "Waiting on owner sign-off",
    revision: 2,
    label: "Reviewer claim",
  });

  assert.equal(groups[1]!.id, "c1");
  assert.equal(groups[1]!.statement, "Unit tests pass");
  assert.equal(groups[1]!.done, 1);
  assert.equal(groups[1]!.total, 1);
  assert.equal(groups[1]!.integrationSummary, "1 of 1 tasks integrated");
  assert.deepEqual(groups[1]!.provisionalAssessment, { state: "met", label: "Provisional", revision: 2 });
  assert.deepEqual(groups[1]!.reviewerClaim, {
    verdict: "verified",
    evidence: "Tests passed on cloud runner",
    revision: 2,
    label: "Reviewer claim",
  });
});

test("partitionMobileRoster collapses finished attempts and links failed/stopped attempts to replacements", () => {
  const members: TeamMember[] = [
    makeMember("m-old-pm", { role: "project-manager", revision: 1, status: "stopped", startedAt: "2026-11-26T00:00:00.000Z" }),
    makeMember("m-pm", { role: "project-manager", revision: 2, status: "waiting", startedAt: "2026-11-26T00:01:00.000Z" }),
    makeMember("m-t1-a", { taskId: "t1", status: "stopped", stoppedReason: "timed out", startedAt: "2026-11-26T00:01:30.000Z" }),
    makeMember("m-t1-b", { taskId: "t1", status: "running", startedAt: "2026-11-26T00:02:00.000Z" }),
    makeMember("m-t2-done", { taskId: "t2", status: "reported", startedAt: "2026-11-26T00:01:40.000Z" }),
  ];

  const partitioned = partitionMobileRoster(members, 2);
  assert.deepEqual(partitioned.active.map(item => item.member.memberId), ["m-pm", "m-t1-b"]);
  assert.deepEqual(partitioned.finished.map(item => item.member.memberId), ["m-old-pm", "m-t1-a", "m-t2-done"]);

  const oldPm = partitioned.finished.find(item => item.member.memberId === "m-old-pm")!;
  const activePm = partitioned.active.find(item => item.member.memberId === "m-pm")!;
  assert.equal(oldPm.replacedByMemberId, "m-pm");
  assert.equal(activePm.replacesMemberId, "m-old-pm");

  const stoppedT1 = partitioned.finished.find(item => item.member.memberId === "m-t1-a")!;
  const runningT1 = partitioned.active.find(item => item.member.memberId === "m-t1-b")!;
  assert.equal(stoppedT1.replacedByMemberId, "m-t1-b");
  assert.equal(runningT1.replacesMemberId, "m-t1-a");

  const doneT2 = partitioned.finished.find(item => item.member.memberId === "m-t2-done")!;
  assert.equal(doneT2.replacedByMemberId, undefined);
});

test("mergeMobileEntries deduplicates by entryId, preserves sparse seq order, and filterMobileEntries filters by kind", () => {
  const existing = [
    makeEntry("e1", 4, { kind: "direction", authority: "direction", state: "active" }),
    makeEntry("e2", 9, { kind: "check", authority: "receipt", state: "active" }),
  ];
  const merged = mergeMobileEntries(existing, {
    entries: [
      makeEntry("e2", 9, { kind: "check", authority: "receipt", state: "withdrawn" }),
      makeEntry("e3", 15, { kind: "report", authority: "claim", state: "active" }),
      makeEntry("e0", 2, { kind: "integration", authority: "receipt", state: "active" }),
    ],
  });

  assert.deepEqual(merged.map(entry => [entry.entryId, entry.seq, entry.state]), [
    ["e0", 2, "active"],
    ["e1", 4, "active"],
    ["e2", 9, "withdrawn"],
    ["e3", 15, "active"],
  ]);

  assert.equal(filterMobileEntries(merged, "all").length, 4);
  assert.deepEqual(filterMobileEntries(merged, "report").map(entry => entry.entryId), ["e3"]);
  assert.equal(authorityLabel("receipt"), "Host receipt");
  assert.equal(authorityLabel("claim"), "Agent claim");
  assert.equal(authorityLabel("direction"), "Owner direction");
});

test("formatEntryBodySummary extracts structured facts across host and member entries safely", () => {
  const checkSummary = formatEntryBodySummary({
    command: { command: "npm", args: ["test"] },
    phase: "setup",
    status: "failed",
    exitCode: 2,
    round: 3,
    headCommit: "abcdef1234567890",
    output: "FAIL line 1",
  });
  assert.equal(checkSummary.headCommit, "abcdef1234567890");
  assert.equal(checkSummary.exitCode, 2);
  assert.equal(checkSummary.round, 3);
  assert.equal(checkSummary.output, "FAIL line 1");
  assert.ok(checkSummary.facts.some(fact => fact.label === "Command" && fact.value === "npm test"));

  const reportSummary = formatEntryBodySummary({
    memberId: "m1",
    role: "reviewer",
    report: {
      kind: "review",
      verdict: "approved",
      summary: "All good",
      uiEvidence: "Checked screen",
      acceptance: [{ criterion: 1, verdict: "verified", evidence: "Observed output" }],
    },
  });
  assert.equal(reportSummary.verdict, "approved");
  assert.equal(reportSummary.summary, "All good");
  assert.equal(reportSummary.uiEvidence, "Checked screen");
  assert.deepEqual(reportSummary.acceptance, [{ criterion: 1, verdict: "verified", evidence: "Observed output" }]);

  const integrationSummary = formatEntryBodySummary({
    commit: "deadbeef1234",
    changedPaths: { paths: ["a.ts", "b.ts"], truncated: true },
  });
  assert.equal(integrationSummary.commit, "deadbeef1234");
  assert.deepEqual(integrationSummary.changedPaths, { paths: ["a.ts", "b.ts"], truncated: true });

  const answerSummary = formatEntryBodySummary({ source: "answer", question: "Ship?", text: "Yes" });
  assert.equal(answerSummary.question, "Ship?");
  assert.equal(answerSummary.answer, "Yes");

  const primitiveSummary = formatEntryBodySummary(null);
  assert.deepEqual(primitiveSummary.facts, []);
  assert.equal(primitiveSummary.rawJson, "null");
});

test("mission-progress-model advances generation-scoped cursors and resets cleanly on explicit or implicit resync", () => {
  let state = createMissionProgressState("mission-1");
  const initialPage = makeProgressPage({
    resync: { required: true, reason: "initial" },
    cursor: "mp1.gen-1.mission-1.inst-1.1",
    observations: [{ cursor: "mp1.gen-1.mission-1.inst-1.1", sequence: 1, observedAt: "2026-11-26T00:01:00.000Z", snapshot: makeProgressPage().snapshot }],
  });
  state = applyMissionProgressPage(state, initialPage);
  assert.equal(state.resyncNotice, undefined);
  assert.equal(state.generation, "gen-1");
  assert.equal(state.cursor, "mp1.gen-1.mission-1.inst-1.1");
  assert.equal(state.observations.length, 1);

  const incrementalPage = makeProgressPage({
    resync: { required: false },
    cursor: "mp1.gen-1.mission-1.inst-1.2",
    observations: [{ cursor: "mp1.gen-1.mission-1.inst-1.2", sequence: 2, observedAt: "2026-11-26T00:02:00.000Z", snapshot: makeProgressPage().snapshot }],
  });
  state = applyMissionProgressPage(state, incrementalPage);
  assert.deepEqual(state.observations.map(item => item.sequence), [1, 2]);
  assert.equal(state.cursor, "mp1.gen-1.mission-1.inst-1.2");

  const evictedPage = makeProgressPage({
    generation: "gen-1",
    cursor: "mp1.gen-1.mission-1.inst-2.1",
    resync: { required: true, reason: "history-evicted" },
    observations: [],
  });
  state = applyMissionProgressPage(state, evictedPage);
  assert.equal(state.observations.length, 0);
  assert.equal(state.resyncNotice, "Resynchronized after cursor eviction.");

  state = dismissMissionProgressNotice(state);
  assert.equal(state.resyncNotice, undefined);

  const restartedPage = makeProgressPage({
    generation: "gen-2",
    cursor: "mp1.gen-2.mission-1.inst-3.1",
    resync: { required: true, reason: "host-restarted" },
    observations: [{ cursor: "mp1.gen-2.mission-1.inst-3.1", sequence: 1, observedAt: "2026-11-26T00:04:00.000Z", snapshot: makeProgressPage().snapshot }],
  });
  state = applyMissionProgressPage(state, restartedPage);
  assert.equal(state.generation, "gen-2");
  assert.equal(state.resyncNotice, "Resynchronized after host restart.");
  assert.deepEqual(state.observations.map(item => item.sequence), [1]);

  const unflaggedGenSwitch = makeProgressPage({
    generation: "gen-3",
    cursor: "mp1.gen-3.mission-1.inst-4.1",
    resync: { required: false },
    observations: [],
  });
  state = applyMissionProgressPage(state, unflaggedGenSwitch);
  assert.equal(state.generation, "gen-3");
  assert.equal(state.observations.length, 0);
  assert.equal(state.resyncNotice, "Resynchronized after host restart.");
});

test("partitionMissionSubtasks keeps blocked subtasks active with replacement links and compacts finished attempts", () => {
  const subtasks: MissionProgressPage["snapshot"]["subtasks"] = [
    {
      id: "sub-1",
      title: "Repo A attempt 1",
      repoProjectId: "repo-a",
      status: "blocked",
      child: { kind: "linked", runId: "team-1", missionId: "m1", projectId: "repo-a", revision: 1, status: "blocked", assignments: [], checks: [] },
    },
    {
      id: "sub-2",
      title: "Repo A attempt 2",
      repoProjectId: "repo-a",
      status: "running",
      child: { kind: "linked", runId: "team-2", missionId: "m1", projectId: "repo-a", revision: 1, status: "implementing", assignments: [], checks: [] },
    },
    {
      id: "sub-3",
      title: "Repo B",
      repoProjectId: "repo-b",
      status: "done",
      child: { kind: "not-created" },
    },
  ];
  const partitioned = partitionMissionSubtasks(subtasks);
  assert.deepEqual(partitioned.active.map(item => item.subtask.id), ["sub-1", "sub-2"]);
  assert.deepEqual(partitioned.finished.map(item => item.subtask.id), ["sub-3"]);
  assert.equal(partitioned.active[0]!.replacedBySubtaskId, "sub-2");
  assert.equal(partitioned.active[1]!.replacesSubtaskId, "sub-1");
  assert.equal(linkedTeamIdOf(subtasks[0]!.child), "team-1");
  assert.equal(linkedTeamIdOf(subtasks[2]!.child), undefined);
});
