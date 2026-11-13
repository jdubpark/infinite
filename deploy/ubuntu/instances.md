# Commission a second instance

This runbook adds one separately addressed Infinite service to the encrypted
host. It keeps its accounts, group, unit, configuration, run directory, vault
key, wrapper directory, sudoers policy, token cache, and release pointer
separate from the first instance. Instance-owned persistent data lives under
`/srv/infinite-data/instances/NAME/`; the first instance stays at its existing
paths.

Run the commands as an administrator with root access. The example name is
`work`. Choose another name only if it follows the naming rules below and has
not already been used. Keep one shell open for the command blocks; set
`NAME=work` again when starting a new shell.

## Names

`NAME` must match `[a-z][a-z0-9-]{0,15}`. The generated identifiers derive
from it:

| Thing | First instance | Instance `work` |
| --- | --- | --- |
| API account | `infinite-host` | `infinite-work-host` |
| Agent account | `infinite-agent` | `infinite-work-agent` |
| Workspace group | `infinite-workspace` | `infinite-work-workspace` |
| Unit | `infinite.service` | `infinite-work.service` |
| Config | `/etc/infinite/config.json` | `/etc/infinite-work/config.json` |
| Run directory | `/run/infinite` | `/run/infinite-work` |
| Vault key | `/run/infinite-key/vault.key` | `/run/infinite-work-key/vault.key` |
| Wrappers | `/usr/local/libexec/infinite/` | `/usr/local/libexec/infinite-work/` |
| Sudoers | `/etc/sudoers.d/infinite` | `/etc/sudoers.d/infinite-work` |
| Release pointer | `/opt/infinite` | `/opt/infinite-work` |
| Data root | `/srv/infinite-data/` | `/srv/infinite-data/instances/work/` |

The data root holds `control`, `control-home`, `agent-home`, `workspaces`,
`team-workspaces`, `tmp/control`, `tmp/agent`, and `agents` (the provider tools
prefix). The first instance's accounts belong to none of the new groups, and
the new accounts belong to none of the first instance's groups. The name limit
keeps socket paths below the Unix socket path limit.

Shared, read-only: root-owned release directories, the Node runtime, the
existing relay, and the host storage watchdog. Never share the vault key, device
keys, API port, writable provider tools prefix, provider homes or logins,
Linear key, Slack tokens, GitHub credential, connector logins, temporary
directories, team workspace root, knowledge service, or memory adapter.

These names are reserved because they can collide with existing service
identifiers:

| Reserved name | Reason |
| --- | --- |
| `agent`, `agents`, `host`, `key` | Identity and runtime components |
| `github`, `github-auth` | GitHub credential service components |
| `relay` | Relay service |
| `workspace`, `data` | Workspace and storage paths |
| `build`, `brain`, `backup` | Host service components |

The renderer refuses invalid and reserved names with exit status 64. Keep the
same name for the accounts, service, generated files, config, and private DNS
entry.

## Accounts, group, and directories

Verify that `/srv/infinite-data` is the existing encrypted mount. Do not change
its ownership or recursively apply ACLs. Create the instance root so the agent
can traverse to its instance but cannot create a sibling:

```sh
NAME=work
sudo groupadd --system "infinite-$NAME-workspace"
sudo install -d -o root -g root -m 0711 /srv/infinite-data/instances
sudo install -d -o root -g "infinite-$NAME-workspace" -m 0750 \
  "/srv/infinite-data/instances/$NAME"
sudo useradd --system --user-group --home-dir "/srv/infinite-data/instances/$NAME/control-home" \
  --create-home --shell /usr/sbin/nologin "infinite-$NAME-host"
sudo useradd --system --user-group --home-dir "/srv/infinite-data/instances/$NAME/agent-home" \
  --create-home --shell /usr/sbin/nologin "infinite-$NAME-agent"
sudo usermod --append --groups "infinite-$NAME-workspace" "infinite-$NAME-host"
sudo usermod --append --groups "infinite-$NAME-workspace" "infinite-$NAME-agent"
```

