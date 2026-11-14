import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectGroup, ProjectGroupList } from "../packages/host/src/project-group-types.js";
import { PermissionDelegationService } from "../packages/host/src/permission-delegation.js";
import type { PermissionCoverageEntry } from "../packages/host/src/permission-delegation-types.js";
import { INTERRUPT_CLASSES, PERMISSION_POLICY_VERSION } from "../packages/host/src/permission-policy.js";
import type { Config, Project } from "../packages/host/src/types.js";
import { TeamError } from "../packages/host/src/team-workspace.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";

const actor = { deviceId: "owner-device" };
const request = () => ({ requestId: randomUUID() });

function makeGroup(id: string, name: string, ids: string[]): ProjectGroup {
  return {
    id,
    name,
    kind: "owner",
    hidden: false,
    repos: ids.map(projectId => ({
      projectId,
      name: projectId,
      path: "project-root",
      checkouts: [{ projectId, name: projectId, path: "project-root", primary: true, teamReady: false }],
    })),
    implicit: false,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeGroups {
  private readonly moves = new Map<string, number>();
  constructor(private groups: ProjectGroup[]) {}
  /** A host fold: membership changes and no owner move is recorded. */
  set(groups: ProjectGroup[]) { this.groups = groups; }
  /** An owner regrouping: every project whose holder changed is recorded as moved, as the group service does. */
  ownerRegroup(groups: ProjectGroup[]) {
    const ids = new Set([...this.groups, ...groups].flatMap(group => group.repos.flatMap(repo => repo.checkouts.map(checkout => checkout.projectId))));
    const before = new Map([...ids].map(id => [id, this.containing(id)?.id]));
    this.groups = groups;
    for (const id of ids) if (before.get(id) !== this.containing(id)?.id) this.moves.set(id, (this.moves.get(id) ?? 0) + 1);
  }
  ownerMoveMark(projectId: string): string { return `fake-moves:${this.moves.get(projectId) ?? 0}`; }
  get(id: string): ProjectGroup {
    const group = this.groups.find(value => value.id === id || value.repos.some(repo => repo.checkouts.some(checkout => checkout.projectId === id)));
    if (!group) throw new TeamError(404, "project-group-not-found", "This project group does not exist.");
    return group;
  }
  list(): ProjectGroupList { return { groups: this.groups, suggestions: [] }; }
  containing(projectId: string): { id: string; name: string } | undefined {
    const group = this.groups.find(value => value.repos.some(repo => repo.checkouts.some(checkout => checkout.projectId === projectId)));
    return group ? { id: group.id, name: group.name } : undefined;
  }
}

function fixture(ids = ["alpha", "beta"]) {
  const root = mkdtempSync(join(tmpdir(), "permission-delegation-"));
  const projects: Project[] = ids.map(id => ({ id, name: `${id} project`, path: join(root, "projects", id) }));
  const config = { stateDir: join(root, "state"), projects } as Config;
  const key = randomBytes(32);
  const groups = new FakeGroups([makeGroup("workspace-one", "Workspace One", ids)]);
  let now = Date.UTC(2026, 10, 14, 12);
  let writes = 0;
  const writeState = (file: string, stateKey: Buffer, scope: string, value: unknown) => {
    writes++;
    writeSealed(file, stateKey, scope, value);
  };
  const service = (options: { policyVersion?: number } = {}) =>
    new PermissionDelegationService(config, key, groups, { now: () => now, writeState, ...options });
  const file = join(config.stateDir, "permission-delegations", "state.sealed");
  const stored = (projectId: string, extra: Partial<PermissionCoverageEntry> = {}): PermissionCoverageEntry => ({
    projectId, act: "delegate", workspaceId: "workspace-one", by: "prior-owner",
    at: "2026-11-13T12:00:00.000Z", interruptClasses: [...INTERRUPT_CLASSES], policyVersion: 1,
    path: join(root, "projects", projectId), moveMark: groups.ownerMoveMark(projectId), ...extra,
  });
  return {
    root, config, key, groups, service, file, stored,
    get writes() { return writes; },
    get now() { return now; },
    set now(value: number) { now = value; },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function failsWith(status: number, code: string) {
  return (error: unknown) => error instanceof TeamError && error.status === status && error.code === code;
}

test("a shared repository identity does not transfer one project's owner coverage to another", () => {
  const f = fixture();
  try {
    const sharedRepository = makeGroup("workspace-one", "Workspace One", ["alpha", "beta"]);
    sharedRepository.repos = [{
      ...sharedRepository.repos[0]!,
      key: "repository-key",
      checkouts: sharedRepository.repos.flatMap(repo => repo.checkouts),
    }];
    f.groups.set([sharedRepository]);
    const service = f.service();
    assert.deepEqual(service.coverage("alpha"), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.deepEqual(service.coverage("beta"), { covered: false, projectId: "beta", reason: "not-covered" });
    assert.deepEqual(service.coverage("missing"), { covered: false, projectId: "missing", reason: "unknown-project" });
    assert.equal(service.status()[0]!.state, "not-delegated");

    assert.equal(service.coverProject("alpha", request(), actor).covered, true);
    assert.deepEqual(service.coverage("beta"), { covered: false, projectId: "beta", reason: "not-covered" });
  } finally { f.cleanup(); }
});

test("a project joining a delegated workspace later remains uncovered and makes it partly delegated", () => {
  const f = fixture();
  try {
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha"]), makeGroup("workspace-two", "Workspace Two", ["beta"])]);
    const service = f.service();
    service.delegate("workspace-one", request(), actor);
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha", "beta"])]);

    assert.equal(service.coverage("beta").covered, false);
    assert.equal(service.status()[0]!.state, "partly-delegated");
    assert.deepEqual(service.status()[0]!.projects.map(project => [project.projectId, project.state]), [
      ["alpha", "covered"], ["beta", "not-covered"],
    ]);
  } finally { f.cleanup(); }
});

test("a host-made membership change preserves only the moved project's own coverage", () => {
  const f = fixture();
  try {
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha"]), makeGroup("workspace-two", "Workspace Two", ["beta"])]);
    const service = f.service();
    service.delegate("workspace-one", request(), actor);
    f.groups.set([makeGroup("workspace-two", "Workspace Two", ["alpha", "beta"])]);

    const moved = service.coverage("alpha");
    assert.equal(moved.covered, true);
    if (moved.covered) {
      assert.equal(moved.workspaceId, "workspace-two");
      assert.equal(moved.coverage.workspaceId, "workspace-one");
    }
    assert.deepEqual(service.coverage("beta"), { covered: false, projectId: "beta", reason: "not-covered" });
    assert.equal(service.status()[0]!.state, "partly-delegated");
  } finally { f.cleanup(); }
});

test("opt-out survives onboarding and is replaced only by an explicit delegate", () => {
  const f = fixture(["alpha"]);
  try {
    const service = f.service();
    const choice = service.optOut("alpha", request(), actor);
    assert.deepEqual(choice, { covered: false, projectId: "alpha", reason: "opt-out" });
    const onboarded = service.coverProject("alpha", request(), actor);
    assert.deepEqual(onboarded, { covered: false, projectId: "alpha", reason: "opt-out" });
    assert.equal(service.status()[0]!.projects[0]!.state, "opt-out");

    const delegated = service.delegate("workspace-one", request(), actor);
    assert.deepEqual(delegated.replacedOptOuts, ["alpha"]);
    assert.equal(service.coverage("alpha").covered, true);
    assert.equal(service.status()[0]!.projects[0]!.state, "covered");
  } finally { f.cleanup(); }
});

test("repeat onboarding preserves a delegated entry and its direction", () => {
  const f = fixture(["alpha"]);
  try {
    const service = f.service();
    service.delegate("workspace-one", { ...request(), direction: "Keep this narrow." }, actor);
    const original = service.coverage("alpha");
    f.now += 1000;

    const repeated = service.coverProject("alpha", request(), actor);
    assert.deepEqual(repeated, original);
    const delegatedAgain = service.delegate("workspace-one", request(), actor);
    assert.equal(delegatedAgain.view.projects[0]!.state, "covered");
    const current = service.coverage("alpha");
    assert.equal(current.covered, true);
    if (current.covered) assert.equal(current.coverage.direction, "Keep this narrow.");
  } finally { f.cleanup(); }
});

test("revoke removes current workspace coverage without creating an opt-out", () => {
  const f = fixture();
  try {
    const service = f.service();
    service.delegate("workspace-one", request(), actor);
    const view = service.revoke("workspace-one", request(), actor);
    assert.equal(view.state, "not-delegated");
    assert.deepEqual(view.projects.map(project => project.state), ["not-covered", "not-covered"]);
    assert.deepEqual(service.coverage("alpha"), { covered: false, projectId: "alpha", reason: "not-covered" });
    const state = unseal<{ optOuts: Record<string, unknown> }>(
      f.key, "permission-delegations", readFileSync(join(f.config.stateDir, "permission-delegations", "state.sealed"), "utf8"),
    );
    assert.deepEqual(state.optOuts, {});
  } finally { f.cleanup(); }
});

test("onboarding does not restore coverage removed by owner regrouping, but delegate can", () => {
  const f = fixture(["alpha"]);
  try {
    const service = f.service();
    service.delegate("workspace-one", request(), actor);
    f.groups.ownerRegroup([makeGroup("workspace-two", "Workspace Two", ["alpha"])]);
    assert.deepEqual(service.coverage("alpha"), { covered: false, projectId: "alpha", reason: "not-covered" });

    assert.deepEqual(service.coverProject("alpha", request(), actor), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.equal(service.delegate("workspace-two", request(), actor).view.state, "delegated");
    assert.equal(service.coverage("alpha").covered, true);
  } finally { f.cleanup(); }
});

test("onboarding does not restore revoked coverage, but delegate can", () => {
  const f = fixture(["alpha"]);
  try {
    const service = f.service();
    service.delegate("workspace-one", request(), actor);
    service.revoke("workspace-one", request(), actor);

    assert.deepEqual(service.coverProject("alpha", request(), actor), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.equal(service.delegate("workspace-one", request(), actor).view.state, "delegated");
    assert.equal(service.coverage("alpha").covered, true);
  } finally { f.cleanup(); }
});

test("delegate applies explicit direction text to every covered entry", () => {
  const f = fixture();
  try {
    const result = f.service().delegate("workspace-one", { ...request(), direction: "Only allow routine project work." }, actor);
    assert.equal(result.view.direction, "Only allow routine project work.");
    assert.deepEqual(result.view.projects.map(project => project.state), ["covered", "covered"]);
    for (const id of ["alpha", "beta"]) {
      const coverage = f.service().coverage(id);
      assert.equal(coverage.covered, true);
      if (coverage.covered) {
        assert.deepEqual(coverage.coverage, {
          projectId: id,
          act: "delegate",
          workspaceId: "workspace-one",
          by: actor.deviceId,
          at: "2026-11-14T12:00:00.000Z",
          interruptClasses: [...INTERRUPT_CLASSES],
          policyVersion: PERMISSION_POLICY_VERSION,
          path: join(f.root, "projects", id),
          moveMark: f.groups.ownerMoveMark(id),
          direction: "Only allow routine project work.",
        });
      }
    }
  } finally { f.cleanup(); }
});

test("direction text accepts 4,000 characters and rejects longer text without writing", () => {
  const f = fixture(["alpha"]);
  try {
    const service = f.service();
    const maximum = "n".repeat(4000);
    const result = service.delegate("workspace-one", { ...request(), direction: `  ${maximum}  ` }, actor);
    assert.equal(result.view.direction, maximum);
    const writesBeforeInvalid = f.writes;

    assert.throws(() => service.delegate("workspace-one", { ...request(), direction: `${maximum}n` }, actor));
    assert.throws(() => service.delegate("workspace-one", { ...request(), direction: " \t  " }, actor));
    assert.equal(f.writes, writesBeforeInvalid);
  } finally { f.cleanup(); }
});

test("null direction clears text from every covered entry", () => {
  const f = fixture();
  try {
    const service = f.service();
    service.delegate("workspace-one", { ...request(), direction: "Narrow direction." }, actor);
    const cleared = service.delegate("workspace-one", { ...request(), direction: null }, actor);
    assert.equal(cleared.view.direction, undefined);
    for (const id of ["alpha", "beta"]) {
      const coverage = service.coverage(id);
      assert.equal(coverage.covered, true);
      if (coverage.covered) assert.equal(coverage.coverage.direction, undefined);
    }
  } finally { f.cleanup(); }
});

test("omitted direction preserves a shared text and applies it to newly covered members", () => {
  const f = fixture();
  try {
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha"]), makeGroup("workspace-two", "Workspace Two", ["beta"])]);
    const service = f.service();
    service.delegate("workspace-one", { ...request(), direction: "Keep this boundary." }, actor);
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha", "beta"])]);
    const result = service.delegate("workspace-one", request(), actor);

    assert.equal(result.view.direction, "Keep this boundary.");
    for (const id of ["alpha", "beta"]) {
      const coverage = service.coverage(id);
      assert.equal(coverage.covered, true);
      if (coverage.covered) assert.equal(coverage.coverage.direction, "Keep this boundary.");
    }
  } finally { f.cleanup(); }
});

test("omitted direction refuses mixed existing text and asks for an explicit direction", () => {
  const f = fixture();
  try {
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha"]), makeGroup("workspace-two", "Workspace Two", ["beta"])]);
    const service = f.service();
    service.delegate("workspace-one", { ...request(), direction: "Alpha boundary." }, actor);
    service.coverProject("beta", request(), actor);
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha", "beta"])]);
    const writesBeforeConflict = f.writes;

    assert.throws(() => service.delegate("workspace-one", request(), actor), failsWith(409, "permission-delegation-direction-conflict"));
    assert.equal(f.writes, writesBeforeConflict);
    const resolved = service.delegate("workspace-one", { ...request(), direction: null }, actor);
    assert.equal(resolved.view.state, "delegated");
    assert.equal(resolved.view.direction, undefined);
  } finally { f.cleanup(); }
});

test("authorityHash changes when policy version, classes, direction, or time changes", () => {
  const f = fixture(["alpha"]);
  try {
    const service = f.service();
    service.coverProject("alpha", request(), actor);
    const file = join(f.config.stateDir, "permission-delegations", "state.sealed");
    const state = unseal<{ entries: Record<string, PermissionCoverageEntry>; optOuts: Record<string, unknown>; receipts: Record<string, unknown> }>(
      f.key, "permission-delegations", readFileSync(file, "utf8"),
    );
    const base = state.entries.alpha!;
    const original = service.coverage("alpha");
    assert.equal(original.covered, true);
    if (!original.covered) return;

    const changes: Array<Partial<PermissionCoverageEntry>> = [
      { policyVersion: base.policyVersion + 1 },
      { interruptClasses: [...base.interruptClasses, "additional-pinned-class"] },
      { direction: "A new boundary." },
      { at: "2026-11-14T12:00:01.000Z" },
    ];
    for (const change of changes) {
      writeSealed(file, f.key, "permission-delegations", {
        ...state,
        entries: { ...state.entries, alpha: { ...base, ...change } },
      });
      const changed = f.service().coverage("alpha");
      assert.equal(changed.covered, true);
      if (changed.covered) assert.notEqual(changed.authorityHash, original.authorityHash);
    }
  } finally { f.cleanup(); }
});

test("authorityHash includes the host policy version in force", () => {
  const f = fixture(["alpha"]);
  try {
    const recorded = f.service({ policyVersion: 7 }).coverProject("alpha", request(), actor);
    const laterRelease = f.service({ policyVersion: 8 }).coverage("alpha");

    assert.equal(recorded.covered, true);
    assert.equal(laterRelease.covered, true);
    if (recorded.covered && laterRelease.covered) {
      assert.equal(recorded.coverage.policyVersion, 7);
      assert.equal(laterRelease.coverage.policyVersion, 7, "the stored entry remains pinned to its original policy");
      assert.notEqual(laterRelease.authorityHash, recorded.authorityHash);
    }
  } finally { f.cleanup(); }
});

test("classes in force retain a pinned class absent from this release", () => {
  const f = fixture(["alpha"]);
  try {
    writeSealed(f.file, f.key, "permission-delegations", {
      entries: { alpha: f.stored("alpha", { interruptClasses: ["retired-interrupt-class"] }) },
      optOuts: {}, knownProjectIds: ["alpha"], receipts: {},
    });
    const coverage = f.service().coverage("alpha");

    assert.equal(coverage.covered, true);
    if (coverage.covered) {
      assert.ok(coverage.interruptClasses.includes("retired-interrupt-class"));
      assert.deepEqual(coverage.interruptClasses, [...INTERRUPT_CLASSES, "retired-interrupt-class"]);
    }
  } finally { f.cleanup(); }
});

test("request replay returns the saved result without a second write and conflicting reuse is rejected", () => {
  const f = fixture(["alpha"]);
  try {
    const service = f.service();
    const input = { ...request(), direction: "Stable replay." };
    const first = service.delegate("workspace-one", input, actor);
    const afterFirst = f.writes;
    const replayed = service.delegate("workspace-one", input, actor);

    assert.deepEqual(replayed, first);
    assert.equal(f.writes, afterFirst);
    assert.throws(() => service.delegate("workspace-one", { ...input, direction: "Different request." }, actor), failsWith(409, "request-conflict"));
    assert.equal(f.writes, afterFirst);
  } finally { f.cleanup(); }
});

test("coverage and request receipts survive a restart", () => {
  const f = fixture(["alpha"]);
  try {
    const input = request();
    const first = f.service();
    const result = first.coverProject("alpha", input, actor);
    const restarted = f.service();

    assert.deepEqual(restarted.coverProject("alpha", input, actor), result);
    assert.deepEqual(restarted.coverage("alpha"), result);
  } finally { f.cleanup(); }
});

test("invalid sealed state fails with the fixed error before loading any entries", () => {
  const f = fixture();
  try {
    writeSealed(f.file, f.key, "permission-delegations", {
      entries: { alpha: f.stored("alpha"), beta: { ...f.stored("beta"), act: "invalid-act" } },
      optOuts: {},
      knownProjectIds: ["alpha", "beta"],
      receipts: {},
    });

    assert.throws(() => f.service(), error => error instanceof Error && error.message === "Invalid permission-delegation state");
  } finally { f.cleanup(); }
});

test("sealed state does not expose direction text in plaintext", () => {
  const f = fixture(["alpha"]);
  try {
    const direction = "private-direction-text-for-sealing-check";
    f.service().delegate("workspace-one", { ...request(), direction }, actor);
    const raw = readFileSync(join(f.config.stateDir, "permission-delegations", "state.sealed"), "utf8");

    assert.equal(raw.includes(direction), false);
  } finally { f.cleanup(); }
});

test("delegateAll covers each listed workspace and reports replaced opt-outs", () => {
  const f = fixture();
  try {
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha"]), makeGroup("workspace-two", "Workspace Two", ["beta"])]);
    const service = f.service();
    service.optOut("beta", request(), actor);
    const result = service.delegateAll(request(), actor);

    assert.deepEqual(result.views.map(view => view.workspaceId), ["workspace-one", "workspace-two"]);
    assert.deepEqual(result.views.map(view => view.state), ["delegated", "delegated"]);
    assert.deepEqual(result.replacedOptOuts, ["beta"]);
  } finally { f.cleanup(); }
});

test("an owner regrouping ends the moved project's coverage with no write to this service, and moving it back restores nothing", () => {
  const f = fixture();
  try {
    const service = f.service();
    service.delegate("workspace-one", request(), actor);
    const writesBefore = f.writes;

    f.groups.ownerRegroup([makeGroup("workspace-one", "Workspace One", ["beta"]), makeGroup("workspace-two", "Workspace Two", ["alpha"])]);
    assert.deepEqual(service.coverage("alpha"), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.equal(service.coverage("beta").covered, true);
    assert.deepEqual(service.status().map(view => [view.workspaceId, view.state]), [
      ["workspace-one", "delegated"], ["workspace-two", "not-delegated"],
    ]);
    assert.equal(f.writes, writesBefore);

    f.groups.ownerRegroup([makeGroup("workspace-one", "Workspace One", ["alpha", "beta"])]);
    assert.deepEqual(service.coverage("alpha"), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.equal(service.status()[0]!.state, "partly-delegated");
    assert.deepEqual(service.coverProject("alpha", request(), actor), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.equal(service.delegate("workspace-one", request(), actor).view.state, "delegated");
    assert.equal(service.coverage("alpha").covered, true);
  } finally { f.cleanup(); }
});

test("a regrouping made while this service could not write or was not running still ends coverage after recovery", () => {
  const f = fixture();
  try {
    let failing = false;
    const writeState = (file: string, stateKey: Buffer, scope: string, value: unknown) => {
      if (failing) throw new Error("write failed");
      writeSealed(file, stateKey, scope, value);
    };
    const service = new PermissionDelegationService(f.config, f.key, f.groups, { writeState });
    service.delegate("workspace-one", request(), actor);

    failing = true;
    f.groups.ownerRegroup([makeGroup("workspace-one", "Workspace One", ["beta"]), makeGroup("workspace-two", "Workspace Two", ["alpha"])]);
    assert.deepEqual(service.coverage("alpha"), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.throws(() => service.revoke("workspace-one", request(), actor), /write failed/);
    failing = false;

    const restarted = f.service();
    assert.deepEqual(restarted.coverage("alpha"), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.equal(restarted.coverage("beta").covered, true);
  } finally { f.cleanup(); }
});

test("an opt-out, a revocation and the onboarding history survive a project that leaves the host and returns", () => {
  const f = fixture(["alpha", "beta", "gamma"]);
  try {
    const service = f.service();
    service.optOut("alpha", request(), actor);
    service.coverProject("beta", request(), actor);
    service.revoke("workspace-one", request(), actor);
    const enrolled = [...f.config.projects];

    f.config.projects = enrolled.filter(project => project.id === "gamma");
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["gamma"])]);
    assert.deepEqual(service.coverage("alpha"), { covered: false, projectId: "alpha", reason: "unknown-project" });
    assert.deepEqual(service.status()[0]!.projects.map(project => project.projectId), ["gamma"]);
    service.coverProject("gamma", request(), actor);
    service.optOut("gamma", request(), actor);

    f.config.projects = enrolled;
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha", "beta", "gamma"])]);
    const restarted = f.service();
    assert.deepEqual(restarted.coverProject("alpha", request(), actor), { covered: false, projectId: "alpha", reason: "opt-out" });
    assert.deepEqual(restarted.coverProject("beta", request(), actor), { covered: false, projectId: "beta", reason: "not-covered" });
    assert.deepEqual(restarted.status()[0]!.projects.map(project => project.state), ["opt-out", "not-covered", "opt-out"]);
  } finally { f.cleanup(); }
});

test("another checkout enrolled under a covered project's id is not covered until the owner delegates it", () => {
  const f = fixture(["alpha"]);
  try {
    const service = f.service();
    service.delegate("workspace-one", request(), actor);
    f.config.projects = [{ id: "alpha", name: "alpha project", path: join(f.root, "projects", "another-checkout") }];

    assert.deepEqual(service.coverage("alpha"), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.equal(service.status()[0]!.state, "not-delegated");
    assert.deepEqual(service.coverProject("alpha", request(), actor), { covered: false, projectId: "alpha", reason: "not-covered" });
    assert.equal(service.delegate("workspace-one", request(), actor).view.state, "delegated");
    assert.equal(service.coverage("alpha").covered, true);
  } finally { f.cleanup(); }
});

test("a replayed request id returns its recorded result and restores no coverage", () => {
  const f = fixture();
  try {
    f.groups.set([makeGroup("workspace-one", "Workspace One", ["alpha"]), makeGroup("workspace-two", "Workspace Two", ["beta"])]);
    const service = f.service();
    const delegated = request(), onboarded = request(), all = request();
    const first = service.delegate("workspace-one", delegated, actor);
    service.revoke("workspace-one", request(), actor);
    const covered = service.coverProject("beta", onboarded, actor);
    const everything = service.delegateAll(all, actor);
    service.revoke("workspace-one", request(), actor);
    service.revoke("workspace-two", request(), actor);
    f.groups.ownerRegroup([makeGroup("workspace-one", "Workspace One", ["alpha", "beta"])]);
    const writesBefore = f.writes;

    assert.deepEqual(service.delegate("workspace-one", delegated, actor), first);
    assert.deepEqual(service.coverProject("beta", onboarded, actor), covered);
    assert.deepEqual(service.delegateAll(all, actor), everything);
    assert.equal(f.writes, writesBefore);
    for (const id of ["alpha", "beta"])
      assert.deepEqual(service.coverage(id), { covered: false, projectId: id, reason: "not-covered" });
    assert.equal(f.service().status()[0]!.state, "not-delegated");
  } finally { f.cleanup(); }
});
