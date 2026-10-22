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
      PATH|HOME|SHELL|TMPDIR|LD_*|XDG_*|INFINITE_*|SUDO_*|OPENCODE_SERVER_*|OPENCODE_CONFIG_CONTENT|npm_config_prefix|provider) continue ;;
      _*) continue ;;
      IFS|OPTIND|OPTARG|PS1|PS2|PS3|PS4|PWD|OLDPWD|SHLVL|LINENO|RANDOM|SECONDS|PPID|UID|EUID|GROUPS) continue ;;
      ENV|BASH_ENV|BASH*|ZDOTDIR|CDPATH|FPATH|MAIL|MAILPATH|MAILCHECK|HIST*|LC_ALL|LANG|LC_*) continue ;;
      SHELLOPTS|FUNCNAME|DIRSTACK|PIPESTATUS|REPLY|TMOUT|COMP_*|COMPREPLY|EXECIGNORE|GLOBIGNORE|IGNOREEOF|INPUTRC) continue ;;
      POSIXLY_CORRECT|PROMPT_COMMAND|PROMPT_DIRTRIM|HOSTNAME|HOSTTYPE|MACHTYPE|OSTYPE|OPTERR|EMACS|INSIDE_EMACS|CHILD_MAX) continue ;;
    esac
    # Files are additive: a variable the host already injected (sudoers
    # env_keep: session tokens, OpenCode credentials) is never overridden.
    case $_infinite_env_preexisting in
      *"$_infinite_env_nl$_infinite_env_key$_infinite_env_nl"*)
        _infinite_env_warn "$_infinite_env_file" "$_infinite_env_key is set by the host"
        continue ;;
    esac
    # No deny list is complete across shells: a readonly or arithmetic name
    # makes the assignment fatal under set -e. Probe it in a subshell first;
    # a fatal assignment only kills the subshell, and the key is skipped.
    if ! ( export "$_infinite_env_key=$_infinite_env_value" ) 2>/dev/null; then
      _infinite_env_warn "$_infinite_env_file" "cannot export $_infinite_env_key"
      continue
    fi
    export "$_infinite_env_key=$_infinite_env_value"
  done < "$_infinite_env_file"
  return 0
}

infinite_load_env() {
  _infinite_env_dir=$1
  _infinite_env_project_id=$2
  _infinite_env_agent_uid=$(id -u)
  _infinite_env_nl=$(printf '\n_'); _infinite_env_nl=${_infinite_env_nl%_}
  # Names already in the environment before any file is read, one per line
  # with surrounding newlines so exact matching works in case patterns.
  _infinite_env_preexisting=$_infinite_env_nl$(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p')$_infinite_env_nl

  for _infinite_env_file in "$_infinite_env_dir"/secrets/*.env; do
    [ -e "$_infinite_env_file" ] || [ -L "$_infinite_env_file" ] || continue
    _infinite_env_load_file "$_infinite_env_file" "$_infinite_env_agent_uid"
  done
  _infinite_env_file=$_infinite_env_dir/android.env
  _infinite_env_load_file "$_infinite_env_file" "$_infinite_env_agent_uid"

  case $_infinite_env_project_id in ''|*[!A-Za-z0-9._-]*) ;; *)
    _infinite_env_file=$_infinite_env_dir/projects/$_infinite_env_project_id.env
    _infinite_env_load_file "$_infinite_env_file" "$_infinite_env_agent_uid" ;;
  esac
  return 0
}
