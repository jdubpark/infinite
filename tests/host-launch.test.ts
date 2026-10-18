import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { buildLaunch, permissionCoordinatorLaunch, teamModelLaunch } from "../packages/host/src/launch.js";
import { DEFAULT_HOOKS, readConfig } from "../packages/host/src/config.js";
import type { TeamModelProfile } from "../packages/host/src/team-types.js";

const hooks = { url: "http://127.0.0.1:4321/hook", token: "tok" };
const relay = "/opt/infinite/packages/host/dist/hook-relay.js";
const enabled = { claude: true, codex: true };

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
