# Work Briefs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the phone's raw-Markdown work expansion with a host-generated, sectioned work brief that renders rich text, component changes, and native interactive diagrams.

**Architecture:** Shared, dependency-free parsers and types in `@infinite/remote` (Markdown to rich nodes, Mermaid subset to a `Diagram` graph, layered layout). The host records a change index at team integration, assembles a deterministic `WorkBrief` at read time from recorded work, and caches an optional model narrative generated on explicit refresh. The phone gets a work detail route with a section rail, typed block renderers, and an SVG `DiagramView` built on `PanResponder`.

**Tech Stack:** TypeScript, Node 22 (`node --import tsx --test`), zod, Express routes, React Native 0.86 / Expo 57, `react-native-svg` 15, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-work-briefs-design.md`

## Global Constraints

- No new npm dependencies anywhere; the phone uses `PanResponder`, `Animated`, and `react-native-svg` only.
- `packages/remote/src/*` stays pure TypeScript: no `node:*`, no React imports.
- Nothing private in tracked files: no host paths, hostnames, or account names; fixtures use `/home/dev/...` style placeholders when an absolute path is unavoidable.
- Honesty: no generated text says "complete", "done", "deployed", or "merged" unless it quotes a recorded status; every block carries a `basis`.
- Reads (`GET`) never spawn a process. Only `POST …/refresh` may start a writer, and only for owner or controller.
- Bounds from the spec: 12 sections, 40 blocks, 4000 rich nodes per brief; 48 nodes and 120 edges per diagram; 4 diagrams per brief; 60 components and 400 files per `components` block; 2000 characters of check output; 24 citations per block; `run.changes` 400 files; `task.changedPaths` 200 paths; 48 narratives per workspace per UTC day; 64 narratives and 4 MiB per workspace store; 10-minute cooldown after a failed narrative.
- Tests that start a host use `startHost` from `tests/helpers.ts` with `timeout` set; pure tests use `node --import tsx --test tests/<file>`.
- Never use `git stash`. Other workers edit this repository in parallel; never revert their changes. Set work aside with a WIP commit if needed.
- Commit messages carry no `Claude-Session:` trailers or session links (house rule). The coordinator commits; workers do not.

## Review Focus

1. A request containing a fenced code block with `#` lines inside must render the lines as code, not headings (Task 2 pins this).
2. A Mermaid edge chain `A --> B --> C` and fan-out `A --> B & C` must produce three and two edges respectively, never a node named `B & C` (Task 3 pins this).
3. A cyclic flowchart (`A --> B --> A`) must still lay out and terminate (Task 4 pins this).
4. A run whose integration Git read fails must still integrate and the brief must say paths were not recorded (Tasks 5 and 7 pin this).
5. A viewer opening a brief must never cause a writer process to start, and a refresh for a run with a moved head must not serve the old narrative as current (Task 8 pins this).

---

### Task 1: Shared work brief types

**Files:**
- Create: `packages/remote/src/understanding-work.ts`
- Modify: `packages/remote/src/understanding.ts` (add `diagrams?: Diagram[]` to `UnderstandingBrief`)
- Modify: `packages/remote/src/index.ts` (export the new types and, later, the parser functions)

**Interfaces:**
- Produces: every type in the spec's "Shared types" section, verbatim names: `WorkBrief`, `WorkNarrativeStatus`, `WorkSectionKind`, `WorkSection`, `WorkBlock`, `Basis`, `RichNode`, `Inline`, `ComponentChange`, `Diagram`, plus `TaskSummary`, `CheckSummary`, `DecisionSummary` defined here as:

```ts
export interface TaskSummary { id: string; title: string; status: string; revision: number; role: string | null; summary: RichNode[]; diffStat: { added: number; removed: number; files: number } | null; reviewRounds: number; rubric: { correctness: number; cleanliness: number; extensibility: number; docs: number } | null; componentNames: string[]; workId?: string }
export interface CheckSummary { command: string; phase: "setup" | "verify"; status: "running" | "passed" | "failed" | "interrupted"; exitCode: number | null; headCommit: string | null; startedAt: string; finishedAt: string | null; outputTail: string }
export interface DecisionSummary { id: string; question: string; options: string[]; answer: string | null; answeredBy: "owner" | "coordinator" | null; answeredAt: string | null; createdAt: string }
```
  `TaskSummary.workId` is set on mission subtasks to the subteam's `team:<id>` so the phone can open that brief. `Diagram` includes `sourceText?` and `parseError?` as the spec says.

- [ ] **Step 1: Write the types file** exactly as the spec's "Shared types" section plus the three interfaces above; doc-comment each `Basis` value in one line.
- [ ] **Step 2: Add `diagrams?: Diagram[]` to `UnderstandingBrief`** in `packages/remote/src/understanding.ts`, importing the type from `./understanding-work.js`.
- [ ] **Step 3: Export** `export type * from "./understanding-work.js";` from `packages/remote/src/index.ts`.
- [ ] **Step 4: Typecheck**: `npm run typecheck -w @infinite/remote` → exit 0.
- [ ] **Step 5: Commit** `feat(remote): add work brief, rich text, and diagram types (INF-158)`.

### Task 2: Markdown to rich nodes

**Files:**
- Create: `packages/remote/src/markdown.ts`
- Modify: `packages/remote/src/index.ts` (add `export { parseMarkdown } from "./markdown.js";`)
- Test: `tests/markdown.test.ts`

**Interfaces:**
- Consumes: `RichNode`, `Inline` from Task 1.
- Produces: `parseMarkdown(text: string, options?: { maxNodes?: number; maxBytes?: number }): { nodes: RichNode[]; truncated: boolean }`. Defaults `maxNodes = 4000`, `maxBytes = 256 * 1024`. Never throws.

- [ ] **Step 1: Write the failing tests** in `tests/markdown.test.ts` (node:test, `assert/strict`):

```ts
test("headings, paragraphs and emphasis", () => {
  const { nodes } = parseMarkdown("# Title\n\nSome **bold** and *italic* with `code`.");
  assert.deepEqual(nodes[0], { type: "heading", level: 1, inlines: [{ type: "text", text: "Title" }] });
  assert.deepEqual(nodes[1], { type: "paragraph", inlines: [
    { type: "text", text: "Some " }, { type: "text", text: "bold", bold: true }, { type: "text", text: " and " },
    { type: "text", text: "italic", italic: true }, { type: "text", text: " with " }, { type: "code", text: "code" }, { type: "text", text: "." } ] });
});
test("nested lists keep nesting and ordered starts", () => {
  const { nodes } = parseMarkdown("* a\n  * b\n    1. c\n2. d");
  const list = nodes[0]; assert.equal(list.type, "list"); assert.equal(list.ordered, false);
  assert.equal(list.items[0].children[0].type, "list");
  assert.equal(list.items[0].children[0].items[0].children[0].type, "list");
  assert.equal(list.items[0].children[0].items[0].children[0].ordered, true);
  assert.equal(nodes[1].type, "list"); assert.equal(nodes[1].start, 2);
});
test("fenced code keeps hash lines as code", () => {
  const { nodes } = parseMarkdown("```sh\n# not a heading\nnpm test\n```");
  assert.deepEqual(nodes, [{ type: "code", language: "sh", text: "# not a heading\nnpm test" }]);
});
test("links: https only, bare https autolinked, other schemes stay text", () => {
  const { nodes } = parseMarkdown("See [docs](https://example.invalid/a) and https://example.invalid/b and [x](javascript:alert(1)) and file:///etc");
  const inlines = (nodes[0] as { inlines: Inline[] }).inlines;
  assert.deepEqual(inlines.filter(i => i.type === "link"), [{ type: "link", text: "docs", url: "https://example.invalid/a" }, { type: "link", text: "https://example.invalid/b", url: "https://example.invalid/b" }]);
  assert.ok(inlines.some(i => i.type === "text" && i.text.includes("x")));
});
test("quotes, rules and pipe tables", () => {
  const { nodes } = parseMarkdown("> quoted\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |");
  assert.equal(nodes[0].type, "quote"); assert.equal(nodes[1].type, "rule");
  assert.equal(nodes[2].type, "paragraph"); // table rows become paragraphs: "a · b" then "1 · 2"
});
test("bounds: maxNodes truncates and reports; huge input does not throw", () => {
  const { nodes, truncated } = parseMarkdown(Array.from({ length: 50 }, (_, i) => `para ${i}`).join("\n\n"), { maxNodes: 10 });
  assert.equal(nodes.length, 10); assert.equal(truncated, true);
  assert.doesNotThrow(() => parseMarkdown("x".repeat(600 * 1024)));
});
```

- [ ] **Step 2: Run** `node --import tsx --test tests/markdown.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `parseMarkdown`** in `packages/remote/src/markdown.ts`. Line-based block parser: fence detection first, then heading (`#{1,4} `; deeper levels clamp to 4), rule (`---`/`***`), quote (`> ` prefix, recursive), list items (`[-*+] ` or `\d+[.)] `, nesting by indent width of the marker; the first ordered item sets `start`), pipe table rows (lines starting with `|`, skip the `|-|` separator, cells joined with ` · `), else paragraph (consecutive non-empty lines joined with a space). Inline parser: single pass over the text producing runs for `**`/`__` bold, `*`/`_` italic (not inside words for `_`), backtick code, `[text](url)`, and bare `https://` tokens; unterminated markers are literal text. Truncate input at `maxBytes`, stop emitting at `maxNodes` (count every node including nested), set `truncated`.
- [ ] **Step 4: Run** the test file → PASS. Also `npm run typecheck -w @infinite/remote`.
- [ ] **Step 5: Commit** `feat(remote): bounded Markdown to rich-text parser (INF-158)`.

### Task 3: Mermaid subset to Diagram

**Files:**
- Create: `packages/remote/src/mermaid.ts`
- Modify: `packages/remote/src/index.ts` (export `parseMermaid`)
- Test: `tests/mermaid.test.ts`

**Interfaces:**
- Consumes: `Diagram` from Task 1.
- Produces: `parseMermaid(text: string): { ok: true; diagram: Pick<Diagram, "direction" | "nodes" | "edges" | "groups" | "sequence">; kind: "flowchart" | "sequence"; coverage: string[] } | { ok: false; error: string }`. Never throws. Max 48 nodes, 120 edges, text 3000 characters.

- [ ] **Step 1: Write the failing tests** in `tests/mermaid.test.ts`, one assertion group per fixture listed in the spec's "Test fixtures" bullet:

```ts
test("flowchart shapes, labels, chains, fan-out and subgraphs", () => {
  const r = parseMermaid("flowchart TD\n  A[Store] -->|reads| B(Cache)\n  B -.-> C{Decide}\n  C --> D[(DB)] & E([Queue])\n  E --> F --> G");
  assert.ok(r.ok); const d = r.diagram;
  assert.equal(d.direction, "TD");
  assert.deepEqual(d.nodes.map(n => [n.id, n.label, n.shape]), [["A","Store","box"],["B","Cache","round"],["C","Decide","diamond"],["D","DB","cylinder"],["E","Queue","pill"],["F","F","box"],["G","G","box"]]);
  assert.deepEqual(d.edges.map(e => [e.from, e.to, e.label ?? null, e.style]), [["A","B","reads","solid"],["B","C",null,"dashed"],["C","D",null,"solid"],["C","E",null,"solid"],["E","F",null,"solid"],["F","G",null,"solid"]]);
  const g = parseMermaid("graph LR\n  subgraph Host\n    A --> B\n  end\n  B --> C");
  assert.ok(g.ok); assert.deepEqual(g.diagram.groups, [{ id: "Host", label: "Host" }]);
  assert.equal(g.diagram.nodes.find(n => n.id === "A")?.group, "Host"); assert.equal(g.diagram.nodes.find(n => n.id === "C")?.group, undefined);
  assert.ok(parseMermaid("flowchart LR\n  API --> Policy").ok);
  assert.equal(parseMermaid("flowchart LR\n  A -- label --> B").ok && parseMermaid("flowchart LR\n  A -- label --> B").diagram.edges[0].label, "label");
  assert.equal(parseMermaid("flowchart LR\n  A ==> B").ok && parseMermaid("flowchart LR\n  A ==> B").diagram.edges[0].style, "thick");
});
test("sequence diagrams", () => {
  const r = parseMermaid("sequenceDiagram\n  participant A as API\n  A->>B: request\n  Note over A: skip me\n  B-->>A: reply");
  assert.ok(r.ok); assert.equal(r.kind, "sequence");
  assert.deepEqual(r.diagram.sequence?.participants, [{ id: "A", label: "API" }, { id: "B", label: "B" }]);
  assert.deepEqual(r.diagram.sequence?.messages, [{ from: "A", to: "B", text: "request", style: "solid" }, { from: "B", to: "A", text: "reply", style: "dashed" }]);
  assert.ok(r.coverage.some(line => /skipped 1/.test(line)));
});
test("dropped inputs", () => {
  for (const text of ["flowchart LR\n  A --> B\n  click A \"https://example.invalid\"", "flowchart LR\n  A[<img src=x>] --> B", "%%{init: {}}%%\nflowchart LR\n  A --> B",
    "flowchart LR\n  A --> B\n  style A fill:#f00", "flowchart LR\n  A --> B\n  classDef red fill:#f00", "flowchart LR\n  A --> B\n  class A red", "flowchart LR\n  A --> B\n  linkStyle 0 stroke:#f00",
    "sequenceDiagram\n  A->>B: hi\n  link A: Docs @ example", "flowchart LR\n  A@{ img: \"x.png\" } --> B", "pie title X\n  \"a\": 1", "flowchart LR\n  A --> B\n  " + "Z --> Y\n".repeat(60)]) {
    const r = parseMermaid(text); assert.equal(r.ok, false, text);
  }
});
test("unparsed lines over 10% drop the diagram, under keep it with coverage", () => {
  const bad = parseMermaid("flowchart LR\n  A --> B\n  ??? nonsense ???");
  assert.equal(bad.ok, false);
  const lines = ["flowchart LR", ...Array.from({ length: 20 }, (_, i) => `  N${i} --> N${i + 1}`), "  ??? one bad line"];
  const ok = parseMermaid(lines.join("\n")); assert.ok(ok.ok); assert.ok(ok.coverage.some(l => /1 line/.test(l)));
});
```

- [ ] **Step 2: Run** `node --import tsx --test tests/mermaid.test.ts` → FAIL.
- [ ] **Step 3: Implement `parseMermaid`**. Reject before parsing when the text contains `%%{`, `click`, `linkStyle`, `classDef`, `class `, `style `, `link`, `<`, `@{`, or does not start with `/^(flowchart|graph)\s+(TD|TB|BT|LR|RL)\b|^sequenceDiagram\b/` (`TB` maps to `TD`, `BT` and `RL` map to `TD`/`LR` with edges kept in declared order). Flowchart lines: `subgraph <id> [<label>]?` / `end`, then edge statements split on the edge operator regex `/\s*(-->|---|-\.->|==>|--\s*[^-]+\s*-->)\s*/` with an optional `|label|` after the operator; each side may be `id`, `id[label]`, `id(label)`, `id((label))`, `id{label}`, `id[(label)]`, `id([label])`, or an `&` list. First mention declares a node; a later shape declaration updates label and shape. Sequence lines: `participant X as Label`, `X->>Y: text` (solid), `X-->>Y: text` (dashed), `X->Y:`/`X-->Y:` likewise; `Note`, `loop`, `alt`, `else`, `end`, `activate`, `deactivate` are skipped and counted. Undeclared participants are declared on first use in a message, in order.
- [ ] **Step 4: Run** → PASS; typecheck remote.
- [ ] **Step 5: Commit** `feat(remote): parse the Mermaid flowchart and sequence subset into diagram data (INF-158)`.

### Task 4: Layered diagram layout

**Files:**
- Create: `packages/remote/src/diagram-layout.ts`
- Modify: `packages/remote/src/index.ts` (export `layoutDiagram` and `DiagramLayout`)
- Test: `tests/diagram-layout.test.ts`

**Interfaces:**
- Consumes: `Diagram` from Task 1.
- Produces:
```ts
export interface DiagramLayout { width: number; height: number; nodes: { id: string; x: number; y: number; w: number; h: number; lines: string[] }[]; edges: { from: string; to: string; points: [number, number][]; label?: string; labelAt: [number, number]; style: "solid" | "dashed" | "thick" }[]; groups: { id: string; label: string; x: number; y: number; w: number; h: number }[]; lanes?: { id: string; label: string; x: number }[] }
export function layoutDiagram(diagram: Pick<Diagram, "direction" | "nodes" | "edges" | "groups" | "sequence">): DiagramLayout
```
  Constants exported: `NODE_W = 132`, `NODE_H = 44`, `LAYER_GAP = 56`, `NODE_GAP = 18`, `GROUP_PAD = 14`. `lines` is the label wrapped to at most two lines of 18 characters, the second ending in `…` when cut.

- [ ] **Step 1: Write the failing tests**:

```ts
test("longest-path layering and deterministic positions", () => {
  const a = layoutDiagram(flow("LR", ["A","B","C","D"], [["A","B"],["B","C"],["A","C"],["C","D"]]));
  const x = Object.fromEntries(a.nodes.map(n => [n.id, n.x]));
  assert.ok(x.A < x.B && x.B < x.C && x.C < x.D);
  assert.deepEqual(a, layoutDiagram(flow("LR", ["A","B","C","D"], [["A","B"],["B","C"],["A","C"],["C","D"]])));
  const td = layoutDiagram(flow("TD", ["A","B"], [["A","B"]]));
  assert.ok(td.nodes[0].y < td.nodes[1].y && td.nodes[0].x === td.nodes[1].x);
});
test("cycles terminate and every node is placed", () => {
  const l = layoutDiagram(flow("LR", ["A","B","C"], [["A","B"],["B","A"],["B","C"]]));
  assert.equal(l.nodes.length, 3); assert.ok(l.width > 0 && l.height > 0);
});
test("groups bound their members and labels wrap", () => {
  const d = flow("LR", ["A","B","C"], [["A","B"],["B","C"]]); d.nodes[0].group = "G"; d.nodes[1].group = "G"; d.groups = [{ id: "G", label: "Group" }];
  d.nodes[2].label = "A very long component label that needs wrapping badly";
  const l = layoutDiagram(d); const g = l.groups[0]; const inside = l.nodes.filter(n => ["A","B"].includes(n.id));
  assert.ok(inside.every(n => n.x >= g.x && n.y >= g.y && n.x + n.w <= g.x + g.w && n.y + n.h <= g.y + g.h));
  assert.equal(l.nodes.find(n => n.id === "C")!.lines.length, 2); assert.ok(l.nodes.find(n => n.id === "C")!.lines[1].endsWith("…"));
});
test("sequence layout gives lanes and ordered message rows", () => {
  const l = layoutDiagram({ direction: "LR", nodes: [], edges: [], groups: [], sequence: { participants: [{ id: "A", label: "API" }, { id: "B", label: "B" }], messages: [{ from: "A", to: "B", text: "req", style: "solid" }, { from: "B", to: "A", text: "rep", style: "dashed" }] } });
  assert.equal(l.lanes?.length, 2); assert.equal(l.edges.length, 2); assert.ok(l.edges[0].points[0][1] < l.edges[1].points[0][1]);
});
```
  with a local helper `flow(direction, ids, pairs)` building a `Diagram`-shaped object with box nodes and solid edges.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `layoutDiagram`**. Break cycles by DFS back-edge reversal for layering only; layer = longest path from a source; order within layers by four barycenter sweeps (down, up, down, up) with ties by declaration order; place layers along the primary axis at `LAYER_GAP + NODE_W` (LR) or `LAYER_GAP + NODE_H` (TD), nodes along the secondary axis centered per layer with `NODE_GAP`; edges as four points (start at the node's trailing edge midpoint, two control points one third and two thirds across the gap, end at the leading edge midpoint); `labelAt` is the midpoint; groups expand to member bounds plus `GROUP_PAD` and push non-members out by shifting the group's layers' rows if overlap would occur. Sequence: lanes at `x = index * (NODE_W + LAYER_GAP)`, message `i` at `y = NODE_H + 36 * (i + 1)`, a self-message drawn as a short loop. Width and height include a 16-unit margin.
- [ ] **Step 4: Run** → PASS; typecheck; `npm run build -w @infinite/remote` succeeds.
- [ ] **Step 5: Commit** `feat(remote): deterministic layered layout for diagrams (INF-158)`.

### Task 5: Record team change index and task paths

**Files:**
- Modify: `packages/host/src/team-types.ts` (`TeamTask`, `TeamRun`)
- Modify: `packages/host/src/teams.ts` (result integration operation near the `diffStat` assignment; `diffStat` helper)
- Modify: `docs/teams.md` (one paragraph where task records are described)
- Test: `tests/teams.test.ts` (extend the test that asserts `taskA.diffStat?.docs`)

**Interfaces:**
- Produces on `TeamTask`: `changedPaths?: { paths: string[]; truncated: boolean }`. On `TeamRun`: `changes?: { headCommit: string; recordedAt: string; files: { path: string; status: "added" | "modified" | "removed" | "renamed"; added: number | null; removed: number | null }[]; truncated: boolean }`.
- Helper in `teams.ts`: `export function changeIndex(nameStatus: string | undefined, numstat: string | undefined, headCommit: string, at: string): TeamRun["changes"] | undefined` (parses `--name-status -z` where records are `STATUS\0path\0` and `R100\0old\0new\0`, and `--numstat -z`; returns `undefined` when `nameStatus` is undefined; bounds to 400 files with `truncated`).

- [ ] **Step 1: Extend the failing test**: after the existing `diffStat` assertions add
```ts
assert.deepEqual(run.changes?.files.map(f => [f.path, f.status]).sort(), [/* the fixture's paths with "added"/"modified" as the fixture writes them */]);
assert.equal(run.changes?.headCommit, run.headCommit); assert.equal(run.changes?.truncated, false);
assert.ok(taskA.changedPaths?.paths.length! > 0); assert.equal(taskA.changedPaths?.truncated, false);
```
  and add a unit test for `changeIndex` with a hand-built `-z` string containing `A`, `M`, `D`, and `R100` records and matching numstat rows, asserting statuses and counts, and `undefined` when `nameStatus` is undefined.
- [ ] **Step 2: Run** `node --import tsx --test tests/teams.test.ts` (the relevant test by name with `--test-name-pattern`) → FAIL.
- [ ] **Step 3: Implement.** In the integration `perform`, after the existing numstat command, run two more best-effort `teamCommand` calls with the same 30 s timeout and `.catch(() => undefined)`: `git diff --no-ext-diff --no-textconv --name-status --no-renames -z <run.baseCommit> <head> --` and `git diff --no-ext-diff --no-textconv --numstat --no-renames -z <run.baseCommit> <head> --` in `run.workspace`, plus `git diff --name-only --no-renames -z <member.baseCommit> <commit> --` for the task. In `complete`, set `run.changes = changeIndex(...)` when defined and `task.changedPaths` when defined. Never throw from these.
- [ ] **Step 4: Run** the tests → PASS. Run `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: Document** in `docs/teams.md` next to task fields: one paragraph naming `changes` and `changedPaths`, their bounds, and that a refused Git read leaves them absent.
- [ ] **Step 6: Commit** `feat(teams): record the run change index and task paths at integration (INF-158)`.

