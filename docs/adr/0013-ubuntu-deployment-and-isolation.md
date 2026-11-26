# ADR-0013: Ubuntu Host Deployment, Service Isolation, and Encrypted Backups

- **Status**: Accepted
- **Scope**: `deploy/ubuntu/`

## Context

The Ubuntu host isolates provider execution, eval trials, grading, ceilings, environment loading, and backups across dedicated non-root accounts (`infinite-host`, `infinite-agent`, `infinite-eval`, `infinite-grader`, and optional brain writer accounts). Because these shell and Python entrypoints run across `sudo` privilege boundaries on untrusted workspaces, they enforce strict path, environment, signal, and filesystem invariants.

## Decisions

### 1. Agent wrappers and environment loading (`agent-anchor.sh`, `agent-env.sh`, `agent-wrapper.sh`, `install-agent-env.sh`, `eval-wrapper.sh`, `jevcode-wrapper.sh`, `github-app-gh.sh`)
- **Byte-identical anchor patching (`agent-anchor.sh`, `install-agent-env.sh`)**: The installer never evaluates or parses arbitrary shell; it patches a wrapper only if lines `1` through `export SHELL=/bin/bash` are byte-identical to the shipped `agent-wrapper.sh`, preserving owner, group, and mode via `chown`/`chmod --reference` on the temporary file.
- **Additive, fail-safe env loader (`agent-env.sh`)**:
  - Denies launcher-owned variables, host-owned egress variables (even when egress is disabled), `_`-prefixed loader internals, and shell-reserved names.
  - Never overrides variables injected by the host via `sudoers` `env_keep` (session tokens, OpenCode credentials), while allowing later `.env` files to layer over earlier `.env` files.
  - Probes `export` in a subshell first because `set -e` turns assignment to shell-specific readonly or arithmetic names into a fatal shell abort; a failing subshell simply skips the key.
- **Wrapper runtime environment**:
  - Service accounts use disabled login shells, so wrappers export `SHELL=/bin/bash` for native tool runners and share a volume-local `pnpm` store and `corepack` cache under the agent home.
  - `codex` runs with `--no-daemon` because background app-server daemons cannot run in the service account; `claude` invokes `workspace-trust.js` when `INFINITE_TRUSTED_WORKSPACE` is set.
  - `eval-wrapper.sh` explicitly unsets `INFINITE_GITHUB_GRANT` and `INFINITE_GITHUB_PROXY` and sets `TMPDIR` equal to `EVAL_TMP` in `eval-command.sh` so `clean` reclaims temporary files.
  - `github-app-gh.sh` routes `gh` through `github-app-client.mjs` only for `infinite-agent`, leaving other service accounts on `/usr/bin/gh`.
  - `jevcode-wrapper.sh` pins `HOME` to the instance's `AGENT_HOME`, enforces an explicit subcommand and option allowlist (`auto`/`brief`/`context`/`show`/`prompt`), confines `--repo` (or physical `pwd -P` when `--repo` is omitted), effective Git `--show-toplevel`/`--git-common-dir`, `--focus` (including relative paths resolved under `--repo`), and `--log` (`WORKSPACES`/`TEAM_WORKSPACES`/`TMPDIR` only, never `AGENT_HOME`) while rejecting traversal, symlinked paths, and symlinked root ancestors, changes directory out of the caller's cwd before `exec`, and exports `JEV_API_KEY` only from a non-symlinked regular file under `AGENT_HOME`.

