import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectGroupService } from "../packages/host/src/project-groups.js";
import { MissionService } from "../packages/host/src/missions.js";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";
import { UnderstandingService } from "../packages/host/src/understanding.js";
import { captureMissionPinnedRepositories, readGitHead } from "../packages/host/src/understanding-binding.js";
import { renderUnderstanding } from "../packages/host/src/understanding-cli.js";
import { writeSealed } from "../packages/host/src/vault.js";
import type { Config, Project, Session } from "../packages/host/src/types.js";
import type { TeamLineup } from "../packages/host/src/team-types.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { ProjectGroup, ProjectGroupRepo } from "../packages/host/src/project-group-types.js";

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(path: string, file = "README.md", content = "initial\n"): { head: string; key: string; identity: string } {
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
  return {
    projectId: id,
    name,
    path: real,
    key,
    checkouts: [{ projectId: id, name, path: real, primary: true, teamReady: true }],
  };
}

function makeGroup(id: string, repos: ProjectGroupRepo[]): ProjectGroup {
  return {
    id,
    name: `Workspace ${id}`,
    kind: "owner",
    hidden: false,
    implicit: false,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    repos,
  };
}

function makeMissionRecord(id: string, groupId: string, repoProjectIds: string[]): Mission {
  const at = "2026-10-21T00:00:00.000Z";
  const strong = { id: "coord", label: "Coordinator", provider: "claude" as const, model: "claude-opus-5-5", tier: "strong" as const };
  return {
    id,
    groupId,
    groupName: `Workspace ${groupId}`,
    repoProjectIds,
    title: "Multi-repo mission",
    objective: "Coordinate changes across api and web",
    maxSubtasks: 8,
    maxMinutes: 60,
    deadlineAt: "2026-10-21T01:00:00.000Z",
    revision: 1,
    status: "working",
    createdAt: at,
    updatedAt: at,
    lineup: { coordinator: strong, integrator: strong, reviewer: strong, implementers: [] },
    subtasks: [],
    decisions: [],
    steering: [],
    events: [],
  };
}

