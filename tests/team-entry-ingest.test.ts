import test from "node:test";
import assert from "node:assert/strict";
import type { Blackboard, IngestOutcome, MemberPostRecord } from "../packages/host/src/evidence/blackboard.js";
import { memberEntryId, memberEntryPostSchema, type MemberEntryPost } from "../packages/host/src/evidence/member-entry.js";
import { EntryIngestQueue, ingestPass, ingestRunEntries, type IngestDeps } from "../packages/host/src/team-entry-ingest.js";
import type { TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import type { Event } from "../packages/host/src/types.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";

const at = "2026-11-13T10:10:00.000Z";

function memberState(status: TeamMember["status"]): { run: TeamRun; member: TeamMember } {
  const run = hostEntryRun();
  const member = run.members.find(item => item.memberId === hostEntryIds.implA);
  if (!member) throw new Error("fixture member missing");
  member.status = status;
  member.entryTools = true;
  member.startedAt = at;
  member.entryCursor = 0;
  member.report = undefined;
  return { run, member };
}

function postEvent(member: TeamMember, seq: number, summary: string): Event {
  const entry: MemberEntryPost = memberEntryPostSchema.parse({
    kind: "contract",
    summary,
    paths: [],
    body: { interface: "Shared route", change: summary },
  });
  const binding = { runId: member.runId, memberId: member.memberId, revision: member.revision };
  return { seq, at, type: "team-entry", data: { op: "post", ...binding, requestId: memberEntryId(binding, entry), entry } };
}

function journalAfter(journal: Event[], after: number): { events: Event[]; cursor: number; more: boolean } {
  const visible = journal.filter(event => event.seq > after);
  return { events: visible, cursor: visible.at(-1)?.seq ?? after, more: false };
}

function fakeEntries(): { entries: Blackboard; batches: MemberPostRecord[][] } {
  const batches: MemberPostRecord[][] = [];
  const entries = {
    ingest: (_run: TeamRun, _member: TeamMember, posts: MemberPostRecord[]): IngestOutcome => {
      batches.push(posts);
      return { result: "stored", stored: posts.length, dropped: 0, invalid: 0 };
    },
  } as unknown as Blackboard;
  return { entries, batches };
}

test("a running member is read again on every pass", () => {
  const { run, member } = memberState("running");
  const journal: Event[] = [postEvent(member, 1, "first post")];
  const { entries, batches } = fakeEntries();
  const done = new Set<string>();
  const deps: IngestDeps = { events: (_id, after) => journalAfter(journal, after), entries, done, members: [member] };

  ingestRunEntries(run, deps);
  journal.push(postEvent(member, 2, "second post"));
  ingestRunEntries(run, deps);

  assert.deepEqual(batches.map(posts => posts.map(post => post.seq)), [[1], [2]]);
  assert.equal(done.has(member.memberId), false);
});

test("a stopped member with more to read is not settled", () => {
  const { run, member } = memberState("stopped");
  const journal: Event[] = [postEvent(member, 301, "late post")];
  const { entries, batches } = fakeEntries();
  const done = new Set<string>();
  const events = (_id: string, after: number) => (after < 300 ? { events: [], cursor: 300, more: true } : journalAfter(journal, after));
  const deps: IngestDeps = { events, entries, done, members: [member] };

  ingestRunEntries(run, deps);
  assert.equal(done.has(member.memberId), false, "a silent page that says more is not the end");

  ingestRunEntries(run, deps);
  assert.deepEqual(batches.map(posts => posts.map(post => post.seq)), [[301]]);
  assert.equal(done.has(member.memberId), true, "the page that says no more settles the member");

  ingestRunEntries(run, deps);
  assert.equal(batches.length, 1);
});

test("a stopped member whose page holds a post and says more is read on", () => {
  const { run, member } = memberState("stopped");
  const early = postEvent(member, 10, "early post"), late = postEvent(member, 400, "late post");
  const { entries, batches } = fakeEntries();
  const done = new Set<string>();
  const events = (_id: string, after: number) => (after < 10 ? { events: [early], cursor: 200, more: true } : journalAfter([late], after));
  const deps: IngestDeps = { events, entries, done, members: [member] };

  ingestRunEntries(run, deps);
  assert.equal(done.has(member.memberId), false, "a stored page that says more is not the end");

  ingestRunEntries(run, deps);
  assert.deepEqual(batches.map(posts => posts.map(post => post.seq)), [[10], [400]]);
  assert.equal(done.has(member.memberId), true, "the page that says no more settles the member");
});

function queueRun(runId: string, memberIds: string[], status: TeamMember["status"], started = true): TeamRun {
  const run = hostEntryRun();
  const base = memberState("running").member;
  run.id = runId;
  run.blackboard = { tools: true };
  run.members = memberIds.map(memberId => ({
    ...base, runId, memberId, sessionId: `${memberId}-session`, status, entryTools: true,
    startedAt: started ? at : undefined, entryCursor: 0, report: undefined,
  }));
  return run;
}

const silentJournal = (_id: string, after: number) => ({ events: [] as Event[], cursor: after, more: false });

test("the queue hands out members in turn, at most the limit a pass", () => {
  const queue = new EntryIngestQueue();
  const runIds = ["run-a", "run-b", "run-c"];
  for (let index = 0; index < 40; index += 1) queue.add(runIds[index % 3], `m${index}`);
  queue.add(runIds[0], "m0");
  assert.equal(queue.size, 40);

  const first = queue.take(16).map(entry => entry.memberId);
  const second = queue.take(16).map(entry => entry.memberId);
  const third = queue.take(16).map(entry => entry.memberId);
  assert.equal(first.length, 16);
  assert.equal(second.length, 16);
  assert.equal(new Set([...first, ...second]).size, 32);
  assert.deepEqual(third, [...Array.from({ length: 8 }, (_, index) => `m${32 + index}`), ...Array.from({ length: 8 }, (_, index) => `m${index}`)]);

  queue.remove("m3");
  assert.equal(queue.size, 39);
  const after = queue.take(40).map(entry => entry.memberId);
  assert.equal(after.includes("m3"), false);
  assert.equal(after.length, 39);
});

test("a pass looks at no run whose members are settled", () => {
  const runs = new Map<string, TeamRun>([
    ["run-a", queueRun("run-a", ["a1", "a2"], "stopped")],
    ["run-b", queueRun("run-b", ["b1"], "running")],
    ["run-c", queueRun("run-c", ["c1"], "running")],
  ]);
  const calls = new Map<string, number>();
  const lookup = (runId: string) => {
    calls.set(runId, (calls.get(runId) ?? 0) + 1);
    return runs.get(runId);
  };
  const queue = new EntryIngestQueue();
  for (const run of runs.values()) for (const member of run.members) queue.add(run.id, member.memberId);
  const { entries } = fakeEntries();
  const deps = { events: silentJournal, entries };

  ingestPass(queue, lookup, deps);
  const aAfterFirst = calls.get("run-a") ?? 0;
  ingestPass(queue, lookup, deps);
  ingestPass(queue, lookup, deps);
  assert.equal(calls.get("run-a"), aAfterFirst, "a settled run is not looked up again");
  assert.equal(aAfterFirst, 1);
  assert.ok((calls.get("run-b") ?? 0) >= 3, "a running run is read on every pass");
  assert.ok((calls.get("run-c") ?? 0) >= 3, "a running run is read on every pass");

  for (const member of [...runs.get("run-b")!.members, ...runs.get("run-c")!.members]) member.status = "stopped";
  ingestPass(queue, lookup, deps);
  calls.clear();
  ingestPass(queue, lookup, deps);
  assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), 0, "a pass with every member settled looks up no run");
  assert.equal(queue.size, 0);
});

