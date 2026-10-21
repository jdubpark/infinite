# Projects over checkouts

Status: design for build, 2026-10-21. Decisions marked **(call)** are the
author's; the owner can overturn them.

## Intent

The owner picks a product, writes what they want, and the coordinator works out
which repository and checkout to use. Today the phone's "Choose a project" sheet
lists every enrolled host directory: four provider worktrees of one repository,
a synced snapshot of the same repository, a throwaway checkout under `.local`,
and paths such as `Projects/SmartAlarm/codebase`. Twelve rows stand for four
products. Nothing in the apps lets the owner rename, hide, or fold them.

A **project** becomes the only thing the owner chooses. It groups one or more
**repositories**; each repository may have several **checkouts** on the host.
Checkouts of one repository fold together automatically. Paths and checkout
names leave the picker and the board and move to a detail screen.

### Why now

The board and the mission composer shipped (INF-56) on top of the host project
list as it was. Live, that list is twelve single-checkout projects, of which
seven are checkouts of the one `infinite` repository. The owner's words: "these
project names and paths are all over the place and there's also so many
worktrees for one name."

## Goals

- The picker shows one row per product, named like a product, with no paths.
- Several checkouts of one repository count as one repository, automatically.
- The owner can rename a project, hide it, combine projects, split a checkout
  out, and choose which checkout a project's work runs in.
- A mission's coordinator sees one entry per repository and dispatches to that
  repository's chosen checkout; it is not told about stale duplicates.
- Board filter chips and rows use the same project names, and filtering by
  project keeps every run of that project, including standalone team runs and
  goals.
- Older clients keep working against the new list without changes.

## Non-goals

- A web board or web mission composer. The web client has neither today; it
  keeps its session and goal forms. Its "Workspace" select is unchanged.
- Changing which repository a session or team actually runs in, or how a
  checkout is enrolled, synced, or refreshed.
- An ideas backlog per project. The mission objective is the idea; the
  coordinator plans from it as it does now.
- Merging project context, Linear mappings, delivery policies, or permission
  delegation across repositories. These stay per host project
  (`docs/missions.md`, "Projects").
- Mac app changes beyond what the new list gives it for free.

## Anti-goals

- Guessing that two different repositories are one product. Folding happens
  only for checkouts whose Git identity says they are the same repository.
  Cross-repository grouping stays an explicit owner action, as `PRODUCT.md`
  requires for anything inferred from a parent folder, a Linear mapping, or a
  similar name.
- Losing a mission's target under the owner's feet. A running mission keeps the
  checkouts it pinned at start, whatever the owner renames, hides, or regroups.
- Showing a hidden project's work nowhere. Hidden only removes the project from
  the picker and the chips; its runs remain under "All" and the project remains
  one tap away in the management screen.

## Constraints the builder must honor

- `PRODUCT.md`: context binding stays per project and codebase; nothing here
  shares context. The host never infers task completion.
- `docs/missions.md`: a repository belongs to at most one owner-created group;
  mission `repoProjectIds` pin host project IDs; subteams reserve their own
  repository only.
- Private information: no real repository, account, host, or laptop path in
  code, tests, docs, or fixtures. Tests use placeholder remotes such as
  `https://github.com/example/sample.git`.
- Sealed host state carries the stored groups (`stateDir/project-groups`).
  Old state must load; the schema gains optional fields only.
- Git commands the host runs against a project directory must not execute
  hooks or filters. Identity capture uses `git config --get remote.origin.url`
  and `git rev-list --max-parents=0 HEAD`, both hook-free, and runs once per
  checkout.
- Agent-writable Git metadata is untrusted (`docs/security.md`). The design
  below captures identity once and turns later changes into suggestions rather
  than regrouping on its own.

## Design

### Model

Three nouns, two of which exist already.

| Noun | Today | After |
|---|---|---|
| Checkout | A host project: `{ id, name, path }` from config or a mirrored folder. | Unchanged. Gains a sealed **identity** record. |
| Repository | Not modeled. | Checkouts with the same identity key. Has a **primary** checkout. |
| Project | A `ProjectGroup`: owner-created, or implicit per ungrouped host project. | A stored `ProjectGroup` with a `kind`, a `hidden` flag, and repositories made of checkouts. |

**Identity.** The host derives one key per checkout, in this order, and stores
it sealed beside the groups the first time it sees the checkout:

