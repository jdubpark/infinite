import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "github-app-client-test-"));
const clientScript = resolve("scripts/github-app-client.mjs");
test.after(() => rmSync(root, { recursive: true, force: true }));

const permissions = { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", metadata: "read" };
const appToken = "fixture-app-token-without-whitespace";
let sequence = 0;

function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }

function fixture(repositories = ["acme/widget"]) {
  const directory = join(root, `fixture-${++sequence}`);
  const tokens = join(directory, "tokens");
  mkdirSync(tokens, { recursive: true, mode: 0o700 });
  const home = join(directory, "home");
  const xdgConfig = join(directory, "xdg-config");
  const xdgCache = join(directory, "xdg-cache");
  const ghConfig = join(directory, "gh-config");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(xdgConfig, { recursive: true, mode: 0o700 });
  mkdirSync(xdgCache, { recursive: true, mode: 0o700 });
  mkdirSync(ghConfig, { recursive: true, mode: 0o700 });
  const emptyGlobalConfig = join(directory, "empty-global-config");
  const emptySystemConfig = join(directory, "empty-system-config");
  writeFileSync(emptyGlobalConfig, "", { mode: 0o600 });
  writeFileSync(emptySystemConfig, "", { mode: 0o600 });
  const capture = join(directory, "captured.json");
  const config = join(directory, "client.json");
  const gh = join(directory, "gh-fixture");
  const fallbackMarker = join(directory, "fallback-called");
  writeFileSync(gh, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ args: process.argv.slice(2), ghToken: process.env.GH_TOKEN ?? null, githubToken: process.env.GITHUB_TOKEN ?? null, ghHost: process.env.GH_HOST ?? null, enterpriseToken: process.env.GH_ENTERPRISE_TOKEN ?? null, githubEnterpriseToken: process.env.GITHUB_ENTERPRISE_TOKEN ?? null, cwd: process.cwd() }), { mode: 0o600 });
`, { mode: 0o700 });
  chmodSync(gh, 0o700);
  const fallback = join(directory, "fallback-helper");
  writeFileSync(fallback, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv.at(-1) === "get") {
  appendFileSync(process.env.FALLBACK_MARKER, "get\\n", { mode: 0o600 });
  process.stdout.write("username=fallback-user\\npassword=fallback-secret\\n\\n");
}
`);
  writeFileSync(config, JSON.stringify({ tokenDirectory: tokens, githubCli: gh, repositories }), { mode: 0o600 });
  chmodSync(config, 0o600);
  return { directory, tokens, home, xdgConfig, xdgCache, ghConfig, emptyGlobalConfig, emptySystemConfig, capture, config, gh, fallback, fallbackMarker, repositories };
}

