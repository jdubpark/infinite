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
| `infinite.sudoers` | `/etc/sudoers.d/infinite`; it keeps the proxy variables through sudo |

Run the commands from a checkout of the release that the host runs. Port 4785 is an example; any free loopback port works if the proxy config, the optional socket unit, and the host's `proxyUrl` agree.

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

Optional: with `infinite-egress-proxy.socket` enabled (`sudo systemctl enable --now infinite-egress-proxy.socket`), systemd holds the port, so connections wait during a proxy restart instead of failing.

Each connection writes one JSON line to the journal (`journalctl -u infinite-egress-proxy -o cat`) with time, kind, project, session, host, port, checked address, decision, reason, byte counts, and duration. It never records paths, queries, headers, or credentials. The proxy also keeps a 14-day summary in `/var/lib/infinite-egress/summary.json`, mode 0640, which the host reads.

Rollback: `sudo systemctl disable --now infinite-egress-proxy.service infinite-egress-proxy.socket`, then remove the unit files and `/opt/infinite-egress`. Do this only after step 3 is rolled back, or sessions that still carry proxy variables lose the network.

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

`proxyUrl` must be `http://` to a loopback IP address with a port and nothing else. Then install the sudoers file from this release, which keeps the proxy variables through sudo, and restart the API so it picks up the configuration and the new group:

```sh
sudo visudo -cf deploy/ubuntu/infinite.sudoers
sudo install -o root -g root -m 0440 deploy/ubuntu/infinite.sudoers /etc/sudoers.d/infinite
sudo systemctl restart infinite.service
sudo -H -u infinite-host /usr/local/bin/infinite doctor --config /etc/infinite/config.json
```

The doctor line reads `Egress: proxy reachable at 127.0.0.1:4785 · key readable · summary ...`. A worker reads the key when its session launches and gives the provider only the proxy URL with a session credential. A session started before this step keeps its old environment until it is recreated. If the key is unreadable, sessions start without proxy variables and the worker journals `no-credential`.

If `teams.commandPrefix` runs a root-owned launcher that resets the environment, make it keep `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy`, `NO_PROXY`, and `no_proxy`. Otherwise team Git fetches and pushes go direct: logged in observe, refused in enforce.

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
```

The unit replaces only the `inet infinite_egress` table, so Tailscale's and the system's tables stay as they are. Do not add the rule to `/etc/nftables.conf`, whose `flush ruleset` removes other tables. Restarting `nftables.service` restarts this unit too.

Run real work for at least a week, then read what agents reached:

```sh
infinite egress                     # would-deny hosts first, per project
infinite egress --project ID --json
journalctl -k --grep 'infinite-egress'   # direct connections that skipped the proxy
```

Add the hosts that agents legitimately need to `allow` or to a project's entry and reload. A `bypass` kernel line names a destination address and port, not the program; `sudo ss -tnp` while it happens shows which process holds the socket. Each tool that bypasses the proxy will fail in enforce mode.

Rollback: `sudo systemctl disable --now infinite-egress-firewall.service` deletes the table.

## 5. Enforce

Switch the proxy first, then the firewall:

```sh
sudo sed -i 's/"mode": "observe"/"mode": "enforce"/' /etc/infinite-egress/policy.json
sudo systemctl reload infinite-egress-proxy
infinite egress | head -2          # Egress: enforce · ... and no Policy: line
sudo install -o root -g root -m 0644 deploy/ubuntu/egress/egress-enforce.nft /etc/infinite-egress/firewall.nft
sudo nft -c -f /etc/infinite-egress/firewall.nft
sudo systemctl restart infinite-egress-firewall.service
sudo -u infinite-agent curl -sS --max-time 5 https://example.com   # refused: no proxy variables
```

Then start a session and confirm it reaches its model and a listed registry, and that an unlisted host fails with `403`. The enforce rule also resets direct connections that were open when it loaded.

Rollback, fastest first: `sudo systemctl stop infinite-egress-firewall.service` removes the rule at once; reinstalling the observe variant and restarting the unit returns to logging; setting `"mode": "observe"` and reloading the proxy stops allow-list refusals.

## When the proxy is down

Sessions with proxy variables cannot reach the network: model calls, package installs, and Git over HTTPS fail with connection refused. The host API, web client, and phone keep working, because the host's own requests do not use the proxy and the firewall rule matches only the agent account. Systemd restarts the proxy after two seconds; with the socket unit, new connections wait instead of failing. `infinite doctor` shows `proxy UNREACHABLE`.

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
- **Tools that ignore proxy variables.** SSH (including Git over SSH), UDP and QUIC, ICMP, and raw sockets do not use the proxy. Node's built-in `fetch` ignores proxy variables unless `NODE_USE_ENV_PROXY=1` is set on a Node release that supports it; an owner can set it in a `secrets/*.env` file. These go direct and are logged in observe mode, and fail in enforce mode.
- **Attribution, not isolation.** The credential is in the session's environment, and every process of the agent account can read other sessions' environments and files. The project in the records says which credential was used, not which project acted, so per-project allow entries do not isolate projects from each other. Tools that print their proxy URL also print the credential.
- **Credential lifetime.** Session credentials last 30 days and host-command credentials one day. The proxy refuses credentials that claim more than 31 days. Rotating the key is the only revocation.
- **Observe resolves everything.** In observe mode the proxy resolves every name it is asked for; in enforce mode it resolves only listed names.
- **Launches without proxy variables.** Repository briefings and code graph extraction run through their own sudo wrappers, and the host does not give them proxy variables. In enforce mode their network calls fail. Check that these features can do without the network, or keep the firewall in observe, before enforcing.
- **One instance.** The rule matches `infinite-agent` only. A second instance's agent account is not covered, and its host account is not in the `infinite-egress` group. Cover it by adding its account to the rule and the group, or with a second proxy, key, and port.
- **Records hold destinations.** The journal and summary list every host each project reached. Members of `adm` and `systemd-journal` can read the journal; the agent account must not be one of them.
