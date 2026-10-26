import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ComponentChange, Diagram, UnderstandingWork } from "@infinite/remote";
import { MAX_RESPONSE_BYTES } from "@infinite/remote/protocol";
import type { KnowledgeComponent, KnowledgeRelationship } from "@infinite/remote";
import type { TeamRun, TeamTask } from "../packages/host/src/team-types.js";
import type { ProductGoal } from "../packages/host/src/goal-types.js";
import type { RepoContext } from "../packages/host/src/understanding-runtime.js";
import {
  WorkBriefService,
  assembleTeamBrief,
  boundedWorkBrief,
  changeMap,
  classifyChanges,
  type NarrativeRecord,
  type WorkSources,
} from "../packages/host/src/understanding-work.js";

const repositoryId = "repo";
const at = "2026-10-25T12:00:00.000Z";

function narrativeKey(workId: string, baseCommit: string | null, headCommit: string | null): string {
  return createHash("sha256").update(JSON.stringify([workId, baseCommit, headCommit])).digest("hex");
}

function component(id: string, name: string, path: string, paths = [path], files = paths): KnowledgeComponent {
  return {
    id,
    name,
    description: "",
    repositoryIds: [repositoryId],
    paths: paths.map(value => ({ repositoryId, path: value })),
    files: files.map(value => ({ repositoryId, path: value, hash: "0".repeat(40), lines: 1 })),
    pinned: false,
    retired: false,
    redirectTo: null,
    current: { state: "ready", snapshotId: "snapshot", sources: [], summary: "", claims: [], brief: null, generatedAt: at },
    planned: [],
    difference: { state: "unverified", summary: "", claims: [], planRevisions: [], snapshotId: null, generatedAt: null },
    featureIds: [],
    history: [],
    coverage: [],
  };
}

function fixtureComponents(): KnowledgeComponent[] {
  return [
    component("auth", "Authentication", "src/auth", ["src/auth"], ["src/auth/session.ts", "src/auth/existing.ts"]),
    component("billing", "Billing", "src/billing", ["src/billing"], ["src/billing/index.ts"]),
    component("legacy", "Legacy", "src/legacy", ["src/legacy"], ["src/legacy/old.ts"]),
  ];
}

function fixtureFiles(): NonNullable<TeamRun["changes"]>["files"] {
  return [
    { path: "src/auth/session.ts", status: "modified", added: 4, removed: 1 },
    { path: "src/billing/index.ts", status: "added", added: 8, removed: 0 },
    { path: "src/legacy/old.ts", status: "removed", added: 0, removed: 12 },
    { path: "docs/guide.md", status: "modified", added: 2, removed: 1 },
  ];
}

function relationship(from: string, to: string, kind: KnowledgeRelationship["kind"] = "imports", evidence: KnowledgeRelationship["evidence"] = []): KnowledgeRelationship {
  return { id: `${from}-${to}`, from, to, kind, basis: "source", summary: "Recorded relationship.", evidence };
}

function task(id: string, title: string, changedPaths: string[], extras: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    title,
    objective: title,
    revision: 1,
    status: "integrated",
    changedPaths: { paths: changedPaths, truncated: false },
    summary: `${title} report.`,
    reviewRounds: 1,
    ...extras,
  } as TeamTask;
}

function run(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: "run",
    projectId: repositoryId,
    title: "Work brief fixture",
    objective: "## Request\n\nMake the recorded changes.\n\n- First\n  - Nested\n\n## Verification\n\nReview the recorded checks.",
    status: "ready-for-review",
    revision: 3,
    createdAt: at,
    updatedAt: at,
    baseCommit: "base-commit",
    headCommit: "head-commit",
    tasks: [
      task("task-auth", "Authentication changes", ["src/auth/session.ts"]),
      task("task-auth-tests", "Cover authentication", ["src/auth/session.ts"], { revision: 2 }),
      task("task-billing", "Add billing", ["src/billing/index.ts"], { revision: 2 }),
    ],
    continuations: [],
    checks: [],
    decisions: [],
    steering: [],
    events: [],
    members: [],
    round: 1,
    workspace: "workspace",
    branch: "branch",
    provider: "codex",
    parallelism: 1,
    changes: { headCommit: "head-commit", recordedAt: at, files: fixtureFiles(), truncated: false },
    ...overrides,
  } as TeamRun;
}

