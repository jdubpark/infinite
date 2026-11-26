import { PROVIDER_NAMES } from "@infinite/attention";
import { entryToolsFor } from "./entry-roles.js";
import { evaluatorProfiles } from "./evaluator-profiles.js";
import { HOST_LOAD_REASON_PREFIX } from "./host-load.js";
import { familyOf } from "./permission-families.js";
import type { ProviderLimit } from "./provider-limits.js";
import { fallbackRule } from "./routing-rules.js";
import { escalationInstructions, escalationRetarget, retargetPrompt, TEAM_PROMPT_LIMIT_BYTES } from "./team-prompts.js";
import { hostProfilesFor, resolveLimitFallback, type TeamMember, type TeamModelProfile, type TeamRun } from "./team-types.js";
import { TeamError } from "./team-workspace.js";
import { TeamStopRefused } from "./manager.js";
import type { Provider } from "./types.js";

export const ENRICH_LIMIT = 16;
export const ENRICH_WARN_INTERVAL_MS = 60_000;
export const CATCH_WARN_INTERVAL_MS = 60_000;
export const MAX_EVENT_KIND_WARNINGS = 64;
export const MAX_CATCH_WARNING_KEYS = 64;
export const IDLE_MAX_PASSES = 64;
export const PROVIDER_LIMIT_HOLD_PREFIX = "Waiting for provider limit to clear: ";

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SAFE_CODE = /^(?:[A-Z][A-Z0-9_]{1,31}|[a-z][a-z0-9-]{1,40})$/;
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

const SOURCE_BENIGN_CODES = new Set(["source-refreshing", "source-unavailable", "not-github", "unknown-project"]);
const STOP_BENIGN_CODES = new Set(["ENOENT", "ESRCH", "ECONNREFUSED", "EPIPE", "control-busy", "control-lost"]);
const FENCE_BENIGN_CODES = new Set(["ENOENT", "ESRCH", "ECONNREFUSED", "EPIPE"]);
const ENRICH_BENIGN_CODES = new Set(["ENOENT", "ENOTDIR"]);
const OUTBOX_BENIGN_CODES = new Set(["unavailable"]);

const defaultWarn = (message: string) => console.warn(message);

export interface RateLimitedWarningSnapshot {
  total: number;
  suppressed: number;
  emitted: number;
  lastWarnAt: number | undefined;
}

export class RateLimitedWarning {
  private lastWarnAt: number | undefined;
  private suppressedSinceWarn = 0;
  private totalCount = 0;
  private emittedCount = 0;

  constructor(private readonly intervalMs: number = ENRICH_WARN_INTERVAL_MS) {}

  record(
    now: number,
    format: (stats: { total: number; sinceLastWarning: number }) => string,
    warn: (message: string) => void = defaultWarn,
  ): boolean {
    this.totalCount += 1;
    this.suppressedSinceWarn += 1;
    if (this.lastWarnAt === undefined || now - this.lastWarnAt >= this.intervalMs) {
      const sinceLastWarning = this.suppressedSinceWarn;
      this.lastWarnAt = now;
      this.suppressedSinceWarn = 0;
      this.emittedCount += 1;
      warn(format({ total: this.totalCount, sinceLastWarning }));
      return true;
    }
    return false;
  }

  snapshot(): RateLimitedWarningSnapshot {
    return {
      total: this.totalCount,
      suppressed: this.suppressedSinceWarn,
      emitted: this.emittedCount,
      lastWarnAt: this.lastWarnAt,
    };
  }
}

export interface BoundedKindSnapshot {
  tracked: number;
  max: number;
  overflow: number;
  total: number;
}

function sanitizeKind(kind: string): string {
  const cleaned = kind.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 64);
  return SAFE_TOKEN.test(cleaned) ? cleaned : "invalid-kind";
}

export class BoundedKeyedWarnings {
  private readonly seen = new Set<string>();
  private readonly overflowNotice: RateLimitedWarning;
  private overflowCount = 0;
  private totalCount = 0;

