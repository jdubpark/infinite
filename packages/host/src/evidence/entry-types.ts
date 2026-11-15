import type { TeamRole } from "../team-types.js";

/** Every entry kind of the blackboard (spec part 3). Phase 2 writes only the host kinds. */
export const ENTRY_KINDS = ["contract", "finding", "blocker", "handoff", "report", "integration", "check", "direction"] as const;
export type EntryKind = typeof ENTRY_KINDS[number];
export type HostEntryKind = "report" | "integration" | "check" | "direction";

/** The plain columns and sealed head of one stored entry. Member text lives only in the sealed body. */
export type EntryHead = {
  entryId: string;
  seq: number;
  scope: "run" | "mission";
  runId: string;
  revision: number;
  at: string;
  kind: EntryKind;
  author: "host" | "member" | "owner";
  authority: "receipt" | "claim" | "direction";
  authorRole?: TeamRole | "mission-coordinator";
  taskId?: string;
  paths: string[];
  subtaskIds?: string[];
  summary: string;
  bodyBytes: number;
  supersedes?: string;
  unreadRequired?: string[];
  state: "active" | "superseded" | "withdrawn";
};

/** One entry the host builds from a saved run record, before it is stored. */
export type HostEntry = {
  entryId: string;
  kind: HostEntryKind;
  author: EntryHead["author"];
  authority: EntryHead["authority"];
  runId: string;
  missionId?: string;
  revision: number;
  at: string;
  authorMemberId?: string;
  authorRole?: TeamRole;
  taskId?: string;
  summary: string;
  body: Record<string, unknown>;
};

/** The kinds a member may post (spec part 3). Member and host kinds are disjoint. */
export const MEMBER_ENTRY_KINDS = ["contract", "finding", "blocker", "handoff"] as const;
/** The kinds the default order shows a member. Report and check entries reach a member through filtered lists only. */
export const ADDRESSED_ENTRY_KINDS = ["direction", "contract", "blocker", "handoff", "integration", "finding"] as const;
/** The same kinds as SQL text. The default order's statement and its partial index use this one text, so SQLite matches them. */
export const ADDRESSED_KIND_SQL = ADDRESSED_ENTRY_KINDS.map(kind => `'${kind}'`).join(", ");
export type MemberEntryKind = typeof MEMBER_ENTRY_KINDS[number];

/** What a member sees of a head: no run, revision, scope, author member id, or unread lists. */
export type MemberHead = Pick<EntryHead, "entryId" | "seq" | "at" | "kind" | "author" | "authority" | "authorRole"
  | "taskId" | "paths" | "summary" | "bodyBytes" | "supersedes" | "state">;
