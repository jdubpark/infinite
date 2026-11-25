import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { teamGoalContextSchema, teamReportSchema, type RecordDigest, type TeamMember, type TeamRun, type TeamTaskPlan } from "../../packages/host/src/team-types.js";
import { validateGoalTaskCriterionRefs } from "../../packages/host/src/team-goal-criteria.js";
import { TeamError } from "../../packages/host/src/team-workspace.js";
import type { TeamService } from "../../packages/host/src/teams.js";
import { bump, type Counts, rand } from "../outcome-sim-script.js";
import { schedulerFixture } from "./team-scheduler.js";

/*
 * A seeded crash/reopen simulator for goal planning. Each seed creates a real TeamService and a host-pinned
 * goal record, prepares a project manager, sends an invalid report, then either corrects it or repeats the bad report.
 * The correction state and accepted task links are read from the sealed team record after service reopen.
 *
 * Faults are generated from the seed: the host is restarted after a prepared pin, a saved correction, or an accepted
 * plan. The record is always reopened by TeamService, not reconstructed by the model. team-run-sim separately cuts
 * owner requests between individual writes and checks their receipts; this simulator checks the goal plan state.
 *
 * Invariants checked after each state transition:
 * I1 A newly prepared goal planner and every restored plan prompt keep the exact objective-version pin.
 * I2 The first malformed report spends one correction for the revision, and restart cannot restore that allowance.
 * I3 Accepted plan links persist as task metadata and never compose a criterion assessment.
 */

export type GoalPlanFixture = ReturnType<typeof schedulerFixture>;
type SimStored = { run: TeamRun; pending?: unknown; goalPlanCorrectionRevision?: number };
type Internals = {
  record(id: string): SimStored;
  prepareMember(stored: SimStored, role: "project-manager"): void;
  consume(stored: SimStored, member: TeamMember): void;
  block(stored: SimStored, error: unknown, member?: TeamMember): void;
  save(stored: SimStored): void;
};
const internals = (service: TeamService) => service as unknown as Internals;

const GOAL_RECORD: RecordDigest = { version: 7, criteria: [
  { id: "c0", statement: "", check: "judgement:owner-text", producer: "evaluator" },
  { id: "c2", statement: "The output validates.", check: "artifact:src/output.json", producer: "host" },
  { id: "c3", statement: "The output cites sources.", check: "citation-form:src/output.json", producer: "host" },
] };
const BRIEF = {
  title: "Produce the requested output", problem: "The current repository lacks the output.",
  evidence: [{ source: "Repository inspection", observation: "The output file is absent." }],
  dataShape: "One output file.", acceptance: ["The output validates."], expectedOutcome: "A valid output is available.", uiChanges: false,
};

/** Shared goal setup for example and simulator tests. Writes the starting record through the scheduler fixture. */
export function prepareGoalPlanFixture(fixture: GoalPlanFixture): void {
  fixture.run.headCommit = fixture.run.baseCommit;
  fixture.run.goal = teamGoalContextSchema.parse({
    id: randomUUID(), revision: 1, cycle: 1, successCriteria: "The owner's output is useful.", nonGoals: [], allowedPaths: ["."], evidence: [],
    previousWork: [], deadlineAt: "2100-01-01T00:00:00.000Z", maxMembers: 10, record: GOAL_RECORD,
  });
  fixture.config.projects[0]!.team = { checks: [{ command: "npm", args: ["test"] }] };
  fixture.writeTeam();
}

/** A plan shape shared by focused tests and generated simulator reports. */
export function goalPlan(criterionRefs?: TeamTaskPlan["criterionRefs"]) {
  return {
    kind: "plan" as const, summary: "Create and check the output.", brief: BRIEF,
    tasks: [{ id: "output", title: "Write the output", instructions: "Create the output for the goal.", paths: ["src/output.ts"], dependsOn: [],
      ...(criterionRefs ? { criterionRefs } : {}) }],
  };
}

