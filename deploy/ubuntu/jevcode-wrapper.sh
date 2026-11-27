#!/bin/sh
set -eu
umask 077
ulimit -c 0

WORKSPACES=/srv/infinite-data/workspaces
TEAM_WORKSPACES=/srv/infinite-data/team-workspaces
AGENT_HOME=/srv/infinite-data/agent-home

export HOME="$AGENT_HOME"
export TMPDIR=/srv/infinite-data/tmp/agent
export npm_config_store_dir=/srv/infinite-data/agent-home/.pnpm-store
export COREPACK_HOME=/srv/infinite-data/agent-home/.cache/corepack
export PATH=/opt/infinite-agents/v1/bin:/usr/local/bin:/usr/bin:/bin
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES

refuse() {
  printf 'jevcode request refused: %s\n' "$1" >&2
  exit 64
}

check_root_ancestors() {
  cursor=$1
  while [ "$cursor" != / ]; do
    case "$cursor" in
      */) cursor=${cursor%/} ;;
      *) break ;;
    esac
  done
  while [ "$cursor" != / ]; do
    if [ -L "$cursor" ]; then
      refuse 'symlinked root is not supported'
    fi
    cursor=${cursor%/*}
    if [ -z "$cursor" ]; then cursor=/; fi
  done
}

check_no_symlinks() {
  cursor=$1
  root=$2
  resolved_root=$3
  while :; do
    while [ "$cursor" != / ]; do
      case "$cursor" in
        */) cursor=${cursor%/} ;;
        *) break ;;
      esac
    done
    if [ "$cursor" = "$root" ] || [ "$cursor" = "$resolved_root" ] || [ "$cursor" = / ]; then
      break
    fi
    if [ -L "$cursor" ]; then
      refuse 'symlinked paths are not supported'
    fi
    cursor=${cursor%/*}
    if [ -z "$cursor" ]; then cursor=/; fi
  done
}

LAST_RESOLVED=
require_inside_roots() {
  candidate=$1
  shift
  case "$candidate" in
    /*) ;;
    *) refuse 'an absolute path is required' ;;
  esac
  case "$candidate" in
    *[[:cntrl:]]*) refuse 'invalid path characters' ;;
  esac
  case "/$candidate/" in
    */../*) refuse 'path is outside its assigned root' ;;
  esac
  resolved=$(/usr/bin/realpath -m -- "$candidate") || refuse 'cannot resolve path'
  for root in "$@"; do
    check_root_ancestors "$root"
    resolved_root=$(/usr/bin/realpath -m -- "$root") || refuse 'cannot resolve root'
    case "$resolved" in
      "$resolved_root"/*)
        check_no_symlinks "$candidate" "$root" "$resolved_root"
        LAST_RESOLVED=$resolved
        return 0
        ;;
    esac
  done
  refuse 'path is outside its assigned root'
}

check_token() {
  case "$1" in
    ''|-*|*[!A-Za-z0-9._-]*) refuse 'invalid option value' ;;
  esac
}

check_session() {
  case "$1" in
    ''|-*|*[!A-Za-z0-9._:-]*) refuse 'invalid session value' ;;
  esac
}

check_timeout() {
  case "$1" in
    ''|0*|*[!0-9]*) refuse 'invalid timeout value' ;;
  esac
  [ "${#1}" -le 12 ] || refuse 'invalid timeout value'
}

check_base() {
  case "$1" in
    ''|-*|/*|*[!A-Za-z0-9._/@^~-]*) refuse 'invalid base value' ;;
  esac
  case "/$1/" in
    */../*) refuse 'invalid base value' ;;
  esac
}

check_model() {
  case "$1" in
    ''|-*|/*|*[[:cntrl:]]*) refuse 'invalid model value' ;;
  esac
}

NL=$(printf '\nx')
NL=${NL%x}
PENDING_FOCUS=

record_focus() {
  val=$1
  case "$val" in
    '') return 0 ;;
    -*|*[[:cntrl:]]*) refuse 'invalid focus path' ;;
    /*) require_inside_roots "$val" "$WORKSPACES" "$TEAM_WORKSPACES" ;;
    *)
      case "/$val/" in
        */../*) refuse 'path is outside its assigned root' ;;
      esac
      PENDING_FOCUS="${PENDING_FOCUS:+$PENDING_FOCUS$NL}$val"
      ;;
  esac
}

seen_cmd=0
seen_repo=0
repo_path=
expect=
for arg in "$@"; do
  if [ -n "$expect" ]; then
    case "$expect" in
      repo)
        [ "$seen_repo" -eq 0 ] || refuse 'duplicate --repo option'
        require_inside_roots "$arg" "$WORKSPACES" "$TEAM_WORKSPACES"
        repo_path=$LAST_RESOLVED
        seen_repo=1
        ;;
      focus) record_focus "$arg" ;;
      token) check_token "$arg" ;;
      session) check_session "$arg" ;;
      timeout) check_timeout "$arg" ;;
      base) check_base "$arg" ;;
      model) check_model "$arg" ;;
      question) [ -n "$arg" ] || refuse 'empty question value' ;;
    esac
    expect=
    continue
  fi
  case "$arg" in
    auto|brief|context|show|prompt)
      [ "$seen_cmd" -eq 0 ] || refuse 'unexpected positional argument'
      seen_cmd=1
      ;;
    --activity-stdin|--no-state|--report-usage) ;;
    --repo) expect=repo ;;
    --repo=*)
      [ "$seen_repo" -eq 0 ] || refuse 'duplicate --repo option'
      require_inside_roots "${arg#--repo=}" "$WORKSPACES" "$TEAM_WORKSPACES"
      repo_path=$LAST_RESOLVED
      seen_repo=1
      ;;
    --log|--log=*) refuse '--log is not permitted; use --activity-stdin' ;;
    --focus) expect=focus ;;
    --focus=*) record_focus "${arg#--focus=}" ;;
    --trigger|--format|--runner) expect=token ;;
    --trigger=*) check_token "${arg#--trigger=}" ;;
    --format=*) check_token "${arg#--format=}" ;;
    --runner=*) check_token "${arg#--runner=}" ;;
    --session) expect=session ;;
    --session=*) check_session "${arg#--session=}" ;;
    --timeout) expect=timeout ;;
    --timeout=*) check_timeout "${arg#--timeout=}" ;;
    --base) expect=base ;;
    --base=*) check_base "${arg#--base=}" ;;
    --model) expect=model ;;
    --model=*) check_model "${arg#--model=}" ;;
    --question) expect=question ;;
    --question=*) [ -n "${arg#--question=}" ] || refuse 'empty question value' ;;
    *) refuse 'unsupported argument' ;;
  esac
done
if [ -n "$expect" ]; then
  refuse 'missing value for option'
fi
if [ "$seen_cmd" -eq 0 ]; then
  refuse 'missing command'
fi
if [ "$seen_repo" -eq 0 ]; then
  cwd=$(pwd -P) || refuse 'cannot resolve working directory'
  require_inside_roots "$cwd" "$WORKSPACES" "$TEAM_WORKSPACES"
  repo_path=$LAST_RESOLVED
fi
focus_base=$repo_path
if [ -e "$repo_path" ] && [ ! -d "$repo_path" ]; then
  refuse 'repository path must be a directory'
fi
if [ -d "$repo_path" ]; then
  git_top=$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null /usr/bin/git -c 'safe.directory=*' -C "$repo_path" rev-parse --show-toplevel 2>/dev/null) || git_top=
  if [ -n "$git_top" ]; then
    require_inside_roots "$git_top" "$WORKSPACES" "$TEAM_WORKSPACES"
    focus_base=$LAST_RESOLVED
    git_dir=$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null /usr/bin/git -c 'safe.directory=*' -C "$repo_path" rev-parse --path-format=absolute --git-dir 2>/dev/null) || refuse 'cannot resolve git directory'
    require_inside_roots "$git_dir" "$WORKSPACES" "$TEAM_WORKSPACES"
    git_common=$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null /usr/bin/git -c 'safe.directory=*' -C "$repo_path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || refuse 'cannot resolve git common directory'
    require_inside_roots "$git_common" "$WORKSPACES" "$TEAM_WORKSPACES"
  elif [ -e "$repo_path/.git" ] || [ -L "$repo_path/.git" ]; then
    refuse 'cannot resolve git repository'
  fi
fi
if [ -n "$PENDING_FOCUS" ]; then
  while IFS= read -r rel_focus; do
    [ -n "$rel_focus" ] || continue
    require_inside_roots "$focus_base/$rel_focus" "$WORKSPACES" "$TEAM_WORKSPACES"
  done <<EOF
$PENDING_FOCUS
EOF
fi
if [ -d "$repo_path" ]; then
  cd "$repo_path" || refuse 'cannot enter repository'
else
  cd / || refuse 'cannot change directory'
fi

check_root_ancestors "$AGENT_HOME"
key_file=$AGENT_HOME/.config/jevcode/jev-api-key
if [ ! -L "$AGENT_HOME/.config" ] && [ ! -L "$AGENT_HOME/.config/jevcode" ] && [ ! -L "$key_file" ] && [ -f "$key_file" ] && [ -r "$key_file" ]; then
  JEV_API_KEY=$(/bin/cat "$key_file")
  export JEV_API_KEY
fi

exec /usr/local/bin/node /opt/jevcode-repo-agent/dist/cli.js "$@"
