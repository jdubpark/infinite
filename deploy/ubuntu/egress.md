# Agent egress proxy

This runbook adds an optional network boundary for agent sessions on the single-tenant Ubuntu host. It is off until the owner installs it. Every step is a root step, and each one says how to undo it.

There are two parts:

- **The proxy** (`scripts/egress-proxy.mjs`) listens on loopback. The host gives each new session `HTTPS_PROXY` and `HTTP_PROXY` with a credential that names the session's project. The proxy records the destination of every connection, refuses cloud metadata, private, and other non-public addresses, and in enforce mode refuses hosts that the policy does not list.
- **The firewall rule** (`egress-*.nft`) examines packets from the agent account that do not leave through loopback, which means they did not go through the proxy. The observe variant logs them and lets them through. The enforce variant logs them and refuses them. Both refuse link-local destinations, where cloud metadata services live.

Policy mode and firewall variant are separate switches. Run both in observe, read what agents reach, write the allow list, and then switch the proxy to enforce before the firewall. [Confidentiality boundary](../../docs/security.md#agent-egress-boundary) states what this boundary protects and what it does not.

| File | Installed as |
| --- | --- |
| `scripts/egress-proxy.mjs` | `/opt/infinite-egress/egress-proxy.mjs`, root-owned. It uses only Node built-ins. |
| `egress/proxy.example.json` | `/etc/infinite-egress/proxy.json`: listen address, key, policy, and summary paths, optional `limits` |
| `egress/policy.example.json` | `/etc/infinite-egress/policy.json`: mode, ports, allow list |
| `egress/infinite-egress-proxy.service` | `/etc/systemd/system/` |
| `egress/infinite-egress-proxy.socket` | `/etc/systemd/system/`, optional |
| `egress/egress-observe.nft`, `egress/egress-enforce.nft` | One of them as `/etc/infinite-egress/firewall.nft` |
| `egress/infinite-egress-firewall.service` | `/etc/systemd/system/` |
| `egress/nftables-keeps-egress.conf` | `/etc/systemd/system/nftables.service.d/infinite-egress.conf` |
| `egress/infinite-requires-egress-firewall.conf` | `/etc/systemd/system/infinite.service.d/egress-firewall.conf`, in enforce mode |
| `infinite.sudoers` | `/etc/sudoers.d/infinite`; it keeps the six proxy variables and `NODE_USE_ENV_PROXY` through sudo |

Run the commands from a checkout of the release that the host runs. Port 4785 is an example; any free loopback port works if the proxy config, the optional socket unit, and the host's `proxyUrl` agree.

## Stopping agent work

Any step that removes the firewall table leaves the agent account's direct connections unlogged and unrefused, cloud metadata addresses included, from that moment until a rule loads again. Those steps are: stopping or restarting `infinite-egress-firewall.service`, and starting, restarting, reloading, or stopping `nftables.service`, which flushes every table. With the drop-in from step 4, a start, restart, or reload of `nftables.service` loads the rule again within the same job, so the gap is the moment between the flush and the load; a stop leaves no rule. Before any of them, stop agent work:

1. Close every session: `infinite list`, then `infinite close SESSION_ID` for each one, including team and goal members.
2. Stop the API so it launches nothing new: `sudo systemctl stop infinite.service`.
3. Check that the agent account runs nothing: `pgrep -u infinite-agent -a` prints nothing. Stopping the API alone is not enough, because its workers and their agents outlive it (`KillMode=process`). End anything still listed after reading what it is.

When the step is done, load the rule again and check it before any agent starts:

```sh
sudo systemctl reload-or-restart infinite-egress-firewall.service
sudo nft list table inet infinite_egress     # must print the table; an error means no rule is in force
sudo systemctl start infinite.service
```

Do not start the API or a session while the second command prints an error. The firewall unit reports `active` from its first successful load onward, also after `nftables.service` flushed its table and the reload that follows failed, so `systemctl status` alone does not show that the rule is in force. Read `journalctl -u infinite-egress-firewall` for the failed load, fix `/etc/infinite-egress/firewall.nft`, and run the three commands again.

Changing the firewall variant needs none of this: `systemctl reload infinite-egress-firewall` replaces the table in one transaction, and a file that fails to load leaves the previous table in force.

## 1. Account, group, and key

The proxy runs as its own account `infinite-egress`. The host account joins the `infinite-egress` group so it can read the key and the summary. The agent account must never join it.

```sh
sudo groupadd --system infinite-egress
sudo useradd --system --gid infinite-egress --no-create-home --home-dir /nonexistent \
  --shell /usr/sbin/nologin infinite-egress
sudo usermod --append --groups infinite-egress infinite-host
id -nG infinite-agent        # must not list infinite-egress
sudo install -d -o root -g infinite-egress -m 0750 /etc/infinite-egress
sudo sh -c 'umask 077 && head -c 32 /dev/urandom > /etc/infinite-egress/key'
sudo chown root:infinite-egress /etc/infinite-egress/key
sudo chmod 0640 /etc/infinite-egress/key
sudo stat -c '%U:%G %a %s' /etc/infinite-egress/key   # root:infinite-egress 640 32
```

The proxy and the host both refuse a key that is not exactly 32 bytes, that is owned by another account, or that other users can read. The key needs no off-host copy: a lost key is replaced as described under [Rotating the key](#rotating-the-key).

Rollback: `sudo gpasswd -d infinite-host infinite-egress`, `sudo userdel infinite-egress`, `sudo groupdel infinite-egress`, `sudo rm -r /etc/infinite-egress`.

## 2. Install and start the proxy in observe mode

```sh
sudo install -d -o root -g root -m 0755 /opt/infinite-egress
sudo install -o root -g root -m 0644 scripts/egress-proxy.mjs /opt/infinite-egress/egress-proxy.mjs
sudo install -o root -g infinite-egress -m 0640 deploy/ubuntu/egress/proxy.example.json /etc/infinite-egress/proxy.json
sudo install -o root -g infinite-egress -m 0640 deploy/ubuntu/egress/policy.example.json /etc/infinite-egress/policy.json
sudo install -o root -g root -m 0644 deploy/ubuntu/egress/infinite-egress-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now infinite-egress-proxy.service
systemctl status infinite-egress-proxy.service
curl -sS -o /dev/null -w '%{http_connect}\n' -x http://127.0.0.1:4785 https://example.com   # 407
```

Edit `/etc/infinite-egress/policy.json` before relying on it: keep `"mode": "observe"`, and replace the `project-a` example under `projects` with real project IDs or remove it. The policy keys are:

- `mode`: `observe` records every destination and refuses only non-public addresses; `enforce` also refuses hosts that are not listed, before resolving them.
- `allow`: exact host names, IP literals, and `*.example.com` wildcards. A wildcard matches subdomains only and needs at least two labels after `*.`.
- `ports`: allowed destination ports, `[443, 80]` by default. Other ports are refused in both modes.
- `projects`: extra `allow` entries for one project ID.
- `allowPrivate`: exact `host:port` entries that may resolve to a private address. They lift only the address refusal; in enforce mode the host must still be listed.

`sudo systemctl reload infinite-egress-proxy` re-reads the policy. A policy that fails to load leaves the previous one in force, and `infinite egress` names the error. The proxy refuses to start when its config is missing, invalid, or names a listen address that is not loopback; the journal shows `egress-proxy: failed (CODE)`.

Optional socket activation: systemd then holds the port, so connections wait during a proxy restart instead of failing. The running service holds the port itself, so stop it before the socket starts:

```sh
sudo install -o root -g root -m 0644 deploy/ubuntu/egress/infinite-egress-proxy.socket /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl stop infinite-egress-proxy.service
sudo systemctl enable --now infinite-egress-proxy.socket
sudo systemctl start infinite-egress-proxy.service
sudo ss -ltnp 'sport = :4785'      # lists systemd as well as node: the proxy uses the socket systemd holds
```

Sessions' requests fail between the stop and the socket start. To go back, reverse the order: `sudo systemctl stop infinite-egress-proxy.socket infinite-egress-proxy.service`, `sudo systemctl disable infinite-egress-proxy.socket`, `sudo rm /etc/systemd/system/infinite-egress-proxy.socket`, `sudo systemctl daemon-reload`, `sudo systemctl start infinite-egress-proxy.service`. The service then listens on its own port again.

Each connection writes one JSON line to the journal (`journalctl -u infinite-egress-proxy -o cat`) with time, kind, project, session, host, port, checked address, decision, reason, byte counts, and duration. It never records paths, queries, headers, or credentials. The proxy also keeps a 14-day summary in `/var/lib/infinite-egress/summary.json`, mode 0640, which the host reads.

Rollback: `sudo systemctl disable --now infinite-egress-proxy.socket infinite-egress-proxy.service`, then remove the unit files and `/opt/infinite-egress`. Do this only after step 3 is rolled back, or sessions that still carry proxy variables lose the network.

## 3. Point the host at the proxy

Add the block to `/etc/infinite/config.json`, merging it into an existing `autonomy` block if there is one:

```json
"autonomy": {
  "boundary": {
    "egress": {
      "proxyUrl": "http://127.0.0.1:4785",
      "keyPath": "/etc/infinite-egress/key",
      "summaryPath": "/var/lib/infinite-egress/summary.json"
    }
  }
}
```

`proxyUrl` must be `http://` to a loopback IP address with a port and nothing else. Then install the sudoers file from this release, which keeps the six proxy variables and `NODE_USE_ENV_PROXY` through sudo, and restart the API so it picks up the configuration and the new group:

```sh
sudo visudo -cf deploy/ubuntu/infinite.sudoers
sudo install -o root -g root -m 0440 deploy/ubuntu/infinite.sudoers /etc/sudoers.d/infinite
sudo systemctl restart infinite.service
sudo -H -u infinite-host /usr/local/bin/infinite doctor --config /etc/infinite/config.json
```

The doctor line reads `Egress: proxy reachable at 127.0.0.1:4785 · key readable · summary ...`. A worker reads the key when its session launches and gives the provider only the proxy URL with a session credential. A session started before this step keeps its old environment until it is recreated.

If the key cannot be read, the host still hands out the proxy address, without a credential. Network requests from new sessions and host commands are then refused with `407` rather than sent direct, local work is unaffected, the worker journals `no-credential`, and `doctor` reports `key UNREADABLE (...)` with that consequence. Fix the key's owner, group, or mode; new sessions and the next host command pick it up.

If `teams.commandPrefix` runs a root-owned launcher that resets the environment, make it keep `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy`, `NO_PROXY`, `no_proxy`, and `NODE_USE_ENV_PROXY`. This repository does not ship that launcher, so update the server copy. Otherwise team Git fetches and pushes run as the agent account without the proxy: logged in observe, refused in enforce. Without `teams.commandPrefix`, those commands run as the host account, which the firewall rule does not match, so only the proxy variables route them.

Git's default `http.proxyAuthMethod=anyauth` first opens each HTTPS connection without the credential, so the proxy logs one `unauthenticated` (`missing`) line before every authenticated connection. To send the credential on the first attempt, set it in the system configuration of each git on the host, and again after installing a new git build. A git built with its own prefix reads `PREFIX/etc/gitconfig`; `git config --system --show-origin --list` names the file.

```sh
sudo git config --system http.proxyAuthMethod basic
```

Codex starts stdio MCP servers with a restricted environment. Variables outside its built-in environment are forwarded only when named in that server's `env_vars`, and unset names are omitted. For each owner-configured Codex MCP server that needs egress, add this line to its `[mcp_servers.<server-name>]` table:

```toml
env_vars = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"]
```

The host adds these names to its generated team/mission and handoff MCP server settings only when egress is configured.

Rollback: remove the `egress` block, restart `infinite.service`, and recreate sessions. The sudoers line has no effect while the host sets no proxy variables.

## 4. Observe

Install the observe firewall variant:

```sh
sudo install -o root -g root -m 0644 deploy/ubuntu/egress/egress-observe.nft /etc/infinite-egress/firewall.nft
sudo nft -c -f /etc/infinite-egress/firewall.nft
sudo install -o root -g root -m 0644 deploy/ubuntu/egress/infinite-egress-firewall.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now infinite-egress-firewall.service
sudo nft list table inet infinite_egress
sudo install -d -o root -g root -m 0755 /etc/systemd/system/nftables.service.d
sudo install -o root -g root -m 0644 deploy/ubuntu/egress/nftables-keeps-egress.conf \
  /etc/systemd/system/nftables.service.d/infinite-egress.conf
sudo systemctl daemon-reload
systemctl show nftables.service -p ExecStartPost   # lists the nft command for firewall.nft
```

The unit replaces only the `inet infinite_egress` table, so Tailscale's and the system's tables stay as they are. Do not add the rule to `/etc/nftables.conf`, whose `flush ruleset` removes other tables. Starting, restarting, or reloading `nftables.service` flushes this table too. The firewall unit follows a restart or a reload, but systemd propagates no start, and Ubuntu 24.04 ships `nftables.service` disabled: without the drop-in, `systemctl start nftables.service` removed the table while the firewall unit kept reporting `active`. The drop-in loads the rule again as part of each start, restart, and reload of `nftables.service`. When the rule does not load, that job fails and no rule is left until a load succeeds, while the firewall unit still reports `active`. A moment without a rule remains between the flush and the load (see [Stopping agent work](#stopping-agent-work)).

Run real work for at least a week, then read what agents reached:

```sh
infinite egress                     # would-deny hosts first, per project
infinite egress --project ID --json
journalctl -k --grep 'infinite-egress'   # direct connections that skipped the proxy
```

Add the hosts that agents legitimately need to `allow` or to a project's entry and reload. A `bypass` kernel line names a destination address and port, not the program; `sudo ss -tnp` while it happens shows which process holds the socket. Each tool that bypasses the proxy will fail in enforce mode.

Rollback: [stop agent work](#stopping-agent-work), then `sudo systemctl disable --now infinite-egress-firewall.service`, which deletes the table, and `sudo rm /etc/systemd/system/nftables.service.d/infinite-egress.conf` and `sudo systemctl daemon-reload`, so `nftables.service` does not load the rule again. From then on the agent account's direct connections are neither logged nor refused, metadata addresses included.

## 5. Enforce

Switch the proxy first, then the firewall, then make the API depend on the firewall:

```sh
sudo sed -i 's/"mode": "observe"/"mode": "enforce"/' /etc/infinite-egress/policy.json
sudo systemctl reload infinite-egress-proxy
infinite egress | head -2          # Egress: enforce · ... and no Policy: line
sudo install -o root -g root -m 0644 deploy/ubuntu/egress/egress-enforce.nft /etc/infinite-egress/firewall.nft
sudo nft -c -f /etc/infinite-egress/firewall.nft
sudo systemctl reload infinite-egress-firewall.service
sudo nft list chain inet infinite_egress agent     # shows "jump refuse" after the loopback rule
sudo install -d -o root -g root -m 0755 /etc/systemd/system/infinite.service.d
sudo install -o root -g root -m 0644 deploy/ubuntu/egress/infinite-requires-egress-firewall.conf \
  /etc/systemd/system/infinite.service.d/egress-firewall.conf
sudo systemctl daemon-reload
systemctl show infinite.service -p Requires -p After   # both list infinite-egress-firewall.service
systemctl show infinite.service -p ExecStartPre        # lists the nft command
sudo -u infinite-agent curl -sS --max-time 5 https://example.com   # refused: no proxy variables
```

Reload, never restart, the firewall unit: restart stops it first, which removes the table while agents keep running. The drop-in makes the API start only after the rule has loaded, and not at all when loading fails. Each API start also loads the rule again as root, because the firewall unit stays `active` when something else removes its table later. A host with the boundary on therefore never starts its API without the rule. Agents that are already running are not covered by this: they keep running if the table is removed, which is why every step that removes it begins with [stopping agent work](#stopping-agent-work). It also means that stopping or restarting the firewall unit stops or restarts the API, though not the agents already running. If the API does not come up after a reboot, read `systemctl status infinite-egress-firewall` and `journalctl -u infinite.service` for the failed `nft` command.

Then start a session and confirm it reaches its model and a listed registry, and that an unlisted host fails with `403`. The enforce rule also resets direct connections that were open when it loaded.

Rollback, fastest first:

- Back to logging, with no gap and no agent stop: install `egress-observe.nft` as `/etc/infinite-egress/firewall.nft` and `sudo systemctl reload infinite-egress-firewall`. The drop-in can stay.
- Stop allow-list refusals: set `"mode": "observe"` and `sudo systemctl reload infinite-egress-proxy`.
- Remove the rule entirely: [stop agent work](#stopping-agent-work); remove both drop-ins (`sudo rm /etc/systemd/system/infinite.service.d/egress-firewall.conf /etc/systemd/system/nftables.service.d/infinite-egress.conf` and `sudo systemctl daemon-reload`) so the API no longer depends on the firewall and `nftables.service` no longer loads the rule; then `sudo systemctl disable --now infinite-egress-firewall.service` and start the API. From then on the agent account's direct connections are neither logged nor refused, metadata addresses included.

## 6. Eval identities

The eval account ([the eval member account](eval.md)) has two egress identities. The host gives each one a credential that names it, and the proxy gives each one only its own list in the `projects` map of `policy.json`. The global `allow` list never applies to them.

- `_eval` is the member of a trial and the probe that checks its isolation. The member's credential lasts 30 days, as every session's does, and the probe's lasts 60 seconds. Its list holds the provider API hosts of the eval logins.
- `_eval-setup` is the project's `setup` command, which installs dependencies in a trial's workspace. Its credential lasts 15 minutes. Its list holds the package registries that `setup` needs.

```json
"projects": {
  "_eval": { "allow": ["PROVIDER_API_HOST"] },
  "_eval-setup": { "allow": ["PACKAGE_REGISTRY_HOST"] }
}
```

The lists are the owner's. Step 6 of [the eval member account](eval.md#6-the-egress-lists) says how to choose them and why a registry that serves the project's own later releases does not belong in `_eval-setup`.

Setup runs with the host's whole egress set: the four proxy variables, `NO_PROXY` and `no_proxy` with the loopback addresses, and `NODE_USE_ENV_PROXY=1`. Node 22 uses the proxy only with the last one. Commands that a trial runs through `exec` get no proxy variable, so a tool that calls out directly reaches the network only where the network rule of [the eval member account](eval.md#5-the-network-rule) allows it, which is nowhere but loopback.

Check: the journal's `_eval` lines name the hosts that a trial reached. In enforce mode a host that is missing from the list shows `refused`.

```sh
journalctl -u infinite-egress-proxy -o cat | grep '"project":"_eval' | tail -n 5
```

Undo: remove the two keys from `projects`, and reload the proxy with `sudo systemctl reload infinite-egress-proxy`. The eval account then reaches no host through the proxy, and every trial's probe and setup fail.

## When the proxy is down

Sessions with proxy variables cannot reach the network: model calls, package installs, and Git over HTTPS fail with connection refused. The firewall rule is separate and stays in force. The host API, web client, and phone keep working, because the host's own requests do not use the proxy and the firewall rule matches only the agent account. Systemd restarts the proxy after two seconds; with the socket unit, new connections wait instead of failing. `infinite doctor` shows `proxy UNREACHABLE`.

## Rotating the key

Rotation revokes every credential issued so far. Use it when a credential may have leaked.

```sh
sudo sh -c 'umask 077 && head -c 32 /dev/urandom > /etc/infinite-egress/key.new'
sudo chown root:infinite-egress /etc/infinite-egress/key.new
sudo chmod 0640 /etc/infinite-egress/key.new
sudo mv /etc/infinite-egress/key.new /etc/infinite-egress/key
sudo systemctl restart infinite-egress-proxy.service infinite.service
```

The proxy reads the key at start, and the API caches it for host commands, so both restart. Running sessions keep the old credential and get `407` until they are recreated.

## Limits

- **Names, not content.** The proxy sees the host name and port of each connection and never decrypts TLS. An allowed host can carry data out: `github.com` accepts pushes to any repository the agent can write, and `*.githubusercontent.com` serves user content. Domain fronting through a shared CDN is not detected.
- **DNS and loopback stay open.** Agents resolve names through the local resolver over loopback, and DNS queries can carry data. The firewall leaves all loopback traffic alone, and traffic to this host's own addresses, including its tailnet address, also travels over loopback. The Infinite API, the proxy, and any other local service remain reachable and rely on their own authentication. A server an agent runs is reachable only from this host in enforce mode.
- **Tools that ignore proxy variables.** SSH (including Git over SSH), UDP and QUIC, ICMP, and raw sockets do not use the proxy. Node's built-in `fetch` and HTTP clients need `NODE_USE_ENV_PROXY=1` on Node releases that support environment proxies. When egress is configured, the host sets this flag with the six proxy variables for sessions and host commands. Other tools that ignore proxy variables go direct and are logged in observe mode, and fail in enforce mode.
- **Attribution, not isolation.** The credential is in the session's environment, and every process of the agent account can read other sessions' environments and files. The project in the records says which credential was used, not which project acted, so per-project allow entries do not isolate projects from each other. Tools that print their proxy URL also print the credential. The host identity (`_host`) is in the same position: briefings, System tab brief and context runs, permission reviewer turns and prefixed team commands all carry it, so a `projects._host` allow entry is open to any agent-account process, not to the host alone.
- **Credential lifetime.** Session credentials last 30 days and host-command credentials one day. The proxy refuses credentials that claim more than 31 days. Rotating the key is the only revocation.
- **Observe resolves everything.** In observe mode the proxy resolves every name it is asked for; in enforce mode it resolves only listed names.
- **Launches without proxy variables.** Code graph extraction runs through its own sudo wrapper without host proxy variables, and it needs none: `scripts/repository_graph.py` runs Graphify with `GRAPHIFY_BACKEND=none`, `extract --code-only` and `cluster-only --no-label`, so it parses files locally and calls no model. On the main instance, graph builds between 2026-11-19 and 2026-11-21 logged no direct connection while the `bypass` log rule was confirmed working, so enforce mode does not affect them. Pass the proxy variables through the wrapper before giving Graphify a model backend. Session briefings, System tab briefs and context runs, and permission reviewer turns receive the configured proxy variables, with the host identity, through sudo using the `env_keep` entries in `infinite.sudoers`. The System tab's `gh` reads of pull requests and deployments run as the host account with the host's own environment, not through the proxy.
- **Host-account commands.** Without `teams.commandPrefix`, team Git commands run as the host account, which the firewall does not cover; the proxy variables are their only route. With a prefix, they run through a root-owned server launcher that resets the environment; this repository does not ship that launcher. Keep the six proxy variables and `NODE_USE_ENV_PROXY` in its environment when egress is configured. Tools that ignore the proxy go direct in every mode.
- **One instance.** The rule matches `infinite-agent` only. A second instance's agent account is not covered, and its host account is not in the `infinite-egress` group. Cover it by adding its account to the rule and the group, or with a second proxy, key, and port.
- **Rehearsed, not deployed.** Steps 1 to 5, the socket unit, and the drop-ins ran on Ubuntu 24.04 with systemd 255 and nftables 1.0.9 (arm64 container, 2026-11-15) against stand-in hosts. Observe logged an agent connection through the proxy as `would-deny` and let a direct one through the `bypass` rule; enforce answered `403` for an unlisted host, passed a listed one, and reset the agent account's direct connections; the host account's direct connections met neither rule. The container's network namespace drops kernel log lines, so the `log` rules were confirmed with `nft monitor trace`, not `journalctl -k`; read the kernel log on the server.
- **Records hold destinations.** The journal and summary list every host each project reached. Members of `adm` and `systemd-journal` can read the journal; the agent account must not be one of them.