Create private state, homes, and temporary directories with their owning
account. Keep the shared team workspace root non-writable by the agent; the
host creates working directories below it.

```sh
sudo install -d -o "infinite-$NAME-host" -g "infinite-$NAME-host" -m 0700 \
  "/srv/infinite-data/instances/$NAME/control" \
  "/srv/infinite-data/instances/$NAME/control-home"
sudo install -d -o "infinite-$NAME-agent" -g "infinite-$NAME-agent" -m 0700 \
  "/srv/infinite-data/instances/$NAME/agent-home" \
  "/srv/infinite-data/instances/$NAME/tmp/agent"
sudo install -d -o "infinite-$NAME-host" -g "infinite-$NAME-host" -m 0700 \
  "/srv/infinite-data/instances/$NAME/tmp/control"
sudo install -d -o "infinite-$NAME-host" -g "infinite-$NAME-workspace" -m 2750 \
  "/srv/infinite-data/instances/$NAME/workspaces" \
  "/srv/infinite-data/instances/$NAME/team-workspaces"
sudo setfacl -d -m g::rwx,m::rwx "/srv/infinite-data/instances/$NAME/workspaces"
sudo install -d -o root -g "infinite-$NAME-agent" -m 0750 \
  "/srv/infinite-data/instances/$NAME/github-app-tokens"
```

The generated paths include the team workspace, control state, agent home,
temporary files, and GitHub App token cache beneath the instance directory.
Create each configured project directory below the instance's `workspaces/`
root as `infinite-NAME-host:infinite-NAME-workspace` mode `2770`, with a
default ACL that preserves group write on new files. Point project config only
at these per-instance directories.
Keep secrets and device credentials out of state, run, workspace, and project
directories. Store host-readable Linear and Slack credential files in
`/etc/infinite-NAME/`, owned by `infinite-NAME-host` with mode `0600`.

Install each release as root-owned code under `/opt/infinite-NAME`. Maintain a
separate release pointer for this instance. Do not point it at `/opt/infinite`
or reuse the first instance's mutable checkout.

## Generate a separate vault key

Each instance needs a newly generated 32-byte key. Do not copy the first
instance's key: the relay registers the machine identity derived from its own
key, so a duplicate key makes the two services claim one identity and breaks
relay registration.

Generate and retain the key privately on the encrypted instance directory,
then install the runtime copy. The private boot-key helper must restore this
same key to `/run/infinite-NAME-key/vault.key` before starting the unit.

```sh
sudo -H -u "infinite-$NAME-host" sh -c \
  'umask 077; openssl rand -out "$1/vault.key" 32' sh "/srv/infinite-data/instances/$NAME"
sudo test "$(stat -c %s "/srv/infinite-data/instances/$NAME/vault.key")" -eq 32
sudo install -d -o "infinite-$NAME-host" -g "infinite-$NAME-host" -m 0700 "/run/infinite-$NAME-key"
sudo install -o "infinite-$NAME-host" -g "infinite-$NAME-host" -m 0600 \
  "/srv/infinite-data/instances/$NAME/vault.key" "/run/infinite-$NAME-key/vault.key"
```

Keep the recovery copy separate from the host and include it in the owner's
recovery procedure. Do not print or record the key in a shell transcript.

## Render and install the files

From the release checkout, render the instance templates. The generated config
uses port `4781` by default; select another unused loopback port with
`--port 4890` (or another free port) if necessary.

```sh
NAME=work
node scripts/render-instance.mjs --out ".local/instance-$NAME" --instance "$NAME"
```

Review the rendered config and paths. Set `origin` to
`https://HOST.YOUR-TAILNET.ts.net` and confirm that the hostname resolves only
inside the owner's tailnet. Keep the API bound to loopback; do not create a
public inbound rule for its port.

Validate and install the sudoers policy before restarting either service:

```sh
sudo visudo -cf ".local/instance-$NAME/infinite-$NAME.sudoers"
sudo install -o root -g root -m 0440 ".local/instance-$NAME/infinite-$NAME.sudoers" \
  "/etc/sudoers.d/infinite-$NAME"
```

