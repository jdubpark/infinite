#!/bin/sh
set -eu

case ${1:-} in
  */cloud-npm.sh)
    checkout=$(CDPATH= cd -- "$(dirname -- "$0")/../t" && pwd -P)
    if [ "$#" -ge 2 ] && [ -n "${npm_lifecycle_event:-}" ] &&
       [ "$(realpath -- "$1")" = "$checkout/scripts/cloud-npm.sh" ] &&
       [ "$(git rev-parse --show-toplevel 2>/dev/null || true)" = "$checkout" ]; then
      shift
      script=$1
      shift
      exec /bin/sh -c "$script \"\$@\"" "$npm_lifecycle_event" "$@"
    fi
    ;;
esac
exec /bin/sh "$@"
