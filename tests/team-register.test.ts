import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson } from "../packages/host/src/evidence/crypto.js";
import type { MemberPostRecord } from "../packages/host/src/evidence/blackboard.js";
import type { BlobReader, StreamRead } from "../packages/host/src/git-stream.js";
import { commandDigest } from "../packages/host/src/objective-input.js";
import type { GoalRecordPort } from "../packages/host/src/objective-intent.js";
import { goalRecord, REGISTER_OPS } from "../packages/host/src/objective-record.js";
import type { ObjectiveState } from "../packages/host/src/objective-record.js";
import { sealRecord } from "../packages/host/src/objective-write.js";
import type { Assumption, Criterion, ObjectiveRecord } from "../packages/host/src/objective-types.js";
import { REGISTER_EVENTS, TeamRegister } from "../packages/host/src/team-register.js";
import type { RegisterHolder, RegisterHost } from "../packages/host/src/team-register.js";
import type { TeamCheck, TeamCommand, TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";

const HEAD = "1".repeat(40);
const OTHER = "2".repeat(40);
const AT = "2026-11-18T00:00:00.000Z";
const GOAL_ID = "6f1c2a3e-8b4d-4c5e-9f60-718293a4b5c6";
const RUN = "run-1";
const ENTRIES = "research/entries.json";
const RANK: TeamCommand = { command: "npm", args: ["run", "rank-verify"] };
const TESTS: TeamCommand = { command: "npm", args: ["test"] };
const CONFIGURED = [RANK, TESTS];
const MEMBER = { memberId: "m1", role: "reviewer" } as unknown as TeamMember;

type Ev = { runId: string; text: string };

/** The fake goal record port. `unavailable` and `failWrites` script the two skip paths. */
class Port implements GoalRecordPort {
  records = new Map<string, ObjectiveRecord>();
  unavailable = false;
  failWrites = false;
  read(goalId: string): ObjectiveState {
    if (this.unavailable) return { kind: "unavailable", reason: "record-invalid" };
    const record = this.records.get(goalId);
    return record ? { kind: "ready", record } : { kind: "absent" };
  }
  write(goalId: string, expected: number, next: ObjectiveRecord): void {
    if (this.failWrites) throw new Error("disk full");
    if (this.records.get(goalId)?.version !== expected) throw new Error("version stale");
    this.records.set(goalId, next);
  }
}

/** The fake blob reader. `stallFirst` counts the first reads as stalled; `onRead` runs inside a read, after it starts. */
class Reader implements BlobReader {
  calls: string[] = [];
  files = new Map<string, StreamRead>();
  stallFirst = 0;
  stalls = 0;
  onRead?: () => void;
  async read(_cwd: string, commit: string, path: string): Promise<StreamRead> {
    const key = `${commit}:${path}`;
    this.calls.push(key);
    if (this.calls.length <= this.stallFirst) this.stalls += 1;
    this.onRead?.();
    await Promise.resolve();
    return this.files.get(key) ?? { state: "failed" };
  }
  stalled(): number {
    return this.stalls;
  }
}

/** One simulated host: the holders, the events, the clock, and the register built on them. `w.holders` is read at each call, so a restart can replace it. */
type World = { holders: Map<string, RegisterHolder>; events: Ev[]; clock: { ms: number }; port: Port; reader: Reader; register: TeamRegister };

function makeRegister(w: World): TeamRegister {
  const host: RegisterHost = {
    holder: id => w.holders.get(id),
    configured: () => CONFIGURED,
    workspace: () => "integration-checkout",
    enqueue: work => {
      const next = chain.then(() => work());
      chain = next.catch(() => undefined);
      return next;
    },
    save: () => undefined,
    event: (holder, text) => { w.events.push({ runId: holder.run.id, text }); },
    prefix: () => undefined,
    now: () => new Date(w.clock.ms).toISOString(),
  };
  let chain: Promise<void> = Promise.resolve();
  const register = new TeamRegister(host, w.reader);
  register.goals = w.port;
  return register;
}

function world(port = new Port(), reader = new Reader()): World {
  const w: World = { holders: new Map(), events: [], clock: { ms: Date.parse(AT) }, port, reader, register: undefined as unknown as TeamRegister };
  w.register = makeRegister(w);
  return w;
}

function goalFixture(): ProductGoal {
  return {
    id: GOAL_ID,
    objective: "Find ranked sources for the research brief.",
    successCriteria: "A ranked shortlist with reasons and sources",
    nonGoals: ["no paid sources"],
    allowedPaths: ["research"],
    evidence: ["notes.md"],
    steering: [],
  } as unknown as ProductGoal;
}

/** The goal's record at version 1, with the given assumptions and criteria. Its log keeps the creation entry only. */
function baseRecord(assumptions: Assumption[] = [], criteria: Criterion[] = []): ObjectiveRecord {
  const created = goalRecord(goalFixture(), AT, "created");
  if (typeof created === "string") throw new Error(`the fixture record is ${created}`);
  return sealRecord(created, { assumptions, criteria: [...created.criteria, ...criteria] }, []);
}

/** An artifact test that passes when `ENTRIES` holds at least `min` entries. */
function artifactAssumption(id: string, path: string, min: number): Assumption {
  return {
    id, statement: `Assumption ${id}`, status: "assumed", origin: "intent-check", criticality: "plan",
    refutedBy: "Too few entries", test: { kind: "artifact", path, count: "/entries", threshold: { kind: "count", min } },
    evidence: [], proposals: [],
  };
}

/** A command test on the configured `rank-verify` check. */
function commandAssumption(id: string, refutesOn: "fail" | "pass"): Assumption {
  return {
    id, statement: `Assumption ${id}`, status: "assumed", origin: "intent-check", criticality: "plan",
    refutedBy: "The check fails", test: { kind: "command", command: commandDigest(RANK), refutesOn }, evidence: [], proposals: [],
  };
}

function check(status: TeamCheck["status"], revision: number, headCommit = HEAD): TeamCheck {
  return { command: RANK, status, startedAt: AT, output: "", revision, headCommit, round: 1 };
}

/** A run at `ready-for-review` on HEAD, approved at revision 1, with a failed `rank-verify` at revision 1. */
function runOf(parts: Record<string, unknown> = {}): TeamRun {
  return {
    id: RUN, goal: { id: GOAL_ID }, status: "ready-for-review", revision: 1, headCommit: HEAD,
    review: { verdict: "approved", summary: "Approved.", revision: 1 }, checks: [check("failed", 1)], register: "on", members: [],
    ...parts,
  } as unknown as TeamRun;
}

/** A holder for `run`, with the run's check head at its head commit and the record in the port. */
function holderOf(w: World, run: TeamRun, record: ObjectiveRecord): RegisterHolder {
  w.port.records.set(GOAL_ID, record);
  const holder: RegisterHolder = { run, checkHead: HEAD };
  w.holders.set(run.id, holder);
  return holder;
}

function json(value: unknown): StreamRead {
  return { state: "read", bytes: Buffer.from(JSON.stringify(value)) };
}

function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest("hex");
}

