import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import { ENTRY_NOTICE } from "../packages/host/src/evidence/entry-reads.js";
import { memberEntryId, type MemberEntryPost } from "../packages/host/src/evidence/member-entry.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { ENTRY_DROP_TEXT, ENTRY_INGEST_MEMBERS } from "../packages/host/src/team-entry-ingest.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { entryInstructions } from "../packages/host/src/team-prompts.js";
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
  ingestEntries(): void;
  newMember(run: TeamRun, role: string, cwd: string, baseCommit: string, taskId?: string): unknown;
  replaceStalledMember(stored: unknown, member: unknown): Promise<void>;
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

test("a record that cannot be read for a while keeps its run in the backlog", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key, 0);
  try {
    let clock = Date.now();
    const entries = new Blackboard(store, { now: () => clock });
    f.writeTeam();
    const teams = f.openTeam({ entries });
    // A failed entry write at a save puts the run in the backlog. No later save of the run follows.
    const blocker = new DatabaseSync(evidenceDatabasePath(f.config.stateDir));
    try {
      blocker.exec("BEGIN IMMEDIATE");
      await teams.steer(f.run.id, { requestId: randomUUID(), revision: 1, text: "Keep the API stable" });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    await teams.idle();
    clock += 61_000;
    const stored = () => entries.list(f.run.id, { kinds: ["direction"] }).entries.length;

    const file = join(f.config.stateDir, "teams", `${f.run.id}.sealed`);
    const before = recordBytes(f);
    // The record file is missing during one pass. Nothing of the host removed it: a removal leaves through deleteRecord.
    renameSync(file, `${file}.aside`);
    try { internal(teams).drainEntries(); }
    finally { renameSync(`${file}.aside`, file); }
    assert.equal(stored(), 0);

    // The record reads again, and the drain leaves it alone for a minute.
    internal(teams).drainEntries();
    assert.equal(stored(), 0, "the drain waits before it reads the record again");

    // The next read fails another way, as under a descriptor limit or a disk fault: a folder stands in the file's place.
    clock += 61_000;
    renameSync(file, `${file}.aside`);
    mkdirSync(file);
    try { internal(teams).drainEntries(); }
    finally { rmdirSync(file); renameSync(`${file}.aside`, file); }
    assert.equal(stored(), 0);

    // After another minute the record reads, and the drain stores the entry without a save.
    clock += 61_000;
    internal(teams).drainEntries();
    assert.equal(stored(), 1, "the run kept its place in the backlog through both failed reads");
    assert.deepEqual(recordBytes(f), before, "the drain saves nothing");
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

/** A contract of the project manager, as the worker's post carries it. */
const contract = (summary: string): MemberEntryPost => ({ kind: "contract", summary, paths: [],
  body: { interface: `Interface ${summary}`, change: `Change ${summary}`, sources: [] } });

/** A post envelope with the content identity the worker recomputes. */
function postEnvelope(f: Fixture, memberId: string, entry: MemberEntryPost, revision = 1) {
  const binding = { runId: f.run.id, memberId, revision };
  return { op: "post", ...binding, requestId: memberEntryId(binding, entry), entry };
}

/** The run pins the tools and the project manager holds them, as a run created with the switch on does. */
function toolsOn(f: Fixture) {
  f.run.blackboard = { tools: true };
  f.run.members[0]!.entryTools = true;
}

function storedRows(f: Fixture, runId: string): number {
  const db = new DatabaseSync(evidenceDatabasePath(f.config.stateDir));
  try { return (db.prepare("SELECT count(*) AS n FROM entries WHERE run_id=?").get(runId) as { n: number }).n; }
  finally { db.close(); }
}

/** Sets every member's entry cursor back to zero in the sealed record, as a crash before the saves would leave it. */
function resetEntryCursors(f: Fixture) {
  const sealed = f.readRecord<{ run: TeamRun }>("team", f.run.id);
  for (const member of sealed.run.members) member.entryCursor = 0;
  writeSealed(join(f.config.stateDir, "teams", `${f.run.id}.sealed`), f.key, `team:${f.run.id}`, sealed);
}

/** The project manager stalls and its replacement is queued. With `ingestBefore`, the post is stored before the stall. */
async function replacedProjectManager(f: Fixture, entries: Blackboard, ingestBefore: boolean) {
  const teams = f.openTeam({ entries });
  const scheduler = internal(teams);
  const stored = scheduler.record(f.run.id) as { run: TeamRun; pending?: unknown };
  const member = stored.run.members[0]!;
  if (ingestBefore) scheduler.ingestEntries();
  member.stalledAt = new Date(Date.now() - 6 * 60000).toISOString();
  member.stoppedReason = "No activity for 5 minutes";
  f.state.status = "exited";
  await scheduler.replaceStalledMember(stored, member);
  await waitFor(() => stored.pending === undefined, "the replacement is queued");
  await teams.idle();
  const replacement = f.readRecord<{ run: TeamRun }>("team", f.run.id).run.members.find(item => item.memberId !== member.memberId)!;
  if (!f.launches.some(launch => launch.requestId === replacement.sessionId)) {
    await scheduler.step(stored);
    await teams.idle();
  }
  if (!ingestBefore) scheduler.ingestEntries();
  return { member, replacement };
}

test("a run pins the tools only when the switch is on and the store is ready", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  f.config.agents = { demo: { command: process.execPath, args: [] } };
  f.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] } as never;
  const request = () => ({ requestId: randomUUID(), projectId: "fixture", provider: "demo", title: "Inspect the fixture",
    objective: "Ask before choosing work", parallelism: 1 }) as never;
  try {
    f.config.teams = { ...f.config.teams!, blackboard: { tools: true } };
    const teams = f.openTeam({ entries: new Blackboard(store) });
    const pinned = await teams.create(request());
    assert.deepEqual(f.readRecord<{ run: TeamRun }>("team", pinned.id).run.blackboard, { tools: true });

    f.config.teams = { ...f.config.teams!, blackboard: { tools: false } };
    const later = await teams.create(request());
    assert.equal("blackboard" in f.readRecord<{ run: TeamRun }>("team", later.id).run, false, "the switch is off for this run");
    assert.deepEqual(f.readRecord<{ run: TeamRun }>("team", pinned.id).run.blackboard, { tools: true }, "turning the switch off keeps the pin");
  } finally { store.close(); f.close(); }

  const absent = schedulerFixture(), ready = openStore(absent, absent.key), wrong = openStore(absent, randomBytes(32));
  try {
    const teams = absent.openTeam({ entries: new Blackboard(ready) });
    absent.config.agents = { demo: { command: process.execPath, args: [] } };
    absent.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] } as never;
    const view = await teams.create(request());
    assert.equal("blackboard" in absent.readRecord<{ run: TeamRun }>("team", view.id).run, false, "no switch, no pin");
  } finally { ready.close(); wrong.close(); absent.close(); }

  const unready = schedulerFixture();
  openStore(unready, unready.key).close();
  const bad = openStore(unready, randomBytes(32));
  try {
    unready.config.agents = { demo: { command: process.execPath, args: [] } };
    unready.config.projects[0]!.team = { checks: [{ command: process.execPath, args: ["-e", "0"] }] } as never;
    unready.config.teams = { ...unready.config.teams!, blackboard: { tools: true } };
    const teams = unready.openTeam({ entries: new Blackboard(bad) });
    const view = await teams.create(request());
    assert.equal("blackboard" in unready.readRecord<{ run: TeamRun }>("team", view.id).run, false, "a wrong-key store does not pin");
  } finally { bad.close(); unready.close(); }
});

