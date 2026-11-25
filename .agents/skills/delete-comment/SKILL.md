---
name: delete-comment
description: Use when auditing, categorizing, and deleting code comments in this repository under the ratcheted comment-ban check (`scripts/check-comments.mjs`), moving decision records to `docs/adr/` and tracking excuse hacks in Linear.
---

# Delete comments and tighten the ratchet

This repository bans prose comments in new and cleaned source files via `npm run check:comments` (`scripts/check-comments.mjs`) backed by the downward-only baseline in `scripts/comments-baseline.json`. The checker covers TypeScript/JavaScript (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`), Swift/C/Kotlin (`.swift`, `.c`, `.h`, `.kt`, `.kts`), Python (`.py`), Shell (`.sh`), CSS (`.css`), and systemd unit files (`.service`, `.timer`, `.socket`). Use this workflow to burn down remaining baseline files cleanly without losing architectural decisions or hiding hacky workarounds.

## 1. Pick a target slice

Inspect remaining comment debt and full-line LOC savings:

```sh
node scripts/check-comments.mjs --stats
```

Choose a coherent subsystem, directory, or set of files from `scripts/comments-baseline.json` (for example one package, one app feature folder, or the files already touched by the current task). Do not mix unrelated edits into an active feature branch unless requested.

## 2. Classify every comment in the slice

Read each target file in full before editing. Categorize every non-directive comment block into exactly one bucket:

- **Tautology**: Repeats what the code, type signature, identifier name, or control flow already expresses.
- **Stale**: References symbols, files, behaviors, or temporary milestones that are no longer accurate or relevant.
- **Excuse**: Rationalizes a hack, missing check, brittle assumption, silent fallback, or workaround that should be fixed instead of explained away.
- **Decision Record**: Captures a non-obvious architectural, protocol, security, concurrency, or compatibility decision ("why this design instead of the obvious alternative").

Machine pragmas exempted by `scripts/check-comments.mjs` (do not delete these if still required by the toolchain): line-1 shebangs (`#!`), line-1 `// swift-tools-version:`, `/// <reference ... />`, `@ts-expect-error` compile-time negative tests, bare single-line `// eslint-disable-next-line` directives, and `# shellcheck disable=` in `.sh` files. Remove any prose attached to them when possible, or fix the underlying code so the directive is unnecessary.

## 3. Take the required action for each category

- **Tautology / Stale**: Delete the comment. If deleting a comment exposes an unclear identifier or magic constant, rename the identifier or extract a named constant instead of rewriting the comment.
- **Excuse**:
  1. Delete the comment.
  2. Resolve the configured Linear team from the checkout's private runtime configuration and file a Linear issue in that team (using the configured Linear MCP tools; search first to avoid duplicates) describing the hacky implementation, exact file path, failure mode, and concrete acceptance criterion.
  3. If Linear MCP is unavailable in the current session, do not invent a tracked backlog file inside the repository; report the unsynchronized Linear-ready issue drafts in the handoff/summary so the owner or next session can file them.
- **Decision Record**:
  1. Preserve the non-obvious decision in an Architectural Decision Record under `docs/adr/NNNN-short-topic.md` (extend an existing ADR when the decision belongs to the same subsystem rather than creating overlapping files).
  2. Update `docs/adr/README.md` with the new or updated entry.
  3. Delete the in-code comment once the ADR captures the rationale and constraints.
  4. Never include local filesystem paths, personal identifiers, hostnames, secrets, or private references in any ADR (`AGENTS.md`).

## 4. Lower the ratchets and verify

Lower both ratchets (never hand-raise a baseline entry):

```sh
node scripts/check-comments.mjs --update
node scripts/check-file-size.mjs --update
```

Run the required checks for the affected surfaces:

```sh
npm run check
```

If `apps/mobile` changed, also run `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` inside `apps/mobile`. If `apps/macos` changed, run `swift test` inside `apps/macos`.

Scan the diff for private or machine-specific information before committing:

```sh
git diff --cached | grep -n -I -E '/Users/|/home/[a-z0-9_-]+/|~/(Library|Projects|Documents|Desktop)|\.ts\.net|SHA256:|BEGIN [A-Z ]*PRIVATE KEY|([0-9]{1,3}\.){3}[0-9]{1,3}'
```

## 5. Report outcomes

Report:
- Files brought to 0 comments and total comment lines shed.
- Counts by category (`Tautology`, `Stale`, `Excuse`, `Decision Record`).
- ADRs added or updated (`docs/adr/...`).
- Linear issue IDs filed for `Excuse` comments (or explicit unsynchronized Linear-ready drafts when Linear MCP is unavailable).
- Verification command results.
