"""Shared helpers for the recording-driven pipeline scripts. Standard library only.

Every step script imports this module from its own directory, so the scripts run
straight from the skill (`python -X utf8 <skill>/assets/templates/recording/<step>.py
<project>`) or from a project copy of the whole `recording/` directory.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def utf8_stdio():
    """Print Vietnamese text on any console; Windows defaults to cp1252."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


class StepError(Exception):
    """A failure the operator can act on; printed without a traceback."""


def main_guard(fn):
    """Run a step's main(), turning StepError into one stderr line and exit 1."""
    utf8_stdio()
    try:
        sys.exit(fn() or 0)
    except StepError as err:
        print(f"error: {err}", file=sys.stderr)
        sys.exit(1)


def project_dir(path):
    root = Path(path).resolve()
    if not root.is_dir():
        raise StepError(f"project directory not found: {root}")
    return root


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        if default is not None:
            return default
        raise StepError(f"missing {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise StepError(f"{path}: invalid JSON ({err})") from err


def write_json(path, data, indent=1):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8", newline="\n")


def need(tool):
    exe = shutil.which(tool)
    if not exe:
        raise StepError(f"{tool} not found on PATH; run scripts/doctor.py")
    return exe


def run(argv, capture=False):
    """Run a command without a shell; raise StepError with the tail of its output on failure."""
    proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise StepError(f"{Path(argv[0]).name} exited {proc.returncode}: {tail}")
    return proc.stdout if capture else None


def filter_script_option():
    """`-/filter_complex` (ffmpeg 7+) or the deprecated `-filter_complex_script` for older builds."""
    head = run([need("ffmpeg"), "-hide_banner", "-version"], capture=True).split("\n", 1)[0]
    m = re.search(r"version n?(\d+)\.", head)
    return "-filter_complex_script" if m and int(m.group(1)) < 7 else "-/filter_complex"


def ffmpeg(args):
    run([need("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", *args])


def ffmpeg_stderr(args):
    """Run ffmpeg for its analysis output (loudnorm, ebur128), which goes to stderr."""
    proc = subprocess.run([need("ffmpeg"), "-hide_banner", "-nostats", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise StepError(f"ffmpeg exited {proc.returncode}: {proc.stderr.strip()[-800:]}")
    return proc.stderr


def duration(path):
    out = run([need("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], capture=True)
    try:
        return float(out.strip())
    except ValueError as err:
        raise StepError(f"ffprobe could not read the duration of {path}") from err


def has_video(path):
    """True when the file has a real video stream; cover art in an audio file (attached_pic) does not count."""
    out = run([need("ffprobe"), "-v", "error", "-select_streams", "v", "-show_entries", "stream=index:stream_disposition=attached_pic",
               "-of", "csv=p=0", str(path)], capture=True)
    return any(line.strip() and not line.strip().endswith(",1") for line in out.splitlines())


_WORD = re.compile(r"[^\w'-]+", re.UNICODE)


def norm(word):
    """Lower-case and strip punctuation, as the composition's W(sid, word) lookup expects."""
    return _WORD.sub("", word.lower()).strip("'-")


def atempo_chain(speed):
    """ffmpeg atempo accepts 0.5..2 per instance; chain it for other factors."""
    if speed <= 0:
        raise StepError(f"speed must be positive, got {speed}")
    parts = []
    while speed > 2.0:
        parts.append(2.0)
        speed /= 2.0
    while speed < 0.5:
        parts.append(0.5)
        speed /= 0.5
    parts.append(speed)
    return ",".join(f"atempo={p:.6f}" for p in parts)


def r3(x):
    return round(float(x), 3)
