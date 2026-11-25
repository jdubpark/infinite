import type { Attention } from "@infinite/attention";
import { z } from "zod";
export type Role = "owner" | "controller" | "viewer";
export type Provider = "claude" | "codex" | "grok" | "opencode" | "demo";
export type Status =
  | "starting"
  | "running"
  | "exited"
  | "unavailable"
  | "recording-error";
export interface ControlActor {
  id: string;
  label: string;
}
export interface ControlLease {
  id: string;
  label: string;
  expiresAt: number;
}
export interface TerminalSnapshot {
  ansi: string;
  seq: number;
  cols: number;
  rows: number;
  capturedAt: string;
}
interface SessionRuntimeBase {
  id: string;
  location: "local" | "cloud";
}
export type SessionRuntime =
  | (SessionRuntimeBase & {
      transport: "pty";
      nativeUi?: "codex" | "opencode";
    })
  | (SessionRuntimeBase & {
      transport: "cmux";
      nativeUi?: never;
    });
export const sessionRuntimeSchema: z.ZodType<SessionRuntime> = z.discriminatedUnion("transport", [
  z.object({
    id: z.string().min(1),
    location: z.enum(["local", "cloud"]),
    transport: z.literal("pty"),
    nativeUi: z.enum(["codex", "opencode"]).optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    location: z.enum(["local", "cloud"]),
    transport: z.literal("cmux"),
  }).strict(),
]);
export interface LaptopWorkspace {
  cwd: string;
  roots: string[];
}
export interface ExecutionCheckpoint {
  id: string;
  capturedAt: string;
}
interface ExecutionStateBase {
  checkpoint?: ExecutionCheckpoint;
}
export type ExecutionState =
  | (ExecutionStateBase & {
      location: "cloud";
      state: "online";
      cloudReady: true;
      reason?: never;
      reconciliation?: "available";
    })
  | (ExecutionStateBase & {
      location: "cloud";
      state: "paused";
      cloudReady: false;
      reason: string;
      reconciliation?: "available";
    })
  | (ExecutionStateBase & {
      location: "laptop";
      state: "connecting" | "online" | "offline" | "preparing" | "paused";
      cloudReady: boolean;
      reason?: string;
      reconciliation?: never;
    });
const executionCheckpointSchema = z.object({
  id: z.string().min(1),
  capturedAt: z.string().refine(value => Number.isFinite(Date.parse(value)), { message: "Invalid checkpoint timestamp" }),
}).strict();
export const executionStateSchema: z.ZodType<ExecutionState> = z.union([
  z.object({
    location: z.literal("cloud"),
    state: z.literal("online"),
    cloudReady: z.literal(true),
    checkpoint: executionCheckpointSchema.optional(),
    reconciliation: z.literal("available").optional(),
  }).strict(),
  z.object({
    location: z.literal("cloud"),
    state: z.literal("paused"),
    cloudReady: z.literal(false),
    checkpoint: executionCheckpointSchema.optional(),
    reason: z.string().min(1),
    reconciliation: z.literal("available").optional(),
  }).strict(),
  z.object({
    location: z.literal("laptop"),
    state: z.enum(["connecting", "online", "offline", "preparing", "paused"]),
    cloudReady: z.boolean(),
    checkpoint: executionCheckpointSchema.optional(),
    reason: z.string().min(1).optional(),
  }).strict(),
]);
export type SessionHeadless =
  | { channel: true; reason?: never; allowlist?: string[] }
  | { channel: false; reason: string; allowlist?: string[] };
