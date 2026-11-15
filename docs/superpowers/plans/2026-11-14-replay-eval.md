# Replay Eval Implementation Plan (INF-185)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure a configuration by replaying real, accepted project tasks against hidden tests, so routing and prompt changes rest on evidence.

**Architecture:** `TeamService` tells a capture sink when an implementer's commit is integrated and when a review approves. The sink keeps the task's prompt inputs and its patches as sealed rows of an `eval-corpus` module in the evidence store, and promotes a task to `candidate` when the outcome ledger counts its attempt as accepted. Later slices mine the base branch, validate candidates as the grader identity, and run trials as the eval identity.

**Tech Stack:** TypeScript, `zod`, `node:child_process`, `node:test`. The evidence store of INF-182 and the outcome ledger of INF-184.

**Spec:** `docs/superpowers/specs/2026-11-12-replay-eval-design.md`, under the shared contracts in `docs/superpowers/specs/2026-11-12-self-improving-teams-design.md` (C1, C4, C5, C9, C11).

This plan grows one section per slice. Each slice is one pull request.

## Global Constraints

- Node.js 22.14 or later. No new dependency.
- Capture observes. No `TeamService` decision reads the corpus, and a capture failure never changes a run or what a member sees.
- Eval material stays sealed in the evidence store. It never enters a tracked file, a mirror ref, a log line, an error body, or a member's prompt (umbrella C9 rule 8).
- Eval settings stay out of the routine authority digest (umbrella C11).
- Every Git command goes through `teams.commandPrefix`. A new form waits for the owner's launcher approval, and the fact it reads stays missing until then.
- No home path, host name, account name, or secret in any tracked file (`AGENTS.md`).
- Focused tests run with `node --import tsx --test tests/FILE.test.ts`. The full check is `npm run check`.

## Slices

| Slice | Content | Needs |
|---|---|---|
| Capture | Capsules and patches for integrated tasks, promotion on `accepted`, deletion with cancelled runs. This section | evidence store, outcome ledger |
| Mining and validation | The scanner, provenance groups, the `validate` job, the corpus summary, `infinite eval status`. No model tokens | Capture; the grader identity |
| Trials | The replay run kind, the trial source, the probes, grading, `baseline` jobs, outcome rows | Mining and validation; the eval identity |
| Comparison | `compare` and `confirm` jobs, the two sets, reports, epochs, the prior export | Trials |
| Run-level replay | A whole team from a recorded objective, and the blind rubric | Trials |

---

# Slice: capture

Spec part 1 (the `eval` block, capture fields only), part 2 (captured tasks), and part 4 (what must not leak), delivery step 1, with acceptance 1. After it, an owner turns on capture for a GitHub project, and every integrated implementer task leaves a sealed capsule, two patches, and its file lists in the evidence store. A task becomes `candidate` once the outcome ledger counts its attempt as accepted, or `rejected` with a code. Nothing spends model tokens, starts a session, or reads the corpus for a decision. It builds on the evidence store, the event outbox, and the outcome ledger, which are on `main`.

Where the design and the code disagree, this plan rules:

- The design reads the patches "in the host step that records `TeamTask.commit`". That step is the synchronous completion callback of `this.operation` in `teams.ts`, and Git reads are asynchronous. **Ruling:** the step writes a marker and starts the reads, which finish in the background.
- Condition 3 names `changedPaths`. The code caps that list at 200 paths and marks it `truncated`. **Ruling:** the check uses the capture's own name read of the same range, up to 500 names, so a truncated list never hides a later change.
- Condition 2 needs to know whether the run started from the mirror. `createRun` keeps that in the local `fromMirror` and never stores it. **Ruling:** the host checks the anchor with base-scan form 1 in the mirror.
- The design caps a capsule at 64 KiB, but a run's objective alone may hold 24,000 characters and a goal context much more. **Ruling:** a capsule over the cap is refused, never cut.
- The launcher admits no Git form that prints file content (the design leaves admission to the builder). **Ruling:** one new form, under "Git commands".
- `withoutFeatures` in `team-prompts.ts` copies every other key of the team block into a member's context, so an `eval` block would reach members. **Ruling:** it also drops `eval` (Task 2).

**Rulings before the build.**

- Line numbers and "after this line" places in this section were read on main before the cost-coverage fix. Find each place by the quoted code.
- The patch form waits for the owner's launcher approval. The slice ships with capture off, and `docs/teams.md` says to turn it on only after that approval.
- The owner defaults stand until the owner changes one: 365 days of retention, a deleted cancelled run deletes its tasks, and the caps of Tasks 3 to 6.
- Nothing periodic may cost more as history grows. `reconcile` and `sweep` visit at most 100 rows a pass, and no list route or tick reads the corpus once for each run, member, or session.

**Rulings after the first review.**

- **A deleted run keeps its eval tasks only when its last status says the work stands.** The `deleteRun` hook stamps `run_deleted_at` when the last `run.deleted` or `run.settled` event says `merged` or `no-change`. (The second review showed that no deleted run is `ready-for-review`: the host deletes a run record only when it is cancelled, merged, or no-change, so that status at deletion means that later events were lost.) Every other status, no event, or an event that does not open deletes the run's rows and material. Main now cancels a run that stayed blocked and keeps `blocked` as its last settled status on purpose; when that run's `run.deleted` event never reaches the store, `blocked` must not read as "keep". A list of the statuses that keep is also safe against a status that a later change adds.
- **The reconcile pass reads through an index.** It runs one query for each state, `WHERE state = ? ORDER BY checked_at, task_id LIMIT ?`, and takes the oldest `limit` rows of the two results. The index is `eval_tasks_check ON eval_tasks (state, checked_at, task_id)`. The module has never shipped, so `migrate(tx, 0)` changes and the version stays 1.
- **`insertMarker` checks the row cap only,** as Task 4 says. The byte caps apply in `completeMaterial`, whose two sums read the new index `eval_tasks_bytes ON eval_tasks (project_ref, material_bytes)`.
- **The hourly passes read through indexes too:** `eval_tasks_live_runs ON eval_tasks (run_id) WHERE run_deleted_at IS NULL` for `runIds`, and `eval_tasks_captured ON eval_tasks (captured_at, project_ref)` for the sweep's fallback.
- **A reference patch of zero bytes is `missing`.** A captured task has at least two files, so an empty reference means a read that failed without saying so.
- **The restart rule looks at material jobs only for material.** `failPending` gets the ids of the material jobs in flight for its material half, and the ids of the approval jobs for its approval half.
- **The patch form pins how a submodule change prints.** `--submodule=short` and `--ignore-submodules=none` follow `--no-renames`. A repository's own configuration (`diff.submodule`, `diff.ignoreSubmodules`, `submodule.NAME.ignore`) could otherwise change or hide a submodule change in the stored reference. The owner approves this form in the launcher once, so it is final here.
- **The patch form also pins its context** (`--unified=3 --inter-hunk-context=0`, after the submodule flags). A copy's own `diff.context` or `diff.interHunkContext` could otherwise grow every patch past the size limit, and a member that can write the copy's configuration could keep its tasks out of the corpus that way. This is the final form.
- **Host-run Git commands ignore replace refs.** `teamCommand`, `spawnTeamBundle`, and the patch reader set `GIT_NO_REPLACE_OBJECTS=1` when the command is `git`. A replace ref that a member plants in a team copy could otherwise make a capture read print another commit's content than the one that was integrated, and the same holds for the reviewed tree and the name lists that other slices read. Setup and check commands keep their environment. The production launcher sets the same variable, and `GIT_NO_LAZY_FETCH=1`, for the Git commands it runs (part of the launcher change that the owner approves); the host does not set the second one, because a developer's project source may be a partial clone.
- **Two tests pin what a refused read answers:** a refused patch form is `failed`, never `read`; a name list that `teamCommand` cut is `too-wide`, never a shorter list.

**Rulings after the independent review (round 1).** They replace every earlier line of this section that says otherwise.

