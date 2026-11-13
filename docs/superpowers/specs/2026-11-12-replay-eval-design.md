# Replay eval (INF-185)

Date: 2026-11-12. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`.

## Intent

The owner wants to raise team performance in each repository by measurement. Production outcomes cannot compare two configurations, because a task runs once and the coordinator chooses who gets it.

Replay eval builds a corpus of eval tasks from the repository's own history. It runs any configuration on the same eval tasks under the production member lifecycle, and it grades each result with tests the member never saw. Two configurations then differ on identical work. The router takes priors from the results, and the improvement gate takes trials.

## Current state

Observed on `main`:

- `TeamService.createRun` (`packages/host/src/teams.ts`) always starts a project manager. No entry point accepts a recorded task.
- A team workspace is a transport clone of the source mirror, and a member clone is one of that workspace (`prepareTeamWorkspaceFromMirror` and `prepareMemberWorkspace` in `packages/host/src/team-workspace.ts`). A clone receives the history that the cloned repository's refs reach, so a workspace at an older commit would still have received the later base-branch commits.
- The mirror holds the full history of the base branch only (`ProjectSourceService.refresh`). Agents can write it (`docs/security.md`).
- `captureMemberResult` makes one host commit for a result that changes the tree, and none otherwise. It limits a member by path only. The commit exists only in the run's clones, which retention removes.
- `deleteRecord` removes a run's record. `TeamService.retire` calls it on its own only for a cancelled run that no goal and no mission owns. `removeRun` calls it on request for a settled cancelled, merged, or no-change run.
- `teamCommand` keeps only the last 64 KiB of output. `spawnTeamBundle` streams a bundle of one branch.
- On the Ubuntu template every agent runs as one account (`deploy/ubuntu/infinite.sudoers`), which can read the mirror, the project checkouts, and the team roots.
- This repository's base branch has 149 first-parent commits. 121 of them touch `tests/*.test.ts`.

Not verified: launcher admission for the added Git operations, the layout of provider-native history, and every branch of `TeamService.step`.

## Goals

1. A per-project corpus of validated eval tasks, captured from settled runs and mined from base-branch history.
2. Trials with production member behaviour and no production side effect.
3. Deterministic grading from hidden tests and the configured checks.
4. Paired comparison that reports its uncertainty, its n, and its sources.
5. A dev set for tuning and a counted holdout set for confirmation.

## Non-goals

- Interface tasks in the first version (Part 9).
- Run-level replay before phase 5.
- A corpus shared across projects.
- A replacement for review.
- Network egress filtering.

## Anti-goals

- **A leaked answer.** A trial that can read its reference yields a number that looks like evidence.
- **An eval that starves real work.** Replay spends the same provider limits as production.
- **An easy corpus presented as the whole workload.** Only a task with tests can be graded, so the corpus summary shows its coverage.
- **Tuning on the holdout set.**

## Approaches

Three ways to run a trial were considered.

- **A. A separate harness that launches bare sessions.** It is the least code, but it must copy report reading, result capture, permission review, and stall and limit handling. The copies drift, so the eval would measure a different system.
- **B. A restricted run kind inside `TeamService`.** A replay run starts from a seeded task and uses the real member lifecycle, with production side effects switched off at named points. It adds a branch to a large state machine.
- **C. A container runner, as public coding benchmarks use.** It isolates best, but it needs an image per base commit and provider logins in containers, and it bypasses the host launch path.

The design uses B and takes C's isolation property as a requirement (Part 4). *(My call: the router acts on these numbers, so fidelity matters more than build cost.)*

## Design

This design defines six terms for every document in this set:

- **Eval task**: one recorded piece of work that can be repeated. It has a prompt, a base tree, a reference result, and hidden tests.
- **Trial**: one attempt at one eval task under one configuration.
- **Corpus**: a project's eval tasks.
- **Dev set**: the valid eval tasks that tuning may read.
- **Holdout set**: the valid eval tasks reserved for confirmation.
- **Resolved**: the grade of a trial that passed every expected case and the guard checks (Part 5).

### Part 1. Project eval configuration

The first version supports projects in `github` source mode, because only they have a host mirror. The owner adds an `eval` block to the project's private team configuration:

```ts
type EvalProjectConfig = {
  testPaths: { prefixes: string[], suffixes: string[] }
  gradingPaths: string[]                  // runner configuration, package scripts, test helpers
  focusedTest: TeamCommand                // argv with {files} and {report} placeholders
  reportFormat: "junit" | "tap"           // what focusedTest writes to {report}
  guardChecks?: TeamCommand[]             // default: the configured checks
  excludeAreas: string[]                  // interface areas (contract C4)
  candidateProfiles?: TeamModelProfile[]  // approved for replay only
  memberProfile?: string                  // launch profile of the eval identity
  graderProfile?: string                  // launch profile of the grader identity
  trialMinutes: number                    // default 45
}
```

The harness replaces `{files}` with the hidden test paths and `{report}` with a file outside the checkout. A job may test a profile only from the project's lineup pools or from `candidateProfiles`, which no prompt shows. *(My call: the owner can measure a new model before it receives real work.)*

### Part 2. The corpus

```ts
type EvalTask = {
  id: string, projectId: string
  origin: { type: "captured" | "mined", runId?: string, taskId?: string, commit?: string }
  group: string, exposed: boolean  // provenance group and its exposure flag
  promptOrigin: "assignment" | "run-objective" | "commit-message"
  anchorCommit: string           // on the base branch, held by the mirror
  features: { role: "implementer", area: string, kind: string | null, risk: "normal" | "elevated", featureVersion: number }
  state: "captured" | "candidate" | "valid" | "rejected" | "retired"
  reason?: string
  set?: "dev" | "holdout"
  // Encrypted payloads (contract C1):
  capsule: Capsule               // prompt inputs, never a rendered prompt
  baseDelta: Uint8Array | null   // patch: anchorCommit to the replay base
  referencePatch: Uint8Array     // patch: replay base to the accepted result
  hiddenFiles: string[]          // test files the reference adds or changes
  expectedCases: string[]        // hidden test cases that passed with the reference
}
type Capsule = {
  objective: string, steering: string[], ownerAnswers: { question: string, answer: string }[]
  brief?: TeamBrief, goal?: TeamGoalContext
  task: { id: string, title: string, instructions: string, paths: string[] }
}
```

The replay base is the tree a trial starts from: the anchor commit with `baseDelta` applied. The reference tree is the replay base with `referencePatch` applied.

A capsule stores prompt inputs, so a trial renders them with the prompt builder under test (`teamPrompt`). A patch stores a tree change, so no eval task depends on a commit that retention deletes. Both are rows in the evidence store, limited to 64 KiB and 1 MiB. A private ref in the mirror would expose the reference to agents.

**Captured tasks.** In the host step that records `TeamTask.commit`, the host also reads two binary patches from the integration checkout. One runs from the run's `baseCommit` to the member's `baseCommit`. The other runs from there to the task commit. The host reads them with a streaming reader, because `teamCommand` truncates output. A failed read records `capture-failed` and never blocks integration. The capsule keeps only the steering entries and owner answers dated before the member started.

A captured task becomes a `candidate` when four conditions hold:

1. The outcome ledger marks its attempt `accepted`.
2. The run's `baseCommit` is on the mirror's base branch.
3. No later commit of the run changed the files in the task's `changedPaths`.
4. The reference changes at least one test file and one other file.

Otherwise it is `rejected` with a code such as `reference-ambiguous` or `no-hidden-tests`. When `deleteRecord` removes a run whose status is `cancelled`, the host deletes that run's captured tasks in the same step. *(My call: a deleted cancelled run leaves no data.)* Every other eval task stays until the owner-set eval retention removes it (contract C1).

**Mined tasks.** A scanner walks the first-parent history of the base branch in the mirror, newest first. A commit yields a `candidate` task when its diff against its first parent changes at least one test file and one other file. The diff must stay under 30 files and 1,500 changed lines, must not be a revert, and must touch no excluded area. The first parent is the anchor.

If a kept run record has `deliveryReceipt.mergeCommit` equal to the commit, the capsule takes that run's objective and brief (`run-objective`). Otherwise it takes the commit message (`commit-message`). The host does not read Linear here, because `LinearService` cannot cut an issue's text at its creation time. The task's `paths` are the parent directories of the files the reference changes. A mined task has no coordinator label, so its kind is null.

**Provenance groups.** Tasks that derive from one change share a group. Set assignment, holdout rotation, and every exclusion act on whole groups. A run's captured tasks form one group. A mined commit joins it when the run's `deliveryReceipt.mergeCommit` equals the commit, or when the outcome ledger's base branch scan matched the commit to the run. The mined task is then `rejected` with `duplicate-of-captured` while the group has a `candidate` or `valid` captured task. Any other mined commit is its own group.

A mined commit with unclear lineage never enters the holdout set. Its lineage is unclear when its changed files overlap the `changedPaths` of a run that has captured tasks, was approved before the commit, and has no observed landing. The mined task then joins that run's group. It is rejected while the group has a `candidate` or `valid` captured task, as above. Otherwise it is kept with the mark `lineage-unclear`, and its group is assigned to the dev set only. *(My call: a pull request delivery records no merge commit, and a squash merge onto a moved base matches no exact rule, so the host cannot prove that such a commit is a new change.)*

**Validation.** A `validate` job runs host commands only and spends no model tokens. A candidate becomes `valid` when:

1. With the whole reference applied, the runner report lists passed cases in the hidden files. They become the expected cases. On the replay base with the hidden files added, at least one of them fails or is absent.
2. The guard checks pass with the reference applied.
3. Three reference runs pass the same expected cases, and two base runs both show the failure.
4. The focused test run finishes within ten minutes.

Validation commands run as the grader identity (Part 4), so a test that needs a network or a listener its launch profile denies fails there. A failed candidate is `rejected` with `not-fail-to-pass`, `guard-failed`, `flaky`, or `too-slow`. A scheduled revalidation retires a task whose reference stops passing, whose anchor leaves the mirror, or whose group gained a captured task. A seeded hash puts 30% of groups in the holdout set and the rest in the dev set. *(My call.)* An exposed group belongs to the dev set: it joins it, or moves to it at once. No group ever moves from the dev set to the holdout set.

### Part 3. Trials

A trial runs one implementer under one configuration:

```ts
type EvalConfiguration = {
  profile: TeamModelProfile
  guidance: "as-of-base" | { pinned: string }        // digest of an overlay stored with the job
  knowledge: "none" | { forced: string }             // digest of a text stored with the job
  promptOverride?: { slot: string, digest: string }  // as the improvement gate design defines
}
```

The host adds the prompt version and computes `configId` (contract C7). `as-of-base` uses the guidance files in the base tree. `pinned` overlays one set of guidance files on every task's base, so the improvement gate can compare two versions of guidance. Such guidance can postdate a task, so a trial with pinned guidance, forced knowledge, or a prompt override never feeds a prior export.

`TeamService.createForReplay` creates a run with `replay: { jobId, trialId, purpose }`, set once. Seeding emits `plan.accepted` and one `task.planned` that carries the eval task's features, so the outcome ledger needs no special case. A replay run differs from a production run only here:

| Point | Production run | Replay run |
|---|---|---|
| Plan | From the project manager | Seeded with the capsule's task. No project manager starts |
| Base | Mirror head or parent run | The trial source |
| Members | As planned | One implementer on the configuration's profile, with the project's pinned permission review |
| Stall, escalation, question, blocked | A replacement or an owner decision | The trial ends with that name |
| Provider limit | Switch to the fallback profile | The trial is void |
| After integration | Checks, repair, review, delivery | The run settles, and the harness grades it |
| Publication, Linear, push, client lists | As configured | Never |

`publicationTarget` returns nothing for a replay run, and creation passes `linearTracking` as false. `list`, `statuses`, and `understandingRecords` omit replay runs, so no client and no notifier sees one. Each session records the purpose `replay`, or `gate` when the improvement gate created the job.

A permission prompt that the pinned delegation cannot decide ends the trial as `permission`. No component answers it. The prompt is the production prompt and does not say that the task is a replay.

### Part 4. Leakage controls

Two accounts isolate a trial. Each serves every project, so each control below covers all projects. The **eval identity** runs replay members with its own provider logins. The **grader identity** runs validation and grading commands with no provider login. Neither holds a repository credential. *(My call: an account without logins is cheap, and cleanup after graded code that ran beside the hidden tests cannot be trusted.)*

**Trial source.** The harness makes a staging clone of the mirror and points one branch at the replay base. For a captured task it first applies `baseDelta` and makes one host commit. It streams a bundle of that branch through the host, as `spawnTeamBundle` does for run branches. A bundle holds only the objects its branch reaches. The trial's checkout is cloned from the bundle.

| Channel | Control | Probe before launch |
|---|---|---|
| Later commits in the clone | The one-branch bundle | `git cat-file -e` fails for the reference commit and the mirror head |
| Mirror, project checkouts, production team roots, production agent home | The eval identity cannot read them | It cannot read a canary file in each, and its fetch of the repository fails |
| Hidden tests and grading clones | Hidden material leaves the evidence store only into the grader's root. The eval identity cannot read that root, the grader's home, or its temporary directory | It cannot read a canary file in each. The trial workspace holds no hidden file content |
| Other trials, of any project | One live trial per eval identity. The host removes the previous trial's workspace first | The eval root holds no other trial workspace |
| Surviving processes | The host stops every process of the eval identity between trials | No process runs under the eval identity |
| Local provider state | After usage capture the harness removes what a trial left in the eval home | The eval home holds no session history and no memory file |

The harness lists and stops processes by user with the means in `packages/host/src/team-retirement.ts`. It removes each grading clone when its commands end. The clone has no remote, as today. Recall tools are off, guidance is as of the base commit, and prompt text is fixed at the time of the work.

**What no probe covers.** The host cannot inspect history or memory that a provider holds on its own side for a login. The `isolated` label makes no claim about it. The owner sets up the eval logins with those features off where the provider offers that, and uses the logins for nothing else. This design also adds no egress filter, so a project with a public repository cannot reach `isolated`.

When every probe passes, the trial is labelled `isolation: "isolated"`, otherwise `none`. A trial labelled `none` never enters a prior export or a gate receipt. Local trials are always `none`.

### Part 5. Grading

After the host confirms that every process of the trial has stopped:

1. The host captures the result with `captureMemberResult` and its path-scope check.
2. It streams a bundle of the result commit into the grader's root and builds the grading commit there. That commit is the result tree with three sets of files taken from the reference tree: the hidden files, every other test file, and every file under `gradingPaths`.
3. `focusedTest` runs as the grader identity in a grading clone, which is disposable and must stay unchanged, like a verification clone.
4. If the report lists every expected case as passed, the guard checks run at the same commit.

The path-scope check limits a member by path only, so a result could otherwise change the runner, a package script, or a helper. For the same reason only the runner report resolves a trial, never an exit code.

```ts
type TrialGrade = {
  ending: "graded" | "no-result" | "escalated" | "question" | "blocked" | "permission" | "stalled"
        | "scope-violation" | "timeout" | "void-limit" | "void-host" | "void-owner"
  expectedPassed: number, expectedTotal: number   // from the runner report
  guardPassed: boolean | null
  resolved: boolean          // graded, every expected case passed, and guardPassed
  overwritten: number        // files the result changed that step 2 replaced
  diff: { added: number, removed: number, referenceAdded: number, referenceRemoved: number }
  isolation: "isolated" | "none"
}
```

`resolved` is a grade, not a success level of contract C5. A trial that needs its own change to a replaced file cannot be resolved, so reports count the trials with `overwritten` above zero.

Only a cause outside the configuration voids a trial: a provider limit, a host restart or infrastructure failure, or an owner stop (contract C5). The harness runs a void trial again, at most twice. Every other ending counts as not resolved, `permission` included.

The harness keeps each graded trial's result patch as an encrypted payload. A host-internal read gives the duels design a project's calibration pairs: two graded trials of one dev set task where exactly one is resolved, each with its result patch. The store query admits dev set tasks only and returns at most one pair per eval task, because a judge member reads the pair. A design that shows an eval task's content to a member outside that task's own trial first marks the task's group as exposed.

A later phase adds a blind rubric from the project's reviewer profile, which must differ in model from the trial's profile (contract C9 rule 4).

### Part 6. Jobs, budget, and scheduling

```ts
type EvalJob = {
  id: string, projectId: string
  kind: "validate" | "baseline" | "compare" | "confirm"
  purpose: "replay" | "gate"
  configurations: EvalConfiguration[]
  taskFilter: { set: "dev" | "holdout", taskIds?: string[], excludeGroups?: string[], areas?: string[], promptOrigins?: string[], maxTasks?: number }
  trialsPerTask: number          // default 3
  subject?: string               // required for confirm
  limits: { maxTrials: number, maxListUsd: number, maxSpentUsd: number, maxWallMinutes: number }
  windows?: { startHourUtc: number, endHourUtc: number }[]
  expiresAt: string
  status: RoutineStatus          // from routine-types.ts
}
```

A job has the shape of a routine in `RoutineService`. Only the owner creates one, and it expires within 30 days. The improvement gate may create one inside the limits of a gate job that the owner approved. The host pins a digest of the project policy, the host policy, the eval configuration, and the prompt version. A change blocks the job with `configuration-changed`. Before approval the host shows the trial count, the estimate that it would reserve per trial, and whether that estimate is measured or the fallback.

**Learning budget.** This design owns the learning budget of contract C8. The owner sets it in the project's private team configuration:

```ts
type LearningBudgetConfig = {
  monthlyListUsd: number        // cap on list-price equivalent, for every profile
  monthlySpentUsd: number       // cap on metered money
  shares: { duel: number, replay: number, gate: number }   // each 0 to 1, sum at most 1
  fallbackEstimate?: { listUsd: number, spentUsd: number }  // per session with no usage history
}
```

A project without this block has a budget of zero, so no session with a learning purpose starts there. A `validate` job spends no model tokens and needs no budget. A purpose's share of the two caps is its cap. The other designs call them the duel cap and the gate cap.

Three host-internal functions serve this design, the duels design, and the improvement gate design:

- `reserve(projectId, purpose, estimate)` takes an estimate with two amounts, `listUsd` and `spentUsd`. It succeeds while the month's settled and reserved amounts for that purpose stay inside both caps.
- `settle(reservationId)` replaces the estimate with the usage of the reserved sessions, read from the usage ledger. A session with `complete` usage coverage settles at its measured usage. Any other session settles at its estimate, or at its measured usage when that is larger, and is labelled so.
- `status(projectId)` returns the caps and, per purpose, the settled, reserved, and estimated amounts.

An estimate is the median usage of the profile's earlier sessions in the project that have `complete` usage coverage. With no such session, or for an amount that cannot be priced, it is the owner-set `fallbackEstimate`. With no fallback configured, `reserve` refuses, and the job pauses with `estimate-unavailable`.

Reservations are rows in the evidence store. The month is a calendar month in UTC.

The host checks the job limits and reserves from the learning budget before each trial starts. It cannot cap tokens inside a session, so a job can exceed a limit by the trials already running. An exhausted limit pauses the job with `budget-exhausted`.

No trial starts while its provider has an active limit in `ProviderLimits`, outside the job's windows, or when fewer than four host session slots are free. *(My call: real work keeps priority.)* A later job reuses a valid trial under 30 days old when the eval task, the `configId`, the profile epoch, and the harness version match. The harness version changes with grading or the trial lifecycle. A `confirm` job never reuses a trial.

### Part 7. Statistics

The unit is the eval task. A task's score for a configuration is the share of its valid trials that are resolved. The paired difference is one configuration's score minus the other's. A report names its source, `replay`, and gives:

- the mean paired difference with a 95% percentile bootstrap interval over tasks (10,000 resamples, seeded from the job id)
- an exact two-sided sign test over tasks, with wins, losses, and ties
- n tasks, trials per task, and the smallest difference this n could detect at 80% power
- cost per resolved trial: tokens, `listUsd`, `spentUsd` for metered profiles, and minutes
- the same figures per `promptOrigin` and per area, each with its n
- attrition per configuration: void trials by cause, and tasks dropped for lacking the full count of valid trials
- a sensitivity figure: the difference with every void trial counted as not resolved

A job fixes its task set, trial count, and metric at approval. An interim view shows no test result. A job with more than two configurations reports Holm-adjusted p-values. A comparison is reported as inconclusive when fewer than 90% of its tasks keep their full count of valid trials in every configuration. *(My call: below that share the surviving tasks can favour one configuration.)*

Planning figures at 3 trials per task and 80% power, for a standard deviation of the paired difference between 0.35 and 0.41:

| Eval tasks | Smallest detectable difference |
|---|---|
| 15 | 25 to 30 points |
| 30 | 18 to 21 points |
| 60 | 13 to 15 points |

These are planning estimates for a paired mean test under a normal approximation, not results. Nobody has computed the power of this design's tests on resolved scores or of the improvement gate's pass rule. A builder checks both by simulation before the first `confirm` job.

**Holdout set.** `baseline` and `compare` jobs read the dev set only. A `confirm` job reads the holdout set and names a subject: a change candidate or a configuration pair. The store refuses a second `confirm` job for one subject, and any `confirm` job when the holdout set has fewer than 15 tasks. A holdout group moves to the dev set after five confirm jobs or 120 days, and a newly validated group replaces it.

**Epochs.** A trial records the profile epoch of its profile, which the outcome ledger design keeps. The owner advances it there after a known backend change behind an unchanged model name. A changed profile identity is another profile with its own epochs. Trials from different profile epochs never share a comparison or a prior export.

### Part 8. Outputs and surface

A replay run emits the same events as any run, so the outcome ledger writes its outcome row with source `replay`. The harness sets the row's `experiment_ref` to the trial id. The row's `accepted`, `firstPass`, and `held` stay unknown (contract C5).

The prior export feeds the router:

```ts
type ReplayPrior = {
  projectId: string, profileId: string
  profile: { provider: string, model: string, effort: string }   // profile identity: effort or variant
  profileEpoch: number, promptVersion: string
  role: "implementer", area: string, kind: string | null
  tasks: number          // distinct eval tasks: the n to trust
  trials: number, resolved: number
  source: "replay", promptOrigin: "assignment" | "run-objective" | "commit-message"
  generatedAt: string
}
```

It covers `isolated` dev set trials. Trials of one task are not independent, so `tasks` is the sample size.

The corpus summary shows task counts by state, origin, set, and area. It also shows coverage: the share of accepted production attempts that have a valid eval task.

- **API.** Under `/api/eval`: `GET projects/:id`, `GET projects/:id/priors`, `GET jobs`, `GET jobs/:id`, and `GET jobs/:id/report`. Owner only: `POST jobs`, `POST jobs/:id/pause`, `resume`, and `cancel`, and `POST tasks/:id/retire`. A task listing shows each task's group. No route returns a capsule, a patch, or a hidden file.
- **CLI.** `infinite eval status PROJECT`, `infinite eval run --file job.json --request-id UUID`, `infinite eval report JOB`, and `infinite eval priors PROJECT`, each with `--json`.
- **MCP.** None. No member can read eval data (contract C9 rule 3).

### Part 9. Interface tasks later

A later version needs a runnable interface on the host, which INF-110 tracks. It also needs screenshots at fixed states, a reference for each, a blind judge of a different model, and a flake screen for rendering. Until then a task that touches an excluded area, or whose brief sets `uiChanges`, never enters the corpus.

## Authority and safety

- A grade never changes a run's status, a Linear issue, or a routing decision.
- A job tests only profiles the owner approved, under the project's pinned permission policy. A `dataUse: "contributor"` profile needs the project's policy to allow it, because a trial sends repository content to that provider.
- A trial runs old commits with old dependencies. Neither the eval identity nor the grader identity holds a repository credential, so that code can publish nothing.
- Validation and grading commands run as the grader identity, never as the host identity.

## Failure modes

| Failure | Behaviour |
|---|---|
| The host restarts during a trial | The trial is void. The host removes its workspace before another trial starts |
| The mirror's history is rewritten | A task whose anchor is gone is retired with `anchor-missing` |
| A grading command exceeds its time | The trial ends `timeout`. A command the host cannot stop blocks the job |

## Delivery order

1. **Capture.** Capsules and patches for integrated tasks, promotion on `accepted`, and deletion with cancelled runs. It needs the evidence store and the outcome ledger's events.
2. **Mining and validation.** The scanner, provenance groups, the `validate` job, the corpus summary, and `infinite eval status`. It spends no model tokens.
3. **Trials.** The replay run kind, the trial source, the probes, grading, `baseline` jobs, and outcome rows.
4. **Comparison.** `compare` and `confirm` jobs, the two sets, reports, epochs, and the prior export.
5. **Run-level replay and the blind rubric.** A run-level trial starts a whole team from a recorded objective.

## Acceptance

1. After a fixture run integrates an implementer task and records an approving review, a `candidate` eval task exists. Removing the run's clones does not change it. Deleting the cancelled run's record deletes it.
2. A fixture commit whose test fails at its parent and passes with its diff becomes `valid`. One whose test passes at its parent is rejected with `not-fail-to-pass`, and one that fails one of three reference runs with `flaky`.
3. A captured task and the mined commit of its run's merge share a group, the mined task is rejected with `duplicate-of-captured`, and no group spans both sets.
4. In a prepared trial workspace, `git cat-file -e` fails for the reference commit, `git remote` prints nothing, and no hidden file content exists.
5. No trial starts while a process runs under the eval identity, or while another trial's workspace, of any project, exists in the eval root. Without both launch profiles a trial is labelled `none`, and the prior export omits it.
6. A replay run makes no publication, Linear, or notifier call, and `GET /api/teams` does not list it.
7. A trial whose member applies the reference is `resolved`. A result that makes `focusedTest` exit zero without running the hidden tests is not. A result that edits a file under `gradingPaths` is graded with the reference's file and reports `overwritten` above zero.
8. An empty result ends `no-result`, an edit outside the task's paths ends `scope-violation`, and an undecided permission prompt ends `permission`. A provider limit voids the trial, and it runs again.
9. `reserve` refuses when a profile has no usage history and no fallback estimate exists. A job starts no trial after its `maxTrials` or its learning budget is exhausted.
10. A report on a fixed result set prints the same interval on every run, with attrition per configuration and the sensitivity figure. Below the 90% share it reports the comparison as inconclusive.
11. The host refuses a second `confirm` job for one subject. The calibration read returns no pair from a holdout task and at most one pair per eval task.

## Owner decisions

1. Whether to add the two accounts: an eval identity with its own provider logins, and a grader identity with none. Without both, every result is labelled `none` and feeds nothing.
2. The setup of the eval logins: provider-side history and memory off where the provider offers that, and no other use. The host cannot check it.
3. When replay may spend subscription limits: the windows, the monthly cap inside the learning budget, and the fallback estimate.
4. Whether tasks with a `commit-message` prompt may feed router priors. The export keeps them apart either way.
5. How long eval material stays in host state, and whether a captured task may outlive the deleted record of a cancelled run. The default for the second is no.

## Left to the builder

- The exact points in `TeamService` that seed a plan and settle a replay run.
- The streaming patch reader, the commands that build a staging clone and its bundle, and how a bundle passes between the three identities.
- The report parser for each `reportFormat`, and the form of a case identifier.
- Launcher admission for the added Git operations.
- Removal of local provider state after usage capture.
- Table definitions in the evidence store, and the report layout.
