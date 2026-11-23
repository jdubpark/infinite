import { CLAUDE_CODE_MODE_ENV } from "./code-mode.js";
import type { Session } from "./types.js";

export function addProjectIdToLaunchEnv(env: Record<string, string>, projectId: string | undefined) {
  if (typeof projectId === "string" && /^[A-Za-z0-9._-]+$/.test(projectId))
    env.INFINITE_PROJECT_ID = projectId;
}

export function addClaudeCodeModeToLaunchEnv(env: Record<string, string>, enabled: boolean) {
  if (enabled) env[CLAUDE_CODE_MODE_ENV] = "1";
}

/**
 * Whether the launch arguments carry the Code Mode request beside the environment. The host adds it only to arguments
 * it wrote itself, a resume among them. The owner's own native arguments stay exact, so the request of a fresh native
 * launch travels in the environment alone.
 */
export function codeModeInLaunchArguments(codeMode: boolean, session: Pick<Session, "nativeArgs" | "resumedFrom">): boolean {
  return codeMode && (session.nativeArgs === undefined || session.resumedFrom !== undefined);
}
