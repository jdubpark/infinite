import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { RunEvent } from "../packages/host/src/evidence/types.js";
import { MAX_OUTBOX_EVENTS } from "../packages/host/src/run-events.js";
import { DEFAULT_TEAM_RETENTION, type TeamRun } from "../packages/host/src/team-types.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { prepareMemberWorkspace } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { limitLineup, mixedLineup } from "./team-fixture.js";

const SUMMARY_KEYS = ["tasks", "integrated", "members", "round", "checks", "recoveries", "decisionsByOwner",
  "decisionsByCoordinator", "steering", "permissionEscalations", "continuations"];

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
  save(stored: unknown): void;
  record(id: string): unknown;
  block(stored: unknown, error: unknown, member?: unknown): void;
  step(stored: unknown): Promise<void>;
  retire(stored: unknown): Promise<void>;
  consume(stored: unknown, member: unknown): void;
  launch(stored: unknown, member: unknown): Promise<void>;
  readMemberJournal(stored: unknown, member: unknown): unknown;
  replaceStalledMember(stored: unknown, member: unknown): Promise<void>;
  switchLimitedMember(stored: unknown, member: unknown, limit: unknown): Promise<void>;
};
const internal = (teams: TeamService) => teams as unknown as Internal;

test("a service without an outbox writes no ledger fields", async () => {
  const f = schedulerFixture();
  try {
    f.writeTeam();
    const teams = f.openTeam();
    await teams.pause(f.run.id, { requestId: randomUUID(), revision: 1 });
    const sealed = f.readRecord<Record<string, unknown>>("team", f.run.id);
    for (const field of ["outbox", "ledgerStatus", "ledgerBlockSource", "ledgerGap"]) assert.equal(field in sealed, false, field);
  } finally { f.close(); }
});

test("a settled status emits run.settled once", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    await teams.cancel(f.run.id, { requestId: randomUUID(), revision: 1 });
    const settled = eventsOfKind(store, f.run.id, "run.settled");
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.data.v, 1);
    assert.equal(settled[0]!.data.status, "cancelled");
    assert.deepEqual(Object.keys(settled[0]!.data.summary as object).sort(), [...SUMMARY_KEYS].sort());
    internal(teams).save(internal(teams).record(f.run.id));
    assert.equal(eventsOfKind(store, f.run.id, "run.settled").length, 1, "a save that keeps the status adds no event");
  } finally { store.close(); f.close(); }
});

test("a blocked status emits run.blocked with its code", () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const member = f.run.members[0]!;
    f.run.recovery = { attempts: 2, status: "exhausted", source: {
      code: "wrong-agent-report", memberId: member.memberId, revision: 1, reason: "Earlier attempts were exhausted", at: new Date().toISOString(),
    } };
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    internal(teams).block(internal(teams).record(f.run.id), new TeamError(409, "wrong-agent-report", "An agent's report does not match its assigned role."), member);
    const blocked = eventsOfKind(store, f.run.id, "run.blocked");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0]!.data.code, "wrong-agent-report");
    assert.equal(blocked[0]!.data.sourceMemberId, member.memberId);
    assert.equal(f.readRecord<Record<string, unknown>>("team", f.run.id).ledgerBlockSource, undefined, "the source is cleared after the save");
  } finally { store.close(); f.close(); }
});

test("a legacy record emits only on the next change", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam({ run: { ...f.run, status: "paused" } });
    const teams = f.openTeam({ events: new EventOutbox(store) });
    assert.equal(allEvents(store, f.run.id).length, 0, "opening a legacy record stores no status event");
    await teams.cancel(f.run.id, { requestId: randomUUID(), revision: 1 });
    assert.equal(eventsOfKind(store, f.run.id, "run.settled").length, 1);
  } finally { store.close(); f.close(); }
});

test("events wait while the store is unavailable and arrive after a restart", async () => {
  const f = schedulerFixture();
  const good = openStore(f, f.key);
  good.close();
  const bad = openStore(f, randomBytes(32));
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(bad) });
    await teams.cancel(f.run.id, { requestId: randomUUID(), revision: 1 });
    const sealed = f.readRecord<{ outbox?: OutboxEvent[] }>("team", f.run.id);
    assert.deepEqual(sealed.outbox?.map(event => event.kind), ["run.settled"]);
    bad.close();
    const restored = openStore(f, f.key);
    try {
      f.openTeam({ events: new EventOutbox(restored) });
      assert.deepEqual(allEvents(restored, f.run.id).map(event => event.kind), ["run.settled"]);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("a repeated flush stores each key once", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const outbox = new EventOutbox(store);
    f.writeTeam();
    const teams = f.openTeam({ events: outbox });
    await teams.cancel(f.run.id, { requestId: randomUUID(), revision: 1 });
    const { seq, ...event } = eventsOfKind(store, f.run.id, "run.settled")[0]!;
    void seq;
    const sealed = f.readRecord<Record<string, unknown>>("team", f.run.id);
    f.writeTeam({ ...sealed, outbox: [event] });
    f.openTeam({ events: outbox });
    assert.equal(eventsOfKind(store, f.run.id, "run.settled").length, 1);
  } finally { store.close(); f.close(); }
});

test("the outbox stops at its limit and reports the gap", async () => {
  const f = schedulerFixture();
  const good = openStore(f, f.key);
  good.close();
  const bad = openStore(f, randomBytes(32));
  try {
    const waiting: OutboxEvent[] = Array.from({ length: MAX_OUTBOX_EVENTS }, (_, index) => ({
      key: `synthetic:${index}`, runId: f.run.id, revision: 1, at: new Date().toISOString(), kind: "run.created", data: { v: 1 },
    }));
    f.writeTeam({ outbox: waiting });
    const teams = f.openTeam({ events: new EventOutbox(bad) });
    await teams.cancel(f.run.id, { requestId: randomUUID(), revision: 1 });
    const sealed = f.readRecord<{ outbox: OutboxEvent[]; ledgerGap?: { dropped: number } }>("team", f.run.id);
    assert.equal(sealed.outbox.length, MAX_OUTBOX_EVENTS);
    assert.equal(sealed.ledgerGap?.dropped, 1);
    bad.close();
    const restored = openStore(f, f.key);
    try {
      f.openTeam({ events: new EventOutbox(restored) });
      const gaps = eventsOfKind(restored, f.run.id, "ledger.gap");
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0]!.data.dropped, 1);
    } finally { restored.close(); }
  } finally { f.close(); }
});

