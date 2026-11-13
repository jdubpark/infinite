# Team Blackboard Implementation Plan (INF-182)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the evidence store, the event table, typed blackboard entries, and the member tools that post and read them.

**Architecture:** One SQLite database in the host state directory, written only by the host process. Each design registers a module with its own tables and migrations. Text from a repository or a run is encrypted per row. A value that must be matched is stored as a keyed hash.

**Tech Stack:** TypeScript, `node:sqlite` (`DatabaseSync`), `node:crypto` (HKDF-SHA-256, AES-256-GCM, HMAC-SHA-256), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-12-team-blackboard-design.md`, under the shared contracts in `docs/superpowers/specs/2026-11-12-self-improving-teams-design.md` (C1, C2).

This plan grows one section per delivery phase of the spec. Each phase is one pull request.

## Global Constraints

- Node.js 22.14 or later. No new dependency.
- The host process is the only writer. Nothing falls back to plaintext or to a JSON file.
- A plain column holds an opaque identifier, an enumeration, a number, or a time. Everything else is encrypted (umbrella C1).
- A store failure never blocks a run, a report, or a host start.
- No home path, host name, account name, or secret in any tracked file (`AGENTS.md`).
- Focused tests run with `node --import tsx --test tests/FILE.test.ts`. The full check is `npm run check`.

---

# Phase 1: evidence store and event table

Spec parts 1 and 2, delivery phase 1. No member-visible change.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/evidence/types.ts` (create) | `RunEvent`, `EvidenceDb`, `EvidenceTx`, `EvidenceModule`, `EvidenceStatus`, `EvidenceError` |
| `packages/host/src/evidence/crypto.ts` (create) | Key derivation, row sealing, blind indexes, canonical JSON |
| `packages/host/src/evidence/store.ts` (create) | `EvidenceStore`: open, key check, modules, transactions, events, run deletion, sweep, status |
| `tests/evidence-store.test.ts` (create) | Store tests |
| `packages/host/src/server.ts` (modify) | Construct the store, pass it to `TeamService`, serve the status route, run the sweep, close it |
| `packages/host/src/teams.ts` (modify) | `useEvidence`, the `deleteRecord` hook, `hasRecordFile` |
| `packages/host/src/missions.ts` (modify) | `hasRecordFile` |
| `packages/host/src/client.ts` (modify) | `infinite evidence status` |
| `docs/architecture.md`, `docs/security.md`, `docs/cli.md` (modify) | One short section each |

## Review Focus

1. A second process opens the same file while the host writes (a host restart overlap). Expect a wait of at most `busy_timeout`, then a clean error, never corruption.
2. A callback throws in the middle of `write`. Expect no row from that call to remain.
3. The database file exists with a wider mode than `0600`. Expect the store to set `0600` after the key check passes.
4. The disk is full or the directory is read-only at start. Expect state `unavailable` with a fixed reason and a running host.
5. A caller asks `events` for a huge `limit`. Expect at most 500 rows.

Each of these has a test in the task that owns the code.

### Task 1: keys, sealing, and store lifecycle

**Files:** create `evidence/types.ts`, `evidence/crypto.ts`, `evidence/store.ts`, `tests/evidence-store.test.ts`. Read `packages/host/src/memory/store.ts` first (constructor, `deriveKey`, `authenticateStoreMetadata`, `seal`, `unseal`) and follow its open sequence.

**Interfaces (produces):**

```ts
// evidence/crypto.ts
export const EVIDENCE_KEY_VERSION = 1;
export function deriveEvidenceKey(vaultKey: Buffer, purpose: "row-encryption" | "blind-index" | "event-key"): Buffer;
//   hkdfSync("sha256", vaultKey, "infinite-evidence-kdf-v1", `infinite-evidence:${purpose}:v1`, 32)
export function canonicalJson(value: unknown): string;            // sorted object keys, rejects non-JSON values
export function sealRow(key: Buffer, table: string, rowId: string, value: unknown): string;
export function openRow<T>(key: Buffer, table: string, rowId: string, sealed: string): T;
//   AES-256-GCM, 12-byte nonce, AAD `infinite:evidence:v1:${table}:${rowId}`,
//   envelope JSON { v: 1, n, c, t } in base64, as in memory/store.ts
export type EvidenceIndexClass = "project" | "task" | "area";
export function blindIndex(key: Buffer, cls: EvidenceIndexClass, value: string): string;
//   HMAC-SHA-256 hex of `${cls}\u0000${value}`

// evidence/types.ts
export type RunEvent = { seq: number; key: string; runId: string; revision: number; at: string; kind: string; memberId?: string; taskId?: string; data: Record<string, unknown> };
export interface EvidenceDb {
  get<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[];
  open<T>(table: string, rowId: string, sealed: string): T;
  index(cls: EvidenceIndexClass, value: string): string;
}
export interface EvidenceTx extends EvidenceDb {
  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number };
  exec(sql: string): void;
  seal(table: string, rowId: string, value: unknown): string;
}
export interface EvidenceModule {
  name: string;                 // /^[a-z][a-z0-9-]{0,39}$/, never "store"
  version: number;              // integer >= 1
  readVersion: number;
  migrate(tx: EvidenceTx, from: number): void;      // from = stored version, 0 when new
  deleteRun?(tx: EvidenceTx, runId: string): void;      // needs runIds too
  runIds?(db: EvidenceDb): string[];
  counts?(db: EvidenceDb): Record<string, number>;
}
export type ModuleState = "ready" | "unavailable";
export type EvidenceStatus = { state: "ready" | "unavailable"; reason?: string; modules: Record<string, ModuleState> };
export class EvidenceError extends Error { constructor(readonly code: "unavailable" | "nested-write" | "invalid-event" | "event-too-large" | "invalid-module" | "invalid-statement", message: string) }

// evidence/store.ts
export const evidenceDatabasePath = (stateDir: string) => join(stateDir, "evidence", "evidence.sqlite3");
export class EvidenceStore {
  constructor(options: { databasePath: string; vaultKey: Buffer; busyTimeoutMs?: number });   // TypeError on bad options, never throws on an open failure
  status(): EvidenceStatus;
  register(module: EvidenceModule): void;
  read<T>(fn: (db: EvidenceDb) => T): T;
  write<T>(fn: (tx: EvidenceTx) => T): T;
  tryWrite(fn: (tx: EvidenceTx) => void): boolean;
  close(): void;
}
```

**Decisions:**

