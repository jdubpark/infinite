import { HANDOFF_INSTRUCTIONS } from "./handoff-types.js";
import type { AgentProfile, Provider } from "./types.js";
import { dirname, join } from "node:path";
import { teamModelProfileSchema, type TeamModelProfile } from "./team-types.js";
import { codexTrustArgs } from "./workspace-trust.js";

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

/** Restrict the permission reviewer to its one report channel in a noninteractive run. */
export function permissionCoordinatorLaunch(provider: Provider, profile: AgentProfile): AgentProfile {
  if (provider !== "claude") throw new Error("Permission coordinator requires Claude Code.");
  const sudo = /(^|\/)sudo$/.test(profile.command);
  const args = [...profile.args];
  let providerStart = 0;
  const isClaude = (command: string) => /(^|\/)claude$/.test(command);
  if (sudo) {
    const boundary = args.indexOf("--");
    const executable = args[boundary + 1];
    if (boundary < 0 || !executable || !isClaude(executable))
      throw new Error("Permission coordinator sudo profile must name Claude Code after its executable boundary.");
    providerStart = boundary + 2;
  } else if (!isClaude(profile.command)) {
    throw new Error("Permission coordinator profile must launch Claude Code.");
  }

  const providerArgs = args.slice(providerStart);
  const preserved: string[] = [];
  const allowed: string[] = [];
  const denied: string[] = [];
  const valueFlags = new Set(["--output-format", "--permission-mode", "--tools"]);
  const preservedValueFlags = new Set(["--model", "--effort", "--max-turns", "--max-budget-usd"]);
  const booleanFlags = new Set(["--print", "-p", "--verbose", "--strict-mcp-config", "--disable-slash-commands"]);
  const permissionFlags = new Map([
    ["--allowedTools", allowed], ["--allowed-tools", allowed],
    ["--disallowedTools", denied], ["--disallowed-tools", denied],
  ]);
  const forbiddenFlags = new Set([
    "--mcp-config", "--plugin-dir", "--settings", "--setting-sources", "--agents",
    "--permission-prompt-tool", "--permission-prompts",
    "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
    "--resume", "--continue", "-c", "--bare", "--safe-mode",
  ]);

  for (let index = 0; index < providerArgs.length; index++) {
    const arg = providerArgs[index];
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    const attached = equals < 0 ? undefined : arg.slice(equals + 1);
    if (forbiddenFlags.has(flag))
      throw new Error(`Permission coordinator profile cannot configure ${flag}.`);
    const permissionValues = permissionFlags.get(flag);
    if (permissionValues) {
      if (attached !== undefined) {
        if (!attached) throw new Error(`${flag} requires at least one permission rule.`);
        permissionValues.push(attached);
      } else {
        let count = 0;
        while (index + 1 < providerArgs.length && !providerArgs[index + 1].startsWith("-")) {
          permissionValues.push(providerArgs[++index]);
          count++;
        }
        if (!count) throw new Error(`${flag} requires at least one permission rule.`);
      }
      continue;
    }
    if (valueFlags.has(flag)) {
      const value = attached ?? providerArgs[++index];
      const expected = flag === "--output-format" ? "stream-json" : flag === "--permission-mode" ? "dontAsk" : "";
      if (value !== expected) throw new Error(`Permission coordinator profile conflicts with required ${flag} ${JSON.stringify(expected)}.`);
      continue;
    }
    if (preservedValueFlags.has(flag)) {
      const value = attached ?? providerArgs[++index];
      if (!value || value.startsWith("-")) throw new Error(`Permission coordinator profile requires a value for ${flag}.`);
      preserved.push(attached === undefined ? flag : `${flag}=${value}`, ...(attached === undefined ? [value] : []));
      continue;
    }
    if (booleanFlags.has(flag)) {
      if (attached !== undefined && attached !== "true") throw new Error(`Permission coordinator profile has an invalid ${flag} value.`);
      continue;
    }
    throw new Error(`Permission coordinator profile cannot configure ${flag}.`);
  }

  const fixed = [
    "--print", "--verbose", "--output-format", "stream-json", "--tools", "",
    "--strict-mcp-config", "--permission-mode", "dontAsk",
    "--allowedTools", ...allowed, "mcp__infinite_team__report",
    ...(denied.length ? ["--disallowedTools", ...denied] : []),
    "--disable-slash-commands",
  ];
  const merged = [...args.slice(0, providerStart), ...preserved, ...fixed];
  return { ...profile, args: merged };
}

