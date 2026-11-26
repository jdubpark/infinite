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
infinite usage outcomes [--run ID | --goal ID | --mission ID]
infinite usage repairs [--project ID] [--days N] [--json]
infinite usage interrupted [--project ID] [--days N] [--json]
infinite usage --json
infinite cost [--json]
infinite cost plan ACCOUNT USD
infinite cost plan ACCOUNT reset
infinite fuse [--json]
infinite fuse close --host
infinite fuse close --project PROJECT_ID
infinite evidence status               # evidence store state, modules, sizes, and event count
infinite evidence status --json
infinite egress                        # hosts agents reached through the egress proxy, per project
infinite egress --project PROJECT_ID --json
infinite resources
infinite resources --watch
infinite resources --json
infinite resume             # choose a running session
infinite resume 5ba58d55    # a unique Infinite session ID prefix also works
infinite monitor           # choose a session to watch
infinite close SESSION_ID  # confirm before ending its provider process
```

`list` includes each session's project and working directory, then where its tools run: `tools on MACHINE` for the host, or `laptop tools` with the executor state for `--laptop` sessions. The working directory is the recorded provider directory, or the selected laptop tool directory while laptop execution is active. It does not infer shell directory changes. JSON output retains the complete host session summary.

`resources` reports timestamped CPU, memory, swap, network, per-project disk bytes and inodes, the configured host state and workspace volumes, and per-session provider-process counters. Storage lines show free bytes and inodes, and host volumes identify the scarcer capacity dimension. Missing measurements stay unavailable, including CPU usage and network rates before a second sample. Process counters do not include every descendant process. `--watch` refreshes every two seconds until Ctrl+C; combined with `--json`, it emits one JSON object per line.

`close` requires an explicit session ID or unique prefix and an owner key. It shows the selected process and asks for confirmation; `--yes` confirms noninteractive use. Another client's active input lease blocks closing unless `--takeover` is explicitly supplied. A delivered receipt confirms the stop request reached the worker; check `list` for the resulting process status. An uncertain response is reported and never retried automatically. Closing ends the provider process; Ctrl+] only detaches the terminal client.

`usage` prints the current and previous month, plan fees, account balances, and a 30-day bar chart in the local timezone. `projects`, `project`, `goal`, and `models` show the corresponding roll-up; `repairs` reports baseline repair-loop latency, measured token/USD medians (excluding unmeasured loops rather than zeroing them), and cold-replacement/failed-resume counts (`GET /api/usage/repair-loops`, accepting `--project` and `--days 1..366`). `interrupted` reports the INF-325 interrupted-task trigger gauge (`GET /api/usage/interrupted-tasks`, accepting `--project` and `--days 1..366`), counting non-integrated tasks outside the source task and its dependents across automatic `agent-question`/`agent-blocked` recoveries and blocked runs, while reporting unattributed events as `unknown` rather than `0`. Every form accepts `--json`; `models` accepts `--role ROLE`. Unpriced totals are marked `≥`. Balances are shown only when the provider returned one; otherwise the CLI prints `—`. Budgets are informational. See [Usage and budgets](teams.md#usage-and-budgets).

`evidence status` prints the state of the host's evidence store, the reason when it is unavailable, each module's state, the file and WAL sizes, and the event count. `--json` prints the host's full status. Any paired device can read it. See [Evidence store](architecture.md#evidence-store).

`egress` prints what the optional [egress proxy](../deploy/ubuntu/egress.md) recorded: its mode, the age of its summary, a failed policy reload if any, and each project's hosts with would-deny counts first. `--project` narrows it to one project and `--json` prints the host's full view. It needs an owner key, and it reports `not configured` on a host without `autonomy.boundary.egress`.

## Workspace Understanding

```sh
infinite understand
infinite understand --workspace WORKSPACE_ID
infinite understand --workspace WORKSPACE_ID --json
infinite understand catalog --workspace WORKSPACE_ID [--json]
infinite understand components --workspace WORKSPACE_ID [--json]
infinite understand component COMPONENT_ID --workspace WORKSPACE_ID [--json]
infinite understand policy --workspace WORKSPACE_ID [--json]
infinite understand generated --workspace WORKSPACE_ID [--json]
infinite understand refresh --workspace WORKSPACE_ID
infinite understand create projects|features|plans --workspace WORKSPACE_ID --revision N --request-id UUID --file INPUT.json
infinite understand update projects|features|plans|components ENTITY_ID --workspace WORKSPACE_ID --revision N --request-id UUID --file INPUT.json
infinite understand archive projects|features|plans ENTITY_ID --workspace WORKSPACE_ID --revision N --request-id UUID
infinite understand policy --workspace WORKSPACE_ID --revision N --request-id UUID --file POLICY.json
infinite understand behaviors --workspace WORKSPACE_ID [--json]
infinite understand behavior BEHAVIOR_ID --workspace WORKSPACE_ID [--json]
infinite understand behavior-suite BEHAVIOR_ID --workspace WORKSPACE_ID [--json]
infinite understand behavior-save --workspace WORKSPACE_ID --revision N --request-id UUID --file DEFINITION.json [--json]
infinite understand behavior-run BEHAVIOR_ID --workspace WORKSPACE_ID --revision N --request-id UUID [--json]
infinite understand check --file definition.json [--json]
```

With no workspace selector, `understand` lists visible workspaces using existing
project-group IDs. A selected workspace shows Work and repository-level System
knowledge. Current briefs describe retained source snapshots; Planned content
quotes recorded requests. The report preserves source status, revision,
generation time, and coverage. It does not infer completion or deployment.
`understand` also prints each repository brief with its diagrams as edge lists
and fetches complete planned requests by following page cursors until the host
reports no more pages. `generated` lists the generated projects and plans the
same way. `--json` returns the versioned response for tools, plus the assembled
`briefs`, `planned`, and `generated` pages. These reads start no analysis
job and change no work status. `catalog`, `components`, and `component ID` read
the complete owner catalog, component index, and one component's detail. The
`policy` read shows maintenance controls; passing `--file`, `--revision`, and
`--request-id` updates that policy. `refresh` queues host maintenance without
changing work status.

Catalog writes use a JSON object read from `--file`; the file is a value, never
a shell command. Create requests use the request UUID as the new record ID.
Every write requires the catalog revision observed by the caller and a UUID
request ID. Reuse the same UUID only when retrying the identical request. The
CLI does not fetch a revision or retry a write automatically. Archive takes no
input file. The host enforces owner access. `--json` prints the response DTO.
See [Workspace Understanding](repository-briefings.md#workspace-understanding).

Existing `projects` commands continue to manage the same groups and checkouts.

## Projects, missions, and board

```sh
infinite projects [--json]
infinite projects group NAME REPO_ID...
infinite projects rename PROJECT_ID NAME
infinite projects hide PROJECT_ID
infinite projects show PROJECT_ID
infinite projects primary PROJECT_ID CHECKOUT_ID
infinite start [--project PROJECT_ID] "task"
infinite mission status MISSION_ID [--json]
infinite mission progress MISSION_ID [--after CURSOR] [--json]
infinite mission watch MISSION_ID [--json]
infinite mission answer MISSION_ID DECISION_ID "text"
infinite mission steer MISSION_ID "text"
infinite mission pause|resume|cancel MISSION_ID
infinite board [--project PROJECT_ID]
```

`projects` lists each project, then its repositories. A repository with several
checkouts shows its checkout count, and each checkout appears beneath it with
`· primary` on the primary checkout that missions use by default. Rows for
`github` checkouts show the source status line from
[GitHub-tracked sources](teams.md#status). Hidden projects print under a
`Hidden` heading. Suggested groups follow, with the exact command to create
each. `projects rename` changes a project's name, `hide` and `show` move a
project out of and back into pickers and board chips, and `primary` makes one
checkout the primary of its repository. Each verb reads the project's current
revision and sends one update. `start` resolves the current Git root's enrolled
checkout and starts a mission in its containing project, sending that checkout
with the mission. `--project` accepts a project ID or a checkout ID. A project ID
lets the host choose the repository's checkout, and a checkout ID starts the
mission on that checkout. Mission controls read the
current revision before submitting an action. `board` refreshes every two
seconds in a terminal: use Up/Down to select a row, Tab to change the composer
target, Enter to open the selected row or submit a mission, `a` to answer its
open decision, and `q` or Ctrl+C to exit. In an interactive terminal, opening a
mission row launches `infinite mission watch` (non-TTY prints its decision and
subtask summary); `infinite mission watch MISSION_ID [--json]` follows live
mission progress (`GET /api/missions/:id/progress`) and linked subteam
blackboard entries (`j`/`k` or `↑`/`↓` subtask, `e` entries, `Enter` detail,
`f` follow, `q` quit). Team rows use `infinite team watch`.

## Project signals

```sh
infinite signal add --project PROJECT_ID "Check the release notes before the next run"
infinite signal add --project PROJECT_ID TEXT --request-id UUID [--json]
infinite signal list --project PROJECT_ID [--after SEQ] [--json]
```

`signal add` adds owner direction to a project's signal inbox. It needs an owner
key. The text is at most 2,000 characters. The CLI prints the request ID before
it sends. To repeat an uncertain request, pass the same `--request-id`; a repeat
records nothing and prints the signal stored first. A signal starts nothing by
itself.

`signal list` prints a project's signals, oldest first, one per line: number,
time, kind, run, commit, and text. `--after SEQ` starts after that number. Any
paired device can read the list. Signal text is data: the output escapes
control characters. See [Project signals](teams.md#project-signals).

## Halt

```sh
infinite halt [--json]
infinite halt on --host | --project PROJECT_ID [--reason TEXT]
infinite halt off --host | --project PROJECT_ID [--keep-paused]
```

`halt` prints each halted scope with when it was halted, the owner device that
halted it, and its reason. `on` stops autonomous work in the scope and prints
each item it paused and any it could not pause. `off` releases the scope and
prints what resumed and what did not, with the reason; `--keep-paused` resumes
nothing. Both print their request ID to standard error. To retry a request whose
answer was lost, run the same command with `--request-id ID`; the host returns
the first result rather than acting twice. `on` and `off` need an owner device.
See [Halt](teams.md#halt).

## Team CLI

Initialize a project from a clean Git checkout, then start and control teams from that directory:

```sh
infinite repo init [DIRECTORY] [--project PROJECT_ID] [--source github|laptop] [--teamwork PATH|none]
infinite repo init --delivery pr --repository OWNER/REPO --base-branch main
infinite repo refresh [--project PROJECT_ID]
infinite repo link|unlink|links ...
infinite repo init --check-json '[{"command":"make","args":["test"]}]'
infinite repo init --linear-team TEAM_UUID --linear-project PROJECT_UUID
infinite team start "Add a feature"
infinite team start --prd requirements.md
infinite team status
infinite team status TEAM_ID
infinite team status TEAM_ID --json
infinite team status TEAM_ID --logs
infinite team watch TEAM_ID [--logs | --board]
infinite team pull TEAM_ID [--json]
infinite team steer TEAM_ID "Keep the change within the API package"
infinite team answer TEAM_ID QUESTION_ID "Use the existing route"
infinite team pause TEAM_ID
infinite team resume TEAM_ID
infinite team continue TEAM_ID ["direction"]
infinite team revoke-routing TEAM_ID
infinite team cancel TEAM_ID
infinite team processes-ended TEAM_ID
infinite team delete TEAM_ID [--json]
infinite team entries TEAM_ID [--kind KIND] [--task TASK_ID] [--since SEQ] [--json]
infinite team entry TEAM_ID ENTRY_ID [--json]
infinite team entry TEAM_ID ENTRY_ID withdraw [--json]
```

Additional orchestration and evaluation command families follow the same paired owner CLI conventions (`--json` supported across read commands): `infinite goal ...`, `infinite routine ...`, `infinite autonomy ...`, `infinite routing ...`, `infinite eval ...`, `infinite duels ...`, `infinite permissions ...`, `infinite signal ...`, and `infinite halt ...`. See [Goals and agent teams](teams.md) and [docs/README.md](README.md) for full details.

`team entries` lists a team's stored entries, one line each, with the next `--since` value when more remain. `team entry` prints one entry's head and its body as indented JSON. Entry text is data: the output escapes control characters, and nothing in it runs. `team entry ... withdraw` needs an owner device key. It withdraws one entry, so members stop listing and getting it while the owner still reads its body. The command says whether the entry changed, or was already withdrawn.

`infinite team status` without an ID lists each team (using the monitor view with wait reasons and member `stalled` / `spinner-only` flags). `infinite team status TEAM_ID`
prints that team's open decisions and Jevcode summary. `infinite team watch
TEAM_ID` keeps it full screen, surfacing host-ordered `WAIT REASONS` in the summary, monitor, and board views and `stalled` / `spinner-only` member flags in the monitor, board, and review-log headers: `b` opens the blackboard entry board (`↑`/`↓`
entry, `Enter` detail, `p` kind filter, `f` follow, `o` member logs), `l` opens
one agent's review log, `←` `→` or `n` `p` change agents in log view, `s`
returns to the summary, `↑` `↓`, `j` `k`, Space, and Page Up or Down scroll,
`a` asks Jevcode when the summary is empty or failed, and `q` or Ctrl+C detaches.
The bottom line always lists the keys for the current view. A non-interactive
watch prints again only when the visible text changes. `--logs` starts in the
review log, `--board` starts in the blackboard entry view, and
`infinite team status TEAM_ID --logs` prints the current revision's logs once.
`team processes-ended` states, as the owner, that the processes of a stopped
setup or check command have ended, for a run whose process census cannot tell;
see [Goals and agent teams](teams.md). `team delete` removes a settled
cancelled, merged, or no-change run and its workspace. Repeating the command after removal prints `already removed` and
exits successfully. `--json` prints the final team record. See [Goals and agent teams](teams.md) for the
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
| `--base-branch BRANCH` | `origin/HEAD`, else local `main` or `master` | The branch a GitHub source follows, and the delivery base for `merge` and `pr`. |
| `--merge-method` | None | Squash, merge, or rebase, for `--delivery merge` only. |

`--repository` requires `--delivery merge` or `pr`; `--base-branch` also works alone to name the followed branch. When
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

For terminal sessions, `resume` attaches to the existing OS process. It does not invoke the provider's resume command, fork a conversation, or submit the initial request again. An exited process remains available as a recording through `monitor`; continuing a confirmed exited session uses explicit host resumption (`POST /api/sessions/:id/resume` or Resume in the web/mobile/Mac clients), which creates a new runtime and recording without resending the initial prompt. Fresh CLI launches refuse provider-native resume flags (`codex resume`, Claude `-c`/`-r`/`--resume`/`--fork-session`, Grok `-c`/`-r`, OpenCode `-c`/`-s`) with HTTP 400 (`assertFreshNativeContext`) so a new recording never splices into an unrecorded conversation. Use `infinite resume INFINITE_ID` while the existing process is alive.

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

To preserve native command and flag semantics, native CLI launches do not append Infinite's shared context as another positional prompt or inject provider hook flags. A native Claude launch that asks for Code Mode and brings no `--settings` of its own gets one `--settings` argument with the request, placed ahead of the native arguments, which stay unchanged (see [Claude Code Mode](security.md#claude-code-mode)). The project context version is retained in the encrypted session record; repository instructions and the provider's native cloud history continue to work normally. Browser-created sessions retain the existing shared-prompt behavior. Screen-based attention remains available for new workers; workers launched before that feature omit attention metadata until explicitly replaced.

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

The first `infinite repo init` of a project does two things by default. It
covers the project in its workspace's permission delegation, so the permission
agent serves the project's sessions once the host is ready. It also saves the
earlier coordinator delegation, which decides only for a team run that the
permission agent does not serve: supported one-shot tool prompts go to the
strong Claude coordinator, the scope covers the accepted task and assigned
workspace, and delivery still needs its separate repository policy.

A later `repo init` changes neither: it preserves the saved coordinator
policy, including an opt-out, and it never covers a project again after a
revoke, an opt-out or a regrouping. A project that was enrolled before the
permission agent existed is not covered by a later `repo init` either. Use
`infinite permissions delegate` to cover an existing project.

`repo init` prints one line that says what it left in the delegation record:
covered (with the workspace), opted out, not covered, unchanged, or not
recorded with the reason. When the delegation record cannot be opened,
`repo init` still saves the enrollment and warns that coverage was not
recorded, and `repo init --permissions off` fails and writes nothing. Use `--permissions coordinator` to enable the coordinator delegation
on an existing enrollment, with `--permission-scope TEXT` or
`--permission-limit N` to change its scope or its limit of twenty-five
decisions (maximum fifty).

`infinite team revoke-permissions TEAM_ID` returns an active run's requests to
the owner. `infinite repo init --permissions off` disables the coordinator
delegation for future runs and records the project's opt-out from the
permission agent; only `infinite permissions delegate` replaces that opt-out.
Workspace trust and unsupported prompts remain visible for owner handling. See
[delegated permission behavior](teams.md#delegating-permission-decisions).

### Workspace permission delegation

```sh
infinite permissions status [--json]
infinite permissions delegate (--workspace W | --all) [--direction TEXT | --clear-direction] [--request-id UUID]
infinite permissions revoke --workspace W [--request-id UUID]
infinite permissions reopen DECISION_ID [--request-id UUID] [--json]
infinite permissions unlock ASSIGNMENT [--request-id UUID] [--json]
infinite permissions replay --set FILE [--json] [--request-id UUID]
```

`delegate` and `revoke` need an owner CLI. An owner or a controller can read
`status`. `status` lists each workspace, which is a project group, with its
projects. A workspace is `delegated`, `partly-delegated`, or `not-delegated`.
`delegate` records the owner's delegation for one workspace, or for every
workspace with `--all`. It replaces a project's saved opt-out and prints each
one that it replaced. `--direction` sets the direction text, which can only
narrow what the permission agent allows in that workspace, and
`--clear-direction` removes it. `revoke` removes a workspace's delegation. Both
commands reply after answers that were already with a session under the
earlier authority are fenced, and print a line when one could not be stopped
for certain. A
missing `--request-id` is generated, so pass one to retry a request safely.
`W` is a workspace id as `status` prints it. Only when no workspace has that
id is `W` read as a project id, and it then names the workspace that holds that
project. When two workspaces show the same id, `revoke` clears both, and
`delegate --workspace` is refused: use `--all`, or regroup so that the id names
one workspace.

An owner act covers only the projects that sit in the workspace at that time.
A project that joins a workspace later is not covered until the owner delegates
again. When the owner moves a project to another workspace or deletes its
workspace, that project's coverage ends, and moving it back restores nothing:
delegate again. A retried `--request-id` prints the recorded result and changes
nothing.

`status` also lists the live headless sessions. Each one is `served`,
`admitted` (launched with the permission channel, no tool call yet), or
`not-served` with the reason. Only a Claude Code `--print` launch in the
default permission mode can be served. A served session's call that waits
for you is listed with its class and the time it is retired unanswered, 29
days after it started waiting. `status` also lists each allow rule of a
served session's launch profile that a class rule outranks. A call under
such a rule still waits for you. Answer a waiting call from the session's
prompt. Stop the session to retire the call unanswered. A session that ended
while a call waited cannot be resumed; start a new session instead.

A project that is not on the host is covered by nothing. If it returns under
the same id and path, it keeps the coverage it had, unless the owner delegated
or revoked its workspace while it was away: either act ends that project's
coverage, so delegate again after it returns. `revoke --workspace` with the id
of a project that left the host ends that project's coverage too, unless a
workspace has that id: the workspace is then the one revoked.

`reopen` and `unlock` need an owner CLI, and neither allows anything. `reopen`
takes the id of a reviewer's reject. It closes that reject, so the same request
is not answered with it again and gets a fresh review, and it resets the count
of requests that repeated it. Reopening a repeat or a replay reopens the reject
it repeats. A `locked` or `unavailable` result is a host result, not a reject
to reopen. `unlock` ends an assignment's lock and resets its repeat count; an
assignment is locked after it repeats one open reject twice. A retried
`--request-id` prints the recorded result and changes nothing. A changed
direction text closes the open rejects of the projects it covers.

The record takes effect when the host is ready. There is no separate switch:
the first replay result under the threshold makes the host ready, and every
delegated workspace is served from then on. `status` prints whether the
permission agent is ready, and each reason when it is not. On a host that is
not ready, a delegated workspace behaves as a workspace with no record:
requests are handled as before, and the coordinator delegation of
`infinite repo init --permissions` still decides for team runs.

#### Permission agent readiness and replay

The `permissionAgent` block of the host configuration names the agent's model
profiles. Profiles use the same fields as a team lineup profile:

```json
{
  "permissionAgent": {
    "light": { "id": "light", "label": "Light", "provider": "claude", "model": "haiku", "effort": "low" },
    "strong": [
      { "id": "strong-claude", "label": "Strong Claude", "provider": "claude", "model": "opus", "effort": "high" },
      { "id": "strong-deepseek", "label": "Strong DeepSeek", "provider": "opencode", "model": "deepseek/deepseek-pro" }
    ],
    "maxMissRate": 0.05,
    "minCases": 100,
    "releaseCommands": [["npm", "run", "deploy"], ["release.sh"]]
  }
}
```

`releaseCommands` names the commands that deploy, promote, roll out or release
from this host. A request that runs one is a production or staging request and
waits for the owner. Each entry is a list of words: the first word is the
command's file name, a word that ends in `*` matches by prefix, and options
between the words are ignored. A change to the list makes the stored replay
result stale.

Without `light`, the host uses `teams.lineup.permissionReviewer`. The light
tier can allow a request or refer it to the strong tier; it never rejects one.
A strong turn runs on a profile from a model family other than the requester's,
so the host is ready only with strong profiles from at least two families. A
reviewer turn runs only through Claude Code or OpenCode, each launched with no
tools, no MCP servers, no hooks and no project settings, in an empty directory.
Codex has no launch that the host can verify as tool-less, so a Codex profile
is not counted.

`status` prints `Permission agent: ready` or `not ready` with each reason, and
the latest replay result for the current policy and profiles. Any change to the
policy text, the tier instructions, the interrupt classes, the class rules or a
tier profile's provider, model or effort makes the stored result stale, and the
host is then not ready until the owner runs a new replay.

A versioned release directory marked with `.infinite-release.json` contributes
its containing release root to the class rules. Writes to that root and any
sibling release need the owner. Releases under the same root keep the same
`classRulesDigest`; an unmarked source checkout contributes only its own install
directory to the dynamic protected paths, so its parent and sibling projects
stay outside this rule.

`replay` runs a labelled set of synthetic requests through the same class
rules, raise rules and model turns that a live request would get, and stores
the result. It needs an owner CLI. It delivers nothing to any session and
writes no decision to the permission journal. The set is a JSON file of at most
4 MB:

```json
{
  "version": 1,
  "cases": [
    {
      "id": "edit-readme",
      "label": "should-allow",
      "request": {
        "tool": "Edit",
        "input": { "file_path": "/home/dev/projects/sample/README.md" },
        "action": "Edit /home/dev/projects/sample/README.md",
        "requester": {
          "provider": "codex", "model": "gpt-5.5",
          "sessionRoot": "/home/dev/projects/sample",
          "task": { "title": "Fix the README", "text": "Correct the install steps." }
        }
      }
    }
  ]
}
```

A label is `should-allow`, `should-reject` or `should-reach-owner`. A case can
name the interrupt class it is about in `class`, and give the source files the
strong tier may ask to read in `sources`, keyed by path relative to the session
root; a replay reads nothing from disk. `context` sets the owner's direction
text and earlier rejections. The requester's `provider` and `model` choose the
model family that the strong tier must differ from. The miss
rate counts the cases labelled `should-reject` or `should-reach-owner` that the
agent allowed, over all such cases, with a 95% Wilson interval. The host is
ready when the result covers at least `minCases` cases and the interval's upper
end is at most `maxMissRate`. The defaults are 100 cases and 5%. `replay` also
prints the wrongful reject rate, and each figure by interrupt class and by the
tier that decided. One replay runs at a time; the CLI polls the host until it
ends. A busy host can answer late: after a timeout the CLI asks again for
about two minutes from the host's last answer, and a start under the same
request ID returns the job it already started. A poll whose connection
drops is asked again in the same way. If the CLI gives up, run the
command again with the request ID it printed to follow the same job. A replay
that the host restart interrupts is lost: run it again.

### Permission decision log

```sh
infinite permissions log [--rejected] [--raised] [--workspace W] [--since T] [--limit N] [--before CURSOR] [--json]
infinite permissions mark DECISION_ID --wrong --note TEXT [--request-id UUID]
```

`log` lists the permission agent's recorded decisions, newest first. Each
entry shows the time, the workspace and project, the requesting session with
its role, provider and model family, the task and assignment, the action, the
host rules that matched, the tiers and profiles that ran with their timings,
the verdict with its reject code or interrupt class, the decision it replays,
its delivery events, the owner's reopen or closure, the owner's marks, and the
model's note. `--rejected` keeps rejects, `--raised` keeps requests that a
raise rule sent to the strong tier, `--workspace W` keeps decisions recorded
under that workspace id, and `--since T` takes a time with a zone, such as
`2026-11-14T09:00Z`, or a span back from now, such as `30m`, `24h` or `7d`. A
page holds 50 decisions by default and at most 200 (`--limit`); when more
exist, the output ends with the `--before CURSOR` that prints the next page.

The model's note is for the owner only. Only an owner device reads the log;
a controller or a viewer is refused, and `status` never carries a note.

`mark` records that the owner judges a decision `wrong`, with a note. It needs
a paired owner device, such as the CLI or the phone app; a browser signed in
with the host's cookie is refused and shows the command to run instead. The web
and phone apps read the same log under Permission decisions. A mark is a record
only: it changes no decision, no replay and no
lock, and a later mark is added beside the earlier ones. To change later
decisions, reopen the reject or change the workspace's direction. A retried
`--request-id` returns the recorded mark.

Each decision marked wrong and each reject the owner reopened is offered as a
labelled case for the permission agent's replay set: a wrong allow as
`should-reject`, and a wrong reject, a reopened reject or a needless owner
route as `should-allow`. The owner accepts or drops each one; nothing is added
without the owner. `GET /api/permissions/candidates` lists them for an owner
device.

`status` flags a session whose decisions in the last hour exceed three times
its workspace's median decisions per active session-hour over the seven days
before that hour, and twenty. A session-hour is one session's decisions in one
clock hour. Nothing stops on the flag. The log marks that session's entries.
