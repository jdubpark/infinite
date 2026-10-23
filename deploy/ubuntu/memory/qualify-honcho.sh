#!/bin/sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../../.." && pwd)
PROJECT="infinite-memory-qual-$$"
PRIVATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/infinite-memory-qual.XXXXXX")
HONCHO_TIKTOKEN_CACHE="$ROOT/.local/memory-specs/tiktoken-cache/runtime-cache"
export HONCHO_TIKTOKEN_CACHE
python3 - "$HONCHO_TIKTOKEN_CACHE" <<'PY'
import hashlib
import sys
import urllib.request
from pathlib import Path
directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
url = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"
cache_file = directory / hashlib.sha1(url.encode()).hexdigest()
expected = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"
if not cache_file.exists() or hashlib.sha256(cache_file.read_bytes()).hexdigest() != expected:
    data = urllib.request.urlopen(url, timeout=30).read()
    if hashlib.sha256(data).hexdigest() != expected:
        raise SystemExit("tokenizer data checksum mismatch")
    cache_file.write_bytes(data)
cache_file.chmod(0o644)
directory.chmod(0o755)
PY
chmod 700 "$PRIVATE_DIR"
cleanup() {
  STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    docker compose -f "$HERE/honcho.compose.yml" -p "$PROJECT" logs --no-color --tail=40 2>/dev/null \
      | python3 -c 'import functools,sys; s=functools.reduce(lambda text, secret: text.replace(secret, "[redacted]"), sys.argv[1:], sys.stdin.read()); sys.stdout.write(s)' \
        "$POSTGRES_PASSWORD" "$HONCHO_JWT_SECRET" "$HONCHO_DISABLED_MODEL_KEY"
  fi
  docker compose -f "$HERE/honcho.compose.yml" -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$PRIVATE_DIR"
  return "$STATUS"
}
trap cleanup EXIT HUP INT TERM

HONCHO_PORT=$(python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
)
POSTGRES_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
HONCHO_JWT_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
HONCHO_DISABLED_MODEL_KEY=qualification-disabled-no-external-provider
cat >"$PRIVATE_DIR/honcho.env" <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
HONCHO_JWT_SECRET=$HONCHO_JWT_SECRET
HONCHO_DISABLED_MODEL_KEY=$HONCHO_DISABLED_MODEL_KEY
HONCHO_PORT=$HONCHO_PORT
EOF
chmod 600 "$PRIVATE_DIR/honcho.env"
HONCHO_ENV_FILE="$PRIVATE_DIR/honcho.env"
export POSTGRES_PASSWORD HONCHO_JWT_SECRET HONCHO_DISABLED_MODEL_KEY HONCHO_PORT HONCHO_ENV_FILE

docker compose -f "$HERE/honcho.compose.yml" -p "$PROJECT" up -d --wait --wait-timeout 180
API_CONTAINER=$(docker compose -f "$HERE/honcho.compose.yml" -p "$PROJECT" ps -q api)
docker cp "$HERE/qualify_service.py" "$API_CONTAINER:/app/qualification.py"
docker compose -f "$HERE/honcho.compose.yml" -p "$PROJECT" exec -T \
  -e HONCHO_QUALIFICATION_URL="http://127.0.0.1:8000" api \
  /app/.venv/bin/python /app/qualification.py
