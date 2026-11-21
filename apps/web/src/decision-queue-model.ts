import type { QueueDecision } from "./api";

export type DecisionQueueState = {
  decisions: QueueDecision[];
  activeKey?: string;
  selectedAnswers: string[];
  answeredElsewhere: boolean;
};

export type QueueSelectableOption = { value: string; sessionIndex?: number; role?: string };

export function createDecisionQueueState(decisions: readonly QueueDecision[] = []): DecisionQueueState {
  return { decisions: [...decisions], activeKey: decisions[0]?.key, selectedAnswers: [], answeredElsewhere: false };
}

function selectionShape(decision: QueueDecision | undefined): string {
  if (!decision) return "";
  if (decision.kind === "session") return JSON.stringify([decision.prompt.id, decision.terminalOnly, decision.prompt.options.map(option => [option.index, option.label, option.role])]);
  return JSON.stringify([decision.revision, decision.decision.answerMode, decision.decision.options,
    decision.decision.recommendation?.answers]);
}

export function reconcileDecisionQueue(state: DecisionQueueState, decisions: readonly QueueDecision[]): DecisionQueueState {
  const next = [...decisions];
  const previousIndex = Math.max(0, state.decisions.findIndex(decision => decision.key === state.activeKey));
  const current = next.find(decision => decision.key === state.activeKey);
  const active = current ?? next[Math.min(previousIndex, next.length - 1)];
  const moved = Boolean(state.activeKey && !current);
  const previous = state.decisions.find(decision => decision.key === state.activeKey);
  const reset = moved || selectionShape(previous) !== selectionShape(current);
  return { decisions: next, activeKey: active?.key, selectedAnswers: reset ? [] : state.selectedAnswers,
    answeredElsewhere: moved || (state.answeredElsewhere && state.activeKey === active?.key) };
}

export function moveDecisionQueue(state: DecisionQueueState, offset: -1 | 1): DecisionQueueState {
  if (!state.decisions.length) return state;
  const index = state.decisions.findIndex(decision => decision.key === state.activeKey);
  const nextIndex = Math.max(0, Math.min(state.decisions.length - 1, (index < 0 ? 0 : index) + offset));
  if (nextIndex === index) return { ...state, answeredElsewhere: false };
  return { ...state, activeKey: state.decisions[nextIndex].key, selectedAnswers: [], answeredElsewhere: false };
}

export function removeAnsweredDecision(state: DecisionQueueState, key: string): DecisionQueueState {
  const index = state.decisions.findIndex(decision => decision.key === key);
  if (index < 0) return state;
  const decisions = state.decisions.filter(decision => decision.key !== key);
  if (key !== state.activeKey) return { ...state, decisions };
  return { ...state, decisions, activeKey: decisions[Math.min(index, decisions.length - 1)]?.key,
    selectedAnswers: [], answeredElsewhere: false };
}

export function selectDecisionAnswers(state: DecisionQueueState, answers: readonly string[]): DecisionQueueState {
  return { ...state, selectedAnswers: [...answers], answeredElsewhere: false };
}

export function selectableOptions(decision: QueueDecision | undefined): QueueSelectableOption[] {
  if (!decision) return [];
  if (decision.kind === "session") return decision.prompt.options.map(option => ({ value: String(option.index), sessionIndex: option.index, role: option.role }));
  const recommended = [...new Set(decision.decision.recommendation?.answers ?? [])];
  const values = [...recommended, ...decision.decision.options.filter(option => !recommended.includes(option))];
  return values.map(value => ({ value }));
}

export function recommendationAnswers(decision: QueueDecision | undefined): string[] {
  return decision && decision.kind !== "session" ? [...new Set(decision.decision.recommendation?.answers ?? [])] : [];
}

export type QueueKeyInput = {
  key: string;
  targetTagName?: string;
  targetIsContentEditable?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};
export type QueueKeyContext = {
  options: readonly QueueSelectableOption[];
  recommendedAnswers?: readonly string[];
  canAnswer: boolean;
  terminalOnly?: boolean;
  destructive?: boolean;
  multiple?: boolean;
};
export type QueueKeyResult = { state: DecisionQueueState; handled: boolean; submit?: { key: string; answers: string[] } };

function noAction(state: DecisionQueueState): QueueKeyResult { return { state, handled: false }; }

export function applyDecisionQueueKey(state: DecisionQueueState, input: QueueKeyInput, context: QueueKeyContext): QueueKeyResult {
  if (input.altKey || input.ctrlKey || input.metaKey || input.shiftKey || input.targetIsContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(input.targetTagName?.toUpperCase() ?? "")) return noAction(state);
  if (input.key === "Enter" && ["BUTTON", "A"].includes(input.targetTagName?.toUpperCase() ?? "")) return noAction(state);
  if (["j", "ArrowDown", "s"].includes(input.key)) return { state: moveDecisionQueue(state, 1), handled: true };
  if (["k", "ArrowUp"].includes(input.key)) return { state: moveDecisionQueue(state, -1), handled: true };
  if (context.terminalOnly || !context.canAnswer) return noAction(state);
  if (/^[1-9]$/.test(input.key)) {
    const option = context.options[Number(input.key) - 1];
    if (!option) return noAction(state);
    if (context.destructive && (option.role === "accept" || option.role === "accept-always")) return { state, handled: true };
    const selectedAnswers = context.multiple
      ? state.selectedAnswers.includes(option.value) ? state.selectedAnswers.filter(answer => answer !== option.value) : [...state.selectedAnswers, option.value]
      : [option.value];
    return { state: selectDecisionAnswers(state, selectedAnswers), handled: true };
  }
  if (input.key === "r") {
    const answers = (context.recommendedAnswers ?? []).filter(answer => context.options.some(option => option.value === answer));
    if (!answers.length) return noAction(state);
    return { state: selectDecisionAnswers(state, context.multiple ? answers : answers.slice(0, 1)), handled: true };
  }
  if (input.key === "Enter" && state.activeKey && state.selectedAnswers.length) {
    return { state, handled: true, submit: { key: state.activeKey, answers: [...state.selectedAnswers] } };
  }
  return noAction(state);
}

export function formatWaitDuration(since: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const [amount, unit] = seconds < 60 ? [seconds, "second"] : seconds < 3600 ? [Math.floor(seconds / 60), "minute"] :
    seconds < 86400 ? [Math.floor(seconds / 3600), "hour"] : [Math.floor(seconds / 86400), "day"];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}
