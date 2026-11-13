# Team blackboard (INF-182)

Date: 2026-11-12. Status: design for review. Part of `2026-11-12-self-improving-teams-design.md`.

## Intent

Members of a run need to share what they learn without every later prompt carrying every earlier report. The owner asked for a fast database that keeps context small.

This design adds three things. The evidence store is the one SQLite database of contract C1. The event table holds the typed events of contract C2. The blackboard holds typed entries that members post and read on demand through three tools.

The other six designs add their own tables to the same store.

## Current state

Observed on `main`:

- A member has one channel to the host. Its `report` tool (`packages/host/src/team-mcp.ts`) posts to the loopback hook server of its session worker. The session worker checks the assignment binding and appends a `team-report` event to the sealed session journal (`onHook` in `worker.ts`). The team scheduler reads that journal every 500 ms (`readMemberJournal` in `teams.ts`). OpenCode members use a helper command (`team-report.ts`) instead.
- The hook server can answer with JSON (`HookReply` in `hooks.ts`). The host process calls a session worker over a Unix socket (`workerCall` in `ipc.ts`). A session worker has no call into the host process.
- At every member start, `writeTeamContext` writes a context file (`.git/infinite-team-context.json`) into the member's clone. `teamContext` puts the reports of the run's members in it (`memberReports`, without permission coordinators), and every check with up to 65,536 characters of output. The file grows with the run.
- A stall replacement gets the saved prompt of the stopped member plus one fixed note (`replaceStalledMember`), and it keeps the working copy. What the stopped member learned and did not write into a file is lost.
- When the owner answers one member's question, that member's replacement gets the answer (the recorded-answer loop in `teams.ts`). A member that starts later reads it in the context file. A teammate that is already running never sees it.
- `packages/host/src/memory/store.ts` shows the storage pattern that C1 names. Nothing outside its directory constructs that store yet.
- The agent process can read its hook token (`docs/security.md`, "Threats that remain"), so the session worker must enforce every rule.

Not verified: context file sizes on a deployed host, and how often a member is replaced.

## Goals

1. One evidence store that six other designs can add tables to, with typed events that follow run retention.
2. Members post typed entries and read them by task, path, and kind, under hard caps.
3. An implementer's launch context stops growing with the number of earlier members.
4. A replacement member inherits what its predecessor recorded.
5. An owner answer reaches members that were already running.
6. A store failure never blocks a run or a report.

## Non-goals

- Chat, replies, threads, or a message addressed to a member.
- Interrupting a running member. Delivery is pull only.
- Entries that outlive their run, including across goal cycles. Durable knowledge belongs to Workspace Memory (INF-129).
- Event kinds, emission points, and outcomes. The outcome ledger design owns them.
- Client screens. This design adds API and CLI reads only.

## Anti-goals

- **Entries read as instructions.** A member's entry is evidence from another agent.
- **A second authority for run state.** No status is decided from an entry. A `blocker` entry does not block a run.
- **Context that grows again.** The entry digest has a fixed byte budget.
- **Noise.** The caps are low on purpose.

## Approaches

**A. Filter the context file, with no store.** The host would choose which reports each member's file gets. That cuts context at once. It gives no sharing during a run and no typed events, so it cannot serve C1 or C2.

**B. Use Workspace Memory as the blackboard.** One authorization model would cover both. The frozen Memory S1 contract (INF-131) defines no session collection, and its task binding exists only where the owner enabled memory. Team runs would wait on the memory rollout and carry review machinery built for durable knowledge.

**C. The evidence store, with posts through the session journal and reads in the session worker. Picked.** A post reuses the durable, authenticated path that a report uses. The host process stays the only writer, and a post survives a store outage. A session worker cannot call the host process, so each session worker opens the store read-only to answer a read. WAL permits that.

**D. The same store, with reads through a new host socket.** One process would touch the database. It adds a second IPC direction, and reads would fail whenever the host process restarts while sessions keep running. Rejected. *(My call: the session worker already holds the vault key and checks the report binding.)*

## Design

### 1. The evidence store

