import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Project } from "../packages/host/src/types.js";
import { ProjectGroupService } from "../packages/host/src/project-groups.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { startHost, type Host } from "./helpers.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-groups-"));
  const linearProjectId = randomUUID();
  const projects: Project[] = [
    { id: "rehearsal", name: "Rehearsal", path: join(root, "apps", "alpha") },
    { id: "beta", name: "Beta", path: join(root, "apps", "beta") },
    { id: "home-one", name: "Home One", path: join(root, "home", "one") },
    { id: "home-two", name: "Home Two", path: join(root, "home", "two") },
    { id: "broad-one", name: "Broad One", path: join(root, "home", "projects", "one") },
    { id: "broad-two", name: "Broad Two", path: join(root, "home", "projects", "two") },
    { id: "shop-web", name: "Shop Web", path: join(root, "home", "work", "shop", "web") },
    { id: "shop-api", name: "Shop API", path: join(root, "home", "work", "shop", "api") },
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

test("project group persistence failures preserve memory and allow the same request to retry", () => {
  const f = fixture();
  try {
    let failWrites = true;
    const writer = (file: string, key: Buffer, scope: string, value: unknown) => {
      if (failWrites) throw new Error("Persistence unavailable.");
      writeSealed(file, key, scope, value);
    };
    const service = new ProjectGroupService(f.config, f.key, writer);
    const request = { requestId: randomUUID(), name: "Recoverable", repos: ["rehearsal", "beta"] };

    assert.throws(() => service.create(request), /Persistence unavailable/);
    assert.throws(() => service.get("recoverable"), failWith(404, "project-group-not-found"));

    failWrites = false;
    const created = service.create(request);
    assert.equal(created.id, "recoverable");
    assert.deepEqual(new ProjectGroupService(f.config, f.key).get(created.id), created);

    const updateRequest = { requestId: randomUUID(), revision: created.revision, name: "Recovered Update" };
    failWrites = true;
    assert.throws(() => service.update(created.id, updateRequest), /Persistence unavailable/);
    assert.deepEqual(service.get(created.id), created);
    failWrites = false;
    const updated = service.update(created.id, updateRequest);
    assert.equal(updated.name, "Recovered Update");
    assert.deepEqual(new ProjectGroupService(f.config, f.key).get(created.id), updated);

    const removeRequest = { requestId: randomUUID(), revision: updated.revision };
    failWrites = true;
    assert.throws(() => service.remove(created.id, removeRequest), /Persistence unavailable/);
    assert.deepEqual(service.get(created.id), updated);
    failWrites = false;
    assert.deepEqual(service.remove(created.id, removeRequest), updated);
    const restarted = new ProjectGroupService(f.config, f.key);
    assert.throws(() => restarted.get(created.id), failWith(404, "project-group-not-found"));
    assert.deepEqual(restarted.remove(created.id, removeRequest), updated);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed post-rename write is retried before a later mutation can replace its receipt", () => {
  const f = fixture();
  try {
    let failAfterWrite = true;
    let firstGroup: ReturnType<ProjectGroupService["create"]> | undefined;
    const writer = (file: string, key: Buffer, scope: string, value: unknown) => {
      if (failAfterWrite) {
        firstGroup = structuredClone((value as { groups: Record<string, ReturnType<ProjectGroupService["create"]>> }).groups.first);
        writeSealed(file, key, scope, value);
        failAfterWrite = false;
        throw new Error("Directory sync unavailable.");
      }
      writeSealed(file, key, scope, value);
    };
    const service = new ProjectGroupService(f.config, f.key, writer);
    const firstRequest = { requestId: randomUUID(), name: "First", repos: ["rehearsal", "beta"] };
    assert.throws(() => service.create(firstRequest), /Directory sync unavailable/);
    assert.throws(() => service.get("first"), failWith(404, "project-group-not-found"));

    const second = service.create({ requestId: randomUUID(), name: "Second", repos: ["home-one", "home-two"] });
    assert.equal(second.id, "second");

    const restarted = new ProjectGroupService(f.config, f.key);
    assert.deepEqual(restarted.get("first"), firstGroup);
    assert.deepEqual(restarted.create(firstRequest), firstGroup);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("deleting and recreating a group name allocates a new ID and rejects mutations to the old ID", () => {
  const f = fixture();
  try {
    const service = new ProjectGroupService(f.config, f.key);
    const created = service.create({ requestId: randomUUID(), name: "Repeated Group", repos: ["rehearsal", "beta"] });
    service.remove(created.id, { requestId: randomUUID(), revision: created.revision });
    const recreated = service.create({ requestId: randomUUID(), name: "Repeated Group", repos: ["rehearsal", "beta"] });

    assert.notEqual(recreated.id, created.id);
    assert.throws(
      () => service.update(created.id, { requestId: randomUUID(), revision: created.revision, name: "Stale edit" }),
      error => error instanceof TeamError && (error.status === 404 || error.status === 409),
    );
    assert.deepEqual(service.get(recreated.id), recreated);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy receipts reserve IDs for groups deleted before tombstones were stored", () => {
  const f = fixture();
  try {
    const request = { requestId: randomUUID(), name: "Archived Group", repos: ["rehearsal", "beta"] };
    const deleted = new ProjectGroupService(f.config, f.key).create(request);
    writeSealed(join(f.config.stateDir, "project-groups", "state.sealed"), f.key, "project-groups", {
      groups: {},
      receipts: { [request.requestId]: { fingerprint: "legacy", result: deleted } },
    });

    const migrated = new ProjectGroupService(f.config, f.key);
    const recreated = migrated.create({ ...request, requestId: randomUUID() });
    assert.notEqual(recreated.id, deleted.id);
    assert.equal(recreated.id, `${deleted.id}-2`);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("project group updates reject duplicate repository IDs without changing the group", () => {
  const f = fixture();
  try {
    const service = new ProjectGroupService(f.config, f.key);
    const created = service.create({ requestId: randomUUID(), name: "Applications", repos: ["rehearsal", "beta"] });

    assert.throws(
      () => service.update(created.id, { requestId: randomUUID(), revision: created.revision, repos: ["rehearsal", "rehearsal"] }),
      error => error instanceof Error && error.message.includes("List each repository once."),
    );
    assert.deepEqual(service.get(created.id), created);
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
    assert.ok(!result.suggestions.some(s => s.repos.some(id => id.startsWith("broad-"))), "A folder directly below home is too broad to suggest.");
    assert.ok(result.suggestions.some(s => s.reason === "shared-parent" && s.name === "shop" && s.repos.includes("shop-web") && s.repos.includes("shop-api")));
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