- **The name reads of capture pin submodule changes too.** Both name reads (the reference's files, and the later changes of an approval) run `git diff --no-ext-diff --no-textconv --name-only --no-renames --ignore-submodules=none -z FROM TO --` (`namesArgs` in `eval-git.ts`). A copy's own configuration (`diff.ignoreSubmodules`, `submodule.NAME.ignore`) could otherwise hide a submodule change from the file list while the patch shows it. It could also hide a later change of the reference, so that a task whose reference changed later is promoted. This is a second new launcher form (see "Git commands"). While the launcher refuses it, every capture ends `capture-failed` and every later-change list stays unknown, so nothing is promoted. Test: `a copy's submodule setting hides no name`.
- **The sweep walks project references and never reads a row that it keeps.** A pass first maps each configured project's reference to its retention days. It then walks the references that have rows, in order. `NEXT_PROJECT_REF_SQL` finds the next reference with one seek. `PROJECT_OLD_SQL` reads that reference's oldest rows before its cutoff: the project's retention, or the fallback for a reference of no configured project. A pass visits at most `SWEEP_REFS_MAX = 64` references and deletes at most `limit` rows. The caller keeps a cursor (`{ after: string }`): the next pass goes on after the last reference that was finished, and starts over after the last one. When the row limit ends a pass, the next pass starts at that same reference again; a reference with a large backlog therefore keeps the walk until it is drained, and the other references wait that long. Nothing is lost by the wait. The separate loop over configured projects, `sweepFallbackSql`, and the index `eval_tasks_captured` are removed. A transaction that fails after the cursor moved loses nothing: the walk comes back to those references. Tests: `retention removes old tasks per project` (unchanged), `a sweep pass visits a bounded number of projects, and the next pass goes on` (it also shows that the walk starts over after its end), and `the periodic passes read through an index`, which now requires a `SEARCH` for both statements.
- **A patch child counts until it has exited.** `readPatch` resolves only when its child closes, as `teamCommand` does, or at once when the child cannot start. The answer is decided earlier, at the first of: the byte limit (`too-large`), the time limit, a stop by `close()`, or a stream error (all three `failed`). At that moment the reader destroys both pipes and signals the child's group. When the signal is refused (a launcher that runs the command as another account), the promise stays pending, and `TaskCapture.bounded` counts the read as stalled until the child ends. A refused child stops holding the process open one second later (`CAPTURE_RELEASE_MS`), not at once: on macOS the group of a child that has already ended refuses the signal too, and that child closes a moment later. `bounded` starts no Git call while `stalled >= CAPTURE_STALLED_MAX`: that call counts as failed. So at most `CAPTURE_STALLED_MAX + CAPTURE_CONCURRENCY` (6) capture children exist at one time, whatever the launcher does. The launcher also ends each capture read by itself (see "Git commands"). Tests: `a patch child that cannot be stopped counts until it exits`, `a refused stop of a child that has already ended still settles the read`, and one more block in `a stalled read refuses new work, never the run` (five held reads, then a sixth job that starts when four reads have stalled and makes no call).
- **Close stops the read chain.** `TaskCapture.close()` clears every pending deadline and settles its wait as failed (never as stalled), then calls `git.close?.()`. `bounded` starts no Git call after close. Deadline timers are unreferenced. `CaptureGit` gains an optional `close()`. `captureGit` implements it with one `AbortController`: a read in flight is stopped as far as the host may signal it, and a later call answers `failed` or `not-proven` without starting a child. A job that close interrupts writes nothing; the next process fails its row through `failPending`, as before. Tests: `closing stops the read chain` and `close stops the reads in flight`.
- **A capture read reports to no operation.** Since the restart-evidence change on main, `teamCommand` reports each command it starts to the `commandScope` of the operation that is running, and that scope writes the command into the run's record. A capture job can start inside such a scope, or after a job that did. `TaskCapture.pump` therefore starts every job with `commandScope.exit(() => job.run())`: a capture read is never recorded as a command of a run's operation, never waits for a run's save, and never causes one. Capture never changes a run. Test: `a capture read reports to no operation`.
- **Not changed.** `names` and `onBaseBranch` keep `teamCommand`: its promise already stays pending until the child closes, so `bounded` counts them the same way. Two points are outside this slice and are tracked as follow-ups: the other callers of the old name-list form, and the handles of a `teamCommand` child that the host may not signal.

**Capture is a marker plus background reads, and it never changes the run.** `TeamService` gains one option, `capture?: CaptureSink`, and calls it at two completion points: after `task.integrated` for an implementer with a commit, and after `review.recorded` with an approving verdict. Each call first asks `enabled(projectId)`, which is false unless the project's `eval.capture` is true, so a project without the setting does no work at all. Each call is inside `try`/`catch`. The sink writes a marker row synchronously and returns; its Git reads run on their own queue, with no slot of `ENRICH_LIMIT`. *(My call: the design places the reads in the integration step, but they must not delay the run, take its enrichment slots, or fail it.)*

**Promotion is a timer pass that waits for every fact, and it uses the ledger's own decision rule.** `TaskCapture.reconcile()` runs from the server's 60-second `advanceOutbox` timer. It reads the attempt's ledger row with `readOutcome` and judges it with `rowUse(row, "decision")`, so a backfilled, gap, unfrozen, excluded, or same-model attempt is never counted as accepted (umbrella C9 rule 4). Three facts arrive in any order: the capture reads (C), the approval read (A), and the frozen ledger row (R). Each is written once by its own completion, and the decision waits until none is pending, so every order ends in the same state. *(My call: a projector would have to wait for Git reads, and `deleteRecord` holds a run's record up to 24 hours while a projector is pending (`EVIDENCE_WAIT_MS`). A timer pass holds nothing.)*

**One new Git form, and a missing fact stays missing** (amended after the independent review: the name list of capture is a second new form, and while it is refused nothing is captured; see the rulings above)**.** The binary patch needs a `diff --binary` form that the launcher does not admit today. While it is refused, the host still keeps the capsule, both name lists, the approval read, and the base check; the material is `partial`, and promotion rejects the task with `patch-missing`, never a guess. Form 1 (`merge-base --is-ancestor`) proves condition 2 only on exit 0. Any other result, a launcher refusal included, gives `base-not-proven`, a code that claims only what is known.

**A deleted run keeps its tasks only when its last status says the work stands** (amended after the first review; see the rulings above)**.** The original rule follows. The module's `deleteRun` hook reads the run's last `run.deleted` or `run.settled` event, which is still stored because the store runs hooks before it deletes events. Status `cancelled`, or no readable status, deletes every row and all material of the run (owner decision 5, default). Any other status sets `run_deleted_at`, and the eval retention removes the rows later. *(My call: an unknown status deletes, because keeping text for a run whose fate is unknown is the riskier error.)*

**The setting is `project.team.eval`, outside the routine digest and outside every member context.** It is the "private team configuration" of spec part 1. `RoutineService.authority` removes the `eval` key before hashing, as `digestedTeams` removes `teams.outcomes` (umbrella C11). This slice parses only `capture`, `testPaths`, `excludeAreas`, and `retentionDays`, all optional. *(My call: `testPaths` falls back to the host's `isTestPath` rule, so turning capture on needs one key. `retentionDays` is new: spec part 2 names an owner-set eval retention without a home. Later slices add part 1's other fields as optional at parse and require them where a job needs them, so a block written for this slice stays valid.)*

## Trust boundary, and what a review checks

`TaskCapture`, the store module, and the rules are host code. These inputs originate outside the host:

- **The member's tree.** File names and contents of the task commit and of later run commits. Names arrive as NUL-separated Git output: at most 500 for the reference, 2,000 for a later-change read, and 64 KiB per read (`teamCommand` keeps the last 64 KiB and sets `truncated`, which counts as too wide). Names are sealed, never logged, never used as a host file path, and never put into a Git argument. Contents arrive only inside binary patches of at most 1,048,576 bytes each. This slice stores them as bytes and never applies, parses, or runs them.
- **The coordinator's plan.** The task's title (at most 100 characters), instructions (8,000), and paths (32 of 300), and the run's brief. Sealed in the capsule.
- **Owner and controller text.** The objective (24,000), steering, answered decisions, and the goal context, including its source issue's link and text. Sealed in the capsule. The capsule's canonical JSON is at most 65,536 bytes, or the task is refused.
- **Git and the launcher.** Exit codes and output only. A refusal, a time-out, a truncation, or a process the host cannot stop is a failed read. Every commit id comes from the run record and passes `COMMIT_ID` (`outcome-hold.ts`) before it enters an argument.
- **The ledger.** Rows the host wrote, read through `readOutcome`. Owner exclusions reach them as signals.
- **Owner configuration.** `project.team.eval`, through the owner-only `PUT /api/projects/:id/team` or the configuration file, checked by a strict schema.

