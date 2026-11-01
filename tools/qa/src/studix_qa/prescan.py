"""prescan: cheap machine checks run before any reviewer looks, so a reviewer spends time on taste instead of on
defects a script finds in seconds. Its flags are evidence for a reviewer, not a gate.

Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/qa-prescan.py. The detectors and
their thresholds are unchanged; the file-based modes became JSON input: `clips` takes the used ranges
instead of reading edl.json, `events` takes the event list instead of reading audio/mix-events.json, and
every file is a media grant id.

picture  every frame at 1280x720 gray:
         wedge   a transform edge exposed: >= 3 consecutive 64 px blocks from a corner whose outer 3 px are > 40
                 luma darker than the band 8-10 px inside
         black   the leading black run (mean luma < 16) longer than maxLeadBlackS; later black runs of 3+ frames
                 are listed for a look
         hold    the picture barely changes for longer than maxHoldS: 16 px block means compared 0.5 s apart
                 change by under 5 luma (grain over a held cel measured 3-5, any real move 7-60); 0 turns it off
clips    generated clips: hard cuts inside the clip (frame-difference spikes on a 96x54 proxy) and a leading black
         run. With `ranges`, only the range each shot uses is checked, so a cut the edit avoids is not flagged
audio    clicks (second-difference spikes 12x over the 10 ms envelope) and dropouts (50 ms windows under -60 dBFS
         inside the file, not at its ends)
events   mix events: an unknown bus; an event cut short with a fade-out under 80 ms; a hits event whose peak after
         gain is under -30 dBFS; a hits event whose transient sits more than 2 frames into the file without an
         `onset` key, or whose `onset` disagrees with the measured one by more than a frame
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np

from .ff import decode_audio, ffprobe_json, gray_frames
from .probe import summarize
from .sandbox import Deadline, Media, ToolError

W, H, B = 1280, 720, 64
BUSES = ("beds", "hits", "vo", "music")
HOLD_BLOCK, HOLD_LAG, HOLD_THR = 16, 0.5, 5.0  # block size px, comparison lag s, mean abs luma change below = still
MAX_FLAGS = 200


def wedge_run(d: np.ndarray, thr: float = -40) -> int:
    """Longest run of blocks darker than thr anchored at either end of an edge (0 when shorter than 3)."""
    best = 0
    for seq in (d, d[::-1]):
        n = 0
        while n < len(seq) and seq[n] < thr:
            n += 1
        best = max(best, n if n >= 3 else 0)
    return best


def frame_wedges(g: np.ndarray) -> str:
    out = ""
    for name, o, i in (("T", g[0:3].mean(0), g[8:11].mean(0)), ("B", g[-3:].mean(0), g[-11:-8].mean(0)),
                       ("L", g[:, 0:3].mean(1), g[:, 8:11].mean(1)), ("R", g[:, -3:].mean(1), g[:, -11:-8].mean(1))):
        n = len(o) // B * B
        r = wedge_run((o[:n] - i[:n]).reshape(-1, B).mean(1))
        if r:
            out += f"{name}{r}"
    return out


def black_runs(yavg: np.ndarray, thr: float = 16) -> list[tuple[int, int]]:
    """[start, end) index runs where the value is under thr."""
    runs, start = [], None
    for k, y in enumerate(list(yavg) + [255]):
        if y < thr and start is None:
            start = k
        elif y >= thr and start is not None:
            runs.append((start, k))
            start = None
    return runs


def block_means(g: np.ndarray, b: int = HOLD_BLOCK) -> np.ndarray:
    h, w = g.shape[0] // b * b, g.shape[1] // b * b
    return g[:h, :w].reshape(h // b, b, w // b, b).mean((1, 3))


def still_runs(blocks: list[np.ndarray], yavg: list[float], fps: float, min_s: float,
               lag_s: float = HOLD_LAG, thr: float = HOLD_THR) -> list[tuple[float, float]]:
    """Spans (seconds) of at least min_s where each frame differs from the one lag_s later by under thr luma
    (block means, so grain averages out); black frames are left to the black check."""
    lag = max(1, int(round(lag_s * fps)))
    n = len(blocks)
    if n <= lag or min_s <= 0:
        return []
    still = [float(np.abs(blocks[k + lag] - blocks[k]).mean()) < thr and yavg[k] >= 16 for k in range(n - lag)]
    out = []
    for a, b in black_runs(np.array([0.0 if s else 255.0 for s in still]), 1):  # runs of still frames
        a_s, b_s = a / fps, (b + lag) / fps  # the last compared frame belongs to the hold too
        if b_s - a_s > min_s:
            out.append((round(a_s, 2), round(b_s, 2)))
    return out


def cut_frames(f: np.ndarray) -> list[int]:
    """Frames that start a new shot: the mean frame difference spikes 6x over the clip's median (and over 9 luma)."""
    if len(f) < 2:
        return []
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    med = float(np.median(d)) + 0.5
    return [i + 1 for i in range(len(d)) if d[i] > max(6 * med, 9)]


