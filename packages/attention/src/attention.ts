import type { Attention, Prompt, Provider, Signal, SignalData, SignalEvent } from "./types.js";
import { LOUD_TOOLS, PROVIDER_NAMES } from "./types.js";
import type { DetectedPrompt } from "./prompts.js";
import { normalisedLines } from "./prompts.js";
import { matchDestructive } from "./destructive.js";
import { roleForLabel } from "./roles.js";
import { dialogCommand } from "./delegation.js";

export type ScreenDecision =
  | { kind: "none" }
  | { kind: "open"; open: Omit<Prompt, "id" | "hash"> & { fingerprint: string } }
  | { kind: "merge"; merge: DetectedPrompt }
  | { kind: "close"; close: { promptId: number; reason: "vanished" } }
  | { kind: "idle"; idle: "turn-finished" | "idle" }
  | { kind: "working" };

export function initialAttention(at: string, hasInitialPrompt: boolean): Attention {
  const base = {
    since: at, source: "lifecycle" as const, lastActivityAt: at, hooks: "none" as const, hookErrors: 0, sawTurnEnd: false,
  };
  return hasInitialPrompt
    ? { ...base, state: "working", now: "Starting" }
    : { ...base, state: "idle", now: "Waiting for your direction" };
}

function transitionTiming(att: Attention, state: Attention["state"], source: Attention["source"], at: string) {
  return att.state === state ? { since: att.since, source: att.source } : { since: at, source };
}

export function applyLifecycle(att: Attention, status: "exited" | "unavailable" | "recording-error", at: string): Attention {
  return {
    ...transitionTiming(att, status, "lifecycle", at),
    state: status,
    now: "",
    ...(att.lastMessage !== undefined ? { lastMessage: att.lastMessage } : {}),
    lastActivityAt: at,
    hooks: att.hooks,
    hookErrors: att.hookErrors,
    limit: att.limit,
    sawTurnEnd: att.sawTurnEnd,
  };
}

export function recoveryTurnEnd(data: SignalData): boolean {
  if (data.kind !== "turn-end" || data.failed === true) return false;
  return data.source === "protocol" || (data.provider === "claude" && data.source === "hook");
}

function updateCurrentState(
  att: Exclude<Attention, { state: "exited" | "unavailable" | "recording-error" }>,
  patch: { lastActivityAt: string; hooks: "active" | "none"; limit: Attention["limit"]; hookErrors: number; lastTool?: Attention["lastTool"] },
): Attention {
  const base = {
    since: att.since,
    source: att.source,
    now: att.now,
    lastActivityAt: patch.lastActivityAt,
    hooks: patch.hooks,
    hookErrors: patch.hookErrors,
    limit: patch.limit,
    sawTurnEnd: att.sawTurnEnd,
  };
  switch (att.state) {
    case "working":
      return { ...base, state: "working", lastTool: patch.lastTool };
    case "needs-you":
      return att.prompt
        ? { ...base, state: "needs-you", prompt: att.prompt, lastTool: patch.lastTool }
        : { ...base, source: "lifecycle", state: "needs-you", lastTool: patch.lastTool };
    case "turn-finished":
      return { ...base, state: "turn-finished", lastMessage: att.lastMessage };
    case "idle":
      return { ...base, state: "idle" };
  }
}