function fixtureChanges(): ComponentChange[] {
  return classifyChanges(fixtureFiles(), repositoryId, fixtureComponents(), [
    { taskId: "task-auth", paths: ["src/auth/session.ts"] },
    { taskId: "task-auth-tests", paths: ["src/auth/session.ts"] },
    { taskId: "task-billing", paths: ["src/billing/index.ts"] },
  ]);
}

test("classifies recorded statuses by longest component path and falls back to folders", () => {
  const changes = fixtureChanges();
  const byPath = new Map(changes.map(change => [change.path, change]));

  assert.equal(byPath.get("src/auth")?.change, "modified");
  assert.equal(byPath.get("src/billing")?.change, "added");
  assert.equal(byPath.get("src/legacy")?.change, "removed");
  assert.equal(byPath.get("docs")?.componentId, null);
  assert.deepEqual(byPath.get("src/auth")?.taskIds, ["task-auth", "task-auth-tests"]);
  assert.deepEqual(byPath.get("src/billing")?.taskIds, ["task-billing"]);
  assert.deepEqual(byPath.get("docs")?.taskIds, []);
});

test("change map shows changed units, relationship kinds, source basis, and caps neighbors", () => {
  const changes = fixtureChanges();
  const components = fixtureComponents();
  const edge = relationship("auth", "billing", "imports", [{ repositoryId, source: "src/auth/session.ts", line: 7, text: "import billing" }]);
  const diagram = changeMap(changes, [edge], components);

  assert.equal(diagram.basis, "source");
  assert.equal(diagram.direction, "LR");
  assert.equal(diagram.nodes.length, 4);
  assert.ok(diagram.nodes.every(node => node.change));
  assert.deepEqual(diagram.edges.map(value => [value.from, value.to, value.kind]), [["auth", "billing", "imports"]]);
  assert.deepEqual(diagram.citations, [{ source: "src/auth/session.ts", line: 7 }]);

  const neighbors = Array.from({ length: 40 }, (_, index) => component(`neighbor-${index}`, `Neighbor ${index}`, `lib/${index}`));
  const manyEdges = neighbors.map((neighbor, index) => relationship("auth", neighbor.id, index === 0 ? "calls" : "imports"));
  const bounded = changeMap(changes, manyEdges, [...components, ...neighbors]);
  assert.ok(bounded.nodes.length <= 24);
  assert.ok(bounded.nodes.some(node => node.id === "auth"));
  assert.ok(bounded.nodes.some(node => node.id === "billing"));
  assert.ok(bounded.coverage.includes("0 changed units and 20 relationships were omitted from the map"));

  const changedUnits = Array.from({ length: 25 }, (_, index) => ({
    componentId: `unit-${index}`,
    name: `Unit ${index}`,
    path: `src/unit-${index}`,
    repositoryId,
    change: "modified" as const,
    files: [],
    filesTotal: 0,
    taskIds: [],
  }));
  const changedComponents = changedUnits.map(change => component(change.componentId!, change.name, change.path));
  const cappedChanges = changeMap(changedUnits, [], changedComponents);
  assert.ok(cappedChanges.coverage.includes("1 changed unit and 0 relationships were omitted from the map"));

  const denseEdges = Array.from({ length: 121 }, (_, index) => ({ ...edge, id: `auth-billing-${index}` }));
  const cappedEdges = changeMap(changes, denseEdges, components);
  assert.equal(cappedEdges.edges.length, 120);
  assert.deepEqual(cappedEdges.coverage, ["0 changed units and 1 relationship were omitted from the map"]);
});

