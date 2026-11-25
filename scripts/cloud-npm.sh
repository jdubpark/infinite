#!/bin/sh
set -eu

script=$1
shift

if [ -f "${INFINITE_CLOUD_CHECK:-}" ] &&
   [ "$(cat "$INFINITE_CLOUD_CHECK")" = infinite-cloud-check-v1 ]; then
  exec sh -c "$script \"\$@\"" "$npm_lifecycle_event" "$@"
fi

exec python3 "$(dirname "$0")/cloud-check.py" --npm-script "$script" -- "$@"
