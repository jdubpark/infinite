import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { stopSessionWorkers } from "./helpers.js";
import { Manager } from "../packages/host/src/manager.js";
import { TeamError, TeamService } from "../packages/host/src/teams.js";
import { MissionService, type ProjectGroupLookup } from "../packages/host/src/missions.js";
import type { Config } from "../packages/host/src/types.js";
import type { CreateMission } from "../packages/host/src/mission-types.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
export const lineup: TeamLineup = {
  coordinator: { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
  implementers: [{ id: "light", label: "Light worker", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
  integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
  reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
};

/** Real team and mission services over real session workers, with a two-repository project behind a fake group lookup. */
export function missionHarness(options?: { configure?: (config: Config) => void }) {
  const root = realpathSync(mkdtempSync("/tmp/inf-mission-"));
  const receipts = join(root, "receipts");
  mkdirSync(receipts, { mode: 0o700 });
  const repo = (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "check.mjs"), `import { existsSync } from "node:fs";\nif (!existsSync("${name}.txt")) process.exit(1);\n`);
    git(path, "init", "--initial-branch=main"); git(path, "add", "check.mjs");
    git(path, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", `Initial ${name}`);
    return path;
  };
  const api = repo("api"), web = repo("web");
  const key = randomBytes(32), keyFile = join(root, "key");
  writeFileSync(keyFile, key, { mode: 0o600 });
  const agent = (provider: string) => ({ command: process.execPath, args: [resolve("tests/fixtures/mission-agent.mjs"), "mission", receipts, provider] });
  const checks = [{ command: process.execPath, args: ["check.mjs"] }];
  const config: Config = { port: 0, origin: "http://127.0.0.1", keyFile, stateDir: join(root, "state"), runDir: join(root, "run"), tokens: [],
    environment: "local", enableDemo: true, maxSessions: 24, agents: { claude: agent("claude"), codex: agent("codex") },
    projects: [{ id: "api", name: "API", path: api, team: { checks } }, { id: "web", name: "Web", path: web, team: { checks } }],
    teams: { workspaceDir: join(root, "teams"), lineup } };
  options?.configure?.(config);
  const at = new Date().toISOString();
  const groups: ProjectGroupLookup = { get: id => {
    if (id !== "shop") throw new TeamError(404, "project-group-not-found", "This project does not exist.");
    return { id, name: "Shop", kind: "owner", hidden: false, implicit: false, revision: 1, createdAt: at, updatedAt: at,
      repos: [
        { projectId: "api", name: "API", path: api, checkouts: [{ projectId: "api", name: "API", path: api, primary: true, teamReady: true }] },
        { projectId: "web", name: "Web", path: web, checkouts: [{ projectId: "web", name: "Web", path: web, primary: true, teamReady: true }] },
      ] };
  } };
  let services: { teams: TeamService; missions: MissionService } | undefined;
  const open = () => {
    const manager = new Manager(config, key);
    const teams = new TeamService(config, key, manager, (_project, start) => start());
    const missions = new MissionService(config, key, manager, teams, groups);
    teams.start(); missions.start();
    services = { teams, missions };
    return services;
  };
  const shut = () => { services?.missions.close(); services?.teams.close(); services = undefined; };
  const coordinatorReceipts = () => readdirSync(receipts).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(receipts, name), "utf8"))).filter(receipt => receipt.role === "mission-coordinator");
  const create = (objective = "Add an endpoint to the API and call it from the web client"): CreateMission =>
    ({ requestId: randomUUID(), groupId: "shop", objective, maxSubtasks: 8, maxMinutes: 30 });
  const release = (name: string) => writeFileSync(join(receipts, name), "go", { mode: 0o600 });
  const close = async () => {
    const closing = services;
    shut();
    // A tick already under way can still launch a coordinator attempt or subteam member after close().
    await closing?.missions.idle(); await closing?.teams.idle();
    // Workers exit 1.5 s after their child. Sweep until none answers, so no worker or provider outlives the test.
    for (let pass = 1; await stopSessionWorkers(config); pass++) {
      if (pass === 8) throw new Error("Session workers still answer after the mission test stopped them");
      await new Promise(done => setTimeout(done, 500));
    }
    await new Promise(done => setTimeout(done, 1700));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, api, web, open, shut, close, create, release, coordinatorReceipts, services: () => services! };
}
