#!/usr/bin/env python3
"""Episode (or one scene) audio mix -> <episode>/audio/mix.wav: 48 kHz stereo 24-bit, exactly the edit length,
one static gain to the target LUFS, then a 4x-oversampled limiter at the true-peak ceiling.

usage: uv run --with numpy python build-audio-mix.py <episode-dir> [--scene sc01] [--out PATH] [--peaks]
Reads <episode>/audio/mix-events.json (see assets/templates/mix-events.example.json). Event times are scene
time (`scene` + `t`), shot time (`scene` + `at_shot` + `t`) or episode time (no scene), so editing one scene
never shifts the sound of the others. Auto events: each video shot with audio=true contributes its conformed
clips/<shot>.wav, each dialogue line with a `vo` file is placed at its t0, and duck windows can be derived from
every dialogue line. Per-bus peaks are printed (every 0.25 s with --peaks) before any master gain is applied.
Shared acoustics: `spaces` {name: {ir, return_db}} (IRs from make-space-ir.py) and `scene_space`
{scene: {space, send_db: {bus: dB}}} send each event's dry signal, convolved with the IR, back onto its bus
before ducking; an event may override with `space` or `send` (dB relative to its dry gain).
Supported: macOS, Linux. Needs ffmpeg and numpy.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio.edit_page_builder import episode_timeline  # noqa: E402

BUSES = ("beds", "hits", "vo", "music")


def ff(cmd: list[str], data: bytes | None = None) -> bytes:
    p = subprocess.run(cmd, input=data, capture_output=True)
    if p.returncode:
        sys.exit(" ".join(cmd[:8]) + "\n" + p.stderr.decode()[-1500:])
    return p.stdout


def compensate_limiters(chain: str) -> str:
    """alimiter delays its output by the lookahead (5 ms of zeros at the head, tail cut) unless latency=1 is set."""
    return re.sub(r"alimiter(=(?:(?!latency)[^,])*)?(?=,|$)", lambda m: m.group(0) + (":" if m.group(1) else "=") + "latency=1", chain)


def load(path: Path, off: float, ln: float | None, filt: str, sr: int) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error", "-i", str(path)]
    # trim in the filter graph: an input-side -ss on mp3 returns ~25 ms of digital zero before the audio
    trim = f"atrim=start={off}" + (f":duration={ln}" if ln else "") + ",asetpts=PTS-STARTPTS"
    if "aecho" in filt:  # pad first so the echo tail survives the source trim
        filt = "apad=pad_dur=0.6," + filt
    af = trim + "," + (compensate_limiters(filt) + "," if filt else "") + "aformat=channel_layouts=stereo"
    out = ff(cmd + ["-af", af, "-ar", str(sr), "-ac", "2", "-f", "f32le", "-"])
    return np.frombuffer(out, np.float32).reshape(-1, 2).copy()


def place(bus: np.ndarray, a: np.ndarray, t: float, gain: float, fi: float, fo: float, pan: float, sr: int) -> None:
    n = len(a)
    env = np.ones(n, np.float32)
    if fi > 0:
        k = min(n, int(fi * sr)); env[:k] *= np.linspace(0, 1, k)
    if fo > 0:
        k = min(n, int(fo * sr)); env[n - k:] *= np.linspace(1, 0, k)
    a *= (env * 10 ** (gain / 20))[:, None]
    a[:, 0] *= min(1, 1 - pan); a[:, 1] *= min(1, 1 + pan)
    i = max(0, int(round(t * sr))); j = min(len(bus), i + n)
    if j > i:
        bus[i:j] += a[: j - i]


def bus_fx(bus: np.ndarray, chain: str, sr: int) -> np.ndarray:
    chain = compensate_limiters(chain)
    out = ff(["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "-", "-af", chain, "-f", "f32le", "-"],
             bus.astype(np.float32).tobytes())
    o = np.frombuffer(out, np.float32).reshape(-1, 2)
    return np.pad(o, ((0, max(0, len(bus) - len(o))), (0, 0)))[: len(bus)].copy()


def convolve(x: np.ndarray, ir: np.ndarray, block: int = 1 << 18) -> np.ndarray:
    """Stereo overlap-add FFT convolution (channel i with IR channel i), trimmed to len(x)."""
    n, m = len(x), len(ir)
    size = 1 << int(np.ceil(np.log2(block + m - 1)))
    H = np.fft.rfft(ir, size, axis=0)
    out = np.zeros((n + m, 2), np.float32)
    for i in range(0, n, block):
        seg = x[i:i + block]
        if not seg.any():
            continue
        y = np.fft.irfft(np.fft.rfft(seg, size, axis=0) * H, size, axis=0)[: len(seg) + m - 1]
        out[i:i + len(y)] += y
    return out[:n]


def space_of(e: dict, cfg: dict) -> tuple[str | None, float | None]:
    """Reverb send for an event: its own `space`/`send`, else the scene's default space and per-bus send (dB)."""
    sc = (cfg.get("scene_space") or {}).get(e.get("scene") or "", {})
    space = e.get("space", sc.get("space"))
    send = e.get("send", (sc.get("send_db") or {}).get(e.get("bus", "beds")))
    return (space, send) if space and send is not None else (None, None)


