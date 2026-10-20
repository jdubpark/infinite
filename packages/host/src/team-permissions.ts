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

/** Worker refusal codes. A delegated answer refused with one of these wrote no key. */
const ANSWER_REFUSALS = new Set(["prompt-changed", "unsupported", "invalid-option", "text-not-accepted", "control-busy", "control-lost"]);

/**
 * Whether a delegated answer failed before its first key: a manager preflight refusal or a named
 * worker refusal. A transport error can follow a delivered key, so it never qualifies.
 */
export function refusedBeforeSend(error: unknown): boolean {
  return error instanceof ContentError || ANSWER_REFUSALS.has((error as WorkerError | undefined)?.code ?? "");
}
