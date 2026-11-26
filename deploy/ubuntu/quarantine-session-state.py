#!/usr/bin/env python3
"""Move selected native session directories into offline root-only custody.

This tool handles only ``state/sessions/<UUID>`` directories. It does not
stop the service or prove that writers are fenced. Callers must establish
those preconditions and provide every service-accessible root. Session
contents are moved without reading, decrypting, copying, or deleting them.
Mount checks use this process's mount namespace; run in the same namespace as
the service paths and keep mount topology unchanged for the operation.
"""
import argparse
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
import posixpath
import re
import stat
import sys
import uuid


MAX_SELECTION_BYTES = 1_048_576
MAX_CHECKPOINT_BYTES = 4_194_304
MAX_SESSIONS = 20_000
CHECKPOINT_NAME = ".checkpoint.json"
LOCK_NAME = ".lock"
SESSIONS_NAME = "sessions"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
TEMP_CHECKPOINT_RE = re.compile(r"^\.checkpoint\.tmp-[0-9]+-[0-9a-f]{16}$")

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
RENAME_NOREPLACE = 1


class QuarantineError(Exception):
    """A fixed-code error safe to show to an operator."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code):
    raise QuarantineError(code)


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail("invalid-json")
        value[key] = item
    return value


def _reject_json_constant(_value):
    fail("invalid-json")


def _absolute_parts(value):
    if type(value) is not str or not value.startswith("/") or "\x00" in value:
        fail("invalid-path")
    parts = [part for part in value.split("/") if part]
    if any(part in (".", "..") for part in parts):
        fail("invalid-path")
    return parts


def _open_absolute_directory(path):
    parts = _absolute_parts(path)
    current = os.open("/", DIR_FLAGS)
    try:
        for part in parts:
            next_fd = os.open(part, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = next_fd
        return current
    except Exception:
        os.close(current)
        raise


def _open_absolute_file(path):
    parts = _absolute_parts(path)
    if not parts:
        fail("invalid-file")
    parent = os.open("/", DIR_FLAGS)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, DIR_FLAGS, dir_fd=parent)
            os.close(parent)
            parent = next_fd
        name = parts[-1]
        fd = os.open(name, FILE_FLAGS, dir_fd=parent)
        return parent, name, fd
    except Exception:
        os.close(parent)
        raise


def _open_child_directory(parent_fd, name):
    before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(before.st_mode):
        fail("unsafe-directory")
    fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    after = os.fstat(fd)
    if not stat.S_ISDIR(after.st_mode) or _identity(before) != _identity(after):
        os.close(fd)
        fail("directory-changed")
    return fd


def _identity(info):
    return {"device": int(info.st_dev), "inode": int(info.st_ino)}


def _same_identity(left, right):
    return left.get("device") == right.get("device") and left.get("inode") == right.get("inode")


def _is_ancestor(directory_fd, target_identity):
    current = os.dup(directory_fd)
    try:
        for _ in range(4096):
            here = _identity(os.fstat(current))
            if _same_identity(here, target_identity):
                return True
            parent = os.open("..", DIR_FLAGS, dir_fd=current)
            parent_identity = _identity(os.fstat(parent))
            if _same_identity(here, parent_identity):
                os.close(parent)
                return False
            os.close(current)
            current = parent
        fail("path-depth")
    finally:
        os.close(current)


def _assert_disjoint(left_fd, right_fd):
    left = _identity(os.fstat(left_fd))
    right = _identity(os.fstat(right_fd))
    if _is_ancestor(left_fd, right) or _is_ancestor(right_fd, left):
        fail("overlapping-roots")


def _write_all(fd, raw):
    view = memoryview(raw)
    offset = 0
    while offset < len(view):
        offset += os.write(fd, view[offset:])


def _read_regular(fd, limit, owner, mode):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != owner or stat.S_IMODE(before.st_mode) != mode or before.st_nlink != 1:
        fail("unsafe-file")
    if before.st_size < 0 or before.st_size > limit:
        fail("file-size")
    chunks = []
    total = 0
    while True:
        block = os.read(fd, min(65_536, limit + 1 - total))
        if not block:
            break
        chunks.append(block)
        total += len(block)
        if total > limit:
            fail("file-size")
    after = os.fstat(fd)
    stable = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
    current = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
    if stable != current or total != after.st_size:
        fail("file-changed")
    return b"".join(chunks), after


def _selection(path):
    parent_fd, name, fd = _open_absolute_file(path)
    try:
        raw, info = _read_regular(fd, MAX_SELECTION_BYTES, 0, 0o400)
        parsed = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_json_constant)
        if type(parsed) is not dict or set(parsed) != {"version", "sessionIds"} or type(parsed["version"]) is not int or parsed["version"] != 1:
            fail("invalid-selection")
        values = parsed["sessionIds"]
        if type(values) is not list or not 1 <= len(values) <= MAX_SESSIONS:
            fail("invalid-selection")
        ids = []
        for value in values:
            if type(value) is not str or not UUID_RE.fullmatch(value) or str(uuid.UUID(value)) != value:
                fail("invalid-selection")
            ids.append(value)
        if len(set(ids)) != len(ids):
            fail("invalid-selection")
        ids.sort()
        canonical = json.dumps({"version": 1, "sessionIds": ids}, separators=(",", ":"), ensure_ascii=True).encode("ascii")
        selection_info = {**_identity(info), "size": int(info.st_size), "mtimeNs": int(info.st_mtime_ns), "ctimeNs": int(info.st_ctime_ns)}
        return ids, hashlib.sha256(canonical).hexdigest(), selection_info, parent_fd
    except QuarantineError:
        os.close(parent_fd)
        raise
    except Exception as error:
        os.close(parent_fd)
        raise QuarantineError("invalid-selection") from error
    finally:
        os.close(fd)


def _entry_identity(parent_fd, name):
    try:
        before = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(before.st_mode):
        fail("unsafe-entry")
    fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    try:
        after = os.fstat(fd)
        if not stat.S_ISDIR(after.st_mode) or _identity(before) != _identity(after):
            fail("entry-changed")
        return _identity(after)
    finally:
        os.close(fd)


def _assert_selected_names(parent_fd, ids):
    names = os.listdir(parent_fd)
    for session_id in ids:
        matches = [name for name in names if name.lower() == session_id]
        if matches and (len(matches) != 1 or matches[0] != session_id):
            fail("noncanonical-session-name")


class Roots:
    def __init__(self, args):
        self.fds = []
        self.state_path = posixpath.normpath(args.state_root)
        self.source_path = posixpath.join(self.state_path, SESSIONS_NAME)
        self.custody_path = posixpath.normpath(args.custody_root)
        self.custody_sessions_path = posixpath.join(self.custody_path, SESSIONS_NAME)
        self.service_paths = list(dict.fromkeys([self.state_path, *(posixpath.normpath(path) for path in args.service_root)]))
        try:
            self.state_fd = self._open(args.state_root)
            self.source_fd = _open_child_directory(self.state_fd, SESSIONS_NAME)
            self.fds.append(self.source_fd)
            self.custody_fd = self._open(args.custody_root)
            self.custody_sessions_fd = _open_child_directory(self.custody_fd, SESSIONS_NAME)
            self.fds.append(self.custody_sessions_fd)
            self._require_private_custody(self.custody_fd)
            self._require_private_custody(self.custody_sessions_fd)
            self.service_fds = [self._open(path) for path in [args.state_root, *args.service_root]]
            for service_fd in self.service_fds:
                _assert_disjoint(self.custody_fd, service_fd)
            self.selection_parent_fd = None
            self.lock_fd = None
        except Exception:
            self.close()
            raise

    def _open(self, path):
        fd = _open_absolute_directory(path)
        self.fds.append(fd)
        return fd

    @staticmethod
    def _require_private_custody(fd):
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            fail("unsafe-custody-root")

    def set_selection_parent(self, fd):
        self.selection_parent_fd = fd
        self.fds.append(fd)
        for service_fd in self.service_fds:
            _assert_disjoint(fd, service_fd)
        _assert_disjoint(fd, self.custody_fd)

    def acquire_lock(self):
        self.lock_fd = os.open(LOCK_NAME, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.custody_fd)
        self.fds.append(self.lock_fd)
        lock_info = os.fstat(self.lock_fd)
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != 0 or stat.S_IMODE(lock_info.st_mode) != 0o600 or lock_info.st_nlink != 1:
            fail("unsafe-lock")
        try:
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise QuarantineError("busy") from error

    def close(self):
        for fd in reversed(self.fds):
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds.clear()


def _open_names_for_operation(roots, ids, initial):
    names = set(os.listdir(roots.custody_fd))
    permitted = {SESSIONS_NAME, LOCK_NAME, CHECKPOINT_NAME}
    temps = {name for name in names if TEMP_CHECKPOINT_RE.fullmatch(name)}
    for name in temps:
        info = os.stat(name, dir_fd=roots.custody_fd, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
            fail("unsafe-checkpoint")
    if names - permitted - temps:
        fail("unexpected-custody-entry")
    _assert_selected_names(roots.source_fd, ids)
    custody_names = os.listdir(roots.custody_sessions_fd)
    if initial and custody_names:
        fail("custody-not-empty")
    if any(name not in ids for name in custody_names):
        fail("unexpected-custody-entry")
    _assert_selected_names(roots.custody_sessions_fd, [name for name in ids if name in custody_names])


def _mount_contract():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "verify-instance-boundaries.py")
    try:
        spec = importlib.util.spec_from_file_location("_infinite_instance_mount_contract", path)
        if spec is None or spec.loader is None:
            fail("mount-contract-unavailable")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        previous = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        try:
            spec.loader.exec_module(module)
        finally:
            sys.dont_write_bytecode = previous
        return module
    except QuarantineError:
        raise
    except Exception as error:
        raise QuarantineError("mount-contract-unavailable") from error


def _path_overlaps(module, left, right):
    return module._path_contains(left, right) or module._path_contains(right, left)


def _parse_mount_contract(module, raw):
    if len(raw) > module.MAX_MOUNTINFO_BYTES:
        fail("mountinfo-too-large")
    lines = os.fsdecode(raw).splitlines()
    if not lines or len(lines) > module.MAX_MOUNTS:
        fail("mountinfo-invalid")

    ordinary = []
    namespace_mountpoints = []
    for line in lines:
        left, separator, right = line.partition(" - ")
        fields = left.split()
        if not separator or len(fields) < 6 or not fields[0].isdigit() or not fields[1].isdigit():
            fail("mountinfo-invalid")
        if fields[3].startswith("/"):
            ordinary.append(line)
            continue
        right_fields = right.split()
        if (not re.fullmatch(r"[0-9]+:[0-9]+", fields[2]) or not right_fields
                or right_fields[0] != "nsfs"):
            fail("mountinfo-invalid")
        mountpoint = posixpath.normpath(module._decode_mount_field(fields[4]))
        if not mountpoint.startswith("/"):
            fail("mountinfo-invalid")
        namespace_mountpoints.append(mountpoint)

    mounts = module.parse_mountinfo("\n".join(ordinary))
    return mounts, tuple(namespace_mountpoints)


def _read_mount_contract(module):
    try:
        return module._read_mountinfo(), ()
    except module.VerificationError as error:
        if error.code != "mountinfo_invalid":
            raise

    with open("/proc/self/mountinfo", "rb") as source:
        raw = source.read(module.MAX_MOUNTINFO_BYTES + 1)
    return _parse_mount_contract(module, raw)


def _assert_no_mount_alias(path, service_paths, mounts, module, reject_subtree_mounts, extra_mountpoints=()):
    try:
        roots = module._mount_roots_for_path(path, "file", mounts)
    except Exception as error:
        raise QuarantineError("mount-path-unavailable") from error
    if not roots:
        fail("mount-path-unavailable")
    device, filesystem_path = roots[0]
    for mount in mounts:
        if reject_subtree_mounts and module._path_contains(path, mount.mountpoint):
            fail("mounted-session-subtree")
        if mount.device != device:
            continue
        if module._path_contains(mount.root, filesystem_path):
            relative = posixpath.relpath(filesystem_path, mount.root)
            projected = posixpath.normpath(posixpath.join(mount.mountpoint, relative))
            if projected == path:
                continue
            if any(_path_overlaps(module, projected, service_path) for service_path in service_paths):
                fail("mount-alias")
        elif module._path_contains(filesystem_path, mount.root):
            if module._path_contains(path, mount.mountpoint):
                continue
            if any(_path_overlaps(module, mount.mountpoint, service_path) for service_path in service_paths):
                fail("mount-alias")
    if reject_subtree_mounts and any(module._path_contains(path, mountpoint) for mountpoint in extra_mountpoints):
        fail("mounted-session-subtree")


def _assert_custody_filesystem_disjoint(roots, mounts, module):
    try:
        custody = module._mount_roots_for_path(roots.custody_path, "directory", mounts)
        services = [module._mount_roots_for_path(path, "directory", mounts) for path in roots.service_paths]
    except Exception as error:
        raise QuarantineError("mount-path-unavailable") from error
    for custody_device, custody_path in custody:
        for service in services:
            for service_device, service_path in service:
                if custody_device == service_device and _path_overlaps(module, custody_path, service_path):
                    fail("mount-alias")


def _mount_preflight(roots, ids):
    module = _mount_contract()
    try:
        mounts, namespace_mountpoints = _read_mount_contract(module)
    except Exception as error:
        raise QuarantineError("mountinfo-read-failed") from error
    _assert_no_mount_alias(roots.source_path, roots.service_paths, mounts, module, False)
    _assert_no_mount_alias(roots.custody_path, roots.service_paths, mounts, module, False)
    _assert_no_mount_alias(roots.custody_sessions_path, roots.service_paths, mounts, module, False)
    _assert_custody_filesystem_disjoint(roots, mounts, module)
    for session_id in ids:
        source = _entry_identity(roots.source_fd, session_id)
        custody = _entry_identity(roots.custody_sessions_fd, session_id)
        if source is not None:
            _assert_no_mount_alias(posixpath.join(roots.source_path, session_id), roots.service_paths, mounts, module, True, namespace_mountpoints)
        if custody is not None:
            _assert_no_mount_alias(posixpath.join(roots.custody_sessions_path, session_id), roots.service_paths, mounts, module, True, namespace_mountpoints)


def _root_records(roots):
    return {
        "stateRoot": _identity(os.fstat(roots.state_fd)),
        "sourceSessionRoot": _identity(os.fstat(roots.source_fd)),
        "custodyRoot": _identity(os.fstat(roots.custody_fd)),
        "custodySessionRoot": _identity(os.fstat(roots.custody_sessions_fd)),
    }


def _session_records(source_fd, ids):
    records = []
    for session_id in ids:
        identity = _entry_identity(source_fd, session_id)
        if identity is None:
            fail("missing-session")
        if identity["device"] != os.fstat(source_fd).st_dev:
            fail("cross-device-session")
        records.append({**identity, "state": "source"})
    return records


def _checkpoint(ids, digest, selection_info, roots, items):
    return {
        "version": 1,
        "selectionSha256": digest,
        "selectionFile": selection_info,
        "roots": _root_records(roots),
        "direction": "apply",
        "items": items,
    }


def _checkpoint_shape(value, count):
    if type(value) is not dict or set(value) != {"version", "selectionSha256", "selectionFile", "roots", "direction", "items"}:
        fail("invalid-checkpoint")
    if type(value["version"]) is not int or value["version"] != 1 or type(value["selectionSha256"]) is not str or not DIGEST_RE.fullmatch(value["selectionSha256"]):
        fail("invalid-checkpoint")
    if value["direction"] not in ("apply", "restore") or type(value["direction"]) is not str:
        fail("invalid-checkpoint")
    if type(value["selectionFile"]) is not dict or set(value["selectionFile"]) != {"device", "inode", "size", "mtimeNs", "ctimeNs"}:
        fail("invalid-checkpoint")
    if any(type(value["selectionFile"][key]) is not int or value["selectionFile"][key] < 0 for key in ("device", "inode", "size", "mtimeNs", "ctimeNs")):
        fail("invalid-checkpoint")
    roots = value["roots"]
    expected_roots = {"stateRoot", "sourceSessionRoot", "custodyRoot", "custodySessionRoot"}
    if type(roots) is not dict or set(roots) != expected_roots:
        fail("invalid-checkpoint")
    for identity in roots.values():
        if type(identity) is not dict or set(identity) != {"device", "inode"} or any(type(identity[key]) is not int or identity[key] < 0 for key in ("device", "inode")):
            fail("invalid-checkpoint")
    items = value["items"]
    if type(items) is not list or len(items) != count:
        fail("selection-changed")
    for item in items:
        if type(item) is not dict or set(item) != {"device", "inode", "state"} or item["state"] not in ("source", "custody") or type(item["state"]) is not str:
            fail("invalid-checkpoint")
        if type(item["device"]) is not int or type(item["inode"]) is not int or item["device"] < 0 or item["inode"] < 0:
            fail("invalid-checkpoint")


def _read_checkpoint(custody_fd, count):
    try:
        fd = os.open(CHECKPOINT_NAME, FILE_FLAGS, dir_fd=custody_fd)
    except FileNotFoundError as error:
        raise QuarantineError("no-plan") from error
    try:
        raw, _info = _read_regular(fd, MAX_CHECKPOINT_BYTES, 0, 0o600)
    finally:
        os.close(fd)
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_json_constant)
    except QuarantineError:
        raise
    except Exception as error:
        raise QuarantineError("invalid-checkpoint") from error
    _checkpoint_shape(value, count)
    return value


def _write_checkpoint(custody_fd, value, create=False):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    if len(raw) > MAX_CHECKPOINT_BYTES:
        fail("checkpoint-size")
    if create:
        try:
            fd = os.open(CHECKPOINT_NAME, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=custody_fd)
        except FileExistsError as error:
            raise QuarantineError("plan-exists") from error
        try:
            _write_all(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(custody_fd)
        return

    temp_name = f".checkpoint.tmp-{os.getpid()}-{os.urandom(8).hex()}"
    try:
        fd = os.open(temp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=custody_fd)
        try:
            _write_all(fd, raw)
            os.fsync(fd)
        finally:
            os.close(fd)
        existing_fd = os.open(CHECKPOINT_NAME, FILE_FLAGS, dir_fd=custody_fd)
        try:
            info = os.fstat(existing_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
                fail("unsafe-checkpoint")
        finally:
            os.close(existing_fd)
        os.replace(temp_name, CHECKPOINT_NAME, src_dir_fd=custody_fd, dst_dir_fd=custody_fd)
        os.fsync(custody_fd)
    except Exception:
        try:
            os.unlink(temp_name, dir_fd=custody_fd)
        except OSError:
            pass
        raise


def _verify_bindings(value, ids, digest, selection_info, roots):
    if value["selectionSha256"] != digest or value["selectionFile"] != selection_info:
        fail("selection-changed")
    if value["roots"] != _root_records(roots):
        fail("root-changed")
    if len(value["items"]) != len(ids):
        fail("selection-changed")
    if os.fstat(roots.source_fd).st_dev != os.fstat(roots.custody_sessions_fd).st_dev:
        fail("cross-device-roots")


def _item_identity(item):
    return {"device": item["device"], "inode": item["inode"]}


def _rename_noreplace(source_fd, source_name, destination_fd, destination_name):
    if sys.platform != "linux":
        fail("linux-required")
    try:
        function = ctypes.CDLL(None, use_errno=True).renameat2
    except AttributeError as error:
        raise QuarantineError("renameat2-unavailable") from error
    function.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    function.restype = ctypes.c_int
    result = function(source_fd, os.fsencode(source_name), destination_fd, os.fsencode(destination_name), RENAME_NOREPLACE)
    if result != 0:
        error = ctypes.get_errno()
        if error == 17:
            fail("destination-exists")
        fail("rename-failed")
    os.fsync(source_fd)
    os.fsync(destination_fd)


def _sync_rename_parents(roots):
    os.fsync(roots.source_fd)
    os.fsync(roots.custody_sessions_fd)


def _check_item_state(roots, session_id, item):
    source = _entry_identity(roots.source_fd, session_id)
    custody = _entry_identity(roots.custody_sessions_fd, session_id)
    expected = _item_identity(item)
    if source is not None and not _same_identity(source, expected):
        fail("source-changed")
    if custody is not None and not _same_identity(custody, expected):
        fail("custody-changed")
    return source, custody


def _plan(roots, ids, digest, selection_info):
    _open_names_for_operation(roots, ids, initial=True)
    if os.fstat(roots.source_fd).st_dev != os.fstat(roots.custody_sessions_fd).st_dev:
        fail("cross-device-roots")
    try:
        checkpoint = _read_checkpoint(roots.custody_fd, len(ids))
    except QuarantineError as error:
        if error.code != "no-plan":
            raise
    else:
        _verify_bindings(checkpoint, ids, digest, selection_info, roots)
        if checkpoint["direction"] != "apply" or any(item["state"] != "source" for item in checkpoint["items"]):
            fail("plan-exists")
        for session_id, item in zip(ids, checkpoint["items"]):
            source, custody = _check_item_state(roots, session_id, item)
            if source is None or custody is not None:
                fail("plan-exists")
        return
    items = _session_records(roots.source_fd, ids)
    value = _checkpoint(ids, digest, selection_info, roots, items)
    _write_checkpoint(roots.custody_fd, value, create=True)


def _apply(roots, ids, digest, selection_info):
    _open_names_for_operation(roots, ids, initial=False)
    value = _read_checkpoint(roots.custody_fd, len(ids))
    _verify_bindings(value, ids, digest, selection_info, roots)
    if value["direction"] != "apply":
        fail("wrong-direction")
    for session_id, item in zip(ids, value["items"]):
        source, custody = _check_item_state(roots, session_id, item)
        expected = _item_identity(item)
        if source is None and custody is not None:
            _sync_rename_parents(roots)
            if item["state"] == "source":
                item["state"] = "custody"
                _write_checkpoint(roots.custody_fd, value)
            continue
        if source is None or custody is not None or item["state"] != "source":
            fail("ambiguous-session-state")
        _rename_noreplace(roots.source_fd, session_id, roots.custody_sessions_fd, session_id)
        moved = _entry_identity(roots.custody_sessions_fd, session_id)
        if moved is None or not _same_identity(moved, expected):
            fail("post-rename-mismatch")
        item["state"] = "custody"
        _write_checkpoint(roots.custody_fd, value)


def _restore(roots, ids, digest, selection_info):
    _open_names_for_operation(roots, ids, initial=False)
    value = _read_checkpoint(roots.custody_fd, len(ids))
    _verify_bindings(value, ids, digest, selection_info, roots)
    if value["direction"] == "apply":
        value["direction"] = "restore"
        _write_checkpoint(roots.custody_fd, value)
    for session_id, item in zip(ids, value["items"]):
        source, custody = _check_item_state(roots, session_id, item)
        expected = _item_identity(item)
        if source is not None and custody is None:
            _sync_rename_parents(roots)
            if item["state"] != "source":
                item["state"] = "source"
                _write_checkpoint(roots.custody_fd, value)
            continue
        if source is not None or custody is None:
            fail("ambiguous-session-state")
        _rename_noreplace(roots.custody_sessions_fd, session_id, roots.source_fd, session_id)
        restored = _entry_identity(roots.source_fd, session_id)
        if restored is None or not _same_identity(restored, expected):
            fail("post-restore-mismatch")
        item["state"] = "source"
        _write_checkpoint(roots.custody_fd, value)


class Parser(argparse.ArgumentParser):
    def error(self, _message):
        raise QuarantineError("invalid-arguments")


def _parser():
    parser = Parser(description=__doc__)
    parser.add_argument("action", choices=("plan", "apply", "restore"))
    parser.add_argument("--selection", required=True)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--custody-root", required=True)
    parser.add_argument("--service-root", action="append", required=True)
    return parser


def main(argv=None):
    os.umask(0o077)
    try:
        args = _parser().parse_args(argv)
        if os.geteuid() != 0:
            fail("root-required")
        roots = Roots(args)
        try:
            ids, digest, selection_info, selection_parent = _selection(args.selection)
            roots.set_selection_parent(selection_parent)
            roots.acquire_lock()
            _mount_preflight(roots, ids)
            if args.action == "plan":
                _plan(roots, ids, digest, selection_info)
                print(f"planned {len(ids)} session directories")
            elif args.action == "apply":
                _apply(roots, ids, digest, selection_info)
                print(f"moved {len(ids)} session directories into custody")
            else:
                _restore(roots, ids, digest, selection_info)
                print(f"restored {len(ids)} session directories")
        finally:
            roots.close()
        return 0
    except QuarantineError as error:
        print(f"error: {error.code}", file=sys.stderr)
        return 2
    except OSError:
        print("error: filesystem", file=sys.stderr)
        return 2
    except Exception:
        print("error: operation", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
