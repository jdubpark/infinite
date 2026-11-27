import type { Prompt } from "./types.js";

export function terminalOnlyPrompt(prompt: Pick<Prompt, "hash" | "options" | "multiSelect" | "source" | "acceptsText">, backend?: "infinite" | "cmux"): boolean {
  if (backend === "cmux" && prompt.source === "protocol" && prompt.acceptsText && Boolean(prompt.hash)) return false;
  return prompt.multiSelect === true || !prompt.hash || prompt.options.length === 0;
}
