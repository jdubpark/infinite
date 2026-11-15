import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { GoalService } from "../packages/host/src/goals.js";
import { GOAL_OBJECTIVE_EVENTS } from "../packages/host/src/objective-goals.js";
import { goalRecord } from "../packages/host/src/objective-record.js";
import { objectiveRecordSchema } from "../packages/host/src/objective-types.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";
import { TeamError } from "../packages/host/src/teams.js";

type StoredShape = { goal: ProductGoal; fingerprint: string; receipts: Record<string, string>; objectiveRecord?: unknown; objectiveNotice?: string; launch?: unknown; control?: unknown };

const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

/** The scheduler fixture with a strong lineup and a configured project, so goals can be created. */
function fixture() {
  const f = schedulerFixture();
  f.config.teams = { ...f.config.teams!, lineup };
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] } as Config["projects"][number]["team"];
  return f;
}

const createInput = (overrides: Partial<CreateGoal> = {}): CreateGoal => ({
  requestId: randomUUID(), projectId: "fixture", title: "Rank sources", objective: "Find ranked sources",
  successCriteria: "A ranked shortlist with reasons and sources", nonGoals: ["no paid sources"], allowedPaths: ["research"],
  evidence: ["notes.md"], maxRuns: 2, maxMinutes: 60, maxMembers: 4, parallelism: 2, ...overrides,
});

/** A goal as an earlier host wrote it: no objective record, a fixed update time, and a fixed revision. */
function legacyGoal(overrides: Record<string, unknown> = {}): ProductGoal {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    id: randomUUID(), projectId: "fixture", title: "Rank sources", objective: "Find ranked sources",
    successCriteria: "A ranked shortlist with reasons and sources", nonGoals: ["no paid sources"], allowedPaths: ["research"],
    evidence: ["notes.md"], maxRuns: 2, maxMinutes: 60, maxTotalMinutes: 60, maxMembers: 4, parallelism: 2,
    revision: 1, status: "running", createdAt: at, updatedAt: at, deadlineAt: new Date(Date.now() + 3600000).toISOString(),
    ceilingAt: new Date(Date.now() + 3600000).toISOString(), lineup, memberCount: 0, cycles: [], steering: [], events: [], outcomes: [],
    ...overrides,
  } as unknown as ProductGoal;
}

const goalFile = (f: ReturnType<typeof fixture>, id: string) => join(f.config.stateDir, "goals", `${id}.sealed`);
const eventTexts = (goal: ProductGoal) => goal.events.map(event => event.text);

test("a new goal gets record version 1 with c0 only", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const created = await goals.create(createInput());
    const stored = f.readRecord<StoredShape>("goal", created.id);
    const record = objectiveRecordSchema.parse(stored.objectiveRecord);
    assert.equal(record.version, 1);
    assert.deepEqual(record.criteria.map(item => [item.id, item.statement]), [["c0", "A ranked shortlist with reasons and sources"]]);
    assert.deepEqual(record.nonGoals, [{ id: "n1", text: "no paid sources" }]);
    assert.deepEqual(record.log.map(entry => [entry.op, entry.actor, entry.handle]), [["record.created", "owner", created.id]]);
    assert.equal("objectiveRecord" in goals.get(created.id), false);
    assert.equal("objectiveNotice" in goals.get(created.id), false);
    assert.equal(goals.objectiveRecord(created.id).version, 1);
  } finally { f.close(); }
});

test("steering appends a direction and changes nothing else", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const created = await goals.create(createInput());
    const before = objectiveRecordSchema.parse(f.readRecord<StoredShape>("goal", created.id).objectiveRecord);
    const firstRequest = randomUUID(), secondRequest = randomUUID();
    const first = await goals.steer(created.id, { requestId: firstRequest, revision: created.revision, text: "Prefer seed stage" });
    const secondBody = { requestId: secondRequest, revision: first.revision, text: "Exclude current holdings" };
    await goals.steer(created.id, secondBody);
    const after = objectiveRecordSchema.parse(f.readRecord<StoredShape>("goal", created.id).objectiveRecord);
    assert.equal(after.version, 3);
    assert.deepEqual(after.statement.directions.map(item => item.id), ["s2", "s3"]);
    assert.deepEqual(after.log.slice(-2).map(entry => [entry.op, entry.actor, entry.authority, entry.handle]), [
      ["direction.appended", "owner", "direction", firstRequest],
      ["direction.appended", "owner", "direction", secondRequest],
    ]);
    assert.deepEqual(after.criteria, before.criteria);
    assert.deepEqual(after.nonGoals, before.nonGoals);
    assert.deepEqual(after.constraints, before.constraints);

    await goals.steer(created.id, secondBody);
    assert.deepEqual(objectiveRecordSchema.parse(f.readRecord<StoredShape>("goal", created.id).objectiveRecord), after);

    const text = readFileSync(goalFile(f, created.id), "utf8");
    new GoalService(f.config, f.key, teams);
    assert.equal(readFileSync(goalFile(f, created.id), "utf8"), text);
  } finally { f.close(); }
});

