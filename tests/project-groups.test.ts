import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Project } from "../packages/host/src/types.js";
import { ProjectGroupService } from "../packages/host/src/project-groups.js";
import type { GitReader } from "../packages/host/src/checkout-identity.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import { writeSealed } from "../packages/host/src/vault.js";
import { startHost, type Host } from "./helpers.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "project-groups-"));
  const linearProjectId = randomUUID();
  const projects: Project[] = [
    { id: "rehearsal", name: "Rehearsal", path: join(root, "apps", "alpha") },
    { id: "alpha-codex", name: "Alpha Codex", path: join(root, "apps", "alpha-codex") },
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
  const applied: Record<string, string | undefined> = {};
  const calls = new Map<string, number>();
  const git: GitReader = (cwd, args) => {
    calls.set(cwd, (calls.get(cwd) ?? 0) + 1);
    const id = projects.find(project => project.path === cwd)?.id;
    if (id === "rehearsal" || id === "alpha-codex") return args[0] === "config" ? "git@github.com:example/alpha.git" : undefined;
    if (id === "beta") return args[0] === "config" ? "https://github.com/example/beta.git" : undefined;
    if (id === "linear-one") return args[0] === "config" ? undefined : "bbbb\naaaa";
    return undefined;
  };
  let clock = Date.now();
  const options = (extra: { git?: GitReader; appliedAt?: (projectId: string) => string | undefined; now?: () => number } = {}) => ({
    git: extra.git ?? git,
    appliedAt: extra.appliedAt ?? (projectId => applied[projectId]),
    now: extra.now ?? (() => clock),
  });
  const service = (writer?: (file: string, key: Buffer, scope: string, value: unknown) => void, extra: Parameters<typeof options>[0] = {}) =>
    new ProjectGroupService(config, key, writer, options(extra));
  const key = randomBytes(32);
  return { root, config, key, projects, applied, calls, git, options, service, get clock() { return clock; }, set clock(value: number) { clock = value; } };
}

function failWith(status: number, code: string) {
  return (error: unknown) => error instanceof TeamError && error.status === status && error.code === code;
}

