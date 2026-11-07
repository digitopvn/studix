#!/usr/bin/env python3
"""Cheap machine checks to run BEFORE spawning QA agents, so the agents spend their turns on taste, not on hunting
defects a script finds in seconds. Prints one line per file and exits 1 when anything is flagged.

usage: uv run -q --with numpy python -X utf8 qa-prescan.py picture <video>... [--max-lead-black 0.5] [--max-hold 1.5]
       uv run -q --with numpy python -X utf8 qa-prescan.py clips <clip.mp4 | scene-dir>...
       uv run -q --with numpy python -X utf8 qa-prescan.py audio <wav-or-video>...
       uv run -q --with numpy python -X utf8 qa-prescan.py events <episode-dir> [--scenes sc01,sc02]

picture  every frame at 1280x720 gray:
         wedge   a transform edge exposed: >= 3 consecutive 64 px blocks from a corner whose outer 3 px are > 40 luma
                 darker than the band 8-10 px inside (FRONTIER sc02 f905 measured -82..-166 over 9 blocks; a QA
                 agent found it by eye after two renders had shipped)
         black   the leading black run (mean luma < 16) longer than --max-lead-black: a fadeFromBlack cue stacked on
                 the boot fade held frame 0 black; later black runs of 3+ frames are listed for a look
         hold    the picture barely changes for longer than --max-hold seconds: 16 px block means compared 0.5 s
                 apart change by under 5 luma (rain or grain over a held cel measured 3-5, any real move 7-60 on
                 FRONTIER sc03). A static cel is what the user called "quá tĩnh"; 0 turns the check off
clips    generated clips: hard cuts inside the clip (frame-difference spikes on a 96x54 proxy) and a leading black
         run. Given a scene dir (with edl.json), only the range each video shot uses is checked, so a cut the
         edit already avoids is not flagged
audio    clicks (second-difference spikes 12x over the 10 ms envelope) and dropouts (50 ms windows under -60 dBFS
         inside the file, not at its ends)
events   mix-events.json: a missing file; an unknown bus (beds, hits, vo, music); an event cut short (len under the
         file's remaining length) with a fade_out under 80 ms; a hits event whose peak after gain is under -30 dBFS
         (inaudible); a hits event whose transient sits more than 2 frames into the file while the event has no
         `onset` key (then `t` is the file start and the hit lands late: set t = moment - onset and record
         "onset": <s>), or whose `onset` key disagrees with the measured one by more than a frame. A swell or tail
         that is meant to creep in carries "onset": null
None of this judges taste or masking; audit-mix-buses.py and the two QA agents do that.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402

W, H, B = 1280, 720, 64
BUSES = ("beds", "hits", "vo", "music")
HOLD_BLOCK, HOLD_LAG, HOLD_THR = 16, 0.5, 5.0  # block size px, comparison lag s, mean abs luma change below = still


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


def picture(path: Path, fps: float, max_lead: float, max_hold: float) -> list[str]:
    p = subprocess.Popen(io.resolve_cmd(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-vf", f"scale={W}:{H}",
                                         "-f", "rawvideo", "-pix_fmt", "gray", "-"]), stdout=subprocess.PIPE)
    wedges, yavg, blocks = [], [], []
    while len(b := p.stdout.read(W * H)) == W * H:
        g = np.frombuffer(b, np.uint8).reshape(H, W).astype(np.float32)
        yavg.append(float(g.mean()))
        blocks.append(block_means(g))
        if w := frame_wedges(g):
            wedges.append(f"f{len(yavg) - 1} {(len(yavg) - 1) / fps:.2f}s {w}")
    p.wait()
    runs = black_runs(np.array(yavg))
    holds = still_runs(blocks, yavg, fps, max_hold)
    flags = [f"wedge {w}" for w in wedges] + [f"static hold {a:.2f}-{b:.2f}s ({b - a:.2f}s)" for a, b in holds]
    if runs and runs[0][0] == 0 and runs[0][1] / fps > max_lead:
        flags.append(f"leading black {runs[0][1] / fps:.2f}s > {max_lead}s (stacked fade?)")
    looks = [f"{a / fps:.2f}-{b / fps:.2f}s" for a, b in runs if a > 0 and b - a >= 3 and b < len(yavg)]
    print(f"{path.name}: {len(yavg)} frames, frame0 luma {yavg[0] if yavg else 0:.0f}, wedge frames {len(wedges)}, "
          f"static holds {len(holds)}" + (f", black runs to look at {looks[:8]}" if looks else ""))
    return flags


def proxy_frames(path: Path, w: int = 96, h: int = 54) -> np.ndarray:
    raw = subprocess.run(io.resolve_cmd(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-vf",
                                         f"scale={w}:{h},format=gray", "-f", "rawvideo", "-"]),
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)


def cut_frames(f: np.ndarray) -> list[int]:
    """Frames that start a new shot: the mean frame difference spikes 6x over the clip's median (and over 9 luma)."""
    if len(f) < 2:
        return []
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    med = float(np.median(d)) + 0.5
    return [i + 1 for i in range(len(d)) if d[i] > max(6 * med, 9)]


