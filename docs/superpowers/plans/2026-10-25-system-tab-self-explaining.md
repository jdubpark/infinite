# System tab that explains the workspace by itself: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phone's System tab fill itself for every enrolled workspace with summaries, diagrams, recent changes, generated plans, delivery and maintenance, with readable failure reasons and no fixed-fraction response trimming.

**Architecture:** The host's Understanding maintenance job gains a repository-level brief step (engine `brief` at the tracked head, diagrams parsed into graph data, a changes watermark) and records failure reasons. New paged read endpoints sit beside the unchanged `schemaVersion: 1` overview. A shared layout module in `@infinite/remote` lets the phone draw graph data with `react-native-svg`. The phone System tab is rebuilt around sections with plain copy.

**Tech Stack:** TypeScript, Node 22 (`node:test`), zod, Express, React Native with Expo and `react-native-svg` 15.15.4, Jevcode as the briefing engine.

**Spec:** `docs/superpowers/specs/2026-10-25-system-tab-self-explaining-design.md`

## Global Constraints

- Relay responses stay under `MAX_RESPONSE_BYTES` (4 MiB, `packages/remote/src/protocol.ts:9`); every new endpoint pages to at most 512 KiB or 50 records per page.
- `GET …/understanding` keeps `schemaVersion: 1` and every existing field; new fields are optional additions only.
- Catalog store stays at 2 MiB per workspace; runtime store at 8 MiB. Diagram graphs count toward them.
- Generated text and diagrams are data, never executable markup. Mermaid source is stored as text and never evaluated.
- Nothing private in tracked files (no host paths, hostnames, account names). Run the AGENTS.md privacy scan before each commit.
- Copy rules (spec section 7): fact first, then evidence label; no sentence mentions bytes, budgets or omission; one honesty line per tab.
- Tests run with `node --import tsx --test FILE` for focused files; `npm run check` once at the end. Never run two full suites in parallel.
- Never use `git stash`. Other sessions edit this repository in parallel; do not revert their changes.
- Work in the detached worktree at `docs/..`'s repository root checked out from `origin/main` (commit `1112eec`). Commit per task; do not push.

## Review Focus

1. A brief whose Mermaid uses a construct outside the subset (for example `A -. text .-> B` or `classDef`): the parser must either accept the line or fail with `parseError` set, never drop silently. Test in Task 1.
2. A workspace where the engine succeeds for the context step but the `brief` step times out: maintenance must publish the source map and component diagram and record the brief failure reason, not fail the whole job. Test in Task 5.
3. A team artifact whose member workspace was deleted after the run: it must stay visible on the repository it describes. Test in Task 7.
4. A repository with 13 planned requests of 20 KB each: the v1 overview must include all 13 titles with excerpts and the `planned` page must return all 13 full texts. Test in Task 8.
5. A policy an owner explicitly disabled after this release: the next host start must not re-enable it. Test in Task 4.

---

### Task 1: Diagram graph types, Mermaid subset parser, component graph

**Files:**
- Create: `packages/remote/src/understanding-diagrams.ts`
- Modify: `packages/remote/src/index.ts` (export the new types)
- Create: `packages/host/src/understanding-diagrams.ts`
- Test: `tests/understanding-diagrams.test.ts`

**Interfaces:**
- Produces (shared, in `packages/remote/src/understanding-diagrams.ts`):
  ```ts
  export interface DiagramNode { id: string; label: string; group: string | null; componentId: string | null }
  export interface DiagramGroup { id: string; label: string }
  export interface DiagramEdge { from: string; to: string; label: string | null }
  export interface DiagramGraph {
    id: string; title: string; kind: "system" | "change" | "components"; direction: "LR" | "TB";
    nodes: DiagramNode[]; groups: DiagramGroup[]; edges: DiagramEdge[];
    source: "mermaid" | "components"; sourceText: string | null; parseError: string | null;
    repositoryId: string; head: string | null; observedAt: string;
  }
  ```
- Produces (host, in `packages/host/src/understanding-diagrams.ts`):
  ```ts
  export type ParsedFlowchart = { direction: "LR" | "TB"; nodes: { id: string; label: string; group: string | null }[]; groups: { id: string; label: string }[]; edges: { from: string; to: string; label: string | null }[] };
  export function parseMermaidFlowchart(text: string): { ok: true; graph: ParsedFlowchart } | { ok: false; error: string };
  export function diagramFromMermaid(input: { id: string; title: string; kind: "system" | "change"; mermaid: string; repositoryId: string; head: string | null; observedAt: string }): DiagramGraph;
  export function componentGraph(input: { repositoryId: string; head: string | null; observedAt: string; components: Pick<KnowledgeComponent, "id" | "name" | "paths" | "retired">[]; relationships: Pick<KnowledgeRelationship, "from" | "to" | "kind">[] }): DiagramGraph;
  export function linkDiagramNodes(graph: DiagramGraph, components: Pick<KnowledgeComponent, "id" | "name">[]): DiagramGraph;
  export const diagramGraphSchema: z.ZodType<DiagramGraph>;
  ```
- Subset accepted by `parseMermaidFlowchart`: header `flowchart` or `graph` with `LR`, `RL`, `TB`, `TD` (RL maps to LR, TD to TB); node definitions `id[label]`, `id(label)`, `id((label))`, `id{label}`, `id>label]`, `id[["label"]]`, bare `id`, with labels optionally in double quotes; edges `-->`, `---`, `-.->`, `==>`, with `|label|` after the arrow or `-- label -->` and `-. label .->` forms, and chains `A --> B --> C`; `subgraph id [label]`, `subgraph id`, `subgraph "label"` … `end`; `%%` comments; blank lines; `classDef`, `class`, `style`, `linkStyle`, `click` lines ignored. Any other line returns `{ ok: false, error: "line N: <text>" }`. Limits: 200 nodes, 400 edges; beyond that `ok: false`. Node ids are `[A-Za-z0-9_.-]+`. Labels are trimmed and HTML-unescaped for `&quot;`, `&amp;`, `&lt;`, `&gt;`, `#quot;`.
- `diagramFromMermaid`: on parse success, nodes get `componentId: null`, `source: "mermaid"`, `sourceText: mermaid`, `parseError: null`; on failure, empty `nodes/groups/edges`, `sourceText: mermaid`, `parseError: error`.
- `componentGraph`: one node per non-retired component (id = component id, label = name, group = text before the first `/` of `paths[0].path`, or `"root"` when it has no `/`), one group per distinct group label, edges deduplicated by `(from, to)` restricted to nodes present, `label` = `kind` unless `kind === "imports"` (then `null`), `direction: "LR"`, `kind: "components"`, `id: \`components:${repositoryId}\``, `title: "Component map"`, `source: "components"`, `sourceText: null`, `parseError: null`.
- `linkDiagramNodes`: `componentId` = node id when a component has that id; else the single component whose `name` equals the label case-insensitively; else `null`.

- [ ] **Step 1: Write the failing tests** in `tests/understanding-diagrams.test.ts`

