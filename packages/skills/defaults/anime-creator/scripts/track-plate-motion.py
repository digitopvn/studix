#!/usr/bin/env python3
"""Track the motion of a video shot's plate (its conformed clip) and write one 2x3 affine per clip frame, so light FX
and DOM overlays laid out on the footage ride it instead of holding still while the picture moves.

usage: uv run --with opencv-python-headless --with numpy python track-plate-motion.py <scene-dir> [name:]<shot>[@x0,y0,x1,y1]...
       [--model similarity|affine] [--sheet DIR]

Each shot is read from <scene-dir>/clips/<id>.mp4 (frame 0 = the shot's first frame). The optional region is a box in
frame fractions (0..1, y down) around what the FX sit on (a face, a dome, a screen); without it the whole frame is
tracked. The region rides the track from frame to frame, so it stays on its subject. A `name:` prefix stores the track
under that name instead of the shot id, for a second track on the same shot (a subject moving against its own plate):
the shot's own entry keeps feeding fx.map, and the named one is read by hand (trackMap / pinToTrack on TRACKS[name]).

Per frame: corners inside the region of a reference frame are followed into the current frame with pyramidal
Lucas-Kanade, a forward-backward check drops the unreliable ones, and RANSAC fits the reference-to-current
transform (similarity: shift, rotation, uniform scale; affine adds shear). Measuring against a reference instead of
the previous frame keeps drift down; the reference moves on when too few of its points survive. A frame with no fit
keeps the previous frame's velocity. The parameters get a light centred gaussian (no lag) before writing.

Output: <scene-dir>/src/scene/plate-tracks.js, `export const TRACKS = {...}` with {fps, m: [[a, b, c, d, e, f], ...]}
per shot (frame-0 px to frame-i px at the EDL size; x' = a x + b y + c, y' = d x + e y + f). Shots already in the file
and not named again are kept. Hand it to the engine as SCENE.tracks (see engine/src/core/plate-track.js).
--sheet DIR writes <id>-track.jpg there: frames along the shot with the tracked region and a point grid drawn on.
Supported: macOS, Linux, Windows.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

import cv2
import numpy as np

AW = 960                  # analysis width; results are scaled to the EDL size
SMOOTH = 0.7              # gaussian sigma in frames for the parameter paths
FB_MAX = 1.0              # forward-backward error (analysis px) above which a point is dropped
MIN_PTS = 10
REFRESH = 0.45            # move the reference on when fewer than this share of its points survive


def read_frames(clip: Path, aw: int, ah: int):
    p = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-i", str(clip), "-vf", f"scale={aw}:{ah}", "-f", "rawvideo",
                          "-pix_fmt", "gray", "-"], stdout=subprocess.PIPE)
    out = []
    while True:
        b = p.stdout.read(aw * ah)
        if len(b) < aw * ah:
            break
        out.append(np.frombuffer(b, np.uint8).reshape(ah, aw))
    p.wait()
    return out


def h3(m):
    return np.vstack([m, [0, 0, 1]])


def region_mask(shape, box, acc):
    """Mask of the region box (frame fractions) carried by the accumulated transform acc (3x3, analysis px)."""
    ah, aw = shape
    x0, y0, x1, y1 = box
    q = np.array([[x0 * aw, y0 * ah], [x1 * aw, y0 * ah], [x1 * aw, y1 * ah], [x0 * aw, y1 * ah]], np.float64)
    q = (acc[:2, :2] @ q.T).T + acc[:2, 2]
    m = np.zeros(shape, np.uint8)
    cv2.fillConvexPoly(m, np.round(q).astype(np.int32), 255)
    return m


def fit(p0, p1, model):
    f = cv2.estimateAffinePartial2D if model == "similarity" else cv2.estimateAffine2D
    m, inl = f(p0, p1, method=cv2.RANSAC, ransacReprojThreshold=1.0, maxIters=4000, confidence=0.995)
    if m is None or inl is None or inl.sum() < MIN_PTS:
        return None
    return m


def track(frames, box, model):
    """Per-frame 3x3 transforms (analysis px), frame 0 to frame i."""
    lk = dict(winSize=(21, 21), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    accs = [np.eye(3)]
    ref, ref_acc, ref_pts, n0 = frames[0], np.eye(3), None, 0
    vel = np.eye(3)

    def seed(img, acc):
        pts = cv2.goodFeaturesToTrack(img, 500, 0.01, 6, mask=region_mask(img.shape, box, acc))
        return pts if pts is not None and len(pts) >= MIN_PTS else None

    ref_pts = seed(ref, ref_acc)
    n0 = 0 if ref_pts is None else len(ref_pts)
    for i in range(1, len(frames)):
        cur, step = frames[i], None
        if ref_pts is not None:
            p1, st, _ = cv2.calcOpticalFlowPyrLK(ref, cur, ref_pts, None, **lk)
            p0b, stb, _ = cv2.calcOpticalFlowPyrLK(cur, ref, p1, None, **lk)
            ok = (st.ravel() == 1) & (stb.ravel() == 1) & (np.linalg.norm(p0b - ref_pts, axis=2).ravel() < FB_MAX)
            if ok.sum() >= MIN_PTS:
                m = fit(ref_pts[ok], p1[ok], model)
                if m is not None:
                    step = h3(m) @ ref_acc          # frame 0 -> current through the reference
            survive = ok.sum() / max(1, n0)
        else:
            survive = 0.0
        acc = step if step is not None else vel @ accs[-1]
        vel = acc @ np.linalg.inv(accs[-1])
        accs.append(acc)
        if step is None or survive < REFRESH:
            ref, ref_acc = cur, acc
            ref_pts = seed(ref, ref_acc)
            n0 = 0 if ref_pts is None else len(ref_pts)
    return accs


def smooth(accs, sigma):
    """Centred gaussian over each affine parameter (no lag; the ends are held)."""
    a = np.array([m[:2].ravel() for m in accs])
    if sigma <= 0 or len(a) < 3:
        return a
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(a, ((r, r), (0, 0)), mode="edge")
    return np.stack([np.convolve(pad[:, j], k, mode="valid") for j in range(a.shape[1])], axis=1)


def to_full(rows, s):
    """Analysis-px affines to EDL-size px: scale the shift, keep the linear part."""
    out = rows.copy()
    out[:, 2] *= s
    out[:, 5] *= s
    return out


def sheet(frames, rows, box, s, path: Path, n=8):
    ah, aw = frames[0].shape
    x0, y0, x1, y1 = box
    q = np.array([[x0 * aw, y0 * ah], [x1 * aw, y0 * ah], [x1 * aw, y1 * ah], [x0 * aw, y1 * ah]])
    gx, gy = np.meshgrid(np.linspace(x0, x1, 5) * aw, np.linspace(y0, y1, 4) * ah)
    grid = np.stack([gx.ravel(), gy.ravel()], 1)
    tiles = []
    for i in np.linspace(0, len(frames) - 1, n).round().astype(int):
        m = rows[i].reshape(2, 3).copy()
        m[:, 2] /= s
        img = cv2.cvtColor(frames[i], cv2.COLOR_GRAY2BGR)
        qq = (m[:, :2] @ q.T).T + m[:, 2]
        cv2.polylines(img, [np.round(qq).astype(np.int32)], True, (0, 220, 255), 2)
        for p in (m[:, :2] @ grid.T).T + m[:, 2]:
            cv2.circle(img, (int(p[0]), int(p[1])), 4, (60, 60, 255), -1)
        cv2.putText(img, f"f{i}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2)
        tiles.append(cv2.resize(img, (aw // 2, ah // 2)))
    while len(tiles) % 4:
        tiles.append(np.zeros_like(tiles[0]))
    rows_img = [np.hstack(tiles[j:j + 4]) for j in range(0, len(tiles), 4)]
    cv2.imwrite(str(path), np.vstack(rows_img), [cv2.IMWRITE_JPEG_QUALITY, 70])


def read_existing(path: Path) -> dict:
    if not path.exists():
        return {}
    m = re.search(r"export const TRACKS = (\{.*\});", path.read_text(encoding="utf-8"), re.S)
    return json.loads(m.group(1)) if m else {}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scene", type=Path)
    ap.add_argument("shots", nargs="+", help="[name:]shot id, optionally @x0,y0,x1,y1 (frame fractions, y down)")
    ap.add_argument("--model", choices=["similarity", "affine"], default="similarity")
    ap.add_argument("--sheet", type=Path, default=None)
    args = ap.parse_args()

    edl = json.loads((args.scene / "edl.json").read_text(encoding="utf-8"))
    W, H, fps = edl.get("width", 1920), edl.get("height", 1080), edl["fps"]
    ah = round(AW * H / W / 2) * 2
    s = W / AW
    out_path = args.scene / "src/scene/plate-tracks.js"
    tracks = read_existing(out_path)
    for spec in args.shots:
        sid, _, roi = spec.partition("@")
        key, _, sid = sid.rpartition(":")
        key = key or sid
        box = tuple(float(v) for v in roi.split(",")) if roi else (0.0, 0.0, 1.0, 1.0)
        frames = read_frames(args.scene / "clips" / f"{sid}.mp4", AW, ah)
        if len(frames) < 2:
            raise SystemExit(f"{sid}: no frames in clips/{sid}.mp4")
        rows = to_full(smooth(track(frames, box, args.model), SMOOTH), s)
        tracks[key] = {"fps": fps, "m": [[round(float(v), 5 if j in (0, 1, 3, 4) else 2) for j, v in enumerate(r)] for r in rows]}
        last = rows[-1]
        print(f"{key}: {len(rows)} frames, last shift ({last[2]:+.1f}, {last[5]:+.1f}) px, "
              f"scale {np.sqrt(abs(last[0] * last[4] - last[1] * last[3])):.3f}")
        if args.sheet:
            args.sheet.mkdir(parents=True, exist_ok=True)
            sheet(frames, rows, box, s, args.sheet / f"{key}-track.jpg")
    body = json.dumps(dict(sorted(tracks.items())), separators=(",", ":"))
    out_path.write_text("// Plate tracks written by scripts/track-plate-motion.py: per video shot, one affine per clip frame (frame-0 px\n"
                        "// to frame-i px). Regenerate with that script; do not edit by hand.\n"
                        f"export const TRACKS = {body};\n", encoding="utf-8")


if __name__ == "__main__":
    main()
