# Outcome Ledger Implementation Plan (INF-184)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every attempt one durable outcome row, written from typed run events when each fact happens.

**Architecture:** `TeamService` appends typed events to an outbox in the sealed run record. A flush stores them in the evidence store and runs projectors in the same transaction. The projectors write outcome rows, which the scorecard and later designs read.

**Tech Stack:** TypeScript, `zod`, `node:crypto`, `node:test`. The evidence store of INF-182.

**Spec:** `docs/superpowers/specs/2026-11-12-outcome-ledger-design.md`, under the shared contracts in `docs/superpowers/specs/2026-11-12-self-improving-teams-design.md` (C2, C4, C5, C7).

This plan grows one section per slice. Each slice is one pull request.

## Global Constraints

- Node.js 22.14 or later. No new dependency.
- The ledger observes. No `TeamService` decision reads it, and a store failure never stops a run.
- A model never labels a task's area or lowers its risk.
- A durable row holds no objective, instructions, summary, path, or URL in a plain column.
- No home path, host name, account name, or secret in any tracked file (`AGENTS.md`).
- Focused tests run with `node --import tsx --test tests/FILE.test.ts`. The full check is `npm run check`.

## Slices

| Slice | Content | Needs |
|---|---|---|
| Task features | The pure rules for area, kind, and risk. This section | nothing |
| Event outbox | `EventOutbox` with the projector registry | INF-182 phase 1 |
| Run events | The outbox in the run record, `emit`, the flush, and the run-level kinds | Event outbox |
| Member and task events | The member and task kinds, with features on `task.planned` | Run events, Task features |
| Check, review, repair, delivery events | The remaining kinds and the emission-coverage test | Run events |
| Configuration identity | `configId`, `configurations`, `profile_epochs` | Run events |
| Projection | Outcome rows, run summaries, member results, the backfill | all events |

---

# Slice: task features

