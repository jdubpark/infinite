import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventOutbox } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { RunEvent } from "../packages/host/src/evidence/types.js";
import { runRecord } from "../packages/host/src/objective-record.js";
import { RUN_OBJECTIVE_EVENTS } from "../packages/host/src/objective-runs.js";
import { type TeamBrief, type TeamGoalContext, type TeamRun, teamGoalContextSchema } from "../packages/host/src/team-types.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;

function openStore(f: Fixture, key: Buffer): EvidenceStore {
  return new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: key });
}

/** Every stored event of one run, read page by page. */
function allEvents(store: EvidenceStore, runId: string): RunEvent[] {
  const events: RunEvent[] = [];
  let after = 0;
  for (;;) {
    const page = store.events({ runId, after, limit: 500 });
    events.push(...page.events);
    if (!page.more) return events;
    after = page.cursor;
  }
}

function eventsOfKind(store: EvidenceStore, runId: string, kind: string): RunEvent[] {
  return allEvents(store, runId).filter(event => event.kind === kind);
}

/** Scheduler internals that the tests drive directly. */
type Internal = {
  record(id: string): unknown;
  consume(stored: unknown, member: unknown): void;
};
const internal = (teams: TeamService) => teams as unknown as Internal;

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

/** The project manager's record, read from the sealed store, with its report set for `consume`. */
function reportFrom(teams: TeamService, runId: string, report: unknown) {
  const stored = internal(teams).record(runId) as { run: TeamRun; members?: never };
  const member = stored.run.members[0]!;
  member.report = report as TeamRun["members"][number]["report"];
  return { stored, member };
}

function planReport(extra: object = {}) {
  return { kind: "plan", summary: "One task", parallelism: 4, tasks: [
    { id: "a", title: "Session fix", instructions: "Repair the session", paths: ["src/a.ts"], dependsOn: [] },
  ], ...extra };
}

function goalContext(): TeamGoalContext {
  return teamGoalContextSchema.parse({ id: randomUUID(), revision: 1, cycle: 1, successCriteria: "The session survives a restart.",
    nonGoals: [], allowedPaths: ["src"], evidence: [], previousWork: [], deadlineAt: new Date(Date.now() + 3600_000).toISOString(), maxMembers: 4 });
}

const goalBrief: TeamBrief = { title: "Session restart", problem: "Sessions drop on restart.", evidence: [{ source: "Repository", observation: "The restart path clears state." }],
  dataShape: "A session record.", acceptance: ["The session survives a restart."], expectedOutcome: "Sessions persist.", uiChanges: false };

test("a run's record starts at its first accepted plan", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.run.revision = 2;
    f.run.members[0]!.revision = 2;
    f.run.steering = [{ text: "Keep the API stable", revision: 2, at: new Date().toISOString() }];
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    assert.throws(() => teams.objectiveRecord(f.run.id), (error: unknown) =>
      error instanceof TeamError && error.status === 404 && error.code === "objective-record-absent");

    const { stored, member } = reportFrom(teams, f.run.id, planReport());
    internal(teams).consume(stored, member);
    await waitFor(() => (stored as { pending?: unknown }).pending === undefined && stored.run.status !== "planning", "the plan's operation completes");
    await teams.idle();

    const planned = teams.objectiveRecord(f.run.id);
    assert.equal(planned.version, 2);
    assert.equal(planned.record.criteria[0]?.statementOf, "objective");
    assert.deepEqual(planned.record.statement.directions.map(item => item.id), ["s2"]);
    assert.deepEqual(planned.log.map(entry => entry.op), ["record.created", "direction.copied"]);
    assert.equal(planned.log[0]?.handle, member.memberId, "the first entry names the project manager's member");

    const steerId = randomUUID();
    await teams.steer(f.run.id, { requestId: steerId, revision: 2, text: "Add a changelog" });
    await teams.idle();
    const steered = teams.objectiveRecord(f.run.id);
    assert.equal(steered.version, 3);
    assert.deepEqual(steered.record.statement.directions.map(item => item.id), ["s2", "s3"]);
    const last = steered.log[steered.log.length - 1];
    assert.equal(last?.op, "direction.appended");
    assert.equal(last?.actor, "owner");
    assert.equal(last?.handle, steerId);

    const sealed = f.readRecord<{ objectiveRecord?: unknown }>("team", f.run.id).objectiveRecord;
    assert.deepEqual(sealed, { ...steered.record, log: steered.log }, "the sealed run record holds the same record");
  } finally { store.close(); f.close(); }
});

