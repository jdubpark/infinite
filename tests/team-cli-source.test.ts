import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { createClientApi } from "../packages/host/src/client-api.js";
import { handleTeamClientCommand, inferProjectSource, requestedDelivery } from "../packages/host/src/team-cli.js";
import { fixture as teamFixture } from "./team-fixture.js";

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
    execFileSync("git", ["-C", root, "symbolic-ref", "HEAD", "refs/heads/trunk"], { stdio: "ignore" });
    assert.deepEqual(inferProjectSource(root, undefined), { mode: "laptop" });
    assert.deepEqual(inferProjectSource(root, "github", "trunk"), { mode: "github", repository: "example/product", baseBranch: "trunk" });
    assert.deepEqual(inferProjectSource(root, undefined, "trunk"), { mode: "github", repository: "example/product", baseBranch: "trunk" });
    assert.equal(requestedDelivery(root, { "--base-branch": "trunk" }, { revision: 0 }), undefined);
    assert.throws(() => inferProjectSource(root, undefined, "bad..branch"), /safe Git branch name/);
    assert.throws(() => inferProjectSource(root, "github", "-flag"), /safe Git branch name/);
    assert.throws(() => requestedDelivery(root, { "--repository": "example/product" }, { revision: 0 }), /--repository requires --delivery merge or pr/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function initLocalRepo(root: string, content = "source snapshot\n") {
  const runGit = (...args: string[]) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  });
  runGit("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(root, "README.md"), content);
  runGit("add", "README.md");
  runGit("-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial commit");
  return runGit("rev-parse", "HEAD").trim();
}

test("repo init recovers a stranded pre-upgrade pending receipt after host-first upgrade and preserves publisherId across pre-commit retries", { timeout: 90000 }, async () => {
  const localRoot = realpathSync(mkdtempSync(join(homedir(), "infinite-cli-upgrade-repo-")));
  const cloudHome = mkdtempSync(join(tmpdir(), "infinite-cli-upgrade-cloud-"));
  const run = await teamFixture("success", undefined, { sync: { homeDir: cloudHome } });
  const configPath = join(run.host.root, "upgrade-client.json");
  const config = { origin: run.host.origin, token: run.host.tokens.owner };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const api = createClientApi(config);
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const receiptsPath = join(dirname(configPath), "team-cli", identity, "receipts.json");
  const checksJson = JSON.stringify([{ command: "git", args: ["status", "--short"] }]);
  const options = { "--check-json": checksJson, "--source": "laptop", "--permissions": "off" };
  try {
    const commit = initLocalRepo(localRoot);
    const resolved = await run.host.fetchApi("/projects/resolve", "owner", { path: relative(realpathSync(homedir()), localRoot) });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const projectId = resolved.body.id as string;

    const key = `${config.origin}\n${localRoot}`;
    const uploadKey = `${key}:source-upload:${projectId}:${commit}`;
    mkdirSync(dirname(receiptsPath), { recursive: true, mode: 0o700 });
    writeFileSync(receiptsPath, JSON.stringify({
      [uploadKey]: {
        requestId: randomUUID(),
        body: { requestId: randomUUID(), projectId, commit },
        createdAt: new Date().toISOString(),
        state: "pending",
        manifestId: "a".repeat(64),
      },
    }, null, 2), { mode: 0o600 });

    const legacyBegin = await run.host.fetchApi(`/projects/${projectId}/sync/begin`, "owner", {});
    assert.deepEqual([legacyBegin.status, legacyBegin.body.code], [400, "invalid-sync-headers"]);

    const seenPublishers: string[] = [];
    let droppedChunkOnce = false;
    const flakyUploadApi: typeof api = {
      request: async (path, body, signal, headers, method) => {
        if (!droppedChunkOnce && (path === `/projects/${projectId}/sync/blobs` || path.startsWith(`/projects/${projectId}/sync/blob/`))) {
          droppedChunkOnce = true;
          throw new Error("simulated chunk upload failure");
        }
        return api.request(path, body, signal, headers, method);
      },
      json: async <T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string, timeoutMs?: number): Promise<T> => {
        if (path === `/projects/${projectId}/sync/begin` && headers?.["X-Infinite-Sync-Publisher"]) {
          seenPublishers.push(headers["X-Infinite-Sync-Publisher"]);
        }
        return api.json<T>(path, body, signal, headers, method, timeoutMs);
      },
    };
    await assert.rejects(
      handleTeamClientCommand("repo", ["init", localRoot], options, { ...config }, flakyUploadApi, configPath, ["repo", "init", localRoot]),
      /simulated chunk upload failure/,
    );
    const savedPreparing = JSON.parse(readFileSync(receiptsPath, "utf8")) as Record<string, { state?: string; phase?: string; publisherId?: string }>;
    assert.equal(savedPreparing[uploadKey]?.state, "pending");
    assert.equal(savedPreparing[uploadKey]?.phase, "preparing");
    assert.equal(savedPreparing[uploadKey]?.publisherId, seenPublishers[0], "interrupted upload preserves its publisherId for lease resumption");

    const ok = await handleTeamClientCommand("repo", ["init", localRoot], options, { ...config }, flakyUploadApi, configPath, ["repo", "init", localRoot]);
    assert.equal(ok, true);
    assert.ok(seenPublishers.length >= 3);
    assert.equal(new Set(seenPublishers).size, 1, "retry reuses the persisted publisherId to resume the active host lease");
    const after = await run.host.fetchApi(`/projects/${projectId}`);
    assert.ok(after.body.sync.appliedManifest);
    assert.equal(readFileSync(join(after.body.path, "README.md"), "utf8"), "source snapshot\n");
    const enrolled = await run.host.fetchApi(`/projects/${projectId}/team`);
    assert.equal(enrolled.body.team.checks[0].command, "git");
    const confirmed = JSON.parse(readFileSync(receiptsPath, "utf8")) as Record<string, { state?: string }>;
    assert.equal(confirmed[uploadKey]?.state, "confirmed");
  } finally {
    await run.close();
    rmSync(localRoot, { recursive: true, force: true });
    rmSync(cloudHome, { recursive: true, force: true });
  }
});

