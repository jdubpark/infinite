import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { startHost, stopSessionWorkers, waitFor, type Host } from "./helpers.js";
import type { Config } from "../packages/host/src/types.js";
import type { CreateTeam, TeamLineup, TeamView } from "../packages/host/src/team-types.js";
import type { ProjectSourceService } from "../packages/host/src/project-source.js";
import { Manager } from "../packages/host/src/manager.js";
import { TeamService } from "../packages/host/src/teams.js";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();

export const mixedLineup: TeamLineup = {
  coordinator: { id: "opus-coordinator", label: "Opus coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh" },
  implementers: [
    { id: "spark-high", label: "Spark implementer", provider: "opencode", model: "meta/muse-spark-1.3-contributor", variant: "high", tier: "light", dataUse: "contributor" },
    { id: "astra-xhigh", label: "Astra implementer", provider: "codex", model: "gpt-6-astra", effort: "xhigh" },
  ],
  integrator: { id: "astra-integrator", label: "Astra integrator", provider: "codex", model: "gpt-6-astra", effort: "high" },
  reviewer: { id: "opus-reviewer", label: "Opus reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh" },
};

export const limitLineup: TeamLineup = {
  coordinator: { id: "codex-coordinator", label: "Codex coordinator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
  implementers: [
    { id: "haiku", label: "Claude implementer", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light", limitFallback: "deepseek-light" },
    { id: "codex-light", label: "Codex implementer", provider: "codex", model: "gpt-6-astra", effort: "medium", tier: "light" },
  ],
  integrator: { id: "codex-integrator", label: "Codex integrator", provider: "codex", model: "gpt-6-astra", effort: "high", tier: "strong" },
  reviewer: { id: "codex-reviewer", label: "Codex reviewer", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" },
  fallbacks: [
    { id: "deepseek-light", label: "DeepSeek Flash", provider: "opencode", model: "deepseek/deepseek-flash", variant: "medium", tier: "light" },
  ],
};

/** `trustWorkspaces` also gives the host its own HOME, where a Claude member's trust is recorded. */
export async function fixture(scenario = "success", lineup?: TeamLineup, config: Partial<Config> = {}, options: { trustWorkspaces?: boolean; env?: NodeJS.ProcessEnv; parallelism?: number; deliveryMode?: "merge" | "pr"; noServer?: boolean } = {}) {
  const root = realpathSync(mkdtempSync("/tmp/inf-team-"));
  const home = join(root, "home");
  if (options.trustWorkspaces) mkdirSync(home, { mode: 0o700 });
  const source = join(root, "source");
  const receipts = join(root, "receipts");
  mkdirSync(source); mkdirSync(receipts, { mode: 0o700 });
  const opencode = join(root, "opencode-fixture");
  const codexAgent = resolve("tests/fixtures/team-agent.mjs");
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  writeFileSync(opencode, `#!/bin/sh\nexec ${[process.execPath, resolve("tests/fixtures/team-agent.mjs"), scenario, receipts, "--fixture-provider", "opencode"].map(quote).join(" ")} "$@"\n`);
  chmodSync(opencode, 0o700);
  const claude = join(root, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec ${[process.execPath, resolve("tests/fixtures/team-agent.mjs"), scenario, receipts, "--fixture-provider", "claude"].map(quote).join(" ")} "$@"\n`);
  chmodSync(claude, 0o700);
  git(source, "init", "--initial-branch=main");
  const bootstrap = scenario.startsWith("bootstrap");
  if (!bootstrap)
    writeFileSync(join(source, "original.txt"), "The configured project remains unchanged.\n");
  if (!bootstrap) writeFileSync(join(source, "check.mjs"), [
    'import assert from "node:assert/strict";',
    'import { existsSync, readFileSync } from "node:fs";',
    'assert.match(readFileSync("a.txt", "utf8"), /^revision [1-9][0-9]*\\n$/);',
    'assert.equal(readFileSync("a.txt", "utf8"), readFileSync("b.txt", "utf8"));',
    'if (process.argv.includes("--prefix")) assert.equal(process.env.INFINITE_TEST_COMMAND_IDENTITY, "team-prefix");',
    'if (process.argv.includes("--fail")) { console.error("Configured verification failed"); process.exit(17); }',
    ...(scenario === "mixed" || scenario === "integrator-limit" ? ['if (!existsSync("repair.txt")) { console.error("Integration repair required"); process.exit(18); }'] : []),
  ].join("\n"));
  if (bootstrap) {
    git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Empty project");
  } else git(source, "add", "original.txt", "check.mjs");
  if (!bootstrap)
    git(source, "-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial fixture");
  const base = git(source, "rev-parse", "HEAD");
  const agents: Config["agents"] = {
    demo: { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), scenario, receipts] },
    ...(lineup ? {
      claude: { command: claude, args: scenario === "permissions-launch-invalid" ? ["--dangerously-skip-permissions"] : [] },
      codex: { command: process.execPath, args: [codexAgent, scenario, receipts, "--fixture-provider", "codex"] },
      opencode: { command: opencode, args: [] },
    } : {}),
  };
  const hostConfig: Partial<Config> = {
    remote: { enabled: true },
    projects: [{ id: "rehearsal", name: "Rehearsal", path: source,
      team: { ...(scenario.startsWith("delivery") ? { delivery: options.deliveryMode === "pr" ? { mode: "pr" as const, repository: "example/app", baseBranch: "main" } : { mode: "merge" as const, repository: "example/app", baseBranch: "main", mergeMethod: "squash" as const } } : {}), ...(scenario.startsWith("permissions") ? { setup: { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--permission-setup", receipts] } } : {}), ...(scenario.startsWith("permissions") && scenario !== "permissions-off" ? { permissions: { mode: "coordinator" as const, scope: "Approve only read access needed to inspect this project for the stated objective.", maxDecisions: 2 } } : {}), checks: [], ...(scenario !== "bootstrap-override" && bootstrap ? { establishChecks: true } : {}), ...(bootstrap && scenario !== "bootstrap-override" ? {} : { checks: [
        { command: process.execPath, args: ["check.mjs", ...(scenario.endsWith("failed-check") ? ["--fail"] : []), ...(scenario === "success" ? ["--prefix"] : [])] },
        ...(scenario === "lifecycle" ? [{ command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--hold-check", receipts] }] : []),
      ] }) } }],
    ...config,
    teams: { workspaceDir: join(root, "teams"), ...(lineup ? { lineup } : {}), ...(options.trustWorkspaces ? { trustWorkspaces: true } : {}), ...(scenario === "success" ? {
      commandPrefix: { command: process.execPath, args: [resolve("tests/fixtures/team-agent.mjs"), "--command-prefix", receipts] },
    } : {}), ...config.teams },
  };
  let host: Host;
  try {
    if (options.noServer) {
      const keyFile = join(root, "key");
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
      const directConfig: Config = { port: 0, origin: "http://127.0.0.1", keyFile, stateDir: join(root, "state"), runDir: join(root, "run"),
        environment: "local", enableDemo: true, maxSessions: 24, projects: [], tokens: [], agents, ...hostConfig };
      host = { root, config: directConfig, origin: directConfig.origin, tokens: {} as Host["tokens"],
        fetchApi: async () => { throw new Error("The no-server fixture does not expose an API client."); },
        start: async () => {}, stopApi: async () => {},
        stop: async () => { await stopSessionWorkers(directConfig); await new Promise(resolve => setTimeout(resolve, 1700)); rmSync(root, { recursive: true, force: true }); } };
    } else {
      host = await startHost({ agents, config: hostConfig,
        ...(options.trustWorkspaces ? { env: { HOME: home } } : {}),
        ...(options.env ? { env: { ...(options.trustWorkspaces ? { HOME: home } : {}), ...options.env } } : {}),
      });
    }
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const create = (): CreateTeam => ({ requestId: randomUUID(), projectId: "rehearsal", provider: lineup?.coordinator.provider ?? "demo",
    ...(lineup ? { useConfiguredLineup: true } : {}), title: "Implement a small feature",
    objective: "Create independent files and verify their integrated contents.", parallelism: options.parallelism ?? 2 });
  const get = async (id: string): Promise<TeamView> => {
    const response = await host.fetchApi(`/teams/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const settled = (id: string) => waitFor(() => get(id), run => ["ready-for-review", "merged", "blocked"].includes(run.status), 90000);
  const directServices: TeamService[] = [];
  const openTeamService = async (serviceOptions: { source?: Pick<ProjectSourceService, "refresh" | "mirrorPath" | "isGithub" | "status">; onMerged?: (projectId: string) => void; start?: boolean } = {}) => {
    await host.stopApi();
    if (serviceOptions.source) host.config.projects.find(project => project.id === "rehearsal")!.source = { mode: "github", repository: "example/app", baseBranch: "main" };
    const key = readFileSync(host.config.keyFile);
    const manager = new Manager(host.config, key);
    const service = new TeamService(host.config, key, manager, (_projectId, start) => start(), undefined, undefined,
      { ...(serviceOptions.source ? { source: serviceOptions.source } : {}), ...(serviceOptions.onMerged ? { onMerged: serviceOptions.onMerged } : {}) });
    if (serviceOptions.start !== false) service.start();
    directServices.push(service);
    return service;
  };
  const close = async () => {
    try {
      for (const service of directServices) service.close();
      for (const service of directServices) await service.idle();
      if (!options.noServer && !directServices.length) {
        const listed = await host.fetchApi("/teams");
        for (const run of listed.body.teams ?? [])
          if (!["ready-for-review", "merged", "cancelled"].includes(run.status))
            await host.fetchApi(`/teams/${run.id}/cancel`, "owner", { requestId: randomUUID(), revision: run.revision });
      }
    } finally { await host.stop(); rmSync(root, { recursive: true, force: true }); }
  };
  /** Serve the fixture's parent folder as the sync home and enroll a sibling teamwork folder through the API. */
  const enrollTeamwork = async (sync: Partial<NonNullable<Config["sync"]>> = {}, teamwork = "teamwork") => {
    const home = realpathSync(dirname(source));
    host.config.sync = { homeDir: home, ...sync };
    await host.stopApi();
    writeFileSync(join(host.root, "config.json"), JSON.stringify(host.config));
    await host.start();
    const current = await host.fetchApi("/projects/rehearsal/team", "owner");
    assert.equal(current.status, 200, JSON.stringify(current.body));
    const saved = await host.fetchApi("/projects/rehearsal/team", "owner", { requestId: randomUUID(), revision: current.body.revision, team: current.body.team, teamwork }, {}, "PUT");
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.teamwork, teamwork);
    return join(home, ...teamwork.split("/"));
  };
  return { host, source, receipts, home, base, create, get, settled, close, enrollTeamwork, openTeamService };
}
