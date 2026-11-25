# Architecture Decision Records

Non-obvious architectural, protocol, security, concurrency, and compatibility decisions migrated out of inline code comments live here. New and cleaned source files carry zero prose comments under `npm run check:comments` (`scripts/check-comments.mjs`).

| ADR | Title | Scope | Status |
| --- | --- | --- | --- |
| [0001](0001-attention-prompt-lifecycle-and-screen-authority.md) | Attention Prompt Lifecycle, Screen Authority, and Delegation Evidence | `packages/attention/` | Accepted |
| [0002](0002-remote-encrypted-channel-and-sync-contracts.md) | Remote Encrypted Channel, Wire Contracts, and Data-Only Rendering | `packages/remote/` | Accepted |
| [0003](0003-comment-policy-and-ratchet.md) | Zero-Comment Policy with Downward Ratchet | Repository-wide | Accepted |
| [0004](0004-macos-swift-concurrency-and-transport.md) | macOS Client Concurrency, Transport, and Sealed Storage | `apps/macos/` | Accepted |
| [0005](0005-mobile-freshness-and-web-swarm-invariants.md) | Mobile Freshness Hooks and Web Swarm View Contracts | `apps/mobile/`, `apps/web/` | Accepted |
| [0006](0006-host-concurrency-and-lock-free-storage.md) | Host Lock-Free Storage, Pipeline Concurrency, and Partitioned Coordination | `packages/host/` | Accepted |
| [0007](0007-host-state-machines-and-fail-closed-boundaries.md) | Host State Machines, Fail-Closed Halts, Eval Isolation, and Transport Boundaries | `packages/host/` | Accepted |
| [0008](0008-wave2-domain-and-service-state-machines.md) | Wave 2A Domain, Background Service, and Session Control State Machines | `packages/host/`, `apps/mobile/`, `apps/web/` | Accepted |
| [0010](0010-egress-and-github-proxy-security.md) | Egress Proxy Isolation and GitHub Credential Proxy Security | `scripts/` | Accepted |
| [0011](0011-build-watch-graph-and-test-tooling.md) | Build, Native Workspace Watch, Code Graph, and Verification Tooling | `scripts/`, `.agents/skills/` | Accepted |
| [0012](0012-web-client-ui-and-transport-invariants.md) | Web Client UI, Transport, Freshness, and Cost Accounting Invariants | `apps/web/` | Accepted |
| [0013](0013-ubuntu-deployment-and-isolation.md) | Ubuntu Host Deployment, Service Isolation, and Encrypted Backups | `deploy/ubuntu/` | Accepted |
| [0014](0014-mobile-client-invariants.md) | Mobile Client Invariants, Lifecycle, and Honesty Boundaries | `apps/mobile/` | Accepted |
| [0016](0016-wave3-per-entity-orchestration-queues.md) | Per-Entity Orchestration Queues and Orchestration Service Invariants | `packages/host/` | Accepted |
| [0017](0017-host-eval-evidence-outcome-routing-invariants.md) | Host Eval, Evidence, Objective, Outcome, and Routing Invariants | `packages/host/` | Accepted |
| [0018](0018-test-harness-and-verification-invariants.md) | Test Harness, Simulator, and Verification Invariants | `tests/` | Accepted |
