#!/usr/bin/env python3
"""Lay a TTS take onto an Omni clip's lip motion. Omni acts and speaks the line itself (its audio is then discarded);
its speech segments give the timing, and the chosen TTS take is cut into phrases, paired with Omni's in order and
time-stretched (atempo, clamped) onto them. Given several takes, the one needing the least stretching wins.

usage: uv run --with numpy python -X utf8 align-vo-to-omni.py <omni.mp4> <out.wav> <take.wav> [<take2.wav> ...]
       [--omni-words stt.json] [--tts-words-dir DIR] [--window IN,OUT] [--clamp 0.15] [--close-gaps 0.12]
       [--keep-lead 0.5] [--keep-tail 0.8] [--max-slow 0.1] [--json report.json]

Segments:
- Omni: from speech-to-text word timings when --omni-words is given (an ElevenLabs Scribe json, `multix elevenlabs
  transcribe --format json`). An energy VAD hears thunder, SFX and breaths in Omni's track as speech. When Omni only
  shouts or breathes, STT returns no words: leave --omni-words out and the band-passed energy VAD is used.
- Takes: from their own STT words when <tts-words-dir>/<take stem>.json exists (a breath before the line is then
  not speech), else from the VAD with shorter and shorter pause thresholds until the counts match.
- --window keeps only Omni speech inside the clip range the edit uses (`in` to `in + shot length`).

Options: --close-gaps G cuts every pause inside a merged TTS phrase down to G s (the take pauses where Omni speaks in
one breath); --keep-lead / --keep-tail play that much before the first word / after the last word unstretched (the
breath in, a laugh after); --max-slow lets the clip play up to that much slower when no take fits (report
`video_speed`; set the shot's `speed` to it).

Output: a mono wav, clip-relative (sample 0 = clip time `start`, in the slowed clip's playback time) and a report
with `worst_end_err_frames` and `within_3_frames` (the gate: every phrase ends within 3 frames at 24 fps).
Placing it in the shot: head = max(0, in / speed - start); trim `head` seconds off the front of the wav (never clamp
a negative t0 to 0, which shifts every word late) and set the line's t0 = shot start + start + head - in / speed.
Then bring the wav to the picks' loudness (-18 LUFS for FRONTIER) and re-run the `align` job or the caption words.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402

SR, HOP, WIN = 48000, 0.01, 0.05
FRAME = 1 / 24


def ffmpeg(args: list[str], data: bytes | None = None) -> bytes:
    return subprocess.run(io.resolve_cmd(["ffmpeg", "-nostdin", "-v", "error", "-y"] + args), input=data,
                          capture_output=True, check=True).stdout


def load(p, band: bool = True) -> np.ndarray:
    af = ["-af", "highpass=f=250,lowpass=f=3800"] if band else []
    return np.frombuffer(ffmpeg(["-i", str(p), *af, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]), np.float32)


def segments(x: np.ndarray, gap: float = 0.2, min_len: float = 0.12) -> list[list[float]]:
    """Speech segments from an RMS envelope: over 35% of the way from the floor to the peak (and within 30 dB)."""
    hop, win = int(SR * HOP), int(SR * WIN)
    n = max(1, (len(x) - win) // hop + 1)
    rms = np.array([np.sqrt(np.mean(x[i * hop:i * hop + win] ** 2) + 1e-12) for i in range(n)])
    db = 20 * np.log10(rms)
    floor, peak = np.percentile(db, 10), np.percentile(db, 99)
    on = db > max(floor + 0.35 * (peak - floor), peak - 30)
    segs, i = [], 0
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]:
                j += 1
            segs.append([i * HOP, j * HOP + WIN])
            i = j
        else:
            i += 1
    merged: list[list[float]] = []
    for s in segs:
        if merged and s[0] - merged[-1][1] < gap:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    return [s for s in merged if s[1] - s[0] >= min_len]


def stretch(chunk: np.ndarray, ratio: float, tmp: str) -> np.ndarray:
    """ratio = new_len / old_len."""
    src, dst = Path(tmp) / "a.f32", Path(tmp) / "b.f32"
    chunk.astype(np.float32).tofile(src)
    ffmpeg(["-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", str(src), "-af", f"atempo={1 / ratio:.5f}", "-f", "f32le", str(dst)])
    return np.fromfile(dst, np.float32)


def has_words(stt_path) -> bool:
    return any(w.get("type", "word") == "word" for w in io.load_json(stt_path).get("words", []))


def word_segments(stt_path, gap: float = 0.2) -> list[list[float]]:
    segs: list[list[float]] = []
    for w in io.load_json(stt_path).get("words", []):
        if w.get("type", "word") != "word":
            continue
        if segs and w["start"] - segs[-1][1] < gap:
            segs[-1][1] = w["end"]
        else:
            segs.append([w["start"], w["end"]])
    return segs


def merge_groups(segs, n):
    """Merge the two neighbours with the smallest gap until n segments remain; each keeps its sub-phrases."""
    groups = [[list(s)] for s in segs]
    while len(groups) > n:
        k = min(range(len(groups) - 1), key=lambda i: groups[i + 1][0][0] - groups[i][-1][1])
        groups[k:k + 2] = [groups[k] + groups[k + 1]]
    return groups


def pair_up(o_segs, t_segs):
    n = min(len(o_segs), len(t_segs))
    return list(zip(merge_groups(t_segs, n), [[g[0][0], g[-1][1]] for g in merge_groups(o_segs, n)]))


def spoken_len(group, close: float) -> float:
    """Length of a merged TTS phrase once its inner pauses are cut to `close` s (0 = pauses kept)."""
    full = group[-1][1] - group[0][0]
    return full if not close else full - sum(max(0.0, b[0] - a[1] - close) for a, b in zip(group, group[1:]))


def cost(pairs, clamp: float, close: float) -> float:
    """Total log-stretch plus a heavy charge for any stretch the clamp cannot reach."""
    c = 0.0
    for tg, os_ in pairs:
        r = abs(np.log((os_[1] - os_[0]) / spoken_len(tg, close)))
        c += r + 4 * max(0.0, r - np.log(1 + clamp))
    return c


def phrase_audio(x: np.ndarray, group, pad: float, close: float) -> np.ndarray:
    """The merged phrase's audio with every inner pause longer than `close` cut to it (10 ms crossfade)."""
    a0, a1 = max(0.0, group[0][0] - pad), min(len(x) / SR, group[-1][1] + pad)
    if not close or len(group) == 1:
        return x[int(a0 * SR):int(a1 * SR)]
    xf = int(0.01 * SR)
    pieces, cur = [], a0
    for a, b in zip(group, group[1:]):
        if b[0] - a[1] > close:
            pieces.append(x[int(cur * SR):int((a[1] + close / 2) * SR)])
            cur = b[0] - close / 2
    pieces.append(x[int(cur * SR):int(a1 * SR)])
    out = pieces[0].copy()
    ramp = np.linspace(0, 1, xf, dtype=np.float32)
    for piece in pieces[1:]:
        out[-xf:] = out[-xf:] * (1 - ramp) + piece[:xf] * ramp
        out = np.concatenate([out, piece[xf:]])
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("omni"); ap.add_argument("out"); ap.add_argument("tts", nargs="+")
    ap.add_argument("--omni-words", help="Scribe json of the clip's audio; ignored when it has no words (a shout)")
    ap.add_argument("--window", help="IN,OUT clip seconds the edit uses")
    ap.add_argument("--clamp", type=float, default=0.15, help="largest stretch either way (0.15 = 0.85x..1.15x)")
    ap.add_argument("--json")
    ap.add_argument("--tts-words-dir"); ap.add_argument("--keep-lead", type=float, default=0.0)
    ap.add_argument("--close-gaps", type=float, default=0.0); ap.add_argument("--keep-tail", type=float, default=0.0)
    ap.add_argument("--max-slow", type=float, default=0.0,
                    help="also try playing the clip up to this much slower (0.15 = down to 0.85x) when no take fits")
    a = ap.parse_args()
    out_p = Path(a.out)
    if out_p.exists():
        sys.exit(f"{out_p} exists: aligned takes are never overwritten, pick a new name")
    o_segs = word_segments(a.omni_words) if a.omni_words and has_words(a.omni_words) else segments(load(a.omni))
    if a.window:
        w0, w1 = map(float, a.window.split(","))
        o_segs = [[max(s[0], w0), min(s[1], w1)] for s in o_segs if s[1] > w0 and s[0] < w1]
    speeds = [s for s in (1.0, 0.95, 0.9, 0.85) if s >= 1 - a.max_slow - 1e-9]
    takes = []
    for t in a.tts:
        tw = Path(a.tts_words_dir) / f"{Path(t).stem}.json" if a.tts_words_dir else None
        if tw and tw.exists() and has_words(tw):
            t_segs = word_segments(tw)
        else:
            x = load(t)
            for g in (0.2, 0.12, 0.08, 0.05):  # a take that runs phrases together: shorter pauses until counts match
                t_segs = segments(x, gap=g)
                if len(t_segs) >= len(o_segs):
                    break
        if not (o_segs and t_segs):
            continue
        for sp in speeds:  # playback time of the slowed clip; slowing costs a little so 1.0x wins unless it buys a fit
            pairs = pair_up([[s0 / sp, s1 / sp] for s0, s1 in o_segs], t_segs)
            takes.append((cost(pairs, a.clamp, a.close_gaps) + 2 * (1 - sp), t, t_segs, pairs, sp))
    if not takes:
        sys.exit(f"no speech found: omni {len(o_segs)} segments, no take with speech")
    takes.sort(key=lambda x: x[0])
    _, take, t_segs, pairs, speed = takes[0]
    tts_full = load(take, band=False)
    lo, hi, pad = 1 - a.clamp, 1 + a.clamp, 0.03
    ts0 = pairs[0][0][0][0]
    lead = tts_full[int(max(0.0, ts0 - a.keep_lead) * SR):int(max(0.0, ts0 - pad) * SR)] if a.keep_lead else tts_full[:0]
    start = max(0.0, pairs[0][1][0] - pad - len(lead) / SR)
    out = np.zeros(int(SR * (pairs[-1][1][1] - start + 1.0)), np.float32)
    if len(lead):
        i1 = int(max(0.0, pairs[0][1][0] - pad - start) * SR)
        out[max(0, i1 - len(lead)):i1] += lead[len(lead) - min(len(lead), i1):]  # a lead before the clip is trimmed
    rep = []
    with tempfile.TemporaryDirectory() as tmp:
        end = len(tts_full) / SR
        for k, (tg, os_) in enumerate(pairs):
            chunk = phrase_audio(tts_full, tg, pad, a.close_gaps)
            spoken = spoken_len(tg, a.close_gaps)
            want = (os_[1] - os_[0]) / spoken
            ratio = min(hi, max(lo, want))
            y = stretch(chunk, ratio, tmp) if abs(ratio - 1) > 0.01 else chunk
            if a.keep_tail and k == len(pairs) - 1:
                y = np.concatenate([y, tts_full[int(min(end, tg[-1][1] + pad) * SR):int(min(end, tg[-1][1] + a.keep_tail) * SR)]])
            i0 = int(max(0.0, os_[0] - pad - start) * SR)
            if i0 + len(y) > len(out):
                out = np.concatenate([out, np.zeros(i0 + len(y) - len(out), np.float32)])
            out[i0:i0 + len(y)] += y
            rep.append({"seg": k, "omni": [round(os_[0], 3), round(os_[1], 3)], "tts": [round(tg[0][0], 3), round(tg[-1][1], 3)],
                        "spoken": round(spoken, 3), "ratio": round(ratio, 3), "wanted": round(want, 3),
                        "end_err_frames": round((spoken * ratio - (os_[1] - os_[0])) / FRAME, 1)})
    voiced = np.nonzero(np.abs(out) > 1e-4)[0]
    out = out[:voiced[-1] + int(0.25 * SR)] if len(voiced) else out
    peak = float(np.max(np.abs(out)) or 1)
    if peak > 0.99:
        out *= 0.99 / peak
    out_p.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg(["-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", "-c:a", "pcm_s16le", str(out_p)], out.tobytes())
    worst = max(abs(r["end_err_frames"]) for r in rep)
    report = {"omni": a.omni, "tts": take, "out": a.out, "video_speed": speed, "start": round(start, 3),
              "omni_segs": len(o_segs), "tts_segs": len(t_segs), "worst_end_err_frames": worst,
              "within_3_frames": worst <= 3, "takes_ranked": [[round(c, 3), t, sp] for c, t, _, _, sp in takes[:8]], "pairs": rep}
    if a.json:
        io.save_json(a.json, report, indent=1)
    print(json.dumps({k: v for k, v in report.items() if k != "pairs"}, ensure_ascii=False))
    for r in rep:
        print("  ", r)


if __name__ == "__main__":
    main()
