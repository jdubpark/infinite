# GitHub-tracked project sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrolled GitHub repositories stay current on the host by themselves: a per-project mirror fetched from GitHub, team runs based on it, PR delivery, and status everywhere.

**Architecture:** A new `ProjectSourceService` owns a bare mirror per `github` project and a refresh state machine (fetch, fast-forward, save-edits, diverged). Teams clone the mirror instead of the project directory; the server exposes refresh and status and refuses laptop sync for `github` projects; the CLI records the mode at `repo init` and prints comparisons; the apps show the source line. The GitHub App refresh script enumerates installed repositories.

**Tech Stack:** TypeScript (Node 22, ESM), zod, express, `node:test` via `node --import tsx --test FILE`, React (web), React Native/Expo (phone), plain `.mjs` scripts for the GitHub App.

**Spec:** `docs/superpowers/specs/2026-10-20-github-source-tracking-design.md`

## Global Constraints

- No private information in any tracked file: no real repository names, handles, hostnames, laptop paths. Use `OWNER/REPO`, `/home/dev/...`, `example` project IDs.
- Every Git command the host runs against GitHub, a project working tree, or a mirror goes through `teamCommand(..., prefix)` with `teamGitArgs`, as `team-workspace.ts` does today. Never `execFileSync("git", ...)` from host code against those trees.
- Fixed messages only: no error text, URL, path, or token in a status `message`.
- Fast-forward only; never `reset --hard`, `checkout -- .`, `clean`, or `stash` in a project working tree.
- Working-tree step runs only when no cloud session runs in the project directory. Teams, goals, blocked runs, and handoffs do not hold it.
- Tests start no server unless they already do in the file being extended; new host tests use local bare repositories as the fake GitHub remote (a filesystem path is a valid `remoteUrl` for tests).
- Run focused tests with `node --import tsx --test tests/FILE.test.ts`; typecheck with `npm run typecheck -w @infinite/host` (or the workspace touched). The coordinator runs `npm run check` once at the end.
- Status strings in the CLI and apps follow the shapes in the spec's "What the owner sees".
- One writer per file. Workers do not edit files outside their task's owned paths.

## Review Focus

1. A `github` project whose working tree is on a branch (legacy laptop-mode snapshot) with commits not on the base: refresh must record `diverged` and leave the tree alone (Task 2 test "diverged").
2. A session starts in the project directory between the fetch step and the working-tree step: the working-tree step must skip with `session-running`, not race (Task 2 test "running check re-evaluated before the apply step").
3. `repo init` on a repository whose `origin` is a github.com URL with a token embedded: must fall back to `laptop` mode without printing the URL (Task 5 test "credentialed origin").
4. A team run for a `github` project whose fetch fails on the very first refresh (mirror empty): run must block with a clear `source-unavailable` error, not start from nothing (Task 3 test "first fetch failed").
5. Laptop sync `--apply --force` against a `github` project: must be refused with `409 source-github` so it cannot overwrite the mirror-tracked tree (Task 4 test).

---

### Task 1: Shared contracts (coordinator, lands first)

**Files:**
- Modify: `packages/host/src/team-types.ts` (delivery schema, report union, `TeamRun` fields)
- Modify: `packages/host/src/types.ts` (`Project.source`, `Config.source`)
- Modify: `packages/host/src/config.ts:28-34` (config schema)
- Modify: `packages/host/src/repo-enrollment.ts` (request schema, stored entry, view, restore)
- Create: `packages/host/src/project-source.ts` (types and class skeleton only; Task 2 fills bodies)
- Test: `tests/repo-enrollment.test.ts` (extend)

**Interfaces (Produces):**