Spec part 2. Pure functions and a configuration schema. Nothing calls them yet.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/task-features.ts` (create) | Area, kind, and risk rules, the feature map schema, and its digest |
| `tests/task-features.test.ts` (create) | Rule tests |

## Review Focus

1. A task that owns only test or documentation paths. Expect those paths to vote, so the area is not empty.
2. A path whose name contains a risk token inside a longer word, such as `author.ts` for `auth`. Expect `normal`, because a token is a whole word. A camel-case name such as `oauthClient.ts` splits into words, so it is `elevated`. So is a capital, compound, or plural form such as `K8sClient.ts`, `DockerFileBuilder.ts`, or `authorizations.ts`. A lower-case compound such as `authservice.ts` stays `normal`, which is the rule's stated limit.
3. An area map with two prefixes that both match a path. Expect the longest prefix to win, and the first entry on a tie.
4. A coordinator label that tries to lower risk. Expect no such input to exist: the label can only be `elevated`.
5. Paths with upper-case letters. Expect tokens to compare in lower case, and area names to keep the path's own case.

### Task 1: the feature rules

**Interfaces (produces):**

```ts
export const FEATURE_VERSION = 1;
export const TASK_KINDS = ["feature", "fix", "refactor", "test", "docs", "investigation"] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type TaskRisk = "normal" | "elevated";
export const DEFAULT_ELEVATED_TOKENS: readonly string[];
export const featureMapSchema: z.ZodType<FeatureMap>;
export interface FeatureMap {
  areas: { id: string; paths: string[] }[];
  elevated?: string[];          // path prefixes
  elevatedTokens?: string[];    // replaces the default list
}
export interface TaskFeatures {
  role: "implementer" | "scout";
  area: string;
  kind: TaskKind | null;
  risk: TaskRisk;
  featureVersion: number;
  featureMap: string;           // "default", or the map's digest
}
/** "default" for no map. Otherwise the SHA-256 hex of the map's canonical JSON. */
export function featureMapDigest(map?: FeatureMap): string;
export function isTestPath(path: string): boolean;
export function isDocPath(path: string): boolean;
/** The paths that vote: every path that is neither a test nor a doc path, or all paths when none is left. */
export function votingPaths(paths: readonly string[]): string[];
export function pathArea(path: string, map?: FeatureMap): string;
export function taskArea(paths: readonly string[], map?: FeatureMap): string;
export function taskRisk(paths: readonly string[], map?: FeatureMap, label?: "elevated"): TaskRisk;
export function taskFeatures(
  input: { role: "implementer" | "scout"; paths: readonly string[]; kind?: TaskKind; risk?: "elevated" },
  map?: FeatureMap,
): TaskFeatures;
```

**Decisions:**

- `featureMapSchema` is strict. `areas` has at most 64 entries and may be empty, for a project that sets only risk rules. An area `id` matches `/^[a-z][a-z0-9-]{0,39}$/` and is never `mixed`, `none`, or `root`. Area ids are unique. Each area has 1 to 32 `paths`. `elevated` has at most 64 prefixes. `elevatedTokens` has at most 64 tokens, each matching `/^[a-z0-9]{2,40}$/`. A path prefix is a repository-relative path of at most 300 characters with no leading or trailing slash, no empty, `.`, or `..` segment, no backslash, and no control character. The single prefix `.` matches every path.
- `isTestPath` and `isDocPath` use the rules that `diffStat` in `packages/host/src/teams.ts` uses today: a doc path starts with `docs/` or ends with `.md`. A test path matches `/(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i`.
- **Prefix match.** A prefix matches a path as `teamPathAllowed` in `packages/host/src/team-workspace.ts` does: the prefix is `.`, or equals the path, or the path starts with the prefix and a slash.
- **`pathArea`.** With a map, the area whose prefix is the longest match wins, and the earlier area wins a tie. Without a match, the area is a directory name with a trailing slash: the first two segments when the first segment is `apps`, `packages`, `services`, `libs`, `crates`, `cmd`, or `modules` and the path has at least three segments, and the first segment otherwise. A path with one segment is `root`. The trailing slash keeps a fallback area apart from a mapped id and from `mixed`, `none`, and `root`. A path that is empty, starts with a slash, holds a backslash, or has an empty, `.`, or `..` segment is not a valid owned path, and its area is `root`.
- **`taskArea`.** A scout task is `none`, which `taskFeatures` sets. For other tasks it is the one area of the voting paths, or `mixed` when they have more than one. A task with no paths is `mixed`.
- **`taskRisk`.** `elevated` when the label is `elevated`, or any owned path matches an `elevated` prefix, or a voting path spells an entry of the token list. Chunks are the runs of ASCII letters and digits in the path. A chunk splits into atoms with `/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g`: an upper-case run that no lower-case letter follows, a lower-case word with at most one leading capital, or a digit run. A path spells an entry when some run of adjacent atoms of one chunk, joined in lower case, equals the entry, or the entry followed by `s`. A run longer than 41 characters is not tried. The token list is `elevatedTokens` when the map sets it, and `DEFAULT_ELEVATED_TOKENS` otherwise. *(My call after review: an owner's explicit prefix applies to every owned path, an entry is found wherever the path marks its word boundaries, and a plural matches its singular, because a missed risk is the costly mistake.)*
- **Known limit of the token rule, by design.** A boundary is a separator, a camel-case boundary, or a boundary between a letter and a digit. A lower-case compound such as `authservice` or `k8sclient` is one atom and spells nothing. A separator ends a chunk, so `per-mission` does not spell `permission`. The rule is a default, not a guarantee: a project covers such names with `elevatedTokens` or an `elevated` prefix, and a plan task can carry the label.
- **`DEFAULT_ELEVATED_TOKENS`**, singular forms only, because the match rule covers a plural: `auth`, `authn`, `authz`, `authorization`, `authentication`, `authorize`, `authenticate`, `oauth`, `permission`, `security`, `secret`, `vault`, `credential`, `password`, `migration`, `migrate`, `billing`, `payment`, `deploy`, `deployment`, `sudoers`, `workflow`, `terraform`, `k8s`, `kubernetes`, `dockerfile`, `env`, `ci`.
- **`taskFeatures`.** For a scout: area `none`, kind `investigation`, risk from the same rule. For an implementer: kind is the label, or null when absent. `featureVersion` is `FEATURE_VERSION`. `featureMap` is `featureMapDigest(map)`.
- Canonical JSON for the digest sorts object keys and keeps array order.

- [ ] **Step 1: Write the failing tests** in `tests/task-features.test.ts`.

| Test name | Assertions |
|---|---|
| `a path takes the area of its longest mapped prefix` | With areas `host: ["packages/host"]` and `host-teams: ["packages/host/src/teams.ts", "packages/host/src/team-types.ts"]`: `packages/host/src/teams.ts` is `host-teams`, and `packages/host/src/usage.ts` is `host`. With two areas that list the same prefix, the first wins. A prefix of `.` matches every path. |
| `an unmapped path falls back to its leading segments` | `packages/host/src/usage.ts` is `packages/host/`. `apps/mobile/src/api/client.ts` is `apps/mobile/`. `packages/README.md` is `packages/`. `scripts/run-tests.mjs` is `scripts/`. `README.md` is `root`. `Docs/Guide/intro.txt` is `Docs/`. |
| `test and doc paths do not vote unless nothing else is owned` | `["packages/host/src/usage.ts", "tests/usage.test.ts", "docs/teams.md"]` has area `packages/host/`. `["tests/usage.test.ts"]` has area `tests/`. `["docs/teams.md", "tests/a.test.ts"]` is `mixed`. `votingPaths` returns the expected lists. |
| `a task over two areas is mixed` | `["packages/host/src/a.ts", "apps/web/src/b.ts"]` is `mixed`. An empty list is `mixed`. |
| `risk rises on a token, a prefix, or a label` | `packages/host/src/auth/session.ts` is `elevated`. `packages/host/src/author.ts` is `normal`. `deploy/ubuntu/infinite.sudoers` is `elevated`. `.github/workflows/ci.yml` is `elevated`. `packages/host/src/Permissions.ts` is `elevated`. `src/runtime.ts` is `normal`, and `elevated` with `elevated: ["src/runtime.ts"]`. `src/oauthClient.ts`, `src/PaymentsService.ts`, `src/authentication.ts`, `db/migrate/001.sql`, `infra/terraform/main.tf`, `.env`, `Dockerfile`, `k8s/service.yaml`, and `.gitlab-ci.yml` are `elevated`. So are the capital and digit forms `src/K8sClient.ts`, `K8S/service.yaml`, `src/k8sClient.ts`, `src/OAuth2Client.ts`, `src/AUTHService.ts`, `build/DockerFile`, `src/DockerFileBuilder.ts`, `src/K8S2Client.ts`, and `src/authV2Handler.ts`, and the plurals `src/authorizations.ts`, `src/authentications.ts`, `src/permissions.ts`, and `infra/envs/prod.ts`. `src/environment.ts`, `src/cinema.ts`, `src/cinemas.ts`, `src/authors.ts`, and `src/classes.ts` are `normal`. With `elevatedTokens: ["ledger"]`, `src/auth.ts` is `normal`, and `src/ledger.ts` and `src/ledgers.ts` are `elevated`. With `elevatedTokens: ["oauth", "s3"]`, `src/OAuthClient.ts` and `src/S3Bucket.ts` are `elevated` and `src/Client.ts` is `normal`. The label `elevated` raises a `normal` task. |
| `a token needs a word boundary` | `src/authService.ts`, `src/auth_service.ts`, `src/auth-service.ts`, `src/k8sClient.go`, and `src/auth2.ts` are `elevated`. `src/authservice.ts`, `src/k8sclient.go`, `src/per-mission-budget.ts`, and `src/reauth.ts` are `normal`. A name of 1,200 mixed-case letters that ends in `Auth` is `elevated`, and a name of 3,000 lower-case letters is `normal`. |
| `an explicit elevated prefix applies to every owned path` | With `elevated: ["docs/deploy"]`, `["src/ui.ts", "docs/deploy/run.sh"]` is `elevated`. Without the map it is `normal`. |
| `a prefix matches whole segments only` | The prefix `src` matches `src/a.ts` and not `src2/a.ts`, for areas and for elevated prefixes. |
| `malformed paths never throw and reserved directory names do not collide` | `none/a.ts` is `none/`, `mixed/a.ts` is `mixed/`, and `root/a.ts` is `root/`. An empty path, `/src/x.ts`, `./src/x.ts`, `a//b.ts`, and a path with a backslash each give `root`. |
| `a test path alone does not raise risk for a task that owns source` | `["packages/host/src/usage.ts", "tests/auth.test.ts"]` is `normal`. `["tests/auth.test.ts"]` is `elevated`. |
| `task features combine the rules` | An implementer with `kind: "fix"` gets that kind, and without a label gets null. A scout gets area `none` and kind `investigation`. `featureVersion` is 1. `featureMap` is `default` without a map and a 64-character hex with one. |
| `the feature map digest is stable` | Two maps that differ only in object key order give one digest. A changed prefix gives another. |
| `the feature map schema refuses bad maps` | An area id `mixed`, a duplicate id, an id with upper case, a prefix with `..`, a prefix with a leading slash, a token with a hyphen, and an unknown key are each refused. A valid map parses. |

- [ ] **Step 2: Run the tests and confirm they fail** with a missing module error.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass**, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

## Not in this slice

- The `features` key in the project team configuration, the `kind` and `risk` fields of a plan task, and the prompt line. They arrive with the member and task events.

---

# Slice: event outbox

Spec part 1, the storing and projecting half. A small module over the evidence store. Nothing calls it yet.

**Events first, projections by cursor.** A flush stores events in one transaction. Each projector then advances from its own cursor over the event table, in its own transaction. *(After review: a projector can arrive after its events. A later slice ships the first projector, and a module can be unavailable for a while. A flush that projected only the events it inserted would never project those, and would still tell its caller to drop them. Capture cannot be backfilled, so storing an event must never wait for a projection.)*

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/evidence/outbox.ts` (create) | `EventOutbox`: the flush, the projector registry, the cursors, and `advance` |
| `packages/host/src/evidence/store.ts` (modify) | Export the pure event check and the kind rule that `appendEvent` already applies, read events through a given connection, refuse any operation on a write whose transaction SQLite has ended, and call module delete hooks before a run's events are removed |
| `tests/evidence-outbox.test.ts` (create) | Flush, cursor, and registry tests |
| `tests/evidence-store.test.ts` (modify) | Tests for the two store changes |

## Review Focus

1. An event stored before its projector existed. Expect the projector to see it, once, when it advances.
2. A projector that throws for one event. Expect its own batch to roll back with its cursor, the events to stay stored, and the other projectors to run. Expect it to project in order once it is fixed.
3. An event the store can never accept, or one that cannot be read, in a list with good events. Expect the good events to be stored and the bad one counted.
4. A repeated flush of the same events. Expect no second event row and no second projection.
5. A closed or unavailable store, and a long backlog. Expect `flush` to return at once, without reading the events.

### Task 1: the event check, the event reader, and the outbox

**Interfaces (consumes):** `EvidenceStore` (`status`, `register`, `tryWrite`, `appendEvent`), `EvidenceTx`, `EvidenceDb`, `RunEvent` from INF-182 phase 1.

**Interfaces (produces):**

```ts
// packages/host/src/evidence/store.ts
/** Why `appendEvent` would refuse this event, or undefined when it would accept it. Pure, and it never throws. */
export function eventProblem(event: Omit<RunEvent, "seq">): "invalid-event" | "event-too-large" | undefined;
/** Whether a value is an event kind. The store and the outbox share this one rule. */
export function isEventKind(kind: unknown): kind is string;
export type EventQuery = { runId?: string; kinds?: string[]; after?: number; limit: number };
export class EvidenceStore {
  /** `events` through a given connection: the transaction of a write sees its own uncommitted rows. */
  eventsIn(db: EvidenceDb, query: EventQuery): { events: RunEvent[]; cursor: number; more: boolean };
}

// packages/host/src/evidence/outbox.ts
export type OutboxEvent = Omit<RunEvent, "seq">;
export interface EventProjector {
  /** Unique among projectors, /^[a-z][a-z0-9-]{0,39}$/. The outbox keeps one cursor under this name. */
  name: string;
  /** A module registered with the store. Its tables are the ones this projector writes. */
  module: string;
  /** Exact kinds such as "task.integrated", or a prefix that ends with a dot, such as "duel.". */
  kinds: readonly string[];
  /** Runs inside the projector's own transaction, once per matching event, in `seq` order. Must be synchronous. */
  project(tx: EvidenceTx, event: RunEvent): void;
}
export type FlushResult = {
  /** True when every accepted event is in the store. False means none of this flush was stored. */
  stored: boolean;
  /** Events the store can never accept. The caller drops them when `stored` is true. */
  refused: number;
};
export type AdvanceResult = {
  /** Matching events projected by the projectors that committed. */
  projected: number;
  /** True when some projector still has stored events it has not seen, or cannot run. */
  pending: boolean;
  /** Projectors that cannot run until someone repairs them. Each also counts as pending. */
  blocked: { name: string; reason: "definition-changed" | "cursor-ahead" }[];
};
export class EventOutbox {
  constructor(store: EvidenceStore);                       // one outbox per store: TypeError when the store already has the module
  registerProjector(projector: EventProjector): void;   // TypeError on a bad projector
  flush(events: readonly OutboxEvent[]): FlushResult;    // never throws
  advance(limit?: number): AdvanceResult;                // never throws
}
```

**Decisions:**

- **`appendEvent` does not change.** One internal function examines an event with exactly the reads and the one serialization pass that `appendEvent` made before. `appendEvent` calls it once and throws the same three errors with the same messages. `eventProblem` calls the same function and maps a thrown error to `invalid-event`. *(After review: a second serialization pass changed the row stored for data with a stateful getter.)*
- `isEventKind` holds the kind rule (the pattern and the 64-character limit) that the event check uses.
- `eventsIn(db, query)` and `events(query)` share their code, and `events` makes exactly the property reads it made before, in the same order: its validation first, then the reads inside the reader callback. *(After review round 2: sharing the code must not change what `events` returns for any query object.)*
- **A write's transaction must be alive for every operation.** Before each `run`, `exec`, `get`, `all`, `seal`, `open`, and `index` on a write's `tx`, and before `appendEvent`, the store checks that SQLite still has the transaction open. When it does not, the operation throws `EvidenceError("invalid-statement")` and runs nothing. SQLite ends a transaction by itself on a conflict clause such as `INSERT OR ROLLBACK` and on some failures (a full disk, an I/O error). Module code that caught such an error and kept writing would otherwise commit each later statement by itself. The check reads `isTransaction` where the runtime has it. Where it does not, the store tries a plain `BEGIN`: SQLite refuses one inside a transaction, and when it accepts one the store rolls it back and treats the write as ended. *(After review round 2. This is a defect in the store from INF-182 phase 1, and the cursor guarantee depends on it.)*
- **Module delete hooks run before a run's events are removed**, in the same transaction, so a hook can still read them.
- **Parameters are plain values.** `run`, `get`, and `all` take positional parameters only: null, a number, a bigint, a string, or bytes. The store copies them first (bytes into a new buffer), then makes its liveness check, then runs the statement with the copies. Any other parameter, such as an object of named bindings, is refused with a `TypeError` and nothing runs. So binding a statement runs no caller code. *(After review round 3: a named-binding object with a getter could end the transaction after the liveness check and before the statement ran.)*
- **Who the guards protect against.** Module and projector code is host code that we write and review. The store's guards catch mistakes in that code: a statement that ends the transaction, an error that was caught and ignored, a wrong parameter. They are not a boundary against code written to defeat them, and a review does not need to prove one. *(My call after review round 3, confirmed by the owner on 2026-11-13.)*
- **The outbox owns one evidence module**, `event-outbox`, version 1, with one table: `projector_cursors (name TEXT PRIMARY KEY, seq INTEGER NOT NULL, definition TEXT NOT NULL, lost INTEGER NOT NULL DEFAULT 0)`. The constructor registers it, and throws a `TypeError` when the store already has that module: a store has one outbox. A cursor is the `seq` of the last event its projector has passed.
- **A projector's definition is bound to its name.** The definition is the SHA-256 hex of the canonical JSON of `{ module, kinds }` with `kinds` sorted. A projector's first committed write stores it with the cursor. When a stored row under the same name has another definition, the projector does not run: it is blocked with the reason `definition-changed`. To change what a projector matches, give it a new name and rebuild its rows in its module's migration. *(After review round 2: a projector that changed its kinds would inherit the old cursor and never see the events it newly matches.)*
- **A cursor beyond the event sequence blocks its projector**, with the reason `cursor-ahead`. The high-water mark is the `seq` that SQLite keeps for `run_events` in `sqlite_sequence`, or 0 when it has none. It is not the largest stored `seq`, because a deleted run can leave that below a valid cursor.
- A blocked projector is skipped, counts as pending, is listed in `blocked`, and stays blocked for the life of the outbox object. The outbox logs one line per name and reason, with fixed words only.
- **Deleting a run wins, and the loss is recorded.** The store removes a run's events at once. The outbox module's `deleteRun` hook runs first: for each registered projector it counts the run's events after the projector's cursor whose kind the projector matches, and adds that count to the projector's `lost` column (it creates the row at cursor 0 when the projector has none). The module's `counts` hook reports `projectors` and `lost`, so `infinite evidence status` shows them. A cursor that `advance` would not trust is not trusted here either: when a projector's stored row has another definition, or a cursor above the high-water mark, the hook counts every event of the run that the projector matches, and it adds to `lost` without changing the stored cursor or definition. A caller that wants no loss calls `advance()` first and deletes when `pending` is false. The module's `runIds` hook returns an empty list. *(After review round 2: a run deleted while a projector was behind lost its projections without a trace. The run events slice makes retention deletes wait for the projectors, within a limit.)*
- **`registerProjector`** throws a `TypeError` when the name does not match the pattern or is already registered, when the module is not registered with the store or is `store` or `event-outbox`, when `kinds` is empty or has more than 64 entries, when an entry is neither an event kind nor a prefix, or when `project` is not a function. A prefix ends with a dot, and adding one more segment to it gives an event kind by `isEventKind`. Projectors run in registration order.
- A projector matches an event when one of its kinds equals the event kind, or is a prefix and the event kind starts with it.
- **`flush(events)`**, in this order:
  1. An empty list returns `{ stored: true, refused: 0 }` and touches nothing, the store included.
  2. A store that is not `ready` returns `{ stored: false, refused: 0 }` before any event is read. *(After review: the caller flushes on every save, so an unavailable store must cost nothing per waiting event.)*
  3. Each event is copied into a snapshot: the eight fields `key`, `runId`, `revision`, `at`, `kind`, `memberId`, `taskId`, `data` are each read once, and `data` is copied through its canonical JSON. No other property is read. An event whose snapshot throws, or for which `eventProblem` returns a value, is refused and counted. *(After review: a value that reads differently the second time, or an unrelated property that throws, must not fail a batch on every retry.)*
  4. When every event is refused, the result is `{ stored: true, refused }` and no write happens.
  5. One `store.tryWrite` appends every snapshot with `appendEvent`, in list order. A failed write returns `{ stored: false, refused: 0 }`.
  6. After a stored write, `flush` calls `advance()` once and returns `{ stored: true, refused }`. The result never depends on a projector.
- **`advance(limit = 500)`** clamps `limit` to 1 through 500. For each projector, in registration order:
  - A projector whose module is not `ready` is skipped and counts as pending.
  - One `store.tryWrite`: read the projector's cursor (0 when it has none); read `eventsIn(tx, { after: cursor, limit })`; call `project(tx, event)` for each matching event in order; when the page held any event, store the page's cursor as the projector's cursor.
  - A projector that throws, or returns a thenable, fails its own write. Its rows and its cursor roll back together, the events stay stored, and the next projector still runs. A thenable's rejection is consumed.
  - `projected` adds the matching events of each write that committed. `pending` is true when a write failed, a module was not ready, or a page reported more events.
- **Exactly once, in order.** A projector's rows and its cursor commit together, and the cursor passes every event it read, matching or not. So a projector sees each matching event once, in `seq` order, whether the event came from this flush, an earlier flush, another writer, or a release that had no such projector. A new projector starts at the beginning of the event table.
- A store that is not `ready` makes `advance` return `{ projected: 0, pending: true, blocked: [] }` when projectors exist, and `{ projected: 0, pending: false, blocked: [] }` when none do.
- `flush` and `advance` catch every error. They log nothing themselves, because `tryWrite` logs one line per failure kind.
- The caller bounds the list it passes. The team service keeps at most 2,000 waiting events per run.

- [ ] **Step 1: Write the failing tests** in `tests/evidence-outbox.test.ts`. Each test builds a store in a fresh temporary directory with a 32-byte key, as `tests/evidence-store.test.ts` does, and registers a module `probe` with one table `probe_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, kind TEXT NOT NULL, who TEXT NOT NULL)`.

| Test name | Assertions |
|---|---|
| `a flush stores events and advances matching projectors once` | A projector `p-tasks` for `task.integrated` inserts a row. Flush `run.created` and `task.integrated` for one run: the result is `{ stored: true, refused: 0 }`, `events({ runId, limit: 10 })` returns both in order, `probe_rows` has one row whose `seq` equals the stored `task.integrated` event's `seq`, and the projector's cursor equals the last stored `seq`. A second flush of the same list returns the same result and adds no event and no probe row. |
| `an event stored before its projector existed is projected` | Flush two matching events with no projector. Register the projector and call `advance()`: the result is `{ projected: 2, pending: false }` and both rows exist, in `seq` order. Then append a third matching event directly with `store.write` and `appendEvent`, and flush that same event: the result is `{ stored: true, refused: 0 }` and its row exists once. |
| `a projector failure rolls back its own batch only` | Projector `p-a` throws for the second of three matching events, after it wrote a row for the first. Projector `p-b` writes a row for each. After the flush: the result is `{ stored: true, refused: 0 }`, all three events are stored, `p-b` has three rows, `p-a` has none, and `p-a` has no cursor. After `p-a` stops throwing, `advance()` returns `{ projected: 3, pending: false }` and `p-a` has three rows in `seq` order. |
| `an unavailable module is skipped and catches up later` | A module `broken` whose `migrate` throws is `unavailable`. With a projector on `broken`, a flush of a matching event returns `{ stored: true, refused: 0 }`, the event is stored, and `advance()` returns `pending: true`. After the store is closed and opened again with a `broken` module that migrates, a new outbox with the same projector name returns `{ projected: 1, pending: false }` from `advance()`. |
| `an unavailable store leaves events waiting and reads none of them` | For a store opened with the wrong key, and for a closed store: a flush of an event whose `kind` getter counts its reads returns `{ stored: false, refused: 0 }` and the count is 0. `advance()` returns `{ projected: 0, pending: true }` with a projector registered beforehand on a ready store that was then closed. |
| `a refused event is counted and does not block the others` | A list with a kind `Bad Kind`, an event whose data is over 16 KiB, an event whose `kind` getter throws, and one valid event gives `{ stored: true, refused: 3 }`, and only the valid event is stored. A list with only refused events gives `{ stored: true, refused: n }` and stores nothing. |
| `an event is read once and only by its known fields` | A proxy counts every property read of an event: each of the eight known fields is read exactly once, and no other property is read. An event with an enumerable `extra` getter that throws is stored, and the getter was never called. An event whose `data.value` getter returns 1 on the first read and a BigInt on later reads is stored with `value` 1. The projector receives an event object with exactly the known fields and `seq`. |
| `a prefix projector receives its kinds` | A projector with `kinds: ["duel."]` receives `duel.started` and `duel.resolved`, and does not receive `duels.other` or `run.created`. |
| `projector registration is validated` | Each of these throws a `TypeError`: a name `Bad Name`, a repeated name, an unknown module, the module `store`, the module `event-outbox`, an empty `kinds`, 65 kinds, a kind `Bad Kind`, a prefix `.`, a prefix `duel..`, and a missing `project`. A projector with 64 kinds is accepted. Two projectors for one kind write their rows in registration order. |
| `an async projector fails its own batch` | A projector writes a row and then returns a rejected promise. After the flush the events are stored, the projector has no row and no cursor, and no unhandled rejection is reported to the process. |
| `advance works in pages` | Seven matching events are stored. `advance(3)` projects 3 with `pending: true` twice, and then 1 with `pending: false`. With three more events stored through the store, `advance(0)` projects exactly 1, because 0 is clamped to 1. With 501 more, `advance(9999)` projects 500 with `pending: true`, because the limit is clamped to 500. A page that holds only events the projector does not match projects 0 and moves the cursor to the page's last `seq`. |
| `a cursor survives a restart` | After a flush advances a projector, the store is closed and opened again. A new outbox with the same projector returns `{ projected: 0, pending: false, blocked: [] }`, and a new matching event is projected once. No earlier event is projected again. |
| `a changed definition blocks the projector` | A projector `p` for `run.created` advances past a stored `task.integrated` event. After a reopen, `p` registered for `task.integrated` is not run: `advance()` returns `pending: true` and `blocked: [{ name: "p", reason: "definition-changed" }]`, and its `project` was never called. The same name with the same module and the same kinds in another order is not blocked. The same name and kinds on another module is blocked. |
| `a cursor beyond the event sequence blocks the projector` | A cursor row is written with `seq` 100 while the event table has one event. `advance()` returns `pending: true` and `blocked: [{ name, reason: "cursor-ahead" }]`, and nothing is projected. A cursor equal to the high-water mark, after the run that held the last events was deleted, is not blocked. |
| `deleting a run records the events a projector never saw` | Two matching events and one non-matching event are stored for a run, with a projector registered and not advanced. `store.deleteRun(runId)` returns true. `store.describe().counts` then shows `event-outbox.lost` 2. `advance()` projects 0 with `pending: false`. A run deleted after its projector passed its events adds nothing to `lost`. |
| `deleting a run counts every matching event when the cursor is not trusted` | With a cursor row moved above the high-water mark, a new matching event is stored and its run is deleted: `lost` rises by 1. With a projector whose stored definition differs from the registered one, a run with two events that the registered definition matches is deleted: `lost` rises by 2, and the stored `seq` and `definition` are unchanged. |
| `a blocked projector is logged once` | With a blocked projector, three calls to `advance()` each list it in `blocked`, and `console.warn` was called once for it. |
| `a second outbox on one store is refused` | `new EventOutbox(store)` twice on one store object throws a `TypeError` the second time. |
| `an empty flush is a no-op` | An outbox over a stub store that counts every method call returns `{ stored: true, refused: 0 }` for `flush([])`, and no method was called after construction. |
| `flush and advance never throw` | Each of these returns a result and does not throw: a closed store, a list that is not an array, a list that holds `null`, an array proxy whose `length` throws, a revoked proxy, a projector that throws a value that is not an `Error`, a flush called from inside a projector, and a store whose `status()` throws (a stub). |
| `the event check matches appendEvent` | For a valid event, `eventProblem` is undefined, `appendEvent` stores it, and `events` reads back the same key, kind, and data. For a bad kind, `appendEvent` throws `invalid-event` with the message `The event envelope is invalid.`. For data with a cycle it throws `invalid-event` with `Event data must be a JSON object.`. For data over 16 KiB it throws `event-too-large` with `Event data is larger than 16 KiB.`. `eventProblem` returns the same code for each. For data whose getter counts its reads, `appendEvent` stores the value of the second read, as it did before this change. |

In `tests/evidence-store.test.ts`:

| Test name | Assertions |
|---|---|
| `a write that SQLite rolled back takes no further operation` | A module table has a unique column. In one write: insert row A; run `INSERT OR ROLLBACK` of a duplicate inside a `try`, and catch its error; then insert row B. The insert of B throws `invalid-statement`, the write fails, and neither A nor B is stored afterwards. After the rollback, `run`, `exec`, `get`, `all`, `seal`, `open`, `index`, `appendEvent`, and `eventsIn` each throw `invalid-statement`. |
| `the transaction probe works without the runtime flag` | `transactionOpen`, exported for this test, is called with a stub connection that has no `isTransaction`. When `exec("BEGIN")` throws the nested-transaction error, it returns true. When `BEGIN` succeeds, it returns false and the stub received a `ROLLBACK`. When `BEGIN` throws any other error, it returns false. |
| `a parameter that is not a plain value is refused` | `run`, `get`, and `all` each throw a `TypeError` for an object parameter, an array parameter, and a function parameter, and run nothing. With a named-binding object whose getter runs a conflicting `INSERT OR ROLLBACK`, the call throws, the getter was never called, and no row is committed. A `Uint8Array` parameter is stored, and changing the caller's array afterwards does not change the stored bytes. |
| `module delete hooks see the run's events` | A module's `deleteRun` hook counts the run's rows in `run_events` and writes the count to its own table. After `deleteRun`, the stored count equals the events the run had, and the events are gone. With a second module whose hook throws, `deleteRun` returns false, the first hook's row is not stored, and the run's events remain. |
| `events reads its query as before` | A query whose `runId` getter returns one id for its first three reads and another id afterwards returns the events of the second id, as it did before this slice. |

