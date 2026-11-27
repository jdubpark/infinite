import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Blackboard } from "../packages/host/src/evidence/blackboard.js";
import { memberEntryId, type MemberEntryPost } from "../packages/host/src/evidence/member-entry.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import { runRecord } from "../packages/host/src/objective-record.js";
import type { ObjectiveReceipt } from "../packages/host/src/objective-receipts.js";
import { sealRecord } from "../packages/host/src/objective-write.js";
import type { Assumption, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import type { Project } from "../packages/host/src/types.js";
import type { TeamCheck, TeamCommand, TeamRun } from "../packages/host/src/team-types.js";
import type { TeamService } from "../packages/host/src/teams.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";

type Fixture = ReturnType<typeof schedulerFixture>;

type Internal = {
  record(id: string): unknown;
  ingestEntries(): void;
  save(stored: unknown): void;
};
const internal = (teams: TeamService) => teams as unknown as Internal;

type Tests = { drain(): void; idle(): Promise<void>; pending(runId: string): boolean; receipts(runId: string): ObjectiveReceipt[] | undefined };
const registerOf = (teams: TeamService) => (teams as unknown as { objectiveTests: Tests }).objectiveTests;

const FIXTURE = resolve("tests/fixtures/team-agent.mjs");
const ENTRIES = "research/entries.json";
const RANK: TeamCommand = { command: "npm", args: ["run", "rank-verify"] };
const AT = new Date().toISOString();

function openStore(f: Fixture): EvidenceStore {
  return new EvidenceStore({ databasePath: evidenceDatabasePath(f.config.stateDir), vaultKey: f.key });
}

function registerFixture(): { f: Fixture; receipts: string } {
  const f = schedulerFixture();
  const receipts = join(f.config.stateDir, "prefix");
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  f.config.teams!.commandPrefix = { command: process.execPath, args: [FIXTURE, "--command-prefix", receipts] };
  f.config.projects[0]!.team = { checks: [RANK], objective: { register: "on" } } as Project["team"];
  return { f, receipts };
}

function git(f: Fixture, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd: f.run.workspace, encoding: "utf8", stdio: "pipe" }).trim();
}

function entriesDocument(qualifying: number) {
  return { entries: Array.from({ length: 45 }, (_, index) => ({
    id: `e${index}`,
    sources: index < qualifying ? [`https://one${index}.example/a`, `https://two${index}.example/b`] : [`https://one${index}.example/a`],
  })) };
}

function commitEntries(f: Fixture, document: unknown): string {
  mkdirSync(join(f.run.workspace, "research"), { recursive: true });
  writeFileSync(join(f.run.workspace, ENTRIES), JSON.stringify(document));
  git(f, "add", "--", ENTRIES);
  git(f, "commit", "-m", "Entries");
  return git(f, "rev-parse", "HEAD");
}

function assumption(id: string, test: Assumption["test"]): Assumption {
  return { id, statement: `Assumption ${id}`, status: "unchecked", origin: "intent-check", criticality: "plan",
    refutedBy: `Refuted ${id}`, test, evidence: [], proposals: [] };
}

function recordFor(f: Fixture): ObjectiveRecord {
  const created = runRecord(f.run, AT, `run:${f.run.id}`);
  if (typeof created === "string") throw new Error(`the fixture record is ${created}`);
  return sealRecord(created, {
    assumptions: [
      assumption("a2", { kind: "artifact", path: ENTRIES, count: "/entries", citedPerEntry: 2, threshold: { kind: "count", min: 40 } }),
      assumption("a4", { kind: "command", command: commandDigest(RANK), refutesOn: "fail" }),
    ],
  }, []);
}

function seedRun(f: Fixture, head: string, record: ObjectiveRecord, options: { register?: boolean; status?: TeamRun["status"] } = {}): void {
  f.run.status = options.status ?? "ready-for-review";
  f.run.revision = 1;
  f.run.headCommit = head;
  f.run.review = { verdict: "approved", summary: "Approved.", revision: 1 } as TeamRun["review"];
  f.run.checks = [{ command: RANK, status: "failed", startedAt: AT, output: "", revision: 1, headCommit: head, round: 1 }] as TeamCheck[];
  f.run.blackboard = { tools: true };
  f.run.members[0]!.role = "reviewer";
  f.run.members[0]!.entryTools = true;
  if (options.register !== false) f.run.register = "on";
  f.writeTeam({ objectiveRecord: record, checkHead: head });
}

