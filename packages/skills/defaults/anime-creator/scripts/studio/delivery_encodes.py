"""Delivery encodes that keep the true-peak ceiling, and the measurement every delivered file gets.

Measured on FRONTIER EP01: AAC re-encodes overshoot the mix's true peak. A -2.0 dBFS mix came out at -0.7 dBTP
at 720p/256k, a 96k phone copy reached +0.4 dBTP, and re-encoding a master's AAC stack overshot twice. So:
- encode each delivered audio stream once, from the PCM mix, after a limiter on a 4x oversampled copy;
- a copy that keeps the picture size (share) copies that audio stream instead of re-encoding it;
- low-rate AAC (phone, 128k) needs a lower limit (0.6); 0.75 still let the encoder glitch to +2.7 dBFS;
- an 18 kHz lowpass goes before the limiter: on FRONTIER EP03's 330 s join, one transient overshot 2.1 dB through
  the 256k encoder (-1.0 dBTP from a 0.7 limit, and lowering the limit barely moved it); with the lowpass, -2.0;
- every delivered file is measured (ebur128 true peak, integrated LUFS, size); a pass is a number, not a belief.
Chat and phone viewers refuse files over 30 MiB, so the phone copy is two-pass sized to a MiB target under it.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from .common_io_and_paths import append_jsonl, resolve_cmd
from .reference_roles import sha256

MIB = 1024 * 1024
SEND_LIMIT_MIB = 30.0          # SendUserFile refused a 30.1 MiB phone copy
PHONE_TARGET_MIB = 28.0
TP_CEILING = -1.5               # dBTP on every delivered file
LUFS_TARGET, LUFS_TOL = -14.0, 1.0
NODE_HEAP_MB = 8192             # hyperframes ran out of heap at the 4 GB default on a 85 s scene


def tp_safe_af(limit: float = 0.8, gain_db: float = 0) -> str:
    """Limiter on an oversampled copy: inter-sample peaks are caught before the AAC encoder adds its own.

    gain_db drives the limiter harder: a low ceiling (the phone's 0.6) otherwise costs integrated loudness.
    The lowpass keeps energy off the encoder's cutoff, where a transient made it overshoot the limit by 2 dB.
    """
    pre = f"volume={gain_db}dB," if gain_db else ""
    return f"{pre}lowpass=f=18000:p=2,aresample=192000,alimiter=limit={limit}:attack=1:release=50:level=false,aresample=48000"


def ffmpeg(*args: str) -> list[str]:
    return ["ffmpeg", "-nostdin", "-v", "error", "-y", *args]


def master_720_cmd(master: Path, mix: Path, out: Path, *, limit: float = 0.8, extra_vf: str = "") -> list[str]:
    """Review master: 1080p picture scaled to 720p, audio encoded once from the PCM mix."""
    vf = "scale=1280:720:flags=lanczos" + (f",{extra_vf}" if extra_vf else "")
    return ffmpeg("-i", str(master), "-i", str(mix), "-map", "0:v:0", "-map", "1:a:0", "-vf", vf,
                  "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-af", tp_safe_af(limit),
                  "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(out))


def share_cmd(src: Path, out: Path, *, crf: int = 27) -> list[str]:
    """Smaller copy of the same size: re-encode the picture, copy the measured audio stream."""
    return ffmpeg("-i", str(src), "-c:v", "libx264", "-crf", str(crf), "-preset", "slow", "-c:a", "copy",
                  "-movflags", "+faststart", str(out))


def remux_cmd(video: Path, mix: Path, out: Path, *, limit: float = 0.8, kbps: int = 256) -> list[str]:
    """Audio-only fix: keep the rendered picture bit for bit, put a new mix under it (seconds, not a re-render)."""
    return ffmpeg("-i", str(video), "-i", str(mix), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                  "-af", tp_safe_af(limit), "-c:a", "aac", "-b:a", f"{kbps}k", "-movflags", "+faststart", str(out))


def phone_kbps(duration_s: float, target_mib: float = PHONE_TARGET_MIB, audio_kbps: int = 128,
               overhead: float = 0.03) -> int:
    """Video bitrate (kbit/s) that lands a two-pass encode under target_mib with the container overhead."""
    total_kbit = target_mib * MIB * 8 / 1000 * (1 - overhead)
    return max(150, int(total_kbit / max(duration_s, 0.1) - audio_kbps))


def phone_cmds(src: Path, mix: Path, out: Path, duration_s: float, *, target_mib: float = PHONE_TARGET_MIB,
               limit: float = 0.6, audio_kbps: int = 128, height: int = 540, gain_db: float = 0) -> list[list[str]]:
    vb = phone_kbps(duration_s, target_mib, audio_kbps)
    log = str(out.with_suffix("")) + "-2pass"
    vf = f"scale=-2:{height}:flags=lanczos"
    base = ["-vf", vf, "-c:v", "libx264", "-preset", "slow", "-b:v", f"{vb}k", "-passlogfile", log]
    # pass 1 writes to the null muxer: a NUL/os.devnull output path broke on Windows
    return [ffmpeg("-i", str(src), *base, "-pass", "1", "-an", "-f", "null", "-"),
            ffmpeg("-i", str(src), "-i", str(mix), "-map", "0:v:0", "-map", "1:a:0", *base, "-pass", "2",
                   "-af", tp_safe_af(limit, gain_db), "-c:a", "aac", "-b:a", f"{audio_kbps}k", "-movflags", "+faststart", str(out))]


def cleanup_2pass(out: Path) -> None:
    stem = str(out.with_suffix("")) + "-2pass"
    for f in out.parent.glob(Path(stem).name + "*"):
        f.unlink(missing_ok=True)


def parse_ebur128(stderr: str) -> dict:
    tail = stderr.split("Summary:")[-1]
    num = lambda rx: float(m.group(1)) if (m := re.search(rx, tail)) else None  # noqa: E731
    return {"lufs": num(r"I:\s+(-?[\d.]+) LUFS"), "tp_dbfs": num(r"Peak:\s+(-?[\d.]+) dBFS")}


def measure(path: Path) -> dict:
    """Integrated LUFS and true peak of the file as delivered, plus its size."""
    err = subprocess.run(resolve_cmd(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true",
                                      "-f", "null", "-"]), capture_output=True, text=True, errors="replace").stderr
    return {"file": path.name, "mib": round(path.stat().st_size / MIB, 2), **parse_ebur128(err)}


def problems(m: dict, *, max_tp: float = TP_CEILING, max_mib: float | None = None,
             lufs: float | None = LUFS_TARGET, tol: float = LUFS_TOL) -> list[str]:
    """Empty when the file may ship; one message per broken limit otherwise."""
    out = []
    if m.get("tp_dbfs") is None:
        out.append("no audio measured")
    elif m["tp_dbfs"] > max_tp:
        out.append(f"true peak {m['tp_dbfs']:+.1f} dBTP > {max_tp}")
    if lufs is not None and m.get("lufs") is not None and abs(m["lufs"] - lufs) > tol:
        out.append(f"loudness {m['lufs']:.1f} LUFS off {lufs}+-{tol}")
    if max_mib is not None and m["mib"] > max_mib:
        out.append(f"{m['mib']} MiB > {max_mib} MiB send limit")
    return out


def record(manifest: Path, row: dict) -> None:
    """Append one delivered file to renders/deliveries.jsonl, so the latest links survive sessions and accounts. The
    sha256 of the file at row["path"] goes with it, so the export gate can tell the bytes at that name are still the
    ones delivered."""
    if "sha256" not in row and isinstance(row.get("path"), str):
        row = {**row, "sha256": sha256(Path(row["path"]))}
    append_jsonl(manifest, row)


def node_env(heap_mb: int = NODE_HEAP_MB) -> dict:
    env = dict(os.environ)
    if "max-old-space-size" not in env.get("NODE_OPTIONS", ""):
        env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + f" --max-old-space-size={heap_mb}").strip()
    return env