test("repo init fences concurrent live uploads, refuses legacy receipts during an admitted commit or on an older host, and blocks uncertain post-commit retries", { timeout: 90000 }, async () => {
  const localRoot = realpathSync(mkdtempSync(join(homedir(), "infinite-cli-uncertain-repo-")));
  const cloudHome = mkdtempSync(join(tmpdir(), "infinite-cli-uncertain-cloud-"));
  const run = await teamFixture("success", undefined, { sync: { homeDir: cloudHome } });
  const configPath = join(run.host.root, "uncertain-client.json");
  const config = { origin: run.host.origin, token: run.host.tokens.owner };
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const api = createClientApi(config);
  const identity = createHash("sha256").update(`${new URL(config.origin).origin}\n${config.token}`).digest("hex");
  const receiptsPath = join(dirname(configPath), "team-cli", identity, "receipts.json");
  const checksJson = JSON.stringify([{ command: "git", args: ["status", "--short"] }]);
  const options = { "--check-json": checksJson, "--source": "laptop", "--permissions": "off" };
  try {
    const commit = initLocalRepo(localRoot, "uncertain snapshot\n");
    const resolved = await run.host.fetchApi("/projects/resolve", "owner", { path: relative(realpathSync(homedir()), localRoot) });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const projectId = resolved.body.id as string;
    const key = `${config.origin}\n${localRoot}`;
    const uploadKey = `${key}:source-upload:${projectId}:${commit}`;

    let reachedHas!: () => void;
    let releaseHas!: () => void;
    const atHas = new Promise<void>(resolve => { reachedHas = resolve; });
    const allowHas = new Promise<void>(resolve => { releaseHas = resolve; });
    const pausedApi: typeof api = {
      request: (...args) => api.request(...args),
      json: async <T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string, timeoutMs?: number): Promise<T> => {
        if (path === `/projects/${projectId}/sync/has`) {
          reachedHas();
          await allowHas;
        }
        if (path === `/projects/${projectId}/sync/commit`) throw new TypeError("fetch failed");
        return api.json<T>(path, body, signal, headers, method, timeoutMs);
      },
    };

    const firstAttempt = handleTeamClientCommand("repo", ["init", localRoot], options, { ...config }, pausedApi, configPath, ["repo", "init", localRoot]);
    await atHas;
    await assert.rejects(
      handleTeamClientCommand("repo", ["init", localRoot], options, { ...config }, api, configPath, ["repo", "init", localRoot]),
      /Another repo init source upload is already in progress/,
    );
    releaseHas();
    await assert.rejects(firstAttempt, TypeError);
    const saved = JSON.parse(readFileSync(receiptsPath, "utf8")) as Record<string, { state?: string; phase?: string }>;
    assert.deepEqual([saved[uploadKey]?.state, saved[uploadKey]?.phase], ["pending", "committing"]);

    await assert.rejects(
      handleTeamClientCommand("repo", ["init", localRoot], options, { ...config }, api, configPath, ["repo", "init", localRoot]),
      /prior source upload has an uncertain result/,
    );

    const legacyRecord = {
      requestId: randomUUID(),
      body: { requestId: randomUUID(), projectId, commit },
      createdAt: new Date().toISOString(),
      state: "pending",
      manifestId: "b".repeat(64),
    };
    writeFileSync(receiptsPath, JSON.stringify({ [uploadKey]: legacyRecord }, null, 2), { mode: 0o600 });

    const olderHostApi: typeof api = {
      request: (...args) => api.request(...args),
      json: async <T>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string, timeoutMs?: number): Promise<T> => {
        if (path === `/projects/${projectId}/sync/begin`) return { generation: randomUUID() } as T;
        return api.json<T>(path, body, signal, headers, method, timeoutMs);
      },
    };
    await assert.rejects(
      handleTeamClientCommand("repo", ["init", localRoot], options, { ...config }, olderHostApi, configPath, ["repo", "init", localRoot]),
      /prior source upload has an uncertain result/,
    );
    assert.deepEqual(JSON.parse(readFileSync(receiptsPath, "utf8"))[uploadKey], legacyRecord, "legacy receipt stays intact when host does not attest emptyConfirmed");

    const activeCommitBegin = await run.host.fetchApi(`/projects/${projectId}/sync/begin`, "owner", {}, { "X-Infinite-Sync-Publisher": randomUUID() });
    assert.equal(activeCommitBegin.status, 409, "the earlier interrupted attempt still holds an idle lease on the host");
    await assert.rejects(
      handleTeamClientCommand("repo", ["init", localRoot], options, { ...config }, api, configPath, ["repo", "init", localRoot]),
      /prior source upload has an uncertain result/,
    );
    assert.deepEqual(JSON.parse(readFileSync(receiptsPath, "utf8"))[uploadKey], legacyRecord, "legacy receipt stays intact when host refuses expectEmpty begin");
  } finally {
    await run.close();
    rmSync(localRoot, { recursive: true, force: true });
    rmSync(cloudHome, { recursive: true, force: true });
  }
});
