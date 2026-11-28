import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prompt } from "@infinite/attention";
import type { GitReader } from "../packages/host/src/checkout-identity.js";
import { EvidenceStore, evidenceDatabasePath } from "../packages/host/src/evidence/store.js";
import { Manager } from "../packages/host/src/manager.js";
import { outcomeModule } from "../packages/host/src/outcome-store.js";
import { ProjectGroupService } from "../packages/host/src/project-groups.js";
import { evaluateLaunchAdmissionAsync } from "../packages/host/src/team-diagnostics.js";
import { teamPermissionRequest, teamPermissionTarget } from "../packages/host/src/team-permission-adapter.js";
import { collectPermissionEvidence } from "../packages/host/src/team-permission-evidence.js";
import type { TeamMember, TeamRun } from "../packages/host/src/team-types.js";
import { memberChangedPaths, prepareMemberWorkspace, writeTeamContext } from "../packages/host/src/team-workspace.js";
import type { Config, Project } from "../packages/host/src/types.js";
import { LEDGER_KEEP_MS, UsageService, type UsageSessionRow } from "../packages/host/src/usage-service.js";
import type { UsageRecord } from "../packages/host/src/usage.js";

function gitExec(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  }).trim();
}

function screenPrompt(command: string): Prompt {
  return {
    id: 1,
    kind: "permission",
    title: "Would you like to run the following command?",
    detail: `$ ${command}`,
    options: [
      { index: 1, label: "Yes", role: "accept-once" },
      { index: 2, label: "No", role: "reject-once" },
    ],
    acceptsText: false,
    source: "screen",
    pinned: true,
    hash: "a".repeat(64),
  };
}

