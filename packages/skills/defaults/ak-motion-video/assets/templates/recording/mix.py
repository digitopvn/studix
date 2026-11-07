"""Mix the edited voice with optional ducked music into assets/audio/mix.m4a.

The voice (assets/audio/voice.wav) is levelled to -16 LUFS. Music (--music or
data/music.json {file, db}) is looped, trimmed to the voice duration plus a 2 s
tail, levelled to --music-db LUFS and side-chain ducked under the voice by about
--duck-db. The premix is two-pass loudness-normalised to -14 LUFS / -1.5 dBTP
and written as AAC 192k 48 kHz stereo with the voice duration. Stems
(stem-voice.wav, stem-music.wav with the tail) carry the same gain as the mix.

Usage: python -X utf8 mix.py <project> [--music FILE] [--music-db -20] [--duck-db 8]
"""
import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reclib  # noqa: E402

FMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"
LN = "loudnorm=I=-14:TP=-1.5:LRA=11"
VOICE_LUFS = -16.0
TAIL = 2.0  # music kept after the voice in the music stem (shorts tails)
SPEECH_OVER = 16.0  # dB the side-chain sits above the compressor threshold while speaking


def loudness(path):
    """Integrated loudness (LUFS) and true peak (dBTP) from ebur128."""
    log = reclib.ffmpeg_stderr(["-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"])
    summary = log[log.rfind("Summary"):]
    i = re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", summary)
    p = re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", summary)
    if not i or not p:
        raise reclib.StepError(f"could not measure the loudness of {path}")
    return float(i.group(1)), float(p.group(1))


def gain_for(path, target):
    """dB that brings a file to the target loudness without pushing its peak above -1 dBFS."""
    lufs, peak = loudness(path)
    if lufs <= -69:
        raise reclib.StepError(f"{path} is silent")
    return max(-40.0, min(target - lufs, -1.0 - peak))


def duck_filter(duck_db):
    """sidechaincompress settings that pull the music down by about duck_db while the voice speaks."""
    duck = max(0.0, min(duck_db, SPEECH_OVER - 0.5))
    ratio = 1.0 / (1.0 - duck / SPEECH_OVER) if duck else 1.0
    threshold = 10 ** ((-18.0 - SPEECH_OVER) / 20)  # speech at -16 LUFS sits near -18 dBFS RMS
    return f"sidechaincompress=threshold={threshold:.5f}:ratio={min(ratio, 20):.3f}:attack=15:release=350:makeup=1"


def loudnorm_pass2(premix):
    log = reclib.ffmpeg_stderr(["-i", str(premix), "-af", f"{LN}:print_format=json", "-f", "null", "-"])
    part = log.split("[Parsed_loudnorm")[-1]
    match = re.search(r"\{[\s\S]*?\}", part)
    if not match:
        raise reclib.StepError("loudnorm did not report its measurement")
    m = json.loads(match.group(0))
    if m["input_i"] in ("-inf", "inf"):
        raise reclib.StepError("the premix is silent")
    return (
        f"{LN}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
        f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    ), float(m["input_i"])


def resolve_music(root, args):
    spec = {}
    cfg = root / "data/music.json"
    if cfg.exists():
        spec = reclib.read_json(cfg)
        if not isinstance(spec, dict):
            raise reclib.StepError(f"{cfg}: expected {{file, db}}")
    file = args.music or spec.get("file")
    db = args.music_db if args.music_db is not None else spec.get("db", -20)
    try:
        db = float(db)
    except (TypeError, ValueError) as err:
        raise reclib.StepError(f"music level must be a number of dB, got {db!r}") from err
    if not file:
        return None, db
    path = Path(file)
    if not path.is_absolute():
        path = (Path.cwd() / path) if args.music else (root / path)
    if not path.exists():
        raise reclib.StepError(f"music file not found: {path}")
    return path.resolve(), db


