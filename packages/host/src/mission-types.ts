import type { ConnectorSource } from "./mcp-types.js";
import { z } from "zod";
import { blockerEvidenceSchema, storedUsageRollupSchema, type TeamLineup, type TeamStatus } from "./team-types.js";
import type { StoredRollup, UsageRollup } from "./team-usage.js";
import { projectGroupIdSchema } from "./project-group-types.js";
import { questionRecommendationSchema, refineQuestion, requiredQuestionRecommendationSchema, type DecisionRecommendation } from "./question-recommendation.js";

const subtaskId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const connectorSourceSchema = z.object({ kind: z.literal("connector"), id: z.string().min(1), name: z.string().min(1) }).strict();
const decisionRecommendationSchema = questionRecommendationSchema.extend({
  outcome: z.enum(["matched", "different", "other"]).optional(),
}).strict();
const teamStatusValues = ["planning", "discovering", "implementing", "integrating", "verifying", "reviewing", "delivering", "merged", "needs-input", "paused", "blocked", "ready-for-review", "no-change", "cancelled"] as const;

export const createMissionSchema = z.object({
  requestId: z.uuid(),
  groupId: projectGroupIdSchema,
  title: z.string().trim().min(1).max(100).optional(),
  objective: z.string().trim().min(1).max(24000),
  maxSubtasks: z.number().int().min(1).max(12).default(8),
  maxMinutes: z.number().int().min(5).max(1440).default(240),
  checkouts: z.array(z.string().regex(/^[a-z0-9-]{1,80}$/)).max(64).optional(),
  mode: z.literal("answer").optional(),
}).strict();
export type CreateMission = z.infer<typeof createMissionSchema>;
export const missionActionSchema = z.object({ requestId: z.uuid(), revision: z.number().int().min(1) }).strict();
export const missionTextSchema = missionActionSchema.extend({ text: z.string().trim().min(1).max(8000) }).strict();
export const missionExtendSchema = missionActionSchema.extend({ minutes: z.number().int().min(5).max(1440) }).strict();

