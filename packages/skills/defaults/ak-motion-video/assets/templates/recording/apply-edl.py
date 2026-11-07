"""Cut the takes to the operator's keep list (data/edl.json).

Writes assets/audio/voice.wav (48 kHz stereo PCM), assets/video/webcam.mp4 (30 fps H.264,
no audio; only when every take has video) and data/edl-map.json, which maps source time
to edited time:

  {duration, fps, ranges:[{take, src:[a, b], dst:[c, d], speed, segments:[ids]}]}

data/edl.json: {speed: 1.0, pad: 0.08, keep:[{segments:"g001..g014"} | {segments:["g001","g003"]}
| {take, from, to}]}; every keep entry may set its own speed. Segment ranges keep `pad`
seconds around their edges (clamped to the take and to the neighbouring kept range of the
same take); explicit {take, from, to} windows are kept exactly.

Every range is cut to a whole number of video frames and its audio to exactly the same
length, so audio and webcam cannot drift apart however many cuts the EDL has.
"""
import argparse
import json
import math
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reclib
from reclib import StepError

FPS = 30
RATE = 48000
EPS = 1e-6


def number(value, what, positive=False, minimum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise StepError(f"data/edl.json: {what} must be a number, got {value!r}")
    if positive and value <= 0:
        raise StepError(f"data/edl.json: {what} must be > 0, got {value}")
    if minimum is not None and value < minimum:
        raise StepError(f"data/edl.json: {what} must be >= {minimum}, got {value}")
    return float(value)


def segment_ids(spec, index, where):
    """Resolve "g001..g014", "g005" or ["g001", "g003"] into ids in segment order."""
    if isinstance(spec, str):
        if ".." in spec:
            first, _, last = (p.strip() for p in spec.partition(".."))
        else:
            first = last = spec.strip()
        for sid in (first, last):
            if sid not in index:
                raise StepError(f"{where}: unknown segment {sid!r}; see data/segments.json")
        lo, hi = index[first], index[last]
        if lo > hi:
            raise StepError(f"{where}: range {spec!r} runs backwards")
        return list(range(lo, hi + 1))
    if isinstance(spec, list) and spec:
        out = []
        for sid in spec:
            if not isinstance(sid, str) or sid not in index:
                raise StepError(f"{where}: unknown segment {sid!r}; see data/segments.json")
            out.append(index[sid])
        return out
    raise StepError(f"{where}: segments must be \"gA..gB\" or a non-empty list of ids")


def resolve_keep(edl, segments, takes):
    """Turn keep entries into pieces: {take, a, b, pad, speed, segments} in output order."""
    speed0 = number(edl.get("speed", 1.0), "speed", positive=True)
    pad = number(edl.get("pad", 0.08), "pad", minimum=0)
    keep = edl.get("keep")
    if not isinstance(keep, list) or not keep:
        raise StepError("data/edl.json: keep must be a non-empty list")
    index = {s["id"]: i for i, s in enumerate(segments)}
    pieces, seen = [], {}
    for n, entry in enumerate(keep, 1):
        where = f"data/edl.json keep[{n}]"
        if not isinstance(entry, dict):
            raise StepError(f"{where}: must be an object")
        speed = number(entry.get("speed", speed0), f"keep[{n}].speed", positive=True)
        if "segments" in entry:
            idx = segment_ids(entry["segments"], index, where)
            group = []
            for i in idx:
                seg = segments[i]
                if seg["id"] in seen:
                    raise StepError(f"{where}: segment {seg['id']} is already kept by keep[{seen[seg['id']]}]")
                seen[seg["id"]] = n
                # Consecutive segments of one take stay one piece, pauses included.
                if group and (seg["take"] != group[-1]["take"] or i != index[group[-1]["id"]] + 1):
                    pieces.append(_seg_piece(group, pad, speed, n))
                    group = []
                group.append(seg)
            pieces.append(_seg_piece(group, pad, speed, n))
        elif {"take", "from", "to"} <= entry.keys():
            take = entry["take"]
            if take not in takes:
                raise StepError(f"{where}: unknown take {take!r}; takes: {', '.join(takes)}")
            a = number(entry["from"], f"keep[{n}].from", minimum=0)
            b = number(entry["to"], f"keep[{n}].to")
            dur = takes[take]["duration"]
            if b <= a:
                raise StepError(f"{where}: to ({b}) must be after from ({a})")
            if a >= dur:
                raise StepError(f"{where}: from ({a}) is past the end of {take} ({dur:.3f} s)")
            ids = [s["id"] for s in segments if s["take"] == take and s["start"] >= a - EPS and s["end"] <= b + EPS]
            for sid in ids:
                if sid in seen:
                    raise StepError(f"{where}: segment {sid} is already kept by keep[{seen[sid]}]")
                seen[sid] = n
            pieces.append({"take": take, "ra": a, "rb": min(b, dur), "pad": 0.0, "speed": speed, "segments": ids, "entry": n})
        else:
            raise StepError(f"{where}: needs \"segments\" or \"take\", \"from\" and \"to\"")
    return pieces


def _seg_piece(group, pad, speed, n):
    return {"take": group[0]["take"], "ra": group[0]["start"], "rb": max(s["end"] for s in group), "pad": pad,
            "speed": speed, "segments": [s["id"] for s in group], "entry": n}


def pad_and_merge(pieces, takes):
    """Apply pads without crossing the take bounds or a neighbouring kept range, then merge touching pieces."""
    by_take = {}
    for p in pieces:
        p["a"], p["b"] = max(0.0, p["ra"] - p["pad"]), min(takes[p["take"]]["duration"], p["rb"] + p["pad"])
        by_take.setdefault(p["take"], []).append(p)
    for take, group in by_take.items():
        group.sort(key=lambda p: p["ra"])
        for prev, nxt in zip(group, group[1:]):  # noqa: RUF007 - itertools.pairwise needs Python 3.10
            if prev["rb"] > nxt["ra"] + EPS:
                raise StepError(f"keep[{prev['entry']}] and keep[{nxt['entry']}] overlap in {take} "
                                f"({prev['ra']:.3f}–{prev['rb']:.3f} vs {nxt['ra']:.3f}–{nxt['rb']:.3f})")
            if prev["b"] > nxt["a"]:
                mid = (prev["rb"] + nxt["ra"]) / 2
                prev["b"], nxt["a"] = min(prev["b"], mid), max(nxt["a"], mid)
    merged = []
    for p in pieces:
        last = merged[-1] if merged else None
        if last and last["take"] == p["take"] and last["speed"] == p["speed"] and abs(last["b"] - p["a"]) <= EPS:
            last["b"] = p["b"]
            last["segments"] += p["segments"]
        else:
            merged.append(dict(p))
    return merged


def quantise(ranges, takes):
    """Give each range a whole number of frames; extend the source end to match (never past the take)."""
    frame = 0
    for r in ranges:
        dur, speed = takes[r["take"]]["duration"], r["speed"]
        n = math.ceil((r["b"] - r["a"]) / speed * FPS - 1e-6)
        if r["a"] + n * speed / FPS > dur + EPS:
            n = math.floor((dur - r["a"]) / speed * FPS + 1e-6)
        if n < 1:
            raise StepError(f"keep[{r['entry']}] in {r['take']} is shorter than one frame")
        r["n"] = n
        r["b"] = r["a"] + n * speed / FPS
        r["frame0"] = frame
        frame += n
    return frame


def display_size(path):
    """Displayed width and height of the first video stream (rotation applied), rounded down to even."""
    out = reclib.run([reclib.need("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
                      "stream=width,height:stream_tags=rotate:stream_side_data=rotation", "-of", "json", str(path)], capture=True)
    try:
        stream = json.loads(out)["streams"][0]
        w, h = int(stream["width"]), int(stream["height"])
    except (ValueError, KeyError, IndexError, TypeError) as err:
        raise StepError(f"ffprobe could not read the frame size of {path}") from err
    rot = stream.get("tags", {}).get("rotate")
    for side in stream.get("side_data_list", []) or []:
        rot = side.get("rotation", rot)
    try:
        if int(float(rot or 0)) % 180:
            w, h = h, w
    except ValueError:
        pass
    return max(2, w // 2 * 2), max(2, h // 2 * 2)


def graph(ranges, inputs, kind, size=None):
    parts, labels = [], []
    for i, r in enumerate(ranges):
        k, a, b, speed = inputs[r["take"]], r["a"], r["b"], r["speed"]
        if kind == "a":
            tempo = "" if speed == 1 else "," + reclib.atempo_chain(speed)
            samples = r["n"] * RATE // FPS
            parts.append(f"[{k}:a:0]atrim=start={a:.6f}:end={b:.6f},asetpts=PTS-STARTPTS,aresample={RATE},"
                         f"aformat=sample_fmts=fltp:channel_layouts=stereo{tempo},apad,atrim=end_sample={samples},"
                         f"asetpts=N/SR/TB[a{i}]")
            labels.append(f"[a{i}]")
        else:
            w, h = size
            parts.append(f"[{k}:v:0]trim=start={a:.6f}:end={b:.6f},setpts=(PTS-STARTPTS)/{speed:.6f},fps={FPS},"
                         f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,"
                         f"format=yuv420p,tpad=stop_mode=clone:stop={r['n']},trim=end_frame={r['n']},"
                         f"setpts=N/({FPS}*TB)[v{i}]")
            labels.append(f"[v{i}]")
    out = "[aout]" if kind == "a" else "[vout]"
    v, a = (0, 1) if kind == "a" else (1, 0)
    parts.append(f"{''.join(labels)}concat=n={len(labels)}:v={v}:a={a}{out}")
    return ";\n".join(parts) + "\n", out


def render(ranges, take_paths, kind, out_path, size=None):
    """Run one ffmpeg pass from a filter-graph file and replace out_path atomically."""
    used = list(dict.fromkeys(r["take"] for r in ranges))
    inputs = {t: i for i, t in enumerate(used)}
    text, label = graph(ranges, inputs, kind, size)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fd, script = tempfile.mkstemp(prefix="edl-graph-", suffix=".txt")
    tmp_out = out_path.with_name(f".{out_path.stem}.partial{out_path.suffix}")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        args = []
        for t in used:
            args += ["-i", str(take_paths[t])]
        args += [reclib.filter_script_option(), script, "-map", label]
        if kind == "a":
            args += ["-c:a", "pcm_s16le", "-ar", str(RATE), "-ac", "2", str(tmp_out)]
        else:
            args += ["-an", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
                     "-movflags", "+faststart", str(tmp_out)]
        reclib.ffmpeg(args)
        os.replace(tmp_out, out_path)
    finally:
        Path(script).unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)


def load_inputs(root):
    transcript = reclib.read_json(root / "data" / "transcript.json")
    segments = reclib.read_json(root / "data" / "segments.json")
    edl = reclib.read_json(root / "data" / "edl.json")
    if not isinstance(transcript, dict) or not isinstance(transcript.get("takes"), dict) or not transcript["takes"]:
        raise StepError("data/transcript.json has no takes; run transcribe.py")
    if not isinstance(segments, list) or not all(isinstance(s, dict) and {"id", "take", "start", "end"} <= s.keys() for s in segments):
        raise StepError("data/segments.json is not a segment list; run segments.py")
    if not isinstance(edl, dict):
        raise StepError("data/edl.json must be an object with a keep list")
    takes, paths = {}, {}
    for name, info in transcript["takes"].items():
        path = Path(info.get("path", ""))
        path = path if path.is_absolute() else root / path
        if not path.is_file():
            raise StepError(f"take {name}: media not found at {path}")
        takes[name] = {"duration": float(info.get("duration") or reclib.duration(path))}
        paths[name] = path
    unknown = sorted({s["take"] for s in segments} - takes.keys())
    if unknown:
        raise StepError(f"data/segments.json uses takes missing from the transcript: {', '.join(unknown)}; re-run segments.py")
    return takes, paths, segments, edl


def main():
    ap = argparse.ArgumentParser(description="Cut the takes to data/edl.json: voice.wav, webcam.mp4 and data/edl-map.json.")
    ap.add_argument("project", help="project directory")
    args = ap.parse_args()
    root = reclib.project_dir(args.project)
    takes, paths, segments, edl = load_inputs(root)

    ranges = pad_and_merge(resolve_keep(edl, segments, takes), takes)
    frames = quantise(ranges, takes)

    used = list(dict.fromkeys(r["take"] for r in ranges))
    with_video = [t for t in used if reclib.has_video(paths[t])]
    render(ranges, paths, "a", root / "assets" / "audio" / "voice.wav")
    webcam = root / "assets" / "video" / "webcam.mp4"
    if with_video and len(with_video) == len(used):
        size = display_size(paths[with_video[0]])
        render(ranges, paths, "v", webcam, size)
    else:
        if with_video:
            missing = ", ".join(t for t in used if t not in with_video)
            print(f"warning: takes without video ({missing}); webcam.mp4 not written", file=sys.stderr)
        if webcam.is_file():
            webcam.unlink()
            print("removed stale assets/video/webcam.mp4 (the kept takes have no video)", file=sys.stderr)

    edl_map = {
        "duration": round(frames / FPS, 6),
        "fps": FPS,
        "ranges": [{"take": r["take"], "src": [round(r["a"], 6), round(r["b"], 6)],
                    "dst": [round(r["frame0"] / FPS, 6), round((r["frame0"] + r["n"]) / FPS, 6)],
                    "speed": r["speed"], "segments": r["segments"]} for r in ranges],
    }
    reclib.write_json(root / "data" / "edl-map.json", edl_map)

    source = sum(takes[t]["duration"] for t in takes)
    kept = sum(r["b"] - r["a"] for r in ranges)
    edited = edl_map["duration"]
    saved = (1 - edited / source) * 100 if source else 0.0
    print(f"{len(ranges)} ranges · source {source:.2f} s (kept {kept:.2f} s) · edited {edited:.2f} s · saved {saved:.1f}%")
    print("wrote assets/audio/voice.wav" + (", assets/video/webcam.mp4" if webcam.is_file() else "") + ", data/edl-map.json")


if __name__ == "__main__":
    reclib.main_guard(main)
