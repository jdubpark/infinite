import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const renderer = resolve("scripts/render-instance.mjs");
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryDirectories: string[] = [];
const templateFiles = ["agent-anchor.sh", "agent-env.sh", "agent-wrapper.sh", "config.example.json", "github-app-gh.sh",
  "infinite-github-refresh.service", "infinite-github-refresh.timer", "infinite.service", "infinite.sudoers", "infinite-tmpfiles.conf", "install-agent-env.sh",
  "jevcode-wrapper.sh", "process-census.sh", "repository-graph-wrapper.py", "transcript-drain.sh"];

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

function gitTopLevel(root: string) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? realpathSync(result.stdout.trim()) : undefined;
}

function isGitCheckout(root: string) {
  return gitTopLevel(root) === realpathSync(root);
}

function gitDeployFiles(root: string) {
  return execFileSync("git", ["ls-files", "deploy/ubuntu"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)
    .map(path => path.slice("deploy/ubuntu/".length));
}

function diskDeployFiles(root: string) {
  const base = join(root, "deploy/ubuntu");
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [relative(base, path).split(sep).join("/")] : [];
  });
  return walk(base).sort();
}

function deployFiles(root = repositoryRoot) {
  return isGitCheckout(root) ? gitDeployFiles(root) : diskDeployFiles(root);
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
    "jevcode-wrapper.sh", "process-census.sh", "repository-graph-wrapper.py", "transcript-drain.sh"].sort());
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

test("the instance drain wrapper runs the instance's relay, and the instance sudoers permits instance-scoped jevcode and repository-graph", () => {
  const out = render(["--instance", "work"]);
  assert.match(readFileSync(join(out, "transcript-drain.sh"), "utf8"),
    /^exec \/usr\/local\/bin\/node \/opt\/infinite-work\/packages\/host\/dist\/hook-relay\.js drain$/m);
  const sudoers = readFileSync(join(out, "infinite-work.sudoers"), "utf8");
  assert.match(sudoers, /^infinite-work-host ALL=\(infinite-work-agent\) NOPASSWD: \/usr\/local\/libexec\/infinite-work\/transcript-drain ""$/m);
  assert.match(sudoers, /NOPASSWD: \/usr\/local\/libexec\/infinite-work\/claude \*, .*\/usr\/local\/libexec\/infinite-work\/jevcode \*/);
  assert.match(sudoers, /^infinite-work-host ALL=\(infinite-work-agent\) NOPASSWD: \/usr\/local\/libexec\/infinite-work\/repository-graph \*$/m);
  assert.doesNotMatch(sudoers, /\/usr\/local\/libexec\/infinite\/(?:jevcode|repository-graph)/);
});

test("the instance census wrapper runs the instance's census, and the instance sudoers permits it", () => {
  const out = render(["--instance", "work"]);
  assert.match(readFileSync(join(out, "process-census.sh"), "utf8"),
    /^exec \/usr\/local\/bin\/node \/opt\/infinite-work\/packages\/host\/dist\/process-census\.js$/m);
  assert.match(readFileSync(join(out, "infinite-work.sudoers"), "utf8"),
    /^infinite-work-host ALL=\(infinite-work-agent\) NOPASSWD: \/usr\/local\/libexec\/infinite-work\/process-census ""$/m);
});

