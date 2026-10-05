import type { Attention } from "@infinite/attention";
export type Role = "owner" | "controller" | "viewer";
export type Provider = "claude" | "codex" | "grok" | "opencode" | "demo";
export type Status =
  | "starting"
  | "running"
  | "exited"
  | "unavailable"
  | "recording-error";
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
}
export type WorkerRequest =
  | { op: "state"; screen?: boolean }
  | {
      op: "input";
      requestId: string;
      text: string;
      submit: boolean;
      /** Type even over an open dialog; only terminal surfaces send it. */
      force?: boolean;
    }
  | { op: "raw"; requestId: string; text: string }
  | {
      op: "key";
      requestId: string;
      key: "interrupt" | "enter" | "escape" | "up" | "down" | "tab";
    }
  | {
      op: "answer";
      requestId: string;
      promptId: number;
      option?: number;
      text?: string;
    }
  | { op: "resize"; cols: number; rows: number }
  | { op: "stop"; requestId: string };
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
