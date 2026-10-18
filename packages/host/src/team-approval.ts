import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { matchDestructive, type Prompt } from "@infinite/attention";

export type ApprovalPrompt = Pick<Prompt, "kind" | "title" | "detail" | "options" | "destructive">;
export type TeamApproval =
  | { action: "accept"; option: number }
  | { action: "ask-coordinator" }
  | { action: "leave" };

const compact = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** Ordinary team-workspace prompts the member may accept without a person or the coordinator. */
export function teamApprovalChoice(prompt: ApprovalPrompt, cwd: string): TeamApproval {
  const trust = prompt.options.find((option) => compact(option.label).includes("yesitrustthisfolder"));
  if (trust && compact(prompt.title).includes("isthisaprojectyoucreatedoroneyoutrust")) {
    return workspacePathShown(prompt, cwd) ? { action: "accept", option: trust.index } : { action: "leave" };
  }
  if (prompt.kind !== "permission" && prompt.kind !== "yes-no") return { action: "leave" };
  if (prompt.destructive || dangerousApproval(prompt)) return { action: "ask-coordinator" };
  const accept = prompt.options.find((option) => option.role === "accept");
  return accept ? { action: "accept", option: accept.index } : { action: "leave" };
}

function workspacePathShown(prompt: ApprovalPrompt, cwd: string): boolean {
  const folder = normalize(cwd);
  if (!isAbsolute(folder) || folder === "/" || folder.split("/").filter(Boolean).length < 2) return false;
  const shown = [prompt.detail ?? "", prompt.title].join("\n");
  return new RegExp(`(?:^|\\s)${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\s)`).test(shown);
}

function dangerousApproval(prompt: ApprovalPrompt): string | null {
  const text = [prompt.title, prompt.detail ?? "", ...prompt.options.map((option) => option.label)].join("\n");
  return matchDestructive(text)
    ?? (/\bsudo\b/.test(text) ? "sudo" : null)
    ?? (/\bgit\s+push\b/.test(text) ? "git-push" : null)
    ?? (/\bgh\s+(?:pr\s+merge|release\s+create)\b/.test(text) ? "publish" : null)
    ?? (/\b(?:dangerously-skip-permissions|bypassPermissions)\b/.test(text) ? "permission-bypass" : null)
    ?? (/(?:^|[^\w.-])(?:\.env(?:\.|$)|\.pem\b|id_rsa\b|credentials\.json\b|aws\/credentials\b)/i.test(text) ? "credential-file" : null);
}

/** Mark one assigned workspace trusted in Claude's project map. Other projects stay as they were. */
export function withClaudeWorkspaceTrust(existing: string | undefined, cwd: string): string {
  const folder = normalize(cwd);
  if (!isAbsolute(folder) || folder !== cwd || folder.includes("\0") || folder.split("/").filter(Boolean).length < 2)
    throw new Error("Claude trust can be recorded only for an absolute assigned workspace");
  let data: Record<string, unknown> = {};
  if (existing?.trim()) {
    const parsed: unknown = JSON.parse(existing);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude config is not an object");
    data = parsed as Record<string, unknown>;
  }
  const projects = data.projects && typeof data.projects === "object" && !Array.isArray(data.projects)
    ? { ...(data.projects as Record<string, unknown>) }
    : {};
  const current = projects[folder] && typeof projects[folder] === "object" && !Array.isArray(projects[folder])
    ? { ...(projects[folder] as Record<string, unknown>) }
    : {};
  if (current.hasTrustDialogAccepted === true) return existing ?? JSON.stringify({ ...data, projects });
  projects[folder] = { ...current, hasTrustDialogAccepted: true };
  return JSON.stringify({ ...data, projects });
}

export function acceptClaudeWorkspaceTrust(configPath: string, cwd: string) {
  let existing: string | undefined;
  try { existing = readFileSync(configPath, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const next = withClaudeWorkspaceTrust(existing, cwd);
  if (next === existing) return;
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, configPath);
}

export function coordinatorJudgePrompt(input: { workspace: string; role: string; title: string; detail?: string; options: string[] }): string {
  return [
    "Decide one provider approval for an Infinite team member.",
    "Reply with one JSON object only: {\"allow\":true,\"reason\":\"short reason\"} or {\"allow\":false,\"reason\":\"short reason\"}.",
    "Allow only when the action stays inside the assigned workspace and the task needs it.",
    "Deny publication, credential access, permission changes, and destructive commands. Deny when unsure.",
    `Workspace: ${input.workspace}`,
    `Role: ${input.role}`,
    `Prompt: ${input.title.slice(0, 300)}`,
    `Detail: ${(input.detail ?? "").slice(0, 2000)}`,
    `Options: ${input.options.join(" | ").slice(0, 500)}`,
  ].join("\n");
}

export function coordinatorJudgeLaunch(profile: { command: string; args: string[] }, prompt: string): { command: string; args: string[] } {
  return { command: profile.command, args: [...profile.args, "--print", "--tools", "", "--permission-mode", "plan", prompt] };
}

export function parseCoordinatorVerdict(text: string): { allow: boolean; reason: string } | null {
  const end = text.lastIndexOf("}");
  const start = text.lastIndexOf("{", end);
  if (start < 0 || end < start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { allow?: unknown }).allow !== "boolean") return null;
    const reason = (value as { reason?: unknown }).reason;
    return { allow: (value as { allow: boolean }).allow, reason: typeof reason === "string" ? reason.slice(0, 500) : "" };
  } catch { return null; }
}
