# Cost tracking, balances, and agent effectiveness

Date: 2026-10-19. Status: design for review. Builds on `2026-10-17-usage-ledger-and-limit-fallback-design.md`, which added the OpenCode usage ledger.

## Intent

The owner wants to know, at a glance, how much money agents spent: per task, per goal, accrued per project, and per day. They want the same view on the phone, the Mac app, the web client, and the CLI, along with the remaining balance on connected provider accounts where a provider exposes one.

Second, they want to learn which models deliver good results per token and per dollar, and later to use that evidence to choose models more deliberately. Code quality is subjective, so this half must measure carefully, show its uncertainty, and never change routing on its own.

Today only OpenCode team members are measured. Claude Code and Codex are "unmeasured". Repository briefings run on Muse and DeepSeek outside the ledger. Nothing rolls up per task, per project, or per day. The web client shows text totals with no charts, the phone and Mac apps show nothing, and no balance is read.

## Goals

1. Every metered agent session the host runs records token usage and cost: OpenCode sessions (DeepSeek, Meta Muse, and any other metered model) and repository briefings that run on the host.
2. **Spent** is metered money that actually left an account. The owner pays DeepSeek and Meta through their own API keys. Claude and Codex are subscriptions paid upfront: they appear only as a fixed monthly plan fee, and their per-use API value is not computed.
3. Usage rolls up to session, task, team run, goal, and project, and into a daily series.
4. Account balances:
   - DeepSeek's live balance comes from its API.
   - Every other account shows "—" for balance. A balance is shown only when it comes directly from the provider's official API; it is never estimated.
   - Claude and Codex show their plan's fixed monthly fee.
5. One cost view with the same information design on web, mobile, the Mac app, and the CLI. The owner asked that it look beautiful and use few words, carrying the information in figures and charts rather than prose.
6. Per-model effectiveness evidence per role, answering whether DeepSeek, Meta, and other metered subagents are worth their tokens and dollars. It combines objective outcomes with a structured, versioned quality rubric and the owner's own ratings.
7. Later, advisory routing suggestions built from that evidence, which the owner explicitly accepts or ignores.

## Non-goals

- Hard spend limits, automatic pausing, or spend push alerts. Budgets stay informational, as in the previous design.
- Allocating subscription fees across tasks, or computing an API-price value for subscription use. A plan fee is a fixed monthly line.
- Capturing Claude Code or Codex token usage. They remain unmeasured.
- Reading balances through admin keys, such as the Anthropic and OpenAI organization cost APIs. The owner uses subscriptions there.
- Estimated balances of any kind.
- Measuring work that runs off the host, such as laptop sessions or Jevcode briefings fired by laptop Stop hooks. The ledger is per host. Off-host spend is out of scope, and the overview says that totals cover this host only.
- Automatic lineup changes. The host never edits routing configuration.

## Anti-goals

These would make the feature a failure even if it works:

- **A number that looks exact but isn't.** Every figure carries its source: configured price, reported by OpenCode, or unmeasured. A total that excludes unmeasured sessions shows how many it excludes, as the previous design requires.
- **A quality score that looks more certain than it is.** Comparisons hide below a minimum sample size and always show n.
- **Agents gaming the score.** Scores and rubrics are never fed into implementer prompts, and a model never grades its own work.
- **Credentials leaving the host.** Provider keys stay in the host environment. Clients receive balances, never keys. Nothing private enters tracked files (`AGENTS.md`).
- **Wordy screens.** Labels are short; a legend or a tap-for-detail replaces sentences.

## Part 1: capture everything

Extend the existing `usage` journal event and `UsageService` ledger. Do not create a second store.

| Source | Where usage comes from | `modelSource` |
|---|---|---|
| OpenCode (team, local UI) | Unchanged: `step_finish` / `message.part.updated` | as today |
| Repository briefings | The briefing runtime's runner output, if it exposes OpenCode usage. Otherwise these sessions count as unmeasured under a `briefings` bucket. | as available |

Confirm every field name and file location against the installed binaries before trusting a parser, the same way the previous design did. The builder records what was confirmed in this document. If a source cannot be confirmed, it stays unmeasured; it is never guessed.

