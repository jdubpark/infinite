import type { Prompt, Signal } from "./types.js";
import { matchDestructive } from "./destructive.js";
import { cut, truncateInput } from "./truncate.js";

export type Body = Record<string, unknown>;
export const str = (v: unknown, max = 4000) => (typeof v === "string" ? cut(v, max) : undefined);
export const obj = (v: unknown): Body => (v && typeof v === "object" && !Array.isArray(v) ? (v as Body) : {});

/** Matches against the full command so truncation can never hide a destructive tail. */
export function destructiveOf(input: Body): { pattern: string } | undefined {
  const pattern = typeof input.command === "string" ? matchDestructive(input.command) : null;
  return pattern ? { pattern } : undefined;
}

export function toolTarget(tool: string, input: Body): string | undefined {
  if (tool === "Bash" || tool === "PowerShell") return str(input.command, 2000);
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") return str(input.file_path, 500);
  if (tool === "NotebookEdit") return str(input.notebook_path, 500);
  return undefined;
}

export function hookPrompt(kind: Prompt["kind"], title: string, tool: string | undefined, input: Body, detail?: string): Prompt {
  return {
    id: 0, kind, title, detail: detail ?? (tool ? toolTarget(tool, input) : undefined), options: [], acceptsText: false, source: "hook",
    tool: tool ? { name: tool, input: truncateInput(input) } : undefined,
    destructive: destructiveOf(input),
  };
}

export const turnStart = (b: Body): Signal => ({ kind: "turn-start", prompt: str(b.prompt, 500) });
export const turnEnd = (b: Body, backgroundTasks = 0): Signal =>
  ({ kind: "turn-end", message: str(b.last_assistant_message, 4000), backgroundTasks, stopHookActive: b.stop_hook_active === true });
