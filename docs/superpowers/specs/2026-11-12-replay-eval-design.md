# Replay eval (INF-185)

Date: 2026-11-12. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`. Amended 2026-11-14: part 1, the captured tasks of part 2, and owner decision 5, for the capture slice (delivery step 1). Amended 2026-11-21: parts 2 and 5 to 8, and acceptance 3, 10, and 11, for the comparison slice (delivery step 4).

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
  capture?: boolean                       // amended 2026-11-14: turns capture on
  testPaths?: { prefixes: string[], suffixes: string[] }  // amended: optional at this stage
  retentionDays?: number                  // amended 2026-11-14: 30 to 3650, default 365
  mine?: boolean                          // amended 2026-11-16: turns mining on; read only for github projects
  gradingPaths?: string[]                 // runner configuration, package scripts, test helpers; amended: optional at this stage
  focusedTest: TeamCommand                // argv with {files} and {report} placeholders
  reportFormat: "junit" | "tap"           // what focusedTest writes to {report}
  guardChecks?: TeamCommand[]             // default: the configured checks
  excludeAreas?: string[]                 // interface areas (contract C4); amended: optional at this stage
  candidateProfiles?: TeamModelProfile[]  // approved for replay only
  memberProfile?: string                  // launch profile of the eval identity
  // amended 2026-11-16: no graderProfile. The grader is host configuration, eval.grader (Part 4).
  trialMinutes: number                    // default 45
}
```

The harness replaces `{files}` with the hidden test paths and `{report}` with a file outside the checkout. A job may test a profile only from the project's lineup pools or from `candidateProfiles`, which no prompt shows. *(My call: the owner can measure a new model before it receives real work.)*

*Amended 2026-11-14 (capture slice).* The first slice parses four fields, all optional: `capture`, `testPaths`, `excludeAreas`, and `retentionDays`. `capture` turns capture on, and the host reads it only for a `github` project. `retentionDays` is the number of days a captured task is kept. Without `testPaths`, the host's test-path rule applies. The other fields above are parsed as optional in delivery step 2, and a job that needs one refuses to start until it is set. *(My call: a block written for this slice stays valid when step 2 adds fields.)*

*Amended 2026-11-16 (mining and validation slice).* `mine` turns mining on, and the host reads it only for a `github` project. `gradingPaths`, `focusedTest`, `reportFormat`, and `guardChecks` are optional in the stored block. A validate job refuses to start until `focusedTest` and `reportFormat` are set, and it reads the other two as they are. The grader is host configuration, `eval.grader`, with its probe and canaries (Part 4). A project has no grader field, so `graderProfile` is removed. A launch profile in the code belongs to a provider session, not to a host command. `candidateProfiles`, `memberProfile`, and `trialMinutes` wait for the trial step. *(My call: the grader is one account for every project, so a per-project field would name a choice the host does not make.)*

*Amended 2026-11-18 (trials slice).* `trialsPerDay` (1 to 50) is the owner's stand-in for the learning budget. Absent, it is off: no trial starts, and a baseline job is refused `eval-config-incomplete`. `trialMinutes` defaults to 45 and takes 10 to 240 minutes. `candidateProfiles` takes up to 8 profiles, approved for baseline jobs only. `memberProfile` is removed. The eval identity is host configuration, `eval.member`, with one launch profile per provider (Part 4). *(My call: one eval account serves every project, so its launch profile is one host setting.)*

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

**Captured tasks.** *Amended 2026-11-14 (capture slice):* At integration the host writes a marker row and returns. Two binary patches and their name lists are read in the background, from the integration checkout: one from the run's `baseCommit` to the member's `baseCommit`, and one from there to the task commit. The reads start at integration and finish in the background, so no read delays, takes a slot from the enrichment limit, or fails the integration. The host reads the patches with a streaming reader, because `teamCommand` truncates output. A failed or refused patch leaves that part missing, and the task is rejected `patch-missing`. *Amended 2026-11-14 (capture slice, after the first review):* an empty reference read counts as missing too, because a captured task has at least two files; an empty base delta stays stored. A failed name read records `capture-failed`. The capsule keeps only the steering entries and owner answers dated before the member started. A capsule over 64 KiB is refused, never cut.

