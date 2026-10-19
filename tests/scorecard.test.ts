import assert from "node:assert/strict";
import test from "node:test";
import { scorecard, wilsonInterval } from "../packages/host/src/scorecard.js";
import type { TeamMember, TeamRun } from "../packages/host/src/team-types.js";

function fixture(profileId: string, provider: "opencode" | "claude", integrated: number, total: number, opts: { rating?: number } = {}): TeamRun {
  const modelProfile = { id: profileId, label: profileId, provider, model: provider === "opencode" ? "meta/model" : "claude-model", ...(provider === "claude" ? { effort: "medium" as const } : {}) } as TeamMember["modelProfile"];
  const members = Array.from({ length: total }, (_, index) => ({ memberId: `${profileId}-${index}`, sessionId: `${profileId}-session-${index}`, role: "implementer", revision: 1,
    title: profileId, status: index >= integrated ? "stopped" : "completed", taskId: `task-${index}`, modelProfile,
    startedAt: new Date(Date.now() - 60_000).toISOString(), stoppedReason: index === total - 1 && total > integrated ? "provider usage limit" : undefined } as unknown as TeamMember));
  const tasks = members.map((member, index) => ({ id: `task-${index}`, title: `Task ${index}`, instructions: "", paths: ["src"], dependsOn: [], memberId: member.memberId,
    status: index < integrated ? "integrated" : "blocked", ...(index < integrated && opts.rating ? { ownerRating: { score: opts.rating as 1 | 2 | 3 | 4 | 5, at: new Date().toISOString() } } : {}) } as TeamRun["tasks"][number]));
  return { id: profileId, projectId: "project", provider: "claude", title: "Run", objective: "Objective", parallelism: 1, revision: 1, status: "ready-for-review", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workspace: "/workspace", branch: "branch", baseCommit: "", tasks, members, decisions: [], checks: [], steering: [], events: [], round: 0 };
}

test("Wilson interval and tiny samples retain interval without suggestion", () => {
  assert.deepEqual(wilsonInterval(8, 10)?.map(value => Number(value.toFixed(2))), [0.49, 0.94]);
  const result = scorecard([fixture("a", "opencode", 1, 1), fixture("b", "opencode", 1, 1)], () => ({ cost: 1, tokens: 100, unpriced: 0 }));
  assert.equal(result.rows[0].enough, false);
  assert.ok(result.rows[0].rateInterval);
  assert.deepEqual(result.suggestions, []);
});

test("limit-switched attempts are excluded and subscription costs are null", () => {
  const result = scorecard([fixture("metered", "opencode", 9, 10), fixture("subscription", "claude", 10, 10)], () => ({ cost: 1, tokens: 100, unpriced: 0 }));
  assert.equal(result.rows.find(row => row.profileId === "metered")?.attempts, 9);
  const subscription = result.rows.find(row => row.profileId === "subscription")!;
  assert.equal(subscription.medianUsd, null);
  assert.equal(subscription.medianTokens, null);
});

test("enough metered profiles with overlapping intervals produce an advisory", () => {
  const result = scorecard([fixture("cheap", "opencode", 10, 11), fixture("costly", "opencode", 9, 11)], sessionId => ({ cost: sessionId.startsWith("cheap") ? 0.2 : 0.8, tokens: 1000, unpriced: 0 }));
  assert.equal(result.suggestions.length, 1);
  assert.match(result.suggestions[0].text, /cheap integrated 10\/10 implementer tasks/);
});
