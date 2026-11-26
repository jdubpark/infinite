import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHost } from "./helpers.js";

const client = fileURLToPath(new URL("../scripts/cloud-check.py", import.meta.url));

function bindFixtureRunner(home: string, root: string, origin?: string) {
  const marker = "/etc/infinite-check-workspace";
  if (!existsSync(marker)) return;
  const scope = readFileSync(marker, "utf8").trim();
  const directory = join(home, ".config", "infinite", "cloud-check", "workspaces.d");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const originHashes = origin ? [createHash("sha256").update(origin).digest("hex")] : [];
  writeFileSync(join(directory, scope + ".json"), JSON.stringify({ roots: [root], originHashes, runners: ["fixture-runner"] }), { mode: 0o600 });
}

test("a test host recovers if its first listener address is taken during startup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "host-port-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const occupied = join(dir, "occupied-port");
  const preload = join(dir, "occupy-port.mjs");
  writeFileSync(preload, `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { createServer } from 'node:net';
    if (process.argv.includes('serve') && !existsSync(process.env.OCCUPIED_PORT)) {
      const config = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
      const listener = createServer();
      await new Promise(resolve => listener.listen(config.port, '127.0.0.1', resolve));
      writeFileSync(process.env.OCCUPIED_PORT, String(config.port));
      listener.unref();
    }
  `);
  const host = await startHost({ env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, OCCUPIED_PORT: occupied } });
  t.after(() => host.stop());
  assert.ok(Number(readFileSync(occupied, "utf8")) > 0);
  assert.equal((await host.fetchApi("/me")).status, 200);
});

test("a healthy test host can take more than one second to answer its readiness probe", async t => {
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
    await delay(1400);
    return fetch(...args);
  });
  const host = await startHost();
  t.after(() => host.stop());
  assert.equal((await host.fetchApi("/me")).status, 200);
});

