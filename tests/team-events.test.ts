import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { RunEvent } from "../packages/host/src/evidence/types.js";
import { MAX_OUTBOX_EVENTS } from "../packages/host/src/run-events.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

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
