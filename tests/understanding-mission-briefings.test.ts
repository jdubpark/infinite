import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";
import { UnderstandingService } from "../packages/host/src/understanding.js";
import type { Mission } from "../packages/host/src/mission-types.js";
import type { ProjectGroup, ProjectGroupRepo } from "../packages/host/src/project-group-types.js";
import type { Project, Session } from "../packages/host/src/types.js";

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
    id, groupId, groupName: `Workspace ${groupId}`, repoProjectIds, title: "Multi-repo mission",
    objective: "Coordinate api and web", maxSubtasks: 8, maxMinutes: 60, deadlineAt: "2026-10-21T01:00:00.000Z",
    revision: 1, status: "working", createdAt: at, updatedAt: at,
    lineup: { coordinator: strong, integrator: strong, reviewer: strong, implementers: [] },
    subtasks: [], decisions: [], steering: [], events: [],
  };
}

function writeModeBriefScript(file: string) {
  writeFileSync(file, [
    "import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';",
    "import { execFileSync } from 'node:child_process';",
    "const [modeFile, stateFile, callsFile, ...rest] = process.argv.slice(2);",
    "const repo = rest[rest.indexOf('--repo') + 1];",
    "const baseIdx = rest.indexOf('--base');",
    "const base = baseIdx >= 0 ? rest[baseIdx + 1] : null;",
    "const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'run';",
    "appendFileSync(callsFile, `${mode}\\n`);",
    "const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
    "const root = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();",
    "if (mode === 'skip' && existsSync(stateFile)) {",
    "  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));",
    "  process.stdout.write(JSON.stringify({ ...saved, decision: { action: 'skip', reason: 'primary unchanged', judge: 'jev', worthwhile: 0.1, scope: 'skip' } }));",
    "  process.exit(0);",
    "}",
    "const payload = {",
    "  decision: mode === 'skip'",
    "    ? { action: 'skip', reason: 'no prior brief', judge: 'jev', worthwhile: 0.1, scope: 'skip' }",
    "    : { action: 'run', reason: 'refreshed', judge: 'heuristic', worthwhile: 1, scope: 'full' },",
    "  repo: root, head, base, generatedAt: new Date().toISOString(), fingerprint: 'a'.repeat(40),",
    "  brief: { summary: `Generated at ${head}`, architecture: [], review: [], changes: [], checks: [], guidance: [], unknowns: [], diagrams: [] },",
    "  evidence: [], coverage: [],",
    "};",
    "if (mode === 'run') writeFileSync(stateFile, JSON.stringify(payload));",
    "process.stdout.write(JSON.stringify(payload));",
  ].join("\n"));
}

