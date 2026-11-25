export type Provider = "claude" | "codex" | "grok" | "opencode" | "demo";
export type SignalSource = "hook" | "osc" | "screen" | "host" | "protocol";
export type PromptSource = "hook" | "osc" | "screen" | "protocol";
export type PromptKind = "permission" | "question" | "elicitation" | "yes-no" | "menu";
export type OptionRole = "accept" | "accept-always" | "reject" | "reject-with-feedback" | "other";

export interface PromptOption {
  index: number;
  label: string;
  role: OptionRole;
}
export interface Prompt {
  id: number;
  kind: PromptKind;
  title: string;
  detail?: string;
  options: PromptOption[];
  highlighted?: number;
  acceptsText: boolean;
  multiSelect?: boolean;
  destructive?: { pattern: string };
  tool?: { name: string; input: Record<string, unknown>; inputComplete?: boolean };
  source: PromptSource;
  hash?: string;
  pinned?: boolean;
  delegable?: boolean;
}

export type PromptClosedReason = "answered-here" | "resolved" | "vanished" | "superseded";
export type AnswerResult = "closed" | "still-open" | "changed" | "refused";

export type Signal =
  | { kind: "hooks-ready"; event: string }
  | { kind: "turn-start"; prompt?: string; automatic?: true }
  | { kind: "turn-end"; message?: string; backgroundTasks?: number; stopHookActive?: boolean; failed?: boolean }
  | { kind: "tool-start"; tool: string; toolUseId?: string; input: Record<string, unknown>; quiet: boolean; destructive?: { pattern: string } }
  | { kind: "tool-end"; tool: string; toolUseId?: string; ok: boolean; durationMs?: number; summary?: string; files?: string[]; error?: string }
  | { kind: "prompt-open"; prompt: Prompt }
  | { kind: "prompt-closed"; promptId: number; reason: PromptClosedReason; label?: string }
  | { kind: "answer"; promptId: number; requestId: string; option?: { index: number; label: string }; text: boolean; result: AnswerResult }
  | { kind: "notice"; type: string; message?: string; title?: string; promptId?: number; detail?: string }
  | { kind: "provider-limit"; limit: "usage" | "credits"; confidence: "single-source" | "corroborated"; resetsAt?: string; message: string }
  | { kind: "error"; message: string; where: "provider" | "hooks" | "host" };
export type SignalKind = Signal["kind"];

export type SignalData = Signal & {
  source: SignalSource;
  provider: Provider;
  agent?: { id: string; type: string };
};

export interface SignalEvent {
  seq: number;
  at: string;
  type: "signal";
  data: SignalData;
}

export type AttentionState =
  | "working" | "needs-you" | "turn-finished" | "idle"
  | "exited" | "unavailable" | "recording-error";

type AttentionTool = { tool: string; summary: string; at: string };

type AttentionBase = {
  since: string;
  source: "hook" | "osc" | "screen" | "lifecycle" | "protocol";
  now: string;
  lastMessage?: string;
  lastActivityAt: string;
  hooks: "active" | "none";
  hookErrors: number;
  limit?: { limit: "usage" | "credits"; confidence: "single-source" | "corroborated"; resetsAt?: string; since: string; message: string };
  sawTurnEnd: boolean;
};

export type Attention =
  | (AttentionBase & { state: "working"; prompt?: undefined; lastTool?: AttentionTool })
  | (AttentionBase & { state: "needs-you"; prompt: Prompt; lastTool?: AttentionTool })
  | (AttentionBase & { state: "needs-you"; source: "lifecycle"; prompt?: undefined; lastTool?: AttentionTool })
  | (AttentionBase & { state: "turn-finished"; prompt?: undefined; lastTool?: undefined })
  | (AttentionBase & { state: "idle"; prompt?: undefined; lastTool?: undefined })
  | (AttentionBase & { state: "exited"; prompt?: undefined; lastTool?: undefined })
  | (AttentionBase & { state: "unavailable"; prompt?: undefined; lastTool?: undefined })
  | (AttentionBase & { state: "recording-error"; prompt?: undefined; lastTool?: undefined });

export const LOUD_TOOLS = new Set([
  "Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit",
  "AskUserQuestion", "Agent", "Workflow", "ExitPlanMode", "apply_patch",
]);
export const PROVIDER_NAMES: Record<Provider, string> = {
  claude: "Claude Code", codex: "Codex", grok: "Grok Build", opencode: "OpenCode", demo: "Rehearsal",
};