test("every deploy file with a first-instance path has a per-instance template or an explicit host-level owner", () => {
  const hostLevelFiles = new Map([
    ["README.md", "the first instance's install guide; a second instance follows instances.md"],
    ["ceilings.md", "the machine's one set of provider ceilings; its deny rules cover every instance's secret paths by pattern"],
    ["ceilings/managed-settings.json", "one file for the whole machine; its deny rules cover every instance's secret paths by pattern"],
    ["backup.py", "the machine's one backup job, which reads the whole data volume"],
    ["backups.md", "documents that one backup job"],
    ["infinite-backup.service", "runs that one backup job"],
    ["infinite-instance-boundaries.service", "one machine-wide verifier compares the accounts and roots of all enrolled instances"],
    ["commissioning.md", "the record of commissioning the machine and its first instance"],
    ["github-app.md", "the first instance's GitHub App setup; instances.md gives an instance's own"],
    ["github-proxy.md", "the first instance's GitHub credential proxy; a second instance needs its own key, account, port, unit, and token directory"],
    ["public-relay.md", "the relay and the first instance's connection to it; instances.md registers an instance"],
    ["instances.md", "names first-instance paths to tell them apart from an instance's"],
    ["grader.md", "the replay grader's runbook; a second instance changes each name by hand, as its third paragraph says"],
    ["grader.sudoers", "the first instance's grader rule; a second instance writes its own from grader.md"],
    ["eval-wrapper.sh", "the first instance's eval provider wrapper; rendering the eval files for an instance is a later slice"],
    ["eval.sudoers", "the first instance's eval rule; rendering the eval files for an instance is a later slice"],
    ["eval.md", "the eval account's runbook; a second instance changes each name by hand, as its account paragraph says"],
  ]);
  const firstPath = /\/opt\/infinite\/|\/opt\/infinite-agents|\/srv\/infinite-data|\/usr\/local\/libexec\/infinite\//;
  const tracked = deployFiles();
  for (const name of hostLevelFiles.keys()) assert.ok(tracked.includes(name), `${name} is listed but not tracked`);
  const templated = new Set(readdirSync(render()));
  const unlisted = tracked.filter(name => firstPath.test(readFileSync(join("deploy/ubuntu", name), "utf8")) && !templated.has(name) && !hostLevelFiles.has(name));
  assert.deepEqual(unlisted, []);
});

