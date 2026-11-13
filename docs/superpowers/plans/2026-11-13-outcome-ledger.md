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

- **`run.settled` from `retire`.** Where `retire` first sets `run.workspaceRemovedAt` for a run whose status is `blocked`, before that `save`: key parts `[revision, "blocked", "workspace-removed"]`, data `{ status: "blocked", summary: runSummaryCounts(run) }`. The clone of a blocked run can no longer be resumed, so its rows freeze. The key holds no timestamp, so a retried removal names the same fact once. When that `save` fails, `retire` reverts `workspaceRemovedAt` and also removes the waiting event with that key from the outbox: a removal that did not start leaves no settled event. *(Decided during the build: `retire` is the one path that reverts its state after a failed save.)*
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

---

# Slice: member and task events

Spec part 1, the emission half, for the member and task kinds. It also delivers the inputs of spec part 2: the `features` key of a project's team configuration, the optional `kind` and `risk` labels of a plan task, and features on `task.planned`. It builds on the run events slice and uses its `emit`, `flushOutbox`, `Stored` fields, `runEventKey`, and test helpers unchanged.

## Trust boundary, and what a review checks

`TeamService` is host code. It builds every event from its own run record, after its own validation. These fields originate from a member or a provider:

- A report's kind. The member chooses it and `teamReportSchema` parses it. Stored as an enumerated code.
- Task and scout ids, owned paths, and the `kind` and `risk` labels. The project manager chooses them. `teamTaskPlanSchema`, `validateTeamPlan`, and the goal scope check them. Ids go into the envelope `taskId`, and scout ids also into `discovery.accepted`. Owned paths go into `task.planned`. Labels enter features as a claim, and `risk` can only raise.
- An `agentProfileId` or an escalation target. A member chooses it and the run's lineup checks it. Umbrella C1 counts a profile id as an enumeration.
- A provider limit's message and reset time, titles, instructions, summaries, questions, and escalation reasons. Never stored.

The rule: event data holds counts, booleans, enumerated codes, host-issued ids, profile ids, timestamps the record stores, and commit hashes. It holds no free text, prompt, or file content. It holds paths only where spec part 1 names them, and for this slice that is `task.planned`: "profile, owned paths, features". The spec's rule for derived rows binds the projector: "A row never holds an objective, instructions, a summary, a rubric reason, a rating note, a path, or a URL." The store seals event data and deletes it with its run (umbrella C1).

The slice must survive: owned paths larger than the store's 16 KiB data limit, a stop barrier that reads the same member on every tick, a launch that re-enters after a restart, a crash between a state change and its `save`, and a service built without `events`. Outside it: how a projector turns events into dispositions, `configId` and profile epochs, and hostile event shapes, which `emit` and the outbox already refuse.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/run-events.ts` (modify) | Pure helpers: `planDigest`, `pathField`, `profileIdentity`, the stop reasons, the replacement causes |
| `packages/host/src/team-types.ts` (modify) | `features` on `teamProjectSchema`; `kind` and `risk` on `teamTaskPlanSchema` |
| `packages/host/src/team-prompts.ts` (modify) | One plan-prompt sentence for the labels; `teamContext` leaves out the feature map |
| `packages/host/src/teams.ts` (modify) | `emitWith`, `linkReplacement`, `memberStopped`, `Stored.ledgerReplaces`, the `readMemberJournal` signature, the emission sites |
| `tests/run-events.test.ts`, `tests/task-features.test.ts`, `tests/team-prompts.test.ts` (modify) | Helper, schema, prompt, and context tests |
| `tests/team-events.test.ts` (modify) | Service tests with a real store |
| `docs/teams.md` (modify) | The `features` key, in one short paragraph |

## Event kinds

Every key is `runEventKey(kind, runId, parts)`. A completion callback runs at most once per operation: a failed operation keeps its intent and blocks the run, and a restart keeps that intent blocked. So no key needs a time.

| Kind | Emitted in | Key parts | `data` besides `v` | Why the key is unique and stable |
|---|---|---|---|---|
| `plan.accepted` | `consume`, `plan` | `[revision]` | `taskCount`, `planDigest`, `parallelism` | One plan per revision: `step` starts a project manager only while `run.tasks` is empty, and every path that empties it advances the revision |
| `task.planned` | same, once per task | `[revision, taskId]` | `profileId?`, `paths` or `pathsOmitted`, `features` | `validateTeamPlan` refuses a repeated task id |
| `discovery.accepted` | `consume`, `explore` | `[revision]` | `parallelism`, `scouts` | `consume` refuses a second discovery in a run |
| `member.started` | `launch` | `[memberId]` | `role`, `purpose`, `sessionId`, `startedAt`, `baseCommit`, profile identity, `unavailable?`, `replaces?` | A host-issued UUID. Only a permission coordinator is queued twice, and it emits nothing |
| `member.reported` | `readMemberJournal` | `[memberId]` | `role`, `reportKind` | Same id. The first report read wins |
| `member.stopped` | `replaceStalledMember`, `switchLimitedMember`, `retireMember`, `step` (halt loop, exit branch) | `[memberId]` | `role`, `reason`, `detail?`, `reported` | Same id. The first stop wins |
| `task.integrated` | `consume`, implementer `result` | `[revision, taskId]` | `commit?`, `headCommit`, `baseCommit`, `memberBaseCommit`, `diff?` | An integrated task never returns to pending in its revision |
| `scout.completed` | `consume`, `findings` | `[revision, taskId]` | none | A complete scout never runs again |
| `task.escalated` | `consume`, `escalate` | `[revision, taskId]` | `fromProfileId?`, `toProfileId` | `consume` refuses a second escalation of a task |
| `task.limit-switched` | `switchLimitedMember` | `[memberId]` of the stopped member | `role`, `fromProfileId`, `toProfileId` | A switched member is stopped and never switched again |

## Review Focus

1. A stop barrier that drains the same revision on every tick. Expect one `member.stopped` per member, with its first reason.
2. A plan task whose owned paths serialize to more than 12 KiB. Expect `task.planned` stored with its features and `pathsOmitted: true`.
3. A service without `events`. Expect no `ledgerReplaces` key in any sealed record. The prompt sentence and the schema fields are the only visible changes.
4. A project with a feature map. Expect no `features` key in any member's context file.
5. A permission coordinator's turns. Expect no member event.

### Task 1: plan, task, and discovery events, with the feature inputs

**Interfaces (consumes):** `emit`, `Stored`, `runEventKey` from run events. `taskFeatures`, `featureMapSchema`, `TASK_KINDS`, `FeatureMap` from task features.

**Interfaces (produces):**

```ts
// packages/host/src/run-events.ts
/** SHA-256 hex of the JSON of one tuple per task, in order:
 *  [id, title, instructions, agentProfileId ?? null, paths, dependsOn, kind ?? null, risk ?? null]. */
export function planDigest(tasks: readonly TeamTaskPlan[]): string;
export const PATH_FIELD_BUDGET = 12 * 1024;
/** `{ paths }` when the UTF-8 JSON of the list is at most `budget` bytes, else `{ pathsOmitted: true }`. */
export function pathField(paths: readonly string[], budget?: number): { paths: string[] } | { pathsOmitted: true };

// packages/host/src/team-types.ts
// teamProjectSchema gains:  features: featureMapSchema.optional()
// teamTaskPlanSchema gains: kind: z.enum(TASK_KINDS).optional(), risk: z.literal("elevated").optional()

// packages/host/src/teams.ts
/** Calls `build` only with `options.events`, then `emit`. Never throws: a throwing `build` drops the event
 *  and logs one line per kind, with fixed words only. */
private emitWith(stored: Stored, kind: string, keyParts: readonly (string | number)[],
  ids: { memberId?: string; taskId?: string; revision?: number }, build: () => Record<string, unknown>): void;
```

**Decisions:**

