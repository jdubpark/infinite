# GitHub credential proxy

The proxy takes GitHub App installation tokens away from the agent account.
Today the [renewal service](github-app.md) writes one-hour tokens into a cache
that `infinite-agent` can read, so any agent session can push any branch and
merge any pull request in every repository the App is installed on. With the
proxy, the cache is readable only by the proxy's own account. Sessions receive a
host-signed grant instead, and the proxy checks every request against it before
it adds the token.

Nothing changes until the owner configures it. Every step below is a root
operation on the server; this repository installs nothing.

## What a grant allows

A grant names one repository, a list of operations (`fetch`, `push`, `pr`,
`merge`), the refs a push may update, and an expiry. The host signs it with
HMAC-SHA256 using a key that only the host account and the proxy account can
read. The proxy refuses an unsigned, altered, expired, or unknown-field grant.

| Session | Repository | Operations | Push refs |
| --- | --- | --- | --- |
| Owner-started session | the project's GitHub repository | fetch, push, pr, merge | `refs/heads/*` |
| Team delivery member | the run's delivery repository | fetch, push, pr (+ merge when delivery mode is `merge`) | the run's head branch only |
| Other team members | the run's repository | fetch | none |
| Mission and permission coordinators | none | none | none |
| Host mirror fetch | the project's repository | fetch | none, 15-minute grant |
| Host team head publication | the delivery repository | push | the one published ref, 15-minute grant |

The project repository is the GitHub source of a GitHub-tracked project, or the
team delivery repository otherwise. A project with neither gets no grant.

The proxy enforces these rules on every request:

- Git smart HTTP only (`info/refs`, `git-upload-pack`, `git-receive-pack`) for
  the granted repository. Fetch needs `fetch`; push needs `push` and refs.
- A push may create or update only granted branches under `refs/heads/`. Tags,
  other ref namespaces, and deletions are refused. Git shows the refusal as
  `! [remote rejected] REF (Infinite GitHub proxy: REASON)`.
- `gh` reaches GitHub only through the proxy's `POST /gh` broker, and only for
  `gh pr create|view|list|checks|ready|comment|merge` with an allowlist of
  flags. The broker sets `--repo` from the grant. `create`, `ready`, `comment`,
  and `merge` act only on a pull request whose head branch is in the granted
  repository and covered by the grant's refs. A merge needs `merge`,
  `--match-head-commit`, and one of `--merge`, `--squash`, `--rebase`; `--admin`,
  `--auto`, and `--delete-branch` are refused. `gh api`, `gh run`, `gh issue`,
  and every other command are refused.
- The agent never sees the installation token. The proxy strips the client's
  `Authorization`, refuses GitHub redirects, and redacts the token from `gh`
  output. Each request writes one JSON line to the journal without the token or
  the grant.

## Before you start

- Deploy a host release that contains INF-233. An older host refuses the
  `autonomy.boundary.github` configuration key.
- Find the group in `tokenGroupId` of `/etc/infinite-github/issuer.json`
  (`getent group GID`). The template uses the agent account's group,
  `infinite-agent`; substitute yours below.
- Pick a free loopback port. This runbook uses `8417`.
- List the GitHub owners (users or organizations) whose repositories the App is
  installed on. The examples use `OWNER`.
- Remove every other GitHub credential from the agent account: SSH keys known to
  GitHub, a `gh` login, personal tokens in Git config or credential stores. The
  proxy cannot bound a credential it does not hold.

## 1. Accounts and grant key

```sh
sudo groupadd --system infinite-github-grant
sudo useradd --system --user-group --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin infinite-github-proxy
sudo usermod --append --groups infinite-github-grant infinite-host
sudo install -d -o root -g infinite-github-grant -m 0750 /srv/infinite-data/github-grant
sudo sh -c 'umask 0277 && openssl rand -hex 32 > /srv/infinite-data/github-grant/grant.key'
sudo chown root:infinite-github-grant /srv/infinite-data/github-grant/grant.key
sudo chmod 0440 /srv/infinite-data/github-grant/grant.key
```

Never add `infinite-agent` to `infinite-github-grant`: anyone who reads the key
can sign grants. Confirm that the agent account cannot read it and that the proxy
account can reach the token directory's parent:

```sh
sudo -u infinite-agent cat /srv/infinite-data/github-grant/grant.key   # must fail
sudo -u infinite-github-proxy test -x /srv/infinite-data && echo traversable
```

The host and the proxy both refuse a key file that is group-writable or open to
other users. The host account's new group takes effect at its next restart
(step 4).

Rollback: `sudo userdel infinite-github-proxy`, `sudo groupdel
infinite-github-grant`, and remove `/srv/infinite-data/github-grant`.

## 2. Install the proxy

Install `scripts/github-proxy.mjs` and the updated
`scripts/github-app-client.mjs` from the same release into
`/opt/infinite-github-auth`, owned by root with mode `0644`. Create
`/etc/infinite-github/proxy.json`, owned by root with mode `0644`:

