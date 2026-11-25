#!/bin/sh
set -eu
umask 077
ulimit -c 0

export TMPDIR=/srv/infinite-data/tmp/agent
export npm_config_store_dir=/srv/infinite-data/agent-home/.pnpm-store
export COREPACK_HOME=/srv/infinite-data/agent-home/.cache/corepack
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
export PATH=/usr/local/bin:/usr/bin:/bin
export SHELL=/bin/bash
[ -r /usr/local/libexec/infinite/agent-env.sh ] && . /usr/local/libexec/infinite/agent-env.sh && infinite_load_env /usr/local/libexec/infinite "${INFINITE_PROJECT_ID:-}"

provider=$(basename "$0")
case "$provider" in
  claude)
    if [ -n "${INFINITE_TRUSTED_WORKSPACE:-}" ]; then
      /usr/local/bin/node /opt/infinite/packages/host/dist/workspace-trust.js claude || true
    fi ;;
  codex)
    export npm_config_prefix=/opt/infinite-agents/v1
    set -- --no-daemon "$@"
    ;;
  codex-app-server|grok|opencode) ;;
  demo)
    exec /usr/local/bin/node /opt/infinite/packages/host/dist/demo.js "$@"
    ;;
  *) printf 'Unknown agent launcher\n' >&2; exit 64 ;;
esac
exec "/opt/infinite-agents/v1/bin/$provider" "$@"