- Every site in this slice calls `emitWith`. Data that needs work (digests, features, path bounds) is then built only when the ledger is on, and a fault in it never reaches the run.
- **The map.** A site reads `(run.handoff?.project ?? this.config.projects.find(p => p.id === run.projectId)?.team)?.features`, the expression `launch` uses for `configuredProject`. Features are fixed at acceptance, as spec part 2 says.
- **`plan.accepted`.** In the completion callback of the `plan` branch of `consume`, after `run.status = "implementing"` and its `this.event`, at the end of the callback. `operation` saves right after the callback. Ids `{ memberId: member.memberId, revision: member.revision }`. Data: `taskCount: run.tasks.length`, `planDigest: planDigest(run.tasks)`, `parallelism: run.parallelism` after `applyProjectManagerCapacity`. *(My call: the digest covers every planned field, so two different plans never share it. The draft hashed id, profile, paths, and `dependsOn` only.)*
- **`task.planned`.** Right after `plan.accepted`, once per task in `run.tasks` order, which is dependency order. Ids `{ taskId: task.id, revision: member.revision }`. Data: `profileId: task.agentProfileId` (absent on a single-provider run), `...pathField(task.paths)`, and `features: taskFeatures({ role: "implementer", paths: task.paths, kind: task.kind, risk: task.risk }, map)`. Features are computed from the full list even when the paths are omitted. `dependsOn`, the title, and the instructions are not stored. *(My call: the store refuses data over 16 KiB, and 32 owned paths of 300 multi-byte characters exceed it. Omitting the list keeps the event, and the projector then counts the task's rounds as unknown.)*
- **`discovery.accepted`.** In the completion callback of the `explore` branch, after `run.status = "discovering"`. Ids as `plan.accepted`. Data: `parallelism: run.parallelism`, and `scouts: run.discovery.tasks.map(scout => ({ taskId: scout.id, profileId: scout.agentProfileId, features: taskFeatures({ role: "scout", paths: [] }, map) }))`. *(My call: the spec lists only the profile. A scout row needs area, kind, risk, and featureVersion too, and features are fixed at acceptance.)*
- **Schema.** Both new keys are optional. `repo-enrollment.ts` parses `teamProjectSchema` too, so the owner can set a map through the enrollment route. `z.toJSONSchema` in `team-mcp.ts` picks up the plan labels by itself.
- **Prompt.** One sentence follows the `Report {"kind":"plan",…}` sentence in the project-manager branch of `teamPrompt`: `Each task may add "kind" (feature, fix, refactor, test, docs, or investigation) and "risk":"elevated" when it touches authorization, money, data migration, or deployment.` No prompt names a token, a prefix, or an area. *(My call: the labels and this sentence apply with or without `events`. They are plan inputs, as `dependsOn` is.)*
- **Context.** `teamContext` leaves out `features` from `configuredProject` and from `authority.handoff.project`. Today it spreads the whole project object into every member's context file. *(My call: a member that reads the elevated tokens can shape its owned paths around them, and umbrella C4 says a model never lowers risk.)*

- [ ] **Step 1: Write the failing tests.** Service tests drive `step` through the private-method cast that `tests/teams.test.ts` uses, set `f.config.projects[0].team` where a test needs checks or a map, and wait for an operation with `waitFor` from `tests/helpers.ts`. `kindEvents(runId, kind)` filters `events(runId)`.

| Test name | Assertions |
|---|---|
| `a plan digest covers every planned field` (run-events) | Equal lists give one 64-character hex digest. A changed `instructions`, a changed `kind`, and a swapped task order each give another. |
| `a path list over its byte budget is omitted` (run-events) | `pathField(["a.ts"])` is `{ paths: ["a.ts"] }`. With budget 10, `["abcdef"]` (10 bytes) is kept and `["abcdefg"]` is `{ pathsOmitted: true }`. |
| `project configuration and plan tasks accept feature inputs` (task-features) | `teamProjectSchema` parses `{ checks: [cmd], features: { areas: [{ id: "host", paths: ["packages/host"] }] } }` and refuses an area id `mixed`. `teamTaskPlanSchema` accepts `kind: "fix"` and `risk: "elevated"`, and refuses `kind: "chore"` and `risk: "normal"`. |
| `the project manager may label kind and raise risk` (team-prompts) | The project-manager prompt contains `"risk":"elevated"` and `feature, fix, refactor, test, docs, or investigation`. An implementer prompt does not. |
| `a member context never carries the feature map` (team-prompts) | `teamContext` for a handoff run whose project has a map, given a configured project with the same map, serializes with no `"features"` and no `"elevatedTokens"`. `checks` is still present. |
| `an accepted plan records the plan and each task with its features` | With the map `host: ["packages/host"]`, the project manager reports task `a` (`["packages/host/src/auth/session.ts"]`, `kind: "fix"`) and task `b` (`["docs/teams.md"]`, depends on `a`). The store has one `plan.accepted` at revision 1 with `taskCount` 2, a 64-hex `planDigest`, and `parallelism` 4. It has `task.planned` for `a` and then `b`. `a` has the path, `profileId` absent, and features `{ role: "implementer", area: "host", kind: "fix", risk: "elevated", featureVersion: 1 }` with a 64-hex `featureMap`. `b` has area `docs/`, kind null, and risk `normal`. |
| `oversized owned paths leave the task event without them` | One task owns 32 paths of 296 `é` characters, a slash, and an index. Its `task.planned` has `pathsOmitted: true`, no `paths`, and features with area set. |
| `discovery records each scout with its profile` | On a run with `mixedLineup`, an explore report with scouts `s1` (`spark-high`) and `s2` (`astra-xhigh`) stores one `discovery.accepted` whose `scouts` are `s1` then `s2`, each with features `{ role: "scout", area: "none", kind: "investigation", risk: "normal" }`. |
| `a refused plan records no plan` | A plan whose task depends on itself blocks the run. The store has no `plan.accepted` and no `task.planned`. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement**, and add the paragraph to `docs/teams.md`.
- [ ] **Step 4: Run** `node --import tsx --test tests/run-events.test.ts tests/task-features.test.ts tests/team-prompts.test.ts tests/team-events.test.ts`, then `npm run typecheck -w @infinite/host`.

### Task 2: member starts and reports, with replacement links

**Interfaces (consumes):** task 1.

**Interfaces (produces):**

```ts
// packages/host/src/run-events.ts
export type ReplacementCause = "stall" | "limit" | "escalation" | "answer";
export interface ProfileIdentity { profileId?: string; provider: string; model?: string; effort?: string }
/** Umbrella C7's profile identity. `effort` is the profile's effort, or its variant for OpenCode. */
export function profileIdentity(profile: TeamModelProfile | undefined, provider: Provider): ProfileIdentity;

// packages/host/src/teams.ts
type Stored = { /* existing fields */
  /** The member each queued replacement continues, until it starts. Written only with `options.events`. */
  ledgerReplaces?: Record<string, { memberId: string; cause: ReplacementCause }>;
};
/** Records that `next` continues `previous`. A no-op without `options.events`. */
private linkReplacement(stored: Stored, next: TeamMember, previous: TeamMember, cause: ReplacementCause): void;
/** Was `(run, member, exited, singlePage)`. */
private readMemberJournal(stored: Stored, member: TeamMember, exited?: boolean, singlePage?: boolean): { page: ReturnType<Manager["events"]>; limit: LimitSwitch | undefined };
```

**Decisions:**

- **Gap: the replaced member.** Spec part 1 puts "replaced member and cause" on `member.started`, and the run record keeps no such link. The fact is known where a replacement is created, and `launch` runs later. The smallest change is `Stored.ledgerReplaces`, written by `linkReplacement` and read by `member.started`. *(My call: a `Stored` field, not the draft's `TeamMember.replaces`, so a service without events and every `TeamView` stay as they are. Deriving the link from a shared working copy cannot tell a non-implementer's limit switch, which leaves only a text reason.)*
- `linkReplacement` is called after `run.members.push(next)` in four places, each followed by a save: the completion callback of `replaceStalledMember` (`stall`), the completion callback of `switchLimitedMember` (`limit`), the completion callback of the `escalate` branch of `consume` (`escalation`), and the answered-decision loop of `step`, before its `this.save(stored)` (`answer`).
- **`member.started`.** In `launch`, after `member.startedAt ??= timestamp()` and the turn update, before the last `this.save(stored)`. Ids `{ memberId, taskId: member.taskId, revision: member.revision }`. Data: `role`; `purpose: "work"`, the constant `run.created` uses; `sessionId`; `startedAt: member.startedAt`; `baseCommit: member.baseCommit`; `...profileIdentity(member.modelProfile, member.provider ?? run.provider)`; `unavailable: true` only when the launch returned `unavailable`; `replaces: stored.ledgerReplaces?.[member.memberId]`. Then the entry is deleted, and the map is deleted when it is empty. *(My call: the spec does not list `sessionId`. Spec part 3 refreshes cost "for one of the attempt's sessions", and only this event ties a session to an attempt.)*
- **Permission coordinators emit no member kind.** *(My call: spec part 6 leaves the permission coordinator out because it "has its own decision records". It is also the only member that gets a new session per turn, so a member-id key would keep only its first turn.)*
- **`member.reported`.** `readMemberJournal` takes `stored`. It emits after `member.report`, `status`, `reportedAt`, `stalledAt`, and the `stoppedReason` clear are set, before `break`. Ids `{ memberId, taskId: member.taskId, revision: member.revision }`. Data: `role`, `reportKind: member.report.kind`. In `step` and `replaceStalledMember` a save follows in the same synchronous path. In the stop barrier the loop's final save persists the report and the event together, so a crash loses both, and the next read emits again.
- A barrier that reads past a consumed report can overwrite `member.report`. The ledger keeps the first kind, by key.

- [ ] **Step 1: Write the failing tests** in `tests/team-events.test.ts`.

| Test name | Assertions |
|---|---|
| `a launch records member.started once` | With `mixedLineup`, a queued implementer on `spark-high` for task `a` (cwd the fixture workspace) launches on `step`. One `member.started` has `memberId`, `taskId` `a`, and revision 1, with data `role` `implementer`, `purpose` `work`, the member's `sessionId`, `startedAt` equal to the record's, `baseCommit` the fixture base, `profileId` `spark-high`, `provider` `opencode`, `model` `meta/muse-spark-1.3-contributor`, `effort` `high`, and no `replaces`. A second `step` and a restart add none. |
| `a report records member.reported with its kind` | The fixture project manager reports a plan. One `member.reported` has its `memberId` and data `{ v: 1, role: "project-manager", reportKind: "plan" }`. |
| `an answered replacement names the member it replaces` | As `an answered implementer waits for a slot…` in `tests/teams.test.ts`: after the answer and a `step`, the sealed `ledgerReplaces[next]` is `{ memberId: waiting.memberId, cause: "answer" }`. After the launching `step`, `member.started.data.replaces` equals it, and the sealed record has no `ledgerReplaces`. |
| `a service without an outbox records no replacement link` | The same flow with `openTeam()`: no sealed record read after either `step` has `ledgerReplaces`. |
| `a permission coordinator emits no member event` | A queued permission coordinator launches and its report is read. The store has no `member.started` and no `member.reported` for it. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four test files of task 1 and the typecheck.

### Task 3: member stops

**Interfaces (consumes):** task 2.

**Interfaces (produces):**

```ts
// packages/host/src/run-events.ts
export const MEMBER_STOP_REASONS = ["stall", "limit", "no-report", "owner", "host"] as const;
export type MemberStopReason = typeof MEMBER_STOP_REASONS[number];
export type MemberStopDetail = "pause" | "cancel" | "steer" | "block" | "retired";

// packages/host/src/teams.ts
/** Emits `member.stopped` with data { role, reason, detail?, reported: Boolean(member.report) }.
 *  A no-op for a permission coordinator or without `options.events`. */
private memberStopped(stored: Stored, member: TeamMember, reason: MemberStopReason, detail?: MemberStopDetail): void;
```

**Decisions:**

- Ids for every stop: `{ memberId, taskId: member.taskId, revision: member.revision }`. The classes follow spec part 1: `owner` is a pause, cancel, or steer. `host` is a halt for a block (another member's block, an automatic recovery, a deadline, the attempt limit) and a runtime retirement.
- **`replaceStalledMember`.** After the `if (limit) { … }` branch and before the delivery check. The exit is confirmed and the drained journal holds no report and no limit. Reason `stall`. Every later path saves synchronously: `block`, `operation`, or a throw that `step` turns into `block`.
- **`switchLimitedMember`.** After `member.stoppedReason = …`, below the permission-coordinator branch. Reason `limit`. The same save argument holds.
- **`retireMember`.** In both branches, right after the line that sets `status`, `stoppedReason`, and `retirement`, before `block` or `save`. Reason `host`, detail `retired`.
- **`step`, exit branch.** After `member.status = "stopped"`, before `this.block(… "missing-agent-report" …)`. Reason `no-report`.
- **`step`, halt loop.** Each iteration over `membersToStop` captures the member's status first. A `finally` around the iteration body, because the body uses `continue`, calls `memberStopped` when the status became `stopped` in that iteration: reason `host` when `stored.halt` is `block`, else `owner`, and detail `stored.halt`. A member that reported but was never consumed (status `reported` behind an earlier task, or a report the barrier read) gets `reported: true`. A member already `stopped` is skipped, so a barrier that reads the revision on every tick adds nothing. The save after the loop persists the states and the events together.
- The answered-decision loop's `prior.status = "stopped"` emits no stop. Its question report ended the attempt.

- [ ] **Step 1: Write the failing tests** in `tests/team-events.test.ts`.

| Test name | Assertions |
|---|---|
| `a stalled member's stop names the stall` | An implementer on task `a` with `stalledAt` set and an exited session is replaced on `step`. Its `member.stopped` data is `{ v: 1, role: "implementer", reason: "stall", reported: false }`. After the replacement launches, its `member.started.data.replaces` is `{ memberId: old, cause: "stall" }`. |
| `a limit stop without a fallback names the limit` | A provider-limit signal (as `tests/teams.test.ts` appends one) on a run with no lineup. `member.stopped` has reason `limit`, and `run.blocked` has code `provider-limit`. |
| `an owner cancel stops members as owner stops` | `cancel` with one running implementer, then `step`. Its `member.stopped` has reason `owner`, detail `cancel`, and `reported: false`. |
| `a reported member that a halt stops is marked reported` | A member with status `reported`, a `result` report, and `exitConfirmedAt`, then `pause` and `step`. Its `member.stopped` has reason `owner`, detail `pause`, and `reported: true`. |
| `a sibling block stops the other members as host stops` | Running implementers on `a` and `b`. `a` reports `blocked`, and two `step` calls drain the revision. `b` has `member.stopped` with reason `host` and detail `block`. `a` has `member.reported` with `reportKind` `blocked` and no `member.stopped`. |
| `a member that exits without a report keeps its first reason` | An implementer whose session exited with an empty journal. After `step` it has `member.stopped` with reason `no-report`. After two more `step` calls that drain its revision, the store still has exactly one `member.stopped` for it. |
| `a retired reviewer's stop is a host stop` | With `retireTeamRuntime` stubbed on the fixture manager and the reviewer at the checked head, `retireMember` stores `member.stopped` with role `reviewer`, reason `host`, detail `retired`. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four test files of task 1 and the typecheck.

### Task 4: task outcomes

**Interfaces (consumes):** tasks 1 to 3. No new interface.

**Decisions:**

- **`task.integrated`.** In the completion callback of the `result` branch of `consume`, inside `if (task)`, after `task.changedPaths` is set or deleted. Integrators have no task and emit none here. Ids `{ memberId, taskId: task.id, revision: member.revision }`. Data: `commit` (absent when the result changed nothing, the spec's `empty-result`), `headCommit: head`, `baseCommit: run.baseCommit`, `memberBaseCommit: member.baseCommit`, `diff: task.diffStat` (absent when Git refused the read). Not the summary, not `changedPaths`.
- **`scout.completed`.** In the completion callback of the `findings` branch, after `scout.status = "complete"`. Ids `{ memberId, taskId: scout.id, revision: member.revision }`. No data.
- **`task.escalated`.** In the completion callback of the `escalate` branch, right after `task.escalation = …` and before `newMember`. A throwing `newMember` blocks the run and the escalation stays on the task, so the event matches the record. Ids `{ memberId, taskId: task.id, revision: member.revision }`. Data: `fromProfileId: task.escalation.fromProfileId`, `toProfileId: task.escalation.toProfileId`. Not the reason.
- **`task.limit-switched`.** In the completion callback of `switchLimitedMember`, after `run.members.push(next)`, for every role. Ids `{ memberId: member.memberId, taskId: member.taskId, revision: member.revision }`. Data: `role`, `fromProfileId: from.id`, `toProfileId: fallback.id`. Not `limit.message` or `limit.resetsAt`, which a provider reported. *(My call: every role, as the draft says. The spec names no role, and the integrator, reviewer, and delivery attempts need the fact for member results.)*

- [ ] **Step 1: Write the failing tests** in `tests/team-events.test.ts`. A member's working copy comes from `prepareMemberWorkspace` in `packages/host/src/team-workspace.ts`.

| Test name | Assertions |
|---|---|
| `an integrated result records its commit, head, and diff counts` | The implementer of task `a` (paths `["a.txt"]`) writes one line to `a.txt` and reports `result`. `task.integrated` has `taskId` `a`, its `memberId`, and revision 1, with a 40-hex `commit` equal to `task.commit`, `headCommit` equal to `run.headCommit`, `baseCommit` and `memberBaseCommit` the fixture base, and `diff` `{ added: 1, removed: 0, files: 1, docs: false, tests: false }`. |
| `an empty result records no commit` | The same with no file written: no `commit`, and `headCommit` is the fixture base. |
| `a completed scout records scout.completed` | With `mixedLineup` and scout `s1` running, a `findings` report stores `scout.completed` with `taskId` `s1`, its `memberId`, and data `{ v: 1 }`. |
| `an escalation records both profiles and links the new member` | With `mixedLineup` plus an escalation pool holding `astra-escalation`, the `spark-high` implementer of `a` escalates. `task.escalated` has data `{ v: 1, fromProfileId: "spark-high", toProfileId: "astra-escalation" }`. The new member's `member.started.data.replaces` is `{ memberId: old, cause: "escalation" }`. |
| `a limit switch records both profiles and links the new member` | With `limitLineup`, the `haiku` implementer of `a` hits a provider limit. The store has `member.stopped` with reason `limit`, and `task.limit-switched` with data `{ v: 1, role: "implementer", fromProfileId: "haiku", toProfileId: "deepseek-light" }`. The new member's `replaces` has cause `limit`. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the four test files of task 1, then `node --import tsx --test tests/teams.test.ts tests/team-delivery.test.ts tests/team-member-retire.test.ts` on the host, then the typecheck.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

## Not in this slice

- The check, review, repair, delivery, and rating kinds, and the emission-coverage test.
- `configId` and the profile epoch on `member.started`. The configuration identity slice adds them.
- `attempt_index` and `inherited`. The projection derives both from the `replaces` chain, and a predecessor that started before this slice has no `member.started`.
- Any projector, and the `team-prompts.ts` import guard of the authority rules.

---

# Slice: check, review, repair, delivery events

Spec part 1, the emission half, for the remaining core kinds: checks, reviews, correction rounds, deliveries, and owner ratings. It adds the two best-effort Git reads that spec part 1 asks for, and a coverage test that keeps the spec's event table and the emission sites in `TeamService` equal. It builds on the run events slice and on the member and task events slice (`emitWith`, `profileIdentity`, `pathField`, `memberStopped`, `MEMBER_STOP_REASONS`).

## Trust boundary, and what a review checks

`TeamService` is host code. It builds every event from its own run record, after its own validation. These fields originate from a member, a provider, or the owner:

- A review's verdict and rubric scores. The reviewer chooses them, and `teamReportSchema` bounds a score to an integer from 1 to 5. The rubric's `why` text, the summary, and the UI evidence are never stored.
- A delivery report's head commit, which `consume` requires to equal `run.headCommit`, and its merge commit, a hex id by schema. The merge commit is "Agent-reported delivery evidence" (`TeamRun.deliveryReceipt`), so the event records it as reported. The base branch scan of spec part 5 is what checks it. The pull request URL is never stored.
- The changed paths of an integrator commit. A member wrote the files, and the host's own Git reads the names back. Spec part 1 names them: "`repair.integrated` | `consume` (integrator `result`) | commit, head, changed paths".
- An owner rating's score. The note is never stored.
- Check output and repair feedback. Never stored. Exit codes and statuses are host observations.

The rule: event data holds counts, booleans, enumerated codes, host-issued ids, profile ids, timestamps the record stores, and commit and tree ids. It holds no free text, prompt, file content, or URL. It holds paths only in `repair.integrated`, as quoted above. The spec's rule for derived rows binds the projector: "A row never holds an objective, instructions, a summary, a rubric reason, a rating note, a path, or a URL." The store seals event data and deletes it with its run (umbrella C1).

The slice must survive: a Git read that fails, times out, or is refused by the command prefix; a check that a pause interrupts; a merge whose baseline capture fails after its receipt; a repeated rating request; a repair at the round limit; and a service built without `events`. Outside it: how a projector attributes rounds, freezes rows, flags a same-model review, and matches landings.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/teams.ts` (modify) | The emission sites, the `cause` parameter of `repair`, `readTree`, the integrator's changed-path read |
| `docs/superpowers/specs/2026-11-12-outcome-ledger-design.md` (modify) | Two rows in the part 1 table: `run.prepared` and `ledger.gap` |
| `tests/team-events.test.ts` (modify) | Check, review, repair, and rating tests |
| `tests/team-fixture.ts` (modify) | `openTeamService` passes `events` |
| `tests/team-delivery.test.ts` (modify) | Delivery tests; `deliveryRecord` gains an `events` option |
| `tests/run-event-coverage.test.ts` (create) | The coverage tests |
| `tests/teams.test.ts` (modify) | One full-run test on the host |

## Event kinds

| Kind | Emitted in | Key parts | `data` besides `v` | Why the key is unique and stable |
|---|---|---|---|---|
| `check.finished` | `check`, completion callback | `[revision, round, startedAt]` of the first result | `round`, `headCommit`, `passed`, `expected`, `commands` | `startedAt` is stored in `run.checks` before the completion. Check operations run one at a time (`team-operation-running`), so no two share a first start |
| `review.recorded` | `consume`, `review` | `[revision, memberId]` | `verdict`, `headCommit`, `baseCommit`, `reviewer`, `rubric?` | A reviewer member reports once |
| `review.tree` | after the `review` operation, outside it | `[revision, memberId]` | `headCommit`, `tree` | The same reviewer member. Emitted only when the tree read returns a tree |
| `repair.started` | `repair` | `[revision, round]` | `round`, `cause`, `headCommit` | `round` rises by one per repair and resets only when the revision advances |
| `repair.integrated` | `consume`, integrator `result` with `run.round > 0` | `[revision, round]` | `round`, `commit?`, `headCommit`, `baseCommit` | One integrator result per round: a replaced integrator never reported |
| `repair.paths` | after the integrator `result` operation, outside it | `[revision, round]` | `round`, `commit`, `paths` or `pathsOmitted` | The same round. Emitted only when the integrator produced a commit |
| `delivery.recorded` | `consume`: the `delivery` receipt write, `pull-request`, and a reconciled pull request | `[revision, memberId]` | `method`, `headCommit`, `mergeCommit?` | A delivery member reports once |
| `rating.recorded` | `rateTask` | `[requestId]` | `score` | A replayed request returns before any change. A new request is a new fact |

## Review Focus

1. A tree or changed-path read that fails, is refused, or stalls. Expect the review or integration to complete at the same moment as without `events`. Expect no `review.tree` for a failed tree read, and `repair.paths` with `pathsOmitted: true` for a failed path read.
2. A `changes-requested` review. Expect `review.recorded` before `repair.started`, in one revision, with round one higher than before.
3. A merge report whose baseline capture fails. Expect `delivery.recorded` stored and the run blocked.
4. A service without `events`. Expect no new key in a sealed record and no extra Git command.
5. An emit call with a computed kind, or a spec row with no site. Expect the coverage test to fail.

## Ledger-only Git reads never sit inside a run operation

*(Decided after review round 1. Where Task 1's "tree read" and Task 2's "changed-path read" below differ from this section, this section wins.)*

An operation checks the run deadline after its perform step. A read that only the ledger needs, awaited in that step, can push a valid review or an integrator result past the deadline. The ledger would then change what the run does. Catching the read's errors does not help: a slow read is enough.

- The `review` and `result` perform steps run exactly the commands they run without `events`. Neither starts or awaits a read that only the ledger needs.
- `review.recorded` has no `tree`. `repair.integrated` has no `paths` and no `pathsOmitted`.
- The two optional facts are enrichment events. Each is read after its operation is complete and saved, outside any pending operation and outside every deadline check:
  - `review.tree`: key parts `[revision, memberId]`, ids `{ memberId, revision }`, data `{ headCommit, tree }`. Emitted only when `readTree` returns a tree. A failed or refused read emits nothing.
  - `repair.paths`: key parts `[revision, round]`, ids `{ memberId, revision }`, data `{ round, commit, ...pathField(paths) }`. A failed or refused read gives `{ round, commit, pathsOmitted: true }`, so a projector can tell "unknown" from "not yet read". Emitted only when the integrator produced a commit. The read is the same `git diff --name-only --no-renames -z member.baseCommit commit` as an implementer's.
- One private method starts an enrichment: `private enrich(stored: Stored, read: (signal: AbortSignal) => Promise<(() => void) | undefined>): void`. It returns at once. It does nothing without `events`. The read has a 30 second limit and never throws into the caller. The read returns the emit as a closure, or nothing when it has no fact. `enrich` runs that closure only when the service is open and the record is still the live one (`this.records.get(stored.run.id) === stored`). After it emits, it calls `flushOutbox(stored)`, so the event reaches the store without another save, and the next save seals whatever still waits. A crash before that loses only the enrichment, and the fact then reads as unknown.
- An enrichment's identity is fixed at completion. The key parts and the data (revision, member, round, commits) are captured before the read starts, because the run may have moved on when the read ends: a later repair round must not take an earlier round's paths. *(Found in review round 2.)*
- A service without `events` runs no extra Git command at all.

Tests (in `tests/team-events.test.ts`; they replace the tree and path assertions of the Task 1 and Task 2 tables):

| Test name | Assertions |
|---|---|
| `the reviewed tree arrives as its own event` | After an approved review, `review.recorded` has no `tree`. A `review.tree` event follows, with `headCommit` the reviewed head and `tree` equal to `git rev-parse <head>^{tree}`. |
| `a refused tree read stores no tree event` | With a command prefix that exits 1 for an argument ending in `^{tree}`: `review.recorded` is stored, `run.review.verdict` is `approved`, and after 500 ms the store has no `review.tree`. |
| `a stalled tree read does not delay the review` | With a command prefix that sleeps 3 seconds for an argument ending in `^{tree}`: the review is applied and the run has no pending operation while the read still runs (assert before the 3 seconds pass), and `review.tree` arrives afterwards. |
| `the repair's changed paths arrive as their own event` | With `run.round` 1, an integrator writes `fix.txt` and reports `result`. `repair.integrated` has `round` 1, a 40-hex `commit`, `headCommit`, and `baseCommit`, and no path field. A `repair.paths` event follows with `paths` `["fix.txt"]`. |
| `a refused changed-path read marks the paths omitted` | With a command prefix that exits 1 for `diff --name-only`: the integration succeeds as without the ledger, and `repair.paths` has `pathsOmitted: true` and no `paths`. |
| `a path read that ends after the next round starts keeps its own round` | The integrator's name-only diff is delayed by 1.2 seconds. After the integration completes, `run.round` becomes 2. The `repair.paths` event that follows has `round` 1, a key that names round 1, the integrator's commit, and `paths` `["fix.txt"]`. |
| `a service without the ledger runs no ledger read` | Without `events`, a review and an integrator result run through a command prefix that logs each command. The log has no argument ending in `^{tree}` and no `diff --name-only` for the integrator's commit, and the sealed record has no `outbox`, `ledgerStatus`, or `ledgerReplaces` key. |

The spec's part 1 table gains the rows `review.tree` and `repair.paths`, and its `review.recorded` and `repair.integrated` rows lose the tree and the changed paths. The coverage test then covers both new kinds.

### Task 1: check and review events

**Interfaces (consumes):** `emitWith`, `profileIdentity` from the member and task events slice.

**Interfaces (produces):**

```ts
// packages/host/src/teams.ts
/** Best-effort `git rev-parse --verify <commit>^{tree}` in `run.workspace` through `teamCommand` and `teamGitArgs`,
 *  30 s. A 40- or 64-hex stdout, else undefined. Never throws. */
private async readTree(run: TeamRun, commit: string, signal: AbortSignal): Promise<string | undefined>;
```

**Decisions:**

- **`check.finished`.** The first statement of the completion callback of `check`, before the guard that returns for a changed revision, a halt, or a pause. Skipped when `results` is empty. Ids `{ revision }`, the revision `check` captured. Data: `round: results[0].round`; `headCommit: head`; `expected: commands.length`; `passed`, true when every expected command ran and passed; `commands: results.map(r => ({ phase: r.phase ?? "verification", status: r.status, exitCode: r.exitCode ?? null }))`. Not the command, its arguments, or its output. The guard may then return: the checks ran, and `run.checks` keeps them. The operation saves after the callback. *(My call: a check operation that fails, for example when a check changed files, never reaches its completion and emits nothing. `run.blocked` carries its code, and `runSummaryCounts` counts its check records.)*
- **`review.recorded`.** In the completion callback of the `review` branch of `consume`, after `run.review` is set and after the rubric loop, before the verdict branch. So it precedes the `repair.started` of a `changes-requested` verdict. Ids `{ memberId, revision: member.revision }`. Data: `verdict`; `headCommit: member.baseCommit`, the verified head; `baseCommit: run.baseCommit`; `tree` from the perform step, absent when the read failed; `reviewer: profileIdentity(reviewer, member.provider ?? run.provider)`, where `reviewer` is the `member.modelProfile ?? this.memberProfile(run, "reviewer")` that the rubric loop uses; `rubric`, one `{ taskId, correctness, cleanliness, extensibility, docs }` of scores per entry the loop stored in `task.rubric`, absent when none was stored. The projector sets `same-model-review` by comparing `reviewer.model` with the attempt's `member.started` model.
- **The tree read.** The `review` branch's perform step becomes: `assertMemberReadOnly` as today, then `{ tree: this.options?.events ? await this.readTree(run, member.baseCommit, signal) : undefined }`. *(My call: the read runs only with `events`, so a service without the ledger runs exactly the commands it ran before, and command-prefix receipts in existing tests do not change.)*

- [ ] **Step 1: Write the failing tests** in `tests/team-events.test.ts`. A check test sets `f.config.projects[0].team.checks`, and its run has one integrated task, no active member, `headCommit` equal to the base, and no `checkHead`.

| Test name | Assertions |
|---|---|
| `a passing check records each command result` | Checks `[node -e ""]`. One `check.finished` at revision 1 with data `{ v: 1, round: 0, headCommit: base, passed: true, expected: 1, commands: [{ phase: "verification", status: "passed", exitCode: 0 }] }`. |
| `a failing check records its exit code` | Checks `[node -e "process.exit(3)"]`. `passed` is false and `commands` is `[{ phase: "verification", status: "failed", exitCode: 3 }]`. |
| `a check that a pause interrupts is still recorded` | A check that waits 30 s, and `pause` while it runs. `check.finished` has `passed: false` and one command with status `interrupted`. The run is `paused`. |
| `an approved review records its verdict, tree, and kept scores` | With `mixedLineup`, tasks `a` and `b` integrated. `a`'s implementer has model `claude-opus-5-5`, the reviewer's model, and `b`'s has `gpt-6-astra`. The reviewer at the checked head approves with rubric entries for both. `review.recorded` has `verdict` `approved`, `headCommit` and `baseCommit` the base, `tree` equal to `git rev-parse <base>^{tree}`, `reviewer` `{ profileId: "opus-reviewer", provider: "claude", model: "claude-opus-5-5", effort: "xhigh" }`, and `rubric` `[{ taskId: "b", correctness: 4, cleanliness: 3, extensibility: 5, docs: 2 }]`. The stored data contains none of the `why` strings. |
| `a refused tree read leaves the tree out` | `config.teams.commandPrefix` is a script, built like `resultFailurePrefix` in `tests/team-fixture.ts`, that exits 1 when an argument ends in `^{tree}` and runs every other command. `review.recorded` has no `tree`, and `run.review.verdict` is `approved`. |
| `a changes-requested review records its verdict` | `review.recorded` has `verdict` `changes-requested` and no `rubric`. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/run-events.test.ts tests/team-events.test.ts`, then `npm run typecheck -w @infinite/host`.

### Task 2: repair, delivery, and rating events

**Interfaces (consumes):** task 1, and `pathField` from the member and task events slice.

**Interfaces (produces):**

```ts
// packages/host/src/teams.ts
/** Was `(stored, feedback)`. */
private repair(stored: Stored, feedback: string, cause: "check" | "review" | "delivery"): void;

// tests/team-fixture.ts
openTeamService(serviceOptions?: { /* existing fields */ events?: EventOutbox }): Promise<TeamService>;
```

**Decisions:**

- **`repair` causes.** The completion of `check` passes `check`, the completion of the `review` branch passes `review`, and the completion of `delivery-repair` passes `delivery`.
- **`repair.started`.** In `repair`, after `round++` and the two resets, before `prepareMember`. The two early returns (a halt or a pause, and the round limit) emit nothing. Data: `round` (the new value), `cause`, `headCommit: run.headCommit`. The `operation` that `prepareMember` starts saves it. When `newMember` throws, the caller's completion blocks the run and saves it, and the round has no answer. Spec part 4 then counts one unknown round.
- **`repair.integrated`.** In the completion callback of the `result` branch, after the `if (task)` block, when `member.role === "integrator"` and `run.round > 0`. Ids `{ memberId, revision: member.revision }`. Data: `round: run.round`; `commit`, absent when the integrator changed nothing; `headCommit: head`; `baseCommit: run.baseCommit`; and the paths. With no commit they are `{ paths: [] }`. With a read that succeeded and was not truncated they are `pathField(changedPaths.paths)`. Otherwise they are `{ pathsOmitted: true }`, because a truncated list can hide an owned path. *(My call: an integrator at round 0 carries a moved base, not a correction. It emits nothing here, and member results still see it through `member.started` and `member.reported`.)*
- **The changed-path read.** In the `result` branch's perform step, the existing `taskPaths` read runs when `task` is set, as today, or when `member.role === "integrator"` and `this.options?.events` is set. It is the same `git diff --name-only --no-renames -z member.baseCommit commit` read. The completion still stores `changedPaths` on an implementer's task only.
- **`delivery.recorded`.** Ids `{ memberId, revision: member.revision }` at three places. A merge: inside the `enqueue` in the perform step of the delivery branch, after `run.deliveryReceipt = …` and before its `this.save(stored)`, with data `{ method: "merge", headCommit: report.headCommit, mergeCommit: report.mergeCommit }`. The receipt is then recorded even when `captureDeliveryBaseline` fails afterwards and the run blocks. A pull request: in the completion callback, after `run.pullRequest = …`, with `{ method: "pull-request", headCommit: report.headCommit }`. A reconciled pull request: in the completion callback of `delivery-reconciliation`, in its `pull-request` disposition branch for `pr` mode, after `run.pullRequest = …`, with the same data. A delivery repair records `repair.started` instead.
- **`rating.recorded`.** In `rateTask`, after `task.ownerRating` and `stored.ratings[requestId]` are set, before `this.save(stored)`. A replayed request returns earlier and emits nothing. Ids `{ taskId, memberId: task.memberId, revision: task.revision }`. Data: `score`. *(My call: the key is the owner's request id, which `rateTask` already uses for idempotency. A second rating of one task is then a second fact, and the projector keeps the latest by `at`.)*
- `deliveryRecord` in `tests/team-delivery.test.ts` gains an `events` option and passes it to `openTeamService`. A test builds the store from `evidenceDatabasePath(f.host.config.stateDir)` and the fixture key file.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `a failing check starts a repair caused by the check` (team-events) | After the failing check of task 1, `repair.started` at revision 1 has data `{ v: 1, round: 1, cause: "check", headCommit: base }`, and its `seq` is above the `check.finished` `seq`. |
| `a changes-requested review comes before its repair` (team-events) | `review.recorded` then `repair.started`, with `cause` `review` and `round` 1. |
| `a repair past its limit starts no round` (team-events) | With `run.round` 2, a failing check blocks the run with `repair-limit`. The store has no `repair.started`. |
| `an integrator result answers its round with its changed paths` (team-events) | With `run.round` 1, an integrator in a `prepareMemberWorkspace` copy writes `fix.txt` and reports `result`. `repair.integrated` has its `memberId`, revision 1, and data `round` 1, a 40-hex `commit`, `headCommit` equal to `run.headCommit`, `baseCommit` the base, and `paths` `["fix.txt"]`. The store has no `task.integrated`. |
| `a round-zero integrator records no repair` (team-events) | The same with `run.round` 0: no `repair.integrated`. |
| `a rating records the score once per request` (team-events) | `rateTask(id, "a", { requestId: R, score: 4, note: "Useful" })` twice gives one `rating.recorded` with `taskId` `a`, the task's `memberId`, and data `{ v: 1, score: 4 }`. No stored event contains `Useful`. A second request with score 2 gives a second event. |
| `a pull-request report records the delivery without its URL` (team-delivery) | `deliveryRecord("pr", …)` and a `pull-request` report for `https://github.com/example/app/pull/7`. `delivery.recorded` has its `memberId`, revision 1, and data `{ v: 1, method: "pull-request", headCommit }`. No stored event contains `github.com`. |
| `a merge receipt is recorded even when the baseline capture fails` (team-delivery) | `deliveryRecord("merge", …)` and a `delivery` report whose `mergeCommit` is 40 `a` characters, absent from the repository. The run blocks. `delivery.recorded` has `method` `merge`, `headCommit`, and that `mergeCommit`. |
| `a reconciled pull request records the delivery` (team-delivery) | A `delivery-reconciliation` report with disposition `pull-request` in `pr` mode stores `delivery.recorded` with `method` `pull-request`. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/run-events.test.ts tests/team-events.test.ts`, then `tests/team-delivery.test.ts` on the host, then the typecheck.

### Task 3: the emission-coverage test

**Interfaces (consumes):** the spec file, `packages/host/src/teams.ts` as text, `teamReportSchema`, `MEMBER_STOP_REASONS`, `schedulerFixture()`. No production interface.

**Decisions:**

- **Spec amendment.** The part 1 table gains `run.prepared` (the prepare completion in `createRun`; base commit) and `ledger.gap` (`flushOutbox`, after a stored flush; dropped count). The run events slice emits both, and the table lacks them. The table then lists 23 kinds.
- **Kinds.** The test takes the backticked kind in the first cell of each table row between `### Part 1.` and `### Part 2.` of the spec. It finds every `this.emit(` and `this.emitWith(` call in `teams.ts` and takes the second argument. Every call names its kind as a string literal. The one exception is the forwarding call inside `emitWith`, which the test allows by its exact text `this.emit(stored, kind,`. *(My call: a literal kind at every site is what makes a static check possible. A computed kind would hide a site.)*
- **Report kinds.** A test sample exists for each kind of `teamReportSchema.options`, and each sample parses. A kind without a sample fails the test, so a new report kind needs a decision.
- **Stop reasons.** `MEMBER_STOP_REASONS` must equal the backticked classes after "are" in the spec sentence that begins `The reason classes of \`member.stopped\``. Each reason must appear as a string literal in the arguments of some `this.memberStopped(` call.
- **The full run.** One host test checks the happy path of spec acceptance 1, without the stall, through `server.ts`, which the run events slice wires to the outbox.

- [ ] **Step 1: Write the tests**, and amend the spec table.

| Test name | Assertions |
|---|---|
| `every spec event kind has an emission site, and every emitted kind is in the spec` (run-event-coverage) | The spec set and the source set are equal and hold 25 kinds (with `review.tree` and `repair.paths`), `run.prepared` and `ledger.gap` among them. Exactly one call has a non-literal kind, and its text is `this.emit(stored, kind,`. |
| `every report kind reaches member.reported` (run-event-coverage) | The sample keys equal the 14 kinds of `teamReportSchema.options` (each option's `shape.kind.value`). For each kind, a fresh `schedulerFixture()` with an outbox, the fixture project manager's report of that sample, and one `step` give one `member.reported` whose `data.reportKind` is that kind. `readMemberJournal` accepts any valid report and `roleAcceptsReport` runs later in `consume`, so a kind the project manager may not send is still reported, and the run may then block. |
| `every member.stopped reason has an emission site` (run-event-coverage) | The spec sentence gives `["stall", "limit", "no-report", "owner", "host"]`, equal to `MEMBER_STOP_REASONS`. Each appears as a literal in a `this.memberStopped(` call. |
| `a full run stores its events in order` (teams, host) | `fixture()` settles at `ready-for-review`. After `f.host.stopApi()`, the store holds one each of `run.created`, `run.prepared`, `plan.accepted`, `check.finished` (`passed: true`), `review.recorded` (`approved`), and `run.settled` (`ready-for-review`); two `task.planned` and two `task.integrated`; and one `member.started` and one `member.reported` per member of the run. It holds no `member.stopped`, `repair.started`, or `ledger.gap`. By `seq`, `run.created` < `run.prepared` < `plan.accepted` < each `task.planned` < each `task.integrated` < `check.finished` < `review.recorded` < `run.settled`, and each member's `member.started` precedes its `member.reported`. |

- [ ] **Step 2: Run the tests.** The first three must pass against the two event slices. Break each once on purpose (rename one emitted kind, remove one sample, change one stop reason) and confirm the matching test fails, then restore it.
- [ ] **Step 3: Run** `node --import tsx --test tests/run-event-coverage.test.ts tests/team-events.test.ts`, then `tests/teams.test.ts` and `tests/team-delivery.test.ts` on the host, then the typecheck.
- [ ] **Step 4: The coordinator runs `npm run check`, requests the independent review, and commits.**

## Not in this slice

- Any projector: round attribution, the freeze, the `same-model-review` flag, run summaries.
- `check.finished` for a check operation that fails before its completion.
- The base branch scan, landing, revert, and the hold window.
- `configId` and the profile epoch.
- The test that `team-prompts.ts` does not import the ledger. It arrives with the ledger module in the projection slice.

---

# Slice: configuration identity

Spec part 3, "Configurations and profile epochs", under umbrella C7. After a member's session starts, `TeamService` computes the member's `configId` and emits it as an enrichment event, `member.configured`. A new evidence module keeps one row per `configId` with its six components, and the profile epochs with the time each one began. The owner can advance an epoch.

The projection slice reads both: it puts `config_id` and `profile_epoch` on outcome rows. This slice writes no outcome row.

## Trust boundary, and what a review checks

`config-identity.ts`, `configuration-store.ts`, the projector, the enrichment in `launch`, and the owner route are host code. Every event is built by the host from its own run record and its own configuration. These values have an outside origin:

- The profile identity: provider, model, and effort or variant. The owner configures it, and `teamModelProfileSchema` checks the model pattern. Umbrella C1 counts it as an enumeration.
- The guidance digest. Repository authors and members write `AGENTS.md` and `CLAUDE.md`. The host's own Git lists the object ids of those files in the member's base commit. Only a SHA-256 over the paths and object ids leaves the read. No path, file content, or object id is stored.
- The rendered prompt. `teamPrompt` renders fixed fixture runs, never the live run. Only its digest is kept.
- The owner's epoch request: a profile id and a request id.

The rule for derived rows is spec part 3: "Plaintext columns hold opaque identifiers, enumerations, numbers, and times. Names from the repository or the run stay in the encrypted payload." Neither table of this slice has a run id, a member id, a task id, a path, or text. Both tables are durable, and nothing in them belongs to a run.

The slice must survive:

- A guidance read that fails, stalls, is refused by the command prefix, or truncates its output. The member starts at the same moment as without `events`, no `member.configured` is emitted, and the configuration reads as unknown.
- A prompt fixture that `teamPrompt` refuses. No event, and the configuration reads as unknown.
- `member.configured` that arrives after `member.reported`, `member.stopped`, or `run.settled`, or never. It is a fact about the start, so it is never refused for being late.
- A store that is unavailable. The event waits in the outbox like any other.
- The configurations projector behind or blocked. Its rows arrive later. No run decision reads them.
- A run deleted before its `member.configured` was projected. The event is lost and counted in `event-outbox.lost`. The outcome row then keeps `config_id` null.
- An epoch advanced while a projector is behind. A reader takes the epoch in effect at the member's start time, never the current one.
- A repeated owner request. One epoch, by request id.
- A service built without `events`. No Git read and no new key in a sealed record.

Outside this slice: the per-project guidance pattern list, a knowledge snapshot other than `none`, a routing policy other than `off`, the `trial` shape, `configId` on the usage session header, and outcome rows.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/config-identity.ts` (create) | Pure rules: the profile identity key, `configId`, the prompt version and its fixture runs, the guidance tree parser and digest, and `memberConfiguration`, which runs the read |
| `packages/host/src/configuration-store.ts` (create) | The `configurations` evidence module, its projector, `epochAt`, and `advanceEpoch` |
| `packages/host/src/teams.ts` (modify) | `launch`: start the `member.configured` enrichment after `member.started` |
| `packages/host/src/server.ts` (modify) | Register the module and the projector; `POST /api/outcomes/epochs` |
| `packages/host/src/client.ts` (modify) | `infinite usage outcomes new-epoch --profile ID [--json]` |
| `docs/superpowers/specs/2026-11-12-outcome-ledger-design.md` (modify) | Part 1 table: the `member.started` row and a new `member.configured` row. Part 3: the epoch paragraph |
| `tests/config-identity.test.ts` (create) | Rule and read tests |
| `tests/configuration-store.test.ts` (create) | Module, projector, and epoch tests |
| `tests/team-events.test.ts`, `tests/run-event-coverage.test.ts` (modify) | The enrichment, and 26 kinds |
| `tests/outcome-routes.test.ts` (create) | The epoch route, as `tests/usage-routes.test.ts` builds its host |

## Event kinds

| Kind | Emitted in | Key parts | `data` besides `v` | Why the key is unique and stable |
|---|---|---|---|---|
| `member.configured` | `launch`, a read after the session starts | `[memberId]` | `configId`, `provider`, `model?`, `effort?`, `promptVersion`, `guidance`, `knowledge`, `routing`, `shape` | A host-issued member id. The first configured event wins, as for `member.started` |

## Review Focus

1. A guidance read that sleeps 3 seconds. Expect `member.started` and the running status before the 3 seconds pass, and `member.configured` after.
2. Two members of one run on one base commit with one profile. Expect one `configId` and one configurations row.
3. An epoch advanced at time T. Expect `epochAt` to give the old epoch for a time before T and the new one from T on.
4. One owner request sent twice. Expect one new epoch.
5. A service without `events`. Expect no `diff-tree` in a logging command prefix.

### Task 1: the identity rules and the guidance read

**Files:** `packages/host/src/config-identity.ts` (create), `tests/config-identity.test.ts` (create).

**Interfaces (consumes):** `teamPrompt` (`team-prompts.ts`), `teamCommand` and `teamGitArgs` (`team-workspace.ts`), `canonicalJson` (`evidence/crypto.ts`), `TeamMember`, `TeamModelProfile`, `TeamCommand`, `Provider`, `profileIdentity` (`run-events.ts`).

**Interfaces (produces):**

```ts
export const GUIDANCE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
export type ProfileKey = { provider: string; model: string | null; effort: string | null };
export interface ConfigComponents {
  profile: ProfileKey;
  promptVersion: string;          // 64 hex
  guidance: string;               // 64 hex
  knowledge: "none";
  routing: "off";
  shape: "team" | "trial";
}
/** SHA-256 hex of the canonical JSON of the key. The profile id and label are not part of it. */
export function profileIdentityKey(profile: ProfileKey): string;
/** SHA-256 hex of the canonical JSON of exactly the six components (umbrella C7). */
export function configId(components: ConfigComponents): string;
/** The fixture renders of `teamPrompt`, with the host's report command replaced by a placeholder. Throws when teamPrompt throws. */
export function renderedPrompts(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean): string[];
/** Digest of `renderedPrompts`. Cached per exact input. Throws when teamPrompt throws. */
export function promptVersion(role: TeamMember["role"], provider: Provider, profile: TeamModelProfile | undefined, publishHeads: boolean): string;
/** The guidance entries of `git diff-tree -r --raw --no-abbrev` output against the empty tree, sorted by path. */
export function parseGuidanceTree(stdout: string): { path: string; object: string }[];
export function guidanceDigest(entries: readonly { path: string; object: string }[]): string;
/** Best effort. Undefined on any failure. Never throws. Successes are cached per workspace and commit. */
export function readGuidanceDigest(workspace: string, commit: string, prefix: TeamCommand | undefined, signal: AbortSignal): Promise<string | undefined>;
export type MemberConfiguration = ConfigComponents["profile"] & Omit<ConfigComponents, "profile"> & { configId: string };
/** The data of `member.configured`, or undefined when any component is unknown. Never throws. */
export function memberConfiguration(input: {
  workspace: string; baseCommit: string; role: TeamMember["role"]; provider: Provider;
  profile?: TeamModelProfile; publishHeads: boolean; prefix?: TeamCommand;
}, signal: AbortSignal): Promise<MemberConfiguration | undefined>;
```

**Decisions:**

- **Profile key.** `{ provider, model: model ?? null, effort: effort ?? null }`, from `profileIdentity`. `effort` is the effort, or the variant for OpenCode. A member with no profile has `model` and `effort` null.
- **Prompt version.** The module holds two frozen fixture runs: a single-provider run with one implementer task, and a run with a goal, a lineup, and one scout. Values are neutral placeholders: project id `example`, workspace `/home/dev/projects/infinite`, fixed UUIDs, and fixed times. For each fixture, `teamPrompt(run, role, taskOrScoutFor(role), undefined, provider, profile, { checks: [FIXTURE_CHECK] }, [], publishHeads)`. The version is the SHA-256 hex of the canonical JSON of the rendered strings, in fixture order. *(My call: it renders with the member's own profile object, so a profile-specific branch of `teamPrompt` is covered. Any wording change then changes the version, which is the point of C7 component 2.)*
- **The render is normalised before it is hashed.** For a provider without a report tool, the prompt holds the report command, which is the Node path and the absolute path of the host's own reporter file. `renderedPrompts` replaces that command (`reportCommand()`, now exported from `team-prompts.ts`) with `<report-command>`. *(Local review before the first independent round: without this, every release directory gave every OpenCode member a new prompt version and a new `configId`, with no change in wording.)*
- The cache is a module `Map` keyed by the exact render input: `JSON.stringify([role, provider, profile ?? null, publishHeads])`. *(Local review: the prompt prints the whole profile object, with its label, tier, data-use setting, and fallback. A key with only the identity and the id let two profiles that differ in a label share one entry, so a member's version depended on which one launched first.)* A profile field that the prompt prints is part of the version, so a changed label is a new prompt version. The rendering is pure CPU work, and it runs inside the enrichment, never in `launch`.
- **Guidance read.** One bounded command in `workspace`, through `teamCommand` and `teamGitArgs`: `git -c core.quotePath=true diff-tree -r --raw --no-abbrev --no-renames <empty tree> <commit> -- ':(glob)**/AGENTS.md' ':(glob)**/CLAUDE.md'` (one glob per `GUIDANCE_FILES` name). It compares the commit with the empty tree, so every matching file of the commit is listed as added with its object id, and only the matching files are printed. *(Decided during the build: a whole-tree `git ls-tree -r` is cut at the command's 64 KiB output cap for a repository of about 700 files, and a cut listing reads as unknown, so most real repositories would have no identity. `git ls-tree` takes no glob.)* The empty tree id is `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, or `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321` when the commit id has 64 characters. The output is one line per file: `:000000 <mode> <zero id> <object id> A`, a tab, then the path. With `core.quotePath` on and no `-z`, Git writes a path that holds a non-ASCII byte, a quote, a backslash, or a control character in its quoted form, so the output is ASCII. *(Local review: `teamCommand` decodes each output chunk on its own, so a multi-byte character split across two chunks would change the path text, and the digest, with read timing.)* `parseGuidanceTree` keeps a line whose status is `A`, whose mode is a file or a symbolic link (`100644`, `100755`, `120000`), and whose last path segment equals a `GUIDANCE_FILES` name, case-sensitively. The digest covers the path as Git printed it. No matching file gives the digest of an empty list. An empty guidance file and a symbolic link each count, by object id. The result is undefined when the command exits non-zero, is interrupted, or is truncated.
- The guidance cache holds at most 64 successes and evicts the oldest. A commit's tree never changes, so a cached digest is always valid.
- **A stalled read stays bounded.** *(Review round 1: under a launcher such as `sudo`, the host may not signal the command's process group, so a stalled read cannot be stopped, and a read that waits for its child would wait for good. Launch after launch would then leave a process and a pending enrichment behind.)* Three rules:
  1. One read per workspace and commit runs at a time. Later callers for the same pair share its result, so five members on one base commit start one Git process.
  2. At most `GUIDANCE_READS_LIMIT` (4) reads run at once in the host. A caller that finds no free place waits for one, until its own deadline. A read frees its place only when its child has ended, so four stalled reads leave four processes and later members go without a configuration.
  3. A caller's wait ends when its signal aborts, whether or not the child ended. The read itself runs under its own 30-second limit and never under a caller's signal, because several callers share it.
  4. A caller that gives up leaves the read's waiter set, and a caller that waits for a place leaves that set too. *(Local review of the repair: a `Promise.race` on the shared read left one reaction on a stalled read for every caller that gave up.)* So a read that never ends holds no memory for callers that left.
- **`enrich` holds a bounded number in flight.** At most `ENRICH_LIMIT` (16) enrichments are pending in one service. One more is skipped, its event is absent, and the host says so once per process. A read that never ends keeps its place, so a stall leaves at most 16 pending reads, for every enrichment kind (`review.tree`, `repair.paths`, and `member.configured`).
- **`memberConfiguration`** reads the guidance, computes the prompt version, and returns `{ ...profile, promptVersion, guidance, knowledge: "none", routing: "off", shape: "team", configId }`. Any throw or an undefined digest gives undefined.

- [ ] **Step 1: Write the failing tests** in `tests/config-identity.test.ts`.

| Test name | Assertions |
|---|---|
| `a configId covers all six components` | Fixed components give a 64-hex id, equal across two calls and across two key orders of the input. A changed `profile.model`, `profile.effort`, `promptVersion`, `guidance`, `routing` cast to `"x"`, or `shape: "trial"` each gives another id. |
| `a profile key leaves out the id and the label` | `profileIdentityKey({ provider: "claude", model: "m", effort: "high" })` is one 64-hex key. `effort: null` gives another. Two profiles with ids `a` and `b` and one identity give one key. |
| `the prompt version is stable per role and provider` | Two calls with equal arguments are equal and 64 hex. `implementer` and `reviewer` differ. `claude` and `codex` differ. |
| `the guidance parser keeps guidance entries only` | Lines (`:000000 <mode> <zero id> <object id> A`, a tab, the path) for `AGENTS.md` (`100644`, O1), `packages/host/CLAUDE.md` (`100755`, O2), `docs/agents.md` (`100644`, O3), `vendor/AGENTS.md` (`160000`, O4), `src/MY-AGENTS.md` (`100644`, O5), `a/CLAUDE.md` (`120000`, O6), and the quoted path `"d\303\251/AGENTS.md"` (`100644`, O8) give exactly the quoted path, `AGENTS.md`, `a/CLAUDE.md`, and `packages/host/CLAUDE.md`, sorted by path. A line with status `M` is left out. |
| `a path with a non-ASCII character reads the same every time` | A commit with `dé/AGENTS.md`: the digest equals `guidanceDigest` of the quoted path `"d\303\251/AGENTS.md"` with its id from `git rev-parse`, and the command's output holds only ASCII bytes. |
| `the report command is not part of the prompt version` | For provider `opencode`, no string of `renderedPrompts` holds `process.execPath`, and each holds `<report-command>`. |
| `the prompt version follows every profile field the prompt prints` | Two implementer profiles with one id and one identity and different labels give different versions, whichever is asked first. Two equal profile objects give one version. |
| `a large repository still has a guidance digest` | A temporary repository with 1,500 committed files whose `git ls-tree -r` listing is over 65,536 bytes, plus `AGENTS.md`: the digest is defined and equals `guidanceDigest` of the one path with its id from `git rev-parse`. |
| `no guidance file gives the empty-list digest` | A commit with no guidance file gives `guidanceDigest([])`. |
| `an empty file and a symbolic link count` | A commit with an empty `AGENTS.md` and `a/CLAUDE.md` as a symbolic link gives the digest of both paths with their ids from `git rev-parse`. |
| `the guidance digest is order-free and bound to content` | Two orders of one list give one digest. A changed object id gives another. The empty list gives a fixed 64-hex digest unlike any one-entry list. |
| `guidance is read from a commit` | In a temporary repository with `AGENTS.md` and `a/CLAUDE.md` committed, the digest equals `guidanceDigest` of the two paths with the ids from `git rev-parse HEAD:AGENTS.md` and `HEAD:a/CLAUDE.md`. After a commit that edits `a/CLAUDE.md`, the new commit gives another digest and the first commit still gives its own. |
| `one guidance read serves every caller of a commit` | Five concurrent calls for one workspace and commit, through a prefix that logs each command, give one digest five times and one `diff-tree` in the log. |
| `a caller with no free place waits for one` | Six calls for six commits, through a prefix that takes 300 ms per `diff-tree`, with a signal that never aborts: six digests, all different, and six `diff-tree` commands in the log. |
| `a stalled read ends at the caller's deadline and leaves a bounded number behind` | A prefix sleeps 2 seconds for `diff-tree`. Six calls for six commits, each with a signal aborted after 100 ms, all give undefined in under 1.5 seconds, and the log holds four `diff-tree` commands. After the sleeps end, a call for a seventh commit gives a digest. |
| `a failed guidance read gives nothing` | An unknown commit, a command prefix that exits 1 for `diff-tree`, and an aborted signal each resolve to undefined without throwing. `memberConfiguration` then resolves to undefined. |

- [ ] **Step 2: Run the tests and confirm they fail** with a missing module error.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/config-identity.test.ts`, then `npm run typecheck -w @infinite/host`.

### Task 2: the configurations module, its projector, and epochs

**Files:** `packages/host/src/configuration-store.ts` (create), `tests/configuration-store.test.ts` (create). It can run in parallel with Task 1: it imports only `configId` and `profileIdentityKey`, whose signatures are fixed above.

**Interfaces (consumes):** `EvidenceStore`, `EvidenceModule`, `EvidenceDb`, `EventProjector`, `EvidenceError`.

**Interfaces (produces):**

```sql
-- Every column is plain: digests are opaque, profile fields are enumerations (umbrella C1).
CREATE TABLE configurations (
  config_id      TEXT PRIMARY KEY,   -- 64 hex
  provider       TEXT NOT NULL,
  model          TEXT,
  effort         TEXT,
  prompt_version TEXT NOT NULL,      -- 64 hex
  guidance       TEXT NOT NULL,      -- 64 hex
  knowledge      TEXT NOT NULL,      -- none
  routing        TEXT NOT NULL,      -- off
  shape          TEXT NOT NULL,      -- team | trial
  first_seen_at  TEXT NOT NULL
);
CREATE TABLE profile_epochs (
  identity   TEXT NOT NULL,          -- profileIdentityKey
  epoch      INTEGER NOT NULL,       -- 2 and up. Epoch 1 has no row
  provider   TEXT NOT NULL, model TEXT, effort TEXT,
  since      TEXT NOT NULL,          -- ISO 8601, host clock
  request_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (identity, epoch)
);
```

```ts
export const CONFIGURATIONS_MODULE = "configurations";
/** Version 1. No deleteRun and no runIds: nothing in it belongs to a run. counts: { configurations, epochs }. */
export function configurationModule(): EvidenceModule;
/** Name "configurations", module "configurations", kinds ["member.configured"]. */
export function configurationProjector(): EventProjector;
/** The highest epoch whose `since` is at or before `at`, or 1. */
export function epochAt(db: EvidenceDb, identity: string, at: string): number;
/** One write. Throws EvidenceError("unavailable") when the store is not ready. */
export function advanceEpoch(store: EvidenceStore, input: { profile: ProfileKey; requestId: string; now: string }): { epoch: number; since: string; repeated: boolean };
```

**Decisions:**

- *(My call: the guidance digest is a plain column. It is a SHA-256 over object ids, as opaque as `configId`, which the spec keeps plain and which is computed from it.)*
- **The projector** parses `event.data` with a strict schema and recomputes `configId` from the components. On a parse failure or a mismatch it skips the event and logs one fixed line per process. *(My call: it does not throw, because a throw would hold every later event behind a bad one.)* Otherwise it inserts with `ON CONFLICT(config_id) DO NOTHING` and `first_seen_at = event.at`. A replayed page inserts nothing new.
- **Epochs keep their history.** *(My call, and a change to spec part 3, which keeps only the current epoch. A projector that falls behind must still give an attempt the epoch it started in, and `TeamService` must not read the store at launch.)* Epoch 1 is implicit, so a fresh store needs no rows.
- `epochAt` compares ISO strings. Every writer uses `new Date().toISOString()`, so string order equals time order.
- **`advanceEpoch`** in one write: a row with the request id and the same identity is returned with `repeated: true`. A row with the request id and another identity throws `EpochRequestConflict` (exported from this file), and the route answers 409 `request-conflict`, as every other request id in the host does. *(Decided during the build: without it, a reused request id returned another profile's epoch under the new profile's name.)* Otherwise the new epoch is the identity's highest plus one, or 2, with `since = now`. `now` must be in the exact form `toISOString` gives, because `epochAt` compares strings; any other form throws a `TypeError`. An epoch never starts before the identity's latest one: `since` is the later of `now` and that epoch's `since`, so `epochAt` never puts a later epoch ahead of an earlier one. After a clock that stepped back, the two start together and the earlier epoch is in effect for no time. `advanceEpoch` throws `EvidenceError("unavailable")` unless the store reports the `configurations` module `ready`, so a module that failed to migrate answers 503 and not a generic error. *(Both from the local review.)*

- [ ] **Step 1: Write the failing tests** in `tests/configuration-store.test.ts`. Each builds a store in a fresh temporary directory with a 32-byte key, an `EventOutbox`, the module, and the projector.

| Test name | Assertions |
|---|---|
| `a configured member records its configuration once` | A flushed `member.configured` with valid components gives one row with every component and `first_seen_at` equal to the event's `at`. A second event for another member with equal components adds no row. |
| `an event whose configId does not match is skipped` | With `configId` of 64 `0` characters: no row, `advance()` returns `pending: false`, and a later valid event is stored. |
| `the epoch in effect at a time` | With no rows, `epochAt` is 1. After `advanceEpoch` at `2026-11-01T00:00:00.000Z` and at `2026-11-10T00:00:00.000Z`: `epochAt` is 1 at `2026-10-31T23:59:59.999Z`, 2 at `2026-11-01T00:00:00.000Z` and at `2026-11-05T00:00:00.000Z`, and 3 at `2026-11-10T00:00:00.000Z`. Another identity is 1. |
| `a repeated epoch request advances once` | Two calls with one request id both return epoch 2, the second with `repeated: true`. The table has one row. |
| `a request id that belongs to another profile is refused` | After an advance for one profile, the same request id for another profile throws `EpochRequestConflict`. The table still has one row, and the other identity is in epoch 1. |
| `an epoch never starts before the one before it` | After an advance at `2026-11-10T00:00:00.000Z`, an advance with `now` `2026-11-09T00:00:00.000Z` gives epoch 3 with `since` `2026-11-10T00:00:00.000Z`. `epochAt` at that time is 3, and at `2026-11-09T12:00:00.000Z` it is 1: epoch 2 is in effect for no time. |
| `a module that is not ready is unavailable` | Over a store where the `configurations` module is not registered, `advanceEpoch` throws `EvidenceError` with code `unavailable`. |
| `a long model name is stored` | A `member.configured` event whose model has 180 characters gives one row. |
| `an epoch start time must be a canonical timestamp` | `2026-11-01`, `2026-11-01T00:00:00Z`, an offset form, and `soon` each throw a `TypeError` and store nothing. |
| `the module reports its counts` | `store.describe().counts` has `configurations.configurations` 1 and `configurations.epochs` 1. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --import tsx --test tests/configuration-store.test.ts`, then the typecheck.

### Task 3: the enrichment, the wiring, the route, and the CLI

**Files:** `packages/host/src/teams.ts`, `packages/host/src/server.ts`, `packages/host/src/client.ts`, the spec, `tests/team-events.test.ts`, `tests/run-event-coverage.test.ts`, `tests/outcome-routes.test.ts`. Needs Tasks 1 and 2.

**Decisions:**

- **`launch` in `teams.ts`.** Right after the `member.started` `emitWith`, under the same `permission-coordinator` condition, about five lines: capture `{ memberId, taskId, revision, workspace: run.workspace, baseCommit, role, provider, profile }` and `publishHeadsEnabled()`, then `this.enrich(stored, async signal => { const data = await memberConfiguration(captured, signal); return data && (() => this.emitWith(stored, "member.configured", [captured.memberId], { memberId, taskId, revision }, () => data)); })`. The identity is captured before the read, as the review and repair enrichments do. *(My call, and a change to spec part 1, which puts `configId` and the epoch on `member.started`. Guidance needs a Git read, and a ledger-only read never sits in a run path.)*
- `enrich` already does nothing without `events`, bounds the read to 30 seconds, and drops the emit when the record is no longer live.
- **Spec.** The `member.started` row's data becomes "role, purpose, session, profile identity, replaced member and cause". A new row follows it: `member.configured` | `launch`, a read after the session starts | `configId` and its six components; absent when the read fails. The part 3 paragraph says that an enrichment after launch computes `configId`, and that `profile_epochs` keeps each epoch with its start time. The coverage test expects 26 kinds.
- **`server.ts`.** After `new EventOutbox(evidence)`: `evidence.register(configurationModule())`, then `outbox.registerProjector(configurationProjector())`. A projector needs its module registered first.
- **`POST /api/outcomes/epochs`**, `requireRole(["owner"])`. The body is strict: `{ profileId, requestId }`, the profile id pattern of `teamModelProfileSchema` and a UUID. The route asks `profileKeyOf(lineupProfiles(lineup), profileId)` (exported from `config-identity.ts`), which collects the distinct profile keys of every profile with that id across the lineup (coordinator, integrator, reviewer, implementers, escalations, fallbacks, permissionReviewer). None gives 404 `profile-not-found`. More than one gives 409 `profile-ambiguous`. *(Found during the build: the lineup schema already refuses an id that names two identities, so no loaded lineup reaches the 409. It stays as a guard for that rule, and a unit test of `profileKeyOf` covers it.)* A store that is not ready gives 503 `evidence-unavailable`. A request id that already advanced another profile gives 409 `request-conflict`. Otherwise 200 with `{ profileId, provider, model, effort, epoch, since, repeated }`.
- **CLI.** `infinite usage outcomes new-epoch --profile ID [--json]` sends a new `randomUUID()` request id and prints `Profile ID (provider model effort) is in epoch N since TIME.` A 403 prints `Advancing a profile epoch requires an owner device key.`

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `a launched member records its configuration` (team-events) | With `mixedLineup`, the `spark-high` implementer of task `a` launches. A `member.configured` follows with its `memberId`, `taskId` `a`, revision 1, and data `provider` `opencode`, the profile's `model`, `effort` `high`, 64-hex `promptVersion` and `guidance`, `knowledge` `none`, `routing` `off`, `shape` `team`, and `configId` equal to `configId` of those components. `guidance` equals `readGuidanceDigest` at the fixture base. |
| `a stalled guidance read does not delay the launch` (team-events) | A command prefix that sleeps 3 seconds for `diff-tree`: `member.started` is stored and the member is `running` before the 3 seconds pass. `member.configured` arrives after. |
| `a refused guidance read records no configuration` (team-events) | A command prefix that exits 1 for `diff-tree`: `member.started` is stored, and after 500 ms there is no `member.configured`. |
| `a read that never ends leaves a bounded number in flight` (team-events) | Twenty calls of `enrich` with reads that do not settle start sixteen reads, and the skip is logged once at most. After those reads end, one more call starts its read. |
| `a service without the ledger reads no guidance` (team-events) | Without `events`, a logging command prefix shows no `diff-tree` after a launch. |
| `every spec event kind has an emission site…` (run-event-coverage) | The existing test, now with 26 kinds and `member.configured` among them. |
| `the owner advances a profile epoch` (outcome-routes, host) | Two posts with one request id return epoch 2, the second with `repeated: true`. A new request id returns 3. The first request id with another profile id returns 409 `request-conflict`. An unknown profile id returns 404. A non-owner device returns 403. |
| `a profile id names one identity, none, or an ambiguous one` (config-identity) | Two profiles with one id and one identity give that key. Two with one id and different providers give `ambiguous`. An unknown id and an empty list give undefined. |
| `a profile id names one identity across the lineup, and a shared identity is accepted` (outcome-routes, host) | The lineup schema refuses one id with two identities. One id with one identity in two slots advances to epoch 2. |
| `an unavailable store answers 503 and the status route still reports it` (outcome-routes, host) | With an unusable evidence location, the post answers 503 `evidence-unavailable`, and `GET /api/evidence/status` answers 200 with state `unavailable`. |
| `the new-epoch command prints the epoch` (outcome-routes, host) | The CLI prints `Profile light (codex gpt-6-luna high) is in epoch 2 since TIME.`, `--json` gives `epoch: 3` and `repeated: false`, an unknown profile exits non-zero with its message, and a viewer token gets the owner-key message. |
| `a profile field may be absent or null` (configuration-store) | In an empty store, an event with `model` and `effort` absent gives one row with both columns null. In another empty store, an event with both null gives the same row. Both events in one store give one row. |

- [ ] **Step 2: Run the tests and confirm they fail.**
- [ ] **Step 3: Implement**, and amend the spec.
- [ ] **Step 4: Run** `node --import tsx --test tests/config-identity.test.ts tests/configuration-store.test.ts tests/team-events.test.ts tests/run-event-coverage.test.ts`, then `tests/outcome-routes.test.ts` on the host, then the typecheck.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

## Not in this slice

- `config_id` and `profile_epoch` on outcome rows and member results. The projection slice reads `member.configured` and `epochAt`.
- The per-project guidance pattern list of C7 component 3.
- A knowledge snapshot reference other than `none`, a routing policy version other than `off`, and the `trial` shape.
- `configId` on the usage session header. The usage capture design owns the header.
- A route that lists epochs, and pruning of configuration rows that no outcome row references.

---

# Slice: projection

Spec parts 3, 4, and 6, and the backfill of delivery order 2. A projector turns stored run events into one outcome row per attempt, one run summary per run, and one member result per member that has no task. A one-time backfill writes flagged rows for runs that predate emission. A read route returns a run's rows, also after its record is gone. It builds on the configuration identity slice, which must merge first.

## Trust boundary, and what a review checks

The module, the projector, and the backfill are host code. The projector is synchronous. Every event was built by the host from its own run record. These values in events originate from members: report kinds (enumerated), task and scout ids (the project manager chose them), owned paths in `task.planned`, changed paths in `repair.paths`, profile ids (checked against the lineup), a review's verdict and rubric scores (bounded integers), and a reported merge commit. A rating score comes from the owner.

The rules for derived rows are spec part 3: "Plaintext columns hold opaque identifiers, enumerations, numbers, and times. Names from the repository or the run stay in the encrypted payload. A row never holds an objective, instructions, a summary, a rubric reason, a rating note, a path, or a URL." And umbrella C1: "A durable row holds identifiers, features, dispositions, counts, and costs. It holds no free text from the run." So the projector compares paths in memory and never writes one. A project id, task id, area, commit id, or tree id goes into a sealed payload. A match uses a blind index of class `project`, `task`, or `area`.

The slice must survive:

- **A projector that falls behind.** Rows arrive later. Every rule uses `seq` order and event times, never the clock at projection time.
- **A blocked projector.** It writes no rows. A run deletion still stamps the run's existing rows through the module's `deleteRun` hook, and the outbox counts the lost events.
- **A run deleted before its events were projected.** Rows keep what was projected, get `run_deleted_at`, and carry `gap`. A fact that never arrived stays unknown.
- **Facts split across kinds.** `review.recorded` then `review.tree`; `repair.integrated` then `repair.paths`; a `member.stopped` with no `member.started`; `run.settled` before a late enrichment; `member.configured` late or never. Task 3 states each case.
- **A store that is unavailable.** Nothing is written. The backfill and the retention sweep return at once.
- **A retried page.** A page's rows and its cursor commit together. Every write is a set or a recount, never an increment, so a replayed event writes the same row.

Outside this slice: cost and its coverage, delayed signals and the base branch scan, cells and the scorecard, roll-ups, the legacy import, the purge, and hostile event shapes, which the outbox refuses.

## File map

| File | Responsibility |
|---|---|
| `packages/host/src/outcome-rules.ts` (create) | Pure rules: types, dispositions and their precedence, levels, the block-code map, round links |
| `packages/host/src/outcome-store.ts` (create) | The `outcomes` evidence module: schema, hooks, sealed row helpers, the run view, the retention sweep |
| `packages/host/src/outcome-projector.ts` (create) | The `outcomes` projector |
| `packages/host/src/outcome-backfill.ts` (create) | Rows from sealed run records that predate emission |
| `packages/host/src/teams.ts` (modify) | Two lines: the block source in `block`, the recovery source in `startAutomaticRecovery` |
| `packages/host/src/server.ts`, `packages/host/src/client.ts` (modify) | Registration, the backfill tick, the sweep, `GET /api/outcomes/runs/:runId`, `infinite usage outcomes --run ID` |
| `docs/superpowers/specs/2026-11-12-outcome-ledger-design.md` (modify) | Part 1 table: the `run.revision-advanced` data |
| `tests/outcome-{rules,store,projector,backfill}.test.ts` (create); `tests/team-events.test.ts`, `tests/teams.test.ts`, `tests/outcome-routes.test.ts` (modify) | Unit tests with a real store; the two sources, a full run, and the route |

## Review Focus

1. A review approves before a repair's paths arrive. Expect accepted yes and firstPass unknown, then firstPass set by `repair.paths`, also after the freeze.
2. A run deleted while the projector is behind. Expect its rows kept, stamped, and flagged `gap`, and no table holding a path.
3. A page that fails and is retried. Expect rows equal to a run without the failure.
4. An attempt stopped as a host stop and then named as the source of a scope violation. Expect `out-of-scope`.
5. A run that predates emission. Expect rows flagged `backfilled` that never overwrite an event-derived row.

### Task 1: the outcome rules

**Files:** `packages/host/src/outcome-rules.ts`, `tests/outcome-rules.test.ts`. Runs in parallel with Task 2.

**Interfaces (produces):**

```ts
export type Disposition = "open" | "integrated" | "completed" | "escalated" | "stalled" | "no-report" | "question"
  | "blocked" | "wrong-report" | "out-of-scope" | "limit" | "owner-stop" | "host-stop";
export type Exclusion = "limit" | "owner" | "host"; export type Level = 0 | 1 | null;   // no, yes, unknown
export type Flag = "backfilled" | "gap" | "empty-result" | "same-model-review";
export type LinkState = "pending" | "attributed" | "clear" | "unknown";
export interface RowState { role: "implementer" | "scout"; disposition: Disposition; accepted: Level; links: readonly LinkState[] }
export interface Levels { integrated: Level; accepted: Level; firstPass: Level; held: Level }
export const BLOCK_DISPOSITIONS: Readonly<Record<string, Disposition>>;
export function stopDisposition(reason: MemberStopReason): Disposition;
export function reportDisposition(kind: string): Disposition | undefined;
export function exclusionOf(disposition: Disposition): Exclusion | undefined;
export function replaces(current: Disposition, next: Disposition): boolean;
export function levels(state: RowState): Levels;
export function freezeAccepted(accepted: Level, lastReview: "approved" | "changes-requested" | undefined, status: string): Level;
export function linkAfterPaths(owned: readonly string[] | undefined, changed: readonly string[] | "omitted"): LinkState;
export function roundCounts(links: readonly LinkState[]): { run: number; attributed: number; unknown: number };
```

**Decisions:**

- Dispositions and exclusions follow the spec part 3 table. `reportDisposition` maps `question` and `blocked`. Every other report kind gives undefined, because a consume event decides it.
- `BLOCK_DISPOSITIONS`: `wrong-agent-report` is `wrong-report`. `task-scope-violation` and `read-only-role-changed-files` are `out-of-scope`. `integration-conflict`, `integration-changed-files`, `workspace-operation-failed`, `invalid-workspace-baseline`, and `workspace-copy-changed` are `host-stop`. Every other code changes no row. *(My call: the spec says "a workspace operation failure". These are the codes that `teams.ts` treats as one.)*
- **Precedence.** `integrated` and `completed` replace any disposition except each other. `wrong-report` and `out-of-scope` replace `open` and `host-stop`, because a host stop is excluded only when the attempt did not cause it. Every other disposition replaces `open` only. *(My call: the strongest host receipt wins, and the halt loop's stop never hides the attempt's own fault.)*
- **Levels.** Open, excluded, and scout rows: all unknown. A counted failure of an implementer: all no. An integrated row: integrated yes; accepted as stored; firstPass no when accepted is no or a link is `attributed`, yes when accepted is yes and every link is `clear`, else unknown; held no when accepted is no, else unknown. Held is never yes here: it needs the base branch scan.
- `freezeAccepted` keeps a stored level. Otherwise it gives no when the last covering review requested changes and the status is not `cancelled`, else unknown.
- `linkAfterPaths` uses `teamPathAllowed` from `team-workspace.ts`. Omitted changed paths, or owned paths that are unknown, give `unknown`. An empty change gives `clear`.
- `roundCounts`: `run` counts every link, `attributed` counts `attributed`, and `unknown` counts `pending` and `unknown`. *(My call: `rounds.run` counts every correction round linked to the row, of any cause. The spec ties it to today's `reviewRounds`, which counts review rounds only. `outcome_rounds.cause` keeps the scorecard's choice open.)*

- [ ] **Step 1: Write the failing tests** in `tests/outcome-rules.test.ts`.

| Test name | Assertions |
|---|---|
| `dispositions follow the spec table` | The five stop reasons give `stalled`, `limit`, `no-report`, `owner-stop`, `host-stop`. `exclusionOf` gives `limit`, `owner`, `host` for the last three and undefined for `stalled`. `BLOCK_DISPOSITIONS["task-scope-violation"]` is `out-of-scope`, `["integration-conflict"]` is `host-stop`, and `["repair-limit"]` is undefined. `reportDisposition("result")` is undefined. |
| `a later fact replaces an earlier one only by precedence` | `replaces("open", "stalled")` true. `("stalled", "owner-stop")` false. `("host-stop", "out-of-scope")` true. `("owner-stop", "out-of-scope")` false. `("host-stop", "integrated")` true. `("integrated", "host-stop")` false. |
| `levels by row state` | Open, `owner-stop`, and a completed scout: all null. A stalled implementer: 0, 0, 0, 0. Integrated with accepted null and no links: 1, null, null, null. Accepted 1 with links `clear`, `clear`: 1, 1, 1, null. Accepted 1 with `pending`: firstPass null. Accepted null with `attributed`: firstPass 0. Accepted 0: 1, 0, 0, 0. |
| `a freeze decides acceptance from the last covering review` | `changes-requested` at `ready-for-review` gives 0, at `cancelled` gives null. No review gives null. A stored 1 stays 1. |
| `a round link follows the changed paths` | Owned `["packages/host/src"]` with change `["packages/host/src/a.ts"]` is `attributed`, with `["apps/web/b.ts"]` is `clear`, with `[]` is `clear`, and with `"omitted"` is `unknown`. Owned undefined is `unknown`. Owned `["."]` is `attributed`. Owned `["src"]` with `["src2/a.ts"]` is `clear`. |
| `round counts` | `["pending", "attributed", "clear", "unknown"]` gives `{ run: 4, attributed: 1, unknown: 2 }`. |
| `team prompts never import the ledger` | The import specifiers of `team-prompts.ts` match none of `outcome-`, `configuration-store`, `config-identity`, or `evidence/` (spec "Authority and safety"). |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/outcome-rules.test.ts` and the typecheck.

### Task 2: the outcomes module

**Files:** `packages/host/src/outcome-store.ts`, `tests/outcome-store.test.ts`. Runs in parallel with Task 1.

**Interfaces (produces):** module `outcomes`, version 1. Plain columns hold ids, enumerations, numbers, and times. `payload` columns are sealed with `tx.seal(table, rowId, value)`.

```sql
CREATE TABLE outcomes (                     -- spec part 3, plus task_ref, session_id, and plain flags
  outcome_id TEXT PRIMARY KEY,              -- runId ':' memberId
  source TEXT NOT NULL, project_ref TEXT NOT NULL, task_ref TEXT NOT NULL,   -- blind indexes
  run_id TEXT NOT NULL, revision INTEGER NOT NULL, member_id TEXT NOT NULL, session_id TEXT,
  attempt_index INTEGER NOT NULL, inherited INTEGER NOT NULL, role TEXT NOT NULL,
  profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT,
  profile_epoch INTEGER NOT NULL, config_id TEXT, experiment_ref TEXT,
  area_ref TEXT NOT NULL, kind TEXT, risk TEXT NOT NULL, feature_version INTEGER NOT NULL,
  disposition TEXT NOT NULL, exclusion TEXT, flags TEXT NOT NULL,           -- sorted, comma-joined
  integrated INTEGER, accepted INTEGER, first_pass INTEGER, held INTEGER,   -- 1, 0, NULL
  started_at TEXT, ended_at TEXT, frozen_at TEXT, hold_until TEXT, run_deleted_at TEXT,
  payload TEXT NOT NULL                     -- sealed OutcomePayload
);
CREATE TABLE outcome_rounds (run_id TEXT NOT NULL, revision INTEGER NOT NULL, round INTEGER NOT NULL,
  cause TEXT NOT NULL, state TEXT NOT NULL,  -- started | answered | resolved | unknown
  started_at TEXT NOT NULL, run_deleted_at TEXT, PRIMARY KEY (run_id, revision, round));
CREATE TABLE outcome_round_links (outcome_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL,
  round INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (outcome_id, revision, round));
CREATE TABLE run_summaries (run_id TEXT PRIMARY KEY, source TEXT NOT NULL, project_ref TEXT NOT NULL,
  revision INTEGER NOT NULL, status TEXT, block_code TEXT, flags TEXT NOT NULL,
  created_at TEXT, settled_at TEXT, approved_at TEXT, run_deleted_at TEXT,
  payload TEXT NOT NULL);                   -- sealed RunSummaryPayload
CREATE TABLE member_results (result_id TEXT PRIMARY KEY, source TEXT NOT NULL, project_ref TEXT NOT NULL,
  run_id TEXT NOT NULL, revision INTEGER NOT NULL, member_id TEXT NOT NULL, session_id TEXT,
  role TEXT NOT NULL, profile_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT,
  profile_epoch INTEGER NOT NULL, config_id TEXT, report_kind TEXT,
  disposition TEXT NOT NULL,                -- open | reported | stalled | no-report | limit | owner-stop | host-stop
  flags TEXT NOT NULL, started_at TEXT, ended_at TEXT, run_deleted_at TEXT,
  payload TEXT NOT NULL);                   -- sealed { projectId, replaces? }
CREATE TABLE backfill_runs (run_id TEXT PRIMARY KEY, at TEXT NOT NULL, rows INTEGER NOT NULL, skipped INTEGER NOT NULL);
CREATE TABLE outcome_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);   -- 'last_seq'
-- Indexes: outcomes (run_id), (session_id), (run_deleted_at); member_results (run_id); outcome_round_links (run_id).
```

```ts
export const OUTCOMES_MODULE = "outcomes", OUTCOME_RETENTION_DAYS = 730;
export const OUTCOME_KINDS: readonly string[];   // the 21 kinds of the Task 3 table, shared with the projector
export type OutcomePayload = { projectId: string; taskId: string; area: string; featureMap: string;
  goal?: { id: string; cycle: number }; missionId?: string;
  replaces?: { memberId: string; cause: ReplacementCause }; failureKind?: string; baseCommit?: string;
  lastReview?: "approved" | "changes-requested"; rounds: { run: number; attributed: number; unknown: number };
  rubric?: { version: 1; correctness: number; cleanliness: number; extensibility: number; docs: number; reviewerProfileId: string };
  ownerRating?: { score: number; at: string }; diff?: TeamTask["diffStat"]; wallMs?: number;
  limitEvents: number; costCoverage: "none" };
export type RunSummaryPayload = { projectId: string; goal?: { id: string; cycle: number }; missionId?: string;
  counts?: RunSummaryCounts; attempts: Partial<Record<Disposition, number>>;
  rounds: { total: number; attributed: number; unattributed: number; unknown: number };
  currentBase?: string; reviewedHead?: string; reviewedTree?: string; mergeCommit?: string; deliveryMethod?: "merge" | "pull-request" };
// OutcomeRow, RunSummaryRow, MemberResultRow: every column in camelCase, `flags: Flag[]`, and the opened payload.
export function outcomeModule(options?: { now?: () => string }): EvidenceModule;
export function readOutcome(db: EvidenceDb, outcomeId: string): OutcomeRow | undefined;   // also runOutcomes(db, runId)
export function writeOutcome(tx: EvidenceTx, row: OutcomeRow): void;   // INSERT ... ON CONFLICT DO UPDATE, the whole row
// readSummary/writeSummary and readMemberResult/writeMemberResult have the same shapes.
export function runOutcomeView(store: EvidenceStore, runId: string): { summary?: RunSummaryRow; rows: OutcomeRow[]; members: MemberResultRow[] } | undefined;
/** Removes the rows of runs deleted more than 730 days before `now`, at most `limit` runs per call. Never throws. */
export function sweepExpiredOutcomes(store: EvidenceStore, now: string, limit?: number): number;
```

**Decisions:**

- *(My call: `task_ref` and `session_id` are added for assignment grouping and the later cost refresh, and `flags` is plain because each flag is an enumeration.)* `payload.lastReview` is added for the freeze.
- **Sentinels.** A field whose fact is missing holds `unknown` (profile id, provider, model), `(unknown)` (area: no mapped id or fallback area can spell it), risk `unknown`, feature version 0, attempt index 0, and epoch 0. Such a row carries `gap`. A member with no profile has profile id and model `default`. *(My call: the spec columns are NOT NULL, and the events carry these fields only when they exist.)*
- **`deleteRun` hook**, in the delete transaction before the run's events are removed: sets `run_deleted_at = COALESCE(run_deleted_at, now)` on the run's rows in the four run tables. When the run still has an event whose kind is in `OUTCOME_KINDS` and whose `seq` is above `last_seq`, it adds `gap` to the run's rows and summary. It removes nothing: no row holds a path or text. `last_seq` is exact, because the projector writes it at every matching event, in `seq` order, in the same transaction as its rows.
- **`runIds` hook** lists the runs whose summary or rows have no `run_deleted_at`. `EvidenceStore.sweep` then calls the hook for a run whose record file is gone, which repairs a deletion made while this module was unavailable. A stamped run is not listed again. *(My call: unlike the outbox module, this one lists runs, so the hourly sweep repairs a missed stamp.)*
- **`counts`**: `outcomes`, `open`, `gap`, `backfilled`, `summaries`, `memberResults`.
- **Retention.** A run's rows expire 730 days after `run_deleted_at` (owner decision of 2026-11-13). The rows of a live run never expire. One write removes the rows of at most `limit` runs (default 100) from all five run tables and `backfill_runs`, and logs one fixed line with the count. The sweep returns 0 at once, with no log line and no statement, unless the `outcomes` module is `ready`. *(Ruling after the local review: the hourly call must not log on every pass of an unavailable store, and a module that is not ready takes no DELETE.)* *(My call: a constant for now. The `teams.outcomes.retentionDays` key arrives with the signals slice, together with `holdDays` and the C11 digest rule.)*

- [ ] **Step 1: Write the failing tests** in `tests/outcome-store.test.ts`, with a temporary store as `tests/evidence-store.test.ts` builds it.

| Test name | Assertions |
|---|---|
| `a row round-trips with its payload sealed` | A row with task `task-a` and project `example` reads back equal. The raw `payload` column contains neither string. `project_ref` equals `tx.index("project", "example")`. |
| `deleting a run stamps its rows and removes none` | With rows in all five run tables and two events for run R, `store.deleteRun(R)` leaves every row, each with `run_deleted_at` equal to the injected `now`, and removes the events. |
| `a run deleted with unseen events is flagged` | With `last_seq` 5 and R's events at `seq` 4 and 6 (kind `task.integrated`), R's rows and summary gain `gap`. A run whose events are all at or below 5 gains none. |
| `the store sweep finds unstamped runs only` | `runIds` lists R before the deletion and not after. `store.sweep(() => false)` stamps a run that has rows and no events. |
| `rows expire 730 days after their run was deleted` | With `run_deleted_at` `2024-01-01T00:00:00.000Z`: a sweep at `2025-12-30T23:59:59.999Z` removes nothing, and one at `2025-12-31T00:00:00.001Z` removes R from every table. A live run's rows stay. With `limit` 1 and two expired runs, one call removes one run. |
| `the retention sweep waits for a ready module` | On a store with no `outcomes` module registered, and on a store whose path cannot open: `sweepExpiredOutcomes` returns 0 and writes no log line. |
| `the module reports its counts` | `describe().counts` has `outcomes.outcomes`, `outcomes.open`, and `outcomes.gap` with the expected numbers. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/outcome-store.test.ts` and the typecheck.

### Task 3: the projector

**Files:** `packages/host/src/outcome-projector.ts`, `tests/outcome-projector.test.ts`. Needs Tasks 1 and 2.

**Interfaces (consumes):** Tasks 1 and 2, `epochAt` and `CONFIGURATIONS_MODULE` from the configuration identity slice, `profileIdentityKey`, `EvidenceStore.eventsIn`. **Interfaces (produces):** `export function outcomeProjector(store: EvidenceStore, options?: { log?: (line: string) => void }): EventProjector;` with name `outcomes`, module `outcomes`, and kinds `OUTCOME_KINDS`. To change the kinds later, rename the projector, as the outbox requires.

**Decisions:** keys are `runId:memberId` for rows and member results, `runId` for summaries, `(runId, revision, round)` for rounds, and `(outcomeId, revision, round)` for links. After every change the projector recomputes `levels`, `exclusion`, and `payload.rounds` from the row's links, and stores `last_seq = event.seq`.

| Kind | Effect |
|---|---|
| `run.created` | Summary: source `production`, `project_ref`, `created_at`, payload project, goal, mission |
| `run.prepared` | Summary `currentBase` |
| `member.started` | Implementer or scout: a new row, or fills the sentinel fields of a row an earlier event made. Profile from the data; epoch `epochAt(identity, startedAt)`; session; `replaces` gives `inherited` 1 and `attempt_index` the predecessor's plus one, or 2 without a predecessor row. Features from the run's `task.planned` (implementer) or `discovery.accepted` (scout) of the same revision, read with `eventsIn(tx, { runId, kinds })`; missing gives sentinels and `gap`. Other roles: a member result, `open` |
| `member.configured` | `config_id` on the row or member result, whatever its state, when `configId` matches its components |
| `member.reported` | `reportDisposition` by precedence. Member result: `reported` with `report_kind` |
| `member.stopped` | `stopDisposition` by precedence. Member result: the same names, from `open` only |
| `task.integrated` | `integrated`, `ended_at`, `baseCommit`, `diff`, `empty-result` without a commit. A row that becomes integrated from another disposition starts with accepted unknown. Summary `currentBase` |
| `scout.completed`, `task.escalated` | `completed`; `escalated` |
| `review.recorded` | Summary `reviewedHead`, `currentBase`; a review of another head removes `reviewedTree`; `approved_at` is the event's `at` when approved and null otherwise. Integrated, unfrozen rows with this base: `lastReview`; when approved, accepted 1, `same-model-review` when the reviewer's model equals the row's, and the kept rubric for the row's task |
| `review.tree` | Summary `reviewedTree` when its head equals `reviewedHead` |
| `repair.started` | Round `started`. A `pending` link for each integrated, unfrozen row whose base equals `currentBase`, or every such row when `currentBase` is unknown |
| `repair.integrated` | Round `answered`. Links of rows with another base become `clear`. Without a commit, every `pending` link becomes `clear` and the round `resolved` |
| `repair.paths` | Each `pending` link of the round takes `linkAfterPaths(owned, changed)`, owned paths from the row's `task.planned`. The round becomes `resolved`, or `unknown` with `pathsOmitted`. The summary's rounds are recounted when a summary exists |
| `delivery.recorded` | Summary `deliveryMethod`, and `mergeCommit` for a merge |
| `rating.recorded` | `ownerRating` on the existing row of the event's `memberId`, the latest `at` winning. No level changes. A rating for a member with no row writes nothing |
| `run.blocked` | Summary status and `block_code`. The source member's row takes `BLOCK_DISPOSITIONS[code]` by precedence |
| `run.revision-advanced` | Summary revision. `baseChanged` clears `currentBase`. A recovery source acts as `run.blocked` |
| `run.settled` | Freeze: each integrated row with no `frozen_at` gets the event's `at` and `freezeAccepted`. Summary status, `settled_at`, `counts`, and attempts by disposition recounted from rows. `block_code` is cleared unless the status is `blocked`. Summary rounds are recounted per round (below) |
| `run.deleted` | The stamp of the `deleteRun` hook |
| `ledger.gap` | `gap` on the run's rows, member results, and summary. A row made later in the run copies it |

- **Before and after a late fact.** Until `review.tree` arrives, the summary has no tree, and the scan slice reads that as unknown. A link stays `pending` until `repair.paths`, so firstPass stays unknown, and the late event resolves it even after the freeze, because the round predates the freeze. A row that an event other than `member.started` made holds sentinels and `gap`. `member.configured` fills `config_id` on an ended or frozen row. A freeze never changes integrated, and a later steer or continuation makes new rows only.
- **Epochs.** When the `configurations` module is not ready, the projector throws, its page rolls back, and the cursor waits. *(My call: no row takes a guessed epoch, at the cost of a projector that waits for another module.)*
- **No path or text is written.** Owned and changed paths are compared in memory and dropped.
- **Summary rounds count rounds, not links** (spec part 6: "correction rounds with and without an attributed task"). For each row of `outcome_rounds` of the run: it is `attributed` when one of its links is `attributed`; else `unknown` when its state is not `resolved` or one of its links is `pending` or `unknown`; else `unattributed`, which includes a resolved round with no link. `total` is the number of rounds. The recount runs at `run.settled`, and again after a `repair.paths` when the run has a summary, so a path event that arrives after the settle corrects the summary too.
- **A stored acceptance belongs to an integration.** `saveRow` stores the computed levels, so a counted failure stores accepted 0. A row that later becomes integrated starts with accepted unknown, and only a review sets it. *(Ruling after the task review: `replaces` lets `integrated` follow any disposition, and a stale 0 would read as a review that requested changes.)*
- **The reviewed head, its tree, and its approval stay one fact.** A review of another head removes the stored tree, and a review that requests changes clears `approved_at`, so `approved_at` is set exactly when the reviewed head is approved. *(Ruling after the task review: the scan slice reads these three together.)*
- **A rating never makes a row.** *(Ruling after the task review: a rating can arrive for a run that predates emission before its backfill runs. A sentinel row would then keep the backfilled row out for good.)*
- **A settled status drops an earlier block code.** A run that was blocked, continued, and settled keeps no block code beside a status that is not `blocked`.
- **A freeze never changes a backfilled row's acceptance.** The backfill never claims accepted no, and no later event may add that claim: `run.settled` stamps `frozen_at` on a `backfilled` row and leaves its accepted as stored. *(Ruling after the local review.)*
- **A replacement of an attempt with no start is attempt 2.** A sentinel predecessor has attempt index 0, so the replacement takes `max(predecessor, 1) + 1`.
- **Every ended row has an end time.** A report that sets a disposition (`question`, `blocked`) ends the row at the report. A block that sets one ends the row at the block, unless a stop ended it earlier. A member result that reports ends at its report. *(Ruling after the task review: a later read orders rows and cuts time windows by `ended_at`.)*
- At `run.settled`, when the integrated rows of the event's revision differ from `summary.integrated`, the projector logs one line with fixed words and the two numbers.

- [ ] **Step 1: Write the failing tests** in `tests/outcome-projector.test.ts`, with a real store, an outbox, both modules, and both projectors. A helper builds events with `runEventKey` and flushes them.

| Test name | Assertions |
|---|---|
| `a stalled attempt and its replacement` | Spec acceptance 1 as events: m1 stalls on `a`, m2 replaces it and integrates, m3 integrates `b`, an approval, `run.settled` `ready-for-review`. m1 is `stalled` with 0, 0, 0, 0 and attempt 1. m2 has 1, 1, 1, null, attempt 2, inherited 1. m3 has 1, 1, 1, null. Both have `frozen_at` equal to the settled `at`. |
| `a repair is attributed to the task that owns its path` | Spec acceptance 4: `a` owns `a.txt`, `b` owns `b.txt`, changes requested, round 1 with `repair.paths` `["a.txt"]`, then an approval. Row `a`: accepted 1, firstPass 0, rounds `{ run: 1, attributed: 1, unknown: 0 }`. Row `b`: firstPass 1. |
| `a late path event resolves a frozen row` | As above with `repair.paths` after `run.settled`. Before it, `b` has firstPass null. After it, 1, with `frozen_at` unchanged. |
| `missing repair facts leave rounds unknown` | `pathsOmitted` gives both rows firstPass null and `unknown` 1. An unanswered round does the same. An answer without a commit gives firstPass 1. |
| `a changes-requested review freezes as not accepted` | Settled `ready-for-review`: accepted 0, firstPass 0, held 0. Settled `cancelled`: all three null. |
| `owner and host stops are excluded` | `member.stopped` `owner` gives `owner-stop`, exclusion `owner`, levels null. `host` gives `host-stop` and `host`. |
| `a scope violation names its attempt` | A host stop and then `run.revision-advanced` with recovery source `task-scope-violation` for m gives `out-of-scope`, no exclusion, levels 0. `run.blocked` `integration-conflict` for m2 gives `host-stop`. `repair-limit` changes nothing. |
| `a stop with no start writes a gap row` | Only `member.stopped` `stall`: role `implementer`, profile id `unknown`, attempt index 0, flags `gap`, disposition `stalled`. |
| `configuration and epoch reach the row` | An epoch advanced before the start gives `profile_epoch` 2. A `member.configured` after `member.stopped` still sets `config_id`. |
| `a same-model approval is flagged` | The reviewer's model equals m2's: m2 has `same-model-review`, m3 does not. |
| `a replayed page writes the same rows` | A wrapper throws once at the fifth event. After the retry, every table equals that of an unfailed run. |
| `a ledger gap marks the run` | Existing rows and the summary gain `gap`, and so does a row started later. |
| `the summary keeps review and delivery facts` | Head H, tree T, merge M, settled `merged`: `approved_at`, payload `reviewedHead` H, `reviewedTree` T, `mergeCommit` M, attempts `{ integrated: 2 }`, and `counts` equal to the event's. A `review.tree` for another head changes nothing. |
| `no table holds a path or text` | After the acceptance 4 events, no plain column and no opened payload contains `a.txt`. |
| `members without a task get member results` | A reviewer that reports is `reported` with `report_kind` `review`. An integrator that stalls is `stalled`. |
| `the summary counts rounds, not links` | Acceptance 4 with two integrated rows and one round attributed to `a`, settled: summary rounds `{ total: 1, attributed: 1, unattributed: 0, unknown: 0 }`. A second round whose paths touch neither task: `{ total: 2, attributed: 1, unattributed: 1, unknown: 0 }`. A third round with `pathsOmitted`: `unknown` 1. A fourth round that nothing answers: `unknown` 2. A `repair.paths` that arrives after `run.settled` moves its round from `unknown` to its result on the summary, with no second settle. |
| `an integration after a failure starts with no acceptance` | `member.reported` `question` gives accepted 0. A `task.integrated` for the same member then gives 1, null, null, null. An approval then gives accepted 1. |
| `a review of a new head drops the old tree and approval` | Approved head H with tree T, then a changes-requested review of head H2: payload `reviewedHead` H2, no `reviewedTree`, `approved_at` null. A late `review.tree` for H changes nothing. |
| `a rating for an unknown member writes no row` | `rating.recorded` for a member with no row: no outcome row exists for it afterwards. A rating for an existing row sets `ownerRating`. |
| `a settled run drops an earlier block code` | `run.blocked` `repair-limit`, then `run.settled` `ready-for-review`: `block_code` null. `run.settled` with status `blocked` keeps the code. |
| `a settle never turns a backfilled row to not accepted` | A row with flags `backfilled`, disposition `integrated`, accepted null, and `lastReview` `changes-requested`, then `run.settled` `ready-for-review`: accepted stays null, firstPass and held stay null, and `frozen_at` is the event's time. |
| `a replacement of a sentinel is attempt 2` | `member.stopped` `stall` for m1 with no start, then `member.started` for m2 that replaces m1: m2 has attempt index 2 and inherited 1. |
| `a row that ends has an end time` | A `question` report at minute 3: `ended_at` is that time. A host stop at minute 5 and a scope violation block at minute 6: `out-of-scope` with `ended_at` of minute 5. A block that finds the row open: `wrong-report` with the block's time. A reviewer's report: its member result ends at the report. |
| `a later event keeps a backfilled row's unknown rounds` | A row with flags `backfilled`, accepted 1, and one link of state `unknown` at revision 0, round 1 (written as Task 4 writes it): a `rating.recorded` for its member leaves firstPass null and rounds `{ run: 1, attributed: 0, unknown: 1 }`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/outcome-projector.test.ts` and the typecheck.

### Task 4: the backfill

**Files:** `packages/host/src/outcome-backfill.ts`, `tests/outcome-backfill.test.ts`. Needs Tasks 1 and 2. Runs in parallel with Task 3.

**Interfaces (produces):**

```ts
/** Pure. Paths are read and dropped. */
export function backfillRun(run: TeamRun, context: { map?: FeatureMap; epoch: (identity: string, at: string) => number; index: (cls: EvidenceIndexClass, value: string) => string }): { rows: OutcomeRow[]; summary: RunSummaryRow; skipped: number; rounds: number };
/** At most `limit` runs, one write each. Never throws. */
export function backfillTick(store: EvidenceStore, runs: () => TeamRun[], options: { mapOf: (projectId: string) => FeatureMap | undefined; limit?: number; now: () => string }): { written: number; remaining: number };
```

**Decisions:**

- **What it reads.** The sealed run records the host holds, through `TeamService.understandingRecords()`. A run qualifies when the store has no `run.created` event for it (`store.hasEvent(runEventKey("run.created", id))`) and `backfill_runs` has no row. It reads no journal and runs no Git command.
- **What it reconstructs**, per implementer or scout member, from `run.tasks` and each `run.continuations[].tasks` snapshot of the member's revision: `integrated` (a task with the member's id and status integrated), `completed` (a complete discovery task), `escalated` (`task.escalation.memberId`), `limit` (`task.limitSwitches[].memberId`), `stalled` (`stalledAt`, or the host's own `No activity for ` reason), and `question` or `blocked` (`report.kind`). Any other member is skipped and counted. Accepted is yes only under an approved review of the same snapshot (`run.review`, or the continuation's `review`), else unknown. It is never no. The payload keeps `lastReview` only for an approval: a stored `changes-requested` review is left out, because a later `run.settled` would freeze it as accepted no *(ruling after the local review)*. FirstPass is yes only with accepted yes and no correction round in the run, else unknown. The run's correction rounds are the largest `task.reviewRounds` of any snapshot, and at least 1 when a check record has `round` above 0 *(the record has no run-wide `reviewRounds`; this is the number the tasks show)*. Held is unknown. `rounds` is `{ run: N, attributed: 0, unknown: N }` for that number N. *(My call: a record cannot show which review covered an attempt whose tasks a steer cleared, so the backfill claims less than the projector.)*
- Features come from the snapshot's paths, with the project's current map. `attempt_index` is one plus the earlier members of the same revision, role, and task. `inherited` is 1 when such a member shares the cwd. `config_id` is null. Rubric and rating come from the task.
- **Marking, so sources never mix silently (umbrella C6).** Every row and summary carries `backfilled`, and its source stays `production`, as spec delivery order 2 says. A later decision query must leave `backfilled` rows out or label them. Rows insert with `ON CONFLICT DO NOTHING`, so an event-derived row always wins. The projector applies later events to a backfilled row by the same precedence and keeps its flag and its non-sentinel fields.
- **Unknown rounds are stored, not only counted.** The projector recomputes a row's levels and `payload.rounds` from its stored links at every later write. So for a run with N correction rounds the backfill writes N rows in `outcome_rounds` (revision 0, rounds 1 to N, cause `unknown`, state `unknown`, `started_at` the run's creation time, `INSERT OR IGNORE`) and, for each row it inserts, N links of state `unknown` at revision 0. *(Ruling after the task review: revision 0 never meets a real round, whose revision is 1 or more. Without the links, a later rating or configuration event would turn firstPass to yes.)*
- **A record that cannot be read is marked, not retried.** When `backfillRun` throws for a run, the tick writes that run's `backfill_runs` row with `rows` 0 and `skipped` -1 and no outcome row, and logs one fixed line per process. A store failure marks nothing, and the run stays pending. *(Ruling after the task review: twenty unreadable records at the head of the list would otherwise keep every later run out and the tick would never finish.)* The same mark applies to a record that lacks a field a row needs (a legacy record without a member's session id or the run's creation time): the tick checks that every value the write binds is plain, and that every payload is canonical JSON, before it writes, so the write step fails only for a reason of the store.
- **Order.** Runs that are not settled come first (status other than `ready-for-review`, `merged`, `no-change`, `cancelled`), then the rest, each group in the order `runs()` gives. A tick writes EVERY pending run that is not settled, and at most `limit` settled runs. The server runs the first tick in `createApp`, right after the team service is built and before any timer can fire, so no event of a run that predates emission is projected before that run's backfill. *(Ruling after the local review: an event for an old member that is projected first makes a sentinel row, and that row keeps the backfilled row out for good. The unsettled runs are bounded by the records the host holds, which `runs()` copies in the same tick. A settled run that the owner steers before its own tick has an event-made summary, which the next rule completes.)*
- **A summary that an event made first is completed, not replaced.** When the run already has a summary whose project is the sentinel `unknown` (an event reached the run before its backfill, and no `run.created` exists), the backfill keeps every event fact and takes the project, goal, mission, and creation time from the record, and adds `backfilled`; `gap` stays. A summary with a known project is never touched. *(Ruling after a host test: a host that lost its evidence database sends each record's last waiting events again at the next start, before the first tick, and those events make such a summary.)*
- **Bounded.** *(My call: at most 20 settled runs per tick.)* The server calls it once at start and then after each outbox pass until `remaining` is 0, then stops for the life of the process. The tick returns `{ written: 0, remaining: 0 }` at once, before it calls `runs()`, when the store, the `outcomes` module, or the `configurations` module is not ready: a module that is not ready stays so for the life of the process, and the next start tries again.

- [ ] **Step 1: Write the failing tests** in `tests/outcome-backfill.test.ts`, with `TeamRun` fixtures built as `tests/scorecard.test.ts` builds them.

| Test name | Assertions |
|---|---|
| `an approved run backfills accepted rows` | Two integrated tasks, an approved review, no rounds: two rows with 1, 1, 1, null, flags `backfilled`, attempt 1. |
| `a correction round leaves firstPass unknown` | `reviewRounds` 1: firstPass null and `unknown` 1 for both rows. |
| `a steered run keeps its earlier attempt` | A continuation snapshot with `a` integrated by m1 and an approved review: m1 is integrated and accepted. |
| `replacements number their attempts` | m1 stalled and m2 in the same cwd integrated: attempts 1 and 2, m2 inherited 1. |
| `unknown endings are skipped and counted` | A stopped member with only an owner stop reason: no row, `skipped` 1. |
| `the tick never overwrites and stops when done` | A run with `run.created` is untouched. An event row for R2's m1 stays as it was. A second tick writes nothing. With `limit` 1 and two runs: `written` 1, `remaining` 1. |
| `no backfilled row holds a path` | No plain column or opened payload contains an owned path. |
| `unknown rounds are stored as links` | A run with `reviewRounds` 2 on its tasks: `outcome_rounds` holds two rows for it at revision 0 with state `unknown`, and each inserted row has two links of state `unknown`. A run with no round writes neither. |
| `an unreadable record is marked and never blocks the rest` | With `limit` 1 and two runs, the first of which makes `backfillRun` throw (a record whose `members` is not an array): the first tick marks it (`rows` 0, `skipped` -1, no outcome row) and the second tick writes the second run; a third tick reports `remaining` 0. |
| `a record with a missing field is marked, not left pending` | With `limit` 1: a run whose integrated member has no `sessionId`, a run with no `createdAt` and no member `startedAt`, a run whose task rating has no `at` (its payload is not canonical JSON), and a good run. Four ticks write one each. The first three are marked (`rows` 0, `skipped` -1) with no summary and no row, and the good run has its rows. |
| `a changes-requested review is not kept` | Two integrated tasks under a `changes-requested` review of the same snapshot: accepted null and no `lastReview` in the payload. |
| `a summary that an event made first takes the record's facts` | A summary with project `unknown`, flags `gap`, status `ready-for-review`, and a settle time, then the tick: project and creation time come from the record, flags are `backfilled` and `gap`, status and settle time are unchanged, and the run's two rows exist. A summary with a known project keeps every field. |
| `every unsettled run is written in one tick` | With `limit` 1: three runs that are not settled and two settled runs. The first tick writes the three and one settled run (`written` 4, `remaining` 1). |
| `active runs come first, and a module that is not ready ends the tick` | With `limit` 1, two settled runs listed before an active one: the first tick writes the active run and the first settled run, and not the second settled run. With the `configurations` module not registered: `{ written: 0, remaining: 0 }` and `runs` is never called. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement.** **Step 4: Run** `node --import tsx --test tests/outcome-backfill.test.ts` and the typecheck.

### Task 5: the sources, the wiring, and the read route

**Files:** `teams.ts`, `server.ts`, `client.ts`, the spec, `tests/team-events.test.ts`, `tests/teams.test.ts`, `tests/outcome-routes.test.ts`. Needs Tasks 3 and 4.

**Decisions:**

- **`block` in `teams.ts`.** The line `stored.ledgerBlockSource = sourceMember?.memberId` becomes `sourceMember?.memberId ?? pending?.source?.memberId`. An operation failure blocks through `block(stored, error)` with no source member, so `run.blocked` named no attempt. *(My call: a one-line fix in `teams.ts`, because the spec's `out-of-scope` disposition depends on it.)*
- **`startAutomaticRecovery`.** Its `run.revision-advanced` data gains `sourceCode: source.code`, and `sourceMemberId: source.memberId` unless it is `unattributed`. A recovered scope violation emits no `run.blocked`, so this is the only event that names it. *(My call: without it, an automatic recovery turns the attempt's own fault into an excluded host stop.)* The spec's part 1 row gains "recovery source".
- **`server.ts`.** After the configurations registration: `evidence.register(outcomeModule())` and `outbox.registerProjector(outcomeProjector(evidence))`. The backfill tick runs once in `createApp` right after the team service is built, and `advanceOutbox` then runs it until done. `sweepEvidence` also runs `sweepExpiredOutcomes(evidence, new Date().toISOString())`.
- **`GET /api/outcomes/runs/:runId`** follows the role rule of `GET /api/usage/models`. It returns `runOutcomeView` without the blind index columns, 404 when the run has no summary and no row, and 503 when the store is not ready. *(Ruling: `project_ref`, `task_ref`, and `area_ref` are store internals. The opened payload already names the project, the task, and the area.)* `infinite usage outcomes --run ID [--json]` prints one line per row: member, role, profile, disposition, and the four levels as yes, no, or unknown.

- [ ] **Step 1: Write the failing tests.**

| Test name | Assertions |
|---|---|
| `an operation failure names its member` (team-events) | A task-scope violation with recovery exhausted, reached as `tests/teams.test.ts` reaches it: `run.blocked` has `sourceMemberId` equal to the implementer's. |
| `an automatic recovery names its source` (team-events) | `run.revision-advanced` with cause `automatic-recovery` has `sourceCode` and `sourceMemberId`. |
| `a full run projects its outcomes` (teams, host) | `fixture()` settles at `ready-for-review`. Two rows have 1, 1, 1, null, the summary status is `ready-for-review`, and member results exist for the project manager and the reviewer. |
| `rows outlive a cancelled run` (outcome-routes, host) | Spec acceptance 3: a cancel with one running implementer, then `removeRun`. The route returns the row with exclusion `owner` and a `run_deleted_at`. |

- [ ] **Step 2: Run the tests and confirm they fail.** **Step 3: Implement**, and amend the spec. **Step 4: Run** the four unit test files and `tests/team-events.test.ts`, then `tests/teams.test.ts` and `tests/outcome-routes.test.ts` on the host, then the typecheck.
- [ ] **Step 5: The coordinator runs `npm run check`, requests the independent review, and commits.**

## Not in this slice

- Cost: tokens, `spentUsd`, `listUsd`, and coverage refreshed from the usage ledger. Rows carry `costCoverage: "none"` and `limitEvents: 0`.
- Held yes, `landing`, `hold_until`, `outcome_signals`, the base branch scan, and the `scan-gap` flag. Held stays unknown unless accepted is no.
- Cells, the scorecard switch-over, `GET /api/outcomes`, roll-ups, and blind indexes for goal and mission.
- The legacy import, the `duel` and `replay` sources, `experiment_ref`, the `teams.outcomes` configuration keys, the purge, member results in the backfill, and remote access for the new route.
