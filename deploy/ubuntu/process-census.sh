#!/bin/sh
# The process census: the host asks the agent account whether processes still use a run directory. It is
# read-only and takes no arguments. The directory arrives on standard input, one absolute path and a newline.
set -eu
umask 077
ulimit -c 0
if [ "$#" -ne 0 ]; then
  printf 'process-census takes no arguments\n' >&2
  exit 64
fi
export PATH=/usr/local/bin:/usr/bin:/bin
exec /usr/local/bin/node /opt/infinite/packages/host/dist/process-census.js