### Task 6: Persist brief diagrams on artifacts

**Files:**
- Modify: `packages/host/src/understanding.ts` (`briefSchema`, `persist`)
- Modify: `packages/host/src/repository-briefings.ts` only if `RepositoryBrief.brief.diagrams` is not already exposed (it is in the schema; verify the type reaches `RepositorySummary`)
- Test: `tests/understanding.test.ts` (the test "Understanding is a read-only scoped API and its source-bound brief survives API restart")

**Interfaces:**
- Consumes: `parseMermaid` (Task 3), `Diagram` (Task 1).
- Produces: `UnderstandingArtifact.brief.diagrams: Diagram[]` with `id = <artifactId>:<index>`, `kind` from the source (`system` | `change`), `basis: "model"`, `title`, `citations`, and either parsed content or `sourceText` + `parseError` + an empty graph. The zod `briefSchema` in `understanding.ts` gains `diagrams: z.array(diagramSchema).max(4).default([])` where `diagramSchema` is a strict zod shape of `Diagram` (nodes ≤ 48, edges ≤ 120, sourceText ≤ 3000).

- [ ] **Step 1: Extend the failing test**: find the briefing fixture that test uses (follow `startHost` config `repositoryBriefings.command`/`args` in that test) and add `diagrams: [{ title: "Request path", kind: "system", mermaid: "flowchart LR\n  API --> Policy", citations: [] }, { title: "Broken", kind: "change", mermaid: "flowchart LR\n  A --> B\n  style A fill:#f00", citations: [] }]` to its emitted `brief`. Assert after restart: `artifact.brief.diagrams.length === 2`, the first has `nodes.map(n => n.id)` equal to `["API", "Policy"]` and one edge, the second has `parseError` and `sourceText` and zero nodes.
- [ ] **Step 2: Run** that test by name → FAIL.
- [ ] **Step 3: Implement** in `persist`: map `summary.repository.brief.diagrams ?? []` through `parseMermaid`; include in the artifact; extend `briefSchema`. Keep `MAX_ARTIFACT_BYTES` unchanged.
- [ ] **Step 4: Run** → PASS; typecheck host.
- [ ] **Step 5: Commit** `feat(understanding): retain parsed brief diagrams with artifacts (INF-158)`.

