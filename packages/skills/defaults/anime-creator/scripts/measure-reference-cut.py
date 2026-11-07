#!/usr/bin/env python3
"""Cut rhythm, impact frames, holds, loudness and hit placement of a film, so ours can be held against a reference.

usage: uv run -q --with numpy python -X utf8 measure-reference-cut.py <video>[@start-end]... [--json out.json]
                                                                      [--sheet DIR] [--hits 12]
  e.g. measure-reference-cut.py ref-01.mp4 renders/sc03-master.mp4 --json work/cut-compare.json --sheet work/ref-sheets

Per file (or span):
  shots     shot lengths from hard cuts on a 96x54 proxy (frame difference and colour histogram change, both
            against the local motion around the frame; see cut_frames), with flash frames removed first: ASL, median, p10/p90, cuts per minute and the share of shots under
            1 s, 1-3 s and over 3 s. Runs of 3 frames or fewer are counted apart as `micro` (impact frames, FX
            drawn on ones, whip-pan blur) with their share of runtime; the stats cover the rest.
  dissolves candidate gradual transitions (fades included): a 50/50 blend test over 12 frames. Listed, not
            counted as shot boundaries: on four references one of two candidates was a real cross-dissolve and
            the other an explosion clearing inside a shot. Wipes and full-frame FX covers stay invisible: check
            on the sheet
  flashes   impact frames: 1-4 frames whose mean luma jumps 35+ over both neighbours (white flash, inverted or
            silhouette frame) and comes back; listed with time and length in frames
  holds     runs of 0.75 s or more where 6 px proxy block means (about 80 px at 720p) change under 5 luma 0.5 s
            apart (held drawings, stopped camera); the share of runtime held. Coarser than qa-prescan's hold check:
            use it to compare films, not to gate one hold. A reference's holds are deliberate beats, not a defect
  motion    mean frame difference per shot, so a quiet shot and a busy one can be told apart
  loudness  integrated LUFS, LRA and peak (ebur128), and the spread of 0.4 s block levels (p10, p50, p90 dBFS)
  hits      the strongest transients (10 ms envelope rising 12 dB or more over the 150 ms before it; 6 dB when
            12 finds under half of --hits, which itself says the mix is a dense wall), each with:
              cut_f   frames from the nearest cut (negative = the hit lands before the cut); the summary sets the
                      count within 2 frames against chance (5 frames / mean shot length per hit)
              flash   true when a flash frame is within 3 frames
              dip_db  how far the 0.15-1.0 s before the hit sits under the 3 s before that (the silence or
                      suck-out before an impact; 6 dB or more reads as a deliberate drop)
              sub     share of the 250 ms after the onset below 120 Hz (dB of total): the sub layer of the hit
              tail_s  time until the envelope falls 20 dB under the hit peak: the decay/debris tail
--sheet DIR writes <name>-shots.jpg: one tile per shot (its middle frame), shot index and length burned in,
so the rhythm and the beats can be read as a page instead of a video.

These are measurements to compare with, not a verdict on taste.
"""
from __future__ import annotations

import argparse
import math
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio import media_inspection as mi  # noqa: E402

PW, PH = 96, 54
SR = 16000
FLASH_JUMP, FLASH_MAX = 35.0, 4
HOLD_BLOCK, HOLD_LAG, HOLD_THR, HOLD_MIN = 6, 0.5, 5.0, 0.75  # 6 proxy px is about 80 px at 720p
MICRO_F = 3
DISSOLVE_K = 6


def parse_spec(spec: str) -> tuple[str, float | None, float | None]:
    if "@" in spec and not Path(spec).exists():
        f, rng = spec.rsplit("@", 1)
        a, b = rng.split("-", 1)
        return f, float(a), float(b)
    return spec, None, None


def video_fps(path: str) -> float:
    out = io.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=avg_frame_rate",
                  "-of", "csv=p=0", path]).stdout
    out = out.decode() if isinstance(out, bytes) else out
    n, _, d = out.strip().partition("/")
    return float(n) / float(d or 1) if float(d or 1) else 24.0