test("a member that has not started stays queued, and one that never will leaves", () => {
  const waiting = queueRun("run-wait", ["w1"], "queued", false);
  const stopped = queueRun("run-stop", ["s1"], "stopped", false);
  const runs = new Map([[waiting.id, waiting], [stopped.id, stopped]]);
  const queue = new EntryIngestQueue();
  queue.add(waiting.id, "w1");
  queue.add(stopped.id, "s1");
  const { entries, batches } = fakeEntries();
  const journal: Event[] = [];
  const deps = { events: (_id: string, after: number) => journalAfter(journal, after), entries };

  ingestPass(queue, id => runs.get(id), deps);
  assert.equal(queue.size, 1, "a stopped member that never started leaves at its first pass");
  ingestPass(queue, id => runs.get(id), deps);
  ingestPass(queue, id => runs.get(id), deps);
  assert.equal(queue.size, 1, "an active member that has not started stays queued");

  const member = waiting.members[0];
  member.status = "running";
  member.startedAt = at;
  journal.push(postEvent(member, 1, "posted after start"));
  ingestPass(queue, id => runs.get(id), deps);
  assert.deepEqual(batches.map(posts => posts.map(post => post.seq)), [[1]], "the member is read once it starts and posts");
});

test("a run that is gone or has the tools off leaves the queue", () => {
  const off = queueRun("run-off", ["o1", "o2"], "running");
  off.blackboard = { tools: false } as unknown as TeamRun["blackboard"];
  const queue = new EntryIngestQueue();
  queue.add("run-gone", "g1");
  queue.add("run-gone", "g2");
  queue.add(off.id, "o1");
  queue.add(off.id, "o2");
  const { entries } = fakeEntries();
  const runs = new Map([[off.id, off]]);

  ingestPass(queue, id => runs.get(id), { events: silentJournal, entries });
  assert.equal(queue.size, 0);
});