### 2. Eval and grader account sandboxing (`eval-command.sh`, `grader-command.sh`)
- **Pre-execution boundary checks**: Both launchers verify non-root expected UID/username, non-symlink root mode (`0711` for eval, `0700` for grader), and `cd /` before running `find -exec` (the caller's cwd may be unreachable by the isolated account, causing `find` to fail when returning after `-exec`). Test override environment variables (`INFINITE_EVAL_TEST_*`, `INFINITE_GRADER_TEST_*`) are ignored whenever running as root (`id -u == 0`), as the configured production `ACCOUNT`, under `sudo`/`doas`/`pkexec`, or from an installed system directory (`/usr/local/libexec/`, etc.), disallow `STOP_KILL_MODE=kill` and default `STOP_KILL_MODE` to `refuse` whenever any test override is active, and are unset immediately after loading.
- **Safe numeric and ID validation**: `valid_trial` and `valid_job` use glob hex character classes (`# shellcheck disable=SC2254`); `valid_count` rejects leading zeros (POSIX `sh` treats leading `0` as octal) and caps at 12 digits to avoid arithmetic overflow.
- **Credential-free process args and timeout mapping**: `git_run`, `run_trial`, and `run_child` place `timeout` and the command *last* (after `prlimit` and `env -i` with proxy/egress variables) so long-lived `timeout` arguments visible in `/proc` never hold proxy URLs or credentials. Exit status `137` (`SIGKILL` from `timeout --kill-after`) maps to `124`; the host checks elapsed wall time before treating `124` as a timeout.
- **Direct `/proc/sysvipc` inspection (`eval-command.sh`)**: `ipc_ids` parses `/proc/sysvipc/{shm,sem,msg}` with `set -f` + `# shellcheck disable=SC2086` instead of `ipcs` because `ipcs` truncates usernames to 10 characters (shorter than `infinite-eval`) and omits `cuid` (creator UID). Read failures, 4 MiB truncation, or missing columns fail closed so `probe` and `stop` never treat an unreadable table as empty.
- **Directory cleanup and link repair**: `open_tree` runs `find ... -type d ! -perm -u=rwx -exec chmod u+rwx \;` so each directory becomes traversable before `find` descends; `op_clean` repairs a symlinked/file `trials` entry (`rm -f` + `mkdir 0711`); `op_scrub` removes symlink/non-directory obstructions along `LOGIN_PATHS` top-down (failing closed by deleting obstructed logins) before copying `TEMPLATE`. `op_stop` judges shared temp directories by what remains owned by the account UID (ignoring other users' unreadable directories).
- **Grader specifics (`grader-command.sh`)**: `probe` emits `"version":2` (hosts treat absence as v1); `op_read` reads `maxbytes + 1` bytes to catch files growing after `stat`; `op_export` verifies `refs/heads/trial` before streaming bytes (exiting `2` if absent).

### 3. Provider ceilings installer (`install-ceilings.sh`)
- Validates JSON/TOML templates before touching destination paths.
- Walks `safe_above` to `/` verifying real, root-owned, non-group/world-writable directories before inspecting or writing targets (preventing planted symlink attacks).
- Never reads through a symlink or special file as root; backs up existing regular targets using unpredictable `mktemp` root-only files; installs via `mktemp` + `mv -fT` so directory symlinks are replaced atomically rather than followed.

### 4. Online encrypted backups and verification (`backup.py`, `verify-backup.py`)
- **Crash-consistent freeze protocol (`backup.py`)**: Verifies unlocked `/dev/mapper/` storage, confirms all `infinite-host`, `infinite-agent`, and configured `brain` writer processes sit inside expected systemd cgroups, arms an independent 45s `systemd-run` thaw timer *before* `systemctl freeze` (bounding pause duration even after `SIGKILL`), enforces a 30s copy budget excluding temporary dirs while preserving full SQLite WAL/rollback journals, archives with `--format=pax --acls --numeric-owner`, and encrypts solely to a public `age` recipient (key recovery stays on owner devices). Fatal errors suppress native-home filenames and subprocess payloads.
- **Offline verification (`verify-backup.py`)**: Verifies SHA-256 against the owner receipt before decrypting into a fresh `0700` directory via Python `tarfile.data_filter`, records skipped external symlinks in `external-links.json`, opens copied SQLite databases normally to recover WALs and run `PRAGMA integrity_check`, and explicitly reports that PAX ACLs/numeric owners are not applied during verification.

### 5. Auxiliary wrappers (`repository-graph-wrapper.py`, `process-census.sh`, `transcript-drain.sh`)
- `repository-graph-wrapper.py` runs with `#!/usr/bin/python3 -I`, confines `--repo` inside the instance's `workspaces/` or `team-workspaces/` and `--cache-dir`/`--seed-cache-dir` inside its `repository-graphs/`, rejects `..` traversal, symlinked root ancestors, and symlinks along uncreated paths, bounds `--timeout-seconds` (1–300) and `--max-workers` (1–2), and scrubs environment variables via `os.execve`.
- `process-census.sh` and `transcript-drain.sh` refuse any CLI arguments (`exit 64`), taking input solely from stdin or `sudo` `env_keep`.

## Consequences

- Security, shell-portability, cgroup-freeze, and privilege-boundary invariants for Ubuntu deployment scripts are preserved in one place.
- All 15 scripts in `deploy/ubuntu/` carry zero prose comments (retaining only line-1 shebangs and `# shellcheck disable=...` directives) under `scripts/check-comments.mjs`.
