#!/usr/bin/env python3
"""Re-time one aligned VO line without a new paid take or alignment: keep listed spans of the take, each at its own
tempo, insert pauses where wanted, and carry the word timings through the same cut so the karaoke stays on the words.

usage: python -X utf8 retime-vo-line.py <vo.wav> <out.wav> '<spans json>' [--words align.json [--words-out f.json]]
       [--edl scenes/scNN/edl.json --line <line id or vo stem prefix>]

Spans (seconds of the source take; put every edge in a pause between words):
  [a, b, tempo]          keep a..b at that tempo (1.0 = as is, 0.9 = 10% slower); tempo below 0.5 chains atempo stages
  ["gap", s]             insert s seconds of silence
  ["gap", s, a, b]       insert s seconds of the take's own room tone, looped from a..b (a breath-free pause)
Every join gets 6 ms fades, so a cut in room tone never clicks.

--words remaps an alignment json (ElevenLabs `words[]`/`characters[]` with start/end) into --words-out
(default <out stem>.align.json). --edl --line remaps the line's `words[].t0` (base = t0 + vo_offset) and points its
`vo` at the new file (relative to the episode when it lives there); the write is atomic. t0 and t1 stay put: move or
lengthen them yourself when the line got longer. Any tempo below 0.85 is flagged: it starts to sound slowed, so
The user's ear decides. The output is never overwritten.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402

FADE = 0.006
SLOW_FLAG = 0.85


def parse_spans(spans: list) -> list[tuple]:
    """Normalize to ('keep', a, b, tempo) / ('gap', s, a, b) tuples; raise on anything malformed."""
    out = []
    for sp in spans:
        if sp and sp[0] == "gap":
            s = float(sp[1])
            if s <= 0:
                raise ValueError(f"gap length must be positive: {sp}")
            a, b = (float(sp[2]), float(sp[3])) if len(sp) >= 4 else (None, None)
            if a is not None and b <= a:
                raise ValueError(f"room-tone range must run forward: {sp}")
            out.append(("gap", s, a, b))
        else:
            a, b, r = float(sp[0]), float(sp[1]), float(sp[2]) if len(sp) > 2 else 1.0
            if b <= a or r <= 0:
                raise ValueError(f"bad span {sp}: need a < b and tempo > 0")
            out.append(("keep", a, b, r))
    return out


def atempo_chain(r: float) -> str:
    """ffmpeg atempo takes 0.5..100 per stage; chain stages for slower tempos."""
    if abs(r - 1) < 1e-6:
        return ""
    stages = []
    while r < 0.5:
        stages.append(0.5)
        r /= 0.5
    stages.append(r)
    return "".join(f",atempo={s:.5f}" for s in stages)


def mapper(spans: list[tuple]):
    """Source time -> output time. A time inside a removed stretch lands on the next kept span's start."""
    marks, o = [], 0.0
    for sp in spans:
        if sp[0] == "gap":
            o += sp[1]
            continue
        _, a, b, r = sp
        marks.append((a, b, r, o))
        o += (b - a) / r
    total = o

    def m(t: float) -> float:
        for a, b, r, off in marks:
            if t < a:
                return off
            if t <= b:
                return off + (t - a) / r
        return total
    return m, total


def filter_graph(spans: list[tuple]) -> str:
    parts, labels = [], []
    for i, sp in enumerate(spans):
        if sp[0] == "gap":
            _, s, a, b = sp
            if a is None:
                parts.append(f"anullsrc=r=48000:cl=mono,atrim=0:{s:.4f}[p{i}]")
            else:
                parts.append(f"[0:a]atrim={a:.4f}:{b:.4f},asetpts=PTS-STARTPTS,aloop=loop=-1:size=2e9,atrim=0:{s:.4f},"
                             f"afade=t=in:d={FADE},areverse,afade=t=in:d={FADE},areverse[p{i}]")
        else:
            _, a, b, r = sp
            parts.append(f"[0:a]atrim={a:.4f}:{b:.4f},asetpts=PTS-STARTPTS{atempo_chain(r)},afade=t=in:d={FADE},"
                         f"areverse,afade=t=in:d={FADE},areverse[p{i}]")
        labels.append(f"[p{i}]")
    # every input to concat is brought to the same format first
    fmt = ";".join(f"{lb}aformat=sample_rates=48000:channel_layouts=mono[q{i}]" for i, lb in enumerate(labels))
    return ";".join(parts) + ";" + fmt + ";" + "".join(f"[q{i}]" for i in range(len(labels))) + f"concat=n={len(labels)}:v=0:a=1[o]"


def remap_alignment(al: dict, m) -> dict:
    for k in ("words", "characters"):
        for w in al.get(k) or []:
            for f in ("start", "end"):
                if f in w:
                    w[f] = round(m(float(w[f])), 3)
    return al


def find_line(edl: dict, lid: str):
    for s in edl.get("shots", []):
        for ln in s.get("dialogue") or []:
            if ln.get("id") == lid or Path(ln.get("vo") or "").name.startswith(lid + "-"):
                return ln
    raise SystemExit(f"line {lid} not found in the EDL")


def remap_line(line: dict, m) -> None:
    base = float(line["t0"]) + float(line.get("vo_offset", 0) or 0)
    for w in line.get("words") or []:
        w["t0"] = round(base + m(float(w["t0"]) - base), 3)


def atomic_write_json(path: Path, data) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    os.replace(tmp, path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("vo"); ap.add_argument("out"); ap.add_argument("spans")
    ap.add_argument("--words"); ap.add_argument("--words-out")
    ap.add_argument("--edl"); ap.add_argument("--line")
    a = ap.parse_args()
    src, out = Path(a.vo), Path(a.out)
    if out.exists():
        sys.exit(f"{out} exists: retimed takes are never overwritten, pick a new name")
    if bool(a.edl) != bool(a.line):
        sys.exit("--edl and --line go together")
    spans = parse_spans(json.loads(a.spans))
    for sp in spans:
        if sp[0] == "keep" and sp[3] < SLOW_FLAG:
            print(f"warning: span {sp[1]}-{sp[2]} at {sp[3]}x is below {SLOW_FLAG}x and may sound slowed; ask the user's ear")
    out.parent.mkdir(parents=True, exist_ok=True)
    io.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(src), "-filter_complex", filter_graph(spans),
            "-map", "[o]", "-ar", "48000", "-c:a", "pcm_s16le", str(out)])
    m, total = mapper(spans)
    if a.words:
        al = remap_alignment(io.load_json(a.words), m)
        al["retimed_from"] = {"file": src.name, "spans": json.loads(a.spans)}
        wo = Path(a.words_out) if a.words_out else out.with_suffix(".align.json")
        io.save_json(wo, al, indent=1)
        print(f"alignment -> {wo}")
    if a.edl:
        edl_p = Path(a.edl)
        edl = io.load_json(edl_p)
        line = find_line(edl, a.line)
        remap_line(line, m)
        episode = edl_p.resolve().parent.parent.parent
        try:
            line["vo"] = out.resolve().relative_to(episode).as_posix()
        except ValueError:
            line["vo"] = out.resolve().as_posix()
        atomic_write_json(edl_p, edl)
        end = float(line["t0"]) + float(line.get("vo_offset", 0) or 0) + total
        if line.get("t1") is not None and end > float(line["t1"]):
            print(f"warning: the line now ends at {end:.3f} s, after its t1 {line['t1']}; move t1 for the caption")
    print(f"{src.name} -> {out.name} ({total:.3f} s)")


if __name__ == "__main__":
    main()