A captured task becomes a `candidate` when four conditions hold:

1. The outcome ledger marks its attempt `accepted`.
2. The run's `baseCommit` is on the mirror's base branch. *Amended 2026-11-14: the host runs form 1 of the base scan, `git merge-base --is-ancestor`, in the mirror against the mirror's head. Only exit 0 proves it. Any other result is `base-not-proven`.*
3. No later commit of the run changed a file in the task's reference. *Amended 2026-11-14: the check uses the capture's own name read of the reference, up to 500 names. It does not use `changedPaths`, which the code caps at 200 paths and marks `truncated`.*
4. The reference changes at least one test file and one other file.

Otherwise it is `rejected` with one reason code. *Amended 2026-11-14:* the start codes are `ui-changes`, `start-unknown`, `capsule-too-large`, `excluded-area-unknown`, and `capture-busy`. The material codes are `capture-failed`, `reference-too-wide`, `excluded-area`, `no-hidden-tests`, `patch-too-large`, and `corpus-full`. The promotion codes are `ledger-missing`, `ledger-withheld`, `excluded`, `same-model-review`, `not-accepted`, `acceptance-unknown`, `patch-missing`, `reference-unknown`, `reference-ambiguous`, `base-not-proven`, `features-unknown`, and `unreadable`. The reason table is in `docs/teams.md`, under Eval capture.

When `deleteRecord` removes a run whose status is `cancelled`, the host deletes that run's captured tasks in the same step. *(My call: a deleted cancelled run leaves no data.)* *Amended 2026-11-14:* the store's `deleteRun` hook makes the decision. A run with no readable status counts as cancelled, because keeping text for a run whose fate is unknown is the riskier error. Any other status stamps the tasks with a deletion time, and the eval retention removes them later (contract C1). *Amended 2026-11-14 (capture slice, after the first review):* the rule is a keep list, not a delete list. A deleted run keeps its tasks only when its last `run.deleted` or `run.settled` status is `merged` or `no-change`. Any other status (`cancelled`, `blocked`, `ready-for-review`, or anything else), no status event, or an event that does not open deletes the tasks and their sealed material. The host deletes a run record only when the run is cancelled, merged, or no-change, so another last status means that later events were lost. A `blocked` run keeps no tasks, because a run that stayed blocked may never reach its `run.deleted` event.

**Mined tasks.** A scanner walks the first-parent history of the base branch in the mirror, newest first. A commit yields a `candidate` task when its diff against its first parent changes at least one test file and one other file. The diff must stay under 30 files and 1,500 changed lines, must not be a revert, and must touch no excluded area. The first parent is the anchor.

If a kept run record has `deliveryReceipt.mergeCommit` equal to the commit, the capsule takes that run's objective and brief (`run-objective`). Otherwise it takes the commit message (`commit-message`). The host does not read Linear here, because `LinearService` cannot cut an issue's text at its creation time. The task's `paths` are the parent directories of the files the reference changes. A mined task has no coordinator label, so its kind is null.

*Amended 2026-11-16 (mining slice).* A pass mines at most 50 commits. It takes the commits added since its last pass, oldest first, and then backfills older first-parent commits, newest first, until 2,000 are visited. A refused, failed, or timed-out read mines nothing for that commit, keeps the cursor, and ends the pass. A commit that changes no test file, or no other file, leaves no row. A mined capsule takes the objective and brief of the run whose `deliveryReceipt.mergeCommit` equals the commit, when a kept run record says so.

**Provenance groups.** Tasks that derive from one change share a group. Set assignment, holdout rotation, and every exclusion act on whole groups. A run's captured tasks form one group. A mined commit joins it when the run's `deliveryReceipt.mergeCommit` equals the commit, or when the outcome ledger's base branch scan matched the commit to the run. The mined task is then `rejected` with `duplicate-of-captured` while the group has a `candidate` or `valid` captured task. Any other mined commit is its own group.

*Amended 2026-11-16 (mining slice).* Lineage counts a captured task only when it was captured within 90 days before the commit and approved before it. A commit that would merge more than 64 groups, or that has more than 1,000 captured rows on one path in that window, is rejected `lineage-too-wide`. A merge takes the smallest group id as its root. A mined group's id begins with `mined:`, so a mined group is the root of any merge with a run group. A landing joins its mined copy without the dev-only mark. The duplicate rule applies after each mined insert, each merge, and each captured promotion.