def clicks(x: np.ndarray, sr: int) -> list[float]:
    d2 = np.abs(np.diff(x, 2))
    k = max(1, int(0.01 * sr))
    env = np.sqrt(np.convolve(x.astype(np.float64) ** 2, np.ones(k) / k, "same"))[1:-1]
    out: list[int] = []
    for c in np.where((d2 > 0.08) & (d2 > 12 * (env + 1e-4)))[0]:
        if not out or c - out[-1] > sr * 0.05:
            out.append(int(c))
    return [round(c / sr, 3) for c in out]


def dropouts(x: np.ndarray, sr: int, floor_db: float = -60) -> list[tuple[float, float]]:
    w = int(0.05 * sr)
    n = len(x) // w
    if n < 3:
        return []
    r = 20 * np.log10(np.sqrt((x[: n * w].astype(np.float64).reshape(n, w) ** 2).mean(1)) + 1e-9)
    runs = black_runs(r, floor_db)  # same run finder: windows under the floor
    return [(round(a * 0.05, 2), round(b * 0.05, 2)) for a, b in runs if a > 0 and b < n]


def transient(x: np.ndarray, sr: int) -> tuple[float, float]:
    """(peak dBFS, onset s): onset is the first 5 ms window whose sample peak reaches 10% of the file's peak."""
    pk = float(np.max(np.abs(x))) if len(x) else 0.0
    if pk <= 0:
        return -120.0, 0.0
    w = max(1, int(0.005 * sr))
    n = len(x) // w
    wp = np.abs(x[: n * w]).reshape(n, w).max(1) if n else np.abs(x)
    return 20 * np.log10(pk), float(np.argmax(wp >= 0.1 * pk) * w / sr)


def _fps(path: Path, deadline: Deadline, fallback: float) -> float:
    video = summarize(ffprobe_json(path, deadline))["video"]
    return (video or {}).get("fps") or fallback


def picture(path: Path, deadline: Deadline, fps: float, max_lead: float, max_hold: float) -> dict:
    wedges, yavg, blocks = [], [], []
    for g in gray_frames(path, deadline, W, H):
        yavg.append(float(g.mean()))
        blocks.append(block_means(g))
        if w := frame_wedges(g):
            wedges.append(f"f{len(yavg) - 1} {(len(yavg) - 1) / fps:.2f}s {w}")
    runs = black_runs(np.array(yavg))
    holds = still_runs(blocks, yavg, fps, max_hold)
    flags = [f"wedge {w}" for w in wedges] + [f"static hold {a:.2f}-{b:.2f}s ({b - a:.2f}s)" for a, b in holds]
    if runs and runs[0][0] == 0 and runs[0][1] / fps > max_lead:
        flags.append(f"leading black {runs[0][1] / fps:.2f}s > {max_lead}s (stacked fade?)")
    looks = [[round(a / fps, 2), round(b / fps, 2)] for a, b in runs if a > 0 and b - a >= 3 and b < len(yavg)]
    return {"frames": len(yavg), "frame0Luma": round(yavg[0], 1) if yavg else None, "wedgeFrames": len(wedges),
            "staticHolds": [list(h) for h in holds], "blackRunsToLookAt": looks, "flags": flags}


def proxy_frames(path: Path, deadline: Deadline, w: int = 96, h: int = 54) -> np.ndarray:
    frames = list(gray_frames(path, deadline, w, h))
    return np.stack(frames) if frames else np.zeros((0, h, w), np.float32)


def clip_cuts(path: Path, deadline: Deadline, fps: float, ranges: list[tuple[str, float, float]] | None) -> dict:
    f = proxy_frames(path, deadline)
    cuts = [c / fps for c in cut_frames(f)]
    lead = black_runs(f.mean(axis=(1, 2)), 4) if len(f) else []
    flags = []
    if ranges is None:
        flags += [f"internal cut at {t:.2f}s" for t in cuts]
    else:
        for shot, a, b in ranges:
            flags += [f"{shot}: internal cut at clip {t:.2f}s inside the used range {a:.2f}-{b:.2f}s" for t in cuts
                      if a + 0.5 / fps < t < b - 0.5 / fps]
    if lead and lead[0][0] == 0 and (ranges is None or any(a < lead[0][1] / fps for _, a, _ in ranges)):
        flags.append(f"black from the first frame to {lead[0][1] / fps:.2f}s")
    return {"durationS": round(len(f) / fps, 3), "cutsS": [round(t, 2) for t in cuts], "flags": flags}


