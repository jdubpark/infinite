import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mintGithubGrant, type GithubGrantOp } from "../packages/host/src/github-grants.js";
import { createGhBroker, createGithubProxy, validateProxyConfig } from "../scripts/github-proxy.mjs";

const TOKEN = "ghs_fixtureBrokerToken0123456789";
const root = mkdtempSync(join(tmpdir(), "github-gh-broker-test-"));
const key = randomBytes(32);
const tokenDirectory = join(root, "tokens");
mkdirSync(tokenDirectory, { mode: 0o700 });
writeFileSync(join(tokenDirectory, `${createHash("sha256").update("example/product").digest("hex")}.json`), JSON.stringify({
  schemaVersion: 1, repository: "example/product", repositoryId: 11, installationId: 22, token: TOKEN,
  expiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
  permissions: { contents: "write", pull_requests: "write", checks: "read", statuses: "read", actions: "read", metadata: "read" },
}), { mode: 0o600 });
const capture = join(root, "gh-calls.jsonl");
const lookupCapture = join(root, "gh-lookups.jsonl");
const fakeGh = join(root, "gh.mjs");
writeFileSync(fakeGh, `#!${process.execPath}
import { appendFileSync, readdirSync } from "node:fs";
let stdin = "";
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  // Pull request lookups: 12 is this repository's infinite/team-1, 13 is main, 14 comes from a fork, others are missing.
  if (args[1] === "view" && args[3] === "--json=number,headRefName,isCrossRepository") {
    appendFileSync(${JSON.stringify(lookupCapture)}, JSON.stringify(args) + "\\n");
    const pulls = { "12": ["infinite/team-1", false], "infinite/team-1": ["infinite/team-1", false], "13": ["main", false], "14": ["infinite/team-1", true] };
    const pull = pulls[args[2]];
    if (!pull) { process.stderr.write("no pull requests found\\n"); process.exit(1); }
    process.stdout.write(JSON.stringify({ number: args[2] === "infinite/team-1" ? 12 : Number(args[2]), headRefName: pull[0], isCrossRepository: pull[1] }, null, 2) + "\\n");
    return;
  }
  const env = Object.fromEntries(["GH_TOKEN", "GH_REPO", "GH_HOST", "GH_PROMPT_DISABLED", "GITHUB_TOKEN"].map(name => [name, process.env[name] ?? null]));
  appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), entries: readdirSync(process.cwd()), env, stdin }) + "\\n");
  process.stdout.write("ran with " + process.env.GH_TOKEN + "\\n");
});
`, { mode: 0o755 });

let proxy: http.Server;
let port = 0;
const records: Record<string, unknown>[] = [];
test.before(async () => {
  const config = validateProxyConfig({ listen: { host: "127.0.0.1", port: 0 }, grantKeyFile: join(root, "grant.key"), tokenDirectory, githubCli: fakeGh });
  proxy = createGithubProxy({ config, key, log: (record: Record<string, unknown>) => records.push(record), broker: createGhBroker(config) });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  port = (proxy.address() as { port: number }).port;
});
test.after(async () => {
  await new Promise(done => proxy.close(done));
  rmSync(root, { recursive: true, force: true });
});

const grant = (ops: GithubGrantOp[], refs?: string[]) => mintGithubGrant(key, { sub: "test", sid: "session-1", project: "product-web", repo: "example/product", ops, ...(refs ? { refs } : {}) });
const prGrant = grant(["fetch", "push", "pr"], ["refs/heads/infinite/*"]);
const mergeGrant = grant(["fetch", "push", "pr", "merge"], ["refs/heads/infinite/*"]);
const calls = () => existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];

async function gh(grantText: string, argv: string[], stdin?: string) {
  const response = await fetch(`http://127.0.0.1:${port}/gh`, {
    method: "POST", headers: { authorization: `Bearer ${grantText}`, "content-type": "application/json" },
    body: JSON.stringify({ argv, ...(stdin === undefined ? {} : { stdin }) }),
  });
  const text = await response.text();
  assert.equal(text.includes(TOKEN), false);
  return { status: response.status, text, json: response.ok ? JSON.parse(text) : undefined };
}