  constructor(
    private readonly maxKeys: number = MAX_EVENT_KIND_WARNINGS,
    overflowIntervalMs: number = CATCH_WARN_INTERVAL_MS,
  ) {
    this.overflowNotice = new RateLimitedWarning(overflowIntervalMs);
  }

  record(
    kind: string,
    now: number,
    format: (safeKind: string) => string,
    formatOverflow: (stats: { max: number; overflow: number; sinceLastWarning: number }) => string,
    warn: (message: string) => void = defaultWarn,
  ): boolean {
    const safe = sanitizeKind(kind);
    this.totalCount += 1;
    if (this.seen.has(safe)) return false;
    if (this.seen.size < this.maxKeys) {
      this.seen.add(safe);
      warn(format(safe));
      return true;
    }
    this.overflowCount += 1;
    return this.overflowNotice.record(
      now,
      ({ sinceLastWarning }) => formatOverflow({ max: this.maxKeys, overflow: this.overflowCount, sinceLastWarning }),
      warn,
    );
  }

  snapshot(): BoundedKindSnapshot {
    return {
      tracked: this.seen.size,
      max: this.maxKeys,
      overflow: this.overflowCount,
      total: this.totalCount,
    };
  }
}

function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || errorCodeOf(error) === "ABORT_ERR";
}

export function isBenignSourceRefreshError(error: unknown, aborted = false): boolean {
  if (aborted || isAbortError(error)) return true;
  const code = errorCodeOf(error);
  return code !== undefined && SOURCE_BENIGN_CODES.has(code);
}

export function isBenignStopError(error: unknown, closed = false): boolean {
  if (closed || error instanceof TeamStopRefused || isAbortError(error)) return true;
  const code = errorCodeOf(error);
  return code !== undefined && STOP_BENIGN_CODES.has(code);
}

export function isBenignFenceError(error: unknown, closed = false): boolean {
  if (closed || isAbortError(error)) return true;
  const code = errorCodeOf(error);
  return code !== undefined && FENCE_BENIGN_CODES.has(code);
}

export function isBenignEnrichError(error: unknown, aborted = false, closed = false): boolean {
  if (aborted || closed || isAbortError(error)) return true;
  const code = errorCodeOf(error);
  return code !== undefined && ENRICH_BENIGN_CODES.has(code);
}

export function isBenignOutboxError(error: unknown, closed = false): boolean {
  if (closed || isAbortError(error)) return true;
  const code = errorCodeOf(error);
  return code !== undefined && OUTBOX_BENIGN_CODES.has(code);
}

export function redactedErrorCategory(error: unknown): string {
  if (error instanceof TeamError) return SAFE_CODE.test(error.code) ? `team:${error.code}` : "team:unknown";
  if (error instanceof TeamStopRefused) return "stop-refused";
  const code = errorCodeOf(error);
  if (code !== undefined && SAFE_CODE.test(code)) return `code:${code}`;
  if (error instanceof Error && SAFE_ERROR_NAME.test(error.name)) return `error:${error.name}`;
  return "unknown";
}

export class TrackedTaskSet<T extends Promise<unknown> = Promise<void>> extends Set<T> {
  constructor(private readonly onChange: () => void) {
    super();
  }

  override add(value: T): this {
    if (!this.has(value)) this.onChange();
    return super.add(value);
  }

  override delete(value: T): boolean {
    const removed = super.delete(value);
    if (removed) this.onChange();
    return removed;
  }
}

export interface IdleSources {
  reviewFeedback(): Promise<void>;
  activeTicks: ReadonlySet<Promise<unknown>>;
  removalTasks: ReadonlySet<Promise<unknown>>;
  publicationTasks: ReadonlySet<Promise<unknown>>;
  memberWorkSaveTasks: ReadonlySet<Promise<unknown>>;
  queuesSize(): number;
  settleQueues(): Promise<void>;
}

export interface IdleDrainResult {
  settled: boolean;
  passes: number;
  generation: number;
}

export class IdleWatermark {
  private currentGeneration = 0;
  private unsettledCount = 0;

  get generation(): number {
    return this.currentGeneration;
  }

