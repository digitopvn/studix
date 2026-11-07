#!/usr/bin/env python3
"""Upscale finished 720p scene renders to the 1080p masters assemble-episode.py joins, through any upscaler engine.

usage: upscale-finished-scenes.py <episode-dir> --tag "{sc}-cut3-r1" [--out-tag "{sc}-cut3-hd"] [--part sc02=sc02-cut3-r2]
                                  [--scenes sc01,sc02] [--engine NAME] [--test sc01:12.5:6] [--width 1920 --height 1080]
                                  [--dry-run]
Use it when the finishing passes (FX, captions, grade) run at 720p only: upscale the finished scene, not the raw
clips, so captions and FX are upscaled once with everything else. Reads renders/<tag>-master-720p.mp4, writes
renders/<tag>-master.mp4 (picture from the upscaler, audio stream-copied from the 720p master; assemble encodes the
episode audio from the joined PCM mix anyway). Never overwrites.
finish-scenes.py already wrote a Lanczos <tag>-master.mp4, so an approved tag needs --out-tag: the upscale lands in
renders/<out-tag>-master.mp4 and the 720p source is copied to <out-tag>-master-720p.mp4, so
`assemble-episode.py --tag <out-tag>` runs at once. --part takes each scene's approved source tag, as assemble does.
--test first: one short clip (scene:start:seconds) that holds captions with diacritics and fine FX. Look at it
before paying for the whole cut; it lands in upscaled/<tag>/test-*.mp4 and nothing else runs.
Every output must match its source frame for frame and be exactly --width x --height, or the run stops: an
upscaler that drops or adds frames breaks the episode's sync.
Engine: role `upscaler` of engines.json (assets/templates/, or <series>/engines.json):
- `atlas-async` (default byteplus-standard): upload a near-lossless picture-only copy, submit all scenes first so
  they run in parallel, then fetch; prediction ids go to upscaled/<tag>/ids.json so a rerun resumes, never repays,
  and to logs/predictions.log so `anime-studio.py ledger` prices the spend.
- `cli`: any local upscaler; its cmd gets {in} {out} {width} {height}.
Supported: Windows, macOS, Linux. Needs ffmpeg, ffprobe; multix for atlas-async.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio import engine_routing as er  # noqa: E402
from studio import multix_job_commands as mj  # noqa: E402

WAIT_MS = 1_800_000  # a full scene can queue for longer than the 10 min default


def plan(ep: Path, scenes: list[str], tag: str, out_tag: str | None = None,
         parts: dict[str, str] | None = None) -> list[tuple[str, Path, Path]]:
    r = ep / "renders"

    def src(sc: str) -> str:
        return (parts or {}).get(sc) or tag.format(sc=sc)

    def dst(sc: str) -> str:
        return (out_tag or tag).format(sc=sc)

    return [(sc, r / f"{src(sc)}-master-720p.mp4", r / f"{dst(sc)}-master.mp4") for sc in scenes]


def log_prediction(ep: Path, pid: str, name: str, model: str) -> None:
    """The ledger prices every id in logs/predictions.log, the same line format the media runner writes."""
    (ep / "logs").mkdir(exist_ok=True)
    with (ep / "logs" / "predictions.log").open("a", encoding="utf-8") as f:
        f.write(f"{pid} upscale {name} {model}\n")


def parse_test(spec: str) -> tuple[str, float, float]:
    m = re.fullmatch(r"([^:]+):([\d.]+):([\d.]+)", spec)
    if not m:
        raise SystemExit(f"--test wants scene:start:seconds, e.g. sc01:12.5:6 (got {spec!r})")
    return m.group(1), float(m.group(2)), float(m.group(3))


def mismatch(src_frames: int, up_frames: int, size: tuple[int, int], want: tuple[int, int]) -> str | None:
    if size != want:
        return f"size {size[0]}x{size[1]}, want {want[0]}x{want[1]}"
    if src_frames != up_frames:
        return f"{up_frames} frames, source has {src_frames}"
    return None


def size_of(p: Path) -> tuple[int, int]:
    out = io.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                  "-of", "csv=p=0", str(p)]).stdout.decode().strip()
    w, h = out.split(",")[:2]
    return int(w), int(h)


def picture_copy(src: Path, dst: Path, start: float | None = None, seconds: float | None = None) -> Path:
    """Near-lossless picture-only copy: the upscaler sees the master's detail, not a share encode's blocks."""
    if not dst.exists():
        cut = (["-ss", f"{start:.3f}"] if start is not None else []) + (["-t", f"{seconds:.3f}"] if seconds else [])
        io.run(["ffmpeg", "-v", "error", "-n", *cut, "-i", str(src), "-an", "-c:v", "libx264", "-crf", "12",
                "-preset", "slow", "-pix_fmt", "yuv420p", str(dst)])
    return dst


def submit_atlas(ep: Path, adapter: dict, pic: Path, work: Path, key: str, ids: dict, ids_path: Path) -> None:
    if key in ids:
        return
    url = mj.parse_upload_url(io.run(mj.upload_cmd(pic)).stdout.decode(errors="replace"))
    if not url:
        sys.exit(f"{key}: upload returned no URL")
    pay = work / f"{key}-payload.json"
    pay.write_text(json.dumps({"video_url": url, **adapter.get("payload", {})}), encoding="utf-8")
    pid = mj.parse_pred_id(io.run(mj.run_cmd(adapter["model"], pay, video=True)).stdout.decode(errors="replace"))
    if not pid:
        sys.exit(f"{key}: submit returned no prediction id")
    ids[key] = pid
    io.save_json(ids_path, ids)
    log_prediction(ep, pid, f"up-{work.name}-{key}", adapter["model"])
    print(key, "submitted", pid, flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("episode", type=Path)
    ap.add_argument("--tag", required=True, help='render tag template, e.g. "{sc}-cut3-r1" (as assemble-episode.py)')
    ap.add_argument("--out-tag", help='write under a new tag, e.g. "{sc}-cut3-hd": finish-scenes already wrote a '
                    "Lanczos <tag>-master.mp4, which this script never overwrites")
    ap.add_argument("--part", action="append", default=[], help="sc=tag source override, e.g. sc02=sc02-cut3-r2")
    ap.add_argument("--scenes", help="comma list (default: episode.json scenes)")
    ap.add_argument("--engine", help="upscaler adapter in engines.json (default: the role's default)")
    ap.add_argument("--test", help="scene:start:seconds; upscale only this clip and stop")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--dry-run", action="store_true", help="print what would run; no upload, no spend")
    a = ap.parse_args()
    ep = a.episode.expanduser().resolve()
    scenes = a.scenes.split(",") if a.scenes else io.load_json(ep / "episode.json")["scenes"]
    name, adapter = er.pick(er.load(ep), "upscaler", a.engine)
    kind = adapter.get("kind")
    if kind not in ("atlas-async", "cli"):
        sys.exit(f"upscaler {name}: kind {kind!r} is not runnable here (atlas-async or cli)")
    work = ep / "upscaled" / re.sub(r"[^\w.-]+", "_", (a.out_tag or a.tag).replace("{sc}", "all"))
    want = (a.width, a.height)
    parts = dict(p.split("=", 1) for p in a.part)
    rows = plan(ep, scenes, a.tag, a.out_tag, parts)
    if a.test:
        sc, start, secs = parse_test(a.test)
        src = dict((s, p) for s, p, _ in rows).get(sc) or plan(ep, [sc], a.tag, a.out_tag, parts)[0][1]
        key = f"test-{sc}-{start:g}-{secs:g}"
        rows = [(key, src, work / f"{key}.mp4")]
    missing = [str(s) for _, s, _ in rows if not s.exists()]
    if missing:
        sys.exit("missing finished renders:\n  " + "\n  ".join(missing))
    todo = [(k, s, d) for k, s, d in rows if not d.exists()]
    for k, s, d in rows:
        if d.exists():
            print(k, "exists, kept:", d)
    if a.dry_run:
        for k, s, d in todo:
            print(f"{k}: {s.name} -> {d.name} via {name} ({kind})")
        return 0
    work.mkdir(parents=True, exist_ok=True)
    ids_path = work / "ids.json"
    ids = io.load_json(ids_path) if ids_path.exists() else {}
    start, secs = (parse_test(a.test)[1:] if a.test else (None, None))
    pics = {k: picture_copy(s, work / f"{k}-in.mp4", start, secs) for k, s, _ in todo}
    if kind == "atlas-async":  # everything submitted before the first wait, so the jobs run side by side
        for k, _, _ in todo:
            submit_atlas(ep, adapter, pics[k], work, k, ids, ids_path)
    for k, s, d in todo:
        raw = work / f"{k}-up.mp4"
        if not raw.exists():
            if kind == "atlas-async":
                io.run(mj.fetch_cmd(ids[k], raw, WAIT_MS))
            else:
                er.run_cli(adapter, **{"in": str(pics[k]), "out": str(raw), "width": a.width, "height": a.height})
        bad = mismatch(io.ffprobe_frames(pics[k]), io.ffprobe_frames(raw), size_of(raw), want)
        if bad:
            sys.exit(f"{k}: upscale mismatch: {bad}; kept {raw} for a look, wrote nothing")
        if a.test:
            raw.replace(d)
        else:
            io.run(["ffmpeg", "-v", "error", "-n", "-i", str(raw), "-i", str(s), "-map", "0:v:0", "-map", "1:a:0?",
                    "-c", "copy", str(d)])
            mate = d.with_name(d.name.replace("-master.mp4", "-master-720p.mp4"))
            if a.out_tag and not mate.exists():  # assemble-episode.py --tag <out-tag> reads both masters
                shutil.copy2(s, mate)
        print(k, "ok", d, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
