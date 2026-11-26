import {
  detectLimit,
  evaluateScreenActivity,
  rebaselineScreenActivity,
  substantiveScreenFingerprint,
  type Attention,
  type Provider,
  type ScreenActivityState,
  type Signal,
  type SignalData,
} from "@infinite/attention";

export interface ScreenCheckOutcome {
  attention: Attention;
  changed: boolean;
  idle: boolean;
  freshOutput: boolean;
  substantiveChange: boolean;
  spinnerOnly: boolean;
  rawOutputSinceCheck: boolean;
  displayChanged: boolean;
}

function withoutSpinnerOnly(attention: Attention): Attention {
  if (attention.spinnerOnlySince === undefined) return attention;
  const { spinnerOnlySince: _spinnerOnlySince, ...rest } = attention;
  return rest as Attention;
}

function renderedDisplay(lines: readonly string[]): string {
  return lines.map((line) => line.trimEnd()).join("\n").trimEnd();
}

export class WorkerScreenActivity {
  private screenState: ScreenActivityState | undefined;
  private lastSubstantiveOutputAt: number;
  private pendingRawOutputAt: number | undefined;
  private lastRawOutputAt: number | undefined;
  private pendingSubstantiveChangeAt: number | undefined;
  private pendingDisplayChanged = false;
  private sawRenderedInWindow = false;
  private lastRenderedFingerprint: string | undefined;
  private lastRenderedDisplay: string | undefined;

  constructor(private readonly idleAfterMs: number, initialMs = Date.now()) {
    this.lastSubstantiveOutputAt = initialMs;
  }

  noteRawOutput(nowMs = Date.now()): void {
    this.pendingRawOutputAt =
      this.pendingRawOutputAt === undefined ? nowMs : Math.max(this.pendingRawOutputAt, nowMs);
    this.lastRawOutputAt =
      this.lastRawOutputAt === undefined ? nowMs : Math.max(this.lastRawOutputAt, nowMs);
  }

  noteRenderedOutput(lines: readonly string[], provider: Provider, arrivedAt = Date.now()): void {
    this.noteRawOutput(arrivedAt);
    this.sawRenderedInWindow = true;
    const display = renderedDisplay(lines);
    if (this.lastRenderedDisplay === undefined ? display !== "" : display !== this.lastRenderedDisplay) {
      this.pendingDisplayChanged = true;
    }
    this.lastRenderedDisplay = display;
    const fingerprint = substantiveScreenFingerprint(lines, provider);
    const baseline = this.lastRenderedFingerprint ?? this.screenState?.fingerprint;
    if (baseline === undefined ? fingerprint !== "" : fingerprint !== baseline) {
      this.pendingSubstantiveChangeAt =
        this.pendingSubstantiveChangeAt === undefined
          ? arrivedAt
          : Math.max(this.pendingSubstantiveChangeAt, arrivedAt);
    }
    this.lastRenderedFingerprint = fingerprint;
  }

  markTurnEnd(lines: readonly string[], provider: Provider, turnEndMs = Date.now()): void {
    const fingerprint = substantiveScreenFingerprint(lines, provider);
    const display = renderedDisplay(lines);
    this.screenState = {
      ...this.screenState,
      fingerprint,
      spinnerOnlySinceMs: undefined,
    };
    this.lastRenderedFingerprint = fingerprint;
    this.lastRenderedDisplay = display;
    if (turnEndMs > this.lastSubstantiveOutputAt) {
      this.lastSubstantiveOutputAt = turnEndMs;
    }
    if (this.pendingSubstantiveChangeAt !== undefined && this.pendingSubstantiveChangeAt <= turnEndMs) {
      this.pendingSubstantiveChangeAt = undefined;
    }
  }

  hasPendingRawOutput(): boolean {
    return this.pendingRawOutputAt !== undefined;
  }

