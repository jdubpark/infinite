# ADR-0011: Build, Native Workspace Watch, Code Graph, and Verification Tooling

- **Status**: Accepted
- **Scope**: `scripts/`, `.agents/skills/verify-infinite/scripts/`

## Context

Repository tooling spans experimental Codex handoff builds and qualification, macOS desktop packaging, a C `kqueue` filesystem guard (`scripts/native/workspace-watch.c`), an incremental Graphify snapshot builder (`scripts/repository_graph.py`), instance template rendering, downward file-size ratchets, the test runner, and the Playwright live-verification harness. Non-obvious OS, toolchain, and isolation invariants from these tools are consolidated here.

## Decisions

### 1. Codex handoff build, qualification, and hybrid prototype (`build-codex-handoff.mjs`, `qualify-codex-handoff.mjs`, `hybrid-codex.mjs`)
- **Cargo lock version stamping and companion bundling (`build-codex-handoff.mjs`)**: Official Codex source archives stamp workspace manifests with the release version while leaving source-less entries in `Cargo.lock` at `0.0.0`; rewriting only source-less workspace entries lets `cargo build --locked` succeed without altering third-party dependency locks. The unpatched `codex-code-mode-host` V8 binary is copied from the matching `@openai/codex` npm package (direct `exec_command` probes cannot detect its absence) and published atomically before `codex-app-server`.
- **Qualification scope (`qualify-codex-handoff.mjs`)**: Qualifies only the narrow handoff boundary (single native command, same OS, determinate refusal before dispatch, no uncertain effect); it does not qualify general process fencing, arbitrary shell classification, or outage recovery.
- **Hybrid laptop executor (`hybrid-codex.mjs`)**: Opt-in prototype that keeps conversation and model auth on Infinite while running tools on the laptop. Child processes are supervised via an inherited pipe (`fd 3`) so even `SIGKILL` tears down helpers (`codex --exit-on-stdin-close` only works in hosted registration mode). Provider approval requests remain unanswered for explicit user decisions in the native UI/phone. Each connection allocates a fresh `environmentId` (Codex caches executor connections by ID) and aligns top-level `cwd` so a rejoining native TUI does not reset the environment.

### 2. macOS signing and PTY helper preflight (`build-macos.mjs`, `packages/host/src/pty-preflight.ts`)
- `build-macos.mjs` signs `Infinite.app` with `INFINITE_SIGN_IDENTITY` or the local `Apple Development:` certificate so macOS Keychain items stay accessible across rebuilds without committing developer identities to tracked files.
- Rather than mutating `node_modules` during `postinstall` (which breaks under `npm ci --ignore-scripts` and masks upstream fixes), `packages/host/src/pty-preflight.ts` follows `node-pty`'s `build/Release` → `build/Debug` → `prebuilds/darwin-<arch>` native-module selection order, verifies effective process read/execute access (`R_OK`/`X_OK`, distinguishing ancestor-directory `EACCES` as `inaccessible`), reports status in `infinite doctor`, warns at host startup (`cli.ts`), and enriches `worker.ts` `node-pty` spawn failures with explicit remediation.

### 3. Native `kqueue` workspace change guard (`scripts/native/workspace-watch.c`)
- **Why `kqueue` `EVFILT_VNODE`**: Kernel vnode filters retain change flags until drained (including write/revert pairs), whereas `FSEvents`/`FlushSync` can lag completed writes and cannot certify a capture. Because writable `mmap` can modify bytes without vnode events, this binary serves as a change guard for an explicitly qualified writer profile rather than a filesystem snapshot; no paths or file contents leave the helper.
- **Race-free registration and special files**: Every directory is registered in `kqueue` *before* enumerating children so additions or replacements during traversal invalidate the watch. Traversal rejects symlinks and nested mounts. In `--changes` mode, `fstatat(..., AT_SYMLINK_NOFOLLOW)` filters out special files before `openat` because opening a FIFO can block and sockets cannot be opened as vnode descriptors (the already-registered parent watch catches replacement with a capturable entry). `report()` caps draining at `MAX_WATCHES * 2` events so a busy writer cannot monopolize the control channel.

### 4. Incremental code-graph snapshot builder (`scripts/repository_graph.py`)
- **Path safety and process cleanup**: `_safe_path` resolves caller-provided parent directories (accommodating system temp aliases) while forbidding symlinks at the cache root itself. Graphify executes in its own session (`start_new_session=True`), and `SIGTERM`/timeout terminates its entire process group (`os.killpg`).
- **Hard-linked immutable blobs and generation retention**: Committed source blobs are immutable, so warm generations hard-link unchanged trees (`os.link`) and replace changed files via new inodes. Older generations are retained for 24 hours (keeping at least the two newest regardless of age) so immutable `graph.json` paths returned to queued agents remain readable.
- **Dependency invalidation across Graphify node IDs**: Graphify names unresolved module anchors `ref_<module>` and replaces them with `<module>`/`<module>_*` once defined, so `_newly_resolved_dependents` normalizes `ref_` prefixes against newly added provider IDs. Because unresolved JS/TS module IDs omit importing directories, unresolved JS/TS consumers are revisited whenever a new provider node is introduced, while ordinary body edits reuse cached graph entries.

### 5. Instance rendering, file-size ratchet, and test runner (`render-instance.mjs`, `check-file-size.mjs`, `run-tests.mjs`)
- `render-instance.mjs` applies all path/name replacements in a single longest-match regex pass over the original template so inserted instance segments cannot match later rules. Secondary instances render instance-scoped `jevcode-wrapper.sh` and `repository-graph-wrapper.py` wrappers confined to `/srv/infinite-data/instances/<name>/` and enable both in `infinite-<name>.sudoers`.
- `check-file-size.mjs` enforces a downward-only file-length ratchet (`--update` only lowers or removes entries; raising requires an explicit diff).
- `run-tests.mjs` runs process-sensitive suites (`client-cli`, `main-check-real`) serially after the parallel phase and, in non-TTY output (CI/host checks), reprints failed test names after each phase so early failures are visible in truncated logs.

### 6. Live browser verification harness (`.agents/skills/verify-infinite/scripts/`)
- **Isolation and port reservation**: `launch-profile.sh` and `drive.mjs` never use port `4780` (reserved for host tunnels), require an `ownership.json` claim receipt and `/tmp/iv-` run directory (keeping Unix socket paths within OS limits), enforce that every configured agent is a `tests/fixtures` script, and pre-create `release-first-plan` for goals journeys unless `VERIFY_HOLD_FIRST_PLAN` is set. Device keys are redacted from all logs and evidence files.
- **Target and process-identity guards**: Every API call and browser sign-in verifies via `lsof` and `ps` that the claimed API PID still owns the instance config and port. Process cleanup matches `(lstart, args)` to prevent adopting reused PIDs (subject to `lstart`'s 1-second resolution), discovers detached worker trees via `lsof -U` sockets under the run directory (still visible after directory removal), and shuts down goals before standalone teams (goal cancellation cascades to cycles; team cancel returns `409` on goal-owned runs).
- **Journey assertions**: Browser journeys verify `httpOnly` cookie scoping under `/api`, read authoritative lease state from the host API, explicitly release control before ending (a held lease blocks stops with `409`), and verify that a `ready-for-review` goal has an approved cycle review rather than merely hitting its cycle limit.

## Consequences

- Native watcher, incremental Graphify, Codex handoff, and verification-harness constraints are preserved centrally without inline comments.
- All 14 files in `scripts/` and all 3 script files under `.agents/skills/` carry zero prose comments under `scripts/check-comments.mjs`.