```ts
// team-types.ts
export const projectSourceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("github"), repository: githubRepository, baseBranch: gitBranch }).strict(),
  z.object({ mode: z.literal("laptop") }).strict(),
]);
export type ProjectSource = z.infer<typeof projectSourceSchema>;
export const teamDeliverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("merge"), repository: githubRepository, baseBranch: gitBranch, mergeMethod: z.enum(["squash","merge","rebase"]).default("squash") }).strict(),
  z.object({ mode: z.literal("pr"), repository: githubRepository, baseBranch: gitBranch }).strict(),
]);
// report union gains:
z.object({ kind: z.literal("pull-request"), headCommit: COMMIT_REGEX, pullRequestUrl: z.string().trim().min(1).max(500), summary: z.string().trim().min(1).max(4000) }).strict()
// TeamRun gains:
pullRequest?: { revision: number; headCommit: string; pullRequestUrl: string; summary: string; reportedAt: string };
baseStale?: { fetchedAt?: string; reason: "fetch-failed"; category: SourceFetchCategory };
baseBehind?: { mirrorHead: string };

// types.ts
export interface Project { ...; source?: import("./team-types.js").ProjectSource }
export interface Config { ...; source?: { mirrorDir?: string; refreshMinutes?: number } }

// project-source.ts
export type SourceFetchCategory = "auth" | "network" | "not-found" | "other";
export type SourcePendingReason = "session-running" | "fetch-failed" | "diverged" | "apply-failed";
export interface ProjectSourceStatus {
  mode: "github" | "laptop";
  repository?: string; baseBranch?: string;
  mirrorHead?: string; appliedHead?: string; fetchedAt?: string; appliedAt?: string;
  pending?: { reason: SourcePendingReason; category?: SourceFetchCategory | SyncFailureCategory; message?: string; since: string };
  savedBranches?: string[];
}
export class ProjectSourceError extends Error { constructor(message: string, readonly code: "source-github" | "source-refreshing" | "source-unavailable" | "unknown-project" | "not-github", readonly status = 409) }
export class ProjectSourceService {
  constructor(config: Config, options: { running: (projectId: string) => Promise<boolean>; prefix?: TeamCommand });
  status(projectId: string): ProjectSourceStatus;
  isGithub(projectId: string): boolean;
  mirrorPath(projectId: string): string;            // `${config.source?.mirrorDir ?? join(dirname(config.teams!.workspaceDir), "source-mirrors")}/${projectId}.git`
  refreshing(projectId: string): boolean;           // true only during the working-tree step
  refresh(projectId: string, options?: { maxAgeMs?: number; signal?: AbortSignal }): Promise<ProjectSourceStatus>;
  start(): void; stop(): void;                      // timer, every (config.source?.refreshMinutes ?? 5) minutes, min 1
}
```

- [ ] **Step 1: Write failing enrollment tests** in `tests/repo-enrollment.test.ts`: `put` with `source: { mode: "github", repository: "example/product", baseBranch: "main" }` returns it in the view and sets `project.source`; a restart (`new RepoEnrollmentService(...)`) restores `project.source`; `source: { mode: "laptop" }` is stored and returned; omitting `source` on a later `put` keeps the saved one.
- [ ] **Step 2: Run** `node --import tsx --test tests/repo-enrollment.test.ts` — expect FAIL (unknown key `source`).
- [ ] **Step 3: Implement** the schemas and types above. In `repo-enrollment.ts`: add `source: projectSourceSchema.optional()` to `repoEnrollmentRequestSchema`; `StoredEnrollment.source?`; `RepoEnrollmentView.source?`; in `putLocked` set `entry.source = request.source ?? current?.source`; in `restore`/`putLocked` assign `project.source`; in `view` include it. Keep `teamDeliverySchema.shape.repository` call sites in `team-cli.ts` compiling by exporting `githubRepositorySchema` and `gitBranchSchema` from `team-types.ts` and switching those two call sites (`team-cli.ts:70,85`) to them.
- [ ] **Step 4: Create `project-source.ts` skeleton** with the exported types, error class, and the class whose methods throw `new Error("not implemented")` except `isGithub` (reads `config.projects`), `mirrorPath`, and `status` (returns `{ mode: "laptop" }` for non-github projects; otherwise reads `join(config.stateDir, "projects", id, "source", "status.json")` when present, else `{ mode: "github", repository, baseBranch }`).
- [ ] **Step 5: Run** the enrollment test and `npm run typecheck -w @infinite/host` — expect PASS.
- [ ] **Step 6: Commit** `feat(host): add project source and PR delivery contracts (INF-97)`.

