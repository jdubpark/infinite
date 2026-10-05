import type { Signal } from "./types.js";
import type { Body } from "./util.js";
import { LOUD_TOOLS } from "./types.js";
import { truncateInput } from "./truncate.js";
import { destructiveOf, hookPrompt, obj, str, turnEnd, turnStart } from "./util.js";

export function claudeAgent(body: unknown): { id: string; type: string } | undefined {
  const b = obj(body);
  return typeof b.agent_id === "string" ? { id: b.agent_id, type: typeof b.agent_type === "string" ? b.agent_type : "" } : undefined;
}

function isQuiet(tool: string) {
  return !LOUD_TOOLS.has(tool);
}

export function mapClaudeHook(body: unknown): Signal[] {
  const b = obj(body);
  const event = b.hook_event_name;
  if (typeof event !== "string") return [];
  const tool = typeof b.tool_name === "string" ? b.tool_name : undefined;
  const input = obj(b.tool_input);
  const toolUseId = str(b.tool_use_id, 100);
  switch (event) {
    case "UserPromptSubmit": return [turnStart(b)];
    case "PreToolUse": {
      if (!tool) return [];
      const shell = tool === "Bash" || tool === "PowerShell";
      const out: Signal[] = [{
        kind: "tool-start", tool, toolUseId, input: truncateInput(input), quiet: isQuiet(tool),
        destructive: shell ? destructiveOf(input) : undefined,
      }];
      if (tool === "AskUserQuestion") {
        const questions = Array.isArray(input.questions) ? (input.questions as Body[]) : [];
        const first = questions[0] ?? {};
        out.push({ kind: "prompt-open", prompt: { ...hookPrompt("question", str(first.question, 500) ?? "Question", tool, input), multiSelect: first.multiSelect === true } });
      }
      return out;
    }
    case "PostToolUse": {
      if (!tool) return [];
      const response = obj(b.tool_response);
      const diff = obj(response.bashEditDiff);
      const files = Array.isArray(diff.changedFiles) ? (diff.changedFiles as unknown[]).filter((f): f is string => typeof f === "string").slice(0, 50) : undefined;
      const exit = typeof response.exitCode === "number" ? response.exitCode : undefined;
      return [{
        kind: "tool-end", tool, toolUseId, ok: exit === undefined ? true : exit === 0,
        durationMs: typeof b.duration_ms === "number" ? b.duration_ms : undefined,
        summary: exit !== undefined ? `exit ${exit}` : typeof response.type === "string" ? response.type : undefined,
        files,
      }];
    }
    case "PostToolUseFailure": return tool ? [{ kind: "tool-end", tool, toolUseId, ok: false, error: str(b.error, 1000) ?? "failed" }] : [];
    case "PermissionRequest": return [{ kind: "prompt-open", prompt: hookPrompt("permission", "Permission needed", tool, input) }];
    // The worker binds the close (promptId 0) to the open prompt; the notice keeps the reason.
    case "PermissionDenied": return [
      { kind: "prompt-closed", promptId: 0, reason: "resolved" },
      { kind: "notice", type: "permission_denied", message: str(b.reason, 500) },
    ];
    case "Elicitation": return [{ kind: "prompt-open", prompt: hookPrompt("elicitation", str(b.message, 500) ?? "Input requested", undefined, {}, str(b.mcp_server_name, 100)) }];
    case "Notification": {
      const type = str(b.notification_type, 60) ?? "unknown";
      const out: Signal[] = [{ kind: "notice", type, message: str(b.message, 500), title: str(b.title, 100) }];
      if (type === "permission_prompt") out.push({ kind: "prompt-open", prompt: hookPrompt("permission", str(b.message, 200) ?? "Permission needed", undefined, {}) });
      if (type === "elicitation_dialog" || type === "elicitation_url_dialog") out.push({ kind: "prompt-open", prompt: hookPrompt("elicitation", str(b.message, 200) ?? "Input requested", undefined, {}) });
      return out;
    }
    case "Stop": {
      const tasks = Array.isArray(b.background_tasks) ? b.background_tasks.length : 0;
      return [turnEnd(b, tasks)];
    }
    case "StopFailure": return [
      { kind: "error", message: str(b.error, 1000) ?? "The provider reported a failure", where: "provider" },
      { kind: "turn-end", backgroundTasks: 0, failed: true },
    ];
    case "SessionEnd": return [{ kind: "notice", type: "session_end", message: str(b.reason, 100) }];
    default: return [];
  }
}
