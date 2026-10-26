import { createHash } from "node:crypto";
import type {
  CheckSummary,
  ComponentChange,
  DecisionSummary,
  Diagram,
  Inline,
  RichNode,
  TaskSummary,
  UnderstandingCitation,
  UnderstandingWork,
  WorkBrief,
  WorkBlock,
  WorkSection,
  WorkSectionKind,
} from "@infinite/remote";
import { parseMarkdown } from "@infinite/remote";
import { MAX_RESPONSE_BYTES } from "@infinite/remote/protocol";
import type { KnowledgeComponent, KnowledgeRelationship } from "@infinite/remote";
import type { GoalService } from "./goals.js";
import type { ProductGoal } from "./goal-types.js";
import type { MissionService } from "./missions.js";
import type { Mission } from "./mission-types.js";
import { CatalogError } from "./understanding-catalog.js";
import type { ProjectGroup } from "./project-group-types.js";
import type { TeamRun, TeamTask } from "./team-types.js";
import type { TeamService } from "./teams.js";
import type { UnderstandingSources } from "./understanding.js";
import type { ReadKnowledge, RepoContext } from "./understanding-runtime.js";

const MAX_COMPONENTS = 60;
const MAX_COMPONENT_FILES = 400;
const MAX_CITATIONS = 24;
const MAX_DIAGRAMS = 4;
const MAX_DIAGRAM_EDGES = 120;
const MAX_RICH_NODES = 4000;
const MAX_BLOCKS = 40;
const MAX_SECTIONS = 12;
const MAX_CHECK_OUTPUT = 2000;
const SECTION_ORDER: WorkSectionKind[] = ["overview", "changes", "diagram", "narrative", "tasks", "checks", "decisions", "review", "delivery", "request", "report", "evidence"];
const NOT_RECORDED = "Not recorded";

export interface WorkSources {
  groups: UnderstandingSources["groups"];
  missions: Pick<MissionService, "understandingRecords">;
  teams: Pick<TeamService, "understandingRecords">;
  goals: Pick<GoalService, "understandingRecords">;
  knowledge: { read(workspaceId: string): Pick<ReadKnowledge, "components" | "relationships"> & { contexts?: Record<string, RepoContext> } };
  work: { workReferences(workspaceId: string): UnderstandingWork[] };
}

export interface NarrativeRecord {
  key: string;
  baseCommit: string | null;
  headCommit: string | null;
  generatedAt: string;
  engine: string;
  model: string;
  brief: import("@infinite/remote").UnderstandingBrief;
  diagrams: Diagram[];
  coverage?: string[];
}

export function classifyChanges(
  files: NonNullable<TeamRun["changes"]>["files"],
  repositoryId: string,
  components: KnowledgeComponent[],
  taskPaths: { taskId: string; paths: string[] }[],
): ComponentChange[] {
  const componentPaths = components.flatMap(component => component.paths
    .filter(entry => entry.repositoryId === repositoryId && validComponentPath(entry.path))
    .map(entry => ({ component, path: trimSlashes(entry.path) })))
    .sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path) || a.component.id.localeCompare(b.component.id));

  const unitFor = (path: string) => {
    const matching = componentPaths.find(entry => isWithin(entry.path, path));
    if (matching) return { key: `component:${matching.component.id}`, componentId: matching.component.id, name: matching.component.name, path: matching.path };
    const parts = path.split("/").filter(Boolean);
    const folder = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0] ?? "unknown";
    return { key: `folder:${folder}`, componentId: null, name: `${folder}/`, path: folder };
  };

  const grouped = new Map<string, { unit: ReturnType<typeof unitFor>; files: ComponentChange["files"] }>();
  for (const file of files) {
    if (!validRelativePath(file.path)) continue;
    const unit = unitFor(file.path);
    const group = grouped.get(unit.key) ?? { unit, files: [] };
    group.files.push({ path: file.path, change: file.status, added: file.added, removed: file.removed });
    grouped.set(unit.key, group);
  }

  const result: ComponentChange[] = [];
  for (const { unit, files: changedFiles } of grouped.values()) {
    changedFiles.sort((a, b) => a.path.localeCompare(b.path));
    const changedPaths = new Set(changedFiles.map(file => file.path));
    const mapFiles = unit.componentId
      ? components.find(component => component.id === unit.componentId)?.files
        .filter(file => file.repositoryId === repositoryId && isWithin(unit.path, file.path))
        .map(file => file.path) ?? []
      : [];
    const allAdded = changedFiles.length > 0 && changedFiles.every(file => file.change === "added");
    const allRemoved = changedFiles.length > 0 && changedFiles.every(file => file.change === "removed");
    const mapListsNoOtherFiles = mapFiles.every(path => changedPaths.has(path));
    const change = allAdded && mapListsNoOtherFiles ? "added"
      : allRemoved && mapListsNoOtherFiles ? "removed"
        : "modified";
    const taskIds = taskPaths.filter(task => task.paths.some(path => {
      if (!validRelativePath(path)) return false;
      return unitFor(path).key === unit.key;
    })).map(task => task.taskId);
    result.push({
      componentId: unit.componentId,
      name: unit.name,
      path: unit.path,
      repositoryId,
      change,
      files: changedFiles,
      filesTotal: changedFiles.length,
      taskIds: [...new Set(taskIds)].sort(),
    });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path) || (a.componentId ?? "").localeCompare(b.componentId ?? ""));
}

export function changeMap(changes: ComponentChange[], relationships: KnowledgeRelationship[], components: KnowledgeComponent[]): Diagram {
  const byId = new Map(components.map(component => [component.id, component]));
  const changed = changes.slice().sort((a, b) => a.path.localeCompare(b.path) || (a.componentId ?? "").localeCompare(b.componentId ?? ""));
  const changedIds = new Set(changed.flatMap(change => change.componentId ? [change.componentId] : []));
  const changedUnitIds = new Set(changed.map(change => change.componentId ?? `folder:${change.repositoryId}:${change.path}`));
  const includedIds = new Set(changedIds);
  const neighborCount = new Map<string, number>();
  for (const edge of relationships) {
    const repositories = new Set(changed.filter(change => change.componentId === edge.from || change.componentId === edge.to).map(change => change.repositoryId));
    if (changedIds.has(edge.from) && byId.has(edge.to) && byId.get(edge.to)!.repositoryIds.some(id => repositories.has(id)))
      neighborCount.set(edge.to, (neighborCount.get(edge.to) ?? 0) + 1);
    if (changedIds.has(edge.to) && byId.has(edge.from) && byId.get(edge.from)!.repositoryIds.some(id => repositories.has(id)))
      neighborCount.set(edge.from, (neighborCount.get(edge.from) ?? 0) + 1);
  }
  const neighbors = [...neighborCount.keys()].filter(id => !changedIds.has(id))
    .sort((a, b) => neighborCount.get(b)! - neighborCount.get(a)! || a.localeCompare(b));
  const capacity = Math.max(0, 24 - Math.min(24, changed.length));
  for (const id of neighbors.slice(0, capacity)) includedIds.add(id);
  const nodeById = new Map<string, Diagram["nodes"][number]>();
  const nodes: Diagram["nodes"] = [];
  for (const change of changed.slice(0, 24)) {
    const id = change.componentId ?? `folder:${change.repositoryId}:${change.path}`;
    if (nodeById.has(id)) continue;
    const node: Diagram["nodes"][number] = {
      id,
      label: change.name,
      shape: "box",
      change: change.change,
      ...(change.componentId ? { componentId: change.componentId } : {}),
    };
    nodes.push(node); nodeById.set(id, node);
  }
  for (const id of neighbors) {
    if (!includedIds.has(id) || nodes.length >= 24) continue;
    const component = byId.get(id)!;
    const node: Diagram["nodes"][number] = { id, label: component.name, shape: "box", componentId: id };
    nodes.push(node); nodeById.set(id, node);
  }
  const componentNodeIds = new Set([...includedIds].filter(id => nodeById.has(id)));
  const candidateIds = new Set([...changedIds, ...neighbors]);
  const candidateEdges = relationships
    .filter(edge => candidateIds.has(edge.from) && candidateIds.has(edge.to))
    .slice()
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
  const retainedEdges = candidateEdges
    .filter(edge => componentNodeIds.has(edge.from) && componentNodeIds.has(edge.to))
    .slice(0, MAX_DIAGRAM_EDGES);
  const edges: Diagram["edges"] = retainedEdges
    .map(edge => ({ from: edge.from, to: edge.to, style: "solid", kind: edge.kind }));
  const citations: UnderstandingCitation[] = [];
  for (const edge of retainedEdges) {
    const evidence = edge.evidence.find(item => item.line !== null && item.line > 0 && item.source);
    if (evidence) citations.push({ source: evidence.source, line: evidence.line! });
  }
  const omittedChangedUnits = [...changedUnitIds].filter(id => !nodeById.has(id)).length;
  const omittedRelationships = candidateEdges.length - retainedEdges.length;
  const coverage = omittedChangedUnits || omittedRelationships
    ? [`${omittedChangedUnits} changed unit${omittedChangedUnits === 1 ? "" : "s"} and ${omittedRelationships} relationship${omittedRelationships === 1 ? "" : "s"} were omitted from the map`]
    : [];
  return {
    id: "change-map",
    title: "Component change map",
    kind: "change-map",
    basis: "source",
    direction: "LR",
    nodes,
    edges,
    groups: [],
    citations: uniqueCitations(citations).slice(0, MAX_CITATIONS),
    coverage,
  };
}