test("the proposal hook sees only the posts the store holds", () => {
  const scripted = (outcomes: IngestOutcome[]) => {
    const ingested: number[][] = [];
    const entries = {
      ingest: (_run: TeamRun, _member: TeamMember, posts: MemberPostRecord[]): IngestOutcome => {
        ingested.push(posts.map(post => post.seq));
        const outcome = outcomes.shift();
        if (outcome === undefined) throw new Error("no scripted outcome");
        return outcome;
      },
    } as unknown as Blackboard;
    return { entries, ingested };
  };

  const { run, member } = memberState("running");
  const journal: Event[] = [postEvent(member, 1, "kept post"), postEvent(member, 2, "unkept post")];
  const { entries, ingested } = scripted([
    { result: "stored", stored: 2, dropped: 0, invalid: 0, kept: new Set([1]) },
    { result: "unready", stored: 0, dropped: 0, invalid: 0 },
    { result: "held", stored: 0, dropped: 0, invalid: 0 },
  ]);
  const hooked: number[][] = [];
  const deps: IngestDeps = {
    events: (_id, after) => journalAfter(journal, after),
    entries,
    done: new Set(),
    members: [member],
    kept: (_run, _member, posts) => { hooked.push(posts.map(post => post.seq)); },
  };

  ingestRunEntries(run, deps);
  assert.deepEqual(hooked, [[1]], "the hook gets the kept posts once");
  assert.equal(member.entryCursor, 2);

  journal.push(postEvent(member, 3, "unready post"));
  ingestRunEntries(run, deps);
  journal.push(postEvent(member, 4, "held post"));
  ingestRunEntries(run, deps);
  assert.deepEqual(hooked, [[1]], "an unready or held store gives the hook nothing");
  assert.equal(member.entryCursor, 2, "an unready or held store holds the cursor");
  assert.equal(ingested.length, 3);

  const quiet: IngestDeps = {
    ...deps,
    events: () => ({ events: [{ seq: 9, at, type: "heartbeat", data: {} }], cursor: 9, more: false }),
  };
  ingestRunEntries(run, quiet);
  assert.equal(ingested.length, 3, "a page without posts is not stored");
  assert.deepEqual(hooked, [[1]], "a page without posts gives the hook nothing");

  const none = scripted([{ result: "stored", stored: 0, dropped: 0, invalid: 1, kept: new Set() }]);
  const noneJournal: Event[] = [postEvent(member, 10, "invalid post")];
  ingestRunEntries(run, { ...deps, entries: none.entries, events: (_id, after) => journalAfter(noneJournal, after) });
  assert.equal(none.ingested.length, 1, "the page is stored");
  assert.deepEqual(hooked, [[1]], "a page the store keeps nothing of gives the hook nothing");

  const state = memberState("running");
  const second = state.run.members.find(item => item.memberId === hostEntryIds.implB);
  if (!second) throw new Error("fixture member missing");
  second.status = "running";
  second.entryTools = true;
  second.startedAt = at;
  second.entryCursor = 0;
  second.report = undefined;
  second.sessionId = "00000000-0000-4000-8000-0000000000c9";
  const firstJournal: Event[] = [postEvent(state.member, 1, "throwing hook post")];
  const secondJournal: Event[] = [postEvent(second, 1, "next member post")];
  const ingestedBy: string[] = [];
  const throwing = {
    ingest: (_run: TeamRun, read: TeamMember, posts: MemberPostRecord[]): IngestOutcome => {
      ingestedBy.push(read.memberId);
      return { result: "stored", stored: posts.length, dropped: 0, invalid: 0, kept: new Set(posts.map(post => post.seq)) };
    },
  } as unknown as Blackboard;
  ingestRunEntries(state.run, {
    events: (id, after) => journalAfter(id === state.member.sessionId ? firstJournal : secondJournal, after),
    entries: throwing,
    done: new Set(),
    members: [state.member, second],
    kept: () => { throw new Error("hook failed"); },
  });
  assert.equal(state.member.entryCursor, 1, "a throwing hook does not hold the cursor");
  assert.deepEqual(ingestedBy, [state.member.memberId, second.memberId]);
  assert.equal(second.entryCursor, 1, "the next member is read after a throwing hook");
});
