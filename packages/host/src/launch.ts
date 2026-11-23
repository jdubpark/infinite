import { HANDOFF_INSTRUCTIONS } from "./handoff-types.js";
import { learningPurpose, type AgentProfile, type Config, type Provider, type SessionPurpose } from "./types.js";
import { dirname, join } from "node:path";
import { teamModelProfileSchema, type TeamModelProfile } from "./team-types.js";
import { TeamError } from "./team-workspace.js";
import { codexTrustArgs } from "./workspace-trust.js";
import { sudoShape } from "./sudo-profile.js";
import { EGRESS_ENVIRONMENT_NAMES } from "./egress.js";
import { CLAUDE_CODE_MODE_ENV, codeModeEnabled } from "./code-mode.js";

/** eval.member.agents[provider] for a learning purpose, else config.agents[provider]. Throws TeamError 409 "eval-identity-missing" for a learning purpose without an eval profile for the provider. */
export function sessionAgentProfile(config: Pick<Config, "agents" | "eval">, provider: Provider, purpose: SessionPurpose | undefined): AgentProfile | undefined {
  if (!learningPurpose(purpose)) return config.agents[provider];
  const agents = config.eval?.member?.agents;
  const profile = agents && (provider === "claude" || provider === "codex" || provider === "opencode") ? agents[provider] : undefined;
  if (!profile) throw new TeamError(409, "eval-identity-missing", "The eval identity has no launch profile for this provider.");
  return profile;
}

/**
 * Whether a new Claude team member of this host would be asked to start in Code Mode. Routing needs the answer before a
 * launch exists, so this is an estimate from the configured level and the shape of the Claude launch profile: a
 * headless launch whose shape the permission channel can serve counts as served. Each launch records its own answer,
 * which is no for a learning run and for a headless launch the channel does not serve. A learning run carries no
 * routing pin, so routing never reads this estimate for one.
 */
export function memberCodeModeExpected(config: Pick<Config, "agents" | "codeMode">): boolean {
  const profile = config.agents.claude;
  if (!profile) return false;
  const shape = headlessLaunch("claude", profile);
  return codeModeEnabled(config.codeMode?.claude, "claude", { headless: shape.headless, served: shape.headless && shape.unservable === undefined, excluded: false });
}

/** For a learning purpose, the snapshot with `text: ""` and `sources: []`: today's text is not the text of the work's time. */
export function withoutSharedContext<T extends { text: string; sources: readonly unknown[] }>(context: T, purpose: SessionPurpose | undefined): T {
  return learningPurpose(purpose) ? { ...context, text: "", sources: [] } : context;
}

