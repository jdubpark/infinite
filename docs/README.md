# Infinite Documentation and Research Index

This index maps every subsystem, Architecture Decision Record (ADR), runbook, and source file in the current Infinite repository, for both engineers onboarding onto the codebase and AI coding agents gathering task context.

Source files carry zero prose comments (`npm run check:comments`, [ADR-0003](adr/0003-comment-policy-and-ratchet.md)). Non-obvious design invariants live in `docs/adr/0001`–`0022` and this `docs/` tree rather than inline comments. Check the relevant ADR before refactoring concurrency, wire schemas, or security checks.

---

## Cohesive Architecture Graphics

All six diagrams share Infinite's `DESIGN.md` visual vocabulary and distinguish live-wired components, fail-closed boundaries, advisory outputs, and unwired/spec-only foundations:

| Figure | Diagram | Best used when researching |
| --- | --- | --- |
| **FIG 01** | [System Topology](diagrams/system-topology.svg) | End-to-end overview: 4 clients, transport, host planes, detached workers, encrypted storage |
| **FIG 02** | [Orchestration Hierarchy & Team Pipeline](diagrams/orchestration-hierarchy.svg) | Two execution paths—`Intake/MCP -> Mission -> Subtask TeamRuns` and `Routine -> Goal -> TeamRun Cycles -> Session`—plus `KeyedQueue` lock order, 14 states, 10 roles, Blackboard |
| **FIG 03** | [Evidence Store, Routing & Self-Improvement](diagrams/self-improvement-loop.svg) | `evidence.sqlite3` (15 modules, 4 projectors), Thompson routing, Verdicts, Replay Eval, Judge Calibration, unwired boundaries |
| **FIG 04** | [Security & Hard Isolation Boundaries](diagrams/security-boundaries.svg) | 7 Ubuntu service accounts, 3 `nftables` tables, egress & GitHub proxies, ceilings, backups, org isolation, deployment modes |
| **FIG 05** | [Session Protocol & Permission Pipeline](diagrams/session-protocol-and-permissions.svg) | Worker serialized queue (5-step delivery receipt protocol + `resize`), `@infinite/attention`, Halt -> Fuse -> 5-step `HostPermissionPipeline` |
| **FIG 06** | [Understanding & Four-Client Matrix](diagrams/understanding-and-clients.svg) | Graphify code maps, Jevcode briefings, Understanding fence, BFS/TLA+ checker, Usage, Memory, and CLI/Web/Mobile/macOS parity |

---

## Reading Paths by Goal

