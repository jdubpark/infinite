# Workspace retention, cancelled-run deletion, storage headroom, pnpm (INF-157)

## Intent

The host's state volume ran out of inodes twice in two days. Every team run keeps a full integration clone and one clone per member, each with its own dependency tree, and nothing ever removes them. Thirty-four cancelled and three merged runs held ninety-seven percent of the volume's inodes while bytes were plentiful. The owner's direction: completed work is pruned, data for cancelled and merged work is deleted, cancelled runs are replaced by new runs when the coordinator deems it necessary and are then deleted, dependency installs use pnpm where possible, and the host must not fall over when storage is short.

## Goals

- A run's clones disappear automatically once the run no longer needs them.
- Cancelled runs are deleted whole (clones and record) after a short settle window; the goal or mission that owned them keeps the reason and can dispatch a replacement.
- The host refuses to start a run when the workspace volume is below a floor instead of crashing mid-save, and it tells the owner when storage is low.
- `pnpm-lock.yaml` repositories install with pnpm from a shared content-addressable store on the state volume, so identical files share inodes across workspaces.

## Non-goals

- Changing RAID or filesystem geometry on the server (operator decision, separate).
- Deleting merged or reviewed run records. Only their clones go; the record, events, receipts and Linear trail remain.
- Migrating other repositories to pnpm from inside this change.

## Behaviour

### Retention (`config.teams.retention`, see `teamRetentionSchema`)

| Run status | Clones removed | Record |
|---|---|---|
| merged, no-change | `finishedMinutes` (default 60) after every member stopped, and never while the goal, mission or handoff that owns the run is still active (the next cycle clones from this workspace) | kept, `workspaceRemovedAt` set |
| cancelled | `cancelledMinutes` (default 60) after every member stopped | deleted with the clones |
| ready-for-review | `reviewHours` (default 24) after the status was reached | kept |
| blocked | `blockedHours` (default 72) after the status was reached | kept; the run can no longer resume |
| any active run | a stopped member whose result was integrated loses its clone after `memberMinutes` (default 60), unless a newer member still uses that directory | member keeps `workspaceRemovedAt` |

Removal never runs while the run has a pending operation, a live command, or a member that is not stopped, and a stopped member's clone is kept while a newer member still uses it as its working directory. A failed removal is an event on the run and is retried on later ticks; it never blocks the run. Resuming or continuing a run whose workspace was removed is refused with `team-workspace-removed`.

Removal runs the agent-owned clones through the team command prefix (`rm -rf -- integration members` with the run directory as cwd, which the gate admits inside a team root) and then removes the host-owned run directory itself. Without a prefix the host removes the tree directly.

### Deleting a run

`TeamService.removeRun(id)` deletes the clones and the record of a run whose status is cancelled, merged or no-change and whose members have all stopped. Anything else is refused with `team-active`. It is exposed as `DELETE /api/teams/:id` and `infinite team delete ID`. Missions delete their cancelled subteams automatically once settled, clearing `subtask.teamId` and keeping the subtask's final status and reason; the coordinator prompt says to dispatch a replacement subtask when the work is still needed. Goals do the same for cancelled cycles.

### Storage headroom

`volumeUsage()` reports bytes and inodes for a path. `createRun` refuses with `host-storage-low` (507) when the workspace volume is under `config.teams.storageFloor` (defaults 300k inodes, 2 GiB). `/api/machine/resources` reports inodes next to bytes and adds the host's state and workspace volumes. The notifier emits a `host-storage` push (configurable, on by default) when a volume crosses 85 percent and again at 95 percent, once per crossing.

### Crash hardening

`block()` and the two stop paths no longer fire `invalidatePermissionDecisions` unobserved; a failed save inside them becomes an event, not an unhandled rejection. The scheduler tick keeps its catch.

### pnpm

`repo init` infers `pnpm install --frozen-lockfile` and `pnpm run <check>` when `pnpm-lock.yaml` or a `packageManager: pnpm@…` field is present, npm otherwise. The agent wrapper exports a pnpm store directory on the state volume so installs hardlink into one store. Implementers are told to use the repository's package manager. Agent temp directories under the shared agent `TMPDIR` are aged out by a tmpfiles rule.
