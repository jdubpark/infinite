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

# Slice: mining and validation

Spec part 1 (the validation fields, and `mine`), part 2 (mined tasks, provenance groups, validation), part 4 (the grader identity, for validation), part 6 (the `validate` job), and part 8 (the corpus summary, its routes, and `infinite eval status`), delivery step 2, with acceptance 2 and the first two clauses of acceptance 3 (Linear INF-281). After it, an owner turns on mining for a GitHub project. The host walks the base branch in the mirror and keeps each commit that changes a test file and another file as a `candidate`. Captured and mined tasks share provenance groups, and a mined copy of a captured task is rejected `duplicate-of-captured`. An owner's `validate` job runs candidates as the grader identity, and a task becomes `valid` only when its runner reports show the expected cases failing on the base twice and passing with the reference three times. `infinite eval status PROJECT` shows the counts, the coverage, the grader's state, and the jobs. Nothing spends model tokens, starts a session, or changes a run. It builds on the capture slice, the outcome ledger's base scan and landing signals, the halt, and the host-load gate, which are on `main`.

Where the design and the code disagree, this plan rules:

- Part 1 gives each project a `graderProfile`. Part 4 says each identity serves every project, and a launch profile in the code belongs to a provider session, not to a host command. **Ruling:** the grader is host configuration, `eval.grader`, a new top-level block of the host configuration. A project has no grader field.
- Part 2 makes a mined commit a `candidate` at once. Capture's `reconcileBatch` visits every `candidate` row and judges it by the ledger, so a mined row would end `ledger-missing`. **Ruling:** reconcile reads captured rows only, through a partial index (Task 2).
- Part 2's lineage rule has no time bound. Every run that touched a popular file (a lockfile, a package manifest) and has no observed landing would make every later commit that touches it unclear, merge those groups, and reject the mined task while any of them holds a captured `candidate`. **Ruling:** a captured task counts for lineage only when it was captured within 90 days before the commit (`LINEAGE_DAYS`, the ledger's `APPROVAL_DAYS`) and approved before it. A commit that would merge more than 64 groups is rejected `lineage-too-wide`. The summary shows the largest group, so the owner sees a merge that grows.
- Part 2 joins a mined commit to a run when "the outcome ledger's base branch scan matched the commit to the run". The ledger keeps the landing commit only inside a sealed signal payload, with no index by commit. **Ruling:** a bounded pass reads each run group's landing signal by its id (`landingSignalId(runId)`), and the corpus keeps a blind landing reference that both join directions read through an index.
- Part 2 condition 1 counts "passed cases in the hidden files". A TAP report names no file, and JUnit reporters differ in where they put one. **Ruling:** the focused test receives only the hidden files, so every case in its report counts as a case of the hidden files.
- Part 2 runs the base "with the hidden files added". Part 5 grades a result with the hidden files, every other test file, and every file under `gradingPaths` taken from the reference. **Ruling:** a base round uses part 5's construction on the replay base. Validation then checks exactly what grading will check: an unchanged base fails.
- Part 6's `EvalJob` needs `taskFilter.set` and trial limits. Sets arrive in step 4, and a `validate` job runs no trial and renders no prompt. **Ruling:** a validate job has its own request shape (Task 10), and its pinned digest covers the fields that decide a validation (the validation settings, `setup`, the checks, and `eval.grader`), not the prompt version or the permission policy.
- The rule "every Git command through `teams.commandPrefix`" covers the mirror and the team copies. Validation also runs Git as the grader inside the grader's own root. **Ruling:** those are grader commands, not host Git commands. They go through the grader launcher, which fixes the identity and the directory. Only the commands in the mirror are Git forms of `teams.commandPrefix` (see "Git commands").
- Acceptance 3's "no group spans both sets" needs the sets of step 4. **Ruling:** this slice proves the shared group and `duplicate-of-captured`, and stores the dev-only mark that step 4 reads.

**Rulings before the build.**

- Line numbers in this section were read on main `0e108bf`. Find each place by the quoted code.
- The grader account, its launcher, its sudo rule, and the three mirror forms wait for the owner (see "Owner approvals"). The slice ships with mining off for every project and with validation unable to start: without `eval.grader` the grader state is `not-configured`, a job waits with `waiting: "grader"`, and the summary says so.
- The owner defaults stand until the owner changes one: a backfill of 2,000 first-parent commits, 5,000 mined rows per project, the 90-day lineage window, and the limits of Tasks 4 to 10.
- Nothing periodic costs more as history grows. Every pass has a fixed bound, and no list route or tick reads the corpus once for each run, member, session, or task.
- The ledger records nothing for this slice. A validate job starts no session and changes no run, so no status change writes an outcome event. No run field is added, so nothing new reaches relay devices through the team view. No member prompt changes, so no prompt byte pin moves and the permission agent reads nothing new.

**The grader is its own account behind a root-owned launcher, and validation stays off without it.** Every validation command runs through `eval.grader.prefix` (for example `sudo -n -u infinite-grader -- /usr/local/libexec/infinite/grader-command`) as an account with no provider login, no repository credential, and no read access to host state. The launcher admits seven operations, confines each to the grader's root, starts every child from an empty environment, and limits its time, processes, and file sizes. Before each task the host probes the account: a different user id from the host, the configured root with mode `0700`, every canary path unreadable, and the cloud metadata address closed. Anything else is a named grader state, and no task starts. *(My call: the design names the account but not the means; a probe before each task turns each claim about the account into a check.)*

**Only a runner report validates, three times.** The host reads each report as the grader, through the launcher, at most 8 MiB, and parses it with a bounded parser. The reference round R1 fixes the expected cases, the guard checks must pass on a fresh reference copy, base rounds B1 and B2 must show the same nonempty set of expected cases not passing, and reference rounds R2 and R3 must pass exactly the expected set again. An exit code can reject (a failed guard, a time-out) but never validates, and a round without a parsable report is undecided, never a pass or a failure. After three undecided attempts a task ends `unvalidated`. *(My call: a missing base report proves nothing about the hidden cases, so it cannot count as their failure.)*

**Mining is a bounded walk with a sealed cursor, and a refused read mines nothing.** A pass mines at most 50 commits: first the commits added since the last pass, oldest first, then the backfill, newest first, until 2,000 first-parent commits are visited. Each commit is decided and its cursor advanced in one transaction, so a restart neither skips nor repeats a commit. A commit that changes no test file or no other file leaves no row. A refused, failed, or timed-out read ends the pass, keeps the cursor, and marks the project `failing`; it never records "no test change". *(My call: the bound keeps the corpus from crowding out captured tasks, and older history mostly fails setup with old dependencies.)*

**Groups are a small union-find in the corpus module, and the duplicate rule runs at every event that can create a duplicate.** A captured task's group is its run; a mined task starts in its own group. A landing join and a lineage merge both merge roots, and the smallest group id becomes the root, so the result does not depend on which merge came first. The rule "a root that holds a captured `candidate` or `valid` task holds no mined `candidate` or `valid` task" is applied after each mined insert, each merge, and each captured promotion. *(My call: the dev-only mark of a lineage merge is not undone by a later landing, so it can only err toward the dev set.)*

**The settings live in `project.team.eval` and in the host's `eval` block, outside the routine digest and every member context.** `mine`, `gradingPaths`, `focusedTest`, `reportFormat`, and `guardChecks` join the project's `eval` block, which `digestedProjectTeam` already removes before hashing and `withoutPrivateSettings` already drops from member contexts. `eval.grader` is a new top-level host block; `RoutineService.authority` hashes only `teams`, `source`, `linear`, and `agents` of the host configuration, so it stays out without a change. `mine` is false unless the owner sets it, and it is read only for a `github` project. *(My call: `candidateProfiles`, `memberProfile`, and `trialMinutes` wait for step 3, which reads them.)*

## Coordinator rulings (2026-11-16)

These override the text below them where the two differ.

1. **A task sees only its own job's input, and nothing a task leaves survives it.** One grader account serves every project. Without this rule, a test could read another job's bundle, which is another project's whole base branch. A file an earlier task planted would also live on, for example a `node_modules` directory in the root, which Node's upward module lookup finds from every job.
   - Install item 1 becomes `useradd --system --user-group --no-create-home --home-dir /var/lib/infinite-grader --shell /usr/sbin/nologin infinite-grader`, then `install -d -o root -g root -m 0755 /var/lib/infinite-grader`; item 2 follows as written. The grader can then write only under its root, and in the shared temporary directories that `stop` empties.
   - The launcher's `clean JOB` leaves exactly `ROOT/jobs/JOB/in/base.bundle`. It removes every other entry of `ROOT`, of `ROOT/jobs`, and of `ROOT/jobs/JOB`.
   - A new launcher operation, `digest JOB`, prints the SHA-256 hex of `ROOT/jobs/JOB/in/base.bundle`, or exits 2 when the file is missing. `Grader` gains `digest(job: string): Promise<{ state: "read"; sha256: string } | { state: "missing" | "failed" }>`, and the fixture launcher implements it.
   - The validation pump keeps two values in memory: the last job it prepared, and the SHA-256 of the bundle bytes it streamed (it already counts those bytes).
     - Before each task, when the last prepared job is another job or none, the pump calls `prepareJob`.
     - Otherwise it calls `digest`. A mismatch, `missing`, or `failed` prepares the job once more; if that fails too, the task ends `environment` `bundle-missing`.
     - `NextWork.fresh` is removed, because the pump decides.
   - The probe adds `ancestorsWritable`: a directory above `ROOT` that the grader can write gives `misconfigured`.
   - The host's derived canaries add `mirrorPath(id)` of every GitHub project, so a grader that can read a source mirror is `exposed`.
   - Tests:
     - Task 7's `the launcher confines every operation to its root` also plants `ROOT/node_modules`, `ROOT/jobs/OTHER/in/base.bundle` (OTHER another UUID), and `ROOT/jobs/JOB/extra`. After `clean JOB`, only `ROOT/jobs/JOB/in/base.bundle` exists, and `digest JOB` prints its SHA-256.
     - Task 9 adds `a changed bundle is streamed again`: a digest that differs from the streamed one gives a second `receive` before the clone, and a second mismatch gives `bundle-missing`.
     - Task 6's probe test adds a writable ancestor, which gives `misconfigured`.
2. **The launcher acts only as its own account, and no test runs `stop` as a person.** `stop` runs `kill -KILL -1` and deletes every file of the caller's in `/tmp`, `/var/tmp`, and `/dev/shm`. Run as the host account (a prefix without `sudo`), it would kill its parent, the host. Run by a test, it would kill the developer's or the release checker's processes and delete their temporary files.
   - The script sets `ACCOUNT=infinite-grader` beside `ROOT=`, and the owner edits both at install. Every operation first checks `[ "$(/usr/bin/id -un)" = "$ACCOUNT" ]` and exits 64 otherwise. The script sets its own `PATH=/usr/bin:/bin` and calls its tools by absolute path.
   - The probe maps exit 64 to `misconfigured`. The host runs `stop` only after a probe in this process answered `ready`, and Task 13's startup clean waits for that probe.
   - Task 7's tests:
     - They rewrite `ACCOUNT` to the current user only for `receive`, `run`, `read`, `digest`, `clean`, and `remove`. They never call `stop` with that rewrite.
     - One test calls `stop` with `ACCOUNT` set to another name: it exits 64, and a `sleep` that the test started still runs.
     - `the launcher ends a round at its limit` proves without `stop` that no process of the round remains: it looks for a unique `sleep` argument with `pgrep -f`.
     - The launcher test imports only `node:` modules, so it runs in a Linux container with plain Node (ruling 6).
   - `deploy/ubuntu/grader.md` verifies the real `stop` at install: start a `sleep` as the grader, run `stop`, and see the `sleep` gone.
3. **A child cannot borrow the launcher's exit codes.** In `run`, once the child has started, the launcher exits with:
   - the child's status, when it is below 64;
   - 124 at the time limit (the host still checks the elapsed time);
   - 1 for any other status.

   Codes 64 and 125 come only from the launcher, before the child starts. Without this rule, a setup step that exits 125 would read as a launcher failure. `docker run` exits 125 on a daemon error, and `git bisect run` uses 125 for "skip". A launcher failure counts no attempt, so the job would visit the same task again until its wall limit.
   - The probe checks that `setsid`, `timeout`, `prlimit`, `env`, `sha256sum`, `realpath`, and `find` exist, and answers `misconfigured` otherwise.
   - Task 7 adds the test `a child cannot borrow the launcher's codes`: `run JOB round-1 10 -- /bin/sh -c 'exit 125'` exits 1, `exit 64` exits 1, and `exit 7` exits 7.
4. **The probe runs before each task**, as the intro and the trust boundary say. Task 13's ten-minute cache serves `summary` only. When a probe answers anything but `ready`, the job waits `grader`, and the task does not start.
5. **Task 1 may make compile-only fixes** in `eval-store.ts` and `eval-capture.ts` if the wider `EvalState` breaks them, because it runs alone. It reports each line.
6. **Verification.** The laptop runs macOS, where `tests/eval-grader-launcher.test.ts` skips. The coordinator runs that test once in a Linux container, as a non-root user, and records the result in the pull request.
7. **The docs name every loopback listener, and what stays the owner's choice.**
   - `docs/security.md` and `deploy/ubuntu/grader.md` list each loopback service of the deploy template with the credential it requires: the API (a device token), hooks (a hook token), the egress proxy (its password), the GitHub proxy (a grant), the relay's listener, and any other listener the template starts.
   - They also state:
     - memory and CPU in a round are bounded only by the wall limit and by the host-load check before the task;
     - `/proc` shows agents' command lines to the grader, unless the owner mounts it with `hidepid=invisible` and a `gid=` exemption for the host account;
     - a private `/tmp`, a disk quota, and a memory limit are the owner's choices.
   - `grader.md`'s canary list also names the agent account's provider login directories.
   - Its install checks include:
     - `sudo -l -U infinite-host`, which shows exactly one grader rule;
     - an `env` round through the launcher, with `INFINITE_HOOK_TOKEN` exported by the caller, which prints exactly the fixed list;
     - the `stop` check of ruling 2.
8. **Added to "Not in this slice":**
   - rendering the grader files for a second instance (`scripts/render-instance.mjs`);
   - a transient systemd unit per round, as later hardening: a private `/proc` and `/tmp`, a cgroup kill, and memory limits.
9. **Merge order.** This slice is independent of INF-280 and INF-282. Whichever merges second rebases `server.ts`, `docs/teams.md`, and `scripts/file-size-baseline.json`.
10. **Report keys stay per format.** A JUnit key keeps `classname`, as the plan says, and a TAP key has none, so the two formats give different keys for one run. Node's JUnit reporter always writes `classname="test"`.
    - A project pins one `reportFormat`, and a change of it blocks the job (`configuration-changed`).
    - Task 8's test becomes `node's two reporters parse to the same statuses`: three cases in each format with the expected statuses, and each TAP key equal to its JUnit key without the `classname` part.
    - `caseRef(key)` is the SHA-256 hex of a raw case key, the function `parseReport` uses for its map keys. It has no display form.
    - Step 3 compares expected cases only under the format that validated them.
11. **Cleanup limits.** `clean` and `remove` get 600 seconds, because a task's round clones and their dependencies can hold hundreds of thousands of files. `read` and `stop` keep 30 seconds, and `receive` and `digest` 600.
12. **A rewrite answer must be followed by a read before it moves the cursor.** Form 1's `no` changes the cursor only in the transaction of the first commit visited after it (mined, rejected, or skipped). If the next read fails, nothing is written. A launcher that refuses form 1 with exit 1 therefore mines nothing and claims no rewrite. Task 5 also maps E2's `too-large` to `capsule-too-large`.
13. **Each task keeps its own index test.** Tasks 3, 5, 10, and 11 run in parallel pairs, so none of them edits `tests/eval-store-v2.test.ts`. Each adds a test named `the hot statements read through an index` to its own test file, with the same `EXPLAIN QUERY PLAN` check as Task 2's, listing its exported statements and the index each must `SEARCH`.
14. **The smallest group id is the root, and Task 3's table follows it.** The decision stands: `mergeRoots` picks the smallest id in code-unit order, so a mined group (`mined:…`) is the root of every merge with a run group (`run:…`), whichever merge came first.
    - `the three group facts give one result in every order` expects `rootOf` of both tasks to be the mined task's group id.
    - `a deleted run leaves its mined copy` expects the mined row, its state, and its group row (the root, with its `dev_only`) to stay. The run's group row, which no task names and which is no other row's root, goes: the first `sweepGroups` returns 1, and a second returns 0.
    - `groupStats` counts root rows (`total`), roots with `dev_only` 1 (`devOnly`), and the most tasks under one root (`largest`). Task 11 uses these meanings.
    - Task 3's step M joins a landed run group through `eval_groups_landing`, as Task 5's transaction does, so the order L-M-P gives the same result.
15. **Task 9's calls, the grader's `stop`, and what Task 13 owes.**
    - Accepted from Task 9: R2 and R3 must pass exactly E, as the test table reads; `ValidateContext.bundle` (`BundleState`: the bundle factory, the job last streamed, its digest, and the job already streamed again for a missing commit), which the pump owns across tasks; a non-zero exit or a time-out of a preparation command (clone, checkout, restore, apply, commit, update-ref, diff) is undecided `setup-failed`, and a launcher failure is `grader-failed`; a missing patch rejects `patch-missing` and an oversized one `patch-too-large`; a mined task's base is its first parent; `restoreLists`' `files` is the task's file list.
    - **`stop` bypasses the grader's channel.** `launcherGrader`'s `stop` neither waits for nor takes the channel that a running command holds, so a halt reaches a running round within 10 seconds. Task 9's repair makes the change in `eval-grader.ts`, with a test in `tests/eval-grader.test.ts`.
    - **The report directory is the launcher's.** The launcher creates `work/reports` for every operation, and the fixture's `run` does the same. The validator runs no `mkdir`.
    - **Task 13's pump** supplies `bundle` and keeps it across tasks; probes the grader before each task (ruling 4); calls `record` after every task, also when `validateTask` throws, so `inFlight` never outlives its task; and after an `environment` outcome waits one pump interval before its next `next`, so a task whose cause persists is not handed out again at once.
    - Task 10's `record` clears `inFlight` before its write, so a failed write still frees the next job.
16. **A job names its project in the request body.** `EvalHostApi.create` takes a project id, and the body of Task 11 gave it none. `POST /api/eval/jobs` takes `{ projectId, requestId, job }`. A `projectId` that names no configured project is `404` `unknown-project`. The answer's body is `create`'s `{ created, job }`, with `201` when created and `200` otherwise. The CLI is `infinite eval run PROJECT --file job.json --request-id UUID [--json]`, like `status PROJECT`, and sends `{ projectId, requestId, job }`. Task 12 carries the change; Task 11 builds the route to it.
17. **A rewrite moves the forward cursor with its head's own decision.** Form 1's `no` decides the head commit first; that write sets `forward` to the head and restarts the backfill at the head's first parent with `visited` kept. Before this ruling the head waited for the backfill, so a project whose backfill had reached its 2,000-commit bound never mined again after a rewrite. Ruling 12 still holds: nothing moves until the head's read succeeds. A forward list over 500 commits keeps the newest 500; the older ones are neither mined nor counted, since counting them needs a read outside the approved Git commands. Task 5 carries both.

## Trust boundary, and what a review checks

The miner, the groups pass, the validator, the jobs, the routes, and the CLI are host code. These inputs originate outside the host:

- **The base branch in the mirror.** Anyone with push rights writes it, and members write it through delivery. Commit ids pass `COMMIT_ID` before they enter an argument. File names arrive NUL-separated from E1, at most 29 entries per mined commit and 64 KiB of output; they are sealed, never logged, never used as a host path, and never put into a host Git argument. Commit messages arrive from E2, at most 24,000 characters; they are sealed in the capsule and pass the secret-shape check first. Committer times are set by whoever made the commit; they decide only the lineage comparison, so a wrong time can move a commit between its own group and a run's group, never expose material.
- **The repository's test code.** The focused test, `setup`, and the guard checks run code from the repository at old commits. It runs only as the grader, in a fresh copy under the grader's root, with the launcher's limits.
- **Runner reports and other grader output.** Bytes the grader account wrote. The host reads them only through the launcher, as the grader, so a planted link reaches only what the grader can read. A report is at most 8 MiB, 20,000 cases, and 4,096 characters per case key; case keys are stored only as SHA-256 hashes. The restore list that the grader prints can only shorten the host's own lists, never add a name.
- **Owner configuration.** `project.team.eval`, through the owner-only `PUT /api/projects/:id/team` or the configuration file, and the host's `eval.grader`, through the configuration file. Strict schemas.
- **Device roles.** Owner, controller, and viewer read the summary and the jobs, which hold only ids, enumerations, counts, and times. Only the owner creates or controls a job and retires a task.
- **The launchers.** `teams.commandPrefix` and the grader launcher answer with exit codes and bounded output. A refusal, a time-out, or a truncation is a failed read.
- **Host state.** Kept run records (`deliveryReceipt.mergeCommit`, the objective, the brief) through `TeamService.understandingRecords()`, and the ledger's landing signals through `readSignal`.

**What a hostile test can reach.** A test runs as the grader identity in `ROOT/jobs/JOB/work/round-N`. It has:

- **No host credential in its environment.** The host starts the launcher with only `PATH` and `LANG`, and the launcher starts the child from an empty environment plus a fixed list (Task 7). No GitHub grant, egress password, hook token, provider login, or proxy variable reaches it. Test: `the launcher starts the child with an empty environment`.
- **No read access to host files.** The evidence database, the vault key file, `stateDir`, `runDir`, the team workspace root, and the owner's listed credential paths (`eval.grader.canaries`: the GitHub App, grant, egress, and vault key paths of the deploy template) are canaries; the probe proves each unreadable before each task, or the state is `exposed`. Test: `the probe names every unsafe state`.
- **No way into the host's own reads.** The host never opens a file under the grader's root; it reads reports through the launcher's `read`, which admits only `reports/round-[1-6].(xml|tap)` and refuses links. Test: `the host reads only reports, and only as the grader`.
- **No signal to another account.** A different user id cannot signal, trace, or read the environment of host or agent processes.
- **No credential-free network service that matters.** The cloud metadata address is the one credential-free source; the probe requires it closed (`network-open` otherwise). The recommended nftables rule also rejects private, link-local, CGNAT, and multicast ranges for the grader. Loopback services stay reachable, and each requires a credential that the grader does not hold (the API needs a device token, hooks a hook token, the egress proxy its password).
- **No life after its task.** The host stops every grader process after each round and after each task (three rounds of `stop` and the process inventory of `team-retirement.ts`); a process that survives blocks the job with `grader-processes-alive`. `stop` also removes the grader's files in `/tmp`, `/var/tmp`, and `/dev/shm`. Each task gets a new `HOME` and `TMPDIR`. Test: `a surviving grader process blocks the job`.

What stays reachable, and the docs say so: the shared `/tmp` (only what other accounts leave readable there; the host writes no eval material outside the grader's root), process command lines in `/proc` (the host passes no secret in an argument), loopback services, the public network (package installs need it), and the disk (a file is at most 4 GiB; the host requires 10 GiB and 200,000 inodes free before each task; a quota is the owner's hardening choice).

**What reaches the store.** A mined capsule holds a commit message, or a kept run's objective and brief. A member that held a GitHub grant or an egress password could have written one into a commit message. `findSecret` (`evidence/secret-scan.ts`) checks the capsule before it is sealed; any match, the host-issued grant and egress shapes included, rejects the commit `secret-shaped` and stores no capsule. Validation stores file lists (repository names, sealed) and case-key hashes. No log line, error body, or CLI line carries a name, a message, a commit id, or a case. Besides the store's write-failure line, the new log lines are `Eval mining paused (CODE).` and `Eval validation paused (CODE).`, once per code per process, where CODE is an enumeration.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| Mining the merge commit (M), observing the run's landing (L), and promoting the captured task (P), in all six orders, once with a file overlap and once without | In every order: the captured task `candidate`, the mined task `rejected` `duplicate-of-captured`, both under the root `run:RUN`. With the overlap, the root is dev-only exactly in the three orders where M comes before L; without it, in none | Task 3 `the three group facts give one result in every order` |
| After every step of every order above | No root holds both a captured `candidate` or `valid` task and a mined `candidate` or `valid` task | Task 3 `the three group facts give one result in every order` |
| A restart between a mined insert and the next commit, and a pass that runs twice over the same head | Each commit has one row; the cursor advances once per commit; `visited` counts each commit once | Task 5 `a commit is mined once across a restart` |
| The launcher refuses E1 or E2, or a read times out | No row; the cursor stays; mining `failing`; the next pass retries after an hour | Task 5 `a refused read mines nothing and claims nothing` |
| A rewritten base branch (form 1 answers 1) | The forward walk restarts at the new head; rows stay; validation later retires a task whose anchor is gone with `anchor-missing` | Task 5 `a rewritten branch restarts the walk`; Task 9 `a missing anchor retires a valid task` |
| No `eval.grader`, or a probe that shows `unavailable`, `misconfigured`, `exposed`, or `network-open` | No task starts; the job waits `grader`; the summary shows the state | Task 6 `the probe names every unsafe state`; Task 13 `no grader, no validation` |
| A focused test that exits 0 and writes no report | Undecided, never valid; the third such attempt ends `unvalidated` | Task 9 `an exit code never validates` |
| A test that passes at the parent; a test that fails one of three reference rounds | `rejected` `not-fail-to-pass`; `rejected` `flaky` | Task 13 `a fixture commit becomes valid, and the two bad ones are rejected` (acceptance 2) |
| A grader process that survives three stops | The job `blocked` `grader-processes-alive`; no other task starts while it lives | Task 6 `a surviving grader process blocks the job` |
| A host restart during a task | The attempt is not counted; the new process runs `stop` and `clean` before any task and visits the task again | Task 13 `a restart in the middle of a task counts no attempt` |
| An owner halt during a round | The round stops within 10 seconds; the attempt is not counted; the job waits `halt` | Task 9 `a halt stops the round within ten seconds` |
| A changed validation setting, `setup`, check, or `eval.grader` during a job | `blocked` `configuration-changed` before the next task; `resume` pins the new digest | Task 10 `a changed configuration blocks the job` |
| The same request id twice; the same id with another body | One job; `409` `request-conflict` | Task 10 `a request id makes one job` |
| A captured task becomes `candidate` or `valid` after its mined copy became `valid` | The mined task `retired` `duplicate-of-captured` | Task 3 `a promotion retires a valid mined copy` |
| A valid captured task whose attempt the owner excludes | `retired` `excluded`, material removed | Task 2 `a valid captured task is retired, never promoted again` |
| A deleted cancelled run whose group holds a mined task | The captured rows and their paths go; the mined row and the group rows stay | Task 3 `a deleted run leaves its mined copy` |
| An unavailable store, or a module that is not ready | Tick, mining, and validation do nothing and throw nothing; routes answer `503` `evidence-unavailable` | Task 13 `an unavailable store takes nothing and throws nothing` |
| A mined or captured payload that does not open | Validation rejects it `unreadable` and removes its material | Task 9 `unreadable records are never validated` |
| A v1 store with captured rows; a rollback to a host whose module is version 1 | The v2 migration keeps every row and gives it its run group; the old host finds a newer stored version and leaves the module unavailable | Task 2 `the v2 migration keeps every v1 row`, `a v1 host leaves a v2 store alone` |

Outside this slice: trials, the eval identity, the trial source and its probes, grading, `baseline` jobs, the dev and holdout sets, exposure, reports, priors, and the learning budget.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/eval-config.ts` (modify) | The new `eval` fields, `mineSettings`, `validationSettings`, and the host `eval` block schema |
| `packages/host/src/eval-types.ts` (modify) | States, origins, reasons, the mined payload, grader, job, summary, and host API types |
| `packages/host/src/config.ts` (modify, 1 line) | `eval: evalHostSchema.optional(),` in the host schema |
| `packages/host/src/types.ts` (modify, 2 lines) | `eval?: EvalHostConfig` in `Config`, with its comment |
| `packages/host/src/evidence/crypto.ts` (modify, in place) | Index classes `eval-commit` and `eval-path` |
| `packages/host/src/eval-store.ts` (modify) | Module version 2: the migration, the new columns, the captured-only reconcile, `rejectTask`, `retireTask`, `indexPaths` |
| `packages/host/src/eval-groups.ts` (create) | Group rows, roots, merges, the duplicate rule, landings, lineage, and the groups pass |
| `packages/host/src/eval-capture.ts` (modify, 3 lines) | The `onPromoted` option, passed to `reconcileBatch` |
| `packages/host/src/eval-mine-rules.ts` (create) | Pure: numstat parsing, the mining verdict, the message, the capsule, parent directories |
| `packages/host/src/eval-mine-git.ts` (create) | The mirror reads of mining (forms 1 to 4, E1, E2) and the bundle stream (E3) |
| `packages/host/src/eval-miner.ts` (create) | The `Miner`: passes, the sealed cursor, mined rows |
| `packages/host/src/eval-grader.ts` (create) | The launcher client, the probe and grader states, the stop rounds |
| `deploy/ubuntu/grader-command.sh`, `deploy/ubuntu/grader.sudoers`, `deploy/ubuntu/grader.nft` (create) | The launcher template, its sudo rule, the recommended network rule |
| `packages/host/src/eval-report.ts` (create) | Pure: the JUnit and TAP parsers, case keys and hashes |
| `packages/host/src/eval-validate-rules.ts` (create) | Pure: the round verdict, the focused argv, the restore lists |
| `packages/host/src/eval-validate.ts` (create) | Job preparation and the validation of one task |
| `packages/host/src/eval-jobs.ts` (create) | The `validate` job: schema, rows, transitions, the pinned digest, the next task |
| `packages/host/src/eval-summary.ts` (create) | The corpus summary and the coverage |
| `packages/host/src/eval-routes.ts` (create) | `/api/eval/...` |
| `packages/host/src/eval-cli.ts` (create) | `infinite eval ...` |
| `packages/host/src/client.ts` (modify, +2 lines) | One import and one dispatch line; `eval` in `CLIENT_COMMANDS` in place |
| `scripts/file-size-baseline.json` (modify) | `client.ts` 1,403 to 1,405 (reviewed raise, Task 12) |
| `packages/host/src/eval-host.ts` (create) | `EvalHost`: composition, the validation pump, timers, the host API |
| `packages/host/src/server.ts` (modify, net 0 lines) | Construct, wire, start, route, close |
| `tests/fixtures/grader-command.mjs` (create) | A same-user launcher with the production operations, for tests |
| `docs/teams.md`, `docs/security.md`, `deploy/ubuntu/grader.md`, the spec (modify or create) | Mining, validation, the grader, its installs, the amendments |
| `tests/eval-{store-v2,groups,mine,miner,grader,grader-launcher,report,validate,jobs,routes,cli,validate-run}.test.ts` (create); `tests/eval-config.test.ts`, `tests/eval-store.test.ts`, `tests/routines.test.ts` (modify) | Pure rules, a real store, real Git, the fixture launcher, the host |

