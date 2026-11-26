import ctypes
import os
import pathlib
import re
import secrets
import select
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

os.umask(0o022)
allowed = {"worker.py", "project.py", "npm-shell.sh", "toolchain.json", "snapshot.json", "source.pack", "working-tree.tar"}
interrupted = 0
def admit_workspace():
    if len(sys.argv) != 2:
        raise RuntimeError("missing workspace selection")
    expected = sys.argv[1]
    if expected != "-" and not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", expected):
        raise RuntimeError("invalid workspace selection")
    try:
        descriptor = os.open("/etc/infinite-check-workspace", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if expected != "-":
            raise RuntimeError("runner has no workspace binding")
    else:
        with os.fdopen(descriptor, "rb") as marker:
            info = os.fstat(marker.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError("runner workspace binding is not administrator-owned")
            label = expected.encode("ascii")
            if expected == "-" or marker.read(66) not in (label, label + b"\n"):
                raise RuntimeError("runner does not belong to the selected workspace")
    print("INFINITE-CHECK-READY-v2", flush=True)

def on_signal(number, _frame):
    global interrupted
    interrupted = number
for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(number, on_signal)
def disconnected():
    readable, _, _ = select.select([sys.stdin.buffer], [], [], 0)
    if not readable:
        return False
    extra = sys.stdin.buffer.read(1)
    if extra:
        raise RuntimeError("unexpected bytes after verification frame")
    return True
def exit_info(status):
    return status.si_status if status.si_code == os.CLD_EXITED else 128 + status.si_status
def stop_group(pid):
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    time.sleep(0.2)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
def await_fallback(child):
    while True:
        status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
        if status is not None:
            code = exit_info(status)
            stop_group(child.pid)
            child.wait()
            return code
        if interrupted or disconnected():
            number = interrupted or signal.SIGTERM
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 7
            while time.monotonic() < deadline:
                status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
                if status is not None:
                    stop_group(child.pid)
                    child.wait()
                    return 128 + number
                time.sleep(0.1)
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            return 128 + number
        time.sleep(0.1)
def launch_fallback(base, env):
    if not sys.platform.startswith("linux"):
        raise RuntimeError("runner lacks supported process containment")
    prctl = ctypes.CDLL(None, use_errno=True).prctl
    PR_SET_CHILD_SUBREAPER = 36
    if prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "could not enable child subreaper")
    children = pathlib.Path(f"/proc/self/task/{os.getpid()}/children")
    children.read_text()
    child = subprocess.Popen([sys.executable, "worker.py"], cwd=base, env=env,
                             stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        return await_fallback(child)
    finally:
        while True:
            owned = [int(pid) for pid in children.read_text().split()]
            if not owned:
                break
            for pid in owned:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)


def cleanup_docker(run_id, base):
    docker = shutil.which("docker")
    socket = pathlib.Path("/var/run/docker.sock")
    if not docker or not socket.is_socket() or not os.access(socket, os.R_OK | os.W_OK):
        return
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(base), "DOCKER_HOST": "unix:///var/run/docker.sock"}
    for kind in ("container", "network", "volume", "image"):
        found = set()
        for label in ("com.docker.compose.project", "io.infinite.check"):
            command = [docker, kind, "ls", "-q", "--filter", f"label={label}={run_id}"]
            if kind == "container":
                command.append("--all")
            found.update(subprocess.check_output(command, env=env, text=True, timeout=15).split())
        if found:
            command = [docker, kind, "rm"]
            if kind == "container":
                command.append("--force")
            subprocess.run([*command, *sorted(found)], env=env, check=True, timeout=30, stdout=subprocess.DEVNULL)


def systemd_probe(token, base, env):
    systemctl, systemd_run = shutil.which("systemctl"), shutil.which("systemd-run")
    if not systemctl or not systemd_run or subprocess.run([systemctl, "--user", "is-system-running"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        return None
    probe = [systemd_run, "--user", "--quiet", "--wait", "--collect", "--pipe",
             "--unit=iv-" + token + "-probe.service", "--property=KillMode=control-group",
             "--property=TimeoutStopSec=5s", "--working-directory=" + str(base)]
    probe.extend("--setenv=" + key + "=" + value for key, value in env.items())
    probe.extend(["--", shutil.which("true") or "/usr/bin/true"])
    check = subprocess.run(probe, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    return (systemctl, systemd_run) if check.returncode == 0 else None
def launch_systemd(base, env, token, systemd):
    systemctl, systemd_run = systemd
    unit = "iv-" + token + ".service"
    command = [systemd_run, "--user", "--quiet", "--wait", "--collect", "--pipe",
               "--unit=" + unit, "--property=KillMode=control-group",
               "--property=TimeoutStopSec=5s", "--working-directory=" + str(base)]
    command.extend("--setenv=" + key + "=" + value for key, value in env.items())
    command.extend(["--", sys.executable, "worker.py"])
    child = subprocess.Popen(command, cwd=base, stdin=subprocess.DEVNULL)
    while child.poll() is None:
        if interrupted or disconnected():
            subprocess.run([systemctl, "--user", "stop", unit], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            try:
                return child.wait(timeout=7), True
            except subprocess.TimeoutExpired:
                child.terminate()
                try:
                    return child.wait(timeout=2), True
                except subprocess.TimeoutExpired:
                    child.kill()
                    return child.wait(), True
        time.sleep(0.1)
    return child.returncode, False
try:
    admit_workspace()
    header = sys.stdin.buffer.read(8)
    if len(header) != 8:
        raise EOFError("missing verification frame")
    size = int.from_bytes(header, "big")
    if size <= 0 or size > 1073741824:
        raise RuntimeError("invalid verification frame size")
    with (
        tempfile.TemporaryDirectory(prefix="iv-", dir="/tmp") as root,
        tempfile.TemporaryDirectory(prefix=".iv-", dir=pathlib.Path.home()) as private_home,
    ):
        base = pathlib.Path(root)
        payload_path = base / "payload.tar.gz"
        with payload_path.open("wb") as output:
            remaining = size
            while remaining:
                chunk = sys.stdin.buffer.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise EOFError("incomplete verification frame")
                output.write(chunk)
                remaining -= len(chunk)
        seen = set()
        with tarfile.open(payload_path, mode="r|*") as archive:
            for member in archive:
                if member.name not in allowed or not member.isfile() or member.name in seen:
                    raise RuntimeError("invalid verification payload")
                source = archive.extractfile(member)
                if source is None:
                    raise RuntimeError("invalid verification payload")
                (base / member.name).write_bytes(source.read())
                seen.add(member.name)
        if seen != allowed:
            raise RuntimeError("incomplete verification payload")
        env = {key: os.environ[key] for key in ("HOME", "PATH", "LANG", "LC_ALL", "TZ", "ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME") if key in os.environ}
        token = secrets.token_hex(16)
        run_id = "iv-" + token
        env["INFINITE_CHECK_RUN_ID"] = run_id
        env["INFINITE_CHECK_HOME"] = private_home
        systemd = systemd_probe(token, base, env)
        try:
            if systemd:
                code, cancelled = launch_systemd(base, env, token, systemd)
            else:
                code = launch_fallback(base, env)
                cancelled = bool(interrupted)
        finally:
            cleanup_docker(run_id, base)
        if cancelled and not code:
            code = 128 + (interrupted or signal.SIGTERM)
        raise SystemExit(code)
except (EOFError, OSError, RuntimeError, tarfile.TarError, subprocess.SubprocessError) as error:
    sys.stderr.write("remote bootstrap: " + str(error) + "\n")
    raise SystemExit(2)
