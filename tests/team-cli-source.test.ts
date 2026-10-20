import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inferProjectSource, requestedDelivery } from "../packages/host/src/team-cli.js";

function makeRepository(origin?: string) {
  const root = mkdtempSync(join(tmpdir(), "infinite-team-cli-source-"));
  const runGit = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  });
  try {
    runGit("init", "--quiet");
    if (origin !== undefined) {
      runGit("config", "--local", "remote.origin.url", origin);
      runGit("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("repo init infers GitHub source and the origin default branch from a credential-free HTTPS origin", () => {
  const root = makeRepository("https://github.com/example/product.git");
  try {
    assert.deepEqual(inferProjectSource(root, undefined), {
      mode: "github",
      repository: "example/product",
      baseBranch: "main",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo init falls back to laptop for a credentialed origin without exposing its credentials", () => {
  const root = makeRepository("https://user:token@github.com/example/product.git");
  try {
    const inferred = inferProjectSource(root, undefined);
    assert.deepEqual(inferred, { mode: "laptop" });
    assert.doesNotThrow(() => inferProjectSource(root, undefined));
    assert.doesNotMatch(JSON.stringify(inferred), /user:token|github\.com/);
    assert.throws(() => inferProjectSource(root, "github"), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Git origin must be an HTTPS or SSH github\.com/);
      assert.doesNotMatch(error.message, /user:token|product\.git/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo init defaults to laptop when the repository has no origin", () => {
  const root = makeRepository();
  try {
    assert.deepEqual(inferProjectSource(root, undefined), { mode: "laptop" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR delivery accepts repository and base branch targets", () => {
  const delivery = requestedDelivery("/unused", {
    "--delivery": "pr",
    "--repository": "example/product",
    "--base-branch": "main",
  }, { revision: 0 });
  assert.deepEqual(delivery, { mode: "pr", repository: "example/product", baseBranch: "main" });
});

test("PR delivery rejects merge-method with its bounded option error", () => {
  assert.throws(() => requestedDelivery("/unused", {
    "--delivery": "pr",
    "--repository": "example/product",
    "--base-branch": "main",
    "--merge-method": "squash",
  }, { revision: 0 }), { message: "--merge-method applies only to --delivery merge." });
});

test("repo init takes --base-branch as the followed branch when origin/HEAD is missing, with or without delivery", () => {
  const root = makeRepository("https://github.com/example/product.git");
  try {
    execFileSync("git", ["-C", root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], { stdio: "ignore" });
    // No origin/HEAD and a local branch that is neither main nor master: nothing to infer the followed branch from.
    execFileSync("git", ["-C", root, "symbolic-ref", "HEAD", "refs/heads/trunk"], { stdio: "ignore" });
    assert.deepEqual(inferProjectSource(root, undefined), { mode: "laptop" });
    assert.deepEqual(inferProjectSource(root, "github", "trunk"), { mode: "github", repository: "example/product", baseBranch: "trunk" });
    assert.deepEqual(inferProjectSource(root, undefined, "trunk"), { mode: "github", repository: "example/product", baseBranch: "trunk" });
    assert.equal(requestedDelivery(root, { "--base-branch": "trunk" }, { revision: 0 }), undefined);
    assert.throws(() => requestedDelivery(root, { "--repository": "example/product" }, { revision: 0 }), /--repository requires --delivery merge or pr/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