Install the systemd unit, GitHub refresh unit and timer, and tmpfiles rule from
the rendered directory. Install the rendered config as
`/etc/infinite-NAME/config.json`, owned by `infinite-NAME-host` with mode
`0600`. Install `agent-wrapper.sh` as each provider wrapper under
`/usr/local/libexec/infinite-NAME/`, then run the rendered
`install-agent-env.sh` so the instance-specific environment loader is
installed. Install `github-app-gh.sh` as
`/usr/local/libexec/infinite-NAME/bin/gh`. That location is first on the
instance wrapper `PATH`; do not replace the shared `/usr/local/bin/gh`.

```sh
sudo install -o root -g root -m 0644 ".local/instance-$NAME/infinite-$NAME.service" \
  "/etc/systemd/system/infinite-$NAME.service"
sudo install -o root -g root -m 0644 ".local/instance-$NAME/infinite-$NAME-github-refresh.service" \
  "/etc/systemd/system/infinite-$NAME-github-refresh.service"
sudo install -o root -g root -m 0644 ".local/instance-$NAME/infinite-$NAME-github-refresh.timer" \
  "/etc/systemd/system/infinite-$NAME-github-refresh.timer"
sudo install -o root -g root -m 0644 ".local/instance-$NAME/infinite-$NAME-tmpfiles.conf" \
  "/etc/tmpfiles.d/infinite-$NAME.conf"
sudo install -d -o root -g root -m 0755 "/etc/infinite-$NAME"
sudo install -o "infinite-$NAME-host" -g "infinite-$NAME-host" -m 0600 \
  ".local/instance-$NAME/config.example.json" "/etc/infinite-$NAME/config.json"
sudo install -d -o root -g root -m 0755 "/usr/local/libexec/infinite-$NAME/bin"
sudo install -o root -g root -m 0755 ".local/instance-$NAME/github-app-gh.sh" \
  "/usr/local/libexec/infinite-$NAME/bin/gh"
sudo install -d -o root -g root -m 0755 "/usr/local/libexec/infinite-$NAME"
for provider in claude codex codex-app-server grok opencode; do
  sudo install -o root -g root -m 0755 ".local/instance-$NAME/agent-wrapper.sh" \
    "/usr/local/libexec/infinite-$NAME/$provider"
done
sudo sh ".local/instance-$NAME/install-agent-env.sh"
sudo systemctl daemon-reload
sudo systemd-tmpfiles --create "/etc/tmpfiles.d/infinite-$NAME.conf"
```

Copy the instance-specific `config.example.json` to its private config path
before adding secrets or live project paths. Check the port, origin, key path,
state directory, team workspace, and command prefix. Start the refresh service
once after configuring it; enable its timer only after it succeeds.

## Port, origin, and relay registration

Use a distinct loopback port for the second API. The default is `4781`; the
first instance continues to use its configured port. Publish only through
Tailscale Serve, with the HTTPS hostname equal to `origin`:

```sh
sudo tailscale serve --bg http://127.0.0.1:4781
tailscale serve status
```

Keep the host firewall closed to public API traffic. Allow SSH only from the
operator's approved address and preserve the existing Tailscale access:

```sh
sudo ufw allow from SERVER_PUBLIC_IP to any port 22 proto tcp
sudo ufw status verbose
```

After the owner approves the relay entry, create a separate machine identity
and registration token for the instance. Do not reuse the first instance's
machine ID, vault key, or registration token. Set the second instance's
`remote.relay.url` and `remote.relay.tokenFile` through its existing
owner-approved config procedure, then verify the instance's relay connection.

