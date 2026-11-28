import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { GateOutcome, SearchState } from "./search-engine.js";
import type { SearchHost, SearchHolder, TeamSearchRuntime } from "./team-search-runtime.js";
import type { TeamCommand, TeamMember, TeamModelProfile, TeamReport, TeamRun, TeamTask } from "./team-types.js";
import type { Config, Provider } from "./types.js";
import type { Manager } from "./manager.js";
import { collectIntegrationData } from "./team-consumer.js";
import {
  assertMemberReadOnly,
  captureMemberResult,
  integrateMemberResult,
  prepareMemberWorkspace,
  prepareVerificationWorkspace,
  teamCommand,
  teamGitArgs,
  teamOperationCommand,
} from "./team-workspace.js";

export interface TeamSearchServiceAdapter {
  readonly config: Config;
  readonly manager: Manager;
  readonly closed: boolean;
  nowMs(): number;
  currentDate(): Date;
  limited(): ReadonlySet<Provider>;
  requiredChecks(run: TeamRun): readonly TeamCommand[] | undefined;
  prefixFor(run: TeamRun): TeamCommand | undefined;
  freeSessionSlots(): number;
  activeWorkerCount(run: TeamRun): number;
  enqueue(runId: string, task: () => void | Promise<void>): Promise<unknown>;
  save(holder: SearchHolder): void;
  event(holder: SearchHolder, text: string): void;
  block(holder: SearchHolder, error: unknown, sourceMember?: TeamMember): void;
  stopped(member: TeamMember): Promise<unknown>;
  assertRunPath(holder: SearchHolder, path: string): void;
  isPending(holder: SearchHolder): boolean;
  isHalted(holder: SearchHolder): boolean;
  isExploratoryStart?(run: TeamRun, task: TeamTask): boolean;
  operation<T>(
    holder: SearchHolder,
    kind: "result",
    perform: (signal: AbortSignal) => Promise<T>,
    complete: (value: T) => void,
    sourceMember?: TeamMember,
    sourceWorkspace?: "member" | "integration",
  ): void;
  pauseRun(holder: SearchHolder, reason: string): void;
  newMember(run: TeamRun, role: TeamMember["role"], cwd: string, baseCommit: string, taskId?: string, promptInput?: unknown, pinnedProfile?: TeamModelProfile): TeamMember;
  recordIntegrated(
    holder: SearchHolder,
    member: TeamMember,
    task: TeamTask,
    data: {
      commit: string;
      head: string;
      diff?: string;
      changes?: TeamRun["changes"];
      changedPaths?: { paths: string[]; truncated: boolean };
      reportSummary?: string;
      report?: Extract<TeamReport, { kind: "result" }>;
    },
  ): void;
  onReleaseResult(holder: SearchHolder, member: TeamMember): void;
  runtime(): TeamSearchRuntime;
}

