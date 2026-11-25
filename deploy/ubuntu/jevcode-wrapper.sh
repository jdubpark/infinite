#!/bin/sh
set -eu
umask 077
ulimit -c 0

export TMPDIR=/srv/infinite-data/tmp/agent
export npm_config_store_dir=/srv/infinite-data/agent-home/.pnpm-store
export COREPACK_HOME=/srv/infinite-data/agent-home/.cache/corepack
export PATH=/opt/infinite-agents/v1/bin:/usr/local/bin:/usr/bin:/bin

if [ -r "$HOME/.config/jevcode/jev-api-key" ]; then
  JEV_API_KEY=$(cat "$HOME/.config/jevcode/jev-api-key")
  export JEV_API_KEY
fi

exec /usr/local/bin/node /opt/jevcode-repo-agent/dist/cli.js "$@"
