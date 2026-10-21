# Projects over checkouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold checkouts of one repository into one owner-facing project, let the owner rename, hide, combine, split, and pick a primary checkout, and make the phone picker, board, and creation screens speak in projects.

**Architecture:** The host captures a Git identity per checkout once (sealed), folds checkouts by identity inside stored project groups, and keeps creating one `repository` group per new identity. `repos[]` keeps one entry per repository with the primary checkout's id, name, and path, so older clients render the folded list unchanged. Missions, the board, the CLI, and the phone consume the new `kind`, `hidden`, and `checkouts` fields.

**Tech Stack:** Node 22 host (TypeScript, zod, sealed state through `vault.ts`), `node --test` suites under `tests/`, Expo React Native phone app, CLI in `packages/host/src/client.ts` and `board-cli.ts`.

**Spec:** `docs/superpowers/specs/2026-10-21-projects-over-checkouts-design.md`

## Global Constraints

- No private information in any file: placeholder remotes such as `https://github.com/example/sample.git`, placeholder paths such as `/home/dev/projects/sample`.
- Sealed state must load older records: missing `kind` reads `owner`, missing `hidden` reads `false`, missing `detached` and `primary` read empty.
- The host runs only `git config --get remote.origin.url` and `git rev-list --max-parents=0 HEAD` in a project directory, once per checkout, with a 5 s timeout.
- `repos[].projectId`, `name`, `path` mean the primary checkout; `implicit` stays `kind === "implicit"`.
- Project ids match `/^[a-z0-9-]{1,80}$/` and are never reused (tombstones).
- Phone copy: sentence case, terse, rows not cards, no host path in any list row.
- Tests that start a host run with `npm test -- --test-name-pattern` or `node --import tsx --test FILE`; run focused suites per task and `npm run check` once at integration.

## Review Focus

1. A checkout whose `.git` is a linked-worktree pointer that does not resolve on the host: both Git commands fail; the checkout must stay an implicit single project and the list must not throw. Test in Task 2 ("a checkout whose Git commands fail stays implicit and is retried on the next list").
2. The owner names a checkout in `PUT repos` that belongs to an `owner` group: 409 `project-group-repo-conflict`, nothing moves. Test in Task 2.
3. Two repository groups whose default names collide (`sample` from two unrelated remotes with the same last segment): the second gets `sample-2`, and the ids stay stable across restarts. Test in Task 2.
4. A mission started for a project whose primary checkout is not team-ready while another checkout is: the team-ready one is pinned and an event says so. Test in Task 3.
5. Chip filtering on the phone keeps standalone team runs and goals of that project. Test in Task 3 (board carries `groupId`) and Task 5 (model filter unchanged, fixture includes a team item).

---

### Task 1: Shared contracts and identity helpers (coordinator, lands first)

**Files:**
- Modify: `packages/host/src/project-group-types.ts`
- Modify: `packages/host/src/mission-types.ts:8-16` (add `checkouts`)
- Create: `packages/host/src/checkout-identity.ts`
- Create: `tests/checkout-identity.test.ts`
- Modify: `apps/mobile/src/api/client.ts:212-221`
- Create: `apps/mobile/src/features/projects/model.ts`
- Create: `tests/mobile-projects-model.test.ts`

**Interfaces:**
- Produces (host types):
  ```ts
  export type ProjectGroupKind = "owner" | "repository" | "implicit";
  export interface ProjectGroupCheckout { projectId: string; name: string; path: string; primary: boolean; teamReady: boolean; identityFrom?: "source" | "host-scan" }
  export interface ProjectGroupRepo { projectId: string; name: string; path: string; key?: string; checkouts: ProjectGroupCheckout[] }
  export interface ProjectGroup { id: string; name: string; kind: ProjectGroupKind; hidden: boolean; repos: ProjectGroupRepo[]; implicit: boolean; revision: number; createdAt: string; updatedAt: string }
  export interface ProjectGroupSuggestion { name: string; repos: string[]; groupIds: string[]; reason: "shared-parent" | "shared-linear-project" }
  // repoListSchema max becomes 64; updateProjectGroupSchema gains: hidden: z.boolean().optional(), primary: repoListSchema.optional()
  // mission-types.ts createMissionSchema gains: checkouts: z.array(hostProjectId).max(64).optional()
  ```