export function applySignal(att: Attention, event: SignalEvent): Attention {
  if (att.state === "exited" || att.state === "unavailable" || att.state === "recording-error") return att;
  const { data } = event;
  const at = event.at;
  const hooks = data.source === "hook" || data.kind === "hooks-ready" ? "active" : att.hooks;
  const source = data.source === "host" ? "lifecycle" : data.source;
  const screenOwnedPrompt = att.state === "needs-you" && att.prompt?.hash !== undefined ? att.prompt : undefined;
  const currentTool = att.state === "working" || att.state === "needs-you" ? att.lastTool : undefined;
  const base = {
    now: att.now,
    lastActivityAt: at,
    hooks,
    hookErrors: att.hookErrors,
    limit: att.limit,
    sawTurnEnd: att.sawTurnEnd,
  };

  switch (data.kind) {
    case "hooks-ready":
      return updateCurrentState(att, { ...base, lastTool: currentTool });
    case "turn-start":
      if (screenOwnedPrompt) {
        return { ...base, since: att.since, source: att.source, state: "needs-you", prompt: screenOwnedPrompt, lastTool: undefined };
      }
      return { ...base, ...transitionTiming(att, "working", source, at), state: "working", lastTool: undefined };
    case "tool-start": {
      const lastTool = data.quiet ? currentTool : { tool: data.tool, summary: toolSummary(data.tool, data.input), at };
      if (screenOwnedPrompt) {
        return { ...base, since: att.since, source: att.source, state: "needs-you", prompt: screenOwnedPrompt, lastTool };
      }
      return { ...base, ...transitionTiming(att, "working", source, at), state: "working", lastTool };
    }
    case "tool-end": {
      const lastTool = currentTool && currentTool.tool === data.tool ? undefined : currentTool;
      return updateCurrentState(att, { ...base, lastTool });
    }
    case "prompt-open":
      return {
        ...base,
        ...transitionTiming(att, "needs-you", data.prompt.source, at),
        state: "needs-you",
        prompt: { ...data.prompt, id: event.seq },
        lastTool: currentTool,
      };
    case "prompt-closed": {
      const lastTool = rejects(data.label) ? undefined : currentTool;
      if (att.state === "needs-you" && att.prompt?.id === data.promptId) {
        return { ...base, ...transitionTiming(att, "working", source, at), state: "working", lastTool };
      }
      return updateCurrentState(att, { ...base, lastTool });
    }
    case "answer": {
      const lastTool = rejects(data.option?.label) ? undefined : currentTool;
      return updateCurrentState(att, { ...base, lastTool });
    }
    case "turn-end":
      return {
        ...base,
        ...transitionTiming(att, "turn-finished", source, at),
        state: "turn-finished",
        sawTurnEnd: true,
        lastMessage: data.message,
        limit: recoveryTurnEnd(data) ? undefined : att.limit,
      };
    case "notice":
      return updateCurrentState(att, {
        ...base,
        limit: data.type === "quota_auto_resume_fired" ? undefined : att.limit,
        lastTool: currentTool,
      });
    case "provider-limit": {
      const keep = att.limit?.limit === data.limit && att.limit.confidence === "corroborated" && data.confidence === "single-source";
      const limit = keep ? att.limit : { limit: data.limit, confidence: data.confidence, resetsAt: data.resetsAt, since: at, message: data.message };
      return updateCurrentState(att, { ...base, limit, lastTool: currentTool });
    }
    case "error":
      return updateCurrentState(att, {
        ...base,
        hookErrors: att.hookErrors + (data.where === "hooks" ? 1 : 0),
        lastTool: currentTool,
      });
    default:
      return updateCurrentState(att, { ...base, lastTool: currentTool });
  }
}

function rejects(label?: string) {
  if (label === undefined) return false;
  const role = roleForLabel(label);
  return role === "reject" || role === "reject-with-feedback";
}

export function dropsPrompt(att: Attention, signal: Signal): boolean {
  if (att.state !== "needs-you" || !att.prompt) return false;
  if (signal.kind === "turn-end") return true;
  if (signal.kind === "turn-start" || signal.kind === "tool-start") return att.prompt.hash === undefined;
  return false;
}

export function screenDecision(att: Attention, detected: DetectedPrompt | null, idle: boolean, outputSinceLastCheck: boolean, at: string): ScreenDecision {
  void at;
  if (att.state === "exited" || att.state === "unavailable" || att.state === "recording-error") return { kind: "none" };
  if (detected) {
    if (att.state === "needs-you" && att.prompt) {
      if (att.prompt.hash === undefined || att.prompt.options.length === 0) return { kind: "merge", merge: detected };
      return { kind: "none" };
    }
    return {
      kind: "open",
      open: {
        kind: detected.kind, title: detected.title, detail: detected.detail, options: detected.options,
        highlighted: detected.highlighted, acceptsText: detected.acceptsText, multiSelect: detected.multiSelect,
        pinned: detected.pinned, source: "screen", fingerprint: detected.fingerprint,
      },
    };
  }
  if (att.state === "needs-you" && att.prompt?.hash !== undefined) return { kind: "close", close: { promptId: att.prompt.id, reason: "vanished" } };
  if (idle && (!att.prompt)) return { kind: "idle", idle: att.sawTurnEnd ? "turn-finished" : "idle" };
  if (outputSinceLastCheck && (att.state === "idle" || (att.state === "turn-finished" && att.hooks !== "active"))) return { kind: "working" };
  return { kind: "none" };
}