```sh
sudo -H -u "infinite-$NAME-host" node \
  "/opt/infinite-$NAME/packages/host/dist/cli.js" machine-info \
  --config "/etc/infinite-$NAME/config.json"
printf 'Machine ID from machine-info: '
read -r MACHINE_ID
sudo node /opt/infinite-relay/packages/host/dist/cli.js relay-add \
  --machine "$MACHINE_ID" --token-file "/etc/infinite-$NAME/relay-registration.key" \
  --config /etc/infinite-relay/relay.json
sudo chown infinite-relay:infinite-relay /etc/infinite-relay/relay.json
sudo chown "infinite-$NAME-host:infinite-$NAME-host" "/etc/infinite-$NAME/relay-registration.key"
sudo node "/opt/infinite-$NAME/packages/host/dist/cli.js" connect-relay http://127.0.0.1:4790 \
  --token-file "/etc/infinite-$NAME/relay-registration.key" \
  --config "/etc/infinite-$NAME/config.json"
sudo chown "infinite-$NAME-host:infinite-$NAME-host" "/etc/infinite-$NAME/config.json"
sudo chmod 0600 "/etc/infinite-$NAME/config.json"
sudo systemctl restart "infinite-$NAME.service"
```

`relay-add` writes a new registration key and the relay machine entry. Keep the
key in the instance control account's private config area, mode `0600`.
Add the new machine in the phone, Mac, and web clients. The laptop CLI can
select it with `INFINITE_CLIENT_CONFIG` or `--client-config`; no CLI change is
needed.

## GitHub App and provider accounts

Create the instance GitHub config directory and token cache before installing
the App configuration:

```sh
sudo install -d -o root -g root -m 0755 "/etc/infinite-$NAME-github"
sudo install -d -o root -g "infinite-$NAME-agent" -m 0750 \
  "/srv/infinite-data/instances/$NAME/github-app-tokens"
sudo install -d -o root -g root -m 0700 \
  "/srv/infinite-data/instances/$NAME/github-app"
```

Use a GitHub App installation approved for only the repositories needed by the
instance. Keep its private key and issuer configuration outside the checkout,
owned by root with mode `0600`. Store the private key at
`/srv/infinite-data/instances/NAME/github-app/private-key.pem`, the issuer at
`/etc/infinite-NAME-github/issuer.json` (root, `0600`), and the non-secret
client config at `/etc/infinite-NAME-github/client.json` (root, `0644`). Use a
token cache under
`/srv/infinite-data/instances/NAME/github-app-tokens`; keep the GitHub App
client code under shared root-owned `/opt/infinite-github-auth`. Install the
rendered GitHub refresh unit and timer under the instance names. Follow
[Unattended GitHub access](github-app.md) for the App permission set and token
checks, adjusting account and config paths for this instance.

If a server App installation is not ready, keep the source on the laptop and
use the existing laptop-to-host source sync. Do not place a laptop credential
in the instance service environment or ask the instance to depend on the
laptop's personal login. Confirm that the server has the approved source tree
before enabling automated intake.

Authenticate each enabled provider as `infinite-NAME-agent` and verify its
installed CLI version and default permission mode. Never reuse the first
instance's provider home. Keep briefings, the knowledge service, remote memory,
cmux, demo, and contributor models disabled until each has a separate reviewed
configuration and an owner decision.

## Private host tools to extend

These tools belong to the private deployment and are not shipped here. Extend
them to support the second instance before activation:

- The boot-key helper restores the instance's own vault key before its unit
  starts.
- The team command launcher runs Git, setup, and check commands as the
  instance agent account. Obtain owner approval before installing or enabling
  it.
- Release pruning retains a valid rollback release for both instances and
  never removes the active release of either one.
- Secrets sync stores the instance's Linear, Slack, GitHub App, and relay
  credentials in a vault of its own and keeps them outside state, run,
  workspace, and project paths.
- The activation guard checks the instance-specific config, key, mount,
  launcher, and account boundaries before the service can start.

The second service must not inherit authority from a helper configured for the
first instance. Each tool needs an explicit instance name and its own owner
approval where it changes host state.

After those tools are ready, run the private activation guard. Enable the
service and GitHub refresh timer only after the guard passes and the boot-key
helper is ordered before the service:

```sh
sudo systemctl enable --now "infinite-$NAME-github-refresh.timer"
sudo systemctl enable --now "infinite-$NAME.service"
```

