# The hard boundary: provider ceilings, agent egress, and the GitHub credential proxy (INF-231, INF-232, INF-233)

Date: 2026-11-14. Status: code built and merged as #144 (`main` `65d7311`); none of the three controls is installed on a host, and no deploy file of theirs has run on Linux. The decisions and limits are recorded at the end. It complements `2026-11-14-host-permission-agent-design.md` (INF-226), which lists provider sandboxes as a non-goal.

## Intent

The host is moving decisions from the owner to a reviewer: a delegated coordinator today, a host permission agent next. Both vendors that publish such a reviewer also publish that it misses. One reports a 17% miss rate on real overeager actions in a sample of 52. The other reports 90.3% recall and says the reviewer "should not be treated as a guarantee of security". Both say the reviewer is safe to use because a boundary sits under it that the agent cannot change.

Infinite has the reviewer and not the boundary. On the Ubuntu host today:

- An agent session can start a provider with any flag its configured profile carries, and a project file can loosen provider settings. No root-owned policy sets a ceiling.
- An agent can open a connection to any address, including the cloud metadata address and private ranges.
- The agent account can read the GitHub App installation token. That token can write contents and pull requests in every configured repository, push any ref, and merge any pull request.

This design adds three controls under the reviewer. Each one holds when the reviewer is wrong, and none of them depends on a model.

### The rule

**A control counts as part of the boundary only when the agent account cannot change it.** A prompt, a hook the agent's project can replace, a setting in the agent's home directory, and an environment variable are not boundary. A root-owned file, another account's process, and a firewall rule on the agent's user id are.

## Current state

Observed on `main` and in the deploy template at the time of writing. The live host was not inspected for this design.

- **Launch.** The host passes hooks to Claude Code through `--settings`, MCP servers through `--mcp-config`, and role limits through `--allowedTools`, `--tools`, and `--permission-mode` (`packages/host/src/launch.ts`). Codex gets `-c` overrides. The deploy template has no managed settings file and no `requirements.toml`.
- **Network.** `deploy/ubuntu/` has no outbound rule, proxy, or proxy variable. The firewall notes cover inbound traffic only. `infinite.sudoers` keeps no proxy variable.
- **GitHub.** A root timer mints installation tokens into a cache the agent account's group can read (`scripts/github-app-refresh.mjs`). A Git credential helper and a `gh` wrapper hand the token to the caller (`scripts/github-app-client.mjs`, `deploy/ubuntu/github-app-gh.sh`). The host checks that a delivery report names the reviewed head and repository; it does not check the remote operation (`docs/teams.md`).
- **Accounts.** One agent account runs every provider session of every project.

## Goals

1. A root-owned ceiling for each provider that turns off the modes that skip permission checks, with a `doctor` check that reports a missing, changed, or agent-writable ceiling.
2. Agent traffic goes through a host proxy that attributes each connection to a project, refuses metadata and private addresses always, and can refuse unlisted hosts.
3. The agent account cannot read a GitHub token. Each session holds a host-made grant for one repository, a set of operations, and the refs it may push.
4. Every control is off until configured, ships with a runbook, and has a rollback at each step.

## Non-goals

- Per-run file confinement or one account per project. It is the fourth part of the boundary and needs its own design.
- Content inspection of agent traffic. The proxy sees host names and ports.
- Replacing GitHub branch protection. The base branch stays protected on GitHub.
- Moving host hooks, MCP servers, or permission rules into managed policy. Each needs a test on the real host first; see Part 1.
- Installing anything. Every install step is a root step for the owner.

## Design

### Part 1. Provider ceilings (INF-231)

Two files, installed as `root:root` and not writable by anyone else:

- Claude Code managed settings (`/etc/claude-code/managed-settings.json` on Linux): bypass-permissions mode off; auto mode off, because the host's own permission flow decides and the provider must not approve by itself; `deny` rules for reading the host's credential locations.
- Codex requirements (`/etc/codex/requirements.toml`): only the read-only and workspace-write sandbox modes.

**What the default ceiling does not set, and why.** The host's own launch path uses the same channels a stricter policy would close:

| Policy | Effect on the host today | Test needed before it is set |
|---|---|---|
| Managed hooks only | Likely drops the host's `--settings` hooks, so the host loses prompts and transcripts. | A marker hook in the managed file fires, and the host hooks are moved there. |
| Managed permission rules only | Makes `--allowedTools` inert, so the mission coordinator and permission reviewer lose their tool limits. | The role limits are moved into managed rules and a coordinator run passes. |
| Managed MCP only, or side-load flags off | Blocks the host's `--mcp-config` report tools. | The report servers are listed in the managed allowlist and a member reports. |