test("run creation emits run.created", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    // The fixture project has no checks; the team may establish its own, as a project without configured checks needs.
    Object.assign(f.config.projects[0]!, { team: { checks: [], establishChecks: true } });
    Object.assign(f.config.agents, { demo: { command: process.execPath, args: [] } });
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const created = await teams.create({ requestId: randomUUID(), projectId: "fixture", provider: "demo",
      title: "Inspect the fixture", objective: "Report the fixture state", parallelism: 1 });
    const [event] = eventsOfKind(store, created.id, "run.created");
    assert.ok(event, "run.created is stored");
    assert.equal(event.revision, 1);
    assert.equal(event.data.projectId, "fixture");
    assert.equal(event.data.purpose, "work");
    assert.equal(event.data.lineup, false);
  } finally { store.close(); f.close(); }
});

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

test("steering advances the revision and says why", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const steered = await teams.steer(f.run.id, { requestId: randomUUID(), revision: 1, text: "Narrow the scope to the parser." });
    assert.equal(steered.revision, 2);
    const [event] = eventsOfKind(store, f.run.id, "run.revision-advanced");
    assert.ok(event, "the new revision is stored");
    assert.equal(event.revision, 2);
    assert.deepEqual(event.data, { v: 1, cause: "steer", fromRevision: 1, baseChanged: false });
  } finally { store.close(); f.close(); }
});

test("a continuation, a resume, and a recovery each name their cause", async () => {
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      f.run.members[0]!.status = "stopped";
      f.run.status = "blocked"; f.run.blockCode = "agent-blocked"; f.run.reason = "The implementer reported a blocker.";
      f.run.headCommit = f.run.baseCommit;
      f.writeTeam();
      const teams = f.openTeam({ events: new EventOutbox(store) });
      await teams.continueRun(f.run.id, { requestId: randomUUID(), revision: 1 });
      const [event] = eventsOfKind(store, f.run.id, "run.revision-advanced");
      assert.equal(event?.revision, 2);
      assert.deepEqual(event?.data, { v: 1, cause: "continue", fromRevision: 1, baseChanged: false });
    } finally { store.close(); f.close(); }
  }
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      f.run.status = "paused";
      f.writeTeam();
      const teams = f.openTeam({ events: new EventOutbox(store) });
      await teams.resume(f.run.id, { requestId: randomUUID(), revision: 1 });
      const [event] = eventsOfKind(store, f.run.id, "run.revision-advanced");
      assert.equal(event?.revision, 2);
      assert.deepEqual(event?.data, { v: 1, cause: "resume", fromRevision: 1, baseChanged: false });
    } finally { store.close(); f.close(); }
  }
  {
    const f = schedulerFixture();
    const store = openStore(f, f.key);
    try {
      const member = f.run.members[0]!;
      member.status = "stopped";
      member.report = { kind: "blocked", summary: "The implementer is blocked." };
      const source = { code: "agent-blocked", memberId: member.memberId, revision: 1, reportKind: "blocked" as const,
        reason: member.report.summary, at: new Date().toISOString() };
      f.run.recovery = { attempts: 1, status: "stopping", source };
      f.run.status = "planning"; f.run.blockCode = "agent-blocked"; f.run.reason = source.reason;
      f.run.headCommit = f.run.baseCommit;
      f.writeTeam();
      const teams = f.openTeam({ events: new EventOutbox(store) });
      const scheduler = internal(teams);
      await scheduler.step(scheduler.record(f.run.id));
      const [event] = eventsOfKind(store, f.run.id, "run.revision-advanced");
      assert.equal(event?.revision, 2);
      assert.deepEqual(event?.data, { v: 1, cause: "automatic-recovery", fromRevision: 1, baseChanged: false });
    } finally { store.close(); f.close(); }
  }
});

test("preparing a run records its base commit", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    // The fixture project has no checks; the team may establish its own, as a project without configured checks needs.
    Object.assign(f.config.projects[0]!, { team: { checks: [], establishChecks: true } });
    Object.assign(f.config.agents, { demo: { command: process.execPath, args: [] } });
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const created = await teams.create({ requestId: randomUUID(), projectId: "fixture", provider: "demo",
      title: "Inspect the fixture", objective: "Report the fixture state", parallelism: 1 });
    await waitFor(() => eventsOfKind(store, created.id, "run.prepared").length === 1, "the preparation is stored");
    const [event] = eventsOfKind(store, created.id, "run.prepared");
    assert.equal(event!.data.baseCommit, f.readRecord<{ run: TeamRun }>("team", created.id).run.baseCommit);
  } finally { store.close(); f.close(); }
});

test("removing a blocked run's workspace settles it", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, blockedHours: 1 };
    f.run.status = "blocked"; f.run.blockCode = "agent-blocked"; f.run.reason = "The implementer reported a blocker.";
    f.run.headCommit = f.run.baseCommit;
    f.run.members.forEach(member => { member.status = "stopped"; });
    f.writeTeam({ retention: { status: "blocked", statusAt: "2020-01-01T00:00:00.000Z", integratedAt: {}, removalErrors: {} } });
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    await scheduler.retire(scheduler.record(f.run.id));
    await teams.idle();
    const settled = eventsOfKind(store, f.run.id, "run.settled");
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.data.status, "blocked");
    assert.deepEqual(Object.keys(settled[0]!.data.summary as object).sort(), [...SUMMARY_KEYS].sort());
    await scheduler.retire(scheduler.record(f.run.id));
    await teams.idle();
    assert.equal(eventsOfKind(store, f.run.id, "run.settled").length, 1, "a later pass adds no second event");
  } finally { store.close(); f.close(); }
});

