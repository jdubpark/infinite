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
- Only the store begins and ends a transaction. Before any SQL runs, the store scans the whole text it was given. It skips what SQLite skips: quoted strings and identifiers (`'…'`, `"…"`, `` `…` ``, `[…]`) and comments (`-- …` to the next newline, `/* … */`). A statement ends at a semicolon in the remaining text. A statement whose first keyword is `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `ATTACH`, `DETACH`, `VACUUM`, or `PRAGMA` is refused with `EvidenceError("invalid-statement")`, and nothing in the text runs. Inside a `CREATE TRIGGER` statement, the statement that starts with `END` closes the trigger and is allowed. A Tcl-style parameter, a `$`, `@`, `:`, or `#` name followed by `(`, is refused as well: SQLite reads it as one token, so a quote inside it could hide a later statement from the scan. Where the scan and SQLite could disagree, the scan sees more statements than SQLite runs, never fewer. After each `tx.exec` and after the write callback, a connection that reports no open transaction also throws `invalid-statement`, as a second check. *(My call after review: the scan covers every statement, because `exec` runs them all, and a check after a `COMMIT` cannot undo it. Only the first keyword of a statement counts, so a `CASE … END` inside a trigger body is not mistaken for the trigger's end.)* The store does not parse SQL beyond this.
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

- `deleteRun` removes the run's `run_events` rows and calls each ready module's `deleteRun` hook, in one transaction.
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
