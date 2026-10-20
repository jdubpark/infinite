# Cost tracking, balances, and agent effectiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track metered agent spend per task, goal, project, and day; show the DeepSeek balance; render one cost view on web, mobile, Mac, and CLI; and score metered models against subscription baselines.

**Architecture:** Extend the existing sealed `UsageService` ledger (`packages/host/src/usage-service.ts`) with a built-in price catalog, account mapping, attribution queries, briefing rows, and a balance cache. Expose read-only JSON routes. Each client renders the same three-level view from those routes. Effectiveness is derived on read from team runs plus the ledger, with reviewer rubric scores and owner ratings stored on team tasks.

**Tech Stack:** TypeScript, Node 22, Express, zod, vitest (host); React and Vite (web); Expo and React Native with `react-native-svg` (mobile); SwiftUI and Swift Charts (macOS).

**Spec:** `docs/superpowers/specs/2026-10-19-cost-and-agent-effectiveness-design.md`. Linear: INF-71.

## Global Constraints

- All money in USD, as numbers in dollars. Arithmetic is done in integer micro-dollars, as in `usage.ts`.
- Claude and Codex never get per-use dollars. They appear only as `planUsd` on subscription accounts.
- A balance appears only when the provider's official API returned it. Otherwise it is `null`, rendered "—".
- An unpriced or unmeasured figure is never shown as $0. Totals carry `unpriced` and `unmeasured` counts.
- Provider keys are read from an absolute `apiKeyFile` path (the existing `linear.apiKeyFile` / `summaries.apiKeyFile` convention), read once, never logged, and never sent to clients.
- No private paths, hostnames, keys, or personal identifiers in tracked files (`AGENTS.md`).
- Scores and rubrics never enter implementer prompts. The host never edits routing configuration.
- UI copy: short labels; a legend replaces sentences. Follow `DESIGN.md`.
- Workers never use `git stash`, and do not commit; the coordinator commits.

## Shared API contract

Every client mirrors these shapes. Host types live in `packages/host/src/usage-api.ts`.

```ts
type Pricing = "configured" | "catalog" | "provider" | "unknown";        // "catalog" is new
type Money = { usd: number; unpriced: number };                          // unpriced = steps with no price
type Balance = { amount: number; currency: string; asOf: string; stale: boolean } | null;
type AccountView = { id: string; kind: "metered" | "subscription"; month?: Money; planUsd?: number; balance: Balance };

// GET /api/usage — existing UsageSummary plus:
{ month: { start: string; end: string; spent: Money; previous: Money; plansUsd: number; unmeasuredSessions: number },
  accounts: AccountView[] }

// GET /api/usage/daily?days=30&tz=Europe/Berlin&project=ID   (days 1..366, tz IANA, default UTC)
{ tz: string; accounts: string[]; days: { date: "YYYY-MM-DD"; usd: number; byAccount: Record<string, number> }[] }

// GET /api/usage/projects?tz=…
{ projects: { id: string; name: string; total: Money; unmeasured: number; month: Money & { unmeasured: number }; spark: number[] /* 30 daily usd, oldest first */ }[] }

// GET /api/usage/projects/:id?tz=…
{ id: string; name: string; total: Money; unmeasured: number;
  byKind: { goals: number; teams: number; sessions: number; briefings: number };
  goals: { id: string; title: string; total: Money; tasks: number }[];
  teams: { id: string; title: string; goalId?: string; total: Money }[];          // runs not under a goal, plus goal runs
  sessions: { id: string; title: string; total: Money }[];                        // measured non-team sessions
  briefings: { total: Money; runs: number; unmeasured: number } }

// Team view (GET /api/teams/:id): each task gains
  usage?: { usd: number; unpriced: number; tokens: number; attempts: number; profiles: string[] }
  ownerRating?: { score: 1|2|3|4|5; note?: string; at: string }
  rubric?: Rubric
// Goal view (GET /api/goals/:id) gains
  tasks: { teamId: string; taskId: string; title: string; usage: TeamTask["usage"] }[]

type Rubric = { version: 1; correctness: Score; cleanliness: Score; extensibility: Score; docs: Score; reviewerProfileId: string };
type Score = { score: 1|2|3|4|5; why: string };

// GET /api/usage/models?role=implementer   (role defaults to implementer)
{ rubricVersion: 1; minAttempts: 10; rows: ModelRow[]; suggestions: Suggestion[] }
type ModelRow = { profileId: string; label: string; provider: string; role: string; metered: boolean;
  attempts: number; integrated: number; rate: number; rateInterval: [number, number] | null;   // Wilson 95%
  medianUsd: number | null; medianTokens: number | null; usdPerMTok: number | null;            // null when not metered
  medianMinutes: number | null; meanReviewRounds: number | null;
  rubric: { correctness: number; cleanliness: number; extensibility: number; docs: number; n: number } | null;
  owner: { mean: number; n: number } | null; enough: boolean };                                 // enough = attempts >= minAttempts
type Suggestion = { text: string; profileId: string; comparedTo: string; role: string; n: [number, number] };

// POST /api/teams/:id/tasks/:taskId/rating  (owner)  body { requestId: uuid, score: 1..5, note?: string ≤ 1000 }
// POST /api/usage/balances/refresh          (owner)  → { accounts: AccountView[] }
```

