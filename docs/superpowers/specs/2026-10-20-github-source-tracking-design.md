# GitHub-tracked project sources

Status: draft for owner approval, 2026-10-20.

## Intent

Enrolled repositories that live on GitHub should stay current on the cloud host
without the owner running `infinite sync` from the laptop. GitHub becomes the
source of truth for those projects. The laptop pushes to GitHub as it does
today; the host follows the repository's base branch on its own; team runs start
from the current base; delivered work reaches GitHub from the host; and the
host picks the merge up by itself. The owner never thinks about syncing.

### Why now

The host holds a one-time snapshot of each enrolled repository, taken at
`repo init`. It does not follow GitHub. Every team run clones that snapshot, so
runs start from whatever commit the owner last uploaded. On 2026-10-19/20 runs
built on a base fifty commits behind `main` and spent their budget on rebase
conflicts. Refreshing the snapshot requires `infinite sync`, which copies the
whole laptop folder including ignored files (an 858 MB `node_modules` in one
case), stops on `cloud-changed` whenever a cloud session wrote any file, and then
needs `--apply --force`. The owner has said they should not have to care about
any of this.

## Goals

- A project enrolled from a GitHub repository follows its base branch on the
  host automatically, with no laptop process involved.
- A team run's base commit is the base branch head as of run start, fetched
  fresh. A run never starts on a base the host knows is behind GitHub without
  saying so.
- Merged work, whether merged by the host (`--delivery merge`) or by the owner
  on GitHub, appears on the host within minutes without any command.
- The owner can see at a glance, from the CLI and the apps, that laptop, GitHub,
  and host are on the same commit, and when they are not, which one is behind
  and why.
- Enrollment of a GitHub repository needs no new per-repository step beyond
  what delivery already needs (the GitHub App installation for private
  repositories).

## Non-goals

- Replacing workspace sync for folders that are not GitHub repositories, or for
  owners who want the host to mirror an uncommitted laptop tree. Workspace sync
  stays as it is for projects in `laptop` source mode.
- Two-way sync of working trees. Code moves through Git commits only.
- Pushing the owner's laptop commits to GitHub on their behalf. Unpushed laptop
  work is reported, never pushed.
- GitHub webhooks. The GitHub App keeps webhooks disabled; the host polls.
- Changing provider permission rules, branch protection, or the honesty rules in
  `PRODUCT.md`.

## Anti-goals

- Losing work. The host never discards tracked edits a session made in the
  project directory, and never overwrites a team's integration branch.
- Silent staleness. If the host cannot reach GitHub or cannot fast-forward, every
  surface that shows the project says so, and team runs record the base they
  actually used.
- A new allow-list the owner has to edit per repository (see
  `minimal onboarding friction` in the team conventions).

## Constraints the builder must honor

- **Credentials live with the agent identity.** On the Ubuntu template the
  GitHub App token is reachable only through the agent account's Git credential
  helper. Every network Git command against GitHub therefore runs through
  `teams.commandPrefix` as the agent identity, never as the API account. Public
  repositories need no token but still run through the prefix for uniformity.
- **Agent-writable Git metadata is untrusted.** A project directory's `.git`
  (hooks, `config`, filters) can be edited by agents. Any Git command that could
  run hooks or filters in that directory also runs through the prefix, never as
  the API account.
- **The live launcher is instance-specific.** The constrained launcher on the
  production host allows an exact set of Git operations. New operations (fetch
  from a GitHub remote, fast-forward in a project source, clone from a mirror)
  need an owner-approved launcher edit before deployment. The design must list
  the exact operations it introduces so that edit can be reviewed once.
- **Workspace sync's drift check.** Workspace sync compares the live tree to the
  scan taken after its last apply. A project that the host fast-forwards must
  not also be the target of laptop sync, or every laptop upload will report
  `cloud-changed`. The two modes are exclusive per project.
- **Running sessions.** As with sync apply, the host does not change the project
  working tree while a cloud session in that project is running or starting.
  Team runs use their own clones and are not affected.
- **Private information.** Nothing in code, docs, tests, or fixtures names a
  real repository, account, host, or laptop path.

## Design

### Source modes

Each project gains a `source` record:

```json
{
  "mode": "github",
  "repository": "OWNER/REPO",
  "baseBranch": "main",
  "remoteUrl": "https://github.com/OWNER/REPO.git"
}
```

or `{ "mode": "laptop" }`, the current behavior. Existing projects are
`laptop` until re-enrolled. The record is sealed host state like the sync
mapping and delivery policy.

