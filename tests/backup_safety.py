"""Exercise the backup boundary with synthetic procfs and a stateful service controller."""
import importlib.util
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


source_path = Path(os.environ.get("INFINITE_BACKUP_SOURCE", Path(__file__).parents[1] / "deploy/ubuntu/backup.py"))
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("backup", source_path)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.source = root / "data"
        self.output = root / "output"
        self.proc = root / "proc"
        for path in (self.source, self.output, self.proc):
            path.mkdir()
        for name in ("control", "control-home", "agent-home", "workspaces", "cmux"):
            (self.source / name).mkdir()
            (self.source / name / "fixture").write_text(name + " state")
        self.groups = {unit: "/system.slice/" + unit for unit in ("infinite.service", "infinite-cmux.service")}
        self.writer("101", self.groups["infinite.service"])
        self.writer("102", self.groups["infinite-cmux.service"])
        self.frozen = set()
        self.calls = []
        self.copied = []
        self.copy_error = True
        self.partial_freeze_error = False
        self.thaw_error = False
        self.watchdog_fires = False
        self.addCleanup(patch.stopall)
        patch.object(backup, "Path", side_effect=lambda path: self.proc if str(path) == "/proc" else Path(path)).start()
        patch.object(backup.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=os.getuid())).start()
        patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024 ** 3)).start()
        patch.object(backup, "run", side_effect=self.run_command).start()
        self.emergency = patch.object(backup.subprocess, "run", return_value=SimpleNamespace(returncode=0)).start()

    def writer(self, pid, group):
        directory = self.proc / pid
        directory.mkdir(exist_ok=True)
        (directory / "cgroup").write_text("0::" + group + "\n")
        (directory / "stat").write_text(pid + " (synthetic worker) " + " ".join(["S"] + ["0"] * 18 + ["12345"]))

    def run_command(self, *args, **kwargs):
        self.calls.append(args)
        if args[0] == "du":
            return "100 " + args[-1]
        if args[0] == "systemd-run":
            return ""
        if args[0] == "systemctl":
            action = args[1]
            if action == "is-active":
                return "active"
            if action == "show":
                unit = args[2]
                if "LoadState" in args:
                    return "loaded" if unit in self.groups else "not-found"
                if "--property=ControlGroup" in args:
                    return self.groups[unit]
                if "FreezerState" in args:
                    return "frozen" if unit in self.frozen else "running"
            if action == "freeze":
                self.frozen.add(args[2])
                if self.partial_freeze_error:
                    raise subprocess.CalledProcessError(1, args)
                self.frozen.update(args[2:])
                return ""
            if action == "thaw":
                if self.thaw_error and args[2] == "infinite.service":
                    raise subprocess.CalledProcessError(1, args)
                self.frozen.discard(args[2])
                return ""
            if action == "stop":
                return ""
        if args[0] == "sync":
            return ""
        if args[0] == "cp":
            self.assertEqual(self.frozen, set(self.groups), "Copy started without freezing every supported writer")
            original, destination = Path(args[-2]), Path(args[-1])
            shutil.copytree(original, destination)
            self.copied.append((original.name, (destination / "fixture").read_text()))
            if original.name == "cmux":
                if self.watchdog_fires:
                    self.frozen.discard("infinite-cmux.service")
                if self.copy_error:
                    raise subprocess.TimeoutExpired(args, 30)
            return ""
        raise AssertionError("Unexpected external command: " + repr(args))

    def assert_no_snapshot_published(self):
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(list(self.source.glob(".backup-*")), [])

    def test_two_service_snapshot_copies_cmux_and_thaws_both_after_timeout(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            backup.create_backup(self.source, self.output, "age1synthetic")
        self.assertIn(("cmux", "cmux state"), self.copied)
        self.assertEqual(self.frozen, set())
        watchdog = next(call for call in self.calls if call[0] == "systemd-run")
        self.assertEqual(watchdog[-2:], ("infinite.service", "infinite-cmux.service"))
        self.assert_no_snapshot_published()

    def test_partial_freeze_and_thaw_failure_still_attempts_both_and_keeps_watchdog(self):
        self.partial_freeze_error = True
        self.thaw_error = True
        with self.assertRaisesRegex(RuntimeError, "watchdog remains armed"):
            backup.create_backup(self.source, self.output, "age1synthetic")
        thaws = [call[2] for call in self.calls if call[:2] == ("systemctl", "thaw")]
        self.assertEqual(thaws, ["infinite.service", "infinite-cmux.service"])
        self.assertFalse(any(call[:2] == ("systemctl", "stop") for call in self.calls))
        self.assertEqual([call.args[0][2] for call in self.emergency.call_args_list], ["infinite.service", "infinite-cmux.service"])
        self.assertEqual(self.copied, [])
        self.assert_no_snapshot_published()

    def test_untracked_writer_is_rejected_before_any_freeze(self):
        self.writer("103", "/system.slice/untracked.service")
        with self.assertRaisesRegex(RuntimeError, "outside"):
            backup.create_backup(self.source, self.output, "age1synthetic")
        self.assertFalse(any(call[0] == "systemd-run" or call[:2] == ("systemctl", "freeze") for call in self.calls))

    def test_broad_service_cgroup_is_rejected(self):
        self.groups["infinite.service"] = "/system.slice"
        self.writer("101", "/system.slice")
        with self.assertRaisesRegex(RuntimeError, "unexpected cgroup"):
            backup.create_backup(self.source, self.output, "age1synthetic")
        self.assertEqual(self.copied, [])

    def test_host_without_cmux_retains_original_directory_coverage(self):
        del self.groups["infinite-cmux.service"]
        shutil.rmtree(self.proc / "102")
        shutil.rmtree(self.source / "cmux")
        services, _, names, writers = backup.backup_plan(self.source)
        self.assertEqual(services, ["infinite.service"])
        self.assertEqual(set(names), {"control", "control-home", "agent-home", "workspaces"})
        self.assertEqual(set(writers), {"101"})

    def test_cmux_directory_symlink_is_rejected(self):
        shutil.rmtree(self.source / "cmux")
        (self.source / "cmux").symlink_to(self.source / "workspaces", target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "real directories"):
            backup.backup_plan(self.source)

    def test_watchdog_thaw_during_copy_rejects_snapshot_and_thaws_other_service(self):
        self.copy_error = False
        self.watchdog_fires = True
        with self.assertRaisesRegex(RuntimeError, "Watchdog thawed"):
            backup.create_backup(self.source, self.output, "age1synthetic")
        self.assertEqual(self.frozen, set())
        self.assert_no_snapshot_published()


@unittest.skipUnless(sys.platform == "linux" and shutil.which("getfacl") and shutil.which("setfacl"), "Linux ACL utilities are required")
class BackupACLs(unittest.TestCase):
    def test_archive_restores_named_and_default_acls_with_modes_and_owners(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original"
            restored = root / "restored"
            original.mkdir(mode=0o700)
            restored.mkdir(mode=0o700)
            workspace = original / "workspace"
            workspace.mkdir(mode=0o750)
            content = workspace / "fixture"
            content.write_text("synthetic ACL recovery fixture\n")
            content.chmod(0o640)
            subprocess.run(["setfacl", "-m", "u:60001:r-x,d:u::rwx,d:u:60001:r-x,d:g::r-x,d:m::r-x,d:o::---", str(workspace)], check=True)
            subprocess.run(["setfacl", "-m", "u:60001:r--", str(content)], check=True)
            archive = root / "snapshot.tar.gz"
            with archive.open("wb") as target:
                subprocess.run(backup.archive_command(original), stdout=target, check=True)
            subprocess.run(["tar", "--extract", "--gzip", "--acls", "--numeric-owner", "--same-owner", "--same-permissions", "--keep-old-files", "--file=" + str(archive), "--directory=" + str(restored)], check=True)
            for relative in ("workspace", "workspace/fixture"):
                left, right = original / relative, restored / relative
                acl = lambda path: subprocess.check_output(["getfacl", "--numeric", "--omit-header", str(path)], text=True, stderr=subprocess.DEVNULL)
                self.assertEqual(acl(left), acl(right), "Recovery lost an access or default ACL")
                self.assertEqual((stat.S_IMODE(left.stat().st_mode), left.stat().st_uid, left.stat().st_gid), (stat.S_IMODE(right.stat().st_mode), right.stat().st_uid, right.stat().st_gid))
            self.assertEqual(content.read_bytes(), (restored / "workspace/fixture").read_bytes())


if __name__ == "__main__":
    unittest.main()
