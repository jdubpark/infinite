import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Project } from "../packages/host/src/types.js";
import { ProjectGroupService } from "../packages/host/src/project-groups.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import { startHost, type Host } from "./helpers.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-groups-"));
  const linearProjectId = randomUUID();
  const projects: Project[] = [
    { id: "rehearsal", name: "Rehearsal", path: join(root, "apps", "alpha") },
    { id: "beta", name: "Beta", path: join(root, "apps", "beta") },
    { id: "home-one", name: "Home One", path: join(root, "home", "one") },
    { id: "home-two", name: "Home Two", path: join(root, "home", "two") },
    { id: "workspace-one", name: "Workspace One", path: join(root, "workspace", "one") },
    { id: "workspace-two", name: "Workspace Two", path: join(root, "workspace", "two") },
    { id: "linear-one", name: "Linear One", path: join(root, "linear", "one"), linear: { teamId: randomUUID(), projectId: linearProjectId } },
    { id: "linear-two", name: "Linear Two", path: join(root, "other-linear", "two"), linear: { teamId: randomUUID(), projectId: linearProjectId } },
  ];
  const config = { stateDir: join(root, "state"), projects, sync: { homeDir: join(root, "home") }, teams: { workspaceDir: join(root, "workspace") } } as Config;
  return { root, config, key: randomBytes(32), projects };
}

function failWith(status: number, code: string) {
  return (error: unknown) => error instanceof TeamError && error.status === status && error.code === code;
}

test("project groups create owner groups, list implicit projects, and resolve both kinds", () => {
  const f = fixture();
  try {
    const service = new ProjectGroupService(f.config, f.key);
    const implicit = service.get("beta");
    assert.equal(implicit.implicit, true);
    assert.equal(implicit.revision, 1);
    assert.deepEqual(implicit.repos.map(repo => repo.projectId), ["beta"]);

    const request = { requestId: randomUUID(), name: "Rehearsal", repos: ["rehearsal", "beta"] };
    const created = service.create(request);
    assert.equal(created.id, "rehearsal-2", "Owner group slugs reserve host project IDs.");
    assert.equal(created.implicit, false);
    assert.deepEqual(created.repos.map(repo => repo.projectId), request.repos);
    assert.equal(service.get(created.id).id, created.id);
    const list = service.list();
    assert.ok(list.groups.some(group => group.id === created.id && !group.implicit));
    assert.ok(!list.groups.some(group => group.id === "beta"), "Grouped repositories stop appearing as implicit projects.");
    assert.ok(list.groups.some(group => group.id === "home-one" && group.implicit));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("project group requests replay their stored result and reject request ID reuse with different bodies", () => {
  const f = fixture();
  try {
    const service = new ProjectGroupService(f.config, f.key);
    const request = { requestId: randomUUID(), name: "Applications", repos: ["rehearsal", "beta"] };
    const created = service.create(request);
    assert.deepEqual(service.create(request), created);
    assert.throws(() => service.create({ ...request, name: "Different" }), failWith(409, "request-conflict"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("project group updates enforce revisions and prevent a repository from joining two groups", () => {
  const f = fixture();
  try {
    const service = new ProjectGroupService(f.config, f.key);
    const first = service.create({ requestId: randomUUID(), name: "Applications", repos: ["rehearsal", "beta"] });
    assert.throws(() => service.create({ requestId: randomUUID(), name: "Conflict", repos: ["beta", "linear-one"] }), failWith(409, "project-group-repo-conflict"));
    assert.throws(() => service.create({ requestId: randomUUID(), name: "Unknown", repos: ["not-enrolled"] }), failWith(400, "unknown-project-group-repo"));
    service.create({ requestId: randomUUID(), name: "Linear repositories", repos: ["linear-one", "linear-two"] });

    const updated = service.update(first.id, { requestId: randomUUID(), revision: first.revision, name: "Product Apps" });
    assert.equal(updated.revision, first.revision + 1);
    assert.equal(updated.name, "Product Apps");
    assert.deepEqual(updated.repos.map(repo => repo.projectId), ["rehearsal", "beta"]);
    assert.throws(() => service.update(first.id, { requestId: randomUUID(), revision: first.revision, name: "Stale" }), failWith(409, "stale-project-group-revision"));
    assert.throws(() => service.update(first.id, { requestId: randomUUID(), revision: updated.revision, repos: ["beta", "linear-one"] }), failWith(409, "project-group-repo-conflict"));
    const removed = service.remove(first.id, { requestId: randomUUID(), revision: updated.revision });
    assert.equal(removed.id, first.id);
    assert.equal(service.get("rehearsal").implicit, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("group suggestions cover shared parents and Linear projects while excluding home and workspace roots", () => {
  const f = fixture();
  try {
    const result = new ProjectGroupService(f.config, f.key).list();
    assert.ok(result.suggestions.some(s => s.reason === "shared-parent" && s.name === "apps" && s.repos.includes("rehearsal") && s.repos.includes("beta")));
    assert.ok(!result.suggestions.some(s => s.reason === "shared-parent" && s.repos.some(id => id.startsWith("home-"))));
    assert.ok(!result.suggestions.some(s => s.reason === "shared-parent" && s.repos.some(id => id.startsWith("workspace-"))));
    assert.ok(result.suggestions.some(s => s.reason === "shared-linear-project" && s.name === "Linear One" && s.repos.includes("linear-one") && s.repos.includes("linear-two")));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("sealed project groups and request receipts survive a service restart", () => {
  const f = fixture();
  try {
    const request = { requestId: randomUUID(), name: "Applications", repos: ["rehearsal", "beta"] };
    const created = new ProjectGroupService(f.config, f.key).create(request);
    const restarted = new ProjectGroupService(f.config, f.key);
    assert.deepEqual(restarted.get(created.id), created);
    assert.deepEqual(restarted.create(request), created);
    assert.throws(() => restarted.create({ ...request, name: "Different" }), failWith(409, "request-conflict"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("project group API exposes reads to paired roles and restricts all mutations to owners", async () => {
  const f = fixture();
  let host: Host | undefined;
  try {
    const projects = f.projects.map(({ id, name, path }) => ({ id, name, path }));
    host = await startHost({ config: { projects, sync: f.config.sync, teams: f.config.teams, stateDir: join(f.root, "api-state") } });
    assert.equal((await host.fetchApi("/project-groups", "viewer")).status, 200);
    assert.equal((await host.fetchApi("/project-groups", "controller")).status, 200);
    const request = { requestId: randomUUID(), name: "Applications", repos: ["rehearsal", "beta"] };
    assert.equal((await host.fetchApi("/project-groups", "controller", request)).status, 403);
    const created = await host.fetchApi("/project-groups", "owner", request);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const update = { requestId: randomUUID(), revision: created.body.revision, name: "Product Apps" };
    assert.equal((await host.fetchApi(`/project-groups/${created.body.id}`, "viewer", update, {}, "PUT")).status, 403);
    const updated = await host.fetchApi(`/project-groups/${created.body.id}`, "owner", update, {}, "PUT");
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const remove = { requestId: randomUUID(), revision: updated.body.revision };
    assert.equal((await host.fetchApi(`/project-groups/${created.body.id}`, "controller", remove, {}, "DELETE")).status, 403);
    assert.equal((await host.fetchApi(`/project-groups/${created.body.id}`, "owner", remove, {}, "DELETE")).status, 200);
  } finally {
    if (host) await host.stop();
    rmSync(f.root, { recursive: true, force: true });
  }
});
