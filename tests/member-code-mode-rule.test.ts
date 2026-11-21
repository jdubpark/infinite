import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProgramInstructions, memberLaunchPrompt } from "../packages/host/src/code-mode.js";
import { memberConfiguration, promptVersion, renderedPrompts } from "../packages/host/src/config-identity.js";
import { memberCodeModeExpected } from "../packages/host/src/launch.js";
import { Manager } from "../packages/host/src/manager.js";
import { startFrame } from "../packages/host/src/routing-auto.js";
import { pinRouting } from "../packages/host/src/routing-policy.js";
import type { TeamLineup, TeamModelProfile, TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import type { AgentProfile, Config } from "../packages/host/src/types.js";
import { schedulerFixture } from "./fixtures/team-scheduler.js";
import { waitFor } from "./helpers.js";
import { fixture, mixedLineup } from "./team-fixture.js";

const PROMPT = "Member prompt: change one file.\n\nReport when the check passes.";
const claudeLight: TeamModelProfile = { id: "haiku-medium", label: "Claude implementer", provider: "claude", model: "claude-haiku-5-5", effort: "medium", tier: "light" };

test("only a Claude member whose launch asks for Code Mode reads the rule for programs", () => {
  assert.equal(memberLaunchPrompt(PROMPT, "claude", true), `${PROMPT}\n\n${claudeProgramInstructions}`);
  assert.equal(memberLaunchPrompt(PROMPT, "claude", false), PROMPT);
  for (const provider of ["codex", "opencode", "grok"] as const) assert.equal(memberLaunchPrompt(PROMPT, provider, true), PROMPT, provider);
  // The rule names the report tool a Claude member is told to use, and says that a reject holds inside a program.
  assert.match(claudeProgramInstructions, /mcp__infinite_team__report/);
  assert.match(claudeProgramInstructions, /A rejected call is final inside a program too/);
});

test("a Claude member's prompt version differs with Code Mode, and every other version stays the same", () => {
  const roles = ["project-manager", "scout", "implementer", "integrator", "reviewer", "delivery", "intent-checker"] as const;
  for (const role of roles) {
    const plain = promptVersion(role, "claude", undefined, true, true, false);
    assert.equal(promptVersion(role, "claude", undefined, true, true, false, false), plain, `${role}: off is the version without the argument`);
    assert.notEqual(promptVersion(role, "claude", undefined, true, true, false, true), plain, `${role}: on is another version`);
    for (const provider of ["codex", "opencode"] as const)
      assert.equal(promptVersion(role, provider, undefined, true, true, false, true), promptVersion(role, provider, undefined, true, true, false), `${role} ${provider}`);
  }
  // The version is the hash of what the member reads: each render ends with the rule, and is otherwise the same text.
  const off = renderedPrompts("implementer", "claude", undefined, true), on = renderedPrompts("implementer", "claude", undefined, true, false, false, true);
  assert.deepEqual(on, off.map(text => `${text}\n\n${claudeProgramInstructions}`));
});

test("a member's configuration identity differs with the mode its launch recorded, for a Claude member only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "member-code-mode-"));
  try {
    execFileSync("git", ["init", "-q", "--template="], { cwd: dir });
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "empty"], { cwd: dir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const live = new AbortController().signal;
    const read = (provider: "claude" | "codex", codeMode?: boolean) =>
      memberConfiguration({ workspace: dir, baseCommit: head, role: "implementer", provider, publishHeads: true, ...(codeMode === undefined ? {} : { codeMode }) }, live);
    const [absent, off, on] = [await read("claude"), await read("claude", false), await read("claude", true)];
    assert.ok(absent && off && on);
    assert.deepEqual(off, absent, "a launch without Code Mode keeps the identity it had before the mode existed");
    assert.equal(on.promptVersion, promptVersion("implementer", "claude", undefined, true, false, false, true));
    assert.notEqual(on.promptVersion, absent.promptVersion);
    assert.notEqual(on.configId, absent.configId);
    assert.deepEqual({ ...on, promptVersion: absent.promptVersion, configId: absent.configId }, absent, "only the prompt version and the id it feeds differ");
    assert.deepEqual(await read("codex", true), await read("codex"), "another provider's identity does not read the mode");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the mode a new Claude member would start in is read from the level and the shape of the launch profile", () => {
  const config = (level: "off" | "headless" | "all" | undefined, claude: AgentProfile | undefined): Pick<Config, "agents" | "codeMode"> =>
    ({ agents: { ...(claude ? { claude } : {}) } as Config["agents"], ...(level ? { codeMode: { claude: level } } : {}) });
  const interactive = { command: "claude", args: [] }, headless = { command: "claude", args: ["-p"] };
  const viaSudo = { command: "/usr/bin/sudo", args: ["-n", "-u", "agent", "--", "claude", "--print"] };
  const cases: Array<[string, AgentProfile | undefined, "off" | "headless" | "all" | undefined, boolean]> = [
    ["no level", interactive, undefined, false], ["off", interactive, "off", false],
    ["headless level, interactive launch", interactive, "headless", false], ["all, interactive launch", interactive, "all", true],
    ["off, headless launch", headless, "off", false], ["headless level, headless launch", headless, "headless", true],
    ["all, headless launch", headless, "all", true], ["all, headless launch through sudo", viaSudo, "all", true],
    // The channel cannot serve these shapes, and a headless run takes the request only from the channel's settings.
    ["all, headless launch that skips permissions", { command: "claude", args: ["-p", "--dangerously-skip-permissions"] }, "all", false],
    ["all, headless launch outside the default permission mode", { command: "claude", args: ["-p", "--permission-mode", "dontAsk"] }, "all", false],
    ["all, no Claude profile", undefined, "all", false],
  ];
  for (const [name, profile, level, expected] of cases) assert.equal(memberCodeModeExpected(config(level, profile)), expected, name);
});

test("routing scores a Claude candidate at the prompt version of the mode a new member would start in", () => {
  const lineup: TeamLineup = { ...mixedLineup, implementers: [claudeLight, mixedLineup.implementers[1]!] };
  const run = { id: "run-1", revision: 1, projectId: "rehearsal", lineup, routing: pinRouting(undefined, "autonomous", lineup), tasks: [], members: [], events: [] } as unknown as TeamRun;
  const task = { id: "task-a", title: "task-a", instructions: "do it", paths: ["packages/host/src/a.ts"], dependsOn: [], revision: 1, status: "pending" } as unknown as TeamTask;
  const versions = (codeMode: boolean) => new Map([...startFrame({ run, task, publishHeads: false, entryTools: false, objectiveDigest: false, codeMode, featureMap: undefined, limited: new Set() })
    .versions.values()].map(({ profile, version }) => [profile.id, version]));
  const on = versions(true), off = versions(false);
  assert.equal(off.get("haiku-medium"), promptVersion("implementer", "claude", claudeLight, false, false));
  assert.equal(on.get("haiku-medium"), promptVersion("implementer", "claude", claudeLight, false, false, false, true));
  assert.notEqual(on.get("haiku-medium"), off.get("haiku-medium"));
  assert.ok(off.get("astra-xhigh"));
  assert.equal(on.get("astra-xhigh"), off.get("astra-xhigh"));
});

test("a run's router reads the mode a new Claude member would start in, and a learning run reads none", () => {
  const f = schedulerFixture();
  try {
    f.config.agents.claude = { command: "claude", args: [] };
    f.config.codeMode = { claude: "all" };
    const teams = f.openTeam();
    const routed = (run: TeamRun) => (teams as unknown as { routerInput(run: TeamRun): { codeMode: boolean } }).routerInput(run).codeMode;
    assert.equal(routed(f.run), true);
    // A learning session never starts in Code Mode, so its run's router does not expect it.
    assert.equal(routed({ ...f.run, replay: { jobId: "job", trialId: "trial", purpose: "replay" } }), false);
    f.config.codeMode = { claude: "off" };
    assert.equal(routed(f.run), false);
  } finally {
    f.close();
  }
});

/**
 * Starts one session on a stand-in provider that records the arguments and the Code Mode variable it started with:
 * a team member in `role`, or the owner's own session when `role` is null.
 */
async function launchMember(level: "off" | "all" | undefined, provider: "claude" | "codex", role: string | null = "implementer") {
  const root = mkdtempSync(join(tmpdir(), "infinite-member-rule-"));
  const log = join(root, "launch.json");
  const agent = join(root, "agent.mjs");
  writeFileSync(agent, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), mode: process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE ?? null }));