### Task 7: Deterministic work brief assembly

**Files:**
- Create: `packages/host/src/understanding-work.ts`
- Test: `tests/understanding-work.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `parseMarkdown` (Task 2), `TeamRun.changes` and `TeamTask.changedPaths` (Task 5), `KnowledgeComponent`, `KnowledgeRelationship`, `RepoContext` (`understanding-runtime.ts`).
- Produces, all exported from `understanding-work.ts`:
```ts
export interface WorkSources { groups: UnderstandingSources["groups"]; missions: Pick<MissionService, "understandingRecords">; teams: Pick<TeamService, "understandingRecords">; goals: Pick<GoalService, "understandingRecords">; knowledge: { read(workspaceId: string): Pick<ReadKnowledge, "components" | "relationships"> & { contexts?: Record<string, RepoContext> } }; work: { workReferences(workspaceId: string): UnderstandingWork[] } }
export function classifyChanges(files: NonNullable<TeamRun["changes"]>["files"], repositoryId: string, components: KnowledgeComponent[], taskPaths: { taskId: string; paths: string[] }[]): ComponentChange[]
export function changeMap(changes: ComponentChange[], relationships: KnowledgeRelationship[], components: KnowledgeComponent[]): Diagram
export function assembleTeamBrief(input: { workspaceId: string; run: TeamRun; repositoryId: string; components: KnowledgeComponent[]; relationships: KnowledgeRelationship[]; mapObservedAt: string | null; narrative: NarrativeRecord | null; now: string }): WorkBrief
export class WorkBriefService { constructor(sources: WorkSources, narratives: { read(workspaceId: string, workId: string): NarrativeRecord | null }); get(workspaceId: string, workId: string): WorkBrief }
export interface NarrativeRecord { key: string; baseCommit: string | null; headCommit: string | null; generatedAt: string; engine: string; model: string; brief: UnderstandingBrief; diagrams: Diagram[] }
export function boundedWorkBrief(brief: WorkBrief): WorkBrief
```
  `WorkBriefService.get` throws `CatalogError(404, "This work is not available in this workspace.")` for unknown or partial-scope work. The narrative store is injected so this task has no file I/O.

- [ ] **Step 1: Write the failing tests** (pure, no host). Build a fixture `TeamRun` as the spec's "Test fixtures" bullet describes (three integrated tasks across `src/auth` and `src/billing`, `src/legacy` removed, two checks one failed, one decision, request Markdown with two H2 sections and nested lists, `changes.files` with statuses) and a component list with `paths` for `src/auth`, `src/billing`, `src/legacy`, plus one relationship `auth imports billing`. Assert:
  - `classifyChanges` returns `src/auth` modified, `src/billing` added (all files `added`, map lists only those files), `src/legacy` removed, and `docs/` as a folder entry with `componentId: null`; task ids grouped under the right component.
  - `changeMap` has nodes for the four units with `change` set, one edge `imports` between auth and billing, `basis: "source"`, and at most 24 nodes when 40 neighbor components are supplied.
  - `assembleTeamBrief(...).sections.map(s => s.kind)` equals `["overview","changes","diagram","tasks","checks","decisions","request","report","evidence"]` for the fixture, and equals `["overview","request","evidence"]` for a cancelled run with no tasks, checks, decisions, or changes (plus `report` when `reason` is set).
  - The overview `facts` include execution status verbatim and a tally `"1 added · 1 modified · 1 removed"`; the request section's first `rich` node is a heading of level 2.
  - A run with `diffStat` but no `changes` yields a `changes` section with a `note` "Changed paths were not recorded for this run." and no `components` block.
  - A `checks` block entry has `outputTail` of at most 2000 characters (tail) and `phase: "verify"` when `phase` is absent.
  - `boundedWorkBrief` on a brief whose request is 3 MiB keeps `overview` and `request` (truncated rich nodes) and adds a coverage line; result under `MAX_RESPONSE_BYTES`.
  - `WorkBriefService.get` with a mission record: `narrative.state === "unavailable"`, `tasks` block entries carry `workId: "team:<childId>"`, and `get("ws", "team:<unknown>")` throws status 404; a partial-scope item also 404s.
- [ ] **Step 2: Run** `node --import tsx --test tests/understanding-work.test.ts` → FAIL.
- [ ] **Step 3: Implement** per the spec's "Sections" table and "Component mapping" rules. Section ids are `<kind>` (unique per kind; `diagram` holds all diagram blocks). Overview summary precedence: narrative summary (basis `model`) → reported summary (basis `agent`) → first paragraph of the request (basis `owner`). `request` is `parseMarkdown(run.objective)` with basis `owner`. `report` includes `noChange.summary`, `deliveryReceipt.summary`, `pullRequest.summary`, `reason`, mission `result.summary`, goal `outcomes[]`, each dated. `delivery` uses `facts` basis `agent` and `links` for https URLs only. `evidence` has the citations gathered from narrative blocks, `facts` for `baseCommit`, `headCommit`, map observation, `generatedAt`, and `coverage` lines as `note` blocks. Missions: iterate `subtasks` and the subteams whose `missionId` matches; goals: iterate `cycles` and their runs by `activeTeamId`/cycle team ids. Coverage lines as the spec words them.
- [ ] **Step 4: Run** → PASS; typecheck host.
- [ ] **Step 5: Commit** `feat(understanding): assemble deterministic work briefs from recorded work (INF-158)`.

### Task 8: Narrative store, refresh, and writer adapter

**Files:**
- Create: `packages/host/src/understanding-work-narrative.ts`
- Modify: `packages/host/src/understanding-adapter.ts` (add `explainWork` to `UnderstandingAdapter` and `createUnderstandingAdapter`)
- Modify: `packages/host/src/understanding-runtime.ts` (export `runRepositoryContext` or a thin `collectContext(config, root, options)` wrapper)
- Create: `tests/fixtures/work-brief.mjs`
- Test: `tests/understanding-work-narrative.test.ts`

**Interfaces:**
- Consumes: `NarrativeRecord`, `WorkBriefService` (Task 7); `validateBrief`-style validation from `understanding-adapter.ts` (export it); `parseMermaid` (Task 3); `writeSealed`/`unseal` (`vault.ts`).
- Produces:
```ts
// understanding-adapter.ts
explainWork?(input: { root: string; baseCommit: string; question: string }, options: UnderstandingAdapterOptions): Promise<{ brief: UnderstandingBrief; diagrams: Diagram[]; engine: string; model: string; generatedAt: string }>
// understanding-work-narrative.ts
export class WorkNarrativeStore {
  constructor(options: { config: Config; key: Buffer; adapter: Pick<UnderstandingAdapter, "explainWork">; teams: Pick<TeamService, "understandingRecords" | "pendingOperation">; now?: () => Date });
  read(workspaceId: string, workId: string): NarrativeRecord | null;
  status(workspaceId: string, workId: string, run: TeamRun | null): WorkNarrativeStatus;
  refresh(workspaceId: string, workId: string, run: TeamRun | null, role: "owner" | "controller" | "viewer"): { narrative: WorkNarrativeStatus; queued: boolean };
  close(): Promise<void>;
}
```
  `TeamService.pendingOperation(runId): boolean` is added to `teams.ts` (returns `Boolean(stored.pending)`). Store directory `understanding/work-narratives`, one sealed file per workspace (`<workspaceId>.sealed`, scope `understanding-work-narrative`), holding `{ version: 1; day: string; jobs: number; records: Record<workId, NarrativeRecord>; failures: Record<workId, { at: string; reason: string }> }`, pruned to 64 records and 4 MiB. The question text is built by `workQuestion(run: TeamRun): string` (exported) and cut to 8000 bytes.

- [ ] **Step 1: Write the fixture** `tests/fixtures/work-brief.mjs`: a script that answers `context --repo <root>` with a minimal `RepoContext` JSON for the files in `<root>` (hash, lines) and `brief --repo <root> --base <sha> --format json --no-state --question <q>` with a Jevcode-shaped envelope (repo, head, base, generatedAt, fingerprint computed like `tests/fixtures/understanding-brief.mjs`, brief with `summary`, one `changes` claim citing `src/a.ts:1`, one review question, `diagrams: [{ title: "Change", kind: "change", mermaid: "flowchart LR\n  A --> B", citations: [] }]`, evidence `[]`, coverage `[]`). It appends one line per invocation to the file named by `WORK_BRIEF_CALLS` so tests can count writer runs.
- [ ] **Step 2: Write the failing tests** using a temp Git repo as the "integration workspace" (init, commit `src/a.ts`, note HEAD as `headCommit`, first commit as `baseCommit`), a `TeamRun` fixture pointing `workspace` at it with status `ready-for-review`, config `repositoryBriefings: { command: process.execPath, args: [fixturePath], automatic: false, intervalMs: 0, cooldownMs: 0, timeoutMs: 10000 }`:
  - viewer refresh → `{ narrative: { state: "unavailable", reason: /owner or controller/ }, queued: false }` and zero writer calls.
  - owner refresh → `queued: true`, `state: "pending"`; `waitFor` until `read()` returns a record with `brief.summary` and one parsed diagram; writer called exactly twice (context, brief).
  - second owner refresh → `state: "ready"`, `queued: false`, no new writer calls.
  - a run with status `implementing` → `unavailable` with reason /still active/; a run whose workspace HEAD differs from `headCommit` (commit once more) → /no longer checked out/.
  - after moving `headCommit` on the run fixture, `status()` → `stale`.
  - budget: with `now` fixed and `jobs` seeded to 48, refresh → `unavailable` /daily/; a failure (fixture told to exit 1 via `WORK_BRIEF_FAIL=1`) → `failed`, and an immediate refresh → `unavailable` /10 minutes/.
  - the store survives a new `WorkNarrativeStore` instance reading the same directory.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Implement.** `explainWork` runs `context` then `brief` with the configured `runner`/`model`/`--timeout` args as `synthesize` does, validates with the exported validator against the fresh context, parses diagrams. The store serializes jobs through one promise chain, writes `pending` state in memory only, seals on completion, and resets `jobs` when `day` changes (UTC date). `status` returns `ready` when `records[workId].key === sha256(workId, baseCommit, headCommit)`, `stale` when a record exists with another key, `pending` while queued, `failed` within the cooldown, else `unavailable` with the applicable reason (no writer → "No summary writer is configured on this host"; not a team → "Narratives cover team runs; open a subteam.").
- [ ] **Step 5: Run** → PASS; typecheck host.
- [ ] **Step 6: Commit** `feat(understanding): explicit, budgeted model narratives for work briefs (INF-158)`.

### Task 9: Routes and host wiring

**Files:**
- Modify: `packages/host/src/server.ts` (construct `WorkBriefService` and `WorkNarrativeStore`, two routes, close on shutdown, error mapping)
- Modify: `packages/host/src/understanding-runtime.ts` (expose stored `RepoContext` per repository in `read()` as `contexts` or add `contextFor(workspaceId, repositoryId): RepoContext | null`)
- Test: `tests/understanding-work-api.test.ts`

**Interfaces:**
- Consumes: Tasks 7 and 8.
- Produces: `GET /api/project-groups/:id/understanding/work/:workId` → `WorkBrief` (200) or `{ code: "understanding-work", error }` (404); `POST …/work/:workId/refresh` with body `{}` → 202 `{ narrative }` when queued, 200 otherwise; 403 for viewer on POST. `workId` validated by `z.string().regex(/^(team|mission|goal):[0-9a-f-]{36}$/)`.

- [ ] **Step 1: Write the failing API tests** with `startHost` (timeout 60000): seed a cancelled goal via the `retainGoal` helper pattern in `tests/understanding.test.ts` with an objective `"## Scope\n\n* one\n* two"`; `GET` as viewer → 200 with `sections[0].kind === "overview"`, a `request` section whose first rich node is a level-2 heading, `narrative.state === "unavailable"`; `GET …/work/team:<random uuid>` → 404 `code: "understanding-work"`; `POST …/refresh` as viewer → 403, as owner for the goal → 200 with `narrative.state === "unavailable"`; malformed `workId` → 400.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the wiring next to the existing understanding routes; map `CatalogError` as today. Add `workNarratives.close()` to the close list.
- [ ] **Step 4: Run** → PASS; `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: Commit** `feat(host): work brief routes (INF-158)`.