/** Only model controls are added here; the configured provider permissions remain unchanged. */
export function teamModelLaunch(profile: AgentProfile, input: TeamModelProfile): AgentProfile {
  const selection = teamModelProfileSchema.parse(input);
  let providerArgs = profile.args;
  if (/(^|\/)sudo$/.test(profile.command)) {
    const shape = sudoShape(profile.args);
    if (!shape.ok) {
      throw shape.problem === "wrapper"
        ? new Error("Mixed-model sudo profiles require an explicit -- executable boundary, with only -n, -H, -u USER, or -g GROUP before it.")
        : new Error("The sudo provider profile must name an executable after --.");
    }
    providerArgs = shape.providerArgs;
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
    "--resume", "-r", "--session-id", "--continue", "-c", "--bare", "--safe-mode",
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
    const valueFlags = new Set(["--permission-mode", "--settings", "--agents", "--plugin-dir", "--permission-prompt-tool"]);
    // Variadic flags lose every value, so no stray value can become the positional prompt.
    const listFlags = new Set(["--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--tools", "--mcp-config"]);
    for (let index = 0; index < profile.args.length; index++) {
      const arg = profile.args[index], flag = arg.split("=")[0];
      if (["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--session-id", "--resume", "-r", "--continue", "-c"].includes(flag))
        throw new Error(`Mission coordinator profile cannot configure ${flag}.`);
      if (arg.startsWith("-c") && arg !== "--" && !arg.startsWith("--"))
        throw new Error("Mission coordinator profile cannot configure -c.");
      if (arg.startsWith("-r") && !arg.startsWith("--"))
        throw new Error("Mission coordinator profile cannot configure -r.");
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
  // Codex merges inherited MCP server tables, so a coordinator could keep write-capable tools
  // outside its read-only sandbox. Codex coordinators wait until that can be enforced.
  throw new Error("Mission coordinators require Claude Code.");
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
/** A TOML basic string. JSON escapes what TOML requires escaped, except DEL, which TOML also refuses raw. */
const tomlString = (value: string) => JSON.stringify(value).replace(/\x7f/g, "\\u007f");

const CODEX_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
];

/** The class check answers quickly; its relay denies at 15 seconds, before this timeout could let the call through. */
export const PERMISSION_CHECK_TIMEOUT_S = 30;
/** Above the five-minute review bound. A timeout falls to the provider's normal flow, which denies a headless call. */
export const PERMISSION_REQUEST_TIMEOUT_S = 360;

/**
 * The settings of a served headless Claude session. `disableAllHooks: false` in this layer outranks a project or local
 * settings file, `--setting-sources ""` loads none of those files, and every hook command starts this host's own
 * interpreter by absolute path. The channel hooks are separate commands from the signal relay, whose reply never
 * becomes a provider decision.
 */
export function headlessChannelArgs(relayPath: string, signalHooks: boolean, codeMode = false): string[] {
  const development = relayPath.endsWith(".ts");
  const run = (script: string, route: string) =>
    [process.execPath, ...(development ? ["--import", import.meta.resolve("tsx")] : []), script, route].join(" ");
  const channel = join(dirname(relayPath), development ? "permission-hook.ts" : "permission-hook.js");
  const signal = { type: "command", command: run(relayPath, "claude"), timeout: 10 };
  const check = { type: "command", command: run(channel, "check"), timeout: PERMISSION_CHECK_TIMEOUT_S };
  const decide = { type: "command", command: run(channel, "request"), timeout: PERMISSION_REQUEST_TIMEOUT_S };
  const hooks: Record<string, { hooks: object[] }[]> = {};
  for (const event of CLAUDE_EVENTS) {
    // The signal relay would open a hook-only prompt for each PermissionRequest and push the owner while the
    // permission agent decides it. The channel's own hook handles that event; the worker shows what waits.
    const relayed = signalHooks && event !== "PermissionRequest";
    const handlers = [...(relayed ? [signal] : []), ...(event === "PreToolUse" ? [check] : event === "PermissionRequest" ? [decide] : [])];
    if (handlers.length) hooks[event] = [{ hooks: handlers }];
  }
  return ["--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: false, hooks,
    ...(codeMode ? { env: { [CLAUDE_CODE_MODE_ENV]: "1" } } : {}),
  })];
}

/** What the host can tell about a launch from the arguments it passes the provider. */
export interface HeadlessLaunch {
  /** The provider runs without a dialog: Claude Code `--print`, OpenCode `run`, Codex `exec`. */
  headless: boolean;
  /** Why the permission channel cannot serve this headless launch. Absent when it can. */
  unservable?: string;
  /** The launch profile's allow rules, as given. They stay in force. */
  allowlist: string[];
}

/**
 * Reads a launch profile. Only a Claude Code `--print` launch in the default permission mode can be served: the
 * `PermissionRequest` hook was observed to fire there, and not under `dontAsk`. A flag that would replace the host's
 * settings, bypass permissions, or start from another conversation makes the launch unservable.
 */
export function headlessLaunch(provider: Provider, profile: AgentProfile): HeadlessLaunch {
  let args = profile.args;
  if (/(^|\/)sudo$/.test(profile.command)) {
    const shape = sudoShape(profile.args);
    if (!shape.ok) return { headless: false, allowlist: [] };
    args = shape.providerArgs;
  }
  if (provider === "opencode" || provider === "codex") {
    const headless = provider === "opencode" ? args.includes("run") : args.includes("exec");
    return headless ? { headless, allowlist: [], unservable: `${provider === "opencode" ? "OpenCode" : "Codex"} has no verified headless permission channel.` } : { headless: false, allowlist: [] };
  }
  if (provider !== "claude") return { headless: false, allowlist: [] };
  const allowlist: string[] = [];
  let headless = false, mode: string | undefined, conflict: string | undefined;
  // A continuation flag is servable: the resumed conversation's calls reach the channel like any other. A forked or
  // unpersisted conversation cannot be resumed in place, so a deferred call could never be returned to it.
  const conflicts = new Set(["--settings", "--setting-sources", "--permission-prompt-tool", "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions", "--fork-session", "--no-session-persistence", "--bare", "--safe-mode"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index], equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (flag === "-p" || flag === "--print") headless ||= equals < 0 || arg.slice(equals + 1) === "true";
    else if (flag === "--permission-mode") mode = equals < 0 ? args[++index] : arg.slice(equals + 1);
    else if (flag === "--allowedTools" || flag === "--allowed-tools") {
      // A rule such as `Bash(git status)` keeps its spaces; only separators outside parentheses split rules.
      if (equals >= 0) allowlist.push(...(arg.slice(equals + 1).match(/(?:[^\s,(]+(?:\([^)]*\))?)+/g) ?? []));
      else while (index + 1 < args.length && !args[index + 1].startsWith("-")) allowlist.push(args[++index]);
    } else if (conflicts.has(flag)) conflict ??= flag;
  }
  if (!headless) return { headless: false, allowlist };
  if (conflict) return { headless, allowlist, unservable: `The launch profile sets ${conflict}, which the permission channel cannot combine with its own settings.` };
  if (mode !== undefined && mode !== "default")
    return { headless, allowlist, unservable: mode === "dontAsk"
      ? "Permission mode dontAsk refuses an open call before the PermissionRequest hook fires."
      : `Permission mode ${mode} was not verified with the permission channel.` };
  return { headless, allowlist };
}

