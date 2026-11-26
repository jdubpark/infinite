import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UnderstandingArtifact, WorkspaceUnderstanding } from "@infinite/remote";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";
import { UnderstandingService } from "../packages/host/src/understanding.js";
import { writeSealed } from "../packages/host/src/vault.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { ProjectGroup, ProjectGroupRepo } from "../packages/host/src/project-group-types.js";
import type { Project, Session } from "../packages/host/src/types.js";

type RepoId = "api" | "web" | "docs";
type SessionState = "live" | "missing" | "unreadable" | "unowned" | "rebound-cwd";

interface PublishedMissionBrief {
  id: string;
  pinnedHeads: Record<string, string>;
  pinnedIdentities: Record<string, string>;
  pinnedPaths: Record<string, string>;
  missionRepos: string[];
  retainedAt: string;
}

interface SimWorld {
  heads: Record<RepoId, string>;
  identities: Record<RepoId, string>;
  enrolledPaths: Record<RepoId, string>;
  recordedPaths: Record<RepoId, string>;
  missionRepos: RepoId[];
  workspaceRepos: RepoId[];
  sessionState: SessionState;
  published: PublishedMissionBrief[];
  legacyProjectId: string;
  legacyMissionId: string;
  apiCanonicalPath: string;
  apiCanonicalIdentity: string;
}

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(path: string, file: string, content: string) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path });
  git(path, "config", "user.email", "fixture@example.invalid");
  git(path, "config", "user.name", "Fixture");
  writeFileSync(join(path, file), content);
  git(path, "add", file);
  git(path, "commit", "-qm", "initial");
  const head = git(path, "rev-parse", "HEAD");
  const rootCommit = git(path, "rev-list", "--max-parents=0", "HEAD").split(/\s+/).sort()[0]!;
  const key = `root:${rootCommit}`;
  return { head, key, identity: sha256(key) };
}

function commitFile(path: string, file: string, content: string, message: string): string {
  writeFileSync(join(path, file), content);
  git(path, "add", file);
  git(path, "commit", "-qm", message);
  return git(path, "rev-parse", "HEAD");
}

function repoEntry(id: string, name: string, path: string, key: string): ProjectGroupRepo {
  const real = realpathSync(path);
  return { projectId: id, name, path: real, key, checkouts: [{ projectId: id, name, path: real, primary: true, teamReady: true }] };
}

function makeGroup(id: string, repos: ProjectGroupRepo[]): ProjectGroup {
  return {
    id, name: `Workspace ${id}`, kind: "owner", hidden: false, implicit: false, revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", repos,
  };
}

function makeMission(id: string, groupId: string, repoProjectIds: string[]): Mission {
  const at = "2026-10-21T00:00:00.000Z";
  const strong = { id: "coord", label: "Coordinator", provider: "claude" as const, model: "claude-opus-5-5", tier: "strong" as const };
  return {
    id, groupId, groupName: `Workspace ${groupId}`, repoProjectIds, title: "Sim mission",
    objective: "Simulate multi-repo transitions", maxSubtasks: 8, maxMinutes: 60, deadlineAt: "2026-10-21T01:00:00.000Z",
    revision: 1, status: "working", createdAt: at, updatedAt: at,
    lineup: { coordinator: strong, integrator: strong, reviewer: strong, implementers: [] },
    subtasks: [], decisions: [], steering: [], events: [],
  };
}