type InvalidKind = "missing" | "invented" | "wrong-version";
type FollowUp = "valid" | "invalid";
type Script = { first: InvalidKind; second: InvalidKind; followUp: FollowUp; restartAfterPin: boolean; restartAfterCorrection: boolean; restartAfterOutcome: boolean };
const INVALIDS: readonly InvalidKind[] = ["missing", "invented", "wrong-version"];
function scriptFor(seed: number): Script {
  const r = rand(seed * 7919);
  // Alternating the second report ensures the default bounded corpus exercises both acceptance and blocking.
  return { first: r.pick(INVALIDS), second: r.pick(INVALIDS), followUp: seed % 2 === 1 ? "valid" : "invalid",
    restartAfterPin: r.chance(0.5), restartAfterCorrection: r.chance(0.85), restartAfterOutcome: r.chance(0.5) };
}
function describeScript(seed: number): string {
  const s = scriptFor(seed), restart = [s.restartAfterPin && "pin", s.restartAfterCorrection && "correction", s.restartAfterOutcome && "outcome"].filter(Boolean);
  return `${seed}:${s.first}->${s.followUp === "valid" ? "valid-subset" : s.second}->${restart.length ? `restart-${restart.join("+")}` : "no-restart"}`;
}

type Mutation = "drop-pin-on-save" | "drop-correction-on-save" | "attribute-assessment-on-save";
type Variant = { mutation?: Mutation };
export class GoalPlanViolation extends Error {}
const RERUN = (seed: number) => `TEAM_SIM_SEED=${seed} GOAL_PLAN_SIM_SEED=${seed} node --import tsx --test tests/team-run-sim.test.ts`;

async function waitFor(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (check()) return; await delay(10); }
  assert.fail(message);
}

type GoalPlanModel = { pinned: boolean; corrections: number; accepted?: TeamTaskPlan["criterionRefs"]; outcome?: "blocked" };

class Simulator {
  private teams: TeamService;
  private stored: SimStored;
  private scheduler: Internals;
  private stepName = "setup";
  private model: GoalPlanModel = { pinned: false, corrections: 0 };

  constructor(private readonly seed: number, private readonly fixture: GoalPlanFixture, private readonly counts: Counts, private readonly variant: Variant) {
    this.teams = fixture.openTeam();
    this.scheduler = internals(this.teams);
    this.stored = this.scheduler.record(fixture.run.id);
    this.patch(this.teams);
  }

  private fail(invariant: string, message: string): never {
    throw new GoalPlanViolation(`seed=${this.seed} step=${this.stepName} invariant=${invariant}: ${message}; rerun: ${RERUN(this.seed)}`);
  }

  private require(invariant: string, condition: unknown, message: string): asserts condition {
    if (!condition) this.fail(invariant, message);
  }

  private patch(teams: TeamService) {
    if (!this.variant.mutation) return;
    const host = internals(teams), save = host.save.bind(teams);
    host.save = stored => {
      if (this.variant.mutation === "drop-pin-on-save") {
        for (const member of stored.run.members) if (member.role === "project-manager" && member.memberId !== this.fixture.run.members[0]?.memberId)
          delete member.goalCriteriaPlan;
      } else if (this.variant.mutation === "drop-correction-on-save") {
        delete stored.goalPlanCorrectionRevision;
      } else if (this.variant.mutation === "attribute-assessment-on-save" && stored.run.tasks.length && !stored.run.assessment) {
        stored.run.assessment = {
          verdictId: randomUUID(), revision: stored.run.revision, head: stored.run.headCommit!, kind: "reviewed", result: "met",
          counts: { met: GOAL_RECORD.criteria.length, notMet: 0, inconclusive: 0, pendingOwner: 0 },
          criteria: GOAL_RECORD.criteria.map(criterion => ({ id: criterion.id, state: "met" })), at: "2026-11-24T00:00:00.000Z",
        };
      }
      save(stored);
    };
  }

  private async reopen() {
    await this.teams.close();
    this.teams = this.fixture.openTeam();
    this.scheduler = internals(this.teams);
    this.stored = this.scheduler.record(this.fixture.run.id);
    this.patch(this.teams);
    await this.teams.idle();
    this.check("after host restart");
    bump(this.counts, "restart");
  }