export function assembleTeamBrief(input: {
  workspaceId: string;
  run: TeamRun;
  repositoryId: string;
  components: KnowledgeComponent[];
  relationships: KnowledgeRelationship[];
  mapObservedAt: string | null;
  narrative: NarrativeRecord | null;
  now: string;
}): WorkBrief {
  const { run, repositoryId, components, relationships, mapObservedAt, narrative } = input;
  const revisionChanged = narrative && (narrative.baseCommit !== (run.baseCommit ?? null) || narrative.headCommit !== (run.headCommit ?? null));
  const keyChanged = narrative && narrative.key !== narrativeKey(`team:${run.id}`, run.baseCommit ?? null, run.headCommit ?? null);
  const staleNarrative = narrative && (revisionChanged || keyChanged) ? narrative : null;
  const currentNarrative = staleNarrative ? null : narrative;
  const tasks = allTasks(run);
  const changeIndex = currentChangeIndex(run);
  const changes = changeIndex ? classifyChanges(changeIndex.files, repositoryId, components, taskPathsFor(tasks)) : [];
  const hasUnrecordedPaths = !changeIndex && (Boolean(run.changes) || tasks.some(task => task.diffStat));
  const hasMap = mapObservedAt !== null || components.some(component => component.repositoryIds.includes(repositoryId));
  const coverage = [...new Set([...runCoverage(run, mapObservedAt, hasMap, changes.length > 0), ...(currentNarrative?.coverage ?? [])])];
  const taskSummaries = taskSummariesFor(tasks, changes, run);
  const reportedSummary = run.noChange?.summary ?? run.deliveryReceipt?.summary ?? run.pullRequest?.summary ?? run.discovery?.summary;
  const requestNodes = parseMarkdown(run.objective).nodes;
  const summaryBasis = currentNarrative?.brief.summary ? "model" as const : reportedSummary ? "agent" as const : "owner" as const;
  const summaryNodes: RichNode[] = currentNarrative?.brief.summary
    ? parseMarkdown(currentNarrative.brief.summary).nodes
    : reportedSummary ? parseMarkdown(reportedSummary).nodes : firstParagraph(requestNodes);
  const sections: WorkSection[] = [];
  const totals = tally(changes);
  const overviewBlocks: WorkBlock[] = [
    { kind: "facts", items: [
      { label: "Kind", value: "team", basis: "host" },
      { label: "Execution status", value: run.status, basis: "host" },
      { label: "Updated", value: run.updatedAt, basis: "host" },
      { label: "Repositories", value: repositoryId, basis: "source" },
      { label: "Revision", value: String(run.revision), basis: "host" },
      { label: "Head", value: run.headCommit ?? NOT_RECORDED, basis: "source" },
      { label: "Components", value: `${totals.added} added · ${totals.modified} modified · ${totals.removed} removed`, basis: "source" },
    ] },
    { kind: "rich", basis: summaryBasis, nodes: summaryNodes },
  ];
  sections.push(section("overview", "Overview", overviewBlocks));

  if (changes.length || hasUnrecordedPaths) {
    const blocks: WorkBlock[] = [];
    if (changes.length) blocks.push({ kind: "components", items: changes });
    else blocks.push({ kind: "note", tone: "info", text: "Changed paths were not recorded for this run." });
    sections.push(section("changes", "Changes", blocks));
  }

  const diagrams: Diagram[] = [];
  if (changes.length) diagrams.push(changeMap(changes, relationships, components));
  if (currentNarrative) diagrams.push(...currentNarrative.diagrams.slice(0, MAX_DIAGRAMS));
  if (diagrams.length) sections.push(section("diagram", "Diagrams", diagrams.slice(0, MAX_DIAGRAMS).map(diagram => ({ kind: "diagram", diagram }))));

  if (currentNarrative) {
    const claims = currentNarrative.brief.changes.flatMap(claim => parseMarkdown(claim.text).nodes);
    const nodes = [...parseMarkdown(currentNarrative.brief.summary).nodes, ...(claims.length ? [{ type: "list", ordered: false, items: claims.map(node => ({ inlines: [], children: [node] })) } as RichNode] : [])];
    sections.push(section("narrative", "Model narrative", [
      { kind: "rich", basis: "model", nodes },
      { kind: "citations", items: citationsFromNarrative(currentNarrative.brief) },
    ]));
  }

  if (taskSummaries.length) sections.push(section("tasks", "Tasks", [{ kind: "tasks", items: taskSummaries }]));

  const checks = run.checks.map(checkSummary);
  if (checks.length) sections.push(section("checks", "Checks", [{ kind: "checks", items: checks }]));

  const decisions = run.decisions.map(decisionSummary);
  if (decisions.length) sections.push(section("decisions", "Decisions", [{ kind: "decisions", items: decisions }]));

  const reviewQuestions = currentNarrative?.brief.review ?? [];
  const currentReview = currentRunReview(run);
  const earlierReview = hasEarlierRunReview(run);
  if (reviewQuestions.length || currentReview || earlierReview) {
    const blocks: WorkBlock[] = [];
    if (reviewQuestions.length) blocks.push({ kind: "questions", items: reviewQuestions });
    if (currentReview) blocks.push({ kind: "rich", basis: "agent", nodes: parseMarkdown(`${currentReview.verdict}\n\n${currentReview.summary}`).nodes });
    else if (earlierReview) blocks.push({ kind: "note", tone: "info", text: "An earlier round's review is not shown as current" });
    sections.push(section("review", "Review", blocks));
  }

  const delivery = teamDelivery(run);
  if (delivery) sections.push(section("delivery", "Delivery", delivery));

  sections.push(section("request", "Request", [{ kind: "rich", basis: "owner", nodes: requestNodes }]));

  const report = teamReports(run);
  if (report.length) sections.push(section("report", "Report", report.map(item => ({ kind: "rich", basis: "agent", nodes: datedRich(item.text, item.at) }))));

  sections.push(evidenceSection({
    baseCommit: run.baseCommit ?? null,
    headCommit: run.headCommit ?? null,
    mapObservedAt,
    mapSnapshot: mapSnapshot(components.filter(component => component.repositoryIds.includes(repositoryId))),
    sourceFingerprint: sourceFingerprint({ id: run.id, revision: run.revision, status: run.status, updatedAt: run.updatedAt, baseCommit: run.baseCommit, headCommit: run.headCommit, changes: run.changes, tasks }),
    generatedAt: input.now,
    citations: [
      ...citationsFromNarrative(currentNarrative?.brief),
      ...diagrams.flatMap(diagram => diagram.citations),
      ...reviewQuestions.flatMap(question => question.citations),
    ],
    coverage,
  }));

  const brief: WorkBrief = {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    workId: `team:${run.id}`,
    kind: "team",
    title: run.title,
    source: { revision: run.revision, status: run.status, updatedAt: run.updatedAt, baseCommit: run.baseCommit ?? null, headCommit: run.headCommit ?? null },
    generatedAt: input.now,
    narrative: currentNarrative ? { state: "ready", generatedAt: currentNarrative.generatedAt, engine: currentNarrative.engine, model: currentNarrative.model }
      : { state: "unavailable", reason: "No narrative is available for this work item." },
    sections,
    coverage,
  };
  if (staleNarrative) markNarrativeStale(brief, staleNarrative, Boolean(revisionChanged));
  return boundedWorkBrief(brief);
}

