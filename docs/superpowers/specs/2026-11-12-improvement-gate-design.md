# Improvement gate (INF-189)

Date: 2026-11-12. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`.

## Intent

The team system changes itself through text: prompt templates, repository guidance, and learned lessons. Today a change is adopted because a reviewer liked it. Nothing measures whether it helped, and nothing notices when it hurt.

The improvement gate measures a change before anyone proposes it for adoption. It compares the change with the current configuration on the repository's own eval tasks and writes a receipt. After adoption it watches production outcomes and reports a regression.

## Current state

Observed on `main`:

- Prompt templates are code. `packages/host/src/team-prompts.ts` holds constants such as `assignmentBriefInstructions`, and `teamPrompt` builds each role's instructions inline. A change needs a host release. The sealed run record keeps each member's rendered prompt while the run exists (`TeamMember.prompt`), and no prompt text has a durable version identifier.
- Repository guidance reaches a member through its provider. `teamPrompt` says "Follow repository agent instructions", and the provider reads files such as `AGENTS.md` and `apps/mobile/AGENTS.md` in the member's clone.
- The host delivers no lessons. `docs/teams.md` mentions a separately installed shared-brain skill and describes only its context boundaries. This repository shows no step that measures a lesson's effect.
- Workspace Memory (INF-129) will own lessons. `packages/remote/src/memory.ts` defines `record_propose`, `record_review`, and `record_suppress`, and `packages/host/src/memory/store.ts` implements only the first. The INF-141 Linear issue, not source, requires held-out evaluation before feedback changes ranking.
- `RoutineService` in `packages/host/src/routines.ts` runs owner-approved finite schedules. `assertAuthority` blocks a routine when its pinned policy digest changes.
- Blocker lessons (INF-128, INF-170) are not on `main`.

## Goals

1. A change candidate gets a paired comparison with the current configuration before it is proposed.
2. The comparison is fixed in advance and reports n, an interval, its sources, and its cost. Its receipt states whether the proposer could have seen its eval tasks.
3. A failed receipt blocks adoption where the host is on the adoption path. A passed receipt approves nothing by itself. For a Class A change, the adoption rule of C15 decides (`2026-11-13-delegated-adoption-design.md`).
4. After adoption, a production regression produces a rollback proposal for a Class B change and an automatic demotion of a Class A change.
5. An owner-approved finite job can propose guidance candidates from failure clusters.
6. Memory review (INF-141) gets its held-out evaluation without a second review lifecycle.

## Non-goals

- Automatic adoption or rollback of a Class B or Class C surface. Class A changes follow C15 (decided 2026-11-13).
- A change to required checks, permissions, limits, budgets, delivery policy, the lineup, or the routing policy.
- Owner-authored project context (`packages/host/src/project-context.ts`) as a candidate surface.
- The replay harness and the corpus. The replay eval design owns both.

## Anti-goals

- **A candidate tuned to the test.** A project's holdout stages share one error budget.
- **A proposer that sees the score.**
- **A gate that freezes learning.** A change the corpus cannot measure gets the stated verdict `unmeasurable`.
- **A receipt that claims more than it measured,** or one read as approval.
- **Gate spend the owner did not approve.**

## Approaches

1. **Review, then watch production.** It costs nothing extra, but tasks never repeat. The evidence is confounded and slow: about 93 attempts per arm separate a 50% rate from a 70% rate at 80% power. A harmful change ships first.
2. **Live A/B on production tasks.** It needs no corpus. But real work runs under unproven text, and the extra attempts draw on run limits, which contract C8 forbids.
3. **Offline paired replay before the proposal.** Both arms run the same eval tasks, so it needs far fewer samples and exposes no real work. It spends learning budget and covers only what the corpus covers.

The pick is approach 3, with review as the second filter and a production watch as the third.

## Design

### Part 1. Change candidates

A **change candidate** is one proposed change to one surface, with a statement of what it should improve. Its payload is immutable, and a changed payload is a new version in the same **lineage**. A **gate receipt** is the host-written record of one gate stage for one candidate version.

| Type | Scope | Proposer | Changed component (C7) | Adoption path |
|---|---|---|---|---|
| `prompt-template` | host, or project (C15) | a person; for project scope also a proposer member | prompt version: one tunable slot | host scope: pull request here, then a host release. Project scope: automatic under C15 |
| `guidance` | project | a person or a proposer member | guidance digest: a patch to the guidance set | pull request to the project's repository |
| `lesson` | project | a person, the memory review queue, or lesson triage (C15) | knowledge snapshot: one added record | automatic under C15, or memory review (INF-141) |

Three requested types fold into these. *(My calls.)* A focused check is a `guidance` candidate, which a nested guidance file can scope to one directory. A team shape default is either a protected limit or the `plannerCraft` slot. A routing policy parameter is not gated: a replay trial fixes its profile, so the router's `shadow` mode measures a policy change.

```ts
type CandidatePayload =
  | { type: "prompt-template"; slot: TunableSlot; text: string }   // at most 4 KiB
  | { type: "guidance"; patch: string }                            // unified diff, at most 16 KiB
  | { type: "lesson"; text: string; memoryRecordId?: string };
