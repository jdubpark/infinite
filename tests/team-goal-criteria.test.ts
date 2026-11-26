import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { teamReportSchema, type RecordDigest, type TeamMember, type TeamRun, type TeamTaskPlan } from "../packages/host/src/team-types.js";
import { goalPlan, prepareGoalPlanFixture } from "./fixtures/goal-plan-sim.js";
import { validateGoalTaskCriterionRefs } from "../packages/host/src/team-goal-criteria.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import type { TeamService } from "../packages/host/src/teams.js";
import type { RunEvent } from "../packages/host/src/evidence/types.js";

type SchedulerFixture = ReturnType<typeof schedulerFixture>;
type Stored = { run: TeamRun; pending?: unknown; goalPlanCorrectionRevision?: number };
type Internals = {
  record(id: string): Stored;
  prepareMember(stored: Stored, role: "project-manager"): void;
  replaceStalledMember(stored: Stored, member: TeamMember): Promise<void>;
  consume(stored: Stored, member: TeamMember): void;
  block(stored: Stored, error: unknown, member?: TeamMember): void;
};
const internals = (teams: TeamService) => teams as unknown as Internals;

function openEvents(fixture: SchedulerFixture) {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(fixture.config.stateDir), vaultKey: fixture.key });
  return { store, events: new EventOutbox(store) };
}

function eventsOf(store: EvidenceStore, runId: string, kind: string): RunEvent[] {
  const events: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = store.events({ runId, after, limit: 500 });
    events.push(...page.events);
    if (!page.more) return events.filter(event => event.kind === kind);
    after = page.cursor;
  }
}

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function markedPlanner(fixture: SchedulerFixture, teams: TeamService) {
  const scheduler = internals(teams), stored = scheduler.record(fixture.run.id);
  scheduler.prepareMember(stored, "project-manager");
  await waitFor(() => stored.run.members.some(member => member.memberId !== fixture.run.members[0]!.memberId && member.goalCriteriaPlan), "fresh PM is prepared with a host-owned pin");
  await teams.idle();
  return { stored, member: stored.run.members.filter(member => member.goalCriteriaPlan).at(-1)! };
}

test("plan reports carry typed objective-version-pinned task criterion references", () => {
  const report = {
    kind: "plan",
    summary: "Work on the output and its verification.",
    tasks: [{
      id: "output",
      title: "Write the output",
      instructions: "Create the output for the pinned objective.",
      paths: ["src/output.ts"],
      dependsOn: [],
      criterionRefs: { objectiveVersion: 7, criteria: ["c0", "c2"] },
    }],
  };

  assert.deepEqual(teamReportSchema.parse(report), report);
});

test("the generated report-tool schema advertises task criterion references to live planners", () => {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "schema-test", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ].map(request => JSON.stringify(request)).join("\n") + "\n";
  const output = execFileSync(process.execPath, ["--import", "tsx", "packages/host/src/team-mcp.ts"], { input: requests, encoding: "utf8" });
  const listed = JSON.parse(output.trim().split("\n")[1]!) as { result: { tools: { name: string; inputSchema: unknown }[] } };
  const tool = listed.result.tools.find(candidate => candidate.name === "report");
  assert.ok(tool, "the normal report tool is advertised");
  const serialized = JSON.stringify(tool.inputSchema);

  assert.ok(serialized.includes('"criterionRefs"'), "the MCP report input exposes the task field");
  assert.ok(serialized.includes('"objectiveVersion"'), "the generated input exposes its pin");
});

test("criterion references reject duplicate IDs at the report boundary", () => {
  const result = teamReportSchema.safeParse({
    kind: "plan",
    summary: "Plan.",
    tasks: [{ id: "output", title: "Output", instructions: "Write output.", paths: ["src/output.ts"], dependsOn: [],
      criterionRefs: { objectiveVersion: 7, criteria: ["c0", "c0"] } }],
  });

  assert.equal(result.success, false);
});