## Review Focus

1. **Peak-window pricing at the boundary.** A DeepSeek step completing at 03:59:59 UTC on a Friday bills peak; 04:00:00 bills off-peak; Saturday 02:00 bills off-peak. Test in Task 1.
2. **Timezone day buckets.** A step at 23:30 UTC belongs to the next day in `Asia/Seoul`. An invalid `tz` returns 400 and does not fall back silently. Test in Task 2.
3. **DeepSeek balance failure.** A 401, a timeout, or a malformed body keeps the last good value with `stale: true`, or `null` if none exists. It never throws into `/api/usage`, and the key never appears in a log or response. Test in Task 3.
4. **Mixed pricing totals.** A project whose steps are partly unpriced shows `unpriced > 0`, and every client renders "at least $X" or a marker, never a bare $X. Test in Task 2, plus visual checks in Tasks 7–9.
5. **Scorecard with tiny n.** One attempt per profile yields `enough: false`, `rateInterval` computed but no suggestion. A limit-switched attempt is excluded from `attempts`. Test in Task 6.

---

### Task 1: Price catalog, peak windows, and accounts config

**Files:**
- Create: `packages/host/src/price-catalog.ts`
- Modify: `packages/host/src/usage.ts` (`priceUsage`, `Pricing`), `packages/host/src/config.ts` (`usageConfigSchema`)
- Test: `tests/usage-pricing.test.ts` (extend)

**Interfaces:**
- Produces:
  - `PRICE_CATALOG: Record<string, CatalogPrice>`, where `CatalogPrice = { input; output; cacheRead?; cacheWrite?; peak?: { days: number[]; hoursUtc: [number, number][]; multiplier: number }; source: string; asOf: string }`.
  - `priceUsage(record, prices, catalog = PRICE_CATALOG): { cost; pricing: Pricing }`, resolved in the order configured, then catalog, then provider-reported, then unknown.
  - `UsageConfig.accounts: Record<string, { kind: "metered" | "subscription"; match: string[]; planUsd?: number; balance?: { source: "deepseek"; apiKeyFile: string } }>`, defaulting to `{}`.
  - `accountOf(providerId, modelId, accounts): string`, which returns the first account whose `match` glob (`deepseek/*`) matches, else `providerId`.

Catalog values. These were checked on 2026-10-19 against the official pages; record each one's `source` URL and `asOf: "2026-10-19"`:

| key | input | cacheRead | output | peak |
|---|---|---|---|---|
| `deepseek/deepseek-flash` (also `deepseek/deepseek-v4-flash`) | 0.15 | 0.003 | 0.60 | Mon–Fri, `[1,4]` and `[6,10]` UTC, ×2 |
| `deepseek/deepseek-v4-pro` | 0.66 | 0.022 | 1.98 | same |
| `meta/muse-spark-1.3`, `-1.2`, `-1.1` | 1.25 | 0.15 | 4.25 | — |
| `meta/muse-spark-1.3-contributor`, `-1.2-contributor` | 0.10 | 0.002 | 0.20 | — |
| `meta/muse-wonder-1.0` | 4.00 | 0.20 | 20.00 | — |

Sources: `https://api-docs.deepseek.com/quick_start/pricing` and `https://dev.meta.ai/docs/pricing-rate-limits.md`. Chinese public holidays are not modelled; a comment in the file says so. `cacheWrite` defaults to `input`.

