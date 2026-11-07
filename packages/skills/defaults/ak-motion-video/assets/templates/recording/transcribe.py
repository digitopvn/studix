"""Transcribe the raw takes into word timestamps: data/transcript.json.

Default engine: ElevenLabs Scribe through `multix elevenlabs transcribe` (one JSON per
take under data/transcribe/, reused unless --force). Offline: import a Whisper or
faster-whisper JSON with word timestamps for one take (--import FILE --take NAME).

Output: {engine, language, takes:{<take>:{path, duration}}, words:[{t, s, e, take}]}
in source seconds, ordered by take then time.
"""
import argparse
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reclib
from reclib import StepError

MEDIA_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".wav", ".m4a", ".mp3", ".aac", ".flac", ".ogg"}


def natural_key(name):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r"(\d+)", name)]


def rel(root, path):
    path = Path(path).resolve()
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def discover_takes(root, inputs):
    """Map take name -> media path, from --input paths or raw/*."""
    if inputs:
        files = [Path(p).resolve() for p in inputs]
        missing = [str(f) for f in files if not f.is_file()]
        if missing:
            raise StepError(f"input not found: {', '.join(missing)}")
    else:
        raw = root / "raw"
        files = sorted((f for f in raw.glob("*") if f.is_file() and f.suffix.lower() in MEDIA_EXT), key=lambda f: natural_key(f.name)) if raw.is_dir() else []
        if not files:
            raise StepError(f"no audio or video takes in {raw}; put the recordings there or pass --input")
    takes = {}
    for f in files:
        if f.stem in takes:
            raise StepError(f"two takes share the name {f.stem!r}: {takes[f.stem].name} and {f.name}; rename one")
        takes[f.stem] = f
    return takes


def find_media(root, take, inputs):
    if inputs:
        if len(inputs) != 1:
            raise StepError("--import takes exactly one --input (the media of that take)")
        path = Path(inputs[0]).resolve()
        if not path.is_file():
            raise StepError(f"input not found: {path}")
        return path
    raw = root / "raw"
    for f in sorted(raw.glob(f"{take}.*")) if raw.is_dir() else []:
        if f.is_file() and f.suffix.lower() in MEDIA_EXT and f.stem == take:
            return f.resolve()
    raise StepError(f"no media for take {take!r} in {raw}; add raw/{take}.<ext> or pass --input")


def _num(value, where):
    try:
        out = float(value)
    except (TypeError, ValueError) as err:
        raise StepError(f"{where}: timestamp {value!r} is not a number") from err
    if not math.isfinite(out) or out < 0:
        raise StepError(f"{where}: invalid timestamp {value!r}")
    return out


def clean_words(raw_words, take, where):
    words = []
    for i, w in enumerate(raw_words):
        if not isinstance(w, dict):
            raise StepError(f"{where}: word {i} is not an object")
        text = str(w.get("word", w.get("text", "")) or "").strip()
        if not text:
            continue
        s, e = _num(w.get("start"), f"{where} word {i}"), _num(w.get("end"), f"{where} word {i}")
        if e < s:
            raise StepError(f"{where}: word {i} ({text!r}) ends before it starts")
        words.append({"t": text, "s": reclib.r3(s), "e": reclib.r3(e), "take": take})
    words.sort(key=lambda w: (w["s"], w["e"]))
    return words


def parse_scribe(data, take, where):
    """ElevenLabs Scribe: {language_code, text, words:[{text, start, end, type}]}; keep spoken words."""
    if not isinstance(data, dict) or not isinstance(data.get("words"), list):
        raise StepError(f"{where}: not an ElevenLabs Scribe JSON (no words list); was it run with --format json?")
    spoken = [w for w in data["words"] if isinstance(w, dict) and w.get("type", "word") == "word"]
    return clean_words(spoken, take, where), data.get("language_code")


def parse_whisper(data, take, where):
    """Whisper / faster-whisper: {segments:[{words:[{word,start,end}]}]} or a top-level words list."""
    if isinstance(data, list):
        raw_words, language = data, None
    elif isinstance(data, dict) and isinstance(data.get("segments"), list):
        raw_words = [w for seg in data["segments"] if isinstance(seg, dict) for w in (seg.get("words") or [])]
        language = data.get("language")
    elif isinstance(data, dict) and isinstance(data.get("words"), list):
        raw_words, language = data["words"], data.get("language")
    else:
        raise StepError(f"{where}: no word timestamps found; export Whisper JSON with word_timestamps=True")
    words = clean_words(raw_words, take, where)
    if not words:
        raise StepError(f"{where}: no word timestamps found; export Whisper JSON with word_timestamps=True")
    return words, language


def cmd_quote(value):
    """cmd.exe quoting for the multix.cmd shim: double quotes, keep %VAR% literal."""
    return '"' + str(value).replace('"', '""').replace("%", '"^%"') + '"'