const pinnedRecord: RecordDigest = { version: 7, criteria: [
  { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" },
  { id: "c2", statement: "The output is valid.", check: "artifact:src/output.json", producer: "host" },
  { id: "c3", statement: "The output has sources.", check: "citation-form:src/output.json", producer: "host" },
] };
const pin = { objectiveVersion: 7 } as const;
const task = (id: string, refs?: TeamTaskPlan["criterionRefs"], dependsOn: string[] = []): TeamTaskPlan => ({
  id, title: id, instructions: `Implement ${id}.`, paths: [`src/${id}.ts`], dependsOn,
  ...(refs ? { criterionRefs: refs } : {}),
});
const refs = (...criteria: string[]) => ({ objectiveVersion: 7, criteria });

test("each task, including a prerequisite, directly covers a pinned active criterion", () => {
  const tasks = [
    task("schema", refs("c2")),
    task("writer", refs("c2"), ["schema"]),
  ];

  assert.doesNotThrow(() => validateGoalTaskCriterionRefs(tasks, pin, pinnedRecord));
});

test("a valid plan may target one criterion while other criteria remain open", () => {
  assert.doesNotThrow(() => validateGoalTaskCriterionRefs([task("writer", refs("c2"))], pin, pinnedRecord));
});

test("new goal plans reject missing, invented, and retired criterion references", () => {
  const cases: [string, TeamTaskPlan[], string][] = [
    ["missing", [task("writer")], "goal-task-criteria-invalid"],
    ["invented", [task("writer", refs("c99"))], "goal-task-criteria-invalid"],
    ["retired", [task("writer", refs("c1"))], "goal-task-criteria-invalid"],
  ];
  for (const [name, tasks, code] of cases) {
    assert.throws(() => validateGoalTaskCriterionRefs(tasks, pin, pinnedRecord), (error: unknown) =>
      error instanceof TeamError && error.code === code, name);
  }
});

test("a task cannot attribute work to a different objective version", () => {
  assert.throws(() => validateGoalTaskCriterionRefs([task("writer", { objectiveVersion: 6, criteria: ["c2"] })], pin, pinnedRecord), (error: unknown) =>
    error instanceof TeamError && error.code === "goal-task-criteria-invalid");
});

test("the host rejects a missing or changed pinned record separately from a report mistake", () => {
  assert.throws(() => validateGoalTaskCriterionRefs([task("writer", refs("c2"))], pin, undefined), (error: unknown) =>
    error instanceof TeamError && error.code === "goal-criteria-pin-unavailable");
  assert.throws(() => validateGoalTaskCriterionRefs([task("writer", refs("c2"))], pin, { ...pinnedRecord, version: 8 }), (error: unknown) =>
    error instanceof TeamError && error.code === "goal-criteria-pin-stale");
});

test("old or unbound plans keep legacy behavior only when they omit criterion references", () => {
  assert.doesNotThrow(() => validateGoalTaskCriterionRefs([task("writer")], undefined, undefined));
  assert.throws(() => validateGoalTaskCriterionRefs([task("writer", refs("c2"))], undefined, pinnedRecord), (error: unknown) =>
    error instanceof TeamError && error.code === "goal-task-criteria-invalid");
});

test("a new goal plan gets one correction, replacement keeps its pin, and accepted links remain claims", async () => {
  const fixture = schedulerFixture();
  const { store, events } = openEvents(fixture);
  try {
    fixture.run.members[0]!.status = "stopped";
    prepareGoalPlanFixture(fixture);
    const teams = fixture.openTeam({ events });
    const scheduler = internals(teams);
    const { stored, member } = await markedPlanner(fixture, teams);
    assert.deepEqual(member.goalCriteriaPlan, { objectiveVersion: 7 });
    assert.ok(member.prompt.includes('"objectiveVersion":7'));

    await (scheduler as unknown as { launch(stored: Stored, member: TeamMember): Promise<void> }).launch(stored, member);
    assert.equal(member.status, "running", "the scheduler starts the pinned planner before it stalls");
    member.lastActivityAt = new Date(Date.now() - 6 * 60000).toISOString();
    await scheduler.replaceStalledMember(stored, member);
    await waitFor(() => stored.pending === undefined && stored.run.members.length >= 3, "the marked PM replacement is prepared");
    await teams.idle();
    const replacement = stored.run.members.at(-1)!;
    assert.deepEqual(replacement.goalCriteriaPlan, member.goalCriteriaPlan, "the replacement keeps the exact objective pin");
    assert.ok(replacement.prompt.includes('"objectiveVersion":7'), "the replacement prompt keeps the serialized objective pin");
    assert.ok(replacement.prompt.includes("every task, including each prerequisite"), "the saved prompt keeps the contract");

    replacement.report = teamReportSchema.parse(goalPlan());
    scheduler.consume(stored, replacement);
    await waitFor(() => stored.pending === undefined && stored.run.members.length >= 4, "one corrective PM is prepared");
    await teams.idle();
    assert.equal(stored.goalPlanCorrectionRevision, stored.run.revision);
    assert.deepEqual(stored.run.tasks, [], "the invalid plan starts no implementer task");
    const correction = stored.run.members.at(-1)!;
    assert.equal(correction.role, "project-manager");
    assert.deepEqual(correction.goalCriteriaPlan, { objectiveVersion: 7 });
    assert.ok(correction.prompt.includes("must include"));

    correction.report = teamReportSchema.parse(goalPlan({ objectiveVersion: 7, criteria: ["c2"] }));
    scheduler.consume(stored, correction);
    await waitFor(() => stored.pending === undefined && stored.run.tasks.length === 1, "the corrected plan is accepted");
    await teams.idle();

    const view = teams.get(fixture.run.id);
    assert.deepEqual(view.tasks[0]!.criterionRefs, { objectiveVersion: 7, criteria: ["c2"] }, "the public task retains accepted attribution");
    assert.equal("goalCriteriaPlan" in view.members.find(row => row.memberId === correction.memberId)!, false, "the internal marker is not public");
    const [planned] = eventsOf(store, fixture.run.id, "task.planned");
    assert.ok(planned, "task.planned is stored");
    assert.deepEqual(planned.data.criterionRefs, { objectiveVersion: 7, criteria: ["c2"] });
    assert.equal(eventsOf(store, fixture.run.id, "verdict.recorded").length, 0, "mapping does not create a criterion verdict");
    assert.equal(view.assessment, undefined, "mapping does not satisfy the goal");
    assert.equal(view.members.some(row => row.role === "implementer"), false, "no writer is started by accepting references");
  } finally { store.close(); fixture.close(); }
});

test("a repeated bad link after restart blocks without launching a writer", async () => {
  const fixture = schedulerFixture();
  const { store, events } = openEvents(fixture);
  let teams: TeamService | undefined;
  try {
    prepareGoalPlanFixture(fixture);
    teams = fixture.openTeam({ events });
    const scheduler = internals(teams);
    const { stored, member } = await markedPlanner(fixture, teams);
    member.report = teamReportSchema.parse(goalPlan({ objectiveVersion: 7, criteria: ["c99"] }));
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined && stored.run.members.length >= 3, "the first invalid report receives one correction");
    await teams.idle();
    assert.equal(stored.goalPlanCorrectionRevision, 1);
    await teams.close();

    teams = fixture.openTeam({ events });
    const afterRestart = internals(teams).record(fixture.run.id);
    assert.equal(afterRestart.goalPlanCorrectionRevision, 1, "the retry allowance survives host restart");
    const correction = afterRestart.run.members.at(-1)!;
    assert.deepEqual(correction.goalCriteriaPlan, { objectiveVersion: 7 }, "the host pin survives restart");
    correction.report = teamReportSchema.parse(goalPlan({ objectiveVersion: 7, criteria: ["c99"] }));
    let caught: unknown;
    try { internals(teams).consume(afterRestart, correction); }
    catch (error) { caught = error; }
    assert.ok(caught instanceof TeamError && caught.code === "goal-task-criteria-invalid", "the second invalid report is refused");
    internals(teams).block(afterRestart, caught, correction);
    await teams.idle();

    const view = teams.get(fixture.run.id);
    assert.equal(view.status, "blocked");
    assert.equal(view.blockCode, "goal-task-criteria-invalid");
    assert.deepEqual(view.tasks, [], "no invalid plan becomes executable work");
    assert.equal(view.members.some(row => row.role === "implementer"), false, "no writer starts after repeated invalid links");
    assert.equal(eventsOf(store, fixture.run.id, "task.planned").length, 0);
    assert.equal(eventsOf(store, fixture.run.id, "run.blocked").at(-1)?.data.code, "goal-task-criteria-invalid");
  } finally { await teams?.close(); store.close(); fixture.close(); }
});

test("a pre-upgrade in-flight PM without a marker can still submit its old plan shape", async () => {
  const fixture = schedulerFixture();
  try {
    prepareGoalPlanFixture(fixture);
    const teams = fixture.openTeam();
    const stored = internals(teams).record(fixture.run.id), oldPlanner = stored.run.members[0]!;
    assert.equal(oldPlanner.goalCriteriaPlan, undefined);
    oldPlanner.report = teamReportSchema.parse(goalPlan());
    internals(teams).consume(stored, oldPlanner);
    await waitFor(() => stored.pending === undefined && stored.run.tasks.length === 1, "the old report is accepted");
    await teams.idle();
    assert.equal(teams.get(fixture.run.id).tasks[0]!.criterionRefs, undefined, "no unbound attribution is stored");
  } finally { fixture.close(); }
});
