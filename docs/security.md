# Confidentiality boundary

Managed multi-tenant operation requires confidentiality from the service operator. The current implementation does not provide it. The [managed tenant contract](multi-tenant.md) defines the required confidential execution, attestation, client, keys, and recovery design. The development host lacks confidential VM support; it currently runs the owner's single-tenant pilot and cannot host operator-confidential tenants. The [commissioning record](../deploy/ubuntu/commissioning.md) identifies the deployed controls and remaining checks.

An unattended agent's execution environment must read the files, credentials, and model context it uses. On an ordinary VM, the host administrator can potentially access that environment. Disk encryption, a VPN, containers, and application encryption do not solve that boundary. A properly attested confidential runtime can move trust away from the host operator, but still trusts the measured guest software, hardware/attestation chain, and user device. It does not protect plaintext from a compromised agent or guest software already authorized to read it.

## Implemented protection

The optional [MCP request connector](mcp.md) uses a dedicated bearer credential
and explicit project allowlist on a separate loopback listener. Expose only its
`/mcp` path through a dedicated HTTPS proxy. It grants no paired-device or owner
API access, checks request ownership and current scope, and retains connector
provenance in mission instructions and answers. A Grok Bot name does not isolate
an account-wide App connection. Provider permission approvals remain outside
the connector tools.

Goal and team requirements, decisions, reports, outcomes, and receipts use the
encrypted state and journal. A Goal records approved paths, execution limits,
and requested model profiles. The host validates task ownership and integrated
changes against that scope. Public lifecycle and steering requests for a
goal-owned Team must go through its Goal; decision answers require its current
active cycle. Outcomes require an explicit owner/controller assessment after
work stops. These controls do not establish product success or contain every
possible provider tool effect.

Each member report is bound to its run, member, and revision and is acknowledged
after durable recording. Separate Git copies isolate edits without sandboxing
providers. Git, setup, and check commands must run under the intended agent
identity. Git commands that the host runs in team copies ignore replace refs (`GIT_NO_REPLACE_OBJECTS=1`), so a ref that a member plants in a team copy cannot change what a read returns. Workspace files remain plaintext runtime data. Provider permissions
remain with the owner unless an explicit repository policy delegates bounded
one-shot requests to the strong coordinator. Guarded delivery checks the current
assignment, workspace, prompt, policy, expiry and human input control. Workspace
trust and persistent allow rules remain outside delegation. An owner who sets
`teams.trustWorkspaces` trusts every team root: members then start trusted in
their own folders. Claude team launches load no project or local settings file
(`--setting-sources user`), so hooks, allow rules and MCP servers that an
earlier member committed to `.claude/settings.json` or `.mcp.json` never apply
to a later member. A trusted Codex member does not start while its folder, or
any folder above it up to the Git root, holds a `.codex` entry, so Codex
settings, hooks and MCP servers that an earlier member committed do not reach
it. That check runs just before the launch, so a file written in the moment
between the check and Codex's start is not caught. Both checks cover what the
repository carries, not the agent account's own provider configuration, which
any agent-account process can edit. Headless OpenCode
rejects unmet permissions instead of providing an interactive approval flow. Profile `dataUse` labels disclose
configured contributor use without changing provider terms or retention. See
[Goals and agent teams](teams.md) for scope, routing, limits, and recovery.

### Claude Code Mode

Claude Code has an experimental Code Mode: the model writes one program that
calls several tools, where it would otherwise call them one at a time. The host
asks for it when it starts a new session and the top-level `codeMode.claude`
setting says so:

- `off`, the default, also when the key is absent: no new session asks for it.
- `headless`: served headless Claude sessions ask for it.
- `all`: interactive Claude sessions do too, the owner's and team members'.

The host only asks. It does not check that Claude Code turned Code Mode on. A
profile whose tool list leaves out the program tool, a restricted launch, an
older model, or a custom API endpoint starts without it, and the host's record
still says that it asked.

Some launches never ask. A permission coordinator and a mission coordinator
run with tool lists that leave out the program tool. Permission-reviewer turns,
headless launches that the permission channel does not serve, evaluation and
learning sessions, other providers, and launches outside the host's worker stay
as they are. A headless run takes the request only from its `--settings`
argument, and only a served launch carries one.

In a served session each tool call inside a program raises its own hooks, so
the permission channel still decides each call.

A session records whether the host asked for Code Mode. Resuming the same
conversation asks again when the record says so, whatever the setting says by
then, and does not ask when the record says no or the session is older than
this setting. One case differs: an owner resume has no permission channel, so a
conversation resumed through a headless profile starts without Code Mode, and
its new record says so. The record is not part of any API response.

Before setting `all`:

- Claude Code asks for a confirmation once per operating-system account. The
  host does not answer it, and this setting does not accept it in advance.
  Accept it once in a terminal on the account that runs the agents. Until then
  every interactive launch stops at the confirmation.
- Claude Code's documentation names 2.1.328 as the first version with the hook
  behaviour described here, and the host was measured against 2.1.330. The host
  does not check the installed version.
- A Code Mode session cannot use Remote Control, Claude in Chrome, or computer
  use.
- Where agents start through `sudo`, an interactive launch carries the request
  in the environment variable `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`, which
  reaches Claude Code only if the sudoers `env_keep` list names it. Served
  headless launches carry it in their `--settings` argument and need no sudoers
  entry.

On the Ubuntu host, provider wrappers can load owner-managed environment files
for host-wide credentials, Android tooling, and a selected project. Values are
exported literally and never passed through `eval`, so file contents cannot
execute shell substitutions or command syntax during loading. A deny list
protects the launcher's `PATH`, home, shell, temporary and XDG paths, sudo and
Infinite control variables, and wrapper-owned settings from file overrides,
and also rejects the loader's own underscore-prefixed namespace and names the
shell interprets on assignment (`IFS`, `OPTIND`, `PS1`..`PS4`, `PWD`, `ENV`,
`BASH_ENV`, `CDPATH`, locale variables and similar), so a file cannot redirect
project selection or abort the wrapper. A trailing carriage return is dropped.
Files are additive: a variable the host already injected into the session
(sudoers `env_keep`, such as the native token and OpenCode credentials) is
never overridden by a file, and `OPENCODE_SERVER_*` / `OPENCODE_CONFIG_CONTENT`
are denied outright.
This keeps owner-supplied build credentials from changing the execution
identity, launcher paths, or host-to-worker control channel.

Optional Linear tracking sends configured goal and feature details to Linear.
Its API credential stays in a private host file outside runtime and project
roots and is never passed into agent environments. Clients receive issue
snapshots and links.
Those snapshots are visible to the paired tenant roles and belong to the same
private record boundary as goal requirements. Unavailable, closed, or changed
issues block new work. Linear workflow state does not establish local execution
completion, merge, deployment, or product achievement.

Application records are encrypted with AES-256-GCM. Each record has a fresh 96-bit random nonce and authenticated data containing the format version, session ID, and sequence number. This detects content modification and substitution between records or sessions. It does not detect deletion/rollback of a whole valid suffix without an independently anchored checkpoint.

The 256-bit key is a separate 0600 file outside the data directory, loaded into the API and worker memory. Encrypting a backup of the state directory is useful only if the attacker does not also obtain this key. Back up the key separately through an owner-controlled channel; losing it loses the recording. The local development layout is not a protected production key management system.

Metadata and context use atomic encrypted writes. Workers fsync recording entries, serialize input, and refuse to silently continue after a detected recording error. A short output buffer of at most roughly 40 ms is not yet durable if the worker or machine dies; this is distinct from client disconnection.

Owner context is bound to a project ID and its canonical checkout path. Reusing an ID for another path does not import its saved text. Legacy context without a codebase binding is withheld until the owner saves context for the current project. Sessions retain source project IDs, context versions, relationship purposes, and the relationship version used at creation. Two projects sharing a directory still have separate context records.

Only an owner can create a directed context relationship. It shares the source project's owner-authored text with future managed sessions in the consuming project; it does not import conversations, follow the source's links, or authorize filesystem access. A changed source path blocks retrieval until the relationship is reviewed. Removing a link affects future snapshots, including team members launched later; it cannot erase text already delivered to a provider or saved in a session. Native CLI launches record this snapshot but preserve their existing no-injection behavior.

Fresh native launches reject recognized conversation-selection arguments. Use Infinite's recorded-session resume operation, which retains the original project and verifies its checkout binding. This is application context routing, not an OS sandbox or a complete provider argument policy. Provider accounts retain their configured filesystem/network access, credentials, global instructions, and native interactive commands. A provider's permission to read another checkout does not grant the team permission to use its context. Separate execution identities or containers are needed for filesystem-level isolation.