- The directory is created with mode `0700`. A new store is built in a temporary file beside the final path, with its schema and key check, and then linked to the final name. A crash during that build leaves only a temporary file, which the next open removes. An existing file must pass the key check on a read-only connection, and again on the writer, before any PRAGMA or schema change. An existing empty or pre-schema file is refused and never replaced.
- PRAGMAs: `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `secure_delete=ON`, `wal_autocheckpoint=1000`, and a busy timeout of 250 ms. *(My call after review: the host is the only writer, so a locked database is abnormal. A long wait would freeze the host's event loop, and the sweep and the event outbox retry anyway.)*
- Core tables, owned by the built-in module `store` at version 1: `store_meta` and `schema_modules` as in spec part 1, and `run_events` as in spec part 2. `store_meta` holds `vault_key_check` (the sealed constant `infinite-evidence-key-check-v1`, row ID `vault_key_check`) and `key_version`.
- An open failure sets state `unavailable` with a fixed reason and logs one line: `key-check-failed`, `unsupported-key-version`, or `open-failed`. A reason never contains a path.
- `register`: a stored version above `module.version` makes the module `unavailable` and runs nothing. Otherwise `migrate` and the `schema_modules` upsert run in one transaction. A throw rolls back and makes the module `unavailable`. A second module with a registered name throws `EvidenceError("invalid-module")`.
- `write` runs `BEGIN IMMEDIATE`, the callback, then `COMMIT`. A throw rolls back and rethrows. It throws `EvidenceError("unavailable")` when the store is not ready and `EvidenceError("nested-write")` inside another `write`.
- `tryWrite` returns `false` on any failure, logs once per distinct message, and never throws.
- `read`, `events`, `hasEvent`, and `describe` use a separate read-only connection, so a read can never write. Inside `write`, reads use the writer and see its uncommitted rows.
- Only the store begins and ends a transaction. Before any SQL runs, the store scans the whole text it was given. It skips what SQLite skips: quoted strings and identifiers (`'…'`, `"…"`, `` `…` ``, `[…]`) and comments (`-- …` to the next newline, `/* … */`). A statement ends at a semicolon in the remaining text. A statement whose first keyword is `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ATTACH`, `DETACH`, `VACUUM`, or `PRAGMA` is refused with `EvidenceError("invalid-statement")`, and nothing in the text runs. Inside a `CREATE TRIGGER` statement, the statement that starts with `END` closes the trigger and is allowed. A Tcl-style parameter, a `$`, `@`, `:`, or `#` name followed by `(`, is refused as well: SQLite reads it as one token, so a quote inside it could hide a later statement from the scan. Where the scan and SQLite could disagree, the scan sees more statements than SQLite runs, never fewer. Before every operation on a write's `tx`, after each `tx.exec`, and after the write callback, a connection with no open transaction throws `invalid-statement` and runs nothing more. SQLite can end a transaction by itself, on `INSERT OR ROLLBACK` or on a failure such as a full disk, and code that caught that error must not go on to write outside the transaction. *(The check before every operation was added with the event outbox of INF-184.)* *(My call after review: the scan covers every statement, because `exec` runs them all, and a check after a `COMMIT` cannot undo it. Only the first keyword of a statement counts, so a `CASE … END` inside a trigger body is not mistaken for the trigger's end.)* The store does not parse SQL beyond this.
- When the read-only connection cannot open, `describe()` reports `unavailable` with the reason `reader-unavailable`, and reads fail as `unavailable`.
- A temporary build file carries its builder's process id. The store removes a leftover only when that process is not running.
- A module hook must be synchronous. A hook that returns a promise fails: the transaction rolls back, and a failed `migrate` leaves the module `unavailable`.
- A module with a `deleteRun` hook must have a `runIds` hook. Otherwise `register` throws `EvidenceError("invalid-module")`.
- A log line holds only fixed tokens: an `EvidenceError` code, a SQLite category, or an errno code from a fixed list. It never holds an error's name or message.
- `busyTimeoutMs` defaults to 250.

- [ ] **Step 1: Write the failing tests** in `tests/evidence-store.test.ts`. Each test uses a fresh directory from `mkdtempSync` and a 32-byte key from `randomBytes`.

| Test name | Assertions |
|---|---|
| `a fresh store is ready, private, and in WAL mode` | `status().state === "ready"`. File mode `& 0o777 === 0o600`. Directory mode `0o700`. `PRAGMA journal_mode` on a raw read-only connection returns `wal`. `PRAGMA integrity_check` returns `ok`. |
| `another vault key is refused` | Open, close, reopen with a different key. State `unavailable`, reason `key-check-failed`. `write` throws `EvidenceError` with code `unavailable`. `tryWrite` returns `false`. |
| `an existing empty file is refused` | Create a zero-byte file at the path first. State `unavailable`, reason `key-check-failed`. The file stays zero bytes. |
| `the same key reopens the store` | Open, close, reopen with the same key. State `ready`. |
| `a wider file mode is narrowed` | Open, close, `chmod 0o644`, reopen. Mode is `0o600`. |
| `sealed rows hide their content and are bound to their row` | `sealRow` then `openRow` returns the value. The sealed text does not contain the plaintext. `openRow` with another `rowId`, another `table`, or another key throws. |
| `blind indexes separate classes` | `blindIndex(k, "task", "a") !== blindIndex(k, "area", "a")`. The same input gives the same 64-character hex. |
| `a module migrates once and records its version` | Register a module at version 1 whose `migrate` creates a table. Reopen and register again. `migrate` runs once in total, with `from` 0. |
| `a newer stored module version makes that module unavailable` | Register version 2, reopen, register version 1. `status().modules[name] === "unavailable"`. The store state is `ready`, and another module still registers. |
| `a failing migration rolls back` | `migrate` creates a table and throws. The table does not exist, and the module is `unavailable`. |
| `a throwing write leaves nothing behind` | A `write` that inserts a row and throws leaves the table empty and rethrows. A `write` inside a `write` throws code `nested-write`. |
| `a second connection waits and then succeeds` | With the store open, a raw `DatabaseSync` on the same file inserts a row after the store's `write` returns. `PRAGMA integrity_check` is `ok`. |
| `an unwritable location leaves the host running` | Construct with a `databasePath` whose parent is a regular file. No throw. State `unavailable`, reason `open-failed`. |

- [ ] **Step 2: Run the tests and confirm they fail** with a missing module error: `node --import tsx --test tests/evidence-store.test.ts`
- [ ] **Step 3: Implement** `types.ts`, `crypto.ts`, and the lifecycle half of `store.ts`.
- [ ] **Step 4: Run the tests and confirm they pass**, then `npm run typecheck -w @infinite/host`.

### Task 2: events

**Files:** modify `evidence/store.ts`, `tests/evidence-store.test.ts`.

**Interfaces (produces):**

```ts
// on EvidenceStore
appendEvent(tx: EvidenceTx, event: Omit<RunEvent, "seq">): { seq: number; inserted: boolean };
events(query: { runId?: string; kinds?: string[]; after?: number; limit: number }): { events: RunEvent[]; cursor: number; more: boolean };
hasEvent(key: string): boolean;
```

**Decisions:**

