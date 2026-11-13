import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { prepareMemberWorkspace } from "../packages/host/src/team-workspace.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;

/** Scheduler internals that the tests drive directly. */
type Internal = {
  save(stored: unknown): void;
  record(id: string): unknown;
  step(stored: unknown): Promise<void>;
  launch(stored: unknown, member: unknown): Promise<void>;
  consume(stored: unknown, member: unknown): void;
  drainEntries(): void;
};
const internal = (teams: TeamService) => teams as unknown as Internal;

function openStore(f: Fixture, key: Buffer, busyTimeoutMs?: number): EvidenceStore {
  return new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: key, ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }) });
}

/** The bytes of the run's sealed record file. */
function recordBytes(f: Fixture, runId = f.run.id): Buffer {
  return readFileSync(join(f.config.stateDir, "teams", `${runId}.sealed`));
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

/** A settled copy of the fixture run under a new id, with one owner steering text, sealed as its own record. */
function writeSettledRun(f: Fixture, text: string): string {
  const id = randomUUID(), base = f.run.members[0]!;
  const run: TeamRun = { ...structuredClone(f.run), id, status: "cancelled",
    steering: [{ text, revision: 1, at: new Date().toISOString() }],
    members: [{ ...structuredClone(base), runId: id, memberId: randomUUID(), sessionId: randomUUID(), status: "stopped" }] };
  writeSealed(join(f.config.stateDir, "teams", `${id}.sealed`), f.key, `team:${id}`, { run, prepared: true, fingerprint: "fixture", receipts: {} });
  return id;
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

/** A member's own clone at the run's base commit, prepared as a real attempt is. */
async function memberClone(f: Fixture, memberId: string) {
  return prepareMemberWorkspace(f.run.workspace, memberId, f.run.baseCommit, f.config.teams?.commandPrefix);
}

/** Every object key path of a value, with array positions. Values are not compared. */
function keyPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => keyPaths(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => [`${path}.${key}`, ...keyPaths(item, `${path}.${key}`)]);
  }
  return [];
}

/** The project manager reports a one-task plan, as its journal would carry it. */
function reportPlan(f: Fixture) {
  const pm = f.run.members[0]!;
  f.report(pm.sessionId, { requestId: randomUUID(), runId: f.run.id, memberId: pm.memberId, revision: pm.revision,
    report: { kind: "plan", summary: "One task", tasks: [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [] }] } });
}

/** Writes the record, opens a service with the given blackboard, and runs one step over the plan report. */
async function planFlow(f: Fixture, entries?: Blackboard) {
  f.writeTeam();
  reportPlan(f);
  const teams = f.openTeam({ entries });
  const scheduler = internal(teams);
  await scheduler.step(scheduler.record(f.run.id));
  await teams.idle();
  return teams;
}

/** One queued implementer on task a, in its own clone, as a planned run holds it. */
async function queuedImplementer(f: Fixture) {
  const memberId = randomUUID(), cwd = await memberClone(f, memberId);
  const member = { ...f.run.members[0]!, memberId, sessionId: randomUUID(), role: "implementer" as const, taskId: "a", cwd,
    status: "queued" as const, prompt: "Write a.txt in your clone and report the result." };
  f.run.members = [member];
  f.run.status = "implementing";
  f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
  f.writeTeam();
  return { member, cwd };
}

test("a service without the blackboard keeps its records as today", async () => {
  const plain = schedulerFixture(), withEntries = schedulerFixture();
  const store = openStore(withEntries, withEntries.key);
  try {
    await planFlow(plain);
    await planFlow(withEntries, new Blackboard(store));
    const plainRecord = plain.readRecord("team", plain.run.id), entryRecord = withEntries.readRecord("team", withEntries.run.id);
    assert.deepEqual(keyPaths(entryRecord), keyPaths(plainRecord));
    // Keys alone would let a changed value pass, so the values are compared too.
    assert.equal(normalized(JSON.stringify(entryRecord), withEntries), normalized(JSON.stringify(plainRecord), plain));
  } finally { store.close(); plain.close(); withEntries.close(); }
});