export function createTeamSearchHost(adapter: TeamSearchServiceAdapter): SearchHost {
  const gateControllers = new Map<string, AbortController>();
  const challengerControllers = new Map<string, AbortController>();
  const runControllers = new Map<string, Set<AbortController>>();
  const deferredTimers = new Map<string, Set<NodeJS.Timeout>>();

  const track = (runId: string, controller: AbortController): (() => void) => {
    let set = runControllers.get(runId);
    if (!set) {
      set = new Set();
      runControllers.set(runId, set);
    }
    set.add(controller);
    return () => {
      set!.delete(controller);
      if (set!.size === 0) runControllers.delete(runId);
    };
  };

  const scheduleDeferred = (runId: string, fn: () => void) => {
    let timers = deferredTimers.get(runId);
    if (!timers) {
      timers = new Set();
      deferredTimers.set(runId, timers);
    }
    const timer = setTimeout(() => {
      timers!.delete(timer);
      if (timers!.size === 0) deferredTimers.delete(runId);
      if (adapter.closed) return;
      void adapter.enqueue(runId, () => {
        if (!adapter.closed) fn();
      }).catch(() => {});
    }, 50);
    timer.unref();
    timers.add(timer);
  };

  const abortRun = (runId: string) => {
    const controllers = runControllers.get(runId);
    if (controllers) {
      for (const controller of [...controllers]) controller.abort();
      runControllers.delete(runId);
    }
    const timers = deferredTimers.get(runId);
    if (timers) {
      for (const timer of timers) clearTimeout(timer);
      deferredTimers.delete(runId);
    }
  };

  const setupCommandFor = (run: TeamRun): TeamCommand | undefined => {
    const configured = run.handoff?.project ?? adapter.config.projects.find(project => project.id === run.projectId)?.team;
    return run.establishChecks ? run.verification?.setup : configured?.setup;
  };

  return {
    get config() { return adapter.config; },
    now: () => new Date(adapter.nowMs()).toISOString(),
    limited: () => adapter.limited(),
    requiredChecks: run => adapter.requiredChecks(run),
    freeSessionSlots: () => adapter.freeSessionSlots(),
    activeWorkerCount: run => adapter.activeWorkerCount(run),
    save: holder => adapter.save(holder),
    event: (holder, text) => adapter.event(holder, text),
    isExploratoryStart: adapter.isExploratoryStart ? (run, task) => adapter.isExploratoryStart!(run, task) : undefined,

    close() {
      for (const controller of gateControllers.values()) controller.abort();
      gateControllers.clear();
      for (const controller of challengerControllers.values()) controller.abort();
      challengerControllers.clear();
      for (const runId of [...runControllers.keys(), ...deferredTimers.keys()]) abortRun(runId);
    },

    runCheckCommand(holder, search, command, commit, memberId) {
      const controller = new AbortController();
      const untrack = track(holder.run.id, controller);
      const key = `${search.id}:${memberId ?? "base"}`;
      gateControllers.get(key)?.abort();
      gateControllers.set(key, controller);
      const run = holder.run;
      const started = adapter.nowMs();
      const timeoutMs = (adapter.config.teams?.checkMinutes ?? 60) * 60000;
      const prefix = adapter.prefixFor(run);
      const setup = setupCommandFor(run);

      void (async () => {
        let outcome: GateOutcome = "fail";
        let stage: "setup" | "command" = "setup";
        try {
          adapter.assertRunPath(holder, run.workspace);
          const verification = await prepareVerificationWorkspace(run.workspace, randomUUID(), commit, prefix, controller.signal);
          adapter.assertRunPath(holder, verification.workspace);
          if (setup) {
            const setupResult = await teamOperationCommand(setup, verification.workspace, controller.signal, timeoutMs, prefix);
            if (setupResult.interrupted) {
              outcome = "timeout";
            } else if (setupResult.exitCode !== 0) {
              outcome = "setup-failed";
            } else {
              if (!controller.signal.aborted) await assertMemberReadOnly(verification.workspace, commit, prefix, controller.signal, "setup");
              stage = "command";
            }
          } else {
            stage = "command";
          }
          if (stage === "command" && !controller.signal.aborted) {
            const result = await teamOperationCommand(command, verification.workspace, controller.signal, timeoutMs, prefix);
            outcome = result.interrupted ? "timeout" : result.exitCode === 0 ? "pass" : "fail";
            if (!controller.signal.aborted) await assertMemberReadOnly(verification.workspace, commit, prefix, controller.signal, "verification");
          }
        } catch {
          outcome = controller.signal.aborted ? "timeout" : stage === "setup" ? "setup-failed" : "fail";
        } finally {
          untrack();
          if (gateControllers.get(key) === controller) gateControllers.delete(key);
        }
        if (controller.signal.aborted || adapter.closed) return;
        const ms = Math.max(0, adapter.nowMs() - started);
        await adapter.enqueue(run.id, () => {
          if (!adapter.closed && !controller.signal.aborted) {
            adapter.runtime().onGateCompleted(holder, search.id, { outcome, ms, ...(memberId ? { memberId } : {}) });
          }
        });
      })().catch(() => {});
    },

    captureCandidate(holder, search, member, task) {
      const run = holder.run;
      const prefix = adapter.prefixFor(run);
      const controller = new AbortController();
      const untrack = track(run.id, controller);
      void (async () => {
        let scope: "ok" | "violation" = "ok";
        let commit = "";
        let tree = "";
        let empty = true;
        try {
          const captured = await captureMemberResult(member.cwd, member.baseCommit, task.paths, prefix, controller.signal);
          if (captured && !controller.signal.aborted) {
            const rev = await teamCommand({ command: "git", args: teamGitArgs(member.cwd, ["rev-parse", "--verify", `${captured}^{tree}`]) }, member.cwd, controller.signal, 30000, prefix);
            const resolvedTree = rev.exitCode === 0 && !rev.interrupted && !rev.truncated ? rev.stdout.trim() : "";
            if (!resolvedTree) {
              scope = "violation";
            } else {
              commit = captured;
              tree = resolvedTree;
              empty = false;
            }
          }
        } catch {
          scope = "violation";
        } finally {
          untrack();
        }
        if (controller.signal.aborted || adapter.closed) return;
        await adapter.enqueue(run.id, () => {
          if (!adapter.closed && !controller.signal.aborted) {
            adapter.runtime().onMemberCaptured(holder, search.id, { memberId: member.memberId, commit, tree, scope, empty });
          }
        });
      })().catch(() => {});
    },

    startChallengers(holder, search, task, launch, profiles, baseCommit) {
      const run = holder.run;
      const prefix = adapter.prefixFor(run);
      const launchKey = `${search.id}:${launch}`;
      const controller = new AbortController();
      const untrack = track(run.id, controller);
      challengerControllers.set(launchKey, controller);

      void (async () => {
        const prepared: { profile: TeamModelProfile; cwd: string }[] = [];
        const cleanupPrepared = async (extraPath?: string) => {
          if (run.replay) return;
          for (const item of prepared) await rm(item.cwd, { recursive: true, force: true }).catch(() => {});
          if (extraPath) await rm(extraPath, { recursive: true, force: true }).catch(() => {});
        };
        try {
          for (const profile of profiles) {
            if (controller.signal.aborted || adapter.closed) break;
            const dirId = randomUUID();
            const candidatePath = join(run.workspace, "..", "members", dirId);
            try {
              const cwd = run.replay
                ? run.workspace
                : await prepareMemberWorkspace(run.workspace, dirId, baseCommit, prefix, controller.signal);
              if (controller.signal.aborted || adapter.closed) {
                if (!run.replay) await rm(cwd, { recursive: true, force: true }).catch(() => {});
                break;
              }
              prepared.push({ profile, cwd });
            } catch {
              if (!run.replay) await rm(candidatePath, { recursive: true, force: true }).catch(() => {});
            }
          }
          if (controller.signal.aborted || adapter.closed) {
            await cleanupPrepared();
            return;
          }
          await adapter.enqueue(run.id, () => {
            if (adapter.closed || controller.signal.aborted) {
              void cleanupPrepared();
              return;
            }
            const challengers: { memberId: string; profileId: string }[] = [];
            for (const item of prepared) {
              try {
                if (!run.replay) adapter.assertRunPath(holder, item.cwd);
                const member = adapter.newMember(run, "implementer", item.cwd, baseCommit, task.id, undefined, item.profile);
                run.members.push(member);
                challengers.push({ memberId: member.memberId, profileId: item.profile.id });
              } catch {
                if (!run.replay) void rm(item.cwd, { recursive: true, force: true }).catch(() => {});
              }
            }
            adapter.runtime().dispatchEvent(holder, search.id, { kind: "started", launch, challengers });
          });
        } finally {
          untrack();
          if (challengerControllers.get(launchKey) === controller) challengerControllers.delete(launchKey);
        }
      })().catch(() => {});
    },

    cancelChallengerLaunch(_holder, search, launch) {
      const key = `${search.id}:${launch}`;
      challengerControllers.get(key)?.abort();
      challengerControllers.delete(key);
    },

    stopMember(holder, member, reason) {
      member.stoppedReason = reason;
      if (member.status === "queued") {
        member.status = "stopped";
        adapter.save(holder);
        return;
      }
      void (async () => {
        try {
          const exited = await adapter.stopped(member);
          if (!exited || adapter.closed) return;
          await adapter.enqueue(holder.run.id, () => {
            if (adapter.closed) return;
            member.status = "stopped";
            adapter.save(holder);
          });
        } catch {}
      })();
    },

    stopOperations(holder, search) {
      for (const [key, controller] of gateControllers.entries()) {
        if (key.startsWith(`${search.id}:`)) {
          controller.abort();
          gateControllers.delete(key);
        }
      }
      for (const [key, controller] of challengerControllers.entries()) {
        if (key.startsWith(`${search.id}:`)) {
          controller.abort();
          challengerControllers.delete(key);
        }
      }
      abortRun(holder.run.id);
    },

    integrateWinner(holder, search, member, task) {
      const contestant = search.contestants.find(item => item.memberId === member.memberId);
      const commit = contestant?.commit ?? "";
      const run = holder.run;
      if (!commit) return;
      const prefix = adapter.prefixFor(run);
      const controller = new AbortController();
      const untrack = track(run.id, controller);

      const runIntegration = () => {
        if (adapter.closed || controller.signal.aborted || adapter.isHalted(holder)) {
          untrack();
          return;
        }
        if (adapter.isPending(holder)) {
          scheduleDeferred(run.id, runIntegration);
          return;
        }
        run.status = "integrating";
        adapter.operation(holder, "result", async opSignal => {
          const combined = new AbortController();
          const abortCombined = () => combined.abort();
          opSignal.addEventListener("abort", abortCombined, { once: true });
          controller.signal.addEventListener("abort", abortCombined, { once: true });
          if (opSignal.aborted || controller.signal.aborted) combined.abort();
          try {
            const head = run.replay ? commit : await integrateMemberResult(run.workspace, member.cwd, commit, prefix, combined.signal);
            return await collectIntegrationData(run, member, commit, head, {
              hasTask: true,
              prefix,
              signal: combined.signal,
              at: new Date(adapter.nowMs()).toISOString(),
            });
          } finally {
            opSignal.removeEventListener("abort", abortCombined);
            controller.signal.removeEventListener("abort", abortCombined);
            untrack();
          }
        }, value => {
          adapter.recordIntegrated(holder, member, task, {
            ...value,
            ...(member.report?.kind === "result" ? { reportSummary: member.report.summary, report: member.report } : {}),
          });
        }, member, "integration");
      };
      runIntegration();
    },

    releaseChampion(holder, _search, member, task, state, reason) {
      adapter.event(holder, `Search ${state} (${reason}); continuing with primary task path for ${member.title}.`);
      if (member.report?.kind === "result") {
        const releaseResult = () => {
          if (adapter.closed || adapter.isHalted(holder)) return;
          if (task.status === "integrated") return;
          if (adapter.isPending(holder)) {
            scheduleDeferred(holder.run.id, releaseResult);
            return;
          }
          adapter.onReleaseResult(holder, member);
        };
        releaseResult();
        return;
      }
      if (!member.report && member.status === "stopped" && task.status === "running" && task.memberId === member.memberId && !adapter.isHalted(holder) && !reason.startsWith("champion-")) {
        task.status = "pending";
        delete task.memberId;
        adapter.save(holder);
      }
    },

    pauseForBrake(holder, reason) {
      adapter.pauseRun(holder, reason);
    },
  };
}
