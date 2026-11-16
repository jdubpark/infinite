import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import type { TeamAcceptanceEvidence, TeamBrief, TeamMember, TeamRun } from "../packages/host/src/team-types.js";

test("scheduler corrects one invalid brief review, then blocks a repeat and records a verified approval", { timeout: 30000 }, async () => {
  const brief: TeamBrief = { title: "Evidence-backed change", problem: "The reviewed behavior needs a concrete check.",
    evidence: [{ source: "Repository inspection", observation: "The behavior has two acceptance criteria." }],
    dataShape: "No persistent data change.", acceptance: ["The first behavior is correct.", "The second behavior is correct."],
    expectedOutcome: "Reviewers can verify both behaviors.", uiChanges: false };
  const goal = { id: randomUUID(), revision: 1, cycle: 1, successCriteria: "Both criteria are verified.", nonGoals: [],
    allowedPaths: ["."], evidence: [], previousWork: [], deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxMembers: 3 };
  const invalid = [
    { criterion: 1, verdict: "verified" as const, evidence: "The focused check passed." },
    { criterion: 2, verdict: "inconclusive" as const, evidence: "The required behavior could not be observed." },
  ];
  const verified = [
    { criterion: 1, verdict: "verified" as const, evidence: "The focused check passed." },
    { criterion: 2, verdict: "verified" as const, evidence: "The runnable behavior matched the criterion." },
  ];
  const open = async () => {
    const f = schedulerFixture();
    try {
      Object.assign(f.config.projects[0]!, { team: { checks: [] } });
      f.run.goal = goal;
      f.run.brief = brief;
      f.run.status = "reviewing";
      f.run.headCommit = f.run.baseCommit;
      f.run.tasks = [{ id: "task", title: "Implement the change", instructions: "Implement the reviewed behavior.",
        paths: ["src/change.ts"], dependsOn: [], revision: 1, status: "integrated", memberId: randomUUID() }];
      const reviewer: TeamMember = { ...f.run.members[0]!, runId: f.run.id, memberId: randomUUID(), revision: 1,
        role: "reviewer", status: "running", sessionId: randomUUID(), title: "reviewer: review the change",
        cwd: f.run.workspace, baseCommit: f.run.baseCommit, report: undefined };
      f.run.members = [reviewer];
      await f.manager.createTeamSession({ requestId: reviewer.sessionId, provider: reviewer.provider ?? "demo",
        title: reviewer.title, prompt: reviewer.prompt },
        { runId: f.run.id, memberId: reviewer.memberId, revision: reviewer.revision, role: "reviewer" }, reviewer.cwd);
      f.writeTeam({ checkHead: f.run.baseCommit });
      const teams = f.openTeam();
      const scheduler = teams as unknown as {
        record(id: string): { run: TeamRun; [key: string]: unknown };
        step(stored: unknown): Promise<void>;
      };
      return { f, teams, scheduler, stored: scheduler.record(f.run.id), reviewer };
    } catch (error) {
      await f.close();
      throw error;
    }
  };
  const reportAndExit = (f: ReturnType<typeof schedulerFixture>, member: TeamMember, acceptance: TeamAcceptanceEvidence[]) => {
    f.report(member.sessionId, { requestId: randomUUID(), runId: f.run.id, memberId: member.memberId, revision: member.revision,
      report: { kind: "review", verdict: "approved", summary: "Reviewed the acceptance criteria.", acceptance } });
    f.exitWithoutNativeSession(member.sessionId);
  };
  const processReport = async (scenario: Awaited<ReturnType<typeof open>>) => {
    await scenario.scheduler.step(scenario.stored);
    await scenario.teams.idle();
  };

  const retrying = await open();
  try {
    reportAndExit(retrying.f, retrying.reviewer, invalid);
    await processReport(retrying);
    const firstCorrection = await waitFor(() => Promise.resolve(retrying.teams.get(retrying.f.run.id)), run =>
      run.status === "blocked" || run.members.some(member => member.role === "reviewer" && member.memberId !== retrying.reviewer.memberId));
    assert.notEqual(firstCorrection.status, "blocked");
    assert.equal(firstCorrection.review, undefined);
    assert.deepEqual(firstCorrection.acceptanceCorrections, [firstCorrection.revision]);
    const correctionMember = firstCorrection.members.filter(member => member.role === "reviewer").at(-1)!;
    assert.notEqual(correctionMember.memberId, retrying.reviewer.memberId);
    assert.equal(retrying.stored.run.members.find(member => member.memberId === retrying.reviewer.memberId)?.status, "stopped");
    const preparedCorrection = retrying.stored.run.members.find(member => member.memberId === correctionMember.memberId)!;
    assert.match(preparedCorrection.prompt, /Report one acceptance entry per criterion/);

    await processReport(retrying);
    const correctionLaunch = retrying.f.launches.find(launch => launch.requestId === correctionMember.sessionId);
    assert.ok(correctionLaunch, "the scheduler launched a corrected reviewer");
    assert.match(correctionLaunch.prompt, /2 \(inconclusive\)/);
    assert.match(correctionLaunch.prompt, /Report one acceptance entry per criterion/);
    assert.match(correctionLaunch.prompt, /If any criterion is not verified, the verdict must be changes-requested/);

    reportAndExit(retrying.f, correctionMember as TeamMember, invalid);
    await processReport(retrying);
    const blocked = retrying.teams.get(retrying.f.run.id);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockCode, "acceptance-evidence-required");
    assert.equal(blocked.review, undefined);
  } finally { await retrying.f.close(); }

  const approving = await open();
  try {
    reportAndExit(approving.f, approving.reviewer, verified);
    await processReport(approving);
    const reviewed = await waitFor(() => Promise.resolve(approving.teams.get(approving.f.run.id)), run => run.review?.verdict === "approved");
    assert.deepEqual(reviewed.review?.acceptance, verified);
  } finally { await approving.f.close(); }
});