The slice adds no route, CLI command, or MCP tool. Material leaves the store only through `readMaterial`, which only tests call in this slice. No member reads the corpus: `team-prompts.ts` and `team-mcp.ts` may import no `eval-` file (Task 2 extends the existing test), and member contexts drop the `eval` block. No log line or error carries a name, a commit, or any text. Besides the store's existing write-failure line, the one new log line is `Eval capture skipped (CODE).`, once per code per process, where CODE is an enumeration.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| Capture reads (C), approval read (A), and the frozen ledger row (R) in all six orders, for an accepted task with no later change, one with a later change, and a refused one | The same final row, material, and payload in every order: `candidate`; `rejected` `reference-ambiguous`; `rejected` `not-accepted` | Task 6 `the three facts give one result in every order` |
| The same integration reported twice | One row; the second marker changes nothing | Task 4 `a marker and its completion are written once` |
| A second approval after the first | The second's later-change read decides; the first read, if it ends later, writes nothing | Task 6 `a later approval replaces an earlier one` |
| A restart while reads are pending | Material `pending` becomes `rejected` `capture-failed`; approval `pending` becomes `unknown`, so an accepted task ends `reference-unknown` | Task 6 `a restart turns pending facts into failures` |
| An unavailable store, or an `eval-corpus` module that is not ready | `enabled` is false; no row, no read, no throw; the run is unchanged | Task 6 `an unavailable store takes nothing and throws nothing` |
| A captured task whose sealed payload does not open | `rejected` `unreadable`, material removed | Task 6 `unreadable records are never promoted` |
| A ledger row whose payload does not open | The task stays as it is and is counted in `unreadable` | Task 6 `unreadable records are never promoted` |
| A cancelled run deleted while a read runs | Every row and part of the run gone; the late completion writes nothing | Task 6 `a deleted run's late read writes nothing` |
| A cancelled run deleted after promotion; a merged run deleted; a run deleted with no status event | Rows and material gone; rows kept and stamped; rows gone | Task 4 `deleting a cancelled run deletes its tasks; another status stamps them`; Task 7 `a fixture run captures its accepted task, and deleting it as cancelled removes it` |
| The run's clones removed after capture | The candidate and its material unchanged | Task 7 `a fixture run captures its accepted task, and deleting it as cancelled removes it` |
| The launcher refuses the patch form | Material `partial`; an otherwise passing task ends `patch-missing` and its material is removed | Task 6 `a refused patch form leaves the patch missing` |
| The launcher refuses form 1 | `base-not-proven` | Task 5 `names and the base check`; Task 3 `promotion follows the ledger's decision rule` |
| A read that never ends | After 35 seconds it counts as failed; with 4 such reads, or 64 queued, new captures end `capture-busy` and the run goes on | Task 6 `a stalled read refuses new work, never the run` |
| An owner exclusion after promotion | `rejected` `excluded`, material removed | Task 6 `an owner exclusion demotes a candidate` |
| A project at 20,000 tasks, or at 128 MiB of material | No new row; `corpus-full` | Task 4 `the corpus caps hold` |
| Capture off, or a laptop project | No row and no read | Task 6 `capture off writes nothing and reads nothing` |
| A rollback to a host without the module, which deletes a cancelled run | The old host leaves that run's eval rows. Back on this host, `runIds` lists the run, the sweep finds no record, and the hook finds no status event (the old host deleted them), so it deletes the rows | Task 4 `deleting a cancelled run deletes its tasks; another status stamps them` (the no-event case) |

Outside this slice: mining, provenance groups, the `exposed` flag, the dev and holdout sets, validation, the corpus summary and its route and CLI, trials, and the learning budget.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/eval-config.ts` (create) | The `eval` block schema, its limits, and `captureSettings` |
| `packages/host/src/eval-types.ts` (create) | Shared types: capsule, capture and approval starts, the sink, rows, reasons, Git read results |
| `packages/host/src/team-types.ts` (modify, one line) | `eval: evalProjectSchema.optional()` in `teamProjectSchema` |
| `packages/host/src/routines.ts` (modify) | `digestedProjectTeam` removes `eval` from the authority digest |
| `packages/host/src/team-prompts.ts` (modify) | `withoutFeatures` becomes `withoutPrivateSettings`, dropping `features` and `eval` |
| `packages/host/src/eval-rules.ts` (create) | Pure: capsule, capture start, start verdict, test-path rule, reference verdict, later change, promotion |
| `packages/host/src/eval-store.ts` (create) | The `eval-corpus` module: SQL, hooks, and the read and write helpers |
| `packages/host/src/eval-git.ts` (create) | The streaming patch reader, the name read, the base check |
| `packages/host/src/eval-capture.ts` (create) | `TaskCapture`: the sink, the queue, `reconcile`, `sweep` |
| `packages/host/src/outcome-projector.ts` (modify, one word) | `export` on `outcomeId` |
| `packages/host/src/teams.ts` (modify) | The option, two call lines, two helpers: at most 18 added lines |
| `packages/host/src/server.ts` (modify) | Construct, pass, reconcile, sweep, close: at most 6 added lines |
| `docs/teams.md`, `docs/security.md`, the spec (modify) | Eval capture, its limits, deletion, the Git form, the amendments |
| `tests/eval-{config,rules,store,git,capture,capture-run}.test.ts` (create); `tests/{routines,team-prompts,outcome-rules}.test.ts`, `tests/team-fixture.ts` (modify) | Pure rules, a real store, real Git, the host |

**Order and owners.** Task 1 runs first and is small. Then Tasks 2, 3, 4, and 5 run in parallel. Task 6 waits for 3, 4, and 5. Then Tasks 7 and 8 run in parallel. Each file has one writer. Task 6 alone touches `outcome-projector.ts`, and Task 7 alone touches `teams.ts`, `server.ts`, and `tests/team-fixture.ts`.

## Review Focus

1. Capture changing a run or reaching a member: a throw, a stall, or a slow read in the completion path; an `eval` block in a member's context or the routine digest. Expect none (Task 7 `a failing capture never changes the run`; Task 6 `a stalled read refuses new work, never the run`; Task 2 `a member context never carries the feature map or the eval block`, `eval settings stay out of the routine approval digest`).
2. A result that depends on the order of the three facts, or on a repeated or late completion. Expect equal rows (Task 6 `the three facts give one result in every order`, `a later approval replaces an earlier one`; Task 4 `a marker and its completion are written once`).
3. Material that outlives a deleted cancelled run, or a late read that writes after deletion. Expect none (Task 4 `deleting a cancelled run deletes its tasks; another status stamps them`; Task 6 `a deleted run's late read writes nothing`; Task 7 `a fixture run captures its accepted task, and deleting it as cancelled removes it`).
4. A guess where a fact is missing: a refused patch stored as empty, a truncated list read as complete, a refused form 1 read as "not on the branch", unknown acceptance read as a refusal, a same-model approval counted. Expect a named missing state (Task 6 `a refused patch form leaves the patch missing`, `a restart turns pending facts into failures`; Task 5 `an over-limit patch is refused, never cut`, `names and the base check`; Task 3 `promotion follows the ledger's decision rule`).
5. Text in a plain column, a log line, or an error. Expect only ids, enumerations, counts, times, and blind indexes (Task 4 `the module keeps every text sealed`).

### Task 1: the setting and the shared types

**Files:** `packages/host/src/eval-config.ts`, `packages/host/src/eval-types.ts`, `packages/host/src/team-types.ts` (one line), `tests/eval-config.test.ts`. Runs first. Tasks 2 to 5 start from its commit.

