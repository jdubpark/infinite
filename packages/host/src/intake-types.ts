import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { CreateMission } from "./mission-types.js";
import { projectGroupIdSchema } from "./project-group-types.js";

export const intakeConfigSchema = z.object({
  linear: z.object({
    teamIds: z.array(z.uuid()).min(1).max(20),
    creatorId: z.uuid(),
    label: z.string().trim().min(1).max(80),
    commentsMirrorToSlack: z.boolean().default(false),
  }).strict(),
  slack: z.object({
    appTokenFile: z.string().refine(isAbsolute),
    botTokenFile: z.string().refine(isAbsolute),
    teamId: z.string().regex(/^T[A-Z0-9]{2,20}$/),
    ownerUserId: z.string().regex(/^[UW][A-Z0-9]{2,20}$/),
    // Mention markup names users only (`<@U…>` or `<@W…>`), so a bot ID would never match.
    linearAgentUserId: z.string().regex(/^[UW][A-Z0-9]{2,20}$/).optional(),
    bindByMention: z.boolean().default(false),
    endpoint: z.url().optional(),
  }).strict().optional(),
  mission: z.object({
    groupId: projectGroupIdSchema,
    maxSubtasks: z.number().int().min(1).max(12).default(8),
    maxMinutes: z.number().int().min(5).max(1440).default(240),
    answerProjectId: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
  }).strict(),
  maxActive: z.number().int().min(1).max(12).default(3),
  requireSlackThread: z.boolean().default(true),
}).strict();
export type IntakeConfig = z.infer<typeof intakeConfigSchema>;

export type IntakeState = "queued" | "started" | "finished" | "skipped";
export type IntakeSkipReason = "creator-mismatch" | "no-slack-thread" | "thread-unreadable" | "no-owner-mention";
export type IntakeMessageKind = "ack" | "started" | "question" | "result" | "status" | "edit-note" | "reply";
export interface IntakeThread { channelId: string; threadTs: string }
export interface IntakeMessage {
  key: string; kind: IntakeMessageKind; text: string; createdAt: string;
  status: "pending" | "sent" | "failed"; attempts: number;
  /** The last send may have reached Slack; look the key up in the thread before sending again. */
  uncertain?: boolean; nextAttemptAt?: string; ts?: string; error?: string;
}
export interface IntakeInbound {
  eventId: string; ts: string; text: string; receivedAt: string; handledAt?: string; outcome?: string;
  /** The mission call chosen for this event, saved before the call; a replay performs exactly this call. */
  call?: { action: "answer" | "steer" | "pause" | "resume" | "cancel"; decisionId?: string; text?: string; revision: number };
}
export interface IntakeComment { id: string; body: string; delivered: boolean; attempts: number; error?: string }
export interface IntakeRecord {
  issueId: string; identifier: string; url: string; title: string; description: string;
  issueCreatedAt: string; issueUpdatedAt: string;
  state: IntakeState; rule?: string; skipReason?: IntakeSkipReason;
  /** Why a queued record has not started: "max-active" or a refusal from the mission service. */
  holdReason?: string;
  /** Absent on skipped records, so a skipped issue never binds a thread. */
  thread?: IntakeThread;
  /** Saved before the mission is created and reused verbatim on every retry. */
  request?: CreateMission;
  missionId?: string;
  closure?: { reason: string; at: string };
  editNotedAt?: string;
  comments: { started?: IntakeComment; outcome?: IntakeComment };
  messages: IntakeMessage[];
  questions: { decisionId: string; n: number }[];
  inbound: IntakeInbound[];
  createdAt: string; updatedAt: string;
}
export interface IntakeView {
  issueId: string; identifier: string; url: string; title: string; state: IntakeState;
  skipReason?: IntakeSkipReason; holdReason?: string; missionId?: string; threadBound: boolean;
  comments: { started?: "pending" | "delivered"; outcome?: "pending" | "delivered" };
  messages: { key: string; kind: IntakeMessageKind; status: IntakeMessage["status"]; ts?: string; error?: string }[];
}
export interface SlackThreadMessage { ts: string; user?: string; botId?: string; text: string; key?: string }
/** `unreadable` is Slack's refusal (not in channel, no such thread); a thrown error is an outage. */
export interface IntakeThreadReader { thread(binding: IntakeThread): Promise<SlackThreadMessage[] | "unreadable"> }
/** A stable RFC 9562 UUID: SHA-256 of `${namespace}:${value}`, first 16 bytes, version nibble 5, variant 10. */
export function deterministicUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256").update(`${namespace}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export const missionRequestId = (issueId: string) => deterministicUuid("intake-mission", issueId);
