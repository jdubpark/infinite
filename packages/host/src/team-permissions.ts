import { createHash } from "node:crypto";
import type { Prompt } from "@infinite/attention";
import type { WorkerError } from "./ipc.js";
import { ContentError } from "./session-content.js";

export { oneShotPermissionOption } from "@infinite/attention";

const COLLAPSED_LINES = /^\[?\s*(?:…|\.\.\.)\s*\+?\d+\s+lines?\s*\]?$/i;
const CODEX_COMMAND_PROMPT = /^would you like to run the following command\?$/i;
const VIEW_ALL = /^(?:press\s+)?(?:\^a|ctrl(?:\+|-)?a|control(?:\+|-)?a|⌃a)(?:\s+to)?\s+view all$/i;
const COLLAPSED_AND_VIEW_ALL = /^\[?\s*(?:…|\.\.\.)\s*\+?\d+\s+lines?\s*\]?(?:\s*[|·—-]\s*|\s+)(?:press\s+)?(?:\^a|ctrl(?:\+|-)?a|control(?:\+|-)?a|⌃a)(?:\s+to)?\s+view all$/i;
const TRUST_LANGUAGE = /always|trust|workspace|project|session|folder|remember|future/i;

/**
 * A Codex command dialog whose command is still collapsed on the pinned screen.
 * This predicate only admits the narrow display-expansion case; it does not
 * authorize a prompt or establish what the hidden command will do.
 */
export function isCollapsedPermissionPrompt(prompt: Prompt): boolean {
  if (!["permission", "menu"].includes(prompt.kind) || !["screen", "hook"].includes(prompt.source) ||
      !/^[a-f0-9]{64}$/i.test(prompt.hash ?? "") || prompt.pinned !== true || prompt.multiSelect || prompt.acceptsText !== true ||
      prompt.options.length !== 2 || prompt.options.some(option => TRUST_LANGUAGE.test(option.label)))
    return false;

  const accepts = prompt.options.filter(option => option.role === "accept" &&
    /^yes,\s*proceed(?:\s+once)?(?:\s*\(y\))?$/i.test(option.label.trim()));
  const feedback = prompt.options.filter(option => option.role === "reject-with-feedback");
  if (accepts.length !== 1 || feedback.length !== 1 ||
      prompt.options.some(option => option.role !== "accept" && option.role !== "reject-with-feedback"))
    return false;

  const detail = (prompt.detail ?? "").split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const title = prompt.title.replace(/\s+/g, " ").trim();
  const collapsedDetail = COLLAPSED_AND_VIEW_ALL.test(detail.at(-1) ?? "") ||
    detail.length >= 2 && COLLAPSED_LINES.test(detail.at(-2)!) && VIEW_ALL.test(detail.at(-1)!);
  const reasonTitle = /^reason:\s*\S/i.test(title);
  if (!COLLAPSED_AND_VIEW_ALL.test(title) && !COLLAPSED_LINES.test(title) && !VIEW_ALL.test(title) &&
      !CODEX_COMMAND_PROMPT.test(title) && !(reasonTitle && collapsedDetail)) return false;
  const layouts = [[...detail, title], [title, ...detail]];
  return layouts.some(lines => lines.some((line, index) =>
    ((index === lines.length - 1 || index + 2 === lines.length) && COLLAPSED_AND_VIEW_ALL.test(line)) ||
    (index + 2 === lines.length && COLLAPSED_LINES.test(line) && VIEW_ALL.test(lines[index + 1]))));
}

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
