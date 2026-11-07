"""Cut generated footage to the edit.

trim     raw gen clip -> <episode>/trimmed/<scene>-<shot>.mp4: only the used range plus a handle each side, so
         a paid upscale bills for frames the film actually uses. --rewrite points the EDL at the upscaled copy
         and moves `in` to the handle.
conform  EDL src -> <scene>/clips/<shot>.mp4 with exactly round(len * fps) frames at the EDL size (speed applied,
         short sources padded by holding the last frame and reported), plus <shot>.wav when the shot keeps
         its audio. Every command is built first, so --dry-run prints the plan without touching anything.
"""
from __future__ import annotations

from pathlib import Path

from .common_io_and_paths import ffprobe_duration, ffprobe_frames, frames, load_json, run, save_json


def _atempo(speed: float) -> str:
    """atempo takes 0.5..2.0 per stage; chain stages for larger changes."""
    stages, s = [], speed
    while s > 2.0:
        stages.append("atempo=2.0"); s /= 2.0
    while s < 0.5:
        stages.append("atempo=0.5"); s /= 0.5
    stages.append(f"atempo={s:.6f}")
    return ",".join(stages)


def video_shots(edl: dict, only: list[str] | None = None) -> list[dict]:
    return [s for s in edl["shots"] if s.get("kind") == "video" and (not only or s["id"] in only)]


def plan_trim(edl: dict, episode_dir: Path, scene: str, *, handle_frames: int = 4, only=None) -> list[dict]:
    fps, jobs = edl["fps"], []
    for s in video_shots(edl, only):
        src = episode_dir / s["src"]
        need = (frames(s["end"] - s["start"], fps) / fps) * s.get("speed", 1.0)
        h = handle_frames / fps
        a = max(0.0, s.get("in", 0.0) - h)
        b = s.get("in", 0.0) + need + h
        out = episode_dir / "trimmed" / f"{scene}-{s['id']}.mp4"
        cmd_v = ["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.4f}", "-to", f"{b:.4f}", "-i", str(src), "-map", "0:v",
                 "-c:v", "libx264", "-crf", "8", "-preset", "slow", "-pix_fmt", "yuv420p", "-r", str(fps), str(out)]
        cmd_a = ["ffmpeg", "-v", "error", "-y", "-ss", f"{a:.4f}", "-to", f"{b:.4f}", "-i", str(src), "-map", "0:a?",
                 "-c:a", "pcm_s16le", str(out.with_suffix(".wav"))]
        jobs.append({"shot": s["id"], "src": str(src), "a": round(a, 4), "b": round(b, 4), "new_in": round(s.get("in", 0.0) - a, 4),
                     "out": str(out), "cmds": [cmd_v] + ([cmd_a] if s.get("audio") else [])})
    return jobs


def trim(scene_dir: Path, *, handle_frames: int = 4, only=None, rewrite: str | None = None, dry: bool = False) -> list[dict]:
    episode_dir, scene = scene_dir.parents[1], scene_dir.name
    edl_p = scene_dir / "edl.json"
    edl = load_json(edl_p)
    jobs = plan_trim(edl, episode_dir, scene, handle_frames=handle_frames, only=only)
    for j in jobs:
        print(f"trim {j['shot']}: {Path(j['src']).name} [{j['a']}, {j['b']}] -> {Path(j['out']).name} (in -> {j['new_in']})")
        if dry:
            continue
        if not Path(j["src"]).exists():
            raise SystemExit(f"missing source {j['src']}")
        Path(j["out"]).parent.mkdir(parents=True, exist_ok=True)
        for c in j["cmds"]:
            run(c, check=c is j["cmds"][0])
    if rewrite and not dry:
        by = {j["shot"]: j for j in jobs}
        for s in edl["shots"]:
            if s["id"] in by:
                s["src_raw"] = s.get("src_raw", s["src"])
                s["src"] = f"{rewrite.rstrip('/')}/{scene}-{s['id']}.mp4"
                s["in"] = by[s["id"]]["new_in"]
        save_json(edl_p, edl)
        print(f"edl.json now reads video from {rewrite}/ (original path kept in src_raw)")
    if not dry:
        save_json(episode_dir / "trimmed" / f"{scene}-manifest.json", jobs)
    return jobs