`infinite repo init` records `github` when `origin` is an HTTPS or SSH
`github.com` URL without embedded credentials, using the same reading the
`--delivery merge` path uses today (base branch from `origin/HEAD`, else local
`main` or `master`, else `--base-branch`). This no longer depends on the
delivery setting. `--source laptop` opts out and keeps workspace sync.
`--source github` on an existing enrollment switches modes; switching stops any
recorded laptop sync service for that project and tells the owner. Enrollment of
a `github` project still uploads the one-time snapshot so the project directory
exists immediately; the first refresh then takes over.

While a project is in `github` mode, the laptop sync routes for it answer `409`
with code `source-github` and a message naming `--source laptop`. `infinite sync`
without `--project` from such a checkout prints that the project follows GitHub
and exits without starting a service.

### Host mirror

For each `github` project the host keeps a bare mirror, owned by the API
account and readable by the agent group, outside the project directory and
outside any agent-writable tree. The builder chooses the location; it must be
covered by the launcher's clone-source rule and must survive sync applies (which
replace the project directory wholesale).

The project directory that `repo init` uploads today is a detached checkout
with its `origin` remote removed. It stays that way: the mirror is the only
thing on the host that knows the GitHub URL, and the working tree is kept
detached at the base head. Fetching into the working tree uses the mirror path
directly and a `refs/remotes/origin/BASE` tracking ref; no remote is added.

**Refresh** is one unit of work per project:

1. `git fetch` the base branch from GitHub into the mirror, through the command
   prefix. Record `fetchedAt`, the new head, and on failure a category
   (`auth`, `network`, `not-found`, `other`) and a fixed message with no URL or
   token.
2. If the mirror head moved and no cloud session is running or starting in the
   project directory, fast-forward the working tree to it (fetch from the mirror,
   then `checkout --detach` the new head, which is a fast-forward because of the
   ancestry check below), through the command prefix. Record `appliedAt` and the
   applied head. Only sessions that execute in the project directory hold this
   step. Team runs, goals, and blocked runs do not, because they work in their
   own clones; this is deliberately narrower than the hold sync apply uses.
3. If tracked files in the working tree differ from its `HEAD` (a session left
   edits), do not discard them. Commit them on a local branch named
   `infinite/saved-DATE-8HEX` with a fixed message, return to a clean detached
   tree, fast-forward, and record the saved branch on the project so the CLI
   and apps show it. Untracked and ignored files stay where they are, so
   installed dependencies survive a refresh.
4. If the working tree's `HEAD` is not an ancestor of the new base (someone
   committed on the host), leave the tree alone and record reason `diverged`
   with both commits. The owner or coordinator resolves it.

Refresh runs:

- on a timer, every 5 minutes per `github` project (configurable, minimum 1
  minute), skipping projects whose last fetch is younger than the interval;
- immediately before a team run or goal prepares its workspace;
- immediately after the host records a delivery merge for the project;
- on demand from `POST /api/projects/:id/source/refresh`, which the CLI exposes
  as `infinite repo refresh` and the apps as **Refresh from GitHub**.

A refresh in flight holds the project the way a sync apply does: new sessions in
it wait with `409 source-refreshing` for the few seconds a fast-forward takes.
The fetch step does not hold the project; only the working-tree step does.

### Team runs

A team run for a `github` project clones from the mirror, not from the project
directory, after a refresh. `baseCommit` is the mirror's base-branch head at that
moment. The clean-source check that today refuses a run with `project-dirty`
when a session left an untracked file in the project directory no longer
applies, because a bare mirror is always clean. If the refresh's fetch failed,
the run still starts from the mirror's last known head, and the team record, its
Linear issue, and the status views carry `baseStale: { fetchedAt, reason }`
until the next successful fetch. This is my call: the owner prefers progress
over blocking, and delivery merge rebases onto the live base anyway; the
warning keeps it honest.

Goal and mission continuations keep cloning from the parent run's integration
checkout, as today. Setup (`pnpm install`, `npm ci`) runs in each clone as
today. Nothing in this design changes the clone layout, branch names, or
integration flow.

### Delivery back to GitHub

The host never pushes or merges on its own. As today, a delivery member does
it with the provider's GitHub tools and reports; the host validates the report
against the reviewed head and records it as agent evidence.

`--delivery merge` keeps its meaning. After the host records a merge report, it
refreshes the project, so the merged commit is on the host before the owner
reads the result.

