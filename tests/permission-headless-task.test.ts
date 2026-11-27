import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { GoalService } from "../packages/host/src/goals.js";
import { HeadlessPermissionChannel, channelToken, headlessRequest, headlessTask } from "../packages/host/src/permission-headless.js";
import { teamPermissionTask } from "../packages/host/src/team-permission-adapter.js";
import { turnPrompt, type TurnContext } from "../packages/host/src/permission-reviewer.js";
import { teamPrompt } from "../packages/host/src/team-prompts.js";
import type { PermissionPipeline } from "../packages/host/src/permission-agent-types.js";
import type { CreateGoal } from "../packages/host/src/goal-types.js";
import type { TeamLineup, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import type { Config, Session } from "../packages/host/src/types.js";

const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};
const command = { command: process.execPath, args: ["-e", "0"] };

function fixture() {
  const f = schedulerFixture();
  f.config.teams = { ...f.config.teams!, lineup };
  f.config.projects[0]!.team = { checks: [command], objective: { prompts: "on" } } as Config["projects"][number]["team"];
  f.config.agents = { claude: { command: process.execPath, args: [] }, codex: { command: process.execPath, args: [] } } as Config["agents"];
  return f;
}

function setSwitch(f: ReturnType<typeof fixture>, value: "on" | "off") {
  f.config.projects[0]!.team = { ...f.config.projects[0]!.team!, objective: { prompts: value } } as Config["projects"][number]["team"];
}

const judgement = (statement: string) => ({ statement, check: { kind: "judgement" as const, item: "sources" }, threshold: { kind: "pass" as const } });
const add = (criterion: ReturnType<typeof judgement>) => ({ op: "criterion.add" as const, criterion });
const correction = (version: number, ops: unknown[]) => ({ requestId: randomUUID(), version, ops });
const createInput = (overrides: Partial<CreateGoal> = {}): CreateGoal => ({
  requestId: randomUUID(), projectId: "fixture", title: "Rank sources", objective: "Find ranked sources",
  successCriteria: "A ranked shortlist with reasons and sources", nonGoals: ["no paid sources"], allowedPaths: ["research"],
  evidence: ["notes.md"], maxRuns: 2, maxMinutes: 60, maxMembers: 4, parallelism: 2, ...overrides,
});

const bash = (command: string, toolUseId = "toolu_1") => ({ toolName: "Bash", toolInput: { command }, toolUseId });

for (const prompts of ["on", "off"] as const) {
  test(`a headless team member's reviewer turn carries the run objective and task, not the member prompt (objective prompts ${prompts})`, async () => {
    const success = `SUCCESS-${randomUUID()}`, criterion = `CRITERION-${randomUUID()}`;
    const f = fixture();
    let teams = f.openTeam(), goals: GoalService | undefined;
    try {
      goals = new GoalService(f.config, f.key, teams);
      const created = await goals.create(createInput({ successCriteria: `A ranked shortlist that holds ${success}` }));
      await goals.correctObjective(created.id, correction(1, [add(judgement(criterion))]));
      setSwitch(f, prompts);
      goals.start();
      await goals.idle();
      const teamId = goals.get(created.id).activeTeamId;
      assert.ok(teamId, "the tick launched the first cycle");
      goals.close(); goals = undefined; teams.close();

      const stored = f.readRecord<{ run: TeamRun } & Record<string, unknown>>("team", teamId);
      const run = structuredClone(stored.run);
      const task = { id: "task-a", memberId: "member-a", title: "Rank the sources", instructions: "Write the shortlist file", dependsOn: [], status: "running",
        allowedPaths: ["research"], acceptance: ["The shortlist exists"] } as unknown as TeamTask;
      run.tasks = [task];
      run.members = [...run.members, { runId: run.id, memberId: "member-a", revision: 1, role: "implementer", sessionId: randomUUID(), title: task.title,
        status: "running", cwd: run.workspace, baseCommit: run.baseCommit, prompt: "", cursor: 0, stopRequestId: randomUUID(),
        startedAt: new Date().toISOString(), taskId: task.id, provider: "claude" } as unknown as TeamRun["members"][number]];
      const member = run.members.at(-1)!;
      f.writeRecord("team", teamId, { ...stored, run });
      teams = f.openTeam();

      const session = { id: member.sessionId, projectId: "fixture", provider: "claude", cwd: f.run.workspace, title: task.title,
        initialPrompt: teamPrompt(run, "implementer", task, "", "claude"), headless: { channel: true },
        team: { runId: run.id, memberId: member.memberId, revision: 1, role: "implementer", taskId: task.id } } as unknown as Session;

      assert.ok(session.initialPrompt.includes(success), "control: the member prompt holds the success text");
      if (prompts === "on") assert.ok(session.initialPrompt.includes(criterion), "control: the member prompt holds the pinned digest");
      assert.equal(run.objective.includes(success) || run.objective.includes(criterion), false);
      const hostTask = teams.permissionAgentTask(session);
      assert.deepEqual(hostTask, teamPermissionTask(run, task));
      const channelTask = headlessTask(session, s => teams.permissionAgentTask(s));
      assert.deepEqual(channelTask, hostTask);
      const request = headlessRequest(session, { toolName: "Bash", toolInput: { command: "make safe-build" } }, `headless:${session.id}:toolu_1`, channelTask!);
      const context: TurnContext & { canAllow: boolean } = { interruptClasses: [], openRejects: [], evidenceRejects: [], raised: [], requesterFamily: undefined, canAllow: true };
      const text = turnPrompt(request, context);
      assert.ok(text.includes(run.objective), "the reviewer turn holds the run objective");
      assert.equal(text.includes(success) || text.includes(criterion), false);
    } finally { goals?.close(); teams.close(); f.close(); }
  });
}

