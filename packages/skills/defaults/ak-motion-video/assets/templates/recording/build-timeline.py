"""Build the master timeline of a recording-driven video.

Maps the transcript segments through the edit (data/edl-map.json) onto the edited
voice, cuts the scenes of data/script.json at their first kept segment (snapped to
the music beat when data/music-arrangement.json exists), times the captions
(data/captions-vi.json, else the spoken words), computes the per-frame voice
envelope, writes data/timeline.json (TIMING without env, plus mode:"recording")
and injects window.TIMING into index.html, same shape as the TTS mode.

Usage: python -X utf8 build-timeline.py <project> [--fps 30] [--dry] [--no-env]
"""
import argparse
import json
import math
import re
import sys
import tempfile
from collections import Counter
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reclib  # noqa: E402

MAX_CHUNK = 9  # caption words per chunk
SNAP = 0.25  # a scene start snaps to a beat this close
CAP_LEAD = 0.12  # a caption shows this long before its first word
MIN_SCENE, MAX_SCENE, MIN_CAPTION = 1.5, 20.0, 0.5
EPS = 1e-3
PUNCT = re.compile(r"[,.:;?!]$")


def warn(msg):
    print(f"warning: {msg}")


class EditMap:
    """Source (take, seconds) -> edited seconds through the kept ranges of edl-map.json."""

    def __init__(self, data):
        try:
            self.duration = float(data["duration"])
            self.ranges = [
                (str(r.get("take", "")), float(r["src"][0]), float(r["src"][1]), float(r["dst"][0]), float(r.get("speed", 1.0) or 1.0))
                for r in data["ranges"]
            ]
        except (KeyError, TypeError, ValueError, IndexError) as err:
            raise reclib.StepError(f"edl-map.json: expected {{duration, ranges:[{{take, src:[a,b], dst:[c,d], speed}}]}} ({err})") from err

    def find(self, take, t):
        for rng in self.ranges:
            if (not rng[0] or not take or rng[0] == take) and rng[1] - EPS <= t <= rng[2] + EPS:
                return rng
        return None

    @staticmethod
    def at(rng, t):
        _, a, b, c, speed = rng
        return c + (min(max(t, a), b) - a) / speed


def load_segments(path):
    segs = reclib.read_json(path)
    if not isinstance(segs, list):
        raise reclib.StepError(f"{path}: expected a list of segments")
    out = []
    for seg in segs:
        try:
            words = [(str(w[0]), float(w[1]), float(w[2])) for w in seg.get("words", [])]
            out.append({"id": str(seg["id"]), "take": str(seg.get("take", "")), "start": float(seg["start"]), "end": float(seg["end"]), "text": str(seg.get("text", "")), "words": words})
        except (KeyError, TypeError, ValueError, IndexError) as err:
            raise reclib.StepError(f"{path}: malformed segment {seg!r:.80} ({err})") from err
    return out


def map_segment(seg, emap):
    """Kept words of one segment in edited time; None when the edit drops every word."""
    words = []
    for text, s, e in seg["words"]:
        rng = emap.find(seg["take"], s)
        if rng is None:
            continue
        ms = emap.at(rng, s)
        words.append((text, ms, max(ms, emap.at(rng, e))))
    if not words:
        return None
    rng = emap.find(seg["take"], seg["start"])
    start = min(emap.at(rng, seg["start"]), words[0][1]) if rng else words[0][1]
    return {"id": seg["id"], "start": start, "on": words[0][1], "off": words[-1][2], "words": words}


def resolve_scenes(script, segs, mapped):
    """Scene list with the kept segments of each and a raw start (None when nothing is kept)."""
    order = {s["id"]: i for i, s in enumerate(segs)}
    scenes, seen = [], {}
    for i, sc in enumerate(script):
        sid = sc.get("id")
        if not sid:
            raise reclib.StepError(f"script.json scene #{i + 1} has no id")
        if "from" in sc:
            a, b = sc["from"], sc.get("to", sc["from"])
            if a not in order or b not in order:
                raise reclib.StepError(f"{sid}: unknown segment {a if a not in order else b}")
            if order[b] < order[a]:
                raise reclib.StepError(f"{sid}: segment range {a}..{b} runs backwards")
            ids = [s["id"] for s in segs[order[a]:order[b] + 1]]
            for gid in ids:
                if gid in seen:
                    warn(f"{gid} is referenced by {seen[gid]} and {sid}")
                seen.setdefault(gid, sid)
            kept = sorted((mapped[g] for g in ids if mapped.get(g)), key=lambda m: m["on"])
            start = min(m["start"] for m in kept) if kept else None
        elif "start" in sc:
            try:
                start, end = float(sc["start"]), float(sc["end"]) if sc.get("end") is not None else math.inf
            except (TypeError, ValueError) as err:
                raise reclib.StepError(f"{sid}: start/end must be seconds") from err
            kept = [m for m in mapped.values() if m and start - EPS <= m["on"] < end]
            kept.sort(key=lambda m: m["on"])
        else:
            raise reclib.StepError(f"{sid}: give from/to segment ids or start/end seconds")
        if not kept:
            warn(f"{sid}: no kept words")
        scenes.append({"id": sid, "start": start, "segs": kept})
    return scenes


