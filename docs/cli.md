# Laptop CLI

For web/phone creation across cloud and laptop machines, cmux discovery, and the outbound relay, see [remote machines](remote-machines.md). The commands below describe the separately installed terminal client. Host setup commands use `node packages/host/dist/cli.js`.

The laptop CLI works independently of the Mac app and keeps provider conversations and tools on the cloud host. A launch without `--project` mirrors the current checkout below the server home and keeps it synced one way, including ignored and untracked files. The first launch waits for that copy to be applied. The folder structure and the launch subdirectory stay the same beneath each home directory; see [folder mapping](workspace-sync.md#folder-mapping). Codex can instead run tools in the current laptop project with `--laptop`, which prepares automatic cloud handoff in the background. Detaching or losing the interface leaves the cloud conversation running.

Launch and attach report their current stage immediately, with elapsed time during longer waits. These messages go to stderr; JSON listings and detached session IDs remain machine-readable on stdout. Progress stops when native output takes over.

Updated clients and hosts use one authenticated WebSocket for ordered input, delivery receipts, and terminal output. Keystrokes do not wait for previous acknowledgments. Journal changes wake the output stream immediately, with a periodic lifecycle check. Older hosts retain the HTTPS streaming fallback. Native remote echo still includes network latency; this transport is not a locally running provider UI. See [native interaction and continuity](native-continuity.md) for the Herdr review and provider adapter requirements.

```sh
infinite claude
infinite codex --model MODEL
infinite grok
infinite opencode --model deepseek/deepseek-flash

infinite list
infinite list --json
infinite usage                         # month totals, accounts, balances, and daily bars
infinite usage projects
infinite usage project PROJECT_ID
infinite usage goal GOAL_ID
infinite usage models [--role implementer]
infinite usage --json
infinite resources
infinite resources --watch
infinite resources --json
infinite resume             # choose a running session
infinite resume 5ba58d55    # a unique Infinite session ID prefix also works
infinite monitor           # choose a session to watch
infinite close SESSION_ID  # confirm before ending its provider process
```

`list` includes each session's project and working directory, then where its tools run: `tools on MACHINE` for the host, or `laptop tools` with the executor state for `--laptop` sessions. The working directory is the recorded provider directory, or the selected laptop tool directory while laptop execution is active. It does not infer shell directory changes. JSON output retains the complete host session summary.

`resources` reports timestamped CPU, memory, swap, disk, network, and per-session provider-process counters. Missing measurements stay unavailable, including CPU usage and network rates before a second sample. Process counters do not include every descendant process. `--watch` refreshes every two seconds until Ctrl+C; combined with `--json`, it emits one JSON object per line.

`close` requires an explicit session ID or unique prefix and an owner key. It shows the selected process and asks for confirmation; `--yes` confirms noninteractive use. Another client's active input lease blocks closing unless `--takeover` is explicitly supplied. A delivered receipt confirms the stop request reached the worker; check `list` for the resulting process status. An uncertain response is reported and never retried automatically. Closing ends the provider process; Ctrl+] only detaches the terminal client.

`usage` prints the current and previous month, plan fees, account balances, and a 30-day bar chart in the local timezone. `projects`, `project`, `goal`, and `models` show the corresponding roll-up. Every form accepts `--json`; `models` accepts `--role ROLE`. Unpriced totals are marked `≥`. Balances are shown only when the provider returned one; otherwise the CLI prints `—`. Budgets are informational. See [Usage and budgets](teams.md#usage-and-budgets).

## Projects, missions, and board

```sh
infinite projects [--json]
infinite projects group NAME REPO_ID...
infinite start [--project PROJECT_ID] "task"
infinite mission status MISSION_ID [--json]
infinite mission answer MISSION_ID DECISION_ID "text"
infinite mission steer MISSION_ID "text"
infinite mission pause|resume|cancel MISSION_ID
infinite board [--project PROJECT_ID]
```

`projects` lists explicit groups and implicit single-repository projects, followed
by suggested groups and the exact command to create each. Rows for `github`
projects show the source status line from [GitHub-tracked sources](teams.md#status). `start` resolves the
current Git root's enrolled repository binding and starts a mission in its
containing group; `--project` selects a group directly. Mission controls read the
current revision before submitting an action. `board` refreshes every two
seconds in a terminal: use Up/Down to select a row, Tab to change the composer
target, Enter to open the selected row or submit a mission, `a` to answer its
open decision, and `q` or Ctrl+C to exit. Missions open their decision and
subtask summary; team rows use `infinite team watch`.

## Team CLI

Initialize a project from a clean Git checkout, then start and control teams from that directory:

```sh
infinite repo init [DIRECTORY] [--project PROJECT_ID] [--source github|laptop] [--teamwork PATH|none]
infinite repo init --delivery pr --repository OWNER/REPO --base-branch main
infinite repo refresh [--project PROJECT_ID]
infinite repo init --check-json '[{"command":"make","args":["test"]}]'
infinite repo init --linear-team TEAM_UUID --linear-project PROJECT_UUID
infinite team start "Add a feature"
infinite team start --prd requirements.md
infinite team status
infinite team status TEAM_ID
infinite team status TEAM_ID --json
infinite team status TEAM_ID --logs
infinite team watch TEAM_ID
infinite team watch TEAM_ID --logs
infinite team pull TEAM_ID [--json]
infinite team steer TEAM_ID "Keep the change within the API package"
infinite team answer TEAM_ID QUESTION_ID "Use the existing route"
infinite team pause TEAM_ID
infinite team resume TEAM_ID
infinite team cancel TEAM_ID
```

`infinite team status` without an ID lists each team. `infinite team status TEAM_ID`
prints that team's open decisions and Jevcode summary. `infinite team watch
TEAM_ID` keeps it full screen: `l` opens one agent's review log, `←` `→` or
`n` `p` change agents, `s` or `b` returns to the summary, `↑` `↓`, `j` `k`,
Space, and Page Up or Down scroll, `a` asks Jevcode when the summary is empty or
failed, and `q` or Ctrl+C detaches. The bottom line always lists the keys for
the current view. A non-interactive watch prints again only when the visible
text changes. `--logs` starts in the review log, and
`infinite team status TEAM_ID --logs` prints the current revision's logs once.
`--json` prints the team record. See [Goals and agent teams](teams.md) for the
full key list.

`repo init` takes these source and delivery options:

| Option | Default | Effect |
| --- | --- | --- |
| `--source github` | Chosen when `origin` is a `github.com` URL | The host follows the base branch and refuses laptop sync for the project. The followed branch comes from `origin/HEAD`, else local `main` or `master`. |
| `--source laptop` | Chosen otherwise | Workspace sync from this checkout. |
| `--delivery review` | Default for new enrollments | Reviewed work stays on the host, with no provider delivery. |
| `--delivery merge` | None | The delivery member merges the reviewed commit on GitHub. The host refreshes after the merge report. |
| `--delivery pr` | None | The delivery member pushes the reviewed branch and opens a pull request. The owner merges on GitHub. |
| `--repository OWNER/REPO` | Read from `origin` | Delivery target for `merge` and `pr`. |
| `--base-branch BRANCH` | `origin/HEAD`, else local `main` or `master` | Delivery base for `merge` and `pr`. |
| `--merge-method` | None | Squash, merge, or rebase, for `--delivery merge` only. |

`--repository` and `--base-branch` require `--delivery merge` or `pr`. When
`--delivery` is omitted, an existing enrollment keeps its delivery policy.
Running `repo init` in an enrolled GitHub checkout switches it to `github` mode.

For a `github` project, `repo init` refreshes the source once and prints its status
line. A failed refresh prints a warning and keeps the enrollment. When a laptop
sync service was running for the project, `repo init` stops it and says so. The JSON
output includes `projectSource`, with `mode` and, for `github`, `repository` and
`baseBranch`. A host that predates this field reports `{ "mode": "laptop" }`.

`infinite repo refresh` fetches the base branch from GitHub now and fast-forwards
the working tree when no session is using it. It prints the source status line. It
fails for a project in `laptop` mode. The status line is described in
[GitHub-tracked sources](teams.md#status).

Linear IDs are saved during enrollment; team commands do not need them again.
To reuse them across repositories, initialize their parent folder once:

```sh
infinite repo init /path/to/work --linear-team TEAM_UUID --linear-project PROJECT_UUID
cd /path/to/work/my-repo
infinite repo init
infinite team start "Add a feature"
```

A parent folder outside Git stores only local Linear defaults. It does not upload
the folder or create a host project. Each child repository still needs its own
enrollment and verification commands. An enrolled Git repository also supplies
its saved Linear mapping to repositories nested beneath it.

Enrollment uses explicit Linear flags first, an existing host project mapping
second, and the nearest parent default third. Parent changes affect future
enrollments; they do not rewrite enrolled repositories or historical runs. A
different explicit team never retains a project from the previous team.
Paths are resolved before looking up parents, so a symlink outside the parent
does not inherit its defaults. Defaults stay in private client storage for the
paired host and device key; another pairing needs its own setup.

For a repository, `repo init` binds the canonical Git root to its cloud project in private client state. Existing repositories must have a clean checkout. `--teamwork PATH` selects a local folder outside the repository and below the local home; the host stores its matching home-relative path and uses it for new team runs. `--teamwork none` removes that setting, while omission preserves it. The option requires a Git repository. A freshly initialized, empty repository needs no first commit: the CLI creates an empty baseline only in the cloud snapshot and leaves local files, Git metadata, and history unchanged. The command infers `npm ci` when an npm lockfile exists and `npm run check` when `package.json` defines a `check` script. For a new empty repository without checks, onboarding authorizes the first team to establish them. Its coordinator must define verification commands before implementation; the host then runs them against the integrated work and requires independent review. Existing repositories without identifiable checks still need `--check-json` as a JSON array of `{ "command": "...", "args": [...] }` objects; `--setup-json` accepts one setup command in the same format. For a newly resolved local project, it uploads a one-time source snapshot from an isolated clone of the current commit. It does not start continuous sync or include ignored and untracked files. An explicit `--project` or existing directory binding configures the selected project without uploading local source. A pending cloud generation is refused; an already applied generation is retained without replacement.

The host must have team workspace storage configured, and the project must have required checks or explicit authorization for the team to establish them, before `team start` can run. The host's configured lineup is used by default. `--provider PROVIDER` requests a single-provider team explicitly. `team start` uses the current directory's saved project binding, or an explicit `--project PROJECT_ID`. `team status` without an ID lists teams on the paired host; the other commands address a team by ID. `--linear-team` and `--linear-project` configure the optional project issue mapping during initialization. `--handoff auto|off` defaults to `auto` for this onboarding path.

Run `team pull TEAM_ID` from the enrolled repository bound to that team's project to fetch its integrated branch as a local branch. It leaves your working tree and checked-out branch alone, skips a result already contained by that branch, and lets Git refuse a conflicting branch update.

Ordinary provider launches from an enrolled directory also use its saved project binding. For example, `infinite claude` opens that project's existing cloud checkout without uploading local changes or starting continuous sync. Launching from a subdirectory preserves its relative working directory. Use explicit sync commands when the cloud source needs an update.

Team mutations save a private request receipt before sending and do not retry an uncertain request. Supply `--request-id UUID` only when deliberately resuming the same request. `status` and `watch` show the host's workspace, branch, Linear URL, and pending questions. Ctrl+C detaches from `watch`; it does not stop the team.

For terminal sessions, `resume` attaches to the existing OS process. It does not invoke the provider's resume command, fork a conversation, or submit the initial request again. An exited process remains available as a recording through `monitor`; restarting it requires explicit native-provider recovery. For example, `infinite codex resume NATIVE_ID` passes that native command through and creates a new Infinite recording. Use `infinite resume INFINITE_ID` while the existing process is alive.

## The app's cmux workspaces from a terminal

The Mac app has two connections: Infinite sessions and a separate native cmux workspace server. `infinite list`, `resume`, and `close` address the Infinite catalog. The native cmux server keeps its own workspace and terminal IDs. Use `infinite cmux` for the same cmux catalog shown in the app:

```sh
infinite cmux                         # full native workspace TUI
infinite cmux --json terminal list
infinite cmux attach TERMINAL_ID      # one terminal, full viewport
infinite cmux terminal TERMINAL_ID close
```

This dispatches arguments unchanged to the separately installed `infinite-cmux` launcher on PATH. The launcher must be enrolled with the intended persistent cmux server; Infinite device pairing does not enroll it. It does not start a replacement server when the existing one is unavailable. Press Ctrl+B, then D in the workspace TUI to detach while server processes continue. Native terminal close commands end the selected cmux process and follow cmux's own controls, independently of Infinite's input leases.

The personal launcher uses the pinned cmux runtime and its encrypted remote connection. A standalone SSH forwarding service can supply its loopback route and the Infinite HTTP route without the app running. The launcher and tunnel are local provisioning artifacts; `make` installs the Infinite client and its dispatch, but does not provision those services. See [cmux enrollment and its trust boundary](desktop.md#connect-a-cmux-server).

## Laptop execution with `--laptop`

Run inside the project you want Codex to inspect or change:

```sh
infinite --laptop codex "Inspect this repository"
infinite --laptop --include ../shared codex "Update this project and its shared library"
infinite --laptop --detach codex "Run the checks"
infinite resume SESSION_ID
```

The launch directory is authoritative, including when it is inside a repository subdirectory. Infinite selects the Git project root and any explicit `--include` directories as workspace roots. The cloud app server registers the laptop executor before the original prompt starts; tools can read uncommitted and untracked files immediately without uploading the repository or opening an SSH tunnel. A configured host project still groups the session and supplies its administrative process directory; it does not replace the selected laptop directory.

The laptop service survives CLI exit and native-interface detachment. `resume` attaches to the same conversation and keeps the selected executor. It does not restart a lost laptop service. The service reconnects its transport to the same executor, never replays a command, and stops when that executor exits, pairing is revoked, or the host confirms the session ended. Start requires macOS or Linux, a single-tenant host, an owner device key, and compatible authenticated Codex app-server and exec-server support. Provider permissions remain explicit. Workspace roots configure Codex; they do not confine arbitrary shell commands or replace its sandbox policy.

The conversation's tools use the laptop executor. Native-interface file-picker search, standalone shell shortcuts, and standalone Git helpers are currently refused because those provider APIs target the app-server filesystem. They need a separate laptop implementation before they can be enabled here. Detached launch reports success only after the provider has admitted its thread and the laptop is connected.

Automatic handoff is part of `--laptop` mode. The host must have the qualified backend prepared with `npm run prepare:codex`; a stock backend reports its missing capability. Once background preparation is ready, an outage continues from the verified checkpoint in the same conversation. An uncertain tool outcome pauses for reconciliation instead of being replayed. Checkpoint age and the current blocker appear on web and phone. `--cloud` is accepted with no effect and cannot be combined with `--laptop`; cloud execution is the default.

`infinite --laptop codex` also supports an empty prompt. Its persistent terminal accepts the first real input; once history exists, native reattachment is available. No synthetic prompt is submitted.

After cloud handoff, `infinite recover SESSION_ID --output NEW_DIRECTORY` downloads a verified recovery copy and prints its cwd. Omit `--output` to use private client storage. The original laptop files remain available for comparison; tools stay in the cloud. See [scope, checkpoint semantics and platform limits](hybrid-execution.md).

## Workspace sync and pull

```sh
infinite sync                          # mirror this checkout beneath the server home
infinite sync --project PROJECT_ID     # sync into an explicitly configured project
infinite sync --status
infinite sync --apply [--force] --project PROJECT_ID
infinite sync --stop --project PROJECT_ID
infinite pull PROJECT_ID --output NEW_DIRECTORY
```

- `sync` starts a detached service that keeps the configured cloud project current with the Git root of the current directory, one way, including ignored and untracked files.
- `--status` lists each project's local service and sync state, and works while the host is unreachable. A `github` project shows its source status line instead of sync state.
- `--apply` applies a pending generation; `--force` also replaces cloud changes made since the last apply.
- `--stop` ends the local service.
- `sync` refuses a project in `github` mode and starts no service. See [Source modes](workspace-sync.md#source-modes).
- `pull` downloads the current cloud project tree into a new directory and prints its path, without writing into the checkout.

[Workspace sync](workspace-sync.md) defines the scope, apply rules, pending reasons, and limits.

## Experimental local Codex interface

```sh
infinite --local-ui codex "Inspect this repository"
infinite resume SESSION_ID
infinite --takeover resume SESSION_ID
infinite monitor SESSION_ID
```

This opt-in mode runs the installed Codex interface on the laptop and keeps its app server on the execution host. Prompt editing and cursor motion happen locally. Model requests, tools, history loading, and remote file searches still depend on the connection. A persistent cloud terminal supplies the recording and the web/phone controls for the same conversation.

Both machines need a Codex version with authenticated `--remote` support. A paired **owner** key is required for the local native interface. The initial launch requires a nonempty prompt: the tested app server cannot attach a second client to an empty conversation. Infinite uses legacy provider history because the tested WebSocket server cannot hydrate the native TUI's paginated default. Existing terminal sessions stay attached to their original process.

Supported launch options are `--model`, `--config`, `--ask-for-approval`, `--sandbox` (including their short forms), `--search`, and `--no-alt-screen`, plus one prompt. Other native arguments require ordinary terminal mode. Options retain their values; Infinite separates the prompt with `--` so prompt text cannot become a provider subcommand. The cloud owns model settings, credentials, tools, and history. The launch uses the mirrored checkout unless `--project ID` selects an existing server project.

`resume` opens a new local interface attached by the recorded provider conversation ID; it does not create another thread or resubmit the initial prompt. Native Codex shortcuts apply. Infinite's Ctrl+E, Ctrl+G, and Ctrl+] shortcuts apply only to streamed terminals. `monitor` uses the cloud terminal and remains read-only until control is requested. A phone can take over using the existing controls; the worker rejects stale native requests, including approval replies. Losing control detaches the local interface. Reopen with `resume`; use `--takeover` only when intentionally replacing another device's control.

Closing the local interface leaves cloud execution running. Unsaved local drafts are not synchronized. Provider requests are not automatically replayed after a broken connection; check the current conversation before sending again. This mode remains experimental because Codex's WebSocket app-server transport is experimental. It does not provide recovery after an execution-host failure or local/cloud file synchronization.

## Experimental local OpenCode interface

```sh
infinite --local-ui opencode
infinite --local-ui opencode --model PROVIDER/MODEL --prompt "Inspect this project"
infinite resume SESSION_ID
infinite --takeover resume SESSION_ID
```

The installed OpenCode TUI runs locally and attaches to one persistent cloud OpenCode server and conversation. Empty sessions work. Supported launch options are `--model`/`-m`, `--agent`, `--prompt`, and `--pure`; other native arguments use ordinary terminal mode. `--pure` remains opt-in and disables external provider plugins. A bare positional argument is not treated as a prompt because OpenCode normally interprets it as a project directory.

A paired owner key is required. The native interface receives only a temporary loopback password; Infinite retains the paired device credential. `resume` rejoins the recorded conversation without creating one or replaying a prompt. A takeover invalidates the old interface's requests and closes its event stream. The cloud backend and observer continue after the laptop interface exits. The observer supplies the existing web/phone recording and terminal controls.

Provider permission and question events show **needs you**. Their current native dialog remains authoritative: use terminal controls to answer it; compact OpenCode approval choices are not yet mapped. Infinite does not answer requests automatically. Provider administration, new/fork/delete operations, and navigation into child sessions are unavailable through this pinned attachment. Cloud credentials, model settings, paths, and tools remain associated with the cloud workspace. This does not synchronize laptop files or unsent native drafts.

OpenCode 1.18.34 was rehearsed with its real TUI, server, and shell tool using a controlled model response fixture. A tool completed after UI detachment, a phone-side follow-up appeared under the same ID after reattachment, and a pending permission was answered explicitly through phone terminal controls. Ten typed characters measured about 22 ms p95 at a simulated 1,000 ms request round trip, with no mutating HTTP requests while typing. This small local rehearsal does not establish live provider authentication, Android runtime behavior, or host reboot recovery. The adapter follows OpenCode's [native attach contract](https://opencode.ai/docs/cli/#attach) and [server API](https://opencode.ai/docs/server/).


## Terminal controls

- **Ctrl+]** detaches without interrupting the agent.
- **Ctrl+G** releases control, switches to monitoring, and drops unsent buffered keys. An open local draft is saved on the laptop.
- **Enter** in monitor mode requests control for an owner device. Input stays disabled until the host acknowledges it. That Enter is consumed locally; it does not approve a native prompt.
- **Ctrl+T** in monitor mode explicitly takes control from another device. The previous device's keys and resize requests are refused by the worker.
- **Ctrl+C** interrupts the agent in interactive mode and detaches in monitor mode.
- **Ctrl+E** opens a local draft editor for an interactive owner. Typing and line editing stay on the laptop. Enter adds a line, **Ctrl+S** inserts the draft into the native prompt without submitting it, **Esc** keeps the draft and closes the editor, and **Ctrl+X** discards it. The CLI is a terminal surface, so the draft is inserted even while a provider dialog is on screen, as typed keys would be. After insertion is acknowledged, Enter in the native terminal submits the prompt. Multiline insertion requires the provider's bracketed-paste support. Remote output continues updating the saved screen while drafting; closing the editor restores it.

A viewer remains read-only. Full native input requires an owner key. Controller keys retain the compact web/mobile steering controls, but cannot send arbitrary terminal control bytes. Monitoring does not resize the shared terminal; an interactive owner supplies its terminal dimensions.

On supported workers, attachment restores the current screen and up to 200 scrollback rows, then consumes output after that snapshot's exact journal cursor. Unsupported terminal state and older workers use recording replay. Older history stays on the host; the snapshot does not delete it.

After a broken connection, the CLI discards queued input and reconnects in monitor mode. An input with an uncertain delivery receipt is not automatically retried. Inspect the native screen, then press Enter to request control again. A confirmed control refusal means that attempt was not sent; it is distinct from an uncertain receipt.

Control expires after 30 seconds without renewal. This expiry releases input ownership only; the provider process keeps running. The current CLI renews every 10 seconds while interactive. Phone clients open in monitoring mode, treat iOS `inactive` as foreground, and pause polling and lease renewals only in the background. A held lease renews immediately on return if it is still within the host's 30-second lease; after the lease lapses, the phone stays in monitoring mode and never claims control automatically. The shared live stream stays open for a 30-second background grace period, then closes to save battery. Cursor-based recovery catches up on return without showing offline prematurely; stale/offline appears only after the existing foreground stale delay. Browser clients open in monitoring mode and stop renewing when backgrounded. Older workers expose no control capability and retain their previous shared-input behavior; they are not restarted during an API upgrade.

Ctrl+E drafts are saved encrypted beside the private client configuration, scoped to the paired origin, device key, project, session, and runtime. Saves run within 200 ms while typing and flush before insertion or graceful detachment. A sudden process kill can lose the most recent unsaved keystrokes. Resume the same session, acquire control, and press Ctrl+E to review a recovered draft. Recovery never sends text. Each client writes its own file; another live editor's draft is not taken over. Additional recovered drafts remain available after the current one is inserted or discarded.

An insertion is recorded locally as unconfirmed before dispatch and cleared only after the host acknowledges delivery. If the receipt is lost, the recovered text is read-only and Ctrl+S is blocked. Esc returns to the native screen for inspection. Use Ctrl+X to discard text already inserted, or Ctrl+R to mark it as unsent after your review. That explicit choice can duplicate the earlier insertion; the wrapper never makes it automatically.

This recovery covers Infinite's Ctrl+E editor in streamed terminal mode. Native Codex/OpenCode edit buffers and browser/phone drafts retain their own lifecycle; they are not captured or synchronized by this feature. Losing or replacing the paired device key also loses access to its encrypted drafts. Deleting the local `drafts` directory beside the client configuration removes the saved copies.

## Native arguments and cloud workspaces

In ordinary terminal mode, accepted arguments after the provider name are passed as an array, unchanged. There is no shell evaluation. Native history selectors such as `--resume`, `--continue`, and `codex resume` are refused on fresh launches; use `infinite resume SESSION_ID` to keep a recorded conversation bound to its original project. Put `--` before literal prompt arguments that match history commands, for example `infinite opencode run -- explain import`. Put Infinite options before the provider:

```sh
infinite projects
infinite projects forget [DIRECTORY] [--project PROJECT_ID]
infinite --project PROJECT_ID --title "Investigate tests" codex --model MODEL
infinite --detach --project PROJECT_ID claude "Review this checkout"
infinite --client-config "$CLIENT_CONFIG_FILE" monitor SESSION_ID
```

Paths, configuration files, native session IDs, installed tools, and credentials belong to the cloud host. A laptop path passed to `--cd`, `--add-dir`, or a provider configuration flag is not translated. A launch without `--project` uploads the selected checkout through workspace sync. Use `--project ID` to select an existing server project without automatic upload. Sync scope includes ignored files, untracked files, and Git metadata; credentials inside that scope travel to the server.

`infinite projects forget` removes the folder mapping for the current Git root, the supplied directory's Git root, or `--project PROJECT_ID`, and keeps the server directory and cloud files. See [workspace sync](workspace-sync.md#folder-mapping) for when it is refused.

`--laptop` Codex launches use the laptop project and background cloud handoff described above. The earlier [SSH prototype](hybrid-execution.md#earlier-ssh-prototype) remains available for isolated protocol experiments and retains its original offline behavior.

To preserve native command and flag semantics, native CLI launches do not append Infinite's shared context as another positional prompt or inject provider hook flags. The project context version is retained in the encrypted session record; repository instructions and the provider's native cloud history continue to work normally. Browser-created sessions retain the existing shared-prompt behavior. Screen-based attention remains available for new workers; workers launched before that feature omit attention metadata until explicitly replaced.

Use separate configured worktrees for parallel writers. Multiple sessions launched against the same project directory share that working directory. Do not assume that a new session automatically creates a Git worktree.

## Install and pair another laptop

Requires Node.js 22.14 or newer and access to the host through HTTPS or a separately established SSH tunnel.

```sh
make
infinite pair https://HOST.YOUR-TAILNET.ts.net --token-file "$OWNER_KEY_FILE"
```

`make` (or `make build`) installs dependencies when `node_modules` is missing or older than the lockfile, builds `@infinite/attention`, `@infinite/remote`, and `@infinite/host`, then runs `scripts/install-client.mjs`. The same steps by hand:

```sh
npm ci
npm run build -w @infinite/attention
npm run build -w @infinite/remote
npm run build -w @infinite/host
node scripts/install-client.mjs
```

The installer places `infinite` in `~/.local/bin` and an independent, versioned client runtime in the user's application-data directory. Add `~/.local/bin` to PATH if the installer reports it missing. The runtime bundles its dependencies and does not require this checkout or its `node_modules` directory. It refuses to overwrite an unrelated existing command.

Pairing validates the host and device role before saving a mode-0600 `~/.config/infinite/client.json`. Use `--token-file -` to receive the key through stdin instead of a file. Do not put a key in command arguments or shell history. Remote pairing requires HTTPS; HTTP is accepted only for loopback addresses, including an SSH-forwarded local endpoint. Redirects are refused so credentials are not forwarded to another endpoint.

For a tunnel that already forwards local port 4780 to the trusted server's API, use `infinite pair http://127.0.0.1:4780 --token-file "$OWNER_KEY_FILE"`. Keep the forward bound to loopback and verify the SSH host identity. SSH encrypts the network connection between laptop and server; the existing Infinite terminal CLI carries HTTP/WebSocket traffic inside that tunnel. It does not use the native Mac/phone application's encrypted WebSocket protocol or its public relay. Native provider gateways, `--laptop`, sync, and pull retain this direct connection path. The standalone tunnel can run at login and does not require the Mac app to be open.

This client currently connects directly to a trusted single-tenant runner. TLS pairing is not confidential-VM attestation and does not implement the future operator-private multi-tenant protocol.

### Delegated team permissions

The first `infinite repo init` enables coordinator delegation by default. Supported
one-shot tool prompts go to the strong Claude coordinator for future runs. The
scope covers the accepted task and assigned workspace; delivery still needs its
separate repository policy. Later enrollments preserve the saved policy,
including an opt-out. Use `--permissions coordinator` to enable delegation on an
existing enrollment. Add `--permission-scope TEXT` or `--permission-limit N` to
that explicit command to change the scope or ten-decision limit (maximum twenty).

`infinite team revoke-permissions TEAM_ID` revokes an active run's delegation.
`infinite repo init --permissions off` disables it for future runs. Workspace
trust and unsupported prompts remain visible for owner handling. See
[delegated permission behavior](teams.md#delegating-permission-decisions).
