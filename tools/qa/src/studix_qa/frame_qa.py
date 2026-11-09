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

import subprocess
import struct
import zlib
from pathlib import Path

import numpy as np

from .ff import INPUT_GUARD, _preexec, ffmpeg_bin, ffprobe_json
from .probe import summarize
from .sandbox import Deadline, Media, Outputs, ToolError

PROXY_W, PROXY_H = 320, 180
BLACK_LUMA = 16.0
BLANK_STD = 2.0
EDGE_STRENGTH = 40.0
MARGIN_MIN, MARGIN_TEXTURE_MAX = 0.01, 0.25
STATIC_DIFF = 0.5
SHEET_COLUMNS = 4
DEFAULT_SAMPLES, MAX_SAMPLES = 6, 16
DEFAULT_MARGIN_PCT = 5.0


def sample_times(duration: float, count: int) -> list[float]:
    """Mid-slice timestamps: one per equal slice, so the first and last frames (fades) are never the sample."""
    return [round(duration * (i + 0.5) / count, 3) for i in range(count)]


def _frame_rgb(path: Path, t: float, deadline: Deadline) -> np.ndarray:
    argv = [ffmpeg_bin(), "-nostdin", "-hide_banner", "-nostats", "-v", "error", "-ss", f"{t:.3f}",
            *INPUT_GUARD, "-i", str(path), "-map", "0:v:0", "-frames:v", "1",
            "-vf", f"scale={PROXY_W}:{PROXY_H}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=deadline.remaining(), preexec_fn=_preexec(),
                              check=False)
    except FileNotFoundError as err:
        raise ToolError("UNAVAILABLE", f"{argv[0]} is not installed or not on PATH") from err
    except subprocess.TimeoutExpired as err:
        raise ToolError("TIMEOUT", f"ffmpeg exceeded the {deadline.seconds:g}s deadline") from err
    size = PROXY_W * PROXY_H * 3
    if proc.returncode != 0 or len(proc.stdout) < size:
        tail = proc.stderr.decode("utf-8", "replace")[-1500:]
        raise ToolError("INTERNAL", f"ffmpeg returned no frame at {t:.3f}s", {"stderr": tail})
    return np.frombuffer(proc.stdout[:size], np.uint8).reshape(PROXY_H, PROXY_W, 3)


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
    cols = min(SHEET_COLUMNS, len(frames))
    rows = -(-len(frames) // cols)
    sheet = np.full((rows * PROXY_H, cols * PROXY_W, 3), 24, np.uint8)
    for i, f in enumerate(frames):
        r, c = divmod(i, cols)
        sheet[r * PROXY_H:(r + 1) * PROXY_H, c * PROXY_W:(c + 1) * PROXY_W] = f
    return _png(sheet), cols, rows


def run(payload: dict, media: Media, deadline: Deadline, outputs: Outputs) -> dict:
    path = media.path(payload.get("media"))
    count = payload.get("samples", DEFAULT_SAMPLES)
    margin = float(payload.get("safeMarginPct", DEFAULT_MARGIN_PCT))
    if not isinstance(count, int) or isinstance(count, bool) or not 2 <= count <= MAX_SAMPLES:
        raise ToolError("VALIDATION", f"samples must be an integer from 2 to {MAX_SAMPLES}")
    if not 0 <= margin <= 20:
        raise ToolError("VALIDATION", "safeMarginPct must be between 0 and 20")
    video = summarize(ffprobe_json(path, deadline))["video"]
    if video is None:
        raise ToolError("VALIDATION", "file has no video stream", {"media": payload.get("media")})
    duration = video["durationS"]
    if not duration or duration <= 0:
        raise ToolError("VALIDATION", "video has no readable duration", {"media": payload.get("media")})

    times = sample_times(duration, count)
    frames = [_frame_rgb(path, t, deadline) for t in times]
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
    if outputs.root is not None and payload.get("contactSheet", True):
        png, cols, rows = contact_sheet(frames)
        name = "contact-sheet.png"
        outputs.path(name).write_bytes(png)
        sheet = {"file": name, "columns": cols, "rows": rows, "frameWidth": PROXY_W, "frameHeight": PROXY_H}
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
