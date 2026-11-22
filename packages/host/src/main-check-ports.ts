import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MainCheckRecord } from "./main-check-state.js";
import { bootId, hostProcesses, type HostProcesses } from "./process-census.js";
import { assertTeamworkPath } from "./repo-enrollment.js";
import { volumeUsage, type VolumeUsage } from "./storage.js";
import type { TeamCommand } from "./team-types.js";
import { assertMemberReadOnly, prepareTeamWorkspaceFromMirror, prepareVerificationWorkspace, removeTeamWorkspace, teamCommand } from "./team-workspace.js";
import type { Config } from "./types.js";
import { unseal, writeSealed } from "./vault.js";

/** The halt as the main check reads it: `HaltService.check`. */
export type MainCheckHalt = { check(input: { projectId: string }): { state: string } };
/** The host load gate as the main check reads it: `HostLoadGate.held`. */
export type MainCheckHostLoad = { held(): string | undefined };
export type MainCheckTimer = unknown;

/** The sealed record files, one per project. */
export interface MainCheckRecords {
  /** Project ids that have a record file. */
  list(): string[];
  /** The unsealed value, or undefined when the project has no record file. Throws when a file exists and cannot be read or unsealed. */
  read(projectId: string): unknown;
  write(projectId: string, record: MainCheckRecord): void;
}

/**
 * Every side effect of the main check. The defaults call the real helpers; the simulator and later tests replace
 * them. The service calls nothing else that reads a clock, a file, a process or a random source.
 */
export interface MainCheckPorts {
  now(): number;
  setTimer(callback: () => void, ms: number): MainCheckTimer;
  clearTimer(timer: MainCheckTimer): void;
  records: MainCheckRecords;
  /** `prepareTeamWorkspaceFromMirror`; `teamwork` names a project teamwork root, which takes the sync home as its anchor. */
  prepareWorkspace(mirror: string, head: string, root: string, directoryName: string, branch: string, prefix: TeamCommand | undefined, signal: AbortSignal, teamwork: boolean): Promise<{ workspace: string; baseCommit: string }>;
  prepareVerification(workspace: string, id: string, baseCommit: string, prefix?: TeamCommand, signal?: AbortSignal): Promise<{ workspace: string; baseCommit: string }>;
  run: typeof teamCommand;
  assertClean: typeof assertMemberReadOnly;
  /** Process table, process start and census. */
  processes: HostProcesses;
  remove: typeof removeTeamWorkspace;
  halt: MainCheckHalt;
  hostLoad: MainCheckHostLoad;
  /** The usage of the volume that holds `root`, or of its nearest existing ancestor. */
  storage(root: string): Promise<VolumeUsage>;
  bootId(): string;
  /** `length` random lower-case hex characters. */
  randomHex(length: number): string;
  uuid(): string;
}

export const recordDirectory = (config: Config) => join(config.stateDir, "main-check");
export const recordScope = (projectId: string) => `main-check:${projectId}`;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function sealedRecords(config: Config, key: Buffer): MainCheckRecords {
  const directory = recordDirectory(config);
  const file = (projectId: string) => join(directory, `${projectId}.sealed`);
  return {
    list: () => {
      let names: string[];
      try { names = readdirSync(directory); } catch (error) { if (isMissing(error)) return []; throw error; }
      return names.flatMap(name => /^([a-z0-9-]+)\.sealed$/.exec(name)?.[1] ?? []);
    },
    read: projectId => {
      let raw: string;
      try { raw = readFileSync(file(projectId), "utf8"); } catch (error) { if (isMissing(error)) return undefined; throw error; }
      return unseal<unknown>(key, recordScope(projectId), raw);
    },
    write: (projectId, record) => writeSealed(file(projectId), key, recordScope(projectId), record),
  };
}

/** The usage of the nearest existing ancestor of `root`, as team creation measures it. */
async function teamVolume(root: string): Promise<VolumeUsage> {
  let sample = resolve(root);
  while (!existsSync(sample)) {
    const ancestor = dirname(sample);
    if (ancestor === sample) throw new Error("No ancestor of the team root exists.");
    sample = ancestor;
  }
  return volumeUsage(sample);
}

export function defaultMainCheckPorts(options: { config: Config; key: Buffer; halt: MainCheckHalt; hostLoad: MainCheckHostLoad }): MainCheckPorts {
  const { config } = options;
  return {
    now: () => Date.now(),
    setTimer: (callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return timer;
    },
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    records: sealedRecords(config, options.key),
    prepareWorkspace: async (mirror, head, root, directoryName, branch, prefix, signal, teamwork) => {
      // A teamwork root is checked and anchored at the sync home, as team creation does it.
      let anchor: string | undefined;
      if (teamwork) {
        assertTeamworkPath(config, root);
        anchor = realpathSync(config.sync?.homeDir ?? homedir());
      }
      return prepareTeamWorkspaceFromMirror(mirror, head, root, directoryName, branch, prefix, signal, anchor);
    },
    prepareVerification: prepareVerificationWorkspace,
    run: teamCommand,
    assertClean: assertMemberReadOnly,
    processes: hostProcesses,
    remove: removeTeamWorkspace,
    halt: options.halt,
    hostLoad: options.hostLoad,
    storage: teamVolume,
    bootId,
    randomHex: length => randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length),
    uuid: () => randomUUID(),
  };
}
