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

A grant names one project, one repository, a list of operations (`fetch`,
`push`, `pr`, `merge`), the refs a push may update, and an expiry. The host signs
it with HMAC-SHA256 using a key that only the host account and the proxy account
can read. The proxy refuses an unsigned, altered, expired, or unknown-field grant,
and any grant format other than the current one (`v2`).

| Session | Repository | Operations | Push refs |
| --- | --- | --- | --- |
| Session the owner started (the owner-only create and resume routes, including the paired native CLI) | the project's GitHub repository | fetch, push, pr, merge | `refs/heads/*` |
| Any other session outside a team | the project's GitHub repository | fetch | none |
| Team delivery member | the run's delivery repository | fetch, push, pr (+ merge when delivery mode is `merge`) | the run's head branch only |
| Other team members | the run's repository | fetch | none |
| Mission and permission coordinators | none | none | none |
| Host mirror fetch | the project's repository | fetch | none, 15-minute grant |
| Host team head publication | the delivery repository, or the project's GitHub source | push | the one published ref, 15-minute grant |
| Host pull request read (review feedback, recorded branch lookup) | the run's delivery repository | pr | none, 15-minute grant |
| Host save of a member's unfinished work | the delivery repository, or the project's GitHub source | push | the one exact ref it pushes: `-wip-MEMBER`, or `-wip-MEMBER-COMMIT8` on a retry after a rejection; 15-minute grant |

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
  the grant. Every authenticated line names the grant's `project`, `sid`, and
  `sub`, so two projects that use one repository stay apart.

## Before you start

- Deploy a host release that contains INF-233. An older host refuses the
  `autonomy.boundary.github` configuration key.
- Find the group in `tokenGroupId` of `/etc/infinite-github/issuer.json`
  (`getent group GID`). The template uses the agent account's group,
  `infinite-agent`; substitute yours below.
- Pick a free loopback port. This runbook uses `8417`.
- Install the `acl` package (`getfacl`, `setfacl`). The proxy's `/health` reports
  the token cache as closed to the agent only after `/usr/bin/getfacl` finds no
  extended ACL on it; without `getfacl` it reports `unknown`.
- Check that `/srv`, `/srv/infinite-data`, and `/etc/infinite-github` are real
  directories (not links) owned by root and not writable by their group or
  others: `namei -l /srv/infinite-data/x /etc/infinite-github/x`. The host and
  the proxy refuse the grant key, and the proxy its configuration, under any
  other directory.
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

The host and the proxy apply one rule to the key: a regular file owned by root,
not writable by its group or others and not open to others, below real
directories owned by root and not writable by their group or others, with no
symbolic link on the way. Each opens the file without following a link and
checks and reads the open file. The host account's new group takes effect at its
next restart (step 4).

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
change; `UNSAFE (...)` names the file or directory that breaks the key rule.

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

## 6. Host Git and `gh` operations through the team launcher

The host fetches each GitHub-tracked mirror, publishes team heads, saves
members' unfinished work, and reads pull requests with `gh` (review feedback and
the recorded branch lookup) through `teams.commandPrefix`, which on the Ubuntu
deployment is a root-owned launcher outside this repository. Each operation now
carries a 15-minute host grant in `INFINITE_GITHUB_GRANT` for one repository
(and, for a push, one exact ref). sudo drops the `GIT_CONFIG_*` variables the
host also sets, so the launcher must:

1. keep `INFINITE_GITHUB_GRANT` and `INFINITE_GITHUB_PROXY` in the environment
   it gives Git and `gh`. Without the grant, the App client's `gh` falls back to
   the token cache, which step 7 removes;
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
`"sid":"publish:…"` and `"decision":"allow"`. With review feedback on, a run
waiting for review also shows `"sid":"review:…"` lines with
`"command":"pr view"`.

Rollback: restore the previous launcher. It keeps working until step 7.

## 7. Take the cache away from the agent account

Changing groups is not enough. An ACL entry on the token directory or a file can
give the agent account access that mode bits do not show, and a cached token that
is still valid is not rewritten by the renewal service, so it would keep any
access it had. This step removes every ACL and replaces every cached file.

