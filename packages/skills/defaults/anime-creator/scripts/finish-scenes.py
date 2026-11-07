#!/usr/bin/env python3
"""Render and finish scenes one after another: bundle, validate, render, grade with the mix, 720p review master,
share copy, then measure every delivered file. Or swap in a new mix under an existing render (--video-from).

usage: python -X utf8 finish-scenes.py <episode-dir> --scenes sc01,sc02 --tag "{sc}-cut3-r1"
         [--build-mix] [--build-edit] [--video-from "{sc}-cut3-r1"] [--no-bundle] [--workers N] [--overwrite] [--strict-engine]

Per scene, outputs in <episode>/renders/ (tag from the template, {sc} = scene id):
  <tag>-draft.mp4          the HyperFrames render (skipped with --video-from)
  <tag>-master.mp4         graded 1080p with the mix (grade also writes <tag>-preview.mp4; do not send that one)
  <tag>-master-720p.mp4    review master: audio encoded once from audio/mix-<sc>.wav behind an oversampled limiter
  <tag>-share-720p.mp4     crf 27 picture, the 720p audio stream copied
Every one of them is measured (LUFS, true peak, MiB) and appended to renders/deliveries.jsonl.

Why each step exists (FRONTIER EP01):
- `render` does not rebuild dist/film.js; a stale bundle shipped a missing decal and a `followCel is not a
  function` crash. The bundle is rebuilt here and checked to be newer than every source file.
- The series engine copy drifted from the skill copy and fixes never reached the build; the two are compared.
- hyperframes ran out of heap at the 4 GB default (exit 134); NODE_OPTIONS gets 8 GB unless already set.
- Two renders at once doubled the time and risked OOM; scenes render strictly in sequence, and the render holds
  <episode>/work/locks/render.lock (owner PID inside; a dead owner's lock is reclaimed, a live one is waited on).
- A pipe after a failing render hid exit 127 and an old index.html was rendered; every step's exit code counts.
- An audio-only fix (new SFX, a gain) needs no re-render: --video-from remuxes the new mix in seconds.
- Tags are never reused: existing outputs stop the run unless --overwrite (paid and reviewed takes stay).
Supported: macOS, Linux, Windows (Git Bash for build-scene.sh).
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio import delivery_encodes as de  # noqa: E402
from studio import project_layout_and_init as pl  # noqa: E402

SCRIPTS = Path(__file__).resolve().parent
STUDIO = [sys.executable, "-X", "utf8", str(SCRIPTS / "anime-studio.py")]


def step(cmd: list[str], env: dict | None = None, cwd: Path | None = None) -> None:
    r = subprocess.run(io.resolve_cmd(cmd), env=env, cwd=str(cwd) if cwd else None)
    if r.returncode:
        sys.exit(f"step failed ({r.returncode}): {' '.join(map(str, cmd[:6]))} ...")


def tree_hashes(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): hashlib.sha1(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            for p in root.rglob("*") if p.is_file()}


def engine_drift(engine_src: Path) -> list[str]:
    """Files that differ between the series engine and the skill's engine (line endings ignored)."""
    ref = io.ENGINE_ASSET / "engine" / "src"
    if not engine_src.is_dir() or not ref.is_dir() or engine_src.resolve() == ref.resolve():
        return []
    a, b = tree_hashes(engine_src), tree_hashes(ref)
    return sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))


def newest(*dirs: Path) -> float:
    return max((p.stat().st_mtime for d in dirs if d.is_dir() for p in d.rglob("*") if p.is_file()), default=0.0)


def deliver(ep: Path, sc: str, tag: str, kind: str, f: Path, bad: list[str]) -> None:
    m = de.measure(f)
    issues = de.problems(m, max_mib=de.SEND_LIMIT_MIB if kind == "share" else None)
    de.record(ep / "renders" / "deliveries.jsonl", {"ts": io.now_iso(), "scene": sc, "tag": tag, "kind": kind,
                                                     "path": f.resolve().as_posix(), **m, "ok": not issues})
    print(f"  {f.name}: {m['lufs']} LUFS, {m['tp_dbfs']} dBTP, {m['mib']} MiB" + (f"  <- {'; '.join(issues)}" if issues else ""))
    bad += [f"{f.name}: {x}" for x in issues]


