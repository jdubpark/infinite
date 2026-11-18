#!/bin/sh
# Launcher for the eval account, which runs the member of a replay trial. The host reaches it only through sudo
# (deploy/ubuntu/eval.sudoers), and it runs one operation as ACCOUNT under ROOT. The owner sets ROOT, ACCOUNT,
# EVAL_HOME, TEMPLATE, and EVAL_TMP at install and changes nothing else. EVAL_TMP is the eval wrapper's TMPDIR, and
# the two must be equal.
#
# Operations: probe [--fetch URL] -- [CANARY...] | receive TRIAL MAXBYTES | prepare TRIAL
#             | check TRIAL -- OBJECT... | exec -- ARGV... | setup -- ARGV... | stop | clean | scrub
# Exit codes: 0 done; 1 check found an object or a remote; 3 over the byte limit (receive); 64 refused before a
# child starts; 124 the time limit of exec or setup; 125 a launcher failure before a child starts. In exec and setup,
# once the child has started, its status.
set -eu
ROOT=/var/lib/infinite-eval/root
ACCOUNT=infinite-eval
EVAL_HOME=/var/lib/infinite-eval/home
TEMPLATE=/usr/local/share/infinite-eval/home
EVAL_TMP=/var/lib/infinite-eval/tmp
LOGIN_PATHS=".claude/.credentials.json .codex/auth.json .local/share/opencode/auth.json"
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

# Exactly 8-4-4-4-12 lowercase hex digits.
valid_trial() {
  H='[0-9a-f]'
  G4="$H$H$H$H"
  # The hex classes are a glob on purpose.
  # shellcheck disable=SC2254
  case "$1" in
    $G4$G4-$G4-$G4-$G4-$G4$G4$G4) return 0 ;;
  esac
  return 1
}

# A full commit or tree id: 40 or 64 lowercase hex digits.
valid_object() {
  case "$1" in
    ''|*[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]
}

# Digits only, at most 12 of them, so the arithmetic below cannot overflow. A leading zero is refused,
# because sh arithmetic reads 010 as octal.
valid_count() {
  case "$1" in
    ''|*[!0-9]*|0?*) return 1 ;;
  esac
  [ "${#1}" -le 12 ]
}

tools_present() {
  for tool in /usr/bin/timeout /usr/bin/prlimit /usr/bin/env /usr/bin/git /usr/bin/realpath /usr/bin/find \
    /usr/bin/cmp /usr/bin/head /usr/bin/stat /usr/bin/cp /usr/bin/chmod /usr/bin/rm /usr/bin/mv /usr/bin/sleep \
    /usr/bin/id /usr/bin/wc /bin/mkdir /bin/bash; do
    if [ ! -x "$tool" ]; then
      return 1
    fi
  done
  return 0
}

# Creates one directory with the given mode. A link on the way is refused, and so is a non-directory.
make_dir() {
  if [ -L "$2" ]; then refuse; fi
  if [ ! -e "$2" ]; then /bin/mkdir -m "$1" -- "$2" || die; fi
  if [ ! -d "$2" ]; then refuse; fi
}

