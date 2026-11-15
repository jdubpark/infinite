import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { GoalService } from "../packages/host/src/goals.js";
import { GOAL_DIGEST_EVENTS, GOAL_OBJECTIVE_EVENTS, goalRecordDigest } from "../packages/host/src/objective-goals.js";
import { goalRecord } from "../packages/host/src/objective-record.js";
import { objectiveRecordSchema, recordDigest, type ObjectiveRecord, type Criterion } from "../packages/host/src/objective-types.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import type { CreateGoal, ProductGoal } from "../packages/host/src/goal-types.js";
import type { Config } from "../packages/host/src/types.js";
import type { TeamCommand, TeamLineup } from "../packages/host/src/team-types.js";
import { TeamError } from "../packages/host/src/teams.js";

type StoredShape = { goal: ProductGoal; fingerprint: string; receipts: Record<string, string>; objectiveRecord?: unknown; objectiveNotice?: string; launch?: any; control?: unknown };

const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  escalations: [{ id: "strong", label: "Strong worker", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

const command = { command: process.execPath, args: ["-e", "0"] };

/** The scheduler fixture with a strong lineup, a configured project whose objective switch is on, so goals can be created. */
function fixture() {
  const f = schedulerFixture();
  f.config.teams = { ...f.config.teams!, lineup };
  f.config.projects[0]!.team = { checks: [command], objective: { prompts: "on" } } as Config["projects"][number]["team"];
  // The launch needs a profile for each provider of the lineup; the fixture's manager runs no agent.
  f.config.agents = { claude: { command: process.execPath, args: [] }, codex: { command: process.execPath, args: [] } } as Config["agents"];
  return f;
}

/** Sets or removes the project's objective switch. `undefined` removes the key, as an operator who never wrote it has it. */
function setSwitch(f: ReturnType<typeof fixture>, value: "on" | "off" | undefined) {
  const { objective: _objective, ...team } = f.config.projects[0]!.team!;
  f.config.projects[0]!.team = (value === undefined ? team : { ...team, objective: { prompts: value } }) as Config["projects"][number]["team"];
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
const correctionEvent = (version: number) => `The owner corrected the objective record to version ${version}.`;

const judgement = (statement: string) => ({ statement, check: { kind: "judgement" as const, item: "sources" }, threshold: { kind: "pass" as const } });
const commandCriterion = (statement: string) => ({ statement, check: { kind: "command" as const, run: command }, threshold: { kind: "pass" as const } });
const artifactCriterion = { statement: "The shortlist file exists", check: { kind: "artifact" as const, path: "research/shortlist.md" }, threshold: { kind: "pass" as const } };
const add = (criterion: ReturnType<typeof judgement>) => ({ op: "criterion.add" as const, criterion });
const correction = (version: number, ops: unknown[], requestId = randomUUID()) => ({ requestId, version, ops });
/** Resolves once the tick that `start` queued has finished: a steer with a stale revision queues behind it and changes nothing. */
const barrier = (goals: GoalService, id: string) => goals.steer(id, { requestId: randomUUID(), revision: 999, text: "Barrier" }).catch(() => undefined);
const refused = (code: string) => (error: unknown) => error instanceof TeamError && error.code === code;

/** Counts record parses and sealed-file reads until `stop`. */
function meter() {
  const counts = { parses: 0, sealed: 0 };
  const { safeParse, parse } = objectiveRecordSchema;
  const readFile = fs.readFileSync;
  objectiveRecordSchema.safeParse = ((...args: Parameters<typeof safeParse>) => { counts.parses++; return safeParse.apply(objectiveRecordSchema, args); }) as typeof safeParse;
  objectiveRecordSchema.parse = ((...args: Parameters<typeof parse>) => { counts.parses++; return parse.apply(objectiveRecordSchema, args); }) as typeof parse;
  fs.readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (typeof file === "string" && file.endsWith(".sealed")) counts.sealed++;
    return (readFile as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  return { counts, stop() {
    objectiveRecordSchema.safeParse = safeParse; objectiveRecordSchema.parse = parse;
    fs.readFileSync = readFile; syncBuiltinESMExports();
  } };
}

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

test("creation criteria join version 1", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const request = createInput();
    const created = await goals.create(request, undefined, [commandCriterion("The checks pass"), artifactCriterion]);
    const view = goals.objectiveRecord(created.id);
    assert.equal(view.version, 1);
    assert.deepEqual(view.record.criteria.map(item => item.id), ["c0", "c1", "c2"]);
    assert.deepEqual(view.log.filter(entry => entry.op === "criterion.added").map(entry => [entry.version, entry.target]), [[1, "c1"], [1, "c2"]]);
    assert.equal("criteria" in goals.get(created.id), false);

    assert.equal((await goals.create(request, undefined, [commandCriterion("The checks pass"), artifactCriterion])).id, created.id);
    await assert.rejects(goals.create(request, undefined, [judgement("Other")]), refused("request-conflict"));

    const unknown = createInput();
    await assert.rejects(goals.create(unknown, undefined, [{ statement: "Unknown", check: { kind: "command", run: { command: "not-configured", args: [] } }, threshold: { kind: "pass" } }]), (error: unknown) =>
      error instanceof TeamError && error.status === 400 && error.code === "objective-command-unknown");
    assert.equal(goals.list().some(goal => goal.id === unknown.requestId), false);
    assert.equal(existsSync(goalFile(f, unknown.requestId)), false);
  } finally { f.close(); }
});

test("a creation criterion that cannot be built refuses the create and stores nothing", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    // A configured check without args makes its digest throw: a host fault, not an owner error.
    const configured = f.config.projects[0]!.team!.checks;
    f.config.projects[0]!.team!.checks = [{ command: process.execPath } as TeamCommand];
    const goals = new GoalService(f.config, f.key, teams);
    const request = createInput();
    await assert.rejects(goals.create(request, undefined, [commandCriterion("The checks pass")]), refused("objective-op-refused"));
    assert.equal(goals.list().some(goal => goal.id === request.requestId), false);
    assert.equal(existsSync(goalFile(f, request.requestId)), false);

    f.config.projects[0]!.team!.checks = configured;
    const created = await goals.create(request, undefined, [commandCriterion("The checks pass")]);
    assert.equal(created.id, request.requestId);
    assert.equal(goals.objectiveRecord(created.id).record.criteria.length, 2);
    assert.equal((await goals.create(request, undefined, [commandCriterion("The checks pass")])).id, created.id);
  } finally { f.close(); }
});