test("assembles team sections in contract order from recorded work", () => {
  const brief = assembleTeamBrief({
    workspaceId: "ws",
    run: run({
      reason: "The run stopped after the recorded verification round.",
      checks: [
        { command: { command: "npm", args: ["test"] }, status: "failed", exitCode: 1, startedAt: at, output: `head\n${"x".repeat(2200)}`, revision: 3 },
        { command: { command: "npm", args: ["run", "typecheck"] }, phase: "setup", status: "passed", exitCode: 0, startedAt: at, finishedAt: at, output: "ok", revision: 3 },
      ],
      decisions: [{ id: "decision-1", memberId: "member", revision: 3, question: "Keep the adapter?", options: ["yes", "no"], createdAt: at, answer: "yes", answeredBy: "owner", answeredAt: at }],
    }),
    repositoryId,
    components: fixtureComponents(),
    relationships: [relationship("auth", "billing", "imports")],
    mapObservedAt: at,
    narrative: null,
    now: at,
  });

  assert.deepEqual(brief.sections.map(section => section.kind), ["overview", "changes", "diagram", "tasks", "checks", "decisions", "request", "report", "evidence"]);
  const overview = brief.sections.find(section => section.kind === "overview")!;
  const facts = overview.blocks.find(block => block.kind === "facts");
  assert.ok(facts?.kind === "facts" && facts.items.some(item => item.label === "Execution status" && item.value === "ready-for-review"));
  assert.ok(facts?.kind === "facts" && facts.items.some(item => item.value === "1 added · 1 modified · 1 removed"));

  const request = brief.sections.find(section => section.kind === "request")!;
  const rich = request.blocks.find(block => block.kind === "rich");
  assert.ok(rich?.kind === "rich" && rich.nodes[0]?.type === "heading" && rich.nodes[0].level === 2);
  const checks = brief.sections.find(section => section.kind === "checks")?.blocks.find(block => block.kind === "checks");
  assert.ok(checks?.kind === "checks");
  if (checks?.kind === "checks") {
    assert.equal(checks.items.length, 2);
    assert.equal(checks.items[0].outputTail.length, 2000);
    assert.equal(checks.items[0].phase, "verify");
    assert.equal(checks.items[0].status, "failed");
  }
  for (const section of brief.sections) {
    for (const block of section.blocks) {
      if (block.kind === "facts") assert.ok(block.items.every(item => item.basis));
      if (block.kind === "rich") assert.ok(block.basis);
      if (block.kind === "links") assert.ok(block.items.every(item => item.basis));
    }
  }
});

test("adds model claims and diagrams after the source change map", () => {
  const citation = { source: "packages/host/src/teams.ts", line: 12 };
  const diagram = (id: string, kind: Diagram["kind"]): Diagram => ({
    id,
    title: kind,
    kind,
    basis: "model",
    direction: "LR",
    nodes: [{ id: "A", label: "A", shape: "box" }],
    edges: [],
    groups: [],
    citations: [citation],
    coverage: [],
  });
  const narrative: NarrativeRecord = {
    key: narrativeKey("team:run", "base-commit", "head-commit"),
    baseCommit: "base-commit",
    headCommit: "head-commit",
    generatedAt: at,
    engine: "briefing-engine",
    model: "briefing-model",
    brief: {
      summary: "A recorded summary.",
      architecture: [{ text: "The host links the components.", citations: [citation] }],
      changes: [{ text: "The authentication path changed.", citations: [citation] }],
      checks: [],
      review: [{ priority: "medium", area: "Coverage", why: "Coverage needs confirmation.", question: "Are all paths exercised?", citations: [citation] }],
      guidance: [],
      unknowns: [],
    },
    diagrams: [diagram("system", "system"), diagram("sequence", "sequence")],
    coverage: ["Narrative evidence was omitted during validation."],
  };
  const brief = assembleTeamBrief({ workspaceId: "ws", run: run(), repositoryId, components: fixtureComponents(), relationships: [relationship("auth", "billing")], mapObservedAt: at, narrative, now: at });
  assert.ok(brief.coverage.includes("Narrative evidence was omitted during validation."));
  assert.deepEqual(brief.sections.map(section => section.kind), ["overview", "changes", "diagram", "narrative", "tasks", "review", "request", "evidence"]);
  const diagramBlocks = brief.sections.find(section => section.kind === "diagram")?.blocks.filter(block => block.kind === "diagram");
  assert.ok(diagramBlocks?.every(block => block.kind === "diagram"));
  assert.deepEqual(diagramBlocks?.map(block => block.kind === "diagram" ? block.diagram.kind : null), ["change-map", "system", "sequence"]);
  assert.equal(brief.narrative.state, "ready");
  const narrativeCitations = brief.sections.find(section => section.kind === "narrative")?.blocks.find(block => block.kind === "citations");
  assert.ok(narrativeCitations?.kind === "citations" && narrativeCitations.items.length === 1);

  const mismatched = assembleTeamBrief({ workspaceId: "ws", run: run(), repositoryId, components: fixtureComponents(), relationships: [], mapObservedAt: at, narrative: { ...narrative, key: "wrong-work-key" }, now: at });
  assert.equal(mismatched.narrative.state, "stale");
  assert.equal(mismatched.sections.some(section => section.kind === "narrative"), false);
});