test("a recorded report becomes a report entry at its save", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    const entries = new Blackboard(store);
    await planFlow(f, entries);
    const page = entries.list(f.run.id, { kinds: ["report"] });
    assert.equal(page.entries.length, 1);
    const [head] = page.entries;
    assert.equal(head!.author, "member");
    assert.equal(head!.authority, "claim");
    assert.equal(head!.authorRole, "project-manager");
    const body = entries.get(f.run.id, head!.entryId)!.body as { memberId: string; report: { kind: string } };
    assert.equal(body.report.kind, "plan");
    assert.equal(body.memberId, f.run.members[0]!.memberId);
  } finally { store.close(); f.close(); }
});

test("owner steering and answers become directions", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    const entries = new Blackboard(store);
    const at = new Date().toISOString(), memberId = f.run.members[0]!.memberId;
    f.run.decisions = [
      { id: "d1", memberId, revision: 1, question: "Which store?", options: [], createdAt: at },
      { id: "d2", memberId, revision: 1, question: "Which runner?", options: [], createdAt: at },
    ];
    f.writeTeam();
    const teams = f.openTeam({ entries });
    // Answers come first: a steer advances the revision that the decisions name.
    await teams.answer(f.run.id, "d1", { requestId: randomUUID(), revision: 1, text: "Use SQLite" });
    await teams.answer(f.run.id, "d2", { requestId: randomUUID(), revision: 1, text: "Use the CLI" }, undefined, "coordinator");
    await teams.steer(f.run.id, { requestId: randomUUID(), revision: 1, text: "Keep the API stable" });
    const directions = entries.list(f.run.id, { kinds: ["direction"] }).entries;
    assert.equal(directions.length, 2, "the owner answer and the owner steering; the coordinator answer is not a direction");
    const [answer, steering] = directions;
    assert.equal(answer!.author, "owner");
    assert.equal(answer!.authority, "direction");
    assert.equal(answer!.taskId, undefined);
    assert.deepEqual(entries.get(f.run.id, answer!.entryId)!.body, { source: "answer", question: "Which store?", text: "Use SQLite" });
    assert.deepEqual(entries.get(f.run.id, steering!.entryId)!.body, { source: "steering", text: "Keep the API stable" });
  } finally { store.close(); f.close(); }
});

test("an integration and a finished check become receipts", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    const entries = new Blackboard(store);
    const memberId = randomUUID(), cwd = await memberClone(f, memberId);
    writeFileSync(join(cwd, "a.txt"), "one\n");
    f.run.headCommit = f.run.baseCommit;
    f.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId }];
    const member = { ...f.run.members[0]!, memberId, role: "implementer" as const, taskId: "a", cwd, status: "reported" as const,
      report: { kind: "result" as const, summary: "Wrote a.txt" } };
    f.run.members = [member];
    f.writeTeam();
    const teams = f.openTeam({ entries });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun; pending?: unknown };
    scheduler.consume(stored, member);
    await waitFor(() => stored.pending === undefined, "the result is integrated");
    await teams.idle();
    const [integration] = entries.list(f.run.id, { kinds: ["integration"] }).entries;
    assert.ok(integration, "the integration is stored");
    const task = stored.run.tasks[0]!;
    const integrationBody = entries.get(f.run.id, integration.entryId)!.body as Record<string, unknown>;
    assert.equal(integrationBody.taskId, "a");
    assert.equal(integrationBody.commit, task.commit);
    assert.deepEqual(integrationBody.changedPaths, { paths: ["a.txt"], truncated: false });

    // The check finishes in the operation, and the save that follows it stores the receipt.
    const at = new Date().toISOString();
    stored.run.checks.push({ command: { command: "node", args: ["-e", "console.log('check-ok')"] }, status: "passed", startedAt: at,
      finishedAt: at, exitCode: 0, output: "check-ok\n", revision: stored.run.revision, round: 0, headCommit: stored.run.headCommit } as TeamRun["checks"][number]);
    scheduler.save(stored);
    const [check] = entries.list(f.run.id, { kinds: ["check"] }).entries;
    assert.ok(check, "the check is stored");
    const checkBody = entries.get(f.run.id, check.entryId)!.body as { status: string; output: string };
    assert.equal(checkBody.status, "passed");
    assert.match(checkBody.output, /check-ok/);
  } finally { store.close(); f.close(); }
});

