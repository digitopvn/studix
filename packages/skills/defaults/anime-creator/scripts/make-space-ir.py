#!/usr/bin/env python3
"""Synthesize a stereo impulse response for a mix space (build-audio-mix.py `spaces`), so a scene's effects sit in
one shared acoustic instead of reading dry and pasted on.

usage: uv run --with numpy python make-space-ir.py <out.wav> --preset street|plaza|hall|room|server [--rt60 S] [--seed N]

The IR is decorrelated noise with a per-band exponential decay (highs die first, like air and soft surfaces),
plus discrete early reflections (building facades, walls) panned left/right, high-passed so the wet return
never muddies the low end. Write it under <episode>/audio/ir/ and reference it from mix-events.json:
  "spaces": {"street": {"ir": "audio/ir/street.wav", "return_db": 0}},
  "scene_space": {"sc03": {"space": "street", "send_db": {"beds": -16, "hits": -10}}}
Events may override with their own "space"/"send" (dB, relative to the dry gain).
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import numpy as np

SR = 48000
# rt60 (s), pre-delay (s), early reflections [(delay s, gain, pan -1..1)], low cut and high cut of the wet (Hz)
PRESETS = {
    "street": dict(rt60=1.6, pre=0.012, early=[(0.031, 0.55, -0.7), (0.047, 0.5, 0.8), (0.083, 0.38, -0.4), (0.121, 0.3, 0.6),
                                              (0.172, 0.22, -0.8), (0.240, 0.15, 0.7)], lo=160, hi=7000),
    "plaza": dict(rt60=2.2, pre=0.02, early=[(0.065, 0.35, -0.6), (0.110, 0.3, 0.7), (0.190, 0.22, -0.3), (0.300, 0.16, 0.5)],
                  lo=140, hi=6500),
    "hall": dict(rt60=1.8, pre=0.015, early=[(0.018, 0.5, -0.5), (0.029, 0.45, 0.6), (0.044, 0.35, -0.2), (0.061, 0.3, 0.3)],
                 lo=120, hi=8000),
    "room": dict(rt60=0.5, pre=0.004, early=[(0.007, 0.6, -0.5), (0.011, 0.5, 0.5), (0.017, 0.35, 0.1)], lo=150, hi=9000),
    "server": dict(rt60=0.9, pre=0.006, early=[(0.009, 0.55, -0.6), (0.014, 0.5, 0.6), (0.023, 0.35, -0.2), (0.035, 0.25, 0.4)],
                   lo=150, hi=7500),
}


def band_noise(n: int, lo: float, hi: float, rng: np.random.Generator) -> np.ndarray:
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    spec[(f < lo) | (f >= hi)] = 0
    return np.fft.irfft(spec, n)


def make(preset: dict, rt60: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int((rt60 * 1.3 + preset["pre"]) * SR)
    t = np.arange(n) / SR
    edges = [preset["lo"], 500, 2000, 5000, preset["hi"]]
    ir = np.zeros((n, 2))
    for ch in range(2):
        for k, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
            rt = rt60 * (1.0, 0.85, 0.65, 0.45)[k]  # higher bands decay faster
            ir[:, ch] += band_noise(n, lo, hi, rng) * np.exp(-6.91 * t / rt)
    onset = np.clip((t - preset["pre"]) / 0.04, 0, 1)  # the diffuse tail builds up after the early reflections
    ir *= onset[:, None] * 0.35 / np.sqrt((ir ** 2).sum(0).mean())
    for d, g, pan in preset["early"]:
        i = int(d * SR)
        ir[i, 0] += g * min(1, 1 - pan)
        ir[i, 1] += g * min(1, 1 + pan)
    return ir / np.abs(ir).max() * 0.7


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out")
    ap.add_argument("--preset", choices=sorted(PRESETS), required=True)
    ap.add_argument("--rt60", type=float)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    p = PRESETS[a.preset]
    ir = make(p, a.rt60 or p["rt60"], a.seed).astype(np.float32)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    # the low/high cut is re-applied after the early reflections, which are full-band clicks
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                    "-af", f"highpass=f={p['lo']},lowpass=f={p['hi']}", "-c:a", "pcm_f32le", str(out)],
                   input=ir.tobytes(), check=True)
    print(f"{out} {a.preset} rt60 {a.rt60 or p['rt60']}s {len(ir) / SR:.2f}s")


if __name__ == "__main__":
    main()
