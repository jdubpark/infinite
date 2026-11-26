import {
  evaluateScreenActivity,
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
}

function withoutSpinnerOnly(attention: Attention): Attention {
  if (attention.spinnerOnlySince === undefined) return attention;
  const { spinnerOnlySince: _spinnerOnlySince, ...rest } = attention;
  return rest as Attention;
}

export class WorkerScreenActivity {
  private screenState: ScreenActivityState | undefined;
  private lastSubstantiveOutputAt: number;
  private rawOutputSinceCheck = false;

  constructor(private readonly idleAfterMs: number, initialMs = Date.now()) {
    this.lastSubstantiveOutputAt = initialMs;
  }

  noteRawOutput(nowMs = Date.now()): void {
    void nowMs;
    this.rawOutputSinceCheck = true;
  }

  evaluate(
    attention: Attention,
    lines: readonly string[],
    provider: Provider,
    idleScreen: boolean,
    nowMs = Date.now(),
  ): ScreenCheckOutcome {
    const rawThisCheck = this.rawOutputSinceCheck;
    this.rawOutputSinceCheck = false;
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

    const at = new Date(nowMs).toISOString();
    let nextAttention = attention;
    let changed = false;

    if (result.substantiveChange) {
      this.lastSubstantiveOutputAt = nowMs;
      const cleared = withoutSpinnerOnly(nextAttention);
      if (cleared !== nextAttention) {
        nextAttention = cleared;
        changed = true;
      }
      if (nextAttention.hooks === "none" && nextAttention.lastActivityAt !== at) {
        nextAttention = { ...nextAttention, lastActivityAt: at };
        changed = true;
      }
    } else if (result.spinnerOnly && result.spinnerOnlySince !== undefined) {
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
      this.lastSubstantiveOutputAt > Date.parse(nextAttention.since);

    return {
      attention: nextAttention,
      changed,
      idle,
      freshOutput,
      substantiveChange: result.substantiveChange,
      spinnerOnly: result.spinnerOnly,
    };
  }

  clearSpinner(): void {
    if (this.screenState) {
      this.screenState = { ...this.screenState, spinnerOnlySinceMs: undefined };
    }
  }
}
