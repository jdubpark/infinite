export type Provider = "claude" | "codex" | "grok" | "opencode" | "demo";
export type SignalSource = "hook" | "osc" | "screen" | "host" | "protocol";
export type PromptSource = "hook" | "osc" | "screen";
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
  tool?: { name: string; input: Record<string, unknown> };
  source: PromptSource;
  hash?: string;
}

export type PromptClosedReason = "answered-here" | "resolved" | "vanished" | "superseded";
export type AnswerResult = "closed" | "still-open" | "changed" | "refused";

export type Signal =
  | { kind: "hooks-ready"; event: string }
  | { kind: "turn-start"; prompt?: string }
  | { kind: "turn-end"; message?: string; backgroundTasks?: number; stopHookActive?: boolean; failed?: boolean }
  | { kind: "tool-start"; tool: string; toolUseId?: string; input: Record<string, unknown>; quiet: boolean; destructive?: { pattern: string } }
  | { kind: "tool-end"; tool: string; toolUseId?: string; ok: boolean; durationMs?: number; summary?: string; files?: string[]; error?: string }
  | { kind: "prompt-open"; prompt: Prompt }
  | { kind: "prompt-closed"; promptId: number; reason: PromptClosedReason; label?: string }
  | { kind: "answer"; promptId: number; requestId: string; option?: { index: number; label: string }; text: boolean; result: AnswerResult }
  | { kind: "notice"; type: string; message?: string; title?: string; promptId?: number; detail?: string }
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

export interface Attention {
  state: AttentionState;
  since: string;
  source: "hook" | "osc" | "screen" | "lifecycle" | "protocol";
  now: string;
  prompt?: Prompt;
  lastMessage?: string;
  lastTool?: { tool: string; summary: string; at: string };
  lastActivityAt: string;
  hooks: "active" | "none";
  hookErrors: number;
  /** Internal: a turn-end has been seen in this session. */
  sawTurnEnd: boolean;
}

export const LOUD_TOOLS = new Set([
  "Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit",
  "AskUserQuestion", "Agent", "Workflow", "ExitPlanMode", "apply_patch",
]);
export const PROVIDER_NAMES: Record<Provider, string> = {
  claude: "Claude Code", codex: "Codex", grok: "Grok Build", opencode: "OpenCode", demo: "Rehearsal",
};