test("a workspace removal that cannot be saved leaves no settled event", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, blockedHours: 1 };
    f.run.status = "blocked"; f.run.blockCode = "agent-blocked"; f.run.reason = "The implementer reported a blocker.";
    f.run.headCommit = f.run.baseCommit;
    f.run.members.forEach(member => { member.status = "stopped"; });
    f.writeTeam({ retention: { status: "blocked", statusAt: "2020-01-01T00:00:00.000Z", integratedAt: {}, removalErrors: {} } });
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const restore = f.blockRecordWrites("team", f.run.id);
    try { await scheduler.retire(scheduler.record(f.run.id)); }
    finally { restore(); }
    assert.equal(eventsOfKind(store, f.run.id, "run.settled").length, 0, "the store holds no settled event");
    const sealed = f.readRecord<{ outbox?: OutboxEvent[]; run: TeamRun }>("team", f.run.id);
    assert.equal(sealed.run.workspaceRemovedAt, undefined, "the removal did not start");
    assert.equal((sealed.outbox ?? []).filter(event => event.kind === "run.settled").length, 0, "the sealed outbox holds no settled event");
    await scheduler.retire(scheduler.record(f.run.id));
    await teams.idle();
    const settled = eventsOfKind(store, f.run.id, "run.settled");
    assert.equal(settled.length, 1);
    assert.equal(settled[0]!.data.status, "blocked");
  } finally { store.close(); f.close(); }
});

test("an owner removes a run while the store is unavailable", async () => {
  const f = schedulerFixture();
  const good = openStore(f, f.key);
  good.close();
  const bad = openStore(f, randomBytes(32));
  try {
    f.run.status = "cancelled";
    f.run.members.forEach(member => { member.status = "stopped"; });
    f.writeTeam();
    await f.openTeam({ events: new EventOutbox(bad) }).removeRun(f.run.id);
    assert.equal(existsSync(join(f.config.stateDir, "teams", `${f.run.id}.sealed`)), false);
  } finally { bad.close(); f.close(); }
});

test("retention keeps a record while its events wait, for at most a day", async () => {
  const f = schedulerFixture();
  const good = openStore(f, f.key);
  good.close();
  const bad = openStore(f, randomBytes(32));
  const outbox = new EventOutbox(bad);
  const sealedPath = join(f.config.stateDir, "teams", `${f.run.id}.sealed`);
  try {
    f.config.teams!.retention = { ...DEFAULT_TEAM_RETENTION, cancelledMinutes: 1 };
    f.run.status = "cancelled";
    f.run.members.forEach(member => { member.status = "stopped"; });
    rmSync(dirname(f.run.workspace), { recursive: true, force: true });
    f.run.workspaceRemovedAt = "2020-01-01T00:00:00.000Z";
    f.writeTeam({ retention: { status: "cancelled", statusAt: "2020-01-01T00:00:00.000Z", integratedAt: {}, removalErrors: {} } });

    const first = f.openTeam({ events: outbox });
    const firstScheduler = internal(first);
    await firstScheduler.retire(firstScheduler.record(f.run.id));
    assert.equal(existsSync(sealedPath), true, "the record is kept while its events wait");
    const held = f.readRecord<{ retention: { evidenceHeldAt?: string } }>("team", f.run.id).retention.evidenceHeldAt;
    assert.ok(held, "the first held attempt is recorded");

    const sealed = f.readRecord<{ retention: Record<string, unknown> }>("team", f.run.id);
    f.writeTeam({ ...sealed, retention: { ...sealed.retention, evidenceHeldAt: new Date(Date.now() - 25 * 3600000).toISOString() } });
    const later = f.openTeam({ events: outbox });
    const laterScheduler = internal(later);
    await laterScheduler.retire(laterScheduler.record(f.run.id));
    assert.equal(existsSync(sealedPath), false, "past a day the record is removed although its events still wait");
  } finally { bad.close(); f.close(); }
});

test("a run behaves the same with an unavailable store as with no ledger", async () => {
  type Step = { status: string; revision: number; reason?: string; blockCode?: string };
  const drive = async (withLedger: boolean) => {
    const f = schedulerFixture();
    const good = openStore(f, f.key);
    good.close();
    const bad = withLedger ? openStore(f, randomBytes(32)) : undefined;
    try {
      f.writeTeam();
      const teams = f.openTeam(bad ? { events: new EventOutbox(bad) } : undefined);
      const trace: Step[] = [];
      const record = (view: { status: string; revision: number; reason?: string; blockCode?: string }) =>
        trace.push({ status: view.status, revision: view.revision, reason: view.reason, blockCode: view.blockCode });
      let revision = 1;
      const step = async (run: () => Promise<{ revision: number; status: string; reason?: string; blockCode?: string }>) => {
        const view = await run();
        revision = view.revision;
        record(view);
      };
      await step(() => teams.pause(f.run.id, { requestId: randomUUID(), revision }));
      // The fixture has no real provider to stop its member, so the stop the scheduler would record is set here before the resume.
      const paused = internal(teams).record(f.run.id) as { run: { members: { status: string }[] }; halt?: string };
      paused.run.members.forEach(member => { member.status = "stopped"; });
      paused.halt = undefined;
      await step(() => teams.resume(f.run.id, { requestId: randomUUID(), revision }));
      await step(() => teams.steer(f.run.id, { requestId: randomUUID(), revision, text: "Prefer the smaller change." }));
      await step(() => teams.cancel(f.run.id, { requestId: randomUUID(), revision }));
      const sealed = f.readRecord<{ run: { events: { text: string }[] }; outbox?: unknown[] }>("team", f.run.id);
      return { trace, texts: sealed.run.events.map(event => event.text), sealed };
    } finally { bad?.close(); f.close(); }
  };
  const plain = await drive(false);
  const unavailable = await drive(true);
  assert.deepEqual(unavailable.trace, plain.trace, "status, revision, reason, and blockCode match after every step");
  assert.deepEqual(unavailable.texts, plain.texts, "the run's event messages match");
  assert.equal("outbox" in plain.sealed, false, "a service without an outbox writes no outbox key");
  assert.ok(Array.isArray(unavailable.sealed.outbox) && unavailable.sealed.outbox.length > 0, "the events wait in the sealed record");
});

