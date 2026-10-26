# System tab that explains the workspace by itself

Date: 2026-10-25. Status: implemented on the phone; desktop and web follow.

## Intent

The owner opens a workspace on the phone, taps **System**, and expects to
learn what the workspace is, how it is built, what the agents changed
recently, how changes reach production, and whether the explanation itself is
fresh. Today the tab shows empty sections and coverage sentences such as
"Planned requests: 0 of 10 included; 10 omitted from this response to fit its
byte limit" and "retained snapshots remain source-labeled". The owner cannot
act on any of it.

This design makes the System tab fill itself for every enrolled workspace,
without owner data entry, with summaries, diagrams, and plain language, and
removes the response trimming that hides records.

## Why the tab is empty today (observed in code and on the live host)

1. **Maintenance is off by default.** The workspace policy ships with
   `enabled: false, synthesis: false, delivery: false`
   (`docs/repository-briefings.md`, "Host maintenance"). Nothing ever observes
   the repositories, so components, relationships, delivery, and generated
   briefs stay at zero. The owner was never asked to turn it on and the UI
   only says "Refresh sources to request a new observation".
2. **Team briefs are retained for some workspaces and silently lost for
   others.** The per-session briefing runtime
   (`packages/host/src/repository-briefings.ts`) briefs each session and the
   retention gate in `packages/host/src/understanding.ts` (`capture` and
   `persist`) stores the result as a workspace artifact. On the live host this
   works for the single-repository workspaces (18 and 36 team artifacts) and
   yields zero artifacts for the two-repository workspace, although the
   engine's own state holds 26 complete member briefs for those repositories
   (system shape, Mermaid diagrams, review questions, guidance). Every error on
   that path is replaced by a generic message and the engine's stderr is
   discarded, so the reason is not recoverable from logs. The repository row
   shows "failed" with no cause.
3. **Workspace maintenance fails without a reason too.** Where maintenance was
   enabled, its state is `failed` with "Maintenance failed or its source
   changed" and nothing else; the deterministic `context --repo` step runs
   fine on the same checkout in about one second, so the failure is in the
   binding checks or synthesis, and nobody can tell which.
4. **Diagrams are dropped.** The brief schema carries up to two Mermaid
   diagrams, but `packages/host/src/understanding.ts` persists only the text
   sections, and no client renders a diagram.
5. **Fixed-fraction response budgets hide records.** `boundedResponse` splits
   the 4 MiB relay frame limit into fractions: planned requests get 1/16 of a
   1.25 MiB budget (80 KiB) shared across all repositories, first come first
   served. A planned request is the full team prompt (10 to 23 KB each), so
   the first repository consumes the budget and the second shows "0 of 11
   included". The live overview for the affected workspace is 300 KB in
   total, well under the frame limit.
6. **Projects, features, and plans are owner-typed records.** Nothing creates
   them from the work the agents already did, so "Projects · 0" is the normal
   state.
7. **Copy was written to satisfy the honesty rules, not to be read.** Phrases
   like "retained source snapshot", "source-labeled", and "Difference" carry
   no meaning for the owner.

## Goals

- Every workspace with at least one enrolled repository has a filled System
  tab within one maintenance cycle of enrollment, and it stays current as
  work lands. No owner data entry is required for the default content.
- The tab answers, in this order: what this workspace is; how it is built
  (architecture with a diagram); what changed recently and which work caused
  it; what is planned and how it differs from what exists; how changes are
  delivered; how this explanation is maintained (when it last ran, what it
  will do next, why it failed if it failed).
- Diagrams are rendered natively on the phone, desktop, and web, and are
  regenerated when the source changes.
- Responses are never trimmed by fixed fractions. The overview is small by
  construction and every list pages.
- Every generated claim still states its evidence: the commit it describes,
  when it was observed, and that it is not a deployment or completion claim.
  This is shown as a short label on each card, not as paragraphs of caveats.

## Non-goals

- Changing the honesty rules in `PRODUCT.md`. Generated text never marks
  work complete, approves a permission, or claims a deployment.
