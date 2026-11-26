import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Manager } from "../packages/host/src/manager.js";
import { teamReportToolInputSchema } from "../packages/host/src/team-mcp.js";
import {
  MAX_TASK_LIMITATION_CHARS,
  MAX_TASK_LIMITATIONS,
  extractTaskLimitations,
  normalizeTaskLimitations,
  recordedTaskLimitations,
  taskLimitations,
} from "../packages/host/src/team-task-limitations.js";
import { recordedTeamReportSchema, taskLimitationsSchema, teamReportSchema, type TeamRun, type TeamTask, type TeamView } from "../packages/host/src/team-types.js";
import { TeamService } from "../packages/host/src/teams.js";
import type { Config } from "../packages/host/src/types.js";
import { unseal, writeSealed } from "../packages/host/src/vault.js";
import { startHost, waitFor } from "./helpers.js";

test("extractTaskLimitations matches legacy markdown headings, wrapped bullets, and multi-item lists without matching mid-sentence prose", () => {
  const macosParity = "Changes:\n- did things\n\nLimitations:\n- No Linear MCP tool was available,\n  so no comment was posted.\n\nNext: none";
  assert.deepEqual(extractTaskLimitations(macosParity), ["No Linear MCP tool was available, so no comment was posted."]);
  assert.deepEqual(extractTaskLimitations("Limitations: none known"), ["none known"]);
  assert.deepEqual(extractTaskLimitations("Limitations:\nNo fixture for empty input."), ["No fixture for empty input."]);
  assert.deepEqual(extractTaskLimitations("All good."), []);
  assert.deepEqual(extractTaskLimitations(undefined), []);
  assert.deepEqual(extractTaskLimitations("Task 0 is integrated. Limitations: none observed."), []);
  assert.deepEqual(extractTaskLimitations("Limitations of this approach are small."), []);
  assert.deepEqual(extractTaskLimitations("Limitations:\n\nNext: none"), []);

  const multi = "Done.\r\n\r\nLimitations:\r\n- First gap,\r\n  continued here.\r\n* Second gap.\r\n1. Third gap.\r\n## Next\r\n- Not a limitation";
  assert.deepEqual(extractTaskLimitations(multi), ["First gap, continued here.", "Second gap.", "Third gap."]);
  assert.deepEqual(extractTaskLimitations("## Limitations\n\n- ATX bullet one.\n- ATX bullet two.\n\n## Verification\n- Passed"), ["ATX bullet one.", "ATX bullet two."]);
  assert.deepEqual(extractTaskLimitations("**Limitations:**\n- Bold heading gap."), ["Bold heading gap."]);
  assert.deepEqual(extractTaskLimitations("**Limitations:** inline bold gap"), ["inline bold gap"]);
  assert.deepEqual(extractTaskLimitations("**Limitations:**\n\n- No live verification\n- No simulator run"), ["No live verification", "No simulator run"]);
  assert.deepEqual(extractTaskLimitations("Limitations:\n\n- No live verification"), ["No live verification"]);
  assert.deepEqual(extractTaskLimitations("**Limitations:**\n- No device test\n**Verification:**\n- Unit tests passed"), ["No device test"]);
  assert.deepEqual(extractTaskLimitations("Limitations:\n- gap\nVerification:\n- passed"), ["gap"]);
  assert.deepEqual(extractTaskLimitations("Limitations:\n- **macOS**: skipped device build\n**Next steps**\n- Follow up"), ["**macOS**: skipped device build"]);
  assert.deepEqual(extractTaskLimitations("Limitations: inline note\n- Bullet after inline"), ["inline note", "Bullet after inline"]);
  assert.deepEqual(extractTaskLimitations("Limitations: first half\nsecond half"), ["first half second half"]);
});

