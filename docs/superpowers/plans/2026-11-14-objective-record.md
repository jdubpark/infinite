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
