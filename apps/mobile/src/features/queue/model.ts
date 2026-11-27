import type { Prompt } from "@infinite/attention";

export type QueueRecommendation = { answers: string[]; reason: string; outcome?: "matched" | "different" | "other" };
export type QueueOrigin = { id: string; title: string; projectId?: string; team?: { id: string; title: string; role: string } };
export type QueueDecisionRecord = {
  id: string;
  question: string;
  options: string[];
  answerMode?: "approval" | "single" | "multiple";
  createdAt: string;
  recommendation?: QueueRecommendation;
};
export type QueueDecision =
  | { kind: "session"; key: string; since: string; origin: QueueOrigin; answerPath: string; prompt: Prompt; terminalOnly?: true }
  | { kind: "team"; key: string; since: string; origin: QueueOrigin; answerPath: string; revision: number; decision: QueueDecisionRecord; held?: true }
  | { kind: "mission"; key: string; since: string; origin: QueueOrigin; answerPath: string; revision: number; decision: QueueDecisionRecord };
export type DecisionQueue = { decisions: QueueDecision[] };

export const QUEUE_SCREEN_POLL_MS = 2000;
export const QUEUE_SESSION_POLL_MS = 2000;
export const QUEUE_ME_POLL_MS = 30000;
export const SWAP_GUARD_MS = 400;
export const QUEUE_COUNT_POLL_MS = 10000;
export const ANSWERED_RESTORE_READ = 5;

export type QueueState = { decisions: QueueDecision[]; activeKey?: string; selected: string[]; activeLeft: boolean };

export function createQueueState(decisions: readonly QueueDecision[] = []): QueueState {
  return { decisions: [...decisions], activeKey: decisions[0]?.key, selected: [], activeLeft: false };
}

function selectionShape(decision: QueueDecision | undefined): string {
  if (!decision) return "";
  if (decision.kind === "session") return JSON.stringify([decision.prompt.id, decision.terminalOnly, decision.prompt.options.map(option => [option.index, option.label, option.role])]);
  return JSON.stringify([decision.revision, decision.decision.answerMode, decision.decision.options, decision.decision.recommendation?.answers]);
}

export function reconcileQueue(state: QueueState, decisions: readonly QueueDecision[]): QueueState {
  const next = [...decisions];
  const previousIndex = Math.max(0, state.decisions.findIndex(decision => decision.key === state.activeKey));
  const current = next.find(decision => decision.key === state.activeKey);
  const active = current ?? next[Math.min(previousIndex, next.length - 1)];
  const moved = Boolean(state.activeKey && !current);
  const previous = state.decisions.find(decision => decision.key === state.activeKey);
  const reset = moved || selectionShape(previous) !== selectionShape(current);
  return { decisions: next, activeKey: active?.key, selected: reset ? [] : state.selected,
    activeLeft: moved || (state.activeLeft && state.activeKey === active?.key) };
}

export function moveQueue(state: QueueState, offset: -1 | 1): QueueState {
  if (!state.decisions.length) return state;
  const index = state.decisions.findIndex(decision => decision.key === state.activeKey);
  const nextIndex = Math.max(0, Math.min(state.decisions.length - 1, (index < 0 ? 0 : index) + offset));
  if (nextIndex === index) return { ...state, activeLeft: false };
  return { ...state, activeKey: state.decisions[nextIndex].key, selected: [], activeLeft: false };
}

export function removeAnswered(state: QueueState, key: string): QueueState {
  const index = state.decisions.findIndex(decision => decision.key === key);
  if (index < 0) return state;
  const decisions = state.decisions.filter(decision => decision.key !== key);
  if (key !== state.activeKey) return { ...state, decisions };
  return { ...state, decisions, activeKey: decisions[Math.min(index, decisions.length - 1)]?.key, selected: [], activeLeft: false };
}

export function toggleChoice(state: QueueState, value: string): QueueState {
  const selected = state.selected.includes(value) ? state.selected.filter(answer => answer !== value) : [...state.selected, value];
  return { ...state, selected, activeLeft: false };
}

