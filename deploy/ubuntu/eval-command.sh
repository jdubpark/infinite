#!/bin/sh
set -eu
ROOT=/var/lib/infinite-eval/root
ACCOUNT=infinite-eval
EVAL_HOME=/var/lib/infinite-eval/home
TEMPLATE=/usr/local/share/infinite-eval/home
EVAL_TMP=/var/lib/infinite-eval/tmp
LOGIN_PATHS=".claude/.credentials.json .codex/auth.json .local/share/opencode/auth.json"
STOP_DIRS="/tmp /var/tmp /dev/shm /dev/mqueue /run/lock /var/crash"
PRLIMIT_NPROC=512
SYSVIPC_DIR=/proc/sysvipc
STOP_KILL_MODE=kill
TRIALS=$ROOT/trials
TRIAL_DIR=
REAL_TRIAL=
CWD_TRIAL=
LC_ALL=C
PATH=/usr/bin:/bin
export LC_ALL PATH
umask 077

refuse() { exit 64; }
die() { exit 125; }

valid_trial() {
  H='[0-9a-f]'
  G4="$H$H$H$H"
  # shellcheck disable=SC2254
  case "$1" in
    $G4$G4-$G4-$G4-$G4-$G4$G4$G4) return 0 ;;
  esac
  return 1
}

valid_object() {
  case "$1" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]
}

valid_count() {
  case "$1" in
    ''|*[!0-9]*|0?*) return 1 ;;
  esac
  [ "${#1}" -le 12 ]
}

tools_present() {
  for tool in /usr/bin/timeout /usr/bin/prlimit /usr/bin/env /usr/bin/git /usr/bin/realpath /usr/bin/find \
    /usr/bin/cmp /usr/bin/head /usr/bin/stat /usr/bin/cp /usr/bin/chmod /usr/bin/rm /usr/bin/mv /usr/bin/sleep \
    /usr/bin/id /usr/bin/wc /usr/bin/ipcs /usr/bin/ipcrm /bin/mkdir /bin/bash; do
    if [ ! -x "$tool" ]; then
      return 1
    fi
  done
  return 0
}

make_dir() {
  if [ -L "$2" ]; then refuse; fi
  if [ ! -e "$2" ]; then /bin/mkdir -m "$1" -- "$2" || die; fi
  if [ ! -d "$2" ]; then refuse; fi
}