export const sessionHeadlessSchema: z.ZodType<SessionHeadless> = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal(true),
    allowlist: z.array(z.string().min(1)).optional(),
  }).strict(),
  z.object({
    channel: z.literal(false),
    reason: z.string().min(1),
    allowlist: z.array(z.string().min(1)).optional(),
  }).strict(),
]);
export type SessionPurpose = "work" | "duel" | "replay" | "gate";
export const SESSION_PURPOSES: readonly SessionPurpose[] = ["work", "duel", "replay", "gate"];
export const LEARNING_PURPOSES: readonly SessionPurpose[] = ["replay", "gate", "duel"];
export function learningPurpose(purpose: SessionPurpose | undefined): boolean {
  return purpose !== undefined && LEARNING_PURPOSES.includes(purpose);
}
export interface Session {
  purpose?: SessionPurpose;
  configId?: string;
  codeMode?: boolean;
  handoff?: { policy?: import("./handoff-types.js").HandoffPolicy; reason?: string };
  id: string;
  managedBy?: { kind: "mission"; missionId: string; teamId?: string };
  team?: import("./team-types.js").TeamAssignment;
  teamModelProfile?: import("./team-types.js").TeamModelProfile;
  workspaceTrusted?: true;
  backend?: "infinite" | "cmux";
  machineId?: string;
  executionLocation?: "cloud" | "laptop";
  resumedFrom?: string;
  resumeNativeSession?: { id: string; source: "hook" | "protocol" };
  provider: Provider;
  title: string;
  generatedTitle?: true;
  projectId: string;
  cwd: string;
  createdAt: string;
  status: Status;
  archivedAt?: string;
  pid?: number;
  exitCode?: number;
  projectRoot?: string;
  contextSources?: import("./project-context.js").ContextSource[];
  contextLinksVersion?: number;
  contextVersion: number;
  context: string;
  initialPrompt: string;
  nativeArgs?: string[];
  runtime?: SessionRuntime;
  workspace?: LaptopWorkspace;
  headless?: SessionHeadless;
}
export interface PermissionChannelWaiting {
  interruptClass: string;
  tool: string;
  since: string;
  expiresAt: string;
}
export interface PermissionChannelNotice {
  id: string;
  interruptClass?: string;
  at: string;
}
export interface PermissionChannelView {
  served: boolean;
  waiting?: PermissionChannelWaiting;
  notice?: PermissionChannelNotice;
}
export type PermissionChannelViewState =
  | { served: false; waiting?: never; notice?: PermissionChannelNotice }
  | { served: true; waiting?: PermissionChannelWaiting; notice?: PermissionChannelNotice };
