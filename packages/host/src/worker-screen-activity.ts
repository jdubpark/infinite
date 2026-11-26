import {
  evaluateScreenActivity,
  rebaselineScreenActivity,
  type Attention,
  type Provider,
  type ScreenActivityState,
} from "@infinite/attention";

export interface ScreenCheckOutcome {
  attention: Attention;
  changed: boolean;
  idle: boolean;
  freshOutput: boolean;
  substantiveChange: boolean;
  spinnerOnly: boolean;
  rawOutputSinceCheck: boolean;
}

function withoutSpinnerOnly(attention: Attention): Attention {
  if (attention.spinnerOnlySince === undefined) return attention;
  const { spinnerOnlySince: _spinnerOnlySince, ...rest } = attention;
  return rest as Attention;
}

export class WorkerScreenActivity {
  private screenState: ScreenActivityState | undefined;
  private lastSubstantiveOutputAt: number;
  private pendingRawOutputAt: number | undefined;
  private lastRawOutputAt: number | undefined;

  constructor(private readonly idleAfterMs: number, initialMs = Date.now()) {
    this.lastSubstantiveOutputAt = initialMs;
  }

  noteRawOutput(nowMs = Date.now()): void {
    this.pendingRawOutputAt =
      this.pendingRawOutputAt === undefined ? nowMs : Math.max(this.pendingRawOutputAt, nowMs);
    this.lastRawOutputAt =
      this.lastRawOutputAt === undefined ? nowMs : Math.max(this.lastRawOutputAt, nowMs);
  }

  hasPendingRawOutput(): boolean {
    return this.pendingRawOutputAt !== undefined;
  }

  rebaseline(lines: readonly string[], provider: Provider): void {
    this.screenState = rebaselineScreenActivity(this.screenState, lines, provider);
  }

  evaluate(
    attention: Attention,
    lines: readonly string[],
    provider: Provider,
    idleScreen: boolean,
    nowMs = Date.now(),
  ): ScreenCheckOutcome {
    const rawOutputAt = this.pendingRawOutputAt;
    const rawThisCheck = rawOutputAt !== undefined;
    this.pendingRawOutputAt = undefined;
    const syncedState: ScreenActivityState | undefined = this.screenState
      ? {
          ...this.screenState,
          spinnerOnlySinceMs: attention.spinnerOnlySince === undefined
            ? undefined
            : (this.screenState.spinnerOnlySinceMs ?? Date.parse(attention.spinnerOnlySince)),
        }
      : undefined;
    const result = evaluateScreenActivity(syncedState, lines, provider, rawThisCheck, nowMs);
    this.screenState = result.nextState;

    let nextAttention = attention;
    let changed = false;
    let substantiveObservedAt: number | undefined;

    if (result.substantiveChange) {
      substantiveObservedAt = rawOutputAt ?? this.lastRawOutputAt ?? nowMs;
      if (substantiveObservedAt > this.lastSubstantiveOutputAt) {
        this.lastSubstantiveOutputAt = substantiveObservedAt;
      }
      const cleared = withoutSpinnerOnly(nextAttention);
      if (cleared !== nextAttention) {
        nextAttention = cleared;
        changed = true;
      }
      const prevActivityMs = Date.parse(nextAttention.lastActivityAt);
      if (nextAttention.hooks === "none" && (!Number.isFinite(prevActivityMs) || substantiveObservedAt > prevActivityMs)) {
        nextAttention = { ...nextAttention, lastActivityAt: new Date(substantiveObservedAt).toISOString() };
        changed = true;
      }
    }

    if (nextAttention.state !== "working") {
      const cleared = withoutSpinnerOnly(nextAttention);
      if (cleared !== nextAttention) {
        nextAttention = cleared;
        changed = true;
      }
      if (this.screenState?.spinnerOnlySinceMs !== undefined) {
        this.screenState = { ...this.screenState, spinnerOnlySinceMs: undefined };
      }
    } else if (!result.substantiveChange && result.spinnerOnly && result.spinnerOnlySince !== undefined) {
      if (nextAttention.spinnerOnlySince !== result.spinnerOnlySince) {
        nextAttention = { ...nextAttention, spinnerOnlySince: result.spinnerOnlySince };
        changed = true;
      }
    }

    const idle =
      !result.substantiveChange &&
      nowMs - this.lastSubstantiveOutputAt >= this.idleAfterMs &&
      idleScreen;
    const freshOutput =
      result.substantiveChange &&
      substantiveObservedAt !== undefined &&
      substantiveObservedAt > Date.parse(nextAttention.since);

    return {
      attention: nextAttention,
      changed,
      idle,
      freshOutput,
      substantiveChange: result.substantiveChange,
      spinnerOnly: result.spinnerOnly,
      rawOutputSinceCheck: rawThisCheck,
    };
  }

  clearSpinner(): void {
    if (this.screenState) {
      this.screenState = { ...this.screenState, spinnerOnlySinceMs: undefined };
    }
  }
}
