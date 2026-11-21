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
  // A headless run takes the request only from its --settings argument, and the host puts it there only for a served launch.
  if (facts.excluded || (facts.headless && !facts.served)) return false;
  if (recorded !== undefined) return recorded;
  return facts.headless ? level === "headless" || level === "all" : level === "all";
}