- [ ] **Step 1: Write failing tests**
  - `catalog prices deepseek flash off-peak`: 1M input, 1M output, 1M cacheRead at Saturday 02:00Z → `{ cost: 0.753, pricing: "catalog" }`.
  - `catalog doubles at peak`: the same tokens at Friday 03:59:59Z → `1.506`; at Friday 04:00:00Z → `0.753`.
  - `configured price beats catalog`.
  - `accountOf matches globs`: `accountOf("deepseek","deepseek-flash",{deepseek:{kind:"metered",match:["deepseek/*"]}}) === "deepseek"`; an unmatched model returns its providerId.
- [ ] **Step 2:** Run `npx vitest run tests/usage-pricing.test.ts`. Expect the new tests to fail.
- [ ] **Step 3:** Implement. The peak test uses `completedAt`'s UTC weekday (1–5) and hour, with each `[start, end)` range end-exclusive.
- [ ] **Step 4:** Run the tests again. Expect PASS.

### Task 2: Ledger attribution, daily series, projects, and briefings

**Files:**
- Create: `packages/host/src/usage-api.ts` (contract types and pure aggregation helpers)
- Modify: `packages/host/src/usage-service.ts`, `packages/host/src/goals.ts`, `packages/host/src/teams.ts` (task usage on the view), `packages/host/src/repository-briefings.ts` (optional envelope `usage`)
- Test: `tests/usage-service.test.ts` (extend, or create following existing ledger tests), `tests/usage-api.test.ts`

**Interfaces:**
- Consumes: `priceUsage` and `accountOf` (Task 1).
- Produces these `UsageService` methods:
  - `summary(now)`, extended with `month` and `accounts`; `accounts[].balance` comes from `BalanceService` (Task 3) via `useBalances(service)`.
  - `daily({ days, tz, projectId?, now? })`.
  - `projects({ tz, now? })`.
  - `project(id, { tz, now? })`.
  - `taskUsage(runId, taskId, revision): TaskUsage | undefined`; task attribution matches both the task ID and the revision that created the task.
  - `recordBriefing(projectId: string, sessionId: string, at: string, usage: BriefingUsage | null)`.
- Produces `BriefingUsage = { providerId: string; modelId: string; tokens: UsageTokens; reportedCost?: number }`.
- The ledger gains `briefings: Record<key, { projectId; at; record?: UsageRecord }>`. A missing `record` counts as unmeasured.
- Goal and team resolution: `UsageService.useResolvers({ goalOfRun(runId): { id; title } | undefined; runTitle(runId): string | undefined; projectName(id): string | undefined; sessionTitle(id): string | undefined })`, wired in `server.ts`.

Day bucketing uses `Intl.DateTimeFormat(…, { timeZone })`. An invalid tz throws `RangeError`, which the route maps to 400. Attribution:
- task = ledger `team.runId` + `team.taskId` + the task-creating revision
- goal = `goalOfRun(runId)`
- project = ledger `projectId`
- kind = briefing row, else team-with-goal, else team, else session

- [ ] **Step 1: Write failing tests**
  - `daily buckets by tz`: a row at `2026-10-18T23:30:00Z` lands in `2026-10-19` for `Asia/Seoul` and in `2026-10-18` for `UTC`.
  - `daily fills empty days with 0` and returns exactly `days` entries, oldest first.
  - `project roll-up splits kinds` and `unpriced counts propagate`.
  - `task usage sums replacement members` (two members, same `taskId`, `attempts: 2`).
  - `briefing without usage counts unmeasured`.
  - `invalid tz throws RangeError`.
- [ ] **Step 2:** Run the tests. Expect FAIL.
- [ ] **Step 3:** Implement. In `repository-briefings.ts`, `envelopeSchema` gains an optional `usage` (the `BriefingUsage` shape, with `.optional()` so current Jevcode output still parses). After each run with `decision.action === "run"`, call `recordBriefing`. Team view: each task gets `usage` from `taskUsage`. Goal view gets `tasks` across cycles.
- [ ] **Step 4:** Run the tests. Expect PASS.

### Task 3: DeepSeek balance service

**Files:**
- Create: `packages/host/src/balances.ts`
- Test: `tests/balances.test.ts`

**Interfaces:**
- Produces:
  - `class BalanceService { constructor(accounts: UsageConfig["accounts"], fetchImpl = fetch, now = () => Date.now()); get(accountId): Balance; refresh(force?: boolean): Promise<void>; start(); close() }`
  - It refreshes at most every 15 minutes, and also on `refresh(true)`, limited to one forced refresh per 60 s.
