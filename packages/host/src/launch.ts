import type { AgentProfile, Provider } from "./types.js";

const CLAUDE_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
  "Notification",
  "Elicitation",
  "Stop",
  "StopFailure",
  "SessionEnd",
];
const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
];

export function buildLaunch(
  provider: Provider,
  profile: AgentProfile,
  prompt: string,
  hooks: { url: string; token: string } | null,
  relayPath: string,
  enabled: { claude: boolean; codex: boolean },
): AgentProfile {
  const args = [...profile.args];
  if (hooks && provider === "claude" && enabled.claude) {
    const handler = {
      type: "http",
      url: `${hooks.url}/claude`,
      headers: { Authorization: "Bearer $INFINITE_HOOK_TOKEN" },
      allowedEnvVars: ["INFINITE_HOOK_TOKEN"],
      timeout: 5,
    };
    const settings = {
      hooks: Object.fromEntries(
        CLAUDE_EVENTS.map((e) => [e, [{ hooks: [handler] }]]),
      ),
    };
    args.push("--settings", JSON.stringify(settings));
  }
  if (hooks && provider === "codex" && enabled.codex) {
    // Dev runs the relay from TypeScript through tsx; builds run the compiled file. The tsx
    // loader is passed as an absolute URL because the agent's cwd is the project, not this repo.
    const relay = relayPath.endsWith(".ts")
      ? ["node", "--import", import.meta.resolve("tsx"), relayPath]
      : ["node", relayPath];
    const command = [...relay, "codex"].join(" ");
    for (const event of CODEX_EVENTS)
      args.push(
        "-c",
        `hooks.${event}=[{hooks=[{type="command",command="${command}"}]}]`,
      );
    args.push("--dangerously-bypass-hook-trust");
    args.push(
      "-c",
      `notify=[${[...relay, "codex-notify"].map((a) => `"${a}"`).join(",")}]`,
    );
    args.push(
      "-c",
      `tui.notifications=["agent-turn-complete","approval-requested","async-question"]`,
    );
    args.push("-c", `tui.notification_method="osc9"`);
    args.push("-c", `tui.notification_condition="always"`);
  }
  if (prompt)
    args.push(...(provider === "opencode" ? ["--prompt", prompt] : [prompt]));
  return { command: profile.command, args };
}
