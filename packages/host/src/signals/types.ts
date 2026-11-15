/**
 * Project signals: host-recorded events that may wake standing work.
 *
 * A signal is a fact the host observed (a receipt) or an item the owner authored. No source starts an
 * agent directly: a source records a signal, and a consumer (a standing goal, a routine) reads the
 * inbox on its own scheduler pass and decides inside its own gates. Text from anyone but the owner
 * never enters a signal.
 */
export const signalKinds = ["revert", "external-commit", "delivery-landed", "owner"] as const;
/**
 * - `revert`: a landed agent change was reverted on the base branch (outcome ledger receipt).
 * - `external-commit`: the base branch gained a commit that no team run of this project delivered.
 * - `delivery-landed`: a team run's delivered change was seen on the base branch.
 * - `owner`: an item the owner added through an owner-only route.
 */
export type SignalKind = (typeof signalKinds)[number];

export interface ProjectSignal {
  /** Host-wide order of recording, starting at 1. A consumer keeps the last seq it handled. */
  seq: number;
  id: string;
  /** Host project ID. */
  projectId: string;
  kind: SignalKind;
  /** The source's own identifier. One (projectId, kind, key) is recorded once; a repeat is dropped. */
  key: string;
  /** When the host recorded the signal. */
  at: string;
  /** The team run whose work caused the event, when the host knows it. A consumer ignores its own runs. */
  runId?: string;
  /** The commit the event is about, for the commit kinds. */
  commit?: string;
  /** Owner-authored text. Present only for kind `owner`. */
  text?: string;
}

/** What a consumer needs from the inbox. Both calls are synchronous reads and never throw. */
export interface SignalReader {
  /** The highest seq recorded so far, 0 when none. `undefined` when the inbox cannot be read. */
  head(): number | undefined;
  /**
   * Signals of one project recorded after `seq`, oldest first, at most `limit` (default 50, maximum 200).
   * Empty when the inbox cannot be read, so a consumer keeps its cursor and reads again later.
   */
  after(projectId: string, seq: number, options?: { kinds?: readonly SignalKind[]; limit?: number }): ProjectSignal[];
}

/** A consumer's bounded record of the signals waiting to start its next run. */
export interface PendingWake {
  /** Newest last, at most 20. Older entries are dropped and counted in `dropped`. */
  signals: { id: string; kind: SignalKind; key: string; at: string; commit?: string; text?: string }[];
  dropped: number;
  /** When the first signal of this batch was read. */
  since: string;
  /** The owner sent direction while the consumer was between runs. */
  owner?: boolean;
}

export const maxPendingWakeSignals = 20;

/** Folds newly read signals into a pending wake, keeping the newest `maxPendingWakeSignals`. */
export function addToPendingWake(pending: PendingWake | undefined, signals: readonly ProjectSignal[], now: string): PendingWake | undefined {
  if (!signals.length) return pending;
  const next: PendingWake = pending ? { ...pending, signals: [...pending.signals] } : { signals: [], dropped: 0, since: now };
  for (const signal of signals) {
    if (next.signals.some(value => value.id === signal.id)) continue;
    next.signals.push({ id: signal.id, kind: signal.kind, key: signal.key, at: signal.at, ...(signal.commit ? { commit: signal.commit } : {}), ...(signal.text ? { text: signal.text } : {}) });
  }
  const overflow = next.signals.length - maxPendingWakeSignals;
  if (overflow > 0) { next.signals.splice(0, overflow); next.dropped += overflow; }
  return next;
}
