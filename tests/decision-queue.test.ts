import assert from "node:assert/strict";
import test from "node:test";
import { initialAttention, type Attention, type Prompt } from "@infinite/attention";
import { buildDecisionQueue } from "../packages/host/src/decision-queue.js";
import { readDecisionQueue } from "../packages/host/src/decision-queue-read.js";
import { publicAttention, type Manager } from "../packages/host/src/manager.js";
import type { MissionDecision } from "../packages/host/src/mission-types.js";
import type { TeamDecision } from "../packages/host/src/team-types.js";
import { promptOwner } from "../packages/host/src/notifier.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { limitLineup } from "./team-fixture.js";

type QueueInput = Parameters<typeof buildDecisionQueue>[0];
type SessionInput = QueueInput["sessions"][number];
type TeamInput = QueueInput["teams"][number];
type MissionInput = QueueInput["missions"][number];

const at = (minute: number) => `2026-11-21T12:${String(minute).padStart(2, "0")}:00.000Z`;
const hash = "a".repeat(64);

function prompt(id: number, tool?: Prompt["tool"]): Prompt {
  return {
    id,
    kind: "permission",
    title: "Run this command?",
    options: [{ index: 1, label: "Run", role: "accept" }],
    acceptsText: false,
    source: "hook",
    hash,
    ...(tool === undefined ? {} : { tool }),
  };
}

function attention(since: string, state: Attention["state"] = "needs-you", currentPrompt?: Prompt): Attention {
  return {
    ...initialAttention(since, true),
    state,
    ...(currentPrompt === undefined ? {} : { prompt: currentPrompt }),
  };
}

function session(id: string, overrides: Partial<Omit<SessionInput, "id" | "title">> = {}): SessionInput {
  return {
    id,
    title: `Session ${id}`,
    projectId: `project-${id}`,
    status: "running",
    attention: attention(at(10), "needs-you", prompt(1)),
    owner: "user",
    team: undefined,
    ...overrides,
  };
}

function teamDecision(id: string, revision = 1, answer?: string): TeamDecision {
  return {
    id,
    memberId: "member-1",
    revision,
    question: `Question ${id}`,
    options: ["Keep", "Change"],
    createdAt: at(20),
    ...(answer === undefined ? {} : { answer }),
  };
}

function team(id: string, overrides: Partial<Omit<TeamInput, "id" | "title">> = {}): TeamInput {
  return {
    id,
    title: `Team ${id}`,
    projectId: `project-${id}`,
    revision: 1,
    status: "needs-input",
    missionId: undefined,
    goal: false,
    held: false,
    goalCanAnswer: false,
    decisions: [],
    ...overrides,
  };
}

function missionDecision(id: string, answer?: string): MissionDecision {
  return {
    id,
    question: `Question ${id}`,
    options: ["Keep", "Change"],
    createdAt: at(20),
    ...(answer === undefined ? {} : { answer }),
  };
}

function mission(id: string, overrides: Partial<Omit<MissionInput, "id" | "title">> = {}): MissionInput {
  return {
    id,
    title: `Mission ${id}`,
    projectId: `project-${id}`,
    revision: 1,
    status: "needs-input",
    takesAnswers: true,
    decisions: [],
    ...overrides,
  };
}

test("session decisions require a live user-owned needs-you prompt and expose no tool input", () => {
  const queued = buildDecisionQueue({
    sessions: [
      session("visible", {
        projectId: "project-a",
        team: { id: "team-a", title: "Team A", role: "implementer" },
        attention: attention(at(10), "needs-you", prompt(7, { name: "Bash", input: { command: "private command" }, inputComplete: true })),
      }),
      session("working", { attention: attention(at(11), "working", prompt(8)) }),
      session("exited", { status: "exited" }),
      session("no-prompt", { attention: attention(at(12), "needs-you") }),
      session("coordinator-owned", { owner: "coordinator" }),
      session("undecided", { owner: "undecided" }),
    ],
    teams: [],
    missions: [],
  });

  assert.equal(queued.decisions.length, 1);
  assert.deepEqual(queued.decisions[0], {
    kind: "session",
    key: "session:visible:7",
    since: at(10),
    origin: {
      id: "visible",
      title: "Session visible",
      projectId: "project-a",
      team: { id: "team-a", title: "Team A", role: "implementer" },
    },
    answerPath: "/api/sessions/visible/answer",
    prompt: {
      id: 7,
      kind: "permission",
      title: "Run this command?",
      options: [{ index: 1, label: "Run", role: "accept" }],
      acceptsText: false,
      source: "hook",
      hash,
      tool: { name: "Bash", input: {} },
    },
  });
});