  get unsettled(): number {
    return this.unsettledCount;
  }

  bump(): number {
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  async drain(
    sources: IdleSources,
    options: {
      maxPasses?: number;
      onUnsettled?: (detail: { passes: number; generation: number; active: Record<string, number> }) => void;
    } = {},
  ): Promise<IdleDrainResult> {
    const maxPasses = options.maxPasses ?? IDLE_MAX_PASSES;
    let passes = 0;
    for (;;) {
      const observed = this.currentGeneration;
      await sources.reviewFeedback();
      const pending: Promise<unknown>[] = [
        ...sources.activeTicks,
        ...sources.removalTasks,
        ...sources.publicationTasks,
        ...sources.memberWorkSaveTasks,
      ];
      if (pending.length > 0) await Promise.allSettled(pending);
      if (sources.queuesSize() > 0) await sources.settleQueues();
      const active = {
        ticks: sources.activeTicks.size,
        removals: sources.removalTasks.size,
        publications: sources.publicationTasks.size,
        memberWorkSaves: sources.memberWorkSaveTasks.size,
        queues: sources.queuesSize(),
      };
      const hasWork = active.ticks > 0 || active.removals > 0 || active.publications > 0 || active.memberWorkSaves > 0 || active.queues > 0;
      if (!hasWork && this.currentGeneration === observed) {
        return { settled: true, passes, generation: this.currentGeneration };
      }
      passes += 1;
      if (passes >= maxPasses) {
        this.unsettledCount += 1;
        options.onUnsettled?.({ passes, generation: this.currentGeneration, active });
        return { settled: false, passes, generation: this.currentGeneration };
      }
    }
  }
}

export interface TeamDiagnosticsSnapshot {
  enrichSkips: RateLimitedWarningSnapshot;
  droppedEventKinds: BoundedKindSnapshot;
  unbuiltEventKinds: BoundedKindSnapshot;
  catchWarnings: { trackedKeys: number; maxKeys: number; total: number; overflow: number };
  idle: { generation: number; unsettled: number };
}

export class TeamDiagnostics {
  readonly enrichSkips: RateLimitedWarning;
  readonly droppedEventKinds: BoundedKeyedWarnings;
  readonly unbuiltEventKinds: BoundedKeyedWarnings;
  readonly idle = new IdleWatermark();
  private readonly catchLimiters = new Map<string, RateLimitedWarning>();
  private readonly catchOverflow: RateLimitedWarning;
  private readonly maxCatchKeys: number;
  private readonly catchIntervalMs: number;
  private catchTotal = 0;
  private catchOverflowCount = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly warn: (message: string) => void = defaultWarn,
    options: { enrichIntervalMs?: number; catchIntervalMs?: number; maxEventKinds?: number; maxCatchKeys?: number } = {},
  ) {
    this.maxCatchKeys = options.maxCatchKeys ?? MAX_CATCH_WARNING_KEYS;
    this.catchIntervalMs = options.catchIntervalMs ?? CATCH_WARN_INTERVAL_MS;
    this.enrichSkips = new RateLimitedWarning(options.enrichIntervalMs ?? ENRICH_WARN_INTERVAL_MS);
    this.droppedEventKinds = new BoundedKeyedWarnings(options.maxEventKinds ?? MAX_EVENT_KIND_WARNINGS, this.catchIntervalMs);
    this.unbuiltEventKinds = new BoundedKeyedWarnings(options.maxEventKinds ?? MAX_EVENT_KIND_WARNINGS, this.catchIntervalMs);
    this.catchOverflow = new RateLimitedWarning(this.catchIntervalMs);
  }

  warnEnrichSkip(): boolean {
    return this.enrichSkips.record(
      this.now(),
      ({ total, sinceLastWarning }) => total === 1
        ? "Ledger reads are waiting on earlier reads that have not ended; some run events are skipped (1 skipped total)."
        : `Ledger reads are waiting on earlier reads that have not ended; some run events are skipped (${sinceLastWarning} skipped since last warning, ${total} total).`,
      this.warn,
    );
  }

