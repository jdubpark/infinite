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
- **Forward first.** When the head differs from `forward`: form 1 `forward` to head; `no` sets `forward` and `backfill.next` to the head (a rewrite; `visited` is kept, so the 2,000 bound still holds). `yes`: form 2 lists the new commits; more than 500 keeps the newest 500, and the cursor counts the rest as `skipped`. Mine them oldest first. **Then backfill**, newest first, with form 3 from `backfill.next` while `visited < 2,000` and not `done`; a list shorter than 500 that ends at a root commit sets `done`. A pass mines at most 50 commits in total.
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
- **Cost per tick at 1,000 sessions and 10,000 outcome rows:** at most 100 reconcile rows, 100 landing checks (one signal read by key each), 100 path-index rows, one mining pass of at most 50 commits and 100 mirror reads, and at most one validation task host-wide. No step reads anything per session, and none reads the outcome rows.

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

The owner decided on 2026-11-13 to add the grader identity. None of the following is installed, and the slice works without it: mining needs only items 6 and 7, and validation needs items 1 to 5 and 7.

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
