#!/usr/bin/env python3
"""Labelled review grid: one frame per take, each tile carrying its label, so the user can name the pick.

usage: make-review-tiles.py out.jpg "path|time|label" ... [--cols 2] [--tile-width 960] [--crop face|W:H:X:Y]
                                    [--font FILE] [--overwrite]
time: seconds, "end" (last frame) or "-" (a still image). --crop face keeps the upper-left 72 % x 62 % of the frame,
where a medium shot's face sits, so faces of two engines or two encodes can be judged at the same scale; any
ffmpeg crop expression works too. Use it for engine comparisons (same keyframe and seed), takes, grades and encodes;
re-encode clips at a low CRF before judging faces, since a low-bitrate encode smears them on its own.
The font comes from --font, $ANIME_FONT or the OS's usual bold faces (studio/review_cards.py).
Supported: Windows, macOS, Linux. Needs ffmpeg.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio import review_cards as rc  # noqa: E402

CROPS = {"face": "iw*0.72:ih*0.62:iw*0.04:0"}


def parse_spec(spec: str) -> tuple[str, str, str]:
    parts = spec.split("|", 2)
    if len(parts) != 3:
        raise SystemExit(f"tile spec needs path|time|label: {spec!r}")
    return parts[0], parts[1], parts[2]


def seek_args(t: str) -> list[str]:
    return [] if t == "-" else (["-sseof", "-0.1"] if t == "end" else ["-ss", t])


def tile_filter(text: str, t: str, width: int, height: int, crop: str | None, font: str | None) -> str:
    """Crop (optional), fit into width x height on black, then burn the label (plus the time) top-left."""
    chain = [f"crop={CROPS.get(crop, crop)}"] if crop else []
    chain += [f"scale={width}:{height}:force_original_aspect_ratio=decrease",
              f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
              rc.label(text + ("" if t == "-" else f"  ·  t={t}"), font)]
    return ",".join(chain)


def grid_filter(n: int, cols: int) -> str:
    """xstack layout for n equal tiles, row-major; a short last row is filled black."""
    if n == 1:
        return "[0:v]null[out]"
    cells = []
    for i in range(n):
        r, c = divmod(i, cols)
        cells.append(f"{'+'.join(['w0'] * c) or '0'}_{'+'.join(['h0'] * r) or '0'}")
    ins = "".join(f"[{i}:v]" for i in range(n))
    return f"{ins}xstack=inputs={n}:layout={'|'.join(cells)}:fill=black[out]"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("out", type=Path)
    ap.add_argument("tiles", nargs="+", help='"path|time|label"')
    ap.add_argument("--cols", type=int, default=2)
    ap.add_argument("--tile-width", type=int, default=960)
    ap.add_argument("--tile-height", type=int, help="default: 9/16 of the width (face crop: 0.62/0.72 x 16/9 of it)")
    ap.add_argument("--crop", help="'face' or an ffmpeg crop expression W:H:X:Y")
    ap.add_argument("--font")
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args()
    if a.out.exists() and not a.overwrite:
        sys.exit(f"{a.out} exists; pick a new name (or --overwrite)")
    w = a.tile_width
    h = a.tile_height or (round(w * 0.62 / 0.72 * 9 / 16 / 2) * 2 if a.crop == "face" else round(w * 9 / 16 / 2) * 2)
    font = rc.font_file(a.font)
    specs = [parse_spec(s) for s in a.tiles]
    with tempfile.TemporaryDirectory() as d:
        pngs = []
        for i, (src, t, text) in enumerate(specs):
            p = Path(d) / f"t{i}.png"
            io.run(["ffmpeg", "-v", "error", "-y", *seek_args(t), "-i", src, "-frames:v", "1",
                    "-vf", tile_filter(text, t, w, h, a.crop, font), str(p)])
            pngs.append(p)
        ins = [x for p in pngs for x in ("-i", str(p))]
        a.out.parent.mkdir(parents=True, exist_ok=True)
        io.run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", grid_filter(len(pngs), a.cols),
                "-map", "[out]", "-frames:v", "1", "-q:v", "3", str(a.out)])
    print(a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
