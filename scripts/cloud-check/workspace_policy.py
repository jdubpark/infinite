"""Private operator policy for routing repositories to isolated test runners.

The registry is intentionally read-only. A trusted enrollment flow owns its
contents; repository-local Git configuration is never used as workspace
identity.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping


_WORKSPACE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z", re.ASCII)
_ALIAS = _WORKSPACE_ID
_HASH = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)


class WorkspacePolicyError(RuntimeError):
    """The private workspace registry or caller identity is unsafe or invalid."""


@dataclass(frozen=True)
class _Scope:
    roots: tuple[Path, ...]
    origins: frozenset[str]
    runners: tuple[str, ...]


class WorkspacePolicy:
    """Validated view of operator-owned workspace routing policy."""

    def __init__(self, scopes: Mapping[str, _Scope] | None = None) -> None:
        self._scopes = dict(scopes or {})

    @classmethod
    def load(cls) -> "WorkspacePolicy":
        """Load ``workspaces.d/*.json`` from the user's private config directory.

        A missing registry is a valid empty registry. Existing paths and files
        must be owned by the current user or root, must not be symlinks, and
        must not be writable by group or other users.
        """
        xdg = os.environ.get("XDG_CONFIG_HOME")
        base = Path(xdg) if xdg else Path.home() / ".config"
        directory = base / "infinite" / "cloud-check" / "workspaces.d"
        if not directory.exists() and not directory.is_symlink():
            return cls()
        _check_protected_path(directory, directory=True)

        scopes: dict[str, _Scope] = {}
        roots_seen: list[tuple[Path, str]] = []
        hashes_seen: dict[str, str] = {}
        aliases_seen: dict[str, str] = {}
        for path in sorted(directory.iterdir(), key=lambda item: item.name):
            if path.suffix != ".json":
                continue
            workspace_id = path.name[:-5]
            if not _WORKSPACE_ID.fullmatch(workspace_id):
                raise WorkspacePolicyError("workspace policy filename must be an ASCII workspace ID")
            _check_protected_path(path, directory=False)
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                raise WorkspacePolicyError(f"invalid workspace policy file: {path.name}") from error
            if not isinstance(raw, dict) or set(raw) != {"roots", "originHashes", "runners"}:
                raise WorkspacePolicyError(f"workspace policy {path.name} must contain exactly roots, originHashes, and runners")
            if not all(isinstance(raw[key], list) and raw[key] for key in ("roots", "runners")):
                raise WorkspacePolicyError(f"workspace policy {path.name} requires non-empty roots and runners")
            if not isinstance(raw["originHashes"], list):
                raise WorkspacePolicyError(f"workspace policy {path.name} originHashes must be a list")

            roots: list[Path] = []
            for value in raw["roots"]:
                if not isinstance(value, str) or not value or not Path(value).is_absolute():
                    raise WorkspacePolicyError(f"workspace policy {path.name} roots must be absolute canonical directories")
                root = Path(value)
                try:
                    canonical = root.resolve(strict=True)
                except OSError as error:
                    raise WorkspacePolicyError(f"workspace policy {path.name} contains a missing root") from error
                if str(canonical) != value or not canonical.is_dir():
                    raise WorkspacePolicyError(f"workspace policy {path.name} roots must be absolute canonical directories")
                _check_protected_path(canonical, directory=True)
                roots.append(canonical)

            origins = raw["originHashes"]
            if any(not isinstance(value, str) or not _HASH.fullmatch(value) for value in origins):
                raise WorkspacePolicyError(f"workspace policy {path.name} contains an invalid origin hash")
            if len(set(origins)) != len(origins):
                raise WorkspacePolicyError(f"workspace policy {path.name} contains duplicate origin hashes")
            runners = raw["runners"]
            if any(not isinstance(value, str) or not _ALIAS.fullmatch(value) for value in runners):
                raise WorkspacePolicyError(f"workspace policy {path.name} contains an invalid runner alias")
            if len(set(runners)) != len(runners):
                raise WorkspacePolicyError(f"workspace policy {path.name} contains duplicate runner aliases")

            for root in roots:
                for other, other_id in roots_seen:
                    if workspace_id != other_id and _overlaps(root, other):
                        raise WorkspacePolicyError(f"workspace roots overlap between {workspace_id} and {other_id}")
                roots_seen.append((root, workspace_id))
            for origin in origins:
                if origin in hashes_seen:
                    raise WorkspacePolicyError(f"origin hash is assigned to multiple workspaces: {workspace_id} and {hashes_seen[origin]}")
                hashes_seen[origin] = workspace_id
            for alias in runners:
                if alias in aliases_seen:
                    raise WorkspacePolicyError(f"runner alias is assigned to multiple workspaces: {alias}")
                aliases_seen[alias] = workspace_id
            scopes[workspace_id] = _Scope(tuple(roots), frozenset(origins), tuple(runners))
        return cls(scopes)

    def scope_for(self, root: str | Path, origin_hash: str | None,
                  saved_aliases: Iterable[str] | Mapping[str, str], *,
                  directory_aliases: Iterable[str] = (), enrolling: bool = False) -> str | None:
        """Resolve a checkout to one scope or fail closed on disagreement.

        ``saved_aliases`` are aliases already approved by the trusted global
        origin-to-runner enrollment store. Their values, when a mapping is
        supplied, are origin hashes; local Git config is not consulted.
        """
        physical = self._physical_scopes(Path(root))
        if len(physical) > 1:
            raise WorkspacePolicyError("checkout Git root and common directory identify different workspaces")
        physical_scope = next(iter(physical), None)

        origin_scope = None
        if origin_hash is not None:
            if not isinstance(origin_hash, str) or not _HASH.fullmatch(origin_hash):
                raise WorkspacePolicyError("origin hash is invalid")
            origin_scope = self._scope_for_origin(origin_hash)

        aliases = _saved_alias_names(saved_aliases)
        if isinstance(saved_aliases, Mapping):
            if any(not isinstance(bound_hash, str) or not _HASH.fullmatch(bound_hash)
                   for bound_hash in saved_aliases.values()):
                raise WorkspacePolicyError("global runner enrollment contains an invalid identity hash")
            if origin_hash is None:
                _git_root, common = _git_locations(Path(root))
                common_hash = hashlib.sha256(os.fsencode(str(common))).hexdigest()
                aliases = {alias for alias, bound_hash in saved_aliases.items() if bound_hash == common_hash}
            else:
                aliases = {alias for alias, bound_hash in saved_aliases.items() if bound_hash == origin_hash}
        bound_to_directory = _saved_alias_names(directory_aliases)
        directory_scopes = {scope for scope, entry in self._scopes.items() if bound_to_directory.intersection(entry.runners)}
        alias_scopes = {scope for scope, entry in self._scopes.items() if aliases.intersection(entry.runners)}
        if len(alias_scopes) > 1:
            raise WorkspacePolicyError("approved runner aliases identify different workspaces")
        alias_scope = next(iter(alias_scopes), None)

        identities = {value for value in (origin_scope, alias_scope) if value is not None}
        identities.update(directory_scopes)
        if physical_scope is not None:
            identities.add(physical_scope)
        if len(identities) > 1:
            raise WorkspacePolicyError("checkout path, origin, and approved runner aliases identify different workspaces")
        if identities:
            chosen = next(iter(identities))
            if physical_scope is None and chosen not in directory_scopes and not enrolling:
                raise WorkspacePolicyError("clone outside its managed roots requires explicit directory enrollment with --enroll")
            if origin_hash is not None and origin_scope is None and alias_scope != chosen and not enrolling:
                raise WorkspacePolicyError("this repository origin is not enrolled for the managed workspace; rerun with --enroll")
            if origin_hash is None and origin_scope is None:
                if enrolling and physical_scope == chosen:
                    return chosen
                if alias_scope != chosen or physical_scope != chosen:
                    raise WorkspacePolicyError("originless repository requires explicit same-root enrollment with --enroll")
            return chosen

        return None

    def allowed_aliases(self, scope: str | None, aliases: Iterable[str] | None = None,
                        requested: str | None = None, *,
                        enrolling: bool = False) -> list[str]:
        """Select available aliases in policy order and reject cross-scope use."""
        if requested is not None and (not isinstance(requested, str) or not _ALIAS.fullmatch(requested)):
            raise WorkspacePolicyError("requested runner alias is invalid")
        if aliases is None:
            if scope is None:
                available: list[str] = []
            elif scope not in self._scopes:
                raise WorkspacePolicyError("unknown workspace scope")
            else:
                available = list(self._scopes[scope].runners)
        else:
            available = list(aliases)
            if any(not isinstance(alias, str) or not _ALIAS.fullmatch(alias) for alias in available):
                raise WorkspacePolicyError("available runner aliases contain an invalid alias")
            available = list(dict.fromkeys(available))
        if any(not isinstance(alias, str) or not _ALIAS.fullmatch(alias) for alias in available):
            raise WorkspacePolicyError("available runner aliases contain an invalid alias")
        reserved = {alias: owner for owner, entry in self._scopes.items() for alias in entry.runners}
        if scope is None:
            if requested is not None and requested in reserved:
                raise WorkspacePolicyError("requested runner alias belongs to a managed workspace; bind the repository with --enroll")
            unreserved = [alias for alias in available if alias not in reserved]
            if requested is not None:
                if requested not in unreserved:
                    raise WorkspacePolicyError("requested runner alias is not available")
                return [requested]
            return unreserved
        if scope not in self._scopes:
            raise WorkspacePolicyError("unknown workspace scope")
        approved = self._scopes[scope].runners
        if requested is not None:
            owner = reserved.get(requested)
            if owner is not None and owner != scope:
                raise WorkspacePolicyError("requested runner alias belongs to another workspace")
            if requested not in approved:
                if enrolling:
                    raise WorkspacePolicyError("enrollment runner alias is not approved for this workspace")
                raise WorkspacePolicyError("requested runner alias is not approved for this workspace")
            if requested not in available:
                raise WorkspacePolicyError("requested runner alias is not available")
            return [requested]
        return [alias for alias in approved if alias in available]

    def _scope_for_origin(self, origin_hash: str) -> str | None:
        return next((scope for scope, entry in self._scopes.items() if origin_hash in entry.origins), None)

    def _physical_scopes(self, root: Path) -> set[str]:
        git_root, common = _git_locations(root)
        result: set[str] = set()
        for scope, entry in self._scopes.items():
            if any(_within(git_root, configured) or _within(common, configured)
                   for configured in entry.roots):
                result.add(scope)
        return result

def _saved_alias_names(saved: Iterable[str] | Mapping[str, str]) -> set[str]:
    names = set(saved.keys() if isinstance(saved, Mapping) else saved)
    if any(not isinstance(alias, str) or not _ALIAS.fullmatch(alias) for alias in names):
        raise WorkspacePolicyError("approved runner aliases contain an invalid alias")
    return names


def _check_protected_path(path: Path, *, directory: bool) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise WorkspacePolicyError("workspace policy path cannot be inspected safely") from error
    if stat.S_ISLNK(info.st_mode) or (directory and not stat.S_ISDIR(info.st_mode)) or (not directory and not stat.S_ISREG(info.st_mode)):
        raise WorkspacePolicyError("workspace policy paths must not be symlinks and must have the expected file type")
    if info.st_uid not in (os.getuid(), 0) or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise WorkspacePolicyError("workspace policy paths must be owned by the user or root and not group/world writable")


def _overlaps(left: Path, right: Path) -> bool:
    return _within(left, right) or _within(right, left)


def _within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _git_locations(root: Path) -> tuple[Path, Path]:
    try:
        top = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                             check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()
        common = subprocess.run(["git", "-C", str(root), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout.strip()
        return Path(top).resolve(strict=True), Path(common).resolve(strict=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise WorkspacePolicyError("cannot determine checkout Git root and common directory") from error
