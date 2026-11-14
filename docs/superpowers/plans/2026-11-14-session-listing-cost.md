# Session Listing Cost Implementation Plan (INF-239)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An idle host spends a few `stat` calls, not two decrypted reads and a failed connect, on each session that exited long ago, and its pollers stop reading every session record on every tick.

**Architecture:** `Manager.list()` keeps the parsed listing part of each `meta.sealed` and `status.sealed` in memory, keyed by the file's identity, and builds every row afresh from them. It connects to a worker only when the worker's socket file exists. The handoff poller and the readings poller remember the sessions whose answer can no longer change. `meta()` and `state()` keep reading the files.

**Tech Stack:** TypeScript, `node:fs`, `node:test`.

**Spec:** the issue, measured on the live host on 2026-11-14. The idle host uses about 73% of one core, and its event loop stalls 250 to 600 ms about once a second. It holds 937 session records (`meta.sealed` median 37 KB, 41.8 MB in all). In 3 s it opened `meta.sealed` 16,636 times and `status.sealed` 6,559 times and made about 2,700 failed socket connects a second. Acceptance after the release: the idle host process uses less than 15% of one core, and the 90th percentile latency of a 1 ms route is under 20 ms.

## Global Constraints

- Node.js 22.14 or later. No new dependency. No new setting.
- Nothing a session, a team run, a goal, or a routine does changes. No route answer changes, field for field and in key order.
- `manager.ts` changes only in the line ranges Task 1 names. Other sessions change this repository at the same time: keep each diff small and local.
- Nothing new goes to disk, to a log line, or to an error body. Session text stays in process memory, as today.
- Focused tests run with `node --import tsx --test tests/FILE.test.ts` on the host: the new tests listen on Unix sockets. The coordinator runs `npm run check` once.
- No home path, host name, account name, or secret in any tracked file (`AGENTS.md`).

# Slice: the session listing

`list()` (`manager.ts:363-391`) builds each row as `{ ...summary, ...state, attention }`. The summary is the `meta.sealed` record without `context`, `initialPrompt`, `generatedTitle`, `nativeArgs`, and `handoff`. The state comes from `state(id)` (`329-357`) without `screen`: the worker's answer through `withDefaultAttention`; else the saved `status.sealed` with `status` `exited` or `unavailable` and `attention` through `applyLifecycle(…, now)`; else `unavailable()`. A row of a session that no worker answers depends on the time of the call: `applyLifecycle` sets `attention.lastActivityAt` to the call time, and `since` too when the saved state differs. After this slice a listing costs, per exited record, four checks (`existsSync` of the deleted receipt as today, `statSync` of the two files, `existsSync` of the socket) and one copy, and gives exactly today's rows.

What the code shows, and how this plan rules on it:

- **`meta.sealed` has two writers**: `createRecorded` (`manager.ts:975`) and `setArchived` (`281-286`), which changes only `archivedAt`. No code changes a title after creation; the readings title is an overlay, not a write. The key covers a future writer anyway. **`status.sealed` has one writer**, the worker's `persist` (`worker.ts:144-150`). Deletion is `remove` (`318-324`: receipt, then folder) and the constructor sweep (`235-245`). Every write goes through `writeSealed` (`vault.ts`): a temporary file opened `wx`, then a rename.
- **`exited` is final for a session id.** A worker refuses to start for an id whose journal has events (`worker.ts:82-84`), `createRecorded` returns the stored session for an existing record (`880-885`), and a resume creates a new id (`788`, `816-817`). The listing does not rely on it: it checks the socket on every call. Between a worker's spawn and its `listen` the row is `unavailable()`, as today; after `listen` the worker answers `starting`.
- **The other timer readers of `meta.sealed`**: `HandoffService.tick` (`handoffs.ts:73-89`), every 500 ms, lists and then calls `discover`, which reads `meta()` for every session without a handoff record. For a session with a handoff policy it also calls `handoffRequest` (`manager.ts:1027-1035`), whose `events()` reads `meta()` once per 512 KB page and decrypts the whole journal. `Readings.tick` (`readings.ts:162-173`), every 2 s when Jev is configured, reads `meta()` for every row in `observeRows` (`175-207`). On a laptop, one `meta()` pass over 937 synthetic records costs 71 ms, against 130 ms for a whole listing today. The acceptance needs both pollers covered, so this slice covers them (Tasks 2 and 3).
- **No caller changes the object `meta()` returns** (checked: `setArchived` spreads into a new object, and the readers only read). `HandoffService.discover` keeps `source.handoff.policy` by reference inside its long-lived record, so a cached `meta()` would have to copy on every call. This slice leaves `meta()` and `state()` uncached.
- **Pollers on timers**: handoffs (500 ms), teams (2 s, which also feeds the usage ledger), the notifier (2 s), readings (2 s, Jev only), repository briefings (5 s default). That is about 3.7 listings a second once a listing is cheap.