const permissionChannelWaitingSchema = z.object({
  interruptClass: z.string().min(1),
  tool: z.string().min(1),
  since: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();
const permissionChannelNoticeSchema = z.object({
  id: z.string().min(1),
  interruptClass: z.string().min(1).optional(),
  at: z.iso.datetime(),
}).strict();
export const permissionChannelViewSchema: z.ZodType<PermissionChannelViewState> = z.discriminatedUnion("served", [
  z.object({
    served: z.literal(false),
    notice: permissionChannelNoticeSchema.optional(),
  }).strict(),
  z.object({
    served: z.literal(true),
    waiting: permissionChannelWaitingSchema.optional(),
    notice: permissionChannelNoticeSchema.optional(),
  }).strict(),
]);
export function projectPermissionChannelView(view: PermissionChannelView): PermissionChannelViewState {
  if (view.served) {
    return {
      served: true,
      ...(view.waiting ? { waiting: view.waiting } : {}),
      ...(view.notice ? { notice: view.notice } : {}),
    };
  }
  return {
    served: false,
    ...(view.notice ? { notice: view.notice } : {}),
  };
}
export interface Event {
  seq: number;
  at: string;
  type: "output" | "lifecycle" | "input-intent" | "input-result" | "signal" | "team-report" | "mission-report" | "team-handoff" | "team-entry" | "team-entry-read" | "usage" | "usage-coverage" | "message";
  data: Record<string, unknown>;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  team?: import("./team-types.js").TeamProject;
  linear?: { teamId: string; projectId?: string };
  teamworkDir?: string;
  source?: import("./team-types.js").ProjectSource;
  autonomy?: import("./autonomy.js").AutonomyMode;
}
export interface AgentProfile {
  command: string;
  args: string[];
  appServerCommand?: string;
  appServerArgs?: string[];
  workspaceDir?: string;
  sharedWorkspace?: boolean;
}
export interface Config {
  linear?: { apiKeyFile: string; endpoint?: string; reportName?: string };
  hostLoad?: { minAvailableMemoryGiB: number; maxLoadPerCpu: number };
  intake?: import("./intake-types.js").IntakeConfig;
  mcp?: import("./mcp-types.js").McpConfig;
  codeMode?: { claude: "off" | "headless" | "all" };
  teams?: {
    workspaceDir: string;
    commandPrefix?: import("./team-types.js").TeamCommand;
    lineup?: import("./team-types.js").TeamLineup;
    trustWorkspaces?: boolean;
    stallMinutes?: number;
    checkMinutes?: number;
    retention?: import("./team-types.js").TeamRetention;
    storageFloor?: import("./team-types.js").StorageFloor;
    outcomes?: { holdDays?: number; retentionDays?: number };
    blackboard?: { tools?: boolean };
    memberTraces?: import("./member-traces.js").MemberTraceSettings;
  };
  machine?: { id: string; label: string };
  permissionAgent?: import("./permission-agent-config.js").PermissionAgentConfig;
  autonomy?: { defaultMode?: import("./autonomy.js").AutonomyMode; fuse?: import("./config.js").FuseConfig; continuity?: import("./config.js").ContinuityConfig; boundary?: { egress?: import("./egress.js").EgressConfig; github?: import("./github-grants.js").GithubBoundary } };
  cmux?: { enabled: boolean; command?: string; hooksDir?: string };
  remote?: { enabled: boolean; relay?: { url: string; tokenFile: string } };
  usage?: import("./config.js").UsageConfig;
  deployment?: import("./deployment.js").Deployment;
  sync?: { sharedGroup?: boolean; homeDir?: string };
  source?: { mirrorDir?: string; refreshMinutes?: number; remoteOverrides?: Record<string, string> };
  github?: { reviewFeedback?: { enabled?: boolean; ownerLogin?: string; pollMinutes?: number } };
  eval?: import("./eval-config.js").EvalHostConfig;
  summaries?: { model: string; apiKeyFile: string; baseUrl: string };
  jev?: { apiKeyFile: string; model: string; baseUrl: string; sessionReadings?: boolean };
  dictation?: { model: string; apiKeyFile: string; baseUrl: string };
  repositoryBriefings?: { command: string; args: string[]; runner?: "muse" | "deepseek" | "codex"; model?: string; automatic: boolean; intervalMs: number; cooldownMs: number; timeoutMs: number };
  repositoryGraphs?: { command: string; args: string[]; graphifyCommand: string; cacheDir: string; projectIds?: string[]; timeoutMs: number; debounceMs: number; intervalMs: number };
  port: number;
  origin: string;
  stateDir: string;
  runDir: string;
  keyFile: string;
  tokens: { id: string; label: string; role: Role; hash: string }[];
  projects: Project[];
  agents: Partial<Record<Provider, AgentProfile>>;
  environment: "local" | "cloud";
  enableDemo: boolean;
  maxSessions: number;
  attention?: {
    idleAfterMs: number;
    limitConfirmMs: number;
    hooks: { claude: boolean; codex: boolean };
  };
  push?: {
    enabled: boolean;
    accessTokenFile?: string;
    endpoint: string;
    detail: "minimal" | "full";
    events: ("needs-you" | "turn-finished" | "exited" | "recording-error" | "goal-started" | "goal-finished" | "goal-stuck" | "goal-cancelled" | "team-started" | "team-finished" | "team-stuck" | "team-cancelled" | "team-blocked" | "host-storage" | "autonomy-interrupt" | "main-check")[];
  };
}
export interface Receipt {
  requestId: string;
  state: "delivered" | "uncertain";
  seq: number;
}
export interface WorkerState {
  handoffQuiescence?: { requestId: string; verifiedAt: string; scope: "process-group-and-observed-descendants" };
  status: Status;
  pid?: number;
  workerPid?: number;
  exitCode?: number;
  seq: number;
  screen: string;
  attention: Attention;
  capabilities?: { terminalSnapshot?: 1; inputControl?: 1; nativeUi?: "codex" | "opencode"; transcript?: 1 };
  control?: ControlLease | null;
  runtime?: SessionRuntime;
  nativeSession?: { id: string; source: "hook" | "protocol" };
  execution?: ExecutionState;
  permissionChannel?: PermissionChannelView;
}
export interface InputControl {
  actor?: ControlActor;
  leaseId?: string;
}
export interface TeamPermissionExpansionExpectation {
  promptId: number;
  promptHash: string;
  evidenceHash: string;
  targetCwd: string;
  expiresAt: string;
}
export type TeamMemberAssignment = Omit<import("./team-types.js").TeamAssignment, "role"> & {
  role: import("./team-types.js").TeamRole;
};
interface TeamAnswerWorkerRequestBase {
  op: "team-answer";
  requestId: string;
  decisionId: string;
  targetSessionId: string;
  assignment: TeamMemberAssignment;
  targetCwd: string;
  expiresAt: string;
  policyHash: string;
  promptId: number;
  promptHash: string;
  evidenceHash: string;
  option: number;
  actor: ControlActor;
  leaseId: string;
}
export type TeamAnswerWorkerRequest =
  | (TeamAnswerWorkerRequestBase & {
      coordinatorMemberId: string;
      choice?: never;
      text?: never;
    })
  | (TeamAnswerWorkerRequestBase & {
      coordinatorMemberId?: never;
      choice: "accept";
      text?: never;
    })
  | (TeamAnswerWorkerRequestBase & {
      coordinatorMemberId?: never;
      choice: "reject";
      text?: string;
    });
const noControlChars = /^[^\x00-\x1f\x7f]*$/;
const uuidString = /^[a-f0-9-]{36}$/i;
const sha256Hex = /^[a-f0-9]{64}$/i;
const lowercaseSha256Hex = /^[0-9a-f]{64}$/;
const controlActorSchema = z.object({
  id: z.string().min(1).max(128).regex(noControlChars),
  label: z.string().min(1).max(120).regex(noControlChars),
}).strict();
const teamMemberAssignmentSchema = z.object({
  runId: z.string().regex(uuidString),
  memberId: z.string().regex(uuidString),
  revision: z.number().int().min(1),
  role: z.enum([
    "permission-coordinator",
    "project-manager",
    "scout",
    "implementer",
    "integrator",
    "reviewer",
    "delivery",
    "intent-checker",
    "evaluator",
    "judge",
  ]),
  taskId: z.string().optional(),
  verificationRefused: z.literal(true).optional(),
  entryTools: z.literal(true).optional(),
  hostProfiles: z.literal(true).optional(),
}).strict();
const teamAnswerBaseShape = {
  op: z.literal("team-answer"),
  requestId: z.string().min(1).max(80),
  decisionId: z.string().regex(uuidString),
  targetSessionId: z.string().min(1),
  assignment: teamMemberAssignmentSchema,
  targetCwd: z.string().min(1).max(4096),
  expiresAt: z.string().refine(value => Number.isInteger(Date.parse(value)), { message: "Invalid expiration timestamp" }),
  policyHash: z.string().regex(sha256Hex),
  promptId: z.number().int().min(1),
  promptHash: z.string().regex(sha256Hex),
  evidenceHash: z.string().regex(sha256Hex),
  option: z.number().int().min(0),
  actor: controlActorSchema,
  leaseId: z.string().min(1).max(80),
};
export const teamAnswerWorkerRequestSchema: z.ZodType<TeamAnswerWorkerRequest> = z.union([
  z.object({
    ...teamAnswerBaseShape,
    coordinatorMemberId: z.string().regex(uuidString),
  }).strict(),
  z.object({
    ...teamAnswerBaseShape,
    choice: z.literal("accept"),
  }).strict(),
  z.object({
    ...teamAnswerBaseShape,
    choice: z.literal("reject"),
    text: z.string().min(1).max(2000).regex(noControlChars).optional(),
  }).strict(),
]);
export type WorkerControlRequestState =
  | { op: "control"; action: "claim"; actor: ControlActor; leaseId?: string; takeover?: boolean }
  | { op: "control"; action: "renew" | "release"; actor: ControlActor; leaseId: string; takeover?: never };
export const workerControlRequestSchema: z.ZodType<WorkerControlRequestState> = z.discriminatedUnion("action", [
  z.object({
    op: z.literal("control"),
    action: z.literal("claim"),
    actor: controlActorSchema,
    leaseId: z.string().min(1).max(80).optional(),
    takeover: z.boolean().optional(),
  }).strict(),
  z.object({
    op: z.literal("control"),
    action: z.literal("renew"),
    actor: controlActorSchema,
    leaseId: z.string().min(1).max(80),
  }).strict(),
  z.object({
    op: z.literal("control"),
    action: z.literal("release"),
    actor: controlActorSchema,
    leaseId: z.string().min(1).max(80),
  }).strict(),
]);
export const httpControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("claim"), leaseId: z.uuid().optional(), takeover: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("renew"), leaseId: z.uuid().optional(), takeover: z.literal(false).optional() }).strict(),
  z.object({ action: z.literal("release"), leaseId: z.uuid().optional(), takeover: z.literal(false).optional() }).strict(),
]);
export type NormalizedControlRequest =
  | { ok: true; request: WorkerControlRequestState }
  | { ok: false; code: "control-lost" };
