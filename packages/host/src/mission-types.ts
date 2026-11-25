import type { ConnectorSource } from "./mcp-types.js";
import { z } from "zod";
import { blockerEvidenceSchema, type GithubReviewSource, type TeamLineup, type TeamStatus } from "./team-types.js";
import type { UsageRollup } from "./team-usage.js";
import { projectGroupIdSchema } from "./project-group-types.js";
import { questionRecommendationSchema, refineQuestion, requiredQuestionRecommendationSchema, type DecisionRecommendation } from "./question-recommendation.js";

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
  /** `answer` makes the mission read-only: the coordinator reports an answer and starts no subtasks. Absent means a work mission. */
  mode: z.literal("answer").optional(),
}).strict();
export type CreateMission = z.infer<typeof createMissionSchema>;
export const missionActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export const missionTextSchema = missionActionSchema.extend({ text: z.string().trim().min(1).max(8000) }).strict();
/** The owner approves more working time: up to 24 hours per extension. */
export const missionExtendSchema = missionActionSchema.extend({ minutes: z.number().int().min(5).max(1440) }).strict();

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

const missionQuestionShape = { kind: z.literal("question"), question: z.string().trim().min(1).max(4000), options: z.array(z.string().min(1).max(500)).max(4).default([]), answerMode: z.enum(["approval", "single", "multiple"]).optional(), subtaskId: subtaskId.optional(), childDecisionId: z.uuid().optional() };
const missionReportVariants = [
  z.object({ kind: z.literal("dispatch"), summary: z.string().trim().min(1).max(4000), subtasks: z.array(missionSubtaskPlanSchema).min(1).max(12) }).strict(),
  z.object({ kind: z.literal("resize-subtask"), subtaskId, parallelism: z.number().int().min(1).max(4), summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("answer-child"), subtaskId, decisionId: z.uuid(), text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("cancel-subtask"), subtaskId, reason: z.string().trim().min(1).max(2000) }).strict(),
  /** Forwards owner direction or an owner answer to a running subteam; the subteam replans under a new revision. */
  z.object({ kind: z.literal("steer-subtask"), subtaskId, text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("result"), summary: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("blocked"), summary: z.string().trim().min(1).max(4000), blocker: blockerEvidenceSchema.optional() }).strict(),
  /** Ends the attempt without a decision; the next subteam event or owner input starts another. */
  z.object({ kind: z.literal("wait"), summary: z.string().trim().min(1).max(2000) }).strict(),
  /** Ends the attempt and asks the host to start another at a time; it schedules a look and decides nothing. */
  z.object({ kind: z.literal("follow-up"), inMinutes: z.number().int().min(5).max(10080), reason: z.string().trim().min(1).max(500), check: z.string().trim().min(1).max(1000) }).strict(),
] as const;
/** Reports the mission coordinator may send: every question carries its recommendation. Subteam members keep using `TeamReport`. */
export const missionReportSchema = z.discriminatedUnion("kind", [...missionReportVariants,
  z.object({ ...missionQuestionShape, recommendation: requiredQuestionRecommendationSchema }).strict().superRefine(refineQuestion)]);
/**
 * A report as the session journal and the mission record hold it. A coordinator started before recommendations were
 * required may still ask a question without one, so the worker and the host read this form.
 */
export const recordedMissionReportSchema = z.discriminatedUnion("kind", [...missionReportVariants,
  z.object({ ...missionQuestionShape, recommendation: questionRecommendationSchema.optional() }).strict().superRefine(refineQuestion)]);
export type MissionReport = z.infer<typeof recordedMissionReportSchema>;
/** The coordinator's own words for a later conversation. Kept in the stored record only; never host fact. */
export const missionNoteSchema = z.string().trim().min(1).max(2000)
  .describe("Optional. What the mission state does not show: decisions and their reasons, what you are waiting for, and what to check next.");
