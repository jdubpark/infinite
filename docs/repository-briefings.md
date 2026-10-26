# Repository briefings

The product capability is **Workspace Understanding**, opened through
**Understand**. An individual generated explanation is a **Brief**. Jevcode
remains the current engine and integration executable; configuration keys and
engine identifiers remain compatible.

Repository briefings give a session a source-backed view of its selected cloud
project and a concise review brief. The report is generated evidence for the
owner; it does not establish that work is complete, that checks passed, or that
the owner reviewed or approved a change. See [product honesty](../PRODUCT.md) and
[security](security.md) for the host's evidence and trust boundaries.

## Workspace Understanding

A **workspace** groups enrolled repositories, projects, features and recorded
work. Its existing project-group ID stays stable; grouping does not change
repository permissions or execution identity. `GET
/api/project-groups/:id/understanding` returns `schemaVersion: 1`, workspace
identity/revision, observation time, recorded work, retained repository briefs
and optional `knowledge`. Older clients can keep reading the original fields.

Work preserves missions, standalone teams and goals with their original
execution statuses, requests, reports and links. Managed child runs remain
associated with their parent. A work item spanning repositories now assigned
to different workspaces becomes a partial association; inseparable content is
withheld. A feature records explicit project, repository, component and work
associations. Its status is an owner assessment. Separate attempts retain their
own outcomes; neither an agent report nor a feature status certifies delivery.
Linked tracker work remains authoritative in its tracker. Catalog edits never
write to an external tracker.

System pages distinguish **Current**, **Planned** and **Difference**. Current
names the exact checkout source fingerprint and observation time. Planned
records proposed, accepted or superseded owner intent. Difference identifies
the source generation and plan revisions it compared. Missing evidence or a
changed plan leaves the comparison unverified. A supported generated comparison
still needs review; it cannot accept a plan or complete a feature.

Component boundaries initially come from repository layout. Static
JavaScript/TypeScript import relationships cite their source and target files;
a null citation line means file-level evidence. These edges do not establish
runtime calls or deployed topology. Owner names, pins and redirects preserve
navigation as the source evolves. Disappeared components remain labeled as
retired history. Generated text and diagrams are data, never executable markup.

### Catalog and navigation API

The following paths are relative to `/api/project-groups/:id/understanding`:

| Method and path | Result or action |
| --- | --- |
| `GET /catalog` | Complete bounded catalog and revision. |
| `GET /components` | Component navigation index and coverage. |
| `GET /components/:componentId` | Component detail and incident relationships. |
| `POST /catalog/:collection` | Create a project, feature or plan; update policy. |
| `POST /catalog/:collection/:entityId` | Update or archive a record; set a component override. |
| `POST /refresh` | Queue a bounded observation, returning maintenance status. |

Read roles are owner, controller and viewer. Mutations require owner role.
Collections are `projects`, `features`, `plans`, `components` and `policy`.
Catalog bodies contain `requestId`, the observed catalog `revision`, `action`
(`create`, `update` or `archive`) and a typed `value`; archive omits `value`.
New records use their request UUID as identity. A repeated identical request
is idempotent. Reusing an ID for different input or editing an obsolete revision
returns conflict. Refresh takes an empty object. Clients retain uncertain
mutation requests for explicit retry and do not replay edits on startup.

Catalogs are encrypted, bounded to 2 MiB per workspace, and source-bound at the
record level. Each source must remain enrolled with its original native and
repository identity. Adding an independent repository or another checkout of
an unchanged repository does not erase existing records. Missing or rebound
inputs withhold affected content. Archival preserves record identity and a
bounded revision history. Storage errors remain explicit.

### Host maintenance

Workspace maintenance is independent of an active session and continues while
clients are closed. Its policy defaults to disabled, with synthesis and delivery
observations disabled, a 15-minute interval and 24 jobs per workspace per UTC
day. Owner policy edits enable these capabilities independently. An explicit
refresh can collect a source map while scheduling is disabled; model synthesis
still requires its own enabled policy and a configured writer.

The configured engine's `context --repo` command supplies deterministic source
maps without a model call. Source fingerprints suppress synthesis for unchanged
inputs. The queue coalesces workspace refreshes, admits at most two component
briefs per workspace job, rotates pending components, applies daily admission
limits and backs off failed attempts. A workspace attempt has an overall time
limit capped at ten minutes. Each selected component gets a separate bounded
synthesis invocation; every invocation shares the remaining workspace deadline.
Collection and synthesis also have process, output and storage bounds. Current source and plan bindings are rechecked
before publishing generated comparisons. Failed attempts retain the previous
usable source observations with failure and freshness metadata.

The maintenance store has an 8 MiB encrypted budget. Legacy session briefs use
a separate rolling store of at most 16 generations per repository within 8 MiB. Those briefs
retain checkout/session provenance and generation/retention times. Mission
coordinator briefs are withheld from that single-repository artifact store
until complete multi-repository provenance is available; mission work remains
readable. Read responses stay below the encrypted transport limit and disclose
omitted records. Use the catalog and component detail endpoints for content
omitted from the overview. Response omission never deletes stored content.

Reading Understanding never schedules a model job, changes execution status or
writes to a tracker. Observation time, generation time, provider report time and
read time are distinct. A saved snapshot is not a claim about live source or
runtime health at the moment it is read.

### Delivery observations

When enabled, the host uses the existing repository-scoped `gh` installation
and credentials for read-only PR, check and deployment observations. It requires
an enrolled GitHub source matching the checkout identity. PR heads and check
results are shown separately from provider environment revisions. A merge does
not establish deployment, and a provider deployment status is not a live probe.

Unsupported credentials or missing permissions produce explicit coverage. The
service never broadens credentials or grants permissions. GitHub deployment
reads require the repository's deployments read permission; see the official
[deployment API](https://docs.github.com/en/rest/deployments/deployments) and
[status API](https://docs.github.com/en/rest/deployments/statuses). Observations
are bounded to recent provider records and disclose that coverage.

Use `infinite understand` to list workspaces and `--workspace WORKSPACE_ID` to
read one. Catalog, component, policy and mutation commands are documented in
[the CLI guide](cli.md). Desktop and mobile expose the same Work/System model.
Hosts predating the optional knowledge contract retain the original reading
experience and require an upgrade for the additional controls.

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
started. The session report cache lives in memory and is lost when the API
restarts; the retained Workspace Understanding artifacts and Jevcode's
checkpoint are not. Restart does not backfill historical sessions.

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

Jevcode briefs every repository; there is no per-repository opt-in. A
session reports the briefing as unavailable only when Jevcode's automatic
briefs are turned off globally.

To count briefing spend in the cost view, add `--report-usage` to
`repositoryBriefings.args` after the wrapper path. Jevcode then reports the
writer's token usage for each brief it writes, and only when every billed
writer call used one model; anything else stays unmeasured.

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
