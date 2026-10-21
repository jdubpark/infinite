import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHost, type Host } from "./helpers.js";

test("a host project is readable as a folded group and can start a mission", { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "project-group-alias-api-"));
  const repo = join(root, "repo"), receipts = join(root, "receipts");
  mkdirSync(repo);
  mkdirSync(receipts, { mode: 0o700 });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/Repo.git"], { cwd: repo, stdio: "ignore" });
  const strong = { provider: "claude" as const, model: "claude-opus-5-5", effort: "xhigh" as const, tier: "strong" as const };
  let host: Host | undefined;
  try {
    host = await startHost({ config: {
      agents: { claude: { command: process.execPath, args: [resolve("tests/fixtures/mission-agent.mjs"), "mission", receipts, "claude"] } },
      projects: [{ id: "repo", name: "Repo", path: repo, team: { checks: [{ command: process.execPath, args: ["-e", "0"] }] } }],
      teams: { workspaceDir: join(root, "teams"), lineup: { coordinator: { id: "coordinator", label: "Coordinator", ...strong },
        implementers: [{ id: "light", label: "Light", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
        integrator: { id: "integrator", label: "Integrator", ...strong }, reviewer: { id: "reviewer", label: "Reviewer", ...strong } } },
    } });

    const folded = await host.fetchApi("/project-groups/repo", "viewer");
    assert.equal(folded.status, 200, JSON.stringify(folded.body));
    assert.notEqual(folded.body.id, "repo", "The stored group id differs from the host project id, proving the alias resolved");
    assert.equal(folded.body.name, "Repo");
    assert.equal(folded.body.kind, "repository");
    assert.equal(folded.body.implicit, false);
    assert.deepEqual(folded.body.repos.map((item: { projectId: string }) => item.projectId), ["repo"]);
    assert.deepEqual(folded.body.repos[0].checkouts.map((item: { projectId: string }) => item.projectId), ["repo"]);

    const request = { requestId: randomUUID(), groupId: "repo", objective: "Add a feature" };
    const created = await host.fetchApi("/missions", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.groupId, folded.body.id);
    assert.equal(created.body.groupName, "Repo");
    assert.deepEqual(created.body.repoProjectIds, ["repo"]);
    const moved = await host.fetchApi("/project-groups", "owner", { requestId: randomUUID(), name: "Shop", repos: ["repo"] });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const replayed = await host.fetchApi("/missions", "owner", request);
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.equal(replayed.body.id, created.body.id, "An alias retry replays after the checkout moves to a different group");
    assert.equal(replayed.body.groupId, folded.body.id, "The recorded mission keeps its original resolved group id");
    await host.fetchApi(`/missions/${created.body.id}/cancel`, "owner", { requestId: randomUUID(), revision: created.body.revision });
  } finally {
    if (host) await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
