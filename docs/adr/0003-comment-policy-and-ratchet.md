# ADR-0003: Zero-Comment Policy with Downward Ratchet

- **Status**: Accepted
- **Scope**: Repository-wide (`scripts/check-comments.mjs`, `scripts/comments-baseline.json`, `.agents/skills/delete-comment/SKILL.md`)

## Context

An AST-accurate census of the repository found 11,600 comment blocks spanning 17,702 comment lines (17,381 full-line comment lines) across 961 of 1,097 source files. In practice, source comments split into four buckets:

1. **Tautologies** that restate types, identifiers, or control flow.
2. **Stale comments** that drift away from the code they describe.
3. **Excuses** that normalize hacky implementations instead of filing and fixing them.
4. **Decision Records** that capture genuinely non-obvious architectural, protocol, or security constraints.

Deleting all comments in a single PR across 961 files would create an unreviewable diff and risk losing valuable decision rationale or silently burying hacks.

## Decision

1. **Ban prose comments in new and cleaned files**: `scripts/check-comments.mjs` (wired into `npm run check` via `npm run check:comments`) parses TypeScript/JavaScript via the TypeScript AST (`typescript`) and Swift/C/Kotlin/Python/Shell via string-aware lexers. Any file not listed in `scripts/comments-baseline.json` must contain 0 prose comments.
2. **Downward-only ratchet**: Existing files with comments are recorded in `scripts/comments-baseline.json` by comment line count. No file may grow past its recorded count. `node scripts/check-comments.mjs --update` only lowers or removes entries; it never adds or raises them.
3. **Narrow toolchain pragma exemption**: Line-1 shebangs (`#!`), line-1 SwiftPM `// swift-tools-version:` headers, TypeScript `/// <reference ... />` directives, `@ts-expect-error` compile-time negative tests, bare single-line `// eslint-disable-next-line` directives, and `# shellcheck disable=` directives in `.sh` files are exempt so required compiler/linter pragmas remain functional. `@ts-ignore` and multiline `/* eslint-disable ... */` blocks are intentionally not exempt.
4. **Preserve knowledge outside source comments**:
   - Move **Decision Records** into numbered ADRs under `docs/adr/`.
   - Delete **Excuse** comments and file Linear issues in team `INF` to fix the underlying hacks.
   - Delete **Tautology** and **Stale** comments outright, improving naming or types where needed.
5. **Repeatable burn-down**: `.agents/skills/delete-comment/SKILL.md` defines the repeatable `/delete-comment` workflow for clearing remaining baseline files in focused waves.

## Consequences

- New modules and refactored files carry zero prose comments by construction.
- Existing comment debt strictly decreases over time alongside `scripts/check-file-size.mjs`.
- Architectural rationale lives in searchable, reviewable ADRs rather than scattered inline comments.