A new middle setting, `--delivery pr`, authorizes the delivery member to push
the integrated `infinite/team-*` branch to the configured repository and open a
pull request against the base branch, then stop. The report carries
`headCommit` and the PR URL; the host checks the URL names the configured
repository and records it; the run reaches a new terminal status `pr-open`
that counts as done for project holds, like `ready-for-review`. The owner
reviews and merges on GitHub from any device; the timer picks the merge up.
This removes the laptop from the review path (`team pull`, push, open PR)
without granting merge authority. `team pull` still works on a `pr-open` run.
`review` stays the default for new enrollments. `pr` requires the same strong
coordinator and reviewer that `merge` requires.

### What the owner sees

`infinite projects`, `infinite repo status`, and the project line in the Create
screens show, for a `github` project:

```
seat-project  Projects/sample  follows github OWNER/REPO@main
  host f811c1d8 = origin/main · fetched 2m ago · applied 2m ago
```

and when something is off, one of:

```
  host 0a3a8aaf, origin/main f811c1d8 (2 commits ahead) · fetch failed 14m ago: auth
  host 0a3a8aaf, origin/main f811c1d8 · waiting: session running
  host f811c1d8 = origin/main · saved local edits on infinite/saved-20261020-1a2b3c4d
  host diverged from origin/main: host 9c0d... is not on main
```

From an enrolled checkout, the CLI also compares the laptop: `laptop f811c1d8 =
origin/main`, or `laptop has 2 unpushed commits; the host runs origin/main`, or
`laptop is 3 commits behind origin/main`. This needs no new host call; the CLI
reads the local repository and the project record.

Before a cloud launch from an enrolled checkout, the CLI prints the one-line
comparison instead of today's "Laptop changes are pending" line.

`GET /api/projects/:id` returns `source` with `mode`, `repository`,
`baseBranch`, `mirrorHead`, `appliedHead`, `fetchedAt`, `appliedAt`,
`pending: { reason, category?, message?, savedBranch?, since }`. Pending reasons:
`session-running`, `fetch-failed`, `diverged`, `apply-failed`.

### Migration for projects enrolled today

Re-running `infinite repo init` in an enrolled GitHub checkout switches it to
`github` mode. The first refresh fetches into a new mirror and fast-forwards
the existing snapshot directory. Ignored files already on the host (installed
dependencies, generated reports) stay. Tracked edits made by earlier sessions
are saved to a branch as above. The CLI prints the resulting state.

### Launcher operations this design adds

For the owner's review of the production launcher, the host runs these through
the prefix and nothing else new:

- in a host-owned mirror: `git fetch REMOTE_URL +refs/heads/BASE:refs/heads/BASE`
  (exact GitHub URL from the project record);
- in a project source: `git fetch MIRROR_PATH +refs/heads/BASE:refs/remotes/origin/BASE`,
  `git checkout --detach SHA`, `git status --porcelain`, `git rev-parse HEAD`,
  `git merge-base --is-ancestor A B`, and for saving edits `git checkout -b
  infinite/saved-*`, `git add -A`, `git commit -m FIXED`;
- in a team run: `git clone MIRROR_PATH` in place of the project-source clone;
- nothing new for `--delivery pr`: the delivery member pushes with its own
  tools from its member clone, as the merge path does today.

Deployment of the host change waits for that launcher edit; the host must
report a launcher refusal as `apply-failed` with category `permission`, not as
staleness.

## Left to the builder

- Mirror location and its permission bits; the hold/lock shared with sync apply
  and session admission; the timer's placement in the host scheduler.
- Exact wording of the status lines and app strings, within the shapes above.
- Whether the SSH form of a `github.com` origin is rewritten to HTTPS for the
  host fetch (recommended: yes, the App token is HTTPS-only) and how that is
  shown to the owner.
- Tests: unit tests for mode selection and the fast-forward/save/diverge state
  machine against a local bare "GitHub" repository; a host test that a team run
  pins the mirror head; CLI tests for the comparison line. No test touches the
  network.

## Decisions for the owner

1. GitHub becomes the source of truth for enrolled GitHub repositories by
   default at the next `repo init`; laptop sync stays available by opt-out.
2. Add `--delivery pr` so reviews happen on GitHub without a laptop step.
3. The host saves, rather than refuses, tracked edits a session left in the
   project directory, on a dated local branch.
4. A failed fetch warns and proceeds rather than blocking a team run.
