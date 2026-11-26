"""Contract tests for the read-only Linux instance-boundary verifier."""
import errno
import importlib.util
import itertools
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

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

    def rows(self, left_paths=None, right_paths=None):
        return [
            {"name": "left", "users": [self.left.pw_name],
             "paths": [str(path) for path in (left_paths or [self.left_dir, self.left_file])]},
            {"name": "right", "users": [self.right.pw_name],
             "paths": [str(path) for path in (right_paths or [self.right_dir, self.right_file])]},
        ]

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


if __name__ == "__main__":
    unittest.main()
