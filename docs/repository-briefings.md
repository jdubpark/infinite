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

The runtime first observes sessions already active when it starts. It does not
backfill their old turns. After that baseline, a new explicit turn-end or process
exit can queue a briefing. Once configured, automatic collection is enabled by
default and runs on a bounded queue and concurrency limit, with a cooldown per
session and a finite model timeout. It does not react to permission prompts,
infer task completion, answer approvals, or change the session's execution state.

Collection waits for the transcript to settle after the checkpoint and refreshes
activity when a queued job starts. The comparison base is the checkout's HEAD
when the runtime first observes the session, which may be later than the task
started. Reports and caches live in memory and are lost when the API restarts;
restart does not backfill historical sessions.

The report describes the source snapshot collected at `generatedAt`; it does not
claim that the checkout still has that content when a person reads it. The
collector checks source freshness while generating the report. Human review is
still needed to assess whether each statement follows from its citations.

## Configuration

Enable the feature in the host configuration with an absolute executable and a
fixed argument vector. The Ubuntu template uses the root-owned wrapper shown
below; keep the model name aligned with the Codex account authenticated for the
`infinite-agent` execution identity.

```json
{
  "repositoryBriefings": {
    "command": "/usr/bin/sudo",
    "args": [
      "-n", "-H", "-u", "infinite-agent", "--",
      "/usr/local/libexec/infinite/jevcode"
    ],
    "model": "MODEL",
    "automatic": true,
    "intervalMs": 5000,
    "cooldownMs": 60000,
    "timeoutMs": 300000
  }
}
```

`command` must be absolute. The runtime appends the briefing arguments, selected
repository, model, timeout, and scoped activity input to that command. Do not
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

The installed artifact and wrapper must not be writable by either runtime
identity. Use the configured `TMPDIR` under encrypted storage. Keep Codex login
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
  --format json --model MODEL --timeout 300 --no-state
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