---

### Task 2: ProjectSourceService (mirror, refresh, timer)

**Files:**
- Modify: `packages/host/src/project-source.ts` (fill the skeleton)
- Test: `tests/project-source.test.ts` (create)

**Interfaces:**
- Consumes: skeleton from Task 1; `teamCommand`, `teamGitArgs`, `TeamError` from `team-workspace.ts`; `syncFailure` from `project-sync.ts`.
- Produces: the class as declared in Task 1. Additional exported helper for Task 3: `export function mirrorRemoteUrl(source: { repository: string }, override?: string): string` returning `override ?? \`https://github.com/${repository}.git\``. `refresh` must accept a per-project test override of the remote through `config.source?.remoteOverrides?: Record<string, string>` (add to `Config.source` type; undocumented, test-only; refuse it when `config.environment === "cloud"`).

Status persistence: `join(config.stateDir, "projects", id, "source", "status.json")` (plain JSON, like `pending.json`). Saved-branch names: `infinite/saved-YYYYMMDD-8HEX` where 8HEX is from `randomUUID()`.

Refresh algorithm (one queued task per project; a second call while one runs awaits the first):
1. Skip when `options.maxAgeMs` is set and `fetchedAt` is younger than it; return `status()`.
2. Ensure mirror: if `mirrorPath` missing, `mkdir -p` its parent (mode `0o2770` when `config.sync?.sharedGroup`, else `0o750`) and run `git init --bare <mirror>` through the prefix.
3. `git fetch --no-tags <remote> +refs/heads/BASE:refs/heads/BASE` in the mirror, 120 s timeout. On failure classify by output: `/authentication|403|401|could not read Username/i` → `auth`; `/could not resolve|unable to access|timed out|connection/i` → `network`; `/not found|repository .* does not exist/i` → `not-found`; else `other`. Record `pending: { reason: "fetch-failed", category, message: FIXED[category], since }` where the auth message is `"grant the GitHub App access to OWNER/REPO"` (with the real slug substituted; the slug is not private) and return. On success set `fetchedAt`, `mirrorHead` (`rev-parse refs/heads/BASE` in the mirror), clear a `fetch-failed` pending.
4. If `mirrorHead === appliedHead` and working tree `HEAD` equals it, return.
5. If `await running(projectId)`: record `pending: session-running` and return.
6. Set `refreshing(projectId)` true for the remainder. Re-check `running` (Review Focus 2). In the working tree: `rev-parse HEAD` → `treeHead`. `merge-base --is-ancestor treeHead mirrorHead`; on non-zero exit record `pending: diverged` with message `"the host checkout has commits that are not on BASE"` and return.
7. `status --porcelain --untracked-files=no`; if non-empty: `checkout -b infinite/saved-...`, `add -u`, `commit -m "Edits left in the host checkout before a refresh from GitHub"`, append the branch to `savedBranches`, then continue (the tree is now clean at the saved commit, which is a descendant of `treeHead`; step 8 checks out the base head detached, so the saved commit stays only on its branch).
8. `fetch --no-tags <mirrorPath> +refs/heads/BASE:refs/remotes/origin/BASE` in the working tree, then `checkout --detach mirrorHead`. Set `appliedHead`, `appliedAt`, clear pending.
9. Any `TeamError`/fs error in 6–8: `pending: { reason: "apply-failed", ...syncFailure(error, project.path) }`.

Timer: `start()` sets an unref'd interval of 60 s that calls `refresh(id, { maxAgeMs: refreshMinutes*60_000 })` for every github project, swallowing errors; `stop()` clears it.