export function settleAnsweredKeys(hidden: ReadonlyMap<string, number>, read: number, listed: ReadonlySet<string>): Map<string, number> {
  const next = new Map<string, number>();
  for (const [key, firstRead] of hidden) {
    if (read < firstRead || (listed.has(key) && read < firstRead + ANSWERED_RESTORE_READ - 1)) next.set(key, firstRead);
  }
  return next;
}

export function visibleDecisions(queue: DecisionQueue, hidden: ReadonlyMap<string, number>): QueueDecision[] {
  return queue.decisions.filter(decision => !hidden.has(decision.key));
}

export function orderedChoices(record: Pick<QueueDecisionRecord, "options" | "answerMode" | "recommendation">): string[] {
  const { options, answerMode, recommendation } = record;
  const first = answerMode === "approval" && options.length > 0 ? [] : [...new Set(recommendation?.answers ?? [])];
  return [...first, ...options.filter(option => !first.includes(option))];
}

export function formatAnswer(answers: readonly string[], answerMode?: QueueDecisionRecord["answerMode"]): string {
  if (answerMode !== "multiple") return answers[0] ?? "";
  return answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n");
}

export type AnswerGate =
  | { kind: "answer" }
  | { kind: "blocked"; note: string; terminal: boolean };

export function answerGate(input: {
  decision: QueueDecision;
  role: "owner" | "controller" | "viewer" | undefined;
  promptAnswers: boolean;
  online: boolean;
}): AnswerGate {
  const { decision, role, promptAnswers, online } = input;
  if (decision.kind === "session" && decision.terminalOnly) return { kind: "blocked", terminal: true, note: "Only this session's terminal can answer this prompt." };
  if (role === "viewer") return { kind: "blocked", terminal: false, note: "This device key can view but not steer." };
  if (decision.kind === "mission" && role !== "owner") return { kind: "blocked", terminal: false, note: "Only the owner can answer mission decisions." };
  if (decision.kind === "session" && !promptAnswers) return { kind: "blocked", terminal: false, note: "This host takes no prompt answers from the phone." };
  if (!online) return { kind: "blocked", terminal: false, note: "Offline. Answers stay off until the queue refreshes." };
  return { kind: "answer" };
}

export function queueEntryLabel(count: number | undefined): string {
  if (count === undefined) return "Decisions";
  return count === 0 ? "Decisions · none waiting" : `Decisions · ${count} waiting`;
}

export function kindLabel(decision: QueueDecision): string {
  if (decision.kind === "session") return decision.origin.team ? "Member approval" : "Session prompt";
  return decision.kind === "team" ? "Team decision" : "Mission decision";
}

export const queueRequestKey = (machine: string, key: string) => `queue/${machine}/${key}`;
export const apiPath = (answerPath: string) => answerPath.startsWith("/api/") ? answerPath.slice(4) : answerPath;

export type QueueAnswerSend = { path: string; label: string; revision: number; fields: { text: string } };

export function answerSend(decision: Exclude<QueueDecision, { kind: "session" }>, text: string): QueueAnswerSend | undefined {
  const trimmed = text.trim();
  return trimmed ? { path: apiPath(decision.answerPath), label: "Answer", revision: decision.revision, fields: { text: trimmed } } : undefined;
}

export function decisionForPath(decisions: readonly QueueDecision[], path: string): QueueDecision | undefined {
  return decisions.find(decision => apiPath(decision.answerPath) === path);
}

export function hideCompleted(
  hidden: ReadonlyMap<string, number>,
  read: number,
  listed: readonly string[],
  completed: (key: string) => boolean,
): Map<string, number> {
  const next = settleAnsweredKeys(hidden, read, new Set(listed));
  for (const key of listed) if (!next.has(key) && completed(key)) next.set(key, read);
  return next;
}

export type ControlStep = { kind: "none" } | { kind: "take"; takeover: boolean } | { kind: "ready" };

export function controlStep(input: { requiresControl: boolean; hasLease: boolean; holderLabel?: string }): ControlStep {
  if (!input.requiresControl) return { kind: "none" };
  if (input.hasLease) return { kind: "ready" };
  return { kind: "take", takeover: input.holderLabel !== undefined };
}
