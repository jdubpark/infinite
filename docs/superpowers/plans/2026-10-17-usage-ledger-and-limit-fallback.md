# Usage Ledger and Provider-Limit Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record OpenCode token usage and USD cost durably with a soft per-provider budget, and make the team scheduler recognise a Claude Code or Codex usage limit and move the member's task to a configured fallback profile with partial work preserved.

**Architecture:** The worker already turns hooks, OSC, and screen text into journaled attention signals; this plan adds a `usage` journal event parsed from OpenCode's `--format json` output and a `provider-limit` signal from hooks and the screen. A new `UsageService` follows those journals into a sealed ledger and prices records at read time. `TeamService` consumes `provider-limit` signals the same way it consumes `team-report` events, keeps a sealed host-level `providerLimits` map, and reuses the escalation path to relaunch a member on its `limitFallback` profile.

**Tech Stack:** Node 22 / TypeScript, zod schemas, `node:test` via `tsx --test`, sealed JSON state (`writeSealed` / `unseal` / `Journal` / `readEvents` in `packages/host/src/vault.ts`), React web client in `apps/web`.

**Spec:** `docs/superpowers/specs/2026-10-17-usage-ledger-and-limit-fallback-design.md`

## Global Constraints

- Work in the agent-teams checkout on branch `feat/agent-teams`. Before the first task, the existing uncommitted Teams, Goals, and Linear work in this checkout must be committed as a baseline; otherwise every per-task `git add` of `teams.ts`, `config.ts`, or `server.ts` sweeps that work into an unrelated commit. Do not stash, reset, or clean.
- Repository privacy rule: no home-directory paths, hostnames, account handles, or credentials in any tracked file, fixture, or commit message. Run the scan from `AGENTS.md` before each commit.
- `npm run check` (typecheck, tests, builds) must pass before the branch is declared done. Tests run with `tsx --test --test-concurrency=1 tests/*.test.ts`.
- Prices are USD per million tokens; `cacheRead` and `cacheWrite` default to the input price. Budget periods are `day`, `week`, `month` in UTC, default `month`. Budgets are informational only.
- Providers without a capture path are reported as `unmeasured`, never as zero cost.
- Only `StopFailure` `error === "rate_limit"` is a Claude limit. Only Codex's bottom status-row indicator triggers; transcript text never does.
- Host-level limit entries last until the provider's `resetsAt` capped at 24 hours, otherwise 15 minutes. Only corroborated observations write them.
- A `limitFallback` must name a profile in the same lineup with a different provider; strong tier falls back only to strong tier; chains stop after two hops; a cycle is a config error.
- A limit switch is a new member attempt counted against run and goal limits and does not consume the task's single escalation.
- The host never sends input to a limited member and never approves a provider dialog; stopping it is the only action.
- No attribution trailers in commit messages.
- This checkout's `AGENTS.md` makes the configured Linear team the task record. Before Task 1, create or reuse one issue for this work and record progress and the open live confirmations there, not in repository documents.

## Review Focus

1. OpenCode reports `cost: 0` for a model with no configured price. Expected: the record's `pricing` is `unknown` and totals show the gap, not "$0.00". Pinned in Task 2.
2. A `message.updated` JSON line arrives split across two PTY chunks. Expected: the assembler reassembles it and records one usage event. Pinned in Task 3.
3. The same `step_finish` line is journaled twice (a duplicate announcement). Expected: exactly one ledger row for that `(sessionId, messageId, partId)`. Pinned in Task 4.
4. A Codex screen whose transcript body contains "Usage limit reached" while the status row is normal. Expected: no `provider-limit` signal. Pinned in Task 7.
5. A member's fallback profile's provider is itself in `providerLimits`. Expected: the resolver skips to the next hop; with no hop left the run blocks with a reason naming the profile. Pinned in Task 1 (resolver) and Task 10 (block).

---

### Task 1: Configuration schema for usage prices, budgets, and lineup fallbacks

**Files:**
- Modify: `packages/host/src/team-types.ts:15-52` (profile fields, lineup schema and refinements)
- Modify: `packages/host/src/config.ts:17-20` (add `usage` block; attention `limitConfirmMs`)
- Modify: `packages/host/src/types.ts:93-99` (`Config.usage`, `Config.attention.limitConfirmMs`)
- Test: `tests/usage-config.test.ts` (create)

**Interfaces:**
- Produces: `teamModelProfileSchema` accepts optional `limitFallback: string` (same regex as `id`) on all three provider variants; `teamLineupSchema` accepts optional `fallbacks: TeamModelProfile[]` (1–8) and exports `lineupProfiles(lineup): TeamModelProfile[]` (coordinator, integrator, reviewer, implementers, escalations, fallbacks) and `resolveLimitFallback(lineup, profileId, limitedProviders: Set<Provider>): TeamModelProfile | undefined` (follows `limitFallback` at most two hops, skipping profiles whose provider is in `limitedProviders`).
- Produces: `usageConfigSchema` with `prices: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>` (keys `provider/model`, non-negative) and `budgets: Partial<Record<Provider, { usd: number; period?: "day" | "week" | "month" }>>`; exported type `UsageConfig`. `Config.usage?: UsageConfig`. `attention.limitConfirmMs: number` default 30000, min 1000, max 600000.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/usage-config.test.ts
import test from "node:test"; import assert from "node:assert/strict";
import { teamLineupSchema, resolveLimitFallback } from "../packages/host/src/team-types.js";
import { usageConfigSchema } from "../packages/host/src/config.js";
const p = (id: string, provider: "claude" | "codex" | "opencode", tier?: "light" | "strong", limitFallback?: string) =>
  provider === "opencode" ? { id, label: id, provider, model: "deepseek/deepseek-flash", variant: "high", tier, limitFallback }
  : { id, label: id, provider, model: provider === "claude" ? "claude-opus-5-5" : "gpt-6-luna", effort: "high", tier, limitFallback };