export class WorkBriefService {
  constructor(private readonly sources: WorkSources, private readonly narratives: { read(workspaceId: string, workId: string): NarrativeRecord | null }) {}

  get(workspaceId: string, workId: string): WorkBrief {
    const group = this.workspaceGroup(workspaceId);
    const row = this.findWork(workspaceId, workId, group);
    const knowledge = this.readKnowledge(workspaceId);
    if (row.kind === "team") {
      const record = this.sources.teams.understandingRecords().find(value => value.id === row.sourceId && projectInWorkScope(group, row, value.projectId));
      if (!record) throw unavailableWork();
      const repositoryId = canonicalRepositoryId(group, record.projectId);
      if (!repositoryId) throw unavailableWork();
      const run = { ...record, projectId: repositoryId };
      const context = knowledge.contexts?.[repositoryId];
      const repositoryComponents = knowledge.components.filter(component => component.repositoryIds.includes(repositoryId));
      const mapObservedAt = context?.generatedAt ?? mapObservationTime(repositoryComponents, repositoryId);
      const cached = this.narratives.read(workspaceId, workId);
      return assembleTeamBrief({ workspaceId, run, repositoryId, components: repositoryComponents, relationships: knowledge.relationships, mapObservedAt, narrative: cached, now: new Date().toISOString() });
    }
    if (row.kind === "mission") {
      const record = this.sources.missions.understandingRecords().find(value => value.id === row.sourceId && value.repoProjectIds.some(id => projectInWorkScope(group, row, id)));
      if (!record) throw unavailableWork();
      const repositoryIds = canonicalRepositoryIds(group, record.repoProjectIds).filter(id => row.repositoryIds.includes(id));
      const mission = {
        ...record,
        repoProjectIds: repositoryIds,
        subtasks: record.subtasks.map(subtask => ({
          ...subtask,
          repoProjectId: canonicalRepositoryId(group, subtask.repoProjectId) ?? subtask.repoProjectId,
        })),
      };
      const teams = this.sources.teams.understandingRecords().filter(team => team.missionId === mission.id && projectInWorkScope(group, row, team.projectId))
        .map(team => normalizeTeamRepository(group, team));
      return boundedWorkBrief(assembleMissionBrief(workspaceId, mission, teams, knowledge, new Date().toISOString()));
    }
    const record = this.sources.goals.understandingRecords().find(value => value.id === row.sourceId && projectInWorkScope(group, row, value.projectId));
    if (!record) throw unavailableWork();
    const repositoryId = canonicalRepositoryId(group, record.projectId);
    if (!repositoryId) throw unavailableWork();
    const goal = { ...record, projectId: repositoryId };
    const ids = new Set([...goal.cycles.map(cycle => cycle.teamId), ...(goal.activeTeamId ? [goal.activeTeamId] : [])]);
    const teams = this.sources.teams.understandingRecords().filter(team => ids.has(team.id) && projectInWorkScope(group, row, team.projectId))
      .map(team => normalizeTeamRepository(group, team));
    return boundedWorkBrief(assembleGoalBrief(workspaceId, goal, teams, knowledge, new Date().toISOString()));
  }

  private workspaceGroup(workspaceId: string): ProjectGroup {
    try {
      const group = this.sources.groups.get(workspaceId);
      if (group.id !== workspaceId) throw unavailableWork();
      return group;
    } catch {
      throw unavailableWork();
    }
  }

  private findWork(workspaceId: string, workId: string, group: ProjectGroup): UnderstandingWork {
    const row = this.sources.work.workReferences(workspaceId).find(value => value.id === workId);
    if (!row && workId.startsWith("team:")) {
      const id = workId.slice("team:".length);
      const child = this.sources.teams.understandingRecords().find(team => team.id === id && (team.missionId || team.goal) && canonicalRepositoryId(group, team.projectId));
      const repositoryId = child ? canonicalRepositoryId(group, child.projectId) : null;
      if (child && repositoryId) return {
        id: workId,
        sourceId: id,
        kind: "team",
        title: child.title,
        objective: child.objective,
        reportedSummary: null,
        status: child.status,
        column: "working",
        updatedAt: child.updatedAt,
        scope: "complete",
        repositoryIds: [repositoryId],
        briefIds: [],
        links: [],
      };
    }
    if (!row || row.scope !== "complete" || !row.repositoryIds.length) throw unavailableWork();
    const match = workId.match(/^(team|mission|goal):(.+)$/);
    if (!match || match[1] !== row.kind || !match[2] || match[2] !== row.sourceId) throw unavailableWork();
    return row;
  }

  private readKnowledge(workspaceId: string): Pick<ReadKnowledge, "components" | "relationships"> & { contexts?: Record<string, RepoContext> } {
    try { return this.sources.knowledge.read(workspaceId); }
    catch { return { components: [], relationships: [], contexts: {} }; }
  }
}

