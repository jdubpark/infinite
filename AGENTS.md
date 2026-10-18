# Agent instructions for Infinite

Infinite is a persistent agent host with a web client and a React Native phone app. This file applies to every AI coding agent and assistant working in this repository. `apps/mobile/AGENTS.md` adds Expo-specific rules for that directory.

## Never commit private, personal, or machine-specific information

This repository must stay safe to publish. Nothing that identifies a person, a machine, an account, or a deployed host belongs in code, tests, fixtures, docs, plans, specs, comments, or commit messages.

Do not write any of the following into a tracked file:

- **Local filesystem paths.** No home-directory paths such as `/Users/<name>/…`, `/home/<name>/…`, `~/Library/…`, or `~/Projects/…`, and no temp or scratch paths from the machine you are running on. Use repository-relative paths, or a neutral placeholder such as `/home/dev/projects/infinite` when a test or example needs an absolute path.
- **Personal identifiers.** No real names, usernames, account handles, email addresses, phone numbers, or machine names. This includes handles embedded in app, bundle, or package identifiers.
- **Infrastructure identifiers.** No real IP addresses, hostnames, tailnet or VPN names, SSH host fingerprints, disk or volume UUIDs, release hashes, cloud account or project IDs, or instance names. Use placeholders such as `SERVER_PUBLIC_IP`, `HOST.YOUR-TAILNET.ts.net`, and documentation ranges such as `192.0.2.0/24`.
- **Secrets.** No tokens, device keys, API keys, passwords, private keys, push tokens, or credential file contents, and no instructions that point at a specific private credential file on someone's machine.
- **References to private work.** No paths into other private repositories or projects on the author's machine, and no content copied from private conversations, personal settings, or personal agent configuration.
- **Hardware and environment details that identify the author's machine**, such as an exact laptop model. Give only the figures a design argument needs.

The same rule applies to captured material. Terminal recordings, screenshots, logs, hook payloads, and command output used as fixtures or evidence must be redacted before they are saved in the repository.

When a document needs to say that private material exists, say where it lives in general terms, for example "recorded privately, outside this repository". Do not name the location.

### Before finishing any change

1. Read your own diff for the items above, including generated plans, specs, and reports.
2. Run a scan over what you are about to commit and resolve every hit that is not a documented placeholder:

   ```sh
   git diff --cached | grep -n -I -E '/Users/|/home/[a-z0-9_-]+/|~/(Library|Projects|Documents|Desktop)|\.ts\.net|SHA256:|BEGIN [A-Z ]*PRIVATE KEY|([0-9]{1,3}\.){3}[0-9]{1,3}'
   ```

   Loopback and documentation addresses (`127.0.0.1`, `10.0.2.2`, `192.0.2.x`) are expected hits.
3. Keep runtime state, keys, and local receipts in ignored locations (`.local/`, `.env`, `credentials.txt`). Never force-add an ignored file.

If you find existing private information while working, remove or replace it and say so in your summary. Do not leave it because it was already there.

## Working in this repository

- Use the configured Linear team as the source of truth for product tasks,
  bugs, scope, and resolution. Reuse the relevant issue; keep implementation
  findings and verification evidence there instead of maintaining a second
  backlog in repository documents. Keep workspace URLs and issue bindings in
  private runtime configuration, outside tracked files.
- Record actual progress in Linear. Passing checks and agent approval mean
  ready for review; they do not prove merge, deployment, or product impact.
  If Linear access is unavailable, report the unsynchronized work explicitly
  and preserve its request identity rather than inventing a completed update.

- Requirements: Node.js 22.14+ and npm. `npm ci` builds the shared `@infinite/attention` package during install.
- Run `npm run check` (typecheck, tests, builds) before declaring host or shared-package work complete.
- For the phone app, also run `npm run lint -w @infinite/mobile` and `npx tsc --noEmit` in `apps/mobile`.
- Product, design, and protocol context: `PRODUCT.md`, `DESIGN.md`, `docs/architecture.md`, `docs/security.md`.
- Do not weaken the honesty rules in `PRODUCT.md`: the host never infers task completion and never approves a provider permission on its own.

## Repository summaries and architecture review

Use Jevcode's headless repository briefing agent for human-facing change summaries, substantial handoffs, and architecture review. The coordinator owns the brief; workers supply scoped evidence. Never invoke another briefing agent from within a briefing run.

Use it to compress agent activity into meaningful changes, explain system responsibilities and boundaries, rank critical code for human inspection, draw the system and change diagrams, and identify constraints that should guide subsequent agent work. Prioritize permissions, session lifecycle, durable state, transport, provider adapters, and shared contracts when affected. Include important unchanged code and unresolved architectural questions.

Configure `JEVCODE_ROOT` outside the repository to a built Jevcode installation on the execution host. Muse Spark 1.3 Contributor writes briefs through OpenCode, with DeepSeek V4.1 Flash as the fallback. Jev (TypeSafe System One) decides when a refresh is worth its cost, which sections are stale, and whether each claim's citations support it.

Briefs refresh automatically. Where the execution host installs Jevcode's Stop hooks, every Claude Code and Codex turn ends with a detached `jevcode auto` check that costs no model tokens when nothing changed. Do not run briefs routinely. At a handoff, or before writing a human-facing summary, request a refresh with your own session transcript and read the result:

```sh
node "$JEVCODE_ROOT/scripts/jevcode.mjs" auto --repo "$PWD" --log "$SESSION_TRANSCRIPT"
node "$JEVCODE_ROOT/scripts/jevcode.mjs" show --repo "$PWD"
```

For a forced full brief over an explicit range, set `REVIEW_BASE` to the comparison commit:

```sh
node "$JEVCODE_ROOT/scripts/jevcode.mjs" brief --repo "$PWD" --base "$REVIEW_BASE"
```

Run from the repository root. The base compares that commit to the current working tree; omitting it only reviews changes since HEAD. Add repeated `--focus` paths and `--log` files only for the assigned scope. Select logs explicitly; do not discover global histories. Keep reports and checkpoints outside tracked source. When the human says a brief was unhelpful, late, or wrong, record it with `jevcode feedback noise|late|wrong [--section NAME]`; Jevcode tunes its timing and claim checks from those outcomes. See the installation's `docs/repo-agent.md` for setup, state, data use, and collection limits.

Lead the human summary with the outcome, system shape, and at most five ranked review questions with source references. Follow with meaningful changes, check evidence, guidance for agents, and gaps. Separate observed code, agent claims, and inference; label proposed guidance as proposed. Historical check logs do not certify the current tree, and a generated brief grants no approval or completion status. Required checks and independent review still apply.

If OpenCode is unavailable, use `--runner codex`. If no allowed writer is available, use Jevcode's `prompt` or `context` command with the approved reviewer. If Jevcode itself is unavailable, report that gap and use the same brief structure directly. Do not install credentials, change provider configuration, or bypass permissions to produce a summary. This is an agent workflow; changes to the host's chat-summary endpoint require a separate implementation task.
