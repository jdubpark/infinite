#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run this installer as root.' >&2
  exit 1
fi

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
loader=$script_dir/agent-env.sh
. "$script_dir/agent-anchor.sh"
target=/usr/local/libexec/infinite
hook_line='[ -r /usr/local/libexec/infinite/agent-env.sh ] && . /usr/local/libexec/infinite/agent-env.sh && infinite_load_env /usr/local/libexec/infinite "${INFINITE_PROJECT_ID:-}"'

if [ ! -r "$loader" ]; then
  printf '%s\n' 'Missing deploy/ubuntu/agent-env.sh beside installer.' >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$target"
install -o root -g root -m 0755 "$loader" "$target/agent-env.sh"
printf '%s\n' "Installed $target/agent-env.sh (root:root 0755)."
install -d -o root -g infinite-agent -m 0750 "$target/secrets" "$target/projects"
printf '%s\n' "Ensured $target/secrets and $target/projects (root:infinite-agent 0750)."

reference=$script_dir/agent-wrapper.sh
for provider in claude codex codex-app-server grok opencode; do
  wrapper=$target/$provider
  if [ ! -f "$wrapper" ]; then
    printf '%s\n' "Skipped missing wrapper: $wrapper"
    continue
  fi
  state=$(infinite_wrapper_prefix_state "$wrapper" "$reference" || true)
  case $state in
    patched)
      printf '%s\n' "Already patched $wrapper (prefix verified against $reference)"
      continue ;;
    patchable*)
      anchor_line=${state#patchable}
      anchor_line=${anchor_line#?} ;;
    *)
      printf '%s\n' "Cannot patch $wrapper: its first lines differ from $reference up to 'export SHELL=/bin/bash'. Reconcile the wrapper with the shipped one by hand, then rerun." >&2
      exit 1 ;;
  esac

  timestamp=$(date +%Y%m%d%H%M%S)
  backup=$wrapper.before-agent-env-$timestamp
  temporary=$(mktemp "$wrapper.agent-env.XXXXXX")
  cp -p "$wrapper" "$backup"
  {
    head -n "$anchor_line" "$wrapper"
    printf '%s\n' "$hook_line"
    tail -n +"$((anchor_line + 1))" "$wrapper"
  } >"$temporary"
  # Keep the wrapper's owner, group (infinite-agent must stay able to run
  # it) and mode; the temporary file was created root:root.
  chown --reference="$wrapper" "$temporary"
  chmod --reference="$wrapper" "$temporary"
  if [ "$(infinite_wrapper_prefix_state "$temporary" "$reference")" != patched ]; then
    rm -f "$temporary"
    printf '%s\n' "Patched copy of $wrapper did not verify; not installed, backup kept at $backup" >&2
    exit 1
  fi
  mv -f "$temporary" "$wrapper"
  printf '%s\n' "Patched $wrapper; backup: $backup"
done