export function boundedWorkBrief(brief: WorkBrief): WorkBrief {
  const result = structuredClone(brief);
  let truncated = false;
  const uniqueSections = new Map<WorkSectionKind, WorkSection>();
  for (const section of result.sections) if (!uniqueSections.has(section.kind)) uniqueSections.set(section.kind, section);
  result.sections = SECTION_ORDER.flatMap(kind => uniqueSections.has(kind) ? [uniqueSections.get(kind)!] : []).slice(0, MAX_SECTIONS);
  if (result.sections.length !== brief.sections.length) truncated = true;
  let blocksRemaining = MAX_BLOCKS;
  let diagramRemaining = MAX_DIAGRAMS;
  let nodesRemaining = MAX_RICH_NODES;
  let richCharsRemaining = Math.max(1_000, Math.floor(MAX_RESPONSE_BYTES / 20));
  const requestNodeBudget = Math.max(1, Math.floor(MAX_RICH_NODES / 2));
  const requestCharBudget = Math.max(1_000, Math.floor(richCharsRemaining / 2));

  const prioritySections = [
    ...result.sections.filter(section => section.kind === "request"),
    ...result.sections.filter(section => section.kind === "overview"),
    ...result.sections.filter(section => section.kind !== "overview" && section.kind !== "request"),
  ];
  for (const section of prioritySections) {
    if (blocksRemaining <= 0) { section.blocks = []; truncated = true; continue; }
    const requiredLimit = section.kind === "overview" ? 2 : section.kind === "request" ? 1 : blocksRemaining;
    const allowed = Math.min(blocksRemaining, requiredLimit);
    if (section.blocks.length > allowed) { section.blocks = section.blocks.slice(0, allowed); truncated = true; }
    blocksRemaining -= section.blocks.length;
    for (const block of section.blocks) {
      if (block.kind === "rich") {
        const nodeBudget = section.kind === "request" ? Math.min(nodesRemaining, requestNodeBudget) : nodesRemaining;
        const charBudget = section.kind === "request" ? Math.min(richCharsRemaining, requestCharBudget) : richCharsRemaining;
        const bounded = boundRichNodes(block.nodes, { nodes: nodeBudget, chars: charBudget });
        block.nodes = bounded.nodes;
        nodesRemaining -= nodeBudget - bounded.nodesRemaining;
        richCharsRemaining -= charBudget - bounded.charsRemaining;
        truncated ||= bounded.truncated;
      } else if (block.kind === "components") {
        if (block.items.length > MAX_COMPONENTS) { block.items = block.items.slice(0, MAX_COMPONENTS); truncated = true; }
        let componentFileCount = 0;
        for (const item of block.items) {
          const allowed = Math.max(0, MAX_COMPONENT_FILES - componentFileCount);
          if (item.files.length > allowed) { item.files = item.files.slice(0, allowed); truncated = true; }
          componentFileCount += item.files.length;
          if (item.taskIds.length > 100) { item.taskIds = item.taskIds.slice(0, 100); truncated = true; }
        }
      } else if (block.kind === "diagram") {
        if (diagramRemaining <= 0) { section.blocks = section.blocks.filter(candidate => candidate !== block); truncated = true; continue; }
        diagramRemaining -= 1;
        if (block.diagram.nodes.length > 48) { block.diagram.nodes = block.diagram.nodes.slice(0, 48); truncated = true; }
        const nodeIds = new Set(block.diagram.nodes.map(node => node.id));
        const validEdges = block.diagram.edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
        if (validEdges.length > MAX_DIAGRAM_EDGES) truncated = true;
        block.diagram.edges = validEdges.slice(0, MAX_DIAGRAM_EDGES);
        if (block.diagram.citations.length > MAX_CITATIONS) { block.diagram.citations = block.diagram.citations.slice(0, MAX_CITATIONS); truncated = true; }
        if (block.diagram.groups.length > 48) { block.diagram.groups = block.diagram.groups.slice(0, 48); truncated = true; }
      } else if (block.kind === "citations") {
        if (block.items.length > MAX_CITATIONS) { block.items = block.items.slice(0, MAX_CITATIONS); truncated = true; }
      } else if (block.kind === "questions") {
        if (block.items.length > 24) { block.items = block.items.slice(0, 24); truncated = true; }
        let citationsRemaining = MAX_CITATIONS;
        for (const item of block.items) {
          if (item.citations.length > citationsRemaining) { item.citations = item.citations.slice(0, citationsRemaining); truncated = true; }
          citationsRemaining = Math.max(0, citationsRemaining - item.citations.length);
        }
      } else if (block.kind === "tasks") {
        if (block.items.length > 100) { block.items = block.items.slice(0, 100); truncated = true; }
        for (const item of block.items) {
          const bounded = boundRichNodes(item.summary, { nodes: nodesRemaining, chars: richCharsRemaining });
          item.summary = bounded.nodes; nodesRemaining = bounded.nodesRemaining; richCharsRemaining = bounded.charsRemaining; truncated ||= bounded.truncated;
          if (item.componentNames.length > 60) { item.componentNames = item.componentNames.slice(0, 60); truncated = true; }
        }
      } else if (block.kind === "checks") {
        if (block.items.length > 64) { block.items = block.items.slice(0, 64); truncated = true; }
        for (const item of block.items) if (item.outputTail.length > MAX_CHECK_OUTPUT) { item.outputTail = item.outputTail.slice(-MAX_CHECK_OUTPUT); truncated = true; }
      } else if (block.kind === "decisions") {
        if (block.items.length > 64) { block.items = block.items.slice(0, 64); truncated = true; }
        for (const item of block.items) if (item.options.length > 8) { item.options = item.options.slice(0, 8); truncated = true; }
      } else if (block.kind === "links" && block.items.length > 64) { block.items = block.items.slice(0, 64); truncated = true; }
      else if (block.kind === "facts" && block.items.length > 40) { block.items = block.items.slice(0, 40); truncated = true; }
      else if (block.kind === "note" && block.text.length > 1000) { block.text = `${block.text.slice(0, 999)}…`; truncated = true; }
    }
  }

  if (richCharsRemaining <= 0 || nodesRemaining <= 0) truncated = true;
  if (truncated) {
    const note = "Some brief content was truncated to fit the supported response limits.";
    if (result.coverage.length >= 100) result.coverage[result.coverage.length - 1] = note;
    else addCoverage(result, note);
  }
  result.sections = result.sections.filter(section => section.blocks.length > 0 || section.kind === "overview" || section.kind === "request");
  result.coverage = result.coverage.slice(0, 100).map(value => value.slice(0, 500));
  ensureBriefByteLimit(result);
  return result;
}

function boundRichNodes(nodes: RichNode[], budget: { nodes: number; chars: number }): { nodes: RichNode[]; nodesRemaining: number; charsRemaining: number; truncated: boolean } {
  let nodesRemaining = budget.nodes;
  let charsRemaining = budget.chars;
  let truncated = false;
  const take = (value: string) => {
    if (value.length <= charsRemaining) { charsRemaining -= value.length; return value; }
    const taken = Math.max(0, charsRemaining);
    charsRemaining = 0; truncated = true;
    return `${value.slice(0, Math.max(0, taken - 1))}${taken ? "…" : ""}`;
  };
  const takeInline = (inline: Inline): Inline | null => {
    const text = take(inline.text);
    if (!text) return null;
    if (inline.type !== "link") return { ...inline, text };
    const url = take(inline.url);
    return url === inline.url ? { ...inline, text } : { type: "text", text };
  };
  const visit = (node: RichNode): RichNode | null => {
    if (nodesRemaining <= 0) { truncated = true; return null; }
    nodesRemaining -= 1;
    if (node.type === "heading" || node.type === "paragraph") {
      const inlines = node.inlines.map(takeInline).filter((inline): inline is Inline => inline !== null);
      return { ...node, inlines };
    }
    if (node.type === "code") return { ...node, language: node.language ? take(node.language) : null, text: take(node.text) };
    if (node.type === "quote") return { ...node, children: node.children.map(visit).filter((item): item is RichNode => item !== null) };
    if (node.type === "list") {
      const items: typeof node.items = [];
      for (const item of node.items) {
        if (nodesRemaining <= 0) { truncated = true; break; }
        nodesRemaining -= 1;
        const inlines = item.inlines.map(takeInline).filter((inline): inline is Inline => inline !== null);
        const children: RichNode[] = [];
        for (const child of item.children) {
          if (nodesRemaining <= 0) { truncated = true; break; }
          const boundedChild = visit(child);
          if (boundedChild) children.push(boundedChild);
        }
        if (inlines.length || children.length) items.push({ inlines, children });
      }
      return { ...node, items };
    }
    return node;
  };
  const bounded: RichNode[] = [];
  for (const node of nodes) {
    const value = visit(node);
    if (value) bounded.push(value);
  }
  return { nodes: bounded, nodesRemaining, charsRemaining, truncated };
}

