# Infinite

<!-- impeccable:product-schema 1 -->

## Platform
Web desktop client and React Native mobile client, Android first, iPhone build support.

The native prototype uses a fixed light theme in both OS appearance modes. Phone layouts and enlarged Android text are in scope for this delivery; a native dark palette, tablet-specific layout, and iPhone native runtime verification remain future work.

## Stack
React Native selected by the user. Implementation choice: TypeScript, Node.js worker host, React web client, Expo native client. Ubuntu is the deployment target. AWS was the initial preference; the user subsequently requested a comparison with Hetzner and other providers for 10 or more agents, high bandwidth, and low egress charges.

## Users
An individual running a single-tenant host, or multiple users on the managed service with independent private contexts and execution environments, including the service owner as an ordinary tenant. Each user works from a laptop and checks or steers from a phone or another computer. Flights, sleep, lost Wi-Fi, and laptop shutdown must not terminate cloud work.

## Product Purpose
Create, monitor, and steer Claude Code, Codex, Grok Build, and OpenCode sessions on a selected persistent cloud host or an online laptop from web and phone clients. Devices attach to the same processes and recover their recorded output after a connection outage. Infinite also discovers existing Claude Code and Codex sessions in cmux; CmuxControl remains a separate cmux controller.

## Operating Context
Conversations and tools run on the selected cloud machine. The Mac and the phone are connectors: they attach to cloud sessions, edit prompts locally, and move context into the cloud. A detached laptop service keeps the configured cloud project current with the owner's checkout, one way; a received generation is applied when no session runs in that project and the cloud tree is unchanged, otherwise it stays pending until the owner applies it or a later laptop change arrives when it can apply. Laptop execution with background cloud handoff remains available for Codex as the explicit `--laptop` mode; see [laptop execution mode and recovery](docs/hybrid-execution.md). Nothing in this direction changes `claude`, `codex`, `grok`, or `opencode` run directly on the Mac. See [workspace sync](docs/workspace-sync.md).

Any paired owner device can create a session on a configured machine and project. Controller devices can steer existing sessions; viewers can monitor. Each machine retains its own sessions, credentials, and files. An outbound encrypted relay supports access without an inbound laptop port or a device VPN. A laptop must remain online and awake for sessions running there; remote access does not migrate them to the cloud. See [remote machines](docs/remote-machines.md) for setup, cmux support, and the distinction from hybrid execution.

The target for managed workloads remains confidential VMs: the service operator must not be able to read tenant context. User-owned cloud accounts were offered and not selected. Team collaboration and public discovery remain outside the MVP.

Support both deployment modes. **Single tenant** runs directly on the host with one user's context and no added tenant/VM isolation requirement. **Multi-tenant** assigns each user a separate execution environment and complete context bucket. The operator-confidentiality requirement applies to managed multi-tenant private workloads; the single-tenant owner explicitly controls and trusts their own execution host. Authentication, encrypted recordings, and device roles still apply in either mode.

## Capabilities and Constraints
Preserve native agent histories and workspaces. Show execution location, connection freshness, recording errors, and actual delivery receipts. Shared context must identify its version and source. Do not infer task completion from an idle terminal or automatically approve provider permissions.

In the managed multi-tenant service, tenant contents must be confidential from other users and the service operator. This requires a supported, hardened confidential runtime, independently verified attestation bound to the live client channel, user-controlled keys and update policy, and no operator recovery bypass. Native phone credentials belong in platform secure storage. A compromised agent, trusted client, or selected model provider remains a separate threat boundary.

The current runner is single-tenant. Owner/controller/viewer are roles within that tenant, not separate users' context buckets. A development deployment gives each tenant an entire VM and separate Infinite instance, credentials, disks, homes, networking, and backups. Ordinary VM development is synthetic-only and cannot claim operator confidentiality. The managed contract and implementation limits are in `docs/multi-tenant.md`.

## Open Decisions
The development server lacks confidential VM support. It is suitable for the single-tenant pilot and development/control-plane work; managed confidential execution needs a separate host. The server now runs the single-tenant pilot on Ubuntu 24.04 with private Tailscale HTTPS and LUKS2 application storage. Claude, Codex, Grok, and OpenCode have completed authenticated file edits; Codex also passed an in-flight tool/API-restart continuity check. OpenCode uses the owner's selected Muse Spark Contributor and DeepSeek providers. The confidential execution provider/region/budget, off-host backup destination, native signing identities, and cold-boot recovery remain unfinished. A paired laptop CLI and an owner-key encrypted backup with verified data restoration are now available. See `deploy/ubuntu/commissioning.md` for verified receipts.

The laptop interaction target now requires locally responsive native prompt editing, not just a remote PTY in a local terminal. See [native interaction and continuity](docs/native-continuity.md) for the Herdr and Orca reviews, verified provider connection capabilities, consistent checkpoint requirements, and the distinction between a local interface and actual Mac execution. Cloud execution is the default for every provider as of 2026-10-16; Codex laptop execution with automatic checkpoint handoff is the explicit `--laptop` mode on qualified backends. Empty launches accept their first real input through the persistent terminal. OpenCode also has an experimental local UI adapter and supports empty conversations. Claude/Grok native UI adapters, automatic conflict application, platform-specific dependency provisioning and worker reboot recovery remain unfinished.