/** The first top-level key whose canonical JSON differs, for a short failure message. */
function firstDiff(left: ObjectiveRecord, right: ObjectiveRecord): string {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.find(key => canonicalJson((left as unknown as Record<string, unknown>)[key] ?? null) !== canonicalJson((right as unknown as Record<string, unknown>)[key] ?? null)) ?? "none";
}

test("a settled revision gets one pass", async () => {
  const w = world();
  const record = baseRecord([artifactAssumption("a2", ENTRIES, 2), commandAssumption("a4", "fail")]);
  const holder = holderOf(w, runOf(), record);
  w.reader.files.set(`${HEAD}:${ENTRIES}`, json({ entries: [{ id: "e1" }] }));

  // Due at ready-for-review on the reviewed head: one pending reviewed pass. The save that marks it writes it.
  w.register.mark(holder);
  assert.equal(holder.register?.pass?.kind, "reviewed", "a settled revision on the reviewed head is a reviewed pass");
  assert.equal(holder.register?.pass?.state, "pending", "the mark leaves one pending pass");
  assert.equal(w.register.pending(RUN), true, "the pass is pending before the tick");

  w.register.drain();
  await w.register.idle();
  assert.deepEqual(w.reader.calls, [`${HEAD}:${ENTRIES}`], "each planned blob is read once: the command test reads nothing");
  const pass = holder.register?.pass;
  assert.equal(pass?.state, "done", "the pass ends done");
  assert.equal(pass?.wrote, 2, "the apply writes the record one version up");
  assert.equal(pass?.receipts?.length, 2, "one receipt per subject");
  assert.equal(w.port.records.get(GOAL_ID)?.version, 2, "the goal record is at version 2");
  assert.equal(w.events.length, 1, "a finished pass adds one event");
  assert.equal(w.events[0]?.text, REGISTER_EVENTS.recorded(1, { pass: 0, fail: 2, unknown: 0, changed: 2 }), "the event carries counts only");

  // The same revision and kind again: no second pass, and no read.
  const first = holder.register?.pass;
  holder.run.status = "merged";
  w.register.mark(holder);
  w.register.drain();
  await w.register.idle();
  assert.equal(holder.register?.pass, first, "a second mark at merged adds no pass");
  assert.equal(w.reader.calls.length, 1, "no second read");
  assert.equal(w.port.records.get(GOAL_ID)?.version, 2, "no second write");

  // A blocked revision with a check entry gets a check pass, which reads nothing.
  holder.run.status = "blocked";
  holder.run.revision = 2;
  holder.run.checks.push(check("failed", 2));
  holder.run.review = undefined;
  holder.checkHead = undefined;
  w.register.mark(holder);
  assert.equal(holder.register?.pass?.kind, "check", "a blocked revision with checks is a check pass");
  w.register.drain();
  await w.register.idle();
  assert.equal(holder.register?.pass?.state, "done", "the check pass ends done");
  assert.equal(w.reader.calls.length, 1, "a check pass reads nothing");

  // The same revision is then reviewed on its head: a reviewed pass follows the check pass.
  holder.run.status = "ready-for-review";
  holder.run.review = { verdict: "approved", summary: "Approved.", revision: 2 };
  holder.checkHead = HEAD;
  w.register.mark(holder);
  assert.equal(holder.register?.pass?.kind, "reviewed", "a reviewed pass follows a check pass of the same revision");
  w.register.drain();
  await w.register.idle();
  assert.equal(holder.register?.pass?.state, "done", "the reviewed pass ends done");

  // An unpinned run gets no pass.
  const plain = runOf({ id: "run-plain", register: undefined });
  const plainHolder: RegisterHolder = { run: plain, checkHead: HEAD };
  w.register.mark(plainHolder);
  assert.equal(plainHolder.register?.pass, undefined, "an unpinned run gets no pass");

  // A run that has not settled gets no pass, and neither does a settled revision with no check at that revision.
  const busyHolder: RegisterHolder = { run: runOf({ id: "run-busy", status: "implementing" }), checkHead: HEAD };
  w.register.mark(busyHolder);
  assert.equal(busyHolder.register?.pass, undefined, "a run that has not settled gets no pass");
  const unchecked = runOf({ id: "run-unchecked", revision: 2, review: { verdict: "approved", summary: "Approved.", revision: 2 } });
  const uncheckedHolder: RegisterHolder = { run: unchecked, checkHead: HEAD };
  w.register.mark(uncheckedHolder);
  assert.equal(uncheckedHolder.register?.pass, undefined, "a revision without a check at that revision gets no pass");
});

