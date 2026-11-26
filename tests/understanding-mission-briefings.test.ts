import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readGitResultAsync } from "../packages/host/src/checkout-identity.js";
import { RepositoryBriefings } from "../packages/host/src/repository-briefings.js";
import { UnderstandingService } from "../packages/host/src/understanding.js";
import { captureMissionPinnedRepositories, captureMissionPinnedRepositoriesAsync } from "../packages/host/src/understanding-binding.js";
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

test("mission briefs isolate checkpoints with --no-state and persist rejects leaked mission skips on ordinary project sessions", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-isolation-"));
  try {
    const apiPath = join(temp, "api");
    const webPath = join(temp, "web");
    const api = initRepo(apiPath, "api.txt", "api v1\n");
    const web = initRepo(webPath, "web.txt", "web v1\n");
    const teamWorkspace = join(temp, "teams");
    const missionId = randomUUID();
    const memberId = randomUUID();
    const missionSessionId = randomUUID();
    const projectSessionId = randomUUID();
    const leakedSessionId = randomUUID();
    const missionFolder = join(teamWorkspace, "missions", missionId);
    mkdirSync(missionFolder, { recursive: true });
    const checkpointFile = join(temp, "primary-checkpoint.json");
    const callsFile = join(temp, "calls.jsonl");
    const ignoreNoStateFlag = join(temp, "ignore-no-state.txt");
    const script = join(temp, "checkpoint-brief.mjs");
    writeFileSync(script, [
      "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      "const [checkpointPath, callsPath, ignoreFlagPath, ...rest] = process.argv.slice(2);",
      "const repo = rest[rest.indexOf('--repo') + 1];",
      "const session = rest[rest.indexOf('--session') + 1];",
      "const baseIdx = rest.indexOf('--base');",
      "const base = baseIdx >= 0 ? rest[baseIdx + 1] : null;",
      "const noState = rest.includes('--no-state') && !existsSync(ignoreFlagPath);",
      "appendFileSync(callsPath, `${JSON.stringify({ session, args: rest })}\\n`);",
      "const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
      "const root = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();",
      "if (!noState && existsSync(checkpointPath)) {",
      "  const saved = JSON.parse(readFileSync(checkpointPath, 'utf8'));",
      "  if (saved.repo === root && saved.base === base) {",
      "    process.stdout.write(JSON.stringify({ ...saved, decision: { action: 'skip', reason: 'shared checkpoint', judge: 'jev', worthwhile: 0.1, scope: 'skip' } }));",
      "    process.exit(0);",
      "  }",
      "}",
      "const payload = {",
      "  decision: { action: 'run', reason: 'fresh', judge: 'heuristic', worthwhile: 1, scope: 'full' },",
      "  repo: root, head, base, generatedAt: new Date().toISOString(), fingerprint: 'a'.repeat(40),",
      "  brief: { summary: `Brief from ${session}`, architecture: [], review: [], changes: [], checks: [], guidance: [], unknowns: [], diagrams: [] },",
      "  evidence: [], coverage: [],",
      "};",
      "if (!noState) writeFileSync(checkpointPath, JSON.stringify(payload));",
      "process.stdout.write(JSON.stringify(payload));",
    ].join("\n"));

    const projects: Project[] = [
      { id: "api", name: "API", path: apiPath },
      { id: "web", name: "Web", path: webPath },
    ];
    let groupRepos = [
      repoEntry("api", "API", apiPath, api.key),
      repoEntry("web", "Web", webPath, web.key),
    ];
    const group = () => makeGroup("platform", groupRepos);
    const missionSession: Session = {
      id: missionSessionId, provider: "claude", title: "Mission", projectId: "api", cwd: missionFolder,
      createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "mission",
      team: { runId: missionId, memberId, revision: 1, role: "mission-coordinator" },
    };
    const projectSession: Session = {
      id: projectSessionId, provider: "claude", title: "Project", projectId: "api", cwd: apiPath,
      createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "project",
    };
    const leakedSession: Session = {
      id: leakedSessionId, provider: "claude", title: "Leaked", projectId: "api", cwd: apiPath,
      createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "leaked",
    };
    const sessions = new Map([[missionSessionId, missionSession], [projectSessionId, projectSession], [leakedSessionId, leakedSession]]);
    const manager = {
      meta: (id: string) => {
        const s = sessions.get(id);
        if (!s) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { session: s };
      },
      state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
      events: () => ({ events: [{ seq: 1, type: "message", at: "2026-10-21T00:00:00.000Z", data: { id: "m1", role: "user", text: "go" } }], cursor: 1, more: false }),
    };
    const briefings = new RepositoryBriefings(
      { command: process.execPath, args: [script, checkpointFile, callsFile, ignoreNoStateFlag], automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
      manager as never, projects, teamWorkspace,
    );
    const service = new UnderstandingService({
      config: { stateDir: join(temp, "state"), projects } as never, key: Buffer.alloc(32, 14), manager: manager as never, briefings,
      groups: { list: () => ({ groups: [group()], suggestions: [] }), get: () => group() },
      missions: {
        understandingRecords: () => [makeMission(missionId, "platform", ["api", "web"])],
        understandingOwnsSession: () => true,
        understandingRepoPaths: () => ({ api: apiPath, web: webPath }),
      },
      teams: { understandingRecords: () => [], understandingOwnsSession: () => false },
      goals: { understandingRecords: () => [] },
    });
    const readCalls = () => readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line) as { session: string; args: string[] });
    try {
      await briefings.summarize(missionSession, "0");
      const callsAfterMission = readCalls();
      assert.equal(callsAfterMission.length, 1);
      assert.ok(callsAfterMission[0]!.args.includes("--no-state"), "mission coordinator runs pass --no-state so primary checkpoints are untouched");
      assert.equal(existsSync(checkpointFile), false, "mission coordinator run must not write primary checkout checkpoint");

      await briefings.summarize(projectSession, "0");
      const callsAfterProject = readCalls();
      assert.equal(callsAfterProject.length, 2);
      assert.ok(!callsAfterProject[1]!.args.includes("--no-state"), "ordinary project sessions keep normal checkpoint behavior");
      const apiBriefs = service.get("platform").repositories.find(r => r.id === "api")!.current;
      assert.ok(apiBriefs.some(a => a.pinnedSources === undefined && a.brief.summary === `Brief from ${projectSessionId}`));

      rmSync(checkpointFile, { force: true });
      writeFileSync(ignoreNoStateFlag, "1");
      commitFile(webPath, "web.txt", "web v2\n", "advance secondary for leak test");
      await briefings.summarize(missionSession, "0");
      assert.equal(existsSync(checkpointFile), true, "simulated buggy engine wrote mission brief into shared checkpoint");
      await assert.rejects(briefings.summarize(leakedSession, "0"), /skipped mission brief/i, "persist refuses to promote a skipped mission brief into a single-repo project artifact");

      groupRepos = [repoEntry("api", "API", apiPath, api.key)];
      const afterSplit = service.get("platform").repositories.find(r => r.id === "api")!.current.map(a => a.brief.summary);
      assert.deepEqual(afterSplit, [`Brief from ${projectSessionId}`], "no mission content remains visible on api after secondary repo leaves workspace");
    } finally {
      await briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("status reads status and source key atomically across concurrent refresh and avoids full git capture when empty", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-atomic-"));
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
    const session: Session = {
      id: sessionId, provider: "claude", title: "Coordinator", projectId: "api", cwd: missionFolder,
      createdAt: "2026-10-21T00:00:00.000Z", status: "running", contextVersion: 0, context: "", initialPrompt: "go",
      team: { runId: missionId, memberId, revision: 1, role: "mission-coordinator" },
    };
    const manager = {
      meta: () => ({ session }),
      state: async () => ({ seq: 1, capabilities: { transcript: 1 } }),
      events: () => ({ events: [{ seq: 1, type: "message", at: "2026-10-21T00:00:00.000Z", data: { id: "m1", role: "user", text: "atomic" } }], cursor: 1, more: false }),
    };
    const briefings = new RepositoryBriefings(
      { command: process.execPath, args: [join(process.cwd(), "tests/fixtures/jevcode-brief.mjs"), receipt], automatic: false, intervalMs: 100, cooldownMs: 0, timeoutMs: 10000 },
      manager as never, projects, teamWorkspace,
    );
    let currentKey = "pin-A";
    let cacheKeyCalls = 0;
    let availableResult = true;
    let interceptStatusCacheKey = false;
    let releaseIntercept!: () => void;
    let enteredIntercept!: () => void;
    const interceptEntered = new Promise<void>(resolve => { enteredIntercept = resolve; });
    briefings.useRetention({
      capture: async () => ({ key: currentKey }),
      persist: async () => {},
      captureKey: captured => (captured as { key: string }).key,
      available: async () => availableResult,
      cacheKey: async () => {
        cacheKeyCalls++;
        if (interceptStatusCacheKey) {
          interceptStatusCacheKey = false;
          enteredIntercept();
          await new Promise<void>(resolve => { releaseIntercept = resolve; });
          return currentKey;
        }
        return currentKey;
      },
    });
    try {
      assert.equal((await briefings.status(session)).state, "empty");
      assert.equal(cacheKeyCalls, 0, "status() with no summary skips full multi-repo cacheKey capture");
      availableResult = false;
      assert.equal((await briefings.status(session)).state, "unavailable");
      assert.equal(cacheKeyCalls, 0, "unavailable check without summary skips full multi-repo cacheKey capture");
      availableResult = true;

      const summaryA = await briefings.summarize(session, "0");
      assert.equal(summaryA.engine, "jevcode");

      interceptStatusCacheKey = true;
      const inFlightStatus = briefings.status(session);
      await interceptEntered;

      currentKey = "pin-B";
      const summaryB = await briefings.summarize(session, "0");
      assert.notEqual(summaryB.at, summaryA.at);
      releaseIntercept();

      const resolved = await inFlightStatus;
      assert.equal(resolved.state, "ready");
      assert.equal(resolved.summary?.at, summaryB.at, "status() must return the summary matching the validated source key, never the stale pre-await summary");
    } finally {
      await briefings.close();
    }

    const manyProjects: Project[] = [];
    const manyRepos: ProjectGroupRepo[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `repo-${i}`;
      const dir = join(temp, id);
      const info = initRepo(dir, `f${i}.txt`, `v${i}\n`);
      manyProjects.push({ id, name: id, path: dir });
      manyRepos.push(repoEntry(id, id, dir, info.key));
    }
    const ids = manyProjects.map(p => p.id);
    const manyGroup = makeGroup("many", manyRepos);
    let active = 0, peakActive = 0;
    const asyncPinned = await captureMissionPinnedRepositoriesAsync(ids, manyProjects, manyGroup, undefined, {
      concurrency: 4,
      git: async (cwd, args) => {
        active++;
        peakActive = Math.max(peakActive, active);
        await new Promise(resolve => setTimeout(resolve, 15));
        try { return await readGitResultAsync(cwd, args); }
        finally { active--; }
      },
    });
    const syncPinned = captureMissionPinnedRepositories(ids, manyProjects, manyGroup);
    assert.ok(peakActive > 1 && peakActive <= 4, `expected bounded async concurrency in [2, 4], got ${peakActive}`);
    assert.deepEqual(asyncPinned, syncPinned);
    assert.deepEqual(Object.keys(asyncPinned), Object.keys(syncPinned));
    assert.equal(api.head.length, 40);
    assert.equal(web.head.length, 40);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("cached range hit preserves active job status and automatic checkpoint restores matching cached brief on head return", async () => {
  const temp = realpathSync(mkdtempSync("/tmp/inf-mission-brief-active-restore-"));
  const started = join(temp, "started.txt");
  const release = join(temp, "release.txt");
  const receipt = join(temp, "calls.jsonl");
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
    const gateScript = join(temp, "gate-on-second.mjs");
    writeFileSync(gateScript, [
      "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      "const [startedPath, releasePath, callsPath, ...rest] = process.argv.slice(2);",
      "const repo = rest[rest.indexOf('--repo') + 1];",
      "const baseIdx = rest.indexOf('--base');",
      "const base = baseIdx >= 0 ? rest[baseIdx + 1] : null;",
      "const input = await new Promise((res, rej) => { let v = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => v += c); process.stdin.on('end', () => res(v)); process.stdin.on('error', rej); });",
      "const lines = input.trim().split('\\n').filter(Boolean);",
      "appendFileSync(callsPath, `${lines.length}\\n`);",
      "const seq = readFileSync(callsPath, 'utf8').trim().split('\\n').filter(Boolean).length;",
      "if (lines.length === 1 && input.includes('GATE_SECOND_RANGE') && !existsSync(releasePath)) {",
      "  appendFileSync(startedPath, 'started\\n');",
      "  while (!existsSync(releasePath)) await new Promise(r => setTimeout(r, 20));",
      "}",
      "const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
      "const root = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();",
      "process.stdout.write(JSON.stringify({ decision: { action: 'run', reason: 'ok', judge: 'heuristic', worthwhile: 1, scope: 'full' }, repo: root, head, base, generatedAt: new Date(Date.now() + seq * 1000).toISOString(), fingerprint: 'a'.repeat(40), brief: { summary: `Brief ${seq}`, architecture: [], review: [], changes: [], checks: [], guidance: [], unknowns: [], diagrams: [] }, evidence: [], coverage: [] }));",
    ].join("\n"));

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
      { seq: 1, type: "message", at: createdAt, data: { id: "m1", role: "user", text: "first range" } },
      { seq: 2, type: "message", at: createdAt, data: { id: "m2", role: "user", text: "GATE_SECOND_RANGE" } },
    ];
    const manager = {
      list: async () => [{ id: sessionId, createdAt, status: "running", seq: recordedEvents.length, capabilities: { transcript: 1 } }],
      meta: () => ({ session }),
      state: async () => ({ seq: recordedEvents.length, capabilities: { transcript: 1 } }),
      events: (_id: string, after: number, _limit: number, types?: Set<string>) => {
        const filtered = recordedEvents.filter(event => event.seq > after && (!types || types.has(event.type)));
        return { events: filtered, cursor: recordedEvents.length, more: false };
      },
    };
    const briefings = new RepositoryBriefings(
      { command: process.execPath, args: [gateScript, started, release, receipt], automatic: true, intervalMs: 50, cooldownMs: 0, timeoutMs: 10000 },
      manager as never, projects, teamWorkspace,
    );
    new UnderstandingService({
      config: { stateDir: join(temp, "state"), projects } as never, key: Buffer.alloc(32, 15), manager: manager as never, briefings,
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
      const briefA = await briefings.summarize(session, "0");
      assert.equal(callCount(), 1);

      const activeJob = briefings.summarize(session, "1");
      const startDeadline = Date.now() + 5000;
      while (Date.now() < startDeadline) {
        try { if (readFileSync(started, "utf8").includes("started")) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.match(readFileSync(started, "utf8"), /started/);

      const cachedRangeZero = await briefings.summarize(session, "0");
      assert.equal(cachedRangeZero.at, briefA.at);
      assert.equal((await briefings.status(session)).state, "running", "serving a cached range must not overwrite active running status");
      assert.equal(briefings.understandingStatuses().find(item => item.sessionId === sessionId)?.state, "running");

      writeFileSync(release, "go\n");
      await activeJob;
      assert.equal((await briefings.status(session)).state, "ready");
      assert.equal(callCount(), 2);

      commitFile(webPath, "web.txt", "web v2\n", "head B");
      const cachedHeadB = await briefings.summarize(session, "0");
      assert.notEqual(cachedHeadB.at, briefA.at);
      assert.equal(callCount(), 3);

      git(webPath, "reset", "--hard", web.head);
      assert.equal((await briefings.status(session)).state, "empty", "returning to head A strips head B before automatic checkpoint");
      recordedEvents.push({ seq: 3, type: "signal", at: new Date().toISOString(), data: { kind: "turn-end" } });

      const restoreDeadline = Date.now() + 5000;
      while (Date.now() < restoreDeadline) {
        if ((await briefings.status(session)).state === "ready") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const restored = await briefings.status(session);
      assert.equal(restored.state, "ready", "automatic checkpoint restores matching cached brief when returning to an earlier secondary head");
      assert.equal(restored.summary?.at, briefA.at);
      assert.equal(callCount(), 3, "restoring cached head A brief requires zero new engine invocations");
    } finally {
      writeFileSync(release, "go\n");
      await briefings.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