## First-instance host load gate

Enable the launch gate on the first instance through its existing owner-approved
config-change procedure. Add this exact block without replacing unrelated
configuration:

```json
"hostLoad": {
  "minAvailableMemoryGiB": 8,
  "maxLoadPerCpu": 1.5
}
```

Restart the first service only through that procedure. The instance renderer
also places this default in the second instance config. The new unit uses
`CPUWeight=50` and `IOWeight=50`, below the default weight of 100, so the first
instance gets twice the weighted share under contention while the second can
use idle capacity. `OOMScoreAdjust=500` makes the kernel prefer the new
instance's processes if the host still runs out of memory. The new unit has no
CPU, memory, or task ceiling; the first unit and its existing limits stay
unchanged.

## Host acceptance checks

Run these five checks before enabling private mission work. Record the results
without recording credentials.

1. **The instances cannot read each other's private data.** Test both
   directions for the agent home, control state, workspaces, and config file.

   ```sh
   sudo -H -u "infinite-$NAME-agent" test ! -x /srv/infinite-data/agent-home
   sudo -H -u "infinite-$NAME-agent" test ! -x /srv/infinite-data/control
   sudo -H -u "infinite-$NAME-agent" test ! -x /srv/infinite-data/workspaces
   sudo -H -u "infinite-$NAME-agent" test ! -r /etc/infinite/config.json
   sudo -H -u infinite-agent test ! -x "/srv/infinite-data/instances/$NAME/agent-home"
   sudo -H -u infinite-agent test ! -x "/srv/infinite-data/instances/$NAME/control"
   sudo -H -u infinite-agent test ! -x "/srv/infinite-data/instances/$NAME/team-workspaces"
   sudo -H -u infinite-agent test ! -r "/etc/infinite-$NAME/config.json"
   ```

2. **The unit has the intended resource priority.** Confirm the weights and
   OOM score, and inspect every process belonging to the new accounts in the
   unit's control group.

   ```sh
   systemctl show "infinite-$NAME.service" -p CPUWeight -p IOWeight -p OOMScoreAdjust
   ps -eo user=,cgroup=,pid=,args= | grep -E "infinite-$NAME-(host|agent)" | grep -v grep
   ```

3. **The first instance's guarded files are unchanged.** Capture the output
   before commissioning and compare it afterward. The normalized config digest
   omits only the new `hostLoad` block.

   ```sh
   first_files() {
     sudo sha256sum /etc/systemd/system/infinite.service /etc/sudoers.d/infinite \
       /etc/tmpfiles.d/infinite.conf /etc/systemd/system/infinite-github-refresh.service \
       /etc/systemd/system/infinite-github-refresh.timer \
       /etc/infinite-github/issuer.json /etc/infinite-github/client.json \
       /usr/local/libexec/infinite/agent-env.sh /usr/local/libexec/infinite/claude \
       /usr/local/libexec/infinite/codex /usr/local/libexec/infinite/codex-app-server \
       /usr/local/libexec/infinite/grok /usr/local/libexec/infinite/opencode \
       /usr/local/bin/gh
     readlink -f /opt/infinite
     sudo node -e 'const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync("/etc/infinite/config.json", "utf8")); delete c.hostLoad; process.stdout.write(JSON.stringify(c));' | sha256sum
   }
   FIRST_BEFORE=$(first_files)
   printf '%s\n' "$FIRST_BEFORE"
   ```

   After commissioning, run the comparison in the same shell:

   ```sh
   test "$FIRST_BEFORE" = "$(first_files)" && echo 'first instance files unchanged apart from hostLoad'
   ```

4. **Restarting either service leaves the other instance's work running.**
   Start a disposable session and worker in each instance, capture their PIDs,
   restart each service separately, and confirm the other PIDs remain.

   ```sh
   ps -eo user=,pid=,cgroup=,args= | grep -E 'infinite(-work)?-(host|agent)' | grep -v grep
   sudo systemctl restart "infinite-$NAME.service"
   ps -eo user=,pid=,cgroup=,args= | grep -E 'infinite(-work)?-(host|agent)' | grep -v grep
   sudo systemctl restart infinite.service
   ps -eo user=,pid=,cgroup=,args= | grep -E 'infinite(-work)?-(host|agent)' | grep -v grep
   ```