A mined commit with unclear lineage never enters the holdout set. Its lineage is unclear when it changes a file that a stored reference patch of some run's captured tasks also changes, that run was approved before the commit, and that run has no observed landing. The host reads the files from the stored patches, because `TeamTask.changedPaths` can be absent or truncated. The mined task then joins that run's group. When several runs match, their groups merge into one. The mined task is rejected while the group has a `candidate` or `valid` captured task, as above. Otherwise it is kept with the mark `lineage-unclear`. A group that holds such a task, or that was merged this way, is assigned to the dev set only. *(My call: a pull request delivery records no merge commit, and a squash merge onto a moved base matches no exact rule, so the host cannot prove that such a commit is a new change.)*

**Validation.** A `validate` job runs host commands only and spends no model tokens. A candidate becomes `valid` when:

1. With the whole reference applied, the runner report lists passed cases in the hidden files. They become the expected cases. On the replay base with the hidden files added, at least one of them fails or is absent.
2. The guard checks pass with the reference applied.
3. Three reference runs pass the same expected cases, and two base runs both show the failure.
4. The focused test run finishes within ten minutes.

Validation commands run as the grader identity (Part 4), so a test that needs a network or a listener its launch profile denies fails there. A failed candidate is `rejected` with `not-fail-to-pass`, `guard-failed`, `flaky`, or `too-slow`.

*Amended 2026-11-16 (validation slice).* The focused test receives only the hidden files, so every case in its report counts as a case of those files. The rounds run in this order, and the first decision stops them: R1 with the reference, which fixes the expected cases E; the guard checks on a fresh reference copy; B1 on the base; R2 on the reference; B2 on the base; and R3 on the reference. A base round uses Part 5's construction on the replay base: the hidden files and the `gradingPaths` files are taken from the reference. So an unchanged base fails. R2 and R3 must pass exactly E. B1 and B2 must each leave a nonempty set of E unpassed, and the two sets must be equal. A focused test's exit code never validates a task. A round without a parsable report is undecided, not a failure. Three undecided attempts end a task `unvalidated`. The reasons are in `docs/teams.md`, under Eval mining and validation.

A scheduled revalidation retires a task whose reference stops passing, whose anchor leaves the mirror, or whose group gained a captured task. A seeded hash puts 30% of groups in the holdout set and the rest in the dev set. *(My call.)* An exposed group belongs to the dev set: it joins it, or moves to it at once. No group ever moves from the dev set to the holdout set.

*Amended 2026-11-21 (comparison slice).* The set and the exposure flag live on the group's root row, not on the task: `holdout`, `exposed`, `set_at`, and `confirms`. A task's set is its root's set, and a task without a group row is in the dev set. `EvalTask.set` and `EvalTask.exposed` are read from the root. The host draws the set once, when it creates the group row, as `tx.index("eval-set", groupId)`, an HMAC under the vault key. The group goes to the holdout set when the first 8 hex digits, read as an unsigned integer, are below 1,288,490,189, the ceiling of 0.3 × 2³². The migration draws every existing root the same way. It puts a root in the dev set when it has the dev-only mark, or when one of its tasks already has a trial row. A merged root is in the holdout set only when every merged root was, none had the dev-only mark or was exposed, and the merge does not set the dev-only mark. Otherwise it is in the dev set, and no row of it keeps `holdout`. `exposed` is the largest value of the merged roots. Eval corpus version 3 also stores each task's prompt origin and kind in plain columns, so a report never opens a sealed payload. *(My call: one row per group cannot let a group span both sets, and the vault key keeps the draw unknown to anyone without the key.)*

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

*Amended 2026-11-18 (trials slice).* A member that exits without a report ends its trial `no-result`, a member failure that counts as not resolved, not a void. A replay run never sets `run.permissions`, so no permission coordinator starts. The project's permission pipeline decides its dialogs, and for a project the host permission agent serves, that agent does. A dialog that nobody decides ends the trial `permission`. Besides the table's exclusions, `listSessions`, the notifier's session pushes, the provider-limit memory (`limits.reconcile`), and project activity skip learning sessions and replay runs. `get` and `objectiveRecord` answer `404` for a replay run. A replay run's record is deleted once its trial is final, and its session an hour later. *(My call: one live session per eval identity, and no component answers a prompt that the pipeline left undecided.)*