  warnDroppedEventKind(kind: string, problem: string): boolean {
    return this.droppedEventKinds.record(
      kind,
      this.now(),
      safe => `A run event of kind ${safe} was dropped: ${problem}.`,
      ({ max, overflow, sinceLastWarning }) => `Dropped run event warning cap (${max} kinds) reached; ${sinceLastWarning} additional dropped kinds suppressed since last warning (${overflow} overflowed total).`,
      this.warn,
    );
  }

  warnUnbuiltEventKind(kind: string): boolean {
    return this.unbuiltEventKinds.record(
      kind,
      this.now(),
      safe => `A run event of kind ${safe} could not be built; the run continues without it.`,
      ({ max, overflow, sinceLastWarning }) => `Unbuilt run event warning cap (${max} kinds) reached; ${sinceLastWarning} additional unbuilt kinds suppressed since last warning (${overflow} overflowed total).`,
      this.warn,
    );
  }

  warnUnexpected(scope: string, error: unknown): boolean {
    const safeScope = sanitizeKind(scope);
    const category = redactedErrorCategory(error);
    const key = `${safeScope}:${category}`;
    this.catchTotal += 1;
    let limiter = this.catchLimiters.get(key);
    if (!limiter) {
      if (this.catchLimiters.size >= this.maxCatchKeys) {
        this.catchOverflowCount += 1;
        return this.catchOverflow.record(
          this.now(),
          ({ sinceLastWarning }) => `TeamService warning tracker reached its cap (${this.maxCatchKeys} categories); ${sinceLastWarning} additional unexpected errors suppressed since last warning (${this.catchOverflowCount} overflowed total).`,
          this.warn,
        );
      }
      limiter = new RateLimitedWarning(this.catchIntervalMs);
      this.catchLimiters.set(key, limiter);
    }
    return limiter.record(
      this.now(),
      ({ total, sinceLastWarning }) => total === 1
        ? `TeamService ${safeScope} failed unexpectedly (${category}).`
        : `TeamService ${safeScope} failed unexpectedly (${category}; ${sinceLastWarning} occurrences since last warning, ${total} total).`,
      this.warn,
    );
  }