Each usage record gains a `provider` value for its true origin (`claude`, `codex`, `opencode`). For OpenCode records, the provider/model id pair (`deepseek/…`, `meta/…`) also maps to a billing account (Part 3).

## Part 2: attribution and daily series

The ledger already stores session → provider, project, team, and profile. Add `taskId`, `goalId`, and `role` to the ledger's session header at capture time. The team member already knows its `taskId` and role, and the goal knows its cycles. Briefing sessions are attributed to their project with `role: "briefing"`.

Roll-ups:

- **Task:** the sum over every member that worked on the task, including replacements after a stall, a limit switch, or an escalation. It also counts attempts.
- **Goal:** the sum over its cycles (the existing behaviour), plus a per-task breakdown.
- **Project:** everything attributed to the project: goals, ad-hoc team runs, interactive sessions, and briefings, broken down by those four kinds.
- **Daily:** per-day buckets of Spent, stacked by account. Days are bucketed in the timezone the client passes (`?tz=` with an IANA name); the host default is UTC. *(My call: clients send the device timezone, so the graph matches the owner's day.)*

### API

All routes are read-only:

- `GET /api/usage`: extended with accounts (Part 3), the current month's Spent, and the previous month's.
- `GET /api/usage/daily?days=30&tz=…&project=…`
- `GET /api/usage/projects`: accrued cost per project, with a 30-day sparkline series.
- `GET /api/usage/projects/:id`: goals, runs, briefings, and sessions, with cost.
- Goal and team views gain `usage` per task.

## Part 3: pricing and accounts

### Prices

Ship a dated built-in price catalog in the host, with list prices for the DeepSeek, Meta Muse, Claude, and OpenAI models the lineup uses. Each entry records its source URL and an "as of" date. Configured `usage.prices` still override the catalog, and OpenCode's reported cost is the last fallback.

DeepSeek bills peak hours at double rate, so a price entry may carry UTC time windows with their own rates, and each record is priced at its `completedAt`. Muse Contributor variants are distinct model ids with their own prices. *(My call: a built-in catalog instead of config-only, because the owner shouldn't have to hand-maintain prices to see dollars; the "as of" date keeps it honest.)*

### Accounts

These go in the private host config:

```json
{
  "usage": {
    "accounts": {
      "deepseek": { "kind": "metered", "match": ["deepseek/*"], "balance": { "source": "deepseek", "apiKeyEnv": "DEEPSEEK_API_KEY" } },
      "meta":     { "kind": "metered", "match": ["meta/*"] },
      "claude":   { "kind": "subscription", "match": ["claude/*"], "planUsd": 200 },
      "codex":    { "kind": "subscription", "match": ["codex/*"], "planUsd": 200 }
    }
  }
}
```

- **DeepSeek:** the host calls `GET https://api.deepseek.com/user/balance` with the key named by `apiKeyEnv`. It does this at most every 15 minutes, plus when a client asks for a refresh. It caches the result with its fetch time, and shows the balance with "as of" and the currency DeepSeek returns. On an error it keeps the last value and marks it stale.
- **Meta:** the Muse API documents no balance endpoint, so the balance shows "—". Spend is still shown.
- **Claude and Codex:** the plan fee is a fixed monthly line, because it is real money. No per-use dollars.

## Part 4: surfaces

The same three levels everywhere. Follow `DESIGN.md`, and use the `impeccable` design skill while building.

1. **Overview.** One large figure for this month's metered Spent, with the change from last month. Plan fees are not in that figure, the daily bars, or the change; they sit on their own account cards as a fixed monthly line, and a small "with plans" total sits beside the headline. *(My call: fees would hide the movement that matters.)* Below it, a 30-day bar chart stacked by account; tapping a bar shows that day. Then a row of account cards: balance or plan, a small trend, and "as of".
2. **Projects.** A list ranked by accrued cost, each with a 30-day sparkline. Opening a project shows its goals, team runs, briefings, and sessions, each with cost.
3. **Goal and task.** A goal's total, then one row per task: cost, tokens, attempts, and a model chip. Tapping a task shows its attempts.

Source markers are one consistent visual: a solid figure for a configured price, a dotted mark for a cost reported by OpenCode, and a small "n unmeasured" badge. Each is explained once in a legend and nowhere else.

Platform choices *(my calls)*:

- **Web** (`apps/web`): a new Cost page with hand-built SVG charts, adding no chart dependency. It replaces the text-only `SpendBlock`.
- **Mobile** (`apps/mobile`): a Cost screen reachable from the main list, using `react-native-svg` for charts. Goal and team screens gain per-task cost.
- **Mac** (`apps/macos`): a Cost view using Swift Charts.
- **CLI:**
  - `infinite usage` prints the overview: month totals, a 30-day Unicode bar chart, and account balances.
  - `infinite usage projects`, `infinite usage project <id>`, and `infinite usage goal <id>` print the deeper levels.
  - `--json` prints raw output on every command.

## Part 5: agent effectiveness

### Unit of evidence

One **task attempt**: a member working a task, with its model profile, role, and lineup tier. Coordinator, reviewer, and briefing work are evaluated per role, never compared with implementer work.

### Objective signals

The host records these, with no judgement involved:

- **Outcome:** integrated, blocked, escalated away, stalled, or limit-switched.
- **Rework:** the number of review rounds before approval, and the delivery repairs attributed to the task.
- **Wall time:** start to report, and start to integration.
- **Cost:** tokens and Spent dollars, for metered profiles. Subscription profiles show "—".
- **Checks:** results of the run's checks.
- **Change shape:** lines added and removed, and whether tests and docs were changed (paths under `docs/`, `*.md`, and test files).

### Subjective signals

These are recorded as claims, with their author:

- **Reviewer rubric.** The reviewer's report gains an optional per-task rubric: correctness, cleanliness, ease of extension, and documentation. Each is scored 1 to 5 with a one-line justification citing files. The rubric has a version, and scores from different versions are never averaged together. The reviewer must not be the same model as the implementer it scores. If the lineup makes them the same, the score is dropped.
- **Owner rating.** The owner can rate any task or goal, 1 to 5 with an optional note, from any client. How it combines with the rubric is set under Counting rules.

### Counting rules *(my calls)*

- The unit is the attempt, not the task id. Task ids are run-local slugs, so no cross-run task identity is needed.
- An attempt ended by a provider limit switch is excluded from the denominator. That is an account event, not model quality. A stall or an escalation away counts as not integrated.
- Cost columns cover metered profiles only. Subscription profiles stay in the scorecard with outcomes and quality, as the baseline that metered models are compared against, and show "—" for tokens and cost.
- The owner rating is a separate overall score shown beside the rubric. It does not override individual rubric dimensions. Where the two disagree, the owner's score wins in suggestions. Goal-level ratings stay on the goal and do not feed the per-model scorecard, because a goal spans many models.

### Scorecard

Per model profile and role:

- integrated rate
- median cost and tokens per integrated task, plus cost per million tokens
- median time
- mean review rounds
- mean rubric scores

Every figure shows n, and an interval when n allows one. Below 10 attempts the scorecard shows "not enough data" rather than a ranking. It is available in the API, in the clients as a "Models" tab inside the cost view, and in the CLI as `infinite usage models`.

### Routing suggestions (later phase)

Once a profile pair has enough attempts in the same role, the host may phrase a suggestion. For example: "Luna integrated 31/34 implementer tasks at a median $0.42; Haiku 29/33 at $0.61 (rubric 4.1 vs 4.0)."

Suggestions are advisory text with their evidence and n. The owner acts on one by editing the private lineup. The host never changes routing, and scores never enter agent prompts. The scorecard is exportable as JSON, so the owner's own routing tooling outside this repository can read it.

## Delivery order

Each phase is its own Linear issue and its own PR, and each is useful on its own:

1. **Capture and attribution:** Parts 1 and 2, plus the CLI overview. This makes everything else possible.
2. **Prices and accounts:** Part 3.
3. **Cost UI:** web first, then mobile, then the Mac app (Part 4).
4. **Effectiveness:** objective signals, then the rubric and owner ratings, then the scorecard.
5. **Routing suggestions:** only after phase 4 has gathered real attempts.

## Left to the builder

- Parser details and the confirmation evidence for each capture source.
- Ledger schema migration. Re-deriving the ledger from journals is acceptable, since the ledger is rebuildable by design.
- Chart rendering details within the design rules above.
- Interval method for the scorecard. A Wilson interval on rates and a bootstrap or plain IQR on medians are both fine; label whichever is used.