test("a legacy goal migrates once at load and keeps its fields", () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const id = randomUUID();
    const goal = legacyGoal({ id, revision: 3, steering: [
      { text: "Prefer seed stage", revision: 2, at: "2026-01-02T00:00:00.000Z" },
      { text: "Exclude current holdings", revision: 3, at: "2026-01-03T00:00:00.000Z" },
    ] });
    const launch = { request: { requestId: randomUUID(), projectId: "fixture", title: "Round", objective: "Find ranked sources" }, context: { id, revision: 3, cycle: 1 } };
    const control = { action: "steer", requestId: randomUUID(), teamId: randomUUID(), revision: 3, text: "Exclude current holdings" };
    f.writeRecord("goal", id, { goal, receipts: { previous: "digest" }, fingerprint: "fixture", launch, control });
    new GoalService(f.config, f.key, teams);
    const migrated = f.readRecord<StoredShape>("goal", id);
    const record = objectiveRecordSchema.parse(migrated.objectiveRecord);
    assert.equal(record.version, 3);
    assert.deepEqual(record.log.map(entry => [entry.op, entry.actor]), [
      ["record.migrated", "host"], ["direction.copied", "host"], ["direction.copied", "host"],
    ]);
    assert.deepEqual(migrated.goal, goal);
    assert.equal(migrated.fingerprint, "fixture");
    assert.deepEqual(migrated.receipts, { previous: "digest" });
    assert.deepEqual(migrated.launch, launch);
    assert.deepEqual(migrated.control, control);

    const text = readFileSync(goalFile(f, id), "utf8");
    new GoalService(f.config, f.key, teams);
    assert.equal(readFileSync(goalFile(f, id), "utf8"), text);
  } finally { f.close(); }
});

test("a direction steered by an older host is copied once", () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const id = randomUUID();
    const steered = [{ text: "Prefer seed stage", revision: 2, at: "2026-01-02T00:00:00.000Z" }];
    const goal = legacyGoal({ id, revision: 2, steering: steered });
    const built = goalRecord(goal, "2026-01-02T00:00:00.000Z", "created");
    assert.notEqual(built, "source-invalid");
    f.writeRecord("goal", id, { goal: { ...goal, steering: [...steered, { text: "Exclude holdings", revision: 3, at: "2026-01-03T00:00:00.000Z" }] }, receipts: {}, fingerprint: "fixture", objectiveRecord: built });
    new GoalService(f.config, f.key, teams);
    const record = objectiveRecordSchema.parse(f.readRecord<StoredShape>("goal", id).objectiveRecord);
    assert.equal(record.version, 3);
    assert.deepEqual(record.statement.directions.map(item => item.id), ["s2", "s3"]);
    assert.deepEqual(record.log.filter(entry => entry.op === "direction.copied").map(entry => entry.target), ["s2", "s3"]);

    const text = readFileSync(goalFile(f, id), "utf8");
    new GoalService(f.config, f.key, teams);
    assert.equal(readFileSync(goalFile(f, id), "utf8"), text);
  } finally { f.close(); }
});

