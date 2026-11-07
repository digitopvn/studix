#!/usr/bin/env python3
"""Turn a side-on painted plate (a roof, a wall, a bridge) into a receding one by panning its camera (a yaw).

usage: uv run --with opencv-python-headless --with numpy python warp-plate-yaw-perspective.py in.png out.png
       --f 1097 --yaw 26 --horizon 438 --ridge 505 [--width W] [--cx COL]
A pure camera rotation re-projects an image exactly whatever the scene depth, so the result is a true
perspective view from the same eye: lines parallel to the old image plane now recede to a vanishing point on
the horizon row. Side-on sets read like an old 2D game; this is the cheap fix before regenerating a plate.
  f        focal length in plate px (match the 3D set: zRef / world px per plate px)
  yaw      degrees; positive puts the vanishing point on the left (near end right)
  horizon  eye-level row of the source plate (a little above its ridge or ground line)
  ridge    the source row whose new position the caller needs (printed at left, centre, right)
  width    output width in px (default: source width); cx: source column the eye looks at (default: middle)
The source is mirror-tiled sideways first, so the far end has plate to sample; resampling is premultiplied.
Supported: macOS, Linux, Windows.
"""
import argparse

import cv2
import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    for k, v in (("f", 1097.0), ("yaw", 26.0), ("horizon", 438.0), ("ridge", 505.0), ("width", 0.0), ("cx", 0.0)):
        ap.add_argument(f"--{k}", type=float, default=v)
    o = ap.parse_args()
    img = cv2.imread(o.src, cv2.IMREAD_UNCHANGED)
    if img.shape[2] == 3:
        img = np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])
    img = img.astype(np.float32) / 255.0
    h, w = img.shape[:2]
    img[..., :3] *= img[..., 3:4]  # premultiply so matte edges resample without a fringe
    strip = np.concatenate([img[:, ::-1], img, img[:, ::-1]], axis=1)
    f, th, cy = o.f, np.radians(o.yaw), o.horizon
    cx = o.cx or w / 2.0
    ow = int(o.width) or w
    xs, ys = np.meshgrid(np.arange(ow, dtype=np.float32) + 0.5 - ow / 2.0, np.arange(h, dtype=np.float32) + 0.5 - cy)
    rx = xs * np.cos(th) - f * np.sin(th)  # output ray -> source ray (rotation about the vertical axis)
    rz = xs * np.sin(th) + f * np.cos(th)
    mx = (f * rx / rz + cx + w - 0.5).astype(np.float32)  # + w: the centre copy of the strip
    my = (f * ys / rz + cy - 0.5).astype(np.float32)
    out = np.clip(cv2.remap(strip, mx, my, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_CONSTANT, borderValue=0), 0, 1)
    a = out[..., 3:4]
    out[..., :3] = np.where(a > 1e-4, out[..., :3] / np.maximum(a, 1e-4), 0)
    cv2.imwrite(o.dst, (out * 255 + 0.5).astype(np.uint8))
    for name, x in (("left", 0), ("centre", ow / 2), ("right", ow)):
        z = (x - ow / 2.0) * np.sin(th) + f * np.cos(th)
        print(f"ridge {name}: row {cy + (o.ridge - cy) * z / f:.1f}")


if __name__ == "__main__":
    main()
