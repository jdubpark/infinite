import { z } from "zod";
import type { TeamLineup, TeamStatus } from "./team-types.js";
import type { UsageRollup } from "./team-usage.js";
import { projectGroupIdSchema } from "./project-group-types.js";

const subtaskId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

export const createMissionSchema = z.object({
  requestId: z.uuid(),
  groupId: projectGroupIdSchema,
  /** Derived from the first line of the objective when omitted. */
  title: z.string().trim().min(1).max(100).optional(),
  objective: z.string().trim().min(1).max(24000),
  maxSubtasks: z.number().int().min(1).max(12).default(8),
  maxMinutes: z.number().int().min(5).max(1440).default(240),
  /** Host project ids that override the primary checkout of their repository for this mission. */
  checkouts: z.array(z.string().regex(/^[a-z0-9-]{1,80}$/)).max(64).optional(),
}).strict();
export type CreateMission = z.infer<typeof createMissionSchema>;
export const missionActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export const missionTextSchema = missionActionSchema.extend({ text: z.string().trim().min(1).max(8000) }).strict();

/** One unit of work the main coordinator hands to a single-repository subteam. */
export const missionSubtaskPlanSchema = z.object({
  id: subtaskId,
  /** Host project ID; must be a repository of the mission's group. */
  repoProjectId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(12000),
  /** Initial worker limit; solo has a ceiling of 1 and team subtasks can later scale up to the host ceiling of 4. */
  size: z.enum(["solo", "team"]),
  parallelism: z.number().int().min(1).max(4).default(1),
  dependsOn: z.array(subtaskId).max(12).default([]),
}).strict();
export type MissionSubtaskPlan = z.infer<typeof missionSubtaskPlanSchema>;

/** Reports from the mission coordinator. Subteam members keep using `TeamReport`. */
export const missionReportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dispatch"), summary: z.string().trim().min(1).max(4000), subtasks: z.array(missionSubtaskPlanSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("resize-subtask"), subtaskId, parallelism: z.number().int().min(1).max(4), summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("answer-child"), subtaskId, decisionId: z.uuid(), text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("cancel-subtask"), subtaskId, reason: z.string().trim().min(1).max(2000) }).strict(),
  /** Forwards owner direction or an owner answer to a running subteam; the subteam replans under a new revision. */
  z.object({ kind: z.literal("steer-subtask"), subtaskId, text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("question"), question: z.string().trim().min(1).max(4000), options: z.array(z.string().min(1).max(500)).max(4).default([]), subtaskId: subtaskId.optional(), childDecisionId: z.uuid().optional() }).strict(),
  z.object({ kind: z.literal("result"), summary: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("blocked"), summary: z.string().trim().min(1).max(4000) }).strict(),
  /** Ends the attempt without a decision; the next subteam event or owner input starts another. */
  z.object({ kind: z.literal("wait"), summary: z.string().trim().min(1).max(2000) }).strict(),
]);
export type MissionReport = z.infer<typeof missionReportSchema>;
export const missionReportEnvelopeSchema = z.object({ requestId: z.uuid(), missionId: z.uuid(), memberId: z.uuid(), revision: z.number().int().min(1), report: missionReportSchema }).strict();

export type MissionStatus = "planning" | "working" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "cancelled";
export interface MissionSubtask extends MissionSubtaskPlan {
  /** `queued` waits for dependencies or for the repository's active subteam to finish. */
  status: "queued" | "running" | "done" | "cancelled" | "blocked";
  teamId?: string;
  /** Last observed child status; refreshed by the host, never reported by an agent. */
  teamStatus?: TeamStatus;
  /** Small host-observed record retained after a cancelled subteam is deleted. */
  finalEvidence?: { reason?: string; headCommit?: string; usage?: UsageRollup };
}
export interface MissionDecision {
  id: string;
  question: string;
  options: string[];
  createdAt: string;
  /** Present when the question was escalated from a subteam decision. */
  subtaskId?: string;
  childDecisionId?: string;
  answer?: string;
  answeredAt?: string;
  answeredBy?: "owner" | "coordinator";
}
export interface Mission {
  id: string;
  groupId: string;
  /** Group name and repositories pinned at creation; later group edits do not change a running mission. */
  groupName: string;
  repoProjectIds: string[];
  title: string;
  objective: string;
  maxSubtasks: number;
  maxMinutes: number;
  deadlineAt: string;
  revision: number;
  status: MissionStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  lineup: TeamLineup;
  coordinator?: { memberId: string; sessionId: string; status: "running" | "waiting" | "stopped" };
  dispatchSummary?: string;
  subtasks: MissionSubtask[];
  decisions: MissionDecision[];
  steering: { text: string; revision: number; at: string }[];
  events: { at: string; text: string }[];
  result?: { summary: string; revision: number; at: string };
  /** Computed on read from the coordinator and subteams; never stored. */
  usage?: UsageRollup;
}

/** One row of the owner's board, across missions and runs started outside a mission. */
export type BoardColumn = "needs-input" | "working" | "review" | "ended";
export interface BoardItem {
  kind: "mission" | "team" | "goal";
  id: string;
  title: string;
  groupId?: string;
  /** Project (group) name, or the host project name for runs outside a group. */
  projectName: string;
  column: BoardColumn;
  status: string;
  /** One line: the open question, the block reason, or the current step. */
  detail: string;
  updatedAt: string;
  subtasks?: { total: number; running: number; done: number };
}
export interface Board {
  items: BoardItem[];
}
