#!/bin/sh
set -eu
ROOT=/var/lib/infinite-grader/root
ACCOUNT=infinite-grader
JOBS=$ROOT/jobs
JOBDIR=
REAL_JOB=
LC_ALL=C
PATH=/usr/bin:/bin
export LC_ALL PATH
umask 077

refuse() { exit 64; }
die() { exit 125; }

valid_job() {
  H='[0-9a-f]'
  G4="$H$H$H$H"
  # shellcheck disable=SC2254
  case "$1" in
    $G4$G4-$G4-$G4-$G4-$G4$G4$G4) return 0 ;;
  esac
  return 1
}

valid_dir() {
  case "$1" in
    .|task|round-[1-6]) return 0 ;;
  esac
  return 1
}

valid_name() {
  case "$1" in
    base.bundle|base-delta.patch|reference.patch|result.patch) return 0 ;;
  esac
  return 1
}

valid_report() {
  case "$1" in
    reports/round-[1-6].xml|reports/round-[1-6].tap) return 0 ;;
  esac
  return 1
}

valid_count() {
  case "$1" in
    ''|*[!0-9]*|0?*) return 1 ;;
  esac
  [ "${#1}" -le 12 ]
}

valid_seconds() {
  valid_count "$1" && [ "${#1}" -le 4 ] && [ "$1" -ge 1 ] && [ "$1" -le 3600 ]
}

tools_present() {
  for tool in /usr/bin/setsid /usr/bin/timeout /usr/bin/prlimit /usr/bin/env /usr/bin/sha256sum /usr/bin/realpath /usr/bin/find /bin/mkdir /bin/bash; do
    if [ ! -x "$tool" ]; then
      return 1
    fi
  done
  return 0
}

make_dir() {
  if [ -L "$1" ]; then refuse; fi
  if [ ! -e "$1" ]; then /bin/mkdir -m 700 -- "$1" || die; fi
  if [ ! -d "$1" ]; then refuse; fi
}