```ts
test("parses the flowchart subset with groups, labeled edges and chains", () => {
  const result = parseMermaidFlowchart(`flowchart TD\n%% comment\nsubgraph api [API]\n  a[\"Auth &amp; tokens\"]\n  b(Store)\nend\nc((Worker))\na -->|verifies| b --> c\nc -. retry .-> a\nclassDef x fill:#fff`);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.graph.direction, "TB");
  assert.deepEqual(result.graph.groups, [{ id: "api", label: "API" }]);
  assert.deepEqual(result.graph.nodes.map(n => [n.id, n.label, n.group]), [["a", "Auth & tokens", "api"], ["b", "Store", "api"], ["c", "Worker", null]]);
  assert.deepEqual(result.graph.edges, [{ from: "a", to: "b", label: "verifies" }, { from: "b", to: "c", label: null }, { from: "c", to: "a", label: "retry" }]);
});
test("rejects unsupported lines with the line number and keeps the source text", () => {
  const result = parseMermaidFlowchart("flowchart LR\na --> b\nsequenceDiagram");
  assert.deepEqual(result, { ok: false, error: "line 3: sequenceDiagram" });
  const graph = diagramFromMermaid({ id: "d1", title: "System", kind: "system", mermaid: "flowchart LR\na --> b\nsequenceDiagram", repositoryId: "repo", head: null, observedAt: "2026-10-25T00:00:00.000Z" });
  assert.equal(graph.parseError, "line 3: sequenceDiagram");
  assert.equal(graph.sourceText?.startsWith("flowchart"), true);
  assert.equal(graph.nodes.length, 0);
});
test("rejects more than 200 nodes", () => {
  const lines = Array.from({ length: 201 }, (_, i) => `n${i}`);
  assert.equal(parseMermaidFlowchart(`flowchart LR\n${lines.join("\n")}`).ok, false);
});
test("builds a component graph grouped by top-level directory with deduplicated edges", () => {
  const graph = componentGraph({ repositoryId: "repo", head: "a".repeat(40), observedAt: "2026-10-25T00:00:00.000Z",
    components: [{ id: "cmp_a", name: "A", paths: [{ repositoryId: "repo", path: "src/a" }], retired: false }, { id: "cmp_b", name: "B", paths: [{ repositoryId: "repo", path: "src/b" }], retired: false }, { id: "cmp_r", name: "R", paths: [{ repositoryId: "repo", path: "README.md" }], retired: false }, { id: "cmp_old", name: "Old", paths: [], retired: true }],
    relationships: [{ from: "cmp_a", to: "cmp_b", kind: "imports" }, { from: "cmp_a", to: "cmp_b", kind: "imports" }, { from: "cmp_b", to: "cmp_old", kind: "calls" }] });
  assert.equal(graph.id, "components:repo");
  assert.deepEqual(graph.nodes.map(n => [n.id, n.group, n.componentId]), [["cmp_a", "src", "cmp_a"], ["cmp_b", "src", "cmp_b"], ["cmp_r", "root", "cmp_r"]]);
  assert.deepEqual(graph.groups.map(g => g.id), ["src", "root"]);
  assert.deepEqual(graph.edges, [{ from: "cmp_a", to: "cmp_b", label: null }]);
});
test("links diagram nodes to components by id, then by unique case-insensitive name", () => {
  const graph = diagramFromMermaid({ id: "d", title: "t", kind: "system", mermaid: "flowchart LR\ncmp_a --> store[Store] --> other[Other]", repositoryId: "repo", head: null, observedAt: "2026-10-25T00:00:00.000Z" });
  const linked = linkDiagramNodes(graph, [{ id: "cmp_a", name: "Auth" }, { id: "cmp_s", name: "store" }, { id: "cmp_o1", name: "Other" }, { id: "cmp_o2", name: "other" }]);
  assert.deepEqual(linked.nodes.map(n => n.componentId), ["cmp_a", "cmp_s", null]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/understanding-diagrams.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Add the shared types** to `packages/remote/src/understanding-diagrams.ts` and export them from `packages/remote/src/index.ts`.

- [ ] **Step 4: Implement the host module** `packages/host/src/understanding-diagrams.ts` with the functions in Interfaces. `diagramGraphSchema` is a strict zod schema with limits: 200 nodes, 50 groups, 400 edges, labels max 200, `sourceText` max 3000, `parseError` max 300, title max 120.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test tests/understanding-diagrams.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Build the shared package and typecheck**

Run: `npm run build -w @infinite/remote && npm run typecheck -w @infinite/host`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/remote/src/understanding-diagrams.ts packages/remote/src/index.ts packages/host/src/understanding-diagrams.ts tests/understanding-diagrams.test.ts
git commit -m "feat(understanding): parse brief diagrams and component maps into graph data"
```

---

### Task 2: Shared layered graph layout

**Files:**
- Create: `packages/remote/src/diagram-layout.ts`
- Modify: `packages/remote/src/index.ts`
- Test: `tests/diagram-layout.test.ts`

**Interfaces:**
- Consumes: `DiagramGraph` from Task 1.
- Produces:
  ```ts
  export interface LayoutOptions { nodeWidth: number; nodeHeight: number; gapX: number; gapY: number; groupPadding: number }
  export interface LayoutNode { id: string; x: number; y: number; width: number; height: number; layer: number }
  export interface LayoutEdge { from: string; to: string; label: string | null; points: { x: number; y: number }[]; back: boolean }
  export interface LayoutGroup { id: string; label: string; x: number; y: number; width: number; height: number }
  export interface GraphLayout { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[]; groups: LayoutGroup[] }
  export const defaultLayoutOptions: LayoutOptions; // { nodeWidth: 150, nodeHeight: 44, gapX: 48, gapY: 28, groupPadding: 12 }
  export function layoutGraph(graph: Pick<DiagramGraph, "direction" | "nodes" | "groups" | "edges">, options?: Partial<LayoutOptions>): GraphLayout;
  ```
- Algorithm (deterministic): break cycles by marking back edges found in a DFS over nodes in input order (`back: true`); longest-path layering from sources; order nodes within a layer by barycenter of their predecessors over four sweeps (down, up, down, up), ties by input order; place layers along the direction axis (`LR`: layers increase in x), nodes within a layer along the other axis with `gap`; edges are two-point polylines from the source node's far edge center to the target node's near edge center; back edges route from the source's near edge to the target's far edge; group boxes are the bounding box of member nodes plus `groupPadding`; `width`/`height` cover all boxes plus `groupPadding`. Edges whose endpoints are missing are dropped.

- [ ] **Step 1: Write the failing tests** in `tests/diagram-layout.test.ts`

```ts
test("layers a chain left to right and keeps a back edge", () => {
  const layout = layoutGraph({ direction: "LR", groups: [], nodes: n(["a", "b", "c"]), edges: [e("a", "b"), e("b", "c"), e("c", "a")] });
  assert.deepEqual(layout.nodes.map(x => x.layer), [0, 1, 2]);
  assert.ok(layout.nodes[0].x < layout.nodes[1].x && layout.nodes[1].x < layout.nodes[2].x);
  assert.deepEqual(layout.edges.map(x => x.back), [false, false, true]);
  assert.equal(layout.width, 3 * 150 + 2 * 48 + 2 * 12);
});
test("layers top to bottom and places siblings apart", () => {
  const layout = layoutGraph({ direction: "TB", groups: [], nodes: n(["root", "x", "y"]), edges: [e("root", "x"), e("root", "y")] });
  const [root, x, y] = layout.nodes;
  assert.ok(root.y < x.y && x.y === y.y && x.x !== y.x);
});
test("group boxes enclose their members with padding", () => {
  const layout = layoutGraph({ direction: "LR", groups: [{ id: "g", label: "G" }], nodes: [{ id: "a", label: "a", group: "g", componentId: null }, { id: "b", label: "b", group: "g", componentId: null }], edges: [e("a", "b")] });
  const g = layout.groups[0];
  for (const node of layout.nodes) { assert.ok(node.x >= g.x + 12 && node.x + node.width <= g.x + g.width - 12); }
});
test("is deterministic and drops edges to unknown nodes", () => {
  const graph = { direction: "LR" as const, groups: [], nodes: n(["a", "b"]), edges: [e("a", "b"), e("a", "zzz")] };
  assert.deepEqual(layoutGraph(graph), layoutGraph(graph));
  assert.equal(layoutGraph(graph).edges.length, 1);
});
```
(`n` builds nodes with `group: null, componentId: null`; `e` builds edges with `label: null`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/diagram-layout.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `layoutGraph`** in `packages/remote/src/diagram-layout.ts`; export from `index.ts`. No DOM or Node APIs: the phone imports it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/diagram-layout.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/diagram-layout.ts packages/remote/src/index.ts tests/diagram-layout.test.ts
git commit -m "feat(remote): deterministic layered layout for understanding diagrams"
```

---

### Task 3: Failure reasons retained and shown

**Files:**
- Create: `packages/host/src/failure-reason.ts`
- Modify: `packages/remote/src/understanding-knowledge.ts` (`KnowledgeMaintenance`)
- Modify: `packages/host/src/understanding-runtime.ts` (`failWorkspace` at ~622, `runWorkspace` capture catch at ~342, `runtimeStateSchema` maintenance object at ~128)
- Modify: `packages/host/src/repository-briefings.ts` (`collectProcess` at 169, the drain catch at ~484-490)
- Modify: `packages/host/src/understanding.ts` (`get` warnings at ~340-343)
- Test: `tests/understanding-runtime.test.ts`, `tests/understanding.test.ts`, `tests/failure-reason.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // packages/host/src/failure-reason.ts
  export function failureReason(error: unknown, stderr?: string): string; // ≤ 400 chars, one line
  ```
  Rules: use `error.message` (or `String(error)`), append `` · ${lastNonEmptyLine(stderr)} `` when stderr has content, collapse whitespace to single spaces, replace any token of 32 or more `[A-Za-z0-9_-]` characters with `[redacted]`, strip `/` + path-like runs longer than 80 characters to their last two segments, clip to 400 characters.
- `KnowledgeMaintenance` gains `lastFailure?: { at: string; reason: string } | null`.
- `UnderstandingRuntime.failWorkspace(workspaceId: string, error: unknown)` sets `message: \`Last attempt failed at ${at}: ${reason}.\`` and `lastFailure: { at, reason }`, and logs one line `` [Infinite] Understanding maintenance failed · workspace ${id} · ${reason} `` with `console.error`. A successful publish sets `lastFailure: null`. Per-repository capture failures push `` Repository ${name}: ${failureReason(error)} `` into `partial`.
- `collectProcess` in `repository-briefings.ts` pipes stderr (instead of `"ignore"`), keeps the last 2 KiB, and rejects with `new Error(failureReason(new Error(\`exit ${code}\`), stderrTail))` on a non-zero exit.
- The briefing drain catch sets `error: \`${FAILED_MESSAGE} Reason: ${failureReason(error)}\`` for failures that are neither `NotReady` nor `NotOptedIn`.
- `UnderstandingService.get` replaces the warning "The latest recorded briefing attempt failed; retained snapshots remain source-labeled." with `` The latest brief attempt failed: ${reason} `` where `reason` is the part of the status error after `"Reason: "` (or the whole error string).

- [ ] **Step 1: Write the failing tests**

`tests/failure-reason.test.ts`:
```ts
test("failureReason redacts long tokens, shortens paths, appends stderr and clips", () => {
  const reason = failureReason(new Error("exit 1"), "warning\nENOENT /very/long/path/" + "x".repeat(90) + "/dist/cli.js token=" + "A".repeat(40) + "\n");
  assert.match(reason, /^exit 1 · ENOENT .*dist\/cli\.js token=\[redacted\]$/);
  assert.ok(reason.length <= 400);
  assert.equal(failureReason("plain"), "plain");
});
```
`tests/understanding-runtime.test.ts`, add after the "failed or invalid context capture" test:
```ts
test("a failed job records a readable reason and clears it on the next success", { timeout: 20000 }, async t => {
  let fail = true;
  const s = setup(t, { adapter: { context: async root => { if (fail) throw new Error("engine exploded"); return sampleContext(root); } } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").maintenance.state === "failed");
  const failed = s.runtime.read("workspace").maintenance;
  assert.match(failed.message ?? "", /^Last attempt failed at \d{4}-.*: Repository Repository: engine exploded\.$/);
  assert.equal(failed.lastFailure?.reason, "Repository Repository: engine exploded");
  fail = false;
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
  assert.equal(s.runtime.read("workspace").maintenance.lastFailure, null);
});
```
`tests/understanding.test.ts`: in the existing test that drives the `jevcode-brief.mjs` fixture in `fail` mode (search for `"fail"` in the file), assert the repository warning: `assert.match(repo.warnings.join("\n"), /^The latest brief attempt failed: exit 1/m)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/failure-reason.test.ts tests/understanding-runtime.test.ts`
Expected: FAIL (module not found; `lastFailure` undefined).

- [ ] **Step 3: Implement** `failure-reason.ts`, the runtime changes (schema: `lastFailure` optional, nullable), the briefing stderr capture and error message, and the overview warning. Keep `"ignore"` for stdin where it is today.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/failure-reason.test.ts tests/understanding-runtime.test.ts tests/understanding.test.ts`
Expected: PASS (the understanding suite starts hosts; run it on the host, not in a network-off sandbox).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/failure-reason.ts packages/host/src/understanding-runtime.ts packages/host/src/repository-briefings.ts packages/host/src/understanding.ts packages/remote/src/understanding-knowledge.ts tests/failure-reason.test.ts tests/understanding-runtime.test.ts tests/understanding.test.ts
git commit -m "feat(understanding): keep and show the reason when a brief or maintenance attempt fails"
```

---

### Task 4: Maintenance on by default with a one-time policy migration

**Files:**
- Modify: `packages/remote/src/understanding-knowledge.ts` (`KnowledgePolicy`)
- Modify: `packages/host/src/understanding-catalog.ts` (`defaults` at ~58, `policyInput` at 35, `catalogSchema`, load path near 142, policy mutation at ~321-335)
- Test: `tests/understanding-catalog.test.ts`

**Interfaces:**
- `KnowledgePolicy` gains `editedAt?: string | null` and `editedBy?: "owner" | "migration" | null`.
- `defaults` becomes `{ enabled: true, synthesis: true, delivery: true, intervalMinutes: 15, dailyJobLimit: 24 }`.
- Stored policies without `editedAt` are migrated on load to `{ ...defaults, editedAt: <now>, editedBy: "migration" }` and persisted; the catalog `revision` does not change. Policies with `editedAt` set are left alone.
- A policy mutation sets `editedAt: <now>, editedBy: "owner"` server-side; input still accepts only the five existing fields.
- `emptyCatalog()` returns `defaults` with `editedAt: null, editedBy: null` (a brand-new workspace is enabled without a migration mark).

- [ ] **Step 1: Write the failing tests** in `tests/understanding-catalog.test.ts` (follow the file's existing `setup` helper)

```ts
test("new workspaces are enabled by default and owner edits stamp editedAt", () => {
  const s = setup();
  const policy = s.catalog.read("workspace").policy;
  assert.deepEqual([policy.enabled, policy.synthesis, policy.delivery, policy.intervalMinutes, policy.dailyJobLimit], [true, true, true, 15, 24]);
  assert.equal(policy.editedAt, null);
  s.catalog.mutate("workspace", "policy", undefined, { requestId: randomUUID(), revision: 0, action: "update", value: { enabled: false, synthesis: false, delivery: false, intervalMinutes: 30, dailyJobLimit: 10 } }, s.context);
  const edited = s.catalog.read("workspace").policy;
  assert.equal(edited.enabled, false);
  assert.equal(edited.editedBy, "owner");
  assert.match(edited.editedAt ?? "", /^\d{4}-/);
});
test("a stored policy without editedAt migrates to enabled once; an owner-disabled policy survives restart", () => {
  const s = setup();
  s.writeStoredPolicy({ enabled: false, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 }); // legacy record, no editedAt
  const migrated = s.reopen().read("workspace").policy;
  assert.equal(migrated.enabled, true);
  assert.equal(migrated.editedBy, "migration");
  s.catalog.mutate("workspace", "policy", undefined, { requestId: randomUUID(), revision: 0, action: "update", value: { enabled: false, synthesis: false, delivery: false, intervalMinutes: 15, dailyJobLimit: 24 } }, s.context);
  assert.equal(s.reopen().read("workspace").policy.enabled, false);
});
```
Add `writeStoredPolicy` and `reopen` to the test file's setup helper: `writeStoredPolicy` seals a stored catalog with the given policy object using `writeSealed` at the same path and scope the catalog uses; `reopen` constructs a new `UnderstandingCatalog` on the same state directory.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/understanding-catalog.test.ts`
Expected: FAIL (defaults disabled; `editedBy` undefined).

- [ ] **Step 3: Implement** the type, schema (`editedAt: datetime nullable optional`, `editedBy: enum nullable optional`), defaults, migration in the load path, and the stamp in the policy mutation. Existing tests that assert `enabled: false` defaults must be updated to the new defaults, not deleted.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/understanding-catalog.test.ts tests/understanding-runtime.test.ts`
Expected: PASS. (Runtime tests use their own `catalog()` fixture with `enabled: false`, so no job starts unexpectedly.)

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/understanding-knowledge.ts packages/host/src/understanding-catalog.ts tests/understanding-catalog.test.ts
git commit -m "feat(understanding): enable workspace maintenance by default and stamp owner policy edits"
```

---

### Task 5: Repository brief step in maintenance with diagrams and a changes watermark

**Files:**
- Modify: `packages/remote/src/understanding-knowledge.ts` (`WorkspaceKnowledge`, new `KnowledgeRepositoryBrief`)
- Modify: `packages/host/src/understanding-adapter.ts` (`outputSchema` diagrams at 19, `validateBrief` at 33, `createUnderstandingAdapter`)
- Modify: `packages/host/src/understanding-runtime.ts` (`UnderstandingAdapter`, `StoredRepository`, `storedRepositorySchema`, `runWorkspace`, `read`)
- Modify: `tests/fixtures/jevcode-brief.mjs` (emit a `diagrams` entry in the default mode)
- Test: `tests/understanding-runtime.test.ts`, `tests/understanding-adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 (`diagramFromMermaid`, `componentGraph`, `linkDiagramNodes`, `diagramGraphSchema`), Task 3 (`failureReason`).
- Produces (shared):
  ```ts
  export interface KnowledgeRepositoryBrief {
    repositoryId: string; head: string | null; base: string | null; generatedAt: string; observedAt: string;
    state: "ready" | "stale"; brief: UnderstandingBrief; diagrams: DiagramGraph[];
    evidence: { source: string; line: number; text: string }[]; coverage: string[];
  }
  // WorkspaceKnowledge gains optional: briefs?: KnowledgeRepositoryBrief[]; diagrams?: DiagramGraph[];
  ```
- Produces (host):
  ```ts
  export interface RepositoryBriefOutput { head: string | null; base: string | null; generatedAt: string; brief: UnderstandingBrief; diagrams: { title: string; kind: "system" | "change"; mermaid: string }[]; evidence: { source: string; line: number; text: string }[]; coverage: string[] }
  // UnderstandingAdapter gains:
  brief?(input: { workspaceId: string; root: string; repositoryId: string; context: RepoContext; base: string | null; components: Pick<KnowledgeComponent, "id" | "name">[] }, options: UnderstandingAdapterOptions): Promise<RepositoryBriefOutput>;
  ```
- Adapter implementation: runs `config.repositoryBriefings.command` with `[...args, ...writerArgs, "brief", "--repo", root, "--format", "json", "--no-state", ...(base ? ["--base", base] : []), "--question", question]` where `question` is `"Explain the whole repository for its owner. In diagrams, use these component ids as node ids when a node describes that component: " + components.map(c => \`${c.id} (${c.name})\`).join(", ")`. Parses with `validateBrief` (extend `outputSchema.diagrams` to the briefing schema shape: `{ title ≤120, kind, mermaid ≤3000, citations }`, max 2) and returns `RepositoryBriefOutput`.
- `StoredRepository` gains `brief: StoredBrief | null`, `briefFingerprint: string | null`, `briefFailure: string | null`, `previousHead: string | null`, `componentDiagram: DiagramGraph | null` where `StoredBrief = Omit<KnowledgeRepositoryBrief, "state" | "repositoryId">`. Schema additions are optional with defaults so existing sealed state still loads.
- `runWorkspace`, after capture of each repository and before component synthesis: when `policy.synthesis && adapter.brief` and `observation.briefFingerprint !== observation.fingerprint`, call `adapter.brief` with `base: observation.previousHead` through `this.invoke` with the remaining deadline; on success store `brief` (diagrams via `linkDiagramNodes(diagramFromMermaid(...), components)`, ids `` `${repositoryId}:${index}` ``), set `briefFingerprint = fingerprint`, `briefFailure = null`; on failure set `briefFailure = failureReason(error)` and push `` Repository ${name}: brief unavailable: ${reason} `` into `partial` without throwing. `previousHead` is set to the prior stored `head` whenever `fingerprint` changes. Always set `componentDiagram = componentGraph(...)` from the captured components and relationships. A brief run does not change the daily job count (it is part of the job).
- `read` returns `briefs` (one per stored repository with a brief; `state: "stale"` when current HEAD differs from `brief.head`, else `"ready"`) and `diagrams` (every repository's `componentDiagram` followed by each brief's diagrams).
- `server.ts` knowledge read (line ~306) spreads the runtime read, so the new fields flow into the overview automatically; the overview's bounded knowledge (Task 8) handles their size.
- Fixture: `tests/fixtures/jevcode-brief.mjs` default mode adds `diagrams: [{ title: "System shape", kind: "system", mermaid: "flowchart LR\n  unstable-a[A] --> unstable-b[B]", citations: [] }]` and when `--base` is given adds one `changes` claim `` `Changed since ${base.slice(0, 7)}` `` citing `README.md:1`. The fixture also accepts a `brief-fail` mode that exits 1 only when the first positional argument is `brief` (the `context` call must still succeed).

- [ ] **Step 1: Write the failing tests**

`tests/understanding-adapter.test.ts` (follow its existing fixture pattern):
```ts
test("brief adapter asks the engine for a repository brief with component ids and keeps diagrams", async t => {
  const s = setup(t); // existing helper that points repositoryBriefings.command at tests/fixtures/jevcode-brief.mjs
  const output = await s.adapter.brief!({ workspaceId: "workspace", root: s.root, repositoryId: "repo", context: s.context, base: null, components: [{ id: "cmp_a", name: "A" }] }, s.options);
  assert.equal(output.diagrams.length, 1);
  assert.match(output.diagrams[0].mermaid, /^flowchart LR/);
  const receipt = s.lastReceipt(); // parsed last line of the fixture receipt file
  assert.equal(receipt.args[0], "brief");
  assert.ok(receipt.args.includes("--no-state"));
  assert.match(receipt.args[receipt.args.indexOf("--question") + 1], /cmp_a \(A\)/);
});
```
`tests/understanding-runtime.test.ts`:
```ts
test("maintenance publishes a repository brief with parsed diagrams, a component map, and a changes watermark", { timeout: 30000 }, async t => {
  const s = setup(t, { processFixture: true });
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, synthesis: true } });
  s.runtime.refresh("workspace");
  await waitUntil(() => (s.runtime.read("workspace").briefs?.length ?? 0) === 1);
  const first = s.runtime.read("workspace");
  assert.equal(first.briefs![0].state, "ready");
  assert.equal(first.briefs![0].base, null);
  assert.equal(first.briefs![0].diagrams[0].nodes.map(n => n.componentId).filter(Boolean).length, 0, "fixture node ids are not component ids");
  assert.equal(first.diagrams![0].kind, "components");
  assert.equal(first.diagrams![0].nodes.length, 2);
  const head = execFileSync("git", ["-C", s.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(s.root, "src", "a.ts"), "export const a = 10;\n");
  execFileSync("git", ["-C", s.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qam", "change"]);
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").briefs?.[0]?.base === head);
  assert.match(s.runtime.read("workspace").briefs![0].brief.changes[0].text, /^Changed since/);
});
test("a failing brief step keeps the source map and records the brief reason", { timeout: 30000 }, async t => {
  const s = setup(t, { processFixture: true, fixtureMode: "brief-fail" });
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true, synthesis: true } });
  s.runtime.refresh("workspace");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
  const read = s.runtime.read("workspace");
  assert.equal(read.briefs?.length ?? 0, 0);
  assert.equal(read.diagrams![0].kind, "components");
  assert.match(read.maintenance.message ?? "", /brief unavailable: exit 1/);
});
```
Extend the test file's `setup` with `fixtureMode?: string` passed to the fixture as its mode argument.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/understanding-adapter.test.ts tests/understanding-runtime.test.ts`
Expected: FAIL (`brief` undefined; `briefs` undefined).

- [ ] **Step 3: Implement** the fixture change, adapter `brief`, runtime storage and job step, and `read` additions.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/understanding-adapter.test.ts tests/understanding-runtime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/understanding-knowledge.ts packages/host/src/understanding-adapter.ts packages/host/src/understanding-runtime.ts tests/fixtures/jevcode-brief.mjs tests/understanding-adapter.test.ts tests/understanding-runtime.test.ts
git commit -m "feat(understanding): brief each repository at its tracked head with diagrams and a changes watermark"
```

---

### Task 6: Refresh when work lands

**Files:**
- Modify: `packages/host/src/understanding-runtime.ts` (new public method)
- Modify: `packages/host/src/project-source.ts` (`ProjectSourceOptions`, `refreshOne` success path)
- Modify: `packages/host/src/server.ts` (lines ~125-160 and ~300-306)
- Test: `tests/understanding-runtime.test.ts`, `tests/project-source.test.ts` (if present; otherwise add the assertion to the existing source-tracking test file found by `grep -l ProjectSourceService tests/*.test.ts`)

**Interfaces:**
- Produces: `UnderstandingRuntime.sourceChanged(projectId: string): void` — for every group whose repos include a checkout with that `projectId` and whose policy is `enabled`, calls `this.refresh(group.id)`; errors are swallowed. Returns nothing.
- `ProjectSourceOptions` gains `onApplied?: (projectId: string, head: string) => void`, invoked by `refreshOne` only when the working tree's HEAD changed during this refresh.
- `server.ts`: declare `let sourceChanged: (projectId: string) => void = () => {};` before `projectSource` and `teams` are built; pass `onApplied: id => sourceChanged(id)` to the source service and extend the teams `onMerged` closure to also call `sourceChanged(id)`; after `understandingRuntime` is constructed, assign `sourceChanged = id => understandingRuntime.sourceChanged(id)`.
- Cancelled or no-change runs trigger nothing: the source did not move, and the Planned and "What changed" sections read work records live. This narrows the spec's trigger list deliberately.

- [ ] **Step 1: Write the failing tests**

`tests/understanding-runtime.test.ts`:
```ts
test("sourceChanged queues a refresh only for enabled workspaces that contain the checkout", { timeout: 20000 }, async t => {
  const s = setup(t, { adapter: { context: async root => sampleContext(root) } });
  s.runtime.sourceChanged("repo");
  assert.equal(s.runtime.read("workspace").maintenance.state, "disabled");
  s.setCatalog({ ...catalog(), policy: { ...catalog().policy, enabled: true } });
  s.runtime.sourceChanged("other-project");
  assert.notEqual(s.runtime.read("workspace").maintenance.state, "queued");
  s.runtime.sourceChanged("repo");
  await waitUntil(() => s.runtime.read("workspace").components.length === 2);
});
```
Project source test: in the existing refresh test, pass `onApplied` and assert it is called once with the project id and the new head after a fast-forward, and not called when the refresh finds nothing new.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/understanding-runtime.test.ts`
Expected: FAIL (`sourceChanged` is not a function).

- [ ] **Step 3: Implement** the runtime method, the source option, and the server wiring.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/understanding-runtime.test.ts <project source test file>` and `npm run typecheck -w @infinite/host`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/understanding-runtime.ts packages/host/src/project-source.ts packages/host/src/server.ts tests/understanding-runtime.test.ts <project source test file>
git commit -m "feat(understanding): refresh a workspace when a merge lands or its GitHub source advances"
```

---

### Task 7: Retention that survives workspace cleanup and shares fairly

**Files:**
- Modify: `packages/host/src/understanding.ts` (`MAX_GENERATIONS` at 17, `retainedGenerations` at ~355, `visibleEntry` at ~233)
- Test: `tests/understanding.test.ts`

**Interfaces:**
- `retainedGenerations` keeps at most `MAX_GENERATIONS_PER_PROJECT = 16` newest entries per `artifact.sourceProjectId`, then applies the global byte cap (newest first across projects). `MAX_GENERATIONS` (64 total) is removed.
- `visibleEntry` for `sourceKind === "team"`: when the session metadata is unavailable, the run record no longer lists the member, or `realpathSync(expected.root)` / `sourceCwd` throws, the entry stays visible as long as the repository binding still matches (`project.enrolledPath`, device, inode and `repoIdentity` equal) and the artifact has a recorded `head`. The ownership check still applies when the session is available.

- [ ] **Step 1: Write the failing tests** in `tests/understanding.test.ts`, using the file's existing helpers for retaining a team artifact (search for `sourceKind: "team"` and reuse the fixture that writes a sealed entry)

```ts
test("team artifacts remain visible after their member workspace is removed", { timeout: 40000 }, async () => {
  // retain one team artifact for the rehearsal checkout through the existing fixture path, then
  rmSync(memberWorkspaceDir, { recursive: true, force: true });
  const after = await viewer.request<WorkspaceUnderstanding>(path);
  assert.equal(after.repositories[0].current.length, 1);
  assert.equal(after.repositories[0].current[0].sourceKind, "team");
});
test("retention keeps the newest sixteen generations per repository instead of a global cap", () => {
  const entries = [...Array(20)].map((_, i) => entry("repo-a", i)).concat([...Array(5)].map((_, i) => entry("repo-b", i)));
  const kept = retainedGenerationsForTest(entries); // export retainedGenerations under a test-only name or test through the service's load()
  assert.equal(kept.filter(e => e.artifact.sourceProjectId === "repo-a").length, 16);
  assert.equal(kept.filter(e => e.artifact.sourceProjectId === "repo-b").length, 5);
});
```
Prefer testing through `UnderstandingService.load()` by writing 25 sealed entries into the artifacts directory (the file already writes sealed entries with `writeSealed`); only export the function if that proves impractical.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/understanding.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement** the per-project retention and the relaxed team visibility.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/understanding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/understanding.ts tests/understanding.test.ts
git commit -m "fix(understanding): keep team briefs visible after cleanup and retain per repository"
```

---

### Task 8: Overview without fixed fractions, planned excerpts, and paged endpoints

**Files:**
- Create: `packages/host/src/understanding-pages.ts`
- Modify: `packages/remote/src/understanding.ts` (`UnderstandingPlan`)
- Modify: `packages/host/src/understanding.ts` (`boundedResponse` at ~363-424, `boundedKnowledge` at ~429, planned mapping in `get` at ~333)
- Modify: `packages/host/src/server.ts` (routes after line 566)
- Test: `tests/understanding-pages.test.ts`, `tests/understanding.test.ts`

**Interfaces:**
- `UnderstandingPlan` gains `excerpt: boolean` (true when `text` was cut to 600 characters) — optional in the shared type for older hosts: `excerpt?: boolean`.
- Produces (`understanding-pages.ts`):
  ```ts
  export const PAGE_MAX_ITEMS = 50; export const PAGE_MAX_BYTES = 512 * 1024;
  export function pageOf<T>(items: T[], cursor: string | undefined, key: (item: T) => string): { items: T[]; next: string | null };
  export function encodeCursor(index: number, key: string): string; export function decodeCursor(value: string): { index: number; key: string } | null;
  ```
  Cursor = base64url of `${index}:${key}`; `pageOf` starts at `index` only when `key(items[index]) === key`, otherwise it searches for the item with that key (a list may have grown) and starts after it; invalid cursors start at 0. A single item larger than `PAGE_MAX_BYTES` is returned alone on its own page.
- `UnderstandingService` gains:
  ```ts
  briefsPage(workspaceId: string, repositoryId: string, cursor?: string): { items: UnderstandingArtifact[]; next: string | null };
  plannedPage(workspaceId: string, repositoryId: string, cursor?: string): { items: UnderstandingPlan[]; next: string | null }; // full text, excerpt: false
  workPage(workspaceId: string, cursor?: string): { items: UnderstandingWork[]; next: string | null };
  ```
- Routes (read roles owner, controller, viewer): `GET …/understanding/briefs?repository=ID&cursor=`, `GET …/understanding/planned?repository=ID&cursor=`, `GET …/understanding/work?cursor=`, `GET …/understanding/diagrams/:diagramId` (from `understandingRuntime.read(id).diagrams`, 404 when absent; diagram ids may contain `:`), `GET …/understanding/brief?repository=ID` (the `KnowledgeRepositoryBrief` for that repository, 404 when none). Query validation: `repository` matches `/^[a-z0-9-]{1,80}$/`, `cursor` ≤ 200 chars.
- `boundedResponse` rewrite: one budget `MAX_RESPONSE_BYTES - 64 * 1024` consumed in this order, each item whole: workspace metadata and coverage; every repository shell (no `current`, no `planned`); `knowledge` without `briefs`, `diagrams`, `components`, `relationships`, `delivery`; the newest `current` artifact per repository without evidence; `work`; `planned` (already excerpts); `knowledge.components`, `relationships`, `delivery`, `briefs`, `diagrams`; older artifacts; evidence. When something is left out, one coverage line per category: `` ${category}: ${included} of ${total} shown here; the rest are available on the detail pages. `` The catalog is never emptied.
- `get` builds `planned[].text` as the first 600 characters of the objective with `excerpt: true` when cut.

- [ ] **Step 1: Write the failing tests**

`tests/understanding-pages.test.ts`:
```ts
test("pages by count and bytes with stable cursors across inserts", () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ id: `k${i}`, body: "x".repeat(10) }));
  const first = pageOf(items, undefined, item => item.id);
  assert.equal(first.items.length, 50);
  const second = pageOf([{ id: "new", body: "" }, ...items], first.next!, item => item.id);
  assert.equal(second.items[0].id, "k50");
  const big = pageOf([{ id: "a", body: "y".repeat(600 * 1024) }, { id: "b", body: "" }], undefined, item => item.id);
  assert.deepEqual(big.items.map(item => item.id), ["a"]);
  assert.equal(pageOf(items, "garbage", item => item.id).items[0].id, "k0");
});
```
`tests/understanding.test.ts`:
```ts
test("planned requests are complete across the overview excerpt and the planned page", { timeout: 60000 }, async () => {
  // retain 13 goals with 20 KB objectives through retainGoal(host, i, "o".repeat(20_000))
  const overview = await viewer.request<WorkspaceUnderstanding>(path);
  const repo = overview.repositories[0];
  assert.equal(repo.planned.length, 13);
  assert.ok(repo.planned.every(plan => plan.text.length === 600 && plan.excerpt === true));
  assert.equal(repo.coverage.length, 0);
  let cursor: string | undefined, all: string[] = [];
  do { const page = await viewer.request<{ items: { workId: string; text: string }[]; next: string | null }>(`${path}/planned?repository=${repo.id}${cursor ? `&cursor=${cursor}` : ""}`); all.push(...page.items.map(item => item.text)); cursor = page.next ?? undefined; } while (cursor);
  assert.equal(all.length, 13);
  assert.ok(all.every(text => text.length === 20_000));
});
test("the diagram and brief routes answer with 404 before any observation", { timeout: 40000 }, async () => {
  assert.equal((await host.fetchApi(`${path}/diagrams/components:rehearsal`, "viewer")).status, 404);
  assert.equal((await host.fetchApi(`${path}/brief?repository=rehearsal`, "viewer")).status, 404);
  assert.equal((await host.fetchApi(`${path}/work`, "viewer")).status, 200);
});
```
Update the existing test that asserts the fraction-based coverage strings (search for `"to fit its byte limit"` in `tests/understanding.test.ts`) to the new single-budget behavior: with the default fixture nothing is omitted and `coverage` carries no omission line.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/understanding-pages.test.ts tests/understanding.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the pages module, service methods, routes, `boundedResponse` rewrite, and excerpt mapping.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test tests/understanding-pages.test.ts tests/understanding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/understanding-pages.ts packages/host/src/understanding.ts packages/host/src/server.ts packages/remote/src/understanding.ts tests/understanding-pages.test.ts tests/understanding.test.ts
git commit -m "feat(understanding): page briefs, planned requests and work instead of trimming the overview"
```

---

### Task 9: Plans and projects generated from work

**Files:**
- Modify: `packages/remote/src/understanding.ts` (new types)
- Modify: `packages/host/src/understanding.ts` (new method)
- Modify: `packages/host/src/server.ts` (new route)
- Test: `tests/understanding.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export interface GeneratedPlan { id: string; workId: string; kind: UnderstandingWorkKind; title: string; objective: string; repositoryIds: string[]; status: string; column: UnderstandingWork["column"]; outcome: string | null; links: UnderstandingLink[]; updatedAt: string; basis: "work" }
  export interface GeneratedProject { id: string; name: string; repositoryIds: string[]; planIds: string[]; basis: "repository" }
  export interface GeneratedCatalogPage { projects: GeneratedProject[]; plans: GeneratedPlan[]; next: string | null; coverage: string[] }
  ```
- `UnderstandingService.generatedPage(workspaceId: string, cursor?: string): GeneratedCatalogPage`: one `GeneratedPlan` per complete-scope work row with a non-empty objective (`id: \`plan:${work.id}\``, `objective` full text, `outcome: reportedSummary`); one `GeneratedProject` per repository (`id: \`project:${repositoryId}\``, `name` = repository name, `planIds` = plans naming that repository). Plans page with `pageOf`; projects are always complete (≤ 64). `coverage` carries the single line `"From work: derived from recorded team, mission and goal requests. Status is the run's own status."`. Tracker-based projects are out of this slice.
- Route: `GET …/understanding/generated?cursor=` (read roles).

- [ ] **Step 1: Write the failing test** in `tests/understanding.test.ts`

```ts
test("generated plans and projects derive from recorded work without touching the catalog", { timeout: 40000 }, async () => {
  retainGoal(host, 1, "Build the thing");
  const page = await viewer.request<GeneratedCatalogPage>(`${path}/generated`);
  assert.equal(page.plans.length, 1);
  assert.equal(page.plans[0].basis, "work");
  assert.equal(page.plans[0].objective, "Build the thing");
  assert.equal(page.plans[0].status, "cancelled");
  assert.deepEqual(page.projects.map(project => project.planIds), [[page.plans[0].id]]);
  assert.equal((await viewer.request<WorkspaceUnderstanding>(path)).knowledge?.catalog.revision, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/understanding.test.ts`
Expected: FAIL (404).

- [ ] **Step 3: Implement** the types, method and route.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/understanding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/remote/src/understanding.ts packages/host/src/understanding.ts packages/host/src/server.ts tests/understanding.test.ts
git commit -m "feat(understanding): derive plans and projects from recorded work"
```

---

### Task 10: CLI follows cursors and prints briefs and diagrams

**Files:**
- Modify: `packages/host/src/understanding-cli.ts`
- Modify: `docs/cli.md` (the `understand` section)
- Test: `tests/understanding-cli.test.ts`

**Interfaces:**
- Consumes: Task 8 routes, Task 9 route, Task 5 `briefs`/`diagrams`.
- `infinite understand --workspace ID` prints, after the existing sections: `Repository brief` lines per `knowledge.briefs` entry (summary, state, head, then `Diagram <title> (<n> nodes, <m> edges)` and one `  <from> -> <to>` line per edge, or `  diagram not parsed: <parseError>`), and `Planned requests` fetched through `/planned` for each repository following `next` until null, printing full text. `--json` prints the overview plus `{ briefs, planned: { [repositoryId]: UnderstandingPlan[] }, generated: GeneratedCatalogPage }` assembled from the paged endpoints.
- New subcommand `infinite understand generated --workspace ID [--json]`.

- [ ] **Step 1: Write the failing test** in `tests/understanding-cli.test.ts` (follow its fake `Api` pattern)

```ts
test("understand follows planned cursors and prints diagram edges", async () => {
  const api = fakeApi({ "/project-groups/w/understanding": overviewWith({ planned: [plan("p1", true)] , briefs: [briefWith(diagram("System shape", [["a", "b"]]))] }),
    "/project-groups/w/understanding/planned?repository=repo": { items: [fullPlan("p1")], next: "c2" },
    "/project-groups/w/understanding/planned?repository=repo&cursor=c2": { items: [fullPlan("p2")], next: null } });
  const out = await runUnderstand(api, { workspace: "w" });
  assert.match(out, /Diagram System shape \(2 nodes, 1 edges\)\n\s+a -> b/);
  assert.match(out, /p1 full text/); assert.match(out, /p2 full text/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/understanding-cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the printing and cursor following; update `docs/cli.md` with the `generated` subcommand and a sentence that `understand` prints complete planned requests by following pages.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test tests/understanding-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/understanding-cli.ts docs/cli.md tests/understanding-cli.test.ts
git commit -m "feat(cli): print repository briefs, diagrams and complete planned requests"
```

---

### Task 11: Phone diagram renderer

**Files:**
- Create: `apps/mobile/src/features/understanding/DiagramView.tsx`
- Test: `apps/mobile` lint and typecheck (no unit test harness exists for the phone)

**Interfaces:**
- Consumes: `DiagramGraph`, `layoutGraph`, `GraphLayout` from `@infinite/remote`.
- Produces:
  ```tsx
  export function DiagramView({ graph, onOpenComponent, collapsedGroupsAbove = 40 }: { graph: DiagramGraph; onOpenComponent?: (componentId: string) => void; collapsedGroupsAbove?: number }): JSX.Element
  ```
- Behavior: when `graph.parseError` is set, render a card with the title, the line "This diagram could not be drawn." and the Mermaid source in a monospace `Text` (selectable). Otherwise compute the layout with `layoutGraph` (memoized on `graph.id` and node/edge counts), draw with `react-native-svg` (`Svg`, `G`, `Rect`, `Text`, `Line`, `Polyline`, `Defs`, `Marker`): group boxes first (light fill, label at top left), then edges with an arrowhead marker and optional label at the midpoint, then nodes (rounded rect, label clipped to the box width with an ellipsis after 22 characters). Nodes with `componentId` use the forest accent border and are `Pressable` (accessibilityRole "button", label `Open component <label>`). When visible node count exceeds `collapsedGroupsAbove`, groups render collapsed as a single node `"<label> · <n>"` and expand in place on tap; the expansion state is local. Pinch-zoom and pan via a `ScrollView` with `maximumZoomScale={3}` horizontally and vertically nested (`horizontal` outer, inner vertical) so it works on both platforms without extra dependencies. The whole diagram is wrapped in a `View` with `accessibilityLabel` `"Diagram <title> with <n> parts and <m> connections"`.
- Colors come from `theme.colors` only (`paper`, `secondarySurface`, `fieldRule`, `ink`, `mutedInk`, `forest`).

- [ ] **Step 1: Implement `DiagramView.tsx`** as specified.

- [ ] **Step 2: Lint and typecheck the phone**

Run: `npm run lint -w @infinite/mobile && npx tsc --noEmit -p apps/mobile`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/features/understanding/DiagramView.tsx
git commit -m "feat(mobile): draw understanding diagrams natively with react-native-svg"
```

---

### Task 12: Phone System tab rebuilt around sections with plain copy

**Files:**
- Create: `apps/mobile/src/features/understanding/SystemOverview.tsx`
- Modify: `apps/mobile/src/features/understanding/UnderstandingWorkspace.tsx` (`SystemView` at ~223-232, `RepositoryCard` at ~234-295, copy at 226, 244, 288-291)
- Modify: `apps/mobile/src/features/understanding/KnowledgePanel.tsx` (new optional prop only)
- Modify: `apps/mobile/src/features/understanding/offline-cache.ts` only if the cached shape needs the new optional fields (it stores labels and state only; expected unchanged)

**Interfaces:**
- Consumes: `DiagramView` (Task 11); routes from Task 8 (`/brief?repository=`, `/briefs?repository=&cursor=`, `/planned?repository=&cursor=`); `knowledge.briefs`, `knowledge.diagrams` (Task 5); `api<T>(connection, path)` from `apps/mobile/src/api/client.ts`.
- `KnowledgePanel` gains `openComponentId?: string`; when it changes to a non-empty value the panel switches to the components area, selects that component and loads its detail (reuse the existing `pendingComponentNavigation` path). `SystemView` holds that id in state and passes it; `onOpenComponent` sets it and calls `onComponentNavigate`.
- Produces:
  ```tsx
  export function SystemOverview({ connection, workspaceId, data, offline, onOpenComponent }: { connection: Connection; workspaceId: string; data: WorkspaceUnderstanding; offline: boolean; onOpenComponent: (componentId: string) => void }): JSX.Element
  ```
- `SystemView` renders, in order: `SystemOverview`, then the existing `KnowledgePanel` with `defaultArea="components"`, then the single honesty line `"Generated from the code and the work records. It does not mean anything is deployed or approved."`. The intro sentence at line 226 is removed.
- `SystemOverview` sections (each a card with title, body, and a muted evidence label):
  1. **What this workspace is**: for each repository, the newest of `knowledge.briefs` summary (fallback: newest `current[0].brief.summary`; fallback copy: "No explanation yet. The first observation runs within a few minutes of enrollment."). Evidence label: `` From commit ${short(head)}, observed ${relative(observedAt)} `` or "Not observed yet".
  2. **Architecture**: `DiagramView` for the first `kind: "system"` diagram of the newest brief; below it the brief's `architecture` claims as paragraphs; each claim's citations shown as a muted `source:line` line. Empty copy: "The map appears after the first successful brief."
  3. **Components**: `DiagramView` for the `kind: "components"` diagram when it exists and the system diagram does not cover every component (fewer `componentId` links than components); a tap on a node calls `onOpenComponent`.
  4. **What changed**: newest first, the brief's `changes` claims, then `current` team artifacts (title `` ${short(head)} · team run `` from `sourceKind`), each with its generated time. Button "Show earlier briefs" pages `/briefs?repository=` and appends. Empty copy: "Nothing recorded since the first observation."
  5. **Planned**: `planned` items with title, status and the excerpt; "Read the full request" fetches the first `/planned` page containing that `workId` and expands in place. Empty copy: "No requests recorded for this repository."
  6. **Repository state line** replacing the old `RepositoryCard` copy: `"updating" → "Updating now"`, `"failed" → the first warning line (the reason)`, `"empty" → "Waiting for the first observation"`, `"unavailable" → "Source unavailable on the host"`, `"ready" → nothing`.
- `RepositoryCard` is deleted; the "Revision details" and evidence disclosures move into section 4's artifact rows unchanged in content.
- Copy constraints from the spec apply to every new string. No string contains "retained", "source-labeled", "snapshot", "byte", "omitted" or "Difference".

- [ ] **Step 1: Implement `SystemOverview.tsx`** and rewire `SystemView`.

- [ ] **Step 2: Lint and typecheck**

Run: `npm run lint -w @infinite/mobile && npx tsc --noEmit -p apps/mobile`
Expected: no errors.

- [ ] **Step 3: Grep the feature for banned words**

Run: `grep -n -i -E "retained|source-labeled|snapshot|byte|omitted|Difference" apps/mobile/src/features/understanding/SystemOverview.tsx apps/mobile/src/features/understanding/UnderstandingWorkspace.tsx`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/features/understanding/SystemOverview.tsx apps/mobile/src/features/understanding/UnderstandingWorkspace.tsx
git commit -m "feat(mobile): rebuild the System tab around summaries, diagrams and recent changes"
```

---

### Task 13: Phone Plans & projects "From work" and Maintenance in plain language

**Files:**
- Modify: `apps/mobile/src/features/understanding/KnowledgePanel.tsx` (`CatalogArea` section rendering projects/plans, `MaintenanceArea` at ~414-437, policy editor toggles at ~455-460)

**Interfaces:**
- Consumes: `GET …/understanding/generated` (Task 9), `KnowledgeMaintenance.lastFailure` (Task 3), `KnowledgePolicy.editedAt` (Task 4).
- Plans & projects: a "From work" section above the owner records on both the Projects and Plans tabs, loaded with the catalog reads; each generated plan shows title, kind, status, the first 200 characters of the objective, links, and "Planned vs current: not compared; promote this plan to an owner record to compare it." A button "Promote to owner record" opens the existing plan editor prefilled with `title`, `text: objective`, `repositoryIds`, `workId`, `status: "proposed"` (owners only). Owner records keep their current UI under the heading "Owner records".
- Maintenance copy:
  - Status line by state: `idle → "Up to date"`, `queued → "Refresh queued"`, `running → "Refreshing now"`, `failed → maintenance.message` (already "Last attempt failed at …: reason."), `budget-limited → "Daily refresh limit reached (<limit>). Resumes at 00:00 UTC."`, `disabled → "Automatic updates are off for this workspace."`, `unavailable → maintenance.message`.
  - Lines: `` Last observed <time> · last explained <time> `` (lastObservedAt, lastPublishedAt), `` Next attempt <time> `` only when set, `` Refreshes used today <n> of <limit> ``, and a static "Refreshes run every <interval> minutes, after a merge, and when the GitHub source moves."
  - Replace the intro "Model work runs only under the saved owner policy and when a host writer is configured." with "Automatic updates observe the code, write the explanation, and read delivery status."
  - A direct toggle "Automatic updates" (owner only) that submits the policy with `enabled` flipped and the other fields unchanged, beside the existing "Edit saved policy" button. Button "Refresh sources" becomes "Refresh now".
  - Policy editor toggle labels: "Automatic updates", "Write explanations with the summary writer", "Read pull requests and deployments".
- Delivery copy (same file, `DeliveryArea`): intro "How a change reaches users, as observed on GitHub." Per repository: `` Open pull requests <n> · merged recently <m> `` from `pullRequests`, each PR row `#<number> <title> · <state> · checks <passed>/<total>`, environments as `` <environment>: <status> at <short(revision)> ``. When `state === "unavailable"`, show "No delivery observations yet." followed by the first coverage line (which names what is missing: a GitHub source, CLI access, or deployment permission). Replace "Pull requests and provider environments are separate observations. A merged change does not prove deployment." with "A merged pull request is not a deployment; environment status is what GitHub reported."

- [ ] **Step 1: Implement** the sections and copy.

- [ ] **Step 2: Lint and typecheck**

Run: `npm run lint -w @infinite/mobile && npx tsc --noEmit -p apps/mobile`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/features/understanding/KnowledgePanel.tsx
git commit -m "feat(mobile): show plans from work and plain-language maintenance on the System tab"
```

---

### Task 14: Docs, full check, and a real screenshot

**Files:**
- Modify: `docs/repository-briefings.md` (Workspace Understanding, Catalog and navigation API table, Host maintenance), `docs/desktop.md` only if its description of defaults is now wrong (maintenance default)
- Modify: `docs/superpowers/specs/2026-10-25-system-tab-self-explaining-design.md` status line to "implemented on the phone; desktop and web follow"

**Interfaces:** none.

- [ ] **Step 1: Update `docs/repository-briefings.md`**: policy defaults are enabled (with the `editedAt` migration rule), the new routes (`briefs`, `planned`, `work`, `generated`, `brief`, `diagrams/:id`) in the API table, the repository brief step and changes watermark under Host maintenance, failure reasons in maintenance state, diagrams as graph data, per-repository retention and team artifact visibility. Keep every honesty statement.

- [ ] **Step 2: Privacy scan of everything staged**

Run: `git add -A && git diff --cached | grep -n -I -E '/Users/|/home/[a-z0-9_-]+/|~/(Library|Projects|Documents|Desktop)|\.ts\.net|SHA256:|BEGIN [A-Z ]*PRIVATE KEY|([0-9]{1,3}\.){3}[0-9]{1,3}'`
Expected: only loopback or documentation addresses, if any.

- [ ] **Step 3: Run the full check once**

Run: `npm run check`
Expected: typecheck, tests and builds pass. If the summary-brief or desktop-fence tests flake, rerun each alone before blaming a change (known flakes under parallel load).

- [ ] **Step 4: Screenshot the System tab on the simulator** against a scratch host that has a brief with a diagram. Reuse the preview-pair route and the fixture host described in the phone screenshot notes recorded privately outside this repository; save the screenshot outside the repository and attach it to the handoff.

- [ ] **Step 5: Commit**

```bash
git add docs/repository-briefings.md docs/desktop.md docs/superpowers/specs/2026-10-25-system-tab-self-explaining-design.md
git commit -m "docs(understanding): document default maintenance, paged reads, briefs and diagrams"
```

---

## Second slice (separate plan)

Desktop (`apps/macos/Sources/InfiniteDesktop/UnderstandingView.swift`, `UnderstandingKnowledgeView.swift`) and web (`apps/web`) consume the same routes and the shared layout; once they switch, delete the v1 trimming code and bump `schemaVersion` to 2. Deployment to the live host follows the private rollout procedure and is not part of this plan.
