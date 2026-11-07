#!/usr/bin/env python3
"""Estimate a relative depth map for a painted background plate with Depth Anything V2 (ONNX, local).

usage: uv run --with onnxruntime --with pillow --with numpy python estimate-plate-depth.py model.onnx plate.png out-depth.png [--size 518] [--matte "#140a0e"]

The plate may carry a transparent sky: it is flattened over a dark matte first so
the model sees a night sky rather than a hole. The output is the model's relative
inverse depth (white = near), normalised over the plate's opaque pixels to 0..1
and written as an 8-bit greyscale PNG at the plate's own size. The 3D set
smooths it and maps it to multiplane depths; this script only measures.

Two input sizes are run (the given short side and 1.5x of it) and averaged: the
small pass keeps the global layout, the large one sharpens building edges.
Model: Depth Anything V2 small ONNX (download once from its Hugging Face release; local inference avoids
hosted-model downloads that some networks block). Supported: macOS, Linux, Windows.
"""
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def parse(argv):
    a = argv[:]
    model, src, dst = a.pop(0), a.pop(0), a.pop(0)
    o = {"size": 518, "matte": "#140a0e"}
    while a:
        k = a.pop(0)[2:]
        o[k] = int(a.pop(0)) if k == "size" else a.pop(0)
    return model, src, dst, o


def run(sess, rgb, short):
    h, w = rgb.shape[:2]
    s = short / min(h, w)
    nh, nw = max(14, round(h * s / 14) * 14), max(14, round(w * s / 14) * 14)
    x = np.asarray(Image.fromarray(rgb).resize((nw, nh), Image.BICUBIC), np.float32) / 255
    x = ((x - MEAN) / STD).transpose(2, 0, 1)[None]
    name = sess.get_inputs()[0].name
    d = sess.run(None, {name: x})[0]
    d = np.squeeze(d).astype(np.float32)
    return np.asarray(Image.fromarray(d).resize((w, h), Image.BICUBIC), np.float32)


def main():
    model, src, dst, o = parse(sys.argv[1:])
    im = Image.open(src).convert("RGBA")
    m = o["matte"].lstrip("#")
    bg = Image.new("RGBA", im.size, tuple(int(m[i:i + 2], 16) for i in (0, 2, 4)) + (255,))
    bg.alpha_composite(im)
    rgb = np.asarray(bg.convert("RGB"))
    alpha = np.asarray(im)[..., 3] > 128
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    a = run(sess, rgb, o["size"])
    b = run(sess, rgb, int(o["size"] * 1.5))
    norm = lambda d: (d - np.percentile(d[alpha], 1)) / max(1e-6, np.percentile(d[alpha], 99) - np.percentile(d[alpha], 1))
    d = np.clip(0.5 * norm(a) + 0.5 * norm(b), 0, 1)
    d[~alpha] = 0
    Image.fromarray((d * 255 + 0.5).astype(np.uint8)).save(dst)
    print(dst, im.size, "opaque px", int(alpha.sum()))


if __name__ == "__main__":
    main()