- Produces (`checkout-identity.ts`):
  ```ts
  export type CheckoutIdentity = { projectId: string; key: string; repoName: string; capturedAt: string; from: "source" | "host-scan" };
  /** Trimmed stdout of `git -C cwd ...args`, or undefined when git fails or times out (5 s). */
  export type GitReader = (cwd: string, args: string[]) => string | undefined;
  export const readGit: GitReader;
  export function normalizeRemote(url: string): { key: string; repoName: string } | undefined;
  export function repoNameFromPath(path: string): string;
  export function captureIdentity(project: { id: string; path: string }, git: GitReader, at?: string): CheckoutIdentity | undefined;
  ```
- Produces (phone `features/projects/model.ts`):
  ```ts
  export function visibleGroups(groups: ProjectGroup[]): ProjectGroup[];            // drops hidden, keeps order
  export function groupActivity(items: BoardItem[], groupId: string): string;       // "1 needs input · 2 working · 1 to review" or "Nothing running"
  export function checkoutsOf(group: ProjectGroup): ProjectGroupCheckout[];         // every checkout, primary first within each repo
  export function groupContaining(groups: ProjectGroup[], projectId: string): ProjectGroup | undefined;
  export function primaryCheckout(group: ProjectGroup): ProjectGroupCheckout | undefined; // first repo's primary
  ```

- [ ] **Step 1: Write `tests/checkout-identity.test.ts`**

```ts
test("normalizeRemote folds https, ssh, scp, credentials, and .git into one lowercase key", () => {
  for (const url of ["https://github.com/Example/Sample.git", "git@github.com:example/sample.git", "ssh://git@GitHub.com/example/sample", "https://user:token@github.com/example/sample"])
    assert.deepEqual(normalizeRemote(url), { key: "remote:github.com/example/sample", repoName: "Sample" === url.split("/").at(-1)?.replace(".git", "") ? "Sample" : "sample" });
  assert.equal(normalizeRemote(""), undefined);
  assert.equal(normalizeRemote("not a url"), undefined);
});
test("repoNameFromPath skips generic folder names", () => {
  assert.equal(repoNameFromPath("/home/dev/projects/SmartAlarm/codebase"), "SmartAlarm");
  assert.equal(repoNameFromPath("/home/dev/projects/sample"), "sample");
  for (const generic of ["code", "src", "repo", "app", "main", "worktree"]) assert.equal(repoNameFromPath(`/home/dev/thing/${generic}`), "thing");
});
test("captureIdentity prefers the remote, falls back to the lowest root commit, and yields nothing when git fails", () => {
  const remote: GitReader = (_cwd, args) => args[0] === "config" ? "git@github.com:example/sample.git" : "abc";
  assert.deepEqual(captureIdentity({ id: "a", path: "/home/dev/sample" }, remote, "2026-10-21T00:00:00.000Z"), { projectId: "a", key: "remote:github.com/example/sample", repoName: "sample", capturedAt: "2026-10-21T00:00:00.000Z", from: "host-scan" });
  const roots: GitReader = (_cwd, args) => args[0] === "config" ? undefined : "ffff\naaaa\n";
  assert.equal(captureIdentity({ id: "b", path: "/home/dev/projects/SmartAlarm/codebase" }, roots)?.key, "root:aaaa");
  assert.equal(captureIdentity({ id: "b", path: "/home/dev/projects/SmartAlarm/codebase" }, roots)?.repoName, "SmartAlarm");
  assert.equal(captureIdentity({ id: "c", path: "/home/dev/plain" }, () => undefined), undefined);
});
```

Fix the first assertion so the expected `repoName` is literal per url (`Sample`, `sample`, `sample`, `sample`); do not compute it.

- [ ] **Step 2: Run it; expect module-not-found**

Run: `node --import tsx --test tests/checkout-identity.test.ts`

- [ ] **Step 3: Implement `checkout-identity.ts`**

`normalizeRemote`: accept `scheme://[user[:pass]@]host[:port]/path`, `user@host:path`, and bare `host/path`; drop userinfo, port, trailing `.git`, trailing `/`; lowercase host and path for the key; `repoName` is the last path segment before lowercasing; return undefined when host or path is empty or the path has fewer than one segment. `readGit` uses `execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })` in try/catch. `captureIdentity` runs `config --get remote.origin.url`, then `rev-list --max-parents=0 HEAD` (split lines, sort, take first), `from: "host-scan"`.

