import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeMutationContext } from "@infinite/remote";
import { UnderstandingCatalog, CatalogError } from "../packages/host/src/understanding-catalog.js";
import type { Config } from "../packages/host/src/types.js";
import type { ProjectGroup } from "../packages/host/src/project-group-types.js";

const emptyContext: KnowledgeMutationContext = { work: [], components: [] };
const request = (revision: number, action: "create" | "update" | "archive", value?: unknown) => ({ requestId: randomUUID(), revision, action, ...(value === undefined ? {} : { value }) });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "understanding-catalog-"));
  const checkout = join(root, "checkout"); mkdirSync(checkout);
  execFileSync("git", ["init", "--quiet", checkout]);
  execFileSync("git", ["-C", checkout, "config", "user.email", "catalog@example.invalid"]);
  execFileSync("git", ["-C", checkout, "config", "user.name", "Catalog Test"]);
  writeFileSync(join(checkout, "README.md"), "catalog fixture\n");
  execFileSync("git", ["-C", checkout, "add", "README.md"]);
  execFileSync("git", ["-C", checkout, "commit", "--quiet", "-m", "fixture"]);
  execFileSync("git", ["-C", checkout, "remote", "add", "origin", "https://github.com/example/catalog-fixture.git"]);
  const project = { id: "repo", name: "Fixture", path: checkout };
  const repo = { projectId: "repo", name: "catalog-fixture", path: checkout, key: "remote:github.com/example/catalog-fixture", checkouts: [{ projectId: "repo", name: "Fixture", path: checkout, primary: true, teamReady: false, identityFrom: "host-scan" as const }] };
  const group: ProjectGroup = { id: "workspace", name: "Workspace", kind: "owner", hidden: false, repos: [repo], implicit: false, revision: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  const config = { stateDir: join(root, "state"), projects: [project] } as Config;
  const key = Buffer.alloc(32, 7);
  const groups = { get: (id: string) => { if (id !== group.id) throw new Error("missing"); return group; }, list: () => ({ groups: [group], suggestions: [] }) };
  const make = () => new UnderstandingCatalog({ config, key, groups });
  return { root, checkout, config, group, make, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("catalog writes are sealed, globally CASed, replay-safe, and survive restart", () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const body = request(0, "create", { name: "Client", description: "Workspace project", repositoryIds: ["repo"] });
    const created = catalog.mutate("workspace", "projects", undefined, body, emptyContext);
    assert.equal(created.revision, 1);
    assert.equal(created.projects[0]?.id, body.requestId);
    assert.deepEqual(catalog.mutate("workspace", "projects", undefined, body, emptyContext), created);
    assert.throws(() => catalog.mutate("workspace", "projects", undefined, { ...body, value: { name: "Changed", description: "", repositoryIds: ["repo"] } }, emptyContext), (error: unknown) => error instanceof CatalogError && error.statusCode === 409);
    assert.throws(() => catalog.mutate("workspace", "policy", undefined, request(0, "update", { enabled: true, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 }), emptyContext), (error: unknown) => error instanceof CatalogError && error.statusCode === 409);

    const file = join(f.config.stateDir, "understanding", "catalogs", "workspace.sealed");
    const sealed = readFileSync(file, "utf8");
    assert.doesNotMatch(sealed, /Workspace project|catalog-fixture/);
    const restarted = f.make();
    assert.deepEqual(restarted.read("workspace"), created);

    const next = request(1, "update", { name: "Client v2", description: "Updated", repositoryIds: ["repo"] });
    const updated = restarted.mutate("workspace", "projects", body.requestId, next, emptyContext);
    assert.equal(updated.revision, 2);
    assert.equal(updated.projects[0]?.revision, 2);
    assert.equal(updated.projects[0]?.history.at(-1)?.revision, 2);
  } finally { f.cleanup(); }
});