test("corrections and creation criteria need the switch", async () => {
  for (const value of [undefined, "off"] as const) {
    const f = fixture(), teams = f.openTeam();
    try {
      setSwitch(f, value);
      const goals = new GoalService(f.config, f.key, teams);
      await assert.rejects(goals.create(createInput(), undefined, [commandCriterion("The checks pass")]), refused("objective-prompts-off"));
      const created = await goals.create(createInput());
      await assert.rejects(goals.correctObjective(created.id, correction(1, [add(judgement("Sources are named"))])), refused("objective-prompts-off"));
      assert.equal(goals.objectiveRecord(created.id).version, 1);
      assert.deepEqual(goals.objectiveRecord(created.id).record.criteria.map(item => item.id), ["c0"]);
      goals.start();
      await barrier(goals, created.id);
      goals.close();
      const active = goals.get(created.id).activeTeamId;
      assert.ok(active, `the goal launched a run with the switch ${String(value)}`);
      assert.equal("record" in teams.get(active).goal!, false);
    } finally { f.close(); }
  }
});

test("a correction applies once", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const created = await goals.create(createInput());
    const body = correction(1, [add(judgement("Sources are named"))]);
    const first = await goals.correctObjective(created.id, body);
    assert.equal(first.version, 2);
    const text = readFileSync(goalFile(f, created.id), "utf8");
    assert.deepEqual(await goals.correctObjective(created.id, body), first);
    assert.equal(readFileSync(goalFile(f, created.id), "utf8"), text);
    assert.equal(eventTexts(goals.get(created.id)).filter(event => event === correctionEvent(2)).length, 1);
    await assert.rejects(goals.correctObjective(created.id, correction(1, [add(judgement("Other"))], body.requestId)), refused("request-conflict"));
    await assert.rejects(goals.correctObjective(created.id, correction(1, [add(judgement("Other"))])), refused("objective-version-stale"));
    assert.equal(goals.get(created.id).revision, created.revision);
    // The replay is checked before the switch: after the switch turns off, the applied correction still answers its view.
    setSwitch(f, "off");
    assert.deepEqual(await goals.correctObjective(created.id, body), first);
    assert.equal(readFileSync(goalFile(f, created.id), "utf8"), text);
  } finally { f.close(); }
});

test("a failed correction write changes nothing", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const created = await goals.create(createInput());
    const before = goals.get(created.id);
    const body = correction(1, [add(judgement("Sources are named"))]);
    const restore = f.blockRecordWrites("goal", created.id);
    try {
      await assert.rejects(goals.correctObjective(created.id, body));
      assert.equal(goals.objectiveRecord(created.id).version, 1);
      const after = goals.get(created.id);
      assert.equal(after.updatedAt, before.updatedAt);
      assert.deepEqual(eventTexts(after), eventTexts(before));
    } finally { restore(); }
    assert.equal(f.readRecord<StoredShape>("goal", created.id).receipts[body.requestId], undefined);
    assert.equal((await goals.correctObjective(created.id, body)).version, 2);
    assert.ok(f.readRecord<StoredShape>("goal", created.id).receipts[body.requestId]);
  } finally { f.close(); }
});