/** The mission_report tool input. */
export const missionReportArgumentsSchema = z.object({ report: missionReportSchema, note: missionNoteSchema.optional() }).strict();
export const missionReportEnvelopeSchema = z.object({ requestId: z.uuid(), missionId: z.uuid(), memberId: z.uuid(), revision: z.number().int().min(1), report: recordedMissionReportSchema, note: missionNoteSchema.optional() }).strict();

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
  /** Absent on legacy decisions; approval uses option 1 to approve and option 2 to deny. */
  answerMode?: "approval" | "single" | "multiple";
  createdAt: string;
  /** Present when the question was escalated from a subteam decision. */
  subtaskId?: string;
  childDecisionId?: string;
  answer?: string;
  answeredAt?: string;
  answeredBy?: "owner" | "coordinator" | "connector";
  source?: ConnectorSource;
  /**
   * What the coordinator would answer and why, with how the recorded answer compared. Absent on a decision asked by a
   * coordinator started before recommendations were required.
   */
  recommendation?: DecisionRecommendation;
}
/** A time the coordinator asked to look again. `fired` means the host woke the coordinator; it records no outcome. */
export interface MissionFollowUp {
  id: string;
  dueAt: string;
  reason: string;
  check: string;
  createdAt: string;
  state: "open" | "fired" | "cancelled";
  settledAt?: string;
}
export type MissionOrigin = { kind: "intake"; issueId: string; identifier: string; url: string; rule: string; source?: ConnectorSource };
export type MissionInputSource = "slack" | ConnectorSource;
export interface Mission {
  id: string;
  groupId: string;
  /** Set when an intake rule created the mission from a Linear issue. */
  origin?: MissionOrigin;
  /** `answer` when the coordinator may only read and report an answer; absent for a work mission. */
  mode?: "answer";
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
  /** `deadline` while the mission is blocked because its approved time ran out: its subteams are paused, their
   * workspaces are kept, and the owner may extend it. Absent for every other status or reason. */
  stopReason?: "deadline";
  /** Views only. Set while an intake mission's clock is stopped, because it waits on the owner or is paused. `deadlineAt`
   * then leaves out the stopped span: the time left is `deadlineAt` minus this, and the deadline moves when the clock restarts. */
  clockStoppedAt?: string;
  createdAt: string;
  updatedAt: string;
  lineup: TeamLineup;
  coordinator?: { memberId: string; sessionId: string; status: "running" | "waiting" | "stopped" };
  dispatchSummary?: string;
  subtasks: MissionSubtask[];
  decisions: MissionDecision[];
  steering: { text: string; revision: number; at: string; source?: MissionInputSource | GithubReviewSource }[];
  events: { at: string; text: string }[];
  result?: { summary: string; revision: number; at: string };
  earlierResults?: { summary: string; revision: number; at: string }[];
  /** Open follow-ups and the 10 most recently settled. Absent on missions that never set one. */
  followUps?: MissionFollowUp[];
  /** Computed on read from the coordinator and subteams; never stored. */
  usage?: UsageRollup;
}

/** One row of the owner's board, across missions and runs started outside a mission. */
export type BoardColumn = "needs-input" | "working" | "review" | "ended";
/** One of several starts of the same work: missions or standalone runs of one project with the same objective. */
export interface BoardAttempt {
  /** Shared by every attempt of the work. */
  workId: string;
  /** Position among the attempts the host still holds, oldest first, from 1. */
  number: number;
  of: number;
  /** A newer attempt exists and this one is blocked or cancelled, so a client may fold it behind the newest. */
  superseded: boolean;
}
export interface BoardItem {
  kind: "mission" | "team" | "goal";
  id: string;
  title: string;
  groupId?: string;
  /** Project (group) name, or the host project name for runs outside a group. */
  projectName: string;
  column: BoardColumn;
  status: string;
  /** Deadline stop reason for missions; absent when the mission has no stop reason. */
  stopReason?: "deadline";
  /** One line: the open question, the block reason, or the current step. */
  detail: string;
  createdAt: string;
  updatedAt: string;
  subtasks?: { total: number; running: number; done: number };
  /** Present only when the host holds more than one attempt of this work. */
  attempt?: BoardAttempt;
}
export interface Board {
  items: BoardItem[];
}