def decode_rgb(path: str, a: float | None, b: float | None, w: int, h: int) -> np.ndarray:
    cut = ["-ss", str(a), "-to", str(b)] if a is not None else []
    raw = subprocess.run(io.resolve_cmd(["ffmpeg", "-nostdin", "-v", "error", *cut, "-i", path, "-vf",
                                         f"scale={w}:{h},format=rgb24", "-f", "rawvideo", "-"]),
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def colour_hists(rgb: np.ndarray) -> np.ndarray:
    """Normalised 512-bin colour histogram per frame."""
    q = (rgb // 32).astype(np.int32)
    idx = q[..., 0] * 64 + q[..., 1] * 8 + q[..., 2]
    hs = np.stack([np.bincount(i.ravel(), minlength=512) for i in idx]).astype(np.float32)
    return hs / hs.sum(1, keepdims=True)


def colour_hist_diff(rgb: np.ndarray, hs: np.ndarray | None = None) -> np.ndarray:
    """Half the L1 distance between consecutive 512-bin colour histograms: 0 same palette, 1 nothing shared."""
    hs = colour_hists(rgb) if hs is None else hs
    return np.abs(np.diff(hs, axis=0)).sum(1) / 2


def dissolve_spans(f: np.ndarray, hs: np.ndarray, cuts: list[int], k: int = DISSOLVE_K) -> list[tuple[int, int]]:
    """(middle frame, length) of candidate gradual transitions: frames i-k and i+k share little palette (histogram distance
    over 0.4), no hard cut lies between them, and frame i is close to the 50/50 mix of the two (the residual is
    under 35% of their difference). Fades to and from black count."""
    n = len(f)
    cand = []
    cs = set(cuts)
    for i in range(k, n - k):
        if any(c in cs for c in range(i - k + 1, i + k + 1)):
            continue
        dh = float(np.abs(hs[i + k] - hs[i - k]).sum() / 2)
        if dh < 0.4:
            continue
        diff = float(np.abs(f[i + k] - f[i - k]).mean())
        if diff < 12:
            continue
        resid = float(np.abs(f[i] - (f[i - k] + f[i + k]) / 2).mean())
        quart = float(np.abs(f[i - k // 2] - (0.75 * f[i - k] + 0.25 * f[i + k])).mean())
        if resid < 0.35 * diff and quart < 0.35 * diff:
            cand.append((resid / diff, i))
    keep: list[int] = []
    for _, i in sorted(cand):
        if all(abs(i - j) > 2 * k for j in keep):
            keep.append(i)
    return [(i, 2 * k) for i in sorted(keep)]


def decode_mono(path: str, a: float | None, b: float | None, sr: int = SR) -> np.ndarray:
    cut = ["-ss", str(a), "-to", str(b)] if a is not None else []
    raw = subprocess.run(io.resolve_cmd(["ffmpeg", "-nostdin", "-v", "error", *cut, "-i", path, "-map", "0:a:0",
                                         "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]),
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def flash_frames(luma: np.ndarray) -> list[tuple[int, int]]:
    """(first frame, length) of 1-4 frame runs whose mean luma jumps FLASH_JUMP over both sides and comes back."""
    out: list[tuple[int, int]] = []
    n, i = len(luma), 1
    while i < n - 1:
        hit = None
        for k in range(1, FLASH_MAX + 1):
            if i + k >= n:
                break
            run = luma[i:i + k]
            before, after = luma[i - 1], luma[i + k]
            if abs(after - before) < FLASH_JUMP / 2 and (
                    (run.min() - max(before, after) >= FLASH_JUMP) or (min(before, after) - run.max() >= FLASH_JUMP)):
                hit = k
                break
        if hit:
            out.append((i, hit))
            i += hit + 1
        else:
            i += 1
    return out


def cut_frames(f: np.ndarray, flashes: list[tuple[int, int]] | None = None, hd: np.ndarray | None = None) -> list[int]:
    """Frames that start a new shot.

    A cut is a frame difference 2.5x over the local motion (the median of non-duplicate differences 12 frames
    either side, so a drawing held on twos does not lower the bar) and over 12 luma, together with a colour
    histogram change 2x over its local median and over 0.15; or a histogram change over 0.6 on its own. A
    global threshold failed on fire, sparks and smear, where every frame differs from the last. The edges into
    and out of a flash are not cuts, and two cuts are at least 3 frames apart."""
    if len(f) < 2:
        return []
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    if hd is None:
        hd = np.zeros_like(d)
    skip: set[int] = set()
    for a, k in flashes or []:
        skip |= {a, a + k}
    cuts: list[int] = []
    for i in range(len(d)):
        if i + 1 in skip:
            continue
        lo, hi = max(0, i - 12), min(len(d), i + 13)
        nb = np.r_[d[lo:max(lo, i - 1)], d[i + 2:hi]]
        moving = nb[nb > 1.0]
        lm = float(np.median(moving if len(moving) else nb)) if len(nb) else 0.0
        nh = np.r_[hd[lo:max(lo, i - 1)], hd[i + 2:hi]]
        lh = float(np.median(nh)) if len(nh) else 0.0
        if (d[i] > max(2.5 * lm, 12) and hd[i] > max(2 * lh, 0.15)) or hd[i] > 0.6:
            if not cuts or i + 1 - cuts[-1] > 2:
                cuts.append(i + 1)
    for a, k in flashes or []:  # a flash that hides a cut: the frames on its two sides differ like a cut
        if a + k < len(f) and np.abs(f[a + k] - f[a - 1]).mean() > 30:
            cuts.append(a)
    return sorted(set(cuts))


def shot_lengths(cuts: list[int], n_frames: int, fps: float) -> list[float]:
    edges = [0] + [c for c in cuts if 0 < c < n_frames] + [n_frames]
    return [round((b - a) / fps, 3) for a, b in zip(edges, edges[1:]) if b > a]


def shot_stats(lengths: list[float], dur: float, fps: float = 24.0) -> dict:
    """Stats over the real shots; runs of MICRO_F frames or fewer are counted apart as micro cuts (impact frames,
    FX frames on ones, whip-pan blur), because they are beats inside a shot rather than shots of their own."""
    if not lengths:
        return {}
    allx = np.array(lengths)
    micro = allx <= MICRO_F / fps + 1e-6
    x = allx[~micro] if (~micro).any() else allx
    p10, p50, p90 = np.percentile(x, [10, 50, 90])
    return {"shots": int(len(x)), "micro": int(micro.sum()), "micro_share": round(float(allx[micro].sum() / dur), 3) if dur else 0.0,
            "asl": round(float(x.mean()), 2), "median": round(float(p50), 2),
            "p10": round(float(p10), 2), "p90": round(float(p90), 2),
            "cuts_per_min": round((len(x) - 1) / dur * 60, 1) if dur else 0.0,
            "under_1s": round(float((x < 1).mean()), 2), "1_to_3s": round(float(((x >= 1) & (x <= 3)).mean()), 2),
            "over_3s": round(float((x > 3).mean()), 2)}


def hold_runs(f: np.ndarray, fps: float, min_s: float = HOLD_MIN) -> list[tuple[float, float]]:
    """(start s, length s) of stretches where the picture barely changes over HOLD_LAG."""
    n = len(f)
    lag = max(1, int(round(HOLD_LAG * fps)))
    if n <= lag:
        return []
    h, w = f.shape[1] // HOLD_BLOCK * HOLD_BLOCK or f.shape[1], f.shape[2] // HOLD_BLOCK * HOLD_BLOCK or f.shape[2]
    b = min(HOLD_BLOCK, f.shape[1], f.shape[2])
    g = f[:, :h, :w].reshape(n, h // b, b, w // b, b).mean(axis=(2, 4))
    still = np.abs(g[lag:] - g[:-lag]).mean(axis=(1, 2)) < HOLD_THR
    out, i = [], 0
    while i < len(still):
        if still[i]:
            j = i
            while j < len(still) and still[j]:
                j += 1
            ln = (j - i + lag) / fps
            if ln >= min_s:
                out.append((round(i / fps, 2), round(ln, 2)))
            i = j
        else:
            i += 1
    return out


def envelope_db(x: np.ndarray, sr: int, win: float = 0.01) -> np.ndarray:
    k = max(1, int(sr * win))
    n = len(x) // k
    if not n:
        return np.zeros(0)
    return 20 * np.log10(np.sqrt((x[:n * k].astype(np.float64).reshape(n, k) ** 2).mean(1)) + 1e-9)


def find_hits(env: np.ndarray, win: float = 0.01, top: int = 12, rise_db: float = 12.0) -> list[int]:
    """Indexes of the strongest onsets: the envelope rises rise_db over the 150 ms before it; one per 250 ms."""
    look, gap = int(0.15 / win), int(0.25 / win)
    cand = []
    for i in range(look, len(env)):
        if env[i] - env[i - look:i].min() >= rise_db and env[i] >= env[max(0, i - 2):i + 3].max() - 1e-9:
            cand.append(i)
    cand.sort(key=lambda i: -env[i])
    keep: list[int] = []
    for i in cand:
        if all(abs(i - j) > gap for j in keep):
            keep.append(i)
        if len(keep) >= top:
            break
    return sorted(keep)


def hit_features(x: np.ndarray, sr: int, env: np.ndarray, i: int, win: float = 0.01) -> dict:
    pre_a, pre_b, base = int(1.0 / win), int(0.15 / win), int(3.0 / win)
    near = env[max(0, i - pre_a):max(0, i - pre_b)]
    far = env[max(0, i - pre_a - base):max(0, i - pre_a)]
    dip = float(np.median(far) - np.median(near)) if len(near) and len(far) else 0.0
    j = i
    while j < len(env) and env[j] > env[i] - 20:
        j += 1
    s0 = int(i * win * sr)
    seg = x[s0:s0 + int(0.25 * sr)].astype(np.float64)
    sub = -99.0
    if len(seg) > 64:
        p = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
        fq = np.fft.rfftfreq(len(seg), 1 / sr)
        sub = float(10 * np.log10(p[fq < 120].sum() / (p.sum() + 1e-12) + 1e-12))
    return {"t": round(i * win, 2), "level_db": round(float(env[i]), 1), "dip_db": round(dip, 1),
            "sub_db": round(sub, 1), "tail_s": round((j - i) * win, 2)}


def nearest_cut(t: float, cut_times: list[float], fps: float) -> int | None:
    if not cut_times:
        return None
    c = min(cut_times, key=lambda c: abs(c - t))
    return int(round((t - c) * fps))


def block_levels(x: np.ndarray, sr: int) -> dict:
    w = int(0.4 * sr)
    n = len(x) // w
    if n < 3:
        return {}
    blk = 10 * np.log10((x[:n * w].astype(np.float64).reshape(n, w) ** 2).mean(1) + 1e-12)
    act = blk[blk > blk.max() - 50]
    p10, p50, p90 = np.percentile(act, [10, 50, 90])
    return {"p10": round(float(p10), 1), "p50": round(float(p50), 1), "p90": round(float(p90), 1)}


def shot_sheet(path: str, a: float | None, cuts: list[int], lengths: list[float], fps: float, out: Path) -> None:
    mids = []
    edges = [0] + cuts
    for k, ln in enumerate(lengths):
        mids.append(edges[k] + max(0, int(ln * fps / 2)))
    cols = 8
    rows = max(1, math.ceil(len(mids) / cols))
    sel = "+".join(f"eq(n\\,{m})" for m in mids)
    labels = ",".join(f"drawtext=text='{k + 1} {ln:.1f}s':x=6:y=6:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6:"
                      f"enable='eq(n\\,{k})'" for k, ln in enumerate(lengths))
    cut = ["-ss", str(a)] if a is not None else []
    vf = f"select='{sel}',setpts=N/TB,scale=240:-2,{labels},tile={cols}x{rows}:padding=3"
    script = out.with_suffix(".filter.txt")
    script.write_text(vf, encoding="utf-8")
    try:
        io.run(["ffmpeg", "-v", "error", "-y", *cut, "-i", path, "-filter_script:v", str(script), "-frames:v", "1",
                "-vsync", "0", "-q:v", "5", str(out)])
    except subprocess.CalledProcessError:  # drawtext needs a font build; fall back to an unlabelled grid
        script.write_text(f"select='{sel}',setpts=N/TB,scale=240:-2,tile={cols}x{rows}:padding=3", encoding="utf-8")
        io.run(["ffmpeg", "-v", "error", "-y", *cut, "-i", path, "-filter_script:v", str(script), "-frames:v", "1",
                "-vsync", "0", "-q:v", "5", str(out)])
    finally:
        script.unlink(missing_ok=True)


def measure(path: str, a: float | None, b: float | None, top: int = 12, sheet_dir: Path | None = None) -> dict:
    fps = video_fps(path)
    rgb = decode_rgb(path, a, b, PW, PH)
    f = rgb.astype(np.float32).mean(axis=3)
    luma = f.mean(axis=(1, 2))
    fl = flash_frames(luma)
    hs = colour_hists(rgb)
    cuts = cut_frames(f, fl, colour_hist_diff(rgb, hs))
    del rgb
    dis = dissolve_spans(f, hs, cuts)
    dur = len(f) / fps
    lengths = shot_lengths(cuts, len(f), fps)
    d = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2)) if len(f) > 1 else np.zeros(1)
    edges = [0] + cuts + [len(f)]
    motion = [round(float(d[s:max(s + 1, e - 1)].mean()), 1) for s, e in zip(edges, edges[1:]) if e > s]
    holds = hold_runs(f, fps)
    row = {"file": path, "span": None if a is None else [a, b], "fps": round(fps, 3), "dur": round(dur, 2),
           **shot_stats(lengths, dur, fps), "shot_lengths": lengths, "shot_motion": motion,
           "cut_times": [round(c / fps, 3) for c in cuts],
           "dissolves": [{"t": round(i / fps, 2), "frames": k} for i, k in dis],
           "flashes": [{"t": round(s / fps, 2), "frames": k} for s, k in fl],
           "holds": [{"t": t, "len": ln} for t, ln in holds],
           "held_share": round(sum(ln for _, ln in holds) / dur, 2) if dur else 0.0}
    try:
        x = decode_mono(path, a, b)
    except subprocess.CalledProcessError:
        x = np.zeros(0, np.float32)
    if len(x):
        env = envelope_db(x, SR)
        ct = row["cut_times"]
        hits, rise = [], 12.0
        idx = find_hits(env, top=top, rise_db=rise)
        if len(idx) < max(1, top // 2):  # a dense, compressed mix: transients rise less over their lead-in
            rise = 6.0
            idx = find_hits(env, top=top, rise_db=rise)
        row["hit_rise_db"] = rise
        for i in idx:
            h = hit_features(x, SR, env, i)
            h["cut_f"] = nearest_cut(h["t"], ct, fps)
            h["flash"] = any(abs(h["t"] - fx["t"]) * fps <= 3 for fx in row["flashes"])
            hits.append(h)
        row.update({"levels": block_levels(x, SR), "hits": hits})
        if a is None:
            row["loudness"] = mi.loudness(Path(path))
    if sheet_dir is not None and lengths:
        sheet_dir.mkdir(parents=True, exist_ok=True)
        shot_sheet(path, a, cuts, lengths, fps, sheet_dir / f"{Path(path).stem}-shots.jpg")
    return row


def summary(r: dict) -> str:
    ld = r.get("loudness") or {}
    hits = r.get("hits") or []
    on_cut = sum(1 for h in hits if h.get("cut_f") is not None and abs(h["cut_f"]) <= 2)
    chance = len(hits) * min(1.0, 5 / (r["dur"] / max(1, len(r["cut_times"]) + 1) * r["fps"])) if r["dur"] else 0.0
    dips = sum(1 for h in hits if h["dip_db"] >= 6)
    return (f"{Path(r['file']).name[:34]:34s} {r['dur']:7.1f}s  shots {r.get('shots', 0):4d}  ASL {r.get('asl', 0):5.2f}  "
            f"med {r.get('median', 0):5.2f}  micro {r.get('micro', 0):3d}  cuts/min {r.get('cuts_per_min', 0):5.1f}  <1s {r.get('under_1s', 0):.2f}  "
            f">3s {r.get('over_3s', 0):.2f}  dissolves {len(r.get('dissolves', []))}  "
            f"flashes {len(r['flashes'])}  held {r['held_share']:.2f}  "
            f"I {ld.get('I_lufs')}  LRA {ld.get('LRA_lu')}  hits on cut(+-2f) {on_cut}/{len(hits)} (chance {chance:.1f})  "
            f"on flash {sum(1 for h in hits if h.get('flash'))}  dips>=6dB {dips}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("specs", nargs="+")
    ap.add_argument("--json")
    ap.add_argument("--sheet", help="directory for one shot-grid jpg per file")
    ap.add_argument("--hits", type=int, default=12, help="how many of the strongest transients to report")
    a = ap.parse_args()
    rows = []
    for spec in a.specs:
        f, s0, s1 = parse_spec(spec)
        r = measure(f, s0, s1, a.hits, Path(a.sheet) if a.sheet else None)
        rows.append(r)
        print(summary(r))
    if a.json:
        io.save_json(a.json, rows, indent=1)


if __name__ == "__main__":
    main()