- `key_hmac` is the hex HMAC-SHA-256 of the event key under the `event-key` key. `task_key` is `index("task", taskId)`. `encrypted_data` seals `{ key, taskId, data }` with row ID `key_hmac`.
- A kind matches `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/` and has at most 64 characters. A key has 1 to 512 characters. `revision` is an integer of at least 1. `at` parses as a date. Otherwise `EvidenceError("invalid-event")`.
- `canonicalJson(data)` has at most 16,384 bytes. Otherwise `EvidenceError("event-too-large")`. Nothing is truncated.
- Insert with `ON CONFLICT(key_hmac) DO NOTHING`. A repeat returns the stored `seq` and `inserted: false`. A stored row never changes.
- `events` returns rows in `seq` order. `limit` is clamped to 1 through 500. `kinds` holds at most 32 values. `cursor` is the last returned `seq`, or `after ?? 0` when nothing is returned. `more` is true when a further row matches.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `appending one key twice yields one row and the same seq` | Two appends with one key, in two `write` calls. Same `seq`. `inserted` is `true`, then `false`. One row in `run_events`. The second call's different `data` is not stored. |
| `an event round-trips and its content is not in the file` | Append with `taskId: "wire-settings-form"` and `data: { note: "evidence-plain-marker" }`. `events({ runId, limit: 10 })` returns the same key, kind, member, task, and data. After `close()`, neither marker string is in the bytes of the database file or its WAL. |
| `events filter and page` | Append 5 events in 2 runs with 2 kinds. Filter by `runId`, by `kinds`, and by `after`. `limit: 2` returns 2 rows, `more: true`, and a `cursor` that returns the rest. `limit: 100000` returns at most 500. |
| `invalid events are refused` | Kinds `Member.reported`, `member`, and a 65-character kind. An empty key. `revision: 0`. Each throws code `invalid-event`, and no row is stored. |
| `an oversized event is refused whole` | `data` of 16,385 bytes throws code `event-too-large`. `data` of exactly 16,384 bytes is stored. |
| `hasEvent reports a stored key` | `false` before the append, `true` after. |

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm pass**, then typecheck.

### Task 3: run deletion, sweep, and host wiring

**Files:** modify `evidence/store.ts`, `tests/evidence-store.test.ts`, `server.ts`, `teams.ts`, `missions.ts`, `client.ts`, and the three docs.

**Interfaces (produces):**

```ts
// on EvidenceStore
deleteRun(runId: string): boolean;                       // false when the store or the delete failed, never throws
sweep(isLive: (runId: string) => boolean): number;        // runs deleted
describe(): EvidenceStatus & { fileBytes: number; walBytes: number; events: number; counts: Record<string, number> };

// on TeamService and MissionService
hasRecordFile(id: string): boolean;                       // the sealed record file exists on disk
// on TeamService
useEvidence(store: EvidenceStore): void;
```

**Decisions:**

