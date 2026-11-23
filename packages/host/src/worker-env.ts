import { CLAUDE_CODE_MODE_ENV } from "./code-mode.js";

export function addProjectIdToLaunchEnv(env: Record<string, string>, projectId: string | undefined) {
  if (typeof projectId === "string" && /^[A-Za-z0-9._-]+$/.test(projectId))
    env.INFINITE_PROJECT_ID = projectId;
}

export function addClaudeCodeModeToLaunchEnv(env: Record<string, string>, enabled: boolean) {
  if (enabled) env[CLAUDE_CODE_MODE_ENV] = "1";
}
