import type { Prompt } from "@infinite/attention";
import type { PermissionDelivery, PermissionTier } from "./evidence/permission-journal.js";
import type { InterruptClass, RejectCode } from "./permission-policy.js";

export type PermissionRequesterKind = "team-member" | "session" | "headless";

export interface PermissionRequester {
  kind: PermissionRequesterKind;
  sessionId: string;
  projectId: string;
  taskId: string;
  assignment: string;
  role?: string;
  provider: string;
  model?: string;
  sessionRoot: string;
  scratchRoots: string[];
  task: { title: string; text: string };
}

export interface PermissionRequestShape {
  completeEvidence: boolean;
  oneShotAccept: boolean;
  oneShotReject: boolean;
  persistentOnly: boolean;
  trustPrompt: boolean;
}

export interface PermissionEvidence {
  files: Array<{ path: string; sha256: string; content: string }>;
  limitations: string[];
  digest: string;
}

export interface PermissionRequest {
  id: string;
  requester: PermissionRequester;
  tool: string;
  input?: Record<string, unknown>;
  action: string;
  prompt?: Prompt;
  destructive?: { pattern: string };
  shape: PermissionRequestShape;
  evidenceHash: string;
  reuseKey?: string;
  evidence?: PermissionEvidence;
  deliveryCommands?: string[];
}

export interface PermissionClassMatch {
  interruptClass: InterruptClass;
  rule: string;
}

export type PermissionQualification =
  | { qualified: true }
  | { qualified: false; reason: "incomplete-evidence" | "no-one-shot-accept" | "no-one-shot-reject" };

export interface PermissionRejectRef {
  id: string;
  tool: string;
  action: string;
  code: RejectCode;
}

export interface PermissionReviewContext {
  requesterFamily: string | undefined;
  interruptClasses: readonly string[];
  direction?: string;
  openRejects: PermissionRejectRef[];
  evidenceRejects: PermissionRejectRef[];
  raised: string[];
  canAllow: boolean;
  collect?: (paths: string[]) => Promise<PermissionEvidence>;
  held?: () => boolean;
  signal?: AbortSignal;
}

interface PermissionReviewBase {
  note?: string;
  tiers: PermissionTier[];
}

export type PermissionReview =
  | (PermissionReviewBase & { verdict: "allow"; code?: never; interruptClass?: never; repeats?: never })
  | (PermissionReviewBase & { verdict: "reject"; code: RejectCode; repeats?: string; interruptClass?: never })
  | (PermissionReviewBase & { verdict: "owner"; interruptClass: InterruptClass; code?: never; repeats?: never });

export interface PermissionReadiness {
  ready: boolean;
  reasons: string[];
}

export class PermissionReviewHeld extends Error {
  constructor() {
    super("A permission review turn is held by the launch gate.");
    this.name = "PermissionReviewHeld";
  }
}

export interface PermissionAgentCore {
  readiness(): PermissionReadiness;
  binding(): string;
  familyOf(profile: { provider: string; model?: string }): string | undefined;
  classify(request: PermissionRequest, interruptClasses: readonly string[]): PermissionClassMatch | undefined;
  qualify(request: PermissionRequest): PermissionQualification;
  raise(request: PermissionRequest, context: { rejectHistory: boolean }): string[];
  readRules(request: PermissionRequest, interruptClasses: readonly string[]): { match: PermissionClassMatch | undefined; raised: string[] };
  review(request: PermissionRequest, context: PermissionReviewContext): Promise<PermissionReview>;
}

export type PermissionServed = { served: true } | { served: false; reason: "not-covered" | "not-ready" };

export type PermissionOutcome =
  | { kind: "not-served"; reason: "not-covered" | "not-ready" }
  | { kind: "owner"; decisionId: string; interruptClass: InterruptClass }
  | { kind: "held" }
  | { kind: "undeliverable"; reason: string }
  | { kind: "allow"; decisionId: string; strongTier: boolean }
  | { kind: "reject"; decisionId: string; code: RejectCode; notice: string };

export interface PermissionDecideOptions {
  signal?: AbortSignal;
  collect?: (paths: string[]) => Promise<PermissionEvidence>;
}

export interface PermissionPipeline {
  serves(projectId: string): PermissionServed;
  classOf(request: PermissionRequest): PermissionClassMatch | undefined;
  decide(request: PermissionRequest, options?: PermissionDecideOptions): Promise<PermissionOutcome>;
  applicable(decisionId: string, request?: PermissionRequest): boolean;
  halted?(projectId: string): boolean;
  recordDelivery(decisionId: string, kind: PermissionDelivery["kind"], detail?: string): void;
  taskEnded(taskId: string): void;
}

export interface PermissionInteractiveTarget {
  request: PermissionRequest;
  check(): Promise<
    | { ok: true; accept?: number; reject?: number }
    | { ok: false; stale: boolean; reason: string }
  >;
  answer(option: number, decisionId: string, notice?: string, current?: () => boolean): Promise<"delivered" | "refused" | "uncertain">;
  fence?(): Promise<boolean>;
  signal?: AbortSignal;
  collect?: (paths: string[]) => Promise<PermissionEvidence>;
}

export type PermissionHandled =
  | { handled: false; reason: string; held?: true }
  | { handled: true; result: "allowed"; decisionId: string; delivery: "receipt"; code?: never; interruptClass?: never }
  | { handled: true; result: "rejected"; decisionId: string; code: RejectCode; delivery: "receipt"; interruptClass?: never }
  | { handled: true; result: "owner"; decisionId: string; interruptClass: InterruptClass; code?: never; delivery?: never }
  | { handled: true; result: "undeliverable" | "stale"; decisionId?: string; code?: RejectCode; delivery?: "refusal" | "uncertain"; interruptClass?: never };

export interface PermissionDeliveryService {
  handle(target: PermissionInteractiveTarget): Promise<PermissionHandled>;
  holder(sessionId: string, promptId: number): "agent" | "owner" | "undecided";
  fenceRetired?(): Promise<boolean>;
  ownerClass?(sessionId: string, promptId: number): InterruptClass | undefined;
}

interface HeadlessSessionStatusBase {
  sessionId: string;
  projectId: string;
  title: string;
  provider: string;
}

export type HeadlessSessionStatus =
  | (HeadlessSessionStatusBase & {
      state: "served";
      waiting?: { interruptClass: string; tool: string; since: string; expiresAt: string };
      reason?: never;
    })
  | (HeadlessSessionStatusBase & {
      state: "admitted" | "not-served";
      reason: string;
      waiting?: never;
    });

export interface HeadlessShadowedRule {
  sessionId: string;
  rule: string;
  interruptClass: InterruptClass;
  classRule: string;
}

export interface HeadlessChannelStatus {
  sessions: HeadlessSessionStatus[];
  shadowed: HeadlessShadowedRule[];
}

export interface PermissionHeadlessChannel {
  status(): Promise<HeadlessChannelStatus>;
}

export interface PermissionAgentServices {
  core?: PermissionAgentCore;
  pipeline?: PermissionPipeline;
  delivery?: PermissionDeliveryService;
  headless?: PermissionHeadlessChannel;
}