test("omits empty sections and explains unavailable legacy change paths", () => {
  const empty = run({ status: "cancelled", tasks: [], checks: [], decisions: [], changes: undefined, reason: undefined });
  const brief = assembleTeamBrief({ workspaceId: "ws", run: empty, repositoryId, components: [], relationships: [], mapObservedAt: null, narrative: null, now: at });
  assert.deepEqual(brief.sections.map(section => section.kind), ["overview", "request", "evidence"]);

  const explained = assembleTeamBrief({
    workspaceId: "ws",
    run: run({ status: "cancelled", reason: "Recorded cancellation reason.", changes: undefined, tasks: [task("task-old", "Legacy diff", [], { diffStat: { added: 1, removed: 0, files: 1 } })], checks: [], decisions: [] }),
    repositoryId,
    components: [],
    relationships: [],
    mapObservedAt: null,
    narrative: null,
    now: at,
  });
  assert.ok(explained.sections.some(section => section.kind === "report"));
  const changes = explained.sections.find(section => section.kind === "changes");
  assert.ok(changes?.blocks.some(block => block.kind === "note" && block.text === "Changed paths were not recorded for this run."));
  assert.equal(changes?.blocks.some(block => block.kind === "components"), false);
});

test("ignores a change index recorded for an earlier head", () => {
  const stale = run({ changes: { headCommit: "earlier-head", recordedAt: at, files: fixtureFiles(), truncated: false } });
  const brief = assembleTeamBrief({ workspaceId: "ws", run: stale, repositoryId, components: fixtureComponents(), relationships: [], mapObservedAt: at, narrative: null, now: at });

  const changes = brief.sections.find(section => section.kind === "changes");
  assert.ok(changes?.blocks.some(block => block.kind === "note" && block.text === "Changed paths were not recorded for this run."));
  assert.equal(changes?.blocks.some(block => block.kind === "components"), false);
  assert.ok(brief.coverage.includes("The recorded change index belongs to an earlier head."));
});

test("does not show a continuation review as the current run review", () => {
  const brief = assembleTeamBrief({
    workspaceId: "ws",
    run: run({
      review: undefined,
      continuations: [{ revision: 4, requestId: "continued", at, reason: "Continue after review", headCommit: "head-commit", tasks: [], review: { verdict: "approved", summary: "Earlier approval", revision: 3 } }],
    }),
    repositoryId,
    components: fixtureComponents(),
    relationships: [],
    mapObservedAt: at,
    narrative: null,
    now: at,
  });

  const review = brief.sections.find(section => section.kind === "review");
  assert.ok(review?.blocks.some(block => block.kind === "note" && block.text === "An earlier round's review is not shown as current"));
  assert.equal(review?.blocks.some(block => block.kind === "rich" && JSON.stringify(block.nodes).includes("Earlier approval")), false);
});