test("a continuation appends a direction", async () => {
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      const built = runRecord(f.run, new Date().toISOString(), f.run.members[0]!.memberId);
      assert.notEqual(built, "source-invalid");
      f.run.members[0]!.status = "stopped";
      f.run.status = "blocked"; f.run.blockCode = "agent-blocked"; f.run.reason = "The implementer reported a blocker.";
      f.run.headCommit = f.run.baseCommit;
      f.writeTeam({ objectiveRecord: built });
      const teams = f.openTeam({ events: new EventOutbox(store) });
      const continueId = randomUUID();
      await teams.continueRun(f.run.id, { requestId: continueId, revision: 1, text: "Ship the changelog too" });
      await teams.idle();
      const view = teams.objectiveRecord(f.run.id);
      const last = view.record.statement.directions[view.record.statement.directions.length - 1];
      assert.equal(last?.text, "Ship the changelog too");
      assert.equal(view.log[view.log.length - 1]?.op, "direction.appended");
      assert.equal(view.log[view.log.length - 1]?.handle, continueId);
    } finally { store.close(); f.close(); }
  }
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      const built = runRecord(f.run, new Date().toISOString(), f.run.members[0]!.memberId);
      assert.notEqual(built, "source-invalid");
      f.run.members[0]!.status = "stopped";
      f.run.status = "blocked"; f.run.blockCode = "agent-blocked"; f.run.reason = "The implementer reported a blocker.";
      f.run.headCommit = f.run.baseCommit;
      f.writeTeam({ objectiveRecord: built });
      const teams = f.openTeam({ events: new EventOutbox(store) });
      const before = teams.objectiveRecord(f.run.id);
      await teams.continueRun(f.run.id, { requestId: randomUUID(), revision: 1 });
      await teams.idle();
      assert.deepEqual(teams.objectiveRecord(f.run.id), before, "a continuation without text leaves the record deep-equal");
    } finally { store.close(); f.close(); }
  }
});

test("a refused plan makes no record", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.run.parallelismCeiling = 2;
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const { stored, member } = reportFrom(teams, f.run.id, planReport({ parallelism: 3 }));
    assert.throws(() => internal(teams).consume(stored, member), (error: unknown) =>
      error instanceof TeamError && error.code === "team-parallelism-limit");
    assert.equal((stored as { objectiveRecord?: unknown }).objectiveRecord, undefined);
    assert.equal(f.readRecord<{ objectiveRecord?: unknown }>("team", f.run.id).objectiveRecord, undefined);
  } finally { store.close(); f.close(); }
});

test("a goal cycle run has no record of its own", async () => {
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      f.run.goal = goalContext();
      f.writeTeam();
      const teams = f.openTeam({ events: new EventOutbox(store) });
      const { stored, member } = reportFrom(teams, f.run.id, planReport({ brief: goalBrief }));
      internal(teams).consume(stored, member);
      await waitFor(() => (stored as { pending?: unknown }).pending === undefined && stored.run.status !== "planning", "the goal plan's operation completes");
      await teams.idle();
      assert.equal(stored.run.status, "implementing", "the goal plan is accepted");
      assert.equal((stored as { objectiveRecord?: unknown }).objectiveRecord, undefined);
      assert.throws(() => teams.objectiveRecord(f.run.id), (error: unknown) =>
        error instanceof TeamError && error.status === 409 && error.code === "objective-record-of-goal");
    } finally { store.close(); f.close(); }
  }
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      f.run.missionId = randomUUID();
      f.writeTeam();
      const teams = f.openTeam({ events: new EventOutbox(store) });
      const { stored, member } = reportFrom(teams, f.run.id, planReport());
      internal(teams).consume(stored, member);
      await waitFor(() => (stored as { pending?: unknown }).pending === undefined && stored.run.status !== "planning", "the subteam plan's operation completes");
      await teams.idle();
      assert.equal(stored.run.status, "implementing", "the subteam plan is accepted");
      await teams.steer(f.run.id, { requestId: randomUUID(), revision: f.run.revision, text: "Keep the subteam narrow" });
      await teams.idle();
      assert.equal(f.readRecord<{ objectiveRecord?: unknown }>("team", f.run.id).objectiveRecord, undefined);
      assert.throws(() => teams.objectiveRecord(f.run.id), (error: unknown) =>
        error instanceof TeamError && error.status === 409 && error.code === "objective-record-of-mission");
    } finally { store.close(); f.close(); }
  }
});

