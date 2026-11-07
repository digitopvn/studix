"""Group transcript words into sentence segments: data/segments.json plus a table to write the EDL from.

A segment ends after sentence-ending punctuation (. ? ! … and their full-width forms), before a
pause longer than --max-gap seconds, at --max-words words, and at the end of a take.
Ids g001, g002, ... run across all takes in transcript order.

Output: [{id, take, start, end, text, words:[[t, s, e], ...]}] in source seconds.
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reclib
from reclib import StepError

# End punctuation, optionally followed by closing quotes or brackets.
SENTENCE_END = re.compile(r"[.?!…。？！]+[\"'”’»)\]]*$")


def split_segments(words, max_gap, max_words):
    segments, current = [], []

    def close():
        if current:
            segments.append(current[:])
            current.clear()

    for w in words:
        if current and (w["take"] != current[-1]["take"] or w["s"] - current[-1]["e"] > max_gap):
            close()
        current.append(w)
        if SENTENCE_END.search(w["t"]) or len(current) >= max_words:
            close()
    close()
    width = max(3, len(str(len(segments))))
    out = []
    for i, seg in enumerate(segments, 1):
        out.append({
            "id": f"g{i:0{width}d}",
            "take": seg[0]["take"],
            "start": reclib.r3(seg[0]["s"]),
            "end": reclib.r3(max(w["e"] for w in seg)),
            "text": " ".join(w["t"] for w in seg),
            "words": [[w["t"], reclib.r3(w["s"]), reclib.r3(w["e"])] for w in seg],
        })
    return out


def load_words(transcript):
    words = transcript.get("words") if isinstance(transcript, dict) else None
    if not isinstance(words, list):
        raise StepError("data/transcript.json has no words list; run transcribe.py first")
    for i, w in enumerate(words):
        if not isinstance(w, dict) or not {"t", "s", "e", "take"} <= w.keys():
            raise StepError(f"data/transcript.json word {i} lacks t/s/e/take")
    return words


def main():
    ap = argparse.ArgumentParser(description="Split data/transcript.json into sentence segments (data/segments.json) and print the table.")
    ap.add_argument("project", help="project directory")
    ap.add_argument("--max-gap", type=float, default=0.6, help="start a new segment after a pause longer than this many seconds (default 0.6)")
    ap.add_argument("--max-words", type=int, default=40, help="cap a segment at this many words (default 40)")
    args = ap.parse_args()
    if args.max_gap <= 0 or args.max_words < 1:
        raise StepError("--max-gap must be > 0 and --max-words >= 1")

    root = reclib.project_dir(args.project)
    words = load_words(reclib.read_json(root / "data" / "transcript.json"))
    if not words:
        raise StepError("data/transcript.json has no words; check the takes and re-run transcribe.py")
    segments = split_segments(words, args.max_gap, args.max_words)
    reclib.write_json(root / "data" / "segments.json", segments)

    take_w = max(len(s["take"]) for s in segments)
    for s in segments:
        text = s["text"] if len(s["text"]) <= 60 else s["text"][:59] + "…"
        print(f"{s['id']}  {s['take']:<{take_w}}  {s['start']:8.2f}–{s['end']:<8.2f}  {text}")
    print(f"wrote data/segments.json ({len(segments)} segments from {len(words)} words)")


if __name__ == "__main__":
    reclib.main_guard(main)
