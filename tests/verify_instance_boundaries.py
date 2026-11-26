"""Contract tests for the read-only Linux instance-boundary verifier."""
import errno
import importlib.util
import itertools
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

try:
    import pwd
except ImportError:
    pwd = None

IS_PRIVILEGED_LINUX = (sys.platform.startswith("linux") and hasattr(os, "geteuid")
                       and os.geteuid() == 0 and hasattr(os, "fork") and pwd is not None)

sys.dont_write_bytecode = True
SOURCE = Path(__file__).parents[1] / "deploy/ubuntu/verify-instance-boundaries.py"
spec = importlib.util.spec_from_file_location("infinite_instance_boundary_checker", SOURCE)
verifier = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = verifier
spec.loader.exec_module(verifier)


def manifest(instances):
    return json.dumps({"instances": instances}).encode("utf-8")


def cli(raw):
    with tempfile.TemporaryDirectory(prefix="instance-boundary-") as directory:
        manifest_path = Path(directory) / "manifest.json"
        manifest_path.write_bytes(raw)
        return subprocess.run([sys.executable, str(SOURCE), "--manifest", str(manifest_path)],
                              capture_output=True, text=True, check=False)


def acl_for(named_users, mask=7):
    entries = [(0x01, 0, verifier.UNDEFINED_ACL_ID)]
    entries.extend((0x02, permission, uid) for uid, permission in sorted(named_users))
    entries.extend(((0x04, 0, verifier.UNDEFINED_ACL_ID),
                    (0x10, mask, verifier.UNDEFINED_ACL_ID),
                    (0x20, 0, verifier.UNDEFINED_ACL_ID)))
    return struct.pack("<I", 2) + b"".join(struct.pack("<HHI", *entry) for entry in entries)


@unittest.skipUnless(IS_PRIVILEGED_LINUX,
                     "kernel permission contract requires privileged Linux")
class LinuxBoundaryContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        accounts = []
        seen = set()
        for entry in pwd.getpwall():
            if entry.pw_uid == 0 or entry.pw_uid in seen:
                continue
            seen.add(entry.pw_uid)
            try:
                groups = set(os.getgrouplist(entry.pw_name, entry.pw_gid))
            except (AttributeError, OSError):
                continue
            groups.add(entry.pw_gid)
            accounts.append((entry, groups))
        pair = next(((left, left_groups, right, right_groups)
                     for (left, left_groups), (right, right_groups) in itertools.combinations(accounts, 2)
                     if left.pw_uid != right.pw_uid), None)
        if pair is None:
            raise unittest.SkipTest("system has fewer than two non-root accounts")
        cls.left, cls.left_groups, cls.right, cls.right_groups = pair

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="instance-boundary-contract-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o711)
        self.left_dir = self.root / "left"
        self.left_dir.mkdir()
        os.chown(self.left_dir, self.left.pw_uid, self.left.pw_gid)
        self.left_dir.chmod(0o500)
        self.right_dir = self.root / "right"
        self.right_dir.mkdir()
        os.chown(self.right_dir, self.right.pw_uid, self.right.pw_gid)
        self.right_dir.chmod(0o500)
        self.left_file = self.root / "left-secret"
        self.left_file.write_bytes(b"synthetic fixture\n")
        os.chown(self.left_file, self.left.pw_uid, self.left.pw_gid)
        self.left_file.chmod(0o600)
        self.right_file = self.root / "right-secret"
        self.right_file.write_bytes(b"synthetic fixture\n")
        os.chown(self.right_file, self.right.pw_uid, self.right.pw_gid)
        self.right_file.chmod(0o600)

    def rows(self, left_paths=None, right_paths=None, left_retired=None, right_retired=None):
        left_row = {"name": "left", "users": [self.left.pw_name],
                    "paths": [str(path) for path in (left_paths if left_paths is not None else [self.left_dir, self.left_file])]}
        if left_retired is not None:
            left_row["retiredPaths"] = [str(path) for path in left_retired]
        right_row = {"name": "right", "users": [self.right.pw_name],
                     "paths": [str(path) for path in (right_paths if right_paths is not None else [self.right_dir, self.right_file])]}
        if right_retired is not None:
            right_row["retiredPaths"] = [str(path) for path in right_retired]
        return [left_row, right_row]

    def test_retired_paths_require_root_only_custody_and_deny_all_accounts(self):
        retired_dir = self.root / "retired-cache"
        retired_dir.mkdir()
        os.chown(retired_dir, 0, 0)
        retired_dir.chmod(0o700)
        retired_file = self.root / "retired-secret"
        retired_file.write_bytes(b"synthetic fixture\n")
        os.chown(retired_file, 0, 0)
        retired_file.chmod(0o600)

        accepted = cli(manifest(self.rows(left_retired=[retired_dir, retired_file])))
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        self.assertEqual(json.loads(accepted.stdout), {"ok": True, "instances": 2, "accounts": 2, "resources": 6})

        retired_dir.chmod(0o750)
        bad_mode = cli(manifest(self.rows(left_retired=[retired_dir])))
        self.assertNotEqual(bad_mode.returncode, 0)
        self.assertEqual(json.loads(bad_mode.stdout), {"ok": False, "error": "retired_path_permissions"})

        retired_dir.chmod(0o700)
        os.chown(retired_dir, self.left.pw_uid, 0)
        bad_owner = cli(manifest(self.rows(left_retired=[retired_dir])))
        self.assertNotEqual(bad_owner.returncode, 0)
        self.assertEqual(json.loads(bad_owner.stdout), {"ok": False, "error": "retired_path_permissions"})

        os.chown(retired_dir, 0, 0)
        try:
            os.setxattr(retired_dir, "system.posix_acl_access", acl_for([(self.left.pw_uid, 5)], mask=0))
        except OSError as error:
            if error.errno not in (errno.ENOTSUP, errno.EOPNOTSUPP, errno.EPERM):
                raise
        else:
            masked = cli(manifest(self.rows(left_retired=[retired_dir])))
            self.assertEqual(masked.returncode, 0, masked.stdout + masked.stderr)

    def test_owner_acl_grant_passes_and_peer_acl_grant_fails(self):
        os.chown(self.left_file, 0, 0)
        self.left_file.chmod(0)
        try:
            os.setxattr(self.left_file, "system.posix_acl_access", acl_for([(self.left.pw_uid, 4)]))
        except OSError as error:
            if error.errno in (errno.ENOTSUP, errno.EOPNOTSUPP, errno.EPERM):
                self.skipTest("temporary filesystem does not support POSIX access ACLs")
            raise

        accepted = cli(manifest(self.rows()))
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        self.assertEqual(json.loads(accepted.stdout), {"ok": True, "instances": 2, "accounts": 2, "resources": 4})

        for permission in (4, 2, 1):
            with self.subTest(permission=permission):
                os.setxattr(self.left_file, "system.posix_acl_access",
                            acl_for([(self.left.pw_uid, 4), (self.right.pw_uid, permission)]))
                rejected = cli(manifest(self.rows()))
                self.assertNotEqual(rejected.returncode, 0)
                self.assertEqual(json.loads(rejected.stdout), {"ok": False, "error": "peer_access"})
                self.assertNotIn(str(self.left_file), rejected.stdout + rejected.stderr)
                self.assertNotIn(self.left.pw_name, rejected.stdout + rejected.stderr)

    def test_directory_and_file_roots_cannot_overlap(self):
        nested = self.left_dir / "nested"
        nested.write_bytes(b"synthetic fixture\n")
        os.chown(nested, self.right.pw_uid, self.right.pw_gid)
        nested.chmod(0o600)
        rejected = cli(manifest(self.rows(left_paths=[self.left_dir], right_paths=[nested])))
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(json.loads(rejected.stdout), {"ok": False, "error": "resource_ownership_overlap"})

    def test_same_inode_roots_cannot_cross_instance_ownership(self):
        alias = self.root / "left-alias"
        os.link(self.left_file, alias)
        rejected = cli(manifest(self.rows(left_paths=[self.left_file], right_paths=[alias])))
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(json.loads(rejected.stdout), {"ok": False, "error": "resource_ownership_overlap"})