confined() {
  real=$(/usr/bin/realpath -e -- "$1") || die
  case "$real" in
    "$REAL_TRIAL"|"$REAL_TRIAL"/*) ;;
    *) refuse ;;
  esac
}

setup_trial() {
  valid_trial "$1" || refuse
  make_dir 711 "$TRIALS"
  TRIAL_DIR=$TRIALS/$1
  make_dir 711 "$TRIAL_DIR"
  make_dir 700 "$TRIAL_DIR/in"
  make_dir 700 "$TRIAL_DIR/tmp"
  REAL_TRIAL=$(/usr/bin/realpath -e -- "$TRIAL_DIR") || die
  confined "$TRIAL_DIR/in"
  confined "$TRIAL_DIR/tmp"
}

cwd_trial() {
  if [ -L "$TRIALS" ]; then refuse; fi
  real=$(/usr/bin/realpath -e -- .) || refuse
  case "$real" in
    "$ROOT"/trials/*/work|"$ROOT"/trials/*/work/*) ;;
    *) refuse ;;
  esac
  CWD_TRIAL=${real#"$ROOT"/trials/}
  CWD_TRIAL=${CWD_TRIAL%%/*}
  valid_trial "$CWD_TRIAL" || refuse
}

git_run() {
  seconds=$1
  gitproxy=$2
  shift 2
  set -- /usr/bin/timeout "$seconds" "$@"
  if [ -n "$gitproxy" ]; then
    set -- HTTPS_PROXY="$gitproxy" HTTP_PROXY="$gitproxy" https_proxy="$gitproxy" http_proxy="$gitproxy" \
      NO_PROXY=localhost,127.0.0.1,::1 "$@"
  fi
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$EVAL_HOME" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 \
    "$@"
}

run_trial() {
  trial=$1
  proxy=$2
  shift 2
  set -- /usr/bin/timeout --kill-after=10 3600 "$@"
  if [ -n "$proxy" ]; then
    set -- HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" https_proxy="$proxy" http_proxy="$proxy" \
      NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1 NODE_USE_ENV_PROXY=1 "$@"
  fi
  set -- /usr/bin/env -i \
    PATH=/usr/local/bin:/usr/bin:/bin HOME="$EVAL_HOME" TMPDIR="$TRIALS/$trial/tmp" \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 \
    "$@"
  if [ "$PRLIMIT_NPROC" = off ]; then
    set -- /usr/bin/prlimit --fsize=4294967296 --core=0 --nofile=4096 "$@"
  else
    set -- /usr/bin/prlimit --nproc="$PRLIMIT_NPROC" --fsize=4294967296 --core=0 --nofile=4096 "$@"
  fi
  status=0
  "$@" || status=$?
  if [ "$status" -eq 137 ]; then exit 124; fi
  exit "$status"
}

op_probe() {
  url=
  if [ "${1-}" = --fetch ]; then
    [ $# -ge 2 ] || refuse
    url=$2
    case "$url" in
      https://*|http://*) ;;
      *) refuse ;;
    esac
    shift 2
  fi
  [ "${1-}" = -- ] || refuse
  shift
  fetch=skipped
  if [ -n "$url" ]; then
    proxy=$(/usr/bin/head -n 1 | /usr/bin/head -c 2048)
    fetch=refused
    cd "$ROOT" || die
    if git_run 15 "" /usr/bin/git ls-remote --exit-code -- "$url" HEAD >/dev/null 2>&1; then
      fetch=open
    elif [ -n "$proxy" ] && git_run 15 "$proxy" /usr/bin/git ls-remote --exit-code -- "$url" HEAD \
      >/dev/null 2>&1; then
      fetch=open
    fi
  fi
  readable=
  for canary in "$@"; do
    if [ -r "$canary" ]; then value=true; else value=false; fi
    readable="${readable:+$readable,}$value"
  done
  uid=$(/usr/bin/id -u)
  mode=$(/usr/bin/stat -c %a -- "$ROOT")
  owner=$(/usr/bin/stat -c %u -- "$ROOT")
  avail=$(/usr/bin/stat -f -c %a -- "$ROOT")
  bsize=$(/usr/bin/stat -f -c %S -- "$ROOT")
  inodes=$(/usr/bin/stat -f -c %d -- "$ROOT")
  ancestors=false
  p=$ROOT
  while [ "$p" != / ]; do
    p=${p%/*}
    if [ -z "$p" ]; then p=/; fi
    if [ -w "$p" ]; then ancestors=true; break; fi
  done
  tools=false
  if tools_present; then tools=true; fi
  if /usr/bin/timeout 2 /bin/bash -c 'exec 3<>/dev/tcp/169.254.169.254/80' >/dev/null 2>&1; then
    meta=open
  else
    meta=closed
  fi
  trials=$(count_entries "$TRIALS")
  leftovers=$(count_leftovers)
  printf '{"version":1,"uid":%s,"root":"%s","rootMode":"%s","rootOwner":%s,"readable":[%s],"metadata":"%s",' \
    "$uid" "$ROOT" "$mode" "$owner" "$readable" "$meta"
  printf '"freeBytes":%s,"freeInodes":%s,"ancestorsWritable":%s,"tools":%s,"trials":%s,"leftovers":%s,"fetch":"%s"}\n' \
    "$((avail * bsize))" "$inodes" "$ancestors" "$tools" "$trials" "$leftovers" "$fetch"
}

count_entries() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    /usr/bin/find "$1" -mindepth 1 -maxdepth 1 -printf x | /usr/bin/wc -c
  else
    printf 0
  fi
}

keep_path() {
  for login in $LOGIN_PATHS; do
    case "$login" in
      "$1"|"$1"/*) return 0 ;;
    esac
  done
  [ -e "$TEMPLATE/$1" ] || [ -L "$TEMPLATE/$1" ]
}

count_leftovers() {
  count=0
  if [ -d "$EVAL_HOME" ] && [ ! -L "$EVAL_HOME" ]; then
    while IFS= read -r rel; do
      if [ -z "$rel" ]; then continue; fi
      if ! keep_path "$rel"; then count=$((count + 1)); fi
    done <<EOF
$(/usr/bin/find "$EVAL_HOME" -mindepth 1 -printf '%P\n' | /usr/bin/head -n 10000)
EOF
  fi
  if [ -d "$TEMPLATE" ] && [ ! -L "$TEMPLATE" ]; then
    while IFS= read -r rel; do
      if [ -z "$rel" ]; then continue; fi
      if ! /usr/bin/cmp -s -- "$TEMPLATE/$rel" "$EVAL_HOME/$rel"; then count=$((count + 1)); fi
    done <<EOF
$(/usr/bin/find "$TEMPLATE" -mindepth 1 -type f -printf '%P\n' | /usr/bin/head -n 10000)
EOF
  fi
  extra=$(count_root_others)
  count=$((count + extra))
  extra=$(count_entries "$EVAL_TMP")
  count=$((count + extra))
  extra=$(count_obstructions)
  count=$((count + extra))
  extra=$(count_account_state)
  count=$((count + extra))
  if [ "$count" -gt 10000 ]; then count=10000; fi
  printf '%s' "$count"
}

count_account_state() {
  n=0
  uid=$(/usr/bin/id -u)
  for kind in m s q; do
    if ids=$(ipc_ids "$kind"); then
      for ipc_obj in $ids; do n=$((n + 1)); done
    else
      n=$((n + 1))
    fi
  done
  set -f
  # shellcheck disable=SC2086
  for dir in $STOP_DIRS; do
    if [ -d "$dir" ]; then
      found=$(/usr/bin/find "$dir" -xdev -mindepth 1 -user "$uid" -printf x 2>/dev/null | /usr/bin/head -c 10000 | /usr/bin/wc -c)
      n=$((n + found))
    fi
  done
  set +f
  printf '%s' "$n"
}

count_root_others() {
  /usr/bin/find "$ROOT" -mindepth 1 -maxdepth 1 ! -name trials -printf x | /usr/bin/wc -c
}

count_obstructions() {
  n=0
  for login in $LOGIN_PATHS; do
    prefix=
    rest=$login
    while [ -n "$rest" ]; do
      part=${rest%%/*}
      if [ "$part" = "$rest" ]; then rest=; else rest=${rest#*/}; fi
      prefix=${prefix:+$prefix/}$part
      path=$EVAL_HOME/$prefix
      if [ -z "$rest" ]; then
        if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then n=$((n + 1)); fi
      elif [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
        n=$((n + 1))
        break
      fi
    done
  done
  printf '%s' "$n"
}

