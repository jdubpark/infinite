import type { Prompt } from "./types.js";
import { isTruncatedArrayMarker, MAX_ARRAY_ITEMS } from "./truncate.js";

const CODEX_COMMAND_TITLE = /^would you like to run the following command\?$/i;

export function dialogCommand(prompt: Pick<Prompt, "title" | "detail">): string | undefined {
  if (!CODEX_COMMAND_TITLE.test(prompt.title.trim())) return undefined;
  const lines = (prompt.detail ?? "").split("\n").map(line => line.trim()).filter(Boolean);
  const starts = lines.flatMap((line, index) => line.startsWith("$ ") ? [index] : []);
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  const command = [lines[start].slice(2).trim(), ...lines.slice(start + 1)];
  if (!command[0] || command.some(line => /(?:…|\.\.\.)(?:\s*\[\+\d+ chars\])?$/.test(line))) return undefined;
  return command.join("\n");
}

export function accountSettingPrompt(prompt: Pick<Prompt, "title">): boolean {
  return prompt.title.replace(/[^a-z0-9]/gi, "").toLowerCase() === "codemodeexperimental";
}

export function oneShotPermissionOption(prompt: Prompt): number | undefined {
  if (accountSettingPrompt(prompt) || prompt.kind !== "permission" || !["screen", "hook"].includes(prompt.source) || !prompt.hash ||
      prompt.multiSelect || prompt.destructive || prompt.options.length < 2 || hasTruncatedEvidence(prompt.detail))
    return undefined;
  const toolEvidence = Boolean(prompt.tool?.name) && prompt.tool!.inputComplete === true && Object.keys(prompt.tool!.input).length > 0 && !hasTruncatedEvidence(prompt.tool!.input);
  const screenEvidence = !prompt.tool && prompt.source === "screen" && prompt.pinned === true && dialogCommand(prompt) !== undefined;
  if (!toolEvidence && !screenEvidence) return undefined;

  const accepted = prompt.options.filter(option => option.role === "accept" &&
    /^(?:yes|yes,\s*(?:proceed|continue|run|make|create|allow|approve)(?:\s+(?:once|this time))?|(?:proceed|continue|run|make|create|allow|approve)(?:\s+(?:once|this time))?)\b/i.test(option.label.trim()) &&
    !/always|trust|workspace|project|folder|remember|future|session/i.test(option.label));
  const rejected = prompt.options.some(option => option.role === "reject" || option.role === "reject-with-feedback");
  return accepted.length === 1 && rejected ? accepted[0].index : undefined;
}

export function hasTruncatedEvidence(value: unknown): boolean {
  if (typeof value === "string") return /(?:…|\.\.\.)\s*\[\+\d+ chars\]$/.test(value) || value === "[truncated]";
  if (Array.isArray(value)) {
    return (value.length === MAX_ARRAY_ITEMS + 1 && isTruncatedArrayMarker(value[MAX_ARRAY_ITEMS])) ||
      value.some(hasTruncatedEvidence);
  }
  if (value && typeof value === "object") return Object.values(value).some(hasTruncatedEvidence);
  return false;
}