/**
 * The profile that resumes a served headless conversation in place after the owner answered its deferred call: the
 * same provider arguments without a continuation flag of their own, then `--resume` with the conversation's id.
 */
export function headlessResumeProfile(profile: AgentProfile, nativeSessionId: string): AgentProfile {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(nativeSessionId)) throw new Error("Invalid native conversation id");
  let prefix = 0;
  if (/(^|\/)sudo$/.test(profile.command)) {
    const shape = sudoShape(profile.args);
    if (!shape.ok) throw new Error("The sudo provider profile cannot be resumed in place");
    prefix = shape.options.length + 2;
  }
  const kept: string[] = [];
  const rest = profile.args.slice(prefix);
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index], equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (flag === "--continue" || flag === "-c") continue;
    if (flag === "--resume" || flag === "-r" || flag === "--session-id") {
      if (equals < 0 && index + 1 < rest.length && !rest[index + 1].startsWith("-")) index++;
      continue;
    }
    kept.push(arg);
  }
  return { ...profile, args: [...profile.args.slice(0, prefix), ...kept, "--resume", nativeSessionId] };
}

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
  entryTools?: boolean,
  /** The host admitted this headless Claude session to the permission channel. */
  channel = false,
  egressConfigured = false,
  codeMode = false,
  /** How many of the profile's last arguments are native ones: what the owner typed, or the host's own `--resume ID`. */
  nativeArgCount = 0,
): AgentProfile {
  const args = [...profile.args];
  const hostEgressEnvVars = egressConfigured ? EGRESS_ENVIRONMENT_NAMES : [];
  // Entry tools ride the team report channel. They add no provider permission, so the profile's own decisions still apply.
  const withEntryTools = Boolean(team && entryTools && !handoffSessionId);
  if (handoffSessionId) {
    if (!hooks || !["claude", "codex"].includes(provider)) throw new Error("Handoff requires an authenticated provider channel");
    const development = relayPath.endsWith(".ts");
    const serverArgs = [...(development ? ["--import", import.meta.resolve("tsx")] : []), join(dirname(relayPath), development ? "team-mcp.ts" : "team-mcp.js")];
    if (provider === "claude") args.push("--append-system-prompt", HANDOFF_INSTRUCTIONS, "--mcp-config", JSON.stringify({ mcpServers: { infinite_handoff: {
      type: "stdio", command: process.execPath, args: serverArgs,
      env: { INFINITE_HOOK_URL: "${INFINITE_HOOK_URL}", INFINITE_HOOK_TOKEN: "${INFINITE_HOOK_TOKEN}", INFINITE_HANDOFF_SESSION: handoffSessionId },
    } } }));
    else {
      const envVars = ["INFINITE_HOOK_URL", "INFINITE_HOOK_TOKEN", ...hostEgressEnvVars];
      for (const [key, value] of Object.entries({ command: process.execPath, args: serverArgs, env_vars: envVars, "env.INFINITE_HANDOFF_SESSION": handoffSessionId }))
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
        ...(withEntryTools ? { INFINITE_TEAM_ENTRY_TOOLS: "1" } : {}),
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
      env_vars: ["INFINITE_HOOK_URL", "INFINITE_HOOK_TOKEN", "INFINITE_TEAM_ASSIGNMENT", "INFINITE_MISSION_ASSIGNMENT", "INFINITE_PROJECT_ID", ...hostEgressEnvVars],
      "tools.report.approval_mode": "approve",
      "tools.mission_report.approval_mode": "approve",
      ...(withEntryTools ? {
        "env.INFINITE_TEAM_ENTRY_TOOLS": "1",
        "tools.entry_post.approval_mode": "approve",
        "tools.entry_list.approval_mode": "approve",
        "tools.entry_get.approval_mode": "approve",
      } : {}),
    })) args.push("-c", `mcp_servers.infinite_team.${key}=${JSON.stringify(value)}`);
  }
  // Dev runs the relay from TypeScript through tsx; builds run the compiled file. The tsx
  // loader is passed as an absolute URL because the agent's cwd is the project, not this repo.
  const relay = relayPath.endsWith(".ts")
    ? ["node", "--import", import.meta.resolve("tsx"), relayPath]
    : ["node", relayPath];
  // An interactive Claude launch takes the Code Mode request from the `env` key of this argument as it does from its
  // own environment. A command prefix such as sudo drops the variable and passes the argument, so the request rides here.
  const codeModeRequest = codeMode && provider === "claude" && !channel ? { env: { [CLAUDE_CODE_MODE_ENV]: "1" } } : undefined;
  if (hooks && provider === "claude" && enabled.claude && !channel) {
    // A command hook, not an HTTP hook: the relay runs in the agent's account and is the only
    // process that can read the transcript the worker asks for in its reply.
    const handler = { type: "command", command: [...relay, "claude"].join(" "), timeout: 10 };
    // Stated outright because a project settings file that sets `disableAllHooks` would otherwise switch these
    // hooks off in a running session. This layer outranks project and local settings.
    const settings = {
      disableAllHooks: false,
      hooks: Object.fromEntries(
        CLAUDE_EVENTS.map((e) => [e, [{ hooks: [handler] }]]),
      ),
      ...codeModeRequest,
    };
    args.push("--settings", JSON.stringify(settings));
  } else if (codeModeRequest && !profile.args.some(arg => arg === "--settings" || arg.startsWith("--settings="))) {
    // Without the hook layer (hooks off, a native launch, a resume) the host passes this argument for the request
    // alone. It goes ahead of the native arguments, which stay exact: Claude Code reads what follows a typed `--` as
    // prompt text. Claude Code honours only the last such argument, so a launch that brings its own keeps it, and its
    // request travels only in the environment.
    args.splice(Math.max(0, profile.args.length - nativeArgCount), 0, "--settings", JSON.stringify(codeModeRequest));
  }
  // A served headless session: the permission channel's hooks and the signal hooks in one settings layer, with no
  // user, project or local settings loaded, so no settings file can switch them off or answer before them.
  if (hooks && provider === "claude" && channel) args.push(...headlessChannelArgs(relayPath, enabled.claude, codeMode));
  // Every other Claude team launch (member, mission coordinator, permission coordinator) loads the agent account's own
  // settings and no project or local file. A Codex member can commit `.claude/settings.json` or `.mcp.json`; Claude Code
  // runs their hooks and MCP server commands in any folder and applies their allow rules in a trusted one, so a later
  // member would load what an earlier one wrote. Managed settings and the host's `--settings` layer load either way.
  if (team && provider === "claude" && !channel) {
    if (profile.args.some(arg => arg === "--setting-sources" || arg.startsWith("--setting-sources=")))
      throw new Error("A Claude team launch chooses its own setting sources; remove --setting-sources from the profile.");
    args.push("--setting-sources", "user");
  }
  if (hooks && provider === "codex") {
    // notify needs no hook trust, so it stays on when Codex hooks are off; turn-end usage then needs no bypass (INF-213).
    args.push("-c", `notify=[${[...relay, "codex-notify"].map(tomlString).join(",")}]`);
    if (enabled.codex) {
      const command = [...relay, "codex"].join(" ");
      for (const event of CODEX_EVENTS)
        args.push(
          "-c",
          `hooks.${event}=[{hooks=[{type="command",command=${tomlString(command)}}]}]`,
        );
      args.push("--dangerously-bypass-hook-trust");
      args.push(
        "-c",
        `tui.notifications=["agent-turn-complete","approval-requested","async-question"]`,
      );
      args.push("-c", `tui.notification_method="osc9"`);
      args.push("-c", `tui.notification_condition="always"`);
    }
  }
  if (trustedCwd && provider === "codex") args.push(...codexTrustArgs(trustedCwd));
  if (prompt)
    args.push(...(provider === "opencode"
      ? [team && teamModelProfile?.provider === "opencode" ? "--" : "--prompt", prompt]
      : [prompt]));
  return { command: profile.command, args };
}
