# ADR-0012: Web Client UI, Transport, Freshness, and Cost Accounting Invariants

- **Status**: Accepted
- **Scope**: `apps/web/src/`

## Context

`apps/web/src/` implements the browser client for sessions, decision queues, halts, permissions logs, cost/usage reporting, teams, goals, missions, and the Swarm canvas (whose core model/graph invariants are also recorded in ADR-0005). Non-obvious behavioral, concurrency, accessibility, and backward-compatibility decisions live here.

## Decisions

### 1. Ephemeral tab state, routing, and session views (`api.ts`, `machines.tsx`, `session-navigation.tsx`, `main.tsx`)
- **Tab-scoped memory only**: `clientId` (`crypto.randomUUID()`) identifies each running browser tab independently of the shared login cookie. Machine profiles, device keys, drafts, request receipts, and cached `sessionViews` never leave process memory (never `localStorage`, `sessionStorage`, or URL hashes).
- **Cached views without authority**: Switching sessions paints `sessionViews` immediately for responsiveness without restoring control authority; `SessionView` catches up from `seq - 200` rather than event `0`.
- **Hash routing disambiguation**: Cost project routes accept any single path segment (host-configured slugs); permission decision IDs live under `/permissions/decisions/:id` so host-assigned IDs can never collide with `/permissions/overview`. The decision log entry sits under the host status panel because it is host-scoped rather than workspace-scoped.
- **Sync status announcements**: `Create` announces `syncNotice` only when the pending reason or applied generation changes, preventing repeated screen-reader announcements as relative timestamps tick.

### 2. Polling freshness, control leases, and halts (`live-refresh.ts`, `session-control.ts`, `main.tsx`, `halt.ts`, `halt-banner.tsx`)
- **Visibility-aware freshness (`useLiveRefresh`)**: Hiding a tab stops timers, drops any stale warning, and cancels in-flight generation checks; returning triggers an immediate poll and restarts the 3,000 ms stale grace timer.
- **Control lease fencing (`useSessionControl`)**: Claim and release transitions increment `generation.current` so older in-flight polls cannot overwrite the new holder; release retries terminate at `control.expiresAt`; foreground return renews or reclaims immediately; hidden tabs release held leases.
- **Mission-managed sessions (`SessionView`)**: Direct steering is locked except while `attention.state === "needs-you"`, any held lease is released once locked, and `PromptDecision` answers require no control lease (managed sessions cannot be claimed). Only `terminal` and `screen` tabs send `force: true` to type directly into an open prompt. A single fixed feedback slot displays delivery errors, control messages, and receipts with precedence over dictation notices.
- **Halts (`halt.ts`, `halt-banner.tsx`, `main.tsx`)**: `haltFeed` retains the last received halt across failed polls so banners never flicker out on transient poll errors. A host halt (readable or unreadable) overrides project halts on every screen while `projects` retains standalone project halts that stay active if the host halt is released. Mission halt scope uses creation-pinned `repoProjectIds` (subtasks do not narrow it). Compact rail banners omit explanatory prose to preserve list density.

### 3. Idempotent requests, dictation, and decision queue (`requests.ts`, `drafts.ts`, `dictation.tsx`, `decision-answer.ts`, `decision-queue-feed.ts`, `decision-queue-model.ts`, `decision-queue.tsx`, `team-decision.tsx`)
- **Idempotent receipts**: `requestStore` and `drafts` retain pending `requestId`s across unmounts; delayed receipts settle only matching `requestId`s so newer drafts or retries are never overwritten.
- **Dictation lock fencing (`dictation.tsx`)**: `useDictation` mirrors `disabled` onto the mic (`disabledRef` is re-checked synchronously before inserting results in case the lock rendered before its effect ran) and increments `generation` on cancel so late cleanup replies are discarded.
- **Decision queue (`useDecisionQueueFeed`, `decision-queue-model.ts`, `DecisionQueueView`, `Decision`)**:
  - `queue` persists across transient failures/in-flight reads, clears on HTTP `404` (host lacks route), and stops counting as `current` once a read is `QUEUE_READ_GRACE_MS` (3,000 ms) overdue (unless the tab is hidden or offline).
  - Answers hide items immediately starting from the first read begun *after* the answer; if still listed by `ANSWERED_RESTORE_READ` (5), the item reappears because the host still waits on it. `activeLeft` tracks decisions removed externally.
  - `decisionChoices` promotes recommended options first except when `answerMode === "approval"` (where index 0 approves and index 1 denies). `DecisionQueueView` uses a two-step select-then-submit flow, updates state labels/disabled flags in place without layout shifts, and re-sends unconfirmed answers with the original `requestId`. When a question has no options, `Decision` renders a single button to apply the already-shown recommendation rather than duplicating its text.

### 4. Cost honesty, permissions marks, and Swarm extensions (`cost.tsx`, `usage.tsx`, `teams.tsx`, `goals.tsx`, `linear.tsx`, `permissions.tsx`, `swarm/`)
- **Money and usage honesty (`cost.tsx`, `usage.tsx`, `api.ts`)**: Mirrors host `formatUsd` (4 decimals below `$0.01`, `"0.00"` only for true zero); figures with unpriced steps or unmeasured runs/members render as lower bounds (`≥` / `+`) or `"—"` rather than `$0`. Provider balances stay `null` (`"—"`) unless populated by the provider's own API. `viewerZone` is sent to the host for day bucketing; account colors (`FIXED_ACCOUNT_COLORS`) are fixed per ID across clients; `parsePlanUsd` accepts a single comma or dot decimal and rejects thousands separators to match host validation; `PlanFee` relies on full-list host responses and `TaskRating` uses idempotent `requestId`s.
- **Backward compatibility and lazy loading (`api.ts`, `teams.tsx`, `goals.tsx`, `linear.tsx`)**: `AccountView.planSource`, `UsageProjectRow.unmeasured`, and `TeamView.workers` are optional for older hosts (`workerStatus` falls back to `parallelism`); `LinearTracking` handles list rows that omit `description`; `CycleAssessment` fetches criteria details lazily when expanded. Blocked runs always sort first in team lists while preserving received order within groups.
- **Permissions marks (`permissions.tsx`)**: Browser sessions signed in via host cookies are not paired owner CLI devices, so `POST /permissions/marks` fails with `403`. The client remembers those machines in `cliOnlyMachines` and presents a copyable `infinite permissions mark` command using POSIX single-quote escaping (`shellWord`).
- **Swarm additions (`apps/web/src/swarm/`)**: `approvalOwner` in `approval.ts` must stay aligned with `apps/mobile`'s team model. `useSwarmContext` retires `404` paths per page load, isolates per-path failures, and restarts only feeds whose target ID set changed. `SwarmView` derives `now` from feed updates (no separate timer) and counts both person-owned prompts and open owner decisions in the `needs-you` vital. `StateMark` pairs distinct shapes with `--sw-*` colors for color-blind accessibility, and `createActivity` tracks page-observed activity strictly in memory.

## Consequences

- Browser session authority, cost honesty, and decision-queue timing contracts are documented centrally without inline comments.
- All 30 remaining files in `apps/web/` carry zero prose comments under `scripts/check-comments.mjs`.
