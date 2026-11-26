import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMobileEvidenceHead,
  applyMobileEvidencePage,
  authorityLabel,
  createMobileEvidenceFeedState,
  deriveMobileOutcomeGroups,
  deriveReviewerAcceptanceClaims,
  entryAuthorLabel,
  filterMobileEntries,
  formatEntryBodySummary,
  memberScreenNotices,
  mergeMobileEntries,
  orderMobileWaitReasons,
  partitionMobileRoster,
  resolveSelectedEntryHead,
  sliceVisibleMobileEntries,
  waitReasonLabel,
  waitReasonTone,
} from "../apps/mobile/src/features/teams/inspector-model.ts";
import {
  applyMissionProgressPage,
  createMissionProgressState,
  dismissMissionProgressNotice,
  linkedTeamIdOf,
  partitionMissionSubtasks,
  resyncNoticeForReason,
  summarizeMissionProgressChild,
} from "../apps/mobile/src/features/board/mission-progress-model.ts";
import type { MissionProgressPage, TeamEntryHead } from "../apps/mobile/src/api/client.ts";
import { shortDate, type TeamMember, type TeamTask, type TeamView, type TeamWaitReason, type TeamWaitReasonKind } from "../apps/mobile/src/features/teams/model.ts";

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

test("deriveMobileOutcomeGroups uses c0 successCriteria and keeps provisional assessment separate from brief reviewer claims", () => {
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
    brief: {
      title: "Inspector brief",
      problem: "Need inspector",
      evidence: [{ source: "host", observation: "missing" }],
      dataShape: "typed",
      acceptance: ["Brief acceptance 1", "Brief acceptance 2", "Brief acceptance 3"],
      expectedOutcome: "Works",
      uiChanges: true,
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
        { criterion: 3, verdict: "verified", evidence: "Extra brief item verified" },
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
  assert.equal("reviewerClaim" in groups[0]!, false);

  assert.equal(groups[1]!.id, "c1");
  assert.equal(groups[1]!.statement, "Unit tests pass");
  assert.equal(groups[1]!.done, 1);
  assert.equal(groups[1]!.total, 1);
  assert.equal(groups[1]!.integrationSummary, "1 of 1 tasks integrated");
  assert.deepEqual(groups[1]!.provisionalAssessment, { state: "met", label: "Provisional", revision: 2 });
  assert.equal("reviewerClaim" in groups[1]!, false);

  const claims = deriveReviewerAcceptanceClaims(team);
  assert.equal(claims.length, 3);
  assert.deepEqual(claims[0], {
    criterion: 1,
    verdict: "inconclusive",
    evidence: "Waiting on owner sign-off",
    statement: "Brief acceptance 1",
    revision: 2,
  });
  assert.deepEqual(claims[2], {
    criterion: 3,
    verdict: "verified",
    evidence: "Extra brief item verified",
    statement: "Brief acceptance 3",
    revision: 2,
  });
});

test("partitionMobileRoster scopes replacement links to revision, role, and taskId unless explicit host link exists", () => {
  const members: TeamMember[] = [
    makeMember("m-old-pm", { role: "project-manager", revision: 1, status: "stopped", startedAt: "2026-11-26T00:00:00.000Z" }),
    makeMember("m-pm", { role: "project-manager", revision: 2, status: "waiting", startedAt: "2026-11-26T00:01:00.000Z" }),
    makeMember("m-rev1-t1", { role: "implementer", revision: 1, taskId: "t1", status: "stopped", startedAt: "2026-11-26T00:00:30.000Z" }),
    makeMember("m-scout-t1", { role: "scout", revision: 2, taskId: "t1", status: "reported", startedAt: "2026-11-26T00:01:10.000Z" }),
    makeMember("m-t1-a", { role: "implementer", revision: 2, taskId: "t1", status: "stopped", stoppedReason: "timed out" }),
    makeMember("m-t1-b", { role: "implementer", revision: 2, taskId: "t1", status: "running" }),
    makeMember("m-t2-done", { role: "implementer", revision: 2, taskId: "t2", status: "reported", startedAt: "2026-11-26T00:01:40.000Z" }),
    makeMember("m-t3-a", { role: "implementer", revision: 2, taskId: "t3", status: "stopped", startedAt: "2026-11-26T00:02:00.000Z" }),
    makeMember("m-t3-b", { role: "implementer", revision: 2, taskId: "t3", status: "running", startedAt: "2026-11-26T00:02:00.000Z" }),
    makeMember("m-explicit-old", { role: "implementer", revision: 1, taskId: "t9", status: "stopped" }),
    makeMember("m-explicit-new", { role: "integrator", revision: 2, taskId: "t9", status: "running", replaces: { memberId: "m-explicit-old", cause: "escalation" } }),
  ];

  const partitioned = partitionMobileRoster(members, 2);
  assert.deepEqual(partitioned.active.map(item => item.member.memberId), ["m-pm", "m-t1-b", "m-t3-b", "m-explicit-new"]);
  assert.deepEqual(
    partitioned.finished.map(item => item.member.memberId),
    ["m-old-pm", "m-rev1-t1", "m-scout-t1", "m-t1-a", "m-t2-done", "m-t3-a", "m-explicit-old"],
  );

  const oldPm = partitioned.finished.find(item => item.member.memberId === "m-old-pm")!;
  const activePm = partitioned.active.find(item => item.member.memberId === "m-pm")!;
  assert.equal(oldPm.replacedByMemberId, undefined);
  assert.equal(activePm.replacesMemberId, undefined);

  const rev1T1 = partitioned.finished.find(item => item.member.memberId === "m-rev1-t1")!;
  const scoutT1 = partitioned.finished.find(item => item.member.memberId === "m-scout-t1")!;
  assert.equal(rev1T1.replacedByMemberId, undefined);
  assert.equal(scoutT1.replacedByMemberId, undefined);

  const stoppedT1 = partitioned.finished.find(item => item.member.memberId === "m-t1-a")!;
  const runningT1 = partitioned.active.find(item => item.member.memberId === "m-t1-b")!;
  assert.equal(stoppedT1.replacedByMemberId, "m-t1-b");
  assert.equal(runningT1.replacesMemberId, "m-t1-a");

  const stoppedT3 = partitioned.finished.find(item => item.member.memberId === "m-t3-a")!;
  const runningT3 = partitioned.active.find(item => item.member.memberId === "m-t3-b")!;
  assert.equal(stoppedT3.replacedByMemberId, "m-t3-b");
  assert.equal(runningT3.replacesMemberId, "m-t3-a");

  const doneT2 = partitioned.finished.find(item => item.member.memberId === "m-t2-done")!;
  assert.equal(doneT2.replacedByMemberId, undefined);

  const explicitOld = partitioned.finished.find(item => item.member.memberId === "m-explicit-old")!;
  const explicitNew = partitioned.active.find(item => item.member.memberId === "m-explicit-new")!;
  assert.equal(explicitOld.replacedByMemberId, "m-explicit-new");
  assert.equal(explicitNew.replacesMemberId, "m-explicit-old");
});

test("mergeMobileEntries deduplicates by entryId, preserves sparse seq order, and formats author labels", () => {
  const existing = [
    makeEntry("e1", 4, { kind: "direction", authority: "direction", state: "active" }),
    makeEntry("e2", 9, { kind: "check", authority: "receipt", state: "active" }),
  ];
  const merged = mergeMobileEntries(existing, {
    entries: [
      makeEntry("e2", 9, { kind: "check", authority: "receipt", state: "withdrawn" }),
      makeEntry("e3", 15, { kind: "report", authority: "claim", state: "active", author: "member", authorRole: "mission-coordinator" }),
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
  assert.equal(entryAuthorLabel("member", "mission-coordinator"), "Mission coordinator");
  assert.equal(entryAuthorLabel("member", "project-manager"), "Coordinator");
  assert.equal(entryAuthorLabel("host"), "host");
});

test("formatEntryBodySummary extracts structured facts across host and member entries without duplicating answer text", () => {
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
  assert.equal(answerSummary.summary, undefined);

  const primitiveSummary = formatEntryBodySummary(null);
  assert.deepEqual(primitiveSummary.facts, []);
  assert.equal(primitiveSummary.rawJson, "null");
});

test("mission-progress-model advances generation-scoped cursors and sets explicit notices for every resync reason", () => {
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

  for (const [reason, expected] of [
    ["invalid-cursor", "Resynchronized after invalid cursor."],
    ["retention-gap", "Resynchronized after observation retention gap."],
    ["cursor-ahead", "Resynchronized after cursor reset."],
    ["mission-mismatch", "Resynchronized for the current mission."],
  ] as const) {
    assert.equal(resyncNoticeForReason(reason), expected);
    state = applyMissionProgressPage(state, makeProgressPage({
      generation: "gen-1",
      cursor: `mp1.gen-1.mission-1.inst-${reason}.1`,
      resync: { required: true, reason },
      observations: [],
    }));
    assert.equal(state.resyncNotice, expected);
    assert.equal(state.lastResyncReason, reason);
  }

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

test("partitionMissionSubtasks does not infer replacements from repo order and honors explicit host links", () => {
  const subtasks: MissionProgressPage["snapshot"]["subtasks"] = [
    {
      id: "sub-1",
      title: "Repo A cancelled work",
      repoProjectId: "repo-a",
      status: "cancelled",
      child: { kind: "linked", runId: "team-1", missionId: "m1", projectId: "repo-a", revision: 1, status: "cancelled", assignments: [], checks: [] },
    },
    {
      id: "sub-2",
      title: "Repo A unrelated follow-up",
      repoProjectId: "repo-a",
      status: "blocked",
      child: { kind: "linked", runId: "team-2", missionId: "m1", projectId: "repo-a", revision: 1, status: "blocked", assignments: [], checks: [] },
    },
    {
      id: "sub-3",
      title: "Repo A explicit retry",
      repoProjectId: "repo-a",
      status: "running",
      replacesSubtaskId: "sub-2",
      child: { kind: "linked", runId: "team-3", missionId: "m1", projectId: "repo-a", revision: 1, status: "implementing", assignments: [], checks: [] },
    },
    {
      id: "sub-4",
      title: "Repo B",
      repoProjectId: "repo-b",
      status: "done",
      child: { kind: "not-created" },
    },
  ];
  const partitioned = partitionMissionSubtasks(subtasks);
  assert.deepEqual(partitioned.active.map(item => item.subtask.id), ["sub-2", "sub-3"]);
  assert.deepEqual(partitioned.finished.map(item => item.subtask.id), ["sub-1", "sub-4"]);
  assert.equal(partitioned.finished[0]!.replacedBySubtaskId, undefined);
  assert.equal(partitioned.active[0]!.replacesSubtaskId, undefined);
  assert.equal(partitioned.active[0]!.replacedBySubtaskId, "sub-3");
  assert.equal(partitioned.active[1]!.replacesSubtaskId, "sub-2");
  assert.equal(linkedTeamIdOf(subtasks[0]!.child), "team-1");
  assert.equal(linkedTeamIdOf(subtasks[3]!.child), undefined);
});

test("mobile evidence feed retains intermediate pages past 500 entries, enforces host supersedes eligibility, preserves monotonic state, avoids no-op updates, and bounds mounted rows", () => {
  let feed = createMobileEvidenceFeedState("m1/team-1");
  feed = applyMobileEvidencePage(feed, {
    entries: [
      makeEntry("e-1", 1, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m1", taskId: "t1" }),
      makeEntry("e-500", 500, { kind: "contract", author: "member", authority: "claim", authorMemberId: "m1", taskId: "t1" }),
    ],
    cursor: 500,
    more: true,
  }, { mode: "incremental", observedAt: "2026-11-26T00:01:00.000Z" });
  assert.equal(feed.cursor, 500);
  assert.equal(feed.more, true);

  feed = applyMobileEvidencePage(feed, {
    entries: [
      makeEntry("e-501", 501, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m1", taskId: "t1" }),
      makeEntry("e-502", 502, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m2", taskId: "t2" }),
    ],
    cursor: 502,
    more: true,
  }, { mode: "incremental", observedAt: "2026-11-26T00:02:00.000Z" });
  assert.equal(feed.cursor, 502);
  assert.equal(feed.more, true);

  feed = applyMobileEvidencePage(feed, {
    entries: [
      makeEntry("e-503", 503, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m2", taskId: "t2", supersedes: "e-502" }),
      makeEntry("e-504", 504, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m1", taskId: "t1", supersedes: "e-500" }),
      makeEntry("e-505", 505, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m9", taskId: "t9", supersedes: "e-501" }),
      makeEntry("e-506", 506, { kind: "finding", author: "host", authority: "receipt", supersedes: "e-1" }),
    ],
    cursor: 506,
    more: false,
  }, { mode: "incremental", observedAt: "2026-11-26T00:03:00.000Z" });
  assert.deepEqual(feed.entries.map(item => [item.entryId, item.state]), [
    ["e-1", "active"],
    ["e-500", "active"],
    ["e-501", "active"],
    ["e-502", "superseded"],
    ["e-503", "active"],
    ["e-504", "active"],
    ["e-505", "active"],
    ["e-506", "active"],
  ]);
  assert.equal(feed.cursor, 506);
  assert.equal(feed.more, false);

  const steady = applyMobileEvidencePage(feed, { entries: [], cursor: 506, more: false }, { mode: "incremental", observedAt: "2026-11-26T00:03:04.000Z" });
  assert.equal(steady, feed);

  feed = applyMobileEvidencePage(feed, {
    entries: [
      makeEntry("e-1", 1, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m1", taskId: "t1", state: "withdrawn" }),
      makeEntry("e-503", 503, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m2", taskId: "t2", supersedes: "e-502", state: "withdrawn" }),
    ],
    cursor: 503,
    more: true,
  }, { mode: "revalidate", observedAt: "2026-11-26T00:04:00.000Z" });
  assert.equal(feed.cursor, 506);
  assert.equal(feed.more, false);
  assert.equal(feed.entries.find(item => item.entryId === "e-1")?.state, "withdrawn");
  assert.equal(feed.entries.find(item => item.entryId === "e-503")?.state, "withdrawn");
  assert.equal(feed.entries.find(item => item.entryId === "e-502")?.state, "superseded");

  const staleDetailHead = makeEntry("e-1", 1, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m1", taskId: "t1", state: "active", summary: "Old" });
  const afterLateDetail = applyMobileEvidenceHead(feed, staleDetailHead);
  assert.equal(afterLateDetail.entries.find(item => item.entryId === "e-1")?.state, "withdrawn");
  assert.equal(resolveSelectedEntryHead(staleDetailHead, afterLateDetail.entries.find(item => item.entryId === "e-1"))?.state, "withdrawn");

  const lateSupersededDetail = makeEntry("e-502", 502, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m2", taskId: "t2", state: "active" });
  assert.equal(applyMobileEvidenceHead(feed, lateSupersededDetail).entries.find(item => item.entryId === "e-502")?.state, "superseded");

  const detailFirst = applyMobileEvidenceHead(feed, makeEntry("e-504", 504, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m1", taskId: "t1", state: "withdrawn" }));
  const afterStaleList = applyMobileEvidencePage(detailFirst, {
    entries: [makeEntry("e-504", 504, { kind: "finding", author: "member", authority: "claim", authorMemberId: "m1", taskId: "t1", state: "active" })],
    cursor: 504,
    more: false,
  }, { mode: "revalidate", observedAt: "2026-11-26T00:05:00.000Z" });
  assert.equal(afterStaleList.entries.find(item => item.entryId === "e-504")?.state, "withdrawn");

  const sliced = sliceVisibleMobileEntries(afterStaleList.entries, 3);
  assert.equal(sliced.visible.length, 3);
  assert.equal(sliced.hiddenCount, 5);
});

test("summarizeMissionProgressChild distinguishes recorded assignments, confirmed live workers, unsampled workers, and truncated samples", () => {
  const exitedSummary = summarizeMissionProgressChild({
    kind: "linked",
    runId: "team-1",
    missionId: "m1",
    projectId: "repo-a",
    revision: 1,
    status: "implementing",
    assignments: [
      { runId: "team-1", memberId: "m1", sessionId: "s1", revision: 1, role: "implementer", recordedStatus: "running", workerStatus: "exited" },
    ],
    checks: [],
  });
  assert.equal(exitedSummary, "Implementing · recorded 1/1 active · 0 workers live (1 exited)");

  const recErrorSummary = summarizeMissionProgressChild({
    kind: "linked",
    runId: "team-2",
    missionId: "m1",
    projectId: "repo-a",
    revision: 1,
    status: "verifying",
    assignments: [
      { runId: "team-2", memberId: "m1", sessionId: "s1", revision: 1, role: "implementer", recordedStatus: "running", workerStatus: "recording-error" },
    ],
    checks: [
      { revision: 1, status: "failed", exitCode: 1, headCommit: "abcdef123456", startedAt: "2026-11-26T00:00:00.000Z" },
    ],
  });
  assert.equal(recErrorSummary, "Running checks · recorded 1/1 active · 0 workers live (1 recording-error) · check failed (1) · abcdef12");

  const unsampledReportedSummary = summarizeMissionProgressChild({
    kind: "linked",
    runId: "team-2b",
    missionId: "m1",
    projectId: "repo-a",
    revision: 1,
    status: "reviewing",
    assignments: [
      { runId: "team-2b", memberId: "m1", sessionId: "s1", revision: 1, role: "implementer", recordedStatus: "reported", workerStatus: "not-sampled" },
    ],
    checks: [],
  });
  assert.equal(unsampledReportedSummary, "Reviewing · recorded 0/1 active · workers unsampled (1 not-sampled)");

  const partialSampledSummary = summarizeMissionProgressChild({
    kind: "linked",
    runId: "team-2c",
    missionId: "m1",
    projectId: "repo-a",
    revision: 1,
    status: "implementing",
    assignments: [
      { runId: "team-2c", memberId: "m1", sessionId: "s1", revision: 1, role: "implementer", recordedStatus: "running", workerStatus: "exited" },
      { runId: "team-2c", memberId: "m2", sessionId: "s2", revision: 1, role: "reviewer", recordedStatus: "unavailable", workerStatus: "unknown" },
    ],
    checks: [],
  });
  assert.equal(partialSampledSummary, "Implementing · recorded 1/2 active · 0 of 1 sampled worker live (1 exited, 1 unknown)");

  const confirmedExitReportedSummary = summarizeMissionProgressChild({
    kind: "linked",
    runId: "team-2d",
    missionId: "m1",
    projectId: "repo-a",
    revision: 1,
    status: "ready-for-review",
    assignments: [
      { runId: "team-2d", memberId: "m1", sessionId: "s1", revision: 1, role: "implementer", recordedStatus: "reported", exitConfirmedAt: "2026-11-26T00:02:00.000Z", workerStatus: "not-sampled" },
    ],
    checks: [],
  });
  assert.equal(confirmedExitReportedSummary, "Ready for your review · recorded 0/1 active · 0 workers live");

  const truncatedSummary = summarizeMissionProgressChild({
    kind: "linked",
    runId: "team-3",
    missionId: "m1",
    projectId: "repo-a",
    revision: 1,
    status: "implementing",
    assignments: [
      { runId: "team-3", memberId: "m1", sessionId: "s1", revision: 1, role: "implementer", recordedStatus: "running", workerStatus: "running" },
      { runId: "team-3", memberId: "m2", sessionId: "s2", revision: 1, role: "implementer", recordedStatus: "running", workerStatus: "not-sampled" },
    ],
    assignmentsTruncated: true,
    checks: [],
    checksTruncated: true,
  });
  assert.equal(truncatedSummary, "Implementing · recorded 2 active (2 shown, truncated) · 1 of 1 sampled worker live (1 not-sampled) · checks truncated");
});

test("waitReasonLabel and waitReasonTone map all nine wait reason kinds accurately", () => {
  const expected: Record<TeamWaitReasonKind, { label: string; tone: "error" | "attention" | undefined }> = {
    "owner-decision": { label: "Owner decision", tone: "attention" },
    "provider-prompt": { label: "Provider prompt", tone: "attention" },
    "provider-limit": { label: "Provider limit", tone: "attention" },
    stalled: { label: "Stalled", tone: "error" },
    "spinner-only": { label: "Spinner-only", tone: "attention" },
    "worker-slot": { label: "Worker slot", tone: undefined },
    dependency: { label: "Dependency", tone: undefined },
    "integration-order": { label: "Integration order", tone: undefined },
    "linear-sync": { label: "Linear sync", tone: undefined },
  };

  for (const kind of Object.keys(expected) as TeamWaitReasonKind[]) {
    assert.equal(waitReasonLabel(kind), expected[kind].label);
    assert.equal(waitReasonTone(kind), expected[kind].tone);
  }
});

test("orderMobileWaitReasons places actionable and stall reasons ahead of scheduling waits and preserves stability", () => {
  assert.deepEqual(orderMobileWaitReasons(undefined), []);
  assert.deepEqual(orderMobileWaitReasons([]), []);

  const input: TeamWaitReason[] = [
    { kind: "linear-sync", summary: "Linear sync pending" },
    { kind: "integration-order", summary: "Waiting to integrate t2", taskId: "t2" },
    { kind: "dependency", summary: "Waiting on t1", taskId: "t2", blockedByTaskIds: ["t1"] },
    { kind: "worker-slot", summary: "Waiting for slot 1", taskId: "t3" },
    { kind: "provider-limit", summary: "Codex limit active", resetsAt: "2026-11-26T02:00:00.000Z" },
    { kind: "spinner-only", summary: "Spinner-only redraws", memberId: "m-spin", since: "2026-11-26T00:10:00.000Z" },
    { kind: "stalled", summary: "Member stalled", memberId: "m-stall", since: "2026-11-26T00:08:00.000Z" },
    { kind: "provider-prompt", summary: "Prompt waiting", memberId: "m-prompt" },
    { kind: "owner-decision", summary: "Decision 1", decisionId: "d1", memberId: "m-dec" },
    { kind: "worker-slot", summary: "Waiting for slot 2", taskId: "t4" },
  ];
  const snapshot = input.map(item => ({ ...item }));
  const ordered = orderMobileWaitReasons(input);

  assert.deepEqual(ordered.map(item => item.kind), [
    "owner-decision",
    "provider-prompt",
    "stalled",
    "spinner-only",
    "provider-limit",
    "worker-slot",
    "worker-slot",
    "dependency",
    "integration-order",
    "linear-sync",
  ]);
  assert.deepEqual(
    ordered.filter(item => item.kind === "worker-slot").map(item => item.summary),
    ["Waiting for slot 1", "Waiting for slot 2"],
  );
  assert.deepEqual(input, snapshot);
});

test("shortDate guards empty, undefined, and invalid timestamps", () => {
  assert.equal(shortDate(undefined), "");
  assert.equal(shortDate(""), "");
  assert.equal(shortDate("   "), "");
  assert.equal(shortDate("not-a-date"), "");
  assert.notEqual(shortDate("2026-11-26T00:12:00.000Z"), "");
});

test("spinnerOnlySince and stalledAt metadata are preserved in roster partitions and formatted into screen notices", () => {
  const members: TeamMember[] = [
    makeMember("m-spin", {
      status: "running",
      spinnerOnlySince: "2026-11-26T00:12:00.000Z",
    }),
    makeMember("m-stall", {
      status: "stopped",
      stalledAt: "2026-11-26T00:15:00.000Z",
      stoppedReason: "No activity for 15 minutes",
    }),
    makeMember("m-clean", {
      status: "running",
    }),
  ];

  const partitioned = partitionMobileRoster(members, 2);
  const activeSpin = partitioned.active.find(entry => entry.member.memberId === "m-spin")!.member;
  const finishedStall = partitioned.finished.find(entry => entry.member.memberId === "m-stall")!.member;
  assert.equal(activeSpin.spinnerOnlySince, "2026-11-26T00:12:00.000Z");
  assert.equal(finishedStall.stalledAt, "2026-11-26T00:15:00.000Z");

  assert.deepEqual(memberScreenNotices(activeSpin, iso => `fmt(${iso})`), [
    { kind: "spinner-only", tone: "warning", text: "Spinner-only screen since fmt(2026-11-26T00:12:00.000Z)" },
  ]);
  assert.deepEqual(memberScreenNotices(finishedStall, iso => `fmt(${iso})`), [
    { kind: "stalled", tone: "error", text: "Stalled since fmt(2026-11-26T00:15:00.000Z)" },
  ]);

  assert.deepEqual(
    memberScreenNotices({ status: "running", spinnerOnlySince: "invalid-date" }),
    [{ kind: "spinner-only", tone: "warning", text: "Spinner-only screen" }],
  );
  assert.deepEqual(
    memberScreenNotices({ status: "running", stalledAt: "invalid-date" }, () => "   "),
    [{ kind: "stalled", tone: "error", text: "Stalled" }],
  );
  assert.deepEqual(
    memberScreenNotices({ status: "running", spinnerOnlySince: "2026-11-26T00:12:00.000Z" }, () => ""),
    [{ kind: "spinner-only", tone: "warning", text: "Spinner-only screen" }],
  );

  assert.deepEqual(
    memberScreenNotices({
      status: "running",
      spinnerOnlySince: "2026-11-26T00:12:00.000Z",
      stalledAt: "2026-11-26T00:15:00.000Z",
    }, iso => iso),
    [
      { kind: "stalled", tone: "error", text: "Stalled since 2026-11-26T00:15:00.000Z" },
    ],
  );
  assert.deepEqual(
    memberScreenNotices({ status: "stopped", spinnerOnlySince: "2026-11-26T00:12:00.000Z" }, iso => iso),
    [],
  );
  assert.deepEqual(
    memberScreenNotices({ status: "reported", spinnerOnlySince: "2026-11-26T00:12:00.000Z" }, iso => iso),
    [],
  );
  assert.deepEqual(memberScreenNotices(members[2]!), []);
});
