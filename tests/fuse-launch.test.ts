import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { BASELINE_FILE, readBaseline } from "../packages/host/src/fuse/baseline.js";
import { isFuseReason } from "../packages/host/src/fuse/rules.js";
import { FuseService } from "../packages/host/src/fuse/service.js";
import type { FuseLaunch } from "../packages/host/src/fuse/types.js";
import { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService, providerInputReason } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { fixture, mixedLineup } from "./team-fixture.js";

const START = Date.parse("2026-11-13T10:00:00.000Z");

type Fixture = ReturnType<typeof schedulerFixture>;

/** The scheduler's private step and record, as tests/team-events.test.ts reaches them. */
const scheduler = (teams: TeamService) => teams as unknown as { record(id: string): unknown; step(stored: unknown): Promise<void> };

/** A real fuse over the fixture's evidence store, with a fake clock. */
function rig(f: Fixture) {
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
  const clock = { now: START };
  const fuse = new FuseService({ config: f.config, key: f.key, store, sessionExists: () => false, now: () => clock.now });
  return { store, clock, fuse, file: join(f.config.stateDir, BASELINE_FILE) };
}

/**
 * A fixture's own ids, commit ids, times, and temporary paths, replaced by placeholders in order of first use.
 * Two fixtures that did the same work give the same text.
 */
