import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import type { TeamRun } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { prepareMemberWorkspace } from "../packages/host/src/team-workspace.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;

/** Scheduler internals that the tests drive directly. */
type Internal = {
  save(stored: unknown): void;
  record(id: string): unknown;
  step(stored: unknown): Promise<void>;
  launch(stored: unknown, member: unknown): Promise<void>;
  consume(stored: unknown, member: unknown): void;
};
const internal = (teams: TeamService) => teams as unknown as Internal;

function openStore(f: Fixture, key: Buffer): EvidenceStore {
  return new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: key });
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
    const plainKeys = keyPaths(plain.readRecord("team", plain.run.id)), entryKeys = keyPaths(withEntries.readRecord("team", withEntries.run.id));
    assert.deepEqual(entryKeys, plainKeys);
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

    // The same launch without the blackboard writes a context file with the same top-level keys.
    const other = await queuedImplementer(plain);
    const plainTeams = plain.openTeam();
    const plainScheduler = internal(plainTeams);
    await plainScheduler.step(plainScheduler.record(plain.run.id));
    await plainTeams.idle();
    const plainContext = JSON.parse(readFileSync(join(other.cwd, ".git", "infinite-team-context.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(context).sort(), Object.keys(plainContext).sort());
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