export const missionSubtaskPlanSchema = z.object({
  id: subtaskId,
  repoProjectId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  title: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(12000),
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
  z.object({ kind: z.literal("steer-subtask"), subtaskId, text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("result"), summary: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ kind: z.literal("blocked"), summary: z.string().trim().min(1).max(4000), blocker: blockerEvidenceSchema.optional() }).strict(),
  z.object({ kind: z.literal("wait"), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("follow-up"), inMinutes: z.number().int().min(5).max(10080), reason: z.string().trim().min(1).max(500), check: z.string().trim().min(1).max(1000) }).strict(),
] as const;
export const missionReportSchema = z.discriminatedUnion("kind", [...missionReportVariants,
  z.object({ ...missionQuestionShape, recommendation: requiredQuestionRecommendationSchema }).strict().superRefine(refineQuestion)]);
export const recordedMissionReportSchema = z.discriminatedUnion("kind", [...missionReportVariants,
  z.object({ ...missionQuestionShape, recommendation: questionRecommendationSchema.optional() }).strict().superRefine(refineQuestion)]);
export type MissionReport = z.infer<typeof recordedMissionReportSchema>;
export const missionNoteSchema = z.string().trim().min(1).max(2000)
  .describe("Optional. What the mission state does not show: decisions and their reasons, what you are waiting for, and what to check next.");
export const missionReportArgumentsSchema = z.object({ report: missionReportSchema, note: missionNoteSchema.optional() }).strict();
export const missionReportEnvelopeSchema = z.object({ requestId: z.uuid(), missionId: z.uuid(), memberId: z.uuid(), revision: z.number().int().min(1), report: recordedMissionReportSchema, note: missionNoteSchema.optional() }).strict();

export type MissionStatus = "planning" | "working" | "needs-input" | "paused" | "blocked" | "ready-for-review" | "cancelled";
export interface MissionSubtaskFinalEvidence {
  reason?: string;
  headCommit?: string;
  usage?: StoredRollup;
}
export interface MissionSubtask extends MissionSubtaskPlan {
  status: "queued" | "running" | "done" | "cancelled" | "blocked";
  teamId?: string;
  teamStatus?: TeamStatus;
  finalEvidence?: MissionSubtaskFinalEvidence;
}
export type QueuedMissionSubtask = MissionSubtaskPlan & {
  status: "queued";
  teamId?: never;
  teamStatus?: never;
  finalEvidence?: never;
};
export type ActiveMissionSubtask = MissionSubtaskPlan & {
  status: "running" | "done";
  teamId: string;
  teamStatus?: TeamStatus;
  finalEvidence?: never;
};
export type BlockedBeforeLaunchMissionSubtask = MissionSubtaskPlan & {
  status: "blocked";
  teamId?: never;
  teamStatus?: never;
  finalEvidence?: never;
};
export type BlockedSubteamMissionSubtask = MissionSubtaskPlan & {
  status: "blocked";
  teamId: string;
  teamStatus?: TeamStatus;
  finalEvidence?: never;
};
export type BlockedMissionSubtask = BlockedBeforeLaunchMissionSubtask | BlockedSubteamMissionSubtask;
export type CancelledMissionSubtask = MissionSubtaskPlan & {
  status: "cancelled";
  teamId?: string;
  teamStatus?: TeamStatus;
  finalEvidence?: MissionSubtaskFinalEvidence;
};
export type MissionSubtaskState =
  | QueuedMissionSubtask
  | ActiveMissionSubtask
  | BlockedMissionSubtask
  | CancelledMissionSubtask;
export function projectMissionSubtask(subtask: MissionSubtask): MissionSubtaskState {
  if (subtask.status === "queued") {
    if (subtask.teamId !== undefined || subtask.teamStatus !== undefined || subtask.finalEvidence !== undefined) {
      throw new Error("Invalid mission subtask state: queued subtask cannot carry teamId, teamStatus, or finalEvidence.");
    }
    const { teamId: _teamId, teamStatus: _teamStatus, finalEvidence: _finalEvidence, ...base } = subtask;
    return { ...base, status: "queued" };
  }
  if (subtask.status === "cancelled") {
    if (subtask.teamId === "") {
      throw new Error("Invalid mission subtask state: teamId cannot be empty.");
    }
    return { ...subtask, status: "cancelled" };
  }
  if (subtask.finalEvidence !== undefined) {
    throw new Error(`Invalid mission subtask state: ${subtask.status} subtask cannot carry finalEvidence.`);
  }
  if (subtask.status === "blocked") {
    if (subtask.teamId === undefined) {
      if (subtask.teamStatus !== undefined) {
        throw new Error("Invalid mission subtask state: launch-blocked subtask without teamId cannot carry teamStatus.");
      }
      const { teamId: _teamId, teamStatus: _teamStatus, finalEvidence: _finalEvidence, ...base } = subtask;
      return { ...base, status: "blocked" };
    }
    if (subtask.teamId.length === 0) {
      throw new Error("Invalid mission subtask state: teamId cannot be empty.");
    }
    const { finalEvidence: _finalEvidence, ...rest } = subtask;
    return { ...rest, status: "blocked", teamId: subtask.teamId };
  }
  if (typeof subtask.teamId !== "string" || subtask.teamId.length === 0) {
    throw new Error(`Invalid mission subtask state: ${subtask.status} subtask requires a non-empty teamId.`);
  }
  const { finalEvidence: _finalEvidence, ...rest } = subtask;
  return { ...rest, status: subtask.status, teamId: subtask.teamId };
}
export const missionSubtaskSchema: z.ZodType<MissionSubtaskState> = z.union([
  missionSubtaskPlanSchema.extend({ status: z.literal("queued") }).strict(),
  missionSubtaskPlanSchema.extend({
    status: z.literal("running"),
    teamId: z.string().min(1),
    teamStatus: z.enum(teamStatusValues).optional(),
  }).strict(),
  missionSubtaskPlanSchema.extend({
    status: z.literal("done"),
    teamId: z.string().min(1),
    teamStatus: z.enum(teamStatusValues).optional(),
  }).strict(),
  missionSubtaskPlanSchema.extend({ status: z.literal("blocked") }).strict(),
  missionSubtaskPlanSchema.extend({
    status: z.literal("blocked"),
    teamId: z.string().min(1),
    teamStatus: z.enum(teamStatusValues).optional(),
  }).strict(),
  missionSubtaskPlanSchema.extend({
    status: z.literal("cancelled"),
    teamId: z.string().min(1).optional(),
    teamStatus: z.enum(teamStatusValues).optional(),
    finalEvidence: z.object({
      reason: z.string().optional(),
      headCommit: z.string().optional(),
      usage: storedUsageRollupSchema.optional(),
    }).strict().optional(),
  }).strict(),
]);
export interface MissionDecision {
  id: string;
  question: string;
  options: string[];
  answerMode?: "approval" | "single" | "multiple";
  createdAt: string;
  subtaskId?: string;
  childDecisionId?: string;
  answer?: string;
  answeredAt?: string;
  answeredBy?: "owner" | "coordinator" | "connector";
  source?: ConnectorSource;
  recommendation?: DecisionRecommendation;
}
type MissionDecisionBase = Omit<MissionDecision, "subtaskId" | "childDecisionId" | "answer" | "answeredAt" | "answeredBy" | "source">;
type MissionDecisionForwarding =
  | { subtaskId?: string; childDecisionId?: never }
  | { subtaskId: string; childDecisionId: string };
type MissionDecisionCore = MissionDecisionBase & MissionDecisionForwarding;
export type OpenMissionDecision = MissionDecisionCore & {
  answer?: never;
  answeredAt?: never;
  answeredBy?: never;
  source?: never;
};
export type AnsweredMissionDecision = MissionDecisionCore & (
  | { answer: string; answeredAt?: string; answeredBy?: "owner" | "coordinator"; source?: never }
  | { answer: string; answeredAt?: string; answeredBy: "connector"; source?: ConnectorSource }
);
export type MissionDecisionState =
  | { state: "open"; decision: OpenMissionDecision }
  | { state: "answered"; decision: AnsweredMissionDecision };
const validMissionDecisionForwarding = (decision: MissionDecision) =>
  decision.childDecisionId === undefined || decision.subtaskId !== undefined;
export function isOpenMissionDecision(decision: MissionDecision): decision is OpenMissionDecision {
  return validMissionDecisionForwarding(decision)
    && decision.answer === undefined
    && decision.answeredAt === undefined
    && decision.answeredBy === undefined
    && decision.source === undefined;
}
export function isAnsweredMissionDecision(decision: MissionDecision): decision is AnsweredMissionDecision {
  if (!validMissionDecisionForwarding(decision)) return false;
  if (typeof decision.answer !== "string" || decision.answer.length === 0) return false;
  if (decision.source !== undefined && decision.answeredBy !== "connector") return false;
  return true;
}
export function projectMissionDecision(decision: MissionDecision): MissionDecisionState {
  if (isOpenMissionDecision(decision)) return { state: "open", decision };
  if (isAnsweredMissionDecision(decision)) return { state: "answered", decision };
  throw new Error("Invalid mission decision state: answer, answeredBy, answeredAt, source, or forwarding fields are inconsistent.");
}
const missionDecisionBaseShape = {
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string()),
  answerMode: z.enum(["approval", "single", "multiple"]).optional(),
  createdAt: z.iso.datetime(),
  recommendation: decisionRecommendationSchema.optional(),
};
const directMissionDecisionShape = { ...missionDecisionBaseShape, subtaskId: subtaskId.optional() };
const forwardedMissionDecisionShape = { ...missionDecisionBaseShape, subtaskId, childDecisionId: z.uuid() };
export const missionDecisionSchema: z.ZodType<OpenMissionDecision | AnsweredMissionDecision> = z.union([
  z.object(directMissionDecisionShape).strict(),
  z.object(forwardedMissionDecisionShape).strict(),
  z.object({
    ...directMissionDecisionShape,
    answer: z.string().min(1),
    answeredAt: z.iso.datetime().optional(),
    answeredBy: z.enum(["owner", "coordinator"]).optional(),
  }).strict(),
  z.object({
    ...forwardedMissionDecisionShape,
    answer: z.string().min(1),
    answeredAt: z.iso.datetime().optional(),
    answeredBy: z.enum(["owner", "coordinator"]).optional(),
  }).strict(),
  z.object({
    ...directMissionDecisionShape,
    answer: z.string().min(1),
    answeredAt: z.iso.datetime().optional(),
    answeredBy: z.literal("connector"),
    source: connectorSourceSchema.optional(),
  }).strict(),
  z.object({
    ...forwardedMissionDecisionShape,
    answer: z.string().min(1),
    answeredAt: z.iso.datetime().optional(),
    answeredBy: z.literal("connector"),
    source: connectorSourceSchema.optional(),
  }).strict(),
]);
interface MissionFollowUpBase {
  id: string;
  dueAt: string;
  reason: string;
  check: string;
  createdAt: string;
}
export type MissionFollowUp =
  | (MissionFollowUpBase & { state: "open"; settledAt?: never })
  | (MissionFollowUpBase & { state: "fired" | "cancelled"; settledAt: string });