  private check(where: string) {
    this.stepName = where;
    let saved: SimStored;
    try { saved = this.fixture.readRecord<SimStored>("team", this.fixture.run.id); }
    catch (error) { this.fail("I1", `the sealed goal plan record did not load (${error instanceof Error ? error.message : String(error)})`); }
    const goal = saved.run.goal?.record;
    this.require("I1", goal !== undefined, "the goal lost its host-pinned record");
    const pinned = saved.run.members.filter(member => member.goalCriteriaPlan);
    const goalPlanners = saved.run.members.filter(member => member.role === "project-manager" && member.memberId !== this.fixture.run.members[0]?.memberId);
    if (this.model.pinned) this.require("I1", goalPlanners.length > 0, "the newly prepared PM disappeared from durable state");
    for (const member of goalPlanners)
      this.require("I1", member.goalCriteriaPlan !== undefined, `new PM ${member.memberId} lost its host-owned pin`);
    for (const member of pinned) {
      this.require("I1", member.role === "project-manager", `a ${member.role} member carries a PM-only marker`);
      this.require("I1", member.goalCriteriaPlan!.objectiveVersion === goal.version,
        `member ${member.memberId} carries version ${member.goalCriteriaPlan!.objectiveVersion}, expected ${goal.version}`);
      this.require("I1", member.prompt.includes(`"objectiveVersion":${goal.version}`) && member.prompt.includes("every task, including each prerequisite"),
        `member ${member.memberId}'s saved prompt no longer carries the objective pin`);
    }
    this.require("I2", saved.goalPlanCorrectionRevision === (this.model.corrections ? saved.run.revision : undefined),
      `correction marker is ${saved.goalPlanCorrectionRevision ?? "absent"}, expected ${this.model.corrections ? saved.run.revision : "absent"}`);
    const expectedPlanners = this.model.pinned ? 1 + this.model.corrections : 0;
    this.require("I2", goalPlanners.length === expectedPlanners,
      `the run has ${goalPlanners.length} newly prepared planners, expected ${expectedPlanners}`);
    if (this.model.accepted) {
      this.require("I3", saved.run.tasks.length === 1, `the accepted plan has ${saved.run.tasks.length} stored tasks`);
      this.require("I3", isDeepStrictEqual(saved.run.tasks[0]!.criterionRefs, this.model.accepted), "stored task metadata differs from the accepted report");
      this.require("I3", saved.run.assessment === undefined, "plan attribution created an objective assessment");
      const view = this.teams.get(this.fixture.run.id);
      this.require("I3", isDeepStrictEqual(view.tasks[0]!.criterionRefs, this.model.accepted), "public task projection omitted accepted metadata");
      this.require("I3", view.assessment === undefined, "public task attribution appears as criterion satisfaction");
    } else {
      this.require("I3", saved.run.tasks.length === 0, "an unaccepted plan created task work");
      this.require("I3", saved.run.assessment === undefined, "a plan claim created an assessment before acceptance");
    }
    if (this.model.outcome === "blocked") {
      this.require("I2", saved.run.status === "blocked" && saved.run.blockCode === "goal-task-criteria-invalid",
        `repeated bad refs did not block (${saved.run.status}/${saved.run.blockCode ?? "no code"})`);
      this.require("I2", saved.run.tasks.length === 0, "a repeated bad report created tasks");
    }
  }

  private async settle(expectedMembers: number, expectTask = false) {
    await waitFor(() => this.stored.pending === undefined && this.stored.run.members.length >= expectedMembers && (!expectTask || this.stored.run.tasks.length === 1),
      "a plan operation did not settle");
    await this.teams.idle();
  }

  private async preparePlanner() {
    const existing = this.stored.run.members.length;
    this.scheduler.prepareMember(this.stored, "project-manager");
    await this.settle(existing + 1);
    const member = this.stored.run.members.at(-1)!;
    this.require("I1", member.goalCriteriaPlan?.objectiveVersion === GOAL_RECORD.version,
      "the host did not stamp its newly prepared PM with the pinned objective version");
    this.model.pinned = true;
    this.check("PM prepared and saved");
    return member;
  }

  private report(kind: InvalidKind | "valid"): ReturnType<typeof teamReportSchema.parse> {
    if (kind === "valid") return teamReportSchema.parse(goalPlan({ objectiveVersion: GOAL_RECORD.version, criteria: ["c2"] }));
    if (kind === "missing") return teamReportSchema.parse(goalPlan());
    if (kind === "invented") return teamReportSchema.parse(goalPlan({ objectiveVersion: GOAL_RECORD.version, criteria: ["c99"] }));
    return teamReportSchema.parse(goalPlan({ objectiveVersion: GOAL_RECORD.version - 1, criteria: ["c2"] }));
  }

  private process(member: TeamMember, report: ReturnType<typeof teamReportSchema.parse>) {
    member.report = report;
    this.scheduler.consume(this.stored, member);
  }

