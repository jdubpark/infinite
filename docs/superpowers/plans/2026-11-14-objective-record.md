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
| Owner ops and prompts | `POST …/record`, creation `criteria`, the record digest in prompts and the context file, the `evaluators` lineup slot, the store module `objective` | The record |
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
- Decision answers as record changes: step 3, for the intent check's questions.
- `infinite team record`, every web, phone, and Mac screen, and relay access.
- Records for mission subteams and for missions (left open by the design).
- A record for a run that settled before this change. It gets one only if a continuation brings a new plan.
- A goal removal path. `goals.ts` has none.
- Steps 3 to 7.