test("recordedTaskLimitations and taskLimitations prefer explicit structured arrays over summary scraping and enforce bounds", () => {
  const legacySummary = "Done.\n\nLimitations:\n- Scraped limitation.";
  assert.deepEqual(recordedTaskLimitations({ summary: legacySummary, limitations: ["  Explicit gap.  "] }), ["Explicit gap."]);
  assert.deepEqual(recordedTaskLimitations({ summary: legacySummary, limitations: [] }), []);
  assert.deepEqual(recordedTaskLimitations({ summary: legacySummary }), ["Scraped limitation."]);
  assert.deepEqual(taskLimitations({ summary: legacySummary, limitations: [] }), []);
  assert.deepEqual(taskLimitations({ summary: legacySummary, limitations: ["Stored gap."] }), ["Stored gap."]);
  assert.deepEqual(taskLimitations({ summary: legacySummary }), ["Scraped limitation."]);
  assert.deepEqual(taskLimitations({}), []);

  const oversized = Array.from({ length: MAX_TASK_LIMITATIONS + 5 }, (_, index) => `  item ${index} ${"x".repeat(MAX_TASK_LIMITATION_CHARS + 20)}  `);
  const bounded = normalizeTaskLimitations(["", "   ", ...oversized]);
  assert.equal(bounded.length, MAX_TASK_LIMITATIONS);
  assert.ok(bounded.every(item => item.length === MAX_TASK_LIMITATION_CHARS));
});

test("team report schemas and MCP tool schema accept structured result limitations and reject invalid items", () => {
  assert.deepEqual(
    teamReportSchema.parse({ kind: "result", summary: "Changed parser.", limitations: ["  No fixture for empty input.  "] }),
    { kind: "result", summary: "Changed parser.", limitations: ["No fixture for empty input."] },
  );
  assert.deepEqual(
    teamReportSchema.parse({ kind: "result", summary: "Changed parser.", limitations: [] }),
    { kind: "result", summary: "Changed parser.", limitations: [] },
  );
  assert.deepEqual(
    recordedTeamReportSchema.parse({ kind: "result", summary: "Legacy result." }),
    { kind: "result", summary: "Legacy result." },
  );
  assert.equal(taskLimitationsSchema.safeParse([""]).success, false);
  assert.equal(taskLimitationsSchema.safeParse(["   "]).success, false);
  assert.equal(taskLimitationsSchema.safeParse(["x".repeat(MAX_TASK_LIMITATION_CHARS + 1)]).success, false);
  assert.equal(taskLimitationsSchema.safeParse(Array.from({ length: MAX_TASK_LIMITATIONS + 1 }, (_, i) => `gap ${i}`)).success, false);

  type BranchSchema = { properties?: { kind?: { const?: string }; limitations?: { type?: string; description?: string } }; oneOf?: BranchSchema[]; anyOf?: BranchSchema[] };
  const flatten = (node: BranchSchema): BranchSchema[] => [...(node.oneOf ?? []), ...(node.anyOf ?? [])].flatMap(child => (child.oneOf || child.anyOf) ? flatten(child) : [child]);
  const reportSchema = (teamReportToolInputSchema as { properties?: { report?: BranchSchema } }).properties?.report ?? {};
  const resultBranch = flatten(reportSchema).find(branch => branch.properties?.kind?.const === "result");
  assert.equal(resultBranch?.properties?.limitations?.type, "array");
  assert.match(resultBranch?.properties?.limitations?.description ?? "", /limitations/i);
});

