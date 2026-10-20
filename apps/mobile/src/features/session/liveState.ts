export const MAX_SIGNAL_EVENTS = 2000;

export type SequencedSignal = { seq: number };
export type ConversationActivity = { attentionState?: unknown; lastActivityAt?: unknown };

export function mergeSignalEvents<T extends SequencedSignal>(previous: readonly T[], incoming: readonly T[]): T[] {
  return [...new Map([...previous, ...incoming].map(event => [event.seq, event])).values()].slice(-MAX_SIGNAL_EVENTS);
}

export function hasExitedLifecycle(events: readonly { type: string; data?: unknown }[]): boolean {
  return events.some(event => event.type === "lifecycle" && (event.data as { status?: unknown } | undefined)?.status === "exited");
}

export function conversationActivity(payload: unknown): ConversationActivity | null {
  if (!payload || typeof payload !== "object") return null;
  const state = (payload as { state?: unknown }).state;
  if (!state || typeof state !== "object") return null;
  const attention = (state as { attention?: unknown }).attention;
  if (!attention || typeof attention !== "object") return null;
  return {
    attentionState: (attention as { state?: unknown }).state,
    lastActivityAt: (attention as { lastActivityAt?: unknown }).lastActivityAt,
  };
}

export function shouldRefreshConversation(previous: ConversationActivity | null, payload: unknown): boolean {
  const update = payload && typeof payload === "object" ? payload as { events?: { events?: unknown } } : {};
  if (Array.isArray(update.events?.events) && update.events.events.length > 0) return true;
  const next = conversationActivity(payload);
  return !!previous && !!next && (previous.attentionState !== next.attentionState || previous.lastActivityAt !== next.lastActivityAt);
}
