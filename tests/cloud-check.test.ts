import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startHost } from "./helpers.js";

const client = fileURLToPath(new URL("../scripts/cloud-check.py", import.meta.url));

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

test("cloud dispatch preserves Git layers, worktree bytes, cwd, argv and the check's exit status", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const sub = join(repo, "nested");
  mkdirSync(sub, { recursive: true });
  mkdirSync(bin);
  const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", PATH: `${bin}:${process.env.PATH}` };
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
  git("config", "--add", "infinite.verifyHost", "fixture-runner");
  writeFileSync(join(bin, "ssh"), '#!/bin/sh\nfor command do :; done\nexport ANDROID_HOME=/opt/fixture-sdk\nexec sh -c "$command"\n', { mode: 0o755 });
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