test("an unreadable or unbuildable record never blocks a plan or a steer", async () => {
  const recordInvalid = RUN_OBJECTIVE_EVENTS["record-invalid"];
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      const junk = { schemaVersion: 1, junk: true };
      f.writeTeam({ objectiveRecord: junk });
      const teams = f.openTeam({ events: new EventOutbox(store) });
      const { stored, member } = reportFrom(teams, f.run.id, planReport());
      internal(teams).consume(stored, member);
      await waitFor(() => (stored as { pending?: unknown }).pending === undefined && stored.run.status !== "planning", "the plan's operation completes");
      await teams.idle();
      assert.equal(stored.run.status, "implementing");
      assert.equal(stored.run.tasks.length, 1);
      assert.deepEqual((stored as { objectiveRecord?: unknown }).objectiveRecord, junk, "the stored value is kept unchanged");
      assert.equal(stored.run.events.filter(event => event.text === recordInvalid).length, 1);

      await teams.steer(f.run.id, { requestId: randomUUID(), revision: f.run.revision, text: "Keep it small" });
      await teams.idle();
      assert.deepEqual(f.readRecord<{ objectiveRecord?: unknown }>("team", f.run.id).objectiveRecord, junk);
      assert.equal(stored.run.events.filter(event => event.text === recordInvalid).length, 1, "the steer adds no event");
    } finally { store.close(); f.close(); }
  }
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      f.run.objective = "x".repeat(24_001);
      f.writeTeam();
      const teams = f.openTeam({ events: new EventOutbox(store) });
      const { stored, member } = reportFrom(teams, f.run.id, planReport());
      internal(teams).consume(stored, member);
      await waitFor(() => (stored as { pending?: unknown }).pending === undefined && stored.run.status !== "planning", "the plan's operation completes");
      await teams.idle();
      assert.equal(stored.run.status, "implementing");
      assert.equal((stored as { objectiveRecord?: unknown }).objectiveRecord, undefined);
      assert.equal((stored as { objectiveNotice?: unknown }).objectiveNotice, "source-invalid");
      assert.equal(stored.run.events.filter(event => event.text === RUN_OBJECTIVE_EVENTS["source-invalid"]).length, 1);
    } finally { store.close(); f.close(); }
  }
});

test("a removed run takes its record with it", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.run.status = "cancelled";
    f.run.members[0]!.status = "stopped";
    f.writeTeam({ objectiveRecord: runRecord(f.run, new Date().toISOString(), f.run.members[0]!.memberId) });
    const teams = f.openTeam({ events: new EventOutbox(store) });
    await teams.removeRun(f.run.id);
    assert.throws(() => teams.objectiveRecord(f.run.id), (error: unknown) =>
      error instanceof TeamError && error.status === 404 && error.code === "team-not-found");
    assert.equal(existsSync(join(f.config.stateDir, "teams", `${f.run.id}.sealed`)), false);
  } finally { store.close(); f.close(); }
});

test("the run view carries no record", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.run.revision = 2;
    f.run.members[0]!.revision = 2;
    f.run.steering = [{ text: "Keep the API stable", revision: 2, at: new Date().toISOString() }];
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const { stored, member } = reportFrom(teams, f.run.id, planReport());
    internal(teams).consume(stored, member);
    await waitFor(() => (stored as { pending?: unknown }).pending === undefined && stored.run.status !== "planning", "the plan's operation completes");
    await teams.idle();

    const view = teams.get(f.run.id) as unknown as Record<string, unknown>;
    assert.equal("objectiveRecord" in view, false);
    assert.equal("objectiveNotice" in view, false);
    assert.equal(JSON.stringify(view).includes("record.created"), false);
  } finally { store.close(); f.close(); }
});
