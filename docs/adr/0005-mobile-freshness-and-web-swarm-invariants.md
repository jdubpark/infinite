# ADR-0005: Mobile Freshness Hooks and Web Swarm View Contracts

- **Status**: Accepted
- **Scope**: `apps/mobile/src/api/`, `apps/web/src/swarm/`

## Context

The mobile data hooks (`useLive`, `usePoll`) previously tracked `data`, `online`, `stale`, `loading`, and `refreshing` as independent React state slots alongside multiple nullable stream/timer refs, permitting illegal states such as `online && stale`. Similarly, the web Swarm view types (`Unit`, `Swarm`) allowed simultaneous `live: true` and `terminal` states or mismatched `kind`/fields.

## Decisions

### 1. Mobile live/poll freshness and focus recovery (`apps/mobile/src/api/`)
- `Freshness<T>` (`loading` | `online` | `offline`) makes `online && stale` unrepresentable at compile time; `useLive` encodes `SharedStream` phase as `idle` | `opening` | `live` | `restarting`, and `usePoll` encodes poll scheduling as `idle` | `polling`.
- Regaining screen focus behaves like returning from background: the view retains its last received data until a read or stream succeeds.
- `usePoll` keeps `online` across brief switches when the last success is within `intervalMs`, marks the view `stale` after 3,000 ms in the foreground without a successful poll (even if an earlier success was recent), and preserves the last value across `deps` changes.
- Both hooks keep `// eslint-disable-next-line react-hooks/exhaustive-deps` because callers own `deps` while callbacks (`load`, `select`, `fn`) are read through refs to avoid restarting live streams or timers on every render.

### 2. Web Swarm model honesty, accounting, and layout stability (`apps/web/src/swarm/`)
- **Typed states**: `Unit` is a discriminated union (`LiveUnit | QuietUnit`) on `live`, forbidding `terminal` on live units and making `hold` vs `terminal` mutually exclusive on quiet units. `Swarm` is a discriminated union (`MissionSwarm | TeamSwarm | SoloSwarm`) on `kind`.
- **Honesty**: Terminal states (`review-ready`, `merge-reported`, `no-change`, `cancelled`) and the `reported` agent state reflect agent/host reports, never host verification of merge or completion; UI copy renders `reported` explicitly as `"reported (agent report)"`.
- **Cost accounting**: `unmeasured` / `unmeasuredMembers` counts agents without provider usage telemetry; `costUsd` sums measured usage only and never treats unmeasured agents as `$0`.
- **Ordering and layout stability**:
  - `AGENT_STATES` prioritizes attention-seeking states (`needs-you`, `in-review`), while swarm row ordering depends solely on kind, creation time, and ID so rows never jump when an agent requests input.
  - Graph node positions (`graph-layout.ts`) depend strictly on node presence and model order—never on agent state or link weight—so state-only polls do not shift coordinates. Missions without live units still allocate a row for their hub/coordinator; multi-kind touch links (`planned`, `read`, `edit`, `integrated`) offset onto parallel strands; coordinator-to-mission `member` edges omit spokes because the coordinator sits beside the hub.
- **Quiet runs and headers**: Non-live units are counted individually (not collapsed per mission), bounded to a 72-hour window (`QUIET_WINDOW_MS`) and cap of 12 (`QUIET_LIMIT`); finished/blocked units inside a live mission remain inline as collapsed `QuietRow`s. Standalone team headers omit duplicate cost (shown on the single `LaneRow`) and lead the unit label with `projectId`.
- **Graph polling and observability**: `Graph.tsx` tolerates hosts predating `/graph/map` and `/context` (`contextAvailable = false`), paints SVG layers back-to-front (`code`, structure, touch strands), and treats mission hubs as non-interactive `role="img"` labels beside the selectable coordinator mark. `graph-model.ts` rotates context polls in batches of `SESSION_BATCH = 12` to prevent starvation, distinguishes `codeGraph: "none"` from `"off"`, and marks an agent `unobserved` unless both `agent.observable` and `observed?.observable === true`.

## Consequences

- `online && stale`, simultaneous stream lifecycle phases, and `live: true` + `terminal` Swarm units are rejected at compile time.
- Prose comments in `useLive.ts`, `usePoll.ts`, and `apps/web/src/swarm/**` are removed under `scripts/check-comments.mjs`.