5. **The host load gate holds and resumes a launch.** Use a bounded synthetic
   memory load to take available memory below the configured 8 GiB floor. If
   the sample does not cross the floor, increase the bounded allocation until
   it does. Run the `infinite` commands from a client paired to the new instance.
   The board must show a waiting reason while existing work continues, then
   start the mission after memory recovers.

   ```sh
   command -v stress-ng >/dev/null || sudo apt install stress-ng
   stress-ng --vm 1 --vm-bytes 80% --vm-keep --timeout 5m --metrics-brief &
   LOAD_PID=$!
   grep MemAvailable /proc/meminfo
   infinite start "Host capacity acceptance: report one fact about the selected project; do not edit files."
   infinite board
   kill "$LOAD_PID"
   wait "$LOAD_PID" || true
   infinite board
   ```

## Slack app and read-only connectors

Use a dedicated Slack app for the instance. Turn on Socket Mode. Give the bot
only `app_mentions:read`, `chat:write`, `channels:history`, and `groups:history`;
give the app-level token `connections:write`. Subscribe to the `app_mention`
event only. Obtain the owner's approval before installing the app. Store each
token in a separate mode `0600` file readable by the
instance host account, then set the corresponding `intake.slack.appTokenFile`
and `intake.slack.botTokenFile` values in the instance config. Set the Slack
workspace, owner, Infinite bot, and Linear bot identities to the IDs from that
app and the owner's account, including `intake.slack.linearAgentUserId` for
Linear's Slack agent. The intake binding must post only into the issue's
recorded Slack thread.

Configure external connectors as MCP servers in the instance agent account,
with read scopes only. A delegated permission request may add read-only
connector calls within the owner's approved task; it does not authorize a
connector write. The delegated-permission scope for the workspace's
repositories adds read-only connector calls made for the accepted objective.
Sends, writes, and new credentials still escalate to the owner.

## Pre-build checks

Before building Parts 2 and 3, obtain the owner's Linear API key and one issue
filed through Linear's Slack agent. Read these outcomes privately; do not put
issue text, account IDs, or credentials in this repository.

1. **Linear author and thread fields.** Read the test issue through the API.
   Identify the creator field and whether it reports the owner or Linear's app,
   and identify how the Slack thread link is represented. Set
   `intake.linear.creatorId` to the owner's Linear ID when Linear attributes
   the issue to the person. If Linear attributes it to an app, omit
   `creatorId`; the owner mention check in the thread becomes the authorship
   gate and the separate creator check is dropped. If the API exposes no thread
   link, set `intake.slack.bindByMention` to enable binding when the owner
   mentions the bot in that thread with the ID of an admitted issue, and set
   `intake.requireSlackThread` to `false`. Until a thread is bound, outcomes go
   to Linear and the apps; do not require a Slack thread for admission. Set
   `intake.slack.linearAgentUserId` to Linear's Slack agent ID for the mention
   check.
2. **Linear comment mirroring.** Add a top-level comment to the test issue and
   check whether it appears in the Slack thread. Set
   `intake.linear.commentsMirrorToSlack` to `true` if Linear mirrors it. In
   that case the Slack thread carries the outcome and intake skips its Linear
   outcome comment, avoiding a duplicate. Otherwise leave it `false`.
3. **Codex MCP reachability.** Run a Codex team member with a remote MCP
   connector under the provider sandbox. If it cannot reach the connector, set
   `teams.lineup` so its planner and scout roles use Claude Code; those roles
   perform answer-only work. This is an instance-wide lineup choice, not a
   per-subtask override.

Keep intake disabled until these three outcomes, the host acceptance checks,
the owner identity, allowed Linear teams and label, Slack app, and credentials
have been configured. Do not use teammate identities or a public callback
endpoint.