export function normalizeControlRequest(
  body: z.infer<typeof httpControlRequestSchema>,
  actor: ControlActor,
): NormalizedControlRequest {
  if (body.action === "claim") {
    return {
      ok: true,
      request: {
        op: "control",
        action: "claim",
        actor,
        ...(body.leaseId !== undefined ? { leaseId: body.leaseId } : {}),
        ...(body.takeover !== undefined ? { takeover: body.takeover } : {}),
      },
    };
  }
  if (body.leaseId === undefined) return { ok: false, code: "control-lost" };
  return { ok: true, request: { op: "control", action: body.action, actor, leaseId: body.leaseId } };
}
export function normalizeWorkerControlRequest(request: WorkerControlRequestState): WorkerControlRequestState {
  if (request.action !== "claim" && (request as { takeover?: unknown }).takeover === false) {
    const { takeover: _takeover, ...rest } = request as WorkerControlRequestState & { takeover?: unknown };
    return rest as WorkerControlRequestState;
  }
  return request;
}
export type WorkerWorkspaceExportRequestState =
  | { op: "workspace-export"; method: "sync/export"; hash?: never }
  | { op: "workspace-export"; method: "sync/blob"; hash: string };
export const workerWorkspaceExportRequestSchema: z.ZodType<WorkerWorkspaceExportRequestState> = z.discriminatedUnion("method", [
  z.object({
    op: z.literal("workspace-export"),
    method: z.literal("sync/export"),
  }).strict(),
  z.object({
    op: z.literal("workspace-export"),
    method: z.literal("sync/blob"),
    hash: z.string().regex(lowercaseSha256Hex),
  }).strict(),
]);
export type WorkerRequest =
  | { op: "state"; screen?: boolean }
  | { op: "native-info" }
  | { op: "executor-connect"; token: string }
  | WorkerWorkspaceExportRequestState
  | ({ op: "native-connect" } & InputControl)
  | { op: "snapshot" }
  | { op: "handoff-stop"; requestId: string }
  | WorkerControlRequestState
  | ({
      op: "input";
      requestId: string;
      text: string;
      submit: boolean;
      force?: boolean;
    } & InputControl)
  | ({ op: "raw"; requestId: string; text: string } & InputControl)
  | ({
      op: "key";
      requestId: string;
      key: "interrupt" | "enter" | "escape" | "up" | "down" | "tab";
    } & InputControl)
  | ({
      op: "answer";
      missionManaged?: true;
      requestId: string;
      promptId: number;
      option?: number;
      text?: string;
    } & InputControl)
  | TeamAnswerWorkerRequest
  | ({
      op: "team-permission-expand";
      requestId: string;
      targetSessionId: string;
      assignment: import("./team-types.js").TeamAssignment;
      expected: TeamPermissionExpansionExpectation;
      actor: ControlActor;
      leaseId: string;
    })
  | ({
      op: "session-permission-answer";
      requestId: string;
      decisionId: string;
      targetSessionId: string;
      targetCwd: string;
      promptId: number;
      promptHash: string;
      evidenceHash: string;
      option: number;
      text?: string;
      actor: ControlActor;
      leaseId: string;
    })
  | { op: "team-answer-invalidate"; decisionId: string }
  | { op: "session-permission-invalidate"; decisionId: string }
  | ({ op: "resize"; cols: number; rows: number } & InputControl)
  | ({ op: "stop"; requestId: string } & InputControl);
export interface Bootstrap {
  session: Session;
  profile: AgentProfile;
  stateDir: string;
  runDir: string;
  key: string;
  prompt: string;
  codeMode: boolean;
  executorTokenHash?: string;
  permissionChannel?: { socket: string };
  github?: { proxy: string; grant: string };
  codexTraceRoot?: string;
  attention: {
    hooks: { claude: boolean; codex: boolean };
    idleAfterMs: number;
    limitConfirmMs: number;
  };
}