function ensureBriefByteLimit(brief: WorkBrief) {
  if (Buffer.byteLength(JSON.stringify(brief)) <= MAX_RESPONSE_BYTES) return;
  brief.workspaceId = brief.workspaceId.slice(0, 120);
  brief.workId = brief.workId.slice(0, 240);
  brief.title = brief.title.slice(0, 300);
  brief.source = {
    ...brief.source,
    status: brief.source.status.slice(0, 120),
    updatedAt: brief.source.updatedAt.slice(0, 100),
    baseCommit: brief.source.baseCommit?.slice(0, 200) ?? null,
    headCommit: brief.source.headCommit?.slice(0, 200) ?? null,
  };
  brief.generatedAt = brief.generatedAt.slice(0, 100);
  brief.narrative = { state: "unavailable", reason: "Narrative detail was omitted to fit the response byte limit." };
  brief.coverage = ["Some brief content was omitted to fit the response byte limit."];
  brief.sections = [
    section("overview", "Overview", [{ kind: "facts", items: [{ label: "Execution status", value: brief.source.status, basis: "host" }] }]),
    section("request", "Request", [{ kind: "rich", basis: "owner", nodes: [{ type: "paragraph", inlines: [{ type: "text", text: "Request text was truncated to fit the response byte limit." }] }] }]),
  ];
}

function assembleMissionBrief(workspaceId: string, mission: Mission, teams: TeamRun[], knowledge: Pick<ReadKnowledge, "components" | "relationships"> & { contexts?: Record<string, RepoContext> }, now: string): WorkBrief {
  const childById = new Map(teams.map(team => [team.id, team]));
  const children = mission.subtasks.flatMap(subtask => subtask.teamId && childById.has(subtask.teamId) ? [childById.get(subtask.teamId)!] : []);
  const repositoryIds = mission.repoProjectIds;
  const changes = aggregateChanges(children, knowledge.components);
  const coverage = aggregateCoverage(children, knowledge.contexts, repositoryIds, knowledge.components);
  const summary = mission.result?.summary ?? mission.reason;
  const latest = latestTeam(children);
  const brief = aggregateBriefBase({ workspaceId, workId: `mission:${mission.id}`, kind: "mission", title: mission.title, objective: mission.objective,
    status: mission.status, revision: mission.revision, updatedAt: mission.updatedAt, repositoryIds, baseCommit: latest?.baseCommit ?? null, headCommit: latest?.headCommit ?? null,
    now, summary, changes, relationships: knowledge.relationships, components: knowledge.components, mapObservedAt: aggregateMapObservedAt(repositoryIds, knowledge.contexts, knowledge.components),
    sourceFingerprint: sourceFingerprint({ mission, teams: children }), hasUnrecordedDiff: children.some(hasUnrecordedChangePaths), coverage });
  const subtaskItems: TaskSummary[] = mission.subtasks.map(subtask => {
    const team = subtask.teamId ? childById.get(subtask.teamId) : undefined;
    const childChanges = changes.filter(change => team && change.taskIds.some(id => allTasks(team).some(task => task.id === id)));
    const report = team && teamReports(team).at(-1)?.text;
    return { id: subtask.id, title: subtask.title, status: team?.status ?? subtask.teamStatus ?? subtask.status, revision: team?.revision ?? mission.revision,
      role: null, summary: parseMarkdown(report ?? subtask.objective).nodes, diffStat: null, reviewRounds: 0, rubric: null,
      componentNames: childChanges.map(change => change.name), ...(subtask.teamId ? { workId: `team:${subtask.teamId}` } : {}) };
  });
  const sections = brief.sections;
  if (subtaskItems.length) sections.splice(sections.findIndex(section => section.kind === "request"), 0, section("tasks", "Tasks", [{ kind: "tasks", items: subtaskItems }]));
  const decisions = [
    ...mission.decisions.map(value => ({ id: value.id, question: value.question, options: value.options, answer: value.answer ?? null,
      answeredBy: value.answeredBy ?? null, answeredAt: value.answeredAt ?? null, createdAt: value.createdAt } satisfies DecisionSummary)),
    ...children.flatMap(team => team.decisions.map(decisionSummary)),
  ].filter((value, index, values) => values.findIndex(candidate => candidate.id === value.id) === index);
  if (decisions.length) insertBefore(sections, "request", section("decisions", "Decisions", [{ kind: "decisions", items: decisions }]));
  addAggregateSections(sections, children);
  const reports: { text: string; at: string }[] = [];
  if (mission.result) reports.push({ text: mission.result.summary, at: mission.result.at });
  if (mission.reason) reports.push({ text: mission.reason, at: mission.updatedAt });
  reports.push(...children.flatMap(team => teamReports(team)));
  if (reports.length) insertBefore(sections, "evidence", section("report", "Report", reports.map(item => ({ kind: "rich", basis: "agent", nodes: datedRich(item.text, item.at) }))));
  return brief;
}

function assembleGoalBrief(workspaceId: string, goal: ProductGoal, teams: TeamRun[], knowledge: Pick<ReadKnowledge, "components" | "relationships"> & { contexts?: Record<string, RepoContext> }, now: string): WorkBrief {
  const orderedCycles = goal.cycles.slice().sort((a, b) => b.cycle - a.cycle || b.startedAt.localeCompare(a.startedAt));
  const teamById = new Map(teams.map(team => [team.id, team]));
  const children = [...new Map([
    ...orderedCycles.flatMap(cycle => teamById.has(cycle.teamId) ? [[cycle.teamId, teamById.get(cycle.teamId)!] as const] : []),
    ...(goal.activeTeamId && teamById.has(goal.activeTeamId) ? [[goal.activeTeamId, teamById.get(goal.activeTeamId)!] as const] : []),
  ]).values()];
  const repositoryIds = [goal.projectId];
  const changes = aggregateChanges(children, knowledge.components);
  const coverage = aggregateCoverage(children, knowledge.contexts, repositoryIds, knowledge.components);
  const latest = latestTeam(children);
  const brief = aggregateBriefBase({ workspaceId, workId: `goal:${goal.id}`, kind: "goal", title: goal.title, objective: goal.objective,
    status: goal.status, revision: goal.revision, updatedAt: goal.updatedAt, repositoryIds, baseCommit: latest?.baseCommit ?? null, headCommit: latest?.headCommit ?? null,
    now, summary: goal.outcomes.at(-1)?.summary ?? goal.reason, changes, relationships: knowledge.relationships, components: knowledge.components,
    mapObservedAt: aggregateMapObservedAt(repositoryIds, knowledge.contexts, knowledge.components), sourceFingerprint: sourceFingerprint({ goal, teams: children }),
    hasUnrecordedDiff: children.some(hasUnrecordedChangePaths), coverage });
  const cycleTasks: TaskSummary[] = orderedCycles.map(cycle => {
    const team = teamById.get(cycle.teamId);
    const report = team && teamReports(team).at(-1)?.text;
    const cycleChanges = changes.filter(change => team && change.taskIds.some(id => allTasks(team).some(task => task.id === id)));
    return { id: `cycle:${cycle.cycle}`, title: team?.title ?? `Cycle ${cycle.cycle}`, status: team?.status ?? cycle.status, revision: team?.revision ?? goal.revision,
      role: null, summary: parseMarkdown(report ?? cycle.reason ?? "").nodes, diffStat: null, reviewRounds: 0, rubric: null, componentNames: cycleChanges.map(change => change.name), workId: `team:${cycle.teamId}` };
  });
  const activeTeam = goal.activeTeamId ? teamById.get(goal.activeTeamId) : undefined;
  if (activeTeam && !orderedCycles.some(cycle => cycle.teamId === activeTeam.id)) {
    const report = teamReports(activeTeam).at(-1)?.text;
    const activeChanges = changes.filter(change => change.taskIds.some(id => allTasks(activeTeam).some(task => task.id === id)));
    cycleTasks.push({ id: `active:${activeTeam.id}`, title: activeTeam.title, status: activeTeam.status, revision: activeTeam.revision, role: null,
      summary: parseMarkdown(report ?? "").nodes, diffStat: null, reviewRounds: 0, rubric: null, componentNames: activeChanges.map(change => change.name), workId: `team:${activeTeam.id}` });
  }
  const cycleBlocks: WorkBlock[] = orderedCycles.map(cycle => ({ kind: "facts", items: [{ label: `Cycle ${cycle.cycle}`, value: `${cycle.status} · ${cycle.startedAt}${cycle.finishedAt ? ` – ${cycle.finishedAt}` : ""}`, basis: "host" }] }));
  if (cycleTasks.length) cycleBlocks.push({ kind: "tasks", items: cycleTasks });
  if (cycleBlocks.length) insertBefore(brief.sections, "request", section("tasks", "Cycles and runs", cycleBlocks));
  addAggregateSections(brief.sections, children);
  const reports = [
    ...goal.outcomes.map(outcome => ({ text: `${outcome.result}: ${outcome.summary}`, at: outcome.at })),
    ...(goal.reason ? [{ text: goal.reason, at: goal.updatedAt }] : []),
  ];
  reports.push(...children.flatMap(team => teamReports(team)));
  if (reports.length) insertBefore(brief.sections, "evidence", section("report", "Report", reports.map(item => ({ kind: "rich", basis: "agent", nodes: datedRich(item.text, item.at) }))));
  return brief;
}