def finish_one(ep: Path, sc: str, a: argparse.Namespace, env: dict, bad: list[str]) -> None:
    tag = a.tag.format(sc=sc)
    r = ep / "renders"
    r.mkdir(parents=True, exist_ok=True)
    taken = sorted(r.glob(f"{tag}-*.mp4"))
    if taken and not a.overwrite:
        sys.exit(f"{sc}: tag {tag} already has {taken[0].name}; use a new round tag (or --overwrite)")
    sd = ep / "scenes" / sc
    mix = ep / "audio" / f"mix-{sc}.wav"
    t0 = time.time()
    if a.build_mix:
        step([sys.executable, "-X", "utf8", str(SCRIPTS / "build-audio-mix.py"), str(ep), "--scene", sc, "--out", str(mix)])
    if not mix.exists():
        sys.exit(f"{sc}: missing {mix} (run build-audio-mix.py --scene {sc} --out {mix}, or pass --build-mix)")
    master, m720, share = r / f"{tag}-master.mp4", r / f"{tag}-master-720p.mp4", r / f"{tag}-share-720p.mp4"
    if a.video_from:
        src = a.video_from.format(sc=sc)
        old, old720 = r / f"{src}-master.mp4", r / f"{src}-master-720p.mp4"
        if not old.exists():
            sys.exit(f"{sc}: --video-from needs {old}")
        print(f"== {sc}: new mix under {src} -> {tag}")
        io.run(de.remux_cmd(old, mix, master))
        io.run(de.remux_cmd(old720, mix, m720) if old720.exists() else de.master_720_cmd(master, mix, m720))
    else:
        engine = pl.engine_dir_for(sd)
        drift = engine_drift(engine / "src")
        if drift:
            msg = f"{sc}: series engine differs from the skill engine in {', '.join(drift[:6])}"
            if a.strict_engine:
                sys.exit(msg)
            print("WARN " + msg)
        if not a.no_bundle:
            step(["bash", (engine / "build-scene.sh").as_posix(), sd.resolve().as_posix()])
        if a.build_edit:  # regenerates index.html: only for pages the skill generates, never for hand-edited ones
            step(STUDIO + ["build-edit", str(sd)])
        film = sd / "dist" / "film.js"
        src_time = max(newest(sd / "src", engine / "src"), (sd / "edl.json").stat().st_mtime)  # the bundle embeds edl.json
        if not film.exists() or film.stat().st_mtime + 1 < src_time:
            sys.exit(f"{sc}: {film} is older than its sources; bundle with engine/build-scene.sh before rendering")
        step(STUDIO + ["validate", str(sd)])
        draft = r / f"{tag}-draft.mp4"
        print(f"== {sc}: render -> {draft.name}")
        lock = ep / "work" / "locks" / "render.lock"  # shared with other builders of this episode: one render at a time
        io.take_lock(lock, f"finish-scenes {sc} {tag}", wait=6 * 3600)
        try:
            step(STUDIO + ["render", str(sd), "--quality", a.quality, "--out", str(draft)]
                 + (["--workers", str(a.workers)] if a.workers else []), env=env)
        finally:
            lock.unlink(missing_ok=True)
        step(STUDIO + ["grade", str(draft), "--mix", str(mix), "--episode", str(ep), "--out", str(r / tag)]
             + (["--look", a.look] if a.look else []))
        mm = de.measure(master)
        if de.problems(mm, lufs=None):  # the grade's own AAC pass can overshoot: put the PCM mix back behind the limiter
            tmp = master.with_name(master.stem + "-tp.mp4")
            io.run(de.remux_cmd(master, mix, tmp))
            tmp.replace(master)
        io.run(de.master_720_cmd(master, mix, m720, extra_vf=a.extra_vf))
    io.run(de.share_cmd(m720, share))
    for kind, f in (("master", master), ("master-720p", m720), ("share", share)):
        deliver(ep, sc, tag, kind, f, bad)
    print(f"   {sc} done in {(time.time() - t0) / 60:.1f} min")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episode")
    ap.add_argument("--scenes", required=True, help="comma list, rendered in this order, one at a time")
    ap.add_argument("--tag", required=True, help='output tag template, e.g. "{sc}-cut3-r1"')
    ap.add_argument("--video-from", help='reuse the picture of this tag template (audio-only fix), e.g. "{sc}-cut3-r1"')
    ap.add_argument("--build-mix", action="store_true", help="run build-audio-mix.py --scene first (needs numpy)")
    ap.add_argument("--no-bundle", action="store_true", help="skip engine/build-scene.sh (the freshness check still runs)")
    ap.add_argument("--build-edit", action="store_true", help="also regenerate index.html (anime-studio.py build-edit)")
    ap.add_argument("--strict-engine", action="store_true", help="stop when the series engine differs from the skill's")
    ap.add_argument("--quality", default="draft")
    ap.add_argument("--workers", type=int)
    ap.add_argument("--look", help="grade look (default: the grade command's)")
    ap.add_argument("--extra-vf", default="", help="extra filter on the 720p master, e.g. a caption-safe crop")
    ap.add_argument("--heap-mb", type=int, default=de.NODE_HEAP_MB)
    ap.add_argument("--overwrite", action="store_true")
    a = ap.parse_args()
    ep = Path(a.episode).expanduser().resolve()
    env = de.node_env(a.heap_mb)
    bad: list[str] = []
    t0 = time.time()
    for sc in [s for s in a.scenes.split(",") if s]:
        finish_one(ep, sc, a, env, bad)
    print(f"all done in {(time.time() - t0) / 60:.1f} min")
    if bad:
        sys.exit("NOT DELIVERABLE:\n  " + "\n  ".join(bad))


if __name__ == "__main__":
    main()
