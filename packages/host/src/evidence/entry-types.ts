import type { TeamRole } from "../team-role.js";

export const ENTRY_KINDS = ["contract", "finding", "blocker", "handoff", "report", "integration", "check", "direction"] as const;
export type EntryKind = typeof ENTRY_KINDS[number];
export type HostEntryKind = "report" | "integration" | "check" | "direction";
export type EntryAuthorRole = Exclude<TeamRole, "evaluator" | "judge">;

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
  authorRole?: EntryAuthorRole | "mission-coordinator";
  taskId?: string;
  paths: string[];
  subtaskIds?: string[];
  summary: string;
  bodyBytes: number;
  supersedes?: string;
  unreadRequired?: string[];
  state: "active" | "superseded" | "withdrawn";
};

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
  authorRole?: EntryAuthorRole;
  taskId?: string;
  summary: string;
  body: Record<string, unknown>;
};

export const MEMBER_ENTRY_KINDS = ["contract", "finding", "blocker", "handoff"] as const;
export const ADDRESSED_ENTRY_KINDS = ["direction", "contract", "blocker", "handoff", "integration", "finding"] as const;
export const ADDRESSED_KIND_SQL = ADDRESSED_ENTRY_KINDS.map(kind => `'${kind}'`).join(", ");
export type MemberEntryKind = typeof MEMBER_ENTRY_KINDS[number];

export type MemberHead = Pick<EntryHead, "entryId" | "seq" | "at" | "kind" | "author" | "authority" | "authorRole"
  | "taskId" | "paths" | "summary" | "bodyBytes" | "supersedes" | "state">;
export type PendingEntry = { entryId: string; state: "pending" };
export type MemberList = { notice: string; heads: MemberHead[]; more: boolean; cursor?: number; unreadable: number };
export type MemberEntry = { notice: string; head: MemberHead; body: unknown };