test("a deleted run's last event is projected before its events are removed", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  const projected: string[] = [];
  try {
    store.register({ name: "probe", version: 1, readVersion: 1, migrate() {}, runIds: () => [] });
    const outbox = new EventOutbox(store);
    outbox.registerProjector({ name: "probe", module: "probe", kinds: ["run.deleted"], project: (_tx, event) => { projected.push(event.key); } });
    f.run.status = "cancelled";
    f.run.members.forEach(member => { member.status = "stopped"; });
    f.writeTeam();
    const teams = f.openTeam({ events: outbox });
    // server.ts attaches the store this way; removeRun must then do the whole deletion itself.
    teams.useEvidence(store);
    await teams.removeRun(f.run.id);
    assert.deepEqual(projected, [`run.deleted:${f.run.id}`], "the probe saw run.deleted exactly once");
    assert.deepEqual(store.events({ runId: f.run.id, limit: 100 }).events, [], "no event for the run remains in the store");
    assert.equal(store.describe().counts["event-outbox.lost"], 0);
  } finally { store.close(); f.close(); }
});

/** The project manager's record, read from the sealed store, with its report set for `consume`. */
function reportFrom(teams: TeamService, runId: string, report: unknown) {
  const stored = internal(teams).record(runId) as { run: TeamRun; members?: never };
  const member = stored.run.members[0]!;
  member.report = report as TeamRun["members"][number]["report"];
  return { stored, member };
}

test("an accepted plan records the plan and each task with its features", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    Object.assign(f.config.projects[0]!, { team: { checks: [{ command: "npm", args: ["test"] }], features: { areas: [{ id: "host", paths: ["packages/host"] }] } } });
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const { stored, member } = reportFrom(teams, f.run.id, { kind: "plan", summary: "Two tasks", parallelism: 4, tasks: [
      { id: "a", title: "Session fix", instructions: "Repair the session", paths: ["packages/host/src/auth/session.ts"], dependsOn: [], kind: "fix" },
      { id: "b", title: "Docs", instructions: "Document it", paths: ["docs/teams.md"], dependsOn: ["a"] },
    ] });
    internal(teams).consume(stored, member);
    await waitFor(() => (stored as { pending?: unknown }).pending === undefined, "the report's operation completes");
    await teams.idle();

    const [plan] = eventsOfKind(store, f.run.id, "plan.accepted");
    assert.ok(plan, "plan.accepted is stored");
    assert.equal(plan.revision, 1);
    assert.equal(plan.memberId, member.memberId);
    assert.equal(plan.data.taskCount, 2);
    assert.match(String(plan.data.planDigest), /^[0-9a-f]{64}$/);
    assert.equal(plan.data.parallelism, 4);

    const tasks = eventsOfKind(store, f.run.id, "task.planned");
    assert.deepEqual(tasks.map(event => event.taskId), ["a", "b"]);
    const [first, second] = tasks;
    assert.equal(first!.data.profileId, undefined, "a single-provider run names no profile");
    assert.deepEqual(first!.data.paths, ["packages/host/src/auth/session.ts"]);
    const firstFeatures = first!.data.features as Record<string, unknown>;
    assert.equal(firstFeatures.role, "implementer");
    assert.equal(firstFeatures.area, "host");
    assert.equal(firstFeatures.kind, "fix");
    assert.equal(firstFeatures.risk, "elevated");
    assert.equal(firstFeatures.featureVersion, 1);
    assert.match(String(firstFeatures.featureMap), /^[0-9a-f]{64}$/);
    const secondFeatures = second!.data.features as Record<string, unknown>;
    assert.equal(secondFeatures.area, "docs/");
    assert.equal(secondFeatures.kind, null);
    assert.equal(secondFeatures.risk, "normal");
    assert.equal("dependsOn" in second!.data, false, "dependencies and instructions are not stored");
    assert.equal("instructions" in second!.data, false);
  } finally { store.close(); f.close(); }
});

test("oversized owned paths leave the task event without them", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    Object.assign(f.config.projects[0]!, { team: { checks: [{ command: "npm", args: ["test"] }], features: { areas: [{ id: "host", paths: ["packages/host"] }] } } });
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const paths = Array.from({ length: 32 }, (_, index) => `${"é".repeat(296)}/${index}`);
    const { stored, member } = reportFrom(teams, f.run.id, { kind: "plan", summary: "Wide task", tasks: [
      { id: "a", title: "Wide", instructions: "Touch many files", paths, dependsOn: [] },
    ] });
    internal(teams).consume(stored, member);
    await waitFor(() => (stored as { pending?: unknown }).pending === undefined, "the report's operation completes");
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "task.planned");
    assert.ok(event, "task.planned is stored");
    assert.equal(event.data.pathsOmitted, true);
    assert.equal("paths" in event.data, false);
    assert.equal(typeof (event.data.features as { area?: unknown }).area, "string");
  } finally { store.close(); f.close(); }
});