confined() {
  real=$(/usr/bin/realpath -e -- "$1") || die
  case "$real" in
    "$REAL_JOB"|"$REAL_JOB"/*) ;;
    *) refuse ;;
  esac
}

setup_job() {
  make_dir "$JOBS"
  JOBDIR=$JOBS/$1
  make_dir "$JOBDIR"
  REAL_JOB=$(/usr/bin/realpath -e -- "$JOBDIR") || die
  for part in in work work/reports home tmp; do
    make_dir "$JOBDIR/$part"
    confined "$JOBDIR/$part"
  done
}

op_probe() {
  if [ "${1-}" != -- ]; then refuse; fi
  shift
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
  printf '{"uid":%s,"root":"%s","rootMode":"%s","rootOwner":%s,"readable":[%s],"metadata":"%s","freeBytes":%s,"freeInodes":%s,"ancestorsWritable":%s,"tools":%s,"version":2}\n' \
    "$uid" "$ROOT" "$mode" "$owner" "$readable" "$meta" "$((avail * bsize))" "$inodes" "$ancestors" "$tools"
}

op_receive() {
  [ $# -eq 3 ] || refuse
  valid_job "$1" || refuse
  valid_name "$2" || refuse
  valid_count "$3" || refuse
  setup_job "$1"
  dest=$JOBDIR/in/$2
  if [ -d "$dest" ]; then refuse; fi
  tmp=$JOBDIR/in/.receive.$$
  /usr/bin/head -c "$(( $3 + 1 ))" > "$tmp" || { /usr/bin/rm -f -- "$tmp"; die; }
  size=$(/usr/bin/stat -c %s -- "$tmp")
  if [ "$size" -gt "$3" ]; then
    /usr/bin/rm -f -- "$tmp"
    exit 3
  fi
  /usr/bin/mv -f -T -- "$tmp" "$dest"
}

run_child() {
  child_seconds=$1
  shift
  status=0
  /usr/bin/setsid -w /usr/bin/prlimit --nproc=512 --fsize=4294967296 --core=0 --nofile=4096 \
    /usr/bin/timeout --kill-after=10 "$child_seconds" \
    /usr/bin/env -i \
      PATH=/usr/local/bin:/usr/bin:/bin HOME="$JOBDIR/home" TMPDIR="$JOBDIR/tmp" \
      LANG=C.UTF-8 LC_ALL=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
      GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 CI=1 \
    "$@" || status=$?
}

finish_child() {
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then exit 124; fi
  if [ "$status" -lt 64 ]; then exit "$status"; fi
  exit 1
}

op_run() {
  [ $# -ge 5 ] || refuse
  job=$1
  dir=$2
  seconds=$3
  [ "$4" = -- ] || refuse
  shift 4
  valid_job "$job" || refuse
  valid_dir "$dir" || refuse
  valid_seconds "$seconds" || refuse
  tools_present || die
  setup_job "$job"
  if [ "$dir" = . ]; then cwd=$JOBDIR/work; else cwd=$JOBDIR/work/$dir; fi
  make_dir "$cwd"
  confined "$cwd"
  cd "$cwd" || die

  run_child "$seconds" "$@"
  finish_child
}

op_export() {
  [ $# -eq 1 ] || refuse
  valid_job "$1" || refuse
  tools_present || die
  setup_job "$1"
  cwd=$JOBDIR/work/task
  if [ -L "$cwd" ] || [ ! -d "$cwd" ]; then exit 2; fi
  confined "$cwd"
  cd "$cwd" || die

  run_child 600 /bin/sh -c 'git rev-parse --verify --quiet refs/heads/trial >/dev/null || exit 2; exec git bundle create - refs/heads/trial'
  finish_child
}

op_read() {
  [ $# -eq 3 ] || refuse
  valid_job "$1" || refuse
  valid_report "$2" || refuse
  valid_count "$3" || refuse
  setup_job "$1"
  file=$JOBDIR/work/$2
  if [ -L "$file" ]; then refuse; fi
  if [ ! -f "$file" ]; then exit 2; fi
  size=$(/usr/bin/stat -c %s -- "$file")
  if [ "$size" -gt "$3" ]; then exit 3; fi
  /usr/bin/head -c "$(( $3 + 1 ))" -- "$file"
}

op_digest() {
  [ $# -eq 1 ] || refuse
  valid_job "$1" || refuse
  setup_job "$1"
  file=$JOBDIR/in/base.bundle
  if [ -L "$file" ]; then refuse; fi
  if [ ! -f "$file" ]; then exit 2; fi
  hash=$(/usr/bin/sha256sum < "$file")
  printf '%s\n' "${hash%% *}"
}

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
      if [ -n "$(/usr/bin/find "$dir" -xdev -mindepth 1 -user "$uid" -print -quit 2>/dev/null)" ]; then
        status=1
      fi
    fi
  done
  exit "$status"
}

open_tree() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    /usr/bin/find "$1" -xdev -type d ! -perm -u=rwx -exec /usr/bin/chmod u+rwx -- {} \; 2>/dev/null || true
  fi
}

op_clean() {
  [ $# -eq 1 ] || refuse
  valid_job "$1" || refuse
  setup_job "$1"
  open_tree "$ROOT"
  /usr/bin/find "$ROOT" -mindepth 1 -maxdepth 1 ! -name jobs -exec /usr/bin/rm -rf -- {} +
  /usr/bin/find "$JOBS" -mindepth 1 -maxdepth 1 ! -name "$1" -exec /usr/bin/rm -rf -- {} +
  /usr/bin/find "$JOBDIR" -mindepth 1 -maxdepth 1 ! -name in -exec /usr/bin/rm -rf -- {} +
  /usr/bin/find "$JOBDIR/in" -mindepth 1 -maxdepth 1 ! -name base.bundle -exec /usr/bin/rm -rf -- {} +
}

op_remove() {
  [ $# -eq 1 ] || refuse
  valid_job "$1" || refuse
  make_dir "$JOBS"
  open_tree "${JOBS:?}/$1"
  /usr/bin/rm -rf -- "${JOBS:?}/$1"
}

[ "$(/usr/bin/id -un)" = "$ACCOUNT" ] || refuse
[ "$(/usr/bin/id -u)" -ne 0 ] || refuse
[ -d "$ROOT" ] && [ ! -L "$ROOT" ] || refuse
[ "$(/usr/bin/stat -c '%a %u' -- "$ROOT")" = "700 $(/usr/bin/id -u)" ] || refuse

if [ $# -eq 0 ]; then refuse; fi
op=$1
shift
cd / || die
case "$op" in
  probe) op_probe "$@" ;;
  receive) op_receive "$@" ;;
  run) op_run "$@" ;;
  read) op_read "$@" ;;
  digest) op_digest "$@" ;;
  export) op_export "$@" ;;
  stop) op_stop "$@" ;;
  clean) op_clean "$@" ;;
  remove) op_remove "$@" ;;
  *) refuse ;;
esac