### Part 4. Leakage controls

Two accounts isolate a trial. Each serves every project, so each control below covers all projects. The **eval identity** runs replay members with its own provider logins. The **grader identity** runs validation and grading commands with no provider login. Neither holds a repository credential. *(My call: an account without logins is cheap, and cleanup after graded code that ran beside the hidden tests cannot be trusted.)*

**Trial source.** The harness makes a staging clone of the mirror and points one branch at the replay base. For a captured task it first applies `baseDelta` and makes one host commit. It streams a bundle of that branch through the host, as `spawnTeamBundle` does for run branches. A bundle holds only the objects its branch reaches. The trial's checkout is cloned from the bundle.

| Channel | Control | Probe before launch |
|---|---|---|
| Later commits in the clone | The one-branch bundle | `git cat-file -e` fails for the reference commit and the mirror head |
| Mirror, project checkouts, production team roots, production agent home | The eval identity cannot read them | It cannot read a canary file in each, and its fetch of the repository fails |
| Hidden tests and grading clones | Hidden material leaves the evidence store only into the grader's root. The eval identity cannot read that root, the grader's home, or its temporary directory | It cannot read a canary file in each. The trial workspace holds no hidden file content |
| Other sessions, of any project | One live session per eval identity: a trial member or a duel judge. The host removes the previous session's workspace and package first | The eval root holds no other workspace |
| Surviving processes | The host stops every process of the eval identity between sessions | No process runs under the eval identity |
| Local provider state | After usage capture the harness removes what a session left in the eval home | The eval home holds no session history and no memory file |

The harness lists and stops processes by user with the means in `packages/host/src/team-retirement.ts`. It removes each grading clone when its commands end. The clone has no remote, as today. Recall tools are off, guidance is as of the base commit, and prompt text is fixed at the time of the work.

**What no probe covers.** The host cannot inspect history or memory that a provider holds on its own side for a login. The `isolated` label makes no claim about it. The owner sets up the eval logins with those features off where the provider offers that, and uses the logins for nothing else. This design also adds no egress filter, so a project with a public repository cannot reach `isolated`.

When every probe passes, the trial is labelled `isolation: "isolated"`, otherwise `none`. A trial labelled `none` never enters a prior export or a gate receipt. Local trials are always `none`.

*Amended 2026-11-16 (mining and validation slice).* The grader is one account for every project, and a launcher runs every validation command as that account. The launcher admits eight operations, and it confines each to the grader's root: `probe`, `receive`, `run`, `read`, `digest`, `stop`, `clean`, and `remove`. Before each task the host probes the account. The probe requires a different user id from the host's, a root of mode `0700` owned by the grader, no writable directory above the root, the tools the launcher needs, no readable canary, and a closed metadata address. The probe's states are `ready`, `not-configured`, `unavailable`, `misconfigured`, `exposed`, and `network-open`. A state other than `ready` starts no task. The host runs `stop` only after a probe in the same process has answered `ready`. The install and its checks are in `deploy/ubuntu/grader.md`, and the loopback services and their credentials are in `docs/security.md`.

*Amended 2026-11-18 (trials slice).* The trial source is built by the grader, not in a staging clone of the mirror. The grader's `export` streams a bundle of the trial branch at the replay base. The eval launcher's `prepare` clones it, removes its remote, checks out the commit detached, and deletes the branch. Before launch, `check` proves the absence of the objects in the table above. The eval launcher, `deploy/ubuntu/eval-command.sh`, runs one operation as the eval account under its root: `probe`, `receive`, `prepare`, `check`, `exec`, `setup`, `stop`, `clean`, and `scrub`. It starts every command with an empty environment, and only `setup` adds the host's egress set. Before each trial the host runs the stop rounds, then `clean` (the trials root, the temporary directory, and every root entry except `trials`), then `scrub`, which resets the home from a root-owned template and keeps only the login files. Then it runs `probe`, which counts each leftover, and any trial or leftover makes the state `busy`. The login files stay writable by the member, because providers rewrite them on refresh, so they remain a channel between trials, which the design accepts. A cron or `at` job would outlive `stop`, so the owner denies both to the account. Two egress identities apply: `_eval` for the member and the probe, and `_eval-setup` for the project's setup command. Each one has only its own list in the policy's `projects` map (`deploy/ubuntu/egress.md`, section 6). A trial can be labelled `isolated` only in enforce mode, because the proxied fetch succeeds in observe mode. *(My call: no new `teams.commandPrefix` form, and no eval material in a directory the agent account can read.)*

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