### Task 10: Phone rich text and block renderers

**Files:**
- Create: `apps/mobile/src/features/understanding/blocks/RichText.tsx`, `Facts.tsx`, `Components.tsx`, `Tasks.tsx`, `Checks.tsx`, `Decisions.tsx`, `Questions.tsx`, `Links.tsx`, `Citations.tsx`, `Note.tsx`, `BasisLabel.tsx`, `index.tsx` (exports `BlockView({ block, onOpenComponent, onOpenWork })`)
- Create: `apps/mobile/src/features/understanding/blocks/styles.ts` (shared `StyleSheet` using `theme`)

**Interfaces:**
- Consumes: Task 1 types via `@infinite/remote`; `theme`, `Chip`, `Button`, `Glyph`.
- Produces: `BlockView({ block: WorkBlock; onOpenComponent?: (componentId: string) => void; onOpenWork?: (workId: string) => void })` and `RichText({ nodes: RichNode[]; basis?: Basis; compact?: boolean })`.

- [ ] **Step 1: Implement `RichText`**: headings at 20/17/15/14 pt (600 weight), paragraphs at 15/24, lists as rows with a 20 pt marker column (`•` or `n.`), nested lists indented 16 pt, code in a `theme.colors.screenSurface` panel with `theme.mono`, horizontal `ScrollView`, selectable; quotes with a 3 pt `fieldRule` left bar; rules as hairlines; inline bold/italic/code via nested `Text`; links open through a `safeOpen(url)` helper (https only) and are underlined in `forest`.
- [ ] **Step 2: Implement the other block views** per the spec's "Block renderers" paragraph. `Components`: change pill colors added = `forest` text on `secondarySurface`, modified = `warningInk` on `warningSurface`, removed = `error` text with a strikethrough name; expand shows files with `+n −m`; "Open component" when `componentId`. `Checks`: output tail in a `terminalSurface` panel with `terminalInk` mono text. `BasisLabel` maps `source → "Source"`, `agent → "Agent report"`, `owner → "Owner"`, `model → "Model"`, `host → "Host"`.
- [ ] **Step 3: Verify** `npx tsc --noEmit` and `npm run lint -w @infinite/mobile` pass.
- [ ] **Step 4: Commit** `feat(mobile): rich text and work brief block renderers (INF-158)`.

