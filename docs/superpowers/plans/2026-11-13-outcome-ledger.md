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