test("jevcode auto skip never relabels an older mission brief under a new secondary head, while an unchanged match reuses cleanly", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-skip-"));
  try {
    const apiPath = join(temp, "api");
    const webPath = join(temp, "web");
    const api = initRepo(apiPath, "api.txt", "api v1\n");
    const web = initRepo(webPath, "web.txt", "web v1\n");
    const teamWorkspace = join(temp, "teams");
    const missionId = randomUUID();
    const memberId = randomUUID();
    const sessionId = randomUUID();
    const missionFolder = join(teamWorkspace, "missions", missionId);
    mkdirSync(missionFolder, { recursive: true });
    const stateDir = join(temp, "state");
    const key = Buffer.alloc(32, 11);
    const script = join(temp, "mode-brief.mjs");
    const modeFile = join(temp, "mode.txt");
    const savedBriefFile = join(temp, "saved-brief.json");
    const callsFile = join(temp, "calls.log");
    writeModeBriefScript(script);

    const projects: Project[] = [
      { id: "api", name: "API", path: apiPath },
      { id: "web", name: "Web", path: webPath },
    ];
    const group = makeGroup("platform", [
      repoEntry("api", "API", apiPath, api.key),
      repoEntry("web", "Web", webPath, web.key),
    ]);
    const session: Session = {
      id: sessionId, provider: "claude", title: "Coordinator", projectId: "api", cwd: missionFolder,
      createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "go",
      team: { runId: missionId, memberId, revision: 1, role: "mission-coordinator" },
    };
    const manager = {
      meta: (id: string) => {
        if (id !== sessionId) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { session };
      },
      state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
      events: () => ({ events: [{ seq: 1, type: "message", at: "2026-10-21T00:00:00.000Z", data: { id: "m1", role: "user", text: "brief both" } }], cursor: 1, more: false }),
    };
    const makePair = () => {
      const briefings = new RepositoryBriefings(
        { command: process.execPath, args: [script, modeFile, savedBriefFile, callsFile], automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
        manager as never, projects, teamWorkspace,
      );
      const service = new UnderstandingService({
        config: { stateDir, projects } as never, key, manager: manager as never, briefings,
        groups: { list: () => ({ groups: [group], suggestions: [] }), get: () => group },
        missions: {
          understandingRecords: () => [makeMission(missionId, "platform", ["api", "web"])],
          understandingOwnsSession: () => true,
          understandingRepoPaths: () => ({ api: apiPath, web: webPath }),
        },
        teams: { understandingRecords: () => [], understandingOwnsSession: () => false },
        goals: { understandingRecords: () => [] },
      });
      return { briefings, service };
    };

    const first = makePair();
    const second = makePair();
    try {
      writeFileSync(modeFile, "skip");
      await assert.rejects(first.briefings.summarize(session, "0"), /skipped refresh/i, "unverified skip with no prior retained multi-repo binding is rejected");
      assert.deepEqual(readdirSync(join(stateDir, "understanding", "artifacts")).filter(name => name.endsWith(".sealed")), []);

      writeFileSync(modeFile, "run");
      const generated = await first.briefings.summarize(session, "0");
      assert.equal(generated.engine, "jevcode");
      const sealedAfterRun = readdirSync(join(stateDir, "understanding", "artifacts")).filter(name => name.endsWith(".sealed"));
      assert.equal(sealedAfterRun.length, 1);

      const reloaded = makePair();
      try {
        writeFileSync(modeFile, "skip");
        const reused = await reloaded.briefings.summarize(session, "0");
        assert.equal(reused.at, generated.at, "skip matching the complete retained multi-repo pin map reuses cleanly after cold cache");
        assert.equal(readdirSync(join(stateDir, "understanding", "artifacts")).filter(name => name.endsWith(".sealed")).length, 1);

        commitFile(webPath, "web.txt", "web v2\n", "advance secondary only");
        await assert.rejects(reloaded.briefings.summarize(session, "0"), /skipped refresh/i, "skip must not relabel old brief under new secondary head");
        assert.equal(readdirSync(join(stateDir, "understanding", "artifacts")).filter(name => name.endsWith(".sealed")).length, 1);
        assert.deepEqual(reloaded.service.get("platform").repositories.find(repo => repo.id === "api")!.current, []);
        assert.deepEqual(reloaded.service.get("platform").repositories.find(repo => repo.id === "web")!.current, []);
        const failedStatus = await reloaded.briefings.status(session);
        assert.equal(failedStatus.state, "failed");
        assert.equal(failedStatus.summary, undefined, "stale summary is stripped from failed status after secondary drift");
      } finally {
        await reloaded.briefings.close();
      }
    } finally {
      await first.briefings.close();
      await second.briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("status-only summary route validates live mission pins on secondary drift and workspace split without running the engine", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-status-"));
  try {
    const apiPath = join(temp, "api");
    const webPath = join(temp, "web");
    const api = initRepo(apiPath, "api.txt", "api v1\n");
    const web = initRepo(webPath, "web.txt", "web v1\n");
    const teamWorkspace = join(temp, "teams");
    const missionId = randomUUID();
    const memberId = randomUUID();
    const sessionId = randomUUID();
    const missionFolder = join(teamWorkspace, "missions", missionId);
    mkdirSync(missionFolder, { recursive: true });
    const receipt = join(temp, "calls.jsonl");
    const projects: Project[] = [
      { id: "api", name: "API", path: apiPath },
      { id: "web", name: "Web", path: webPath },
    ];
    let groupRepos = [
      repoEntry("api", "API", apiPath, api.key),
      repoEntry("web", "Web", webPath, web.key),
    ];
    const group = () => makeGroup("platform", groupRepos);
    const session: Session = {
      id: sessionId, provider: "claude", title: "Coordinator", projectId: "api", cwd: missionFolder,
      createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "go",
      team: { runId: missionId, memberId, revision: 1, role: "mission-coordinator" },
    };
    const manager = {
      meta: (id: string) => {
        if (id !== sessionId) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { session };
      },
      state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
      events: () => ({ events: [{ seq: 1, type: "message", at: "2026-10-21T00:00:00.000Z", data: { id: "m1", role: "user", text: "status check" } }], cursor: 1, more: false }),
    };
    const briefings = new RepositoryBriefings(
      { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/jevcode-brief.mjs"), receipt], automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
      manager as never, projects, teamWorkspace,
    );
    new UnderstandingService({
      config: { stateDir: join(temp, "state"), projects } as never, key: Buffer.alloc(32, 12), manager: manager as never, briefings,
      groups: { list: () => ({ groups: [group()], suggestions: [] }), get: () => group() },
      missions: {
        understandingRecords: () => [makeMission(missionId, "platform", ["api", "web"])],
        understandingOwnsSession: () => true,
        understandingRepoPaths: () => ({ api: apiPath, web: webPath }),
      },
      teams: { understandingRecords: () => [], understandingOwnsSession: () => false },
      goals: { understandingRecords: () => [] },
    });
    const callCount = () => {
      try { return readFileSync(receipt, "utf8").trim().split("\n").filter(Boolean).length; }
      catch { return 0; }
    };
    try {
      const initial = await briefings.status(session);
      assert.equal(initial.state, "empty");
      assert.equal(callCount(), 0);

      await briefings.summarize(session, "0");
      assert.equal(callCount(), 1);
      const ready = await briefings.status(session);
      assert.equal(ready.state, "ready");
      assert.ok(ready.summary);

      commitFile(webPath, "web.txt", "web v2\n", "advance secondary before status check");
      const afterDrift = await briefings.status(session);
      assert.equal(afterDrift.state, "empty", "status suppresses stale ready summary when secondary repo advances");
      assert.equal(afterDrift.summary, undefined);
      assert.equal(callCount(), 1, "status-only check must not start a model job");

      git(webPath, "reset", "--hard", web.head);
      const afterReset = await briefings.status(session);
      assert.equal(afterReset.state, "ready");
      assert.ok(afterReset.summary);

      groupRepos = [repoEntry("api", "API", apiPath, api.key)];
      const afterSplit = await briefings.status(session);
      assert.equal(afterSplit.state, "unavailable", "status reports unavailable when bound repos split across workspaces");
      assert.equal(afterSplit.summary, undefined);
      assert.equal(callCount(), 1);
    } finally {
      await briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("automatic mission briefing settles from pending back to ready on a re-keyed cache hit", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-auto-hit-"));
  try {
    const apiPath = join(temp, "api");
    const webPath = join(temp, "web");
    const api = initRepo(apiPath, "api.txt", "api v1\n");
    const web = initRepo(webPath, "web.txt", "web v1\n");
    const teamWorkspace = join(temp, "teams");
    const missionId = randomUUID();
    const memberId = randomUUID();
    const sessionId = randomUUID();
    const missionFolder = join(teamWorkspace, "missions", missionId);
    mkdirSync(missionFolder, { recursive: true });
    const receipt = join(temp, "calls.jsonl");
    const projects: Project[] = [
      { id: "api", name: "API", path: apiPath },
      { id: "web", name: "Web", path: webPath },
    ];
    const group = makeGroup("platform", [
      repoEntry("api", "API", apiPath, api.key),
      repoEntry("web", "Web", webPath, web.key),
    ]);
    const createdAt = new Date().toISOString();
    const session: Session = {
      id: sessionId, provider: "claude", title: "Coordinator", projectId: "api", cwd: missionFolder,
      createdAt, status: "running", contextVersion: 0, context: "", initialPrompt: "go",
      team: { runId: missionId, memberId, revision: 1, role: "mission-coordinator" },
    };
    const recordedEvents: Array<{ seq: number; type: string; at: string; data: Record<string, unknown> }> = [
      { seq: 1, type: "message", at: createdAt, data: { id: "m1", role: "user", text: "auto mission turn" } },
    ];
    const manager = {
      list: async () => [{ id: sessionId, createdAt, status: "running", seq: recordedEvents.length, capabilities: { transcript: 1 } }],
      meta: (id: string) => {
        if (id !== sessionId) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { session };
      },
      state: async () => ({ seq: recordedEvents.length, capabilities: { transcript: 1 } }),
      events: (_id: string, after: number, _limit: number, types?: Set<string>) => {
        const filtered = recordedEvents.filter(event => event.seq > after && (!types || types.has(event.type)));
        return { events: filtered, cursor: recordedEvents.length, more: false };
      },
    };
    const briefings = new RepositoryBriefings(
      { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/jevcode-brief.mjs"), receipt], automatic: true, intervalMs: 50, cooldownMs: 1200, timeoutMs: 10000 },
      manager as never, projects, teamWorkspace,
    );
    const service = new UnderstandingService({
      config: { stateDir: join(temp, "state"), projects } as never, key: Buffer.alloc(32, 13), manager: manager as never, briefings,
      groups: { list: () => ({ groups: [group], suggestions: [] }), get: () => group },
      missions: {
        understandingRecords: () => [makeMission(missionId, "platform", ["api", "web"])],
        understandingOwnsSession: () => true,
        understandingRepoPaths: () => ({ api: apiPath, web: webPath }),
      },
      teams: { understandingRecords: () => [], understandingOwnsSession: () => false },
      goals: { understandingRecords: () => [] },
    });
    const callCount = () => {
      try { return readFileSync(receipt, "utf8").trim().split("\n").filter(Boolean).length; }
      catch { return 0; }
    };
    try {
      await briefings.start();
      await briefings.summarize(session, "0");
      assert.equal(callCount(), 1);

      commitFile(webPath, "web.txt", "web v2\n", "temporary secondary commit");
      recordedEvents.push({ seq: 2, type: "signal", at: new Date().toISOString(), data: { kind: "turn-end" } });

      const pendingDeadline = Date.now() + 5000;
      while (Date.now() < pendingDeadline) {
        if ((await briefings.status(session)).state === "pending") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const pendingStatus = await briefings.status(session);
      assert.equal(pendingStatus.state, "pending");
      assert.equal(pendingStatus.summary, undefined, "stale summary is withheld while pending under a different secondary head");

      git(webPath, "reset", "--hard", web.head);
      const readyDeadline = Date.now() + 5000;
      while (Date.now() < readyDeadline) {
        if ((await briefings.status(session)).state === "ready") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const settled = await briefings.status(session);
      assert.equal(settled.state, "ready", "automatic briefing settles from pending back to ready when re-keyed drain hits cache");
      assert.ok(settled.summary);
      assert.equal(callCount(), 1, "re-keyed cache hit reuses cached brief without invoking the engine again");
      assert.equal(service.get("platform").repositories.find(repo => repo.id === "api")!.state, "ready");
    } finally {
      await briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