test("a launch records its sizes and sends what it sent before", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  const plain = schedulerFixture();
  try {
    f.run.steering = [{ text: "Keep the API stable", revision: 2, at: new Date().toISOString() }];
    const entries = new Blackboard(store);
    const { member, cwd } = await queuedImplementer(f);
    const teams = f.openTeam({ entries });
    const mark = entries.launchMark(f.run.id);
    assert.equal(mark, 1, "the steering entry is stored before the launch");
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await teams.idle();
    assert.ok(f.launches.some(launch => launch.requestId === member.sessionId), "the implementer launched");

    const usage = entries.contextUsage(f.run.id);
    assert.equal(usage.length, 1);
    const [row] = usage;
    assert.equal(row!.memberId, member.memberId);
    assert.equal(row!.launchSeq, mark);
    assert.equal(row!.promptBytes, Buffer.byteLength(f.launches.at(-1)!.prompt, "utf8"));
    assert.equal(row!.contextBytes, statSync(join(cwd, ".git", "infinite-team-context.json")).size);
    assert.equal(row!.digestBytes, 0);

    const contextText = readFileSync(join(cwd, ".git", "infinite-team-context.json"), "utf8");
    const context = JSON.parse(contextText) as Record<string, unknown>;
    assert.equal(context.schemaVersion, 1);
    assert.ok("memberReports" in context);
    const launchPrompt = f.launches.at(-1)!.prompt;
    for (const text of [contextText, launchPrompt]) assert.equal(/promptBytes|contextBytes|context_bytes/.test(text), false);

    // The same launch without the blackboard writes the same context file and sends the same prompt.
    plain.run.steering = [{ text: "Keep the API stable", revision: 2, at: new Date().toISOString() }];
    const other = await queuedImplementer(plain);
    const plainTeams = plain.openTeam();
    const plainScheduler = internal(plainTeams);
    await plainScheduler.step(plainScheduler.record(plain.run.id));
    await plainTeams.idle();
    const plainContextText = readFileSync(join(other.cwd, ".git", "infinite-team-context.json"), "utf8");
    assert.equal(normalized(contextText, f), normalized(plainContextText, plain));
    assert.equal(normalized(launchPrompt, f), normalized(plain.launches.at(-1)!.prompt, plain));
  } finally { store.close(); f.close(); plain.close(); }
});

test("an unavailable store changes nothing", async () => {
  const plain = schedulerFixture(), f = schedulerFixture();
  // The store's key is fixed by its first open, so the right key opens the file before the wrong one does.
  openStore(f, f.key).close();
  const bad = openStore(f, randomBytes(32));
  try {
    await planFlow(plain);
    await planFlow(f, new Blackboard(bad));
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.status, plain.readRecord<{ run: TeamRun }>("team", plain.run.id).run.status);
    assert.equal(f.launches.length, plain.launches.length);
    bad.close();
    const good = openStore(f, f.key);
    try {
      assert.deepEqual(new Blackboard(good).contextUsage(f.run.id), [], "no scope row was written under the wrong key");
    } finally { good.close(); }
  } finally { bad.close(); f.close(); plain.close(); }
});

test("an entry missed before a crash is written after a restart", async () => {
  const f = schedulerFixture(), good = openStore(f, f.key), bad = openStore(f, randomBytes(32));
  try {
    f.writeTeam();
    reportPlan(f);
    const first = f.openTeam({ entries: new Blackboard(bad) });
    const firstScheduler = internal(first);
    await firstScheduler.step(firstScheduler.record(f.run.id));
    await first.idle();
    first.close();
    bad.close();
    const membersBefore = JSON.stringify(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.members);

    const entries = new Blackboard(good);
    assert.equal(entries.list(f.run.id, { kinds: ["report"] }).entries.length, 0, "the report entry was missed");
    f.openTeam({ entries });
    const [head] = entries.list(f.run.id, { kinds: ["report"] }).entries;
    assert.ok(head, "the restart writes the missed report entry");
    assert.equal(head.authorRole, "project-manager");
    assert.equal(JSON.stringify(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.members), membersBefore, "the restart mutates no member");
  } finally { good.close(); bad.close(); f.close(); }
});

