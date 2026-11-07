"""Final look and delivery: grade, bloom, grain and hit chroma split on the edit render, with the mix muxed in.

The graph starts with format=gbrp: blending in YUV turned a whole run magenta once, so the blend always runs
in planar RGB. color_test renders three graded frames next to the raw ones before the full pass; look at it
first (a full master costs minutes, the test costs seconds).
"""
from __future__ import annotations

import os
from pathlib import Path

from .common_io_and_paths import ffprobe_duration, run

LOOKS = {
    # warm afternoon: the xianxia run
    "warm": "eq=contrast=1.03:saturation=1.05:gamma=0.99,colorbalance=rs=0.015:bs=-0.01:rh=0.02:gh=0.005:bh=-0.015",
    # neutral: only a touch of contrast
    "neutral": "eq=contrast=1.02:saturation=1.02",
    # night / moonlight: cool shadows, slightly lifted blacks
    "night": "eq=contrast=1.04:saturation=0.95:gamma=1.02,colorbalance=rs=-0.02:bs=0.03:rm=-0.01:bm=0.015:rh=0.01:bh=-0.005",
    # dusk fire: orange highs, teal lows (fight climaxes)
    "dusk": "eq=contrast=1.05:saturation=1.08,colorbalance=rs=-0.015:bs=0.025:rh=0.035:gh=0.01:bh=-0.03",
}


def hit_expr(hits: list[float], fps: float, frames: int = 2) -> str:
    return "+".join(f"between(t,{t:.3f},{t + frames / fps:.3f})" for t in hits) or "0"


def grade_graph(*, hits: list[float], fps: float, look: str = "warm", bloom: float = 0.35, grain: int = 6,
                chroma_px: int = 6) -> str:
    chain = LOOKS.get(look, look)  # a raw ffmpeg chain is accepted as a custom look
    g = (f"[0:v]format=gbrp,split[a][b];[b]curves=all='0/0 0.62/0 1/1',gblur=sigma=18[g];"
         f"[a][g]blend=all_mode=screen:all_opacity={bloom},{chain}")
    if hits and chroma_px:
        g += f",rgbashift=rh={chroma_px}:bh=-{chroma_px}:enable='{hit_expr(hits, fps)}'"
    if grain:
        g += f",noise=c0s={grain}:c0f=t+u:c1s={max(1, grain // 3)}:c1f=t+u:c2s={max(1, grain // 3)}:c2f=t+u"
    return g + ",format=yuv420p[v]"


def master_cmd(src: Path, mix: Path | None, out: Path, graph: str, fps: float, *, crf: int = 14) -> list[str]:
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(src)]
    if mix:
        cmd += ["-i", str(mix)]
    cmd += ["-filter_complex", graph, "-map", "[v]"]
    if mix:
        cmd += ["-map", "1:a", "-t", f"{ffprobe_duration(mix):.6f}", "-c:a", "aac", "-b:a", "320k"]
    cmd += ["-r", str(fps), "-fps_mode", "cfr", "-c:v", "libx264", "-crf", str(crf), "-preset", "slow", "-tune", "grain",
            "-movflags", "+faststart", str(out)]
    return cmd


def preview_cmds(master: Path, out: Path, *, target_mb: float = 25.0) -> list[list[str]]:
    """Two-pass encode sized to target_mb (SendUserFile and most chat uploads cap near 30 MB)."""
    dur = ffprobe_duration(master)
    vb = max(300, int((target_mb * 8 * 1024 * 1024 / dur - 256_000) / 1000))
    log = str(out.with_suffix("")) + "-x264"
    base = ["ffmpeg", "-v", "error", "-y", "-i", str(master), "-c:v", "libx264", "-b:v", f"{vb}k", "-preset", "slow", "-passlogfile", log]
    return [base + ["-pass", "1", "-an", "-f", "mp4", os.devnull],
            base + ["-pass", "2", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(out)]]


def color_test(src: Path, out_jpg: Path, graph: str, *, at: tuple[float, ...] | None = None) -> Path:
    """Raw (top) vs graded (bottom) at three times, one jpg."""
    dur = ffprobe_duration(src)
    ts = at or (dur * 0.25, dur * 0.5, dur * 0.75)
    tmp = out_jpg.parent / (out_jpg.stem + "-tmp")
    tmp.mkdir(parents=True, exist_ok=True)
    g = graph.replace("format=yuv420p[v]", "format=yuv420p,scale=640:-2[v]")
    for i, t in enumerate(ts):
        run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", "-vf", "scale=640:-2", str(tmp / f"raw{i}.png")])
        run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(src), "-frames:v", "1", "-filter_complex", g, "-map", "[v]", str(tmp / f"grd{i}.png")])
    ins = []
    for k in ("raw", "grd"):
        for i in range(len(ts)):
            ins += ["-i", str(tmp / f"{k}{i}.png")]
    n = len(ts)
    fc = (f"{''.join(f'[{i}:v]' for i in range(n))}hstack=inputs={n}[r];"
          f"{''.join(f'[{n + i}:v]' for i in range(n))}hstack=inputs={n}[g];[r][g]vstack=inputs=2")
    run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", fc, "-q:v", "3", str(out_jpg)])
    for f in tmp.iterdir():
        f.unlink()
    tmp.rmdir()
    return out_jpg


def concat_scenes(renders: list[Path], out: Path) -> list[str]:
    """Episode = scene renders back to back (same codec settings, so stream copy is safe)."""
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in renders), encoding="utf-8")
    return ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out)]
