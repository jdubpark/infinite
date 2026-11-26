import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { MainCheckAnchors } from "./main-check-anchors.js";
import type { MainCheckRecord } from "./main-check-state.js";
import { bootId, hostProcesses, type HostProcesses } from "./process-census.js";
import { assertTeamworkPath } from "./repo-enrollment.js";
import { volumeUsage, type VolumeUsage } from "./storage.js";
import type { TeamCommand } from "./team-types.js";
import { assertMemberReadOnly, prepareTeamWorkspaceFromMirror, prepareVerificationWorkspace, removeTeamWorkspace, teamCommand } from "./team-workspace.js";
import type { Config } from "./types.js";
import { unseal, writeSealed } from "./vault.js";

export type MainCheckHalt = { check(input: { projectId: string }): { state: string } };
export type MainCheckHostLoad = { held(): string | undefined };
export type MainCheckTimer = unknown;

export interface MainCheckRecords {
  list(): string[];
  read(projectId: string): unknown;
  write(projectId: string, record: MainCheckRecord): void;
}

export interface MainCheckPorts {
  now(): number;
  setTimer(callback: () => void, ms: number): MainCheckTimer;
  clearTimer(timer: MainCheckTimer): void;
  records: MainCheckRecords;
  anchors: MainCheckAnchors;
  prepareWorkspace(mirror: string, head: string, root: string, directoryName: string, branch: string, prefix: TeamCommand | undefined, signal: AbortSignal, teamwork: boolean): Promise<{ workspace: string; baseCommit: string }>;
  prepareVerification(workspace: string, id: string, baseCommit: string, prefix?: TeamCommand, signal?: AbortSignal): Promise<{ workspace: string; baseCommit: string }>;
  run: typeof teamCommand;
  assertClean: typeof assertMemberReadOnly;
  processes: HostProcesses;
  remove: typeof removeTeamWorkspace;
  halt: MainCheckHalt;
  hostLoad: MainCheckHostLoad;
  storage(root: string): Promise<VolumeUsage>;
  bootId(): string;
  platform: NodeJS.Platform;
  randomHex(length: number): string;
  uuid(): string;
}

export const recordDirectory = (config: Config) => join(config.stateDir, "main-check");
export const recordScope = (projectId: string) => `main-check:${projectId}`;
export const anchorDirectory = (config: Config) => join(config.stateDir, "main-check-anchors");
export const anchorScope = (projectId: string, directory: string) => `main-check-anchor:${projectId}:${directory}`;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function sealedFiles(directory: string, key: Buffer) {
  const file = (name: string) => join(directory, `${name}.sealed`);
  return {
    list: () => {
      let names: string[];
      try { names = readdirSync(directory); } catch (error) { if (isMissing(error)) return []; throw error; }
      return names.flatMap(name => /^([a-z0-9-]+)\.sealed$/.exec(name)?.[1] ?? []);
    },
    read: (name: string, scope: string) => {
      let raw: string;
      try { raw = readFileSync(file(name), "utf8"); } catch (error) { if (isMissing(error)) return undefined; throw error; }
      return unseal<unknown>(key, scope, raw);
    },
    write: (name: string, scope: string, value: unknown) => writeSealed(file(name), key, scope, value),
    remove: (name: string) => rmSync(file(name), { force: true }),
  };
}

function sealedRecords(config: Config, key: Buffer): MainCheckRecords {
  const files = sealedFiles(recordDirectory(config), key);
  return {
    list: files.list,
    read: projectId => files.read(projectId, recordScope(projectId)),
    write: (projectId, record) => files.write(projectId, recordScope(projectId), record),
  };
}

function sealedAnchors(config: Config, key: Buffer): MainCheckAnchors {
  const files = sealedFiles(anchorDirectory(config), key);
  return {
    list: files.list,
    read: (projectId, directory) => files.read(directory, anchorScope(projectId, directory)),
    write: (projectId, directory, anchor) => files.write(directory, anchorScope(projectId, directory), anchor),
    remove: files.remove,
  };
}

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
    anchors: sealedAnchors(config, options.key),
    prepareWorkspace: async (mirror, head, root, directoryName, branch, prefix, signal, teamwork) => {
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
    platform: process.platform,
    randomHex: length => randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length),
    uuid: () => randomUUID(),
  };
}
