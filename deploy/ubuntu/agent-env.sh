#!/bin/sh
# Sourced by provider wrappers. Loading this file defines functions only.

_infinite_env_warn() {
  printf 'infinite_load_env: skipping %s: %s\n' "$1" "$2" >&2
}

_infinite_env_load_file() {
  _infinite_env_file=$1
  _infinite_env_agent_uid=$2
  _infinite_env_cr=$(printf '\r')
  if [ ! -e "$_infinite_env_file" ] && [ ! -L "$_infinite_env_file" ]; then
    return 0
  fi
  if [ -L "$_infinite_env_file" ] || [ ! -f "$_infinite_env_file" ]; then
    _infinite_env_warn "$_infinite_env_file" 'not a regular file'
    return 0
  fi
  [ -r "$_infinite_env_file" ] || return 0

  if ! _infinite_env_owner=$(stat -c '%u' "$_infinite_env_file" 2>/dev/null) &&
    ! _infinite_env_owner=$(stat -f '%u' "$_infinite_env_file" 2>/dev/null); then
    _infinite_env_warn "$_infinite_env_file" 'cannot inspect owner'
    return 0
  fi
  if ! _infinite_env_mode=$(stat -c '%a' "$_infinite_env_file" 2>/dev/null) &&
    ! _infinite_env_mode=$(stat -f '%Lp' "$_infinite_env_file" 2>/dev/null); then
    _infinite_env_warn "$_infinite_env_file" 'cannot inspect permissions'
    return 0
  fi
  case $_infinite_env_owner in
    0|"$_infinite_env_agent_uid") ;;
    *) _infinite_env_warn "$_infinite_env_file" 'owner is neither root nor agent'; return 0 ;;
  esac
  case $_infinite_env_mode in
    *[!0-7]*|'') _infinite_env_warn "$_infinite_env_file" 'cannot inspect permissions'; return 0 ;;
    *[2367]) _infinite_env_warn "$_infinite_env_file" 'world-writable'; return 0 ;;
  esac

  while IFS= read -r _infinite_env_line || [ -n "$_infinite_env_line" ]; do
    _infinite_env_line=${_infinite_env_line%"$_infinite_env_cr"}
    case $_infinite_env_line in ''|'#'*) continue ;; esac
    case $_infinite_env_line in *=*) ;; *) continue ;; esac
    _infinite_env_key=${_infinite_env_line%%=*}
    _infinite_env_value=${_infinite_env_line#*=}
    case $_infinite_env_key in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;; esac

    if [ "$_infinite_env_key" = PATH_APPEND ]; then
      [ -n "$_infinite_env_value" ] || continue
      PATH="${PATH:+$PATH:}$_infinite_env_value"
      export PATH
      continue
    fi

    # Denied: launcher-owned keys, this loader's own namespace (any leading
    # underscore), and names the shell interprets on assignment.
    case $_infinite_env_key in
      PATH|HOME|SHELL|TMPDIR|LD_*|XDG_*|INFINITE_*|SUDO_*|npm_config_prefix|provider) continue ;;
      _*) continue ;;
      IFS|OPTIND|OPTARG|PS1|PS2|PS3|PS4|PWD|OLDPWD|SHLVL|LINENO|RANDOM|SECONDS|PPID|UID|EUID|GROUPS) continue ;;
      ENV|BASH_ENV|BASH*|ZDOTDIR|CDPATH|FPATH|MAIL|MAILPATH|MAILCHECK|HISTFILE|HISTSIZE|LC_ALL|LANG|LC_*) continue ;;
    esac
    export "$_infinite_env_key=$_infinite_env_value"
  done < "$_infinite_env_file"
  return 0
}

infinite_load_env() {
  _infinite_env_dir=$1
  _infinite_env_project_id=$2
  _infinite_env_agent_uid=$(id -u)

  for _infinite_env_file in "$_infinite_env_dir"/secrets/*.env; do
    [ -e "$_infinite_env_file" ] || [ -L "$_infinite_env_file" ] || continue
    _infinite_env_load_file "$_infinite_env_file" "$_infinite_env_agent_uid"
  done
  _infinite_env_file=$_infinite_env_dir/android.env
  _infinite_env_load_file "$_infinite_env_file" "$_infinite_env_agent_uid"

  case $_infinite_env_project_id in ''|*[!A-Za-z0-9._-]*) return 0 ;; esac
  _infinite_env_file=$_infinite_env_dir/projects/$_infinite_env_project_id.env
  _infinite_env_load_file "$_infinite_env_file" "$_infinite_env_agent_uid"
  return 0
}
