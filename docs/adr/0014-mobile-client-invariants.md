# ADR-0014: Mobile Client Invariants, Lifecycle, and Honesty Boundaries

- **Status**: Accepted
- **Scope**: `apps/mobile/`

## Context

The Expo/React Native mobile client (`apps/mobile/`) manages encrypted remote channels, multi-tab route state, single-instance native hardware/SDK hooks, input control leases, offline-tolerant polling, and agent/host honesty boundaries across iOS and Android. Many non-obvious invariants previously lived in inline prose comments across `apps/mobile/src/` and `apps/mobile/app.config.ts`. This ADR records those architectural, platform, concurrency, compatibility, and honesty invariants so source files remain comment-free under `scripts/check-comments.mjs` (extending [ADR-0005](0005-mobile-freshness-and-web-swarm-invariants.md) where mobile freshness hooks were already captured).

## Decisions

### 1. Encrypted transport, foreground lifecycle, and state stores
- **Authenticated encrypted channel (`src/api/client.ts`)**: Both direct and relayed connections always use the authenticated encrypted channel; unavailable endpoints never fall back to plaintext HTTP. Only body-less `GET` reads retry once on `"disconnected"` (when `inForeground()`) and drop an idle channel (`saved.calls === 0`) on abort/timeout; mutations never auto-retry.
- **Foreground grace and iOS `AppState` (`src/api/foreground.ts`, `src/api/client.ts`)**: iOS reports `AppState` `"inactive"` for the app switcher, Control Center, Face ID, and call banners; only `"background"` signifies leaving the app. `APP_BACKGROUND_GRACE_MS` (30,000 ms) matches one host control lease window before idle remote channels are closed, and backgrounded disconnects do not auto-reconnect (foreground return polls recover).
- **Live stream fencing (`src/api/liveStatus.ts`)**: Only stream snapshots that replace the current data (`next !== undefined && next !== current`) fence off an in-flight load; reload requests coalesce.
- **Pairings, client identity, and in-memory receipts (`src/store/connection.ts`, `src/store/drafts.ts`, `src/store/requests.ts`)**:
  - `SECRET_KEY` (`infinite.connection.v1`) stays unchanged to migrate legacy single-file app pairings into `infinite.machines.v2`.
  - `clearConnection` publishes removal to subscribers before SecureStore persistence so mounted tabs stop using a removed pairing immediately.
  - `loadClientId` provides the install UUID (`infinite.client.v1`) sent as `X-Infinite-Client` so the host binds the paired key plus client identity to this phone's control lease; SecureStore read/write failures fall back to a process-lifetime UUID.
  - Drafts (`drafts.ts`) and run/creation receipts (`requests.ts`) stay in process memory only so delayed responses settle across unmounts, and `settleDraft` / `complete` only clear the matching `requestId` (and matching text for drafts).
- **Shared multi-tab machine selection (`src/store/machines.ts`)**: All tabs share one active machine. Route `machine` params promote into the store and are cleared via screen-local `useNavigation().setParams` (not global router, which clears params on whichever tab currently has focus). An async generation counter guards promotion against superseding params/unmounts, and `requested` displays immediately until promotion completes so tabs do not flash the prior machine.
- **Routing and build configuration (`app.config.ts`, `src/app/pair.tsx`, `src/app/(tabs)/_layout.tsx`)**:
  - Cloud builds read Android Firebase config from `GOOGLE_SERVICES_JSON` (EAS file variable); local builds read the gitignored `.local/google-services.json`.
  - `src/app/pair.tsx` re-exports `index` so screens inside `(tabs)` reach pairing unambiguously (because `/` also matches `(tabs)/index`).
  - Android edge-to-edge layout requires the tab bar to reserve `insets.bottom` directly.

### 2. Push notifications and speech dictation
- **Push registration and notification routing (`src/push/register.ts`, `src/push/handler.ts`)**: Callers confirm `capabilities.push` before calling `registerForPush` so hosts without push support never trigger a permission prompt; push tokens are never logged. Native token rotation invalidates the Expo token, so `addPushTokenListener` re-fetches `getExpoPushTokenAsync` rather than forwarding raw APNs/FCM payloads. Notifications lacking `machineId` route only when `profiles.length === 1`.
- **Single-recognizer dictation lifecycle (`src/dictation/useDictation.ts`)**:
  - Reads `ExpoSpeechRecognition` directly via `requireOptionalNativeModule` (degrading cleanly to `null` in Expo Go and older builds).
  - One app-wide native recognizer serves every mounted field across stack screens. An abandoned capture keeps ownership via `drain` until the native `end` event arrives (rather than a timer, because native events carry no capture ID); if `start` never ran, `release` runs immediately. Unmount cleanup calls `drain` when an error already nulled `session.current` before native `end`.
  - `useLayoutEffect` syncs `latest` at commit so async cleanup replies and native events never read stale lock state. `CLEANUP_TIMEOUT_MS` (28,000 ms) sits inside the encrypted channel's 30 s timeout while accommodating the host's 25 s model bound.

