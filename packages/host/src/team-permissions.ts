import { createHash } from "node:crypto";
import { dialogCommand, oneShotPermissionOption, type Prompt } from "@infinite/attention";
import type { WorkerError } from "./ipc.js";
import type { PermissionRequestShape } from "./permission-agent-types.js";
import { ContentError } from "./session-content.js";

export { oneShotPermissionOption } from "@infinite/attention";

/** An option label that would grant more than this one request. */
const PERSISTENT_LABEL = /always|trust|workspace|project|folder|remember|future|session|don't ask|do not ask|never ask/i;

/**
 * The one-shot accept a permission agent may choose for this prompt, or undefined. It is today's
 * qualification with complete evidence, except that the destructive flag does not disqualify: the
 * delivery service delivers an accept for a destructive request only on a strong verdict.
 */
export function agentAcceptOption(prompt: Prompt): number | undefined {
  return oneShotPermissionOption({ ...prompt, destructive: undefined });
}

/**
 * The one-shot reject option of a permission dialog, or undefined when the dialog has none that the
 * host recognises. Exactly one reject option must offer no persistent effect. A reject needs no
 * complete evidence: rejecting what the host cannot read is a valid answer.
 */
export function oneShotRejectOption(prompt: Prompt): number | undefined {
  if (prompt.kind !== "permission" || !["screen", "hook"].includes(prompt.source) || !prompt.hash || prompt.multiSelect ||
      prompt.options.length < 2) return undefined;
  const rejects = prompt.options.filter(option => (option.role === "reject" || option.role === "reject-with-feedback") &&
    !PERSISTENT_LABEL.test(option.label));
  return rejects.length === 1 ? rejects[0].index : undefined;
}

const TRUST_TITLE = /\btrust\b.*\b(?:folder|files|workspace|project|directory)\b|\b(?:folder|files|workspace|project|directory)\b.*\btrust\b/i;

/** Structural facts about a dialog for the permission agent's qualify step and class rules. */
export function permissionRequestShape(prompt: Prompt): PermissionRequestShape {
  const accept = agentAcceptOption(prompt);
  const oneShotAccept = prompt.options.filter(option => option.role === "accept" && !PERSISTENT_LABEL.test(option.label)).length === 1;
  const persistent = prompt.options.some(option => option.role === "accept-always" || option.role === "accept" && PERSISTENT_LABEL.test(option.label));
  const trustPrompt = TRUST_TITLE.test(prompt.title) || prompt.options.some(option => /\btrust\b/i.test(option.label));
  return {
    completeEvidence: accept !== undefined || completeDialogEvidence(prompt),
    oneShotAccept: !trustPrompt && oneShotAccept,
    oneShotReject: oneShotRejectOption(prompt) !== undefined,
    persistentOnly: !oneShotAccept && persistent,
    trustPrompt,
  };
}

/** The host holds the whole action: complete hook tool input, or a pinned command dialog that shows its whole command. */
function completeDialogEvidence(prompt: Prompt): boolean {
  if (prompt.kind !== "permission" || !prompt.hash || truncated(prompt.detail)) return false;
  if (prompt.tool) return Boolean(prompt.tool.name) && prompt.tool.inputComplete === true &&
    Object.keys(prompt.tool.input).length > 0 && !truncated(prompt.tool.input);
  return prompt.source === "screen" && prompt.pinned === true && dialogCommand(prompt) !== undefined;
}

/** The same truncation markers that today's qualification refuses. */
function truncated(value: unknown): boolean {
  if (typeof value === "string") return /(?:…|\.\.\.)\s*\[\+\d+ chars\]$/.test(value) || value === "[truncated]";
  if (Array.isArray(value)) return value.length >= 50 || value.some(truncated);
  if (value && typeof value === "object") return Object.values(value).some(truncated);
  return false;
}

/** The action as the host extracted it, bounded to 2,000 characters: the dialog's command, the hook command, or the title. */
export function permissionAction(prompt: Prompt): string {
  const command = typeof prompt.tool?.input.command === "string" ? prompt.tool.input.command : undefined;
  const text = dialogCommand(prompt) ?? command ?? [prompt.title, prompt.detail].filter(Boolean).join("\n");
  return [...text].slice(0, 2000).join("");
}

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