test("memberChangedPaths collects modified, staged, and untracked files in parallel sorted without duplicates", async () => {
  const repo = mkdtempSync(join(tmpdir(), "inf-phase2-changed-"));
  try {
    gitExec(repo, "init");
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "b.txt"), "two\n");
    gitExec(repo, "add", ".");
    gitExec(repo, "commit", "-m", "base");
    const base = gitExec(repo, "rev-parse", "HEAD");

    writeFileSync(join(repo, "a.txt"), "one-mod\n");
    writeFileSync(join(repo, "b.txt"), "two-staged\n");
    gitExec(repo, "add", "b.txt");
    writeFileSync(join(repo, "b.txt"), "two-both\n");
    writeFileSync(join(repo, "c.txt"), "untracked\n");
    writeFileSync(join(repo, "ignored.log"), "ignored\n");

    const changed = await memberChangedPaths(repo, base);
    assert.deepEqual(changed, ["a.txt", "b.txt", "c.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("teamPermissionTarget consumes initialWorkspace once on first check and re-queries workspace on TOCTOU checks", async () => {
  const root = "/home/dev/projects/infinite";
  const prompt = screenPrompt("npm test");
  const initialEvidence = { files: [], limitations: [], digest: "digest-1" };
  const initialWorkspace = { changedPaths: ["src/a.ts"], evidence: initialEvidence };
  const request = teamPermissionRequest({
    run: { id: "run-1", projectId: "project-1", provider: "codex", title: "Run", objective: "Objective" } as never,
    member: { sessionId: "session-1", memberId: "member-1", role: "implementer", revision: 1 } as never,
    prompt,
    sessionRoot: root,
    workspace: initialWorkspace,
    acceptedChecks: null,
  });

  let workspaceCalls = 0;
  let currentWorkspace = initialWorkspace;
  const assignment = { runId: "run-1", memberId: "member-1", revision: 1, role: "implementer" as const };
  const target = teamPermissionTarget(request, {
    manager: {
      meta: () => ({ session: { team: assignment, cwd: root } }),
      state: async () => ({ status: "running", control: null, attention: { state: "needs-you", prompt } }),
      answerAgentPermission: async () => { throw new Error("not reached"); },
    } as never,
    assignment,
    runCheck: () => undefined,
    sessionRoot: () => root,
    initialWorkspace,
    workspace: async () => {
      workspaceCalls++;
      return currentWorkspace;
    },
  });

  const first = await target.check();
  assert.equal(first.ok, true);
  assert.equal(workspaceCalls, 0);

  const second = await target.check();
  assert.equal(second.ok, true);
  assert.equal(workspaceCalls, 1);

  currentWorkspace = { changedPaths: ["src/a.ts", "src/drift.ts"], evidence: initialEvidence };
  const third = await target.check();
  assert.equal(workspaceCalls, 2);
  assert.deepEqual(third, { ok: false, stale: true, reason: "The inspected command sources or changed paths changed." });
});

test("ProjectGroupService skips structuredClone on steady-state reads and reconciles new checkouts", () => {
  const root = mkdtempSync(join(tmpdir(), "inf-phase2-groups-"));
  const projects: Project[] = [
    { id: "alpha-one", name: "Alpha One", path: join(root, "alpha-one") },
    { id: "beta-one", name: "Beta One", path: join(root, "beta-one") },
  ];
  const config = { stateDir: join(root, "state"), projects } as Config;
  const git: GitReader = (cwd, args) => {
    if (args[0] !== "config") return undefined;
    if (cwd.includes("alpha")) return "https://github.com/example/alpha.git";
    if (cwd.includes("beta")) return "https://github.com/example/beta.git";
    return undefined;
  };
  const service = new ProjectGroupService(config, randomBytes(32), undefined, { git });
  const originalStructuredClone = globalThis.structuredClone;
  try {
    const initial = service.list();
    assert.equal(initial.groups.length, 2);

    let clones = 0;
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
      clones++;
      return originalStructuredClone(value, options);
    }) as typeof structuredClone;

    assert.equal(service.list().groups.length, 2);
    assert.equal(service.get("alpha-one").id, "alpha");
    assert.ok(service.ownerMoveMark("alpha-one").endsWith(":0"));
    assert.equal(service.storedHolder("alpha-one"), "alpha");
    assert.equal(clones, 0);

    globalThis.structuredClone = originalStructuredClone;
    projects.push({ id: "alpha-two", name: "Alpha Two", path: join(root, "alpha-two") });
    const updated = service.list();
    const alpha = updated.groups.find(group => group.id === "alpha");
    assert.ok(alpha);
    assert.deepEqual(
      alpha.repos[0]!.checkouts.map(checkout => checkout.projectId).sort(),
      ["alpha-one", "alpha-two"],
    );
  } finally {
    globalThis.structuredClone = originalStructuredClone;
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcomeModule v6 creates outcomes_pending_list_usd index and UsageService aggregates accurately", async t => {
  const root = mkdtempSync(join(tmpdir(), "inf-phase2-usage-"));
  const key = randomBytes(32);
  const store = new EvidenceStore({ databasePath: evidenceDatabasePath(root), vaultKey: key });
  try {
    store.register(outcomeModule());
    const version = store.read(db => db.get<{ version: number }>("SELECT version FROM schema_modules WHERE name='outcomes'"));
    assert.equal(version?.version, 6);
    const plan = store.read(db => db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT outcome_id FROM outcomes WHERE outcome_id > ? AND source <> 'legacy' AND disposition <> 'open' AND list_usd IS NULL "
      + "AND (session_id IS NOT NULL OR run_id IS NOT NULL) ORDER BY outcome_id ASC LIMIT ?",
      "",
      500,
    )).map(row => row.detail);
    assert.ok(plan.some(line => line.includes("USING INDEX outcomes_pending_list_usd")), plan.join("\n"));
    assert.ok(!plan.some(line => line.startsWith("SCAN outcomes")), plan.join("\n"));

    const nowMs = Date.UTC(2026, 10, 15, 12, 0, 0);
    t.mock.timers.enable({ apis: ["Date"], now: nowMs });
    const completedAt = new Date(nowMs - 60_000).toISOString();
    const record = (messageId: string): UsageRecord => ({
      provider: "opencode",
      providerId: "deepseek",
      modelId: "deepseek-flash",
      messageId,
      partId: "p1",
      modelSource: "reported",
      completedAt,
      tokens: { input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      reportedCost: 0.02,
    });
    const runId = randomUUID();
    const manager = {
      list: () => { throw new Error("not used"); },
      events: (id: string, after: number) => {
        const events = [{ seq: 1, at: completedAt, type: "usage", data: record(id) }].filter(event => event.seq > after);
        return { events, cursor: 1, more: false };
      },
    } as unknown as Manager;
    const config = {
      stateDir: root,
      usage: {
        prices: { "deepseek/deepseek-flash": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
        budgets: { opencode: { usd: 50, period: "month" } },
        accounts: { deepseek: { kind: "metered", match: ["deepseek/*"] } },
      },
    } as unknown as Config;
    const usage = new UsageService(config, key, manager, store, { now: () => nowMs });
    const rows: UsageSessionRow[] = [
      {
        id: "s-1",
        provider: "opencode",
        projectId: "proj-a",
        createdAt: completedAt,
        status: "exited",
        team: { runId, memberId: "m-1", revision: 1, role: "implementer", taskId: "task-1" },
        teamModelProfile: { id: "light", provider: "opencode" },
      } as unknown as UsageSessionRow,
      {
        id: "s-2",
        provider: "opencode",
        projectId: "proj-b",
        createdAt: completedAt,
        status: "exited",
        runtime: { nativeUi: "opencode" },
      } as unknown as UsageSessionRow,
    ];
    await usage.tick(rows);

    let reads = 0;
    const originalRead = store.read.bind(store);
    store.read = (fn => { reads++; return originalRead(fn); }) as typeof store.read;

    const summary = usage.summary(new Date(nowMs));
    assert.equal(summary.providers.opencode.spent?.messages, 2);
    assert.equal(summary.accounts[0]?.month?.usd, 0.004);
    const projectsView = usage.projects({ now: new Date(nowMs) });
    assert.equal(projectsView.projects.length, 2);
    assert.equal(usage.project("proj-a", { now: new Date(nowMs) })?.total.usd, 0.002);
    assert.equal(usage.providerSpend("opencode", "month", new Date(nowMs), "proj-b").measured, true);
    assert.equal(usage.daily({ days: 3, now: new Date(nowMs) }).days.at(-1)?.usd, 0.004);
    assert.equal(reads, 1);

    const taskStats = usage.taskUsage(runId, "task-1", 1);
    assert.equal(taskStats?.usd, 0.002);
    t.mock.timers.tick(LEDGER_KEEP_MS);
    assert.equal(usage.session("s-1").measured, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Manager and evaluateLaunchAdmissionAsync grant permission-coordinator one overflow slot past maxSessions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "p2s-")));
  try {
    const projectPath = join(root, "repo");
    const workspaceDir = join(root, "teams");
    const runWorkspace = join(workspaceDir, "run-1");
    const memberCwd = join(runWorkspace, "members", "coord-1");
    const workerCwd = join(runWorkspace, "members", "impl-2");
    mkdirSync(projectPath, { recursive: true });
    mkdirSync(memberCwd, { recursive: true });
    mkdirSync(workerCwd, { recursive: true });
    const keyFile = join(root, "key");
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    const config: Config = {
      port: 0,
      origin: "http://127.0.0.1",
      keyFile,
      stateDir: join(root, "state"),
      runDir: join(root, "run"),
      environment: "local",
      enableDemo: false,
      maxSessions: 1,
      projects: [{ id: "rehearsal", name: "Rehearsal", path: projectPath }],
      tokens: [],
      agents: {},
      teams: { workspaceDir },
    };
    const manager = new Manager(config, randomBytes(32));
    let activeSessions: { id: string; status: "running" | "starting" }[] = [{ id: "impl-1", status: "running" }];
    manager.list = (async () => activeSessions as never) as typeof manager.list;

    await assert.rejects(
      manager.createTeamSession(
        { requestId: randomUUID(), provider: "claude", projectId: "rehearsal", title: "Worker 2", prompt: "Work" },
        { runId: "run-1", memberId: "impl-2", revision: 1, role: "implementer" },
        workerCwd,
        undefined,
        workspaceDir,
      ),
      /The configured session limit has been reached/,
    );

    await assert.rejects(
      manager.createTeamSession(
        { requestId: randomUUID(), provider: "claude", projectId: "rehearsal", title: "Coordinator", prompt: "Review" },
        { runId: "run-1", memberId: "coord-1", revision: 1, role: "permission-coordinator" },
        memberCwd,
        undefined,
        workspaceDir,
      ),
      /Provider is not configured on this host/,
    );

    activeSessions = [
      { id: "impl-1", status: "running" },
      { id: "coord-1", status: "running" },
    ];
    await assert.rejects(
      manager.createTeamSession(
        { requestId: randomUUID(), provider: "claude", projectId: "rehearsal", title: "Coordinator 2", prompt: "Review" },
        { runId: "run-1", memberId: "coord-2", revision: 1, role: "permission-coordinator" },
        memberCwd,
        undefined,
        workspaceDir,
      ),
      /The configured session limit has been reached/,
    );

    const run = { id: "run-1", provider: "claude", events: [] } as unknown as TeamRun;
    const slotLimitFor = (role: TeamMember["role"]) => role === "permission-coordinator" && config.maxSessions > 0 ? config.maxSessions + 1 : config.maxSessions;
    const coordMember = { memberId: "coord-1", role: "permission-coordinator", title: "Coordinator", prompt: "Review" } as TeamMember;
    const implMember = { memberId: "impl-2", role: "implementer", title: "Implementer", prompt: "Work" } as TeamMember;

    activeSessions = [{ id: "impl-1", status: "running" }];
    const coordAdmit = await evaluateLaunchAdmissionAsync(run, coordMember, [], new Set(), "Waiting for an available host session slot.", () => {}, {
      checkSessionSlotFull: async () => activeSessions.length >= slotLimitFor(coordMember.role),
    });
    assert.equal(coordAdmit.proceed, true);

    const implHold = await evaluateLaunchAdmissionAsync(run, implMember, [], new Set(), "Waiting for an available host session slot.", () => {}, {
      checkSessionSlotFull: async () => activeSessions.length >= slotLimitFor(implMember.role),
    });
    assert.equal(implHold.proceed, false);

    activeSessions = [{ id: "impl-1", status: "running" }, { id: "coord-1", status: "running" }];
    const secondCoordHold = await evaluateLaunchAdmissionAsync(run, coordMember, [], new Set(), "Waiting for an available host session slot.", () => {}, {
      checkSessionSlotFull: async () => activeSessions.length >= slotLimitFor(coordMember.role),
    });
    assert.equal(secondCoordHold.proceed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareMemberWorkspace uses local hardlinks for readOnly roles and isolates mutating roles", async () => {
  const root = mkdtempSync(join(tmpdir(), "inf-phase2-clone-"));
  try {
    const runDir = join(root, "run-1");
    const integration = join(runDir, "integration");
    mkdirSync(integration, { recursive: true });
    gitExec(integration, "init");
    writeFileSync(join(integration, "README.md"), "hello\n");
    gitExec(integration, "add", ".");
    gitExec(integration, "commit", "-m", "init");
    const baseCommit = gitExec(integration, "rev-parse", "HEAD");

    const roCwd = await prepareMemberWorkspace(integration, "ro-1", baseCommit, undefined, undefined, { readOnly: true });
    const rwCwd = await prepareMemberWorkspace(integration, "rw-1", baseCommit, undefined, undefined, { readOnly: false });

    assert.equal(lstatSync(join(roCwd, ".git")).isDirectory(), true);
    assert.equal(lstatSync(join(roCwd, ".git")).isSymbolicLink(), false);
    assert.equal(gitExec(roCwd, "rev-parse", "HEAD"), baseCommit);
    assert.equal(gitExec(rwCwd, "rev-parse", "HEAD"), baseCommit);
    await writeTeamContext(roCwd, { role: "reviewer" });

    const objectDirs = readdirSync(join(integration, ".git", "objects")).filter(entry => /^[0-9a-f]{2}$/.test(entry));
    assert.ok(objectDirs.length > 0);
    const firstDir = objectDirs[0]!;
    const firstObj = readdirSync(join(integration, ".git", "objects", firstDir))[0]!;
    const srcStat = statSync(join(integration, ".git", "objects", firstDir, firstObj));
    const roStat = statSync(join(roCwd, ".git", "objects", firstDir, firstObj));
    const rwStat = statSync(join(rwCwd, ".git", "objects", firstDir, firstObj));
    assert.equal(roStat.ino, srcStat.ino);
    assert.notEqual(rwStat.ino, srcStat.ino);
    assert.notEqual(realpathSync(roCwd), realpathSync(rwCwd));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectPermissionEvidence accepts pure read-only output filter pipes and rejects unsafe pipe targets", () => {
  const cwd = mkdtempSync(join(tmpdir(), "inf-phase2-pipes-"));
  try {
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node scripts/check.mjs" } }));
    writeFileSync(join(cwd, "scripts/check.mjs"), "console.log('ok');\n");

    const npmFiltered = collectPermissionEvidence({ prompt: screenPrompt("npm test | tail -n 50"), cwd, changedPaths: [] });
    assert.deepEqual(npmFiltered.limitations, []);
    assert.deepEqual(npmFiltered.files.map(file => file.path), ["package.json", "scripts/check.mjs"]);

    const gitFiltered = collectPermissionEvidence({ prompt: screenPrompt("git diff | head -n 40 | wc -l"), cwd, changedPaths: [] });
    assert.deepEqual(gitFiltered.limitations, []);

    const grepFiltered = collectPermissionEvidence({ prompt: screenPrompt("npm test | grep -n -i --color=never pass | sort -u | uniq --group=separate"), cwd, changedPaths: [] });
    assert.deepEqual(grepFiltered.limitations, []);

    const rgFiltered = collectPermissionEvidence({ prompt: screenPrompt("npm test | rg -T md pass"), cwd, changedPaths: [] });
    assert.deepEqual(rgFiltered.limitations, []);

    for (const unsafe of [
      "npm test | bash",
      "npm test | tee out.txt",
      "npm test | sort -o out.txt",
      "npm test | sort --output=out.txt",
      "npm test | grep -f secrets.txt",
      "npm test | grep pattern secrets.txt",
      "npm test | grep --color . /etc/passwd",
      "npm test | grep --colour . /etc/passwd",
      "npm test | grep -T . /etc/passwd",
      "npm test | uniq --group /etc/passwd",
      "npm test | uniq --group /dev/stdin --all-repeated /tmp/out",
      "npm test | HEAD -n 10",
      "npm test | rg --pre cat pattern",
      "npm test | head -n 50 > out.txt",
      "npm test || true",
    ]) {
      const result = collectPermissionEvidence({ prompt: screenPrompt(unsafe), cwd, changedPaths: [] });
      assert.ok(
        result.limitations.includes("The command uses shell composition, expansion, or multiple lines; source collection is incomplete."),
        `${unsafe}: ${JSON.stringify(result.limitations)}`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