**The cache holds parsed inputs and never a row.** It keys each file by `dev`, `ino`, `size`, `mtimeMs`, and `ctimeMs`. Each call builds its rows with its own time, so a cached row gives today's answer, including `lastActivityAt`.

**A parse is kept only when its file is at least 2 s old (`SETTLED_MS`).** A rename gives the new file another inode than the file it replaces. But XFS and ext4 reuse a freed inode number, Linux file times come from the coarse clock (one tick, 1 to 4 ms), and two seals of equal-length JSON have equal size. So two writes within one tick can leave the same key. With the rule, a file that reuses the kept inode was created after the kept file was replaced, so after the fill, and its `mtime` is at least 2 s later than the kept one. A clock that steps back clears the cache. *(My call: the rule Git uses for racily clean index entries. A write counter cannot cover the worker, which is another process.)*

**No worker serves a session whose socket file is missing.** `workerCall` connects to `socketPath(runDir, id)` and fails with `ENOENT` when the file is missing, so skipping the connect gives the same answer. A socket file that exists is connected as today, live or stale. The run directory is a `RuntimeDirectory` that the boot clears, and `exitWorker` unlinks the socket (`worker.ts:1365`), so stale socket files come only from workers that crashed since the boot.

**Every returned value is a fresh copy.** The cache returns `structuredClone` of what it keeps. *(My call: the copy costs 6 of the 15 to 18 ms a cached listing of 937 records takes on a laptop. Freezing would turn a caller's write into a thrown `TypeError`.)*

**The pollers remember only answers that cannot change.** Handoffs: a session without a handoff policy, which is fixed at creation, or a session listed `exited` whose journal holds no request. The worker appends a request only while its status is `running` (`worker.ts:347-353`), and it sets `exited` before it persists (`1589`). Readings: a session that can never need a title reading, valid while the row's title is the same. `view()` still reads the record, so its answers and its error for a deleted session stay.

**No shared listing for all pollers.** At about 3.7 listings a second of about 25 ms on the host, the listings use about 9% of one core. *(My call: 25 ms scales the laptop's 16 ms by the ratio of the measured 73% to a laptop model of today's load, about 45%.)*

**Memory.** A cache entry holds the summary (1 to 2 KB of JSON) and the saved status (1 to 6 KB; `lastMessage` has at most 4,000 characters). Measured: 5.3 MiB for 2,000 entries with 500-character messages, 12 MiB with 4,000. An entry leaves when its id leaves a listing (folder gone, deleted receipt), when its file is missing or changes, and all entries leave when the clock steps back. The two poller memories hold ids and small snapshots only.

## Trust boundary, and what a review checks

The sealed files are written by the host and its workers with one key, and `unseal` authenticates each read with its scope. A file that fails to open leaves its row out (metadata) or shows it `unavailable` (status), as today, and a failure is never kept. Socket files live in the run directory (mode 0700); any process of the service user that creates one is connected to, as today. The cache adds no file, column, log line, or error text. The wall clock is the one new input: a step back clears the cache.

| Sequence | Expected | Test |
|---|---|---|
| List, archive, list | The second listing shows `archivedAt` | Task 1 `every change shows in the next listing` |
| List, rewrite `meta.sealed` with the same size and the old `mtime`, list | The new title shows | same |
| List, `remove`; list, folder removed without a receipt; list | Each row is gone from the next listing | same |
| List, first `status.sealed` written, list | The saved state shows | same |
| List, a worker listens on an exited id's socket, list; it closes, list | The worker's state; then the saved state with no sealed read | same |
| A file written now, two listings, then the file 2 s old, two listings | Reads 1, 1, 1, 0 | Task 1 `a second listing of exited records reads no sealed file and connects to no worker` |
| The clock steps back | The next listing reads every record again | same |
| A restart (a new `Manager`), or the clock moves on | Rows equal the rows built from `meta()` and `state()` at that time | Task 1 `listing rows equal the rows built from meta and state, cold, warm, and after a restart` |
| Unreadable metadata, unreadable status, a folder without metadata, a deleted receipt | Left out, `unavailable`, left out, left out; read again every listing | same |
| A caller changes a row | The next listing is unchanged | Task 1 `a caller that changes its rows changes no later listing` |
| Two handoff ticks over sessions without a policy, exited with a policy, running with a policy | `meta()` read 1, 1, 2 times; `view()` of a deleted session still throws | Task 2 `discovery reads a record once when its answer cannot change` |
| Two readings ticks, then a renamed row | An owner-titled record read once, a title candidate twice, the renamed row again | Task 3 `polling reads a session record once unless a title reading may follow` |

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/session-listing.ts` (create) | `SealedFileCache`, `listedSession`, `SETTLED_MS` |
| `packages/host/src/manager.ts` (modify) | `list()` reads through two caches; `savedState` shared with `state()` |
| `packages/host/src/handoffs.ts` (modify) | `discover` remembers sources that will never request a handoff |
| `packages/host/src/readings.ts` (modify) | `observeRows` remembers sessions that need no title reading |
| `tests/session-listing.test.ts`, `tests/handoff-discovery.test.ts` (create); `tests/readings.test.ts` (modify) | The tests below |

**Order and owners.** Tasks 1, 2, and 3 run in parallel: each writes its own files, and none uses another's interface. Then the coordinator runs `npm run check` once and requests the independent review.

## Review Focus

1. A write that leaves the key unchanged, so a stale row shows: inode reuse within one timestamp tick with equal size (Task 1 `every change shows in the next listing`, the same-size rewrite; `a second listing …`, the 2 s rule).
2. A time-dependent field kept from the fill (Task 1 `listing rows equal …`, after the clock moves on).
3. A nested object shared between a caller and the cache (Task 1 `a caller that changes its rows …`).
4. A live worker skipped, or a kept status used while a worker answers (Task 1 `listing rows equal …`, the live row; `every change …`, the worker that starts again).
5. A poller memory that hides a change: a running session with a policy, a title candidate, a renamed row, `view()` of a deleted session (Tasks 2 and 3).

### Task 1: the listing cache

**Files:** `packages/host/src/session-listing.ts`, `packages/host/src/manager.ts`, `tests/session-listing.test.ts`. In `manager.ts` only these lines change: `22-23` (import `socketPath` from `./ipc.js`, and the new module), `178-183` (add `savedState` after `unavailable`), `184-191` (two private fields), `329-357` (`state()` calls `savedState`; its behaviour is unchanged), `358-391` (`list()`, and `listedState` after it).

**Interfaces (produces):**
```ts
// session-listing.ts
export const SETTLED_MS = 2000;
export type ListedSession = Omit<Session, "context" | "initialPrompt" | "generatedTitle" | "nativeArgs" | "handoff">;
/** Destructuring rest, so the key order of today's rows stays. */
export function listedSession(session: Session): ListedSession;
/** Parsed sealed files, one per session id, reused while the file keeps its identity. */
export class SealedFileCache<T> {
  constructor(parse: (id: string, raw: string) => T);
  /** A copy no other caller holds, or undefined when the file is missing. Throws what reading or parsing throws; a failure is not kept. */
  read(id: string, file: string, now: number): T | undefined;
  /** Forgets ids that are not listed, and every entry when `now` is earlier than the previous call's. */
  retain(ids: ReadonlySet<string>, now: number): void;
}
// manager.ts
/** The state a saved status gives when no worker answers: `exited` stays, anything else is `unavailable`. */
function savedState(saved: WorkerState, now = new Date().toISOString()): WorkerState;
private readonly listedMeta = new SealedFileCache<ListedSession>((id, raw) => listedSession(unseal<StoredSession>(this.key, `${id}:meta`, raw).session));
private readonly savedStatus = new SealedFileCache<WorkerState>((id, raw) => unseal<WorkerState>(this.key, `${id}:status`, raw));
private async listedState(id: string): Promise<WorkerState>;
```

**Decisions:**

- **`read`** is synchronous: `statSync(file, { throwIfNoEntry: false })`; no file deletes the entry and returns undefined. The key is `` `${dev}:${ino}:${size}:${mtimeMs}:${ctimeMs}` ``. A hit returns `structuredClone(value)`. A miss deletes the entry, reads with `readFileSync(file, "utf8")` from `node:fs` (the test counts these calls), parses, keeps the value when `now - mtimeMs >= SETTLED_MS`, and returns a copy. The `stat` comes before the read, so a kept value is never older than its key.
- **`list()`** takes `now = Date.now()` once, lists ids exactly as today (`364-366`), and calls `retain` on both caches. Per id it reads the summary through `listedMeta`; a missing file throws, so the row is left out as today. The state is `listedState(id).catch(() => unavailable())`. The row expression is today's.
- **`listedState`**: when `existsSync(socketPath(this.config.runDir, id))`, it returns `withDefaultAttention(await workerCall(…, { op: "state", screen: false }))`, and on a failure falls through. Then `savedStatus.read(…)`: a value gives `savedState(value)`, no file gives `unavailable()`, and a throw rejects. The parse closures read `this.key` when called, so field order in the constructor does not matter.

- [ ] **Step 1: Write the failing tests.** The fixture: a root from `mkdtempSync(join(".local", "sl-"))` (a short socket path), `stateDir` and `runDir` under it, `Buffer.alloc(32, 7)` as the key, `{ stateDir, runDir, enableDemo: true, agents: {} } as Config`. Records are written with `writeSealed` and their files dated 10 s back with `utimesSync`. A fake worker is a `net` server on `socketPath(runDir, id)` that answers `{ op: "state" }`, as in `tests/team-permissions.test.ts`. The oracle is today's `list()` body over `manager.meta(id)` and `manager.state(id)`, with `withDefaultAttention({ status: "unavailable", seq: 0, screen: "" })` for a state that throws. Time is fixed with `mock.timers.enable({ apis: ["Date"], now: Date.now() })`. Reads and connects are counted by wrapping `fs.readFileSync` (paths ending in `/meta.sealed` or `/status.sealed`) and `net.createConnection`, then `syncBuiltinESMExports()`, as in `tests/transcript.test.ts`, restored in `finally`.

| Test name | Assertions (and what fails without the change) |
|---|---|
| `listing rows equal the rows built from meta and state, cold, warm, and after a restart` | Records: E exited with a 400-character `lastMessage`; U1 saved `running` with no worker; U2 without status; L live (a fake worker whose state has a prompt with tool input); S with status `"x"`; X with metadata `"x"`; N, a folder without metadata; D with a deleted receipt. The listing holds exactly E, U1, U2, L, S. Cold and warm listings deep-equal the oracle, with and without `includeFullMessage`. With the mocked clock moved 60 s forward, a listing deep-equals a new oracle: a cache that kept rows fails on `lastActivityAt`. A second `Manager` on the same folders gives the same rows. |
| `every change shows in the next listing` | After a warm listing, each step is followed by a listing that deep-equals the oracle: `setArchived(E, true)` (`archivedAt` shows); with two more exited records E2 and E3, a rewrite of E2's metadata from title `Title A` to `Title B` with the old `mtime` restored (a key without inode or `ctime` fails); `remove(E3)`; `rmSync` of U1's folder; a first `status.sealed` of `exited` for U2; a fake worker on the socket of W, an untouched exited record (W shows `running`; a cache that trusts `exited` fails), then the worker closed (W shows `exited`, and neither of W's files is read). |
| `a second listing of exited records reads no sealed file and connects to no worker` | 200 exited records. Cold: 400 reads, 0 connects (today: 200 connects). Warm: 0 reads, 0 connects (today: 400 and 200). A regular file at record 0's socket path: 1 connect, 0 reads. A new status for record 1, written now: two listings read it once each; after its `mtime` is set 10 s back, one read, then none (a cache that keeps fresh files fails). With the mocked clock set 60 s back, the next listing reads 400. |
| `a caller that changes its rows changes no later listing` | Change the first listing's rows: `title`, `attention.lastMessage`, `runtime.id`, push to `contextSources`, `capabilities.transcript`. The next listing deep-equals the oracle (a cache returning kept or shallow-copied objects fails). |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/session-listing.test.ts tests/session-archive.test.ts tests/team-permissions.test.ts` and `npm run typecheck -w @infinite/host`, then commit.

### Task 2: handoff discovery

**Files:** `packages/host/src/handoffs.ts` (lines `15-19`, `34-52`, `77`), `tests/handoff-discovery.test.ts`.

**Interfaces (produces):**
```ts
/** Sources that will never request a handoff: no policy (fixed at creation), or exited with no request in the journal. */
private readonly settled = new Set<string>();
private discover(sessionId: string, exited = false): Stored | undefined;
```

**Decisions:** `discover` returns a known record first, then returns undefined for a settled id without reading. No policy adds the id. When `handoffRequest` finds no event and `exited` is true, it adds the id. `tick` lists once, deletes settled ids that are not listed, and calls `discover(source.id, source.status === "exited")`. `view()` does not change: it calls `discover` and then reads `meta()` itself, so it answers as today and throws for a deleted session.

- [ ] **Step 1: Write the failing test** with a stub manager (`list`, a counting `meta`, a counting `handoffRequest` that finds nothing, `reserveHandoff`, `releaseHandoff`) and `{ stateDir } as Config`. The service starts, waits until `list` has answered twice, and closes.

| Test name | Assertions |
|---|---|
| `discovery reads a record once when its answer cannot change` | Rows A (no policy, `running`), B (policy, `exited`), C (policy, `running`). `meta()` reads: A 1, B 1, C 2 (today: 2, 2, 2). `handoffRequest`: A 0, B 1, C 2 (a memory of a running session fails on C). `view(A)` is `{ status: "unavailable", reason: A's reason }` and reads `meta()`; with A's `meta()` throwing `ENOENT`, `view(A)` throws `ENOENT` (a view answered from the memory fails). `view(B)` is `{ status: "available" }`. |

- [ ] **Step 2: Run it and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/handoff-discovery.test.ts`, then `tests/team-handoff.test.ts` on the host, and the typecheck.

### Task 3: readings polling

**Files:** `packages/host/src/readings.ts` (lines `100-105`, `175-207`), `tests/readings.test.ts`.

**Interfaces (produces):**
```ts
/** Sessions that can never need a title reading: their latest snapshot, valid while the row's title is the same. */
private readonly settledSessions = new Map<string, { title: string; latest: LatestSession }>();
```

**Decisions:** in the loop of `observeRows`, an entry whose `title` equals `row.title` sets `latestSessions` to its `latest` and skips `meta()` and `onSession`. `queueTitleReading` returns without effect for such a session, so the skip changes nothing. Otherwise the loop runs as today, and keeps the entry when `latest.promptLineLength <= 60`: an owner title, an empty prompt, or a first line of at most 60 characters. A `meta()` failure also deletes the entry. A `snapshot` or `tick` deletes entries whose ids are not in the rows. A title candidate keeps its read, so no full prompt is kept, as `background polling retains compact session snapshots instead of full prompts and messages` requires.

- [ ] **Step 1: Write the failing test** with `setup()`'s config and key and a stub manager with a counting `meta`.

| Test name | Assertions |
|---|---|
| `polling reads a session record once unless a title reading may follow` | Rows O (title `Fix the login flow`), S (title `""`, prompt `Short prompt`), C (title `""`, prompt `longLine`), all `working`. After two `tick()` calls: reads O 1, S 1, C 2 (today: 2, 2, 2; a memory of candidates fails on C). `merge([S row])` gives `reading.title` `{ text: "Short prompt", source: "first-line" }` with no new read. O's row renamed: the next `tick()` reads O again. |

- [ ] **Step 2: Run it and confirm it fails.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/readings.test.ts` and the typecheck.

- [ ] **Step 5 (coordinator): run `npm run check` once, request the independent review, and commit.** After the release, with the host idle for 60 s, check the acceptance: the host process's mean CPU, and the 90th percentile of 200 sequential `GET /api/me` requests.

## Not in this slice

- **One shared listing per tick for all pollers.** The estimate is under the acceptance. It is the next step if the host measures above 15% after the release.
- **The handoff poll interval and the journal scan of running sessions with a policy.** A running source still costs one scan a tick, as today.
- **A memory of refused connects.** A crashed worker's stale socket still costs one failed connect per listing. A connect that arrives between a worker's `bind` and its `listen` is refused, so a memory of refusals needs more proof than this slice gives.
- **Caching `meta()` or `state()`.** They have about 70 call sites, several in lifecycle decisions, and the full records of 2,000 sessions parse to about 65 MB.
- **The exited row's `lastActivityAt`**, which is the listing time. It is part of a route's answer, so it stays.