The boundary does not hold when this step ends. It holds one hour after the
cutoff below, when every token minted before it has expired. See
[Wait out the old tokens](#wait-out-the-old-tokens).

Stop the renewal service first, so no token is minted while access changes and
the cutoff is one known moment:

```sh
sudo systemctl stop infinite-github-refresh.timer
sudo systemctl stop infinite-github-refresh.service
systemctl is-active infinite-github-refresh.service     # inactive
```

```sh
TOKENS=/srv/infinite-data/github-app-tokens
# Keep the current ACLs and ownership for rollback.
sudo sh -c "getfacl -R -p $TOKENS > /root/github-token-acl-before.txt"
# Point the renewal service at the proxy's group: set "tokenGroupId" in
# /etc/infinite-github/issuer.json to the number this prints.
getent group infinite-github-proxy | cut -d: -f3
# Remove every extended ACL entry, access and default, from the directory and everything in it.
sudo setfacl -b -k "$TOKENS"
sudo find "$TOKENS" -mindepth 1 -type d -exec setfacl -b -k {} +
sudo find "$TOKENS" -mindepth 1 -type f -exec setfacl -b {} +
sudo chgrp infinite-github-proxy "$TOKENS"
sudo chmod 0750 "$TOKENS"
date -u +%Y-%m-%dT%H:%M:%SZ     # the cutoff: write it down
```

From the cutoff on, the agent account cannot read the cache. Tokens it read
before the cutoff stay valid at GitHub until they expire, at most one hour after
they were minted. Revoke the ones the cache holds now. This shortens the
exposure for those tokens only; it does not end it. It reads each cached token
as root and sends it only in a request header, never in a command line:

```sh
sudo node --input-type=module -e '
import { readdirSync, readFileSync } from "node:fs";
const dir = "/srv/infinite-data/github-app-tokens";
for (const name of readdirSync(dir).filter(entry => /^[a-f0-9]{64}\.json$/.test(entry))) {
  const { token } = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
  const response = await fetch("https://api.github.com/installation/token", {
    method: "DELETE", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
  console.log(name.slice(0, 12), response.status);
}'
```

Each line should end in `204`. Then delete every cached file, so no file from
before the switch survives, and mint new ones:

```sh
sudo find "$TOKENS" -maxdepth 1 -type f -name '*.json' -delete
sudo systemctl start infinite-github-refresh.service
sudo systemctl status infinite-github-refresh.service --no-pager
sudo systemctl start infinite-github-refresh.timer
```

GitHub access through the proxy fails between the revocation and the end of the
refresh. The new files are owned by root, in the proxy's group, with mode `0640`
and no ACL, because the directory no longer has a default ACL.

End the transition and restart the proxy without the agent group:

```sh
sudo rm /etc/systemd/system/infinite-github-proxy.service.d/transition.conf
sudo systemctl daemon-reload
sudo systemctl restart infinite-github-proxy.service
```

Verify by reading, not by listing. Each of these must print nothing:

```sh
sudo getfacl -R -s -p "$TOKENS"
sudo -u infinite-agent test -x "$TOKENS" && echo "AGENT CAN ENTER $TOKENS"
sudo find "$TOKENS" -mindepth 1 -maxdepth 1 -type f -exec sh -c '
  for file; do sudo -u infinite-agent head -c 1 "$file" >/dev/null 2>&1 && echo "AGENT CAN READ $file"; done' sh {} +
```

The last command tries to read one byte of every token file by its full name as
the agent account and discards it. It runs in any POSIX shell; a loop over
`read -d ''` fails in `dash`, which `sh` is on Ubuntu, and then prints nothing
for a readable file. Then:

```sh
curl -s http://127.0.0.1:8417/health
sudo -H -u infinite-host /usr/local/bin/infinite doctor --config /etc/infinite/config.json
```

Expect `"tokenCache":"proxy-only"` and `token cache not readable by the agent
account`. The proxy says `proxy-only` only when mode bits and group membership
deny the agent account and `getfacl` finds no extended ACL on the directory or on
any entry in it. An ACL, a missing or failing `getfacl`, or an unreadable
directory makes it `unknown`, which `doctor` prints as `UNKNOWN`. Repeat the
checks from steps 5 and 6.

### Wait out the old tokens

The checks above show that the agent account cannot read the cache. They do not
show that it holds no token. The renewal service replaces a token 15 minutes
before it expires and does not revoke the one it replaces, and GitHub's
revocation request ends only the token that authenticates it. A token the agent
account copied before the cutoff, and that the cache had already replaced, was
therefore not revoked above, and nothing on this host can revoke it. Used
directly against GitHub, it skips the proxy's branch and API limits.

Every such token was minted before the cutoff, so the last one expires at most
one hour after it. Until then:

- Treat the agent account as still holding an unrestricted token for every
  enrolled repository. `"tokenCache":"proxy-only"` describes file access only.
- Do not start work that relies on the proxy's limits, and do not report the
  boundary as on.

One hour after the cutoff, repeat the three read checks and the `/health` check.
The boundary holds from then on. Any later step that gives the agent account
access to the cache again, including the rollback below, starts a new cutoff
when it is undone.

After this step the App credential helper for `https://github.com` in the agent
account's config can no longer read the cache. Remove it, so other public
repositories clone anonymously.

The read-only `gh` calls of the System tab run as the host account with that
account's own GitHub CLI login, not the token cache. This step does not change
them.

Rollback (do this before undoing steps 5 or 6): set `tokenGroupId` back to the
agent group's id, give the directory and its files back to that group, rerun the
renewal service, and restore the transition drop-in:

```sh
sudo chgrp infinite-agent "$TOKENS"
sudo find "$TOKENS" -maxdepth 1 -type f -name '*.json' -exec chgrp infinite-agent {} +
sudo systemctl start infinite-github-refresh.service
printf '[Service]\nSupplementaryGroups=infinite-agent\n' |
  sudo tee /etc/systemd/system/infinite-github-proxy.service.d/transition.conf
sudo systemctl daemon-reload && sudo systemctl restart infinite-github-proxy.service
```

If `/root/github-token-acl-before.txt` lists ACL entries the deployment relied
on, restore them with `sudo setfacl --restore=/root/github-token-acl-before.txt`.

## Operate

- The proxy restarts on failure. While it is down, agents and host Git
  operations cannot reach GitHub; delivery waits and nothing falls back to the
  cache.
- Rotate the grant key by installing a new key file with the same owner, mode,
  and directory, then restarting the proxy. The host reads the key for every grant it
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
- `/health` rules out ACLs only on the token directory and its entries, and reads
  group membership from `/etc/passwd` and `/etc/group`; groups from another
  directory service are not seen.
- Rehearsed, not deployed. On 2026-11-15, the steps of
  [github-app.md](github-app.md) and then steps 1 to 5 and 7 here ran as written on
  Ubuntu 24.04 (an arm64 container, gh 2.45), against a stand-in GitHub API with a
  throwaway certificate authority. These passed: the clone, a push to the
  session's own branch, the refusal to push a tag or delete a branch, the
  delivery and member grants, the refusal without a grant, `gh pr list` through
  the broker, the refusal of `gh api` and `gh run`, host Git with a `host` grant,
  `"tokenCache":"proxy-only"` after step 7, and a timer-started refresh.
  Step 6, the team launcher, did not run. Read `/health` and `doctor` on the
  server.
