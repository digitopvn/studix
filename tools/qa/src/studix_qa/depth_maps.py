"""depth-maps: a relative depth map per granted image (Depth Anything V2 on the CPU), for 2.5D parallax and rack
focus. Needs the optional `depth` extra (torch, transformers, pillow), installed only in the optional worker
image; the default image reports UNAVAILABLE.

Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/make-depth-maps.py. The model is read
from a directory baked into the image at build time (`python -m studix_qa.depth_maps fetch <dir>`), never
downloaded at run time. Each image gets `<id>.depth.png` in the run's output directory: 8-bit grey at the image's
own size, white = near, the model's relative inverse depth normalised over the 1st-99th percentile; two input
sizes (the given short side and twice it) are averaged, and the near side is grown by a few px so a foreground
edge sits just outside its colour edge.
"""
from __future__ import annotations

import argparse
import os

import numpy as np

from .sandbox import Deadline, Media, Outputs, ToolError

DEFAULT_MODEL_DIR = "/opt/studix-qa/models/depth-anything-v2-small"
DEFAULT_MODEL_ID = "depth-anything/Depth-Anything-V2-Small-hf"
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def normalise(d: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(d, 1), np.percentile(d, 99)
    return np.full_like(d, 0.5) if hi - lo < 1e-6 else (d - lo) / (hi - lo)  # a flat card stays mid


def model_size(h: int, w: int, short: int) -> tuple[int, int]:
    """Input size for one pass: the short side scaled to `short`, both sides multiples of 14 (the ViT patch)."""
    s = short / min(h, w)
    return max(14, round(h * s / 14) * 14), max(14, round(w * s / 14) * 14)


def grow_px(shape: tuple[int, ...]) -> int:
    """Odd max-filter size: about 1/360 of the short side on each side."""
    return 2 * max(1, round(min(shape[:2]) / 360)) + 1


def _load_model():
    try:
        import torch  # noqa: PLC0415 - optional dependency
        from transformers import AutoModelForDepthEstimation  # noqa: PLC0415
    except ImportError as err:
        raise ToolError("UNAVAILABLE", "depth-maps needs the optional worker image with torch",
                        {"extra": "depth"}) from err
    model_dir = os.environ.get("STUDIX_QA_DEPTH_MODEL") or DEFAULT_MODEL_DIR
    if not os.path.isdir(model_dir):
        raise ToolError("UNAVAILABLE", "the depth model is not installed in this image", {"modelDir": model_dir})
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    return torch, AutoModelForDepthEstimation.from_pretrained(model_dir, local_files_only=True).eval()


def _infer(torch, model, rgb: np.ndarray, short: int) -> np.ndarray:
    from PIL import Image  # noqa: PLC0415

    h, w = rgb.shape[:2]
    nh, nw = model_size(h, w, short)
    x = np.asarray(Image.fromarray(rgb).resize((nw, nh), Image.BICUBIC), np.float32) / 255
    x = torch.from_numpy(((x - MEAN) / STD).transpose(2, 0, 1)[None].copy())
    with torch.inference_mode():
        d = model(pixel_values=x).predicted_depth  # (1, nh, nw) relative inverse depth
    d = torch.nn.functional.interpolate(d[:, None], size=(h, w), mode="bicubic", align_corners=False)
    return d[0, 0].numpy().astype(np.float32)


def run(payload: dict, media: Media, deadline: Deadline, outputs: Outputs) -> dict:
    refs = payload.get("images")
    if not isinstance(refs, list) or not refs:
        raise ToolError("VALIDATION", "images must be a non-empty array of media ids")
    size = int(payload.get("size", 518))
    if size % 14 or not 14 <= size <= 1036:
        raise ToolError("VALIDATION", "size must be a multiple of 14 between 14 and 1036")
    paths = [(ref, media.path(ref)) for ref in refs]
    torch, model = _load_model()
    from PIL import Image, ImageFilter  # noqa: PLC0415

    written = []
    for ref, path in paths:
        deadline.remaining()
        rgb = np.asarray(Image.open(path).convert("RGB"))
        d = np.clip(0.5 * normalise(_infer(torch, model, rgb, size))
                    + 0.5 * normalise(_infer(torch, model, rgb, size * 2)), 0, 1)
        name = f"{ref}.depth.png"
        out = outputs.path(name)
        Image.fromarray((d * 255 + 0.5).astype(np.uint8), "L").filter(ImageFilter.MaxFilter(grow_px(d.shape))).save(out)
        written.append({"media": ref, "file": name, "width": int(d.shape[1]), "height": int(d.shape[0])})
    return {"outputs": written}


def fetch_model(target: str, model_id: str, revision: str) -> None:
    """Image build step (network allowed there, never at run time): download the weights into `target`."""
    from huggingface_hub import snapshot_download  # noqa: PLC0415 - installed with transformers

    snapshot_download(repo_id=model_id, revision=revision, local_dir=target)


def main() -> None:
    ap = argparse.ArgumentParser(description="Bake the depth model into the optional worker image.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    fetch = sub.add_parser("fetch")
    fetch.add_argument("target")
    fetch.add_argument("--model", default=DEFAULT_MODEL_ID)
    fetch.add_argument("--revision", required=True, help="commit sha of the model repo, so the image is reproducible")
    a = ap.parse_args()
    fetch_model(a.target, a.model, a.revision)


if __name__ == "__main__":
    main()
