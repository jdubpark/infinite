#!/bin/sh
set -eu

if [ "$(id -un)" = infinite-agent ]; then
  exec /usr/local/bin/node /opt/infinite-github-auth/github-app-client.mjs \
    --config /etc/infinite-github/client.json gh -- "$@"
fi
exec /usr/bin/gh "$@"
