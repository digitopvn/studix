#!/usr/bin/env python3
"""Stylized-voice variants (robot, radio, ...) from approved TTS takes by DSP, plus a labelled reel for the user to pick.

usage: make-voice-variants.py --in flat=take1.wav [--in bright=take2.wav] --group robot [--only A,C]
                              --out-dir audio/vo/takes --name sc01-s06-L03 [--line "0:17  L03  the line text"]
                              [--presets FILE] [--episode DIR] [--font FILE] [--list]
A stylized voice is a taste call: make every variant of the group, put them in one reel with each card labelled
(variant id and what it does) and the line in place, and let the user choose; do not pick for them. DSP on a clean
take beats prompt-only TTS for a stylized voice and costs no new API call.
Presets: assets/templates/voice-dsp-presets.json, merged with <series>/voice-dsp-presets.json when --episode is given,
or --presets FILE. Each variant names its `source` (an --in key; default the first --in) and an ffmpeg -af chain.
Writes <out-dir>/<name>-<group>-<id>.wav (loudness -18 LUFS, -2 dBTP, 48 kHz mono) and
<out-dir>/<name>-<group>-variants.mp4. Never overwrites.
Supported: Windows, macOS, Linux. Needs ffmpeg, ffprobe.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio import engine_routing as er  # noqa: E402
from studio import review_cards as rc  # noqa: E402

PRESETS = io.TEMPLATES / "voice-dsp-presets.json"
FINISH = "loudnorm=I=-18:TP=-2,aresample=48000"


def load_presets(path: Path | None = None, episode: Path | None = None) -> dict:
    doc = io.load_json(path or PRESETS)
    s = er.series_dir(episode)
    if path is None and s and (s / "voice-dsp-presets.json").exists():
        doc = er._merge(doc, io.load_json(s / "voice-dsp-presets.json"))
    return {k: v for k, v in doc.items() if not k.startswith("_")}


def chain(af: str, sample_rate: int) -> str:
    return af.replace("{sr}", str(sample_rate)) + "," + FINISH


def pick_variants(group: dict, only: str | None) -> list[tuple[str, dict]]:
    ids = only.split(",") if only else sorted(group)
    unknown = [i for i in ids if i not in group]
    if unknown:
        raise SystemExit(f"no variant {', '.join(unknown)} (have {', '.join(sorted(group))})")
    return [(i, group[i]) for i in ids]


def sample_rate(p: Path) -> int:
    return int(io.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate",
                       "-of", "csv=p=0", str(p)]).stdout.decode().strip())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--in", dest="takes", action="append", default=[], help="key=path of an approved take")
    ap.add_argument("--group", help="preset group, e.g. robot")
    ap.add_argument("--only", help="comma list of variant ids")
    ap.add_argument("--out-dir", type=Path)
    ap.add_argument("--name", help="file stem, e.g. sc01-s06-L03")
    ap.add_argument("--line", default="", help="second card line: time, line id and text")
    ap.add_argument("--presets", type=Path)
    ap.add_argument("--episode", type=Path, help="to merge <series>/voice-dsp-presets.json")
    ap.add_argument("--font")
    ap.add_argument("--list", action="store_true", help="print the groups and variants, then stop")
    a = ap.parse_args()
    presets = load_presets(a.presets, a.episode)
    if a.list:
        for g, vs in presets.items():
            for i, v in sorted(vs.items()):
                print(f"{g}/{i}: {v.get('label', '')}")
        return 0
    if not (a.takes and a.group and a.out_dir and a.name):
        ap.error("--in, --group, --out-dir and --name are required (or --list)")
    takes = dict(t.split("=", 1) if "=" in t else (f"in{n}", t) for n, t in enumerate(a.takes))
    first = next(iter(takes))
    group = presets.get(a.group) or sys.exit(f"no preset group {a.group!r} (have {', '.join(presets)})")
    reel = a.out_dir / f"{a.name}-{a.group}-variants.mp4"
    if reel.exists():
        sys.exit(f"{reel} exists; pick a new --name")
    font = rc.font_file(a.font)
    a.out_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as d:
        cards = []
        for vid, v in pick_variants(group, a.only):
            src = Path(takes.get(v.get("source", first)) or takes[first])
            out = a.out_dir / f"{a.name}-{a.group}-{vid}.wav"
            if not out.exists():
                io.run(["ffmpeg", "-v", "error", "-n", "-i", str(src), "-af", chain(v["af"], sample_rate(src)),
                        "-ac", "1", str(out)])
            card = Path(d) / f"{vid}.mp4"
            vf = rc.label(f"{a.group} {vid}  -  {v.get('label', '')}", font, 40, "(w-tw)/2", "h/2-60")
            if a.line:
                vf += "," + rc.label(a.line, font, 30, "(w-tw)/2", "h/2+20")
            io.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x101418:s=1280x720:r=24", "-i", str(out),
                    "-af", "adelay=500,apad=pad_dur=0.8", "-shortest", "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", str(card)])
            cards.append(card)
            print(out)
        lst = Path(d) / "list.txt"
        lst.write_text("".join(f"file '{c.as_posix()}'\n" for c in cards), encoding="utf-8")
        io.run(["ffmpeg", "-v", "error", "-n", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(reel)])
    print(reel, "<- send this to the user and wait for their pick")
    return 0


if __name__ == "__main__":
    sys.exit(main())