test("bounds a large brief while retaining overview and request", () => {
  const large = "x".repeat(3 * 1024 * 1024);
  const brief = assembleTeamBrief({ workspaceId: "ws", run: run({ objective: large, tasks: [], checks: [], decisions: [], changes: undefined }), repositoryId, components: [], relationships: [], mapObservedAt: null, narrative: null, now: at });

  const bounded = boundedWorkBrief(brief);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < MAX_RESPONSE_BYTES);
  assert.ok(bounded.sections.some(section => section.kind === "overview"));
  assert.ok(bounded.sections.some(section => section.kind === "request"));
  assert.ok(bounded.coverage.some(line => /truncated|omitted|byte limit/i.test(line)));
  const boundedRequest = bounded.sections.find(section => section.kind === "request")!;
  const rich = boundedRequest.blocks.find(block => block.kind === "rich");
  assert.ok(rich?.kind === "rich" && rich.nodes[0]?.type === "paragraph" && rich.nodes[0].inlines[0]?.type === "text");
  assert.ok(rich?.kind === "rich" && rich.nodes[0]?.type === "paragraph" && rich.nodes[0].inlines[0]?.type === "text" && rich.nodes[0].inlines[0].text.length > 0 && rich.nodes[0].inlines[0].text.length < large.length);
  const overviewRich = bounded.sections.find(section => section.kind === "overview")?.blocks.find(block => block.kind === "rich");
  assert.ok(overviewRich?.kind === "rich" && overviewRich.nodes[0]?.type === "paragraph" && overviewRich.nodes[0].inlines[0]?.type === "text" && overviewRich.nodes[0].inlines[0].text.length > 0);

  const crowded = structuredClone(brief);
  crowded.sections.push({ id: "changes", kind: "changes", title: "Many recorded changes", blocks: Array.from({ length: 45 }, (_, index) => ({
    kind: "facts" as const,
    items: [{ label: `Cycle ${index}`, value: "recorded", basis: "host" as const }],
  })) });
  const boundedCrowded = boundedWorkBrief(crowded);
  assert.ok(boundedCrowded.sections.find(section => section.kind === "request")?.blocks.length);
  assert.ok(boundedCrowded.sections.reduce((count, section) => count + section.blocks.length, 0) <= 40);
});

test("bounds a request containing 5000 bullet items", () => {
  const brief = assembleTeamBrief({ workspaceId: "ws", run: run({ tasks: [], checks: [], decisions: [], changes: undefined }), repositoryId, components: [], relationships: [], mapObservedAt: null, narrative: null, now: at });
  const request = brief.sections.find(section => section.kind === "request")!;
  const rich = request.blocks.find(block => block.kind === "rich");
  assert.ok(rich?.kind === "rich");
  if (!rich || rich.kind !== "rich") return;
  rich.nodes = [{ type: "list", ordered: false, items: Array.from({ length: 5000 }, (_, index) => ({
    inlines: [{ type: "text" as const, text: `Bullet ${index}` }],
    children: [{ type: "paragraph" as const, inlines: [{ type: "text" as const, text: `Detail ${index}` }] }],
  })) }];

  const bounded = boundedWorkBrief(brief);
  const boundedRequest = bounded.sections.find(section => section.kind === "request")?.blocks.find(block => block.kind === "rich");
  const list = boundedRequest?.kind === "rich" ? boundedRequest.nodes.find(node => node.type === "list") : undefined;
  assert.ok(list?.type === "list");
  assert.ok(list.items.length < 5000);
  assert.ok(list.items.length <= 1000);
  assert.ok(bounded.coverage.some(line => /truncated/i.test(line)));
});

