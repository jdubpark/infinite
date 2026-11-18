import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventOutbox, type OutboxEvent } from "../packages/host/src/evidence/outbox.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { RunEvent } from "../packages/host/src/evidence/types.js";
import { outcomeProjector } from "../packages/host/src/outcome-projector.js";
import { integrationGauge, integrationOf } from "../packages/host/src/outcome-gauges.js";
import { outcomeModule, readOutcome } from "../packages/host/src/outcome-store.js";
import { runEventKey } from "../packages/host/src/run-events.js";
import { prepareMemberWorkspace } from "../packages/host/src/team-workspace.js";
import { TeamService } from "../packages/host/src/teams.js";
import { configurationModule, configurationProjector } from "../packages/host/src/configuration-store.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

const RUN = "run-1";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const COMMIT = "c".repeat(40);
const DIFF = { added: 3, removed: 1, files: 1, docs: false, tests: true };
const FEATURES = { role: "implementer", area: "core", kind: null, risk: "normal", featureVersion: 1, featureMap: "default" };
const at = (minute: number) => `2026-11-18T10:${String(minute).padStart(2, "0")}:00.000Z`;

// ---------- a. integrationGauge ----------

function gaugeInput(overrides: Partial<Parameters<typeof integrationGauge>[0]> = {}): Parameters<typeof integrationGauge>[0] {
  return {
    tasks: [{ id: "a", status: "running" }],
    taskId: "a",
    memberBase: BASE,
    headBefore: BASE,
    changedPaths: { paths: ["secret/one.txt"], truncated: false },
    ...overrides,
  };
}

test("no other task in flight gives writers 0", () => {
  assert.equal(integrationGauge(gaugeInput({ tasks: [{ id: "a", status: "running" }] })).writers, 0);
  assert.equal(integrationGauge(gaugeInput({ tasks: [] })).writers, 0);
});

test("pending, integrated and blocked tasks are not counted", () => {
  const tasks = [
    { id: "p", status: "pending" }, { id: "i", status: "integrated" }, { id: "b", status: "blocked" },
  ];
  assert.equal(integrationGauge(gaugeInput({ tasks })).writers, 0);
});

test("running and waiting tasks are counted: two running and one waiting give 3", () => {
  const tasks = [
    { id: "a", status: "running" }, { id: "b", status: "running" }, { id: "c", status: "running" }, { id: "d", status: "waiting" },
  ];
  assert.equal(integrationGauge(gaugeInput({ tasks })).writers, 3);
});

test("the integrated task is never counted, whatever its status", () => {
  for (const status of ["running", "waiting", "integrated", "pending", "blocked"]) {
    assert.equal(integrationGauge(gaugeInput({ tasks: [{ id: "a", status }] })).writers, 0, status);
  }
});

test("staleBase compares the head with the member base, and is absent for an unknown head", () => {
  assert.equal(integrationGauge(gaugeInput({ headBefore: BASE })).staleBase, false);
  assert.equal(integrationGauge(gaugeInput({ headBefore: HEAD })).staleBase, true);
  const unknown = integrationGauge(gaugeInput({ headBefore: undefined }));
  assert.equal("staleBase" in unknown, false);
  const empty = integrationGauge(gaugeInput({ headBefore: "" }));
  assert.equal("staleBase" in empty, false);
});

test("changedPaths counts the list and truncated appears only for a truncated list", () => {
  const plain = integrationGauge(gaugeInput({ changedPaths: { paths: ["x", "y"], truncated: false } }));
  assert.equal(plain.changedPaths, 2);
  assert.equal("truncated" in plain, false);
  const cut = integrationGauge(gaugeInput({ changedPaths: { paths: ["x", "y"], truncated: true } }));
  assert.equal(cut.changedPaths, 2);
  assert.equal(cut.truncated, true);
});

test("an absent path list gives neither changedPaths nor truncated", () => {
  const gauge = integrationGauge(gaugeInput({ changedPaths: undefined }));
  assert.equal("changedPaths" in gauge, false);
  assert.equal("truncated" in gauge, false);
});

test("the gauge text holds no path and no commit id", () => {
  const paths = ["secret/one.txt", "private/two.txt"];
  const gauge = integrationGauge({
    tasks: [{ id: "a", status: "running" }, { id: "b", status: "waiting" }],
    taskId: "a",
    memberBase: BASE,
    headBefore: HEAD,
    changedPaths: { paths, truncated: true },
  });
  const text = JSON.stringify(gauge);
  for (const path of paths) assert.equal(text.includes(path), false, path);
  assert.equal(text.includes(BASE), false);
  assert.equal(text.includes(HEAD), false);
  assert.deepEqual(Object.keys(gauge).sort(), ["changedPaths", "staleBase", "truncated", "writers"]);
});

// ---------- b. integrationOf ----------

test("integrationOf accepts a valid gauge", () => {
  const value = { writers: 2, staleBase: true, changedPaths: 5, truncated: true };
  assert.deepEqual(integrationOf(value), value);
  assert.deepEqual(integrationOf({ writers: 0 }), { writers: 0 });
});

test("integrationOf returns undefined for values that are not a gauge", () => {
  for (const value of [null, "x", [], undefined, { staleBase: true }, { writers: -1 }, { writers: 1.5 }, { writers: 65 }, { writers: "2" }]) {
    assert.equal(integrationOf(value), undefined, JSON.stringify(value));
  }
});