*Amended 2026-11-21 (comparison slice).* The calibration read marks the group of each task it returns as exposed, in the same write. It admits dev tasks only, and it returns at most 20 pairs per call. Its only reader is a judge member, and a read without the mark would leave the rule to every caller.

A later phase adds a blind rubric from the project's reviewer profile, which must differ in model from the trial's profile (contract C9 rule 4).

*Amended 2026-11-18 (trials slice).* The result is read as a binary patch of at most 1 MiB through the eval launcher, and the host sends it to the grader as `result.patch`. The grader starts from the result tree, then restores from the reference the hidden files and every test file or `gradingPaths` file that either side changed. `overwritten` counts the result's changes to those files. `TrialGrade` holds `expectedPassed: number | null` and `diff: {…} | null`. Null is unknown, never zero, and a null `expectedPassed` never resolves. A result over 1 MiB ends `scope-violation`. A result patch that matches a secret shape is dropped (`patch: "secret-shaped"`), and the grade is kept. *(My call: the reader already streams with a limit, the grader already applies patches, and a patch carries no object the base lacks.)*

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

A job has the shape of a routine in `RoutineService`. The owner creates one. In an `autonomous` project, the host's learning scheduler also creates one inside the standing learning budget (delegated adoption design, Part 9). A job expires within 30 days. The improvement gate may create one inside the limits of a gate job that the owner approved. The host pins a digest of the project policy, the host policy, the eval configuration, and the prompt version. A change blocks the job with `configuration-changed`. Before approval the host shows the trial count, the estimate that it would reserve per trial, and whether that estimate is measured or the fallback.

**Learning budget.** This design owns the learning budget of contract C8. It is a standing weekly share of the project's spend fuse (C13), decided on 2026-11-13. The owner may set it in the project's private team configuration, in the shape that the delegated adoption design gives (Part 9):

```ts
type LearningBudgetConfig = {
  fuseShare?: number            // share of each weekly project fuse ceiling; absent: 0.25
  shares?: { duel: number, replay: number, gate: number }  // absent: 0.2, 0.5, 0.3; sum at most 1
  weeklySpentUsd?: number       // metered share; absent: fuseShare of the weekly metered ceiling
  fallbackEstimate?: { tokens: number, listUsd: number, spentUsd: number }  // per session with no usage history
}
```

The block is outside the routine authority digest: umbrella C11 removes it from the digested object before hashing, so an owner change to it leaves every routine approval valid. Its keys stay optional, and the code applies the values above at read. A `supervised` project without this block has a budget of zero, so no session with a learning purpose starts there. An `autonomous` project without it has those values. A `validate` job spends no model tokens and needs no budget. A purpose's share of the budget is its cap. The other designs call them the duel cap and the gate cap.

Three host-internal functions serve this design, the duels design, and the improvement gate design:

- `reserve(projectId, purpose, estimate)` takes an estimate in the fuse's three units: tokens, `listUsd`, and `spentUsd`. It succeeds while the week's settled and reserved amounts for that purpose stay inside every cap.
- `settle(reservationId)` replaces the estimate with the usage of the reserved sessions, read from the usage ledger. A session with `complete` usage coverage settles at its measured usage. Any other session settles at its estimate, or at its measured usage when that is larger, and is labelled so.
- `status(projectId)` returns the caps and, per purpose, the settled, reserved, and estimated amounts.

An estimate is the median usage of the profile's earlier sessions in the project that have `complete` usage coverage. With no such session, or for an amount that cannot be priced, it is the owner-set `fallbackEstimate`. With no fallback configured, `reserve` refuses, and the job pauses with `estimate-unavailable`.

