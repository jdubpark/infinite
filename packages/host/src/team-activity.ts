import { digest } from "./team-kernel.js";
import type { TeamMember, TeamRun } from "./team-types.js";
import type { Stored } from "./teams.js";

export interface TeamSaveSnapshot {
  persisted: string;
  runState: string;
  activity: string;
}

function latestIso(candidates: readonly (string | undefined)[], fallback: string): string {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const value of candidates) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best ?? fallback;
}

function runActivityTimestamps(run: TeamRun): (string | undefined)[] {
  const times: (string | undefined)[] = [
    run.createdAt,
    run.discovery?.completedAt,
    run.deliveryReceipt?.reportedAt,
    run.pullRequest?.reportedAt,
    run.publication && "publishedAt" in run.publication ? run.publication.publishedAt : undefined,
    run.publication?.failure?.at,
    run.changes?.recordedAt,
    run.assessment?.at,
    run.permissionsRevokedAt,
    run.routingRevokedAt,
    run.recovery?.source.at,
    run.workspaceRemovedAt,
  ];
  for (const member of run.members) {
    times.push(member.startedAt, member.lastActivityAt, member.reportedAt, member.exitConfirmedAt, member.stalledAt);
  }
  for (const event of run.events) times.push(event.at);
  for (const decision of run.decisions) times.push(decision.createdAt, decision.answeredAt);
  for (const check of run.checks) times.push(check.startedAt, check.finishedAt);
  for (const item of run.steering) times.push(item.at);
  for (const entry of run.reviewFeedback ?? []) times.push(entry.receivedAt);
  for (const item of run.continuations ?? []) times.push(item.at);
  for (const task of run.tasks) {
    times.push(task.ownerRating?.at, task.escalation?.at);
    for (const sw of task.limitSwitches ?? []) times.push(sw.at);
  }
  return times;
}

export function deriveTeamLastActivityAt(run: TeamRun): string {
  return latestIso(runActivityTimestamps(run), run.createdAt || run.updatedAt);
}

export function teamLastActivityAt(run: TeamRun): string {
  return run.lastActivityAt ?? deriveTeamLastActivityAt(run);
}

function normalizeMember(member: TeamMember) {
  const { cursor: _cursor, entryCursor: _entryCursor, pendingLimit, ...rest } = member;
  return { ...rest, ...(pendingLimit ? { pendingLimit: true } : {}) };
}

function normalizeLinear(linear: TeamRun["linear"]) {
  if (!linear) return undefined;
  const { checkedAt: _checkedAt, retryAt: _retryAt, ...rest } = linear;
  return rest;
}

export function teamSaveSnapshot(stored: Stored): TeamSaveSnapshot {
  const { updatedAt: _updatedAt, lastActivityAt: _lastActivityAt, linear, members, ...runRest } = stored.run;
  const persisted = digest({ ...stored, run: { ...runRest, members, ...(linear ? { linear } : {}) } });
  const normalizedMembers = members.map(normalizeMember);
  const {
    run: _run,
    receipts: _receipts,
    retention: _retention,
    outbox: _outbox,
    ledgerStatus: _ledgerStatus,
    ledgerBlockSource: _ledgerBlockSource,
    ledgerGap: _ledgerGap,
    ledgerReplaces: _ledgerReplaces,
    permissionTaskEnded: _permissionTaskEnded,
    answersMarked: _answersMarked,
    unfencedAnswers: _unfencedAnswers,
    checkObservations: _checkObservations,
    ...storedRest
  } = stored;
  const runState = digest({
    ...storedRest,
    run: {
      ...runRest,
      members: normalizedMembers,
      ...(linear ? { linear: normalizeLinear(linear) } : {}),
    },
  });
  const activity = digest({ ...runRest, members: normalizedMembers });
  return { persisted, runState, activity };
}

export class TeamSaveTracker {
  private readonly snapshots = new Map<string, TeamSaveSnapshot>();

  seed(stored: Stored): void {
    this.snapshots.set(stored.run.id, teamSaveSnapshot(stored));
  }

  commit(stored: Stored, write: () => void, now: () => string, records?: ReadonlyMap<string, Stored>): boolean {
    const id = stored.run.id;
    const prior = this.snapshots.get(id);
    const next = teamSaveSnapshot(stored);
    if (prior !== undefined && next.persisted === prior.persisted) return false;
    const runStateChanged = prior === undefined || next.runState !== prior.runState;
    const activityChanged = prior === undefined || next.activity !== prior.activity;
    const previousUpdatedAt = stored.run.updatedAt;
    const previousLastActivityAt = stored.run.lastActivityAt;
    if (runStateChanged || activityChanged) {
      const at = now();
      if (runStateChanged) stored.run.updatedAt = at;
      if (activityChanged) {
        stored.run.lastActivityAt = latestIso([stored.run.lastActivityAt, ...runActivityTimestamps(stored.run), at], at);
      }
    }
    try {
      write();
    } catch (error) {
      stored.run.updatedAt = previousUpdatedAt;
      stored.run.lastActivityAt = previousLastActivityAt;
      throw error;
    }
    this.snapshots.set(id, next);
    if (records && this.snapshots.size > records.size + 64) {
      for (const key of this.snapshots.keys()) if (!records.has(key)) this.snapshots.delete(key);
    }
    return true;
  }
}