test("a session prompt that only its terminal can answer is listed and marked", () => {
  const unverified = (id: number): Prompt => { const { hash: _hash, ...rest } = prompt(id); return rest; };
  const waiting = (id: string, minute: number, current: Prompt, backend?: SessionInput["backend"]) =>
    session(id, { ...(backend === undefined ? {} : { backend }), attention: attention(at(minute), "needs-you", current) });
  const text = { source: "protocol", acceptsText: true, options: [] } as const;
  const queued = buildDecisionQueue({
    sessions: [
      waiting("verified", 1, prompt(1)),
      waiting("hook-only", 2, unverified(2)),
      waiting("multi-select", 3, { ...prompt(3), multiSelect: true }),
      waiting("no-options", 4, { ...prompt(4), options: [] }),
      waiting("text-native", 5, { ...prompt(5), ...text }),
      waiting("text-cmux", 6, { ...prompt(6), ...text }, "cmux"),
      waiting("text-cmux-unverified", 7, { ...unverified(7), ...text }, "cmux"),
    ],
    teams: [],
    missions: [],
  });

  assert.deepEqual(queued.decisions.map(item => [item.origin.id, item.kind === "session" && item.terminalOnly === true]), [
    ["verified", false],
    ["hook-only", true],
    ["multi-select", true],
    ["no-options", true],
    ["text-native", true],
    ["text-cmux", false],
    ["text-cmux-unverified", true],
  ]);
  assert.equal("terminalOnly" in queued.decisions[0]!, false);
});

test("shared prompt ownership checks the permission holder before the team coordinator", () => {
  const row = { id: "session", attention: attention(at(1), "needs-you", prompt(9)) };
  let teamCalls = 0;
  const teams = { promptOwner: () => { teamCalls++; return "user" as const; } };

  assert.equal(promptOwner(row, { holder: () => "agent" }, teams), "coordinator");
  assert.equal(teamCalls, 0);
  assert.equal(promptOwner(row, { holder: () => "undecided" }, teams), "undecided");
  assert.equal(teamCalls, 0);
  assert.equal(promptOwner(row, { holder: () => "owner" }, { promptOwner: () => "coordinator" }), "coordinator");
  assert.equal(promptOwner(row, { holder: () => { throw new Error("unavailable"); } }), "user");
});

test("queue classifies delegated member prompts before hiding tool input", async () => {
  const f = schedulerFixture();
  try {
    const member = f.run.members[0]!;
    f.run.status = "implementing";
    f.run.permissions = { mode: "coordinator", scope: "Approve one-time checks.", maxDecisions: 2 };
    f.run.lineup = limitLineup;
    f.writeTeam();
    const teams = f.openTeam();
    const prompt: Prompt = {
      id: 1, kind: "permission", source: "hook", hash: "a".repeat(64), acceptsText: false,
      title: "Run command?", options: [{ index: 0, label: "Yes, proceed", role: "accept" }, { index: 1, label: "No", role: "reject" }],
      tool: { name: "Bash", input: { command: "npm run check" }, inputComplete: true },
    };
    const row = {
      id: member.sessionId, title: "Delegated member", projectId: "fixture", provider: "demo", cwd: member.cwd,
      createdAt: at(1), contextVersion: 1, status: "running" as const, seq: 0, screen: "",
      attention: attention(at(1), "needs-you", prompt),
      team: { runId: f.run.id, memberId: member.memberId, revision: member.revision, role: member.role },
    };
    const manager = {
      list: async (options?: { includeFullMessage?: boolean }) =>
        [options?.includeFullMessage === true ? row : { ...row, attention: publicAttention(row.attention) }],
    } as unknown as Pick<Manager, "list">;
    const read = (service: typeof teams) => readDecisionQueue({
      manager, cmux: undefined, permissions: { holder: () => "owner" }, teams: service,
      goals: { decisionAnswerable: () => false }, missions: { decisionQueueCandidates: () => [] },
    });

    assert.equal(teams.promptOwner(member.sessionId, publicAttention(row.attention).prompt!), "user");
    assert.equal(teams.promptOwner(member.sessionId, prompt), "undecided");
    assert.deepEqual((await read(teams)).decisions, []);

    f.run.permissionsRevokedAt = new Date().toISOString();
    f.writeTeam();
    teams.close();
    const revoked = f.openTeam();
    assert.equal(revoked.promptOwner(member.sessionId, prompt), "user");
    const queued = await read(revoked);
    assert.deepEqual(queued.decisions.map(item => item.key), [`session:${member.sessionId}:1`]);
    assert.equal(queued.decisions[0]?.kind, "session");
    assert.deepEqual(queued.decisions[0]?.kind === "session" && queued.decisions[0].prompt.tool?.input, {});
  } finally { f.close(); }
});