export function mergeScreenIntoPrompt(prompt: Prompt, detected: DetectedPrompt, hash: string): Prompt {
  return {
    ...prompt,
    kind: prompt.kind === "menu" ? detected.kind : prompt.kind,
    title: detected.title,
    detail: detected.detail,
    options: detected.options,
    highlighted: detected.highlighted,
    acceptsText: detected.acceptsText,
    multiSelect: Boolean(prompt.multiSelect) || Boolean(detected.multiSelect),
    pinned: detected.pinned,
    destructive: prompt.destructive ?? blockDestructive(detected),
    hash,
  };
}

export function mergeHookIntoPrompt(open: Prompt, hook: Prompt, block: DetectedPrompt): Prompt {
  const hookKind = hook.kind === "permission" || hook.kind === "question" || hook.kind === "elicitation";
  return {
    ...open,
    kind: hookKind ? hook.kind : open.kind,
    tool: hook.tool ?? open.tool,
    destructive: hook.destructive ?? open.destructive ?? blockDestructive(block),
    multiSelect: Boolean(hook.multiSelect) || Boolean(open.multiSelect) || Boolean(block.multiSelect),
    source: "hook",
  };
}

export function blockDestructive(block: { detail?: string }): { pattern: string } | undefined {
  const pattern = matchDestructive(block.detail ?? "");
  return pattern ? { pattern } : undefined;
}

const PLACEHOLDER_TITLES = new Set(["Permission needed", "Approval needed", "Input requested"]);
const MIN_ELLIPSIS_PREFIX = 32;

export function correlates(
  hook: { title?: string; detail?: string },
  block: { title: string; detail?: string },
): boolean {
  const needles = normalisedLines(hook.detail).slice(0, 6);
  for (const title of normalisedLines(hook.title)) if (!PLACEHOLDER_TITLES.has(title)) needles.push(title);
  if (!needles.length) return false;
  const haystack = [...normalisedLines(block.detail), ...normalisedLines(block.title)];
  return needles.every((needle) =>
    haystack.some((line) => {
      if (line === needle) return true;
      if (!line.endsWith("…")) return false;
      const prefix = line.slice(0, -1).trimEnd();
      return prefix.length >= MIN_ELLIPSIS_PREFIX && needle.startsWith(prefix);
    }),
  );
}

export function toolSummary(tool: string, input: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (tool === "Bash" || tool === "PowerShell" || tool === "apply_patch") return str(input.command).split("\n")[0].slice(0, 120);
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") return basename(str(input.file_path) || str(input.notebook_path));
  if (tool === "AskUserQuestion") return "Asking you a question";
  if (tool === "Agent") return `Subagent ${str(input.subagent_type) || ""}`.trim();
  return tool;
}

function basename(path: string) { return path.split("/").filter(Boolean).at(-1) ?? path; }

export function describeNow(att: Attention, provider: Provider): string {
  const name = PROVIDER_NAMES[provider];
  let text: string;
  switch (att.state) {
    case "needs-you": {
      const p = att.prompt;
      if (!p) {
        text = `${name} needs you`;
        break;
      }
      const command = p.tool?.input.command;
      const [commandLine] = normalisedLines(typeof command === "string" ? command : undefined);
      const shown = normalisedLines(p.detail);
      const [dialogLine] = normalisedLines(dialogCommand(p));
      const head = (commandLine && shown.find((l) => l === commandLine)) ?? dialogLine ?? shown[0] ?? commandLine;
      text = head ? `${p.title} ${head}` : p.title;
      break;
    }
    case "working": {
      const t = att.lastTool;
      text = !t ? "Thinking" : LOUD_TOOLS.has(t.tool) && (t.tool === "Bash" || t.tool === "PowerShell" || t.tool === "apply_patch") ? `Running ${t.summary}` : /Edit|Write/.test(t.tool) ? `Editing ${t.summary}` : t.summary;
      break;
    }
    case "turn-finished": text = firstSentence(att.lastMessage) || "Finished a turn"; break;
    case "idle": text = "Waiting for your direction"; break;
    case "exited": text = "Process exited"; break;
    case "unavailable": text = "Host cannot reach this session"; break;
    case "recording-error": text = "Recording failed; process suspended"; break;
  }
  return text.length > 140 ? text.slice(0, 139) + "…" : text;
}

export function firstSentence(text?: string) {
  if (!text) return "";
  const line = text.trim().split("\n").find((l) => l.trim() !== "") ?? "";
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  return (m ? m[1] : line).trim();
}
