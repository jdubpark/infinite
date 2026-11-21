import type { Prompt } from "./types.js";

/**
 * True when the host's answer route cannot deliver an answer to this prompt, so a person answers it in the session's
 * terminal: the prompt has no verified screen block (a hook that arrived without its dialog), offers no option, or is
 * a multi-select dialog. A cmux protocol prompt that takes text is answered with text instead.
 */
export function terminalOnlyPrompt(prompt: Pick<Prompt, "hash" | "options" | "multiSelect" | "source" | "acceptsText">, backend?: "infinite" | "cmux"): boolean {
  if (backend === "cmux" && prompt.source === "protocol" && prompt.acceptsText && Boolean(prompt.hash)) return false;
  return prompt.multiSelect === true || !prompt.hash || prompt.options.length === 0;
}