def place_scenes(scenes, duration, arrangement):
    beat0 = beat_len = None
    if arrangement:
        beat0, beat_len = float(arrangement["beat0"]), 60.0 / float(arrangement["bpm"])
    # a scene without kept words collapses onto the next scene's start
    nxt = duration
    for sc in reversed(scenes):
        if sc["start"] is None:
            sc["start"] = nxt
        nxt = sc["start"]
    prev = 0.0
    for i, sc in enumerate(scenes):
        t = 0.0 if i == 0 else sc["start"]
        if i and beat_len:
            b = beat0 + round((t - beat0) / beat_len) * beat_len
            if abs(b - t) <= SNAP + EPS and b >= prev:
                t = b
        if t < prev:
            warn(f"{sc['id']}: starts at {t:.2f}, before the previous scene ({prev:.2f}); clamped")
            t = prev
        sc["start"] = min(t, duration)
        prev = sc["start"]
    for i, sc in enumerate(scenes):
        sc["end"] = scenes[i + 1]["start"] if i + 1 < len(scenes) else duration
    return beat0, beat_len


def check_order(scenes):
    """Fail when a scene's speech lies outside its window: script scenes must follow the EDL's output order."""
    uses = Counter(seg["id"] for sc in scenes for seg in sc["segs"])  # a segment used twice is already warned about
    bad = [f"{sc['id']} ({seg['id']} at {seg['on']:.2f}-{seg['off']:.2f}s, window {sc['start']:.2f}-{sc['end']:.2f}s)"
           for sc in scenes for seg in sc["segs"]
           if uses[seg["id"]] == 1 and (seg["on"] < sc["start"] - SNAP - EPS or seg["off"] > sc["end"] + SNAP + EPS)]
    if bad:
        raise reclib.StepError("speech falls outside its scene; order the script scenes as the EDL keeps them: " + "; ".join(bad[:5]))