test("discovery records each scout with its profile", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.run.lineup = structuredClone(mixedLineup);
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const { stored, member } = reportFrom(teams, f.run.id, { kind: "explore", summary: "Two scouts", parallelism: 2, tasks: [
      { id: "s1", title: "First scout", instructions: "Read the parser", agentProfileId: "spark-high" },
      { id: "s2", title: "Second scout", instructions: "Read the store", agentProfileId: "astra-xhigh" },
    ] });
    internal(teams).consume(stored, member);
    await waitFor(() => (stored as { pending?: unknown }).pending === undefined, "the report's operation completes");
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "discovery.accepted");
    assert.ok(event, "discovery.accepted is stored");
    assert.equal(event.revision, 1);
    assert.equal(event.data.parallelism, 2);
    const scouts = event.data.scouts as { taskId: string; profileId: string; features: Record<string, unknown> }[];
    assert.deepEqual(scouts.map(scout => [scout.taskId, scout.profileId]), [["s1", "spark-high"], ["s2", "astra-xhigh"]]);
    for (const scout of scouts) {
      assert.equal(scout.features.role, "scout");
      assert.equal(scout.features.area, "none");
      assert.equal(scout.features.kind, "investigation");
      assert.equal(scout.features.risk, "normal");
    }
  } finally { store.close(); f.close(); }
});

test("a refused plan records no plan", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const { stored, member } = reportFrom(teams, f.run.id, { kind: "plan", summary: "Self dependent", tasks: [
      { id: "a", title: "Loop", instructions: "Depends on itself", paths: ["src/a.ts"], dependsOn: ["a"] },
    ] });
    // `step` turns a refused report into a block; this drives the same path without the scheduler loop.
    try { internal(teams).consume(stored, member); }
    catch (error) { internal(teams).block(stored, error, member); }
    await teams.idle();
    assert.equal(stored.run.status, "blocked");
    assert.equal(eventsOfKind(store, f.run.id, "plan.accepted").length, 0);
    assert.equal(eventsOfKind(store, f.run.id, "task.planned").length, 0);
  } finally { store.close(); f.close(); }
});

test("a launch records member.started once", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const memberId = randomUUID(), sessionId = randomUUID();
    const queued = { ...f.run.members[0]!, memberId, sessionId, role: "implementer" as const, title: "Implementer: a", taskId: "a",
      provider: "opencode" as const, modelProfile: mixedLineup.implementers[0]!, status: "queued" as const, cursor: 0, prompt: "Write a.txt" };
    f.run.members = [queued];
    f.run.lineup = mixedLineup; f.run.status = "implementing"; f.run.parallelism = 2;
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => eventsOfKind(store, f.run.id, "member.started").length === 1, "member.started is stored");
    const stored = f.readRecord<{ run: TeamRun }>("team", f.run.id).run.members[0]!;
    const [event] = eventsOfKind(store, f.run.id, "member.started");
    assert.equal(event!.memberId, memberId);
    assert.equal(event!.taskId, "a");
    assert.equal(event!.revision, 1);
    assert.equal(event!.data.role, "implementer");
    assert.equal(event!.data.purpose, "work");
    assert.equal(event!.data.sessionId, sessionId);
    assert.equal(event!.data.startedAt, stored.startedAt);
    assert.equal(event!.data.baseCommit, f.run.baseCommit);
    assert.equal(event!.data.profileId, "spark-high");
    assert.equal(event!.data.provider, "opencode");
    assert.equal(event!.data.model, "meta/muse-spark-1.3-contributor");
    assert.equal(event!.data.effort, "high");
    assert.equal("replaces" in event!.data, false);

    await scheduler.step(scheduler.record(f.run.id));
    await teams.idle();
    assert.equal(eventsOfKind(store, f.run.id, "member.started").length, 1, "a second step adds none");
    const second = openStore(f, f.key);
    try {
      const restarted = f.openTeam({ events: new EventOutbox(second) });
      await internal(restarted).step(internal(restarted).record(f.run.id));
      await restarted.idle();
      assert.equal(eventsOfKind(second, f.run.id, "member.started").length, 1, "a restart adds none");
    } finally { second.close(); }
  } finally { store.close(); f.close(); }
});

test("a report records member.reported with its kind", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const pm = f.run.members[0]!;
    f.report(pm.sessionId, { requestId: randomUUID(), runId: f.run.id, memberId: pm.memberId, revision: pm.revision,
      report: { kind: "plan", summary: "One task", tasks: [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [] }] } });
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => eventsOfKind(store, f.run.id, "member.reported").length === 1, "member.reported is stored");
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "member.reported");
    assert.equal(event!.memberId, pm.memberId);
    assert.deepEqual(event!.data, { v: 1, role: "project-manager", reportKind: "plan" });
  } finally { store.close(); f.close(); }
});

