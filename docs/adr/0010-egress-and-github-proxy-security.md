# ADR-0010: Egress Proxy Isolation and GitHub Credential Proxy Security

- **Status**: Accepted
- **Scope**: `scripts/egress-proxy.mjs`, `scripts/github-proxy.mjs`, `scripts/github-app-client.mjs`, `scripts/github-app-refresh.mjs`

## Context

Agent sessions and repository operations on the Ubuntu host require controlled outbound HTTP/HTTPS access and scoped GitHub operations without exposing long-lived credentials, GitHub App private keys, installation tokens, or internal/metadata network endpoints to untrusted agent code. Both proxies are implemented with the Node standard library only to eliminate third-party supply-chain surface in privileged boundary processes.

## Decisions

### 1. Egress proxy protocol, SSRF, and framing boundaries (`scripts/egress-proxy.mjs`)
- **No TLS termination**: The proxy tunnels `CONNECT` traffic and forwards absolute-form `http://` requests without terminating TLS, observing hostnames and ports only.
- **Stateless host-minted credentials**: `Proxy-Authorization` (`Basic PROJECT.SESSION:v1.EXPIRES.MAC`) is verified via HMAC-SHA256 matching `packages/host/src/egress.ts`. Lifetimes exceeding `MAX_CREDENTIAL_LIFETIME_SECONDS` (31 days) are rejected as not host-minted.
- **Host, port, and SSRF normalization**:
  - Authorities reject userinfo, delimiters, leading-zero ports, and IPv6 zone identifiers.
  - Any hostname whose final label is numeric is parsed through `legacyIPv4` (decimal, octal, hex, or shortened forms) and rejected if invalid, preventing resolver-dependent IPv4 smuggling.
  - IPv6 classification inspects embedded IPv4 addresses (IPv4-mapped, IPv4-compatible, NAT64 `64:ff9b::/96`), blocks everything outside global unicast (`2000::/3`), and blocks special-purpose blocks inside `2000::/3` (IETF protocol assignments `2001:0000::/23`, documentation `2001:0db8::/32` and `3fff::/20`, and 6to4 `2002::/16`).
- **Policy evaluation and DNS resolution**:
  - Wildcard rules (`*.`) require at least two domain labels (never TLDs or IP addresses).
  - In `enforce` mode, unlisted hosts are refused before any DNS lookup so disallowed names are never resolved.
  - Every resolved address for a permitted hostname is checked; any single refused address fails the destination (unless the `host:port` is explicitly in `allowPrivate`).
- **Request smuggling and prototype pollution defenses**:
  - Forwarded header maps use `Object.create(null)` so `constructor` or `__proto__` headers cannot pollute prototypes.
  - `requestFraming` accepts only framing the proxy can reproduce verbatim: a single decimal `Content-Length` or a sole `chunked` `Transfer-Encoding`; ambiguous headers are refused. `frameHeaders` sets `content-length: 0` explicitly on non-bodyless methods.
  - Plain HTTP protocol upgrades are refused (clients must use `CONNECT`), and each plain HTTP request uses a fresh `connection: close` upstream socket via `createConnection` pointing at the already-connected checked-IP socket with `host: entry.address` so Node never re-resolves.
- **Connect staggering, early data, and socket lifecycle**:
  - `connectUpstream` interleaves address families per RFC 8305, bounds concurrent upstream connection attempts at `MAX_ATTEMPTS_IN_FLIGHT = 4` (retiring the oldest pending socket to stay inside file-descriptor limits), and re-checks `socket.remoteAddress` on connect.
  - Bytes arriving with `CONNECT` (`head`) and before tunnel establishment count together toward `MAX_EARLY_BYTES` (64 KiB); the client socket stays in flowing mode before tunnel establishment so eager client closes/half-closes abort pending work immediately.
  - Refused sockets drain and discard client-sent bytes before closing to avoid TCP resets; clean upstream EOF calls `client.end()` with a bounded drain timeout while upstream errors call `client.destroy()`.