function aggregateBriefBase(input: {
  workspaceId: string; workId: string; kind: "mission" | "goal"; title: string; objective: string; status: string; revision: number; updatedAt: string;
  repositoryIds: string[]; baseCommit: string | null; headCommit: string | null; now: string; summary?: string;
  changes: ComponentChange[]; relationships: KnowledgeRelationship[]; components: KnowledgeComponent[]; mapObservedAt: string | null; sourceFingerprint: string; hasUnrecordedDiff: boolean; coverage: string[];
}): WorkBrief {
  const totals = tally(input.changes);
  const first = firstParagraph(parseMarkdown(input.objective).nodes);
  const summaryNodes = input.summary ? parseMarkdown(input.summary).nodes : first;
  const sections: WorkSection[] = [section("overview", "Overview", [
    { kind: "facts", items: [
      { label: "Kind", value: input.kind, basis: "host" }, { label: "Execution status", value: input.status, basis: "host" },
      { label: "Updated", value: input.updatedAt, basis: "host" }, { label: "Repositories", value: input.repositoryIds.join(", "), basis: "source" },
      { label: "Revision", value: String(input.revision), basis: "host" }, { label: "Head", value: input.headCommit ?? NOT_RECORDED, basis: "source" },
      { label: "Components", value: `${totals.added} added · ${totals.modified} modified · ${totals.removed} removed`, basis: "source" },
    ] },
    { kind: "rich", basis: input.summary ? "agent" : "owner", nodes: summaryNodes },
  ])];
  if (input.changes.length || input.hasUnrecordedDiff) {
    sections.push(section("changes", "Changes", [
      ...(input.changes.length ? [{ kind: "components", items: input.changes } as const] : []),
      ...(input.hasUnrecordedDiff ? [{ kind: "note", tone: "info", text: "Changed paths were not recorded for this run." } as const] : []),
    ]));
    if (input.changes.length) sections.push(section("diagram", "Diagrams", [{ kind: "diagram", diagram: changeMap(input.changes, input.relationships, input.components) }]));
  }
  sections.push(section("request", "Request", [{ kind: "rich", basis: "owner", nodes: parseMarkdown(input.objective).nodes }]));
  sections.push(evidenceSection({ baseCommit: input.baseCommit, headCommit: input.headCommit, mapObservedAt: input.mapObservedAt,
    mapSnapshot: mapSnapshot(input.components.filter(component => input.repositoryIds.some(id => component.repositoryIds.includes(id)))),
    sourceFingerprint: input.sourceFingerprint, generatedAt: input.now,
    citations: [], coverage: input.coverage }));
  return { schemaVersion: 1, workspaceId: input.workspaceId, workId: input.workId, kind: input.kind, title: input.title,
    source: { revision: input.revision, status: input.status, updatedAt: input.updatedAt, baseCommit: input.baseCommit, headCommit: input.headCommit },
    generatedAt: input.now, narrative: { state: "unavailable", reason: "Narratives cover team runs; open a subteam." }, sections, coverage: input.coverage };
}

function aggregateChanges(teams: TeamRun[], components: KnowledgeComponent[]): ComponentChange[] {
  const merged = new Map<string, ComponentChange>();
  for (const team of teams) {
    const changeIndex = currentChangeIndex(team);
    if (!changeIndex) continue;
    const changes = classifyChanges(changeIndex.files, team.projectId, components, taskPathsFor(allTasks(team)));
    for (const change of changes) {
      const key = `${change.repositoryId}\0${change.componentId ?? change.path}`;
      const current = merged.get(key);
      if (!current) { merged.set(key, structuredClone(change)); continue; }
      const files = new Map(current.files.map(file => [file.path, file]));
      for (const file of change.files) {
        const previous = files.get(file.path);
        files.set(file.path, previous && previous.change !== file.change
          ? { ...file, change: "modified" }
          : file);
      }
      current.files = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
      current.filesTotal = current.files.length;
      current.taskIds = [...new Set([...current.taskIds, ...change.taskIds])].sort();
      if (current.change !== change.change) current.change = "modified";
    }
  }
  return [...merged.values()].sort((a, b) => a.repositoryId.localeCompare(b.repositoryId) || a.path.localeCompare(b.path));
}

function aggregateCoverage(teams: TeamRun[], contexts: Record<string, RepoContext> | undefined, repositoryIds: string[], components: KnowledgeComponent[]): string[] {
  const coverage: string[] = [];
  const hasMapForRepository = (id: string) => Boolean(contexts?.[id] || components.some(component => component.repositoryIds.includes(id)));
  if (repositoryIds.some(id => !hasMapForRepository(id)))
    coverage.push("Component boundaries come from folder layout; run a workspace refresh for the repository map");
  else if (repositoryIds.some(id => !contexts?.[id]?.generatedAt && !mapObservationTime(components.filter(component => component.repositoryIds.includes(id)), id)))
    coverage.push("The component map observation time was not recorded");
  for (const team of teams) {
    const changeIndex = currentChangeIndex(team);
    if (hasStaleChangeIndex(team)) coverage.push("The recorded change index belongs to an earlier head.");
    else if (!changeIndex && allTasks(team).some(task => task.diffStat)) coverage.push("Changed paths were not recorded for this run.");
    if (changeIndex?.truncated) coverage.push("The recorded change index is truncated to its retained file limit.");
    const observedAt = contexts?.[team.projectId]?.generatedAt ?? mapObservationTime(components.filter(component => component.repositoryIds.includes(team.projectId)), team.projectId);
    if (observedAt && changeIndex && observedAt < changeIndex.recordedAt)
      coverage.push("The component map was observed before this run's last integration");
  }
  return [...new Set(coverage)];
}