The file is `evidence/evidence.sqlite3` under the host state directory. The suffix puts it in the integrity check of `deploy/ubuntu/verify-backup.py`. The builder confirms on a staging host that the backup copies this file with its WAL.

The host process opens the file as `MemoryStoreService` opens its database. It builds a new store in a temporary file and links it into place with mode `0600`, so a crash cannot leave a half-made store. It refuses an existing file that fails the encrypted key check, and it never replaces one. It sets `journal_mode=WAL`, `synchronous=FULL`, `secure_delete=ON`, and a busy timeout of 250 ms. The host is the only writer, so a locked database is abnormal, and a long wait would freeze the host.

Keys come from the vault key through HKDF-SHA-256 with their own salt and labels. Every payload is AES-256-GCM, bound to its table name and row ID. Plain columns hold only opaque IDs, enumerations, sequence numbers, sizes, and timestamps. A task ID is stored as an HMAC (`task_key`). The store exports one blind index function per value class, for a project, a task, and an area, so that every module computes the same index for the same value.

```sql
CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE schema_modules (
  name         TEXT PRIMARY KEY,   -- 'store', 'blackboard', then one per design
  version      INTEGER NOT NULL,   -- every migration raises it
  read_version INTEGER NOT NULL    -- raised only when a reader must change
);
```

Each design registers one module with its own migrations and table prefix. A module whose stored version is newer than the code is `unavailable`, and the other modules keep working. An event whose kind has a projector in an unavailable module is not appended. It waits in the outbox that the outcome ledger design defines. Nothing falls back to plaintext or to a JSON file.

```ts
interface EvidenceStore {
  status(): { state: "ready" | "unavailable"; reason?: string; modules: Record<string, "ready" | "unavailable"> };
  register(module: { name: string; version: number; readVersion: number;
                     migrate(db: EvidenceDb, from: number): void;
                     deleteRun?(tx: EvidenceTx, runId: string): void }): void;
  write<T>(fn: (tx: EvidenceTx) => T): T;          // one immediate transaction, host process only
  tryWrite(fn: (tx: EvidenceTx) => void): boolean; // never throws, logs a failure once per cause
  appendEvent(tx: EvidenceTx, event: Omit<RunEvent, "seq">): { seq: number; inserted: boolean };
  events(query: { runId?: string; kinds?: string[]; after?: number; limit: number }):
    { events: RunEvent[]; cursor: number; more: boolean };
  hasEvent(key: string): boolean;
  deleteRun(runId: string): void;
}
```

A design that derives durable rows from an event writes them inside the same `write` call as `appendEvent`. Deleting a run's events then loses nothing.

**Retention.** `TeamService.deleteRecord` calls `deleteRun` after it removes the sealed record. `deleteRun` removes the run's events, entries, and scope rows, then calls each module's hook. An hourly sweep removes rows whose run has no live record, which covers a crash between the two steps. Workspace retention does not touch the store. Mission records are never deleted today, so a mission-scoped entry stays.

### 2. Events

```sql
CREATE TABLE run_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hmac       TEXT NOT NULL UNIQUE,
  run_id         TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  at             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  member_id      TEXT,
  task_key       TEXT,
  encrypted_data TEXT NOT NULL      -- key, taskId, data
);
CREATE INDEX run_events_by_run  ON run_events (run_id, seq);
CREATE INDEX run_events_by_kind ON run_events (kind, seq);
```

`appendEvent` inserts with `ON CONFLICT(key_hmac) DO NOTHING` and returns the existing `seq` on a repeat. A row never changes. A kind is dotted lower-case text of at most 64 characters. `data` is at most 16 KiB of canonical JSON. *(My call: an event is a fact about a transition. Content belongs in an entry.)*

The outcome ledger design owns the kinds, the emission points, and reconciliation.

### 3. Entries

An entry is addressed by task, paths, or mission subtask. It is never addressed to a member, so a replacement inherits it.