1. The project's GitHub source record when one exists (branch
   `feat/github-source-tracking`, INF-97): `remote:github.com/OWNER/REPO`.
2. `remote.origin.url` of the checkout on the host, normalized: scheme, user
   info, and a trailing `.git` dropped, host lowercased, `ssh` and `https`
   forms of the same repository equal. Key `remote:HOST/PATH`.
3. The repository's earliest root commit, `git rev-list --max-parents=0 HEAD`,
   lowest hash when there are several. Key `root:HASH`.
4. None. The checkout is not a Git repository or Git failed; it stays a
   single-checkout project as today.

The record is `{ projectId, key, repoName, capturedAt, from: "source" |
"host-scan" }`. Suggestions are computed over projects of kind `repository`
and `implicit` only, never over an `owner` project: shared parent folder of
the primary paths, or shared Linear project of any checkout. A suggestion
lists every checkout of every project it would combine, so accepting it with
one `POST` moves whole repositories. `repoName` is the last path segment of the remote, or for a
root-only key the checkout's folder name, unless that name is one of
`codebase`, `code`, `src`, `repo`, `app`, `main`, `worktree`, in which case
the parent folder's name is used (`Projects/SmartAlarm/codebase` →
`SmartAlarm`) **(call)**.

A checkout's identity is captured once and never rescanned **(call)**. An
agent that later edits `.git/config` cannot regroup projects; the owner
regroups by hand in the management screen. A checkout whose identity capture
failed is retried on each list until one succeeds, because a failure stores
nothing.

**Repository.** Within a group, checkouts are folded by identity key into
repositories. Each repository has exactly one primary checkout. The default
primary is chosen in this order **(call)**: the owner's stored choice; a checkout
with a GitHub source record; a team-ready checkout (has `team.checks` or
`establishChecks`) with the most recent sync apply; the most recently applied
checkout; the shortest host path; lowest id. The default is recomputed at list
time; an owner choice is stored on the group as `primary: { [key]: projectId }`
and survives until that checkout leaves the group.

**Project kinds.**

- `owner`: created or edited by the owner. Exists today.
- `repository`: created by the host, one per identity key that no stored group
  already contains a checkout of. Its id is the slug of `repoName`, made unique
  like owner-group ids are today, and persisted so missions, chips, and links
  keep a stable id. Its name starts as `repoName`.
- `implicit`: a checkout with no identity and no group, as today. Not stored;
  id equals the host project id.

A `repository` group that the owner renames, hides, edits, or sets a primary on
keeps `kind: "repository"`; the owner's fields simply override the defaults.
Adding a checkout of a different repository turns it into `owner`.

**Automatic folding rule.** Groups hold checkouts; identity keys only decide
where a checkout the host has not placed yet lands. On every list, for each
checkout with an identity that no stored group holds: candidate groups are the
stored groups holding a checkout with the same key whose `detached` list does
not name this checkout; it joins the candidate with the most checkouts of that
key, then the earliest created. With no candidate the host creates a
`repository` group. A checkout the owner removed from a group is recorded in
that group's `detached` list and never returns to it on its own. Two stored
groups may therefore hold the same key (after "Move to its own project"); the
second one gets the next free slug (`sample-2`) and the same default name, and
the owner can rename it.

Identity capture that fails (no `.git` yet, Git error, timeout) stores nothing
and is retried on a later list, at most once a minute per checkout, so a
mirrored folder that is empty until its first sync apply folds once the tree
arrives.

**Hidden.** `hidden: boolean` on a stored group. Hidden projects are omitted
from the picker, the board's chips, and the goal and session project choices,
and are listed in the management screen under "Hidden". Missions can still be
created for them through the CLI. A new `repository` group is never hidden by
default; nothing hides on its own **(call)**.

### Name rules

Project name: the stored name. Defaults: `repository` groups use `repoName`;
owner groups use what the owner typed. Checkout label: the host project's
existing `name` (for example `Infinite · codex worktree`), shown only in the
detail screen. Never a host path in a list row. The detail screen shows the
host path in a monospace line because the owner sometimes needs it to read a
CLI command; **(call)**.

### API

`GET /api/project-groups` → `ProjectGroupList`, any paired role.