def caption_words(seg, vi):
    """[(text, onset)] for one segment: Vietnamese tokens borrow proportional onsets of the spoken words."""
    spoken = seg["words"]
    if vi:
        toks = vi.split()
        words = [[t, spoken[min(len(spoken) - 1, (i * len(spoken)) // len(toks))][1]] for i, t in enumerate(toks)]
    else:
        words = [[t, s] for t, s, _ in spoken if t.strip()]
    for i in range(1, len(words)):
        if words[i][1] <= words[i - 1][1]:
            words[i][1] = reclib.r3(words[i - 1][1] + 0.07)
    return words


def chunk(words):
    """Split at punctuation or at most MAX_CHUNK words, balancing what is left so no chunk is one orphan word."""
    out, cur, size = [], [], MAX_CHUNK
    for i, w in enumerate(words):
        if not cur:
            n = len(words) - i
            size = math.ceil(n / math.ceil(n / MAX_CHUNK))
        cur.append(w)
        left = len(words) - i - 1
        if left == 0:
            break
        punct = bool(PUNCT.search(w[0]))
        if (punct and len(cur) >= 3 and left >= 2 and len(words) > MAX_CHUNK) or len(cur) >= size:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def build_captions(scenes, vi_map):
    caps = []
    for sc in scenes:
        for seg in sc["segs"]:
            words = caption_words(seg, str(vi_map.get(seg["id"], "") or "").strip())
            for c in chunk(words):
                caps.append({"scene": sc, "lineOff": seg["off"], "words": c})
    caps.sort(key=lambda c: c["words"][0][1])
    for i, c in enumerate(caps):
        sc = c["scene"]
        nxt = caps[i + 1] if i + 1 < len(caps) else None
        start = max(sc["start"], c["words"][0][1] - CAP_LEAD)
        natural = nxt["words"][0][1] - CAP_LEAD if nxt and nxt["lineOff"] == c["lineOff"] else c["lineOff"] + 0.5
        end = min(natural, nxt["words"][0][1] - 0.16) if nxt else natural
        end = max(min(end, sc["end"]), start)
        c["start"], c["end"] = reclib.r3(start), reclib.r3(end)
        if end - start < MIN_CAPTION:
            warn(f"{sc['id']}: caption \"{' '.join(w[0] for w in c['words'])[:40]}\" lasts {end - start:.2f}s")
    return [{"start": c["start"], "end": c["end"], "words": [[w[0], reclib.r3(w[1])] for w in c["words"]]} for c in caps]


def load_sfx(path):
    if not path.exists():
        return []
    cues = reclib.read_json(path)
    if not isinstance(cues, list):
        raise reclib.StepError(f"{path}: expected a list of {{sfx, vol, t}}")
    out = []
    for c in cues:
        try:
            out.append({"sfx": str(c["sfx"]), "vol": float(c.get("vol", 0.5)), "t": max(0.0, reclib.r3(c["t"]))})
        except (KeyError, TypeError, ValueError) as err:
            raise reclib.StepError(f"{path}: recording mode takes absolute cues {{sfx, vol, t}} ({c!r:.80})") from err
    return out


def envelope(voice, duration, fps):
    """Per-frame RMS of the voice, normalised by the 90th percentile of the non-silent frames."""
    rate = 24000
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "env.f32"
        reclib.ffmpeg(["-i", str(voice), "-ac", "1", "-ar", str(rate), "-f", "f32le", str(raw)])
        samples = array("f")
        samples.frombytes(raw.read_bytes()[: (raw.stat().st_size // 4) * 4])
    if sys.byteorder != "little":
        samples.byteswap()
    per = rate / fps
    frames = int(math.ceil(duration * fps - 1e-6))
    rms = []
    for f in range(frames):
        a, b = int(round(f * per)), int(round((f + 1) * per))
        chunk_ = samples[a:b]
        rms.append(math.sqrt(sum(x * x for x in chunk_) / (b - a)) if chunk_ else 0.0)
    loud = sorted(x for x in rms if x > 0.005)
    ref = loud[int(len(loud) * 0.9)] if loud else 1.0
    return [round(min(1.0, x / ref), 2) for x in rms]


def inject(html_path, timing, duration):
    if not html_path.exists():
        warn(f"{html_path} not found; TIMING not injected")
        return False
    html = html_path.read_text(encoding="utf-8")
    if "/*TIMING:BEGIN*/" not in html or "/*TIMING:END*/" not in html:
        warn(f"{html_path} has no /*TIMING:BEGIN*/ /*TIMING:END*/ markers; TIMING not injected")
        return False
    payload = json.dumps(timing, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    block = f"/*TIMING:BEGIN*/window.TIMING={payload};/*TIMING:END*/"
    html = re.sub(r"/\*TIMING:BEGIN\*/[\s\S]*?/\*TIMING:END\*/", lambda _: block, html, count=1)
    dur = f"{duration:g}"
    # the studio may prepend data-hf-id attributes, so match id anywhere in the tag
    html = re.sub(r'(<div\b[^>]*?\bid="root"[^>]*?data-duration=")[\d.]+"', lambda m: f'{m.group(1)}{dur}"', html)
    html = re.sub(r'(<audio\b[^>]*?\bid="mix"[^>]*?data-duration=")[\d.]+"', lambda m: f'{m.group(1)}{dur}"', html)
    html_path.write_text(html, encoding="utf-8", newline="\n")
    return True


def table(scenes):
    for sc in scenes:
        lines = " | ".join(f"{s['on']:.2f}-{s['off']:.2f}" for s in sc["segs"])
        print(f"{sc['id'][:18]:<18} {sc['start']:7.2f} -> {sc['end']:7.2f} ({sc['end'] - sc['start']:5.2f}s) {len(sc['segs']):2d} seg  {lines}")


def main():
    ap = argparse.ArgumentParser(description="Build data/timeline.json and inject TIMING for a recording-driven project.")
    ap.add_argument("project", help="project directory")
    ap.add_argument("--fps", type=int, default=30, help="composition frame rate (default 30)")
    ap.add_argument("--dry", action="store_true", help="print the schedule only; write nothing")
    ap.add_argument("--no-env", action="store_true", help="reuse data/vo-envelope.json instead of measuring the voice")
    args = ap.parse_args()
    if args.fps <= 0:
        raise reclib.StepError("--fps must be positive")
    root = reclib.project_dir(args.project)
    data = root / "data"

    script = reclib.read_json(data / "script.json")
    if not isinstance(script, dict) or not isinstance(script.get("scenes"), list) or not script["scenes"]:
        raise reclib.StepError("script.json: expected {mode:\"recording\", scenes:[...]}")
    if script.get("mode", "recording") != "recording":
        warn(f"script.json mode is {script.get('mode')!r}; building as recording mode")
    segs = load_segments(data / "segments.json")
    emap = EditMap(reclib.read_json(data / "edl-map.json"))
    duration = reclib.r3(emap.duration)
    arrangement = reclib.read_json(data / "music-arrangement.json") if (data / "music-arrangement.json").exists() else None
    if arrangement is not None:
        try:
            if float(arrangement["bpm"]) <= 0:
                raise ValueError("bpm must be positive")
            float(arrangement["beat0"])
        except (KeyError, TypeError, ValueError) as err:
            raise reclib.StepError(f"music-arrangement.json: expected {{bpm, beat0}} ({err})") from err
    vi_map = reclib.read_json(data / "captions-vi.json", default={}) if (data / "captions-vi.json").exists() else {}

    mapped = {s["id"]: map_segment(s, emap) for s in segs}
    scenes = resolve_scenes(script["scenes"], segs, mapped)
    beat0, beat_len = place_scenes(scenes, duration, arrangement)
    check_order(scenes)
    for sc in scenes:
        span = sc["end"] - sc["start"]
        if span < MIN_SCENE:
            warn(f"{sc['id']}: only {span:.2f}s long")
        elif span > MAX_SCENE:
            warn(f"{sc['id']}: {span:.1f}s long; split it or add a visual beat to avoid monotony")
    if args.dry:
        table(scenes)
        return 0

    captions = build_captions(scenes, vi_map)
    sfx = load_sfx(data / "cues.json")
    if beat_len is None:
        beat0, beat_len = 0.0, 0.5
    last_beat = max(0, int(math.floor((duration - beat0) / beat_len)))
    arr = arrangement or {}
    outro = (arr.get("fadeOut") or {}).get("beat") if isinstance(arr.get("fadeOut"), dict) else None
    timing = {
        "duration": duration,
        "fps": args.fps,
        "beat0": reclib.r3(beat0),
        "beatLen": round(beat_len, 6),
        "kick": arr.get("kick", []),
        "drops": arr.get("drops", []),
        "outroBeat": outro if outro is not None else arr.get("outroBeat", last_beat),
        "scenes": {
            sc["id"]: {
                "start": reclib.r3(sc["start"]),
                "end": reclib.r3(sc["end"]),
                "lines": [
                    {"on": reclib.r3(s["on"]), "off": reclib.r3(s["off"]), "words": [[w, reclib.r3(a), reclib.r3(b)] for w, a, b in ((reclib.norm(t), a, b) for t, a, b in s["words"]) if w]}
                    for s in sc["segs"]
                ],
            }
            for sc in scenes
        },
        "captions": captions,
        "sfx": sfx,
    }
    if len(timing["scenes"]) != len(scenes):
        raise reclib.StepError("script.json has duplicate scene ids")

    env_path = data / "vo-envelope.json"
    if args.no_env:
        env = reclib.read_json(env_path, default=[]) if env_path.exists() else []
        if not env:
            warn("--no-env: data/vo-envelope.json missing or empty; env is []")
    else:
        voice = root / "assets/audio/voice.wav"
        if not voice.exists():
            raise reclib.StepError(f"missing {voice}; run apply-edl.py first (or pass --no-env)")
        env = envelope(voice, duration, args.fps)
        env_path.write_text(json.dumps(env, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")

    reclib.write_json(data / "timeline.json", {**timing, "mode": "recording"})
    injected = inject(root / "index.html", {**timing, "mode": "recording", "env": env}, duration)
    table(scenes)
    print(f"timeline -> {data / 'timeline.json'} ({duration:.2f}s, {len(scenes)} scenes, captions {len(captions)}, sfx {len(sfx)}, env frames {len(env)}{', TIMING injected' if injected else ''})")
    return 0


if __name__ == "__main__":
    reclib.main_guard(main)
