"""frame-qa: a few frames sampled across a render, checked for what duration, fps and codec cannot show.

Per sampled frame: black (mean luma under 16), blank (a flat, non-black frame: a missing layer or a failed
load), and sparse edges inside the outer safe-margin band (text or graphics placed where a phone or TV crops).
Between neighbouring samples: a scene that did not change. A contact sheet PNG of the samples is written to the
run's output directory when there is one.

These are heuristics on a small gray proxy, reported as evidence for a reviewer, never as a gate: a deliberate
title hold is "static", a full-bleed photo has edges everywhere (more than MARGIN_TEXTURE_MAX of the band is
treated as texture, not as text).
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np

from . import ff
from .ff import ffprobe_json, input_args
from .probe import summarize
from .sandbox import Deadline, Media, Outputs, ToolError

LONG_SIDE, SHORT_SIDE = 320, 180  # proxy size; portrait renders get 180x320 so they are not squashed
BLACK_LUMA = 16.0
BLANK_STD = 2.0
EDGE_STRENGTH = 40.0
MARGIN_MIN, MARGIN_TEXTURE_MAX = 0.01, 0.25
STATIC_DIFF = 0.5
SHEET_COLUMNS = 4
DEFAULT_SAMPLES, MAX_SAMPLES = 6, 16
DEFAULT_MARGIN_PCT = 5.0


def frame_times(path: Path, deadline: Deadline) -> list[float]:
    """Presentation times of the video frames, sorted, from the packet index (no decoding). The end of the
    *video* is read from here, because a container may be longer than its picture (audio tail) and MKV/WebM carry
    no per-stream duration."""
    result = ff.run([ff.ffprobe_bin(), "-v", "error", *ff.INPUT_GUARD, "-select_streams", "v:0",
                     "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(path)], deadline)
    times = set()
    for line in result.stdout.decode("utf-8", "replace").splitlines():
        try:
            times.add(round(float(line.strip().rstrip(",")), 6))
        except ValueError:
            continue
    return sorted(times)


def pick_times(frames: list[float], count: int) -> list[float]:
    """One real frame time per equal slice (the middle one), so the first and last frames (fades) are not the
    sample and every pick is a distinct frame the decoder can reach."""
    n = len(frames)
    return [frames[min(n - 1, int((i + 0.5) * n / count))] for i in range(count)]


def _frame_rgb(path: Path, t: float, size: tuple[int, int], deadline: Deadline) -> np.ndarray:
    w, h = size
    # Seek a millisecond before the frame so rounding never lands after it.
    proc = ff.ffmpeg(["-v", "error", *input_args(path, seek=max(0.0, t - 0.001)), "-map", "0:v:0", "-frames:v", "1",
                      "-vf", f"scale={w}:{h}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], deadline)
    if len(proc.stdout) < w * h * 3:
        raise ToolError("INTERNAL", f"ffmpeg returned no frame at {t:.3f}s")
    return np.frombuffer(proc.stdout[:w * h * 3], np.uint8).reshape(h, w, 3)


def _gray(rgb: np.ndarray) -> np.ndarray:
    f = rgb.astype(np.float32)
    return 0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]


def margin_edge_ratio(gray: np.ndarray, margin_pct: float) -> float | None:
    """Share of strong-edge pixels in the band outside the safe rectangle (margin_pct of width and height on every
    side). None when margin_pct is 0."""
    if margin_pct <= 0:
        return None
    h, w = gray.shape
    mx, my = max(1, round(w * margin_pct / 100)), max(1, round(h * margin_pct / 100))
    edge = np.zeros_like(gray, dtype=bool)
    edge[:, 1:] |= np.abs(np.diff(gray, axis=1)) > EDGE_STRENGTH
    edge[1:, :] |= np.abs(np.diff(gray, axis=0)) > EDGE_STRENGTH
    band = np.ones_like(edge)
    band[my:h - my, mx:w - mx] = False
    return float(edge[band].mean())


def classify(gray: np.ndarray) -> str:
    if float(gray.mean()) < BLACK_LUMA:
        return "black"
    return "blank" if float(gray.std()) < BLANK_STD else "ok"


def _png(rgb: np.ndarray) -> bytes:
    h, w, _ = rgb.shape
    raw = b"".join(b"\x00" + rgb[y].tobytes() for y in range(h))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def contact_sheet(frames: list[np.ndarray]) -> tuple[bytes, int, int]:
    fh, fw, _ = frames[0].shape
    cols = min(SHEET_COLUMNS, len(frames))
    rows = -(-len(frames) // cols)
    sheet = np.full((rows * fh, cols * fw, 3), 24, np.uint8)
    for i, f in enumerate(frames):
        r, c = divmod(i, cols)
        sheet[r * fh:(r + 1) * fh, c * fw:(c + 1) * fw] = f
    return _png(sheet), cols, rows


def run(payload: dict, media: Media, deadline: Deadline, outputs: Outputs) -> dict:
    path = media.path(payload.get("media"))
    count = payload.get("samples", DEFAULT_SAMPLES)
    margin = payload.get("safeMarginPct", DEFAULT_MARGIN_PCT)
    if not isinstance(count, int) or isinstance(count, bool) or not 2 <= count <= MAX_SAMPLES:
        raise ToolError("VALIDATION", f"samples must be an integer from 2 to {MAX_SAMPLES}")
    if isinstance(margin, bool) or not isinstance(margin, (int, float)) or not 0 <= margin <= 20:
        raise ToolError("VALIDATION", "safeMarginPct must be a number between 0 and 20")
    margin = float(margin)
    video = summarize(ffprobe_json(path, deadline))["video"]
    if video is None:
        raise ToolError("VALIDATION", "file has no video stream", {"media": payload.get("media")})
    available = frame_times(path, deadline)
    if len(available) < 2:
        raise ToolError("VALIDATION", "video has fewer than 2 frames to compare", {"media": payload.get("media")})
    count = min(count, len(available))
    portrait = video["height"] > video["width"]
    size = (SHORT_SIDE, LONG_SIDE) if portrait else (LONG_SIDE, SHORT_SIDE)
    fps = video["fps"] or 24.0
    duration = round(available[-1] + 1 / fps, 3)

    times = pick_times(available, count)
    frames = [_frame_rgb(path, t, size, deadline) for t in times]
    grays = [_gray(f) for f in frames]

    samples, flags = [], []
    for i, (t, g) in enumerate(zip(times, grays)):
        kind = classify(g)
        ratio = margin_edge_ratio(g, margin)
        outside = ratio is not None and MARGIN_MIN <= ratio <= MARGIN_TEXTURE_MAX
        samples.append({"index": i, "tS": t, "meanLuma": round(float(g.mean()), 2),
                        "lumaStd": round(float(g.std()), 2), "kind": kind,
                        "marginEdgeRatio": None if ratio is None else round(ratio, 4), "outsideSafeMargin": outside})
        if kind != "ok":
            flags.append(f"{t:.2f}s: {kind} frame")
        if outside:
            flags.append(f"{t:.2f}s: content inside the outer {margin:g}% safe margin")
    pairs = []
    for i in range(count - 1):
        diff = float(np.abs(grays[i + 1] - grays[i]).mean())
        static = diff < STATIC_DIFF
        pairs.append({"from": i, "to": i + 1, "meanAbsDiff": round(diff, 3), "static": static})
        if static:
            flags.append(f"{times[i]:.2f}s to {times[i + 1]:.2f}s: the scene did not change")

    sheet = None
    if outputs.root is not None and payload.get("contactSheet", False):
        png, cols, rows = contact_sheet(frames)
        name = "contact-sheet.png"
        outputs.path(name).write_bytes(png)
        sheet = {"file": name, "columns": cols, "rows": rows, "frameWidth": size[0], "frameHeight": size[1]}
    return {
        "durationS": duration,
        "safeMarginPct": margin,
        "samples": samples,
        "pairs": pairs,
        "blankSamples": sum(s["kind"] == "blank" for s in samples),
        "blackSamples": sum(s["kind"] == "black" for s in samples),
        "marginSamples": sum(s["outsideSafeMargin"] for s in samples),
        "staticPairs": sum(p["static"] for p in pairs),
        "flags": flags,
        "contactSheet": sheet,
    }
