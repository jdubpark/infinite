#!/bin/sh
set -eu
umask 077
ulimit -c 0

# sudo -H sets HOME to the dedicated agent account's encrypted home.
export TMPDIR=/srv/infinite-data/tmp/agent
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
export PATH=/usr/local/bin:/usr/bin:/bin
# Service accounts keep a disabled login shell; native tool runners still need bash.
export SHELL=/bin/bash

provider=$(basename "$0")
case "$provider" in
  claude)
    export DISABLE_UPDATES=1
    export DISABLE_AUTOUPDATER=1
    ;;
  codex|codex-app-server|grok|opencode) ;;
  demo)
    exec /usr/local/bin/node /opt/infinite/packages/host/dist/demo.js "$@"
    ;;
  *) printf 'Unknown agent launcher\n' >&2; exit 64 ;;
esac
exec "/opt/infinite-agents/v1/bin/$provider" "$@"
