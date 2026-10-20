# Confidentiality boundary

Managed multi-tenant operation requires confidentiality from the service operator. The current implementation does not provide it. The [managed tenant contract](multi-tenant.md) defines the required confidential execution, attestation, client, keys, and recovery design. The development host lacks confidential VM support; it currently runs the owner's single-tenant pilot and cannot host operator-confidential tenants. The [commissioning record](../deploy/ubuntu/commissioning.md) identifies the deployed controls and remaining checks.

An unattended agent's execution environment must read the files, credentials, and model context it uses. On an ordinary VM, the host administrator can potentially access that environment. Disk encryption, a VPN, containers, and application encryption do not solve that boundary. A properly attested confidential runtime can move trust away from the host operator, but still trusts the measured guest software, hardware/attestation chain, and user device. It does not protect plaintext from a compromised agent or guest software already authorized to read it.

## Implemented protection

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
identity. Workspace files remain plaintext runtime data. Provider permissions
remain with the owner unless an explicit repository policy delegates bounded
one-shot requests to the strong coordinator. Guarded delivery checks the current
assignment, workspace, prompt, policy, expiry and human input control. Workspace
trust and persistent allow rules remain outside delegation. An owner who sets
`teams.trustWorkspaces` trusts every team root: members then start trusted in
their own folders and may load repository provider settings that earlier
members edited. Headless OpenCode
rejects unmet permissions instead of providing an interactive approval flow. Profile `dataUse` labels disclose
configured contributor use without changing provider terms or retention. See
[Goals and agent teams](teams.md) for scope, routing, limits, and recovery.

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
and bounded project file operations. `terminal-open`, `terminal-send`,
`terminal-close`, and the `events-*` messages
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

## Required on a real host

Use Tailscale with device approval, restrictive ACLs, and SSH policy. Expose the API through **Serve**, never Funnel. Serve is private to the tailnet; it is a transport layer, not file encryption or runtime isolation. Check with a device outside the tailnet that the host is inaccessible. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

Put source repositories, native agent home directories, native history, caches, temporary files containing project data, and swap on encrypted storage. For Hetzner bare metal, use LUKS2 with a recovery/unlock plan. For AWS, encrypted EBS is a baseline against storage exposure, not against an authorized running guest or an attacker holding the cloud account. Files must be mounted while work runs.

Separate the API service Unix identity from native agent execution identities. The local default profiles intentionally run as the current user; **they are not a sandbox**. The Ubuntu template uses a distinct `infinite-agent` account and constrained sudo launch profiles so an ordinary agent command cannot directly read the API key, device credentials, or worker sockets. Agents sharing that account still share its trust boundary. Use separate users/containers per project if those projects need isolation, and do not mount Docker's host socket.

Authenticate providers on the server in their own protected home, with only the credentials needed for approved projects. An SSH-agent forwarded from the laptop stops being useful when the laptop disappears. Copying the entire laptop home would import excessive credentials and platform-specific paths. Inventory skills, AGENTS.md, MCP services, environment variables, tool versions, Git identity, and project dependencies explicitly.

Repository briefings execute through a root-owned wrapper as `infinite-agent`, using that account's provider authentication (Codex, or Muse Spark and DeepSeek through OpenCode) and read-only source collection. The selected project source and explicitly supplied recorded chat messages are sent to the configured writer's provider; when the account holds a TypeSafe key, changed-line excerpts and claim excerpts are also sent to Jev. Muse Spark 1.3 Contributor is a contributor data-use model; check the provider's terms before routing a project to it. Approve that transmission for each project before enabling automatic briefings. The feature does not discover provider histories or other sessions. The agent account remains a shared single-tenant trust boundary; briefings are unavailable when the runtime cannot resolve a cloud source root, including current hybrid laptop and cmux sessions. See [repository briefings](repository-briefings.md) for deployment and evidence limits.

For unattended GitHub delivery, the optional [GitHub App renewal service](../deploy/ubuntu/github-app.md)
keeps the app private key outside agent-readable storage and issues one-repository
installation tokens. The Git/GitHub client refuses expired or mismatched tokens
for configured repositories. Existing credentials for other repositories remain
separate. Agents sharing a Unix identity can read that identity's token files;
this does not add filesystem isolation or change provider approval controls.

Workspace sync runs only on single-tenant hosts. Owner CLI launches without `--project` start or reuse it for the selected home-relative checkout; an explicit `infinite sync` can also start it. Folder registration accepts only an owner bearer key, persists in sealed host state, and refuses symlink aliases, overlapping projects, and protected host paths. It uploads the entire Git root of the selected checkout, including ignored and untracked files and its `.git` directory. For a linked Git worktree it also uploads Git metadata from outside the root: the common repository's objects, refs, ref logs, packed refs, `info/`, `shallow`, `description`, and a projected config, and the worktree's own `HEAD`, `index`, ref logs, refs, in-progress merge, rebase, cherry-pick, revert, and bisect state, and a projected `config.worktree`. A Git config can carry credentials such as a token in a remote URL. Keep credentials out of synced checkouts or accept that they reach the host. A forced apply replaces the cloud tree; one previous copy is kept beside the project directory. Received chunks are plaintext files under the host's private state directory, so that directory belongs on the encrypted storage above. See [workspace sync](workspace-sync.md).

The owner pilot now has an age-encrypted laptop backup with file, SQLite, and journal restore verification. Its daily server timer creates encrypted snapshots; automatic upload to independent storage is still pending. See [backup operations](../deploy/ubuntu/backups.md).

