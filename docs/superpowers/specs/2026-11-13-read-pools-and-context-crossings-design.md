# Read pools and context crossings (INF-181 amendment)

Date: 2026-11-13. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`. It defines contracts C16 and C17 and carries decision D6 of the continuous autonomy amendment.

## Intent

The owner wants continuous, autonomous agent swarms that do not blow up context or spend. Two limits stand in the way.

Read work is cramped. A coordinator gets one batch of one to three scouts before planning. Scouts share the four write slots and the run's attempt limit, so a wide read uses up implementer capacity. An invalid batch blocks the run.

Context moves by copying. Every member's context file carries every earlier report and check output. A goal's next cycle gets one line per reviewed cycle and nothing about failures.

This design adds a read pool: read-only members requested in phases, validated by the host before any launch, and bounded by their own ceilings and allowance. It names six context pools and gives every crossing between them one typed record: a fixed-schema digest, a handle to the full artifact, and provenance. It defines the goal digest, which carries a goal into its next cycle. It adds two isolations on purpose: an evaluator that sees only the artifact and the criteria, and a quarantined reader for outside content.

The amendment's principle applies throughout. A read is reversible and holds no write authority, so the host runs it without the owner, inside the spend fuse (C13). A reader's output is a claim. Nothing here establishes an outcome.

## Current state

Observed in this worktree:

- A project manager may report `explore` once per run, before planning, with 1 to 3 scout tasks (`teamReportSchema` in `packages/host/src/team-types.ts`). A scout task has an id, a title, instructions of at most 4,000 characters, and a profile. `consume` in `packages/host/src/teams.ts` refuses a second batch with `discovery-already-used`.
- A scout's profile must be in `lineup.implementers` (`taskProfiles`). The scout prompt says "Do not implement, commission more agents, or expand the assignment" (`teamPrompt`). A scout can report only `findings`, `question`, or `blocked` (`roleAcceptsReport`), so it cannot request members.
- Scouts and implementers share one worker pool. `holdsWorkerSlot` counts both against `run.parallelism`, which is 1 to 4 under `capacityCeiling` (2 for a handoff run).
- Every member counts against the run's attempt limit (`assertBudget`): the goal's or handoff's `maxMembers`, else 60. A goal cycle gets at most 60, bounded by the goal's remaining allowance (`packages/host/src/goals.ts`). The goal default is 24 attempts, scouts included (`docs/teams.md`).
- The host-wide session limit is `maxSessions`, default 24 (`packages/host/src/config.ts`). A member start waits while that many sessions run.
- An invalid `explore` (duplicate ids, an unknown profile, `parallelism` above the ceiling, a second batch) throws in `consume` after the report is recorded. These codes are not in `automaticRecoveryCodes`, so the run blocks.
- One validation already runs before a report is recorded. The session worker refuses a plan that carries `verification` when the assignment has `verificationRefused`, with a 409 whose text tells the member how to correct it (`packages/host/src/worker.ts`). The flag travels in the assignment binding.
- Member preparation is a run operation. `operation` refuses a second pending operation, so the members of one run are cloned one at a time. Each member, scouts included, gets its own clone.
- No team member has a turn cap. The host stops a member after `teams.stallMinutes` (default 30) without activity, at a goal deadline, or at the attempt limit.
- The scout's assignment JSON sits inside the role instructions, before shared sections such as the reporting instructions (`teamPrompt`). Two scouts' prompts diverge there.
- `teamContext` (`packages/host/src/team-prompts.ts`) writes every non-permission member's report (`memberReports`) and every check into the context file. A check keeps the last 65,536 characters of output (`packages/host/src/team-workspace.ts`). Prompts have an 80 KiB limit.
- A goal's next cycle receives `previousWork`: one line per reviewed cycle, made of the brief's title and expected outcome (`goals.ts`). Blocked and failed cycles carry nothing. The schema allows 16 lines of 2,000 characters (`teamGoalContextSchema`), and `createForGoal` parses it. `maxRuns` is at most 10 today, so a 17th line never arises.
- The duels design defines a blind judge whose context file holds no task list, member report, or review (`2026-11-12-duels-design.md`).
- A Claude Code member can run provider-native subagents. Usage capture reads their transcripts for usage only (commit 2513cf9).

Not verified: context file sizes on a deployed host; whether each provider exposes turn boundaries the host can count; whether each provider can enable a web tool for one member alone; whether a provider's own system prompt, which can name the working directory, keeps a shared prefix cacheable across members in different clones.

## Goals

1. A coordinator gathers wide read evidence without spending write slots or implementer attempts.
2. The host validates every read request before any launch and returns fixable errors to the requester.
3. Fan-out stays bounded in count, depth, and effort, with no usage figure in any prompt.
4. Every crossing between context pools has one record shape, so the facts a summary loses survive.
5. A goal's next cycle starts from a bounded digest of what happened, failures included.
6. Verification and outside content are isolated on purpose.
7. Context reduction turns on only after sizes are measured.

## Non-goals

- Free-form chat between agents, replies, threads, or messages addressed to a member.
- A member that starts another member. The host launches every member.
- Parallel writers. The write pool stays at four, with one writer per integration branch.
- Read fan-out for a mission coordinator. It reads its repositories itself and dispatches subteams.
- Money ceilings. The spend fuse (C13) admits or refuses every launch.
- Promotion of a finding into a lesson. C15 owns it. This design defines only the crossing and the inbox.
- Rules for provider-native subagents inside a member. They stay inside the member's working context and its time cap.

## Anti-goals

- **A swarm that is wide because it can be.** Multi-agent systems changed success by −0.3% on average across 260 matched-budget configurations, at 1.6 to 6.2 times the tokens, and independent agents with no checker did worst (arXiv 2512.08296). Width needs a list to iterate over.
- **A cap the agent must sense.** Token use for one task varied up to 30 times, and agents cannot sense their budget (arXiv 2604.22750). Caps are static, and the host enforces them.
- **A digest written by a model.** It would lose the facts this design exists to keep.
- **Outside text with authority.** Web content reaches a writer only as schema-checked, labelled data.

## Approaches

**A. Widen today's discovery.** More scouts and more batches in the shared worker pool. It is small. Scouts would still take write slots and implementer attempts, which D6 forbids, and an invalid batch would still block the run.

**B. Let members start provider-native subagents.** It is cheap and exists for Claude Code. The host cannot validate, count, cap, route, or isolate those agents, and Codex and OpenCode differ. It breaks "a member never starts another member".

**C. A host-validated read pool with typed crossings. Picked.** The requester writes a phased plan as a report. The session worker validates it against a grant in the assignment binding, as `verificationRefused` works today. The host validates it again before launch and launches each member. Outputs land in the evidence store as entries with fixed-schema digests. It reuses the report path, the store, and the binding check.

## Design

### 1. The read pool

A read member is a member with role `scout`. It keeps that role, so the outcome ledger's scout rows, the router's `scout` point, and the read-only checks apply unchanged. A read member holds a **read slot**, never a worker slot. `holdsWorkerSlot` stops counting scouts, and a new `holdsReadSlot` counts them with the same status rule.

A read attempt counts against the run's **read allowance**, never against the run's or the goal's `maxMembers`. Retries and a scout lead's second attempt are read attempts.

| Setting (`teams.reads`) | Default | Range | Bounds |
|---|---|---|---|
| `concurrency` | 3 | 1–5 | active read members per requester |
| `listConcurrency` | 8 | 1–8 | the same, for a phase with `forEach` |
| `runConcurrency` | 8 | 1–16 | active read members per run |
| `hostConcurrency` | 12 | 1 to `maxSessions` | active read members on the host |
| `runAttempts` | 40 | 0–200 | read attempts per run |
| `requestAttempts` | 24 | 1–40 | expanded steps per request |
| `outside` | true | boolean | whether quarantined readers may run (part 11) |

*(My call: 3 to 5 follows published practice for parallel research agents. 8 applies only to a list. 12 is half the default `maxSessions`, which leaves room for coordinators, writers, and reviewers.)* A project's team configuration may lower any value and may set `outside` to false. A run pins the values at creation. Under D1 a goal's next cycle is a new run, so its allowance renews. `runAttempts` 0 turns the pool off. These settings are outside the routine approval digest of C11, because they bound read work and never widen write authority. *(My call.)* Learning never changes them (C15 class C).

The pool needs the evidence store, because outputs live there. When the store is `unavailable` at run creation, the run pins the pool off, and `explore` works exactly as today.

In a run with the pool on, an `explore` report becomes a one-phase request whose tasks are `findings` steps at `standard` effort. Its `parallelism` still sets the write pool's limit. *(My call: older prompts and fixtures keep working.)*

### 2. Read requests

A project manager or a scout lead sends a `read` report:

```ts
type ReadRequest = {
  kind: "read";
  summary: string;                 // why the evidence is needed, ≤ 2,000
  concurrency?: number;            // ≤ concurrency, or ≤ listConcurrency when a phase has forEach
  phases: { id: string; steps: ReadStep[] }[];   // 1–4 phases, 1–6 steps each, run in order
};
type ReadStep = {
  id: string;                      // taskId rules, unique in the request
  title: string;                   // ≤ 100
  instructions: string;            // the brief, ≤ 4,000
  agentProfileId?: string;         // from lineup.implementers; optional when the router covers `scout`
  paths?: string[];                // read focus, ≤ 16, ownedPath rules
  output: "findings" | "list" | "verdict" | "locations";
  effort?: "small" | "standard" | "large";       // default standard
  forEach?: { step: string; maxItems: number };  // a `list` step of an earlier phase, maxItems 1–16
  lead?: { maxAttempts: number };  // project manager only, 1–12
  verify?: true;                   // project manager only: artifact-only context, part 11
  source?: { refs: string[] };     // 1–8 https URLs or `evidence:N` goal evidence items, part 11
};
```

The output schemas are a fixed set. *(My call: a free JSON schema per step would be a second language for the host to check and digest.)*

- `findings`: today's shape, a summary and 1 to 12 `teamEvidenceSchema` items.
- `list`: a summary and 1 to 32 items of `{ key, title, source }`. Only a `list` feeds `forEach`.
- `verdict`: `met`, `not-met`, or `inconclusive` (the C14 vocabulary), the criterion judged, and 1 to 8 evidence items.
- `locations`: a summary and 1 to 24 items of `{ path, symbols, role }`.

A reader reports `{ kind: "read-result", output, partial, notes?, …fields }`. `notes` holds the claim lists of part 9: `decisions`, `forSiblings`, and `open`. The session worker checks that `output` names the step's schema.

A project manager may send at most 3 read requests per run revision, and a scout lead one. *(My call: a round limit stops loops that the allowance alone would permit.)* The objective record's intent check may ask up to 3 scout questions, and the host builds that read request on the project manager's behalf. It passes the same `validateReadRequest`, counts as one of the project manager's 3 requests per run revision, and uses the same allowance and ceilings.

### 3. Validation

One pure function, `validateReadRequest(request, grant)`, runs twice with the same rules.

**In the session worker, before the report is recorded.** At launch the host puts a `readGrant` in the assignment binding: the requester kind, the allowed profile ids, the pinned settings, the allowance left, a lead's reservation, the router's coverage of `scout`, the outside-read profiles, and the keys of the read steps running or complete in this revision. A failing request gets a 409. Its text lists every error with its field path and a fix, and says that this is not a denial. No `team-report` event is written, so the member corrects the request and reports again in the same session.

| Code | When |
|---|---|
| `unknown-profile` | A profile is not in the pool, or is missing where the router does not cover `scout` |
| `forward-reference` | `forEach` names a step in the same or a later phase, or a step that is not a `list` |
| `repeated-step` | Two steps share an id or a key |
| `duplicate-running` | A step's key equals a read step running or complete in this revision. The text names that step, whose output the requester receives |
| `over-ceiling` | Phases, steps, `maxItems`, `concurrency`, a lead's `maxAttempts`, or the expanded total exceed a setting, or the total exceeds the allowance left |
| `not-granted` | The member may not request: a reader under a lead, a quarantined reader, a lead's second request, a fourth round, or a run with the pool off |
| `outside-off` | A `source` step where `outside` is off, on a profile without a verified outside-read tool, or that would start a lineage above the cap of part 11 |

A step's **key** is the SHA-256 of its normalized instructions (whitespace collapsed, lower case), sorted paths, output, `forEach` source, and `source` refs. The profile is not part of it. A `forEach` step counts as `maxItems` steps, and a lead step as 1 plus its `maxAttempts`, so the total is known before any launch.

The session worker refuses at most 2 times per requester attempt, and records the third report as sent. *(My call: 2 matches `automaticRecoveryLimit`.)*

**In the host process, before launch.** `consume` runs the function again against the current run. A difference can come only from work that started after the requester launched. A late duplicate is not an error: the host marks the step `joined` to the earlier one. A `joined` step settles when the step it joined settles, and takes that step's status and output handle. If the allowance fell below the request, the host admits whole phases in order and records the rest as `refused: allowance`. Any other failure, the third report included, refuses the request. A refusal never blocks the run. The host records `read.refused` with the errors and starts the requester's next attempt with them in its context file.

### 4. Phases and results

The sealed run record keeps admitted requests under `run.reads`: per request its id, revision, requester, depth, and status, and per step its key, status, member ids, and the handle of its output entry. It holds no output text. *(My call: outputs are append-heavy, and C1 keeps those out of sealed documents.)*

Phase k+1 starts when every step of phase k is `complete`, `partial`, or `failed`. A `joined` step counts only after it has settled with the status of the step it joined, so a `forEach` never expands before its list exists. A `forEach` step expands when its phase starts: one step per item of the source list, up to `maxItems`, with the item appended to the brief as data. Items beyond `maxItems` are recorded as `truncated`. A failed or empty source expands to nothing, and the phase goes on.

A queued step starts when a read slot is free under the requester's, the run's, and the host's concurrency, and the fuse (C13) admits the launch. A step that cannot start waits. It holds no slot, and the run's deadline keeps running.

Read preparation has its own operation lane, separate from the run's single pending operation, with at most 2 clones at once. A restart marks an unresolved read preparation failed, and the step retries. *(My call: a read clone has no result to lose, so waiting behind integration adds only delay.)*

Each output is ingested as a `report` entry (blackboard part 3) with a crossing record (part 9). When the last phase ends, the host starts the requester's next attempt. For a project manager, that is the planning attempt that follows discovery today. Its context file has a `reads` key with each step's status, crossing digest, and entry handle. Its prompt has one line per step, at most 4 KiB in total. Until the project's rollout stage reaches `tools` (part 12), the context file also carries the full outputs of this request, at most 256 KiB, cutting the earliest phases to digests first.

A reader that changes a file fails its step, and its clone is removed. The run does not block. *(My call: today `read-only-role-changed-files` starts PM recovery, which a read step does not need.)*

### 5. Scout leads and depth

A step with `lead` starts a **scout lead**: a read member whose grant allows one read request. Its readers' grants allow none. Depth is therefore one read-only level below a lead, and at most two below the project manager.

At admission the host reserves `lead.maxAttempts` from the run's allowance. The lead's request must fit the reservation, and the lead's second attempt counts in it. When the lead reports `read`, its attempt ends and it holds no slot. When its readers finish, the host starts its second attempt, which reads their digests and must report `read-result`. *(My call: a new attempt, as the project manager gets after discovery. Native resume would keep the lead's cache. The builder may add it as the permission coordinator's `turns` do.)* An unused reservation returns to the allowance when the lead ends.

A lead cannot be quarantined and cannot request a lead.

### 6. Effort caps

Every read step carries a static cap, chosen by its `effort`:

| Effort | Turns | Minutes | Attempts |
|---|---|---|---|
| `small` | 12 | 8 | 2 |
| `standard` | 25 | 15 | 2 |
| `large` | 50 | 30 | 2 |

*(My call: today's only timer is a 30-minute stall window. With these caps, a phase of readers ends in about the time a stall takes to notice.)*

The brief states the cap once, as fixed numbers: "You have at most 25 turns and 15 minutes. Before either, report what you have, with `partial: true` if it is incomplete." The host never tells a member how much it has used. No usage figure enters a prompt (C9 rule 3).

The host enforces minutes from launch, including time spent waiting on a prompt, plus a 2-minute grace. *(My call: a read step has no owner in its loop.)* It enforces turns where the provider exposes a turn boundary it can count, and passes the provider's own flag where one exists, such as Claude Code's `--max-turns`. At a cap the host stops the member. If the member posted `finding` entries, the step ends `partial` with them as its output. Otherwise it ends `failed: cap`.

A stall, a provider limit, or a missing report starts the second attempt. A cap hit does not, because a retry would double the effort. A limit switch starts the second attempt on the fallback profile. An attempt's model never changes after launch.

### 7. Prompts

A reader's prompt has two parts, split by a fixed marker line. The **prefix** is the same bytes for every step of one request on one profile: the reader role text, profile instructions, context scope, objective and owner direction, the request's `summary`, the read-only rules, all four output schemas, and the reporting instructions. The **suffix** holds the step id, title, brief, paths, item, output name, and cap. Later readers of a request then read a cached prefix. The host records the prefix's SHA-256 on `read.step-started`.

The prefix holds no member index, attempt count, or time, so it does not change between launches. The 80 KiB limit applies to the whole prompt.

### 8. The six context pools

| Pool | Holds | Writers | Readers | What may cross out |
|---|---|---|---|---|
| Member working context | One attempt's prompt, context file, clone, scratch directory, native transcript, provider-native subagents | The host (prompt, file); the member (clone, scratch, transcript) | That member. The host reads its report and journal | Its report, entries, and read output, each as a crossing. The transcript and reasoning never cross |
| Run blackboard | A run's entries and events (blackboard design), read results, crossing records | The host; members as claims; the owner as directions | Members of the run within scope; the run's mission coordinator | A goal digest to the next cycle, a mission message, a finding to the knowledge inbox, events to the evidence pool |
| Mission pool | Mission-scoped `contract` and `blocker` entries, mission state, coordinator messages | The mission coordinator and the host | The coordinator; subteam members, for entries that address their subtask | A subtask objective or a mission-scoped entry into one subteam. Nothing else crosses a project boundary (C9 rule 9) |
| Project knowledge | Guidance files, Workspace Memory records, adopted lessons (C15), the knowledge inbox | The owner; the adoption path of C15 | Members, through the knowledge snapshot of C7 | A lesson into a member's context, checked against its citations at use (C15) |
| Evidence pool | Events, outcomes, signals, usage, routing decisions, scorecards | The host only | Host components and owner views | Nothing into a prompt, ever (C9 rule 3). Numbers may pool across one tenant's projects as priors (C9) |
| Eval pool | The eval corpus, trials, grades, holdout sets, gate receipts | The harness and the grader identity | The harness. A trial member reads only its own assignment | A gate receipt to adoption (C15). Nothing into a production prompt |

Events reach the evidence pool through the outbox of C2. They carry no member text, so they need no digest. Every other crossing that carries text uses the record of part 9.

### 9. Crossing records and the crossing digest

```ts
type Crossing = {
  crossingId: string;                       // deterministic over from, to, and handle
  from: { pool: Pool; scope: string };      // Pool: the six pools of part 8; scope: a run, mission, project, or goal id
  to: { pool: Pool; scope: string };
  author: "host" | "member" | "owner" | "mission-coordinator";
  authorRef?: { memberId: string; role: TeamRole; profileId?: string };
  authority: "receipt" | "claim" | "direction";
  digest: CrossingDigest;
  handle: { kind: "entry" | "commit" | "check" | "artifact"; id: string; bytes: number; sha256: string };
  provenance: { runId?: string; revision?: number; taskId?: string; stepId?: string;
                inputs: string[]; quarantined: boolean; at: string };   // inputs: the crossings it was built from
};
type CrossingDigest = {
  v: 1;
  outcome: "complete" | "partial" | "failed" | "refused";
  touched: { path: string; ids?: string[]; op: "read" | "changed" | "added" | "removed"; by: "receipt" | "claim" }[];  // ≤ 24
  decisions: { what: string; why: string }[];          // ≤ 6, each field ≤ 240 bytes, claims
  failures: { signal: string; where?: string; class: "check" | "stop" | "refusal" | "conflict" | "claim"; by: "receipt" | "claim" }[];  // ≤ 6
  forSiblings: { note: string; paths?: string[] }[];   // ≤ 4, each ≤ 240 bytes, claims
  open: string[];                                      // ≤ 4, each ≤ 240 bytes, claims
  omitted: { touched: number; decisions: number; failures: number };
};
```

The four lists are the classes that summaries lose: files and identifiers touched, reasons for decisions, failure signals, and discoveries that matter to a sibling. A digest is at most 2 KiB. *(My call: room for about 24 paths and a dozen short lines.)*

**The host builds what it can.** Changed, added, and removed paths come from Git between the member's base and its commit, as `changedPaths` does today. Failure signals come from check exit codes, stop reasons, and refusal codes. The outcome comes from run state. These fields are receipts. Member text comes only from the report's own `notes` and evidence sources, marked as claims. No model writes or rewrites a digest.

**Merging is incremental.** `mergeDigest(a, b)` unions `touched` by path, keeping a receipt over a claim and the stronger operation. It keeps the newest decisions and open questions, the latest failure per signal and place, and unique sibling notes. Each list keeps its cap and adds what it drops to `omitted`. The run digest is the merge of the run's crossings in order, updated at each ingest. It is never rebuilt from text.

Crossings live in the evidence store, in a `crossings` module. Plain columns hold the pools, author, authority, quarantine flag, sizes, and times. The digest, handle, and provenance are encrypted per row (C1). A run-scoped crossing is deleted with its run. The secret scan of blackboard part 4 applies to every member field.

Every member report kind except `permission-decision` gains optional `notes` with the three claim lists. The prompt asks for them in one line.

**The knowledge inbox.** A `finding` entry crosses into its project's knowledge inbox when its body sets `candidate: true`, an optional field this design adds, or when the owner nominates it. The objective record design adds a second optional `finding` field, `assumption`, which names an assumption id, and this design carries it unchanged. The crossing copies the body and citations through `promotionSource` (blackboard part 9), because the entry is deleted with its run. The inbox keeps a row for 90 days unless C15 takes it. *(My call.)* A quarantined crossing never enters the inbox. Outside content reaches project knowledge only through an owner direction.

### 10. The goal digest

The goal digest carries into a goal's next cycle (decided 2026-11-13). It replaces `previousWork`.

`GoalService` builds it when it starts the next cycle, from the previous cycle's run digest, run summary, and run record. No model takes part.

```ts
type GoalDigest = {
  v: 1; cycle: number;                       // the cycle that ended
  history: { cycle: number; status: string; line: string }[];   // ≤ 16, newest first, each line ≤ 240 bytes
  touched: CrossingDigest["touched"];        // receipts only, merged across cycles, ≤ 24
  failures: CrossingDigest["failures"];      // unresolved at cycle end, ≤ 6
  decisions: CrossingDigest["decisions"];    // ≤ 6, claims
  open: string[];                            // ≤ 4, claims
  criteria?: { criterion: string; status: "met" | "not-met" | "inconclusive" | "pending-owner";
               check?: string }[];           // C14, ≤ 8; check: the C14 check label, kind plus name, ≤ 120 bytes
  handles: { runId: string; reviewedHead?: string };
  outsideContent: boolean;                   // part 11, inherited quarantine
  unclearedHead?: { runId: string; head: string };   // newest head of the entry that applies
  omitted: { cycles: number; touched: number; failures: number };
};
```

`history` has one line per cycle, blocked and failed cycles included. A line is the brief's title and expected outcome, or the block code and stop class. `criteria` is the evaluator's provisional status per named criterion, labelled an agent assessment (C14), so the coordinator can choose the next opportunity. It never carries a score. Under C14 this status is a task finding, the same class as a review finding, and not a learning signal, so C9 rule 3 does not bar it. `check` is the C14 check label: the check kind plus its name, at most 120 bytes (objective record design, part 5).

The goal digest is at most 8 KiB. *(My call: a tenth of the prompt limit, and a quarter of today's worst case of 16 lines of 2,000 characters.)* At the bound, the oldest history lines go first, then claim fields, then receipts, and `omitted` counts them. A standing goal can run any number of cycles without its context growing, and the 16-line limit of `previousWork` no longer applies.

Nothing else carries. In particular: entries, reports, transcripts, check output, rubric scores, owner ratings, usage, routing decisions, posteriors, eval results, gate receipts, withdrawn entries, permission evidence, and quarantined text.

The goal digest goes into `TeamGoalContext` as `digest`. Every role's context file holds it under `authority.goal`. The project manager's prompt holds its history and failures, at most 2 KiB.

### 11. Isolation on purpose

**Artifact-only context.** A verifier or evaluator works from the artifact and the criteria, never from the author's reasoning. Its context file has `isolation: "artifact"`. It holds the objective, the goal's success criteria, non-goals, and allowed paths, the named checks of C14, the reviewed head and base commit, the changed files of `run.changes`, and the host's check receipts with handles. It holds no `memberReports`, no brief, no goal digest, and no entry except `check`, `integration`, and `direction`. Its `entry_list` and `entry_get` serve only those kinds. C14's evaluator uses this context, and so does a `verify` step. *(My call: the brief is the author's framing of success.)* The reviewer keeps today's context (C9 rule 3). One added verification step raised task success by 15.6% in a study of 1,642 failure traces (arXiv 2503.13657).

**Quarantined readers.** A step with `source` reads outside content: a web page, or a document supplied as a goal evidence item. Its member is quarantined for that attempt.

- It gets no repository clone, no context file beyond its brief, and no entries. It works in an empty scratch directory. *(My call: with a fetch tool and a clone, a reader could leak repository content through a request URL.)*
- Only it has the outside-read tool. Every other member has that tool turned off where the provider allows it. Where a provider supports a domain list, fetches are limited to the hosts of `refs`.
- It holds no write or delivery authority, no entry tools, no lead, and no delegated permission answers. A permission prompt it raises stays unanswered until its time cap, and the daily digest lists it (C18).
- The session worker checks its report against the output schema, the field caps, and the secret scan. Its crossing has `quarantined: true`. Every prompt renders its text in a block labelled as quarantined outside content.
- A run carries `outsideContent` when its own crossings include a quarantined output. Such a run is a **source**. A run also carries it, by inheritance, when its base contains the head of a source that the owner has not cleared. A run that carries `outsideContent` does not merge automatically, and it ends at a pull request for the owner. *(My call: the brief quarantines a run that reads outside content. Goal continuity holds, because the next cycle clones the reviewed head.)*

**Inherited quarantine.** Quarantine passes from cycle to cycle with the code, so a later cycle that does only local work on a quarantined head cannot merge it automatically.

The record keeps a frontier, not a history.

- The run record and the goal record each keep `outsideContent.lineages`, both in sealed host state. One entry stands for a chain of uncleared sources: `{ newest: { runId, head }, oldest: { runId, head }, sources: number }`. A source enters the record when its reviewed head exists.
- When a new source's reviewed head contains an entry's newest head, the new source replaces it: `newest` becomes the new head, `oldest` stays, and `sources` grows by one. A head that contains several entries merges them into one entry, keeping the oldest `oldest` and the sum of `sources`. Otherwise the source starts a new entry. Each goal cycle clones the previous cycle's reviewed head, so a goal usually holds one entry.
- At run creation, the host copies from the parent run or the goal every entry whose oldest head is an ancestor of, or equal to, the new run's base commit. A run started fresh from the base branch inherits nothing. A flagged head cannot reach the base branch without an owner action. *(My call.)*
- Inheritance never makes a run a new source. Only a run's own quarantined crossings do.
- An entry stays until an explicit owner action clears it. The owner merges the pull request of its newest head, which the outcome ledger's base branch scan records as a landing of that head; that head contains the older ones. Or the owner records a clearance for the newest head (`POST /api/teams/:id/outside-content/clear`, owner only, with a `requestId`). Clearing an entry clears every source it stands for and removes it from every run and goal record that holds it. A landing or a clearance of an older head does not clear the entry, and the clearance route answers 409 with the newest head.
- A goal or a run holds at most 3 entries that do not descend from one another. *(My call: more separate lineages mean more pull requests the owner has not reached.)* At the cap, a new `source` step that would start a fourth lineage is refused with `outside-off`, and the reason names the uncleared newest heads. It is refused until the owner clears one. A source that extends an existing entry is not refused.
- The delivery gate reads a run's entries when delivery starts. A run whose entries have all been cleared by then may merge automatically.
- The goal digest carries only `outsideContent`, a boolean, and `unclearedHead`, the run id and newest head of the entry that applies to the next cycle's base. It carries no quarantined text and no list.
- The daily digest lists each entry's newest head, its oldest head, and its count of sources under "Waiting on you" (C18).

The Linear issue snapshot already enters prompts as task data, and this design does not change that. *(My call: the owner mapped the issue, so it is scope the owner supplied.)*

### 12. Context growth: measure, then reduce

The context file copies every earlier report and check output forward, so it grows with each member. The order is fixed: measure first, then reduce.

1. **Measure.** At each member start the host records prompt bytes, context file bytes, entry digest bytes, `reads` bytes, and goal digest bytes. Read receipts add served bytes (blackboard part 5). `GET /api/evidence/context?project=ID` and `infinite evidence context --project ID` report the median, 95th percentile, and maximum per role and per member start index within a run. The index shows the growth.
2. **Stages.** Each project has a rollout stage: `measure`, `tools`, `reduce`, `gate`. The host advances it in the decided order: to `tools` after 20 settled runs with complete byte rows; to `reduce` after 10 more runs with `tools` on and no store outage at a member start; to `gate` after the report gate's rehearsal passes for each provider in the project's lineup, and 10 more runs. *(My call on the counts: enough runs for a stable median per role.)*
3. **Pins.** A run pins the stage's switches at creation. An explicit owner value in `teams.blackboard` wins over the stage. The stage is host state outside the C11 digest, so an advance never blocks a routine. *(My call.)*
4. **Fallback.** A store outage at run creation pins every switch off, as the blackboard design says. A stage never advances during an outage.

No size figure enters a prompt.

### 13. Owner surface

- `GET /api/teams/:id/reads`: requests, phases, steps, statuses, refusals, and handles. `infinite team reads ID [--json]`.
- `POST /api/teams/:id/reads/:requestId/cancel`, owner only, with a `requestId`. Running readers stop, and their steps end `failed: owner`.
- `GET /api/evidence/context?project=ID`, and the CLI of part 12.
- `GET /api/goals/:id` includes the goal digest.
- Refusals, truncations, and cap hits go to the daily digest (C18). None interrupts the owner.

## Authority and safety

- The host launches every member. A request is a claim of need and starts nothing by itself.
- Every read launch passes the spend fuse (C13). The ceilings here bound count and depth only.
- Reads run in `supervised` and `autonomous` mode alike (C12), because a read is reversible and holds no write authority.
- A read member is read-only. The host checks its clone as it checks a scout's today.
- Profiles come from `lineup.implementers`, under C9 rule 6 for contributor profiles. The router may choose at admission and never changes a running attempt.
- Caps are fixed at launch. No usage figure, posterior, routing decision, or eval result enters a reader's prompt (C9 rule 3).
- A crossing names its author and authority. Member text is always a claim and always rendered as untrusted data (C3).
- A read never changes scope, owned paths, permissions, delivery policy, or the profile set (C9 rule 2).
- Quarantine removes the clone, the entries, and every write, delivery, and permission path from an outside reader. Its run, and every run built on its uncleared head, does not merge automatically until the owner clears it.
- Content crosses a project boundary only through the mission pool (C9 rule 9).

## Failure modes

| Failure | Behaviour |
|---|---|
| Store unavailable at run creation | The run pins the pool off, and `explore` runs as today. The goal digest keeps its receipt fields from the run record and marks claim fields `unavailable` |
| Store unavailable mid-run | Ingest waits in the journals. Admitted steps run. The requester's next attempt waits up to 10 minutes for ingest, then starts with those steps marked `unavailable` |
| Third invalid request | Refused at consume. The run continues, and the requester's next attempt receives the errors |
| Allowance runs out mid-request | Remaining phases are refused as `allowance`. The requester receives what finished |
| Host ceiling or fuse holds a launch | The step waits without a slot. The owner sees `waiting` and the reason |
| A reader stalls or hits a provider limit | One more attempt, then `failed` |
| A reader reaches a cap | Stopped. `partial` with its posted findings, or `failed: cap` |
| A reader changes a file | The step fails and its clone is removed. The run is not blocked |
| A `forEach` source fails or is empty | It expands to nothing, and the phase goes on |
| A duplicate races the session worker check | `joined` to the earlier step |
| A restart during read preparation | The intent is marked failed, and the step retries |
| A provider prompt names the clone path | The prefix cache misses. `read.step-started` shows it. Results are unaffected |
| A goal digest reaches 8 KiB | Oldest history goes first, then claims, then receipts, all counted |

## Delivery order

1. **Measurement.** The byte roll-up per project, role, and start index, and the stage state held at `measure`. Needs blackboard phase 2. No member-visible change.
2. **The read pool.** Read slots, the read allowance, settings and pins, and `explore` mapped onto one phase. Scouts stop holding worker slots and stop counting in `maxMembers`.
3. **Read requests.** The `read` and `read-result` kinds, the four schemas, `validateReadRequest`, the grant, refusals in the session worker and in `consume`, phases, `forEach`, the read lane, effort caps, and the `read.` events. Needs blackboard phase 2 for report entries.
4. **Scout leads.** `lead`, reservations, and the second attempt.
5. **Crossings.** The `crossings` module, the digest builder, `mergeDigest`, report `notes`, the `reads` context key, and the stable prefix.
6. **The goal digest,** built in `GoalService`, replacing `previousWork`.
7. **Isolation.** The artifact-only context, with C14. Quarantined readers, one provider at a time as its outside-read switch is verified. The knowledge inbox, with C15.
8. **Rollout.** Automatic stage advance for the blackboard switches, once blackboard phases 3 to 5 exist.

## Acceptance

1. Two implementers hold the write slots at a run limit of 2. A recovery project manager requests 5 readers with `concurrency` 5. All 5 start without waiting, `run.parallelism` stays 2, and `maxMembers` use is unchanged after they end.
2. A request names an unknown profile, a `forEach` over a step in its own phase, and two steps with one id. The first report gets one 409 that lists all three with field paths, and no `team-report` event exists. The corrected request is recorded.
3. A project manager sends three invalid requests. The third is recorded and refused at consume. The run is not blocked, and the next planning attempt's context file holds the errors.
4. Phase 1 has a `list` step that returns 11 items. Phase 2 has a `forEach` with `maxItems` 8. Eight readers start, at most `listConcurrency` at once, and the step records `truncated: 3`.
5. A request whose expanded total is 41 under `runAttempts` 40 is refused with `over-ceiling` before any launch.
6. Three runs each want 5 readers under `hostConcurrency` 12. Twelve run. The rest wait and start as slots free.
7. A reader under a scout lead sends a `read` report and gets 409 `not-granted`. Its prompt holds no read request instructions.
8. A `small` reader is still running at 10 minutes. The host stops it. It had posted two findings, so the step ends `partial` with them. Its prompt holds "12 turns and 8 minutes" and no usage figure.
9. Two steps of one request on one profile have byte-identical prompts up to the marker line, and their `read.step-started` events carry the same prefix digest.
10. An implementer's crossing digest lists exactly the paths Git reports as changed, marked as receipts, and its `notes.decisions`, marked as claims. The digest is at most 2 KiB, and so is the run digest after 13 crossings.
11. Cycle 1 ends blocked after a failed check. Cycle 2's goal digest has a history line with the block code and the check failure with its handle, and no report, rubric, rating, or usage. After 20 cycles the digest is at most 8 KiB, and the 21st cycle starts.
12. An evaluator's context file has no `memberReports`, brief, or goal digest. Its `entry_list` returns only `check`, `integration`, and `direction` entries.
13. A `source` step on a profile without a verified outside-read tool is refused with `outside-off`. On a verified profile the reader has no clone, its `entry_post` gets 403, and a report with an extra field gets 409. Its crossing has `quarantined: true`, it never enters the knowledge inbox, and the run ends at a pull request.
14. Cycle 1 of a goal reads outside content and ends at a pull request. Cycle 2 does only local work on cycle 1's head. It inherits `outsideContent` and also ends at a pull request. Its goal digest shows `outsideContent: true` with cycle 1's head, and the daily digest lists that head under "Waiting on you". The owner merges cycle 1's pull request, and the base branch scan records its landing. Cycle 3, built on cycle 2's head, carries no uncleared entry and may merge automatically. If cycles 4 and 5 each read outside content, the goal record holds one entry: newest cycle 5's head, oldest cycle 4's head, 2 sources. With 3 separate uncleared lineages, a `source` step that would start a fourth is refused with `outside-off` naming the three newest heads.
15. With the store unavailable at run creation, a `read` report gets 409 `not-granted` with text that names `explore`, and an `explore` with 3 scouts runs as today.
16. A project reaches 20 measured runs. The next run pins `tools` on, and earlier runs keep their pins. A project whose owner set `tools: false` stays off.

## Owner decisions

Values to confirm. Each was my call.

1. Read concurrency: 3 per requester (up to 5), 8 for a list, 8 per run, 12 per host.
2. The read allowance: 40 attempts per run, 24 expanded steps per request, `maxItems` 16, 4 phases of 6 steps, 3 rounds per revision.
3. Effort caps: 12 turns and 8 minutes, 25 and 15, 50 and 30, with 2 attempts and a 2-minute grace.
4. Two refusals in the session worker before a request is refused at consume.
5. Digest bounds: 2 KiB per crossing, 8 KiB per goal digest with 16 history lines, 90 days in the knowledge inbox.
6. Rollout per project: 20 runs to `tools`, 10 more to `reduce`, a rehearsal per provider and 10 more to `gate`.
7. A run that carries quarantined output, its own or inherited, ends at a pull request and does not merge automatically. A goal or a run holds at most 3 separate uncleared lineages.
8. Quarantined readers are on by default (`outside: true`) for enrolled projects.

## Left to the builder

- File layout under `packages/host/src/`, and whether read state shares code with `discovery`.
- Field lengths inside the four output schemas, and the refusal text.
- How each provider counts turns, and which providers can enable an outside-read tool for one member alone. Until verified, a provider hosts no quarantined reader and has no turn cap beyond minutes.
- Whether the prefix stays cacheable when a provider's system prompt names the clone path, and whether readers should get a common clone path.
- Native resume for a scout lead's second attempt.
- The `read.` event payloads, within C2's limits.
- Client views of `run.reads` and the goal digest.
- Whether provider-native subagents inside a member count toward its turn cap.
