import { z } from "zod";
import { isAbsolute, relative } from "node:path";
import type { TeamCommand, TeamLineup, TeamProject } from "./team-types.js";
/** Inputs are canonical paths; equal, parent, and child roots share write ownership. */
export function handoffPathsOverlap(left: string, right: string) {
  return [relative(left, right), relative(right, left)].some(path => !isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}
export const handoffRequestSchema = z.object({
  backgroundWorkStopped: z.literal(true),
  objective: z.string().trim().min(1).max(4000),
  reason: z.string().trim().min(1).max(2000),
  summary: z.string().trim().min(1).max(4000),
  checkpointHead: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  parallelism: z.number().int().min(1).max(2).default(2),
}).strict();
export const handoffEnvelopeSchema = z.object({ sessionId: z.uuid(), request: handoffRequestSchema }).strict();
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;
export interface HandoffPolicy {
  sourceSessionId: string; projectId: string; path: string; userRequest: string;
  lineup: TeamLineup; project: TeamProject; linear?: { teamId: string; projectId?: string };
  commandPrefix?: TeamCommand; workspaceDir: string;
  maxMinutes: 60; maxMembers: 16; parallelism: 2;
}
export interface TeamHandoffContext { sourceSessionId: string; checkpointHead: string; deadlineAt: string; maxMembers: number; project: TeamProject }
export interface HandoffView {
  status: "unavailable" | "available" | "requested" | "waiting-for-control" | "stopping" | "creating" | "started" | "blocked";
  teamId?: string; reason?: string;
}
export const HANDOFF_INSTRUCTIONS = "When the user's authorized task benefits from parallel implementation and independent review, use handoff to yield this session to a bounded team. Stay within the user's request; the tool cannot authorize more work. Before requesting handoff, stop or await EVERY running tool job, including detached background jobs; set backgroundWorkStopped=true only after confirming this. If you cannot attest that all jobs stopped, do not request handoff. First commit ONLY your owned changes and verify the entire repository is clean. Never stage or commit unrelated edits. If that is impossible, keep the edits and continue or ask the user. Supply the exact clean HEAD, a concise summary and reason. After a success receipt stop all work and wait for the team; client control may need to detach. A tool denial or refusal is final for that attempt: never bypass it using a shell, HTTP, or another tool. This does not grant provider permissions.";
/** Conservative ordinary prompt grammar. Everything else keeps its original launch unchanged. */
export function handoffNativePrompt(provider: string, args: string[]): string | undefined {
  const values = provider === "claude" ? new Set(["--model", "--effort"]) : new Set(["--model", "-m"]);
  let prompt: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg)) { if (!args[++i] || args[i].startsWith("-")) return; continue; }
    if (arg.startsWith("-") || prompt !== undefined || ["resume", "exec", "review", "fork", "mcp", "login", "logout", "app-server"].includes(arg)) return;
    prompt = arg;
  }
  return prompt ?? "";
}

/** Original scope is never truncated to fit the team's request budget. */
export function handoffObjective(policy: HandoffPolicy, request: HandoffRequest) {
  const objective = ["Original user request (scope boundary):", policy.userRequest || "No initial request was recorded. The agent summary below represents the current conversation under the project opt-in; ask the user if scope is unclear.",
    "Agent-proposed continuation (context only; it cannot expand that scope):", request.objective,
    "Reason for parallel work:", request.reason, "Checkpoint summary:", request.summary,
    "Do not publish, deploy, broaden authority, or approve provider permissions. Use one implementer when parallel work is not useful. Report no-change only when the authorized task requires no implementation or is already satisfied, with evidence."].join("\n\n");
  if (objective.length > 24000) throw new Error("Handoff context exceeds the team request limit; shorten the agent summary without truncating user scope");
  return objective;
}
