"""shot-boundaries: every join between two shots of a rendered film, the last N frames before the cut against
the first N after it, on a 160x90 RGB proxy. Per join:
  luma   mean-luma jump across the join (a lighting pop)
  hist   colour-histogram distance 0..1 across the join (a palette or grade jump)
  ratio  the join's frame difference over the median frame difference inside both sides (a jump in pose or
         framing that the shots' own motion does not explain)
The thresholds apply to joins whose boundary promises continuity (`locked-composition`, `camera-transition`); an
`intentional-cut` is reported as allowed. A `chained` join (the second shot was generated from a still of the
first) is judged on the looser chained ratio, because image-to-video models redraw the still they start on.

Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/qa-shot-boundaries.py (join_metrics,
judge). That script reads separate clips through an EDL; here the joins come from the IR timeline of one render,
and strips, chain stills and episode files are left out.
"""
from __future__ import annotations

import numpy as np

from .ff import ffmpeg, ffprobe_json, input_args
from .probe import summarize
from .sandbox import Deadline, Media, ToolError

W, H = 160, 90
CONTINUOUS = ("locked-composition", "camera-transition")
MODES = (*CONTINUOUS, "intentional-cut")
DEFAULTS = {"luma": 18.0, "hist": 0.35, "ratio": 3.0, "chainedRatio": 4.5}
MAX_JOINS = 2000


def rgb_frames(path, deadline: Deadline, start: float, n: int, fps: float) -> np.ndarray:
    """n RGB frames from `start` -> (k, H, W, 3) float32, k <= n."""
    raw = ffmpeg(["-v", "error", *input_args(path, seek=max(0.0, start)), "-map", "0:v:0", "-frames:v", str(n),
                  "-vf", f"fps={fps},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], deadline).stdout
    k = len(raw) // (W * H * 3)
    return np.frombuffer(raw[: k * W * H * 3], np.uint8).reshape(k, H, W, 3).astype(np.float32)


def _hist(f: np.ndarray, bins: int = 16) -> np.ndarray:
    h = np.concatenate([np.histogram(f[..., c], bins=bins, range=(0, 256))[0] for c in range(3)]).astype(np.float64)
    return h / max(h.sum(), 1.0)


def join_metrics(a: np.ndarray, b: np.ndarray) -> dict:
    """a: the frames before the cut, b: the frames after it (each at least one frame)."""
    la, fb = a[-1], b[0]
    inner = [float(np.abs(x[i + 1] - x[i]).mean()) for x in (a, b) for i in range(len(x) - 1)]
    base = float(np.median(inner)) if inner else 0.0
    join = float(np.abs(fb - la).mean())
    return {"luma": round(abs(float(la.mean()) - float(fb.mean())), 2),
            "hist": round(0.5 * float(np.abs(_hist(la) - _hist(fb)).sum()), 3),
            "joinDiff": round(join, 2), "innerDiff": round(base, 2), "ratio": round(join / max(base, 1.0), 2)}


def judge(m: dict, mode: str, thr: dict, *, chained: bool = False) -> tuple[str, list[str]]:
    limits = {"luma": thr["luma"], "hist": thr["hist"], "ratio": thr["chainedRatio"] if chained else thr["ratio"]}
    why = [f"{k} {m[k]} > {limits[k]}" + (" (chained)" if chained and k == "ratio" else "")
           for k in ("luma", "hist", "ratio") if m[k] > limits[k]]
    if mode == "intentional-cut":
        return "allowed", ["intentional cut"]
    return ("flag" if why else "ok"), why


def _threshold(payload: dict, key: str) -> float:
    value = payload.get(key, DEFAULTS[key])
    if not isinstance(value, (int, float)) or value <= 0:
        raise ToolError("VALIDATION", f"{key} must be a positive number")
    return float(value)


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    path = media.path(payload.get("media"))
    joins = payload.get("joins")
    if not isinstance(joins, list) or not 0 < len(joins) <= MAX_JOINS:
        raise ToolError("VALIDATION", f"joins must be a list of 1..{MAX_JOINS} joins")
    n = payload.get("n", 6)
    if not isinstance(n, int) or not 2 <= n <= 48:
        raise ToolError("VALIDATION", "n must be an integer in 2..48")
    thr = {k: _threshold(payload, k) for k in DEFAULTS}
    video = summarize(ffprobe_json(path, deadline))["video"]
    if video is None:
        raise ToolError("VALIDATION", "file has no video stream", {"media": payload.get("media")})
    fps = float(video["fps"] or 24.0)
    rows, flagged = [], 0
    for j in joins:
        if not isinstance(j, dict) or j.get("mode") not in MODES or not isinstance(j.get("atS"), (int, float)):
            raise ToolError("VALIDATION", "each join needs a, b, atS and a boundary mode", {"join": j})
        name = f"{j.get('a')}|{j.get('b')}"
        at = float(j["atS"])
        tail = rgb_frames(path, deadline, at - n / fps, n, fps)
        head = rgb_frames(path, deadline, at, n, fps)
        if not len(tail) or not len(head):
            rows.append({"join": name, "mode": j["mode"], "chained": bool(j.get("chained")), "verdict": "skip",
                         "why": ["no frames decoded"]})
            continue
        m = join_metrics(tail, head)
        verdict, why = judge(m, j["mode"], thr, chained=bool(j.get("chained")))
        flagged += verdict == "flag"
        rows.append({"join": name, "mode": j["mode"], "chained": bool(j.get("chained")), "verdict": verdict,
                     "why": why, **m})
    return {"fps": fps, "joins": rows, "flagged": flagged, "pass": flagged == 0}