A `Read` deny rule does not stop a shell command from reading a file the account can read. File modes and Part 3 are the control for credentials. The ceiling's job is the mode switches.

**Install and check.** `deploy/ubuntu/install-ceilings.sh` installs both files, keeps a copy of what it replaces, prints each SHA-256, and has a `--check` mode. `infinite doctor` reports, per provider: the file exists; it and its parent are root-owned and not group- or world-writable; its hash equals the template of the running release; and no configured launch profile carries a flag the ceiling forbids. A missing ceiling is a warning, since development machines have none.

### Part 2. Agent egress (INF-232)

**Proxy.** A dependency-free Node process under its own account, on a loopback port, restarted by systemd. It handles `CONNECT` tunnels and plain HTTP. It does not intercept TLS.

**Identity.** The host gives each session proxy credentials in `HTTPS_PROXY`: a user name that carries the project and session, and an expiring HMAC made with a key that only the host and proxy accounts can read. The proxy verifies it without shared state. So every record names a project, and a policy can differ per project.

**Always refused.** Loopback, link-local (the cloud metadata address is here), private ranges, the carrier-grade NAT range, multicast, and their IPv6 forms. The proxy resolves a name once and connects to the address it checked. An `allowPrivate` list of exact `host:port` entries is the only exception.

**Modes.** `observe` allows every other destination and records an unlisted host as `would-deny`. `enforce` refuses it. The owner runs `observe` first, reads the per-project summary (`GET /api/egress`, `infinite egress`), builds the allowlist from real traffic, then switches.

**Firewall.** An nftables rule on the agent account's user id logs (observe) or rejects (enforce) traffic that is not to loopback. With the rule in enforce mode, a tool that ignores proxy variables fails instead of leaking.

**Limits, stated plainly.** No content inspection: an allowed host can receive anything. A tool that resolves names itself still reaches the local resolver, so DNS remains a narrow channel. Loopback services stay reachable. If the proxy is down, agents lose the network and the host API does not.

### Part 3. The GitHub credential proxy (INF-233)

**Grant.** `v1.<payload>.<mac>`. The payload names a subject, a session, one repository, operations (`fetch`, `push`, `pr`, `merge`), the refs `push` may write, and an expiry of at most 24 hours. The MAC uses a key that only the host and proxy accounts can read. The host mints; the proxy verifies.

**Who gets what.**

| Session | Grant |
|---|---|
| Ordinary team member | `fetch` |
| The role that delivers | `fetch`, `push` to that run's head branch, `pr`, and `merge` only when the run's delivery policy is merge |
| Mission coordinator, permission reviewer | none |
| A session the owner started directly | `fetch`, `push` on branches, `pr`, `merge` |
| Host-run Git | the one operation it is doing |
| A project with no GitHub repository | none |

**Git.** The proxy serves Git smart HTTP on loopback and forwards to GitHub with the token. On a push it parses the command list before it forwards a byte: every ref must match the grant, a delete is refused, and a ref outside `refs/heads/` is refused unless the grant names it. The agent account reaches the proxy through a URL rewrite and a credential helper that returns the grant from the environment.

**`gh`.** The same service runs the real `gh` under the proxy account for a strict allowlist: `pr create`, `pr view`, `pr list`, `pr checks`, `pr ready`, `pr comment`, and `pr merge`. It always sets the repository from the grant. `pr merge` requires the reviewed head commit and the `merge` operation, and refuses admin merges. Every flag that reads a file, opens an editor, or opens a browser is refused.

**The switch.** The proxy runs beside the current path until the owner verifies a fetch, a refused push, an allowed push, and a pull request through it. Then the token cache's group changes so the agent account cannot read it. `doctor` reports whether the agent account can still read the cache, because that defeats the proxy.

**Limits.** A session with `push` can still push bad code to its own branch; review and checks handle that. Branch protection on the base branch stays necessary. A one-hour token still exists in the proxy account.

## Authority and safety

- **Fail closed.** A proxy with no valid policy refuses everything. A grant that does not verify is refused. A host that cannot read its key gives sessions no credentials, so they have no network path and no GitHub path, and `doctor` says why.
- **No secrets to agents.** The HMAC keys and the GitHub token are never passed to a session. A session holds only its own short-lived credentials.
- **Records.** Both proxies write one line per request with the project, session, target, and decision. Neither logs a token, a grant, a URL path, or a header.
- **The reviewer is unchanged.** These controls sit under the permission flow. They decide nothing about a prompt, and they approve nothing.
- **Honesty.** The proxy records what was allowed or refused. It does not record that work completed.