setTimeout(() => process.exit(0), 300);
`);
  const host = await fixture("success", undefined, level ? { codeMode: { claude: level } } : {}, { noServer: true });
  try {
    const config = host.host.config;
    config.agents[provider] = { command: process.execPath, args: [agent] };
    const manager = new Manager(config, readFileSync(config.keyFile));
    const cwd = join(config.teams!.workspaceDir, randomUUID(), "integration");
    mkdirSync(cwd, { recursive: true });
    const assignment = { runId: randomUUID(), memberId: randomUUID(), revision: 1, role, taskId: "a" } as never;
    const request = { requestId: randomUUID(), projectId: "rehearsal", provider, title: "Member", prompt: PROMPT };
    const session = role === null ? await manager.create(request, "owner") : await manager.createTeamSession(request, assignment, cwd);
    await waitFor(() => existsSync(log), Boolean, 60000);
    const launch = JSON.parse(readFileSync(log, "utf8")) as { args: string[]; mode: string | null };
    return { session, mode: launch.mode, prompts: launch.args.filter(arg => arg.includes("Member prompt:")) };
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a Claude member launched with Code Mode on is started with its prompt and the rule, and its record says so", { timeout: 120000 }, async () => {
  const { session, mode, prompts } = await launchMember("all", "claude");
  assert.equal(session.codeMode, true);
  assert.equal(mode, "1", "the launch asked for Code Mode");
  assert.deepEqual(prompts, [`${PROMPT}\n\n${claudeProgramInstructions}`]);
  assert.equal(session.initialPrompt, PROMPT, "the session record keeps the prompt the team gave");
});

test("the owner's own Claude session in Code Mode is started with the owner's prompt and no rule", { timeout: 120000 }, async () => {
  const { session, mode, prompts } = await launchMember("all", "claude", null);
  assert.equal(session.team, undefined);
  assert.equal(session.codeMode, true);
  assert.equal(mode, "1");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0]!.includes(PROMPT));
  assert.ok(!prompts[0]!.includes("Working rule for programs"), `the rule is for team members, and the owner's session read: ${prompts[0]!.slice(-400)}`);
});

test("with the switch off a Claude member is started with its prompt byte for byte", { timeout: 120000 }, async () => {
  for (const level of ["off", undefined] as const) {
    const { session, mode, prompts } = await launchMember(level, "claude");
    assert.notEqual(session.codeMode, true, String(level));
    assert.equal(mode, null, String(level));
    assert.deepEqual(prompts, [PROMPT], String(level));
  }
});

test("Code Mode on changes nothing for a Codex member or for a coordinator that never starts in Code Mode", { timeout: 120000 }, async () => {
  const codex = await launchMember("all", "codex");
  assert.notEqual(codex.session.codeMode, true);
  assert.deepEqual(codex.prompts, [PROMPT]);
  const coordinator = await launchMember("all", "claude", "mission-coordinator");
  assert.notEqual(coordinator.session.codeMode, true);
  assert.equal(coordinator.mode, null);
  assert.deepEqual(coordinator.prompts, [PROMPT]);
});