test("a pass never outlives its run or its revision", async () => {
  // The holder is removed while the pass reads: nothing is written and no event is added.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a2", ENTRIES, 2)]));
    w.reader.files.set(`${HEAD}:${ENTRIES}`, json({ entries: [] }));
    w.reader.onRead = () => { w.holders.delete(RUN); };
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.equal(w.port.records.get(GOAL_ID)?.version, 1, "a removed run's record is unchanged");
    assert.equal(w.events.length, 0, "a removed run adds no event");
  }

  // A new revision is marked while the old pass reads: the old apply writes nothing, and the new pass runs next.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a2", ENTRIES, 2)]));
    w.reader.files.set(`${HEAD}:${ENTRIES}`, json({ entries: [] }));
    w.reader.onRead = () => {
      if (w.reader.calls.length !== 1) return;
      holder.run.revision = 2;
      holder.run.checks.push(check("failed", 2));
      holder.run.review = { verdict: "approved", summary: "Approved.", revision: 2 };
      w.register.mark(holder);
    };
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.equal(w.reader.calls.length, 2, "the revision 2 pass reads again");
    assert.equal(holder.register?.pass?.revision, 2, "the pass left at the end is revision 2's");
    const tested = w.port.records.get(GOAL_ID)?.log.filter(entry => entry.op === REGISTER_OPS.tested) ?? [];
    assert.equal(tested.length > 0 && tested.every(entry => (entry.after as { inline: { revision: number } }).inline.revision === 2), true,
      "every test.recorded entry is revision 2's");
    assert.equal(w.port.records.get(GOAL_ID)?.version, 2, "one write, from revision 2's pass");
  }

  // A newer revision is marked before the queued pass starts: the stale job is skipped, and the newer pass runs once.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a2", ENTRIES, 2)]));
    w.reader.files.set(`${HEAD}:${ENTRIES}`, json({ entries: [] }));
    w.reader.files.set(`${OTHER}:${ENTRIES}`, json({ entries: [] }));
    w.register.mark(holder);
    Object.assign(holder.run, { revision: 2, headCommit: OTHER, review: { verdict: "approved", summary: "Approved.", revision: 2 } });
    holder.run.checks.push(check("failed", 2, OTHER));
    holder.checkHead = OTHER;
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.deepEqual(w.reader.calls, [`${OTHER}:${ENTRIES}`], "only the newer pass reads, once");
    assert.equal(w.port.records.get(GOAL_ID)?.version, 2, "one write, from the newer pass");
    assert.equal(w.events.length, 1, "one event");
  }

  // The register closes while the pass reads: the pass is aborted, so no further read starts and nothing is written.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a1", "p1.json", 1), artifactAssumption("a2", ENTRIES, 2)]));
    w.reader.onRead = () => { w.register.close(); };
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.equal(w.reader.calls.length, 1, "no read starts after close");
    assert.equal(w.port.records.get(GOAL_ID)?.version, 1, "a closed register writes nothing");
    assert.equal(w.events.length, 0, "a closed register adds no event");
  }

  // The run moves on to a revision that is not due before the pass plans: the pass still reads the commit it was marked at.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a2", ENTRIES, 2)]));
    w.reader.files.set(`${HEAD}:${ENTRIES}`, json({ entries: [{ id: "e1" }, { id: "e2" }] }));
    w.reader.files.set(`${OTHER}:${ENTRIES}`, json({ entries: [] }));
    w.register.mark(holder);
    Object.assign(holder.run, { status: "running", revision: 2, headCommit: OTHER });
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.deepEqual(w.reader.calls, [`${HEAD}:${ENTRIES}`], "the pass reads at its marked commit, not the run's new head");
    assert.deepEqual(holder.register?.pass?.receipts?.map(receipt => [receipt.commit, receipt.outcome]), [[HEAD, "pass"]],
      "the receipt is a fact about the marked commit");
  }

  // The holder is copied and assigned back, as continue and verification recovery do, before the pass starts or while it reads:
  // the pass settles once, on the copy the holder now holds, and nothing stays pending.
  for (const when of ["queued", "reading"] as const) {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a2", ENTRIES, 2)]));
    w.reader.files.set(`${HEAD}:${ENTRIES}`, json({ entries: [] }));
    const copyBack = () => {
      const next = structuredClone(holder);
      Object.assign(next.run, { status: "planning", revision: 2 });
      Object.assign(holder, next);
    };
    if (when === "reading") w.reader.onRead = copyBack;
    w.register.mark(holder);
    if (when === "queued") copyBack();
    w.register.drain();
    await w.register.idle();
    assert.equal(w.register.pending(RUN), false, `${when}: the copied pass is not left pending`);
    assert.equal(holder.register?.pass?.state, "done", when);
    assert.equal(w.port.records.get(GOAL_ID)?.version, 2, `${when}: one write, from the pass marked before the copy`);
  }

  // A goal record write that fails: skipped write-failed, one event, and the receipts are kept.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a2", ENTRIES, 2), commandAssumption("a4", "fail")]));
    w.reader.files.set(`${HEAD}:${ENTRIES}`, json({ entries: [] }));
    w.port.failWrites = true;
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.equal(holder.register?.pass?.skipped, "write-failed", "a failed write is a skip");
    assert.equal(holder.register?.pass?.receipts?.length, 2, "the receipts are kept");
    assert.deepEqual(w.events.map(event => event.text), [REGISTER_EVENTS.skipped["write-failed"]], "one skip event");
    assert.equal(w.port.records.get(GOAL_ID)?.version, 1, "the record is unchanged");
  }

  // An unreadable record: skipped record-unavailable, one event.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a2", ENTRIES, 2)]));
    w.port.unavailable = true;
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.equal(holder.register?.pass?.skipped, "record-unavailable", "an unreadable record is a skip");
    assert.deepEqual(w.events.map(event => event.text), [REGISTER_EVENTS.skipped["record-unavailable"]], "one skip event");
  }

  // A full log: skipped log-full, one event, and the receipts are kept.
  {
    const w = world();
    const record = baseRecord([commandAssumption("a4", "fail")]);
    const full = sealRecord({ ...record, log: Array.from({ length: 380 }, (_, index) => ({ ...record.log[0]!, seq: index + 1 })) }, {}, []);
    const holder = holderOf(w, runOf(), full);
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.equal(holder.register?.pass?.skipped, "log-full", "a full log is a skip");
    assert.equal(holder.register?.pass?.receipts?.length, 1, "the receipts are kept");
    assert.deepEqual(w.events.map(event => event.text), [REGISTER_EVENTS.skipped["log-full"]], "one skip event");
  }
});

