# Unattended GitHub access

Use a private GitHub App for autonomous delivery. The server keeps its private
key and renews installation tokens without a laptop connection. Each token is
limited to one configured repository. A timer checks every five minutes and
renews tokens with less than fifteen minutes remaining.

GitHub App private keys have no automatic expiration. Installation tokens expire
after one hour; the renewal service handles that lifetime. This supports ongoing
operation beyond a year without a yearlong bearer token. Revocation, removal of
a repository from the installation, or a failed renewal can still block access.
See GitHub's [private-key guidance](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
and [installation-token contract](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## One-time owner setup

Register a private GitHub App with these repository permissions:

| Permission | Access |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Actions, Checks, Commit statuses, Metadata | Read |

Keep webhooks, user OAuth, and account or organization permissions disabled.
Install the app on **Only select repositories**, then select the repositories
approved for delivery. This does not authorize changing workflow definitions,
repository settings, secrets, or branch protections.

Generate one app private key and transfer it privately to the server's encrypted
storage. Keep the key and issuer configuration owned by root with mode `0600`,
inside a root-only directory. Do not put the key in a checkout, agent home,
prompt, environment variable, or Git remote URL. Adding another repository needs
an owner-approved installation change and a server configuration entry; it does
not need another personal token or private key.

## Server configuration

Install the two scripts from `scripts/github-app-*.mjs` in
`/opt/infinite-github-auth`, owned by root and not writable by agents. Create
`/srv/infinite-data/github-app-tokens` owned by root, with the agent account's
group and mode `0750`. Only short-lived tokens belong in this directory.

Create `/etc/infinite-github` owned by root with mode `0755`, then create
`issuer.json` in that directory with mode `0600`. Replace the
example IDs and group ID with the app, installation, repository, and agent group:

```json
{
  "appId": "12345",
  "privateKeyFile": "/srv/infinite-data/github-app/private-key.pem",
  "tokenDirectory": "/srv/infinite-data/github-app-tokens",
  "tokenGroupId": 1001,
  "repositories": [
    {
      "repository": "example/product",
      "repositoryId": 23456,
      "installationId": 34567
    }
  ]
}
```

Create the non-secret `/etc/infinite-github/client.json`, owned by root with
mode `0644`:

```json
{
  "tokenDirectory": "/srv/infinite-data/github-app-tokens",
  "githubCli": "/usr/bin/gh",
  "repositories": ["example/product"]
}
```

Install `infinite-github-refresh.service` and `infinite-github-refresh.timer` from
this directory into `/etc/systemd/system`. Run the service once before enabling
the timer. A failed refresh preserves the prior cache; the client refuses it
when expired. Service errors omit tokens, JWTs, keys, and GitHub response bodies.

```sh
systemctl daemon-reload
systemctl start infinite-github-refresh.service
systemctl enable --now infinite-github-refresh.timer
```

Install `github-app-gh.sh` as `/usr/local/bin/gh`, owned by root with mode `0755`.
The wrapper applies only to the template's `infinite-agent` account and delegates
to `/usr/bin/gh` for other accounts. Adjust that account name when using another
execution identity. Preserve any existing wrapper before installation; do not
overwrite an unrelated command.

For the agent account, set `credential.https://github.com.useHttpPath=true`.
Make the following the first helper after the GitHub helper-reset entry, followed
by the account's existing GitHub helper:

```text
!/usr/local/bin/node /opt/infinite-github-auth/github-app-client.mjs --config /etc/infinite-github/client.json credential
```

If the existing helper uses GitHub CLI, pin it to
`!/usr/bin/gh auth git-credential`. Calling the new `gh` wrapper here can recurse
or select the checkout's repository instead of the credential request's target.

The helper uses Git's repository path to select the token. For configured
repositories, an invalid cache stops the credential chain instead of falling
back to a personal credential. Other repositories keep their existing helpers.
The GitHub CLI wrapper selects the repository from explicit arguments or the
checkout's GitHub origin. Conflicting targets and non-GitHub destinations cannot
receive an app token. It does not retry failed mutations using another identity.

## Verify and operate

Run the status command as the agent account. It reports expiry without exposing
the credential:

```sh
node /opt/infinite-github-auth/github-app-client.mjs \
  --config /etc/infinite-github/client.json status example/product
systemctl status infinite-github-refresh.timer
```

Verify Git fetch, PR metadata, and exact-head check/status reads using the agent
identity. Then use the next authorized, independently reviewed change to verify
branch publication, PR creation, and guarded merge. A successful token refresh,
read request, or dry-run push does not establish successful delivery.

Enable automatic merging once for the enrolled repository with
`infinite repo init --delivery merge`. Provider permissions and branch protections
remain in force. Record the confirmed PR and merge commit in Linear; do not
equate merge with deployment or product-goal completion.

To rotate the durable key, generate a replacement, install it privately, and
verify a fresh token before revoking the old key. Removing repository access in
GitHub and removing its server entries stops future renewal. Remove its cached
token as part of that owner operation. Agent accounts sharing a Unix identity
can read that identity's token files; this is repository-scoped GitHub authority,
not filesystem isolation between agents or projects.