### 3. Session input control leases, steering, and idempotent retries
- **Shared `SessionControl` store (`src/features/session/useSessionControl.ts`, `Brief.tsx`, `Terminal.tsx`, `TeamApprovals.tsx`)**:
  - Brief and Terminal share one `SessionControl` per `(url, token, sessionId)`. Focus teardown defers `if (this.focused === 0) this.forget(true)` via `setTimeout(..., 0)` so switching between Brief and Terminal does not drop the shared lease.
  - Leases (30 s host TTL) renew every 10 s while focused and foregrounded, pause in background and renew on return (never auto-claiming), and drop via `useControlSync` when `stale` becomes true.
  - A monotonic `revision` fences off polls started before local `claim`, `renew`, or `forget`. If foreground return occurs mid-renewal, `renewOnForeground` retries once in `finally` before dropping the lease.
  - `leaseFor` fails closed on the client when `requiresControl` is true and no local lease is held (because host workers accept lease-less input when uncontested).
- **Mission-managed, team-member, and lifecycle boundaries (`Brief.tsx`, `Terminal.tsx`, `TeamApprovals.tsx`, `Lifecycle.tsx`)**:
  - Mission-managed sessions lock steering and release any held lease unless `attention.state === "needs-you"`. Team member prompts are approved in `TeamDetail` (`AgentApproval` claims a lease only for that answer and releases it via `forget(true)` once `status.kind === "sent"`).
  - `Brief` blocks free-text sends when a prompt is open or `attention.state === "unavailable"`; `Terminal` passes `force: true` to `useSteering` because the user views the screen directly.
  - `Lifecycle` settles ambiguous `DELETE /sessions/:id` failures by probing `GET /sessions/:id` and treating 404 as deleted.
- **Idempotent request retries (`useAnswer.ts`, `useRunRequest.ts`, `GoalCreate.tsx`, `PermissionDecision.tsx`, `useSteering.ts`)**: Worker prompt refusals (`REFUSALS`) and 4xx rejections clear the pending request and refresh; network/5xx/generic-409 failures keep the original `requestId` and recorded payload for retry (ignoring newer form/host setting changes). On both `useAnswer` and `useSteering`, a `ControlRefusal` during a retry keeps `pendingAnswer` / `draft.pending` intact because the first attempt's delivery remains unconfirmed.

### 4. Platform UI, layout, charts, and diagram rendering
- **Edge-to-edge keyboard and touch targets (`src/components/keyboard.ts`, `Button.tsx`, `Glass.tsx`)**: `useKeyboardPadding` applies `keyboardDidShow` height directly because Android edge-to-edge `KeyboardAvoidingView` mismeasures below safe-area top padding. Compact controls reach 48-unit touch targets via `hitSlop`.
- **Composer and dock measurement (`Composer.tsx`, `Brief.tsx`, `Terminal.tsx`)**: `Composer` latches multiline wrapping above `ONE_LINE = 32` and unwraps only below `SHORT_TEXT = 24` to prevent oscillation when switching to full-width layout, keeps drafts editable without control, and keeps `TextInput` in one tree position across row/column layouts so focus is never lost. `Brief` and `Terminal` measure one outer dock container for `FloatingNotice` offset.
- **Pure render timestamps (`Inbox.tsx`, `TeamSummary.tsx`, `useClock.ts`)**: Poll results record `at: Date.now()` (supplemented by `useClock`) so ages advance without calling `Date.now()` during render.
- **Pure Node-testable domain modules (`status.ts`, `halt/model.ts`, `cost/model.ts`, `teams/model.ts`, `teams/summary.ts`, `teams/goal-verdicts.ts`)**: Keep zero React Native imports so domain rules run directly under `node --test`.
- **SVG charts, diagrams, and screen boxes (`charts.tsx`, `DiagramView.tsx`, `diagram/DiagramView.tsx`, `diagram/shapes.tsx`, `diagram/useCanvasGestures.ts`, `TeamSummary.tsx`)**:
  - `charts.tsx` renders labels with native `<Text>` so system font scaling applies.
  - Diagrams render parsed `DiagramGraph` / `Diagram` data with native SVG and never interpret Mermaid source as HTML/SVG markup.
  - `diagram/DiagramView.tsx` keys `<Svg>` on a FNV-1a content hash plus `selectedId` because `react-native-svg` 15 does not reliably apply prop updates to mounted nodes; `shapes.tsx` applies `opacity` per primitive shape because group opacity is unreliable across renderers.
  - `useCanvasGestures.ts` returns `false` from `onStartShouldSetPanResponder` and activates only past `MOVE_THRESHOLD = 5` or multi-touch so short taps reach SVG node `onPress` handlers.
  - `TeamSummary.tsx` caps `SCREEN_LINES = 14` to fit the 260 px screen box without clipping bottom prompts; `plainScreen` (`summary.ts`) strips trailing blank lines before slicing `maxLines`.
