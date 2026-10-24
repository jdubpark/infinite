#!/usr/bin/env python3
"""Synthetic pinned-service auth and partition smoke check; performs no inference."""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def token(secret: str, workspace: str, expiry: int) -> str:
    header = b64url(b'{"alg":"HS256","typ":"JWT"}')
    payload = b64url(json.dumps({"w": workspace, "exp": expiry}, separators=(",", ":")).encode())
    signing = f"{header}.{payload}".encode()
    signature = b64url(hmac.new(secret.encode(), signing, hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def request(base: str, path: str, method: str = "GET", bearer: str | None = None, body: dict | None = None) -> tuple[int, bytes]:
    headers = {}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(f"{base.rstrip('/')}/{path.lstrip('/')}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read(64 * 1024 + 1)
    except urllib.error.HTTPError as error:
        return error.code, error.read(64 * 1024 + 1)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"FAIL: {message}")


def main() -> None:
    base = os.environ["HONCHO_QUALIFICATION_URL"]
    secret = os.environ["HONCHO_JWT_SECRET"]
    now = int(time.time())
    a, b, rebuilt = "synthetic-private-a", "synthetic-private-b", "synthetic-rebuild-a"
    token_a, token_b, token_rebuilt = (token(secret, value, now + 300) for value in (a, b, rebuilt))
    expired = token(secret, a, now - 60)

    status, _ = request(base, "/health")
    require(status == 200, f"health endpoint status was {status}")
    status, _ = request(base, "/v3/workspaces", "POST", token_a, {"id": a})
    require(status in (200, 201), f"workspace A creation status was {status}")
    status, _ = request(base, "/v3/workspaces", "POST", token_a, {"id": a})
    require(status in (200, 201), f"workspace A idempotent creation status was {status}")
    status, _ = request(base, "/v3/workspaces", "POST", token_b, {"id": b})
    require(status in (200, 201), f"workspace B creation status was {status}")

    marker = "synthetic memory partition marker"
    for workspace, workspace_token, session in ((a, token_a, "synthetic-session-a"), (b, token_b, "synthetic-session-b")):
        status, _ = request(base, f"/v3/workspaces/{workspace}/sessions", "POST", workspace_token, {"id": session})
        require(status in (200, 201), f"session create status was {status}")
        content = marker if workspace == a else "synthetic private B only"
        status, raw = request(base, f"/v3/workspaces/{workspace}/sessions/{session}/messages", "POST", workspace_token,
                              {"messages": [{"content": content, "peer_id": "synthetic-owner"}]})
        require(status == 201, f"synthetic message ingest status was {status}")
        created = json.loads(raw)
        require(isinstance(created, list) and len(created) == 1, "message ingest returned no single message")

    status, raw = request(base, f"/v3/workspaces/{a}/search", "POST", token_a, {"query": marker, "limit": 20})
    require(status == 200, f"keyword search A status was {status}")
    require(any(item.get("content") == marker for item in json.loads(raw)), "inference-disabled keyword search missed A's synthetic record")
    status, raw = request(base, f"/v3/workspaces/{b}/search", "POST", token_b, {"query": marker, "limit": 20})
    require(status == 200 and not json.loads(raw), "workspace B returned workspace A's synthetic record")

    status, _ = request(base, f"/v3/workspaces/{b}/search", "POST", token_a, {"query": "synthetic cross partition sentinel"})
    require(status in (401, 403), f"workspace A token reached workspace B search: {status}")
    status, _ = request(base, "/v3/workspaces", "POST", token_a, {"id": b})
    require(status in (401, 403), f"workspace A token created workspace B: {status}")
    status, _ = request(base, f"/v3/workspaces/{a}/queue/status", bearer=expired)
    require(status in (401, 403), f"expired workspace token was accepted: {status}")
    status, _ = request(base, "/v3/workspaces", "POST", body={"id": "synthetic-no-auth"})
    require(status in (401, 403), f"unauthenticated workspace creation was accepted: {status}")

    status, _ = request(base, f"/v3/workspaces/{a}/sessions/synthetic-session-a", "DELETE", token_a)
    require(status == 202, f"session deletion was not accepted asynchronously: {status}")
    status, _ = request(base, f"/v3/workspaces/{b}/sessions/synthetic-session-b", "DELETE", token_b)
    require(status == 202, f"workspace B session deletion was not accepted asynchronously: {status}")
    status, _ = request(base, f"/v3/workspaces/{a}", "DELETE", token_a)
    require(status == 202, f"workspace deletion was not accepted asynchronously: {status}")
    status, _ = request(base, f"/v3/workspaces/{b}", "DELETE", token_b)
    require(status == 202, f"workspace B deletion was not accepted asynchronously: {status}")
    status, _ = request(base, "/v3/workspaces", "POST", token_rebuilt, {"id": rebuilt})
    require(status in (200, 201), f"replacement workspace create status was {status}")
    session = "synthetic-rebuild-session"
    status, _ = request(base, f"/v3/workspaces/{rebuilt}/sessions", "POST", token_rebuilt, {"id": session})
    require(status in (200, 201), f"replacement generation session create status was {status}")
    status, _ = request(base, f"/v3/workspaces/{rebuilt}/sessions/{session}/messages", "POST", token_rebuilt,
                        {"messages": [{"content": marker, "peer_id": "synthetic-owner"}]})
    require(status == 201, f"replacement generation ingest status was {status}")
    status, raw = request(base, f"/v3/workspaces/{rebuilt}/search", "POST", token_rebuilt, {"query": marker, "limit": 20})
    require(status == 200 and any(item.get("content") == marker for item in json.loads(raw)), "replacement generation missed canonical synthetic evidence")
    status, _ = request(base, f"/v3/workspaces/{rebuilt}/sessions/{session}", "DELETE", token_rebuilt)
    require(status == 202, f"replacement session deletion was not accepted asynchronously: {status}")
    status, _ = request(base, f"/v3/workspaces/{rebuilt}", "DELETE", token_rebuilt)
    require(status == 202, f"replacement workspace deletion was not accepted asynchronously: {status}")
    print("PASS: pinned Honcho auth, isolated A/B partitions, inference-disabled keyword search, empty-generation replay, and async delete acceptance")
    print("LIMIT: no semantic retrieval, external model calls, host adapter generation CAS, physical purge completion, SDK client contract, scale/restore, or AGPL legal review")


if __name__ == "__main__":
    main()
