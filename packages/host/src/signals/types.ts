export const signalKinds = ["revert", "external-commit", "delivery-landed", "owner", "ci-failure"] as const;
export type SignalKind = (typeof signalKinds)[number];
export type CommitSignalKind = Exclude<SignalKind, "owner">;

interface ProjectSignalBase {
  seq: number;
  id: string;
  projectId: string;
  key: string;
  at: string;
}

export type CiFailureFields = {
  workflow?: string;
  checkName?: string;
  branch?: string;
};

export type ProjectSignal =
  | (ProjectSignalBase & { kind: "owner"; text: string; commit?: never; runId?: never; workflow?: never; checkName?: never; branch?: never })
  | (ProjectSignalBase & { kind: "ci-failure"; commit?: string; runId?: string; text?: never } & CiFailureFields)
  | (ProjectSignalBase & { kind: Exclude<CommitSignalKind, "ci-failure">; commit?: string; runId?: string; text?: never; workflow?: never; checkName?: never; branch?: never });

export interface SignalReader {
  head(): number | undefined;
  after(projectId: string, seq: number, options?: { kinds?: readonly SignalKind[]; limit?: number }): ProjectSignal[];
}

export type PendingWakeSignal =
  | { id: string; kind: "owner"; key: string; at: string; text: string; commit?: never; workflow?: never; checkName?: never; branch?: never; count?: never }
  | { id: string; kind: "ci-failure"; key: string; at: string; commit?: string; text?: never; count?: number } & CiFailureFields
  | { id: string; kind: Exclude<CommitSignalKind, "ci-failure">; key: string; at: string; commit?: string; text?: never; workflow?: never; checkName?: never; branch?: never; count?: never };

export interface PendingWake {
  signals: PendingWakeSignal[];
  dropped: number;
  since: string;
  owner?: boolean;
}

export const maxPendingWakeSignals = 20;

const ciFailureCoalesceMatch = (existing: PendingWakeSignal, incoming: Extract<ProjectSignal, { kind: "ci-failure" }>): boolean =>
  existing.kind === "ci-failure"
  && (existing.checkName ?? "") === (incoming.checkName ?? "")
  && (existing.commit ?? "") === (incoming.commit ?? "");

export function addToPendingWake(pending: PendingWake | undefined, signals: readonly ProjectSignal[], now: string): PendingWake | undefined {
  if (!signals.length) return pending;
  const next: PendingWake = pending ? { ...pending, signals: pending.signals.map(item => ({ ...item })) } : { signals: [], dropped: 0, since: now };
  for (const signal of signals) {
    if (next.signals.some(value => value.id === signal.id)) continue;
    if (signal.kind === "owner") {
      next.signals.push({ id: signal.id, kind: "owner", key: signal.key, at: signal.at, text: signal.text });
      next.owner = true;
    } else if (signal.kind === "ci-failure") {
      const existing = next.signals.find(value => ciFailureCoalesceMatch(value, signal));
      if (existing && existing.kind === "ci-failure") {
        existing.at = signal.at;
        existing.workflow ??= signal.workflow;
        existing.branch ??= signal.branch;
        existing.count = (existing.count ?? 1) + 1;
      } else {
        next.signals.push({
          id: signal.id,
          kind: "ci-failure",
          key: signal.key,
          at: signal.at,
          ...(signal.commit ? { commit: signal.commit } : {}),
          ...(signal.workflow ? { workflow: signal.workflow } : {}),
          ...(signal.checkName ? { checkName: signal.checkName } : {}),
          ...(signal.branch ? { branch: signal.branch } : {}),
        });
      }
    } else {
      next.signals.push({ id: signal.id, kind: signal.kind, key: signal.key, at: signal.at, ...(signal.commit ? { commit: signal.commit } : {}) });
    }
  }
  const overflow = next.signals.length - maxPendingWakeSignals;
  if (overflow > 0) { next.signals.splice(0, overflow); next.dropped += overflow; }
  return next;
}