```

A candidate also carries a statement of at most 500 characters, its proposer, the SHA-256 `payloadDigest`, and `evidenceRunIds`: the runs whose failures motivated it. The host derives the lineage at registration from the type, the target project, and the target areas. A caller cannot name one.

**Tunable slots.** The builder splits each role's instructions in `teamPrompt` into a fixed authority part and a named craft slot: `plannerCraft` (today's `assignmentBriefInstructions`), `implementerCraft`, `scoutCraft`, `integratorCraft`, and `reviewerCraft`. The two closing paragraphs on tests and on plain English become `testingCraft` and `writingCraft`. All other text is fixed. Only a session with purpose `gate` can receive a slot override, and so can a production session of a project with an adopted Class A slot (C15).

A task-level trial launches one implementer. It exercises `implementerCraft`, `testingCraft`, and `writingCraft`, the last two for implementers only. A candidate for any other slot is `unmeasurable` until the corpus replays whole runs.

**Arms.** The two arms of a comparison differ in one component:

- `prompt-template`: the candidate arm overrides one slot.
- `guidance`: the baseline pins the guidance set (contract C7) at the base branch head, and the candidate adds the patch. Head guidance may describe a historical task's solution in both arms. That narrows the room for improvement and does not make the task unseen.
- `lesson`: the candidate arm shows the lesson as a fixed evidence section in the prompt. The receipt records `delivery: "forced"`, an upper bound. Recall delivery waits for INF-142. For a Class A lesson the arm uses the production selection and verification of C15 instead, and the receipt records `delivery: "selected"`.

**What the gate uses from the replay eval design.** Pinned guidance, a slot override, and a forced knowledge text as configuration components. A task filter by explicit identifiers. Provenance groups, which stay whole in one set, and their `exposed` mark. A `confirm` job that reuses no trial. A harness version. Budget reservation per project, and an owner approval of a gate run or gate job that covers the eval jobs it starts.

### Part 2. Where candidates come from

**Cluster report.** The host groups one project's `production` and `duel` outcomes over a window by failure kind, area, kind, and model identity. The outcome ledger design owns the failure kinds. A cluster shows its count, its rate with an interval, and its change from the previous window. No model takes part.

**A gate job** proposes `guidance` candidates and project-scope `prompt-template` candidates (C15). *(My call: host-scope text from a proposer member would carry one project's content into every project, against C9 rule 9.)* In an `autonomous` project, the learning scheduler also runs gate jobs inside the standing learning budget (C15). It copies the routine's schedule fields, its 30-day approval limit, and its pinned authority digest, which here also covers the gate thresholds. It adds a cluster filter, a proposer profile from the approved lineup, `maxConfirms` for holdout stages, and `maxListUsd` for its share of the gate cap.

Each occurrence takes the largest cluster with no open lineage and builds a **failure packet**. It holds the cluster's labels and count. For at most eight attempts it also holds the task instructions and the recorded failure text, marked as untrusted evidence. It never holds a rate, a rubric, a posterior, an eval result, a hidden test, holdout content, or another project's content. The packet's runs become the candidate's `evidenceRunIds`. The gate first marks their provenance groups as exposed, which keeps them out of the holdout set.

The host then starts one proposer member in a seeded one-member run, as the replay eval design's `createForReplay` starts a trial. The member is an implementer with purpose `gate`. Its owned paths are the guidance files at the base branch head, because owned paths are exact paths (`teamPathAllowed`). The path-scope check in `captureMemberResult` rejects any other change, so a proposer cannot add a file. The captured diff is the payload, and the report summary is the statement. A proposer works at the base branch head, so it can read every merged result.

### Part 3. The gate protocol

**Registration.** The host writes the registration before any trial and stores its digest. It never changes. Only the owner sets a threshold or names a guard project.

```ts
type GateRegistration = {
  candidateId: string;
  targetAreas: string[];             // contract C4 areas in the target project
  guardProjectIds: string[];         // named by the owner, may be empty
  guardSampleSize: number;           // per project, default 12
  profileIds: string[];
  holdoutMode: "retrospective" | "prospective";
  trialsPerTask: number;             // default 3
  margin: number;                    // default 0
  guardTolerance: number;            // default 0.05
  costTolerance: number | null;      // default 0.10, null means not tested
  minTasks: number;                  // default 12 holdout tasks in the target
  baseHead: string;                  // base branch head of the target project
  baseline: { promptVersions: Record<string, string>; guidanceDigest: string; knowledge: string };
};
```

The target is the valid eval tasks in the target areas. A guard is a seeded sample of other tasks, stratified by area: one from the target project's other areas and one from each guard project. The holdout and guard lists leave out every provenance group that holds a task from a run in `evidenceRunIds`, so a mined copy of a captured task leaves with it.

**Holdout modes.** Every receipt carries one. `retrospective`, the default, uses the existing holdout set. Its receipt says that the proposer could see these tasks' reference results in the repository, and that head guidance may postdate them. `prospective` uses only target groups whose source change is outside the history of `baseHead`: a mined commit that `baseHead` does not contain, or a captured task whose run started after the registration. It needs new merges, so the candidate waits at `submitted`.

**Testing family.** One project's holdout stages in a rolling 30-day window form one family. The project allowance fixes its size at six, and a lineage gets at most two. To hold the family's error rate at 5%, each holdout stage uses a two-sided interval at level 1 − 0.05 / 6 = 99.17%. Another allowance changes the divisor. The control is per window.

**Stages.**

1. **Static check.** A candidate that touches anything outside its type's allowlist is `invalid`.
2. **Measurability.** Before any session starts, the host checks the registered mode's holdout tasks: `minTasks` in the target, and the replay eval design's minimum of 15 in the set. It also needs an isolated execution profile and a slot that a task-level trial exercises. A failed check gives `unmeasurable`. A cost tolerance with a profile that has no list price is refused.
3. **Dev stage.** A `compare` job in the target project runs both arms for each registered profile. It passes when the target estimate is above `margin`, the project's own guard is not `harm`, and the cost rule holds. A failure spends no holdout stage.
4. **Holdout stage.** One gate execution runs the target project's `confirm` job and one job per guard project.

**Gate execution.** An eval job has one project, so a stage runs as one gate execution with one child eval job per project. The target project's child holds the target tasks and that project's own guard. A guard project's child is a `compare` job on its dev set. *(My call: a guard can only fail a candidate, so it does not spend another project's holdout set.)* Each child reserves from its own project's gate cap. A child that cannot run makes its project's guard `inconclusive`. The receipt lists it with a reason code and never drops it.

The host admits a holdout execution in one transaction that counts earlier ones by lineage and by project. It derives both keys, so a new candidate identifier resets neither allowance. The `confirm` job's subject is the execution.

**Pass rule.** A task's score in an arm is the share of its valid trials that are `resolved`, over all registered profiles. The gate applies the replay eval design's percentile bootstrap over tasks. A holdout stage passes when all three hold:

1. Target: the lower bound of the family-adjusted interval is above `margin`.
2. Guard: no guard is `harm`. Each project's guard gets a 95% interval of its paired difference. It is `harm` when the interval lies below zero, `clear` when its lower bound is above `-guardTolerance`, and `inconclusive` otherwise. The receipt states each result and never claims that no regression exists while one is `inconclusive`.
3. Cost: the candidate arm's total `listUsd` is at most `(1 + costTolerance)` times the baseline arm's. With no tolerance, the receipt says that cost was not tested. Otherwise an unknown `listUsd` in either arm gives `incomplete`, never a pass and never a zero cost.

The receipt also reports an untested estimate per model identity: a provider and a model, without effort or variant. It is not the vendor family of C19. The gate confirms only large effects. The replay eval design estimates 25 to 30 points at 15 tasks for a 95% interval, and the adjusted level raises that to about 31 to 37 points by the same approximation. A receipt records the largest number of earlier `confirm` jobs that any of its tasks had seen. A person sees aggregate holdout results only, and no member sees any result.

### Part 4. Receipts

The tables live in the evidence store (C1). A project identifier is stored encrypted with a blind index, as C1 requires.

```sql
CREATE TABLE gate_executions (
  execution_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES gate_candidates (candidate_id),
  lineage_id TEXT NOT NULL,
  project_index TEXT NOT NULL,     -- blind index of the target project
  stage TEXT NOT NULL,             -- dev | holdout | retest
  started_at TEXT NOT NULL,
  child_jobs TEXT NOT NULL         -- JSON, one per project: blind index, role (target | guard),
                                   -- and the eval job id or a reason code
);
CREATE UNIQUE INDEX gate_one_holdout ON gate_executions (candidate_id) WHERE stage = 'holdout';