test("an answered replacement names the member it replaces", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.run.missionId = randomUUID();
    f.run.parallelismCeiling = 4;
    const original = f.run.members[0], at = new Date().toISOString();
    const active = { ...original, role: "implementer" as const, taskId: "a", startedAt: at, lastActivityAt: at };
    const waiting = { ...original, memberId: randomUUID(), sessionId: randomUUID(), role: "implementer" as const, taskId: "b", status: "waiting" as const,
      report: { kind: "question" as const, question: "Continue?", options: ["Yes"] } };
    f.run.members = [active, waiting]; f.run.status = "implementing"; f.run.parallelism = 2;
    f.run.tasks = ["a", "b"].map((id, index) => ({ id, title: id, instructions: "Write the assigned file", paths: [`${id}.txt`], dependsOn: [],
      status: index ? "waiting" as const : "running" as const, memberId: index ? waiting.memberId : active.memberId }));
    f.run.decisions = [{ id: randomUUID(), memberId: waiting.memberId, revision: 1, question: "Continue?", options: ["Yes"], createdAt: at }];
    f.state.attention.lastActivityAt = at;
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    await teams.setMissionParallelism(f.run.id, { requestId: randomUUID(), revision: 1, parallelism: 1 });
    await teams.answer(f.run.id, f.run.decisions[0]!.id, { requestId: randomUUID(), revision: 1, text: "Yes" });
    await scheduler.step(scheduler.record(f.run.id));
    await teams.setMissionParallelism(f.run.id, { requestId: randomUUID(), revision: 1, parallelism: 2 });
    await scheduler.step(scheduler.record(f.run.id));
    const next = f.readRecord<{ run: TeamRun; ledgerReplaces?: Record<string, unknown> }>("team", f.run.id);
    const replacement = next.run.members.find(member => member.taskId === "b" && member.status === "queued")!;
    assert.ok(replacement, "the answered member has a queued replacement");
    assert.deepEqual(next.ledgerReplaces?.[replacement.memberId], { memberId: waiting.memberId, cause: "answer" });

    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => eventsOfKind(store, f.run.id, "member.started").some(event => event.memberId === replacement.memberId), "the replacement starts");
    const [started] = eventsOfKind(store, f.run.id, "member.started").filter(event => event.memberId === replacement.memberId);
    assert.deepEqual(started!.data.replaces, { memberId: waiting.memberId, cause: "answer" });
    assert.equal("ledgerReplaces" in f.readRecord<Record<string, unknown>>("team", f.run.id), false, "the link is dropped once the replacement starts");
  } finally { store.close(); f.close(); }
});

test("a service without an outbox records no replacement link", async () => {
  const f = schedulerFixture();
  try {
    f.run.missionId = randomUUID();
    f.run.parallelismCeiling = 4;
    const original = f.run.members[0], at = new Date().toISOString();
    const active = { ...original, role: "implementer" as const, taskId: "a", startedAt: at, lastActivityAt: at };
    const waiting = { ...original, memberId: randomUUID(), sessionId: randomUUID(), role: "implementer" as const, taskId: "b", status: "waiting" as const,
      report: { kind: "question" as const, question: "Continue?", options: ["Yes"] } };
    f.run.members = [active, waiting]; f.run.status = "implementing"; f.run.parallelism = 2;
    f.run.tasks = ["a", "b"].map((id, index) => ({ id, title: id, instructions: "Write the assigned file", paths: [`${id}.txt`], dependsOn: [],
      status: index ? "waiting" as const : "running" as const, memberId: index ? waiting.memberId : active.memberId }));
    f.run.decisions = [{ id: randomUUID(), memberId: waiting.memberId, revision: 1, question: "Continue?", options: ["Yes"], createdAt: at }];
    f.state.attention.lastActivityAt = at;
    f.writeTeam();
    const teams = f.openTeam();
    const scheduler = internal(teams);
    await teams.setMissionParallelism(f.run.id, { requestId: randomUUID(), revision: 1, parallelism: 1 });
    await teams.answer(f.run.id, f.run.decisions[0]!.id, { requestId: randomUUID(), revision: 1, text: "Yes" });
    await scheduler.step(scheduler.record(f.run.id));
    assert.equal("ledgerReplaces" in f.readRecord<Record<string, unknown>>("team", f.run.id), false);
    await teams.setMissionParallelism(f.run.id, { requestId: randomUUID(), revision: 1, parallelism: 2 });
    await scheduler.step(scheduler.record(f.run.id));
    assert.equal("ledgerReplaces" in f.readRecord<Record<string, unknown>>("team", f.run.id), false);
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.members.filter(member => member.taskId === "b").length, 2);
  } finally { f.close(); }
});

test("a permission coordinator emits no member event", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const coordinator = { ...f.run.members[0]!, memberId: randomUUID(), sessionId: randomUUID(), role: "permission-coordinator" as const,
      title: "Permission coordinator", provider: "claude" as const, status: "queued" as const, cursor: 0, prompt: "Review the request" };
    f.run.members = [coordinator];
    f.run.status = "implementing";
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun };
    const member = stored.run.members[0]!;
    await scheduler.launch(stored, member);
    assert.ok(f.launches.some(launch => launch.requestId === coordinator.sessionId), "the coordinator launched");
    f.report(coordinator.sessionId, { requestId: randomUUID(), runId: f.run.id, memberId: coordinator.memberId, revision: coordinator.revision,
      report: { kind: "permission-decision", decisionId: randomUUID(), verdict: "escalate", summary: "Needs the owner" } });
    scheduler.readMemberJournal(stored, member);
    assert.equal(member.report?.kind, "permission-decision", "the coordinator's report was read");
    await teams.idle();
    assert.deepEqual(allEvents(store, f.run.id).filter(event => event.kind.startsWith("member.")), []);
  } finally { store.close(); f.close(); }
});

const memberStops = (store: EvidenceStore, runId: string, memberId: string) =>
  eventsOfKind(store, runId, "member.stopped").filter(event => event.memberId === memberId);

test("a stalled member's stop names the stall", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun; pending?: unknown };
    const member = stored.run.members[0]!;
    member.stalledAt = new Date(Date.now() - 6 * 60000).toISOString();
    member.stoppedReason = "No activity for 5 minutes";
    f.state.status = "exited";
    await scheduler.replaceStalledMember(stored, member);
    await waitFor(() => (stored as { pending?: unknown }).pending === undefined, "the replacement is queued");
    await teams.idle();
    const stops = memberStops(store, f.run.id, member.memberId);
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0]!.data, { v: 1, role: "project-manager", reason: "stall", reported: false });
    const sealed = f.readRecord<{ run: TeamRun; ledgerReplaces?: Record<string, unknown> }>("team", f.run.id);
    const replacement = sealed.run.members.find(item => item.memberId !== member.memberId)!;
    assert.deepEqual(sealed.ledgerReplaces?.[replacement.memberId], { memberId: member.memberId, cause: "stall" });
  } finally { store.close(); f.close(); }
});