function addAggregateSections(sections: WorkSection[], teams: TeamRun[]) {
  const checks = teams.flatMap(team => team.checks.map(checkSummary));
  if (checks.length) insertBefore(sections, "request", section("checks", "Checks", [{ kind: "checks", items: checks }]));
  if (!sections.some(value => value.kind === "decisions")) {
    const decisions = teams.flatMap(team => team.decisions.map(decisionSummary))
      .filter((value, index, values) => values.findIndex(candidate => candidate.id === value.id) === index);
    if (decisions.length) insertBefore(sections, "request", section("decisions", "Decisions", [{ kind: "decisions", items: decisions }]));
  }
  const reviews: WorkBlock[] = [];
  for (const team of teams) {
    const review = currentRunReview(team);
    if (review) reviews.push({ kind: "rich", basis: "agent", nodes: parseMarkdown(`${review.verdict}\n\n${review.summary}`).nodes });
    else if (hasEarlierRunReview(team)) reviews.push({ kind: "note", tone: "info", text: "An earlier round's review is not shown as current" });
  }
  if (reviews.length) insertBefore(sections, "request", section("review", "Review", reviews));
  const facts: Extract<WorkBlock, { kind: "facts" }> ["items"] = [];
  const links: Extract<WorkBlock, { kind: "links" }> ["items"] = [];
  for (const team of teams) {
    for (const block of teamDelivery(team) ?? []) {
      if (block.kind === "facts") facts.push(...block.items);
      if (block.kind === "links") for (const link of block.items) if (!links.some(existing => existing.url === link.url)) links.push(link);
    }
  }
  if (facts.length || links.length) insertBefore(sections, "request", section("delivery", "Delivery", [
    ...(facts.length ? [{ kind: "facts", items: facts } as const] : []),
    ...(links.length ? [{ kind: "links", items: links } as const] : []),
  ]));
}

function taskPathsFor(tasks: TeamTask[]) {
  return tasks.flatMap(task => task.changedPaths ? [{ taskId: task.id, paths: task.changedPaths.paths }] : []);
}

function currentChangeIndex(run: TeamRun) {
  return run.changes?.headCommit === run.headCommit ? run.changes : undefined;
}

function hasStaleChangeIndex(run: TeamRun) {
  return Boolean(run.changes && run.changes.headCommit !== run.headCommit);
}

function hasUnrecordedChangePaths(run: TeamRun) {
  return !currentChangeIndex(run) && (Boolean(run.changes) || allTasks(run).some(task => task.diffStat));
}

function allTasks(run: TeamRun): TeamTask[] {
  return [...run.tasks, ...(run.continuations ?? []).flatMap(continuation => continuation.tasks)];
}

function taskSummariesFor(tasks: TeamTask[], changes: ComponentChange[], run: TeamRun): TaskSummary[] {
  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    status: task.status,
    revision: task.revision,
    role: run.members.find(member => member.memberId === task.memberId)?.role ?? null,
    summary: parseMarkdown(task.summary ?? "").nodes,
    diffStat: task.diffStat ? { added: task.diffStat.added, removed: task.diffStat.removed, files: task.diffStat.files } : null,
    reviewRounds: task.reviewRounds ?? 0,
    rubric: task.rubric ? {
      correctness: task.rubric.correctness.score,
      cleanliness: task.rubric.cleanliness.score,
      extensibility: task.rubric.extensibility.score,
      docs: task.rubric.docs.score,
    } : null,
    componentNames: changes.filter(change => change.taskIds.includes(task.id)).map(change => change.name),
  }));
}

function checkSummary(check: TeamRun["checks"][number]): CheckSummary {
  return {
    command: [check.command.command, ...check.command.args].join(" "),
    phase: check.phase === "setup" ? "setup" : "verify",
    status: check.status,
    exitCode: check.exitCode ?? null,
    headCommit: check.headCommit ?? null,
    startedAt: check.startedAt,
    finishedAt: check.finishedAt ?? null,
    outputTail: String(check.output ?? "").slice(-MAX_CHECK_OUTPUT),
  };
}

function decisionSummary(decision: TeamRun["decisions"][number]): DecisionSummary {
  return { id: decision.id, question: decision.question, options: decision.options, answer: decision.answer ?? null,
    answeredBy: decision.answeredBy ?? null, answeredAt: decision.answeredAt ?? null, createdAt: decision.createdAt };
}

function teamDelivery(run: TeamRun): WorkBlock[] | null {
  const facts: Extract<WorkBlock, { kind: "facts" }>["items"] = [];
  const links: Extract<WorkBlock, { kind: "links" }>["items"] = [];
  if (run.noChange) facts.push({ label: "No-change report", value: run.noChange.summary, basis: "agent" });
  if (run.deliveryReceipt) {
    facts.push({ label: "Delivery receipt", value: run.deliveryReceipt.summary, basis: "agent" });
    const url = safeHttps(run.deliveryReceipt.pullRequestUrl);
    if (url) links.push({ label: "Pull request", url, basis: "agent" });
  }
  if (run.pullRequest) {
    facts.push({ label: "Pull request report", value: run.pullRequest.summary, basis: "agent" });
    const url = safeHttps(run.pullRequest.pullRequestUrl);
    if (url && !links.some(link => link.url === url)) links.push({ label: "Pull request", url, basis: "agent" });
  }
  if (run.deliveryRecovery) facts.push({ label: "Delivery recovery", value: run.deliveryRecovery.status, basis: "agent" });
  if (!facts.length && !links.length) return null;
  return [...(facts.length ? [{ kind: "facts", items: facts } as const] : []), ...(links.length ? [{ kind: "links", items: links } as const] : [])];
}

function teamReports(run: TeamRun): { text: string; at: string }[] {
  return [
    ...(run.noChange ? [{ text: run.noChange.summary, at: run.updatedAt }] : []),
    ...(run.deliveryReceipt ? [{ text: run.deliveryReceipt.summary, at: run.deliveryReceipt.reportedAt }] : []),
    ...(run.pullRequest ? [{ text: run.pullRequest.summary, at: run.pullRequest.reportedAt }] : []),
    ...(run.reason ? [{ text: run.reason, at: run.updatedAt }] : []),
  ];
}

function currentRunReview(run: TeamRun) {
  return run.review;
}

function hasEarlierRunReview(run: TeamRun) {
  return !run.review && Boolean(run.continuations?.some(continuation => continuation.review));
}

function citationsFromNarrative(brief: NarrativeRecord["brief"] | undefined): UnderstandingCitation[] {
  if (!brief) return [];
  return uniqueCitations([
    ...brief.architecture.flatMap(claim => claim.citations),
    ...brief.changes.flatMap(claim => claim.citations),
    ...brief.checks.flatMap(claim => claim.citations),
    ...brief.review.flatMap(item => item.citations),
    ...brief.guidance.flatMap(item => item.citations),
  ]).slice(0, MAX_CITATIONS);
}

function evidenceSection(input: { baseCommit: string | null; headCommit: string | null; mapObservedAt: string | null; mapSnapshot: string | null; sourceFingerprint: string; generatedAt: string; citations: UnderstandingCitation[]; coverage: string[] }): WorkSection {
  const facts: WorkBlock = { kind: "facts", items: [
    { label: "Source fingerprint", value: input.sourceFingerprint, basis: "host" },
    { label: "Base commit", value: input.baseCommit ?? NOT_RECORDED, basis: "source" },
    { label: "Head commit", value: input.headCommit ?? NOT_RECORDED, basis: "source" },
    { label: "Component map observed", value: input.mapObservedAt ?? NOT_RECORDED, basis: "source" },
    { label: "Map snapshot", value: input.mapSnapshot ?? NOT_RECORDED, basis: "source" },
    { label: "Brief generated", value: input.generatedAt, basis: "host" },
  ] };
  const blocks: WorkBlock[] = [facts, { kind: "citations", items: uniqueCitations(input.citations).slice(0, MAX_CITATIONS) }, ...input.coverage.map(text => ({ kind: "note", tone: "info", text } as const))];
  return section("evidence", "Evidence", blocks);
}