  async run(script: Script) {
    this.check("starting record opened by TeamService");
    let pm = await this.preparePlanner();
    if (script.restartAfterPin) { await this.reopen(); pm = this.stored.run.members.at(-1)!; }
    this.stepName = "first invalid report";
    this.process(pm, this.report(script.first));
    await this.settle(this.stored.run.members.length + 1);
    this.model.corrections = 1;
    this.check("one correction saved");
    bump(this.counts, "correction:first");

    if (script.restartAfterCorrection) await this.reopen();
    const corrected = this.stored.run.members.at(-1)!;
    this.require("I1", corrected.goalCriteriaPlan?.objectiveVersion === GOAL_RECORD.version,
      "the corrected PM did not retain the original host pin");
    this.check("corrected PM restored");

    if (script.followUp === "valid") {
      const acceptedRefs = { objectiveVersion: GOAL_RECORD.version, criteria: ["c2"] };
      this.process(corrected, this.report("valid"));
      await this.settle(this.stored.run.members.length, true);
      this.model.accepted = acceptedRefs;
      this.check("valid subset plan accepted");
      bump(this.counts, "plan:accepted-subset");
      if (script.restartAfterOutcome) await this.reopen();
    } else {
      let error: unknown;
      try { this.process(corrected, this.report(script.second)); }
      catch (caught) { error = caught; }
      this.require("I2", error instanceof TeamError && error.code === "goal-task-criteria-invalid",
        "the repeated bad report was not rejected by the host's real criterion validator");
      this.scheduler.block(this.stored, error, corrected);
      this.model.outcome = "blocked";
      this.check("repeated invalid plan blocked");
      bump(this.counts, "plan:blocked-repeat");
      if (script.restartAfterOutcome) await this.reopen();
    }
  }
}

async function simulateGoalPlan(seed: number, counts: Counts, variant: Variant = {}) {
  const fixture = schedulerFixture();
  try {
    prepareGoalPlanFixture(fixture);
    const sim = new Simulator(seed, fixture, counts, variant);
    await sim.run(scriptFor(seed));
  } catch (error) {
    if (error instanceof GoalPlanViolation) throw error;
    throw new GoalPlanViolation(`seed=${seed} step=host invariant=I1: ${error instanceof Error ? error.message : String(error)}; rerun: ${RERUN(seed)}`);
  } finally {
    fixture.close();
  }
}

/** Registers the goal-plan cases alongside the broader seeded team-run simulator. */
export function registerGoalPlanSimulator(register: typeof test): void {
  const only = process.env.GOAL_PLAN_SIM_SEED ?? process.env.TEAM_SIM_SEED;
  const count = Number(process.env.GOAL_PLAN_SIM_SEEDS ?? 12);
  const base = Number(process.env.GOAL_PLAN_SIM_BASE ?? 1);
  const seeds = only === undefined ? Array.from({ length: count }, (_, index) => base + index) : [Number(only)];
  const defaultCorpus = only === undefined && count === 12 && base === 1;
  assert.ok(seeds.length > 0 && seeds.every(Number.isSafeInteger), "GOAL_PLAN_SIM_* settings take integers");
  register("seeded goal plans preserve pinned coverage across corrections and restarts", { timeout: 120000 }, async context => {
    const counts: Counts = {};
    for (const seed of seeds) await simulateGoalPlan(seed, counts);
    context.diagnostic(`goal plan scripts ${seeds.map(describeScript).join(" ")} (GOAL_PLAN_SIM_SEED or TEAM_SIM_SEED replays one); ${JSON.stringify(counts)}`);
    if (defaultCorpus) {
      assert.ok((counts["plan:accepted-subset"] ?? 0) > 0, "the corpus must accept a valid subset plan");
      assert.ok((counts["plan:blocked-repeat"] ?? 0) > 0, "the corpus must block a repeated bad plan");
      assert.ok((counts.restart ?? 0) > 0, "the corpus must reopen saved goal-plan state");
    } else context.diagnostic("coverage floors are off: they describe the default corpus, and a GOAL_PLAN_SIM_* setting changed it");
  });

  const mutants: readonly [Mutation, string, number][] = [
    ["drop-pin-on-save", "I1", 1],
    ["drop-correction-on-save", "I2", 2],
    ["attribute-assessment-on-save", "I3", 1],
  ];
  for (const [mutation, invariant, seed] of mutants) register(`goal-plan simulator catches ${mutation} through ${invariant}`, { skip: only !== undefined }, async () => {
    await assert.rejects(simulateGoalPlan(seed, {}, { mutation }), new RegExp(`seed=${seed} step=.* invariant=${invariant}:`));
  });
}