- [ ] **Step 4: Add the type fields and schema change in `project-group-types.ts`**

Add `ProjectGroupKind`, `ProjectGroupCheckout`, `key?`/`checkouts` on `ProjectGroupRepo`, `kind`/`hidden` on `ProjectGroup`, `groupIds` on the suggestion, and `hidden`/`primary` on `updateProjectGroupSchema`. The host will not compile until Task 2; that is expected.

- [ ] **Step 5: Mirror the types in `apps/mobile/src/api/client.ts`** replacing the block at lines 212-221 with the same shapes (`ProjectGroupCheckout`, `ProjectGroupRepo` with `key?` and `checkouts`, `ProjectGroup` with `kind` and `hidden`, suggestion with `groupIds`).

- [ ] **Step 6: Write `tests/mobile-projects-model.test.ts`**

```ts
const checkout = (projectId: string, primary = false, teamReady = true): ProjectGroupCheckout => ({ projectId, name: projectId, path: `/home/dev/${projectId}`, primary, teamReady });
const group = (id: string, repos: ProjectGroupRepo[], hidden = false): ProjectGroup => ({ id, name: id, kind: "repository", hidden, repos, implicit: false, revision: 1, createdAt: "", updatedAt: "" });
const sample = group("sample", [{ projectId: "sample-main", name: "sample", path: "/home/dev/sample-main", checkouts: [checkout("sample-main", true), checkout("sample-codex")] }]);
test("visibleGroups drops hidden projects and keeps order", () => assert.deepEqual(visibleGroups([sample, group("old", [], true), group("z", [])]).map(g => g.id), ["sample", "z"]));
test("groupActivity counts open columns in order and names the empty case", () => {
  const items = [item({ groupId: "sample", column: "working" }), item({ groupId: "sample", column: "review", kind: "team" }), item({ groupId: "sample", column: "needs-input" }), item({ groupId: "sample", column: "ended" }), item({ groupId: "other" })];
  assert.equal(groupActivity(items, "sample"), "1 needs input · 1 working · 1 to review");
  assert.equal(groupActivity([item({ groupId: "sample", column: "ended" })], "sample"), "Nothing running");
  assert.equal(groupActivity([item({ groupId: "sample", column: "needs-input" }), item({ groupId: "sample", column: "needs-input" })], "sample"), "2 need input");
});
test("checkoutsOf, groupContaining, and primaryCheckout read the folded shape", () => {
  assert.deepEqual(checkoutsOf(sample).map(c => c.projectId), ["sample-main", "sample-codex"]);
  assert.equal(groupContaining([sample], "sample-codex")?.id, "sample");
  assert.equal(groupContaining([sample], "nope"), undefined);
  assert.equal(primaryCheckout(sample)?.projectId, "sample-main");
});
```

Use the `item` helper shape from `tests/mobile-board-model.test.ts`.

- [ ] **Step 7: Implement `features/projects/model.ts`; run the test**

Run: `node --import tsx --test tests/mobile-projects-model.test.ts` → PASS.

- [ ] **Step 8: Commit** `feat(projects): checkout identity helpers and folded project contracts (INF-98)`

---

### Task 2: ProjectGroupService folds checkouts, kinds, hidden, primary, detach, alias

