#!/bin/sh
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
file_meta='root:root 644'
dir_meta='root:root 755'

sha256_of() {
  sha256sum "$1" | cut -d' ' -f1
}

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

safe_above() {
  above=$(dirname "$1")
  while :; do
    if [ -L "$above" ] || [ ! -d "$above" ]; then
      printf '%s is not a real directory' "$above"
      return 1
    fi
    if [ "$(stat -c '%u' "$above")" != 0 ] || [ $(( 0$(stat -c '%a' "$above") & 022 )) -ne 0 ]; then
      printf '%s is not root-owned or is group- or world-writable' "$above"
      return 1
    fi
    [ "$above" = / ] && return 0
    above=$(dirname "$above")
  done
}

dir_problem() {
  if [ -L "$1" ] || [ ! -d "$1" ]; then
    printf '%s is not a real directory' "$1"
    return 1
  fi
  if [ "$(stat -c '%u' "$1")" != 0 ] || [ $(( 0$(stat -c '%a' "$1") & 022 )) -ne 0 ]; then
    printf '%s is not root-owned or is group- or world-writable' "$1"
    return 1
  fi
  return 0
}

process() {
  template=$1
  target=$2
  dir=$(dirname "$target")
  want=$(sha256_of "$template")

  if ! problem=$(safe_above "$dir"); then
    printf 'unsafe: %s. Fix it before installing %s\n' "$problem" "$target" >&2
    if [ "$mode" = check ]; then differs=1; return; fi
    exit 1
  fi

  if [ "$mode" = check ]; then
    if [ ! -e "$dir" ] && [ ! -L "$dir" ]; then
      printf 'missing: %s (directory %s does not exist)\n' "$target" "$dir"
      differs=1
      return
    fi
    if ! problem=$(dir_problem "$dir"); then
      printf 'differs: %s; target not read\n' "$problem"
      differs=1
      return
    fi
    if [ ! -e "$target" ] && [ ! -L "$target" ]; then
      printf 'missing: %s\n' "$target"
      differs=1
      return
    fi
    if [ -L "$target" ] || [ ! -f "$target" ]; then
      printf 'differs: %s is not a regular file\n' "$target"
      differs=1
      return
    fi
    have=$(sha256_of "$target")
    meta=$(stat -c '%U:%G %a' "$target")
    above=$(stat -c '%U:%G %a' "$dir")
    if [ "$have" = "$want" ] && [ "$meta" = "$file_meta" ] && [ "$above" = "$dir_meta" ]; then
      printf 'ok: %s sha256 %s\n' "$target" "$have"
    else
      printf 'differs: %s sha256 %s (owner and mode %s; directory %s); template sha256 %s, expected %s in a %s directory\n' \
        "$target" "$have" "$meta" "$above" "$want" "$file_meta" "$dir_meta"
      differs=1
    fi
    return
  fi

  if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then
    printf '%s is not a real directory. Remove it and run this script again.\n' "$dir" >&2
    exit 1
  fi
  if [ ! -d "$dir" ]; then
    install -d -o root -g root -m 0755 "$dir"
  elif [ "$(stat -c '%U:%G %a' "$dir")" != "$dir_meta" ]; then
    chown root:root "$dir"
    chmod 0755 "$dir"
    printf 'Secured %s (root:root 0755). Another account could write it before. Remove any entry below that does not belong:\n' "$dir"
    ls -la "$dir"
  fi
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    printf '%s is a directory. Remove it and run this script again.\n' "$target" >&2
    exit 1
  fi

  if [ -f "$target" ] && [ ! -L "$target" ] && [ "$(sha256_of "$target")" = "$want" ] && [ "$(stat -c '%U:%G %a' "$target")" = "$file_meta" ]; then
    printf 'Unchanged %s\n' "$target"
  else
    if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
      printf 'Replacing %s, which was not a regular file. No copy was kept.\n' "$target"
    elif [ -f "$target" ]; then
      backup=$(mktemp "$target.before-ceilings-$stamp.XXXXXX")
      cat "$target" > "$backup"
      printf 'Kept previous copy at %s (root only)\n' "$backup"
    fi
    temporary=$(mktemp "$dir/.ceiling.XXXXXX")
    install -o root -g root -m 0644 "$template" "$temporary"
    mv -fT "$temporary" "$target"
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