test("TeamService projects structured limitations for legacy sealed runs without mutating stored records", async () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-legacy-limitations-"));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "teams"), { recursive: true });
  const key = randomBytes(32);
  const runId = randomUUID();
  const at = "2026-11-26T00:00:00.000Z";
  const commit = "a".repeat(40);
  const run: TeamRun = {
    id: runId,
    projectId: "rehearsal",
    provider: "demo",
    title: "Legacy limitations projection",
    objective: "Verify legacy markdown extraction on load",
    parallelism: 2,
    revision: 1,
    status: "ready-for-review",
    createdAt: at,
    updatedAt: at,
    workspace: join(root, "ws"),
    branch: "infinite/legacy",
    baseCommit: commit,
    headCommit: commit,
    tasks: [
      {
        id: "legacy-md",
        title: "Legacy markdown task",
        instructions: "Do work",
        paths: ["a.txt"],
        dependsOn: [],
        revision: 1,
        status: "integrated",
        commit,
        summary: "Changes:\n- Updated a.txt\n\nLimitations:\n- No Linear MCP tool was available,\n  so no comment was posted.\n\nNext: none",
      },
      {
        id: "explicit-empty",
        title: "Explicit empty task",
        instructions: "Do work",
        paths: ["b.txt"],
        dependsOn: [],
        revision: 1,
        status: "integrated",
        commit,
        summary: "Done.\n\nLimitations: should not be scraped",
        limitations: [],
      },
      {
        id: "clean",
        title: "Clean task",
        instructions: "Do work",
        paths: ["c.txt"],
        dependsOn: [],
        revision: 1,
        status: "pending",
      },
    ],
    members: [],
    decisions: [],
    checks: [],
    steering: [],
    events: [],
    round: 0,
  };
  writeSealed(join(stateDir, "teams", `${runId}.sealed`), key, `team:${runId}`, {
    run,
    fingerprint: "f".repeat(64),
    receipts: {},
    prepared: true,
  });
  const config: Config = {
    port: 0,
    origin: "http://127.0.0.1",
    keyFile: join(root, "key"),
    stateDir,
    runDir: join(root, "run"),
    environment: "local",
    enableDemo: true,
    maxSessions: 4,
    projects: [],
    tokens: [],
    agents: {},
  };
  const manager = new Manager(config, key);
  const service = new TeamService(config, key, manager, (_projectId, start) => start());
  try {
    const view = service.get(runId);
    const byId = new Map(view.tasks.map(task => [task.id, task]));
    assert.deepEqual(byId.get("legacy-md")!.limitations, ["No Linear MCP tool was available, so no comment was posted."]);
    assert.deepEqual(byId.get("explicit-empty")!.limitations, []);
    assert.deepEqual(byId.get("clean")!.limitations, []);
  } finally {
    service.close();
    await service.idle();
    rmSync(root, { recursive: true, force: true });
  }
});