The laptop CLI also saves its Ctrl+E drafts with authenticated encryption and private file permissions. The encryption key is derived from the high-entropy paired device key with HKDF, scoped to the origin, session, project, and runtime. Draft ciphertext alone does not reveal the text; someone who obtains the paired client configuration can derive its key. This is local crash recovery, not protection from a compromised laptop. No draft is uploaded before explicit insertion, and unconfirmed insertions remain blocked on recovery.

The native Mac app's local prompt composer has its own AES-GCM draft store and a
device-only Keychain key. Draft identity is authenticated with the ciphertext;
pending submission identities survive recovery and are not automatically
resubmitted. Editing the composer does not send keystrokes to the host. Explicit
terminal typing (**Type in terminal**) is a separate input mode. Neither mode supplies provider
approval decisions automatically.

The HTTP listener is loopback-only. Host and Origin checks, HttpOnly/SameSite cookies, role checks, bounded request bodies, login throttling, and a restrictive CSP cover the private control interface. Native release clients require HTTPS and keep their key in platform secure storage. Browser data is not cached to localStorage or a service worker. Decrypted log export is an explicit download to the owner's device.

The experimental native Codex gateway grants owner-level provider access and requires a bearer key plus the worker's device-bound control lease. Browser cookies and controller/viewer roles cannot connect. Both provider listeners and the laptop relay bind only to loopback and require per-run capabilities; the local TUI receives a relay capability, not the owner's device key. The worker fences each native request after takeover and never supplies an approval response itself. Conversation pinning prevents accidental session switching; it is not a sandbox against an owner or an agent that can execute commands. The observer capability and provider state stay inside the same trusted tenant runtime.

OpenCode's native HTTP gateway has the same owner/control boundary. Every request receives a single-use worker capability; streamed reads close after control is lost. The worker fixes the cloud directory and rejects session creation, forks, deletion, lifecycle/configuration changes, and unrelated permission/question replies. Request bodies are limited to 8 MiB and buffered responses to 32 MiB. Native provider access is still a trusted owner capability, not isolation between projects or tenants. The local interface can read provider configuration returned by OpenCode; do not treat this endpoint as a restricted viewer API.

Codex `--laptop` execution additionally requires a single-tenant host, a paired owner bearer, and a separate random per-session executor capability. The worker receives only the capability hash through private bootstrap; public session records omit the secret. The detached laptop service receives credentials through private IPC and opens an outbound connection. The actual exec-server binds to loopback with its own bearer; neither the model nor the local native interface receives the owner key. Origin-bearing browser connections cannot attach. Channels and buffers are bounded. The service polls pairing/session status and stops on confirmed revocation or exit.

The selected cwd and roots describe Codex's workspace, not a filesystem isolation boundary. Laptop shell tools retain the selected provider sandbox and the local account's authority. Closing the tunnel or cleaning up the supervisor does not establish containment of arbitrary tool descendants. Automatic handoff requires a verified prepared tree, a settled recorded executor boundary and qualified provider selection. An unresolved operation pauses. Publication epochs reject late local updates; they do not revoke arbitrary detached descendants or external effects. A failed connection never authorizes replay or a provider approval. Captures record stable reads over an observation span, not an atomic database or filesystem snapshot. Returning files go into a new recovery directory without overwriting the laptop copy.

Selected-root files, content-addressed blobs and materialized checkpoints are plaintext runtime data with private permissions; keep them on encrypted storage. The selected roots include ignored files and repository metadata, including any credentials stored inside that scope. Source transfer does not copy the entire home. The owner-only workspace export endpoint returns verified checkpoint data; controller/viewer keys and browser-origin requests cannot use it. A separate execution identity needs the dedicated shared data directory in the Ubuntu template, while receipts, blobs, keys and control sockets stay private.

A provider-limit observation and a usage total are records of what the host
saw. Neither carries a credential, and neither is an inference about completion
or product impact. They never substitute for a member's report. The host's only
action toward a limited member is stopping it. It never sends that member input
or answers a provider dialog, and the relaunch on a fallback is a new member.
Price tables stay in private host configuration. Budget amounts, aggregated
totals, and limit observations reach clients.

## Evidence store at rest

The evidence database follows the at-rest rule of contract C1 in the self-improving teams design. Its file is private (`0600`) in a private directory (`0700`). The host narrows a wider file mode on open, after the key check passes. Each payload is sealed with AES-256-GCM under a key that HKDF-SHA-256 derives from the vault key. The seal binds a payload to its table and row ID, so a payload copied into another row does not open.

A plain column holds only an opaque ID, an enumeration, a number, or a time. A task ID, a path, and any text from a repository or a run are encrypted. When such a value must be matched, the row stores a blind index: a keyed HMAC-SHA-256 that keeps value classes apart. Event keys are stored the same way. The host refuses an existing file that fails the encrypted key check, an empty file included, and it never falls back to plaintext. Status reasons and log lines never name a path.

