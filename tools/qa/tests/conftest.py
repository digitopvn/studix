"""Shared fixtures: media generated with ffmpeg lavfi sources (no network, no provider) and a CLI runner that
calls the tools exactly as the worker does (`python -I -m studix_qa <tool>`, JSON on stdin)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HAS_FFMPEG = bool(shutil.which(os.environ.get("FFMPEG_PATH") or "ffmpeg")
                  and shutil.which(os.environ.get("FFPROBE_PATH") or "ffprobe"))
# CI sets this so a missing ffmpeg fails the run instead of silently skipping the media tests.
REQUIRE_TOOLCHAIN = os.environ.get("STUDIX_QA_REQUIRE_TOOLCHAIN") == "1"


@pytest.fixture
def ffmpeg_available() -> None:
    if not HAS_FFMPEG:
        if REQUIRE_TOOLCHAIN:
            pytest.fail("ffmpeg/ffprobe are required (STUDIX_QA_REQUIRE_TOOLCHAIN=1) but not on PATH")
        pytest.skip("needs ffmpeg and ffprobe")


def ffmpeg(*args: str) -> None:
    subprocess.run([os.environ.get("FFMPEG_PATH") or "ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y", *args],
                   check=True)


def tone(amplitude: float, seconds: float = 3.0, extra: str = "") -> str:
    """aevalsrc expression: a 997 Hz sine (mono: -3.01 LUFS at full scale, so 0.282 is about -14 LUFS)."""
    return f"aevalsrc='{amplitude}*sin(2*PI*997*t){extra}':s=48000:d={seconds}"


def av_file(path: Path, *, audio: str | None, video: str = "testsrc2=s=320x180:r=24:d=3",
            audio_offset_s: float = 0.0) -> Path:
    """A video (H.264) with an optional PCM audio stream in Matroska; PCM keeps loudness values exact."""
    args = ["-f", "lavfi", "-i", video]
    if audio:
        args += (["-itsoffset", str(audio_offset_s)] if audio_offset_s else []) + ["-f", "lavfi", "-i", audio]
    args += ["-map", "0:v"] + (["-map", "1:a", "-c:a", "pcm_s16le"] if audio else [])
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "24", str(path)]
    ffmpeg(*args)
    return path


def wav(path: Path, source: str, *extra: str) -> Path:
    ffmpeg("-f", "lavfi", "-i", source, *extra, str(path))
    return path


def run_tool(tool: str, tool_input: dict, media: dict[str, Path] | None = None, *, timeout_s: float = 60,
             out_dir: Path | None = None) -> dict:
    """Run one tool through the CLI and return the parsed response (ok or error)."""
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "SYSTEMROOT", "SystemRoot", "FFMPEG_PATH", "FFPROBE_PATH")}
    if out_dir is not None:
        env["STUDIX_QA_OUT"] = str(out_dir)
    request = {"input": tool_input, "media": {k: str(v.resolve()) for k, v in (media or {}).items()},
               "timeoutS": timeout_s}
    proc = subprocess.run([sys.executable, "-I", "-m", "studix_qa", tool], input=json.dumps(request).encode(),
                          capture_output=True, env=env, timeout=timeout_s + 30, check=False)
    response = json.loads(proc.stdout.decode("utf-8"))
    assert proc.returncode == (0 if response["ok"] else 1), proc.stderr.decode("utf-8", "replace")
    return response


def result(tool: str, tool_input: dict, media: dict[str, Path] | None = None, **kw) -> dict:
    response = run_tool(tool, tool_input, media, **kw)
    assert response["ok"], response
    return response["result"]