test("a cycle pins the digest it launched with", async () => {
  const f = fixture(), teams = f.openTeam();
  let goals: GoalService | undefined;
  try {
    goals = new GoalService(f.config, f.key, teams);
    const created = await goals.create(createInput());
    await goals.correctObjective(created.id, correction(1, [add(commandCriterion("The checks pass"))]));
    goals.start();
    await barrier(goals, created.id);
    const teamId = goals.get(created.id).activeTeamId;
    assert.ok(teamId, "the tick launched the first cycle");
    assert.equal(teams.get(teamId).goal?.record?.version, 2);

    await goals.correctObjective(created.id, correction(2, [add(judgement("Owners are named"))]));
    assert.equal(teams.get(teamId).goal?.record?.version, 2);
    goals.close(); teams.close();

    const reopenedTeams = f.openTeam(), reopened = new GoalService(f.config, f.key, reopenedTeams);
    assert.equal(reopenedTeams.get(teamId).goal?.record?.version, 2);
    assert.equal(reopened.objectiveRecord(created.id).version, 3);
    reopened.close();

    // A pending launch stored by an older host has no record: it replays unchanged, without a digest.
    const legacy = createInput();
    const legacyId = (await reopened.create(legacy)).id;
    const stored = f.readRecord<StoredShape>("goal", legacyId);
    const launchRequest = randomUUID();
    f.writeRecord("goal", legacyId, { ...stored, launch: {
      request: { requestId: launchRequest, projectId: "fixture", provider: "claude", useConfiguredLineup: true, title: "Rank sources · 1", objective: "Find ranked sources", parallelism: 2 },
      context: { id: legacyId, revision: 1, cycle: 1, successCriteria: "A ranked shortlist with reasons and sources", nonGoals: ["no paid sources"], allowedPaths: ["research"], evidence: ["notes.md"], previousWork: [], deadlineAt: new Date(Date.now() + 3600000).toISOString(), maxMembers: 4, extendMinutes: 0, ceilingAt: new Date(Date.now() + 3600000).toISOString() },
      autonomy: "supervised",
    } });
    const legacyGoals = new GoalService(f.config, f.key, reopenedTeams);
    legacyGoals.start();
    await barrier(legacyGoals, legacyId);
    legacyGoals.close();
    const legacyTeam = reopenedTeams.get(legacyGoals.get(legacyId).activeTeamId!);
    assert.equal(legacyTeam.id, launchRequest);
    assert.equal("record" in legacyTeam.goal!, false);
    reopenedTeams.close();
  } finally { goals?.close(); f.close(); }
});

test("an unreadable record launches without a digest", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const created = await goals.create(createInput());
    goals.close();
    const stored = f.readRecord<StoredShape>("goal", created.id);
    f.writeRecord("goal", created.id, { ...stored, objectiveRecord: { schemaVersion: 1, junk: true } });

    const reopened = new GoalService(f.config, f.key, teams);
    reopened.start();
    await barrier(reopened, created.id);
    reopened.close();
    const goal = reopened.get(created.id);
    assert.equal(goal.status, "running");
    assert.equal("record" in teams.get(goal.activeTeamId!).goal!, false);
    assert.equal(eventTexts(goal).filter(text => text === GOAL_DIGEST_EVENTS["record-unavailable"]).length, 1);
  } finally { f.close(); }
});

/** A goal's record with `extra` criteria after c0, resealed by hand: the writer refuses the shapes these tests need. */
function recordWith(goal: ProductGoal, extra: Criterion[]): ObjectiveRecord {
  const { digest: _digest, ...body } = goalRecord(goal, "2026-11-14T10:00:00.000Z", "created") as ObjectiveRecord;
  const next = { ...body, criteria: [body.criteria[0]!, ...extra] };
  return { ...next, digest: recordDigest(next) };
}

test("the digest skips with its reason and never throws", () => {
  const goal = legacyGoal();
  const full = { command: process.execPath, args: ["-e", "0"] };
  const judged = (id: string): Criterion => ({ id, origin: "owner", statement: "a".repeat(1000), check: { kind: "judgement", item: "sources" }, producer: "evaluator", threshold: { kind: "pass" }, state: "active" });
  assert.ok("digest" in goalRecordDigest({ goal, objectiveRecord: recordWith(goal, []) }, [full]), "a small record has a digest");

  // Eight criteria of 1,000-byte statements cross the 6,144-byte digest limit: the digest is skipped, not thrown.
  const large = recordWith(goal, Array.from({ length: 7 }, (_, index) => judged(`c${index + 1}`)));
  assert.deepEqual(goalRecordDigest({ goal, objectiveRecord: large }, [full]), { skipped: "digest-too-large" });

  // A configured check without args makes the digest's label throw: that is an unreadable record, never an escape.
  const commanded = recordWith(goal, [{ id: "c1", origin: "owner", statement: "The checks pass", check: { kind: "command", command: commandDigest(full) }, producer: "host", threshold: { kind: "pass" }, state: "active" }]);
  assert.ok("digest" in goalRecordDigest({ goal, objectiveRecord: commanded }, [full]));
  assert.deepEqual(goalRecordDigest({ goal, objectiveRecord: commanded }, [{ command: process.execPath } as TeamCommand]), { skipped: "record-unavailable" });
});

