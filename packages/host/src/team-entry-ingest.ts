import { z } from "zod";
import type { Blackboard, IngestOutcome, MemberPostRecord, MemberReadRecord } from "./evidence/blackboard.js";
import { memberEntryEnvelopeSchema } from "./evidence/member-entry.js";
import type { Event } from "./types.js";
import { ACTIVE_MEMBER_STATUSES, type TeamMember, type TeamRun } from "./team-types.js";

/** Journal events of a member's entry calls: the worker's posts and read receipts. */
export const ENTRY_EVENT_TYPES = new Set<string>(["team-entry", "team-entry-read"]);
/** Journal events read per member per pass. */
export const ENTRY_INGEST_PAGE = 200;
/** Members read per pass across all runs. A pass reads at most this many journal pages. */
export const ENTRY_INGEST_MEMBERS = 16;
/** How often the scheduler runs an ingest pass. */
export const ENTRY_INGEST_MS = 1_000;
/** The run event that says posts were dropped at the run limit. It is added once per run. */
export const ENTRY_DROP_TEXT = "Member entries over the run limit of 400 were dropped.";

const readSchema = z.object({ op: z.enum(["list", "get"]), servedBytes: z.number().int().min(0) }).strict();

export type IngestDeps = {
  events: (id: string, after: number, limit: number, types?: Set<string>) => { events: Event[]; cursor: number; more: boolean };
  entries: Blackboard;
  /** Members that are settled for good, in memory. A restart reads each pending member once. */
  done: Set<string>;
  /** The members to read this pass. The caller bounds the list. */
  members: readonly TeamMember[];
};

/** Whether a member's journal may still hold entry events the host has not stored. */
export function entryIngestPending(member: TeamMember, done: ReadonlySet<string>): boolean {
  if (member.entryTools !== true || member.startedAt === undefined || done.has(member.memberId)) return false;
  // The worker closes entry calls at the report, so a reported member whose entry cursor passed its report cursor has nothing left.
  return !(member.report !== undefined && (member.entryCursor ?? 0) >= member.cursor);
}

/**
 * One journal page per listed member. Posts and receipts go to `Blackboard.ingest`; a cursor moves only when the
 * store holds the page. Events that do not parse are skipped. Never throws.
 * `advanced`: a cursor moved past a page. `dropped`: posts the run limit refused in this pass.
 */
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
        // A page with no post and no receipt moves the cursor in memory only: no store write, and no advance to save.
        if (posts.length === 0 && reads.length === 0) {
          member.entryCursor = page.cursor;
          if (!page.more && !ACTIVE_MEMBER_STATUSES.includes(member.status)) deps.done.add(member.memberId);
          continue;
        }
        const outcome: IngestOutcome = deps.entries.ingest(run, member, posts, reads);
        if (outcome.result !== "stored") continue;
        result.dropped += outcome.dropped;
        if (page.cursor !== (member.entryCursor ?? 0)) { member.entryCursor = page.cursor; result.advanced = true; }
        // A stopped member whose journal was read to its end sends no more entry calls, so it is settled for good.
        if (!page.more && !ACTIVE_MEMBER_STATUSES.includes(member.status)) deps.done.add(member.memberId);
      } catch {
        // A member whose page cannot be read keeps its cursor and waits for a later pass.
      }
    }
  } catch {
    // Never throws: a failed pass leaves every cursor where the store last held it.
  }
  return result;
}