### Task 11: Phone diagram view

**Files:**
- Create: `apps/mobile/src/features/understanding/diagram/DiagramView.tsx`, `diagram/shapes.tsx` (node shape paths and arrowhead), `diagram/useCanvasGestures.ts`

**Interfaces:**
- Consumes: `layoutDiagram`, `DiagramLayout`, `Diagram` from `@infinite/remote`.
- Produces: `DiagramView({ diagram: Diagram; height?: number; onOpenComponent?: (componentId: string) => void })`; `useCanvasGestures({ contentWidth, contentHeight, frameWidth, frameHeight }): { panHandlers; transform: Animated.AnimatedProps<ViewStyle>["transform"]; reset(): void }`.

- [ ] **Step 1: Implement `useCanvasGestures`** with one `PanResponder`: one touch pans (`translate` += delta), two touches scale around the pinch midpoint with `scale` clamped to `[0.5, 3]`; initial scale = `min(1, frameWidth / contentWidth)`; `reset()` recenters. Use `Animated.Value`s and `Animated.View`.
- [ ] **Step 2: Implement `DiagramView`**: frame 260 pt (prop), `Svg` sized to the layout inside the animated view; groups as dashed `Rect` with a title; nodes via `shapes.tsx` (`box` rounded rect r=8, `round` r=22, `diamond` path, `cylinder` rect + two ellipses, `pill` capsule), fills per the spec's change colors, labels as two `Text` lines centered, 12 pt; edges as `Path` cubic through the four points with `markerEnd` arrowhead, `dashed` as `strokeDasharray="6 4"`, `thick` as width 2.5; edge labels on a `paper` pill at `labelAt`; sequence diagrams: lanes as vertical hairlines with participant boxes on top, messages as horizontal arrows with numbered labels. Selection via `onPress` on node groups: dim others to opacity 0.35, show a detail strip below the frame (label, change, path from `componentId` lookup is not available here, so show `label` and `change`, plus "Open component" when `componentId`), tap on the background `Rect` clears. Buttons: "Fit" (reset) and "Expand" (opens a `Modal` with the same view at full height). Accessibility label per the spec.
- [ ] **Step 3: Verify** typecheck and lint.
- [ ] **Step 4: Commit** `feat(mobile): native interactive diagram view (INF-158)`.