test("with the tools on, a launch carries the digest, the flag, and the paragraph", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    f.run.blackboard = { tools: true };
    f.writeTeam();
    const entries = new Blackboard(store);
    const teams = f.openTeam({ entries });
    const scheduler = internal(teams);
    const stored = scheduler.record(f.run.id) as { run: TeamRun };
    stored.run.status = "implementing";
    // The member is built by the service's own newMember, so the entry paragraph and the flag come from production code.
    const implementer = scheduler.newMember(stored.run, "implementer", "", stored.run.baseCommit, "a") as { memberId: string; cwd: string; sessionId: string; entryTools?: true; prompt: string };
    implementer.cwd = await memberClone(f, implementer.memberId);
    assert.equal(implementer.entryTools, true);
    stored.run.tasks = [{ id: "a", title: "Write a", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [], status: "running", memberId: implementer.memberId }];
    // The fixture's one worker slot is free only when the project manager is not counted.
    stored.run.members = [implementer as TeamRun["members"][number]];
    scheduler.save(stored);
    const mark = entries.launchMark(f.run.id);
    await scheduler.step(stored);
    await teams.idle();
    assert.ok(f.launches.some(launch => launch.requestId === implementer.sessionId), "the implementer launched");

    const context = JSON.parse(readFileSync(join(implementer.cwd, ".git", "infinite-team-context.json"), "utf8")) as Record<string, unknown>;
    const digest = context.entries as { notice: string; cursor: number };
    assert.equal(digest.notice, ENTRY_NOTICE);
    assert.equal(digest.cursor, mark);
    assert.equal((context.assignment as { entryTools?: boolean }).entryTools, true);
    const usage = entries.contextUsage(f.run.id).find(row => row.memberId === implementer.memberId)!;
    assert.equal(usage.digestBytes, Buffer.byteLength(canonicalJson(context.entries), "utf8"));
    const prompt = f.launches.find(launch => launch.requestId === implementer.sessionId)!.prompt;
    assert.ok(prompt.includes(entryInstructions("demo")), "the launch prompt carries the entry paragraph");

    // The member was created after the service loaded, so only its launch can have put it in the ingest queue.
    f.post(implementer.sessionId, "team-entry", postEnvelope(f, implementer.memberId, contract("after the launch")));
    scheduler.ingestEntries();
    assert.equal(entries.list(f.run.id, { kinds: ["contract"] }).entries.length, 1, "a member launched in this process is read without a restart");
  } finally { store.close(); f.close(); }
});

