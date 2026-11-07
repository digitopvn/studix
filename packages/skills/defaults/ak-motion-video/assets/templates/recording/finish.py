"""Finish a render: circular webcam picture-in-picture plus the untouched mix.

Overlays the edited webcam (assets/video/webcam.mp4, from --from seconds) as a
circle with a 2 px soft edge (optional thin ring) on the silent HyperFrames
render, copies the audio stream unchanged (default assets/audio/mix.m4a) and
encodes libx264 crf 18 high yuv420p +faststart with the render's length.

Usage: python -X utf8 finish.py <project> --render RAW -o OUT [--ratio 16x9|9x16|1x1]
       [--from S] [--pip cx,cy,d] [--no-pip] [--ring HEX] [--audio FILE]
"""
import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reclib  # noqa: E402

PIP = {"16x9": (1740, 880, 300), "9x16": (196, 1380, 240), "1x1": (150, 930, 220)}
RING_PX = 4


def size(path):
    out = reclib.run([reclib.need("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path)], capture=True).strip()
    try:
        w, h = (int(x) for x in out.splitlines()[0].split("x")[:2])
    except (ValueError, IndexError) as err:
        raise reclib.StepError(f"{path} has no video stream") from err
    return w, h


def has_audio(path):
    out = reclib.run([reclib.need("ffprobe"), "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)], capture=True)
    return bool(out.strip())


def parse_pip(text):
    try:
        cx, cy, d = (int(round(float(v))) for v in text.split(","))
    except ValueError as err:
        raise reclib.StepError(f"--pip expects cx,cy,d in pixels, got {text!r}") from err
    if d < 8:
        raise reclib.StepError("--pip diameter must be at least 8 px")
    return cx, cy, d + (d % 2)  # even size for yuv420p


def disc_alpha(d, inner=None):
    """geq alpha: a disc of diameter d with a 2 px soft edge; with `inner`, an annulus (the ring)."""
    r = d / 2
    dist = f"hypot(X-{r - 0.5:.1f},Y-{r - 0.5:.1f})"
    outer = f"clip(({r:.1f}-{dist})/2,0,1)"
    if inner is None:
        return f"255*{outer}"
    return f"255*{outer}*clip(({dist}-{inner:.1f})/2+1,0,1)"


def main():
    ap = argparse.ArgumentParser(description="Composite the webcam as a circular PiP over a render and copy the mix audio untouched.")
    ap.add_argument("project", help="project directory")
    ap.add_argument("--render", required=True, help="silent render from HyperFrames")
    ap.add_argument("-o", "--out", required=True, help="output MP4")
    ap.add_argument("--ratio", choices=sorted(PIP), help="frame ratio for the default PiP place (default: from the render size)")
    ap.add_argument("--from", dest="start", type=float, default=0.0, help="webcam offset in edited seconds (part and short builds)")
    ap.add_argument("--pip", help="cx,cy,d of the circle in pixels (default by ratio)")
    ap.add_argument("--no-pip", action="store_true", help="no webcam overlay")
    ap.add_argument("--ring", metavar="HEX", help="draw a thin ring in this colour, e.g. FFFFFF")
    ap.add_argument("--audio", help="audio file to copy (default: <project>/assets/audio/mix.m4a)")
    args = ap.parse_args()
    root = reclib.project_dir(args.project)
    render = Path(args.render).resolve()
    if not render.exists():
        raise reclib.StepError(f"render not found: {render}")
    audio = Path(args.audio).resolve() if args.audio else root / "assets/audio/mix.m4a"
    if not audio.exists():
        raise reclib.StepError(f"audio not found: {audio}; run mix.py or pass --audio")
    if not has_audio(audio):
        raise reclib.StepError(f"{audio} has no audio stream")
    if args.start < 0:
        raise reclib.StepError("--from must be >= 0")
    if args.ring and not re.fullmatch(r"#?[0-9A-Fa-f]{6}", args.ring):
        raise reclib.StepError("--ring expects a hex colour like FFFFFF")
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    w, h = size(render)
    length = reclib.duration(render)
    ratio = args.ratio or ("16x9" if w > h else "9x16" if h > w else "1x1")
    inputs = ["-i", str(render)]
    if args.no_pip:
        graph = "[0:v]format=yuv420p[v]"
    else:
        cam = root / "assets/video/webcam.mp4"
        if not cam.exists():
            raise reclib.StepError(f"missing {cam}; pass --no-pip for a video without the webcam")
        cam_len = reclib.duration(cam)
        if args.start >= cam_len:
            raise reclib.StepError(f"--from {args.start:g} is past the end of the webcam ({cam_len:.2f}s)")
        if cam_len - args.start < length - 0.05:
            print(f"warning: the webcam ends {length - (cam_len - args.start):.2f}s before the render; the PiP disappears there", file=sys.stderr)
        cx, cy, d = parse_pip(args.pip) if args.pip else PIP[ratio]
        x, y = cx - d // 2, cy - d // 2
        if x < 0 or y < 0 or x + d > w or y + d > h:
            print(f"warning: the PiP circle ({cx},{cy},{d}) leaves the {w}x{h} frame", file=sys.stderr)
        inputs += ["-ss", f"{args.start:.3f}", "-t", f"{length + 1:.3f}", "-i", str(cam)]
        steps = [
            f"[1:v]crop='min(iw,ih)':'min(iw,ih)',scale={d}:{d},setsar=1,format=yuva420p,"
            f"geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='{disc_alpha(d)}'[cam]",
            f"[0:v][cam]overlay={x}:{y}:eof_action=pass:format=auto[base]",
        ]
        last = "base"
        if args.ring:
            color = args.ring.lstrip("#")
            steps.append(f"color=c=0x{color}:s={d}x{d}:d={length + 1:.3f},format=yuva420p,"
                         f"geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='{disc_alpha(d, d / 2 - RING_PX)}'[ring]")
            steps.append(f"[base][ring]overlay={x}:{y}:shortest=0:eof_action=pass[ringed]")
            last = "ringed"
        steps.append(f"[{last}]format=yuv420p[v]")
        graph = ";".join(steps)
    a_idx = 1 if args.no_pip else 2
    inputs += ["-i", str(audio)]
    if reclib.duration(audio) < length - 0.1:
        print(f"warning: {audio.name} is shorter than the render; the end is silent", file=sys.stderr)
    reclib.ffmpeg([
        *inputs, "-filter_complex", graph, "-map", "[v]", "-map", f"{a_idx}:a:0",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-t", f"{length:.3f}", "-movflags", "+faststart", str(out),
    ])
    print(f"finish -> {out} ({reclib.duration(out):.2f}s, {w}x{h}, {'no PiP' if args.no_pip else f'PiP {ratio}'})")
    return 0


if __name__ == "__main__":
    reclib.main_guard(main)