- Replacing the briefing engine. Jevcode remains the engine; the design adds
  inputs and surfaces outputs.
- Behavior statecharts (PR #70). They stay as they are and keep their panel.
- Web and desktop parity in the first release. The phone ships first; the
  desktop and web clients follow the same data contract in a second slice.

## Anti-goals

- A tab that looks full but is wrong. Generated content must cite the commit
  and time it describes, and stale content must say so in one line.
- Unbounded model spend. Synthesis runs only when a source fingerprint changed
  and stays under the existing daily job limit per workspace.
- Another hand-maintained backlog. Generated plans come from the work records
  and trackers that already exist.

## Constraints

- Relay frames are limited to 4 MiB by the remote protocol; this is a
  transport invariant and stays. The design makes it unreachable by paging
  rather than by trimming.
- Catalog storage per workspace stays encrypted and bounded (2 MiB catalog,
  8 MiB maintenance store). Diagram sources count toward those budgets.
- The host must not write to external trackers.
- Nothing private (hostnames, paths, account names) enters tracked files.

## Design

### 1. Maintenance on by default

- New workspaces get policy `enabled: true, synthesis: true`, and
  `delivery: true` when the repository has a GitHub source with usable `gh`
  credentials.
- The policy record gains `editedAt` and `editedBy` (owner request id), so
  future explicit edits are distinguishable from defaults. Today's stored
  policies have no such mark, and an explicit disable is identical to the
  default, so the one-time migration at host start enables every existing
  workspace and records the migration as the policy's first edit. The owner
  decided this on 2026-10-25 (see "Decided by the owner"); the Maintenance
  section shows the toggle so any workspace can be turned off again in one
  tap.
- Refresh triggers, in addition to the interval: a GitHub mirror refresh that
  moves the tracked branch head; a team or mission run reaching merged,
  delivered, or cancelled; an owner "Refresh now" tap. Triggers coalesce
  through the existing queue.
- The daily job limit stays at 24 per workspace. When it is reached the
  Maintenance section says "Daily refresh limit reached (24). Resumes at
  00:00 UTC." rather than a coverage sentence.

### 2. Make failures visible, then make briefs reach every workspace

- Failure visibility comes first, because it is the only way to find the
  remaining gates. Both runtimes (session briefing and workspace maintenance)
  keep the thrown error's name and the engine's last stderr line (bounded to
  400 characters, passed through the existing redaction helper) with the
  attempt time in their encrypted state, log one structured line per failed
  attempt to the host log, and expose the reason to owners. Maintenance shows
  "Last attempt failed at <time>: <reason>. Next attempt at <time>." The
  generic message is the fallback only when no reason exists.
- The workspace "Current" brief is generated by maintenance from the project
  checkout at the tracked branch head (the checkout the host already keeps
  in sync with GitHub). It is a maintenance job and counts toward the daily
  limit. The writer is the configured briefing wrapper; when no writer is
  configured, the Maintenance section says "No summary writer is configured
  on this host" and the deterministic source map and component diagram are
  still produced.
- Comparison base for "What changed": the commit of the previous successful
  observation for that repository, stored as a watermark. The first
  observation has no changes section and says so.
- Team member briefs stay on the existing retention path. The retention gate
  is repaired once its reason is visible (the live host shows it rejecting
  every brief for one workspace); the fix is whatever that reason requires,
  not a parallel ingestion path. Member artifacts are shown under their run
  in "What changed", labeled with the member's branch and commit. The
  tracked-head brief remains the canonical "Current" explanation.

### 3. Diagrams as data, rendered by the clients

- The engine is instructed (prompt addition in the briefing adapter) to emit
  flowchart diagrams in a restricted Mermaid subset: `flowchart` direction,
  nodes with labels, `subgraph` groups, and `-->` edges with optional labels.
- The host parses that subset into a graph document
  `{ id, title, direction, nodes: [{ id, label, group? }], groups: [{ id, label }], edges: [{ from, to, label? }], source: "mermaid", sourceText }`
  and stores it with the artifact and with the component map. Unparseable
  diagrams keep `sourceText` and a `parseError`; clients show the text.
- A second, deterministic diagram is built from the component relationship
  graph the host already computes (component nodes, import edges), so every
  workspace with a source map has at least one diagram even before synthesis.
- Rendering: the phone uses `react-native-svg` (already a dependency) with a
  small layered layout (longest-path layering, barycenter ordering, fixed
  node boxes, orthogonal or straight edges). The same layout function lives
  in `packages/remote` so the web client and the desktop (via a tiny JSON
  layout exchange or a Swift port of the same algorithm) draw identical
  pictures. Diagrams are pinch-zoomable on the phone and support tapping a
  node that maps to a component to open that component.
- Diagrams carry the commit and observation time of the artifact they came
  from. When a newer artifact exists, the diagram is replaced; the older one
  remains in the artifact history.
- Node to component mapping: the engine prompt asks for node ids equal to
  component ids where a node describes a component. The host validates ids
  against the component index, then matches remaining node labels to
  component names case-insensitively, and leaves everything else as a plain
  node. Only validated nodes are tappable.
- Large maps: the deterministic component diagram groups components by their
  top-level directory. Above 40 visible nodes the renderer shows groups
  collapsed with a node count; tapping a group expands it in place. Nothing
  is dropped from the data; the graph document carries every node and group.

### 4. Overview without trimming

- `GET …/understanding` returns a small document: workspace identity, the
  current summary paragraph per repository, counts, freshness, maintenance
  status, the component index (ids, names, one-line purpose), and the list of
  diagram ids. Full text lives behind paged endpoints:
  - `GET …/understanding/briefs?repository=ID&cursor=` (artifact history,
    newest first, full sections and diagrams per artifact)
  - `GET …/understanding/work?cursor=` (work records; already exist in the
    Work tab's data)
  - `GET …/understanding/planned?repository=ID&cursor=` (planned requests,
    returning title, status, first 600 characters, and a link to the full
    work record)
  - `GET …/understanding/diagrams/:id`
- The new endpoints build each page to a page size (default 50 records or
  512 KiB, whichever first) and return a `next` cursor. No page reports
  omission; everything is reachable by paging.
- Compatibility: the overview keeps its `schemaVersion: 1` shape and fields
  until the desktop and web slices ship, because the macOS app and the web
  client read that contract. Two changes make the v1 overview stop trimming
  in practice: planned requests carry title, status, and a 600-character
  excerpt instead of the full prompt, and `boundedResponse` uses the whole
  frame budget first-come instead of fixed fractions, so a response trims
  only when the workspace really exceeds 4 MiB. The phone switches to the
  paged endpoints. When desktop and web have switched, the v1 trimming code
  is deleted and `schemaVersion` becomes 2. The CLI's `understand` commands
  follow cursors and print complete output.

### 5. Plans and projects filled from work

- The catalog keeps owner-typed projects, features, and plans with their
  current semantics (feature status is an owner assessment).
- The host adds generated entries with `basis: "work"`: one plan per team,
  mission, or goal request (title, objective, repositories, status copied from
  the run, links to the run and tracker issue), and one project per tracker
  project or per repository group when no tracker binding exists. They are
  shown in "Plans & projects" under the headings "From work" and "Owner
  records". Generated entries are read-only; "Promote to owner record" copies
  one into an editable owner record.
- Generated entries are derived at read time from the work records and are
  not stored in the owner catalog, so they never change the catalog revision
  and never invalidate a synthesis run (`plan-revisions-changed-during-
  synthesis`). They attach to no component until promoted.
- "Planned vs current" needs no extra model call. Owner plans attached to a
  component keep the existing comparison produced during that component's
  synthesis. Generated plans show "Not compared; promote this plan to an
  owner record to compare it", and finished runs show their outcome from the
  run record (merged, delivered, cancelled). The host never marks a plan
  accepted.

### 6. Delivery and maintenance sections

- Delivery describes, from observation, how a change reaches users: tracked
  branch, open pull requests with check status, release or deployment records
  the provider exposes, and the repository's own checks (`npm run check` or
  the enrolled check commands). When nothing is observable it says "No
  delivery observations yet" and names what would make them available (a
  GitHub source, deployment read permission).