test("a settled run's missed entries are written after a restart", async () => {
  const f = schedulerFixture(), good = openStore(f, f.key), bad = openStore(f, randomBytes(32));
  try {
    // The run settled in a save whose entry write was lost: the store was unavailable.
    f.run.status = "cancelled";
    f.run.members[0]!.status = "stopped";
    f.run.steering = [{ text: "Keep the API stable", revision: 1, at: new Date().toISOString() }];
    f.writeTeam();
    const first = f.openTeam({ entries: new Blackboard(bad) });
    internal(first).drainEntries();
    first.close();
    bad.close();
    const before = recordBytes(f);

    const entries = new Blackboard(good);
    f.openTeam({ entries });
    const [direction] = entries.list(f.run.id, { kinds: ["direction"] }).entries;
    assert.ok(direction, "the restart writes the settled run's missed entry");
    assert.deepEqual(entries.get(f.run.id, direction.entryId)!.body, { source: "steering", text: "Keep the API stable" });
    assert.deepEqual(recordBytes(f), before, "the drain saves nothing");
  } finally { good.close(); bad.close(); f.close(); }
});

test("a failed entry write is retried without a save", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key, 0);
  try {
    let clock = Date.now();
    const entries = new Blackboard(store, { now: () => clock });
    f.writeTeam();
    const teams = f.openTeam({ entries });
    const blocker = new DatabaseSync(evidenceDatabasePath(f.config.stateDir));
    try {
      blocker.exec("BEGIN IMMEDIATE");
      await teams.steer(f.run.id, { requestId: randomUUID(), revision: 1, text: "Keep the API stable" });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    await teams.idle();
    assert.equal(entries.list(f.run.id, { kinds: ["direction"] }).entries.length, 0, "the save's entry write failed");
    const before = recordBytes(f);

    // Within the minute the drain leaves the store alone.
    internal(teams).drainEntries();
    assert.equal(entries.list(f.run.id, { kinds: ["direction"] }).entries.length, 0);
    clock += 61_000;
    internal(teams).drainEntries();
    assert.equal(entries.list(f.run.id, { kinds: ["direction"] }).entries.length, 1, "the drain stores the entry");
    assert.deepEqual(recordBytes(f), before, "no save happened between the steer and the drain");
  } finally { store.close(); f.close(); }
});

test("a failing store stops the drain after one write", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key, 0);
  try {
    let clock = Date.now();
    const entries = new Blackboard(store, { now: () => clock });
    const calls: string[] = [];
    const retry = entries.retry.bind(entries);
    entries.retry = run => { const result = retry(run); calls.push(result); return result; };
    f.writeTeam();
    const settled = Array.from({ length: 6 }, (_, index) => writeSettledRun(f, `Direction ${index}`));
    // The lock is held while the service starts, so its first pass fails once and leaves every run waiting.
    const blocker = new DatabaseSync(evidenceDatabasePath(f.config.stateDir));
    let teams: TeamService;
    try {
      blocker.exec("BEGIN IMMEDIATE");
      teams = f.openTeam({ entries });
      // The fixture's own run is active, so it comes first, and it has nothing to store.
      assert.deepEqual(calls, ["done", "failed"], "the start's pass stops at its first failed write");
      clock += 61_000;
      calls.length = 0;
      const scheduler = internal(teams);
      scheduler.drainEntries();
      assert.deepEqual(calls, ["failed"], "one failed write ends the pass");
      scheduler.drainEntries();
      assert.deepEqual(calls, ["failed"], "the same minute costs nothing more");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    const scheduler = internal(teams);
    clock += 61_000;
    calls.length = 0;
    // The six settled runs wait.
    scheduler.drainEntries();
    assert.deepEqual(calls, ["done", "done", "done", "done"], "a pass retries four runs at most");
    scheduler.drainEntries();
    assert.equal(calls.length, 6);
    scheduler.drainEntries();
    assert.equal(calls.length, 6, "an empty backlog costs nothing");
    for (const id of settled) assert.equal(entries.list(id, { kinds: ["direction"] }).entries.length, 1);
  } finally { store.close(); f.close(); }
});