const base = { coordinator: p("c", "claude", "strong", "ds-strong"), integrator: p("c", "claude", "strong", "ds-strong"), reviewer: p("c", "claude", "strong", "ds-strong"),
  implementers: [p("haiku", "claude", "light", "ds-light")], fallbacks: [p("ds-strong", "opencode", "strong"), p("ds-light", "opencode", "light")] };
test("lineup fallbacks must exist, change provider, keep strong tier, and not cycle", () => {
  assert.ok(teamLineupSchema.safeParse(base).success);
  assert.equal(teamLineupSchema.safeParse({ ...base, implementers: [p("haiku", "claude", "light", "missing")] }).success, false);
  assert.equal(teamLineupSchema.safeParse({ ...base, implementers: [p("haiku", "claude", "light", "c")] }).success, false); // same provider
  assert.equal(teamLineupSchema.safeParse({ ...base, coordinator: p("c", "claude", "strong", "ds-light"), integrator: p("c", "claude", "strong", "ds-light"), reviewer: p("c", "claude", "strong", "ds-light") }).success, false); // strong -> light
  const cyclic = { ...base, fallbacks: [p("ds-strong", "opencode", "strong"), p("ds-light", "opencode", "light", "haiku")] };
  assert.equal(teamLineupSchema.safeParse(cyclic).success, false);
});
test("resolveLimitFallback follows at most two hops and skips limited providers", () => {
  const lineup = teamLineupSchema.parse({ ...base, implementers: [p("haiku", "claude", "light", "luna")], escalations: [p("luna", "codex", "light", "ds-light")] });
  assert.equal(resolveLimitFallback(lineup, "haiku", new Set(["claude"]))?.id, "luna");
  assert.equal(resolveLimitFallback(lineup, "haiku", new Set(["claude", "codex"]))?.id, "ds-light");
  assert.equal(resolveLimitFallback(lineup, "haiku", new Set(["claude", "codex", "opencode"])), undefined);
  assert.equal(resolveLimitFallback(lineup, "ds-light", new Set(["opencode"])), undefined);
});
test("usage config accepts per-million prices and provider budgets", () => {
  const parsed = usageConfigSchema.parse({ prices: { "deepseek/deepseek-flash": { input: 0.14, output: 0.28 } }, budgets: { opencode: { usd: 50 } } });
  assert.equal(parsed.budgets.opencode?.period, "month");
  assert.equal(usageConfigSchema.safeParse({ prices: { "x/y": { input: -1, output: 0 } }, budgets: {} }).success, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/usage-config.test.ts`
Expected: FAIL, `resolveLimitFallback` and `usageConfigSchema` are not exported.

- [ ] **Step 3: Implement the schemas**

Add `limitFallback: modelProfileFields.id.optional()` to each variant in `teamModelProfileSchema` (keep key order; append last). Add `fallbacks` to `teamLineupSchema` and include it in the existing unique-id and identity refinements. Add a refinement that, for every profile with `limitFallback`: the target exists in `lineupProfiles`, has a different `provider`, has `tier === "strong"` when the source does, and following `limitFallback` from the source revisits no id and ends within two hops. Export `lineupProfiles` and `resolveLimitFallback(lineup, profileId, limited)`: start at the profile, hop to `limitFallback` while the candidate's provider is in `limited`, return the first candidate not limited within two hops, else `undefined`. In `config.ts` add `usage: usageConfigSchema.optional()` and `limitConfirmMs` to `attention`; add the fields to `Config` in `types.ts`.

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/usage-config.test.ts && npm run typecheck`
Expected: PASS. Also run `npx tsx --test tests/teams.test.ts tests/goals.test.ts` to confirm existing lineups still parse.

- [ ] **Step 5: Commit**

```bash
git add tests/usage-config.test.ts packages/host/src/team-types.ts packages/host/src/config.ts packages/host/src/types.ts
git commit -m "Add usage price and budget config and lineup limit fallbacks"
```

---

### Task 2: Usage record pricing and budget periods

**Files:**
- Create: `packages/host/src/usage.ts`
- Test: `tests/usage-pricing.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface UsageTokens { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  export interface UsageRecord { provider: "opencode"; providerId: string; modelId: string; messageId: string; completedAt: string; tokens: UsageTokens; reportedCost: number }
  export type Pricing = "configured" | "provider" | "unknown";
  export function priceUsage(record: UsageRecord, prices: UsageConfig["prices"] | undefined): { cost: number; pricing: Pricing }
  export function periodStart(period: "day" | "week" | "month", now: Date): Date   // UTC; week starts Monday
  export function sumUsage(rows: { cost: number; pricing: Pricing; tokens: UsageTokens }[]): UsageTotals
  export interface UsageTotals { cost: number; tokens: UsageTokens; messages: number; pricing: Record<Pricing, number> }
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("configured prices override the reported cost and are per million tokens", () => {
  const record = { ...base, tokens: { input: 1_000_000, output: 500_000, reasoning: 0, cacheRead: 2_000_000, cacheWrite: 0 }, reportedCost: 9 };
  assert.deepEqual(priceUsage(record, { "deepseek/deepseek-flash": { input: 0.14, output: 0.28, cacheRead: 0.014 } }), { cost: 0.14 + 0.14 + 0.028, pricing: "configured" });
  assert.deepEqual(priceUsage(record, { "deepseek/deepseek-flash": { input: 1, output: 1 } }).cost, 1 + 0.5 + 2); // cacheRead defaults to input
});
test("reported cost is used without a table, and zero without a table is unknown", () => {
  assert.deepEqual(priceUsage({ ...base, reportedCost: 0.02 }, undefined), { cost: 0.02, pricing: "provider" });
  assert.deepEqual(priceUsage({ ...base, reportedCost: 0 }, {}), { cost: 0, pricing: "unknown" });
});
test("period starts are UTC day, Monday week, and month", () => {
  const now = new Date("2026-10-17T15:00:00Z"); // a Saturday
  assert.equal(periodStart("day", now).toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(periodStart("week", now).toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(periodStart("month", now).toISOString(), "2026-10-01T00:00:00.000Z");
});
```

- [ ] **Step 2: Run to verify failure** — `npx tsx --test tests/usage-pricing.test.ts`; expected: module not found.
- [ ] **Step 3: Implement `packages/host/src/usage.ts`** with the signatures above. Price lookup key is `${providerId}/${modelId}`. Floating point: compute in micro-dollars with integers, divide once.
- [ ] **Step 4: Run tests** — expected PASS.
- [ ] **Step 5: Commit** — `git add packages/host/src/usage.ts tests/usage-pricing.test.ts && git commit -m "Price OpenCode usage records from a configured table with UTC budget periods"`

---

### Task 3: Capture OpenCode usage into the session journal

(Rewritten 2026-10-18 after review: `opencode run --format json` writes part events, not `message.updated`; usage comes from `step-finish` parts in both paths.)

**Files:**
- Create: `packages/host/src/opencode-usage.ts`
- Modify: `packages/host/src/usage.ts` (`UsageRecord` gains `partId: string` and `modelSource: "requested" | "reported"`)
- Modify: `packages/host/src/types.ts:70-75` (add `"usage"` to `Event.type`)
- Modify: `packages/host/src/launch.ts:37-54` (append `--format json` to the `run` arguments unless the provider profile already sets `--format`)
- Modify: `packages/host/src/worker.ts` (`output()` feeds the line assembler for OpenCode team members; native adapter `onUsage`)
- Modify: `packages/host/src/native-opencode.ts` (map `message.updated` id → providerID/modelID; emit usage from `message.part.updated` step-finish parts)
- Modify: `packages/host/src/server.ts` (`/api/sessions/:id/events` `types` filter accepts `usage`)
- Modify: `tests/fixtures/team-agent.mjs` (accept `--format json`; scenario `usage` prints `step_finish` lines)
- Test: `tests/opencode-usage.test.ts` (create), `tests/teams.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export function usageFromStepFinish(part: unknown, context: { completedAt: string; providerId: string; modelId: string; modelSource: "requested" | "reported" }): UsageRecord | undefined
  // undefined unless part.type === "step-finish" with string id and messageID; tokens coerced to finite non-negative integers (missing → 0); cost to a finite non-negative number (otherwise 0)
  export class JsonLineAssembler { push(chunk: string): unknown[] }   // parsed objects per complete JSON-object line; non-JSON dropped; partial trailing line held (cap 1 MiB, then dropped)
  ```
- Headless worker path (`provider === "opencode" && session.team`): each assembled object with `type === "step_finish"` becomes a record with `completedAt` from the line's `timestamp`, provider/model from `session.teamModelProfile.model` split at its first `/`, `modelSource: "requested"`; appended immediately with `append("usage", record)`. No worker-side coalescing.
- Native adapter: `onUsage(record)` option; on `message.part.updated` with `part.type === "step-finish"`, record with `completedAt` = now, provider/model from the remembered `message.updated` for that message (`modelSource: "reported"`), else the session's requested model (`modelSource: "requested"`).

- [ ] **Step 1: Unit tests** in `tests/opencode-usage.test.ts`: a step-finish part with `cost: 0.0123`, `tokens: { input: 1200, output: 300, reasoning: 50, cache: { read: 100, write: 0 } }` yields the record; a part with `tokens.cache` missing and `cost: null` yields zeros; a `text` part yields undefined; the assembler reassembles a JSON line split across two chunks and drops `{not json}` and plain text.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the module, type changes, launch flag, worker and adapter wiring, and the events-route filter.
- [ ] **Step 4: Fixture and team test.** Scenario `usage`: each OpenCode implementer writes a `text` line, a `step_finish` line (`id: "prt_<taskId>_1"`, `messageID: "msg_<taskId>"`, `cost: 0.1`, `tokens: { input: 400, output: 100, reasoning: 0, cache: { read: 0, write: 0 } }`), a second `step_finish` line (`id: "prt_<taskId>_2"`, same message, `cost: 0.4`, `tokens: { input: 600, output: 400, reasoning: 0, cache: { read: 0, write: 0 } }`), then a plain-text line; each JSON line is `{ type, timestamp: Date.now(), sessionID: "ses_fixture", part }`. Team test (lineup with two OpenCode implementers, `spark-high` and `deepseek-high` on `deepseek/deepseek-flash`): per implementer exactly two `usage` events (read with `types=usage`), distinct `partId`s, same `messageId`, summed `tokens.input === 1000`, `tokens.output === 500`, summed `reportedCost === 0.5` (1e-9 tolerance), `modelSource === "requested"`, provider/model equal to the profile model split at `/`.
- [ ] **Step 5: Run** — `npx tsx --test tests/opencode-usage.test.ts tests/usage-pricing.test.ts tests/teams.test.ts tests/native-opencode.test.ts`; expected PASS.
- [ ] **Step 6: Commit.**

---

### Task 4: UsageService ledger and the usage API

**Files:**
- Create: `packages/host/src/usage-service.ts`
- Modify: `packages/host/src/server.ts:95-115` (construct), `:259-282` (`/api/me.usage`), add `GET /api/usage`, `:343` (`/api/sessions` rows gain `usage`)
- Test: `tests/usage-service.test.ts` (create; reuse the `fixture()` helper pattern from `tests/teams.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  export interface SessionUsage extends UsageTotals { measured: true }
  export type UsageSummary = { period: { start: string; end: string }; providers: Record<Provider, { measured: boolean; spent?: UsageTotals; budget?: { usd: number; period: "day" | "week" | "month" }; previous?: UsageTotals; unmeasuredSessions: number }> };
  export class UsageService {
    constructor(config: Config, key: Buffer, manager: Manager);
    start(): void; close(): void;                       // 2 s timer like TeamService
    session(sessionId: string): SessionUsage | { measured: false };
    sessions(ids: string[]): UsageTotals;               // sum over measured ids
    summary(now?: Date): UsageSummary;
  }
  ```
- Ledger: `<stateDir>/usage.sealed` holding `{ cursors: Record<sessionId, number>, sessions: Record<sessionId, { provider, projectId, team?: TeamAssignment, profileId?: string }>, rows: Record<`${sessionId}/${messageId}/${partId}`, UsageRecord> }`. Each tick: list sessions from `manager.list()`, for OpenCode sessions read `manager.events(id, cursor, 200, new Set(["usage"]))` until `!more`, upsert rows by key (last write wins), persist. Rows are per OpenCode step, so `messages` in `UsageTotals` counts step rows. Pricing is applied in `session()`/`summary()` via `priceUsage` with `config.usage?.prices`. A session is `measured` when it is OpenCode and either a team member or a local-UI session (`runtime.nativeUi === "opencode"`); every other session counts toward its provider's `unmeasuredSessions`.

- [ ] **Step 1: Write the failing test**

```ts
test("usage ledger prices OpenCode members, survives restart idempotently, and counts unmeasured sessions", { timeout: 120000 }, async () => {
  const run = await fixture("usage", opencodeLineup, { usage: { prices: { "deepseek/deepseek-flash": { input: 1, output: 2 } }, budgets: { opencode: { usd: 10 } } } });
  try {
    const team = await run.settled((await run.host.fetchApi("/teams", "owner", run.create())).body.id);
    const usage = await waitFor(() => run.host.fetchApi("/usage").then(r => r.body), (u: UsageSummary) => u.providers.opencode.spent?.messages === 4, 20000); // two step rows per OpenCode member
    // deepseek member: configured 1000*1 + 500*2 per million = 0.002; spark member: no table entry -> reported 0.5
    assert.equal(usage.providers.opencode.spent!.cost.toFixed(4), (0.002 + 0.5).toFixed(4));
    assert.deepEqual(usage.providers.opencode.spent!.pricing, { configured: 2, provider: 2, unknown: 0 });
    assert.equal(usage.providers.opencode.budget?.usd, 10);
    assert.ok(usage.providers.claude.unmeasuredSessions >= 2); // coordinator + reviewer
    await run.host.restart();
    const again = (await run.host.fetchApi("/usage")).body as UsageSummary;
    assert.equal(again.providers.opencode.spent!.messages, 4);
    const sessions = (await run.host.fetchApi("/sessions")).body.sessions;
    assert.equal(sessions.find((s: any) => s.id === team.members.find(m => m.modelProfile?.id === "deepseek-high")!.sessionId).usage.cost.toFixed(4), "0.0020");
  } finally { await run.close(); }
});
```

Extend `fixture()` in `tests/teams.test.ts` to accept a third `config` argument merged into `startHost`'s `config`, and export it (or move it to `tests/team-fixture.ts`) so this file can reuse it. If `Host` has no `restart()`, add one to `tests/helpers.ts` that stops the API (not the workers) and starts it again on the same state directory, following how `tests/teams.test.ts:137` already restarts.

- [ ] **Step 2: Run to verify failure** — `npx tsx --test tests/usage-service.test.ts`; expected: 404 on `/usage`.
- [ ] **Step 3: Implement `UsageService`** per Interfaces, construct it in `server.ts` next to `TeamService`, and add `GET /api/usage` (any paired role), `usage: { enabled: Boolean(config.usage), budgets: config.usage?.budgets ?? {} }` to `/api/me`, and `usage` on each `/api/sessions` row (`{ measured: false }` omitted; measured rows carry totals). Export the service to `TeamService` via a setter `teams.useUsage(service)` for Task 5.
- [ ] **Step 4: Run** — `npx tsx --test tests/usage-service.test.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add packages/host/src/usage-service.ts packages/host/src/server.ts tests/usage-service.test.ts tests/helpers.ts && git commit -m "Keep a sealed usage ledger and expose per-provider spend against budgets"`

---

### Task 5: Usage on team and goal views

**Files:**
- Modify: `packages/host/src/team-types.ts:115-195` (`TeamMember.usage?`, `TeamRun.usage?`, `TeamView`)
- Modify: `packages/host/src/teams.ts:67-74` (`view()` attaches usage)
- Modify: `packages/host/src/goal-types.ts` (`GoalCycle.usage?`, `ProductGoal.usage?`), `packages/host/src/goals.ts:204-209` (`refresh()` sums)
- Test: extend `tests/usage-service.test.ts`

**Interfaces:**
- Produces: `TeamMember.usage?: UsageTotals` (measured members only); `TeamRun.usage: { total: UsageTotals; byProfile: Record<string, UsageTotals>; byProvider: Partial<Record<Provider, UsageTotals>>; unmeasuredMembers: number }`; `ProductGoal.usage` with the same shape summed over cycles, and `GoalCycle.usage?: UsageTotals`.

- [ ] **Step 1: Extend the test** from Task 4 to assert `team.usage.byProfile["deepseek-high"].cost.toFixed(4) === "0.0020"`, `team.usage.unmeasuredMembers >= 2`, and, in `tests/goals.test.ts` "cycles" scenario, that `goal.usage.total.messages` equals the sum of its cycles' messages (0 is acceptable there; the assertion is about shape and summation).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `view()` calls `this.usage?.session(member.sessionId)` per member and sums; `goals.refresh()` copies `team.usage.total` to the cycle and sums cycles into `goal.usage`.
- [ ] **Step 4: Run** — `npx tsx --test tests/usage-service.test.ts tests/goals.test.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add packages/host/src/team-types.ts packages/host/src/teams.ts packages/host/src/goal-types.ts packages/host/src/goals.ts tests/usage-service.test.ts tests/goals.test.ts && git commit -m "Show usage totals per member, run, and goal"`

---

### Task 6: Web and CLI usage surfaces, usage docs

**Files:**
- Modify: `apps/web/src/api.ts:36-58` (types: `UsageTotals`, `Me.usage`, `TeamView.usage`, member `usage`, `ProductGoal.usage`)
- Modify: `apps/web/src/teams.tsx:97-110` (Teams list: "Spend" block from `GET /usage`, one row per provider labelled with that provider's `period.start`–`period.end` window and `budget.period`; the top-level summary `period` is only the default month window and must not label a day or week budget), `:232` (member cost line or "Unmeasured"), run total near "Review the changes"
- Modify: `apps/web/src/goals.tsx:138` (add "Agent spend" cell to the Work limits list)
- Modify: `packages/host/src/client.ts:337` (`CLIENT_COMMANDS` add `usage`), new `usage` handler printing one line per provider: `PROVIDER  spent $X.XX of $Y.YY for <day|week|month> from <period.start date> (N steps, M unmeasured sessions)`, where the period words come from the provider entry's own `period: { start, end }` and `budget.period` (never a hard-coded "this month"); `--json` prints the raw summary
- Modify: `docs/teams.md` (new "Usage and budgets" section after "Linear tracking"), `docs/cli.md:17-25` (add `infinite usage`)
- Test: `tests/client-cli.test.ts` (add a `usage` case against `startHost` with a `usage` config), typecheck/build for web

- [ ] **Step 1: Write the CLI test**: start a host with `usage.budgets.opencode.usd = 10`, run the client `usage --json` the way the existing `list` test does, assert the parsed output has `providers.opencode.budget.usd === 10`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the CLI command, web types and components, and docs.** Every web label distinguishes "configured price" from "reported by OpenCode" and renders `Unmeasured` for members without usage. The docs section documents the `usage` config block from the spec verbatim and states that budgets never gate work.
- [ ] **Step 4: Run** — `npx tsx --test tests/client-cli.test.ts && npm run typecheck && npm run build -w @infinite/web`; expected PASS.
- [ ] **Step 5: Commit** — `git add apps/web/src/api.ts apps/web/src/teams.tsx apps/web/src/goals.tsx packages/host/src/client.ts docs/teams.md docs/cli.md tests/client-cli.test.ts && git commit -m "Show provider spend in the web client and infinite usage"`

---

### Task 7: The provider-limit signal from hooks and screens

**Files:**
- Modify: `packages/attention/src/types.ts:30-42` (Signal union), `:52-66` (`Attention.limit?`)
- Create: `packages/attention/src/limits.ts`; export from `packages/attention/src/index.ts`
- Modify: `packages/attention/src/claude.ts:60-74` (`Notification` quota types; `StopFailure` `rate_limit`)
- Modify: `packages/attention/src/attention.ts:34-88` (`applySignal` case `provider-limit`)
- Test: `tests/attention-hooks.test.ts` (extend), `tests/attention-limits.test.ts` (create), fixtures `tests/fixtures/screens/codex-usage-limited.txt`, `tests/fixtures/screens/codex-body-text-only.txt`, `tests/fixtures/screens/claude-usage-limit.txt`

**Interfaces:**
- Produces:
  ```ts
  | { kind: "provider-limit"; limit: "usage" | "credits"; confidence: "single-source" | "corroborated"; resetsAt?: string; message: string }
  Attention.limit?: { limit: "usage" | "credits"; confidence: "single-source" | "corroborated"; resetsAt?: string; since: string; message: string }
  export function detectLimit(lines: string[], provider: Provider, now: Date): { limit: "usage" | "credits"; resetsAt?: string; message: string } | null
  export function parseResetTime(text: string, now: Date): string | undefined   // "resets 3:45pm", "resets Mon 12:00am", "Try again at Oct 18, 2026 3:45 PM"; next occurrence after now; undefined when unparseable
  ```
- `detectLimit` for `codex` inspects only the last non-empty row, which must look like the TUI status row: after `cleanLine`, splitting it on `·` (or `|`) must yield a trimmed segment equal to `usage limited` (case-insensitive) as a whole segment, and the row must not begin with the composer prompt `›` or a shell prompt `$`/`%`. Prose containing the phrase, a composer draft, or a bare shell line never matches. (Amended 2026-10-18 after review: the earlier two-row `\busage limited\b` rule was injectable.) It then scans the whole screen for "Try again at …" to fill `resetsAt`, taking the LAST match so the newest error wins, and reports `limit: "credits"` if the body contains "out of credits". For `claude` it matches `/You've hit your .* limit/` anywhere and parses `resets …`. Other providers return `null`.
- `mapClaudeHook`: `StopFailure` with `error === "rate_limit"` returns the existing two signals plus `{ kind: "provider-limit", limit: "usage", confidence: "single-source", message }`; `Notification` with `notification_type` starting `quota_auto_resume_` adds `{ kind: "provider-limit", limit: "usage", confidence: "corroborated", message }`. Other `StopFailure` errors are unchanged.
- `applySignal` on `provider-limit` sets `next.limit` (keeps an existing `corroborated` entry over a new `single-source` one for the same `limit`), and leaves `state` alone.

- [ ] **Step 1: Write the failing tests.** In `tests/attention-hooks.test.ts`: `StopFailure` with `error: "rate_limit"` yields three signals, the last `provider-limit` single-source; `error: "overloaded"` yields exactly the two existing signals; `Notification` `quota_auto_resume_fired` yields a corroborated `provider-limit`. In `tests/attention-limits.test.ts`: the Codex fixture whose last row is the TUI status row containing `usage limited` and whose body says `Try again at Oct 18, 2026 3:45 PM` detects `{ limit: "usage", resetsAt: "2026-10-18T15:45:00.000Z" }` with `now = 2026-10-17T20:00:00Z`; `codex-body-text-only.txt` (transcript contains "Usage limit reached. You've reached your usage limit." and a normal status row) returns `null`; the Claude fixture line `You've hit your session limit · resets 3:45pm` detects `resetsAt` at the next 15:45 local-to-UTC per the plan's fixed `now`; `applySignal` reducer test: single-source then corroborated updates `limit.confidence`, corroborated then single-source keeps corroborated.
- [ ] **Step 2: Run to verify failure** — `npx tsx --test tests/attention-hooks.test.ts tests/attention-limits.test.ts`.
- [ ] **Step 3: Implement** per Interfaces. Time zone: `parseResetTime` interprets clock times as UTC (the host runs in UTC; document this in `docs/teams.md` in Task 11).
- [ ] **Step 4: Run** — the two test files plus `tests/attention-reducer.test.ts`; expected PASS. Rebuild attention: `npm run build -w @infinite/attention`.
- [ ] **Step 5: Commit** — `git add packages/attention/src tests/attention-hooks.test.ts tests/attention-limits.test.ts tests/fixtures/screens && git commit -m "Add the provider-limit attention signal from Claude hooks and Codex status rows"`

---

### Task 8: Worker corroboration and journaling of limit observations

**Files:**
- Modify: `packages/host/src/worker.ts:366-462` (`checkScreen` calls `detectLimit`; corroboration state), `:289-360` (`onHook` path: after recording a single-source Claude `provider-limit`, arm a two-check screen corroboration window)
- Modify: `packages/host/src/manager.ts:52-62` (`publicAttention` keeps `limit` but truncates `limit.message` to 300 characters, since screen-derived text reaches clients)
- Modify: `tests/fixtures/hook-agent.mjs` (mode `rate-limit`: posts `StopFailure` `rate_limit`, then prints the Claude notice and idles; mode `rate-limit-blip`: posts the hook and prints nothing), create `tests/fixtures/codex-limit-agent.mjs` (draws a Codex-style screen whose last row contains `usage limited`, keeps it for the test's duration)
- Test: `tests/worker-attention.test.ts` (extend)

**Interfaces:**
- Worker state: `let limitWatch: { source: "hook" | "screen"; firstAt: number; checks: number; corroborated: boolean } | undefined`.
- Rules (from the spec): a Claude hook observation records `single-source` immediately and, if `detectLimit` matches on the same or either of the next two `checkScreen` runs, records a `corroborated` signal once. A Codex screen match records `single-source` on first sight and `corroborated` once it has matched on at least three consecutive checks spanning at least `config.attention.limitConfirmMs` with no new output in between; a check without the match resets the watch. A Claude screen match with no preceding hook observation records one `single-source` signal and nothing more. The `provider-limit` signal source is `"hook"` or `"screen"` accordingly.

- [ ] **Step 1: Write the failing tests** (host started with `attention: { limitConfirmMs: 2000 }`):

```ts
test("a Claude rate-limit hook is single-source until the screen notice corroborates it", { timeout: 60000 }, async () => {
  // provider "claude" pointed at hook-agent.mjs rate-limit; wait until events contain a provider-limit with confidence corroborated
  // assert the first provider-limit event is single-source, the second corroborated, and the session attention.limit.confidence === "corroborated"
});
test("a Claude rate-limit hook with no screen notice stays single-source", { timeout: 60000 }, async () => {
  // mode rate-limit-blip; after 5 s, exactly one provider-limit event, single-source
});
test("a Codex status row is corroborated only after it persists", { timeout: 60000 }, async () => {
  // codex-limit-agent.mjs; first provider-limit single-source, a corroborated one at least 2 s later; overloaded body text in the same fixture never produces a third
});
```

Use the existing event and session endpoints the file already exercises at `tests/worker-attention.test.ts:25-80`.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the watch in `checkScreen` and the hook path; add `limit` to `publicAttention`.
- [ ] **Step 4: Run** — `npx tsx --test tests/worker-attention.test.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add packages/host/src/worker.ts packages/host/src/manager.ts tests/fixtures/hook-agent.mjs tests/fixtures/codex-limit-agent.mjs tests/worker-attention.test.ts && git commit -m "Corroborate provider usage limits in the worker before they count"`

---

### Task 9: Native Codex app-server limit errors

**Files:**
- Modify: `packages/host/src/native-codex.ts:225` (read `turn.error.codexErrorInfo`)
- Modify: `tests/fixtures/native-codex.mjs` (a prompt text `usage-limit` completes the turn with `status: "failed", error: { codexErrorInfo: "usageLimitExceeded" }`)
- Test: `tests/native-ui.test.ts` (extend)

- [ ] **Step 1: Write the failing test**: a local-UI Codex session prompted with `usage-limit` ends with a `provider-limit` event `{ limit: "usage", confidence: "corroborated" }` and a failed `turn-end`; a prompt `rate-limit-transient` (`codexErrorInfo: "rateLimitExceeded"`) produces the failed `turn-end` and no `provider-limit`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**: on `turn/completed` with `turn.status === "failed"` and `codexErrorInfo === "usageLimitExceeded"`, `options.onSignal({ kind: "provider-limit", limit: "usage", confidence: "corroborated", message: "Codex reported usageLimitExceeded" })` before the existing `turn-end`.
- [ ] **Step 4: Run** — `npx tsx --test tests/native-ui.test.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add packages/host/src/native-codex.ts tests/fixtures/native-codex.mjs tests/native-ui.test.ts && git commit -m "Treat Codex usageLimitExceeded as a corroborated provider limit"`

---

### Task 10: Scheduler fallback on provider limits

**Files:**
- Modify: `packages/host/src/team-types.ts:130-136` (`TeamTask.limitSwitches?: { fromProfileId?: string; toProfileId: string; reason: string; resetsAt?: string; memberId: string; at: string }[]`), `TeamMember.stoppedReason?: string`, `TeamRun`/`TeamView` gain `providerLimits: ProviderLimit[]`
- Create: `packages/host/src/provider-limits.ts` — `export interface ProviderLimit { provider: Provider; detectedAt: string; resetsAt?: string; expiresAt: string; sessionId: string; runId?: string; confidence: "corroborated" }` and `export class ProviderLimits { constructor(file: string, key: Buffer); observe(limit: Omit<ProviderLimit, "expiresAt">): void; clear(provider: Provider): void; active(now?: Date): ProviderLimit[]; limited(now?: Date): Set<Provider> }` with expiry = `min(resetsAt, detectedAt + 24h)` or `detectedAt + 15 min`, persisted with `writeSealed`
- Modify: `packages/host/src/teams.ts:339-360` (member step: read `signal` events with `data.kind === "provider-limit"` alongside `team-report`; switch), `:430-445` (`memberProfile`/`newMember` substitution via `resolveLimitFallback(run.lineup, profile.id, this.limits.limited())`), `:67-74` (`view()` includes `providerLimits: this.limits.active()`), and a public `observeLimit(sessionId, signal)` the Manager-facing tick can call for non-team sessions
- Modify: `packages/host/src/server.ts:273` (`/api/me.providerLimits`)
- Modify: `tests/fixtures/team-agent.mjs` (scenario `limit`: the implementer whose `--model` is `claude-haiku-5-5` writes a partial `a.txt`, posts `StopFailure` `{ error: "rate_limit" }` to its hook, prints `You've hit your session limit · resets 3:45pm`, then idles; the replacement whose `--model` is `deepseek/deepseek-flash` sees the partial file and completes; scenario `limit-no-fallback` uses a lineup without `limitFallback`)
- Test: `tests/teams.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveLimitFallback` (Task 1), `provider-limit` signal (Task 7), events via `manager.events(id, cursor, 200, new Set(["team-report", "signal"]))`.
- Switch procedure for a member with no report whose events contain a `provider-limit` allowed to switch (`confidence === "corroborated"`, or `source === "hook"` for Claude): if corroborated, `limits.observe(...)`; `await this.stopped(member)` (on failure keep the existing `unavailable` handling); resolve the fallback; if none, `this.block(stored, new TeamError(409, "provider-limit", "<Provider name> usage limit reached at <HH:MM>[, resets <HH:MM>]; no fallback profile is configured for <profileId>."))`; otherwise for an implementer run `assertMemberScope` then `newMember(run, "implementer", member.cwd, member.baseCommit, task.id, undefined, fallback)` with the escalation-style prompt note, push `task.limitSwitches`, set `member.stoppedReason`; for other roles `assertMemberReadOnly` then `newMember` with `member.prompt` and the fallback pinned; `this.event(stored, "<fromLabel> hit a <Provider> usage limit[ (resets HH:MM)]; <task or role> continues on <toLabel> with partial work preserved.")`.
- `newMember`: after selecting `selected`, if `selected.provider` is in `limits.limited()`, substitute `resolveLimitFallback(...)` when it resolves and record an event "`<label>` launched on `<fallbackLabel>`: `<Provider>` is limited until HH:MM".
- Non-team sessions and clearing: at the start of each scheduler tick, scan `manager.list()`. For a `claude` or `codex` session whose `attention.limit?.confidence === "corroborated"` and whose `limit.since` is newer than the stored entry for that provider (or there is none), call `limits.observe(...)` with `runId` omitted. For a session of a limited provider, call `limits.clear(provider)` only when its journal shows a `turn-end` signal with `failed !== true` recorded after the entry's `detectedAt` and after that session's latest `provider-limit` signal (read via `manager.events(id, cursor, 200, new Set(["signal"]))` with a per-session cursor kept in memory). `attention.lastActivityAt` is bumped by every signal, including a repeat limit hit, so it must not be used for this. Cover the clear rule with a scheduler unit test: `ProviderLimits.observe` then a fake session row meeting the clear condition leaves `active()` empty.

- [ ] **Step 1: Write the failing tests**

```ts
test("a Claude member that hits a usage limit continues on its fallback with partial work, and later Claude members launch on the fallback directly", { timeout: 120000 }, async () => {
  const run = await fixture("limit", limitLineup); // haiku implementer with limitFallback deepseek-light; coordinator/reviewer codex strong
  try {
    const team = await run.settled((await run.host.fetchApi("/teams", "owner", run.create())).body.id);
    assert.equal(team.status, "ready-for-review");
    const task = team.tasks.find(t => t.id === "a")!;
    assert.equal(task.limitSwitches?.length, 1);
    assert.equal(task.limitSwitches![0].toProfileId, "deepseek-light");
    assert.equal(task.limitSwitches![0].resetsAt?.slice(11, 16), "15:45");
    assert.equal(team.members.filter(m => m.taskId === "a").length, 2);
    assert.match(team.members.find(m => m.modelProfile?.id === "haiku")!.stoppedReason!, /usage limit/);
    assert.equal(team.providerLimits[0]?.provider, "claude");
    const receipts = readReceipts(run.receipts); // fixture receipts record argv per member
    assert.ok(receipts.some(r => r.model === "deepseek/deepseek-flash" && r.sawPartial === true));
    const second = await run.settled((await run.host.fetchApi("/teams", "owner", run.create())).body.id);
    assert.ok(second.events.some(e => /launched on DeepSeek/.test(e.text)));
    assert.equal(second.members.filter(m => m.modelProfile?.provider === "claude").length, 0);
  } finally { await run.close(); }
});
test("a usage limit with no configured fallback blocks the run with its reason", { timeout: 90000 }, async () => {
  // fixture("limit-no-fallback", ...); settled status "blocked"; reason matches /no fallback profile is configured for haiku/
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `provider-limits.ts`, the scheduler changes, the `/api/me` field, and the fixture scenarios. The fixture's `receipt.sawPartial` is `existsSync("a.txt")` at start for the OpenCode member.
- [ ] **Step 4: Run** — `npx tsx --test tests/teams.test.ts tests/goals.test.ts`; expected PASS.
- [ ] **Step 5: Commit** — `git add packages/host/src/provider-limits.ts packages/host/src/teams.ts packages/host/src/team-types.ts packages/host/src/server.ts tests/fixtures/team-agent.mjs tests/teams.test.ts && git commit -m "Switch limited team members to their configured fallback profile"`

---

### Task 11: Web limit displays and documentation

**Files:**
- Modify: `apps/web/src/api.ts` (types `ProviderLimit`, `limitSwitches`, `stoppedReason`, `Me.providerLimits`), `apps/web/src/teams.tsx:97-110` (Teams list banner "Claude Code limited since HH:MM · resets HH:MM · new Claude members launch on their fallback"), `:231` (task `limitSwitches` rendered like `escalation`), `:232` (member `stoppedReason`), `apps/web/src/main.tsx` (session row shows `attention.limit` as "Usage limit reached · resets HH:MM"; measured sessions also show their `usage` cost with the shared formatter from `apps/web/src/usage.tsx`, and unmeasured sessions show nothing, never 0.00 — carried from Task 6)
- Modify: `docs/teams.md` ("Provider usage limits and fallbacks" section: config example from the spec, confidence rules, what the host does and never does, UTC note), `docs/security.md` (one paragraph: limit observations and usage totals are records of what the host saw; no credential involved)
- Test: `npm run typecheck && npm run build -w @infinite/web`

- [ ] **Step 1: Implement the web changes and docs.**
- [ ] **Step 2: Run** — `npm run typecheck && npm run build -w @infinite/web`; expected PASS.
- [ ] **Step 3: Commit** — `git add apps/web/src docs/teams.md docs/security.md && git commit -m "Show provider limits and fallback switches in the web client"`

---

### Task 12: Full check and privacy scan

- [ ] **Step 1:** `npm run check`; expected: all tests, typecheck, and builds pass.
- [ ] **Step 2:** `git diff <baseline>..HEAD | grep -n -I -E '/Users/|/home/[a-z0-9_-]+/|~/(Library|Projects|Documents|Desktop)|\.ts\.net|SHA256:|BEGIN [A-Z ]*PRIVATE KEY|([0-9]{1,3}\.){3}[0-9]{1,3}'`; expected: only `127.0.0.1` hits.
- [ ] **Step 3:** Record the three live confirmations still owed (Claude `rate_limit` on a quota hit, the Codex status row rendering, non-zero OpenCode `cost` for the configured providers) as open items in the Linear issue for this work, per `AGENTS.md`, not in the repository.