function makeMultiRepoFixture(temp: string, options: { briefScript?: string; briefArgs?: string[] } = {}) {
  const root = realpathSync(temp);
  const apiPath = join(root, "api");
  const webPath = join(root, "web");
  const docsPath = join(root, "docs");
  const api = initRepo(apiPath, "api.txt", "api v1\n");
  const web = initRepo(webPath, "web.txt", "web v1\n");
  const docs = initRepo(docsPath, "docs.txt", "docs v1\n");
  const teamWorkspace = join(root, "teams");
  const missionId = randomUUID();
  const memberId = randomUUID();
  const sessionId = randomUUID();
  const missionFolder = join(teamWorkspace, "missions", missionId);
  mkdirSync(missionFolder, { recursive: true });
  const key = Buffer.alloc(32, 7);
  const stateDir = join(root, "state");
  const receipt = join(root, "brief-calls.jsonl");
  const projects: Project[] = [
    { id: "api", name: "API", path: apiPath },
    { id: "web", name: "Web", path: webPath },
    { id: "docs", name: "Docs", path: docsPath },
  ];
  let groupRepos = [
    repoEntry("api", "API", apiPath, api.key),
    repoEntry("web", "Web", webPath, web.key),
    repoEntry("docs", "Docs", docsPath, docs.key),
  ];
  const group = () => makeGroup("platform", groupRepos);
  const setGroupRepos = (next: ProjectGroupRepo[]) => { groupRepos = next; };
  let missionRecords: Mission[] = [makeMissionRecord(missionId, "platform", ["api", "web"])];
  const setMissionRecords = (next: Mission[]) => { missionRecords = next; };
  let ownsSession = true;
  let expectedCwd: string | undefined = missionFolder;
  const setOwnsSession = (next: boolean) => { ownsSession = next; };
  const setExpectedCwd = (next: string | undefined) => { expectedCwd = next; };
  let liveSession: Session | undefined = {
    id: sessionId,
    provider: "claude",
    title: "Mission coordinator",
    projectId: "api",
    cwd: missionFolder,
    createdAt: "2026-10-21T00:00:00.000Z",
    status: "running",
    contextVersion: 0,
    context: "",
    initialPrompt: "Coordinate api and web",
    team: { runId: missionId, memberId, revision: 1, role: "mission-coordinator" },
  };
  const setLiveSession = (next: Session | undefined) => { liveSession = next; };
  let metaError: Error | undefined;
  const setMetaError = (next: Error | undefined) => { metaError = next; };
  const manager = {
    meta: (id: string) => {
      if (metaError) throw metaError;
      if (!liveSession || liveSession.id !== id) throw Object.assign(new Error("unknown session"), { code: "ENOENT" });
      return { session: liveSession };
    },
    state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
    events: () => ({
      events: [{ seq: 1, type: "message", at: "2026-10-21T00:00:00.000Z", data: { id: "m1", role: "user", text: "Coordinate api and web changes" } }],
      cursor: 1,
      more: false,
    }),
  };
  const script = options.briefScript ?? join(process.cwd(), "tests/fixtures/jevcode-brief.mjs");
  const args = options.briefArgs ?? [script, receipt];
  const briefings = new RepositoryBriefings(
    { command: process.execPath, args, automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
    manager as never,
    projects,
    teamWorkspace,
  );
  const createService = (attachBriefings = true) => new UnderstandingService({
    config: { stateDir, projects } as never,
    key,
    manager: manager as never,
    ...(attachBriefings ? { briefings } : {}),
    groups: { list: () => ({ groups: [group()], suggestions: [] }), get: () => group() },
    missions: {
      understandingRecords: () => missionRecords,
      understandingOwnsSession: (runId, memId, sessId, projId, cwd) => Boolean(
        ownsSession
        && runId === missionId
        && memId === memberId
        && liveSession
        && sessId === liveSession.id
        && missionRecords.some(item => item.id === runId && item.repoProjectIds.includes(projId))
        && (expectedCwd === undefined || cwd === undefined || realpathSync(expectedCwd) === realpathSync(cwd)),
      ),
    } as never,
    teams: { understandingRecords: () => [], understandingOwnsSession: () => false } as never,
    goals: { understandingRecords: () => [] } as never,
  });
  const callCount = () => {
    try { return readFileSync(receipt, "utf8").trim().split("\n").filter(Boolean).length; }
    catch { return 0; }
  };
  return {
    root,
    stateDir,
    key,
    apiPath,
    webPath,
    docsPath,
    api,
    web,
    docs,
    teamWorkspace,
    missionId,
    memberId,
    sessionId,
    missionFolder,
    projects,
    receipt,
    briefings,
    createService,
    callCount,
    getSession: () => liveSession!,
    setLiveSession,
    setMetaError,
    setGroupRepos,
    setMissionRecords,
    setOwnsSession,
    setExpectedCwd,
  };
}

test("multi-repo mission coordinator brief binds all participating repos, reuses on matching heads, and survives restart", async () => {
  const temp = mkdtempSync("/tmp/inf-mission-brief-reuse-");
  try {
    const f = makeMultiRepoFixture(temp);
    const service = f.createService();
    try {
      const summary = await f.briefings.summarize(f.getSession(), "0");
      assert.equal(summary.engine, "jevcode");
      assert.equal(f.callCount(), 1);

      const view = service.get("platform");
      const apiRepo = view.repositories.find(repo => repo.id === "api")!;
      const webRepo = view.repositories.find(repo => repo.id === "web")!;
      const docsRepo = view.repositories.find(repo => repo.id === "docs")!;

      assert.equal(apiRepo.state, "ready");
      assert.equal(webRepo.state, "ready");
      assert.equal(docsRepo.state, "empty");
      assert.equal(apiRepo.current.length, 1);
      assert.equal(webRepo.current.length, 1);
      assert.equal(docsRepo.current.length, 0);
      assert.equal(apiRepo.current[0]!.id, webRepo.current[0]!.id);
      assert.deepEqual(apiRepo.current[0]!.pinnedSources, {
        api: { head: f.api.head, repoIdentity: f.api.identity },
        web: { head: f.web.head, repoIdentity: f.web.identity },
      });
      assert.equal(service.briefsPage("platform", "api").items.length, 1);
      assert.equal(service.briefsPage("platform", "web").items.length, 1);
      assert.equal(service.briefsPage("platform", "docs").items.length, 0);

      const rendered = renderUnderstanding(view).join("\n");
      assert.match(rendered, new RegExp(`pinned api@${f.api.head}, web@${f.web.head}`));

      const cached = await f.briefings.summarize(f.getSession(), "0");
      assert.equal(cached.at, summary.at);
      assert.equal(f.callCount(), 1, "unchanged pinned heads reuse the cached mission brief without re-running the engine");

      const restarted = f.createService(false);
      const afterRestart = restarted.get("platform");
      assert.equal(afterRestart.repositories.find(repo => repo.id === "api")!.current[0]!.id, apiRepo.current[0]!.id);
      assert.equal(afterRestart.repositories.find(repo => repo.id === "web")!.current[0]!.id, webRepo.current[0]!.id);
    } finally {
      await f.briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("multi-repo mission brief detects staleness and regenerates when either secondary or primary bound repo advances", async () => {
  const temp = mkdtempSync("/tmp/inf-mission-brief-stale-");
  try {
    const f = makeMultiRepoFixture(temp);
    const service = f.createService();
    try {
      await f.briefings.summarize(f.getSession(), "0");
      assert.equal(f.callCount(), 1);
      const firstId = service.get("platform").repositories.find(repo => repo.id === "api")!.current[0]!.id;

      const webHead2 = commitFile(f.webPath, "web.txt", "web v2\n", "advance web");
      const staleAfterWeb = service.get("platform");
      assert.deepEqual(staleAfterWeb.repositories.find(repo => repo.id === "api")!.current, [], "advancing secondary repo invalidates mission brief on primary repo view");
      assert.deepEqual(staleAfterWeb.repositories.find(repo => repo.id === "web")!.current, [], "advancing secondary repo invalidates mission brief on secondary repo view");

      await f.briefings.summarize(f.getSession(), "0");
      assert.equal(f.callCount(), 2, "advancing secondary repo busts cached summary and generates a fresh brief");
      const afterWebRefresh = service.get("platform");
      const secondArtifact = afterWebRefresh.repositories.find(repo => repo.id === "api")!.current[0]!;
      assert.equal(afterWebRefresh.repositories.find(repo => repo.id === "api")!.current.length, 1);
      assert.notEqual(secondArtifact.id, firstId);
      assert.deepEqual(secondArtifact.pinnedSources, {
        api: { head: f.api.head, repoIdentity: f.api.identity },
        web: { head: webHead2, repoIdentity: f.web.identity },
      });

      const apiHead2 = commitFile(f.apiPath, "api.txt", "api v2\n", "advance api");
      const staleAfterApi = service.get("platform");
      assert.deepEqual(staleAfterApi.repositories.find(repo => repo.id === "api")!.current, []);
      assert.deepEqual(staleAfterApi.repositories.find(repo => repo.id === "web")!.current, []);

      await f.briefings.summarize(f.getSession(), "0");
      assert.equal(f.callCount(), 3, "advancing primary repo busts cached summary and generates a fresh brief");
      const afterApiRefresh = service.get("platform");
      const thirdArtifact = afterApiRefresh.repositories.find(repo => repo.id === "web")!.current[0]!;
      assert.equal(afterApiRefresh.repositories.find(repo => repo.id === "web")!.current.length, 1);
      assert.equal(thirdArtifact.head, apiHead2);
      assert.deepEqual(thirdArtifact.pinnedSources, {
        api: { head: apiHead2, repoIdentity: f.api.identity },
        web: { head: webHead2, repoIdentity: f.web.identity },
      });
    } finally {
      await f.briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("in-flight commit on a secondary bound repo rejects mission brief publication", async () => {
  const temp = mkdtempSync("/tmp/inf-mission-brief-inflight-");
  const started = join(temp, "started.txt");
  const release = join(temp, "release.txt");
  try {
    const delayed = join(process.cwd(), "tests/fixtures/understanding-delayed-brief.mjs");
    const f = makeMultiRepoFixture(temp, { briefArgs: [delayed, started, release] });
    const service = f.createService();
    try {
      const pending = f.briefings.summarize(f.getSession(), "0");
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try { if (readFileSync(started, "utf8").includes("started")) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.match(readFileSync(started, "utf8"), /started/);

      commitFile(f.webPath, "web.txt", "changed mid-flight\n", "in-flight secondary change");
      writeFileSync(release, "go\n");

      await assert.rejects(pending, /enrolled source changed/i);
      const artifactDir = join(f.stateDir, "understanding", "artifacts");
      assert.deepEqual(readdirSync(artifactDir).filter(name => name.endsWith(".sealed")), []);
      const view = service.get("platform");
      assert.deepEqual(view.repositories.find(repo => repo.id === "api")!.current, []);
      assert.deepEqual(view.repositories.find(repo => repo.id === "web")!.current, []);
      assert.equal(view.repositories.find(repo => repo.id === "web")!.state, "failed");
    } finally {
      writeFileSync(release, "go\n");
      await f.briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("mission brief invalidates on identity change, membership drift, workspace split, cwd/ownership change, and tampered pinned sets", async () => {
  const temp = mkdtempSync("/tmp/inf-mission-brief-invalidation-");
  try {
    const f = makeMultiRepoFixture(temp);
    const service = f.createService();
    try {
      await f.briefings.summarize(f.getSession(), "0");
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.current.length, 1);

      git(f.webPath, "config", "remote.origin.url", "https://example.invalid/rebound.git");
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "secondary repo identity change invalidates brief");
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "web")!.current, []);
      git(f.webPath, "config", "--unset", "remote.origin.url");
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.current.length, 1);

      f.setMissionRecords([makeMissionRecord(f.missionId, "platform", ["api", "web", "docs"])]);
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "adding a repo to the mission invalidates the brief");

      f.setMissionRecords([makeMissionRecord(f.missionId, "platform", ["api"])]);
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "removing a repo from the mission invalidates the brief");

      f.setMissionRecords([makeMissionRecord(f.missionId, "platform", ["api", "web"])]);
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.current.length, 1);

      f.setGroupRepos([repoEntry("api", "API", f.apiPath, f.api.key)]);
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "splitting a bound repo out of the workspace withholds the inseparable mission brief");
      f.setGroupRepos([
        repoEntry("api", "API", f.apiPath, f.api.key),
        repoEntry("web", "Web", f.webPath, f.web.key),
        repoEntry("docs", "Docs", f.docsPath, f.docs.key),
      ]);
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.current.length, 1);

      f.setOwnsSession(false);
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "revoking mission session ownership withholds the brief");
      f.setOwnsSession(true);

      const reboundCwd = join(f.teamWorkspace, "missions", "rebound-dir");
      mkdirSync(reboundCwd, { recursive: true });
      f.setExpectedCwd(reboundCwd);
      f.getSession().cwd = reboundCwd;
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "rebinding coordinator cwd invalidates old artifact binding");
      f.setExpectedCwd(f.missionFolder);
      f.getSession().cwd = f.missionFolder;
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.current.length, 1);

      f.setMetaError(Object.assign(new Error("permission denied"), { code: "EACCES" }));
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "EACCES on session metadata must fail closed");
      f.setMetaError(new SyntaxError("corrupt session metadata"));
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "corrupt session metadata must fail closed");
      f.setMetaError(undefined);
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.current.length, 1);

      f.setLiveSession(undefined);
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.current.length, 1, "mission brief stays visible after ENOENT session removal while all pinned heads match");

      const movedWeb = join(f.root, "moved-web");
      renameSync(f.webPath, movedWeb);
      initRepo(f.webPath, "web.txt", "replaced checkout\n");
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, [], "replacing a bound checkout directory invalidates the brief even after session cleanup");
      rmSync(f.webPath, { recursive: true, force: true });
      renameSync(movedWeb, f.webPath);
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.current.length, 1);

      const artifactDir = join(f.stateDir, "understanding", "artifacts");
      const apiStat = statSync(f.apiPath);
      const webStat = statSync(f.webPath);
      const folderStat = statSync(f.missionFolder);
      const validBinding = {
        projectId: "api",
        sourceKind: "team" as const,
        enrolledPath: f.apiPath,
        root: f.apiPath,
        sourceCwd: f.missionFolder,
        projectDevice: String(apiStat.dev),
        projectInode: String(apiStat.ino),
        rootDevice: String(apiStat.dev),
        rootInode: String(apiStat.ino),
        sourceCwdDevice: String(folderStat.dev),
        sourceCwdInode: String(folderStat.ino),
        repoIdentity: f.api.identity,
        runId: f.missionId,
        memberId: f.memberId,
        missionRole: "mission-coordinator" as const,
        pinnedRepositories: {
          api: { enrolledPath: f.apiPath, projectDevice: String(apiStat.dev), projectInode: String(apiStat.ino), repoIdentity: f.api.identity, head: f.api.head },
          web: { enrolledPath: f.webPath, projectDevice: String(webStat.dev), projectInode: String(webStat.ino), repoIdentity: f.web.identity, head: f.web.head },
        },
      };
      const sealCustom = (summary: string, bindingOverride: Record<string, unknown>, pinnedSourcesOverride: Record<string, unknown> | undefined) => {
        const id = randomUUID();
        const artifact = {
          id,
          sourceProjectId: "api",
          sessionId: randomUUID(),
          sourceKind: "team",
          head: f.api.head,
          base: null,
          fingerprint: "b".repeat(40),
          generatedAt: "2026-10-21T00:00:00.000Z",
          retainedAt: "2026-10-21T00:00:01.000Z",
          coverage: [],
          brief: { summary, architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] },
          evidence: [],
          ...(pinnedSourcesOverride !== undefined ? { pinnedSources: pinnedSourcesOverride } : {}),
        };
        writeSealed(join(artifactDir, `${id}.sealed`), f.key, "understanding-artifact", {
          binding: { ...validBinding, ...bindingOverride },
          artifact,
        });
      };

      sealCustom("Mismatched head in artifact pinnedSources", {}, {
        api: { head: f.api.head, repoIdentity: f.api.identity },
        web: { head: "0".repeat(40), repoIdentity: f.web.identity },
      });
      sealCustom("Missing repo in artifact pinnedSources", {}, {
        api: { head: f.api.head, repoIdentity: f.api.identity },
      });
      sealCustom("Mismatched identity in artifact pinnedSources", {}, {
        api: { head: f.api.head, repoIdentity: f.api.identity },
        web: { head: f.web.head, repoIdentity: "f".repeat(64) },
      });
      sealCustom("Missing missionRole on binding", { missionRole: undefined }, {
        api: { head: f.api.head, repoIdentity: f.api.identity },
        web: { head: f.web.head, repoIdentity: f.web.identity },
      });
      sealCustom("Null pinned head cannot survive session cleanup", {
        pinnedRepositories: {
          ...validBinding.pinnedRepositories,
          web: { ...validBinding.pinnedRepositories.web, head: null },
        },
      }, {
        api: { head: f.api.head, repoIdentity: f.api.identity },
        web: { head: null, repoIdentity: f.web.identity },
      });

      const reloaded = f.createService(false);
      const summaries = reloaded.get("platform").repositories.find(repo => repo.id === "api")!.current.map(item => item.brief.summary);
      assert.deepEqual(summaries, ["Fixture repository brief."], "every tampered or incomplete mission pinned binding is withheld");
    } finally {
      await f.briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("legacy v1 single-repo artifacts coexist cleanly and never authorize mission coordinator records", async () => {
  const temp = mkdtempSync("/tmp/inf-mission-brief-v1-compat-");
  try {
    const f = makeMultiRepoFixture(temp);
    const artifactDir = join(f.stateDir, "understanding", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const apiStat = statSync(f.apiPath);
    const webStat = statSync(f.webPath);
    const legacyTeamRunId = randomUUID();
    const legacyMemberId = randomUUID();

    const sealLegacy = (summary: string, opts: { projectId: string; path: string; stat: ReturnType<typeof statSync>; identity: string; sourceKind: "project" | "team"; runId?: string; memberId?: string }) => {
      const id = randomUUID();
      const binding = {
        projectId: opts.projectId,
        sourceKind: opts.sourceKind,
        enrolledPath: opts.path,
        root: opts.path,
        sourceCwd: opts.path,
        projectDevice: String(opts.stat.dev),
        projectInode: String(opts.stat.ino),
        rootDevice: String(opts.stat.dev),
        rootInode: String(opts.stat.ino),
        sourceCwdDevice: String(opts.stat.dev),
        sourceCwdInode: String(opts.stat.ino),
        repoIdentity: opts.identity,
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(opts.memberId ? { memberId: opts.memberId } : {}),
      };
      const artifact = {
        id,
        sourceProjectId: opts.projectId,
        sessionId: randomUUID(),
        sourceKind: opts.sourceKind,
        head: "a".repeat(40),
        base: null,
        fingerprint: "b".repeat(40),
        generatedAt: "2026-10-20T00:00:00.000Z",
        retainedAt: "2026-10-20T00:00:00.000Z",
        coverage: [],
        brief: { summary, architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] },
        evidence: [],
      };
      writeSealed(join(artifactDir, `${id}.sealed`), f.key, "understanding-artifact", { binding, artifact });
    };

    sealLegacy("Legacy v1 project brief", { projectId: "api", path: f.apiPath, stat: apiStat, identity: f.api.identity, sourceKind: "project" });
    sealLegacy("Legacy v1 single-repo team brief", { projectId: "web", path: f.webPath, stat: webStat, identity: f.web.identity, sourceKind: "team", runId: legacyTeamRunId, memberId: legacyMemberId });
    sealLegacy("Legacy v1 single-repo mission attempt", { projectId: "api", path: f.apiPath, stat: apiStat, identity: f.api.identity, sourceKind: "team", runId: f.missionId, memberId: f.memberId });

    const service = f.createService();
    try {
      await f.briefings.summarize(f.getSession(), "0");
      const view = service.get("platform");
      const apiSummaries = view.repositories.find(repo => repo.id === "api")!.current.map(item => item.brief.summary);
      const webSummaries = view.repositories.find(repo => repo.id === "web")!.current.map(item => item.brief.summary);

      assert.deepEqual(apiSummaries, ["Fixture repository brief.", "Legacy v1 project brief"], "v1 project brief coexists with multi-repo mission brief while legacy single-repo mission record is withheld");
      assert.deepEqual(webSummaries, ["Fixture repository brief.", "Legacy v1 single-repo team brief"], "v1 single-repo team brief coexists with multi-repo mission brief");
      assert.equal(view.repositories.find(repo => repo.id === "api")!.current[1]!.pinnedSources, undefined);

      commitFile(f.webPath, "web.txt", "web v2\n", "advance web after v1 check");
      const afterAdvance = service.get("platform");
      assert.deepEqual(afterAdvance.repositories.find(repo => repo.id === "api")!.current.map(item => item.brief.summary), ["Legacy v1 project brief"]);
      assert.deepEqual(afterAdvance.repositories.find(repo => repo.id === "web")!.current.map(item => item.brief.summary), ["Legacy v1 single-repo team brief"]);
    } finally {
      await f.briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("multi-repo mission fails cleanly with mission-brief-source-unavailable when any bound repo is missing or unavailable", async () => {
  const temp = mkdtempSync("/tmp/inf-mission-brief-unavailable-");
  try {
    const f = makeMultiRepoFixture(temp);
    assert.throws(
      () => captureMissionPinnedRepositories(["api", "missing-repo"], f.projects, makeGroup("platform", [
        repoEntry("api", "API", f.apiPath, f.api.key),
        repoEntry("web", "Web", f.webPath, f.web.key),
      ])),
      /mission-brief-source-unavailable/,
    );
    f.setMissionRecords([makeMissionRecord(f.missionId, "platform", ["api", "missing-repo"])]);
    const service = f.createService();
    try {
      await assert.rejects(f.briefings.summarize(f.getSession(), "0"));
      assert.equal(f.callCount(), 0);
      assert.equal((await f.briefings.status(f.getSession())).state, "failed");
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "api")!.current, []);
    } finally {
      await f.briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("integration with real ProjectGroupService and MissionService binds multi-repo coordinator sessions and enforces cwd ownership", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-integration-"));
  try {
    const apiPath = join(temp, "api");
    const webPath = join(temp, "web");
    const api = initRepo(apiPath, "api.txt", "api v1\n");
    const web = initRepo(webPath, "web.txt", "web v1\n");
    const stateDir = join(temp, "state");
    const runDir = join(temp, "run");
    const workspaceDir = join(temp, "teams");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    const key = randomBytes(32);
    const keyFile = join(temp, "host.key");
    writeFileSync(keyFile, key, { mode: 0o600 });
    const checks = [{ command: process.execPath, args: ["-e", "0"] }];
    const lineup: TeamLineup = {
      coordinator: { id: "coord", label: "Coordinator", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
      implementers: [{ id: "light", label: "Light", provider: "codex", model: "gpt-6-luna", effort: "high", tier: "light" }],
      integrator: { id: "integrator", label: "Integrator", provider: "claude", model: "claude-opus-5-5", effort: "high", tier: "strong" },
      reviewer: { id: "reviewer", label: "Reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh", tier: "strong" },
    };
    const config: Config = {
      port: 0,
      origin: "http://127.0.0.1",
      keyFile,
      stateDir,
      runDir,
      tokens: [],
      environment: "local",
      enableDemo: false,
      maxSessions: 12,
      agents: { claude: { command: process.execPath, args: [] }, codex: { command: process.execPath, args: [] } },
      projects: [
        { id: "api", name: "API", path: apiPath, team: { checks } },
        { id: "web", name: "Web", path: webPath, team: { checks } },
      ],
      teams: { workspaceDir, lineup },
    };
    const groups = new ProjectGroupService(config, key);
    const createdGroup = groups.create({ requestId: randomUUID(), name: "Shop", repos: ["api", "web"] });

    const sessions = new Map<string, Session>();
    const manager = {
      hostLoad: { held: () => undefined },
      meta: (id: string) => {
        const session = sessions.get(id);
        if (!session) throw Object.assign(new Error("missing session"), { code: "ENOENT" });
        return { session };
      },
      state: async () => ({ status: "running", seq: 1, capabilities: { transcript: 1 }, attention: { state: "working", lastActivityAt: new Date().toISOString() } }),
      events: (_id: string, _after: number, _limit: number, types?: Set<string>) => {
        if (types && !types.has("message")) return { events: [], cursor: 1, more: false };
        return {
          events: [{ seq: 1, type: "message", at: new Date().toISOString(), data: { id: "m1", role: "user", text: "Inspect api and web" } }],
          cursor: 1,
          more: false,
        };
      },
      createTeamSession: async (req: { requestId: string; provider: "claude"; projectId: string; title: string; prompt: string }, team: NonNullable<Session["team"]>, cwd: string) => {
        const session: Session = {
          id: req.requestId,
          provider: req.provider,
          title: req.title,
          projectId: req.projectId,
          cwd: realpathSync(cwd),
          createdAt: new Date().toISOString(),
          status: "running",
          contextVersion: 0,
          context: "",
          initialPrompt: req.prompt,
          team,
        };
        sessions.set(session.id, session);
        return session;
      },
    };
    const stubTeams = {
      useMissionReservations: () => {},
      useMissionReviews: () => ({}),
      understandingRecords: () => [],
      understandingOwnsSession: () => false,
      activeForProject: () => false,
      list: () => [],
    };
    const missions = new MissionService(config, key, manager as never, stubTeams as never, groups);
    const receipt = join(temp, "integration-calls.jsonl");
    const briefings = new RepositoryBriefings(
      { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/jevcode-brief.mjs"), receipt], automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
      manager as never,
      config.projects,
      workspaceDir,
    );
    const understanding = new UnderstandingService({
      config,
      key,
      manager: manager as never,
      groups,
      missions,
      teams: stubTeams as never,
      goals: { understandingRecords: () => [] } as never,
      briefings,
    });
    try {
      const mission = await missions.create({
        requestId: randomUUID(),
        groupId: createdGroup.id,
        objective: "Ship coordinated API and Web update",
        maxSubtasks: 4,
        maxMinutes: 30,
      });
      missions.start();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !missions.get(mission.id).coordinator?.sessionId) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const coordinatorSessionId = missions.get(mission.id).coordinator?.sessionId;
      assert.ok(coordinatorSessionId, "mission launched a coordinator session");
      const session = sessions.get(coordinatorSessionId)!;
      assert.equal(session.team?.role, "mission-coordinator");
      assert.equal(missions.understandingOwnsSession(mission.id, session.team!.memberId, session.id, session.projectId, session.cwd), true);
      assert.equal(missions.understandingOwnsSession(mission.id, session.team!.memberId, session.id, session.projectId, apiPath), false, "real MissionService rejects a rebound coordinator cwd");

      await briefings.summarize(session, "0");
      const view = understanding.get(createdGroup.id);
      assert.equal(view.repositories.length, 2);
      for (const repo of view.repositories) {
        assert.equal(repo.state, "ready");
        assert.equal(repo.current.length, 1);
        assert.deepEqual(repo.current[0]!.pinnedSources, {
          api: { head: api.head, repoIdentity: api.identity },
          web: { head: web.head, repoIdentity: web.identity },
        });
      }

      const webAltPath = join(temp, "web-alt");
      git(webPath, "worktree", "add", "--detach", webAltPath, "HEAD");
      config.projects[1]!.path = webAltPath;
      assert.ok(understanding.get(createdGroup.id).repositories.every(repo => repo.current.length === 0), "redirecting a secondary project to a different worktree invalidates retained mission briefs");
      await assert.rejects(briefings.summarize(session, "0"), /Repository brief could not be generated/);
      config.projects[1]!.path = webPath;
      assert.ok(understanding.get(createdGroup.id).repositories.every(repo => repo.current.length === 1));

      commitFile(webPath, "web.txt", "web v2\n", "advance web in integration");
      const stale = understanding.get(createdGroup.id);
      assert.ok(stale.repositories.every(repo => repo.current.length === 0));
    } finally {
      await missions.close();
      await briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("readGitHead rejects enclosing parent repositories and corrupt refs, and resolves group-ID collisions cleanly", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-hardening-"));
  try {
    const outerPath = join(temp, "outer");
    initRepo(outerPath, "outer.txt", "outer repo\n");
    const nestedWeb = join(outerPath, "nested-web");
    const web = initRepo(nestedWeb, "web.txt", "nested web\n");
    assert.equal(readGitHead(nestedWeb), web.head);

    rmSync(join(nestedWeb, ".git"), { recursive: true, force: true });
    assert.equal(readGitHead(nestedWeb), undefined, "removing nested .git must not walk up to an enclosing repository HEAD");

    const unbornPath = join(temp, "unborn");
    mkdirSync(unbornPath, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: unbornPath });
    assert.equal(readGitHead(unbornPath), null, "an initialized unborn repository reports null head");
    const symbolicRef = git(unbornPath, "symbolic-ref", "--quiet", "HEAD");
    const looseRefPath = join(unbornPath, ".git", symbolicRef);
    mkdirSync(join(unbornPath, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(looseRefPath, "not-a-commit\n");
    assert.equal(readGitHead(unbornPath), undefined, "a corrupt loose branch ref must not report unborn");
    writeFileSync(looseRefPath, "0".repeat(40) + "\n");
    assert.equal(readGitHead(unbornPath), undefined, "a branch ref pointing at a missing commit object must not report unborn");
    rmSync(looseRefPath);
    assert.equal(readGitHead(unbornPath), null);
    assert.equal(readGitHead(unbornPath, (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ok: true, stdout: unbornPath };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { ok: false, status: null, stderr: "", errorCode: "ETIMEDOUT" };
      return { ok: true, stdout: symbolicRef };
    }), undefined, "a git timeout during rev-parse must fail closed as unavailable");
    assert.equal(readGitHead(unbornPath, (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ok: true, stdout: unbornPath };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { ok: false, status: 1, stderr: "" };
      if (args[0] === "symbolic-ref") return { ok: true, stdout: symbolicRef };
      return { ok: false, status: 128, stderr: "fatal: unable to read refs" };
    }), undefined, "a git permission or fatal read failure during show-ref must not report unborn");
    writeFileSync(join(unbornPath, ".git", "HEAD"), "0".repeat(40) + "\n");
    assert.equal(readGitHead(unbornPath), undefined, "a broken detached HEAD is unavailable, not unborn");

    const f = makeMultiRepoFixture(temp);
    const collidingGroup = makeGroup("api", [repoEntry("docs", "Docs", f.docsPath, f.docs.key)]);
    const realWorkspace = makeGroup("platform", [
      repoEntry("api", "API", f.apiPath, f.api.key),
      repoEntry("web", "Web", f.webPath, f.web.key),
    ]);
    const service = new UnderstandingService({
      config: { stateDir: f.stateDir, projects: f.projects } as never,
      key: f.key,
      manager: {
        meta: () => ({ session: f.getSession() }),
      } as never,
      briefings: f.briefings,
      groups: {
        list: () => ({ groups: [collidingGroup, realWorkspace], suggestions: [] }),
        get: id => (id === "api" ? collidingGroup : realWorkspace),
      },
      missions: {
        understandingRecords: () => [makeMissionRecord(f.missionId, "platform", ["api", "web"])],
        understandingOwnsSession: () => true,
      } as never,
      teams: { understandingRecords: () => [], understandingOwnsSession: () => false } as never,
      goals: { understandingRecords: () => [] } as never,
    });
    try {
      await f.briefings.summarize(f.getSession(), "0");
      const view = service.get("platform");
      assert.equal(view.repositories.find(repo => repo.id === "api")!.current.length, 1);
      assert.equal(view.repositories.find(repo => repo.id === "web")!.current.length, 1);
    } finally {
      await f.briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("queued mission brief keys its cached report by the captured heads rather than stale enqueue-time heads", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-queue-key-"));
  const started = join(temp, "started.txt");
  const release = join(temp, "release.txt");
  const calls = join(temp, "calls.jsonl");
  try {
    const script = join(temp, "gated-brief.mjs");
    writeFileSync(script, [
      "import { appendFileSync, existsSync } from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      "const [startedPath, releasePath, callsPath, ...rest] = process.argv.slice(2);",
      "const repo = rest[rest.indexOf('--repo') + 1];",
      "const baseIdx = rest.indexOf('--base');",
      "const base = baseIdx >= 0 ? rest[baseIdx + 1] : null;",
      "const session = rest[rest.indexOf('--session') + 1];",
      "appendFileSync(callsPath, `${session}\\n`);",
      "if (!existsSync(releasePath)) {",
      "  appendFileSync(startedPath, 'started\\n');",
      "  while (!existsSync(releasePath)) await new Promise(r => setTimeout(r, 20));",
      "}",
      "const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
      "const root = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();",
      "process.stdout.write(JSON.stringify({ decision: { action: 'run', reason: 'ok', judge: 'heuristic', worthwhile: 1, scope: 'full' }, repo: root, head, base, generatedAt: new Date().toISOString(), fingerprint: 'a'.repeat(40), brief: { summary: `Brief at ${head}`, architecture: [], review: [], changes: [], checks: [], guidance: [], unknowns: [], diagrams: [] }, evidence: [], coverage: [] }));",
    ].join("\n"));
    const apiPath = join(temp, "api");
    const webPath = join(temp, "web");
    const otherPath = join(temp, "other");
    const api = initRepo(apiPath, "api.txt", "api v1\n");
    const web = initRepo(webPath, "web.txt", "web v1\n");
    const other = initRepo(otherPath, "other.txt", "other v1\n");
    const teamWorkspace = join(temp, "teams");
    const missionId = randomUUID();
    const memberId = randomUUID();
    const missionSessionId = randomUUID();
    const blockerSessionId = randomUUID();
    const missionFolder = join(teamWorkspace, "missions", missionId);
    mkdirSync(missionFolder, { recursive: true });
    const projects: Project[] = [
      { id: "api", name: "API", path: apiPath },
      { id: "web", name: "Web", path: webPath },
      { id: "other", name: "Other", path: otherPath },
    ];
    const blockerSession: Session = {
      id: blockerSessionId, provider: "demo", title: "Blocker", projectId: "other", cwd: otherPath,
      createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "block",
    };
    const missionSession: Session = {
      id: missionSessionId, provider: "claude", title: "Coordinator", projectId: "api", cwd: missionFolder,
      createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "coord",
      team: { runId: missionId, memberId, revision: 1, role: "mission-coordinator" },
    };
    const sessions = new Map([[blockerSessionId, blockerSession], [missionSessionId, missionSession]]);
    const manager = {
      meta: (id: string) => ({ session: sessions.get(id)! }),
      state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
      events: () => ({ events: [{ seq: 1, type: "message", at: "2026-10-21T00:00:00.000Z", data: { id: "m1", role: "user", text: "go" } }], cursor: 1, more: false }),
    };
    const briefings = new RepositoryBriefings(
      { command: process.execPath, args: [script, started, release, calls], automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
      manager as never,
      projects,
      teamWorkspace,
    );
    const workspace = makeGroup("platform", [
      repoEntry("api", "API", apiPath, api.key),
      repoEntry("web", "Web", webPath, web.key),
      repoEntry("other", "Other", otherPath, other.key),
    ]);
    const service = new UnderstandingService({
      config: { stateDir: join(temp, "state"), projects } as never,
      key: Buffer.alloc(32, 9),
      manager: manager as never,
      briefings,
      groups: { list: () => ({ groups: [workspace], suggestions: [] }), get: () => workspace },
      missions: {
        understandingRecords: () => [makeMissionRecord(missionId, "platform", ["api", "web"])],
        understandingOwnsSession: () => true,
      } as never,
      teams: { understandingRecords: () => [], understandingOwnsSession: () => false } as never,
      goals: { understandingRecords: () => [] } as never,
    });
    const missionCalls = () => readFileSync(calls, "utf8").trim().split("\n").filter(line => line === missionSessionId).length;
    try {
      const blockerJob = briefings.summarize(blockerSession, "0");
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try { if (readFileSync(started, "utf8").includes("started")) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const queuedMissionJob = briefings.summarize(missionSession, "0");
      const pendingDeadline = Date.now() + 5000;
      while (Date.now() < pendingDeadline) {
        if ((await briefings.status(missionSession)).state === "pending") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal((await briefings.status(missionSession)).state, "pending", "mission job entered pending status before HEAD moved");

      const webHead2 = commitFile(webPath, "web.txt", "web v2\n", "advance while queued");
      writeFileSync(release, "go\n");
      await blockerJob;
      await queuedMissionJob;
      assert.equal(missionCalls(), 1);
      assert.deepEqual(service.get("platform").repositories.find(repo => repo.id === "web")!.current[0]!.pinnedSources, {
        api: { head: api.head, repoIdentity: api.identity },
        web: { head: webHead2, repoIdentity: web.identity },
      });

      await briefings.summarize(missionSession, "0");
      assert.equal(missionCalls(), 1, "report was cached under the actual captured head H2, not the stale enqueue-time head H1");

      git(webPath, "reset", "--hard", web.head);
      await briefings.summarize(missionSession, "0");
      assert.equal(missionCalls(), 2, "resetting back to H1 must not falsely hit the H2 report");
    } finally {
      writeFileSync(release, "go\n");
      await briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
