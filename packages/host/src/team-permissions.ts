import { createHash } from "node:crypto";
import { accountSettingPrompt, dialogCommand, hasTruncatedEvidence, oneShotPermissionOption, type Prompt } from "@infinite/attention";
import type { WorkerError } from "./ipc.js";
import type { PermissionRequestShape } from "./permission-agent-types.js";
import { ContentError } from "./session-content.js";

export { oneShotPermissionOption } from "@infinite/attention";

const PERSISTENT_LABEL = /always|trust|workspace|project|folder|remember|future|session|don't ask|do not ask|never ask/i;

export function agentAcceptOption(prompt: Prompt): number | undefined {
  return oneShotPermissionOption({ ...prompt, destructive: undefined });
}

export function oneShotRejectOption(prompt: Prompt): number | undefined {
  if (accountSettingPrompt(prompt) || prompt.kind !== "permission" || !["screen", "hook"].includes(prompt.source) || !prompt.hash || prompt.multiSelect ||
      prompt.options.length < 2) return undefined;
  const rejects = prompt.options.filter(option => (option.role === "reject" || option.role === "reject-with-feedback") &&
    !PERSISTENT_LABEL.test(option.label));
  return rejects.length === 1 ? rejects[0].index : undefined;
}

const TRUST_TITLE = /\btrust\b.*\b(?:folder|files|workspace|project|directory)\b|\b(?:folder|files|workspace|project|directory)\b.*\btrust\b/i;

export function permissionRequestShape(prompt: Prompt): PermissionRequestShape {
  const accountSetting = accountSettingPrompt(prompt);
  const accept = agentAcceptOption(prompt);
  const oneShotAccept = !accountSetting && prompt.options.filter(option => option.role === "accept" && !PERSISTENT_LABEL.test(option.label)).length === 1;
  const persistent = prompt.options.some(option => option.role === "accept-always" || option.role === "accept" && PERSISTENT_LABEL.test(option.label));
  const trustPrompt = TRUST_TITLE.test(prompt.title) || prompt.options.some(option => /\btrust\b/i.test(option.label));
  return {
    completeEvidence: accept !== undefined || completeDialogEvidence(prompt),
    oneShotAccept: !accountSetting && !trustPrompt && oneShotAccept,
    oneShotReject: !accountSetting && oneShotRejectOption(prompt) !== undefined,
    persistentOnly: accountSetting || !oneShotAccept && persistent,
    trustPrompt,
  };
}

function completeDialogEvidence(prompt: Prompt): boolean {
  if (prompt.kind !== "permission" || !prompt.hash || hasTruncatedEvidence(prompt.detail)) return false;
  if (prompt.tool) return Boolean(prompt.tool.name) && prompt.tool.inputComplete === true &&
    Object.keys(prompt.tool.input).length > 0 && !hasTruncatedEvidence(prompt.tool.input);
  return prompt.source === "screen" && prompt.pinned === true && dialogCommand(prompt) !== undefined;
}

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

export function permissionAuthorityHash(permissions: unknown, ownerDirection: string[]): string {
  return createHash("sha256").update(JSON.stringify({ permissions: permissions ?? null, ownerDirection })).digest("hex");
}

const ANSWER_REFUSALS = new Set(["prompt-changed", "unsupported", "invalid-option", "text-not-accepted", "control-busy", "control-lost"]);

export function refusedBeforeSend(error: unknown): boolean {
  return error instanceof ContentError || ANSWER_REFUSALS.has((error as WorkerError | undefined)?.code ?? "");
}

export function selectPermissionRecoveryHistory<T extends { cause: string; action: string; decision: string; consequence: string; at: string }>(
  run: { id: string; projectId: string; reason?: string; recovery?: { source: { reason: string } }; permissionRecovery?: { steps: { action: string; cause: string }[] } },
  records: Iterable<{ run: { id: string; projectId: string; permissionRecovery?: { outcomes: (T & { requestId: string })[] } } }>,
  bound: (value: string) => string,
): T[] {
  const steps = (run.permissionRecovery?.steps ?? []).slice(-10);
  const relevantActions = new Set(steps.map(step => step.action.toLowerCase()));
  const stopWords = new Set(["about", "after", "before", "could", "from", "into", "needs", "permission", "prompt", "request", "same", "that", "this", "with"]);
  const tokens = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? []).filter(word => !stopWords.has(word)));
  const causes = [run.reason, run.recovery?.source.reason, ...steps.map(step => step.cause)].filter((value): value is string => Boolean(value));
  const currentTokens = new Set(causes.flatMap(cause => [...tokens(cause)]));
  if (!relevantActions.size && !currentTokens.size) return [];
  return [...records].filter(item => item.run.id !== run.id && item.run.projectId === run.projectId)
    .flatMap(item => (item.run.permissionRecovery?.outcomes ?? []).map(({ requestId: _requestId, ...outcome }) => outcome as unknown as T))
    .filter(outcome => relevantActions.has(outcome.action.toLowerCase()) || [...tokens(outcome.cause)].filter(token => currentTokens.has(token)).length >= 3)
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5).map(outcome => ({
      ...outcome, cause: bound(outcome.cause), action: bound(outcome.action),
      decision: bound(outcome.decision), consequence: bound(outcome.consequence),
    }));
}
