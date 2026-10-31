"""mix-buses: per-shot bus levels and an ambience masking check, measured on the bus stems before the master
loudness pass.

Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/audit-mix-buses.py. The source
rebuilt the buses itself from mix-events.json with its own mixer; here the renderer's mix provides the four
stems (beds, hits, vo, music; a missing stem is silence) and this tool only measures them. The measurements
and the per-shot check are unchanged:

  mask%   share of 100 ms windows OUTSIDE dialogue where beds >= (beds+music+vo) - 10 dB, the bed not buried
          (hits are left out: an impact may cover the room for a moment)
  b-m     beds minus music outside dialogue (dB)
  vo-b    vo minus beds where a dialogue line is actually voiced (dB)
  check   mask% >= minMaskPct, b-m >= -maxUnderMusicDb, vo-b >= minVoOverBedsDb, and a bed exists (> -70 dBFS);
          shots in `allow` are intentional silences and skip it

The check is necessary, not sufficient (a mix that passed it still sounded thin to its listener), so its
result is evidence for a human listener, not a gate.
"""
from __future__ import annotations

import numpy as np

from .ff import decode_audio
from .sandbox import Deadline, Media, ToolError

BUSES = ("beds", "hits", "vo", "music")
WIN = 0.1


def window_db(x: np.ndarray, w: int) -> np.ndarray:
    """RMS dBFS of consecutive windows of w samples (stereo summed to power)."""
    k = len(x) // w
    if k == 0:
        return np.zeros(0)
    p = (x[: k * w].astype(np.float64) ** 2).reshape(k, w, -1).mean(axis=(1, 2))
    return 10 * np.log10(p + 1e-18)


def rms_db(x: np.ndarray) -> float:
    return float(10 * np.log10((x.astype(np.float64) ** 2).mean() + 1e-18)) if len(x) else -120.0


def _power_mean_db(d: np.ndarray) -> float:
    return float(10 * np.log10(np.mean(10 ** (d / 10)) + 1e-18))


def shot_stats(buses: dict[str, np.ndarray], total: np.ndarray, i: int, j: int, speech: np.ndarray, sr: int) -> dict:
    """total: beds + music + vo (no hits); speech: bool per window of the timeline (True = a dialogue line runs)."""
    w = int(WIN * sr)
    a, b = i // w, j // w
    beds_w, tot_w = window_db(buses["beds"][a * w:b * w], w), window_db(total[a * w:b * w], w)
    mus_w, vo_w = window_db(buses["music"][a * w:b * w], w), window_db(buses["vo"][a * w:b * w], w)
    sp = speech[a:b][: len(beds_w)]
    out: dict = {k: round(rms_db(buses[k][i:j]), 1) for k in BUSES}
    quiet = ~sp
    live = tot_w > -70  # windows that are not silence
    q = quiet & live
    out["maskPct"] = round(float(np.mean(beds_w[q] >= tot_w[q] - 10) * 100), 0) if q.any() else None
    out["bedsMinusMusic"] = (round(_power_mean_db(beds_w[q]) - _power_mean_db(mus_w[q]), 1)
                             if q.any() and (mus_w[q] > -70).any() else None)
    voiced = sp & (vo_w > -70)  # the dialogue padding can spill into a shot with no voice
    out["voMinusBeds"] = (round(_power_mean_db(vo_w[voiced]) - _power_mean_db(beds_w[voiced]), 1)
                          if voiced.any() else None)
    return out


def gate(st: dict, *, min_mask: float, max_under: float, min_vo: float) -> list[str]:
    bad = []
    if st["beds"] < -70:
        bad.append("no bed")
    if st["maskPct"] is not None and st["maskPct"] < min_mask:
        bad.append(f"mask {st['maskPct']:.0f}% < {min_mask:.0f}%")
    if st["bedsMinusMusic"] is not None and st["bedsMinusMusic"] < -max_under:
        bad.append(f"beds {st['bedsMinusMusic']:+.1f} dB under music")
    if st["voMinusBeds"] is not None and st["voMinusBeds"] < min_vo:
        bad.append(f"vo only {st['voMinusBeds']:+.1f} dB over beds")
    return bad


def speech_mask(shots: list[dict], n_windows: int) -> np.ndarray:
    speech = np.zeros(n_windows, bool)
    for s in shots:
        for line in s.get("dialogue") or []:
            a = max(0, int((float(line["t0"]) - 0.05) / WIN))
            speech[a:int((float(line["t1"]) + 0.1) / WIN) + 1] = True
    return speech


def _shots(raw: object) -> list[dict]:
    if not isinstance(raw, list) or not raw:
        raise ToolError("VALIDATION", "shots must be a non-empty array of {id, startS, endS}")
    out = []
    for s in raw:
        try:
            shot = {"id": str(s["id"]), "start": float(s["startS"]), "end": float(s["endS"]),
                    "dialogue": [{"t0": float(d["t0"]), "t1": float(d["t1"])} for d in s.get("dialogue") or []]}
        except (KeyError, TypeError, ValueError) as err:
            raise ToolError("VALIDATION", "every shot needs id, startS, endS and dialogue lines with t0, t1") from err
        if not 0 <= shot["start"] < shot["end"]:
            raise ToolError("VALIDATION", f"shot {shot['id']} must have 0 <= startS < endS")
        out.append(shot)
    return out


def run(payload: dict, media: Media, deadline: Deadline, _outputs) -> dict:
    stems = payload.get("stems")
    if not isinstance(stems, dict) or not stems or set(stems) - set(BUSES):
        raise ToolError("VALIDATION", f"stems must map some of {', '.join(BUSES)} to media ids")
    sr = int(payload.get("sampleRate", 48000))
    if not 8000 <= sr <= 192000:
        raise ToolError("VALIDATION", "sampleRate must be between 8000 and 192000")
    shots = _shots(payload.get("shots"))
    decoded = {b: decode_audio(media.path(ref), deadline, sr=sr, channels=2) for b, ref in stems.items()}
    n = max(int(round(max(s["end"] for s in shots) * sr)), *(len(x) for x in decoded.values()))
    buses = {}
    for b in BUSES:
        x = np.zeros((n, 2), np.float32)
        if b in decoded:
            x[: len(decoded[b])] = decoded[b][:n]
        buses[b] = x
    allow = {str(a) for a in payload.get("allow") or []}
    min_mask = float(payload.get("minMaskPct", 60))
    max_under = float(payload.get("maxUnderMusicDb", 6))
    min_vo = float(payload.get("minVoOverBedsDb", 6))
    w = int(WIN * sr)
    speech = speech_mask(shots, n // w + 1)
    total = buses["beds"] + buses["music"] + buses["vo"]
    report, fails = [], []
    for s in shots:
        st = shot_stats(buses, total, int(s["start"] * sr), int(s["end"] * sr), speech, sr)
        st["fail"] = [] if s["id"] in allow else gate(st, min_mask=min_mask, max_under=max_under, min_vo=min_vo)
        report.append({"id": s["id"], "allowed": s["id"] in allow, **st})
        fails += [f"{s['id']}: {x}" for x in st["fail"]]
    return {"shots": report, "fails": fails, "pass": not fails}
