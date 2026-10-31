"""Guards every QA tool runs under: no network, a memory cap, a deadline, media reachable only through the
grants the caller passed, and writes confined to one output directory.

These are in-process guards. The worker adds the outer ones (scrubbed environment, private temp directory,
process-tree kill on timeout); the container is what actually isolates the network and the filesystem.
"""
from __future__ import annotations

import os
import re
import socket
import time
from pathlib import Path

ERROR_CODES = ("VALIDATION", "NOT_FOUND", "UNAVAILABLE", "TIMEOUT", "INTERNAL")
MEDIA_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
OUTPUT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class ToolError(Exception):
    """A failure reported to the caller as `{"ok": false, "error": {code, message, details}}`."""

    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code if code in ERROR_CODES else "INTERNAL"
        self.message = message
        self.details = details or {}

    def payload(self) -> dict:
        out = {"code": self.code, "message": self.message}
        if self.details:
            out["details"] = self.details
        return out


def _network_disabled(*_args, **_kwargs):
    raise PermissionError("network access is disabled for QA tools")


class _NoSocket(socket.socket):
    def __init__(self, *args, **kwargs) -> None:  # noqa: D107 - refuses every socket
        _network_disabled()


def disable_network() -> None:
    """Make socket creation and name resolution fail inside this process. Tools never need the network; a
    dependency that tries to reach it (a model hub, telemetry) fails loudly instead of leaking."""
    socket.socket = _NoSocket  # type: ignore[misc]
    socket.create_connection = _network_disabled  # type: ignore[assignment]
    socket.getaddrinfo = _network_disabled  # type: ignore[assignment]
    socket.socketpair = _network_disabled  # type: ignore[assignment]


def limit_memory(megabytes: int | None) -> None:
    """Cap this process's address space (POSIX only; Windows relies on the container limit). The cap is soft so
    ffmpeg children, which reserve address space per thread, can lift it: their memory is bounded by the
    container, while the arrays a tool builds from decoded media are bounded here."""
    if not megabytes:
        return
    try:
        import resource  # noqa: PLC0415 - POSIX only
    except ImportError:
        return
    soft = megabytes * 1024 * 1024
    _, hard = resource.getrlimit(resource.RLIMIT_AS)
    if hard != resource.RLIM_INFINITY:
        soft = min(soft, hard)
    resource.setrlimit(resource.RLIMIT_AS, (soft, hard))


def lift_memory_limit() -> None:
    """preexec_fn for media binaries: restore the hard address-space limit (see limit_memory)."""
    try:
        import resource  # noqa: PLC0415
    except ImportError:
        return
    _, hard = resource.getrlimit(resource.RLIMIT_AS)
    resource.setrlimit(resource.RLIMIT_AS, (hard, hard))


class Deadline:
    """Wall-clock budget shared by every subprocess a tool starts."""

    def __init__(self, seconds: float) -> None:
        if not (seconds > 0):
            raise ToolError("VALIDATION", "timeoutS must be > 0")
        self.seconds = float(seconds)
        self._end = time.monotonic() + self.seconds

    def remaining(self) -> float:
        left = self._end - time.monotonic()
        if left <= 0:
            raise ToolError("TIMEOUT", f"tool exceeded its {self.seconds:g}s deadline")
        return left


class Media:
    """The media files a run may read, by grant id. Tools take ids, never paths, so a tool input cannot point
    anywhere the caller did not grant."""

    def __init__(self, grants: object) -> None:
        if not isinstance(grants, dict):
            raise ToolError("VALIDATION", "media must be an object of id -> absolute path")
        self._paths: dict[str, Path] = {}
        for media_id, raw in grants.items():
            if not isinstance(media_id, str) or not MEDIA_ID.match(media_id):
                raise ToolError("VALIDATION", f"media id {media_id!r} must match {MEDIA_ID.pattern}")
            if not isinstance(raw, str) or not os.path.isabs(raw):
                raise ToolError("VALIDATION", f"media {media_id!r} must be an absolute path")
            path = Path(raw)
            try:
                real = path.resolve(strict=True)
            except (FileNotFoundError, OSError) as err:
                raise ToolError("NOT_FOUND", f"media {media_id!r} does not exist", {"media": media_id}) from err
            if not real.is_file():
                raise ToolError("VALIDATION", f"media {media_id!r} is not a regular file", {"media": media_id})
            self._paths[media_id] = real

    def path(self, media_id: object) -> Path:
        if not isinstance(media_id, str) or media_id not in self._paths:
            raise ToolError("VALIDATION", f"media {media_id!r} was not granted to this run")
        return self._paths[media_id]

    def ids(self) -> list[str]:
        return list(self._paths)


class Outputs:
    """The one directory a tool may write to (the worker's per-run sandbox `out/`)."""

    def __init__(self, root: str | None) -> None:
        self.root = Path(root).resolve() if root else None

    def path(self, name: str) -> Path:
        if self.root is None:
            raise ToolError("VALIDATION", "this run has no output directory")
        if not OUTPUT_NAME.match(name) or name in {".", ".."}:
            raise ToolError("VALIDATION", f"output name {name!r} is not a plain file name")
        self.root.mkdir(parents=True, exist_ok=True)
        return self.root / name
