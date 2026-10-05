import type { SignalEvent, SignalSource } from "./types.js";

export interface Moment {
  id: string;
  at: string;
  kind: "command" | "edit" | "quiet" | "decision" | "turn" | "notice";
  title: string;
  detail?: string;
  destructive?: string;
  status?: "running" | "ok" | "failed";
  count?: number;
  source: SignalSource;
  expanded: { label: string; text: string }[];
}

const basename = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;
const s = (v: unknown) => (typeof v === "string" ? v : "");

/** Oldest-in, newest-first out. */
export function deriveMoments(events: SignalEvent[]): Moment[] {
  const out: Moment[] = [];
  const openTools = new Map<string, Moment>();
  const openByName = new Map<string, Moment>();
  let quiet: { reads: number; searches: number; other: number; moment?: Moment } = { reads: 0, searches: 0, other: 0 };
  let lastEdit: Moment | undefined;
  const prompts = new Map<number, Moment>();

  const flushQuiet = () => { quiet = { reads: 0, searches: 0, other: 0 }; };
  const quietTitle = () => {
    const parts: string[] = [];
    if (quiet.reads) parts.push(`Read ${quiet.reads} file${quiet.reads === 1 ? "" : "s"}`);
    if (quiet.searches) parts.push(`searched ${quiet.searches} time${quiet.searches === 1 ? "" : "s"}`);
    if (quiet.other) parts.push(`${quiet.other} other tool call${quiet.other === 1 ? "" : "s"}`);
    return parts.join(", ");
  };

  for (const e of events) {
    const d = e.data;
    const id = String(e.seq);
    switch (d.kind) {
      case "turn-start":
        flushQuiet(); lastEdit = undefined;
        out.push({ id, at: e.at, kind: "turn", title: d.prompt ?? "New turn", source: d.source, expanded: d.prompt ? [{ label: "Request", text: d.prompt }] : [] });
        break;
      case "turn-end":
        flushQuiet(); lastEdit = undefined;
        out.push({ id, at: e.at, kind: "turn", title: d.failed ? "Turn failed" : d.message?.split("\n").find((l) => l.trim())?.trim() ?? "Finished a turn", source: d.source, status: d.failed ? "failed" : undefined, expanded: d.message ? [{ label: "Message", text: d.message }] : [] });
        break;
      case "tool-start": {
        if (d.quiet) {
          if (d.tool === "Read") quiet.reads++; else if (d.tool === "Grep" || d.tool === "Glob" || d.tool === "WebSearch") quiet.searches++; else quiet.other++;
          if (!quiet.moment) { quiet.moment = { id, at: e.at, kind: "quiet", title: "", source: d.source, expanded: [] }; out.push(quiet.moment); }
          quiet.moment.title = quietTitle();
          break;
        }
        const path = s(d.input.file_path) || s(d.input.notebook_path);
        const isEdit = /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(d.tool) && path !== "";
        if (!isEdit) lastEdit = undefined;
        if (isEdit && lastEdit && lastEdit.detail === path) {
          lastEdit.count = (lastEdit.count ?? 1) + 1;
          lastEdit.expanded.push(editExpansion(d.tool, d.input));
          openTools.set(d.toolUseId ?? id, lastEdit);
          break;
        }
        const m: Moment = isEdit
          ? { id, at: e.at, kind: "edit", title: basename(path) || d.tool, detail: path, status: "running", count: 1, source: d.source, expanded: [editExpansion(d.tool, d.input)] }
          : { id, at: e.at, kind: "command", title: d.tool === "Bash" || d.tool === "PowerShell" ? s(d.input.command).split("\n")[0].slice(0, 200) : d.tool === "AskUserQuestion" ? "Asked a question" : d.tool, destructive: d.destructive?.pattern, status: "running", source: d.source, expanded: [{ label: "Input", text: JSON.stringify(d.input, null, 2) }] };
        if (isEdit) lastEdit = m;
        out.push(m);
        openTools.set(d.toolUseId ?? id, m);
        openByName.set(d.tool, m);
        break;
      }
      case "tool-end": {
        const m = (d.toolUseId && openTools.get(d.toolUseId)) || openByName.get(d.tool);
        if (!m) break;
        m.status = d.ok ? "ok" : "failed";
        const bits = [d.summary, d.durationMs !== undefined ? `${(d.durationMs / 1000).toFixed(1)}s` : undefined, d.error].filter(Boolean);
        if (m.kind === "command" && bits.length) m.detail = bits.join(" · ");
        if (d.files?.length) m.expanded.push({ label: "Changed files", text: d.files.join("\n") });
        if (d.error) m.expanded.push({ label: "Error", text: d.error });
        // A moment sits at its latest activity, so a finished tool surfaces above decisions opened while it ran.
        const at = out.lastIndexOf(m);
        if (at !== -1 && at !== out.length - 1) { out.splice(at, 1); out.push(m); }
        if (d.toolUseId) openTools.delete(d.toolUseId);
        openByName.delete(d.tool);
        break;
      }
      case "prompt-open": {
        const m: Moment = { id, at: e.at, kind: "decision", title: d.prompt.title, detail: "Waiting", destructive: d.prompt.destructive?.pattern, source: d.source, expanded: d.prompt.detail ? [{ label: "Detail", text: d.prompt.detail }] : [] };
        prompts.set(e.seq, m);
        out.push(m);
        break;
      }
      case "answer": {
        const m = prompts.get(d.promptId);
        if (m) m.detail = `${d.option?.label ?? (d.text ? "Replied with text" : "Answered")} · answered through Infinite${d.result === "closed" ? "" : ` (${d.result})`}`;
        break;
      }
      case "prompt-closed": {
        const m = prompts.get(d.promptId);
        if (m && (m.detail === "Waiting" || !m.detail)) m.detail = d.reason === "vanished" ? `${d.label ?? "Answered"} elsewhere` : d.reason === "superseded" ? "Replaced by another prompt" : d.label ?? "Resolved";
        break;
      }
      case "error":
        out.push({ id, at: e.at, kind: "notice", title: d.message.split("\n")[0].slice(0, 200), status: "failed", source: d.source, expanded: [{ label: "Error", text: d.message }] });
        break;
      case "notice":
        // A hook-first prompt took the dialog's own title and detail once its block appeared.
        if (d.type === "prompt-merged" && d.promptId !== undefined) {
          const m = prompts.get(d.promptId);
          if (m) {
            if (d.title) m.title = d.title;
            m.expanded = d.detail ? [{ label: "Detail", text: d.detail }] : [];
          }
          break;
        }
        if (d.type === "session_end" || d.type === "auth_success" || d.type === "permission_denied")
          out.push({ id, at: e.at, kind: "notice", title: d.title ?? d.type.replace(/_/g, " "), detail: d.message, source: d.source, expanded: [] });
        break;
      default: break;
    }
  }
  return out.reverse();
}

function editExpansion(tool: string, input: Record<string, unknown>) {
  if (tool === "Edit") return { label: "Edit", text: `- ${s(input.old_string)}\n+ ${s(input.new_string)}` };
  if (tool === "Write") return { label: "Write", text: `wrote ${s(input.content).length} chars` };
  return { label: tool, text: JSON.stringify(input, null, 2) };
}
