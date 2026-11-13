import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const renderer = resolve("scripts/render-instance.mjs");
const temporaryDirectories: string[] = [];
const templateFiles = ["agent-anchor.sh", "agent-env.sh", "agent-wrapper.sh", "config.example.json", "github-app-gh.sh",
  "infinite-github-refresh.service", "infinite-github-refresh.timer", "infinite.service", "infinite.sudoers", "infinite-tmpfiles.conf", "install-agent-env.sh"];

function tmp() {
  const path = mkdtempSync(join(tmpdir(), "infinite-instance-"));
  temporaryDirectories.push(path);
  return path;
}

function render(args: string[] = []) {
  const out = join(tmp(), "rendered");
  const result = spawnSync(process.execPath, [renderer, "--out", out, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return out;
}

function rendered(args: string[] = []) {
  const out = render(args);
  return readdirSync(out).map(name => [name, readFileSync(join(out, name), "utf8")] as const);
}

function file(name: string, args: string[] = ["--instance", "work"]) {
  const out = render(args);
  return readFileSync(join(out, name), "utf8");
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("rendering with no instance name reproduces the tracked files byte for byte", () => {
  const out = render();
  assert.deepEqual(readdirSync(out).sort(), [...templateFiles].sort());
  for (const name of readdirSync(out))
    assert.ok(readFileSync(join(out, name)).equals(readFileSync(join("deploy/ubuntu", name))), name);
});

test("no rendered file for an instance names the first instance", () => {
  const first = [/\/srv\/infinite-data\/(?!instances\/work\/)/, /infinite-host(?![a-z0-9-])/, /infinite-agent(?![a-z0-9-])/, /infinite-workspace/,
    /\/etc\/infinite\//, /\/run\/infinite(\/|-key)/, /\/usr\/local\/libexec\/infinite(\/|\s|"|$)/m, /\/opt\/infinite(\/|\s|"|$)/m, /\/opt\/infinite-agents/, /\/etc\/infinite-github/];
  const files = rendered(["--instance", "work"]);
  assert.deepEqual(files.map(([name]) => name).sort(), ["agent-anchor.sh", "agent-env.sh", "agent-wrapper.sh", "config.example.json", "github-app-gh.sh",
    "infinite-work-github-refresh.service", "infinite-work-github-refresh.timer", "infinite-work.service", "infinite-work.sudoers", "infinite-work-tmpfiles.conf", "install-agent-env.sh"].sort());
  for (const [name, text] of files)
    for (const pattern of first) assert.doesNotMatch(text, pattern, `${name} ${pattern}`);
});

test("the instance unit has weights and an OOM preference and no ceiling", () => {
  const unit = file("infinite-work.service");
  for (const line of ["CPUWeight=50", "IOWeight=50", "OOMScoreAdjust=500", "TasksMax=infinity", "User=infinite-work-host",
    "ConditionPathIsMountPoint=/srv/infinite-data", "ConditionPathExists=/run/infinite-work-key/vault.key"])
    assert.ok(unit.includes(`\n${line}\n`), line);
  assert.doesNotMatch(unit, /MemoryHigh|MemoryMax|CPUQuota/);
  assert.match(unit, /^Description=.* \(instance work\)$/m);
});

test("both sudoers files keep the mission assignment", () => {
  assert.match(readFileSync("deploy/ubuntu/infinite.sudoers", "utf8"), /env_keep \+= "[^"]*INFINITE_MISSION_ASSIGNMENT/);
  assert.match(file("infinite-work.sudoers"), /^Defaults:infinite-work-host env_keep \+= "[^"]*INFINITE_MISSION_ASSIGNMENT/m);
});

test("every wrapper path derives from the instance name", () => {
  const wrapper = file("agent-wrapper.sh");
  for (const part of ["TMPDIR=/srv/infinite-data/instances/work/tmp/agent", "COREPACK_HOME=/srv/infinite-data/instances/work/agent-home/.cache/corepack",
    "npm_config_store_dir=/srv/infinite-data/instances/work/agent-home/.pnpm-store", "infinite_load_env /usr/local/libexec/infinite-work ",
    "/opt/infinite-work/packages/host/dist/workspace-trust.js", "/srv/infinite-data/instances/work/agents/v1/bin/$provider",
    "PATH=/usr/local/libexec/infinite-work/bin:"])
    assert.ok(wrapper.includes(part), part);
});

test("rendered shell files parse", () => {
  const out = render(["--instance", "work"]);
  for (const name of ["agent-wrapper.sh", "github-app-gh.sh", "install-agent-env.sh"])
    execFileSync("sh", ["-n", join(out, name)]);
});

test("the config skeleton has the teams and hostLoad blocks and the default session limit", () => {
  const config = JSON.parse(file("config.example.json"));
  assert.equal(config.teams.workspaceDir, "/srv/infinite-data/instances/work/team-workspaces");
  assert.deepEqual(config.teams.commandPrefix, { command: "/usr/local/libexec/infinite-work/team-command", args: [] });
  assert.deepEqual(config.hostLoad, { minAvailableMemoryGiB: 8, maxLoadPerCpu: 1.5 });
  assert.equal("maxSessions" in config, false);
  assert.equal(config.port, 4781);
  assert.equal(config.runDir, "/run/infinite-work");
  assert.equal(config.origin, "https://infinite-work.YOUR-TAILNET.ts.net");
});

test("an explicit instance port is written to the config", () => {
  const config = JSON.parse(file("config.example.json", ["--instance", "work", "--port", "4890"]));
  assert.equal(config.port, 4890);
});

test("the instance GitHub wrapper uses instance identity and config but shared root-owned code", () => {
  const wrapper = file("github-app-gh.sh");
  assert.match(wrapper, /id -un\)" = infinite-work-agent/);
  assert.match(wrapper, /\/etc\/infinite-work-github\/client\.json/);
  assert.match(wrapper, /\/opt\/infinite-github-auth\/github-app-client\.mjs/);
  assert.match(wrapper, /exec \/usr\/bin\/gh/);
});

test("bad and reserved names are refused", () => {
  for (const name of ["Work", "1work", "", "a-name-longer-than-16", "work/../x", "agent", "agents", "host", "key", "github", "github-auth", "relay", "workspace", "data", "build", "brain", "backup"]) {
    const result = spawnSync(process.execPath, [renderer, "--out", tmp(), "--instance", name], { encoding: "utf8" });
    assert.equal(result.status, 64, `${name}: ${result.stderr || result.stdout}`);
    assert.equal(`${result.stderr}${result.stdout}`.trim().split("\n").length, 1, name);
  }
});
