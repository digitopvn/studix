"""black-frames: runs of black frames (mean luma under a threshold, 16 by default, on a full-range gray proxy)
in the first video stream. The leading run, the trailing run and the longest run in between are reported
separately, because a fade from or to black at the ends is normal and a blackout in the middle is not.

The black test is the one qa-prescan applies to every frame (zuey-workspace@10719856:
.agents/skills/anime-creator/scripts/qa-prescan.py, `black_runs`), on a smaller proxy: mean luma does not
depend on the frame size.
"""
from __future__ import annotations

import numpy as np

from .ff import ffprobe_json, gray_frames
from .prescan import black_runs
from .probe import summarize
from .sandbox import Deadline, Media, ToolError

PROXY_W, PROXY_H = 160, 90


def analyse(yavg: list[float], fps: float, threshold: float = 16) -> dict:
    n = len(yavg)
    runs = black_runs(np.array(yavg, np.float64), threshold) if n else []
    leading = next((b for a, b in runs if a == 0), 0)
    trailing = next((b - a for a, b in runs if b == n and a > 0), 0)
    inner = [(a, b) for a, b in runs if a > 0 and b < n]
    return {
        "fps": fps,
        "frames": n,
        "blackFrames": int(sum(b - a for a, b in runs)),
        "leadingS": round(leading / fps, 3),
        "trailingS": round(trailing / fps, 3),
        "maxInnerRunS": round(max((b - a for a, b in inner), default=0) / fps, 3),
        "allBlack": n > 0 and leading == n,
        "runs": [{"startS": round(a / fps, 3), "endS": round(b / fps, 3), "frames": b - a} for a, b in runs[:100]],
    }


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    path = media.path(payload.get("media"))
    threshold = float(payload.get("thresholdLuma", 16))
    if not 0 < threshold < 255:
        raise ToolError("VALIDATION", "thresholdLuma must be between 0 and 255")
    video = summarize(ffprobe_json(path, deadline))["video"]
    if video is None:
        raise ToolError("VALIDATION", "file has no video stream", {"media": payload.get("media")})
    fps = video["fps"] or 24.0
    yavg = [float(g.mean()) for g in gray_frames(path, deadline, PROXY_W, PROXY_H)]
    return {"thresholdLuma": threshold, **analyse(yavg, fps, threshold)}