`teams.ts`, `team-cli.ts`, `tests/teams.test.ts`, `outcome-store.ts`, and `evidence/store.ts` do not change. `server.ts` stays at 2,282 lines: Task 13 replaces five lines in place, removes two, and adds two. `client.ts` grows by 2 lines with a reviewed baseline raise, because a new top-level command needs its import and its dispatch line; the handler is in `eval-cli.ts`. Every new source file stays under 600 lines; `eval-store.ts` grows from 548 to at most 700.

**Order and owners.** Task 1 runs first and is small. Then Tasks 2, 4, 6, 7, 8, 12, and 14 run in parallel. Task 3 and Task 10 wait for Task 2. Task 5 waits for Tasks 3 and 4. Task 9 waits for Tasks 2, 6, and 8. Task 11 waits for Tasks 3 and 10. Task 13 waits for Tasks 5, 9, 10, and 11. Each file has one writer: Task 3 alone touches `eval-capture.ts`, Task 12 alone touches `client.ts` and the baseline file, and Task 13 alone touches `server.ts`. Tasks 9 and 10 build against each other's interfaces as fixed below, without talking.

## Review Focus

1. A hostile test reaching a host secret or the store: a credential in the child's environment, a canary the grader can read, a host read of a grader file, a process that outlives its task. Expect none (Task 7 `the launcher starts the child with an empty environment`, `the launcher confines every operation to its root`; Task 6 `the probe names every unsafe state`, `a surviving grader process blocks the job`; Task 9 `the host reads only reports, and only as the grader`).
2. A task made valid by anything but three reports: an exit code, a missing or invalid report, an empty expected set, a base report that is missing, a flaky round. Expect a rejection or an undecided attempt (Task 8 `every round decides as the plan says`; Task 9 `an exit code never validates`; Task 13 `a fixture commit becomes valid, and the two bad ones are rejected`).
3. A mined copy that survives beside its captured task, or a group result that depends on the order of mining, landing, and promotion. Expect one result (Task 3 `the three group facts give one result in every order`, `a promotion retires a valid mined copy`).
4. A guess where mining has no fact: a refused read recorded as "no test change", a truncated numstat read as small, a binary change counted as zero lines, a cursor that skips or repeats a commit across a restart, mined rows that fill the capture cap. Expect a named state or no row (Task 4 `a truncated or binary read is never small`; Task 5 `a refused read mines nothing and claims nothing`, `a commit is mined once across a restart`, `mined rows stop at their own cap`; Task 2 `mined rows stay out of capture's reads and cap`).
5. Text in a plain column, a log line, an error, or CLI output; a secret in a capsule. Expect only ids, enumerations, counts, times, blind references, and hashes (Task 2 `the v2 tables keep every text sealed`; Task 5 `a secret-shaped message is never stored`; Task 12 `status prints only ids, states, and counts`).

### Task 1: the settings and the shared types

**Files:** `packages/host/src/eval-config.ts`, `packages/host/src/eval-types.ts`, `packages/host/src/config.ts` (1 line), `packages/host/src/types.ts` (2 lines), `tests/eval-config.test.ts`, `tests/routines.test.ts`. Runs first. Every other task starts from its commit.

**Interfaces (produces):**
```ts
// eval-config.ts (imports zod and node:path only)
export const GRADING_PATHS_MAX = 64, GUARD_CHECKS_MAX = 8, GRADER_CANARIES_MAX = 32;
export const FILES_PLACEHOLDER = "{files}", REPORT_PLACEHOLDER = "{report}";
// evalProjectSchema gains, all optional:
//   mine: boolean
//   gradingPaths: repositoryPrefix[] (at most 64)
//   focusedTest: command (the teamCommandSchema shape, repeated here)
//   reportFormat: "junit" | "tap"
//   guardChecks: command[] (at most 8)
export type ValidationSettings = {
  focusedTest: { command: string; args: string[] }; reportFormat: "junit" | "tap";
  gradingPaths: string[]; guardChecks: { command: string; args: string[] }[]; setup?: { command: string; args: string[] };
};
/** The block when the project turned mining on and follows GitHub; otherwise undefined. */
export function mineSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings } } | undefined): EvalProjectSettings | undefined;
/** What a validate job needs, or the first missing key in the order source, focusedTest, reportFormat. */
export function validationSettings(project: { source?: { mode: string }; team?: { eval?: EvalProjectSettings; checks?: { command: string; args: string[] }[]; setup?: { command: string; args: string[] } } } | undefined):
  { settings: ValidationSettings } | { missing: "source" | "focusedTest" | "reportFormat" };
export const evalHostSchema: z.ZodType<EvalHostConfig>;
export type EvalHostConfig = { grader?: EvalGraderConfig };
export type EvalGraderConfig = { prefix: { command: string; args: string[] }; root: string; canaries?: string[] };

// eval-types.ts additions (types and constants only)
export const EVAL_STATES = ["captured", "candidate", "valid", "rejected", "retired"] as const;
export const MINE_REASONS = ["too-large", "binary-change", "revert", "secret-shaped", "lineage-too-wide", "duplicate-of-captured"] as const;
export const VALIDATION_REASONS = ["not-fail-to-pass", "guard-failed", "flaky", "too-slow", "anchor-missing", "unvalidated", "owner-retired"] as const;
export type EvalState = typeof EVAL_STATES[number];            // replaces the three-state type
export type EvalOrigin = "captured" | "mined";
export type MineReason = typeof MINE_REASONS[number];
export type ValidationReason = typeof VALIDATION_REASONS[number];
export type EvalReason = StartReason | MaterialReason | PromotionReason | MineReason | ValidationReason;
export type PromptOrigin = "assignment" | "run-objective" | "commit-message";
export type Lineage = "clear" | "unclear";
/** Sealed in eval_tasks.payload for a mined task. */
export type MinedPayload = {
  projectId: string; anchorCommit: string; commit: string; commitTime: string;
  promptOrigin: "run-objective" | "commit-message"; runId?: string;
  files: string[]; hiddenFiles: string[]; features: EvalFeatures;
  expectedCases?: string[];          // SHA-256 hex of each case key, after validation
};
// CapturedPayload gains `expectedCases?: string[]`.
// EvalTaskRow: origin EvalOrigin; payload CapturedPayload | MinedPayload | RejectedPayload; and
//   groupId: string | null; lineage: Lineage | null; validatedAt: string | null; attempts: number.
export type GraderState = "not-configured" | "unavailable" | "misconfigured" | "exposed" | "network-open" | "ready";
export type MiningState = "off" | "waiting" | "mining" | "caught-up" | "full" | "failing";
export type MiningStatus = { state: MiningState; visited: number | null; mined: number | null; skipped: number | null; failures: number | null; backfillDone: boolean | null };
export type EvalJobReason = "owner" | "validation-stuck" | "configuration-changed" | "grader-processes-alive" | "limit-reached" | "done" | "expired";
export type EvalJobWait = "grader" | "window" | "host-load" | "halt" | "storage" | "bundle" | "mirror" | "another-job";
export type EvalJobView = {
  jobId: string; projectId: string | null; kind: "validate"; status: RoutineStatus;
  reason: EvalJobReason | null; waiting: EvalJobWait | null;
  createdAt: string; startedAt: string | null; expiresAt: string; finishedAt: string | null;
  counts: { visited: number; valid: number; rejected: number; retired: number; undecided: number };
};
export type ValidateJobRequest = {
  kind: "validate";
  taskFilter?: { taskIds?: string[]; origins?: EvalOrigin[]; areas?: string[]; revalidate?: boolean; maxTasks?: number };
  limits: { maxWallMinutes: number };
  windows?: { startHourUtc: number; endHourUtc: number }[];
  expiresAt?: string;
};
export type EvalSummary = {
  projectId: string;
  capture: { on: boolean };
  mining: { on: boolean } & MiningStatus;
  tasks: { byState: Record<EvalState, number>; byOrigin: Record<EvalOrigin, Record<EvalState, number>>;
           byArea: { area: string; candidate: number; valid: number }[]; bySet: null };
  groups: { total: number; devOnly: number; largest: number };
  coverage: { days: number; validCaptured: number; accepted: number; share: number } | null;
  grader: { state: GraderState };
  jobs: EvalJobView[];
};
export type EvalRefusal = { status: 400 | 404 | 409 | 503; code: "invalid-eval-request" | "unknown-project" | "unknown-job" | "unknown-task"
  | "job-active" | "request-conflict" | "eval-config-incomplete" | "invalid-job-transition" | "task-not-active" | "evidence-unavailable" };
export interface EvalHostApi {
  summary(projectId: string): Promise<EvalSummary | EvalRefusal>;
  jobs(): EvalJobView[] | EvalRefusal;
  job(jobId: string): EvalJobView | EvalRefusal;
  create(projectId: string, request: ValidateJobRequest, requestId: string): { created: boolean; job: EvalJobView } | EvalRefusal;
  control(jobId: string, action: "pause" | "resume" | "cancel"): EvalJobView | EvalRefusal;
  retire(taskId: string): { taskId: string; state: "retired" } | EvalRefusal;
}
```

**Decisions:**

- **`focusedTest`.** `{files}` is exactly one whole argument; `{report}` occurs exactly once in all arguments together, as a whole argument or inside one (for example `--test-reporter-destination={report}`); `command` holds neither. Both rules are schema refinements with fixed messages.
- **`gradingPaths`** use the `repositoryPrefix` rule already in the file. **`eval.grader`**: `prefix` is the command shape; `root` and every canary are absolute, at most 4,096 characters; at most 32 canaries. No defaults, so a parsed block is exactly what the owner wrote.
- `validationSettings` takes `guardChecks` when set, else the project's `checks`, and `gradingPaths` `[]` when absent. `mineSettings` mirrors `captureSettings`: the block only when `mine === true` and `source.mode === "github"`.
- `config.ts` adds `eval: evalHostSchema.optional(),` after `source`; `types.ts` adds `/** Replay eval host settings: the grader identity. Outside the routine approval digest. */` and `eval?: import("./eval-config.js").EvalHostConfig;`. `config-identity.ts` and `routines.ts` do not change.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the eval block is optional and strict` (eval-config, extended) | `{ mine: true }` and a complete validation block parse. Each fails: `{files}` twice, `--x={files}`, no `{report}`, `{report}` twice, `{report}` in `command`, 65 `gradingPaths`, a grading path `a/../b`, `reportFormat` `xml`, 9 guard checks. |
| `mining is on only for a GitHub project that asks for it` (eval-config) | `mineSettings`: no team, no `eval`, `mine` false, and `mine` true with source `laptop` give undefined; `mine` true with `github` gives the block; `capture` true alone gives undefined. |
| `a validate job names the first missing setting` (eval-config) | `validationSettings`: a laptop project gives `{ missing: "source" }`; no `focusedTest`, `focusedTest`; no `reportFormat`, `reportFormat`; a complete block gives `guardChecks` equal to the project's `checks` and `gradingPaths` `[]`, and `setup` from the team block. `evalHostSchema` refuses a relative `root`, a relative canary, 33 canaries, and an unknown key. |
| `eval settings stay out of the routine approval digest` (routines, extended) | The existing test also sets `mine: true`, `focusedTest`, `reportFormat: "junit"`, and `gradingPaths: ["package.json"]` in `team.eval`, and a host `eval.grader` block; the routine stays `running`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-config.test.ts`, then `tests/routines.test.ts` on the host, then the typecheck, then commit.

### Task 2: the store, version 2

**Files:** `packages/host/src/eval-store.ts`, `packages/host/src/evidence/crypto.ts` (two classes, in place), `tests/eval-store-v2.test.ts`, `tests/eval-store.test.ts` (no new test; it must keep passing). Needs Task 1. Runs in parallel with Tasks 4, 6, 7, 8, 12, and 14.

**Interfaces (produces):** module `eval-corpus`, version 2, `readVersion` 2. `migrate(tx, from)` runs the v1 schema when `from` is 0, then these statements when `from` is below 2, in the same transaction as the version record:
```sql
ALTER TABLE eval_tasks ADD COLUMN group_id TEXT;            -- 'run:' || run_id, or a mined task's own id
ALTER TABLE eval_tasks ADD COLUMN commit_ref TEXT;          -- mined: index('eval-commit', commit)
ALTER TABLE eval_tasks ADD COLUMN area_ref TEXT;            -- index('area', features.area), set with the features
ALTER TABLE eval_tasks ADD COLUMN lineage TEXT;             -- mined: clear | unclear; NULL for captured
ALTER TABLE eval_tasks ADD COLUMN validated_at TEXT;
ALTER TABLE eval_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE eval_tasks ADD COLUMN paths_indexed INTEGER NOT NULL DEFAULT 0;
UPDATE eval_tasks SET group_id = 'run:' || run_id WHERE origin = 'captured';
DROP INDEX IF EXISTS eval_tasks_check;
CREATE INDEX eval_tasks_check_captured ON eval_tasks (state, checked_at, task_id) WHERE origin = 'captured';
CREATE INDEX eval_tasks_group ON eval_tasks (group_id, origin, state);
CREATE UNIQUE INDEX eval_tasks_commit ON eval_tasks (project_ref, commit_ref) WHERE commit_ref IS NOT NULL;
CREATE INDEX eval_tasks_summary ON eval_tasks (project_ref, origin, state, area_ref);
CREATE INDEX eval_tasks_next ON eval_tasks (project_ref, state, task_id);
CREATE INDEX eval_tasks_unindexed ON eval_tasks (project_ref, task_id) WHERE paths_indexed = 0 AND material IN ('stored', 'partial');
CREATE TABLE eval_groups (
  group_id TEXT PRIMARY KEY, kind TEXT NOT NULL,            -- run | mined
  project_ref TEXT NOT NULL, root_id TEXT NOT NULL,         -- root_id = group_id for a root
  dev_only INTEGER NOT NULL DEFAULT 0,                      -- read on the root row only
  landing_ref TEXT, landing_checked_at TEXT, created_at TEXT NOT NULL);
CREATE INDEX eval_groups_root ON eval_groups (root_id);
CREATE INDEX eval_groups_project ON eval_groups (project_ref, root_id);
CREATE INDEX eval_groups_landing ON eval_groups (project_ref, landing_ref) WHERE landing_ref IS NOT NULL;
CREATE INDEX eval_groups_unlanded ON eval_groups (landing_checked_at, group_id) WHERE landing_ref IS NULL AND kind = 'run';
INSERT OR IGNORE INTO eval_groups (group_id, kind, project_ref, root_id, created_at)
  SELECT 'run:' || run_id, 'run', project_ref, 'run:' || run_id, MIN(captured_at) FROM eval_tasks WHERE origin = 'captured' GROUP BY run_id, project_ref;
CREATE TABLE eval_paths (
  path_ref TEXT NOT NULL,                                   -- index('eval-path', projectId + '\0' + path)
  captured_at TEXT NOT NULL, task_id TEXT NOT NULL,
  PRIMARY KEY (path_ref, captured_at, task_id)) WITHOUT ROWID;
CREATE INDEX eval_paths_task ON eval_paths (task_id);
CREATE TABLE eval_mining (
  project_ref TEXT PRIMARY KEY, state TEXT NOT NULL,        -- a MiningState
  visited INTEGER NOT NULL DEFAULT 0, mined INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, retry_at TEXT, updated_at TEXT NOT NULL,
  payload TEXT NOT NULL);                                   -- sealed MiningCursor, row id project_ref
CREATE TABLE eval_jobs (
  job_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT, waiting TEXT, request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, started_at TEXT, expires_at TEXT NOT NULL, finished_at TEXT, updated_at TEXT NOT NULL,
  visited INTEGER NOT NULL DEFAULT 0, valid INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0,
  retired INTEGER NOT NULL DEFAULT 0, undecided INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,                                              -- the last task id the job visited
  payload TEXT NOT NULL);                                   -- sealed { projectId, request, requestDigest, pinnedDigest }, row id job_id
CREATE INDEX eval_jobs_project ON eval_jobs (project_ref, status);
CREATE INDEX eval_jobs_status ON eval_jobs (status, created_at, job_id);
CREATE INDEX eval_jobs_created ON eval_jobs (created_at, job_id);
```
```ts
export const RECONCILE_ORDER_SQL = "SELECT task_id, checked_at FROM eval_tasks WHERE origin = 'captured' AND state = ? ORDER BY checked_at, task_id LIMIT ?";
export const PATHS_PENDING_SQL = "SELECT 1 AS one FROM eval_tasks WHERE project_ref = ? AND paths_indexed = 0 AND material IN ('stored', 'partial') LIMIT 1";
export type Promoted = (tx: EvidenceTx, task: EvalTaskRow) => void;
export function reconcileBatch(tx: EvidenceTx, decide: Decide, at: string, limit?: number, onPromoted?: Promoted): ReconcileResult;
/** The one reject rule, now exported. It also deletes the task's eval_paths rows. */
export function rejectTask(tx: EvidenceTx, taskId: string, reason: EvalReason, at: string, projectId?: string): void;
/** As rejectTask, with state 'retired'. For a task that was `valid` or a mined `candidate` taken by the duplicate rule. */
export function retireTask(tx: EvidenceTx, taskId: string, reason: EvalReason, at: string, projectId?: string): void;
/** Writes eval_paths for captured rows that v1 left unindexed. At most `limit` rows (100). */
export function indexPaths(tx: EvidenceTx, limit?: number): number;
export function pathsPending(db: EvidenceDb, projectRef: string): boolean;
export function pathRef(db: EvidenceDb, projectId: string, path: string): string;   // index('eval-path', projectId + '\0' + path)
```

**Decisions:**

- `crypto.ts`: `"eval-commit"` and `"eval-path"` join `EvidenceIndexClass` and `INDEX_CLASSES`.
- **`insertMarker`** also writes `group_id = 'run:' || run_id` and `INSERT OR IGNORE`s the run's group row (kind `run`, root itself). Its cap counts only captured rows (`AND origin = 'captured'`, through `eval_tasks_summary`), so mined rows never take capture's room. **`completeMaterial`**, on `store`, writes one `eval_paths` row per reference file (at most 500, `captured_at` of the row) and sets `paths_indexed` 1.
- **`markApproval`** and **`completeApproval`** also act on `valid` rows, so a later approval with a later change of the reference retires a valid task.
- **`reconcileBatch`** reads `RECONCILE_ORDER_SQL` for the states `captured`, `candidate`, and `valid`, and takes the oldest `limit` of the three results. A `candidate` decision promotes a `captured` row and calls `onPromoted(tx, row)`; on a `candidate` or `valid` row it changes nothing. A reject of a `valid` row calls `retireTask` with the reason and counts as `demoted`. The promotion also sets `area_ref`.
- **`retireTask`** applies the reject rule's columns (material and base `none`, approval NULL, bytes 0, payload `{ projectId }`, parts and paths deleted) with state `retired`. Neither function touches `eval_groups`.
- **`deleteRun`** (the module hook) and `deleteTasks` (the retention sweep's delete) also delete the `eval_paths` rows of the tasks they delete. Group rows stay; Task 3's sweep removes the ones no row uses. Mined rows have `run_id = ''`: `runIds` still lists `''` through `LIVE_RUN_IDS_SQL`, and the store's run sweep skips an empty id (`evidence/store.ts`, `runId.length > 0`), so no run deletion reaches a mined row.
- **`indexPaths`** reads rows through `eval_tasks_unindexed`, opens each payload, writes its `files`, and sets `paths_indexed` 1. A payload that does not open sets `paths_indexed` 1 and writes nothing; reconcile rejects that row `unreadable` anyway.
- **`counts`** adds `valid`, `retired`, `mined`, and `jobs`.
- `TASK_COLUMNS` and `taskOf` gain the new columns, and `origin` comes from its column instead of the constant `"captured"`. `index(...)` in this section means `EvidenceDb.index(cls, value)`.

- [ ] **Step 1: Write the failing tests** in `tests/eval-store-v2.test.ts`, on a real `EvidenceStore` in a temporary directory.

| Test name | Assertions |
|---|---|
| `the v2 migration keeps every v1 row` | A store built with the v1 module (the v1 `SCHEMA` and a module object with version 1) holding two captured rows of one run, one stored and one pending. Registering version 2: both rows unchanged in every v1 column; `group_id` `run:RUN`; one `eval_groups` row with root `run:RUN`; `paths_indexed` 0; `indexPaths` writes the stored row's two paths and returns 1; the pending row stays out until `completeMaterial`. |
| `a v1 host leaves a v2 store alone` | After version 2 registered, a new store on the same file registers a module named `eval-corpus` with version 1: its state is `unavailable`, and every table and row is unchanged. |
| `the v2 tables keep every text sealed` | A captured task with files `[src/secret-name.ts, tests/secret-name.test.ts]`, a job row, a mining row, and a group: no plain column of `eval_tasks`, `eval_groups`, `eval_paths`, `eval_mining`, or `eval_jobs`, read with `SELECT *`, contains `secret-name`, a commit id, or the project id. |
| `mined rows stay out of capture's reads and cap` | A mined `candidate` row and a captured `captured` row: `reconcileBatch` visits one row, and `decide` never sees the mined row. With 19,999 captured rows and 5,000 mined rows of one project (direct inserts), `insertMarker` gives `inserted`; the next gives `full`. |
| `a valid captured task is retired, never promoted again` | A `valid` captured row whose `decide` answers reject `excluded`: state `retired`, reason `excluded`, zero parts, zero paths, `demoted` 1. A `decide` that answers `candidate` leaves a `valid` row `valid` and calls no `onPromoted`. |
| `the hot statements read through an index` | `EXPLAIN QUERY PLAN` shows `SEARCH` with the named index for `RECONCILE_ORDER_SQL` (`eval_tasks_check_captured`), `PATHS_PENDING_SQL` (`eval_tasks_unindexed`), and Task 3's, Task 5's, Task 10's, and Task 11's exported statements as each task adds them to this test's list. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-store-v2.test.ts tests/eval-store.test.ts tests/eval-capture.test.ts` and the typecheck.

### Task 3: provenance groups

**Files:** `packages/host/src/eval-groups.ts`, `packages/host/src/eval-capture.ts` (the option, 3 lines), `tests/eval-groups.test.ts`. Needs Task 2. Runs in parallel with Task 10.

**Interfaces (produces):**
```ts
export const GROUP_BATCH = 100, LINEAGE_DAYS = 90, LINEAGE_GROUPS_MAX = 64, LINEAGE_ROWS_MAX = 1_000, LANDING_CHECK_DAYS = 90, LANDING_RECHECK_MS = 600_000;
export const ROOT_TASKS_SQL = "SELECT t.task_id, t.origin, t.state FROM eval_groups g JOIN eval_tasks t ON t.group_id = g.group_id WHERE g.root_id = ?";
export const LINEAGE_SQL = "SELECT t.group_id, t.approved_at FROM eval_paths p JOIN eval_tasks t ON t.task_id = p.task_id "
  + "WHERE p.path_ref = ? AND p.captured_at >= ? AND p.captured_at < ? AND t.origin = 'captured' AND t.state IN ('captured', 'candidate', 'valid') LIMIT ?";
export const LANDINGS_DUE_SQL = "SELECT group_id, project_ref, created_at FROM eval_groups WHERE landing_ref IS NULL AND kind = 'run' "
  + "AND (landing_checked_at IS NULL OR landing_checked_at < ?) ORDER BY landing_checked_at, group_id LIMIT ?";
export function runGroupId(runId: string): string;                                  // 'run:' + runId
export function ensureGroup(tx: EvidenceTx, groupId: string, kind: "run" | "mined", projectRef: string, at: string): void;
export function rootOf(db: EvidenceDb, groupId: string): string;                    // root_id, or groupId without a row
/** Merges roots into the smallest id. `devOnly` marks the result; a merged root keeps any earlier mark. */
export function mergeRoots(tx: EvidenceTx, roots: readonly string[], devOnly: boolean): string;
/** In a root with a captured candidate or valid task: a mined candidate is rejected and a mined valid task retired, both duplicate-of-captured. */
export function applyDuplicateRule(tx: EvidenceTx, root: string, at: string): number;
/** Records a run group's landing and joins the mined task of that commit, if one exists. */
export function recordLanding(tx: EvidenceTx, input: { projectRef: string; groupId: string; landingRef: string; at: string }): boolean;
/** The roots of runs that may have produced this commit, or tooWide. */
export function lineageRoots(db: EvidenceDb, input: { pathRefs: readonly string[]; commitTime: string }): { roots: string[] } | { tooWide: true };
export function groupStats(db: EvidenceDb, projectRef: string): { total: number; devOnly: number; largest: number };
export function sweepGroups(tx: EvidenceTx, limit?: number): number;                // 100
export type GroupPassOptions = { store: EvidenceStore; runs: () => readonly TeamRun[]; now?: () => string };
export class GroupPass {
  constructor(options: GroupPassOptions);
  /** Up to 100 landing checks and 100 path-index rows. Never throws. */
  run(): { checked: number; landed: number; joined: number; indexed: number };
}
// eval-capture.ts: TaskCaptureOptions gains `onPromoted?: Promoted`, passed to reconcileBatch.
```

**Decisions:**

- **Roots.** A task's `group_id` never changes after insert; its group is `rootOf(group_id)`. `mergeRoots` sets `root_id` of every row whose `root_id` is one of the roots to the smallest root id in code-unit order (`a < b`, SQLite's BINARY order; `eval-store.ts` keeps its `compareText` private), and `dev_only` of that root to the largest value among the merged roots and `devOnly`. One `UPDATE ... WHERE root_id IN (...)` through `eval_groups_root`.
- **The duplicate rule** reads `ROOT_TASKS_SQL` and acts only when a captured row is `candidate` or `valid`. A mined `candidate` gets `rejectTask(..., "duplicate-of-captured")`, a mined `valid` task `retireTask(..., "duplicate-of-captured")`. A mined task is never reinstated. *(My call: reinstating needs the capsule of a rejected row, against the one reject rule.)*
- **`recordLanding`** sets `landing_ref` and `landing_checked_at` of the run group, finds the mined row through `eval_tasks_commit` (`project_ref`, `commit_ref = landingRef`), merges its root with the run's root without the dev-only mark, and applies the duplicate rule to the result.
- **`lineageRoots`.** For each path ref, `LINEAGE_SQL` with the window `[commitTime − 90 days, commitTime)` and `LIMIT 1001`; a result of 1,001 rows is `tooWide`. It keeps rows with `approved_at` set and earlier than `commitTime`, whose run group has no `landing_ref`, and returns their distinct roots; more than 64 is `tooWide`.
- **`GroupPass.run`.** It reads `LANDINGS_DUE_SQL` with the cutoff `now − 10 minutes`, skipping groups created more than 90 days ago (it stamps them checked and leaves them). It calls `runs()` at most once per pass and only when the batch is not empty, and maps each kept run with `deliveryReceipt.mergeCommit` (passing `COMMIT_ID`) by id. For each group: the run's merge commit, else the payload commit of `readSignal(db, landingSignalId(runId))` when the `outcomes` module is ready and the signal is a `landing`. A found commit calls `recordLanding` with `index('eval-commit', commit)`; otherwise the group is stamped checked. Then `indexPaths(tx, 100)`. Each group is its own `tryWrite`.
- **`sweepGroups`** deletes group rows that no task row names in `group_id` and that are no other row's root, oldest first, at most 100.
- `eval-capture.ts`: three lines, the option, its comment, and the argument. `EvalHost` passes `onPromoted: (tx, task) => applyDuplicateRule(tx, rootOf(tx, task.groupId ?? runGroupId(task.runId)), now())`.

- [ ] **Step 1: Write the failing tests** in `tests/eval-groups.test.ts`, on a real store with `outcomeModule()` and the eval module. Helpers write a captured row through `insertMarker` and `completeMaterial` (files `[src/a.ts, tests/a.test.ts]`, approved 5 days before the commit), and a mined row through Task 5's `insertMined` with a fake that Task 5 replaces (a direct row insert with the same columns until then).

| Test name | Assertions |
|---|---|
| `the three group facts give one result in every order` | Three steps: M (insert the mined row of commit C, whose files are `[src/a.ts, tests/b.test.ts]`, then the lineage merge), L (`recordLanding` with `index('eval-commit', C)`), and P (reconcile promotes the captured task, with `onPromoted`). For each of the six orders, on a fresh store: the captured task `candidate`; the mined task `rejected` `duplicate-of-captured` with zero parts; `rootOf` of both is `run:RUN`; `dev_only` of the root is 1 exactly in the orders M-L-P, M-P-L, and P-M-L. A second case with mined files `[lib/c.ts, tests/c.test.ts]` (no overlap) ends with the same states and `dev_only` 0 in all six orders. After every step of every order, no root holds a captured `candidate` or `valid` task together with a mined `candidate` or `valid` task. |
| `a promotion retires a valid mined copy` | A mined task set `valid` in a root with a `captured` task; promotion of the captured task retires the mined task `duplicate-of-captured` with zero parts. |
| `lineage is bounded in time and width` | Captured 91 days before the commit, approved after the commit, or with a landing: no root. 65 runs within the window on one path: `tooWide`. 64 runs: 64 roots. |
| `the groups pass joins a landing from either source` | A run record whose `deliveryReceipt.mergeCommit` is C, and, in a second store, a ledger `landing` signal for the run with commit C: each pass sets `landing_ref` and joins the mined row of C. A signal whose payload does not open stamps the group checked and joins nothing. A second pass within 10 minutes reads no group. |
| `a deleted run leaves its mined copy` | After the join, events `run.deleted` `cancelled` and `store.deleteRun`: zero captured rows and zero paths of the run; the mined row, its state, and both group rows stay. `sweepGroups` removes nothing while the mined row names its group. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-groups.test.ts tests/eval-capture.test.ts` and the typecheck.

### Task 4: the mining rules and the mirror reads

**Files:** `packages/host/src/eval-mine-rules.ts`, `packages/host/src/eval-mine-git.ts`, `tests/eval-mine.test.ts`. Needs Task 1. Runs in parallel with Tasks 2, 6, 7, 8, 12, and 14.

**Interfaces (produces):**
```ts
// eval-mine-rules.ts: pure, no I/O, no clock
export const MINED_FILES_MAX = 29, MINED_LINES_MAX = 1_499, MINED_PATHS_MAX = 32, COMMIT_MESSAGE_MAX = 24_000, MINED_TITLE_MAX = 100;
export type NumstatEntry = { path: string; added: number | null; removed: number | null };   // null for a binary file
/** `-z` numstat: ADDED TAB REMOVED TAB PATH NUL. Undefined when any record fails to parse. */
export function parseNumstat(stdout: string): NumstatEntry[] | undefined;
export type MineVerdict =
  | { kind: "skip" }                                                   // no test file, or no other file: no row
  | { kind: "reject"; reason: "too-large" | "binary-change" | "excluded-area" | "excluded-area-unknown" }
  | { kind: "read-message"; files: string[]; hiddenFiles: string[]; paths: string[]; features: EvalFeatures };
