import { ContentError } from "./session-content.js";
import type { Provider } from "./types.js";

const historyError = () => new ContentError(
  "Native conversation selection can reuse history from another project. Use infinite resume SESSION_ID to continue a recorded session.",
  400,
);

const optionValues: Partial<Record<Provider, ReadonlySet<string>>> = {
  claude: new Set([
    "--add-dir", "--agent", "--agents", "--allowedTools", "--allowed-tools", "--append-system-prompt",
    "--autocompact", "--betas", "--debug", "--debug-file", "--effort", "--environment", "--fallback-model",
    "--file", "--input-format", "--json-schema", "--max-budget-usd", "--mcp-config", "--model", "--name",
    "--output-format", "--permission-mode", "--permission-prompts", "--plugin-dir", "--plugin-url", "--prompt-suggestions",
    "--remote-control", "--remote-control-session-name-prefix", "--setting-sources", "--settings", "--system-prompt",
    "--system-prompt-file", "--system-prompt-snapshot", "--tools", "--worktree", "-d", "-n",
  ]),
  codex: new Set([
    "--add-dir", "--ask-for-approval", "--cd", "--color", "--config", "--cyber-access-program", "--disable", "--enable",
    "--image", "--local-provider", "--model", "--output-last-message", "--output-schema", "--profile", "--remote",
    "--remote-auth-token-env", "--sandbox", "--thread-source", "-C", "-a", "-c", "-i", "-m", "-o", "-p", "-s",
  ]),
  grok: new Set([
    "--agent", "--agents", "--allow", "--deny", "--disallowed-tools", "--debug-file", "--json-schema", "--max-turns",
    "--model", "--output-format", "--permission-mode", "--prompt-file", "--prompt-json", "--rules", "--sandbox",
    "--cwd", "--effort", "--leader-socket", "--reasoning-effort", "--session-id", "--single", "--system-prompt",
    "--system-prompt-override", "--tools", "--worktree", "--worktree-ref", "--ref", "--allowed-tools", "--allowedTools",
    "--disallowedTools", "-m", "-p", "-r", "-s", "-w",
  ]),
  opencode: new Set([
    "--agent", "--cors", "--hostname", "--log-level", "--mdns-domain", "--model", "--port", "--prompt",
    "--replay-limit", "-m",
  ]),
};

const shortValues: Partial<Record<Provider, ReadonlySet<string>>> = {
  claude: new Set(["d", "n"]),
  codex: new Set(["C", "a", "c", "i", "m", "o", "p", "s"]),
  grok: new Set(["m", "p", "s", "w"]),
  opencode: new Set(["m"]),
};

const historyFlags: Partial<Record<Provider, ReadonlySet<string>>> = {
  claude: new Set(["-c", "--continue", "-r", "--resume", "--fork-session", "--from-pr", "--teleport", "--cloud"]),
  codex: new Set([]),
  grok: new Set(["-c", "--continue", "-r", "--resume", "--fork-session"]),
  opencode: new Set(["-c", "--continue", "-s", "--session", "--fork"]),
};

const historyCommands: Partial<Record<Provider, ReadonlySet<string>>> = {
  claude: new Set(["attach", "respawn"]),
  codex: new Set(["resume", "fork", "queue"]),
  grok: new Set(["sessions"]),
  opencode: new Set(["attach", "import"]),
};

/** Reject public launches that ask a provider CLI to select an existing conversation. */
export function assertFreshNativeContext(provider: Provider, args: string[]): void {
  const flags = historyFlags[provider];
  const values = optionValues[provider];
  const commands = historyCommands[provider];

  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === "--") return;

    const equals = argument.indexOf("=");
    const flag = equals > 0 ? argument.slice(0, equals) : argument;
    if (flags?.has(flag)) throw historyError();
    if (!argument.startsWith("--") && argument.startsWith("-")) {
      const valued = shortValues[provider];
      const history = flags;
      for (const shortFlag of argument.slice(1)) {
        if (history?.has(`-${shortFlag}`)) throw historyError();
        if (valued?.has(shortFlag)) break;
      }
    }

    if (argument.startsWith("-")) {
      // A dash-leading token is parsed as another option by these CLIs unless
      // attached with `=`, so don't let a missing option value hide a selector.
      if (values?.has(flag) && equals < 0 && args[i + 1] && !args[i + 1].startsWith("-")) i++;
      continue;
    }

    // Some native parsers recognize subcommands after another positional value.
    // A normal prompt is one argument; literal command tokens can follow `--`.
    if (commands?.has(argument)) throw historyError();
  }
}
