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
Keep Claude Code, Codex, Grok Build, and OpenCode sessions on a persistent cloud execution host. Devices attach to the same processes and recover their recorded output after a connection outage.

## Operating Context
The user selected permanent cloud execution instead of automatic movement between macOS and Linux. New sessions originate from the laptop; secondary devices monitor and steer. The target is now managed confidential VMs: the service operator must not be able to read tenant context. User-owned cloud accounts were offered and not selected. Team collaboration and public discovery remain outside the MVP.

Support both deployment modes. **Single tenant** runs directly on the host with one user's context and no added tenant/VM isolation requirement. **Multi-tenant** assigns each user a separate execution environment and complete context bucket. The operator-confidentiality requirement applies to managed multi-tenant private workloads; the single-tenant owner explicitly controls and trusts their own execution host. Authentication, encrypted recordings, and device roles still apply in either mode.

## Capabilities and Constraints
Preserve native agent histories and workspaces. Show execution location, connection freshness, recording errors, and actual delivery receipts. Shared context must identify its version and source. Do not infer task completion from an idle terminal or automatically approve provider permissions.

In the managed multi-tenant service, tenant contents must be confidential from other users and the service operator. This requires a supported, hardened confidential runtime, independently verified attestation bound to the live client channel, user-controlled keys and update policy, and no operator recovery bypass. Native phone credentials belong in platform secure storage. A compromised agent, trusted client, or selected model provider remains a separate threat boundary.

The current runner is single-tenant. Owner/controller/viewer are roles within that tenant, not separate users' context buckets. A development deployment gives each tenant an entire VM and separate Infinite instance, credentials, disks, homes, networking, and backups. Ordinary VM development is synthetic-only and cannot claim operator confidentiality. The managed contract and implementation limits are in `docs/multi-tenant.md`.

## Open Decisions
The development server lacks confidential VM support. It is suitable for the single-tenant pilot and development/control-plane work; managed confidential execution needs a separate host. The server now runs the single-tenant pilot on Ubuntu 24.04 with private Tailscale HTTPS and LUKS2 application storage. Claude, Codex, Grok, and OpenCode have completed authenticated file edits; Codex also passed an in-flight tool/API-restart continuity check. OpenCode uses the owner's selected Muse Spark Contributor and DeepSeek providers. The confidential execution provider/region/budget, off-host backup destination, native signing identities, and cold-boot recovery remain unfinished. A paired laptop CLI and an owner-key encrypted backup with verified data restoration are now available. See `deploy/ubuntu/commissioning.md` for verified receipts.

The laptop interaction target now requires locally responsive native prompt editing, not just a remote PTY in a local terminal. See [native interaction and continuity](docs/native-continuity.md) for the Herdr and Orca reviews, verified provider connection capabilities, consistent checkpoint requirements, and the distinction between a local interface and actual Mac execution. The current cloud pilot does not yet implement provider-native local UI adapters or automatic Mac/cloud workspace synchronization.
