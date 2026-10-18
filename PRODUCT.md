# Infinite

<!-- impeccable:product-schema 1 -->

## Platform
Web client, React Native phone client (Android first, iPhone build support), and
a personal native macOS client in `apps/macos`. The Mac implementation includes
streamed provider terminals, a local prompt composer, resource/agent monitoring,
file browsing, reviewed folder synchronization, and encrypted server connections.
Its native build, provider UI parity, and physical-device commissioning remain
separate acceptance checks. See [Infinite Desktop](docs/desktop.md).

The phone prototype uses a fixed light theme in both OS appearance modes. Phone layouts and enlarged Android text are in scope for that client; a native dark palette, tablet-specific layout, and iPhone native runtime verification remain future work.

## Stack
React Native selected by the user for the phone. Implementation: TypeScript,
Node.js worker host, React web client, Expo phone client, and SwiftUI/CryptoKit Mac
client with an embedded terminal renderer and optional native cmux SDK/helper.
Ubuntu is the deployment target. AWS was the initial preference; the user
subsequently requested a comparison with Hetzner and other providers for 10 or
more agents, high bandwidth, and low egress charges.

## Users
An individual running a single-tenant host, or multiple users on the managed service with independent private contexts and execution environments, including the service owner as an ordinary tenant. Each user works from a laptop and checks or steers from a phone or another computer. Flights, sleep, lost Wi-Fi, and laptop shutdown must not terminate cloud work.

## Product Purpose
Create, monitor, and steer Claude Code, Codex, Grok Build, and OpenCode sessions on a selected persistent cloud host or an online laptop from web and phone clients. Devices attach to the same processes and recover their recorded output after a connection outage. Infinite also discovers existing Claude Code and Codex sessions in cmux; CmuxControl remains a separate cmux controller.

## Operating Context
Conversations and tools run on the selected cloud machine. The Mac and the phone are connectors: they attach to cloud sessions, edit prompts locally, and move context into the cloud. A native CLI launch maps the checkout's path below the laptop home to the same path below the server home and keeps its launch subdirectory. An explicit `--project` selects an existing cloud project. A detached laptop service keeps the mapped cloud project current with the owner's checkout, one way; a received generation is applied when no session runs in that project and the cloud tree is unchanged, otherwise it stays pending until the owner applies it or a later laptop change arrives when it can apply. Laptop execution with background cloud handoff remains available for Codex as the explicit `--laptop` mode; see [laptop execution mode and recovery](docs/hybrid-execution.md). Nothing in this direction changes `claude`, `codex`, `grok`, or `opencode` run directly on the Mac. See [workspace sync](docs/workspace-sync.md).

Any paired owner device can create a session on a configured machine and project. Controller devices can steer existing sessions; viewers can monitor. Each machine retains its own sessions, credentials, and files. An outbound encrypted relay supports access without an inbound laptop port or a device VPN. A laptop must remain online and awake for sessions running there; remote access does not migrate them to the cloud. See [remote machines](docs/remote-machines.md) for setup, cmux support, and the distinction from hybrid execution.

The target for managed workloads remains confidential VMs: the service operator must not be able to read tenant context. User-owned cloud accounts were offered and not selected. Team collaboration and public discovery remain outside the MVP.

Support both deployment modes. **Single tenant** runs directly on the host with one user's context and no added tenant/VM isolation requirement. **Multi-tenant** assigns each user a separate execution environment and complete context bucket. The operator-confidentiality requirement applies to managed multi-tenant private workloads; the single-tenant owner explicitly controls and trusts their own execution host. Authentication, encrypted recordings, and device roles still apply in either mode.

## Capabilities and Constraints
Goals accept a desired product outcome, success criteria, evidence, allowed
paths, and execution limits. A strong coordinator selects scoped improvements;
light workers investigate and implement in parallel, with explicit escalation
to configured strong profiles. A cycle that produces reviewed changes has a
short brief, host check results, and an independent review. Later cycles continue from a reviewed local commit.
Teams remain available for a single feature request or PRD.