```json
{
  "listen": { "host": "127.0.0.1", "port": 8417 },
  "grantKeyFile": "/srv/infinite-data/github-grant/grant.key",
  "tokenDirectory": "/srv/infinite-data/github-app-tokens",
  "githubCli": "/usr/bin/gh",
  "agentUser": "infinite-agent"
}
```

An optional `repositories` list limits the proxy to those repositories.
`agentUser` lets `/health` report whether that account can still read the token
cache.

Until step 6 the cache belongs to the agent group, so give the proxy that group
for the transition only:

```sh
sudo install -d -m 0755 /etc/systemd/system/infinite-github-proxy.service.d
printf '[Service]\nSupplementaryGroups=infinite-agent\n' |
  sudo tee /etc/systemd/system/infinite-github-proxy.service.d/transition.conf
# from this directory of the release:
sudo install -o root -g root -m 0644 infinite-github-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now infinite-github-proxy.service
curl -s http://127.0.0.1:8417/health
```

Expect `{"ok":true,"grantKey":"loaded","tokenCache":"agent-readable"}`. Nothing
uses the proxy yet.

Rollback: `sudo systemctl disable --now infinite-github-proxy.service`, then
remove the unit and its drop-in directory.

## 3. Client configuration and sudo

Add `"proxyUrl": "http://127.0.0.1:8417"` to `/etc/infinite-github/client.json`.
The client then answers the proxy's credential requests with the session's grant
and sends `gh` commands to the broker when a grant is present. Without a grant
it behaves as before.

Install the updated `infinite.sudoers` after `visudo -cf`. Its new `env_keep`
line carries `INFINITE_GITHUB_GRANT` and `INFINITE_GITHUB_PROXY` through sudo to
the agent wrappers and the team launcher.

Rollback: remove `proxyUrl`; the old sudoers file is harmless to keep.

## 4. Host configuration

Add the boundary to `/etc/infinite/config.json`:

```json
{
  "autonomy": {
    "boundary": {
      "github": {
        "proxyUrl": "http://127.0.0.1:8417",
        "keyPath": "/srv/infinite-data/github-grant/grant.key"
      }
    }
  }
}
```

Merge it into the existing `autonomy` block, then restart the API service (or
activate the release that contains INF-233). Running workers keep their old
environment; only sessions started after the restart get a grant.

```sh
sudo -H -u infinite-host /usr/local/bin/infinite doctor --config /etc/infinite/config.json
```

Expect `GitHub proxy: http://127.0.0.1:8417 reachable · grant key readable ·
token cache READABLE by the agent account, which bypasses the proxy`. A key
reported as `UNREADABLE` usually means the API started before step 1's group
change.

From now on `gh` in a new session goes through the broker. Start an owner
session in a GitHub-tracked project and run `gh pr list`. The journal
(`journalctl -u infinite-github-proxy`) shows a line with `"command":"pr list"`
and `"decision":"allow"`.

Rollback: remove `autonomy.boundary.github` and restart the API. New sessions
then get no grant and `gh` reads the cache again.

## 5. Route agent Git through the proxy

Append these sections to the end of the agent account's global Git config
(`/srv/infinite-data/agent-home/.gitconfig` in the template), one `url` section
per GitHub owner. They must come after every other credential helper: the empty
`helper =` clears helpers collected before it, so no other helper answers the
proxy.

```ini
[url "http://127.0.0.1:8417/OWNER/"]
	insteadOf = https://github.com/OWNER/
	insteadOf = git@github.com:OWNER/
	insteadOf = ssh://git@github.com/OWNER/
[credential "http://127.0.0.1:8417"]
	helper =
	helper = "!/usr/local/bin/node /opt/infinite-github-auth/github-app-client.mjs --config /etc/infinite-github/client.json credential"
```

Rewriting only the App's owners keeps anonymous clones of other public
repositories working. Keep the helper value quoted; an unquoted `;` in a Git
config value starts a comment.

Sessions started before step 4 have no grant and lose GitHub Git access at this
step. Do it when they can be restarted.

Verify in a new session:

- `git fetch` in the project checkout succeeds.
- In an owner session, `git push origin HEAD:refs/tags/proxy-probe` fails with
  `ref-not-branch`. Push `HEAD:refs/heads/infinite/proxy-probe` (it succeeds),
  then `git push origin :refs/heads/infinite/proxy-probe` fails with
  `delete-refused`. Delete the probe branch on GitHub afterwards.
- In a team member session other than delivery, any push fails with HTTP 403;
  the proxy journal names the reason, `push-not-granted`. Refusals before a push
  starts (repository, operation, grant) reach Git only as an HTTP status, so
  read the reason in the journal.
- In a delivery session, a push to its own head branch succeeds and a push to
  the base branch fails with `ref-not-granted`.
