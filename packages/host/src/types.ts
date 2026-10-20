import type { Attention } from "@infinite/attention";
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
export interface SessionRuntime {
  id: string;
  location: "local" | "cloud";
  transport: "pty" | "cmux";
  nativeUi?: "codex" | "opencode";
}
export interface LaptopWorkspace {
  cwd: string;
  roots: string[];
}
export interface ExecutionState {
  location: "laptop" | "cloud";
  state: "connecting" | "online" | "offline" | "preparing" | "paused";
  cloudReady: boolean;
  checkpoint?: { id: string; capturedAt: string };
  reason?: string;
  reconciliation?: "available";
}
export interface Session {
  handoff?: { policy?: import("./handoff-types.js").HandoffPolicy; reason?: string };
  id: string;
  managedBy?: { kind: "mission"; missionId: string; teamId?: string };
  /** Host-owned assignment; ordinary session creation cannot supply this. */
  team?: import("./team-types.js").TeamAssignment;
  teamModelProfile?: import("./team-types.js").TeamModelProfile;
  /** Host-owned: this member folder lies under a team root the owner trusts. */
  workspaceTrusted?: true;
  backend?: "infinite" | "cmux";
  machineId?: string;
  /** Where this session's tools run. Laptop execution is the explicit --laptop mode. */
  executionLocation?: "cloud" | "laptop";
  resumedFrom?: string;
  resumeNativeSession?: { id: string; source: "hook" | "protocol" };
  provider: Provider;
  title: string;
  /** Host-only marker for a title supplied by a CLI default, never a person. */
  generatedTitle?: true;
  projectId: string;
  cwd: string;
  createdAt: string;
  status: Status;
  pid?: number;
  exitCode?: number;
  /** Canonical source checkout at creation; never inferred from a Linear mapping. */
  projectRoot?: string;
  contextSources?: import("./project-context.js").ContextSource[];
  contextLinksVersion?: number;
  contextVersion: number;
  context: string;
  initialPrompt: string;
  nativeArgs?: string[];
  runtime?: SessionRuntime;
  workspace?: LaptopWorkspace;
}
export interface Event {
  seq: number;
  at: string;
  type: "output" | "lifecycle" | "input-intent" | "input-result" | "signal" | "team-report" | "mission-report" | "team-handoff" | "usage" | "message";
  data: Record<string, unknown>;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  team?: import("./team-types.js").TeamProject;
  linear?: { teamId: string; projectId?: string };
  /** Absolute host directory that holds this project's team runs, outside every project root. */
  teamworkDir?: string;
}
export interface AgentProfile {
  command: string;
  args: string[];
  /** Optional qualified standalone Codex app-server; the regular command remains the TUI. */
  appServerCommand?: string;
  appServerArgs?: string[];
  /** Optional data root outside private control state for a separate execution identity. */
  workspaceDir?: string;
  sharedWorkspace?: boolean;
}
export interface Config {
  /** Host-only credential; never copied into provider environment variables or prompts. */
  linear?: { apiKeyFile: string; endpoint?: string };
  /** Separate working copies, writable by the host and selected provider execution account. */
  teams?: {
    workspaceDir: string; commandPrefix?: import("./team-types.js").TeamCommand; lineup?: import("./team-types.js").TeamLineup;
    /** Owner trust in every team root: Claude and Codex members start trusted in their own folders. */
    trustWorkspaces?: boolean;
    /** Minutes without attention activity before a member without a report is stopped and replaced. */
    stallMinutes?: number;
    /** Minutes each configured verification command may run before the host stops it (default 60). */
    checkMinutes?: number;
  };
  machine?: { id: string; label: string };
  cmux?: { enabled: boolean; command?: string; hooksDir?: string };
  remote?: { enabled: boolean; relay?: { url: string; tokenFile: string } };
  /** Token prices (USD per million) and per-provider spend budgets for the usage ledger. */
  usage?: import("./config.js").UsageConfig;
  deployment?: import("./deployment.js").Deployment;
  /** Workspace sync. `homeDir` overrides the server home used for folder mapping; `sharedGroup` permits a separate agent account. */
  sync?: { sharedGroup?: boolean; homeDir?: string };
  /** Chat digests written by a hosted model through an OpenAI-compatible Responses API. */
  summaries?: { model: string; apiKeyFile: string; baseUrl: string };
  /** Optional Jev readings for turn-finished lines and generated session titles. */
  jev?: { apiKeyFile: string; model: string; baseUrl: string };
  /** Optional cleanup for dictated text through an OpenAI-compatible Responses API. */
  dictation?: { model: string; apiKeyFile: string; baseUrl: string };
  /** Read-only repository briefs produced by an administrator-configured host wrapper. */
  repositoryBriefings?: { command: string; args: string[]; runner?: "muse" | "deepseek" | "codex"; model?: string; automatic: boolean; intervalMs: number; cooldownMs: number; timeoutMs: number };
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
    events: ("needs-you" | "turn-finished" | "exited" | "recording-error")[];
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
  /** Written to the sealed status only; a row carries it when the worker did not answer. */
  workerPid?: number;
  exitCode?: number;
  seq: number;
  screen: string;
  attention: Attention;
  /** `transcript` means chat messages come from the provider's own conversation record. */
  capabilities?: { terminalSnapshot?: 1; inputControl?: 1; nativeUi?: "codex" | "opencode"; transcript?: 1 };
  control?: ControlLease | null;
  runtime?: SessionRuntime;
  nativeSession?: { id: string; source: "hook" | "protocol" };
  execution?: ExecutionState;
}
export interface InputControl {
  actor?: ControlActor;
  leaseId?: string;
}
export type WorkerRequest =
  | { op: "state"; screen?: boolean }
  | { op: "native-info" }
  | { op: "executor-connect"; token: string }
  | { op: "workspace-export"; method: "sync/export" | "sync/blob"; hash?: string }
  | ({ op: "native-connect" } & InputControl)
  | { op: "snapshot" }
  | { op: "handoff-stop"; requestId: string }
  | {
      op: "control";
      action: "claim" | "renew" | "release";
      actor: ControlActor;
      leaseId?: string;
      takeover?: boolean;
    }
  | ({
      op: "input";
      requestId: string;
      text: string;
      submit: boolean;
      /** Type even over an open dialog; only terminal surfaces send it. */
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
      /** Set by the host only for owner-authorized answers on mission-managed sessions. */
      missionManaged?: true;
      requestId: string;
      promptId: number;
      option?: number;
      text?: string;
    } & InputControl)
  | ({
      /** Host-only delegated one-shot permission answer over the private worker socket. */
      op: "team-answer";
      requestId: string;
      decisionId: string;
      coordinatorMemberId: string;
      targetSessionId: string;
      assignment: import("./team-types.js").TeamAssignment;
      targetCwd: string;
      expiresAt: string;
      policyHash: string;
      promptId: number;
      promptHash: string;
      evidenceHash: string;
      option: number;
      actor: ControlActor;
      leaseId: string;
    })
  | { op: "team-answer-invalidate"; decisionId: string }
  | ({ op: "resize"; cols: number; rows: number } & InputControl)
  | ({ op: "stop"; requestId: string } & InputControl);
export interface Bootstrap {
  session: Session;
  profile: AgentProfile;
  stateDir: string;
  runDir: string;
  key: string;
  prompt: string;
  executorTokenHash?: string;
  attention: {
    hooks: { claude: boolean; codex: boolean };
    idleAfterMs: number;
    limitConfirmMs: number;
  };
}
