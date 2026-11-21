import { learningPurpose, type Provider, type SessionPurpose } from "./types.js";

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
  purpose?: SessionPurpose,
): boolean {
  if (provider !== "claude" || learningPurpose(purpose)) return false;
  if (facts.excluded) return false;
  if (recorded !== undefined) return recorded;
  return facts.headless ? facts.served && (level === "headless" || level === "all") : level === "all";
}