  rebaseline(lines: readonly string[], provider: Provider): void {
    this.screenState = rebaselineScreenActivity(this.screenState, lines, provider);
    this.lastRenderedFingerprint = this.screenState.fingerprint;
    this.lastRenderedDisplay = renderedDisplay(lines);
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
    const sawRendered = this.sawRenderedInWindow;
    const pendingSubstantiveAt = this.pendingSubstantiveChangeAt;
    const pendingDisplayChanged = this.pendingDisplayChanged;
    const prevDisplay = this.lastRenderedDisplay;
    this.pendingRawOutputAt = undefined;
    this.pendingSubstantiveChangeAt = undefined;
    this.pendingDisplayChanged = false;
    this.sawRenderedInWindow = false;

    const display = renderedDisplay(lines);
    const displayChanged = sawRendered
      ? pendingDisplayChanged
      : rawThisCheck && (prevDisplay === undefined ? display !== "" : display !== prevDisplay);

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
    this.lastRenderedFingerprint = result.nextState.fingerprint;
    this.lastRenderedDisplay = display;

    let nextAttention = attention;
    let changed = false;
    let substantiveObservedAt: number | undefined;

    if (result.substantiveChange) {
      substantiveObservedAt = sawRendered
        ? pendingSubstantiveAt
        : (rawOutputAt ?? this.lastRawOutputAt ?? nowMs);
      if (substantiveObservedAt !== undefined && substantiveObservedAt > this.lastSubstantiveOutputAt) {
        this.lastSubstantiveOutputAt = substantiveObservedAt;
      }
      const cleared = withoutSpinnerOnly(nextAttention);
      if (cleared !== nextAttention) {
        nextAttention = cleared;
        changed = true;
      }
      const prevActivityMs = Date.parse(nextAttention.lastActivityAt);
      if (
        substantiveObservedAt !== undefined &&
        nextAttention.hooks === "none" &&
        (!Number.isFinite(prevActivityMs) || substantiveObservedAt > prevActivityMs)
      ) {
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
      displayChanged,
    };
  }

  clearSpinner(): void {
    if (this.screenState) {
      this.screenState = { ...this.screenState, spinnerOnlySinceMs: undefined };
    }
  }
}

export type LimitSignal = Extract<Signal, { kind: "provider-limit" }>;

export class WorkerLimitWatch {
  private limitWatch: { source: "hook" | "screen"; firstAt: number; checks: number; corroborated: boolean } | undefined;
  private screenLimitSuppressed = false;
  private limitEpisode: { single?: "hook" | "screen"; corroborated: boolean; misses: number; resetsAt?: string } | undefined;

  constructor(
    private readonly provider: Provider,
    private readonly limitConfirmMs: number,
    private readonly emit: (signal: LimitSignal, source: SignalData["source"], agent?: { id: string; type: string }) => void,
  ) {}

  reset(): void {
    this.limitEpisode = undefined;
    this.limitWatch = undefined;
    this.screenLimitSuppressed = true;
  }

  fromProtocol(signal: LimitSignal): void {
    this.limitWatch = undefined;
    this.recordLimit(signal, "protocol");
  }

  fromHook(signal: LimitSignal, agent?: { id: string; type: string }, nowMs = Date.now()): void {
    if (signal.confidence === "corroborated") {
      this.limitWatch = undefined;
      this.recordLimit(signal, "hook", agent);
      return;
    }
    if (this.limitEpisode?.single === "screen" && !this.limitEpisode.corroborated) {
      this.limitWatch = undefined;
      this.recordLimit({ ...signal, confidence: "corroborated" }, "hook", agent);
      return;
    }
    const fresh = !this.limitEpisode?.single && !this.limitEpisode?.corroborated;
    this.recordLimit(signal, "hook", agent);
    if (fresh) this.limitWatch = { source: "hook", firstAt: nowMs, checks: 0, corroborated: false };
  }

  watch(lines: string[], nowMs: number, displayChanged: boolean): void {
    const found = detectLimit(lines, this.provider, new Date(nowMs));
    const watch = this.limitWatch;
    if (!found) {
      this.screenLimitSuppressed = false;
      if (watch?.source === "screen" || (watch && ++watch.checks > 2)) this.limitWatch = undefined;
      if (!this.limitWatch && this.limitEpisode && ++this.limitEpisode.misses >= 3) this.limitEpisode = undefined;
      return;
    }
    if (this.screenLimitSuppressed) return;
    if (this.limitEpisode) this.limitEpisode.misses = 0;
    const observed = {
      kind: "provider-limit" as const,
      limit: found.limit,
      message: found.message,
      ...(found.resetsAt ? { resetsAt: found.resetsAt } : {}),
    };
    if (watch?.source === "hook") {
      this.limitWatch = undefined;
      this.recordLimit({ ...observed, confidence: "corroborated" }, "screen");
      return;
    }
    if (!watch) {
      this.recordLimit({ ...observed, confidence: "single-source" }, "screen");
      if (this.provider === "codex") this.limitWatch = { source: "screen", firstAt: nowMs, checks: 1, corroborated: false };
      return;
    }
    if (displayChanged) {
      this.limitWatch = { source: "screen", firstAt: nowMs, checks: 1, corroborated: watch.corroborated };
      return;
    }
    if (watch.corroborated) return;
    watch.checks++;
    if (watch.checks >= 3 && nowMs - watch.firstAt >= this.limitConfirmMs) {
      this.recordLimit({ ...observed, confidence: "corroborated" }, "screen");
      watch.corroborated = true;
    }
  }

  private recordLimit(signal: LimitSignal, source: SignalData["source"], agent?: { id: string; type: string }): void {
    const episode = (this.limitEpisode ??= { corroborated: false, misses: 0 });
    episode.misses = 0;
    episode.resetsAt = signal.resetsAt ?? episode.resetsAt;
    if (episode.resetsAt) signal = { ...signal, resetsAt: episode.resetsAt };
    if (signal.confidence === "corroborated") {
      if (episode.corroborated) return;
      episode.corroborated = true;
    } else {
      if (episode.single || episode.corroborated) return;
      episode.single = source === "hook" ? "hook" : "screen";
    }
    this.emit(signal, source, agent);
  }
}