- [ ] **Step 2: Run the tests and confirm they fail** for the reason each names.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/evidence-outbox.test.ts tests/evidence-store.test.ts`, then `npm run typecheck -w @infinite/host`.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

## Not in this slice

- `Stored.outbox`, `emit`, and the flush calls in `TeamService`. They arrive with the run events.
- Any projector. The projection slice registers the first one, and it starts from the beginning of the event table.
- A scheduled `advance`. The run events slice calls it at start and on a timer.

---

# Slice: run events

Spec part 1, the emission half, for the kinds that belong to the run itself. `TeamService` gains an outbox in the sealed run record and emits the run-level events. The member, task, check, review, repair, and delivery kinds follow in later slices.

Emission is off unless the host passes an `EventOutbox` to `TeamService`. `server.ts` passes one.

## Trust boundary, and what a review checks

`TeamService` is host code, and every event is built by the host from its own run record. No member, provider, or client supplies an event or any part of one. The failures this slice must survive are a crash between two writes, a store that is unavailable for a while, a restart, and a run record that was written before this slice existed. A review looks for a lost or doubled event under those failures, a changed behaviour of a run, and a sealed record that grows without bound. Hostile event shapes are outside this slice: the outbox of the previous slice refuses what the store cannot take.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/run-events.ts` (create) | Pure helpers: the event key, the run summary counts, the limits. No service code |
| `packages/host/src/teams.ts` (modify) | The outbox in `Stored`, `emit`, the flush, the status events in `save`, the startup flush, the run-level emission sites, the `deleteRecord` rule |
| `packages/host/src/server.ts` (modify) | Build the `EventOutbox` from the evidence store, pass it to `TeamService`, and run `advance` at start and on a timer |
| `tests/run-events.test.ts` (create) | Helper tests |
| `tests/team-events.test.ts` (create) | Service tests with a real store, through `schedulerFixture()` |
| `tests/fixtures/team-scheduler.ts` (modify) | `openTeam(options?)` passes service options |
| `docs/superpowers/specs/2026-11-12-outcome-ledger-design.md` (modify) | The `deleteRecord` paragraph of part 1 |
| `docs/teams.md` (modify) | One short paragraph: what the run events are, and that they never change a run |