def audio(path: Path, deadline: Deadline) -> dict:
    sr = 48000
    x = decode_audio(path, deadline, sr=sr)
    c, d = clicks(x, sr), dropouts(x, sr)
    return {"durationS": round(len(x) / sr, 3), "clicksS": c, "dropoutsS": [list(r) for r in d],
            "flags": [f"click {t}s" for t in c] + [f"dropout {a}-{b}s" for a, b in d]}


def event_flags(e: dict, f: Path | None, *, file_len, file_transient, fps: float = 24) -> list[str]:
    """Flags for one mix event. `f` is None when the event's file was not granted (reported as missing);
    file_len / file_transient measure the file (injected so tests can stub them)."""
    where = f"{e.get('scene', '-')} {e.get('atShot', '')} t={e.get('t', 0)} {e.get('file', '?')}"
    if f is None:
        return [f"missing {where}"]
    out = []
    bus = e.get("bus", "beds")
    if bus not in BUSES:
        out.append(f"bus '{bus}' is not one of {', '.join(BUSES)}: {where}")
    rem = file_len(f) - float(e.get("offset", 0))
    ln = e.get("len")
    if ln and not e.get("loop") and bus != "music" and ln < rem - 0.05 and e.get("fadeOut", 0) < 0.08:
        out.append(f"chop {where} len {ln} of {rem:.2f}s, fadeOut {e.get('fadeOut', 0)}")
    if bus == "hits":
        pk, onset = file_transient(f, float(e.get("offset", 0)), ln)
        if pk + e.get("gain", 0) < -30:
            out.append(f"inaudible {where}: peak {pk + e.get('gain', 0):.1f} dBFS after gain")
        if "onset" in e:
            if e["onset"] is not None and abs(float(e["onset"]) - onset) > 1 / fps:
                out.append(f"onset key {e['onset']} but measured {onset:.3f}s: {where}")
        elif onset > 2 / fps:
            out.append(f"late transient {where}: onset {onset:.3f}s into the file; set t = moment - {onset:.3f} "
                       f"and \"onset\": {onset:.3f}")
    return out


def events(payload: dict, media: Media, deadline: Deadline) -> dict:
    evs = payload.get("events")
    if not isinstance(evs, list):
        raise ToolError("VALIDATION", "events mode needs an `events` array")
    fps = float(payload.get("fps") or 24)
    granted = set(media.ids())

    @lru_cache(None)
    def file_len(f: Path) -> float:
        return summarize(ffprobe_json(f, deadline))["durationS"] or 0.0

    @lru_cache(None)
    def file_transient(f: Path, off: float, ln: float | None) -> tuple[float, float]:
        return transient(decode_audio(f, deadline, sr=24000, seek=off, length=ln), 24000)

    flags: list[str] = []
    for e in evs:
        if not isinstance(e, dict):
            raise ToolError("VALIDATION", "every event must be an object")
        ref = e.get("file")
        f = media.path(ref) if ref in granted else None
        flags += event_flags(e, f, file_len=file_len, file_transient=file_transient, fps=fps)
    return {"events": len(evs), "flags": flags}


def _ranges(raw: object) -> list[tuple[str, float, float]] | None:
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ToolError("VALIDATION", "ranges must be an array of {shot, inS, outS}")
    out = []
    for r in raw:
        try:
            out.append((str(r["shot"]), float(r["inS"]), float(r["outS"])))
        except (KeyError, TypeError, ValueError) as err:
            raise ToolError("VALIDATION", "every range needs shot, inS and outS") from err
    return out


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    mode = payload.get("mode")
    if mode == "events":
        result = events(payload, media, deadline)
        return {"mode": mode, "files": [], "flags": result["flags"][:MAX_FLAGS], "events": result["events"]}
    if mode not in ("picture", "clips", "audio"):
        raise ToolError("VALIDATION", "mode must be picture, clips, audio or events")
    refs = payload.get("media")
    if not isinstance(refs, list) or not refs:
        raise ToolError("VALIDATION", f"{mode} mode needs a non-empty `media` array")
    fps_default = float(payload.get("fps") or 24)
    files, flags = [], []
    for ref in refs:
        path = media.path(ref)
        if mode == "picture":
            got = picture(path, deadline, _fps(path, deadline, fps_default), float(payload.get("maxLeadBlackS", 0.5)),
                          float(payload.get("maxHoldS", 1.5)))
        elif mode == "clips":
            ranges = (payload.get("ranges") or {}).get(ref) if isinstance(payload.get("ranges"), dict) else None
            got = clip_cuts(path, deadline, _fps(path, deadline, fps_default), _ranges(ranges))
        else:
            got = audio(path, deadline)
        files.append({"media": ref, **got})
        flags += [f"{ref}: {x}" for x in got["flags"]]
    return {"mode": mode, "files": files, "flags": flags[:MAX_FLAGS]}
