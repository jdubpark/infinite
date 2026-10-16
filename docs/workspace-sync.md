# Workspace sync

Workspace sync keeps a configured cloud project directory current with the owner's laptop checkout. It is one way, laptop to cloud. The cloud directory is the executing copy for every cloud session in that project. Changes made there travel back only through `infinite pull`, into a new directory. Command usage is in the [CLI guide](cli.md#workspace-sync-and-pull).

## Laptop side

`infinite sync --project ID`, run inside a checkout, starts a detached service for the Git root of the current directory, or for the directory itself outside a Git repository. The service captures the tree with the same scanner the `--laptop` mode uses: bounded SHA-256 chunks, stable reads, metadata verification, and a full read every minute. Scope and capture rules are those of [project scope and checkpoints](hybrid-execution.md#project-scope-and-checkpoints), with exactly one root, so the root's own `.git` directory travels too. When the root is a linked Git worktree, the upload also includes Git metadata from outside the root: the common repository's objects, refs, ref logs, packed refs, and a projected `config`. A Git config can carry credentials, such as a token in a remote URL or an `http.extraheader`. `--project` defaults to the paired project.

The service rescans every few seconds and uploads only when content, layout, or modes changed. Each upload begins a generation, asks the host which chunks it lacks with `POST /api/projects/:id/sync/has`, sends those with `PUT /api/projects/:id/sync/blob/:hash`, then commits the manifest. `infinite sync` returns after the first commit. The service reports progress while it captures, uploads, and waits for the host to apply that commit, so a first upload of a large tree can take many minutes. Startup fails only if the service reports nothing for 60 seconds or keeps failing before its first commit; chunks already uploaded stay on both sides, so running `infinite sync` again resumes. A commit request may wait up to 30 minutes for the host's apply.

It records its pid, root, and last commit beside the private client configuration under `sync/`, next to its local chunk store; both must lie outside the synced checkout. Closing the terminal leaves it running. It does not restart after a reboot; run `infinite sync` again. One service runs per project, and a second start is refused until the first is stopped.

`infinite sync --stop` signals the recorded pid only after confirming that the process still runs as the sync service, then removes the record. `infinite sync --status` lists each project's local service and, when the host answers, its sync state. Both work without reaching the host. A record whose process is gone, after a crash or reboot, is reported as stale.

Transient failures are retried every few seconds, and `--status` shows the current problem. A host refusal with 401, 403, or 404, such as a revoked device key or a removed project, stops the service. It does not run unless the owner started it.

## Host side

The host stores received chunks and the newest manifest for each project under its private state directory. Manifest and apply records are sealed with the host key. Chunks are plaintext files and need [encrypted host storage](security.md#required-on-a-real-host). Upload and export routes accept only a paired owner bearer key; a browser session is refused.

The host verifies each chunk against its hash and accepts request bodies up to 1 MiB. Presence checks take at most 512 hashes. A commit is parsed after owner authentication, with a 32 MiB JSON limit. It is refused when a newer generation has begun, when the manifest has more or fewer than one root, or when it names a chunk the host does not have.

A committed manifest is **applied** when no cloud session is running or starting in that project and the live cloud tree still matches the scan the host took right after the last apply. The comparison ignores the Infinite-owned `.infinite/` directory. Before the first apply, the directory must be empty apart from `.infinite/`. A manifest whose entries equal the applied generation is recorded as applied without replacing the tree.

Applying materializes the tree in a sibling stage directory, moves the current directory to `.NAME.infinite-previous` (replacing the older copy), and renames the stage into place. The cloud project's `.infinite/` directory moves into the new tree. A `.infinite/` directory from the laptop is discarded, so the cloud copy wins. If a step fails, the live tree and its `.infinite/` directory are moved back and the error is reported. After a successful apply the host scans the new tree, and that scan is the reference for the next drift check. The host refuses a project path that is the filesystem root, the host account's home directory, or a directory holding the host's own state.

When cloud agents run under a different Unix account from the host, as in the [Ubuntu template](../deploy/ubuntu/README.md#separate-identities-and-directories), the applied tree must be writable by the agent and every file the agent creates must stay readable and removable by the host. The host materializes for a shared group when the project directory's parent has the setgid bit or the config sets `sync.sharedGroup: true`: directories 2770, files group read/write, and group execute where the laptop file is executable. Otherwise files keep the laptop's modes. A default ACL granting the group `rwx` must sit on that parent, because each apply renames a tree staged beside the project directory into place and new directories inherit the parent's default ACL. Without it, files an agent creates under `umask 077` block drift scans and the next apply. `.infinite/` must stay writable by the host, which moves it into each new tree. The agent account also needs a scoped Git `safe.directory` entry, since the host owns the repository.

While a commit or apply holds a project, `POST /api/sessions` and `POST /api/sessions/:id/resume` for that project answer `409` with code `sync-applying`. This covers Infinite-managed and cmux sessions. A session admitted just before is counted as starting, so the apply sees it. The running check reads the same session list the clients show, cmux sessions included. A session counts while it is starting or running. It also counts while its worker does not answer and the recorded worker or provider process still lives; such a session reads `unavailable` or `recording-error`. An exited session never counts. A pid that the system reused for another process keeps the apply waiting until that process ends. If the session list cannot be read, the project counts as running. `--laptop` sessions do not block an apply, because their tools run against the laptop or a prepared checkpoint rather than the project directory. Records written before the execution location existed count as laptop sessions when they carry a hybrid workspace.

A manifest that cannot be applied stays **pending** with a reason. The pending marker always describes the newest received generation.

| Reason | Meaning | What clears it |
| --- | --- | --- |
| `session-running` | A cloud session is running or starting in this project | After it exits: `infinite sync --apply`, **Apply now** on web or phone, or the next laptop change |
| `cloud-changed` | The cloud tree differs from the scan taken after the last apply, or the directory was not empty before the first apply | `infinite pull` to save the cloud copy, then `infinite sync --apply --force` or **Replace cloud files** on web or phone |

`--force` skips the drift check and the identical-manifest shortcut; a running session still refuses the apply. A forced apply therefore replaces the tree even when the manifest matches the applied generation, which resets cloud edits to the laptop content. An explicit apply that is refused answers `409` with the reason as its code and leaves the generation pending.

`GET /api/projects/:id` returns the project's `id`, `name`, and a `sync` object. `lastSyncedAt` and `lastSyncedManifest` describe the newest received generation, `appliedAt` and `appliedManifest` the generation in place, and `pendingGeneration` (`id`, `capturedAt`, `receivedAt`, `reason`) a waiting one. Any paired role can read it. `infinite projects` and `infinite sync --status` print a summary of it: sync age, apply age, and the pending reason.

## Clients

On a cloud host, the web and phone Create screens show the selected project's sync age, apply age, and pending reason. Owners get **Apply now** for `session-running` and **Replace cloud files** for `cloud-changed`; the second asks for confirmation first. Laptop hosts hide sync state. The session view shows "Tools run on" the machine, or "your laptop" for `--laptop` execution, using the live executor location when the session reports one.

## Pull

`infinite pull` asks the host to scan the live cloud project tree, downloads the chunks the laptop lacks, materializes the tree into a new directory, and prints its path. Without `--output` the directory goes into private client storage. An existing destination is refused, and the checkout is never written. The copy includes `.infinite/`. Compare and merge by hand. `infinite recover SESSION_ID` remains the download for `--laptop` sessions after handoff.

## Limits

One root per project; `--include` belongs to `--laptop` execution. No merge: a forced apply replaces the cloud tree, and only one previous copy is kept. No two-way sync. Process memory, databases in use, and files outside the root are not covered, apart from a linked worktree's common Git metadata. Chunk stores on the laptop and the host grow without automatic pruning. The single-tenant trust boundary applies: everything in the checkout, and for a linked worktree its repository's common Git metadata, travels to the host, including any credentials stored there.
