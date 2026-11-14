#!/bin/sh
# Install or check the provider ceilings: root-owned policy files that
# Claude Code and Codex read and that agents cannot change.
# Usage: sudo deploy/ubuntu/install-ceilings.sh [--check]
# No network access. Changes nothing with --check.
set -eu

usage() {
  printf '%s\n' 'Usage: install-ceilings.sh [--check]' >&2
  exit 2
}

mode=install
case ${1:-} in
  '') ;;
  --check) mode=check ;;
  *) usage ;;
esac
[ "$#" -le 1 ] || usage

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run this script as root (for example with sudo).' >&2
  exit 1
fi

script_dir=$(cd "$(dirname "$0")" && pwd)
templates=$script_dir/ceilings
stamp=$(date -u +%Y%m%dT%H%M%SZ)
differs=0

sha256_of() {
  sha256sum "$1" | cut -d' ' -f1
}

# Validate every template before any file is touched.
validate_json() {
  if ! python3 -I -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
if not isinstance(value, dict):
    raise SystemExit("top level must be a JSON object")
' "$1"; then
    printf 'Invalid JSON template, nothing installed: %s\n' "$1" >&2
    exit 1
  fi
}

validate_toml() {
  if ! python3 -I -c '
import sys, tomllib
with open(sys.argv[1], "rb") as handle:
    tomllib.load(handle)
' "$1"; then
    printf 'Invalid TOML template, nothing installed: %s\n' "$1" >&2
    exit 1
  fi
}

validate_json "$templates/managed-settings.json"
validate_toml "$templates/requirements.toml"

# process TEMPLATE TARGET: install TEMPLATE at TARGET, or report a difference.
process() {
  template=$1
  target=$2
  dir=$(dirname "$target")
  want=$(sha256_of "$template")
  ownership='root:root 644'

  if [ "$mode" = check ]; then
    if [ ! -f "$target" ]; then
      printf 'missing: %s\n' "$target"
      differs=1
      return
    fi
    have=$(sha256_of "$target")
    meta=$(stat -c '%U:%G %a' "$target")
    if [ "$have" = "$want" ] && [ "$meta" = "$ownership" ]; then
      printf 'ok: %s sha256 %s\n' "$target" "$have"
    else
      printf 'differs: %s sha256 %s (owner and mode %s); template sha256 %s, expected %s\n' \
        "$target" "$have" "$meta" "$want" "$ownership"
      differs=1
    fi
    return
  fi

  if [ -f "$target" ] && [ "$(sha256_of "$target")" = "$want" ] && [ "$(stat -c '%U:%G %a' "$target")" = "$ownership" ]; then
    printf 'Unchanged %s\n' "$target"
  else
    install -d -o root -g root -m 0755 "$dir"
    if [ -e "$target" ]; then
      backup=$target.before-ceilings-$stamp
      cp -p "$target" "$backup"
      printf 'Kept previous copy at %s\n' "$backup"
    fi
    # Write beside the target and rename, so a reader never sees a partial file.
    temporary=$(mktemp "$dir/.ceiling.XXXXXX")
    install -o root -g root -m 0644 "$template" "$temporary"
    mv -f "$temporary" "$target"
    printf 'Installed %s (root:root 0644)\n' "$target"
  fi
  printf 'sha256 %s %s\n' "$(sha256_of "$target")" "$target"
}

process "$templates/managed-settings.json" /etc/claude-code/managed-settings.json
process "$templates/requirements.toml" /etc/codex/requirements.toml

if [ "$mode" = check ]; then
  if [ "$differs" -ne 0 ]; then
    printf '%s\n' 'Ceilings differ from the shipped templates. Run install-ceilings.sh as root to install them.' >&2
    exit 1
  fi
  printf '%s\n' 'Ceilings match the shipped templates.'
fi