function rig(extra: { team?: Session["team"]; teamTask?: (session: Pick<Session, "team">) => { title: string; text: string } | undefined; prompt?: string }) {
  const key = randomBytes(32);
  const session = { id: randomUUID(), projectId: "rehearsal", provider: "claude", cwd: tmpdir(), title: "T", initialPrompt: extra.prompt ?? "do it",
    headless: { channel: true }, ...(extra.team ? { team: extra.team } : {}) } as Session;
  const decided: unknown[] = [];
  const classed: unknown[] = [];
  const pipeline = {
    serves: () => ({ served: true }),
    classOf: (request: unknown) => { classed.push(request); return { interruptClass: "production-or-staging", rule: "production-deploy" }; },
    async decide(request: unknown) { decided.push(request); return { kind: "allow", decisionId: randomUUID(), strongTier: false }; },
    applicable: () => true,
    recordDelivery() {},
    taskEnded() {},
  } as unknown as PermissionPipeline;
  const channel = new HeadlessPermissionChannel({
    key, runDir: tmpdir(), services: { pipeline },
    sessions: { meta: () => ({ session }), list: async () => [] },
    teamLive: () => true,
    ...(extra.teamTask ? { teamTask: extra.teamTask } : {}),
  });
  const ask = (request: Record<string, unknown>) => channel.handle({ v: 1, sessionId: session.id, token: channelToken(key, session.id), ...request });
  return { ask, session, decided, classed };
}

test("a team session's request carries the reader's task, never the member prompt", async () => {
  const marker = `PROMPT-${randomUUID()}`;
  const team = { runId: "run-1", memberId: "member-1", revision: 1, role: "implementer", taskId: "task-a" } as NonNullable<Session["team"]>;
  const task = { title: "Task", text: "OBJECTIVE" };
  const h = rig({ team, teamTask: () => task, prompt: `The member prompt holds ${marker}` });
  const assertClean = (request: unknown) => {
    assert.deepEqual((request as { requester: { task: unknown } }).requester.task, task);
    assert.equal(JSON.stringify(request).includes(marker), false, "the member prompt never reaches the request");
  };
  await h.ask({ op: "class", call: bash("deploy production") });
  assert.equal(h.classed.length, 1, "the class check saw one request");
  assertClean(h.classed[0]);
  const before = h.decided.length;
  await h.ask({ op: "decide", call: bash("make safe-build"), requestId: `headless:${h.session.id}:toolu_1` });
  assert.equal(h.decided.length, before + 1, "the decide op saw one request");
  assertClean(h.decided[before]);
});

test("a team session whose task cannot be read is not served", async () => {
  const team = { runId: "run-1", memberId: "member-1", revision: 1, role: "implementer", taskId: "task-a" } as NonNullable<Session["team"]>;
  for (const teamTask of [() => undefined, () => { throw new Error("no run"); }]) {
    const h = rig({ team, teamTask });
    assert.deepEqual(await h.ask({ op: "class", call: bash("deploy production") }), { result: "not-served" });
    assert.deepEqual(await h.ask({ op: "decide", call: bash("make safe-build"), requestId: `headless:${h.session.id}:toolu_1` }), { result: "not-served" });
    assert.equal(h.decided.length, 0, "the pipeline's decide is never called");
  }
  const session = { title: "T", initialPrompt: "p", team } as Session;
  assert.equal(headlessTask(session, undefined), undefined);
  assert.equal(headlessTask(session, () => { throw new Error("no run"); }), undefined);
});

test("a session outside a run keeps its own prompt as task text", () => {
  const session = { id: randomUUID(), title: "T".repeat(250), initialPrompt: "p".repeat(5000) } as Session;
  assert.deepEqual(headlessTask(session, undefined), { title: "T".repeat(200), text: "p".repeat(4000) });
  assert.deepEqual(headlessTask(session, () => ({ title: "x", text: "y" })), { title: "T".repeat(200), text: "p".repeat(4000) });
});