const missionFollowUpBaseShape = {
  id: z.string().min(1),
  dueAt: z.iso.datetime(),
  reason: z.string().min(1),
  check: z.string().min(1),
  createdAt: z.iso.datetime(),
};
export const missionFollowUpSchema: z.ZodType<MissionFollowUp> = z.discriminatedUnion("state", [
  z.object({ ...missionFollowUpBaseShape, state: z.literal("open") }).strict(),
  z.object({ ...missionFollowUpBaseShape, state: z.literal("fired"), settledAt: z.iso.datetime() }).strict(),
  z.object({ ...missionFollowUpBaseShape, state: z.literal("cancelled"), settledAt: z.iso.datetime() }).strict(),
]);
export type MissionOrigin = { kind: "intake"; issueId: string; identifier: string; url: string; rule: string; source?: ConnectorSource };
export type MissionInputSource = "slack" | ConnectorSource;
export interface Mission {
  id: string;
  groupId: string;
  origin?: MissionOrigin;
  mode?: "answer";
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
  stopReason?: "deadline";
  clockStoppedAt?: string;
  createdAt: string;
  updatedAt: string;
  lineup: TeamLineup;
  coordinator?: { memberId: string; sessionId: string; status: "running" | "waiting" | "stopped" };
  dispatchSummary?: string;
  subtasks: MissionSubtask[];
  decisions: MissionDecision[];
  steering: { text: string; revision: number; at: string; source?: MissionInputSource }[];
  events: { at: string; text: string }[];
  result?: { summary: string; revision: number; at: string };
  followUps?: MissionFollowUp[];
  usage?: UsageRollup;
}