test("member posts reach the board on the next pass and once", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    toolsOn(f);
    f.writeTeam();
    const entries = new Blackboard(store);
    const teams = f.openTeam({ entries });
    const pm = f.run.members[0]!;
    f.post(pm.sessionId, "team-entry", postEnvelope(f, pm.memberId, contract("one")));
    internal(teams).ingestEntries();
    const [head] = entries.list(f.run.id, { kinds: ["contract"] }).entries;
    assert.ok(head, "the post is stored");
    assert.equal(head.author, "member");
    assert.equal(head.authority, "claim");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.members[0]!.entryCursor, f.journal.seq);

    resetEntryCursors(f);
    const again = f.openTeam({ entries });
    internal(again).ingestEntries();
    assert.equal(entries.list(f.run.id, { kinds: ["contract"] }).entries.length, 1, "a second pass stores no second row");
  } finally { store.close(); f.close(); }
});

test("a post that does not match its member is dropped and counted", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    toolsOn(f);
    f.writeTeam();
    const entries = new Blackboard(store);
    const teams = f.openTeam({ entries });
    const pm = f.run.members[0]!;
    const otherMember = randomUUID();
    f.post(pm.sessionId, "team-entry", postEnvelope(f, otherMember, contract("other member")));
    // A handoff parses, but the project manager's role holds no handoffs.
    f.post(pm.sessionId, "team-entry", postEnvelope(f, pm.memberId, { kind: "handoff", summary: "not allowed", paths: [], taskId: "a",
      body: { done: [], remaining: [], commands: [] } }));
    f.post(pm.sessionId, "team-entry", { ...postEnvelope(f, pm.memberId, contract("bad id")), requestId: randomUUID() });
    internal(teams).ingestEntries();
    assert.equal(storedRows(f, f.run.id), 0, "no row is stored");
    assert.equal(store.describe().counts["blackboard.invalid"], 3);
  } finally { store.close(); f.close(); }
});

test("the run limit drops posts and says so once", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    toolsOn(f);
    f.writeTeam();
    const entries = new Blackboard(store);
    const teams = f.openTeam({ entries });
    const scheduler = internal(teams);
    const pm = f.run.members[0]!;
    for (let i = 0; i < 402; i++) f.post(pm.sessionId, "team-entry", postEnvelope(f, pm.memberId, contract(`post ${i}`)));
    for (let pass = 0; pass < 3; pass++) scheduler.ingestEntries();
    assert.equal(storedRows(f, f.run.id), 400);
    assert.equal(store.describe().counts["blackboard.dropped"], 2);
    const lines = () => f.readRecord<{ run: TeamRun }>("team", f.run.id).run.events.filter(event => event.text === ENTRY_DROP_TEXT).length;
    assert.equal(lines(), 1);

    f.post(pm.sessionId, "team-entry", postEnvelope(f, pm.memberId, contract("one more")));
    scheduler.ingestEntries();
    assert.equal(lines(), 1, "a later drop adds no second line");
  } finally { store.close(); f.close(); }
});