test("cloud dispatch preserves Git layers, worktree bytes, cwd, argv and the check's exit status", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const sub = join(repo, "nested");
  mkdirSync(sub, { recursive: true });
  mkdirSync(bin);
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dir, "private-gitconfig"), PATH: `${bin}:${process.env.PATH}` };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  const launch = (...args: string[]) => spawnSync("python3", [client, "--runner", "fixture-runner", "--", ...args], { cwd: sub, env, encoding: "utf8" });
  git("init", "-q", "--template=");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("commit", "--allow-empty", "-qm", "first");
  const pkg = { name: "cloud-check-fixture", version: "1.0.0", private: true };
  writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { "": pkg } }));
  writeFileSync(join(repo, ".gitignore"), ".local/\n");
  writeFileSync(join(sub, "tracked"), "committed\n");
  writeFileSync(join(sub, "removed"), "to remove\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const head = git("rev-parse", "HEAD").trim();
  const branch = git("branch", "--show-current").trim();
  writeFileSync(join(sub, "tracked"), "staged\n");
  git("add", "nested/tracked");
  writeFileSync(join(sub, "tracked"), "working\n");
  rmSync(join(sub, "removed"));
  writeFileSync(join(sub, "odd name"), Buffer.from([0, 255]), { mode: 0o755 });
  symlinkSync("odd name", join(sub, "link"));
  mkdirSync(join(repo, ".local"));
  writeFileSync(join(repo, ".local", "private"), "excluded fixture\n");
  const before = git("status", "--porcelain=v1");

  const unenrolled = launch("touch", "unintended");
  assert.notEqual(unenrolled.status, 0);
  assert.equal(existsSync(join(sub, "unintended")), false);
  bindFixtureRunner(dir, repo);
  execFileSync("python3", [client, "--enroll", "fixture-runner"], { cwd: repo, env });
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\nfor command do :; done\nexport ANDROID_HOME=/opt/fixture-sdk\nexec sh -c "$command"\n', { mode: 0o755 });
  const linked = join(dir, "linked");
  git("worktree", "add", "-q", "--detach", linked, "HEAD");
  const linkedResult = spawnSync("python3", [client, "--runner", "fixture-runner", "--project-command", "--", "git", "rev-parse", "HEAD"], { cwd: linked, env, encoding: "utf8" });
  assert.equal(linkedResult.status, 0, linkedResult.stdout + linkedResult.stderr);
  assert.match(linkedResult.stdout, new RegExp(head));
  const proof = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const git = (...args) => require('node:child_process').execFileSync('git', args, {encoding:'utf8'}).trim();
    assert.equal(git('rev-parse','HEAD'),process.argv[1]);
    assert.equal(git('branch','--show-current'),process.argv[3]);
    assert.equal(git('rev-parse','--show-prefix'),'nested/');
    assert.equal(git('show','HEAD:nested/tracked'),'committed');
    assert.equal(git('show',':nested/tracked'),'staged');
    assert.equal(fs.readFileSync('tracked','utf8'),'working\\n');
    assert.equal(fs.existsSync('removed'),false);
    assert.equal(fs.existsSync('../.local/private'),false);
    assert.equal(fs.readlinkSync('link'),'odd name');
    assert.deepEqual([...fs.readFileSync('link')],[0,255]);
    assert.ok(fs.statSync('odd name').mode & 0o100);
    assert.equal(process.argv[2], 'literal $value & spaces');
    assert.equal(process.env.ANDROID_HOME, '/opt/fixture-sdk');
    const service = require('node:child_process').spawn('sleep', ['60'], {stdio:'ignore', detached:true});
    service.unref();
    console.log('background pid=' + service.pid);
    console.log('verified remote working tree');
    process.exit(37);
  `;
  const result = launch("node", "-e", proof, head, "literal $value & spaces", branch);
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.match(result.stdout, /verified remote working tree/);
  assert.equal(git("status", "--porcelain=v1"), before);
  const pid = /background pid=(\d+)/.exec(result.stdout)?.[1];
  assert.ok(pid);
  const service = spawnSync("ps", ["-p", pid, "-o", "stat="], { encoding: "utf8" });
  assert.ok(service.status === 1 || service.stdout.trim().startsWith("Z"), "background test service survived the check");

  writeFileSync(join(repo, ".nvmrc"), "0.0.1\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ ...pkg, packageManager: "npm@10.9.8" }));
  const wrongVersion = launch("node", "-e", "console.log('check actually ran')");
  assert.notEqual(wrongVersion.status, 0);
  assert.match(wrongVersion.stderr + wrongVersion.stdout, /Node version mismatch/);
  assert.doesNotMatch(wrongVersion.stdout, /check actually ran/);

  writeFileSync(join(repo, ".nvmrc"), process.versions.node);
  const profile = JSON.parse(readFileSync(new URL("../scripts/cloud-check/linux-runner.json", import.meta.url), "utf8"));
  mkdirSync(join(repo, "scripts/cloud-check"), { recursive: true });
  writeFileSync(join(repo, "scripts/cloud-check/linux-runner.json"), JSON.stringify({ ...profile, docker: "0.0.1" }));
  const wrongDocker = launch("node", "-e", "console.log('check actually ran')");
  assert.notEqual(wrongDocker.status, 0);
  assert.match(wrongDocker.stderr + wrongDocker.stdout, /runner docker mismatch/);
  assert.doesNotMatch(wrongDocker.stdout, /check actually ran/);
});

test("portable project enrollment follows the exact Git origin", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "portable-enrollment-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const globalConfig = join(dir, "private-global-config");
  writeFileSync(globalConfig, "");
  const env = {
    ...process.env,
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "home", ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
  };
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(join(dir, "bin"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
  const run = (cwd: string, ...args: string[]) => spawnSync("python3", [client, ...args], { cwd, env, encoding: "utf8" });
  const source = join(dir, "source");
  const primary = join(dir, "primary.git");
  const unrelatedRemote = join(dir, "unrelated.git");
  const unrelated = join(dir, "unrelated-clone");
  const clone = join(dir, "clone");
  mkdirSync(source);
  git(source, "init", "-q", "--template=");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(source, "tracked"), "portable project\n");
  git(source, "add", "tracked");
  git(source, "commit", "-qm", "fixture");
  git(source, "clone", "--bare", "-q", source, primary);
  git(source, "remote", "add", "origin", primary);
  git(source, "push", "-q", "-u", "origin", "HEAD");
  execFileSync("git", ["clone", "-q", primary, clone], { env });
  execFileSync("git", ["clone", "--bare", "-q", source, unrelatedRemote], { env });
  execFileSync("git", ["clone", "-q", unrelatedRemote, unrelated], { env });

  bindFixtureRunner(env.HOME, source, primary);
  const enrolled = run(source, "--enroll", "fixture-runner");
  assert.equal(enrolled.status, 0, enrolled.stdout + enrolled.stderr);
  writeFileSync(join(dir, "bin", "ssh"), '#!/bin/sh\nfor command do :; done\nexport ANDROID_HOME=/opt/fixture-sdk\nexec sh -c "$command"\n', { mode: 0o755 });

  if (existsSync("/etc/infinite-check-workspace")) {
    assert.match(run(clone, "--runner", "fixture-runner", "--project-command", "--", "true").stderr, /directory enrollment/);
    assert.equal(run(clone, "--enroll", "fixture-runner").status, 0);
  }
  const sameOrigin = run(clone, "--runner", "fixture-runner", "--project-command", "--", "node", "-e", "console.log('same origin accepted')");
  assert.equal(sameOrigin.status, 0, sameOrigin.stdout + sameOrigin.stderr);
  assert.match(sameOrigin.stdout, /same origin accepted/);

  const differentOrigin = run(unrelated, "--runner", "fixture-runner", "--project-command", "--", "node", "-e", "console.log('must not run')");
  assert.notEqual(differentOrigin.status, 0);
  assert.doesNotMatch(differentOrigin.stdout, /must not run/);
  assert.match(differentOrigin.stderr + differentOrigin.stdout, /enroll|origin|runner/i);
  assert.equal(readFileSync(globalConfig, "utf8").includes("fixture-runner"), true);

  const localOnly = join(dir, "local-only");
  mkdirSync(localOnly);
  git(localOnly, "init", "-q", "--template=");
  const localEnrollment = run(localOnly, "--enroll", "local-runner");
  assert.equal(localEnrollment.status, 0, localEnrollment.stdout + localEnrollment.stderr);
  assert.equal(git(localOnly, "config", "--local", "--get", "infinite.verifyHost").trim(), "local-runner");
  assert.doesNotMatch(readFileSync(globalConfig, "utf8"), /local-runner/);
});

test("a passing cloud project command is rejected when its source changes in flight", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-stale-source-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const globalConfig = join(dir, "private-global-config");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(globalConfig, "");
  const env = {
    ...process.env,
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "home", ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    PATH: `${bin}:${process.env.PATH}`,
    MUTATE_SOURCE: join(repo, "tracked"),
  };
  mkdirSync(env.HOME, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  git("init", "-q", "--template=");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "tracked"), "before\n");
  git("add", "tracked");
  git("commit", "-qm", "fixture");
  bindFixtureRunner(env.HOME, repo);
  execFileSync("python3", [client, "--enroll", "fixture-runner"], { cwd: repo, env });
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\nfor command do :; done\nprintf "changed\\n" > "$MUTATE_SOURCE"\nexec sh -c "$command"\n', { mode: 0o755 });

  const proof = "require('node:assert/strict').equal(require('node:fs').readFileSync('tracked', 'utf8'), 'before\\n'); console.log('cloud command passed')";
  const result = spawnSync("python3", [client, "--runner", "fixture-runner", "--project-command", "--", "node", "-e", proof], { cwd: repo, env, encoding: "utf8" });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /STALE/);
  assert.match(result.stdout, /cloud command passed/);
  assert.equal(readFileSync(join(repo, "tracked"), "utf8"), "changed\n");
});

test("a conflicting workspace or unconfirmed guest receives no checkout bytes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-admission-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "workspace-a", "repository");
  const other = join(dir, "workspace-b");
  const config = join(dir, "config", "infinite", "cloud-check", "workspaces.d");
  const bin = join(dir, "bin");
  const contact = join(dir, "received");
  for (const path of [repo, other, config, bin]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const env = { ...process.env, INFINITE_CLOUD_CHECK: "", HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", PATH: `${bin}:${process.env.PATH}`, CONTACT: contact };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
  const launch = (...args: string[]) => spawnSync("python3", [client, ...args, "--project-command", "--", "true"], { cwd: repo, env, encoding: "utf8" });
  const origin = join(dir, "origin-a.git");
  const foreignOrigin = join(dir, "origin-b.git");
  const homeScope = existsSync("/etc/infinite-check-workspace") ? readFileSync("/etc/infinite-check-workspace", "utf8").trim() : "scope-a";
  for (const [scope, root, url, alias] of [[homeScope, join(dir, "workspace-a"), origin, "runner-a"], ["scope-b", other, foreignOrigin, "runner-b"]]) {
    const manifest = { roots: [root], originHashes: [createHash("sha256").update(url).digest("hex")], runners: [alias] };
    writeFileSync(join(config, scope + ".json"), JSON.stringify(manifest), { mode: 0o600 });
  }
  git("init", "-q", "--template=");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "private-project-input"), "fixture source bytes\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  git("remote", "add", "origin", origin);
  writeFileSync(join(bin, "ssh"), `#!/usr/bin/env python3
import os, select, sys
ready, _, _ = select.select([0], [], [], 0.5)
with open(os.environ["CONTACT"], "wb") as receipt:
    receipt.write(os.read(0, 64) if ready else b"")
print("guest rejected workspace", flush=True)
`, { mode: 0o755 });
  assert.notEqual(launch("--runner", "runner-b").status, 0);
  assert.equal(existsSync(contact), false);
  git("remote", "set-url", "origin", foreignOrigin);
  assert.notEqual(launch("--runner", "runner-a").status, 0);
  assert.equal(existsSync(contact), false);
  git("remote", "set-url", "origin", origin);
  const rejected = launch("--runner", "runner-a");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /handshake/);
  assert.equal(readFileSync(contact).length, 0);

  rmSync(contact);
  const example = ".env.development-example";
  const approved = "TEST_TOKEN=\n";
  writeFileSync(join(repo, example), approved);
  git("add", example);
  git("commit", "-qm", "distributed example");
  const originHash = createHash("sha256").update(origin).digest("hex");
  git("config", "--global", "--add", `infiniteProject.${originHash}.envExample`, createHash("sha256").update(approved).digest("hex") + " " + example);
  assert.match(launch("--runner", "runner-a").stderr, /handshake/);
  rmSync(contact);
  writeFileSync(join(repo, example), "TEST_TOKEN=unapproved-fixture\n");
  assert.match(launch("--runner", "runner-a").stderr, /environment example/);
  assert.equal(existsSync(contact), false);
  git("add", example);
  writeFileSync(join(repo, example), approved);
  assert.match(launch("--runner", "runner-a").stderr, /environment example/);
  git("commit", "-qm", "changed example");
  git("add", example);
  assert.match(launch("--runner", "runner-a").stderr, /environment example/);
  assert.equal(existsSync(contact), false);
});

test("nested npm cannot reuse a cloud job from a different repository", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nested-cloud-job-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proof = join(dir, "unintended-command");
  const marker = join(dir, "executor");
  writeFileSync(marker, "infinite-cloud-check-v1\n");
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", INFINITE_CLOUD_CHECK: marker, npm_lifecycle_event: "test" };
  execFileSync("git", ["init", "-q", "--template="], { cwd: dir, env });
  const shell = fileURLToPath(new URL("../scripts/cloud-npm.sh", import.meta.url));
  const result = spawnSync("sh", [shell, "touch", proof], { cwd: dir, env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(proof), false);
});