```ts
interface ProjectGroup {
  id: string;
  name: string;
  kind: "owner" | "repository" | "implicit";
  hidden: boolean;
  repos: ProjectGroupRepo[];            // one per repository
  implicit: boolean;                    // kept: kind === "implicit"
  revision: number;
  createdAt: string;
  updatedAt: string;
}
interface ProjectGroupRepo {
  projectId: string;                    // the PRIMARY checkout's host project id
  name: string;                         // repository display name (repoName or the host project name when no identity)
  path: string;                         // primary checkout's host path
  key?: string;                         // identity key; absent when none
  checkouts: ProjectGroupCheckout[];    // every checkout of this repository in the group, primary first
}
interface ProjectGroupCheckout {
  projectId: string;
  name: string;                         // host project name
  path: string;
  primary: boolean;
  teamReady: boolean;
  identityFrom?: "source" | "host-scan";
}
interface ProjectGroupSuggestion {
  name: string;
  repos: string[];                      // every host project id of every project involved
  groupIds: string[];                   // the projects that would combine, for display
  reason: "shared-parent" | "shared-linear-project";
}
```

`repos[].projectId`, `name`, and `path` keep today's meaning for one checkout
per repository, so the Mac app and the CLI's existing rendering show the folded
list without changes. `implicit` stays for the same reason.

`GET /api/project-groups/:id` accepts a group id or a host project id; a host
project id resolves to the group containing that checkout. `POST /api/missions`
accepts the same aliasing in `groupId` so an old chip, link, or
`infinite start --project HOST_ID` keeps working. The mission stores the
resolved group id.

`PUT /api/project-groups/:id` (owner, `requestId`, `revision`) gains:

```ts
{ name?: string; repos?: string[]; hidden?: boolean; primary?: string[] }
```

`repos` lists host project ids (up to 64). Removing a checkout detaches it
(recorded); adding a checkout held by a `repository` group moves that one
checkout (the old group's `detached` list gains it, and an emptied
`repository` group is deleted with its id tombstoned); adding a checkout held
by an `owner` group is refused with 409 `project-group-repo-conflict`, the same
rule `POST` applies. `primary` lists host project ids to make primary, at most
one per repository; an id not in the group is a 400. Editing an `implicit`
group first materializes it as a stored `owner` group with the same id.

`POST /api/project-groups` (owner) is unchanged in shape apart from the 64
limit. Its `repos` may name checkouts held by `repository` groups; those move
as above. Checkouts held by an `owner` group conflict (409), as today.

`DELETE /api/project-groups/:id` on a `repository` group releases its
checkouts, which fold again into a fresh `repository` group with a new id on
the next list. On an `owner` group, as today.

`GET /api/board`: every item carries `groupId` and `projectName` of the project
that contains its host project, teams and goals included. Today only missions
carry `groupId`, so a chip filter drops the other rows (`missions.ts`, board
assembly). The row keeps `projectId` for the checkout.

### Missions

`POST /api/missions` resolves the group, then builds the coordinator's
repository list with one entry per repository: the chosen checkout's host
project id, the repository name, its path, and `teamReady`. The chosen checkout
is, in order: one named in the request's optional `checkouts: string[]` (host
project ids; an id outside the group is a 400) for that repository; the
primary when team-ready; any team-ready checkout, with a mission event saying
the primary was not configured **(call)**; else the primary. Alternate
checkouts are not listed to the coordinator. The mission pins the chosen host
project ids in `repoProjectIds` as today; later edits to the group do not
change a running mission.

The CLI passes `checkouts: [HOST_ID]` when `infinite start` runs from a bound
checkout without `--project`, and when `--project` names a host project id, so
starting a mission from a worktree still targets that worktree's cloud copy.
The phone never passes `checkouts`.

Hidden projects accept missions. Mission `groupName` is the project name at
start.

### CLI

`infinite projects` prints one line per project, then one indented line per
repository, then its checkouts further indented with `primary` marked, then
suggestions. Hidden projects print under a trailing "Hidden" heading. `--json`
prints the list as is.

`infinite projects group NAME REPO...` is unchanged. New:
`infinite projects rename ID NAME`, `infinite projects hide ID`,
`infinite projects show ID`, `infinite projects primary ID HOST_PROJECT_ID`.
Each maps to one `PUT`. **(call)** These four exist so the owner can manage
projects without the phone; they are thin.

`infinite start` without `--project` resolves the current checkout's host
project id to its project and sends that checkout in `checkouts`. The CLI
resolves on the client before posting, so an older CLI against the new host
fails with "Unknown project ID" from a non-primary checkout until it is
updated; the CLI ships with the host and the owner updates both together
**(call)**.