CREATE TABLE gate_receipts (
  receipt_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES gate_candidates (candidate_id),
  execution_id TEXT REFERENCES gate_executions (execution_id),
  stage TEXT NOT NULL,             -- static | measurability | dev | holdout | retest
  verdict TEXT NOT NULL,           -- passed | failed | unmeasurable | invalid | incomplete
  holdout_mode TEXT,
  registration_digest TEXT,
  baseline_arm_id TEXT,
  candidate_arm_id TEXT,
  harness_version TEXT,
  task_count INTEGER,
  trial_count INTEGER,
  holdout_uses INTEGER,            -- most earlier confirm jobs seen by one of its tasks
  spent_usd_micros INTEGER,        -- NULL when unknown
  list_usd_micros INTEGER,         -- NULL when unknown
  finished_at TEXT NOT NULL,
  encrypted_detail TEXT NOT NULL   -- registration, statistics, guard results, reasons,
                                   -- and the configId of each task, arm, and profile
);
```

A receipt reaches its trials through its execution's child jobs. The host inserts an execution when a stage starts, which spends the allowance. It writes a receipt once, when the stage ends, and never changes it. A receipt's statistics use `replay` outcomes of `isolated` trials only. A watch uses `production` and `duel` outcomes only. Neither uses `legacy`.

`gate_candidates` holds one row per candidate version, with its lineage, type, payload digest, status, and encrypted payload. A status is `submitted`, `invalid`, `unmeasurable`, `dev-failed`, `dev-passed`, `passed`, `failed`, `incomplete`, or `withdrawn`. `gate_adoptions` holds one row per observed adoption, with its receipt if any, the watch state, and the applicability per model identity.

**Arm identity and staleness.** An arm identity is the digest of an arm's fixed inputs: its slot override, its guidance mode or pinned digest, and its knowledge reference. A `configId` cannot identify an arm. It differs per task when guidance comes from the task's base, and a production `configId` has shape `team` while a trial's has shape `trial`. So the registration records the baseline's named components: the prompt version per provider, the guidance digest at the base branch head, and the knowledge reference. A receipt is stale when one of them differs from that component in the `configurations` row of the project's newest production attempt for the same role and provider.

### Part 5. Adoption

`infinite gate export` writes the payload and a receipt summary: verdict, holdout mode, estimate, interval and level, each guard result, n, cost, holdout uses, and the proposer's model. It holds no eval task content.

A receipt blocks where the host is on the path. For a lesson, the gate offers a receipt lookup by payload digest. This design asks one rule of INF-141: a candidate with a `failed` holdout receipt for that digest cannot be accepted. A memory candidate that enters review registers as a gate candidate, which is how blocker lessons (INF-128) arrive. The host cannot block a merge on GitHub, so for repository files it makes the state visible.

The host observes adoption and never infers it from a report:

- `prompt-template`: the running host's default slot text has the payload's digest.
- `guidance`: the patch reverse-applies cleanly to the guidance files at the base branch head the host holds.
- `lesson`: the memory record is `active` at the gated digest.

A Class A change is adopted by the host itself under the rule of C15, so it needs no observation. Its adoption row keeps its pre-image.

A component that changes without such a match, or after an edit to a candidate, is listed as an **ungated change**. The host finds a changed component in the `configurations` rows of the outcome ledger design. The list blocks nothing. An `unmeasurable` candidate may still go to review, and the host records its adoption as unmeasured. It is never adopted automatically (decided 2026-11-13).

### Part 6. Watch and re-test

A watch opens when the host observes an adoption. It covers the registered target areas and partitions attempts by full profile identity and profile epoch. A stratum is comparable when it has at least 15 attempts in the 60 days before adoption and 15 in the 30 days after, counting at most 40 a side. The watch compares `firstPass` inside each comparable stratum and pools the differences, weighted by attempts. With no comparable stratum the result is `inconclusive`.

The watch closes as `regressed` when the pooled rate fell and its 95% interval excludes zero, and as `confirmed` when it rose under the same test. Every result is labelled observational, because the tasks differ. For a Class B change, a `regressed` watch raises a regression report with a rollback proposal: a revert patch or a `record_suppress` request, and nothing rolls back by itself. A Class A change is demoted automatically (C15).

A **re-test** runs when a registered profile starts a new profile epoch, because a lesson can help one model and hurt another. A `compare` job on the dev set runs the current configuration with and without the candidate. *(My call: a re-test tunes nothing, so it needs no unseen tasks.)* Its `retest` receipt gives an applicability value per model identity: `helps`, `no-effect`, `hurts`, or `unknown`. A `hurts` value raises a regression report for a Class B change. For a Class A change, C15 states the re-test schedule and the demotion threshold.

### Part 7. Cost and surface

Every session the gate starts has purpose `gate`. Each child eval job reserves from its own project's gate cap and settles as contract C8 states. No gate session starts in a project whose gate cap is reached. A `confirm` job that expires unfinished gives an `incomplete` receipt, and its holdout stage stays spent.

- API under `/api/gate`: `clusters`, `candidates`, `receipts`, `adoptions`, `ungated`, and `jobs`. A viewer can read. Only the owner mutates, with a `requestId`.
- CLI: `infinite gate clusters`, `propose`, `list`, `show`, `run`, `withdraw`, `export`, `adoptions`, `ungated`, and `job`, each with `--json`.
- MCP: none. No member can read a candidate, a receipt, or a cluster.

### Part 8. Worked example

The numbers are illustrative.

1. The cluster report shows failure kind `task-scope-violation` in area `apps/mobile` for 9 of 31 implementer attempts.
2. The owner proposes a `prompt-template` candidate for `implementerCraft`: "Before you report, list the files you changed. Restore every file outside your assigned paths." The owner names one guard project and keeps the `retrospective` mode.
3. The static check, the measurability check, and the dev stage pass. The dev stage shows +0.21 on 22 tasks.
4. The holdout stage shows +0.24 on 14 tasks and two profiles, with a 99.17% interval of [0.03, 0.44]. The project's own guard interval is [−0.12, 0.10], so that guard is `inconclusive`. The guard project's interval is [−0.03, 0.09], so it is `clear`. The cost ratio is 1.03. The verdict is `passed`, and the receipt states both guard results and the two retrospective limits.
5. The owner exports the receipt and opens a pull request for the normal checks and an independent review. After the release, the host's slot text matches the payload digest, and the host opens a watch.

## Authority and safety

- **Allowlist (C9 rule 2).** A candidate may touch only one tunable slot, files in the guidance set, or one memory candidate record. The static check rejects everything else, including limits, required checks, review and delivery policy, the lineup, the routing policy, the corpus, and the gate's thresholds.
- **No scores or eval material in prompts (C9 rules 3 and 8).** A failure packet holds counts and failure text. A proposer never receives a receipt, a dev result, a hidden test, or holdout content.
- **No self-grading (C9 rule 4).** The export names the proposer's model, and the adoption review uses a different model family (C19).
- **Evidence, not approval (C9 rule 7).** No code path changes a repository file from a receipt. A Class A state changes only under the adoption rule of C15, which needs more than a receipt. A `passed` receipt says only that the candidate beat the baseline on these eval tasks under these graders, with the limits it states.
- **Project boundary (C9 rule 9).** A reviewer checks that a `prompt-template` text names nothing project-specific. The static check cannot decide that.

## Failure modes

- **Small corpus.** The verdict is `unmeasurable`, and the surface shows how many more eval tasks the target needs.
- **No new merges.** The holdout set shrinks below the replay minimum. A candidate waits at `dev-passed`, or at `submitted` in `prospective` mode.
- **Stale baseline.** Another change lands while a candidate is in the gate. Part 4 defines the stale mark. Two interfering candidates have no other defence.
- **A candidate that memorizes eval tasks.** The holdout list leaves out the evidence runs' provenance groups, a reviewer reads the text, and a guard shows a narrow change. Only a `prospective` receipt rules it out.

## Delivery order

Each phase is its own pull request and is useful alone.

1. Person-proposed `guidance` candidates: static check, registration, both stages, receipts, CLI, and API.
2. `prompt-template`: the slot split with byte-identical default prompts, the slot override in trials, and guard projects.
3. The cluster report, adoption observation, the ungated list, the watch, and the regression report.
4. Gate jobs and the proposer member.
5. `lesson` with the receipt lookup for INF-141, and re-tests.

## Acceptance

1. A `guidance` patch outside the guidance set is `invalid`, and so is a `prompt-template` candidate for fixed text. No session starts.
2. A request to change a registered threshold is refused, and a dev failure starts no `confirm` job.
3. A second holdout stage for one candidate version is refused. So is a third for one lineage or a seventh for one project within 30 days, under any new candidate identifier.
4. With fixture task scores, a target passes when its 99.17% interval lies above the margin and fails when only its 95% interval does.
5. A guard interval below zero fails the candidate. One that spans zero, or a guard project whose child cannot start, appears in a passing receipt as `inconclusive`.
6. A cost tolerance with an unknown `listUsd` gives `incomplete`. With no tolerance the receipt says that cost was not tested.
7. A target under `minTasks`, a holdout set under the replay minimum, or a slot that no task-level trial exercises returns `unmeasurable` before any session starts.
8. No holdout or guard task shares a provenance group with a run in `evidenceRunIds`, including a mined copy of a captured task. A `prospective` list holds only groups outside the history of `baseHead`, and a `retrospective` receipt states its two limits.
9. A proposer's prompt, packet, and clone contain no rate, score, receipt, hidden test, or holdout text. A proposer edit outside the guidance set fails the path-scope check.
10. Every session the gate starts has purpose `gate`, and each child job reserves from its own project's gate cap.
11. After an unchanged guidance patch merges, the host records the adoption. After an edited merge, it lists an ungated change. A receipt becomes stale when a named baseline component changes, never because a production `configId` differs from a trial's.
12. A watch compares only inside one profile identity and profile epoch, and returns `inconclusive` with no comparable stratum. A drop for a Class B change produces a regression report, and nothing is reverted. A drop for a Class A change demotes it (C15).
13. With no override, `teamPrompt` output for a fixture run is byte-identical before and after the slot split.

## Owner decisions

1. **Decided 2026-11-13:** an agent may propose `guidance` candidates through the gate.
2. The gate cap and the thresholds. **Decided 2026-11-13:** the gate cap is 30% of the standing learning budget, which is a quarter of the weekly fuse. Still open: the default thresholds and allowances in Part 3.
3. Does adoption need a `prospective` receipt? **Decided 2026-11-13 for automatic adoption:** yes (C15). Still open for adoption by review.
4. **Decided 2026-11-13:** a candidate that the gate cannot measure is not adopted automatically. Review may still adopt it, recorded as unmeasured.
5. Which guard projects does a `prompt-template` candidate name? Each one spends its own gate cap.
6. Should per-task holdout results stay hidden from the owner while a task is in the holdout set?

## Left to the builder

- The proposer's task text and the seeding of its one-member run.
- The cluster ranking, and the interval methods for cluster rates and for the pooled watch.
- The resample count that a 99.17% bootstrap bound needs.
- Indexes, migrations, and the canonical payload encoding.
- How a regression report reaches the owner's devices.

Not verified in source: how each provider resolves nested or imported guidance files.