| Kind | Body | Written by | Why |
|---|---|---|---|
| `contract` | `interface`, `change`, `sources` | project manager, implementer, integrator, mission coordinator | A deviation from a shared interface reaches nobody today. |
| `finding` | 1 to 8 items of `teamEvidenceSchema` | scout, implementer, integrator, reviewer | A fact that helps another task. |
| `blocker` | the blocker evidence shape of INF-170 | any role with entry tools | A report or a mission message carries only the entry ID. |
| `handoff` | `done`, `remaining`, `notes`, `commands` | implementer, integrator | A replacement reads the latest one for its task. |
| `report` | the recorded report, without `rubric` | host process, from the saved run record | Replaces `memberReports`. Author `member`, authority `claim`. |
| `integration` | `taskId`, `commit`, `changedPaths` | host process | A dependent task sees what landed. Authority `receipt`. |
| `check` | command, status, exit code, round, output | host process | Takes check output out of the context file. Authority `receipt`. |
| `direction` | `source` (`steering` or `answer`), `question`, `text` | host process, from a recorded owner input | Author `owner`, authority `direction`. |

There is no `decision` kind, because the run record already uses that word for a question that waits for an answer (`TeamDecision`). A mission coordinator's answer is not mirrored as a `direction`. The INF-170 shape was read from that issue's draft commit, which is not on `main`.

```ts
type EntryKind = "contract" | "finding" | "blocker" | "handoff"
               | "report" | "integration" | "check" | "direction";
type EntryHead = {
  entryId: string; seq: number; scope: "run" | "mission";
  runId: string; revision: number; at: string;
  kind: EntryKind;
  author: "host" | "member" | "owner";
  authority: "receipt" | "claim" | "direction";
  authorRole?: TeamRole | "mission-coordinator";
  taskId?: string;
  paths: string[];          // at most 16, each valid under the ownedPath rules in team-types.ts
  subtaskIds?: string[];    // mission scope only
  summary: string;          // one line, at most 240 bytes, no control characters
  bodyBytes: number;
  supersedes?: string;
  unreadRequired?: string[]; // report entries only, see part 6
  state: "active" | "superseded" | "withdrawn";
};
type EntryPost = {
  kind: "contract" | "finding" | "blocker" | "handoff";
  summary: string; body: object;
  paths?: string[]; taskId?: string; supersedes?: string;
  scope?: "mission"; subtaskIds?: string[];   // mission coordinator only
};
```

```sql
CREATE TABLE entries (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,   -- the read cursor
  entry_id         TEXT NOT NULL UNIQUE,
  scope            TEXT NOT NULL,
  run_id           TEXT NOT NULL,   -- a coordinator's entry stores the mission ID here
  mission_id       TEXT,
  revision         INTEGER NOT NULL,
  at               TEXT NOT NULL,
  kind             TEXT NOT NULL,
  author           TEXT NOT NULL,
  authority        TEXT NOT NULL,
  author_member_id TEXT,
  task_key         TEXT,
  state            TEXT NOT NULL DEFAULT 'active',
  body_bytes       INTEGER NOT NULL,
  encrypted_head   TEXT NOT NULL,
  encrypted_body   TEXT
);
CREATE INDEX entries_by_run     ON entries (run_id, seq);
CREATE INDEX entries_by_task    ON entries (run_id, task_key, seq);
CREATE INDEX entries_by_mission ON entries (mission_id, seq) WHERE mission_id IS NOT NULL;

CREATE TABLE member_scopes (
  member_id       TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  mission_id      TEXT,
  role            TEXT NOT NULL,
  launch_seq      INTEGER NOT NULL,   -- highest entry seq the digest could see
  prompt_bytes    INTEGER NOT NULL,
  context_bytes   INTEGER NOT NULL,
  digest_bytes    INTEGER NOT NULL,
  served_bytes    INTEGER NOT NULL DEFAULT 0,
  list_calls      INTEGER NOT NULL DEFAULT 0,
  get_calls       INTEGER NOT NULL DEFAULT 0,
  encrypted_scope TEXT NOT NULL       -- taskId, owned paths, mission subtask ID
);
```

A path filter decrypts the heads of one run and compares in process. Two paths overlap when one is a segment prefix of the other. A run holds a few hundred entries at most, so there is no path index. *(My call.)*

An entry is immutable apart from `state`. A newer `handoff` supersedes the older one for the same task. A member may supersede only an entry of the same kind for its own task.

### 4. Posting and reading