Owners can start, pause, resume, and cancel goals; owners and controllers can
steer and answer questions. Only an explicit user assessment with evidence can
record a product outcome as achieved. Checked code is ready for human review,
or for automatic PR merge when the owner configured a repository delivery policy.
Deployment requires its own existing authorization. See [Goals and agent teams](docs/teams.md)
for the web flow, model routing, scope, limits, API, and recovery.

Projects can map Goals and feature cycles to Linear issues. The host checks
issue scope and workflow state before starting more work; unavailable or changed
issues block progression. Linear workflow state is shown separately from local
execution, and Infinite does not mark an issue Done automatically.

Preserve native agent histories and workspaces. Show execution location, connection freshness, recording errors, and actual delivery receipts. Shared context must identify its version and source. Do not infer task completion from an idle terminal. Do not automatically approve provider permissions, except for a team member in its assigned workspace: the host accepts that folder and ordinary tool prompts, and the coordinator model decides dangerous prompts. Product questions still wait for an owner or controller.

Bind context to the selected project and codebase. Do not infer sharing from a parent directory, Linear mapping, provider account, or similar repository name. Cross-project context requires an explicit owner-created relationship with a named source and purpose. Relationships are directional and do not propagate through further links. Revocation stops future retrieval; context already delivered to a conversation remains part of its history.

In the managed multi-tenant service, tenant contents must be confidential from other users and the service operator. This requires a supported, hardened confidential runtime, independently verified attestation bound to the live client channel, user-controlled keys and update policy, and no operator recovery bypass. Native phone credentials belong in platform secure storage. A compromised agent, trusted client, or selected model provider remains a separate threat boundary.

The current runner is single-tenant. Owner/controller/viewer are roles within that tenant, not separate users' context buckets. A development deployment gives each tenant an entire VM and separate Infinite instance, credentials, disks, homes, networking, and backups. Ordinary VM development is synthetic-only and cannot claim operator confidentiality. The managed contract and implementation limits are in `docs/multi-tenant.md`.

## Open Decisions
The development server lacks confidential VM support. It is suitable for the single-tenant pilot and development/control-plane work; managed confidential execution needs a separate host. The server now runs the single-tenant pilot on Ubuntu 24.04 with private Tailscale HTTPS and LUKS2 application storage. Claude, Codex, Grok, and OpenCode have completed authenticated file edits; Codex also passed an in-flight tool/API-restart continuity check. OpenCode uses the owner's selected Muse Spark Contributor and DeepSeek providers. The confidential execution provider/region/budget, off-host backup destination, native signing identities, and cold-boot recovery remain unfinished. A paired laptop CLI and an owner-key encrypted backup with verified data restoration are now available. See `deploy/ubuntu/commissioning.md` for verified receipts.

The Mac interaction target uses a native local prompt composer: editing does not
wait for the network; Enter submits the complete prompt and Shift-Enter inserts a
newline. The actual provider terminal remains available, with direct keys and
provider output subject to network latency. This is the selected local drafting
approach; a locally running provider editor and complete provider-specific UI
parity remain separate capabilities. See [Infinite Desktop](docs/desktop.md) and
[native interaction and continuity](docs/native-continuity.md) for native provider
adapters and checkpoint requirements. Cloud execution is the default for every
provider as of 2026-10-16; Codex laptop execution with automatic checkpoint
handoff is the explicit `--laptop` mode on qualified backends. Empty launches
accept their first real input through the persistent terminal. OpenCode also has
an experimental local UI adapter and supports empty conversations. Claude/Grok
native UI adapters, automatic conflict application, platform-specific dependency
provisioning and worker reboot recovery remain unfinished.

### Autonomous delivery

An owner may configure a GitHub repository and base branch for automatic merge.
A separate strong delivery agent may publish and merge the exact integration
commit only after required checks and independent strong review pass. Repository
protections and provider permissions remain in force. Repairs return through
integration, checks, and review; uncertain publication is preserved for remote
reconciliation instead of blindly repeated. The host labels a merge as an agent
report and records the PR, reviewed head, and reported merge commit. A reported
merge does not establish a product goal's outcome.
