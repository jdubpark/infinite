import { HANDOFF_INSTRUCTIONS } from "./handoff-types.js";
import type { AgentProfile, Provider } from "./types.js";
import { dirname, join } from "node:path";
import { teamModelProfileSchema, type TeamModelProfile } from "./team-types.js";

/** Only model controls are added here; the configured provider permissions remain unchanged. */
export function teamModelLaunch(profile: AgentProfile, input: TeamModelProfile): AgentProfile {
  const selection = teamModelProfileSchema.parse(input);
  let providerArgs = profile.args;
  if (/(^|\/)sudo$/.test(profile.command)) {
    const sudoBoundary = profile.args.indexOf("--");
    const invalidWrapper = () => new Error("Mixed-model sudo profiles require an explicit -- executable boundary, with only -n, -H, -u USER, or -g GROUP before it.");
    if (sudoBoundary < 0) throw invalidWrapper();
    // Recognize the supported wrapper instead of mistaking a provider's -- for sudo's.
    for (let index = 0; index < sudoBoundary; index++) {
      const arg = profile.args[index];
      if (["-n", "-H", "--non-interactive", "--set-home"].includes(arg)) continue;
      if (["-u", "-g", "--user", "--group"].includes(arg)) {
        const value = profile.args[++index];
        if (index < sudoBoundary && value && !value.startsWith("-")) continue;
      }
      throw invalidWrapper();
    }
    const executable = profile.args[sudoBoundary + 1];
    if (!executable || executable.startsWith("-")) throw new Error("The sudo provider profile must name an executable after --.");
    providerArgs = profile.args.slice(sudoBoundary + 2);
  }
  const conflict = providerArgs.some((arg, index, args) => {
    if (arg === "--" || /^--(?:model|effort|fallback-model)(?:=|$)/.test(arg)) return true;
    if (selection.provider === "opencode") return /^--variant(?:=|$)/.test(arg) || /^-m/.test(arg);
    if (selection.provider !== "codex") return false;
    if (/^-m/.test(arg)) return true;
    const override = arg === "-c" || arg === "--config" ? args[index + 1]
      : arg.startsWith("--config=") ? arg.slice(9) : arg.startsWith("-c") ? arg.slice(2) : undefined;
    return override !== undefined && /^\s*["']?(?:model|model_reasoning_effort)["']?\s*=/.test(override);
  });
  if (conflict) throw new Error("Move model and effort settings from the provider profile into the team lineup. Remove fallback-model arguments before starting a mixed-model team.");
  if (selection.provider === "opencode") {
    // Run mode owns the conversation, working directory, and prompt. Preserve
    // provider policy flags, but refuse alternate commands and session routing.
    const switches = new Set(["--pure", "--print-logs", "--thinking", "--auto", "--no-auto"]);
    const values = new Set(["--agent", "--format", "--title", "--log-level"]);
    for (let index = 0; index < providerArgs.length; index++) {
      const arg = providerArgs[index], separator = arg.indexOf("=");
      const flag = separator < 0 ? arg : arg.slice(0, separator);
      if (switches.has(flag) && (separator < 0 || ["true", "false"].includes(arg.slice(separator + 1)))) continue;
      if (values.has(flag)) {
        const value = separator < 0 ? providerArgs[++index] : arg.slice(separator + 1);
        if (value && !value.startsWith("-")) continue;
      }
      throw new Error("OpenCode team profiles support only --agent, --pure, --print-logs, --log-level, --format, --title, --thinking, and explicitly configured --auto; remove positional arguments, alternate commands, and session or directory overrides.");
    }
    const wrapper = profile.args.slice(0, profile.args.length - providerArgs.length);
    return { ...profile, args: [...wrapper, "run", ...providerArgs,
      // JSON events carry the per-message token and cost usage the worker records.
      ...(providerArgs.some(arg => arg === "--format" || arg.startsWith("--format=")) ? [] : ["--format", "json"]),
      "--model", selection.model,
      ...(selection.variant ? ["--variant", selection.variant] : []),
    ] };
  }
  return { ...profile, args: [...profile.args, "--model", selection.model,
    ...(selection.provider === "claude" ? ["--effort", selection.effort] : ["-c", `model_reasoning_effort=${JSON.stringify(selection.effort)}`]),
  ] };
}

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
  team = false,
  teamModelProfile?: TeamModelProfile,
  handoffSessionId?: string,
): AgentProfile {
  const args = [...profile.args];
  if (handoffSessionId) {
    if (!hooks || !["claude", "codex"].includes(provider)) throw new Error("Handoff requires an authenticated provider channel");
    const development = relayPath.endsWith(".ts");
    const serverArgs = [...(development ? ["--import", import.meta.resolve("tsx")] : []), join(dirname(relayPath), development ? "team-mcp.ts" : "team-mcp.js")];
    if (provider === "claude") args.push("--append-system-prompt", HANDOFF_INSTRUCTIONS, "--mcp-config", JSON.stringify({ mcpServers: { infinite_handoff: {
      type: "stdio", command: process.execPath, args: serverArgs,
      env: { INFINITE_HOOK_URL: "${INFINITE_HOOK_URL}", INFINITE_HOOK_TOKEN: "${INFINITE_HOOK_TOKEN}", INFINITE_HANDOFF_SESSION: handoffSessionId },
    } } }));
    else {
      for (const [key, value] of Object.entries({ command: process.execPath, args: serverArgs, env_vars: ["INFINITE_HOOK_URL", "INFINITE_HOOK_TOKEN"], "env.INFINITE_HANDOFF_SESSION": handoffSessionId }))
        args.push("-c", `mcp_servers.infinite_handoff.${key}=${JSON.stringify(value)}`);
    }
  }
  if (team && provider === "claude") {
    if (!hooks) throw new Error("Claude team reporting requires its authenticated report channel");
    const development = relayPath.endsWith(".ts");
    args.push("--mcp-config", JSON.stringify({ mcpServers: { infinite_team: {
      type: "stdio",
      command: process.execPath,
      args: [...(development ? ["--import", import.meta.resolve("tsx")] : []), join(dirname(relayPath), development ? "team-mcp.ts" : "team-mcp.js")],
      env: {
        INFINITE_HOOK_URL: "${INFINITE_HOOK_URL}",
        INFINITE_HOOK_TOKEN: "${INFINITE_HOOK_TOKEN}",
        INFINITE_TEAM_ASSIGNMENT: "${INFINITE_TEAM_ASSIGNMENT}",
      },
    } } }));
  }
  // Dev runs the relay from TypeScript through tsx; builds run the compiled file. The tsx
  // loader is passed as an absolute URL because the agent's cwd is the project, not this repo.
  const relay = relayPath.endsWith(".ts")
    ? ["node", "--import", import.meta.resolve("tsx"), relayPath]
    : ["node", relayPath];
  if (hooks && provider === "claude" && enabled.claude) {
    // A command hook, not an HTTP hook: the relay runs in the agent's account and is the only
    // process that can read the transcript the worker asks for in its reply.
    const handler = { type: "command", command: [...relay, "claude"].join(" "), timeout: 10 };
    const settings = {
      hooks: Object.fromEntries(
        CLAUDE_EVENTS.map((e) => [e, [{ hooks: [handler] }]]),
      ),
    };
    args.push("--settings", JSON.stringify(settings));
  }
  if (hooks && provider === "codex" && enabled.codex) {
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
    args.push(...(provider === "opencode"
      ? [team && teamModelProfile?.provider === "opencode" ? "--" : "--prompt", prompt]
      : [prompt]));
  return { command: profile.command, args };
}
