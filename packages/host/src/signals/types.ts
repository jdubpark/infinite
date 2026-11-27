export const signalKinds = ["revert", "external-commit", "delivery-landed", "owner"] as const;
export type SignalKind = (typeof signalKinds)[number];
export type CommitSignalKind = Exclude<SignalKind, "owner">;

interface ProjectSignalBase {
  seq: number;
  id: string;
  projectId: string;
  key: string;
  at: string;
}

export type ProjectSignal =
  | (ProjectSignalBase & { kind: "owner"; text: string; commit?: never; runId?: never })
  | (ProjectSignalBase & { kind: CommitSignalKind; commit?: string; runId?: string; text?: never });

export interface SignalReader {
  head(): number | undefined;
  after(projectId: string, seq: number, options?: { kinds?: readonly SignalKind[]; limit?: number }): ProjectSignal[];
}

export type PendingWakeSignal =
  | { id: string; kind: "owner"; key: string; at: string; text: string; commit?: never }
  | { id: string; kind: CommitSignalKind; key: string; at: string; commit?: string; text?: never };

export interface PendingWake {
  signals: PendingWakeSignal[];
  dropped: number;
  since: string;
  owner?: boolean;
}

export const maxPendingWakeSignals = 20;

export function addToPendingWake(pending: PendingWake | undefined, signals: readonly ProjectSignal[], now: string): PendingWake | undefined {
  if (!signals.length) return pending;
  const next: PendingWake = pending ? { ...pending, signals: [...pending.signals] } : { signals: [], dropped: 0, since: now };
  for (const signal of signals) {
    if (next.signals.some(value => value.id === signal.id)) continue;
    if (signal.kind === "owner") {
      next.signals.push({ id: signal.id, kind: "owner", key: signal.key, at: signal.at, text: signal.text });
      next.owner = true;
    } else {
      next.signals.push({ id: signal.id, kind: signal.kind, key: signal.key, at: signal.at, ...(signal.commit ? { commit: signal.commit } : {}) });
    }
  }
  const overflow = next.signals.length - maxPendingWakeSignals;
  if (overflow > 0) { next.signals.splice(0, overflow); next.dropped += overflow; }
  return next;
}
