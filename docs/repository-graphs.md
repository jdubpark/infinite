# Repository graph checkpoints

Repository graph checkpoints are an opt-in, code-only aid for navigating enrolled project checkouts. They use the configured Graphify builder and never upload source, fetch a repository, authorize a provider action, expand an assignment, or approve work. Graph output is advisory; agents and reviewers must inspect source files for claims that affect a decision.

## Configuration

Add `repositoryGraphs` to host configuration to enable the feature:

```json
{
  "repositoryGraphs": {
    "command": "/usr/bin/python3",
    "args": ["/opt/infinite/scripts/repository_graph.py"],
    "graphifyCommand": "/usr/local/bin/graphify",
    "cacheDir": "/var/lib/infinite/repository-graphs",
    "projectIds": ["example-project"],
    "timeoutMs": 300000,
    "debounceMs": 750,
    "intervalMs": 86400000
  }
}
```

`command` and `args` are an administrator supplied command prefix. The host appends `--repo`, `--cache-dir`, `--ref`, `--graphify`, `--timeout-seconds`, and `--max-workers` to the configured arguments. Feature lanes also receive `--seed-cache-dir` pointing at their project's shared lane. `projectIds` optionally limits initial and daily reconciliation to a subset of configured project IDs; when omitted, all enrolled projects and GitHub source projects are eligible. No `repositoryGraphs` setting means no graph process, timer, or graph prompt material.

The builder must print one JSON receipt with status `ready`, `unchanged`, `failed`, or `busy`, and exit zero only for `ready` or `unchanged`. A usable receipt identifies both the requested head and the successful graph path for that same head. The host treats malformed output, nonzero exit, timeout, and a mismatched head as advisory failure.

## Checkpoints and lanes

- Before a code-consuming team member starts, the host requests a graph for the exact commit used to prepare that member's isolated checkout. Permission coordinators are excluded. The graph step runs in the asynchronous member preparation operation, outside the team service's serialized mutation queue.
- New and resumed native or cmux project sessions schedule a shared-lane refresh in the background; this does not change their prompts or wait on the graph builder. Code-consuming team members still receive the exact-head checkpoint described above. Standalone sessions therefore get refreshed shared status without an added launch delay.
- Each team run has a private cache lane shared across its member checkouts. The integration checkout is requested at its pinned head, so review reuses that run lane when the head matches. A lane's cache identity includes the configured project root, project ID, and authorized team workspace root; its run identifier separates it from shared project history.
- A project source change triggers a shared-lane refresh only after ProjectSourceService reports an applied head. A completed post-merge refresh also checkpoints the actual project checkout HEAD. The graph service does not trust a claimed merge hash as the project checkout head.
- Startup reconciliation and a bounded daily timer refresh configured enrolled roots from their current local HEAD. This fallback does not poll a provider or fetch source.

Nearby requests coalesce by project-root authority and lane. A newer head arriving during a build remains queued for its own receipt; an older build cannot satisfy its waiter. The scheduler bounds global and per-project concurrency, and lifecycle shutdown clears timers, resolves queued requests as unavailable, and terminates active builder process groups. A failed refresh never blocks team preparation, review, source refresh, or permissions.

The last-good graph remains under the cache directory assigned to the configured builder identity. A member prompt includes a graph path only when its receipt head equals the member's prepared commit; otherwise it marks the graph unavailable or stale and directs the member to inspect source directly.

Owners can read the bounded in-memory receipts at `GET /api/projects/:id/graph`. The response includes an enabled flag and receipts with lane, requested and successful heads, status, graph path, and refresh counts; receipts omit the source checkout path. The endpoint reports disabled when graph refresh is not configured or the project is outside the configured project filter.

## Code map

Each `ready` and `unchanged` builder receipt can carry a `map`. The builder reduces the graph file to directories, so the API process never opens a graph file. The map has three keys: `areas`, `links`, and `truncated`.

- An area is a source file's directory, cut to the deepest depth that keeps at most 120 areas. The root directory is `.`. If even depth 1 has more than 120 areas, the 119 areas with the most symbols are kept and the rest fold into `other`.
- Each area reports `files` (distinct source files) and `symbols` (graph nodes). External nodes and nodes without a relative `source_file` are skipped.
- A link counts the graph edges whose ends fall in two different areas. Links are undirected, and the 400 heaviest are kept.
- A map whose compact JSON exceeds 262144 bytes is dropped, and the receipt carries `mapStatus: "too-large"` instead.
- A missing, unreadable, or malformed graph file produces no map. The receipt is otherwise unchanged.
- The host parses the map with a strict schema. A map with unknown keys, more than 120 areas, more than 400 links, IDs that are longer than 300 characters or are not relative paths, or non-integer counts is dropped, and the receipt is kept. A directory name longer than 300 characters therefore drops the whole map.
- The host checks the serialized size itself: a map over 262144 bytes is dropped and reported as `too-large`, whatever the builder says.
- `status()` omits the map. The owner receipt endpoint stays small.

Two host lookups read the map from memory:

- `codeMap(projectId, lane)` returns the last authorized receipt of that lane that carried a map or reported `too-large`. A later failed or busy refresh does not clear it. A run lane with no such receipt falls back to the shared lane, and the response's `lane` names the lane used. The result is `disabled` for a project outside the graph filter, `unavailable` with `none-built`, or `unavailable` with `too-large`.
- `areas(projectId)` returns the shared-lane area IDs, or `undefined` when the shared lane has no usable map.

The HTTP endpoint is `GET /api/projects/:id/graph/map?lane=`. Its `lane` is `shared` (the default) or `run-<team id>`. Every paired role may read it, and it is admitted over the relay. It answers `disabled` when repository graphs are not configured. The web client's [Swarm view](swarm.md) reads the shared lane. Maps are kept in memory only: after a host restart the shared lane returns with startup reconciliation, and a run lane returns when one of its members next launches.
