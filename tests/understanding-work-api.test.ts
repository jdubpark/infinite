import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startHost } from "./helpers.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { createGoalSchema, type ProductGoal } from "../packages/host/src/goal-types.js";

function initializeRepo(path: string) {
  execFileSync("git", ["init", "-q"], { cwd: path });
  execFileSync("git", ["-C", path, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Fixture"]);
  writeFileSync(join(path, "README.md"), "work brief fixture\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
}

function retainGoal(host: Awaited<ReturnType<typeof startHost>>, index: number, objective: string) {
  const request = createGoalSchema.parse({ requestId: randomUUID(), projectId: "rehearsal", title: `Recorded goal ${index}`, objective, successCriteria: "Inspect the result" });
  const { requestId: id, ...input } = request;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  const strong = { id: "fixture-strong", label: "Fixture reviewer", provider: "codex" as const, model: "fixture", tier: "strong" as const };
  const goal: ProductGoal = { ...input, id, revision: 1, status: "cancelled", createdAt: at, updatedAt: at, deadlineAt: at,
    lineup: { coordinator: strong, integrator: strong, reviewer: strong, implementers: [], escalations: [] }, cycles: [], memberCount: 0, steering: [], events: [], outcomes: [] };
  writeSealed(join(host.config.stateDir, "goals", `${id}.sealed`), readFileSync(host.config.keyFile), `goal:${id}`, { goal, fingerprint: "fixture", receipts: {} });
  return goal;
}

async function workspacePath(host: Awaited<ReturnType<typeof startHost>>) {
  const listed = await host.fetchApi("/project-groups", "viewer");
  const workspace = listed.body.groups.find((group: any) => group.repos.some((repo: any) => repo.checkouts.some((checkout: any) => checkout.projectId === "rehearsal")));
  assert.ok(workspace, "the enrolled checkout has a canonical workspace");
  return `/project-groups/${workspace.id}/understanding/work`;
}

test("work brief API serves recorded goal work to readers and keeps refresh away from viewers", { timeout: 60000 }, async () => {
  const host = await startHost();
  try {
    initializeRepo(host.config.projects[0].path);
    const goal = retainGoal(host, 0, "## Scope\n\n* one\n* two");
    await host.stopApi();
    await host.start();
    const path = await workspacePath(host);
    const workId = `goal:${goal.id}`;

    const viewer = await host.fetchApi(`${path}/${workId}`, "viewer");
    assert.equal(viewer.status, 200);
    assert.equal(viewer.body.workId, workId);
    assert.equal(viewer.body.sections[0].kind, "overview");
    const request = viewer.body.sections.find((section: any) => section.kind === "request");
    assert.ok(request, "the request section is present");
    const richBlock = request.blocks.find((block: any) => block.kind === "rich");
    assert.equal(richBlock.nodes[0].type, "heading");
    assert.equal(richBlock.nodes[0].level, 2);
    assert.equal(viewer.body.narrative.state, "unavailable");

    const controller = await host.fetchApi(`${path}/${workId}`, "controller");
    assert.equal(controller.status, 200);

    const missingTeam = await host.fetchApi(`${path}/team:${randomUUID()}`, "viewer");
    assert.equal(missingTeam.status, 404);
    assert.equal(missingTeam.body.code, "understanding-work");

    const denied = await host.fetchApi(`${path}/${workId}/refresh`, "viewer", {});
    assert.equal(denied.status, 403);

    const refreshed = await host.fetchApi(`${path}/${workId}/refresh`, "owner", {});
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.narrative.state, "unavailable");

    const malformed = await host.fetchApi(`${path}/goal:not-a-uuid`, "viewer");
    assert.equal(malformed.status, 400);
  } finally {
    await host.stop();
  }
});
