"""Labelled review media for taste calls: a font ffmpeg's drawtext can use on any OS, and text escaping for it.

Every tile, card and reel the user picks from carries its label (variant, engine, approach, time) burned in, so the
pick can be named back without guessing which file was which.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

# bold faces with Vietnamese and Latin-extended coverage, per OS; $ANIME_FONT wins
FONT_CANDIDATES = [
    "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/noto/NotoSans-Bold.ttf",
]


def font_file(explicit: str | None = None) -> str | None:
    for cand in (explicit, os.environ.get("ANIME_FONT"), *FONT_CANDIDATES):
        if cand and Path(cand).is_file():
            return cand
    if shutil.which("fc-match"):
        out = subprocess.run(["fc-match", "-f", "%{file}", "sans:bold"], capture_output=True, text=True).stdout.strip()
        if out and Path(out).is_file():
            return out
    return None  # drawtext then falls back to its fontconfig default


def esc_text(t: str) -> str:
    """Text for drawtext text='...' inside a filtergraph."""
    return t.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\u2019").replace("%", "\\%")


def font_opt(font: str | None) -> str:
    """'fontfile=...:' (or '' with no font); a Windows drive colon is escaped for the filtergraph."""
    return f"fontfile='{Path(font).as_posix().replace(':', chr(92) + ':')}':" if font else ""


def label(text: str, font: str | None, size: int = 30, x: str = "14", y: str = "14") -> str:
    return (f"drawtext={font_opt(font)}text='{esc_text(text)}':fontsize={size}:fontcolor=white:"
            f"box=1:boxcolor=black@0.72:boxborderw=12:x={x}:y={y}")