**Files:**
- Modify: `packages/host/src/project-groups.ts` (whole file)
- Modify: `tests/project-groups.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `captureIdentity`, `readGit`, `GitReader`.
- Produces:
  ```ts
  export class ProjectGroupService {
    constructor(config: Config, key: Buffer, writeState: StateWriter = writeSealed,
      options: { git?: GitReader; appliedAt?: (projectId: string) => string | undefined } = {});
    list(): ProjectGroupList;
    /** A stored group id, or a host project id, which resolves to the group holding that checkout. */
    get(idOrProjectId: string): ProjectGroup;
    /** The project a checkout belongs to, for board rows. */
    containing(projectId: string): { id: string; name: string } | undefined;
    create(input: CreateProjectGroup): ProjectGroup;
    update(id: string, input: UpdateProjectGroup): ProjectGroup;
    remove(id: string, input: { requestId: string; revision: number }): ProjectGroup;
  }
  ```
- Stored shape (sealed, scope `project-groups`): `{ groups: Record<string, StoredGroup>; receipts; tombstones: string[] }` with
  `StoredGroup = { id; name; kind: "owner" | "repository"; hidden: boolean; members: string[]; detached: string[]; primary: Record<string, string>; revision; createdAt; updatedAt }`.
  On load, an old record with `repos` becomes `members = repos.map(r => r.projectId)`, `kind: "owner"`, `hidden: false`, `detached: []`, `primary: {}`.
- Identity store (sealed, scope `checkout-identities`, file `stateDir/project-groups/identities.sealed`): `Record<string, CheckoutIdentity>`.

**Reconcile** (runs at the start of `list`, `get`, `containing`, `create`, `update`, `remove`):
1. For each configured project without a stored identity, call `captureIdentity(project, git)`; store on success. On failure remember the attempt time in memory and do not retry that checkout for 60 s (`options.now?: () => number` for tests, default `Date.now`).
2. For each configured project with an identity that no stored group holds as a member: candidates are stored groups holding a member with the same key whose `detached` excludes this project; join the candidate with the most members of that key, then the earliest `createdAt` (bump its `revision`, `updatedAt`). Otherwise create `{ id: slug(repoName), name: repoName, kind: "repository", hidden: false, members: [id], detached: [], primary: {} }`.
3. Persist when anything changed, through the existing `persist`/`pending` path.

**View**: for a stored group, members that are still configured are grouped by `identity.key ?? "project:" + id`; each repository → `ProjectGroupRepo` with `checkouts` sorted primary first then id; primary = `primary[key]` when still a member, else the first by: teamReady and latest `appliedAt`; latest `appliedAt`; shortest `path`; id. Repo `name` = identity `repoName`, or the host project name without identity. `teamReady` as `missions.ts:161` computes it. `implicit` views for identity-less, ungrouped projects as today. Sort groups by name then id; hidden groups included.

**Suggestions**: over `repository` and `implicit` groups only; shared parent of the primary path (same exclusions as today) and shared Linear project of any checkout; `repos` = every member of every involved group; `groupIds` = their ids; name as today.

**Edits**: `create` moves listed checkouts out of `repository` groups (deleting and tombstoning one that empties) and refuses (409 `project-group-repo-conflict`) checkouts in `owner` groups. `update`: `repos` removal appends to `detached`; addition moves from a `repository` group or refuses as above; a `repository` group holding two keys becomes `owner`; `primary` validates membership and sets `primary[key]`, at most one id per key (400 `project-group-primary-invalid`); `hidden` sets the flag. Editing an implicit id first materializes `{ id: projectId, kind: "owner", members: [projectId] }`. `remove` works for every stored kind.

- [ ] **Step 1: Extend the fixture in `tests/project-groups.test.ts`** with a `git` reader keyed by path (`/apps/alpha` and `/apps/alpha-codex` → `git@github.com:example/alpha.git`; `/apps/beta` → `https://github.com/example/beta.git`; `/linear/one` → root list `"bbbb\naaaa"`; others → undefined) and an `appliedAt` map, passed as `new ProjectGroupService(config, key, undefined, { git, appliedAt })`. Add project `alpha-codex` at `apps/alpha-codex`.

- [ ] **Step 2: Add the failing tests**

```ts
test("checkouts of one remote fold into one repository group with a stable id and a primary", ...)
  // list(): group id "alpha", kind "repository", repos.length 1, checkouts ids ["rehearsal","alpha-codex"], primary = the one with the latest appliedAt; restart → same id.
test("ssh and https forms and a root-only identity fold, and a checkout without identity stays implicit", ...)
test("rename, hide, primary, detach, move, and delete persist across a restart", ...)
  // update name → "Alpha product"; hidden true; primary ["alpha-codex"]; repos without "alpha-codex" → detached, and the next list shows "alpha-codex" in a new group "alpha-2"; create {name:"Shop", repos:[...shop-web members, ...shop-api members]} → kind owner, two repos; remove → tombstone; restart → identical list().
test("a checkout in an owner group cannot be pulled into another group", ...) // 409 project-group-repo-conflict
test("primary must name a member and at most one checkout per repository", ...) // 400 project-group-primary-invalid
test("a checkout whose Git commands fail stays implicit, is not retried within a minute, and folds once git answers", ...)
  // git reader returns undefined for /apps/late until a flag flips; list() → implicit; flip flag, list() with now unchanged → still implicit (no git call: count calls); advance now by 61 s → folded.
test("a detached checkout lands in the group with most checkouts of its key, then the earliest", ...)
test("repository groups with the same default name get distinct stable ids", ...) // two different remotes ending in /sample → "sample", "sample-2"
test("get resolves a host project id to its folded group and containing names the project", ...)
test("suggestions span repository groups and list every checkout they would combine", ...)
  // shop-web + shop-api → one suggestion, repos include all members, groupIds ["shop-api","shop-web"] sorted by name; owner groups never suggested
```

