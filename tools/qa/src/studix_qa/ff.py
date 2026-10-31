"""ffmpeg and ffprobe, always by argv (never a shell), always under the run's deadline, and only ever reading
local files: every input is opened with `-protocol_whitelist file`, so a crafted path or playlist cannot make
ffmpeg reach the network."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

import numpy as np

from .sandbox import Deadline, ToolError, lift_memory_limit

INPUT_GUARD = ("-protocol_whitelist", "file")


def ffmpeg_bin() -> str:
    return os.environ.get("FFMPEG_PATH") or "ffmpeg"


def ffprobe_bin() -> str:
    return os.environ.get("FFPROBE_PATH") or "ffprobe"


def _preexec():
    return lift_memory_limit if os.name == "posix" else None


def run(argv: list[str], deadline: Deadline, *, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    """Run a media binary; raise UNAVAILABLE when it is missing, TIMEOUT past the deadline and INTERNAL (with the
    stderr tail) on a non-zero exit."""
    try:
        result = subprocess.run(argv, input=stdin, capture_output=True, timeout=deadline.remaining(),
                                preexec_fn=_preexec(), check=False)
    except FileNotFoundError as err:
        raise ToolError("UNAVAILABLE", f"{argv[0]} is not installed or not on PATH") from err
    except subprocess.TimeoutExpired as err:
        raise ToolError("TIMEOUT", f"{Path(argv[0]).name} exceeded the {deadline.seconds:g}s deadline") from err
    if result.returncode != 0:
        tail = result.stderr.decode("utf-8", "replace")[-1500:]
        raise ToolError("INTERNAL", f"{Path(argv[0]).name} failed (exit {result.returncode})", {"stderr": tail})
    return result


def ffmpeg(args: list[str], deadline: Deadline) -> subprocess.CompletedProcess:
    return run([ffmpeg_bin(), "-nostdin", "-hide_banner", "-nostats", *args], deadline)


def input_args(path: Path, *, seek: float = 0.0, length: float | None = None) -> list[str]:
    """`-i` for one local file, with the protocol guard and an optional input-side seek and length."""
    out: list[str] = []
    if seek:
        out += ["-ss", f"{seek:.6f}"]
    if length:
        out += ["-t", f"{length:.6f}"]
    return [*out, *INPUT_GUARD, "-i", str(path)]


def ffprobe_json(path: Path, deadline: Deadline) -> dict:
    result = run([ffprobe_bin(), "-v", "error", *INPUT_GUARD, "-show_format", "-show_streams", "-of", "json",
                  str(path)], deadline)
    try:
        return json.loads(result.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError as err:
        raise ToolError("INTERNAL", "ffprobe printed no JSON") from err


def decode_audio(path: Path, deadline: Deadline, *, sr: int = 48000, channels: int = 1, seek: float = 0.0,
                 length: float | None = None) -> np.ndarray:
    """First audio stream as float32 samples, shape (n,) for mono and (n, channels) otherwise."""
    raw = ffmpeg(["-v", "error", *input_args(path, seek=seek, length=length), "-map", "0:a:0", "-ac", str(channels),
                  "-ar", str(sr), "-f", "f32le", "-"], deadline).stdout
    x = np.frombuffer(raw, np.float32)
    return x if channels == 1 else x[: len(x) // channels * channels].reshape(-1, channels)


def gray_frames(path: Path, deadline: Deadline, w: int, h: int) -> Iterator[np.ndarray]:
    """Stream every frame of the first video stream as a (h, w) float32 luma array (full range, 0..255)."""
    argv = [ffmpeg_bin(), "-nostdin", "-hide_banner", "-nostats", "-v", "error", *input_args(path), "-map", "0:v:0",
            "-vf", f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"]
    # stderr goes to a file: a pipe nobody drains would block ffmpeg once a damaged stream fills it.
    errors = tempfile.TemporaryFile()
    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=errors, preexec_fn=_preexec())
    except FileNotFoundError as err:
        errors.close()
        raise ToolError("UNAVAILABLE", f"{argv[0]} is not installed or not on PATH") from err
    size = w * h
    try:
        assert proc.stdout is not None
        while True:
            deadline.remaining()
            chunk = proc.stdout.read(size)
            if len(chunk) < size:
                break
            yield np.frombuffer(chunk, np.uint8).reshape(h, w).astype(np.float32)
        try:
            code = proc.wait(timeout=max(0.1, deadline.remaining()))
        except subprocess.TimeoutExpired as err:
            raise ToolError("TIMEOUT", f"ffmpeg exceeded the {deadline.seconds:g}s deadline") from err
        if code != 0:
            errors.seek(0)
            tail = errors.read().decode("utf-8", "replace")[-1500:]
            raise ToolError("INTERNAL", f"ffmpeg failed (exit {code})", {"stderr": tail})
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if proc.stdout:
            proc.stdout.close()
        errors.close()


def rational(value: object) -> float | None:
    """'24000/1001' -> 23.976...; None for '0/0', missing or malformed values."""
    if not isinstance(value, str) or "/" not in value:
        try:
            v = float(value)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
        return v if v > 0 else None
    num, _, den = value.partition("/")
    try:
        n, d = float(num), float(den)
    except ValueError:
        return None
    return n / d if n > 0 and d > 0 else None
