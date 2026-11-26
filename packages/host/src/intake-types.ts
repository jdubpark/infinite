import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { CreateMission } from "./mission-types.js";
import { projectGroupIdSchema } from "./project-group-types.js";
import type { IntakeRoute } from "./intake-route.js";

export const intakeConfigSchema = z.object({
  linear: z.object({
    teamIds: z.array(z.uuid()).min(1).max(20),
    creatorId: z.uuid(),
    label: z.string().trim().min(1).max(80),
    commentsMirrorToSlack: z.boolean().default(false),
    admitIssues: z.boolean().default(true),
  }).strict(),
  slack: z.object({
    appTokenFile: z.string().refine(isAbsolute),
    botTokenFile: z.string().refine(isAbsolute),
    teamId: z.string().regex(/^T[A-Z0-9]{2,20}$/),
    ownerUserId: z.string().regex(/^[UW][A-Z0-9]{2,20}$/),
    linearAgentUserId: z.string().regex(/^[UW][A-Z0-9]{2,20}$/).optional(),
    bindByMention: z.boolean().default(false),
    directRequests: z.boolean().default(false),
    ownerOnlyInJoinedChannels: z.boolean().optional(),
    answerQuestions: z.boolean().default(false),
    requestChannelIds: z.array(z.string().regex(/^[CG][A-Z0-9]{2,20}$/)).max(20)
      .refine(ids => new Set(ids).size === ids.length, "requestChannelIds must be unique").optional(),
    organizationScope: z.object({
      channelIds: z.array(z.string().regex(/^[CG][A-Z0-9]{2,20}$/)).max(20)
        .refine(ids => new Set(ids).size === ids.length, "organizationScope.channelIds must be unique").optional(),
      workspaces: z.array(z.object({
        projectId: z.string().regex(/^[a-z0-9-]{1,80}$/),
        path: z.string().refine(value => isAbsolute(value) && resolve(value) === value, "Workspace paths must be absolute canonical paths"),
        repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).nullable(),
        rootCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i).optional(),
      }).strict().superRefine((workspace, context) => {
        if (workspace.repository === null && !workspace.rootCommit)
          context.addIssue({ code: "custom", path: ["rootCommit"], message: "Local-only workspaces must pin their Git root commit" });
        if (workspace.repository !== null && workspace.rootCommit !== undefined)
          context.addIssue({ code: "custom", path: ["rootCommit"], message: "GitHub workspaces must not set rootCommit" });
      })).min(1, "organizationScope.workspaces must pin at least one workspace").max(64)
        .refine(workspaces => new Set(workspaces.map(value => value.projectId)).size === workspaces.length, "organizationScope.workspaces projectIds must be unique")
        .refine(workspaces => new Set(workspaces.map(value => value.path)).size === workspaces.length, "organizationScope.workspaces paths must be unique"),
    }).strict(),
    classify: z.boolean().default(false),
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
export interface SlackOrganizationScope {
  channelIds?: string[];
  workspaces: { projectId: string; path: string; repository: string | null; rootCommit?: string }[];
}

export type IntakeState = "queued" | "started" | "finished" | "skipped";
export type IntakeSkipReason = "creator-mismatch" | "no-slack-thread" | "thread-unreadable" | "no-owner-mention";
export type IntakeMessageKind = "ack" | "started" | "question" | "result" | "status" | "edit-note" | "reply";
export interface IntakeThread { channelId: string; threadTs: string }

interface IntakeMessageBase {
  key: string;
  kind: IntakeMessageKind;
  text: string;
  createdAt: string;
  attempts: number;
  blocks?: Record<string, unknown>[];
}

export type IntakeMessage =
  | (IntakeMessageBase & { status: "pending"; uncertain?: boolean; nextAttemptAt?: string; error?: string; ts?: never })
  | (IntakeMessageBase & { status: "sent"; ts: string; uncertain?: never; nextAttemptAt?: never; error?: never })
  | (IntakeMessageBase & { status: "failed"; error: string; uncertain?: boolean; nextAttemptAt?: never; ts?: never });

export interface IntakeInbound {
  eventId: string; ts: string; text: string; receivedAt: string; handledAt?: string; outcome?: string;
  entrypoint?: "channel-message";
  call?: { action: "answer" | "steer" | "pause" | "resume" | "cancel" | "extend"; decisionId?: string; text?: string; minutes?: number; revision: number };
  interactionId?: string;
}

export interface IntakeDirect {
  eventId: string; ts: string; text: string; filedAt?: string;
  entrypoint?: "channel-message";
  route?: IntakeRoute & { at: string };
  routable?: true;
}

export interface IntakeComment { id: string; body: string; delivered: boolean; attempts: number; error?: string }

export interface IntakeExternalScope {
  groupId: string;
  repositories: { projectId: string; key?: string; checkouts: { projectId: string; path: string; primary: boolean }[] }[];
  selectedCheckouts: string[];
}

export interface IntakeExternal {
  connectorId: string;
  requestId: string;
  fingerprint: string;
  scope: IntakeExternalScope;
  filedAt?: string;
}

interface IntakeRecordBase {
  issueId: string;
  identifier: string;
  url: string;
  slackAudienceId?: string;
  title: string;
  description: string;
  issueCreatedAt: string;
  issueUpdatedAt: string;
  direct?: IntakeDirect;
  external?: IntakeExternal;
  editNotedAt?: string;
  deadlineNoticeFor?: string;
  tracked?: { title: string; description: string };
  comments: { started?: IntakeComment; outcome?: IntakeComment };
  messages: IntakeMessage[];
  questions: { decisionId: string; n: number }[];
  inbound: IntakeInbound[];
  createdAt: string;
  updatedAt: string;
}

export type IntakeRecord =
  | (IntakeRecordBase & {
      state: "skipped";
      skipReason: IntakeSkipReason;
      rule?: never;
      holdReason?: never;
      thread?: never;
      request?: never;
      missionId?: never;
      closure?: never;
    })
  | (IntakeRecordBase & {
      state: "queued";
      skipReason?: never;
      rule?: string;
      holdReason?: string;
      thread?: IntakeThread;
      request?: CreateMission;
      missionId?: never;
      closure?: never;
    })
  | (IntakeRecordBase & {
      state: "started" | "finished";
      skipReason?: never;
      rule: string;
      holdReason?: never;
      thread?: IntakeThread;
      request?: CreateMission;
      missionId: string;
      closure?: { reason: string; at: string };
    });

export interface IntakeView {
  issueId: string; identifier: string; url: string; title: string; state: IntakeState;
  skipReason?: IntakeSkipReason; holdReason?: string; missionId?: string; threadBound: boolean;
  route?: IntakeRoute & { at: string };
  comments: { started?: "pending" | "delivered"; outcome?: "pending" | "delivered" };
  messages: { key: string; kind: IntakeMessageKind; status: IntakeMessage["status"]; ts?: string; error?: string }[];
}

export interface SlackThreadMessage { ts: string; user?: string; botId?: string; text: string; key?: string }

export interface IntakeThreadReader {
  thread(binding: IntakeThread): Promise<SlackThreadMessage[] | "unreadable">;
  organizationChannelAllowed?(channelId: string): Promise<boolean>;
  permalink?(binding: IntakeThread, ts: string): Promise<string>;
}

export function deterministicUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256").update(`${namespace}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const missionRequestId = (issueId: string) => deterministicUuid("intake-mission", issueId);