export function mineVerdict(read: { state: "read"; entries: NumstatEntry[] } | { state: "too-large" }, settings: EvalProjectSettings, map: FeatureMap | undefined): MineVerdict;
export function parseMessage(stdout: string): { commitTime: string; message: string } | undefined;
export function isRevert(message: string): boolean;
export function minedCapsule(message: string, paths: readonly string[], run: Pick<TeamRun, "objective" | "brief"> | undefined):
  { capsule: Capsule; promptOrigin: "run-objective" | "commit-message" } | { reject: "ui-changes" };
export function capsuleVerdict(capsule: Capsule): "ok" | "capsule-too-large" | "secret-shaped";
export function parentDirectories(files: readonly string[]): string[];

// eval-mine-git.ts
export const MINE_READ_MS = 30_000, BUNDLE_MAX_BYTES = 1_073_741_824;
/** E1 and E2 (see "Git commands"). Throw TypeError when an id fails COMMIT_ID. */
export function numstatArgs(parent: string, commit: string): string[];
export function messageArgs(commit: string): string[];
export interface MineGit {
  isAncestor(mirror: string, older: string, newer: string): Promise<"yes" | "no" | "failed">;                    // form 1
  firstParents(mirror: string, head: string, exclude?: string): Promise<{ ids: string[]; more: boolean } | undefined>;  // form 3, or form 2 with exclude
  parents(mirror: string, ids: readonly string[]): Promise<Map<string, string[]> | undefined>;                    // form 4, 1 to 50 ids
  numstat(mirror: string, parent: string, commit: string): Promise<{ state: "read"; entries: NumstatEntry[] } | { state: "too-large" } | { state: "failed" }>;
  message(mirror: string, commit: string): Promise<{ state: "read"; commitTime: string; message: string } | { state: "too-large" } | { state: "failed" }>;
}
export function mineGit(prefix: () => TeamCommand | undefined): MineGit;          // every read through scanGit(prefix()), 30 s each
/** E3: spawnTeamBundle in the mirror. The caller streams stdout and destroys it past BUNDLE_MAX_BYTES. */
export function spawnMirrorBundle(mirror: string, branch: string, prefix?: TeamCommand): ChildProcess;
```

**Decisions:**

- **`mineVerdict`**, in order: `too-large` read gives `reject` `too-large`; a test file (`evalTestPath` with `testPaths`) and a file that is not a test are both needed, else `skip`; more than 29 entries, or added plus removed above 1,499, gives `too-large`; any binary entry gives `binary-change` *(My call: a binary change has no line count, and an unknown size is never a small one)*; `excludeAreas` set with no feature map gives `excluded-area-unknown`; a file whose `pathArea` is excluded gives `excluded-area`. Otherwise `read-message` with `hiddenFiles` the test files, `paths` from `parentDirectories`, and `features` from `taskFeatures({ role: "implementer", paths: files }, map)` with `kind` null and `featureVersion` `FEATURE_VERSION`.
- **`parentDirectories`**: each file's directory, a root file's own path, sorted and distinct; more than 32 keeps the 32 shortest. *(My call: a capsule holds at most 32 paths.)*
- **`parseMessage`**: `SECONDS NUL BODY`; the seconds become an ISO time; a body over 24,000 characters is undefined (the read then answers `too-large`). **`isRevert`**: the subject starts with `Revert "`, or a line matches `/^This reverts commit [0-9a-f]{40}(?:[0-9a-f]{24})?\b/m`.
- **`minedCapsule`**: `commit-message` gives `objective` the trimmed message; `run-objective` gives the run's `objective` and `brief`, and `ui-changes` when `brief.uiChanges` is true. Both: `steering` and `ownerAnswers` empty, `task` `{ id: "mined", title: first line cut at 100 code points, instructions: "", paths }`. **`capsuleVerdict`**: over `CAPSULE_MAX_BYTES` (65,536) is `capsule-too-large`; `findSecret(capsule, { token: "", url: "" })` is `secret-shaped`.
- **Reads.** A non-zero exit, an interruption, or output that does not parse is `failed`; `truncated` on E1 is `too-large`, on E2 `too-large`, on forms 2 to 4 `failed`. Form 1 exit 0 is `yes`, exit 1 `no`, anything else `failed`.
- **Forms 1 to 4** repeat the argument lists of `outcome-scan.ts` exactly. That file keeps its builders private, so the test pins each list against the outcome-ledger plan's "Git commands of the scan".

- [ ] **Step 1: Write the failing tests** in `tests/eval-mine.test.ts`, with real Git in a temporary bare repository and a recording prefix script as in `tests/eval-git.test.ts`.

| Test name | Assertions |
|---|---|
| `the mining forms are exact and checked` | The recorded argv of `numstat` and `message` equal `["git", ...teamGitArgs(mirror, numstatArgs(P, C))]` and `["git", ...teamGitArgs(mirror, messageArgs(C))]`, with the exact lists of "Git commands". Forms 1 to 4 record the lists of the outcome-ledger plan's "Git commands of the scan". `HEAD`, `-x`, and 39 hex characters: the builders throw, the reads give `failed`, and the script records nothing. |
| `the verdict follows the design's limits` | A commit with `src/a.ts` and `tests/a.test.ts` gives `read-message` with `hiddenFiles` `[tests/a.test.ts]` and `paths` `[src, tests]`. Tests only, or source only: `skip`. 29 files: `read-message`; 30: `too-large`. 1,499 changed lines: `read-message`; 1,500: `too-large`. |
| `a truncated or binary read is never small` | A `too-large` read gives `too-large`; a 4 KiB binary file beside a test gives `binary-change`; a numstat record without its NUL gives undefined from `parseNumstat`, and the read `failed`. |
| `the message decides revert, origin, and secrets` | `git revert` output: `isRevert` true. A run with `deliveryReceipt.mergeCommit` gives `run-objective` with the run's objective; without, `commit-message` with the message. A message holding `ghp_` and 36 letters, or a `v1.eyJ`-shaped grant: `secret-shaped`. A 70,000-byte message: `capsule-too-large`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-mine.test.ts` and the typecheck.

### Task 5: the miner

**Files:** `packages/host/src/eval-miner.ts`, `tests/eval-miner.test.ts`. Needs Tasks 3 and 4.

**Interfaces (produces):**
```ts
export const MINING_BATCH = 50, MINING_BACKFILL_MAX = 2_000, MINED_TASK_MAX = 5_000, MINING_RETRY_MS = 3_600_000;
export const MINED_COUNT_SQL = "SELECT count(*) AS n FROM eval_tasks WHERE project_ref = ? AND origin = 'mined'";
/** Sealed in eval_mining.payload. */
export type MiningCursor = { projectId: string; forward?: string; backfill?: { next: string; visited: number; done: boolean } };
export function minedTaskId(projectRef: string, commitRef: string): string;   // 'mined:' + sha256(projectRef + ':' + commitRef) hex, first 40
export type MinedInsert =
  | { kind: "candidate"; projectId: string; commit: string; parent: string; commitTime: string; capsule: Capsule;
      promptOrigin: "run-objective" | "commit-message"; runId?: string; files: string[]; hiddenFiles: string[]; features: EvalFeatures }
  | { kind: "rejected"; projectId: string; commit: string; reason: EvalReason };
export function insertMined(tx: EvidenceTx, input: MinedInsert, at: string): "inserted" | "exists" | "full";
export type MinerOptions = {
  config: Pick<Config, "projects">; store: EvidenceStore; source: Pick<ProjectSourceService, "mirrorPath" | "status">;
  git: MineGit; runs: () => readonly TeamRun[]; now?: () => string;
};
export class Miner {
  constructor(options: MinerOptions);
  /** Starts one pass when none runs. Never throws. */
  pump(): void;
  idle(): Promise<void>;
  status(projectId: string): MiningStatus;
  close(): void;
}
```

**Decisions:**

- **A pass** takes the next project, in id order after the last one, with `mineSettings` set, a ready store, a mirror head, and `retry_at` past. It waits (state `waiting`) while `pathsPending` is true. It reads the cursor; the first pass sets `forward` and `backfill.next` to the mirror head.
- **Forward first.** When the head differs from `forward`: form 1 `forward` to head; `no` is a rewrite: the head is decided first, its write sets `forward` to the head, and `backfill.next` to its first parent (`visited` is kept, so the 2,000 bound still holds; ruling 17). `yes`: form 2 lists the new commits; more than 500 keeps the newest 500, and the older ones are neither mined nor counted (ruling 17). Mine them oldest first. **Then backfill**, newest first, with form 3 from `backfill.next` while `visited < 2,000` and not `done`; a list shorter than 500 that ends at a root commit sets `done`. A pass mines at most 50 commits in total.
- **One commit, one transaction.** Form 4 gives the first parent (a root commit is `skipped`). Then E1 and `mineVerdict`; `read-message` reads E2, checks `isRevert`, builds the capsule with the run whose `deliveryReceipt.mergeCommit` equals the commit (from `runs()`, read once per pass), and checks `capsuleVerdict`. Then one `tryWrite`: `insertMined`, the landing join through `eval_groups_landing`, else `lineageRoots` (`tooWide` rejects `lineage-too-wide`; roots merge with `devOnly` true and set `lineage` `unclear`; none sets `clear`), `applyDuplicateRule`, the counters, and the cursor. `skip` writes only the counters and the cursor.
- **`insertMined`**: `full` when `MINED_COUNT_SQL` gives 5,000. Otherwise `INSERT OR IGNORE` with `origin` `mined`, `run_id` and `member_id` `''`, `group_id` the task id, `commit_ref`, `area_ref`, `base` `proven`, `material` `stored` and the `capsule` part as `insertMarker` writes it (or `none` for a reject), `material_bytes` the capsule's bytes, `paths_indexed` 1, and the sealed `MinedPayload`. `captured_at` and `checked_at` are the mining time, so retention counts from mining: with the commit time, a backfilled commit older than `retentionDays` would go at the next sweep. The own group row is created with it.
- **Room.** Each pass first reads the project's and the host's material bytes once (`SUM(material_bytes)` through `eval_tasks_bytes`) and `MINED_COUNT_SQL` once. A pass starts only when 50 capsules of 65,536 bytes (3,276,800 bytes) fit under `PROJECT_MATERIAL_MAX_BYTES` and `HOST_MATERIAL_MAX_BYTES` and fewer than 5,000 mined rows exist; otherwise the state is `full`, checked again at each pass.
- **Failures.** A `failed` read ends the pass, keeps the cursor, adds 1 to `failures`, sets state `failing` and `retry_at` one hour later, and logs `Eval mining paused (read-failed).` once. A later successful commit sets the state back. Nothing is skipped for a failure.
- `pump` runs one pass at a time host-wide, and `close` stops the chain: a read in flight ends without a write.

- [ ] **Step 1: Write the failing tests** in `tests/eval-miner.test.ts`, on a real store and a real bare repository with a linear history, and a counting `MineGit` that wraps `mineGit(() => undefined)`.

| Test name | Assertions |
|---|---|
| `a history is mined newest first, within its bounds` | 60 commits, 40 of them test plus source: the first pass mines 50 commits (`visited` 50), the second the remaining 10; 40 rows, all `candidate`, `skipped` 20. With `MINING_BACKFILL_MAX` 2,000 and 2,100 commits, `visited` stops at 2,000 and `backfillDone` stays false. |
| `a commit is mined once across a restart` | A store write that fails once after the first commit of a pass; a new `Miner` on the same store: every commit has one row and `visited` equals the number of commits. A second pass over an unchanged head reads no commit. |
| `a refused read mines nothing and claims nothing` | A prefix script that exits 126 for E1: zero rows, the cursor unchanged, state `failing`, `failures` 1, and no pass before `retry_at`. The same for E2. |
| `a rewritten branch restarts the walk` | After mining, the branch is rewritten with an amended head: the next pass sets the forward cursor to the new head, mines the new commit, and leaves every earlier row. |
| `mined rows stop at their own cap` | 5,000 mined rows: no commit is read, the state is `full`, and the cursor stays; after one mined row is deleted, the next pass mines. Host material bytes 3,276,799 below `HOST_MATERIAL_MAX_BYTES`: `full` without a read. |
| `a secret-shaped message is never stored` | A commit whose message holds an egress-password-shaped value: a `rejected` `secret-shaped` row with zero parts; no table contains the value. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-miner.test.ts tests/eval-groups.test.ts` in the background, then the typecheck.

### Task 6: the grader client

**Files:** `packages/host/src/eval-grader.ts`, `tests/fixtures/grader-command.mjs`, `tests/eval-grader.test.ts`. Needs Task 1. Runs in parallel with Tasks 2, 4, 7, 8, 12, and 14.

**Interfaces (produces):**
```ts
export const PROBE_SECONDS = 30, STOP_ROUNDS = 3, STOP_PAUSE_MS = 1_000, GRADER_GRACE_MS = 30_000, PROBE_FRESH_MS = 600_000,
  GRADER_OUTPUT_MAX = 65_536, GRADER_FREE_BYTES_MIN = 10_737_418_240, GRADER_FREE_INODES_MIN = 200_000;
export const GRADER_ROUNDS = ["round-1", "round-2", "round-3", "round-4", "round-5", "round-6"] as const;
export type GraderDir = "." | "task" | typeof GRADER_ROUNDS[number];
export type GraderInput = "base.bundle" | "base-delta.patch" | "reference.patch";
export type GraderProbe = { state: GraderState; uid?: number; storage?: boolean };
export type GraderRun = { exitCode: number | null; timedOut: boolean; stdout?: Buffer; truncated: boolean; failed: boolean };
export interface Grader {
  probe(canaries: readonly string[]): Promise<GraderProbe>;
  receive(job: string, name: GraderInput, input: Readable | Buffer, maxBytes: number): Promise<"stored" | "too-large" | "failed">;
  /** `stdout` is kept, at most 64 KiB, only when `keepStdout` is true. `input` goes to the child's stdin. */
  run(job: string, dir: GraderDir, seconds: number, argv: readonly string[], options?: { input?: Buffer; keepStdout?: boolean }): Promise<GraderRun>;
  read(job: string, report: string, maxBytes: number): Promise<{ state: "read"; bytes: Buffer } | { state: "missing" | "too-large" | "failed" }>;
  stop(): Promise<boolean>;
  clean(job: string): Promise<boolean>;
  remove(job: string): Promise<boolean>;
}
export function launcherGrader(config: () => EvalGraderConfig | undefined, options?: { hostUid?: number }): Grader;
/** Up to three rounds of stop and inventory, one second apart. */
export function stopGrader(grader: Grader, uid: number, inventory?: () => Promise<RuntimeProcess[]>): Promise<"stopped" | "alive" | "failed">;
```

**Decisions:**

- **Spawning.** `spawn(prefix.command, [...prefix.args, OP, ...ARGS], { env: { PATH, LANG }, stdio: [...], detached: false })`, no shell. The host never signals a launcher child, which runs as another account behind `sudo`; it relies on the launcher's own limits. A call that does not close within its limit plus 30 seconds counts as `failed`, and no further grader call starts while it stays open. stderr is drained and dropped.
- **Exit codes.** 0 done; 2 a missing report (`read`); 3 over the byte limit (`receive`, `read`); 64 a refused argument; 124 the wall limit of `run` (`timedOut` only when the elapsed time is at least the limit minus one second); 125 a launcher failure; any other code of `run` is the child's.
- **The probe** runs `probe -- CANARY...` with the host's derived canaries (the evidence database path, `keyFile`, `stateDir`, `runDir`, `teams.workspaceDir`) and `eval.grader.canaries`, and parses at most 4 KiB of JSON `{ uid, root, rootMode, rootOwner, readable: boolean[], metadata: "open" | "closed", freeBytes, freeInodes }`. No `eval.grader`: `not-configured`. A launcher that fails or output that does not parse: `unavailable`. `uid` equal to the host's or to 0, `root` other than the configured one, `rootOwner` other than `uid`, or `rootMode` other than `700`: `misconfigured`. Any readable canary: `exposed`. `metadata` `open`: `network-open`. Otherwise `ready`, with `storage` true when at least 10 GiB and 200,000 inodes are free.
- **`stopGrader`** calls `stop`, then lists processes with `inventoryRuntimeProcesses` (or the injected inventory), keeps rows whose `ruid` or `euid` is the grader's and whose state is not `Z`, and repeats up to three rounds one second apart. A launcher that fails is `failed`; processes after the third round are `alive`.
- **The fixture** (`tests/fixtures/grader-command.mjs`) takes `--root DIR --uid N --metadata open|closed --record FILE` before the operation, implements every operation of Task 7 as the current user, records each argv line, and implements `stop` by killing only the process groups it started (read from `DIR/.groups`), treating `ESRCH` and `EPERM` as gone, as macOS answers `EPERM` for a group whose leader has ended.

- [ ] **Step 1: Write the failing tests** in `tests/eval-grader.test.ts`, with the fixture launcher and a temporary root.

| Test name | Assertions |
|---|---|
| `the probe names every unsafe state` | No config: `not-configured`. A prefix that exits 1: `unavailable`. `--uid` equal to `process.getuid()`: `misconfigured`; a root with mode `0755`: `misconfigured`. A canary the current user can read: `exposed` (a canary with mode `0000` passes; the case is skipped when the tests run as root). `--metadata open`: `network-open`. Otherwise `ready`. |
| `the host reads only reports, and only as the grader` | `read` of `reports/round-1.xml` returns its bytes; of `reports/round-1.xml` as a link to a file outside the root: `missing`; over 8 MiB: `too-large`; any other path is refused by the client before a spawn. |
| `a surviving grader process blocks the job` | An inventory that keeps one row of the grader's uid: `stopGrader` gives `alive` after three stops and about two seconds. An inventory that empties after the second stop: `stopped`. |
| `a call that never closes counts as failed` | A prefix script that sleeps past the limit plus the grace (both shortened through the options): `run` resolves `failed`, and a second `run` during the hold resolves `failed` without a spawn. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-grader.test.ts` and the typecheck.

### Task 7: the launcher template

**Files:** `deploy/ubuntu/grader-command.sh`, `deploy/ubuntu/grader.sudoers`, `deploy/ubuntu/grader.nft`, `tests/eval-grader-launcher.test.ts`. Needs Task 1. Runs in parallel with Tasks 2, 4, 6, 8, 12, and 14.

**Interfaces (produces):** the launcher's argument contract, which the fixture of Task 6 also follows:
```text
grader-command probe -- [CANARY...]
grader-command receive JOB NAME MAXBYTES          # stdin to ROOT/jobs/JOB/in/NAME
grader-command run JOB DIR SECONDS -- ARGV...       # in ROOT/jobs/JOB/work/DIR (DIR "." is work itself)
grader-command read JOB REPORT MAXBYTES             # REPORT matches ^reports/round-[1-6]\.(xml|tap)$, under work
grader-command stop                                 # every process of the account, then its files in /tmp, /var/tmp, /dev/shm
grader-command clean JOB                            # work, home, tmp, and every input but base.bundle
grader-command remove JOB                           # ROOT/jobs/JOB
JOB    ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$
NAME   base.bundle | base-delta.patch | reference.patch
DIR    . | task | round-1 ... round-6
```

**Decisions:**

- **The root** is a constant at the top of the script (`ROOT=/var/lib/infinite-grader/root`), which the owner edits at install; the launcher takes no root from its caller or its environment. It refuses to run as root and refuses a root that is not a directory of mode `0700` owned by the caller.
- **Confinement.** It creates `ROOT/jobs/JOB/{in,work,work/reports,home,tmp}` with mode `0700` on first use, resolves every path with `realpath`, and refuses (exit 64) any path that leaves `ROOT/jobs/JOB` or any link on the way. `read` refuses a link and anything but a regular file.
- **The child of `run`** starts as `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=ROOT/jobs/JOB/home TMPDIR=ROOT/jobs/JOB/tmp LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 CI=1`, with `umask 077`, under `setsid` and `timeout --kill-after=10 SECONDS`, and `prlimit --nproc=512 --fsize=4294967296 --core=0 --nofile=4096`. SECONDS is 1 to 3,600.
- **`stop`** runs `kill -KILL -1` as the account (Linux never signals the caller itself), waits one second, and deletes the account's files under `/tmp`, `/var/tmp`, and `/dev/shm` with `find -xdev -user`. **`probe`** prints the JSON of Task 6; it tests each canary with `[ -r ]` and the metadata address `169.254.169.254:80` with a two-second connect.
- `grader.sudoers`, installed as `/etc/sudoers.d/infinite-grader` only after the account exists: `Defaults!/usr/local/libexec/infinite/grader-command env_reset` and `infinite-host ALL=(infinite-grader) NOPASSWD: /usr/local/libexec/infinite/grader-command`. A separate file, so `infinite.sudoers` and its `visudo` check do not change.
- `grader.nft`: one table that rejects output from the grader's uid to `169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `224.0.0.0/4`, `fe80::/10`, `fc00::/7`, and `ff00::/8`, and accepts loopback and everything else.

- [ ] **Step 1: Write the failing tests** in `tests/eval-grader-launcher.test.ts`. They run the real script, copied into a temporary directory with its `ROOT` line rewritten, as the current user. The file skips on a platform other than Linux and when it runs as root.

| Test name | Assertions |
|---|---|
| `the launcher starts the child with an empty environment` | With `INFINITE_GITHUB_GRANT`, `HTTPS_PROXY`, and `INFINITE_HOOK_TOKEN` set in the caller, `run JOB round-1 10 -- /usr/bin/env` prints exactly the fixed list of variables. |
| `the launcher confines every operation to its root` | `run` with DIR `../x`, `receive` with NAME `x`, `read` of `reports/../in/base.bundle`, a JOB that is not a UUID, and a `work/round-1` replaced by a link: exit 64 and nothing written outside the root. |
| `the launcher ends a round at its limit` | `run JOB round-1 2 -- sleep 30`: exit 124 within 15 seconds, and no `sleep` of the caller's uid remains after `stop`. |
| `receive and read keep their limits` | `receive` of 11 bytes with MAXBYTES 10: exit 3 and no file; `read` of a report over its MAXBYTES: exit 3. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-grader-launcher.test.ts` on a Linux host.

### Task 8: the report parsers

**Files:** `packages/host/src/eval-report.ts`, `tests/eval-report.test.ts`. Needs Task 1. Runs in parallel with Tasks 2, 4, 6, 7, 12, and 14.

**Interfaces (produces):** pure, no I/O.
```ts
export const REPORT_MAX_BYTES = 8_388_608, REPORT_CASES_MAX = 20_000, CASE_KEY_MAX = 4_096, TAP_LINES_MAX = 200_000, TAP_LINE_MAX = 16_384;
export type CaseStatus = "passed" | "failed" | "skipped";
export type ParsedReport = { state: "parsed"; cases: ReadonlyMap<string, CaseStatus> } | { state: "invalid" };
/** Keys are SHA-256 hex of the case key. */
export function parseReport(format: "junit" | "tap", bytes: Buffer): ParsedReport;
export function caseRef(key: string): string;
```

**Decisions:**

- **JUnit.** A bounded scanner, no dependency, that reads `testsuite`, `testcase`, `failure`, `error`, and `skipped` elements and decodes the five named entities and numeric references. The key is the names of the enclosing `testsuite` elements, then `classname`, then `name`, joined with NUL. A `testcase` with `failure` or `error` is `failed`, with `skipped` is `skipped`, otherwise `passed`. A `<!DOCTYPE` or `<!ENTITY` anywhere makes the report `invalid`.
- **TAP** 13 and 14. The key is the path of `# Subtest:` names, then the description of the `ok` or `not ok` line, joined with NUL. `# SKIP` and `# TODO` make a case `skipped`; `not ok` is `failed`; `ok` is `passed`.
- A key that occurs twice takes its worse status (`failed`, then `skipped`, then `passed`). More than 20,000 cases, a key over 4,096 characters, more bytes than 8 MiB, a TAP line over 16,384 characters, or more than 200,000 lines makes the report `invalid`. An empty but well-formed report is `parsed` with no case.

- [ ] **Step 1: Write the failing tests** in `tests/eval-report.test.ts`.

| Test name | Assertions |
|---|---|
| `node's two reporters parse to the same cases` | Fixed outputs of `node --test --test-reporter=junit` and `--test-reporter=tap` for one file with a passing, a failing, and a skipped test, and a nested `describe`: three cases each, with the statuses expected, and the same keys under both formats. |
| `a hostile report is invalid, never a pass` | A `<!DOCTYPE` with an entity, 20,001 cases, a 4,097-character name, and a truncated document: `invalid`. A duplicate key with `passed` and `failed`: `failed`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-report.test.ts` and the typecheck.

### Task 9: validating one task

**Files:** `packages/host/src/eval-validate-rules.ts`, `packages/host/src/eval-validate.ts`, `tests/eval-validate.test.ts`. Needs Tasks 2, 6, and 8. Runs in parallel with Task 10.

**Interfaces (produces):**
```ts
// eval-validate-rules.ts: pure
export const HIDDEN_FILES_MAX = 100, EXPECTED_CASES_MAX = 5_000, FOCUSED_SECONDS = 600, SETUP_SECONDS = 600, GUARD_SECONDS = 600,
  PREPARE_SECONDS = 600, ATTEMPTS_MAX = 3;
export type RoundOutcome = { kind: "report"; report: ParsedReport } | { kind: "missing" } | { kind: "timeout" } | { kind: "setup-failed" };
export type RoundFacts = { R1?: RoundOutcome; guards?: "passed" | "failed"; B1?: RoundOutcome; R2?: RoundOutcome; B2?: RoundOutcome; R3?: RoundOutcome };
export type RoundVerdict =
  | { kind: "next"; step: "R1" | "guards" | "B1" | "R2" | "B2" | "R3" }
  | { kind: "valid"; expected: string[] }
  | { kind: "reject"; reason: "not-fail-to-pass" | "guard-failed" | "flaky" | "too-slow" | "reference-too-wide" }
  | { kind: "undecided"; cause: "report-missing" | "report-invalid" | "setup-failed" };
export function nextRound(facts: RoundFacts): RoundVerdict;
export function focusedArgv(command: { command: string; args: string[] }, files: readonly string[], report: string): string[];
export function restoreLists(input: { present: readonly string[]; hiddenFiles: readonly string[]; files: readonly string[]; gradingPaths: readonly string[] }):
  { focus: string[]; restore: string[] } | { reject: "no-hidden-tests" | "reference-too-wide" };

// eval-validate.ts
export const HALT_POLL_MS = 10_000;
export type ValidateContext = {
  jobId: string; projectId: string; settings: ValidationSettings; grader: Grader; graderRoot: string; uid: number;
  mirror: string; mirrorHead: string; git: Pick<MineGit, "isAncestor">; halted: () => boolean;
  inventory?: () => Promise<RuntimeProcess[]>; now: () => string;
};
export type TaskValidation =
  | { kind: "decided"; state: "valid" | "rejected" | "retired"; reason: EvalReason | null }
  | { kind: "undecided"; cause: "report-missing" | "report-invalid" | "setup-failed"; attempts: number }
  | { kind: "environment"; cause: "anchor-unknown" | "grader-failed" | "grader-processes-alive" | "halted" | "bundle-missing" | "state-changed" };
/** Streams E3 into the grader once per job. */
export function prepareJob(ctx: ValidateContext, bundle: () => ChildProcess): Promise<"ready" | "too-large" | "failed">;
export function validateTask(store: EvidenceStore, taskId: string, ctx: ValidateContext): Promise<TaskValidation>;
```

**Decisions:**

- **`nextRound`**, step by step, with E the passed keys of R1 and F(B) the keys of E that B does not pass (failed, skipped, or absent). Any round: `timeout` rejects `too-slow`; `setup-failed`, `missing`, and an `invalid` report are undecided. R1: E empty rejects `not-fail-to-pass`; more than 5,000 keys rejects `reference-too-wide`. Guards: `failed` rejects `guard-failed`. B1: F(B1) empty rejects `not-fail-to-pass`. R2: passed keys other than E reject `flaky`. B2: F(B2) other than F(B1) rejects `flaky`. R3: passed keys other than E reject `flaky`; otherwise `valid` with E sorted.
- **`focusedArgv`** replaces the `{files}` argument with one argument per file, each `./` plus the path, so no name reads as an option, and `{report}` with the report path. **`restoreLists`**: `present` is what the grader's diff printed; `focus` is `hiddenFiles ∩ present` (empty: `no-hidden-tests`; over 100: `reference-too-wide`); `restore` is `(hiddenFiles ∪ files under gradingPaths) ∩ present`. A grading path covers a file equal to it or under it plus `/`.
- **Preparation of a job:** `stopGrader`, `remove`, then E3 from the mirror piped into `receive JOB base.bundle 1073741824`; the host counts bytes and destroys the bundle's stdout past 1 GiB (`too-large`).
- **One task**, as the grader, every command with `PREPARE_SECONDS` unless named. Read the row and its payload (a payload that does not open: `rejectTask` `unreadable`). Form 1 in the mirror for the anchor, and for a mined task also the commit, against the mirror head: `no` rejects a candidate and retires a valid task `anchor-missing`; `failed` is `anchor-unknown`. Then `stopGrader`; `clean`; `git clone --quiet --template= --no-checkout -- ROOT/jobs/JOB/in/base.bundle task`. A mined task tags `eval-base` at the parent and `eval-reference` at the commit with `git update-ref`. A captured task checks out the anchor, sends each stored patch with `receive` and applies it with `git apply --index`, commits it with `-c user.name=Infinite -c user.email=agent@example.invalid commit --quiet --no-verify --allow-empty -m eval`, and tags `eval-base` and `eval-reference`. A commit missing from the bundle streams the bundle once more per job, then is `bundle-missing`. Then `git diff --name-only --no-renames --no-ext-diff --no-textconv --ignore-submodules=none --diff-filter=d -z eval-base eval-reference --` with `keepStdout` (truncated: `reference-too-wide`) and `restoreLists`.
- **Rounds.** R1 in `round-1`, the guards in `round-2`, B1 in `round-3`, R2 in `round-4`, B2 in `round-5`, R3 in `round-6`, in the order `nextRound` asks and only as far. Each: `git clone --quiet --template= --no-local --no-hardlinks --no-checkout -- task round-N`; `git -c advice.detachedHead=false checkout --quiet --detach eval-reference` (or `eval-base`, then `git --literal-pathspecs restore --source=eval-reference --staged --worktree --pathspec-from-file=- --pathspec-file-nul` with the NUL-joined `restore` list on stdin); `setup` with `SETUP_SECONDS` (a non-zero exit or a time-out is `setup-failed`); then the focused test with `FOCUSED_SECONDS` and `{report}` set to `ROOT/jobs/JOB/work/reports/round-N.xml` (`.tap` for TAP), or each guard check with `GUARD_SECONDS` (any non-zero exit or time-out is `failed`); then `read`; then `stopGrader`. The focused test's exit code is never read.
- **Halt.** Before each command and every 10 seconds while one runs, `halted()`; when it answers true, the host runs `stop` and the task ends `halted` with nothing written. *(My call: the owner's halt stops everything the host starts, and a round is cheap to repeat.)* An `alive` stop is `grader-processes-alive`; a launcher failure is `grader-failed`.
- **The decision** is one `store.write` that re-reads the row and writes nothing (`state-changed`) unless its state is the one read at the start. `valid`: state `valid`, `validated_at`, `attempts` 0, and `expectedCases` sealed into the payload (a revalidation replaces them). A reject: `rejectTask` for a candidate, `retireTask` for a valid task. Undecided: `attempts` plus 1, and at 3, `unvalidated` the same way. An environment cause writes nothing and counts no attempt. Every path ends with `stopGrader` and `clean`.

- [ ] **Step 1: Write the failing tests** in `tests/eval-validate.test.ts`: pure tests for the rules, and a scripted `Grader` (it answers each command from a table and returns fixed reports) on a real store.

| Test name | Assertions |
|---|---|
| `every round decides as the plan says` (rules) | With E `{a, b}`: R1 empty is `not-fail-to-pass`; guards `failed` is `guard-failed`; B1 passing both is `not-fail-to-pass`; R2 passing only `a` is `flaky`; B1 failing `b` and B2 failing `a` is `flaky`; R3 equal to E is `valid` `[a, b]`; a `timeout` in any round is `too-slow`; `missing` in any round is undecided `report-missing`. |
| `the argv cannot carry an option` (rules) | Files `[-x.test.js, tests/a.test.js]` give `["./-x.test.js", "./tests/a.test.js"]` in place of `{files}`; `--out={report}` becomes `--out=/R/jobs/J/work/reports/round-1.xml`. `restoreLists` drops a name the grader did not print, and a name the grader printed that the host does not list. |
| `an exit code never validates` | Every focused command exits 0 and no report exists: undecided `report-missing` with `attempts` 1; three runs: `rejected` `unvalidated`, zero parts. |
| `a missing anchor retires a valid task` | A valid task whose form 1 answers `no`: `retired` `anchor-missing`. `failed`: `environment` `anchor-unknown`, the row unchanged, `attempts` unchanged. |
| `a halt stops the round within ten seconds` | `halted()` turns true while the focused command runs: the scripted grader sees `stop` within 11 seconds of the change; the result is `halted`; the row and `attempts` are unchanged. |
| `unreadable records are never validated` | A payload replaced with bad sealed text: `rejected` `unreadable` before any grader command. |
| `the host reads only reports, and only as the grader` | The scripted grader records every operation: reads go only through `read` with `reports/round-N.xml`, and the host opens no file under the grader root (the root is a directory the test makes unreadable to the current user, mode `0000`). |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-validate.test.ts` in the background, then the typecheck.