class ManifestContract(unittest.TestCase):
    def test_requires_two_unique_instances_with_absolute_resources(self):
        valid = manifest([
            {"name": "left", "users": ["host-left", "agent-left"], "paths": ["/fixture/left"]},
            {"name": "right", "users": ["host-right", "agent-right"], "paths": ["/fixture/right"]},
        ])
        self.assertEqual(len(verifier.parse_manifest(valid)), 2)
        invalid = [
            {"instances": [{"name": "left", "users": ["a"], "paths": ["/fixture/a"]}]},
            {"instances": [{"name": "same", "users": ["a"], "paths": ["/fixture/a"]},
                           {"name": "same", "users": ["b"], "paths": ["/fixture/b"]}]},
            {"instances": [{"name": "left", "users": ["a"], "paths": ["relative"]},
                           {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}]},
        ]
        for value in invalid:
            with self.subTest(case=len(value["instances"])):
                with self.assertRaises(verifier.VerificationError):
                    verifier.parse_manifest(json.dumps(value).encode("utf-8"))

    def test_invalid_manifest_error_never_echoes_private_fields(self):
        raw = json.dumps({"instances": [
            {"name": "duplicate", "users": ["sensitive-owner"], "paths": ["/fixture/one"]},
            {"name": "duplicate", "users": ["sensitive-peer"], "paths": ["/fixture/two"]},
        ]}).encode("utf-8")
        result = cli(raw)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"ok": False, "error": "invalid_manifest"})
        for sensitive in ("sensitive-owner", "sensitive-peer", "/fixture/one", "/fixture/two"):
            self.assertNotIn(sensitive, result.stdout + result.stderr)

    def test_mountinfo_maps_nested_bind_aliases_without_walking_directories(self):
        mounts = verifier.parse_mountinfo(
            "1 0 8:1 / / rw - ext4 /dev/root rw\n"
            "2 1 8:2 /org/common /srv/instance-a/shared rw - ext4 /dev/data rw\n"
            "3 1 8:2 /org/common /srv/common rw - ext4 /dev/data rw\n"
        )
        owner_roots = verifier._mount_roots_for_path("/srv/instance-a", "directory", mounts)
        peer_roots = verifier._mount_roots_for_path("/srv/common", "directory", mounts)
        self.assertIn(("8:2", "/org/common"), owner_roots)
        self.assertIn(("8:2", "/org/common"), peer_roots)
        with self.assertRaisesRegex(verifier.VerificationError, "resource_ownership_overlap"):
            verifier._ensure_disjoint((
                verifier.Resource("/srv/instance-a", "directory", 0, 8, 1, owner_roots),
                verifier.Resource("/srv/common", "directory", 1, 8, 2, peer_roots),
            ))

    def test_mountinfo_unescapes_path_fields(self):
        mounts = verifier.parse_mountinfo("2 1 8:2 /org/data /srv/with\\040space rw - ext4 /dev/data rw\n")
        self.assertEqual(mounts[0].mountpoint, "/srv/with space")

    def test_retired_paths_manifest_validation(self):
        valid_omitted = manifest([
            {"name": "left", "users": ["host-left"], "paths": ["/fixture/left"]},
            {"name": "right", "users": ["host-right"], "paths": ["/fixture/right"]},
        ])
        parsed_omitted = verifier.parse_manifest(valid_omitted)
        self.assertEqual(parsed_omitted[0].retired_paths, ())
        self.assertEqual(parsed_omitted[1].retired_paths, ())

        valid_with_retired = manifest([
            {"name": "left", "users": ["host-left"], "paths": ["/fixture/left"],
             "retiredPaths": ["/fixture/left-retired"]},
            {"name": "right", "users": ["host-right"], "paths": [],
             "retiredPaths": ["/fixture/right-retired"]},
        ])
        parsed_with_retired = verifier.parse_manifest(valid_with_retired)
        self.assertEqual(parsed_with_retired[0].retired_paths, ("/fixture/left-retired",))
        self.assertEqual(parsed_with_retired[1].paths, ())
        self.assertEqual(parsed_with_retired[1].retired_paths, ("/fixture/right-retired",))

        too_long = "/" + ("a" * verifier.MAX_PATH_BYTES)
        invalid_cases = [
            [{"name": "left", "users": ["a"], "paths": ["/fixture/a"], "extra": []},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"], "paths": ["/fixture/a"], "retiredPaths": "/fixture/r"},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"], "paths": ["/fixture/a"], "retiredPaths": [123]},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"], "paths": ["/fixture/a"], "retiredPaths": ["relative"]},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"], "paths": ["/fixture/a"], "retiredPaths": ["/bad\x00path"]},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"], "paths": ["/fixture/a"], "retiredPaths": [too_long]},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"], "paths": [], "retiredPaths": []},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"], "paths": ["/fixture/a"],
              "retiredPaths": ["/fixture/r", "/fixture/r"]},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"], "paths": ["/fixture/a"],
              "retiredPaths": ["/fixture/a"]},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": "left", "users": ["a"],
              "paths": [f"/fixture/p{i}" for i in range(verifier.MAX_PATHS_PER_INSTANCE)],
              "retiredPaths": ["/fixture/over-instance-cap"]},
             {"name": "right", "users": ["b"], "paths": ["/fixture/b"]}],
            [{"name": f"inst-{i}", "users": [f"u-{i}"],
              "paths": [f"/fixture/{i}/p{j}" for j in range(verifier.MAX_PATHS_PER_INSTANCE)]}
             for i in range(4)] + [
                {"name": "inst-extra", "users": ["u-extra"], "paths": [],
                 "retiredPaths": ["/fixture/extra-r"]}
            ],
        ]
        for case in invalid_cases:
            with self.subTest(case=case):
                with self.assertRaisesRegex(verifier.VerificationError, "invalid_manifest"):
                    verifier.parse_manifest(manifest(case))

    def test_retired_paths_disjointness_checks(self):
        root_mount = (("8:1", "/srv/left"),)
        peer_mount = (("8:1", "/srv/right"),)
        verifier._ensure_disjoint((
            verifier.Resource("/srv/left", "directory", 0, 8, 1, root_mount, retired=False),
            verifier.Resource("/srv/left/retired", "directory", 0, 8, 2, (("8:1", "/srv/left/retired"),), retired=True),
            verifier.Resource("/srv/right", "directory", 1, 8, 3, peer_mount, retired=False),
        ))

        overlap_cases = [
            (
                verifier.Resource("/srv/shared", "directory", 0, 8, 1, (("8:1", "/srv/shared"),), retired=True),
                verifier.Resource("/srv/shared/sub", "file", 1, 8, 2, (("8:1", "/srv/shared/sub"),), retired=False),
            ),
            (
                verifier.Resource("/srv/shared", "directory", 0, 8, 1, (("8:1", "/srv/shared"),), retired=True),
                verifier.Resource("/srv/shared", "directory", 1, 8, 1, (("8:1", "/srv/shared"),), retired=True),
            ),
            (
                verifier.Resource("/srv/left/r", "directory", 0, 8, 1, (("8:1", "/srv/left/r"),), retired=True),
                verifier.Resource("/srv/left/r/sub", "directory", 0, 8, 2, (("8:1", "/srv/left/r/sub"),), retired=True),
            ),
            (
                verifier.Resource("/srv/left", "directory", 0, 8, 1, root_mount, retired=True),
                verifier.Resource("/srv/left/active", "file", 0, 8, 2, (("8:1", "/srv/left/active"),), retired=False),
            ),
            (
                verifier.Resource("/srv/left/active", "file", 0, 8, 5, (("8:1", "/srv/left/active"),), retired=False),
                verifier.Resource("/srv/left/retired-link", "file", 0, 8, 5, (("8:1", "/srv/left/retired-link"),), retired=True),
            ),
            (
                verifier.Resource("/srv/left/active", "directory", 0, 8, 6, (("8:2", "/org/shared"),), retired=False),
                verifier.Resource("/srv/left/retired", "directory", 0, 8, 7, (("8:2", "/org/shared"),), retired=True),
            ),
        ]
        for pair in overlap_cases:
            with self.subTest(pair=pair):
                with self.assertRaisesRegex(verifier.VerificationError, "resource_ownership_overlap"):
                    verifier._ensure_disjoint(pair)

    def test_resolve_resources_checks_retired_path_permissions(self):
        mounts = (verifier.Mount("8:1", "/", "/"),)
        instances = (
            verifier.InstanceSpec("left", ("u-left",), ("/srv/left/active",), ("/srv/left/retired-dir", "/srv/left/retired-file")),
            verifier.InstanceSpec("right", ("u-right",), ("/srv/right/active",)),
        )
        stat_map = {
            "/srv/left/active": os.stat_result((stat.S_IFDIR | 0o500, 10, 8, 1, 1000, 1000, 0, 0, 0, 0)),
            "/srv/left/retired-dir": os.stat_result((stat.S_IFDIR | 0o700, 11, 8, 1, 0, 0, 0, 0, 0, 0)),
            "/srv/left/retired-file": os.stat_result((stat.S_IFREG | 0o600, 12, 8, 1, 0, 0, 0, 0, 0, 0)),
            "/srv/right/active": os.stat_result((stat.S_IFDIR | 0o500, 13, 8, 1, 1001, 1001, 0, 0, 0, 0)),
        }
        with mock.patch.object(verifier.Path, "resolve", lambda self, strict=False: str(self)), \
                mock.patch.object(verifier.os, "stat", side_effect=lambda path: stat_map[path]):
            resolved = verifier._resolve_resources(instances, mounts)
        self.assertEqual([item.retired for item in resolved], [False, True, True, False])

        bad_stats = [
            os.stat_result((stat.S_IFDIR | 0o700, 11, 8, 1, 1000, 0, 0, 0, 0, 0)),
            os.stat_result((stat.S_IFDIR | 0o750, 11, 8, 1, 0, 0, 0, 0, 0, 0)),
            os.stat_result((stat.S_IFDIR | 0o705, 11, 8, 1, 0, 0, 0, 0, 0, 0)),
            os.stat_result((stat.S_IFREG | 0o640, 11, 8, 1, 0, 0, 0, 0, 0, 0)),
        ]
        single_retired = (
            verifier.InstanceSpec("left", ("u-left",), ("/srv/left/active",), ("/srv/left/retired",)),
            verifier.InstanceSpec("right", ("u-right",), ("/srv/right/active",)),
        )
        for bad_stat in bad_stats:
            with self.subTest(mode=oct(stat.S_IMODE(bad_stat.st_mode)), uid=bad_stat.st_uid):
                local_map = {
                    "/srv/left/active": stat_map["/srv/left/active"],
                    "/srv/left/retired": bad_stat,
                    "/srv/right/active": stat_map["/srv/right/active"],
                }
                with mock.patch.object(verifier.Path, "resolve", lambda self, strict=False: str(self)), \
                        mock.patch.object(verifier.os, "stat", side_effect=lambda path: local_map[path]):
                    with self.assertRaisesRegex(verifier.VerificationError, "retired_path_permissions"):
                        verifier._resolve_resources(single_retired, mounts)

    def test_permission_matrix_enforces_no_access_to_retired_paths(self):
        accounts = (
            verifier.Account("u-left", 1000, 1000, (1000,), 0),
            verifier.Account("u-right", 1001, 1001, (1001,), 1),
        )
        resources = (
            verifier.Resource("/srv/left/active", "directory", 0, 8, 1, (("8:1", "/srv/left/active"),), retired=False),
            verifier.Resource("/srv/left/retired", "directory", 0, 8, 2, (("8:1", "/srv/left/retired"),), retired=True),
            verifier.Resource("/srv/right/active", "file", 1, 8, 3, (("8:1", "/srv/right/active"),), retired=False),
        )
        recorded_requests = {}

        def probe_all_denied(account, requests):
            recorded_requests[account.name] = requests
            if account.instance_index == 0:
                return tuple(path == "/srv/left/active" for path, _mode in requests)
            return tuple(path == "/srv/right/active" for path, _mode in requests)

        with mock.patch.object(verifier, "_probe_account", side_effect=probe_all_denied):
            verifier._permission_matrix(accounts, resources)

        for account_name in ("u-left", "u-right"):
            retired_modes = [mode for path, mode in recorded_requests[account_name] if path == "/srv/left/retired"]
            self.assertEqual(retired_modes, [os.R_OK, os.W_OK, os.X_OK])

        for leaky_instance, leaky_mode in ((0, os.R_OK), (0, os.W_OK), (0, os.X_OK), (1, os.R_OK)):
            with self.subTest(leaky_instance=leaky_instance, leaky_mode=leaky_mode):
                def probe_leaky_retired(account, requests):
                    outcomes = []
                    for path, mode in requests:
                        if path == "/srv/left/retired":
                            outcomes.append(account.instance_index == leaky_instance and mode == leaky_mode)
                        elif account.instance_index == 0:
                            outcomes.append(path == "/srv/left/active")
                        else:
                            outcomes.append(path == "/srv/right/active")
                    return tuple(outcomes)

                with mock.patch.object(verifier, "_probe_account", side_effect=probe_leaky_retired):
                    with self.assertRaisesRegex(verifier.VerificationError, "retired_path_accessible"):
                        verifier._permission_matrix(accounts, resources)

        def probe_missing_owner(account, requests):
            if account.instance_index == 0:
                return tuple(False for _ in requests)
            return tuple(path == "/srv/right/active" for path, _mode in requests)

        with mock.patch.object(verifier, "_probe_account", side_effect=probe_missing_owner):
            with self.assertRaisesRegex(verifier.VerificationError, "owner_inaccessible"):
                verifier._permission_matrix(accounts, resources)

        def probe_peer_active(account, requests):
            if account.instance_index == 0:
                return tuple(path in ("/srv/left/active", "/srv/right/active") for path, _mode in requests)
            return tuple(path == "/srv/right/active" for path, _mode in requests)

        with mock.patch.object(verifier, "_probe_account", side_effect=probe_peer_active):
            with self.assertRaisesRegex(verifier.VerificationError, "peer_access"):
                verifier._permission_matrix(accounts, resources)


if __name__ == "__main__":
    unittest.main()
