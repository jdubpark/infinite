import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { buildLaunch, missionCoordinatorLaunch, permissionCoordinatorLaunch, teamModelLaunch } from "../packages/host/src/launch.js";
import { addProjectIdToLaunchEnv } from "../packages/host/src/worker-env.js";
import { claudeConfigPath, recordClaudeTrust } from "../packages/host/src/workspace-trust.js";
import { DEFAULT_HOOKS, readConfig } from "../packages/host/src/config.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";

const hooks = { url: "http://127.0.0.1:4321/hook", token: "tok" };
const relay = "/opt/infinite/packages/host/dist/hook-relay.js";
const enabled = { claude: true, codex: true };

test("worker launch passes only a valid session project ID", () => {
  const valid: Record<string, string> = {};
  addProjectIdToLaunchEnv(valid, "Project.1_name-2");
  assert.equal(valid.INFINITE_PROJECT_ID, "Project.1_name-2");

  for (const projectId of ["bad/id", "has space", "", undefined]) {
    const env: Record<string, string> = {};
    addProjectIdToLaunchEnv(env, projectId);
    assert.equal(Object.hasOwn(env, "INFINITE_PROJECT_ID"), false, `invalid project ID ${String(projectId)} is omitted`);
  }
});

test("team model selection preserves configured provider permissions and refuses competing model controls", () => {
  const selections: TeamModelProfile[] = [
    { id: "opus", label: "Opus", provider: "claude" as const, model: "claude-opus-5-5", effort: "xhigh" as const },
    { id: "astra", label: "Astra", provider: "codex" as const, model: "gpt-6-astra", effort: "high" as const },
    { id: "scout", label: "OpenCode scout", provider: "opencode", model: "example/scout", variant: "high" },
  ];
  const permissions = [
    ["--permission-mode", "plan", "--allowedTools", "Read,Glob"],
    ["--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", 'sandbox_workspace_write.network_access=false'],
    ["--agent", "reviewer", "--pure", "--format", "json", "--auto=false"],
  ];
  for (const [index, selection] of selections.entries()) {
    const profile = { command: selection.provider, args: permissions[index] };
    const original = structuredClone(profile);
    const launch = teamModelLaunch(profile, selection);
    const offset = selection.provider === "opencode" ? 1 : 0;
    assert.equal(launch.command, original.command);
    assert.deepEqual(launch.args.slice(offset, offset + original.args.length), original.args, "Model selection must preserve the operator's permission and sandbox settings verbatim");
    assert.ok(!launch.args.slice(offset + original.args.length).some(arg => /permission|approval|sandbox|dangerously|--auto|yolo/i.test(arg)), "Model routing cannot append an override that weakens the configured permissions");
    assert.deepEqual(profile, original, "Routing one member must not mutate the shared provider profile");
    const sudoPrefix = ["-n", "-H", "-u", "infinite-agent", "--", `/usr/local/libexec/infinite/${selection.provider}`];
    const wrapped = { command: "/usr/bin/sudo", args: [...sudoPrefix, ...profile.args] };
    assert.deepEqual(teamModelLaunch(wrapped, selection), {
      command: wrapped.command, args: [...sudoPrefix, ...launch.args],
    }, "The supported sudo wrapper must preserve its executable boundary and append model controls to the provider");
    for (const args of [["--"], ["--", "--model"], [...sudoPrefix, "--"],
      ["-n", selection.provider], ["-n", selection.provider, "--", "/repo/prompt"],
      ["-n", "-u", "--", selection.provider]])
      assert.throws(() => teamModelLaunch({ command: "/usr/bin/sudo", args }, selection));
    const competing = selection.provider === "claude" ? [
      ["--model", "opus"], ["--effort=medium"], ["--fallback-model", "sonnet"], ["--"],
    ] : selection.provider === "codex" ? [
      ["--model=gpt-6-sol"], ["-m", "gpt-6-sol"], ["-mgpt-6-sol"],
      ["-c", 'model_reasoning_effort="low"'], ["--config", 'model="gpt-6-sol"'],
      ['--config="model_reasoning_effort"="medium"'], ['-cmodel="gpt-6-sol"'],
    ] : [
      ["--model", "example/other"], ["-mexample/other"], ["--variant=low"],
      ["run"], ["attach", "http://127.0.0.1:4321"], ["--command", "custom"],
      ["--dir", "/repo/other"], ["--session", "ses_previous"], ["-c"], ["--prompt", "Another task"], ["--"],
    ];
    for (const args of competing) {
      const error = selection.provider === "opencode" ? /model|variant|OpenCode/ : /model.*effort.*fallback/i;
      assert.throws(() => teamModelLaunch({ ...profile, args: [...profile.args, ...args] }, selection), error, `${selection.provider}: ${args.join(" ")}`);
      assert.throws(() => teamModelLaunch({ ...wrapped, args: [...wrapped.args, ...args] }, selection), error, `sudo ${selection.provider}: ${args.join(" ")}`);
    }
  }
});

