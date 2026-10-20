import type { Prompt } from "./types.js";

/** The title of the Codex dialog that asks to run one command, typically outside its sandbox. */
const CODEX_COMMAND_TITLE = /^would you like to run the following command\?$/i;

/**
 * The command a Codex command dialog shows: its `$ ` line through the end of the detail, one
 * screen line per line. Undefined when the dialog shows no command, cuts one short, or shows
 * more than one `$ ` line: a second one could be transcript text above the dialog or a line the
 * agent wrote into its reason, so the screen cannot say which line is the command. A block that
 * kept its exact title also kept every line between that title and the options.
 */
export function dialogCommand(prompt: Pick<Prompt, "title" | "detail">): string | undefined {
  if (!CODEX_COMMAND_TITLE.test(prompt.title.trim())) return undefined;
  // Trim only the line ends: spacing inside a quoted argument is part of the command.
  const lines = (prompt.detail ?? "").split("\n").map(line => line.trim()).filter(Boolean);
  const starts = lines.flatMap((line, index) => line.startsWith("$ ") ? [index] : []);
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  const command = [lines[start].slice(2).trim(), ...lines.slice(start + 1)];
  if (!command[0] || command.some(line => /(?:…|\.\.\.)$/.test(line))) return undefined;
  return command.join("\n");
}

/**
 * The exact one-shot option a delegated coordinator may recommend for this prompt, or undefined
 * when the prompt stays with its owner. Evidence must be complete: hook tool input that storage
 * did not truncate, or a Codex command dialog pinned to the bottom of the screen that shows its
 * whole command. Agent output scrolls above the provider's own input area, so it is never pinned.
 */
export function oneShotPermissionOption(prompt: Prompt): number | undefined {
  if (prompt.kind !== "permission" || !["screen", "hook"].includes(prompt.source) || !prompt.hash ||
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

function hasTruncatedEvidence(value: unknown): boolean {
  if (typeof value === "string") return /(?:…|\.\.\.)\s*\[\+\d+ chars\]$/.test(value) || value === "[truncated]";
  // The shared attention payload caps arrays at 50 items without annotating the
  // truncation. Treat a full capped array as incomplete evidence.
  if (Array.isArray(value)) return value.length >= 50 || value.some(hasTruncatedEvidence);
  if (value && typeof value === "object") return Object.values(value).some(hasTruncatedEvidence);
  return false;
}