test("a skipped digest is logged once while its reason holds", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const goals = new GoalService(f.config, f.key, teams);
    const created = await goals.create(createInput());
    goals.close();
    const stored = f.readRecord<StoredShape>("goal", created.id);
    f.writeRecord("goal", created.id, { ...stored, objectiveRecord: { schemaVersion: 1, junk: true } });

    const first = new GoalService(f.config, f.key, teams);
    first.start();
    await barrier(first, created.id);
    first.close();
    // The first run has ended: the goal has no active run, so the next tick prepares a second cycle with the same skip.
    const ended = f.readRecord<StoredShape>("goal", created.id);
    f.writeRecord("goal", created.id, { ...ended, goal: { ...ended.goal, activeTeamId: undefined } });

    const second = new GoalService(f.config, f.key, teams);
    second.start();
    await barrier(second, created.id);
    second.close();
    assert.equal(second.get(created.id).cycles.length, 2, "the second cycle launched");
    assert.equal(eventTexts(second.get(created.id)).filter(text => text === GOAL_DIGEST_EVENTS["record-unavailable"]).length, 1);
  } finally { f.close(); }
});

test("a pending control reaches its team after a failed migration write", { skip: process.getuid?.() === 0 }, async () => {
  const f = fixture();
  f.writeTeam();
  const teams = f.openTeam();
  const goalsDirectory = join(f.config.stateDir, "goals");
  const warn = console.warn;
  let goals: GoalService | undefined;
  try {
    const id = randomUUID();
    f.writeRecord("goal", id, { goal: legacyGoal({ id, activeTeamId: f.run.id }), receipts: {}, fingerprint: "fixture",
      control: { action: "pause", requestId: randomUUID(), teamId: f.run.id, revision: f.run.revision } });
    chmodSync(goalsDirectory, 0o500);
    console.warn = () => {};
    goals = new GoalService(f.config, f.key, teams);
    chmodSync(goalsDirectory, 0o700);
    console.warn = warn;
    goals.start();
    await barrier(goals, id);
    goals.close();
    const stored = f.readRecord<StoredShape>("goal", id);
    assert.equal(stored.control, undefined);
    assert.equal(objectiveRecordSchema.parse(stored.objectiveRecord).version, 1);
    assert.equal(teams.get(f.run.id).status, "paused");
  } finally {
    console.warn = warn;
    try { chmodSync(goalsDirectory, 0o700); } catch { /* the directory was removed with the fixture */ }
    goals?.close(); f.close();
  }
});

test("lists, single reads, and an idle tick parse no record and read no sealed file", async () => {
  const f = fixture(), teams = f.openTeam();
  try {
    const launching = new GoalService(f.config, f.key, teams);
    const first = await launching.create(createInput());
    const second = await launching.create(createInput({ title: "Second goal" }));
    // Each goal's first tick prepares its cycle, which parses its record once; both then hold an active run.
    launching.start();
    await barrier(launching, first.id);
    launching.close();
    assert.ok(launching.get(first.id).activeTeamId && launching.get(second.id).activeTeamId);

    const goals = new GoalService(f.config, f.key, teams);
    const counted = meter();
    try {
      goals.list();
      goals.get(first.id);
      goals.get(second.id);
      // An idle tick: the steer with a stale revision queues behind the tick and fails without a change.
      goals.start();
      await barrier(goals, first.id);
      goals.close();
      assert.deepEqual(counted.counts, { parses: 0, sealed: 0 });
    } finally { counted.stop(); }

    const corrected = meter();
    try {
      await goals.correctObjective(first.id, correction(1, [add(judgement("Sources are named"))]));
      assert.deepEqual(corrected.counts, { parses: 2, sealed: 0 });
    } finally { corrected.stop(); }

    const third = await goals.create(createInput({ title: "Third goal" }));
    const ticking = new GoalService(f.config, f.key, teams);
    const prepared = meter();
    try {
      ticking.start();
      await barrier(ticking, third.id);
      ticking.close();
      assert.deepEqual(prepared.counts, { parses: 1, sealed: 0 });
    } finally { prepared.stop(); }
    assert.equal(ticking.objectiveRecord(first.id).version, 2);
  } finally { f.close(); }
});
