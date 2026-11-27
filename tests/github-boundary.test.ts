import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostGithubGrantEnvironment, projectGithubRepository, sessionGithubGrant, sessionGithubScope, sessionGithubScopeFor } from "../packages/host/src/github-grants.js";
import { teamCommandEnvironment } from "../packages/host/src/team-workspace.js";
import { verifyGrant } from "../scripts/github-proxy.mjs";
import { mkdtempSecure } from "./helpers.js";

const repository = "example/product";

test("without autonomy.boundary.github no session or host Git operation gets a grant, and the environment is unchanged", () => {
  const config = { autonomy: { defaultMode: "supervised" as const } };
  const session = { sessionId: "session-1", projectId: "product-web" };
  assert.equal(sessionGithubGrant(config, sessionGithubScope({ kind: "owner", repository }), session), undefined);
  const hostEnv = hostGithubGrantEnvironment(config, { sid: "publish:run-1", project: "product-web", repo: repository, ops: ["push"], refs: ["refs/heads/infinite/team-1"] });
  assert.deepEqual(hostEnv, {});
  assert.deepEqual(teamCommandEnvironment(hostEnv), teamCommandEnvironment());
  assert.equal(sessionGithubGrant({}, sessionGithubScope({ kind: "owner", repository }), session), undefined);
});

test("each session gets the grant its role allows", () => {
  const delivery = (mode: "merge" | "pr") => ({ mode, repository, headBranch: "infinite/team-abc" });
  assert.deepEqual(sessionGithubScope({ kind: "owner", repository }), { sub: "owner", repo: repository, ops: ["fetch", "push", "pr", "merge"], refs: ["refs/heads/*"] });
  assert.equal(sessionGithubScope({ kind: "owner" }), undefined);
  for (const role of ["project-manager", "scout", "implementer", "integrator", "reviewer"] as const)
    assert.deepEqual(sessionGithubScope({ kind: "team", role, repository, delivery: delivery("merge") }), { sub: `team:${role}`, repo: repository, ops: ["fetch"] });
  assert.deepEqual(sessionGithubScope({ kind: "team", role: "delivery", repository, delivery: delivery("merge") }),
    { sub: "team:delivery", repo: repository, ops: ["fetch", "push", "pr", "merge"], refs: ["refs/heads/infinite/team-abc"] });
  assert.deepEqual(sessionGithubScope({ kind: "team", role: "delivery", repository, delivery: delivery("pr") }),
    { sub: "team:delivery", repo: repository, ops: ["fetch", "push", "pr"], refs: ["refs/heads/infinite/team-abc"] });
  assert.equal(sessionGithubScope({ kind: "team", role: "mission-coordinator", repository }), undefined);
  assert.equal(sessionGithubScope({ kind: "team", role: "permission-coordinator", repository, delivery: delivery("merge") }), undefined);
  assert.equal(sessionGithubScope({ kind: "team", role: "implementer" }), undefined);

  assert.equal(projectGithubRepository({ source: { mode: "github", repository, baseBranch: "main" } }), repository);
  assert.equal(projectGithubRepository({ source: { mode: "laptop" }, team: { checks: [], delivery: { mode: "pr", repository: "example/delivered", baseBranch: "main" } } }), "example/delivered");
  assert.equal(projectGithubRepository({ source: { mode: "laptop" } }), undefined);
});

test("only a session whose creation path says the owner started it gets the owner's scope; any other caller fetches only", () => {
  const owner = { sub: "owner", repo: repository, ops: ["fetch", "push", "pr", "merge"], refs: ["refs/heads/*"] };
  const fetchOnly = { sub: "unattributed", repo: repository, ops: ["fetch"] };
  assert.deepEqual(sessionGithubScopeFor({ team: false, origin: "owner-started", repository }), owner);
  assert.deepEqual(sessionGithubScopeFor({ team: false, origin: undefined, repository }), fetchOnly);
  assert.deepEqual(sessionGithubScopeFor({ team: false, origin: { team: owner }, repository }), fetchOnly);
  assert.equal(sessionGithubScopeFor({ team: false, origin: undefined, repository: undefined }), undefined);
  const delivery = sessionGithubScope({ kind: "team", role: "delivery", repository, delivery: { mode: "pr", repository, headBranch: "infinite/team-abc" } });
  assert.deepEqual(sessionGithubScopeFor({ team: true, origin: { team: delivery }, repository }), delivery);
  assert.equal(sessionGithubScopeFor({ team: true, origin: "owner-started", repository }), undefined);
  assert.equal(sessionGithubScopeFor({ team: true, origin: undefined, repository }), undefined);
});

test("with the boundary configured, session and host grants verify in the proxy with their scope", () => {
  const root = mkdtempSecure("github-boundary-test-");
  const trustedUid = process.getuid!();
  try {
    const key = randomBytes(32);
    const keyPath = join(root, "grant.key");
    writeFileSync(keyPath, `${key.toString("hex")}\n`);
    chmodSync(keyPath, 0o640);
    const config = { autonomy: { boundary: { github: { proxyUrl: "http://127.0.0.1:8417", keyPath } } } };
    const now = Math.floor(Date.now() / 1000);

    const session = sessionGithubGrant(config, sessionGithubScope({ kind: "team", role: "delivery", repository, delivery: { mode: "pr", repository, headBranch: "infinite/team-abc" } }),
      { sessionId: "session-9", projectId: "product-web", trustedUid });
    assert.equal(session?.proxy, "http://127.0.0.1:8417");
    const verified = verifyGrant(session!.grant, key, now);
    assert.equal(verified.ok, true);
    assert.deepEqual({ ...verified.claims, exp: undefined }, { sub: "team:delivery", sid: "session-9", project: "product-web", repo: repository, ops: ["fetch", "push", "pr"], refs: ["refs/heads/infinite/team-abc"], exp: undefined });
    assert.ok(verified.claims.exp <= now + 24 * 3600 + 1);

    const hostEnv = hostGithubGrantEnvironment(config, { sid: "publish:run-1", project: "product-web", repo: repository, ops: ["push"], refs: ["refs/heads/infinite/team-1"] }, { trustedUid });
    const host = verifyGrant(hostEnv.INFINITE_GITHUB_GRANT, key, now);
    assert.equal(host.ok, true);
    assert.deepEqual(host.claims.refs, ["refs/heads/infinite/team-1"]);
    assert.equal(host.claims.project, "product-web");
    assert.ok(host.claims.exp <= now + 15 * 60 + 1);
    assert.equal(hostEnv.INFINITE_GITHUB_PROXY, "http://127.0.0.1:8417");
    assert.equal(hostEnv.GIT_CONFIG_VALUE_0, "https://github.com/");
    assert.equal(teamCommandEnvironment(hostEnv).INFINITE_GITHUB_GRANT, hostEnv.INFINITE_GITHUB_GRANT);

    if (trustedUid !== 0) assert.equal(sessionGithubGrant(config, sessionGithubScope({ kind: "owner", repository }), { sessionId: "session-10", projectId: "product-web" }), undefined);
    chmodSync(keyPath, 0o644);
    assert.equal(sessionGithubGrant(config, sessionGithubScope({ kind: "owner", repository }), { sessionId: "session-10", projectId: "product-web", trustedUid }), undefined);
    assert.deepEqual(hostGithubGrantEnvironment(config, { sid: "source:p1", project: "product-web", repo: repository, ops: ["fetch"] }, { trustedUid }), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});