- It calls `GET https://api.deepseek.com/user/balance` with `Authorization: Bearer <key>` and a 10 s timeout. It parses `{ is_available, balance_infos: [{ currency, total_balance }] }` and prefers `USD`, else the first entry. `total_balance` is a string, so it uses `Number()` and rejects NaN.

- [ ] **Step 1: Write failing tests** with a stubbed `fetchImpl`:
  - `parses USD balance`: returns `{ amount: 12.5, currency: "USD", stale: false }`.
  - `failure keeps last value stale`.
  - `failure with no value returns null`.
  - `no balance config returns null`.
  - `key never in error message`: the thrown or logged text excludes the key string.
- [ ] **Step 2:** Run the tests. Expect FAIL. **Step 3:** Implement. **Step 4:** Run the tests. Expect PASS.

### Task 4: Routes and CLI

**Files:**
- Modify: `packages/host/src/server.ts` (routes, wiring), `packages/host/src/client.ts` (`usage` subcommands), `docs/cli.md`, `docs/teams.md` ("Usage and budgets": catalog, accounts, balance)
- Test: `tests/usage-routes.test.ts` (or extend an existing server test), `tests/client-usage.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3. Produces the routes in the contract.
- CLI:
  - `infinite usage`: the month headline, previous month, plans, and one line per account with its balance or "—", then a 30-day bar chart using `▁▂▃▄▅▆▇█`, scaled to the max day, with first and last dates under it.
  - `infinite usage projects`, `infinite usage project <id>`, `infinite usage goal <id>`, and `infinite usage models [--role R]`.
  - `--json` everywhere. The CLI sends `tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`.

- [ ] **Step 1: Failing tests:**
  - `GET /api/usage/daily?tz=Not/AZone → 400`.
  - `GET /api/usage/daily?days=0 → 400`.
  - `refresh requires owner`.
  - `usageBars([0,1,2,4]) === "▁▂▄█"` (exact glyphs from 8 levels: 0→`▁`, max→`█`).
- [ ] **Step 2–4:** Implement and run until PASS.

### Task 5: Reviewer rubric, owner rating, and attempt facts

**Files:**
- Modify: `packages/host/src/team-types.ts` (review report `rubric?: { taskId, correctness, cleanliness, extensibility, docs }[]` where each is `{ score: 1..5, why: string ≤ 300 }`; `TeamTask.rubric?`, `TeamTask.ownerRating?`, `TeamTask.diffStat?: { added; removed; files; docs: boolean; tests: boolean }`, `TeamTask.reviewRounds?: number`), `packages/host/src/teams.ts` (store the rubric on review; skip and record an event when the reviewer profile's model equals the task implementer's; compute `diffStat` with `git diff --numstat <base>..<commit>` at integration; increment `reviewRounds` on each `changes-requested`), the reviewer prompt text (ask for the optional per-task rubric, rubric version 1), `packages/host/src/server.ts` (rating route)
- Test: extend the existing team scheduler tests

**Interfaces:** Produces the `TeamTask` fields above, plus `teams.rateTask(runId, taskId, { requestId, score, note })`, which is idempotent per `requestId`.

- [ ] **Step 1: Failing tests:**
  - `rubric stored per task on approval`.
  - `self-graded rubric dropped`: same model id, so no `rubric` is stored and an event is recorded.
  - `rating is owner-only and idempotent`.
  - `diffStat flags docs and tests`: a change touching `docs/x.md` and `tests/y.test.ts` gives `docs: true, tests: true`.
- [ ] **Step 2–4:** Implement and run until PASS.

### Task 6: Scorecard and suggestions

**Files:**
- Create: `packages/host/src/scorecard.ts`
- Modify: `packages/host/src/server.ts` (`GET /api/usage/models`)
- Test: `tests/scorecard.test.ts`

**Interfaces:**
- Consumes: team runs (`teams.list()` records with members and tasks), `UsageService.taskUsage`, and Task 5 fields.
- Produces `scorecard(runs, usage, { role, minAttempts = 10 }): { rubricVersion: 1; minAttempts; rows: ModelRow[]; suggestions: Suggestion[] }`.

Counting rules:
- An attempt is a member with `taskId` in `role`.
- Exclude members stopped for a provider limit (`stoppedReason` set by a limit switch).
- An attempt is integrated when the task is `integrated` and `task.memberId === member.memberId`.
- Minutes run from `member.startedAt` to the report time.
- Metered means the profile's provider is `opencode`; cost and tokens are `null` otherwise.
- `rateInterval` is the Wilson 95% interval.

A suggestion is emitted only when both rows have `enough`, the same role, and the cheaper metered row's rate interval overlaps or exceeds the other's. It uses the format `"${label} integrated ${i}/${n} ${role} tasks at a median $${usd}; ${other} ${i2}/${n2}${otherUsd}"`, with rubric means appended when both have `n ≥ 5`.

- [ ] **Step 1: Failing tests:**
  - `wilson interval for 8/10 ≈ [0.49, 0.94]` (two decimals).
  - `limit-switched attempt excluded`.
  - `under minAttempts: enough false and no suggestion`.
  - `subscription row has null cost`.
  - `suggestion emitted at n ≥ 10 each`.
- [ ] **Step 2–4:** Implement and run until PASS.

### Task 7: Web Cost page

**Files:**
- Create: `apps/web/src/cost.tsx` (Overview, Projects, Project, and Models views, plus SVG chart components)
- Modify: `apps/web/src/main.tsx` (a "Cost" nav button and route, shown when `me.usage?.enabled`), `apps/web/src/usage.tsx` (replace the text-only `SpendBlock`), `apps/web/src/teams.tsx` and `apps/web/src/goals.tsx` (per-task cost cell and owner rating control), `apps/web/src/style.css`

**Interfaces:** Consumes the shared contract only.

The design is in Spec Part 4:
- one large monthly figure with a delta chip
- 30-day stacked bars with a hover or tap tooltip
- account cards (balance or "—", plan fee, "as of")
- a project list with sparklines
- project drill-down
- a Models tab table with n, an interval bar, and "not enough data" for rows below `minAttempts`

Charts are hand-built SVG with no new dependency. Theme tokens come from `style.css`. Unpriced figures render as "≥ $X" with a dotted underline.

- [ ] Build the page. Then run `npm run build -w @infinite/web` and `npm run check`, and expect them to pass.
- [ ] Run the web client against a local host with seeded ledger rows, screenshot the Overview, a project, and Models at desktop and phone widths, and fix layout issues.

### Task 8: Mobile Cost screen

**Files:**
- Create: `apps/mobile/src/app/cost/index.tsx`, `apps/mobile/src/app/cost/project/[id].tsx`, `apps/mobile/src/features/cost/` (API hooks, charts, parts)
- Modify: `apps/mobile/src/app/index.tsx` (entry point to Cost), `apps/mobile/src/features/teams/TeamDetail.tsx` and `GoalDetail.tsx` (per-task cost and rating), `apps/mobile/package.json` (add `react-native-svg` with `npx expo install react-native-svg`)

The views match Task 7, laid out for the phone: overview, projects, project, and a models segment. Follow `apps/mobile/AGENTS.md`.

- [ ] Run `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` in `apps/mobile`, and expect them to pass.
- [ ] In the iOS simulator against the local host, screenshot the overview and project screens, then fix any issues.

### Task 9: Mac Cost view

**Files:**
- Create: `apps/macos/Sources/InfiniteCore/Usage.swift` (Codable contract types and client calls), `apps/macos/Sources/InfiniteDesktop/CostView.swift`
- Modify: `apps/macos/Sources/InfiniteDesktop/HomeView.swift` or the sidebar (a Cost entry), `TeamsView.swift` (per-task cost)
- Test: `apps/macos/Tests/InfiniteCoreTests/UsageTests.swift` (decoding the contract JSON, including `balance: null` and missing optionals)

The views match Task 7, using Swift Charts `BarMark` stacked by account and `LineMark` sparklines.

- [ ] Run `swift build` and `swift test` in `apps/macos`, and expect them to pass. Launch the app against the local host, screenshot the Cost view, and fix any issues.

### Task 10: Integration and finish

- [ ] Run a full `npm run check`, mobile lint and tsc, and `swift test`.
- [ ] Run one independent review of the whole diff with Codex `gpt-6-astra` high in a read-only sandbox. Fix confirmed findings.
- [ ] Run the private-info scan from `AGENTS.md` on the staged diff.
- [ ] Commit, open the PR referencing INF-71, and record the evidence on INF-71.