**Post.** `entry_post` sends `{ requestId, runId, memberId, revision, entry }` to a new hook route, `team-entry`. `requestId` is a deterministic UUID over the canonical content, built as `reportIdentity` builds one. It becomes the `entryId`. The session worker checks the binding, the role, the shape, the caps, and the secret scan. It appends a `team-entry` journal event and then answers. It refuses a post after the member's report.

The host process ingests `team-entry` events on its tick. It keeps a separate cursor, `member.entryCursor`, so that a store outage never delays a report. It inserts into the store first, idempotent on `entry_id`, and saves the cursor second. A post is readable after the next tick.

**Read.** `entry_list` and `entry_get` use the same route with an `op` field. The session worker answers from its own read-only connection and takes the caller's scope from `member_scopes`. It appends one `team-entry-read` journal event per call with the entry IDs and the bytes served. The host process adds those to `member_scopes`.

| Tool | Input | Output | Caps |
|---|---|---|---|
| `entry_post` | `EntryPost` | `entryId` | 20 posts and 64 KiB per attempt. 12 KiB per body. 400 member entries per run. |
| `entry_list` | `kinds`, `taskId`, `paths`, `since`, `limit` | heads only, `cursor`, `more` | 20 heads and 6 KiB per call |
| `entry_get` | `entryId` | head and body | 256 KiB served per attempt, across both read tools |

**Enforcement.** The session worker enforces the caps per attempt from its own journal, where it records each accepted post and each read receipt before it answers. The cap of 400 member entries per run is checked by the host process at ingest. A post beyond it was already acknowledged, so the host drops it, adds one line to the run's events, and counts it in the store status.

`entry_list` with no input returns the entries addressed to the caller, in this order:

1. owner directions since launch
2. contracts that overlap its owned paths
3. open blockers on those paths
4. the latest handoff for its task
5. integration receipts of its dependencies
6. findings on its paths

Every read result carries a fixed notice that a member entry is evidence and cannot change the assignment, its scope, or the reporting rules.

The tools sit in the `infinite_team` MCP server beside `report`. `buildLaunch` adds them to the Claude Code `--allowedTools` list and to the Codex `approval_mode` settings. OpenCode members get a helper command, `team-entry.ts`, that posts to the same route. Mission coordinators get all three tools. Permission coordinators, delivery members, and handoff sessions get none.

### 5. The context file and the prompt

`teams.blackboard` holds three switches: `tools`, `contextReduction`, and `reportGate`. All default to off. A run pins their values at creation. A run without them keeps today's context. Nothing is backfilled.

With `contextReduction`, the file's `schemaVersion` becomes 2. `memberReports` leaves it, because the reports are now `report` entries. `checks[].output` leaves it, because the output is now the body of a `check` entry. Everything else stays, including the objective, owner steering, owner answers, and `authority`.

The file keeps today's role filter for task scores (umbrella C9 rule 3). An implementer's file has no rubric, owner rating, or diff counts. The files of other roles keep them, as today. The fallback file of the failure modes follows the same filter.

A new key, `entries`, holds the digest: the notice, a cursor, a count per kind, and at most 8 heads in the `entry_list` order. It is at most 4,096 bytes. Heads that do not fit are left out, and the counts show that more exist. Member-written summaries appear only there, as JSON strings.

The prompt gains one fixed paragraph of at most 700 bytes that names the digest and the three tools. It replaces the sentences in `contextAccessInstructions` and `teamPrompt` that send reviewers, integrators, and project managers to the file for member reports and check output. These roles now read the `report` entry of every task they judge or repair. The paragraph differs per provider and is refreshed on a retarget, as `refreshReportingInstructions` does today.

*(My call: the digest lives in the context file, which the host rewrites at every member start. A prompt is saved and carried into a replacement, so a digest inside it would go stale.)*

**Measurement.** At each member start the host records prompt bytes, context file bytes, and digest bytes in `member_scopes`. Read receipts add served bytes. `GET /api/teams/:id/context-usage` returns the four numbers per member. This starts in delivery phase 2, so a baseline exists before anything leaves the file.

### 6. The report gate