export type BoardColumn = "needs-input" | "working" | "review" | "ended";
export interface BoardAttempt {
  workId: string;
  number: number;
  of: number;
  superseded: boolean;
}
interface BoardItemBase {
  id: string;
  title: string;
  groupId?: string;
  projectName: string;
  column: BoardColumn;
  status: string;
  detail: string;
  createdAt: string;
  updatedAt: string;
  attempt?: BoardAttempt;
}
export type BoardItem =
  | (BoardItemBase & {
      kind: "mission";
      stopReason?: "deadline";
      subtasks?: { total: number; running: number; done: number };
    })
  | (BoardItemBase & {
      kind: "team" | "goal";
      stopReason?: never;
      subtasks?: never;
    });
const boardAttemptSchema = z.object({
  workId: z.string().min(1),
  number: z.number().int().min(1),
  of: z.number().int().min(1),
  superseded: z.boolean(),
}).strict();
const boardItemBaseShape = {
  id: z.string().min(1),
  title: z.string().min(1),
  groupId: z.string().min(1).optional(),
  projectName: z.string().min(1),
  column: z.enum(["needs-input", "working", "review", "ended"]),
  status: z.string().min(1),
  detail: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  attempt: boardAttemptSchema.optional(),
};
export const boardItemSchema: z.ZodType<BoardItem> = z.discriminatedUnion("kind", [
  z.object({
    ...boardItemBaseShape,
    kind: z.literal("mission"),
    stopReason: z.literal("deadline").optional(),
    subtasks: z.object({
      total: z.number().int().min(0),
      running: z.number().int().min(0),
      done: z.number().int().min(0),
    }).strict().optional(),
  }).strict(),
  z.object({ ...boardItemBaseShape, kind: z.literal("team") }).strict(),
  z.object({ ...boardItemBaseShape, kind: z.literal("goal") }).strict(),
]);
export interface Board {
  items: BoardItem[];
}