test("catalog withholds records on repository identity changes and rejects scope mismatches", () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const created = catalog.mutate("workspace", "projects", undefined, request(0, "create", { name: "Client", description: "", repositoryIds: ["repo"] }), emptyContext);
    assert.throws(() => catalog.mutate("workspace", "projects", undefined, request(created.revision, "create", { name: "Outside", description: "", repositoryIds: ["elsewhere"] }), emptyContext), (error: unknown) => error instanceof CatalogError && error.statusCode === 400);

    const gitDir = join(f.checkout, ".git");
    const parked = join(f.root, "old-git"); renameSync(gitDir, parked); mkdirSync(gitDir);
    const withheld = catalog.read("workspace");
    assert.deepEqual(withheld.projects, []);
    assert.match(withheld.coverage.join(" "), /identity.*changed|changed.*identity|unavailable/i);
    assert.throws(() => catalog.mutate("workspace", "policy", undefined, request(created.revision, "update", { enabled: true, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 }), emptyContext), (error: unknown) => error instanceof CatalogError && error.statusCode === 409);
  } finally { f.cleanup(); }
});

test("a primary checkout switch keeps catalog identity stable and returns the current primary ID", () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const created = catalog.mutate("workspace", "projects", undefined, request(0, "create", { name: "Client", description: "", repositoryIds: ["repo"] }), emptyContext);
    const copiedPath = join(f.root, "checkout-copy");
    execFileSync("git", ["clone", "--quiet", f.checkout, copiedPath]);
    execFileSync("git", ["-C", copiedPath, "remote", "set-url", "origin", "https://github.com/example/catalog-fixture.git"]);
    f.config.projects.push({ id: "repo-copy", name: "Fixture Copy", path: copiedPath });
    f.group.repos[0]!.checkouts.push({ projectId: "repo-copy", name: "Fixture Copy", path: copiedPath, primary: false, teamReady: false, identityFrom: "host-scan" });
    assert.equal(catalog.read("workspace").projects[0]?.id, created.projects[0]?.id, "adding a checkout of the same repository preserves the project");
    f.group.repos[0]!.projectId = "repo-copy";
    f.group.repos[0]!.path = copiedPath;
    f.group.repos[0]!.checkouts[0]!.primary = false;
    f.group.repos[0]!.checkouts[1]!.primary = true;
    const switched = catalog.read("workspace");
    assert.equal(switched.revision, created.revision);
    assert.deepEqual(switched.projects[0]?.repositoryIds, ["repo-copy"]);
  } finally { f.cleanup(); }
});

test("an unrelated repository addition does not hide records scoped to an unchanged repository", () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const created = catalog.mutate("workspace", "projects", undefined, request(0, "create", { name: "Client", description: "", repositoryIds: ["repo"] }), emptyContext);
    const path = join(f.root, "other-checkout"); mkdirSync(path);
    execFileSync("git", ["init", "--quiet", path]);
    execFileSync("git", ["-C", path, "config", "user.email", "catalog@example.invalid"]);
    execFileSync("git", ["-C", path, "config", "user.name", "Catalog Test"]);
    writeFileSync(join(path, "README.md"), "other repository\n");
    execFileSync("git", ["-C", path, "add", "README.md"]);
    execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "fixture"]);
    execFileSync("git", ["-C", path, "remote", "add", "origin", "https://github.com/example/other-fixture.git"]);
    f.config.projects.push({ id: "other-repo", name: "Other", path });
    f.group.repos.push({ projectId: "other-repo", name: "other-fixture", path, key: "remote:github.com/example/other-fixture",
      checkouts: [{ projectId: "other-repo", name: "Other", path, primary: true, teamReady: false, identityFrom: "host-scan" }] });
    const after = catalog.read("workspace");
    assert.equal(after.revision, created.revision);
    assert.equal(after.projects[0]?.id, created.projects[0]?.id);
    assert.deepEqual(after.projects[0]?.repositoryIds, ["repo"]);
    assert.deepEqual(after.coverage, []);
    const context: KnowledgeMutationContext = {
      work: ["repo", "other-repo"].map(repositoryId => ({ id: `team:${repositoryId}`, sourceId: repositoryId, kind: "team", title: "Scoped attempt", objective: null, reportedSummary: null, status: "completed", column: "ended", updatedAt: new Date().toISOString(), scope: "complete", repositoryIds: [repositoryId], briefIds: [], links: [] })),
      components: [{ id: "cmp_api", repositoryIds: ["repo"] }, { id: "cmp_client", repositoryIds: ["other-repo"] }],
    };
    const feature = { projectId: null, title: "End-to-end feature", description: "Spans separate repository attempts", repositoryIds: ["repo", "other-repo"], workIds: context.work.map(work => work.id), componentIds: context.components.map(component => component.id), status: "active", sourceUrl: null };
    const linked = catalog.mutate("workspace", "features", undefined, request(after.revision, "create", feature), context);
    assert.deepEqual(linked.features[0]?.componentIds, ["cmp_api", "cmp_client"]);
    assert.deepEqual(linked.features[0]?.workIds, ["team:repo", "team:other-repo"]);
    assert.throws(() => catalog.mutate("workspace", "features", undefined, request(linked.revision, "create", { ...feature, repositoryIds: ["repo"] }), context), (error: unknown) => error instanceof CatalogError && error.statusCode === 400, "a reference outside the complete feature scope stays rejected");
  } finally { f.cleanup(); }
});