test("live team runs accept, persist, and serve structured task limitations across reload", { timeout: 90000 }, async () => {
  const root = realpathSync(mkdtempSync("/tmp/inf-live-limitations-"));
  const source = join(root, "source");
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  git("init", "--initial-branch=main");
  writeFileSync(join(source, "check.mjs"), 'import { existsSync } from "node:fs"; if (!existsSync("a.txt") || !existsSync("b.txt") || !existsSync("c.txt")) process.exit(1);\n');
  git("add", "check.mjs");
  git("-c", "user.name=Example Developer", "-c", "user.email=dev@example.invalid", "commit", "-m", "Initial fixture");

  const agentScript = join(root, "limitations-agent.mjs");
  writeFileSync(agentScript, [
    'import { randomUUID } from "node:crypto";',
    'import { writeFileSync } from "node:fs";',
    'const assignment = JSON.parse(process.env.INFINITE_TEAM_ASSIGNMENT);',
    'async function report(value) {',
    '  const response = await fetch(`${process.env.INFINITE_HOOK_URL}/team-report`, {',
    '    method: "POST",',
    '    headers: { Authorization: `Bearer ${process.env.INFINITE_HOOK_TOKEN}`, "Content-Type": "application/json" },',
    '    body: JSON.stringify({ requestId: randomUUID(), runId: assignment.runId, memberId: assignment.memberId, revision: assignment.revision, report: value }),',
    '  });',
    '  if (!response.ok) throw new Error(`Report refused (${response.status}): ${await response.text()}`);',
    '}',
    'if (assignment.role === "project-manager") {',
    '  await report({ kind: "plan", summary: "Three tasks", tasks: [',
    '    { id: "structured", title: "Structured task", instructions: "Write a.txt", paths: ["a.txt"], dependsOn: [] },',
    '    { id: "explicit-none", title: "Explicit empty task", instructions: "Write b.txt", paths: ["b.txt"], dependsOn: [] },',
    '    { id: "legacy-prose", title: "Legacy prose task", instructions: "Write c.txt", paths: ["c.txt"], dependsOn: [] },',
    '  ] });',
    '} else if (assignment.role === "implementer") {',
    '  if (assignment.taskId === "structured") {',
    '    writeFileSync("a.txt", "a\\n");',
    '    await report({ kind: "result", summary: "Wrote a.txt.", limitations: ["No macOS runner available.", "  Skipped live webhook check.  "] });',
    '  } else if (assignment.taskId === "explicit-none") {',
    '    writeFileSync("b.txt", "b\\n");',
    '    await report({ kind: "result", summary: "Wrote b.txt.\\n\\nLimitations:\\n- Should stay ignored.", limitations: [] });',
    '  } else {',
    '    writeFileSync("c.txt", "c\\n");',
    '    await report({ kind: "result", summary: "Wrote c.txt.\\n\\nLimitations:\\n- Legacy markdown bullet,\\n  wrapped onto line two.\\n- Second legacy gap.\\n\\nNext: none" });',
    '  }',
    '} else if (assignment.role === "reviewer") {',
    '  await report({ kind: "review", verdict: "approved", summary: "Looks good." });',
    '}',
  ].join("\n"));

  const host = await startHost({
    agents: { demo: { command: process.execPath, args: [agentScript] } },
    config: {
      projects: [{ id: "rehearsal", name: "Rehearsal", path: source, team: { checks: [{ command: process.execPath, args: ["check.mjs"] }] } }],
      teams: { workspaceDir: join(root, "teams"), publishHeads: false },
    },
  });
  let reloaded: TeamService | undefined;
  try {
    const created = await host.fetchApi("/teams", "owner", {
      requestId: randomUUID(),
      projectId: "rehearsal",
      provider: "demo",
      title: "Structured limitations run",
      objective: "Write three files with structured and legacy limitations.",
      parallelism: 3,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const finished = await waitFor<TeamView>(async () => {
      const response = await host.fetchApi(`/teams/${created.body.id}`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    }, run => run.status === "ready-for-review" || run.status === "blocked", 60000);
    assert.equal(finished.status, "ready-for-review", finished.reason);
    const byId = new Map(finished.tasks.map(task => [task.id, task]));
    assert.deepEqual(byId.get("structured")!.limitations, ["No macOS runner available.", "Skipped live webhook check."]);
    assert.deepEqual(byId.get("explicit-none")!.limitations, []);
    assert.deepEqual(byId.get("legacy-prose")!.limitations, ["Legacy markdown bullet, wrapped onto line two.", "Second legacy gap."]);

    await host.stopApi();
    const key = readFileSync(host.config.keyFile);
    reloaded = new TeamService(host.config, key, new Manager(host.config, key), (_projectId, start) => start());
    const persisted = reloaded.get(created.body.id);
    const persistedById = new Map(persisted.tasks.map(task => [task.id, task]));
    assert.deepEqual(persistedById.get("structured")!.limitations, ["No macOS runner available.", "Skipped live webhook check."]);
    assert.deepEqual(persistedById.get("explicit-none")!.limitations, []);
    assert.deepEqual(persistedById.get("legacy-prose")!.limitations, ["Legacy markdown bullet, wrapped onto line two.", "Second legacy gap."]);
  } finally {
    reloaded?.close();
    await reloaded?.idle();
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

class LimitationInvariantViolation extends Error {
  constructor(readonly invariant: string, readonly seed: number, detail: string) {
    super(`[${invariant}] seed ${seed}: ${detail}`);
  }
}

type SimMutant = "none" | "drop-persisted-limitations" | "scrape-over-explicit-empty" | "ignore-legacy-summary-on-reload";
type SimStored = { run: TeamRun; fingerprint: string; receipts: Record<string, string>; prepared: boolean };
type SimCounts = Record<string, number>;
type SimTaskOracle = { expected: string[]; explicitEmpty: boolean; legacyUnstored: boolean };

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSimTasks(revision: number, count: number): TeamTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${revision}-t${index + 1}`,
    title: `Revision ${revision} task ${index + 1}`,
    instructions: `Implement step ${index + 1}`,
    paths: [`src/r${revision}-t${index + 1}.ts`],
    dependsOn: [],
    revision,
    status: "pending" as const,
  }));
}

function makeLegacySummary(variant: number, tag: string): { summary: string; expected: string[] } {
  if (variant === 0) {
    return {
      summary: `Updated ${tag}.\n\nLimitations:\n- Gap A for ${tag},\n  wrapped line.\n- Gap B for ${tag}.\n\nNext: none`,
      expected: [`Gap A for ${tag}, wrapped line.`, `Gap B for ${tag}.`],
    };
  }
  if (variant === 1) {
    return {
      summary: `Updated ${tag}.\n\n**Limitations:**\n\n- Blank-separated gap for ${tag}\n**Verification:**\n- Unit tests passed`,
      expected: [`Blank-separated gap for ${tag}`],
    };
  }
  if (variant === 2) {
    return {
      summary: `Updated ${tag}.\n\nLimitations:\n\n- Plain blank-separated gap for ${tag}\nVerification:\n- Passed`,
      expected: [`Plain blank-separated gap for ${tag}`],
    };
  }
  return {
    summary: `Updated ${tag} with full coverage.`,
    expected: [],
  };
}

async function runLimitationsSeed(seed: number, counts: SimCounts, mutant: SimMutant = "none") {
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const bump = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; };

  const root = realpathSync(mkdtempSync("/tmp/inf-limitations-sim-"));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "teams"), { recursive: true });
  const key = randomBytes(32);
  const runId = randomUUID();
  const sealPath = join(stateDir, "teams", `${runId}.sealed`);
  const at = "2026-11-26T00:00:00.000Z";
  const commit = seed.toString(16).padStart(40, "a");
  const config: Config = {
    port: 0,
    origin: "http://127.0.0.1",
    keyFile: join(root, "key"),
    stateDir,
    runDir: join(root, "run"),
    environment: "local",
    enableDemo: true,
    maxSessions: 4,
    projects: [],
    tokens: [],
    agents: {},
  };

  let revision = 1;
  const stored: SimStored = {
    run: {
      id: runId,
      projectId: "rehearsal",
      provider: "demo",
      title: `Seed ${seed}`,
      objective: "Verify durable task limitations across faults and reloads",
      parallelism: 2,
      revision,
      status: "ready-for-review",
      createdAt: at,
      updatedAt: at,
      workspace: join(root, "ws"),
      branch: `infinite/sim-${seed}`,
      baseCommit: commit,
      headCommit: commit,
      tasks: makeSimTasks(revision, 3),
      members: [],
      decisions: [],
      checks: [],
      steering: [],
      events: [],
      round: 0,
    },
    fingerprint: "f".repeat(64),
    receipts: {},
    prepared: true,
  };

  const oracles = new Map<string, SimTaskOracle>();
  const priorContinuations: Map<string, string[]>[] = [];
  const lastReport = new Map<string, { summary: string; limitations?: string[] }>();

  const resetOracles = (tasks: TeamTask[]) => {
    oracles.clear();
    for (const task of tasks) oracles.set(task.id, { expected: [], explicitEmpty: false, legacyUnstored: false });
  };
  resetOracles(stored.run.tasks);

  const persist = () => writeSealed(sealPath, key, `team:${runId}`, stored);
  persist();

  let service: TeamService | undefined;
  const openService = () => {
    const next = new TeamService(config, key, new Manager(config, key), (_projectId, start) => start());
    if (mutant === "ignore-legacy-summary-on-reload") {
      const originalGet = next.get.bind(next);
      next.get = (id: string) => {
        const view = originalGet(id);
        const onDisk = unseal<SimStored>(key, `team:${id}`, readFileSync(sealPath, "utf8"));
        const rawById = new Map(onDisk.run.tasks.map(task => [task.id, task]));
        return {
          ...view,
          tasks: view.tasks.map(task => rawById.get(task.id)?.limitations === undefined ? { ...task, limitations: [] } : task),
        };
      };
    }
    return next;
  };
  const closeService = async () => {
    if (!service) return;
    service.close();
    await service.idle();
    service = undefined;
  };

  const applyResult = (task: TeamTask, report: { summary: string; limitations?: string[] }, legacyUnstored: boolean) => {
    task.status = "integrated";
    task.commit = commit;
    task.summary = report.summary;
    if (legacyUnstored) {
      delete task.limitations;
      return;
    }
    let recorded = recordedTaskLimitations(report);
    if (mutant === "drop-persisted-limitations" && report.limitations !== undefined && report.limitations.length > 0) {
      delete task.limitations;
      return;
    }
    if (mutant === "scrape-over-explicit-empty" && report.limitations !== undefined && report.limitations.length === 0) {
      recorded = extractTaskLimitations(report.summary);
    }
    task.limitations = recorded;
  };

  const checkInvariants = async () => {
    await closeService();
    service = openService();
    const view = service.get(runId);
    const byId = new Map(view.tasks.map(task => [task.id, task]));
    for (const [taskId, oracle] of oracles) {
      const seen = byId.get(taskId);
      if (!seen) throw new LimitationInvariantViolation("L1-retained-per-task", seed, `missing task ${taskId}`);
      if (oracle.explicitEmpty && (seen.limitations?.length ?? -1) !== 0) {
        throw new LimitationInvariantViolation("L2-explicit-empty-not-scraped", seed, `${taskId} scraped ${JSON.stringify(seen.limitations)}`);
      }
      if (oracle.legacyUnstored && JSON.stringify(seen.limitations) !== JSON.stringify(oracle.expected)) {
        throw new LimitationInvariantViolation("L3-legacy-fallback-parity", seed, `${taskId} got ${JSON.stringify(seen.limitations)} expected ${JSON.stringify(oracle.expected)}`);
      }
      if (JSON.stringify(seen.limitations) !== JSON.stringify(oracle.expected)) {
        throw new LimitationInvariantViolation("L1-retained-per-task", seed, `${taskId} got ${JSON.stringify(seen.limitations)} expected ${JSON.stringify(oracle.expected)}`);
      }
    }
    if ((view.continuations?.length ?? 0) !== priorContinuations.length) {
      throw new LimitationInvariantViolation("L4-revision-isolation", seed, `continuation count mismatch`);
    }
    for (let index = 0; index < priorContinuations.length; index++) {
      const expectedMap = priorContinuations[index]!;
      const contTasks = new Map(view.continuations![index]!.tasks.map(task => [task.id, task]));
      for (const [taskId, expected] of expectedMap) {
        const contTask = contTasks.get(taskId);
        const actual = contTask ? taskLimitations(contTask) : undefined;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new LimitationInvariantViolation("L4-revision-isolation", seed, `continuation ${index} task ${taskId} got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
        }
      }
    }
  };

  try {
    const actions = ["structured", "explicit-empty", "legacy-prose", "legacy-disk-reload", "retry", "interrupted-write", "reload", "revision-change"] as const;
    for (let step = 0; step < 12; step++) {
      const action = step < 3 ? actions[step]! : pick(actions);
      const task = pick(stored.run.tasks);
      if (action === "structured") {
        const items = [`  No device run s${seed}-p${step}  `, `Skipped external webhook s${seed}-p${step}`];
        const report = { summary: `Implemented ${task.id} cleanly.`, limitations: items };
        applyResult(task, report, false);
        oracles.set(task.id, { expected: normalizeTaskLimitations(items), explicitEmpty: false, legacyUnstored: false });
        lastReport.set(task.id, report);
        persist();
        bump("structured");
      } else if (action === "explicit-empty") {
        const report = { summary: `Implemented ${task.id}.\n\nLimitations:\n- Tempting legacy note for ${task.id}`, limitations: [] as string[] };
        applyResult(task, report, false);
        oracles.set(task.id, { expected: [], explicitEmpty: true, legacyUnstored: false });
        lastReport.set(task.id, report);
        persist();
        bump("explicit-empty");
      } else if (action === "legacy-prose") {
        const sample = makeLegacySummary((seed + step) % 4, `${task.id}-${step}`);
        const report = { summary: sample.summary };
        applyResult(task, report, false);
        oracles.set(task.id, { expected: sample.expected, explicitEmpty: false, legacyUnstored: false });
        lastReport.set(task.id, report);
        persist();
        bump("legacy-prose");
      } else if (action === "legacy-disk-reload") {
        const sample = makeLegacySummary((seed + step) % 3, `disk-${task.id}-${step}`);
        const report = { summary: sample.summary };
        applyResult(task, report, true);
        oracles.set(task.id, { expected: sample.expected, explicitEmpty: false, legacyUnstored: true });
        lastReport.set(task.id, report);
        persist();
        bump("legacy-disk-reload");
      } else if (action === "retry") {
        const prior = lastReport.get(task.id);
        if (prior) {
          const oracle = oracles.get(task.id)!;
          applyResult(task, prior, oracle.legacyUnstored);
          persist();
          bump("retry");
        }
      } else if (action === "interrupted-write") {
        const snapshotBefore = structuredClone(stored);
        const interruptedReport = { summary: `Interrupted ${task.id}`, limitations: [`Lost if interrupted ${step}`] };
        applyResult(task, interruptedReport, false);
        stored.run = unseal<SimStored>(key, `team:${runId}`, readFileSync(sealPath, "utf8")).run;
        assert.deepEqual(stored.run.tasks.map(item => item.limitations), snapshotBefore.run.tasks.map(item => item.limitations));
        bump("interrupted-write");
      } else if (action === "reload") {
        bump("reload");
      } else if (action === "revision-change") {
        priorContinuations.push(new Map([...oracles.entries()].map(([id, oracle]) => [id, oracle.expected])));
        stored.run.continuations = [
          ...(stored.run.continuations ?? []),
          { revision, requestId: randomUUID(), at, reason: `Continue seed ${seed} step ${step}`, headCommit: commit, tasks: structuredClone(stored.run.tasks) },
        ];
        revision += 1;
        stored.run.revision = revision;
        stored.run.tasks = makeSimTasks(revision, 2);
        lastReport.clear();
        resetOracles(stored.run.tasks);
        persist();
        bump("revision-change");
      }
      await checkInvariants();
    }
  } finally {
    await closeService();
    rmSync(root, { recursive: true, force: true });
  }
}

test("seeded durable-state simulator keeps persisted task limitations across faults, retries, reloads, and revisions", { timeout: 60000 }, async () => {
  const counts: SimCounts = {};
  for (let seed = 1; seed <= 24; seed++) await runLimitationsSeed(seed, counts, "none");
  for (const key of ["structured", "explicit-empty", "legacy-prose", "legacy-disk-reload", "retry", "interrupted-write", "reload", "revision-change"]) {
    assert.ok((counts[key] ?? 0) > 0, `expected coverage counter ${key} > 0, got ${counts[key] ?? 0}`);
  }

  const mutants: readonly { mutant: SimMutant; expectedInvariant: string }[] = [
    { mutant: "drop-persisted-limitations", expectedInvariant: "L1-retained-per-task" },
    { mutant: "scrape-over-explicit-empty", expectedInvariant: "L2-explicit-empty-not-scraped" },
    { mutant: "ignore-legacy-summary-on-reload", expectedInvariant: "L3-legacy-fallback-parity" },
  ];
  for (const { mutant, expectedInvariant } of mutants) {
    let caught: LimitationInvariantViolation | undefined;
    for (let seed = 1; seed <= 12; seed++) {
      try { await runLimitationsSeed(seed, {}, mutant); }
      catch (error) {
        if (error instanceof LimitationInvariantViolation) { caught = error; break; }
        throw error;
      }
    }
    assert.ok(caught, `mutant ${mutant} must fail an invariant`);
    assert.equal(caught.invariant, expectedInvariant, `mutant ${mutant} failed ${caught.invariant} instead of ${expectedInvariant}`);
  }
});
