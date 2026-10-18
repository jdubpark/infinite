# Repository briefings

Repository briefings give a session a source-backed view of its selected cloud
project and a concise review brief. The report is generated evidence for the
owner; it does not establish that work is complete, that checks passed, or that
the owner reviewed or approved a change. See [product honesty](../PRODUCT.md) and
[security](security.md) for the host's evidence and trust boundaries.

## Session summary

When `repositoryBriefings` is absent, `GET /api/sessions/:id/summary` keeps its
existing transcript-summary behavior. When configured, the endpoint returns the
latest repository brief for an eligible session. Add `?status=1` to inspect
briefing state without starting a collection or model request.

Each run is a Jevcode automatic refresh (`jevcode auto --trigger host`), not a
fresh brief. It returns at no model cost when neither the checkout nor the
session's recorded chat moved since its last check, asks Jev (TypeSafe) whether
the change is worth a refresh when the agent account holds a key, revises only
the stale sections of the previous brief, checks each claim against its cited
excerpts, and tunes its own timing from recorded outcomes. Jevcode keeps that
state per checkout in the agent account's home, so a brief survives API
restarts. A brief that was not regenerated for a turn says so in its text, and
`repository.decision` carries the run's decision. A checkpoint built over a
different comparison base is rebuilt rather than returned.

The runtime first observes sessions already active when it starts. It does not
backfill their old turns. After that baseline, a new explicit turn-end or process
exit can queue a briefing. Once configured, automatic collection is enabled by
default and runs on a bounded queue and concurrency limit, with a cooldown per
session and a finite model timeout. It does not react to permission prompts,
infer task completion, answer approvals, or change the session's execution state.

Collection waits for the transcript to settle after the checkpoint and refreshes
activity when a queued job starts. The comparison base is the checkout's HEAD
when the runtime first observes the session, which may be later than the task
started. The host's own report cache lives in memory and is lost when the API
restarts; Jevcode's checkpoint is not, and restart does not backfill historical
sessions.

The report describes the source snapshot collected at `generatedAt`; it does not
claim that the checkout still has that content when a person reads it. The
collector checks source freshness while generating the report. Human review is
still needed to assess whether each statement follows from its citations.

## Configuration

Enable the feature in the host configuration with an absolute executable and a
fixed argument vector. The Ubuntu template uses the root-owned wrapper shown
below. `runner` selects Jevcode's writer: absent, Jevcode writes with Muse Spark
1.3 Contributor through OpenCode and falls back to DeepSeek V4.1 Flash, which
requires OpenCode authenticated for those providers in `infinite-agent`'s home;
`codex` uses the Codex account already authenticated there. `model` overrides
the writer's model and is optional.

```json
{
  "repositoryBriefings": {
    "command": "/usr/bin/sudo",
    "args": [
      "-n", "-H", "-u", "infinite-agent", "--",
      "/usr/local/libexec/infinite/jevcode"
    ],
    "runner": "codex",
    "automatic": true,
    "intervalMs": 5000,
    "cooldownMs": 60000,
    "timeoutMs": 300000
  }
}
```

`command` must be absolute. The runtime appends the automatic-run arguments,
session id, selected repository, comparison base, writer, timeout, and scoped
activity input to that command. Do not
put provider credentials or prompt text in the configuration. `automatic`
defaults to `true`; the timing fields above show their defaults in milliseconds.

The runtime supports regular managed-host projects and team worktrees whose
source root it can resolve. Hybrid laptop execution and cmux sessions do not yet
provide a source mapping for this collector, so their briefing state is
unavailable rather than inferred from another checkout.

## Linux installation

Build the Jevcode deployment artifact with the pinned pnpm version in an
unprivileged build checkout. The packaging script builds the filtered runtime
dependency set, deploys it with production dependencies and tree-sitter WASM
assets, repairs pnpm's workspace self-link, verifies that links stay within the
artifact, and startup-checks the packaged CLI.

```sh
cd /path/to/jevcode
pnpm install --frozen-lockfile
node scripts/package-repo-agent.mjs /tmp/jevcode-repo-agent
```

Install that artifact into the dedicated root-owned location and install the
wrapper and sudoers template. Provision the wrapper's temporary directory on
the encrypted data volume for the agent identity:

