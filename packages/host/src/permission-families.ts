const PROVIDER_FAMILY: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "gpt",
  grok: "grok",
};

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

export function familyFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const segments = model.split("/").filter(Boolean);
  const last = (segments.at(-1) ?? "").replace(/@.*$/, "");
  for (const candidate of [last, ...segments.slice(0, -1).reverse()]) {
    const match = MODEL_FAMILIES.find(([, pattern]) => pattern.test(candidate));
    if (match) return match[0];
  }
  return undefined;
}

export function familyOf(profile: { provider: string; model?: string }): string | undefined {
  const fromProvider = PROVIDER_FAMILY[profile.provider];
  const fromModel = familyFromModel(profile.model);
  if (fromProvider) return fromModel === undefined || fromModel === fromProvider ? fromProvider : undefined;
  if (profile.provider === "opencode") return fromModel;
  return undefined;
}
