/**
 * Model families for the permission agent. A family is the model vendor. The strong tier must come from
 * a family other than the requester's, so an unknown family is never guessed: it is undefined.
 */

/** Providers whose CLI runs the models of one vendor. OpenCode runs many vendors, so its model id decides. */
const PROVIDER_FAMILY: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "gpt",
  grok: "grok",
};

/**
 * Model id patterns for each family, tested against the model part of an id (the text after the last
 * `/`, with a `@version` suffix removed) and against the whole id. Kept in one place so a new vendor is
 * one line.
 */
const MODEL_FAMILIES: ReadonlyArray<readonly [family: string, pattern: RegExp]> = [
  ["claude", /^(?:claude|anthropic)\b|^(?:opus|sonnet|haiku|fable|mythos)(?:\b|$)/i],
  ["gpt", /^(?:gpt|chatgpt|codex|o[1-9])(?:\b|-|$)|^openai\b/i],
  ["deepseek", /^deepseek\b/i],
  ["muse", /^muse\b/i],
  ["grok", /^(?:grok|xai)\b/i],
  ["gemini", /^(?:gemini|gemma)\b/i],
  ["qwen", /^(?:qwen|qwq)\b/i],
  ["llama", /^llama\b/i],
  ["mistral", /^(?:mistral|codestral|devstral|magistral|ministral|pixtral)\b/i],
  ["kimi", /^(?:kimi|moonshot)\b/i],
  ["glm", /^(?:glm|zai|z-ai)\b/i],
  ["minimax", /^minimax\b/i],
];

/** The family a model id names, or undefined when no pattern matches. */
export function familyFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const segments = model.split("/").filter(Boolean);
  const last = (segments.at(-1) ?? "").replace(/@.*$/, "");
  // Test the model part first, then each earlier segment, so "openrouter/anthropic/claude-x" is Claude.
  for (const candidate of [last, ...segments.slice(0, -1).reverse()]) {
    const match = MODEL_FAMILIES.find(([, pattern]) => pattern.test(candidate));
    if (match) return match[0];
  }
  return undefined;
}

/**
 * A profile's family. A single-vendor provider gives its vendor unless the model id names another
 * vendor; then the host cannot tell and the family is undefined. A multi-vendor provider gives the family
 * its model id names, and undefined without one.
 */
export function familyOf(profile: { provider: string; model?: string }): string | undefined {
  const fromProvider = PROVIDER_FAMILY[profile.provider];
  const fromModel = familyFromModel(profile.model);
  if (fromProvider) return fromModel === undefined || fromModel === fromProvider ? fromProvider : undefined;
  if (profile.provider === "opencode") return fromModel;
  return undefined;
}
