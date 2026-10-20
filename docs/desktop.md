# Infinite Desktop

Infinite Desktop is a personal macOS client for a trusted server. The implementation
is in `apps/macos`: SwiftUI navigation and controls, a local native prompt editor,
and an embedded xterm.js terminal. The server owns the processes. Closing a view,
quitting the app, or disconnecting the Mac does not request their termination.

Status, 2026-10-16: the signed app is installed and connected to the intended Linux
server. Live resources, file downloads, download-only folder sync, local multiline
editing, and the same persistent cmux terminal across app and CLI have been checked.
The API upgrade preserved all seven existing agents. Physical phone continuity and
complete authenticated provider UI parity remain unqualified; see the acceptance
record below.

## Layout

The main window is a sidebar beside one page. The sidebar starts with project
search and **Home**, badged with the number of board rows that need input, then
**Projects**: every project from `GET /api/project-groups` (see
[missions](missions.md)), owner-created groups first with their repository
count, then the implicit single-repository projects. A dot marks a project with
a row waiting on the owner. Selecting a project shows Home narrowed to it.
**Sessions** follow: the person's own sessions, plus any team member session
stopped on a provider permission prompt, which carries a **Needs you** badge so
no prompt is reachable only through its team's page. Ended sessions are in a
folded **Ended sessions** group, and search also finds team member sessions. A
session's menu opens it beside the current one or ends it. A session whose
attention state is exited, unreachable, or recording-error counts as ended
whatever its stored status says. The footer
names the connected server with its state in words, switches or adds servers,
and opens Connections. A session shows its title, provider, state, and working
directory above its content, with the prompt editor below. The toolbar holds a
**New** menu (mission, single-repository team with options, session) and a menu
for Resources, Files & Sync, and cmux Workspaces, which open in their own
windows; ⌘1 returns to Home.

The app follows Apple's Liquid Glass guidance: content (rows, records,
terminals) stays flat, and controls that act on the whole page float as glass:
the start box, composers, status chips, and the server footer. On
macOS 26 and later these use the system glass; earlier systems get a thin
material with a light rim. The app is always dark, after the ayu dark theme:
near-black grounds (`#0D1017` pages, `#0B0E14` sidebar), warm text, and an amber
accent (`#E6B450`). State colors follow ayu (amber for work in progress, cyan for
review, green for a reported merge, orange for attention, violet for paused, red
for stuck), and each stays beside its state in words. The embedded terminal uses
the same ground. This replaces the web client's warm-paper palette on the Mac
only; see `DESIGN.md` for the web and phone.