test("a goal that cannot migrate keeps working and says so", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const id = randomUUID();
    f.writeRecord("goal", id, { goal: legacyGoal({ id, successCriteria: "a".repeat(16001) }), receipts: {}, fingerprint: "fixture" });
    const goals = new GoalService(f.config, f.key, teams);
    const goal = f.readRecord<StoredShape>("goal", id).goal;
    assert.equal("objectiveRecord" in f.readRecord<StoredShape>("goal", id), false);
    assert.deepEqual(eventTexts(goal).filter(text => text === GOAL_OBJECTIVE_EVENTS["source-invalid"]).length, 1);
    assert.equal(eventTexts(goal).at(-1), GOAL_OBJECTIVE_EVENTS["source-invalid"]);
    new GoalService(f.config, f.key, teams);
    assert.equal(f.readRecord<StoredShape>("goal", id).goal.events.filter(event => event.text === GOAL_OBJECTIVE_EVENTS["source-invalid"]).length, 1);
    assert.throws(() => goals.objectiveRecord(id), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "objective-source-invalid");

    const steered = await goals.steer(id, { requestId: randomUUID(), revision: 1, text: "Prefer seed stage" });
    assert.equal(steered.revision, 2);
    const events = f.readRecord<StoredShape>("goal", id).goal.events.map(event => event.text);
    assert.equal(events.filter(text => Object.values(GOAL_OBJECTIVE_EVENTS).includes(text)).length, 1);
  } finally { f.close(); }
});

test("an unreadable record is kept and never rewritten", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const invalidId = randomUUID(), newerId = randomUUID();
    const invalid = { schemaVersion: 1, junk: true }, newer = { schemaVersion: 2, future: "x" };
    f.writeRecord("goal", invalidId, { goal: legacyGoal({ id: invalidId }), receipts: {}, fingerprint: "fixture", objectiveRecord: invalid });
    f.writeRecord("goal", newerId, { goal: legacyGoal({ id: newerId }), receipts: {}, fingerprint: "fixture", objectiveRecord: newer });
    // A record that parses apart from rule 9: its second direction entry names the first direction.
    const damagedId = randomUUID();
    const built = goalRecord(legacyGoal({ id: damagedId, steering: [
      { text: "Prefer seed stage", revision: 2, at: "2026-01-02T00:00:00.000Z" },
      { text: "Exclude current holdings", revision: 3, at: "2026-01-03T00:00:00.000Z" },
    ] }), "2026-11-14T10:00:00.000Z", "created") as Exclude<ReturnType<typeof goalRecord>, string>;
    const damaged = { ...built, log: built.log.map(entry => (entry.target === "s3" ? { ...entry, target: "s2" } : entry)) };
    f.writeRecord("goal", damagedId, { goal: legacyGoal({ id: damagedId }), receipts: {}, fingerprint: "fixture", objectiveRecord: damaged });
    const goals = new GoalService(f.config, f.key, teams);
    await goals.steer(invalidId, { requestId: randomUUID(), revision: 1, text: "Prefer seed stage" });
    await goals.steer(newerId, { requestId: randomUUID(), revision: 1, text: "Prefer seed stage" });
    await goals.steer(damagedId, { requestId: randomUUID(), revision: 1, text: "Prefer seed stage" });
    new GoalService(f.config, f.key, teams);

    const storedInvalid = f.readRecord<StoredShape>("goal", invalidId), storedNewer = f.readRecord<StoredShape>("goal", newerId);
    assert.deepEqual(storedInvalid.objectiveRecord, invalid);
    assert.deepEqual(storedNewer.objectiveRecord, newer);
    assert.deepEqual(f.readRecord<StoredShape>("goal", damagedId).objectiveRecord, damaged);
    assert.throws(() => goals.objectiveRecord(damagedId), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "objective-record-invalid");
    assert.equal(storedInvalid.goal.events.filter(event => event.text === GOAL_OBJECTIVE_EVENTS["record-invalid"]).length, 1);
    assert.equal(storedNewer.goal.events.filter(event => event.text === GOAL_OBJECTIVE_EVENTS["record-newer"]).length, 1);
    assert.throws(() => goals.objectiveRecord(invalidId), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "objective-record-invalid");
    assert.throws(() => goals.objectiveRecord(newerId), (error: unknown) => error instanceof TeamError && error.status === 409 && error.code === "objective-record-newer");
  } finally { f.close(); }
});

