#!/bin/sh
set -eu
umask 077
ulimit -c 0
if [ "$#" -ne 0 ]; then
  printf 'transcript-drain takes no arguments\n' >&2
  exit 64
fi
export PATH=/usr/local/bin:/usr/bin:/bin
exec /usr/local/bin/node /opt/infinite/packages/host/dist/hook-relay.js drain