test("allowlisted pull request commands run with the grant's repository, a clean environment, and a redacted token", async () => {
  const view = await gh(prGrant, ["pr", "view", "12", "-R", "Example/Product"]);
  assert.equal(view.status, 200);
  assert.deepEqual({ code: view.json.code, stdout: view.json.stdout }, { code: 0, stdout: "ran with [redacted]\n" });
  const call = calls().at(-1);
  assert.deepEqual(call.args, ["pr", "view", "12", "--repo=example/product"]);
  assert.deepEqual(call.env, { GH_TOKEN: TOKEN, GH_REPO: null, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GITHUB_TOKEN: null });
  assert.deepEqual(call.entries, []);
  assert.equal(existsSync(call.cwd), false);
  assert.deepEqual([records.at(-1)!.project, records.at(-1)!.command, records.at(-1)!.decision], ["product-web", "pr view", "allow"]);

  const create = await gh(prGrant, ["pr", "create", "--head", "infinite/team-1", "--base", "main", "--title", "Fix it", "--body-file", "-", "--label", "a", "--label", "b"], "- first\n- second\n");
  assert.equal(create.status, 200);
  assert.deepEqual(calls().at(-1).args, ["pr", "create", "--head=infinite/team-1", "--base=main", "--title=Fix it", "--body-file=-", "--label=a", "--label=b", "--repo=example/product"]);
  assert.equal(calls().at(-1).stdin, "- first\n- second\n");
});

test("other commands, other repositories, and flags that read files, open editors or browsers, or inject flags are refused", async () => {
  const before = calls().length;
  const refused: [string[], RegExp][] = [
    [["api", "repos/example/product"], /command-refused/],
    [["issue", "list"], /command-refused/],
    [["pr", "list", "--repo=example/other"], /repository-not-granted/],
    [["pr", "view", "https://github.com/example/other/pull/1"], /selector-invalid/],
    [["pr", "view", "12", "--web"], /flag-refused:--web/],
    [["pr", "view", "12", "--jq", ".body"], /flag-refused:--jq/],
    [["pr", "view", "12", "-cw"], /flag-refused/],
    [["pr", "view", "--", "12"], /separator-refused/],
    [["pr", "checks", "12", "--watch"], /flag-refused:--watch/],
    [["pr", "comment", "12", "--body-file", "/etc/passwd"], /flag-value-refused/],
    [["pr", "create", "--head", "f", "--base", "main", "--title", "t", "--editor"], /flag-refused:--editor/],
    [["pr", "create", "--fill", "--head", "f", "--base", "main", "--title", "t"], /flag-refused:--fill/],
    [["pr", "create", "--head", "f", "--title", "t"], /flag-required:--base/],
    [["pr", "create", "--head", "f", "--base", "main", "--title", "--web"], /flag-value-missing/],
    [["pr", "create", "--head", "--repo=example/other", "--base", "main", "--title", "t"], /flag-value-missing/],
    [["pr", "view"], /selector-required/],
  ];
  for (const [argv, reason] of refused) {
    const result = await gh(prGrant, argv);
    assert.equal(result.status, 403, argv.join(" "));
    assert.match(result.text, reason, argv.join(" "));
  }
  assert.match((await gh(prGrant, ["pr", "view", "12"], "unused")).text, /stdin-unused/);
  assert.match((await gh(grant(["fetch"]), ["pr", "view", "12"])).text, /pr-not-granted/);
  assert.equal(calls().length, before);
});

