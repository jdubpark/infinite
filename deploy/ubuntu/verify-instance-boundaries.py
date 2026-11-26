#!/usr/bin/env python3
"""Read-only Linux verifier for private multi-instance ownership boundaries."""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import posixpath
import re
import stat
import sys

try:
    import pwd as _pwd
except ImportError:
    _pwd = None


MAX_MANIFEST_BYTES = 1_048_576
MAX_INSTANCES = 8
MAX_USERS_PER_INSTANCE = 4
MAX_PATHS_PER_INSTANCE = 16
MAX_TOTAL_PATHS = 64
MAX_PATH_BYTES = 4096
MAX_MOUNTINFO_BYTES = 8 * 1024 * 1024
MAX_MOUNTS = 16_384
UNDEFINED_ACL_ID = 0xFFFFFFFF


class VerificationError(Exception):
    """A fixed-code failure safe to expose to callers."""

    def __init__(self, code):
        self.code = code


@dataclass(frozen=True)
class InstanceSpec:
    name: str
    users: tuple
    paths: tuple


@dataclass(frozen=True)
class Account:
    name: str
    uid: int
    gid: int
    groups: tuple
    instance_index: int


@dataclass(frozen=True)
class Resource:
    path: str
    kind: str
    instance_index: int
    device: int
    inode: int
    filesystem_roots: tuple


@dataclass(frozen=True)
class Mount:
    device: str
    root: str
    mountpoint: str


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise VerificationError("invalid_manifest")
        result[key] = value
    return result


def _reject_json_constant(_value):
    raise VerificationError("invalid_manifest")


def parse_manifest(raw):
    if len(raw) > MAX_MANIFEST_BYTES:
        raise VerificationError("invalid_manifest")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=_reject_json_constant)
    except VerificationError:
        raise
    except Exception as error:
        raise VerificationError("invalid_manifest") from error

    if type(value) is not dict or set(value) != {"instances"}:
        raise VerificationError("invalid_manifest")
    rows = value["instances"]
    if type(rows) is not list or not 2 <= len(rows) <= MAX_INSTANCES:
        raise VerificationError("invalid_manifest")

    instances = []
    names = set()
    account_names = set()
    total_paths = 0
    for row in rows:
        if type(row) is not dict or set(row) != {"name", "users", "paths"}:
            raise VerificationError("invalid_manifest")
        name = row["name"]
        if type(name) is not str or not name or len(name) > 64 or name in names:
            raise VerificationError("invalid_manifest")
        names.add(name)

        users = row["users"]
        if type(users) is not list or not 1 <= len(users) <= MAX_USERS_PER_INSTANCE:
            raise VerificationError("invalid_manifest")
        clean_users = []
        for username in users:
            if type(username) is not str or not username or len(username) > 256 or "\x00" in username:
                raise VerificationError("invalid_manifest")
            if username in account_names:
                raise VerificationError("invalid_manifest")
            account_names.add(username)
            clean_users.append(username)

        paths = row["paths"]
        if type(paths) is not list or not 1 <= len(paths) <= MAX_PATHS_PER_INSTANCE:
            raise VerificationError("invalid_manifest")
        clean_paths = []
        for path in paths:
            if type(path) is not str:
                raise VerificationError("invalid_manifest")
            try:
                encoded_path_length = len(path.encode("utf-8"))
            except UnicodeEncodeError as error:
                raise VerificationError("invalid_manifest") from error
            if encoded_path_length > MAX_PATH_BYTES:
                raise VerificationError("invalid_manifest")
            if not path.startswith("/") or "\x00" in path:
                raise VerificationError("invalid_manifest")
            clean_paths.append(path)
        total_paths += len(clean_paths)
        if total_paths > MAX_TOTAL_PATHS:
            raise VerificationError("invalid_manifest")
        instances.append(InstanceSpec(name, tuple(clean_users), tuple(clean_paths)))
    return tuple(instances)


def _require_linux_root():
    if not sys.platform.startswith("linux") or not all(hasattr(os, name) for name in
            ("fork", "setgroups", "setresgid", "setresuid")) or _pwd is None:
        raise VerificationError("unsupported_platform")
    if os.geteuid() != 0:
        raise VerificationError("requires_root")