test("read receipts reach context usage once", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    f.run.blackboard = { tools: true };
    const entries = new Blackboard(store);
    const { member } = await queuedImplementer(f);
    member.entryTools = true;
    f.writeTeam();
    const teams = f.openTeam({ entries });
    const scheduler = internal(teams);
    await scheduler.step(scheduler.record(f.run.id));
    await teams.idle();
    f.post(member.sessionId, "team-entry-read", { op: "list", servedBytes: 300 });
    f.post(member.sessionId, "team-entry-read", { op: "get", servedBytes: 1000 });
    scheduler.ingestEntries();
    const row = () => entries.contextUsage(f.run.id).find(usage => usage.memberId === member.memberId)!;
    assert.equal(row().listCalls, 1);
    assert.equal(row().getCalls, 1);
    assert.equal(row().servedBytes, 1300);

    resetEntryCursors(f);
    const again = f.openTeam({ entries });
    internal(again).ingestEntries();
    assert.equal(row().listCalls, 1, "a second pass counts no receipt twice");
    assert.equal(row().getCalls, 1);
    assert.equal(row().servedBytes, 1300);
  } finally { store.close(); f.close(); }
});

test("a replacement sees its predecessor's posts", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    toolsOn(f);
    f.writeTeam();
    const entries = new Blackboard(store);
    const pm = f.run.members[0]!;
    f.post(pm.sessionId, "team-entry", postEnvelope(f, pm.memberId, contract("before the stall")));
    const { replacement } = await replacedProjectManager(f, entries, true);
    const context = JSON.parse(readFileSync(join(replacement.cwd, ".git", "infinite-team-context.json"), "utf8")) as { entries: { heads: { kind: string; authorRole: string }[] } };
    assert.ok(context.entries.heads.some(head => head.kind === "contract" && head.authorRole === "project-manager"));
  } finally { store.close(); f.close(); }

  const late = schedulerFixture(), lateStore = openStore(late, late.key);
  try {
    toolsOn(late);
    late.writeTeam();
    const entries = new Blackboard(lateStore);
    const pm = late.run.members[0]!;
    late.post(pm.sessionId, "team-entry", postEnvelope(late, pm.memberId, contract("after the launch")));
    await replacedProjectManager(late, entries, false);
    assert.ok(entries.list(late.run.id, { kinds: ["contract"] }).entries.some(head => head.authorRole === "project-manager"),
      "the predecessor's post is stored after the replacement launched");
  } finally { lateStore.close(); late.close(); }
});

test("a deleted run ingests nothing", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    toolsOn(f);
    f.run.status = "cancelled";
    f.run.members[0]!.status = "stopped";
    f.writeTeam();
    const entries = new Blackboard(store);
    const teams = f.openTeam({ entries });
    const pm = f.run.members[0]!;
    f.post(pm.sessionId, "team-entry", postEnvelope(f, pm.memberId, contract("deleted")));
    await teams.removeRun(f.run.id);
    const reads = f.reads();
    internal(teams).ingestEntries();
    assert.equal(f.reads(), reads, "no journal is read");
    assert.equal(storedRows(f, f.run.id), 0);
  } finally { store.close(); f.close(); }
});

test("a service without tools reads no extra journal page", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    f.writeTeam();
    const entries = new Blackboard(store);
    const pm = f.run.members[0]!;
    f.post(pm.sessionId, "team-entry", postEnvelope(f, pm.memberId, contract("no switch")));
    const teams = f.openTeam({ entries });
    const reads = f.reads();
    internal(teams).ingestEntries();
    assert.equal(f.reads(), reads);
    assert.equal(storedRows(f, f.run.id), 0);
  } finally { store.close(); f.close(); }
});