1. **Understand the full system fast (10 minutes):** [README.md](../README.md) -> [System Architecture](architecture.md) (scan the 6 diagrams and section summaries).
2. **Trace how a terminal session stays alive and handles prompts:** [System Architecture §2](architecture.md#session-runtime-transport-and-continuity-protocol) -> [CLI contract](cli.md) -> [ADR-0001](adr/0001-attention-prompt-lifecycle-and-screen-authority.md) -> [ADR-0002](adr/0002-remote-encrypted-channel-and-sync-contracts.md).
3. **Trace autonomous multi-agent work (Teams, Goals, Missions, Routines, Intake):** [System Architecture §3](architecture.md#orchestration-stack-and-state-machines) -> [Missions](missions.md) -> [Intake](intake.md) -> [Teams & Goals](teams.md) -> [ADR-0016](adr/0016-wave3-per-entity-orchestration-queues.md) -> [ADR-0019](adr/0019-orchestration-wire-and-domain-type-invariants.md).
4. **Audit permissions, halts, proxies, and Linux isolation:** [System Architecture §4 & §9](architecture.md#fail-closed-governance-halt-fuse-and-host-permission-agent) -> [Security](security.md) -> [Ubuntu runbook](../deploy/ubuntu/README.md) -> [ADR-0007](adr/0007-host-state-machines-and-fail-closed-boundaries.md) -> [ADR-0010](adr/0010-egress-and-github-proxy-security.md) -> [ADR-0013](adr/0013-ubuntu-deployment-and-isolation.md).
5. **Research evaluation, adaptive routing, verdicts, and telemetry:** [System Architecture §5](architecture.md#evidence-store-self-improvement-and-evaluation) -> [ADR-0017](adr/0017-host-eval-evidence-outcome-routing-invariants.md) -> [ADR-0020](adr/0020-host-orchestration-permissions-judges-invariants.md) -> [Agent Runtimes Research](research/agent-runtimes/README.md).
6. **Work on Web, Mobile, or macOS clients:** [System Architecture §7](architecture.md#client-surfaces-and-transport-matrix) -> [DESIGN.md](../DESIGN.md) -> [Swarm view](swarm.md) / [Desktop](desktop.md) / [Remote machines](remote-machines.md) -> [ADR-0004](adr/0004-macos-swift-concurrency-and-transport.md), [ADR-0005](adr/0005-mobile-freshness-and-web-swarm-invariants.md), [ADR-0012](adr/0012-web-client-ui-and-transport-invariants.md), [ADR-0014](adr/0014-mobile-client-invariants.md), [ADR-0015](adr/0015-macos-state-machines-and-invariants.md).

---

## Where to Look in Code (Agent & Engineer Lookup Table)

| Question / Subsystem | Primary Source Files | Governing ADR(s) | Doc Section |
| --- | --- | --- | --- |
| HTTP API, cookies, roles, middleware order | `packages/host/src/server.ts`, `permission-write-fence.ts`, `live.ts` | [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [architecture.md](architecture.md#api-surface-index) |
| Detached PTY worker, IPC, 30s control lease, resize refusals | `packages/host/src/{worker,manager,ipc,terminal-stream,terminal-snapshot,terminal-size,pty-tail}.ts` | [0009](adr/0009-wave2-lockfree-services-and-swift-actors.md), [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [architecture.md](architecture.md#session-runtime-transport-and-continuity-protocol) |
| Attention reducer, prompt parsing, verified answers | `packages/attention/src/{attention,prompts,delegation,destructive,claude,codex,screen-activity}.ts`, `packages/host/src/hooks.ts` | [0001](adr/0001-attention-prompt-lifecycle-and-screen-authority.md) | [architecture.md](architecture.md#signals-attention-and-verified-answers) |
| AES-GCM vault & 256-record segmented journals | `packages/host/src/vault.ts`, `storage.ts` | [0006](adr/0006-host-concurrency-and-lock-free-storage.md), [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [security.md](security.md) |
| E2E encrypted channel (`infinite-remote-v1`) & relay | `packages/remote/src/{protocol,index,session-list}.ts`, `packages/host/src/{remote-access,relay}.ts`, `apps/macos/Sources/InfiniteCore/RemoteCipher.swift` | [0002](adr/0002-remote-encrypted-channel-and-sync-contracts.md), [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [remote-machines.md](remote-machines.md) |
| Laptop CLI, `Ctrl+E` drafts, `--laptop` & `--local-ui` | `packages/host/src/{cli,client,client-entry,client-transport,client-native,client-opencode,client-draft,client-draft-store,hybrid-workspace,executor-tunnel,native-bridge,native-codex,native-http,native-transport,codex-environment,codex-environment-store,codex-environment-fence,deadline}.ts` | [0006](adr/0006-host-concurrency-and-lock-free-storage.md), [0011](adr/0011-build-watch-graph-and-test-tooling.md) | [cli.md](cli.md), [hybrid-execution.md](hybrid-execution.md) |
| Workspace sync, shared blob pool GC & GitHub bare mirrors | `packages/host/src/{sync-service,project-sync,project-source,source-upload-receipt,workspace-checkpoint,workspace-transfer,workspace-watch,workspace-pool-gc,workspace-pool-leases,workspace-pool-scopes}.ts`, `scripts/native/workspace-watch.c` | [0006](adr/0006-host-concurrency-and-lock-free-storage.md), [0011](adr/0011-build-watch-graph-and-test-tooling.md) | [workspace-sync.md](workspace-sync.md) |
| Projects over Checkouts & Project Contexts | `packages/host/src/{checkout-identity,project-groups,project-context,repo-enrollment}.ts` | [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [missions.md](missions.md) |
| `KeyedQueue`, `PendingCreates`, acyclic lock ordering | `packages/host/src/keyed-queue.ts`, `teams.ts`, `goals.ts`, `missions.ts`, `routines.ts`, `manager.ts` | [0006](adr/0006-host-concurrency-and-lock-free-storage.md), [0009](adr/0009-wave2-lockfree-services-and-swift-actors.md), [0016](adr/0016-wave3-per-entity-orchestration-queues.md) | [architecture.md](architecture.md#concurrency-storage-and-type-safety) |
| Team runs, planning, worktrees, command fencing, recovery | `packages/host/src/{teams,team-kernel,team-types,team-state-schemas,team-planning,team-prompts,team-prompt-sections,team-workspace,team-command-fence,team-leftover,group-supervisor,process-census,team-publisher,team-recovery,team-retention,team-retirement,team-acceptance,team-watch-board,team-wait-reasons,stall-recovery,worker-screen-activity,delivery-review}.ts` | [0016](adr/0016-wave3-per-entity-orchestration-queues.md), [0019](adr/0019-orchestration-wire-and-domain-type-invariants.md), [0020](adr/0020-host-orchestration-permissions-judges-invariants.md) | [teams.md](teams.md) |
| Goals, standing cycles, Objective Record, Verdicts | `packages/host/src/{goals,goal-types,goal-standing,goal-verdicts,goal-metrics,goal-released-run,goal-waiting-control,objective-*,team-intent,team-register,team-verdicts,verdict-*,evaluator-profiles}.ts` | [0017](adr/0017-host-eval-evidence-outcome-routing-invariants.md), [0019](adr/0019-orchestration-wire-and-domain-type-invariants.md), [0020](adr/0020-host-orchestration-permissions-judges-invariants.md) | [teams.md](teams.md) |
| Missions, read-only coordinator, Board & Attempts | `packages/host/src/{missions,mission-types,mission-progress,mission-read-routes,mission-watch,handoffs}.ts` | [0016](adr/0016-wave3-per-entity-orchestration-queues.md), [0019](adr/0019-orchestration-wire-and-domain-type-invariants.md) | [missions.md](missions.md) |
| Routines (30d authority-pinned schedules) | `packages/host/src/{routines,routine-types,routine-cli}.ts` | [0016](adr/0016-wave3-per-entity-orchestration-queues.md) | [teams.md](teams.md) |
| Linear + Slack intake & mandatory pinned `organizationScope` (`#304`) | `packages/host/src/{intake,intake-types,intake-store,intake-route,intake-audience,intake-linear,intake-slack,slack-client,slack-text,linear}.ts` | [0008](adr/0008-wave2-domain-and-service-state-machines.md), [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [intake.md](intake.md), [instances.md](../deploy/ubuntu/instances.md) |
| External `/mcp` connector & internal `infinite-team` MCP | `packages/host/src/{mcp-server,mcp-requests,mcp-types,team-mcp,team-mcp-results,team-report,team-entry}.ts` | [0019](adr/0019-orchestration-wire-and-domain-type-invariants.md), [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [mcp.md](mcp.md) |
| Halt kill switch & hourly launch fuse | `packages/host/src/halt/{service,rules,record}.ts`, `packages/host/src/fuse/{service,rules,types,baseline}.ts` | [0007](adr/0007-host-state-machines-and-fail-closed-boundaries.md), [0009](adr/0009-wave2-lockfree-services-and-swift-actors.md) | [architecture.md](architecture.md#fail-closed-governance-halt-fuse-and-host-permission-agent) |
| Host Permission Agent, class rules v8, Decision Queue | `packages/host/src/{permission-*,team-permission-*,decision-queue*}.ts`, `packages/host/src/evidence/permission-*.ts` | [0001](adr/0001-attention-prompt-lifecycle-and-screen-authority.md), [0007](adr/0007-host-state-machines-and-fail-closed-boundaries.md), [0020](adr/0020-host-orchestration-permissions-judges-invariants.md) | [security.md](security.md), [teams.md](teams.md) |
| Single-writer encrypted SQLite `EvidenceStore`, Outbox, Blackboard, Signals | `packages/host/src/evidence/{store,crypto,reader,outbox,blackboard,entry-*,secret-scan}.ts`, `packages/host/src/signals/*` | [0017](adr/0017-host-eval-evidence-outcome-routing-invariants.md) | [architecture.md](architecture.md#evidence-store-self-improvement-and-evaluation) |
| Outcome Ledger, BaseScanner & Model Scorecard | `packages/host/src/{config-identity,configuration-store,outcome-*,scorecard,task-features}.ts` | [0017](adr/0017-host-eval-evidence-outcome-routing-invariants.md) | [architecture.md](architecture.md#evidence-store-self-improvement-and-evaluation) |
| Hierarchical Thompson Adaptive Routing | `packages/host/src/routing-*.ts` (15 files) | [0017](adr/0017-host-eval-evidence-outcome-routing-invariants.md) | [architecture.md](architecture.md#adaptive-model-routing-thompson-sampling) |
| Offline Replay Eval, Grader & Blind Judge Calibration | `packages/host/src/{eval-*,judge-*,team-replay,duel-cli,launch}.ts`, `deploy/ubuntu/{eval,grader}-command.sh` | [0007](adr/0007-host-state-machines-and-fail-closed-boundaries.md), [0013](adr/0013-ubuntu-deployment-and-isolation.md), [0017](adr/0017-host-eval-evidence-outcome-routing-invariants.md), [0020](adr/0020-host-orchestration-permissions-judges-invariants.md) | [teams.md](teams.md), [eval.md](../deploy/ubuntu/eval.md), [grader.md](../deploy/ubuntu/grader.md) |
| Understanding, Work Briefs, Repo Briefings & Graphs | `packages/host/src/{understanding*,repository-briefings,repository-graphs,summary,readings}.ts`, `scripts/repository_graph.py` | [0008](adr/0008-wave2-domain-and-service-state-machines.md), [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [repository-briefings.md](repository-briefings.md), [repository-graphs.md](repository-graphs.md) |
| Finite Behavior Verification (BFS & TLA+/TLC export) | `packages/host/src/{behavior-checker,behavior-suite,understanding-behavior}.ts`, `verification/understanding-refresh/` | [0002](adr/0002-remote-encrypted-channel-and-sync-contracts.md) | [behavior-verification.md](behavior-verification.md) |
| Usage, Pricing, Balances, Repair & Interrupted Metrics, Limits | `packages/host/src/{usage*,price-catalog,opencode-usage,transcript-usage,context-gauge,final-drain,team-usage,repair-metrics*,interrupted-task-metrics,balances,provider-limits}.ts` | [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [architecture.md](architecture.md#usage-cost-accounting-and-provider-limits) |
| Canonical Memory & Honcho (Foundation / Unwired) | `packages/host/src/memory/{types,policy,store,recovery}.ts`, `memory/adapters/{ledger,lexical,honcho}.ts`, `deploy/ubuntu/memory/` | [0002](adr/0002-remote-encrypted-channel-and-sync-contracts.md), [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [architecture.md](architecture.md#canonical-memory-foundation-unwired), [memory/README.md](../deploy/ubuntu/memory/README.md) |
| Search Mode & Read Pools (Implemented / Unwired) | `packages/host/src/{search-engine,read-phases,read-request,crossing-digest,context-touches}.ts` | [0021](adr/0021-host-core-runtime-integrations-invariants.md) | [architecture.md](architecture.md#implemented-unwired-and-spec-only-horizons) |
| Egress Proxy, GitHub Proxy & Provider Ceilings | `scripts/{egress-proxy,github-proxy,github-app-client,github-app-refresh}.mjs`, `packages/host/src/{egress,github-grants,ceilings}.ts`, `deploy/ubuntu/{egress/,ceilings/}` | [0010](adr/0010-egress-and-github-proxy-security.md), [0013](adr/0013-ubuntu-deployment-and-isolation.md) | [egress.md](../deploy/ubuntu/egress.md), [github-proxy.md](../deploy/ubuntu/github-proxy.md), [ceilings.md](../deploy/ubuntu/ceilings.md) |
| Web, Mobile, macOS & cmux clients | `apps/web/src/{team-inspector,mission-inspector,swarm}/`, `apps/mobile/src/features/{teams,board,understanding}/`, `apps/macos/Sources/`, `packages/host/src/cmux/` | [0004](adr/0004-macos-swift-concurrency-and-transport.md), [0005](adr/0005-mobile-freshness-and-web-swarm-invariants.md), [0012](adr/0012-web-client-ui-and-transport-invariants.md), [0014](adr/0014-mobile-client-invariants.md), [0015](adr/0015-macos-state-machines-and-invariants.md) | [swarm.md](swarm.md), [desktop.md](desktop.md), [remote-machines.md](remote-machines.md) |
| Build, Ratchets, Simulators and Verification | `scripts/{check-comments,check-file-size,run-tests,render-instance,build-macos,build-codex-handoff}.mjs`, `tests/*sim*.test.ts`, `tsconfig.type-tests.json` | [0003](adr/0003-comment-policy-and-ratchet.md), [0011](adr/0011-build-watch-graph-and-test-tooling.md), [0018](adr/0018-test-harness-and-verification-invariants.md), [0022](adr/0022-css-systemd-and-remaining-tests-invariants.md) | [architecture.md](architecture.md#build-ratchets-and-verification-suite) |

---

## Complete Documentation & Runbook Inventory

### Architecture & Product Guides (`docs/` & Root)

| Document | Focus |
| --- | --- |
| [`README.md`](../README.md) | Front door: system overview, quickstart, honest status matrix, clients, checks |
| [`PRODUCT.md`](../PRODUCT.md) | Product intent, operating context, honesty rules, continuous autonomy & delivery policies |
| [`DESIGN.md`](../DESIGN.md) | "Working Journal" design system tokens, typography, layout, states, mobile/web UI rules |
| [`AGENTS.md`](../AGENTS.md) | Repository rules for coding agents: privacy/redaction rules, check gates, briefings |
| [`docs/architecture.md`](architecture.md) | Master system architecture: all 6 diagrams, runtime protocols, orchestration, governance, eval, storage, API index |
| [`docs/cli.md`](cli.md) | Laptop CLI installation, pairing, command families, `Ctrl+E` drafts, `--laptop`, `--local-ui` |
| [`docs/teams.md`](teams.md) | Deep reference for Teams, Goals, Routines, Blackboard, Objective Record, Verdicts, Eval, Routing, Permissions, Halt/Fuse, Main Check |
| [`docs/missions.md`](missions.md) | Projects over Checkouts, cross-repo Missions, read-only coordinator, Board & Attempts |
| [`docs/swarm.md`](swarm.md) | Read-only Web Swarm visualization (`#/swarm`, Wall, Graph) and Decision Queue (`#/decisions`) |
| [`docs/intake.md`](intake.md) | Linear + Slack Socket Mode intake, `ask:`/`work:` routing, Block Kit controls, mandatory pinned `organizationScope` (`#304`) |
| [`docs/mcp.md`](mcp.md) | External loopback/HTTPS `/mcp` request connector (plus cross-link to internal stdio `infinite-team` MCP) |
| [`docs/desktop.md`](desktop.md) | Native macOS SwiftUI app: build, signing, Keychain, file safety, sync preview, cmux integration |
| [`docs/remote-machines.md`](remote-machines.md) | Multi-machine pairing, encrypted remote channels, blind relay, cmux discovery backend |
| [`docs/workspace-sync.md`](workspace-sync.md) | One-way laptop-to-cloud batched chunk sync (`sync`/`pull`), automatic shared pool GC, staging apply, GitHub source exclusivity |
| [`docs/hybrid-execution.md`](hybrid-execution.md) | Opt-in `--laptop` Codex execution, background cloud checkpointing, 5s reconnect handoff, `recover` |
| [`docs/native-continuity.md`](native-continuity.md) | Provider-native UI adapters (Codex/OpenCode), continuity limits, external runtime comparison |
| [`docs/repository-briefings.md`](repository-briefings.md) | Jevcode host briefings, session summaries, Workspace Understanding & Work Briefs |
| [`docs/repository-graphs.md`](repository-graphs.md) | Graphify repository graph checkpoints, shared/run lanes, bounded directory code maps |
| [`docs/behavior-verification.md`](behavior-verification.md) | Data-only explicit-state BFS safety model checker, TLA+/TLC export, Understanding refresh pilot |
| [`docs/security.md`](security.md) | Threat model, cryptographic vault/transport, proxy boundaries, intake/MCP hygiene, privacy rules |
| [`docs/multi-tenant.md`](multi-tenant.md) | Single-tenant vs Proxmox synthetic dev vs future confidential VM architecture & release gates |
| [`docs/hosting.md`](hosting.md) | Dedicated server sizing comparison, `hostLoad` admission gate, second-instance pointer |
| [`docs/research/agent-runtimes/README.md`](research/agent-runtimes/README.md) | Comparative study of Herdr, Paseo, and Infinite + merged autonomy pilot evidence |

### Operations & Hardening Runbooks (`deploy/`)

| Runbook | Focus |
| --- | --- |
| [`deploy/ubuntu/README.md`](../deploy/ubuntu/README.md) | Base Ubuntu 24.04 commissioning: accounts, ACLs, wrappers, `agent-env.sh`, systemd, Tailscale Serve |
| [`deploy/ubuntu/commissioning.md`](../deploy/ubuntu/commissioning.md) | Verified pilot receipts vs unfinished commissioning items |
| [`deploy/ubuntu/ceilings.md`](../deploy/ubuntu/ceilings.md) | Root-owned `/etc/claude-code/managed-settings.json` & `/etc/codex/requirements.toml` provider ceilings |
| [`deploy/ubuntu/egress.md`](../deploy/ubuntu/egress.md) | `infinite-egress` proxy (`:4785`) and `inet infinite_egress` observe/enforce `nftables` |
| [`deploy/ubuntu/github-app.md`](../deploy/ubuntu/github-app.md) | GitHub App installation & root-owned 5-minute token refresher |
| [`deploy/ubuntu/github-proxy.md`](../deploy/ubuntu/github-proxy.md) | `infinite-github-proxy` (`:8417`), v2 role-scoped grants, `git-receive-pack` & `POST /gh` broker |
| [`deploy/ubuntu/eval.md`](../deploy/ubuntu/eval.md) | `infinite-eval` isolated replay trial account, 9-op launcher, SysV IPC cleanup, `eval.nft` |
| [`deploy/ubuntu/grader.md`](../deploy/ubuntu/grader.md) | `infinite-grader` untrusted test runner account, `prlimit` caps, `grader.nft`, XML/TAP boundary |
| [`deploy/ubuntu/instances.md`](../deploy/ubuntu/instances.md) | Secondary host instances (`render-instance.mjs`), `organizationScope`, 5-minute OS boundary verifier |
| [`deploy/ubuntu/backups.md`](../deploy/ubuntu/backups.md) | Daily `backup.py` with 45s thaw watchdog, `systemctl freeze`, PAX ACL archive, `age` encryption, `verify-backup.py` |
| [`deploy/ubuntu/public-relay.md`](../deploy/ubuntu/public-relay.md) | Blind `infinite-relay` (`:4790`) behind `cloudflared` and Cloudflare Access for VPN-free phones |
| [`deploy/ubuntu/memory/README.md`](../deploy/ubuntu/memory/README.md) | Offline digest-pinned Docker Compose qualification suite for Honcho v3.4.0 |
| [`deploy/proxmox/README.md`](../deploy/proxmox/README.md) | Synthetic-only multi-tenant KVM fleet planning (`plan-fleet`) |

---

## Thematic Map of All 22 ADRs (`docs/adr/`)

See [`docs/adr/README.md`](adr/README.md) for the chronological index. Grouped by architectural concern:

| Theme | ADRs | Governing Invariants |
| --- | --- | --- |
| **Repo Policies & Tooling** | [0003](adr/0003-comment-policy-and-ratchet.md), [0011](adr/0011-build-watch-graph-and-test-tooling.md), [0022](adr/0022-css-systemd-and-remaining-tests-invariants.md) | Zero-comment policy & downward ratchet; Codex handoff build, `kqueue` watcher, Graphify incremental builder, `render-instance`, file-size ratchet; CSS/systemd lexers & hardening |
| **Attention & Wire Protocols** | [0001](adr/0001-attention-prompt-lifecycle-and-screen-authority.md), [0002](adr/0002-remote-encrypted-channel-and-sync-contracts.md) | Screen-owned prompts, single-close journaling, bottom-anchored anti-spoofing, delegation evidence gate; `infinite-remote-v1` E2E WS, `?since=` sync, data-only Markdown/Mermaid/diagram/behavior ASTs |
| **Concurrency & Lock-Free Storage** | [0006](adr/0006-host-concurrency-and-lock-free-storage.md), [0009](adr/0009-wave2-lockfree-services-and-swift-actors.md), [0016](adr/0016-wave3-per-entity-orchestration-queues.md) | Atomic temp+rename storage, per-dir CLI defaults, pipelined chunk upload, fd-pinned non-blocking trust lock, `KeyedQueue` / `PendingCreates` / `mapConcurrent`, acyclic queue ordering, Swift actors |
| **Typed State Machines & Fail-Closed Boundaries** | [0007](adr/0007-host-state-machines-and-fail-closed-boundaries.md), [0008](adr/0008-wave2-domain-and-service-state-machines.md), [0019](adr/0019-orchestration-wire-and-domain-type-invariants.md) | `HaltService`, `WorkspacePhase`, `EvalTaskRow`, `IntakeRecord`, background service `Lifecycle` unions, complete orchestration/worker discriminated unions + Zod schemas, compile-time `@ts-expect-error` pins |
| **Host Domain Subsystems** | [0017](adr/0017-host-eval-evidence-outcome-routing-invariants.md), [0020](adr/0020-host-orchestration-permissions-judges-invariants.md), [0021](adr/0021-host-core-runtime-integrations-invariants.md) | Encrypted SQLite `EvidenceStore` & blind indexes, Outcomes, Objectives, Thompson Routing, Eval/Grader; Permission Agent pipeline, Delivery lineage, Verdicts, Judge calibration; Core runtime, Memory witness recovery, Understanding, Linear/Slack/MCP |
| **Ubuntu Host & Proxy Hardening** | [0010](adr/0010-egress-and-github-proxy-security.md), [0013](adr/0013-ubuntu-deployment-and-isolation.md) | Egress proxy SSRF/DNS/framing checks, GitHub proxy v2 grants & `receive-pack`/`gh` checks; byte-anchored wrappers, `agent-env.sh` deny-list, `eval`/`grader` sandboxing, 45s backup thaw watchdog |
| **Client Apps (macOS, Web, Mobile)** | [0004](adr/0004-macos-swift-concurrency-and-transport.md), [0005](adr/0005-mobile-freshness-and-web-swarm-invariants.md), [0012](adr/0012-web-client-ui-and-transport-invariants.md), [0014](adr/0014-mobile-client-invariants.md), [0015](adr/0015-macos-state-machines-and-invariants.md) | macOS Swift actors, lock-free `CmuxOutputBuffer`, sealed Keychain drafts; Web Swarm honesty & visibility polling; Mobile `Freshness<T>`, encrypted-only WS, single speech recognizer, offline cache |
| **Test and Verification Suites** | [0018](adr/0018-test-harness-and-verification-invariants.md) | 100-byte socket bounds, non-root fixtures, rewritten launcher copies, seeded crash/fault/differential simulators, fail-closed `wire-schema.ts`, prompt SHA-256 byte pins |

---

## Design Specs Shipment Reference (`docs/superpowers/specs/`)

Historical design specifications live under `docs/superpowers/specs/`. Use this table to avoid confusing spec-only concepts with shipped runtime behavior:

- **Shipped & live-wired:** `mobile-attention-brief`, `cloud-first-execution`, `usage-ledger-and-limit-fallback`, `cost-and-agent-effectiveness`, `github-source-tracking`, `projects-over-checkouts`, `system-tab-self-explaining`, `work-briefs`, `workspace-retention`, `team-blackboard`, `member-usage-capture`, `outcome-ledger`, `replay-eval`, `evidence-router`, `continuous-autonomy`, `objective-record`, `linear-slack-intake`, `swarm-dashboard`, `hard-boundary`, `host-permission-agent`, `wake-primitives`, `review-feedback`, `waiting-task`.
- **Partially shipped / foundation only:** `duels` (Phase 1 judge calibration, `source: "duel"` hooks, and host-owned `executionIdentity: "production" | "eval"` separation shipped; live production duels open), `swarm-inspector-and-repair-experiment` (Web/CLI/Mobile team & mission inspectors, spinner-immune stall recovery, and baseline `GET /api/usage/repair-loops` / `infinite usage repairs` metrics shipped; same-implementer repair experiment remains gated on ≥20 baseline loops), `read-pools-and-context-crossings` (`crossing-digest` / `context-touches` live; `read-phases` / `read-request` unwired), `search-mode` (`search-engine.ts` pure state machine built & tested; unwired), `delegated-adoption` (`C19` cross-family merge review live; Class A auto-adoption open), `self-improving-teams` (umbrella; blackboard, usage, outcomes, replay eval, and evidence router shipped; live duels and improvement gate open).
- **Spec-only (no host service yet):** `improvement-gate` (only underlying eval confirm comparisons, `SessionPurpose = "gate"`, and `executionIdentity = "eval"` exist).