## Review Focus

1. A host that restarts between the sealed write and the store append. Expect each key once in the store after the restart.
2. A store that is unavailable for a whole run. Expect the run to behave exactly as before, the outbox to stop at 2,000 events, and one `ledger.gap` once the store is back.
3. A record written before this slice (no `ledgerStatus`). Expect no status event for the status it already has, and an event on the next change.
4. An owner who removes a run while the store cannot take events. Expect the run to be removed.
5. A `TeamService` built without an outbox, as most tests build it. Expect no `outbox` key in any sealed record and no behaviour change.

### Task 1: the outbox in the run record, status events, and run creation

**Interfaces (consumes):** `EventOutbox` (`flush`, `advance`), `OutboxEvent`, `FlushResult`, and `eventProblem` from the event outbox slice. `EvidenceStore` from INF-182 phase 1.

**Interfaces (produces):**

```ts
// packages/host/src/run-events.ts
/** The most events one run keeps waiting for the store. */
export const MAX_OUTBOX_EVENTS = 2000;
/** `[kind, runId, ...parts].join(":")`. A part is a string or a number. */
export function runEventKey(kind: string, runId: string, parts?: readonly (string | number)[]): string;
export interface RunSummaryCounts {
  tasks: number; integrated: number; members: number; round: number; checks: number;
  recoveries: number; decisionsByOwner: number; decisionsByCoordinator: number;
  steering: number; permissionEscalations: number; continuations: number;
}
/** Counts from the run record as it is now. Numbers only. */
export function runSummaryCounts(run: TeamRun): RunSummaryCounts;

// packages/host/src/teams.ts
type TeamServiceOptions = { /* existing fields */ events?: EventOutbox };
type Stored = {
  /* existing fields */
  /** Events waiting for the evidence store. Sealed with the record, so a crash loses none. */
  outbox?: OutboxEvent[];
  /** The run status that the last status event was emitted for. */
  ledgerStatus?: TeamRun["status"];
  /** The member whose report or failure caused the block that the next status event reports. */
  ledgerBlockSource?: string;
  /** Events dropped since the last stored flush. */
  ledgerGap?: { dropped: number; firstAt: string };
};
```