With `reportGate`, the session worker looks for required entries before it records a report. An entry is required reading for a member when it is `active`, its `seq` is above the member's `launch_seq`, the member has not fetched it with `entry_get`, and one of these holds:

- Its authority is `direction`.
- Its kind is `contract`, another member wrote it, and it overlaps the member's owned paths. A mission-scoped contract counts when it addresses the member's subtask.

The session worker refuses the first report with status 409. The text names the entry IDs and says that this is not a denial: the member must read the entries and report again. No `team-report` event is written, so the member may send a changed report. It never refuses a second time. If the member reports again without reading, the `report` entry lists the IDs as `unreadRequired` for the reviewer. A required entry is still evidence. Under contract C3, only an owner direction binds a member.

The gate fails open: a session worker that cannot read the store records the report. It applies to project managers, scouts, implementers, integrators, and reviewers.

### 7. Missions

A subteam member reads its own run's entries, plus mission-scoped entries that address its subtask or address none. It never reads another subteam's run-scoped entries. A mission coordinator reads every entry of its subteams.

Only the mission coordinator and the host process write a mission-scoped entry, and only of kind `contract` or `blocker`. Such an entry has `subtaskIds` and no paths. *(My call: `docs/missions.md` says that grouping does not merge project context. The coordinator already carries interfaces between repositories in subtask objectives, and a mission-scoped entry is that same channel.)*

A blocked report and a `subtask-finished` mission message gain an optional `blockerEntryId`. The message carries the entry's summary and ID, and the coordinator fetches the evidence with `entry_get`. A 9 KiB blocker then costs the mission prompt about 300 bytes, which removes the cause of the starvation defect in INF-170.

### 8. Owner surface

- `GET /api/teams/:id/entries` (`kind`, `task`, `since`, `limit`), `GET /api/teams/:id/entries/:entryId`, and `GET /api/missions/:id/entries`.
- `POST /api/teams/:id/entries/:entryId/withdraw`, owner only, with a `requestId`. A withdrawn entry is no longer served to members.
- `GET /api/evidence/status`: store and module states, file and WAL sizes, row counts.
- CLI: `infinite team entries ID [--kind K] [--task T] [--json]`, `infinite team entry ID ENTRY_ID`, `infinite evidence status`.

### 9. Workspace Memory

The blackboard never calls memory. A later memory integration (INF-142) calls one host-internal function:

```ts
blackboard.promotionSource(entryId: string): {
  head: EntryHead; body: unknown; projectId: string;
  authorMemberId?: string; authorProfileId?: string;
} | undefined
```

It then submits a `record_propose` operation of the Memory S1 contract under its own memory capability. The proposal copies what it needs, because the entry is deleted with its run. The candidate goes through memory's review (INF-141).

## Authority and safety

- **Capability.** Entry tools use the existing report capability: the hook token plus the assignment binding that the session worker checks. The Memory S1 task binding covers memory actions only, in a workspace where the owner enabled memory, so it is not reused.
- **Read scope.** An entry outside the caller's scope returns the same "not found" as an unknown ID.
- **Duels.** An entry that a duel contestant wrote is served to no other member until that contestant's result is integrated. A shadow champion's entries therefore become visible when it integrates, as today. When the duel ends, the entries of a contestant that was not integrated are withdrawn. A judge has no entry tools. The duels design defines these terms.
- **Untrusted text.** Member text is rendered only inside the labelled digest or a tool result. It never enters a permission reviewer's evidence. A member can never write authority `receipt` or `direction`.
- **Secrets.** The session worker refuses a post that contains a private key block, a common token format, or the member's own hook token or hook URL. The refusal names the field and never echoes the value. The owner can withdraw an entry.
- **Scores.** No entry carries a rubric, a rating, `diffStat`, or usage (C9 rule 3).
- **Codex sandbox.** The MCP server runs outside the command sandbox (INF-62). The Codex paragraph names the MCP tools only, because the helper command fails inside the sandbox.

## Failure modes