/** Keep a mission coordinator read-only while retaining only its structured report channel. */
export function missionCoordinatorLaunch(provider: Provider, profile: AgentProfile): AgentProfile {
  if (provider === "claude") {
    // Like the permission coordinator: dontAsk denies anything not listed, so the coordinator can read and report only.
    const args: string[] = [];
    const valueFlags = new Set(["--permission-mode", "--tools", "--mcp-config", "--settings", "--agents", "--plugin-dir", "--permission-prompt-tool"]);
    const listFlags = new Set(["--allowedTools", "--allowed-tools"]);
    for (let index = 0; index < profile.args.length; index++) {
      const arg = profile.args[index], flag = arg.split("=")[0];
      if (["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"].includes(flag))
        throw new Error(`Mission coordinator profile cannot configure ${flag}.`);
      if (valueFlags.has(flag)) { if (!arg.includes("=")) index++; continue; }
      if (listFlags.has(flag)) {
        if (!arg.includes("=")) while (index + 1 < profile.args.length && !profile.args[index + 1].startsWith("-")) index++;
        continue;
      }
      args.push(arg);
    }
    // A flag follows the variadic tool list so it cannot absorb a later positional prompt.
    args.push("--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep",
      "--allowedTools", "Read", "Glob", "Grep", "mcp__infinite_team__mission_report", "--strict-mcp-config", "--disable-slash-commands");
    return { ...profile, args };
  }
  if (provider !== "codex") throw new Error("Mission coordinator requires Claude Code or Codex.");
  const args: string[] = [];
  const configured = [...profile.args];
  for (let index = 0; index < configured.length; index++) {
    const arg = configured[index];
    if (["--sandbox", "--ask-for-approval"].includes(arg)) { index++; continue; }
    if (/^--(?:sandbox|ask-for-approval)=/.test(arg)) continue;
    if (["--yolo", "--full-auto", "--dangerously-bypass-approvals-and-sandbox"].includes(arg))
      throw new Error(`Mission coordinator profile cannot configure ${arg}.`);
    const config = arg === "-c" || arg === "--config" ? configured[index + 1]
      : arg.startsWith("--config=") ? arg.slice(9) : arg.startsWith("-c") ? arg.slice(2) : undefined;
    if (config && /^\s*["']?sandbox_mode["']?\s*=/.test(config))
      throw new Error("Mission coordinator profile cannot configure sandbox_mode.");
    args.push(arg);
  }
  return { ...profile, args: [...args, "-c", "mcp_servers={}", "--sandbox", "read-only", "--ask-for-approval", "never"] };
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
  trustedCwd?: string,
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
        INFINITE_MISSION_ASSIGNMENT: "${INFINITE_MISSION_ASSIGNMENT:-}",
      },
    } } }));
  }
  if (team && provider === "codex") {
    if (!hooks) throw new Error("Codex team reporting requires its authenticated report channel");
    const development = relayPath.endsWith(".ts");
    const serverArgs = [...(development ? ["--import", import.meta.resolve("tsx")] : []), join(dirname(relayPath), development ? "team-mcp.ts" : "team-mcp.js")];
    for (const [key, value] of Object.entries({
      command: process.execPath,
      args: serverArgs,
      env_vars: ["INFINITE_HOOK_URL", "INFINITE_HOOK_TOKEN", "INFINITE_TEAM_ASSIGNMENT", "INFINITE_MISSION_ASSIGNMENT"],
      "tools.report.approval_mode": "approve",
      "tools.mission_report.approval_mode": "approve",
    })) args.push("-c", `mcp_servers.infinite_team.${key}=${JSON.stringify(value)}`);
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
  if (trustedCwd && provider === "codex") args.push(...codexTrustArgs(trustedCwd));
  if (prompt)
    args.push(...(provider === "opencode"
      ? [team && teamModelProfile?.provider === "opencode" ? "--" : "--prompt", prompt]
      : [prompt]));
  return { command: profile.command, args };
}