test("stalled reads stop the pass from reading", async () => {
  const paths = [1, 2, 3, 4, 5].map(index => `p${index}.json`);
  const assumptions = paths.map((path, index) => artifactAssumption(`a${index + 1}`, path, 1));

  // The first four reads stall, so the fifth never starts.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord(assumptions));
    w.reader.stallFirst = 4;
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.equal(w.reader.calls.length, 4, "the fifth read does not start while four reads are stalled");
    const fifth = holder.register?.pass?.receipts?.find(receipt => receipt.id === "a5");
    assert.deepEqual(fifth?.detail, { kind: "artifact", read: "not-run", problem: "stalled" }, "the unplanned read is not-run");
    assert.equal(fifth?.outcome, "unknown", "a read that did not run is unknown");
    assert.equal(holder.register?.pass?.state, "done", "the pass still ends done");
  }

  // A read that passes the 120-second deadline leaves the rest not-run.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord(assumptions));
    w.reader.onRead = () => { if (w.reader.calls.length === 1) w.clock.ms += 121_000; };
    w.register.mark(holder);
    w.register.drain();
    await w.register.idle();
    assert.equal(w.reader.calls.length, 1, "no read starts past the deadline");
    const second = holder.register?.pass?.receipts?.find(receipt => receipt.id === "a2");
    assert.deepEqual(second?.detail, { kind: "artifact", read: "not-run", problem: "deadline" }, "the rest are not-run at the deadline");
  }
});