Use encrypted off-host backups with restore testing. Keep the backup decryption key outside the rented host where feasible, and separate its repository credentials from keys that can delete prior backups. RAID is availability against a drive failure, not a backup. Monitor disk capacity and inode counts; the recording currently has no automatic retention cap.

## Threats that remain

- Compromised guest root or the active agent can read the plaintext accessible to that agent. A compromised API process can read all records it has a key for.
- A stolen paired device key permits that role until it is removed from host configuration and the API is restarted. Browser login cookies expire after 12 hours or API restart in this prototype.
- Agents can leak data through allowed tools, the internet, model API requests, or prompt injection. Provider retention policies are a separate boundary.
- Native terminal recordings are not a complete audit of every filesystem operation or hidden model context. An agent can write a file without printing it.
- Hook tokens are readable by the agent process. Each worker passes `INFINITE_HOOK_URL` and `INFINITE_HOOK_TOKEN` in the agent's environment, so the agent can post forged signals. Signals are evidence about the agent, never authority over it. They are labeled by source, never approve anything, and the screen checks run independently. The answer endpoint only presses keys for a dialog the terminal shows and checks it before and after.
- Codex hooks are off by default. When `attention.hooks.codex` is enabled, they are injected with `--dangerously-bypass-hook-trust`. Unverified until spike S2: the flag applies only to the hooks Infinite injects for that one process, and hooks the person configured keep their own trust requirements. `doctor` prints a line naming the flag when Codex hooks are enabled.
- Push is an optional outbound dependency of the host. Bodies are minimal by default and carry no session content; `push.detail: "full"` is opt-in. Messages go through Expo's push service and can be cached there. The Expo access token lives in a 0600 file outside the state directory. Push can be left disabled.
- Signal payloads can contain commands and file contents. They are journaled encrypted like the rest of the recording and shown only to paired roles.
- Transcript bytes reach the worker only through the authenticated hook relay, which runs as the agent and reads only a regular `.jsonl` file the provider's own hook named. The worker records them as `message` events in the encrypted journal, so chat carries the same plaintext the provider already stores in its home. On the Linux deployment the hook variables must be in sudo's `env_keep`, or hooks and transcripts never leave the agent account.
- Chat summaries send recorded messages to the configured external model (`summaries`). With `jev` configured, the host can also send candidate sentences from an agent's last message and the clipped first line of a long default-titled prompt to TypeSafe; the summary writer's provider receives that prompt only when Jev finds its clipped first line unclear. A team run's long untitled request is handled the same way, except that local paths and file URLs are removed before either model sees it and, with no `jev` configured, the request goes to the summary writer directly. Configure `jev` with an absolute `apiKeyFile` to a private 0600 file outside the state directory, and optional `model` (default `jev-latest`) and `baseUrl` (default TypeSafe API URL). The summary writer's key file follows the same private-file rule. Provider retention policies remain separate boundaries. With no `jev` key configured, no TypeSafe calls occur.
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

## Dependency audit

The current lockfile's production host dependency audit reports zero known advisories. The full workspace audit reports 29 findings (19 high, 10 moderate), propagated from four transitive packages in the Expo 57 dependency tree: `braces`, `node-forge`, `uuid`, and `decode-uri-component`. Most are in build tooling; the Router URI decoder also requires review before native release. At the time of the check, the registry's latest `braces` and `node-forge` versions remained affected. A forced audit fix proposed incompatible SDK changes, so it was not applied. These findings remain open; the mobile debug build is not a security-reviewed release.

## Delegated team permission decisions

Delegation is an explicit repository enrollment policy, pinned when a run starts.
Only the run's strong Claude coordinator profile can report a permission decision. The
report channel remains bound to its own assignment; it receives no owner key or
sibling-session control capability. The host applies only a current one-shot
choice after verifying the target assignment, canonical workspace, prompt
identity and evidence, owner policy, expiry and human control lease. It records
intent before delivery and preserves uncertain acknowledgements without replay.

A Codex command dialog ("Would you like to run the following command?") runs its
command once outside the provider sandbox, with network access and local
sockets. It qualifies for review only when the dialog is pinned to the bottom of
the screen, with nothing but blank lines and key hints below its options. It
must also show the complete command on a single `$` line and offer a single
one-shot option. Agent output scrolls above the provider's input area, so a
printed copy of a dialog never qualifies. The screen hash ignores spacing inside
a line, so the worker also requires the reviewed title and detail exactly, and
the dialog still pinned, before every key it sends. A redraw stops delivery.
Delegated answers go only to menus: on a yes-no line the typed key changes the
line before its Enter, so that Enter could not be checked. A refusal before the
first key escalates the request; a failure after it is recorded as uncertain and
never replayed. The review evidence adds `targetChangedPaths` (capped at 100),
`targetChangedPathCount` and `acceptedChecks`. The coordinator may recommend
approve-once only for a run of the task's tests or an accepted check in the
target workspace with no install, download, publish, deploy, credential or
global-setting effect. It escalates when a changed path defines what the command
runs (package manifests or scripts, lockfiles, Makefiles, test, build or
TypeScript configuration, scripts directories), when the path list is truncated,
and when any evidence is missing or unclear.

The permission coordinator runs noninteractively with no built-in tools and only
the authenticated assignment report MCP server. Unexpected tool permissions are
denied. Configurations that add conflicting launch or MCP flags are rejected.
If the configured strong provider is unsupported, the request remains with the owner.

The owner can revoke a run's delegation independently of task steering. Changing
the repository policy does not opt existing runs in. Coordinator prompts never
qualify for recursive approval; workspace trust, persistent allow rules and
unsupported native requests require owner handling. This does not isolate
processes sharing a Unix account or grant permission beyond the accepted task.
