"""The boundary every tool shares: JSON in and out, media only through grants, no shell, no network, a deadline,
and writes confined to the output directory."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import run_tool, tone, wav
from studix_qa import TOOLS
from studix_qa.sandbox import Media, Outputs, ToolError

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "studix_qa"


def raw_cli(args: list[str], stdin: bytes) -> tuple[int, dict]:
    proc = subprocess.run([sys.executable, "-I", "-m", "studix_qa", *args], input=stdin, capture_output=True,
                          timeout=60, check=False)
    return proc.returncode, json.loads(proc.stdout.decode("utf-8"))


def test_list_names_every_tool():
    proc = subprocess.run([sys.executable, "-I", "-m", "studix_qa", "--list"], capture_output=True, check=True)
    assert json.loads(proc.stdout) == sorted(TOOLS)


def test_unknown_tool_and_malformed_request_answer_in_json():
    code, response = raw_cli(["nope"], b"{}")
    assert code == 1
    assert response["error"]["code"] == "VALIDATION"
    code, response = raw_cli(["probe"], b"not json")
    assert code == 1
    assert response["error"]["code"] == "VALIDATION"


def test_media_must_be_absolute_existing_regular_files(tmp_path):
    with pytest.raises(ToolError) as err:
        Media({"a": "relative.wav"})
    assert err.value.code == "VALIDATION"
    with pytest.raises(ToolError) as err:
        Media({"a": str(tmp_path / "missing.wav")})
    assert err.value.code == "NOT_FOUND"
    with pytest.raises(ToolError) as err:
        Media({"a": str(tmp_path)})
    assert err.value.code == "VALIDATION"
    with pytest.raises(ToolError):
        Media({"../a": str(tmp_path)})
    granted = Media({"a": str(Path(__file__).resolve())})
    with pytest.raises(ToolError):
        granted.path("b")


def test_outputs_refuse_paths_outside_the_output_directory(tmp_path):
    out = Outputs(str(tmp_path))
    assert out.path("a.depth.png").parent == tmp_path.resolve()
    for name in ("../x.png", "a/b.png", "..", ""):
        with pytest.raises(ToolError):
            out.path(name)
    with pytest.raises(ToolError):
        Outputs(None).path("a.png")


def test_network_is_disabled_inside_a_tool_process():
    code = ("from studix_qa.sandbox import disable_network; disable_network(); import socket\n"
            "for attempt in (lambda: socket.create_connection(('127.0.0.1', 9)), lambda: socket.socket(),\n"
            "                lambda: socket.getaddrinfo('example.com', 80)):\n"
            "    try:\n        attempt()\n    except PermissionError:\n        continue\n"
            "    raise SystemExit('network was reachable')\n")
    subprocess.run([sys.executable, "-I", "-c", code], check=True, timeout=30)


def test_no_tool_source_uses_a_shell():
    for source in PACKAGE.glob("*.py"):
        text = source.read_text(encoding="utf-8")
        assert "shell=True" not in text, source.name
        assert "os.system" not in text and "os.popen" not in text, source.name


def test_deadline_is_enforced(tmp_path, ffmpeg_available):
    response = run_tool("loudness", {"media": "a"}, {"a": wav(tmp_path / "a.wav", tone(0.282, 30.0))}, timeout_s=0.001)
    assert response["ok"] is False
    assert response["error"]["code"] == "TIMEOUT"


def test_a_missing_ffmpeg_is_unavailable(tmp_path, ffmpeg_available):
    clip = wav(tmp_path / "a.wav", tone(0.282))
    request = json.dumps({"input": {"media": "a"}, "media": {"a": str(clip)}}).encode()
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "SYSTEMROOT", "SystemRoot")}
    env["FFPROBE_PATH"] = str(tmp_path / "no-such-ffprobe")
    proc = subprocess.run([sys.executable, "-I", "-m", "studix_qa", "probe"], input=request, capture_output=True,
                          env=env, timeout=60, check=False)
    assert json.loads(proc.stdout)["error"]["code"] == "UNAVAILABLE"