def _resolve_accounts(instances):
    accounts = []
    seen_uids = set()
    for instance_index, instance in enumerate(instances):
        for username in instance.users:
            try:
                entry = _pwd.getpwnam(username)
                groups = set(os.getgrouplist(username, entry.pw_gid))
            except (KeyError, OSError, AttributeError) as error:
                raise VerificationError("account_unavailable") from error
            if entry.pw_uid == 0 or entry.pw_uid in seen_uids:
                raise VerificationError("account_uid_conflict")
            seen_uids.add(entry.pw_uid)
            groups.add(entry.pw_gid)
            accounts.append(Account(username, entry.pw_uid, entry.pw_gid,
                                    tuple(sorted(groups)), instance_index))
    return tuple(accounts)


def _path_contains(parent, child):
    try:
        return os.path.commonpath((parent, child)) == parent
    except ValueError:
        return False


def _decode_mount_field(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def parse_mountinfo(text):
    mounts = []
    try:
        for line in text.splitlines():
            left, separator, _right = line.partition(" - ")
            fields = left.split()
            if not separator or len(fields) < 6 or not fields[0].isdigit() or not fields[1].isdigit():
                raise VerificationError("mountinfo_invalid")
            device = fields[2]
            root = posixpath.normpath(_decode_mount_field(fields[3]))
            mountpoint = posixpath.normpath(_decode_mount_field(fields[4]))
            if (not re.fullmatch(r"[0-9]+:[0-9]+", device) or not root.startswith("/")
                    or not mountpoint.startswith("/")):
                raise VerificationError("mountinfo_invalid")
            mounts.append(Mount(device, root, mountpoint))
            if len(mounts) > MAX_MOUNTS:
                raise VerificationError("mountinfo_too_large")
    except VerificationError:
        raise
    except Exception as error:
        raise VerificationError("mountinfo_invalid") from error
    if not mounts:
        raise VerificationError("mountinfo_invalid")
    return tuple(mounts)


def _read_mountinfo():
    try:
        with open("/proc/self/mountinfo", "rb") as source:
            raw = source.read(MAX_MOUNTINFO_BYTES + 1)
        if len(raw) > MAX_MOUNTINFO_BYTES:
            raise VerificationError("mountinfo_too_large")
        return parse_mountinfo(os.fsdecode(raw))
    except VerificationError:
        raise
    except Exception as error:
        raise VerificationError("mountinfo_unavailable") from error


def _mount_roots_for_path(path, kind, mounts):
    candidates = [mount for mount in mounts if _path_contains(mount.mountpoint, path)]
    if not candidates:
        raise VerificationError("mountinfo_incomplete")
    longest = max(len(mount.mountpoint) for mount in candidates)
    best = [mount for mount in candidates if len(mount.mountpoint) == longest]
    identities = {(mount.device, mount.root) for mount in best}
    if len(identities) != 1:
        raise VerificationError("mountinfo_ambiguous")
    effective = best[0]
    relative = posixpath.relpath(path, effective.mountpoint)
    source_path = posixpath.normpath(posixpath.join(effective.root, relative))
    roots = {(effective.device, source_path)}
    if kind == "directory":
        for mount in mounts:
            if _path_contains(path, mount.mountpoint):
                roots.add((mount.device, mount.root))
    return tuple(sorted(roots))


def _resolve_resources(instances, mounts):
    resources = []
    for instance_index, instance in enumerate(instances):
        for raw_path in instance.paths:
            try:
                canonical = str(Path(raw_path).resolve(strict=True))
                root_stat = os.stat(canonical)
            except (OSError, RuntimeError, ValueError) as error:
                raise VerificationError("resource_unavailable") from error
            if canonical == "/" or not (stat.S_ISREG(root_stat.st_mode) or stat.S_ISDIR(root_stat.st_mode)):
                raise VerificationError("resource_type_invalid")
            kind = "directory" if stat.S_ISDIR(root_stat.st_mode) else "file"
            roots = _mount_roots_for_path(canonical, kind, mounts)
            resources.append(Resource(canonical, kind, instance_index, root_stat.st_dev, root_stat.st_ino, roots))
    return tuple(resources)


def _ensure_disjoint(resources):
    for left_index, left in enumerate(resources):
        for right in resources[left_index + 1:]:
            if left.instance_index == right.instance_index:
                continue
            if (_path_contains(left.path, right.path) or _path_contains(right.path, left.path)
                    or (left.device, left.inode) == (right.device, right.inode)
                    or any(left_device == right_device and
                           (_path_contains(left_root, right_root) or _path_contains(right_root, left_root))
                           for left_device, left_root in left.filesystem_roots
                           for right_device, right_root in right.filesystem_roots)):
                raise VerificationError("resource_ownership_overlap")


def _probe_account(account, requests):
    """Ask the kernel as this account; each request is a path and os.access mask."""
    read_fd, write_fd = os.pipe()
    try:
        pid = os.fork()
    except OSError as error:
        os.close(read_fd)
        os.close(write_fd)
        raise VerificationError("permission_probe_failed") from error

    if pid == 0:
        os.close(read_fd)
        try:
            os.setgroups(account.groups)
            os.setresgid(account.gid, account.gid, account.gid)
            os.setresuid(account.uid, account.uid, account.uid)
            if (os.getuid() != account.uid or os.geteuid() != account.uid
                    or os.getgid() != account.gid or os.getegid() != account.gid):
                os.write(write_fd, b"E")
            else:
                outcome = bytes(1 if os.access(path, mode) else 0 for path, mode in requests)
                os.write(write_fd, outcome)
        except BaseException:
            try:
                os.write(write_fd, b"E")
            except OSError:
                pass
        finally:
            os.close(write_fd)
        os._exit(0)

    os.close(write_fd)
    try:
        chunks = []
        while True:
            chunk = os.read(read_fd, max(1, len(requests) + 1))
            if not chunk:
                break
            chunks.append(chunk)
        _, status = os.waitpid(pid, 0)
    except OSError as error:
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        raise VerificationError("permission_probe_failed") from error
    finally:
        os.close(read_fd)
    result = b"".join(chunks)
    if status != 0 or len(result) != len(requests) or any(value not in (0, 1) for value in result):
        raise VerificationError("permission_probe_failed")
    return tuple(bool(value) for value in result)


def _permission_matrix(accounts, resources):
    owner_access = [False] * len(resources)
    denied_access = False
    for account in accounts:
        requests = []
        request_owner = []
        for resource_index, resource in enumerate(resources):
            is_owner = account.instance_index == resource.instance_index
            if is_owner:
                mode = os.R_OK if resource.kind == "file" else os.R_OK | os.X_OK
                requests.append((resource.path, mode))
                request_owner.append((resource_index, True))
            else:
                modes = (os.R_OK, os.W_OK, os.X_OK)
                requests.extend((resource.path, mode) for mode in modes)
                request_owner.extend((resource_index, False) for _ in modes)
        outcomes = _probe_account(account, requests)
        for (resource_index, is_owner), allowed in zip(request_owner, outcomes):
            if is_owner and allowed:
                owner_access[resource_index] = True
            elif not is_owner and allowed:
                denied_access = True
    if denied_access:
        raise VerificationError("peer_access")
    if not all(owner_access):
        raise VerificationError("owner_inaccessible")


def verify_manifest(raw):
    instances = parse_manifest(raw)
    _require_linux_root()
    accounts = _resolve_accounts(instances)
    resources = _resolve_resources(instances, _read_mountinfo())
    _ensure_disjoint(resources)
    _permission_matrix(accounts, resources)
    return {"ok": True, "instances": len(instances), "accounts": len(accounts), "resources": len(resources)}


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) == 2 and args[0] == "--manifest":
        manifest_path = args[1]
    elif len(args) == 1:
        manifest_path = args[0]
    else:
        result = {"ok": False, "error": "usage"}
        manifest_path = None
    if manifest_path is not None:
        try:
            with open(manifest_path, "rb") as source:
                raw = source.read(MAX_MANIFEST_BYTES + 1)
            result = verify_manifest(raw)
        except VerificationError as error:
            result = {"ok": False, "error": error.code}
        except Exception:
            result = {"ok": False, "error": "verification_failed"}
    print(json.dumps(result, separators=(",", ":")))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