### Phone

**Picker sheet** (`features/board/Composer.tsx`). Rows show the project name
and one detail line: counts of that project's board items that are not ended
(`1 working · 2 to review`), or `Nothing running`. Repository counts and paths
are gone. Hidden projects are absent. Suggestions appear after the rows as one line each,
`Combine Castik backend and Castik frontend`, with a **Combine** control that
creates the owner group named by the suggestion. The sheet ends with a
**Manage projects** row.

**Composer.** Placeholder `What should we work on?`; multi-line. Request shape
unchanged: `{ requestId, groupId, objective }`.

**Board.** Chips are the non-hidden projects, in list order. Rows show the
project name chip for every item kind.

**Manage projects** (`app/projects/index.tsx`). Sections: Projects, then
Suggestions, then Hidden (folded by default). A row opens the project.

**Project screen** (`app/projects/[id].tsx`). Name field with Save. Then one
section per repository: repository name, its checkouts as rows with the
checkout label, a `Primary` marker, and the host path in a small monospace
line; a row's menu offers **Make primary** and **Move to its own project**.
Below: **Hide project** or **Show project**. For an `owner` group, **Remove
project** (checkouts fold back into repository groups) after a confirm. Owner
only; controllers and viewers see the screen read-only.

**Goal and session creation** (`features/teams/GoalCreate.tsx`,
`features/create/Create.tsx`). The "Workspace" choice lists non-hidden
projects by name. When the chosen project has one checkout, nothing else is
asked and that checkout's host project id is sent. When it has several, a
second choice "Checkout" appears with the primary preselected, labeled with the
checkout label. The request shapes are unchanged.

All copy stays terse and in sentence case; rows, not cards; technical detail in
the detail screen only (DESIGN.md, Navigation).

### Migration and compatibility

- Existing stored groups load; missing `kind` reads as `owner`, missing
  `hidden` as false, missing `detached` and `primary` as empty.
- On the first list after deploy, the host captures identities for every
  configured checkout and creates `repository` groups. Live, this folds the
  seven `infinite` checkouts into one project and the two Castik checkouts stay
  two projects with a `shared-parent` suggestion. Captured identities are
  sealed; the scan does not repeat.
- Old mission records keep their `groupId` and `groupName`; the alias rule makes
  an old implicit id resolve to its folded project.
- The branch builds on `main`. The GitHub source record (INF-97, still on its
  own branch) is a one-line merge point: when `project.source.repository`
  exists, identity capture uses it with `from: "source"` and skips the scan.
- Hidden projects stay in `GET /api/project-groups` with `hidden: true`; the
  Mac app, which is out of scope, keeps showing them until it filters.
- Mac app and CLI render `repos[]` as before and show the folded list.
- `docs/missions.md` "Projects" is rewritten to this contract; `docs/cli.md`
  gains the new subcommands; `PRODUCT.md` adds one sentence: checkouts of one
  repository fold into one project automatically, and grouping across
  repositories remains explicit.

### What is left to the builder

- Exact zod schemas, sealed-state version bump, and the identity cache file
  layout.
- How the host runs the two Git commands (existing `execFile` helpers with a
  timeout; failure means no identity).
- Phone layout details within DESIGN.md: which existing `Glass` parts to use,
  the menu control for a checkout row, and how the name field saves.
- Test placement: extend `tests/project-groups.test.ts`, `tests/missions.test.ts`,
  `tests/board.test.ts`, `tests/board-cli.test.ts`, and the mobile model tests.

## Acceptance

- Host tests: two checkouts with the same normalized remote fold into one
  `repository` group with a stable id; ssh and https forms of one remote fold;
  a root-only identity folds; a checkout with no identity stays implicit;
  rename, hide, primary, detach, move, and delete behave as specified and
  survive a service restart; a mission for a folded project lists one
  repository per key and pins the primary; board items of every kind carry
  `groupId`; a host project id resolves as a group alias.
- CLI tests: `projects` renders checkouts and hidden projects; the four new
  subcommands send the expected `PUT`.
- Phone: `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` in
  `apps/mobile` pass; screenshots of the picker, the board with chips, Manage
  projects, and a project screen on the Android emulator against a host whose
  list contains a folded repository.
- `npm run check` passes.
- No private information in the diff (AGENTS.md scan).