function normalized(text: string, f: Fixture): string {
  const names = new Map<string, string>();
  const place = (kind: string, value: string) => {
    let name = names.get(value);
    if (name === undefined) { name = `<${kind}-${names.size}>`; names.set(value, name); }
    return name;
  };
  return text
    .split(dirname(f.config.stateDir)).join("<root>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, value => place("id", value))
    .replace(/\b[0-9a-f]{40}\b/g, value => place("commit", value))
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<time>");
}

function launch(id: string, projectId = "fixture"): FuseLaunch {
  return { launchId: id, projectId, purpose: "work", role: "implementer", profileId: "spark-high" };
}

/** Trips a project with 30 launches of other sessions. */
function trip(fuse: FuseService, projectId = "fixture") {
  for (let i = 0; i < 30; i++) fuse.admit(launch(`other-${i}`, projectId));
  assert.equal(fuse.check({ projectId }).state, "open");
}

/** The fixture's run directory sits under the long temporary path; a Unix socket path must stay short. */
const shortRunDirs: string[] = [];
after(() => { for (const dir of shortRunDirs) rmSync(dir, { recursive: true, force: true }); });
function shortRun(config: Fixture["config"]) {
  const runDir = mkdtempSync("/tmp/fuse-run-");
  shortRunDirs.push(runDir);
  return { ...config, runDir };
}

/** Replaces the fake manager's running-session list. */
function setRunning(f: Fixture, rows: unknown[]) {
  (f.manager as unknown as { list: () => Promise<unknown[]> }).list = async () => rows;
}

/** One queued implementer, launched by the scheduler's next pass. */
function queueImplementer(f: Fixture) {
  const memberId = randomUUID(), sessionId = randomUUID();
  const queued = { ...f.run.members[0]!, memberId, sessionId, role: "implementer" as const, title: "Implementer: a", taskId: "a",
    provider: "opencode" as const, modelProfile: mixedLineup.implementers[0]!, status: "queued" as const, cursor: 0, prompt: "Write a.txt" };
  f.run.members = [queued];
  f.run.lineup = mixedLineup; f.run.status = "implementing"; f.run.parallelism = 2;
  f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
  f.writeTeam();
  return queued;
}

function stateOf(key: Buffer, file: string, sessionId: string) {
  const baseline = readBaseline(file, key);
  assert.ok(baseline, "the baseline file is readable");
  return baseline.launches.find(row => row.launchId === sessionId)?.state;
}

test("ten passes with capacity full leave the baseline unchanged", async () => {
  const f = schedulerFixture();
  const { store, fuse, file } = rig(f);
  try {
    const member = queueImplementer(f);
    f.writeTeam();
    const teams = f.openTeam();
    teams.useFuse(fuse);
    setRunning(f, [{ status: "running" }, { status: "running" }, { status: "running" }, { status: "running" }]);
    const before = readFileSync(file);
    for (let pass = 0; pass < 10; pass++) await scheduler(teams).step(scheduler(teams).record(f.run.id));
    await teams.idle();
    assert.equal(f.launches.length, 0);
    assert.deepEqual(readFileSync(file), before);
    assert.equal(f.readRecord<{ run: { members: { status: string }[] } }>("team", f.run.id).run.members[0]!.status, "queued");

    setRunning(f, []);
    await scheduler(teams).step(scheduler(teams).record(f.run.id));
    await teams.idle();
    assert.equal(f.launches.length, 1);
    assert.equal(fuse.view().host.hour.launches, 1);
    assert.equal(stateOf(f.key, file, member.sessionId), "admitted");

    await scheduler(teams).step(scheduler(teams).record(f.run.id));
    await teams.idle();
    assert.equal(f.launches.length, 1, "a second pass adds no launch");
    assert.equal(fuse.view().host.hour.launches, 1, "the count stays at one");
  } finally { store.close(); f.close(); }
});

test("ten passes with the fuse open change only the reason", async () => {
  const f = schedulerFixture();
  const { store, fuse, file } = rig(f);
  try {
    trip(fuse);
    queueImplementer(f);
    const teams = f.openTeam();
    teams.useFuse(fuse);
    setRunning(f, []);
    const before = readFileSync(file);
    for (let pass = 0; pass < 10; pass++) await scheduler(teams).step(scheduler(teams).record(f.run.id));
    await teams.idle();
    assert.equal(f.launches.length, 0);
    const stored = f.readRecord<{ run: { status: string; reason?: string; members: { status: string }[] }; }>("team", f.run.id).run;
    assert.equal(stored.status, "implementing");
    assert.equal(stored.members[0]!.status, "queued", "the member waits");
    assert.equal(isFuseReason(stored.reason), true);
    assert.deepEqual(readFileSync(file), before);

    assert.equal(fuse.close({ scope: "project", projectId: "fixture" }), "closed");
    await scheduler(teams).step(scheduler(teams).record(f.run.id));
    await teams.idle();
    assert.equal(f.launches.length, 1);
    assert.equal(isFuseReason(f.readRecord<{ run: { reason?: string } }>("team", f.run.id).run.reason), false);
  } finally { store.close(); f.close(); }
});

test("a member's state keeps the reason while the fuse holds a launch", async () => {
  const f = schedulerFixture();
  const { store, fuse } = rig(f);
  try {
    trip(fuse);
    // The coordinator runs and waits on a person at a provider prompt. The scheduler writes that reason from the
    // member's state on every pass, so a fuse text there would be replaced and put back each pass.
    const coordinator = f.run.members[0]!;
    f.state.attention = { state: "needs-you", prompt: { id: 1, kind: "question", title: "Which store?", options: [], acceptsText: true, source: "screen", hash: "c".repeat(64) } } as typeof f.state.attention;
    const queued = queueImplementer(f);
    f.run.members = [coordinator, queued];
    f.run.reason = providerInputReason;
    f.writeTeam();
    const teams = f.openTeam();
    teams.useFuse(fuse);
    setRunning(f, []);
    const internal = teams as unknown as { save(stored: unknown): void };
    const save = internal.save.bind(teams);
    let fuseSaves = 0;
    internal.save = (stored: unknown) => { if (new Error().stack!.includes("fuseWait")) fuseSaves += 1; return save(stored); };
    for (let pass = 0; pass < 10; pass++) await scheduler(teams).step(scheduler(teams).record(f.run.id));
    await teams.idle();
    assert.equal(f.launches.length, 0, "the launch still waits");
    assert.equal(fuseSaves, 0, "the fuse adds no save while a member's state holds the reason");
    const stored = f.readRecord<{ run: { reason?: string; members: { status: string }[] } }>("team", f.run.id).run;
    assert.equal(stored.reason, providerInputReason);
    assert.equal(stored.members[1]!.status, "queued");
  } finally { store.close(); f.close(); }
});

test("a capacity race releases and the retry counts once", async () => {
  const f = schedulerFixture();
  const { store, fuse, file } = rig(f);
  try {
    const member = queueImplementer(f);
    const teams = f.openTeam();
    teams.useFuse(fuse);
    setRunning(f, []);
    const manager = f.manager as unknown as { createTeamSession: (...args: unknown[]) => Promise<unknown> };
    const create = manager.createTeamSession;
    let refusals = 1;
    manager.createTeamSession = async (...args: unknown[]) => {
      if (refusals-- > 0) throw new Error("The configured session limit has been reached");
      return create(...args);
    };

    await scheduler(teams).step(scheduler(teams).record(f.run.id));
    await teams.idle();
    assert.equal(stateOf(f.key, file, member.sessionId), "released");
    assert.equal(fuse.view().host.hour.launches, 1);
    assert.equal(f.readRecord<{ run: { reason?: string } }>("team", f.run.id).run.reason, "Waiting for an available host session slot.");

    await scheduler(teams).step(scheduler(teams).record(f.run.id));
    await teams.idle();
    assert.equal(f.launches.length, 1);
    assert.equal(fuse.view().host.hour.launches, 1, "the retry does not count again");
  } finally { store.close(); f.close(); }
});

test("without a fuse the launch and the record are as today", async () => {
  const plain = schedulerFixture();
  const fused = schedulerFixture();
  const { store, fuse } = rig(fused);
  try {
    queueImplementer(plain);
    const plainTeams = plain.openTeam();
    setRunning(plain, []);
    await scheduler(plainTeams).step(scheduler(plainTeams).record(plain.run.id));
    await plainTeams.idle();
    assert.equal(plain.launches.length, 1);

    queueImplementer(fused);
    const fusedTeams = fused.openTeam();
    fusedTeams.useFuse(fuse);
    setRunning(fused, []);
    await scheduler(fusedTeams).step(scheduler(fusedTeams).record(fused.run.id));
    await fusedTeams.idle();
    assert.equal(fused.launches.length, 1);

    const plainRecord = plain.readRecord<{ run: Record<string, unknown>; members: unknown[] }>("team", plain.run.id).run;
    const fusedRecord = fused.readRecord<{ run: Record<string, unknown> }>("team", fused.run.id).run;
    assert.deepEqual(Object.keys(fusedRecord).sort(), Object.keys(plainRecord).sort());
    assert.deepEqual(Object.keys(fusedRecord.members[0] as object).sort(), Object.keys(plainRecord.members[0] as object).sort());
    // Keys alone would let a changed status or reason pass, so the whole records are compared, value for value.
    assert.equal(normalized(JSON.stringify(fused.readRecord("team", fused.run.id)), fused), normalized(JSON.stringify(plain.readRecord("team", plain.run.id)), plain));
    assert.equal(normalized(fused.launches[0]!.prompt, fused), normalized(plain.launches[0]!.prompt, plain), "the launch prompt is the same");
  } finally { store.close(); plain.close(); fused.close(); }
});

test("the backstop recognises an admitted launch and counts one that skipped admit", async () => {
  const f = schedulerFixture();
  const { store, fuse, file } = rig(f);
  try {
    const manager = new Manager(shortRun(f.config), f.key);
    manager.useFuse(fuse);
    const assignment = { runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "a" } as never;
    const admitted = randomUUID();
    const projectId = "fixture";
    fuse.admit(launch(admitted));
    await assert.rejects(manager.createTeamSession({ requestId: admitted, projectId, provider: "demo", title: "Write a", prompt: "Write a.txt" }, assignment, f.run.workspace),
      /Provider is not configured on this host/);
    assert.equal(stateOf(f.key, file, admitted), "released");
    assert.equal(fuse.view().host.hour.launches, 1);

    const fresh = randomUUID();
    await assert.rejects(manager.createTeamSession({ requestId: fresh, projectId, provider: "demo", title: "Write b", prompt: "Write b.txt" }, assignment, f.run.workspace),
      /Provider is not configured on this host/);
    assert.equal(fuse.view().host.hour.launches, 2);
  } finally { store.close(); f.close(); }
});

test("the backstop refuses while open and passes the permission coordinator", async () => {
  const f = schedulerFixture();
  const { store, fuse } = rig(f);
  try {
    trip(fuse);
    const manager = new Manager(shortRun(f.config), f.key);
    manager.useFuse(fuse);
    const implementer = { runId: f.run.id, memberId: randomUUID(), revision: 1, role: "implementer", taskId: "a" } as never;
    const refused = randomUUID();
    await assert.rejects(manager.createTeamSession({ requestId: refused, projectId: "fixture", provider: "demo", title: "Write a", prompt: "Write a.txt" }, implementer, f.run.workspace),
      (error: unknown) => error instanceof TeamError && error.code === "fuse-open" && error.status === 409 && isFuseReason(error.message));
    assert.equal(existsSync(join(f.config.stateDir, "sessions", refused)), false, "no session directory is created");

    const coordinator = { runId: f.run.id, memberId: randomUUID(), revision: 1, role: "permission-coordinator", taskId: "a" } as never;
    await assert.rejects(manager.createTeamSession({ requestId: randomUUID(), projectId: "fixture", provider: "demo", title: "Review", prompt: "Review" }, coordinator, f.run.workspace),
      /Provider is not configured on this host/);
  } finally { store.close(); f.close(); }
});

test("createOnce marks a created session started", { timeout: 120000 }, async () => {
  const host = await fixture("success", undefined, {}, { noServer: true });
  let store: EvidenceStore | undefined;
  try {
    const config = host.host.config;
    const key = readFileSync(config.keyFile);
    store = new EvidenceStore({ databasePath: evidenceDatabasePath(config.stateDir), vaultKey: key });
    const clock = { now: START };
    const projectId = config.projects[0]!.id;
    const fuse = new FuseService({ config, key, store, sessionExists: () => true, now: () => clock.now });
    const manager = new Manager(shortRun(config), key);
    manager.useFuse(fuse);
    const file = join(config.stateDir, BASELINE_FILE);
    const cwd = join(config.teams!.workspaceDir, randomUUID(), "integration");
    mkdirSync(cwd, { recursive: true });
    const assignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role: "implementer", taskId: "a" } as never;
    const id = randomUUID();
    const request = { requestId: id, projectId, provider: "demo" as const, title: "Write a", prompt: "Write a.txt" };
    await manager.createTeamSession(request, assignment, cwd);
    assert.equal(stateOf(key, file, id), "started");
    assert.equal(fuse.view().host.hour.launches, 1);
    fuse.release(id);
    assert.equal(stateOf(key, file, id), "started", "release leaves a started launch started");

    trip(fuse, projectId);
    const counted = fuse.view().host.hour.launches;
    assert.equal(fuse.check({ projectId }).state, "open");
    const replay = await manager.createTeamSession(request, assignment, cwd);
    assert.equal(replay.id, id, "a replay returns the session as first created");
    assert.equal(fuse.view().host.hour.launches, counted, "the replay is not charged");
  } finally {
    store?.close();
    await host.close();
  }
});