Update the existing tests whose assertions change: implicit listing now excludes identity-bearing projects; `repos[0]` gains `checkouts`.

- [ ] **Step 3: Run; expect failures** `node --import tsx --test tests/project-groups.test.ts`

- [ ] **Step 4: Rewrite `project-groups.ts`** per the Interfaces block. Keep `digest`, receipts, `replay`, `record`, `persist`, `pending`, tombstones, and `slug` as they are. `slug`'s used-id set also includes config project ids and tombstones, as today.

- [ ] **Step 5: Run the suite to green**, then `npx tsc -p packages/host --noEmit` (expect errors only in `missions.ts`, `server.ts`, `board-cli.ts`, `client.ts` until Tasks 3 and 4).

- [ ] **Step 6: Commit** `feat(host): fold same-repository checkouts into one project group (INF-98)`

---

### Task 3: Missions pin the primary checkout; board rows carry the project; alias route

**Files:**
- Modify: `packages/host/src/missions.ts:155-180` (create), `:885-915` (`missionBoard`)
- Modify: `packages/host/src/server.ts:524-527, 541-553, 555, 155`
- Modify: `tests/missions.test.ts`, `tests/board.test.ts`, `tests/project-groups.test.ts` (API test near line 233)

**Interfaces:**
- Consumes: `ProjectGroup.repos[].checkouts`, `ProjectGroupService.get` alias, `containing`.
- Produces: `missionBoard(missions, teams, goals, projects, containing: (projectId: string) => { id: string; name: string } | undefined)`; `ProjectGroupLookup` in `missions.ts` keeps `get(id)`.

- [ ] **Step 1: Failing tests**

`tests/missions.test.ts`: the `groups` stub returns a group whose single repo has checkouts `[primary not teamReady, alternate teamReady]`; after `create`, `mission.repoProjectIds` equals `[alternate id]` and `events` contains a text matching `/not configured for subteams; using/`. A second case: primary teamReady → pinned as is, no such event. A third: `create({ ..., checkouts: [alternate id] })` with a team-ready primary pins the alternate and records no event; `checkouts: ["outside"]` → 400 `mission-checkout-invalid`.

`tests/board.test.ts`: pass `containing` that maps the standalone team's and the goal's `projectId` to `{ id: "shop", name: "Shop" }`; assert both items have `groupId: "shop"` and `projectName: "Shop"`; an unmapped project keeps `projectName` = host project name and no `groupId`.

`tests/project-groups.test.ts` API test: `GET /api/project-groups/<host project id>` returns the folded group (200) for any paired role; `POST /api/missions` with `groupId` = host project id is accepted (mock enough for admission, or assert the server resolves through `projectGroups.get` by checking the stored `groupId` on the returned mission when the mission service is available in that host fixture; otherwise cover the alias through `get` alone and note it).

- [ ] **Step 2: Run; expect failures**

- [ ] **Step 3: Implement**

`missions.ts` create: validate `request.checkouts` against every checkout id in the group (400 `mission-checkout-invalid`); for each `group.repos` entry pick `repo.checkouts.find(c => request.checkouts?.includes(c.projectId)) ?? repo.checkouts.find(c => c.primary && c.teamReady) ?? repo.checkouts.find(c => c.teamReady) ?? repo.checkouts.find(c => c.primary) ?? repo.checkouts[0]`; the event below fires only when no request checkout chose it; look the host project up by that id; when the chosen id differs from `repo.projectId`, push event `Repository ${repo.name}: the primary checkout is not configured for subteams; using ${chosen.projectId}.` `missionBoard`: `const owner = containing(team.projectId)`; `groupId: owner?.id`, `projectName: owner?.name ?? projectName(team.projectId)`; same for goals.