Private methods of `TeamService` (the names are fixed, so later slices can call them):

```ts
/** Appends one event to the run's outbox. Never throws. A no-op without `options.events`. */
private emit(stored: Stored, kind: string, keyParts: readonly (string | number)[],
  ids: { memberId?: string; taskId?: string; revision?: number }, data: Record<string, unknown>): void;
/** Sends the outbox to the store. True when nothing is left waiting. Never throws. */
private flushOutbox(stored: Stored): boolean;
```

**Decisions:**

- **Attach by constructor option**, not by a setter. The constructor loads records and can `save` during restart recovery, before any setter runs. With no `events`, `emit` and the flush do nothing, so most tests and every sealed-record snapshot stay as they are.
- `runSummaryCounts`: `tasks` is `run.tasks.length`. `integrated` counts tasks with status `integrated`. `members` is `run.members.length`. `round` is `run.round`. `checks` is `run.checks.length`. `recoveries` is `run.recovery?.attempts ?? 0`. `decisionsByOwner` and `decisionsByCoordinator` count `run.decisions` by `answeredBy`. `steering` is `run.steering.length`. `permissionEscalations` counts `run.permissionDecisions` with status `escalated`. `continuations` is `run.continuations?.length ?? 0`.
- `emit` builds `{ key: runEventKey(kind, run.id, keyParts), runId: run.id, revision: ids.revision ?? run.revision, at: timestamp(), kind, memberId?, taskId?, data: { v: 1, ...data } }`. A data value that is `undefined` is left out.
- `emit` drops an event for which `eventProblem` returns a value, and logs one line per kind for the life of the process. The line names the kind and the problem code, never the data.
- `emit` skips an event whose key is already waiting in the outbox.
- When the outbox would exceed `MAX_OUTBOX_EVENTS`, `emit` removes the oldest event first and adds one to `ledgerGap.dropped`. `firstAt` is the time of the first drop.
- `flushOutbox` returns true at once when there is no `options.events` or the outbox is empty. Otherwise it calls `options.events.flush(stored.outbox)`. When the result is stored, it clears the outbox in memory and adds `refused` to `ledgerGap.dropped`. Then, when `ledgerGap` is set, it emits `ledger.gap` with key part `firstAt` and data `{ dropped }`, clears `ledgerGap`, and flushes once more. It does not write the sealed record. `flush` never waits for a projector, so only a store that cannot take events keeps them waiting.
- **`save`.** The order is: the retention sync that exists today, the status events, `updatedAt`, the sealed write, then `flushOutbox`. The sealed file can keep events that the store already holds until the next save. That is safe, because an append is idempotent by key. *(My call: one sealed write per save. A second write after every flush would double the cost of the most frequent operation.)*
- **Status events.** `save` compares `run.status` with `stored.ledgerStatus`. When they differ it sets `ledgerStatus`, and emits:
  - `run.blocked` when the new status is `blocked`: key parts `[revision, retention.statusAt]`, data `{ code: run.blockCode, sourceMemberId: stored.ledgerBlockSource }`.
  - `run.settled` when the new status is `ready-for-review`, `merged`, `no-change`, or `cancelled`: key parts `[revision, status, retention.statusAt]`, data `{ status, summary: runSummaryCounts(run) }`.
  It always clears `ledgerBlockSource` afterwards. *(`retentionState` syncs `retention.status` whenever it is called, so `save` cannot find a status change there. `ledgerStatus` is the ledger's own marker.)*
- `block` sets `stored.ledgerBlockSource = sourceMember?.memberId` on the line before its last `save`, the one that follows the final status assignment. The two early returns for an automatic recovery do not set it.
- **Load.** In the constructor, a loaded record with no `ledgerStatus` gets its current `run.status`, in memory only. A record that the constructor then blocks and saves emits `run.blocked` through `save`.
- **Startup flush.** At the end of the constructor, `flushOutbox` runs for every loaded record whose outbox is not empty. It saves nothing.
- **`run.created`.** `createRun` emits it before its first `save`: no key parts, `revision: 1`, data `{ projectId, purpose: "work", goalId: goal?.id, goalCycle: goal?.cycle, missionId, handoff: Boolean(internal?.handoff), parentRunId: internal?.baseRunId, lineup: Boolean(lineup), deliveryMode: run.delivery?.mode }`.
- **`server.ts`** builds `new EventOutbox(evidence)` after the store and passes it as `events` in the `TeamService` options. After the services start, it calls `outbox.advance()` up to 20 times while the result is `pending` with no blocked projector, and then once a minute on an unref'd timer that both shutdown paths clear. *(My call: a projector that was behind or failing catches up without waiting for the next event. With no projector registered yet, `advance` returns at once.)*
- With no `options.events`, no method adds an `outbox`, `ledgerStatus`, `ledgerBlockSource`, or `ledgerGap` key to a record.

- [ ] **Step 1: Write the failing tests.**

`tests/run-events.test.ts`:

| Test name | Assertions |
|---|---|
| `a run event key joins the kind, the run, and the parts` | `runEventKey("run.created", "r1")` is `run.created:r1`. `runEventKey("run.blocked", "r1", [2, "2026-01-01T00:00:00.000Z"])` is `run.blocked:r1:2:2026-01-01T00:00:00.000Z`. |
| `run summary counts read the record` | A run with two tasks (one integrated), three members, round 2, four checks, `recovery.attempts` 1, three decisions (one by the owner, one by a coordinator, one unanswered), two steering entries, one escalated and one approved permission decision, and one continuation gives exactly the eleven counts. A minimal run gives zeros. |

`tests/team-events.test.ts`. Each test builds `schedulerFixture()`, an `EvidenceStore` under the fixture's state directory with the fixture's key, and an `EventOutbox`. `events(runId)` reads `store.events({ runId, limit: 100 })`.

| Test name | Assertions |
|---|---|
| `a service without an outbox writes no ledger fields` | `openTeam()` with no options, then `pause`. The sealed record read back has none of `outbox`, `ledgerStatus`, `ledgerBlockSource`, `ledgerGap`. |
| `a settled status emits run.settled once` | With the outbox, `cancel` the fixture run and wait for it to settle. The store has one `run.settled` event with `data.status` `cancelled`, `data.v` 1, and a `summary` with the eleven counts. A later mutation that keeps the status adds no second event. |
| `a blocked status emits run.blocked with its code` | Drive the fixture to a block with a known code (a wrong-agent report, as `tests/teams.test.ts` does). The store has one `run.blocked` event with that `data.code` and the reporting member as `data.sourceMemberId`. |
| `a legacy record emits only on the next change` | `writeTeam()` with status `paused` and no `ledgerStatus`. Opening the service stores no event. A later `cancel` stores one `run.settled`. |
| `events wait while the store is unavailable and arrive after a restart` | Open the service with an outbox over a store opened with a wrong key. `cancel` the run. The sealed record's `outbox` holds the `run.settled` event. Close. Open a second service with an outbox over a store with the right key. The store now holds the event, with no further mutation. |
| `a repeated flush stores each key once` | After an event is stored, write the sealed record back with the same event in `outbox`, and open a new service. The store still has one event with that key. |
| `the outbox stops at its limit and reports the gap` | With an unavailable store, put 2,000 synthetic waiting events in the sealed record, open the service, and `cancel`. The outbox still has 2,000 events, and `ledgerGap.dropped` is 1. After a restart over a ready store, the store has one `ledger.gap` event with `data.dropped` 1. |
| `run creation emits run.created` | `service.create(...)` for the fixture project, as an existing creation test does. The store has `run.created` with `revision` 1, `data.projectId`, `data.purpose` `work`, and `data.lineup` false. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/run-events.test.ts tests/team-events.test.ts tests/teams.test.ts`, then `npm run typecheck -w @infinite/host`.

### Task 2: prepare, revision, retire, and delete events

**Interfaces (consumes):** task 1.

**Decisions:**

- **`run.prepared`.** The completion callback of the `prepare` operation in `createRun`, where `Object.assign(run, workspace)` sets the base commit: no key parts, data `{ baseCommit: run.baseCommit }`.
- **`run.revision-advanced`.** Emitted at each of the six places that advance `run.revision`, after the new revision is set and before that path's `save`: key parts `[new revision]`, data `{ cause, fromRevision, baseChanged }`.

  | Place | `cause` | `baseChanged` |
  |---|---|---|
  | `steer` | `steer` | false |
  | `continueRun` (on the clone `next`, before `save(next)`) | `continue` | false |
  | `resumeVerificationRecovery` | `verification-recovery` | false |
  | `action` (resume) | `resume` | false |
  | `startAutomaticRecovery` | `automatic-recovery` | false |
  | `consume`, moved base | `moved-base` | true |

- **`run.settled` from `retire`.** Where `retire` first sets `run.workspaceRemovedAt` for a run whose status is `blocked`, before that `save`: key parts `[revision, "blocked", run.workspaceRemovedAt]`, data `{ status: "blocked", summary: runSummaryCounts(run) }`. The clone of a blocked run can no longer be resumed, so its rows freeze.
- **`run.deleted` and the `deleteRecord` rule.** `deleteRecord(stored, waitForEvidence)` emits `run.deleted` (no key parts, data `{ status: run.status }`), calls `flushOutbox`, and calls `options.events.advance()` once, before it persists the tombstone.
  - `retire` passes `waitForEvidence: true`. When the flush fails, or `advance` reports `pending` with no blocked projector, `deleteRecord` throws `TeamError(503, "team-evidence-pending", …)` before it removes anything. `retire` already reports a `deleteRecord` failure through `reportRemovalFailure(stored, "record", error)`, whose backoff retries it. `retention.evidenceHeldAt` records the first such failure. Once 24 hours have passed since then, `deleteRecord` removes the record anyway and logs one line. A blocked projector does not hold a delete: it cannot catch up without a repair, and the outbox records the loss.
  - `removeRun` passes `waitForEvidence: false`. The flush and the advance are tried once. The record is removed whatever the result, and one line is logged when events were lost.
  *(My call, and a change to spec part 1, which kept every record until its outbox was empty. An owner's explicit removal is never held back by measurement. An unavailable store is a state of the whole process, such as a missing SQLite build or a changed key, so an unbounded wait would keep records forever.)*
- The existing evidence `deleteRun` call in `deleteRecord` stays after the file is removed.

- [ ] **Step 1: Write the failing tests** in `tests/team-events.test.ts`.

| Test name | Assertions |
|---|---|
| `steering advances the revision and says why` | `steer` stores `run.revision-advanced` with `revision` 2 and data `{ v: 1, cause: "steer", fromRevision: 1, baseChanged: false }`. |
| `a continuation, a resume, and a recovery each name their cause` | One event per path, with `cause` `continue`, `resume`, and `automatic-recovery`, reached as `tests/teams.test.ts` reaches those paths. |
| `preparing a run records its base commit` | After creation and the prepare operation, `run.prepared` has `data.baseCommit` equal to the run's base commit. |
| `removing a blocked run's workspace settles it` | With `now` moved past the blocked retention, a retention pass stores `run.settled` with `data.status` `blocked`. A second pass stores no second event. |
| `an owner removes a run while the store is unavailable` | With an unavailable store, `removeRun` on a cancelled, settled run resolves, and the sealed record is gone. |
| `retention keeps a record while its events wait, for at most a day` | With an unavailable store, a retention pass on a cancelled run past its window keeps the sealed record and records `retention.evidenceHeldAt`. With `now` moved 25 hours on, the next pass removes it. |
| `a deleted run's last event is projected before its events are removed` | With a ready store and a probe projector for `run.deleted`, `removeRun` resolves, the probe saw the event once, and the outbox module's `lost` count is 0. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement**, and amend the spec paragraph.
- [ ] **Step 4: Run** the three test files of task 1 and the typecheck.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

## Not in this slice

- Member, task, check, review, repair, delivery, and rating events.
- `configId`, task features on `task.planned`, and any projector.