### Task 10: the validate job

**Files:** `packages/host/src/eval-jobs.ts`, `tests/eval-jobs.test.ts`. Needs Task 2. Runs in parallel with Tasks 3 and 9.

**Interfaces (produces):**
```ts
export const JOB_EXPIRY_DAYS_MAX = 30, JOB_TASKS_MAX = 1_000, JOB_TASKS_DEFAULT = 100, JOB_LIST_MAX = 100, STUCK_AFTER = 3, JOB_KEEP_DAYS = 90, REVALIDATE_DAYS = 30;
export const validateJobSchema: z.ZodType<ValidateJobRequest>;
export const NEXT_TASK_SQL = "SELECT task_id, origin, area_ref, validated_at FROM eval_tasks WHERE project_ref = ? AND state = ? AND task_id > ? ORDER BY task_id LIMIT 200";
export const JOBS_SQL = "SELECT * FROM eval_jobs ORDER BY created_at DESC, job_id DESC LIMIT ?";
/** SHA-256 of the canonical JSON of the validation settings and eval.grader. */
export function jobDigest(settings: ValidationSettings, grader: EvalGraderConfig | undefined): string;
export type NextWork =
  | { kind: "task"; jobId: string; projectId: string; taskId: string; settings: ValidationSettings; fresh: boolean }
  | { kind: "wait"; jobId: string; waiting: EvalJobWait }
  | { kind: "none" };
export type Gates = { grader: GraderProbe; hostLoadHeld: boolean; halted: (projectId: string) => boolean };
export class EvalJobs {
  constructor(options: { store: EvidenceStore; config: Pick<Config, "projects" | "eval">; now?: () => string });
  create(projectId: string, request: ValidateJobRequest, requestId: string): { created: boolean; job: EvalJobView } | EvalRefusal;
  control(jobId: string, action: "pause" | "resume" | "cancel"): EvalJobView | EvalRefusal;
  view(jobId: string): EvalJobView | undefined;
  list(limit?: number): EvalJobView[];
  projectJobs(projectId: string, limit: number): EvalJobView[];
  next(gates: Gates): NextWork;
  record(jobId: string, taskId: string, outcome: TaskValidation): void;
  sweep(): number;
}
```

**Decisions:**