test("pull request writes reach only pull requests whose head branch the grant covers", async () => {
  const before = calls().length;
  const create = ["pr", "create", "--base", "main", "--title", "t", "--body", "b"];
  assert.match((await gh(prGrant, [...create, "--head", "main"])).text, /head-not-granted/);
  assert.match((await gh(grant(["fetch", "pr"]), [...create, "--head", "infinite/team-1"])).text, /head-not-granted/);
  assert.match((await gh(prGrant, ["pr", "ready", "13"])).text, /head-not-granted/);
  assert.match((await gh(prGrant, ["pr", "comment", "14", "--body", "x"])).text, /head-not-granted:other-repository/);
  assert.match((await gh(mergeGrant, ["pr", "merge", "13", "--squash", "--match-head-commit", "a".repeat(40)])).text, /head-not-granted/);
  assert.match((await gh(prGrant, ["pr", "ready", "99"])).text, /pull-request-unresolved/);
  assert.equal(calls().length, before);

  const comment = await gh(prGrant, ["pr", "comment", "infinite/team-1", "--body", "x"]);
  assert.equal(comment.status, 200);
  assert.deepEqual(calls().at(-1).args, ["pr", "comment", "12", "--body=x", "--repo=example/product"]);
  assert.equal((await gh(prGrant, ["pr", "view", "13"])).status, 200);
  assert.deepEqual(calls().at(-1).args, ["pr", "view", "13", "--repo=example/product"]);
  const lookups = readFileSync(lookupCapture, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lookups.at(-1), ["pr", "view", "infinite/team-1", "--json=number,headRefName,isCrossRepository", "--repo=example/product"]);
});

test("a merge needs the merge operation and an exact head commit, and never admin or branch deletion", async () => {
  const sha = "a".repeat(40);
  const before = calls().length;
  assert.match((await gh(prGrant, ["pr", "merge", "12", "--squash", "--match-head-commit", sha])).text, /merge-not-granted/);
  assert.match((await gh(mergeGrant, ["pr", "merge", "12", "--squash"])).text, /flag-required:--match-head-commit/);
  assert.match((await gh(mergeGrant, ["pr", "merge", "12", "--squash", "--match-head-commit", sha, "--admin"])).text, /flag-refused:--admin/);
  assert.match((await gh(mergeGrant, ["pr", "merge", "12", "--squash", "--match-head-commit", sha, "--delete-branch"])).text, /flag-refused:--delete-branch/);
  assert.match((await gh(mergeGrant, ["pr", "merge", "12", "--squash", "--merge", "--match-head-commit", sha])).text, /flag-required/);
  assert.match((await gh(mergeGrant, ["pr", "merge", "12", "--squash", "--match-head-commit", "HEAD"])).text, /flag-value-refused/);
  assert.equal(calls().length, before);
  const merged = await gh(mergeGrant, ["pr", "merge", "12", "--squash", "--match-head-commit", sha]);
  assert.equal(merged.status, 200);
  assert.deepEqual(calls().at(-1).args, ["pr", "merge", "12", "--squash", `--match-head-commit=${sha}`, "--repo=example/product"]);
});

test("the client sends gh to the broker with the current branch as head and answers Git with the grant", async () => {
  const clientScript = resolve("scripts/github-app-client.mjs");
  const clientConfig = join(root, "client.json");
  writeFileSync(clientConfig, JSON.stringify({ tokenDirectory, githubCli: "/usr/bin/false" }), { mode: 0o600 });
  const checkout = join(root, "checkout");
  execFileSync("git", ["init", "-q", "-b", "infinite/team-2", checkout]);
  const env = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", INFINITE_GITHUB_PROXY: `http://127.0.0.1:${port}`, INFINITE_GITHUB_GRANT: prGrant };
  const run = (args: string[], input: string, extra: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(process.execPath, [clientScript, "--config", clientConfig, ...args], { cwd: checkout, env: { ...env, ...extra } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", code => done({ code, stdout, stderr }));
    child.stdin.end(input);
  });
  const created = await run(["gh", "--", "pr", "create", "--base", "main", "--title", "Ship", "--body-file", "-"], "Body\n");
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.stdout, "ran with [redacted]\n");
  assert.deepEqual(calls().at(-1).args, ["pr", "create", "--base=main", "--title=Ship", "--body-file=-", "--head=infinite/team-2", "--repo=example/product"]);
  assert.equal(calls().at(-1).stdin, "Body\n");

  const refused = await run(["gh", "--", "api", "user"], "");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /refused this gh command: .*command-refused/);

  const request = `protocol=http\nhost=127.0.0.1:${port}\n\n`;
  assert.equal((await run(["credential", "get"], request)).stdout, `username=x-infinite-grant\npassword=${prGrant}\n\n`);
  const withoutGrant = await run(["credential", "get"], request, { INFINITE_GITHUB_GRANT: "" });
  assert.deepEqual([withoutGrant.code, withoutGrant.stdout], [0, ""]);
});