test("a limit stop without a fallback names the limit", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    const member = f.run.members[0]!;
    f.state.status = "exited";
    const limit = { kind: "provider-limit", limit: "usage", confidence: "corroborated", provider: "demo", source: "protocol",
      message: "Usage exhausted", at: new Date().toISOString(), seq: 0 };
    await scheduler.switchLimitedMember(stored, member, limit);
    await teams.idle();
    const stops = memberStops(store, f.run.id, member.memberId);
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0]!.data, { v: 1, role: "project-manager", reason: "limit", reported: false });
    const [blocked] = eventsOfKind(store, f.run.id, "run.blocked");
    assert.equal(blocked!.data.code, "provider-limit");
    assert.equal(JSON.stringify(allEvents(store, f.run.id)).includes("Usage exhausted"), false, "a provider's limit message is never stored");
  } finally { store.close(); f.close(); }
});

test("an owner cancel stops members as owner stops", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const member = f.run.members[0]!;
    await teams.cancel(f.run.id, { requestId: randomUUID(), revision: 1 });
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await teams.idle();
    const stops = memberStops(store, f.run.id, member.memberId);
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0]!.data, { v: 1, role: "project-manager", reason: "owner", detail: "cancel", reported: false });
  } finally { store.close(); f.close(); }
});

test("a reported member that a halt stops is marked reported", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const member = f.run.members[0]!;
    member.status = "reported";
    member.report = { kind: "result", summary: "Done" } as TeamRun["members"][number]["report"];
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    await teams.pause(f.run.id, { requestId: randomUUID(), revision: 1 });
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await teams.idle();
    const stops = memberStops(store, f.run.id, member.memberId);
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0]!.data, { v: 1, role: "project-manager", reason: "owner", detail: "pause", reported: true });
  } finally { store.close(); f.close(); }
});

test("a sibling block stops the other members as host stops", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id);
    const member = f.run.members[0]!;
    scheduler.block(stored, new TeamError(409, "wrong-agent-report", "An agent's report does not match its assigned role."));
    await scheduler.step(stored);
    await scheduler.step(stored);
    await teams.idle();
    const stops = memberStops(store, f.run.id, member.memberId);
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0]!.data, { v: 1, role: "project-manager", reason: "host", detail: "block", reported: false });
  } finally { store.close(); f.close(); }
});

test("a member that exits without a report keeps its first reason", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const member = f.run.members[0]!;
    f.state.status = "exited";
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => memberStops(store, f.run.id, member.memberId).length === 1, "the exit is stored");
    const stops = memberStops(store, f.run.id, member.memberId);
    assert.deepEqual(stops[0]!.data, { v: 1, role: "project-manager", reason: "no-report", reported: false });
    await scheduler.step(scheduler.record(f.run.id));
    await scheduler.step(scheduler.record(f.run.id));
    await teams.idle();
    assert.equal(memberStops(store, f.run.id, member.memberId).length, 1, "later ticks add no second stop");
  } finally { store.close(); f.close(); }
});

test("a retired reviewer's stop is a host stop", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const member = f.run.members[0]!;
    member.role = "reviewer";
    f.run.headCommit = f.run.baseCommit;
    f.writeTeam({ checkHead: f.run.baseCommit });
    (f.manager as unknown as Record<string, unknown>).retireTeamRuntime = async () => ({ stoppedAt: new Date().toISOString(),
      identity: "a".repeat(64), seq: 0, processes: [], unsignalable: [] });
    const teams = f.openTeam({ events: new EventOutbox(store) });
    await teams.retireMember(f.run.id, member.memberId, { requestId: randomUUID(), revision: 1, sessionId: member.sessionId,
      identity: "a".repeat(64), text: "Retire the reviewer" });
    await teams.idle();
    const stops = memberStops(store, f.run.id, member.memberId);
    assert.equal(stops.length, 1);
    assert.deepEqual(stops[0]!.data, { v: 1, role: "reviewer", reason: "host", detail: "retired", reported: false });
  } finally { store.close(); f.close(); }
});

/** A member's own clone at the run's base commit, prepared as a real attempt is. */
async function memberClone(f: Fixture, memberId: string) {
  return prepareMemberWorkspace(f.run.workspace, memberId, f.run.baseCommit, f.config.teams?.commandPrefix);
}

test("an integrated result records its commit, head, and diff counts", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const memberId = randomUUID(), cwd = await memberClone(f, memberId);
    writeFileSync(join(cwd, "a.txt"), "one\n");
    f.run.headCommit = f.run.baseCommit;
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    const member = { ...f.run.members[0]!, memberId, role: "implementer" as const, taskId: "a", cwd, status: "reported" as const,
      report: { kind: "result" as const, summary: "Wrote a.txt" } };
    f.run.members = [member];
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun; pending?: unknown };
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the result is integrated");
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "task.integrated");
    assert.ok(event, "task.integrated is stored");
    assert.equal(event.memberId, memberId);
    assert.equal(event.taskId, "a");
    assert.equal(event.revision, 1);
    const sealedTask = stored.run.tasks[0]!;
    assert.equal(event.data.commit, sealedTask.commit);
    assert.match(String(event.data.commit), /^[0-9a-f]{40}$/);
    assert.equal(event.data.headCommit, stored.run.headCommit);
    assert.equal(event.data.baseCommit, f.run.baseCommit);
    assert.equal(event.data.memberBaseCommit, f.run.baseCommit);
    assert.deepEqual(event.data.diff, { added: 1, removed: 0, files: 1, docs: false, tests: false });
    assert.equal(JSON.stringify(allEvents(store, f.run.id)).includes("Wrote a.txt"), false, "a summary is never stored");
    assert.equal(JSON.stringify(allEvents(store, f.run.id)).includes("a.txt"), false, "owned paths are stored only by task.planned");
  } finally { store.close(); f.close(); }
});