Reservations are rows in the evidence store. The period is the spend fuse's week (C13).

The host checks the job limits and reserves from the learning budget before each trial starts. It cannot cap tokens inside a session, so a job can exceed a limit by the trials already running. An exhausted limit pauses the job with `budget-exhausted`.

*Amended 2026-11-16 (mining and validation slice).* A validate job has its own request shape: `kind`, `taskFilter` (task ids, origins, areas, `revalidate`, and `maxTasks`), `limits.maxWallMinutes`, `windows`, and `expiresAt`. It runs no trial and renders no prompt, so it has no `purpose`, `configurations`, `trialsPerTask`, or budget limit. Its pinned digest covers the fields that decide a validation: the validation settings, the team's setup and guard checks, and `eval.grader`. It does not cover the prompt version or the permission policy. A change to a pinned value blocks the job with `configuration-changed`, and the owner's `resume` pins the new values.

No trial starts while its provider has an active limit in `ProviderLimits` or headroom below the learning floor (delegated adoption design, Part 9), while any run has an open duel, outside the job's windows, or when fewer than four host session slots are free. *(My call: real work keeps priority.)* A later job reuses a valid trial under 30 days old when the eval task, the `configId`, the profile epoch, and the harness version match. The harness version changes with grading or the trial lifecycle. A `confirm` job never reuses a trial.

*Amended 2026-11-18 (trials slice).* A baseline job has `configurations` (one to four, each `{ profile, guidance: "as-of-base", knowledge: "none" }`), `taskFilter` (task ids, origins, areas, and `maxTasks`, default 20), `trialsPerTask` (default 3), `limits: { maxTrials, maxWallMinutes }`, `windows`, and `expiresAt`. It has no `purpose`, `set`, `excludeGroups`, `promptOrigins`, or USD limit. Its pinned digest covers the validation settings, `trialMinutes`, `eval.grader`, `eval.member`, each prompt version, and the permission settings. A trial starts only when the eval identity is `ready`, the grader is `ready` at launcher version 2, the job's window and the host load allow it, no other job's trial runs, its provider has no active limit, four host session slots are free, and the project has trials left under `trialsPerDay` today (UTC). The learning floor and the open-duel gate wait for their designs. No trial is reused yet. *(My call: the stand-in cap is the smallest bound on spend that exists, and the gates are the ones that exist.)*

*Amended 2026-11-21 (comparison slice).* A `compare` or `confirm` request has `kind`, `configurations` (2 to 4 for `compare`, exactly 2 for `confirm`), `taskFilter` (task ids, origins, areas, `promptOrigins`, `excludeGroups`, and `maxTasks`), `trialsPerTask`, `limits: { maxTrials, maxWallMinutes }`, `windows`, and `expiresAt`. It has no `set` field: the kind fixes the set, and a `confirm` request admits no task ids. When the owner creates the job, the host selects its tasks in task id order, at most `maxTasks` (default 20, at most 200), and seals the list in the job. The `POST` is the approval. A `compare` job needs 2 selected tasks and a `confirm` job needs 15, or the host refuses with `409` `too-few-tasks`. The reuse of this part is decided at creation, for `compare` jobs only. A source is a final, non-void original trial of a `baseline` or `compare` job that ended within 30 days and matches the task, `config_ref`, harness version, prompt version, and profile epoch. Each source fills one slot of the new job as a copy row that records the trial it copies. A copy counts toward neither `maxTrials` nor `trialsPerDay`, and a `compare` job whose every slot is a copy completes at creation. `configId` includes the guidance digest at the task's base, which a job does not know before the run. The task, `config_ref`, and prompt version decide it, because the task's base fixes the guidance. *(My call: reuse at creation keeps the count shown before approval honest.)*

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

*Amended 2026-11-21 (comparison slice).*

