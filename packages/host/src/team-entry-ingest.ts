import { z } from "zod";
import type { Blackboard, IngestOutcome, MemberPostRecord, MemberReadRecord } from "./evidence/blackboard.js";
import { memberEntryEnvelopeSchema } from "./evidence/member-entry.js";
import type { Event } from "./types.js";
import { ACTIVE_MEMBER_STATUSES, type TeamMember, type TeamRun } from "./team-types.js";

export const ENTRY_EVENT_TYPES = new Set<string>(["team-entry", "team-entry-read"]);
export const ENTRY_INGEST_PAGE = 200;
export const ENTRY_INGEST_MEMBERS = 16;
export const ENTRY_INGEST_MS = 1_000;
export const ENTRY_DROP_TEXT = "Member entries over the run limit of 400 were dropped.";

const readSchema = z.object({ op: z.enum(["list", "get"]), servedBytes: z.number().int().min(0) }).strict();

export type IngestDeps = {
  events: (id: string, after: number, limit: number, types?: Set<string>) => { events: Event[]; cursor: number; more: boolean };
  entries: Blackboard;
  done: Set<string>;
  members: readonly TeamMember[];
  kept?: (run: TeamRun, member: TeamMember, posts: readonly MemberPostRecord[]) => void;
};

export function entryIngestPending(member: TeamMember, done: ReadonlySet<string>): boolean {
  if (member.entryTools !== true || member.startedAt === undefined || done.has(member.memberId)) return false;
  return !(member.report !== undefined && (member.entryCursor ?? 0) >= member.cursor);
}

export function ingestRunEntries(run: TeamRun, deps: IngestDeps): { advanced: boolean; dropped: number } {
  const result = { advanced: false, dropped: 0 };
  try {
    for (const member of deps.members) {
      try {
        if (!entryIngestPending(member, deps.done)) continue;
        const page = deps.events(member.sessionId, member.entryCursor ?? 0, ENTRY_INGEST_PAGE, ENTRY_EVENT_TYPES);
        const posts: MemberPostRecord[] = [], reads: MemberReadRecord[] = [];
        for (const event of page.events) {
          if (event.type === "team-entry") {
            const parsed = memberEntryEnvelopeSchema.safeParse(event.data);
            if (parsed.success && parsed.data.op === "post") posts.push({ seq: event.seq, at: event.at, envelope: parsed.data });
          } else {
            const parsed = readSchema.safeParse(event.data);
            if (parsed.success) reads.push({ seq: event.seq, op: parsed.data.op, servedBytes: parsed.data.servedBytes });
          }
        }
        if (posts.length === 0 && reads.length === 0) {
          member.entryCursor = page.cursor;
          if (!page.more && !ACTIVE_MEMBER_STATUSES.includes(member.status)) deps.done.add(member.memberId);
          continue;
        }
        const outcome: IngestOutcome = deps.entries.ingest(run, member, posts, reads);
        if (outcome.result !== "stored") continue;
        result.dropped += outcome.dropped;
        const keptPosts = posts.filter(post => outcome.kept?.has(post.seq) === true);
        if (keptPosts.length > 0) {
          try {
            deps.kept?.(run, member, keptPosts);
          } catch {
          }
        }
        if (page.cursor !== (member.entryCursor ?? 0)) { member.entryCursor = page.cursor; result.advanced = true; }
        if (!page.more && !ACTIVE_MEMBER_STATUSES.includes(member.status)) deps.done.add(member.memberId);
      } catch {
      }
    }
  } catch {
  }
  return result;
}

export class EntryIngestQueue {
  private readonly pending = new Map<string, { runId: string; memberId: string }>();

  add(runId: string, memberId: string): void {
    if (!this.pending.has(memberId)) this.pending.set(memberId, { runId, memberId });
  }

  remove(memberId: string): void {
    this.pending.delete(memberId);
  }

  take(max: number): { runId: string; memberId: string }[] {
    const taken: { runId: string; memberId: string }[] = [];
    for (const entry of this.pending.values()) {
      if (taken.length >= max) break;
      taken.push({ ...entry });
    }
    for (const entry of taken) {
      this.pending.delete(entry.memberId);
      this.pending.set(entry.memberId, entry);
    }
    return taken;
  }

  get size(): number {
    return this.pending.size;
  }
}

export function ingestRunMemberEntries(
  queue: EntryIngestQueue,
  theRun: TeamRun | undefined,
  memberIds: readonly string[],
  deps: Pick<IngestDeps, "events" | "entries" | "kept">,
): { run: TeamRun; advanced: boolean; dropped: number } | undefined {
  try {
    if (theRun === undefined || theRun.blackboard?.tools !== true) {
      for (const memberId of memberIds) queue.remove(memberId);
      return undefined;
    }
    const members: TeamMember[] = [];
    for (const memberId of memberIds) {
      const member = theRun.members.find(item => item.memberId === memberId);
      if (member === undefined || member.entryTools !== true) {
        queue.remove(memberId);
        continue;
      }
      members.push(member);
    }
    const done = new Set<string>();
    const { advanced, dropped } = ingestRunEntries(theRun, { ...deps, done, members });
    for (const member of members) {
      const settled = done.has(member.memberId) ||
        (member.startedAt !== undefined ? !entryIngestPending(member, done) : !ACTIVE_MEMBER_STATUSES.includes(member.status));
      if (settled) queue.remove(member.memberId);
    }
    return { run: theRun, advanced, dropped };
  } catch {
    return undefined;
  }
}

export function ingestPass(
  queue: EntryIngestQueue,
  run: (runId: string) => TeamRun | undefined,
  deps: Pick<IngestDeps, "events" | "entries" | "kept">,
): { run: TeamRun; advanced: boolean; dropped: number }[] {
  const groups = new Map<string, string[]>();
  for (const { runId, memberId } of queue.take(ENTRY_INGEST_MEMBERS)) groups.set(runId, [...(groups.get(runId) ?? []), memberId]);
  const results: { run: TeamRun; advanced: boolean; dropped: number }[] = [];
  for (const [runId, memberIds] of groups) {
    const result = ingestRunMemberEntries(queue, run(runId), memberIds, deps);
    if (result) results.push(result);
  }
  return results;
}
