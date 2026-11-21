# Objective Record Implementation Plan (INF-200)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every goal and every standalone run one versioned objective record that says what "done" means, who changed it, and how.

**Architecture:** The record is a field of the sealed goal record and of the sealed run record, beside `goal` and `run`, never inside them. Pure modules build it, validate it, append directions from steering, and rebuild past versions from its log. Later slices add owner corrections, the record digest in prompts, the intent check, tests, verdicts, follow-ups, and finding measures, each behind its own setting.

**Tech Stack:** TypeScript, `zod`, `node:crypto`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-13-objective-record-design.md`, under the shared contracts in `docs/superpowers/specs/2026-11-12-self-improving-teams-design.md` (C1, C3, C11, C14).

This plan grows one section per slice. Each slice is one pull request.

## Global Constraints

- Node.js 22.14 or later. No new dependency.
- A record failure never blocks or changes a goal, a goal cycle, a run, or a routine. A write that decides something reads the stored record strictly, or does not write.
- Record text lives only in sealed goal and run records (C1). No plain column, log line, or error body holds it.
- Only owner directions bind (C3). Member text never enters the record before step 4, and then only as a labelled claim.
- No prompt byte changes before the slice that says so (step 2). A setting that changes what a run does lives inside `RoutineService.authority` (C11); every other setting stays out of it, as `teams.outcomes` does.
- No home path, host name, account name, or secret in any tracked file (`AGENTS.md`).
- Focused tests run with `node --import tsx --test tests/FILE.test.ts`. The coordinator runs the full check `npm run check` once per slice.

## Slices

| Slice | Content | Needs |
|---|---|---|
| The record | Schema, validation, storage in sealed goal and run records, migration, the log, the reads and the CLI read. This section | main |
| Owner ops and prompts | `POST …/record` for criteria, creation `criteria`, the record digest in prompts and the context file behind a project switch. Its section moves the `evaluators` lineup slot to the intent check and leaves the store module out | The record |
| The intent check | The role, the report, item application, the batched question, the corrected plan, derived criteria | Owner ops and prompts; autonomy mode (C12) |
| Tests and proposals | Command, artifact, citation, and owner tests; member proposals | The intent check; blackboard member tools (C17) |
| Verdicts | The evaluator, composition, `provisional-met`, `objective_verdicts` | Tests and proposals; C19 |
| Follow-ups | Report fields, the scope check, the idea queue, the bound | Verdicts |
| Finding measures | Citation checks, `uses`, scout ratings, the scout cell | Verdicts; C16 |

---

# Slice: the record

Spec part 1 (the record, creation, storage, the log), part 2 (steering), part 3 (the assumption types, as schema only), and part 8 (the two reads and the CLI read form), delivery order 1, with acceptance 1. After it, every goal and every standalone run that has an accepted plan holds a record: the owner's objective, success text as `c0`, non-goals, evidence, paths, and one direction per steering message, each change logged. Any paired device reads it, or any past version of it, through `GET /api/goals/:id/record`, `GET /api/teams/:id/record`, and `infinite goal record ID`. It builds on main as it is; no other slice of this plan must merge first.

**The record sits beside the goal and the run, never inside them.** `objectiveRecord?: unknown` is a field of each service's sealed `Stored`, not of `ProductGoal`, `TeamRun`, `TeamGoalContext`, or `TeamView`. So no view, prompt, member, fingerprint, or authority digest sees it, and this slice changes no prompt byte and nothing a run does. *(My call: the design says only that the record lives in the sealed record. A field of `ProductGoal` would reach every goal view and its tracker mirror; a field of `TeamRun` would reach `TeamView` and `ownerAuthorityHash`.)*

**Directions mirror steering, and one pure function writes them.** `syncDirections` appends a direction `s<revision>` for each steering entry that has none, in steering order. Creation, migration, a run's first plan, live steering, and the repair after a rollback all call it, so they give the same directions. A live steer logs `direction.appended` by the owner; every other call logs `direction.copied` by the host. A controller device's steer is logged as actor `owner`, because the log has no controller actor and today's prompt already prints it as a user direction. *(My call: the design names steering as the only writer of directions in step 1, and says nothing of an older host that steers after a rollback. Copying keeps the record in step with steering whatever happened between two loads.)*

**A goal migrates at load, and the migration write changes no goal field.** The constructor builds the record, then writes the sealed file directly with `writeSealed`, bypassing `save`, so `updatedAt`, `revision`, events, receipts, and every digest stay as they were. A failed write keeps the record in memory, leaves the save digest at its pre-load value so the goal's next change writes it, and warns once with a count. A goal whose fields do not fit the record keeps working without one and says so in one goal event. *(My call on timing and the write: the design says "on load". A lazy migration at first read would make a read path write; one at the next change would leave idle goals without a record.)*

**A standalone run gets its record at its first accepted plan; goal cycle runs and mission subteams never hold one.** The build sits inside the plan's completion callback, after `run.status = "implementing"`, so the plan and the record share one sealed write. A throw there would block the run (`operation` catches it and calls `block`), so every helper returns a result and never throws. A goal cycle's directions live in its goal's record. *(My call for mission subteams: the design names standalone runs, and "whether a mission should hold a record" is left to the builder. A subteam's steering is the mission coordinator's text, which C3 makes a claim, so a record built from it would mark a claim as the owner's direction.)*

**Nothing in this slice waits for a writer that does not exist yet.** The evidence store module `objective` (`objective_log`, `objective_values`), owner `criteria` at goal creation, and the command-membership and blob-recording rules move to step 2 with their first writer. A direction whose log value is above 2 KiB refers to the record's own copy, `{ ref: "record:direction:<id>", digest, bytes }`, because directions are append-only and a rebuild only removes them. *(My call, against part 1 "Creation", which adds `criteria` to `createGoalSchema` now: criteria that reach no prompt or verdict until step 2 would tell the owner that something checks them. Every step-1 record has at most 21 log entries, far under the 400-entry cap, so nothing overflows.)*

**Rulings before the build.**

- Line numbers in this section were read on main before the cost-coverage fix. Find each place by the quoted code, not by its number.
- `OBJECTIVE_LIMITS` holds the design's values. The owner can change a value later in that one block.
- The relay refuses both reads, and no mission holds a record, until the owner decides otherwise.
- Both services load a sealed record without a strict parse. So an older host keeps `objectiveRecord` and `objectiveNotice` in a record it saves, and a rollback loses nothing.

**Rulings after the first review.**

- **A handoff run holds no record.** Its objective is text that the host composes from the user's request, the agent's proposed continuation, and the host's own instructions (`handoffObjective`). A record would mark all of it as the owner's words. `planRunObjective` and `steerRunObjective` answer `handoff-owned`, and a read answers 409 `objective-record-of-handoff`. So only a run without `goal`, `missionId`, and `handoff` holds a record, the same test that `teams.ts` uses for a standalone run.
- **A `command` check holds a digest.** `command` is 64 lower-case hex characters in a criterion's check and in an assumption's test, as "Formats" says. The record never holds command text.
- **A continuation never leaves a cleared notice behind.** `continueRun` copies its working record back with `Object.assign`, which cannot remove a key, so it removes `objectiveNotice` itself when the working record has none. This is the eighth and last line this slice adds to `teams.ts`.
- **The first-plan test steers through the service.** A record built at a steer before the first plan must fail `a run's record starts at its first accepted plan`.

**Rulings after the independent review (round 1) and the full check.**

- **A failed migration write leaves the goal clean.** After a failed write at load, the goal's save digest is the digest with the record, so no tick sees a change that only the migration made, and no tick tries the write again. The record stays in memory, is written with the goal's next real save, and is built again at the next load if no save came. A real change of the goal still fails as it did before when the folder cannot be written. (The first version kept the digest of the stored file. The next tick's save then failed, the tick blocked the goal, and a pending control never reached its team.)
- **A stored record's direction history must agree with its directions.** The strict reader answers `record-invalid` for a record whose log entries of `direction.appended` and `direction.copied` do not name, in log order, exactly the directions of source `steering` in their own order, each once, each with the direction's own log value and a version above the one before. `rebuildVersion` answers 409 `objective-version-unavailable` for an undo whose target is not a direction of the record. So a damaged log never makes a version that did not exist, and the host never writes to such a record.
- **A list, a read of one goal or run, and a tick with nothing to do parse no record.** One test wraps `objectiveRecordSchema` to count parses and holds the count at zero over `goals.list()`, `goals.get(id)`, `teams.list()`, `teams.get(id)`, and one tick. Only the two record reads parse.
- **The migration writes a legacy goal once at load, so the autonomy test compares fields, not bytes.** `tests/autonomy-pins.test.ts` `a goal recorded before this slice is not rewritten at load` compared the sealed file's bytes, which the migration now changes once. It keeps its meaning under the name `a goal recorded before this slice keeps its fields at load`: the unsealed `goal`, `receipts`, and `fingerprint` equal what was written, and the goal holds no `autonomy` key.

**Where the design and the code disagree.**

- Part 1 says `successCriteria` holds "4,000 characters of up to 4 bytes each". `zod` counts UTF-16 code units, and one unit is at most 3 UTF-8 bytes, so the bound is 12,000 bytes. The 16,000-byte bound of `c0` holds with room. The spec is amended.
- Part 1's `digest` is "SHA-256 of the canonical record without `log`". It must also leave out `digest` itself.
- The `Assumption` type has no state, so "32 active assumptions" is a cap on all assumptions.
- No `GoalService.authority` exists. Goals have no approval digest; the routine approval digest is `RoutineService.authority(project)` in `routines.ts`, which reads project and team configuration only.
- No `infinite goal` command exists; this slice adds it. The client's `HttpError` carries the status and the code, never the host's message, so each reason a read can fail has its own code.
- The design does not mention the relay. `allowedPath` in `remote-access.ts` already refuses both `/record` paths, as it refuses the outcome routes.

## Trust boundary, and what a review checks

The builder, the migration, the reads, and the CLI are host code. These inputs originate outside the host:

- **Goal creation fields** come from an owner device (`POST /api/goals`). `createGoalSchema` bounds each field and the request to 40,000 bytes. The record copies the objective, success text, non-goals, evidence, and allowed paths without change.
- **Steering text** comes from an owner or controller device: goal steering (8,000 characters, at most 20 entries and 24,000 bytes with the objective), team steering, and a continuation's text (8,000 characters, at most 20 entries and 32 KiB). The record copies it into a direction. It reaches no plain column and no log line.
- **Stored records** come from disk. A goal or run record may lack the field (written before this change), hold a record that an older host did not update after a rollback, hold a record of a newer schema, or hold a damaged value. The host reads each strictly. A record it cannot read, or one from a newer host, is kept as the same JSON value and never rewritten, and the goal or run works as before.
- **Read requests** come from any paired device: owner, controller, or viewer. The query holds a UUID and an optional version. The response holds the goal's or run's own text, which the same devices already read through `GET /api/goals/:id` and `GET /api/teams/:id`, so no device reads anything new. Error bodies hold a code and a fixed sentence, never record text.
- **Members** read nothing new and write nothing. A plan report triggers a run's record, which holds the project manager's member id as a handle and no report text.

The relay refuses both reads with no code change. This slice runs no Git command, adds no setting, and uses no evidence store.

**What writes the record, and nothing else.** `GoalService.create`, the `GoalService` constructor, `GoalService.steer`, the plan branch of `TeamService.consume`, `TeamService.steer`, and `TeamService.continueRun` with text. No other path writes it: not a decision answer (goal, team, or mission), pause, resume, cancel, extend, outcome, parallelism, reconciliation, the tracker refresh, or a goal tick. *(My call for answers: a decision answer replies to a member's question. The design turns answers into record changes only for the intent check's questions, in step 3.)*

**Digests the record could change.**

| Digest | Changes? |
|---|---|
| The goal's save digest (`digest(stored)` in `goals.ts`) | Once per goal, at migration. It causes the one direct write |
| The goal's `fingerprint` and action receipts | No: `createGoalSchema` and the action bodies are unchanged |
| The goal's `revision` and `updatedAt` | No: the migration write bypasses `save` |
| The team create fingerprint of a goal cycle (`createRun` over the request, the goal context, and the lineup) | No: `TeamGoalContext` gains no field. Step 2, which adds the digest to that context, must keep a persisted `launch` replayable |
| `ownerAuthorityHash(run)` | No: the record is outside `run` |
| `RoutineService.authority(project)` and the routine fingerprint | No: no setting and no request field |
| Prompt bytes | No: `team-prompts.ts` and `team-mcp.ts` import no record module (test) |

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| Create a goal, steer it twice, replay the second steer, restart | Version 3 with `s2` and `s3`; the replay changes nothing; the restart writes nothing | Task 3 `steering appends a direction and changes nothing else` |
| A goal from before this change, with two steering entries, a pending launch, and a pending control, loaded twice | Version 3: `record.migrated` and two `direction.copied`; the goal, fingerprint, receipts, launch, and control unchanged; the second load writes nothing | Task 3 `a legacy goal migrates once at load and keeps its fields` |
| A record written, then an older host steers, then this host loads twice | The missing direction is copied once | Task 3 `a direction steered by an older host is copied once` |
| The record built after 0, 1, 2, or 3 of three steering entries, and synced again | The same directions, version, and digest every time; a repeated sync returns the same object | Task 2 `directions follow steering however the record was built` |
| The migration write fails at load | The host starts; the record is in memory; one warning; the goal's next change writes it | Task 3 `a failed migration write never stops the host` |
| A stored record that does not parse, or one from a newer host | Kept as the same JSON value through load, steer, and save; one event; reads answer 409 | Task 2 `a stored record is read strictly`; Task 3 `an unreadable record is kept and never rewritten` |
| A goal whose fields do not fit the record | The goal works without one; one event; reads answer 409 `objective-source-invalid` | Task 3 `a goal that cannot migrate keeps working and says so` |
| A standalone run steered before its first plan, then steered again | The record starts at the plan with the earlier direction copied; the later one is appended | Task 4 `a run's record starts at its first accepted plan` |
| A refused plan | No record | Task 4 `a refused plan makes no record` |
| A goal cycle run or a mission subteam | No record of its own; reads answer 409 | Task 4 `a goal cycle run has no record of its own`; Task 5 `objective record reads on a goal` |
| A run record that does not parse, or a run objective that does not fit | The plan and the steer proceed; one event; the record unchanged or absent | Task 4 `an unreadable or unbuildable record never blocks a plan or a steer` |
| The host stops between a plan's check and its save | Neither or both: one `save` writes the plan and the record | By construction, no new test |
| A removed run | Its record leaves with its sealed file; reads answer 404 `team-not-found` | Task 4 `a removed run takes its record with it` |
| A rebuild of every version after up to 20 steering entries | Each equals the record as it was at that version | Task 2 `every version rebuilds to what it was` |
| An unavailable evidence store | No effect: this slice reads and writes no store | None |

Outside this slice: owner corrections, prompts, every client screen, relay access, and records for mission subteams.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/objective-types.ts` (create) | Pure: `OBJECTIVE_LIMITS`, the zod schema of parts 1 and 3, the record-level rules, `recordDigest`, `cappedBytes`, `canonicalBytes` |
| `packages/host/src/goal-types.ts` (modify) | The `scopedPath` predicate becomes the exported `isScopedPath`; no behaviour change |
| `packages/host/src/objective-record.ts` (create) | Pure: build from a goal or a run, `syncDirections`, `logValue`, `readStoredRecord`, `rebuildVersion`, `recordView`, error codes, `noticeFor` |
| `packages/host/src/objective-goals.ts` (create) | The goal holder: create, load, steer, view, event texts |
| `packages/host/src/objective-runs.ts` (create) | The run holder: plan, steer, view, event texts |
| `packages/host/src/goals.ts` (modify) | Two `Stored` fields, the constructor migration, one line each in `create` and `steer`, `objectiveRecord` |
| `packages/host/src/teams.ts` (modify) | At most 8 lines, listed in Task 4 |
| `packages/host/src/objective-cli.ts` (create) | `infinite goal record`: the request, the error texts, the lines |
| `packages/host/src/client.ts` (modify) | 4 lines, listed in Task 6 |
| `packages/host/src/objective-routes.ts` (create) | The two `GET` routes |
| `packages/host/src/server.ts` (modify) | 2 lines, listed in Task 5 |
| `docs/teams.md`, the spec (modify) | The record, the reads, and the amendments |
| `tests/objective-{types,record,goals,runs,cli}.test.ts` (create); `tests/{goals,teams,remote-access}.test.ts` (modify) | Pure rules, the services, the host |

**Order and owners.** Task 1 runs first. Task 2 needs Task 1. Then Tasks 3, 4, and 6 run in parallel: each needs only Task 2's interfaces. Task 5 runs last and needs Tasks 3, 4, and 6. Each file has one writer.

## Review Focus

1. A record failure that blocks or changes a goal or a run: a throw inside the plan's completion, a constructor that throws on a bad record, a refused steer, an event added twice. Expect the goal or run to proceed and one event (Task 3 `a goal that cannot migrate keeps working and says so`, `a failed migration write never stops the host`; Task 4 `an unreadable or unbuildable record never blocks a plan or a steer`).
2. A migration that changes what gates work: the goal's `revision`, `updatedAt`, events, fingerprint, receipts, pending launch or control; or a field of `TeamGoalContext`, `TeamRun`, or a prompt. Expect none (Task 3 `a legacy goal migrates once at load and keeps its fields`; Task 1 `team prompts never import the record`; the existing goal and team-event tests, run unchanged).
3. Directions out of step with steering: missing, doubled, or reordered after a rollback, a replayed request, or a run steered before its plan. Expect one direction per steering entry, in order (Task 2 `directions follow steering however the record was built`; Task 3 `a direction steered by an older host is copied once`; Task 4 `a run's record starts at its first accepted plan`).
4. A record where it must not be: on a goal cycle run or a mission subteam, in `TeamView` or the goal view, or through the relay. Expect none (Task 4 `a goal cycle run has no record of its own`, `the run view carries no record`; Task 3 `a new goal gets record version 1 with c0 only`; Task 5 `the relay refuses objective records`).
5. A newer or damaged record overwritten, or a past version rebuilt wrong. Expect the stored value unchanged and every rebuild equal to its snapshot (Task 3 `an unreadable record is kept and never rewritten`; Task 2 `every version rebuilds to what it was`, `a rebuild refuses what it cannot undo`).

### Task 1: the schema and its limits

**Files:** `packages/host/src/objective-types.ts`, `packages/host/src/goal-types.ts` (the `scopedPath` line only), `tests/objective-types.test.ts`. Runs first.

**Interfaces (produces):** pure, no I/O, no clock.
```ts
export const OBJECTIVE_SCHEMA_VERSION = 1;
export const RUBRIC_VERSION_DEFAULT = 1;
/** Every cap of the design's owner decisions, in one place. Values to confirm. Each group names the step that first reads it. */
export const OBJECTIVE_LIMITS = {
  // Owner decision 1. Step 1.
  cappedBytes: 32 * 1024, activeCriteria: 8, assumptions: 32, openQuestions: 8, definitions: 16, rules: 16, logEntries: 400, logBytes: 256 * 1024,
  // Owner decision 2. Step 3.
  intentItems: 16, scoutQuestions: 3, intentChecksPerRevision: 1,
  // Owner decision 3. Step 6.
  followUpsPerReport: 6, openFollowUps: 24, followUpGeneration: 3, repeatWindowCycles: 10, ideas: 20,
  // Owner decision 4. Step 4.
  newAssumptionsPerAttempt: 4, proposalsPerAssumption: 8,
  // Owner decision 5. Step 7: the finding's run plus this many later cycles.
  usedWindowCycles: 1,
  // Field bounds of parts 1 and 3.
  c0Bytes: 16_000, criterionBytes: 1_000, derivedFromBytes: 500, assumptionBytes: 500, noteBytes: 500, inlineValueBytes: 2 * 1024,
  evidenceHandles: 16, pinnedPaths: 8,
  // Builder bounds (my call). Each is at or above the API that feeds it.
  criteria: 64, questions: 64, questionAssumptions: 16, allowedPaths: 32, excludedPaths: 32, pathChars: 300, nonGoals: 20, nonGoalChars: 1_000,
  ownerEvidence: 20, evidenceChars: 2_000, directions: 40, directionChars: 8_000, goalObjectiveChars: 12_000, runObjectiveChars: 24_000,
  termBytes: 100, meaningBytes: 1_000, ruleBytes: 1_000, questionBytes: 1_000, summaryBytes: 500, handleChars: 200,
} as const;
export type ObjectiveOwner = { kind: "goal"; goalId: string } | { kind: "run"; runId: string };
export type Direction = { id: string; text: string; source: "steering" | "correction"; at: string };
export type Threshold = { kind: "pass" } | { kind: "count"; min?: number; max?: number } | { kind: "share"; min: number } | { kind: "score"; min: number; of: 5 };
export type Check =
  | { kind: "command"; command: string }
  | { kind: "receipt"; receipt: "checks-passed" | "review-approved" | "merged" | "landed" }
  | { kind: "artifact"; path: string; schema?: string; count?: string }
  | { kind: "citations" | "citation-form"; path: string; entries: string; perEntry: number }
  | { kind: "judgement"; item: string }
  | { kind: "owner-rating"; subject: string };
export type Criterion = { id: string; origin: "owner" | "derived"; derivedFrom?: string; statement: string;
  /** Only on a run's c0: the statement is `statement.objective`, which is not copied. */
  statementOf?: "objective";
  check: Check; producer: "host" | "evaluator" | "owner"; threshold: Threshold; pinned?: { path: string; blob: string }[];
  latest?: { state: "met" | "not-met" | "inconclusive" | "pending-owner"; note?: string; verdictId: string }; state: "active" | "retired" };
export type AssumptionTest =
  | { kind: "command"; command: string; refutesOn: "fail" | "pass" }
  | { kind: "artifact"; path: string; count: string; citedPerEntry?: number; threshold: Threshold }
  | { kind: "citation"; source: string; quote: string; refutesOn: "absent" | "present" }
  | { kind: "owner"; rating?: { subject: string; below: number } };
export type Assumption = { id: string; statement: string; status: "verified" | "assumed" | "refuted" | "unchecked";
  origin: "intent-check" | "member" | "owner"; criticality: "outcome" | "plan" | "detail"; refutedBy: string; test: AssumptionTest;
  evidence: string[]; proposals: { entryId: string; stance: "supports" | "contradicts"; summary: string; authorRole: string }[];
  question?: string; ownerPinned?: boolean };
export type Question = { id: string; text: string; assumptions: string[]; waits: boolean; decisionId?: string;
  state: "open" | "answered" | "dismissed" | "default-kept" };
export type LogValue = { inline: unknown } | { ref: string; digest: string; bytes: number };
export type LogEntry = { seq: number; at: string; version: number;
  actor: "host" | "owner" | "intent-check" | "coordinator" | "evaluator" | "member"; authority: "receipt" | "direction" | "claim";
  op: string; target: string; before?: LogValue; after?: LogValue; handle?: string };
export type ObjectiveRecord = { schemaVersion: 1; owner: ObjectiveOwner; version: number; digest: string;
  statement: { objective: string; directions: Direction[] }; definitions: { id: string; term: string; meaning: string }[];
  constraints: { allowedPaths: string[]; excludedPaths: string[]; rules: { id: string; text: string }[] };
  nonGoals: { id: string; text: string }[]; ownerEvidence: string[]; criteria: Criterion[]; assumptions: Assumption[];
  questions: Question[]; rubricVersion: number; log: LogEntry[] };
export const objectiveRecordSchema: z.ZodType<ObjectiveRecord>;
/** SHA-256 hex of the canonical record without `log` and `digest`. */
export function recordDigest(record: Omit<ObjectiveRecord, "digest" | "log"> & Partial<Pick<ObjectiveRecord, "digest" | "log">>): string;
/** The bytes that count against `cappedBytes`: everything but the log, the digest, the statement, non-goals, owner evidence, and c0's statement. */
export function cappedBytes(record: ObjectiveRecord): number;
/** UTF-8 bytes of canonicalJson after a JSON round trip, which drops undefined values. */
export function canonicalBytes(value: unknown): number;
// goal-types.ts
export function isScopedPath(value: string): boolean;   // the predicate of `scopedPath`, which now calls it
```

**Decisions:**

- **Strict, with no transform and no default,** at every level, so a parse returns its input unchanged and an unknown key fails. A stored record is read, never repaired.
- **Formats.** Ids: `/^[a-z][a-z0-9-]{0,39}$/`. A goal id and a run id: `z.uuid()`. Times: `z.iso.datetime()`. Handles, entry ids, and refs: `/^[A-Za-z0-9:._-]{1,200}$/`. `op`: `/^[a-z]+(?:[.-][a-z]+)*$/`, at most 64 characters. A command digest: 64 hex. A blob: 40 or 64 hex. A JSON pointer: `/^(?:\/[^/\x00-\x1f]{1,64}){1,8}$/`. A path: `isScopedPath`, at most 300 characters, with no trim. `decisionId` and `verdictId`: UUIDs. `authorRole`: an id. `perEntry` and `citedPerEntry`: integers 1 to 8. `count` bounds: integers 0 to 1,000,000, at least one of them, `min` ≤ `max`. `share.min`: 0 to 1. `score.min`: integer 1 to 5. `below`: integer 1 to 5. `rubricVersion`: integer 1 to 1,000. `version` and `seq`: integers from 1.
- **Text bounds.** Bytes are UTF-8 bytes, checked by refine: c0 of a goal 1 to 16,000; another criterion's statement 1 to 1,000; `derivedFrom` 1 to 500; an assumption's `statement` and `refutedBy` 1 to 500; `note`, a proposal `summary`, a citation `source` and `quote` 1 to 500; `term` 1 to 100; `meaning`, a rule, a question 1 to 1,000. Characters, as the APIs count them: a goal objective 1 to 12,000, a run objective 1 to 24,000, a direction 1 to 8,000, a non-goal 1 to 1,000, owner evidence 1 to 2,000.
- **Record rules** (one `superRefine`, each issue with a fixed message):
  1. Ids are unique across directions, definitions, rules, non-goals, criteria, assumptions, and questions, so a log `target` names one thing.
  2. **c0.** Exactly one criterion `c0`, with origin `owner`, state `active`, check `judgement` on item `owner-text`, producer `evaluator`, and threshold `pass`. On a goal record its statement is 1 to 16,000 bytes and `statementOf` is absent. On a run record its statement is `""` and `statementOf` is `objective`. No other criterion has `statementOf`.
  3. **Producer and threshold fit the check** (part 1): `command`, `receipt`, `artifact`, `citations`, and `citation-form` need producer `host`; `judgement` needs `evaluator`; `owner-rating` needs `owner`. The threshold is `pass` for a command, a receipt, a judgement, or an artifact without `count`; `count` for an artifact with `count`; `share` for both citation checks; `score` for an owner rating. *(My call for an artifact without `count`: the design names no threshold for it, and `pass` is "the file exists and validates".)*
  4. **Derived criteria quote the statement.** `origin` `derived` needs `derivedFrom`, which is a substring of `statement.objective` or of one direction's text. `origin` `owner` has no `derivedFrom`.
  5. **Caps.** At most 8 active criteria and 64 in all; 32 assumptions; 8 open questions and 64 in all; 16 definitions; 16 rules; 32 excluded paths; 32 allowed paths, at least 1; 20 non-goals; 20 owner evidence entries; 40 directions; 8 pinned paths per criterion; 16 evidence handles and 8 proposals per assumption; 16 assumptions per question, each naming an assumption of the record. `cappedBytes` at most 32,768, with the message `objective-too-large`.
  6. **Assumptions.** `verified` and `refuted` need at least one evidence handle.
  7. **The log.** At least one entry and at most 400, with canonical bytes at most 256 KiB. `seq` rises strictly. Each entry's `version` equals the previous entry's or one more, and the last equals the record's `version`. An inline value has canonical bytes at most 2,048; a `ref` value has `bytes` above 2,048 and a 64-hex `digest`.
  8. **The digest.** `digest` equals `recordDigest(record)`.
- **Every valid goal fits the cap.** Owner text does not count, and 32 paths of 300 characters take at most 28,896 bytes, so a goal record without owner corrections stays under 30 KiB of capped bytes.

- [ ] **Step 1: Write the failing tests** in `tests/objective-types.test.ts`, with one helper `validGoalRecord()` and one `validRunRecord()` that set `digest` through `recordDigest`.

| Test name | Assertions |
|---|---|
| `a goal record and a run record parse unchanged` | Both parse, and each output deep-equals its input. An unknown key at the top, in a criterion, and in a log entry each fails. |
| `a criterion's producer and threshold fit its check` | Each check kind with its producer and threshold passes: command/host/pass, receipt `merged`/host/pass, artifact with `count` `/entries`/host/count 10 to 25, artifact without `count`/host/pass, `citation-form`/host/share 1, judgement/evaluator/pass, owner-rating/owner/score 4 of 5. Each fails: judgement with producer `host`, command with producer `evaluator`, producer `coordinator`, command with a count threshold, artifact with `count` and `pass`, count `{ min: 5, max: 4 }`, count `{}`. |
| `c0 is the owner's text` | A goal record without c0, with two c0, with c0 origin `derived`, c0 `retired`, c0 check item `method-applied`, c0 with `statementOf`, or c0 of 16,001 bytes fails; c0 of 16,000 bytes passes. A run record whose c0 has statement `x`, or lacks `statementOf`, fails. `statementOf` on `c1` fails. |
| `a derived criterion quotes the statement` | `derivedFrom` that is a substring of the objective passes; of a direction passes; not a substring fails; a derived criterion without it fails; 501 bytes fails; an owner criterion with it fails. |
| `the record's caps hold` | 8 active criteria and 3 retired pass; 9 active fail. 33 assumptions, 9 open questions (8 open and 2 answered pass), 17 definitions, 17 rules, 41 directions, and an id shared by a non-goal and a criterion each fail. A question naming an unknown assumption fails. Rules of 1,000 bytes that bring `cappedBytes` to 32,769 fail with the message `objective-too-large`; 32,768 passes. |
| `owner text does not count against the cap` | A goal record with an objective of 12,000 `é`, c0 of 16,000 bytes, 20 non-goals of 1,000 characters, 20 evidence entries of 2,000 characters, and 20 directions of 8,000 characters parses, and `cappedBytes` is below 2,048. 32 allowed paths of 300 `é` give `cappedBytes` below 30,720. |
| `the log is ordered and ends at the record's version` | Each fails: an empty log, `seq` 1 then 1, versions 1 then 3, versions 2 then 1, a last version of 2 on a record of version 3, 401 entries, a log of 257 KiB, an inline value of 2,049 canonical bytes, a `ref` value with `bytes` 2,048. Versions 1, 2, 2, 3 on a record of version 3 pass. |
| `a stored digest must match` | Changing any of the objective, a direction, c0, or `rubricVersion` after the digest was set fails. `recordDigest` is the same with a different log, a different `digest`, or keys in another order. |
| `assumptions and questions keep their rules` | `verified` with no evidence fails; `refuted` with one handle passes; 17 handles fail; 9 proposals fail; each test kind of part 3 parses. |
| `team prompts never import the record` | The import specifiers of `team-prompts.ts` and `team-mcp.ts` (the `importsOf` pattern of `tests/outcome-rules.test.ts`) contain none with `objective`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-types.test.ts` and `npm run typecheck -w @infinite/host`, then commit.

### Task 2: building, syncing, reading, and rebuilding

**Files:** `packages/host/src/objective-record.ts`, `tests/objective-record.test.ts`. Needs Task 1. Tasks 3, 4, and 6 start from its commit.

**Interfaces (produces):** pure, no I/O, no clock.
```ts
export type ObjectiveUnavailable = "source-invalid" | "record-invalid" | "record-newer";
export type ObjectiveState = { kind: "absent" } | { kind: "ready"; record: ObjectiveRecord }
  | { kind: "unavailable"; reason: "record-invalid" | "record-newer" };
export type SteeringEntry = { text: string; revision: number; at: string };
/** The steering entry that a live request appended, logged as the owner's direction. */
export type LiveDirection = { revision: number; handle: string };
export type ObjectiveRecordView = { owner: ObjectiveOwner; version: number; latestVersion: number; rebuilt: boolean;
  record: Omit<ObjectiveRecord, "log">; log: LogEntry[] };
export type ObjectiveErrorCode = "objective-record-absent" | "objective-source-invalid" | "objective-record-invalid" | "objective-record-newer"
  | "objective-record-of-goal" | "objective-record-of-mission" | "objective-version-not-found" | "objective-version-unavailable";
export const OBJECTIVE_ERRORS: Record<ObjectiveErrorCode, { status: 404 | 409; message: string }>;
export function objectiveError(code: ObjectiveErrorCode): TeamError;   // TeamError from team-workspace.ts
export function goalRecord(goal: ProductGoal, at: string, origin: "created" | "migrated", live?: LiveDirection): ObjectiveRecord | "source-invalid";
export function runRecord(run: TeamRun, at: string, handle: string): ObjectiveRecord | "source-invalid";
/** Appends one direction per steering entry that has none. Returns the same object when nothing is missing; never mutates its input. */
export function syncDirections(record: ObjectiveRecord, steering: readonly SteeringEntry[], at: string, live?: LiveDirection): ObjectiveRecord | "source-invalid";
export function logValue(value: unknown, ref: string): LogValue;
export function readStoredRecord(raw: unknown, owner: ObjectiveOwner): ObjectiveState;
/** Throws objectiveError: 404 `objective-version-not-found`, 409 `objective-version-unavailable`. */
export function rebuildVersion(record: ObjectiveRecord, version: number): ObjectiveRecord;
export function recordView(record: ObjectiveRecord, version?: number): ObjectiveRecordView;
/** The event text to add once, or undefined. Sets `objectiveNotice` on a new reason and clears it when the record is readable. */
export function noticeFor(holder: { objectiveNotice?: ObjectiveUnavailable }, result: string, events: Record<ObjectiveUnavailable, string>): string | undefined;
```

**Decisions:**

- **A goal record** (part 1 "Creation"): owner `{ kind: "goal", goalId: goal.id }`; `statement.objective` the goal's objective; `nonGoals` `n1` to `nN` in order; `ownerEvidence` the goal's `evidence` (or `[]`); `constraints` `{ allowedPaths: goal.allowedPaths, excludedPaths: [], rules: [] }`; `definitions`, `assumptions`, `questions` `[]`; `rubricVersion` 1; `criteria` one c0 with statement `successCriteria`. Its first log entry, at version 1, is `record.created` (actor `owner`, authority `direction`, target `record`, handle the goal id) or `record.migrated` (actor `host`, authority `receipt`, target `record`, no handle). Then `syncDirections` over `goal.steering` with `live`.
- **A run record:** owner `{ kind: "run", runId }`; `statement.objective` the run's objective; c0 with statement `""` and `statementOf: "objective"`; `allowedPaths` `["."]`; every list empty; first entry `record.created` (actor `host`, authority `receipt`, handle the project manager's member id). Then `syncDirections` over `run.steering`.
- **`syncDirections`.** For each steering entry, in array order, whose `s<revision>` is not a direction id: append `{ id: "s<revision>", text, source: "steering", at: entry.at }`, raise `version` by one, and append a log entry with the next `seq`, the new version, target the direction id, and `after: logValue(direction, "record:direction:<id>")`. The entry whose revision is `live.revision` logs `direction.appended`, actor `owner`, authority `direction`, handle `live.handle`; every other logs `direction.copied`, actor `host`, authority `receipt`. Then the digest is recomputed and the result is parsed with `objectiveRecordSchema`; a failure, or a steering entry that is not `{ text, revision, at }` with the formats of Task 1, returns `source-invalid` and leaves the input untouched. In this slice `version` is one more than the number of directions.
- **`logValue`.** Canonical bytes at most 2,048 give `{ inline: <JSON clone> }`; above, `{ ref, digest: sha256 hex of canonicalJson(value), bytes }`.
- **`readStoredRecord`.** `undefined` is `absent`. An object whose `schemaVersion` is an integer above 1 is `record-newer`. Anything else that fails the schema, or whose owner differs from `owner`, is `record-invalid`.
- **`rebuildVersion`.** A version below 1 or above the record's gives 404. A version below the first log entry's version gives 409 (the log no longer reaches it). Otherwise it undoes the entries above the version in descending `seq`: `direction.appended` and `direction.copied` remove the direction named by `target`; any other op gives 409. Then it sets `version`, keeps the log entries up to the version, and recomputes the digest. *(My call: step 2 adds an undo for each op it introduces. Until then a host refuses a rebuild across an op it does not know, rather than return a record that never existed.)*
- **`recordView`** gives `rebuilt: true` only when a version other than the latest is asked for. `record` is the record without `log`.
- **`noticeFor`.** A reason equal to `objectiveNotice` returns nothing; another reason sets it and returns its text. `built`, `synced`, and `unchanged` clear it and return nothing. Any other result (`goal-owned`, `mission-owned`) changes nothing. So each reason adds one event however often the host loads or steers.
- **Codes and fixed messages.** `objective-record-absent` 404 "This run has no objective record yet. It gets one at its next accepted plan." `objective-source-invalid` 409 "The objective record could not be built from these fields." `objective-record-invalid` 409 "The stored objective record cannot be read. It is kept unchanged." `objective-record-newer` 409 "A newer host wrote this objective record. Upgrade the host to read it." `objective-record-of-goal` 409 "This run belongs to a goal. Read the goal's record." `objective-record-of-mission` 409 "A mission subteam has no objective record." `objective-version-not-found` 404 "The record has no such version." `objective-version-unavailable` 409 "This host cannot rebuild that version of the record." No message holds record text.
- **Response size.** A goal's owner text is bounded by its 40,000-byte request and its 24,000-byte steering limit; a run's by its 24,000-character objective and 32 KiB of steering. With at most 21 log entries of at most about 2.2 KiB each, a view is at most about 160 KiB in this slice. Under the design caps it can reach about 400 KiB; paging waits for the slice that makes records that large.

- [ ] **Step 1: Write the failing tests** in `tests/objective-record.test.ts`, with goal and run literals from one helper.

| Test name | Assertions |
|---|---|
| `a goal record holds the owner's words as c0` | A goal with success text `A ranked shortlist with reasons and sources`, non-goals `["no paid sources", "no personal data"]`, evidence `["notes.md"]`, paths `["research"]`, no steering, origin `created` at T: version 1; c0 statement equal to the success text, check `{ kind: "judgement", item: "owner-text" }`, producer `evaluator`, threshold `pass`, origin `owner`; non-goal ids `n1`, `n2`; owner evidence and paths copied; every other list `[]`; `rubricVersion` 1; one log entry `{ seq: 1, at: T, version: 1, actor: "owner", authority: "direction", op: "record.created", target: "record", handle: goal.id }`; the schema parses it. With origin `migrated`, the entry is `actor: "host"`, `authority: "receipt"`, `op: "record.migrated"`, no handle, and the rest is equal. |
| `a run record refers to its objective` | A run with an objective of 24,000 characters and member id M: c0 statement `""` and `statementOf` `objective`; `statement.objective` equals the run's objective; paths `["."]`; the first entry `record.created` by `host` with handle M; `cappedBytes` below 2,048. |
| `directions follow steering however the record was built` | Steering `s2`, `s3`, `s4` with distinct texts and times. For each k in 0, 1, 2, 3: a goal record built with the first k entries, then each later entry synced live with its own handle. All four results have equal `statement.directions` (ids `s2`, `s3`, `s4`, the steering texts and times), version 4, and digest. Their logs have k `direction.copied` entries, then 3 − k `direction.appended`. A sync with the same steering returns the same object (`===`). One sync that misses `s3` and `s4` copies both, in order. No call mutates its input (deep-equal to a clone taken before). |
| `a long direction is logged by reference to the record` | A direction of 2,000 `é` (4,000 bytes): `after` is `{ ref: "record:direction:s2", digest, bytes }`, with `digest` the SHA-256 of its canonical JSON and `bytes` its canonical bytes. A direction of 100 characters: `after.inline` deep-equals the direction. |
| `every version rebuilds to what it was` | Seeds 1 to 50, through a mulberry32 generator: 0 to 20 steering entries, each of 1 to 8,000 characters, each synced in its own call, live or copied by a coin. A snapshot is taken after the build and after each sync. For every version v from 1 to the last, `rebuildVersion(last, v)` deep-equals snapshot v, and its digest equals `recordDigest` of it. |
| `a rebuild refuses what it cannot undo` | A record whose log holds an op `criterion.derived` at version 3 (built in the test with a valid derived criterion): a rebuild to 3 works; to 2 throws 409 `objective-version-unavailable`. Version 0 and the latest plus 1 throw 404 `objective-version-not-found`. A record whose log starts at version 3 refuses version 2 with 409. |
| `a stored record is read strictly` | `undefined`: `absent`. A valid record: `ready`, deep-equal. An unknown key, a wrong digest, another goal's id, a string, and `{ schemaVersion: "2" }`: `record-invalid`. `{ schemaVersion: 2, future: true }`: `record-newer`. |
| `the view returns a version and its log` | A record of version 3: `recordView(record)` has version 3, `latestVersion` 3, `rebuilt` false, no `log` key in `record`, and 3 log entries. `recordView(record, 2)`: version 2, `latestVersion` 3, `rebuilt` true, 2 entries, one direction. |
| `a source outside the record's bounds is refused` | Each gives `source-invalid`: success text of 16,001 bytes, 21 non-goals, a path `../x`, an objective of 12,001 characters, 41 steering entries, a steering entry with revision 0. A sync that would fail leaves its input deep-equal. |
| `the steering limit fits the log` | 20 live directions of 8,000 characters each: the record parses; 21 log entries; the log's canonical bytes below 16 KiB. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-record.test.ts` and the typecheck.

### Task 3: the goal's record

**Files:** `packages/host/src/objective-goals.ts`, `packages/host/src/goals.ts`, `tests/objective-goals.test.ts`. Needs Task 2. Runs in parallel with Tasks 4 and 6.

**Interfaces (produces):**
```ts
export type GoalHolder = { goal: ProductGoal; objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable };
export type GoalObjectiveResult = "built" | "synced" | "unchanged" | ObjectiveUnavailable;
export const GOAL_OBJECTIVE_EVENTS: Record<ObjectiveUnavailable, string>;
export function createGoalObjective(holder: GoalHolder, at: string): GoalObjectiveResult;
export function loadGoalObjective(holder: GoalHolder, at: string): GoalObjectiveResult;
export function steerGoalObjective(holder: GoalHolder, requestId: string, at: string): GoalObjectiveResult;
export function goalObjectiveNote(holder: GoalHolder, result: GoalObjectiveResult): string | undefined;   // noticeFor with GOAL_OBJECTIVE_EVENTS
/** Throws objectiveError for an absent, unreadable, or newer record, or a version it cannot give. */
export function goalObjectiveView(holder: GoalHolder, version?: number): ObjectiveRecordView;
// goals.ts
objectiveRecord(id: string, version?: number): ObjectiveRecordView;   // 404 goal-not-found first
```

**Decisions:**

- **One rule for load and steer.** Both read the stored value with `readStoredRecord`. `ready`: `syncDirections` over `goal.steering`, live for the newest entry when steering. `absent`: `goalRecord(goal, at, "migrated", live)`. `unavailable`: no change, and the reason is returned. A result other than a record leaves `objectiveRecord` untouched. `createGoalObjective` uses origin `created`.
- **Event texts, each added once through `objectiveNotice`.** `source-invalid`: "The objective record could not be built from this goal's fields. The goal works as before, without a record." `record-invalid`: "The stored objective record cannot be read. It is kept unchanged, and the goal works as before." `record-newer`: "A newer host wrote this goal's objective record. It is kept unchanged; upgrade the host to read it."
- **`goalObjectiveView`.** `absent` with notice `source-invalid` gives 409 `objective-source-invalid`; `absent` otherwise gives 404 `objective-record-absent` (unreachable after load). `unavailable` gives 409 with the reason's code. `ready` gives `recordView`. Reads touch memory only.
- **`goals.ts` changes, and nothing else:**
  1. The import of the six names above and `type ObjectiveUnavailable`.
  2. `type Stored` gains `objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable;` with the comment "The objective record (objective-goals.ts). Outside `goal`, so no view or digest reads it."
  3. The constructor: `let unsaved = 0;` before the loop. Lines 65–66 become:
     ```ts
     const before = digest(stored), note = goalObjectiveNote(stored, loadGoalObjective(stored, now()));
     if (note) this.event(stored, note);
     this.records.set(id, stored);
     if (digest(stored) === before) { this.saved.set(id, before); continue; }
     try { writeSealed(join(this.directory, file), key, `goal:${id}`, stored); this.saved.set(id, digest(stored)); }
     catch { this.saved.set(id, before); unsaved++; }
     ```
     After the loop: `if (unsaved) console.warn(\`Objective records of ${unsaved} goals could not be saved at startup. Each is saved with its goal's next change.\`);`
  4. `create`: after the `stored` literal and before its first `this.event`: `{ const note = goalObjectiveNote(stored, createGoalObjective(stored, createdAt)); if (note) this.event(stored, note); }`
  5. `steer`: after `goal.steering.push(…)` (line 324): `{ const note = goalObjectiveNote(stored, steerGoalObjective(stored, body.requestId, now())); if (note) this.event(stored, note); }`
  6. `objectiveRecord(id: string, version?: number) { return goalObjectiveView(this.record(id), version); }`
- `before` is taken after the legacy `stopReason` repair, as `saved` is today, so a goal that needs no record write is written no more often than before.

- [ ] **Step 1: Write the failing tests** in `tests/objective-goals.test.ts`, with `schedulerFixture()`, a local lineup, `f.config.projects[0].team = { checks: [{ command: "npm", args: ["test"] }] }`, a `GoalService` that is never started, and legacy goals written through `f.writeRecord("goal", id, { goal, receipts: {}, fingerprint: "fixture", ...extra })`.

| Test name | Assertions |
|---|---|
| `a new goal gets record version 1 with c0 only` | `goals.create` with success text `A ranked shortlist with reasons and sources`, non-goals `["no paid sources"]`, evidence `["notes.md"]`, paths `["research"]`: the sealed record's `objectiveRecord` parses; version 1; one criterion, c0, with that text; non-goal `{ id: "n1", text: "no paid sources" }`; one log entry `record.created` by `owner` with handle the goal id. `goals.get(id)` has no key `objectiveRecord` or `objectiveNotice`. `goals.objectiveRecord(id).version` is 1. |
| `steering appends a direction and changes nothing else` | Two steers, R1 `Prefer seed stage` and R2 `Exclude current holdings`: version 3; directions `s2` and `s3`; the last two entries `direction.appended` by `owner`, authority `direction`, handles R1 and R2; c0, non-goals, and paths deep-equal to before. A replay of R2 leaves the record deep-equal. A new `GoalService` over the same state leaves the sealed file's text byte-equal. |
| `a legacy goal migrates once at load and keeps its fields` | A goal without a record, `updatedAt` `2026-01-01T00:00:00.000Z`, revision 3, steering at revisions 2 and 3, and opaque `launch` and `control` literals. After `new GoalService`: version 3, ops `[record.migrated, direction.copied, direction.copied]` by `host`; `goal`, `fingerprint`, `receipts`, `launch`, and `control` deep-equal to what was written. A second `new GoalService` leaves the sealed file's text byte-equal. |
| `a direction steered by an older host is copied once` | A stored record at version 2 with `s2`, and steering `s2` and `s3`: after load, version 3 with one new `direction.copied` for `s3`. A second load leaves the sealed text byte-equal. |
| `a goal that cannot migrate keeps working and says so` | Success text of 16,001 `a`: the service starts; no `objectiveRecord`; the last goal event is the `source-invalid` text, once; a second load adds no event; `objectiveRecord(id)` throws 409 `objective-source-invalid`; a steer succeeds at revision 2 and adds no objective event. |
| `an unreadable record is kept and never rewritten` | Goal A with `{ schemaVersion: 1, junk: true }`, goal B with `{ schemaVersion: 2, future: "x" }`. After load and one steer of each, each stored value deep-equals what was written; A's events hold the `record-invalid` text once and B's the `record-newer` text once; reads throw 409 `objective-record-invalid` and `objective-record-newer`. |
| `a failed migration write never stops the host` | Skipped as root. A legacy goal, then the goals directory set to mode `0o500`, with `console.warn` stubbed: `new GoalService` does not throw; `objectiveRecord(id).version` is 1; the sealed file still has no `objectiveRecord`; one warning, which contains `1 goals` and no goal text. After mode `0o700` and a steer, the sealed file holds the record at version 2. |
| `only steering writes the record` | After `create`: `pause`, `resume`, `cancel`, and `outcome` with `not-achieved` each leave the stored record deep-equal to the record after `create`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-goals.test.ts` and the typecheck. On the host, run `tests/goals.test.ts`, because every goal it writes now migrates at load.

### Task 4: the run's record

**Files:** `packages/host/src/objective-runs.ts`, `packages/host/src/teams.ts`, `tests/objective-runs.test.ts`. Needs Task 2. Runs in parallel with Tasks 3 and 6.

**Interfaces (produces):**
```ts
export type { ObjectiveUnavailable } from "./objective-record.js";
export type RunHolder = { run: TeamRun; objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable };
export type RunObjectiveResult = "built" | "synced" | "unchanged" | "goal-owned" | "mission-owned" | ObjectiveUnavailable;
export const RUN_OBJECTIVE_EVENTS: Record<ObjectiveUnavailable, string>;
/** At an accepted plan. Builds the record when absent, otherwise syncs. Never throws. */
export function planRunObjective(holder: RunHolder, handle: string, at: string): RunObjectiveResult;
/** After a steer or a continuation with text. Syncs a ready record, live for the newest entry; an absent record waits for the next plan. Never throws. */
export function steerRunObjective(holder: RunHolder, requestId: string, at: string): RunObjectiveResult;
export function runObjectiveNote(holder: RunHolder, result: RunObjectiveResult): string | undefined;
/** 409 objective-record-of-goal or objective-record-of-mission first; then as goalObjectiveView. */
export function runObjectiveView(holder: RunHolder, version?: number): ObjectiveRecordView;
// teams.ts
objectiveRecord(id: string, version?: number): ObjectiveRecordView;   // 404 team-not-found first
```

**Decisions:**

- A run with `goal` gives `goal-owned`, one with `missionId` gives `mission-owned`, and neither changes the holder. `runObjectiveNote` returns no text for either.
- Both helpers catch every throw and return `record-invalid`, so a fault in them can never reach `operation`'s `block`.
- **Event texts,** once each through `objectiveNotice`: "The objective record could not be built from this run's fields. The run works as before, without a record." "The stored objective record cannot be read. It is kept unchanged, and the run works as before." "A newer host wrote this run's objective record. It is kept unchanged; upgrade the host to read it."
- A run that accepted its plan before this change has no record until its next accepted plan (a continuation or a steer brings one). Reads answer 404 `objective-record-absent` until then.
- **`teams.ts` lines, and nothing else** (at most 8):
  1. `import { planRunObjective, runObjectiveNote, runObjectiveView, steerRunObjective, type ObjectiveUnavailable } from "./objective-runs.js";`
  2. In `type Stored`, after `ledgerReplaces` (line 109): `/** The objective record of a standalone run (objective-runs.ts). Outside \`run\`, so no view, prompt, or digest reads it. */`
  3. Then: `objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable;`
  4. In the plan branch of `consume`, after `run.status = "implementing";` (line 4214): `const objectiveNote = runObjectiveNote(stored, planRunObjective(stored, member.memberId, timestamp())); if (objectiveNote) this.event(stored, objectiveNote);`
  5. In `steer`, after the steering push (line 1386): `const objectiveNote = runObjectiveNote(stored, steerRunObjective(stored, body.requestId, timestamp())); if (objectiveNote) this.event(stored, objectiveNote);`
  6. In `continueRun`, after the steering push on `next` (line 1755): `if (body.text) { const objectiveNote = runObjectiveNote(next, steerRunObjective(next, body.requestId, timestamp())); if (objectiveNote) this.event(next, objectiveNote); }`
  7. After `get(id)`: `objectiveRecord(id: string, version?: number) { return runObjectiveView(this.record(id), version); }`
- `continueRun` works on `next = structuredClone(stored)` and assigns it back, so a continuation that fails later leaves the record as it was.

- [ ] **Step 1: Write the failing tests** in `tests/objective-runs.test.ts`, with `schedulerFixture()`, `f.writeTeam(extra)`, `f.openTeam()`, and the plan-report helper of `tests/team-events.test.ts` (`internal(teams).consume(stored, member)`, then a wait for `pending` to clear), copied in.

| Test name | Assertions |
|---|---|
| `a run's record starts at its first accepted plan` | A standalone run at revision 2 whose steering holds `{ text: "Keep the API stable", revision: 2 }`: before the plan, `objectiveRecord(id)` throws 404 `objective-record-absent`. After an accepted plan: version 2; c0 with `statementOf` `objective`; directions `[s2]`; ops `[record.created, direction.copied]`, the first with handle the project manager's member id. A steer R `Add a changelog`: version 3, `s3` `direction.appended` by `owner` with handle R. The sealed run record holds the same record. |
| `a continuation appends a direction` | The continuation setup of `a continuation, a resume, and a recovery each name their cause` in `tests/team-events.test.ts`, copied, with the team written with `objectiveRecord: runRecord(run, at, "pm")` and the continuation sent with text `Ship the changelog too` and request id C: the record's last direction has that text, and its log entry is `direction.appended` with handle C. A continuation without text leaves the record deep-equal. |
| `a refused plan makes no record` | On a run written with `parallelismCeiling` 2, a plan with `parallelism` 3 is refused with `team-parallelism-limit` (`capacityCeiling` in `teams.ts` is not exported), and the sealed run record has no `objectiveRecord`. |
| `a goal cycle run has no record of its own` | A run with `goal` set: an accepted plan (with a brief, inside the goal's paths) stores no `objectiveRecord`, and `objectiveRecord(id)` throws 409 `objective-record-of-goal`. A run with `missionId`: an accepted plan and a service-level steer store none, and the read throws 409 `objective-record-of-mission`. |
| `an unreadable or unbuildable record never blocks a plan or a steer` | `objectiveRecord: { schemaVersion: 1, junk: true }`: the plan is accepted (status `implementing`, tasks set); the stored value deep-equals what was written; one run event with the `record-invalid` text; a steer succeeds and adds none. A run whose objective is 24,001 characters (written directly): the plan is accepted, no `objectiveRecord`, `objectiveNotice` `source-invalid`, one event. |
| `a removed run takes its record with it` | A cancelled, settled run with workspaces removed and a record: after `removeRun`, `objectiveRecord(id)` throws 404 `team-not-found` and the sealed file is gone. |
| `the run view carries no record` | After the first test's plan: `teams.get(id)` has neither `objectiveRecord` nor `objectiveNotice`, and its JSON does not contain `record.created`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-runs.test.ts tests/team-events.test.ts` and the typecheck.

### Task 6: the command

**Files:** `packages/host/src/objective-cli.ts`, `packages/host/src/client.ts`, `tests/objective-cli.test.ts`. Needs Task 2. Runs in parallel with Tasks 3 and 4.

**Interfaces (produces):**
```ts
type GoalApi = { json<T = unknown>(path: string, body?: unknown, signal?: AbortSignal, headers?: Record<string, string>, method?: string): Promise<T> };
export const GOAL_RECORD_USAGE = "Usage: infinite goal record ID [--version N] [--json]";
export async function handleGoalClientCommand(positional: string[], options: Record<string, string | boolean>, api: GoalApi): Promise<boolean>;
export function objectiveRecordLines(view: ObjectiveRecordView, goalId: string): string[];
```

**Decisions:**

- **`client.ts` lines, and nothing else:** the import of `handleGoalClientCommand`; `"goal"` joins `CLIENT_COMMANDS`; `"--version"` joins `CLIENT_STRING_OPTIONS` (no client option of that name exists); after the autonomy dispatch (line 891), `if (command === "goal") return await handleGoalClientCommand(positional, options, api);`.
- **The request.** `positional` must be `["record", ID]`; anything else throws the usage. `--version`, when given, must match `/^[1-9][0-9]{0,5}$/`, or the command throws `Give --version as a whole number of 1 or more.` before any request. The path is `/goals/<encodeURIComponent(ID)>/record`, with `?version=N` when given. `--json` prints the view with two-space indentation.
- **Errors.** `HttpError` is not exported, so the command reads `status` and `code` from the thrown value structurally. 404 `goal-not-found`: `No goal has this ID.` 404 `objective-version-not-found`: `The record has no version N.` 409 `objective-version-unavailable`: `This host cannot rebuild version N of the record.` 409 `objective-source-invalid`: `This goal's fields do not fit an objective record. The goal works as before, without one.` 409 `objective-record-invalid`: `The stored objective record cannot be read. The host keeps it unchanged.` 409 `objective-record-newer`: `A newer host wrote this objective record. Upgrade the host to read it.` 404 `objective-record-absent`: `This goal has no objective record yet.` 400: `The host refused the record query.` Another 404: `This host has no objective records. Upgrade the host.` Anything else is rethrown.
- **Lines,** in this order. Every text passes through one function that turns each control character into a space, with no length cut; the record bounds each text. (1) `Goal ID · record version V of L`, then ` · rebuilt` when rebuilt, then ` · digest <first 12 hex>`. (2) `Objective: TEXT`. (3) `Criteria:`, then per criterion `  ID ORIGIN STATE · CHECK · PRODUCER · THRESHOLD: STATEMENT`, where a run's c0 shows `(the objective)`. CHECK is `judgement ITEM`, `command <first 12 hex>`, `receipt NAME`, `artifact PATH`, `artifact PATH count POINTER`, `citations PATH`, `citation-form PATH`, or `owner rating SUBJECT`. THRESHOLD is `pass`, `count MIN to MAX`, `count at least MIN`, `count at most MAX`, `share at least MIN`, or `score at least MIN of 5`. (4) `Directions: none`, or `Directions:` and per direction `  ID SOURCE at AT: TEXT`. (5) `Non-goals: none`, or `Non-goals:` and `  ID: TEXT`. (6) `Allowed paths: P, P`. (7) `Excluded paths: none` or the list. (8) `Owner evidence: none`, or `Owner evidence:` and `  - TEXT`. (9) `Definitions N · rules N · assumptions N · open questions N of N`. (10) `Log:`, then per entry `  #SEQ v VERSION AT ACTOR AUTHORITY OP TARGET`. No line shows a log value.

- [ ] **Step 1: Write the failing tests** in `tests/objective-cli.test.ts`, with a fake `api` that records paths and throws `{ status, code }` objects.

| Test name | Assertions |
|---|---|
| `record lines show the record and its log` | A view of goal G, version 2 of 3, rebuilt, digest `abcdef0123456789…`, c0 `A ranked shortlist`, direction `s2` `Prefer seed stage`, non-goal `n1` `no paid sources`, paths `["research"]`, two log entries: the exact array of lines, starting `Goal G · record version 2 of 3 · rebuilt · digest abcdef012345` and ending `  #2 v 2 <at> owner direction direction.appended s2`. A direction text with `\u001b[31m` prints a space in place of the escape. |
| `the command reads a version and maps each error` | `["record", G]` requests `/goals/G/record`; with `--version 2`, `/goals/G/record?version=2`; `--json` prints parseable JSON with `version`. Each status and code above gives its sentence, with N replaced. `["record"]`, `["list", G]`, and `["record", G, "x"]` throw the usage; `--version 0` and `--version x` throw the version sentence, and the fake records no request. |
| `goal options parse` | `parseClientArgs(["goal", "record", G, "--version", "2", "--json"])` gives command `goal`, positional `["record", G]`, and `--version` `"2"`. `clientCommandCandidate(["--version", "2", "goal"])` is `goal`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-cli.test.ts tests/client-args.test.ts` and the typecheck.

### Task 5: the routes, the host tests, and the docs

**Files:** `packages/host/src/objective-routes.ts`, `packages/host/src/server.ts`, `docs/teams.md`, the spec, `tests/goals.test.ts`, `tests/teams.test.ts`, `tests/remote-access.test.ts`. Needs Tasks 3, 4, and 6.

**Interfaces (produces):**
```ts
export function objectiveRoutes(app: express.Express,
  services: { goals: Pick<GoalService, "objectiveRecord">; teams: Pick<TeamService, "objectiveRecord"> }, read: express.RequestHandler): void;
// GET /api/goals/:id/record[?version=N] and GET /api/teams/:id/record[?version=N], returning ObjectiveRecordView
```

**Decisions:**

- **`server.ts` lines, and nothing else:** `import { objectiveRoutes } from "./objective-routes.js";` and, after line 896 (`app.get("/api/goals/:id", …)`), `objectiveRoutes(app, { goals, teams }, requireRole(["owner", "controller", "viewer"]));`. `readRoles` is declared later (line 939), so the guard is built here from `requireRole` (line 577).
- **Each route:** the guard; the id is `z.uuid().parse(String(req.params.id).toLowerCase())`, because a UUID is case-insensitive and the host's ids are lower case; the query is `z.object({ version: z.string().regex(/^[1-9][0-9]{0,5}$/).optional() }).strict()`; then `objectiveRecord(id, version)`. A `ZodError` answers 400 through the existing handler, and a `TeamError` answers its status with `{ code, error }`. Reads touch memory only and take no lock.
- **The relay.** No change to `remote-access.ts`: neither path matches `allowedPath`.
- **Docs.** `docs/teams.md`, "Start and steer a goal": each goal holds an objective record of its objective, success text as `c0`, non-goals, evidence, paths, and one direction per steering message; `infinite goal record ID [--version N] [--json]`; a standalone run gets its record at its first accepted plan; goal cycles and mission subteams have none; the record changes no prompt yet. The Goals and Teams API sections: both routes, the roles, the version query, and every code of Task 2. The spec: part 1 ("Creation": `criteria` at creation and the store module move to step 2; a run's c0 uses `statementOf`; the 12,000-byte bound; the digest leaves out `log` and `digest`; the assumption cap is on all assumptions; a step-1 direction above 2 KiB is logged by reference to the record), part 2 (a controller's steer is logged as the owner's; answers write nothing until step 3), part 8 (the codes, the relay refusal, the CLI read form first), and delivery order 1 (mission subteams hold no record).

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `objective record reads on a goal` (goals, host) | Extends `a goal with no justified change records evidence without starting implementation or claiming success`: after the goal stops, `GET /goals/:id/record` as a viewer gives 200 with version 1, `latestVersion` 1, `rebuilt` false, c0's statement equal to the request's `successCriteria`, and one log entry `record.created`. The id in upper case gives the same. `?version=1` gives `rebuilt` false; `?version=2` gives 404 `objective-version-not-found`; `?version=0`, `?version=x`, and `?other=1` give 400. A random UUID gives 404 `goal-not-found`. `GET /teams/<the goal's cycle team>/record` gives 409 `objective-record-of-goal`. `goal record ID` prints a first line starting `Goal ID · record version 1 of 1`; `--version 2` exits non-zero with `The record has no version 2.`; `--json` prints JSON with `version` 1. |
| `objective record reads on a standalone run` (teams, host) | Extends `a team builds concurrently in isolated copies and produces checked, reviewed work without changing its source`: after the plan is accepted, `GET /teams/:id/record` gives 200 with owner kind `run`, c0 `statementOf` `objective`, `record.statement.objective` equal to the request's objective, and a first log entry `record.created` by `host`. A random UUID gives 404 `team-not-found`. |
| `the relay refuses objective records` (remote-access) | `/goals/<uuid>/record`, `/goals/<uuid>/record?version=1`, and `/teams/<uuid>/record` each answer 403 `remote-endpoint-denied`, and `runner.requests.length` stays 1. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement**, and amend the docs and the spec. **Step 4: Run** `tests/remote-access.test.ts`, then the two extended tests in `tests/goals.test.ts` and `tests/teams.test.ts` on the host, then the typecheck.
- [ ] **Step 5: The coordinator runs `npm run check` once, requests the independent review, and commits.**

## Not in this slice

- Owner corrections (`POST /api/goals/:id/record`, `POST /api/teams/:id/record`), owner `criteria` at creation, the command-membership and blob-recording rules, and the CLI verbs `confirm`, `retire`, `set-assumption`, and `answer`: step 2.
- The record digest in `TeamGoalContext`, in prompts, and in the context file, and the `evaluators` lineup slot: step 2.
- The evidence store module `objective`, with `objective_log` and `objective_values`, and the outbox that feeds them: with the first write that can pass 400 entries or log a value above 2 KiB that the record does not hold.
- A log that keeps only its newest entries. Record rule 9 needs a log entry for every steering direction, so the slice that first truncates the log must relax that rule to the directions the log still covers. Otherwise this host cannot read a truncated record after a rollback.
- Decision answers as record changes: step 3, for the intent check's questions.
- `infinite team record`, every web, phone, and Mac screen, and relay access.
- Records for mission subteams and for missions (left open by the design).
- A record for a run that settled before this change. It gets one only if a continuation brings a new plan.
- A goal removal path. `goals.ts` has none.
- Steps 3 to 7.

---

# Slice: owner corrections and the record digest

Spec `2026-11-13-objective-record-design.md` part 2 (owner correction), part 8 (the record digest, `POST /api/goals/:id/record`, and the CLI forms), delivery order 2, and acceptance 2 for owner ops. The owner can add, edit, retire, and confirm a goal's criteria, and can give criteria when the goal is created. When a project turns the new switch on, the member prompts and the context file of each goal cycle show the record's criteria in place of the success text. It builds on step 1 (`2026-11-14-objective-record.md`), which is on `main`.

**One switch per project, off by default, inside the routine approval digest.** `project.team.objective = { prompts: "on" | "off" }`, with no default. When the key is absent or `"off"`, no prompt byte, context key, run fingerprint, or prompt version changes, and creation `criteria` and every correction answer 409 `objective-prompts-off`. *(My call. The switch changes what every member of a cycle reads, so it belongs inside `RoutineService.authority`: `digestedProjectTeam` strips only `eval`, so writing an `objective` key changes the digest and blocks that project's active routines until the owner approves them again. An absent key leaves every stored digest valid. Corrections are refused while the switch is off because a correction that no member reads would look applied. The spec names the family `objective.intentCheck` and `objective.evaluator` (part 4, "Authority and safety"); steps 3 and 5 add them beside `prompts`. `config.teams` gains nothing.)*

**The digest is pinned per cycle run, in the goal context.** `GoalService.prepare` builds `TeamGoalContext.record` once per cycle, from the latest record version, when the switch is on. Every member of that run reads the pinned digest, including members started after a pause, a replan, or a host restart. The next cycle reads the latest version. *(My call, against part 2's "other changes apply from the next member start". Part 8 puts the digest in `TeamGoalContext`, which is the run's immutable goal context and part of its creation fingerprint (`createRun` digests `{ request: parsed, ...creationContext }`). A per-member version needs `TeamService` to read the goal's record, which lives in `GoalService`'s sealed record, or a mutable run field that every launch path must refresh. A pending launch persisted before this change has no `record` and replays unchanged.)*

**Step 2 corrects criteria only.** Four ops: `criterion.add`, `criterion.edit`, `criterion.retire`, and `criterion.confirm`. `c0` can be neither edited nor retired (409 `objective-op-c0`): it is the goal's `successCriteria`, which the goal view, the goal digest, and the outcome assessment still read. Owner values, assumption and question ops, promotions, definitions, rules, non-goals, excluded paths, and the rubric version move to step 3, where the intent check creates the things they change. *(My call: the record holds no assumption or question before step 3, and part 8 gives definitions, rules, and non-goals no place in a non-coordinator prompt.)*

**Corrections write no direction, so step 1's history rule stands.** Rule 9 (`objective-history-invalid`) matches `direction.appended` and `direction.copied` entries against steering directions only. A correction writes `criterion.*` entries. `rebuildVersion` learns to undo the four criterion ops, so every earlier version still rebuilds.

**No `evaluators` slot, no `objective` evidence store module, and no standalone-run corrections here.** Each is argued in "Not in this slice".

**Coordinator rulings (2026-11-15).** They settle the calls marked above and replace any line of this section that says otherwise.

- **The switch, the per-cycle pin, criteria-only corrections, owner-only access, goals only, no `evaluators` slot, and no store module are accepted as written.** The design's part 2 and part 8 and its delivery order are amended in Task 9 to say so. A correction reaches members from the next cycle; steering stays the way to reach a running cycle.
- **`repo init` keeps the `objective` key without a task here.** The command carries every team key it does not own (`carriedTeamSettings`, a separate change that lands first). If that change is not on `main` when Task 9 starts, Task 9 stops and reports.
- **Another slice adds a key beside this one.** The router's shadow recorder adds `routing` to `teamProjectSchema`, one line to `withoutPrivateSettings`, and tests to `tests/routines.test.ts` and `tests/team-prompts.test.ts`. Whichever lands second merges `main` and keeps both; neither slice edits the other's lines.
- **Release.** The rollback row above goes into the release notes of the release that carries this slice: remove the `objective` key from every project before a rollback, and expect a goal with a pinned digest in a pending launch to block on an older host.

## Trust boundary, and what a review checks

These inputs originate outside the host:

- **Owner corrections and creation criteria** arrive with an owner device key. Statements are owner text: sealed in the goal's record file, and never in a log line, an event text, or an error body. They reach the prompt of every member of the goal's later cycles and the context file. The host refuses a secret-shaped statement with 400 `objective-secret` and never echoes it: `findSecret(ops, { token: "", url: "" })` checks private keys and the access-token shapes, which include the GitHub grant and egress proxy password shapes since `7cdfbb9`. An owner device holds no session credential, so no by-value list applies. A body that fails its schema gets the fixed 400 `objective-op-invalid` with no detail, because a zod message for an unknown key names the key.
- **Configured check commands** come from the operator's config (`project.team.checks`). A command criterion must name one of them (400 `objective-command-unknown` otherwise); the record stores only its digest. The digest's check label prints the command and its arguments, which every member already reads through `configuredProject.checks`, so no new text reaches a prompt.
- **Members** write nothing in this slice, so no member text reaches the record or the digest. The digest's type and byte rule live in `team-types.ts`, so the step 1 test `team prompts never import the record` keeps holding.
- **Roles.** Only the owner corrects. *(My call: goal steering admits a controller, but a correction redefines "done", like pause, cancel, and extend, which are owner only; the log also has no controller actor.)* The relay refuses `POST /api/goals/:id/record`, because `allowedPath` in `remote-access.ts` admits only `steer|pause|resume|cancel|outcome` after a goal id. No code change; one test row.

What can reach prompt and context text: owner criterion statements (at most 1,000 bytes each), check labels (at most 120 bytes each, built from enumerations, scoped paths, ids, and configured commands), the record version, and producers. No credential the host issues, no member text, no verdict, and no outcome row.

**Sizes.** The digest is at most 6,144 bytes of JSON with `c0`'s statement empty; the prompt prints `c0`'s text once, in place of `successCriteria`. A prompt grows by at most 6,144 bytes plus one fixed lead line; the context file grows by at most 6,144 bytes beside the blackboard digest (`DIGEST_BYTES` 4,096) and the entry paragraph (`ENTRY_PARAGRAPH_LIMIT_BYTES` 700), which do not change. The digest is authority text, so `fitDerivedSections` never cuts it; a prompt whose authority exceeds 80 KiB fails with 409 `team-prompt-too-large`, as today.

**Cost.** Nothing here reads a session, an outcome row, or the evidence store, so 1,000 sessions and 10,000 outcome rows change nothing. A goal list, a goal read, and an idle tick parse no record and read no sealed file. `prepare` parses the record once per cycle. A correction parses twice (the stored record and the result) and writes the goal's sealed file once. A member launch reads `run.goal` and parses nothing. No store statement or index is added.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| Switch absent or `"off"` | Every role's prompt and context equal today's; creation `criteria` and corrections answer 409 `objective-prompts-off`; `prepare` writes no `record` | Task 7 `the record digest replaces the success text and nothing else`; Task 6 `corrections and creation criteria need the switch` |
| The `objective` key written, then a routine's next check | The authority digest differs, so the routine blocks as for any authority change; an absent key keeps the stored digest | Task 2 `the objective switch is inside the routine approval digest` |
| A correction, then the same request again | The second answers the same view and writes nothing | Task 6 `a correction applies once` |
| The same `requestId` with another body | 409 `request-conflict`, nothing written | Task 6 `a correction applies once` |
| Two corrections from one version | The second answers 409 `objective-version-stale` | Task 6 `a correction applies once` |
| A correction whose goal write fails | The in-memory record and receipts are unchanged; the same request then applies once | Task 6 `a failed correction write changes nothing` |
| A correction with one refused op among several | Nothing applied, the input record unchanged, no owner text in the error | Task 5 `refusals change nothing and echo nothing` |
| A correction during a cycle, then a restart | The running run keeps its pinned digest; after the restart it still does; the next cycle reads the new version | Task 6 `a cycle pins the digest it launched with` |
| A pending launch stored by an older host (no `record`) | It replays unchanged; the run has no `record` | Task 6 `a cycle pins the digest it launched with` |
| A stored record that cannot be read when a cycle starts | The cycle launches without `record`, with one fixed event | Task 6 `an unreadable record launches without a digest` |
| Three corrections of distinct criteria in every order | The same criteria, version, and digest | Task 5 `three corrections of distinct criteria give one record in every order` |
| Random steering and corrections with a reload between steps | Every version rebuilds to what it was, and parses | Task 5 `every version rebuilds after random corrections and steering` |
| A correction that would leave the log less than 20 entries or 46 KiB of room | 409 `objective-log-full`; 20 maximal steers still fit afterwards | Task 5 `a correction keeps room for steering` |
| A digest over 6 KiB, 9 active criteria, 65 criteria | 409 `objective-digest-too-large`, `objective-criteria-limit` | Task 5 `limits refuse before anything changes` |
| A failed migration write, then a pending control | The control reaches its team, and the record is saved with that change | Task 6 `a pending control reaches its team after a failed migration write` |
| A controller, a viewer, the relay | 403 | Task 8 `owner corrections through the host`; `the relay refuses corrections` |
| A rollback to a host without this slice | A stored record still parses (the schema does not change), but a version before a correction is 409 `objective-version-unavailable`; a pending launch with `record` fails the old strict `teamGoalContextSchema` and the old tick blocks that goal; a config with the `objective` key fails the old strict `teamProjectSchema` | No test. `docs/teams.md` says to remove the key before a rollback; the release's rollback rehearsal covers the rest |

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/objective-types.ts` (modify) | Export the check and threshold schemas and the producer and threshold rules that `recordProblems` already applies |
| `packages/host/src/objective-input.ts` (create) | Pure: the input and correction schemas, their limits, the goal create body split, `commandDigest` |
| `packages/host/src/team-types.ts` (modify) | `RecordDigest` and its byte rule; `TeamGoalContext.record`; `project.team.objective` |
| `packages/host/src/objective-digest.ts` (create) | Pure: the switch, check labels, the digest of a record |
| `packages/host/src/objective-record.ts` (modify) | The new error codes; `rebuildVersion` undoes criterion ops |
| `packages/host/src/objective-ops.ts` (create) | Pure: owner ops, creation criteria, ids, log room |
| `packages/host/src/objective-goals.ts`, `goals.ts` (modify) | `correctObjective`, creation criteria, the digest in `prepare` |
| `packages/host/src/team-prompts.ts`, `config-identity.ts`, `teams.ts` (modify) | The goal section prints the digest; the prompt version knows it; one capture line |
| `packages/host/src/objective-routes.ts`, `server.ts` (modify) | `POST /api/goals/:id/record`; the goal create body |
| `packages/host/src/objective-cli.ts` (modify) | `retire`, `confirm`, and `apply --file` |
| `docs/teams.md`, the spec (modify) | The switch, corrections, the digest, and the amendments of part 2, part 8, and the delivery order |
| `tests/objective-{input,digest,ops}.test.ts` (create); `tests/{objective-types,objective-record,objective-goals,objective-cli,team-prompts,config-identity,routines,goals,remote-access}.test.ts` (modify) | Pure rules, the goal service with a real team service, the host |

**Order and owners.** Tasks 1, 2, and 4 run first, in parallel. Then Tasks 3 and 7 run in parallel (3 needs 1 and 2; 7 needs 2). Then Task 5 (needs 1, 3, and 4), then Task 6. Tasks 8 and 9 run last, in parallel: the route contract and its texts are fixed below, so the CLI is written without the route. Each file has one writer. Every worker in a worktree is told never to use `git stash`; it compares with `git show HEAD:<path>` and sets work aside with a WIP commit. The host typecheck does not cover `tests/`, so each task runs its test files, and a task reports any cancelled test as a failure.

## Review Focus

1. A byte change while the switch is off: a prompt, a context file, a run fingerprint, a prompt version, or a routine digest with the key absent. Expect none (Task 7 `the record digest replaces the success text and nothing else`; Task 6 `corrections and creation criteria need the switch`; Task 2 `the objective switch is inside the routine approval digest`).
2. A correction that is not exactly once or not all or nothing: a replay, a conflict, a stale version, a failed write, one refused op among several. Expect one application or none (Task 6 `a correction applies once`, `a failed correction write changes nothing`; Task 5 `refusals change nothing and echo nothing`).
3. A history that no longer rebuilds, or a record that step 1's schema refuses, which a rollback would then hide. Expect every version to rebuild and parse (Task 5 `every version rebuilds after random corrections and steering`, `three corrections of distinct criteria give one record in every order`; Task 4 `a rebuild undoes owner corrections`).
4. Owner text where it must not be: an error body, an event, a log line, a plain column; or a secret-shaped statement that reaches a prompt. Expect none (Task 5 `refusals change nothing and echo nothing`, `a secret-shaped statement is refused`; Task 8 `owner corrections through the host`).
5. A digest that changes inside a run, a cycle that reads a stale one, or a read path that starts to parse. Expect a pin per run and zero parses on lists, reads, and idle ticks (Task 6 `a cycle pins the digest it launched with`, `lists, single reads, and an idle tick parse no record and read no sealed file`).

### Task 1: the input schemas

**Files:** `packages/host/src/objective-types.ts`, `packages/host/src/objective-input.ts` (create), `tests/objective-input.test.ts` (create), `tests/objective-types.test.ts`. Runs first, in parallel with Tasks 2 and 4.

**Interfaces (produces):**
```ts
// objective-types.ts: today's private schemas, exported unchanged.
export const thresholdSchema: z.ZodType<Threshold>;
export const checkSchema: z.ZodType<Check>;
/** host for command, receipt, artifact, citations, citation-form; evaluator for judgement; owner for owner-rating. */
export function producerOf(check: Check): Criterion["producer"];
/** artifact: count iff a count threshold, else pass; citations and citation-form: share; owner-rating: score; others: pass. */
export function thresholdFits(check: Check, threshold: Threshold): boolean;

// objective-input.ts
export const CORRECTION_LIMITS = { ops: 16, creationCriteria: 7, version: 1_000_000, criterionCanonicalBytes: 2_048 } as const;
export type CheckInput =
  | Exclude<Check, { kind: "command" } | { kind: "artifact" }>
  | { kind: "command"; run: TeamCommand }
  | { kind: "artifact"; path: string; count?: string };
export type CriterionInput = { statement: string; check: CheckInput; threshold: Threshold; producer?: Criterion["producer"] };
export type CorrectionOp =
  | { op: "criterion.add"; criterion: CriterionInput }
  | { op: "criterion.edit"; id: string; statement?: string; check?: CheckInput; threshold?: Threshold }
  | { op: "criterion.retire"; id: string }
  | { op: "criterion.confirm"; id: string };
export type Correction = { requestId: string; version: number; ops: CorrectionOp[] };
export const criterionInputSchema: z.ZodType<CriterionInput>;
export const correctionSchema: z.ZodType<Correction>;
/** SHA-256 hex of canonical JSON `{ command, args }` of a parsed command (args defaulted). */
export function commandDigest(command: TeamCommand): string;
/** Splits a goal create body: `criteria` (1 to 7) is parsed here, the rest by `createGoalSchema`. Throws `objectiveError("objective-op-invalid")` for bad criteria. */
export function parseGoalCreateBody(input: unknown): { goal: CreateGoal; criteria?: CriterionInput[] };
```

**Decisions:**

- `recordProblems` calls `producerOf` and `thresholdFits`, so one rule serves the stored record and the input. *(My call: an input check needs the rule before a whole record exists, to answer a specific code.)*
- Statements are 1 to 1,000 UTF-8 bytes (`OBJECTIVE_LIMITS.criterionBytes`). `producer` is optional; when present it must be one of the three enumerated values, so `"coordinator"` fails the schema (acceptance 2). A fit check against `producerOf` happens in Task 5, which answers 400 `objective-criterion-misfit`.
- An artifact input has no `schema` and a criterion has no `pinned`: both need a blob read at a fixed commit, a new Git form, and no reader exists before step 4.
- `correctionSchema` is strict: `requestId` a UUID, `version` 1 to 1,000,000, `ops` 1 to 16, no two ops naming the same id, and an edit with at least one field. *(My call: with one op per id, the order of ops inside a correction matters only for the ids that adds receive.)*
- `parseGoalCreateBody` exists so that `goal-types.ts` does not change. *(My call: `routineGoalSchema` spreads `createGoalSchema.shape`, and `ProductGoal` spreads every request field, so a `criteria` field there would reach routines and every goal view. `createGoalSchema` also has refinements, which `extend` does not accept in zod 4.)*

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `inputs are checked strictly` (objective-input) | A statement of 1,001 bytes, an unknown key, an artifact `schema`, a `pinned` field, producer `"coordinator"`, 17 ops, two ops on `c1`, an empty edit, version 0, and version 1,000,001 are refused; a command input with no `args` parses with `args: []`. |
| `a command digest is stable and bound to its arguments` (objective-input) | Equal for `{ command: "npm", args: ["test"] }` parsed twice; different for `args: ["test", "--x"]`; 64 lower-case hex. |
| `the goal create body keeps criteria apart` (objective-input) | A body with `criteria` gives `goal` equal to `createGoalSchema.parse` of the body without it; 8 criteria or a bad criterion throw status 400 code `objective-op-invalid` whose message holds no input text; a body without `criteria` gives `criteria` undefined. |
| `producer and threshold rules are shared` (objective-types) | `producerOf` and `thresholdFits` over every check kind; a record whose judgement criterion has producer `host` still fails `objectiveRecordSchema` with the same message. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-input.test.ts tests/objective-types.test.ts tests/objective-record.test.ts` and the host typecheck, then commit.

### Task 2: the digest type and the switch

**Files:** `packages/host/src/team-types.ts`, `tests/routines.test.ts`. Runs first, in parallel with Tasks 1 and 4.

**Interfaces (produces):**
```ts
export const RECORD_DIGEST_BYTES = 6 * 1024;
export const RECORD_LABEL_BYTES = 120;
/** Part 8's record digest. `c0` is first and its statement is empty: its text is the context's `successCriteria`. */
export const recordDigestSchema = z.strictObject({
  version: z.number().int().min(1).max(1_000_000),
  criteria: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),          // the record's ID_RE, copied: importing objective-types here would close an import cycle
    statement: z.string(),                                   // "" for c0; 1 to 1,000 bytes otherwise
    check: z.string(),                                       // 1 to RECORD_LABEL_BYTES bytes
    producer: z.enum(["host", "evaluator", "owner"]),
  })).min(1).max(8),
}).superRefine(/* c0 first with "", others non-empty, byte bounds, recordDigestBytes(value) <= RECORD_DIGEST_BYTES */);
export type RecordDigest = z.infer<typeof recordDigestSchema>;
export function recordDigestBytes(digest: RecordDigest): number;   // Buffer.byteLength(JSON.stringify(digest))
// teamGoalContextSchema gains, as its last key:
//   record: recordDigestSchema.optional(),
// teamProjectSchema gains, after `eval`:
//   objective: z.strictObject({ prompts: z.enum(["on", "off"]) }).optional(),
```

**Decisions:**

- `record` is the last key of the goal context, so a context without it serializes as today, and `JSON.stringify(run.goal)` of an older run is unchanged.
- The switch has no default, so a parsed config without it has no `objective` key and every routine digest stays valid. Writing the key, even as `"off"`, changes the digest; `docs/teams.md` says to leave it absent for off.
- Steps 3 and 5 add assumptions, open questions, and `objective.intentCheck` and `objective.evaluator` after these fields.

- [ ] **Step 1: Write the failing test** `the objective switch is inside the routine approval digest` in `tests/routines.test.ts`, beside `eval settings stay out of the routine approval digest` and in its pattern: a routine created without the key keeps its stored authority after a reload with the key still absent; the same routine blocks at its next check after the project gains `objective: { prompts: "on" }`. **Step 2: Run it and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/routines.test.ts tests/autonomy-mode.test.ts` and the host typecheck.

### Task 3: the digest of a record

**Files:** `packages/host/src/objective-digest.ts` (create), `tests/objective-digest.test.ts` (create). Needs Tasks 1 and 2. Runs in parallel with Task 7.

**Interfaces (produces):** pure, no I/O, no clock.
```ts
/** True only when `team.objective.prompts` is "on". */
export function objectivePromptsOn(project: Pick<Project, "team"> | undefined): boolean;
/** `kind:detail`, at most RECORD_LABEL_BYTES bytes, with each control character replaced by a space. */
export function checkLabel(check: Check, configured: readonly TeamCommand[]): string;
/** The active criteria in record order, c0 first with an empty statement. The result passes recordDigestSchema except for the byte cap, which callers check. */
export function recordDigestFor(record: ObjectiveRecord, configured: readonly TeamCommand[]): RecordDigest;
```

**Decisions:**

- Labels: `command:` and the configured command joined with its arguments by spaces, found by `commandDigest`; `command:` and the first 12 hex digits and ` (not configured)` when the configuration no longer holds it; `receipt:checks-passed`; `artifact:PATH`; `citations:PATH` and `citation-form:PATH`; `judgement:ITEM` (so `c0` reads `judgement:owner-text`); `owner-rating:SUBJECT`. A label over 120 bytes ends at a character boundary with `...` inside the 120 bytes. *(My call: a label names how the criterion is checked; the threshold, the pointer, and the digest itself stay out, as part 8 lists.)*
- `recordDigestFor` never throws on a valid record. The cap is checked by the writer (Task 5) and by `prepare` (Task 6).

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the digest lists active criteria with c0 first and empty` | A record with `c0`, `c1` (configured command), `c2` (retired), and `c3` (artifact with a count): criteria `[c0, c1, c3]`, `c0` statement `""`, labels and producers as listed; the result parses with `recordDigestSchema`; `recordDigestBytes` equals the JSON byte length. |
| `labels are bounded and plain` | Arguments with a newline and a tab give spaces; a 300-byte command gives 120 bytes ending in `...` with a three-byte character at the cut kept whole; a command digest no longer configured gives `command:` + 12 hex + ` (not configured)`; one label per other kind. |
| `the digest schema refuses what the rule refuses` | `c0` not first, `c0` with text, 9 criteria, a 121-byte label, a 1,001-byte statement, and a digest of 6,145 bytes are refused. |
| `the switch reads only on` | An undefined project, no `team`, no `objective`, and `"off"` give false; `"on"` gives true. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-digest.test.ts` and the host typecheck.

### Task 4: error codes and the rebuild

**Files:** `packages/host/src/objective-record.ts`, `tests/objective-record.test.ts`. Runs first, in parallel with Tasks 1 and 2.

**Interfaces (produces):**
```ts
export type ObjectiveErrorCode = /* the nine of step 1 */
  | "objective-prompts-off" | "objective-op-invalid" | "objective-op-target" | "objective-op-c0" | "objective-op-refused"
  | "objective-version-stale" | "objective-criterion-misfit" | "objective-criterion-too-large" | "objective-command-unknown"
  | "objective-secret" | "objective-criteria-limit" | "objective-too-large" | "objective-log-full" | "objective-digest-too-large";
export const OBJECTIVE_ERRORS: Record<ObjectiveErrorCode, { status: 400 | 404 | 409; message: string }>;
export function rebuildVersion(record: ObjectiveRecord, version: number): ObjectiveRecord;   // signature unchanged
```

**Decisions:**

- Status 400: `op-invalid`, `criterion-misfit`, `criterion-too-large`, `command-unknown`, `secret`. Status 409: the others. Each message is fixed and names no input. These texts are the contract Task 9 maps:
  - `objective-prompts-off`: `Turn on objective prompts for this goal's project before changing its criteria.`
  - `objective-op-invalid`: `The correction is invalid.`
  - `objective-op-target`: `A correction names a criterion that is missing or in another state.`
  - `objective-op-c0`: `Criterion c0 is the goal's success text and cannot be edited or retired.`
  - `objective-op-refused`: `The corrected record would be invalid, so nothing was changed.`
  - `objective-version-stale`: `The record changed since it was read. Read it again and resend the correction.`
  - `objective-criterion-misfit`: `A criterion's producer or threshold does not fit its check.`
  - `objective-criterion-too-large`: `A criterion is over 2,048 bytes.`
  - `objective-command-unknown`: `A command criterion must name one of the project's configured checks.`
  - `objective-secret`: `A criterion looks like it holds a secret, so nothing was changed.`
  - `objective-criteria-limit`: `A record holds at most 8 active criteria and 64 in all.`
  - `objective-too-large`: `The corrected record would be over its size limit.`
  - `objective-log-full`: `The record's log is full. Start a new goal with consolidated criteria.`
  - `objective-digest-too-large`: `The active criteria would be over the 6 KiB prompt digest.`
- **The rebuild undoes criterion ops from their logged values.** Each `criterion.added|edited|retired|confirmed` entry holds the whole criterion inline: `after` always, `before` for all but an add. Undoing an entry finds the criterion whose canonical value equals `after.inline`; an add removes it, and the others replace it with `before.inline` in place. A missing match is 409 `objective-version-unavailable`. The rebuilt record is parsed with `objectiveRecordSchema`; a failure is the same 409. Any other op stays unknown, so `criterion.derived` still answers 409. *(My call: the parse costs one call on a versioned read only, and it turns a damaged log into a refusal instead of a version that never existed.)*

- [ ] **Step 1: Write the failing test** `a rebuild undoes owner corrections`: a hand-built record of version 4 (created at 1; `criterion.added` c1 at 2; a steered direction at 3; `criterion.edited` c1 and `criterion.retired` c2 at 4, with c2 added at creation) rebuilds versions 1 to 3 equal to hand-built snapshots; an `after.inline` that differs by one byte answers 409; the existing `a rebuild refuses what it cannot undo` still passes unchanged. **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-record.test.ts tests/objective-goals.test.ts tests/objective-runs.test.ts` and the host typecheck.

### Task 5: owner ops

**Files:** `packages/host/src/objective-ops.ts` (create), `tests/objective-ops.test.ts` (create). Needs Tasks 1, 3, and 4.

**Interfaces (produces):** pure, no I/O; the clock comes from `context.at`.
```ts
/** Corrections leave this much of OBJECTIVE_LIMITS' log for steering: 20 entries and 46 KiB. */
export const CORRECTION_LOG = { entries: 380, bytes: 210 * 1024 } as const;
export type OwnerOpContext = { configured: readonly TeamCommand[]; requestId: string; at: string };
/** Every op or none, one version up. Throws objectiveError with a fixed code; the input record is never changed. */
export function applyOwnerOps(record: ObjectiveRecord, correction: Pick<Correction, "version" | "ops">, context: OwnerOpContext): ObjectiveRecord;
/** Owner criteria of version 1: ids c1 onward, each logged `criterion.added` at version 1. */
export function addCreationCriteria(record: ObjectiveRecord, inputs: readonly CriterionInput[], context: OwnerOpContext): ObjectiveRecord;
export function criterionFromInput(input: CriterionInput, id: string, configured: readonly TeamCommand[]): Criterion;
/** `c` and one more than the highest number among every criterion id, retired ones included. Ids are never reused. */
export function nextCriterionId(record: ObjectiveRecord): string;
```

**Decisions:**

- **The order of checks is fixed**, so a test can name the first refusal: the version (409 `objective-version-stale`), the secret scan over the whole op list (400 `objective-secret`), then each op in order: its target (a missing id, a retired criterion for edit or retire, an owner criterion for confirm: 409 `objective-op-target`; `c0`: 409 `objective-op-c0`), its check (400 `objective-command-unknown`), its fit (400 `objective-criterion-misfit`), and its size (canonical over 2,048 bytes: 400 `objective-criterion-too-large`). Then the whole result: active and total counts (409 `objective-criteria-limit`), log room (409 `objective-log-full`), `cappedBytes` (409 `objective-too-large`), the digest bytes (409 `objective-digest-too-large`), and last `objectiveRecordSchema.safeParse` (409 `objective-op-refused`).
- **What each op does.** Add appends an owner criterion with state `active`. Edit replaces the given fields; the producer follows the check; a derived criterion that the owner edits becomes `origin: "owner"` without `derivedFrom`, because its words are now the owner's. Retire sets state `retired`. Confirm sets a derived criterion's origin to `owner` and drops `derivedFrom`. *(My call for edit; part 2 names confirm only.)* No step 2 writer makes a derived criterion, so confirm applies only to records that step 3 writes; the test builds one by hand.
- **The log.** One entry per op, all at the new version: `actor: "owner"`, `authority: "direction"`, `handle: requestId`, `target` the criterion id, `after` the whole criterion inline, and `before` for all but an add. The 2,048-byte criterion cap keeps both inline (`OBJECTIVE_LIMITS.inlineValueBytes`). The record's `version` rises by one and its `digest` is recomputed.
- **Log room.** Refused when `log.length + ops.length > 380`, or when the log's canonical bytes after the correction exceed 210 KiB. Steering keeps the last 20 entries and 46 KiB: a goal has at most 20 steering entries (`goal-steering-limit`), and one direction entry is at most about 2.3 KiB, since a longer one is logged by reference. A goal whose log is full for corrections can still be steered to its own limit; the owner starts a new goal for more corrections.
- **Creation criteria** use the same path: version 1, no stale check, and `addCreationCriteria` throws the same codes, so a refused criterion aborts the goal's creation.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `owner ops add, edit, retire, and confirm criteria` | From a record of version 1 with a hand-built derived `c1`: one correction adds `c2` (a configured command: its digest stored, producer `host`) and edits `c1`'s statement; the next retires `c2`. Versions 2 and 3, with log entries as listed; `c1` is now an owner criterion without `derivedFrom`; after the retire, `nextCriterionId` gives `c3`. On a second record, a confirm turns a derived `c1` into an owner criterion. |
| `acceptance 2: misfits and unknown commands are refused` | A judgement check with producer `host` and an artifact with a count under a `pass` threshold give 400 `objective-criterion-misfit`; a command not in `configured` gives 400 `objective-command-unknown`. |
| `refusals change nothing and echo nothing` | For each code of the fixed order, with the refused op second of three: the thrown error has that code; `JSON.stringify` of the error and its message hold no statement text; the input record deep-equals a copy taken before. |
| `c0 stays` | Edit and retire of `c0` give 409 `objective-op-c0`. |
| `a secret-shaped statement is refused` | A private key header, a GitHub token shape, and an egress proxy password shape, each built as `tests/member-entry.test.ts` builds them, give 400 `objective-secret`. |
| `limits refuse before anything changes` | An add that makes 9 active criteria, a 65th criterion, and statements whose digest reaches 6,145 bytes give `objective-criteria-limit` and `objective-digest-too-large`; 7 added criteria of 700 bytes each fit. |
| `a correction keeps room for steering` | A record with 380 log entries refuses a one-op correction with `objective-log-full`; then 20 steering entries of 8,000 characters, synced with `syncDirections`, give a record that parses. The same with a log at 210 KiB. |
| `three corrections of distinct criteria give one record in every order` | From `c1`, `c2`, `c3`: an edit of `c1`, a retire of `c2`, and a threshold edit of `c3`, applied in all six orders, give equal `criteria`, `version`, and `digest`. |
| `every version rebuilds after random corrections and steering` | Seeded (200 seeds, the seed printed on failure): random steering and random valid corrections, with a JSON round trip between steps as a restart; for each version, `rebuildVersion(final, v)` deep-equals the snapshot taken at `v`, and every snapshot parses with `objectiveRecordSchema`. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-ops.test.ts tests/objective-record.test.ts` and the host typecheck.

### Task 6: the goal service

**Files:** `packages/host/src/objective-goals.ts`, `packages/host/src/goals.ts`, `tests/objective-goals.test.ts`. Needs Task 5.

**Interfaces (produces):**
```ts
// objective-goals.ts
export type GoalDigestResult = { digest: RecordDigest } | { skipped: "record-unavailable" | "digest-too-large" };
export const GOAL_DIGEST_EVENTS: Record<"record-unavailable" | "digest-too-large", string>;
/** One parse of the holder's record; never stores it. Throws objectiveError. */
export function correctGoalObjective(holder: GoalHolder, correction: Correction, context: OwnerOpContext): ObjectiveRecord;
/** Step 1's function with creation criteria; a refused criterion throws, any other failure keeps step 1's result. */
export function createGoalObjective(holder: GoalHolder, at: string, criteria?: { inputs: readonly CriterionInput[]; context: OwnerOpContext }): GoalObjectiveResult;
/** One parse of the latest record. */
export function goalRecordDigest(holder: GoalHolder, configured: readonly TeamCommand[]): GoalDigestResult;

// goals.ts
correctObjective(id: string, input: unknown): Promise<ObjectiveRecordView>;
create(input: CreateGoal, admit?: () => void, criteria?: CriterionInput[]): Promise<ProductGoal>;
```

**Decisions:**

- **`correctObjective`** parses with `correctionSchema` before it queues (a failure is `objectiveError("objective-op-invalid")`), then runs in `this.enqueue`, as `steer` does. In order: the goal (404 as today); the replay through `stored.receipts` with `digest({ action: "record", ...body })`, answering the latest view on a match and 409 `request-conflict` on a mismatch (`replay` widens its body type from `Action` to `{ requestId: string }`); the switch (409 `objective-prompts-off`); `correctGoalObjective`; then one fixed event, `The owner corrected the objective record to version N.`, and the save. It returns `recordView(result)`, the corrected record it already parsed. *(Coordinator ruling after review: `goalObjectiveView(stored)` would parse the record a third time, against the cost rule of two parses; the result is ready by construction, so the view is the same.)* A replay is answered even after the switch turns off.
- **The write is all or nothing.** The service saves a copy of the stored record with the new record, receipt, and event, and puts it in `this.records` only after `save` returns. *(My call: steering mutates in place before its save, and a failed save would leave the in-memory record ahead of the file.)*
- **A correction does not raise the goal's revision and is allowed in every goal state.** The record has its own version, and goal actions keep their revision check. A correction while a launch is pending applies to the next cycle; the pending launch already holds its digest.
- **Creation.** With `criteria` and the switch off: 409 `objective-prompts-off`. The fingerprint is `digest(criteria ? { ...request, criteria } : request)`, and the 40,000-byte cap measures the same value, so a goal without criteria keeps today's fingerprint. `createGoalObjective` runs before `records.set`, so a refused criterion stores nothing. `ProductGoal` gains no field.
- **`prepare`.** When `objectivePromptsOn(project)`, it calls `goalRecordDigest(stored, project.team.checks)`. A digest sets `context.record` as the last key; a skip adds the fixed event and launches without `record`. The digest is built before `stored.launch` is saved, so a replayed launch carries it. Texts: `The objective record could not be read, so this cycle's members read the success text without its criteria.` and `The active criteria exceed the prompt digest, so this cycle's members read the success text without them.`

- [ ] **Step 1: Write the failing tests** in `tests/objective-goals.test.ts`. The fixture's project gets `objective: { prompts: "on" }` unless a row says otherwise.

| Test name | Assertions |
|---|---|
| `creation criteria join version 1` | A goal created with a configured command criterion and an artifact criterion has record version 1 with `c0`, `c1`, `c2` and two `criterion.added` entries; `goals.get(id)` has no `criteria` key; the same request again returns the same goal; the same `requestId` with other criteria gives 409 `request-conflict`; a criterion with an unknown command gives 400 and leaves no goal in `list()` and no sealed file. |
| `corrections and creation criteria need the switch` | With the key absent and with `"off"`: create with criteria and a correction each give 409 `objective-prompts-off`; a goal without criteria is created, its record holds `c0` only, and after a tick its run's `goal` has no `record` key. |
| `a correction applies once` | A correction from version 1 returns version 2; the same request again returns the same view, the sealed file bytes unchanged, and one correction event in all; the same `requestId` with other ops gives 409 `request-conflict`; a new request at version 1 gives 409 `objective-version-stale`; the goal's `revision` is unchanged. |
| `a failed correction write changes nothing` | With `f.blockRecordWrites("goal", id)` the correction throws; the view is still version 1 and `receipts` lacks the id; after the restore the same request applies and returns version 2. |
| `a cycle pins the digest it launched with` | A correction to version 2 before the first tick; after the tick, `teams.get(goal.activeTeamId).goal.record.version` is 2. A correction to version 3; the run still shows 2. Both services reopened from disk: the run still shows 2 and the goal's record is version 3. A goal record holding a stored `launch` whose context has no `record`, written as an older host wrote it, launches a run without `record`. |
| `an unreadable record launches without a digest` | A stored record that fails the schema: the tick launches a run without `record`, adds the fixed event once, and the goal keeps running. |
| `a pending control reaches its team after a failed migration write` | `f.writeTeam()`; a legacy goal with `activeTeamId` of that run and a stored pending `pause` control; the goals folder read-only while the service opens (the migration write fails); the folder writable again; after one tick the team's view shows the pause, the stored goal has no `control`, and its file holds record version 1. Skipped as root, as the step 1 test is. |
| `lists, single reads, and an idle tick parse no record and read no sealed file` | Extends step 1's test. A counter over `fs.readFileSync` for paths that end in `.sealed`, installed with `syncBuiltinESMExports` (the technique of `tests/project-sync.test.ts`): list, two reads, and an idle tick give 0 parses and 0 sealed reads; one correction gives 2 parses and 0 sealed reads; one `prepare` (the next tick of a goal with no active run) gives 1 parse. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-goals.test.ts tests/standing-goals.test.ts tests/autonomy-pins.test.ts tests/halt.test.ts` and the host typecheck.

### Task 7: prompts and the prompt version

**Files:** `packages/host/src/team-prompts.ts`, `packages/host/src/config-identity.ts`, `packages/host/src/teams.ts` (one line), `tests/team-prompts.test.ts`, `tests/config-identity.test.ts`. Needs Task 2. Runs in parallel with Task 3.

**Interfaces (produces):**
```ts
// config-identity.ts
export function renderedPrompts(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean, entryTools = false, objectiveDigest = false): string[];
export function promptVersion(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean, entryTools = false, objectiveDigest = false): string;
// memberConfiguration's input gains `objectiveDigest?: boolean`.
// teams.ts, the capture at the member launch:
//   entryTools: Boolean(member.entryTools), objectiveDigest: Boolean(stored.run.goal?.record) };
```

**Decisions:**

- **The goal section with a digest.** Today's section is `Approved goal context (immutable for this run):\n${JSON.stringify(run.goal)}\n` and the fixed tail. With `run.goal.record` it is the same first line; then `JSON.stringify` of the goal without `successCriteria` and `record`; then the lead line `Success criteria from the owner's objective record, version N. Each names how it is checked; c0 is the owner's success text:`; then the JSON array of the digest's criteria with `c0`'s statement set to `successCriteria`; then today's tail unchanged. Without `record`, the code path is today's.
- **The context file** gets the digest through `authority.goal`, with `c0`'s statement empty, so `c0`'s text appears once.
- `withoutPrivateSettings` also deletes `objective`, so a handoff run's copy of its project never shows the switch. *(Found while planning: the handoff context copies `run.handoff.project` whole.)*
- **The prompt version** renders the goal fixture with a fixed digest (`c0` and one command criterion) when `objectiveDigest` is true, so it changes for roles that print the goal section and only for them. The cache key gains the flag.
- The autonomous-mode sentence of part 8 ("propose an assumption") waits for step 3, which adds assumptions.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the record digest replaces the success text and nothing else` (team-prompts) | For every `TeamRole` and each of `ENTRY_PROVIDERS`, a goal run with and without `record`: the prompt with it equals the prompt without it with the expected section text replaced, built in the test from the format above; roles whose prompt has no goal section are equal. `teamContext` with it equals the one without it plus `authority.goal.record`. A run without `record` prints `JSON.stringify(run.goal)` verbatim. |
| `a member context never carries the feature map or the eval block` (team-prompts, extended) | A handoff project with `objective: { prompts: "on" }` shows no `objective` key in the context. |
| `the record digest changes the prompt version only for goal roles` (config-identity) | `promptVersion(role, "claude", undefined, false, false, true)` differs from the default for each role that prints the goal section and equals it for the others; each rendered text holds the lead line. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/team-prompts.test.ts tests/config-identity.test.ts tests/host-launch.test.ts` and the host typecheck. Also, once and not as a test: print `promptVersion` for every role and provider with the default arguments on the base commit and on the task's head, and put both lists, which must be equal, in the task report.

### Task 8: the route and the host

**Files:** `packages/host/src/objective-routes.ts`, `packages/host/src/server.ts`, `tests/goals.test.ts`, `tests/remote-access.test.ts`. Needs Task 6. Runs in parallel with Task 9.

**Interfaces (produces):**
```ts
export function objectiveRoutes(app: express.Express,
  services: { goals: Pick<GoalService, "objectiveRecord" | "correctObjective">; teams: Pick<TeamService, "objectiveRecord"> },
  read: express.RequestHandler, owner: express.RequestHandler): void;
// adds POST /api/goals/:id/record, owner only; the id lower-cased as the reads do; the body goes to correctObjective unparsed.
// server.ts: objectiveRoutes(app, { goals, teams }, requireRole(["owner", "controller", "viewer"]), requireRole(["owner"]));
// server.ts, POST /api/goals: const { goal: body, criteria } = parseGoalCreateBody(req.body); ... goals.create(body, undefined, criteria)
```

**Decisions:** the route contract that Task 9 builds against. Request `{ requestId, version, ops }`; answer 200 with the latest `ObjectiveRecordView`. Errors are the host's TeamError body with the codes and texts of Task 4, plus 403 for a non-owner and 409 `request-conflict`. Routine goals keep `goals.create(request, admit)` and never pass criteria. `POST /api/teams/:id/record` does not exist.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `owner corrections through the host` (goals, host) | A project with the switch on. A goal created with one criterion answers 200, and `/goals/:id/record` shows `c1`. An owner correction answers 200 with version 2; a controller and a viewer get 403; an unknown key, 17 ops, and a statement of 1,001 bytes each get 400 with exactly `{ code: "objective-op-invalid", error: "The correction is invalid." }`; a replay answers 200 with the same version. |
| `the relay refuses corrections` (remote-access) | `["POST", "/goals/<uuid>/record"]` joins the paths that answer 403 `remote-endpoint-denied`. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `tests/remote-access.test.ts`, then `tests/goals.test.ts` on the host, then the host typecheck.

### Task 9: the CLI and the docs

**Files:** `packages/host/src/objective-cli.ts`, `tests/objective-cli.test.ts`, `docs/teams.md`, the spec. Needs Task 1. Runs in parallel with Task 8.

**Interfaces (produces):**
```ts
export const GOAL_RECORD_USAGE: string;   // the three forms below
export const CORRECTION_FILE_BYTES = 64 * 1024;
/** `{ "ops": [...] }`, checked with correctionSchema before any request. Throws an Error that names the op's index, never its text. */
export function readCorrectionFile(path: string): CorrectionOp[];
```
Forms: `infinite goal record ID [--version N] [--json]` (step 1); `infinite goal record ID retire CID|confirm CID [--version N] [--request-id ID] [--json]`; `infinite goal record ID apply --file PATH [--version N] [--request-id ID] [--json]`.

**Decisions:**

- **A correction reads the version, then posts once.** Without `--version`, the command reads `/goals/ID/record` for the latest version. It posts `{ requestId, version, ops }` with `--request-id` or a new UUID, then prints `Record version N.` and the step 1 record lines (or the view with `--json`). With `--version` it does not read first. On a correction form, `--version` names the version the correction applies to.
- **A retry is safe only with the same body**, because the replay digest covers the version. When the post fails without an answer, the command prints `The correction may have been applied. Retry it safely with: infinite goal record ID FORM --version N --request-id RID`, with the values it used, and exits non-zero.
- **Error sentences**: the host's fixed `error` text for each Task 4 code, printed as is; 403: `Corrections need an owner device key.`; 409 `request-conflict`: `This request ID was used for another correction. Leave out --request-id to send a new one.` A file over 64 KiB, not JSON, or failing the schema is an error before any request, naming the op's index.
- **Docs.** `docs/teams.md`, the goal record section: the switch, its place in the routine approval digest, and that writing the key at all changes it; creation criteria; the four ops and their limits; the digest's shape, its 6 KiB cap, and its pin per cycle; the three CLI forms; and before a rollback to a host without this slice, remove `project.team.objective`, which the older strict project schema refuses. The spec: part 2, the pin per cycle run in place of "from the next member start" and the step 2 op list; part 8, the digest's shape, the cap measured with `c0`'s statement empty, and the CLI forms; the delivery order, the `evaluators` slot and standalone-run corrections moved to step 3, and the evidence store module left out.

- [ ] **Step 1: Write the failing tests** in `tests/objective-cli.test.ts`, with the stub API of step 1's tests.

| Test name | Assertions |
|---|---|
| `a correction reads the version, then posts once` | `retire c1` gives the paths `[GET /goals/G/record, POST /goals/G/record]` and the body `{ requestId: <uuid>, version: 3, ops: [{ op: "criterion.retire", id: "c1" }] }`; with `--version 3 --request-id R` only the POST, with R. `confirm c2` posts its op. |
| `a correction file is checked before anything is sent` | A file over 64 KiB, a file that is not JSON, and a file whose op 2 has an unknown key each fail with no request; the third names `op 2` and not the key. |
| `correction errors map to sentences` | Each Task 4 code prints its fixed text; 403 and `request-conflict` print their sentences; a failed post prints the retry command with the version and request id used. |
| `goal options parse` (extended) | The `retire`, `confirm`, and `apply` forms parse; a fourth positional is a usage error. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement**, and amend the docs and the spec. **Step 4: Run** `node --import tsx --test tests/objective-cli.test.ts tests/client-args.test.ts` and the host typecheck.
- [ ] **Step 5: The coordinator runs `npm run check` once on the integrated branch, requests the independent review, and commits.**

## Not in this slice

- **The `evaluators` lineup slot.** It moves to step 3, which adds its first reader (the intent checker's profile, part 4 "Who"). *(My call. Nothing reads it before then, and adding it now costs more than waiting: `teamLineupSchema` is strict, so a rolled-back host refuses a config that names it; every goal pins `lineup` at creation; the context file prints the whole `authority.lineup`, so every member's context changes even with the switch off; and `config.teams` is in the routine approval digest, so every active routine blocks.)*
- **An `objective` evidence store module.** The log stays in the goal's sealed record, inside step 1's caps of 400 entries and 256 KiB, and corrections refuse at their share of it. A module adds tables, `deleteRun`, `runIds`, `counts`, and retention, with no reader in this step. *(My call. Step 1's "left for later" names it for step 2; it belongs with the first writer that needs more log than the record holds, the intent check of step 3.)*
- **Corrections of a standalone run** (`POST /api/teams/:id/record`) and a digest in standalone runs. A run's record starts at its first accepted plan, after the members that would read a digest have started, and the intent check of step 3 is the first writer that runs before them.
- Owner values, assumption, question, definition, rule, non-goal, excluded-path, and rubric ops, and the part 8 sentence for autonomous mode. They change parts that only step 3 creates or prints.
- The full record in the coordinator's context file (part 8). `TeamService` cannot read the goal's record; it needs a pinned copy in the launch, which step 3 can add beside the intent check's inputs.
- `pinned` criteria and artifact `schema` handles, which need a blob read through `teams.commandPrefix`.
- A web, phone, or Mac form for corrections or creation criteria.
- A controller's correction, and relay access to the route.

---

# Slice: the intent check

**Coordinator rulings (2026-11-17)**, from the independent review. The task text below already says each one.

- R1. A checker report of any kind but `intent-check` counts a failure, and `step` holds the run while the current checker exists (Task 7; Task 9's tests).
- R2. Authority surfaces print an intent decision as fixed host text, its question ids, and the owner's answer; the checker's stored report omits every dropped item, and a checker report of any other kind is stored as fixed `blocked` text (Tasks 1, 2, 5, 7, and 9).
- R3. A release never throws: a failed write emits one fixed event, and cancel, steer, `step`, and `hold` go on; the questions it leaves waiting are outside the current revision's invariants (Tasks 7 and 9).
- R4. Task 13 updates `tests/autonomy-pins.test.ts` line 91 and `tests/routing-auto-run.test.ts`; Task 14 updates `tests/routing-routes.test.ts` lines 165 and 196.
- R5. The `goals.ts` extraction moves from Task 10 into Task 13, so `goals.ts` and `teams.ts` stay within their baselines after every task ("Order and owners"; Tasks 10, 13, and 15).
- R6. Task 8 runs before Task 7; `correctionFeedback` moves from Task 5 into Task 7; an answer ends its questions' waits and drops their `decisionId` (Tasks 2, 5, 7, and 8).
- R7. An answer appends its correction only while the record holds fewer than 20 directions (Task 2).
- R8. Only an answer that appends a direction logs `after` through `logValue(…, "record:direction:ans<n>")`, so a reference always names an appended direction. Any other answer logs `after` inline with no text: `{ mode: "defaults", questions }`, or at 20 or more directions `{ mode: "text", questions, directionsFull: true }`, and the decision keeps the owner's answer. The rebuild removes the direction that a reference or an inline `direction.id` names, and none otherwise; a named direction that is missing, or is not a `correction`, is 409 (Tasks 2 and 3).
- R9. `answerIntentQuestions` returns undefined and writes nothing when no question waits on the decision, as a release does, so an answer replayed after a crash between a goal record's write and the run's save appends no second direction; Task 7 treats undefined as recorded. The text `Use the stated defaults` keeps defaults only when the decision offers that option (every waiting question's assumption is `assumed`); otherwise it is a text answer, so no question without a default is marked `default-kept` (Tasks 2 and 7).
- Minor. Task 8's `config-identity.ts` line goes after `const command`; Task 13's step 2 exempts `pins already taken never move`. Every line number is now on the INF-280 branch.

Spec `2026-11-13-objective-record-design.md` part 4 (the intent check), the parts of part 3 and part 8 that the check fills (the assumption register, open questions, and the derived-criterion marker), delivery order 3, acceptance 2 (the quote rule), 3, and 4, and the evaluator condition (C14) of `2026-11-13-continuous-autonomy-design.md` part 2. A goal cycle or standalone run pinned `autonomous` holds its project manager's plan while a read-only checker of another model family compares it with the objective record. Each gap the checker names becomes an assumption in the record. What only the owner knows becomes one blocking question, and the project manager then corrects the plan once. It builds on steps 1 and 2 (`# Slice: owner corrections and the record digest` above), which are on `main`, and on the autonomy pins of `2026-11-13-continuous-autonomy.md` Task 3, which left C14 three seams.

**On by the pinned mode, as part 4 says, and pinned when the run is created.** `createRun` records `run.intentCheck` (`"on"` or `"off"`) beside `run.autonomy` and `run.routing`, so the team view shows it. It is `"on"` for a goal cycle or standalone run pinned `autonomous`, and for one pinned `supervised` only when the project sets `objective.intentCheck: "on"`. A mission subteam and a handoff run hold no record (delivery order 1), so they pin `"off"`. A run without the field was created before this slice and never checks, even after a restart. *(My reading of the coordinator's guard: the pin is per run, so a new cycle of a goal created earlier is a new run and gets the check, and a cycle created before the deploy never does.)* Release note: autonomous projects get the intent check on new runs after this deploy.

**The owner's off switch.** `objective.intentCheck` takes `"on"` or `"off"` and has no default. Absent, the default of the pinned mode applies; `"off"` stops the check in autonomous mode, and `"on"` starts it in supervised mode. The key is inside the routine authority digest: `digestedProjectTeam` strips only `eval`, so `objective` is digested whole, as C11 asks. Writing the key therefore blocks active routines until the owner approves them again. The default needs no key, so no routine digest changes at the deploy, and routine runs get the check from then on. `objective.prompts` gates nothing here and becomes optional, so `{ intentCheck: "off" }` stands alone. *(My call: the check writes the record and corrects the plan whether or not the digest reaches prompts.)*

**The evaluator condition (C14) lands here.** A lineup is autonomy-ready when one of its evaluators (the `evaluators` slot, else the strong reviewer, then each strong escalation) has a known family other than the coordinator's. At the two start pins, `createRun` for a run that is not a goal cycle and `GoalService.create`, an autonomous project whose lineup is not ready pins `supervised`, with an event that gives the reason, and a standing goal is refused with `standing-requires-autonomy`. The enrollment view and `repo init` report `autonomyReady` and the reason. A goal cycle copies its goal's pin (`GoalService.step`), and a resumed or restarted run keeps its own, so C14 never moves a goal or run already pinned `autonomous` under supervised ceilings; when its lineup later loses the evaluator, its checks skip (`no-eligible-profile`). The documented lineup in `docs/teams.md` (coordinator `opus-xhigh`, reviewer `astra-high`, escalations `opus-xhigh` and `astra-xhigh`) derives `[astra-high, opus-xhigh, astra-xhigh]`. It is ready, and its checker is `astra-high` (Astra 6 high, family `gpt`, against the coordinator's `claude`). *(My calls: a run without a lineup is not ready, because C14 fails closed; a derived reviewer must be strong, as part 4 asks of every evaluator.)*

**The held plan is the stopped project manager's kept report.** When a plan passes today's checks, the result callback in `consume` records the check in a sealed `Stored.intentCheck` field and returns before `run.tasks` is set. The project manager is already stopped with its report. When the check ends, the host consumes that report again through today's path, so the accepted plan passes today's checks a second time and nothing else. *(My call against part 4's `run.pendingPlan`: the report is already durable in the sealed run file; a `run` field would reach every client and relay device through the team view; a second copy could drift from the one that passed the checks.)*

**The checker is an ordinary member with a prebuilt prompt.** Role `intent-checker`. It is read-only (its workspace gets `assertMemberReadOnly`, as a scout's does), with no entry tools, no GitHub grant, and no setup command. The fuse counts its launch, and the router never sees it. Its profile is the first `evaluators` profile whose family (C19, `familyOf`) is known and differs from the coordinator's and from the plan author's, on a provider that is not limited. Its prompt holds no run data; it reads everything from its own context file. All its reports go to the intent module, so it cannot block the run or open a decision of its own.

**One aggregated log entry per event.** `intent-check.applied`, `intent-check.answered`, `intent-check.released`, and `intent-check.skipped`, each with ids and counts inline and the prior state of every question it changed. Intent writes stop at step 2's `CORRECTION_LOG` share, so steering keeps its room, and `rebuildVersion` undoes all four. *(My call against one entry per assumption: up to 40 entries per check would fill the 380-entry share in about nine checks; one entry per event lasts about 180 to 350 checks.)*

**The check writes the register; the owner answers through the decision.** This slice adds no owner op, no route, and no new digest part. *(My calls against parts 2 and 8: the owner register ops (`assumption.set`, per-question answers, promotions, definitions, rules, non-goals, excluded paths, rubric version, owner values), their CLI forms, and `POST /api/teams/:id/record` are a slice of their own. Assumptions and open questions join the record digest in step 4, with the receipts that give their statuses meaning, because 32 assumptions of 500 bytes alone exceed its 6 KiB. The autonomous-mode sentence "propose an assumption" waits for step 4's proposal tools.)* Derived criteria are the one exception, as part 4 asks: they take effect at once in the record and, where `objective.prompts` is `"on"`, in the next cycle's digest, marked `derived`.

**Where the code and the design disagree.** No `run.pendingPlan` exists (ruled above). The lineup has no `crossReviewer`, so the derived `evaluators` list is the reviewer when it is strong, then each strong escalation. No enrollment view reports `autonomyReady`, and no pin site reads the lineup: the continuous-autonomy plan left C14 three seams (`createRun`, `GoalService.create`, `GoalService.step`), and Task 13 fills the first two, because the third must keep the goal's pin. Part 4 picks a checker whose family differs from the coordinator's; this plan also excludes the plan author's family, which a limit fallback can move (my call). `TeamDecision` has no `interrupt` field and no question ids, and C18 is not built: each record question names its decision through `Question.decisionId`, and the decision gains only `intentQuestions`, the ids that authority surfaces print in place of its text (R2). C16 is not on `main`, so a scout item is converted to `assume` and logged, as delivery order 3 says. Follow-ups are step 6, so `outOfScope` is ignored and counted. The option "I will answer each item" needs per-item controls, so a decision offers only "Use the stated defaults", and only when every waiting item has a default. `rebuildVersion` keeps the latest assumptions and questions today; Task 3 makes it undo them. `answer()` tells the owner "The requesting member will continue in a new attempt", which is false for the checker; Task 9 changes that sentence in place. A controller's answer is recorded `answeredBy: "owner"` (`server.ts` line 1447 calls `answer` with the default), so the record logs it as the owner's direction, as step 1 logs a controller's steer. `TeamService` already has a private method `intent` (`teams.ts` line 2649), so the new field is `intentChecks`.

**Coordinator rulings (2026-11-16), with the same day's correction to the first.**

- **The default follows part 4** (the correction replaced a default-off switch). The pin is taken in `createRun` (Task 13) and shown in the view, and a run created earlier never gets it. `objective.intentCheck` is the owner's off switch, inside the routine authority digest (Task 1). C14 starts new goals and runs without an eligible evaluator `supervised` and never moves a pin already taken (Tasks 4, 13, and 14).
- **The router (INF-280) shares plan validation, prompts, and launch.** `assertTaskProfiles` and every `agentProfileId` rule stay unchanged, and the checker never reaches `applyStart` or `recordStart`, which run for implementers only (`teams.ts` lines 5025 to 5029). "Touch points shared with the router" lists every shared line.
- **The checker sees and writes no routing value, score, member reasoning beyond the plan, or credential** ("Trust boundary").
- **The pending plan survives a restart and meets steer, resume, cancel, and the halt** (Tasks 7 and 9).
- **`teams.ts` stays inside its baseline after every task** ("Order and owners" gives the counts).

## Trust boundary, and what a review checks

These inputs originate outside the host:

- **The checker's report** is model output from a member that read the repository at the run's head, so repository text can steer it. The report tool checks it with `intentCheckReportSchema` (strict, every text bounded; Task 1). The host then applies it item by item (Task 2). A command test must name a configured check and is stored as its digest; any other test must pass the record's own test schema. Every item and every derived criterion passes `findSecret(value, { token: "", url: "" })`, which knows the private key, access token, GitHub grant, and egress proxy password shapes; a hit drops the item and counts it under `secret` without echoing it. The member report is stored screened (R2, Task 7): an item or criterion that would drop as `shape`, `secret`, `command`, or `quote`, a secret-shaped `outOfScope` id, and a secret-shaped summary never reach `member.report`, so views, `memberReports`, and blackboard entries never show one. A checker report of any other kind is stored as a `blocked` report of fixed host text that names only the kind it replaced. Checker text lands only in the sealed record, the screened member report, and the decision's question. No event text, log line, error body, plain column, or authority surface carries it.
- **The held plan and the discovery findings** are member text. They reach the checker's context file only, as claims. Each task loses `agentProfileId`, a routing value; `parallelism` stays out.
- **Answers** arrive through `POST /api/teams/:id/decisions/:decisionId/answer` (owner and controller devices; a goal's goes through `GoalService.answer`). A connector answers with `by: "connector"`; missions hold no check. Free text recorded `answeredBy: "owner"` becomes a `correction` direction in the sealed record. A connector's answer is delegated agent input and only releases the questions. Every answer reaches the corrected project manager with its `decisionAnswerLabel`, as today. Authority surfaces carry only owner words and fixed host text: they print an intent decision as `The intent check's questions q1, q3` and the owner's answer, never the checker's question (R2; Task 5 lists them). A delegate's answer prints in the same form in every member prompt's agent direction lines and the context's `agentAnswers`, so the checker's question reaches no member. Mission decisions, Slack intake, and connector requests never carry one.
- **Configuration.** `objective.intentCheck` and the lineup's `evaluators` come from the operator, inside the routine approval digest. The host derives both start pins in memory from the project's mode, that key, and the lineup.

What can reach prompt and context text:

- **The checker's prompt**: fixed text, its own profile line, the reporting paragraph, and the scratch-directory and graph lines that every member gets at launch. It holds no run data, so the permission agent's 4,000-character read sees only fixed text.
- **The checker's context file**: the record without its log, criteria without `latest`, assumptions without `proposals`, and all questions; the held plan's summary, brief, tasks without `agentProfileId`, and verification; this revision's discovery findings; the configured checks; the mode, `criteriaDue`, and the limits. No blackboard digest, no other member report, no routing pin, score, eval result, usage figure, outcome row, verdict, or credential. At most 1 MiB, or the check is skipped.
- **The corrected project manager**: host-built feedback of at most 16 KiB (the check's items with their statuses and defaults, and the answer with its label), in the late section "Feedback excerpt (derived evidence, not requirements)" (`team-prompts.ts` line 443) and in its context file. In a short prompt that section can fall inside the permission agent's 4,000-character read. It then exposes checker text labelled as derived evidence and the owner's answer; the permission agent reads task text as untrusted evidence (`permission-policy.ts` line 84).
- **Later cycles' members**: derived criteria print in the goal section with `derived: true` and one conditional sentence. The goal section comes early in every member prompt, so a derived statement can fall inside the permission agent's 4,000-character read. It is at most 1,000 bytes, one of at most 8 active criteria, quote-checked, and secret-scanned. Part 4 asks for this ("take effect at once").
- **The blackboard**: the checker's screened report becomes a host `report` entry with authority `claim`, as every member report does (`evidence/host-entries.ts` line 75); an owner's answer becomes a `direction` entry whose question is the fixed text with ids (line 120).
- **Views**: the checker member (role, title, profile, status, screened report), its decision with `intentQuestions`, and a configured `evaluators` list in `run.lineup` reach owner, controller, viewer, and relay devices through the team view, as every member, decision, and lineup profile does. So does `run.intentCheck`, an enumeration; the enrollment view's `autonomyReady` and its reason, also enumerations, reach every device that reads the project. `Stored.intentCheck` is outside `run` and reaches no view.

No new Git form: the checker's workspace, context write, and read-only check use `prepareMemberWorkspace`, `writeTeamContext`, and `assertMemberReadOnly`, as every member does.

**Sizes.** A report holds at most 16 items (3 of them scouts), 8 criteria, and 24 `outOfScope` ids, with a summary of at most 4,000 characters. Item fields have the byte bounds of Task 1, so a record question built from them is at most 990 bytes. The report variant adds about 3 KiB to the report tool's JSON schema in every member's tool list; no prompt prints it. A check adds at most 16 assumptions, 16 questions, and 8 criteria. The record's caps stand (32 assumptions, 64 questions with 8 open, 8 active criteria, 32 KiB of capped bytes); an item over a cap is dropped and counted. One log entry per event, inline values at most 2 KiB, references as step 1 logs a long direction. The decision's question is at most 4,000 characters, each waiting item's line at most 440. The checker's prompt is at most 8 KiB, its context at most 1 MiB, the corrected-plan feedback at most 16 KiB, and `Stored.intentCheck` under 400 bytes (with the screen's four counts).

**Cost.** On a run pinned `"off"`, an accepted plan costs one field read, and nothing runs per tick. `createRun`, `GoalService.create`, and the enrollment view compute readiness from the lineup in memory: at most 4 evaluators, one family match each. With it on, a run revision parses its record at most five times (hold, launch context, screen, apply, answer) and writes it at most three times. `step` runs once per tick for a run with no tasks and reads memory only: the state, the members, and one decision by id. A goal record is read and written in `GoalService`'s memory through Task 10's port, with one sealed write per change. No store statement, index, list route, or view reads anything new, so 1,000 sessions and 10,000 outcome rows change nothing. A checked revision adds one session, two after a failure.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| A supervised run without the key; an autonomous run with `intentCheck: "off"`; a mission subteam or handoff run; a run created before this slice, after a restart | No checker; the plan accepted as today | Task 9 `the check follows the run's pin`; Task 13 `each new run pins the intent check by mode and setting`; Task 7 `the gate reads the run's pin` |
| A key written, then a routine's next check | `objective.intentCheck` or the lineup's `evaluators` changes the authority digest and blocks the routine; absent keys keep it | Task 1 `the intent check settings are inside the routine approval digest` |
| An autonomous project whose lineup has no eligible evaluator, or no lineup | New runs and goals pin `supervised` with an event that gives the reason; a standing goal is refused (`standing-requires-autonomy`); the enrollment view shows `autonomyReady: false` and the reason | Task 13 `a lineup without an eligible evaluator starts new runs and goals supervised`; Task 14 `the enrollment view says whether autonomy is ready` |
| The lineup loses its evaluator while a goal pinned `autonomous` runs, or while a run pinned `autonomous` pauses and resumes | Pins never move: the next cycle and the resumed run stay `autonomous`, and their checks skip (`no-eligible-profile`) | Task 13 `pins already taken never move` |
| An autonomous check with nothing that waits | The original plan accepted once; one `plan.accepted`; the record one version up | Task 9 `a check with nothing to ask accepts the plan once` |
| Acceptance 3 | The plan waits on one decision; after the answer, the corrected plan is accepted with no second check | Task 9 `acceptance 3: an outcome ask waits for the owner and the corrected plan is not checked again` |
| Acceptance 4 | `assumed`, the conversion logged, no decision | Task 2 `acceptance 4: an autonomous detail ask is assumed and logged` |
| A restart in each state: queued, checking, waiting, correcting, accepting | One checker per revision, at most one decision, one accepted plan | Task 9 `the check survives a restart in every state` |
| Random orders of hold, report, failure, answer, steer, cancel, and restart | At most one decision and two checkers per revision; the plan accepted at most once, never while a question waits | Task 7 `seeded event orders keep the invariants` |
| The same checker report consumed twice | Applied once: the applied entry names the checker | Task 7 `a report applies once` |
| A restart while the checker's report is being checked (its result operation is pending) | Today's restart recovery for a pending result operation; the next check releases any stale wait | Existing restart recovery tests; Task 2 `a new check releases earlier waits` |
| A steer, or a pause and a resume, while the check runs or waits | A new revision: the old report is ignored, its waits released (`replanned`), the new revision checked once, and the old decision answers 404 `decision-not-found` | Task 9 `steering, resume, and cancel meet the pending plan` |
| The owner's halt while waiting, an answer during the halt, then the release | The same revision (`resumeRun` in place, `teams.ts` line 2312): the decision stays current, and the kept answer resolves after the release | Task 9 `steering, resume, and cancel meet the pending plan` |
| Cancel while waiting | `intent-check.released` with cause `cancelled` | Task 9 `steering, resume, and cancel meet the pending plan` |
| Cancel or steer while the record's log is full or its write fails | One `releaseUnrecorded` event; the cancel saves and aborts, and the steer starts its revision, as without the check | Task 7 `a release that fails stops nothing`; Task 9 `cancel and steer on a full log complete` |
| The checker ends without a report, stalls, hits a limit, reports any kind but `intent-check` (`question`, `blocked`, `plan`, …), or changes a file | One replacement on a fresh choice (limited providers excluded); a second failure skips (`checker-failed`) and accepts the plan unchecked; no project manager starts meanwhile | Task 7 `failures are bounded`, `a checker plan report counts a failure and starts no project manager`; Task 9 `a failed checker is replaced once and then skipped` |
| A later pass while the checker exists (running, reported, or its operation pending) | `step` returns true; nothing starts | Task 7 `a second pass in checking with the checker present starts nothing` |
| No eligible profile, an unreadable record, a full log, or a context over 1 MiB | Skipped with its reason and one event; the plan accepted; no checker launched | Task 7 `a skip never loses the plan` |
| The fuse refuses the checker | The plan waits with the fuse; nothing is skipped | Task 8 `the intent checker is a counted launch role` |
| 40 decisions already | Today's `team-decision-limit` block; the record unchanged | Task 7 `the decision cap blocks before anything is written` |
| A secret-shaped item or criterion | Dropped and counted; never in the record, a log entry, an event, an error, the stored member report, a view, or a blackboard entry | Task 2 `secret-shaped items are dropped and never echoed`; Task 7 `the stored report is screened`; Task 9 `the checker is read-only and owns nothing` |
| An answered intent decision | Owner sections, the authority hash input, permission follow-ups, the direction entry, Linear, and the eval capsule print fixed text, the ids, and the answer; for a delegate's answer, so do the agent direction lines and `agentAnswers` | Task 5 `an intent decision's question reaches no authority surface`, `an intent decision's Linear comments hold no checker text` |
| A derived criterion without its quote, on a standalone run, or beyond 8 active | Dropped (`quote`, `cap`) or ignored, and counted | Task 2 `acceptance 2: a derived criterion must quote the statement` |
| A ninth open question | The oldest open question that does not wait closes as `default-kept`; with 8 waiting, the new question is dropped and its assumption kept | Task 2 `a ninth open question closes the oldest that does not wait` |
| A run deleted or blocked while its questions wait | The goal's next check releases them inside its applied entry | Task 2 `a new check releases earlier waits` |
| Random intent writes, steering, and corrections with a reload between steps | Every version rebuilds to its snapshot and parses | Task 2 `every version rebuilds after random intent writes` |
| A log at its share; a record with 20 directions | Apply, answer, and release refuse with `objective-log-full`; an answer at 20 directions appends none (`directionsFull`); 20 maximal steers still fit | Task 2 `intent writes keep room for steering` |
| A goal record write that fails | The goal's record unchanged in memory and on disk; the check skipped (`record-unavailable`) | Task 10 `a failed goal record write changes nothing` |
| No evidence store (`options.entries` absent) | The check runs; entries and launch marks are skipped as today | Task 9's tests run without a store |
| A rollback to a host without this slice | A config with `objective.intentCheck` or lineup `evaluators` fails the old strict schemas; a goal whose pinned lineup has `evaluators` fails at its next cycle's creation and blocks; a pending launch whose digest marks a criterion `derived` fails the old strict `teamGoalContextSchema` and blocks that goal; a version before an intent entry answers 409 `objective-version-unavailable` (the latest still reads); a run with a held plan or a checker member blocks or replans on the old host, which also prints an answered intent decision's question on its authority surfaces; the old fuse cannot read a baseline that holds a checker launch and falls back as for an unreadable baseline until those launches leave its window; an older host ignores `run.intentCheck`, because no strict schema reads a stored run, and keeps the `supervised` pins that C14 wrote | No test. `docs/teams.md` lists the steps before a rollback: remove both keys, finish or cancel runs with a checker member, and expect goals with a pinned `evaluators` lineup to block |

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/intent-report.ts` (create) | The checker's report schema and its limits; imports zod only |
| `packages/host/src/team-types.ts` (modify) | The report variant, `objective.intentCheck`, the lineup's `evaluators`, the digest's `derived` marker, the run's pin field, the decision's `intentQuestions` and `decisionAuthorityQuestion` (Task 1); the role (Task 8) |
| `packages/host/src/objective-types.ts` (modify) | Export the assumption test schema |
| `packages/host/src/objective-intent.ts` (create) | Pure: applying a report, answers, releases, skips, the decision's text; the goal record port type |
| `packages/host/src/objective-record.ts` (modify) | The intent op names; `rebuildVersion` undoes them |
| `packages/host/src/evaluator-profiles.ts` (create) | Pure: the evaluator list, readiness, the start mode, the intent check pin, and the checker's profile |
| `packages/host/src/intent-prompt.ts` (create) | Pure: the checker's prompt and context (Task 5), and the corrected plan's feedback (Task 7) |
| `packages/host/src/team-prompts.ts` (modify) | Five helpers exported; the derived sentence; the decision's authority form in owner sections |
| `packages/host/src/evidence/host-entries.ts`, `linear.ts`, `eval-rules.ts` (modify) | One line each: the decision's authority form (Task 5) |
| `packages/host/src/objective-digest.ts`, `objective-cli.ts` (modify) | The digest marks derived criteria; the record lines show the register |
| `packages/host/src/team-intent.ts` (create) | The per-run check: the gate, the states, the hooks, the events |
| `packages/host/src/fuse/baseline.ts`, `manager.ts`, `worker.ts`, `github-grants.ts`, `config-identity.ts` (modify) | The role in every role list; no grant; its own prompt version |
| `packages/host/src/teams.ts` (modify), `team-changes.ts` (create) | The change helpers moved out (Task 15); the start pins in `createRun` (Task 13); the hooks (Task 9) |
| `packages/host/src/objective-goals.ts`, `goals.ts`, `goal-standing.ts` (modify) | C14 at goal creation and one creation helper moved (Task 13); the goal record port (Task 10) |
| `packages/host/src/repo-enrollment.ts`, `routing-routes.ts`, `team-cli.ts` (modify) | `autonomyReady` and its reason in the enrollment view and `repo init`; the routing status previews the start mode |
| `apps/web/src/teams.tsx`, `apps/mobile/src/features/teams/model.ts`, `packages/host/src/team-watch.ts` (modify) | The role's name and order in clients |
| `tests/fixtures/team-agent.mjs` (modify) | The fake checker |
| `docs/teams.md`, the spec (modify) | The check, its settings, the rollback steps, and the amendments |
| `tests/{intent-schemas,objective-intent,evaluator-profiles,intent-prompt,team-intent,intent-check}.test.ts` (create); `tests/{routines,objective-record,team-prompts,linear-tracking,objective-digest,objective-cli,fuse-baseline,github-grants,config-identity,objective-goals,team-watch,autonomy-pins,autonomy-enrollment,standing-goals,routing-run,routing-auto-run,routing-routes}.test.ts` (modify) | Pure rules, the state machine with a fake host, the host with the fake agent, the pins, and the lineups that autonomous tests need |

**Touch points shared with the router (INF-280).** This slice lands after INF-280, so it keeps every router line. In `teams.ts`: line 1631, where `run.autonomy` is pinned before `this.router?.pin` reads it (1632), changes in place for C14 with its comment (1630), and the intent check pin goes after line 1633; `routing-routes.ts` lines 3 and 62 change in place, so the routing status reads the mode a new run pins. In `prepareMember`, lines 5023, 5028, 5037, and 5046 change in place. Line 5028 is shared: its `newMember` call keeps the router's `applyStart` profile whenever no prebuilt profile is given, and the router's start (5025 to 5027) and `recordStart` (5029) are not touched. In `readMemberJournal`, line 4895 changes in place. In `consume`, one line after 5241 and one before 5343; `validateTeamPlan` and `assertTaskProfiles` (5316 and 5317) are not touched. In `launch`, one line before 5166, and 5167 and 5168 in place. In `team-prompts.ts`, `export` on lines 11, 12, 15, 230, and 268, and lines 90, 108, and 468 in place. In `team-types.ts`, the lineup schema after line 272 and `lineupProfiles` (line 321); `teamRoutingSchema` (`routing-policy.ts`) is not touched.

**Order and owners.** Tasks 1, 3, 11, and 15 run first, in parallel. Then Tasks 4, 5, and 6 run in parallel (each needs Task 1). Then Tasks 2 (needs 3 and 6), 13 (needs 4 and 15), and 14 (needs 4) run in parallel. Then Task 8 (needs 1, 5, and 13). Then Task 7 (needs 2, 4, 5, and 8, because its code names the role). Then Task 9 (needs 7). Then Tasks 10 (needs 9) and 12 run in parallel. Each file has one writer at a time: Tasks 1 and 8 write `team-types.ts`, in that order; Tasks 15, 13, 8, and 9 write `teams.ts`; Tasks 13 and 10 write `goals.ts`; Tasks 5 and 7 write `intent-prompt.ts` and its test file. Every line number is on the INF-280 branch (`da7eef28` and the changes that complete it); files INF-280 does not touch read the same on `main` at `0e108bf`. Each edit quotes the code it changes, so a worker finds it by that code after INF-280 lands, and checks the position against the earlier tasks' edits: Task 15 removes `teams.ts` lines 254 to 309 and adds 2 lines after line 55; Task 13 adds 1 line after `teams.ts` line 55, 1 after 1633, and 1 after 1651, and in `goals.ts` adds 1 line after line 5 and 1 after 279 and removes lines 71 to 80 and 679. Within a task, apply edits from the bottom up. `check:size` holds after every task: `teams.ts` (5,747, baseline 5,757) is 5,693 after Task 15, 5,696 after Tasks 13 and 8, and 5,707 after Task 9; `goals.ts` (1,042, baseline 1,042) is 1,033 after Task 13 and 1,034 after Task 10. Each task confirms its counts with `wc -l`, and recomputes them from its stated net change if INF-280 lands with other counts. Every worker in a worktree is told never to use `git stash`; it compares with `git show HEAD:<path>` and sets work aside with a WIP commit. Workers run test batches that start a host in the background, so a steer can reach them. The host typecheck does not cover `tests/`, so each task runs its test files, and a task reports any cancelled test as a failure.

## Review Focus

1. A check the pin does not allow, or a pin that moves: a checker on a supervised run without the key, on an autonomous run with `"off"`, or on a run created before this slice; a routine digest or prompt byte changed while the key is absent; C14 moving a goal or run already pinned `autonomous`. Expect none (Task 9 `the check follows the run's pin`; Task 13 `pins already taken never move`, `each new run pins the intent check by mode and setting`; Task 1 `the intent check settings are inside the routine approval digest`; Task 5 `derived criteria are marked in the goal section`).
2. A plan accepted twice, never, or checked twice; an answer lost; a run stuck after a restart, a steer, a pause, or a cancel; a checker report of another kind that starts planning again; a failed release that stops a cancel or a steer. Expect one accepted plan per revision and a run that always moves on (Task 9 `the check survives a restart in every state`, `steering, resume, and cancel meet the pending plan`, `cancel and steer on a full log complete`; Task 7 `seeded event orders keep the invariants`, `a skip never loses the plan`, `a checker plan report counts a failure and starts no project manager`).
3. Member text or a credential where it must not be: run data in the checker's prompt; a routing value, score, other member's report, or credential in its context; a secret-shaped item in the record, the stored member report, a view, or a blackboard entry; checker text on an authority surface; item text in an event, log line, error body, or plain column. Expect none (Task 5 `the checker's prompt holds no run data`, `the checker's context holds the record, the plan, and the findings, and nothing else`, `an intent decision's question reaches no authority surface`; Task 2 `secret-shaped items are dropped and never echoed`; Task 9 `the checker is read-only and owns nothing`).
4. A history that no longer rebuilds, a record that the schema refuses, or intent writes that crowd out steering. Expect every version to rebuild and parse, and steering to keep its room (Task 3 `a rebuild undoes the intent check`; Task 2 `every version rebuilds after random intent writes`, `intent writes keep room for steering`).
5. A checker that can do more than read and report: an entry tool, a GitHub grant, an edit, a block, its own decision, a profile of the coordinator's or the plan author's family, or a launch the fuse does not count. Expect none (Task 8 `the intent checker gets no GitHub grant`, `the intent checker is a counted launch role`; Task 4 `the checker differs in family from the coordinator and the plan's author`; Task 7 `the checker cannot block, ask, or post`; Task 9 `the checker is read-only and owns nothing`).

### Task 1: the report and the settings

**Files:** `packages/host/src/intent-report.ts` (create), `packages/host/src/team-types.ts`, `tests/intent-schemas.test.ts` (create), `tests/routines.test.ts`. Runs first, in parallel with Tasks 3 and 11.

**Interfaces (produces):**
```ts
// intent-report.ts: imports zod only, so team-types.ts imports it without an import cycle.
export const INTENT_REPORT_LIMITS = {
  items: 16, scouts: 3, criteria: 8, outOfScope: 24, summaryChars: 4_000,
  dimensionBytes: 200, whyBytes: 500, statementBytes: 500, refutedByBytes: 500, questionBytes: 400,
  options: 4, optionBytes: 40, defaultBytes: 200, scoutBytes: 500, testBytes: 1_024, criterionBytes: 2_048, followUpChars: 64,
} as const;
export type IntentItem = {
  dimension: string; why: string; criticality: "outcome" | "plan" | "detail"; disposition: "ask" | "scout" | "assume";
  assumption: { statement: string; refutedBy: string; test: unknown };              // test: JSON of at most testBytes
  question?: { text: string; options: string[]; default?: string; interrupt?: "definition" };
  scout?: string;
};
export const intentItemSchema: z.ZodType<IntentItem>;
/** No type annotation, so z.discriminatedUnion takes it. */
export const intentCheckReportSchema = z.object({
  kind: z.literal("intent-check"),
  summary: z.string().min(1).max(4_000),
  items: z.array(intentItemSchema).max(16),
  criteria: z.array(/* JSON of at most criterionBytes */).min(1).max(8).optional(),
  outOfScope: z.array(z.string().min(1).max(64)).max(24).optional(),
}).strict().superRefine(/* at most 3 items with disposition "scout" */);
export type IntentCheckReport = z.infer<typeof intentCheckReportSchema>;

// team-types.ts
// teamReportSchema gains intentCheckReportSchema as its last variant.
// teamProjectSchema: objective: z.strictObject({ prompts: z.enum(["on", "off"]).optional(), intentCheck: z.enum(["on", "off"]).optional() }).optional(),
// TeamRun gains, after autonomy (line 675): intentCheck?: "on" | "off";  // pinned by createRun (Task 13); absent on runs created before this slice
// TeamDecision gains, after answeredAt (line 652): intentQuestions?: string[];  // ids of the record questions it asks; set by Task 7
// After decisionAnswerLabel (line 802), the one form every authority surface prints for a decision's question (R2):
//   export const decisionAuthorityQuestion = (decision: Pick<TeamDecision, "question" | "intentQuestions">) =>
//     decision.intentQuestions ? `The intent check's questions ${decision.intentQuestions.join(", ")}` : decision.question;
// teamLineupSchema gains, after permissionReviewer: evaluators: z.array(teamModelProfileSchema).min(1).max(4).optional(),
//   and its superRefine adds "evaluators" to the pools whose ids are unique and refuses an evaluator without tier "strong".
// LineupShape gains "evaluators"; lineupProfiles appends ...(lineup.evaluators ?? []) last.
// recordDigestSchema's criterion gains, after producer: derived: z.literal(true).optional().
```

**Decisions:**

- An item's refinements: `question` iff `ask`; `scout` iff `scout`; a question has exactly one of `default` and `interrupt`. Bounded JSON is `z.unknown()` with a refinement that refuses `undefined` and a value whose `JSON.stringify` exceeds its bound, because `z.toJSONSchema` must still build the report tool's schema at load (`team-mcp.ts` line 20).
- The schema checks shape and bounds; the host checks meaning item by item (Task 2). A shape refusal reaches the checker at once through the report tool, which is part 4's "refuses a question with neither and gives one correction". *(My call: refusing a whole report for one bad test would spend the checker's only replacement on a detail.)*
- No key has a default. Absent keys leave every routine digest, lineup fingerprint, prompt, and context unchanged. Writing either key changes `RoutineService.authority` (`digestedProjectTeam` strips only `eval`, and `config.teams` is digested whole), as "Authority and safety" requires.
- `objective.prompts` becomes optional, so the owner can write `{ intentCheck: "off" }` alone. `objectivePromptsOn` reads only `"on"`, so an absent value keeps prompts off, and step 2's `the objective switch is inside the routine approval digest` passes unchanged. `TeamRun.intentCheck` is a type only; Task 13 writes it.
- `intentQuestions` holds ids only, so it may reach every view and relay device; no strict schema reads a stored decision. A decision without it prints as today everywhere.
- `evaluators` is the lineup's last key, because lineup fingerprints follow key order; the comment "Keep this last" (line 271) moves to it. The identity rule already allows an evaluator that reuses another slot's id with the same identity, so a lineup can list its reviewer's profile (acceptance 11).

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the intent report is bounded and strict` (intent-schemas) | A maximal report parses, and `teamReportSchema` accepts it. 17 items, a fourth scout, a 201-byte dimension, an ask without `question`, a question with both `default` and `interrupt` or with neither, a `scout` on an assume item, an unknown key, a test of 1,025 bytes, and a missing test are refused. `z.toJSONSchema(z.object({ report: teamReportSchema }).strict(), { target: "draft-7" })` does not throw. |
| `the intent check setting stands alone` (intent-schemas) | `{ intentCheck: "off" }`, `{ prompts: "off", intentCheck: "on" }`, and `{ prompts: "on" }` parse; `{ intentCheck: "maybe" }` and an unknown key are refused; a project without the key parses with no `objective` key; `objectivePromptsOn` is false for `{ intentCheck: "on" }`. |
| `evaluators are strong, unique, and last` (intent-schemas) | Five evaluators, a light one, and two with one id are refused. A parsed lineup's last key is `evaluators`. `JSON.stringify` of a lineup without the slot equals the string pinned from the base commit. `lineupProfiles` ends with the evaluators. An evaluator that reuses the reviewer's id and identity parses. |
| `a digest criterion may be marked derived` (intent-schemas) | `derived: true` parses; `derived: false` and `derived: "yes"` are refused. `decisionAuthorityQuestion` gives `The intent check's questions q1, q2` for a decision with `intentQuestions: ["q1", "q2"]`, and the question itself without the field. |
| `the intent check settings are inside the routine approval digest` (routines) | In the pattern of step 2's test: a routine keeps its stored authority across a reload with both keys absent; it blocks at its next check after the project gains `objective: { intentCheck: "off" }`; a second routine blocks after the lineup gains `evaluators`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/intent-schemas.test.ts tests/routines.test.ts tests/autonomy-mode.test.ts` and the host typecheck, then commit.

### Task 2: applying a report to the record

**Files:** `packages/host/src/objective-intent.ts` (create), `packages/host/src/objective-types.ts`, `tests/objective-intent.test.ts` (create). Needs Task 1, Task 3, and Task 6.

**Interfaces (produces):** pure; no I/O, no clock, no randomness (time and ids come from the caller).
```ts
// objective-types.ts: today's private `assumptionTest`, exported unchanged.
export const assumptionTestSchema: z.ZodType<AssumptionTest>;

// objective-intent.ts
export const INTENT_DEFAULTS_ANSWER = "Use the stated defaults";
export type IntentMode = "autonomous" | "supervised";
export type IntentDrop = "shape" | "secret" | "cap" | "quote" | "command";
export type IntentSkipReason = "checker-failed" | "no-eligible-profile" | "record-unavailable" | "log-full" | "context-too-large";
export type IntentReleaseCause = "replanned" | "cancelled" | "delegated-answer";
export type IntentScreenDrop = Exclude<IntentDrop, "cap">;
/** The report minus every item and criterion that fails shape, secret, command, or quote, and minus secret-shaped outOfScope ids;
 *  a secret-shaped summary becomes "Summary withheld: it matched a secret shape.". Without a statement every criterion drops as quote.
 *  Idempotent: screening a kept report drops nothing. */
export function screenIntentReport(report: IntentCheckReport, input: { statement?: { objective: string; directions: string[] };
  configured: readonly TeamCommand[] }): { kept: IntentCheckReport; dropped: Record<IntentScreenDrop, number> };
export type IntentApplyContext = { runId: string; revision: number; checkerMemberId: string; decisionId: string; mode: IntentMode;
  goal: boolean; configured: readonly TeamCommand[]; at: string; screened?: Partial<Record<IntentScreenDrop, number>> };
export type IntentApplied = { record: ObjectiveRecord; decision?: IntentDecision;
  added: { assumptions: string[]; questions: string[]; criteria: string[] }; dropped: Record<IntentDrop, number>; converted: number };
export type IntentDecision = { id: string; question: string; options: string[]; questions: string[] };   // questions: the waiting ids
/** One version up and one `intent-check.applied` entry. A bad item is dropped and counted, never thrown.
 *  Throws objectiveError("objective-log-full") past CORRECTION_LOG, and objectiveError("objective-op-refused") when the result fails objectiveRecordSchema. */
export function applyIntentReport(record: ObjectiveRecord, report: IntentCheckReport, context: IntentApplyContext): IntentApplied;
/** The blocking question for the questions that wait on `decisionId`, built from the record alone; undefined when none waits. */
export function intentDecision(record: ObjectiveRecord, decisionId: string): IntentDecision | undefined;
/** The `intent-check.applied` entry whose handle is this checker. */
export function intentApplied(record: ObjectiveRecord, checkerMemberId: string): LogEntry | undefined;
/** No applied entry carries `statementDigest`, or the latest one differs from the current statement's. */
export function criteriaDue(record: ObjectiveRecord): boolean;
/** The owner's answer to the questions waiting on `decisionId`; each stops waiting and drops decisionId. One version up, one `intent-check.answered` entry.
 *  Undefined when none waits (R9). Throws objectiveError("objective-log-full"), and objectiveError("objective-op-invalid") for text outside 1 to 8,000 characters. */
export function answerIntentQuestions(record: ObjectiveRecord, answer: { decisionId: string; runId: string; text: string; at: string }): ObjectiveRecord | undefined;
/** The questions waiting on `decisionId` stop waiting; undefined when none waits. One version up, one `intent-check.released` entry. Throws objectiveError("objective-log-full"). */
export function releaseIntentQuestions(record: ObjectiveRecord, input: { decisionId: string; runId: string; cause: IntentReleaseCause; at: string }): ObjectiveRecord | undefined;
/** One `intent-check.skipped` entry at the current version; the body is unchanged. Undefined when the log has no room. */
export function skipIntentCheck(record: ObjectiveRecord, input: { runId: string; revision: number; reason: IntentSkipReason; at: string }): ObjectiveRecord | undefined;
/** A goal's record in GoalService's memory (Task 10). `write` throws objectiveError("objective-version-stale") when the held version differs,
 *  and rethrows a failed save after restoring the record. */
export type GoalRecordPort = { read(goalId: string): ObjectiveState; write(goalId: string, expectedVersion: number, next: ObjectiveRecord): void };
```

**Decisions:**

- **The order inside one apply.** First, every question that waits on another decision stops waiting; it is listed in the entry's `released`, with its prior state in `before`. A run has one blocking question, and a stale wait from a deleted or blocked run ends here. Then the items in report order, then the criteria, then log room, then `objectiveRecordSchema.safeParse`.
- **An item.** (1) Its test: `{ kind: "command", run: TeamCommand, refutesOn }` must match a configured check by `commandDigest` (else `command`) and is stored as `{ kind: "command", command: <digest>, refutesOn }`; any other test must pass `assumptionTestSchema` (else `shape`). (2) `findSecret(item, { token: "", url: "" })` (else `secret`). (3) Its status. `assume` gives `assumed`. `scout` gives `assumed` and counts in `converted`, because C16 is absent (delivery order 3). In autonomous mode an `ask` is converted to `assumed` unless its criticality is `outcome` and its test kind is `owner`; a remaining ask with `default` gives `assumed` and an open question, and one with `interrupt` gives `unchecked` and a waiting question. In supervised mode every ask's question waits: `assumed` with a default, `unchecked` without. (4) Caps, all counted under `cap`: the 33rd assumption or the 65th question drops the item. Opening a ninth open question first closes the oldest open question that does not wait (`default-kept`, listed in `closed`); with 8 waiting, the new question is dropped and its assumption kept. An item that would pass 32 KiB of capped bytes is dropped. (5) Ids: `a<n>` and `q<n>`, one more than the highest number with that prefix in the record, never reused. The assumption has `origin: "intent-check"`, empty `evidence` and `proposals`, and `question` when one opens. The question's text is `${dimension}: ${text}`, then ` Options: a; b.` when there are options, then ` Default: ${default}.` or ` No default.`: at most 990 bytes under Task 1's bounds. A waiting question carries `decisionId`.
- **The screen** (R2). `screenIntentReport` runs steps (1) and (2) on every item, the criteria's shape, secret, quote, and command checks below on every criterion (due or not), and `findSecret` on each `outOfScope` id and the summary. Task 7 stores its `kept` report as the member's report and keeps its counts; `applyIntentReport` screens again, a no-op on a kept report, and adds `context.screened` to `dropped`, so the applied entry counts every drop.
- **Derived criteria** apply only when `context.goal` and `criteriaDue(record)`; otherwise each counts in `ignored.criteria`. Each: `derivedFrom` (1 to 500 bytes) is split off; the rest must pass step 2's `criterionInputSchema` and fit its check (`shape`); `findSecret` (`secret`); the quote must appear in the objective or a direction (`quote`, acceptance 2); a command must be configured (`command`); the canonical criterion is at most 2,048 bytes (`shape`); active criteria stay at most 8 and `recordDigestFor` at most 6,144 bytes (`cap`). An accepted one is `criterionFromInput(input, nextCriterionId(record), configured)` with `origin: "derived"` and `derivedFrom`. Task 6 adds the `derived` marker to `recordDigestFor`, so no test here pins a byte boundary. `outOfScope` ids count in `ignored.outOfScope`.
- **The decision** (`intentDecision`) exists when a question waits on `decisionId`. Its text is `The intent check needs your answer on N item(s) before the plan proceeds. Answer in one message.`, then one line per waiting question in record order, `${i}. ${question.text}` cut to 440 characters at a character boundary ending in `...`. At most 4,000 characters. Options are `["Use the stated defaults"]` when every waiting question's assumption is `assumed`, else `[]`. `questions` lists the waiting ids, which Task 7 stores as the decision's `intentQuestions`. It reads only the record, so a restart rebuilds the same decision.
- **The applied entry** is at version + 1: actor `intent-check`, authority `claim`, op `intent-check.applied`, target `context.runId`, handle `context.checkerMemberId`. `after` is inline: `{ revision, mode, added, addedDigest, released, closed, waiting, decision?, converted, dropped, ignored, statementDigest? }`. `before` is inline: `{ questions: [{ id, state, waits, decisionId? }] }` for each question it released or closed. `addedDigest` is the SHA-256 hex of the canonical JSON `{ assumptions, questions, criteria }` of the added objects as written. `statementDigest`, the SHA-256 hex of the canonical `{ objective, directions: [text…] }`, is written only when criteria were considered. At most 48 ids and the counts keep `after` inside 2 KiB.
- **An answer**: actor `owner`, authority `direction`, op `intent-check.answered`, target the decision id, handle the run id. Each question that waits on the decision stops waiting and drops `decisionId`, as a release does, so no record question names the decision afterwards and the decision is closed (R6; the seeded test of Task 7 relies on it). The text `Use the stated defaults`, when the decision offers it, sets those questions to `default-kept` (R9). Other text sets them to `answered` and appends `{ id: "ans<n>", text, source: "correction", at }` to the directions only while the record holds fewer than 20 directions, so steering's 20 (`teams.ts` line 1746, `goals.ts` line 530) always fit under the record's 40 (`syncDirections` fails past it, `objective-record.ts` line 181); at 20 or more it appends none and logs `directionsFull: true` (R7). No status changes (part 4: "it sets no status"). `before` holds each question's prior `state`, `waits`, and `decisionId`. `after` is `{ mode: "defaults" | "text", questions, direction?, directionsFull? }`. An answer that appends a direction logs it through `logValue(…, "record:direction:ans<n>")`, so a long answer is logged by reference, as step 1 logs a long steer; any other answer logs `after` inline, with no text (R8). Rule 9 counts only `direction.appended` and `direction.copied` entries against steering directions, so a `correction` direction keeps step 1's history rule.
- **A release**: actor `host`, authority `receipt`, op `intent-check.released`, target the decision id, handle the run id, `after` `{ cause, questions }`. Each question keeps its state, stops waiting, and drops `decisionId`.
- **A skip**: actor `host`, authority `receipt`, op `intent-check.skipped`, target the run id, `after` `{ revision, reason }`, at the record's current version, so log versions stay or rise by one.
- **Log room** is step 2's `CORRECTION_LOG` (380 entries, 210 KiB): apply, answer, and release throw `objective-log-full` past it, and a skip returns undefined.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `acceptance 4: an autonomous detail ask is assumed and logged` | Autonomous: an ask with criticality `detail`, an owner test, and a default gives one `assumed` assumption, no question, no decision, and `converted: 1` in the applied entry. |
| `acceptance 3, record side: an outcome ask waits and a scout is assumed` | Autonomous: an outcome ask with an owner test and `interrupt`, and a scout item: `a1` `unchecked` with `q1` waiting on the decision id, `a2` `assumed`, `converted: 1`, and a decision whose text holds `q1`'s dimension, with options `[]`. Supervised, with a default instead of `interrupt`: options `["Use the stated defaults"]`. |
| `every item is written down or counted` | 16 items with one bad test, one unconfigured command, and one secret: 13 assumptions added and dropped `{ shape: 1, command: 1, secret: 1 }`. Screening first and applying the kept report with `screened` gives the same entry. |
| `secret-shaped items are dropped and never echoed` | A private key header, a GitHub token shape, and an egress proxy password shape, each built as `tests/member-entry.test.ts` builds them, in a statement, a question, a derived criterion, an `outOfScope` id, and the summary: `screenIntentReport` and `applyIntentReport` each drop or withhold every one as `secret`; `JSON.stringify` of the kept report and of the result holds none of them; screening the kept report again drops nothing. |
| `acceptance 2: a derived criterion must quote the statement` | A goal's first check adds a quoting criterion as `c<n>` with `origin: "derived"` and `derivedFrom`; a non-quoting one is dropped `quote`; on a standalone run, and on a second check with an unchanged statement, criteria are ignored and counted; with 7 active criteria the second of two is dropped `cap`. |
| `criteria are due on the first check and after a statement change` | Due on a new record; not due after an applied entry with `statementDigest`; due again after a steering direction and after an answer direction. |
| `a ninth open question closes the oldest that does not wait` | 8 open questions with `q2` the oldest that does not wait: `q2` becomes `default-kept` and is listed in `closed`. With all 8 waiting, the new question is dropped `cap` and its assumption kept. |
| `a new check releases earlier waits` | `q1` waits on an old decision; the next apply sets it not waiting, lists it in `released`, and keeps its prior state in `before`. |
| `answers: defaults keep, text directs, a delegate releases` | Defaults: the waiting questions `default-kept`, statuses unchanged. Text: `answered`, and direction `ans1` with source `correction`. Release: not waiting. After each, no question waits or names the decision. Each is one version up with one entry. An 8,000-character answer is logged by reference. `intentDecision` returns the same decision before and after a JSON round trip. |
| `intent writes keep room for steering` | At 380 log entries, apply, answer, and release throw `objective-log-full`, and a skip returns undefined; 20 steering entries of 8,000 characters, synced with `syncDirections`, still parse. With 19 directions a text answer appends `ans<n>`; with 20 it appends none and logs `directionsFull: true`; after either, 20 more steering entries sync and parse. |
| `every version rebuilds after random intent writes` | Seeded (200 seeds, the seed printed on failure): random applies of valid and invalid items, answers, releases, skips, steering, and owner corrections (`applyOwnerOps`), with a JSON round trip between steps as a restart. For each version, `rebuildVersion(final, v)` deep-equals the snapshot taken after the last write at `v`, and every snapshot parses. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-intent.test.ts tests/objective-record.test.ts tests/objective-ops.test.ts` and the host typecheck.

### Task 3: the rebuild

**Files:** `packages/host/src/objective-record.ts`, `tests/objective-record.test.ts`. Runs first, in parallel with Tasks 1 and 11.

**Interfaces (produces):**
```ts
export const INTENT_OPS = { applied: "intent-check.applied", answered: "intent-check.answered",
  released: "intent-check.released", skipped: "intent-check.skipped" } as const;
export function rebuildVersion(record: ObjectiveRecord, version: number): ObjectiveRecord;   // signature unchanged
```

**Decisions:**

- **The rebuild tracks criteria, directions, assumptions, and questions,** and undoes entries in reverse `seq`, with the entry shapes of Task 2:
  - `intent-check.applied`: the current objects with the added ids, in record order, must hash to `addedDigest`, else 409 `objective-version-unavailable`. They are removed, and each question in `before.questions` gets back its `state`, `waits`, and `decisionId`.
  - `intent-check.answered`: the questions in `before` are restored with their waits and `decisionId`, and the direction that `after` names (inline `direction.id`, or the id in the reference `record:direction:<id>`; none for an inline `after` without `direction`) is removed. A missing direction, or one that is not a `correction`, is 409 (R8).
  - `intent-check.released`: the questions in `before` are restored.
  - `intent-check.skipped`: nothing.
  - Step 2's criterion ops and step 1's direction ops are undone as today; any other op stays 409.
- The rebuilt record is parsed with `objectiveRecordSchema`, as step 2 does; a failure is the same 409.

- [ ] **Step 1: Write the failing test** `a rebuild undoes the intent check`: a hand-built record. Version 1 is created; 2 is an applied entry adding `a1`, a waiting `q1`, and a derived `c1`; 3 a steered direction; 4 a text answer (`q1` answered, `ans1`); 5 an applied entry adding `a2` and a waiting `q2`, then a skip at 5; 6 a release of `q2` (`cancelled`). Versions 1 to 5 rebuild equal to hand-built snapshots. An `addedDigest` one byte off, and a `before` that names a missing question, answer 409. The existing `a rebuild refuses what it cannot undo` still passes unchanged. **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-record.test.ts tests/objective-ops.test.ts tests/objective-goals.test.ts tests/objective-runs.test.ts` and the host typecheck.

### Task 4: evaluators, readiness, and the start pins

**Files:** `packages/host/src/evaluator-profiles.ts` (create), `tests/evaluator-profiles.test.ts` (create). Needs Task 1. Runs in parallel with Tasks 5 and 6.

**Interfaces (produces):** pure.
```ts
/** The lineup's `evaluators`; without the slot, the reviewer when its tier is "strong", then each strong escalation, first id wins, at most 4. Never written back. */
export function evaluatorProfiles(lineup: TeamLineup): TeamModelProfile[];
export type NotReady = "no-lineup" | "no-eligible-evaluator";
export type AutonomyReadiness = { ready: true } | { ready: false; reason: NotReady };
/** C14, from the lineup alone: ready when an evaluator's family is known and differs from the coordinator's. */
export function autonomyReady(lineup: TeamLineup | undefined): AutonomyReadiness;
/** The mode a new run or goal pins: an autonomous project whose lineup is not ready starts supervised, with the reason. Never used for a goal cycle. */
export function startMode(project: { autonomy?: unknown } | undefined, lineup: TeamLineup | undefined): { mode: AutonomyMode; reason?: NotReady };
/** The fixed event text a C14 pin writes on the run or the goal. */
export function autonomyStartEvent(kind: "run" | "goal", reason: NotReady): string;
/** The pin a new run records (part 4): "on" when pinned autonomous unless the setting is "off", or pinned supervised with the setting "on"; always "off" for a mission subteam or a handoff run. */
export function intentCheckPin(input: { autonomy: AutonomyMode; setting?: "on" | "off"; mission: boolean; handoff: boolean }): "on" | "off";
export type CheckerChoice = { profile: TeamModelProfile } | { skipped: "no-eligible-profile" };
/** The first evaluator whose family is known and differs from the coordinator's and the plan author's, on a provider not in `limited`. */
export function chooseIntentChecker(lineup: TeamLineup | undefined, planAuthor: TeamModelProfile | undefined, limited: ReadonlySet<Provider>): CheckerChoice;
```

**Decisions:**

- Families come from `familyOf` (`permission-families.ts` line 51). An unknown family is never eligible, and an unknown coordinator family makes none eligible: C19 fails closed.
- The plan author is the project manager member's own `modelProfile`, which a limit fallback may have moved to another provider.
- A run without a lineup (a legacy run) gives `skipped`.
- The derived list is never written into a config or a lineup, so the authority digest and lineup fingerprints stay as they are.
- Readiness reads the lineup alone, as part 4 says, so it is known before the first cycle. Limits and the plan's author matter only when a checker is chosen, and then a miss skips the check; it never changes a pin.
- The event texts: "This run starts supervised: no lineup profile of a model family other than the coordinator's can evaluate it." and, for `no-lineup`, "This run starts supervised: it has no lineup, so no evaluator of another model family can check it." The goal's texts start "This goal starts supervised:". They carry no member text.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `evaluators are listed, else derived` | The slot is returned as listed. Without it: `[reviewer, strong escalations]`, a reviewer also listed as an escalation once, a reviewer without tier `strong` and light escalations left out, at most 4. The lineup object is unchanged. |
| `the checker differs in family from the coordinator and the plan's author` | `mixedLineup` (Claude coordinator, reviewer without a tier): `skipped`. With `evaluators` of a strong Claude and a strong Codex profile: the Codex one. A plan author on Codex: `skipped`. An evaluator whose family is unknown: `skipped`. Codex limited: `skipped`. |
| `the documented lineup is ready and derives Astra` | The lineup of `docs/teams.md` (section "Add `lineup`"), copied into the test: `evaluatorProfiles` gives `astra-high`, `opus-xhigh`, `astra-xhigh`; `autonomyReady` is ready; `chooseIntentChecker` with the coordinator as the plan's author gives `astra-high`; with `codex` limited, `skipped`. |
| `readiness and the start mode fail closed` | No lineup: not ready, `no-lineup`. `mixedLineup`, and a lineup whose coordinator's family is unknown: not ready, `no-eligible-evaluator`. `startMode` gives `supervised` with the reason for an autonomous project in each case, `autonomous` with no reason for a ready lineup, and `supervised` with no reason for a supervised project. |
| `the pin follows the mode and the setting` | `intentCheckPin` over both modes, the setting absent, `"on"`, and `"off"`, and a mission subteam or handoff run: `"on"` exactly for autonomous without `"off"` and for supervised with `"on"`, never for a mission subteam or handoff run. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/evaluator-profiles.test.ts` and the host typecheck.

### Task 5: the checker's prompt and context

**Files:** `packages/host/src/intent-prompt.ts` (create), `packages/host/src/team-prompts.ts`, `packages/host/src/evidence/host-entries.ts`, `packages/host/src/linear.ts`, `packages/host/src/eval-rules.ts` (one line each, in place), `tests/intent-prompt.test.ts` (create), `tests/team-prompts.test.ts`, `tests/linear-tracking.test.ts`. Needs Task 1. Runs in parallel with Tasks 4 and 6. Task 7 adds the corrected plan's feedback to `intent-prompt.ts` later (R6).

**Interfaces (produces):**
```ts
// team-prompts.ts: `export` added in place to profileInstructions (line 11), codexSandboxInstructions (12),
//   readOnlyWorkspaceInstructions (15), contextAccessInstructions (230), and reportingInstructions (268).
// Line 90, in place: the lead line ends "c0 is the owner's success text", then, when any digest criterion has `derived`,
//   "; a criterion marked derived came from the intent check and the owner has not confirmed it", then ":".
// R2, each in place, `decision.question` → `decisionAuthorityQuestion(decision)` (Task 1):
//   team-prompts.ts line 468 (ownerDirectionLines: `Owner answered "${decisionAuthorityQuestion(item)}": ${item.answer}`),
//   line 108 (teamContext's ownerAnswers), line 349 (the agent direction lines, a delegate's answer), and line 107
//   (teamContext's agentAnswers, mapped to { ...item, question: decisionAuthorityQuestion(item) });
//   evidence/host-entries.ts line 120 (the direction entry's body);
//   linear.ts line 236 (the question comment); eval-rules.ts line 24 (the capsule's ownerAnswers).

// intent-prompt.ts
export const INTENT_PROMPT_BYTES = 8 * 1024;
export const INTENT_CONTEXT_BYTES = 1024 * 1024;
/** Fixed text; the profile line only when a profile is given. */
export function intentCheckerPrompt(provider: Provider, profile?: TeamModelProfile): string;
export type IntentContext = {
  kind: "intent-check"; runId: string; revision: number; goal: boolean; mode: "autonomous" | "supervised"; criteriaDue: boolean;
  record: Omit<ObjectiveRecord, "log" | "criteria" | "assumptions"> & { criteria: Omit<Criterion, "latest">[]; assumptions: Omit<Assumption, "proposals">[] };
  plan: { memberId: string; summary: string; brief?: TeamBrief; tasks: Omit<TeamTaskPlan, "agentProfileId">[]; verification?: TeamVerification };
  findings: { scoutId: string; title: string; report: TeamReport }[];   // this revision's scout reports, as claims
  checks: TeamCommand[];
  limits: { items: 16; scouts: 3; assumptionsLeft: number; criteriaLeft: number };
};
/** Undefined when the JSON is over INTENT_CONTEXT_BYTES. */
export function intentContext(input: { run: TeamRun; record: ObjectiveRecord; planMember: TeamMember; mode: "autonomous" | "supervised";
  criteriaDue: boolean; checks: readonly TeamCommand[] }): IntentContext | undefined;
```

**Decisions:**

- **The prompt** is fixed text (wording is left to the builder, as the spec says) with these parts: the role (a read-only intent checker that compares a held plan with the objective record and lists what the request leaves unspecified); where its input is (`contextAccessInstructions()`); the report's shape and limits in prose, from `INTENT_REPORT_LIMITS`; when to use each disposition (ask only what only the owner knows; a scout question is recorded as an assumption in this version); derived criteria only when the context says `criteriaDue` and `goal`; never propose tasks, edit files, post entries, or ask for permissions; then `readOnlyWorkspaceInstructions`, `codexSandboxInstructions` for Codex, `profileInstructions(profile)`, and `reportingInstructions(provider)`. It takes no run, so no run data can reach it. The profile line and reporting paragraph keep `retargetPrompt` and `refreshReportingInstructions` working for it.
- **The context** holds the parts listed under "Trust boundary". It reads only `run.discovery` (this revision's scouts and their `findings` reports), the record, the held plan member's report, and the configured checks. It never reads `run.members` beyond the plan member and the scouts, `run.routing`, `run.blackboard`, usage, or the evidence store.
- **Authority surfaces** (R2) print `decisionAuthorityQuestion(decision)` wherever they print a decision's question today: `ownerDirectionLines` (line 468), which `ownerAuthorityHash` (`teams.ts` line 200), the permission follow-ups (`teams.ts` lines 4454 and 4457), and every member prompt's owner section read; the context's `ownerAnswers` (line 108); for a delegate's answer, the agent direction lines of every member prompt (line 349) and the context's `agentAnswers` (line 107); the blackboard's direction entry (`evidence/host-entries.ts` line 120); the Linear question comment (`linear.ts` line 236); and the eval capsule (`eval-rules.ts` line 24). A decision without `intentQuestions` prints as today, so no pinned prompt, authority hash, or entry changes. Views and CLI lines keep the question text: that is where the owner reads it to answer.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the checker's prompt holds no run data` (intent-prompt) | For `claude`, `codex`, and `opencode` with a profile: at most 8 KiB; holds the context path, the profile line, and the reporting paragraph; `retargetPrompt` to another provider is not undefined; the Codex prompt alone holds the sandbox guidance. |
| `the checker's context holds the record, the plan, and the findings, and nothing else` (intent-prompt) | From a run whose record has a log, `latest` on `c1`, and proposals on `a1`; a plan with `agentProfileId` and `parallelism`; findings from two scouts; and an implementer's report, a routing pin, and a blackboard flag holding sentinel strings: the context has a record without `log`, `c1` without `latest`, `a1` without `proposals`, tasks without `agentProfileId`, no `parallelism`, and both findings; `JSON.stringify` of it holds no sentinel. A context over 1 MiB gives undefined. |
| `derived criteria are marked in the goal section` (team-prompts) | A digest with one derived criterion prints `"derived":true` on it and the conditional sentence; a digest without one prints today's text byte for byte; `the record digest replaces the success text and nothing else` still passes unchanged. |
| `an intent decision's question reaches no authority surface` (team-prompts) | A run with an owner-answered decision and a connector-answered one, each with `intentQuestions` `["q1", "q2"]` and a question that holds a sentinel: `ownerDirectionLines` (the input of `ownerAuthorityHash` and `permissionFollowUpPrompt`), every role's `teamPrompt`, `teamContext(…)`'s `ownerAnswers` and `agentAnswers`, the `hostEntry` of the owner's answer, and `buildCapsule` hold `q1, q2` and the answers and no sentinel. A decision without the field renders as today, byte for byte. |
| `an intent decision's Linear comments hold no checker text` (linear-tracking) | On this file's Linear fixture, with a run built as the one at line 390: the question comment holds `q1, q2` and no sentinel; the answer comment holds the owner's answer. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/intent-prompt.test.ts tests/team-prompts.test.ts tests/config-identity.test.ts tests/host-entries.test.ts tests/eval-rules.test.ts`, `tests/linear-tracking.test.ts` in the background on the host, and the host typecheck.

### Task 6: the register in the digest and the CLI

**Files:** `packages/host/src/objective-digest.ts`, `packages/host/src/objective-cli.ts`, `tests/objective-digest.test.ts`, `tests/objective-cli.test.ts`. Needs Task 1. Runs in parallel with Tasks 4 and 5.

**Interfaces (produces):** signatures unchanged.
```ts
// recordDigestFor: a criterion with origin "derived" gets derived: true after producer; owner criteria are unchanged.
// objectiveRecordLines: after "Criteria:", "Assumptions:" (or "Assumptions: none") with "  a1 assumed plan intent-check: statement",
//   then "Open questions:" (or "Open questions: none") with "  q1 open waits: text" or "  q1 open: text". Every line through `clean`.
```

**Decisions:** a record without derived criteria gives today's digest byte for byte, so every pinned digest and prompt version holds. The CLI prints member text from the record as it prints criteria today, after `clean` removes control characters.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the digest marks derived criteria and nothing else` (objective-digest) | A record with an owner `c1` and a derived `c2` gives `derived: true` on `c2` only; the result parses with `recordDigestSchema`; a record with owner criteria only gives the same JSON as on the base commit. |
| `the record lines show the register` (objective-cli) | A view with `a1` (assumed), `a2` (unchecked), and `q1` (open, waiting) prints both lists in record order; a statement holding a newline prints a space; a record with neither prints `Assumptions: none` and `Open questions: none`. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-digest.test.ts tests/objective-cli.test.ts tests/team-prompts.test.ts` and the host typecheck.

### Task 7: the check's state machine

**Files:** `packages/host/src/team-intent.ts` (create), `packages/host/src/intent-prompt.ts` (the feedback, moved from Task 5), `tests/team-intent.test.ts` (create), `tests/intent-prompt.test.ts`. Needs Tasks 2, 4, 5, and 8. Runs alone, after Task 8.

**Interfaces (produces):**
```ts
export type IntentCheckState = {
  revision: number; planMemberId: string;
  status: "queued" | "checking" | "waiting" | "correcting" | "accepting" | "done" | "skipped";
  failures: 0 | 1 | 2; checkerMemberId?: string; decisionId?: string; correctedMemberId?: string; reason?: IntentSkipReason;
  screened?: Partial<Record<IntentScreenDrop, number>>;   // the current checker's screen counts, by assignment
};
/** The part of teams.ts' Stored that the check reads and writes. */
export type IntentHolder = { run: TeamRun; intentCheck?: IntentCheckState; objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable };
/** Closures over TeamService's private methods, built in one field initializer in teams.ts (Task 9). */
export type IntentHost = {
  prepare(holder: IntentHolder, role: "project-manager" | "intent-checker", feedback: string | undefined,
    onPrepared: (member: TeamMember) => void, prebuilt?: { prompt: string; profile: TeamModelProfile }): void;
  consume(holder: IntentHolder, member: TeamMember): void;
  /** teams.ts' operation(holder, "result", perform, complete, member). */
  operation(holder: IntentHolder, perform: (signal: AbortSignal) => Promise<boolean>, complete: (clean: boolean) => void, member: TeamMember): void;
  save(holder: IntentHolder): void;
  event(holder: IntentHolder, text: string): void;
  block(holder: IntentHolder, error: unknown, member?: TeamMember): void;
  project(run: TeamRun): Project | undefined;
  limited(): Set<Provider>;
  prefix(): TeamCommand | undefined;
};
export type { GoalRecordPort } from "./objective-intent.js";
export const INTENT_EVENTS: { held: string; accepted: string; waiting: string; answered: string; correcting: string; replaced: string;
  answerUnrecorded: string; releaseUnrecorded: string; skipped: Record<IntentSkipReason, string>; released: Record<IntentReleaseCause, string> };
/** The run's pin (Task 13): true only for "on". A run created before this slice has no pin and never checks. */
export function intentCheckDue(run: TeamRun): boolean;
export class TeamIntent {
  goals?: GoalRecordPort;
  constructor(host: IntentHost);
  /** In the plan's result callback, before tasks are set: true holds the plan. */
  hold(holder: IntentHolder, member: TeamMember): boolean;
  /** In the tick, where a new project manager would start: true when the check owns the run's next step. */
  step(holder: IntentHolder): boolean;
  /** The report stored for an intent-checker member (teams.ts line 4895): an intent-check report screened against the record
   *  and the configured checks, its counts kept on the state when the member is the current checker; any other kind becomes a
   *  `blocked` report of fixed host text that names only the kind it replaced (R2). */
  screen(holder: IntentHolder, member: TeamMember, report: TeamReport): TeamReport;
  /** Every report of an intent-checker member. */
  consume(holder: IntentHolder, member: TeamMember): void;
  /** A member that stopped without a usable report: true for an intent checker (handled), false for every other role. */
  failed(holder: IntentHolder, member: TeamMember): boolean;
  /** The checker's context at launch, or null after the check was skipped and the member stopped. */
  context(holder: IntentHolder, member: TeamMember): IntentContext | null;
  /** The record stops waiting on this run's decision. Never throws (R3). */
  release(holder: IntentHolder, cause: "cancelled" | "replanned"): void;
  answerNote(holder: IntentHolder, decision: TeamDecision): string | undefined;
}

// intent-prompt.ts (moved from Task 5, because it reads Task 2's applied entry):
export const INTENT_FEEDBACK_BYTES = 16 * 1024;
/** The applied entry's items with their statuses, then the answer with decisionAnswerLabel. At most INTENT_FEEDBACK_BYTES. */
export function correctionFeedback(record: ObjectiveRecord, applied: LogEntry, decision: TeamDecision | undefined): string;
```

**Decisions:**

- **The record**: a standalone run's is `holder.objectiveRecord`, read with `readStoredRecord` and written by assignment and `host.save`; a goal run's goes through `goals.read(run.goal.id)` and `goals.write(…)`. A goal run without a port (a test without `GoalService`) is `record-unavailable`. `GoalService`'s constructor registers the port (`server.ts` constructs it at line 306, and `teams.start()` runs at line 2227), so no tick runs before it.
- **The states.** `hold` and `step` never start work while an operation is pending: `step` sits after the tick's `stored.pending` return (line 3378), and `hold` only records state.

| State | On | Next | What the host does |
|---|---|---|---|
| none, or an older revision | `hold` with a plan that passed today's checks | `queued` | Releases an older revision's waits (`replanned`). When `intentCheckDue` is false, returns false and writes nothing. A standalone run's record is built by `planRunObjective`, and its note goes to the events. An unreadable record, a full log, or no eligible profile: `skipped` with its reason, logged when the log has room, one event, and `hold` returns false, so the plan is accepted in the same callback. Otherwise event `held`; true. |
| `queued`, `checking`, `waiting` | `hold` with another plan of the revision | same | `planMemberId` moves to the newer plan; true. |
| `accepting`, `correcting` | `hold` | `done`, or `skipped` when `reason` is set | False: the plan is accepted with no second check. |
| `done`, `skipped` | `hold` | same | False. |
| `queued` | `step` | `checking` | Chooses the profile (Task 4) with `host.limited()` and the plan member's profile, and prepares the checker with `intentCheckerPrompt`; `onPrepared` sets `checkerMemberId`. No eligible profile: a late skip. |
| `checking` | `step` while the member with `checkerMemberId` exists, whatever its status | same | True: nothing starts, so no project manager starts while the checker runs, has reported, or waits for its operation (R1). |
| `checking` | `step` finds no member with `checkerMemberId` | `queued` | The prepare never completed (a restart, or a failed operation); no failure is counted; true. |
| `checking` | `consume` of the checker's `intent-check` report | `waiting` or `accepting` | `host.operation` runs `assertMemberReadOnly` on the checker's workspace and resolves false on `read-only-role-changed-files`, which is a failure. Then, if `intentApplied` finds the entry, the state follows it; else Task 2 applies with a new decision id. When a question waits and the run has 40 decisions, `block` with today's `team-decision-limit` and nothing written. Else the record is written, the decision pushed (`memberId` the checker, `revision`, `question`, `options`, `intentQuestions`, `createdAt`), `run.status` set to `needs-input`, event `waiting`. With nothing waiting: event `accepted`, `accepting`. `objective-log-full`: a late skip (`log-full`); any other failure to write: a late skip (`record-unavailable`). |
| `checking` | a report of any kind but `intent-check` (`question`, `blocked`, `plan`, `result`, …), or `failed` (no report, stall, limit) | `queued` or `accepting` | `failures` + 1; at 2, a late skip (`checker-failed`), else event `replaced`. Such a report never reaches `host.consume` or `hold`, so it opens no decision and starts no plan (R1). A report or failure of any checker other than the current revision's `checkerMemberId` is ignored. |
| `waiting` | `step`, no answer | `waiting` | `run.status` is `needs-input` (saved only when it changes); true. |
| `waiting` | `step`, answered | `correcting` | `answeredBy: "owner"` (owner and controller devices): `answerIntentQuestions` (undefined: already recorded, R9). `"connector"` or `"coordinator"`: `releaseIntentQuestions` (`delegated-answer`). A failed write gives event `answerUnrecorded` (an owner's answer) or `releaseUnrecorded` (a delegate's), and the run goes on. Then as `correcting`. |
| `correcting` | `step` | `correcting` | Without `correctedMemberId`: prepares a project manager with `correctionFeedback`, `onPrepared` sets `correctedMemberId`, event `correcting`, true. With it: false (today's flow). |
| `accepting` | `step` | same | Consumes the held plan's member again; true. Its result callback calls `hold`, which ends the check. A held member without a plan report: `skipped`, and false (today's flow starts a project manager, whose plan is then accepted unchecked). |
| `done`, `skipped` | `step` | same | False. |
| any, older revision | `step` | none | Releases its waits (`replanned`) and drops the state; false. |
| `waiting` | `release("cancelled")` | same | Releases its waits (`cancelled`). |

- **A skip.** Inside `hold`, a skip sets `skipped` at once, and the plan is accepted in the same callback. After `hold` returned true, a late skip sets `accepting` with `reason`, writes `intent-check.skipped` when the log has room, and emits the skip's event; the next `step` consumes the held plan again, and its `hold` ends in `skipped`. `skipped` and `done` are final for the revision, so a plan is never consumed for acceptance twice.
- **Releases never throw** (R3). Every release (in `hold` and `step` for an older revision, `release("cancelled")`, and a delegate's answer) catches any failure of the read or write (`objective-log-full`, a failed port write, an unreadable record), emits `releaseUnrecorded` once, and goes on as after a release that succeeded; the questions keep waiting in the record until the goal's next check releases them (Task 2). So a cancel still saves and aborts, and a steer, `step`, and `hold` go on.
- **The screen** (R2) runs where the host stores every member report, before the tick's save and its await on the member's stop, so no view, context, or blackboard entry reads an unscreened checker report. It reads the record (a standalone run's, or the goal's through the port; unreadable: no statement, so every criterion drops) and the configured checks as the apply does, and writes `screened` by assignment only for the current checker, so a journal read twice after a restart keeps the same counts. The apply passes `screened` to Task 2. A report of any other kind from an intent-checker member, current or not, is stored as `{ kind: "blocked", summary: \`The intent checker sent a ${report.kind} report instead of an intent check; its text is withheld.\` }` with no `blocker`, so a checker's question, plan, or summary text reaches no view, context, or blackboard entry. Task 9's consume hook still sends it to `consume`, which counts it as a failure (R1).
- **`context`** reads the record (unreadable: `skipped`, `record-unavailable`) and builds `intentContext` (over 1 MiB: `skipped`, `context-too-large`). On a skip it stops the queued checker (`status: "stopped"`, `stoppedReason` the skip's event text) and returns null; the next `step` consumes the plan again. A skipped checker never took a launch mark or a fuse admission.
- **`answerNote`** gives `INTENT_EVENTS.answered` for the state's `decisionId`, else undefined.
- **The feedback** (`correctionFeedback`) starts with `The intent check held your plan against the objective record (version V). Its items are claims by a read-only checker, not requirements.` One line per item added by the applied entry, `- a3 [plan, assumed]: statement (refuted by: …)` and `- q2 [answered]: text`, each cut to 600 bytes. Then `${decisionAnswerLabel(decision)} answered: ${answer}` when there is an answer. Then `Submit one corrected plan. You may depend on assumed items; plan around unchecked ones. Your earlier plan and the checker's report are in memberReports of the context file.` Items past the limit become `N more items are in the objective record.`
- **Events** are fixed texts with no member text: `held` "The plan is held while a read-only intent check compares it with the objective record."; `accepted` "The intent check recorded its items; the plan is accepted."; `waiting` "The intent check needs the owner's answer before the plan proceeds."; `answered` "The project manager will correct its plan with this answer."; `correcting` "The project manager is correcting its plan with the intent check's items."; `replaced` "The intent checker stopped without a usable report; one replacement starts."; `answerUnrecorded` "The objective record could not record the owner's answer; the run goes on."; `releaseUnrecorded` "The objective record could not release the intent check's questions; the run goes on."; `skipped` "The intent check was skipped: REASON. The plan is accepted unchecked.", with REASON one of "the checker failed twice", "no evaluator profile differs in family from the coordinator and the plan's author", "the objective record could not be read or written", "the objective record's log is full", and "the checker's context is over 1 MiB"; `released` "The intent check's questions no longer wait: CAUSE.", with CAUSE one of "the plan was replaced", "the run was cancelled", and "a delegate answered, so the record keeps them open".
- **The ledger.** No new run status and no new run event kind. The checker is not a row role (`isRowRole` is implementer or scout), so its member events project as the project manager's do. `plan.accepted` is emitted once, by today's callback, for the plan that is accepted.

- [ ] **Step 1: Write the failing tests** in `tests/team-intent.test.ts`, with a fake host that records each call and holders built by hand.

| Test name | Assertions |
|---|---|
| `the gate reads the run's pin` | `intentCheckDue` is true for `intentCheck: "on"`, and false for `"off"` and for a run without the field, whatever the project's settings and mode say. `hold` with the gate false returns false and calls nothing. |
| `a plan is held once per revision` | `hold` gives true, `queued`, and one `held` event; a second `hold` of the same member gives true and no event; after `accepting`, `hold` gives false and `done`; a new revision gives a new `queued` state and releases the old waits. |
| `a report applies once` | The same checker's report consumed twice, the second after a JSON round trip of the holder, gives one applied entry, one decision, and the same state. |
| `the checker cannot block, ask, or post` | A checker `question` or `blocked` report counts a failure, opens no decision, and never calls `block`; a report from a checker of another revision or another member changes nothing. |
| `failures are bounded` | No report, then a stall: `skipped` (`checker-failed`), one `intent-check.skipped` entry, and the held plan consumed again. After a limit on Codex, the replacement's profile is not on Codex. A changed file counts as a failure. |
| `waiting meets answers` | The owner's defaults: questions `default-kept`, `correcting`, one project manager prepared with feedback that holds the answer's label. Text: `answered` and a direction. A connector: released, statuses unchanged. The corrected plan's `hold` gives false and `done`. |
| `a skip never loses the plan` | No eligible profile, an unreadable record, a full log, and a context over 1 MiB: each `skipped` with its reason and its event; the plan accepted (`hold` false, or the plan consumed again); no checker launched; a queued checker stopped. |
| `the decision cap blocks before anything is written` | With 40 decisions and a waiting item: `block` with `team-decision-limit`, and the record's version unchanged. |
| `a checker plan report counts a failure and starts no project manager` | A `plan` report from the current checker, then a `result` report from its replacement: `failures` 1 then a late skip (`checker-failed`); `host.consume` and `hold` never see either report; no `prepare` of a project manager; the held plan is consumed once, after the skip. |
| `a second pass in checking with the checker present starts nothing` | `step` twice in `checking` with the checker `running`, then twice with it `reported` and an operation pending: true each time, and no `prepare` call. |
| `a release that fails stops nothing` | With a record whose log is at its share, and with a port whose write throws: `release("cancelled")`, `hold` of a new revision, and `step` of an older revision each throw nothing, emit `releaseUnrecorded` once, and leave the state as a successful release does. |
| `the stored report is screened` | `screen` of an `intent-check` report with a secret-shaped statement, a bad test, an unconfigured command, and a non-quoting criterion returns it without them and sets `screened`; the applied entry's `dropped` counts all four; a `question` report and a `plan` report, each holding a secret-shaped string, come back as `blocked` reports whose summary is the fixed text naming their kind, from the current checker and from an older one; screening a member that is not the current checker sets nothing. |
| `the corrected plan's feedback is bounded and labelled` (intent-prompt) | 16 items with 500-byte statements and an 8,000-character answer give at most 16 KiB, starting with the lead sentence and holding the answer's label. |
| `seeded event orders keep the invariants` | Seeded (200 seeds, the seed printed on failure): random orders of hold, step, a checker report (valid, waiting, invalid, or of another kind), a failure, a failed release, an answer (owner, connector), a revision change, a cancel, and a JSON round trip of the holder as a restart. After each event: at most one decision and two checkers per revision; the plan consumed for acceptance at most once per revision and never while a question of the current revision's decision waits; every waiting question in the record names the state's current `decisionId` or a decision whose release the test made fail (R3 leaves those waiting until the goal's next check). |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/team-intent.test.ts tests/intent-prompt.test.ts` and the host typecheck.

### Task 8: the role

**Files:** `packages/host/src/team-types.ts` (line 538), `packages/host/src/teams.ts` (line 330, the `roleAcceptsReport` line that holds `delivery:`, in place: net 0, stays 5,696), `packages/host/src/fuse/baseline.ts` (line 13), `packages/host/src/manager.ts` (lines 614 and 752, in place: net 0, stays 1,243), `packages/host/src/worker.ts` (lines 1128 and 1385, in place: net 0, stays 1,900), `packages/host/src/github-grants.ts` (line 157, in place), `packages/host/src/config-identity.ts` (+1), `tests/fuse-baseline.test.ts`, `tests/github-grants.test.ts`, `tests/config-identity.test.ts`. Needs Tasks 1, 5, and 13 (`teams.ts` has one writer at a time). Runs alone, before Task 7, whose code names the role (R6). These are one-line edits that must land together: the new role breaks the build until every exhaustive list knows it.

**Interfaces (produces):**
```ts
// team-types.ts line 538
export type TeamRole = "permission-coordinator" | "project-manager" | "scout" | "implementer" | "integrator" | "reviewer" | "delivery" | "intent-checker";
// teams.ts line 330, in place: delivery: [...], "intent-checker": ["intent-check"],
// fuse/baseline.ts line 13: LAUNCH_ROLES gains "intent-checker" before "mission-coordinator".
// manager.ts lines 614 and 752, worker.ts lines 1128 and 1385, in place: each role array gains "intent-checker".
// github-grants.ts line 157, in place: || context.role === "intent-checker"  (returns undefined: no grant)
// config-identity.ts, in renderedPrompts (line 134), after `const command = reportCommand();` (line 135), which it uses:
//   if (role === "intent-checker") return [intentCheckerPrompt(provider, profile).split(command).join("<report-command>")];
```

**Decisions:**

- `roleAcceptsReport` maps the role to `["intent-check"]`; `question` and `blocked` pass for every role, as today. The checker's reports never reach the wrong-kind block (lines 5254 and 5255): Task 9's consume hook sends them all to Task 7, which counts every kind but `intent-check` as a failure (R1).
- The role is not in `EXEMPT_ROLES` (`fuse/rules.ts` line 18), so the fuse counts every checker launch (C13) and a refused launch waits.
- `ENTRY_ROLES` (`entry-roles.ts` line 4) stays as it is, so `entryToolsFor` gives the checker no entry tools.
- `teamPrompt` is never called for the checker: it launches with a prebuilt prompt of at most 8 KiB, under `newMember`'s 80 KiB rebuild threshold.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the intent checker is a counted launch role` (fuse-baseline) | A baseline with a launch of role `intent-checker` writes and reads back; `EXEMPT_ROLES` does not hold it. |
| `the intent checker gets no GitHub grant` (github-grants) | `sessionGithubScope({ kind: "team", role: "intent-checker", repository })` is undefined; a scout's scope still holds `fetch`. |
| `the intent checker's prompt version is its own` (config-identity) | `promptVersion("intent-checker", provider, profile, false)` is stable across calls, differs from the reviewer's, and its render holds `<report-command>`. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/fuse-baseline.test.ts tests/github-grants.test.ts tests/config-identity.test.ts tests/team-prompts.test.ts` and the host typecheck. Also, once and not as a test: print `promptVersion` for every role and provider with the default arguments on the base commit and on the task's head, and put both lists in the task report. They must be equal for every role but the new one. Confirm with `wc -l` that `teams.ts`, `manager.ts`, and `worker.ts` did not grow.

### Task 9: the hooks in `teams.ts`

**Files:** `packages/host/src/teams.ts` (+11: from 5,696 after Tasks 15 and 13, to 5,707), `tests/fixtures/team-agent.mjs`, `tests/intent-check.test.ts` (create). Needs Task 7 (which follows Task 8).

**Interfaces (produces):**
```ts
// teams.ts, by line on the INF-280 branch (find each by its code after the edits of Tasks 15, 13, and 8; apply bottom-up):
// after 55:    import { TeamIntent, type GoalRecordPort, type IntentCheckState } from "./team-intent.js";            +1
// 188, in place:   objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable; intentCheck?: IntentCheckState;
// after 519:   private readonly intentChecks = new TeamIntent({ prepare: (s, r, f, o, p) => this.prepareMember(s as Stored, r, undefined, f, o, p),
//                consume: (s, m) => this.consume(s as Stored, m), operation: (s, p, c, m) => this.operation(s as Stored, "result", p, c, m),
//                save: …, event: …, block: …, project: run => this.config.projects.find(…), limited: () => this.limits.limited(),
//                prefix: () => this.config.teams?.commandPrefix });   // one line                                   +1
// after 736:   useGoalRecords(port: GoalRecordPort) { this.intentChecks.goals = port; }                            +1
// 2039, in place:  const next = this.intentChecks.answerNote(stored, decision) ?? (held ? "…" : "…");
// after 2337, stopRun's last statement (the abort): if (action === "cancel") this.intentChecks.release(stored, "cancelled");   +1
// after 3467:  if (this.intentChecks.failed(stored, member)) return;                                                +1
// after 3549, the block's first line: if (this.intentChecks.step(stored)) return;                                   +1
// 4895, in place:  member.report = member.role === "intent-checker" ? this.intentChecks.screen(stored, member, envelope.report) : envelope.report; …as today…
// after 4933 and after 4980: if (this.intentChecks.failed(stored, member)) return;                                  +2
// 5023, in place:  prepareMember(…, onPrepared?: (member: TeamMember) => void, prebuilt?: { prompt: string; profile: TeamModelProfile })
// 5028, in place:  const member = this.newMember(run, role, "", run.headCommit!, task?.id, prebuilt?.prompt,
//                    prebuilt?.profile ?? (start && autoPinned(run) ? this.router!.applyStart(start) : undefined));   // the router's argument kept
// 5037, in place:  role === "project-manager" || role === "intent-checker" ? "planning" : …
// 5046, in place:  role === "permission-coordinator" || role === "intent-checker" ? undefined : …
// before 5166: const intentContext = member.role === "intent-checker" ? this.intentChecks.context(stored, member) : undefined; if (intentContext === null) return;   +1
// 5167, in place:  const digest = intentContext ? undefined : this.options?.entries?.memberDigest(stored.run, member, launchSeq);
// 5168, in place:  writeTeamContext(member.cwd, { ...(intentContext ?? teamContext(…as today…)), …as today… }, …)
// after 5241:  if (member.role === "intent-checker") { this.intentChecks.consume(stored, member); return; }           +1
// before 5343, the first statement of the plan's result callback: if (this.intentChecks.hold(stored, member)) return;   +1
```

**Decisions:**

- **Where each hook sits.** `hold` runs after today's checks and the project manager's read-only check, before `applyProjectManagerCapacity`, so a held plan changes no capacity, task, brief, or verification. `step` is the first line inside the block that starts a project manager when the revision has no tasks (line 3549). The tick has already returned for active or waiting non-implementer members (lines 3545 and 3546), and for paused, cancelled, and blocked runs (line 3362), so a running checker or corrected project manager holds the run, a paused run is never moved to `needs-input`, and `step` never runs once the plan's tasks are set; a checker that has reported but not been consumed holds it through `step` (R1). The failure hooks run after `memberStopped`, so the ledger sees the stop as today, and before any block or same-copy replacement. The consume hook runs before `blocked` and `question` handling and before the wrong-kind block (lines 5254 and 5255), so no checker report of any kind reaches the run's own paths. The screen is line 4895, where every report is stored, before the tick's save (line 3499) and its await on the member's stop (line 3501) (R2). The cancel's release is `stopRun`'s last statement, after the abort, and never throws, so the cancel saves and aborts as today (R3).
- **The answered-decision loop** (lines 3514 to 3531) skips the checker's decision, because the checker is `stopped`, not `waiting`. The check resolves the answer in `step` instead.
- **The fake agent** gains a branch for role `intent-checker`. It copies its context file and its launch prompt to `${memberId}.intent-context.json` and `${memberId}.intent-prompt.txt` in the receipt directory, and writes its receipt as other roles do. With the flag file `intent-hold` it waits for `${runId}.intent-release`, as other roles wait for their release files; with `intent-silent` it exits without a report; with `intent-plan` it sends the first project manager's plan as its report; with `intent-edit` it changes a tracked file, then reports. Otherwise it reports the receipt directory's `intent-report.json`, or `{ kind: "intent-check", summary: "No gap found.", items: [] }`. A corrected project manager (its context's `feedback` starts with the intent check's lead sentence) waits for `${runId}.correct-release` while `intent-hold` exists, then sends the same plan as the first.

- [ ] **Step 1: Write the failing tests** in `tests/intent-check.test.ts`: a host with the fake agent, `{ ...mixedLineup, evaluators: [<a strong Codex profile>] }`, and the configured project set to `autonomy: "autonomous"` as `tests/routing-run.test.ts` sets it, unless a row says otherwise.

| Test name | Assertions |
|---|---|
| `the check follows the run's pin` | A supervised project without the key, and an autonomous one with `intentCheck: "off"`: no `intent-checker` member, no `intent-check.*` log entry, and the plan accepted once. A run whose sealed record loses `intentCheck` before a restart, as a run created before this slice: no checker after the restart. A supervised project with `intentCheck: "on"` and `mixedLineup` without `evaluators`: `intent-check.skipped` (`no-eligible-profile`) and the plan accepted. |
| `a check with nothing to ask accepts the plan once` | The checker reports two assume items: no decision; the run's tasks are the first project manager's; one `plan.accepted` event; the record one version up with one `intent-check.applied`. |
| `acceptance 3: an outcome ask waits for the owner and the corrected plan is not checked again` | The checker reports one outcome ask with an owner test and `interrupt`, and one scout. The run is `needs-input` with one decision whose `memberId` is the checker and whose text holds the item's dimension. The record has `a1` `unchecked` with `q1` waiting, and `a2` `assumed`. The owner's text answer starts one corrected project manager whose context `feedback` holds the answer. Its plan is accepted; the revision has exactly one checker; the record holds `intent-check.applied` and `intent-check.answered`. |
| `the check survives a restart in every state` | For each of `queued` (no checker yet), `checking` (the checker held by a flag), `waiting`, `correcting` (the corrected project manager held), and `accepting` (before the held plan's operation): the host stops and starts again from disk, then the flags are released. One checker per revision, at most one decision, one `plan.accepted`, and the same final tasks as without the restart. |
| `steering, resume, and cancel meet the pending plan` | A steer while the checker runs: a new revision, the old report ignored, one check in the new revision. A steer while waiting: the question no longer waits (`intent-check.released`, `replanned`), and answering the old decision gives 404 `decision-not-found`. A pause and a resume while waiting: a new revision, the waits released (`replanned`), and one check in the new revision. The owner's halt while waiting, an answer during the halt, then the release: the answer resolves in the same revision. A cancel while waiting: `intent-check.released` with `cancelled`. |
| `a failed checker is replaced once and then skipped` | With `intent-silent`: two checker members, then `intent-check.skipped` (`checker-failed`), the plan accepted, and the skipped event's text. With `intent-plan`: the same, and exactly one project manager in the revision until the plan is accepted (R1). |
| `cancel and steer on a full log complete` | While a run waits, the host stops; the test fills the sealed run record's log to its share (380 entries) and starts the host again. A cancel ends the run `cancelled` with every member stopped and one `releaseUnrecorded` event, as a cancel without the check ends. In a second run, a steer starts the new revision, whose check is skipped (`log-full`) and whose plan is accepted (R3). |
| `the checker is read-only and owns nothing` | The copied context has no `agentProfileId`, no `log`, no `entries` key, and no implementer report. The copied prompt holds no objective text, plan text, or steering text. The checker member has no `entryTools`. With `intent-edit`, the edit counts as a failure. A checker item with a secret-shaped statement appears in no view, in no later member's `memberReports` (the corrected project manager's copied context), and in no `hostEntry` of the run's `hostEntrySources` (R2). The same holds for a checker `question` report with a secret-shaped question: the host stores the fixed `blocked` text in its place. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/intent-check.test.ts tests/objective-runs.test.ts tests/team-events.test.ts` on the host, in the background, and the host typecheck. Confirm with `wc -l` that `teams.ts` is 5,707 lines. Task 9 is the last task that writes `teams.ts`.

### Task 10: goal records

**Files:** `packages/host/src/objective-goals.ts`, `packages/host/src/goals.ts` (+1: from 1,033 after Task 13, to 1,034), `tests/objective-goals.test.ts`. Needs Task 9. Runs in parallel with Task 12.

**Interfaces (produces):**
```ts
// objective-goals.ts
/** Reads a goal's record from GoalService's memory. A write checks the held version, sets the held object's record in place,
 *  and saves it; a failed save restores the record and rethrows. */
export function goalRecordPort(holderOf: (goalId: string) => GoalHolder | undefined, save: (holder: GoalHolder) => void): GoalRecordPort;
// goals.ts (Task 13 already moved lines 71 to 80 and 679 out):
//   after the constructor's load loop (which starts at line 111 on the base): teams.useGoalRecords(goalRecordPort(id => this.records.get(id), holder => this.save(holder as Stored)));  (+1)
//   the import on line 19 (objective-goals.js) changes in place.
```

**Decisions:**

- **In place, not a copy.** A goal tick that holds the same object across an `await` saves the check's write with its own. `GoalService` replaces a record object only in synchronous code (`correctObjective`, creation, and load: the three `this.records.set` calls), so no copy taken before a port write can overwrite it later. *(Found while planning: `correctObjective` saves a copy and swaps it in, which is safe only because it never awaits.)*
- The port writes no goal event; the run's events say what happened, and the goal's record route shows the result.
- The running cycle keeps its pinned digest (step 2). Derived criteria reach the next cycle's digest.

- [ ] **Step 1: Write the failing tests** in `tests/objective-goals.test.ts`.

| Test name | Assertions |
|---|---|
| `a goal cycle's check writes the goal's record` | On this file's scheduler fixture (`tests/fixtures/team-scheduler.ts`), a goal on a project with `autonomy: "autonomous"` and `objective: { prompts: "on" }`, and a lineup whose `evaluators` holds a strong Codex profile, so the goal and its cycles pin `autonomous` and each cycle pins the check. The test injects, through `f.report`, the project manager's plan with a brief, then the checker's report: one assume item and one criterion that quotes the success text. The goal's record is version 2 with `a1`, a derived `c1`, and one `intent-check.applied`; the running cycle's `goal.record` is unchanged; the next cycle's digest lists `c1` with `derived: true`; reopened from disk, the same. |
| `a failed goal record write changes nothing` | With `f.blockRecordWrites("goal", id)`: the check is skipped (`record-unavailable`), the plan accepted, and the goal's record still version 1 in memory and on disk. After the restore, the next cycle's check writes. |
| `lists, single reads, and an idle tick parse no record and read no sealed file` (extended) | With a cycle waiting on the intent check's question, an idle tick parses no record and reads no sealed file. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-goals.test.ts tests/standing-goals.test.ts` and the host typecheck. Confirm with `wc -l` that `goals.ts` is 1,034 lines, within its baseline of 1,042.

### Task 11: clients

**Files:** `apps/web/src/teams.tsx`, `apps/mobile/src/features/teams/model.ts`, `packages/host/src/team-watch.ts`, `tests/team-watch.test.ts`. Runs first, in parallel with Tasks 1 and 3.

**Decisions:**

- Web: `TeamRole` (line 14) gains `"intent-checker"`, and `roles` (line 55) gains `"intent-checker": { name: "Intent checker", description: "Compares the plan with the objective record before work starts." }`. Without it, `roles[member.role].name` (lines 300, 303, and 488) throws on the checker's member and on its decision.
- Phone: `TeamRole` (line 10) gains it, and `ROLE_NAMES` (line 109) gains `"intent-checker": "Intent checker"`, in place.
- `team-watch.ts` line 93: `roleRank` gains `"intent-checker"` after `"project-manager"`.
- The Mac app decodes a role as a string, and the Swarm view's `ROLES` skips an unknown role: no change.

- [ ] **Step 1: Write the failing test** `the intent checker sorts after the project manager` in `tests/team-watch.test.ts`: `orderedTeamMembers` of a team with a scout, a checker, and a project manager gives the project manager, the checker, then the scout. **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/team-watch.test.ts`, `npm run typecheck -w @infinite/web`, `npm run lint -w @infinite/mobile`, and `npx tsc --noEmit` in `apps/mobile`.

### Task 12: the docs and the spec

**Files:** `docs/teams.md`, the spec. Runs last, in parallel with Task 10; the contract is fixed in this plan.

**Decisions:**

- **`docs/teams.md`**, the goal record section: when the check runs (the pin taken at `createRun`, the default by mode, the off switch, and the release note: autonomous projects get the intent check on new runs after this deploy); C14 (readiness, the `supervised` start pins and their events, the standing-goal refusal, `autonomyReady` in the enrollment view and `repo init`, and that a pin already taken never moves); the documented lineup's new explicit `evaluators` entry (`astra-high`), as continuous-autonomy part 2 asks; the `evaluators` slot, its derived default, and the family rule; what the checker reads and reports; how the owner answers (one decision; "Use the stated defaults"; free text becomes a direction while the record holds fewer than 20); that owner sections, permission reviews, the blackboard, and Linear name an intent decision by its question ids; what the record gains (assumptions, open questions, derived criteria) and the four log ops; the skip reasons; both keys inside the routine approval digest; and the steps before a rollback, from this section's rollback row.
- **The spec**: part 4, the pin taken at `createRun` and never added to an earlier run, the held plan as the kept report (no `run.pendingPlan`), the plan author's family excluded beside the coordinator's, scout items converted until C16, the decision without `interrupt` and with one option, the read-only check of the checker's workspace, failures counted over no report, stall, limit, any report kind but `intent-check`, and changed files, the checker's report stored screened, an intent decision's authority form, an explicit `"off"` in autonomous mode, and `objective.prompts` optional; continuous-autonomy part 2, C14 at two of its three seams, a run without a lineup not ready, and a derived reviewer that must be strong; part 2, the owner register ops and `POST /api/teams/:id/record` moved to their own slice, and a standalone run's record built when its plan is held while the check is on; part 8, the digest's `derived` marker, and assumptions, open questions, and the autonomous sentence moved to step 4; the delivery order to match; "Left to the builder", the answer on how the pending plan survives a restart and meets steer and resume.

- [ ] **Step 1: Amend the docs and the spec.** **Step 2: Run** the privacy scan of `AGENTS.md` over the diff.
- [ ] **Step 3: After every task, Tasks 13 to 15 below included, the coordinator runs `npm run check` once on the integrated branch, requests the independent review, and commits.**

Tasks 13 to 15 came with the coordinator's correction of 2026-11-16. "Order and owners" places them: Task 15 in the first wave, Tasks 13 and 14 in the third.

### Task 13: the start pins

**Files:** `packages/host/src/teams.ts` (+3: from 5,693 after Task 15, to 5,696), `packages/host/src/goals.ts` (−9: from 1,042 to 1,033), `packages/host/src/goal-standing.ts` (+11), `tests/autonomy-pins.test.ts`, and the lineups of `tests/standing-goals.test.ts`, `tests/routing-run.test.ts`, and `tests/routing-auto-run.test.ts`. Needs Tasks 4 and 15. Runs in parallel with Tasks 2 and 14.

**Interfaces (produces):**
```ts
// teams.ts, by line on the INF-280 branch (Task 15 removed 254–309 and added 2 lines after 55; apply bottom-up):
// after 55:        import { autonomyStartEvent, intentCheckPin, startMode } from "./evaluator-profiles.js";                 +1
// 1630, in place:  // A goal run takes the mode its cycle passes; every other run takes the project's mode, or supervised when C14 fails.
// 1631, in place:  const start = startMode(project, lineup); run.autonomy = goal ? autonomyOf(internal) : start.mode;
// after 1633:      run.intentCheck = intentCheckPin({ autonomy: run.autonomy, setting: project.team.objective?.intentCheck,
//                    mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) });   // one line              +1
// after 1651 (`this.records.set(run.id, stored); this.event(stored, "Team created; …")`):
//                  if (!goal && start.reason) this.event(stored, autonomyStartEvent("run", start.reason));                     +1
// goals.ts (INF-280 does not touch it; same lines as on main):
// after 5:         import { autonomyStartEvent, startMode } from "./evaluator-profiles.js";                                    +1
// 17, in place:    the goal-standing.js import gains retryableCreationFailure.
// 71–80 removed:   the comment, retryableCreation, and errorCode move to goal-standing.ts as one export (R5).                   −10
// 263, in place:   const start = startMode(project, this.config.teams?.lineup); if (request.standing && start.mode !== "autonomous")
// 264, in place:   throw new TeamError(409, "standing-requires-autonomy", start.reason ? "A standing goal needs an evaluator: no lineup
//                    profile of a model family other than the coordinator's can evaluate it. Add one to the lineup's evaluators, or start
//                    a finite goal." : <today's text>);
// 276, in place:   … autonomy: start.mode, …
// after 279:       if (start.reason) this.event(stored, autonomyStartEvent("goal", start.reason));                            +1
// 679 removed, 680 in place: `if (this.closed || !stored.goal.standing || !retryableCreationFailure(error) || this.runCreated(…)) throw error;`   −1
// goal-standing.ts: export function retryableCreationFailure(error: unknown): boolean;   // goals.ts lines 71 to 80, moved
```

**Decisions:**

- **Two of C14's three seams.** `createRun` applies `startMode` to every run that is not a goal cycle (standalone, mission subteam, handoff), with the run's own lineup; `GoalService.create` applies it with the host lineup it pins on the goal. A goal cycle's run keeps `autonomyOf(internal)`. `GoalService.step` (line 875) keeps copying `autonomyOf(goal)`, and standing-goal resume (lines 328 and 407) and the cycle boundary's mode rule (line 892) keep reading the project's mode only. A resume and a restart keep the run's pin. So C14 never moves a pin already taken, and a standing goal pinned `autonomous` never runs under supervised ceilings.
- **The intent check pin comes after C14**, from the run's final mode, so a run that C14 started `supervised` checks only with `intentCheck: "on"`.
- **The size ratchet** (R5). The `goals.ts` extraction runs here, in the same commit as the two goal lines, so `goals.ts` goes from its baseline of 1,042 to 1,033 and never passes it between tasks; `retryableCreationFailure` keeps the moved behaviour byte for byte.
- **Outside the request fingerprint.** Both pins are host-derived, as `autonomy` is (line 1555 leaves it out of the fingerprint), so a launch prepared before this slice still replays, and a replayed request returns the stored run with the pins it was created with.
- **Test lineups.** A test that needs an autonomous run on a lineup with no eligible evaluator now gets `supervised`. `tests/standing-goals.test.ts`'s lineup gains `evaluators: [{ id: "evaluator", label: "Evaluator", provider: "codex", model: "gpt-6-astra", effort: "xhigh", tier: "strong" }]`. `tests/routing-run.test.ts`'s `mixedRun` passes `{ ...mixedLineup, evaluators: [<the same profile>] }` to `fixture` and, for `"autonomous"`, adds `intentCheck: "off"` to the project's `objective` (wherever a test sets `objective`, it keeps that key too), so its runs keep their members and rows. `tests/routing-auto-run.test.ts`'s `autoRun` does the same, so its runs still pin `autonomous` and `auto`. `tests/autonomy-pins.test.ts`'s lineup has a strong Codex escalation and is ready, but `teams.create(teamRequest())` is a single-provider run with no lineup, so it now pins `supervised` (`no-lineup`) (R4): line 91 creates `{ ...teamRequest(), useConfiguredLineup: true }`, whose run carries the file's lineup, so line 94 still reads `autonomous`. No other assertion in those files changes.

- [ ] **Step 1: Write the failing tests** in `tests/autonomy-pins.test.ts`, with its scheduler fixture and its stub `TeamService` for goals.

| Test name | Assertions |
|---|---|
| `a lineup without an eligible evaluator starts new runs and goals supervised` | With `projects[0].autonomy = "autonomous"` and a lineup whose coordinator and reviewer are Claude and that has no other strong family: `create()` and `createForMission()` pin `supervised`, and each run's events hold the C14 event once; a single-provider `create()` pins `supervised` with the `no-lineup` text; `GoalService.create` gives `goal.autonomy: "supervised"` with the goal's event; a standing goal is refused with 409 `standing-requires-autonomy` and the evaluator text. With the file's ready lineup, `create()` pins `autonomous` and writes no C14 event. |
| `pins already taken never move` | A run created `autonomous` with the ready lineup keeps `autonomous` after the host lineup loses its evaluator and the run pauses and resumes, and after a reload. A standing goal created `autonomous` with the ready lineup: after the host lineup loses its evaluator and the stub settles cycle 1 as `ready-for-review`, cycle 2's `createForGoal` call and its record carry `autonomous`. |
| `each new run pins the intent check by mode and setting` | `create()` under `autonomous` pins `intentCheck: "on"`, and `"off"` with `objective: { intentCheck: "off" }`; under `supervised`, `"off"`, and `"on"` with `{ intentCheck: "on" }`; `createForMission()` pins `"off"`; `createForGoal(…, "autonomous")` pins `"on"`. The view and the sealed record carry the pin, and replaying a `create()` request returns the run with its original pin. |

- [ ] **Step 2: Run and confirm they fail,** except `pins already taken never move`, which passes before this task, because no pin moves today; it guards the change. **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/autonomy-pins.test.ts tests/standing-goals.test.ts tests/goals.test.ts tests/autonomy-mode.test.ts tests/autonomy-cli.test.ts tests/routing-policy.test.ts tests/routing-recorder.test.ts`, and `tests/routing-run.test.ts` and `tests/routing-auto-run.test.ts` in the background, then the host typecheck. Confirm with `wc -l` that `teams.ts` is 5,696 lines and `goals.ts` 1,033.

### Task 14: readiness in the views

**Files:** `packages/host/src/repo-enrollment.ts` (+3), `packages/host/src/routing-routes.ts` (lines 3 and 62 in place), `packages/host/src/team-cli.ts` (line 847 in place: net 0, stays 1,263), `tests/autonomy-enrollment.test.ts`, `tests/routing-routes.test.ts`. Needs Task 4. Runs in parallel with Tasks 2 and 13.

**Interfaces (produces):**
```ts
// repo-enrollment.ts
export interface RepoEnrollmentView { /* existing fields */; autonomyReady: boolean; autonomyReason?: NotReady }   // +1
// view(), after autonomySource (line 340), from autonomyReady(this.config.teams?.lineup):                            +1
//   autonomyReady: true   or   autonomyReady: false, autonomyReason: <the reason>
// import { autonomyReady, type NotReady } from "./evaluator-profiles.js";                                             +1
// routing-routes.ts line 3, in place:   import { startMode } from "./evaluator-profiles.js";   // autonomyOf has no other use in the file
// routing-routes.ts line 62, in place:  autonomy: startMode(project, config.teams?.lineup).mode,
// team-cli.ts line 847, in place:       the repo init JSON gains autonomyReady and autonomyReason after autonomySource.
```

**Decisions:**

- The view reads the host's configured lineup, which new runs and goals use by default. A run with a lineup of its own (a handoff policy's) is judged at its own pin. The fields are reported for every project; they matter while the mode is `autonomous`.
- A stored receipt keeps the view it recorded, so a replayed enrollment request returns its old view without the fields: display only.
- `infinite autonomy mode --json` prints the whole view, so it shows the fields; the plain line is unchanged.
- The routing status previews what a new run pins (the comment at line 64), so it reads the C14 start mode, as `createRun` does.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the enrollment view says whether autonomy is ready` (autonomy-enrollment) | With a ready lineup configured: `autonomyReady: true` and no reason. With a lineup whose evaluators are all Claude: `false` and `no-eligible-evaluator`. With no lineup: `false` and `no-lineup`. The view's other fields are unchanged. |
| `the routing status previews the start mode` (routing-routes) | With `mixedLineup` and `autonomy: "autonomous"`, `GET /api/routing/projects/rehearsal` deep-equals the status of the same project served with `autonomy: "supervised"`. The two existing cases that serve `autonomous` with `mixedLineup` (lines 165 and 196) would now read `supervised`, which turns routing off (`routing-policy.ts` line 66) (R4); they serve `{ ...mixedLineup, evaluators: [<a strong Codex profile>] }` instead, so their expected counts hold. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/autonomy-enrollment.test.ts tests/routing-routes.test.ts tests/repo-enrollment.test.ts` and the host typecheck. Confirm with `wc -l` that `team-cli.ts` is 1,263 lines.

### Task 15: the change helpers move out of `teams.ts`

**Files:** `packages/host/src/teams.ts` (−54: from 5,747 to 5,693), `packages/host/src/team-changes.ts` (create). Runs first, in parallel with Tasks 1, 3, and 11.

**Interfaces (produces):**
```ts
// team-changes.ts: teams.ts lines 254 to 309 moved unchanged (diffStat, maxRunChangeFiles, maxTaskChangedPaths, changeIndex,
//   changedPathList); diffStat, changeIndex, and changedPathList exported; imports the TeamRun and TeamTask types only.
// teams.ts, after line 55:
//   import { changeIndex, changedPathList, diffStat } from "./team-changes.js";                                       +1
//   export { changeIndex };   // tests/teams.test.ts line 15 imports it from teams.ts                                  +1
// teams.ts lines 254–309: removed                                                                                     −56
```

**Decisions:** the move is byte for byte and changes no behaviour; the two limits are used only inside the moved lines (301 and 308). It runs first, so every later commit stays inside `teams.ts`'s baseline of 5,757 (Task 9 alone would pass it without the move).

- [ ] **Step 1: Move the lines; no new test.** **Step 2: Run** `node --import tsx --test tests/teams.test.ts` in the background, and the host typecheck. Confirm with `wc -l` that `teams.ts` is 5,693 lines and `team-changes.ts` under 100.

## Not in this slice

- **Owner register ops**: `assumption.set` and its pin, per-question answers and dismissals, promotions to definitions, definitions, rules, non-goals, excluded paths, the rubric version, owner values, the CLI forms `set-assumption AID STATUS` and `answer QID TEXT`, per-item controls on the decision, and the option "I will answer each item". They are a slice of their own on the routes of step 2. *(My call: the decision answer carries the main path of acceptance 3, and these ops need their own route rules, rebuild cases, and client forms.)*
- **`POST /api/teams/:id/record`**, corrections of a standalone run. With the owner register ops.
- **Assumptions and open questions in the record digest**, and the autonomous-mode sentence "propose an assumption". Step 4, with receipts and proposals.
- **C16 scout requests.** A scout item is converted to `assume` until C16 lands.
- **C18**: `interrupt: "definition"` on the decision, and open questions and challenges in the daily digest.
- **The daily digest line for a C14 pin** (continuous-autonomy 6.3). The daily digest is not built (C18); the run's or goal's event carries the reason until it is.
- **The coordinator's full record in its context file** (part 8).
- **Log overflow into the evidence store** (`objective_log`, `objective_values`). The share of step 2 lasts about 180 to 350 checks; a goal whose log is full skips the check (`log-full`).
- **Follow-ups in the checker's context** (step 6); `outOfScope` is counted only.
- **Running assumption tests** (command, artifact, citation, owner): step 4.
- **The evaluator role** (step 5). The `evaluators` slot lands here; only the checker reads it.
- **The router avoiding `evaluators` profiles for a cycle's tasks** ("Left to the builder" in the spec).
- **Record screens** on the web, the phone, and the Mac, and the checker in the Swarm view.

# Slice: tests and proposals

This slice covers part 3 of spec `2026-11-13-objective-record-design.md` (status changes, the four test kinds, and proposals), part 8's step-4 items (the register in the record digest, and the autonomous sentence "propose an assumption"), and delivery order 4 with acceptance 5. After it, on a run that the owner opted in, host test receipts set assumption statuses, members propose assumptions through `finding` entries, and the owner records owner results through the owner route and the CLI; step 5 reads all three. It builds on steps 1 to 3 on `main` (the record, owner corrections, the digest, and the intent check) and on the blackboard member tools (C17).

## Coordinator rulings (2026-11-17)

These override the text below where the two differ.

1. **The plan's calls stand.** Accepted as written:
   - the register is off by default and pinned at `createRun`;
   - tests read results the host already has, and run nothing;
   - a member's proposed test never runs;
   - receipts live in the run's sealed file;
   - the owner records results through two owner ops on the owner route;
   - the register digest has its own 6 KiB budget;
   - an entry's citations are its `sources`;
   - no goal gate waits for a pass.
2. **Owner questions.** The build uses these defaults until the owner says otherwise:
   - A refuted outcome assumption does not hold the next cycle before C18; it writes one event.
   - Ratings run from 1 to 5 in halves.
   - The proposal share stays at 300 log entries, 160 KiB, and 24 KiB capped.
   - Member proposals wait for a later slice to adopt them.
3. **Form B1.** The live team launcher is specific to each instance and is not in this repository. The repository carries only the test model of B1, Task 18's two flags in `tests/fixtures/team-agent.mjs`. Until the owner installs a launcher that admits B1, every artifact and citation result is `unknown` (`read-failed`), as this plan says. The launcher edit is prepared at the release and installed only on the owner's word.
4. **Workers.** At most four implementers run at once. The first wave runs in two batches: Tasks 1, 3, 5, and 7, then Tasks 2, 4, 6, and 8. The later waves follow the plan's order, four tasks at a time.
5. **Shared line budgets.** `teams.ts` grows by at most 6 lines on this branch. INF-291 adds at most 27 lines and INF-292 adds 5, so the composed tree stays at or under 5,745 of the 5,747 baseline. `goals.ts` changes only in place.

**Off by default, and pinned when the run is created.** A new key, `project.team.objective.register`, takes `"on"` or `"off"` and has no default. It is inside the routine authority digest, because `digestedProjectTeam` strips only `eval`; writing it therefore blocks active routines until the owner approves them again. `createRun` pins `run.register = "on"` only when the key is `"on"` and the run is neither a mission subteam nor a handoff run. Otherwise the field stays absent, so views and sealed runs keep today's bytes. A run created before this slice never tests, even after a restart. Proposals also need `run.blackboard`, which C17's switch `config.teams.blackboard.tools` sets; that switch is also off by default and inside the digest. *(My call against part 3, which reads as always on: new behaviour stays off until a setting turns it on, and artifact and citation tests need a launcher form that the owner installs first.)*

**A test reads a result the host already has, and its receipt is a host fact, not a verdict.** A command test reads the status that `check()` recorded in `run.checks` at the revision's final check round. That check ran through today's runner, `teamCommand`, in the disposable verification workspace that `prepareVerificationWorkspace` builds at the integrated head. It ran through `teams.commandPrefix`, within `teams.checkMinutes` per command (default 60, at most 240). The test never reads the output. A result counts only when its command's digest is one of the project's configured checks now. The rule is `testOf` in `objective-intent.ts`, which this slice exports and reuses; it writes no second rule. A check that a plan established under `establishChecks`, or a digest no longer configured, is therefore `unknown`. Artifact and citation tests read one blob at a pinned commit through one new read-only launcher form (B1). They keep only counts, a parse result, a form check, or a quote boolean. Each result is an `ObjectiveReceipt` (kind, subject, id, commit, outcome, time, and a detail of enumerations and counts), kept in the run's sealed file (`Stored.register`, outside `run`) and in no view. A receipt changes only an assumption from the intent check or the owner, and only when the outcome differs from its status. On a pinned assumption it only attaches its handle, and `unknown` changes nothing. Criteria get receipts but no state. *(My call: step 5 owns verdicts, the evaluator role, and `provisional-met`. It reads `TeamRegister.receipts(runId)` and the owner entries in the log.)*

**A proposal is a recorded claim; the host never runs its test.** A member proposes through the `assumption` field of a `finding` entry, as part 3 says. The host screens the proposal at ingest. A new proposal becomes an `unchecked` assumption with origin `member`. A stance is attached to its assumption. Nothing else changes: no status, test, or criticality. A member assumption is never a test subject and never enters the record digest. The design names adoption as "the next intent check sorts every `unchecked` assumption", and step 3's intent check does not do that sorting. So in this slice nobody adopts a member assumption, and it stays `unchecked`. *(My call: running a test that a member wrote, against a repository that members wrote, would let member text decide a status.)*

**The owner records owner results through the owner route only.** `POST /api/goals/:id/record` takes two new ops. `assumption.set` sets `verified` or `refuted` on an assumption whose test is `owner`, and pins it. `rating.record` takes a score from 1 to 5 in halves, stamped with the head and number of the goal's latest reviewed cycle. The route is owner only. Controllers and viewers get 403, and the relay refuses the path. Connectors, delegates, the coordinator, the permission agent, and members have no path. Owner values live in the record's log. *(My call: these two ops are a narrow form of part 2's owner register ops, which their own slice widens. Halves keep scores exact in binary floating point.)*

**The register reaches prompts within its own budget.** When objective prompts and the register are both on, a goal cycle's digest (`TeamGoalContext.record`) gains `register`. It holds the assumptions that the intent check or the owner wrote, with their statuses, and the open questions. Its budget is 6 KiB, separate from the criteria's 6 KiB. In a run pinned `autonomous`, a role that posts findings with entry tools reads the propose sentence in place of "Ask for a user decision if a material scope decision is required." The prompt version gains the two register shapes, so routing evidence never mixes them with today's prompts. *(My calls against part 8: 32 assumptions of 500 bytes alone exceed 6 KiB, so a shared budget would drop criteria; and member text never enters a digest that prints as the owner's record.)*

**Where the code and the design disagree.**

- **Receipt storage.** No `GoalCycle.receipts` exists (part 5, the authority table). Receipts live in the run's sealed file, and step 5 copies what it reads into its own verdict storage.
- **Owner values.** The record has no field for them, so ratings live in `rating.recorded` log entries.
- **Adoption.** Step 3's intent check does not sort `unchecked` assumptions, so member assumptions wait unadopted (ruled above).
- **The relay.** It allows `POST /api/goals/:id/outcome` (`remote-access.ts` line 47), so the design's phrase "as it refuses the outcome routes" is wrong. The relay refuses `/api/goals/:id/record` for every method, because its goal pattern (line 47) has no `record` branch; `tests/remote-access.test.ts` line 526 checks POST. Owner results rely on that refusal.
- **The digest budget.** A 6 KiB digest cannot hold the register; it gets its own budget (ruled above).
- **Citation fields.** Part 7 names no field that holds an artifact entry's citations, so this plan uses the entry's `sources` array (Task 4).
- **Blob reads.** `teamCommand` keeps only the last 65,536 characters of output, so it cannot read a blob, and no launcher form reads blob content. Task 5 adds a streamed reader and form B1.
- **Readers' findings.** C16 is not built, so a reader's `findings` result is not a proposal.
- **Refuted outcome assumptions.** C18 is not built, so such a refutation does not hold the next cycle. One run event names it (owner question 1).
- **Outside citations.** No host-held text exists for an outside citation, so an outside citation test is `unknown`. The `citations` and `citation-form` criteria are delivery step 7.
- **The ingest hook.** Blackboard ingest has no hook for proposals, so Task 8 adds one.
- **The brief's wording.** The coordinator's brief speaks of "criterion tests" and "criterion proposals". The design's four test kinds belong to assumptions, and criteria carry checks; members propose assumptions only. Criteria with a command or artifact check get receipts here.

## Trust boundary, and what a review checks

These inputs originate outside the host:

- **Members.** A `finding` entry may carry `assumption` (Task 6). Every member post passes these checks before it is stored:
  - At the entry route: the strict schema, the role's kinds, 20 posts and 64 KiB per attempt, and `findSecret` with the session's own credentials (422 `entry-secret`). The project manager posts no finding, so it cannot propose.
  - At ingest, inside the store's transaction: the binding, the entry id, the role, and 400 member entries per run.
  - At the host's screen (Task 10): the pin, a readable record, `testOf` (shape, and a command must be configured), `findSecret` with `{ token: "", url: "" }` (private key, access token, GitHub grant, and egress proxy password shapes), the target, and the caps.

  Member text (the statement, `refutedBy`, the test, and the entry's summary) lands only in the sealed record. It never reaches a digest, a prompt, an event, a log line, an error body, or a plain column. The finding's body, including `assumption`, is stored on the blackboard as today, sealed in the entry body.
- **Repositories.** The B1 form reads blob content at the reviewed head, or at a full commit id that the record names. A read is at most 1 MiB. The content is decoded and parsed in memory, then reduced to counts and booleans. None of it is stored, logged, printed, or sent.

  The integration checkout is agent-writable. The six `-c` settings, `GIT_NO_REPLACE_OBJECTS=1`, and `GIT_NO_LAZY_FETCH=1` pin its configuration, hooks, object replacement, and lazy fetch. `cat-file blob` runs no filter and no textconv.

  Members write the repository, so they can shape what an artifact test counts. A receipt is a fact about what the commit holds, not proof that the content is true: a test cannot tell fabricated entries from real ones.
- **Git output.** The host reads the exit code and stdout bytes only, and discards stderr. A missing path and a failed read look the same, so both are `unknown`.
- **Provider output.** A command test reads only the status that the host derived from an exit code, never the output. The intent check's tests are model output; step 3 screened them, and Task 9 reads them as stored.
- **The owner.** Owner ops arrive with the owner device key and pass `applyOps`'s secret scan, as today. They carry ids, enumerations, and numbers only.
- **Other device roles.** Controllers and viewers read the record (`GET`) and cannot write owner results (403). Relay devices can neither read nor write `/record`. Through the team view, every device sees `run.register` (an enumeration) and the register digest in `run.goal.record.register`, which holds intent-check and owner text only.

What can reach prompt and context text:

- **The register digest.** It holds the ids, statuses, criticalities, and statements of intent-check and owner assumptions, the open questions' ids and texts, and a count. Every text was screened by `findSecret` when it was written. It reaches the goal section of every member prompt and every context file of a goal cycle with prompts and the register on. The goal section comes early in the prompt, so the digest can fall inside the permission agent's 4,000-character read.
- **The propose sentence.** Fixed text.
- **Nothing else.** No receipt, log entry, proposal, member text, repository text, or credential reaches a prompt or a context file. A session's GitHub grant and egress proxy password cannot reach the record: the route scans with the session's own credentials, and the host screen scans again for their shapes.

## Launcher forms

One new form needs the owner's launcher approval. No other form changes.

1. **New, B1: one blob at a pinned commit.** It runs in the run's integration checkout (`TeamRun.workspace`), after the six `-c` settings of `teamGitArgs`:

   `git cat-file blob COMMIT:PATH`

   - **Arguments.** `COMMIT:PATH` is one argument. COMMIT matches `/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/`. PATH passes `isScopedPath` (`goal-types.ts`), is at most 300 characters, and is not `.`.
   - **Environment.** `teamGitEnvironment` (`GIT_NO_REPLACE_OBJECTS=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_NOSYSTEM=1`) plus `GIT_NO_LAZY_FETCH=1`. The launcher sets `GIT_NO_LAZY_FETCH=1` again after its `env_reset`.
   - **Limits.** The output is read as a stream, at most 1,048,576 bytes; the reader closes stdout at the next byte. The time limit is 30 seconds.
   - **While the launcher refuses it:** every artifact and citation result is `unknown` with `read: "read-failed"`, so neither kind changes a status. Command tests and owner results still work.

**The launcher ends B1 by itself after 35 seconds,** as it ends the capture reads. The host may not signal a command that the launcher runs as another account. Until the launcher has this limit, a hung read counts as stalled. With 4 reads stalled, the host starts no new read until one of them ends.

**Sizes.**

- **A proposal.** One per finding:
  - statement: 1 to 500 bytes;
  - `refutedBy`: 1 to 500 bytes;
  - test: JSON of at most 1,024 bytes;
  - criticality: an enumeration;
  - id: the record's ID rule.

  It adds at most about 2.1 KiB to a finding body, inside the body's 12 KiB. The entry tool's input schema grows by about 1 KiB on runs with entry tools.
- **Proposals in the record.**
  - At most 4 new assumptions per attempt (member), 8 stances per assumption, 16 member assumptions, and 32 assumptions. *(The member share was added at review, so one intent check's 16 items still fit.)*
  - Proposals and stances write only while the record's capped bytes stay at most 24 KiB, and the log stays under 300 entries and 160 KiB.
- **Log entries.**
  - `test.recorded`: at most 8 assumptions each.
  - `rating.recorded`: at most 8 assumptions each.
  - `proposal.recorded`: at most 4 assumptions added and 16 stances attached each.
  - Every value is inline and at most 2 KiB.
- **A pass.**
  - At most 40 subjects and 40 distinct blob reads.
  - Each read is at most 1 MiB and 30 seconds; the whole pass is at most 120 seconds.
  - One pass runs at a time, and at most 4 reads are stalled.
- **Receipts.** At most 40 per pass, each about 250 bytes. Only the latest pass is kept, so `Stored.register` stays under 12 KiB plus a dozen drop counts.
- **The register digest.** At most 6,144 bytes, 32 assumptions, and 8 questions.
- **A citation.**
  - At most 2,000 characters, with a line span under 10,000.
  - At most 32 sources are read per entry.
- **A rating.** The score is 1 to 5 in halves. The subject follows the ID rule.
- **The correction file.** Unchanged: 64 KiB.

**Cost.**

- **Register off.** `save` checks one field, and the tick makes one call that returns at once on an empty queue. A stored entry page costs one field check.
- **Register on.** A settled revision gets one pass:
  - two record parses;
  - at most 40 sequential Git reads outside the serial queue (at most 40 MiB streamed). *(Changed when built: the pass keeps what it read until it applies the receipts, at most 40 MiB, and decodes and parses it in the serial queue at apply.)*
  - one or two sealed writes (the goal and the run, or the run alone).

  A stored page that carries a proposal costs one record parse and at most one write.
- **Scale.** No store statement, index, list route, or view reads anything new. The work grows with settled revisions and proposal pages, not with sessions or rows, so 1,000 sessions and 10,000 outcome rows change nothing.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| No key; `register: "off"`; a mission subteam or handoff run; a run created before this slice, after a restart | No pass, no proposal applied, no register digest, no `run.register`, no `Stored.register`; prompts, context files, events, and views as today | Task 18 `without the register a run is as today`, `each new run pins the register by setting`; Task 3 `the register setting stands alone and pins only plain runs`; Task 12 `without the register the goal section is byte for byte` |
| The key written, then a routine's next check | The routine blocks; without the key it keeps its authority | Task 3 `the register setting is inside the routine approval digest` |
| Acceptance 5 | The contradicting finding attaches to a2, and a2 stays `unchecked`; the artifact test counts 31 qualifying entries, so a2 becomes `refuted` with its receipt handle; nobody is interrupted | Task 10 `acceptance 5, proposal side: a contradicting finding attaches and changes no status`; Task 9 `acceptance 5, test side: an artifact test counts qualifying entries`; Task 18 `acceptance 5 end to end` |
| A command test on an unconfigured digest, a plan-established check, or an interrupted, running, or absent result | `unknown`; no status change; no command run | Task 9 `command tests read the final round and run nothing`; Task 18 `acceptance 5 end to end` (`commands.jsonl`) |
| The launcher refuses B1 | Artifact and citation results `unknown` (`read-failed`); command tests still apply | Task 18 `a refused blob form leaves artifact results unknown` |
| A blob over 1 MiB, a read past 30 seconds, a pass past 120 seconds, or 4 stalled reads | `too-large`, `read-failed`, or `not-run`; never a number; no new read while 4 are stalled | Task 5 `a blob read streams within its limits`; Task 17 `stalled reads stop the pass from reading`; Task 9 `unknown is never a number` |
| A restart after the mark, during the reads, or between a goal record's write and the run's save | One pass and one `test.recorded` version | Task 17 `seeded runs with restarts write each pass once`; Task 18 `a restart while a pass reads runs it once` |
| The same journal page ingested twice; a pass applied twice | Applied once | Task 10 `proposals apply once`; Task 17 `seeded runs with restarts write each pass once` |
| Pages from three members in every order, with the assumption cap reached | The same set of proposals and the same drop counts; only the id numbering differs | Task 10 `the order of members' pages does not change the result` |
| A steer, resume, or continuation (a new revision) while a pass reads | The old pass writes nothing; the new revision's pass runs | Task 17 `a pass never outlives its run or its revision` |
| A run deleted while its pass reads | Nothing is written; the record keeps its earlier handles, which show as expired once their runs are gone | Task 17 `a pass never outlives its run or its revision` |
| An unreadable record, or a goal record write that fails | The pass is skipped (`record-unavailable`, `write-failed`) with one event, and its receipts are kept; proposals are counted under the same reasons | Task 17 `a pass never outlives its run or its revision`, `proposals follow the pin and the record` |
| No evidence store, or one that is unready or held | Proposals wait with the cursor, because the hook runs only on a stored page; tests and owner results work | Task 8 `the proposal hook sees only the posts the store holds`; Task 18 `without the register a run is as today` |
| A log at its share | Receipts are kept and the write is skipped (`log-full`) with one event; proposals stop at their 300-entry share | Task 13 `a full log keeps the receipts and writes nothing`; Task 10 `bad proposals are dropped and counted, never echoed` |
| A secret-shaped proposal or summary | 422 at the route; dropped (`secret`) at the host screen if it gets that far; never in the record, a log entry, an event, or an error | Task 10 `bad proposals are dropped and counted, never echoed` |
| A member assumption that names a test | Stored, never run, never in the digest | Task 9 `a pass plans at most 40 subjects and 40 distinct reads`; Task 3 `the register digest has its own budget and no member text` |
| An owner result from a controller, a viewer, or the relay; with the register off | 403; refused by the relay; 409 `objective-register-off` | Task 15 `owner results take the owner route only`; `tests/remote-access.test.ts` `the relay refuses corrections` |
| A rating before any reviewed cycle | 409 `objective-rating-no-head` | Task 11 `a rating stamps the reviewed head and moves unpinned owner tests`; Task 15 `a rating needs a reviewed cycle` |
| Random register writes, intent applies, and owner ops, with a reload between steps | Every version rebuilds and parses | Task 17 `every version rebuilds after random register writes` |
| A rollback to a host without this slice | See the right column | No test. `docs/teams.md` lists the steps before a rollback (Task 19). The old strict schema refuses a config with `objective.register`, so remove the key first. A pending goal launch whose digest holds `register` fails the old strict `teamGoalContextSchema` and blocks that goal. A record with register entries parses (`OP_RE` accepts the ops), but versions before them answer 409 `objective-version-unavailable`; the latest version still reads. An old host ignores `run.register` and `Stored.register`. It skips journal posts whose finding carries `assumption`, because its strict envelope schema refuses them, so those findings never reach its board; its entry route refuses new ones with 400. |

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/objective-write.ts` (create) | Pure: shared record writes (next id, next seq, log room, sealing several entries at one version) |
| `packages/host/src/objective-intent.ts` (modify) | Uses `objective-write.ts`; exports `testOf` |
| `packages/host/src/objective-holder.ts` (create) | Reading and writing a record in its place: a goal's through the port, a standalone run's on its holder |
| `packages/host/src/team-intent.ts` (modify) | Uses `objective-holder.ts` |
| `packages/host/src/team-types.ts` (modify) | The setting, `TeamRun.register`, and the register digest schema with its budget |
| `packages/host/src/objective-digest.ts` (modify) | The pin, the switch reader, the register digest, and the prompt shape |
| `packages/host/src/objective-citations.ts` (create) | Pure: the citation form, the qualifying-entry count, and the quote match |
| `packages/host/src/git-stream.ts` (create), `eval-git.ts` (modify) | Bounded streamed Git reads (moved from `eval-git.ts`), form B1, and the blob reader |
| `packages/host/src/evidence/member-proposal.ts` (create), `evidence/member-entry.ts`, `intent-report.ts`, `objective-types.ts` (modify) | The `assumption` field of a finding |
| `packages/host/src/objective-record.ts` (modify) | The register op names, their undo, and four error codes |
| `packages/host/src/evidence/blackboard.ts`, `team-entry-ingest.ts` (modify) | Which posts the store holds; the proposal hook |
| `packages/host/src/objective-receipts.ts` (create) | Pure: a pass's subjects and reads, and its receipts |
| `packages/host/src/objective-proposals.ts` (create) | Pure: screening and applying one page of proposals |
| `packages/host/src/objective-input.ts`, `objective-ops.ts` (modify) | The two owner ops |
| `packages/host/src/register-prompt.ts` (create), `team-prompts.ts` (modify) | The register text and the scope sentence |
| `packages/host/src/objective-register.ts` (create) | Pure: applying receipts to the record |
| `packages/host/src/config-identity.ts`, `routing-auto.ts`, `routing-reads.ts`, `routing-routes.ts` (modify) | The prompt version's register shapes |
| `packages/host/src/objective-goals.ts`, `goals.ts` (modify) | The correction gate, the rating stamp, and the goal digest's register |
| `packages/host/src/objective-cli.ts` (modify) | `set-assumption` and `rate` |
| `packages/host/src/team-register.ts` (create) | The runtime: mark, restore, drain, the pass, proposals, the events |
| `packages/host/src/teams.ts` (modify) | Six one-line hooks and six lines changed in place (Task 18) |
| `tests/fixtures/team-agent.mjs` (modify) | Two flags of the fake command prefix |
| `docs/teams.md`, the spec (modify) | The setting, the form, the ops, the rollback steps, and the amendments |
| `tests/{objective-write,register-schemas,objective-citations,git-stream,member-proposal,objective-receipts,objective-proposals,register-prompt,objective-register,register-goals,team-register,register-rebuild,register-host}.test.ts` (create); `tests/{objective-digest,routines,objective-record,blackboard-ingest,team-entry-ingest,objective-ops,config-identity,objective-cli,autonomy-pins}.test.ts` (modify) | Pure rules, the runtime with a fake host, and the host on the scheduler fixture |

**Touch points in `teams.ts` and `goals.ts`.**

- **`teams.ts`.** Only Task 18 writes it, and only the lines it lists (+6: from 5,707 to 5,713, baseline 5,747).
- **`goals.ts`.** Only Task 15 writes it, and only lines 20, 21, 538, 548, 549, and 853, each changed in place (net 0: 1,034, baseline 1,042).
- **Not touched:** `server.ts`, `client.ts`, `team-cli.ts`, `missions.ts`, `tests/teams.test.ts`, and `tests/goals.test.ts`.

**Order and owners.**

- **First wave, in parallel:** Tasks 1, 2, 3, 4, 5, 6, 7, and 8.
- **Second wave, in parallel:** Task 9 (needs 4 and 5), Task 10 (needs 1 and 6), Task 11 (needs 7), and Task 12 (needs 3).
- **Third wave, in parallel:** Task 13 (needs 1 and 9), Task 14 (needs 3 and 12), Task 15 (needs 3 and 11), and Task 16 (needs 11).
- **Then, one at a time:** Task 17 (needs 2, 5, 9, 10, 11, and 13), Task 18 (needs 3, 6, 8, 14, and 17), and Task 19.

**One writer per file.** No file has two writers in this slice. Every name, signature, limit, status code, entry shape, and test name below is fixed, so the workers of one wave never need to talk.

**Line numbers.** Every line number is on the reference tree: `main` `3c4e15b9` with PRs #174, #175, and #176. Each edit quotes the code it changes, so a worker finds it by that code if `main` moves. Within a task, apply edits from the bottom up.

**Checks.**

- `check:size` holds after every task. Each task confirms its counts with `wc -l`. Every new file stays under 1,000 lines; the largest, `team-register.ts`, is expected near 380.
- The host typecheck does not cover `tests/`, so each task runs its test files. A task reports any cancelled test as a failure.

**Workers.**

- Every worker in a worktree is told never to use `git stash`. It compares with `git show HEAD:<path>` and sets work aside with a WIP commit.
- Workers run test batches that start a host in the background, so a steer can reach them.

**Lessons from earlier waves.**

- **No new status, role, or report kind.** `save` writes no new outcome event, and the outcome ledger records nothing new. The fuse and a goal's member budget count no new member: a cycle spends the members it spends today. `REPORT_SAMPLES` and the fake agents need no new entry; the only fixture change is Task 18's two prefix flags.
- **Byte pins.** Tests that pin bytes from the base commit (Tasks 3, 6, and 12) re-pin from `main`'s own output when the build starts, because prompt bytes move whenever `main` changes a prompt.
- **Goal tests.** A test that runs goal cycles with a fake agent (Task 15) sets `objective.intentCheck: "off"` and writes the fake agent's plan-brief flag file.
- **Signals.** No test signals a child that already ended (macOS answers EPERM), runs a real launcher's stop (`kill -1`), or runs a launcher as root. Task 5 injects a `stop` that returns false.

## Review Focus

1. **A status set by anything but a host receipt or an owner direction.** A member proposal, member text, an unread blob, or an `unknown` result that changes a status, or a receipt that moves a pinned assumption. Expect none.
   - Tests: Task 13 `pinned and member assumptions keep their status` and `receipts set statuses only where the outcome differs`; Task 9 `unknown is never a number`; Task 10 `acceptance 5, proposal side: a contradicting finding attaches and changes no status`.
   - Lines whose deletion the tests must catch:
     - in `applyReceipts`, the line that skips an `unknown` outcome and the line that skips origin `member`;
     - in `receiptsFor`, the artifact branch's return of `unknown` when the blob did not read;
     - in `applyProposals`, the new assumption's `status: "unchecked"`; changing it to `"assumed"` must fail.
2. **A command run, or a read past its bounds.** Expect only B1 lines in the prefix log.
   - Tests: Task 9 `command tests read the final round and run nothing`; Task 18 `acceptance 5 end to end`, which checks `commands.jsonl`; Task 5 `a blob read is one bounded form` and `a blob read streams within its limits`.
   - Lines:
     - in `receiptsFor`, the check that the digest is one of the configured checks now;
     - in `readGitStream`, the line that decides `too-large` past `maxBytes`;
     - in `blobArgs`, the `COMMIT_ID` check and the `isScopedPath` check.
3. **Something on by default.** Expect today's bytes without the key.
   - Tests: Task 18 `without the register a run is as today` and `each new run pins the register by setting`; Task 3 `the register setting is inside the routine approval digest` and `the register setting stands alone and pins only plain runs`; Task 12 `without the register the goal section is byte for byte`; Task 14 `the register changes the prompt version only where the prompt changes`.
   - Lines:
     - `registerPin`'s `setting === "on"` check;
     - the `run.register !== "on"` guards in `mark` and `propose`;
     - `goalRecordDigest`'s `if (register)`.
4. **A lost or doubled write.** A proposal applied twice, a pass written twice, or an old pass overwriting a newer one after a restart or a new revision. Expect one write per page and per pass.
   - Tests: Task 10 `proposals apply once`; Task 17 `seeded runs with restarts write each pass once` and `a pass never outlives its run or its revision`; Task 18 `a restart while a pass reads runs it once`.
   - Lines:
     - in `applyProposals`, the entry-id check;
     - in the pass's apply step, the guard that `register.pass` is still this pass object;
     - in `applyReceipts`, the `undefined` return when nothing changes; without it, every pass writes a version.
5. **Member text or a credential where it must not be.** Member text in the digest, a prompt, an event, a log line, or a view; a secret-shaped proposal in the record; receipts in a view. Expect none.
   - Tests: Task 3 `the register digest has its own budget and no member text`; Task 10 `bad proposals are dropped and counted, never echoed`; Task 18 `the view shows the pin and nothing else`.
   - Lines:
     - in `registerDigestFor`, the `origin !== "member"` filter;
     - in `applyProposals`, the `findSecret` call;
     - `Stored.register` kept outside `run`; moving the receipts into `run` must fail the view test.

### Task 1: shared record writes

**Files:** `packages/host/src/objective-write.ts` (create), `packages/host/src/objective-intent.ts`, `tests/objective-write.test.ts` (create). Runs first.

**Interfaces (produces):** pure.
```ts
// objective-write.ts: imports objective-types, objective-record, and objective-ops only.
/** `prefix` and one more than the highest number with that prefix among `existing`; never reused. Moved from objective-intent.ts `nextId`. */
export function nextRecordId(prefix: string, existing: readonly string[]): string;
export function nextSeq(record: ObjectiveRecord): number;
export type LogRoom = { entries: number; bytes: number };
/** Throws objectiveError("objective-log-full") when the log plus `entries` passes `room` (default CORRECTION_LOG: 380 entries, 210 KiB). */
export function assertLogRoom(record: ObjectiveRecord, entries: readonly LogEntry[], room?: LogRoom): void;
/** Seals the record at entries[0].version with every entry appended; every entry carries that version.
 *  Throws objectiveError("objective-op-refused") when objectiveRecordSchema refuses the result. Generalizes objective-intent.ts `finish`. */
export function sealRecord(record: ObjectiveRecord, changes: Partial<ObjectiveRecord>, entries: readonly LogEntry[]): ObjectiveRecord;

// objective-intent.ts: nextId, assertRoom, finish, and nextSeq are removed; their callers use the four functions above
//   (finish(r, c, e) becomes sealRecord(r, c, [e]); assertRoom(r, e) becomes assertLogRoom(r, [e])). testOf becomes exported, unchanged:
export type TestVerdict = { ok: true; value: AssumptionTest } | { ok: false; drop: "shape" | "command" };
export function testOf(test: unknown, configured: readonly TeamCommand[]): TestVerdict;
```

**Decisions:**

- **A move, not a change.** The intent check writes the same bytes; `tests/objective-intent.test.ts` passes unchanged.
- **The single command rule.** `testOf` is the only rule for a command test: it must name a configured check by `commandDigest`. Task 10 calls it, and no task writes another.

- [ ] **Step 1: Write the failing test.**

| Test name | Assertions |
|---|---|
| `record writes seal one version with every entry` | `sealRecord` with three entries at version v + 1 gives version v + 1, three more log entries, and `digest` equal to `recordDigest` of the body. A result that the schema refuses throws `objective-op-refused`. `assertLogRoom` at 380 entries plus one throws `objective-log-full`, and at 300 entries with `{ entries: 300, bytes: 160 * 1024 }` it throws too. `nextRecordId("a", ["a1", "a3", "q9"])` is `a4`. |

- [ ] **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-write.test.ts tests/objective-intent.test.ts tests/objective-record.test.ts` and the host typecheck.

### Task 2: the record holder

**Files:** `packages/host/src/objective-holder.ts` (create), `packages/host/src/team-intent.ts` (lines 503 to 525: the bodies of `stateOfRecord` and `writeRecord` call the new functions). Runs first.

**Interfaces (produces):**
```ts
// objective-holder.ts
export type RecordHolder = { run: TeamRun; objectiveRecord?: unknown };
/** A goal run's record through the port; a standalone run's from its holder. Unreadable, or a goal run without a port, is unavailable. Never throws. */
export function heldRecordState(holder: RecordHolder, goals: GoalRecordPort | undefined): ObjectiveState;
/** A goal run's through the port, which throws objectiveError("objective-version-stale") or rethrows a failed save after restoring;
 *  a standalone run's on the holder. Throws Error when a goal run has no port. */
export function writeHeldRecord(holder: RecordHolder, goals: GoalRecordPort | undefined, previous: ObjectiveRecord, next: ObjectiveRecord): void;
```

**Decisions:** a move. The intent check and the register read and write records the same way, through one pair of functions.

- [ ] **Step 1: No new test.** **Step 2: Move the code.** **Step 3: Run** `node --import tsx --test tests/team-intent.test.ts tests/objective-intent.test.ts tests/objective-goals.test.ts` and the host typecheck. All pass unchanged.

### Task 3: the setting, the pin, and the register digest

**Files:** `packages/host/src/team-types.ts`, `packages/host/src/objective-digest.ts`, `tests/register-schemas.test.ts` (create), `tests/objective-digest.test.ts`, `tests/routines.test.ts`. Runs first.

**Interfaces (produces):**
```ts
// team-types.ts
// teamProjectSchema line 236: objective gains register: z.enum(["on", "off"]).optional()   — no default
// TeamRun gains, after intentCheck (line 688):
//   /** Pinned by createRun when the project's register is on; absent otherwise and on runs created before the register existed. */
//   register?: "on";
export const RECORD_REGISTER_BYTES = 6 * 1024;
export const registerDigestSchema = z.strictObject({
  assumptions: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), status: z.enum(["refuted", "unchecked", "assumed", "verified"]),
    criticality: z.enum(["outcome", "plan", "detail"]), statement: z.string() /* 1 to 500 bytes */ })).max(32),
  questions: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), text: z.string() /* 1 to 1,000 bytes */ })).max(8),
  omitted: z.number().int().min(1).max(40).optional(),
}).superRefine(/* the byte bounds, and registerDigestBytes ≤ RECORD_REGISTER_BYTES */);
export type RegisterDigest = z.infer<typeof registerDigestSchema>;
export function registerDigestBytes(register: RegisterDigest): number;   // Buffer.byteLength(JSON.stringify(register))
// recordDigestSchema gains, as its last key: register: registerDigestSchema.optional()
// recordDigestBytes, in place (line 454): counts the digest without `register`, so a digest without one counts exactly as today.

// objective-digest.ts
export function objectiveRegisterOn(project: Pick<Project, "team"> | undefined): boolean;   // true only for "on"
/** The run pin: true only for setting "on" on a run that is neither a mission subteam nor a handoff run. */
export function registerPin(input: { setting?: "on" | "off"; mission: boolean; handoff: boolean }): boolean;
/** Assumptions of origin intent-check or owner, then open questions, in the fixed order, cut at RECORD_REGISTER_BYTES with the rest counted in `omitted`. */
export function registerDigestFor(record: ObjectiveRecord): RegisterDigest;
export type ObjectivePrompt = boolean | "register" | "register-autonomous";
/** A live run's prompt shape: false without a record digest; true with a digest without a register; else by the run's pinned mode (autonomyOf). */
export function objectivePromptOf(run: Pick<TeamRun, "goal" | "autonomy">): ObjectivePrompt;
/** The shape a new run of `project` would render in `mode`: false with prompts off; true with the register off; else by `mode`. */
export function objectivePromptFor(project: Pick<Project, "team"> | undefined, mode: AutonomyMode): ObjectivePrompt;
```

**Decisions:**

- **No default.** Without the key, every routine digest, prompt, and context is unchanged. Writing the key changes `RoutineService.authority`, because `digestedProjectTeam` strips only `eval`. The key stays inside that digest, as C11 asks of anything that changes what a routine's runs do.
- **The order.** First by status (refuted, unchecked, assumed, verified), then by criticality (outcome, plan, detail), then by id number; then the open questions in record order.
- **The cut.** Each item enters whole or not at all. The first item that would pass 6,144 bytes stops the list, and `omitted` counts every assumption and question left out.
- **Member assumptions.** They never enter, and `omitted` does not count them.
- **Every register assumption counts.** The record has no retired state for assumptions.
- **Two independent switches.** With `objective.prompts` off, nothing reaches prompts. With `objective.register` off, no digest has a register.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the register setting stands alone and pins only plain runs` (register-schemas) | **Parsing.** `{ register: "on" }` and `{ register: "off", intentCheck: "off" }` parse; `{ register: "maybe" }` and an unknown key are refused. **The pin.** `registerPin` is true only for `{ setting: "on", mission: false, handoff: false }`. It is false for an absent setting, `"off"`, a mission subteam, and a handoff run. **The digest.** A digest whose register is over 6,144 bytes is refused. A digest with 6 KiB of criteria and a maximal register within 6,144 bytes parses. `JSON.stringify` of a digest without a register equals the string pinned from the base commit, and so does its `recordDigestBytes`. |
| `the register digest has its own budget and no member text` (objective-digest) | The record has 32 assumptions (origins intent-check, owner, and member, across every status and criticality) and 8 open questions. In `registerDigestFor`'s result: no member-origin id appears; the order rule holds; `registerDigestBytes` is at most 6,144; `omitted` equals the number of non-member assumptions and questions left out. A record with neither gives `{ assumptions: [], questions: [] }` with no `omitted`. |
| `the objective prompt shape follows the digest, the register, and the mode` (objective-digest) | **`objectivePromptOf`.** No goal record gives false. A record without a register gives true. With a register, an unpinned or `supervised` run gives `"register"` and an `autonomous` one `"register-autonomous"`. **`objectivePromptFor`.** Prompts off gives false; prompts on with the register off gives true; both on gives the shape by mode. |
| `the register setting is inside the routine approval digest` (routines) | The pattern of step 2's test. A routine keeps its stored authority across a reload without the key. It blocks at its next check after the project gains `objective: { register: "on" }`. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/register-schemas.test.ts tests/objective-digest.test.ts tests/routines.test.ts tests/intent-schemas.test.ts` and the host typecheck.

### Task 4: citations

**Files:** `packages/host/src/objective-citations.ts` (create), `tests/objective-citations.test.ts` (create). Runs first.

**Interfaces (produces):** pure.
```ts
export const CITATION_LIMITS = { chars: 2_000, lineSpan: 10_000, sourcesPerEntry: 32 } as const;
export type RepositoryCitation = { kind: "repository"; path: string; lines?: { from: number; to: number }; commit?: string };
export type OutsideCitation = { kind: "outside"; host: string };
/** Form only: `path`, `path#Lfrom`, `path#Lfrom-Lto`, each with an optional `@commit`, or an https URL. Undefined for anything else. */
export function parseCitation(text: string): RepositoryCitation | OutsideCitation | undefined;
/** Array elements whose first 32 `sources` strings hold at least `perEntry` form-valid citations; outside citations count once per host. */
export function qualifyingEntries(entries: readonly unknown[], perEntry: number): number;
/** Whether `quote` appears in `text`, or in its lines `from` to `to`, after folding every whitespace run to one space and trimming.
 *  Lines are split on "\n" with a trailing "\r" removed; lines past the end are absent. */
export function quotePresent(text: string, quote: string, lines?: { from: number; to: number }): boolean;
```

**Decisions:**

- **A repository path.** It passes `isScopedPath`, is at most 300 characters, and is not `.`. Lines are written `#L<from>` or `#L<from>-L<to>`, with 1 ≤ from ≤ to and to − from < 10,000. A commit is 40 or 64 lowercase hexadecimal characters.
- **An outside citation.** It is an `https:` URL that `new URL` parses and that has a host; the host is lowercased. `http:` and every other scheme are refused. *(My call: the design names no scheme, and https keeps the form check strict.)*
- **An entry's citations are the strings in its `sources` array.** Only the first 32 elements are read, and a non-string element counts as invalid. *(My call: part 7 names no field that holds an entry's citations.)*
- **The check is form only, as part 7 says.** It reads no blob and no outside text.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `citations parse by form only` | **Repository.** `src/a.ts`, `src/a.ts#L7`, `src/a.ts#L10-L24`, `src/a.ts@<40 hex>`, and `docs/b.md#L1-L2@<64 hex>` parse as repository citations. **Outside.** `https://Example.com/x` parses as outside, with host `example.com`. **Refused:** `../a`, `/abs`, `.`, `.git/config`, `a.ts#L0`, `a.ts#L5-L4`, `a.ts#L1-L10001`, an uppercase commit, `http://example.com/x`, `ftp://example.com/x`, and a 2,001-character string. |
| `qualifying entries count form-valid citations, one per outside host` | **At `perEntry` 2.** `{ sources: ["a.md#L1-L2", "https://a.example/1"] }` qualifies. `{ sources: ["https://a.example/1", "https://a.example/2"] }` does not, because both are on one host. **Never:** a string, null, an object without `sources`, and `{ sources: "a.md" }`. **The 32-source cut.** An entry whose second valid source is its 33rd does not qualify. |
| `a quote is present only in the cited lines after whitespace folding` | In `"a\r\n  b   c\nd"`, the quote `b c` is present in lines 2 to 2 and in the whole text. It is absent in lines 3 to 3 and in lines 4 to 9. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-citations.test.ts` and the host typecheck.

### Task 5: streamed Git reads and form B1

**Files:** `packages/host/src/git-stream.ts` (create), `packages/host/src/eval-git.ts`, `tests/git-stream.test.ts` (create). Runs first. `tests/eval-git.test.ts` is not edited and must pass.

**Interfaces (produces):**
```ts
// git-stream.ts
export type StreamRead = { state: "read"; bytes: Buffer } | { state: "too-large" } | { state: "failed" };
/** Moved from eval-git.ts unchanged. */
export function stopGroup(child: ChildProcess): boolean;
export type GitStreamInput = {
  cwd: string; args: readonly string[]; prefix: TeamCommand | undefined; maxBytes: number; timeoutMs: number; signal: AbortSignal;
  stop: (child: ChildProcess) => boolean; releaseMs: number; env?: Record<string, string>;
  /** Called once, when the answer is decided, before the child closes. */
  decided?: (read: StreamRead) => void;
};
/** eval-git.ts readPatch's body with the arguments, the byte limit, and extra environment as inputs. Spawns with teamGitEnvironment(env).
 *  Settles when the child closes, as readPatch did. */
export function readGitStream(input: GitStreamInput): Promise<StreamRead>;
export const BLOB_MAX_BYTES = 1_048_576, BLOB_READ_MS = 30_000, BLOB_RELEASE_MS = 1_000, BLOB_PATH_CHARS = 300;
/** Form B1 after the six settings: ["cat-file", "blob", `${commit}:${path}`].
 *  Throws TypeError for an id that fails COMMIT_ID, or a path that fails isScopedPath, is ".", or is over 300 characters. */
export function blobArgs(commit: string, path: string): string[];
export type BlobReader = {
  /** Resolves when the answer is decided. A child that the stop could not end counts as stalled until it closes. Never throws. */
  read(cwd: string, commit: string, path: string, signal: AbortSignal): Promise<StreamRead>;
  stalled(): number;
};
/** Reads through `prefix()` with teamGitArgs(cwd, blobArgs(…)) and env { GIT_NO_LAZY_FETCH: "1" }. */
export function blobReader(prefix: () => TeamCommand | undefined,
  options?: { timeoutMs?: number; stop?: (child: ChildProcess) => boolean; releaseMs?: number }): BlobReader;

// eval-git.ts: readPatch keeps its signature, builds teamGitArgs(cwd, patchArgs(from, to)) in its try as today, and returns
//   readGitStream({ cwd, args, prefix, maxBytes: PATCH_MAX_BYTES, timeoutMs, signal, stop, releaseMs }). stopGroup is imported.
```

**Decisions:**

- **The move is byte for byte**, except for three new inputs (`args`, `maxBytes`, `env`) and the `decided` callback. Eval capture keeps its behaviour, including settling at the child's close.
- **The blob reader answers at the decision**, so a pass never waits on a child that the launcher keeps alive. `stalled()` counts those children until they close.
- **Refused arguments start nothing.** A read that `blobArgs` refuses starts no child and resolves `failed`.

- [ ] **Step 1: Write the failing tests.** The test builds its own repository with git and no prefix. No test runs a launcher's stop or runs as root.

| Test name | Assertions |
|---|---|
| `a blob read is one bounded form` | **The form.** `blobArgs` of a 40-hex id and `docs/a.json` is exactly `["cat-file", "blob", "<id>:docs/a.json"]`, and a 64-hex id works. **Refusals.** An uppercase id, a 39-character id, `../a`, `a:b`, `.`, `.git/x`, a 301-character path, and a path with a control character each throw TypeError. A reader given a refused path resolves `failed`, and its fake prefix records nothing. |
| `a blob read streams within its limits` | **Results.** A 10-byte blob reads with its bytes; a 1,048,577-byte blob is `too-large`; a missing path is `failed`. **The fake prefix.** The prefix is a node script that writes its argv and environment to a file, then runs git. The argv is the six settings followed by B1, and the environment holds `GIT_NO_LAZY_FETCH=1`. **A stalled read.** The prefix waits for a release file; `timeoutMs` is 200; the `stop` returns false. The read resolves `failed` after about 200 ms, and `stalled()` is 1. It returns to 0 after the test writes the release file and the child closes. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/git-stream.test.ts tests/eval-git.test.ts tests/eval-capture.test.ts` and the host typecheck.

### Task 6: the proposal field

**Files:** `packages/host/src/evidence/member-proposal.ts` (create), `packages/host/src/evidence/member-entry.ts` (+1), `tests/member-proposal.test.ts` (create). Two one-word changes in place: `export` on `bytes` and `boundedJson` in `packages/host/src/intent-report.ts` (lines 19 and 21), and on `ID_RE` in `packages/host/src/objective-types.ts` (line 66). Runs first.

**Interfaces (produces):**
```ts
// member-proposal.ts: imports zod, ../intent-report.js (bytes, boundedJson), and ../objective-types.js (ID_RE).
//   No cycle: objective-types imports only node:crypto, zod, evidence/crypto, and goal-types, whose team-types import is type only.
export const PROPOSAL_FIELD_LIMITS = { statementBytes: 500, refutedByBytes: 500, testBytes: 1_024 } as const;
export type MemberProposal =
  | { id: string; stance: "supports" | "contradicts" }
  | { propose: { statement: string; refutedBy: string; test: unknown; criticality: "outcome" | "plan" | "detail" } };
/** Strict. `id` uses the record's own ID rule (ID_RE), so the two never drift; `test` is bounded JSON of at most 1,024 bytes. */
export const memberProposalSchema: z.ZodType<MemberProposal>;
// member-entry.ts
// findingBody (lines 49 to 51): after line 50 (`items: …`), add `assumption: memberProposalSchema.optional(),`   +1
// FIELD_NAMES (line 157) gains: "assumption", "propose", "id", "stance", "statement", "refutedBy", "test", "criticality"
```

**Decisions:**

- **Where the field lives.** One proposal per finding, in its body, as part 3 says. Only `finding` has the field, and the project manager posts no finding.
- **Existing limits still apply:** the body's 12 KiB, and the route's 20 posts and 64 KiB per attempt.
- **The tool schema.** The entry tool's input schema (`team-mcp.ts`, built from `memberEntryPostSchema`) gains the optional field on every run with entry tools. No prompt, context file, or prompt version changes, and no test pins the schema's bytes. *(My call: a schema per register pin would need a second switch in `team-mcp.ts` for a field that a member can omit. On a run without the pin, the field is stored with the finding and changes nothing.)*
- **Entry ids.** `memberEntryId` hashes the canonical entry, so an entry without the field keeps its id.

- [ ] **Step 1: Write the failing test.**

| Test name | Assertions |
|---|---|
| `a finding may name one assumption` | **Accepted.** `memberEntryPostSchema` parses a finding with `assumption: { id: "a2", stance: "contradicts" }`, and one with `assumption: { propose: { statement, refutedBy, test: { kind: "artifact", path: "research/entries.json", count: "/entries", threshold: { kind: "count", min: 40 } }, criticality: "plan" } }`. **Refused:** a contract with `assumption`; both `id` and `propose`; a 501-byte statement; a 1,025-byte test; criticality `major`; stance `neutral`; an unknown key. **Refusal path.** For the long statement, `refusalPath` gives `entry.body.assumption.propose.statement`. **Ids.** `memberEntryId` of a finding without the field equals the id pinned from the base commit. **The tool schema.** `z.toJSONSchema(z.object({ entry: memberEntryPostSchema }).strict(), { target: "draft-7", io: "input" })` does not throw and names `assumption`. |

- [ ] **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/member-proposal.test.ts tests/member-entry.test.ts tests/team-entry-route.test.ts tests/intent-schemas.test.ts` and the host typecheck.

### Task 7: the rebuild and the error codes

**Files:** `packages/host/src/objective-record.ts`, `tests/objective-record.test.ts`. Runs first.

**Interfaces (produces):**
```ts
export const REGISTER_OPS = { tested: "test.recorded", proposed: "proposal.recorded", set: "assumption.set", rated: "rating.recorded" } as const;
// ObjectiveErrorCode and OBJECTIVE_ERRORS gain:
//   "objective-register-off":      409 "Turn on the assumption register for this goal's project before recording owner results."
//   "objective-assumption-target": 409 "A correction names an assumption that is missing, has no owner test, or was proposed by a member."
//   "objective-rating-subject":    409 "A rating names a subject that no active criterion or owner test names."
//   "objective-rating-no-head":    409 "The goal has no reviewed cycle to rate yet."
export function rebuildVersion(record: ObjectiveRecord, version: number): ObjectiveRecord;   // signature unchanged
```

**The entry shapes.** Tasks 10, 11, and 13 write these entries, and every value is inline. In each shape, `replaced` is the earlier handle with the same prefix and its index in `evidence`.

- **`test.recorded`.**
  - Actor `host`, authority `receipt`, target the run id, handle `receipt:<runId>:<revision>`.
  - `before`: `{ assumptions: [{ id, status, replaced?: { handle, at } }] }`.
  - `after`: `{ revision, kind, changed: [{ id, status }] }`.
  - At most 8 assumptions per entry, and every entry of a pass shares one version.
  - Each assumption's new handle is `<handle>:<id>`, last in its `evidence`.
- **`proposal.recorded`.**
  - Actor `member`, authority `claim`, target the member id, handle the run id.
  - `after`: `{ revision, added: [id…], addedDigest, attached: [{ id, entryId }…] }`. No `before`.
  - At most 4 added and 16 attached per entry.
  - `addedDigest` is the SHA-256 hex of the canonical JSON of the added assumptions as written.
- **`assumption.set`.**
  - Actor `owner`, authority `direction`, target the assumption id, handle the request id.
  - `before`: `{ status, ownerPinned?, replaced? }`. `after`: `{ status }`.
  - The new handle `owner:<requestId>` is last.
- **`rating.recorded`.**
  - Actor `owner`, authority `direction`, target the subject, handle the request id.
  - `before`: `{ assumptions: [{ id, status, replaced? }] }`.
  - `after`: `{ subject, score, commit, cycle, changed: [{ id, status }] }`.
  - At most 8 assumptions per entry, and at least one entry even when nothing changes.
  - Each changed assumption's new handle is `rating:<requestId>`.

**Decisions:**

- **Undo in reverse `seq` order:**
  - **`test.recorded` and `rating.recorded`.** For each assumption in `before`, the current status must equal the one in `after`, and its last handle must be the entry's (`<handle>:<id>`, or `rating:<handle>`). The undo removes the last handle, puts `replaced` back at its index, and restores the status.
  - **`proposal.recorded`.** The current assumptions named in `added`, in record order, must hash to `addedDigest`; the undo removes them. For each `attached` item, in reverse, its assumption's last proposal must carry that `entryId`; the undo removes it.
  - **`assumption.set`.** The last handle must be `owner:<handle>`. The undo removes it, restores `replaced`, and restores the status and `ownerPinned` (an absent pin stays absent).
- **A mismatch.** Any mismatch is 409 `objective-version-unavailable`, as for every other op. The rebuilt record is parsed as today.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `a rebuild undoes the register` | **The record, hand-built.** Version 1 is created with a1 and a2 (intent-check, `unchecked`), a4 (owner test), and a5 (owner test, rating `quality` below 4). Version 2 is a `test.recorded` that sets a1 `verified` and a2 `refuted`, replacing a1's `receipt:` handle at index 0. Version 3 is a `proposal.recorded` that adds a6 and attaches a stance to a2. Version 4 is an `assumption.set` that pins a4 `verified`. Version 5 is a `rating.recorded` that sets a5 `refuted`. **Rebuilds.** Versions 1 to 4 rebuild equal to hand-built snapshots. **Refusals.** An `addedDigest` one byte off, a stance that is not last, and a last handle that differs each answer 409. **Unchanged tests.** The existing `a rebuild refuses what it cannot undo` and `a rebuild undoes the intent check` pass unchanged. |
| `register refusals have fixed codes and sentences` | `objectiveError` gives each of the four new codes its status and sentence. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-record.test.ts tests/objective-ops.test.ts tests/objective-intent.test.ts` and the host typecheck.

### Task 8: the ingest hook

**Files:** `packages/host/src/evidence/blackboard.ts`, `packages/host/src/team-entry-ingest.ts`, `tests/blackboard-ingest.test.ts`, `tests/team-entry-ingest.test.ts`. Runs first.

**Interfaces (produces):**
```ts
// blackboard.ts
export type IngestOutcome = { result: "stored" | "unready" | "held" | "failed"; stored: number; dropped: number; invalid: number;
  /** Seqs of this call's posts that the store holds afterwards, inserted now or already present. Only on "stored". */
  kept?: ReadonlySet<number> };
// ingest(): the transaction adds record.seq to `kept` wherever it counts a post stored (both branches) and resets it with the counts.
// team-entry-ingest.ts
export type IngestDeps = { /* events, entries, done, members as today */
  /** Once per stored page with kept posts, after the store write and before the cursor moves. A throw is ignored. */
  kept?: (run: TeamRun, member: TeamMember, posts: readonly MemberPostRecord[]) => void };
// ingestPass's deps type: Pick<IngestDeps, "events" | "entries" | "kept">.
```

**Decisions:**

- **What the hook sees.** Only posts that passed `checkedPost` and the run limit. An invalid post, or one over the 400-entry limit, never reaches the record.
- **The cursor rule is unchanged.** The cursor moves only when the store holds the page. A throwing hook does not hold the cursor back, because the finding is already on the board; the host's screen counts what it could not record.
- **Optional on purpose.** `kept` is optional, so tests whose fake `ingest` returns no `kept` keep working.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the store reports which posts it holds` (blackboard-ingest) | The page holds a new post, a post already stored, a post with a wrong binding, and a post past the 400-entry limit. `kept` holds exactly the seqs of the first two. An unready store gives no `kept`. |
| `the proposal hook sees only the posts the store holds` (team-entry-ingest) | The hook is called once, with the kept posts. It is never called for an unready or held store, or for a page without posts. After a hook that throws, the cursor has moved and the next member is read. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/blackboard-ingest.test.ts tests/team-entry-ingest.test.ts tests/team-entries.test.ts` (in the background) and the host typecheck.

### Task 9: receipts

**Files:** `packages/host/src/objective-receipts.ts` (create), `tests/objective-receipts.test.ts` (create). Needs Tasks 4 and 5.

**Interfaces (produces):** pure; no I/O and no clock.
```ts
export const PASS_LIMITS = { subjects: 40, reads: 40 } as const;
export type PassKind = "reviewed" | "check";
export type ReceiptKind = "command" | "artifact" | "citation";
export type ReceiptOutcome = "pass" | "fail" | "unknown";   // criterion: the threshold holds; assumption: it stands (verified) or is refuted
export type ReadState = "read" | "too-large" | "read-failed" | "not-run";
export type ReceiptDetail =
  | { kind: "command"; observed: "passed" | "failed" | "interrupted" | "running" | "absent" | "not-configured"; round?: number }
  | { kind: "artifact"; read: ReadState; problem?: "not-text" | "not-json" | "no-array" | "threshold-misfit" | "schema-deferred" | "empty" | "deadline" | "stalled";
      total?: number; qualifying?: number }
  | { kind: "citation"; read: ReadState; problem?: "outside-unchecked" | "malformed" | "not-text" | "deadline" | "stalled"; present?: boolean };
/** The stored shape of a host test result (step 5 reads it). */
export type ObjectiveReceipt = {
  handle: string;                          // receipt:<runId>:<revision>:<id>
  kind: ReceiptKind; subject: "criterion" | "assumption"; id: string;   // the criterion or assumption id
  commit: string; outcome: ReceiptOutcome; at: string; detail: ReceiptDetail;
};
export type Subject =
  | { subject: "criterion"; id: string; check: Extract<Check, { kind: "command" | "artifact" }>; threshold: Threshold }
  | { subject: "assumption"; id: string; test: Extract<AssumptionTest, { kind: "command" | "artifact" | "citation" }> };
export type BlobResult = StreamRead | { state: "not-run"; why: "deadline" | "stalled" };
/** At most 40 subjects in the fixed order. A check pass plans command subjects only. */
export function passSubjects(record: ObjectiveRecord, kind: PassKind): Subject[];
/** Distinct `${commit}:${path}` keys in subject order, at most 40; none for a check pass. */
export function passReads(subjects: readonly Subject[], head: string): { commit: string; path: string }[];
export type PassInput = { runId: string; revision: number; kind: PassKind; head: string; at: string;
  checks: readonly TeamCheck[]; configured: readonly TeamCommand[]; blobs: ReadonlyMap<string, BlobResult> };
export function receiptsFor(subjects: readonly Subject[], input: PassInput): ObjectiveReceipt[];
```

**Decisions:**

- **Subjects.**
  - In a reviewed pass: active criteria whose check is `command` or `artifact`, in record order. Then assumptions whose origin is `intent-check` or `owner` and whose test is `command`, `artifact`, or `citation`, in record order.
  - In a check pass: only those with a command check or test.
  - At most 40; the rest wait for the next pass. Member assumptions and owner tests are never subjects.
- **Command.**
  - **The final round.** It is the highest `round` (absent counts as 0) among `checks` with the pass's revision. In a reviewed pass, its `headCommit` must also be the reviewed head.
  - **The matching entry.** In that round, the entry with no `phase` whose `commandDigest(command)` equals the test's digest.
  - **Configured now.** The digest must also be one of `configured`, the project's checks now; otherwise the result is `not-configured`.
  - **Results.** `passed` and `failed` decide. `interrupted`, `running`, or no entry are `unknown`.
  - **Outcomes.** A criterion passes on `passed`. An assumption with `refutesOn: "fail"` passes on `passed` and fails on `failed`; with `"pass"`, the reverse.
  - **The commit** is the round's `headCommit`.
- **Artifact.**
  - **Reading.** The blob at the reviewed head and the path is decoded as strict UTF-8 (`TextDecoder` with `fatal: true`) and parsed with `JSON.parse`. The RFC 6901 pointer (with `~1` and `~0` unescaped) must name an array.
  - **The counts.** `total` is the array's length. With `citedPerEntry`, `qualifying` is `qualifyingEntries(array, citedPerEntry)` and is the count compared; otherwise `total` is.
  - **Thresholds.** A `count` threshold holds when the count is at least `min` and at most `max` (each when given). A `share` threshold needs `citedPerEntry` and a `total` above 0, and holds when `qualifying / total` is at least `min`; otherwise it is `unknown` (`empty`). A `pass` or `score` threshold on an assumption is `unknown` (`threshold-misfit`).
  - **A criterion's artifact check.** With `count`, as above with its threshold. Without `count` and `schema`, it passes when the blob reads. With `schema`, it is `unknown` (`schema-deferred`).
- **Citation.**
  - An outside source is `unknown` (`outside-unchecked`), and an unparseable one is `unknown` (`malformed`).
  - A repository source reads its `@commit`, or the reviewed head without one. `present` is `quotePresent(text, quote, lines)`.
  - `refutesOn: "absent"` passes when the quote is present; `"present"` passes when it is absent.
- **Unknown is never a number.** `total` and `qualifying` appear only when computed, and `present` only when the blob read and decoded. Criterion ids (`c<n>`) and assumption ids (`a<n>`) never collide, so handles are unique within a pass.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `command tests read the final round and run nothing` | **The final round.** Rounds 1 and 2 ran at the revision, and round 2's `rank-verify` failed: a4 (`refutesOn: "fail"`) fails, with the round's head and `round: 2`. With `refutesOn: "pass"`, a4 passes. **Ignored and unknown.** A setup entry with the same command is ignored. A digest not configured now gives `not-configured` and `unknown`. Interrupted, running, and absent results are `unknown`. **Criteria.** A criterion with a command check passes on `passed` and fails on `failed`. **Pure.** The module imports no `child_process`. |
| `acceptance 5, test side: an artifact test counts qualifying entries` | a2 is `{ kind: "artifact", path: "research/entries.json", count: "/entries", citedPerEntry: 2, threshold: { kind: "count", min: 40 } }`. Against a blob of 45 entries, 31 of which qualify, it fails with detail `{ kind: "artifact", read: "read", total: 45, qualifying: 31 }`. With `min: 30`, it passes. |
| `unknown is never a number` | Each of these gives `unknown` with no `total`, `qualifying`, or `present` key: too large; failed; not run (deadline, stalled); not UTF-8; not JSON; a pointer to an object; a `share` threshold with total 0; a `pass` threshold on an assumption; a criterion with `schema`. |
| `citation tests follow refutesOn` | Present with `refutesOn: "absent"` passes; absent with `"absent"` fails; present with `"present"` fails. An outside source gives `outside-unchecked`, and a malformed one `malformed`. A source with `@<commit>` reads that commit's key. |
| `a pass plans at most 40 subjects and 40 distinct reads` | **The cap and order.** A record with 50 subjects plans 40, criteria first, in the stated order. **Reads.** Two tests on one path share one read. **Never subjects:** member assumptions and owner tests. **A check pass** plans command subjects only, and no read. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-receipts.test.ts tests/objective-citations.test.ts` and the host typecheck.

### Task 10: applying proposals

**Files:** `packages/host/src/objective-proposals.ts` (create), `tests/objective-proposals.test.ts` (create). Needs Tasks 1 and 6.

**Interfaces (produces):** pure.
```ts
export const PROPOSAL_LIMITS = { log: { entries: 300, bytes: 160 * 1024 }, cappedBytes: 24 * 1024, addedPerEntry: 4, attachedPerEntry: 16 } as const;
export type ProposalDrop = "test" | "command" | "secret" | "target" | "attempt" | "stances" | "assumptions" | "bytes" | "log" | "refused";
export type Proposal = { entryId: string; memberId: string; revision: number; authorRole: string; summary: string; assumption: MemberProposal };
export type ProposalContext = { runId: string; configured: readonly TeamCommand[]; at: string };
export type ProposalsApplied = { record?: ObjectiveRecord; added: string[]; attached: number; dropped: Record<ProposalDrop, number> };
/** One page of one member, in journal order: at most one version up, and `record` absent when nothing changed. Never throws. */
export function applyProposals(record: ObjectiveRecord, proposals: readonly Proposal[], context: ProposalContext): ProposalsApplied;
```

**Decisions:**

- **Each proposal, in order:**
  1. **Repetition.** An `entryId` already in any assumption's `proposals` is skipped and not counted.
  2. **Secrets.** `findSecret({ summary, assumption }, { token: "", url: "" })` drops it as `secret`.
  3. **A stance.** Its assumption must exist (`target`) and hold fewer than 8 proposals (`stances`). It gains `{ entryId, stance, summary, authorRole }` last.
  4. **A new proposal.** `testOf(test, configured)` may drop it as `test` or `command`. The member's additions stay at most 4: every `proposal.recorded` entry that targets the member counts, and so does this page (`attempt`). Assumptions stay at most 32 (`assumptions`), and capped bytes at most 24 KiB (`bytes`).

     It becomes `a<n>` (`nextRecordId`) with `status: "unchecked"`, `origin: "member"`, the screened test, empty `evidence`, and `proposals: [{ entryId, stance: "supports", summary, authorRole }]`.
- **After the page.** The log must stay under 300 entries and 160 KiB with the new entries; otherwise every proposal of the page counts under `log`. A result that the schema refuses counts every proposal under `refused`.
- **Nothing else changes.** No existing status, test, criticality, or question changes, as part 3 says: "A member cannot change a test, a criticality, or a status."
- **Entries.** One version per page, with entries of at most 4 added and 16 attached.
- **The attempt is the member.** A replacement member gets its own 4.
- **Why a share.** Proposals stop at their share, so intent checks, receipts, and owner ops keep at least 80 entries and 50 KiB of `CORRECTION_LOG`. *(My call on the share's size: owner question 2.)*

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `acceptance 5, proposal side: a contradicting finding attaches and changes no status` | a2 is a `plan` assumption, `unchecked`. A scout's finding with `assumption: { id: "a2", stance: "contradicts" }` attaches `{ entryId, stance: "contradicts", summary, authorRole: "scout" }` to a2. a2's status, test, and criticality are unchanged. The record is one version up, with one `proposal.recorded` entry. |
| `a member proposes at most four assumptions per attempt` | Six proposals from one member: four `unchecked` member assumptions and two drops under `attempt`. A second page from the same member adds none. Another member adds its own four. |
| `proposals apply once` | The same page applied again returns no `record` and counts no drop. |
| `bad proposals are dropped and counted, never echoed` | **Drops.** An unconfigured command test drops as `command`, and a test that fails `assumptionTestSchema` as `test`. A private key header, a GitHub token shape, and an egress proxy password shape, each in a statement, a summary, and a test (built as `tests/member-entry.test.ts` builds them), each drop as `secret`, and `JSON.stringify` of the result holds none of them. A stance on a missing id drops as `target`, and a ninth stance as `stances`. The 33rd assumption drops as `assumptions`, capped bytes past 24 KiB as `bytes`, and a log at 300 entries as `log`. **Untouched.** A record that only drops is unchanged. |
| `the order of members' pages does not change the result` | Pages from three members, with the record two assumptions below 32, in all 6 orders. Each order gives the same set of `(entryId, statement, status, origin)`, the same `added` count, and the same drop counts. Only the id numbering differs. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-proposals.test.ts tests/objective-write.test.ts` and the host typecheck.

### Task 11: owner results

**Files:** `packages/host/src/objective-input.ts`, `packages/host/src/objective-ops.ts`, `tests/objective-ops.test.ts`. Needs Task 7.

**Interfaces (produces):**
```ts
// objective-input.ts
export type CorrectionOp = /* today's four */
  | { op: "assumption.set"; id: string; status: "verified" | "refuted" }
  | { op: "rating.record"; subject: string; score: number };   // 1 to 5, Number.isInteger(score * 2)
// correctionOpSchema gains the two strict variants; correctionSchema's refine also allows each assumption id and each rating subject once.
export const RATING_SCALE = { min: 1, max: 5, step: 0.5 } as const;
// objective-ops.ts
export type OwnerOpContext = { configured: readonly TeamCommand[]; requestId: string; at: string;
  /** The goal's latest reviewed cycle; a rating without it is refused. */
  rating?: { commit: string; cycle: number } };
export const REGISTER_OP_NAMES: ReadonlySet<CorrectionOp["op"]>;   // "assumption.set", "rating.record"
// applyOps: the two ops are applied in order with the criterion ops, against the input record's assumptions, after the
//   secret scan; the body gains `assumptions`; sealing, log room, capped bytes, and the criteria digest check stay as today.
```

**Decisions:**

- **`assumption.set`.** The assumption must exist and have an `owner` test; otherwise `objective-assumption-target`. It takes the status and `ownerPinned: true`. `owner:<requestId>` becomes its last handle, replacing an earlier `owner:` handle. *(My call: setting any assumption's status, and unpinning, belong to the owner-ops slice. An owner test is the only kind that no host test reaches.)*
- **`rating.record`.**
  - **Checks.** An active `owner-rating` criterion or an owner test's `rating` must name the subject; otherwise `objective-rating-subject`. Without `context.rating`, the answer is `objective-rating-no-head`.
  - **Effects.** Each unpinned assumption whose owner test names the subject becomes `refuted` when the score is below its `below`, and `verified` otherwise. `rating:<requestId>` becomes its last handle, replacing an earlier `rating:` handle.
  - **Always logged.** The entry records the subject, score, commit, and cycle even when no assumption changes. Owner values live in the log, because the record has no field for them.
- **What step 5 reads.** The `after` values of `assumption.set` and `rating.recorded` (Task 7) are the stored owner results.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the owner sets an owner-test assumption and pins it` | **Setting.** `assumption.set` sets a4 (owner test) `verified`: `ownerPinned: true`, last handle `owner:<requestId>`, and one entry with `before` `{ status: "unchecked" }`. A second set replaces the handle. **Refusals.** On a2 (artifact test) and on a missing id: 409 `objective-assumption-target`. `correctionSchema` refuses status `assumed`. |
| `a rating stamps the reviewed head and moves unpinned owner tests` | **The rating.** Score 3.5 on `quality`, with `rating: { commit, cycle: 2 }`: a5 (below 4) becomes `refuted`, a6 (below 3) `verified`, and a7 (pinned) is unchanged. The entry's `after` is `{ subject: "quality", score: 3.5, commit, cycle: 2, changed }`. **Refusals.** Without `rating`: 409 `objective-rating-no-head`. A subject that nothing names: 409 `objective-rating-subject`. The schema refuses scores 0, 5.5, and 3.3. |
| `register ops and criterion ops share one version` | One correction with `criterion.retire` and `assumption.set` goes one version up, with both entries at that version. A stale version answers 409, as today. The existing objective-ops tests pass unchanged. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-ops.test.ts tests/objective-record.test.ts tests/objective-goals.test.ts` and the host typecheck.

### Task 12: the register in prompts

**Files:** `packages/host/src/register-prompt.ts` (create), `packages/host/src/team-prompts.ts` (+1 import; lines 90 and 376 in place), `tests/register-prompt.test.ts` (create). Needs Task 3.

**Interfaces (produces):**
```ts
// register-prompt.ts
export const REGISTER_LEAD = "Assumptions and open questions from the owner's objective record. A verified or refuted assumption rests on a host receipt or the owner; an assumed one stands in until it is tested; plan around unchecked and refuted ones; only the owner answers an open question";
export const ASK_SENTENCE = "Ask for a user decision if a material scope decision is required.";
export const PROPOSE_SENTENCE = "When the work depends on something the record does not settle, do not wait for a user decision: post a finding whose body proposes an assumption (a statement, what would refute it, a test, and a criticality), and plan so that the work survives if it is refuted. A proposal is a claim and changes no status.";
export function registerText(register: RegisterDigest): string;   // `${REGISTER_LEAD}:\n${JSON.stringify(register)}`
/** PROPOSE_SENTENCE when the goal digest holds a register, the run is pinned autonomous, and the role posts findings with entry tools
 *  (entryToolsFor and ROLE_KINDS); ASK_SENTENCE otherwise. */
export function scopeSentence(run: TeamRun, role: TeamMember["role"]): string;
// team-prompts.ts line 90, in place: the return appends `\n${registerText(record.register)}` when record.register is present.
// team-prompts.ts line 376, in place: the literal "Ask for a user decision if a material scope decision is required." becomes ${scopeSentence(run, role)}.
```

**Decisions:**

- **Without a register in the digest, the prompt keeps today's bytes:** the goal section and the sentence are unchanged.
- **Where the register text goes.** It comes right after the criteria, inside the goal section.
- **The ask sentence stays** for the project manager, which posts no finding, and for members without entry tools.
- **No text from the run** reaches the propose sentence.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `without the register the goal section is byte for byte` | For every role, `teamPrompt` of a goal run whose digest has no register equals the string pinned from the base commit. This holds with and without entry tools, supervised and autonomous. |
| `the register reaches the goal section with its lead line` | With a register of one assumption and one question, the prompt holds `REGISTER_LEAD` once and the register JSON once, after the criteria JSON. |
| `the scope sentence follows the mode, the register, and the role` | An autonomous run with a register, for an implementer with entry tools: `PROPOSE_SENTENCE`, and no `ASK_SENTENCE`. `ASK_SENTENCE` instead for the project manager, a reviewer without entry tools, a supervised run, and a digest without a register. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/register-prompt.test.ts tests/team-prompts.test.ts` and the host typecheck.

### Task 13: applying receipts

**Files:** `packages/host/src/objective-register.ts` (create), `tests/objective-register.test.ts` (create). Needs Tasks 1 and 9.

**Interfaces (produces):** pure.
```ts
export const RECEIPT_CHANGES_PER_ENTRY = 8;
export type ReceiptContext = { runId: string; revision: number; kind: PassKind; at: string };
export type ReceiptsApplied = { record: ObjectiveRecord; changed: string[]; refutedOutcome: string[] };
/** One version up with one `test.recorded` entry per 8 changes; undefined when no receipt changes a status or attaches a handle.
 *  Throws objectiveError("objective-log-full") past CORRECTION_LOG, and objectiveError("objective-op-refused") when the schema refuses the result. */
export function applyReceipts(record: ObjectiveRecord, receipts: readonly ObjectiveReceipt[], context: ReceiptContext): ReceiptsApplied | undefined;
```

**Decisions:**

- **When a receipt changes an assumption.** Only assumption receipts count, and only when all of these hold:
  - the outcome is `pass` or `fail`;
  - the assumption exists, with a test of the receipt's kind;
  - its origin is not `member`;
  - the outcome differs from its status (`pass` agrees with `verified`, and `fail` with `refuted`).
- **What it changes.** An unpinned assumption takes the status. A pinned one keeps its status and gains only the handle (part 3: "later receipts attach as evidence"). The handle `receipt:<runId>:<revision>:<id>` goes last, replacing an earlier `receipt:` handle. Each writer keeps one handle per prefix, so `evidence` holds at most three host and owner handles.
- **A receipt that agrees writes nothing,** so an unchanged register spends no log room. *(My call: `CORRECTION_LOG` holds about 380 entries for a goal's whole life, and the newest receipts stay readable in the run's sealed file.)*
- **`refutedOutcome`** lists the `outcome` assumptions that this pass set `refuted`, for the event.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `receipts set statuses only where the outcome differs` | **Changes.** a1 (`unchecked`) with a pass becomes `verified`. a2 (`assumed`) with a fail becomes `refuted`, with `receipt:R:3:a2` last in place of `receipt:R:2:a2`. **No change.** a3 (`verified`) with a pass is unchanged, and so is an assumption with an `unknown` receipt. **The write.** One version up, with one entry whose `before` and `after` follow Task 7. Receipts that change nothing return undefined. |
| `pinned and member assumptions keep their status` | A pinned `verified` assumption with a fail receipt keeps `verified` and gains the handle; with a pass receipt, nothing changes. A member assumption named by a receipt is unchanged. |
| `a pass writes entries of at most eight at one version` | 20 changes give 3 entries at one version, with consecutive seqs. Each entry's `before` and `after` is at most 2,048 bytes inline. |
| `a full log keeps the receipts and writes nothing` | At 380 log entries the call throws `objective-log-full`, and the input record is unchanged. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-register.test.ts tests/objective-receipts.test.ts` and the host typecheck.

### Task 14: the prompt version

**Files:** `packages/host/src/config-identity.ts`; in-place type lines in `packages/host/src/routing-auto.ts` (lines 1 and 32), `routing-reads.ts` (lines 2, 45, and 74), and `routing-routes.ts` (lines 6 and 68); `tests/config-identity.test.ts`. Needs Tasks 3 and 12.

**Interfaces (produces):**
```ts
// config-identity.ts
export type { ObjectivePrompt } from "./objective-digest.js";
const FIXTURE_REGISTER: RegisterDigest = { assumptions: [{ id: "a1", status: "unchecked", criticality: "plan", statement: "Fixture assumption." }],
  questions: [{ id: "q1", text: "Fixture question? Default: keep." }] };
export function renderedPrompts(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean,
  entryTools = false, objectiveDigest: ObjectivePrompt = false): string[];
export function promptVersion(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean,
  entryTools = false, objectiveDigest: ObjectivePrompt = false): string;
// "register" renders the fixture goal's record with FIXTURE_REGISTER on a run pinned supervised; "register-autonomous", pinned autonomous.
// memberConfiguration's input: objectiveDigest?: ObjectivePrompt; it passes input.objectiveDigest ?? false.
// routing-auto.ts line 32 and routing-reads.ts lines 45 and 74: the objectiveDigest field and parameter take ObjectivePrompt,
//   imported with promptVersion on line 1 (routing-auto.ts) and line 2 (routing-reads.ts), in place.
// routing-routes.ts line 6: import { objectivePromptFor } from "./objective-digest.js";   (objectivePromptsOn has no other use there)
// routing-routes.ts line 68: objectiveDigest: objectivePromptFor(project, startMode(project, config.teams?.lineup).mode),
```

**Decisions:**

- **Existing identities stay.** `false` and `true` render exactly as today, so every configuration identity and routing evidence key keeps its value.
- **What each shape renders.** Both register shapes render the register text. Only `"register-autonomous"` renders the propose sentence, and only for a role that posts findings with entry tools. So a project manager has one version under both shapes.
- **Routing.** The router computes start versions with the run's own shape (Task 18 changes line 4983), and its preview uses the shape a new run would pin.

- [ ] **Step 1: Write the failing test.**

| Test name | Assertions |
|---|---|
| `the register changes the prompt version only where the prompt changes` | **The implementer with entry tools:** `true`, `"register"`, and `"register-autonomous"` give three versions. **Without entry tools,** the two register shapes give one version. **The project manager:** the two register shapes give one version. **Unchanged:** the existing base pin (line 394) and `entry tools change the prompt version only for entry roles` pass. |

- [ ] **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/config-identity.test.ts`, then `tests/routing-auto.test.ts tests/routing-reads.test.ts tests/routing-routes.test.ts` in the background, and the host typecheck.

### Task 15: goal records and the owner route

**Files:** `packages/host/src/objective-goals.ts`, `packages/host/src/goals.ts` (lines 20, 21, 538, 548, 549, and 853 in place; net 0; stays 1,034), `tests/register-goals.test.ts` (create). Needs Tasks 3 and 11.

**Interfaces (produces):**
```ts
// objective-goals.ts
/** Throws objective-prompts-off when a criterion op meets prompts off, and objective-register-off when a register op meets the register off. */
export function correctionGate(project: Pick<Project, "team"> | undefined, correction: Pick<Correction, "ops">): void;
/** latestReviewed(goal.cycles)'s headCommit and cycle number, or undefined when there is none or it has no head. */
export function ratingStamp(goal: Pick<ProductGoal, "cycles">): { commit: string; cycle: number } | undefined;
/** Today's digest; with `register`, it gains registerDigestFor(record) before the schema parse. */
export function goalRecordDigest(holder: GoalHolder, configured: readonly TeamCommand[], register?: boolean): GoalDigestResult;
// goals.ts, in place:
//   20:  the objective-goals import gains correctionGate and ratingStamp
//   21:  import { objectivePromptsOn, objectiveRegisterOn } from "./objective-digest.js";
//   538: "…Criterion ops need objective prompts on; register ops need the register on."
//   548: correctionGate(project, body);
//   549: const next = correctGoalObjective(stored, body, { configured: project?.team?.checks ?? [], requestId: body.requestId, at: now(), rating: ratingStamp(goal) });
//   853: const pinned = objectivePromptsOn(project) ? goalRecordDigest(stored, project?.team?.checks ?? [], objectiveRegisterOn(project)) : undefined;
```

**Decisions:**

- **One route.** Owner results go only through `POST /api/goals/:id/record` (`objective-routes.ts` line 22), which `server.ts` line 1097 guards with `requireRole(["owner"])`; the relay refuses the path. No new route, and no `server.ts` line. Standalone runs get no owner route here; the owner-ops slice adds `POST /api/teams/:id/record`.
- **The register never costs the criteria.** It has its own budget, so a goal never skips its criteria digest because of it.
- **No goal gate.** A goal does not wait for its cycle's pass. A pass that finishes after the next cycle's launch reaches the cycle after it. *(My call: holding `activeTeamId` would repeat the event at `goals.ts` line 788 ("A feature passed checks and independent review…") on every tick, because the settle block from line 763 runs again on each tick while the team stays attached. A pass ends within 120 seconds.)*

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `owner results take the owner route only` | **On the server fixture** that `tests/goals.test.ts`'s record test uses (`f.host.fetchApi`). **The route.** With prompts and the register on, the owner's `assumption.set` on a missing id answers 409 `objective-assumption-target`, which shows that the op passed the role and the gate. A controller's and a viewer's answer 403. **The register switch.** With the register off, the answer is 409 `objective-register-off`. With prompts off and the register on, `criterion.retire` answers 409 `objective-prompts-off`. |
| `a rating needs a reviewed cycle` | **`ratingStamp`.** Cycles blocked, ready-for-review (H1, cycle 2), no-change, and merged (H4, cycle 4) give `{ commit: H4, cycle: 4 }`; cycles with no reviewed one give undefined. **The route.** With an `owner-rating` criterion on `quality` and no reviewed cycle, `rating.record` answers 409 `objective-rating-no-head`. |
| `a goal's next cycle carries the register digest` | **With prompts and the register on,** the next launch context's `record.register` lists intent-check and owner assumptions and no member assumption. **With the register off,** the digest's JSON equals the one from before the key was written. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/register-goals.test.ts tests/objective-goals.test.ts tests/standing-goals.test.ts` (in the background) and the host typecheck. Confirm with `wc -l` that `goals.ts` is 1,034 lines.

### Task 16: the CLI

**Files:** `packages/host/src/objective-cli.ts`, `tests/objective-cli.test.ts`. Needs Task 11.

**Interfaces (produces):**
```ts
export const GOAL_RECORD_USAGE = [
  "Usage: infinite goal record ID [--version N] [--json]",
  "       infinite goal record ID retire CID|confirm CID [--version N] [--request-id ID] [--json]",
  "       infinite goal record ID set-assumption AID verified|refuted [--version N] [--request-id ID] [--json]",
  "       infinite goal record ID rate SUBJECT SCORE [--version N] [--request-id ID] [--json]",
  "       infinite goal record ID apply --file PATH [--version N] [--request-id ID] [--json]",
].join("\n");
// formOf destructures [verb, goalId, form, target, value, ...rest]; set-assumption and rate take five positionals.
// objectiveRecordLines, line 111 in place: `  ${id} ${status}${pinned} ${criticality} ${origin}${handle}: ${statement}`, where `pinned` is
//   " pinned" when ownerPinned, and `handle` is ` [${h}]` for the last evidence handle h that starts with receipt:, owner:, or rating:.
//   A line with neither prints as today, so the intent check's `the record lines show the register` passes unchanged.
```

**Decisions:**

- **Scores.** A score must match `/^[1-5](?:\.[05])?$/` and be at most 5. Anything else is a usage error before any request.
- **Failures.** The server's code gives its fixed sentence through `OBJECTIVE_ERRORS`, as today, and 403 keeps "Corrections need an owner device key." `team-cli.ts` and `client.ts` do not change: `client.ts` line 903 already sends `goal` commands here.

- [ ] **Step 1: Write the failing test.**

| Test name | Assertions |
|---|---|
| `the CLI records owner results` | **Requests.** `record G set-assumption a4 verified` posts one op, `{ op: "assumption.set", id: "a4", status: "verified" }`, at the latest version. `record G rate quality 3.5` posts `{ op: "rating.record", subject: "quality", score: 3.5 }`. **Usage errors with no request:** `rate quality 6`, `rate quality 3.3`, `set-assumption a4 assumed`, and an extra argument. **Output.** A 409 `objective-rating-no-head` prints its sentence. The record lines include `  a4 verified pinned detail owner [owner:<requestId>]: …` and `  a2 refuted plan intent-check [receipt:R:1:a2]: …`. The existing `the record lines show the register` passes unchanged. |

- [ ] **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/objective-cli.test.ts` and the host typecheck.

### Task 17: the runtime

**Files:** `packages/host/src/team-register.ts` (create), `tests/team-register.test.ts` (create), `tests/register-rebuild.test.ts` (create). Needs Tasks 2, 5, 9, 10, 11, and 13.

**Interfaces (produces):**
```ts
export { objectivePromptOf, registerPin } from "./objective-digest.js";
export const REGISTER_PASS = { passMs: 120_000, stalledReads: 4 } as const;   // subjects and reads: PASS_LIMITS
export type RegisterPass = { revision: number; kind: PassKind; commit?: string; state: "pending" | "done"; markedAt: string; finishedAt?: string;
  receipts?: ObjectiveReceipt[];   // at most 40
  wrote?: number;                  // the record version written
  skipped?: "record-unavailable" | "log-full" | "write-failed" };
export type RegisterDrop = ProposalDrop | "record-unavailable" | "write-failed";
export type RegisterState = { pass?: RegisterPass; drops?: Partial<Record<RegisterDrop, number>> };
export type RegisterHolder = { run: TeamRun; objectiveRecord?: unknown; checkHead?: string; register?: RegisterState };
export type RegisterHost = {
  holder(runId: string): RegisterHolder | undefined;
  configured(run: TeamRun): readonly TeamCommand[];        // the project's checks now
  workspace(holder: RegisterHolder): string | undefined;   // run.workspace when assertRunPath passes
  enqueue(work: () => void): Promise<void>;                // the serial queue
  save(holder: RegisterHolder): void;
  event(holder: RegisterHolder, text: string): void;
  prefix(): TeamCommand | undefined;
  now(): string;
};
export const REGISTER_EVENTS = {
  recorded: (revision: number, counts: { pass: number; fail: number; unknown: number; changed: number }) =>
    `Host tests for revision ${revision}: ${counts.pass} passed, ${counts.fail} failed, ${counts.unknown} unknown; ${counts.changed} assumption statuses changed.`,
  refuted: (ids: readonly string[]) => `Host tests refuted outcome assumptions ${ids.join(", ")}.`,
  skipped: {
    "record-unavailable": "Host tests could not read the objective record, so no assumption status changed.",
    "log-full": "The objective record's log is full, so host test receipts changed no assumption status.",
    "write-failed": "The objective record could not be saved, so host test receipts changed no assumption status.",
  },
  proposalsDropped: "Member assumption proposals were dropped at a limit or could not be recorded.",
} as const;
export class TeamRegister {
  goals?: GoalRecordPort;
  constructor(host: RegisterHost, reader?: BlobReader);   // default blobReader(host.prefix)
  /** In `save`, memory only: marks a pass due. */
  mark(holder: RegisterHolder): void;
  /** Once at startup: marks every holder and queues every pending pass. */
  restore(holders: Iterable<RegisterHolder>): void;
  /** In the tick: starts the oldest queued pass when none runs. Never awaits, never throws. */
  drain(): void;
  /** In the ingest pass: applies the kept finding posts that carry `assumption`. Never throws. */
  propose(runId: string, member: TeamMember, posts: readonly MemberPostRecord[]): void;
  /** For step 5 and tests: the latest pass's receipts, and whether a pass is pending. */
  receipts(runId: string): readonly ObjectiveReceipt[] | undefined;
  pending(runId: string): boolean;
  close(): void;
  /** Settles when the running pass has finished. Tests only. */
  idle(): Promise<void>;
}
```

**Decisions:**

- **When a pass is due.**
  - **The condition.** `mark` acts on a run pinned `register: "on"` whose status is `ready-for-review`, `merged`, or `blocked`, and whose revision has a check entry.
  - **The kind.** A pass is `reviewed` when the reviewed-head rule holds, as `teams.ts` line 4787 reads it: `run.headCommit` is set, `checkHead` equals it, and `run.review` is approved at the revision. Otherwise it is `check`.
  - **Replacement.** One pass per revision and kind. A reviewed pass replaces a check pass of the same revision; nothing replaces a reviewed pass of the same revision; a later revision replaces any earlier pass.
  - **Persistence.** The `save` that marks a pass also writes it. `restore` marks every holder once at startup, so a run that settled just before a crash gets its pass.
- **A pass, in three steps:**
  1. **In the tick, inside the serial queue.** Read the record with `heldRecordState`, plan the subjects and the reads, and copy the revision's checks.
  2. **Outside the queue.** Read each blob in order through the reader, with one `AbortController`. A read starts only while fewer than 4 reads are stalled and the pass is under 120 seconds; the others are `not-run`.
  3. **Through `host.enqueue`.** If the holder is gone, or its `register.pass` is no longer this pass object, drop the result. Otherwise:
     - read the record again and plan its subjects again;
     - compute the receipts (`not-run` for any read it did not plan) and apply them with `applyReceipts`;
     - write the record with `writeHeldRecord`, and set the pass `done` with its receipts and `wrote` or `skipped`;
     - add the events and save the holder.
- **A pass never changes the run's state.** It writes only the record and `Stored.register`, adds no status, and so writes no outcome event. A run that was paused, cancelled, or resumed after the mark keeps its state, and a receipt stays a fact about a commit, which does not change. This is the lesson that completions must ignore stopped runs: this completion changes no run state.
- **Order.** One pass at a time, oldest first. `drain` returns at once while one runs.
- **Proposals.**
  - **Where it runs.** `propose` runs inside the ingest pass, in the serial queue, on a run pinned `register: "on"`.
  - **What it builds.** A `Proposal` from each kept `finding` post that carries `assumption`. The entry id is the envelope's `requestId`, the author role is the member's role, and the summary is the entry's.
  - **Applying.** It calls `applyProposals`, writes the record, and saves the holder.
  - **Failures.** An unreadable record counts every proposal under `record-unavailable`, and a failed write under `write-failed`.
  - **Drops.** They add to `register.drops`, and one fixed event per run reports them.
- **Events** carry ids and counts only:
  - one when a pass finishes;
  - one listing the `outcome` assumptions that a pass refuted;
  - one per skip.

- [ ] **Step 1: Write the failing tests.** Each test uses a fake host and a fake reader, unless the row says otherwise.

| Test name | Assertions |
|---|---|
| `a settled revision gets one pass` | **The reviewed pass.** `mark` at `ready-for-review` with the reviewed-head rule gives one pending reviewed pass, which is saved. `drain` reads each planned blob once. The apply writes the record one version up, sets the pass `done` with its receipts and `wrote`, adds one event, and saves. **No second pass.** A second `mark` at `merged` adds none. **A blocked revision with checks** gets a check pass that reads nothing. **An unpinned run** gets no pass. |
| `a pass never outlives its run or its revision` | **Gone or replaced.** If the holder is removed before the apply, nothing is written and no event is added. If a new revision is marked while a pass reads, the old apply writes nothing and the new pass runs next. **Skips.** A goal port whose write throws gives `skipped: "write-failed"` and one event, and the receipts are kept. An unreadable record gives `record-unavailable`, and a full log gives `log-full`. |
| `stalled reads stop the pass from reading` | **Stalls.** The reader's first four reads stall, so the fifth never starts. Its subjects' receipts are `unknown` with `read: "not-run"`, and the pass ends `done`. **The deadline.** A read that passes the 120-second deadline, on a fake clock, leaves the rest `not-run`. |
| `proposals follow the pin and the record` | **An unpinned run:** nothing changes and no drop is counted. **A pinned run:** a stance and a proposal apply once across two calls with the same posts. **An unreadable record:** `record-unavailable` is counted with one event, and a second drop adds no second event. |
| `seeded runs with restarts write each pass once` | **Seeded:** 100 seeds, with the seed printed on failure. **The sequences** are random: marks at random statuses and revisions, drains, read completions, proposal pages, and restarts. A restart is a new `TeamRegister` over a JSON round trip of the holders and the goal record. **Invariants.** At most one `test.recorded` version per run, revision, and kind. Every pass ends `done` or replaced. The final record equals the one from the same sequence without restarts. |
| `every version rebuilds after random register writes` (register-rebuild) | **Seeded:** 200 seeds. **The writes** are random `applyReceipts`, `applyProposals`, owner ops (`applyOwnerOps` with `assumption.set`, `rating.record`, and criterion ops), and intent applies (`applyIntentReport`), with a JSON round trip between steps. **The check.** For each version, `rebuildVersion(final, v)` deep-equals the snapshot after the last write at `v`, and every snapshot parses. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/team-register.test.ts tests/register-rebuild.test.ts` and the host typecheck. Confirm with `wc -l` that `team-register.ts` is under 1,000 lines.

### Task 18: the hooks in `teams.ts`

**Files:** `packages/host/src/teams.ts` (+6: from 5,707 to 5,713), `tests/fixtures/team-agent.mjs` (`--command-prefix` mode, +6), `tests/register-host.test.ts` (create), `tests/autonomy-pins.test.ts` (one test). Needs Tasks 3, 6, 8, 14, and 17. Task 18 is the only task that writes `teams.ts`.

**Interfaces (produces):**
```ts
// teams.ts, by line on the reference tree (apply bottom-up; find each by its code):
// after 56:   import { TeamRegister, objectivePromptOf, registerPin, type RegisterState } from "./team-register.js";            +1
// 192, in place:  objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable; intentCheck?: IntentCheckState; register?: RegisterState;
// after 507:  private readonly objectiveTests = new TeamRegister({ holder: id => this.records.get(id), configured: run => this.config.projects.find(p => p.id === run.projectId)?.team?.checks ?? [],
//               workspace: s => { try { this.assertRunPath(s as Stored, s.run.workspace); return s.run.workspace; } catch { return undefined; } },
//               enqueue: work => this.enqueue(work), save: s => this.save(s as Stored), event: (s, text) => this.event(s as Stored, text),
//               prefix: () => this.config.teams?.commandPrefix, now: timestamp });   // one line                                       +1
// after 675 (the constructor's last statement): this.objectiveTests.restore(this.records.values());                               +1
// 686, in place:  useGoalRecords(port: GoalRecordPort) { this.intentChecks.goals = port; this.objectiveTests.goals = port; }
// after 862 (in save, after endPermissionTask): this.objectiveTests.mark(stored);                                                 +1
// 909, in place:  { events: …as today…, entries, kept: (run, member, posts) => this.objectiveTests.propose(run.id, member, posts) })) {
// after 1585: if (registerPin({ setting: project.team.objective?.register, mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) })) run.register = "on";   +1
// after 2475 (in the tick, after drainEntries): this.objectiveTests.drain();                                                     +1
// 2483, in place: close() gains this.objectiveTests.close(); before this.removeAgentSource?.();
// 4983, in place: objectiveDigest: objectivePromptOf(run),
// 5168, in place: objectiveDigest: objectivePromptOf(stored.run),
```

**Decisions:**

- **One call per hook.** Each hook makes one call into `TeamRegister`. `teams.ts` reads nothing new from the store, a journal, or a sealed file.
- **The view.** `run.register`, an enumeration, reaches every view and relay device through the team view, as `run.intentCheck` does. `Stored.register` is outside `run` and reaches no view.
- **The fake prefix gains two flags.** With `refuse-cat-file`, it exits 128 for a `git … cat-file` command. With `hold-cat-file`, it waits for `release-cat-file` before it runs one.

- [ ] **Step 1: Write the failing tests.** They run on `tests/fixtures/team-scheduler.ts`, with this setup:
  - `teams.commandPrefix` is the fake agent's `--command-prefix` mode, with a receipt directory;
  - the blackboard is on, as `tests/team-entries.test.ts` turns it on;
  - the run is written at `ready-for-review` with the reviewed-head rule, and its member is a reviewer with entry tools.

| Test name | Assertions |
|---|---|
| `acceptance 5 end to end` | **Setup.** The run's head commits `research/entries.json`: 45 entries, 31 of which cite two sources in checkable form on distinct hosts. The project's `team.checks` holds `rank-verify`, and the final check round has it `failed`. The record holds a2 (plan; artifact test with count `/entries`, `citedPerEntry` 2, min 40) and a4 (command test on `rank-verify`, `refutesOn: "fail"`). **The finding.** A finding that contradicts a2 is posted and ingested. a2 stays `unchecked`, with the proposal attached. **The pass.** a2 becomes `refuted` with handle `receipt:<run>:1:a2`, and its receipt detail is `{ read: "read", total: 45, qualifying: 31 }`. a4 becomes `refuted`. There is one `test.recorded` version, no decision, and no change to the run's status. **Commands.** `commands.jsonl` holds one B1 line for `<head>:research/entries.json` and no other command. |
| `without the register a run is as today` | The same run without `run.register`, after drains and an ingest of the same finding: no `Stored.register`; the record unchanged; the finding on the board; no register event; no `cat-file` in `commands.jsonl`; and no `register` key in `teams.get(id)`. |
| `a refused blob form leaves artifact results unknown` | With `refuse-cat-file`, a2 stays `unchecked`. Its receipt is `unknown`, with `read: "read-failed"` and no `total`. a4 becomes `refuted`. |
| `a restart while a pass reads runs it once` | With `hold-cat-file`, the pass starts, the service closes, and a new service opens. After `release-cat-file`: one `test.recorded` version, and the pass `done`. |
| `the view shows the pin and nothing else` | `teams.get(id).register` is `"on"`. The view's JSON holds no `receipt:` handle of the pass, no `qualifying`, and no proposal summary. |
| `each new run pins the register by setting` (autonomy-pins) | `create()` pins `register: "on"` only with `objective: { register: "on" }`. `createForMission()` and a handoff run never pin it. The sealed record and the view carry the pin. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/register-host.test.ts tests/team-entries.test.ts tests/autonomy-pins.test.ts tests/intent-check.test.ts tests/objective-runs.test.ts` in the background, and the host typecheck. Confirm with `wc -l` that `teams.ts` is 5,713 lines.

### Task 19: the docs and the spec

**Files:** `docs/teams.md`, the spec. Runs last; the contract is fixed in this plan.

**Decisions:**

- **`docs/teams.md`, in the goal record section, covers:**
  - **The setting:** `objective.register`, off by default and inside the routine approval digest; what it turns on; and that the pin is taken at `createRun`.
  - **Tests:** the four kinds, when each runs, what each reads, and that no test runs a command. The B1 row in the Git forms table (Form, Command, Limit, If refused), with the 35-second launcher limit.
  - **Receipts:** what a receipt stores and where.
  - **Proposals:** the finding field, its limits and screens, and why member assumptions are never tested or shown in the digest until adopted.
  - **Owner results:** the two ops, their roles, `set-assumption` and `rate`, and the scale in halves.
  - **Prompts:** the register digest, the propose sentence, and that a refuted outcome assumption does not hold the next cycle until interruptions (C18) are built.
  - **Rollback:** the steps before a rollback, from this section's rollback row.
- **The spec:**
  - **Part 3:** the setting; member tests never run; adoption deferred; a pinned assumption's receipt attaches only when it disagrees; one handle per prefix; writes only on a change; the refutation hold deferred to C18.
  - **Part 5's authority table:** receipts in the run's sealed file, not `GoalCycle.receipts`.
  - **Part 7:** the `sources` field and https only.
  - **Part 8:** the register's own budget and no member text.
  - **The delivery order:** updated to match.
  - **"Left to the builder":** the answer on Git reads and their timeouts.

- [ ] **Step 1: Amend the docs and the spec.** **Step 2: Run** the privacy scan of `AGENTS.md` over the diff.
- [ ] **Step 3: After every task, the coordinator runs `npm run check` once on the integrated branch, requests the independent review, and commits.**

## Not in this slice

- **Adopting member assumptions:** the intent check sorting `unchecked` items, and owner promotion. This belongs to a later intent-check item or the owner-ops slice.
- **The C18 interruptions:** the hold on a refuted `outcome` assumption ("the next cycle does not start"), and challenges in the daily digest.
- **C16 readers' `findings` results as proposals.**
- **Outside citation text held by the host,** and the `citations` and `citation-form` criteria (delivery step 7).
- **Artifact `schema` checks** (`unknown` here).
- **Step 5:** verdicts, the evaluator role, `provisional-met`, `GET /api/goals/:id/verdicts`, and copying receipts into its verdict storage.
- **Owner register ops beyond the two:** setting any assumption's status, unpinning, per-question answers, promotions, and `POST /api/teams/:id/record` for standalone runs.
- **A goal gate** that waits for a pending pass.
- **Receipts in the outcome ledger.**
- **Record screens** on the web, the phone, and the Mac.
- **The launcher change for B1,** which the owner approves and installs.

---

# Slice: verdicts

This slice covers part 5 of spec `2026-11-13-objective-record-design.md` (the evaluator, composition, use in a goal, criterion status in the next cycle, the owner override, display, and the ledger), the verdict rows of part 8, and delivery order 5 with acceptance 6, 7, 10, and 11. After it, on a run that the owner opted in, the host starts one read-only `evaluator` member when a revision is reviewed or a goal cycle reports no change. It composes the evaluator's report with host receipts and owner values into one provisional verdict, labelled an agent assessment. In an autonomous finite goal, a composed `met` stops the goal as `ready-for-review` with `stopReason: "provisional-met"`; the owner records `achieved`, or `not-achieved` with `continue`. In a standing goal, a verdict feeds the failure count. The next cycle's coordinator reads each criterion's status and check label. It builds on steps 1 to 4 on `main` (the record, owner corrections, the digest, the intent check, and tests and proposals) and on C19's family function (`familyOf`).

**Line numbers.** Every line number is on the reference tree, `main` at `21bebd00`. Each edit quotes the code it changes, so a worker finds it by that code if `main` moves. Within a task, apply edits from the bottom up.

## My calls, for the coordinator to confirm

Each call names the reason. "Ruling needed" marks the ones that change product behaviour or the spec's text.

1. **Off by default, pinned when the run is created.** A new key, `project.team.objective.evaluator`, takes `"on"` or `"off"` and has no default. It is inside the routine authority digest, because `digestedProjectTeam` strips only `eval`. Writing it therefore blocks active routines until the owner approves them again. `createRun` pins `run.verdicts = "on"` only when the key is `"on"`, the run pins `register: "on"`, and the run is neither a mission subteam nor a handoff run. Otherwise the field stays absent, and views and sealed runs keep today's bytes. A run created before this slice never gets a verdict, even after a restart. *(Ruling needed. Part 5 and C12 read as "on in autonomous mode", and step 3's `intentCheckPin` took that default. The brief makes every new behaviour off by default, and this plan follows the brief.)*
2. **Verdicts need the register.** Host criteria take their state from host test receipts (composition rule 1), and only the register (step 4) produces receipts. A verdict without the register would make every command and artifact criterion `inconclusive`, so the pin needs both keys. *(My call: one code path, and no verdict that is `inconclusive` only because a setting is missing.)*
3. **The evaluator holds the run before it settles.** Settled runs are never stepped (`teams.ts` line 2377), so an evaluator after settle would need a second member loop. The host holds at two points, as the intent check holds a plan:
   - **Reviewed:** after the review approves the revision and before delivery or settle (`teams.ts` line 2593), and before line 2594's read-only check of the integration checkout, so a held tick runs no Git command.
   - **No change:** when the project manager's `no-change` report arrives on a goal cycle that started from a reviewed head (`teams.ts` line 3073). The held report is consumed again once the verdict is done.

   A blocked or cancelled run gets none, as part 5 says. The verdict delays delivery by one read-only member. *(My call.)*
4. **The register's pass runs first.** At the reviewed hold, the verdict asks the register for a reviewed pass at the head (`TeamRegister.markReviewed`, Task 4) and waits until it is done. The evaluator then reads the receipts in its context, and composition reads the same receipts. The register's own `mark` at `ready-for-review` later finds the reviewed pass of the same revision and adds none.
5. **Where verdicts live.** No new store holds text.
   - **Full detail** (the evaluator's report, each criterion's composed state, resolved handles, notes, and the profile): `Stored.verdict`, in the run's sealed file, outside `run`. Only the current revision's verdict is kept. It expires with the run, as receipts do.
   - **Summary on the run:** `run.assessment` (ids, enumerations, and counts). It reaches every team view and relay device.
   - **Summary on the goal:** `GoalCycle.assessment`, copied when the goal refreshes the cycle, plus `progress`. It reaches every goal view and relay device. It outlives the run.
   - **The record:** each active criterion's `latest` (`{ state, verdictId }`, no note) and one `verdict.recorded` log entry per verdict, plus one `evaluator-contradicted-receipt` entry per contradicted criterion.
   - **The ledger:** one `objective_verdicts` row per verdict, projected from a run event, with numbers and enumerations only.

   *(Ruling needed against part 5, which puts the note in `latest`. With notes, one verdict needs up to 8 log entries of about 1.3 KiB, and the log's 300-entry share would fill in about 20 cycles; `objective_log` overflow is not built. Without notes, one entry per verdict holds every criterion's `latest` within the 2 KiB inline limit. The notes stay on the run for the owner's display.)*
6. **The evaluator's text stays sealed.** `screen` moves the full report into `Stored.verdict` and leaves a stub on the member (`{ kind: "verdict", result, criteria: [{ id, state, evidence: [] }] }`), so no team view, relay device, blackboard entry, or later member context holds a note or a handle. `memberReports` (`team-prompts.ts` line 188) and `reportingMembers` (`evidence/host-entries.ts` line 76) skip the role. The owner reads notes and handles through `GET /api/goals/:id/verdicts`.
7. **Evidence handles resolve by form and membership.** A handle resolves when it is:
   - a receipt handle from the context's `receipts`;
   - `file:PATH` or `file:PATH#Lfrom-Lto` whose PATH passes `isScopedPath`, is at most 300 characters, and is one of the context's changed paths or a path that an active criterion's check or `pinned` names.

   Citation handles never resolve in this slice: citation checks are delivery step 7. A state is kept only when every handle it gives resolves, and a `met` gives at least one. Otherwise the state becomes `inconclusive` (`unresolved-evidence`). *(My call: no Git read per handle. Up to 64 handles per verdict would need 64 reads, and the host already knows the changed paths.)*
8. **`merged` and `landed` receipt criteria are `inconclusive` at the verdict** (`before-delivery`), because the verdict is taken before delivery. A goal whose record holds one never reaches a provisional `met`; the owner retires or edits that criterion. `checks-passed` and `review-approved` are host facts at the hold. *(Ruling needed: the alternative is a second composition step on the goal after delivery, which adds a goal-side rule.)*
9. **The no-change verdict** reads `run.headCommit`, which equals `run.baseCommit` on a no-change run. It runs only on a goal cycle whose context names `parentRunId`, so the head is the goal's latest reviewed head. Its receipts are the parent run's reviewed-pass receipts when that pass ran at the same commit; otherwise host criteria are `inconclusive` (`no-receipt`). A first cycle that reports no change gets no verdict.
10. **Standalone runs** get a verdict at the reviewed hold, for display only, as part 5 says. Their row has no goal index.
11. **What a verdict changes.** Only an autonomous goal acts on it (`autonomyOf(goal) === "autonomous"`). A supervised goal and a standalone run show it and change nothing.
    - **Finite goal, composed `met` on a reviewed cycle:** the goal stops as `ready-for-review` with `stopReason: "provisional-met"` and a fixed reason. Its status is never `achieved`.
    - **Finite goal, anything else:** the next feature starts, as today.
    - **Standing goal:** a `met` is recorded, and the next cycle starts at its cadence. A cycle with a verdict fails when its composed result is not `met` and its progress is not positive; three failed cycles in a row pause the goal with `repeated-failures`, as today. A cycle with no verdict is classified as today.
    - **`until-met`:** not built. The continuous autonomy design's delivery step 5 adds it and reads `GoalCycle.assessment`.
12. **The owner override uses the outcome route, as part 5 says.** `POST /api/goals/:id/outcome` gains `verdictId` and `continue`. The route keeps its roles (owner and controller) and its relay rule (allowed), because a controller records outcomes and steers today. *(Ruling needed: whether `continue` is owner only. Making it owner only changes `server.ts` line 1286's middleware in place; the relay cannot refuse by body.)* `continue` appends the owner's summary as a steering entry, through the path that `steer` uses, so the next cycle's objective prints it (`goals.ts` line 873) and the record gets direction `s<revision>` (`direction.appended`). *(My call against part 5's "a `correction` direction": no step writes correction directions yet, and a correction direction would not reach the next run's objective.)*
13. **Criterion status reaches the next cycle through `TeamGoalContext.criteria`.** C17's goal digest (`goal-digest.ts`) is not wired, and wiring it brings history, touched paths, failures, decisions, and open items that are C17's work. This slice adds only the digest's `criteria` rows (`{ criterion, status, check }`, at most 8, check labels at most 120 bytes) to the goal context, built from the previous cycle's assessment, and prints them in the project manager's prompt only. When C17 wires its digest, the rows move into it. *(Ruling needed: part 5 says "through the goal digest of C17, and through no other channel".)*
14. **Agreement waits.** Part 5 stores in the row whether the owner agreed. `goals.ts` has no line to spare and no writer into the evidence outbox, and run events need the run, which may be gone. This slice stores `verdictId` on the owner's outcome and shows agreement in the verdicts read. The row's `owner_agrees` column and the per-profile agreement cell wait for a goal event path. *(Ruling needed.)*
15. **No router change.** The router does not avoid `evaluators` profiles for a cycle's tasks. When every eligible profile's model authored integrated work, the verdict is `inconclusive` with `no-independent-evaluator` (part 5). *(My call on part 5's "left to the builder" question: the router change touches routing evidence and is its own slice.)*
16. **The lineup warning waits.** Acceptance 11's last clause ("the lineup check warned about it") needs a warning in the enrollment view and `repo init`. This slice exports the pure rule `evaluatorOverlaps(lineup)` and shows its result nowhere yet. *(Ruling needed: include `repo-enrollment.ts` and `team-cli.ts` here, or defer.)*
17. **No new interruption (C18).** The provisional stop is today's goal stop (`ready-for-review`), and the failure pause is today's `repeated-failures` hold. No notification, decision, or push is added. The bound: one stop per goal until the owner continues it, one failure pause per three failed cycles, and one fixed event per verdict.
18. **The report tool schema.** The `verdict` variant joins `teamReportVariants`, as `intent-check` did in step 3. The report tool's input schema therefore grows for every role, with the key absent too. Prompt text, context files, events, views, and the prompt version do not change, because the version hashes rendered prompts. *(Ruling needed if the tool schema must also stay byte for byte; that needs a per-role report schema in `worker.ts`, which is at its baseline.)*

## Coordinator rulings (2026-11-21)

These rulings settle the calls above. Where a task's text differs, the ruling wins.

1. **Call 1 is confirmed.** `objective.evaluator` has no default and is off unless set, in every mode, and the pin needs `register: "on"` too. A verdict needs the register, which the owner opts in to, so a default of its own would turn on half a feature. Task 16 amends the spec's "on in autonomous mode".
2. **Call 5 is confirmed.** `latest` holds `{ state, verdictId }` and no note.
3. **Call 8 is confirmed for this slice.** `merged` and `landed` criteria are `inconclusive` (`before-delivery`). This is a known limit: the docs and the pull request name it. The goal-side step after delivery is a later slice.
4. **Call 12 is confirmed.** `continue` keeps the outcome route's roles and its relay rule. It has the authority of the outcome it rides on, and no middleware changes.
5. **Call 13 is confirmed.** The criteria rows go through `TeamGoalContext.criteria` and reach only the project manager's prompt, pinned by Task 10's test. They move into C17's digest when it lands.
6. **Call 14 is confirmed.** Agreement waits for a goal event path.
7. **Call 16 is confirmed.** The lineup warning waits. Acceptance 11's last clause stays open, and the pull request says so.
8. **Call 18 is confirmed.** The `verdict` variant joins `teamReportVariants`. `roleAcceptsReport` (`teams.ts`) gains `evaluator: ["verdict"]` and no other role gains `verdict`, so a `verdict` report from another role is a wrong report, as today. Task 12's `without verdicts a run is as today` also asserts that a `verdict` report from an implementer gives no assessment and no `Stored.verdict`.
9. **Lines in baseline files.** This overrides "every change stays on its line" in Tasks 5, 12, and 13.
   - A hook that extends an existing expression, list, or type on its line stays on that line.
   - A new import, a new field, or a new statement gets its own lines, one statement per line. No task joins statements to hold a line count.
   - The task raises that file's entry in `scripts/file-size-baseline.json` by hand, by exactly the lines it added: at most 3 for `server.ts` (Task 5), 16 for `teams.ts` (Task 12), and 10 for `goals.ts` (Task 13). No task runs the script with `--update`. The pull request states each raise and its reason.
   - `manager.ts` and `worker.ts` gain a list element in place and no line.
10. **Test runs.** This overrides "in the background". Every test command runs in the foreground, with `NODE_OPTIONS=--max-old-space-size=2048` and a time bound: `perl -e 'alarm shift; exec @ARGV' 900 node --import tsx --test FILE...`. No worker starts a Monitor, a background run, the full suite, or a mutation tool.
11. **Commits.** A worker never commits, stashes, resets, or checks out. The coordinator reads each task's diff and commits it.
12. **Waves.** At most four implementers at once. The first wave is Tasks 1 to 4; Task 5 runs with the second wave.
13. **Reference tree.** The build starts on `main` at `84f9a8c3`. Since `21bebd00`, `main` changed only permission files, `docs/teams.md`, and an egress document, so the line numbers of the files this slice writes still hold, except in `docs/teams.md` (Task 16).
14. **The verdict event carries its project.** `verdictEventDataSchema` gains a required `projectId` (the project id pattern of `team-types.ts`, `^[a-z0-9-]{1,80}$`), and the projector writes `tx.index("project", data.projectId)`. The projector reads no other module's table: a verdict event can be projected while the outcome ledger is behind or unavailable. Task 11's `emit` fills `projectId` from the run.
15. **The module name is `objective-verdicts`.** The store's name rule refuses an underscore. The table stays `objective_verdicts`.
16. **Three role lines came forward into Task 1's commit** so that every commit on the branch passes the typecheck: `TEAM_ROLES` (`team-mcp-results.ts`), `LAUNCH_ROLES` (`fuse/baseline.ts`), and `evaluator: ["verdict"]` in `roleAcceptsReport` (`teams.ts`). Task 12 finds that hook in place and counts 16 hooks to write. No evaluator member exists before Task 12, so the lines change nothing until then.
17. **`verdict-types.ts` keeps its own copy of the id pattern.** `team-types.ts` loads that module, and it does not load `objective-types.ts`.
18. **Authors count across revisions** (from the Task 11 review). The evaluator rule counts as an author every implementer and integrator member of the run that holds a `result` report, from any revision. Steer, resume, and recovery reset `run.tasks`, but the head keeps what earlier revisions integrated. Counting too many only gives `no-independent-evaluator`, which is safe.
19. **The evaluator's answer holds for the criterion it read** (from the Task 11 review). `VerdictState` gains `judged?: Record<string, string>`: for each criterion in the evaluator's context, a SHA-256 of the canonical JSON of its statement and check, written when the context is built. At the finish, an evaluator answer for a criterion whose digest differs, or that the context did not hold, is dropped before composition, so the criterion composes as `not-assessed`.
20. **No verdict state holds a run without a bound** (from the Task 11 review). `VerdictState` gains `since?: string`, the time the verdict entered `testing`. After `VERDICT_TESTING_WAIT_MS` (300,000) in `testing`, the verdict goes on with the receipts that exist; a host criterion without one composes as `no-receipt`. A no-change verdict waits in `testing` for its parent run's pass under the same bound. A read-only check that ends without a result on a run that is not stopped counts as an evaluator failure. `holdNoChange` holds only a valid no-change report: no task, and the head equal to the base.
21. **An unreadable record writes no ledger row** (from the Task 11 review). The row's schema needs a record version and a rubric version of at least 1, so a verdict with reason `record-unavailable` sets the run's assessment and adds its fixed event, and emits no row event. This replaces "emits the row event" in Task 11's decision "Every path ends in `done`" for that one path. The ledger therefore undercounts `record-unavailable` verdicts.
22. **What a restart finds** (from the Task 11 review). The host fences an operation that a restart interrupted and never replays it. A crash between the goal record's write and the run's save therefore leaves one `verdict.recorded` entry in the record for a verdict with no assessment on the run and no ledger row; the run is fenced, and nothing is written twice. The guard that looks for the entry before a write stays, as a defence. Task 11's comments and its seeded test say that the test's replay is harsher than the host. Task 12 adds a host test of this crash.

## Where the code and the design disagree

- **Hold point.** Part 5 says "when a cycle's run settles". Settled runs are never stepped, so the evaluator runs before settle (call 3).
- **Storage.** `GoalCycle.assessment` exists in no code; this slice adds it with counts only. `latest` has a `note` in the schema (`objective-types.ts` line 123); this slice never writes it (call 5). The record has no `objective_log` overflow, so verdict entries have a share (Sizes).
- **The goal digest.** Part 5's channel is unwired; the rows go into `TeamGoalContext` (call 13).
- **`until-met`.** Part 5 and acceptance 7 name a standing `until-met` goal. `goalStandingSchema` has only `shape: "objective"`. Acceptance 7's `until-met` half waits; its finite-goal analogue is tested here.
- **The owner override.** Part 5's correction direction does not reach a run's objective (call 12). The outcome route admits controllers and the relay (`server.ts` line 1286, `remote-access.ts` line 49).
- **Receipts.** Step 4 makes no receipt for `receipt`-kind criteria. This slice reads `checks-passed` and `review-approved` from the run; `merged` and `landed` are `inconclusive` (call 8). `citations` and `citation-form` criteria have no receipt until step 7.
- **Owner criteria.** `rating.record` stamps the goal's latest reviewed cycle, which is the previous cycle at the next verdict. So an owner criterion is `pending-owner` at every verdict except a no-change cycle on the rated head. This is part 5's rule 3 as written.
- **Acceptance 10's label.** It writes `citation-form:research/founders/shortlist.json`. `checkLabel` (`objective-digest.ts` line 14) is the label the record digest prints, and the rows reuse it, so the label reads as `checkLabel` prints it. The test pins `checkLabel`'s output, not acceptance 10's spelling.
- **Acceptance 11** holds under part 5's rule as written: the second profile fails the hard rule by model, so the reviewer's profile is the only eligible one. A third evaluator profile of a family that neither authored nor reviewed would be preferred over the reviewer's (rule 2); Task 2 tests both.

## Trust boundary, and what a review checks

These inputs originate outside the host:

- **The evaluator.** Its report arrives through the report tool. It passes these checks:
  - At the report route: the strict envelope and `verdictReportSchema` (Task 1). A report of another kind becomes fixed text at `screen`, and the evaluator counts as failed.
  - At consume: the member is the current evaluator of the current revision and the held state; `assertMemberReadOnly` on its working copy (the operation's read-only check, as the intent check runs it).
  - At composition (Task 6): unknown criterion ids are dropped and counted; every handle is checked by form and membership; notes are kept only as sealed bytes.

  Evaluator text (notes and handles) lands only in `Stored.verdict`. It never reaches a prompt, a context file of another member, an event, a log line, an error body, a view, a plain column, or the record's log.
- **Repositories.** The evaluator reads the head in its own read-only working copy, as every member does. The host reads nothing from the repository for a verdict; receipts come from the register, which reads through form B1.
- **Members.** Member reports, briefs, findings, and blackboard entries never reach the evaluator's context (Task 7's builder takes none of them).
- **The owner.** `verdictId` is a UUID that must name a cycle assessment of the goal. `continue` carries the outcome's `summary`, which is screened as steering is today, and passes the steering limits.
- **Other device roles.** Viewers read `GET /api/goals/:id/verdicts`. The relay refuses that path, because its goal pattern (`remote-access.ts` line 49) has no `verdicts` branch. Through views, every device sees `run.verdicts`, `run.assessment`, `GoalCycle.assessment`, and an outcome's `verdictId`: ids, enumerations, and counts only.

What can reach prompt and context text:

- **The evaluator's context:** the record's statement, definitions, rules, non-goals, and active criteria; the head and base; the run's changed paths; the final check round's names and statuses; the receipts' handles, kinds, ids, and outcomes; and the rubric items. All of it is owner text, host facts, or step 4's receipts.
- **The evaluator's prompt:** fixed text.
- **The coordinator's prompt:** the criteria rows (criterion id, status, check label), labelled an agent assessment. No note, score, threshold, count, model, or profile.
- **Nothing else.** No verdict row, agreement, evaluator identity, note, or handle reaches any member. `team-prompts.ts` imports nothing from `verdict-store.ts` (Task 10 test).

## Sizes, cost, and sequences

**Sizes.**

- **The report.** At most 8 criteria, each with at most 8 handles of at most 400 characters and a note of at most 500 bytes. About 30 KiB at most.
- **The context.** At most 1 MiB (`VERDICT_CONTEXT_BYTES`). Over that, the verdict is `inconclusive` with `context-too-large`.
- **The prompt.** At most 8 KiB (`VERDICT_PROMPT_BYTES`), fixed.
- **`Stored.verdict`.** One verdict: the report (30 KiB at most) and the composed criteria (about 6 KiB at most).
- **`run.assessment` and `GoalCycle.assessment`.** About 500 bytes each. A standing goal keeps 50 cycles, so at most about 25 KiB on its sealed record.
- **The criteria rows.** At most 8 rows of at most 200 bytes.
- **Log entries.** `verdict.recorded`: `before` and `after` each hold at most 8 `latest` values of about 70 bytes, inline. `evaluator-contradicted-receipt`: about 150 bytes. Verdict entries write only while the log stays under 300 entries and 160 KiB; otherwise the verdict stands everywhere else and the record write is skipped (`log-full`).
- **A row.** About 300 bytes.

**Cost.**

- **Verdicts off.** `createRun` reads one more setting. Each hook makes one call that returns at once on a run without `run.verdicts`. The goal's refresh reads one absent field.
- **Verdicts on.** Per reviewed revision: one register pass (step 4's cost), one evaluator member, two record parses, one record write, one run save per state change, and one event. Per goal refresh: a scan of at most 50 cycles in memory for the previous assessment.
- **Held runs.** While a verdict holds a run, each tick makes one `reviewed` or `step` call for it, which reads memory only; the hook comes before line 2594's Git check, so a held tick runs no command. A hold lasts at most the register pass (120 seconds of reads) plus two evaluator attempts under the member stall rule.
- **Scale.** No list route, view, or periodic tick reads the store, a journal, or a sealed file per member, session, run, task, or criterion. `GET /api/goals/:id/verdicts` reads in-memory run records for at most 50 cycles. 1,000 sessions and 10,000 outcome rows change nothing.

The slice must survive these sequences. Each has a named test.

| Sequence | Expected | Test |
|---|---|---|
| No key; `evaluator: "off"`; evaluator on with the register off; a mission subteam or handoff run; a run created before this slice, after a restart | No evaluator, no `Stored.verdict`, no `run.verdicts`, no `run.assessment`, no `cycle.assessment`, no criteria rows; prompts, context files, events, views, and the prompt version as today | Task 12 `without verdicts a run is as today`; Task 2 `the verdict pin needs both keys and a plain run`; Task 10 `without criteria rows the prompts are byte for byte`; Task 13 `without verdicts a goal is as today` |
| The key written, then a routine's next check | The routine blocks; without the key it keeps its authority | Task 1 `the evaluator setting is inside the routine approval digest` |
| Acceptance 6 | Every criterion `met` by the evaluator while `rank-verify` failed: composed `not-met`, `evaluator-contradicted-receipt` in the log | Task 6 `acceptance 6: a failing receipt overrides the evaluator`; Task 12 `acceptance 6 end to end` |
| Acceptance 7, finite half | A composed `met` stops an autonomous finite goal as `ready-for-review` with `provisional-met`, never `achieved`; `not-achieved` with `continue` starts the next cycle on a new record version | Task 13 `acceptance 7: a provisional met stops the goal and continue resumes it` |
| A standing goal: `met`; three verdicts with no progress | `met` recorded and the next cycle at its cadence; the third failed cycle pauses with `repeated-failures`; an owner resume resets the count | Task 13 `a standing goal records met and counts verdict failures` |
| Acceptance 10 | Cycle 2's project manager prompt lists `c2` `not-met` with its check label, labelled an agent assessment, with no note, threshold, count, or profile; no other role's prompt holds a row | Task 10 `criteria rows reach only the coordinator`; Task 13 `acceptance 10 end to end` |
| Acceptance 11 | The reviewer's profile evaluates; the row has `also_reviewed` 1 and `shared_family` 0; the profile of the implementer's model is never chosen | Task 2 `the evaluator rule excludes authors by model and prefers independence`; Task 12 `acceptance 11 end to end` |
| No eligible profile; every eligible provider limited | `inconclusive` with `no-independent-evaluator` or `evaluator-unavailable`; no member started; the run proceeds | Task 11 `a verdict without an evaluator is inconclusive and releases the run` |
| The evaluator stalls, hits a limit, or exits without a report, once and then again | One replacement by the same rule; then `inconclusive` with `evaluator-unavailable`; the run proceeds | Task 11 `one replacement, then evaluator-unavailable`; Task 12 `a stalled evaluator is replaced once` |
| The evaluator sends another report kind, or unknown ids, or unresolved handles | Fixed text and a failure; unknown ids dropped and counted; unresolved states `inconclusive` | Task 11 `a wrong report kind is a failure, never text`; Task 6 `handles resolve by form and membership` |
| The fuse refuses the evaluator's launch | The verdict waits with the fuse; nothing is skipped | Task 12 `an open fuse holds the verdict` |
| A pause, steer, or resume (a new revision) while the evaluator runs | The old verdict writes nothing; the new revision is reviewed and held again | Task 11 `a verdict never outlives its revision` |
| A restart in each state | Each verdict composes once; one `verdict.recorded` per verdict | Task 11 `seeded verdicts with restarts compose each verdict once` |
| An unreadable record, a full log, a goal record write that fails | The verdict composes from what it has (`record-unavailable` gives `inconclusive` for every criterion); the record write is skipped with one event; the run proceeds | Task 11 `record failures never hold the run` |
| A pinned file changed in the cycle | That criterion cannot be `met`; it is `inconclusive` (`pinned-changed`) | Task 6 `a changed pinned file voids met` |
| An owner value on the head, on an older head, or none | `met` or `not-met` by the threshold; else `pending-owner`, which never blocks `met` | Task 6 `owner criteria read only a rating on the head` |
| Evaluator text where it must not be | No note or handle in a view, an event, a later member's context, the blackboard, a log entry, or a row | Task 12 `evaluator text stays sealed`; Task 5 `rows hold no text` |
| `verdictId` naming no assessment; `continue` on a goal not stopped by `provisional-met`, with `achieved`, past the deadline, or at the steering limit | 409 `verdict-not-found`, `goal-not-provisional`, 400 from the schema, `goal-limit-reached`, `goal-steering-limit`; nothing written | Task 9 `the outcome rules refuse a wrong verdict answer`; Task 13 `continue is refused outside a provisional stop` |
| `GET /api/goals/:id/verdicts` from the relay | Refused by the relay | Task 14 `the relay refuses the verdicts read` |
| Random verdict writes, register writes, owner ops, and intent applies, with a reload between steps | Every version rebuilds and parses | Task 11 `every version rebuilds after random verdict writes` |
| A rollback to a host without this slice | See the right column | No test. `docs/teams.md` lists the steps (Task 16). The old strict schema refuses a config with `objective.evaluator`, so remove the key first. A pending goal launch whose context holds `criteria` fails the old strict `teamGoalContextSchema` and blocks that goal. A record with verdict entries parses (`OP_RE` accepts both op names), but versions before them answer 409 `objective-version-unavailable`; the latest version still reads. An old host ignores `run.verdicts`, `run.assessment`, `Stored.verdict`, `cycle.assessment`, and `verdictId`. A run with a live `evaluator` member fails the old role schema; finish or cancel such runs before a rollback. An old host reads `stopReason: "provisional-met"` as a value it does not know, so record the owner's outcome on every goal stopped that way before a rollback. |

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/verdict-types.ts` (create) | Pure: the report schema and its limits, the run summary, the criteria row, the composed states, and the reason codes; imports zod and `objective-types.ts` only |
| `packages/host/src/team-types.ts` (modify) | The setting, `TeamRun.verdicts`, `TeamRun.assessment`, the report variant, the role, and the goal context's `criteria` |
| `packages/host/src/evaluator-profiles.ts` (modify) | The evaluator rule, the pin, and `evaluatorOverlaps` |
| `packages/host/src/objective-record.ts` (modify) | The two verdict op names and their undo |
| `packages/host/src/team-register.ts` (modify) | `markReviewed` and `reviewedReceipts` |
| `packages/host/src/verdict-store.ts` (create), `server.ts` (modify, in place) | The `objective_verdicts` module, its projector, and its sweep |
| `packages/host/src/verdict-compose.ts` (create) | Pure: handle resolution, the composition rules, the result, counts, and the record write |
| `packages/host/src/verdict-prompt.ts` (create) | Pure: the evaluator's fixed prompt, its context, and the criteria rows' prompt text |
| `packages/host/src/manager.ts`, `worker.ts`, `team-mcp-results.ts`, `fuse/baseline.ts`, `github-grants.ts`, `team-watch.ts`, `evidence/host-entries.ts`, `apps/web/src/teams.tsx`, `apps/mobile/src/features/teams/model.ts` (modify) | The role in every role list; no grant; no blackboard report |
| `packages/host/src/goal-types.ts` (modify), `goal-verdicts.ts` (create) | `GoalCycle.assessment`, `stopReason`, the outcome's `verdictId` and `continue`; the pure goal rules |
| `packages/host/src/team-prompts.ts`, `objective-digest.ts`, `config-identity.ts` (modify) | The rows in the coordinator's prompt and nowhere else; the prompt shapes; the evaluator's prompt version |
| `packages/host/src/team-verdicts.ts` (create) | The runtime: the hold, the states, the hooks, the events |
| `packages/host/src/teams.ts` (modify, in place) | Seventeen hooks, each in an existing line (Task 12) |
| `packages/host/src/goals.ts` (modify, in place) | Twelve hooks, each in an existing line (Task 13) |
| `packages/host/src/verdict-view.ts` (create), `objective-routes.ts`, `objective-cli.ts` (modify) | `GET /api/goals/:id/verdicts` and `infinite goal verdicts` |
| `apps/web/src/api.ts`, `apps/web/src/goals.tsx`, `apps/mobile/src/api/client.ts`, `apps/mobile/src/features/teams/GoalDetail.tsx` (modify) | The verdict on the goal page and the phone's goal screen; the continue action |
| `tests/fixtures/team-agent.mjs`, `tests/fixtures/goal-agent.mjs` (modify) | The fake evaluator |
| `docs/teams.md`, the spec (modify) | The setting, the role, the rules, the rollback steps, and the amendments |
| `tests/{verdict-schemas,verdict-store,verdict-compose,verdict-prompt,goal-verdicts,team-verdicts,verdict-rebuild,verdict-host,verdict-goals,verdict-routes}.test.ts` (create); `tests/{routines,evaluator-profiles,objective-record,team-register,fuse-baseline,github-grants,team-watch,host-entries,team-prompts,objective-digest,config-identity,autonomy-pins,objective-cli,remote-access}.test.ts` (modify) | Pure rules, the runtime with a fake host, and the host with the fake agents |

**Touch points in baseline files.** Every baseline file below is at its baseline today, so every hook changes an existing line in place and adds none.

- **`teams.ts`** (3,578, baseline 3,578). Only Task 12 writes it: lines 62, 189, 244, 370, 551, 1223, 2483, 2567, 2593, 2737, 2777, 2826, 2882, 2891, 2980, 3058, and 3073.
- **`goals.ts`** (1,042, baseline 1,042). Only Task 13 writes it: lines 8, 21, 571, 578, 579, 581, 582, 612, 795, 796, 871, and 977.
- **`server.ts`** (2,285, baseline 2,285). Only Task 5 writes it: lines 43, 262, and 405.
- **`manager.ts`** (1,244, baseline 1,244) and **`worker.ts`** (1,903, baseline 1,903). Only Task 8 writes them: `manager.ts` lines 604 and 742, `worker.ts` lines 1127 and 1384, each a role list on one line.
- **Not touched:** `client.ts`, `team-cli.ts`, `missions.ts`, `outcome-store.ts`, `evidence/store.ts`, `tests/teams.test.ts`, and `tests/goals.test.ts`.

**Other files near the limit.** `team-types.ts` is 929 lines and grows by at most 10 (Task 1). `team-prompts.ts` is 951 and grows by at most 8 (Task 10). New files stay under 1,000 lines; the largest, `team-verdicts.ts`, is expected near 420.

**Order and owners.**

- **First wave, in parallel:** Task 1, Task 2, Task 3, Task 4, and Task 5. No two share a file.
- **Second wave, in parallel:** Task 6 (needs 1 and 3), Task 7 (needs 1), Task 8 (needs 1), Task 9 (needs 1), and Task 15 (needs 1 and 9's types; it may start with Task 9 from this plan's fixed shapes).
- **Third wave, in parallel:** Task 10 (needs 1 and 7) and Task 11 (needs 1, 2, 3, 4, 6, and 7).
- **Then:** Task 12 (needs 5, 8, 10, and 11).
- **Then, in parallel:** Task 13 (needs 9 and 12) and Task 14 (needs 9 and 12).
- **Last:** Task 16.

If the coordinator caps implementers at four at once, the first wave runs Tasks 1, 2, 3, and 4, then Task 5 with the second wave.

**One writer per file.** No file has two writers in this slice. Every name, signature, limit, status code, entry shape, event text, and test name below is fixed, so the workers of one wave never need to talk.

**Checks.**

- `check:size` holds after every task. Each task confirms its counts with `wc -l`.
- The host typecheck does not cover `tests/`, so each task runs its test files. A task reports any cancelled test as a failure.
- Focused command for every task: `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/FILE.test.ts`. No task runs the full suite.

**Workers.**

- Every worker in a worktree is told never to use `git stash`. It compares with `git show HEAD:<path>` and sets work aside with a WIP commit.
- Workers run test batches that start a host in the background, so a steer can reach them.

**Lessons from earlier waves.**

- **Large values.** A test checks `state` or a length before a `deepEqual` on a record, a report, or a context.
- **Ticks.** A host test whose assertion depends on a tick hook calls the service's `start()`.
- **Byte pins.** Tests that pin bytes from the base commit (Tasks 1, 10, and 12) re-pin from `main`'s own output when the build starts, because prompt bytes move whenever `main` changes a prompt.
- **Goal tests.** A test that runs goal cycles with a fake agent (Task 13) sets `objective.intentCheck: "off"` and writes the fake agent's plan-brief flag file.
- **Signals.** No test signals a child that already ended, runs a real launcher's stop, or runs a launcher as root.

## Review Focus

1. **The host inferring completion.** A verdict that sets `achieved`, a provisional stop on a supervised goal, or a `met` that hides a failing host receipt. Expect none.
   - Tests: Task 13 `acceptance 7: a provisional met stops the goal and continue resumes it` and `a supervised goal shows the verdict and changes nothing`; Task 6 `acceptance 6: a failing receipt overrides the evaluator`.
   - Lines whose deletion the tests must catch:
     - in `composeVerdict`, the host-producer branch that ignores the evaluator's state;
     - in `provisionalStop`, the `autonomyOf(goal) === "autonomous"` check and the `standing` check;
     - in `continueGoal`, the absence of any write to `goal.status = "achieved"`: the only `achieved` stays at `goals.ts` line 580.
2. **A model grading its own work.** An evaluator whose model authored integrated work in the run, or whose family is unknown or the coordinator's. Expect none.
   - Tests: Task 2 `the evaluator rule excludes authors by model and prefers independence`; Task 12 `acceptance 11 end to end`.
   - Lines: in `chooseEvaluator`, the `authorModels.has(model)` check and the `family === undefined` check.
3. **Evaluator text where it must not be.** A note or a handle in a view, an event, the blackboard, a later member's context or prompt, a log entry, or a row. Expect none.
   - Tests: Task 12 `evaluator text stays sealed`; Task 5 `rows hold no text`; Task 10 `criteria rows reach only the coordinator`.
   - Lines: in `screen`, the stub that replaces the member's report; in `memberReports` and `reportingMembers`, the `evaluator` exclusion; in `verdictLogEntries`, the `latest` values without `note`.
4. **Something on by default.** Expect today's bytes without the key.
   - Tests: Task 12 `without verdicts a run is as today`; Task 13 `without verdicts a goal is as today`; Task 10 `without criteria rows the prompts are byte for byte`; Task 1 `the evaluator setting is inside the routine approval digest`.
   - Lines: `verdictPin`'s `evaluator === "on" && register === "on"`; the `run.verdicts !== "on"` guards in `reviewed`, `holdNoChange`, and `step`; `cycleVerdict`'s `{}` when neither side has an assessment; `criteriaRowsFor`'s `{}`.
5. **A run held forever, or a verdict written twice.** A failure that never releases the hold; a verdict composed twice after a restart; an old revision's verdict applied to a new one. Expect one composition per verdict and a release on every path.
   - Tests: Task 11 `seeded verdicts with restarts compose each verdict once`, `a verdict never outlives its revision`, `one replacement, then evaluator-unavailable`, and `record failures never hold the run`.
   - Lines: in `complete`, the guard that the state is still this verdict's; in `step`, the revision check that discards the state; in `failure`, the move to `done` on the second failure.

### Task 1: the report, the setting, and the run fields

**Files:** `packages/host/src/verdict-types.ts` (create), `packages/host/src/team-types.ts` (at most +10), `tests/verdict-schemas.test.ts` (create), `tests/routines.test.ts`. Runs first.

**Interfaces (produces):**
```ts
// verdict-types.ts: imports zod and objective-types only.
export const VERDICT_LIMITS = { criteria: 8, handles: 8, handleChars: 400, noteBytes: 500, labelBytes: 120 } as const;
export type AssessedState = "met" | "not-met" | "inconclusive";
export type ComposedState = AssessedState | "pending-owner";
export const verdictReportSchema = z.object({
  kind: z.literal("verdict"),
  result: z.enum(["met", "not-met", "inconclusive"]),
  criteria: z.array(z.object({
    id: z.string().regex(ID_RE),                             // the record's id rule (objective-types.ts line 66)
    state: z.enum(["met", "not-met", "inconclusive"]),
    evidence: z.array(z.string().min(1).max(400)).max(8),
    note: z.string().optional(),                             // 1 to 500 UTF-8 bytes
  }).strict()).min(1).max(8),
}).strict().superRefine(/* unique ids; note bytes */);
export type VerdictReport = z.infer<typeof verdictReportSchema>;
/** Why a verdict has no evaluator answer. */
export type VerdictReason = "no-independent-evaluator" | "evaluator-unavailable" | "record-unavailable" | "context-too-large";
/** Why one criterion is inconclusive or waits. */
export type CriterionReason = "no-receipt" | "receipt-unknown" | "before-delivery" | "pinned-changed" | "unresolved-evidence" | "not-assessed" | "no-evaluator";
export type VerdictCounts = { met: number; notMet: number; inconclusive: number; pendingOwner: number };
/** The run's summary: ids, enumerations, and counts only. It reaches every team view and relay device. */
export type RunAssessment = {
  verdictId: string; revision: number; head: string; kind: "reviewed" | "no-change";
  result: AssessedState; evaluatorResult?: AssessedState; reason?: VerdictReason;
  counts: VerdictCounts; criteria: { id: string; state: ComposedState }[]; at: string;
};
export const runAssessmentSchema: z.ZodType<RunAssessment>;
export const criteriaRowSchema = z.object({
  criterion: z.string().regex(ID_RE),
  status: z.enum(["met", "not-met", "inconclusive", "pending-owner"]),
  check: z.string(),                                         // 1 to 120 UTF-8 bytes
}).strict();
export type CriteriaRow = z.infer<typeof criteriaRowSchema>;
export const criteriaRowsSchema = z.array(criteriaRowSchema).min(1).max(8);

// team-types.ts
// line 239, in place: objective gains evaluator: z.enum(["on", "off"]).optional()   — no default
// teamReportVariants, after intentCheckReportSchema (line 606): verdictReportSchema,
// TeamRole (line 620), in place: … | "intent-checker" | "evaluator"
// teamGoalContextSchema (line 524), as its last key: criteria: criteriaRowsSchema.optional()
// TeamRun, after register (line 777):
//   /** Pinned by createRun when the project's evaluator and register are on; absent otherwise and on runs created before verdicts existed. */
//   verdicts?: "on";
//   /** The current revision's verdict summary; absent until one is composed. */
//   assessment?: RunAssessment;
```

**Decisions:**

- **No default.** Without the key, every routine digest, prompt, context, and view is unchanged. Writing the key changes `RoutineService.authority`, because `digestedProjectTeam` strips only `eval`.
- **The role and the report.** `evaluator` reports only `verdict`, as `intent-checker` reports only `intent-check`.
- **The criteria rows.** They live in the goal context, beside `record`. They hold no note, threshold, score, count, model, or profile, by schema.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the verdict report is strict and bounded` (verdict-schemas) | **Accepted:** a report with 8 criteria, each with 8 handles of 400 characters and a 500-byte note. `teamReportSchema` accepts it. **Refused:** 9 criteria; 9 handles; a 401-character handle; a 501-byte note; two criteria with one id; an unknown key; state `"pending-owner"`; result `"achieved"`. |
| `the evaluator setting and the run fields stand alone` (verdict-schemas) | `{ evaluator: "on" }` and `{ evaluator: "off", register: "on" }` parse; `{ evaluator: "maybe" }` is refused. A goal context without `criteria` serializes equal to the string pinned from the base commit. A context with 9 rows, a 121-byte label, a row with a `note`, or an empty `criteria` array is refused. `runAssessmentSchema` refuses a key outside the type. |
| `the evaluator setting is inside the routine approval digest` (routines) | The pattern of step 2's test. A routine keeps its stored authority across a reload without the key. It blocks at its next check after the project gains `objective: { evaluator: "on" }`. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/verdict-schemas.test.ts tests/routines.test.ts tests/intent-schemas.test.ts tests/register-schemas.test.ts` and the host typecheck. Confirm with `wc -l` that `team-types.ts` is at most 939 lines.

### Task 2: the evaluator rule and the pin

**Files:** `packages/host/src/evaluator-profiles.ts`, `tests/evaluator-profiles.test.ts`. Runs first.

**Interfaces (produces):** pure.
```ts
export type EvaluatorChoice =
  | { profile: TeamModelProfile; family: string; sharedFamily: boolean; alsoReviewed: boolean }
  | { skipped: "no-independent-evaluator" | "evaluator-unavailable" };
/**
 * C14 rules 1 to 3 over evaluatorProfiles(lineup). `authors`: the profiles of implementer and integrator members whose work
 * integrated in the run. `reviewers`: the run's reviewer profiles. `excluded`: profile ids that already failed this verdict.
 */
export function chooseEvaluator(lineup: TeamLineup | undefined,
  cycle: { authors: readonly TeamModelProfile[]; reviewers: readonly TeamModelProfile[] },
  limited: ReadonlySet<Provider>, excluded?: ReadonlySet<string>): EvaluatorChoice;
/** True only for evaluator "on" with register "on", on a run that is neither a mission subteam nor a handoff run. */
export function verdictPin(input: { evaluator?: "on" | "off"; register?: "on" | "off"; mission: boolean; handoff: boolean }): boolean;
/** The ids of evaluator profiles whose model is also an implementer's or an escalation's (the lineup warning of part 5). */
export function evaluatorOverlaps(lineup: TeamLineup): string[];
```

**Decisions:**

- **A model** is `provider` and `model` together; a profile without `model` is its provider's default and matches only another profile without `model` on that provider.
- **Eligible** (the hard rule): `familyOf(profile)` is known and differs from `familyOf(lineup.coordinator)`, which must be known; and the profile's model is not an author's model.
- **Unavailable** is separate from ineligible. If eligible profiles exist but every one is on a `limited` provider or in `excluded`, the result is `evaluator-unavailable`. If none is eligible, it is `no-independent-evaluator`.
- **Preference** among the remaining, in lineup order: the first whose family neither authored nor reviewed; else the first whose family authored nothing; else the first.
- **Flags.** `sharedFamily`: the chosen family is an author's family. `alsoReviewed`: the chosen model is a reviewer's model.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the evaluator rule excludes authors by model and prefers independence` | **Acceptance 11's lineup.** Coordinator of family A; reviewer of family B; implementers of family C; `evaluators` lists the reviewer's profile, then a second profile of the implementer's model. With that implementer as an author and the reviewer as a reviewer, the choice is the reviewer's profile, with `sharedFamily` false and `alsoReviewed` true. The second profile is never chosen, even when listed first. **Preference.** With a third evaluator of family D that neither authored nor reviewed, D is chosen. |
| `an unknown family is never eligible` | An evaluator whose `familyOf` is undefined is skipped. An unknown coordinator family gives `no-independent-evaluator`. A lineup without evaluators and without a strong reviewer gives `no-independent-evaluator`. |
| `limits and failures make the evaluator unavailable, not ineligible` | One eligible profile on a limited provider gives `evaluator-unavailable`; in `excluded` too; with a second eligible profile, the second is chosen. |
| `the verdict pin needs both keys and a plain run` | `verdictPin` is true only for `{ evaluator: "on", register: "on", mission: false, handoff: false }`. It is false for each of: evaluator absent or `"off"`, register absent or `"off"`, a mission subteam, a handoff run. |
| `evaluator overlaps name shared models` | Acceptance 11's lineup gives the second profile's id only. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/evaluator-profiles.test.ts` and the host typecheck.

### Task 3: the verdict ops in the record log

**Files:** `packages/host/src/objective-record.ts`, `tests/objective-record.test.ts`. Runs first.

**Interfaces (produces):**
```ts
export const VERDICT_OPS = { recorded: "verdict.recorded", contradicted: "evaluator-contradicted-receipt" } as const;
// verdict.recorded: actor "host", authority "receipt", target "c0", handle `verdict:<verdictId>`,
//   before: { inline: { latest: Record<criterionId, { state: ComposedState; verdictId: string } | null> } },
//   after:  { inline: { latest: Record<criterionId, { state: ComposedState; verdictId: string }>; result: AssessedState; kind: "reviewed" | "no-change"; revision: number; head: string } }
// evaluator-contradicted-receipt: actor "host", authority "receipt", target the criterion id, handle `verdict:<verdictId>`,
//   after: { inline: { evaluator: "met" | "not-met"; receipt: "met" | "not-met"; handle?: string } }   // handle: the receipt's, when there is one
// rebuildVersion: verdict.recorded sets each named criterion's `latest` to before.inline.latest[id] (removed when null);
//   evaluator-contradicted-receipt changes nothing.
```

**Decisions:** both op names pass `OP_RE`. Every value is inline: 8 `latest` values of about 70 bytes fit 2 KiB, and no note is logged.

- [ ] **Step 1: Write the failing test.**

| Test name | Assertions |
|---|---|
| `verdict ops rebuild their latest states` | A record at version v gets a `verdict.recorded` entry and a contradicted entry at v + 1, changing `latest` on c0 and c1. `rebuildVersion(record, v)` gives c0 and c1 without `latest`; after a second verdict at v + 2, `rebuildVersion(record, v + 1)` gives the first verdict's `latest`. An entry with an unknown op still answers `objective-version-unavailable`. |

- [ ] **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/objective-record.test.ts tests/register-rebuild.test.ts` and the host typecheck.

### Task 4: the register's reviewed pass at the hold

**Files:** `packages/host/src/team-register.ts`, `tests/team-register.test.ts`. Runs first.

**Interfaces (produces):**
```ts
// TeamRegister gains:
/** At the verdict's hold: marks a reviewed pass for the run's current revision when the reviewed-head rule holds, whatever the
 *  run's status. True when such a pass exists after the call. Saves through host.save when it marks. Never throws. */
markReviewed(holder: RegisterHolder): boolean;
/** The receipts of the run's latest pass when it is a reviewed pass at `head`: "pending" while it runs; undefined otherwise. */
reviewedReceipts(runId: string, head: string): readonly ObjectiveReceipt[] | "pending" | undefined;
```

**Decisions:** `mark` is unchanged. A later `mark` at `ready-for-review` or `merged` finds the reviewed pass of the same revision and adds none, by the existing replacement rule.

- [ ] **Step 1: Write the failing test.**

| Test name | Assertions |
|---|---|
| `a verdict's reviewed pass is the run's only pass` | On a pinned run at `reviewing` with the reviewed-head rule, `markReviewed` returns true and saves one pending pass. `reviewedReceipts` gives `"pending"`; after `drain` and the apply, it gives the receipts. A later `mark` at `ready-for-review` adds no pass. A wrong head gives undefined. An unpinned run, or one without the rule, gives false and no pass. |

- [ ] **Step 2: Run and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/team-register.test.ts` and the host typecheck.

### Task 5: the verdict ledger

**Files:** `packages/host/src/verdict-store.ts` (create), `packages/host/src/server.ts` (lines 43, 262, and 405, in place), `tests/verdict-store.test.ts` (create). Runs first.

**Interfaces (produces):**
```ts
export const VERDICTS_MODULE = "objective_verdicts";
export const VERDICT_RETENTION_DAYS = 730;
export const verdictEventDataSchema = z.strictObject({
  verdictId: z.uuid(), goalId: z.uuid().optional(), cycle: z.number().int().min(1).optional(),
  kind: z.enum(["reviewed", "no-change"]), recordVersion: z.number().int().min(1), rubricVersion: z.number().int().min(1),
  profileId: z.string().regex(ID_RE).optional(), provider: z.enum(["claude", "codex", "opencode"]).optional(),
  model: z.string().max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).optional(), family: z.string().regex(ID_RE).optional(),   // the lineup's id rules (team-types.ts line 252)
  sharedFamily: z.boolean(), alsoReviewed: z.boolean(),
  result: z.enum(["met", "not-met", "inconclusive"]), evaluatorResult: z.enum(["met", "not-met", "inconclusive"]).optional(),
  reason: z.enum(["no-independent-evaluator", "evaluator-unavailable", "record-unavailable", "context-too-large"]).optional(),
  met: count, notMet: count, inconclusive: count, pendingOwner: count,           // count: z.number().int().min(0).max(8)
});
export type VerdictEventData = z.infer<typeof verdictEventDataSchema>;
/** The pattern of outcomeModule: one table, two blind indexes, a deleteRun hook that stamps and never removes. */
export function verdictModule(options?: { now?: () => string }): EvidenceModule;
/** Projects run events of kind "verdict.recorded" into one row each; a repeated verdictId writes nothing. */
export function verdictProjector(store: EvidenceStore): EventProjector;
/** Registers the module, then its projector. */
export function registerVerdicts(store: EvidenceStore, outbox: EventOutbox): void;
/** Deletes rows whose `at` is more than VERDICT_RETENTION_DAYS before `now`, at most `limit` (default 100) per call. */
export function sweepExpiredVerdicts(store: EvidenceStore, now: string, limit?: number): number;
```

The table:
```sql
CREATE TABLE objective_verdicts (
  verdict_id TEXT PRIMARY KEY, project_ref BLOB NOT NULL, goal_ref BLOB, run_id TEXT NOT NULL, cycle INTEGER,
  revision INTEGER NOT NULL, kind TEXT NOT NULL, record_version INTEGER NOT NULL, rubric_version INTEGER NOT NULL,
  profile_id TEXT, provider TEXT, model TEXT, family TEXT, shared_family INTEGER NOT NULL, also_reviewed INTEGER NOT NULL,
  result TEXT NOT NULL, evaluator_result TEXT, reason TEXT,
  met INTEGER NOT NULL, not_met INTEGER NOT NULL, inconclusive INTEGER NOT NULL, pending_owner INTEGER NOT NULL,
  at TEXT NOT NULL, run_deleted_at TEXT);
CREATE INDEX objective_verdicts_project ON objective_verdicts (project_ref, at);
CREATE INDEX objective_verdicts_goal ON objective_verdicts (goal_ref, at);
```

```ts
// server.ts, in place (find each by its code):
// 43:  import { EXCLUSION_REASONS, … } from "./outcome-store.js"; import { registerVerdicts, sweepExpiredVerdicts } from "./verdict-store.js";
// 262: evidence.register(outcomeModule()); registerVerdicts(evidence, outbox);
// 405: sweepExpiredOutcomes(evidence, new Date().toISOString(), undefined, config.teams?.outcomes?.retentionDays); sweepExpiredVerdicts(evidence, new Date().toISOString());
```

**Decisions:**

- **No text.** Every column is an id, an enumeration, a number, a flag, or a time. `project_ref` and `goal_ref` are `tx.index("project", …)` and `tx.index("goal", …)`. A profile id, provider, and model are configuration ids, as the outcome rows hold them.
- **No agreement column.** The owner's answer stays in the sealed goal record (call 14).
- **Rows outlive their run** until the retention sweep, as outcome rows do. They are written only when the outcome ledger's events are on (`options.events`), because the row is projected from a run event.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `a verdict event projects one row` | A `verdict.recorded` event with valid data writes one row with every column as given and the two blind indexes. The same event again writes nothing. An event whose data fails `verdictEventDataSchema` writes no row and does not block later events. |
| `rows hold no text` | Every column's SQLite type is INTEGER, BLOB, or TEXT holding an id, an enumeration, or an ISO time: the test lists the table's columns from `PRAGMA table_info` and checks each TEXT column against its enumeration or id pattern. A data object with a `note` or `summary` key is refused by the schema. |
| `rows outlive their run and expire after 730 days` | `deleteRun` stamps `run_deleted_at` and removes nothing. `sweepExpiredVerdicts` at 731 days removes at most 100 rows per call and keeps a row of 729 days. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/verdict-store.test.ts tests/outcome-store.test.ts` and the host typecheck. Confirm with `wc -l` that `server.ts` is 2,285 lines.

### Task 6: composition

**Files:** `packages/host/src/verdict-compose.ts` (create), `tests/verdict-compose.test.ts` (create). Needs Tasks 1 and 3.

**Interfaces (produces):** pure.
```ts
export type ComposeInput = {
  record: ObjectiveRecord; head: string; kind: "reviewed" | "no-change"; configured: readonly TeamCommand[];
  /** Step 4's receipts at `head`; undefined when no pass ran there. */
  receipts?: readonly ObjectiveReceipt[];
  /** Host facts at `head`; undefined when the host cannot tell. */
  facts: { checksPassed?: boolean; reviewApproved?: boolean };
  changedPaths: { paths: readonly string[]; truncated: boolean };
  /** The evaluator's screened report; absent when no evaluator answered, with `reason`. */
  report?: VerdictReport; reason?: VerdictReason;
};
export type ComposedCriterion = {
  id: string; producer: "host" | "evaluator" | "owner"; state: ComposedState; reason?: CriterionReason;
  evaluatorState?: AssessedState; receipt?: { handle: string; outcome: ReceiptOutcome };
  handles: string[]; note?: string; contradicted?: true;
};
export type ComposedVerdict = {
  result: AssessedState; evaluatorResult?: AssessedState; reason?: VerdictReason;
  criteria: ComposedCriterion[]; counts: VerdictCounts; dropped: { unknownIds: number; handles: number };
};
/** Form and membership only (call 7). */
export function resolveHandle(handle: string, input: Pick<ComposeInput, "receipts" | "changedPaths" | "record">): boolean;
export function composeVerdict(input: ComposeInput): ComposedVerdict;
/** `latest` on every active criterion and the log entries, sealed at one version with sealRecord; "log-full" when the entries
 *  would pass 300 log entries or 160 KiB. Never writes a note. */
export function verdictRecord(record: ObjectiveRecord, verdict: ComposedVerdict,
  meta: { verdictId: string; kind: "reviewed" | "no-change"; revision: number; head: string; at: string }): ObjectiveRecord | "log-full";
```

**Decisions: the composition rule.** Each active criterion of the record, in record order, gets one state:

| Producer and check | Reads | State |
|---|---|---|
| host, `command` or `artifact` | the receipt with `subject: "criterion"`, its id, and `commit === head` | `pass` gives `met`; `fail` gives `not-met`; `unknown` gives `inconclusive` (`receipt-unknown`); none gives `inconclusive` (`no-receipt`) |
| host, `receipt` `checks-passed` or `review-approved` | `facts` | true gives `met`; false gives `not-met`; undefined gives `inconclusive` (`no-receipt`) |
| host, `receipt` `merged` or `landed` | nothing | `inconclusive` (`before-delivery`) |
| host, `citations` or `citation-form` | nothing | `inconclusive` (`no-receipt`); step 7 adds the check |
| evaluator, `judgement` | the report's entry for the id | its state when every handle resolves and a `met` has at least one; else `inconclusive` (`unresolved-evidence`); no entry gives `inconclusive` (`not-assessed`); no report gives `inconclusive` (`no-evaluator`) |
| owner, `owner-rating` | the newest `rating.recorded` log entry whose `after.inline.subject` is the check's subject and whose `after.inline.commit` is `head` | score at least the threshold's `min` gives `met`, else `not-met`; no such entry gives `pending-owner` |

Then, in order:

1. **Pinned files.** A criterion with `pinned` whose path is in `changedPaths.paths`, or any `pinned` criterion when `changedPaths.truncated`, cannot be `met`: `met` becomes `inconclusive` (`pinned-changed`).
2. **Contradiction.** A host criterion whose state is `met` or `not-met`, where the report gives the opposite state for it, gets `contradicted: true`. The host state stands. An evaluator `inconclusive` is no contradiction.
3. **The result.** `not-met` when any criterion is `not-met`, whatever its producer, owner criteria included. Else `inconclusive` when any criterion is `inconclusive`. Else `met`. `pending-owner` never blocks `met`.
4. **Kept from the report:** `evaluatorResult` is the report's own `result`. Unknown and retired ids are dropped and counted. Handles that do not resolve are dropped and counted. Notes are kept on the criterion, as sealed text.

`c0` is always an evaluator criterion, so every result holds an agent judgement and carries the agent assessment label. When the record is unreadable, there is nothing to compose: the runtime records `inconclusive` with `record-unavailable`, no criteria, and zero counts (Task 11).

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `acceptance 6: a failing receipt overrides the evaluator` | Part 9's record. The report gives every criterion `met` with resolved handles; c4's receipt is `fail`. c4 is `not-met` with `contradicted: true`; the result is `not-met`; `evaluatorResult` is `met`. `verdictRecord` writes one `verdict.recorded` entry and one `evaluator-contradicted-receipt` entry targeting c4. |
| `the result follows the composition rules` | Table-driven, one row per line of the rule table and per rule 1 to 3. Includes: every state `met` with one `pending-owner` gives `met`; one owner `not-met` gives `not-met`; one `inconclusive` and no `not-met` gives `inconclusive`; no report gives `inconclusive` with every evaluator criterion `no-evaluator` and host criteria still composed. |
| `handles resolve by form and membership` | **Resolve:** a receipt handle in `receipts`; `file:src/a.ts` and `file:src/a.ts#L1-L9` with `src/a.ts` in the changed paths; `file:research/x.json` when a criterion's artifact check names it. **Do not resolve:** `file:../a`, `file:/abs`, a path in neither set, a receipt handle of another run, `citation:…`, and a 401-character string. A `met` with no handle becomes `inconclusive` (`unresolved-evidence`); a `not-met` with one bad handle becomes `inconclusive` too. |
| `a changed pinned file voids met` | c4 pinned on `research/founders/rank-verify.mjs`: with that path changed, c4 `met` becomes `inconclusive` (`pinned-changed`); with `truncated: true` and no listed change, the same; without a change, `met`. |
| `owner criteria read only a rating on the head` | c5 with threshold 4 of 5: a rating of 4.5 on `head` gives `met`; 3.5 on `head` gives `not-met`; 5 on an older commit gives `pending-owner`; no rating gives `pending-owner`. |
| `the record write holds latest without notes and fits one entry` | 8 active criteria with 500-byte notes: the `verdict.recorded` entry's `before` and `after` are each inline and at most 2,048 bytes; no `latest` holds `note`; the version is one up. At 299 log entries, a write with two entries gives `"log-full"`. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/verdict-compose.test.ts` and the host typecheck.

### Task 7: the evaluator's prompt and context

**Files:** `packages/host/src/verdict-prompt.ts` (create), `tests/verdict-prompt.test.ts` (create). Needs Task 1.

**Interfaces (produces):** pure.
```ts
export const VERDICT_PROMPT_BYTES = 8 * 1024;
export const VERDICT_CONTEXT_BYTES = 1024 * 1024;
/** Rubric version 1: the items a judgement criterion may name. */
export const RUBRIC_V1 = ["owner-text", "method-applied"] as const;
/** Fixed text only: it takes no run, so no run data can reach it. */
export function evaluatorPrompt(provider: Provider, profile?: TeamModelProfile): string;
export type VerdictContext = {
  kind: "verdict-context"; verdictKind: "reviewed" | "no-change"; head: string; base: string;
  record: { objective: string; directions: string[]; definitions: { term: string; meaning: string }[]; rules: string[]; nonGoals: string[];
    criteria: { id: string; statement: string; check: Check; producer: "host" | "evaluator" | "owner"; threshold: Threshold }[] };
  rubric: { version: number; items: readonly string[] };
  changedPaths: { paths: string[]; truncated: boolean };
  checks: { name: string; status: string }[];                                   // the final check round at the head
  receipts: { handle: string; kind: string; id: string; outcome: ReceiptOutcome }[];   // criterion receipts at the head only
};
/** Undefined when the JSON is over VERDICT_CONTEXT_BYTES. Active criteria only; c0's statement is resolved from statementOf. */
export function verdictContext(input: { run: TeamRun; record: ObjectiveRecord; head: string; kind: "reviewed" | "no-change";
  receipts?: readonly ObjectiveReceipt[] }): VerdictContext | undefined;
/** The coordinator's lines for the rows, led by "Agent assessment, provisional, of the previous cycle:". */
export function criteriaRowsText(rows: readonly CriteriaRow[]): string;
```

**Decisions:**

- **The prompt** reuses `readOnlyWorkspaceInstructions`, `contextAccessInstructions`, `reportingInstructions`, and the Codex sandbox text, as `intentCheckerPrompt` does. It tells the evaluator to judge each criterion from the context and the head only, gives the three states, the handle forms (`receipt:…` from the context, `file:PATH` or `file:PATH#Lfrom-Lto`), the limits, and that a `met` needs a handle. It names no member, report, or earlier verdict.
- **The context** holds owner text and host facts only. It holds no assumption, question, proposal, log entry, `latest`, member report, brief, finding, goal digest, earlier verdict, owner assessment, rubric score, task rating, usage figure, routing data, ledger row, or evaluator identity (part 5).
- **Rubric items.** A judgement criterion names one of the two items; the prompt states what each means. A project adds items in a later slice with the rubric version (C15 class B).

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the evaluator prompt is fixed and bounded` | At most 8,192 bytes for each provider. The bytes are equal for two runs with different objectives. It names `verdict`, the three states, both handle forms, and the limits from `VERDICT_LIMITS`. |
| `the verdict context holds owner text and host facts only` | A run and record planted with distinct marker strings in an assumption, a question, a log entry, a criterion's `latest`, a member report, a brief, a finding, and a previous assessment. None of the markers appears in the context's JSON. The criteria are the active ones, with c0's statement resolved. Receipts hold criterion receipts at `head` only. |
| `an oversized context is undefined` | A run with changed paths that push the JSON over 1 MiB gives undefined. |
| `criteria rows print labelled an agent assessment` | Two rows print as one lead line and one line per row: id, status, and check label. The text holds no note, threshold, or count. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/verdict-prompt.test.ts` and the host typecheck.

### Task 8: the role in every role list

**Files:** `packages/host/src/manager.ts` (lines 604 and 742, in place), `packages/host/src/worker.ts` (lines 1127 and 1384, in place), `packages/host/src/team-mcp-results.ts` (line 53), `packages/host/src/fuse/baseline.ts` (line 13), `packages/host/src/github-grants.ts` (line 157), `packages/host/src/team-watch.ts` (lines 18 and 105), `packages/host/src/evidence/host-entries.ts` (line 76), `apps/web/src/teams.tsx` and `apps/mobile/src/features/teams/model.ts` (the role names), `tests/{fuse-baseline,github-grants,team-watch,host-entries}.test.ts`. Needs Task 1.

**Interfaces (produces):**
```ts
// each role list on one line gains "evaluator" in place: manager.ts 604 and 742, worker.ts 1127 and 1384, team-mcp-results.ts 53, fuse/baseline.ts 13
// github-grants.ts 157, in place: … || context.role === "intent-checker" || context.role === "evaluator") return undefined;
// team-watch.ts 18: "evaluator": "Evaluator";   105: the rank puts "evaluator" after "reviewer"
// evidence/host-entries.ts 76, in place: … && member.role !== "permission-coordinator" && member.role !== "evaluator");
// apps/web/src/teams.tsx and apps/mobile/src/features/teams/model.ts: the role's display name "Evaluator"
```

**Decisions:** the evaluator gets no GitHub grant, no entry tools (`ENTRY_ROLES` does not list it; unchanged), and no blackboard report entry. Its launches pass fuse admission as every member's do.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the evaluator launches under the fuse` (fuse-baseline) | `LAUNCH_ROLES` includes `evaluator`; a launch of that role is admitted and counted as any member's. |
| `the evaluator gets no grant` (github-grants) | `sessionGithubScope` for role `evaluator` is undefined with and without delivery. |
| `the evaluator has a name and a place` (team-watch) | The watch line names "Evaluator" and orders it after the reviewer. |
| `an evaluator's report never becomes an entry` (host-entries) | A run with an evaluator member holding a `verdict` report gives no `report:` entry for it. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/fuse-baseline.test.ts tests/github-grants.test.ts tests/team-watch.test.ts tests/host-entries.test.ts`, the host typecheck, `npm run lint -w @infinite/mobile`, and `npx tsc --noEmit` in `apps/mobile`. Confirm with `wc -l` that `manager.ts` is 1,244 and `worker.ts` is 1,903 lines.

### Task 9: the goal rules

**Files:** `packages/host/src/goal-types.ts`, `packages/host/src/goal-verdicts.ts` (create), `tests/goal-verdicts.test.ts` (create). Needs Task 1.

**Interfaces (produces):**
```ts
// goal-types.ts
export type GoalAssessment = RunAssessment & { progress: number };
// GoalCycle gains, after `class`:  /** The cycle's agent assessment, provisional; copied from its run. */ assessment?: GoalAssessment;
// ProductGoal.stopReason (line 110), in place: "deadline" | "member-limit" | "provisional-met"
// ProductGoal.outcomes (line 147), in place: each outcome gains verdictId?: string
// goalOutcomeSchema (line 69) gains: verdictId: z.uuid().optional(), continue: z.literal(true).optional(),
//   refined: `continue` needs `verdictId` and result "not-achieved".
export type GoalOutcomeInput = z.infer<typeof goalOutcomeSchema>;

// goal-verdicts.ts: imports goal-types, team-types, verdict-types, autonomy, objective-goals, objective-digest, and team-workspace's TeamError.
export const PROVISIONAL_REASON = "An agent assessment, provisional, found every criterion met. Record your assessment: achieved, or not achieved with continue.";
export const PROVISIONAL_EVENT = "Agent assessment, provisional: every criterion met. The goal stopped for your assessment and is not marked achieved.";
export const CONTINUE_EVENT = "You recorded not achieved and continued the goal. The next cycle reads your direction.";
/** For refresh's Object.assign: {} when neither the team nor the cycle has an assessment; the team's current one with its
 *  progress; { assessment: undefined } when the cycle has one and the team's is gone or of another revision. */
export function cycleVerdict(goal: Pick<ProductGoal, "cycles">, cycle: GoalCycle, team: Pick<TeamView, "revision" | "assessment">): { assessment?: GoalAssessment };
/** A cycle with a verdict fails when its result is not met and its progress is not positive. */
export function verdictFailed(cycle: Pick<GoalCycle, "assessment">): boolean;
/** True for a pinned-autonomous finite goal whose cycle for `team` holds a current reviewed `met` assessment. */
export function provisionalStop(goal: Pick<ProductGoal, "autonomy" | "standing" | "cycles">, team: Pick<TeamView, "id" | "revision" | "assessment">): boolean;
/** Throws TeamError before anything is admitted; see the codes below. */
export function assertVerdictAnswer(goal: ProductGoal, body: GoalOutcomeInput, nowMs: number): void;
/** Appends body.summary as a steering entry, syncs the record with steerGoalObjective, and sets the goal running with no
 *  stopReason and no reason. Returns goalObjectiveNote's text, or undefined. Never sets `achieved`. */
export function continueGoal(holder: GoalHolder, body: GoalOutcomeInput, at: string): string | undefined;
/** { criteria } for the next cycle's context, or {}: see the decisions. */
export function criteriaRowsFor(holder: GoalHolder, project: Pick<Project, "team"> | undefined): { criteria?: CriteriaRow[] };
```

**Decisions:**

- **Progress** is the cycle's `met` count minus the `met` count of the newest earlier cycle with an assessment, or its `met` count when there is none. It is computed when the assessment is copied, from at most 50 cycles in memory.
- **The refusals of `assertVerdictAnswer`:**
  - 409 `verdict-not-found` ("That agent assessment is not one of this goal's."): `verdictId` names no cycle's assessment.
  - 409 `goal-not-provisional` ("Continue applies only to a goal stopped by a provisional agent assessment."): `continue` on a goal whose `stopReason` is not `provisional-met`, or whose newest assessed cycle's `verdictId` differs.
  - 409 `goal-limit-reached` ("The goal's time or member allowance is spent. Start a new goal to continue."): `continue` at or past `deadlineAt` or `ceilingAt`, or with `memberCount` at `maxMembers`.
  - 409 `goal-steering-limit`: `continue` when the goal holds 20 steering entries, or the objective with every direction and the summary passes 24,000 bytes, as `steer` checks.
- **Criteria rows** are `{}` unless all of these hold:
  - the project's `objective.prompts` and `objective.evaluator` are `"on"`;
  - the goal is pinned `autonomous`;
  - a cycle holds an assessment, and the record reads.

  Then the rows are the newest assessment's criteria that are still active in the record, in record order, with `checkLabel(check, configured)` cut to 120 bytes on a character boundary. In a supervised goal the verdict changes nothing, so no rows.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `cycle verdicts copy the current revision and compute progress` | A team at revision 2 with an assessment of revision 2 gives that assessment with progress; one of revision 1 gives `{ assessment: undefined }` when the cycle holds one, and `{}` when it does not. Three cycles with 1, 3, and 3 met give progress 1, 2, and 0. |
| `a provisional stop needs an autonomous finite goal and a met reviewed verdict` | True only for an autonomous finite goal and a current reviewed `met`. False for a supervised goal, an unpinned goal, a standing goal, a `no-change` assessment, `not-met`, `inconclusive`, and a stale revision. |
| `verdict failures follow the result and the progress` | `verdictFailed` is true for `not-met` with progress 0 and `inconclusive` with progress −1. It is false for `met` with progress 0, `not-met` with progress 1, and no assessment. |
| `the outcome rules refuse a wrong verdict answer` | Each code above from its case, with nothing changed on the goal. `continue` with `achieved` or without `verdictId` is refused by the schema. |
| `continue appends one direction and restarts the goal` | A goal stopped by `provisional-met`: `continueGoal` adds one steering entry, the record gains direction `s<revision>` as `direction.appended` at one version up, and the goal is `running` with no `stopReason` and no `reason`. Its outcomes are unchanged by `continueGoal` itself. |
| `criteria rows follow the latest verdict, the record, and the switches` | Rows from the newest assessment; a criterion retired since is left out; a 200-byte label is cut to at most 120 bytes; each switch off, a supervised goal, no assessment, or an unreadable record gives `{}`. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/goal-verdicts.test.ts tests/objective-goals.test.ts` and the host typecheck.

### Task 10: the rows in the coordinator's prompt, and the prompt version

**Files:** `packages/host/src/team-prompts.ts` (at most +8), `packages/host/src/objective-digest.ts`, `packages/host/src/config-identity.ts`, `tests/team-prompts.test.ts`, `tests/objective-digest.test.ts`, `tests/config-identity.test.ts`. Needs Tasks 1 and 7.

**Interfaces (produces):**
```ts
// team-prompts.ts
// 140 and 141, in place: goalContextText(goal, role) leaves `criteria` out of the goal JSON for every role, and for "project-manager"
//   appends criteriaRowsText(goal.criteria) after it. Without `criteria`, its output is byte for byte today's.
// 521, in place: … goalContextText(run.goal, role) …
// 166, in place: goal: run.goal && role !== "project-manager" ? withoutCriteria(run.goal) : run.goal,
// 188, in place: memberReports: (run.members ?? []).filter(member => member.role !== "permission-coordinator" && member.role !== "evaluator").map(…)
function withoutCriteria(goal: NonNullable<TeamRun["goal"]>): NonNullable<TeamRun["goal"]>;   // the same object when it has no criteria

// objective-digest.ts
export type ObjectivePrompt = boolean | "register" | "register-autonomous" | "criteria" | "register-criteria" | "register-autonomous-criteria";
// objectivePromptOf(run): today's value, with "-criteria" added (true becomes "criteria") when run.goal.criteria is present.
// objectivePromptFor(project, mode): unchanged; it previews an implementer, whose prompt never holds rows.

// config-identity.ts
// objectiveFixture: the three criteria shapes add two fixed rows to the fixture goal.
// 159, after the intent-checker line, in place on one line: if (role === "evaluator") return [evaluatorPrompt(provider, profile).split(command).join("<report-command>")];
```

**Decisions:**

- **Only the coordinator reads the rows**, in its prompt and its context file, as part 8 says. Every other role's prompt and context file stays as without rows.
- **The version follows the bytes.** `promptVersion` hashes rendered prompts, so the implementer's version is equal with and without rows, and the project manager's differs.
- **The evaluator's version** is its fixed prompt's hash, as the intent checker's is.
- **The rows can fall inside the permission agent's 4,000-character read** of the coordinator's prompt. They hold ids, statuses, and check labels that the record digest already prints.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `without criteria rows the prompts are byte for byte` (team-prompts) | For each role, the prompt and the context file of a goal run without `criteria` equal the strings pinned from the base commit. |
| `criteria rows reach only the coordinator` (team-prompts) | A goal run with acceptance 10's rows. **The project manager:** its prompt holds `c2`, `not-met`, the check label, and "Agent assessment, provisional"; its context file holds the rows. **Every other role:** no row in its prompt or its context file. **Nowhere:** a note, a threshold, a count of failing entries, or a profile name. |
| `team-prompts imports no verdict storage` (team-prompts) | The source of `team-prompts.ts` imports neither `verdict-store.ts` nor `outcome-store.ts`. |
| `the criteria shapes follow the goal's rows` (objective-digest) | `objectivePromptOf` gives `"criteria"`, `"register-criteria"`, and `"register-autonomous-criteria"` with rows, and today's values without. |
| `the criteria shapes change the coordinator's prompt version only` (config-identity) | The implementer's `promptVersion` is equal for `true` and `"criteria"`; the project manager's differs. The evaluator's version is stable across two calls and differs from the intent checker's. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/team-prompts.test.ts tests/objective-digest.test.ts tests/config-identity.test.ts tests/register-prompt.test.ts` and the host typecheck. Confirm with `wc -l` that `team-prompts.ts` is at most 959 lines.

### Task 11: the runtime

**Files:** `packages/host/src/team-verdicts.ts` (create), `tests/team-verdicts.test.ts` (create), `tests/verdict-rebuild.test.ts` (create). Needs Tasks 1, 2, 3, 4, 6, and 7.

**Interfaces (produces):**
```ts
export { verdictPin } from "./evaluator-profiles.js";
export type VerdictState = {
  revision: number; head: string; kind: "reviewed" | "no-change"; verdictId: string;
  status: "testing" | "queued" | "evaluating" | "releasing" | "done";
  failures: 0 | 1; excluded?: string[];                 // profile ids that failed this verdict
  receiptsFrom: string;                                 // the run whose reviewed pass gives the receipts: this run, or the parent run
  evaluatorMemberId?: string; heldMemberId?: string;    // heldMemberId: the project manager whose no-change report waits
  choice?: { profileId: string; provider: Provider; model?: string; family: string; sharedFamily: boolean; alsoReviewed: boolean };
  report?: VerdictReport; composed?: ComposedVerdict; reason?: VerdictReason;
  written?: "wrote" | "log-full" | "record-unavailable" | "write-failed";
};
/** The part of teams.ts' Stored that verdicts read and write. */
export type VerdictHolder = { run: TeamRun; verdict?: VerdictState; objectiveRecord?: unknown; checkHead?: string };
/** Closures over TeamService's private methods, built in one field initializer in teams.ts (Task 12). */
export type VerdictHost = {
  holder(runId: string): VerdictHolder | undefined;
  prepare(holder: VerdictHolder, onPrepared: (member: TeamMember) => void, prebuilt: { prompt: string; profile: TeamModelProfile }): void;
  consume(holder: VerdictHolder, member: TeamMember): void;
  operation(holder: VerdictHolder, perform: (signal: AbortSignal) => Promise<boolean | undefined>, complete: (clean: boolean | undefined) => void, member: TeamMember): void;
  save(holder: VerdictHolder): void;
  event(holder: VerdictHolder, text: string): void;
  emit(holder: VerdictHolder, data: VerdictEventData): void;          // the run event "verdict.recorded"
  configured(run: TeamRun): readonly TeamCommand[];
  limited(): Set<Provider>;
  prefix(): TeamCommand | undefined;
  register: Pick<TeamRegister, "markReviewed" | "reviewedReceipts">;
  now(): string;
  uuid(): string;
};
export const VERDICT_EVENTS = {
  held: "The host is assessing this revision against the objective record before it settles.",
  recorded: (result: AssessedState, counts: VerdictCounts) =>
    `Agent assessment, provisional: ${result}. ${counts.met} met, ${counts.notMet} not met, ${counts.inconclusive} inconclusive, ${counts.pendingOwner} waiting for the owner.`,
  contradicted: (count: number) => `The evaluator contradicted ${count} host receipts; the receipts stand.`,
  replaced: "The evaluator stopped without a usable report; one replacement starts.",
  skipped: {
    "no-independent-evaluator": "No evaluator of another model family that authored nothing in this run is listed, so the assessment is inconclusive.",
    "evaluator-unavailable": "The evaluator could not finish, so the assessment is inconclusive.",
    "record-unavailable": "The objective record could not be read, so the assessment is inconclusive.",
    "context-too-large": "The evaluator's context would pass its limit, so the assessment is inconclusive.",
  },
  logFull: "The objective record's log is full, so the assessment was kept on the run and the goal but not written to the record.",
  writeFailed: "The objective record could not be saved, so the assessment was kept on the run and the goal but not written to the record.",
} as const;
export type VerdictDetail = {
  verdictId: string; kind: "reviewed" | "no-change"; revision: number; head: string;
  result: AssessedState; evaluatorResult?: AssessedState; reason?: VerdictReason;
  criteria: ComposedCriterion[]; evaluator?: VerdictState["choice"]; written?: VerdictState["written"];
};
export class TeamVerdicts {
  goals?: GoalRecordPort;
  constructor(host: VerdictHost);
  /** teams.ts 2593, once the review approved: true holds the run (no delivery, no settle). */
  reviewed(holder: VerdictHolder): boolean;
  /** teams.ts 3073, on a project manager's no-change report: true holds the report. */
  holdNoChange(holder: VerdictHolder, member: TeamMember): boolean;
  /** teams.ts 2567, where a new project manager would start: true when the verdict owns the run's next step. */
  step(holder: VerdictHolder): boolean;
  /** teams.ts 2737: keeps the full report in the state and returns the stub; any other kind becomes fixed blocked text. */
  screen(holder: VerdictHolder, member: TeamMember, report: TeamReport): TeamReport;
  /** teams.ts 3058: every report of an evaluator member. Only the current evaluator's verdict report is applied. */
  consume(holder: VerdictHolder, member: TeamMember): void;
  /** teams.ts 2483, 2777, 2826: true for an evaluator (handled), false for every other role. */
  failed(holder: VerdictHolder, member: TeamMember): boolean;
  /** teams.ts 2980: the evaluator's context; null after the verdict finished without it and the member stopped. */
  context(holder: VerdictHolder, member: TeamMember): VerdictContext | null;
  /** For the verdicts read: the done verdict of the run's current revision, from memory. */
  detail(runId: string): VerdictDetail | undefined;
}
```

**Decisions: the states.**

| Status | Entered when | Next |
|---|---|---|
| `testing` | `reviewed` holds a new reviewed verdict and calls `register.markReviewed` | `queued` when `reviewedReceipts(run.id, head)` is not `"pending"` |
| `queued` | from `testing`; at `holdNoChange` (receipts from the parent run); after one failure; when the evaluator member is gone before it was prepared | `evaluating` after `prepare`; `done` when the record does not read, no profile is chosen, or the context is too large |
| `evaluating` | `prepare` started the evaluator | the consume's completion composes and writes, then `done` (reviewed) or `releasing` (no change); a failure goes to `queued` once, then `done` with `evaluator-unavailable` |
| `releasing` | a no-change verdict is composed | `step` consumes the held report again, then `done` |
| `done` | composed, with or without an evaluator | `reviewed` and `holdNoChange` return false; the run proceeds |

- **Every path ends in `done`.** A finish without an evaluator still composes host and owner criteria, sets `run.assessment`, emits the row event, adds one fixed event, and saves.
- **The authors and reviewers** of `chooseEvaluator` come from the run's members: implementers whose task is `integrated` and integrators that reported a `result`, by their `modelProfile`; and every reviewer member.
- **Facts.** For a reviewed verdict, `checksPassed` is true when the final check round at `checkHead === head` has every row passed, as `receiptsFor` reads the final round, and `reviewApproved` is true. For a no-change verdict, both come from the parent run's holder in the same way, and are undefined when it is gone.
- **The record.** It is read with `heldRecordState` and written with `writeHeldRecord` (`objective-holder.ts`), as the intent check and the register write it. The evaluator reads the latest version (part 2).
- **A verdict never outlives its revision.** `reviewed`, `step`, and the completion compare the state's revision and head with the run's. A mismatch discards the state, removes a stale `run.assessment`, writes nothing, and saves.
- **A completion writes once.** It checks that the state is still `evaluating` for this evaluator member, revision, and verdict id.
- **No run status of its own.** The evaluator runs as `reviewing` (Task 12). A verdict adds no status, so the outcome ledger records no new outcome event.
- **Events** carry results and counts only: `held` once, `recorded` once, `contradicted` once when any, and one skip or write event when it applies.

- [ ] **Step 1: Write the failing tests.** Each test uses a fake host, unless the row says otherwise.

| Test name | Assertions |
|---|---|
| `a reviewed revision gets one verdict` | `reviewed` on a pinned run gives true and `testing`; while `reviewedReceipts` is `"pending"` it stays; then `queued`, and `prepare` is called once with the chosen profile and the fixed prompt. The consume's completion composes, writes the record one version up, sets `run.assessment`, emits one event with the counts, adds `held` and `recorded`, and sets `done`. A second `reviewed` returns false. An unpinned run returns false and changes nothing. |
| `a no-change cycle is held and released` | `holdNoChange` on a goal run with `parentRunId` holds once, with receipts from the parent; after the verdict, `step` calls `consume` with the held member once and the state is `done`; `holdNoChange` then returns false. A run without `parentRunId` is not held. |
| `a verdict without an evaluator is inconclusive and releases the run` | `no-independent-evaluator`, every eligible provider limited (`evaluator-unavailable`), an unreadable record, and a context over 1 MiB: each gives `done` with its reason, host criteria composed where the record reads, one skip event, and `reviewed` false next. |
| `one replacement, then evaluator-unavailable` | `failed` on the current evaluator moves to `queued` with the profile excluded and one `replaced` event; the second evaluator's failure gives `done` with `evaluator-unavailable`. `failed` returns true for an evaluator that is not current and changes nothing. |
| `a wrong report kind is a failure, never text` | `screen` turns a `review` report into a `blocked` report with fixed text, and `consume` then counts a failure. A `verdict` report's member keeps only the stub: no note and no handle. |
| `a verdict never outlives its revision` | A new revision while `evaluating`: the completion writes nothing, `run.assessment` of the old revision is removed, and the next `reviewed` starts a new verdict. |
| `record failures never hold the run` | A goal port whose write throws gives `written: "write-failed"` and one event; a log at its share gives `"log-full"`; in both, `run.assessment` is set and the state is `done`. |
| `seeded verdicts with restarts compose each verdict once` | **Seeded:** 100 seeds, with the seed printed on failure. **The sequences** are random: holds, pass completions, prepares, reports, failures, new revisions, and restarts. A restart is a new `TeamVerdicts` over a JSON round trip of the holders and the goal record. **Invariants:** at most one `verdict.recorded` entry and one row event per verdict id; every state ends `done` or discarded; the final record equals the one from the same sequence without restarts. |
| `every version rebuilds after random verdict writes` (verdict-rebuild) | **Seeded:** 200 seeds. **The writes** are random `verdictRecord`, `applyReceipts`, `applyProposals`, owner ops, and intent applies, with a JSON round trip between steps. **The check:** for each version, `rebuildVersion(final, v)` deep-equals the snapshot after the last write at `v`, checked by `version` and criteria count first; every snapshot parses. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/team-verdicts.test.ts tests/verdict-rebuild.test.ts` and the host typecheck. Confirm with `wc -l` that `team-verdicts.ts` is under 1,000 lines.

### Task 12: the hooks in `teams.ts`

**Files:** `packages/host/src/teams.ts` (17 lines in place, net 0), `tests/fixtures/team-agent.mjs` (the fake evaluator), `tests/verdict-host.test.ts` (create), `tests/autonomy-pins.test.ts` (one test). Needs Tasks 5, 8, 10, and 11. Task 12 is the only task that writes `teams.ts`.

**Interfaces (produces):**
```ts
// teams.ts, by line on the reference tree (apply bottom-up; find each by its code). Every change stays on its line.
// 62:   import { TeamRegister, … } from "./team-register.js"; import { TeamVerdicts, verdictPin, type VerdictState } from "./team-verdicts.js";
// 189:  objectiveRecord?: unknown; objectiveNotice?: ObjectiveUnavailable; intentCheck?: IntentCheckState; register?: RegisterState; verdict?: VerdictState;
// 244:  … delivery: [ … ], "intent-checker": ["intent-check"], evaluator: ["verdict"],
// 370:  private readonly objectiveTests = new TeamRegister({ … }); readonly verdicts = new TeamVerdicts({ holder: id => this.records.get(id),
//         prepare: (s, o, p) => this.prepareMember(s as Stored, "evaluator", undefined, undefined, o, p), consume: (s, m) => this.consume(s as Stored, m),
//         operation: (s, p, c, m) => this.operation(s as Stored, "result", p, c, m), save: s => this.save(s as Stored), event: (s, t) => this.event(s as Stored, t),
//         emit: (s, d) => this.emitWith(s as Stored, "verdict.recorded", [d.verdictId], { revision: s.run.revision }, () => d),
//         configured: run => this.config.projects.find(p => p.id === run.projectId)?.team?.checks ?? [], limited: () => this.limits.limited(),
//         prefix: () => this.config.teams?.commandPrefix, register: this.objectiveTests, now: timestamp, uuid: randomUUID });          // one line
// 551:  useGoalRecords(port: GoalRecordPort) { this.intentChecks.goals = port; this.objectiveTests.goals = port; this.verdicts.goals = port; }
// 1223: if (registerPin({ … })) run.register = "on"; if (verdictPin({ evaluator: project.team.objective?.evaluator, register: project.team.objective?.register, mission: Boolean(internal?.missionId), handoff: Boolean(internal?.handoff) })) run.verdicts = "on";
// 2483: if (this.intentChecks.failed(stored, member) || this.verdicts.failed(stored, member)) return;
// 2567: if (this.intentChecks.step(stored) || this.verdicts.step(stored)) return;
// 2593: if (run.review.verdict === "approved") { if (this.verdicts.reviewed(stored)) return;
// 2737: member.report = member.role === "intent-checker" ? this.intentChecks.screen(stored, member, envelope.report) : member.role === "evaluator" ? this.verdicts.screen(stored, member, envelope.report) : envelope.report; …rest as today
// 2777: if (this.intentChecks.failed(stored, member) || this.verdicts.failed(stored, member)) return;
// 2826: if (this.intentChecks.failed(stored, member) || this.verdicts.failed(stored, member)) return;
// 2882: … : role === "reviewer" || role === "evaluator" ? "reviewing" : …
// 2891: const setup = role === "permission-coordinator" || role === "intent-checker" || role === "evaluator" ? undefined : run.establishChecks
// 2980: const intentContext = member.role === "intent-checker" ? this.intentChecks.context(stored, member) : member.role === "evaluator" ? this.verdicts.context(stored, member) : undefined; if (intentContext === null) return;
// 3058: if (member.role === "intent-checker") { this.intentChecks.consume(stored, member); return; } if (member.role === "evaluator") { this.verdicts.consume(stored, member); return; }
// 3073: if (report.kind === "no-change") { if (this.verdicts.holdNoChange(stored, member)) return;
```

**Decisions:**

- **One call per hook.** Each hook makes one call into `TeamVerdicts`. `teams.ts` reads nothing new from the store, a journal, or a sealed file.
- **`verdicts` is public and read-only,** so the verdicts read (Task 14) reaches `detail` without a new method.
- **The evaluator's working copy** is prepared at `run.headCommit`, as every member's is (`newMember`, line 2873). It gets no setup, no entry tools, no blackboard digest (the context replaces it at line 2982), and no GitHub grant.
- **The views.** `run.verdicts` and `run.assessment` reach every view and relay device through the team view. `Stored.verdict` is outside `run` and reaches no view. The evaluator member's report in the view is the stub.
- **The fake evaluator.** In `team-agent.mjs`, the `evaluator` role reads `verdict.json` from the agent's state directory when it exists and reports it; otherwise it reports every criterion in its context `met` with the first changed path as a handle. With `stall-evaluator`, it never reports.
- **The evaluator's session transcript** holds its own text, as every member's does. Session reads keep their roles; this slice changes none.

- [ ] **Step 1: Write the failing tests.** They run on `tests/fixtures/team-scheduler.ts` with the fake agent, the register on, and `teams.commandPrefix` as the fake prefix. Each test calls the service's `start()`.

| Test name | Assertions |
|---|---|
| `acceptance 6 end to end` | Part 9's record on a standalone run; the project's checks hold `rank-verify`, whose final round fails. The fake evaluator reports every criterion `met`. The run settles `ready-for-review` after the verdict; `run.assessment.result` is `not-met`, `evaluatorResult` `met`; the record's log holds `evaluator-contradicted-receipt` on c4; one row event is in the outbox. |
| `acceptance 11 end to end` | Acceptance 11's lineup; an implementer's work integrates. The evaluator member's `modelProfile` is the reviewer's profile; the row event has `alsoReviewed` true and `sharedFamily` false. |
| `without verdicts a run is as today` | The same run without `run.verdicts`: no evaluator member, no `Stored.verdict`, no `assessment` and no `verdicts` key in `teams.get(id)`, no verdict event, and the settle as today. |
| `a stalled evaluator is replaced once` | With `stall-evaluator`, the first evaluator stalls, one replacement starts, and after it stalls the run settles with `reason: "evaluator-unavailable"`. |
| `an open fuse holds the verdict` | With the launch fuse open, no evaluator launches and the run stays held; after the fuse closes, the evaluator runs and the run settles. |
| `evaluator text stays sealed` | The fake evaluator reports notes and handles carrying marker strings. None of the markers appears in `teams.get(id)`, the run's events, the outbox, the blackboard, the record's log, or a later delivery member's prompt and context file. The member's report in the view has empty `evidence`. |
| `each new run pins verdicts by setting` (autonomy-pins) | `create()` pins `verdicts: "on"` only with `objective: { evaluator: "on", register: "on" }`. `createForMission()` and a handoff run never pin it. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/verdict-host.test.ts tests/autonomy-pins.test.ts tests/intent-check.test.ts tests/register-host.test.ts tests/objective-runs.test.ts` in the background, and the host typecheck. Confirm with `wc -l` that `teams.ts` is 3,578 lines.

### Task 13: the hooks in `goals.ts`

**Files:** `packages/host/src/goals.ts` (12 lines in place, net 0), `tests/fixtures/goal-agent.mjs` (the fake evaluator), `tests/verdict-goals.test.ts` (create). Needs Tasks 9 and 12. Task 13 is the only task that writes `goals.ts`.

**Interfaces (produces):**
```ts
// goals.ts, by line on the reference tree (apply bottom-up; find each by its code). Every change stays on its line.
// 8:   import { goalActionSchema, …, type GoalOutcomeInput, type ProductGoal } from "./goal-types.js";
// 21:  import { objectivePromptsOn, objectiveRegisterOn } from "./objective-digest.js"; import { assertVerdictAnswer, continueGoal, criteriaRowsFor, cycleVerdict, provisionalStop, verdictFailed, CONTINUE_EVENT, PROVISIONAL_EVENT, PROVISIONAL_REASON } from "./goal-verdicts.js";
// 571: outcome(id: string, input: GoalOutcomeInput) {
// 578: assertVerdictAnswer(goal, body, Date.now()); this.admit(stored, "outcome", body);
// 579: goal.outcomes.push({ result: body.result, summary: body.summary, evidence: body.evidence, at: now(), revision: goal.revision, ...(body.verdictId ? { verdictId: body.verdictId } : {}) });
// 581: else if (body.continue) { const note = continueGoal(stored, body, now()); if (note) this.event(stored, note); } else if (goal.status === "achieved") goal.status = …as today…;
// 582: this.event(stored, body.continue ? CONTINUE_EVENT : "A user recorded a product outcome with supporting evidence.");
// 612: Object.assign(cycle, { status: team.status, …as today… }, cycleVerdict(stored.goal, cycle, team));
// 795: const stop = provisionalStop(goal, team); goal.status = stop ? "ready-for-review" : "running"; goal.reason = stop ? PROVISIONAL_REASON : undefined; if (stop) goal.stopReason = "provisional-met";
// 796: this.event(stored, stop ? PROVISIONAL_EVENT : "A feature passed checks and independent review. The next feature will use its recorded commit.");
// 871: extendMinutes: …, ...(pinned && "digest" in pinned ? { record: pinned.digest } : {}), ...criteriaRowsFor(stored, project) };
// 977: if (cycle.class === "failed" || verdictFailed(cycle)) goal.failedCycles = (goal.failedCycles ?? 0) + 1;
```

**Decisions:**

- **The outcome route keeps its roles and its relay rule** (call 12). `continue` admits once: a replay of the same `requestId` and body answers the goal and writes nothing, as today.
- **A provisional stop is a stop.** The goal is `ready-for-review`, so no cycle launches, and the owner records an outcome as today. Only `continue` or a new goal starts more work.
- **The failure count** reads `verdictFailed` after `classifyCycle`. A reviewed or no-change cycle with a failing verdict counts as failed; `cycle.class` keeps its value, so `latestReviewed` and the next cycle's parent are unchanged.
- **The next cycle's context** carries the rows only when `criteriaRowsFor` gives them. A launch replay carries the same rows, because the context is built before the launch is saved.
- **The fake evaluator.** In `goal-agent.mjs`, the `evaluator` role reports from `verdict-<cycle>.json` in its state directory when it exists, else every criterion `met`.

- [ ] **Step 1: Write the failing tests.** They run goal cycles with `goal-agent.mjs`, `objective: { evaluator: "on", register: "on", prompts: "on", intentCheck: "off" }`, an autonomous project, and the plan-brief flag file. Each test calls the service's `start()`.

| Test name | Assertions |
|---|---|
| `acceptance 7: a provisional met stops the goal and continue resumes it` | A finite goal; cycle 1's verdict is `met`. The goal is `ready-for-review` with `stopReason: "provisional-met"`, never `achieved`, and holds one `PROVISIONAL_EVENT`. `outcome` with `not-achieved`, `continue`, and the cycle's `verdictId` sets it `running`; the record is one version up with direction `s<revision>`; cycle 2 starts, and its objective prints "User direction:" with the summary. `achieved` with the same `verdictId` sets `achieved`. |
| `continue is refused outside a provisional stop` | `continue` on a goal stopped by its deadline gives 409 `goal-not-provisional`; past the deadline after a provisional stop, 409 `goal-limit-reached`; with an unknown `verdictId`, 409 `verdict-not-found`. Each leaves the goal, its receipts, and its events unchanged. |
| `a standing goal records met and counts verdict failures` | A standing goal: a `met` verdict leaves it `running`, and the next cycle starts at its cadence. Three cycles with `not-met` verdicts and no progress pause it with `repeated-failures`; an owner resume resets the count. |
| `acceptance 10 end to end` | Part 9's record; cycle 1's verdict has c2 `not-met`. Cycle 2's project manager prompt holds c2, `not-met`, and c2's check label with "Agent assessment, provisional", and no note, threshold, count, or profile. Cycle 2's implementer prompt holds no row. |
| `a supervised goal shows the verdict and changes nothing` | A supervised goal with the same switches: `cycle.assessment` is set, a `met` does not stop the goal, no rows reach cycle 2, and the failure count is as today. |
| `without verdicts a goal is as today` | Without `objective.evaluator`: no `assessment` on any cycle, no `stopReason: "provisional-met"`, cycle 2's context equal to today's, and `outcome` without `verdictId` as today. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/verdict-goals.test.ts tests/register-goals.test.ts tests/objective-goals.test.ts tests/standing-goals.test.ts` in the background, and the host typecheck. Confirm with `wc -l` that `goals.ts` is 1,042 lines.

### Task 14: the verdicts read and the CLI

**Files:** `packages/host/src/verdict-view.ts` (create), `packages/host/src/objective-routes.ts`, `packages/host/src/objective-cli.ts`, `tests/verdict-routes.test.ts` (create), `tests/objective-cli.test.ts`, `tests/remote-access.test.ts`. Needs Tasks 9 and 12.

**Interfaces (produces):**
```ts
// verdict-view.ts: pure.
export type GoalVerdictView = {
  cycle: number; teamId: string; verdictId: string; kind: "reviewed" | "no-change"; head: string; at: string;
  label: "Agent assessment, provisional";
  result: AssessedState; evaluatorResult?: AssessedState; differs: boolean; reason?: VerdictReason; counts: VerdictCounts; progress: number;
  owner?: { result: "achieved" | "not-achieved" | "inconclusive"; agrees?: boolean };   // the owner outcome with this verdictId
  criteria: { id: string; producer: "host" | "evaluator" | "owner"; state: ComposedState; label: "host receipt" | "agent assessment" | "waiting for you";
    reason?: CriterionReason; evaluatorState?: AssessedState; receipt?: { handle: string; outcome: ReceiptOutcome }; handles?: string[]; note?: string }[];
  evaluator?: { profileId: string; family: string; sharedFamily: boolean; alsoReviewed: boolean };
  detail: "available" | "expired";                       // expired: the run's record is gone; only the cycle's summary remains
};
export function goalVerdictsView(goal: ProductGoal, details: (teamId: string) => VerdictDetail | undefined): { verdicts: GoalVerdictView[] };

// objective-routes.ts: services.goals gains "get"; services.teams gains "verdicts".
//   app.get("/api/goals/:id/verdicts", read, (req, res) => res.json(goalVerdictsView(services.goals.get(recordId(req.params.id)), id => services.teams.verdicts.detail(id))));
// objective-cli.ts: `infinite goal verdicts ID [--json]`, through handleGoalClientCommand; the text form prints one block per cycle.
```

**Decisions:**

- **Roles.** The read is for owner, controller, and viewer devices, as the record read is. The relay refuses it (`remote-access.ts` line 49 has no `verdicts` branch); no relay code changes.
- **Agreement** is `met` with `achieved` or `not-met` with `not-achieved`; any other pair leaves `agrees` absent.
- **Cost.** One goal view and at most 50 in-memory `detail` calls. No store, journal, or sealed-file read.
- **The CLI's text** labels the result "Agent assessment, provisional" and each criterion by its label; it prints notes only with `--json`.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `the verdicts read joins cycles, details, and owner answers` (verdict-routes) | Two cycles with assessments, one run gone: the first view has its criteria with notes and handles; the second has `detail: "expired"` and the summary only. An owner outcome with the first `verdictId` and `not-achieved` on a `not-met` verdict gives `agrees: true`. `differs` is true when `evaluatorResult` differs from `result`. |
| `the verdicts read keeps the record roles` (verdict-routes) | Owner, controller, and viewer devices get 200; an unknown goal gets 404. |
| `the relay refuses the verdicts read` (remote-access) | `GET /api/goals/<uuid>/verdicts` is refused through the relay. |
| `goal verdicts prints the labels` (objective-cli) | The text form holds "Agent assessment, provisional", each criterion's label, and no note; `--json` prints the response. |

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `NODE_OPTIONS=--max-old-space-size=2048 node --import tsx --test tests/verdict-routes.test.ts tests/objective-cli.test.ts tests/remote-access.test.ts` and the host typecheck.

### Task 15: the goal page and the phone's goal screen

**Files:** `apps/web/src/api.ts`, `apps/web/src/goals.tsx`, `apps/mobile/src/api/client.ts`, `apps/mobile/src/features/teams/GoalDetail.tsx`. Needs Task 1; it builds on this plan's fixed shapes (`GoalAssessment`, `GoalVerdictView`, `GoalOutcomeInput`) and may start beside Task 9.

**Decisions:**

- **Each cycle with an assessment** shows "Agent assessment, provisional", the result, the four counts, and, when they differ, the evaluator's own result. The owner's outcome shows as "Your assessment" and is the only source of `achieved`.
- **A goal stopped by `provisional-met`** shows its reason and two actions: "Achieved", and "Not achieved, continue", which takes the summary and sends `continue` with the newest `verdictId`.
- **The criteria rows** come from `GET /api/goals/:id/verdicts` on demand, when the owner opens a cycle; the list view reads nothing new.
- **The Mac app** is not in this slice.

- [ ] **Step 1: Write the failing tests.** Web: the goal page renders the assessment and the two actions from a mock API. Phone: the goal screen's model renders the same from a fixture. **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Run** the web build, `npm run lint -w @infinite/mobile`, and `npx tsc --noEmit` in `apps/mobile`.

### Task 16: the docs and the spec

**Files:** `docs/teams.md`, the spec. Runs last; the contract is fixed in this plan.

**Decisions:**

- **`docs/teams.md`, in the goal record section, covers:**
  - **The setting:** `objective.evaluator`, off by default, inside the routine approval digest, needing `objective.register`; the pin at `createRun`.
  - **The evaluator:** when it runs, the hold, the rule for its profile, what it reads, what it reports, its limits, and its failures.
  - **Composition:** the rule table and the result.
  - **Goals:** the provisional stop, `continue`, the failure count, and the criteria rows.
  - **Reads:** the API, the CLI, and what relay devices see.
  - **Rollback:** the steps from this section's rollback row.
- **The spec:**
  - **Part 5:** the hold before settle; the default (call 1, as ruled); `latest` without notes; the rows' channel (call 13, as ruled); `continue` as steering; agreement deferred (call 14, as ruled); `merged` and `landed` (call 8, as ruled).
  - **Part 8:** the coordinator reads the rows from `TeamGoalContext.criteria` until C17 wires its digest.
  - **The delivery order and "Left to the builder":** the router question answered "no change" (call 15).

- [ ] **Step 1: Amend the docs and the spec.** **Step 2: Run** the privacy scan of `AGENTS.md` over the diff.
- [ ] **Step 3: After every task, the coordinator runs `npm run check` once on the integrated branch, requests the independent review, and commits.**

## Not in this slice

- **`until-met` standing goals** and acceptance 7's `until-met` half (continuous autonomy delivery step 5).
- **C17's goal digest:** history, touched paths, failures, decisions, open items, and moving the rows into it.
- **The owner's agreement in `objective_verdicts`** and the per-profile agreement cell (call 14).
- **The outcome ledger's goal roll-up** showing the latest agent assessment.
- **The lineup warning** in the enrollment view and `repo init` (call 16).
- **The router avoiding `evaluators` profiles** for a cycle's tasks (call 15).
- **`merged` and `landed` receipts at the verdict** (call 8).
- **Citation handles and the `citations` and `citation-form` criteria** (delivery step 7).
- **Rubric items beyond `owner-text` and `method-applied`,** and rubric versions above 1.
- **`objective_log` overflow** for records whose log reaches its share.
- **C18 attention events** and the daily digest's verdict items.
- **The Mac app's verdict display.**
- **Follow-ups** (delivery step 6) and **finding measures** (delivery step 7).