- Maintenance shows: last successful observation (time and commit), last
  synthesis, next scheduled attempt, jobs used today, what triggers a refresh,
  what is stale and why, the last failure with its reason, and the policy
  toggles. This section is the single place for operational caveats.

### 7. Copy

Every sentence on the System tab is rewritten for an owner who has not read
the architecture docs. Rules:

- Lead with the fact, then the evidence label, e.g. "Backend: a NestJS API
  with a PostgreSQL store and a jobs worker. From commit a1b2c3d, observed
  2 hours ago."
- Replace "retained source snapshot" with "the code as of <commit>",
  "Planned contains recorded requests only" with "what the agents were asked
  to build", "Difference" with "Planned vs current", and "source-labeled"
  with the commit label itself.
- One honesty line per tab, at the bottom: "Generated from the code and the
  work records. It does not mean anything is deployed or approved."
- No sentence mentions bytes, budgets, or omission.

### 8. Phone layout (first slice)

Sections in order on the System tab, each a card with a title, body, and a
small gray evidence label:

1. **What this workspace is**: two to four sentences from the latest brief's
   summary across its repositories; repository chips underneath.
2. **Architecture**: the diagram (zoomable), then the architecture claims as
   short paragraphs, each tappable to its component.
3. **Components**: list with one-line purpose and relationship count; the
   deterministic component map diagram is here when it differs from the
   architecture diagram.