test("catalog rejects incomplete references and component redirect cycles without saving", () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const project = catalog.mutate("workspace", "projects", undefined, request(0, "create", { name: "Client", description: "", repositoryIds: ["repo"] }), emptyContext);
    const componentA = `cmp_${"a".repeat(24)}`, componentB = `cmp_${"b".repeat(24)}`;
    const context: KnowledgeMutationContext = { work: [{ id: "goal:g1", sourceId: "g1", kind: "goal", title: "Goal", objective: null, reportedSummary: null, status: "active", column: "working", updatedAt: new Date().toISOString(), scope: "partial", repositoryIds: ["repo"], briefIds: [], links: [] }], components: [{ id: componentA, repositoryIds: ["repo"] }, { id: componentB, repositoryIds: ["repo"] }] };
    const badFeature = { projectId: project.projects[0]!.id, title: "Feature", description: "", repositoryIds: ["repo"], workIds: ["goal:g1"], componentIds: [componentA], status: "planned", sourceUrl: null };
    assert.throws(() => catalog.mutate("workspace", "features", undefined, request(1, "create", badFeature), context), (error: unknown) => error instanceof CatalogError && error.statusCode === 400);

    const a = { repositoryIds: ["repo"], name: "A", description: "", redirectTo: componentB, pinned: true };
    const first = catalog.mutate("workspace", "components", componentA, request(1, "update", a), context);
    assert.equal(first.componentOverrides.length, 1);
    assert.throws(() => catalog.mutate("workspace", "components", componentB, request(2, "update", { ...a, name: "B", redirectTo: componentA }), context), (error: unknown) => error instanceof CatalogError && error.statusCode === 400);
    assert.equal(catalog.read("workspace").revision, 2);
  } finally { f.cleanup(); }
});

test("a failed catalog write leaves the previously acknowledged state intact", () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const created = catalog.mutate("workspace", "projects", undefined, request(0, "create", { name: "Client", description: "Durable", repositoryIds: ["repo"] }), emptyContext);
    const directory = join(f.config.stateDir, "understanding", "catalogs");
    const file = join(directory, "workspace.sealed");
    const saved = join(directory, "workspace.saved"); renameSync(file, saved); mkdirSync(file);
    const next = { requestId: randomUUID(), action: "update", revision: 1, value: { enabled: true, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 } };
    assert.throws(() => catalog.mutate("workspace", "policy", undefined, next, emptyContext), (error: unknown) => error instanceof CatalogError && error.statusCode === 503);
    rmSync(file, { recursive: true }); renameSync(saved, file);
    for (const name of readdirSync(directory)) if (name.endsWith(".tmp")) rmSync(join(directory, name), { force: true });
    assert.deepEqual(f.make().read("workspace"), created);
  } finally { f.cleanup(); }
});

test("corrupt catalog storage is disclosed on read and rejected on mutation", () => {
  const f = fixture();
  try {
    const directory = join(f.config.stateDir, "understanding", "catalogs"); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "workspace.sealed"), "not a sealed catalog");
    const catalog = f.make();
    const unavailable = catalog.read("workspace");
    assert.deepEqual(unavailable.projects, []);
    assert.match(unavailable.coverage.join(" "), /unavailable or corrupt/i);
    assert.throws(() => catalog.mutate("workspace", "policy", undefined, request(0, "update", { enabled: true, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 }), emptyContext),
      (error: unknown) => error instanceof CatalogError && error.statusCode === 503);
  } finally { f.cleanup(); }
});