- **The schema**, strict: `kind` `"validate"`; `taskFilter.taskIds` at most 1,000 ids matching `/^(captured|mined):[A-Za-z0-9:._-]{1,200}$/`; `origins` at most 2; `areas` at most 32 of `/^[a-z][a-z0-9-]{0,39}$/`; `maxTasks` 1 to 1,000 (default 100); `limits.maxWallMinutes` 10 to 43,200; at most 4 `windows` of whole UTC hours, `startHourUtc` 0 to 23 and `endHourUtc` 1 to 24, a window with an end below its start crossing midnight; `expiresAt` an ISO time at most 30 days ahead (default 30 days).
- **`create`.** An unknown project is `404` `unknown-project`; `validationSettings` with a `missing` key is `409` `eval-config-incomplete`. A known `requestId` with the same request digest returns that job with `created` false; with another digest, `409` `request-conflict`. A job of the project in `scheduled`, `running`, `paused`, or `blocked` is `409` `job-active`. Otherwise status `scheduled`, the sealed payload with the request, its digest, and the pinned `jobDigest`.
- **`next`** reads jobs through `eval_jobs_status`, oldest first among `scheduled` and `running`. Per job, in order: expired (`expired`, reason `expired`); visited at `maxTasks`, or wall time since `started_at` at `maxWallMinutes` (`completed`, `limit-reached`); a digest other than the pinned one (`blocked`, `configuration-changed`); the project halted (`waiting` `halt`); outside every window (`window`); `hostLoadHeld` (`host-load`); the grader not `ready` (`grader`); `storage` false (`storage`). Then `NEXT_TASK_SQL` after `cursor` for `candidate` (and, with `revalidate`, `valid` rows validated 30 or more days ago), filtered by origin, `area_ref`, and task ids; no task completes the job (`completed`, `done`). `waiting` is written only when it changes. A second job never starts while another job's task runs (`another-job`).
- **`record`** moves the cursor and the counters. `decided` resets `streak`; `undecided` adds 1 to `undecided` and `streak`; at `STUCK_AFTER` (3) the job pauses with `validation-stuck`. `environment` changes no counter: `grader-processes-alive` blocks the job; `halted` sets `waiting` `halt`; the others set `waiting` `grader`, `mirror`, or `bundle` and keep the cursor, so the task is visited again.
- **`control`.** `pause` from `scheduled` or `running`: `paused` `owner`. `resume` from `paused`, or from `blocked` (it pins the current digest, which is the owner's approval of the change): `running`, or `scheduled` if never started. `cancel` from any status that is not final: `cancelled`. Anything else is `409` `invalid-job-transition`.
- **`sweep`** deletes jobs whose `finished_at` is older than 90 days, at most 100.

- [ ] **Step 1: Write the failing tests** in `tests/eval-jobs.test.ts`, on a real store with a fixed clock that the tests move forward and back.

| Test name | Assertions |
|---|---|
| `a request id makes one job` | The same id and body twice: one job, `created` true then false. The same id with `maxTasks` 5: `request-conflict`. A second id for the same project while the first is `paused`: `job-active`. A project without `focusedTest`: `eval-config-incomplete`. |
| `a changed configuration blocks the job` | After the first task, the project's `focusedTest` changes: `next` blocks the job `configuration-changed` and returns no task. `resume`: `running`, and `next` returns the next task. A change of `eval.grader.root` blocks it the same way. |
| `the job waits for every gate and says which` | Each gate in turn (halt, window, host load, grader `exposed`, storage): `next` returns `wait` with that name, and the job's `waiting` column holds it. With the clock moved back one hour inside a window and forward again, the result follows the clock. |
| `undecided tasks pause the job, environments count nothing` | Three `undecided` results: `paused` `validation-stuck`. Three `environment` `anchor-unknown` results: the counters and `attempts` unchanged, the cursor unchanged. |
| `a job ends at its limits` | `maxTasks` 2: the third `next` completes the job `limit-reached`. A clock past `expiresAt`: `expired`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-jobs.test.ts` and the typecheck.

### Task 11: the summary and the routes

**Files:** `packages/host/src/eval-summary.ts`, `packages/host/src/eval-routes.ts`, `tests/eval-routes.test.ts`. Needs Tasks 3 and 10.

**Interfaces (produces):**
```ts
// eval-summary.ts
export const SUMMARY_AREAS_MAX = 64, SUMMARY_JOBS = 10;
export const STATE_COUNTS_SQL = "SELECT origin, state, count(*) AS n FROM eval_tasks WHERE project_ref = ? GROUP BY origin, state";
export const AREA_COUNTS_SQL = "SELECT area_ref, state, count(*) AS n FROM eval_tasks WHERE project_ref = ? AND state IN ('candidate', 'valid') GROUP BY area_ref, state";
export const VALID_CAPTURED_SQL = "SELECT count(*) AS n FROM eval_tasks WHERE project_ref = ? AND origin = 'captured' AND state = 'valid' AND captured_at >= ?";
export function evalSummary(store: EvidenceStore, input: {
  project: Project; mining: MiningStatus; grader: GraderState; jobs: EvalJobView[]; now: string;
}): EvalSummary;   // throws EvidenceError "unavailable"
// eval-routes.ts
export function evalRoutes(app: express.Express, deps: { host: EvalHostApi }, readGuard: express.RequestHandler, ownerGuard: express.RequestHandler): void;
```

**Decisions:**

- **Counts** come from the three statements and `groupStats`; a state with no row is 0, because a count over rows that exist is a fact, not a guess. `byArea` maps each `area_ref` through the project's feature-map ids, `mixed`, and `root` (each `index('area', id)`); any other reference counts under `other`; at most 64 areas. `bySet` is null until step 4.
- **Coverage.** The window is `min(retentionDays ?? 365, 730)` days. The denominator is the sum of `levels.accepted.yes` over the cells of `queryCells(store, { use: "display", sources: ["production"], by: [], role: "implementer", projectId, days }, { now })`. Coverage is null when the denominator is 0, when `unreadable` is above 0, or when the `outcomes` module is not ready; otherwise `share` is `validCaptured / accepted`. *(My call: unknown is never shown as a number, and a share over a partial read is unknown.)*
- **Routes.** `GET /api/eval/projects/:id`, `GET /api/eval/jobs`, and `GET /api/eval/jobs/:id` behind `readGuard`. `POST /api/eval/jobs` (body `{ requestId: uuid, job: ValidateJobRequest }`), `POST /api/eval/jobs/:id/pause`, `/resume`, `/cancel`, and `POST /api/eval/tasks/:id/retire` behind `ownerGuard`. A body or id that does not parse is `400` `invalid-eval-request`. An `EvalRefusal` answers with its status and code and a fixed sentence that names no id. A created job is `201`; an existing one `200`. No route returns a capsule, a patch, a file name, a case, or a commit.
- **Cost.** A summary runs six indexed statements over the project's rows (`eval_tasks_summary`, `eval_tasks_project`, `eval_groups_project`), one mining row by key, the project's newest 10 jobs through `eval_jobs_project`, and one `queryCells` (the scorecard's own read). At 25,000 eval rows and 10,000 outcome rows that is one index scan of each, on request only. `GET /api/eval/jobs` is one statement with `LIMIT 100` and opens no sealed payload: `projectId` comes from a map of each configured project's `index('project', id)`, and an unknown reference shows null.

- [ ] **Step 1: Write the failing tests** in `tests/eval-routes.test.ts`, on an express app with a real store and an `EvalHostApi` built from Tasks 3 and 10 with a fake miner status and grader state.

| Test name | Assertions |
|---|---|
| `the summary counts every state and keeps unknowns unknown` | Rows of each state and origin: the counts by state and origin; area `host` and `other`; `bySet` null; no ledger rows: `coverage` null; 4 accepted attempts and 1 valid captured task: `share` 0.25 within 1e-9. No mining row: `visited` null, never 0. |
| `only the owner changes a job` | Viewer and controller tokens: `GET` routes `200`, every `POST` `403`. Owner: `201` then `200` for the same request id; pause, resume, and cancel `200`; a second cancel `409` `invalid-job-transition`; retire of a rejected task `409` `task-not-active`; an unknown project `404` `unknown-project`. |
| `no route answers with text from the corpus` | A task whose capsule holds `Objective-7f3a` and files `secret-name`: no response body of any route contains either string or the commit id. |
| `an unavailable store answers 503` | A store that failed to open: every route answers `503` `evidence-unavailable`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-routes.test.ts` and the typecheck.

### Task 12: the CLI

**Files:** `packages/host/src/eval-cli.ts`, `packages/host/src/client.ts` (+2 lines), `scripts/file-size-baseline.json` (`client.ts` 1,405), `tests/eval-cli.test.ts`. Needs Task 1. Runs in parallel with Tasks 2 to 8.

**Interfaces (produces):**
```ts
type EvalApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
export function evalStatusLines(summary: EvalSummary): string[];
export function evalJobLines(job: EvalJobView): string[];
export async function handleEvalClientCommand(positional: string[], options: Record<string, string | boolean>, api: EvalApi): Promise<boolean>;
```

**Decisions:**

- **Commands:** `infinite eval status PROJECT [--json]`, `infinite eval run --file job.json --request-id UUID [--json]`, `infinite eval job JOB [--json]`, `infinite eval pause|resume|cancel JOB`, `infinite eval retire TASK`. `run` reads at most 64 KiB from the file, parses it as JSON, and sends `{ requestId, job }`. *(My call, beyond part 8: `job`, `pause`, `resume`, `cancel`, and `retire` give the owner the routes of part 8 from a terminal.)*
- **Status lines**, in this order: the project; `capture on|off · mining STATE (visited N, mined N, skipped N, failures N)`; the counts by state; the mined counts; `groups N (dev-only N, largest N)`; `coverage P% of N accepted attempts over D days` or `coverage unknown`; `grader STATE`; then one line per job. A null count prints `unknown`. Every text value passes through a `clean` with the rule of `routing-cli.ts`, which keeps its own private: `/[\x00-\x1f\x7f-\x9f]/g` becomes a space.
- A `404` without a known code prints `This host has no eval routes. Upgrade the host first.`
- `client.ts`: `"eval"` joins `CLIENT_COMMANDS` in place; `import { handleEvalClientCommand } from "./eval-cli.js";` after the `permissions-cli.js` import; `if (command === "eval") return await handleEvalClientCommand(positional, options, api);` after the `permissions` dispatch line. `scripts/file-size-baseline.json`: `client.ts` 1,403 to 1,405, the reviewed raise of this plan.

- [ ] **Step 1: Write the failing tests** in `tests/eval-cli.test.ts`, with a fake `EvalApi`.

| Test name | Assertions |
|---|---|
| `status prints only ids, states, and counts` | A summary with a null coverage, a null `visited`, and a job `waiting` `grader`: the exact lines, with `coverage unknown`, `visited unknown`, and `waiting grader`. A project id holding `\u001b[2J` prints with spaces in place of the control characters. |
| `run sends the file and the request id` | `run --file job.json --request-id UUID`: one `POST /eval/jobs` with `{ requestId, job }`; a missing `--request-id`, a 65 KiB file, or a file that is not JSON: an error before any call. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-cli.test.ts tests/client-cli.test.ts`, `node scripts/check-file-size.mjs`, and the typecheck.

### Task 13: the eval host, the server, and the host test

**Files:** `packages/host/src/eval-host.ts`, `packages/host/src/server.ts` (net 0 lines), `tests/eval-validate-run.test.ts`. Needs Tasks 5, 9, 10, and 11.

**Interfaces (produces):**
```ts
export const TICK_MS = 60_000, SWEEP_MS = 3_600_000;
export type EvalHostOptions = {
  config: Config; store: EvidenceStore; source: Pick<ProjectSourceService, "mirrorPath" | "status">;
  hostLoad: Pick<HostLoadGate, "held">; halt: () => Pick<HaltService, "check">; runs: () => readonly TeamRun[];
  grader?: Grader; mineGit?: MineGit; inventory?: () => Promise<RuntimeProcess[]>; now?: () => string;
};
export class EvalHost implements EvalHostApi {
  constructor(options: EvalHostOptions);   // builds TaskCapture (with onPromoted), GroupPass, Miner, EvalJobs
  readonly capture: TaskCapture;
  /** One sweep and one tick, then both timers, unreferenced. */
  start(): void;
  /** capture.reconcile, the groups pass, the miner's pump, the validation pump. Never throws. */
  tick(): void;
  /** capture.sweep, sweepGroups, the jobs' sweep. Never throws. */
  sweep(): void;
  routes(app: express.Express, readGuard: express.RequestHandler, ownerGuard: express.RequestHandler): void;
  idle(): Promise<void>;
  close(): void;
  // EvalHostApi: summary, jobs, job, create, control, retire
}
```

**Decisions:**

- **The validation pump** runs one task host-wide. It probes the grader at most every 10 minutes (and at once after a failure), `halt().check({ projectId })` is the halt gate, and `hostLoad.held()` is read only before a task starts, never during one, because the task's own tests raise the load. On a `fresh` task it calls `prepareJob`; then `validateTask`; then `jobs.record`. A `halt()` that throws counts as halted. *(My call: fail closed.)*
- **At startup** the first pump runs `stopGrader` and `clean` for every job that was `running`, before any task, so a restart counts no attempt and leaves no process.
- **`summary`** calls `evalSummary` with the miner's status, the cached grader state (a probe when it is older than 10 minutes, at most once per 10 minutes), and the project's jobs. `retire` acts on a `candidate` or `valid` task with `retireTask` `owner-retired`.
- **`server.ts`**, all its lines in this slice:
  - Line 42, `import { TaskCapture } from "./eval-capture.js";` becomes `import { EvalHost } from "./eval-host.js";`.
  - Line 268, `const capture = new TaskCapture({ config, store: evidence, source: projectSource });` becomes `const evalHost = new EvalHost({ config, store: evidence, source: projectSource, hostLoad: manager.hostLoad, halt: () => halt, runs: () => teams.understandingRecords() });`.
  - Line 278, `capture,` in the `TeamService` options becomes `capture: evalHost.capture,`.
  - Line 404, `capture.sweep();`, and line 415, `capture.reconcile();`, are removed: `EvalHost` runs both on its own timers.
  - Line 418, `capture.close();` in `closeEvidence` becomes `evalHost.close();`.
  - After line 1100 (`routingRoutes(...)`): `evalHost.routes(app, requireRole(["owner", "controller", "viewer"]), requireRole(["owner"]));`.
  - After line 2247 (`outboxTimer.unref();`): `evalHost.start();`.
- `halt` and `teams` are read only inside closures that the timers call after startup. `understandingRecords()` copies every kept run; the groups pass and the miner call it at most once per pass and only when that pass has work.
- **Cost per tick at 1,000 sessions and 10,000 outcome rows:** at most 100 reconcile rows, 100 landing checks (one signal read by key each), 100 path-index rows, one mining pass of at most 50 commits and 105 mirror reads (two a commit, and five to place the cursor and list the commits), and at most one validation task host-wide. No step reads anything per session, and none reads the outcome rows.

- [ ] **Step 1: Write the failing tests** in `tests/eval-validate-run.test.ts`. Setup: a bare mirror with branch `main` and a linear history of four commits in a temporary directory: C0 (`package.json` with `"type": "module"`, `src/math.js` exporting `sub`); C1 (adds `add` to `src/math.js` and `tests/add.test.js`); C2 (a comment in `src/math.js` and `tests/sub.test.js`, which passes at C1); C3 (a comment in `src/math.js` and `tests/flaky.test.js`, which passes when `$HOME/flag` is absent and then creates it). The project is `github` with `team.eval = { mine: true, focusedTest: { command: process.execPath, args: ["--test", "--test-reporter=junit", "--test-reporter-destination={report}", "{files}"] }, reportFormat: "junit" }` and `checks: []`. `eval.grader` names the fixture launcher with `--uid` the host's plus one and `--metadata closed`; the inventory is the fixture's own group list. Halt clear, host load not held, `runs` empty. Long batches run in the background.

| Test name | Assertions |
|---|---|
| `a fixture commit becomes valid, and the two bad ones are rejected` (acceptance 2) | After ticks until mining is `caught-up`: three mined `candidate` rows. A validate job, then ticks until it completes: C1 `valid` with one expected case; C2 `rejected` `not-fail-to-pass`; C3 `rejected` `flaky`. The job `completed` `done`, counts visited 3, valid 1, rejected 2. The grader root holds no `jobs/JOB` after the job. No plain column of any eval table contains `add.test` or a commit id. |
| `no grader, no validation` | Without `eval.grader`: the job stays `scheduled` with `waiting` `grader`, no task changes, and `summary` shows `not-configured`. With `--metadata open`: `network-open`, and no grader `run` was recorded. |
| `a restart in the middle of a task counts no attempt` | `close()` while round 1 runs, then a new `EvalHost` on the same store: the first pump records `stop` and `clean` before any `run`; the task is validated again with `attempts` 0. |
| `an unavailable store takes nothing and throws nothing` | A store that failed to open: `tick`, `sweep`, and `summary` throw nothing; no Git and no grader command runs; the routes answer `503`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `tests/eval-validate-run.test.ts` on the host in the background, then the typecheck and `node scripts/check-file-size.mjs`.
- [ ] **Step 5: The coordinator runs `npm run check` once, requests the independent review, and commits.**

### Task 14: the docs

**Files:** `docs/teams.md`, `docs/security.md`, `deploy/ubuntu/grader.md` (create), `docs/superpowers/specs/2026-11-12-replay-eval-design.md`. Needs Task 1. Runs in parallel with Tasks 2 to 12.

**Decisions:**

- `docs/teams.md`, under Eval capture, a section "Eval mining and validation": the new `eval` fields and their limits, the host `eval` block, how mining walks and what it skips, the mined and validation reason codes, groups and the dev-only mark, the rounds and what makes a task valid, the job lifecycle and its waits, the summary, the CLI, and the forms below with what is missing while each is refused.
- `docs/security.md`: the grader identity and what a hostile test can and cannot reach, from "Trust boundary" above, including the limits that remain.
- `deploy/ubuntu/grader.md`: the installs of "Owner approvals", step by step, with the checks (`sudo -l -U infinite-host`, the probe through `infinite eval status`).
- The spec. Part 1: `mine` and the validation fields; no per-project `graderProfile`. Part 2: the lineage window and width; the base-round construction; the round order; `unvalidated`; the codes. Part 4: the grader launcher and probe. Part 6: the validate job's shape and pinned digest. Acceptance 3: the set clause moves to step 4.
- No home path, host name, user name, or tracker link.

- [ ] **Step 1: Write the docs.** **Step 2: Run** the privacy scan of `AGENTS.md` over the diff.

## Git commands

Three new forms in the source mirror need the owner's launcher approval, and four forms of the base scan are reused. Every one runs in the mirror (`ProjectSourceService.mirrorPath`) through `teams.commandPrefix`, after the six `-c` settings of `teamGitArgs`, with `GIT_NO_REPLACE_OBJECTS=1`, and every id passes `COMMIT_ID` first. The mirror is agent-writable, so each form pins what a repository's own configuration could change.

1. **New, E1: the change counts of a commit.** `git diff --no-ext-diff --no-textconv --numstat --no-renames --ignore-submodules=none --diff-algorithm=myers -z PARENT COMMIT --`. PARENT is the first parent that form 4 printed. 30 seconds; 64 KiB of output, and a truncated read is `too-large`. **While the launcher refuses it:** no commit is mined, mining is `failing`, and nothing is claimed about any commit.
2. **New, E2: the time and message of one commit.** `git log --no-walk=unsorted --no-show-signature --no-notes --encoding=UTF-8 --format=%ct%x00%B COMMIT`, with `--format=%ct%x00%B` one argument and one id. 30 seconds; 64 KiB, and a truncated read is `capsule-too-large`. **While refused:** no commit is mined.
3. **New in the mirror, E3: the base-branch bundle.** `git bundle create - refs/heads/BRANCH`, the form that team copies admit for run branches (`spawnTeamBundle`), here with the project's `source.baseBranch`. Streamed, at most 1 GiB; 600 seconds. **While refused:** no validation starts, and the job waits `bundle`.
4. **Reused: forms 1 to 4 of the base scan.** Form 1 (`merge-base --is-ancestor`) checks the forward walk and each task's anchor and commit; form 2 lists new commits; form 3 pages the backfill; form 4 gives first parents, 1 to 50 ids. Their launcher audit is pending with the outcome-ledger release. **While refused:** mining is `failing`, and a validation waits `mirror` and counts no attempt.

The launcher ends E1 and E2 by itself after 35 seconds and E3 after 660 seconds, as for the capture reads; the host may not signal a command that the launcher runs as another account. It also sets `GIT_NO_LAZY_FETCH=1` for them.

The Git commands that validation runs inside the grader's root (`clone` of the bundle, `update-ref`, `checkout`, `apply`, `commit`, `diff --name-only`, `restore`) are grader commands, run through the grader launcher's `run`, with the launcher's environment and limits. They are not forms of `teams.commandPrefix`.

## Owner approvals

The owner decided on 2026-11-13 to add the grader identity. None of the following is installed, and the slice works without it: mining needs only items 6 and 7, and validation needs items 1 to 5 and 7, plus E3 and form 1 of item 6 (see "Git commands").

1. **The account.** `useradd --system --user-group --create-home --home-dir /var/lib/infinite-grader --shell /usr/sbin/nologin infinite-grader` (a second instance uses `infinite-NAME-grader`, as `deploy/ubuntu/instances.md` names accounts). It joins no other group: not the agent's, not the host's, and not the group that may read the GitHub App token cache. It has no provider login and no repository credential.
2. **The root.** `install -d -o infinite-grader -g infinite-grader -m 0700 /var/lib/infinite-grader/root`, on the data volume. *(Recommended, not required: a disk quota for the account.)*
3. **The launcher.** `install -o root -g root -m 0755 deploy/ubuntu/grader-command.sh /usr/local/libexec/infinite/grader-command`, with its `ROOT=` line set to the root of item 2.
4. **The sudo rule.** `install -o root -g root -m 0440 deploy/ubuntu/grader.sudoers /etc/sudoers.d/infinite-grader`, then `visudo -c`. It holds exactly: `Defaults!/usr/local/libexec/infinite/grader-command env_reset` and `infinite-host ALL=(infinite-grader) NOPASSWD: /usr/local/libexec/infinite/grader-command`.
5. **The network rule.** `deploy/ubuntu/grader.nft`, loaded with the host's other nftables rules: it rejects the grader's output to link-local, private, CGNAT, and multicast ranges in IPv4 and IPv6. Required where the cloud metadata address answers (the probe shows `network-open` until then); recommended everywhere.
6. **The mirror forms.** E1, E2, and E3 of "Git commands", added to the production launcher of `teams.commandPrefix` for the mirror, with the 35-second and 660-second limits and `GIT_NO_LAZY_FETCH=1`; and forms 1 to 4, if their audit is still pending.
7. **The configuration.** Host: `"eval": { "grader": { "prefix": { "command": "/usr/bin/sudo", "args": ["-n", "-u", "infinite-grader", "--", "/usr/local/libexec/infinite/grader-command"] }, "root": "/var/lib/infinite-grader/root", "canaries": [the deploy's GitHub App, grant, egress, and vault key paths] } }`. Project: `team.eval.mine: true` to mine, and `focusedTest` and `reportFormat` (with `gradingPaths` and `guardChecks` as needed) to validate.

## Not in this slice

- Trials, the eval identity, the trial source and its probes, grading, `baseline` jobs, reports, and the prior export (steps 3 and 4).
- The dev and holdout sets, the seeded hash, holdout rotation, exposure, and acceptance 3's set clause (step 4). The dev-only mark is stored for step 4 to read.
- `candidateProfiles`, `memberProfile`, and `trialMinutes` (step 3). There is no per-project `graderProfile`.
- Reinstating a mined task whose captured duplicate is later rejected, and undoing a lineage merge that a later landing proves wrong.
- Skipping a commit whose reads keep failing. Mining stays `failing` and retries hourly; the owner sees it.
- A scheduled revalidation. The owner starts one with `revalidate: true`; the learning scheduler of the delegated adoption design schedules it later.
- A per-account `/proc` view (`hidepid`), a private `/tmp` for the grader, and a disk quota, each an owner hardening choice.
- The summary in the web client, the phone, and the Mac app.
- MCP tools: none, by design (C9 rules 3 and 8: an eval result and eval material never reach a member's prompt, workspace, or tool result).

# Slice: trials

Spec part 1 (the trial settings), part 3 (trials and the replay run), part 4 (the eval identity and the trial source), part 5 (grading), part 6 (the `baseline` job and the gates before a trial), and part 8 (outcome rows), delivery step 3, with acceptance 4 to 8 and the job clause of acceptance 9 (Linear INF-291). After it, an owner who installed the eval identity and turned trials on for a GitHub project can create a `baseline` job: the host replays the project's valid eval tasks under each named configuration, one implementer at a time as the eval identity, grades each result as the grader identity against the hidden tests, and keeps a sealed grade and result patch per trial for step 4. It builds on capture, mining and validation, the grader launcher, the launch-rate fuse, the host-load gate, the halt, the egress boundary, the permission pipeline, and the outcome ledger, which are on `main`; every replay run writes outcome rows with source `replay` that no routing read uses.

## Coordinator rulings (2026-11-17)

These override the text below where the two differ.

1. **The plan's rulings stand.** Accepted as written: the eval identity as host configuration; no trial without both identities; the `trialsPerDay` stand-in; gates only on what exists; the grader-built source; the result patch; the permission rule; nullable grades; `no-result`; the home reset; the empty launcher environment; baseline-only configurations; the exclusions; and the purpose fields.
2. **Trial dialogs.** A trial's permission dialogs go through the project's permission pipeline. For a project the host permission agent serves, they also go through that agent, as in production. This is the design's "pinned permission review" (part 3), without a second session. `docs/teams.md` and the pull request say so in one sentence, so the owner sees that the agent's delegation reaches trial dialogs. A dialog left to a person ends the trial `permission`, and nothing answers it.
3. **Launcher test safety (lesson from INF-281).** Every test copy of `eval-command.sh` replaces the `kill -KILL -1` line of `stop` with `exit 99`, and asserts that the replacement happened. A broken account check can then never kill the test runner. A test that calls `stop` calls it last. Cleanup restores modes (`chmod -R u+rwX`) before it removes a tree. The same holds for every test copy of `grader-command.sh` in Task 5.
4. **Linux-only tests.** The launcher tests of Tasks 4 and 5 skip off Linux, so a worker on macOS cannot see them fail. The worker writes them, runs `bash -n` (and `shellcheck` when it is installed), and reports. The coordinator runs them in a throwaway Linux container, as a non-root user with no network, and records the result before the commit.
5. **Workers.** At most four implementers at once.
   - Task 1 runs alone.
   - Then Tasks 2, 3, 7, and 8.
   - Then 4, 5, 6, and 10 as slots free.
   - Then 14, 16, 12, and 9 (Task 9 after 2, 3, and 6).
   - Then 11 (after 5 to 8) and 13 (after 12).
   - Task 15 runs last.
6. **Shared line budgets.** On this branch, `teams.ts` grows by at most 27 lines (5,707 to 5,734). INF-292 adds 5 lines on its own branch, so the composed tree stays at or under 5,739 of the 5,747 baseline. `server.ts`, `manager.ts`, `worker.ts`, `outcome-store.ts`, and `scripts/egress-proxy.mjs` change only in place.
7. **Nothing is installed.** The deploy files are templates. The slice changes no installed launcher, sudo rule, or network rule. The pull request lists what the owner installs, from "Owner approvals".
8. **The day's trial count takes the project id.** Task 7's interface reads `trialsSince(db, projectRef, since)`. Ruling: `trialsSince(db, projectId, since)` computes the blind index itself, so no caller handles an index. `TrialRow.projectRef` stays the index. Tasks 12, 13, and 15 pass the project's id.
9. **No state outlives a trial outside the scrubbed home.** The wrapper's `TMPDIR` (`/var/lib/infinite-eval/tmp`) and any entry of `ROOT` other than `trials` outlive `stop`, `clean`, and `scrub`, and `scrub` keeps a symbolic link that stands on the way to a login path. A trial could leave skills, memory, or its solution for the next trial of the same task. Ruling: the launcher gains the constant `EVAL_TMP=/var/lib/infinite-eval/tmp`, which the wrapper's `TMPDIR` must equal. `clean` also removes every entry of `EVAL_TMP` and every entry of `ROOT` other than `trials`. `scrub` first removes a login path that is not a regular file, and a path on the way to one that is a symbolic link or not a directory. `probe` counts in `leftovers` each entry of `ROOT` other than `trials`, each entry of `EVAL_TMP`, and each login path or path on the way to one that `scrub` would remove: a symbolic link, a path on the way that is not a directory, or a login path that is not a regular file. The login files stay writable by the member, because the providers rewrite them on refresh, so they remain a channel between trials; the slice accepts that. A crontab or an `at` job would outlive `stop`, so the owner denies both to the account (Owner approvals, item 1).
10. **Setup's proxy set follows the host's egress set.** Main's egress change (INF-296) gives every session the six proxy variables and `NODE_USE_ENV_PROXY=1`, without which Node 22 clients ignore the proxy and connect directly, which the eval network rule refuses. Ruling: `setup` adds the same set: the four proxy variables, `NO_PROXY` and `no_proxy`, and `NODE_USE_ENV_PROXY=1`.

Where the design and the code disagree, or the design leaves a point open, this plan rules:

- **Eval launch profiles.** Part 1 gives each project `memberProfile?: string`. A launch profile in the code is one `AgentProfile` per provider (`Config.agents`), and one eval account serves every project. Ruling: the eval identity is host configuration, `eval.member`, beside `eval.grader`: its launcher, its root, one launch profile per provider, and canaries. A project has no member-profile field. *(My call: the slice 2 ruling for the grader; a per-project field would name one account many times.)*
- **No trial without both identities.** Acceptance 5 labels a trial `none` when a launch profile is missing. Ruling: without `eval.member`, or while the grader is not `ready` at launcher version 2, no trial starts. *(My call: a trial without the eval identity would run as the agent account, with production logins and credentials.)*
- **The learning budget.** Part 6's budget (C8) needs the spend fuse's token, `listUsd`, and `spentUsd` ceilings (C13). The fuse on `main` has only the launch rate (`fuse/rules.ts`, `FuseCause = "launch-rate" | "unmeasurable"`), and no reservation rows exist. Ruling: a bounded stand-in, `project.team.eval.trialsPerDay`, absent by default, so no trial starts in any project, autonomous or supervised. A job has `maxTrials` and `maxWallMinutes` and no USD limits. `reserve`, `settle`, `status`, `estimate-unavailable`, `budget-exhausted`, and the per-trial estimate in the job view arrive with delivery step 4 of the delegated adoption design, "The standing budget", which removes `trialsPerDay`. Acceptance 9's `reserve` clause moves there. *(My call: one owner-set daily count is the smallest cap that bounds spend, and an autonomous project gets no default budget before the budget exists.)*
- **Gates that need other designs.** Part 6 holds a trial while headroom is below the learning floor and while any run has an open duel. The floor is delegated adoption Part 9 and duels are their own design; neither is on `main`. Ruling: this slice gates on an active provider limit and on four free session slots, as part 6 also says. The floor joins with the standing budget, the duel gate with duels. *(My call: gate only on what exists.)*
- **The trial source.** Part 4 builds it in a staging clone of the mirror, which needs five or more new `teams.commandPrefix` forms run as the agent account. Validation already builds the replay base in the grader's root (`eval-base` in the job's `task` clone). Ruling: the grader builds the source. A new grader operation, `export`, streams a bundle of one branch at `eval-base` through the host into the eval launcher, which clones it. *(My call: no new `teams.commandPrefix` form, and no eval material in a directory the agent account can read.)*
- **The result's way to the grader.** Part 5 step 2 streams a bundle of the result commit. Ruling: the host reads the result as a binary patch through the eval launcher (slice 2's `captureGit` reader, at most 1 MiB) and sends it to the grader as `result.patch`. *(My call: the reader already streams with a limit, the grader already applies patches, and a patch carries no object the base lacks.)*
- **Permission review.** Part 3 gives the replay member "the project's pinned permission review". That review is a second session, a permission coordinator, against part 4's one-session rule. Ruling: a replay run never sets `run.permissions`, so `maybeStartPermissionReview` never starts a coordinator. The session's permission pipeline, and the host permission agent for a project it serves, decide dialogs as in production. A dialog left to a person ends the trial `permission`. *(My call: one live session per eval identity, and part 3's own rule that no component answers an undecided prompt.)*
- **Unknown grades.** Part 5's `TrialGrade` makes `expectedPassed` and `diff` numbers. A result can break the runner so that no report exists, and a numstat read can be truncated. Ruling: `expectedPassed: number | null` and `diff: {…} | null`. Null is unknown, never zero, and a null `expectedPassed` never resolves. *(My call: the honesty rule.)*
- **A member that exits without a report.** Production blocks the run `missing-agent-report`. Ruling: the trial ends `no-result`, a member failure, not a void. *(My call: re-running member failures as voids would bias the measured rate upward.)*
- **Sets, filters, and reuse.** Part 6's `taskFilter` has `set`, `excludeGroups`, and `promptOrigins`, and a later job reuses a recent trial. The sets arrive in step 4, and `promptOrigin` lives only in sealed payloads. Ruling: a baseline job reads every `valid` task its filter selects (task ids, origins, areas, `maxTasks`), never reuses a trial, and keeps on each trial row the keys that reuse and the sets need: task id, `configId`, profile epoch, and harness version. *(My call: step 4 owns the sets and reuse, and a filter on a sealed field would unseal every task on the job's path.)*
- **Configurations.** Part 3's `EvalConfiguration` admits pinned guidance, forced knowledge, and a prompt override. Ruling: a baseline configuration is `{ profile, guidance: "as-of-base", knowledge: "none" }` only. *(My call: the others need the improvement gate, which also brings the `gate` purpose.)*
- **State between trials.** Part 4 cleans the trial workspace. A member can also write the eval account's home: provider settings, hooks, user-level MCP servers, skills, and memory files that later trials would load. Ruling: before each trial the eval launcher resets the home from a root-owned template and keeps only the login files. *(My call: without the reset, one trial can change every later one.)*
- **Paths outside part 3's table.** Part 3 removes replay runs from `list`, `statuses`, and `understandingRecords`. The member's session also reaches the session list (`server.ts` `listSessions`), the notifier's session pushes (`notifier.ts` `tick`), the provider-limit memory (`teams.ts` `limits.reconcile`), and project activity (`TeamService.activeForProject`). Ruling: each of them skips learning sessions or replay runs, and `get` and `objectiveRecord` answer `404` for a replay run. *(My call: acceptance 6 needs no notifier call, and a trial must neither hold back production work nor switch production members to their fallbacks.)*
- **Hardcoded values.** `fuse/rules.ts` `workLaunch` and the `member.started` event in `teams.ts` hardcode `purpose: "work"`; `config-identity.ts` `memberConfiguration` hardcodes `shape: "team"`; `outcome-projector.ts` hardcodes `source: "production"` in `ensureSummary`, `blankOutcome`, and `blankResult`. Ruling: each takes the replay run's value (Tasks 2, 9, and 10).

**Rulings before the build.**

- Line numbers in this section were read on the reference tree at `7eb630a` (main `3c4e15b` with PRs #174, #175, and #176). Find each place by the quoted code.
- The eval account, its launcher, its home template, its wrappers, its sudo rule, its network rule, the egress lists `_eval` and `_eval-setup`, the eval logins, and grader launcher version 2 wait for the owner (see "Owner approvals"). The slice ships with no trial able to start: without `eval.member` the eval identity is `not-configured` and a baseline job waits `eval-identity`; with grader launcher version 1 the job waits `grader`, and the summary shows `grader ready (version 1: no trials)`.
- The owner defaults stand until the owner changes one: `trialsPerDay` absent (off), `trialMinutes` 45, three trials per task, 20 tasks per job, and the limits of Tasks 4 to 12.
- One trial runs host-wide at a time, because one eval identity runs one live session. The eval host runs its validation step and its trial step in one chain, so one user holds the grader at a time.
- No member report kind and no team role is added. The implementer role and the report kinds `result`, `question`, `blocked`, and `escalate` exist, so `tests/run-event-coverage.test.ts`'s `REPORT_SAMPLES` and the fake agents need no new entry. A trial spends one member launch, which the fuse counts with purpose `replay`. The one new run field, `replay`, is stripped from every team view, and no list or view route returns a replay run.
- State stays bounded. After a trial is final, the pump deletes the replay run's record (with no tombstone), and one hour later the member's session. Trial rows and patches expire with the hourly sweep.

**The eval identity is its own account behind a root-owned launcher, and the Manager is the one place a learning session gets its launch profile.** Every command in a trial workspace runs through `eval.member.prefix` (for example `sudo -n -u infinite-eval -- /usr/local/libexec/infinite/eval-command`), and the member's provider runs through `eval.member.agents[provider]` (`sudo -n -H -u infinite-eval -- /usr/local/libexec/infinite/eval/claude`). The account has its own provider logins and no repository credential, GitHub grant, or project environment. The Manager launches a session with purpose `replay` or `gate` only with that profile and refuses it without one (`409` `eval-identity-missing`); a `work` session never uses it. Before each trial the host stops the account's processes, removes every trial workspace, resets the account's home, and probes it. *(My call: one choke point makes "a trial never runs with production credentials" a single line to review, and a probe before each trial turns each part 4 claim into a check.)*

**A replay run is a `TeamRun` with `replay` set once; `createForReplay` builds it without `createRun`, and a helper owns every difference.** `TeamService.createForReplay` stores a prepared record with one pending implementer task seeded from the capsule, and emits `run.created` (purpose `replay`, `trialId`), `plan.accepted`, and one `task.planned` with the eval task's features. The new `team-replay.ts` holds part 3's differences as closures over the service, the way `team-intent.ts` holds the intent check, so `teams.ts` grows by at most 27 lines and `createRun` does not change. A replay run never publishes, tracks Linear, captures into the corpus, asks the owner, or reaches a client list. *(My call: `createRun` checks production profiles, the team volume, missions, and delivery, none of which applies; a second `TeamService` instance would duplicate report routing, timers, and recovery in `server.ts`, which has no line to spare.)*

**Only the runner report resolves a trial, and the grader grades it.** After every eval process has stopped, the host reads the member's result as a binary patch of at most 1 MiB through the eval launcher, checks its text for secret shapes, seals it, and sends it to the grader. The grader builds the grading commit on `eval-base`: the result, then from the reference the hidden files and every test file or `gradingPaths` file that either side changed. It runs `focusedTest` with the hidden files, and the guard checks only when every expected case passed. *(My call: restoring only the test files that either side changed gives the same tree as restoring every test file, because every other test file is equal in the base and the reference, and it keeps the restore list bounded.)*

**Trials are off by default, and the stand-in cap is the switch.** `trialsPerDay` (1 to 50) lives in `project.team.eval`, which `routines.ts` `digestedProjectTeam` already removes before the routine authority digest and `team-prompts.ts` `withoutPrivateSettings` already drops from member contexts. `eval.member` is host configuration, and `RoutineService.authority` hashes only the project, `teams`, `source`, `linear`, and `agents`. Neither blocks a routine. A job without `trialsPerDay` is refused `409` `eval-config-incomplete`. *(My call: one setting that the standing budget later replaces is easier to retire than a switch plus a cap.)*

**The member reaches only provider endpoints, through the egress boundary, and no host credential reaches the eval account.** The member's proxy credential carries the reserved egress identity `_eval`, and the proxy gives `_eval` only its own list, `projects._eval.allow`, never the global `allow`. The eval launcher receives no environment from the host (`!env_keep` in its sudo rule), so the host's `_host` proxy credential, which `teamCommandEnvironment` adds to every team command, never reaches the eval account. Setup, which installs dependencies, runs through a separate launcher operation that takes an `_eval-setup` proxy URL on standard input; that list holds the package registries, and its credential lasts 15 minutes. The recommended `eval.nft` rejects every output of the eval account except loopback. Before each trial the probe fetches the project's repository as the eval account, directly and through the proxy as `_eval`; when either succeeds, the trial is labelled `none`. *(My call: part 4 adds no egress filter, so a public repository could never be `isolated`; three in-place lines in `scripts/egress-proxy.mjs` give the label a meaning without a new service.)*

## Trust boundary, and what a review checks

The trial pump, the eval identity client, the replay helper, grading, the jobs, the routes, and the CLI are host code. These inputs originate outside the host:

- **The trial member.** A model session as the eval identity. It writes files in its workspace and its home, reports through the team CLI (schema-checked by `teamReportSchema`), draws permission dialogs, and starts processes. Its result reaches the host only as a binary patch read through the eval launcher, at most 1 MiB. The host seals the patch, sends it to the grader, and never logs it, parses it, or writes it to a host path. The member's processes end with the stop rounds, and its home edits end with `scrub`.
- **The repository's code at old commits.** `setup` runs as the eval identity in the trial workspace; `focusedTest` and the guard checks run as the grader in the grader's root. Neither identity holds a credential.
- **Eval material.** The capsule (objective, steering, owner answers, brief, task) becomes the implementer's prompt through the production `teamPrompt`. The host runs `findSecret` over it before the run exists, as mining does; a match skips the task `secret-shaped`.
- **Launcher output.** The eval probe's JSON (at most 4 KiB), `check`'s exit code, and the grader's runs and reports, as in slice 2. A refusal, a time-out, or a truncation is a failed call, never a pass.
- **Provider output.** Limit notices, attention states, and transcripts (usage capture). A limit voids the trial; a dialog left to a person ends it `permission`.
- **Owner configuration.** `project.team.eval` (`trialsPerDay`, `trialMinutes`, `candidateProfiles`) through the owner-only `PUT /api/projects/:id/team` or the configuration file; host `eval.member` and the egress policy through files. Strict schemas.
- **Device roles.** Owner, controller, and viewer read the summary and the jobs: ids, enumerations, counts, and times. Only the owner creates or controls a job.

**What a trial member can reach.** It runs as the eval identity in `ROOT/trials/TRIAL/work`. It has:

- **No production credential.** The Manager launches it with `eval.member.agents[provider]`. The eval wrapper loads no project environment and unsets `INFINITE_GITHUB_GRANT` and `INFINITE_GITHUB_PROXY`, and a replay launch passes no GitHub scope. It holds its own hook token, which serves only its session, and an `_eval` egress credential. Test: Task 2 `a learning session launches only as the eval identity`.
- **No later commit and no hidden test.** Its clone comes from a bundle of one branch at the replay base. Before launch, `check` proves absent the production reference commit, the integrated head, the grader's reference commit, the mirror head, and the reference blob of every hidden file, and proves that `git remote` prints nothing. Hidden material exists only in the grader's root, which the eval account cannot read. Test: Task 11 `the trial source holds only the base` (acceptance 4).
- **No host state and no production work.** The probe proves unreadable, before each trial: the evidence database, `keyFile`, `stateDir`, `runDir`, `teams.workspaceDir`, every GitHub project's mirror, every project's checkout, `eval.grader.root`, and the owner's `eval.member.canaries` (the GitHub App, grant, egress, and vault key paths, and a canary in the agent account's home). A readable canary is `exposed`, and no trial starts. Test: Task 6 `the eval probe names every unsafe state`.
- **No other session and no state from an earlier trial.** Before each trial the host runs up to three rounds of `stop` and the process inventory, then `clean`, then `scrub`, which resets the home from the root-owned template and keeps only the login files, then the probe, which must show no entry in `ROOT/trials` and no path in the home outside the login files and the template. Tests: Task 4 `scrub resets the home to the template`; Task 15 `no trial while the eval identity is busy` (acceptance 5).
- **Provider endpoints only.** Its credential is `_eval`, the proxy gives `_eval` only its own list, and `eval.nft` rejects direct output. Commands the host runs in its workspace get a fixed environment with no proxy variable. Tests: Task 3 `an eval session leaves the network only for its own list`; Task 4 `the eval launcher starts commands with a fixed environment`.

What stays reachable, and the docs say so: the package registries for up to 15 minutes after setup, to a process setup left running or a file holding its credential (the docs say not to list a registry that serves the project's own later releases); the shared `/tmp` (`stop` removes the eval account's files there); `/proc` command lines (the host passes no secret in an argument); loopback services, each of which needs a credential the member does not hold; the login files, which `scrub` keeps; and whatever a provider keeps for its login (owner decision 2).

**What reaches the prompt and the store.** The prompt is `teamPrompt` over the capsule, with no shared project context (`withoutSharedContext`, Task 2), no blackboard tools, no head publication, and no goal. The capsule passed `findSecret`, which knows the host-issued grant and egress shapes. For a project the host permission agent serves, the agent reads up to 4,000 characters of the member's first prompt, the capsule text, as it does for any headless member. A trial row's plain columns hold ids, enumerations, counts, times, a session id, and two references (`project_ref`, `config_ref`). Sealed: the configuration, the probe facts, the grade, and the result patch. The member's session holds an egress credential, so the host runs `findSecret` over the patch text before sealing it; a match drops the patch (`patch: "secret-shaped"`) and keeps the grade. The one new log line is `Eval trials paused (CODE).`, once per code per process.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| A host restart while the member runs, and again during grading | The trial ends `void-host`; the new process ends the replay run, stops, cleans, and resets the eval identity, and cleans the grader before any trial; the slot runs again with `attempt` plus 1 | Task 15 `a restart in the middle of a trial voids it` |
| A host restart while the source is being prepared | The `preparing` row is dropped; no attempt is counted; the slot runs again with the same `attempt` | Task 15 `a restart in the middle of a trial voids it` |
| `insertTrial` twice for one slot; `createForReplay` twice with one trial id | One row (`exists` the second time); one run | Task 7 `a trial moves through its states once`; Task 9 `a replay run is seeded and starts one implementer` |
| The trial rows of one job in any order (200 seeded shuffles, 3 tasks, 3 configurations, 3 slots) | `nextSlot` returns the same slot | Task 8 `the next slot does not depend on the order of the rows` |
| The owner cancels the job while the member runs, and while grading | `void-owner` once; a later grade writes nothing (`finishTrial` answers false) | Task 12 `cancel voids the running trial`; Task 7 `a trial moves through its states once` |
| A void trial, three times in one slot; three voids in a row in one job | No fourth attempt; the job pauses `trial-voids` | Task 8 `a void trial runs again at most twice`; Task 12 `three voids in a row pause the job` |
| An owner halt while the member runs | `void-owner`; the job waits `halt` | Task 9 `every member ending ends the trial with its name`; Task 12 `the job waits for every gate and says which` |
| The result operation completes after the trial ended | Nothing changes | Task 9 `a stopped replay run ignores late completions` |
| A validate job and a baseline job at once | One grader user at a time; no `stop` reaches the other's processes | Task 15 `validation and trials share the grader one step at a time` |
| `trialMinutes`, `eval.member`, a validation setting, or a prompt version changes during a job | `blocked` `configuration-changed` before the next trial; `resume` pins the new digest | Task 12 `a changed configuration blocks the job` |
| An unavailable store | No identity command runs; the tick throws nothing; the routes answer `503` `evidence-unavailable` | Task 15 `an unavailable store starts no trial` |
| A task payload that does not open; a trial payload that does not open | The task is skipped `unreadable` before any command; the live trial ends `void-host` | Task 11 `an unreadable task starts no trial`; Task 15 `a restart in the middle of a trial voids it` |
| The replay run's record is deleted while its member runs; the task's row is deleted during the trial | `void-host` within one step; the job moves past a task that is gone | Task 15 `a lost replay run voids its trial` |

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/eval-config.ts` (modify) | `trialsPerDay`, `trialMinutes`, `candidateProfiles`; the host `eval.member` block; `trialSettings`; `evalCommandPrefix` |
| `packages/host/src/eval-types.ts` (modify) | Trial configuration, ending, grade, state, the baseline request and view, waits, reasons, identity states, summary fields |
| `packages/host/src/team-types.ts` (modify, +2) | `ReplayLink` and `replay?: ReplayLink` on `TeamRun` |
| `packages/host/src/types.ts` (modify) | `LEARNING_PURPOSES` and `learningPurpose`, beside `SESSION_PURPOSES` |
| `packages/host/src/launch.ts` (modify) | `sessionAgentProfile`, `withoutSharedContext` |
| `packages/host/src/manager.ts` (modify, net 0) | Four in-place lines: the import, the fuse purpose, the profile, the context |
| `packages/host/src/fuse/rules.ts` (modify) | `workLaunch` takes a purpose |
| `packages/host/src/notifier.ts` (modify) | The session tick skips learning sessions |
| `packages/host/src/egress.ts` (modify) | The `_eval` and `_eval-setup` identities; `evalProxyUrl` |
| `packages/host/src/worker.ts` (modify, net 0) | One in-place line: the session purpose to `workerEgressEnvironment` |
| `scripts/egress-proxy.mjs` (modify, net 0) | Three in-place lines: the two labels, and eval identities get only their own lists |
| `deploy/ubuntu/eval-command.sh`, `eval-wrapper.sh`, `eval.sudoers`, `eval.nft` (create) | The eval launcher, the provider wrapper, the sudo rule, the network rule |
| `deploy/ubuntu/grader-command.sh` (modify) | Version 2: `export`, the input `result.patch`, `"version": 2` in the probe |
| `packages/host/src/eval-grader.ts` (modify) | `export`, the wider `GraderInput`, `GraderProbe.version` |
| `packages/host/src/eval-identity.ts` (create) | The eval launcher client, the probe and its states, the stop rounds, the canaries |
| `packages/host/src/eval-trial-store.ts` (create) | Evidence module `eval-trials`: trial rows, job counts, patches, the sweep |
| `packages/host/src/eval-trial-rules.ts` (create) | Pure: grades, the restore set, the next slot, the isolation label, ending maps |
| `packages/host/src/team-replay.ts` (create) | `TeamReplay`: seeding, prefixes, endings, settling, state |
| `packages/host/src/teams.ts` (modify, at most +27) | `createForReplay`, `replayState`, `endReplay`, `forgetReplay`, `replayIds`, and the hooks of Task 9 |
| `packages/host/src/config-identity.ts` (modify, net 0) | `memberConfiguration` takes `shape` |
| `tests/fixtures/trial-agent.mjs` (create) | A fake implementer with one mode per trial ending |
| `packages/host/src/outcome-projector.ts`, `outcome-signals.ts` (modify); `outcome-store.ts` (modify, net 0) | Source `replay`, `experiment_ref`, C5's unknown levels |
| `packages/host/src/eval-validate.ts` (modify, at most +6) | Export the grader steps that grading reuses |
| `packages/host/src/eval-trial.ts` (create) | The trial source and the grading of one trial |
| `packages/host/src/eval-jobs.ts` (modify, at most +27) | Validate reads skip baseline rows; baseline views and resume digests come from `TrialJobs` |
| `packages/host/src/eval-trial-jobs.ts` (create) | `TrialJobs`: the baseline schema, create, digest, gates, the next slot, records |
| `packages/host/src/eval-summary.ts`, `eval-routes.ts` (modify) | The identity state, today's trials, grader version, the baseline request and view |
| `packages/host/src/eval-cli.ts` (modify) | Status and job lines for trials |
| `packages/host/src/eval-trial-pump.ts` (create) | The trial pump: start-up, one step, the hourly sweep |
| `packages/host/src/eval-host.ts` (modify, at most +99) | Composition, the trial step in the validation chain, `create` by kind |
| `packages/host/src/server.ts` (modify, net 0) | Three in-place lines: the import, the `EvalHost` options, the session list |
| `tests/fixtures/eval-command.mjs` (create); `tests/fixtures/grader-command.mjs` (modify) | A same-user eval launcher; grader version 2 |
| `docs/teams.md`, `docs/security.md`, `deploy/ubuntu/eval.md` (create), `deploy/ubuntu/grader.md`, `deploy/ubuntu/egress.md`, the spec | Trials, the eval identity, its installs, the amendments |
| `tests/eval-{session,launcher,identity,trial-store,trial-rules,trial,trial-jobs,trial-run}.test.ts`, `tests/egress-eval.test.ts`, `tests/team-replay.test.ts`, `tests/outcome-replay.test.ts` (create); `tests/eval-config.test.ts`, `tests/routines.test.ts`, `tests/eval-grader.test.ts`, `tests/eval-grader-launcher.test.ts`, `tests/eval-routes.test.ts`, `tests/eval-cli.test.ts` (modify) | Pure rules, a real store, real Git, the fixture launchers, the host |

`teams.ts` grows from 5,707 to at most 5,734 lines, inside its baseline of 5,747 (Task 9 lists each line). `server.ts`, `manager.ts`, `worker.ts`, and `outcome-store.ts` change only in place and keep their baselines (2,282; 1,243; 1,900; 1,382). `scripts/egress-proxy.mjs` changes three lines in place (baseline 1,359). `client.ts`, `team-cli.ts`, `missions.ts`, `goals.ts`, `tests/teams.test.ts`, and `tests/goals.test.ts` do not change. Every new source file stays under 600 lines; `eval-host.ts` grows from 371 to at most 470, `eval-jobs.ts` from 463 to at most 490, `eval-validate.ts` from 435 to at most 441.

**Order and owners.** Task 1 runs first and alone. Then Tasks 2, 3, 4, 5, 6, 7, 8, 10, 14, and 16 run in parallel. Task 9 waits for Tasks 2, 3, and 6. Task 11 waits for Tasks 5, 6, 7, and 8. Task 12 waits for Tasks 7 and 8. Task 13 waits for Task 12. Task 15 waits for Tasks 9, 10, 11, 12, and 13. Each file has one writer: Task 1 alone writes `eval-config.ts`, `eval-types.ts`, `team-types.ts`, and `types.ts`; Task 2 alone `manager.ts`, `launch.ts`, `fuse/rules.ts`, and `notifier.ts` (each edit one to four lines); Task 9 alone `teams.ts`, `config-identity.ts`, and `tests/fixtures/trial-agent.mjs`; Task 11 alone `eval-validate.ts`; Task 12 alone `eval-jobs.ts`; Task 15 alone `server.ts` and `eval-host.ts`. Tasks 9, 11, and 12 build against each other's interfaces as fixed below, without talking.

## Review Focus

1. **A trial that sees what it must not**: a production launch profile for a learning session, a later commit or a hidden test in the workspace, a host credential in a command's environment, a file an earlier trial left in the home. Expect none. Task 2 `a learning session launches only as the eval identity`: deleting the learning branch of `sessionAgentProfile`, or restoring `this.config.agents[request.provider]` at `manager.ts:1099`, must fail it. Task 11 `the trial source holds only the base`: deleting the `identity.check` call in `prepareTrialSource` must fail it. Task 4 `prepare leaves only the base`: deleting `remote remove origin` in the launcher's `prepare` must fail it. Task 4 `the eval launcher starts commands with a fixed environment`: dropping `env -i` from `exec` must fail it. Task 4 `scrub resets the home to the template`: deleting the template copy in `scrub` must fail it.
2. **A replay run that acts on the world or shows itself**: publication, Linear, a push, the corpus capture sink, a GitHub grant, a client list, a permission coordinator, an owner question, a production fallback switch, a held-back routine. Expect none. Task 9 `a replay run reaches no client`: deleting the `!stored.run.replay` filter in `list()`, the `!run.replay` guard before `captureIntegrated`, or the purpose filter on `limits.reconcile`'s rows must fail it. Task 2 `no learning session reaches the owner's devices`: deleting the filter in `Notifier.tick` must fail it.
3. **A resolved grade without the report**: an exit code, a missing report, a result that rewrote the runner or a grading file. Expect not resolved, `expectedPassed` null when no report parses, and `overwritten` above 0. Task 8 `every ending grades as the design says`: deleting `expectedPassed !== null &&` in `gradeOf` must fail it. Task 11 `a grading path edit is overwritten`: dropping `gradingPaths` from `restoreSet` must fail it.
4. **Ledger contamination**: a replay row counted as production, a replay row with `accepted`, `firstPass`, or `held` set, a replay row in a routing read. Expect source `replay`, `experiment_ref` the trial id, null levels. Task 10 `a replay run writes replay rows`: deleting the purpose branch in `runCreated`, or the `row.source === "replay"` line in `saveOutcomeRow`, must fail it.
5. **Spend beyond the stand-in**: a trial after `maxTrials` or the day's cap, while its provider is limited, with fewer than four free slots, while halted, or a job that loops on voids. Expect a named wait or a completed job. Task 12 `a job starts no trial after its limits`: deleting the `daily-cap` gate line in `TrialJobs.next` must fail it. Task 12 `the job waits for every gate and says which`: deleting the `provider-limit` gate line must fail it.

### Task 1: the settings and the shared types

**Files:** `packages/host/src/eval-config.ts`, `packages/host/src/eval-types.ts`, `packages/host/src/team-types.ts` (+2), `packages/host/src/types.ts`, `tests/eval-config.test.ts`, `tests/routines.test.ts`. Runs first and alone. It may make compile-only fixes in `eval-cli.ts`, `eval-summary.ts`, `eval-routes.ts`, `eval-jobs.ts`, and `eval-host.ts` for the wider `EvalJobView` and `EvalSummary`, and reports each line.

**Interfaces (produces):**
```ts
// types.ts, beside SESSION_PURPOSES
export const LEARNING_PURPOSES: readonly SessionPurpose[] = ["replay", "gate"];
export function learningPurpose(purpose: SessionPurpose | undefined): boolean;

// eval-config.ts
export const TRIALS_PER_DAY_MAX = 50, TRIAL_MINUTES_DEFAULT = 45, TRIAL_MINUTES_MIN = 10, TRIAL_MINUTES_MAX = 240,
  CANDIDATE_PROFILES_MAX = 8, MEMBER_CANARIES_MAX = 32, EVAL_AGENT_ARGS_MAX = 64;
// evalProjectSchema gains, all optional:
//   trialsPerDay: z.number().int().min(1).max(TRIALS_PER_DAY_MAX)
//   trialMinutes: z.number().int().min(TRIAL_MINUTES_MIN).max(TRIAL_MINUTES_MAX)
//   candidateProfiles: z.array(teamModelProfileSchema).max(CANDIDATE_PROFILES_MAX)
const evalAgentSchema = z.object({          // the AgentProfile fields
  command: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(EVAL_AGENT_ARGS_MAX),
  appServerCommand: z.string().min(1).max(4096).optional(), appServerArgs: z.array(z.string().max(4096)).max(EVAL_AGENT_ARGS_MAX).optional(),
  workspaceDir: absolutePath.optional(), sharedWorkspace: z.boolean().optional(),
}).strict();
const evalMemberSchema = z.object({
  prefix: command,                     // the eval launcher
  root: absolutePath,                  // the launcher's ROOT; trials live in ROOT/trials
  agents: z.object({ claude: evalAgentSchema.optional(), codex: evalAgentSchema.optional(), opencode: evalAgentSchema.optional() }).strict(),
  canaries: z.array(absolutePath).max(MEMBER_CANARIES_MAX).optional(),
}).strict();
export const evalHostSchema = z.object({ grader: graderSchema.optional(), member: evalMemberSchema.optional() }).strict();
export type EvalMemberConfig = z.infer<typeof evalMemberSchema>;
export type TrialSettings = ValidationSettings & { trialsPerDay: number; trialMinutes: number; candidateProfiles: TeamModelProfile[] };
/** What a baseline job needs, or the first missing key in the order source, focusedTest, reportFormat, trialsPerDay. */
export function trialSettings(project: Parameters<typeof validationSettings>[0]):
  { settings: TrialSettings } | { missing: "source" | "focusedTest" | "reportFormat" | "trialsPerDay" };
/** `{ command: prefix.command, args: [...prefix.args, op, "--"] }`, the TeamCommand prefix of one launcher operation. Undefined without eval.member. */
export function evalCommandPrefix(member: EvalMemberConfig | undefined, op: "exec" | "setup"): TeamCommand | undefined;

// eval-types.ts
export type TrialConfiguration = { profile: TeamModelProfile; guidance: "as-of-base"; knowledge: "none" };
export const TRIAL_ENDINGS = ["graded", "no-result", "escalated", "question", "blocked", "permission", "stalled",
  "scope-violation", "timeout", "void-limit", "void-host", "void-owner"] as const;
export type TrialEnding = typeof TRIAL_ENDINGS[number];
export const VOID_ENDINGS: readonly TrialEnding[] = ["void-limit", "void-host", "void-owner"];
export type TrialGrade = {
  ending: TrialEnding;
  expectedPassed: number | null; expectedTotal: number;
  guardPassed: boolean | null;
  resolved: boolean;
  overwritten: number;
  diff: { added: number; removed: number; referenceAdded: number; referenceRemoved: number } | null;
  isolation: "isolated" | "none";
};
export type TrialState = "preparing" | "running" | "grading" | "final";
export type EvalIdentityState = "not-configured" | "unavailable" | "misconfigured" | "exposed" | "network-open" | "busy" | "ready";
export type BaselineJobRequest = {
  kind: "baseline";
  configurations: TrialConfiguration[];
  taskFilter?: { taskIds?: string[]; origins?: EvalOrigin[]; areas?: string[]; maxTasks?: number };
  trialsPerTask?: number;
  limits: { maxTrials: number; maxWallMinutes: number };
  windows?: { startHourUtc: number; endHourUtc: number }[];
  expiresAt?: string;
};
/** The current EvalJobView, renamed. */
export type ValidateJobView = { jobId: string; projectId: string | null; kind: "validate"; status: RoutineStatus; reason: EvalJobReason | null;
  waiting: EvalJobWait | null; createdAt: string; startedAt: string | null; expiresAt: string; finishedAt: string | null;
  counts: { visited: number; valid: number; rejected: number; retired: number; undecided: number } };
export type BaselineJobView = Omit<ValidateJobView, "kind" | "counts"> & {
  kind: "baseline";
  tasks: { planned: number; reached: number; skipped: number };
  trials: { planned: number; started: number; graded: number; resolved: number; ended: number; void: number };
  dailyCap: number | null;
};
export type EvalJobView = ValidateJobView | BaselineJobView;
// EvalJobReason gains "trial-voids" | "eval-processes-alive".
// EvalJobWait gains "eval-identity" | "provider-limit" | "session-slots" | "daily-cap".
// EvalRefusal's codes gain "profile-not-approved" (409).
// EvalSummary: grader { state } gains version: number | null; the summary gains
//   evalIdentity: { state: EvalIdentityState } and trials: { today: number; dailyCap: number | null }.
// EvalHostApi.create takes request: ValidateJobRequest | BaselineJobRequest.

// team-types.ts, beside missionId on TeamRun:
export type ReplayLink = { jobId: string; trialId: string; purpose: "replay" | "gate"; ending?: TrialEnding; resultCommit?: string; resetsAt?: string };
//   /** Set once by createForReplay. Stripped from every TeamView. */ replay?: ReplayLink;
```

**Decisions:**

- `trialSettings` returns `validationSettings`' answer when it misses a key, then requires `trialsPerDay`; `trialMinutes` defaults to 45 and `candidateProfiles` to `[]`.
- `eval.member.agents` admits Claude Code, Codex, and OpenCode only; Grok and Demo have no eval launch.
- `ValidateJobView` is the current `EvalJobView` unchanged; code that reads `counts` narrows on `kind`.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the trial settings parse with their limits` (`tests/eval-config.test.ts`) | `trialsPerDay` 0 and 51, `trialMinutes` 9 and 241, nine `candidateProfiles`: refused. `eval.member` with an unknown key, a relative `root`, or `agents.grok`: refused. `trialSettings` without `trialsPerDay`: `{ missing: "trialsPerDay" }`; with it: `trialMinutes` 45. `evalCommandPrefix(member, "setup")` ends its arguments with `"setup", "--"`. `learningPurpose("replay")` and `("gate")` are true; `("work")` and `(undefined)` false. |
| `trial settings leave the routine digest alone` (`tests/routines.test.ts`) | Adding `trialsPerDay`, `trialMinutes`, and `candidateProfiles` under `project.team.eval`, and `eval.member` to the host configuration, leaves `RoutineService.authority`'s digest unchanged, and an implementer's `teamPrompt` text unchanged. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-config.test.ts tests/routines.test.ts` and the typecheck.

### Task 2: the learning session in the Manager and the notifier

**Files:** `packages/host/src/launch.ts`, `packages/host/src/manager.ts` (net 0), `packages/host/src/fuse/rules.ts`, `packages/host/src/notifier.ts`, `tests/eval-session.test.ts`. Needs Task 1.

**Interfaces (produces):**
```ts
// launch.ts
/** eval.member.agents[provider] for a learning purpose, else config.agents[provider]. Throws TeamError 409
 * "eval-identity-missing" for a learning purpose without an eval profile for the provider. */
export function sessionAgentProfile(config: Pick<Config, "agents" | "eval">, provider: Provider, purpose: SessionPurpose | undefined): AgentProfile | undefined;
/** For a learning purpose, the snapshot with `text: ""` and `sources: []`: today's text is not the text of the work's time. */
export function withoutSharedContext<T extends { text: string; sources: readonly unknown[] }>(context: T, purpose: SessionPurpose | undefined): T;
// fuse/rules.ts: workLaunch's input gains `purpose?: SessionPurpose`; the result's purpose is `input.purpose ?? "work"`.
```

**Decisions:** `manager.ts`, all its lines in this slice, each in place, inside `createRecorded`, where `request.purpose` is already set (line 1110):
- Line 36, `import { missionCoordinatorLaunch, permissionCoordinatorLaunch, teamModelLaunch } from "./launch.js";`, adds `sessionAgentProfile` and `withoutSharedContext`.
- Line 1091, `workLaunch({ launchId: id, projectId: request.projectId, provider: request.provider, team: request.team, profile: request.teamModelProfile })`, adds `purpose: request.purpose`.
- Line 1099, `const configuredProfile = this.config.agents[request.provider];`, becomes `const configuredProfile = sessionAgentProfile(this.config, request.provider, request.purpose);`. Line 1100's "Provider is not configured" check stays.
- Line 1105, `const context = new ProjectContexts(this.config, this.key).snapshot(request.projectId);`, becomes `const context = withoutSharedContext(new ProjectContexts(this.config, this.key).snapshot(request.projectId), request.purpose);`. With empty text, line 1161's `Shared project context` block is not rendered.

`teamModelLaunch` applies the model selection to the eval profile as to the production one, so the eval wrapper receives the same model flags. The worker receives the chosen profile (`worker.ts` line 86), so `drainLaunch` derives the drain from the eval wrapper's directory: `eval/transcript-drain`, as the eval account.

`notifier.ts` line 93, `const rows = (await this.manager.list()) as unknown as Row[];`, becomes a list filtered by `!learningPurpose(row.purpose)`, plus its import line. The team lifecycle rows already come from `teams.statuses()`, which Task 9 filters.

- [ ] **Step 1: Write the failing tests** in `tests/eval-session.test.ts`, with a real Manager, a temporary state directory, and fake agent scripts as both profiles.

| Test name | Assertions |
|---|---|
| `a learning session launches only as the eval identity` | `createTeamSession(…, { purpose: "replay" })` with `eval.member.agents.claude` set: the worker spawns the eval profile's command, never `config.agents.claude`'s. Without `eval.member`: `409` `eval-identity-missing`, and no session directory exists. Purpose `work` with `eval.member` set: the production command. The fuse's launch row records purpose `replay`. |
| `a learning session gets no shared project context` | With a project context set: a `replay` session's `initialPrompt` holds no `Shared project context`, and its `contextSources` is empty; a `work` session's holds both. |
| `no learning session reaches the owner's devices` | A `Notifier` over a fake manager that lists a `replay` session and a `work` session, both in `needs-you`, one registered device, and a recording sender: one message, for the `work` session. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-session.test.ts tests/fuse-rules.test.ts tests/push.test.ts`, `node scripts/check-file-size.mjs`, and the typecheck.

### Task 3: the eval egress identities

**Files:** `packages/host/src/egress.ts`, `packages/host/src/worker.ts` (net 0), `scripts/egress-proxy.mjs` (net 0), `tests/egress-eval.test.ts`. Needs Task 1.

**Interfaces (produces):**
```ts
export const EVAL_EGRESS_PROJECT = "_eval", EVAL_SETUP_EGRESS_PROJECT = "_eval-setup",
  EVAL_SETUP_CREDENTIAL_SECONDS = 900, EVAL_PROBE_CREDENTIAL_SECONDS = 60;
export function sessionEgressIdentity(projectId: string | undefined, sessionId: string, purpose?: SessionPurpose): EgressIdentity;
export function workerEgressEnvironment(projectId: string | undefined, sessionId: string, env?: NodeJS.ProcessEnv, nowMs?: number, purpose?: SessionPurpose):
  { status: "off" | "on" | "no-key" | "invalid"; env: Record<string, string> };
/** The proxy URL with a fresh credential for an eval identity, from the state installHostEgress set up: undefined without
 *  the boundary; the URL with no credential (every request refused) when the key cannot be read. */
export function evalProxyUrl(project: "_eval" | "_eval-setup", session: string, lifetimeSeconds: number, nowMs?: number): string | undefined;
```

**Decisions:**
- `sessionEgressIdentity` returns `{ project: "_eval", session }` when `learningPurpose(purpose)`. `egress.ts` line 26, `EGRESS_PROJECT`, admits `_eval` and `_eval-setup` in place.
- `worker.ts` line 1672, `const egress = workerEgressEnvironment(session.projectId, session.id);`, becomes `const egress = workerEgressEnvironment(session.projectId, session.id, process.env, Date.now(), session.purpose);`.
- `scripts/egress-proxy.mjs`, each in place: line 17, `PROJECT_LABEL`, and line 18, `CREDENTIAL`, add `_eval|_eval-setup` beside `_host|_none`. Line 903, `const listed = listedIn(current.allow, target) || listedIn(current.projects.get(identity.project), target);`, becomes `const listed = (!identity.project.startsWith("_eval") && listedIn(current.allow, target)) || listedIn(current.projects.get(identity.project), target);`. In `observe` mode the proxy still allows and records; the probe's fetch then succeeds, and trials are labelled `none`.

- [ ] **Step 1: Write the failing test** in `tests/egress-eval.test.ts`.

| Test name | Assertions |
|---|---|
| `an eval session leaves the network only for its own list` | Policy `{ mode: "enforce", allow: ["registry.example"], projects: { _eval: { allow: ["api.example"] }, "_eval-setup": { allow: ["packages.example"] } } }`: an `_eval` credential reaches `api.example` and is refused `registry.example` and `packages.example`; an `_eval-setup` credential reaches only `packages.example`, and is refused once its 900 seconds have passed; a project credential reaches `registry.example`. Without `projects._eval`, an `_eval` credential reaches nothing. `workerEgressEnvironment(…, "replay")` mints identity `_eval`; `"work"` keeps the project. |

- [ ] **Step 2: Run the test and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/egress-eval.test.ts tests/egress-proxy.test.ts` and `node scripts/check-file-size.mjs`.

### Task 4: the eval launcher template

**Files:** `deploy/ubuntu/eval-command.sh`, `deploy/ubuntu/eval-wrapper.sh`, `deploy/ubuntu/eval.sudoers`, `deploy/ubuntu/eval.nft`, `tests/eval-launcher.test.ts`. Needs Task 1.

**Interfaces (produces):** the launcher's argument contract, which Task 6's fixture also follows:
```text
eval-command probe [--fetch URL] -- [CANARY...]   # with --fetch, stdin's first line is the proxy URL or empty; JSON on stdout, at most 4 KiB
eval-command receive TRIAL MAXBYTES               # stdin to ROOT/trials/TRIAL/in/base.bundle
eval-command prepare TRIAL                        # the trial clone in ROOT/trials/TRIAL/work
eval-command check TRIAL -- OBJECT...             # 0: no object exists and `git remote` prints nothing; 1: otherwise
eval-command exec -- COMMAND [ARG...]             # in the caller's cwd, under ROOT/trials/TRIAL/work; a fixed environment
eval-command setup -- COMMAND [ARG...]            # as exec, plus the proxy URL from stdin's first line; the child's stdin is /dev/null
eval-command stop                                 # every process of the account, then its files in /tmp, /var/tmp, /dev/shm
eval-command clean                                # every entry of ROOT/trials
eval-command scrub                                # the home reset to TEMPLATE, keeping LOGIN_PATHS
TRIAL   ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$
OBJECT  ^[0-9a-f]{40}$|^[0-9a-f]{64}$, at most 200
```

**Decisions:**
- **Constants** at the top, edited at install: `ROOT=/var/lib/infinite-eval/root`, `ACCOUNT=infinite-eval`, `EVAL_HOME=/var/lib/infinite-eval/home`, `TEMPLATE=/usr/local/share/infinite-eval/home`, and `LOGIN_PATHS`, relative to `EVAL_HOME`: `.claude/.credentials.json`, `.codex/auth.json`, `.local/share/opencode/auth.json`. Every operation first checks `[ "$(/usr/bin/id -un)" = "$ACCOUNT" ]` and a non-root caller, and exits 64 otherwise. `PATH=/usr/bin:/bin`; tools by absolute path; `umask 077`. `ROOT` must be a directory of mode `0711` owned by the caller.
- **Modes.** `ROOT/trials`, `ROOT/trials/TRIAL`, and `ROOT/trials/TRIAL/work` are `0711`, so the host can resolve and enter the member's working directory without listing it; everything else is `0700` or `0600`.
- **`prepare`**: `git clone --quiet --template= --no-checkout --branch trial -- in/base.bundle work`; `git -C work remote remove origin`; `git -C work -c advice.detachedHead=false checkout --quiet --detach trial`; `git -C work branch -D trial`; `rm -rf in`; `chmod 0711 work`. Git runs with `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1`, 600 seconds.
- **`check`** runs `git -C work cat-file -e OBJECT` for each object and `git -C work remote`; 60 seconds.
- **`exec`** resolves `realpath -e .`, requires `ROOT/trials/TRIAL/work` or below it, and runs the command as `env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=$EVAL_HOME TMPDIR=ROOT/trials/TRIAL/tmp LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1`, under `prlimit --nproc=512 --fsize=4294967296 --core=0 --nofile=4096` and `timeout --kill-after=10 3600`, and exits with the child's status (124 at the limit). Team commands pass their Git identity as `-c` arguments (`team-workspace.ts` line 33), so the fixed environment keeps commits working. **`setup`** reads stdin's first line (at most 2 KiB), and when it is not empty adds `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, and `http_proxy` with that value, `NO_PROXY` and `no_proxy` set to `localhost,127.0.0.1,::1`, and `NODE_USE_ENV_PROXY=1` (ruling 10).
- **`probe`** prints `{ version: 1, uid, root, rootMode, rootOwner, readable: boolean[], metadata, freeBytes, freeInodes, ancestorsWritable, tools, trials, leftovers, fetch }`. `trials` counts the entries of `ROOT/trials`. `leftovers` counts the paths under `EVAL_HOME` that are neither a `LOGIN_PATHS` entry, a directory on the way to one, nor a `TEMPLATE` path, plus the `TEMPLATE` files whose bytes differ (`cmp`), reading at most 10,000 paths and answering 10,000 past that. `fetch` is `skipped` without `--fetch`, else `open` when `timeout 15 git ls-remote --exit-code -- URL HEAD` succeeds once with no proxy variable or once with the stdin proxy URL, and `refused` otherwise.
- **`stop`** is the grader's: `kill -KILL -1`, one second, then `find -xdev -user` removal in `/tmp`, `/var/tmp`, `/dev/shm`. **`clean`** removes every entry of `ROOT/trials`, 600 seconds. **`scrub`** removes every path under `EVAL_HOME` except `LOGIN_PATHS`, then `cp -R TEMPLATE/. EVAL_HOME/`; 60 seconds. The owner builds `TEMPLATE` after the eval logins (see "Owner approvals"), so provider settings, hooks, MCP servers, skills, and memory files return to the owner's choice before every trial.
- **`eval-wrapper.sh`**, installed as `/usr/local/libexec/infinite/eval/{claude,codex,codex-app-server,opencode}`: `agent-wrapper.sh` without `agent-env.sh`, the pnpm store, and the corepack cache, with `TMPDIR=/var/lib/infinite-eval/tmp`, and `unset INFINITE_GITHUB_GRANT INFINITE_GITHUB_PROXY` first. The Claude trust step and the Codex `--no-daemon` stay.
- **`eval.sudoers`**, installed as `/etc/sudoers.d/infinite-eval`: `Defaults!/usr/local/libexec/infinite/eval-command !env_keep` (a command default, applied after the `infinite-host` user default, so the launcher receives none of the host's variables, including the `_host` proxy credential that `teamCommandEnvironment` adds); `infinite-host ALL=(infinite-eval) NOPASSWD: /usr/local/libexec/infinite/eval-command`; `infinite-host ALL=(infinite-eval) NOPASSWD: /usr/local/libexec/infinite/eval/claude *, /usr/local/libexec/infinite/eval/codex *, /usr/local/libexec/infinite/eval/codex-app-server *, /usr/local/libexec/infinite/eval/opencode *`; `infinite-host ALL=(infinite-eval) NOPASSWD: /usr/local/libexec/infinite/eval/transcript-drain ""`. `infinite.sudoers` does not change; its `Defaults:infinite-host env_keep` lists already carry the session's hook and `_eval` proxy variables to the wrappers.
- **`eval.nft`**: one table that accepts the eval account's output on `lo` and rejects the rest, IPv4 and IPv6. Its header says it requires `autonomy.boundary.egress`, because without the proxy the provider is unreachable.

- [ ] **Step 1: Write the failing tests** in `tests/eval-launcher.test.ts`. They run the real script, copied into a temporary directory with `ROOT`, `ACCOUNT`, `EVAL_HOME`, and `TEMPLATE` rewritten to the current user's temporary paths, and skip off Linux and as root. They never call `stop` with `ACCOUNT` rewritten.

| Test name | Assertions |
|---|---|
| `the eval launcher starts commands with a fixed environment` | With `INFINITE_HOOK_TOKEN`, `INFINITE_GITHUB_GRANT`, and `HTTPS_PROXY` set by the caller: `exec -- /usr/bin/env` in a trial's `work` prints exactly the fixed list. `setup -- /usr/bin/env` with stdin `http://u:p@127.0.0.1:9/` prints the fixed list plus the four proxy variables with that value, `NO_PROXY`, `no_proxy`, and `NODE_USE_ENV_PROXY=1`; with an empty stdin line, the fixed list. |
| `the eval launcher confines every operation to its root` | `exec` with a cwd outside `ROOT/trials/*/work`, `receive` with a TRIAL that is not a UUID, `check` with an object that is not hex, and a `work` replaced by a link: exit 64, nothing written outside the root. `clean` leaves `ROOT/trials` empty. |
| `scrub resets the home to the template` | A home with `.claude/.credentials.json`, a changed `.claude/settings.json`, a new `.claude/skills/x/SKILL.md`, and `.claude/projects/p/1.jsonl`, and a template with the original `.claude/settings.json`: after `scrub`, the credentials file is unchanged, the settings file equals the template's, and the other two are gone; `probe` reports `leftovers` 0 before and 2 after a planted file and a changed template file. |
| `prepare leaves only the base` | From a repository where C2 follows C1, a bundle of branch `trial` at C1. After `receive` and `prepare`: `check TRIAL -- C2` exits 0, `git remote` prints nothing, and `in/` is gone. After the test fetches C2 into `work` by path: `check TRIAL -- C2` exits 1. |
| `stop refuses another account` | `stop` with `ACCOUNT` set to another name exits 64, and a `sleep` the test started still runs. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-launcher.test.ts` on a Linux host; the coordinator runs it in a Linux container as a non-root user and records the result.

### Task 5: the grader launcher, version 2

**Files:** `deploy/ubuntu/grader-command.sh`, `packages/host/src/eval-grader.ts`, `tests/fixtures/grader-command.mjs`, `tests/eval-grader-launcher.test.ts`, `tests/eval-grader.test.ts`. Needs Task 1.

**Interfaces (produces):**
```text
grader-command export JOB      # stdout: `git bundle create - refs/heads/trial` in ROOT/jobs/JOB/work/task; 600 seconds
NAME   base.bundle | base-delta.patch | reference.patch | result.patch
probe  JSON gains "version": 2
```
```ts
export const EXPORT_SECONDS = 600;
export type GraderInput = "base.bundle" | "base-delta.patch" | "reference.patch" | "result.patch";
export type GraderProbe = { state: GraderState; uid?: number; storage?: boolean; version?: number };
// Grader gains:
export(job: string, sink: Writable, maxBytes: number): Promise<"exported" | "too-large" | "failed">;
```

**Decisions:** `export` runs under the launcher's `run` environment and limits, from `work/task`, and refuses when `refs/heads/trial` is missing (exit 2). The client counts bytes and destroys the stream past `maxBytes`. A version 1 probe has no `version`; the client reports it undefined, and validation runs as before.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the grader exports only the trial branch` (launcher, Linux) | After `run` makes `refs/heads/trial` at C1 in `task`, whose clone also holds C2: `export JOB` writes a bundle whose `git bundle list-heads` shows only `refs/heads/trial`, and a clone of it lacks C2. `receive JOB result.patch 10` stores 10 bytes. `probe` prints `"version":2`. |
| `export keeps its limit` (client, fixture) | An export over a shortened `maxBytes`: `too-large`, and the sink got at most `maxBytes`. A version 1 fixture probe: `version` undefined. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-grader.test.ts`, and `tests/eval-grader-launcher.test.ts` on a Linux host.

### Task 6: the eval identity client

**Files:** `packages/host/src/eval-identity.ts`, `tests/fixtures/eval-command.mjs`, `tests/eval-identity.test.ts`. Needs Task 1; the launcher contract is fixed in Task 4.

**Interfaces (produces):**
```ts
export const EVAL_PROBE_SECONDS = 45, EVAL_RECEIVE_SECONDS = 600, EVAL_PREPARE_SECONDS = 600, EVAL_CHECK_SECONDS = 60, EVAL_STOP_SECONDS = 30,
  EVAL_CLEAN_SECONDS = 600, EVAL_SCRUB_SECONDS = 60, EVAL_GRACE_MS = 30_000, EVAL_PROBE_MAX = 4_096,
  EVAL_FREE_BYTES_MIN = 10_737_418_240, EVAL_FREE_INODES_MIN = 200_000, CHECK_OBJECTS_MAX = 200;
export type EvalProbe = { state: EvalIdentityState; uid?: number; storage?: boolean; fetch?: "refused" | "open" | "skipped" };
export interface EvalIdentity {
  probe(input: { canaries: readonly string[]; graderUid?: number; fetchUrl?: string; proxyUrl?: string }): Promise<EvalProbe>;
  receive(trial: string, input: Readable, maxBytes: number): Promise<"stored" | "too-large" | "failed">;
  prepare(trial: string): Promise<"ready" | "failed">;
  check(trial: string, objects: readonly string[]): Promise<"clean" | "leaked" | "failed">;
  teamPrefix(): TeamCommand | undefined;    // evalCommandPrefix(member, "exec")
  setupPrefix(): TeamCommand | undefined;   // evalCommandPrefix(member, "setup")
  stop(): Promise<boolean>;
  clean(): Promise<boolean>;
  scrub(): Promise<boolean>;
}
export function launcherEvalIdentity(config: () => EvalMemberConfig | undefined, options?: { hostUid?: number; graceMs?: number }): EvalIdentity;
/** Up to three rounds of stop and inventory, one second apart. */
export function stopEvalIdentity(identity: EvalIdentity, uid: number, inventory?: () => Promise<RuntimeProcess[]>): Promise<"stopped" | "alive" | "failed">;
/** The evidence database, keyFile, stateDir, runDir, teams.workspaceDir, each GitHub mirror, each project path, eval.grader.root, then eval.member.canaries. */
export function evalCanaries(config: Config, source: Pick<ProjectSourceService, "mirrorPath">): string[];
/** `config.source.remoteOverrides[projectId]`, else `https://github.com/REPOSITORY.git`. */
export function repositoryUrl(config: Pick<Config, "source">, projectId: string, repository: string): string;
```

**Decisions:**
- **Spawning** follows `launcherGrader`: no shell; env `PATH` and `LANG` only; the probe's proxy URL goes on stdin, never in an argument or the environment; one call at a time except `stop`; a call that outlives its limit plus 30 seconds is `failed` and holds the channel until the child closes.
- **The probe's states**, in this order: no `eval.member`: `not-configured`; a launcher failure or output that does not parse: `unavailable`; `uid` equal to the host's, to 0, or to `graderUid`, `root` other than the configured one, `rootOwner` other than `uid`, `rootMode` other than `711`, `ancestorsWritable`, or `tools` false: `misconfigured`; any readable canary: `exposed`; `metadata` `open`: `network-open`; `trials` or `leftovers` above 0: `busy`; otherwise `ready`, with `storage` (the free-space minimums) and `fetch`.
- **`stopEvalIdentity`** is `stopGrader`'s rule for the eval uid. The host runs `stop` only after a probe in this process answered a state other than `not-configured`, `unavailable`, or `misconfigured`.
- **The fixture** takes `--root DIR --uid N --home DIR --template DIR --metadata open|closed --fetch open|refused --record FILE` before the operation, implements every operation as the current user, records each argv line, and runs `exec` and `setup` in their cwd after the same path check.

- [ ] **Step 1: Write the failing tests** in `tests/eval-identity.test.ts`, with the fixture.

| Test name | Assertions |
|---|---|
| `the eval probe names every unsafe state` | No config: `not-configured`. A prefix that exits 1: `unavailable`. `--uid` equal to the host's or to `graderUid`, mode `0700`, a writable ancestor: `misconfigured`. A readable canary: `exposed` (mode `0000` passes; skipped as root). `--metadata open`: `network-open`. One entry in `trials`, or a planted file in the home: `busy`. Otherwise `ready`; `--fetch open` gives `ready` with `fetch: "open"`. The recorded probe line never holds the proxy URL. |
| `a surviving eval process blocks trials` | An inventory that keeps one row of the eval uid: `alive` after three stops. One that empties after the second: `stopped`. |
| `replay commands run only through exec and setup` | `teamCommand({ command: "git", args: ["status"] }, work, …, identity.teamPrefix())` records `exec -- git status` with cwd `work`; `identity.setupPrefix()` records `setup -- …`; a cwd outside the trials root is refused. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-identity.test.ts` and the typecheck.

### Task 7: the trial store

**Files:** `packages/host/src/eval-trial-store.ts`, `tests/eval-trial-store.test.ts`. Needs Task 1.

**Interfaces (produces):**
```ts
export const EVAL_TRIALS_MODULE = "eval-trials", TRIAL_KEEP_DAYS_DEFAULT = 365, TRIAL_PATCH_KEEP_DAYS = 90,
  TRIAL_PATCH_MAX_BYTES = 1_048_576, TRIAL_PATCHES_HOST_MAX_BYTES = 268_435_456, TRIAL_SWEEP_BATCH = 100, LIVE_TRIALS_MAX = 8;
export const SCHEMA_TRIALS_V1 = [
  `CREATE TABLE IF NOT EXISTS eval_trials (trial_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, task_id TEXT NOT NULL, project_ref TEXT NOT NULL,
    config_ref TEXT NOT NULL, config_id TEXT, profile_epoch INTEGER, harness INTEGER NOT NULL, slot INTEGER NOT NULL, attempt INTEGER NOT NULL,
    state TEXT NOT NULL, ending TEXT, resolved INTEGER, isolation TEXT, session_id TEXT, created_at TEXT NOT NULL, started_at TEXT,
    ended_at TEXT, expires_at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE (job_id, task_id, config_ref, slot, attempt))`,
  "CREATE INDEX IF NOT EXISTS eval_trials_job ON eval_trials (job_id, task_id, config_ref, slot, attempt)",
  "CREATE INDEX IF NOT EXISTS eval_trials_live ON eval_trials (state, created_at) WHERE state != 'final'",
  "CREATE INDEX IF NOT EXISTS eval_trials_project_day ON eval_trials (project_ref, created_at)",
  "CREATE INDEX IF NOT EXISTS eval_trials_expiry ON eval_trials (expires_at)",
  "CREATE INDEX IF NOT EXISTS eval_trials_sessions ON eval_trials (ended_at) WHERE session_id IS NOT NULL",
  `CREATE TABLE IF NOT EXISTS eval_trial_counts (job_id TEXT PRIMARY KEY, planned_tasks INTEGER NOT NULL, planned_trials INTEGER NOT NULL,
    tasks INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL DEFAULT 0, graded INTEGER NOT NULL DEFAULT 0,
    resolved INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0, voided INTEGER NOT NULL DEFAULT 0, void_streak INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS eval_trial_patches (trial_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, stored_at TEXT NOT NULL, expires_at TEXT NOT NULL, payload TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS eval_trial_patches_expiry ON eval_trial_patches (expires_at)",
  "CREATE TABLE IF NOT EXISTS eval_trial_totals (id INTEGER PRIMARY KEY CHECK (id = 1), patch_bytes INTEGER NOT NULL)",
];
export const LIVE_TRIALS_SQL = "SELECT trial_id, job_id, task_id, state FROM eval_trials WHERE state != 'final' ORDER BY state, created_at LIMIT 8";
export const JOB_SLOTS_SQL = "SELECT task_id, config_ref, slot, attempt, state, ending FROM eval_trials WHERE job_id = ? AND task_id = ?";
export const JOB_TRIALS_SQL = "SELECT count(*) AS n FROM eval_trials WHERE job_id = ?";
export const PROJECT_DAY_SQL = "SELECT count(*) AS n FROM eval_trials WHERE project_ref = ? AND created_at >= ?";
export const TRIALS_EXPIRED_SQL = "SELECT trial_id FROM eval_trials WHERE expires_at < ? ORDER BY expires_at LIMIT ?";
export const PATCHES_EXPIRED_SQL = "SELECT trial_id, bytes FROM eval_trial_patches WHERE expires_at < ? ORDER BY expires_at LIMIT ?";
export const TRIAL_SESSIONS_SQL = "SELECT trial_id, session_id FROM eval_trials WHERE session_id IS NOT NULL AND ended_at < ? ORDER BY ended_at LIMIT ?";
export type TrialPayload = { projectId: string; taskId: string; configuration: TrialConfiguration;
  probes?: { fetch: "refused" | "open" | "skipped"; sourceClean: boolean }; grade?: TrialGrade;
  patch?: "stored" | "too-large" | "secret-shaped" | "dropped" };
export type TrialRow = { trialId: string; jobId: string; taskId: string; projectRef: string; configRef: string; configId: string | null;
  profileEpoch: number | null; harness: number; slot: number; attempt: number; state: TrialState; ending: TrialEnding | null;
  resolved: boolean | null; isolation: "isolated" | "none" | null; createdAt: string; startedAt: string | null; endedAt: string | null; payload: TrialPayload };
export type NewTrial = Pick<TrialRow, "trialId" | "jobId" | "taskId" | "configRef" | "harness" | "slot" | "attempt"> &
  { projectId: string; configuration: TrialConfiguration; keepDays: number };
export type TrialFinal = { grade: TrialGrade; configId: string | null; profileEpoch: number | null; sessionId: string | null;
  probes?: TrialPayload["probes"]; patch?: Buffer | "too-large" | "secret-shaped"; patchKeepDays: number };
export type TrialCounts = { plannedTasks: number; plannedTrials: number; tasks: number; skipped: number;
  started: number; graded: number; resolved: number; ended: number; void: number; voidStreak: number };
export function evalTrialsModule(store: EvidenceStore, now: () => string): EvidenceModule;
export function openTrialCounts(tx: EvidenceTx, jobId: string, planned: { tasks: number; trials: number }): void;
export function insertTrial(tx: EvidenceTx, trial: NewTrial, at: string): "inserted" | "exists";
export function dropTrial(tx: EvidenceTx, trialId: string): boolean;                         // only a `preparing` row
export function startTrial(tx: EvidenceTx, trialId: string, at: string): boolean;            // preparing → running
export function gradingTrial(tx: EvidenceTx, trialId: string, at: string): boolean;          // running → grading
export function finishTrial(tx: EvidenceTx, trialId: string, final: TrialFinal, at: string): boolean;   // running or grading → final
export function advanceTask(tx: EvidenceTx, jobId: string, skipped: boolean): void;          // tasks + 1, and skipped + 1 when skipped
export function clearTrialSession(tx: EvidenceTx, trialId: string): void;
export function readTrial(db: EvidenceDb, trialId: string): TrialRow | undefined;            // throws EvidenceError "unreadable" for a payload that does not open
export function liveTrials(db: EvidenceDb): Pick<TrialRow, "trialId" | "jobId" | "taskId" | "state">[];
export function jobSlots(db: EvidenceDb, jobId: string, taskId: string): SlotRow[];
export function jobTrialCount(db: EvidenceDb, jobId: string): number;
export function trialsSince(db: EvidenceDb, projectRef: string, since: string): number;
export function trialCounts(db: EvidenceDb, jobIds: readonly string[]): Map<string, TrialCounts>;   // one statement, primary key, at most 100 ids
export function trialSessions(db: EvidenceDb, endedBefore: string, limit: number): { trialId: string; sessionId: string }[];
export function sweepTrials(tx: EvidenceTx, now: string): number;
```

**Decisions:**
- `project_ref` is `tx.index("project", projectId)`; `config_ref` is `configRef(configuration)` (Task 8); `expires_at` is `created_at` plus `keepDays`, the project's `retentionDays ?? 365`. The payload is sealed with context `eval-trial:TRIAL`; a patch with `eval-trial-patch:TRIAL`. `session_id` holds an id only.
- `finishTrial` writes only from `running` or `grading`. In one transaction it sets `state` `final`, `ending`, `resolved`, `isolation`, `config_id`, `profile_epoch`, `session_id`, `ended_at`, the payload's grade and probes, and the counters: `graded`, and `resolved` when resolved, for `graded`; `ended` for the other non-void endings; `voided` for void endings. `void_streak` grows by 1 on a void and returns to 0 otherwise. A patch is stored when it is a buffer of at most 1 MiB and the host total stays at or under 256 MiB; otherwise the payload says `too-large` or `dropped`. `started` grows in `startTrial`. `dropTrial` changes no counter.
- `sweepTrials` deletes at most 100 expired trials and 100 expired patches per call, keeps `eval_trial_totals` exact, and deletes at most 100 `eval_trial_counts` rows whose job is gone from `eval_jobs`.

- [ ] **Step 1: Write the failing tests** in `tests/eval-trial-store.test.ts`, on a real store.

| Test name | Assertions |
|---|---|
| `trial rows keep every text sealed` | A trial whose capsule objective is `Objective-7f3a` and whose patch holds `secret-name`: no plain column of the four tables contains either string or a profile model name. |
| `a trial moves through its states once` | `insertTrial` twice: `inserted`, then `exists`. `dropTrial` removes a `preparing` row and refuses a `running` one. `startTrial`, `gradingTrial`, `finishTrial`: true each; a second `finishTrial`: false, and the row is unchanged. The counters match each step; three voids give `voidStreak` 3, a graded trial after them 0. |
| `the patch caps hold` | A patch of 1 MiB plus 1 byte: `too-large`, no patch row. With the total at 256 MiB minus 10 bytes, a 20-byte patch: `dropped`. The total equals the sum of `bytes` after a sweep. |
| `the hot statements read through an index` | `EXPLAIN QUERY PLAN` of `LIVE_TRIALS_SQL`, `JOB_SLOTS_SQL`, `JOB_TRIALS_SQL`, `PROJECT_DAY_SQL`, `TRIALS_EXPIRED_SQL`, `PATCHES_EXPIRED_SQL`, and `TRIAL_SESSIONS_SQL` uses `eval_trials_live`, `eval_trials_job`, `eval_trials_job`, `eval_trials_project_day`, `eval_trials_expiry`, `eval_trial_patches_expiry`, and `eval_trials_sessions`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-trial-store.test.ts` and the typecheck.

### Task 8: the trial rules

**Files:** `packages/host/src/eval-trial-rules.ts`, `tests/eval-trial-rules.test.ts`. Needs Task 1. Pure, no I/O.

**Interfaces (produces):**
```ts
export const TRIAL_HARNESS_VERSION = 1, VOID_ATTEMPTS_MAX = 3, VOID_STREAK_PAUSE = 3;
export type SlotRow = { taskId: string; configRef: string; slot: number; attempt: number; state: TrialState; ending: TrialEnding | null };
export type GradeFacts = {
  ending: TrialEnding;              // "graded" when a grading round ran
  expected: readonly string[];      // the task's expectedCases
  report?: ParsedReport;            // eval-report.ts; absent: no parsed report after two rounds
  guard?: "passed" | "failed";      // absent: not run
  overwritten: number; diff: TrialGrade["diff"]; isolation: "isolated" | "none";
};
export function gradeOf(facts: GradeFacts): TrialGrade;
export function restoreSet(input: { referenceChanged: readonly string[]; resultChanged: readonly string[]; hiddenFiles: readonly string[];
  gradingPaths: readonly string[]; testPath: (path: string) => boolean }): { restore: string[]; overwritten: number };
/** The first slot in task order, then slot, then configuration order, with no final non-void row and fewer than three attempts. */
export function nextSlot(input: { tasks: readonly string[]; configRefs: readonly string[]; trialsPerTask: number; rows: readonly SlotRow[] }):
  { taskId: string; configRef: string; slot: number; attempt: number } | undefined;
export function isolationLabel(input: { probe: EvalProbe; sourceClean: boolean }): "isolated" | "none";
/** SHA-256 hex of the canonical JSON of profileIdentityKey(profile), guidance, and knowledge. */
export function configRef(configuration: TrialConfiguration): string;
/** "task-scope-violation" → scope-violation; "missing-agent-report" → no-result; "halted" → void-owner; any other code → void-host. */
export function endingOfBlock(code: string | undefined): TrialEnding;
export function endingOfReport(kind: "question" | "blocked" | "escalate"): TrialEnding;   // question, blocked, escalated
```

**Decisions:**
- **`gradeOf`**: for an ending other than `graded`, `expectedPassed` null, `guardPassed` null, `resolved` false. For `graded`: `expectedTotal` is `expected.length`; `expectedPassed` is the count of `expected` keys that the parsed report passes, or null without a parsed report; `guardPassed` is `guard === "passed"`, or null when absent; `resolved` is `expectedPassed !== null && expectedPassed === expectedTotal && expectedTotal > 0 && guardPassed === true`.
- **`restoreSet`**: `restore` is the sorted union of `hiddenFiles` and every name in `referenceChanged ∪ resultChanged` that `testPath` accepts or that a grading path covers (equal, or under it plus `/`). `overwritten` is the count of `resultChanged` names in `restore`.
- **`isolationLabel`** is `isolated` only when `probe.state` is `ready`, `probe.fetch` is `refused`, and `sourceClean` is true.

- [ ] **Step 1: Write the failing tests** in `tests/eval-trial-rules.test.ts`.

| Test name | Assertions |
|---|---|
| `every ending grades as the design says` | E `{a, b}`: a report passing both and guards `passed`: resolved, 2 of 2. Guards `failed`: not resolved, `guardPassed` false. A report passing only `a`: 1 of 2, `guardPassed` null. No report: `expectedPassed` null, not resolved. Ending `timeout`: null, null, not resolved. E empty: never resolved. `endingOfBlock("missing-agent-report")` is `no-result`; an unknown code `void-host`. |
| `the restore set takes tests and grading paths from the reference` | Reference changed `src/a.js`, `tests/a.test.js`; result changed `src/a.js`, `package.json`, `tests/b.test.js`; hidden `tests/a.test.js`; grading path `package.json`: restore `package.json`, `tests/a.test.js`, `tests/b.test.js`; `overwritten` 2. |
| `the next slot does not depend on the order of the rows` | 200 seeded shuffles of the same rows (3 tasks, 3 configurations, 3 slots, with voids and finals): one result. With no rows: the first task, slot 0, the first configuration, attempt 0. |
| `a void trial runs again at most twice` | A slot with voids at attempts 0 and 1: attempt 2. With a third void: the next slot moves on. |
| `the isolation label needs every probe` | `fetch: "open"`, `sourceClean` false, or a state other than `ready`: `none`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-trial-rules.test.ts` and the typecheck.

### Task 9: the replay run kind

**Files:** `packages/host/src/team-replay.ts`, `packages/host/src/teams.ts` (at most +27), `packages/host/src/config-identity.ts` (net 0), `tests/fixtures/trial-agent.mjs`, `tests/team-replay.test.ts`. Needs Tasks 2, 3, and 6.

**Interfaces (produces):**
```ts
// team-replay.ts
export type ReplayCreate = {
  trialId: string; jobId: string; purpose: "replay" | "gate"; projectId: string;
  profile: TeamModelProfile; capsule: Capsule; features: EvalFeatures;
  baseCommit: string; workspace: string;   // ROOT/trials/TRIAL/work, prepared by the pump
};
export type ReplayState = {
  phase: "running" | "ended";
  ending?: TrialEnding | "settled";   // with "ended"
  resultCommit?: string;              // with "settled", when the member committed a change
  resetsAt?: string;                  // with "void-limit", the provider's stated reset
  memberId?: string; sessionId?: string; memberStartedAt?: string;
  sessionExited: boolean;             // true when no member launched, or the member's session is exited
};
/** The service's record of a run, as team-intent.ts types its holder. */
export type ReplayHolder = { run: TeamRun };
export type ReplayHost = { config(): Config; emit(holder: ReplayHolder, type: RunEventType, data: Record<string, unknown>): void;
  save(holder: ReplayHolder): void;
  cancel(holder: ReplayHolder): Promise<void>;            // stopRun(stored, "cancel") through enqueue
  sessionStatus(sessionId: string): Promise<WorkerState["status"] | undefined> };
export class TeamReplay {
  constructor(host: ReplayHost);
  /** The new run: implementing, one pending task from capsule.task, parallelism 1, the host lineup with implementers [profile] and no
   *  escalations or fallbacks, autonomy "supervised", linearTracking false, no permissions, routing, intentCheck, blackboard, delivery,
   *  goal, or establishChecks; objective, brief, steering, and owner answers (as answered decisions of revision 1) from the capsule. */
  seed(input: ReplayCreate, at: string): TeamRun;
  /** join(eval.member.root, "trials"). Throws TeamError 409 "eval-identity-missing" without eval.member. */
  root(): string;
  /** run.created data: { projectId, purpose, trialId }. Then plan.accepted (taskCount 1, planDigest, parallelism 1) and one task.planned with `features`. */
  created(holder: ReplayHolder, features: EvalFeatures): void;
  prefixFor(run: TeamRun, fallback: TeamCommand | undefined): TeamCommand | undefined;     // evalCommandPrefix(member, "exec") for a replay run
  /** For a replay run: the setup prefix and stdin `evalProxyUrl("_eval-setup", trialId, 900)` plus a newline ("\n" without the boundary). */
  setupFor(run: TeamRun, fallback: TeamCommand | undefined): { prefix: TeamCommand | undefined; input?: string };
  header(run: TeamRun): { purpose?: SessionPurpose };
  trusted(run: TeamRun): boolean;          // true for a replay run; else teams.trustWorkspaces === true
  step(holder: ReplayHolder): void;                                  // every task integrated and no member active
  consume(holder: ReplayHolder, member: TeamMember): boolean;        // question, blocked, escalate
  end(holder: ReplayHolder, ending: TrialEnding, resetsAt?: string): true;
  blocked(holder: ReplayHolder, error: unknown): true;
  state(holder: ReplayHolder | undefined): Promise<ReplayState | undefined>;
  /** Ended or settled, no member active, and the outbox empty. */
  forgettable(holder: ReplayHolder): boolean;
}
// teams.ts, public
createForReplay(input: ReplayCreate): Promise<{ runId: string }>;
replayState(trialId: string): Promise<ReplayState | undefined>;
endReplay(trialId: string, ending: "timeout" | "void-owner" | "void-host"): Promise<void>;
forgetReplay(trialId: string): Promise<boolean>;     // deleteRecord, with no tombstone; false while the run is not forgettable
replayIds(): string[];
// config-identity.ts: memberConfiguration's input gains `shape?: "team" | "trial"`; the components use `input.shape ?? "team"`.
```

**Decisions:**
- **Creation.** `createForReplay` runs inside `enqueue`. A record with the trial id answers that run. Otherwise it stores `{ run: replays.seed(input, at), fingerprint: digest(input), receipts: {}, prepared: true, root: replays.root() }`, emits `run.created` with `replays.created`, saves, and lets the next step start the implementer. It never calls `createRun`, so the production checks (profiles in `config.agents`, the team volume, mission reservations, delivery) do not apply, and `createRun`'s `run.created` keeps its data. The replay methods read `this.records.get(id)` directly.
- **Commands.** `private prefixFor(run)` gives `replays.prefixFor(run, this.config.teams?.commandPrefix)`. On every path a replay run reaches, `this.config.teams?.commandPrefix` becomes `this.prefixFor(run)` in place: the member operation's `assertMemberReadOnly`, `writeTeamContext`, `enrich`'s `prefix`, `assertMemberScope`, `captureMemberResult`, the result operation's `diff` and `gitRead`, and the retirement boundary. The member operation's setup `teamCommand` call takes its prefix and stdin from `replays.setupFor(run, …)` (`teamCommand(setup, cwd, signal, 600000, prefix, input)`). A path missed here fails closed: the agent account cannot enter a trial directory.
- **The member** (each in place). In the member operation, `const cwd = run.replay ? run.workspace : await prepareMemberWorkspace(...)`, and the graph refresh is skipped for a replay run. No scratch directory (line 5118's condition). `publicationTarget`'s first line (1126) becomes `if (!this.publishHeadsEnabled() || stored.run.replay) return undefined;`. `enrich` passes `shape: run.replay ? "trial" : "team"`. In `launch()`, line 5138 becomes `const github = stored.run.replay ? undefined : sessionGithubScope({ …`, and line 5141's `this.config.teams?.trustWorkspaces === true, {}` becomes `this.replays.trusted(stored.run), this.replays.header(stored.run)`. `member.started`'s `purpose: "work"` (line 5160) becomes `purpose: run.replay?.purpose ?? "work"`.
- **Endings** (+1 line each). First line of `consume` (line 5197): `if (stored.run.replay && this.replays.consume(stored, member)) return;` ends `question`, `blocked`, and `escalated`. First line of `replaceStalledMember` (line 4863): `end(…, "stalled")`. First line of `switchLimitedMember` (line 4916): `end(…, "void-limit", limit.resetsAt)`, before `this.limits.observe`. First line of `block` (line 2759): `blocked`, which maps the code with `endingOfBlock`; an implementer that exits without a report reaches `block` with `missing-agent-report` (line 3421) and ends `no-result`. In the member loop's `needs-you` branch, after line 3438, `const holder = this.promptHolder(run, member.sessionId, state.attention.prompt?.id);`: `if (run.replay && holder === "user") return void this.replays.end(stored, "permission");`. A served project's dialog goes to the host permission agent first (`handOffPermission`), and the holder is `agent` while it decides. `end` records `run.replay.ending` once and cancels the run through `host.cancel`; it never creates a member, asks the owner, or switches a profile. The members stop through the cancel path, which records its own stop reason; the trial row holds the ending.
- **A result.** In the result operation, line 5546 becomes `const head = commit ? (run.replay ? commit : await integrateMemberResult(…)) : run.headCommit!;`, and `captureIntegrated` is guarded by `!run.replay`, both in place. `task.integrated` is emitted as for any run. After `if (activeCount) return;` in the run step (line 3517): `if (run.replay) return void this.replays.step(stored);`, which sets `run.replay.resultCommit` to the task's commit (absent for an empty result) and the status `ready-for-review`, and saves. It never starts checks, review, or delivery. A completion that finds `run.replay.ending` set or the run stopped changes nothing.
- **`state`.** No record: `undefined`. `run.replay.ending` set: `ended` with it (and `resetsAt`). Status `ready-for-review`: `ended` `settled`. Status `paused` or `cancelled` without an ending (an owner halt or an owner's action by id): `ended` `void-owner`. Status `blocked` without an ending: `ended` `void-host`. Otherwise `running`. `sessionExited` reads `host.sessionStatus` of the implementer's session once per call.
- **Exclusions**, each in place unless counted: `list()`, `statuses()`, and `understandingRecords()` skip replay runs; a new `private visible(id)` (+1) throws `TeamError(404, "team-not-found", "This team does not exist.")` for a replay run, and `get` (line 1097) and `objectiveRecord` (line 1098) use it; `view()`'s destructure, `const { members, permissionRecovery, ...run }`, also takes out `replay`; `activeForProject` skips replay runs; the tick's `this.limits.reconcile(this.manager, rows)` passes only rows with `!learningPurpose(row.purpose)` (the `import type { Config, Provider, Session } from "./types.js";` line becomes a value import in place); `deleteRecord`'s `this.persistRetiredRunId(stored.run.id)` (line 1397) runs only without `stored.run.replay`. `retire()` returns at once for a replay run (+1): the pump removes the workspace and the record. The notifier, Linear, and publication see no replay run, because they read `statuses()`, `linearTracking`, or `publicationTarget`. Repository briefings already skip sessions outside `teams.workspaceDir` (`repository-briefings.ts` `location()`).
- **`teams.ts` line budget, +27 at most:** the `team-replay.js` import (1), the `replays` field, one line like `intentChecks` at line 507 (1), `createForReplay` (4), `replayState`, `endReplay`, `forgetReplay`, and `replayIds` (4), `prefixFor` (1), `visible` (1), the step hook (1), the `consume` hook (1), the stall, limit, block, and `needs-you` hooks (4), the `retire` return (1), and up to 8 lines where an in-place edit would pass 200 characters. Everything else is in place.
- **`tests/fixtures/trial-agent.mjs`** reports the way `team-agent.mjs` does. Its modes: `reference DIR` (copies DIR's files into its cwd, then reports `result`), `empty`, `outside` (edits a file outside the task's paths), `question`, `blocked`, `escalate`, `silent` (exits with no report), `stall` (prints nothing and waits), `permission` (draws the dialog `hook-agent.mjs` draws, which the fixture pipeline leaves to a person), and `limit` (prints the limit notice `codex-limit-agent.mjs` prints).

- [ ] **Step 1: Write the failing tests** in `tests/team-replay.test.ts`, with a real `TeamService` and Manager, the Task 6 fixture as the eval launcher (`eval.member.prefix`), and `trial-agent.mjs` as the eval profile.

| Test name | Assertions |
|---|---|
| `a replay run is seeded and starts one implementer` | `createForReplay` twice with one trial id: one run, whose id is the trial id. Events in order: `run.created` (purpose `replay`, `trialId`), `plan.accepted` (`taskCount` 1), one `task.planned` with the eval features, `member.started` (purpose `replay`), and `member.configured` with shape `trial`. No project manager. The session's purpose is `replay`, its workspace trusted, and its prompt holds the capsule's objective. |
| `a replay run reaches no client` (acceptance 6) | `list`, `statuses`, and `understandingRecords` omit it; `get` and `objectiveRecord` answer `404`; `activeForProject` is false while it runs. Spies on publication, Linear, the capture sink, and the GitHub grant scope record no call; the run has no `blackboard`, `permissions`, `routing`, or `delivery`. A corroborated limit shown on its session leaves `providerLimits()` empty. |
| `every member ending ends the trial with its name` | Modes `question`, `blocked`, `escalate`, `silent`, `stall`, `limit`, `permission`, `outside`, and an owner halt: `replayState` gives `question`, `blocked`, `escalated`, `no-result`, `stalled`, `void-limit`, `permission`, `scope-violation`, `void-owner`. In each case no member is added and no decision asks the owner. `empty`: `settled` without `resultCommit`; `reference`: `settled` with it. |
| `a stopped replay run ignores late completions` | The result operation completes after `endReplay(…, "void-owner")`: the run, its tasks, and its events stay as they were. |
| `replay commands run as the eval identity` | Every command the run made went through the fixture's `exec` or `setup`; none went through `teams.commandPrefix`. After the run settles, `forgetReplay` answers true and the record file is gone, with no tombstone. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/team-replay.test.ts tests/run-event-coverage.test.ts` in the background, then `node scripts/check-file-size.mjs` and the typecheck. If `tests/run-event-coverage.test.ts` pins the keys of `run.created`, this task adds `trialId` there.

### Task 10: outcome rows

**Files:** `packages/host/src/outcome-projector.ts`, `packages/host/src/outcome-signals.ts`, `packages/host/src/outcome-store.ts` (net 0), `tests/outcome-replay.test.ts`. Needs Task 1. Builds against Task 9's event data: `run.created` with `purpose` and `trialId`.

**Decisions:**
- `runCreated`: when `data.purpose` is `replay` or `gate`, `summary.source = "replay"` and `summary.payload.trialId = str(data.trialId)`. `outcome-store.ts` line 63 in `RunSummaryPayload`, `missionId?: string;`, becomes `missionId?: string; trialId?: string;` in place.
- `Facts` gains `source: "production" | "replay"` and `experimentRef: string | null`; `factsOf` copies them from the summary; `blankOutcome` and `blankResult` use `facts.source` and `facts.experimentRef`. A summary made by another event than `run.created` stays `production` with a gap, as today.
- `saveOutcomeRow`: for `row.source === "replay"`, `accepted`, `firstPass`, and `held` are null after the levels are computed, and `acceptance` stays null (C5).
- Routing and the scorecard already read `ROUTING_SOURCES = ["production", "duel"]` (`outcome-store.ts` line 672), and the coverage denominator reads `production`. Nothing there changes.

- [ ] **Step 1: Write the failing tests** in `tests/outcome-replay.test.ts`, on a real store with the projector.

| Test name | Assertions |
|---|---|
| `a replay run writes replay rows` | The events of a replay run (created, started, configured, reported, integrated, settled, deleted): the summary's source `replay`; the implementer's row source `replay` and `experiment_ref` the trial id; `accepted`, `firstPass`, and `held` null after the settle and after a landing signal for the run. |
| `replay rows never reach routing or the scorecard` | `queryCells` with `sources: ["production"]`, and the routing reads, count no replay row. |
| `a production run keeps production rows` | The same events with purpose `work`: source `production`, `experiment_ref` null, the levels as before. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/outcome-replay.test.ts tests/outcome-store.test.ts` in the background, then `node scripts/check-file-size.mjs`.

### Task 11: the trial source and grading

**Files:** `packages/host/src/eval-trial.ts`, `packages/host/src/eval-validate.ts` (at most +6), `tests/eval-trial.test.ts`. Needs Tasks 5, 6, 7, and 8.

**Interfaces (produces):**
```ts
export const TRIAL_BUNDLE_MAX_BYTES = 1_073_741_824, GRADE_ROUNDS = 2, DIFF_OUTPUT_MAX = 65_536;
export type TrialContext = ValidateContext & { trialId: string; identity: EvalIdentity; evalUid: number; probe: EvalProbe };
export type SourceResult =
  | { kind: "ready"; baseCommit: string; workspace: string; hiddenFiles: string[]; isolation: "isolated" | "none"; capsule: Capsule; features: EvalFeatures }
  | { kind: "skip"; reason: "unreadable" | "not-valid" | "expected-missing" | "secret-shaped" | "source-leaked" }
  | { kind: "environment"; cause: "grader-failed" | "grader-processes-alive" | "eval-failed" | "eval-processes-alive" | "bundle-missing" | "halted" | "storage" };
export function prepareTrialSource(store: EvidenceStore, taskId: string, ctx: TrialContext): Promise<SourceResult>;
export type GradeResult =
  | { kind: "graded"; grade: TrialGrade; patch: Buffer | "too-large" | "secret-shaped" }
  | { kind: "environment"; cause: "grader-failed" | "grader-processes-alive" | "eval-processes-alive" | "task-gone" | "halted" };
export function gradeTrial(store: EvidenceStore, input: { taskId: string; baseCommit: string; resultCommit: string | undefined; workspace: string;
  hiddenFiles: string[]; isolation: "isolated" | "none" }, ctx: TrialContext): Promise<GradeResult>;
// eval-validate.ts exports, in place: Stop, loadTask, cloneTask, tagMined, applyCaptured, applyPatch (name: Exclude<GraderInput, "base.bundle">),
// changedNames (from = "eval-base", to = "eval-reference"), guardChecks, focused, call, exec, expectZero, finish, reset.
```

**Decisions:**
- **The source**, in the eval host's one step, with the grader job id equal to the baseline job id: `loadTask` (a payload that does not open: `skip` `unreadable`); the task must be `valid` with `expectedCases` (else `not-valid` or `expected-missing`); `findSecret(capsule, { token: "", url: "" })`, as `eval-mine-rules.ts` line 102 calls it (`secret-shaped`). Then slice 2's steps: the job's bundle (`prepareJob` with the trial pump's own `BundleState`), `cloneTask`, and `tagMined` or `applyCaptured`. Then, in `task`: `git update-ref refs/heads/trial refs/tags/eval-base`, `git rev-parse eval-base eval-reference`, and `git ls-tree -z eval-reference -- HIDDEN...` with `keepStdout`, which give the base, the grader's reference, and each hidden file's reference blob. Then `stopEvalIdentity`, `clean`, `scrub`, and a fresh probe that must be `ready`; then `export` piped into `identity.receive(trial, …, 1 GiB)`; `identity.prepare`; and `identity.check` with the payload's `commit` and `integratedHead` (captured) or `commit` (mined), the grader's reference, the mirror head, and the hidden blobs. `leaked` skips the task `source-leaked` after `clean`. The label is `isolationLabel({ probe, sourceClean: true })`. The grader's `task` clone stays for grading; `finish` cleans the rounds.
- **Grading**, after the pump saw every eval process stop. No `resultCommit` grades `no-result`. Otherwise `captureGit(() => ctx.identity.teamPrefix()).patch(workspace, baseCommit, resultCommit)`: `too-large` grades `scope-violation`, since no corpus task needs 1 MiB; `failed` is `environment` `eval-processes-alive` only when the stop failed, else the pump ends the trial `void-host`. `findSecret` over the patch's UTF-8 text marks it `secret-shaped`; it is still graded. Then: `stopGrader`; the task clone as above (a task that is gone or unreadable: `environment` `task-gone`); in `task`, check out `eval-base`, `applyPatch(ctx, "result.patch", bytes)` (a refusal grades `scope-violation`), and `git update-ref refs/tags/eval-result HEAD`; `changedNames(ctx, "eval-base", "eval-result")` (truncated: `scope-violation`); `restoreSet` with the reference's `changedNames`. In `round-1`: clone `task`, check out `eval-result`, `git --literal-pathspecs restore --source=eval-reference --staged --worktree --pathspec-from-file=- --pathspec-file-nul` with the restore list, commit; `focused` with the hidden files. A time-out grades `timeout`; a missing or invalid report runs the same in `round-2` once (`GRADE_ROUNDS`). When every expected case passed, `guardChecks` in `round-3`. The numstats of `eval-base` to `eval-result` and to `eval-reference` (`--numstat --no-renames -z`, `keepStdout`) fill `diff`, or `diff` is null when either is truncated. `gradeOf` decides. Every path ends with `finish`.
- **Halt.** `call` polls `halted()` as validation does; a halt is `environment` `halted`, and the pump ends the trial `void-owner`.

- [ ] **Step 1: Write the failing tests** in `tests/eval-trial.test.ts`: real Git, the fixture grader and eval launchers, a real store with a valid mined task.

| Test name | Assertions |
|---|---|
| `the trial source holds only the base` (acceptance 4) | After `prepareTrialSource`: in `work`, `git cat-file -e` fails for the mined commit, the grader's reference, and the mirror head; `git remote` prints nothing; no hidden test file exists and its reference blob is absent; `in/` is gone. A grader fixture whose export still holds the reference: `skip` `source-leaked`, and no trial workspace remains. |
| `a member that applies the reference is resolved` (acceptance 7) | A result commit equal to the reference's tree: `graded`, `expectedPassed` equals `expectedTotal`, `guardPassed` true, `resolved` true, `overwritten` 0. |
| `an exit code never resolves` (acceptance 7) | A result that makes the focused script exit 0 and write no report: `expectedPassed` null after two rounds, `resolved` false. A result that writes a report without the expected cases: not resolved. |
| `a grading path edit is overwritten` (acceptance 7) | A result that edits `package.json`, under `gradingPaths`, and the source: graded with the reference's `package.json`, `overwritten` 1. |
| `a grading time-out ends timeout` | A focused test past its limit: ending `timeout`, `resolved` false. |
| `an unreadable task starts no trial` | A payload replaced with bad sealed text: `skip` `unreadable` before any launcher command. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-trial.test.ts tests/eval-validate.test.ts` in the background, then the typecheck.

### Task 12: the baseline job

**Files:** `packages/host/src/eval-trial-jobs.ts`, `packages/host/src/eval-jobs.ts` (at most +27), `tests/eval-trial-jobs.test.ts`. Needs Tasks 7 and 8.

**Interfaces (produces):**
```ts
export const TRIAL_CONFIGURATIONS_MAX = 4, TRIALS_PER_TASK_DEFAULT = 3, TRIALS_PER_TASK_MAX = 5, TRIAL_TASKS_DEFAULT = 20,
  TRIAL_TASKS_MAX = 200, MAX_TRIALS_MAX = 1_000, TRIAL_SLOTS_FREE_MIN = 4, BASELINE_JOBS_MAX = 100;
export const BASELINE_JOBS_SQL = "SELECT * FROM eval_jobs WHERE status = ? AND kind = 'baseline' ORDER BY created_at, job_id LIMIT ?";
export const baselineJobSchema: z.ZodType<BaselineJobRequest>;
/** SHA-256 of the canonical JSON of the validation settings, trialMinutes, eval.grader, eval.member, each configuration's
 *  promptVersion("implementer", provider, profile, false, false, false), and project.team.permissions. */
export function trialJobDigest(project: Project, config: Pick<Config, "eval">, configurations: readonly TrialConfiguration[]): string;
export type TrialGates = {
  identity: EvalProbe; grader: GraderProbe; hostLoadHeld: boolean; halted: (projectId: string) => boolean;
  limited: ReadonlySet<Provider>;     // TeamService.providerLimits() providers and the pump's eval limits
  freeSlots: () => Promise<number>; trialLive: boolean;
};
export type NextTrial =
  | { kind: "trial"; jobId: string; projectId: string; taskId: string; configuration: TrialConfiguration; configRef: string;
      slot: number; attempt: number; settings: TrialSettings }
  | { kind: "wait"; jobId: string; waiting: EvalJobWait } | { kind: "none" };
export class TrialJobs {
  constructor(options: { store: EvidenceStore; config: Pick<Config, "projects" | "eval" | "teams">; now?: () => string });
  create(projectId: string, request: BaselineJobRequest, requestId: string): { created: boolean; job: BaselineJobView } | EvalRefusal;
  views(db: EvidenceDb, rows: readonly EvalJobRow[]): Map<string, BaselineJobView>;   // one trialCounts read for the page
  next(gates: TrialGates): Promise<NextTrial>;
  skip(jobId: string, taskId: string): void;          // the cursor moves past the task; skipped + 1
  record(jobId: string, ending: TrialEnding): void;
  block(jobId: string, reason: "eval-processes-alive"): void;
  digest(projectId: string, jobId: string): string | undefined;
  running(): string[];                                // ids of running baseline jobs, at most 100
}
// eval-jobs.ts, in place: ACTIVE_JOBS_SQL adds "AND kind = 'validate'"; ACTIVE_PROJECT_JOBS_SQL adds "AND kind = ?";
// `export type EvalJobRow = JobRow;` (+1); the constructor options gain
// `baseline?: { views(db: EvidenceDb, rows: readonly EvalJobRow[]): Map<string, BaselineJobView>; digest(projectId: string, jobId: string): string | undefined }`,
// which viewOf, list, and projectJobs use for rows of kind 'baseline', and which control's resume uses to pin a baseline row.
```

**Decisions:**
- **The schema**, strict: 1 to 4 configurations, each `{ profile: teamModelProfileSchema, guidance: "as-of-base", knowledge: "none" }`, no two with one `configRef`; `taskFilter` with task ids (at most `JOB_TASKS_MAX`), at most 2 origins, at most 32 areas, and `maxTasks` 1 to 200 (default 20); `trialsPerTask` 1 to 5 (default 3); `limits.maxTrials` 1 to 1,000 and `maxWallMinutes` 10 to 43,200; windows and `expiresAt` as the validate job's (at most 30 days).
- **`create`.** An unknown project: `404` `unknown-project`. `trialSettings` with a `missing` key: `409` `eval-config-incomplete`. A profile whose provider is not `claude`, `codex`, or `opencode`; a profile in neither `lineupProfiles(config.teams.lineup)` nor the project's `candidateProfiles`; or a `dataUse: "contributor"` profile while `project.team.routing?.allowContributor` is not true: `409` `profile-not-approved`. Request ids as the validate job's. A baseline job of the project in `scheduled`, `running`, `paused`, or `blocked`: `409` `job-active` (a validate job does not count). The row goes into `eval_jobs` with `kind` `baseline` and the sealed payload `{ projectId, request, requestDigest, jobDigest }`; `openTrialCounts` writes the plan: `planned.tasks` is the count of matching `valid` tasks, at most `maxTasks`, read in pages of `NEXT_TASK_SQL`, and `planned.trials` is `min(maxTrials, tasks × configurations × trialsPerTask)`.
- **`next`**, oldest job first among `scheduled` and `running` baseline rows (`BASELINE_JOBS_SQL` through `eval_jobs_status`), each gate in this order: expired (`expired`); `jobTrialCount` at `maxTrials` or the wall time at `maxWallMinutes` (`completed`, `limit-reached`); the digest (`blocked`, `configuration-changed`); halt (`halt`); window (`window`); host load (`host-load`); the eval identity not `ready`, or no `eval.member.agents` entry for the configuration's provider (`eval-identity`); the grader not `ready` or `version` below 2 (`grader`); storage (`storage`); a live trial (`another-job`); the configuration's provider in `limited` (`provider-limit`); `freeSlots()` below 4 (`session-slots`); `trialsSince(project, today 00:00 UTC)` at `trialsPerDay` (`daily-cap`). Then the slot: the job's `cursor` column holds the current task id; `nextSlot` over `jobSlots(job, cursor)`; when the task has no slot left, `NEXT_TASK_SQL` gives the next `valid` task after the cursor that passes the filter, `advanceTask` counts it, and the cursor moves. At `maxTasks` tasks reached, or with no task left, the job is `completed` `done`. `waiting` is written only when it changes.
- **`record`** reads the counters after `finishTrial`; at `VOID_STREAK_PAUSE` (3) the job pauses `trial-voids`. **`skip`** moves the cursor past the task and calls `advanceTask(…, true)`.
- **Control.** `pause` lets a live trial finish and starts no other; `cancel` also makes the pump end a live trial of the job `void-owner` (Task 15 reads the status). `resume` from `blocked` pins `trialJobDigest`.
- **Cost.** `next` reads at most 100 active baseline jobs through `eval_jobs_status`, one count by job through `eval_trials_job`, one daily count through `eval_trials_project_day`, slot rows of one task through `eval_trials_job`, and at most one page of 200 tasks through `eval_tasks_next`. `freeSlots` runs only after every cheaper gate passed.

- [ ] **Step 1: Write the failing tests** in `tests/eval-trial-jobs.test.ts`, on a real store with a fixed clock.

| Test name | Assertions |
|---|---|
| `a baseline request makes one job` | The same id and body twice: one job, `created` true then false; another body: `request-conflict`. A profile outside the pools, a Grok profile, or a `contributor` profile without `allowContributor`: `profile-not-approved`. No `trialsPerDay`: `eval-config-incomplete`. A second baseline job of the project while one is `paused`: `job-active`; a validate job beside it: created. The view shows `tasks.planned` and `trials.planned`. |
| `the job waits for every gate and says which` | Each gate in turn (halt, window, host load, the eval identity `busy`, a grader `version` 1, storage, a live trial, a limited provider, three free slots, the day's cap reached): `next` returns `wait` with that name, and the column holds it. |
| `a job starts no trial after its limits` (acceptance 9) | `maxTrials` 2 with two trial rows: `completed` `limit-reached`. `trialsPerDay` 1 with one trial today: `daily-cap`; the clock moved to the next UTC day: a trial. |
| `a changed configuration blocks the job` | `trialMinutes` changes: `blocked` `configuration-changed`; `resume` pins the new digest and `next` returns a trial. A change of `eval.member.root` blocks it the same way. |
| `three voids in a row pause the job` | Three `void-host` records: `paused` `trial-voids`. |
| `cancel voids the running trial` | `control(job, "cancel")` with a live trial: the job is `cancelled`, and the pump's next step ends the trial `void-owner`; `pause` leaves the live trial alone. |
| `the baseline statements read through an index` | `EXPLAIN QUERY PLAN` of `BASELINE_JOBS_SQL` and of the edited `ACTIVE_JOBS_SQL` and `ACTIVE_PROJECT_JOBS_SQL` uses `eval_jobs_status`, `eval_jobs_status`, and `eval_jobs_project`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-trial-jobs.test.ts tests/eval-jobs.test.ts` and the typecheck.

### Task 13: the summary and the routes

**Files:** `packages/host/src/eval-summary.ts`, `packages/host/src/eval-routes.ts`, `tests/eval-routes.test.ts`. Needs Task 12.

**Decisions:**
- `evalSummary`'s input gains `evalIdentity: EvalIdentityState`, `graderVersion: number | null`, and `trials: { today: number; dailyCap: number | null }`. `trialsSince` gives `today`; `trialSettings` gives `dailyCap` (null when `trialsPerDay` is absent). The grader's version is null until a probe answered one.
- `POST /api/eval/jobs` parses `job` by `kind` with `validateJobSchema` or `baselineJobSchema` and calls `create`. `GET /api/eval/jobs` renders baseline rows with one `trialCounts` read for the page. No route returns a capsule, a patch, a file name, a case, a commit, a trial id, a session id, or a profile model.

- [ ] **Step 1: Write the failing tests** in `tests/eval-routes.test.ts`.

| Test name | Assertions |
|---|---|
| `the summary shows the eval identity and today's trials` | `evalIdentity.state` `not-configured` without `eval.member`; two trials today with a cap of 6: `today` 2, `dailyCap` 6; without `trialsPerDay`: `dailyCap` null; a version 1 grader: `grader.version` 1. |
| `a baseline job is created and listed` | Owner `POST` of a baseline job: `201`, then `200` for the same id; `GET /api/eval/jobs` shows `kind` `baseline` with `tasks` and `trials`; viewer `POST`: `403`. No body contains the capsule's objective, the patch's text, a trial id, or the model name. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-routes.test.ts` and the typecheck.

### Task 14: the CLI

**Files:** `packages/host/src/eval-cli.ts`, `tests/eval-cli.test.ts`. Needs Task 1. Runs in parallel with Tasks 2 to 12.

**Decisions:** `evalStatusLines` replaces `grader STATE` with `grader STATE`, or `grader ready (version 1: no trials)` when the version is below 2, and adds `eval identity STATE` and `trials today N of CAP`, or `trials off` without a cap. `evalJobLines` prints, for a baseline job, `tasks R of P (skipped S) · trials started N of P, graded N, resolved N, ended N, void N`. `run` already sends any `job` body. Text passes through the existing `clean`, counts through `count`.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `status prints the eval identity and trials` | A summary with `evalIdentity.state` `busy` and `trials` `{ today: 2, dailyCap: 6 }`: the exact lines `eval identity busy` and `trials today 2 of 6`; a null cap prints `trials off`; a version 1 grader prints `grader ready (version 1: no trials)`. |
| `job prints baseline counts` | A baseline view: the exact line of counts; a validate view prints as before. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/eval-cli.test.ts`.

### Task 15: the trial pump, the eval host, the server, and the host test

**Files:** `packages/host/src/eval-trial-pump.ts`, `packages/host/src/eval-host.ts` (at most +99), `packages/host/src/server.ts` (net 0), `tests/eval-trial-run.test.ts`. Needs Tasks 9, 10, 11, 12, and 13.

**Interfaces (produces):**
```ts
// eval-trial-pump.ts
export const EVAL_STOPPING_MS = 120_000, TRIAL_LAUNCH_MS = 900_000, TRIAL_SESSION_KEEP_MS = 3_600_000, TRIAL_SESSIONS_BATCH = 20,
  EVAL_LIMIT_UNSTATED_MS = 900_000, EVAL_LIMIT_MAX_MS = 86_400_000;
export type TrialTeams = Pick<TeamService, "createForReplay" | "replayState" | "endReplay" | "forgetReplay" | "replayIds" | "providerLimits">;
export type TrialPumpOptions = {
  config: Config; store: EvidenceStore; jobs: TrialJobs; grader: Grader; identity: EvalIdentity;
  teams: () => TrialTeams; sessions: Pick<Manager, "list" | "remove">; source: Pick<ProjectSourceService, "mirrorPath" | "status">;
  hostLoad: Pick<HostLoadGate, "held">; halt: () => Pick<HaltService, "check">;
  graderProbe: () => Promise<GraderProbe>; inventory?: () => Promise<RuntimeProcess[]>; now?: () => string;
};
export class TrialPump {
  constructor(options: TrialPumpOptions);
  /** One step: start-up once, then advance the live trial or start one. Never throws. */
  step(): Promise<void>;
  /** Hourly: sweepTrials, forgetReplay for final trials whose run remains, and sessions.remove for at most 20 sessions ended over an hour ago. */
  sweep(): Promise<void>;
  identityState(): EvalIdentityState;   // the last probe, at most 10 minutes old
}
// eval-host.ts: EvalHostOptions gains `teams?: () => TrialTeams; sessions?: Pick<Manager, "list" | "remove">; identity?: EvalIdentity`.
```

**Decisions:**
- **One chain.** `EvalHost.validate()` keeps its one in-flight promise; its `step()` runs the validation step, then `TrialPump.step()`. One user holds the grader at a time, and no lease is needed. The trial pump keeps its own `BundleState`, so a validate job and a baseline job each keep their bundle in the grader root. `EvalHost.sweep()` also calls `TrialPump.sweep()`. Without `options.teams` there is no trial pump.
- **Free slots** are `config.maxSessions` minus the sessions in `running` or `starting`, the predicate `teams.ts` line 5098 uses, read through `sessions.list()` only after every cheaper gate passed.
- **Start-up**, once per process, before any trial: every `preparing` row is dropped (no member was launched: `startTrial` precedes `createForReplay`); every `running` or `grading` row gets `endReplay(trialId, "void-host")` when its run exists, then `finishTrial` with `gradeOf({ ending: "void-host", … })` and `jobs.record`. Then, when the eval identity answers a state other than `not-configured`, `unavailable`, or `misconfigured`: `stopEvalIdentity`, `clean`, `scrub`; and `grader.clean(jobId)` for each of `jobs.running()`, because validation's start-up clean (`eval-host.ts` `startupClean`) now reads validate rows only. A failed stop or clean leaves start-up for the next step.
- **A live trial**, one per step:
  1. `running`: `replayState`. `undefined`: `finishTrial` `void-host`. `phase` `running`: a cancelled job or a halted project calls `endReplay(…, "void-owner")`; a member started more than `trialMinutes` ago calls `endReplay(…, "timeout")`; no member started 15 minutes after `startTrial` calls `endReplay(…, "void-host")`.
  2. `phase` `ended` with `sessionExited` false: wait, up to 120 seconds from the first such step (the worker records the exit after its final transcript drain).
  3. `phase` `ended` with a trial ending: `stopEvalIdentity` (`alive`: the job is blocked `eval-processes-alive`, the trial ends `void-host`), `finishTrial` with `gradeOf({ ending, … })`, `clean`, `scrub`, `jobs.record`, `forgetReplay`. A `void-limit` sets the pump's eval limit for the provider until `resetsAt`, at most 24 hours, or 15 minutes when no reset was stated.
  4. `phase` `ended` `settled`: `stopEvalIdentity` as above, `gradingTrial`, `gradeTrial`, then `finishTrial` with `configId` and `profileEpoch` from one `readOutcome(db, outcomeId(trialId, memberId))` (the epoch only when the row has a `configId`; else both null) and the session id; then `clean`, `scrub`, `jobs.record`, `forgetReplay`. An `environment` answer from grading ends the trial `void-host` (`halted`: `void-owner`).
- **No live trial**: probe the eval identity (cached `ready` for at most 10 minutes; the probe's `fetchUrl` is `repositoryUrl` of the oldest job's project and its `proxyUrl` is `evalProxyUrl("_eval", "probe", 60)`), take `graderProbe()`, and call `jobs.next`. On `trial`: `insertTrial` with a new UUID, then `prepareTrialSource`. `ready`: `startTrial`, then `createForReplay` (a throw ends the trial `void-host`). `skip`: `dropTrial` and `jobs.skip`. `environment`: `dropTrial`; the job waits one step (`*-processes-alive` blocks it `eval-processes-alive`).
- **`server.ts`**, all its lines in this slice, each in place. Line 103, `import type { Config, Role, Receipt, Session } from "./types.js";`, becomes `import { type Config, type Role, type Receipt, type Session, learningPurpose } from "./types.js";`. Line 268's `new EvalHost({ config, store: evidence, source: projectSource, hostLoad: manager.hostLoad, halt: () => halt, runs: () => teams.understandingRecords() })` adds `teams: () => teams, sessions: manager`. Line 472, `const native = (await manager.list({ … })).map(session => {`, adds `.filter(session => !learningPurpose(session.purpose))` before `.map`. `teams` is read only inside closures the timers call after start-up.
- **Cost per step at 1,000 sessions and 10,000 outcome rows:** one `liveTrials` read through `eval_trials_live`; with a live trial, one record lookup in `TeamService` and one session status read; without one, the job gates of Task 12. A trial start adds two eval probes, one `sessions.list()` (the read every team launch already makes), one daily count, and the source commands. Grading reads one outcome row by key. No step reads per session, and none scans outcome rows. Replay records leave memory and disk once a trial is final, and trial sessions an hour later, so trials add no lasting cost to `manager.list()` or the team tick.

- [ ] **Step 1: Write the failing tests** in `tests/eval-trial-run.test.ts`. Setup: slice 2's fixture mirror (C0 to C3) with C1 validated; the project has `team.eval = { mine: true, focusedTest, reportFormat: "junit", trialsPerDay: 10, trialMinutes: 10 }`; `eval.grader` names the fixture grader with `--version 2`; `eval.member` names the fixture eval launcher and, as `agents.claude`, `tests/fixtures/trial-agent.mjs` with a mode argument. Long batches run in the background.

| Test name | Assertions |
|---|---|
| `a fixture task is resolved by a member that applies the reference` (acceptances 4 and 7) | A baseline job with one configuration and `trialsPerTask` 1, ticked until it completes: one trial `graded`, `resolved` true, `isolation` `isolated` with `--fetch refused`; the outcome row's source `replay` and `experiment_ref` the trial id; `GET /api/teams` and `GET /api/sessions` never listed the run or its session; the trials root is empty after the job. |
| `an empty result, an edit outside the paths, and an undecided permission end their trials` (acceptance 8) | Modes `empty`, `outside`, `permission`: `no-result`, `scope-violation`, `permission`; no owner question exists, and the recording push sender sent nothing. |
| `a provider limit voids the trial, and it runs again` (acceptance 8) | Mode `limit` on attempt 0, `reference` after: the first row `void-limit`, the job waits `provider-limit` until the stated reset, then the second row is `graded` with `attempt` 1. `providerLimits()` stays empty throughout. |
| `no trial while the eval identity is busy` (acceptance 5) | A planted entry in the trials root that `clean` cannot remove, or an inventory row of the eval uid that survives: no trial row; the job waits `eval-identity` or is blocked `eval-processes-alive`. |
| `without both identities, no trial starts and the summary says why` | Without `eval.member`: the job waits `eval-identity`, and the summary shows `not-configured`. With a version 1 grader: the job waits `grader`. |
| `a restart in the middle of a trial voids it` | `close()` while the member runs, then a new host on the same store: `void-host`, the run cancelled, `stop`, `clean`, and `scrub` recorded before any trial command, then the slot again with `attempt` 1. The same during grading. A restart during `prepareTrialSource`: the row is gone, and the slot runs again with `attempt` 0. |
| `a lost replay run voids its trial` | The run's record removed while the member runs: `void-host` within one step. The task's row deleted while the member runs: `void-host`, and the job moves past the task. |
| `validation and trials share the grader one step at a time` | A validate job and a baseline job together: the fixture grader's record never shows one job's commands between another job's `receive` and `clean`, and never a `stop` while the other job's command runs. |
| `an unavailable store starts no trial` | A store that failed to open: `tick` throws nothing, no launcher command runs, the routes answer `503`. |
| `a graded trial leaves no run record and, later, no session` | After a graded trial: `replayIds()` is empty and no tombstone was added; after the clock passes one hour and a sweep, the member's session directory is gone. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `tests/eval-trial-run.test.ts` on the host in the background, then the typecheck and `node scripts/check-file-size.mjs`.
- [ ] **Step 5: The coordinator runs `npm run check` once, runs Tasks 4 and 5's launcher tests in a Linux container, requests the independent review, and commits.**

### Task 16: the docs

**Files:** `docs/teams.md`, `docs/security.md`, `deploy/ubuntu/eval.md` (create), `deploy/ubuntu/grader.md`, `deploy/ubuntu/egress.md`, `docs/superpowers/specs/2026-11-12-replay-eval-design.md`. Needs Task 1. Runs in parallel with Tasks 2 to 14.

**Decisions:**
- `docs/teams.md`, under Eval mining and validation, a section "Eval trials": the new fields and limits, `eval.member`, the baseline job and its waits, the endings, grading, the isolation label, the stand-in cap and what replaces it, and what is missing while each launcher refuses.
- `docs/security.md`: the eval identity and what a trial member can and cannot reach, from "Trust boundary" above, the home reset, and the `_eval` and `_eval-setup` egress identities.
- `deploy/ubuntu/eval.md`: the installs of "Owner approvals", step by step, with their checks, including how to build the home template and that a Codex eval profile with `workspaceDir` names a directory the eval account owns. `grader.md`: version 2. `egress.md`: `projects._eval` and `projects["_eval-setup"]`.
- The spec. Part 1: no `memberProfile`; `trialsPerDay`. Part 3: the replay run's endings, `no-result` for a member without a report, the permission rule, and the session and project-activity exclusions. Part 4: the source built by the grader, the eval launcher, the home reset, the probe, the egress identities. Part 5: the result patch, the restore set, null `expectedPassed` and `diff`. Part 6: the baseline request, the stand-in cap, the gates of this slice, no reuse yet. Acceptance 5: no trial without both identities. Acceptance 9: the `reserve` clause moves to the standing budget.
- No home path, host name, user name, or tracker link.

- [ ] **Step 1: Write the docs.** **Step 2: Run** the privacy scan of `AGENTS.md` over the diff.

## Launcher forms

No new form of `teams.commandPrefix`: a replay run never uses it.

1. **The eval launcher, new** (Task 4): `probe`, `receive`, `prepare`, `check`, `exec`, `setup`, `stop`, `clean`, and `scrub`, with the arguments of Task 4. Every command a replay run makes in its workspace goes through `exec` as the eval account: `writeTeamContext`'s `node -e`, the guidance read of `memberConfiguration`, the path-scope and capture commands of `team-workspace.ts`, the retirement boundary, and the result patch read (`patchArgs` of `eval-git.ts`). The project's `setup` goes through `setup`. Both admit any argument list, because the account, its root, and its environment are the boundary. **While it is not installed:** the eval identity is `not-configured` or `unavailable`, no trial starts, and every baseline job waits `eval-identity`.
2. **The grader launcher, version 2** (Task 5): `export JOB`, the input name `result.patch`, and `"version": 2` in the probe. **While version 1 is installed:** validation runs as before, no trial starts, and baseline jobs wait `grader`; the summary shows `grader ready (version 1: no trials)`.
3. **The eval provider wrappers and the drain** (Task 4): `eval/claude`, `eval/codex`, `eval/codex-app-server`, `eval/opencode`, and `eval/transcript-drain`, which `drainLaunch` finds beside the wrapper. **While refused:** the replay launch fails, the trial ends `void-host`, and three such trials pause the job `trial-voids`.

## Owner approvals

The owner decided on 2026-11-13 to add the eval identity. None of the following is installed, and the slice works without it: nothing starts a trial until items 1 to 10 are done and a project sets `trialsPerDay`.

1. **The account.** `useradd --system --user-group --no-create-home --home-dir /var/lib/infinite-eval/home --shell /usr/sbin/nologin infinite-eval`, then `install -d -o root -g root -m 0755 /var/lib/infinite-eval`, `install -d -o infinite-eval -g infinite-eval -m 0700 /var/lib/infinite-eval/home /var/lib/infinite-eval/tmp`, and `install -d -o infinite-eval -g infinite-eval -m 0711 /var/lib/infinite-eval/root /var/lib/infinite-eval/root/trials`. It joins no other group. A second instance uses `infinite-NAME-eval`. Add `infinite-eval` to `/etc/cron.deny` and `/etc/at.deny` wherever cron or at is installed.
2. **The launcher.** `install -o root -g root -m 0755 deploy/ubuntu/eval-command.sh /usr/local/libexec/infinite/eval-command`, with `ROOT=`, `ACCOUNT=`, `EVAL_HOME=`, `EVAL_TMP=`, and `TEMPLATE=` set.
3. **The wrappers and the drain.** `install -d -o root -g root -m 0755 /usr/local/libexec/infinite/eval`; `deploy/ubuntu/eval-wrapper.sh` as `claude`, `codex`, `codex-app-server`, and `opencode` there; `deploy/ubuntu/transcript-drain.sh` as `transcript-drain` there; each `root:root 0755`.
4. **The sudo rule.** `install -o root -g root -m 0440 deploy/ubuntu/eval.sudoers /etc/sudoers.d/infinite-eval`, then `visudo -c`.
5. **The network rule.** `deploy/ubuntu/eval.nft`, only where `autonomy.boundary.egress` is configured.
6. **The egress lists.** `projects._eval.allow` lists the provider API hosts of the eval logins and nothing else; `projects["_eval-setup"].allow` lists the package registries setup needs, and no registry that serves the project's own later releases; `mode: "enforce"` for `isolated` trials.
7. **The eval logins.** Log in each provider as the eval account, with provider-side history and memory off where the provider offers that, and use these logins for nothing else (owner decision 2).
8. **The home template.** After the logins, copy the files the providers need besides the login files (for example `.claude.json` without its `projects` map, `.claude/settings.json`, `.codex/config.toml`) into `/usr/local/share/infinite-eval/home`, owned `root:infinite-eval`, directories `0750`, files `0640`.
9. **Grader launcher version 2.** Reinstall `grader-command` from Task 5's template, with its `ROOT=` and `ACCOUNT=` lines.
10. **The configuration.** Host: `"eval": { "member": { "prefix": { "command": "/usr/bin/sudo", "args": ["-n", "-u", "infinite-eval", "--", "/usr/local/libexec/infinite/eval-command"] }, "root": "/var/lib/infinite-eval/root", "agents": { "claude": { "command": "/usr/bin/sudo", "args": ["-n", "-H", "-u", "infinite-eval", "--", "/usr/local/libexec/infinite/eval/claude"] } }, "canaries": [the deploy's GitHub App, grant, egress, and vault key paths, and a canary file in the agent account's home] } }`, and a canary file in `/var/lib/infinite-eval/home` added to `eval.grader.canaries`. Project: `team.eval.trialsPerDay`, and `candidateProfiles` to measure a model outside the lineup.
11. **The checks.** `sudo -l -U infinite-host` shows exactly the eval rules of item 4; an `exec -- /usr/bin/env` round with `INFINITE_HOOK_TOKEN` and `HTTPS_PROXY` exported prints only the fixed list; a `sleep` started as the eval account is gone after `stop`; a file planted in the eval home is gone after `scrub`; a file planted in `/var/lib/infinite-eval/tmp` is gone after `clean`; `infinite eval status PROJECT` shows `eval identity ready`.

Open for the owner, with the default this plan builds: the windows of a job (none: any hour); `trialsPerDay` (absent: off; 6 recommended when turned on); the hosts in `_eval` and `_eval-setup`; the files in the home template; and the fallback estimate, which waits for the standing budget.

## Not in this slice

- `compare` and `confirm` jobs, the dev and holdout sets, `excludeGroups`, reports, epochs in comparisons, the prior export, and the calibration pair read (step 4). The trial rows, their sealed grades, and their patches are stored for them.
- Trial reuse (step 4's `compare` jobs).
- The learning budget: `reserve`, `settle`, `status`, USD job limits, the learning floor, the per-trial estimate, `estimate-unavailable`, and `budget-exhausted` (delegated adoption delivery step 4, "The standing budget", which also removes `trialsPerDay`).
- A `promptOrigins` filter, which needs a plain column for the prompt origin.
- Pinned guidance, forced knowledge, prompt overrides, and the `gate` purpose (the improvement gate design).
- Duel judges as the eval identity, and the open-duel gate (the duels design).
- Run-level replay and the blind rubric (step 5). The capsule's goal context is not rendered in a trial's prompt until then.
- Permission measurements that keep trial calls apart from production calls; the permission agent decides a served project's trial dialogs under its own limits.
- A probe that the provider endpoints are reachable; a transient systemd unit per trial.
- Rendering the eval files for a second instance (`scripts/render-instance.mjs`).
- The trials in the web client, the phone, and the Mac app.
- MCP tools: none (C9 rules 3 and 8).
