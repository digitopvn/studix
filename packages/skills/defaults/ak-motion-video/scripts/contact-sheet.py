#!/usr/bin/env python3
"""Tile frames of each scene of a render into one small JPEG per scene.

Each sheet spreads --frames frames evenly across the scene window from the
timeline, in --cols columns; the tile width is floor(max_width / cols) rounded
down to an even number, so a sheet never exceeds --max-width. Use the timeline
the render was built from (a part or short build has its own). Standard library
only; needs ffmpeg and ffprobe.

Usage:
  python -X utf8 contact-sheet.py <render> --timeline <timeline.json> [--scenes a..b] [--frames 18]
      [--cols 6] [--max-width 1400] [--out dir]
Writes <out>/sheet-<sid>.jpg (default <out>: sheets/ next to the render).
"""
import argparse
import math
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tl import TlError, load_scenes, scene_range, utf8_stdio  # noqa: E402


def need(tool):
    exe = shutil.which(tool)
    if not exe:
        raise TlError(f"{tool} not found on PATH; run scripts/doctor.py")
    return exe


def run(argv):
    proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise TlError(f"{Path(argv[0]).name} exited {proc.returncode}: {proc.stderr.strip()[-400:]}")
    return proc.stdout


def media_info(path, entries, stream="v:0"):
    out = run([need("ffprobe"), "-v", "error", "-select_streams", stream, "-show_entries", entries,
               "-of", "default=nw=1:nk=1", str(path)])
    return out.split()


def tile_width(max_width, cols):
    width = (max_width // cols) // 2 * 2
    if width < 2:
        raise TlError(f"--max-width {max_width} is too small for {cols} columns")
    return width


def sheet(render, start, length, frames, cols, width, dest):
    rows = math.ceil(frames / cols)
    vf = f"fps={frames}/{length:.6f},scale={width}:-2,tile={cols}x{rows}"
    run([need("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{start:.3f}", "-t", f"{length:.3f}",
         "-i", str(render), "-vf", vf, "-frames:v", "1", "-q:v", "4", str(dest)])
    if not dest.is_file():
        raise TlError(f"ffmpeg wrote no sheet for {dest.name}")
    w, h = media_info(dest, "stream=width,height")[:2]
    return int(w), int(h)


def main(argv=None):
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("render", help="rendered video")
    ap.add_argument("--timeline", required=True, help="timeline.json the render was built from")
    ap.add_argument("--scenes", default="all", help="a..b range, one id, or all (ids accept a unique prefix)")
    ap.add_argument("--frames", type=int, default=18, help="frames per sheet (default 18)")
    ap.add_argument("--cols", type=int, default=6, help="columns per sheet (default 6)")
    ap.add_argument("--max-width", type=int, default=1400, help="sheet width cap in px (default 1400)")
    ap.add_argument("--out", help="output directory (default: sheets/ next to the render)")
    a = ap.parse_args(argv)
    try:
        if a.frames < 1 or a.cols < 1:
            raise TlError("--frames and --cols must be positive")
        render = Path(a.render)
        if not render.is_file():
            raise TlError(f"{render}: not rendered")
        scenes = load_scenes(a.timeline)
        ids = scene_range(a.scenes, scenes)
        width = tile_width(a.max_width, a.cols)
        cols = min(a.cols, a.frames)
        try:
            total = float(media_info(render, "format=duration", stream="v:0")[0])
        except (IndexError, ValueError) as e:
            raise TlError(f"{render}: ffprobe could not read the duration") from e
        out = Path(a.out) if a.out else render.parent / "sheets"
        out.mkdir(parents=True, exist_ok=True)
    except (TlError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    failed = 0
    for sid in ids:
        start, end = scenes[sid]["start"], min(scenes[sid]["end"], total)
        if end - start <= 0.05:
            print(f"{sid}: skipped, window {start:.2f}-{scenes[sid]['end']:.2f} is outside the {total:.2f}s render")
            failed += 1
            continue
        dest = out / f"sheet-{sid}.jpg"
        try:
            w, h = sheet(render, start, end - start, a.frames, cols, width, dest)
        except (TlError, OSError) as e:
            print(f"{sid}: error: {e}")
            failed += 1
            continue
        print(f"{dest} {w}x{h}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