test("a silent member costs no store write and no save", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    toolsOn(f);
    // The coordinator's journal holds one event that is not an entry event, so its end is past zero.
    f.post(f.run.members[0]!.sessionId, "team-usage" as never, {});
    f.writeTeam();
    const entries = new Blackboard(store);
    let ingests = 0;
    const ingest = entries.ingest.bind(entries);
    entries.ingest = (...args: Parameters<Blackboard["ingest"]>) => { ingests++; return ingest(...args); };
    const teams = f.openTeam({ entries });
    const bytes = recordBytes(f);
    const scheduler = internal(teams);
    scheduler.ingestEntries();
    scheduler.ingestEntries();
    const member = (scheduler.record(f.run.id) as { run: TeamRun }).run.members[0]!;
    assert.equal(member.entryCursor, f.journal.seq, "the in-memory cursor is at the journal's end");
    assert.equal(ingests, 0, "Blackboard.ingest was not called");
    assert.deepEqual(recordBytes(f), bytes, "the run was not saved");
  } finally { store.close(); f.close(); }
});

test("an unavailable store keeps posts waiting", async () => {
  const f = schedulerFixture();
  openStore(f, f.key).close();
  const bad = openStore(f, randomBytes(32));
  try {
    toolsOn(f);
    const pm = f.run.members[0]!;
    // A second member, stopped in a blocked run, whose journal holds one non-entry event and no entry event.
    const quietId = randomUUID(), quietSession = randomUUID();
    await f.manager.createTeamSession({ requestId: quietSession, provider: "demo", title: "Quiet", prompt: "Wait" } as never,
      { runId: f.run.id, memberId: quietId, revision: 1, role: "reviewer" }, pm.cwd);
    f.post(quietSession, "team-usage" as never, {});
    f.run.members.push({ ...structuredClone(pm), memberId: quietId, sessionId: quietSession, role: "reviewer", status: "stopped", entryTools: true, cursor: 0 });
    f.run.status = "blocked";
    f.writeTeam();
    f.post(pm.sessionId, "team-entry", postEnvelope(f, pm.memberId, contract("waiting")));
    const teams = f.openTeam({ entries: new Blackboard(bad) });
    const scheduler = internal(teams);
    const before = f.reads();
    scheduler.ingestEntries();
    assert.equal(f.reads() - before, 2, "both members are read on the first pass");
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.members[0]!.entryCursor ?? 0, 0);
    const quiet = (scheduler.record(f.run.id) as { run: TeamRun }).run.members.find(member => member.memberId === quietId)!;
    assert.equal(quiet.entryCursor, 1, "the silent member's cursor moves although the store is unavailable");
    const second = f.reads();
    scheduler.ingestEntries();
    assert.equal(f.reads() - second, 1, "a stopped member of a blocked run leaves the pending set; only the poster is read");
    bad.close();

    const good = openStore(f, f.key);
    try {
      const entries = new Blackboard(good);
      const later = f.openTeam({ entries });
      internal(later).ingestEntries();
      assert.equal(entries.list(f.run.id, { kinds: ["contract"] }).entries.length, 1);
    } finally { good.close(); }
  } finally { bad.close(); f.close(); }
});

test("a pass reads a bounded number of journals", async () => {
  const f = schedulerFixture(), store = openStore(f, f.key);
  try {
    f.run.blackboard = { tools: true };
    const base = f.run.members[0]!;
    f.run.members = [];
    for (let i = 0; i < 40; i++) {
      const memberId = randomUUID(), sessionId = randomUUID();
      await f.manager.createTeamSession({ requestId: sessionId, provider: "demo", title: "Reviewer", prompt: "Review" } as never,
        { runId: f.run.id, memberId, revision: 1, role: "reviewer" }, base.cwd);
      f.run.members.push({ ...structuredClone(base), memberId, sessionId, role: "reviewer", entryTools: true, cursor: 0 });
    }
    f.writeTeam();
    const teams = f.openTeam({ entries: new Blackboard(store) });
    const scheduler = internal(teams);
    const seen = new Set<string>();
    const events = f.manager.events;
    f.manager.events = (id, after, limit, types) => { seen.add(id); return events(id, after, limit, types); };
    for (let pass = 0; pass < 3; pass++) {
      const before = f.reads();
      scheduler.ingestEntries();
      assert.equal(f.reads() - before, ENTRY_INGEST_MEMBERS, `pass ${pass + 1} reads ${ENTRY_INGEST_MEMBERS} journals`);
    }
    assert.equal(seen.size, 40, "three passes reach all 40 members");
  } finally { store.close(); f.close(); }
});