function isolatedEnv(f: ReturnType<typeof fixture>, overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_REPO|GH_HOST|GIT_|SSH_ASKPASS$|SSH_AUTH_SOCK$|NODE_OPTIONS$|XDG_)/u.test(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: f.home,
    XDG_CONFIG_HOME: f.xdgConfig,
    XDG_CACHE_HOME: f.xdgCache,
    GH_CONFIG_DIR: f.ghConfig,
    GIT_CONFIG_GLOBAL: f.emptyGlobalConfig,
    GIT_CONFIG_SYSTEM: f.emptySystemConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    CAPTURE_FILE: f.capture,
    FALLBACK_MARKER: f.fallbackMarker,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function cacheFile(tokens: string, repository: string) {
  const digest = createHash("sha256").update(repository.toLowerCase()).digest("hex");
  return join(tokens, `${digest}.json`);
}

function writeCache(f: ReturnType<typeof fixture>, repository = "acme/widget", overrides: Record<string, unknown> = {}) {
  const value = {
    schemaVersion: 1,
    repository,
    repositoryId: 123,
    installationId: 456,
    token: appToken,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    permissions,
    ...overrides,
  };
  writeFileSync(cacheFile(f.tokens, repository), JSON.stringify(value), { mode: 0o600 });
  chmodSync(cacheFile(f.tokens, repository), 0o600);
  return value;
}

function invoke(f: ReturnType<typeof fixture>, args: string[], options: { env?: Record<string, string | undefined>; cwd?: string; input?: string } = {}) {
  return spawnSync(process.execPath, [clientScript, "--config", f.config, ...args], {
    cwd: options.cwd ?? f.directory,
    env: isolatedEnv(f, options.env),
    input: options.input,
    encoding: "utf8",
  });
}

function captured(f: ReturnType<typeof fixture>) {
  return JSON.parse(readFileSync(f.capture, "utf8")) as { args: string[]; ghToken: string | null; githubToken: string | null; ghHost: string | null; enterpriseToken: string | null; githubEnterpriseToken: string | null; cwd: string };
}

test("configured GitHub calls receive only the scoped app token from the canonical target", () => {
  const f = fixture();
  writeCache(f);
  const origin = join(f.directory, "git-repo");
  mkdirSync(origin);
  execFileSync("git", ["init", "-q", origin], { env: isolatedEnv(f) });
  execFileSync("git", ["-C", origin, "remote", "add", "origin", "https://github.com/acme/widget.git"], { env: isolatedEnv(f) });

  const invocations = [
    { args: ["gh", "--", "issue", "list", "--repo=acme/widget"] },
    { args: ["gh", "--", "-R", "acme/widget", "pr", "list"] },
    { args: ["gh", "--", "pr", "view", "https://github.com/acme/widget/pull/17"] },
    { args: ["gh", "--", "api", "repos/acme/widget/pulls"] },
    { args: ["gh", "--", "api", "https://api.github.com/repos/acme/widget/pulls"] },
    { args: ["gh", "--", "issue", "list"], env: { GH_REPO: "acme/widget" } },
    { args: ["gh", "--", "repo", "view"], cwd: origin },
    { args: ["gh", "--", "repo", "view", "acme/widget"] },
    { args: ["gh", "--", "repo", "clone", "acme/widget"] },
  ];
  for (const item of invocations) {
    rmSync(f.capture, { force: true });
    const result = invoke(f, item.args, { cwd: item.cwd, env: { GITHUB_TOKEN: "ambient-github-token", GH_TOKEN: "ambient-gh-token", GH_ENTERPRISE_TOKEN: "enterprise-token", GITHUB_ENTERPRISE_TOKEN: "github-enterprise-token", ...item.env } });
    assert.equal(result.status, 0, "fixture GitHub CLI did not run successfully");
    const child = captured(f);
    assert.deepEqual(child.args, item.args.slice(2));
    assert.equal(child.ghToken, appToken);
    assert.equal(child.githubToken, null);
    assert.equal(child.ghHost, "github.com");
    assert.equal(child.enterpriseToken, null);
    assert.equal(child.githubEnterpriseToken, null);
    assert.equal(result.stdout.includes(appToken), false);
    assert.equal(result.stderr.includes(appToken), false);
  }
});

test("unconfigured repositories retain the original gh arguments and authentication environment", () => {
  const f = fixture();
  const args = ["gh", "--", "issue", "list", "--repo", "elsewhere/project"];
  const result = invoke(f, args, { env: { GH_TOKEN: "existing-gh-token", GITHUB_TOKEN: "existing-github-token", GH_HOST: "github.com" } });
  assert.equal(result.status, 0, "fixture GitHub CLI did not run successfully");
  assert.deepEqual(captured(f), {
    args: args.slice(2),
    ghToken: "existing-gh-token",
    githubToken: "existing-github-token",
    ghHost: "github.com",
    enterpriseToken: null,
    githubEnterpriseToken: null,
    cwd: realpathSync(f.directory),
  });
});

test("conflicting hints, unbound repository flags, and non-GitHub overrides fail before the CLI runs", () => {
  const f = fixture();
  writeCache(f);
  const cases = [
    { args: ["gh", "--", "issue", "list", "--repo=acme/widget", "https://github.com/other/repo/pull/1"], env: {} },
    { args: ["gh", "--", "pr", "view", "https://github.com/acme/widget/pull/1", "-R"], env: {} },
    { args: ["gh", "--", "issue", "list", "--repo=acme/widget"], env: { GH_REPO: "other/repo" } },
    { args: ["gh", "--", "api", "repos/other/repo/pulls", "-R", "acme/widget"], env: {} },
    { args: ["gh", "--", "api", "https://api.github.com/repos/other/repo/pulls", "-R", "acme/widget"], env: {} },
    { args: ["gh", "--", "repo", "view", "acme/widget", "-R", "other/repo"], env: {} },
    { args: ["gh", "--", "--repo=acme/widget", "api", "https://api.other.invalid/repos/acme/widget"], env: {} },
    { args: ["gh", "--", "--repo=acme/widget", "api", "--hostname=api.other.invalid", "repos/acme/widget"], env: {} },
  ];
  for (const item of cases) {
    rmSync(f.capture, { force: true });
    const result = invoke(f, item.args, { env: item.env });
    assert.notEqual(result.status, 0, JSON.stringify(item.args));
    assert.equal(existsSync(f.capture), false, "the configured CLI must not run after an ambiguous target");
  }
  rmSync(f.capture, { force: true });
  const host = invoke(f, ["gh", "--", "--repo=acme/widget", "issue", "list"], { env: { GH_HOST: "enterprise.invalid" } });
  assert.notEqual(host.status, 0);
  assert.equal(existsSync(f.capture), false);

  const originDirectory = join(f.directory, "origin-checkout");
  mkdirSync(originDirectory);
  execFileSync("git", ["init", "-q", originDirectory], { env: isolatedEnv(f) });
  execFileSync("git", ["-C", originDirectory, "remote", "add", "origin", "https://github.com:443/acme/widget.git"], { env: isolatedEnv(f) });
  const invalidOrigin = invoke(f, ["gh", "--", "repo", "view"], { cwd: originDirectory });
  assert.notEqual(invalidOrigin.status, 0, "origin validation must not fall back to existing authentication");
  assert.equal(existsSync(f.capture), false, "an invalid origin must not launch the underlying CLI");
});

test("configured cache failures never fall back to ambient credentials or spawn gh", () => {
  const f = fixture();
  const expired = new Date(Date.now() + 30_000).toISOString();
  writeCache(f, "acme/widget", { expiresAt: expired });
  let result = invoke(f, ["gh", "--", "--repo", "acme/widget", "issue", "list"], { env: { GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient" } });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.capture), false);
  assert.equal(result.stderr.includes(appToken), false);

  writeCache(f, "acme/widget", { permissions: { contents: "write" } });
  result = invoke(f, ["gh", "--", "-Racme/widget", "issue", "list"], { env: { GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient" } });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.capture), false);
});

test("credential helper emits scoped credentials, quits the helper chain on a bound cache failure, and defers other repos", () => {
  const f = fixture();
  const protocol = (path: string, host = "github.com") => `protocol=https\nhost=${host}\npath=${path}\n\n`;
  writeCache(f);
  for (const [path, host] of [["acme/widget", "github.com"], ["ACME/WIDGET.git", "GITHUB.COM"], ["acme/widget.git/", "github.com:443"]]) {
    const result = invoke(f, ["credential", "get"], { input: protocol(path, host) });
    assert.equal(result.status, 0, "credential client rejected a configured repository");
    assert.equal(result.stdout, `username=x-access-token\npassword=${appToken}\n\n`);
  }
  for (const operation of ["store", "erase"]) {
    const result = invoke(f, ["credential", operation], { input: protocol("acme/widget") });
    assert.equal(result.status, 0, "credential client rejected a no-op operation");
    assert.equal(result.stdout, "");
  }
  const unconfigured = invoke(f, ["credential", "get"], { input: protocol("acme/widget-extra") });
  assert.equal(unconfigured.status, 0);
  assert.equal(unconfigured.stdout, "");
  const nonHttps = invoke(f, ["credential", "get"], { input: "protocol=http\nhost=github.com\npath=acme/widget\n\n" });
  assert.equal(nonHttps.stdout, "");

  const helper = `!${quote(process.execPath)} ${quote(clientScript)} --config ${quote(f.config)} credential`;
  const fallback = `!${quote(process.execPath)} ${quote(f.fallback)}`;
  const git = (path: string, host = "github.com") => spawnSync("git", ["-c", "credential.helper=", "-c", "credential.useHttpPath=true", "-c", `credential.helper=${helper}`, "-c", `credential.helper=${fallback}`, "credential", "fill"], {
    cwd: f.directory,
    env: isolatedEnv(f),
    input: protocol(path, host),
    encoding: "utf8",
  });
  rmSync(f.fallbackMarker, { force: true });
  const bound = git("acme/widget");
  assert.equal(bound.status, 0, "Git credential fill failed for a valid app token");
  assert.ok(bound.stdout.includes(`password=${appToken}`), "Git did not receive the configured app token");
  assert.equal(existsSync(f.fallbackMarker), false, "Git must not ask the broader helper for a configured repository");

  for (const [path, host] of [["ACME/WIDGET.git", "GITHUB.COM"], ["acme/widget.git/", "github.com:443"]]) {
    rmSync(f.fallbackMarker, { force: true });
    const equivalent = git(path, host);
    assert.equal(equivalent.status, 0, "Git credential fill rejected an equivalent configured target");
    assert.ok(equivalent.stdout.includes(`password=${appToken}`), "equivalent GitHub credential target missed the app token");
    assert.equal(existsSync(f.fallbackMarker), false, "equivalent configured target reached the broader helper");
  }

  const other = git("acme/widget-extra");
  assert.equal(other.status, 0, "Git credential fill failed for an unconfigured repository");
  assert.ok(other.stdout.includes("password=fallback-secret"), "the existing credential helper did not serve an unconfigured repository");
  assert.equal(existsSync(f.fallbackMarker), true, "unconfigured repository credentials remain available from the existing helper");

  rmSync(cacheFile(f.tokens, "acme/widget"));
  writeCache(f, "acme/widget", { expiresAt: new Date(Date.now() + 10_000).toISOString() });
  rmSync(f.fallbackMarker, { force: true });
  const expired = git("acme/widget");
  assert.notEqual(expired.status, 0);
  assert.equal(existsSync(f.fallbackMarker), false, "quit=true must prevent fallback even if the app cache has expired");

  writeFileSync(f.config, "{ malformed", { mode: 0o600 });
  rmSync(f.fallbackMarker, { force: true });
  const malformed = git("acme/widget");
  assert.notEqual(malformed.status, 0);
  assert.equal(existsSync(f.fallbackMarker), false, "malformed client config must quit the helper chain for a configured repository");
});

test("status reports only cache state and protected files reject symlink or writable inputs", () => {
  const f = fixture(["acme/widget", "acme/other"]);
  const cacheValue = writeCache(f);
  const status = invoke(f, ["status"]);
  assert.equal(status.status, 0, "status command failed");
  const parsed = JSON.parse(status.stdout);
  assert.deepEqual(parsed.repositories, [
    { repository: "acme/widget", configured: true, cache: "ready", expiresAt: cacheValue.expiresAt },
    { repository: "acme/other", configured: true, cache: "missing" },
  ]);
  assert.equal(status.stdout.includes(appToken), false);

  const config = JSON.parse(readFileSync(f.config, "utf8"));
  chmodSync(f.config, 0o666);
  const writable = invoke(f, ["status"]);
  assert.notEqual(writable.status, 0);
  writeFileSync(f.config, JSON.stringify(config), { mode: 0o600 });
  chmodSync(f.config, 0o600);
  const linkedConfig = join(f.directory, "linked-config.json");
  symlinkSync(f.config, linkedConfig);
  const linked = spawnSync(process.execPath, [clientScript, "--config", linkedConfig, "status"], { env: isolatedEnv(f), encoding: "utf8" });
  assert.notEqual(linked.status, 0, "a symlinked client config must be refused");
  const cache = cacheFile(f.tokens, "acme/widget");
  chmodSync(cache, 0o666);
  const badCache = invoke(f, ["status", "acme/widget"]);
  assert.equal(badCache.status, 0);
  assert.equal(JSON.parse(badCache.stdout).cache, "invalid");
  chmodSync(cache, 0o600);
  const target = `${cache}.target`;
  renameSync(cache, target);
  symlinkSync(target, cache);
  const linkedCache = invoke(f, ["status", "acme/widget"]);
  assert.equal(linkedCache.status, 0);
  assert.equal(JSON.parse(linkedCache.stdout).cache, "invalid");
});
