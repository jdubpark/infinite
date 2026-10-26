import { createHash } from "node:crypto";
import type { Prompt } from "@infinite/attention";
import type { WorkerError } from "./ipc.js";
import { ContentError } from "./session-content.js";

export { oneShotPermissionOption } from "@infinite/attention";

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

/** Hash the semantic authority for a one-shot request, excluding assignment and prompt identity. */
export function permissionReuseKey(input: {
  policyHash: string;
  prompt: Prompt;
  option: number;
  targetTaskId?: string;
  changedPaths: string[];
  acceptedChecks: unknown;
}): string {
  const { prompt } = input;
  const semantic = {
    policyHash: input.policyHash,
    prompt: {
      kind: prompt.kind,
      title: prompt.title,
      detail: prompt.detail ?? null,
      options: prompt.options.map(option => ({ index: option.index, label: option.label, role: option.role })),
      acceptsText: prompt.acceptsText,
      multiSelect: prompt.multiSelect ?? false,
      destructive: prompt.destructive ?? null,
      tool: prompt.tool ? { name: prompt.tool.name, input: prompt.tool.input, inputComplete: prompt.tool.inputComplete ?? false } : null,
    },
    option: input.option,
    targetTaskId: input.targetTaskId ?? null,
    changedPaths: [...new Set(input.changedPaths)].sort(),
    acceptedChecks: input.acceptedChecks,
  };
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}

/**
 * Hash of the owner authority a permission decision was made under: the pinned policy plus the
 * owner's steering and answers. A later owner answer changes it, so an earlier verdict cannot be
 * reused and an approved decision is rechecked before delivery.
 */
export function permissionAuthorityHash(permissions: unknown, ownerDirection: string[]): string {
  return createHash("sha256").update(JSON.stringify({ permissions: permissions ?? null, ownerDirection })).digest("hex");
}

/** Worker refusal codes. A delegated answer refused with one of these wrote no key. */
const ANSWER_REFUSALS = new Set(["prompt-changed", "unsupported", "invalid-option", "text-not-accepted", "control-busy", "control-lost"]);

/**
 * Whether a delegated answer failed before its first key: a manager preflight refusal or a named
 * worker refusal. A transport error can follow a delivered key, so it never qualifies.
 */
export function refusedBeforeSend(error: unknown): boolean {
  return error instanceof ContentError || ANSWER_REFUSALS.has((error as WorkerError | undefined)?.code ?? "");
}