def plan_conform(edl: dict, episode_dir: Path, scene_dir: Path, *, size: str | None = None, only=None, crf: int = 10) -> list[dict]:
    fps = edl["fps"]
    w, h = (size.split("x") if size else (edl.get("width", 1920), edl.get("height", 1080)))
    jobs = []
    for s in video_shots(edl, only):
        n = frames(s["end"] - s["start"], fps)
        sp = float(s.get("speed", 1.0))
        src_len = n / fps * sp
        src = episode_dir / s["src"]
        out = scene_dir / "clips" / f"{s['id']}.mp4"
        # a speed change builds the missing frames by motion interpolation; fps= alone repeats one frame in ten
        # at 0.9x, which judders on every camera move. A source drawn on twos ("twos": true, drawings on the even
        # frames from the in point) keeps only its drawings, with their timestamps, so the interpolation spans the
        # real drawing-to-drawing motion instead of pairing a frame with its held copy; grain keeps the copies too
        # different for mpdecimate to catch
        slow = abs(sp - 1) > 1e-6
        retime = f"minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1" if slow else f"fps={fps}"
        twos = "select='not(mod(n\\,2))'," if s.get("twos") else ""
        vf = (f"{twos}setpts=(PTS-STARTPTS)/{sp},{retime},scale={w}:{h}:flags=lanczos,setsar=1,"
              f"tpad=stop_mode=clone:stop_duration=2")
        # read one drawing past the cut so the last frames still have a pair to interpolate toward
        tail = 0.15 if twos else 0.05
        cmd_v = ["ffmpeg", "-v", "error", "-y", "-ss", f"{s.get('in', 0.0):.4f}", "-t", f"{src_len + tail:.4f}", "-i", str(src),
                 "-vf", vf, "-frames:v", str(n), "-an", "-c:v", "libx264", "-crf", str(crf), "-preset", "slow",
                 "-pix_fmt", "yuv420p", str(out)]
        cmds = [cmd_v]
        if s.get("audio"):
            af = (_atempo(sp) + "," if abs(sp - 1) > 1e-6 else "") + f"aresample=48000,apad,atrim=end={n / fps:.6f}"
            cmds.append(["ffmpeg", "-v", "error", "-y", "-ss", f"{s.get('in', 0.0):.4f}", "-t", f"{src_len + 0.05:.4f}", "-i", str(src),
                         "-vn", "-af", af, "-ac", "2", "-c:a", "pcm_s16le", str(out.with_suffix(".wav"))])
        jobs.append({"shot": s["id"], "frames": n, "src": str(src), "in": s.get("in", 0.0), "src_len": round(src_len, 4),
                     "out": str(out), "cmds": cmds})
    return jobs


def conform(scene_dir: Path, *, size: str | None = None, only=None, dry: bool = False) -> list[dict]:
    episode_dir = scene_dir.parents[1]
    edl = load_json(scene_dir / "edl.json")
    jobs = plan_conform(edl, episode_dir, scene_dir, size=size, only=only)
    for j in jobs:
        if dry:
            print(f"conform {j['shot']}: {j['frames']} frames from {Path(j['src']).name} ({j['src_len']}s of source)")
            continue
        if not Path(j["src"]).exists():
            raise SystemExit(f"missing source {j['src']}")
        avail = ffprobe_duration(j["src"]) - j["in"]
        Path(j["out"]).parent.mkdir(parents=True, exist_ok=True)
        run(j["cmds"][0])
        if len(j["cmds"]) > 1:
            run(j["cmds"][1], check=False)
        got = ffprobe_frames(j["out"])
        short = f"  SOURCE SHORT by {j['src_len'] - avail:.2f}s (last frame held)" if avail + 1e-3 < j["src_len"] else ""
        flag = "" if got == j["frames"] else f"  FRAME MISMATCH {got} != {j['frames']}"
        print(f"conform {j['shot']}: {got} frames -> clips/{Path(j['out']).name}{short}{flag}")
    return jobs