test("team decisions must be unanswered and belong to the current revision", () => {
  const queued = buildDecisionQueue({
    sessions: [],
    teams: [team("team-a", { decisions: [teamDecision("old", 0), teamDecision("answered", 1, "Keep"), teamDecision("current")] })],
    missions: [],
  });

  assert.deepEqual(queued.decisions, [{
    kind: "team",
    key: "team:team-a:current",
    since: at(20),
    origin: { id: "team-a", title: "Team team-a", projectId: "project-team-a" },
    answerPath: "/api/teams/team-a/decisions/current/answer",
    revision: 1,
    decision: teamDecision("current"),
  }]);
});

test("paused, closed, and mission-owned teams are excluded while answerable goals remain", () => {
  const queued = buildDecisionQueue({
    sessions: [],
    teams: [
      team("paused", { status: "paused", decisions: [teamDecision("d")] }),
      team("held-paused", { status: "paused", held: true, decisions: [teamDecision("d")] }),
      team("merged", { status: "merged", revision: 2, decisions: [teamDecision("old-open-looking", 2)] }),
      team("reviewed", { status: "ready-for-review", decisions: [teamDecision("d")] }),
      team("unchanged", { status: "no-change", decisions: [teamDecision("d")] }),
      team("cancelled", { status: "cancelled", decisions: [teamDecision("d")] }),
      team("mission-owned", { missionId: "mission-a", decisions: [teamDecision("d")] }),
      team("goal-hidden", { goal: true, goalCanAnswer: false, decisions: [teamDecision("d")] }),
      team("goal-answerable", { goal: true, goalCanAnswer: true, decisions: [teamDecision("d")] }),
    ],
    missions: [],
  });

  assert.deepEqual(queued.decisions.map(decision => decision.key), ["team:goal-answerable:d", "team:held-paused:d"]);
  const held = queued.decisions.find(decision => decision.key === "team:held-paused:d");
  assert.equal(held?.kind === "team" && held.held, true);
});

test("mission-held subteam decisions appear once while the mission takes answers", () => {
  const queued = buildDecisionQueue({
    sessions: [],
    teams: [team("subteam", { missionId: "accepting", decisions: [teamDecision("child")] })],
    missions: [
      mission("accepting", { decisions: [missionDecision("answered", "Keep"), { ...missionDecision("forwarded"), childDecisionId: "child" }, missionDecision("open")] }),
      mission("read-only", { takesAnswers: false, decisions: [missionDecision("open")] }),
    ],
  });

  assert.deepEqual(queued.decisions.map(decision => decision.key), ["mission:accepting:forwarded", "mission:accepting:open"]);
  assert.equal(queued.decisions[0].kind, "mission");
  assert.equal(queued.decisions[0].kind === "mission" && queued.decisions[0].decision.childDecisionId, "child");
});

test("queue order is oldest first, then stable key", () => {
  const queued = buildDecisionQueue({
    sessions: [session("b", { attention: attention(at(1), "needs-you", prompt(1)) })],
    teams: [team("late", { decisions: [{ ...teamDecision("d"), createdAt: at(3) }] })],
    missions: [mission("z", { decisions: [{ ...missionDecision("d"), createdAt: at(2) }] }), mission("a", { decisions: [{ ...missionDecision("d"), createdAt: at(2) }] })],
  });

  assert.deepEqual(queued.decisions.map(decision => [decision.key, decision.since]), [
    ["session:b:1", at(1)],
    ["mission:a:d", at(2)],
    ["mission:z:d", at(2)],
    ["team:late:d", at(3)],
  ]);
});