- **Pairs and Holm.** A job with more than two configurations reports every pair `a < b`, and the difference is `b` minus `a`. The design names no control configuration. Holm adjusts over all pairs of one figure: the whole job, or one subgroup.
- **The sensitivity figure.** It covers the tasks with at least one final trial in every configuration. A slot without a valid, matching, resolved trial counts as not resolved. The figure is the mean difference of `resolved / trialsPerTask`. A void slot never got a valid trial, so this is "every void trial counted as not resolved" without counting retries twice.
- **Pins.** At creation, a comparison job pins the profile epoch of each configuration and its prompt version. Before each trial, a changed epoch or prompt version ends the job `completed` with reason `identity-changed`. Another digest change blocks it `configuration-changed`, as for a baseline job. The statistics count only trials that match the pins, attrition counts the others as `changed`, and a trial with an unknown epoch never matches.
- **Rotation.** `confirms` counts the confirm jobs that listed a task of the group, and grows at creation. The 120 days count from the time the group was drawn into the holdout set. The hourly sweep moves at most 100 roots per pass, and moves none in a project that has a confirm job without a report. *(My call: a group must not leave the holdout set while a confirm job still reads it.)*
- **The subject.** A `confirm` request names no subject. Its subject is the SHA-256 of the canonical JSON of its two pins, `{ configRef, profileEpoch, promptVersion }`, sorted by `configRef`. The host writes the subject row at creation and never removes it, so a cancelled, expired, or failed confirm job uses its subject too. A new epoch or prompt version is a new subject. Change-candidate subjects arrive with the improvement gate. *(My call: the host cannot tell an honest cancel from a peek at the holdout set.)*
- **Reports of a confirm job.** A confirm report counts a task only while its group is still in the holdout set when the report is written. A task whose group was exposed or merged into the dev set during the job counts as `leftHoldout` and lowers the share. A report and its prior rows never change after they are written.
- **Costs.** The code has no list-price table. The usage ledger's cost is `spentUsd` for every profile, and `listUsd` is null. The pump reads a trial's tokens and cost from the ledger before it removes the trial's session.
- **Planning figures.** The simulation of power that this part asks for before the first `confirm` job is not part of the comparison slice. The planning figures stay estimates.

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

It covers `isolated` dev set trials, or the trials of a prospective `confirm` comparison. An export reaches the router only as an adopted routing prior (C15, delegated adoption design Part 8). Trials of one task are not independent, so `tasks` is the sample size.

The corpus summary shows task counts by state, origin, set, and area. It also shows coverage: the share of accepted production attempts that have a valid eval task.

*Amended 2026-11-16 (mining and validation slice).* This slice ships `GET projects/:id`, `GET jobs`, `GET jobs/:id`, `POST jobs`, the pause, resume, and cancel controls, and `POST tasks/:id/retire`. It ships `infinite eval status`, `run PROJECT --file job.json --request-id UUID` (the route body is `{ projectId, requestId, job }`), `job`, `pause`, `resume`, `cancel`, and `retire`. The priors and report routes and commands arrive in later steps.

- **API.** Under `/api/eval`: `GET projects/:id`, `GET projects/:id/priors`, `GET jobs`, `GET jobs/:id`, and `GET jobs/:id/report`. Owner only: `POST jobs`, `POST jobs/:id/pause`, `resume`, and `cancel`, and `POST tasks/:id/retire`. A task listing shows each task's group. No route returns a capsule, a patch, or a hidden file.
- **CLI.** `infinite eval status PROJECT`, `infinite eval run --file job.json --request-id UUID`, `infinite eval report JOB`, and `infinite eval priors PROJECT`, each with `--json`.
- **MCP.** None. No member can read eval data (contract C9 rule 3).