`server.ts`: `new ProjectGroupService(config, key, undefined, { appliedAt: id => projectSync.status(id).appliedAt })` (move the construction below `projectSync` if needed); add `app.get("/api/project-groups/:id", requireRole(["owner","controller","viewer"]), (req, res) => res.json(projectGroups.get(projectGroupIdSchema.parse(req.params.id))))`; the board route passes `id => projectGroups.containing(id)`; mission create keeps `projectGroups.get(body.groupId)` (alias works) and passes the resolved group id into `missions.create({ ...body, groupId: group.id })` so the stored mission carries the stored id. Allow the new GET through `remote-access.ts` where `/api/project-groups` is allowed.

- [ ] **Step 4: Run** `node --import tsx --test tests/missions.test.ts tests/board.test.ts tests/project-groups.test.ts` → PASS; `npx tsc -p packages/host --noEmit` clean apart from Task 4 files.

- [ ] **Step 5: Commit** `feat(host): missions pin the primary checkout and board rows carry their project (INF-98)`

---

### Task 4: CLI shows checkouts and manages projects

**Files:**
- Modify: `packages/host/src/client.ts:573-595` (`listProjects`), `:239-241` (usage text)
- Modify: `packages/host/src/board-cli.ts:155-170` (`resolveMissionProject`), `:289-296` (`projects` subcommands)
- Modify: `tests/board-cli.test.ts`
- Modify: `docs/cli.md:45-60`

**Interfaces:**
- Consumes: `ProjectGroupList` with `kind`, `hidden`, `checkouts`; `GET /project-groups/:id`; `PUT /project-groups/:id` with `{ requestId, revision, name? | hidden? | primary? }`.

- [ ] **Step 1: Failing tests in `tests/board-cli.test.ts`**

Update the `project()` fixture helper to produce `kind`, `hidden: false`, and `checkouts` (primary first). Add:
- `resolveMissionProject` finds a group through a non-primary checkout id and returns `{ group, checkout }` where `checkout` is that host project id when the lookup went through a checkout (bound directory, or `--project HOST_ID`) and undefined when `--project` named a group id. `start` posts `{ requestId, groupId: group.id, objective, ...(checkout ? { checkouts: [checkout] } : {}) }`; assert the posted body in both cases.
- `projectsLines(list)` (new pure function in `board-cli.ts`, exported, returning string[]) renders: `sample  sample` then `  sample  (2 checkouts)` then `    sample-main  Infinite main  · primary` and `    sample-codex  Infinite codex`, then `Hidden` heading before hidden groups, then suggestions as today. Assert exact lines.
- Subcommand parsing: a fake `api` recording calls; `projects rename sample "Sample product"` → GET `/project-groups/sample` then PUT body `{ revision, name: "Sample product" }` plus a uuid `requestId`; `projects hide sample` → `hidden: true`; `projects show sample` → `hidden: false`; `projects primary sample sample-codex` → `primary: ["sample-codex"]`; a wrong arity throws the usage line `Usage: infinite projects [group NAME REPO_ID... | rename ID NAME | hide ID | show ID | primary ID CHECKOUT_ID]`.

- [ ] **Step 2: Run; expect failures** `node --import tsx --test tests/board-cli.test.ts`

- [ ] **Step 3: Implement.** `client.ts` `listProjects` prints through `projectsLines` (sync lines per checkout come from `GET /projects/:id` as today, appended to the checkout line). `handleBoardClientCommand("projects", …)` handles the four verbs.

- [ ] **Step 4: Update `docs/cli.md`** lines 45-60 with the new verbs and the checkout listing.

- [ ] **Step 5: Run the suite and `npx tsc -p packages/host --noEmit`** → clean.

- [ ] **Step 6: Commit** `feat(cli): list checkouts and manage projects (INF-98)`

---

### Task 5: Phone picker, composer, and board chips

**Files:**
- Modify: `apps/mobile/src/features/board/Composer.tsx`
- Modify: `apps/mobile/src/features/board/Board.tsx:22-70, 103`
- Modify: `apps/mobile/src/features/board/model.ts` (no behavior change; keep `filterBoard`)
- Modify: `tests/mobile-board-model.test.ts` (add a team item with `groupId` to the filter test)

