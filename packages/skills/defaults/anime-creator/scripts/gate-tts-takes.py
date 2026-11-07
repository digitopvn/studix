#!/usr/bin/env python3
"""Gate TTS takes before anyone listens: words against the script, pitch against the speaker, and the speech span.

usage: gate-tts-takes.py take1.wav [take2.wav ...] --text "the script line" --baseline-hz 210 [--lang vi]
                         [--engine NAME] [--min-match 0.85] [--max-octave 0.25] [--episode DIR] [--out gate.json]
For every take: transcribe it with the `asr` role of engines.json (cached as <take>.asr.txt), score the word match
against --text, measure the voiced f0 median and its offset in octaves from the speaker's --baseline-hz (the median of
their approved takes), and find where speech starts and ends. Emotional or shouted direction makes some TTS voices
drift toward another speaker's pitch (a male voice reading as female): a take more than --max-octave away fails even
when its words are right. The gate only removes takes; the user's ear picks among the ones that pass.
Works for takes from any TTS provider. Writes --out (default: gate.json beside the first take, merged per take).
Supported: Windows, macOS, Linux. Needs ffmpeg, numpy and the ASR CLI.
"""
from __future__ import annotations

import argparse
import difflib
import math
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio import engine_routing as er  # noqa: E402

FS = 16000


def words(text: str) -> list[str]:
    t = unicodedata.normalize("NFC", text.lower())
    t = re.sub(r"\([^)]*\)|<[^>]*>|\[[^\]]*\]", " ", t)  # stage directions, audio tags
    return re.findall(r"\w+", t)


def word_match(script: str, heard: str) -> float:
    a, b = words(script), words(heard)
    return round(difflib.SequenceMatcher(None, a, b).ratio(), 3) if a or b else 1.0


def octave_offset(f0: float | None, baseline: float | None) -> float | None:
    return round(math.log2(f0 / baseline), 2) if f0 and baseline else None


def verdict(match: float, octave: float | None, min_match: float, max_octave: float, gate_pitch: bool = True) -> list[str]:
    why = []
    if match < min_match:
        why.append(f"words {match:.2f} < {min_match}")
    if not gate_pitch:
        pass
    elif octave is None:
        why.append("no voiced pitch found")
    elif abs(octave) > max_octave:
        why.append(f"pitch {octave:+.2f} oct from the speaker")
    return why


def pcm(p: Path):
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-ac", "1", "-ar", str(FS), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)


def f0_median(a, fs: int = FS, lo: float = 60, hi: float = 400) -> float | None:
    """Autocorrelation pitch over voiced 40 ms frames (10 ms hop); median in Hz."""
    import numpy as np
    win, hop, out = int(fs * 0.04), fs // 100, []
    for i in range(0, len(a) - win, hop):
        w = a[i:i + win]
        if np.sqrt((w ** 2).mean()) < 0.03:
            continue
        w = w - w.mean()
        c = np.correlate(w, w, "full")[win - 1:]
        if c[0] <= 0:
            continue
        k = int(fs / hi) + int(np.argmax(c[int(fs / hi):int(fs / lo)]))
        if c[k] / c[0] > 0.4:
            out.append(fs / k)
    return round(float(np.median(out)), 1) if out else None


def speech_span(a, fs: int = FS, thresh: float = 0.02) -> tuple[float, float, float]:
    import numpy as np
    hop = fs // 100
    e = np.array([np.sqrt((a[i:i + hop] ** 2).mean()) for i in range(0, max(len(a) - hop, 0), hop)])
    on = np.where(e > thresh)[0]
    total = round(len(a) / fs, 3)
    return (round(on[0] * hop / fs, 3), round((on[-1] + 1) * hop / fs, 3), total) if len(on) else (0.0, 0.0, total)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("takes", nargs="+", type=Path)
    ap.add_argument("--text", required=True, help="the line as written in the script")
    ap.add_argument("--baseline-hz", type=float, help="the speaker's f0 median from approved takes")
    ap.add_argument("--lang", default="vi")
    ap.add_argument("--engine", help="asr adapter in engines.json")
    ap.add_argument("--episode", type=Path, help="to read <series>/engines.json overrides")
    ap.add_argument("--min-match", type=float, default=0.85)
    ap.add_argument("--max-octave", type=float, default=0.25)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    _, adapter = er.pick(er.load(a.episode), "asr", a.engine)
    out = a.out or a.takes[0].parent / "gate.json"
    log = io.load_json(out) if out.exists() else {}
    for take in a.takes:
        if not take.is_file():
            print(f"{take}: missing", file=sys.stderr)
            continue
        cache = take.with_suffix(".asr.txt")
        if not cache.exists():
            res = er.run_cli(adapter, **{"in": str(take), "lang": a.lang, "out": str(cache)}, timeout=600)
            if not cache.exists():
                cache.write_text(res if isinstance(res, str) else str(res), encoding="utf-8")
        heard = cache.read_text(encoding="utf-8").strip()
        sig = pcm(take)
        f0 = f0_median(sig)
        row = {"text": a.text, "asr": heard, "match": word_match(a.text, heard), "f0_hz": f0,
               "baseline_hz": a.baseline_hz, "octave": octave_offset(f0, a.baseline_hz), "span_s": speech_span(sig)}
        why = verdict(row["match"], row["octave"], a.min_match, a.max_octave) if a.baseline_hz else \
            verdict(row["match"], 0.0, a.min_match, a.max_octave)
        row.update(passed=not why, why=why)
        log[take.name] = row
        print(f"{'PASS' if not why else 'FAIL'} {take.name}  words {row['match']:.2f}  f0 {f0}  oct {row['octave']}  "
              f"span {row['span_s'][0]}-{row['span_s'][1]}s  {'; '.join(why)}")
    io.save_json(out, log)
    if not a.baseline_hz:
        print("no --baseline-hz: pitch not gated; measure the speaker's approved takes and pass their median", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
