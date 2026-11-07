#!/usr/bin/env python3
"""Per-shot bus levels and an ambience masking gate for one or more scenes, built exactly as the mixer builds them
(events, reverb sends, ducks, bus fx, bus trims; before the master loudnorm).

usage: uv run -q --with numpy python -X utf8 audit-mix-buses.py <episode-dir> <scene>... [--events FILE] [--edl edl.en.json]
         [--allow s19,s18] [--min-mask 60] [--max-under-music 6] [--min-vo-over-beds 6] [--json]
         [--premix-wav OUT.wav] [--stem beds T0 T1 OUT.wav]

Per shot it prints RMS dBFS of beds, hits, vo, music, then three numbers measured where they matter:
  mask%   share of 100 ms windows OUTSIDE dialogue where beds >= (beds+music+vo) - 10 dB, the bed not buried
          (hits are left out: an impact may cover the room for a moment)
  b-m     beds minus music outside dialogue (dB)
  vo-b    vo minus beds where a dialogue line is actually voiced (dB)
Gate (exit 1 on a failure; shots in --allow are intentional silences and skip it):
  mask% >= --min-mask, b-m >= -(--max-under-music), vo-b >= --min-vo-over-beds, and a bed exists (> -70 dBFS).
FRONTIER EP01 cut 2 failed "nghe ra môi trường" with beds 10-15 dB under the music and shots with no bed; the
sc03 masking shares were 3-41%. This gate is necessary, not sufficient: cut 3 passed it and two QA agents, and
the user still heard a thin room. Send him the beds stem (--stem) or the scene before calling sound done.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

SCRIPTS = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("build_audio_mix", SCRIPTS / "build-audio-mix.py")
mixer = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mixer)
io, episode_timeline, BUSES = mixer.io, mixer.episode_timeline, mixer.BUSES
WIN = 0.1


def build_buses(ep: Path, cfg: dict, rows: list[dict], sr: int) -> dict[str, np.ndarray]:
    n = int(round(sum(r["duration"] for r in rows) * sr))
    presets = cfg.get("presets", {})
    evs, ducks = mixer.gather(ep, cfg, rows)
    buses = {b: np.zeros((n, 2), np.float32) for b in BUSES}
    sends: dict[tuple[str, str], np.ndarray] = {}
    space_of = getattr(mixer, "space_of", None)  # reverb sends exist only in mixers that define spaces
    for e in evs:
        f = Path(e["file"]) if Path(e["file"]).is_absolute() else ep / e["file"]
        if not f.exists():
            continue
        fx = presets.get(e.get("fx", ""), e.get("fx", ""))
        clip = mixer.load(f, e.get("offset", 0), e.get("len"), fx, sr)
        space, send = space_of(e, cfg) if space_of else (None, None)
        if space:
            key = (space, e.get("bus", "beds"))
            sends.setdefault(key, np.zeros((n, 2), np.float32))
            mixer.place(sends[key], clip.copy(), e["abs"], e.get("gain", 0) + send, e.get("fade_in", 0), e.get("fade_out", 0),
                        e.get("pan", 0), sr)
        mixer.place(buses[e.get("bus", "beds")], clip, e["abs"], e.get("gain", 0), e.get("fade_in", 0), e.get("fade_out", 0),
                    e.get("pan", 0), sr)
    for (space, b), wet in sends.items():
        ir = mixer.load(ep / cfg["spaces"][space]["ir"], 0, None, "", sr)
        buses[b] += mixer.convolve(wet, ir) * 10 ** (cfg["spaces"][space].get("return_db", 0) / 20)
    for b in BUSES:
        if ducks[b]:
            att, rel = (0.02, 0.18) if b == "hits" else (0.04, 0.22)
            buses[b] *= mixer.curve(ducks[b], n, sr, att, rel)[:, None]
    for b, chain in (cfg.get("bus_fx") or {}).items():
        if b in buses and chain:
            buses[b] = mixer.bus_fx(buses[b], chain, sr)
    trim = {**{b: 0.0 for b in BUSES}, **cfg.get("bus_trim_db", {})}
    for b in BUSES:
        buses[b] *= 10 ** (trim[b] / 20)
    return buses


def window_db(x: np.ndarray, w: int) -> np.ndarray:
    """RMS dBFS of consecutive windows of w samples (stereo summed to power)."""
    k = len(x) // w
    if k == 0:
        return np.zeros(0)
    p = (x[: k * w].astype(np.float64) ** 2).reshape(k, w, -1).mean(axis=(1, 2))
    return 10 * np.log10(p + 1e-18)


def rms_db(x: np.ndarray) -> float:
    return float(10 * np.log10((x.astype(np.float64) ** 2).mean() + 1e-18)) if len(x) else -120.0


def shot_stats(buses: dict[str, np.ndarray], total: np.ndarray, i: int, j: int, speech: np.ndarray, sr: int) -> dict:
    """total: beds + music + vo (no hits); speech: bool per window of the timeline (True = a dialogue line runs)."""
    w = int(WIN * sr)
    a, b = i // w, j // w
    beds_w, tot_w = window_db(buses["beds"][a * w:b * w], w), window_db(total[a * w:b * w], w)
    mus_w, vo_w = window_db(buses["music"][a * w:b * w], w), window_db(buses["vo"][a * w:b * w], w)
    sp = speech[a:b][: len(beds_w)]
    out = {k: round(rms_db(buses[k][i:j]), 1) for k in BUSES}
    quiet = ~sp
    live = tot_w > -70  # windows that are not silence
    q = quiet & live
    out["mask_pct"] = round(float(np.mean(beds_w[q] >= tot_w[q] - 10) * 100), 0) if q.any() else None
    pw = lambda d: 10 * np.log10(np.mean(10 ** (d / 10)) + 1e-18)  # noqa: E731 - power mean of window dBs
    out["beds_minus_music"] = round(float(pw(beds_w[q]) - pw(mus_w[q])), 1) if q.any() and (mus_w[q] > -70).any() else None
    voiced = sp & (vo_w > -70)  # the dialogue padding can spill into a shot with no voice
    out["vo_minus_beds"] = round(float(pw(vo_w[voiced]) - pw(beds_w[voiced])), 1) if voiced.any() else None
    return out


def gate(st: dict, *, min_mask: float, max_under: float, min_vo: float) -> list[str]:
    bad = []
    if st["beds"] < -70:
        bad.append("no bed")
    if st["mask_pct"] is not None and st["mask_pct"] < min_mask:
        bad.append(f"mask {st['mask_pct']:.0f}% < {min_mask:.0f}%")
    if st["beds_minus_music"] is not None and st["beds_minus_music"] < -max_under:
        bad.append(f"beds {st['beds_minus_music']:+.1f} dB under music")
    if st["vo_minus_beds"] is not None and st["vo_minus_beds"] < min_vo:
        bad.append(f"vo only {st['vo_minus_beds']:+.1f} dB over beds")
    return bad


def write_wav(path: Path, x: np.ndarray, sr: int, af: str = "") -> None:
    mixer.ff(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "-"] + (["-af", af] if af else [])
             + ["-ar", str(sr), "-c:a", "pcm_s16le", str(path)], x.astype(np.float32).tobytes())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episode")
    ap.add_argument("scenes", nargs="+")
    ap.add_argument("--events", help="another mix-events file (a proposal before merging)")
    ap.add_argument("--edl", help="dialogue from scenes/<sc>/<EDL> (a dubbed track, e.g. edl.en.json), as the mixer's --edl")
    ap.add_argument("--allow", default="", help="shot ids that are silent on purpose")
    ap.add_argument("--min-mask", type=float, default=60)
    ap.add_argument("--max-under-music", type=float, default=6)
    ap.add_argument("--min-vo-over-beds", type=float, default=6)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--premix-wav", help="write the (single) scene premix at -14 LUFS for listening")
    ap.add_argument("--stem", nargs=4, metavar=("BUS", "T0", "T1", "OUT"), help="write one bus between scene times, peak 0.7")
    a = ap.parse_args()
    ep = Path(a.episode).expanduser().resolve()
    cfg = io.load_json(Path(a.events) if a.events else ep / "audio" / "mix-events.json")
    sr = int(cfg.get("sample_rate", 48000))
    allow = {s for s in a.allow.split(",") if s}
    report, fails = {}, []
    for sc in a.scenes:
        rows = [r for r in episode_timeline(ep) if r["scene"] == sc]
        if not rows:
            sys.exit(f"{sc}: not in episode.json")
        alt = ep / "scenes" / sc / a.edl if a.edl else None
        if alt and alt.exists():  # a dubbed track: its dialogue windows, the picture's shot timing
            rows[0]["edl"] = io.load_json(alt)
        buses = build_buses(ep, cfg, rows, sr)
        shots = rows[0]["edl"]["shots"]
        w = int(WIN * sr)
        speech = np.zeros(len(buses["beds"]) // w + 1, bool)
        for s in shots:
            for line in s.get("dialogue") or []:
                speech[int((line["t0"] - 0.05) / WIN):int((line["t1"] + 0.1) / WIN) + 1] = True
        total = buses["beds"] + buses["music"] + buses["vo"]
        rep = {}
        if not a.json:
            print(f"{sc}: RMS dBFS pre-master   beds   hits     vo  music | mask%   b-m   vo-b")
        for s in shots:
            st = shot_stats(buses, total, int(s["start"] * sr), int(s["end"] * sr), speech, sr)
            st["fail"] = [] if s["id"] in allow else gate(st, min_mask=a.min_mask, max_under=a.max_under_music, min_vo=a.min_vo_over_beds)
            rep[s["id"]] = st
            fails += [f"{sc} {s['id']}: {x}" for x in st["fail"]]
            if not a.json:
                f = lambda v, fmt: "   -  " if v is None else format(v, fmt)  # noqa: E731
                print(f"{s['id']:>10} {s['start']:7.2f}-{s['end']:7.2f} " + " ".join(f"{st[b]:6.1f}" for b in BUSES)
                      + f" | {f(st['mask_pct'], '5.0f')} {f(st['beds_minus_music'], '+5.1f')} {f(st['vo_minus_beds'], '+5.1f')}"
                      + ("  ALLOWED" if s["id"] in allow else ("  <- " + "; ".join(st["fail"]) if st["fail"] else "")))
        report[sc] = rep
        if a.premix_wav and len(a.scenes) == 1:
            write_wav(Path(a.premix_wav), sum(buses[b] for b in BUSES), sr, "loudnorm=I=-14:TP=-1.5:LRA=20")
            print("wrote", a.premix_wav)
        if a.stem and len(a.scenes) == 1:
            bus, t0, t1, out = a.stem[0], float(a.stem[1]), float(a.stem[2]), Path(a.stem[3])
            x = buses[bus][int(t0 * sr):int(t1 * sr)]
            write_wav(out, x / (np.abs(x).max() + 1e-9) * 0.7, sr)
            print("wrote", out)
    if a.json:
        print(json.dumps({"scenes": report, "fails": fails}, ensure_ascii=False, indent=1))
    elif fails:
        print(f"GATE FAIL ({len(fails)}):\n  " + "\n  ".join(fails))
    else:
        print("GATE PASS (numbers only: the user's ear is the real gate)")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