Eval capture ([teams](teams.md#eval-capture)) keeps its material only in the evidence store. The capsule, both patches, and the file names are sealed there. They never reach a mirror ref, a tracked file, a log line, an error, or a member's context. Plain columns hold only IDs, states, reason codes, counts, and times, and a project is matched by a blind index. A cancelled run's deletion deletes its eval material with it. The `eval` block of a project's team configuration reaches no member, and the routine approval digest leaves it out.

Mined tasks keep their material the same way. Validation stores file lists sealed, and it stores each expected case only as a SHA-256 hash. No log line names a file, a commit, or a case. See [eval mining and validation](teams.md#eval-mining-and-validation).

## Eval grader account

The grader account runs the focused tests and the guard checks of a replay candidate. It is an account of its own. It has no provider login, no repository credential, and no read access to host state. The host reaches it only through the launcher that [the grader install](../deploy/ubuntu/grader.md) sets up. The launcher admits nine operations, and it confines each one to the grader's root.

Before each task the host probes the account. The probe requires a user id that differs from the host's, a root of mode `0700` that the grader owns, no writable directory above that root, the tools the launcher needs, no readable canary, and a closed metadata address. Any other result is a named state, and no task starts. The probe runs before each task, not during one.

### What a hostile test can reach

| Channel | What the grader can reach | Control |
|---|---|---|
| Host environment | Nothing. A child starts from an empty environment plus a fixed list of ten names. No grant, egress key, hook token, provider login, or proxy variable reaches it. | The launcher sets the environment. The host starts the launcher with `PATH` and `LANG` only. |
| Host files | Nothing that the probe lists. The probe reads the evidence database, the vault key, the state, run, and team workspace directories, each mirror of a GitHub project, and the owner's `canaries`. | A readable canary gives `exposed`. |
| Grader files, read by the host | The host opens no file under the grader's root. It reads reports only through the launcher's `read`, which admits `reports/round-1.xml` to `reports/round-6.tap` and refuses links. A report is at most 8 MiB. | The launcher's read and the host's report parser. |
| Other accounts | No signal, trace, or environment read of host or agent processes. A different user id cannot reach them. | The account's user id, checked by the probe. |
| Loopback services | Reachable. Each one needs a credential that the grader does not hold. See the table below. | The credentials. |
| Metadata address and private networks | Refused by the network rule in [the grader install](../deploy/ubuntu/grader.md#4-the-network-rule). The probe reports `network-open` while the metadata address answers. | The network rule and the probe. |
| Processes after a task | Stopped. The host runs `stop` and checks the process table after each round and each task. A process that survives blocks the job with `grader-processes-alive`. | `stop`, and the process check of the host. |
| Files after a task | Removed. Each task gets a new home and temporary directory. `clean` leaves only the job's base bundle, and the host checks its digest before each task. | `clean` and `remove`, and the digest. |
| Test results | A focused test's exit code never validates a task. Only parsed reports from the reference and base rounds can validate one, and a missing or invalid report leaves the attempt undecided. | The round rules. |

### Loopback services

Each service below runs on loopback, so the grader can open a connection to it. Each one needs the credential in the last column.

| Service | Address | Credential |
|---|---|---|
| API | `127.0.0.1:4780` | A device token |
| Hook listener | The address that each session receives in its hook variables | The hook token |
| Egress proxy | `127.0.0.1:4785` | The egress key, or the session credential that the host gives each session. See [egress](../deploy/ubuntu/egress.md). |
| GitHub credential proxy | `127.0.0.1:8417` | A host-signed grant. See [the GitHub proxy](../deploy/ubuntu/github-proxy.md). |
| Relay | `127.0.0.1:4790` | The relay registration key of the runner. Started with `--proxy-socket`, as [the public relay](../deploy/ubuntu/public-relay.md) installs it, the port refuses relay clients, and only `/health` answers without the key. |
| Egress socket | The same port as the egress proxy | The same as the egress proxy. systemd holds the port while the proxy is down. |

A second instance runs its own listeners on its own ports, with its own credentials. See [instances](../deploy/ubuntu/instances.md).

### What stays with the owner

These are the owner's choices. The design does not impose them.

- Memory and CPU in a round are bounded only by the time limit and by the host-load check before each task.
- `/proc` shows the grader the command lines of agent processes. The owner can mount `/proc` with `hidepid=invisible` and a `gid=` exemption for the host account.
- A private `/tmp`, a disk quota, and a memory limit for the grader.

### What stays reachable

- The shared `/tmp`. The grader can read what other accounts leave readable there. The host writes no eval material outside the grader's root.
- Process command lines in `/proc`. The host passes no secret in an argument.
- The loopback services in the table above.
- The public network. Package installs need it, so the network rule rejects only the private, link-local, carrier-grade NAT, and multicast ranges.
- The disk. A file may reach 4 GiB. The host requires 10 GiB and 200,000 inodes free before each task.
- Untrusted code. Each focused test is code from the repository at an old commit, with old dependencies. It runs as the grader, with the launcher's limits and no host credential.

The probe checks each canary before a task. It cannot see a path that becomes readable during a round, and that path is checked only at the next probe.

## Eval member account

The eval account runs the member of a replay trial: a model session that works on one task of a project, with its own provider logins. It is an account of its own. It has no repository credential, no GitHub grant, and no project environment. The host reaches it only through the launcher that [the eval member account install](../deploy/ubuntu/eval.md) sets up. Each launcher operation is one call, and it confines the call to the account's root, in which the member's workspace is one directory.

Before each trial the host stops the account's processes, removes every trial workspace, resets the account's home from a root-owned template, and then probes the account. The probe runs before a trial, not during one. Only the state `ready` starts a trial. The other states are `not-configured`, `unavailable`, `misconfigured`, `exposed`, `network-open`, and `busy`, and each names the failed check.

### What a trial member can reach

| Channel | What the member can reach | Control |
|---|---|---|
| Production credentials | Nothing. The Manager launches a learning session with the eval account's own launch profile, never with a production one. The eval wrapper loads no project environment and unsets `INFINITE_GITHUB_GRANT` and `INFINITE_GITHUB_PROXY`. The launcher receives none of the host's variables. | The profile choice in the Manager, the wrapper, and the sudo rule's `!env_keep`. |
| The repository | Only the replay base. The workspace is cloned from a bundle of one branch. The launcher removes the clone's remote and deletes the branch, and `check` proves that the reference commit and the other objects are absent and that `git remote` prints nothing. | `prepare` and `check`. |
| Hidden tests and grading material | Nothing. Hidden material exists only in the grader's root, which the eval account cannot read. | The grader's root mode and the probe's canaries. |
| Host state | Nothing that the probe lists: the evidence database, the vault key, the state, run, and team workspace directories, each GitHub mirror and project checkout, the grader's root, and the owner's `canaries`. | The probe. A readable canary gives `exposed`. |
| Other trials and sessions | Nothing. One trial runs at a time. Before each one, the probe finds no entry in the trials root, no leftover in the home, and no System V object or file of the account in the shared directories `stop` empties. | `stop`, `clean`, `scrub`, and the probe. |
| Earlier trials | The login files, which `scrub` keeps. The rest of the home, the temporary directory, and the trials root do not survive a trial. | `scrub` and `clean`. |
| Provider endpoints | Reachable through the egress proxy with the `_eval` credential, which the proxy limits to its own list. A direct connection is refused by the network rule. | The `_eval` list and `eval.nft`. |
| Processes | None survive a trial. The host runs `stop` and checks the process table, in up to three rounds, before and after each trial. | `stop` and the process check. |
| Permission dialogs | The project's permission pipeline decides them, and for a project the host permission agent serves, that agent does. A dialog that nobody decides ends the trial `permission`. Nothing answers it. | The permission pipeline. |

A trial is labelled `isolated` only when the probe is `ready`, its fetch of the repository fails both directly and through the proxy, and the source is clean. Otherwise it is labelled `none`. In observe mode the proxy lets `_eval` reach any public host, so the fetch succeeds and the trial is labelled `none`.

### Loopback services

| Service | Address | Credential the member holds |
|---|---|---|
| Hook listener | The address in the session's hook variables | Its own hook token, which serves only its session |
| Egress proxy | `127.0.0.1:4785` | The `_eval` credential, limited to its own list |
| GitHub credential proxy | `127.0.0.1:8417` | None. The wrapper removes the grant variables. |
| API | `127.0.0.1:4780` | None |
| Relay | `127.0.0.1:4790` | None. The owner lists the relay key in `canaries`. |

### What stays with the owner

These are the owner's choices. The design does not impose them.

- The provider logins, and whether the provider keeps history and memory for them. Use the logins for nothing else (owner decision 2). The host cannot see what a provider keeps on its own side for a login.
- The files of the home template, which every trial loads.
- The `canaries` of the member and of the grader, the egress lists, and the network rule.
- Whether cron and `at` deny the account, as the install of [the eval member account](../deploy/ubuntu/eval.md) says.
- `/proc` hiding, a private `/tmp`, a disk quota, and a memory limit for the account.
- The `trialsPerDay` cap, the job windows, and the choice of the candidate profiles.

### What stays reachable

- The login files. `scrub` keeps them, because the providers rewrite them on refresh. A member can therefore leave a value in them for the next trial of any task. The design accepts that channel.
- Whatever a provider keeps for its login on its own side.
- The package registries of `_eval-setup` for up to 15 minutes after setup, and any process setup left running or any file that holds its credential. Do not list a registry that serves the project's own later releases.
- Other world-writable locations. `stop` removes the account's System V shared memory, semaphores, and message queues, and its own files in `/tmp`, `/var/tmp`, `/dev/shm`, `/dev/mqueue`, `/run/lock`, and `/var/crash`. It fails when any of them remains, and the probe reports `busy` for the account's objects and files there. Other accounts' readable files in those directories stay. A world-writable directory that the list does not name is not emptied, and a file the account leaves there survives, so an owner who adds such a directory to the machine adds it to the launcher's `STOP_DIRS` list. Abstract Unix sockets end with the processes, and the kernel's other per-user state, such as keyrings, is not inspected.
- Process command lines in `/proc`. The host passes no secret in an argument. The launcher passes the setup and probe proxy credentials in the environment of the command, never in the arguments of a long-lived process: `env` holds them and runs `timeout`, so the arguments of `timeout` and of the command carry none. Another local account can still read the arguments of `prlimit` and `env` for the moment before each runs its successor.
- Cron and `at` jobs, unless the owner denies them to the account. A job would outlive `stop`.
- Any public host that the `_eval` list names, and every public host in observe mode.
- The loopback services in the table above, each of which needs a credential the member does not hold.

## Remote machine transport

Optional remote access is restricted to single-tenant runners. A runner can accept encrypted direct WebSockets and connect outbound to a separate relay. Keep the runner's ordinary HTTP API private. Only the separate relay endpoint is intended for public HTTPS exposure; it forwards opaque frames and routing metadata rather than exposing runner administration. The supported public deployment puts Cloudflare Access in front of it: a service token is checked at Cloudflare's edge and the tunnel validates the Access JWT before forwarding, so unauthenticated traffic does not reach the server. Access is a spam and flood gate, not the application authentication; the paired device key still authenticates every channel. [Remote machine setup](remote-machines.md) defines pairing and deployment.

The paired high-entropy device key authenticates the client and runner. The shared transport derives a pre-shared secret from its SHA-256 hash, authenticates fresh client/server nonces with HMAC, and uses HKDF to derive directional AES-GCM keys. Monotonic counters reject replay within each connection. The actual device key travels inside the encrypted request and is checked by the existing runner API. There is no forward secrecy: obtaining a paired key or its stored hash can expose captured transport sessions. Treat stored token hashes as transport secrets, not harmless password-verifier data.

The relay uses separate per-machine registration keys. It cannot decrypt application requests without paired key material, but can observe machine/channel identifiers, traffic sizes and timing, and can delay or drop traffic. A TLS-terminating proxy such as Cloudflare sits in the same position. Relay and runner connections, pending requests, frame sizes and buffered output are bounded. Upgrade attempts and concurrent client channels are also bounded per client address. Behind a local proxy, client channels enter only through a private Unix socket, and the relay reads the proxy's client-address header only there, so other local processes cannot choose an address or occupy client slots. Without Access in front, anyone who learns a machine ID can still occupy that machine's channels up to these limits. HTTPS remains required outside literal loopback development. This protocol is not confidential-VM attestation or protection from a compromised execution host.

A web portal's hosting origin is trusted to supply its JavaScript, so the relay serves no web client: a relay operator that supplied the code could capture the key before encryption. The browser client is for local development against a local or private host. Native keys use platform secure storage; browser pairings and decrypted views remain in tab memory. Browser speech dictation may use the browser vendor's speech service and is an explicit user action.

The native Mac client and both direct and relayed phone connections use this
application-encrypted transport. There is no automatic fallback to bearer HTTPS
when the encrypted endpoint is unavailable. Mac credentials remain in Keychain;
the phone uses platform secure storage. The Mac pins the authenticated machine ID
after first pairing. Initial pairing still trusts the manually provisioned device
key and the identity it authenticates; this is not independent hardware attestation
or an expiring enrollment protocol.

The allowlist now includes terminal and live-event streams, resource observations,
and bounded project file operations. It also admits three read-only `GET`
paths for the web [Swarm view](swarm.md): a project's directory-level code map
(`/api/projects/:id/graph/map`) and the touched-file sets of a team or a
session (`/api/teams/:id/context`, `/api/sessions/:id/context`). They carry
directory names, repository-relative file paths, and counts, which is the
class of data the file listing and session events already serve, and no source
text. The allowlist also admits `GET /api/decision-queue` as a read; global API
authentication still applies, and the route adds no role guard. The read answers
nothing. Like `GET /api/sessions`, it first shows the listed dialogs to the session
permission service, which may then start its review of a dialog the owner delegated
to it; ownership is judged after that, so such a dialog is not listed as the
owner's. A session prompt that only its terminal can answer is listed with
`terminalOnly: true`, and the answer route refuses it. `terminal-open`,
`terminal-send`, `terminal-close`, and the `events-*` messages
travel inside ciphertext, together with device credentials and session identifiers.
Server `terminal-event` frames carry original output, snapshots, state, receipts,
and refusals. The host connects only to its own loopback terminal gateway; it
cannot forward an arbitrary destination. Raw input remains owner-only, and
worker input leases and durable request identities remain authoritative. Each
channel limits and event-buffer behavior are defined in the
[session ownership and protocol](architecture.md#delivery-contract) and
[remote protocol](desktop.md#remote-api-extension) references. Closing an attachment
does not terminate its agent.

Every encrypted request checks current device authorization. Active encrypted
subscriptions also recheck authorization before output and periodically while
idle, so removed keys cannot retain streaming access in a running configuration.
Editing the configuration file still requires the documented API restart. No
terminal is automatically reattached and no uncertain input is automatically
replayed. Native provider gateways, general workspace administration, arbitrary
forwarding, and native launch arguments remain outside the allowlist. See
[desktop protocol](desktop.md#remote-api-extension).

Desktop file operations use configured project roots, reject symlinks and special
files, and keep the existing 96 KiB request limit. Transfers use at most 48 KiB raw
chunks and 256 MiB files. Downloads pin content hashes; staged uploads verify size,
hash, destination version, project, and paired device before commit. Host write
fences prevent file mutation while project agents run or a sync application is
active. The local sync UI previews conflicts and never propagates deletion.
Private local backups and baseline metadata are plaintext with private permissions;
they need the laptop's encrypted storage. They are not protected by transport
encryption after download. Concurrent filesystem mutation remains a separate
acceptance boundary; configured roots are not a sandbox against a trusted owner.

## Direct native cmux transport

The native app also supports a separate cmux route, terminal SDK, and bundled
helper. It does not translate an Infinite device key into a cmux identity.
Enrollment uses the daemon's invitation/approval flow. The upstream remote
transport uses authenticated Noise connections; its cryptographic and enrollment
contract must be qualified with the selected SDK/helper/server artifacts. The
Infinite v1 pre-shared-key transport above does not inherit cmux's handshake or
security properties.

The app passes cmux invitations through standard input and keeps device identity
and known daemon pins together in a device-only Keychain item. The helper and SDK
share that identity in an owner-only runtime directory while connected. Normal
disconnect saves the identity and removes the runtime directory; abrupt
termination can leave private plaintext identity files behind. Do not describe
that cleanup as crash-proof erasure. Non-loopback routes require `wss` or `iroh`;
the daemon sees plaintext because it runs the terminals and file service.

A cmux-enrolled device has broad daemon authority. Infinite viewer/controller
roles and worker leases do not constrain independent cmux clients, local typing,
or other cmux controllers. Their concurrent actions can invalidate a prompt
between observations. SDK queue acceptance is not a durable input receipt, and
ambiguous mutations must not be automatically resent. Neither enrollment nor any
lease grants permission to bypass provider approval. The existing Infinite cmux
discovery adapter continues to verify its target surface and foreground process;
it is a different attachment path from direct native cmux.

Provider ceilings are root-owned Claude Code and Codex policy files that the agent account cannot change. They are installed by the owner on a server, not by the host. See [provider ceilings](../deploy/ubuntu/ceilings.md) for the keys, what each one does not stop, and how `infinite doctor` checks them.

## Required on a real host

Use Tailscale with device approval, restrictive ACLs, and SSH policy. Expose the API through **Serve**, never Funnel. Serve is private to the tailnet; it is a transport layer, not file encryption or runtime isolation. Check with a device outside the tailnet that the host is inaccessible. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

Put source repositories, native agent home directories, native history, caches, temporary files containing project data, and swap on encrypted storage. For Hetzner bare metal, use LUKS2 with a recovery/unlock plan. For AWS, encrypted EBS is a baseline against storage exposure, not against an authorized running guest or an attacker holding the cloud account. Files must be mounted while work runs.

Separate the API service Unix identity from native agent execution identities. The local default profiles intentionally run as the current user; **they are not a sandbox**. The Ubuntu template uses a distinct `infinite-agent` account and constrained sudo launch profiles so an ordinary agent command cannot directly read the API key, device credentials, or worker sockets. Agents sharing that account still share its trust boundary. Use separate users/containers per project if those projects need isolation, and do not mount Docker's host socket.

Recording-failed team reviewer retirement reuses the configured `teams.commandPrefix` to signal agent-owned descendants after checking each process start time; it needs no new sudo grant.

Authenticate providers on the server in their own protected home, with only the credentials needed for approved projects. An SSH-agent forwarded from the laptop stops being useful when the laptop disappears. Copying the entire laptop home would import excessive credentials and platform-specific paths. Inventory skills, AGENTS.md, MCP services, environment variables, tool versions, Git identity, and project dependencies explicitly.

Repository briefings execute through a root-owned wrapper as `infinite-agent`, using that account's provider authentication (Codex, or Muse Spark and DeepSeek through OpenCode) and read-only source collection. The selected project source and explicitly supplied recorded chat messages are sent to the configured writer's provider; when the account holds a TypeSafe key, changed-line excerpts and claim excerpts are also sent to Jev. Muse Spark 1.3 Contributor is a contributor data-use model; check the provider's terms before routing a project to it. Approve that transmission for each project before enabling automatic briefings. The feature does not discover provider histories or other sessions. The agent account remains a shared single-tenant trust boundary; briefings are unavailable when the runtime cannot resolve a cloud source root, including current hybrid laptop and cmux sessions. See [repository briefings](repository-briefings.md) for deployment and evidence limits.

For unattended GitHub delivery, the optional [GitHub App renewal service](../deploy/ubuntu/github-app.md)
keeps the app private key outside agent-readable storage and issues one-repository
installation tokens. The Git/GitHub client refuses expired or mismatched tokens
for configured repositories. Existing credentials for other repositories remain
separate. Agents sharing a Unix identity can read that identity's token files;
this does not add filesystem isolation or change provider approval controls.

The optional [GitHub credential proxy](../deploy/ubuntu/github-proxy.md)
(`autonomy.boundary.github`) moves the token cache to its own account. The host
signs a grant for each session and host Git operation: one project and one
repository; the operations fetch, push, pr, or merge; and the branches a push may
update. A session outside a team gets the owner's scope only when an owner-only
route started it; any other caller gets fetch only. Team members other than
delivery can only fetch, delivery can push and open or merge pull requests only
for its own head branch, and coordinators get no grant. The grant key must be a
root-owned file below root-owned directories, and the proxy reports the cache as
closed to agents only after ruling out ACLs. The
proxy refuses tags, deletions, other refs, and `gh` commands outside a
pull-request allowlist. A push grant can still push any content to its own
branches, so base-branch protection stays necessary. Sessions share the agent
account and can read each other's grants from the process environment; a grant
bounds what the agent account can do, not which session does it.

Workspace sync runs only on single-tenant hosts. Owner CLI launches without `--project` start or reuse it for the selected home-relative checkout; an explicit `infinite sync` can also start it. Folder registration accepts only an owner bearer key, persists in sealed host state, and refuses symlink aliases, overlapping projects, and protected host paths. It uploads the entire Git root of the selected checkout, including ignored and untracked files and its `.git` directory. For a linked Git worktree it also uploads Git metadata from outside the root: the common repository's objects, refs, ref logs, packed refs, `info/`, `shallow`, `description`, and a projected config, and the worktree's own `HEAD`, `index`, ref logs, refs, in-progress merge, rebase, cherry-pick, revert, and bisect state, and a projected `config.worktree`. A Git config can carry credentials such as a token in a remote URL. Keep credentials out of synced checkouts or accept that they reach the host. A forced apply replaces the cloud tree; one previous copy is kept beside the project directory. Received chunks are plaintext files under the host's private state directory, so that directory belongs on the encrypted storage above. See [workspace sync](workspace-sync.md).

The owner pilot now has an age-encrypted laptop backup with file, SQLite, and journal restore verification. Its daily server timer creates encrypted snapshots; automatic upload to independent storage is still pending. See [backup operations](../deploy/ubuntu/backups.md).

Use encrypted off-host backups with restore testing. Keep the backup decryption key outside the rented host where feasible, and separate its repository credentials from keys that can delete prior backups. RAID is availability against a drive failure, not a backup. Monitor disk capacity and inode counts; the recording currently has no automatic retention cap.

## Threats that remain

- Compromised guest root or the active agent can read the plaintext accessible to that agent. A compromised API process can read all records it has a key for.
- A stolen paired device key permits that role until it is removed from host configuration and the API is restarted. Browser login cookies expire after 12 hours or API restart in this prototype.
- Agents can leak data through allowed tools, the internet, model API requests, or prompt injection. Provider retention policies are a separate boundary.
- Native terminal recordings are not a complete audit of every filesystem operation or hidden model context. An agent can write a file without printing it.
- Hook tokens are readable by the agent process. Each worker passes `INFINITE_HOOK_URL` and `INFINITE_HOOK_TOKEN` in the agent's environment, so the agent can post forged signals. Signals are evidence about the agent, never authority over it. They are labeled by source, never approve anything, and the screen checks run independently. The answer endpoint only presses keys for a dialog the terminal shows and checks it before and after.
- Codex hooks are off by default, and they must stay off for a repository whose contents you do not trust. When `attention.hooks.codex` is enabled, the hooks are injected with `--dangerously-bypass-hook-trust`. Spike S2 (2026-11-13, Codex CLI 0.167) showed that the flag is wider than the hooks Infinite injects: for that one process it also lets hooks that the working directory defines run without review, outside the command sandbox. It persists no trust. `doctor` prints a warning that names the flag when Codex hooks are enabled.
- With Codex hooks off, the host still passes Codex's `notify` setting to each session that has a hook listener: a team member, or a session under a handoff policy. An ordinary Codex session has no listener while Codex hooks are off, and gets no `notify`. This route passes no bypass flag and adds no hook trust, so a hook defined in the working directory that Codex was not already told to trust does not run because of it. Codex runs the command at each turn end with one JSON argument: the thread id, turn id, working directory, the turn's input messages and the last assistant message. Codex passes it as a command-line argument of the relay process, which lives at most 4 seconds. The host uses the thread id to find the Codex session file and reads it for usage. With Codex hooks off the host journals no attention signal from the notice; it uses the notice only to find and read the session record. No hook marks the start of a turn then, so a notice proves only that some turn ended, and the host reads the turn boundary from the record after the provider exits: the session's usage coverage can be `complete` only when that final read reached the end of the record and the last turn the record starts (`task_started`) has its own end row (`task_complete`). When the record shows a later turn that was cut short or aborted, coverage is `partial`. The JSON argument is visible to other local accounts in the process list while the program runs, unless process listings are hidden. Per-event signals (permission prompts, tool input) still need hooks and this route does not provide them.
- Push is an optional outbound dependency of the host. Bodies are minimal by default and carry no session content; `push.detail: "full"` is opt-in. Messages go through Expo's push service and can be cached there. The Expo access token lives in a 0600 file outside the state directory. Push can be left disabled.
- Signal payloads can contain commands and file contents. They are journaled encrypted like the rest of the recording and shown only to paired roles.
- Transcript bytes reach the worker only through the authenticated hook relay, which runs as the agent and reads only a regular `.jsonl` file the provider's own hook named, and for Claude Code the subagent transcript files in that session's `subagents` folder, for their usage only. After a provider exits, the same relay runs once more in drain mode; on the Ubuntu deployment that runs through the root-owned `transcript-drain` wrapper, which takes no arguments, and the worker's authenticated reply names the file. The path checks do not change for the drain. These path checks prevent accidental reads. They are not a boundary against the agent's own account, which can read the same files. The worker records them as `message` events in the encrypted journal, so chat carries the same plaintext the provider already stores in its home. On the Linux deployment the hook variables must be in sudo's `env_keep`, or hooks and transcripts never leave the agent account.
- The process census looks for processes left by an earlier API process after a restart. The host reads the process table itself and inspects processes of its own account. On the Ubuntu deployment it inspects the agent account through the root-owned `process-census` wrapper, which takes no arguments, takes its directory on standard input, and reads the working directories, open files and command lines of that account's processes. It reports only process ids and a reason, and it never signals, stops or changes a process. Its output crosses an account boundary and is validated before use. A process that refuses inspection is reported as such, and the host then says it cannot tell. The census is evidence about left-over processes; it is not a defense against a process of the agent account that hides on purpose or interferes with the census.
- Chat summaries send recorded messages to the configured external model (`summaries`). With `jev` configured, the host can also send candidate sentences from an agent's last message and the clipped first line of a long default-titled prompt to TypeSafe; the summary writer's provider receives that prompt only when Jev finds its clipped first line unclear. A team run's long untitled request is handled the same way, except that local paths and file URLs are removed before either model sees it and, with no `jev` configured, the request goes to the summary writer directly. Configure `jev` with an absolute `apiKeyFile` to a private 0600 file outside the state directory, and optional `model` (default `jev-latest`) and `baseUrl` (default TypeSafe API URL). The summary writer's key file follows the same private-file rule. Provider retention policies remain separate boundaries. With no `jev` key configured, no TypeSafe calls occur. With `intake.slack.classify` on, the host also sends the owner's own Slack request text, cut to 1,000 characters, to TypeSafe so the reading can choose between an answer and a request; nothing else from the thread, and no text from anyone else, is sent. Setting `jev.sessionReadings` to `false` (default `true`) stops both session flows, the last-message sentences and the clipped prompt line, and leaves only the intake route reading; the long-title question then goes to the summary writer directly.
- Speech recognition runs in the platform's recognizer (Apple, Google, or the browser vendor), which may process audio on its own servers. With `dictation` configured, the transcript text goes to that model with `store: false`. Leave the block unset to send no transcripts to a model; clients then insert raw transcripts.
- Confidential VMs can narrow provider/hypervisor threats, but they do not protect against compromised software inside the trusted guest. Attestation and external key release would be a separate security project, not a box to check on this service. [Confidential VM model](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/about-cvm).

Before putting private production repositories here, verify the isolation and storage controls on the selected host and repeat a real provider session through an actual laptop-network outage. Local synthetic continuity tests establish neither cloud hardening nor provider acceptance.

## GitHub-tracked source mirrors

The host mirror of each GitHub-tracked project is writable by the agent identity,
because the fetch that fills it must run as that identity. On the Ubuntu template,
only that identity can reach the GitHub App token through its Git credential
helper. Every network Git command against GitHub runs through `teams.commandPrefix`.
The mirror grants agents no power over the base that they lack today, since the
project directory they clone is already agent-writable. Its purpose is to keep team
runs apart from the working tree that sessions edit. It does not protect the base
from agents. Content fetched from GitHub is repository content, so it carries the
same prompt-injection risk as any checked-out file. The GitHub App mints tokens for
every repository it is installed on, not a hand-kept list, so a new installation
widens token issuance. See [GitHub App setup](../deploy/ubuntu/github-app.md).

The host also pushes team heads to GitHub through `teams.commandPrefix`, with the
repository-scoped App credential. The refspec is an exact commit SHA to
`refs/heads/infinite/team-*`. The host never forces or deletes a remote branch. The
point is durability: work survives workspace removal and loss of the host disk. See
[Head publication](teams.md#head-publication).

## Request intake

Intake lets the owner start a mission from a Linear issue and follow it in a Slack
thread. See [intake](intake.md) for the flow.

Only the owner causes work, and the rule holds for both the intake service and the
Slack surface:

- Work starts by one of two routes, and each needs the owner. An issue starts a
  mission only when its creator is the owner's Linear user ID,
  `intake.linear.creatorId`. When a Slack thread is required, the thread must also
  hold a message from the owner's Slack user ID, `intake.slack.ownerUserId`, that
  mentions Linear's agent and was sent before the issue was filed. A direct
  request, with `intake.slack.directRequests` on, starts from the owner's
  mention of the bot in the configured workspace. In a configured request
  channel, the owner's ordinary top-level message or explicit instruction to
  take on a proposal can start the same flow. With `intake.linear.admitIssues`
  false, the first route is off.
- Only the configured owner's messages can answer, steer, or control a
  mission. With `intake.slack.ownerOnlyInJoinedChannels` enabled, sender
  identity gates every inbound response, including proposal reactions and
  status replies. The policy applies to mentions and ordinary messages in
  all joined public and private channels. With shared proposal channels enabled,
  a teammate can receive a fixed 👀 reaction
  on their proposal and ask for status in a bound thread. The public status
  comes from that thread's records and contains counts and state. The host
  neither stores the teammate's proposal text on arrival nor sends their
  status request to a model. Channel membership grants no mission controls.
- The thread the issue links is read once, at admission. The objective keeps only
  the owner's own messages from it. Messages from anyone else, and bot messages,
  are read at admission to check authorship and are not stored, shown to agents,
  or logged. The Slack surface also reads the bound thread to find its own posts
  after an uncertain send; it stores nothing from that read.
- For a direct request, other people's messages are read, because the owner's
  decision of 2026-11-14 is that they reach agents. The messages in the thread
  through the owner's request are put in the
  mission objective, stored with the mission, and shown to agents. They are not
  logged, not copied into the Linear issue or any comment, and not posted to
  Slack. The host reads the thread when it files the request, and again if
  filing is retried. It keeps messages whose timestamp is at or before the owner's request
  and discards later ones before anything is stored, passed to an agent, shown, or
  logged. A message edited before the read appears with its edited text. The
  tracker receives only the owner's text and the Slack link, and fixed receipts for
  the outcome; agent reports and questions go to the Slack thread. Every line carries its author
  (`owner | `, `other N | `, `bot | `), and line-break characters in a message are
  normalised first, so a forged line inside another person's message keeps that
  person's marker. The markers are a prompt boundary and not a guarantee: agents
  are told that lines marked `other` or `bot` are not instructions.
- A skipped issue's title and description are not stored. Its record keeps the
  issue's IDs, URL, times, and skip reason, and no text from the issue.

The bot posts messages only into the thread a record is bound to. A proposal
reaction targets the original Slack message in a configured request channel.
Everyone who can read that channel can read the questions and results posted
there. Linear comments go only to the issue whose record they
belong to. Neither surface changes a Linear issue's state, assignee, or labels,
and neither approves a provider permission or marks work complete. Results are
labelled as agent reports.

Host paths and addresses do not leave the host through intake. Before any Slack
message or Linear comment is made, a `file://` URL, and a path that starts with a
configured directory, a host root (`/srv/`, `/opt/`, `/run/`, `/etc/`, `/Users/`,
`/home/`, `/tmp/`, `/private/tmp/`, `/private/var/`, `/var/folders/`), `~/`, or a
Windows drive, becomes `[local path omitted]` when it is at the start of the text or
after any character other than a letter, a digit, or one of `. _ ~ % / -`.
Repeated slashes and `./` segments do not hide a path. Then every IPv4 literal
becomes `[address omitted]`, which also hides four-part version numbers.

Slack and Linear credentials are regular files with mode `0600`, outside
`stateDir`, `runDir`, `teams.workspaceDir`, and every project path. The host reads
them for its own requests. They never enter an agent's environment. Loopback HTTP
endpoints are accepted only when `environment` is `"local"`; every other endpoint
must be the official one. Slack uses Socket Mode, so the host has no inbound
public endpoint, and Linear is polled.

Errors are not shared as text. For an unexpected failure, the intake service's
`lastError`, the Slack surface's `lastError`, and every failure a record keeps
carry only the error's name and, when it has one, its code. The message and stack
go to the host log only. Three known failures keep their own fixed text in shared
places: a mission service refusal (`TeamError`), a Slack request failure
(`SlackError`, whose text names only its code), and a Linear request failure
(`LinearFailure`, whose text is fixed).

Residual risk: the objective carries the Linear title and description, and the
owner's Slack messages, to the coordinator and subteams. For a direct request it
also carries the other people's text in the thread, so anyone who can post in a
thread where the owner starts a request can put words in front of agents. Agent reports posted in the
thread may restate thread content, and pull requests the agents open are written by
the agents. Anyone
who can edit the issue before it is admitted can put instructions in its title or
description. The
coordinator is told that only the owner's words are instructions and that anything
read through a connector is information. That is a prompt boundary, not a
guarantee, and it does not stop an injected request from the owner's own account.

### Answers and the route

With `intake.slack.answerQuestions` on, the first host action for an owner's Slack request
can be chosen by a model reading. The bounds:

- The owner's word wins. A mention that starts with `ask:` or `work:` takes that route
  and the reading is never asked.
- Eligibility is fixed when the request is saved. Only a record saved with
  `answerQuestions` on is routed or read by the reading service; a request saved
  before the setting was on stays work, including one whose Linear filing is
  pending, so reconciliation of an issue Linear may already hold is never
  replaced by an answer.
- The default is work. A reading counts as `work` only at confidence 0.6 or higher,
  and a missing, failed, or slow (over six seconds) reading routes to work, which is
  the route that already existed. A reading can send a request to the answer route
  only when it is confident of an answer or unsure.
- The only text sent to the reading service is the owner's own Slack request text, cut to
  1,000 characters, and only with `intake.slack.classify` on. Thread messages, other
  people's text, and bot text are never sent. The call is made in the intake cycle,
  not in the Slack event handler.
- The host never infers completion. An answer exists only because the coordinator
  reported a `result` through its report tool; it is posted in the thread labelled as
  an agent report.

The answer coordinator's read-only limit is its provider tool flags and the
mission's refusal of a dispatch, not a sandbox. It runs as the agent account and can
read every repository of the project group, including files an unrelated question
did not need. Its answer goes only to the Slack thread; the host makes no Linear
request for it, and it opens no branch or pull request because it cannot start a
subteam. Anyone who can post in the thread can put words in front of it, as for a
request, and the prompt boundary is the same: only the owner's words are
instructions.

A wrong route costs differently in each direction. A change request routed to an
answer gets an answer and no change, and its reply says how to ask again (`work:`).
A question routed to work files a Linear issue and starts a mission that may open a
pull request, and its acknowledgement says how to ask instead (`ask:`); the owner can
cancel it. That asymmetry is why an unsure reading goes to the answer route, which changes
nothing, and why an explicit word always wins. With no reading at all the route is
work, because that is the behavior the owner already had.

## Dependency audit

The current lockfile's production host dependency audit reports zero known advisories. The full workspace audit reports 29 findings (19 high, 10 moderate), propagated from four transitive packages in the Expo 57 dependency tree: `braces`, `node-forge`, `uuid`, and `decode-uri-component`. Most are in build tooling; the Router URI decoder also requires review before native release. At the time of the check, the registry's latest `braces` and `node-forge` versions remained affected. A forced audit fix proposed incompatible SDK changes, so it was not applied. These findings remain open; the mobile debug build is not a security-reviewed release.

## Permission agent

The permission agent's authority is the owner's recorded act and nothing else.
Coverage is one entry for each project, written only by an owner client:
`permissions delegate` for the projects that are in the workspace at that
time, or the owner's first onboarding of the project. Group membership, a host
fold and a repository identity that the host reads from a checkout grant
nothing. A revoke, a regrouping by the owner and a changed direction text end
the authority that earlier decisions were made under. A decision that was made
under an ended authority is never applied and never replayed. On a host that
is not ready the agent serves no request.

The host reads a decision's authority again once it holds the session's input
lease, immediately before the first key. Every API write is acknowledged only
after the host has fenced each answer that is already with a session under an
authority that no longer applies, so a revoke, a changed delegation, an
onboarding opt-out, an owner regrouping or removal of a workspace, and an owner
halt cannot be acknowledged while such an answer can still be typed. The fence
is applied once for all writes, not route by route. At the fence the session's
worker drops the host's lease and sends nothing more for that decision. A key that the worker sent before the fence arrived
stays sent. When a fence cannot be confirmed, the reply carries
`deliveryFence: "uncertain"` and the CLI prints a line; the decision log shows
what was delivered.

What can decide:

- A host rule can send a request to the owner or raise it to the strong tier.
  No host rule allows a request.
- The light model can allow a request or refer it. It cannot reject a request
  or name the owner, and it never gets a raised request.
- The strong model runs on a profile from a model family other than the
  requester's, also when a recorded verdict is replayed. With no such profile,
  or with a requester whose family the host cannot establish, the result is a
  reject with `unavailable`.
- A report outside the closed schema is no verdict.

A reviewer turn runs through Claude Code or OpenCode with no tools, no MCP
servers, no hooks and no project settings, in an empty directory. The task
text, the request and the collected source are passed as marked untrusted
evidence. The strong model can ask once for at most eight source paths. The
host collects them read-only with the root, secret-path, symlink and size
limits of the team evidence collector, and an answer is sent only if a second
collection gives the same content. For a session outside a team run the
collector reads only inside the session's own directory and does not search
upward for a repository root.

The requesting agent receives one option key and, for a reject, a notice that
the host builds from the reason code. The model's note goes to the journal for
the owner. The permission agent cannot start work, message another session,
grant a persistent approval, or change the delegation, the policy or its own
configuration: a write to the host's state, run or install directory, its
configuration file, the vault key or a provider launcher is in the
global-or-account-settings class, and so is a workspace trust prompt.

Delivery records an intent before the first key, and a receipt, a refusal or
an uncertain result after it. Before a key is sent, the host checks the
session, the session root, the dialog's identity and evidence, the owner's
authority, and that no person holds input control. An uncertain delivery is
not repeated, also after a restart. A dialog that the host can answer in
neither direction goes to the owner.

The owner's halt stops the permission agent as it stops every other launch.
While a halt covers a request's project, no reviewer turn starts, and a
verdict that was recorded before the halt is not delivered. The halt is read
before each turn of a review and again immediately before the reviewer
process starts, so a halt that is recorded after the light turn holds the
strong turn, and a verdict reached while the halt was recorded is withheld,
also from a headless session. Each project has a halt epoch, kept in
`halt-epochs.sealed`, a file apart from the halt record. Every engage and every
release that covers a project gives its scope a new epoch, written before the
halt record, and the epoch is part of the authority of each decision: a halt
ends the authority that earlier decisions were made under, as a new owner act
does, and so does its release. A verdict reached before or during the halt and
not yet delivered is never delivered, also after the release and after a
restart, and the same request is decided again from current evidence. Neither
a restart, a dropped request receipt, nor a restored or removed halt record
changes the epochs, so a halt that an older copy of the record brings back
retires, at its release, the verdicts reached since the real release. A removed
epochs file is replaced with a new host epoch, which retires every verdict not
yet delivered. While the epochs or the halt record cannot be read, the agent
serves nothing. The same authority carries a digest of the policy text, the
tier texts, the class rules and the tier profiles: the digest that a replay
result belongs to. A change to any of them sets aside every earlier verdict in
the same way, so a verdict reached under older rules is not replayed under
newer ones and no delivery of it starts under them. Two limits apply. An
answer that the host had already handed to a session's worker when the change
took effect may still be typed after it, while the worker's control lease and
its checks of the dialog hold; the restart of the host does not cancel it. A
rollback to exactly the earlier rules and profiles brings their verdicts back,
as it brings back their replay result. The host does not detect a replayed older copy of its sealed
state: restoring `halt-epochs.sealed` from an older copy, alone or together with
`halt.sealed`, can make a verdict reached before a later halt applicable again,
as restoring an older `halt.sealed` lifts a halt. A dialog that was
pending is handed to the agent again after the release and decided from the
evidence of that time. A host halt, or a halt record that the host cannot
read, also holds every reviewer launch of a replay. A headless call that
arrives under a halt is denied with `unavailable`.

A request that waits for the owner because of a class rule or an `owner`
verdict is pushed with the host's class identifier in parentheses, for example
`(production-or-staging)`. The notifier shows only an identifier from the
host's own class list, so no model text appears in a push. A request that the
host cannot answer is pushed without a class: it is a host limit and not an
interrupt class.

Limits that remain:

- A class rule establishes a class only from what the host can read: the
  command's words, its path targets, the tool name, and the lists in
  `packages/host/src/permission-classes.ts`. A deploy command is a host rule
  only when `permissionAgent.releaseCommands` names it or when it controls the
  host's own service. Every other production or staging action depends on the
  raise rules and the strong model's verdict, and so on the measured miss
  rate. Name each workspace's deploy commands in the host configuration.
- A versioned install is identified by a regular `.infinite-release.json` file
  in its install directory. The host protects the directory containing that
  release and uses that stable path in `classRulesDigest`, so sibling releases
  are protected without making each deploy stale the replay result. Without the
  marker, the dynamic install path protects only the install directory itself.
  A marked release directly below `/` also protects only its own directory,
  because the class rules never protect `/`.
- A command whose effect the host cannot read (a script file, a remote shell,
  a command substitution) matches no class rule. It is raised to the strong
  tier. The host reads a literal shell body (`sh -c '...'`) to three layers
  and applies a wrapper's working directory (`env -C`, `sudo -D`, `cd`). A
  deeper body, a body that the outer shell expands, and a directory that the
  text does not establish are raised. A wrapper that the host does not know
  is raised when its words contain a command that a class rule names; that
  search is bounded, and a request past its bounds is raised too. Options
  between a program and its subcommand do not hide the subcommand. Interpreter
  code is not read: code in an option, attached or combined
  (`python3 -c'...'`, `perl -ne`, `node --eval=...`), a program piped into an
  interpreter, and interpreter code behind a wrapper the host does not know are
  raised. The search
  also raises some routine commands, for example a commit message that reads
  as a credential command. Those cost a strong turn and never an owner
  interrupt.
- Paths are resolved through symbolic links when the request is read. A link
  that changes between the review and the command's own execution is not
  seen. A path that the host cannot read is raised. The evidence collector
  checks each directory of a path and then opens the file, so a directory that
  is replaced by a symbolic link between the two steps could make one read
  land outside the root.
- The replay set that ships with the host has twenty synthetic cases. A host
  becomes ready only after the owner runs a replay with at least `minCases`
  labelled cases (default 100).
- These requests are not served and are handled as before: headless Codex and
  OpenCode sessions, a session whose root-owned launcher adds `--print`
  itself, and, for sessions outside team runs, yes-no dialogs and collapsed
  Codex dialogs.
- The permission journal's evidence module is at version 2. An older host
  binary that opens the same database treats the journal as unavailable, so a
  rollback across this release turns the permission agent off until the newer
  binary returns.

### Headless permission channel

A served headless Claude Code session is launched with `--setting-sources ""`
and one settings layer that the host writes. No user, project or local
settings file can then switch its hooks off or answer a call before the
channel. The cost is that the allow rules, environment values, `apiKeyHelper`
and model defaults of those files do not apply to a served session. The launch
profile's own allowlist still applies, and `permissions status` lists each of
its allow rules that a class rule outranks.

The hook reaches the session's worker, and the worker reaches the API through
a socket in the run directory with mode 0600. Each request carries an HMAC of
the session id under the host key. The worker already holds that key, and the
key never enters the agent's environment. A request with another session's
key is refused, and so is a delivery for a decision that was issued to another
session. The agent holds the hook token, so it can call the channel itself:
that can start a review or get its own call denied, and it cannot make a call
run. A team member's session is served only while its run is live. For a run
that is stopped, paused or halted, or whose permissions the owner revoked, its
calls are handled as before the permission agent, by the launch profile's own
allowlist, and an allow is withheld when the run stops being live before it is
returned.

A class call from the primary agent is deferred only when the host records an
owner decision for it: the provider ends its run,
the session waits, and only the owner's answer on that session's prompt
resumes it. The answer applies once, to that call id, and a resumed call whose
input differs is denied. Before an owner's allow is returned to the resumed
call, the worker asks the host again: an owner halt that covers the project,
a changed session root, a team run that is no longer live, a deferral that was
issued no decision, or a decision that no longer applies, including one reached
before or during an owner halt, withholds the allow, and so does a host that cannot be
reached at that moment. A withheld allow is denied with `unavailable`, and the
answer is used all the same. An owner's refusal is returned without that
check. A resume that the host confirmed just before a halt was recorded can
still run its call after the halt is acknowledged; nothing recalls an allow
that has reached the provider's hook. The session's worker holds the answer,
so after an API restart between the answer and the resume the call runs once
if the restarted API confirms it; a host restart that ends the worker loses
the answer, and the call does not run. A class call from a subagent cannot be
deferred. It is denied with `needs-owner`, and the owner gets a notice. So is a
class call for which the host could record no owner decision. A class call
that arrives during an owner halt is denied with `unavailable`, and nothing
waits for the release. While one call
waits, every other call of the session is denied. A call is denied with
`unavailable` when the host cannot be reached. An unanswered call is retired
after 29 days. A session cannot be resumed after its worker ended while a call
waited.

## Delegated team permission decisions

This section describes the earlier repository-level delegation to a run's
coordinator. It applies only to a team run that the permission agent does not
serve.

Delegation is an explicit repository enrollment policy, pinned when a run starts.
Only the run's strong Claude coordinator profile can report a permission decision. The
report channel remains bound to its own assignment; it receives no owner key or
sibling-session control capability. The host applies only a current one-shot
choice after verifying the target assignment, canonical workspace, prompt
identity and evidence, owner policy, expiry and human control lease. It records
intent before delivery and preserves uncertain acknowledgements without replay.
Within the run's configured decision limit, the host can reuse a terminal
reviewer's verdict only when the pinned policy, semantic prompt and option,
task ID, changed paths, and accepted checks match. Prompt, session, and member
IDs are excluded from the reuse key. Reuse also requires the same run revision,
assigned role, working directory, reviewer profile, inspected workspace
evidence, and owner authority (the pinned policy plus the owner's steering and
answers). An owner answer retires every outstanding delegated decision.
Reused approvals still pass every live authorization and prompt check,
including that owner authority, and use the same single-delivery path; reviewer escalations remain with the owner, and host-side escalations
are never reused.

A Codex command dialog ("Would you like to run the following command?") runs its
command once outside the provider sandbox, with network access and local
sockets. It qualifies for review only when the dialog is pinned to the bottom of
the screen, with nothing but blank lines and key hints below its options. It
must also show the complete command in a single `$` command block and offer a single
one-shot option. Agent output scrolls above the provider's input area, so a
printed copy of a dialog never qualifies. The screen hash ignores spacing inside
a line, so the worker also requires the reviewed title and detail exactly, and
the dialog still pinned, before every key it sends. A redraw stops delivery.
Delegated answers go only to menus: on a yes-no line the typed key changes the
line before its Enter, so that Enter could not be checked. A refusal before the
first key escalates the request; a failure after it is recorded as uncertain and
never replayed. The review evidence adds `targetChangedPaths` (capped at 100),
`targetChangedPathCount`, `acceptedChecks`, and bounded complete command-source
files with SHA-256 hashes and explicit collection gaps. Source collection never
executes the requested command, follows symlinks, or reads credential paths.
External scripts are collected only from the member's host-assigned scratch
directory. A prompt naming an arbitrary temporary file does not establish
ownership or authorize reading it.
The host rechecks the changed paths and collected source snapshot before sending
an answer. The coordinator approves routine development operations by default
against the pinned scope and role, including scoped staging, dependency
installation from declared manifests, test planning, scripts, local listeners
and local browser checks. Changed command definitions require inspection rather
than automatic rejection. A reviewer without an implementation task uses its
review assignment and the objective. Missing evidence that leaves the command
itself or its direct target unknown enters bounded evidence recovery before
escalation, as does an uncollected executable file the member changed. The
coordinator can request specific files for a new review; the same paths and
their contents are recollected before an answer. An uncollected unchanged repository
file that the visible command merely tests, builds or runs is reported as a
limitation. Production or staging actions, credentials, other repositories,
global settings, destructive operations outside the workspace, persistent
approvals, and malicious or unrelated commands always escalate. Leaving the
provider sandbox, or needing network, sockets or IPC, does not itself expand
authority or require an owner decision. Source collection maps emitted `.js`
import specifiers to their TypeScript sources so the code a test runs under a
TypeScript loader is in the evidence.

Recovery is not approval. Display expansion is restricted to a recognized pinned
Codex collapsed-command dialog with the current assignment, prompt evidence,
canonical workspace and control lease. It can send only Ctrl+A, with durable
intent and receipt tracking; loss of acknowledgement cannot cause a second
toggle. Unrecognized permission dialogs can be diagnosed by the strong coordinator but
cannot be answered until the existing complete one-shot contract qualifies.
Evidence requests keep the collector's root, secret-path, symlink and size
restrictions. Requests, decisions and consequences are retained as scoped
observations for PM correction and later reviews; historical success never
authorizes another command. A display or answer receipt does not establish
command execution success.

The screen parser takes a Codex dialog's own title ("Would you like to run the
following command?") as the prompt title even when the agent's reason below it
is phrased as a question, and bounds the header at that title so transcript
above it is not part of the dialog. Detail cut at the parser's length cap is
marked "… [+N chars]", which delegation treats as incomplete evidence, so a
dialog whose command runs past the cap never qualifies. Push notifications for a team member's
prompt are held while the run's coordinator can still decide it and sent once
the request is the owner's.

Delivery-role requests may use the separate pinned delivery policy only when
the reviewed head, branch, repository and passing checks match. The host
revalidates delivery authority and the actual clean workspace HEAD before
review and before answering. The coordinator requires literal reviewed commit
SHAs and explicit destinations for Git publication; mutable refs are insufficient. PR-only policy never permits
merge, and ordinary workers cannot publish. No role may obtain persistent
approval, new credentials, global-setting changes or protection bypasses through
this mechanism. A late report from an obsolete reviewer cannot reopen a terminal
decision; failed shutdown of that report-only member stays visible without
blocking a later eligible review.

The permission coordinator runs noninteractively with no built-in tools and only
the authenticated assignment report MCP server. Unexpected tool permissions are
denied. Configurations that add conflicting launch or MCP flags are rejected.
If the configured strong provider is unsupported, the request remains with the owner.

The owner can revoke a run's delegation independently of task steering. Changing
the repository policy does not opt existing runs in. Coordinator prompts never
qualify for recursive approval; workspace trust, persistent allow rules and
unsupported native requests require owner handling. This does not isolate
processes sharing a Unix account or grant permission beyond the accepted task.

## Agent egress boundary

The optional egress proxy narrows where agent sessions on the Ubuntu host can
connect. It is off unless `autonomy.boundary.egress` is configured; without it,
session environments are unchanged. When configured, each new session receives
the six proxy variables and `NODE_USE_ENV_PROXY=1`. The proxy URLs point at a
loopback proxy and carry a credential that names the session's project and
expires. The host reads the shared key;
no session receives it. When the key cannot be read, sessions and host commands
still get the proxy address, without a credential, so their requests are
refused rather than sent direct. The proxy refuses cloud metadata, loopback, private,
shared, link-local, multicast, documentation, and other non-public addresses in
both modes, after resolving the name once and connecting to the checked
address. It records one line per connection with project, host, port, address,
decision, and byte counts, never paths, headers, or credentials. In enforce mode
it also refuses hosts that the owner's policy does not list. An nftables rule
for the agent account logs, or in enforce mode refuses, connections that skip
the proxy, and refuses link-local destinations in both modes. The owner reads
the per-project summary with `infinite egress` (owner role only).

This is attribution and destination control for one shared agent account, not
isolation. The credential lives in the session environment, which every process
of that account can read, so the recorded project says which credential was
used rather than which project acted. The proxy never inspects TLS content: an
allowed host such as a code host or package registry can still carry data out,
as can DNS through the local resolver, and services on loopback remain
reachable. Node's built-in `fetch` and HTTP clients need `NODE_USE_ENV_PROXY=1`
on Node releases that support environment proxies; the host sets this flag when
egress is configured. Other tools that ignore proxy variables go direct, which
observe mode only logs. Installation, rollout, rollback, and the full list of
limits are in the [egress runbook](../deploy/ubuntu/egress.md).