test("a failed migration write never stops the host", { skip: process.getuid?.() === 0 }, async () => {
  const f = fixture(), teams = f.openTeam();
  const goalsDirectory = join(f.config.stateDir, "goals");
  const warnings: string[] = [];
  const warn = console.warn;
  try {
    const id = randomUUID();
    f.writeRecord("goal", id, { goal: legacyGoal({ id, activeTeamId: randomUUID() }), receipts: {}, fingerprint: "fixture" });
    chmodSync(goalsDirectory, 0o500);
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let goals: GoalService | undefined;
    assert.doesNotThrow(() => { goals = new GoalService(f.config, f.key, teams); });
    assert.equal(goals!.objectiveRecord(id).version, 1);
    assert.equal(f.readRecord<StoredShape>("goal", id).objectiveRecord, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /1 goals/);
    assert.equal(warnings[0]!.includes("Find ranked sources"), false);

    // One goal tick with the folder still read-only. The goal names a team that does not exist, so the tick has nothing to write (a new cycle would need a write and block the goal): it keeps running, gains no event, and its file is unchanged.
    const fileBefore = readFileSync(goalFile(f, id), "utf8"), eventsBefore = goals!.get(id).events.length;
    goals!.start();
    // A steer with a stale revision queues behind the tick and fails without a change, so it marks the tick's end.
    await goals!.steer(id, { requestId: randomUUID(), revision: 999, text: "Barrier" }).catch(() => undefined);
    goals!.close();
    assert.equal(goals!.get(id).status, "running");
    assert.equal(goals!.get(id).events.length, eventsBefore);
    assert.equal(readFileSync(goalFile(f, id), "utf8"), fileBefore);

    console.warn = warn;
    chmodSync(goalsDirectory, 0o700);
    await goals!.steer(id, { requestId: randomUUID(), revision: 1, text: "Prefer seed stage" });
    assert.equal(objectiveRecordSchema.parse(f.readRecord<StoredShape>("goal", id).objectiveRecord).version, 2);
  } finally {
    console.warn = warn;
    try { chmodSync(goalsDirectory, 0o700); } catch { /* the directory was removed with the fixture */ }
    f.close();
  }
});

test("only steering writes the record", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const created = await goals.create(createInput());
    const snapshot = f.readRecord<StoredShape>("goal", created.id).objectiveRecord;
    let current = await goals.pause(created.id, { requestId: randomUUID(), revision: created.revision });
    assert.deepEqual(f.readRecord<StoredShape>("goal", created.id).objectiveRecord, snapshot);
    current = await goals.resume(created.id, { requestId: randomUUID(), revision: current.revision });
    assert.deepEqual(f.readRecord<StoredShape>("goal", created.id).objectiveRecord, snapshot);
    current = await goals.cancel(created.id, { requestId: randomUUID(), revision: current.revision });
    assert.deepEqual(f.readRecord<StoredShape>("goal", created.id).objectiveRecord, snapshot);
    await goals.outcome(created.id, { requestId: randomUUID(), revision: current.revision, result: "not-achieved", summary: "Fixture outcome", evidence: "fixture" });
    assert.deepEqual(f.readRecord<StoredShape>("goal", created.id).objectiveRecord, snapshot);
  } finally { f.close(); }
});

test("lists, single reads, and an idle tick parse no record", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const first = await goals.create(createInput());
    const second = await goals.create(createInput({ title: "Second goal" }));
    let parses = 0;
    const { safeParse, parse } = objectiveRecordSchema;
    objectiveRecordSchema.safeParse = (...args: Parameters<typeof safeParse>) => { parses += 1; return safeParse.apply(objectiveRecordSchema, args); };
    objectiveRecordSchema.parse = (...args: Parameters<typeof parse>) => { parses += 1; return parse.apply(objectiveRecordSchema, args); };
    try {
      goals.list();
      goals.get(first.id);
      goals.get(second.id);
      // An idle tick: the steer with a stale revision queues behind the tick and fails without a change.
      goals.start();
      await goals.steer(first.id, { requestId: randomUUID(), revision: 999, text: "Barrier" }).catch(() => undefined);
      goals.close();
      assert.equal(parses, 0, "lists, single reads, and an idle tick parse no record");
      goals.objectiveRecord(first.id);
      assert.ok(parses > 0, "the count sees a record read");
    } finally {
      objectiveRecordSchema.safeParse = safeParse;
      objectiveRecordSchema.parse = parse;
    }
  } finally { f.close(); }
});