test("mission work links task summaries to child team briefs and hides unknown or partial scope", () => {
  const child = run({ id: "child", missionId: "mission-1", title: "Auth subteam", tasks: [task("child-task", "Implement auth", ["src/auth/session.ts"])], changes: { headCommit: "child-head", recordedAt: at, files: [fixtureFiles()[0]], truncated: false } });
  const mission = {
    id: "mission-1",
    title: "Mission",
    objective: "## Mission request\n\nBuild the approved slice.",
    status: "working",
    revision: 2,
    updatedAt: at,
    repoProjectIds: [repositoryId],
    subtasks: [{ id: "auth-slice", title: "Auth slice", objective: "Update authentication.", repoProjectId: repositoryId, status: "done", teamStatus: child.status, teamId: child.id, size: "solo", parallelism: 1, dependsOn: [] }],
    decisions: [],
    result: { summary: "The mission report is recorded.", revision: 2, at },
  };
  const rows: UnderstandingWork[] = [
    { id: "mission:mission-1", sourceId: "mission-1", kind: "mission", title: "Mission", objective: mission.objective, reportedSummary: mission.result.summary, status: "working", column: "working", updatedAt: at, scope: "complete", repositoryIds: [repositoryId], briefIds: [], links: [] },
    { id: "mission:partial", sourceId: "partial", kind: "mission", title: "Cross-workspace work item", objective: null, reportedSummary: null, status: "working", column: "working", updatedAt: at, scope: "partial", repositoryIds: [repositoryId], briefIds: [], links: [] },
  ];
  const context: RepoContext = { version: 1, repo: "repo", generatedAt: at, head: "head-commit", base: "base-commit", files: {}, components: [], edges: [], limitations: [] };
  const sources = {
    groups: { list: () => ({ groups: [], suggestions: [] }), get: (id: string) => ({ id, name: "Workspace", repos: [{ projectId: repositoryId, checkouts: [{ projectId: repositoryId }] }] }) },
    missions: { understandingRecords: () => [mission] },
    teams: { understandingRecords: () => [child] },
    goals: { understandingRecords: () => [] },
    knowledge: { read: () => ({ components: fixtureComponents(), relationships: [relationship("auth", "billing")], contexts: { [repositoryId]: context } }) },
    work: { workReferences: () => rows },
  } as unknown as WorkSources;
  const service = new WorkBriefService(sources, { read: (_workspaceId: string, _workId: string): NarrativeRecord | null => null });
  const brief = service.get("ws", "mission:mission-1");

  assert.equal(brief.narrative.state, "unavailable");
  const changes = brief.sections.find(section => section.kind === "changes");
  assert.ok(changes?.blocks.some(block => block.kind === "note" && block.text === "Changed paths were not recorded for this run."));
  assert.equal(changes?.blocks.some(block => block.kind === "components"), false);
  assert.ok(brief.coverage.includes("The recorded change index belongs to an earlier head."));
  const taskBlock = brief.sections.find(section => section.kind === "tasks")?.blocks.find(block => block.kind === "tasks");
  assert.ok(taskBlock?.kind === "tasks" && taskBlock.items.some(item => item.workId === "team:child"));
  assert.throws(() => service.get("ws", "team:unknown"), (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 404));
  assert.throws(() => service.get("ws", "mission:partial"), (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 404));

  const staleNarrative: NarrativeRecord = {
    key: narrativeKey("team:child", "base-commit", "older-head"),
    baseCommit: "base-commit",
    headCommit: "older-head",
    generatedAt: at,
    engine: "briefing-engine",
    model: "briefing-model",
    brief: { summary: "Earlier report.", architecture: [], changes: [], checks: [], review: [], guidance: [], unknowns: [] },
    diagrams: [],
  };
  const staleService = new WorkBriefService(sources, { read: () => staleNarrative });
  const stale = staleService.get("ws", "team:child");
  assert.equal(stale.narrative.state, "stale");
  assert.equal(stale.sections.find(section => section.kind === "narrative")?.title, "Model narrative for an earlier revision");
});