4. **What changed**: newest first, each entry from a brief's changes section
   linked to the work record that produced it.
5. **Plans & projects**: From work, then Owner records; each plan shows
   "Planned vs current".
6. **Delivery**.
7. **Maintenance**.

Empty states name the next concrete event ("First observation is queued and
usually takes a few minutes") instead of a policy explanation.

## Decisions the owner made

- No byte limit as a user-facing concept; the tab must never hide records.
- Summaries, diagrams, and graphics are required, updated as work happens.
- The tab must cover plans and projects, components, delivery, features,
  architecture and its latest changes, and maintenance criteria.

## Decided by the owner on 2026-10-25

1. Enable maintenance on every existing workspace in one migration, even
   though an explicit earlier disable cannot be told apart from the default.
   Yes, with the per-workspace toggle in Maintenance.
2. Model spend: one synthesis run per changed component per refresh, through
   the configured summary writer, capped at 24 jobs per workspace per day.
   Yes, with the cap kept.

## Calls made in this document (owner may overrule)

- Failure reasons are retained and shown before any other repair, because
  the live host cannot explain its own failures today.
- The canonical "Current" brief comes from the project checkout at the
  tracked head, produced by maintenance; member briefs stay on the retention
  path and appear under their runs.
- Diagrams are rendered natively from a parsed graph document, not as
  server-rendered images, so they theme, zoom, and link to components.
- Generated plans and projects are read-only "From work" entries derived at
  read time, beside owner records, never stored in the catalog.
- The v1 overview contract stays until desktop and web switch; the phone
  moves to paged endpoints first.
- The phone ships first; desktop and web share the contract in a second
  slice.

## Left to the builder

- Exact layout algorithm and node sizing; any reasonable layered layout is
  acceptable if diagrams with up to 40 visible nodes stay legible on a phone.
- Page sizes and cursor encoding.
- Migration details for existing encrypted runtime and catalog records,
  including the policy `editedAt` field.
- Prompt wording for the diagram subset and the component id convention.
- Which existing redaction helper bounds the retained error line.

## Verification

- Host: unit tests for the Mermaid subset parser, the paging endpoints, the
  policy default migration, the tracked-head brief run (with the sample
  briefing fixture), the changes watermark, and failure-reason retention.
  Regression tests: a workspace with 13 and 11 planned requests returns all of
  them across pages; a failing engine leaves its reason readable by the owner.
- Phone: lint and typecheck; a screenshot of the System tab for a real
  workspace with a diagram, taken on the simulator with the rehearsal host.
- Live: after deployment, the affected workspace's System tab fills within
  one maintenance cycle; the Maintenance section shows the run and its
  commit.