function readRuleMatches(rule: string, path: string) {
  const pattern = /^Read\(\/\/(.+)\)$/.exec(rule)?.[1];
  if (!pattern) return false;
  const source = `/${pattern}`.split(/(\/\*\*$|\*)/).map(part =>
    part === "/**" ? "(?:/.*)?" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(`^${source}$`).test(path);
}

test("the machine's one Claude ceiling denies reads of every instance's secret paths without naming an instance", () => {
  const deny = (JSON.parse(readFileSync("deploy/ubuntu/ceilings/managed-settings.json", "utf8")) as { permissions: { deny: string[] } }).permissions.deny;
  const denied = (path: string) => deny.some(rule => readRuleMatches(rule, path));
  const uncovered: string[] = [];
  const expectDenied = (path: string | undefined, source: string) => {
    if (!path) uncovered.push(`no path found in ${source}`);
    else if (!denied(path)) uncovered.push(path);
  };
  for (const name of [undefined, "alpha", "a-2"]) {
    const args = name ? ["--instance", name] : [];
    const refreshName = name ? `infinite-${name}-github-refresh.service` : "infinite-github-refresh.service";
    const refresh = file(refreshName, args);
    expectDenied(/^ConditionPathExists=(\S+)$/m.exec(refresh)?.[1], `${refreshName} ConditionPathExists`);
    const tokens = /^ReadWritePaths=(\S+)$/m.exec(refresh)?.[1];
    expectDenied(tokens && `${tokens}/0123abcd.json`, `${refreshName} ReadWritePaths`);
    expectDenied((JSON.parse(file("config.example.json", args)) as { keyFile?: string }).keyFile, "config.example.json keyFile");
    const root = name ? `/srv/infinite-data/instances/${name}` : "/srv/infinite-data";
    expectDenied(`${root}/github-app/app-key`, "instances.md");
    if (name) expectDenied(`${root}/vault.key`, "instances.md");
    assert.equal(denied(`${root}/workspaces/project-a/README.md`), false);
  }
  const grantKeys = [...readFileSync("deploy/ubuntu/github-proxy.md", "utf8").matchAll(/"(?:grantKeyFile|keyPath)": "([^"]+)"/g)].map(match => match[1]);
  const egressKeys = [(JSON.parse(readFileSync("deploy/ubuntu/egress/proxy.example.json", "utf8")) as { keyFile?: string }).keyFile,
    ...[...readFileSync("deploy/ubuntu/egress.md", "utf8").matchAll(/"keyPath": "([^"]+)"/g)].map(match => match[1])];
  assert.ok(grantKeys.length > 0, "github-proxy.md names no grant key path");
  assert.ok(egressKeys.length > 1, "proxy.example.json and egress.md name no egress key path");
  for (const path of grantKeys) expectDenied(path, "github-proxy.md");
  for (const path of egressKeys) expectDenied(path, "egress/proxy.example.json or egress.md");
  assert.deepEqual(uncovered, [], "paths not covered by a Read deny rule");
  assert.equal(denied("/etc/infinite/config.example.json"), false);
  assert.deepEqual(deny.filter(rule => /instances\/(?!\*\/)/.test(rule)), []);
});

test("the disk listing of a copy of the tracked deploy files matches the Git listing", t => {
  if (!isGitCheckout(repositoryRoot)) return t.skip("the repository is not a Git checkout");
  const copy = tmp();
  const tracked = gitDeployFiles(repositoryRoot);
  for (const name of tracked) {
    const to = join(copy, "deploy/ubuntu", name);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(repositoryRoot, "deploy/ubuntu", name), to);
  }
  assert.deepEqual(diskDeployFiles(copy), tracked);
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

test("rendered shell and python wrappers parse", () => {
  const out = render(["--instance", "work"]);
  for (const name of ["agent-wrapper.sh", "github-app-gh.sh", "install-agent-env.sh", "jevcode-wrapper.sh", "process-census.sh", "transcript-drain.sh"])
    execFileSync("sh", ["-n", join(out, name)]);
  execFileSync("python3", ["-c", "import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", join(out, "repository-graph-wrapper.py")]);
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

test("rendered secondary jevcode and repository-graph wrappers scope every path to the instance", () => {
  const out = render(["--instance", "work"]);
  const jevcode = readFileSync(join(out, "jevcode-wrapper.sh"), "utf8");
  for (const part of [
    "WORKSPACES=/srv/infinite-data/instances/work/workspaces",
    "TEAM_WORKSPACES=/srv/infinite-data/instances/work/team-workspaces",
    "AGENT_HOME=/srv/infinite-data/instances/work/agent-home",
    "TMPDIR=/srv/infinite-data/instances/work/tmp/agent",
    "npm_config_store_dir=/srv/infinite-data/instances/work/agent-home/.pnpm-store",
    "COREPACK_HOME=/srv/infinite-data/instances/work/agent-home/.cache/corepack",
    "PATH=/srv/infinite-data/instances/work/agents/v1/bin:/usr/local/bin:/usr/bin:/bin",
    "exec /usr/local/bin/node /opt/jevcode-repo-agent/dist/cli.js \"$@\"",
  ]) assert.ok(jevcode.includes(part), part);

  const graph = readFileSync(join(out, "repository-graph-wrapper.py"), "utf8");
  for (const part of [
    'WORKSPACES = Path("/srv/infinite-data/instances/work/workspaces")',
    'TEAM_WORKSPACES = Path("/srv/infinite-data/instances/work/team-workspaces")',
    'CACHE = Path("/srv/infinite-data/instances/work/repository-graphs")',
    'BUILDER = "/opt/infinite-work/scripts/repository_graph.py"',
    'GRAPHIFY = "/usr/local/bin/graphify"',
    '"TMPDIR": "/srv/infinite-data/instances/work/tmp/agent"',
  ]) assert.ok(graph.includes(part), part);
});

test("secondary and primary repository-graph wrappers enforce strict instance root isolation", () => {
  const workOut = render(["--instance", "work"]);
  const workWrapper = join(workOut, "repository-graph-wrapper.py");
  const primaryWrapper = resolve("deploy/ubuntu/repository-graph-wrapper.py");
  const runGraph = (script: string, args: string[]) => spawnSync("python3", [script, ...args], { encoding: "utf8" });

  const workRefusals: Array<[string, string[]]> = [
    ["first-instance workspace", ["--repo", "/srv/infinite-data/workspaces/project-a", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["first-instance team workspace", ["--repo", "/srv/infinite-data/team-workspaces/run-1/member", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["first-instance cache", ["--repo", "/srv/infinite-data/instances/work/workspaces/project-a", "--cache-dir", "/srv/infinite-data/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["first-instance seed cache", ["--repo", "/srv/infinite-data/instances/work/workspaces/project-a", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/run-1", "--seed-cache-dir", "/srv/infinite-data/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["sibling instance workspace", ["--repo", "/srv/infinite-data/instances/other/workspaces/project-a", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["traversal to first instance", ["--repo", "/srv/infinite-data/instances/work/workspaces/../../workspaces/project-a", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["exact workspace root", ["--repo", "/srv/infinite-data/instances/work/workspaces", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["prefix sibling root", ["--repo", "/srv/infinite-data/instances/work/workspaces-evil/project-a", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["relative path", ["--repo", "project-a", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--ref", "HEAD"]],
    ["empty seed cache dir", ["--repo", "/srv/infinite-data/instances/work/workspaces/project-a", "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--seed-cache-dir", "", "--ref", "HEAD"]],
  ];
  for (const [label, args] of workRefusals) {
    const result = runGraph(workWrapper, args);
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, /Repository graph request refused: (?:The requested path is outside its assigned root|An absolute path is required)/, label);
  }

  for (const repo of ["/srv/infinite-data/instances/work/workspaces/project-a", "/srv/infinite-data/instances/work/team-workspaces/run-1/member"]) {
    const allowed = runGraph(workWrapper, ["--repo", repo, "--cache-dir", "/srv/infinite-data/instances/work/repository-graphs/lane/shared", "--ref", "HEAD"]);
    assert.doesNotMatch(allowed.stderr, /outside its assigned root|absolute path|Symlinked/, repo);
  }

  const primaryRefusal = runGraph(primaryWrapper, ["--repo", "/srv/infinite-data/instances/work/workspaces/project-a", "--cache-dir", "/srv/infinite-data/repository-graphs/lane/shared", "--ref", "HEAD"]);
  assert.notEqual(primaryRefusal.status, 0);
  assert.match(primaryRefusal.stderr, /outside its assigned root/);
  const primaryAllowed = runGraph(primaryWrapper, ["--repo", "/srv/infinite-data/workspaces/project-a", "--cache-dir", "/srv/infinite-data/repository-graphs/lane/shared", "--ref", "HEAD"]);
  assert.doesNotMatch(primaryAllowed.stderr, /outside its assigned root|absolute path|Symlinked/);

  const sandbox = tmp();
  const symlinkProbe = spawnSync("python3", [
    "-c",
    [
      "import importlib.util, os, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('rgw', sys.argv[1])",
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "base = pathlib.Path(sys.argv[2])",
      "ws = base / 'workspaces'",
      "other = base / 'other'",
      "(ws / 'real').mkdir(parents=True)",
      "other.mkdir(parents=True)",
      "(ws / 'out-link').symlink_to(other)",
      "(ws / 'in-link').symlink_to(ws / 'real')",
      "assert mod.inside(str(ws / 'real'), ws) == str((ws / 'real').resolve())",
      "for bad in [ws / 'out-link', ws / 'in-link', other, ws, ws / 'real' / '..' / 'real']:",
      "    try:",
      "        mod.inside(str(bad), ws)",
      "        raise AssertionError(f'accepted {bad}')",
      "    except ValueError:",
      "        pass",
    ].join("\n"),
    workWrapper,
    sandbox,
  ], { encoding: "utf8" });
  assert.equal(symlinkProbe.status, 0, symlinkProbe.stderr || symlinkProbe.stdout);
});

test("secondary and primary jevcode wrappers enforce strict instance root isolation", {
  skip: process.platform !== "linux" && "Ubuntu shell wrapper tests require Linux coreutils",
}, () => {
  const workOut = render(["--instance", "work"]);
  const workWrapper = join(workOut, "jevcode-wrapper.sh");
  const primaryWrapper = resolve("deploy/ubuntu/jevcode-wrapper.sh");
  const runJevcode = (script: string, args: string[], cwd = tmp()) => spawnSync("/bin/sh", [script, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
    encoding: "utf8",
  });

  const workRefusals: Array<[string, string[]]> = [
    ["first-instance workspace", ["auto", "--repo", "/srv/infinite-data/workspaces/project-a"]],
    ["first-instance workspace equals form", ["auto", "--repo=/srv/infinite-data/workspaces/project-a"]],
    ["first-instance team workspace", ["auto", "--repo", "/srv/infinite-data/team-workspaces/run-1/member"]],
    ["sibling instance workspace", ["auto", "--repo", "/srv/infinite-data/instances/other/workspaces/project-a"]],
    ["traversal to first instance", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/../../workspaces/project-a"]],
    ["exact workspace root", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces"]],
    ["prefix sibling root", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces-evil/project-a"]],
    ["duplicate repo with second escaping", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "--repo", "/srv/infinite-data/workspaces/escape"]],
    ["relative repo", ["auto", "--repo", "project-a"]],
    ["missing repo value", ["auto", "--repo"]],
    ["first-instance log path", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "--log", "/srv/infinite-data/control/state"]],
    ["unsupported state-dir flag", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "--state-dir=/srv/infinite-data/agent-home/.jevcode"]],
    ["first-instance absolute focus", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "--focus", "/srv/infinite-data/workspaces/project-a"]],
    ["traversing relative focus", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "--focus", "../../workspaces/project-a"]],
    ["flag-like focus desync", ["auto", "--focus", "--repo", "/srv/infinite-data/instances/work/agent-home/x"]],
    ["unknown flag absolute path escape", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "--transcript", "/srv/infinite-data/workspaces/project-a"]],
    ["unknown flag relative traversal", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "--transcript", "../../etc/passwd"]],
    ["unknown equals flag file url", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "--transcript=file:///srv/infinite-data/workspaces/project-a"]],
    ["short option attached path", ["auto", "-r/srv/infinite-data/workspaces/project-a"]],
    ["short option cwd override", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "-C/etc"]],
    ["extra positional traversal", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/ok", "../../etc/passwd"]],
    ["missing subcommand", ["--repo", "/srv/infinite-data/instances/work/workspaces/ok"]],
    ["implicit cwd outside root", ["show"]],
  ];
  for (const [label, args] of workRefusals) {
    const result = runJevcode(workWrapper, args);
    assert.equal(result.status, 64, `${label}: stderr=${result.stderr}`);
    assert.match(result.stderr, /^jevcode request refused:/, label);
  }

  const validWorkCases: Array<[string, string[]]> = [
    ["auto host briefing args", ["--report-usage", "auto", "--trigger", "host", "--format", "json", "--activity-stdin", "--session", "sess-1", "--repo", "/srv/infinite-data/instances/work/workspaces/project-a", "--timeout", "300", "--base", "a".repeat(40), "--runner", "codex", "--model", "meta/muse-spark-1.3-contributor"]],
    ["workspace repo with relative focus", ["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/project-a", "--focus", "packages/host"]],
    ["team workspace repo with instance log", ["auto", "--repo=/srv/infinite-data/instances/work/team-workspaces/run-1/member", "--log", "/srv/infinite-data/instances/work/tmp/agent/session.jsonl"]],
    ["brief with leading-slash question", ["brief", "--repo", "/srv/infinite-data/instances/work/workspaces/project-a", "--focus", "", "--question", "/api/sessions summary", "--format", "json", "--no-state"]],
    ["brief with equals leading-slash question", ["brief", "--repo", "/srv/infinite-data/instances/work/workspaces/project-a", "--question=/api/sessions summary", "--format", "json", "--no-state"]],
    ["context call", ["context", "--repo", "/srv/infinite-data/instances/work/workspaces/project-a"]],
  ];
  for (const [label, args] of validWorkCases) {
    const result = runJevcode(workWrapper, args);
    assert.notEqual(result.status, 64, `${label}: stderr=${result.stderr}`);
    assert.doesNotMatch(result.stderr, /^jevcode request refused:/, label);
  }

  for (const args of [["auto", "--repo", "/srv/infinite-data/instances/work/workspaces/project-a"], ["auto", "--repo", "/etc/passwd"]]) {
    const refused = runJevcode(primaryWrapper, args);
    assert.equal(refused.status, 64, args.join(" "));
    assert.match(refused.stderr, /^jevcode request refused:/);
  }
  for (const args of [["auto", "--repo", "/srv/infinite-data/workspaces/project-a"], ["auto", "--repo", "/srv/infinite-data/team-workspaces/run-1/member"]]) {
    const allowed = runJevcode(primaryWrapper, args);
    assert.notEqual(allowed.status, 64, `${args.join(" ")}: stderr=${allowed.stderr}`);
    assert.doesNotMatch(allowed.stderr, /^jevcode request refused:/);
  }

  const sb = realpathSync(tmp());
  const ws = join(sb, "workspaces");
  const realRepo = join(ws, "real-repo");
  const outside = join(sb, "outside");
  mkdirSync(join(realRepo, "src"), { recursive: true });
  mkdirSync(join(sb, "team-workspaces"), { recursive: true });
  mkdirSync(join(sb, "agent-home"), { recursive: true });
  mkdirSync(join(sb, "tmp", "agent"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(ws, "out-link"));
  symlinkSync(realRepo, join(ws, "in-link"));
  symlinkSync(outside, join(realRepo, "focus-out-link"));
  symlinkSync(join(realRepo, "src"), join(realRepo, "focus-in-link"));
  const scopedWrapper = join(sb, "jevcode-scoped.sh");
  writeFileSync(scopedWrapper, readFileSync(workWrapper, "utf8").replaceAll("/srv/infinite-data/instances/work", sb), { mode: 0o700 });

  for (const [label, args, cwd] of [
    ["symlink repo pointing outside", ["auto", "--repo", join(ws, "out-link")], sb],
    ["symlink repo pointing inside", ["auto", "--repo", join(ws, "in-link")], sb],
    ["relative focus symlink pointing outside", ["brief", "--repo", realRepo, "--focus", "focus-out-link"], sb],
    ["relative focus symlink pointing inside", ["brief", "--repo", realRepo, "--focus", "focus-in-link"], sb],
    ["cwd via symlink pointing outside", ["show"], join(ws, "out-link")],
  ] as Array<[string, string[], string]>) {
    const res = runJevcode(scopedWrapper, args, cwd);
    assert.equal(res.status, 64, `${label}: stderr=${res.stderr}`);
    assert.match(res.stderr, /^jevcode request refused:/, label);
  }
  const realOk = runJevcode(scopedWrapper, ["brief", "--repo", realRepo, "--focus", "src"], sb);
  assert.notEqual(realOk.status, 64, realOk.stderr);
  assert.doesNotMatch(realOk.stderr, /^jevcode request refused:/);
  const cwdOk = runJevcode(scopedWrapper, ["show"], realRepo);
  assert.notEqual(cwdOk.status, 64, cwdOk.stderr);
  assert.doesNotMatch(cwdOk.stderr, /^jevcode request refused:/);

  const symRootSb = realpathSync(tmp());
  const realTarget = join(symRootSb, "target");
  mkdirSync(join(realTarget, "repo"), { recursive: true });
  symlinkSync(realTarget, join(symRootSb, "workspaces"));
  mkdirSync(join(symRootSb, "team-workspaces"), { recursive: true });
  mkdirSync(join(symRootSb, "agent-home"), { recursive: true });
  mkdirSync(join(symRootSb, "tmp", "agent"), { recursive: true });
  const symRootWrapper = join(symRootSb, "jevcode-symroot.sh");
  writeFileSync(symRootWrapper, readFileSync(workWrapper, "utf8").replaceAll("/srv/infinite-data/instances/work", symRootSb), { mode: 0o700 });
  const symRootRefused = runJevcode(symRootWrapper, ["auto", "--repo", join(symRootSb, "workspaces", "repo")], symRootSb);
  assert.equal(symRootRefused.status, 64, symRootRefused.stderr);
  assert.match(symRootRefused.stderr, /^jevcode request refused: symlinked root is not supported/);
});
