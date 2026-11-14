# Evidence router (INF-186, INF-187)

Date: 2026-11-12. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`.

## Intent

Today a model picks each task's worker from a prompt, and nothing measures whether the pick was right. The owner wants the host to choose from recorded outcomes, to keep testing profiles that look worse today, and to stop sending a light profile to work it usually fails.

This design adds a router inside the host. It chooses among profiles the owner already approved and spends a bounded share of real work on exploration. It also learns when a strong start costs less than a light start plus a rescue. That part is the learned cascade.

## Current state

Read in `packages/host/src` on `main`:

- **The coordinator chooses.** `teamPrompt` (`team-prompts.ts`) tells the project manager to name an `agentProfileId` from the implementer pool for every task. `taskProfiles` (`teams.ts`) checks only pool membership, and `memberProfile` resolves the profile.
- **The worker chooses its escalation target.** An `escalate` report names a profile from `lineup.escalations`, once per task.
- **Replacements do not choose.** A replacement after a stall or an answered question keeps the previous profile. A provider limit follows the configured `limitFallback` chain.
- **A run pins its lineup.** A standalone run copies `config.teams.lineup`. A goal or mission run receives the lineup its goal or mission pinned earlier (`createForGoal`, `createForMission`). No lineup is set per project.
- **Same-model review is allowed.** `consume` records a review even when the reviewer's model equals the implementer's. It only drops that task's rubric.
- **Evidence is display-only.** Nothing in `TeamService` reads `scorecard.ts`. The 2026-10-19 cost and effectiveness design says the host never changes routing.
- **Delegation has a precedent.** The permission policy lives in the project team configuration. `infinite repo init` saves it through `PUT /api/projects/:id/team` (owner role, paired owner CLI). `createRun` pins it, and `revokePermissions` withdraws it for one run.
- **`dataUse` is a label.** No code enforces a data-use policy per project.

## Goals

1. The host chooses the profile for the first implementer of a task, for an escalation, and for a scout.
2. A bounded share of work goes to profiles that are not the current best.
3. Owner-set knobs trade success against list price and provider-limit headroom.
4. A task starts on a strong profile where a light start is expected to lose.
5. Every decision is recorded, explainable, and repeatable.
6. In a `supervised` project `off` stays the default, and `shadow` lets the owner watch before delegating. In an `autonomous` project (C12) the router starts in `shadow` and moves to `auto` at `start` after a shadow period (decided 2026-11-13).

## Non-goals

- Routing any role other than implementer and scout.
- Editing the lineup, a pool, or a `limitFallback` chain.
- A learned model over task text.
- Runs without a lineup.

## Anti-goals

- **A router that looks certain.** Status shows n, an interval, the pooling level, and every default in use.
- **Routing data in front of a member.** No prompt, context file, or tool result carries a posterior, a reward, or a routing decision.
- **A reward that pleases the reviewer.** An escaped defect erases a first-pass acceptance.

## Approaches

**A. Show the scorecard to the coordinator.** Scores enter a prompt, the choice is unrepeatable, and the evidence stays confounded, because the coordinator sends hard tasks to profiles it already trusts.

**B. Owner-edited rules.** This is the 2026-10-19 plan: the host prints suggestions and the owner edits the lineup. Nothing explores, so a profile without evidence never earns any.

**C. A host-side bandit under owner delegation.** The host samples from a posterior per profile, picks by utility, bounds exploration, and records the decision. It needs a delegation and new state. It gives randomized evidence and a repeatable choice.

The design picks C. B stays available as `off`, and `shadow` bridges the two. A model over task text was rejected for now, because the data is too thin.

## Design

### Part 1: Policy, delegation, and the pin

The routing policy sits in the project team configuration, beside `permissions`:

```ts
const teamRoutingSchema = z.object({                                     // read default:
  mode: z.enum(["off", "shadow", "auto"]).optional(),                       // "off"
  points: z.array(z.enum(["start", "escalation", "scout"])).min(1).optional(), // ["start"]
  cascade: z.boolean().optional(),                                          // false
  successValueUsd: z.number().min(0).max(100).optional(),                   // 2
  maxExploreShare: z.number().min(0).max(0.5).optional(),                   // 0.2
  exploreWindow: z.number().int().min(10).max(500).optional(),              // 50
  minSpareAttempts: z.number().int().min(0).max(20).optional(),             // 4
  allowContributor: z.boolean().optional(),                                 // false
  listWeight: z.number().min(0).max(1).optional(),                          // 0.25
  headroomWeight: z.number().min(0).max(4).optional(),                      // 1
}).strict();
```

The routine digest hashes the project team configuration, so no key has a schema default. The code applies each default at read, and parsing never writes a key (umbrella C11).

- `off`: today's behaviour. The router writes nothing.
- `shadow`: the coordinator and the worker choose as today. The router records what it would have chosen.
- `auto`: the router chooses at the listed points.

**Autonomous default (decided 2026-11-13).** An `autonomous` project (C12) without a saved policy uses `shadow` until its shadow period ends, then `auto` with points `["start"]`, `cascade` on, and `maxExploreShare` 0.2. *(My call: the shadow period ends after 14 days and 50 recorded `start` decisions, whichever is later.)* The end of the period is a host-held fact in the evidence store, like an exploration pause, so it leaves a routine's approval digest unchanged. Leaving the project `autonomous` is the owner's delegation.

`infinite repo init` saves the policy through that owner-only route. `createRun` pins a copy as `run.routing`, as it pins `permissions`, so a later change affects new runs only. It refuses with `routing-no-eligible-profile` when `start` is listed and no candidate passes the fixed rules of Part 5.

`revokeRouting` sets `run.routingRevokedAt`. After that, the run uses the coordinator's `agentProfileId` where the plan has one, and the default profile otherwise. The fixed rules still bind it. The **default profile** of a decision point is its first candidate in lineup order that passes the fixed rules.

The routing policy is inside the digest that a routine approval pins (umbrella C11), so a policy change blocks an active routine until the owner approves it again. An exploration pause lives in the evidence store instead. It only makes routing more conservative, so it leaves a routine's approval alone.

### Part 2: Decision points

| Point | When | Candidates | Rule |
|---|---|---|---|
| `start` | `prepareMember` starts the first implementer of an assignment | `lineup.implementers`, plus `lineup.escalations` when `cascade` is on | utility. Only this point explores |
| `escalation` | the host accepts an `escalate` report | `lineup.escalations` without the member's own profile | utility, always greedy |
| `scout` | `prepareMember` starts a scout | light profiles in `lineup.implementers` | lowest expected cost |

The scout rule is cost only. The outcome ledger records that a scout completed, which says nothing about the quality of its findings. *(My call, until a design measures read-only work.)*

Replacements stay as they are, so an assignment has at most one `start` decision and one `escalation` decision. The ordinal in the decision key is therefore 1 today.

### Part 3: Reward (`rewardVersion: 1`)

The router reads outcome rows whose source is `production` or `duel`, once the ledger has frozen them. A row that ended without integration counts as soon as its attempt ends. The router never reads `legacy` rows, and it skips rows with an exclusion. It needs rows, not cell totals, because the reward joins several levels of one attempt.

The reward `r` of one attempt is the first matching line:

| Row | r |
|---|---|
| It ended without integration (a stall, or an escalation away), or `accepted` is no | 0 |
| `accepted` is unknown. A row flagged `same-model-review` is in this line | no observation |
| `held` is no | 0 |
| The owner rated the task | (score − 1) / 4 |
| `firstPass` is yes | 1 |
| Anything else | 0.5 |

**Provisional and final.** While `held` is unknown, the last three lines have weight 0.5. When the hold window closes, the row counts at weight 1 with its final reward. So first-pass acceptance counts early at half strength, and `held` has the last word.

A reward enters a Beta posterior as `w·r` successes and `w·(1 − r)` failures. Two more weights multiply `w`:

- **Time.** The weight halves every 30 days. A row older than 180 days is ignored.
- **Who chose.** A row whose member matches an applied `auto` decision has weight 1. Any other row has weight 0.5. *(My call: a coordinator gives harder tasks to the profiles it trusts, so its history is confounded.)*

**Rescue estimate.** A first-pass result that the owner rated 3 has reward 0.5 and needed no rescue, so the reward cannot price a rescue. `φ` is a second estimate: the posterior mean of `firstPass` over the same rows, weights, levels, and labelled priors (Part 4). An observation is 1 when `firstPass` is yes, and 0 when it is no or the attempt ended without integration. It has no provisional weight.

**Duel rows.** A duel winner is integrated and reviewed like any attempt, so its row uses the table. A loser that failed the duel's objective gate has reward 0. Any other loser carries an exclusion and gives no observation. Counted duel results form the lead that the duels design defines, and Part 5 uses the lead only to break a near tie. A winner's row slightly overstates its profile, because it is the better of two attempts.

**Replay** gives a prior, never an observation.

### Part 4: Posterior

Evidence is keyed by profile identity and profile epoch, never by profile ID, because configuration can point an ID at another model.

**Observed rows.** At every level a row must match the profile identity, its current profile epoch, the current prompt version for the role, the role, and the decision point. A row is at `escalation` when its attempt replaced a member that escalated, and at `start` otherwise. The points never share a level, because only tasks that already defeated a light profile reach escalation. A parent never holds its child's rows:

| Level | Scope |
|---|---|
| cell | the task's project, area, and kind or no kind, under the task's `featureVersion` and `featureMap` |
| project | the task's project, without the cell's rows |
| tenant | the tenant's other projects, numeric rows only (contract C9 rule 9) |

**Levels.** A child takes its parent's mean as its prior mean, with a strength of at most 20:

```
tenant:  Beta(1 + P_t + S_t,        1 + Q_t + F_t)
project: Beta(k_p·μ_t + P_p + S_p,  k_p·(1 − μ_t) + Q_p + F_p)    k_p = min(20, mass_t)
cell:    Beta(k_c·μ_p + P_c + S_c,  k_c·(1 − μ_p) + Q_c + F_c)    k_c = min(20, mass_p)
```

`S` and `F` are a level's weighted observed successes and failures. `P` and `Q` are its labelled priors. `μ` is a posterior mean. `mass` is the sum of a level's two parameters, its inherited prior included. It is never below 2, so with no rows anywhere every level is `Beta(1, 1)`.

**Labelled priors.** Evidence that is not an observed row enters only as a prior with a capped mass. Status shows each one under its own label, apart from observed counts.

- **Earlier evidence.** At each level, the rows that fail only the current profile epoch or the current prompt version are scaled to a mass of at most 10. A new profile identity has none. The owner declares a new profile epoch with the outcome ledger design's command. *(My call: prompts change often. A full reset discards evidence, and no reset trusts numbers measured under another prompt.)*
- **Replay.** It enters `start` cells only, and only as an adopted Class A routing prior (C15, delegated adoption design Part 8). An export is compatible when it has the cell's project, role, and area, the profile's identity and profile epoch, the current implementer prompt version, and the cell's kind or no kind. Per prompt origin, the newest compatible export replaces every older one. The router pools the rest by task count and adds the pooled resolved share with a mass of `min(10, total tasks)`, across all prompt origins.

**Sample size.** About 93 attempts per profile separate a 50% success rate from a 70% one at 80% power. A cell with four profiles needs about 370. Cells therefore lean on the project and tenant levels for a long time. The status view names the level behind each number.

### Part 5: The choice

**Eligibility.** Two fixed rules follow from the pinned lineup and policy. A candidate fails when:

1. it has `dataUse: "contributor"` and the policy does not set `allowContributor`, or
2. its model equals the model of `lineup.reviewer`, at every point (contract C9 rule 4).

A third rule changes with time: the candidate's provider is in `ProviderLimits.limited()`.

In a run that delivers by `merge`, at `start` and `escalation`, the router also leaves out a candidate whose model family is `unknown`, and, when the lineup has no `crossReviewer`, one whose family equals the reviewer's, while another candidate remains (C19, delegated adoption design Part 7).

A run **covers** a listed point when a candidate passes the fixed rules. `createRun` refuses a run that cannot cover `start`. At an uncovered `escalation` or `scout` point the router makes no choice. The host follows today's path: the worker or the coordinator names the profile, and the host refuses one that fails rule 1 as it refuses one outside the pool. *(My call for `scout`.)* If that puts an implementer on the reviewer's model, `consume` drops the rubric as today, and the outcome ledger flags the row `same-model-review`.

**Fallbacks.** In an `auto` run the fixed rules also bind every limit fallback of an implementer or a scout. `resolveLimitFallback` skips a target that fails one, as it skips a limited provider. With no target left, the fallback counts as not configured, and Failure modes says what follows. A stall or answered-question replacement keeps a profile that already passed.

**Utility.** For candidate `a`, `θ` is its expected reward and `φ` is its rescue estimate:

```
U(a) = V·θ − λ·(c(a) + (1 − φ)·R) − V·η·p(a)
c(a) = expected listUsd of one attempt
```

`V` is `successValueUsd`, the main owner knob, with presets `cost` (0.5), `balanced` (2), and `quality` (8). An elevated-risk task uses `3·V`. `R` is the rescue cost: the mean extra `listUsd` an assignment spent after a first attempt that was not first-pass. `listUsd` is a routing weight at low weight, and provider-limit headroom weighs more (decided 2026-11-13). `λ` is `listWeight`, `η` is `headroomWeight`, and `p(a)` is the limit pressure of the candidate's provider. The delegated adoption design (Part 8) defines headroom, pressure, and what the router does when a limit is near. They replace the earlier `limitRate · limitPenaltyUsd` term. Cost and `R` come from the ledger at the most specific level with five or more attempts that have complete cost coverage, and from marked per-tier defaults below that.

**The greedy profile** maximizes `U` with `θ` at its posterior mean. An elevated-risk task uses the mean minus one posterior standard deviation. `φ` always enters at its mean. Ties resolve in lineup order. When the top two utilities differ by less than $0.10 and one profile has a weighted duel lead of five or more over the other, that profile is greedy.

**The sample.** At `start`, the router draws one `θ` per candidate and picks the highest `U`. The seed is the SHA-256 of the policy digest, `runId`, `revision`, `task_key`, the point, the ordinal, and the profile identity. `escalation` and `scout` draw no sample and take the greedy profile.

**Exploration guards.** A `start` decision is exploratory when the sampled pick differs from the greedy profile. The router uses the greedy profile when:

- the task's risk is `elevated`,
- exploration is paused for the project,
- the sampled profile's provider is near its limit (delegated adoption design Part 8),
- the exploratory share of the project's last `exploreWindow` `start` decisions would exceed `maxExploreShare`. A decision counts from the moment its row is written until the row is released (Part 7), or
- the run has fewer spare attempts than `minSpareAttempts`. Spare attempts are the limit in `assertBudget`, minus the run's members so far, minus one per unfinished task, minus three for the integrator, the reviewer, and delivery.

**Determinism.** The decision row is the record. The router looks for the row by key first and reuses it, so a host restart between decision and launch repeats the choice. The seed makes the draw checkable from the recorded posteriors.

### Part 6: Learned cascade

The cascade is the same utility with a wider candidate set. With `cascade` on, the escalation pool joins the `start` candidates. A strong profile `S` beats a light profile `L` at the start when:

```
V·(θ_S − θ_L) + λ·R·(φ_S − φ_L) > λ·(c(S) − c(L)) + V·η·(p(S) − p(L))
```

The left side is what the higher reward and the lower rescue risk are worth. The right side is the weighted extra price of the strong attempt, plus its extra limit pressure.

A strong profile has little `start` evidence at first, because it has only received escalated tasks. Until exploration adds rows, its `start` posterior comes from the tenant level and the labelled priors.

A task that starts strong keeps its one escalation. The cascade has its own opt-in because it changes how often strong quota is spent.

### Part 7: Decision record

```sql
CREATE TABLE routing_decisions (
  key TEXT PRIMARY KEY,   -- sha256(runId|revision|task_key|point|ordinal)
  run_id TEXT NOT NULL, revision INTEGER NOT NULL, task_key TEXT NOT NULL,
  point TEXT NOT NULL, ordinal INTEGER NOT NULL,
  project_ref TEXT NOT NULL, role TEXT NOT NULL,
  area_ref TEXT, kind TEXT, risk TEXT NOT NULL, feature_version INTEGER NOT NULL,
  mode TEXT NOT NULL,     -- shadow | auto
  algorithm_version INTEGER NOT NULL, reward_version INTEGER NOT NULL,
  policy_digest TEXT NOT NULL, seed TEXT NOT NULL, basis TEXT NOT NULL,
  chosen_profile_id TEXT NOT NULL, chosen_identity TEXT NOT NULL,
  greedy_profile_id TEXT NOT NULL,
  coordinator_profile_id TEXT,   -- the plan's or the worker's own pick, when present
  explore INTEGER NOT NULL,
  state TEXT NOT NULL,    -- pending | applied | released | recorded
  member_id TEXT,
  decided_at TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL
);
```

`project_ref`, `area_ref`, and `task_key` are the evidence store's blind indexes. `basis` is `sampled`, `greedy-risk`, `greedy-share`, `greedy-budget`, `greedy-paused`, `greedy-headroom`, `greedy-point`, `single-candidate`, or `default-all-limited`. The encrypted payload holds the clear project, area, task ID, and `featureMap`, and per candidate the rule that removed it, the posterior parameters and labelled priors at each level, n by source, the rescue estimate, the sample, the cost, and the utility.

**Routing policy version.** `policy_digest` is the digest of `algorithm_version` and the pinned `run.routing`. It is the routing policy version of contract C7, so one changed parameter gives a new version. The improvement gate does not test routing parameters, because a replay trial fixes its profile. The owner compares two policies in `shadow` mode.

**Writes.** In `auto` mode the host writes the row as `pending` before it creates the member. It becomes `applied`, with `member_id`, when `member.started` arrives for that attempt with the same profile. It becomes `released` when the launch fails: preparation fails, the run halts first, or the member starts on a limit fallback. A startup pass releases a `pending` row of a settled run. A `shadow` row is `recorded` and never changes. The exploration share counts `pending` and `applied` rows, and the who-chose weight uses `applied` rows. A row holds no run text, so it outlives the run record.

The run record gains `task.routing = { decisionKey, profileId, mode }`. The host passes the chosen profile to `newMember` through its existing `pinnedProfile` parameter. `agentProfileId` keeps the coordinator's value.

**Dry run.** The router also answers what a given policy would choose for given task features, without writing a row. The status view and tests use it.

**Order probability.** The router exports a pure function, `orderProbability(decision, a, b)`. It returns the probability that `b`'s utility exceeds `a`'s, from the posterior parameters, rescue estimates, and costs in the decision row, with 2,000 draws seeded from the decision key. The duels design uses it to choose a challenger.

### Part 8: Plan schema and prompts

In `off` and `shadow` mode, schemas and prompts do not change. In `auto` mode, for each point the run covers:

- **`start`.** `taskProfiles` accepts a plan task without `agentProfileId`. If the coordinator sends one, the host validates it and records it as `coordinator_profile_id`. `teamPrompt` replaces the worker pool paragraph and the `agentProfileId` example with: "The host assigns each task's worker profile. Do not name profiles."
- **`scout`.** `teamScoutPlanSchema.agentProfileId` becomes optional, and the explore example drops it.
- **`escalation`.** The `escalate` report's `agentProfileId` becomes optional. The implementer prompt drops the pool listing and says that the host selects the stronger profile.

**Nothing about routing reaches a member** (contract C9 rule 3). `teamPrompt` removes `routing` from the inline task of an implementer and of a scout, as it removes `rubric` and `ownerRating` for an implementer today. `teamContext` copies whole tasks into every member's context file. It removes `routing` from each, for every role: the run's tasks, the discovery tasks, and the tasks inside each continuation.

### Part 9: Owner surface

**CLI**

- `infinite repo init --routing off|shadow|auto [--routing-points LIST] [--routing-cascade on|off] [--routing-value PRESET|USD] [--routing-contributor allow|deny]`
- `infinite routing status [PROJECT] [--json]`: per cell and profile, the observed n by source, each labelled prior with its mass, the posterior mean, 90% interval, rescue estimate, pooling level, expected cost, and greedy mark, plus the mode, exploratory share, pause state, and shadow agreement rate.
- `infinite routing explain RUN_ID TASK_ID`: one decision, decoded.
- `infinite routing pause-explore PROJECT` and `resume-explore PROJECT`.
- `infinite team revoke-routing RUN_ID --revision N`.

**API.** `GET /api/routing/projects/:id` and `GET /api/teams/:id/routing/:taskId` serve the owner, controller, and viewer roles. The pause, resume, and revoke routes need the owner role. `PUT /api/projects/:id/team` carries `routing` under its existing guard.

**MCP.** None. No member tool reads or writes routing state.

**Shadow evaluation.** Status reports how often the router's pick equals the coordinator's, per cell. It makes no claim about what the router's pick would have achieved.

### Worked example

Policy: `V = 2.00`, `R = 1.50`, normal risk, cascade on. The example uses `listWeight` 1 and no limit pressure, so cost counts at full price.

| Profile | Reward posterior | Mean θ | φ | Cost |
|---|---|---|---|---|
| light-a | Beta(12, 12) | 0.50 | 0.60 | $0.40 |
| light-b | Beta(4, 2) | 0.67 | 0.70 | $0.30 |
| strong-s | Beta(9, 2) | 0.82 | 0.90 | $2.20 |

Greedy utilities: light-a `1.00 − 0.40 − 0.60 = 0.00`, light-b `1.33 − 0.30 − 0.45 = 0.58`, strong-s `1.64 − 2.20 − 0.15 = −0.71`. The greedy profile is light-b.

One draw gives `θ` of 0.72, 0.44, and 0.86, with utilities 0.44, 0.13, and −0.63. The sample picks light-a, not the greedy profile. The router starts light-a with `explore` set when every guard passes, and light-b otherwise.

Cascade check against light-b: `2.00 · 0.15 + 1.50 · 0.20 = 0.60`, below the price gap of $1.90, so the task starts light. Against a light profile with `θ` of 0.20 and `φ` of 0.20, `2.00 · 0.62 + 1.50 · 0.70 = 2.29` exceeds the gap, so the task starts strong.

## Authority and safety

- **Delegation.** The host routes only under a pinned, recorded policy: the owner's, or the `autonomous` default that the owner's mode delegates (C12). This design amends one sentence of the 2026-10-19 design: "The host never changes routing". That stays true in `off` and `shadow`. In `auto` the host chooses among approved profiles and still never edits the lineup.
- **Fixed limits.** The router adds no profile, attempt, escalation, or limit fallback target. It changes no permission, scope, budget, review requirement, or delivery policy.
- **Review independence.** The router never chooses the reviewer's model. Today's path, or a reviewer on its own limit fallback, can still produce a same-model review, and the ledger flag keeps that acceptance out of every decision.
- **Data use.** In an `auto` run a contributor profile starts an implementer or a scout only with `allowContributor`. *(My call: no lineup is set per project, so the lineup cannot keep one repository away from a contributor profile.)*
- **Honesty.** A decision records a choice, never that work is complete. An unknown cost shows as a default, never as zero.

## Failure modes

| Situation | Behaviour |
|---|---|
| No evidence at any level | Every level is `Beta(1, 1)`. Utilities differ only by cost, and ties resolve in lineup order. Exploration inside its guards brings the first evidence. |
| The evidence store is unavailable, or a decision takes longer than 250 ms | The host starts the default profile, writes no row, and adds a line to the run's events. The run is not blocked. |
| Every candidate's provider is limited | The router returns the default profile with basis `default-all-limited`. `newMember` then applies the limit fallback under the fixed rules. |
| A limit fallback has no target that passes the fixed rules | Today's code decides. At launch, `newMember` starts the selected profile, because the limit may have lifted. At a limit during work, `switchLimitedMember` blocks the run with `provider-limit`. |
| The launch fails, or the member starts on a limit fallback | The row is released and counts nowhere. |
| A provider changes a model behind an unchanged name | Time decay limits the damage, and the owner can declare a new profile epoch. |

## Delivery order

Each phase is its own pull request and is useful alone.

1. **Shadow recorder.** The policy schema, the pin, the posterior, `routing_decisions`, `shadow` rows at `start`, `routing status`, and `routing explain`. It shows what the router would do at no risk.
2. **`auto` at `start`.** The plan schema and prompt change, the context removal, the fixed rules on fallbacks, the exploration guards, the pause, and `revoke-routing`. Candidates are the implementer pool only.
3. **Replay prior and dry run.** Needs the replay eval design.
4. **Escalation target and scout rule.**
5. **Learned cascade.**
6. **Status in the web, phone, and Mac clients.**

## Acceptance

1. In `off` mode, prompts and plan validation are byte-identical to today, and no row is written.
2. In `shadow` mode, each first implementer start writes one row with both picks, and the member runs on the coordinator's profile.
3. In `auto` mode, a plan without `agentProfileId` is accepted, and the member's `modelProfile` equals the row's chosen profile.
4. No generated prompt or context file, for any role, contains the `routing` field, a decision key, a posterior, a reward, or a utility.
5. The same key and store state give the same choice. A restart between decision and launch reuses the row.
6. Over 1,000 seeds, no `start` decision is exploratory for an elevated-risk task, in a run below `minSpareAttempts`, or during a pause, and no `escalation` or `scout` decision is exploratory. The exploratory share, pending rows included, stays within `maxExploreShare`, and a released row frees its place.
7. In an `auto` run, no implementer or scout starts on a contributor profile without `allowContributor`, by choice, limit fallback, or replacement. The router never chooses the reviewer's model, and no limit fallback lands on it.
8. When every escalation profile has the reviewer's model, the run keeps today's escalation prompt and report schema.
9. Adding or removing `legacy` rows changes no decision.
10. With `cascade` off, no escalation-pool profile starts a task. With it on, a fixture that satisfies the Part 6 inequality at the posterior mean starts strong.
11. A first-pass row adds 0.5 success mass while `held` is unknown, and 1 failure mass after an escaped defect. A first-pass row rated 3 has reward 0.5 and a `firstPass` observation of 1.
12. With no rows, every level is `Beta(1, 1)`. A cell never counts a row of the other decision point or of another `featureMap`.
13. After a new prompt version or profile epoch, the old rows count only as earlier evidence, with a mass of at most 10 and their own label in status.
14. Two replay exports of one prompt origin give the newer one's mass alone. Three origins with 30 tasks in total give a mass of 10.
15. With the store closed, a task starts on the default profile and the run continues.
16. A pause leaves a routine's approval digest unchanged. A mode change alters it.

## Owner decisions

1. **Decided 2026-11-13:** `auto` at `start` for every enrolled project in `autonomous` mode, after a shadow period. Value to confirm: the period of 14 days and 50 recorded `start` decisions (Part 1).
2. **Decided 2026-11-13:** the cascade is allowed, and it is on in the autonomous default.
3. The value preset and the exploration share. **Decided 2026-11-13:** the exploration share is 20%. Still open: the value preset, proposed `balanced`.
4. Whether contributor profiles are eligible, per project.
5. Whether coordinator-chosen history counts at half weight or not at all.

## Left to the builder

- The seeded Beta sampler and its generator.
- Whether posteriors are computed on read or cached, and the indexes.
- The interval method in the status view. Label the one used.
- Per-tier default costs and the default rescue cost, until the ledger has measured values.
- The exact field names the router reads from outcome rows and duel records. Those designs own them.
- CLI text layout and the client status views.