# The path must resolve inside the trial directory. REAL_TRIAL is set by setup_trial.
confined() {
  real=$(/usr/bin/realpath -e -- "$1") || die
  case "$real" in
    "$REAL_TRIAL"|"$REAL_TRIAL"/*) ;;
    *) refuse ;;
  esac
}

# Creates the trial's directories and sets TRIAL_DIR and REAL_TRIAL. ROOT/trials and the trial are 0711, so the
# host can enter the work directory without listing it. in and tmp are 0700.
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

# Sets CWD_TRIAL to the trial whose work directory, or a directory below it, is the current directory, or refuses.
cwd_trial() {
  real=$(/usr/bin/realpath -e -- .) || refuse
  case "$real" in
    "$ROOT"/trials/*/work|"$ROOT"/trials/*/work/*) ;;
    *) refuse ;;
  esac
  CWD_TRIAL=${real#"$ROOT"/trials/}
  CWD_TRIAL=${CWD_TRIAL%%/*}
  valid_trial "$CWD_TRIAL" || refuse
}

# Runs git with the fixed Git environment under a time limit of $1 seconds. NAME=VALUE arguments before the git
# path are passed to the child; the caller's environment never is.
git_run() {
  seconds=$1
  shift
  /usr/bin/timeout "$seconds" /usr/bin/env -i PATH=/usr/bin:/bin HOME="$EVAL_HOME" \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 \
    "$@"
}

# Runs a command as the trial's member. $1 is the trial, $2 the proxy URL or empty, and the rest is the command.
run_trial() {
  trial=$1
  proxy=$2
  shift 2
  if [ -n "$proxy" ]; then
    set -- HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" https_proxy="$proxy" http_proxy="$proxy" \
      NO_PROXY=localhost,127.0.0.1,::1 "$@"
  fi
  status=0
  /usr/bin/prlimit --nproc=512 --fsize=4294967296 --core=0 --nofile=4096 \
    /usr/bin/timeout --kill-after=10 3600 \
    /usr/bin/env -i \
      PATH=/usr/local/bin:/usr/bin:/bin HOME="$EVAL_HOME" TMPDIR="$TRIALS/$trial/tmp" \
      LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 \
    "$@" || status=$?
  # 137 is timeout's KILL after the limit, which is the time limit too.
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
    if git_run 15 /usr/bin/git ls-remote --exit-code -- "$url" HEAD >/dev/null 2>&1; then
      fetch=open
    elif [ -n "$proxy" ] && git_run 15 HTTPS_PROXY="$proxy" HTTP_PROXY="$proxy" https_proxy="$proxy" \
      http_proxy="$proxy" NO_PROXY=localhost,127.0.0.1,::1 /usr/bin/git ls-remote --exit-code -- "$url" HEAD \
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

# Counts the entries of a directory, or prints 0 when it is missing or a link.
count_entries() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    /usr/bin/find "$1" -mindepth 1 -maxdepth 1 -printf x | /usr/bin/wc -c
  else
    printf 0
  fi
}

# True when a path of EVAL_HOME is allowed: a login path, a directory on the way to one, or a template path.
keep_path() {
  for login in $LOGIN_PATHS; do
    case "$login" in
      "$1"|"$1"/*) return 0 ;;
    esac
  done
  [ -e "$TEMPLATE/$1" ] || [ -L "$TEMPLATE/$1" ]
}

# Counts the paths of EVAL_HOME that keep_path refuses, and the template files whose bytes differ from the home's.
# Each reads at most 10000 paths, and the total is 10000 when there are more.
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
  if [ "$count" -gt 10000 ]; then count=10000; fi
  printf '%s' "$count"
}

# Counts the entries of ROOT other than trials.
count_root_others() {
  /usr/bin/find "$ROOT" -mindepth 1 -maxdepth 1 ! -name trials -printf x | /usr/bin/wc -c
}

# Counts what clear_obstructions removes: one per login path, at the first obstruction on its way. A link, or a
# non-directory, on the way counts; a login that is a link or is not a regular file counts.
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

# Removes what stands on the way to a login path, top-down: a link or a non-directory above the login is removed,
# and so is a login that is a link or is not a regular file. The login is then lost, which is intended (fail closed).
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
  git_run 600 /usr/bin/git clone --quiet --template= --no-checkout --branch trial -- in/base.bundle work || die
  git_run 600 /usr/bin/git -C work remote remove origin || die
  git_run 600 /usr/bin/git -C work -c advice.detachedHead=false checkout --quiet --detach trial || die
  git_run 600 /usr/bin/git -C work branch -D trial || die
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
  if [ -L "$work" ] || [ ! -d "$work" ]; then refuse; fi
  for object in "$@"; do
    if git_run 60 /usr/bin/git -C "$work" cat-file -e "$object" >/dev/null 2>&1; then exit 1; fi
  done
  if [ -n "$(git_run 60 /usr/bin/git -C "$work" remote)" ]; then exit 1; fi
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

# Ends every process of the account, then removes the account's files from the shared temporary directories.
op_stop() {
  [ $# -eq 0 ] || refuse
  kill -KILL -1 2>/dev/null || true
  /usr/bin/sleep 1
  uid=$(/usr/bin/id -u)
  status=0
  for dir in /tmp /var/tmp /dev/shm; do
    if [ -d "$dir" ]; then
      /usr/bin/find "$dir" -xdev -type d -user "$uid" ! -perm -u=rwx -exec /usr/bin/chmod u+rwx -- {} \; 2>/dev/null || true
      /usr/bin/find "$dir" -xdev -mindepth 1 -user "$uid" -prune -exec /usr/bin/rm -rf -- {} + 2>/dev/null || true
      # Judged by what remains. Another account's unreadable directory does not fail the stop.
      if [ -n "$(/usr/bin/find "$dir" -xdev -mindepth 1 -user "$uid" -print -quit 2>/dev/null)" ]; then
        status=1
      fi
    fi
  done
  exit "$status"
}

# Makes every directory of a tree owner-writable and searchable, so rm -rf can empty a tree a trial left read-only.
# find acts on a directory before it reads it, and the chmod runs at once (\;), so each level opens before find enters.
open_tree() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    /usr/bin/find "$1" -xdev -type d ! -perm -u=rwx -exec /usr/bin/chmod u+rwx -- {} \; 2>/dev/null || true
  fi
}

# Removes every entry of ROOT other than trials, every entry of ROOT/trials, and every entry of EVAL_TMP when it is a
# directory and not a link. The whole pass runs under one 600-second limit, in a child shell that opens read-only
# directories before it removes anything.
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
  if [ -L "$TRIALS" ]; then refuse; fi
  /usr/bin/timeout 600 /bin/sh -c "$CLEAN_SCRIPT" clean "$ROOT" "$TRIALS" "$EVAL_TMP"
}

# Resets EVAL_HOME to TEMPLATE within 60 seconds: removes every path except the login files and the directories on
# the way to them, then copies the template over the home. Nothing is removed unless the template is present.
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

# Checks that apply to every operation, before any of them runs.
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