clear_obstructions() {
  for login in $LOGIN_PATHS; do
    prefix=
    rest=$login
    while [ -n "$rest" ]; do
      part=${rest%%/*}
      if [ "$part" = "$rest" ]; then rest=; else rest=${rest#*/}; fi
      prefix=${prefix:+$prefix/}$part
      path=$EVAL_HOME/$prefix
      if [ -z "$rest" ]; then
        if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then /usr/bin/rm -rf -- "$path"; fi
      elif [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
        /usr/bin/rm -f -- "$path"
        break
      fi
    done
  done
}

op_receive() {
  [ $# -eq 2 ] || refuse
  valid_count "$2" || refuse
  setup_trial "$1"
  dest=$TRIAL_DIR/in/base.bundle
  if [ -L "$dest" ] || [ -d "$dest" ]; then refuse; fi
  tmp=$TRIAL_DIR/in/.receive.$$
  /usr/bin/head -c "$(( $2 + 1 ))" > "$tmp" || { /usr/bin/rm -f -- "$tmp"; die; }
  size=$(/usr/bin/stat -c %s -- "$tmp")
  if [ "$size" -gt "$2" ]; then
    /usr/bin/rm -f -- "$tmp"
    exit 3
  fi
  /usr/bin/mv -f -T -- "$tmp" "$dest"
}

op_prepare() {
  [ $# -eq 1 ] || refuse
  setup_trial "$1"
  [ -f "$TRIAL_DIR/in/base.bundle" ] && [ ! -L "$TRIAL_DIR/in/base.bundle" ] || refuse
  [ ! -e "$TRIAL_DIR/work" ] && [ ! -L "$TRIAL_DIR/work" ] || refuse
  cd "$TRIAL_DIR" || die
  git_run 600 "" /usr/bin/git clone --quiet --template= --no-checkout --branch trial -- in/base.bundle work || die
  git_run 600 "" /usr/bin/git -C work remote remove origin || die
  git_run 600 "" /usr/bin/git -C work -c advice.detachedHead=false checkout --quiet --detach trial || die
  git_run 600 "" /usr/bin/git -C work branch -D trial || die
  /usr/bin/rm -rf -- in
  /usr/bin/chmod 0711 work
}

op_check() {
  [ $# -ge 2 ] || refuse
  valid_trial "$1" || refuse
  [ "$2" = -- ] || refuse
  trial=$1
  shift 2
  [ $# -le 200 ] || refuse
  for object in "$@"; do
    valid_object "$object" || refuse
  done
  work=$TRIALS/$trial/work
  if [ -L "$TRIALS" ] || [ -L "$work" ] || [ ! -d "$work" ]; then refuse; fi
  for object in "$@"; do
    if git_run 60 "" /usr/bin/git -C "$work" cat-file -e "$object" >/dev/null 2>&1; then exit 1; fi
  done
  if [ -n "$(git_run 60 "" /usr/bin/git -C "$work" remote)" ]; then exit 1; fi
}

op_exec() {
  [ "${1-}" = -- ] || refuse
  shift
  [ $# -ge 1 ] || refuse
  cwd_trial
  run_trial "$CWD_TRIAL" "" "$@"
}

op_setup() {
  [ "${1-}" = -- ] || refuse
  shift
  [ $# -ge 1 ] || refuse
  cwd_trial
  proxy=$(/usr/bin/head -n 1 | /usr/bin/head -c 2048)
  case "$proxy" in
    ''|http://*|https://*) ;;
    *) refuse ;;
  esac
  run_trial "$CWD_TRIAL" "$proxy" "$@" </dev/null
}

ipc_ids() {
  ipc_uid=$(/usr/bin/id -u)
  case "$1" in
    m) ipc_table=$SYSVIPC_DIR/shm ;;
    s) ipc_table=$SYSVIPC_DIR/sem ;;
    q) ipc_table=$SYSVIPC_DIR/msg ;;
    *) return 1 ;;
  esac
  [ -r "$ipc_table" ] || return 1
  listing=$(/usr/bin/head -c 4194305 "$ipc_table" 2>/dev/null) || return 1
  [ "${#listing}" -lt 4194304 ] || return 1
  ipc_column=0
  ipc_creator=0
  ipc_header=1
  while read -r ipc_line; do
    set -f
    # shellcheck disable=SC2086
    set -- $ipc_line
    set +f
    if [ "$ipc_header" = 1 ]; then
      ipc_header=0
      ipc_index=0
      for ipc_name in "$@"; do
        ipc_index=$((ipc_index + 1))
        if [ "$ipc_name" = uid ]; then ipc_column=$ipc_index; fi
        if [ "$ipc_name" = cuid ]; then ipc_creator=$ipc_index; fi
      done
      [ "$ipc_column" -gt 2 ] && [ "$ipc_creator" -gt "$ipc_column" ] || return 1
      continue
    fi
    [ $# -ge "$ipc_creator" ] || continue
    ipc_id=$2
    shift $((ipc_column - 1))
    ipc_owner=$1
    shift $((ipc_creator - ipc_column))
    [ "$ipc_owner" = "$ipc_uid" ] || [ "$1" = "$ipc_uid" ] || continue
    case "$ipc_id" in
      ''|*[!0-9]*) continue ;;
    esac
    printf '%s\n' "$ipc_id"
  done <<EOF
$listing
EOF
}

op_stop() {
  [ $# -eq 0 ] || refuse
  case "$STOP_KILL_MODE" in
    kill)
      kill -KILL -1 2>/dev/null || true
      /usr/bin/sleep 1
      ;;
    skip) ;;
    refuse) exit 99 ;;
    *) refuse ;;
  esac
  uid=$(/usr/bin/id -u)
  status=0
  for kind in m s q; do
    ids=$(ipc_ids "$kind") || { status=1; continue; }
    for ipc_obj in $ids; do
      /usr/bin/ipcrm "-$kind" "$ipc_obj" 2>/dev/null || true
    done
    left=$(ipc_ids "$kind") || { status=1; continue; }
    if [ -n "$left" ]; then status=1; fi
  done
  set -f
  # shellcheck disable=SC2086
  for dir in $STOP_DIRS; do
    if [ -d "$dir" ]; then
      /usr/bin/find "$dir" -xdev -type d -user "$uid" ! -perm -u=rwx -exec /usr/bin/chmod u+rwx -- {} \; 2>/dev/null || true
      /usr/bin/find "$dir" -xdev -mindepth 1 -user "$uid" -prune -exec /usr/bin/rm -rf -- {} + 2>/dev/null || true
      if [ -n "$(/usr/bin/find "$dir" -xdev -mindepth 1 -user "$uid" -print -quit 2>/dev/null)" ]; then
        status=1
      fi
    fi
  done
  set +f
  exit "$status"
}