- **Bounded resource accounting and fail-safe logging**:
  - `acquire()`/`hold()` reference-counts tunnel slots across the client connection and every child operation (including timed-out DNS lookups, since system `getaddrinfo` cannot be cancelled), while deduplicating concurrent lookups per hostname.
  - Config, key, and policy reads verify ownership, mode, and `dev`/`ino` across `lstat` and `O_NOFOLLOW` `open` (`readChecked`); policy reload errors preserve the last valid policy; systemd socket activation (`LISTEN_FDS`) verifies loopback binding; `close()` yields one `setImmediate` tick before flushing summaries so final close records are captured. Log-emit errors in `say()` are caught so a failing log sink does not tear down live connections.

### 2. GitHub credential proxy, receive-pack inspection, and `gh` broker (`scripts/github-proxy.mjs`, `scripts/github-app-client.mjs`, `scripts/github-app-refresh.mjs`)
- **Grant verification and trusted files**:
  - Verifies `v2.<payload>.<mac>` grants via constant-time HMAC-SHA256 before parsing canonical base64url JSON; `v1` grants are refused as `grant-version` because `v2` introduced `project`.
  - `readTrustedFile` checks every directory component up to `/` (no symlinks, trusted owner, non-group/world-writable) before opening with `O_NOFOLLOW` and verifying `fstat`. `upstream` defaults to `https://github.com`, allowing loopback only for tests.
- **`git-receive-pack` inspection and forwarding**:
  - `ReceivePackInspector` incrementally parses `shallow` lines, the command list, optional push options, and the `PACK` header within fixed bounds (64 commands, 64 KiB command list, 512 KiB raw / 256 KiB decoded). Gzip streams are decoded one paused chunk at a time so network reads cannot outrun `zlib` limits.
  - Deletions-only pushes carry no `PACK` and finish inspection so `pushRefusal` rejects them as `delete-refused` and formats a Git side-band `refusalReport` (`! [remote rejected]`). Refused request bodies are drained and discarded.
  - Client disconnects before response completion (`res.once("close")` while `!res.writableFinished`) abort upstream requests even when the client request body had already finished; late upstream errors after client disconnect are ignored.
- **Extended POSIX ACL probing (`agentTokenAccess`, `getfaclProbe`)**:
  - Standard mode bits can prove that the agent user can read the token cache, but cannot prove it cannot (extended ACL entries grant named-user access and alter group-bit semantics). Confirming `"proxy-only"` therefore requires both denying mode bits and `/usr/bin/getfacl --skip-base` returning empty across all entries in batches of 200; any error, timeout, or oversized output yields `"unknown"`.
- **`gh` broker allowlist and PR target resolution (`createGhBroker`)**:
  - Only an explicit allowlist of `gh pr` subcommands and flags is accepted (blocking `--web`, `--editor`, `--body-file` paths, `--template`, `--recover`, `--fill`, `--jq` whose `$ENV` exposes `GH_TOKEN`, `--admin`, `--delete-branch`, `--auto`, and `--watch`).
  - Flag values resembling flags (`^--?[A-Za-z]`) must use `--flag=value`; all forwarded arguments pass as `--flag=value`.
  - Write subcommands (`ready`, `comment`, `merge`) resolve the PR via `gh pr view` first, verify `!isCrossRepository` and head branch coverage in `claims.refs`, and rewrite the selector to the resolved PR number. Token values and grant text are excluded from audit logs and redacted from `gh` output.
- **Client and refresher invariants**:
  - `github-app-client.mjs` only validates grant syntax from `INFINITE_GITHUB_GRANT` (never reads the grant key) and supplies the session grant—never an installation token—when Git queries credentials for the proxy origin.
  - `github-app-refresh.mjs` runs `invalidateWorkflowOptOuts` before key loading or discovery so revoked `workflows: write` caches are deleted immediately; cache filenames are SHA-256 hashes of repository names, never provider-controlled strings.

## Consequences

- Egress and GitHub credential boundaries enforce fail-closed parsing, SSRF checks, resource caps, and grant scoping without external npm dependencies.
- Inline prose comments in `scripts/egress-proxy.mjs`, `scripts/github-proxy.mjs`, `scripts/github-app-client.mjs`, and `scripts/github-app-refresh.mjs` are removed under `scripts/check-comments.mjs`.