test("claude gets --settings with relay command hooks before the prompt", () => {
  const launch = buildLaunch("claude", { command: "claude", args: ["--model", "opus"] }, "do it", hooks, relay, enabled);
  assert.equal(launch.command, "claude");
  assert.equal(launch.args[0], "--model");
  const i = launch.args.indexOf("--settings");
  assert.ok(i > 0);
  const settings = JSON.parse(launch.args[i + 1]);
  const events = Object.keys(settings.hooks).sort();
  assert.deepEqual(events, ["Elicitation", "Notification", "PermissionDenied", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionEnd", "Stop", "StopFailure", "UserPromptSubmit"]);
  const handler = settings.hooks.PreToolUse[0].hooks[0];
  assert.equal(handler.type, "command");
  assert.equal(handler.command, "node /opt/infinite/packages/host/dist/hook-relay.js claude");
  assert.equal(handler.timeout, 10);
  assert.equal("url" in handler, false);
  assert.equal(launch.args.at(-1), "do it");
  assert.ok(!launch.args.includes("--mcp-config"), "Ordinary Claude sessions do not acquire a team tool");
});

test("Claude team launch exposes only its scoped report helper and preserves provider permission decisions", () => {
  const profile = { command: "claude", args: ["--model", "opus"] };
  for (const relayPath of [relay, "/repo/packages/host/src/hook-relay.ts"]) {
    const launch = buildLaunch("claude", profile, "Implement this task", hooks, relayPath, enabled, true);
    const index = launch.args.indexOf("--mcp-config");
    assert.ok(index >= 0);
    const config = JSON.parse(launch.args[index + 1]);
    assert.deepEqual(Object.keys(config.mcpServers), ["infinite_team"]);
    const helper = config.mcpServers.infinite_team;
    assert.equal(helper.type, "stdio");
    assert.equal(helper.command, process.execPath);
    assert.equal(helper.args.at(-1), relayPath.replace("hook-relay", "team-mcp"));
    if (relayPath.endsWith(".ts")) {
      assert.equal(helper.args[0], "--import");
      assert.match(helper.args[1], /^file:\/\/\/.+\/tsx\//);
    }
    assert.deepEqual(helper.env, {
      INFINITE_HOOK_URL: "${INFINITE_HOOK_URL}",
      INFINITE_HOOK_TOKEN: "${INFINITE_HOOK_TOKEN}",
      INFINITE_TEAM_ASSIGNMENT: "${INFINITE_TEAM_ASSIGNMENT}",
      INFINITE_MISSION_ASSIGNMENT: "${INFINITE_MISSION_ASSIGNMENT:-}",
    });
    assert.ok(!launch.args.some(arg => /allowedtools|permission-mode|skip-permissions|dangerously|autoallow/i.test(arg)), "Attaching the report tool must not grant provider permissions");
    assert.equal(launch.args.at(-1), "Implement this task");
    assert.deepEqual(profile.args, ["--model", "opus"]);
  }
  assert.throws(() => buildLaunch("claude", profile, "task", null, relay, enabled, true), /report|hook/i);
});

test("permission coordinator gets a noninteractive report-only Claude profile", () => {
  const configured = { command: "claude", args: ["--allowedTools", "Read", "Glob", "--disallowedTools", "Bash"] };
  const selected = teamModelLaunch(configured, { id: "coordinator", label: "Coordinator", provider: "claude", model: "claude-sonnet-5", effort: "high" });
  const profile = permissionCoordinatorLaunch("claude", selected);
  assert.deepEqual(configured.args, ["--allowedTools", "Read", "Glob", "--disallowedTools", "Bash"], "The shared configured profile is not mutated");
  assert.ok(profile.args.indexOf("--effort") < profile.args.indexOf("--print"), "Coordinator mode follows the configured model and effort args");
  assert.deepEqual(profile.args.slice(profile.args.indexOf("--disallowedTools"), profile.args.indexOf("--disallowedTools") + 2), ["--disallowedTools", "Bash"]);
  assert.equal(profile.args.filter(arg => arg === "--print").length, 1);
  assert.equal(profile.args.filter(arg => arg === "--strict-mcp-config").length, 1);
  assert.equal(profile.args.filter(arg => arg === "--permission-mode").length, 1);
  assert.equal(profile.args[profile.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(profile.args[profile.args.indexOf("--tools") + 1], "");
  assert.deepEqual(profile.args.slice(profile.args.indexOf("--allowedTools") + 1, profile.args.indexOf("--disallowedTools")), ["Read", "Glob", "mcp__infinite_team__report"]);
  assert.deepEqual(profile.args.slice(profile.args.indexOf("--disallowedTools"), profile.args.indexOf("--disallowedTools") + 2), ["--disallowedTools", "Bash"]);

  const launch = buildLaunch("claude", profile, "Review this permission request", hooks, relay, enabled, true);
  const mcpIndex = launch.args.indexOf("--mcp-config");
  assert.ok(mcpIndex >= 0);
  assert.deepEqual(Object.keys(JSON.parse(launch.args[mcpIndex + 1]).mcpServers), ["infinite_team"]);
  assert.ok(launch.args.includes("--strict-mcp-config"));
  assert.equal(launch.args.at(-1), "Review this permission request");

  const wrapped = permissionCoordinatorLaunch("claude", { command: "/usr/bin/sudo", args: ["-n", "-u", "agent", "--", "/usr/local/libexec/infinite/claude", "--model", "sonnet"] });
  assert.deepEqual(wrapped.args.slice(0, 7), ["-n", "-u", "agent", "--", "/usr/local/libexec/infinite/claude", "--model", "sonnet"]);
  assert.ok(wrapped.args.indexOf("--print") > 6, "Coordinator flags follow the configured sudo executable and provider args");
  assert.throws(() => permissionCoordinatorLaunch("claude", { command: process.execPath, args: ["--loader", "provider-wrapper"] }), /must launch Claude Code/);
  assert.throws(() => permissionCoordinatorLaunch("claude", { command: "/usr/bin/sudo", args: ["-n", "--", process.execPath] }), /must name Claude Code/);
});

test("permission coordinator rejects conflicting Claude permission and tool settings", () => {
  for (const args of [
    ["--permission-mode", "acceptEdits"],
    ["--tools", "Read"],
    ["--output-format", "json"],
    ["--mcp-config", "{}"],
    ["--plugin-dir", "./plugins"],
    ["--settings", "settings.json"],
    ["--plugin-url", "https://plugins.example.invalid"],
    ["--chrome"],
    ["--dangerously-skip-permissions"],
  ]) assert.throws(() => permissionCoordinatorLaunch("claude", { command: "claude", args }), /Permission coordinator/);
  assert.throws(() => permissionCoordinatorLaunch("codex", { command: "codex", args: [] }), /Claude Code/);
});

test("mission coordinators can only read repositories and report, and only on Claude Code", () => {
  const claude = missionCoordinatorLaunch("claude", { command: "claude", args: ["--model", "opus"] });
  assert.ok(claude.args.includes("--permission-mode") && claude.args[claude.args.indexOf("--permission-mode") + 1] === "dontAsk");
  assert.ok(claude.args.includes("--tools") && claude.args[claude.args.indexOf("--tools") + 1] === "Read,Glob,Grep");
  const allowed = claude.args.indexOf("--allowedTools");
  assert.deepEqual(claude.args.slice(allowed + 1, allowed + 5), ["Read", "Glob", "Grep", "mcp__infinite_team__mission_report"]);
  assert.ok(claude.args.includes("--strict-mcp-config"));
  const wrapped = missionCoordinatorLaunch("claude", { command: "/usr/bin/sudo", args: ["-n", "-u", "agent", "--", "/usr/local/libexec/infinite/claude", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "Edit"] });
  assert.ok(!wrapped.args.includes("acceptEdits") && !wrapped.args.includes("Bash") && !wrapped.args.includes("Edit"));
  assert.throws(() => missionCoordinatorLaunch("claude", { command: "claude", args: ["--dangerously-skip-permissions"] }), /cannot configure/);
  assert.ok(!claude.args.some(arg => /dangerously-skip|permission-mode.*acceptEdits|mcp__infinite_team__report/.test(arg)));

  // A stray value from a variadic flag must not become the positional prompt.
  const variadic = missionCoordinatorLaunch("claude", { command: "claude", args: ["--tools", "Read", "Bash", "--mcp-config", "a.json", "b.json", "--model", "opus"] });
  assert.ok(!variadic.args.includes("Bash") && !variadic.args.includes("a.json") && !variadic.args.includes("b.json") && variadic.args.includes("opus"));
  // Codex merges inherited MCP servers, so it cannot yet be held to reading and reporting.
  assert.throws(() => missionCoordinatorLaunch("codex", { command: "codex", args: [] }), /require Claude Code/);

  const launch = buildLaunch("claude", claude, "Report the mission", hooks, relay, enabled, true);
  assert.ok(launch.args.at(-1) === "Report the mission");
  assert.ok(launch.args.includes("mcp__infinite_team__mission_report"));
});

test("codex gets -c hook overrides, notify, osc notifications and trust bypass", () => {
  const launch = buildLaunch("codex", { command: "codex", args: [] }, "do it", hooks, relay, enabled);
  const joined = launch.args.join(" ");
  assert.match(joined, /--dangerously-bypass-hook-trust/);
  assert.match(joined, /-c hooks\.PermissionRequest=\[\{hooks=\[\{type="command",command="node \/opt\/infinite\/packages\/host\/dist\/hook-relay\.js codex"\}\]\}\]/);
  assert.match(joined, /-c notify=\["node","\/opt\/infinite\/packages\/host\/dist\/hook-relay\.js","codex-notify"\]/);
  assert.match(joined, /-c tui\.notifications=\["agent-turn-complete","approval-requested","async-question"\]/);
  assert.match(joined, /-c tui\.notification_method="osc9"/);
  assert.match(joined, /-c tui\.notification_condition="always"/);
  assert.equal(launch.args.at(-1), "do it");
});

test("codex dev relay runs the TypeScript file through an absolute tsx loader", () => {
  const launch = buildLaunch("codex", { command: "codex", args: [] }, "", hooks, "/repo/packages/host/src/hook-relay.ts", enabled);
  const hook = launch.args.find((a) => a.startsWith("hooks.PermissionRequest="))!;
  const command = /command="([^"]+)"/.exec(hook)![1];
  assert.ok(command.startsWith("node --import "), command);
  assert.ok(command.endsWith(" /repo/packages/host/src/hook-relay.ts codex"), command);
  // The loader must not be a bare `tsx`, which would resolve from the agent's working directory.
  const loader = command.split(" ")[2];
  assert.match(loader, /^file:\/\/\/.+\/tsx\//);
  const notify = JSON.parse(launch.args.find((a) => a.startsWith("notify="))!.slice("notify=".length));
  assert.deepEqual(notify, ["node", "--import", loader, "/repo/packages/host/src/hook-relay.ts", "codex-notify"]);
});

test("Codex team launch configures its authenticated MCP report tool and requires hooks", () => {
  for (const relayPath of [relay, "/repo/packages/host/src/hook-relay.ts"]) {
    const launch = buildLaunch("codex", { command: "codex", args: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request", "-c", "sandbox_workspace_write.network_access=false"] }, "Implement this task", hooks, relayPath, enabled, true);
    const settings = new Map<string, unknown>();
    for (let index = 0; index < launch.args.length - 1; index++) {
      if (launch.args[index] === "-c" && launch.args[index + 1].startsWith("mcp_servers.infinite_team.")) {
        const override = launch.args[++index].slice("mcp_servers.infinite_team.".length);
        const equals = override.indexOf("=");
        settings.set(override.slice(0, equals), JSON.parse(override.slice(equals + 1)));
      }
    }
    assert.equal(settings.size, 5);
    assert.equal(settings.get("command"), process.execPath);
    const serverArgs = settings.get("args") as string[];
    assert.equal(serverArgs.at(-1), relayPath.replace("hook-relay", "team-mcp"));
    if (relayPath.endsWith(".ts")) {
      assert.equal(serverArgs[0], "--import");
      assert.match(serverArgs[1], /^file:\/\/\/.+\/tsx\//);
    }
    // A mission coordinator's assignment reaches the host-side MCP server, which reports over loopback for the sandboxed agent.
    assert.deepEqual(settings.get("env_vars"), ["INFINITE_HOOK_URL", "INFINITE_HOOK_TOKEN", "INFINITE_TEAM_ASSIGNMENT", "INFINITE_MISSION_ASSIGNMENT", "INFINITE_PROJECT_ID"]);
    assert.equal(settings.get("tools.report.approval_mode"), "approve");
    assert.equal(settings.get("tools.mission_report.approval_mode"), "approve");
    assert.ok(launch.args.includes("--sandbox") && launch.args.includes("workspace-write"));
    assert.ok(launch.args.includes("sandbox_workspace_write.network_access=false"));
    assert.ok(launch.args.includes("on-request"));
    assert.equal(launch.args.at(-1), "Implement this task");
  }
  assert.throws(() => buildLaunch("codex", { command: "codex", args: [] }, "task", null, relay, enabled, true), /Codex team reporting/);
});

// A readable teamwork run path long enough that a terminal wraps it across lines.
const memberFolder = `/srv/data/workspaces/Projects/sample/teamwork/2026-01-15-${"stop-ringing-once-i-am-up-".repeat(2)}3f2a9c1d/members/${randomUUID()}`;

test("a trusted member folder reaches Codex as one per-launch override for that exact folder", () => {
  const trusted = buildLaunch("codex", { command: "codex", args: [] }, "do it", hooks, relay, enabled, true, undefined, undefined, memberFolder);
  const index = trusted.args.indexOf(`projects={${JSON.stringify(memberFolder)}={trust_level="trusted"}}`);
  assert.ok(index > 0 && trusted.args[index - 1] === "-c", trusted.args.join(" "));
  assert.equal(trusted.args.at(-1), "do it");
  const quoted = buildLaunch("codex", { command: "codex", args: [] }, "", null, relay, enabled, false, undefined, undefined, '/srv/a "b"\\c');
  assert.deepEqual(quoted.args, ["-c", 'projects={"/srv/a \\"b\\"\\\\c"={trust_level="trusted"}}']);
  for (const folder of ["relative/member", "/srv/a\nb", "/srv/a/../b", "/"])
    assert.throws(() => buildLaunch("codex", { command: "codex", args: [] }, "", null, relay, enabled, false, undefined, undefined, folder), /absolute folder/);
  // Claude has no per-launch trust flag, and untrusted launches carry no override.
  assert.ok(!buildLaunch("claude", { command: "claude", args: [] }, "p", hooks, relay, enabled, true, undefined, undefined, memberFolder).args.some(arg => arg.includes("trust_level")));
  assert.ok(!buildLaunch("codex", { command: "codex", args: [] }, "p", hooks, relay, enabled, true).args.some(arg => arg.startsWith("projects=")));
});

test("Claude trust adds one exact folder entry and leaves the rest of its config unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "inf-claude-trust-"));
  try {
    const config = join(root, ".claude.json");
    assert.equal(recordClaudeTrust(config, memberFolder), true);
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { projects: { [memberFolder]: { hasTrustDialogAccepted: true } } });
    const parent = memberFolder.slice(0, memberFolder.indexOf("/members/"));
    const existing = { numStartups: 7, projects: { [parent]: { allowedTools: ["Read"] }, [memberFolder]: { allowedTools: [], hasTrustDialogAccepted: false } } };
    writeFileSync(config, JSON.stringify(existing));
    assert.equal(recordClaudeTrust(config, memberFolder), true);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ...existing, projects: { ...existing.projects, [memberFolder]: { allowedTools: [], hasTrustDialogAccepted: true } } });
    const recorded = readFileSync(config, "utf8");
    assert.equal(recordClaudeTrust(config, memberFolder), false);
    assert.equal(readFileSync(config, "utf8"), recorded);
    writeFileSync(config, "{ not json");
    assert.throws(() => recordClaudeTrust(config, memberFolder));
    assert.equal(readFileSync(config, "utf8"), "{ not json");
    assert.throws(() => recordClaudeTrust(config, "members/relative"), /absolute folder/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude trust takes Claude's own config lock and keeps a concurrent Claude write", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-claude-lock-")));
  try {
    const home = join(root, "home"), member = join(root, "member"), config = join(home, ".claude.json"), lock = `${config}.lock`;
    mkdirSync(home); mkdirSync(member);
    writeFileSync(config, JSON.stringify({ numStartups: 1 }));
    mkdirSync(lock);
    assert.throws(() => recordClaudeTrust(config, member, 100), /locked/);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { numStartups: 1 });
    assert.ok(existsSync(lock), "Another writer's lock must stay in place");
    // The agent-side entry waits while a running Claude session holds the lock and saves.
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/host/src/workspace-trust.ts"), "claude"],
      { cwd: member, env: { PATH: process.env.PATH ?? "", HOME: home, INFINITE_TRUSTED_WORKSPACE: member }, stdio: "ignore" });
    const exited = new Promise<number | null>(done => child.once("exit", done));
    const early = await Promise.race([exited, new Promise(done => setTimeout(() => done("waiting"), 1500))]);
    assert.equal(early, "waiting", "Trust must not be written while Claude holds its config lock");
    const claudeSave = { numStartups: 2, projects: { "/srv/other": { allowedTools: ["Read"] } } };
    writeFileSync(config, JSON.stringify(claudeSave));
    rmSync(lock, { recursive: true });
    assert.equal(await exited, 0);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ...claudeSave, projects: { ...claudeSave.projects, [member]: { hasTrustDialogAccepted: true } } });
    assert.ok(!existsSync(lock));
    // A lock abandoned past proper-lockfile's ten-second staleness is reclaimed.
    mkdirSync(lock);
    const old = new Date(Date.now() - 60000);
    utimesSync(lock, old, old);
    assert.equal(recordClaudeTrust(config, "/srv/stale-lock-member", 100), true);
    assert.ok(!existsSync(lock));
    // A stale lock that cannot be removed fails promptly instead of spinning past the deadline.
    mkdirSync(lock);
    writeFileSync(join(lock, "unexpected"), "");
    utimesSync(lock, old, old);
    const started = Date.now();
    assert.throws(() => recordClaudeTrust(config, "/srv/stuck-lock-member", 100), { code: /^(ENOTEMPTY|EEXIST)$/ });
    assert.ok(Date.now() - started < 2000);
    assert.ok(existsSync(join(lock, "unexpected")));
    assert.equal(JSON.parse(readFileSync(config, "utf8")).projects["/srv/stuck-lock-member"], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Claude trust targets the config file Claude reads, including its legacy location", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-claude-path-")));
  try {
    const home = join(root, "home"), legacy = join(home, ".claude", ".config.json"), primary = join(home, ".claude.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    assert.equal(claudeConfigPath(home), primary);
    writeFileSync(legacy, "", { mode: 0o600 });
    assert.equal(claudeConfigPath(home), legacy, "An empty, writable legacy file is used when the primary file is absent");
    writeFileSync(primary, "{}");
    assert.equal(claudeConfigPath(home), primary);
    writeFileSync(legacy, JSON.stringify({ projects: {} }));
    assert.equal(claudeConfigPath(home), legacy, "A non-empty legacy file still wins");
    assert.equal(claudeConfigPath(home, join(root, "custom")), join(root, "custom", ".claude.json"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the agent-side Claude trust entry records only the folder it is launched in", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inf-agent-trust-")));
  try {
    const home = join(root, "home"), member = join(root, "member"), other = join(root, "other");
    for (const folder of [home, member, other]) mkdirSync(folder);
    // Wrappers call the entry through the release symlink, as /opt/infinite does on Ubuntu.
    const release = join(root, "release");
    symlinkSync(resolve("packages/host/src"), release);
    const run = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath,
      ["--import", import.meta.resolve("tsx"), join(release, "workspace-trust.ts"), ...args],
      { cwd: member, env: { PATH: process.env.PATH ?? "", HOME: home, ...env }, encoding: "utf8" });
    assert.equal(run({ INFINITE_TRUSTED_WORKSPACE: other }, "claude").status, 65);
    assert.equal(run({}, "claude").status, 64);
    assert.equal(run({ INFINITE_TRUSTED_WORKSPACE: member }, "codex").status, 64);
    assert.throws(() => readFileSync(join(home, ".claude.json")), { code: "ENOENT" });
    const recorded = run({ INFINITE_TRUSTED_WORKSPACE: member }, "claude");
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects, { [member]: { hasTrustDialogAccepted: true } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("disabled hooks or no hook server leave the profile untouched", () => {
  assert.deepEqual(buildLaunch("claude", { command: "claude", args: [] }, "p", null, relay, enabled).args, ["p"]);
  assert.deepEqual(buildLaunch("codex", { command: "codex", args: [] }, "", hooks, relay, { claude: true, codex: false }).args, []);
  assert.deepEqual(buildLaunch("opencode", { command: "opencode", args: [] }, "p", hooks, relay, enabled).args, ["--prompt", "p"]);
  assert.deepEqual(buildLaunch("grok", { command: "grok", args: ["-x"] }, "", hooks, relay, enabled).args, ["-x"]);
});

test("codex hooks stay off unless the config turns them on", () => {
  const root = mkdtempSync(join(tmpdir(), "inf-config-"));
  try {
    const keyFile = join(root, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    mkdirSync(join(root, "project"));
    const base = {
      port: 0, origin: "http://127.0.0.1:4780", stateDir: join(root, "state"), runDir: join(root, "run"), keyFile,
      environment: "local", tokens: [{ id: "o", label: "o", role: "owner", hash: "a".repeat(64) }],
      projects: [{ id: "p", name: "P", path: join(root, "project") }],
    };
    const parse = (extra: object) => {
      writeFileSync(join(root, "config.json"), JSON.stringify({ ...base, ...extra }));
      return readConfig(join(root, "config.json")).config;
    };
    // No attention block: the manager falls back to DEFAULT_HOOKS.
    assert.equal(parse({}).attention, undefined);
    assert.deepEqual({ ...DEFAULT_HOOKS }, { claude: true, codex: false });
    assert.deepEqual(parse({ attention: {} }).attention?.hooks, { claude: true, codex: false });
    assert.deepEqual(parse({ attention: { hooks: { claude: false } } }).attention?.hooks, { claude: false, codex: false });
    assert.deepEqual(parse({ attention: { hooks: { codex: true } } }).attention?.hooks, { claude: true, codex: true });
    // With the defaults, Codex launches exactly as its profile says.
    assert.deepEqual(buildLaunch("codex", { command: "codex", args: ["-a", "on-request"] }, "go", hooks, relay, DEFAULT_HOOKS).args, ["-a", "on-request", "go"]);
    assert.ok(buildLaunch("claude", { command: "claude", args: [] }, "", hooks, relay, DEFAULT_HOOKS).args.includes("--settings"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