- `gh pr merge NUMBER --squash --match-head-commit SHA` for a pull request whose
  head is not the session's branch fails with `head-not-granted`.

Rollback: delete the appended sections. Git then uses the cache directly again.

## 6. Host Git operations through the team launcher

The host fetches each GitHub-tracked mirror and publishes team heads through
`teams.commandPrefix`, which on the Ubuntu deployment is a root-owned launcher
outside this repository. Each operation now carries a 15-minute host grant in
`INFINITE_GITHUB_GRANT` for one repository (and, for a push, one exact ref).
sudo drops the `GIT_CONFIG_*` variables the host also sets, so the launcher
must:

1. keep `INFINITE_GITHUB_GRANT` and `INFINITE_GITHUB_PROXY` in the environment
   it gives Git;
2. rewrite GitHub to the proxy and answer the proxy with the grant, for example
   by adding these settings after its own credential settings:

   ```text
   -c url.http://127.0.0.1:8417/.insteadOf=https://github.com/
   -c credential.http://127.0.0.1:8417.helper=
   -c credential.http://127.0.0.1:8417.helper=!/usr/local/bin/node /opt/infinite-github-auth/github-app-client.mjs --config /etc/infinite-github/client.json credential
   ```

A launcher that already passes the App client as a generic `credential.helper`
(not one scoped to `https://github.com`), after an empty reset entry, needs just
the variables and the `url` rewrite: the same client answers the proxy origin
with the grant. Record the launcher's new hash with the release.

Verify: run a project source refresh and let a team run publish its head. The
proxy journal shows `"sub":"host"` lines with `"sid":"source:…"` and
`"sid":"publish:…"` and `"decision":"allow"`.

Rollback: restore the previous launcher. It keeps working until step 7.

## 7. Take the cache away from the agent account

```sh
GID=$(getent group infinite-github-proxy | cut -d: -f3)
# Set "tokenGroupId" in /etc/infinite-github/issuer.json to $GID, then:
sudo chgrp infinite-github-proxy /srv/infinite-data/github-app-tokens \
  /srv/infinite-data/github-app-tokens/*.json
sudo systemctl start infinite-github-refresh.service
sudo systemctl status infinite-github-refresh.service --no-pager
```

Change the existing files' group too: the renewal service refuses a cache file
whose group differs from `tokenGroupId` (`cache-permissions`). It sets the
directory group itself on each run.

Then end the transition and restart the proxy without the agent group:

```sh
sudo rm /etc/systemd/system/infinite-github-proxy.service.d/transition.conf
sudo systemctl daemon-reload
sudo systemctl restart infinite-github-proxy.service
curl -s http://127.0.0.1:8417/health
sudo -u infinite-agent ls /srv/infinite-data/github-app-tokens   # must fail
sudo -H -u infinite-host /usr/local/bin/infinite doctor --config /etc/infinite/config.json
```

Expect `"tokenCache":"proxy-only"` and `token cache not readable by the agent
account`. `/health` reads mode bits and group membership only; if the token
directory carries ACLs, check them with `getfacl`. Repeat the checks from steps
5 and 6.

After this step the App credential helper for `https://github.com` in the agent
account's config can no longer read the cache. Remove it, so other public
repositories clone anonymously.

The read-only `gh` calls of the System tab run as the host account with that
account's own GitHub CLI login, not the token cache. This step does not change
them.

Rollback (do this before undoing steps 5 or 6): set `tokenGroupId` back to the
agent group's id, `chgrp` the directory and files back, rerun the renewal
service, and restore the transition drop-in.

## Operate

- The proxy restarts on failure. While it is down, agents and host Git
  operations cannot reach GitHub; delivery waits and nothing falls back to the
  cache.
- Rotate the grant key by installing a new key file with the same owner and
  mode, then restarting the proxy. The host reads the key for every grant it
  signs. Grants signed with the old key stop working, so restart running
  sessions.
- A second instance needs its own key, proxy account, port, unit name, and
  token directory. Do not share a grant key between instances.

## Limits

- A push grant can still push any content, including a force push, to its own
  branches. Base-branch protection on GitHub stays necessary.
- The proxy account holds one-hour installation tokens for every repository in
  the cache. A compromise of that account is a compromise of those tokens.
- Sessions share the `infinite-agent` Unix account, so one session can read
  another session's grant from its process environment. A grant is bounded and
  expiring, but this is not isolation between sessions.
- A session grant lasts at most 24 hours. A session that runs longer loses
  GitHub access until it is restarted.
- One session reaches one repository. An owner session cannot push to or fetch
  private repositories other than its project's through the proxy.
- `gh api`, `gh run`, `gh issue`, Git LFS, and other commands outside the
  allowlist are unavailable to agents. Pushes with unknown protocol capabilities,
  push certificates, or non-ASCII ref names are refused.
- Codex members run with networking off and reach neither GitHub nor the proxy.