**Chat** is the default view: the conversation as the provider recorded it, with
prompts, replies, and one line per tool call, polled from the host's chat record
(see [chat from the provider's own record](architecture.md#chat-from-the-providers-own-record)).
A session started before the host recorded transcripts shows only the prompts
sent through Infinite and says so. **Screen** is the live terminal, created the
first time it is opened and kept afterwards; dialogs and menus that the chat
cannot answer are handled there. When the agent is waiting on a dialog the host
can answer, a card above the prompt editor offers its options and, where the
dialog accepts it, a text reply; the host presses the keys on the dialog it
shows and reports whether it closed. The editor is held back while that dialog
is open in the chat view, because the text would land in the dialog.

Returning to a session shows how many messages arrived since this Mac last
looked. When the host has a summary model configured, **Summarize what's new**
asks for a digest of those messages. The card names the model and says the text
is not the agent's words; the digest attributes any claimed result to the agent
and never marks work complete. Read positions are kept per server and session
in this app's preferences, not sent anywhere.

**Home** is the first page after connecting. An owner device sees one text box
that hands a mission to a project: the picker beside it lists the projects
(with a repository count for multi-repository ones) and defaults to the project
the sidebar selects, and Return sends `POST /api/missions` with a request ID,
the project's group ID, and the text as the objective. A creation whose delivery
is unconfirmed is kept for retry under the same request identity, like a session
creation; Home shows it under the box until it is confirmed or cleared after
review. Below the box is the board from `GET /api/board`, polled every two
seconds with the session list:

| Section | Rows |
| --- | --- |
| Needs input | missions, team runs, and goals waiting on an answer or blocked |
| Working | planning, working, and paused ones |
| Ready for review | the agents report done; results need the owner's review, and delivery follows each repository's policy |
| Ended | cancelled, merged, and otherwise stopped ones, folded until opened |

Rows are newest-updated first. Each row is one line of status glyph, title,
state in words, and age, over a dim line with the project, a mission's finished
subtasks out of its total, and the host's one-line detail (the open question,
the block reason, or the current step). A blocked team the host marks resumable
offers **Resume** on its row. A goal has no Mac page; its row opens nothing.

A mission row opens its page in place of the session panes, which stay mounted
underneath: the coordinator's open decisions first, each with its options and a
free-text answer (an escalated one names the subtask and repository it came
from); the coordinator's result when it reports one, labelled as a report; the
subtasks with their repository, size (solo, or a team with its parallelism),
dependencies, and status, where a started subtask opens its subteam's team
page with a way back; the request; earlier directions and answers; and the
mission history. The composer at the bottom steers the coordinator, and the
owner pauses, resumes, or cancels the mission from its menu. Mission actions
are owner-only and carry the mission revision they were based on, with the same
stale-refusal and unconfirmed-retry handling as team actions below. The page
polls `GET /api/missions/:id` every two seconds while it is shown.

A team run, opened from the board or a subtask, shows its dashboard the same
way: the request, the decisions members asked with their options and a
free-text answer, member sessions stopped on a provider permission prompt with
a button to open them, the work plan with each task's state, dependencies,
owned paths and assigned agent, the members with their role, state and
requested model, the host's own check results and the reviewer's report
(labelled as an agent claim), the branch and commits to inspect, earlier
directions and answers, and the run history. The composer at the bottom sends a
direction, which records a new revision and makes the team replan; owners
pause, resume or cancel from the run's menu. Every mutation carries the
revision it was based on; a request the host refuses as stale refreshes the
run, and one whose delivery is unconfirmed stays visible for a retry with the
same request identity. The dashboard polls its run every two seconds while it is
shown. **New single-repo team…** (⇧⌘N) still starts a team directly in one
workspace with a name, agents, parallelism, and a longer brief.

Recent sessions stay attached and rendered off-screen, so switching back is
immediate and keeps scrollback. Up to three terminals stay mounted; opening a
fourth detaches the oldest. A hidden terminal releases its input lease, so it
never blocks another device. Session polling only redraws the window when the
session list actually changes, and resource samples are requested only while a
Resources window is open.

Periodic desktop reads pause while Infinite is hidden, every Infinite window is
minimized or fully occluded, or the display or system is asleep. A visible window
refreshes immediately on return and resumes the existing cadence. This pauses
the session list, chat, team, mission, cmux catalog, cost, and resource polls.
Attached terminal streams stay open, and a held input lease continues its small
renewal request; returning to the app never claims control again.
Terminal output keeps its scrollback current, while xterm cursor blinking pauses
when its page or session pane is not visible.

## Editing and terminal behavior

Prompt composition happens in a native Mac text editor. Editing, selection, and
cursor movement do not wait for the server. Enter sends the complete prompt;
Shift-Enter inserts a newline. Infinite-managed drafts are encrypted locally with
a Keychain-held key. A pending submission retains its identity and uncertainty
instead of becoming a fresh automatic submission after reconnect.

The terminal displays actual streamed bytes, rendered with xterm.js's WebGL
renderer and the DOM renderer as fallback. **Type in terminal** is a separate mode
for provider shortcuts, dialogs, slash-command interaction, and terminal-specific
editing. Those keys travel to the server PTY; its response still depends on
network latency. The local composer does not predict provider output, emulate a
provider editor, or silently approve a permission.

Sending a prompt or enabling **Type in terminal** claims the input lease itself;
a lease held by another device is taken over, and the footer names that device
beforehand. While this Mac does not hold the lease it cannot resize the server
PTY, so a screen snapshot keeps the size the server drew it at instead of being
reflowed into the window. Output replayed from a host without snapshot support
has no known size and is fitted to the window. Holding the lease fits the
terminal to the window and resizes the PTY.

A live sample of ten sequential encrypted identity requests on an already open
connection measured 249 ms median and 252 ms p95 round trip. This small sample
describes that network path, not provider response time. Native draft typing and
Shift-Enter editing remained local; Enter submitted the complete draft.

This is not yet a claim of complete parity with every local Claude Code or Codex
interaction. Alternate screens, Unicode/IME, multiline paste, keyboard shortcuts,
selection, scrollback, resizing, dialogs, and reconnect must be qualified with the
actual provider versions. Native provider frontend adapters remain separate work;
see [native continuity](native-continuity.md).

## Build and install

The target is macOS 14 or newer. Install the Xcode command-line tools and the
repository's Node/npm requirements, then run from the repository root:

```sh
npm ci
npm run desktop:build
npm run desktop:install
```

The build produces a separate Infinite application and selects an architecture-
matching cmux helper. Initial native qualification targets Apple Silicon; the
terminal SDK also contains Intel macOS slices, but an Intel runtime remains a
separate acceptance check. The build uses `INFINITE_SIGN_IDENTITY` when supplied,
otherwise an available Apple Development identity, with ad-hoc signing as the
fallback. A stable signing identity preserves Keychain access across rebuilds.
This local build is not notarized and has no automatic update service. Installed
launch and bundled terminal rendering have been checked separately from compilation.

The existing cmux application, its settings, and existing Infinite sessions keep
their own ownership. Installing Infinite Desktop is not a session migration.

## Connect an Infinite host

Use [remote machine setup](remote-machines.md) to configure a single-tenant host,
its allowed project roots, providers, HTTPS route, and a separate owner device key
for the Mac. Enable `remote.enabled` on the host. Provision a separate phone key;
do not reuse a relay-registration secret as a device credential.

In **Connect Infinite server**, enter a bare HTTPS host or relay origin and the
Mac's device key. Supply the machine ID for a relay connection; leave it empty for
a direct connection. Loopback HTTP is also supported through a pinned SSH tunnel
to the trusted server; it does not permit plaintext HTTP to a remote address. The app
authenticates the encrypted endpoint before retaining the key in Keychain, records
the authenticated machine ID, and pins it for later connections. Existing paired
keys are manually provisioned secrets, not expiring single-use enrollment codes.

The Mac and phone both use the application-encrypted channel for direct and relay
connections. A host without that endpoint fails connection; the phone no longer
falls back to ordinary bearer HTTPS. The web client's same-origin cookie interface
is a separate existing route. See [security](security.md#remote-machine-transport)
for the trust boundary and the current protocol's lack of forward secrecy.

## Connect a cmux server

**cmux workspaces** uses a separate native cmux connection. Enter the server's
cmux route and enroll the Mac using the server's invitation/approval flow. An
Infinite device key does not enroll a cmux device. The app uses the cmux terminal
C SDK for bytes and a bundled cmux helper for workspace/resource operations.
Invitations go through standard input, not process arguments or saved profiles.

Supported route forms are `wss`, `iroh`, and loopback-only `ws`. The SDK and helper
use `/v1/link` for a bare WebSocket origin; explicit non-root paths are retained.
The SDK and helper
must match the headless server's supported protocol. Device identity and known
daemon pins are stored together in a device-only Keychain item. They are
materialized into an owner-only runtime directory while connected and saved back
before normal cleanup. Forced termination can leave that private directory behind;
runtime cleanup is not a claim of secure erasure.

Direct cmux enrollment grants the daemon's owner authority. It does not translate
Infinite viewer/controller roles or establish an exclusive Infinite input lease
against other cmux clients. Concurrent local typing can change a provider dialog.
SDK queue acceptance is not a durable provider delivery receipt. Ambiguous
mutations are never automatically retried.

The qualified Linux setup gives cmux its own Codex launcher using `--no-daemon`,
so the frontend runs in the persistent cmux terminal without depending on a
separate Codex daemon socket. Its provider home and credentials are unchanged.
The existing Infinite provider launcher keeps its own behavior. Qualify this flag
against the installed Codex version before applying it to another host.

Use the durable headless `cmux-tui` server for this connection. The separate Go
SSH remote daemon has a different lifecycle and must not be assumed to keep an
agent alive independently of its owning workspace. Server supervision, matching
artifact versions, enrollment, and live revocation remain explicit commissioning
checks on the intended server. See the upstream [remote client contract](https://github.com/manaflow-ai/cmux/blob/main/cmux-tui/docs/remote.md)
and [terminal SDK contract](https://github.com/manaflow-ai/cmux/blob/main/cmux-tui/crates/cmux-terminal-client/README.md).

## Agents and resources

The Infinite connection lists managed sessions, configured projects, actual
working directories, provider, observed state, and connection freshness. Owners
can create, resume supported conversations, and explicitly **End session**.
Two sessions can be displayed beside each other through the sidebar's **Open
beside current**. Closing a view detaches it; ending the process is separately
labeled and confirmed.

Infinite terminal observation does not claim input control. The lease is claimed
on the first send or when terminal typing is enabled, never while only watching.
Viewers remain observers; raw terminal input is owner-only. Existing restricted steering
continues through the controller API. Idle or quiet output never means the task
is complete.

Resources include CPU, memory, swap, project filesystem capacity, network
throughput, and available provider-process CPU/RSS. Process figures do not include
an unverified descendant tree. Unavailable counters and the initial sample without
a rate remain unavailable rather than zero. Inventory covers managed/discovered
sessions, not every process or agent on the machine. GPU monitoring, inode
reporting, and durable resource history are not established by this sampler.

The app is optional. The separately installed [laptop CLI](cli.md) supports
provider sessions, resource monitoring, lifecycle control, and workspace sync.
`infinite cmux` opens the same native cmux workspace catalog as the app. Its
launcher and SSH tunnel run independently of the desktop process. Infinite-managed
sessions and cmux terminals retain their separate IDs and controls.

## Files and folder synchronization

**Files & sync** shows a native Mac/server browser. Choose a local folder and a
configured server project, navigate either side, and select files for upload or
download. Server listings are paginated. Symbolic links, special files, and files
larger than 256 MiB are not transferable. Replacing different content directly
requires confirmation and preserves the previous version privately.

Transfers use 48 KiB binary chunks inside the encrypted channel. Downloads pin a
SHA-256 version across chunks and verify the assembled content before it becomes
visible. Uploads declare size/hash and the expected destination hash; the host
commits only a complete verified file after checking the destination hash. Lost
receipts do not trigger automatic replay. Cancellation stops further chunks;
unconfirmed operations remain uncertain and abandoned staging expires. Automatic
transfer resumption across app restarts is not implemented.

**Preview folder sync** compares the local folder and current server folder
against a private machine/project/folder-scoped baseline. New files and unambiguous
edits receive a proposed direction. Different first-time copies, changes on both
sides, and one-sided deletions require a decision and initially remain unchanged.
Choosing a side preserves the replaced copy. Deletions are never propagated;
deletion rows allow explicitly restoring the remaining copy. Renames appear as
additions and deletion notices. Empty directories are not synced.

The preview excludes `.git`, `.infinite`, `.DS_Store`, transfer temporary files,
symbolic links, and special files. Other hidden, ignored, and untracked regular
files are included, so review the scope before applying. Preview is limited to
10,000 entries and 64 directory levels. Case/Unicode filename collisions are
blocked. Baselines advance only after a confirmed transfer or an explicitly
applied, revalidated equal-content observation. A partial failure keeps confirmed
work and requires a refreshed preview for the remaining changes.

Local writes revalidate paths, source/destination versions, and regular-file
identity. Downloads stage content in an owner-only hidden recovery directory
beside the destination. Atomic exchange retains the displaced original inode,
including edits from a still-open file handle; detected drift restores it instead
of discarding a competing version. Mac replacements remain in those private
`.infinite-desktop-recovery-*` directories. Before replacing a server file, its
previous content is downloaded into the `InfiniteDesktop/Recovered Files`
directory in Application Support. These locations have different recovery purposes.

Sync baselines also live in the app's Application Support storage, with owner-only
file permissions. Backups and metadata are plaintext, not an encrypted backup
service. They have no automatic retention purge; inspect and remove recovered
versions manually after confirming they are no longer needed. Native tests verify
path anchoring, conflict refusal, and preservation of the displaced inode and later
open-editor writes. A late edit may remain in the recovered original rather than
being restored automatically.

Host file mutations require an owner device key and are fenced while agents run
in that project, while a sync application is in progress, or while another file
mutation owns the project fence. The server's final hash check followed by rename is not an atomic
compare-and-swap against unrelated filesystem writers: another process with local
access can race that interval. These fences coordinate Infinite-managed operations;
file roots do not sandbox a hostile local user or an owner terminal. This folder
workflow is distinct from whole-checkout [workspace sync](workspace-sync.md), which
has different Git-metadata scope and application rules.

Uploads published in a shared project use the destination directory's group,
preserve owner permission bits, grant group read/write and group execute when the
owner can execute, and remove other-user access. Nonshared replacements retain
existing permission bits. If the API cannot set the shared group, publication
fails before replacing the file.

When the API and providers use different Unix accounts, provision the shared
workspace group and default ACLs in the [Linux deployment guide](../deploy/ubuntu/README.md).
The API needs filesystem access as well as a valid device key. Existing private
files may need an explicit read ACL; deliberately private files remain inaccessible
and are never automatically made readable by the app. Provider credential homes
are outside these project permissions.

## Remote API extension

The encrypted channel keeps the existing v1 handshake and cipher. Hosts advertise
`capabilities.remoteTerminal: 1` and `capabilities.desktop` in `GET /api/me`.
The existing 96 KiB request ceiling is unchanged.

| Encrypted message | Contract |
| --- | --- |
| `terminal-open` | `id`, `token`, `sessionId`, explicit `clientId`, `after`, and `snapshot`; normal response returns `{streamId: id}`. |
| `terminal-send` | `id`, `token`, `streamId`, and the existing terminal `message`; receipts/refusals arrive asynchronously. |
| `terminal-close` | Detach `streamId`; does not terminate the session. |
| `terminal-event` | Server message containing `streamId` and the original terminal page, snapshot, state, receipt, or refusal as `message`. |
| `terminal-closed` | Server message containing `streamId` and a WebSocket-style close `code`. |
| `events-open` | `id`, `token`, `topics`, and resume cursor `after`; normal response returns `{streamId: id}` and forwards the authenticated `/api/events` feed. |
| `events-event` | Server message containing `streamId`, topic, and the changed topic snapshot. |
| `events-close` | Detach `streamId` without changing host state. |
| `events-closed` | Server message containing `streamId` and a WebSocket-style close `code`. |

Client command IDs share the monotonically increasing request sequence. Tokens,
session IDs, terminal contents, and stream commands are inside ciphertext. Event
stream limits, cursor recovery, and phone fallback are defined in
[session ownership and protocol](architecture.md#delivery-contract). The host
forwards terminals only to its own authenticated loopback gateway, retaining owner
checks, lease enforcement, input validation, and durable receipts. Tampering,
replay, revocation, or buffer limits close the channel. Attachments and uncertain
input are not replayed.

File routes are limited to configured projects: directory listing, hash-pinned
reads, directory creation, staged upload begin/chunk/commit/abort, and
version-checked explicit deletion. The desktop sync UI does not call deletion.
Resources use `GET /api/machine/resources`. General workspace administration,
arbitrary forwarding, and native provider gateways remain outside the allowlist.

Source contracts: [remote protocol](../packages/remote/src/protocol.ts),
[remote gateway](../packages/host/src/remote-access.ts),
[file/resource service](../packages/host/src/desktop.ts),
[native transfer client](../apps/macos/Sources/InfiniteCore/FileTransfer.swift),
and [sync planner](../apps/macos/Sources/InfiniteCore/SyncPlanner.swift).

## Acceptance record

| Check | Status |
| --- | --- |
| Repository host/shared checks | `npm run check` passed: 167 tests, typechecks, and builds, including CLI resource/close/dispatch and shared-upload permission checks. |
| Mobile static checks | Lint and TypeScript checks passed. Physical-device behavior remains unqualified. |
| Native safety tests | Six passed, including conflict/symlink refusal, anchored staging, baseline scope, and preservation of open-editor writes and file permissions. |
| Swift-to-Node encrypted integration | One passed: authenticated channel, hash-pinned binary upload/download, and real demo PTY input/output. |
| Signed native build and installed launch | Passed, including saved-profile reconnect, live resources, bundled terminal rendering, and native layout. Enter submitted a multiline shell draft; Shift-Enter kept it local. |
| Isolated cmux SDK/helper integration | Passed with helper 0.13.4: enrollment, catalog, exact argument/working-directory launch, raw bytes, file RPCs, reconnect with process continuity, explicit close, and revocation. |
| Actual Claude Code and Codex terminal interaction | Claude Code 2.1.301 onboarding and Codex 0.163.0 login screens streamed through cmux, acknowledged resizing, and survived disconnect/reattach. Authenticated provider interaction and full local-UI parity remain unqualified. |
| Intended-server provider startup | Claude Code 2.1.289 reached its folder-trust screen, left unanswered. Codex 0.162.0 reached its normal prompt through the cmux-only launcher; the Mac rendered its real UI, delivered Escape to dismiss an update suggestion, and reattached with input disabled. No model prompt or provider permission approval was sent. The separate automated Codex CLI attach probe was inconclusive. |
| Renderer failure and stale completion probes | Passed: replay overflow refuses partial state; fresh rendering gates input; old send receipts preserve newer drafts. |
| Ended-session reconnect regression | Passed: ended streams are not repeatedly reopened; their notice does not claim the process continues. Running sessions remain reconnectable and appear first. |
| Control lifecycle regressions | Nine actual-model scenarios passed: delayed claim/renew responses cannot revive released control or disrupt a newer attachment, and queued raw input cannot cross release/reclaim. The prior implementation failed the regression probes. |
| App-independent installed CLI | Passed: session/resource listing and native cmux dispatch. Full cmux TUI and single-terminal attach rendered output and detached successfully. With the app closed, the same terminal ID, server PID and process start time survived CLI input and detachment. |
| Live native file workflow | Passed: individual download, reviewed three-file download sync, and independent SHA-256 comparison of all four copies. All configured project files passed the server-account read audit after narrow ACL provisioning. Live upload/overwrite interruption remains unqualified. |
| Shared-account upload permissions | Isolated Linux checks passed, including the active deployed module: replacement retained the shared group and allowed the provider account to append; a forbidden group change left the original intact. The prior implementation lost provider write access. |
| Interrupted transfer and broader filesystem concurrency | Complete workflow acceptance pending; ambient server writers are outside the managed-operation fence. |
| Phone/Mac continuity across sleep, app exit, and network outage | Pending physical-device run. |
| Intended-server deployment | Initial activation passed 163 Linux host tests; the file-permission follow-up passed all 167 tests plus typechecks/builds. Authenticated API checks and original-worker identity comparisons passed after activation. The Mac reconnected and displayed fresh resources. |
| Linux cmux daemon | Pinned 0.13.4 passed isolated native SDK enrollment, output, paste, resize, reconnect with PTY continuity, and close. Separate supervised service installed on loopback only; distinct Mac and CLI identities enrolled and verified against the same live shell. |
| Backup compatibility | Installed preflight passed for both service cgroups and all five state directories. Seven boundary tests and a Linux ACL recovery test passed. No live freeze or full backup ran during commissioning. |

Run `swift test --package-path apps/macos` for native unit/safety tests.
`npx tsx scripts/test-macos-integration.ts` starts an isolated local Node host and
runs Swift encrypted transport/file/terminal integration. Its synthetic process
does not establish provider authentication, real-provider UI parity, or deployed
acceptance. Run `npm run check` and the mobile lint/typecheck commands before
declaring the combined change verified.
