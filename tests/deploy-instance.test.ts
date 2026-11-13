import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const renderer = resolve("scripts/render-instance.mjs");
const temporaryDirectories: string[] = [];
const templateFiles = ["agent-anchor.sh", "agent-env.sh", "agent-wrapper.sh", "config.example.json", "github-app-gh.sh",
  "infinite-github-refresh.service", "infinite-github-refresh.timer", "infinite.service", "infinite.sudoers", "infinite-tmpfiles.conf", "install-agent-env.sh",
  "transcript-drain.sh"];

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
    "infinite-work-github-refresh.service", "infinite-work-github-refresh.timer", "infinite-work.service", "infinite-work.sudoers", "infinite-work-tmpfiles.conf", "install-agent-env.sh",
    "transcript-drain.sh"].sort());
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

test("the instance drain wrapper runs the instance's relay, and the instance sudoers permits it and neither jevcode nor repository-graph", () => {
  const out = render(["--instance", "work"]);
  assert.match(readFileSync(join(out, "transcript-drain.sh"), "utf8"),
    /^exec \/usr\/local\/bin\/node \/opt\/infinite-work\/packages\/host\/dist\/hook-relay\.js drain$/m);
  const sudoers = readFileSync(join(out, "infinite-work.sudoers"), "utf8");
  assert.match(sudoers, /^infinite-work-host ALL=\(infinite-work-agent\) NOPASSWD: \/usr\/local\/libexec\/infinite-work\/transcript-drain ""$/m);
  assert.match(sudoers, /NOPASSWD: \/usr\/local\/libexec\/infinite-work\/claude \*, /);
  assert.doesNotMatch(sudoers, /jevcode|repository-graph/);
});

test("every tracked deploy file that names a first-instance path is rendered for an instance or kept for the first instance only", () => {
  const firstInstanceOnly = new Map([
    ["README.md", "the first instance's install guide; a second instance follows instances.md"],
    ["backup.py", "the machine's one backup job, which reads the whole data volume"],
    ["backups.md", "documents that one backup job"],
    ["infinite-backup.service", "runs that one backup job"],
    ["commissioning.md", "the record of commissioning the machine and its first instance"],
    ["github-app.md", "the first instance's GitHub App setup; instances.md gives an instance's own"],
    ["public-relay.md", "the relay and the first instance's connection to it; instances.md registers an instance"],
    ["instances.md", "names first-instance paths to tell them apart from an instance's"],
    ["jevcode-wrapper.sh", "repository briefings, which an instance runs without until an instance wrapper exists"],
    ["repository-graph-wrapper.py", "the code graph, which an instance runs without until an instance wrapper exists"],
  ]);
  const firstPath = /\/opt\/infinite\/|\/opt\/infinite-agents|\/srv\/infinite-data|\/usr\/local\/libexec\/infinite\//;
  const tracked = execFileSync("git", ["ls-files", "deploy/ubuntu"], { encoding: "utf8" }).split("\n").filter(Boolean)
    .map(path => path.slice("deploy/ubuntu/".length));
  for (const name of firstInstanceOnly.keys()) assert.ok(tracked.includes(name), `${name} is listed but not tracked`);
  const templated = new Set(readdirSync(render()));
  const unlisted = tracked.filter(name => firstPath.test(readFileSync(join("deploy/ubuntu", name), "utf8")) && !templated.has(name) && !firstInstanceOnly.has(name));
  assert.deepEqual(unlisted, []);
});

test("every wrapper path derives from the instance name", () => {
  const wrapper = file("agent-wrapper.sh");
  for (const part of ["TMPDIR=/srv/infinite-data/instances/work/tmp/agent", "COREPACK_HOME=/srv/infinite-data/instances/work/agent-home/.cache/corepack",
    "npm_config_store_dir=/srv/infinite-data/instances/work/agent-home/.pnpm-store", "infinite_load_env /usr/local/libexec/infinite-work ",
    "/opt/infinite-work/packages/host/dist/workspace-trust.js", "/srv/infinite-data/instances/work/agents/v1/bin/$provider",
    "PATH=/usr/local/libexec/infinite-work/bin:"])
    assert.ok(wrapper.includes(part), part);
});

test("valid names that overlap template words are substituted only once", async t => {
  for (const name of ["host2", "agent2", "workspace2"]) await t.test(name, () => {
    const out = render(["--instance", name]);
    const files = readdirSync(out);
    assert.ok(files.includes(`infinite-${name}.service`), name);
    const unit = readFileSync(join(out, `infinite-${name}.service`), "utf8");
    assert.match(unit, new RegExp(`\\nUser=infinite-${name}-host\\n`), name);
    const config = JSON.parse(readFileSync(join(out, "config.example.json"), "utf8"));
    assert.equal(config.runDir, `/run/infinite-${name}`, name);
    const wrapper = readFileSync(join(out, "agent-wrapper.sh"), "utf8");
    assert.ok(wrapper.includes(`/opt/infinite-${name}/packages/host/dist/workspace-trust.js`), name);
    for (const filename of files) {
      const text = readFileSync(join(out, filename), "utf8");
      assert.ok(!text.includes(`-${name}-${name}`), `${filename} contains doubled ${name}`);
    }
  });
});

test("rendered shell files parse", () => {
  const out = render(["--instance", "work"]);
  for (const name of ["agent-wrapper.sh", "github-app-gh.sh", "install-agent-env.sh", "transcript-drain.sh"])
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