open_tree() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    /usr/bin/find "$1" -xdev -type d ! -perm -u=rwx -exec /usr/bin/chmod u+rwx -- {} \; 2>/dev/null || true
  fi
}

# shellcheck disable=SC2016
CLEAN_SCRIPT='
set -e
open_tree() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    /usr/bin/find "$1" -xdev -type d ! -perm -u=rwx -exec /usr/bin/chmod u+rwx -- {} \; 2>/dev/null || true
  fi
}
open_tree "$1"
open_tree "$3"
/usr/bin/find "$1" -mindepth 1 -maxdepth 1 ! -name trials -exec /usr/bin/rm -rf -- {} +
for tree in "$2" "$3"; do
  if [ -d "$tree" ] && [ ! -L "$tree" ]; then
    /usr/bin/find "$tree" -mindepth 1 -maxdepth 1 -exec /usr/bin/rm -rf -- {} +
  fi
done
'
op_clean() {
  [ $# -eq 0 ] || refuse
  if [ -L "$TRIALS" ] || { [ -e "$TRIALS" ] && [ ! -d "$TRIALS" ]; }; then
    /usr/bin/rm -f -- "$TRIALS" || die
    make_dir 711 "$TRIALS"
  fi
  /usr/bin/timeout 600 /bin/sh -c "$CLEAN_SCRIPT" clean "$ROOT" "$TRIALS" "$EVAL_TMP"
}

op_scrub() {
  [ $# -eq 0 ] || refuse
  if [ ! -d "$TEMPLATE" ] || [ -L "$TEMPLATE" ]; then die; fi
  if [ ! -d "$EVAL_HOME" ] || [ -L "$EVAL_HOME" ]; then die; fi
  open_tree "$EVAL_HOME"
  clear_obstructions
  set --
  for login in $LOGIN_PATHS; do
    keep=$login
    while [ -n "$keep" ]; do
      set -- "$@" '!' -path "$EVAL_HOME/$keep"
      case "$keep" in
        */*) keep=${keep%/*} ;;
        *) keep= ;;
      esac
    done
  done
  set -- "$@" -exec /usr/bin/rm -rf -- '{}' +
  /usr/bin/timeout 60 /usr/bin/find "$EVAL_HOME" -mindepth 1 -depth "$@"
  /usr/bin/timeout 60 /usr/bin/cp -R -- "$TEMPLATE/." "$EVAL_HOME/"
}

valid_abs_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    /|*/|*[[:cntrl:]\"\\]*) return 1 ;;
  esac
  case "/$1/" in
    */../*) return 1 ;;
  esac
  return 0
}

allow_test_overrides() {
  [ "$(/usr/bin/id -u)" -ne 0 ] || return 1
  [ "$(/usr/bin/id -un)" != "$ACCOUNT" ] || return 1
  [ -z "${SUDO_USER+set}" ] && [ -z "${SUDO_UID+set}" ] && [ -z "${SUDO_GID+set}" ] && [ -z "${SUDO_COMMAND+set}" ] || return 1
  [ -z "${DOAS_USER+set}" ] && [ -z "${PKEXEC_UID+set}" ] || return 1
  self_real=$(/usr/bin/realpath -e -- "$0" 2>/dev/null) || return 1
  case "$self_real" in
    /usr/local/libexec/*|/usr/local/sbin/*|/usr/libexec/*|/usr/sbin/*|/sbin/*|/usr/bin/*|/bin/*|/opt/infinite*) return 1 ;;
  esac
  return 0
}

load_test_overrides() {
  if allow_test_overrides; then
    if [ "${INFINITE_EVAL_TEST_ROOT+set}" = set ]; then
      valid_abs_path "$INFINITE_EVAL_TEST_ROOT" || refuse
      ROOT=$INFINITE_EVAL_TEST_ROOT
    fi
    if [ "${INFINITE_EVAL_TEST_ACCOUNT+set}" = set ]; then
      case "$INFINITE_EVAL_TEST_ACCOUNT" in
        ''|root|*[!A-Za-z0-9._-]*) refuse ;;
      esac
      ACCOUNT=$INFINITE_EVAL_TEST_ACCOUNT
    fi
    if [ "${INFINITE_EVAL_TEST_HOME+set}" = set ]; then
      valid_abs_path "$INFINITE_EVAL_TEST_HOME" || refuse
      EVAL_HOME=$INFINITE_EVAL_TEST_HOME
    fi
    if [ "${INFINITE_EVAL_TEST_TEMPLATE+set}" = set ]; then
      valid_abs_path "$INFINITE_EVAL_TEST_TEMPLATE" || refuse
      TEMPLATE=$INFINITE_EVAL_TEST_TEMPLATE
    fi
    if [ "${INFINITE_EVAL_TEST_TMP+set}" = set ]; then
      valid_abs_path "$INFINITE_EVAL_TEST_TMP" || refuse
      EVAL_TMP=$INFINITE_EVAL_TEST_TMP
    fi
    if [ "${INFINITE_EVAL_TEST_STOP_DIRS+set}" = set ]; then
      stop_count=0
      set -f
      # shellcheck disable=SC2086
      for stop_dir in $INFINITE_EVAL_TEST_STOP_DIRS; do
        valid_abs_path "$stop_dir" || { set +f; refuse; }
        stop_count=$((stop_count + 1))
      done
      set +f
      [ "$stop_count" -ge 1 ] || refuse
      STOP_DIRS=$INFINITE_EVAL_TEST_STOP_DIRS
    fi
    if [ "${INFINITE_EVAL_TEST_PRLIMIT_NPROC+set}" = set ]; then
      case "$INFINITE_EVAL_TEST_PRLIMIT_NPROC" in
        off) PRLIMIT_NPROC=off ;;
        *)
          valid_count "$INFINITE_EVAL_TEST_PRLIMIT_NPROC" && [ "$INFINITE_EVAL_TEST_PRLIMIT_NPROC" -ge 1 ] || refuse
          PRLIMIT_NPROC=$INFINITE_EVAL_TEST_PRLIMIT_NPROC
          ;;
      esac
    fi
    if [ "${INFINITE_EVAL_TEST_SYSVIPC_DIR+set}" = set ]; then
      valid_abs_path "$INFINITE_EVAL_TEST_SYSVIPC_DIR" || refuse
      SYSVIPC_DIR=$INFINITE_EVAL_TEST_SYSVIPC_DIR
    fi
    if [ "${INFINITE_EVAL_TEST_STOP_KILL_MODE+set}" = set ]; then
      case "$INFINITE_EVAL_TEST_STOP_KILL_MODE" in
        kill|skip|refuse) STOP_KILL_MODE=$INFINITE_EVAL_TEST_STOP_KILL_MODE ;;
        *) refuse ;;
      esac
    fi
  fi
  unset INFINITE_EVAL_TEST_ROOT INFINITE_EVAL_TEST_ACCOUNT INFINITE_EVAL_TEST_HOME \
    INFINITE_EVAL_TEST_TEMPLATE INFINITE_EVAL_TEST_TMP INFINITE_EVAL_TEST_STOP_DIRS \
    INFINITE_EVAL_TEST_PRLIMIT_NPROC INFINITE_EVAL_TEST_SYSVIPC_DIR INFINITE_EVAL_TEST_STOP_KILL_MODE
}

load_test_overrides
TRIALS=$ROOT/trials

[ "$(/usr/bin/id -un)" = "$ACCOUNT" ] || refuse
[ "$(/usr/bin/id -u)" -ne 0 ] || refuse
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || refuse
[ "$(/usr/bin/stat -c '%a %u' -- "$ROOT")" = "711 $(/usr/bin/id -u)" ] || refuse

if [ $# -eq 0 ]; then refuse; fi
op=$1
shift
case "$op" in
  probe|stop) ;;
  *) tools_present || die ;;
esac
case "$op" in
  exec|setup) ;;
  *) cd / || die ;;
esac
case "$op" in
  probe) op_probe "$@" ;;
  receive) op_receive "$@" ;;
  prepare) op_prepare "$@" ;;
  check) op_check "$@" ;;
  exec) op_exec "$@" ;;
  setup) op_setup "$@" ;;
  stop) op_stop "$@" ;;
  clean) op_clean "$@" ;;
  scrub) op_scrub "$@" ;;
  *) refuse ;;
esac