```sh
sudo install -d -o infinite-agent -g infinite-agent -m 0700 \
  /srv/infinite-data/tmp/agent
sudo install -d -o root -g root -m 0755 /opt/jevcode-repo-agent
sudo rsync -a --delete /tmp/jevcode-repo-agent/ /opt/jevcode-repo-agent/
sudo chown -R root:root /opt/jevcode-repo-agent
sudo chmod -R go-w /opt/jevcode-repo-agent
INFINITE_CHECKOUT=/path/to/infinite
sudo install -o root -g root -m 0755 \
  "$INFINITE_CHECKOUT/deploy/ubuntu/jevcode-wrapper.sh" \
  /usr/local/libexec/infinite/jevcode
sudo install -o root -g root -m 0440 \
  "$INFINITE_CHECKOUT/deploy/ubuntu/infinite.sudoers" \
  /etc/sudoers.d/infinite
sudo visudo -cf /etc/sudoers.d/infinite
```

Jevcode briefs only repositories the owner opted in, and the host trigger is
no exception: a session in any other repository reports the briefing as
unavailable. Opt a repository in as the agent account; the rule covers every
clone and worktree of that repository, including team worktrees:

```sh
sudo -n -H -u infinite-agent -- /usr/local/libexec/infinite/jevcode \
  optin --repo /srv/infinite-data/workspaces/PROJECT
```

To let Jev gate refreshes and check claims, store a TypeSafe key readable only
by the agent account; the wrapper exports it when present:

```sh
sudo install -d -o infinite-agent -g infinite-agent -m 0700 ~infinite-agent/.config/jevcode
# Write the key on stdin so it never appears in a command line or shell history.
sudo -u infinite-agent sh -c 'umask 077; cat > ~/.config/jevcode/jev-api-key'
```

Without it, Jevcode uses its disclosed heuristic gate and leaves claims
unchecked; the brief's coverage says so. The installed artifact and wrapper must
not be writable by either runtime identity. Use the configured `TMPDIR` under encrypted storage. Keep Codex login
and native history in `infinite-agent`'s protected home; do not forward laptop
credentials. The wrapper forwards CLI arguments without adding provider flags
or changing the provider's approval mode. Install the feature disabled until the
package and provider qualification below succeeds.

## Qualification before activation

First verify the command wrapper and collector against a disposable, approved
checkout as `infinite-agent`. `context` makes no model request; `brief` reads
selected source and sends the prompt and evidence to the provider authenticated
for that account.

```sh
sudo -n -H -u infinite-agent -- /usr/local/libexec/infinite/jevcode \
  context --repo /srv/infinite-data/workspaces/briefing-sample
sudo -n -H -u infinite-agent -- /usr/local/libexec/infinite/jevcode \
  brief --repo /srv/infinite-data/workspaces/briefing-sample \
  --format json --runner codex --timeout 300 --no-state
```

After the context command, confirm the selected checkout and disclosed
collection limits. Before the model request, confirm the checkout is approved
for transmission to the configured provider. Confirm the report is schema-valid,
citations resolve, the collected snapshot did not change, and a timeout or
invalid report does not advance state. The CLI runs no tests or builds and does
not establish deployment status. Only after these checks should the
`repositoryBriefings` configuration be enabled and the API restarted.

## Evidence and activity limits

The report includes the source fingerprint and generation time so a client can
label it as a generated snapshot. A fingerprint is not a human review receipt.
Citation validation checks that each source path and line exists in the
collected snapshot or supplied activity; it cannot prove the cited text entails
the model's sentence. The collector excludes secret-pattern, generated, binary,
and symlinked files, and reports its scan and excerpt limits. Redaction is
pattern-based and cannot guarantee arbitrary source contains no secrets.

The host supplies only recorded chat messages for the session that triggered
the brief. It reads a recent window of at most 2,000 journal positions and keeps
the latest 200 messages within a 256 KiB input limit. The report discloses omitted
activity and retains citation excerpts in both structured and text output.
The CLI accepts this bounded JSONL stream on stdin with
`--activity-stdin`; it does not search provider histories or other sessions.
Activity records may support claims about what the agent reported, but they do
not certify that the report is true. The brief's checks section is historical
evidence only. No transcript, report, or tool event can grant provider approval
or mark a task complete.