| Failure | Behaviour |
|---|---|
| The store cannot open: wrong key, corruption, full disk | State `unavailable` with a reason. New runs pin the switches off. A member start in a blackboard run writes the old context file with `memberReports`. Read tools answer "unavailable". Reports work. |
| Crash between the run record save and an event write | The outcome ledger's reconciliation repairs it. Idempotent append makes that safe. |
| Crash during ingest, or store down while members post | Posts wait in the journals and ingest repeats. A post is lost only if its session record is deleted first. |
| Session worker and store disagree on `read_version` | That session worker's reads answer "unavailable". |
| A post lands just before a teammate reports | The gate can miss it. Later roles still see it. |
| A member stops after a gate refusal | The gate stays off until a rehearsal passes for each provider. |
| A slow reader holds back the WAL checkpoint | Session workers run single statements. The host process checkpoints on a timer. |
| `node:sqlite` changes | One narrow adapter, a startup probe, and a multi-process read test before phase 3. |

## Delivery order

1. **Evidence store and event table.** Lifecycle, modules, events, run deletion, sweep, status. No member-visible change. It unblocks the outcome ledger.
2. **Host-written entries.** `report`, `integration`, `check`, and `direction` entries, the owner API and CLI reads, and the launch byte measurement. The context file is unchanged.
3. **Member tools.** The hook route, the three tools, the helper, the session worker's read path, caps, the secret scan, and the digest beside `memberReports`. Behind `tools`.
4. **Context reduction.** `memberReports` and check output leave the file. The fallback path. Behind `contextReduction`.
5. **Report gate.** Behind `reportGate`, after a rehearsal per provider.
6. **Missions and blockers.** Coordinator tools, mission scope, `blockerEntryId`.
7. **Promotion source,** with INF-142.

## Acceptance

1. A fresh store has mode `0600` and WAL. It refuses another vault key and an existing empty file. A restored backup copy passes the verifier's integrity check.
2. Appending one key twice yields one row and the same `seq`.
3. After `removeRun`, no event, entry, or scope row remains for the run. The sweep removes rows of a run whose sealed record is gone.
4. A finding posted by one member appears in a teammate's `entry_list` after one tick. A member of another run gets "not found" for that ID.
5. A member cannot post a host-only kind or mission scope. A post with another member's ID gets 403. A post after the report gets 409.
6. The 21st post, a 13 KiB body, a path with `..`, a summary with a newline, and a body that holds the member's hook token are each refused.
7. Context bound: a fixture run launches one implementer task after 3 reported members, and again after 13. The prompts are identical, and the context files differ by at most 4,096 bytes. With the switch off, they differ by at least the size of the added reports.
8. With the store unavailable at member start, the context file contains `memberReports`, `entry_list` answers "unavailable", and `report` succeeds.
9. Gate: a contract that overlaps the member's paths is ingested after launch. The first report gets 409 with the entry ID and writes no `team-report` event. The second report is recorded, with `unreadRequired` when the member did not call `entry_get`.
10. When the owner answers member A's question, running member B's first report is refused once and names the new `direction` entry.
11. An implementer's `entry_get` of a review report contains no `rubric`.
12. A coordinator fetches a subteam blocker by the ID in its `subtask-finished` message. A member of one subteam cannot read a run-scoped entry of the other, and both read the coordinator's mission-scoped contract.

## Owner decisions

1. The blackboard takes the role of the memory design's session working context, stored outside memory. Confirm, or move it into memory later.
2. When to turn on `tools`, `contextReduction`, and `reportGate`, and whether per project.
3. Whether a subteam member may write a mission-scoped entry itself. This design says no.
4. Re-scope INF-170 so that blocker evidence is a `blocker` entry and the blocked report carries its ID.
5. Whether entries should carry into the next cycle of a goal. This design says no.
6. Whether reviewers, integrators, and project managers keep reading rubric scores and owner ratings in the context file. This design keeps today's behaviour.

## Left to the builder

- File layout under `packages/host/src/evidence/`, and whether tables are `STRICT`.
- The exact secret patterns and the helper command's arguments.
- Prompt wording within the byte budgets, and the prompt tests that depend on byte counts.
- The remote relay allow-list for the new read routes.
- Owner controls on a mission subteam's entries, following the existing read-only rule for subteams.
- The cap values in part 4, the checkpoint timer, and the status fields.
