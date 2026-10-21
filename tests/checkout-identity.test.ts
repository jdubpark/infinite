import test from "node:test";
import assert from "node:assert/strict";
import { captureIdentity, normalizeRemote, repoNameFromPath, type GitReader } from "../packages/host/src/checkout-identity.js";

test("normalizeRemote folds https, ssh, scp, credentials, and .git into one lowercase key", () => {
  const cases: [string, string][] = [
    ["https://github.com/Example/Sample.git", "Sample"],
    ["git@github.com:example/sample.git", "sample"],
    ["ssh://git@GitHub.com/example/sample", "sample"],
    ["https://user:token@github.com/example/sample", "sample"],
    ["github.com/example/sample", "sample"],
  ];
  for (const [url, repoName] of cases) assert.deepEqual(normalizeRemote(url), { key: "remote:github.com/example/sample", repoName }, url);
  assert.equal(normalizeRemote("ssh://git@github.com:22/example/sample/")?.key, "remote:github.com:22/example/sample", "a port names a different server");
  assert.notEqual(normalizeRemote("ssh://git@git.example.net:2222/team/app")?.key, normalizeRemote("ssh://git@git.example.net:2223/team/app")?.key);
  assert.equal(normalizeRemote("https://git.example.net/Team/App.git")?.key, "remote:git.example.net/Team/App", "path case is kept off GitHub");
  assert.equal(normalizeRemote(""), undefined);
  assert.equal(normalizeRemote("not a url"), undefined);
  assert.equal(normalizeRemote("https://github.com/"), undefined);
  assert.equal(normalizeRemote("/home/dev/local-only"), undefined);
});

test("repoNameFromPath skips generic folder names", () => {
  assert.equal(repoNameFromPath("/home/dev/projects/SmartAlarm/codebase"), "SmartAlarm");
  assert.equal(repoNameFromPath("/home/dev/projects/sample"), "sample");
  for (const generic of ["code", "src", "repo", "app", "main", "worktree"]) assert.equal(repoNameFromPath(`/home/dev/thing/${generic}`), "thing");
});

test("captureIdentity prefers the remote, falls back to the lowest root commit, and yields nothing when git fails", () => {
  const remote: GitReader = (_cwd, args) => args[0] === "config" ? "git@github.com:example/sample.git" : "abc";
  assert.deepEqual(captureIdentity({ id: "a", path: "/home/dev/sample" }, remote, "2026-10-21T00:00:00.000Z"),
    { projectId: "a", key: "remote:github.com/example/sample", repoName: "sample", capturedAt: "2026-10-21T00:00:00.000Z", from: "host-scan" });
  const roots: GitReader = (_cwd, args) => args[0] === "config" ? undefined : "ffff\naaaa\n";
  const rooted = captureIdentity({ id: "b", path: "/home/dev/projects/SmartAlarm/codebase" }, roots);
  assert.equal(rooted?.key, "root:aaaa");
  assert.equal(rooted?.repoName, "SmartAlarm");
  assert.equal(captureIdentity({ id: "c", path: "/home/dev/plain" }, () => undefined), undefined);
  // An unparsable remote falls through to the root commit rather than discarding the checkout.
  const odd: GitReader = (_cwd, args) => args[0] === "config" ? "nonsense" : "abcd";
  assert.equal(captureIdentity({ id: "d", path: "/home/dev/odd" }, odd)?.key, "root:abcd");
});

test("readGit captures a real repository's remote from a linked worktree too", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { readGit } = await import("../packages/host/src/checkout-identity.js");
  const root = mkdtempSync(join(tmpdir(), "identity-"));
  try {
    const main = join(root, "main");
    const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    execFileSync("git", ["init", "-q", main], { stdio: "pipe" });
    run(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "root");
    run(main, "remote", "add", "origin", "git@github.com:example/sample.git");
    run(main, "worktree", "add", "-q", "--detach", join(root, "linked"), "HEAD");
    for (const path of [main, join(root, "linked")]) {
      assert.equal(captureIdentity({ id: "x", path }, readGit)?.key, "remote:github.com/example/sample", path);
    }
    run(main, "remote", "remove", "origin");
    const rooted = captureIdentity({ id: "x", path: join(root, "linked") }, readGit);
    assert.equal(rooted?.key, `root:${run(main, "rev-list", "--max-parents=0", "HEAD").toString().trim()}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