def main():
    ap = argparse.ArgumentParser(description="Mix voice and ducked music into assets/audio/mix.m4a (-14 LUFS / -1.5 dBTP) with stems.")
    ap.add_argument("project", help="project directory")
    ap.add_argument("--music", help="music file (default: data/music.json file, else no music)")
    ap.add_argument("--music-db", type=float, default=None, help="music loudness in LUFS before ducking (default: data/music.json db, else -20)")
    ap.add_argument("--duck-db", type=float, default=8.0, help="how far the music dips under speech, dB (default 8)")
    args = ap.parse_args()
    root = reclib.project_dir(args.project)
    audio = root / "assets/audio"
    voice = audio / "voice.wav"
    if not voice.exists():
        raise reclib.StepError(f"missing {voice}; run apply-edl.py first")
    music, music_db = resolve_music(root, args)
    dur = reclib.duration(voice)
    gv = gain_for(voice, VOICE_LUFS)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        premix, sv, sm = tmp / "premix.wav", tmp / "stem-voice.wav", tmp / "stem-music.wav"
        if music:
            gm = gain_for(music, music_db)
            graph = ";".join([
                f"[0:a]{FMT},volume={gv:.2f}dB,asplit=3[vbus][vside0][vstem]",
                f"[vside0]apad=whole_dur={dur + TAIL:.4f}[vside]",
                f"[1:a]{FMT},atrim=0:{dur + TAIL:.4f},asetpts=PTS-STARTPTS,volume={gm:.2f}dB[mus]",
                f"[mus][vside]{duck_filter(args.duck_db)},afade=t=out:st={dur:.4f}:d={TAIL:.4f},asplit=2[mbus][mstem]",
                f"[vbus][mbus]amix=inputs=2:normalize=0:duration=first:dropout_transition=0,atrim=0:{dur:.4f}[out]",
            ])
            reclib.ffmpeg([
                "-i", str(voice), "-stream_loop", "-1", "-i", str(music), "-filter_complex", graph,
                "-map", "[out]", "-c:a", "pcm_f32le", str(premix),
                "-map", "[vstem]", "-c:a", "pcm_f32le", str(sv),
                "-map", "[mstem]", "-c:a", "pcm_f32le", str(sm),
            ])
        else:
            reclib.ffmpeg([
                "-i", str(voice), "-filter_complex", f"[0:a]{FMT},volume={gv:.2f}dB,asplit=2[out][vstem]",
                "-map", "[out]", "-c:a", "pcm_f32le", str(premix), "-map", "[vstem]", "-c:a", "pcm_f32le", str(sv),
            ])
        pass2, pre_i = loudnorm_pass2(premix)
        # Builds hard-link assets/, so write new files and swap them in; never rewrite a linked file in place.
        mix = audio / "mix.m4a"
        mix_new = audio / ".mix.partial.m4a"
        reclib.ffmpeg(["-i", str(premix), "-af", pass2, "-t", f"{dur:.4f}", "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(mix_new)])
        out_i, out_tp = loudness(mix_new)
        applied = out_i - pre_i  # the gain the mix received, applied to the stems too
        stems = [(sv, audio / "stem-voice.wav")] + ([(sm, audio / "stem-music.wav")] if music else [])
        done = [(mix_new, mix)]
        for src, dst in stems:
            new = dst.with_name(f".{dst.stem}.partial.wav")
            reclib.ffmpeg(["-i", str(src), "-af", f"volume={applied:.2f}dB", "-c:a", "pcm_s16le", str(new)])
            done.append((new, dst))
        for new, dst in done:
            os.replace(new, dst)
    if not music:
        (audio / "stem-music.wav").unlink(missing_ok=True)  # a stale stem from an earlier run with music
    print(f"mix -> {mix} ({reclib.duration(mix):.2f}s, {out_i:.1f} LUFS, {out_tp:.1f} dBTP; premix {pre_i:.1f} LUFS"
          f"{f', music {music.name} at {music_db:g} LUFS ducked ~{args.duck_db:g} dB' if music else ', no music'})")
    print(f"stems -> {', '.join(str(d) for _, d in stems)}")
    return 0


if __name__ == "__main__":
    reclib.main_guard(main)
