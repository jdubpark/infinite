import { createHash } from "node:crypto";
import type { Prompt } from "@infinite/attention";

/** Hash every prompt field that can change what a one-shot answer means. */
export function permissionEvidenceHash(prompt: Prompt): string {
  const evidence = {
    id: prompt.id,
    hash: prompt.hash ?? null,
    source: prompt.source,
    kind: prompt.kind,
    title: prompt.title,
    detail: prompt.detail ?? null,
    options: prompt.options.map(option => ({ index: option.index, label: option.label, role: option.role })),
    acceptsText: prompt.acceptsText,
    multiSelect: prompt.multiSelect ?? false,
    destructive: prompt.destructive ?? null,
    tool: prompt.tool ? { name: prompt.tool.name, input: prompt.tool.input, inputComplete: prompt.tool.inputComplete ?? false } : null,
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/** Return the exact one-shot permission option index, or leave the prompt to its owner. */
export function oneShotPermissionOption(prompt: Prompt): number | undefined {
  if (prompt.kind !== "permission" || !["screen", "hook"].includes(prompt.source) || !prompt.hash ||
      prompt.multiSelect || prompt.destructive || prompt.options.length < 2 ||
      !prompt.tool?.name || prompt.tool.inputComplete !== true || !Object.keys(prompt.tool.input).length || hasTruncatedEvidence(prompt.detail) || hasTruncatedEvidence(prompt.tool.input))
    return undefined;

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
