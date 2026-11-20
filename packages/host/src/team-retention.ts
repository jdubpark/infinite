import { DEFAULT_TEAM_RETENTION, type TeamMember, type TeamPublicationCategory, type TeamRun, type TeamView } from "./team-types.js";
import { rm as rmAsync } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EvidenceStore } from "./evidence/store.js";
import { runEventKey, runSummaryCounts } from "./run-events.js";
import { hostGithubGrantEnvironment } from "./github-grants.js";
import { ensureDefaultTeamRoot, ensureHostDirectory, publishTeamHead, removeMemberWorkspace, removeTeamWorkspace, snapshotMemberWork, TeamError } from "./team-workspace.js";
import { activeMember, digest, filesystemEntryExists, type TeamKernel, teamRunDirectory } from "./team-kernel.js";
import type { RetentionState, Stored, TeamServiceOptions } from "./teams.js";
import { MemberTraces, removeMemberTraces, type TraceSettlementHost } from "./member-traces.js";

/**
 * What the retention class uses of TeamService: part of the kernel, and the record, event and publication members it
 * shares with the rest of the service. teams.ts builds it in `retentionHost`; every member reads the service at the
 * time of use.
 */
export type RetentionHost = Pick<TeamKernel, "records" | "commands" | "manager" | "config" | "closed" | "save" | "event" | "record" | "enqueue" | "assertRunPath"> & {
  /** The record, refused as not found for a replay run (team-replay.ts). */
  visible(id: string): Stored;
  readonly options: TeamServiceOptions | undefined;
  readonly directory: string;
  readonly recorders: Map<string, unknown>;
  readonly entryBacklog: Set<string>;
  readonly evidence: EvidenceStore | undefined;
  view(stored: Stored): TeamView;
  emit(stored: Stored, kind: string, keyParts: readonly (string | number)[], ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void;
  flushOutbox(stored: Stored, afterGap?: boolean): boolean;
  persistRetiredRunId(id: string): void;
  retentionNow(): string;
  retentionState(stored: Stored): RetentionState;
  publicationTarget(stored: Stored): { repository: string; remoteUrl: string } | undefined;
  needsPublication(stored: Stored): boolean;
  startPublication(stored: Stored): boolean;
  refreshOperationCensus(stored: Stored, force?: boolean): Promise<NonNullable<Stored["census"]>["state"] | undefined>;
  closeStaleBlockedRun(stored: Stored, hours: number): Promise<void>;
};

/** How long a failed workspace removal waits before the scheduler tries it again. */
const REMOVAL_RETRY_MS = 5 * 60_000;
/** A run's record waits at most this long for its events to reach the evidence store before retention removes it. */
const EVIDENCE_WAIT_MS = 24 * 3600_000;
function pathStrictlyInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Retention of settled team runs: the pass the scheduler runs on every tick, the owner's removeRun, the removal of
 * workspaces and records outside the mutation queue, and the save of unfinished member work to GitHub before a
 * removal. Moved from TeamService unchanged. TeamService holds one instance.
 */
export class TeamRetention {
  readonly removingRuns = new Set<string>();
  readonly removalTasks = new Set<Promise<void>>();
  private readonly memberWorkSaveRuns = new Set<string>();
  readonly memberWorkSaveTasks = new Set<Promise<void>>();
  readonly memberWorkSaveControllers = new Map<string, AbortController>();
  private readonly removalWaiters: Array<() => void> = [];
  private activeRemovals = 0;
  private readonly traces = new MemberTraces();
  constructor(private readonly host: RetentionHost) {}
  private traceHost(): TraceSettlementHost {
    const { manager } = this.host;
    return {
      stateDir: this.host.config.stateDir,
      now: () => this.host.options?.now?.() ?? Date.now(),
      // A session has exited when it says so. Missing metadata counts as an exit only when the worker cannot be reached
      // either: a session that still answers as live is live, whatever its metadata.
      exited: async sessionId => {
        const status = (await manager.state(sessionId)).status;
        if (status === "exited") return true;
        if (status !== "unavailable") return false;
        try { manager.meta(sessionId); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
      },
    };
  }
  private teamRoot(stored: Stored) {
    const root = stored.root ?? this.host.config.teams?.workspaceDir;
    if (!root) throw new TeamError(409, "invalid-workspace", "The team workspace is outside its configured root.");
    return stored.anchor ? ensureHostDirectory(stored.anchor, root, 0o750, false) : ensureDefaultTeamRoot(root, false);
  }
  private ownerPreventsRemoval(run: TeamRun) {
    return Boolean(run.goal || run.missionId || run.handoff) && (this.host.options?.ownerActive?.(run) ?? true);
  }
  private hasPendingPreparationFrom(stored: Stored) {
    const runDirectory = teamRunDirectory(stored.run.workspace);
    for (const candidate of this.host.records.values()) {
      if (candidate.run.id === stored.run.id || candidate.pending?.kind !== "prepare" || !candidate.source?.path) continue;
      if (pathStrictlyInside(runDirectory, candidate.source.path)) return true;
    }
    return false;
  }
  private assertRunRetentionSafe(stored: Stored) {
    if (this.ownerPreventsRemoval(stored.run))
      throw new TeamError(409, "team-retained", "A live goal, mission or handoff still uses this run as its source; it is removed when that owner finishes.");
    if (this.hasPendingPreparationFrom(stored))
      throw new TeamError(409, "team-in-use", "Another run is preparing from this run's workspace; retry removal after preparation settles.");
  }
  private memberWorkDone(run: TeamRun, member: TeamMember) {
    const saved = member.savedWork;
    return saved?.revision === run.revision && ["published", "nothing-to-save", "gave-up"].includes(saved.state);
  }
  /** Pending member clones are grouped by path so a shared clone is snapshotted only once. */
  private memberWorkGroups(stored: Stored) {
    const { run } = stored;
    if (!["cancelled", "blocked"].includes(run.status) || run.workspaceRemovedAt || !this.host.publicationTarget(stored)) return [];
    const groups = new Map<string, TeamMember[]>();
    for (const member of run.members) {
      if (member.cwd === run.workspace || member.workspaceRemovedAt || !filesystemEntryExists(member.cwd) || this.memberWorkDone(run, member)) continue;
      const members = groups.get(member.cwd) ?? [];
      members.push(member);
      groups.set(member.cwd, members);
    }
    return [...groups].map(([cwd, members]) => ({ cwd, members }));
  }
  private needsMemberWorkSaved(stored: Stored) {
    return this.memberWorkGroups(stored).length > 0;
  }
  private memberWorkRetryDue(stored: Stored, now: number) {
    return this.memberWorkGroups(stored).some(group => group.members.some(member => {
      const saved = member.savedWork;
      return saved?.state === "retrying" && (saved.revision !== stored.run.revision || Boolean(saved.failure && now >= Date.parse(saved.failure.retryAt)));
    }));
  }
  private recordMemberWork(stored: Stored, member: TeamMember, savedWork: NonNullable<TeamMember["savedWork"]>, eventText?: string, additionalEventText?: string) {
    return this.host.enqueue(() => {
      if (this.host.records.get(stored.run.id) !== stored) return;
      const previous = member.savedWork, previousEvents = stored.run.events.slice();
      member.savedWork = savedWork;
      if (eventText && !stored.run.events.some(event => event.text === eventText)) this.host.event(stored, eventText);
      if (additionalEventText && !stored.run.events.some(event => event.text === additionalEventText)) this.host.event(stored, additionalEventText);
      try { this.host.save(stored); }
      catch (error) {
        member.savedWork = previous;
        stored.run.events = previousEvents;
        throw error;
      }
    });
  }
  /** Snapshot and publish eligible member clones without holding the mutation queue during Git work. */
  startMemberWorkSave(stored: Stored) {
    const { run } = stored, target = this.host.publicationTarget(stored);
    if (this.host.closed || !target || !this.needsMemberWorkSaved(stored) || this.memberWorkSaveRuns.has(run.id)) return false;
    const now = this.host.options?.now?.() ?? Date.now();
    const groups = this.memberWorkGroups(stored).map(group => ({ ...group, members: group.members.filter(member => {
      const saved = member.savedWork;
      return !saved?.failure || saved.revision !== run.revision || now >= Date.parse(saved.failure.retryAt);
    }) })).filter(group => group.members.length > 0);
    if (!groups.length) return false;
    const id = run.id, revision = run.revision, runBranch = run.branch, controller = new AbortController();
    this.memberWorkSaveRuns.add(id);
    this.memberWorkSaveControllers.set(id, controller);
    const grantEnv = (member: TeamMember, ref: string) => hostGithubGrantEnvironment(this.host.config, {
      sid: `save-member-work:${id}:${member.memberId}`, project: run.projectId, repo: target.repository, ops: ["push"], refs: [ref],
    });
    let task: Promise<void>;
    task = (async () => {
      for (const group of groups) {
        const representative = group.members.find(member => this.memberIntegratedAt(stored, member) === undefined) ?? group.members[0]!;
        let snapshot: Awaited<ReturnType<typeof snapshotMemberWork>> | undefined;
        let snapshotFailed = false;
        try {
          snapshot = await snapshotMemberWork(group.cwd, representative.baseCommit,
            { skipIfResultTree: this.memberIntegratedAt(stored, representative) !== undefined }, this.host.config.teams?.commandPrefix, controller.signal,
            this.host.options?.memberWorkCommandTimeoutMs ?? 30000, this.host.options?.memberWorkCommandStopGraceMs ?? 2000);
        } catch {
          snapshotFailed = true;
        }
        if (controller.signal.aborted) return;
        for (const member of group.members) {
          if (this.memberWorkDone(run, member)) continue;
          const currentNow = this.host.options?.now?.() ?? Date.now();
          if (member.savedWork?.failure && member.savedWork.revision === revision && currentNow < Date.parse(member.savedWork.failure.retryAt)) continue;
          if (snapshotFailed) {
            await this.recordMemberWorkFailure(stored, member, revision, target.repository, `${runBranch}-wip-${member.memberId}`, undefined, "other");
            continue;
          }
          if (!snapshot) {
            await this.recordMemberWork(stored, member, { revision, state: "nothing-to-save", at: this.host.retentionNow() });
            continue;
          }
          const primaryBranch = `${runBranch}-wip-${member.memberId}`;
          if (!snapshot.commit) {
            if (snapshot.nestedRepository) {
              const nestedEvent = `Member ${member.memberId} has changes inside a nested repository or submodule that the host cannot save to GitHub. The workspace will be removed after the remaining attempts unless the owner saves the work.`;
              await this.recordMemberWorkFailure(stored, member, revision, target.repository, primaryBranch, undefined, "nested-repository", nestedEvent);
            } else await this.recordMemberWork(stored, member, { revision, state: "nothing-to-save", at: this.host.retentionNow() });
            continue;
          }
          let branch = primaryBranch;
          let outcome: Awaited<ReturnType<typeof publishTeamHead>>;
          try {
            outcome = await publishTeamHead(group.cwd, target.remoteUrl, snapshot.commit, branch, this.host.config.teams?.commandPrefix, controller.signal,
              ref => grantEnv(member, ref), this.host.options?.memberWorkPushTimeoutMs ?? 120000, this.host.options?.memberWorkCommandStopGraceMs ?? 2000);
            if (!outcome.published && outcome.category === "rejected") {
              branch = `${primaryBranch}-${snapshot.commit.slice(0, 8)}`;
              outcome = await publishTeamHead(group.cwd, target.remoteUrl, snapshot.commit, branch, this.host.config.teams?.commandPrefix, controller.signal,
                ref => grantEnv(member, ref), this.host.options?.memberWorkPushTimeoutMs ?? 120000, this.host.options?.memberWorkCommandStopGraceMs ?? 2000);
            }
          } catch {
            outcome = { published: false, category: "other" };
          }
          if (controller.signal.aborted) return;
          if (snapshot.nestedRepository) {
            const nestedEvent = `Member ${member.memberId} has changes inside a nested repository or submodule that the host cannot save to GitHub. The workspace will be removed after the remaining attempts unless the owner saves the work.`;
            await this.recordMemberWorkFailure(stored, member, revision, target.repository, branch, snapshot.commit, "nested-repository", nestedEvent);
            continue;
          }
          if (outcome.published) {
            const eventText = `Saved unfinished work of member ${member.memberId} as ${snapshot.commit.slice(0, 12)} to GitHub ${target.repository} ${branch} before its workspace is removed.`;
            await this.recordMemberWork(stored, member, { revision, state: "published", repository: target.repository, branch, commit: snapshot.commit, at: this.host.retentionNow() }, eventText);
          } else await this.recordMemberWorkFailure(stored, member, revision, target.repository, branch, snapshot.commit, outcome.category);
        }
      }
    })().catch(() => {
      console.warn("Could not record the result of a background team member work save.");
    }).finally(() => {
      this.memberWorkSaveRuns.delete(id);
      this.memberWorkSaveControllers.delete(id);
      this.memberWorkSaveTasks.delete(task);
    });
    this.memberWorkSaveTasks.add(task);
    return true;
  }
  private recordMemberWorkFailure(stored: Stored, member: TeamMember, revision: number, repository: string, branch: string, commit: string | undefined, category: TeamPublicationCategory, additionalEventText?: string) {
    const previous = member.savedWork?.revision === revision ? member.savedWork : undefined;
    const attempts = previous?.failure?.attempts ? previous.failure.attempts + 1 : 1;
    const state = attempts >= 5 ? "gave-up" : "retrying";
    const at = this.host.retentionNow();
    const retryAt = new Date(Date.parse(at) + 60_000 * 2 ** (attempts - 1)).toISOString();
    const failure = { category, attempts, at, retryAt };
    const eventText = state === "gave-up"
      ? `Could not save unfinished work of member ${member.memberId} to GitHub after 5 attempts (${category}); its workspace is removed with the run.`
      : `Could not save unfinished work of member ${member.memberId} to GitHub (${category}); the host retries before removing the workspace.`;
    return this.recordMemberWork(stored, member, { revision, state, repository, branch, ...(commit ? { commit } : {}), at, failure }, eventText, additionalEventText);
  }
  private async withRemovalSlot<T>(operation: () => Promise<T>) {
    if (this.activeRemovals >= 2) await new Promise<void>(resolve => this.removalWaiters.push(resolve));
    else this.activeRemovals++;
    try { return await operation(); }
    finally {
      const next = this.removalWaiters.shift();
      if (next) next();
      else this.activeRemovals--;
    }
  }
  /** Filesystem cleanup runs outside the serialized team mutation queue; only its result is enqueued. */
  private removeOutsideQueue(stored: Stored, remove: () => Promise<unknown>, completed: (result: unknown) => void | Promise<void>, failed: (error: unknown) => void | Promise<void>) {
    const id = stored.run.id;
    if (this.removingRuns.has(id)) return false;
    this.removingRuns.add(id);
    let task: Promise<void>;
    task = (async () => {
      let didFail = false, failure: unknown, result: unknown;
      try { result = await this.withRemovalSlot(remove); }
      catch (error) { didFail = true; failure = error; }
      try { await this.host.enqueue(() => didFail ? failed(failure) : completed(result)); }
      catch (error) { console.warn("Could not record the result of a background team workspace removal.", error); }
      finally { this.removingRuns.delete(id); }
    })().finally(() => this.removalTasks.delete(task));
    this.removalTasks.add(task);
    return true;
  }
  async deleteRecord(stored: Stored, waitForEvidence: boolean) {
    const finalView = this.host.view(stored);
    if (this.host.options?.events) {
      this.host.emit(stored, "run.deleted", [], {}, { status: stored.run.status });
      const flushed = this.host.flushOutbox(stored);
      const advanced = this.host.options.events.advance();
      // A blocked projector cannot catch up without a repair, so it does not hold the deletion.
      if (!flushed || advanced.pending && advanced.blocked.length === 0) {
        const retention = this.host.retentionState(stored);
        retention.evidenceHeldAt ??= this.host.retentionNow();
        const heldFor = (this.host.options.now?.() ?? Date.now()) - Date.parse(retention.evidenceHeldAt);
        if (waitForEvidence && heldFor < EVIDENCE_WAIT_MS)
          throw new TeamError(503, "team-evidence-pending", "The team's run events are not yet in the evidence store; its record is kept until they are stored.");
        console.warn("Run events for a removed team were not stored; its record is removed anyway.");
      }
    }
    try { if (!stored.run.replay) this.host.persistRetiredRunId(stored.run.id); }
    catch { throw new TeamError(500, "team-record-removal-failed", "The settled team's deletion tombstone could not be saved; its record was kept."); }
    try { await removeMemberTraces(this.host.config.stateDir, stored.run.id); }
    catch { throw new TeamError(500, "team-record-removal-failed", "The settled team's member traces could not be removed; its record was kept."); }
    try { await rmAsync(join(this.host.directory, `${stored.run.id}.sealed`), { force: true }); }
    catch { throw new TeamError(500, "team-record-removal-failed", "The settled team's record could not be removed."); }
    this.host.commands.get(stored.run.id)?.abort();
    this.host.commands.delete(stored.run.id);
    this.host.records.delete(stored.run.id);
    this.host.recorders.delete(stored.run.id);
    this.host.entryBacklog.delete(stored.run.id);
    // deleteRun never throws. A failed delete is repeated by the hourly sweep, so the removal does not wait on it.
    this.host.evidence?.deleteRun(stored.run.id);
    return finalView;
  }
  removeRun(id: string): Promise<TeamView> {
    return this.host.enqueue(async () => {
      const stored = this.host.visible(id), run = stored.run;
      if (this.host.needsPublication(stored)) throw new TeamError(409, "head-not-published", "The integrated head must be published to GitHub before this run can be removed.");
      if (this.removingRuns.has(id)) throw new TeamError(409, "team-operation-running", "A background workspace removal is still running. Retry deletion after it settles.");
      this.assertRunRetentionSafe(stored);
      if (!(["cancelled", "merged", "no-change"].includes(run.status) && await this.membersSettled(stored)))
        throw new TeamError(409, "team-active", "Only a settled cancelled, merged or no-change run can be removed.");
      if (this.needsMemberWorkSaved(stored)) {
        this.startMemberWorkSave(stored);
        throw new TeamError(409, "member-work-not-saved", "Unfinished member work is being saved to GitHub before this run's workspaces are removed. Retry removal shortly.");
      }
      if (!run.workspaceRemovedAt || filesystemEntryExists(teamRunDirectory(run.workspace))) {
        this.host.assertRunPath(stored, run.workspace);
        await removeTeamWorkspace(teamRunDirectory(run.workspace), this.host.config.teams?.commandPrefix, undefined, this.teamRoot(stored));
        run.workspaceRemovedAt ??= this.host.retentionNow();
        for (const member of run.members) member.workspaceRemovedAt ??= run.workspaceRemovedAt;
        this.host.event(stored, "Workspaces removed by the owner through removeRun after the run settled.");
        this.host.save(stored);
      }
      return this.deleteRecord(stored, false);
    });
  }
  /** `operationEnded` lifts the fence of an interrupted operation. Only the retention gate passes it, and it then closes the run only after a look taken in the same pass found none of the operation's processes. */
  private async membersSettled(stored: Stored, operationEnded = false) {
    const { run } = stored;
    if (this.host.commands.has(run.id)) return false;
    // A terminal run's interrupted operation is never replayed, so it does not keep the run's clones alive.
    if (stored.pending && !["cancelled", "merged", "no-change"].includes(run.status) && !operationEnded) return false;
    for (const member of run.members) {
      if (member.status === "stopped") continue;
      // Whatever the recorded member status, a session that has exited or no longer exists has nothing left to stop.
      // A deleted session can still answer state() from its saved status file, so existence is checked first.
      try { this.host.manager.meta(member.sessionId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; }
      try { if ((await this.host.manager.state(member.sessionId)).status !== "exited") return false; }
      catch { continue; }
      // An exited process can precede the halt pass that records its owner stop. Keep that event's record alive.
      if (stored.halt === "cancel" && activeMember(member)) return false;
    }
    return true;
  }
  private memberIntegratedAt(stored: Stored, member: TeamMember) {
    if (member.status !== "stopped" || member.report?.kind !== "result") return undefined;
    const retention = this.host.retentionState(stored), existing = retention.integratedAt[member.memberId];
    if (existing) return existing;
    const integratedTask = member.role === "implementer" && stored.run.tasks.some(task => task.id === member.taskId && task.memberId === member.memberId && task.status === "integrated");
    const integratedEvent = [...stored.run.events].reverse().find(event => event.text === `${member.title} reported a result; its validated changes were integrated.`);
    if (!integratedTask && !(member.role === "integrator" && integratedEvent)) return undefined;
    const at = integratedEvent?.at ?? member.exitConfirmedAt ?? stored.run.updatedAt ?? stored.run.createdAt;
    retention.integratedAt[member.memberId] = at;
    return at;
  }
  private async reportRemovalFailure(stored: Stored, scope: string, error: unknown) {
    const retention = this.host.retentionState(stored);
    (retention.retryAt ??= {})[scope] = new Date((this.host.options?.now?.() ?? Date.now()) + REMOVAL_RETRY_MS).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException)?.code ?? (error as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
    const fingerprint = digest({ code, message });
    const seen = (retention.removalErrors[scope] ??= []);
    if (seen.includes(fingerprint)) return;
    const previousEvents = stored.run.events.slice();
    seen.push(fingerprint);
    this.host.event(stored, `Workspace removal under the retention policy failed (failure ${fingerprint.slice(0, 12)}); the host will retry. See docs/teams.md.`);
    try { this.host.save(stored); }
    catch (saveError) {
      seen.pop();
      stored.run.events = previousEvents;
      console.warn("Could not record a team workspace retention failure.", saveError);
    }
  }
  /** A failed removal waits out its backoff before the scheduler launches it again. */
  private removalBackoffActive(retention: RetentionState, scope: string, now: number) {
    const retryAt = retention.retryAt?.[scope];
    return retryAt !== undefined && now < Date.parse(retryAt);
  }
  /** Removes a cancelled run's record under the retention policy, unless the last attempt failed within its backoff. */
  private async removeRetainedRecord(stored: Stored) {
    if (this.removalBackoffActive(this.host.retentionState(stored), "record", this.host.options?.now?.() ?? Date.now())) return;
    try { await this.deleteRecord(stored, true); }
    catch (error) { await this.reportRemovalFailure(stored, "record", error); }
  }
  async retire(stored: Stored) {
    // Trace caps apply to replay runs too, and to traces recorded before the setting was turned off. The measurement
    // runs in the background, where idle() waits for it.
    const traces = this.traces.settle(stored.run, this.traceHost());
    if (traces) { this.removalTasks.add(traces); void traces.finally(() => this.removalTasks.delete(traces)); }
    if (stored.run.replay) return;
    try {
      const { run } = stored, retention = this.host.retentionState(stored), policy = this.host.config.teams?.retention ?? DEFAULT_TEAM_RETENTION;
      if (run.status === "blocked" || run.status === "paused") await this.host.refreshOperationCensus(stored);
      // A run a live goal, mission or handoff still retains is left alone, so it is never closed underneath its owner.
      if (this.removingRuns.has(run.id) || this.ownerPreventsRemoval(run) || this.hasPendingPreparationFrom(stored)) return;
      const statusAtStart = run.status;
      const runDirectory = teamRunDirectory(run.workspace);
      const now = this.host.options?.now?.() ?? Date.now();
      const elapsed = Math.max(0, now - Date.parse(retention.statusAt));
      const retentionMs = run.status === "merged" || run.status === "no-change" ? policy.finishedMinutes * 60000
        : run.status === "cancelled" ? policy.cancelledMinutes * 60000
          : run.status === "ready-for-review" ? policy.reviewHours * 3600000
            : run.status === "blocked" ? policy.blockedHours * 3600000 : undefined;
      const removeRunInBackground = (startedAt: string) => this.removeOutsideQueue(stored,
        () => removeTeamWorkspace(runDirectory, this.host.config.teams?.commandPrefix, undefined, this.teamRoot(stored)),
        async () => {
          if (this.host.records.get(run.id) !== stored) return;
          for (const member of run.members) member.workspaceRemovedAt ??= startedAt;
          if (!run.events.some(event => event.text.startsWith("Workspaces removed under the retention policy after this ")))
            this.host.event(stored, `Workspaces removed under the retention policy after this ${run.status} run settled. See docs/teams.md.`);
          try { this.host.save(stored); } catch (error) { console.warn("Could not persist a removed team workspace marker.", error); }
          if (run.status === "cancelled" && !run.goal && !run.missionId && !this.ownerPreventsRemoval(run) && !this.hasPendingPreparationFrom(stored) && await this.membersSettled(stored))
            await this.removeRetainedRecord(stored);
        },
        async error => {
          if (this.host.records.get(run.id) !== stored) return;
          // The removal intent stays durable: a partially removed tree must never be resumed, and a later tick retries while the directory exists.
          await this.reportRemovalFailure(stored, "workspaces", error);
        });

      if (!run.workspaceRemovedAt && !["cancelled", "merged", "no-change", "ready-for-review", "blocked"].includes(run.status)) {
        const memberRetentionMs = policy.memberMinutes * 60000;
        for (const member of run.members) {
          const anotherMemberSharesWorkspace = run.members.some(candidate => candidate !== member && candidate.cwd === member.cwd);
          if (stored.pending?.source?.cwd === member.cwd || anotherMemberSharesWorkspace) continue;
          if (!member.workspaceRemovedAt) {
            const integratedAt = this.memberIntegratedAt(stored, member);
            if (!integratedAt || now - Date.parse(integratedAt) < memberRetentionMs) continue;
            if (!filesystemEntryExists(member.cwd)) {
              member.workspaceRemovedAt = this.host.retentionNow();
              try { this.host.save(stored); }
              catch (error) { member.workspaceRemovedAt = undefined; console.warn("Could not persist a missing member workspace marker.", error); }
              continue;
            }
            member.workspaceRemovedAt = this.host.retentionNow();
            const previousEvents = run.events.slice();
            this.host.event(stored, "Member workspace removal under the retention policy started.");
            try { this.host.save(stored); }
            catch (error) {
              member.workspaceRemovedAt = undefined;
              run.events = previousEvents;
              console.warn("Could not persist a started member workspace removal.", error);
              continue;
            }
          } else if (!filesystemEntryExists(member.cwd) || this.removalBackoffActive(retention, `member:${member.memberId}`, now)) {
            continue;
          }
          this.removeOutsideQueue(stored,
            () => removeMemberWorkspace(runDirectory, member.cwd, this.host.config.teams?.commandPrefix, undefined, this.teamRoot(stored)),
            async removed => {
              if (this.host.records.get(run.id) !== stored) return;
              const removedEvent = `Member workspace removed under the retention policy after its integrated result was consumed (member ${member.memberId}). See docs/teams.md.`;
              if (removed && !run.events.some(event => event.text === removedEvent)) this.host.event(stored, removedEvent);
              try { this.host.save(stored); } catch (error) { console.warn("Could not persist a removed member workspace marker.", error); }
            },
            async error => {
              if (this.host.records.get(run.id) !== stored) return;
              // Keep the member's removal marker: the clone may be partially removed and is retried while it exists.
              await this.reportRemovalFailure(stored, `member:${member.memberId}`, error);
            });
          return;
        }
      }

      if (this.host.needsPublication(stored)) this.host.startPublication(stored);
      if (run.workspaceRemovedAt) {
        if (filesystemEntryExists(runDirectory)) {
          if (!this.removalBackoffActive(retention, "workspaces", now)) removeRunInBackground(run.workspaceRemovedAt);
          return;
        }
        let completionChanged = false;
        for (const member of run.members) if (!member.workspaceRemovedAt) {
          member.workspaceRemovedAt = run.workspaceRemovedAt;
          completionChanged = true;
        }
        const started = run.events.some(event => event.text === "Workspace removal under the retention policy started.");
        const completed = run.events.some(event => event.text.startsWith("Workspaces removed under the retention policy after this "));
        if (started && !completed) {
          this.host.event(stored, `Workspaces removed under the retention policy after this ${run.status} run settled. See docs/teams.md.`);
          completionChanged = true;
        }
        if (completionChanged) try { this.host.save(stored); } catch (error) { console.warn("Could not persist a completed team workspace removal.", error); }
        if (run.status === "blocked") await this.host.closeStaleBlockedRun(stored, policy.blockedHours);
        if (statusAtStart === "cancelled" && run.status === "cancelled" && !run.goal && !run.missionId && retentionMs !== undefined && elapsed >= retentionMs && await this.membersSettled(stored))
          await this.removeRetainedRecord(stored);
        return;
      }
      const retentionDue = retentionMs !== undefined && elapsed >= retentionMs;
      const retryDue = this.memberWorkRetryDue(stored, now);
      if (!retentionDue && !retryDue) return;
      // An interrupted operation keeps its fence unless the host looks now and finds none of its processes. Without a
      // witness the fence stays. This pass runs on every tick, so the look comes last and only confirms: a look that
      // found a process, or could not finish, stands until the next scheduled one above.
      const witnessed = run.status === "blocked" && Boolean(stored.pending?.witness);
      if (!(await this.membersSettled(stored, witnessed))) return;
      if (this.host.needsPublication(stored)) { this.host.startPublication(stored); return; }
      if (witnessed && stored.pending) {
        const last = stored.census?.pendingId === stored.pending.id ? stored.census : undefined;
        if (last && last.state !== "ended") return;
        if (await this.host.refreshOperationCensus(stored, true) !== "ended") return;
        if (run.status !== "blocked" || this.host.commands.has(run.id) || this.removingRuns.has(run.id)) return;
      }
      if (this.needsMemberWorkSaved(stored)) { this.startMemberWorkSave(stored); return; }
      if (!retentionDue) return;
      run.workspaceRemovedAt = this.host.retentionNow();
      // The key names the fact, not the time, so a retried removal stores the same event once.
      const settledKey = runEventKey("run.settled", run.id, [run.revision, "blocked", "workspace-removed"]);
      if (run.status === "blocked") this.host.emit(stored, "run.settled", [run.revision, "blocked", "workspace-removed"], {}, { status: "blocked", summary: runSummaryCounts(run) });
      const startedAt = run.workspaceRemovedAt, previousEvents = run.events.slice();
      this.host.event(stored, "Workspace removal under the retention policy started.");
      try { this.host.save(stored); }
      catch (error) {
        run.workspaceRemovedAt = undefined;
        run.events = previousEvents;
        if (stored.outbox) stored.outbox = stored.outbox.filter(event => event.key !== settledKey);
        console.warn("Could not persist a started team workspace removal.", error);
        return;
      }
      removeRunInBackground(startedAt);
    } catch (error) {
      console.warn("Team workspace retention could not be evaluated; the run was left unchanged.", error);
    }
  }
}