### Task 12: Phone work brief screen and wiring

**Files:**
- Create: `apps/mobile/src/app/understanding/work.tsx` (route; params `workspace`, `work`, `machine`)
- Create: `apps/mobile/src/features/understanding/WorkBriefScreen.tsx`, `useWorkBrief.ts`
- Modify: `apps/mobile/src/features/understanding/UnderstandingWorkspace.tsx` (`WorkCard` pushes the route; remove the expansion; `RepositoryCard` renders `brief.diagrams` and summary/claims through `RichText`)

**Interfaces:**
- Consumes: Tasks 10 and 11; `usePoll`, `api`, `ApiError`, `connectionKey`; `Me` role from `/me`.
- Produces: `useWorkBrief(connection, workspaceId, workId): { brief: WorkBrief | null; poll: ReturnType<typeof usePoll>; requestRefresh(): Promise<void>; refreshState: "idle" | "sent" | "denied" }`.

- [ ] **Step 1: Implement `useWorkBrief`**: `usePoll` over `GET …/understanding/work/<encoded workId>` every 5 s; on first ready result, if `narrative.state` is not `ready`/`pending` and role is owner or controller, `POST …/refresh` once (`requestRefresh`), swallowing 403 as `denied`.
- [ ] **Step 2: Implement `WorkBriefScreen`**: `TopBar` (back to the workspace, title), `LiveStatus`, section rail (horizontal `ScrollView` of `Chip`s with `selected`), narrative status line per the spec, body `ScrollView` with one card per section (`Section` title + `BlockView`s), `onLayout` per section to record y-offsets, `scrollTo` on chip tap, selected chip follows `onScroll` (throttle 100 ms). `onOpenComponent` navigates to the workspace route with `view=system` and the component id (add a `component` search param that `UnderstandingWorkspace` reads once to select the component); `onOpenWork` pushes the same work route for the child id. Loading, 404 ("This work is no longer available."), and offline states mirror `UnderstandingWorkspace`.
- [ ] **Step 3: Wire `WorkCard`**: row shows title, `kindLabel · status · updated`, repository chips; `onPress` → `router.push({ pathname: "/understanding/work", params: { workspace: workspaceId, work: item.id, machine: connectionKey(connection) } })`. Delete the expanded block, `LabeledText`, and the association rendering it owned; keep partial-scope notice.
- [ ] **Step 4: System view**: in `RepositoryCard` render `artifact.brief.summary` through `RichText` and `artifact.brief.diagrams?.map(d => <DiagramView diagram={d} />)` under the summary; a diagram with `parseError` renders its `sourceText` in a code panel with the error as a note.
- [ ] **Step 5: Verify** `npx tsc --noEmit` and `npm run lint -w @infinite/mobile` in `apps/mobile`.
- [ ] **Step 6: Commit** `feat(mobile): work brief screen with section rail and diagrams (INF-158)`.

### Task 13: Docs

**Files:**
- Modify: `docs/repository-briefings.md` (new subsection "Work briefs" after "Workspace Understanding")
- Modify: `docs/teams.md` (if Task 5 did not already add the paragraph)

- [ ] **Step 1: Write the subsection**: what a work brief is, the two routes and roles, section kinds and when they appear, basis labels, the narrative states and the 48-per-day budget and cooldown, the settled-run rule, bounds, and that reading never schedules a writer.
- [ ] **Step 2: Scan the diff** with the AGENTS.md private-information grep; resolve hits.
- [ ] **Step 3: Commit** `docs: describe work briefs (INF-158)`.

### Task 14: Integration verification

- [ ] **Step 1:** `npm run check` from the worktree root → all pass (rerun a flaky suite alone before blaming a change; see the memory on full-check flakes).
- [ ] **Step 2:** `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` in `apps/mobile`.
- [ ] **Step 3:** Phone screenshot against a scratch host seeded with the Task 7 fixture run (the phone-simulator-screenshots memory describes the scratch host and `idb` flow): rail, overview, change map with a selected node, request as headings and lists. Save under the scratchpad, not the repository.
- [ ] **Step 4:** Private-information grep over `git diff origin/main` → only documented placeholders.