function sameSorted(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort((x, y) => x.localeCompare(y));
  const b = [...right].sort((x, y) => x.localeCompare(y));
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function oracleVisibleMissionIds(world: SimWorld): string[] {
  if (world.sessionState === "unreadable" || world.sessionState === "unowned" || world.sessionState === "rebound-cwd") return [];
  return [...world.published]
    .sort((a, b) => b.retainedAt.localeCompare(a.retainedAt) || a.id.localeCompare(b.id))
    .filter(item => {
      if (!sameSorted(item.missionRepos, world.missionRepos)) return false;
      if (!item.missionRepos.every(repo => world.workspaceRepos.includes(repo as RepoId))) return false;
      return item.missionRepos.every(repo => {
        const id = repo as RepoId;
        return world.heads[id] === item.pinnedHeads[id]
          && world.identities[id] === item.pinnedIdentities[id]
          && world.enrolledPaths[id] === item.pinnedPaths[id]
          && world.recordedPaths[id] === item.pinnedPaths[id];
      });
    }).map(item => item.id);
}

function checkInvariants(
  liveView: WorkspaceUnderstanding,
  reloadedView: WorkspaceUnderstanding,
  world: SimWorld,
  label: string,
): void {
  const expectedMissionIds = oracleVisibleMissionIds(world);
  const expectedSet = new Set(expectedMissionIds);
  const byRepo = new Map(liveView.repositories.map(repo => [repo.id, repo]));
  const reloadedByRepo = new Map(reloadedView.repositories.map(repo => [repo.id, repo]));
  const publishedById = new Map(world.published.map(item => [item.id, item]));
  const workspaceComplete = world.missionRepos.every(repo => world.workspaceRepos.includes(repo));
  const missionArtifacts = (items: UnderstandingArtifact[]) => items.filter(item => item.pinnedSources !== undefined);

  for (const repoId of world.workspaceRepos) {
    const repo = byRepo.get(repoId);
    assert.ok(repo, `${label}: workspace contains repo ${repoId}`);
    const visible = missionArtifacts(repo.current);
    const visibleIds = visible.map(item => item.id);

    for (const artifact of visible) {
      const pinned = artifact.pinnedSources!;
      const published = publishedById.get(artifact.id);
      assert.ok(published, `${label} [INV_PIN_MATCH]: visible artifact ${artifact.id} was published`);
      for (const boundId of Object.keys(pinned)) {
        const key = boundId as RepoId;
        assert.equal(
          pinned[boundId]!.head,
          world.heads[key],
          `${label} [INV_NO_STALE_HEAD]: artifact ${artifact.id} pinned ${boundId} head mismatches live HEAD`,
        );
        assert.equal(
          pinned[boundId]!.repoIdentity,
          world.identities[key],
          `${label} [INV_MEMBERSHIP_AND_IDENTITY]: artifact ${artifact.id} pinned ${boundId} identity mismatches live identity`,
        );
        assert.equal(
          published.pinnedPaths[boundId],
          world.enrolledPaths[key],
          `${label} [INV_MEMBERSHIP_AND_IDENTITY]: artifact ${artifact.id} pinned ${boundId} path mismatches enrolled checkout`,
        );
        assert.equal(
          published.pinnedPaths[boundId],
          world.recordedPaths[key],
          `${label} [INV_MEMBERSHIP_AND_IDENTITY]: artifact ${artifact.id} pinned ${boundId} path mismatches mission recorded checkout`,
        );
      }
      assert.ok(
        sameSorted(Object.keys(pinned), world.missionRepos),
        `${label} [INV_MEMBERSHIP_AND_IDENTITY]: artifact ${artifact.id} bound repo set differs from mission repos`,
      );
    }

    if (!workspaceComplete) {
      assert.deepEqual(visibleIds, [], `${label} [INV_WORKSPACE_ALL_OR_NOTHING]: split workspace must withhold all mission briefs on ${repoId}`);
    }
    if (world.sessionState === "unreadable" || world.sessionState === "unowned" || world.sessionState === "rebound-cwd") {
      assert.deepEqual(visibleIds, [], `${label} [INV_SESSION_FAIL_CLOSED]: session state ${world.sessionState} must withhold all mission briefs on ${repoId}`);
    }

    if (world.missionRepos.includes(repoId)) {
      if (workspaceComplete && (world.sessionState === "live" || world.sessionState === "missing")) {
        for (const expectedId of expectedSet) {
          assert.ok(visibleIds.includes(expectedId), `${label} [INV_PIN_MATCH]: expected valid mission artifact ${expectedId} missing on ${repoId}`);
        }
        assert.deepEqual(visibleIds, expectedMissionIds, `${label} [INV_PIN_MATCH]: visible mission artifacts on ${repoId} diverge from oracle`);
      }
    } else {
      assert.deepEqual(visibleIds, [], `${label} [INV_CROSS_REPO_SYMMETRY]: non-participating repo ${repoId} must not show mission artifacts`);
    }

    const reloadedRepo = reloadedByRepo.get(repoId);
    assert.ok(reloadedRepo, `${label} [INV_RELOAD_EQUIVALENCE]: reloaded view missing repo ${repoId}`);
    assert.deepEqual(
      reloadedRepo.current.map(item => ({ id: item.id, pinnedSources: item.pinnedSources ?? null })),
      repo.current.map(item => ({ id: item.id, pinnedSources: item.pinnedSources ?? null })),
      `${label} [INV_RELOAD_EQUIVALENCE]: disk reload diverged from live view on ${repoId}`,
    );
  }

  const participatingVisible = world.missionRepos
    .filter(repoId => world.workspaceRepos.includes(repoId))
    .map(repoId => missionArtifacts(byRepo.get(repoId)!.current).map(item => item.id));
  for (let i = 1; i < participatingVisible.length; i++) {
    assert.deepEqual(
      participatingVisible[i],
      participatingVisible[0],
      `${label} [INV_CROSS_REPO_SYMMETRY]: participating repos must display identical mission artifact lists`,
    );
  }

  const apiRepo = byRepo.get("api")!;
  const apiLegacyIds = apiRepo.current.filter(item => item.pinnedSources === undefined).map(item => item.id);
  const apiUnchanged = world.identities.api === world.apiCanonicalIdentity && world.enrolledPaths.api === world.apiCanonicalPath;
  assert.equal(
    apiLegacyIds.includes(world.legacyProjectId),
    apiUnchanged,
    `${label} [INV_LEGACY_V1_ISOLATION]: legacy v1 project brief visibility must depend only on api binding`,
  );
  assert.equal(
    apiLegacyIds.includes(world.legacyMissionId),
    false,
    `${label} [INV_LEGACY_V1_ISOLATION]: legacy v1 single-repo mission artifact must never become visible`,
  );
}

function setupSimulator(temp: string) {
  const root = realpathSync(temp);
  const paths: Record<RepoId, string> = {
    api: join(root, "api"),
    web: join(root, "web"),
    docs: join(root, "docs"),
  };
  const repos = {
    api: initRepo(paths.api, "api.txt", "api-0\n"),
    web: initRepo(paths.web, "web.txt", "web-0\n"),
    docs: initRepo(paths.docs, "docs.txt", "docs-0\n"),
  };
  const webAltPath = join(root, "web-alt");
  git(paths.web, "worktree", "add", "--detach", webAltPath, "HEAD");
  const webAltCanonical = realpathSync(webAltPath);

  const history: Record<RepoId, string[]> = {
    api: [repos.api.head],
    web: [repos.web.head],
    docs: [repos.docs.head],
  };
  const teamWorkspace = join(root, "teams");
  const missionId = randomUUID();
  const memberId = randomUUID();
  const sessionId = randomUUID();
  const missionFolder = join(teamWorkspace, "missions", missionId);
  const reboundFolder = join(teamWorkspace, "missions", "rebound-sim");
  mkdirSync(missionFolder, { recursive: true });
  mkdirSync(reboundFolder, { recursive: true });
  const stateDir = join(root, "state");
  const artifactDir = join(stateDir, "understanding", "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const key = Buffer.alloc(32, 23);

  const apiStat = statSync(paths.api);
  const legacyProjectId = randomUUID();
  const legacyMissionId = randomUUID();
  const sealLegacy = (id: string, sourceKind: "project" | "team", extra: Record<string, unknown> = {}) => {
    writeSealed(join(artifactDir, `${id}.sealed`), key, "understanding-artifact", {
      binding: {
        projectId: "api", sourceKind, enrolledPath: paths.api, root: paths.api, sourceCwd: paths.api,
        projectDevice: String(apiStat.dev), projectInode: String(apiStat.ino),
        rootDevice: String(apiStat.dev), rootInode: String(apiStat.ino),
        sourceCwdDevice: String(apiStat.dev), sourceCwdInode: String(apiStat.ino),
        repoIdentity: repos.api.identity, ...extra,
      },
      artifact: {
        id, sourceProjectId: "api", sessionId: randomUUID(), sourceKind, head: "a".repeat(40), base: null,
        fingerprint: "b".repeat(40), generatedAt: "2026-10-20T00:00:00.000Z", retainedAt: "2026-10-20T00:00:00.000Z",
        coverage: [], brief: { summary: `legacy-${sourceKind}`, architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] },
        evidence: [],
      },
    });
  };
  sealLegacy(legacyProjectId, "project");
  sealLegacy(legacyMissionId, "team", { runId: missionId, memberId });

  const world: SimWorld = {
    heads: { api: repos.api.head, web: repos.web.head, docs: repos.docs.head },
    identities: { api: repos.api.identity, web: repos.web.identity, docs: repos.docs.identity },
    enrolledPaths: { api: paths.api, web: paths.web, docs: paths.docs },
    recordedPaths: { api: paths.api, web: paths.web, docs: paths.docs },
    missionRepos: ["api", "web"],
    workspaceRepos: ["api", "web", "docs"],
    sessionState: "live",
    published: [],
    legacyProjectId,
    legacyMissionId,
    apiCanonicalPath: paths.api,
    apiCanonicalIdentity: repos.api.identity,
  };

  const projects: Project[] = [
    { id: "api", name: "API", path: paths.api },
    { id: "web", name: "Web", path: paths.web },
    { id: "docs", name: "Docs", path: paths.docs },
  ];
  const syncProjects = () => {
    projects[0]!.path = world.enrolledPaths.api;
    projects[1]!.path = world.enrolledPaths.web;
    projects[2]!.path = world.enrolledPaths.docs;
  };
  const group = () => makeGroup("platform", world.workspaceRepos.map(id =>
    repoEntry(id, id.toUpperCase(), world.enrolledPaths[id], repos[id].key),
  ));
  const session = (): Session => ({
    id: sessionId, provider: "claude", title: "Sim Coordinator", projectId: "api",
    cwd: world.sessionState === "rebound-cwd" ? reboundFolder : missionFolder,
    createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "sim",
    team: { runId: missionId, memberId, revision: 1, role: "mission-coordinator" },
  });
  const manager = {
    meta: (id: string) => {
      if (id !== sessionId) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (world.sessionState === "missing") throw Object.assign(new Error("cleaned up"), { code: "ENOENT" });
      if (world.sessionState === "unreadable") throw Object.assign(new Error("disk error"), { code: "EIO" });
      return { session: session() };
    },
    state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
    events: () => ({ events: [{ seq: 1, type: "message", at: "2026-10-21T00:00:00.000Z", data: { id: "m1", role: "user", text: "sim" } }], cursor: 1, more: false }),
  };
  const receipt = join(root, "sim-calls.jsonl");
  const briefings = new RepositoryBriefings(
    { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/jevcode-brief.mjs"), receipt], automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
    manager as never, projects, teamWorkspace,
  );
  const createService = (attachBriefings = true) => new UnderstandingService({
    config: { stateDir, projects } as never, key, manager: manager as never,
    ...(attachBriefings ? { briefings } : {}),
    groups: { list: () => ({ groups: [group()], suggestions: [] }), get: () => group() },
    missions: {
      understandingRecords: () => [makeMission(missionId, "platform", [...world.missionRepos])],
      understandingOwnsSession: (runId, memId, sessId, projId, cwd) => Boolean(
        world.sessionState !== "unowned"
        && runId === missionId && memId === memberId && sessId === sessionId
        && world.missionRepos.includes(projId as RepoId)
        && (cwd === undefined || realpathSync(cwd) === missionFolder),
      ),
      understandingRepoPaths: (id: string) => id === missionId
        ? Object.fromEntries(world.missionRepos.map(repo => [repo, world.recordedPaths[repo]]))
        : undefined,
    },
    teams: { understandingRecords: () => [], understandingOwnsSession: () => false },
    goals: { understandingRecords: () => [] },
  });

  return { root, paths, repos, webAltCanonical, history, world, briefings, createService, session, syncProjects };
}

test("seeded durable-state simulator verifies mission-binding invariants across heads, identities, paths, workspaces, cleanup, and reloads", async t => {
  const rawSeed = process.env.MISSION_BINDING_SIM_SEED;
  const initialSeed = rawSeed ? (Number.parseInt(rawSeed, 0) >>> 0) : 0x497b1ad5;
  t.diagnostic(`mission-binding-sim seed=0x${initialSeed.toString(16)}`);
  let state = initialSeed;
  const rand = () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

  const temp = mkdtempSync("/tmp/inf-mission-binding-sim-");
  const sim = setupSimulator(temp);
  const service = sim.createService(true);
  const { world, paths, repos, history } = sim;
  let commitCounter = 1;
  const remoteOverridden: Record<RepoId, boolean> = { api: false, web: false, docs: false };
  const canPublish = () => world.sessionState === "live"
    && world.missionRepos.every(id => world.workspaceRepos.includes(id))
    && world.missionRepos.every(id => world.identities[id] === repos[id].identity)
    && world.missionRepos.every(id => world.enrolledPaths[id] === world.recordedPaths[id]);

  try {
    await sim.briefings.summarize(sim.session(), "0");
    const first = service.get("platform").repositories.find(r => r.id === "api")!.current.find(a => a.pinnedSources)!;
    world.published.push({
      id: first.id,
      pinnedHeads: { api: world.heads.api, web: world.heads.web },
      pinnedIdentities: { api: world.identities.api, web: world.identities.web },
      pinnedPaths: { api: world.enrolledPaths.api, web: world.enrolledPaths.web },
      missionRepos: [...world.missionRepos],
      retainedAt: first.retainedAt,
    });

    for (let step = 0; step < 60; step++) {
      const roll = rand();
      if (roll < 0.22) {
        const repoId = pick(["api", "web"] as const);
        if (history[repoId].length > 1 && rand() < 0.45) {
          const target = pick(history[repoId]);
          git(paths[repoId], "reset", "--hard", target);
          world.heads[repoId] = target;
        } else {
          const nextHead = commitFile(paths[repoId], `${repoId}.txt`, `${repoId}-${commitCounter++}\n`, `sim-${step}`);
          history[repoId].push(nextHead);
          world.heads[repoId] = nextHead;
        }
      } else if (roll < 0.34) {
        const repoId = pick(["api", "web"] as const);
        if (remoteOverridden[repoId]) {
          git(paths[repoId], "config", "--unset", "remote.origin.url");
          remoteOverridden[repoId] = false;
          world.identities[repoId] = repos[repoId].identity;
        } else {
          git(paths[repoId], "config", "remote.origin.url", `https://example.invalid/${repoId}-drift.git`);
          remoteOverridden[repoId] = true;
          world.identities[repoId] = sha256(`remote:example.invalid/${repoId}-drift`);
        }
      } else if (roll < 0.44) {
        world.enrolledPaths.web = world.enrolledPaths.web === paths.web ? sim.webAltCanonical : paths.web;
        sim.syncProjects();
      } else if (roll < 0.54) {
        const sets: RepoId[][] = [["api", "web"], ["api", "web", "docs"], ["api"]];
        world.missionRepos = [...pick(sets)];
      } else if (roll < 0.64) {
        const groups: RepoId[][] = [["api", "web", "docs"], ["api", "docs"], ["api", "web"]];
        world.workspaceRepos = [...pick(groups)];
      } else if (roll < 0.78) {
        world.sessionState = pick(["live", "missing", "unreadable", "unowned", "rebound-cwd"] as const);
      } else {
        if (canPublish()) {
          if (world.published.length < 12 || oracleVisibleMissionIds(world).length > 0) {
            const knownIds = new Set(world.published.map(item => item.id));
            await sim.briefings.summarize(sim.session(), "0");
            const currentApi = service.get("platform").repositories.find(r => r.id === "api")!.current;
            for (const artifact of currentApi) {
              if (artifact.pinnedSources && !knownIds.has(artifact.id)) {
                world.published.push({
                  id: artifact.id,
                  pinnedHeads: Object.fromEntries(world.missionRepos.map(id => [id, world.heads[id]])),
                  pinnedIdentities: Object.fromEntries(world.missionRepos.map(id => [id, world.identities[id]])),
                  pinnedPaths: Object.fromEntries(world.missionRepos.map(id => [id, world.enrolledPaths[id]])),
                  missionRepos: [...world.missionRepos],
                  retainedAt: artifact.retainedAt,
                });
              }
            }
          }
        } else if (world.sessionState === "live" || world.sessionState === "unowned" || world.sessionState === "rebound-cwd") {
          await assert.rejects(sim.briefings.summarize(sim.session(), "0"));
        }
      }

      const liveView = service.get("platform");
      const reloadedView = sim.createService(false).get("platform");
      checkInvariants(liveView, reloadedView, world, `step-${step}`);
      if (world.sessionState === "live") {
        const st = await sim.briefings.status(sim.session());
        if (oracleVisibleMissionIds(world).length === 0) {
          assert.notEqual(st.state, "ready", `step-${step}: status must not report ready when oracle expects no valid mission brief`);
        }
      }
    }
  } finally {
    await sim.briefings.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test("simulator mutation checks prove every named invariant catches a targeted fault", async () => {
  const temp = mkdtempSync("/tmp/inf-mission-binding-mut-");
  const sim = setupSimulator(temp);
  const service = sim.createService(true);
  const { world } = sim;
  try {
    await sim.briefings.summarize(sim.session(), "0");
    const liveView = service.get("platform");
    const reloadedView = sim.createService(false).get("platform");
    const artifact = liveView.repositories.find(r => r.id === "api")!.current.find(a => a.pinnedSources)!;
    world.published.push({
      id: artifact.id,
      pinnedHeads: { api: world.heads.api, web: world.heads.web },
      pinnedIdentities: { api: world.identities.api, web: world.identities.web },
      pinnedPaths: { api: world.enrolledPaths.api, web: world.enrolledPaths.web },
      missionRepos: ["api", "web"],
      retainedAt: artifact.retainedAt,
    });
    checkInvariants(liveView, reloadedView, world, "baseline");

    const dropMissionOnApi = structuredClone(liveView);
    dropMissionOnApi.repositories.find(r => r.id === "api")!.current = dropMissionOnApi.repositories.find(r => r.id === "api")!.current.filter(a => !a.pinnedSources);
    assert.throws(() => checkInvariants(dropMissionOnApi, dropMissionOnApi, world, "mut-pin"), /INV_PIN_MATCH/);

    const staleHeadWorld: SimWorld = { ...structuredClone(world), heads: { ...world.heads, web: "0".repeat(40) } };
    assert.throws(() => checkInvariants(liveView, reloadedView, staleHeadWorld, "mut-head"), /INV_NO_STALE_HEAD/);

    const identityDriftWorld: SimWorld = { ...structuredClone(world), identities: { ...world.identities, web: "f".repeat(64) } };
    assert.throws(() => checkInvariants(liveView, reloadedView, identityDriftWorld, "mut-identity"), /INV_MEMBERSHIP_AND_IDENTITY/);

    const splitWorkspaceWorld: SimWorld = { ...structuredClone(world), workspaceRepos: ["api", "docs"] };
    const splitView = structuredClone(liveView);
    splitView.repositories = splitView.repositories.filter(r => r.id !== "web");
    assert.throws(() => checkInvariants(splitView, splitView, splitWorkspaceWorld, "mut-split"), /INV_WORKSPACE_ALL_OR_NOTHING/);

    const leakedToDocs = structuredClone(liveView);
    leakedToDocs.repositories.find(r => r.id === "docs")!.current.push(structuredClone(artifact));
    assert.throws(() => checkInvariants(leakedToDocs, leakedToDocs, world, "mut-symmetry"), /INV_CROSS_REPO_SYMMETRY/);

    const unreadableWorld: SimWorld = { ...structuredClone(world), sessionState: "unreadable" };
    assert.throws(() => checkInvariants(liveView, reloadedView, unreadableWorld, "mut-session"), /INV_SESSION_FAIL_CLOSED/);

    const divergedReload = structuredClone(reloadedView);
    divergedReload.repositories.find(r => r.id === "web")!.current = [];
    assert.throws(() => checkInvariants(liveView, divergedReload, world, "mut-reload"), /INV_RELOAD_EQUIVALENCE/);

    const leakedLegacyMission = structuredClone(liveView);
    leakedLegacyMission.repositories.find(r => r.id === "api")!.current.push({ ...structuredClone(artifact), id: world.legacyMissionId, pinnedSources: undefined });
    assert.throws(() => checkInvariants(leakedLegacyMission, leakedLegacyMission, world, "mut-legacy"), /INV_LEGACY_V1_ISOLATION/);
  } finally {
    await sim.briefings.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