- [ ] **Step 1: Write failing tests** in `tests/project-source.test.ts` with a fixture: temp dir, bare "github" repo seeded from a work clone with commit A on `main`, a project directory = detached clone of A with origin removed (mirror `repo init` output), config with `teams.workspaceDir`, `source.remoteOverrides = { example: <bare path> }`, `project.source = { mode: "github", repository: "example/product", baseBranch: "main" }`. Tests:
  - "first refresh creates the mirror and fast-forwards the tree": push B to the bare repo; `refresh` → `mirrorHead === B`, `appliedHead === B`, working tree `HEAD` B, an ignored file `node_modules/x` created before refresh still exists.
  - "a running session defers the working tree step": `running` returns true → `pending.reason === "session-running"`, `mirrorHead === B`, tree still A; then running false → next `refresh` applies.
  - "tracked edits are saved to a dated branch": modify a tracked file and add an untracked file in the tree; refresh → `savedBranches[0]` matches `/^infinite\/saved-\d{8}-[0-9a-f]{8}$/`, `git log -1 --format=%s <branch>` equals the fixed message, tree HEAD B, the untracked file still exists and is still untracked.
  - "diverged": commit C on top of A in the project tree; refresh → `pending.reason === "diverged"`, tree HEAD still C.
  - "fetch failure is categorized and does not touch the tree": point the override at a missing path → `pending.reason === "fetch-failed"`, `category === "not-found"` or `"other"` (assert one of these), `appliedHead` unchanged.
  - "running check re-evaluated before the apply step": `running` returns false on the first call and true on the second → `pending.reason === "session-running"`.
  - "maxAgeMs skips a young fetch": two refreshes with `maxAgeMs: 60_000`; the bare repo gets commit D between them; the second returns `mirrorHead === B`.
- [ ] **Step 2: Run** `node --import tsx --test tests/project-source.test.ts` — expect FAIL (not implemented).
- [ ] **Step 3: Implement** per the algorithm.
- [ ] **Step 4: Run** the test and `npm run typecheck -w @infinite/host` — expect PASS.
- [ ] **Step 5: Commit** `feat(host): refresh GitHub-tracked project sources through a host mirror (INF-97)`.

---

### Task 3: Teams clone the mirror; PR delivery; refresh after merge

**Files:**
- Modify: `packages/host/src/teams.ts` (constructor option, `createRun` source selection, delivery branch, report handling)
- Modify: `packages/host/src/team-workspace.ts` (new `prepareTeamWorkspaceFromMirror`)
- Modify: `packages/host/src/team-prompts.ts:61-66` (PR delivery instructions)
- Test: `tests/teams.test.ts` and `tests/team-delivery.test.ts` (extend), using `tests/team-fixture.ts`

**Interfaces:**
- Consumes: `ProjectSourceService` (Task 1 skeleton; Task 2 bodies). `TeamService` constructor gains an options bag `{ source?: ProjectSourceService; onMerged?: (projectId: string) => void }` as a new last parameter (keep existing positional parameters unchanged).
- Produces: `prepareTeamWorkspaceFromMirror(mirror: string, head: string, root: string, directoryName: string, branch: string, prefix?: TeamCommand, signal?: AbortSignal, anchor?: string): Promise<{ workspace: string; branch: string; baseCommit: string }>` which does the same directory setup as `prepareTeamWorkspace` but `clone --no-local --no-hardlinks --no-checkout -- <mirror> integration`, `remote remove origin`, `checkout -b <branch> <head>`, and asserts `cat-file -t head === "commit"`; no clean check, no `show-toplevel` check.

