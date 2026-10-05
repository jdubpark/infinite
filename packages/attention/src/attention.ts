import type { Attention, Prompt, Provider, Signal, SignalEvent } from "./types.js";
import { LOUD_TOOLS, PROVIDER_NAMES } from "./types.js";
import type { DetectedPrompt } from "./prompts.js";
import { normalisedLines } from "./prompts.js";
import { matchDestructive } from "./destructive.js";
import { roleForLabel } from "./roles.js";

const TERMINAL = new Set(["exited", "unavailable", "recording-error"]);

export interface ScreenDecision {
  open?: Omit<Prompt, "id" | "hash"> & { fingerprint: string };
  close?: { promptId: number; reason: "vanished" };
  merge?: DetectedPrompt;
  idle?: "turn-finished" | "idle";
  working?: boolean;
}

export function initialAttention(at: string, hasInitialPrompt: boolean): Attention {
  return {
    state: hasInitialPrompt ? "working" : "idle",
    since: at, source: "lifecycle", now: hasInitialPrompt ? "Starting" : "Waiting for your direction",
    lastActivityAt: at, hooks: "none", hookErrors: 0, sawTurnEnd: false,
  };
}

function enter(att: Attention, state: Attention["state"], source: Attention["source"], at: string): Attention {
  return att.state === state ? { ...att, lastActivityAt: at } : { ...att, state, since: at, source, lastActivityAt: at };
}

export function applyLifecycle(att: Attention, status: "exited" | "unavailable" | "recording-error", at: string): Attention {
  return { ...enter(att, status, "lifecycle", at), prompt: undefined, now: "" };
}

export function applySignal(att: Attention, event: SignalEvent): Attention {
  if (TERMINAL.has(att.state)) return att;
  const { data } = event;
  const at = event.at;
  let next: Attention = { ...att, lastActivityAt: at };
  if (data.source === "hook" && next.hooks === "none") next.hooks = "active";
  const source = data.source === "host" ? "lifecycle" : data.source;
  // A prompt with a screen hash belongs to the screen loop: only its block leaving the screen
  // (or an answer) closes it, so a late turn or tool hook for the same dialog keeps it open.
  const screenOwned = next.prompt?.hash !== undefined;
  switch (data.kind) {
    case "hooks-ready": next.hooks = "active"; break;
    case "turn-start":
      next = { ...next, lastTool: undefined, lastMessage: undefined };
      if (!screenOwned) next = { ...enter(next, "working", source, at), prompt: undefined };
      break;
    case "tool-start":
      if (!data.quiet) next.lastTool = { tool: data.tool, summary: toolSummary(data.tool, data.input), at };
      if (!screenOwned) next = { ...enter(next, "working", source, at), prompt: undefined };
      break;
    case "tool-end":
      if (next.lastTool && next.lastTool.tool === data.tool) next.lastTool = undefined;
      break;
    case "prompt-open":
      next = { ...enter(next, "needs-you", data.prompt.source, at), prompt: { ...data.prompt, id: event.seq } };
      break;
    case "prompt-closed":
      if (next.prompt?.id === data.promptId) next = { ...enter(next, "working", source, at), prompt: undefined };
      if (rejects(data.label)) next.lastTool = undefined;
      break;
    case "answer":
      // A rejected tool never runs, so it is no longer what the agent is doing.
      if (rejects(data.option?.label)) next.lastTool = undefined;
      break;
    case "turn-end":
      next = { ...enter(next, "turn-finished", source, at), prompt: undefined, lastTool: undefined, sawTurnEnd: true };
      next.lastMessage = data.message;
      break;
    case "error":
      if (data.where === "hooks") next.hookErrors += 1;
      break;
    default: break;
  }
  return next;
}

function rejects(label?: string) {
  if (label === undefined) return false;
  const role = roleForLabel(label);
  return role === "reject" || role === "reject-with-feedback";
}