  warnIdleUnsettled(detail: { passes: number; generation: number; active: Record<string, number> }): void {
    const counts = Object.entries(detail.active).filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`).join(", ");
    this.warn(`TeamService.idle() did not settle after ${detail.passes} passes (generation ${detail.generation}${counts ? `; active: ${counts}` : ""}).`);
  }

  snapshot(): TeamDiagnosticsSnapshot {
    return {
      enrichSkips: this.enrichSkips.snapshot(),
      droppedEventKinds: this.droppedEventKinds.snapshot(),
      unbuiltEventKinds: this.unbuiltEventKinds.snapshot(),
      catchWarnings: {
        trackedKeys: this.catchLimiters.size,
        maxKeys: this.maxCatchKeys,
        total: this.catchTotal,
        overflow: this.catchOverflowCount,
      },
      idle: {
        generation: this.idle.generation,
        unsettled: this.idle.unsettled,
      },
    };
  }
}

const clockUtc = (iso: string) => `${iso.slice(11, 16)} UTC`;

export function isProviderDeferredMember(member: Pick<TeamMember, "status" | "pendingLimit">): boolean {
  return member.status === "queued" && member.pendingLimit === true;
}

export function isDeferredWorkerMember(member: Pick<TeamMember, "status" | "pendingLimit" | "pendingCapacity">): boolean {
  return member.status === "queued" && (member.pendingLimit === true || member.pendingCapacity === true);
}

export function limitFallbackEligibility(
  run: TeamRun,
  role: TeamMember["role"],
  planMemberId?: string,
): ((profile: TeamModelProfile) => boolean) | undefined {
  if (role === "permission-coordinator") return profile => profile.provider === "claude";
  if (role === "evaluator") return () => false;
  if (role === "intent-checker") {
    if (!run.lineup) return () => false;
    const coordinatorFamily = familyOf(run.lineup.coordinator);
    const planMember = planMemberId !== undefined
      ? run.members.find(member => member.memberId === planMemberId)
      : [...run.members].reverse().find(member => member.revision === run.revision && member.role === "project-manager" && member.report?.kind === "plan");
    const authorFamily = planMember?.modelProfile ? familyOf(planMember.modelProfile) : undefined;
    if (coordinatorFamily === undefined || authorFamily === undefined) return () => false;
    const evaluatorIds = new Set(evaluatorProfiles(run.lineup).map(profile => profile.id));
    return profile => {
      if (!evaluatorIds.has(profile.id)) return false;
      const family = familyOf(profile);
      return family !== undefined && family !== coordinatorFamily && family !== authorFamily;
    };
  }
  return fallbackRule(run, role);
}

export function escalationRetargetFor(
  run: TeamRun,
  role: TeamMember["role"],
  fromProfileId: string | undefined,
  toProfileId: string | undefined,
  currentHostProfiles?: boolean,
): { candidates: string[]; next: string | undefined } | undefined {
  if (role !== "implementer") return undefined;
  const fromHost = currentHostProfiles ?? hostProfilesFor(run, role, fromProfileId);
  const toHost = hostProfilesFor(run, role, toProfileId);
  const fromText = escalationInstructions(run, fromProfileId);
  const toText = escalationInstructions(run, toProfileId);
  if (fromHost === toHost && fromText === toText) return undefined;
  return escalationRetarget(run, fromProfileId, toProfileId);
}

export function providerLimitHoldReason(
  run: TeamRun,
  activeLimits: readonly ProviderLimit[],
  extraLimit?: ProviderLimit,
): string | undefined {
  const byProvider = new Map<Provider, ProviderLimit>();
  for (const item of run.members) {
    if (item.revision !== run.revision || !isProviderDeferredMember(item)) continue;
    const provider = item.provider ?? run.provider;
    const active = activeLimits.find(limit => limit.provider === provider);
    if (active) byProvider.set(provider, active);
  }
  if (extraLimit) byProvider.set(extraLimit.provider, extraLimit);
  if (byProvider.size === 0) return undefined;
  const parts = [...byProvider.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider))
    .map(limit => `${PROVIDER_NAMES[limit.provider]} is limited until ${clockUtc(limit.expiresAt)}`);
  return `${PROVIDER_LIMIT_HOLD_PREFIX}${parts.join("; ")}.`;
}

export type ProviderLimitLaunchAction =
  | { kind: "proceed" }
  | { kind: "switch"; fallback: TeamModelProfile; prompt: string; limit: ProviderLimit; eventText: string }
  | { kind: "defer"; limit: ProviderLimit; reason: string; eventText: string };

export function resolveProviderLimitLaunch(
  run: TeamRun,
  member: TeamMember,
  activeLimits: readonly ProviderLimit[],
  limitedProviders: Set<Provider>,
  planMemberId?: string,
): ProviderLimitLaunchAction {
  const provider = member.provider ?? run.provider;
  const limit = activeLimits.find(item => item.provider === provider);
  if (!limit) return { kind: "proceed" };
  const selected = member.modelProfile;
  const eligible = limitFallbackEligibility(run, member.role, planMemberId);
  const fallback = selected && run.lineup
    ? resolveLimitFallback(run.lineup, selected.id, limitedProviders, eligible)
    : undefined;
  const escalation = fallback ? escalationRetargetFor(run, member.role, selected?.id, fallback.id, member.hostProfiles === true) : undefined;
  const retargeted = fallback
    ? retargetPrompt(member.prompt, {
      provider: fallback.provider,
      profile: fallback,
      role: member.role,
      entryTools: entryToolsFor(run, member.role),
      ...(escalation ? { escalation } : {}),
    })
    : undefined;
  const fitsLimit = retargeted !== undefined && Buffer.byteLength(retargeted, "utf8") <= TEAM_PROMPT_LIMIT_BYTES;
  if (selected && fallback && fitsLimit) {
    return {
      kind: "switch",
      fallback,
      prompt: retargeted,
      limit,
      eventText: `${selected.label} launched on ${fallback.label}: ${PROVIDER_NAMES[limit.provider]} is limited until ${clockUtc(limit.expiresAt)}`,
    };
  }
  const until = clockUtc(limit.expiresAt);
  return {
    kind: "defer",
    limit,
    reason: providerLimitHoldReason(run, activeLimits, limit) ?? `${PROVIDER_LIMIT_HOLD_PREFIX}${PROVIDER_NAMES[limit.provider]} is limited until ${until}.`,
    eventText: `${member.title} launch deferred: ${PROVIDER_NAMES[limit.provider]} is limited until ${until} with no available fallback.`,
  };
}

export function replaceableHoldReason(current: string | undefined, sessionSlotReason: string): boolean {
  return current === undefined
    || current === sessionSlotReason
    || current.startsWith(HOST_LOAD_REASON_PREFIX)
    || current.startsWith(PROVIDER_LIMIT_HOLD_PREFIX);
}

export function resolveLaunchHoldReason(
  run: TeamRun,
  activeLimits: readonly ProviderLimit[],
  sessionSlotReason: string,
  options: { extraLimit?: ProviderLimit; hostLoadReason?: string; sessionSlotFull?: boolean } = {},
): string | undefined {
  if (options.hostLoadReason) return options.hostLoadReason;
  const limitReason = providerLimitHoldReason(run, activeLimits, options.extraLimit);
  if (limitReason) return limitReason;
  if (options.sessionSlotFull) return sessionSlotReason;
  return undefined;
}

export function applyLaunchHoldReason(run: TeamRun, targetReason: string | undefined, sessionSlotReason: string): boolean {
  if (!replaceableHoldReason(run.reason, sessionSlotReason) || run.reason === targetReason) return false;
  run.reason = targetReason;
  return true;
}

export function expireQueuedPermissionReview(
  run: TeamRun,
  member: TeamMember,
  decision: NonNullable<TeamRun["permissionDecisions"]>[number],
  activeLimits: readonly ProviderLimit[],
  permissionReasons?: { reviewing: string; userInput: string },
): { decisionChanged: boolean; recovery: NonNullable<TeamRun["permissionRecovery"]>["requests"][number] | undefined } {
  const decisionChanged = decision.status === "reviewing";
  member.status = member.continuation?.mode === "resume" ? "waiting" : "stopped";
  member.report = undefined;
  member.pendingLimit = undefined;
  member.pendingCapacity = undefined;
  if (run.reason?.startsWith(PROVIDER_LIMIT_HOLD_PREFIX)) run.reason = providerLimitHoldReason(run, activeLimits);
  if (!decisionChanged) return { decisionChanged: false, recovery: undefined };
  decision.status = "escalated";
  decision.reason = "The five-minute review window expired without a decision.";
  if (permissionReasons && run.reason === permissionReasons.reviewing
    && !(run.permissionDecisions ?? []).some(item => item !== decision && item.status === "reviewing")) {
    run.reason = permissionReasons.userInput;
  }
  const recovery = decision.recoveryRequestId ? run.permissionRecovery?.requests.find(item => item.id === decision.recoveryRequestId) : undefined;
  return { decisionChanged: true, recovery };
}

export type LaunchAdmissionResult =
  | { proceed: false; changed: boolean }
  | { proceed: true; changed: boolean; pendingSwitch?: Extract<ProviderLimitLaunchAction, { kind: "switch" }> };

export function evaluateLaunchAdmission(
  run: TeamRun,
  member: TeamMember,
  activeLimits: readonly ProviderLimit[],
  limitedProviders: Set<Provider>,
  sessionSlotReason: string,
  appendEvent: (text: string) => void,
  options: { planMemberId?: string; workerCapacityFull?: boolean; hostLoadReason?: string; sessionSlotFull?: boolean } = {},
): LaunchAdmissionResult {
  const decision = resolveProviderLimitLaunch(run, member, activeLimits, limitedProviders, options.planMemberId);
  if (decision.kind === "defer") {
    let changed = false;
    if (!member.pendingLimit) { member.pendingLimit = true; changed = true; }
    if (member.pendingCapacity) { member.pendingCapacity = undefined; changed = true; }
    if (!run.events.some(item => item.text === decision.eventText)) { appendEvent(decision.eventText); changed = true; }
    const holdReason = resolveLaunchHoldReason(run, activeLimits, sessionSlotReason, { extraLimit: decision.limit, hostLoadReason: options.hostLoadReason });
    if (applyLaunchHoldReason(run, holdReason, sessionSlotReason)) changed = true;
    return { proceed: false, changed };
  }
  if (options.workerCapacityFull) {
    let changed = false;
    if (member.pendingLimit) { member.pendingLimit = undefined; changed = true; }
    if (!member.pendingCapacity) { member.pendingCapacity = true; changed = true; }
    const holdReason = resolveLaunchHoldReason(run, activeLimits, sessionSlotReason, { hostLoadReason: options.hostLoadReason });
    if (applyLaunchHoldReason(run, holdReason, sessionSlotReason)) changed = true;
    return { proceed: false, changed };
  }
  let changed = false;
  if (member.pendingLimit) { member.pendingLimit = undefined; changed = true; }
  if (member.pendingCapacity) { member.pendingCapacity = undefined; changed = true; }
  if (options.hostLoadReason || options.sessionSlotFull) {
    const holdReason = resolveLaunchHoldReason(run, activeLimits, sessionSlotReason, { hostLoadReason: options.hostLoadReason, sessionSlotFull: options.sessionSlotFull });
    if (applyLaunchHoldReason(run, holdReason, sessionSlotReason)) changed = true;
    return { proceed: false, changed };
  }
  const holdReason = resolveLaunchHoldReason(run, activeLimits, sessionSlotReason);
  if (applyLaunchHoldReason(run, holdReason, sessionSlotReason)) changed = true;
  return { proceed: true, changed, ...(decision.kind === "switch" ? { pendingSwitch: decision } : {}) };
}

export function commitProviderLimitSwitch(
  run: TeamRun,
  member: TeamMember,
  pendingSwitch: Extract<ProviderLimitLaunchAction, { kind: "switch" }>,
  appendEvent: (text: string) => void,
): () => boolean {
  const prevProfile = member.modelProfile;
  const prevProvider = member.provider;
  const prevPrompt = member.prompt;
  const prevHostProfiles = member.hostProfiles;
  const prevScratch = member.scratchDirectory;
  const prevEventsLen = run.events.length;
  let active = true;
  member.modelProfile = structuredClone(pendingSwitch.fallback);
  member.provider = pendingSwitch.fallback.provider;
  member.prompt = pendingSwitch.prompt;
  if (hostProfilesFor(run, member.role, pendingSwitch.fallback.id)) member.hostProfiles = true;
  else delete member.hostProfiles;
  appendEvent(pendingSwitch.eventText);
  return () => {
    if (!active) return false;
    active = false;
    member.modelProfile = prevProfile;
    member.provider = prevProvider;
    member.prompt = prevPrompt;
    if (prevHostProfiles) member.hostProfiles = prevHostProfiles;
    else delete member.hostProfiles;
    if (prevScratch) member.scratchDirectory = prevScratch;
    else delete member.scratchDirectory;
    run.events.length = prevEventsLen;
    return true;
  };
}

export function applyProviderLimitGate(
  run: TeamRun,
  member: TeamMember,
  activeLimits: readonly ProviderLimit[],
  limitedProviders: Set<Provider>,
  sessionSlotReason: string,
  appendEvent: (text: string) => void,
  options: { planMemberId?: string; workerCapacityFull?: boolean; hostLoadReason?: string; sessionSlotFull?: boolean } = {},
): { proceed: boolean; changed: boolean } {
  const result = evaluateLaunchAdmission(run, member, activeLimits, limitedProviders, sessionSlotReason, appendEvent, options);
  if (!result.proceed) return result;
  if (result.pendingSwitch) {
    commitProviderLimitSwitch(run, member, result.pendingSwitch, appendEvent);
    return { proceed: true, changed: true };
  }
  return { proceed: true, changed: result.changed };
}