Behavior:
- In `createRun`, when `project.source?.mode === "github"` and there is no `parent`: inside the prepare operation call `await source.refresh(project.id)` (no maxAge). If `status.mirrorHead` is undefined → throw `TeamError(409, "source-unavailable", "The host has no copy of this repository from GitHub yet; check the project's source status.")` (Review Focus 4). Else `prepareTeamWorkspaceFromMirror(source.mirrorPath(id), status.mirrorHead, ...)`; if `status.pending?.reason === "fetch-failed"` set `run.baseStale = { fetchedAt: status.fetchedAt, reason: "fetch-failed", category }` and `this.event(stored, "GitHub could not be reached; the run starts from the last fetched base.")`.
- When `parent` exists and the project is github: call `source.refresh(id, { maxAgeMs: 60_000 })` (errors ignored) and, if `mirrorHead` differs from the parent's head and `merge-base --is-ancestor parentHead mirrorHead` would be true, set `run.baseBehind = { mirrorHead }`. Keep the clone path unchanged.
- Delivery: when the reviewer approves and `run.delivery` exists, the branch already prepares a `delivery` member. In `team-prompts.ts`, when `run.delivery?.mode === "pr"`, swap the merge instructions for: push `run.branch` at exactly `run.headCommit` to the pinned repository, open (or reuse) a pull request against `baseBranch` whose head is that commit, do not merge, and report `{"kind":"pull-request","headCommit":...,"pullRequestUrl":"https://github.com/OWNER/REPO/pull/123","summary":"..."}`. Keep all the existing guards (no force push, no permission changes, blocked on missing tools).
- Report handling: `pull-request` is accepted only when `run.delivery?.mode === "pr"`, passes the same `assertDelivery` and stale checks as `delivery`, validates the URL exactly as `delivery` does, then sets `run.pullRequest = {...}`, `stored.deliveryAttempt = undefined`, `run.status = "ready-for-review"`, event "The delivery agent reported an open pull request for the reviewed commit. Review and merge it on GitHub; the host refreshes the project after the merge." A `delivery` report on a `pr` run, or `pull-request` on a `merge` run, throws `TeamError(409, "delivery-mode-mismatch", ...)`.
- After a `delivery` (merge) report completes (`run.status = "merged"`), call `options.onMerged?.(run.projectId)`.
- `assertDelivery` compares `digest(configured)` with `digest(run.delivery)` as today; nothing changes.

- [ ] **Step 1: Write failing tests**:
  - `tests/teams.test.ts` "a github project run clones the mirror and pins its head": fixture project with `source.mode = "github"`, a fake `ProjectSourceService` object `{ refresh: async () => ({ mode:"github", mirrorHead: HEAD_B, ... }), mirrorPath: () => <bare repo with B>, isGithub: () => true }`; create a team; after prepare, `run.baseCommit === HEAD_B`, integration clone has no `origin`, and the project directory was never read (leave an untracked file there; the run must not fail `project-dirty`).
  - "first fetch failed": fake refresh returns no `mirrorHead` → run blocked with reason containing "no copy of this repository".
  - "fetch failed after a prior success marks the base stale": refresh returns `mirrorHead` plus `pending: { reason: "fetch-failed", category: "network" }` → `run.baseStale.category === "network"` and an event text contains "GitHub could not be reached".
  - `tests/team-delivery.test.ts` "pr delivery records the pull request and ends ready for review": project delivery `{ mode: "pr", repository: "example/product", baseBranch: "main" }`; drive the run to approval as the existing merge test does; the delivery member prompt contains "do not merge"; a `pull-request` report with the right head and `https://github.com/example/product/pull/7` → `run.pullRequest.pullRequestUrl` set, `run.status === "ready-for-review"`, `bundle()` succeeds.
  - "a merge report on a pr run is refused": same setup, report `delivery` → 409 `delivery-mode-mismatch`.
  - "a merge report triggers the source refresh": existing merge test plus `onMerged` spy called once with the project id.
- [ ] **Step 2: Run** both test files — expect FAIL.
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4: Run** both test files and `npm run typecheck -w @infinite/host` — expect PASS.
- [ ] **Step 5: Commit** `feat(teams): base runs on the GitHub mirror and add pull-request delivery (INF-97)`.