*Amended 2026-11-21 (comparison slice).* This slice ships `GET jobs/:id/report` and `GET projects/:id/priors`, each for the owner, a controller, and a viewer, and `infinite eval report JOB` and `infinite eval priors PROJECT`. A relay device reads neither. A report names each configuration by its index, `profileId`, provider, profile epoch, and prompt version, and never by model. It holds counts, means, intervals, P values, attrition, and cost, and the same figures per area and prompt origin with their n. It holds no task, group, trial, or session id. The priors read returns `ReplayPrior` as shaped above, model included, because the router needs it to match a prior to a profile. `profile.model` and `profile.effort` are `string | null`, and a null stays null. The host stores the provider, model, and effort of a prior row as plain columns, as it does for `configurations`. A report and its prior rows are kept 365 days. The prior export covers the trials of `baseline` and `compare` jobs. It leaves out reused copies: the job that ran a source trial exports it, so a `compare` job's rows count only the trials that job ran itself, and a `compare` job whose every slot is reused writes a report and no prior row. The prospective `confirm` comparison needs the registered base head of the delegated adoption design (delivery step 7), so its trials reach no export in this slice. *(My call: a report never names a model, because a report is read by more roles than the router.)*

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
3. A captured task and the mined commit of its run's merge share a group, the mined task is rejected with `duplicate-of-captured`, and no group spans both sets. *(Amended 2026-11-16: the clause "no group spans both sets" moves to delivery step 4, which creates the two sets. Step 2 proves the shared group and the duplicate rejection, and stores the dev-only mark for step 4 to read.)* *(Amended 2026-11-21: the clause is met. A group's set is drawn when its row is created and a merge keeps one set per root, so no group has a task in each set.)*
4. In a prepared trial workspace, `git cat-file -e` fails for the reference commit, `git remote` prints nothing, and no hidden file content exists.
5. No trial starts while a process runs under the eval identity, or while another session's workspace, of any project, exists in the eval root. Without both launch profiles a trial is labelled `none`, and the prior export omits it. *(Amended 2026-11-18: without `eval.member` or a grader at launcher version 2, no trial starts. The label `none` covers isolation only.)*
6. A replay run makes no publication, Linear, or notifier call, and `GET /api/teams` does not list it.
7. A trial whose member applies the reference is `resolved`. A result that makes `focusedTest` exit zero without running the hidden tests is not. A result that edits a file under `gradingPaths` is graded with the reference's file and reports `overwritten` above zero.
8. An empty result ends `no-result`, an edit outside the task's paths ends `scope-violation`, and an undecided permission prompt ends `permission`. A provider limit voids the trial, and it runs again.
9. `reserve` refuses when a profile has no usage history and no fallback estimate exists. A job starts no trial after its `maxTrials` or its learning budget is exhausted. *(Amended 2026-11-18: the `reserve` clause moves to delegated adoption delivery step 4, "The standing budget". This slice's clause is that a job starts no trial after its `maxTrials`, or after `trialsPerDay` trials today.)*
10. A report on a fixed result set prints the same interval on every run, with attrition per configuration and the sensitivity figure. Below the 90% share it reports the comparison as inconclusive. *(Amended 2026-11-21: met by the stored report. Its interval is seeded from the job id, and it is the same on every read.)*
11. The host refuses a second `confirm` job for one subject. The calibration read returns no pair from a holdout task and at most one pair per eval task. *(Amended 2026-11-21: the calibration read also marks the group of each returned task exposed.)*

## Owner decisions

1. **Decided 2026-11-13:** add both accounts, the eval identity and the grader identity. Without them the improvement loop cannot run.
2. The setup of the eval logins: provider-side history and memory off where the provider offers that, and no other use. The host cannot check it.
3. When replay may spend subscription limits. **Decided 2026-11-13:** the cap is the replay share, 50% of a standing budget of a quarter of the weekly fuse. Still open: the windows and the fallback estimate.
4. Whether tasks with a `commit-message` prompt may feed router priors. The export keeps them apart either way.
5. How long eval material stays in host state, and whether a captured task may outlive the deleted record of a cancelled run. The default for the second is no.
   *Amended 2026-11-14: the defaults that the capture slice ships. The owner has not decided them, and they stand until the owner changes them.* Eval material stays 365 days, set per project by `retentionDays` (30 to 3650). A captured task does not outlive a deleted run that did not merge, need no change, or reach review (*amended 2026-11-14, after the first review*). Caps: a capsule is 64 KiB, a patch is 1 MiB, a project holds 20,000 tasks and 128 MiB of material, and the host holds 512 MiB of material.

## Left to the builder

- The exact points in `TeamService` that seed a plan and settle a replay run.
- The streaming patch reader, the commands that build a staging clone and its bundle, and how a bundle passes between the three identities.
- The report parser for each `reportFormat`, and the form of a case identifier.
- Launcher admission for the added Git operations.
- Removal of local provider state after usage capture.
- Table definitions in the evidence store, and the report layout.