const finding = (summary: string, id: string, stance: "supports" | "contradicts"): MemberEntryPost => ({
  kind: "finding", summary, paths: [],
  body: { items: [{ source: ENTRIES, observation: summary }], assumption: { id, stance } },
} as unknown as MemberEntryPost);

function postEnvelope(f: Fixture, memberId: string, entry: MemberEntryPost, revision = 1) {
  const binding = { runId: f.run.id, memberId, revision };
  return { op: "post", ...binding, requestId: memberEntryId(binding, entry), entry };
}

function postFinding(f: Fixture, teams: TeamService, entry: MemberEntryPost): void {
  const reviewer = f.run.members[0]!;
  f.post(reviewer.sessionId, "team-entry", postEnvelope(f, reviewer.memberId, entry));
  internal(teams).ingestEntries();
}

const recordOf = (teams: TeamService, runId: string): ObjectiveRecord =>
  (internal(teams).record(runId) as { objectiveRecord: ObjectiveRecord }).objectiveRecord;
const assumptionOf = (record: ObjectiveRecord, id: string) => record.assumptions.find(item => item.id === id)!;

function commandLines(receipts: string): { command: string; args: string[] }[] {
  const file = join(receipts, "commands.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { command: string; args: string[] });
}

async function waitUntil(check: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

test("acceptance 5 end to end", async () => {
  const { f, receipts } = registerFixture(), store = openStore(f);
  let teams: TeamService | undefined;
  try {
    const head = commitEntries(f, entriesDocument(31));
    const record = recordFor(f);
    seedRun(f, head, record);
    teams = f.openTeam({ entries: new Blackboard(store) });

    postFinding(f, teams, finding("Only 31 entries cite two sources", "a2", "contradicts"));
    const posted = recordOf(teams, f.run.id);
    assert.equal(assumptionOf(posted, "a2").status, "unchecked");
    assert.equal(assumptionOf(posted, "a2").proposals.length, 1);

    const tests = registerOf(teams);
    tests.drain();
    await tests.idle();
    const after = recordOf(teams, f.run.id);
    assert.equal(assumptionOf(after, "a2").status, "refuted");
    assert.equal(assumptionOf(after, "a4").status, "refuted");
    const a2 = tests.receipts(f.run.id)!.find(receipt => receipt.id === "a2")!;
    assert.equal(a2.handle, `receipt:${f.run.id}:1:a2`);
    assert.deepEqual(a2.detail, { kind: "artifact", read: "read", total: 45, qualifying: 31 });
    assert.equal(after.log.filter(entry => entry.op === "test.recorded").length, 1);
    assert.equal(f.readRecord<{ run: TeamRun }>("team", f.run.id).run.status, "ready-for-review");

    const lines = commandLines(receipts);
    assert.equal(lines.length, 1, `commands: ${JSON.stringify(lines)}`);
    assert.ok(lines[0]!.args.includes("cat-file"));
    assert.equal(lines[0]!.args.at(-1), `${head}:${ENTRIES}`);
  } finally { store.close(); f.close(); }
});

test("a run that settles while the service runs gets its pass from the tick", async () => {
  const { f } = registerFixture(), store = openStore(f);
  try {
    const head = commitEntries(f, entriesDocument(31));
    seedRun(f, head, recordFor(f), { status: "integrating" });
    const teams = f.openTeam({ entries: new Blackboard(store) });
    const tests = registerOf(teams);
    assert.equal(tests.pending(f.run.id), false, "a run that has not settled has no pass at open");

    const held = internal(teams).record(f.run.id) as { run: TeamRun };
    held.run.status = "ready-for-review";
    internal(teams).save(held);
    assert.equal(tests.pending(f.run.id), true, "the save marks the pass");
    teams.start();
    await waitUntil(() => tests.receipts(f.run.id) !== undefined, "the tick runs the pass", 15000);
    await tests.idle();
    assert.equal(recordOf(teams, f.run.id).log.filter(entry => entry.op === "test.recorded").length, 1, "one test version");
  } finally { store.close(); f.close(); }
});

test("without the register a run is as today", async () => {
  const { f, receipts } = registerFixture(), store = openStore(f);
  try {
    f.config.projects[0]!.team = { checks: [RANK] } as Project["team"];
    const head = commitEntries(f, entriesDocument(31));
    const record = recordFor(f);
    seedRun(f, head, record, { register: false });
    const entries = new Blackboard(store);
    const teams = f.openTeam({ entries });
    postFinding(f, teams, finding("Only 31 entries cite two sources", "a2", "contradicts"));
    const tests = registerOf(teams);
    tests.drain();
    await tests.idle();

    const stored = internal(teams).record(f.run.id) as { objectiveRecord: ObjectiveRecord; register?: unknown };
    assert.equal(stored.register, undefined, "no Stored.register");
    assert.equal(JSON.stringify(stored.objectiveRecord), JSON.stringify(record), "the record is unchanged");
    assert.equal(entries.list(f.run.id, { kinds: ["finding"] }).entries.length, 1, "the finding is on the board");
    const sealed = f.readRecord<{ run: TeamRun }>("team", f.run.id).run;
    assert.equal(sealed.events.some(event => event.text.startsWith("Host tests") || event.text.startsWith("Member assumption")), false, "no register event");
    assert.deepEqual(commandLines(receipts), [], "no cat-file command");
    assert.equal("register" in (teams.get(f.run.id) as object), false, "no register key in the view");
  } finally { store.close(); f.close(); }
});

test("a refused blob form leaves artifact results unknown", async () => {
  const { f, receipts } = registerFixture(), store = openStore(f);
  try {
    const head = commitEntries(f, entriesDocument(31));
    seedRun(f, head, recordFor(f));
    writeFileSync(join(receipts, "refuse-cat-file"), "");
    const teams = f.openTeam({ entries: new Blackboard(store) });
    const tests = registerOf(teams);
    tests.drain();
    await tests.idle();

    const receipt = tests.receipts(f.run.id)!.find(item => item.id === "a2")!;
    assert.equal(receipt.outcome, "unknown");
    assert.deepEqual(receipt.detail, { kind: "artifact", read: "read-failed" });
    const after = recordOf(teams, f.run.id);
    assert.equal(assumptionOf(after, "a2").status, "unchecked");
    assert.equal(assumptionOf(after, "a4").status, "refuted", "command tests still apply");
  } finally { store.close(); f.close(); }
});

test("a restart while a pass reads runs it once", async () => {
  const { f, receipts } = registerFixture(), store = openStore(f);
  try {
    const head = commitEntries(f, entriesDocument(31));
    const record = recordFor(f);
    seedRun(f, head, record);
    writeFileSync(join(receipts, "hold-cat-file"), "");
    const entries = new Blackboard(store);

    const first = f.openTeam({ entries });
    registerOf(first).drain();
    await waitUntil(() => commandLines(receipts).some(line => line.args.includes("cat-file")), "the first pass starts its read");
    first.close();

    const second = f.openTeam({ entries });
    const tests = registerOf(second);
    tests.drain();
    writeFileSync(join(receipts, "release-cat-file"), "");
    await tests.idle();

    assert.equal(tests.pending(f.run.id), false, "the pass is done");
    const after = recordOf(second, f.run.id);
    assert.equal(after.log.filter(entry => entry.op === "test.recorded").length, 1, "one test version");
    assert.equal(after.version, record.version + 1);
  } finally { store.close(); f.close(); }
});

test("the view shows the pin and nothing else", async () => {
  const { f } = registerFixture(), store = openStore(f);
  try {
    const head = commitEntries(f, entriesDocument(31));
    seedRun(f, head, recordFor(f));
    const teams = f.openTeam({ entries: new Blackboard(store) });
    postFinding(f, teams, finding("Only 31 entries cite two sources", "a2", "contradicts"));
    const tests = registerOf(teams);
    tests.drain();
    await tests.idle();

    const view = teams.get(f.run.id) as unknown as Record<string, unknown>;
    assert.equal(view.register, "on");
    const text = JSON.stringify(view) as string;
    assert.equal(text.includes("receipt:"), false, "no receipt handle");
    assert.equal(text.includes("qualifying"), false, "no receipt detail");
    assert.equal(text.includes("Only 31 entries cite two sources"), false, "no proposal summary");
  } finally { store.close(); f.close(); }
});
