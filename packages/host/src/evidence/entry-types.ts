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
