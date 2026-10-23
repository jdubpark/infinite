import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialAttention } from "@infinite/attention";
import type { Manager } from "../../packages/host/src/manager.js";
import type { Config, WorkerState } from "../../packages/host/src/types.js";
import type { TeamRun } from "../../packages/host/src/team-types.js";
import { TeamService } from "../../packages/host/src/teams.js";
import { Journal, readEvents, unseal, writeSealed } from "../../packages/host/src/vault.js";

/** Real scheduler records and journal, with the worker RPC boundary controlled by the test. */
export function schedulerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "infinite-scheduler-")));
  const key = randomBytes(32), id = randomUUID(), sessionId = randomUUID();
  const workspaceDir = join(root, "teams"), workspace = join(workspaceDir, id, "integration");
  mkdirSync(workspace, { recursive: true, mode: 0o750 });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8", stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "--initial-branch=main");
  git("-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Scheduler fixture");
  const baseCommit = git("rev-parse", "HEAD"), at = new Date().toISOString();
  const quietAt = new Date(Date.now() - 6 * 60000).toISOString();
  const run: TeamRun = { id, projectId: "fixture", provider: "demo", title: "Inspect the fixture", objective: "Ask before choosing work",
    parallelism: 1, revision: 1, status: "planning", createdAt: at, updatedAt: at, workspace, branch: "main", baseCommit,
    tasks: [], decisions: [], checks: [], steering: [], events: [], round: 0,
    members: [{ runId: id, memberId: randomUUID(), revision: 1, role: "project-manager", sessionId, title: "Coordinator",
      status: "running", cwd: workspace, baseCommit, prompt: "Inspect and report", cursor: 0, stopRequestId: randomUUID(), startedAt: quietAt }],
  };
  const config: Config = { stateDir: join(root, "state"), runDir: join(root, "run"), keyFile: join(root, "key"),
    port: 0, origin: "http://127.0.0.1", tokens: [], environment: "local", enableDemo: true, maxSessions: 4,
    projects: [{ id: "fixture", name: "Fixture", path: workspace }], agents: {}, teams: { workspaceDir, stallMinutes: 5 } };
  const journal = new Journal(join(config.stateDir, "events"), key, sessionId);
  const state: WorkerState = { status: "running", seq: 0, screen: "", attention: initialAttention(quietAt, true) };
  let reads = 0;
  const manager = {
    list: async () => [],
    meta: (requestedId: string) => {
      if (requestedId === sessionId) return {};
      throw Object.assign(new Error("Session metadata is unavailable."), { code: "ENOENT" });
    },
    state: async () => structuredClone({ ...state, seq: journal.seq }),
    events: (requestedId: string, after: number, limit: number, types?: Set<string>) => {
      assert.equal(requestedId, sessionId);
      reads++;
      return readEvents(journal.directory, key, sessionId, after, limit, types);
    },
    stopTeamSession: async () => { state.status = "exited"; return manager.state(); },
  };
  function writeRecord(kind: "team" | "goal", recordId: string, value: unknown) {
    const directory = join(config.stateDir, `${kind}s`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeSealed(join(directory, `${recordId}.sealed`), key, `${kind}:${recordId}`, value);
  }
  function readRecord<T>(kind: "team" | "goal", recordId: string): T {
    return unseal<T>(key, `${kind}:${recordId}`, readFileSync(join(config.stateDir, `${kind}s`, `${recordId}.sealed`), "utf8"));
  }
  const services: TeamService[] = [];
  return { config, key, run, state, journal, manager, writeRecord, readRecord, reads: () => reads,
    blockRecordWrites: (kind: "team" | "goal", recordId: string) => {
      const file = join(config.stateDir, `${kind}s`, `${recordId}.sealed`), backup = `${file}.saved`;
      renameSync(file, backup); mkdirSync(file);
      return () => { rmdirSync(file); renameSync(backup, file); };
    },
    writeTeam: (extra: object = {}) => writeRecord("team", id, { run, prepared: true, fingerprint: "fixture", receipts: {}, ...extra }),
    openTeam: () => {
      const service = new TeamService(config, key, manager as unknown as Manager, (_project, start) => start());
      services.push(service); return service;
    },
    close: () => { for (const service of services) service.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