**Interfaces (produces):**
```ts
// eval-config.ts
export const EVAL_RETENTION_DAYS_DEFAULT = 365;
export const evalProjectSchema: z.ZodType<EvalProjectSettings>;
export type EvalProjectSettings = {
  capture?: boolean;
  /** Paths whose files count as tests. Without it the host rule `isTestPath` applies. */
  testPaths?: { prefixes: string[]; suffixes: string[] };
  /** Feature-map area ids whose tasks never enter the corpus (spec part 9). */
  excludeAreas?: string[];
  retentionDays?: number;
};
/** The settings when the project turned capture on and follows GitHub; otherwise undefined. */
export function captureSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings } } | undefined): EvalProjectSettings | undefined;

// eval-types.ts (types and constants only)
export const EVAL_MODULE = "eval-corpus";
export type Capsule = {
  objective: string; steering: string[]; ownerAnswers: { question: string; answer: string }[];
  brief?: TeamBrief; goal?: TeamGoalContext;
  task: { id: string; title: string; instructions: string; paths: string[] };
};
export type CaptureStart = {
  runId: string; memberId: string; projectId: string;
  workspace: string;          // TeamRun.workspace, the integration checkout where every read of this capture runs
  anchorCommit: string;       // TeamRun.baseCommit
  memberBaseCommit: string;   // TeamMember.baseCommit
  commit: string;             // TeamTask.commit
  integratedHead: string;     // the run head after this task's cherry-pick
  at: string;
  uiChanges: boolean;         // TeamRun.brief?.uiChanges === true
  capsule: Capsule | null;    // null when the member has no start time
};
export type ApprovalStart = { runId: string; workspace: string; anchorCommit: string; reviewedHead: string; at: string };
export interface CaptureSink {
  /** Cheap and synchronous. False unless the project turned capture on and the store can take it. */
  enabled(projectId: string): boolean;
  /** Writes a marker, then reads in the background. Never throws. */
  integrated(start: CaptureStart): void;
  /** Marks the run's captured tasks, then reads in the background. Never throws. */
  approved(start: ApprovalStart): void;
}
export const START_REASONS = ["ui-changes", "start-unknown", "capsule-too-large", "excluded-area-unknown", "capture-busy"] as const;
export const MATERIAL_REASONS = ["capture-failed", "reference-too-wide", "excluded-area", "no-hidden-tests", "patch-too-large", "corpus-full"] as const;
export const PROMOTION_REASONS = ["ledger-missing", "ledger-withheld", "excluded", "same-model-review", "not-accepted", "acceptance-unknown",
  "patch-missing", "reference-unknown", "reference-ambiguous", "base-not-proven", "features-unknown", "unreadable"] as const;
export type StartReason = typeof START_REASONS[number];
export type MaterialReason = typeof MATERIAL_REASONS[number];
export type PromotionReason = typeof PROMOTION_REASONS[number];
export type EvalReason = StartReason | MaterialReason | PromotionReason;
export type EvalState = "captured" | "candidate" | "rejected";
export type MaterialState = "pending" | "stored" | "partial" | "none";
export type ApprovalState = "pending" | "read" | "unknown";
export type BaseState = "pending" | "proven" | "not-proven" | "none";
export type EvalFeatures = { role: "implementer"; area: string; kind: string | null; risk: "normal" | "elevated"; featureVersion: number };
/** Sealed in `eval_tasks.payload` for a task that passed the start verdict. */
export type CapturedPayload = {
  projectId: string; anchorCommit: string; memberBaseCommit: string; commit: string; integratedHead: string;
  files?: string[]; hiddenFiles?: string[];          // the reference's names and its test files, after the name read
  baseDelta?: "none" | "stored" | "missing"; reference?: "stored" | "missing";
  laterFiles?: string[];                             // after the latest approval's read
  features?: EvalFeatures;                           // on promotion
};
/** Sealed in `eval_tasks.payload` for a rejected task: nothing but the project. */
export type RejectedPayload = { projectId: string };
export type EvalTaskRow = {
  taskId: string; origin: "captured"; runId: string; memberId: string; projectRef: string;
  state: EvalState; reason: EvalReason | null; material: MaterialState; approval: ApprovalState | null; approvedAt: string | null;
  base: BaseState; materialBytes: number; capturedAt: string; decidedAt: string | null; checkedAt: string; runDeletedAt: string | null;
  payload: CapturedPayload | RejectedPayload;
};
export type PatchRead = { state: "read"; bytes: Buffer } | { state: "too-large" } | { state: "failed" };
export type NameRead = { state: "read"; names: string[] } | { state: "too-wide" } | { state: "failed" };
export type BaseRead = "proven" | "not-proven";
export interface CaptureGit {
  patch(cwd: string, from: string, to: string): Promise<PatchRead>;
  names(cwd: string, from: string, to: string, max: number): Promise<NameRead>;
  onBaseBranch(mirror: string, anchor: string, head: string): Promise<BaseRead>;
}
export type ReconcileResult = { visited: number; promoted: number; rejected: number; demoted: number; waiting: number; unreadable: number };
```

**Decisions:**

