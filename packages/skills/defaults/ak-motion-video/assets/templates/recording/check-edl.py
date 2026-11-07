"""Verify the output of apply-edl.py before building the timeline.

Checks, all against data/edl-map.json:
- the map is contiguous: dst ranges start at 0, follow each other and end at `duration`;
- every range is a whole number of frames and its audio, (src end - src start) / speed, has the
  same length; the cumulative audio-vs-video drift over all ranges stays within the tolerance;
- assets/audio/voice.wav and (when present) assets/video/webcam.mp4 last `duration`;
- every kept segment exists, belongs to the range's take, is kept once, and its words map
  inside the range's dst window.

Exit 1 with one line per failure.
"""
import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reclib
from reclib import StepError


def _pair(value):
    return (isinstance(value, list) and len(value) == 2
            and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in value))


def check_map(edl_map, segments, tol):
    """Return (failures, max drift in seconds) for the map itself."""
    fails = []
    fps = edl_map.get("fps")
    ranges = edl_map.get("ranges")
    duration = edl_map.get("duration")
    if not isinstance(fps, (int, float)) or fps <= 0:
        return ["data/edl-map.json: fps must be a positive number"], 0.0
    if not isinstance(ranges, list) or not ranges:
        return ["data/edl-map.json: ranges must be a non-empty list"], 0.0
    if not isinstance(duration, (int, float)):
        return ["data/edl-map.json: duration must be a number"], 0.0

    by_id = {s.get("id"): s for s in segments if isinstance(s, dict)}
    owner = {}
    cursor = cum_audio = cum_video = max_drift = 0.0
    worst = None
    for i, r in enumerate(ranges, 1):
        where = f"range {i}"
        if not isinstance(r, dict) or not _pair(r.get("src")) or not _pair(r.get("dst")):
            fails.append(f"{where}: needs src:[a,b] and dst:[c,d]")
            continue
        speed = r.get("speed")
        if not isinstance(speed, (int, float)) or isinstance(speed, bool) or speed <= 0:
            fails.append(f"{where}: speed must be a positive number")
            continue
        (a, b), (c, d) = r["src"], r["dst"]
        where = f"range {i} ({r.get('take')} {a:.3f}–{b:.3f})"
        if b <= a or d <= c:
            fails.append(f"{where}: empty or reversed src/dst")
            continue
        if abs(c - cursor) > 1e-3:
            fails.append(f"{where}: dst starts at {c:.6f} but the previous range ends at {cursor:.6f}")
        cursor = d
        frames = (d - c) * fps
        if abs(frames - round(frames)) > 1e-3:
            fails.append(f"{where}: dst length {d - c:.6f} s is not a whole number of frames at {fps} fps")
        cum_video += round(frames) / fps
        cum_audio += (b - a) / speed
        drift = abs(cum_audio - cum_video)
        if drift > max_drift:
            max_drift, worst = drift, i

        for sid in r.get("segments") or []:
            seg = by_id.get(sid)
            if seg is None:
                fails.append(f"{where}: segment {sid} is not in data/segments.json")
                continue
            if sid in owner:
                fails.append(f"segment {sid} appears twice (ranges {owner[sid]} and {i})")
            owner.setdefault(sid, i)
            if seg.get("take") != r.get("take"):
                fails.append(f"{where}: segment {sid} belongs to take {seg.get('take')}")
                continue
            for word in seg.get("words") or []:
                if not (isinstance(word, list) and len(word) == 3 and _pair(word[1:])):
                    fails.append(f"{where}: segment {sid} has a malformed word {word!r}; re-run segments.py")
                    break
                t, s, e = word
                ds, de = c + (s - a) / speed, c + (e - a) / speed
                if ds < c - tol or de > d + tol:
                    fails.append(f"{where}: segment {sid} word {t!r} ({s:.3f}–{e:.3f}) maps to {ds:.3f}–{de:.3f}, "
                                 f"outside dst {c:.3f}–{d:.3f}")
                    break
    if max_drift > tol:
        fails.append(f"audio/video drift reaches {max_drift * 1000:.1f} ms at range {worst} (tolerance {tol * 1000:.0f} ms); "
                     "re-run apply-edl.py")
    if abs(cursor - duration) > tol:
        fails.append(f"duration {duration:.3f} s does not match the end of the last range {cursor:.3f} s")
    return fails, max_drift


def main():
    ap = argparse.ArgumentParser(description="Check voice.wav, webcam.mp4 and data/edl-map.json for drift and mapping errors.")
    ap.add_argument("project", help="project directory")
    ap.add_argument("--tolerance-ms", type=float, default=40.0, help="allowed duration mismatch and drift in ms (default 40)")
    args = ap.parse_args()
    if args.tolerance_ms < 0:
        raise StepError("--tolerance-ms must be >= 0")
    tol = args.tolerance_ms / 1000
    root = reclib.project_dir(args.project)
    edl_map = reclib.read_json(root / "data" / "edl-map.json")
    segments = reclib.read_json(root / "data" / "segments.json")
    if not isinstance(edl_map, dict) or not isinstance(segments, list):
        raise StepError("data/edl-map.json must be an object and data/segments.json a list; re-run apply-edl.py")

    fails, drift = check_map(edl_map, segments, tol)
    duration = edl_map.get("duration") if isinstance(edl_map.get("duration"), (int, float)) else 0.0
    voice = root / "assets" / "audio" / "voice.wav"
    webcam = root / "assets" / "video" / "webcam.mp4"
    measured = []
    if not voice.is_file():
        fails.append("assets/audio/voice.wav is missing; run apply-edl.py")
    for path, label in ((voice, "voice.wav"), (webcam, "webcam.mp4")):
        if path.is_file():
            got = reclib.duration(path)
            measured.append(f"{label} {got:.3f} s")
            if abs(got - duration) > tol:
                fails.append(f"{label} lasts {got:.3f} s but edl-map.json says {duration:.3f} s "
                             f"({(got - duration) * 1000:+.0f} ms, tolerance {args.tolerance_ms:.0f} ms)")

    n = len(edl_map.get("ranges") or [])
    print(f"edl-map: {n} ranges, {duration:.3f} s, max drift {drift * 1000:.1f} ms; " + (", ".join(measured) or "no media"))
    for f in fails:
        print(f"error: {f}", file=sys.stderr)
    print(f"check-edl {'FAIL' if fails else 'OK'}")
    return 1 if fails else 0


if __name__ == "__main__":
    reclib.main_guard(main)