**Interfaces:**
- Consumes: Task 1 phone model helpers; `PUT`/`POST /project-groups` through `api()`.
- Produces: `Composer` props become `{ connection; groups: ProjectGroup[]; items: BoardItem[]; suggestions: ProjectGroupSuggestion[]; onCreated; onManage: () => void; onChanged: () => void }`.

- [ ] **Step 1: Model test** — in the filter test, add `item({ kind: "team", groupId: "project" })` and assert it survives `filterBoard(items, "project")`.

- [ ] **Step 2: Composer.** Picker rows: `label={group.name}`, `detail={groupActivity(items, group.id)}`; iterate `visibleGroups(groups)`; the selected row above the input shows the same detail. Placeholder `What should we work on?`. After the rows: one `SheetRow` per suggestion, glyph `plus`, label `Combine ${names}` where names are the suggestion's `groupIds` mapped to group names joined with " and ", detail `Nothing is merged except the picker; each repository keeps its own settings.`; press → `POST /project-groups` `{ requestId: Crypto.randomUUID(), name: suggestion.name, repos: suggestion.repos }`, then `onChanged()`; a failure shows its message in the existing `message` slot. Last row: `SheetRow glyph="forward" label="Manage projects"` → `onManage()`. Owner-only rows for Combine (pass `owner` boolean or derive from `onChanged` presence; use an explicit `owner: boolean` prop).

- [ ] **Step 3: Board.** Chips from `visibleGroups(groups)`; pass `items`, `suggestions`, `owner`, `onManage={() => router.push({ pathname: "/projects", params: { machine } })}`, `onChanged={() => poll.refresh()}` into `Composer`. Keep the `projectId` filter state; if the selected id disappears from the visible list, reset to `""`.

