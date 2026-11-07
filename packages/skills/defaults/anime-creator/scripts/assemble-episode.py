#!/usr/bin/env python3
"""Join finished scenes into the episode deliverables with true-peak-safe audio, then measure every file.

usage: python -X utf8 assemble-episode.py <episode-dir> --name ep01-cut3 --tag "{sc}-cut3-r1"
         [--scenes sc01,sc02,...,mv] [--part sc02=sc02-cut3-r2 ...] [--mix "audio/mix-{sc}.wav"]
         [--xfade-ms 5] [--limit 0.8] [--phone-limit 0.6] [--phone-gain-db 0] [--no-1080] [--phone-mib 28] [--overwrite]

Inputs per part (scene ids default to episode.json "scenes"; add an MV or an end card with --scenes):
  renders/<tag>-master.mp4 (unless --no-1080), renders/<tag>-master-720p.mp4   from finish-scenes.py
  audio/mix-<sc>.wav                                                           the scene's PCM mix
Outputs in renders/ (and audio/mix-<name>.wav, the joined PCM mix):
  <name>-master.mp4        1080p, picture stream-copied, audio encoded once from the joined PCM mix
  <name>-master-720p.mp4   720p review master, same audio route
  <name>-share-720p.mp4    crf 27 picture, audio stream copied from the 720p master
  <name>-phone-540p.mp4    two-pass sized under --phone-mib (chat/phone viewers refuse files over 30 MiB),
                           AAC 128k behind a 0.6 limiter on an oversampled copy (96k phone AAC hit +0.4 dBTP)
Each scene's mix must match its picture length within two frames, or the episode drifts out of sync after it.
Scene mixes join with a short equal-power overlap (--xfade-ms) that keeps the summed length; see xfade_graph.
Every output is measured and appended to renders/deliveries.jsonl; any broken limit exits 1.
Supported: macOS, Linux, Windows.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio import delivery_encodes as de  # noqa: E402


def concat_list(path: Path, files: list[Path]) -> Path:
    # absolute forward-slash paths: a relative or /d/... path resolved to C:/d/... under Windows ffmpeg
    path.write_text("".join(f"file '{f.resolve().as_posix()}'\n" for f in files), encoding="utf-8")
    return path


def xfade_graph(durations: list[float], ms: float) -> str:
    """Equal-power (qsin) overlap of `ms` at every junction, with the length kept.

    Each scene but the last gets ms/2 of silence after it and each but the first ms/2 before it, so the overlap
    holds the outgoing scene's last ms/2 and the incoming scene's first ms/2 and every scene starts exactly at its
    picture cut. acrossfade swallows the whole overlap, so padding only one side made each scene land ms/2 earlier
    than the one before. A fade-out-then-fade-in pair would leave a hole at the cut instead. The joined mix is
    padded and trimmed to the summed scene lengths so the picture concat still lines up.
    """
    d, total = ms / 1000, sum(durations)
    last = len(durations) - 1

    def edge(i: int) -> str:
        f = [f"adelay=delays={ms / 2:g}:all=1"] if i else []
        f += [f"apad=pad_dur={d / 2:.6f}"] if i != last else []
        return ",".join(f) or "anull"

    parts = [f"[{i}:a]{edge(i)}[p{i}]" for i in range(len(durations))]
    prev = "p0"
    for i in range(1, len(durations)):
        parts.append(f"[{prev}][p{i}]acrossfade=d={d:.6f}:c1=qsin:c2=qsin[x{i}]")
        prev = f"x{i}"
    parts.append(f"[{prev}]apad=whole_dur={total:.6f},atrim=duration={total:.6f}[out]")
    return ";".join(parts)


def join_mixes(mixes: list[Path], out: Path, listfile: Path, ms: float) -> None:
    if ms <= 0 or len(mixes) < 2:
        io.run(de.ffmpeg("-f", "concat", "-safe", "0", "-i", str(concat_list(listfile, mixes)), "-c", "copy", str(out)))
        return
    args = [x for m in mixes for x in ("-i", str(m))]
    graph = xfade_graph([io.ffprobe_duration(m) for m in mixes], ms)
    io.run(de.ffmpeg(*args, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s24le", str(out)))


def video_only(parts: list[Path], tmp: Path) -> list[Path]:
    """Stream-copied picture of each part: concat over the parts' own AAC shifted the video 21 ms (the priming)."""
    tmp.mkdir(parents=True, exist_ok=True)
    outs = [tmp / f"{i:02d}-{p.name}" for i, p in enumerate(parts)]
    for p, o in zip(parts, outs):
        io.run(de.ffmpeg("-i", str(p), "-map", "0:v:0", "-c", "copy", str(o)))
    return outs


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episode")
    ap.add_argument("--name", required=True, help="output base name, e.g. ep01-cut3")
    ap.add_argument("--tag", required=True, help='render tag template, e.g. "{sc}-cut3-r1"')
    ap.add_argument("--scenes", help="comma list in episode order (default: episode.json scenes)")
    ap.add_argument("--part", action="append", default=[], help="sc=tag override for one scene, e.g. sc02=sc02-cut3-r2")
    ap.add_argument("--mix", default="audio/mix-{sc}.wav", help="per-scene PCM mix, relative to the episode")
    ap.add_argument("--xfade-ms", type=float, default=5.0,
                    help="equal-power overlap at each scene junction; 0 = straight concat (a hard cut can click)")
    ap.add_argument("--limit", type=float, default=0.8,
                    help="limiter ceiling before the masters' 256k AAC; lower it when they measure over -1.5 dBTP")
    ap.add_argument("--phone-limit", type=float, default=0.6,
                    help="limiter ceiling before the phone copy's 128k AAC (0.75 once let the encoder glitch to +2.7 dBFS)")
    ap.add_argument("--phone-gain-db", type=float, default=0,
                    help="gain into the phone limiter, when its ceiling pulls the copy under -15 LUFS")
    ap.add_argument("--no-1080", action="store_true", help="skip the 1080p master (720p review round)")
    ap.add_argument("--phone-mib", type=float, default=de.PHONE_TARGET_MIB)
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args()
    ep = Path(a.episode).expanduser().resolve()
    r = ep / "renders"
    scenes = a.scenes.split(",") if a.scenes else io.load_json(ep / "episode.json")["scenes"]
    over = dict(p.split("=", 1) for p in a.part)
    outs = {k: r / f"{a.name}-{k}.mp4" for k in ("master", "master-720p", "share-720p", "phone-540p")}
    if a.no_1080:
        outs.pop("master")
    if any(f.exists() for f in outs.values()) and not a.overwrite:
        sys.exit(f"{a.name} outputs exist; pick a new --name (or --overwrite)")
    v1080, v720, mixes, missing = [], [], [], []
    fps = 24.0
    for sc in scenes:
        tag = over.get(sc, a.tag.format(sc=sc))
        p720, p1080, mix = r / f"{tag}-master-720p.mp4", r / f"{tag}-master.mp4", ep / a.mix.format(sc=sc)
        need = [p720, mix] + ([] if a.no_1080 else [p1080])
        missing += [str(f) for f in need if not f.exists()]
        if p720.exists() and mix.exists():
            dv, da = io.ffprobe_duration(p720), io.ffprobe_duration(mix)
            if abs(dv - da) > 2 / fps:
                sys.exit(f"{sc}: picture {dv:.3f}s vs mix {da:.3f}s; rebuild the mix for this cut before joining")
        v720.append(p720); v1080.append(p1080); mixes.append(mix)
    if missing:
        sys.exit("missing inputs:\n  " + "\n  ".join(missing))
    mix_all = ep / "audio" / f"mix-{a.name}.wav"
    join_mixes(mixes, mix_all, ep / "audio" / f"mix-{a.name}.txt", a.xfade_ms)
    for key, parts in (("master", v1080), ("master-720p", v720)):
        if key not in outs:
            continue
        tmp = r / f"{a.name}-parts-{key}"
        lst = concat_list(r / f"{a.name}-concat-{key}.txt", video_only(parts, tmp))
        io.run(de.ffmpeg("-f", "concat", "-safe", "0", "-i", str(lst), "-i", str(mix_all), "-map", "0:v:0", "-map", "1:a:0",
                         "-c:v", "copy", "-af", de.tp_safe_af(a.limit), "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart",
                         str(outs[key])))
        shutil.rmtree(tmp)
    io.run(de.share_cmd(outs["master-720p"], outs["share-720p"]))
    for cmd in de.phone_cmds(outs["master-720p"], mix_all, outs["phone-540p"], io.ffprobe_duration(outs["master-720p"]),
                             target_mib=a.phone_mib, limit=a.phone_limit, gain_db=a.phone_gain_db):
        io.run(cmd)
    de.cleanup_2pass(outs["phone-540p"])
    bad = []
    for kind, f in outs.items():
        m = de.measure(f)
        issues = de.problems(m, max_mib=de.SEND_LIMIT_MIB if kind == "phone-540p" else None)
        de.record(r / "deliveries.jsonl", {"ts": io.now_iso(), "scene": a.name, "tag": a.name, "kind": kind,
                                           "path": f.resolve().as_posix(), **m, "ok": not issues})
        print(f"{f.name}: {io.ffprobe_duration(f):.2f}s {m['lufs']} LUFS {m['tp_dbfs']} dBTP {m['mib']} MiB"
              + (f"  <- {'; '.join(issues)}" if issues else ""))
        bad += [f"{f.name}: {x}" for x in issues]
    if bad:
        sys.exit("NOT DELIVERABLE:\n  " + "\n  ".join(bad))


if __name__ == "__main__":
    main()