test("proposals follow the pin and the record", async () => {
  const stance = (requestId: string): MemberPostRecord => ({
    seq: 1, at: AT,
    envelope: { op: "post", runId: RUN, memberId: "m1", revision: 1, requestId, entry: { kind: "finding", summary: "Supports a1.", paths: [], body: { items: [], assumption: { id: "a1", stance: "supports" } } } },
  } as unknown as MemberPostRecord);
  const proposal = (requestId: string, statement: string): MemberPostRecord => ({
    seq: 2, at: AT,
    envelope: {
      op: "post", runId: RUN, memberId: "m1", revision: 1, requestId,
      entry: { kind: "finding", summary: "Proposes a test.", paths: [], body: { items: [], assumption: {
        propose: { statement, refutedBy: "The check fails", test: { kind: "command", run: RANK, refutesOn: "fail" }, criticality: "plan" },
      } } },
    },
  } as unknown as MemberPostRecord);
  const ids = ["6f1c2a3e-8b4d-4c5e-9f60-718293a4b501", "6f1c2a3e-8b4d-4c5e-9f60-718293a4b502", "6f1c2a3e-8b4d-4c5e-9f60-718293a4b503"];

  // An unpinned run: nothing changes and no drop is counted.
  {
    const w = world();
    const holder = holderOf(w, runOf({ register: undefined }), baseRecord([artifactAssumption("a1", ENTRIES, 1)]));
    w.register.propose(RUN, MEMBER, [stance(ids[0]!), proposal(ids[1]!, "The entry count is at least 40.")]);
    assert.equal(w.port.records.get(GOAL_ID)?.version, 1, "an unpinned run's record is unchanged");
    assert.equal(holder.register, undefined, "an unpinned run counts no drop");
    assert.equal(w.events.length, 0, "an unpinned run adds no event");
  }

  // A pinned run: a stance and a proposal apply once across two calls with the same posts.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a1", ENTRIES, 1)]));
    const posts = [stance(ids[0]!), proposal(ids[1]!, "The entry count is at least 40.")];
    w.register.propose(RUN, MEMBER, posts);
    const once = w.port.records.get(GOAL_ID);
    assert.equal(once?.version, 2, "the page writes one version");
    assert.equal(once?.assumptions.find(item => item.id === "a1")?.proposals.length, 1, "the stance attaches to a1");
    const added = once?.assumptions.find(item => item.id === "a2");
    assert.equal(added?.origin, "member", "the proposal is a member assumption");
    assert.equal(added?.status, "unchecked", "a member proposal is unchecked");
    w.register.propose(RUN, MEMBER, posts);
    assert.equal(w.port.records.get(GOAL_ID)?.version, 2, "the same posts apply once");
    assert.equal(w.port.records.get(GOAL_ID)?.assumptions.find(item => item.id === "a1")?.proposals.length, 1, "no second stance");
    assert.equal(holder.register?.drops, undefined, "accepted proposals drop nothing");
  }

  // An unreadable record: record-unavailable is counted with one event, and a second drop adds no second event.
  {
    const w = world();
    const holder = holderOf(w, runOf(), baseRecord([artifactAssumption("a1", ENTRIES, 1)]));
    w.port.unavailable = true;
    w.register.propose(RUN, MEMBER, [proposal(ids[2]!, "The entry count is at least 40.")]);
    assert.equal(holder.register?.drops?.["record-unavailable"], 1, "the proposal is counted under record-unavailable");
    assert.equal(w.events.filter(event => event.text === REGISTER_EVENTS.proposalsDropped).length, 1, "one drop event");
    w.register.propose(RUN, MEMBER, [proposal(ids[2]!, "The entry count is at least 40.")]);
    assert.equal(holder.register?.drops?.["record-unavailable"], 2, "a second drop is counted");
    assert.equal(w.events.filter(event => event.text === REGISTER_EVENTS.proposalsDropped).length, 1, "a second drop adds no second event");
  }
});