def curve(wins: list[tuple[float, float, float]], n: int, sr: int, attack: float = 0.04, release: float = 0.22) -> np.ndarray:
    """Duck gain: target min over windows, smoothed by a one-pole follower in 1 ms blocks."""
    target = np.ones(n, np.float32)
    for a, b, g in wins:
        i, j = max(0, int(a * sr)), min(n, int(b * sr))
        target[i:j] = np.minimum(target[i:j], g)
    blk = sr // 1000
    tb = target[::blk]
    out = np.empty_like(tb)
    g, ca, cr = 1.0, np.exp(-1 / (attack * 1000)), np.exp(-1 / (release * 1000))
    for i, x in enumerate(tb):
        c = ca if x < g else cr
        g = c * g + (1 - c) * x
        out[i] = g
    return np.pad(np.repeat(out, blk), (0, max(0, n - len(tb) * blk)), "edge")[:n]


def measure(path: Path) -> tuple[float, float]:
    err = subprocess.run(["ffmpeg", "-v", "info", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True).stderr.split("Summary:")[-1]
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", err).group(1)), float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", err).group(1))


def gather(ep: Path, cfg: dict, rows: list[dict], lang: str | None = None) -> tuple[list[dict], dict[str, list]]:
    """Resolve every event and duck window to absolute (episode or single-scene) time; a dubbed mix (`lang`) takes
    each event's `dub.<lang>` overrides, e.g. the localized take of a song and the offset that lands its line."""
    off = {r["scene"]: r["offset"] for r in rows}
    starts = {(r["scene"], s["id"]): s["start"] for r in rows for s in r["edl"]["shots"]}
    keep = set(off)

    def at(e: dict) -> float | None:
        sc = e.get("scene")
        if sc is None:
            return e.get("t", 0.0) - rows[0]["offset"] if len(rows) == 1 else e.get("t", 0.0)
        if sc not in keep:
            return None
        base = off[sc] + (starts[(sc, e["at_shot"])] if e.get("at_shot") else 0.0)
        return base + e.get("t", 0.0) - rows[0]["offset"]

    evs = []
    for e in cfg.get("events", []):
        e = {**e, **(e.get("dub", {}).get(lang, {}) if lang else {})}
        t = at(e)
        if t is not None:
            evs.append({**e, "abs": t})
    auto = cfg.get("auto", {})
    for r in rows:
        sd = ep / "scenes" / r["scene"]
        base = r["offset"] - rows[0]["offset"]
        for s in r["edl"]["shots"]:
            wav = sd / "clips" / f"{s['id']}.wav"
            if auto.get("clip_audio", True) and s.get("audio") and wav.exists():
                evs.append({"file": str(wav), "abs": base + s["start"], "gain": auto.get("vo_gain_db", 2), "bus": "vo", "fade_in": 0.02, "fade_out": 0.08})
            for line in s.get("dialogue") or []:
                if auto.get("dialogue_vo", True) and line.get("vo"):
                    evs.append({"file": str(ep / line["vo"]), "abs": base + line["t0"] + line.get("vo_offset", 0.0),
                                "gain": line.get("vo_gain", auto.get("vo_gain_db", 2)), "bus": "vo", "fade_in": 0.01, "fade_out": 0.06,
                                "fx": line.get("vo_fx", "")})
    ducks: dict[str, list] = {b: [] for b in BUSES}
    for b, wins in (cfg.get("duck") or {}).items():
        for w in wins:
            a = at({"scene": w.get("scene"), "at_shot": w.get("at_shot"), "t": w["t0"]})
            if a is not None:
                ducks[b].append((a, a + (w["t1"] - w["t0"]), w["gain"]))
    # `duck_from_dialogue_override` windows ({scene, at_shot, t0, t1, bus, gain}) set a different dialogue duck for
    # lines starting inside them, e.g. a climax where the song only dips a little under the voices
    over = []
    for w in cfg.get("duck_from_dialogue_override") or []:
        a = at({"scene": w.get("scene"), "at_shot": w.get("at_shot"), "t": w["t0"]})
        if a is not None:
            over.append((w["bus"], a, a + (w["t1"] - w["t0"]), w["gain"]))
    for b, g in (cfg.get("duck_from_dialogue") or {}).items():
        for r in rows:
            base = r["offset"] - rows[0]["offset"]
            for s in r["edl"]["shots"]:
                for line in s.get("dialogue") or []:
                    t0 = base + line["t0"]
                    gl = next((og for ob, oa, oz, og in over if ob == b and oa <= t0 < oz), g)
                    # the voice file plays from t0 + vo_offset (an early lip lead is negative), so the duck opens
                    # from there; from t0 alone the first word sat under the full bed
                    lead = min(0.0, line.get("vo_offset", 0.0))
                    ducks[b].append((t0 + lead - 0.05, base + line["t1"] + 0.1, gl))
    return evs, ducks


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episode")
    ap.add_argument("--scene")
    ap.add_argument("--out")
    ap.add_argument("--peaks", action="store_true", help="per-bus peak every 0.25 s")
    ap.add_argument("--edl", help="dialogue from scenes/<sc>/<EDL> where it exists (a dubbed track, e.g. edl.en.json); "
                                  "shot timing still comes from edl.json")
    ap.add_argument("--lang", help="dubbed mix: apply each event's dub.<LANG> overrides (localized song takes)")
    a = ap.parse_args()
    ep = Path(a.episode).expanduser().resolve()
    cfg = io.load_json(ep / "audio" / "mix-events.json")
    rows = episode_timeline(ep)
    if a.scene:
        rows = [r for r in rows if r["scene"] == a.scene]
    for r in rows if a.edl else []:
        alt = ep / "scenes" / r["scene"] / a.edl
        if alt.exists():
            r["edl"] = io.load_json(alt)
    sr = int(cfg.get("sample_rate", 48000))
    dur = sum(r["duration"] for r in rows)
    n = int(round(dur * sr))
    presets = cfg.get("presets", {})
    evs, ducks = gather(ep, cfg, rows, a.lang)
    buses = {b: np.zeros((n, 2), np.float32) for b in BUSES}
    sends: dict[tuple[str, str], np.ndarray] = {}
    missing = []
    for e in evs:
        f = Path(e["file"]) if Path(e["file"]).is_absolute() else ep / e["file"]
        if not f.exists():
            missing.append(str(f.relative_to(ep)) if f.is_relative_to(ep) else str(f))
            continue
        fx = presets.get(e.get("fx", ""), e.get("fx", ""))
        clip = load(f, e.get("offset", 0), e.get("len"), fx, sr)
        space, send = space_of(e, cfg)
        if space:  # the wet copy follows the dry event's gain, fades and pan, then the space's IR in one pass per bus
            key = (space, e.get("bus", "beds"))
            sends.setdefault(key, np.zeros((n, 2), np.float32))
            place(sends[key], clip.copy(), e["abs"], e.get("gain", 0) + send, e.get("fade_in", 0), e.get("fade_out", 0), e.get("pan", 0), sr)
        place(buses[e.get("bus", "beds")], clip, e["abs"], e.get("gain", 0),
              e.get("fade_in", 0), e.get("fade_out", 0), e.get("pan", 0), sr)
    if missing:
        print("MISSING (skipped): " + ", ".join(sorted(set(missing))))
    for (space, b), wet in sends.items():  # wet returns join their bus before ducking, so a duck also dips the tail
        ir = load(ep / cfg["spaces"][space]["ir"], 0, None, "", sr)
        buses[b] += convolve(wet, ir) * 10 ** (cfg["spaces"][space].get("return_db", 0) / 20)
    for b in BUSES:
        if ducks[b]:
            att, rel = (0.02, 0.18) if b == "hits" else (0.04, 0.22)
            buses[b] *= curve(ducks[b], n, sr, att, rel)[:, None]
    for b, chain in (cfg.get("bus_fx") or {}).items():
        if b in buses and chain:
            buses[b] = bus_fx(buses[b], chain, sr)
    win = int(0.25 * sr)
    for b in BUSES:
        pk = 20 * np.log10(np.abs(buses[b]).max() + 1e-9)
        line = f"bus {b:6s} peak {pk:6.1f} dBFS"
        if a.peaks and n >= win:
            w = np.abs(buses[b][: n - n % win]).reshape(-1, win, 2).max(axis=(1, 2))
            top = np.argsort(w)[-3:][::-1]
            line += "  loudest at " + ", ".join(f"{i * 0.25:.2f}s {20 * np.log10(w[i] + 1e-9):.1f}" for i in top)
        print(line)
    trim = {**{b: 0.0 for b in BUSES}, **cfg.get("bus_trim_db", {})}
    mix = sum(buses[b] * 10 ** (trim[b] / 20) for b in BUSES)
    # a dubbed mix keeps its own premix, so it can run beside the original language's mix
    tmp = ep / "audio" / (f"premix-{Path(a.edl).stem}.wav" if a.edl else "premix.wav")
    ff(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "-", "-c:a", "pcm_f32le", str(tmp)], mix.astype(np.float32).tobytes())
    print("premix I/TP:", measure(tmp))
    tg = {"lufs": -14.0, "true_peak": -1.5, "lra": 20, "limit": 0.82, **cfg.get("target", {})}
    # master fade at the end of the mix: `scene_fade_out` {scene: s} overrides the file-wide `fade_out` for the
    # scene the mix ends on, so a scene that hands its sound to the next one (a J-cut) can end at full level (0)
    last = rows[-1]["scene"] if rows else ""
    fo = float((cfg.get("scene_fade_out") or {}).get(last, cfg.get("fade_out", 0.4)))
    fade = f"afade=t=out:st={max(0, dur - fo):.3f}:d={fo}," if fo > 0 else ""
    out = Path(a.out) if a.out else ep / "audio" / (f"mix-{a.scene}.wav" if a.scene else "mix.wav")
    # One static gain to the target loudness, then a 4x-oversampled limiter for the true peak. loudnorm with
    # linear=true falls back to its dynamic mode whenever the gain would push the true peak over TP (every premix
    # here peaks +4..+9 dBTP), and the dynamic mode rides the gain: the head of each mix came out up to +3.6 dB hot
    # and the hits lost their punch. The limiter trims loudness a little, so the gain is corrected and re-run.
    gain = tg["lufs"] - measure(tmp)[0]
    ceiling = min(tg["limit"], 10 ** (tg["true_peak"] / 20))
    for _ in range(4):
        chain = (f"volume={gain:.3f}dB,aresample={4 * sr},alimiter=limit={ceiling:.4f}:attack=1:release=40:level=disabled:latency=1,"
                 f"aresample={sr},{fade}apad=whole_len={n},atrim=end_sample={n}")
        ff(["ffmpeg", "-v", "error", "-y", "-i", str(tmp), "-af", chain, "-ar", str(sr), "-c:a", "pcm_s24le", str(out)])
        lufs, tp = measure(out)
        if abs(lufs - tg["lufs"]) <= 0.2 and tp <= tg["true_peak"]:
            break
        gain += tg["lufs"] - lufs
        if tp > tg["true_peak"]:
            ceiling *= 10 ** ((tg["true_peak"] - tp - 0.05) / 20)
    tmp.unlink(missing_ok=True)
    print(f"{out.name} I/TP: {measure(out)}  duration {n / sr:.3f}s")


if __name__ == "__main__":
    main()