- `deleteRun` calls each ready module's `deleteRun` hook and then removes the run's `run_events` rows, in one transaction. The hooks run first, so a hook can still read the run's events. *(Changed with the event outbox of INF-184, whose hook counts the events a projector never saw.)*
- `sweep` collects the distinct run IDs in `run_events` and from each ready module's `runIds` hook. It calls `deleteRun` for every ID that `isLive` rejects. A run is live when its sealed record file exists. The file check is on disk, so a record that failed to load is still live. `hasRecordFile` returns false only when the file is confirmed absent. Any other filesystem error throws, and the sweep keeps a run whose check throws. The sweep stops only when the database is busy or locked, so a locked database costs one wait per sweep. It continues past a failure that belongs to one run, so one bad run cannot hold back the others.
- `TeamService.deleteRecord` calls `deleteRun` after it removes the sealed file. A failure is ignored there, because the sweep repeats it.
- `server.ts` builds the store before `TeamService`, calls `teams.useEvidence(store)`, and runs `store.sweep(id => teams.hasRecordFile(id) || missions.hasRecordFile(id))` once after start and then every hour on an unref'd timer. Both shutdown paths close the store.
- `GET /api/evidence/status` returns `describe()`. It follows the role rule of `GET /api/usage`. It is not added to the remote relay allow-list in this phase.
- `infinite evidence status [--json]` prints the state, the reason when present, each module's state, the file and WAL sizes, and the event count. `evidence` joins the client command words. `clientCommandCandidate(args)` picks the command word with one rule: a token that directly follows a client string option, or an option the client parser does not know, is that option's value and is never the command. So `--config evidence serve` and `--state-dir evidence init` stay with the server parser. *(My call after review: a common word such as `evidence` must not capture a server option's value.)*
- Docs: `docs/architecture.md` gains a short "Evidence store" section (what it holds, one writer, what an unavailable store means). `docs/security.md` gains the at-rest rule (row encryption, blind indexes, `0600`). `docs/cli.md` gains the command.

- [ ] **Step 1: Write the failing tests.**

| Test name | File | Assertions |
|---|---|---|
| `deleting a run removes its events and calls module hooks` | `tests/evidence-store.test.ts` | Two runs with events, and a module with a `deleteRun` hook that deletes its own rows. After `deleteRun(a)`: no event and no module row for `a`, and all rows for `b` remain. Returns `true`. On an unavailable store it returns `false`. |
| `the sweep removes runs with no live record` | same | Three runs with events. `sweep(id => id === keep)` returns 2, and only `keep` has events. A run that only a module's `runIds` hook reports is also swept. |
| `describe reports sizes and counts` | same | After 3 appends: `events === 3`, `fileBytes > 0`, and `counts` holds the module's own counts. On an unavailable store: state `unavailable`, `events === 0`. |
| `removing a run deletes its evidence` | `tests/teams.test.ts`, with the existing run fixtures | A settled cancelled run has one event appended through the store. After `removeRun(id)`, `events({ runId: id, limit: 10 }).events.length === 0`. |
| `the status route and command report the store` | the suite that already covers `GET /api/usage` | `GET /api/evidence/status` returns `state: "ready"` and `modules.store === "ready"`. |

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the focused tests**: `tests/evidence-store.test.ts`, `tests/teams.test.ts`, and the suite that holds the route test. Then typecheck.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

## Not in this phase

- The projector registry and the outbox (INF-184).
- Entries, member tools, and the read-only connection for session workers (phases 2 and 3).
- A backup rehearsal on a staging host. `deploy/ubuntu/verify-backup.py` already checks files with the `.sqlite3` suffix. The copy of the WAL is not verified here.

---

# Phase 2: host-written entries

Spec part 3, part 8 (reads), and the measurement paragraph of part 5, delivery phase 2. The host mirrors four entry kinds from the saved run record into the store: `report`, `integration`, `check`, and `direction`. It records each member's launch sizes in `member_scopes`, and the owner reads entries and sizes through three routes and two commands.

A member's prompt, its context file, its tools, and every run decision stay exactly as today. No member reads an entry in this phase.

## Trust boundary, and what a review checks

The host writes every entry in this phase. It builds each entry from its own sealed run record, after `save` has written that record. The content is still untrusted data:

- A `report` body is the report a member posted, as `readMemberJournal` recorded it. The member chose every word.
- A `check` body holds a command's output, which repository code printed. A plan can choose the command (`run.verification`).
- A `direction` body is the owner's steering or answer text. An `integration` body holds a task id the project manager chose, a commit hash, and paths that Git listed.

The rules, from spec parts 3 and 4 and umbrella C1, C3, and C9:

- Every head and every body is sealed. A plain column holds only an opaque id, an enumeration, a number, or a time. A task id appears only as its blind index, `task_key`.
- An entry id is a hash over opaque values only: a host-issued UUID or a list index. It never covers a task id. *(My call: an unkeyed hash of a short task id can be guessed.)*
- A summary is one line of at most 240 UTF-8 bytes with no control character. The host builds it.
- A host entry has `paths: []`. *(My call: host entries are addressed by task or to the whole run. Paths address member kinds, which arrive in phase 3.)*
- No entry holds a rubric, an owner rating, `diffStat`, or usage (C9 rule 3). Every review report loses `rubric`, for every reader.
- A body is canonical JSON of at most 1 MiB. A larger body is refused whole and never truncated. *(My call: the spec's 12 KiB limit is for member posts. A host body is already bounded by its source: check output by the 65,536-unit tail in `teamCommand`, a report by `teamReportSchema`.)*
- The spec's secret scan applies to member posts in the session worker (phase 3). Host entries hold the text the context file already holds, and are not scanned. *(My call.)*
- Only the owner routes and the CLI serve entries. No entry enters a prompt, a context file, or a tool result. Member text is data, never an instruction (C3).

The phase must survive a store that is unavailable when the service starts, a store that fails during a run (locked, full disk, closed), a crash between a run save and its entry write, a run deleted while its entries are missing, a body over its limit, a record value that cannot be serialized, and a host restart. Outside it: member posts and reads, per-attempt caps, the digest, the report gate, mission scope, withdrawal, and a local attacker who writes the database file.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/evidence/entry-types.ts` (create) | `ENTRY_KINDS`, `EntryKind`, `EntryHead` (spec part 3), `HostEntryKind`, `HostEntry` |
| `packages/host/src/evidence/host-entries.ts` (create) | Pure: the sources a run record holds, the entry one source names, the entry id, the summary rule |
| `packages/host/src/evidence/blackboard.ts` (create) | `Blackboard`: the `blackboard` module, `mirror`, launch sizes, owner reads, the delete and sweep hooks |
| `packages/host/src/team-workspace.ts` (modify) | `writeTeamContext` returns the bytes it wrote |
| `packages/host/src/teams.ts` (modify) | The `entries` option, one line in `save`, one line in the constructor, three lines in `launch` |
| `packages/host/src/server.ts` (modify) | Build the `Blackboard`, pass it to `TeamService`, serve three routes |
| `packages/host/src/team-cli.ts` (modify) | `infinite team entries` and `infinite team entry` |
| `tests/fixtures/host-entry-run.ts` (create) | `hostEntryRun()`: a hand-built `TeamRun` with every source kind |
| `tests/fixtures/team-scheduler.ts` (modify) | `openTeam` passes `entries` |
| `tests/host-entries.test.ts`, `tests/blackboard.test.ts`, `tests/team-entries.test.ts`, `tests/blackboard-routes.test.ts` (create) | Tests |
| `docs/architecture.md`, `docs/teams.md`, `docs/cli.md`, the blackboard spec (modify) | One short paragraph each |

## Review Focus

1. A crash after the sealed write and before the entry write. Expect each entry once after the restart, and no entry for a state the record does not hold.
2. A service without `entries`, and one over an unavailable store. Expect sealed records, context files, prompts, and launches as today, and no thrown error.
3. A locked database during a run. Expect one failed write per run per minute, not one per save.
4. The database file and WAL after a fixture run. Expect no task id, summary, report text, path, or check output in them.
5. A mission subteam's steering. Expect no `direction` entry, because the mission coordinator wrote it.

### Task 1: entry types and host-entry derivation

**Files:** create `evidence/entry-types.ts`, `evidence/host-entries.ts`, `tests/fixtures/host-entry-run.ts`, `tests/host-entries.test.ts`.

**Interfaces (consumes):** `TeamRun`, `TeamMember`, `TeamRole` from `team-types.ts`. `canonicalJson` from `evidence/crypto.ts`.

**Interfaces (produces):**

```ts
// evidence/entry-types.ts
export const ENTRY_KINDS = ["contract", "finding", "blocker", "handoff", "report", "integration", "check", "direction"] as const;
export type EntryKind = typeof ENTRY_KINDS[number];
export type HostEntryKind = "report" | "integration" | "check" | "direction";
export type EntryHead = {
  entryId: string; seq: number; scope: "run" | "mission"; runId: string; revision: number; at: string;
  kind: EntryKind; author: "host" | "member" | "owner"; authority: "receipt" | "claim" | "direction";
  authorRole?: TeamRole | "mission-coordinator"; taskId?: string; paths: string[]; subtaskIds?: string[];
  summary: string; bodyBytes: number; supersedes?: string; unreadRequired?: string[];
  state: "active" | "superseded" | "withdrawn";
};
export type HostEntry = {
  entryId: string; kind: HostEntryKind; author: EntryHead["author"]; authority: EntryHead["authority"];
  runId: string; missionId?: string; revision: number; at: string;
  authorMemberId?: string; authorRole?: TeamRole; taskId?: string; summary: string; body: Record<string, unknown>;
};

// evidence/host-entries.ts
export const ENTRY_SUMMARY_BYTES = 240;
/** Source keys in record order. A key holds only a host-issued UUID or a list index. Never throws for a TeamRun. */
export function hostEntrySources(run: TeamRun): string[];
/** The entry one source names, or undefined when the record does not hold it. Pure. Never mutates `run`. */
export function hostEntry(run: TeamRun, source: string, now: string): HostEntry | undefined;
/** UUIDv8 of SHA-256("infinite-host-entry:v1\0" + canonicalJson({ runId, kind, source })), bits as `reportIdentity`. */
export function hostEntryId(runId: string, kind: HostEntryKind, source: string): string;
/** Control characters and line breaks become spaces, white space collapses, then a cut at 240 bytes on a code point. */
export function entrySummary(text: string, fallback: string): string;
```

**Decisions:**

- The sources, in this order. Each row is one kind.

| Source key | Record field | Kind, author, authority | `revision`, `at`, `taskId` | Body | Summary |
|---|---|---|---|---|---|
| `steering:<i>` | `run.steering[i]`, on a run with no `missionId` | `direction`, `owner`, `direction` | the item's; no task | `{ source: "steering", text }` | `owner steering: <text>` |
| `answer:<decisionId>` | a decision with `answer` and `answeredBy === "owner"` | `direction`, `owner`, `direction` | decision revision, `answeredAt`; no task | `{ source: "answer", question, text }` | `owner answer: <answer>` |
| `report:<memberId>` | a member with `report`, role not `permission-coordinator` | `report`, `member`, `claim` | member revision, `reportedAt ?? now`, member `taskId` | `{ memberId, role, revision, taskId?, baseCommit, report }` without `rubric` | `<kind>: <summary, question, or reason>` |
| `integration:<memberId>` | a task with status `integrated` and a `memberId`, in `run.continuations[].tasks`, then `run.tasks` | `integration`, `host`, `receipt` | `task.revision ?? run.revision`, `now`, task id | `{ taskId, commit?, changedPaths? }` | `task <id> integrated at <12 hex>`, or `… with no change` |
| `check:<i>` | `run.checks[i]` whose status is not `running` | `check`, `host`, `receipt` | the check's revision, `finishedAt ?? startedAt`; no task | `{ command, phase?, status, exitCode, round?, headCommit?, output }` | `<setup or check> <status> (exit <n>): <command and args>` |

- `authorMemberId` and `authorRole` are set for `report` only. `missionId` is `run.missionId`.
- Steering on a mission subteam is not mirrored. *(Spec part 3 calls steering an owner input. The record keeps no author for a steering item, and a mission coordinator's `steer-subtask` report reaches a subteam's `run.steering` through `TeamService.steer`. The spec mirrors no coordinator input as a direction.)*
- An answer counts as the owner's only when `answeredBy === "owner"`, the rule of `ownerDirectionLines`.
- The first report the record holds wins, because the id names the member. A report that `readMemberJournal` later overwrites is not mirrored again. *(My call: the ledger keeps the first report kind the same way.)*
- An integrator's result has no task, and the record keeps no commit per repair. It gets no `integration` entry. *(My call.)*
- The report body leaves out `status`, because it changes after the report. An integration's `at` is the first mirror time, because a task records none. *(My calls.)*

- [ ] **Step 1: Write the failing tests.** `hostEntryRun()` holds: steering `Keep the API stable` (revision 2) and `Prefer small PRs` (revision 3); decision `d1` answered by the owner (`Which store?`, `Use SQLite`), `d2` answered by a coordinator, `d3` open; members `pm` (plan report), `pc` (permission coordinator, `permission-decision` report), `implA` (task `a`, result report), `rev` (review report with a rubric for `a`), `implB` (task `b`, no report); task `a` integrated by `implA` with commit `c` × 40, `changedPaths` `{ paths: ["a.txt"], truncated: false }`, a `diffStat`, and a rubric; task `b` pending; check 0 passed (`npm test`, exit 0, output `ok\n`) and check 1 running.

| Test name | Assertions |
|---|---|
| `sources follow the record in a fixed order` | Exactly `steering:0`, `steering:1`, `answer:<d1>`, `report:<pm>`, `report:<implA>`, `report:<rev>`, `integration:<implA>`, `check:0`. Each key matches `/^(steering\|check):\d+$\|^(answer\|report\|integration):[0-9a-f-]{36}$/`. The run deep-equals a clone taken before. With `missionId` set, no `steering:` key remains. |
| `entry ids are deterministic and opaque` | One id twice is equal and matches `/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`. Kind `integration` with the same source, or another run id, gives another id. |
| `a report entry is a member claim without a rubric` | `report:<rev>`: kind `report`, author `member`, authority `claim`, `authorMemberId` `rev`, `authorRole` `reviewer`, `at` the member's `reportedAt`. `body.report.kind` is `review`. The JSON of the entry contains neither `rubric` nor `correctness`, and the body has no `status`. |
| `an integration entry is a host receipt with no scores` | Body deep-equals `{ taskId: "a", commit, changedPaths: { paths: ["a.txt"], truncated: false } }`. Author `host`, authority `receipt`, `taskId` `a`, `at` the given `now`. The JSON contains no `diffStat`, `rubric`, or `ownerRating`. With no commit: no `commit` key, summary `task a integrated with no change`. A task in `continuations[0].tasks` gives its own source. |
| `a check entry carries its output` | `check:0`: body `{ command: { command: "npm", args: ["test"] }, status: "passed", exitCode: 0, round: 0, headCommit, output: "ok\n" }`, `at` its `finishedAt`, summary `check passed (exit 0): npm test`. A failed setup check's summary starts `setup failed (exit 1)`. `check:1` is undefined. |
| `directions come only from the owner` | `steering:1`: body `{ source: "steering", text: "Prefer small PRs" }`, revision 3, author `owner`, authority `direction`, no `taskId`. `answer:<d1>`: body `{ source: "answer", question: "Which store?", text: "Use SQLite" }`. `answer:<d2>` and `answer:<d3>` are undefined. |
| `summaries are one bounded line` | `entrySummary("a\nb\t c\u0007d", "x")` is `a b c d`. 300 `é` give 120 `é`. `" \n"` gives the fallback. A 4-byte character at the boundary is dropped whole. |
| `a source the record does not hold builds nothing` | `report:<implB>`, `check:9`, `integration:<random UUID>`, `steering:-1`, and `bogus` each give undefined. |

- [ ] **Step 2: Run and confirm failure:** `node --import tsx --test tests/host-entries.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm pass**, then `npm run typecheck -w @infinite/host`.

### Task 2: the blackboard module

**Files:** create `evidence/blackboard.ts`, `tests/blackboard.test.ts`.

**Interfaces (consumes):** Task 1. `EvidenceStore` (`status`, `register`, `read`, `tryWrite`), `EvidenceTx`, `EvidenceDb`, `EvidenceError`, and `canonicalJson` from phase 1.

**Interfaces (produces):**

```ts
export const BLACKBOARD_MODULE = "blackboard";
export const MAX_HOST_BODY_BYTES = 1024 * 1024;
export const MIRROR_BATCH = 64;
export const MIRROR_RETRY_MS = 60_000;
export type EntryQuery = { kinds?: EntryKind[]; taskId?: string; since?: number; limit?: number };
export type EntryPage = { entries: EntryHead[]; cursor: number; more: boolean };
export type LaunchSizes = { launchSeq: number | undefined; promptBytes: number; contextBytes: number };
export type MemberContextUsage = { memberId: string; role: TeamRole; launchSeq: number; promptBytes: number;
  contextBytes: number; digestBytes: number; servedBytes: number; listCalls: number; getCalls: number };
export class Blackboard {
  constructor(store: EvidenceStore, options?: { now?: () => number }); // registers the module; TypeError when the store has it
  mirror(run: TeamRun): boolean;                       // never throws; true when no source of the run is left to store
  writable(): boolean;                                 // never throws; false when not ready, or when a write failed under a minute ago
  launchMark(runId: string): number | undefined;       // never throws
  recordLaunch(run: TeamRun, member: TeamMember, sizes: LaunchSizes): boolean; // never throws
  list(runId: string, query: EntryQuery): EntryPage;   // throws EvidenceError("unavailable") when not ready
  get(runId: string, entryId: string): { head: EntryHead; body: unknown } | undefined;
  contextUsage(runId: string): MemberContextUsage[];
}
```

The migration from version 0 runs the `CREATE TABLE entries`, `CREATE TABLE member_scopes`, and three `CREATE INDEX` statements of spec part 3 unchanged, then:

```sql
CREATE INDEX member_scopes_by_run ON member_scopes (run_id);
```

| Table | Plain columns | Sealed columns |
|---|---|---|
| `entries` | `seq`, `entry_id`, `scope` (`run`), `run_id`, `mission_id`, `revision`, `at`, `kind`, `author`, `authority`, `author_member_id`, `task_key`, `state` (`active`), `body_bytes` | `encrypted_head`: `{ taskId?, authorRole?, paths, summary }`, row id `<entryId>:head`. `encrypted_body`: the body, row id `<entryId>:body` |
| `member_scopes` | `member_id`, `run_id`, `mission_id`, `role`, `launch_seq`, `prompt_bytes`, `context_bytes`, `digest_bytes`, `served_bytes`, `list_calls`, `get_calls` | `encrypted_scope`: `{ taskId?, paths }`, row id `member_id` |

**Decisions:**

- Module `blackboard`, version 1, read version 1. Tables are not `STRICT`, as in phase 1. The spec's table names have no prefix, as `projector_cursors` has none.
- The `deleteRun` hook deletes the run's rows from both tables and forgets the run's cache. The `runIds` hook returns `SELECT run_id FROM entries UNION SELECT run_id FROM member_scopes`. The `counts` hook returns `entries`, `scopes`, and `refused`, the bodies refused since the process started. *(Spec part 1 has the store delete entries and scopes itself. The code deletes only `run_events` and leaves the rest to module hooks.)*
- The sealed head holds only what no plain column holds, so the two cannot disagree. `list` and `get` build an `EntryHead` from both. Head and body use different row ids, so a body never opens as a head. *(My call.)*
- **`mirror(run)`**, in order:
  1. Return false at once when the store or the module is not `ready`, or when the run's last failed write is less than `MIRROR_RETRY_MS` old.
  2. The first call for a run in a process reads the run's stored `entry_id`s once and matches them against `hostEntryId` of each current source.
  3. Build the missing sources in order, at most `MIRROR_BATCH`, with `hostEntry`. A build that throws, or a body whose canonical JSON exceeds `MAX_HOST_BODY_BYTES`, is refused: counted, kept in the cache so it is never built again in this process, and logged once per kind in fixed words.
  4. One `tryWrite` inserts the built entries with `ON CONFLICT(entry_id) DO NOTHING`. `body_bytes` is the canonical JSON's byte length. `task_key` is `tx.index("task", taskId)`.
  5. A failed write records the retry time for the run, and the failure time for the store. The result is true when no current source is left to store: each one is stored or was refused. *(Review round 1: the team service retries a run until `mirror` is true, and a refused body would be refused again.)*
- `launchMark` returns `max(seq)` over the run's entries, 0 when there is none, and undefined when the store, the module, or the read fails.
- `writable()` is true when the store and the module are `ready` and no write of this blackboard failed in the last `MIRROR_RETRY_MS`. The team service asks it before each backlog retry.
- `recordLaunch` writes nothing and returns false when `sizes.launchSeq` is undefined, and while the run's last failed write is less than `MIRROR_RETRY_MS` old. A failed write of its own starts that minute. *(Review round 1: a locked database costs one failed write per run per minute, launches included. The sizes of a launch in that minute are not recorded.)* Otherwise it upserts by `member_id`: `launch_seq`, `prompt_bytes`, `context_bytes`, `digest_bytes` 0, and `encrypted_scope`. A repeat replaces these five and keeps the read counters. `paths` are the owned paths of the run task that `member.taskId` names, else `[]`. *(The spec's scope also holds the mission subtask id. A run record holds only `missionId`, and the subtask link lives in the mission record. Phase 6 adds it.)*
- `list`: `limit` defaults to 50 and is clamped to 1 through 100. `since` defaults to 0. At most 8 kinds. Rows with `seq > since`, in `seq` order. A task filter compares `task_key`. `cursor` and `more` follow `EvidenceStore.events`. A row that fails to open throws.
- `get` matches `entry_id` and `run_id` together. Another run's entry is undefined, as an unknown id is (spec, "Read scope").
- `contextUsage` returns the run's rows in first-launch order (`rowid`).

- [ ] **Step 1: Write the failing tests.** Each test opens a store in a fresh temporary directory with a 32-byte key and builds a `Blackboard` over it. `run` is `hostEntryRun()`.

| Test name | Assertions |
|---|---|
| `the module registers once and creates its tables` | `status().modules.blackboard` is `ready`. `sqlite_master` holds `entries`, `member_scopes`, `entries_by_run`, `entries_by_task`, `entries_by_mission`, and `member_scopes_by_run`. A second `new Blackboard(store)` throws a `TypeError`. After a reopen, `schema_modules` still records version 1. |
| `mirror stores each source once` | `mirror(run)` is true. `list(run.id, {})` returns 8 heads in source order with rising `seq`. A second `mirror` is true and leaves 8 rows. A new `Blackboard` over the reopened store mirrors the run with no new row and the same highest `seq`. |
| `no run text reaches a plain column or the file` | A run with task id `wire-settings-form`, result summary `entry-plain-marker`, check output `check-output-marker`, and changed path `src/path-marker.ts`. After `mirror`, with the store still open, the WAL file exists and is not empty, and none of the four strings is in its bytes. After `close`, none is in the bytes of the database file. Through a raw read-only connection, every `task_key` is 64 hex or null and every `entry_id` is a UUID. |
| `a sealed body never opens as a head` | A raw writer copies one row's `encrypted_body` over its `encrypted_head`. `list(run.id, {})` throws. |
| `list filters and pages` | `{ kinds: ["check"] }` gives 1 head. `{ taskId: "a" }` gives the `implA` report and the integration. `{ limit: 3 }` gives 3 with `more: true`, and `since` equal to its `cursor` gives the next 3. `{ limit: 1000 }` gives at most 100. |
| `get serves only the run's own entry` | `get(run.id, id)` returns the head and the body. `get(otherRunId, id)` and `get(run.id, randomUUID())` are undefined. |
| `an oversized or unserializable body is refused and counted` | A check output of 1,100,000 ASCII characters and a report holding a BigInt: `mirror` is true (nothing is left to store), the other 6 entries are stored, and `describe().counts["blackboard.refused"]` is 2. A second `mirror` adds no row and no log line: `console.warn` ran once per kind. |
| `a failed write waits a minute before it retries` | A store with `busyTimeoutMs: 0`, and a raw connection that holds `BEGIN IMMEDIATE`. `mirror` is false. After the raw `ROLLBACK`, `mirror` with `now` 59 s later is false and stores nothing. With `now` 61 s later it is true and stores 8 rows. |
| `a failed write also holds back launch sizes` | With the raw lock held, `mirror` is false, and `recordLaunch` for that run is false at once: a second raw connection sees no lock wait, and after the `ROLLBACK` no scope row exists. Within the minute `recordLaunch` is still false. With `now` 61 s later it is true and one scope row exists. In a second store, `recordLaunch` under the lock is false, and after the `ROLLBACK` `mirror` for that run is false within the minute. |
| `writable follows the store and the last failure` | A fresh blackboard is writable. After a failed write it is not, for any run. With `now` 61 s later it is. Over a store opened with the wrong key it never is. |
| `an unavailable store answers nothing and writes nothing` | Over a store opened with a wrong key: `mirror` is false, `launchMark` is undefined, `recordLaunch` is false, and `list` throws `EvidenceError` with code `unavailable`. |
| `launch sizes are kept per member` | `launchMark(run.id)` is 0 before `mirror` and the highest `seq` after. Another run's entries do not count. After `recordLaunch(run, implA, { launchSeq: 8, promptBytes: 1200, contextBytes: 4000 })`, `contextUsage(run.id)` is `[{ memberId: implA, role: "implementer", launchSeq: 8, promptBytes: 1200, contextBytes: 4000, digestBytes: 0, servedBytes: 0, listCalls: 0, getCalls: 0 }]`. A repeat with `contextBytes: 4100` leaves one row with 4100. The sealed scope opens to `{ taskId: "a", paths: ["a.txt"] }`. `launchSeq: undefined` writes no row. |
| `deleting a run removes its entries and scopes` | Two runs mirrored and measured. `store.deleteRun(a)` leaves `list(a)` and `contextUsage(a)` empty and run `b` whole. A later `mirror(a)` stores 8 rows again. A run that has only a scope row is removed by `store.sweep(id => id === b)`. |
| `mirror never throws` | `mirror(null as never)`, a run whose `members` is not an array, and a closed store each return false and throw nothing. |

- [ ] **Step 2: Run and confirm failure:** `node --import tsx --test tests/blackboard.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm pass**, together with `tests/evidence-store.test.ts` and `tests/evidence-outbox.test.ts`. Then typecheck.

### Task 3: the team service mirrors entries and measures launches

**Files:** modify `teams.ts`, `team-workspace.ts`, `tests/fixtures/team-scheduler.ts`. Create `tests/team-entries.test.ts`.

**Interfaces (consumes):** `Blackboard` from task 2.

**Interfaces (produces):**

```ts
// team-workspace.ts: was Promise<void>. The UTF-8 bytes of the text it wrote, the final newline included.
export async function writeTeamContext(cwd: string, context: unknown, prefix?: TeamCommand, signal?: AbortSignal): Promise<number>;
// teams.ts
type TeamServiceOptions = { /* existing fields */ entries?: Blackboard };
// tests/fixtures/team-scheduler.ts
openTeam: (options?: { events?: EventOutbox; entries?: Blackboard }) => TeamService;
```

**Decisions:**

- **Attach by constructor option**, as `events` does, because the constructor can `save` during restart recovery. Every new line is a no-op behind `?.` without `entries`. No `Stored` field is added, so no sealed record changes, with or without the store.
- **`save`.** After `writeSealed` and after the existing `flushOutbox` line: `this.mirrorEntries(stored.run)`, which calls `entries.mirror(run)` and keeps the run in `entryBacklog` (an in-memory set of run ids) while the result is false. An entry is written only after a sealed record holds its source, so no entry exists for a state the record lacks (C1). Each kind reaches the store at the save that persists its source:
  - `report`: `readMemberJournal` sets `member.report`. The save that follows in `step` or `replaceStalledMember`, or the stop barrier's final save, writes the entry.
  - `integration`: the completion callback of the `result` branch of `consume` sets `task.status = "integrated"`. `operation` saves right after the callback.
  - `check`: in `check`, `Object.assign(check, …)` finishes a command, and the next `enqueue` saves. The constructor's restart path marks a running check `interrupted` and saves.
  - `direction`: `steer` pushes to `run.steering` and saves. `continueRun` pushes its optional text and calls `save(next)`. `answer` sets `decision.answer` and saves.
- No operation's perform step gains an await. `mirror` is synchronous. It costs one write in a save that adds a source. A failing store costs at most one busy timeout (250 ms by default) per run per minute at a save or a launch, and one per minute in the backlog drain.
- **Startup.** At the end of the constructor, after the outbox startup flush: mirror each loaded record whose status passes `activeTeamRun`, and put every other loaded record in the backlog. It saves nothing. *(Review round 1 replaced my earlier call, which left settled runs alone. A run can settle in the very save whose entry write is lost to a crash or a failing store, and a settled run never saves again. No sealed field marks which settled runs are complete, so every retained run is checked. A settled run from before this phase gains its entries the same way.)*
- **Backlog drain.** The scheduler tick calls `drainEntries()` after its steps. It retries at most `ENTRY_DRAIN_RUNS` (4) backlog runs per tick, oldest first, and moves a run that is still incomplete to the end of the set. It stops at once when `entries.writable()` is false, so a failing store costs the drain at most one failed write per minute, whatever the number of runs. A run with no loaded record leaves the backlog, and `deleteRecord` removes its run. The drain saves nothing, awaits nothing, and changes no record. Without `entries` it does nothing.
- **`launch`.** Inside `if (!this.hasLaunch(member) && member.role !== "permission-coordinator")`, after `configuredProject`: `const launchSeq = this.options?.entries?.launchMark(stored.run.id)`. Then `const contextBytes = await writeTeamContext(…)`, with the arguments unchanged. Then `this.options?.entries?.recordLaunch(stored.run, member, { launchSeq, promptBytes: Buffer.byteLength(member.prompt, "utf8"), contextBytes })`. `member.prompt` is the text that `request.prompt` sends.
- A replayed launch writes no context file and keeps its earlier row. A launch that waits for a session slot writes the file again on the next attempt, and the row then holds that file. A permission coordinator gets no file and no row. A size never enters a prompt or a context file (C9 rule 3).
- **Deletion.** No change. `deleteRecord` already calls `this.evidence?.deleteRun`, which runs the module hook. The hourly sweep repeats a failed delete.

- [ ] **Step 1: Write the failing tests** in `tests/team-entries.test.ts`. Each test builds `schedulerFixture()`, an `EvidenceStore` at `evidenceDatabasePath(f.config.stateDir)` with `f.key`, and `new Blackboard(store)`, and opens `f.openTeam({ entries })`. Flows follow `tests/team-events.test.ts`.

| Test name | Assertions |
|---|---|
| `a service without the blackboard keeps its records as today` | The plan-report flow, once with `openTeam()` and once with `openTeam({ entries })`. The two sealed records are equal after each fixture's own ids, commit ids, times, and temporary paths are replaced by placeholders in order of first use. *(Review round 1: comparing keys alone let a changed value pass.)* |
| `a recorded report becomes a report entry at its save` | The fixture project manager reports a plan. After `step`, `list(run.id, { kinds: ["report"] })` holds one head with author `member`, authority `claim`, and `authorRole` `project-manager`. Its body's `report.kind` is `plan`, and its `memberId` is the project manager's. |
| `owner steering and answers become directions` | `steer` with `Keep the API stable` stores one `direction` with body `{ source: "steering", text: "Keep the API stable" }`. An owner `answer` stores one with the question and the answer. An answer with `by: "coordinator"` stores none. |
| `an integration and a finished check become receipts` | Task `a` (paths `["a.txt"]`) integrates a one-line change, and the project check is `node -e "console.log('check-ok')"`. One `integration` has `taskId` `a`, `commit` equal to `task.commit`, and `changedPaths` `{ paths: ["a.txt"], truncated: false }`. One `check` has status `passed` and output containing `check-ok`. |
| `a launch records its sizes and sends what it sent before` | A queued implementer launches on `step`. `contextUsage` has one row: `promptBytes` equals the byte length of the fixture's last launch prompt, `contextBytes` equals the size of `.git/infinite-team-context.json` in its clone, `digestBytes` is 0, and `launchSeq` equals `launchMark` before the step. The context file has `schemaVersion` 1 and `memberReports`. With the same placeholders, the context file and the launch prompt equal those of the same launch under `openTeam()` in a second fixture with the same steering. Neither the file nor the prompt contains `promptBytes`, `contextBytes`, or `context_bytes`. |
| `an unavailable store changes nothing` | The plan-report flow over a wrong-key store throws nothing. The run status and `f.launches.length` equal those of the same flow under `openTeam()`. No scope row exists after the key is fixed. |
| `an entry missed before a crash is written after a restart` | A first service over a wrong-key store records the plan report through `step` and closes. A second service over a store with the right key holds the report entry after construction, with no mutation. |
| `a settled run's missed entries are written after a restart` | A cancelled run with one steering text, first under a service over a wrong-key store, then closed. A second service over a store with the right key holds no entry after construction, because a settled run waits for the drain. After `drainEntries()` it holds the `direction` entry. The sealed record's bytes are the same before and after. |
| `a failed entry write is retried without a save` | A raw connection holds `BEGIN IMMEDIATE` while `steer` saves: the run has no `direction` entry. After the `ROLLBACK` and 61 s on the blackboard's clock, `drainEntries()` stores it. The sealed record's bytes do not change between the steer and the drain. |
| `a failing store stops the drain after one write` | Six settled runs in the backlog and a raw lock: one `drainEntries()` calls `mirror` once. A second call in the same minute calls it zero times. After the `ROLLBACK` and 61 s, three calls store every run's entries, four runs at most per call. |
| `removing a run removes its entries` | A settled, cancelled run with entries and one scope row. After `removeRun(id)`, `list` returns no entry and `contextUsage` is empty. |

- [ ] **Step 2: Run and confirm failure:** `node --import tsx --test tests/team-entries.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/team-entries.test.ts tests/team-events.test.ts tests/teams.test.ts tests/team-prompts.test.ts` on the host, then the typecheck.

### Task 4: owner routes, commands, and docs

**Files:** modify `server.ts`, `team-cli.ts`, `docs/architecture.md`, `docs/teams.md`, `docs/cli.md`, and `docs/superpowers/specs/2026-11-12-team-blackboard-design.md`. Create `tests/blackboard-routes.test.ts`.

**Interfaces (consumes):** `Blackboard`, `ENTRY_KINDS` from tasks 1 and 2. The `entries` option from task 3.

**Decisions:**

- `server.ts` builds `const blackboard = new Blackboard(evidence)` after `new EventOutbox(evidence)` and passes `entries: blackboard` to `TeamService`.
- Three routes. Each first requires `teams.hasRecordFile(id)`, else 404 `team-not-found`. *(My call: `teams.get` refreshes Linear tracking, and a read of entries should not.)*
  - `GET /api/teams/:id/entries`: query `kind` (one value or several, from `ENTRY_KINDS`), `task` (`/^[a-z][a-z0-9-]{0,39}$/`), `since` (integer of at least 0), `limit` (1 to 100), strict. It answers `list`.
  - `GET /api/teams/:id/entries/:entryId` (a UUID): `{ head, body }`, or 404 `entry-not-found`.
  - `GET /api/teams/:id/context-usage`: `{ members: contextUsage(id) }`.
- `EvidenceError` with code `unavailable` answers 503 `evidence-unavailable`. A bad query answers 400.
- The routes follow the role rule of `GET /api/teams/:id`, which already serves the same reports and check output. They are not added to the remote relay allow-list. *(My call, as phase 1 did for the status route.)*
- `infinite team entries ID [--kind K] [--task T] [--since N] [--json]` prints one line per head: `<seq>  <kind>  <author>/<authority>  [task <id>]  <summary>`, and a last line with the next `--since` when `more` is true. `infinite team entry ID ENTRY_ID [--json]` prints the head line and the body as indented JSON. Every host value passes through the client's terminal cleaning. *(My call: `--since` pages; the spec lists only the other options.)*
- Docs: `docs/architecture.md` adds to "Evidence store": the host mirrors four entry kinds from the run record, and the owner reads them. `docs/teams.md` adds one paragraph after the run events paragraph: entries and launch sizes never change a run, and no member reads them yet. `docs/cli.md` adds the two commands. The spec's retention sentence in part 1 says that the `blackboard` module's hook removes entries and scope rows, and its part 3 table says that a `report` entry comes from the saved run record.

- [ ] **Step 1: Write the failing tests** in `tests/blackboard-routes.test.ts`. The test writes a key file and a state directory, seals a settled run record that holds a reported member and a failed check with output `\u001b[31mred`, mirrors it and records one launch through a `Blackboard` over that store, closes it, and calls `startHost({ config: { stateDir, keyFile } })`.

| Test name | Assertions |
|---|---|
| `the entry routes serve heads, bodies, and sizes` | `GET /teams/:id/entries` returns heads with no `body` key. `?kind=check` returns 1 head. `?limit=1` has `more: true`. `GET /teams/:id/entries/:entryId` returns `head` and `body`. An unknown entry and an unknown team answer 404. `?kind=bogus` answers 400. The viewer role gets 200, and no token gets 401. `GET /teams/:id/context-usage` returns one member. |
| `an unavailable store answers 503` | With an unusable evidence location, as in `tests/usage-routes.test.ts`, `GET /teams/:id/entries` answers 503 with `evidence-unavailable`. |
| `the entry commands print heads and a body` | `infinite team entries ID` prints one line per head with its kind and summary. `--kind check` prints one. `--json` parses to the route's result. `infinite team entry ID ENTRY_ID` prints the check body. No output line contains `\u001b`. |

- [ ] **Step 2: Run and confirm failure:** `node --import tsx --test tests/blackboard-routes.test.ts` on the host.
- [ ] **Step 3: Implement**, and edit the four docs.
- [ ] **Step 4: Run** the four test files of this phase and `tests/usage-routes.test.ts` on the host, then the typecheck.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

Tasks 1 and 2 are serial. Tasks 3 and 4 then run in parallel in different files. Task 4 is committed after task 3, because its `server.ts` line needs the `entries` option.

## Not in this phase

- The `team-entry` hook route, the three member tools, the helper command, the session worker's read path, per-attempt caps, the secret scan, the digest, and a `digest_bytes` above 0 (phase 3).
- The `teams.blackboard` switches. This phase adds no switch, so no routine digest changes (umbrella C11).
- Context reduction and its fallback (phase 4). `mirror`'s result is the completeness check that phase needs.
- The report gate (phase 5). Mission scope, `GET /api/missions/:id/entries`, the subtask id in a scope, and `blockerEntryId` (phase 6). `promotionSource` (phase 7).
- `POST /api/teams/:id/entries/:entryId/withdraw`. *(My call: withdrawal matters once members read entries, in phase 3.)*
- A bound on served bodies. A check body can exceed the 256 KiB that `entry_get` serves per attempt, and phase 3 decides how to serve it.
