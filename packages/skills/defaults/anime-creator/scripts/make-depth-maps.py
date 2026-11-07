#!/usr/bin/env python3
"""Write a relative depth map next to every cel a scene uses, for the GL cel plate's 2.5D parallax and rack focus.

usage: uv run --with torch --with transformers --with pillow python make-depth-maps.py <scene-dir>... [--force]
       [--model depth-anything/Depth-Anything-V2-Small-hf] [--size 518]

Cels are the `img` of every "cel" shot in the scene's edl.json plus every image in assets/cels/ (alternates and
fallbacks get a map too). Each `<name>.<ext>` gets `<name>.depth.png` beside it: 8-bit greyscale at the cel's own
size, white = near, the model's relative inverse depth normalised over the 1st-99th percentile. The engine loads
it for a cel shot whose scene-config entry has `depth` (see references/gl-compositing-and-fx.md).

Depth Anything V2 runs locally on the CPU (free; the weights download once into the Hugging Face cache). Two
input sizes are averaged, the given short side and twice it: the small pass keeps the global layout, the
large one sharpens edges (thin parts such as claws and railings keep their own depth). The near side is then
grown by a few px (a max filter, about 1/360 of the short side), so a foreground edge sits just outside its
colour edge: on a depth move the drawing's silhouette stays crisp and the gap it opens stretches background.
A source image is never written; an existing map newer than its cel is kept unless --force.
Supported: macOS, Linux, Windows.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageFilter
from transformers import AutoModelForDepthEstimation

EXTS = {".jpg", ".jpeg", ".png", ".webp"}
SUFFIX = ".depth.png"
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def depth_path(img: Path) -> Path:
    return img.with_name(img.stem + SUFFIX)


def scene_cels(scene: Path) -> list[Path]:
    edl = json.loads((scene / "edl.json").read_text(encoding="utf-8"))
    cels = {(scene / s["img"]).resolve() for s in edl["shots"] if s.get("kind") == "cel" and s.get("img")}
    folder = scene / "assets" / "cels"
    if folder.is_dir():
        cels |= {p.resolve() for p in folder.iterdir() if p.suffix.lower() in EXTS and not p.name.endswith(SUFFIX)}
    missing = sorted(str(p) for p in cels if not p.exists())
    if missing:
        print("missing cels (skipped):", ", ".join(missing))
    return sorted(p for p in cels if p.exists())


def run(model, rgb: np.ndarray, short: int) -> np.ndarray:
    h, w = rgb.shape[:2]
    s = short / min(h, w)
    nh, nw = max(14, round(h * s / 14) * 14), max(14, round(w * s / 14) * 14)
    x = np.asarray(Image.fromarray(rgb).resize((nw, nh), Image.BICUBIC), np.float32) / 255
    x = torch.from_numpy(((x - MEAN) / STD).transpose(2, 0, 1)[None].copy())
    with torch.inference_mode():
        d = model(pixel_values=x).predicted_depth  # (1, nh, nw) relative inverse depth
    d = torch.nn.functional.interpolate(d[:, None], size=(h, w), mode="bicubic", align_corners=False)
    return d[0, 0].numpy().astype(np.float32)


def normalise(d: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(d, 1), np.percentile(d, 99)
    return np.full_like(d, 0.5) if hi - lo < 1e-6 else (d - lo) / (hi - lo)  # a flat card (black, a screen) stays mid


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenes", nargs="+")
    ap.add_argument("--model", default="depth-anything/Depth-Anything-V2-Small-hf")
    ap.add_argument("--size", type=int, default=518, help="short side of the small pass (multiple of 14)")
    ap.add_argument("--force", action="store_true", help="rewrite maps that are already newer than their cel")
    o = ap.parse_args()
    model = AutoModelForDepthEstimation.from_pretrained(o.model).eval()
    for scene in map(Path, o.scenes):
        done = kept = 0
        for img in scene_cels(scene):
            dst = depth_path(img)
            assert dst != img and dst.name.endswith(SUFFIX)  # never touch a source image
            if not o.force and dst.exists() and dst.stat().st_mtime >= img.stat().st_mtime:
                kept += 1
                continue
            rgb = np.asarray(Image.open(img).convert("RGB"))
            d = np.clip(0.5 * normalise(run(model, rgb, o.size)) + 0.5 * normalise(run(model, rgb, o.size * 2)), 0, 1)
            grow = 2 * max(1, round(min(d.shape) / 360)) + 1
            Image.fromarray((d * 255 + 0.5).astype(np.uint8), "L").filter(ImageFilter.MaxFilter(grow)).save(dst)
            done += 1
            print(dst.relative_to(scene.resolve()) if dst.is_relative_to(scene.resolve()) else dst)
        print(f"{scene.name}: {done} written, {kept} up to date")


if __name__ == "__main__":
    main()