- **Schema**, strict at every level. `capture`: boolean. `testPaths`: `prefixes` at most 32, each 1 to 200 characters, repository-relative with the `ownedPath` rule of `team-types.ts` (no leading `/`, no `\`, no NUL, no empty, `.`, `..`, or `.git` segment); `suffixes` at most 32, each 1 to 64 characters with no `/`, `\`, or NUL; at least one entry in the two lists together. `excludeAreas`: at most 32 ids of `/^[a-z][a-z0-9-]{0,39}$/`. `retentionDays`: integer 30 to 3,650. No defaults, so a parsed block is exactly what the owner wrote.
- `eval-config.ts` imports only `zod`, so `team-types.ts` can import it without a cycle.
- `captureSettings` returns the block only when `capture === true` and `source.mode === "github"` (spec part 1: only GitHub projects have a mirror).

- [ ] **Step 1: Write the failing tests** in `tests/eval-config.test.ts`.

| Test name | Assertions |
|---|---|
| `the eval block is optional and strict` | `teamProjectSchema` parses a team block without `eval` to the same value as today. `{ capture: true }` parses. Each fails: an unknown key, `retentionDays` 29 and 3,651, 33 prefixes, both lists empty, a prefix `/abs`, `a/../b`, or `a\b`, a suffix `a/b`, an area `UI`, 33 areas. |
| `capture is on only for a GitHub project that asks for it` | `captureSettings`: no team, no `eval`, `capture` false, and `capture` true with source `laptop` give undefined; `capture` true with source `github` gives the block. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-config.test.ts` and the typecheck, then commit.

### Task 2: the digest and the member context

**Files:** `packages/host/src/routines.ts`, `packages/host/src/team-prompts.ts`, `tests/routines.test.ts`, `tests/team-prompts.test.ts`, `tests/outcome-rules.test.ts`. Needs Task 1. Runs in parallel with Tasks 3, 4, and 5.

**Interfaces (produces):** none exported.
```ts
// routines.ts
/** The eval block changes what the host measures, never a routine's work (umbrella C11), so it is removed before hashing. */
function digestedProjectTeam(team: Project["team"]): Project["team"];   // the same object when `eval` is absent
// authority(): project: { path, team: digestedProjectTeam(project.team), teamworkDir, source, linear }
// team-prompts.ts
/** A project copy without its private settings. A member reads neither the feature map nor the eval block. */
function withoutPrivateSettings<T extends object>(project: T): T;      // replaces withoutFeatures at its two call sites
```

**Decisions:** a team block without `eval` gives the same digest as today, so no running routine blocks when this ships. Fixture runs carry no `eval`, so the prompt version of `config-identity.ts` does not change.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `eval settings stay out of the routine approval digest` (routines, new) | As `outcome settings stay out of the routine approval digest`: after the first tick, set the project's `team.eval` to `{ capture: true, retentionDays: 90 }`; the routine stays `running`. Then set `team.features` to `{ areas: [{ id: "host", paths: ["src"] }] }`; the routine is `blocked`. |
| `a member context never carries the feature map or the eval block` (team-prompts, renamed from `a member context never carries the feature map`) | The handoff project and `configuredProject` also hold `eval: { capture: true, excludeAreas: ["web"] }`. The serialized snapshot matches neither `/"eval"/` nor `/"excludeAreas"/`, and still holds `"checks"`. |
| `team prompts never import the ledger` (outcome-rules, extended) | `eval-` joins the forbidden specifiers of `team-prompts.ts` and of `team-mcp.ts`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/team-prompts.test.ts tests/outcome-rules.test.ts`, then `tests/routines.test.ts` on the host, then the typecheck.

### Task 3: the capture rules

**Files:** `packages/host/src/eval-rules.ts`, `tests/eval-rules.test.ts`. Needs Task 1. Runs in parallel with Tasks 2, 4, and 5.

**Interfaces (produces):** pure, no I/O, no clock.
```ts
export const CAPSULE_MAX_BYTES = 65_536, REFERENCE_MAX_FILES = 500, LATER_FILES_MAX = 2_000;
export function buildCapsule(run: TeamRun, task: TeamTask, member: TeamMember): Capsule | null;
export function captureStart(run: TeamRun, task: TeamTask, member: TeamMember, facts: { commit: string; head: string; at: string }): CaptureStart;
export function capsuleBytes(capsule: Capsule): number;    // UTF-8 bytes of canonicalJson(capsule)
/** The reason to refuse before any read, or undefined. */
export function startVerdict(start: CaptureStart, settings: EvalProjectSettings, map: FeatureMap | undefined): StartReason | undefined;
export function evalTestPath(path: string, testPaths: EvalProjectSettings["testPaths"]): boolean;
export function referenceVerdict(read: NameRead, settings: EvalProjectSettings, map: FeatureMap | undefined):
  { files: string[]; hiddenFiles: string[] } | { reason: "capture-failed" | "reference-too-wide" | "excluded-area" | "no-hidden-tests" };
export function laterChange(files: readonly string[], later: readonly string[] | undefined): "none" | "changed" | "unknown";
export type PromotionFacts = { state: "captured" | "candidate"; material: MaterialState; approval: ApprovalState | null;
  base: BaseState; runDeletedAt: string | null; payload: CapturedPayload };
export type Promotion = { kind: "wait" } | { kind: "candidate"; features: EvalFeatures } | { kind: "reject"; reason: PromotionReason };
export function promotion(task: PromotionFacts, row: OutcomeRow | undefined): Promotion;
```

**Decisions:**

- **The capsule** copies `objective`; the texts of `steering` entries whose `at` is before `member.startedAt`; `{ question, answer }` of decisions with `answeredBy` `owner`, an `answer`, and `answeredAt` before `member.startedAt`; `brief` and `goal` when present; and the task's `id`, `title`, `instructions`, and `paths`. Times compare by `Date.parse`. Without `member.startedAt` it is null. It never holds a rendered prompt (spec part 2).
- **`captureStart`** reads only the run record: `workspace` and `baseCommit` of the run, `baseCommit` of the member, `uiChanges` as `run.brief?.uiChanges === true`.
- **`startVerdict`**, first match: `uiChanges` gives `ui-changes` (spec part 9); a null capsule gives `start-unknown`; `capsuleBytes` above 65,536 gives `capsule-too-large`; an `excludeAreas` id that the map does not define (or no map) gives `excluded-area-unknown`. *(My call: a mistyped area would silently let interface work in, so a set that cannot be checked refuses.)* `capture-busy` is the queue's, not this rule's.
- **`evalTestPath`.** With `testPaths`: a path equal to a prefix or under it (`prefix + "/"`), or ending with a suffix. Without it: `isTestPath` from `task-features.ts`.
- **`referenceVerdict`**, first match: `failed` gives `capture-failed`; `too-wide` or more than 500 names gives `reference-too-wide`; a file whose `pathArea(file, map)` is in `excludeAreas` gives `excluded-area`; no test file, or no other file, gives `no-hidden-tests` (condition 4). Otherwise `files` is the sorted names and `hiddenFiles` the sorted test files.
- **`laterChange`**: `unknown` without a list, `changed` when the lists share a name, else `none`.
- **`promotion`**, first match. *(My call on the order and on every code but `reference-ambiguous` and `no-hidden-tests`, which the spec names.)*
  1. Material, approval, or base `pending`: wait.
  2. No ledger row: `ledger-missing` when the task is `captured` and its run's record is deleted; otherwise wait. A candidate never loses its state because the ledger's own retention removed the row.
  3. `rowUse(row, "decision")`: `open` and `withheld` `unfrozen` wait; `withheld` `backfilled` or `gap` gives `ledger-withheld`; `excluded` gives `excluded`.
  4. `counted`: the flag `same-model-review` gives `same-model-review`; accepted 0 gives `not-accepted`; null gives `acceptance-unknown`.
  5. Material `partial`: `patch-missing`.
  6. Approval null or `unknown`, or `laterChange` `unknown`: `reference-unknown`. `changed`: `reference-ambiguous` (condition 3).
  7. Base `not-proven`: `base-not-proven` (condition 2).
  8. A risk other than `normal` or `elevated`: `features-unknown`.
  9. Otherwise `candidate`, with `{ role: "implementer", area: row.payload.area, kind: row.kind, risk: row.risk, featureVersion: row.featureVersion }`.

- [ ] **Step 1: Write the failing tests** in `tests/eval-rules.test.ts`, with the `hostEntryRun()` fixture of `tests/fixtures/host-entry-run.ts` for the run, and a row literal from one helper.

| Test name | Assertions |
|---|---|
| `a capsule keeps only what came before the member started` | The fixture's steering is at 10:01 and 10:02, its owner answer at 10:03, its coordinator answer at 10:04, and one decision is open. A member started at 10:01:30: `steering` `["Keep the API stable"]`, `ownerAnswers` `[]`. Started at 10:05: both steering texts, and `ownerAnswers` `[{ question: "Which store?", answer: "Use SQLite" }]` only. `task` equals `{ id, title, instructions, paths }` of the task. No `startedAt`: null. |
| `a start is refused before any read` | `uiChanges` true gives `ui-changes` even with a null capsule. Null capsule: `start-unknown`. An objective that makes the capsule 65,537 bytes: `capsule-too-large`; 65,536 bytes passes. `excludeAreas: ["web"]` with a map of `host` only: `excluded-area-unknown`; with `web` defined: undefined. |
| `the reference verdict` | `[a.txt, tests/y.test.ts]` with no `testPaths`: hidden `["tests/y.test.ts"]`. Tests only, and others only: `no-hidden-tests`. 501 names, and `too-wide`: `reference-too-wide`. `failed`: `capture-failed`. A file in the excluded area `web` with a test file: `excluded-area`. `testPaths` `{ prefixes: ["spec"], suffixes: ["_test.go"] }`: `spec/a.rb` and `pkg/x_test.go` are tests, `specs/a.rb` and `tests/y.test.ts` are not. |
| `later changes` | Files `[a, b]`: later `[c]` gives `none`, `[b]` gives `changed`, `[]` gives `none`, undefined gives `unknown`. |
| `promotion follows the ledger's decision rule` | One row per line, each else passing: open, unfrozen integrated, any pending fact: wait. No row: wait; with `runDeletedAt` and state `captured`: `ledger-missing`; state `candidate`: wait. Flag `backfilled`: `ledger-withheld`. `exclusion` `owner`: `excluded`. `same-model-review` with accepted 1: `same-model-review`. Accepted 0: `not-accepted`; null: `acceptance-unknown`. Material `partial`: `patch-missing`. Approval null: `reference-unknown`. Later `[a.txt]` against files `[a.txt]`: `reference-ambiguous`. Base `not-proven`: `base-not-proven`. Risk `unknown`: `features-unknown`. All passing: `candidate` with area `host`, kind `feature`, risk `normal`, `featureVersion` 1. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-rules.test.ts` and the typecheck.

### Task 4: the store module

**Files:** `packages/host/src/eval-store.ts`, `tests/eval-store.test.ts`. Needs Task 1. Runs in parallel with Tasks 2, 3, and 5.

**Interfaces (produces):** module `eval-corpus`, version 1, `readVersion` 1. `migrate(tx, 0)`:
```sql
CREATE TABLE IF NOT EXISTS eval_tasks (
  task_id TEXT PRIMARY KEY,            -- 'captured:' || run_id || ':' || member_id
  origin TEXT NOT NULL,                -- 'captured'; mined tasks come in a later slice
  run_id TEXT NOT NULL, member_id TEXT NOT NULL,
  project_ref TEXT NOT NULL,           -- index('project', projectId)
  state TEXT NOT NULL,                 -- captured | candidate | rejected
  reason TEXT,                         -- an EvalReason; NULL unless rejected
  material TEXT NOT NULL,              -- pending | stored | partial | none
  approval TEXT, approved_at TEXT,     -- NULL | pending | read | unknown; the time of the latest approval marker
  base TEXT NOT NULL,                  -- pending | proven | not-proven | none
  material_bytes INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL, decided_at TEXT, checked_at TEXT NOT NULL, run_deleted_at TEXT,
  payload TEXT NOT NULL);              -- sealed CapturedPayload or RejectedPayload, row id task_id
CREATE INDEX IF NOT EXISTS eval_tasks_run ON eval_tasks (run_id);
CREATE INDEX IF NOT EXISTS eval_tasks_project ON eval_tasks (project_ref, captured_at);
CREATE INDEX IF NOT EXISTS eval_tasks_check ON eval_tasks (state, checked_at);
CREATE TABLE IF NOT EXISTS eval_material (
  task_id TEXT NOT NULL, part TEXT NOT NULL,   -- capsule | base-delta | reference
  bytes INTEGER NOT NULL,
  payload TEXT NOT NULL,                       -- sealed { capsule } or { patch: base64 }, row id task_id + '/' + part
  PRIMARY KEY (task_id, part));
```
```ts
export const PROJECT_TASK_MAX = 20_000, PROJECT_MATERIAL_MAX_BYTES = 134_217_728, HOST_MATERIAL_MAX_BYTES = 536_870_912, SWEEP_BATCH = 100;
export function evalCorpusModule(store: EvidenceStore, now: () => string): EvidenceModule;
export function capturedTaskId(runId: string, memberId: string): string;
export type MarkerOutcome = { state: "captured"; capsule: Capsule } | { state: "rejected"; reason: StartReason };
export function insertMarker(tx: EvidenceTx, start: CaptureStart, outcome: MarkerOutcome, at: string): "inserted" | "exists" | "full";
export type MaterialResult =
  | { kind: "reject"; reason: MaterialReason }
  | { kind: "store"; files: string[]; hiddenFiles: string[];
      baseDelta: { state: "none" } | { state: "stored"; bytes: Buffer } | { state: "missing" };
      reference: { state: "stored"; bytes: Buffer } | { state: "missing" }; base: BaseRead };
/** False when the row is gone or its material is no longer pending. */
export function completeMaterial(tx: EvidenceTx, taskId: string, result: MaterialResult, at: string): boolean;
/** Marks the run's captured and candidate rows of this anchor. Returns what the approval read needs. */
export function markApproval(tx: EvidenceTx, start: ApprovalStart): { taskId: string; integratedHead: string }[];
/** `later` undefined records `unknown`. False unless the row is `captured` or `candidate` and its approval is pending under `approvedAt`. */
export function completeApproval(tx: EvidenceTx, taskId: string, approvedAt: string, later: string[] | undefined): boolean;
/** The restart rule. Material pending outside `inFlight` is rejected `capture-failed`; approval pending becomes `unknown`. */
export function failPending(tx: EvidenceTx, inFlight: ReadonlySet<string>, at: string): number;
export type Decide = (task: EvalTaskRow & { payload: CapturedPayload }) => Promotion | { kind: "wait"; unreadable: true };
export function reconcileBatch(tx: EvidenceTx, decide: Decide, at: string, limit?: number): ReconcileResult;   // limit 100
export function readEvalTask(db: EvidenceDb, taskId: string): EvalTaskRow | undefined;   // throws on a payload that does not open
export function runEvalTasks(db: EvidenceDb, runId: string): EvalTaskRow[];
export function readMaterial(db: EvidenceDb, taskId: string): { capsule?: Capsule; baseDelta?: Buffer; reference?: Buffer };
export function sweepEvalTasks(tx: EvidenceTx, now: string, projects: readonly { projectId: string; retentionDays: number }[],
  fallbackDays: number, limit?: number): number;   // limit 100
```

**Decisions:**

- **`insertMarker`.** `full` when the project holds 20,000 rows; nothing is written. Otherwise `INSERT OR IGNORE`; `exists` when the row was there. A captured marker sets material `pending`, base `pending`, approval NULL, the sealed payload `{ projectId, anchorCommit, memberBaseCommit, commit, integratedHead }`, the `capsule` part, and `material_bytes` to its bytes. A rejected marker sets material `none`, base `none`, `decided_at`, and the payload `{ projectId }`.
- **One reject rule for every path.** A reject sets state `rejected`, the reason, material and base `none`, approval and `approved_at` NULL, `material_bytes` 0, the payload `{ projectId }`, and `decided_at`, and deletes every part. So no later completion can match the row.
- **`completeMaterial`** acts only on a row whose material is `pending`. A `reject` result, or a stored size that would take the project above 128 MiB or the host above 512 MiB (`SUM(material_bytes)`), rejects the row (`corpus-full` for the caps). A `store` result writes the stored parts, `files`, `hiddenFiles`, the two part states, base, material `stored` (or `partial` when a part is `missing`), and the new byte total.
- **`markApproval`** sets approval `pending` and `approved_at` on rows of the run in state `captured` or `candidate` whose sealed `anchorCommit` equals the start's. A later approval overwrites both, so the latest wins. A payload that does not open sets approval `unknown`.
- **`reconcileBatch`** visits rows in state `captured` or `candidate`, oldest `checked_at` first, sets `checked_at`, and applies `decide`. A payload that does not open rejects the row `unreadable` and removes its material. `candidate` writes `features` into the payload and `decided_at`. A reject of a candidate counts as `demoted`. Every reject removes the material.
- **`deleteRun(tx, runId)`** pages `store.eventsIn(tx, { runId, kinds: ["run.settled", "run.deleted"], after, limit: 100 })` to the last event and reads `data.status`. `cancelled`, no such event, or an event that does not open deletes the run's `eval_material` and `eval_tasks` rows. Any other status sets `run_deleted_at` where it is NULL. `runIds` lists `run_id` where `run_deleted_at` is NULL, so the hourly sweep repeats a hook that failed. `counts` gives `captured`, `candidate`, `rejected`, and `materialBytes`.
- **`sweepEvalTasks`** deletes rows and their parts whose `captured_at` is older than the project's `retentionDays`, or `fallbackDays` for a project ref that no configured project matches; at most 100 rows per call, oldest first.

- [ ] **Step 1: Write the failing tests** in `tests/eval-store.test.ts`, on a real `EvidenceStore` in a temporary directory.

| Test name | Assertions |
|---|---|
| `the module keeps every text sealed` | A captured marker with objective `Objective-7f3a`, then `completeMaterial` with files `[src/secret-name.ts, tests/secret-name.test.ts]` and two patches. No plain column of either table, read with `SELECT *`, contains `Objective-7f3a`, `secret-name`, the commit id, or the project id. `readMaterial` returns the capsule and both patches byte for byte. |
| `a marker and its completion are written once` | A second `insertMarker` of the same start gives `exists` and changes no column. A second `completeMaterial` gives false. `completeMaterial` after the row is deleted gives false and inserts nothing. |
| `deleting a cancelled run deletes its tasks; another status stamps them` | Events `run.settled` `merged` then `run.deleted` `cancelled`: `store.deleteRun` leaves zero rows in both tables. `run.deleted` `merged`: rows kept, `run_deleted_at` set, and `runIds` no longer lists the run. No event: zero rows. |
| `approval marks follow the latest approval` | Two rows of anchor X and one of anchor Y: `markApproval` for X marks two. `completeApproval` with the first `approvedAt` after a second mark gives false; with the second it gives true and approval `read`. `later` undefined gives `unknown`. |
| `the corpus caps hold` | A row of the project with `material_bytes` set to 134,217,728 − 10: a completion storing 11 bytes is rejected `corpus-full` with zero parts; 10 bytes is stored. 20,000 rows of one project: `insertMarker` gives `full`. |
| `retention removes old tasks per project` | Project A with 30 days and an unconfigured project with fallback 365: rows of A at 31 and 29 days and of the other at 366 and 364 days. One sweep removes the two old rows and their parts. 150 old rows need two calls (100, then 50). |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-store.test.ts` and the typecheck.

### Task 5: the Git reads

**Files:** `packages/host/src/eval-git.ts`, `tests/eval-git.test.ts`. Needs Task 1. Runs in parallel with Tasks 2, 3, and 4.

**Interfaces (produces):**
```ts
export const PATCH_MAX_BYTES = 1_048_576, CAPTURE_READ_MS = 30_000;
/** The new form (see "Git commands"). Throws TypeError when an id fails COMMIT_ID. */
export function patchArgs(from: string, to: string): string[];
export function captureGit(prefix: () => TeamCommand | undefined, timeoutMs?: number): CaptureGit;
```

**Decisions:**

- **`patch`** spawns as `spawnTeamBundle` does: `spawn(prefix?.command ?? "git", prefix ? [...prefix.args, "git", ...args] : args, { cwd, env: teamCommandEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })`, with `args = teamGitArgs(cwd, patchArgs(from, to))`. It keeps stdout chunks while the total is at most 1,048,576 bytes. At 1,048,577 it destroys stdout, so Git ends on SIGPIPE even when the host may not signal it, tries to kill the group, and gives `too-large`. Exit 0 within the limit gives `read`. Any other exit, an error, or the time-out gives `failed`. stderr is drained and dropped. A malformed id gives `failed` without a spawn.
- **`names`** runs `teamCommand` with `teamGitArgs(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", from, to, "--"])`, 30 seconds, and the prefix: the form the integration step already runs. Exit 0 and not interrupted: `truncated`, or more than `max` names, gives `too-wide`; otherwise the NUL-separated names. Anything else gives `failed`.
- **`onBaseBranch`** runs form 1, `["merge-base", "--is-ancestor", anchor, head]`, in the mirror. Exit 0 gives `proven`; anything else gives `not-proven`.
- All three are read-only tree forms: they touch no index and take no lock, so they never block the run's own Git work in the same checkout.

- [ ] **Step 1: Write the failing tests** in `tests/eval-git.test.ts`, with real Git in a temporary repository.

| Test name | Assertions |
|---|---|
| `the patch form is exact and checked` | A prefix script, with its record path written into it, records its arguments and runs the rest. The recorded argv equals `["git", ...teamGitArgs(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--default-prefix", "--no-renames", "--submodule=short", "--ignore-submodules=none", "--unified=3", "--inter-hunk-context=0", FROM, TO, "--"])]`. `HEAD`, `-x`, and 39 hex characters: `patchArgs` throws, `patch` gives `failed`, and the script records nothing. |
| `a binary patch reproduces the reference tree` | TO adds a text file, adds a 4 KiB binary file, and deletes a file. `git apply --index` of the read patch in a clone at FROM, then `git write-tree`, equals the tree of TO. |
| `an over-limit patch is refused, never cut` | A 1.2 MiB random file: `too-large`, and the promise settles within 5 seconds. |
| `names and the base check` | Names of a 3-file commit, in Git's order. 501 files with `max` 500: `too-wide`. An ancestor: `proven`; a non-ancestor, a missing commit, and a prefix that exits 1: `not-proven`. |
| `a read that cannot end` | A prefix script that sleeps 10 seconds, with `timeoutMs` 200: `patch` and `names` give `failed` within 2 seconds. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-git.test.ts` and the typecheck.

### Task 6: the capture service

**Files:** `packages/host/src/eval-capture.ts`, `packages/host/src/outcome-projector.ts` (`export` on `outcomeId` only), `tests/eval-capture.test.ts`. Needs Tasks 3, 4, and 5.

**Interfaces (produces):**
```ts
export const CAPTURE_QUEUE_MAX = 64, CAPTURE_CONCURRENCY = 2, CAPTURE_STALLED_MAX = 4, CAPTURE_DEADLINE_MS = 35_000, RECONCILE_BATCH = 100;
export type TaskCaptureOptions = {
  config: Pick<Config, "projects" | "teams">;
  store: EvidenceStore;
  source?: Pick<ProjectSourceService, "mirrorPath" | "status">;
  git?: CaptureGit;               // default captureGit(() => config.teams?.commandPrefix)
  now?: () => string;
  deadlineMs?: number;            // default CAPTURE_DEADLINE_MS
};
export class TaskCapture implements CaptureSink {
  constructor(options: TaskCaptureOptions);   // registers evalCorpusModule(store, now)
  enabled(projectId: string): boolean;
  integrated(start: CaptureStart): void;
  approved(start: ApprovalStart): void;
  /** Runs `failPending` once per process, then one batch. A zero result when closed or a module is not ready. */
  reconcile(): ReconcileResult;
  sweep(): number;
  /** Resolves when no job is queued or running. A stalled read is not awaited. */
  idle(): Promise<void>;
  close(): void;
}
```

**Decisions:**

- **`enabled`** is `!closed && captureSettings(project) !== undefined && source !== undefined && store.status().modules["eval-corpus"] === "ready"`.
- **`integrated`.** Reads the project's settings and feature map once. A full queue (queued plus running at 64, or 4 stalled reads) gives a `rejected` marker `capture-busy`. Otherwise `startVerdict` decides between a rejected marker and a captured one, through `store.tryWrite`. Only an `inserted` captured marker enqueues a job. The job, in order: `names(workspace, memberBase, commit, 500)` and `referenceVerdict` (a reject stops the job); the base-delta patch from anchor to member base, skipped as `none` when they are equal; the reference patch from member base to commit (`too-large` on either rejects `patch-too-large`; `failed` marks the part `missing`); and form 1 against `source.status(projectId).mirrorHead` in `source.mirrorPath(projectId)` (no head, or a throw, gives `not-proven`). Then one `completeMaterial`.
- **`approved`.** `markApproval` through `tryWrite`, then one job per returned task. A task whose integrated head equals the reviewed head records `later` `[]` with no read. Otherwise `names(workspace, integratedHead, reviewedHead, 2000)`: `read` records the names, anything else records `unknown`. A full queue records `unknown` for each task at once.
- **Deadline.** Every Git call races a timer of `deadlineMs`. When the timer wins, the call counts as `failed`, and as stalled until its promise settles. The job goes on, so its row never stays pending in a live process.
- **`reconcile`** calls `reconcileBatch` with a `decide` that reads `readOutcome(tx, outcomeId(runId, memberId))` and calls `promotion`. A ledger read that throws returns `{ kind: "wait", unreadable: true }`. It needs both `outcomes` and `eval-corpus` ready.
- **`sweep`** passes every configured project's `retentionDays` (or 365) and the fallback 365 to `sweepEvalTasks`.
- **`close`** sets `closed`, drops queued jobs, and ignores later completions. A dropped job's row is failed by the next process's `failPending`.
- A store write that fails is skipped through `tryWrite`, which logs one fixed line. The only other log line is `Eval capture skipped (CODE).`, once per code per process, for `capture-busy` and `corpus-full`.

- [ ] **Step 1: Write the failing tests** in `tests/eval-capture.test.ts`, on a real store with `outcomeModule()`, the ledger row written through `writeOutcome` from one helper (disposition `integrated`, `frozenAt` set, accepted 1, flags `[]`, kind `feature`, risk `normal`, `featureVersion` 1, area `host`), and a fake `CaptureGit` whose calls resolve when the test says.

| Test name | Assertions |
|---|---|
| `capture off writes nothing and reads nothing` | No `eval` block, `capture` false, and a `laptop` project: `enabled` false; after `integrated` and `approved`, zero rows and zero Git calls. |
| `the three facts give one result in every order` | Start: `integrated` (names `[a.txt, tests/a.test.ts]`, two patches, base `proven`), then `approved`. For each of the six orders of C (resolve the capture reads), A (resolve the approval read), and R (write the frozen row), with `reconcile()` after each step: later `[]` and accepted 1 end `candidate` with features `{ role: "implementer", area: "host", kind: "feature", risk: "normal", featureVersion: 1 }`; later `[a.txt]` ends `rejected` `reference-ambiguous` with zero parts; accepted 0 ends `rejected` `not-accepted`. Within each case, the rows (without `checked_at` and `decided_at`) and the parts are equal across the six orders. |
| `a later approval replaces an earlier one` | First approval, later `[]`: `candidate`. Second approval with later `[a.txt]`, and the first read resolving after the second mark: the first writes nothing; after the second, `reconcile` demotes the task to `reference-ambiguous` and `demoted` is 1. |
| `a stalled read refuses new work, never the run` | `deadlineMs` 50 and a fake whose calls never settle: four captures leave four stalled reads, and each row ends `rejected` `capture-failed` without a throw. The fifth `integrated` returns at once and writes `capture-busy`. On a fresh capture whose reads wait for the test, 64 queued or running jobs make the 65th `capture-busy`. |
| `a restart turns pending facts into failures` | Close a capture with a read and an approval pending. A new `TaskCapture` on the same store: the first `reconcile` rejects the material-pending row `capture-failed`; the approval-pending row, with an accepted frozen row, ends `reference-unknown`. |
| `an unavailable store takes nothing and throws nothing` | A store that failed to open: `enabled` false; `integrated`, `approved`, `reconcile`, and `sweep` throw nothing and return zero results. |
| `a deleted run's late read writes nothing` | `integrated`, then events `run.deleted` `cancelled` and `store.deleteRun`, then resolve the reads: zero rows and zero parts. |
| `an owner exclusion demotes a candidate` | A candidate, then its ledger row rewritten with `exclusion` `owner`: `rejected` `excluded`, zero parts, `demoted` 1. |
| `a refused patch form leaves the patch missing` | The reference patch read `failed`: material `partial` and `reference` `missing`, with the capsule kept. With an accepted frozen row and approval read: `rejected` `patch-missing`, zero parts. |
| `unreadable records are never promoted` | An eval payload replaced with bad sealed text: `rejected` `unreadable`, zero parts. A ledger payload replaced with bad text: the task stays `captured` and `unreadable` is 1. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-capture.test.ts tests/outcome-projector.test.ts` and the typecheck.

### Task 7: the team service, the server, and the host test

**Files:** `packages/host/src/teams.ts`, `packages/host/src/server.ts`, `tests/team-fixture.ts`, `tests/eval-capture-run.test.ts`. Needs Tasks 2 and 6. Runs in parallel with Task 8.

**Interfaces (produces):** `TeamServiceOptions.capture?: CaptureSink`; `openTeamService({ capture?: CaptureSink })` in the fixture.

**Decisions:** these are all the lines this task adds.

- `teams.ts`, at most 18 lines:
  - Two imports: `import type { CaptureSink } from "./eval-types.js";` and `import { captureStart } from "./eval-rules.js";`.
  - In `TeamServiceOptions`: `/** Eval capture (INF-185). It observes only: it never changes a run, and its failure is swallowed. */` and `capture?: CaptureSink;`.
  - In the integration completion, inside `if (task)`, after the `task.integrated` `emitWith`: `if (commit && member.role === "implementer") this.captureIntegrated(stored, member, task, commit, head);`.
  - In the review completion, after the `review.recorded` `emitWith`: `if (report.verdict === "approved") this.captureApproved(stored, member.baseCommit);`.
  - Two private helpers. Each reads `this.options?.capture`, returns when `enabled(run.projectId)` is false, and calls `integrated(captureStart(stored.run, task, member, { commit, head, at: timestamp() }))` or `approved({ runId, workspace: run.workspace, anchorCommit: run.baseCommit, reviewedHead, at: timestamp() })`, all inside `try { … } catch { /* Capture never changes a run. */ }`.
- `server.ts`, at most 6 lines: the import; `const capture = new TaskCapture({ config, store: evidence, source: projectSource });` after `outbox.registerProjector(outcomeProjector(evidence));`; `capture,` in the `TeamService` options; `capture.reconcile();` at the end of `advanceOutbox`; `capture.sweep();` at the end of `sweepEvidence`; `capture.close();` in `closeEvidence` before `evidence.close()`.
- `tests/team-fixture.ts`: `capture?: CaptureSink` in the `openTeamService` options, passed through like `events`.
- No route, client, web, phone, or Mac change.

- [ ] **Step 1: Write the failing tests** in `tests/eval-capture-run.test.ts`. Setup: `fixture("rubric", limitLineup, {}, { noServer: true })` with `publishHeads` false; the mirror source of `a GitHub project run clones the mirror head without reading the project tree`; `team.eval = { capture: true }` on the `rehearsal` project; an `EvidenceStore` with `outcomeModule()`, an `EventOutbox` with `outcomeProjector`, and a `TaskCapture` on that store and source; `openTeamService({ source, events, capture })` and `useEvidence(store)`. After the run settles: `await capture.idle()`, `outbox.advance()`, `capture.reconcile()`.

| Test name | Assertions |
|---|---|
| `a fixture run captures its accepted task, and deleting it as cancelled removes it` (acceptance 1) | The run settles `ready-for-review`. Task a (implementer `haiku`, reviewer `codex-reviewer`): `candidate`, reason null, material `stored`, approval `read`, base `proven`; `files` `["a.txt", "docs/x.md", "tests/y.test.ts"]`, `hiddenFiles` `["tests/y.test.ts"]`; the capsule's `task.id` `a` and `objective` the run's; the reference patch text contains `diff --git a/tests/y.test.ts b/tests/y.test.ts`; `baseDelta` is `none` exactly when the member's base equals the run's. Task b (`codex-light`, b.txt only): `rejected` `no-hidden-tests`, zero parts. Move the run directory aside, `reconcile()`, and move it back: task a's row (without `checked_at`) and parts are unchanged. Cancel the run and `removeRun` it: zero rows and zero parts for the run. |
| `a failing capture never changes the run` | A sink whose `enabled` is true and whose `integrated` and `approved` throw: the run settles `ready-for-review` with both tasks `integrated`, and no run event text matches `/capture|eval/i`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `tests/eval-capture-run.test.ts` on the host, then the typecheck.
- [ ] **Step 5: The coordinator runs `npm run check` once, requests the independent review, and commits.**

### Task 8: the docs

**Files:** `docs/teams.md`, `docs/security.md`, `docs/superpowers/specs/2026-11-12-replay-eval-design.md`. Needs Task 1. Runs in parallel with Task 7.

**Decisions:**

- `docs/teams.md`, a section "Eval capture": the `eval` block and its limits, that only GitHub projects capture, what a captured task keeps, the start, material, and promotion codes, the deletion rule, retention, the caps, and the launcher forms below, with the note that capture should be turned on after the owner admits the patch form.
- `docs/security.md`: eval material is sealed in the evidence store, never in the mirror or a member's context; a deleted cancelled run deletes it; plain columns hold no text.
- The spec. Part 1: the `capture` and `retentionDays` fields and the optional fields of this stage. Part 2: reads start at integration and finish in the background; condition 3 uses the reference name read; condition 2 is form 1 in the mirror; the codes; `patch-missing`. Owner decision 5: the defaults this slice ships.
- No home path, host name, or tracker link.

- [ ] **Step 1: Write the docs.** **Step 2: Run** the privacy scan of `AGENTS.md` over the diff.

## Git commands

Two new forms need the owner's launcher approval. One form is reused.

1. **New, the patch.** In a run's integration checkout (`TeamRun.workspace`), after the six `-c` settings of `teamGitArgs`:

   `git diff --no-ext-diff --no-textconv --no-color --binary --default-prefix --no-renames --submodule=short --ignore-submodules=none --unified=3 --inter-hunk-context=0 FROM TO --`

   FROM and TO each match `/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/`. The pairs are (run base, member base) and (member base, task commit). `--binary` implies `--full-index`. `--default-prefix` keeps `a/` and `b/` against a user's `diff.noprefix` or `diff.mnemonicPrefix` (Git 2.41 or later; an older Git fails the read, which leaves the patch missing). The output is read as a stream, at most 1,048,576 bytes; the reader closes stdout at the next byte. Time limit 30 seconds. **While the launcher refuses it:** the material is `partial`, both parts are `missing`, and a task that passes every other check is rejected `patch-missing`.
2. **New, the name list of capture.** `git diff --no-ext-diff --no-textconv --name-only --no-renames --ignore-submodules=none -z FROM TO --` in the integration checkout, with the same two id shapes. It is the name list that the integration step runs today for `changedPaths`, plus `--ignore-submodules=none`, so that a copy's own configuration cannot hide a submodule change from the reference's files or from the later-change list. Limits: 500 names for a reference, 2,000 for later changes, 64 KiB of output, 30 seconds. **While the launcher refuses it:** every capture ends `capture-failed`, and a later-change list stays unknown, so nothing is promoted.
3. **Reused, form 1 of the base scan.** `git merge-base --is-ancestor ANCHOR MIRRORHEAD` in the source mirror. Its launcher audit is pending with the outcome-ledger release. **While it is refused:** every task ends `base-not-proven`.

**The launcher ends each of the three capture reads by itself after 35 seconds** (the two new forms, and the base check in the mirror, which members' check commands can write). The host may not signal a command that the launcher runs as another account, so there the host's own 30-second limit only decides the answer. **While a launcher has no such limit:** a read that hangs holds one of the `CAPTURE_STALLED_MAX` places until it ends, and the bound of `CAPTURE_STALLED_MAX + CAPTURE_CONCURRENCY` capture children still holds.

## Not in this slice

- Mining, provenance groups, the `exposed` flag, `set`, validation, the corpus summary, its route and CLI, trials, comparison, and the budget (delivery steps 2 to 5).
- Part 1's other fields: `gradingPaths`, `focusedTest`, `reportFormat`, `guardChecks`, `candidateProfiles`, `memberProfile`, `graderProfile`, `trialMinutes`. Step 2 adds them as optional at parse.
- An ancestry check for a run that started from a parent run or a handoff. Form 1 refuses such a base unless it is on the branch.
- A setting that lets a captured task outlive a deleted cancelled run (owner decision 5 keeps the default).
- Capsule fields for a member that continues another's work. Step 3 decides what a trial renders.
- A retry of a failed base check, and a recovery of a missing patch from published heads.
- The handoff policy still compares the whole team block, so an `eval` change during a pending handoff refuses that handoff, as a `features` change does today.
- Enrollment and the phone replace the whole team block, so a client that does not know `eval` drops it and turns capture off. That fails safe; a merge of unknown keys belongs to the client work.