def run_multix(argv, cwd):
    """POSIX runs multix without a shell; Windows needs cmd.exe to resolve the multix.cmd shim."""
    reclib.need("multix")
    if sys.platform == "win32":
        line = "multix " + " ".join(cmd_quote(a) for a in argv)
        proc = subprocess.run(line, shell=True, cwd=cwd, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace")
    else:
        proc = subprocess.run(["multix", *argv], cwd=cwd, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-800:]
        raise StepError(f"multix exited {proc.returncode}: {tail}")


def transcribe_elevenlabs(root, takes, language, force):
    out_dir = root / "data" / "transcribe"
    out_dir.mkdir(parents=True, exist_ok=True)
    words, detected = [], None
    with tempfile.TemporaryDirectory(prefix="ak-transcribe-") as work:
        for take, media in takes.items():
            out = out_dir / f"{take}.json"
            if force or not out.is_file():
                argv = ["elevenlabs", "transcribe", "--input", str(media), "--timestamps-granularity", "word", "--format", "json", "--output", str(out)]
                if language:
                    argv += ["--language", language]
                print(f"transcribing {take} ...", flush=True)
                run_multix(argv, work)
                if not out.is_file():
                    raise StepError(f"multix did not write {out}")
            take_words, lang = parse_scribe(reclib.read_json(out), take, rel(root, out))
            words += take_words
            detected = detected or lang
    return words, language or detected


def take_entry(root, media, words):
    try:
        dur = reclib.duration(media)
    except StepError:
        dur = max((w["e"] for w in words), default=0.0)
    return {"path": rel(root, media), "duration": reclib.r3(dur)}


def order_words(takes, words):
    rank = {t: i for i, t in enumerate(takes)}
    return sorted(words, key=lambda w: (rank[w["take"]], w["s"], w["e"]))


def main():
    ap = argparse.ArgumentParser(description="Transcribe raw/<take>.* into data/transcript.json (word timestamps).")
    ap.add_argument("project", help="project directory")
    ap.add_argument("--engine", choices=["elevenlabs", "whisper-json"], help="elevenlabs (default) or whisper-json (with --import)")
    ap.add_argument("--language", help="ISO language code passed to the transcriber (auto-detect when omitted)")
    ap.add_argument("--import", dest="import_file", metavar="FILE", help="Whisper/faster-whisper JSON with word timestamps for one take")
    ap.add_argument("--take", help="take name for --import (matches raw/<take>.*)")
    ap.add_argument("--input", nargs="+", metavar="PATH", help="media files instead of raw/* (with --import: the one media file of that take)")
    ap.add_argument("--force", action="store_true", help="re-transcribe takes that already have data/transcribe/<take>.json")
    args = ap.parse_args()

    root = reclib.project_dir(args.project)
    engine = args.engine or ("whisper-json" if args.import_file else "elevenlabs")
    transcript_path = root / "data" / "transcript.json"

    if engine == "whisper-json":
        if not args.import_file or not args.take:
            raise StepError("--engine whisper-json needs --import FILE --take NAME")
        if not re.fullmatch(r"[\w.-]+", args.take):
            raise StepError(f"take name {args.take!r} may use letters, digits, '.', '_' and '-' only")
        src = Path(args.import_file).resolve()
        words, lang = parse_whisper(reclib.read_json(src), args.take, src.name)
        media = find_media(root, args.take, args.input)
        old = reclib.read_json(transcript_path) if transcript_path.is_file() else {"takes": {}, "words": []}
        takes = {k: v for k, v in (old.get("takes") or {}).items() if k != args.take}
        takes[args.take] = take_entry(root, media, words)
        takes = dict(sorted(takes.items(), key=lambda kv: natural_key(kv[0])))
        kept = [w for w in old.get("words") or [] if w.get("take") != args.take and w.get("take") in takes]
        old_engine = old.get("engine")
        engine_out = engine if not old_engine or old_engine == engine or not kept else "mixed"
        data = {"engine": engine_out, "language": args.language or lang or old.get("language"), "takes": takes, "words": order_words(takes, kept + words)}
        report = [args.take]
    else:
        if args.import_file:
            raise StepError("--import works with --engine whisper-json")
        media = discover_takes(root, args.input)
        words, lang = transcribe_elevenlabs(root, media, args.language, args.force)
        takes = {t: take_entry(root, m, [w for w in words if w["take"] == t]) for t, m in media.items()}
        data = {"engine": engine, "language": lang, "takes": takes, "words": order_words(takes, words)}
        report = list(takes)

    reclib.write_json(transcript_path, data)
    for take in report:
        n = sum(1 for w in data["words"] if w["take"] == take)
        print(f"{take}: {n} words, {data['takes'][take]['duration']:.2f} s")
        last = max((w["e"] for w in data["words"] if w["take"] == take), default=0.0)
        if n == 0:
            print(f"warning: {take} has no spoken words", file=sys.stderr)
        elif last > data["takes"][take]["duration"] + 0.05:
            print(f"warning: {take} has words up to {last:.2f} s, past the end of its media; is this the right transcript?", file=sys.stderr)
    print(f"wrote {rel(root, transcript_path)} ({len(data['words'])} words, {len(data['takes'])} takes, language {data['language'] or 'unknown'})")


if __name__ == "__main__":
    reclib.main_guard(main)
