import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { waitFor } from "./helpers.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { TeamError } from "../packages/host/src/teams.js";
import type { TeamBrief, TeamMember, TeamRun } from "../packages/host/src/team-types.js";

test("goal approval requires verified evidence for each brief criterion", async () => {
  const brief: TeamBrief = { title: "Evidence-backed change", problem: "The reviewed behavior needs a concrete check.",
    evidence: [{ source: "Repository inspection", observation: "The behavior has two acceptance criteria." }],
    dataShape: "No persistent data change.", acceptance: ["The first behavior is correct.", "The second behavior is correct."],
    expectedOutcome: "Reviewers can verify both behaviors.", uiChanges: false };
  const goal = { id: randomUUID(), revision: 1, cycle: 1, successCriteria: "Both criteria are verified.", nonGoals: [],
    allowedPaths: ["."], evidence: [], previousWork: [], deadlineAt: new Date(Date.now() + 60_000).toISOString(), maxMembers: 2 };
  const attempt = async (acceptance: { criterion: number; verdict: "verified" | "not-verified" | "inconclusive"; evidence: string }[]) => {
    const f = schedulerFixture();
    try {
      f.run.goal = goal;
      f.run.brief = brief;
      f.run.status = "reviewing";
      f.run.headCommit = f.run.baseCommit;
      const reviewer: TeamMember = { ...f.run.members[0]!, runId: f.run.id, memberId: randomUUID(), revision: 1,
        role: "reviewer", status: "reported", cwd: f.run.workspace, baseCommit: f.run.baseCommit,
        report: { kind: "review", verdict: "approved", summary: "Reviewed both acceptance criteria.", acceptance } };
      f.run.members.push(reviewer);
      f.writeTeam({ checkHead: f.run.baseCommit });
      const teams = f.openTeam();
      const internal = teams as unknown as {
        record(id: string): { run: TeamRun; pending?: unknown };
        consume(stored: { run: TeamRun; pending?: unknown }, member: TeamMember): void;
      };
      const stored = internal.record(f.run.id);
      return { f, teams, stored, reviewer, internal };
    } catch (error) {
      await f.close();
      throw error;
    }
  };

  const incomplete = await attempt([
    { criterion: 1, verdict: "verified", evidence: "The focused check passed." },
    { criterion: 2, verdict: "inconclusive", evidence: "The required behavior could not be observed." },
  ]);
  try {
    assert.throws(() => incomplete.internal.consume(incomplete.stored, incomplete.reviewer), error =>
      error instanceof TeamError && error.status === 409 && error.code === "acceptance-evidence-required" && /2 \(inconclusive\)/.test(error.message));
  } finally { await incomplete.f.close(); }

  const complete = await attempt([
    { criterion: 1, verdict: "verified", evidence: "The focused check passed." },
    { criterion: 2, verdict: "verified", evidence: "The runnable behavior matched the criterion." },
  ]);
  try {
    complete.internal.consume(complete.stored, complete.reviewer);
    const reviewed = await waitFor(() => Promise.resolve(complete.teams.get(complete.f.run.id)), run => run.review?.verdict === "approved", 5000);
    assert.deepEqual(reviewed.review?.acceptance, complete.reviewer.report?.kind === "review" ? complete.reviewer.report.acceptance : undefined);
  } finally { await complete.f.close(); }
});