test("an empty result records no commit", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const memberId = randomUUID(), cwd = await memberClone(f, memberId);
    f.run.headCommit = f.run.baseCommit;
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    const member = { ...f.run.members[0]!, memberId, role: "implementer" as const, taskId: "a", cwd, status: "reported" as const,
      report: { kind: "result" as const, summary: "Nothing to change" } };
    f.run.members = [member];
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun; pending?: unknown };
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the empty result completes");
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "task.integrated");
    assert.ok(event, "task.integrated is stored");
    assert.equal("commit" in event.data, false);
    assert.equal(event.data.headCommit, f.run.baseCommit);
    assert.equal("diff" in event.data, false);
  } finally { store.close(); f.close(); }
});

test("a completed scout records scout.completed", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.run.lineup = structuredClone(mixedLineup);
    const memberId = randomUUID(), cwd = await memberClone(f, memberId);
    const member = { ...f.run.members[0]!, memberId, role: "scout" as const, taskId: "s1", cwd, status: "reported" as const,
      report: { kind: "findings" as const, summary: "The parser reads paths", evidence: [] } };
    f.run.members = [member];
    f.run.discovery = { revision: f.run.revision, summary: "Scouts", tasks: [{ id: "s1", title: "Scout", instructions: "Read the parser",
      agentProfileId: "spark-high", paths: [], dependsOn: [], status: "running", memberId }] };
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun; pending?: unknown };
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the findings complete");
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "scout.completed");
    assert.ok(event, "scout.completed is stored");
    assert.equal(event.memberId, memberId);
    assert.equal(event.taskId, "s1");
    assert.deepEqual(event.data, { v: 1 });
  } finally { store.close(); f.close(); }
});

test("an escalation records both profiles and links the new member", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    const escalation = { id: "astra-escalation", label: "Astra escalation", provider: "codex" as const, model: "gpt-6-astra", effort: "xhigh" as const, tier: "strong" as const };
    f.run.lineup = { ...structuredClone(mixedLineup), escalations: [escalation] };
    const memberId = randomUUID(), cwd = await memberClone(f, memberId);
    const profile = f.run.lineup.implementers[0]!;
    f.run.headCommit = f.run.baseCommit;
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    const member = { ...f.run.members[0]!, memberId, role: "implementer" as const, taskId: "a", cwd, provider: "opencode" as const,
      modelProfile: profile, status: "reported" as const, report: { kind: "escalate" as const, reason: "Needs the stronger model", agentProfileId: escalation.id } };
    // The escalating member is stopped by the time its replacement launches; the fixture's session must agree.
    member.status = "stopped" as typeof member.status;
    f.state.status = "exited";
    f.run.members = [member];
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun; pending?: unknown };
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the escalation completes");
    await teams.idle();
    const [event] = eventsOfKind(store, f.run.id, "task.escalated");
    assert.ok(event, "task.escalated is stored");
    assert.equal(event.memberId, memberId);
    assert.equal(event.taskId, "a");
    assert.deepEqual(event.data, { v: 1, fromProfileId: "spark-high", toProfileId: escalation.id });
    const sealed = f.readRecord<{ run: TeamRun; ledgerReplaces?: Record<string, unknown> }>("team", f.run.id);
    const next = sealed.run.members.find(item => item.memberId !== memberId)!;
    assert.deepEqual(sealed.ledgerReplaces?.[next.memberId], { memberId, cause: "escalation" });
    await scheduler.step(scheduler.record(f.run.id));
    await waitFor(() => eventsOfKind(store, f.run.id, "member.started").some(item => item.memberId === next.memberId), "the escalated member starts");
    const [started] = eventsOfKind(store, f.run.id, "member.started").filter(item => item.memberId === next.memberId);
    assert.deepEqual(started!.data.replaces, { memberId, cause: "escalation" });
  } finally { store.close(); f.close(); }
});

test("a limit switch records both profiles and links the new member", async () => {
  const f = schedulerFixture();
  const store = openStore(f, f.key);
  try {
    f.run.lineup = structuredClone(limitLineup);
    const memberId = randomUUID(), cwd = await memberClone(f, memberId);
    const profile = f.run.lineup.implementers[0]!;
    f.run.headCommit = f.run.baseCommit;
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    const member = { ...f.run.members[0]!, memberId, role: "implementer" as const, taskId: "a", cwd, provider: "claude" as const,
      modelProfile: profile, status: "running" as const, prompt: "Write a.txt" };
    f.run.members = [member];
    f.state.status = "exited";
    f.writeTeam();
    const teams = f.openTeam({ events: new EventOutbox(store) });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun; pending?: unknown };
    const limit = { kind: "provider-limit", limit: "usage", confidence: "corroborated", provider: "claude", source: "protocol",
      message: "Usage exhausted", at: new Date().toISOString(), seq: 0 };
    await scheduler.switchLimitedMember(stored, member, limit);
    await waitFor(() => stored.pending === undefined, "the limit switch completes");
    await teams.idle();
    const [switched] = eventsOfKind(store, f.run.id, "task.limit-switched");
    assert.ok(switched, "task.limit-switched is stored");
    assert.equal(switched.memberId, memberId);
    assert.equal(switched.taskId, "a");
    assert.deepEqual(switched.data, { v: 1, role: "implementer", fromProfileId: "haiku", toProfileId: "deepseek-light" });
    const [stop] = memberStops(store, f.run.id, memberId);
    assert.equal(stop!.data.reason, "limit");
    assert.equal(JSON.stringify(allEvents(store, f.run.id)).includes("Usage exhausted"), false, "a provider's limit message is never stored");
    const sealed = f.readRecord<{ run: TeamRun; ledgerReplaces?: Record<string, unknown> }>("team", f.run.id);
    const next = sealed.run.members.find(item => item.memberId !== memberId)!;
    assert.deepEqual(sealed.ledgerReplaces?.[next.memberId], { memberId, cause: "limit" });
  } finally { store.close(); f.close(); }
});