- **Hooks dependency exemptions**: `DiagramView.tsx` and `KnowledgePanel.tsx` keep bare `// eslint-disable-next-line react-hooks/exhaustive-deps` — `DiagramView` memoizes `layoutGraph` on graph identity/counts/collapsed set, and `KnowledgePanel` runs `openComponentId` navigation only when `openComponentId` or `openComponentNonce` change so repeat taps re-open without firing on unrelated state updates.

### 5. Domain honesty, halt, cost, teams/goals, and understanding contracts
- **Halt precedence and monotonic store (`halt/model.ts`, `HaltBanner.tsx`)**: Unreadable halt state (`!readable`) fails closed across every screen; host halts override project halts; `workspaceHaltScope` includes cached repository IDs so offline views retain halt scope. `createHaltStore` uses monotonic tickets and equality checks to prevent stale polls from restoring released halts or causing redundant redraws; halts are informational only in mobile UI.
- **Cost accounting and date parsing (`cost/model.ts`, `cost/parts.tsx`, `CostOverview.tsx`, `ProjectCost.tsx`, `useCost.ts`)**: Headlines, bars, and deltas show metered spend only (plan fees stay separate). Figures never render partially unpriced/unmeasured spend as exact (using `"≥"`) or unmeasured-only spend as `$0` (using `"—"`). `parsePlanUsd` accepts a single comma decimal separator and rejects thousands grouping. `localDate` splits `YYYY-MM-DD` manually so date strings are not shifted by UTC parsing. `accountColors` assigns fixed hues to known accounts and sorted deterministic fallback slots. `ProjectCost` falls back to `briefings.unmeasured` on older hosts; `useTaskRating` is independent of team revisions.
- **Teams, goals, and permissions (`teams/model.ts`, `goal-verdicts.ts`, `TeamDetail.tsx`, `TeamSummary.tsx`, `permissions/model.ts`, `PermissionLog.tsx`)**:
  - `deliveryReceipt`, `pullRequest`, and goal `assessment` always render as agent claims / provisional; only owner outcomes record `"achieved"`.
  - `TeamListItem` accepts both compact list rows and full `TeamView`s from older hosts or live events; `workerStatus` falls back to `parallelism`; `newer()` resolves poll vs mutation races by `(revision, updatedAt)`.
  - `approvalOwner` delegates member prompts to the coordinator only while its recorded `permissionDecisions` entry is in flight or when delegated, within `maxDecisions`, strong coordinator tier, `delegable === true`, `kind === "permission"`, non-destructive, and single-select.
  - `teamControls` / `goalControls`: mission subteams are controlled from mission and goal teams from goal (except owner `cancel` on orphan blocked runs); expired paused goals cannot resume; `TeamDetail` disables controls in place on stale views; `missionTimeLeftMs` (`board/model.ts`) measures against `clockStoppedAt` while an intake mission's clock is stopped.
  - `PermissionLog` tags polls with `filter` so retained `usePoll` values never render under a switched filter while keeping filter-independent `rateFlags` visible; `decisionLogAvailable` gates on `role === "owner" && permissions?.decisionLog === 1`.
- **Understanding cache, scope isolation, and link safety (`offline-cache.ts`, `UnderstandingWorkspace.tsx`, `useWorkBrief.ts`, `BehaviorPanel.tsx`, `KnowledgePanel.tsx`, `Create.tsx`, `RichText.tsx`)**:
  - `offline-cache.ts` persists workspace/repository labels and states only (never briefs, plans, code, or task text) in chunked SecureStore (`<= 8 * 220` chars, 24 h TTL, max 4 workspaces) and invalidates prior snapshots when host credentials change.
  - `UnderstandingWorkspace` and `useWorkBrief` embed connection/credentials in `scope` and discard mismatched `usePoll` responses; `UnderstandingWorkspace` keeps `membership` checkouts separate and ticketed so halt banners survive brief fetch failures.
  - `useWorkBrief` auto-requests at most one narrative refresh per scope for `owner`/`controller` (never `viewer`) and preserves 200 refusal/failure reasons (`shownNarrative`) over subsequent `unavailable` GETs. `chooseBrief` (`summary.ts`) prefers the coordinator's written brief, then newest written brief, then coordinator status. `TeamSummary.ask` uses a dedicated 180 s remote client for repository briefings.
  - `Create.tsx` falls back to `me.projects` on hosts lacking `/project-groups` and gates `detail` actions until `polledDetail.id === selectedProject`.
  - `BehaviorPanel` requires explicit owner action to start checks and distinguishes model evidence from implementation proof; `KnowledgePanel` caps `/generated` cursor reads at 50 pages and displays the host's observed PR counts as-is; `safeOpen` (`RichText.tsx`) opens `https:` URLs without embedded credentials only.

## Consequences

- Every tracked source file in `apps/mobile/` now carries 0 prose comments under `scripts/check-comments.mjs` (retaining only the four bare `eslint-disable-next-line` directives — `useLive.ts` and `usePoll.ts` from ADR-0005, plus `DiagramView.tsx` and `KnowledgePanel.tsx` — and the line-1 `/// <reference types="node" />` in `app.config.ts`).
- Mobile platform quirks, security boundaries, concurrency tickets, and honesty rules remain documented here rather than drifting out of date inline.