def clip_cuts(path: Path, fps: float, ranges: list[tuple[str, float, float]] | None = None) -> list[str]:
    f = proxy_frames(path)
    cuts = [c / fps for c in cut_frames(f)]
    lead = black_runs(f.mean(axis=(1, 2)), 4)
    flags = []
    if ranges is None:
        flags += [f"internal cut at {t:.2f}s" for t in cuts]
    else:
        for shot, a, b in ranges:
            flags += [f"{shot}: internal cut at clip {t:.2f}s inside the used range {a:.2f}-{b:.2f}s" for t in cuts
                      if a + 0.5 / fps < t < b - 0.5 / fps]
    if lead and lead[0][0] == 0 and (ranges is None or any(a < lead[0][1] / fps for _, a, _ in ranges)):
        flags.append(f"black from the first frame to {lead[0][1] / fps:.2f}s")
    print(f"{path.name}: {len(f) / fps:.2f}s, cuts at {[round(t, 2) for t in cuts]}")
    return flags


def scene_clips(scene: Path, fps: float) -> list[str]:
    edl = io.load_json(scene / "edl.json")
    ep = scene.parent.parent
    used: dict[Path, list[tuple[str, float, float]]] = {}
    for s in edl["shots"]:
        if s.get("kind") == "video" and s.get("src"):
            a = float(s.get("in", 0))
            used.setdefault(ep / s["src"], []).append((s["id"], a, a + (s["end"] - s["start"]) * s.get("speed", 1)))
    flags = []
    for src, ranges in used.items():
        flags += ([f"missing {src}"] if not src.exists() else
                  [f"{src.name}: {x}" for x in clip_cuts(src, edl.get("fps", fps), ranges)])
    return flags


def decode_mono(path: Path, sr: int = 48000, off: float = 0.0, ln: float | None = None) -> np.ndarray:
    raw = subprocess.run(io.resolve_cmd(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(off)] + (["-t", str(ln)] if ln else [])
                                        + ["-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]),
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


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


def audio(path: Path) -> list[str]:
    sr = 48000
    x = decode_mono(path, sr)
    c, d = clicks(x, sr), dropouts(x, sr)
    print(f"{path.name}: {len(x) / sr:.2f}s, clicks {c[:12]}, dropouts {d[:10]}")
    return [f"click {t}s" for t in c] + [f"dropout {a}-{b}s" for a, b in d]


@lru_cache(None)
def file_len(f: str) -> float:
    try:
        return io.ffprobe_duration(Path(f))
    except (Exception, SystemExit):  # noqa: BLE001 - io.run exits on an unreadable file; treat it as empty
        return 0.0


@lru_cache(None)
def file_transient(f: str, off: float, ln: float | None) -> tuple[float, float]:
    try:
        return transient(decode_mono(Path(f), 24000, off, ln), 24000)
    except (Exception, SystemExit):  # noqa: BLE001
        return -120.0, 0.0


def event_flags(e: dict, f: Path, fps: float = 24) -> list[str]:
    where = f"{e.get('scene', '-')} {e.get('at_shot', '')} t={e.get('t', 0)} {f.name}"
    if not f.exists():
        return [f"missing {where}"]
    out = []
    bus = e.get("bus", "beds")
    if bus not in BUSES:
        out.append(f"bus '{bus}' is not one of {', '.join(BUSES)}: {where}")
    rem = file_len(str(f)) - e.get("offset", 0)
    ln = e.get("len")
    if ln and not e.get("loop") and bus != "music" and ln < rem - 0.05 and e.get("fade_out", 0) < 0.08:
        out.append(f"chop {where} len {ln} of {rem:.2f}s, fade_out {e.get('fade_out', 0)}")
    if bus == "hits":
        pk, onset = file_transient(str(f), float(e.get("offset", 0)), ln)
        if pk + e.get("gain", 0) < -30:
            out.append(f"inaudible {where}: peak {pk + e.get('gain', 0):.1f} dBFS after gain")
        if "onset" in e:
            if e["onset"] is not None and abs(float(e["onset"]) - onset) > 1 / fps:
                out.append(f"onset key {e['onset']} but measured {onset:.3f}s: {where}")
        elif onset > 2 / fps:
            out.append(f"late transient {where}: onset {onset:.3f}s into the file; set t = moment - {onset:.3f} "
                       f"and \"onset\": {onset:.3f}")
    return out


def events(ep: Path, scenes: set[str] | None) -> list[str]:
    cfg = io.load_json(ep / "audio" / "mix-events.json")
    flags, n = [], 0
    for e in cfg.get("events", []):
        if scenes and e.get("scene") not in scenes:
            continue
        n += 1
        flags += event_flags(e, Path(e["file"]) if Path(e["file"]).is_absolute() else ep / e["file"])
    print(f"mix-events: {n} events checked")
    return flags


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["picture", "clips", "audio", "events"])
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--fps", type=float, default=24)
    ap.add_argument("--max-lead-black", type=float, default=0.5)
    ap.add_argument("--max-hold", type=float, default=1.5, help="picture: seconds of near-still picture to flag (0 = off)")
    ap.add_argument("--scenes", help="events mode: comma list")
    a = ap.parse_args()
    flags = []
    if a.mode == "events":
        flags = events(Path(a.paths[0]).resolve(), set(a.scenes.split(",")) if a.scenes else None)
    else:
        for p in map(Path, a.paths):
            if a.mode == "picture":
                got = picture(p, a.fps, a.max_lead_black, a.max_hold)
            elif a.mode == "clips":
                got = scene_clips(p, a.fps) if p.is_dir() else clip_cuts(p, a.fps)
            else:
                got = audio(p)
            flags += [f"{p.name}: {x}" for x in got]
    if flags:
        print(f"FLAGGED ({len(flags)}):\n  " + "\n  ".join(flags[:60]))
    sys.exit(1 if flags else 0)


if __name__ == "__main__":
    main()
