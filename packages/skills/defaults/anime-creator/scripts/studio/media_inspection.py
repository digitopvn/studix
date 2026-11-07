"""Look at media by measurement instead of by eye or by a model's guess.

contact_sheet  one jpg grid of frames every `step` seconds, with a legend of tile -> time (no font needed).
strip          n frames of [t0, t1] in one row, for checking an action beat (grip, contact point, cut-off limbs).
loudness       integrated LUFS, true peak and LRA via ebur128.
voice_onsets   RMS envelope onsets of a dialogue track. silencedetect fails under a constant bed, and a video
               model's "the lips lag" claim needs this number before anyone retimes anything.
lip_sync_lag   mouth-crop motion onsets vs voice onsets: the measured lag, not a guess.
edge_touch     fraction of alpha on the outer border of a cut-out PNG: a cut arm or blade shows up here
               before it shows up in the film.
"""
from __future__ import annotations

import array
import math
import re
import subprocess
from pathlib import Path

from .common_io_and_paths import ffprobe_duration, run


def contact_sheet(video: Path, out_jpg: Path, *, step: float = 0.25, cols: int = 6, tile_w: int = 480,
                  t0: float = 0.0, t1: float | None = None) -> list[float]:
    dur = ffprobe_duration(video)
    t1 = min(t1 or dur, dur)
    n = max(1, int((t1 - t0) / step))
    rows = math.ceil(n / cols)
    vf = f"fps=1/{step},scale={tile_w}:-2,tile={cols}x{rows}:padding=4:margin=4"
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}", "-i", str(video), "-vf", vf,
         "-frames:v", "1", "-q:v", "4", str(out_jpg)])
    times = [round(t0 + i * step, 3) for i in range(n)]
    print(f"{out_jpg.name}: {n} tiles, {cols} per row, tile i = t {t0:.2f} + i * {step}s")
    return times


def strip(video: Path, out_jpg: Path, t0: float, t1: float, *, n: int = 8, tile_w: int = 360) -> list[float]:
    step = (t1 - t0) / n
    vf = f"fps=1/{step:.5f},scale={tile_w}:-2,tile={n}x1:padding=2"
    run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}", "-i", str(video), "-vf", vf,
         "-frames:v", "1", "-q:v", "4", str(out_jpg)])
    return [round(t0 + i * step, 3) for i in range(n)]


def loudness(path: Path) -> dict:
    err = subprocess.run(["ffmpeg", "-v", "info", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True).stderr.split("Summary:")[-1]
    num = lambda rx: float(m.group(1)) if (m := re.search(rx, err)) else None  # noqa: E731
    return {"I_lufs": num(r"I:\s+(-?[\d.]+) LUFS"), "LRA_lu": num(r"LRA:\s+(-?[\d.]+) LU"), "peak_dbfs": num(r"Peak:\s+(-?[\d.]+) dBFS")}


def rms_envelope(path: Path, *, sr: int = 8000, win: float = 0.01, t0: float = 0.0, dur: float | None = None) -> list[float]:
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}"] + (["-t", f"{dur:.3f}"] if dur else []) + \
          ["-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"]
    pcm = array.array("h", run(cmd).stdout)
    k = max(1, int(sr * win))
    env = []
    for i in range(0, len(pcm) - k + 1, k):
        blk = pcm[i:i + k]
        env.append(20 * math.log10(math.sqrt(sum(x * x for x in blk) / k) / 32768 + 1e-9))
    return env


def voice_onsets(path: Path, *, threshold_db: float = -32.0, rel_db: float = 18.0, min_gap: float = 0.15,
                 win: float = 0.01, t0: float = 0.0, dur: float | None = None) -> list[float]:
    """Onsets where the envelope rises above max(threshold, floor + rel_db) after min_gap of quiet."""
    env = rms_envelope(path, win=win, t0=t0, dur=dur)
    if not env:
        return []
    floor = sorted(env)[len(env) // 10]  # 10th percentile = the bed under the voice
    thr = max(threshold_db, floor + rel_db)
    onsets, quiet = [], min_gap
    for i, v in enumerate(env):
        if v >= thr and quiet >= min_gap:
            onsets.append(round(t0 + i * win, 3))
        quiet = 0.0 if v >= thr else quiet + win
    return onsets


def edge_touch(png: Path, *, border: int = 2, alpha_min: int = 24) -> dict:
    """Needs Pillow (uv run --with pillow). Returns the share of opaque pixels on each border."""
    from PIL import Image  # noqa: PLC0415 - optional dependency, only for cut-outs
    im = Image.open(png).convert("RGBA")
    a = im.getchannel("A")
    w, h = im.size
    def share(box):
        px = list(a.crop(box).getdata())
        return round(sum(1 for p in px if p >= alpha_min) / max(1, len(px)), 4)
    rep = {"left": share((0, 0, border, h)), "right": share((w - border, 0, w, h)),
           "top": share((0, 0, w, border)), "bottom": share((0, h - border, w, h))}
    rep["touches"] = [k for k, v in rep.items() if isinstance(v, float) and v > 0.002]
    return rep


def mouth_motion(video: Path, crop: str, *, t0: float = 0.0, dur: float | None = None, fps: int = 24, size: int = 48) -> list[float]:
    """Mean absolute frame difference inside a tight mouth crop ("w:h:x:y" in source px), one value per frame."""
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}"] + (["-t", f"{dur:.3f}"] if dur else []) + \
          ["-i", str(video), "-vf", f"crop={crop},scale={size}:{size},format=gray,fps={fps}", "-f", "rawvideo", "-"]
    raw = run(cmd).stdout
    n = size * size
    frames = [raw[i:i + n] for i in range(0, len(raw) - n + 1, n)]
    return [0.0] + [sum(abs(a - b) for a, b in zip(f1, f0)) / n for f0, f1 in zip(frames, frames[1:])]


def lip_sync_lag(video: Path, audio: Path, crop: str, *, t0: float = 0.0, dur: float | None = None, fps: int = 24) -> dict:
    """Lag of mouth movement behind voice onsets (positive = lips late). Measure before retiming a take."""
    motion = mouth_motion(video, crop, t0=t0, dur=dur, fps=fps)
    voice = voice_onsets(audio, t0=t0, dur=dur)
    if not motion or not voice:
        return {"voice_onsets": voice, "lags": [], "median_lag_s": None}
    thr = sorted(motion)[len(motion) // 2] * 2.5 + 1.0  # well above the median jitter of a held mouth
    starts = [t0 + i / fps for i in range(1, len(motion)) if motion[i] >= thr and motion[i - 1] < thr]
    lags = []
    for v in voice:
        near = [s - v for s in starts if -0.25 <= s - v <= 0.5]
        if near:
            lags.append(round(min(near, key=abs), 3))
    med = sorted(lags)[len(lags) // 2] if lags else None
    return {"voice_onsets": voice, "mouth_onsets": [round(s, 3) for s in starts], "lags": lags, "median_lag_s": med}