// ---- Seeded sequences -----------------------------------------------------------------------------------------------

const SEEDS = 100;
const STEPS = 30;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

type Step =
  | { op: "set"; status: "working" | "ready-for-review" | "merged" | "blocked"; advance: 0 | 1; head: string; reviewed: boolean; result: "passed" | "failed" }
  | { op: "drain" }
  | { op: "drain-restart" }
  | { op: "restart" }
  | { op: "propose"; stance: boolean; target: number; statement: number };

function stepsOf(seed: number): Step[] {
  const random = mulberry32(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const steps: Step[] = [];
  for (let index = 0; index < STEPS; index += 1) {
    const roll = random();
    if (roll < 0.35) {
      steps.push({
        op: "set", status: pick(["working", "ready-for-review", "merged", "blocked"] as const), advance: random() < 0.4 ? 1 : 0,
        head: random() < 0.8 ? HEAD : OTHER, reviewed: random() < 0.6, result: random() < 0.5 ? "passed" : "failed",
      });
    } else if (roll < 0.6) {
      steps.push({ op: "drain" });
    } else if (roll < 0.7) {
      steps.push({ op: "drain-restart" });
    } else if (roll < 0.8) {
      steps.push({ op: "restart" });
    } else {
      steps.push({ op: "propose", stance: random() < 0.4, target: Math.floor(random() * 4), statement: Math.floor(random() * 3) });
    }
  }
  return steps;
}

/** Runs the steps on a fresh world. With `restarts`, the restart steps close and rebuild the host from a JSON round trip. */
async function execute(seed: number, steps: readonly Step[], restarts: boolean): Promise<{ w: World }> {
  const w = world();
  const base = baseRecord([artifactAssumption("a1", ENTRIES, 1), commandAssumption("a2", "fail")]);
  w.port.records.set(GOAL_ID, base);
  w.reader.files.set(`${HEAD}:${ENTRIES}`, json({ entries: [{ id: "e1" }, { id: "e2" }] }));
  w.reader.files.set(`${OTHER}:${ENTRIES}`, json({ entries: [{ id: "e1" }] }));
  w.holders.set(RUN, { run: runOf({ status: "working", revision: 1, checks: [], review: undefined }), checkHead: undefined });
  let proposed = 0;
  let revision = 1;
  // Closes the register, as a restart does, even while a pass reads. The host state goes through a JSON round trip.
  const reopen = (): void => {
    w.register.close();
    w.holders = new Map([...w.holders].map(([id, holder]) => [id, JSON.parse(JSON.stringify(holder)) as RegisterHolder]));
    w.port.records = new Map([...w.port.records].map(([id, record]) => [id, JSON.parse(JSON.stringify(record)) as ObjectiveRecord]));
    w.register = makeRegister(w);
    w.register.restore(w.holders.values());
  };
  for (const [index, step] of steps.entries()) {
    const holder = w.holders.get(RUN)!;
    switch (step.op) {
      case "set": {
        revision += step.advance;
        holder.run.status = step.status;
        holder.run.revision = revision;
        holder.run.headCommit = step.head;
        holder.checkHead = step.reviewed ? step.head : holder.checkHead;
        holder.run.review = step.reviewed ? { verdict: "approved", summary: "Approved.", revision } : undefined;
        holder.run.checks.push({ ...check(step.result, revision, step.head), round: 1 });
        // Every save marks the pass, as teams.ts' save does.
        w.register.mark(holder);
        break;
      }
      case "drain":
        w.register.drain();
        await w.register.idle();
        break;
      case "drain-restart":
        w.register.drain();
        if (restarts) {
          reopen();
          w.register.drain();
        }
        await w.register.idle();
        break;
      case "restart":
        if (restarts) {
          await w.register.idle();
          reopen();
        }
        break;
      case "propose": {
        proposed += 1;
        const record = w.port.records.get(GOAL_ID)!;
        const target = record.assumptions[step.target];
        const requestId = `6f1c2a3e-8b4d-4c5e-9f60-${String(seed * 100 + index).padStart(12, "0")}`;
        const assumption = step.stance && target
          ? { id: target.id, stance: "supports" as const }
          : { propose: { statement: `Proposed assumption ${step.statement} of ${proposed}.`, refutedBy: "The check fails", test: { kind: "command", run: RANK, refutesOn: "fail" }, criticality: "plan" } };
        const post = {
          seq: index + 1, at: AT,
          envelope: { op: "post", runId: RUN, memberId: "m1", revision, requestId, entry: { kind: "finding", summary: `Member finding ${index}.`, paths: [], body: { items: [], assumption } } },
        } as unknown as MemberPostRecord;
        w.register.propose(RUN, MEMBER, [post]);
        break;
      }
    }
  }
  w.register.drain();
  await w.register.idle();
  w.register.drain();
  await w.register.idle();
  return { w };
}

test("seeded runs with restarts write each pass once", async () => {
  let applied = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const steps = stepsOf(seed);
    const plain = await execute(seed, steps, false);
    const restarted = await execute(seed, steps, true);

    const finalPlain = plain.w.port.records.get(GOAL_ID)!;
    const finalRestarted = restarted.w.port.records.get(GOAL_ID)!;
    assert.equal(digestOf(finalRestarted) === digestOf(finalPlain), true,
      `seed ${seed}: restarts changed the record at key ${firstDiff(finalPlain, finalRestarted)}`);

    // At most one test.recorded version per revision and kind.
    const versions = new Map<string, Set<number>>();
    for (const entry of finalRestarted.log) {
      if (entry.op !== REGISTER_OPS.tested) continue;
      const inline = (entry.after as { inline: { revision: number; kind: string } }).inline;
      const key = `${inline.revision}:${inline.kind}`;
      versions.set(key, (versions.get(key) ?? new Set()).add(entry.version));
    }
    for (const [key, set] of versions) {
      assert.equal(set.size <= 1, true, `seed ${seed}: revision and kind ${key} wrote ${set.size} versions`);
    }

    // Every pass ends done, or was replaced by one that does.
    for (const holder of restarted.w.holders.values()) {
      const state = holder.register?.pass?.state;
      assert.equal(state === undefined || state === "done", true, `seed ${seed}: a pass is still ${state}`);
      if (holder.register?.pass?.wrote !== undefined) applied += 1;
    }
  }
  // The invariants are vacuous unless passes wrote records across the seeds.
  assert.equal(applied > SEEDS / 4, true, `seed run: only ${applied} passes wrote a record across ${SEEDS} seeds`);
});