test("entity IDs remain reserved after their replay receipt is evicted", () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const create = request(0, "create", { name: "Client", description: "", repositoryIds: ["repo"] });
    catalog.mutate("workspace", "projects", undefined, create, emptyContext);
    let revision = 1;
    for (let index = 0; index < 256; index++) {
      const policy = { enabled: index % 2 === 0, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 };
      catalog.mutate("workspace", "policy", undefined, { requestId: randomUUID(), action: "update", revision, value: policy }, emptyContext);
      revision++;
    }
    assert.throws(() => catalog.mutate("workspace", "projects", undefined, { ...create, revision }, emptyContext),
      (error: unknown) => error instanceof CatalogError && error.statusCode === 409);
    assert.equal(catalog.read("workspace").projects.length, 1);
  } finally { f.cleanup(); }
});

test("component override insertion stops at 512 while existing overrides remain editable and restartable", { timeout: 60000 }, () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const context: KnowledgeMutationContext = { work: [], components: Array.from({ length: 513 }, (_, index) => ({ id: `cmp_${index}`, repositoryIds: ["repo"] })) };
    const value = { repositoryIds: ["repo"], name: "Component", description: "Owner description", redirectTo: null, pinned: true };
    for (let index = 0; index < 512; index++) catalog.mutate("workspace", "components", `cmp_${index}`, request(index, "update", value), context);
    const file = join(f.config.stateDir, "understanding", "catalogs", "workspace.sealed");
    const before = readFileSync(file, "utf8");
    const overflow = request(512, "update", value);
    assert.throws(() => catalog.mutate("workspace", "components", "cmp_512", overflow, context),
      (error: unknown) => error instanceof CatalogError && error.statusCode === 409);
    assert.equal(readFileSync(file, "utf8"), before, "rejected insertion must not replace the durable generation");
    const reopened = f.make();
    assert.equal(reopened.read("workspace").componentOverrides.length, 512);
    const edited = reopened.mutate("workspace", "components", "cmp_0", request(512, "update", { ...value, description: "Updated at capacity" }), context);
    assert.equal(edited.componentOverrides[0]?.description, "Updated at capacity");
    assert.equal(edited.componentOverrides.length, 512);
    assert.deepEqual(f.make().read("workspace"), edited);
  } finally { f.cleanup(); }
});

test("catalog workspace routes reject checkout aliases before reading or mutating another workspace", () => {
  const f = fixture();
  try {
    const catalog = new UnderstandingCatalog({ config: f.config, key: Buffer.alloc(32, 7), groups: { get: () => f.group, list: () => ({ groups: [f.group], suggestions: [] }) } });
    const body = request(0, "create", { name: "Client", description: "", repositoryIds: ["repo"] });
    const canonical = catalog.mutate("workspace", "projects", undefined, body, emptyContext);
    const missing = (error: unknown) => error instanceof CatalogError && error.statusCode === 404;
    assert.throws(() => catalog.read("repo"), missing);
    assert.throws(() => catalog.mutate("repo", "projects", undefined, request(0, "create", body.value), emptyContext), missing);
    assert.deepEqual(catalog.read("workspace"), canonical);
    assert.deepEqual(readdirSync(join(f.config.stateDir, "understanding", "catalogs")), ["workspace.sealed"]);
  } finally { f.cleanup(); }
});

test("an unpersistable component reference is rejected before acknowledging or replacing the catalog", () => {
  const f = fixture();
  try {
    const catalog = f.make();
    const created = catalog.mutate("workspace", "projects", undefined, request(0, "create", { name: "Client", description: "Durable", repositoryIds: ["repo"] }), emptyContext);
    const file = join(f.config.stateDir, "understanding", "catalogs", "workspace.sealed");
    const before = readFileSync(file, "utf8");
    const id = `cmp_${"a".repeat(160)}`;
    const context = { work: [], components: [{ id, repositoryIds: ["repo"] }] };
    assert.throws(() => catalog.mutate("workspace", "components", id, request(1, "update", { repositoryIds: ["repo"], name: "Component", description: "", redirectTo: null, pinned: false }), context),
      (error: unknown) => error instanceof CatalogError && error.statusCode === 503);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(catalog.read("workspace"), created);
    assert.deepEqual(f.make().read("workspace"), created);
  } finally { f.cleanup(); }
});
