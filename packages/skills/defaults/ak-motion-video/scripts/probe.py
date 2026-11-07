#!/usr/bin/env python3
"""Probe rendered media in one line per file: size, fps, duration, codecs, audio.

--loudness adds integrated LUFS and true peak (ebur128=peak=true); --black lists
black segments (blackdetect d=0.1:pix_th=0.05); --expect/--fps flag mismatches.
A missing file prints `<file>: not rendered` and the run exits 2 after probing
the rest; any other problem exits 1. Standard library only.

Usage:
  python -X utf8 probe.py <file>... [--expect 1080x1920] [--fps 30] [--loudness] [--black] [--json]
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


class ProbeError(Exception):
    pass


def utf8_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def need(tool):
    exe = shutil.which(tool)
    if not exe:
        raise ProbeError(f"{tool} not found on PATH; run scripts/doctor.py")
    return exe


def run(argv):
    proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return proc.returncode, proc.stdout, proc.stderr


def rate(text):
    try:
        num, _, den = str(text).partition("/")
        value = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return None
    return round(value, 3) if value else None


def num(text, cast=float):
    try:
        return cast(text)
    except (TypeError, ValueError):
        return None


def ffprobe(path):
    code, out, err = run([need("ffprobe"), "-v", "error", "-show_entries",
                          "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels"
                          ":format=duration", "-of", "json", str(path)])
    if code != 0:
        raise ProbeError(f"ffprobe failed: {err.strip()[-300:] or 'unreadable media'}")
    try:
        data = json.loads(out)
    except ValueError as e:
        raise ProbeError("ffprobe returned no JSON") from e
    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    info = {"duration": num((data.get("format") or {}).get("duration"))}
    if v:
        info.update(width=v.get("width"), height=v.get("height"), fps=rate(v.get("r_frame_rate")), vcodec=v.get("codec_name"))
    if a:
        info.update(acodec=a.get("codec_name"), sample_rate=num(a.get("sample_rate"), int), channels=a.get("channels"))
    return info


def loudness(path):
    code, _, err = run([need("ffmpeg"), "-hide_banner", "-nostats", "-i", str(path), "-vn",
                        "-af", "ebur128=peak=true", "-f", "null", "-"])
    if code != 0:
        raise ProbeError(f"ebur128 failed: {err.strip()[-300:]}")
    summary = err[err.rfind("Summary:"):] if "Summary:" in err else err
    lufs = re.search(r"I:\s*(-?[\d.]+|-inf)\s*LUFS", summary)
    peak = re.search(r"True peak:\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS", summary, re.S)
    return {"lufs": num(lufs.group(1)) if lufs else None, "true_peak": num(peak.group(1)) if peak else None}


def black(path):
    code, _, err = run([need("ffmpeg"), "-hide_banner", "-nostats", "-i", str(path), "-an",
                        "-vf", "blackdetect=d=0.1:pix_th=0.05", "-f", "null", "-"])
    if code != 0:
        raise ProbeError(f"blackdetect failed: {err.strip()[-300:]}")
    return [[float(a), float(b)] for a, b in re.findall(r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)", err)]


def check(info, expect, fps):
    issues = []
    if expect:
        got = f"{info.get('width')}x{info.get('height')}"
        if "width" not in info:
            issues.append(f"no video (expected {expect})")
        elif got != expect:
            issues.append(f"size {got} != {expect}")
    if fps is not None:
        got = info.get("fps")
        if got is None:
            issues.append(f"no video fps (expected {fps:g})")
        elif abs(got - fps) > 0.01:
            issues.append(f"fps {got:g} != {fps:g}")
    return issues


def line(name, info):
    parts = []
    if "width" in info:
        parts.append(f"{info['width']}x{info['height']}")
        parts.append(f"{info['fps']:g}fps" if info.get("fps") else "?fps")
    if info.get("duration") is not None:
        parts.append(f"{info['duration']:.3f}s")
    if "vcodec" in info:
        parts.append(info["vcodec"] or "?")
    if "acodec" in info:
        parts.append(f"{info['acodec']} {info.get('sample_rate')}Hz {info.get('channels')}ch")
    else:
        parts.append("no audio")
    if "lufs" in info:
        lufs, tp = info["lufs"], info["true_peak"]
        parts.append(f"{'?' if lufs is None else f'{lufs:.1f}'} LUFS {'?' if tp is None else f'{tp:.1f}'} dBTP")
    if "black" in info:
        segs = info["black"]
        parts.append("black " + (", ".join(f"{a:.2f}-{b:.2f}" for a, b in segs) if segs else "none"))
    if info.get("issues"):
        parts.append("MISMATCH: " + "; ".join(info["issues"]))
    return f"{name}: " + " ".join(parts)


def parse_size(text):
    if not re.fullmatch(r"\d+x\d+", text or ""):
        raise argparse.ArgumentTypeError("expected WxH, e.g. 1080x1920")
    return text


def main(argv=None):
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="+", help="media files (renders, mixes)")
    ap.add_argument("--expect", type=parse_size, help="required WxH, e.g. 1080x1920")
    ap.add_argument("--fps", type=float, help="required frame rate")
    ap.add_argument("--loudness", action="store_true", help="integrated LUFS and true peak")
    ap.add_argument("--black", action="store_true", help="list black segments")
    ap.add_argument("--json", action="store_true", help="print a JSON list instead of lines")
    a = ap.parse_args(argv)
    results, code = [], 0
    for name in a.files:
        path = Path(name)
        info = {"file": name}
        if not path.is_file():
            info["status"] = "not rendered"
            code = max(code, 2)
        else:
            try:
                info.update(ffprobe(path))
                if a.loudness:
                    info.update(loudness(path))
                if a.black:
                    info["black"] = black(path)
                info["issues"] = check(info, a.expect, a.fps)
                info["status"] = "mismatch" if info["issues"] else "ok"
                if info["issues"]:
                    code = max(code, 1)
            except ProbeError as e:
                info.update(status="error", error=str(e))
                code = max(code, 1)
        results.append(info)
        if not a.json:
            if info["status"] == "not rendered":
                print(f"{name}: not rendered")
            elif info["status"] == "error":
                print(f"{name}: error: {info['error']}")
            else:
                print(line(name, info))
    if a.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
    return code


if __name__ == "__main__":
    sys.exit(main())
