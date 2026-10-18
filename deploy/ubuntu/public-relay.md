# Phone access without a VPN

This adds a public path for the phone app that does not need Tailscale on the phone. The server keeps its private Tailscale Serve endpoint for the laptop CLI. Nothing else becomes public.

```
phone ──HTTPS──▶ Cloudflare edge ──tunnel──▶ cloudflared ──unix socket──▶ relay ◀──127.0.0.1:4790── runner API (outbound)
        Access service token checked here     Access JWT checked here        ciphertext only
```

Three layers stop unwanted traffic before it costs the server anything:

1. **Cloudflare Access.** The phone sends a service token as `CF-Access-Client-Id` and `CF-Access-Client-Secret` on the WebSocket upgrade. Cloudflare rejects every request without it at the edge, so floods and scans never reach the server.
2. **cloudflared origin check.** The tunnel validates the Access JWT for this application before it forwards anything. A mistake in the Access policy does not open the relay.
3. **The relay.** It accepts only `/relay/hosts/:machineId` and `/relay/clients/:machineId` WebSockets and `/health`. It serves no web client and no runner API. Phone channels enter only through a mode-0600 Unix socket that cloudflared (root) can open and agent accounts cannot. The relay reads `CF-Connecting-IP` only on that socket, and limits upgrade attempts and concurrent channels per client address (per /64 for IPv6), per machine, and in total. The loopback TCP port serves only the runner's authenticated registration, so local processes cannot occupy phone slots.

The device key never crosses this path in the clear. The phone and runner authenticate each other and encrypt every request with the [remote transport](../../docs/security.md#remote-machine-transport); Cloudflare and the relay see only ciphertext, sizes, and timing. Cloudflare terminates TLS, so its operator is inside the same "untrusted router" boundary as the relay.

The server opens no inbound port for this. cloudflared makes outbound connections only, so the firewall rules in the [commissioning record](commissioning.md) stay as they are, and the server's address is not published through this hostname.

## Requirements

- A domain whose DNS is on Cloudflare, and a Cloudflare Zero Trust team (the free plan covers this).
- The host built from a release whose `relay-init` accepts `--proxy-socket`.
- A phone app build that has the **Access client ID** pairing fields.

The laptop CLI keeps using the private Tailscale address; it does not use the relay. The browser client cannot send upgrade headers and is for local development only.

## 1. Run the relay on loopback

Create a dedicated, login-less account and a private config directory:

```sh
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin infinite-relay
sudo install -d -o infinite-relay -g infinite-relay -m 0700 /etc/infinite-relay
sudo -u infinite-relay node /opt/infinite/packages/host/dist/cli.js relay-init \
  --config /etc/infinite-relay/relay.json --port 4790 \
  --proxy-socket /run/infinite-relay/proxy.sock --client-address-header cf-connecting-ip
```

Register the runner's machine ID (`machine-info` prints it). The registration key is written straight into the control account's private config directory:

```sh
sudo -u infinite-host node /opt/infinite/packages/host/dist/cli.js machine-info --config /etc/infinite/config.json
sudo node /opt/infinite/packages/host/dist/cli.js relay-add --machine MACHINE_UUID \
  --token-file /etc/infinite/relay-registration.key --config /etc/infinite-relay/relay.json
sudo chown infinite-relay:infinite-relay /etc/infinite-relay/relay.json
sudo chown infinite-host:infinite-host /etc/infinite/relay-registration.key
```

Install and start the unit, then confirm it listens only on loopback and its socket is private:

```sh
sudo install -o root -g root -m 0644 deploy/ubuntu/infinite-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now infinite-relay.service
ss -ltnp | grep 4790                      # 127.0.0.1:4790 only
sudo ls -l /run/infinite-relay/proxy.sock  # srw------- infinite-relay
```

Point the runner at the relay over loopback, not through Cloudflare, then restart the API (workers survive):

```sh
sudo -u infinite-host node /opt/infinite/packages/host/dist/cli.js connect-relay http://127.0.0.1:4790 \
  --token-file /etc/infinite/relay-registration.key --config /etc/infinite/config.json
sudo systemctl restart infinite.service
```

## 2. Create the Access application and service token

In Cloudflare Zero Trust:

1. **Access controls → Service credentials → Service tokens:** create a token named for the phone. Copy the client ID and secret now; the secret is shown once. Choose an expiry and note it.
2. **Access controls → Applications:** add a self-hosted application for `relay.example.com`. Add one policy with action **Service Auth** that includes only that service token. Do not add an Allow policy with an identity provider; nothing here is meant for a browser.
3. Copy the application's **AUD tag** and your team name for the tunnel config.

[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

## 3. Publish the relay through a tunnel

Install cloudflared from Cloudflare's package repository, then create a locally managed tunnel. `tunnel login` prints a URL to open on any device to authorize the domain.

```sh
cloudflared tunnel login
cloudflared tunnel create infinite-relay
cloudflared tunnel route dns infinite-relay relay.example.com
```

Move the generated credentials file and certificate into `/etc/cloudflared/` (mode 0600, root), write `/etc/cloudflared/config.yml` from [`cloudflared.example.yml`](cloudflared.example.yml) with the tunnel UUID, team name, and AUD tag, then validate and install the service:

```sh
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
sudo cloudflared --config /etc/cloudflared/config.yml service install
```

[Origin parameters: access](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/origin-parameters/)

## 4. Pair the phone

In the phone app, **Add machine**:

- Host or relay address: `https://relay.example.com`
- Relay machine ID: the runner's machine UUID
- Access client ID and secret: the service token from step 2
- Device key: the phone's controller or owner key (not the registration key)

All of these stay in the phone's secure storage.

## Verify

From a network outside the tailnet, with Tailscale off:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://relay.example.com/health                        # 403 or a login redirect: blocked at Cloudflare
curl -s -o /dev/null -w '%{http_code}\n' -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
  https://relay.example.com/health                                                                  # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET" \
  https://relay.example.com/                                                                        # 404: no web client
```

Then on the phone, with Tailscale off, open a session, read chat, and send a prompt. Confirm `ss -ltn` still shows no public listener for 4780 or 4790 and the firewall rules are unchanged. From an agent shell, `curl --unix-socket /run/infinite-relay/proxy.sock http://relay/health` must fail with a permission error. Keep `SECRET` out of shell history.

## Revoke or rotate

- Lost phone: revoke its device key with `device-revoke` and restart the API, and delete or rotate the service token in Cloudflare. Either one alone blocks access; do both.
- Token expiry: rotate the service token before it expires and update the phone's pairing. An expired token fails at Cloudflare and looks like an offline machine.
- Relay registration: remove the machine's entry from `/etc/infinite-relay/relay.json` and move the old `/etc/infinite/relay-registration.key` aside, then repeat the `relay-add` and both `chown` commands from step 1. `relay-add` rewrites the config as root, and the relay cannot start until it is owned by `infinite-relay` again. Restart the relay and the API.

## What this does not cover

Cloudflare can delay or drop traffic and sees connection metadata. If Cloudflare or the tunnel is down, this path is down; keep a second, direct Tailscale pairing on the phone for that case. Administrator SSH on port 22 remains public and is a separate hardening task.