/**
 * Whether recording `signal` would drop the open prompt without a `prompt-closed` of its own:
 * a turn-end always does; a turn-start or tool-start does for a hook-only prompt (no hash).
 * The worker journals the close first so every opened prompt is closed exactly once.
 */
export function dropsPrompt(att: Attention, signal: Signal): boolean {
  if (!att.prompt || TERMINAL.has(att.state)) return false;
  if (signal.kind === "turn-end") return true;
  if (signal.kind === "turn-start" || signal.kind === "tool-start") return att.prompt.hash === undefined;
  return false;
}

export function screenDecision(att: Attention, detected: DetectedPrompt | null, idle: boolean, outputSinceLastCheck: boolean, at: string): ScreenDecision {
  void at;
  if (TERMINAL.has(att.state)) return {};
  if (detected) {
    if (att.prompt) {
      if (att.prompt.hash === undefined || att.prompt.options.length === 0) return { merge: detected };
      return {};
    }
    return {
      open: {
        kind: detected.kind, title: detected.title, detail: detected.detail, options: detected.options,
        highlighted: detected.highlighted, acceptsText: detected.acceptsText, multiSelect: detected.multiSelect,
        source: "screen", fingerprint: detected.fingerprint,
      },
    };
  }
  if (att.prompt && att.prompt.hash !== undefined) return { close: { promptId: att.prompt.id, reason: "vanished" } };
  if (idle && !att.prompt) return { idle: att.sawTurnEnd ? "turn-finished" : "idle" };
  // With hooks active, a finished turn ends only on a turn-start or tool-start hook: a redraw or
  // late output after the Stop hook is not new work.
  if (outputSinceLastCheck && (att.state === "idle" || (att.state === "turn-finished" && att.hooks !== "active"))) return { working: true };
  return {};
}

/**
 * The screen's block arrived for a hook prompt. What the phone shows is what the dialog shows:
 * title, detail, options, highlighted and hash come from the block. The hook keeps its tool,
 * its kind unless that is a generic menu, and its destructive flag. Multi-select from either
 * side sticks, so the answer path can refuse it.
 */
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
    destructive: prompt.destructive ?? blockDestructive(detected),
    hash,
  };
}

/**
 * A hook announced the dialog the screen already shows. The open prompt keeps its id, title,
 * detail, options and hash (what the answer path verifies and the phone shows); the hook adds
 * only its kind, tool, destructive flag and multi-select. A flag never goes away once set.
 */
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

/** The destructive flag a dialog block's own text carries. */
export function blockDestructive(block: { detail?: string }): { pattern: string } | undefined {
  const pattern = matchDestructive(block.detail ?? "");
  return pattern ? { pattern } : undefined;
}

/** Hook prompt titles that name no particular dialog. */
const PLACEHOLDER_TITLES = new Set(["Permission needed", "Approval needed", "Input requested"]);
/** A line the dialog cut short with "…" identifies a command only if this much of it is left. */
const MIN_ELLIPSIS_PREFIX = 32;

/**
 * Whether a hook-reported prompt describes this dialog block. Needles are the hook detail's
 * first six non-empty lines plus its title unless that is a placeholder; the haystack is the
 * block's detail lines and title, all whitespace-normalised. Every needle must equal a haystack
 * line, or extend a line the dialog cut short with "…". With no usable needle there is nothing
 * to prove the two belong together, so the answer is false.
 */
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
      const command = p?.tool?.input.command;
      const [commandLine] = normalisedLines(typeof command === "string" ? command : undefined);
      const shown = normalisedLines(p?.detail);
      // Name the command when the dialog shows it; otherwise the dialog's first detail line.
      const head = (commandLine && shown.find((l) => l === commandLine)) ?? shown[0] ?? commandLine;
      text = p ? (head ? `${p.title} ${head}` : p.title) : `${name} needs you`;
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

function firstSentence(text?: string) {
  if (!text) return "";
  const line = text.trim().split("\n").find((l) => l.trim() !== "") ?? "";
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  return (m ? m[1] : line).trim();
}