test("checkouts of one remote fold into one repository group with a stable id and a primary", () => {
  const f = fixture();
  try {
    f.applied.rehearsal = "2026-10-20T10:00:00.000Z";
    f.applied["alpha-codex"] = "2026-10-21T10:00:00.000Z";
    const service = f.service();
    const group = service.list().groups.find(value => value.id === "alpha");
    assert.ok(group);
    assert.equal(group.kind, "repository");
    assert.equal(group.hidden, false);
    assert.equal(group.repos.length, 1);
    assert.deepEqual(group.repos[0]!.checkouts.map(checkout => checkout.projectId), ["alpha-codex", "rehearsal"]);
    assert.equal(group.repos[0]!.projectId, "alpha-codex");
    assert.equal(group.repos[0]!.key, "remote:github.com/example/alpha");
    assert.equal(f.service().get("rehearsal").id, "alpha");
    assert.equal(f.service().list().groups.find(value => value.id === "alpha")?.id, group.id);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("SSH and HTTPS forms and a root-only identity fold, while an identity-less checkout stays implicit", () => {
  const f = fixture();
  try {
    const list = f.service().list();
    const alpha = list.groups.find(group => group.id === "alpha")!;
    const beta = list.groups.find(group => group.id === "beta-2")!;
    const linear = list.groups.find(group => group.repos.some(repo => repo.key === "root:aaaa"))!;
    const home = list.groups.find(group => group.id === "home-one")!;
    assert.deepEqual(alpha.repos[0]!.checkouts.map(checkout => checkout.projectId), ["rehearsal", "alpha-codex"]);
    assert.equal(beta.kind, "repository");
    assert.equal(beta.repos[0]!.key, "remote:github.com/example/beta");
    assert.equal(linear.repos[0]!.key, "root:aaaa");
    assert.equal(home.kind, "implicit");
    assert.equal(home.implicit, true);
    assert.equal(home.repos[0]!.key, undefined);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rename, hide, primary, detach, move, and delete persist across a restart", () => {
  const f = fixture();
  try {
    const service = f.service();
    const alpha = service.get("alpha");
    const renamed = service.update(alpha.id, {
      requestId: randomUUID(), revision: alpha.revision, name: "Alpha product", hidden: true, primary: ["alpha-codex"],
    });
    assert.equal(renamed.name, "Alpha product");
    assert.equal(renamed.hidden, true);
    assert.equal(renamed.repos[0]!.projectId, "alpha-codex");
    const detached = service.update(renamed.id, {
      requestId: randomUUID(), revision: renamed.revision, repos: ["rehearsal"],
    });
    assert.deepEqual(detached.repos.flatMap(repo => repo.checkouts.map(checkout => checkout.projectId)), ["rehearsal"]);
    const afterDetach = service.list();
    assert.equal(afterDetach.groups.find(group => group.id === "alpha")?.hidden, true);
    assert.equal(afterDetach.groups.find(group => group.id === "alpha-2")?.repos[0]?.projectId, "alpha-codex");

    const shop = service.create({ requestId: randomUUID(), name: "Shop", repos: ["shop-web", "shop-api"] });
    assert.equal(shop.kind, "owner");
    assert.equal(shop.repos.length, 2);
    service.remove(shop.id, { requestId: randomUUID(), revision: shop.revision });
    const expected = service.list();
    const restarted = f.service().list();
    assert.deepEqual(restarted, expected);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a checkout in an owner group cannot be pulled into another group", () => {
  const f = fixture();
  try {
    const service = f.service();
    const first = service.create({ requestId: randomUUID(), name: "Applications", repos: ["rehearsal"] });
    const target = service.create({ requestId: randomUUID(), name: "Workspace", repos: ["home-one", "home-two"] });
    const before = service.list();
    assert.throws(() => service.update(target.id, {
      requestId: randomUUID(), revision: target.revision, repos: ["home-one", "rehearsal"],
    }), failWith(409, "project-group-repo-conflict"));
    assert.deepEqual(service.list(), before);
    assert.equal(service.get("rehearsal").id, first.id);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("primary must name a member and at most one checkout per repository", () => {
  const f = fixture();
  try {
    const service = f.service();
    const group = service.create({ requestId: randomUUID(), name: "Alpha and Beta", repos: ["rehearsal", "alpha-codex", "beta"] });
    const before = service.get(group.id);
    assert.throws(() => service.update(group.id, {
      requestId: randomUUID(), revision: group.revision, primary: ["rehearsal", "alpha-codex"],
    }), failWith(400, "project-group-primary-invalid"));
    assert.throws(() => service.update(group.id, {
      requestId: randomUUID(), revision: group.revision, primary: ["rehearsal", "rehearsal"],
    }), failWith(400, "project-group-primary-invalid"));
    assert.throws(() => service.update(group.id, {
      requestId: randomUUID(), revision: group.revision, primary: ["home-two"],
    }), failWith(400, "project-group-primary-invalid"));
    assert.deepEqual(service.get(group.id), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed identity capture is throttled for a minute and retried afterward", () => {
  const f = fixture();
  try {
    const late: Project = { id: "late", name: "Late", path: join(f.root, "late") };
    f.projects.push(late);
    let available = false;
    let lateCalls = 0;
    const git: GitReader = (cwd, args) => {
      if (cwd !== late.path) return undefined;
      lateCalls++;
      return available && args[0] === "config" ? "https://github.com/example/late.git" : undefined;
    };
    const service = f.service(undefined, { git, now: () => f.clock });
    assert.equal(service.list().groups.find(group => group.id === "late")?.kind, "implicit");
    assert.equal(lateCalls, 2);
    available = true;
    assert.equal(service.list().groups.find(group => group.id === "late")?.kind, "implicit");
    assert.equal(lateCalls, 2, "a failed capture must not call Git again within sixty seconds");
    f.clock += 61_000;
    assert.equal(service.list().groups.find(group => group.id === "late-2")?.kind, "repository");
    assert.equal(service.containing("late")?.id, "late-2");
    assert.equal(lateCalls, 3);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a newly identified checkout joins the fullest matching group, then the earliest group on a tie", () => {
  const f = fixture();
  try {
    const ids = ["share-a", "share-b", "share-c", "share-d", "share-e"];
    const projects = ids.map(id => ({ id, name: id, path: join(f.root, "shared", id) }));
    f.config.projects = projects;
    const git: GitReader = (_cwd, args) => args[0] === "config" ? "https://github.com/example/shared.git" : undefined;
    f.service(undefined, { git }).list();
    writeSealed(join(f.config.stateDir, "project-groups", "state.sealed"), f.key, "project-groups", {
      groups: {
        older: { id: "older", name: "Older", kind: "repository", hidden: false, members: ["share-a", "share-b"], detached: [], primary: {}, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        fuller: { id: "fuller", name: "Fuller", kind: "repository", hidden: false, members: ["share-c", "share-d", "share-e"], detached: [], primary: {}, revision: 1, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
      },
      receipts: {}, tombstones: [],
    });
    f.config.projects.push({ id: "share-fresh", name: "Fresh", path: join(f.root, "shared", "fresh") });
    const reloaded = f.service(undefined, { git }).list();
    assert.equal(reloaded.groups.find(group => group.id === "fuller")?.repos[0]?.checkouts.some(checkout => checkout.projectId === "share-fresh"), true);
    assert.equal(reloaded.groups.find(group => group.id === "fuller")?.revision, 2);

    writeSealed(join(f.config.stateDir, "project-groups", "state.sealed"), f.key, "project-groups", {
      groups: {
        older: { id: "older", name: "Older", kind: "repository", hidden: false, members: ["share-a", "share-b", "share-c"], detached: [], primary: {}, revision: 4, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
        fuller: { id: "fuller", name: "Fuller", kind: "repository", hidden: false, members: ["share-d", "share-e", "share-fresh"], detached: [], primary: {}, revision: 3, createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
      },
      receipts: {}, tombstones: [],
    });
    f.config.projects.push({ id: "share-tie", name: "Tie", path: join(f.root, "shared", "tie") });
    const tied = f.service(undefined, { git }).list();
    assert.equal(tied.groups.find(group => group.id === "older")?.repos[0]?.checkouts.some(checkout => checkout.projectId === "share-tie"), true);
    assert.equal(tied.groups.find(group => group.id === "older")?.revision, 5);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("repository groups with the same default name get distinct stable ids", () => {
  const f = fixture();
  try {
    f.config.projects = [
      { id: "sample-one", name: "Sample One", path: join(f.root, "one") },
      { id: "sample-two", name: "Sample Two", path: join(f.root, "two") },
    ];
    const git: GitReader = (cwd) => cwd === f.config.projects[0]!.path
      ? "https://github.com/example/sample.git"
      : "https://gitlab.com/example/sample.git";
    const first = f.service(undefined, { git }).list().groups.filter(group => group.kind === "repository").map(group => group.id);
    assert.deepEqual(first, ["sample", "sample-2"]);
    const second = f.service(undefined, { git }).list().groups.filter(group => group.kind === "repository").map(group => group.id);
    assert.deepEqual(second, first);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("get resolves a host project id to its folded group and containing names the holder", () => {
  const f = fixture();
  try {
    const service = f.service();
    assert.equal(service.get("alpha-codex").id, "alpha");
    assert.deepEqual(service.containing("rehearsal"), { id: "alpha", name: "alpha" });
    assert.deepEqual(service.containing("home-one"), { id: "home-one", name: "Home One" });
    assert.equal(service.containing("unlisted"), undefined);
    assert.throws(() => service.get("unlisted"), failWith(404, "project-group-not-found"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("suggestions span repository and implicit groups and list all checkouts, never owner groups", () => {
  const f = fixture();
  try {
    const service = f.service();
    const result = service.list();
    const shop = result.suggestions.find(suggestion => suggestion.name === "shop" && suggestion.reason === "shared-parent");
    assert.ok(shop);
    assert.deepEqual(shop.groupIds, ["shop-api", "shop-web"]);
    assert.deepEqual(shop.repos, ["shop-api", "shop-web"]);
    assert.ok(result.suggestions.some(suggestion => suggestion.reason === "shared-parent" && suggestion.repos.includes("rehearsal") && suggestion.repos.includes("alpha-codex") && suggestion.repos.includes("beta")));
    assert.ok(result.suggestions.some(suggestion => suggestion.reason === "shared-linear-project" && suggestion.name === "Linear One" && suggestion.repos.includes("linear-one") && suggestion.repos.includes("linear-two")));
    const owner = service.create({ requestId: randomUUID(), name: "Shop project", repos: ["shop-web", "shop-api"] });
    assert.equal(owner.kind, "owner");
    assert.ok(service.list().suggestions.every(suggestion => !suggestion.groupIds.includes(owner.id)));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("project group requests replay their stored result and reject request ID reuse with different bodies", () => {
  const f = fixture();
  try {
    const service = f.service();
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
      if (failWrites && scope === "project-groups") throw new Error("Persistence unavailable.");
      writeSealed(file, key, scope, value);
    };
    const noIdentity = { git: () => undefined };
    const service = f.service(writer, noIdentity);
    const request = { requestId: randomUUID(), name: "Recoverable", repos: ["rehearsal", "beta"] };

    assert.throws(() => service.create(request), /Persistence unavailable/);
    assert.throws(() => service.get("recoverable"), /Persistence unavailable/);

    failWrites = false;
    const created = service.create(request);
    assert.equal(created.id, "recoverable");
    assert.deepEqual(f.service(undefined, noIdentity).get(created.id), created);

    const updateRequest = { requestId: randomUUID(), revision: created.revision, name: "Recovered Update" };
    failWrites = true;
    assert.throws(() => service.update(created.id, updateRequest), /Persistence unavailable/);
    assert.throws(() => service.get(created.id), /Persistence unavailable/);
    failWrites = false;
    const updated = service.update(created.id, updateRequest);
    assert.equal(updated.name, "Recovered Update");
    assert.deepEqual(f.service(undefined, noIdentity).get(created.id), updated);

    const removeRequest = { requestId: randomUUID(), revision: updated.revision };
    failWrites = true;
    assert.throws(() => service.remove(created.id, removeRequest), /Persistence unavailable/);
    assert.throws(() => service.get(created.id), /Persistence unavailable/);
    failWrites = false;
    assert.deepEqual(service.remove(created.id, removeRequest), updated);
    const restarted = f.service(undefined, noIdentity);
    assert.throws(() => restarted.get(created.id), failWith(404, "project-group-not-found"));
    assert.deepEqual(restarted.remove(created.id, removeRequest), updated);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed post-rename write is retried before a later mutation can replace its receipt", () => {
  const f = fixture();
  try {
    let failAfterWrite = true;
    let firstGroup: ReturnType<ProjectGroupService["create"]> | undefined;
    const firstRequest = { requestId: randomUUID(), name: "First", repos: ["rehearsal", "beta"] };
    const writer = (file: string, key: Buffer, scope: string, value: unknown) => {
      if (failAfterWrite && scope === "project-groups") {
        firstGroup = structuredClone((value as { receipts: Record<string, { result: ReturnType<ProjectGroupService["create"]> }> }).receipts[firstRequest.requestId]?.result);
        writeSealed(file, key, scope, value);
        failAfterWrite = false;
        throw new Error("Directory sync unavailable.");
      }
      writeSealed(file, key, scope, value);
    };
    const service = f.service(writer, { git: () => undefined });
    assert.throws(() => service.create(firstRequest), /Directory sync unavailable/);
    assert.deepEqual(service.get("first"), firstGroup);

    const second = service.create({ requestId: randomUUID(), name: "Second", repos: ["home-one", "home-two"] });
    assert.equal(second.id, "second");

    const restarted = f.service(undefined, { git: () => undefined });
    assert.deepEqual(restarted.get("first"), firstGroup);
    assert.deepEqual(restarted.create(firstRequest), firstGroup);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("deleting and recreating a group name allocates a new ID and rejects mutations to the old ID", () => {
  const f = fixture();
  try {
    const service = f.service();
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

test("rematerializing an implicit project after deletion allocates a fresh ID", () => {
  const f = fixture();
  try {
    const service = f.service();
    const materialized = service.update("home-one", {
      requestId: randomUUID(), revision: 1, name: "Home One group",
    });
    assert.equal(materialized.id, "home-one");

    service.remove(materialized.id, { requestId: randomUUID(), revision: materialized.revision });
    const rematerialized = service.update("home-one", {
      requestId: randomUUID(), revision: 1, hidden: true,
    });

    assert.equal(rematerialized.id, "home-one-2");
    assert.equal(rematerialized.hidden, true);
    assert.equal(service.get("home-one").id, "home-one-2");
    // The retired id no longer aliases the group that holds the checkout, whatever revision the stale edit carries.
    assert.throws(
      () => service.update("home-one", { requestId: randomUUID(), revision: rematerialized.revision, name: "Stale edit" }),
      failWith(404, "project-group-not-found"),
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy receipts reserve IDs for groups deleted before tombstones were stored", () => {
  const f = fixture();
  try {
    const request = { requestId: randomUUID(), name: "Archived Group", repos: ["rehearsal", "beta"] };
    const deleted = f.service().create(request);
    writeSealed(join(f.config.stateDir, "project-groups", "state.sealed"), f.key, "project-groups", {
      groups: {},
      receipts: { [request.requestId]: { fingerprint: "legacy", result: deleted } },
    });

    const migrated = f.service();
    const recreated = migrated.create({ ...request, requestId: randomUUID() });
    assert.notEqual(recreated.id, deleted.id);
    assert.equal(recreated.id, `${deleted.id}-2`);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("old stored groups migrate to owner members while their receipts keep the recorded result", () => {
  const f = fixture();
  try {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const legacy = {
      id: "legacy-group", name: "Legacy Group", repos: [{ projectId: "home-one", name: "Home One", path: "/home/dev/one" }],
      implicit: false, revision: 4, createdAt, updatedAt: createdAt,
    };
    const requestId = randomUUID();
    const replay = { requestId, name: "Ignored replay", repos: ["home-two"] };
    const fingerprint = createHash("sha256").update(JSON.stringify({ action: "create", body: replay })).digest("hex");
    writeSealed(join(f.config.stateDir, "project-groups", "state.sealed"), f.key, "project-groups", {
      groups: { "legacy-group": legacy }, receipts: { [requestId]: { fingerprint, result: legacy } },
    });
    const service = f.service();
    const migrated = service.get("legacy-group");
    assert.equal(migrated.kind, "owner");
    assert.equal(migrated.hidden, false);
    assert.deepEqual(migrated.repos.flatMap(repo => repo.checkouts.map(checkout => checkout.projectId)), ["home-one"]);
    assert.deepEqual(service.create(replay), legacy);
    const restarted = f.service();
    assert.equal(restarted.get("legacy-group").kind, "owner");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("project group updates reject duplicate repository IDs without changing the group", () => {
  const f = fixture();
  try {
    const service = f.service();
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
    const service = f.service();
    const first = service.create({ requestId: randomUUID(), name: "Applications", repos: ["rehearsal", "beta"] });
    assert.throws(() => service.create({ requestId: randomUUID(), name: "Conflict", repos: ["beta", "linear-one"] }), failWith(409, "project-group-repo-conflict"));
    assert.throws(() => service.create({ requestId: randomUUID(), name: "Unknown", repos: ["not-enrolled"] }), failWith(400, "unknown-project-group-repo"));
    const linear = service.create({ requestId: randomUUID(), name: "Linear repositories", repos: ["linear-one", "linear-two"] });

    const updated = service.update(first.id, { requestId: randomUUID(), revision: first.revision, name: "Product Apps" });
    assert.equal(updated.revision, first.revision + 1);
    assert.equal(updated.name, "Product Apps");
    assert.deepEqual(updated.repos.map(repo => repo.projectId), ["rehearsal", "beta"]);
    assert.throws(() => service.update(first.id, { requestId: randomUUID(), revision: first.revision, name: "Stale" }), failWith(409, "stale-project-group-revision"));
    assert.throws(() => service.update(first.id, { requestId: randomUUID(), revision: updated.revision, repos: ["beta", "linear-one"] }), failWith(409, "project-group-repo-conflict"));
    const removed = service.remove(first.id, { requestId: randomUUID(), revision: updated.revision });
    assert.equal(removed.id, first.id);
    assert.equal(service.get("rehearsal").kind, "repository");
    assert.equal(service.get("linear-one").id, linear.id);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("group suggestions retain parent exclusions and the team-ready primary rule", () => {
  const f = fixture();
  try {
    const result = f.service().list();
    assert.ok(result.suggestions.some(suggestion => suggestion.reason === "shared-parent" && suggestion.name === "apps" && suggestion.repos.includes("rehearsal") && suggestion.repos.includes("beta")));
    assert.ok(!result.suggestions.some(suggestion => suggestion.reason === "shared-parent" && suggestion.repos.some(id => id.startsWith("home-"))));
    assert.ok(!result.suggestions.some(suggestion => suggestion.reason === "shared-parent" && suggestion.repos.some(id => id.startsWith("workspace-"))));
    assert.ok(!result.suggestions.some(suggestion => suggestion.repos.some(id => id.startsWith("broad-"))));
    assert.ok(result.suggestions.some(suggestion => suggestion.reason === "shared-parent" && suggestion.name === "shop" && suggestion.repos.includes("shop-web") && suggestion.repos.includes("shop-api")));
    assert.ok(result.suggestions.some(suggestion => suggestion.reason === "shared-linear-project" && suggestion.name === "Linear One" && suggestion.repos.includes("linear-one") && suggestion.repos.includes("linear-two")), JSON.stringify(result.suggestions));

    const readyFixture = fixture();
    try {
      const primaryProject = readyFixture.projects.find(project => project.id === "alpha-codex")!;
      primaryProject.team = { checks: [], establishChecks: true };
      readyFixture.applied.rehearsal = "2026-10-21T10:00:00.000Z";
      readyFixture.applied["alpha-codex"] = "2026-10-20T10:00:00.000Z";
      const alpha = readyFixture.service().get("alpha");
      assert.equal(alpha.repos[0]!.projectId, "alpha-codex");
      assert.equal(alpha.repos[0]!.checkouts[0]!.teamReady, true);
      assert.equal(alpha.repos[0]!.checkouts[1]!.teamReady, false);
    } finally { rmSync(readyFixture.root, { recursive: true, force: true }); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("sealed project groups, identities, and request receipts survive a service restart", () => {
  const f = fixture();
  try {
    const request = { requestId: randomUUID(), name: "Applications", repos: ["rehearsal", "beta"] };
    const created = f.service().create(request);
    const restarted = f.service();
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
    assert.equal(created.body.kind, "owner");
    assert.equal(created.body.hidden, false);
    assert.deepEqual(created.body.repos.map((repo: { projectId: string; checkouts: { projectId: string }[] }) => repo.checkouts.map(checkout => checkout.projectId)), [["rehearsal"], ["beta"]]);
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

test("a retired group id never aliases its replacement, and a prototype-named checkout lists safely", () => {
  const f = fixture();
  try {
    // "beta" is a host project id; editing it materializes a stored group with that id.
    const service = f.service();
    const beta = service.get("beta");
    const renamed = service.update(beta.id, { requestId: randomUUID(), revision: beta.revision, name: "Beta product" });
    service.remove(renamed.id, { requestId: randomUUID(), revision: renamed.revision });
    // The checkout folds again under a fresh id; a stale update to the retired id is refused rather than redirected.
    const replacement = service.get("beta");
    assert.notEqual(replacement.id, renamed.id);
    assert.throws(() => service.update(renamed.id, { requestId: randomUUID(), revision: replacement.revision, name: "Hijacked" }), failWith(404, "project-group-not-found"));
    assert.equal(service.get("beta").name, replacement.name);

    f.config.projects.push({ id: "constructor", name: "Constructor", path: join(f.root, "apps", "constructor") });
    const list = f.service().list();
    assert.ok(list.groups.some(group => group.id === "constructor" && group.kind === "implicit"), "a checkout named like a prototype member stays an implicit project");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a GitHub-tracked project takes its identity from the source record without scanning", () => {
  const f = fixture();
  try {
    f.config.projects.push({ id: "tracked", name: "Tracked", path: join(f.root, "apps", "tracked"), source: { mode: "github", repository: "example/alpha", baseBranch: "main" } });
    const list = f.service().list();
    const alpha = list.groups.find(group => group.id === "alpha")!;
    const tracked = alpha.repos[0]!.checkouts.find(checkout => checkout.projectId === "tracked");
    assert.equal(tracked?.identityFrom, "source");
    assert.equal(tracked?.primary, true, "a source-tracked checkout is the default primary");
    assert.equal(f.calls.get(join(f.root, "apps", "tracked")), undefined, "no git command ran in the tracked checkout");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