function runCoverage(run: TeamRun, mapObservedAt: string | null, hasMap: boolean, hasChanges: boolean): string[] {
  const coverage: string[] = [];
  const changeIndex = currentChangeIndex(run);
  if (!hasMap) coverage.push("Component boundaries come from folder layout; run a workspace refresh for the repository map");
  else if (!mapObservedAt) coverage.push("The component map observation time was not recorded");
  else if (changeIndex && mapObservedAt < changeIndex.recordedAt) coverage.push("The component map was observed before this run's last integration");
  if (hasStaleChangeIndex(run)) coverage.push("The recorded change index belongs to an earlier head.");
  else if (!changeIndex && allTasks(run).some(task => task.diffStat)) coverage.push("Changed paths were not recorded for this run.");
  if (changeIndex?.truncated) coverage.push("The recorded change index is truncated to its retained file limit.");
  for (const task of allTasks(run)) if (task.changedPaths?.truncated) coverage.push(`Recorded paths for task ${task.id} are truncated.`);
  if (!hasChanges && changeIndex?.files.length) coverage.push("No changed unit could be matched to the retained component map.");
  return [...new Set(coverage)];
}

function tally(changes: ComponentChange[]) {
  return changes.filter(change => change.componentId !== null)
    .reduce((totals, change) => { totals[change.change] += 1; return totals; }, { added: 0, modified: 0, removed: 0 });
}

function firstParagraph(nodes: RichNode[]): RichNode[] {
  const paragraph = nodes.find(node => node.type === "paragraph");
  return paragraph ? [paragraph] : nodes.slice(0, 1);
}

function datedRich(text: string, at: string): RichNode[] {
  return [{ type: "paragraph", inlines: [{ type: "text", text: at }] }, ...parseMarkdown(text).nodes];
}

function section(kind: WorkSectionKind, title: string, blocks: WorkBlock[]): WorkSection { return { id: kind, kind, title, blocks }; }

function insertBefore(sections: WorkSection[], kind: WorkSectionKind, value: WorkSection) {
  if (sections.some(section => section.kind === value.kind)) return;
  const index = sections.findIndex(section => section.kind === kind);
  sections.splice(index < 0 ? sections.length : index, 0, value);
}

function markNarrativeStale(brief: WorkBrief, narrative: NarrativeRecord, revisionChanged: boolean) {
  brief.narrative = { state: "stale", generatedAt: narrative.generatedAt, reason: revisionChanged ? "The recorded revision changed after this narrative was generated." : "The cached narrative key does not match this work revision." };
  if (!revisionChanged) {
    addCoverage(brief, "A cached model narrative did not match the current work revision and was omitted.");
    return;
  }
  const claims = narrative.brief.changes.flatMap(claim => parseMarkdown(claim.text).nodes);
  const nodes = [...parseMarkdown(narrative.brief.summary).nodes, ...(claims.length ? [{ type: "list", ordered: false, items: claims.map(node => ({ inlines: [], children: [node] })) } as RichNode] : [])];
  let narrativeSection = brief.sections.find(section => section.kind === "narrative");
  if (!narrativeSection) {
    narrativeSection = section("narrative", "Model narrative for an earlier revision", [
      { kind: "note", tone: "warning", text: "Model narrative for an earlier revision" },
      { kind: "rich", basis: "model", nodes },
      { kind: "citations", items: citationsFromNarrative(narrative.brief) },
    ]);
    insertBefore(brief.sections, "tasks", narrativeSection);
  } else {
    narrativeSection.title = "Model narrative for an earlier revision";
    narrativeSection.blocks.unshift({ kind: "note", tone: "warning", text: "Model narrative for an earlier revision" });
  }
  const existingDiagrams = brief.sections.find(section => section.kind === "diagram");
  const oldDiagrams = narrative.diagrams.slice(0, Math.max(0, MAX_DIAGRAMS - (existingDiagrams?.blocks.filter(block => block.kind === "diagram").length ?? 0)))
    .map(diagram => ({ kind: "diagram", diagram: { ...diagram, title: `Earlier revision: ${diagram.title}` } } as const));
  if (existingDiagrams) existingDiagrams.blocks.push(...oldDiagrams);
  else if (oldDiagrams.length) insertBefore(brief.sections, "narrative", section("diagram", "Diagrams", oldDiagrams));
  const evidence = brief.sections.find(section => section.kind === "evidence");
  const evidenceCitations = evidence?.blocks.find(block => block.kind === "citations");
  if (evidenceCitations?.kind === "citations") evidenceCitations.items = uniqueCitations([...evidenceCitations.items, ...citationsFromNarrative(narrative.brief)]).slice(0, MAX_CITATIONS);
  addCoverage(brief, "A model narrative from an earlier revision is shown with its original generation time.");
}

function mapObservationTime(components: KnowledgeComponent[], repositoryId?: string): string | null {
  return components.flatMap(component => component.current.sources
    .filter(source => repositoryId === undefined || source.repositoryId === repositoryId)
    .map(source => source.observedAt)).sort().at(-1) ?? null;
}

function aggregateMapObservedAt(repositoryIds: string[], contexts: Record<string, RepoContext> | undefined, components: KnowledgeComponent[]): string | null {
  const observed = repositoryIds.map(id => contexts?.[id]?.generatedAt ?? mapObservationTime(components.filter(component => component.repositoryIds.includes(id)), id))
    .filter((value): value is string => value !== null);
  return observed.sort().at(-1) ?? null;
}

function mapSnapshot(components: KnowledgeComponent[]): string | null {
  const snapshots = [...new Set(components.map(component => component.current.snapshotId).filter(Boolean))].sort();
  return snapshots.length ? `${snapshots.slice(0, 20).join(", ")}${snapshots.length > 20 ? ", …" : ""}` : null;
}

function sourceFingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function narrativeKey(workId: string, baseCommit: string | null, headCommit: string | null): string {
  return createHash("sha256").update(JSON.stringify([workId, baseCommit, headCommit])).digest("hex");
}

function latestTeam(teams: TeamRun[]): TeamRun | undefined { return teams.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0]; }

function uniqueCitations(items: UnderstandingCitation[]): UnderstandingCitation[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (!item || typeof item.source !== "string" || !item.source || !Number.isInteger(item.line) || item.line < 1) return false;
    const key = `${item.source}\0${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function canonicalRepositoryId(group: ProjectGroup, projectId: string): string | null {
  const repo = group.repos.find(value => value.projectId === projectId || value.checkouts.some(checkout => checkout.projectId === projectId));
  return repo?.projectId ?? null;
}

function canonicalRepositoryIds(group: ProjectGroup, projectIds: string[]): string[] {
  return [...new Set(projectIds.flatMap(projectId => {
    const canonical = canonicalRepositoryId(group, projectId);
    return canonical ? [canonical] : [];
  }))];
}

function projectInWorkScope(group: ProjectGroup, row: UnderstandingWork, projectId: string): boolean {
  const canonical = canonicalRepositoryId(group, projectId);
  return canonical !== null && row.repositoryIds.includes(canonical);
}

function normalizeTeamRepository(group: ProjectGroup, team: TeamRun): TeamRun {
  const projectId = canonicalRepositoryId(group, team.projectId);
  return projectId && projectId !== team.projectId ? { ...team, projectId } : team;
}

function validRelativePath(path: string) { return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(part => !part || part === "." || part === ".."); }
function trimSlashes(path: string) { return path.replace(/^\/+|\/+$/g, ""); }
function isWithin(parent: string, child: string) { return parent === "." ? validRelativePath(child) : child === parent || child.startsWith(`${parent}/`); }
function validComponentPath(path: string) { return path === "." || validRelativePath(path); }
function safeHttps(value: string | undefined): string | undefined {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" ? url.toString() : undefined; } catch { return undefined; }
}
function unavailableWork() { return new CatalogError(404, "This work is not available in this workspace."); }
function addCoverage(brief: WorkBrief, line: string) { if (!brief.coverage.includes(line)) brief.coverage.push(line); }
