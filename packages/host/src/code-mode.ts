import type { ExecutionIdentity, Provider } from "./types.js";

export const CLAUDE_CODE_MODE_ENV = "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE";

export type CodeModeLevel = "off" | "headless" | "all";
export interface CodeModeLaunchFacts {
  headless: boolean;
  served: boolean;
  excluded: boolean;
}

export function codeModeEnabled(
  level: CodeModeLevel | undefined,
  provider: Provider,
  facts: CodeModeLaunchFacts,
  recorded?: boolean,
  executionIdentity: ExecutionIdentity = "production",
): boolean {
  if (provider !== "claude" || executionIdentity === "eval") return false;
  if (facts.excluded || (facts.headless && !facts.served)) return false;
  if (recorded !== undefined) return recorded;
  return facts.headless ? level === "headless" || level === "all" : level === "all";
}

export const claudeProgramInstructions = "Working rule for programs: when you call tools from a program, do the reading, filtering, counting and comparing inside the program, and print only the result you need for your next decision. Do not print whole tool results. When a program lists or reads items, print how many it listed, read, and matched. If your instructions name a context file, read it inside a program and select only the fields you need. Each call a program makes passes the same permission checks as a direct call. A rejected call is final inside a program too: do not catch the rejection and reach the same effect another way. Submit the final report on its own, not from a program that does other work: call mcp__infinite_team__report once, and read its receipt before you stop.";

export function memberLaunchPrompt(prompt: string, provider: Provider, codeMode: boolean): string {
  return codeMode && provider === "claude" ? `${prompt}\n\n${claudeProgramInstructions}` : prompt;
}