test("integrationOf drops unknown keys, a false truncated flag, and a non-boolean staleBase", () => {
  assert.deepEqual(integrationOf({ writers: 1, paths: ["a.txt"] }), { writers: 1 });
  assert.deepEqual(integrationOf({ writers: 1, truncated: false }), { writers: 1 });
  assert.deepEqual(integrationOf({ writers: 1, staleBase: "yes" }), { writers: 1 });
  assert.deepEqual(integrationOf({ writers: 1, changedPaths: 100001 }), { writers: 1 });
});

// ---------- c. projector ----------

type Harness = { store: EvidenceStore; outbox: EventOutbox; flush(events: readonly OutboxEvent[]): void; close(): void };

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "infinite-outcome-gauges-"));
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(join(root, "state")), vaultKey: randomBytes(32) });
  store.register(configurationModule());
  store.register(outcomeModule({ now: () => at(59) }));
  const outbox = new EventOutbox(store);
  outbox.registerProjector(configurationProjector());
  outbox.registerProjector(outcomeProjector(store));
  return {
    store,
    outbox,
    flush(events) {
      const result = outbox.flush(events);
      assert.equal(result.stored, true);
      assert.equal(result.refused, 0);
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let counter = 0;
function ev(kind: string, time: string, fields: { memberId?: string; taskId?: string; revision?: number; data?: Record<string, unknown> } = {}): OutboxEvent {
  counter += 1;
  return {
    key: runEventKey(kind, RUN, [counter]),
    runId: RUN,
    revision: fields.revision ?? 1,
    at: time,
    kind,
    ...(fields.memberId === undefined ? {} : { memberId: fields.memberId }),
    ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
    data: { v: 1, ...(fields.data ?? {}) },
  };
}

function prologue(): OutboxEvent[] {
  return [
    ev("run.created", at(0), { data: { projectId: "example", purpose: "work" } }),
    ev("run.prepared", at(0), { data: { baseCommit: BASE } }),
    ev("member.started", at(1), {
      memberId: "m-a", taskId: "a",
      data: {
        role: "implementer", purpose: "work", sessionId: "session-m-a", startedAt: at(1), baseCommit: BASE,
        provider: "claude", profileId: "profile-m-1", model: "m-1", features: FEATURES,
      },
    }),
  ];
}

function integratedEvent(data: Record<string, unknown>): OutboxEvent {
  return ev("task.integrated", at(3), { memberId: "m-a", taskId: "a", data: { commit: COMMIT, headCommit: HEAD, baseCommit: BASE, memberBaseCommit: BASE, diff: DIFF, ...data } });
}

function rowOf(h: Harness) {
  return h.store.read(db => readOutcome(db, `${RUN}:m-a`));
}

test("an integration event with a gauge stores it on the row", () => {
  const h = harness();
  try {
    const gauge = { writers: 1, staleBase: true, changedPaths: 2, truncated: true };
    h.flush([...prologue(), integratedEvent({ integration: gauge })]);
    const row = rowOf(h);
    assert.deepEqual(row?.payload.integration, gauge);
    assert.equal(row?.disposition, "integrated");
  } finally { h.close(); }
});

test("an integration event without the field leaves the row as before", () => {
  const h = harness();
  try {
    h.flush([...prologue(), integratedEvent({})]);
    const row = rowOf(h);
    assert.equal("integration" in (row?.payload ?? {}), false);
    assert.deepEqual(row?.payload.diff, DIFF);
    assert.equal(row?.disposition, "integrated");
    assert.equal(row?.flags.includes("empty-result"), false);
  } finally { h.close(); }
});

test("a malformed gauge still integrates the row and stores no gauge", () => {
  const h = harness();
  try {
    h.flush([...prologue(), integratedEvent({ integration: "x" })]);
    const row = rowOf(h);
    assert.equal("integration" in (row?.payload ?? {}), false);
    assert.equal(row?.disposition, "integrated");
    assert.deepEqual(row?.payload.diff, DIFF);
  } finally { h.close(); }
});

// ---------- d. end to end through the team service ----------

type Fixture = ReturnType<typeof schedulerFixture>;

function openStore(f: Fixture): EvidenceStore {
  return new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
}

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

test("an integrated result stores the writers in flight and the path count", async () => {
  const f = schedulerFixture();
  const store = openStore(f);
  try {
    const memberId = randomUUID();
    const cwd = await prepareMemberWorkspace(f.run.workspace, memberId, f.run.baseCommit, f.config.teams?.commandPrefix);
    writeFileSync(join(cwd, "a.txt"), "one\n");
    f.run.headCommit = f.run.baseCommit;
    f.run.tasks = [
      { id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId },
      { id: "b", title: "Write b", instructions: "Write b.txt", paths: ["b.txt"], dependsOn: [], status: "running", memberId: randomUUID() },
    ];
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
    const event = allEvents(store, f.run.id).find(item => item.kind === "task.integrated");
    assert.ok(event, "task.integrated is stored");
    assert.deepEqual(event.data.integration, { writers: 1, staleBase: false, changedPaths: 1 });
    assert.equal(JSON.stringify(allEvents(store, f.run.id)).includes("a.txt"), false, "owned paths are stored only by task.planned");
  } finally { store.close(); f.close(); }
});
