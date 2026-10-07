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
  transport: "pty";
  nativeUi?: "codex";
}
export interface Session {
  id: string;
  provider: Provider;
  title: string;
  projectId: string;
  cwd: string;
  createdAt: string;
  status: Status;
  pid?: number;
  exitCode?: number;
  contextVersion: number;
  context: string;
  initialPrompt: string;
  nativeArgs?: string[];
  runtime?: SessionRuntime;
}
export interface Event {
  seq: number;
  at: string;
  type: "output" | "lifecycle" | "input-intent" | "input-result" | "signal";
  data: Record<string, unknown>;
}
export interface Project {
  id: string;
  name: string;
  path: string;
}
export interface AgentProfile {
  command: string;
  args: string[];
}
export interface Config {
  deployment?: import("./deployment.js").Deployment;
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
  status: Status;
  pid?: number;
  exitCode?: number;
  seq: number;
  screen: string;
  attention: Attention;
  capabilities?: { terminalSnapshot: 1; inputControl: 1; nativeUi?: "codex" };
  control?: ControlLease | null;
  runtime?: SessionRuntime;
  nativeSession?: { id: string; source: "hook" | "protocol" };
}
export interface InputControl {
  actor?: ControlActor;
  leaseId?: string;
}
export type WorkerRequest =
  | { op: "state"; screen?: boolean }
  | { op: "native-info" }
  | ({ op: "native-connect" } & InputControl)
  | { op: "snapshot" }
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
      requestId: string;
      promptId: number;
      option?: number;
      text?: string;
    } & InputControl)
  | ({ op: "resize"; cols: number; rows: number } & InputControl)
  | ({ op: "stop"; requestId: string } & InputControl);
export interface Bootstrap {
  session: Session;
  profile: AgentProfile;
  stateDir: string;
  runDir: string;
  key: string;
  prompt: string;
  attention: {
    hooks: { claude: boolean; codex: boolean };
    idleAfterMs: number;
  };
}
