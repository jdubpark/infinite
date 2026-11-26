"""Execution modes for foreign-project cloud verification snapshots."""

from __future__ import annotations

import hashlib
import json
import pathlib
import platform
import re
import shutil
import stat
from typing import Callable


class ProjectError(Exception):
    pass


Run = Callable[..., bytes]
Execute = Callable[..., tuple[int, bytes, bytes]]


def _json(output: bytes, what: str) -> object:
    try:
        return json.loads(output)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ProjectError(f"could not parse Compose {what}") from error


def _safe_path(root: pathlib.Path, value: object, field: str) -> pathlib.Path:
    if not isinstance(value, str) or not value:
        raise ProjectError(f"Compose {field} must be a non-empty path")
    rel = pathlib.PurePosixPath(value)
    if rel.is_absolute() or ".." in rel.parts or rel.as_posix() != value:
        raise ProjectError(f"Compose {field} must stay inside the checkout")
    path = root.joinpath(*rel.parts)
    try:
        info = path.lstat()
        resolved = path.resolve(strict=True)
        resolved.relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise ProjectError(f"Compose {field} escapes the checkout or is missing") from error
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or not resolved.is_file():
        raise ProjectError(f"Compose {field} must be a regular file")
    return resolved


def _digest_ref(value: object, service: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProjectError(f"Compose service {service} has no immutable image reference")
    if "@sha256:" not in value:
        raise ProjectError(f"Compose service {service} uses a mutable image reference; pin it by digest or use generic command mode")
    digest = value.rsplit("@sha256:", 1)[1]
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ProjectError(f"Compose service {service} has an invalid image digest")
    return "sha256:" + digest


def _config(root: pathlib.Path, compose_file: pathlib.Path, run_id: str,
            env: dict[str, str], run: Run, expected_platform: str) -> dict[str, object]:
    docker = shutil.which("docker") or "docker"
    result = run([docker, "compose", "-p", run_id, "-f", str(compose_file), "config", "--format", "json"],
                 cwd=root, env=env, capture=True)
    config = _json(result, "config")
    if not isinstance(config, dict) or not isinstance(config.get("services"), dict) or not config["services"]:
        raise ProjectError("resolved Compose config has no services")
    services = config["services"]
    for name, service in services.items():
        if not isinstance(service, dict):
            raise ProjectError(f"invalid Compose service: {name}")
        if "build" in service:
            raise ProjectError(f"Compose service {name} builds an image; use a digest-pinned image or generic command mode")
        if service.get("platform") != expected_platform:
            raise ProjectError(f"Compose service {name} must explicitly use platform {expected_platform}")
        _digest_ref(service.get("image"), name)
        if service.get("container_name"):
            raise ProjectError(f"Compose service {name} sets a fixed container name; remove it to isolate concurrent jobs")
        for namespace in ("network_mode", "ipc", "pid", "uts"):
            if service.get(namespace) in ("host", "service", "container") or str(service.get(namespace, "")).startswith(("service:", "container:")):
                raise ProjectError(f"Compose service {name} shares the host or another container namespace")
        for mount in service.get("volumes", []):
            if not isinstance(mount, dict):
                raise ProjectError(f"invalid volume mount in service {name}")
            if mount.get("type") != "bind":
                continue
            source = mount.get("source")
            if not isinstance(source, str) or not pathlib.Path(source).is_absolute():
                raise ProjectError(f"service {name} has an invalid bind mount source")
            source_path = pathlib.Path(source).resolve(strict=True)
            try:
                source_path.relative_to(root.resolve())
            except ValueError as error:
                raise ProjectError(f"service {name} has a bind mount outside the checkout") from error
        for port in service.get("ports", []):
            if isinstance(port, dict) and port.get("published"):
                raise ProjectError(f"service {name} publishes a fixed host port; use an ephemeral port or generic command mode")
    for kind in ("volumes", "networks"):
        resources = config.get(kind, {})
        if isinstance(resources, dict):
            for name, resource in resources.items():
                if isinstance(resource, dict):
                    if resource.get("external"):
                        raise ProjectError(f"Compose {kind[:-1]} {name} is external")
                    actual_name = resource.get("name")
                    if actual_name and actual_name != f"{run_id}_{name}":
                        raise ProjectError(f"Compose {kind[:-1]} {name} uses a fixed resource name")
    for kind in ("configs", "secrets"):
        resources = config.get(kind, {})
        if isinstance(resources, dict):
            for name, resource in resources.items():
                if not isinstance(resource, dict):
                    raise ProjectError(f"invalid Compose {kind[:-1]} {name}")
                if resource.get("external"):
                    raise ProjectError(f"Compose {kind[:-1]} {name} is external")
                source = resource.get("file")
                if source:
                    source_path = pathlib.Path(str(source)).resolve(strict=True)
                    try:
                        source_path.relative_to(root.resolve())
                    except ValueError as error:
                        raise ProjectError(f"Compose {kind[:-1]} {name} is outside the checkout") from error
                    if not source_path.is_file():
                        raise ProjectError(f"Compose {kind[:-1]} {name} is missing from the checkout")
    return config


def execute_project(*, checkout: pathlib.Path, cwd: pathlib.Path, argv: list[str],
                    pin: dict[str, object], run_id: str, env: dict[str, str],
                    run: Run, execute: Execute, sha256_file: Callable[[pathlib.Path], str],
                    receipt: dict) -> int:
    mode = pin.get("mode")
    if mode == "command":
        if not argv:
            raise ProjectError("command mode requires non-empty snapshot argv")
        print(f"SOURCE cwd={cwd.relative_to(checkout).as_posix()} argv={json.dumps(argv, ensure_ascii=True)}", flush=True)
        print("DEPENDENCIES image_equivalence=unverified dependency_equivalence=unverified", flush=True)
        code, _, _ = execute(argv, cwd=cwd, env=env)
        return code
    if mode != "compose":
        raise ProjectError("generic toolchain mode must be compose or command")

    docker = shutil.which("docker") or "docker"
    schema_path = checkout / ".infinite" / "check.json"
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProjectError("compose mode requires .infinite/check.json") from error
    if not isinstance(schema, dict) or set(schema) != {"version", "composeFile", "service", "platform"} or type(schema.get("version")) is not int or schema.get("version") != 1:
        raise ProjectError(".infinite/check.json must have exactly version, composeFile, service, and platform fields")
    if not isinstance(schema.get("service"), str) or not schema["service"]:
        raise ProjectError(".infinite/check.json requires a service and runner-supported Linux platform")
    machine = platform.machine()
    runner_platform = {"x86_64": "linux/amd64", "aarch64": "linux/arm64", "arm64": "linux/arm64"}.get(machine)
    if not runner_platform:
        raise ProjectError(f"unsupported Linux runner architecture: {machine}")
    if schema.get("platform") != runner_platform:
        raise ProjectError(f"Compose platform {schema.get('platform')} does not match runner platform {runner_platform}")
    compose_file = _safe_path(checkout, schema.get("composeFile"), "composeFile")
    config = _config(checkout, compose_file, run_id, env, run, schema["platform"])
    services = config["services"]
    service_name = schema["service"]
    if service_name not in services:
        raise ProjectError(f"Compose test service does not exist: {service_name}")
    compose = [docker, "compose", "-p", run_id, "-f", str(compose_file)]
    print(f"RECIPE compose_sha256={sha256_file(compose_file)} check_sha256={sha256_file(schema_path)} file={compose_file.relative_to(checkout).as_posix()} service={service_name} platform={schema['platform']}", flush=True)
    print("IMAGE service ref digest image_id", flush=True)
    pull_code, _, _ = execute([*compose, "pull"], cwd=checkout, env=env)
    if pull_code:
        return pull_code
    config = _config(checkout, compose_file, run_id, env, run, schema["platform"])
    images = {}
    for name, service in config["services"].items():
        reference = service["image"]
        digest = _digest_ref(reference, name)
        inspect = run([docker, "image", "inspect", reference, "--format", "{{.Id}} {{.Os}}/{{.Architecture}}"],
                      cwd=checkout, env=env, capture=True).decode("utf-8", "replace").strip()
        fields = inspect.split()
        if len(fields) != 2 or fields[1] != schema["platform"] or not re.fullmatch(r"sha256:[0-9a-f]{64}", fields[0]):
            raise ProjectError(f"pulled image for service {name} does not match {schema['platform']}")
        print(f"IMAGE {name} {reference} {digest} {fields[0]}", flush=True)
        images[name] = [reference, fields[0]]
    command = [*compose, "run", "--rm", "-T", service_name, *argv]
    print(f"RUN compose service={service_name} override={json.dumps(argv, ensure_ascii=True)}", flush=True)
    stdout_digest = hashlib.sha256()
    code, _, _ = execute(command, cwd=checkout, env=env, stdout_digest=stdout_digest)
    receipt.update(recipe=sha256_file(schema_path), compose=sha256_file(compose_file),
                   images=hashlib.sha256(json.dumps(images, sort_keys=True).encode()).hexdigest(),
                   stdout=stdout_digest.hexdigest())
    return code