---

### Task 4: Server wiring: status, refresh route, holds, sync refusal, capability

**Files:**
- Modify: `packages/host/src/server.ts` (construction near line 120-245, routes near 1152-1195, `/api/me` near 468-475)
- Test: `tests/project-sync-api.test.ts` (extend; it already starts a server)

**Interfaces:**
- Consumes: `ProjectSourceService`, `ProjectSourceError` (Task 1/2); `TeamService` options `{ source, onMerged }` (Task 3).
- Produces: HTTP contract:
  - `GET /api/projects/:id` → adds `source: ProjectSourceStatus`.
  - `POST /api/projects/:id/source/refresh` (owner) → `ProjectSourceStatus`; `409 not-github` for a laptop project; errors from the service map to `{ error, code }` like `ProjectSyncError` does.
  - `POST sync/begin`, `sync/commit`, `sync/apply` → `409 { code: "source-github", error: "This project follows GitHub; laptop sync is off. Re-enroll with --source laptop to upload from this computer." }` when `projectSource.isGithub(id)`.
  - `startInProject` throws `ProjectSourceError("A refresh from GitHub is updating this project. Start the session after it finishes.", "source-refreshing")` when `projectSource.refreshing(id)`.
  - `/api/me` `teams` gains `projectSource: 1`.
- Construction: `const projectSource = new ProjectSourceService(config, { running: id => sessionRunningInProject(id), prefix: config.teams?.commandPrefix })` where `sessionRunningInProject` is a new function next to `projectRunning` that checks only `startsInFlight` and the session list (not teams, goals, or handoffs). Pass `{ source: projectSource, onMerged: id => void projectSource.refresh(id).catch(() => {}) }` to `TeamService`. Call `projectSource.start()` after the server listens and `stop()` on shutdown where other timers stop.