- [ ] **Step 4: Checks** `npm run lint -w @infinite/mobile` and `cd apps/mobile && npx tsc --noEmit` → clean (the `/projects` route is created in Task 6; until then type the push target as a string path `"/projects"`; expo-router's typed routes may require the file to exist, so if `tsc` complains, create a placeholder `apps/mobile/src/app/projects/index.tsx` that Task 6 replaces).

- [ ] **Step 5: Commit** `feat(mobile): project picker without paths, combine suggestions, manage entry (INF-98)`

---

### Task 6: Phone Manage projects and project screens

**Files:**
- Create: `apps/mobile/src/app/projects/index.tsx`, `apps/mobile/src/app/projects/[id].tsx`
- Create: `apps/mobile/src/features/projects/ProjectsList.tsx`, `apps/mobile/src/features/projects/ProjectDetail.tsx`
- Modify: `apps/mobile/src/features/projects/model.ts` (add `projectSections`)
- Modify: `tests/mobile-projects-model.test.ts`

**Interfaces:**
- Consumes: `GET /project-groups`, `GET /project-groups/:id`, `PUT /project-groups/:id`, `DELETE /project-groups/:id`, `GET /me` (role), `ConnectedScreen`, `TopBar`, `Section`, `GroupHeader`, `SheetRow`, `Button`, `Alert`.
- Produces:
  ```ts
  export function projectSections(list: ProjectGroupList): { visible: ProjectGroup[]; hidden: ProjectGroup[]; suggestions: ProjectGroupSuggestion[] };
  ```

- [ ] **Step 1: Model test** — `projectSections` splits visible and hidden, keeps order, passes suggestions through.

- [ ] **Step 2: Routes.** Both routes use `ConnectedScreen` (see `app/cost/index.tsx`); `[id].tsx` reads `id` with `useLocalSearchParams` like `app/mission/[id].tsx`.

- [ ] **Step 3: `ProjectsList`.** Poll `/project-groups` and `/me` every 5 s with `usePoll`. `TopBar backLabel="Board"`. Title `Projects`. Rows (`SheetRow`-style pressable rows with a rule, title + one detail line) for visible projects: detail = `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}` plus ` · ${checkouts} checkouts` when the total checkout count exceeds the repository count. Section `Suggestions` (owner only) with Combine rows as in Task 5 (reuse by extracting `CombineRow` into `features/projects/CombineRow.tsx` and importing it from the Composer too). Section `Hidden` folded by default via `GroupHeader collapsed/onToggle`. Row press → `/projects/[id]`.

- [ ] **Step 4: `ProjectDetail`.** Poll `GET /project-groups/:id` and `/me`. `TopBar backLabel="Projects"`. Name field (`TextInput`, maxLength 100) with a `Save` button enabled when changed; save → `PUT { requestId, revision, name }`. One `Section` per repository titled with the repository name: a row per checkout showing the checkout label, `Primary` as a `Chip` on the primary, and the host path in a 12-size monospace line (`t.mono` from `features/teams/parts.tsx`); a row press on a non-primary checkout opens `Alert.alert(checkout.name, undefined, [{ text: "Make primary", onPress: PUT primary: [id] }, { text: "Move to its own project", onPress: PUT repos: members without id }, { text: "Cancel", style: "cancel" }])`. Below the sections: `Button secondary title={group.hidden ? "Show project" : "Hide project"}` → `PUT hidden`. For `kind === "owner"`: `Button secondary destructive title="Remove project"` with a confirm `Alert` → `DELETE { requestId, revision }` then back. Every mutation re-fetches; a 409 `stale-project-group-revision` re-fetches and shows `This project changed. Try again.`. Non-owners see no controls and a note `Only the owner can change projects.`

- [ ] **Step 5: Checks** mobile lint and tsc clean.

- [ ] **Step 6: Commit** `feat(mobile): manage projects and project detail screens (INF-98)`

---

### Task 7: Project-first Workspace choice on goal and session creation

**Files:**
- Modify: `apps/mobile/src/features/teams/GoalCreate.tsx:35, 113-115`
- Modify: `apps/mobile/src/features/create/Create.tsx:36-37, 90`

**Interfaces:**
- Consumes: `visibleGroups`, `groupContaining`, `primaryCheckout`, `checkoutsOf`; `GET /project-groups` polled alongside `/me` in both screens.

- [ ] **Step 1: GoalCreate.** Fetch groups with the screen's existing poll (add `/project-groups` to it). Replace the Workspace `Choices` values with visible group ids; label = group name, with ` · setup required` when no checkout of the group is team-ready. Selecting a group sets `projectId` to its team-ready primary (or primary). When the selected group has more than one checkout, render a second `Choices` labeled `Checkout` listing checkout ids with checkout names, selected = `projectId`. Keep the request shape. If `/project-groups` fails (older host), fall back to today's host-project chips.

- [ ] **Step 2: Create.tsx.** Same pattern for the "Workspace" buttons: group buttons, then checkout buttons when there are several; `projectId` sent unchanged.

- [ ] **Step 3: Checks** mobile lint and tsc clean.

- [ ] **Step 4: Commit** `feat(mobile): choose a project, then a checkout, when starting goals and sessions (INF-98)`

---

### Task 8: Documentation

**Files:**
- Modify: `docs/missions.md:13-40` (Projects), `:159-168` (Clients)
- Modify: `PRODUCT.md:62` (append one sentence)
- Modify: `docs/cli.md` (already touched in Task 4; verify)

- [ ] **Step 1:** Rewrite the Projects section to the spec's model: identity, repository, project kinds, primary, hidden, detach, alias, suggestions over whole repositories, API shapes. Clients: phone Manage projects and project screen; CLI verbs.
- [ ] **Step 2:** `PRODUCT.md:62` append: `Checkouts of one repository fold into one project automatically; grouping across repositories remains an explicit owner action.`
- [ ] **Step 3:** Run the AGENTS.md private-info scan on the full branch diff; resolve hits.
- [ ] **Step 4: Commit** `docs: projects over checkouts (INF-98)`

---

### Integration (coordinator)

- [ ] `npm run check` once in the worktree; rerun a flaky suite alone before blaming a change.
- [ ] Mobile: `npm run lint -w @infinite/mobile`, `cd apps/mobile && npx tsc --noEmit`.
- [ ] Emulator screenshots: picker, board chips, Manage projects, a project screen, against a host whose list has a folded repository (the mock-API pattern from the web screenshot memory adapts; or the live host after deploy).
- [ ] One strong read-only review of the combined diff with the test evidence; fix findings; rerun affected suites.
- [ ] Record outcomes in Linear INF-98; open the PR.
