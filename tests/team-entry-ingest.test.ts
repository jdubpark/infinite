import test from "node:test";
import assert from "node:assert/strict";
import type { Blackboard, IngestOutcome, MemberPostRecord } from "../packages/host/src/evidence/blackboard.js";
import { memberEntryId, memberEntryPostSchema, type MemberEntryPost } from "../packages/host/src/evidence/member-entry.js";
import { ingestRunEntries, type IngestDeps } from "../packages/host/src/team-entry-ingest.js";
import type { TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import type { Event } from "../packages/host/src/types.js";
import { hostEntryIds, hostEntryRun } from "./fixtures/host-entry-run.js";

const at = "2026-11-13T10:10:00.000Z";

/** A run and its implementer, with the entry tools on, the given status, and no report. */
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

/** A journal `team-entry` event holding a valid member post, bound to the member's current attempt. */
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

/** The scripted journal's page after a cursor: every event with a higher seq. */
function journalAfter(journal: Event[], after: number): { events: Event[]; cursor: number; more: boolean } {
  const visible = journal.filter(event => event.seq > after);
  return { events: visible, cursor: visible.at(-1)?.seq ?? after, more: false };
}

/** A fake store that records each batch of posts it is given and stores all of them. */
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
  // The first page is silent: 512 KiB of other lines, with more to read. The post sits after cursor 300.
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