- [ ] **Step 1: Write failing tests** in `tests/project-sync-api.test.ts`: with a project enrolled as `github` (set `config.projects[0].source` directly in the fixture): `GET /api/projects/:id` has `source.mode === "github"`; `POST sync/apply` with `{ force: true }` → 409 `source-github` (Review Focus 5); `POST source/refresh` on a laptop project → 409 `not-github`; `GET /api/me` has `teams.projectSource === 1`.
- [ ] **Step 2: Run** `node --import tsx --test tests/project-sync-api.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and typecheck — expect PASS.
- [ ] **Step 5: Commit** `feat(server): expose project source status and refresh, refuse laptop sync for GitHub projects (INF-97)`.

---

### Task 5: CLI: repo init source mode, --delivery pr, repo refresh, comparison lines

**Files:**
- Modify: `packages/host/src/team-cli.ts` (repo init options and body, `requestedDelivery`, new `repo refresh`)
- Modify: `packages/host/src/client.ts` (`describeSync` siblings, `sync` refusal, pre-launch line, `projects`/`sync --status` lines)
- Test: `tests/sync-cli.test.ts` (extend) and `tests/team-cli-source.test.ts` (create, unit tests of pure helpers)

**Interfaces:**
- Consumes: host contract from Task 4; `projectSourceSchema`, `githubRepositorySchema`, `gitBranchSchema` from Task 1.
- Produces (exported from `team-cli.ts` for tests):
  - `inferProjectSource(root: string, option: string | undefined): ProjectSource` — `option` is `--source` (`github` | `laptop` | undefined). Undefined: `github` when `inferGitHubRepository(root)` and `inferBaseBranch(root)` both succeed, else `laptop`; never throws for undefined; never prints the remote URL. Explicit `github` throws the existing bounded messages when inference fails.
  - `requestedDelivery` accepts `pr`: `--merge-method` with `pr` throws `"--merge-method applies only to --delivery merge."`; `pr` builds `{ mode: "pr", repository, baseBranch }`.
  - Exported from `client.ts`: `describeSource(source: ProjectSourceStatus): string` and `compareLaptop(root: string, source: ProjectSourceStatus): string` producing the exact lines in the spec: `follows github OWNER/REPO@BASE`, `host SHORT = origin/BASE · fetched AGE · applied AGE`, `host SHORT, origin/BASE SHORT (N commits ahead) · fetch failed AGE: CATEGORY`, `host SHORT, origin/BASE SHORT · waiting: session running`, `saved local edits on BRANCH`, `host diverged from origin/BASE`, and `laptop SHORT = origin/BASE`, `laptop has N unpushed commits; the host runs origin/BASE`, `laptop is N commits behind origin/BASE (host fetched AGE)`, `host is ahead; fetch to compare`. `compareLaptop` uses `git rev-list --count` locally and `git cat-file -e <mirrorHead>` to decide the last case; it never fetches.

Behavior:
- `repo init`: new `--source github|laptop`; body `team` unchanged; body gains `source` (sent when `me.teams?.projectSource === 1`). The JSON output gains `source`. After a `github` enrollment the CLI calls `POST /projects/:id/source/refresh` once and prints `describeSource` on stderr prefixed `[Infinite] `; a `fetch-failed` with `auth` prints the message from the host verbatim.
- `infinite repo refresh [--project ID]` → `POST source/refresh`, prints `describeSource`.
- `infinite sync` (service start) for a project whose detail `source.mode === "github"`: print `This project follows GitHub; laptop sync is off. Push to GitHub, or re-enroll with infinite repo init --source laptop.` and exit 1 without starting a service.
- `sync --status` and `projects` lines: for `github` projects append `· ${describeSource(source)}` instead of the synced/applied pair.
- Pre-launch (where "Laptop changes from AGE are pending" prints): for `github` projects print `compareLaptop(root, source)` when inside an enrolled checkout, else `describeSource`.

- [ ] **Step 1: Write failing tests**: in `tests/team-cli-source.test.ts` build temp repos: origin `https://github.com/example/product.git` with `origin/HEAD` → `inferProjectSource(root, undefined)` is github/main; origin `https://user:token@github.com/example/product.git` → laptop and the thrown-nothing path (Review Focus 3); no origin → laptop; `requestedDelivery` with `--delivery pr` → `{ mode: "pr", ... }`; with `--merge-method` → throws. In `tests/sync-cli.test.ts`: `describeSource`/`compareLaptop` cases listed above with a local repo where `mirrorHead` is or is not present.
- [ ] **Step 2: Run** both — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both and `npm run typecheck -w @infinite/host` — expect PASS.
- [ ] **Step 5: Commit** `feat(cli): record GitHub source mode at repo init, add repo refresh and laptop comparison (INF-97)`.

---

### Task 6: Web and phone: source line, Refresh from GitHub, PR link

**Files:**
- Modify: `apps/web/src/api.ts:186-190` (types, `sourceLabel`)
- Modify: `apps/web/src/main.tsx:440-530` (Create screen)
- Modify: `apps/web/src/teams.tsx` (PR link when `team.pullRequest`)
- Modify: `apps/mobile/src/api/client.ts` or the module that declares `ProjectDetail` (types), `apps/mobile/src/features/create/Create.tsx:40-95`, `apps/mobile/src/features/teams/TeamDetail.tsx` (PR link)
- Test: `apps/web/src/api.test.ts` if present, else none for the label helper (pure string function; add one `node:test` file under `tests/` only if the repo has a pattern for web helpers; otherwise skip)

**Interfaces:**
- Consumes: `GET /api/projects/:id` → `source`; `POST /api/projects/:id/source/refresh`; `team.pullRequest`.
- Produces: `sourceLabel(source: ProjectSourceStatus, now?: number): string` in `apps/web/src/api.ts` mirroring the CLI `describeSource` text; the phone duplicates it in its own api module (the apps do not share code with the host package).

