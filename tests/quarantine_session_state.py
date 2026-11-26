#!/usr/bin/env python3
"""Behavior tests for the offline native-session custody CLI."""
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "deploy" / "ubuntu" / "quarantine-session-state.py"
SESSION_IDS = [
    "a0000000-0000-4000-8000-000000000001",
    "b0000000-0000-4000-8000-000000000002",
]
UNRELATED_ID = "c0000000-0000-4000-8000-000000000003"


def load_quarantine_module():
    spec = importlib.util.spec_from_file_location("quarantine_session_state_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module


QUARANTINE = load_quarantine_module()
MOUNT_CONTRACT = QUARANTINE._mount_contract()


class Fixture:
    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.service = self.root / "service"
        self.state = self.service / "state"
        self.source_sessions = self.state / "sessions"
        self.run = self.service / "run"
        self.projects = self.service / "projects"
        self.custody = self.root / "custody"
        self.custody_sessions = self.custody / "sessions"
        self.receipt_dir = self.root / "receipt"
        self.receipt = self.receipt_dir / "selection.json"
        for path in (self.source_sessions, self.run, self.projects, self.custody_sessions, self.receipt_dir):
            path.mkdir(parents=True, mode=0o700)
        os.chmod(self.custody, 0o700)
        os.chmod(self.custody_sessions, 0o700)
        for session_id in [*SESSION_IDS, UNRELATED_ID]:
            session = self.source_sessions / session_id
            session.mkdir(mode=0o700)
            (session / "meta.sealed").write_bytes(b"synthetic sealed record")
        self.write_selection(SESSION_IDS)

    def write_selection(self, session_ids):
        if self.receipt.exists():
            os.chmod(self.receipt, 0o600)
        self.receipt.write_text(json.dumps({"version": 1, "sessionIds": session_ids}, separators=(",", ":")))
        os.chmod(self.receipt, 0o400)

    def command(self, action, *, state=None, custody=None, selection=None):
        cmd = [
            sys.executable, str(SCRIPT), action,
            "--selection", str(selection or self.receipt),
            "--state-root", str(state or self.state),
            "--custody-root", str(custody or self.custody),
            "--service-root", str(self.service),
        ]
        result = subprocess.run(cmd, text=True, capture_output=True, check=False)
        output = result.stdout + result.stderr
        for secret in [*SESSION_IDS, UNRELATED_ID, str(self.root)]:
            if secret in output:
                raise AssertionError("CLI output disclosed a path or session identifier")
        return result

    def close(self):
        self.temporary.cleanup()


class QuarantineSessionStateTests(unittest.TestCase):
    def setUp(self):
        if os.geteuid() != 0:
            self.skipTest("custody behavior requires the root-owned Linux boundary")
        self.fixture = Fixture()

    def tearDown(self):
        self.fixture.close()

    def require_success(self, action):
        result = self.fixture.command(action)
        self.assertEqual(result.returncode, 0, f"CLI should complete the requested state transition: {result.stderr.strip()}")
        return result.stdout.strip()

    def require_failure(self, action, code):
        result = self.fixture.command(action)
        self.assertEqual(result.returncode, 2, "unsafe state should fail closed")
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), f"error: {code}")

    def test_plan_apply_restore_preserves_unrelated_session_and_is_idempotent(self):
        self.assertEqual(self.require_success("plan"), "planned 2 session directories")
        self.assertEqual(self.require_success("plan"), "planned 2 session directories")
        self.assertEqual(self.require_success("apply"), "moved 2 session directories into custody")
        self.assertEqual(self.require_success("apply"), "moved 2 session directories into custody")
        for session_id in SESSION_IDS:
            self.assertFalse((self.fixture.source_sessions / session_id).exists())
            self.assertTrue((self.fixture.custody_sessions / session_id / "meta.sealed").is_file())
        self.assertTrue((self.fixture.source_sessions / UNRELATED_ID / "meta.sealed").is_file())
        self.assertFalse((self.fixture.custody_sessions / UNRELATED_ID).exists())

        self.assertEqual(self.require_success("restore"), "restored 2 session directories")
        self.assertEqual(self.require_success("restore"), "restored 2 session directories")
        for session_id in SESSION_IDS:
            self.assertTrue((self.fixture.source_sessions / session_id / "meta.sealed").is_file())
            self.assertFalse((self.fixture.custody_sessions / session_id).exists())
        self.assertTrue((self.fixture.source_sessions / UNRELATED_ID / "meta.sealed").is_file())

    def test_apply_recovers_a_rename_that_preceded_its_checkpoint_update(self):
        self.require_success("plan")
        os.rename(self.fixture.source_sessions / SESSION_IDS[0], self.fixture.custody_sessions / SESSION_IDS[0])

        self.require_success("apply")
        for session_id in SESSION_IDS:
            self.assertTrue((self.fixture.custody_sessions / session_id / "meta.sealed").is_file())
        self.assertTrue((self.fixture.source_sessions / UNRELATED_ID / "meta.sealed").is_file())

    def test_restore_recovers_a_rename_that_preceded_its_checkpoint_update(self):
        self.require_success("plan")
        self.require_success("apply")
        os.rename(self.fixture.custody_sessions / SESSION_IDS[0], self.fixture.source_sessions / SESSION_IDS[0])

        self.require_success("restore")
        for session_id in SESSION_IDS:
            self.assertTrue((self.fixture.source_sessions / session_id / "meta.sealed").is_file())
            self.assertFalse((self.fixture.custody_sessions / session_id).exists())

    def test_apply_recovery_fsyncs_both_rename_parents_before_checkpoint(self):
        self.require_success("plan")
        os.rename(self.fixture.source_sessions / SESSION_IDS[0], self.fixture.custody_sessions / SESSION_IDS[0])
        args = SimpleNamespace(state_root=str(self.fixture.state), custody_root=str(self.fixture.custody), service_root=[str(self.fixture.service)])
        roots = QUARANTINE.Roots(args)
        try:
            ids, digest, selection_info, selection_parent = QUARANTINE._selection(str(self.fixture.receipt))
            roots.set_selection_parent(selection_parent)
            roots.acquire_lock()
            expected_parents = {
                (os.fstat(roots.source_fd).st_dev, os.fstat(roots.source_fd).st_ino),
                (os.fstat(roots.custody_sessions_fd).st_dev, os.fstat(roots.custody_sessions_fd).st_ino),
            }
            synced_parents = []
            real_fsync = os.fsync

            def record_fsync(fd):
                info = os.fstat(fd)
                synced_parents.append((info.st_dev, info.st_ino))
                return real_fsync(fd)

            with patch.object(QUARANTINE.os, "fsync", side_effect=record_fsync):
                QUARANTINE._apply(roots, ids, digest, selection_info)
            self.assertEqual(set(synced_parents[:2]), expected_parents)
        finally:
            roots.close()

    def test_restore_recovery_fsyncs_both_rename_parents_before_checkpoint(self):
        self.require_success("plan")
        self.require_success("apply")
        os.rename(self.fixture.custody_sessions / SESSION_IDS[0], self.fixture.source_sessions / SESSION_IDS[0])
        args = SimpleNamespace(state_root=str(self.fixture.state), custody_root=str(self.fixture.custody), service_root=[str(self.fixture.service)])
        roots = QUARANTINE.Roots(args)
        try:
            ids, digest, selection_info, selection_parent = QUARANTINE._selection(str(self.fixture.receipt))
            roots.set_selection_parent(selection_parent)
            roots.acquire_lock()
            expected_parents = {
                (os.fstat(roots.source_fd).st_dev, os.fstat(roots.source_fd).st_ino),
                (os.fstat(roots.custody_sessions_fd).st_dev, os.fstat(roots.custody_sessions_fd).st_ino),
            }
            synced_parents = []
            real_fsync = os.fsync

            def record_fsync(fd):
                info = os.fstat(fd)
                synced_parents.append((info.st_dev, info.st_ino))
                return real_fsync(fd)

            with patch.object(QUARANTINE.os, "fsync", side_effect=record_fsync):
                QUARANTINE._restore(roots, ids, digest, selection_info)
            self.assertEqual(set(synced_parents[2:4]), expected_parents)
        finally:
            roots.close()

    def test_mount_preflight_detects_selected_directory_alias(self):
        selected = "/srv/legacy/state/sessions/" + SESSION_IDS[0]
        mounts = (
            MOUNT_CONTRACT.Mount("8:1", "/", "/"),
            MOUNT_CONTRACT.Mount("8:1", selected, "/srv/service/visible-session"),
        )
        with self.assertRaises(QUARANTINE.QuarantineError) as raised:
            QUARANTINE._assert_no_mount_alias(selected, ["/srv/service"], mounts, MOUNT_CONTRACT, True)
        self.assertEqual(raised.exception.code, "mount-alias")

    def test_mount_preflight_detects_ancestor_mirror_and_nested_session_mount(self):
        selected = "/srv/legacy/state/sessions/" + SESSION_IDS[0]
        ancestor_mirror = (
            MOUNT_CONTRACT.Mount("8:1", "/", "/"),
            MOUNT_CONTRACT.Mount("8:1", "/srv/legacy", "/mnt/mirror"),
        )
        with self.assertRaises(QUARANTINE.QuarantineError) as raised:
            QUARANTINE._assert_no_mount_alias(selected, ["/mnt/mirror"], ancestor_mirror, MOUNT_CONTRACT, True)
        self.assertEqual(raised.exception.code, "mount-alias")

        nested_mount = (
            MOUNT_CONTRACT.Mount("8:1", "/", "/"),
            MOUNT_CONTRACT.Mount("8:2", selected + "/mounted", "/srv/legacy/state/sessions/" + SESSION_IDS[0] + "/mounted"),
        )
        with self.assertRaises(QUARANTINE.QuarantineError) as raised:
            QUARANTINE._assert_no_mount_alias(selected, ["/srv/service"], nested_mount, MOUNT_CONTRACT, True)
        self.assertEqual(raised.exception.code, "mounted-session-subtree")

    def test_mount_preflight_detects_custody_exposure_through_declared_service_root(self):
        custody = "/srv/offline/custody"
        service_paths = ["/mnt/service"]
        mounts = (
            MOUNT_CONTRACT.Mount("8:1", "/", "/"),
            MOUNT_CONTRACT.Mount("8:1", custody, "/mnt/service/custody-view"),
        )
        with self.assertRaises(QUARANTINE.QuarantineError) as raised:
            QUARANTINE._assert_no_mount_alias(custody, service_paths, mounts, MOUNT_CONTRACT, False)
        self.assertEqual(raised.exception.code, "mount-alias")

    def test_nsfs_mount_metadata_is_ignored_but_session_subtree_mounts_still_fail(self):
        raw = (
            b"1 0 8:1 / / rw - ext4 /dev/root rw\n"
            b"2 1 0:2 nsfs:[4026531840] /srv/state/sessions/selected/ns rw - nsfs nsfs rw\n"
        )
        mounts, namespace_mountpoints = QUARANTINE._parse_mount_contract(MOUNT_CONTRACT, raw)
        self.assertEqual(len(mounts), 1)
        self.assertEqual(namespace_mountpoints, ("/srv/state/sessions/selected/ns",))
        with self.assertRaises(QUARANTINE.QuarantineError) as raised:
            QUARANTINE._assert_no_mount_alias(
                "/srv/state/sessions/selected", ["/srv/service"], mounts,
                MOUNT_CONTRACT, True, namespace_mountpoints,
            )
        self.assertEqual(raised.exception.code, "mounted-session-subtree")

        invalid = b"1 0 8:1 odd-root / rw - ext4 /dev/root rw\n"
        with self.assertRaises(QUARANTINE.QuarantineError) as raised:
            QUARANTINE._parse_mount_contract(MOUNT_CONTRACT, invalid)
        self.assertEqual(raised.exception.code, "mountinfo-invalid")

    def test_collision_stops_without_replacing_existing_custody_data_and_retry_converges(self):
        self.require_success("plan")
        collision = self.fixture.custody_sessions / SESSION_IDS[1]
        collision.mkdir(mode=0o700)
        marker = collision / "owner-data"
        marker.write_bytes(b"preserve")

        self.require_failure("apply", "custody-changed")
        self.assertFalse((self.fixture.source_sessions / SESSION_IDS[0]).exists())
        self.assertTrue((self.fixture.custody_sessions / SESSION_IDS[0] / "meta.sealed").is_file())
        self.assertTrue((self.fixture.source_sessions / SESSION_IDS[1] / "meta.sealed").is_file())
        self.assertEqual(marker.read_bytes(), b"preserve")

        marker.unlink()
        collision.rmdir()
        self.require_success("apply")
        self.require_success("restore")

    def test_wrong_inode_after_a_partial_move_stops_without_moving_other_sessions(self):
        self.require_success("plan")
        os.rename(self.fixture.source_sessions / SESSION_IDS[0], self.fixture.custody_sessions / SESSION_IDS[0])
        moved = self.fixture.custody_sessions / SESSION_IDS[0]
        os.rename(moved, self.fixture.root / "held-for-test")
        moved.mkdir(mode=0o700)
        (moved / "marker").write_bytes(b"different directory")

        self.require_failure("apply", "custody-changed")
        self.assertTrue((self.fixture.source_sessions / SESSION_IDS[1] / "meta.sealed").is_file())
        self.assertTrue((moved / "marker").is_file())

    def test_missing_source_prevents_plan_before_any_session_is_moved(self):
        (self.fixture.source_sessions / SESSION_IDS[1] / "meta.sealed").unlink()
        os.rmdir(self.fixture.source_sessions / SESSION_IDS[1])

        self.require_failure("plan", "missing-session")
        self.assertTrue((self.fixture.source_sessions / SESSION_IDS[0]).is_dir())
        self.assertFalse((self.fixture.source_sessions / SESSION_IDS[1]).exists())
        for session_id in SESSION_IDS:
            self.assertFalse((self.fixture.custody_sessions / session_id).exists())
        self.assertFalse((self.fixture.custody / ".checkpoint.json").exists())

    def test_noncanonical_directory_case_fails_closed(self):
        upper = SESSION_IDS[0].upper()
        os.rename(self.fixture.source_sessions / SESSION_IDS[0], self.fixture.source_sessions / upper)

        self.require_failure("plan", "noncanonical-session-name")
        self.assertTrue((self.fixture.source_sessions / upper / "meta.sealed").is_file())

    def test_selection_must_be_canonical_and_immutable(self):
        self.fixture.write_selection([SESSION_IDS[0], SESSION_IDS[0].upper()])
        self.require_failure("plan", "invalid-selection")
        self.fixture.write_selection(SESSION_IDS)
        os.chmod(self.fixture.receipt, 0o600)
        self.require_failure("plan", "unsafe-file")

    def test_apply_rejects_selection_receipt_replacement_after_plan(self):
        self.require_success("plan")
        replacement_dir = self.fixture.root / "replacement"
        replacement_dir.mkdir(mode=0o700)
        replacement = replacement_dir / "selection.json"
        replacement.write_text(json.dumps({"version": 1, "sessionIds": SESSION_IDS}, separators=(",", ":")))
        os.chmod(replacement, 0o400)

        result = self.fixture.command("apply", selection=replacement)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), "error: selection-changed")
        for session_id in SESSION_IDS:
            self.assertTrue((self.fixture.source_sessions / session_id).is_dir())

    def test_custody_inside_a_service_root_is_refused(self):
        nested = self.fixture.service / "private-custody"
        (nested / "sessions").mkdir(parents=True, mode=0o700)
        os.chmod(nested, 0o700)
        result = self.fixture.command("plan", custody=nested)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), "error: overlapping-roots")
        self.assertTrue((self.fixture.source_sessions / SESSION_IDS[0]).is_dir())

    def test_changed_root_identity_after_plan_is_refused(self):
        self.require_success("plan")
        other_state = self.fixture.root / "other-state"
        (other_state / "sessions").mkdir(parents=True, mode=0o700)
        for session_id in SESSION_IDS:
            (other_state / "sessions" / session_id).mkdir(mode=0o700)

        result = self.fixture.command("apply", state=other_state)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), "error: root-changed")
        for session_id in SESSION_IDS:
            self.assertTrue((self.fixture.source_sessions / session_id).is_dir())
            self.assertTrue((other_state / "sessions" / session_id).is_dir())


if __name__ == "__main__":
    unittest.main()