test("goal work assembles cycles latest first and links each run to its team brief", () => {
  const child = run({ id: "goal-child", title: "Goal cycle", tasks: [task("goal-task", "Implement billing", ["src/billing/index.ts"])], changes: {
    headCommit: "older-head", recordedAt: at, files: [fixtureFiles()[1]], truncated: false,
  } });
  const goal = {
    id: "goal-1",
    projectId: repositoryId,
    title: "Goal",
    objective: "Ship the approved work.",
    status: "running",
    revision: 4,
    updatedAt: at,
    cycles: [{ teamId: child.id, cycle: 1, goalRevision: 4, status: child.status, startedAt: at, baseCommit: "base-commit", headCommit: "head-commit", memberCount: 1 }],
    activeTeamId: child.id,
    outcomes: [{ result: "achieved", summary: "The goal outcome was recorded.", evidence: "Evidence was filed.", at, revision: 4 }],
  } as ProductGoal;
  const row: UnderstandingWork = {
    id: "goal:goal-1", sourceId: goal.id, kind: "goal", title: goal.title, objective: goal.objective, reportedSummary: null,
    status: goal.status, column: "working", updatedAt: at, scope: "complete", repositoryIds: [repositoryId], briefIds: [], links: [],
  };
  const sources = {
    groups: { list: () => ({ groups: [], suggestions: [] }), get: (id: string) => ({ id, name: "Workspace", repos: [{ projectId: repositoryId, checkouts: [{ projectId: repositoryId }] }] }) },
    missions: { understandingRecords: () => [] },
    teams: { understandingRecords: () => [child] },
    goals: { understandingRecords: () => [goal] },
    knowledge: { read: () => ({ components: fixtureComponents(), relationships: [], contexts: {} }) },
    work: { workReferences: () => [row] },
  } as unknown as WorkSources;
  const brief = new WorkBriefService(sources, { read: () => null }).get("ws", row.id);

  assert.equal(brief.kind, "goal");
  const changes = brief.sections.find(section => section.kind === "changes");
  assert.ok(changes?.blocks.some(block => block.kind === "note" && block.text === "Changed paths were not recorded for this run."));
  assert.equal(changes?.blocks.some(block => block.kind === "components"), false);
  assert.ok(brief.coverage.includes("The recorded change index belongs to an earlier head."));
  const tasks = brief.sections.find(section => section.kind === "tasks");
  assert.ok(tasks?.blocks.some(block => block.kind === "facts" && block.items[0]?.label === "Cycle 1"));
  assert.ok(tasks?.blocks.some(block => block.kind === "tasks" && block.items[0]?.workId === "team:goal-child"));
  assert.ok(brief.sections.find(section => section.kind === "report")?.blocks.some(block => block.kind === "rich"));
});

test("resolves a secondary checkout to its repository and uses source observation time", () => {
  const child = run({ id: "secondary-run", projectId: "repo-copy" });
  const row: UnderstandingWork = {
    id: "team:secondary-run", sourceId: child.id, kind: "team", title: child.title, objective: child.objective,
    reportedSummary: null, status: child.status, column: "review", updatedAt: child.updatedAt, scope: "complete",
    repositoryIds: [repositoryId], briefIds: [], links: [],
  };
  const components = fixtureComponents();
  components[0]!.current.sources = [{ repositoryId, head: "head-commit", fingerprint: "source-fingerprint", observedAt: "2026-10-25T11:00:00.000Z", kind: "checkout" }];
  const sources = {
    groups: {
      list: () => ({ groups: [], suggestions: [] }),
      get: (id: string) => ({ id, name: "Workspace", repos: [{ projectId: repositoryId, checkouts: [{ projectId: repositoryId }, { projectId: "repo-copy" }] }] }),
    },
    missions: { understandingRecords: () => [] },
    teams: { understandingRecords: () => [child] },
    goals: { understandingRecords: () => [] },
    knowledge: { read: () => ({ components, relationships: [] }) },
    work: { workReferences: () => [row] },
  } as unknown as WorkSources;
  const brief = new WorkBriefService(sources, { read: () => null }).get("ws", row.id);

  assert.equal(brief.workId, row.id);
  const changes = brief.sections.find(section => section.kind === "changes")?.blocks.find(block => block.kind === "components");
  assert.ok(changes?.kind === "components" && changes.items.some(item => item.componentId === "auth"));
  assert.ok(brief.coverage.includes("The component map was observed before this run's last integration"));
});