Behavior:
- Create screen: when `source.mode === "github"`, replace the "Synced from laptop …" line with `Follows GitHub OWNER/REPO@BASE · host SHORT · fetched AGE` plus the pending text, and show an owner button **Refresh from GitHub** (busy state, error line like `applyPending`). Keep the laptop sync line and buttons for laptop projects.
- Team detail (web and phone): when `team.pullRequest`, show a notice "Pull request open for the reviewed commit" with a link to the URL, next to the existing ready-for-review notice.
- Run `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` in `apps/mobile`, and `npm run typecheck -w @infinite/web` (or the web workspace's check script).

- [ ] **Step 1: Implement** the types and labels, then the screens.
- [ ] **Step 2: Run** the three checks above — expect PASS.
- [ ] **Step 3: Commit** `feat(apps): show GitHub source status, refresh button, and pull request link (INF-97)`.

---

### Task 7: GitHub App scripts enumerate installed repositories

**Files:**
- Modify: `scripts/github-app-refresh.mjs` (config shape, discovery, refresh loop)
- Modify: `scripts/github-app-client.mjs:89-112` (`repositories` optional; configured = token file present)
- Modify: `deploy/ubuntu/github-app.md` (configuration section)
- Test: `tests/github-app-refresh.test.ts`, `tests/github-app-client.test.ts` (extend)

**Interfaces:**
- Produces: issuer config accepts either `repositories: [...]` (today) or `installations: [{ installationId }]`. With `installations`, the script mints an installation token per installation (no `repositories` restriction), calls `GET /installation/repositories` (paginate `per_page=100`, cap 500 total), and then refreshes a repository-scoped token for each `{ repository: full_name, repositoryId: id, installationId }` exactly as today. Token files for repositories no longer listed are removed. Client config `repositories` becomes optional; when absent, `configured(config, repository)` is true when `tokenPath` exists.

- [ ] **Step 1: Write failing tests**: refresh with `installations` and a mocked `fetch` sequence (installation token → repositories page → per-repo token) writes two token files and removes a stale third; client `status` and `credential get` work with no `repositories` list when the token file exists and fail closed when it does not.
- [ ] **Step 2: Run** both test files — expect FAIL.
- [ ] **Step 3: Implement**; keep every existing validation and the bounded error codes; add codes `installations` and `discovery-failed`.
- [ ] **Step 4: Update** `deploy/ubuntu/github-app.md`: new example with `installations`, the sentence that adding a repository now needs only the App grant on GitHub, and that `client.json` may omit `repositories`.
- [ ] **Step 5: Run** both test files — expect PASS.
- [ ] **Step 6: Commit** `feat(github-app): mint tokens for every installed repository (INF-97)`.

---

### Task 8: Documentation (after integration)

**Files:**
- Modify: `docs/workspace-sync.md` (new first section "Source modes"; `409 source-github`), `docs/teams.md` (enrollment, delivery `pr`, mirror and launcher operations, base staleness), `docs/cli.md` (`repo init --source`, `--delivery pr`, `repo refresh`, status lines), `docs/architecture.md` (one paragraph on the mirror), `docs/security.md` (mirror is agent-writable; what that means)

- [ ] **Step 1: Write** the sections from the spec and the final code (read the merged branch, not the plan).
- [ ] **Step 2: Scan** the diff with the AGENTS.md private-information grep — expect no hits beyond documented placeholders.
- [ ] **Step 3: Commit** `docs: describe GitHub-tracked project sources and PR delivery (INF-97)`.

---

## Execution notes for the coordinator

- Task 1 lands first, inline. Then Tasks 2–7 run in parallel in this worktree with disjoint owned paths; Task 8 runs after integration.
- Integration seams to check by hand: Task 3's `TeamService` options signature against Task 4's construction; Task 4's `source` field name against Task 5 and 6 readers; the `source-github` message text used by Task 4 and Task 5.
- Final: `npm run check` once, mobile lint and tsc, then one strong review of the combined diff.