test("the drain stores only what the sealed record holds", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key, 0);
  try {
    let clock = Date.now();
    const entries = new Blackboard(store, { now: () => clock });
    f.writeTeam();
    const teams = f.openTeam({ entries });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun };
    // A failed entry write at a save puts the run in the backlog.
    const blocker = new DatabaseSync(evidenceDatabasePath(f.config.stateDir));
    try {
      blocker.exec("BEGIN IMMEDIATE");
      await teams.steer(f.run.id, { requestId: randomUUID(), revision: 1, text: "Saved direction" });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    await teams.idle();
    clock += 61_000;
    // The live run changes a moment before its save, as a finished check does.
    stored.run.steering.push({ text: "Unsaved direction", revision: stored.run.revision, at: new Date().toISOString() });
    scheduler.drainEntries();
    const texts = () => entries.list(f.run.id, { kinds: ["direction"] }).entries
      .map(head => (entries.get(f.run.id, head.entryId)!.body as { text: string }).text);
    assert.deepEqual(texts(), ["Saved direction"], "only the sealed direction is stored");
    scheduler.save(stored);
    assert.deepEqual(texts(), ["Saved direction", "Unsaved direction"], "the save stores the new direction");
  } finally { store.close(); f.close(); }
});

test("one failing run does not hold back the others", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    let clock = Date.now(), failing = true;
    // A store whose writes fail while the flag is set. Reads and the module registration pass through.
    const flaky = {
      status: () => store.status(),
      register: (module: Parameters<EvidenceStore["register"]>[0]) => store.register(module),
      read: <T,>(fn: Parameters<EvidenceStore["read"]>[0]) => store.read(fn) as T,
      tryWrite: (fn: Parameters<EvidenceStore["tryWrite"]>[0]) => failing ? false : store.tryWrite(fn),
    } as unknown as EvidenceStore;
    const entries = new Blackboard(flaky, { now: () => clock });
    f.writeTeam();
    const settled = writeSettledRun(f, "Settled direction");
    // The start's pass fails once, so the settled run waits.
    const teams = f.openTeam({ entries });
    assert.equal(entries.list(settled, { kinds: ["direction"] }).entries.length, 0);

    // The active run's saves keep failing, a minute apart.
    clock += 61_000;
    await teams.steer(f.run.id, { requestId: randomUUID(), revision: 1, text: "First" });
    clock += 61_000;
    await teams.steer(f.run.id, { requestId: randomUUID(), revision: 2, text: "Second" });
    await teams.idle();
    assert.equal(entries.held(f.run.id), true, "the active run's last save failed just now");

    // The store works again for everyone else, in the same minute as that failure.
    failing = false;
    internal(teams).drainEntries();
    assert.equal(entries.list(settled, { kinds: ["direction"] }).entries.length, 1, "the settled run is not held back");
    assert.equal(entries.list(f.run.id, { kinds: ["direction"] }).entries.length, 0, "the failing run waits out its own minute");
    clock += 61_000;
    internal(teams).drainEntries();
    assert.equal(entries.list(f.run.id, { kinds: ["direction"] }).entries.length, 2);
  } finally { store.close(); f.close(); }
});

test("removing a run removes its entries", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    const entries = new Blackboard(store);
    f.run.status = "cancelled";
    f.run.members[0]!.status = "stopped";
    f.run.steering = [{ text: "Keep the API stable", revision: 2, at: new Date().toISOString() }];
    f.writeTeam();
    const teams = f.openTeam({ entries });
    teams.useEvidence(store);
    assert.equal(entries.mirror(f.run), true);
    const pm = f.run.members[0]!;
    assert.equal(entries.recordLaunch(f.run, pm, { launchSeq: entries.launchMark(f.run.id), promptBytes: 1, contextBytes: 1 }), true);
    assert.equal(entries.list(f.run.id).entries.length, 1);
    assert.equal(entries.contextUsage(f.run.id).length, 1);

    await teams.removeRun(f.run.id);
    assert.deepEqual(entries.list(f.run.id).entries, []);
    assert.deepEqual(entries.contextUsage(f.run.id), []);
  } finally { store.close(); f.close(); }
});
