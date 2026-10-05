import type { Signal } from "./types.js";
import { LOUD_TOOLS } from "./types.js";
import { cut, truncateInput } from "./truncate.js";
import { destructiveOf, hookPrompt, obj, str, turnEnd, turnStart } from "./util.js";

export function mapCodexHook(body: unknown): Signal[] {
  const b = obj(body);
  const event = b.hook_event_name;
  if (typeof event !== "string") return [];
  const tool = typeof b.tool_name === "string" ? b.tool_name : undefined;
  const input = obj(b.tool_input);
  const toolUseId = str(b.tool_use_id, 100);
  switch (event) {
    case "SessionStart": return [{ kind: "notice", type: "session_start", message: str(b.source, 50) }];
    case "UserPromptSubmit": return [turnStart(b)];
    case "PreToolUse": {
      if (!tool) return [];
      return [{ kind: "tool-start", tool, toolUseId, input: truncateInput(input), quiet: !LOUD_TOOLS.has(tool) && tool !== "Bash", destructive: destructiveOf(input) }];
    }
    case "PostToolUse": {
      if (!tool) return [];
      const response = obj(b.tool_response);
      const exit = typeof response.exit_code === "number" ? response.exit_code : typeof response.exitCode === "number" ? response.exitCode : undefined;
      return [{ kind: "tool-end", tool, toolUseId, ok: exit === undefined ? true : exit === 0, summary: exit !== undefined ? `exit ${exit}` : undefined }];
    }
    case "PermissionRequest": return [{ kind: "prompt-open", prompt: hookPrompt("permission", "Approval needed", tool, input) }];
    case "Stop": return [turnEnd(b)];
    case "Interrupt": return [{ kind: "notice", type: "interrupt" }];
    case "SessionEnd": return [{ kind: "notice", type: "session_end" }];
    default: return [];
  }
}

export function mapCodexNotify(body: unknown): Signal[] {
  const b = obj(body);
  if (b.type !== "agent-turn-complete") return [];
  return [{ kind: "turn-end", message: str(b["last-assistant-message"], 4000), backgroundTasks: 0 }];
}

const OSC_APPROVAL = ["approval requested", "codex: approval requested"];
const OSC_QUESTION = ["question", "codex: question"];
const OSC_TURN_END = ["turn complete", "codex: turn complete"];

/**
 * OSC 9 notification text emitted by the Codex TUI. Only text that starts with one of the known
 * phrases (case-insensitive) opens a prompt or ends a turn; anything else is a plain notice.
 * The exact wording is unconfirmed until spike S2 captures it.
 */
export function mapCodexOsc(text: string): Signal[] {
  if (typeof text !== "string") return [];
  const t = text.trim();
  const lower = t.toLowerCase();
  const startsWith = (phrases: string[]) => phrases.some((p) => lower.startsWith(p));
  const out: Signal[] = [{ kind: "notice", type: "osc", message: cut(t, 500) }];
  if (startsWith(OSC_APPROVAL)) out.push({ kind: "prompt-open", prompt: { id: 0, kind: "permission", title: "Approval needed", options: [], acceptsText: false, source: "osc" } });
  else if (startsWith(OSC_QUESTION)) out.push({ kind: "prompt-open", prompt: { id: 0, kind: "question", title: cut(t, 200), options: [], acceptsText: false, source: "osc" } });
  else if (startsWith(OSC_TURN_END)) out.push({ kind: "turn-end", backgroundTasks: 0 });
  return out;
}