## Failure modes

| Failure | Behaviour |
|---|---|
| A ceiling file is edited or removed | `doctor` reports `changed` or `missing`. Providers read whatever is there; the file modes are the protection. |
| A launch profile carries a forbidden flag | `doctor` reports `conflict`. The provider refuses or clamps the flag. |
| The egress proxy is down | Agent connections fail. Sessions report network errors. The host API and the owner's clients keep working. |
| The egress policy fails to parse | The last good policy stays. With none, everything is refused. |
| A name resolves to a private address | Refused in both modes. |
| The GitHub proxy is down | Fetch, push, and `gh` fail for agents. The host reports the Git failure as it does today. |
| A grant expires during a long run | The next operation is refused. The host mints a new grant with the next session or host operation. |
| The token cache is still agent-readable after the switch | `doctor` reports it. The proxy still works; the boundary does not hold. |

## Rollout order

All root steps are the owner's. Each has a rollback in its runbook.

1. Ceilings: install, run `doctor`, run one team member of each provider.
2. Egress in `observe`: install the proxy and the logging rule, set the host config, run for a period, read the summary.
3. GitHub proxy beside the current path: install, set the host config, verify the four operations.
4. Egress `enforce`, after the allowlist covers observed traffic.
5. Token cache group change, after the proxy path is verified. The owner's root-owned team Git launcher must pass the grant variables and the proxy helper first.

## Acceptance

1. With the ceilings installed, `doctor` reports both as present and matching, and reports `changed` after one byte of either file changes.
2. A session started with a bypass flag in its profile is reported as a `conflict` by `doctor`.
3. In `observe`, a session's request to an unlisted host succeeds and appears as `would-deny` under its project. In `enforce`, it gets 403.
4. A request to the metadata address is refused in both modes.
5. A team member's fetch through the GitHub proxy succeeds, and its push is refused.
6. The delivering role's push to its run head succeeds byte-for-byte, and its push to the base branch, a tag, or a delete is refused before any upstream request.
7. `gh pr merge` without the reviewed head commit, or without the `merge` operation, is refused.
8. With either config block absent, every session environment is what it is today.

## Owner decisions

The owner approved the direction on 2026-11-14 and, the same day, told the builder to settle the open decisions by its own recommendations. The calls below stand on that delegation. The owner reviewed none of them one by one, and each stays open to change:

1. The default ceiling turns off Claude Code's auto mode. If the owner wants the provider's own classifier for some roles, that key is removed and the reason recorded.
2. Unlisted egress is refused in `enforce`, and listed in the summary in `observe`. There is no "ask the owner per host" prompt.
3. A session the owner started directly gets a full grant for its project's repository.
4. The mission coordinator and the permission reviewer get no GitHub access.
5. The `gh` allowlist is the seven commands above. `gh api` is refused.
6. Managed hooks, managed permission rules, and managed MCP stay off until their tests pass on the real host.
7. The first release installs none of the three controls. The code ships with `autonomy.boundary` absent, and a session's environment stays what it was. Each control is installed on its own, in the rollout order above, after its host checks pass on the real host.
8. The ceilings wait for the host permission agent. They move every bypass-mode session to the provider's default mode, and until an agent answers those prompts, each one waits for the owner.
9. The egress proxy starts in `observe`. `enforce` waits until briefing and code-graph launches carry the proxy variables, because their network calls would otherwise fail.
10. The GitHub token switch waits until the owner names the `gh` commands and the Git LFS use they need. After the switch, an owner session loses `gh api`, `gh run`, `gh issue`, and LFS, and the boundary holds only one hour later, when the old tokens have expired.
11. The ceiling template names the first instance's secret paths only. A host that runs a second instance adds that instance's paths to the installed file before relying on it.

Known limits at the first release:

- No deploy file of the three controls (firewall rule, service units, account and ACL commands) has run on a Linux host. Each was checked by tests and review on the build machine only.
- The ceilings flag check does not read a Codex permission-profile selection.

## Left to the builder

- Which Codex requirements key applies to the installed Codex version.
- How the host maps a session to its repository, role, delivery policy, and head branch for a grant.
- Whether the proxies take a systemd socket or bind the port themselves.
