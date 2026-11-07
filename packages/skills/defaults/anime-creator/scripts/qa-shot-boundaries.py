#!/usr/bin/env python3
"""Check every join between two clip shots of a scene: the last N frames of A against the first N frames of B.

usage: uv run -q --with numpy python -X utf8 qa-shot-boundaries.py <scene-dir> [--n 6] [--strips <dir>] [--json]
                                                                    [--luma 18] [--hist 0.35] [--ratio 3.0]
                                                                    [--chained-ratio 4.5]
Reads only the range the EDL uses (in, speed, start/end), on a 160x90 proxy. Per join:
  luma   mean-luma jump across the join (a lighting pop)
  hist   colour-histogram distance 0..1 across the join (a palette or grade jump)
  ratio  the join's frame difference over the median frame difference inside A and B (a jump in pose or framing
         that the shots' own motion does not explain)
The thresholds apply to joins whose `boundary` promises continuity (locked-composition, camera-transition; see
studio/shot_boundary_contract.py). An intentional-cut, or `boundary.intentional_discontinuity: "<reason>"`, is
reported as allowed. A join without a contract is listed as info, so legacy scenes never fail.
A chained join (boundary.chain, or B's gen-plan job carries `chain`) starts B on a still taken from A, and image-to-
video models redraw that still (Seedance: about 10/255 mean difference with no framing shift, ratio 3.48 on a join that
reads continuous at speed 1). Such a join is judged on --chained-ratio instead of --ratio, and A's out-point frame is
compared with the chain still (src_ratio): a still taken anywhere but the EDL out-point is flagged (chain --at edl). --strips writes one
PNG per join (A's tail over B's head) for a human or AI look. Exits 1 when a continuity join is flagged.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402

W, H = 160, 90
CONTINUOUS = ("locked-composition", "camera-transition")


def frames(clip: Path, t0: float, n: int, fps: float, *, tail: bool) -> np.ndarray:
    """n RGB frames starting at t0 (or ending at t0 when tail) -> (n, H, W, 3) float32."""
    start = max(0.0, t0 - n / fps) if tail else t0
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{start:.4f}", "-i", str(clip), "-frames:v", str(n),
           "-vf", f"fps={fps},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(io.resolve_cmd(cmd), capture_output=True).stdout
    k = len(raw) // (W * H * 3)
    return np.frombuffer(raw[: k * W * H * 3], np.uint8).reshape(k, H, W, 3).astype(np.float32)


def _hist(f: np.ndarray, bins: int = 16) -> np.ndarray:
    h = np.concatenate([np.histogram(f[..., c], bins=bins, range=(0, 256))[0] for c in range(3)]).astype(np.float64)
    return h / max(h.sum(), 1.0)


def join_metrics(a: np.ndarray, b: np.ndarray) -> dict:
    """a: A's last frames, b: B's first frames (each at least one frame)."""
    la, fb = a[-1], b[0]
    inner = [float(np.abs(x[i + 1] - x[i]).mean()) for x in (a, b) for i in range(len(x) - 1)]
    base = float(np.median(inner)) if inner else 0.0
    join = float(np.abs(fb - la).mean())
    return {"luma": round(abs(float(la.mean()) - float(fb.mean())), 2),
            "hist": round(0.5 * float(np.abs(_hist(la) - _hist(fb)).sum()), 3),
            "join_diff": round(join, 2), "inner_diff": round(base, 2), "ratio": round(join / max(base, 1.0), 2)}


def judge(m: dict, boundary: dict | None, thr: dict, *, chained: bool = False) -> tuple[str, list[str]]:
    b = boundary or {}
    lim = {**thr, "ratio": thr.get("chained_ratio", thr["ratio"])} if chained else thr
    over = [k for k in ("luma", "hist", "ratio") if m[k] > lim[k]]
    why = [f"{k} {m[k]} > {lim[k]}" + (" (chained)" if chained and k == "ratio" else "") for k in over]
    if chained and m.get("src_ratio") is not None and m["src_ratio"] > thr["ratio"]:
        why.append(f"src_ratio {m['src_ratio']} > {thr['ratio']}: A's out-point is not the frame B was chained from")
    if b.get("intentional_discontinuity"):
        return "allowed", [f"intentional discontinuity: {b['intentional_discontinuity']}"]
    if b.get("mode") == "intentional-cut":
        return "allowed", ["intentional cut"]
    if b.get("mode") in CONTINUOUS:
        return ("flag" if why else "ok"), why
    return "info", why or ["no boundary contract"]


def chain_still(ep: Path, shot: dict, plan: dict) -> tuple[bool, Path | None]:
    """(chained, still) for shot B: the still is the chain proposal's out (or the job's first frame) it started on.
    After trim --rewrite or an upscale the shot reads a copy and keeps the generated clip in src_raw."""
    jobs = plan.get("jobs", [])
    video = [j for j in jobs if j.get("kind", "video") == "video"]
    # after an upscale `src` is the upscale job's out (no chain). A video job reading `src` wins, so a stale src_raw
    # never beats a retake; src_raw only when no video job is `src`, then any job; a job with a chain first
    found = []
    for group, keys in ((video, ("src",)), (video, ("src_raw",)), (jobs, ("src", "src_raw"))):
        found = [j for j in group for k in keys if shot.get(k) and j.get("out") == shot[k]]
        if found:
            break
    job = next((j for j in found if j.get("chain")), found[0] if found else {})
    chained = bool((shot.get("boundary") or {}).get("chain") or job.get("chain"))
    rel = (job.get("chain") or {}).get("out") or job.get("first")
    return chained, (ep / rel if chained and rel else None)


def still(path: Path) -> np.ndarray | None:
    raw = subprocess.run(io.resolve_cmd(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-frames:v", "1", "-vf", f"scale={W}:{H}",
                                         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]), capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(np.float32) if len(raw) == W * H * 3 else None


def pairs(scene: Path) -> list[tuple[dict, dict]]:
    shots = io.load_json(scene / "edl.json").get("shots", [])
    return [(a, b) for a, b in zip(shots, shots[1:]) if a.get("src") and b.get("src")]


def strip(a: np.ndarray, b: np.ndarray, out: Path) -> None:
    row = lambda x: np.concatenate(list(x), axis=1)  # noqa: E731
    n = max(len(a), len(b))
    pad = lambda x: np.concatenate([x, np.zeros((n - len(x), H, W, 3), np.float32)]) if len(x) < n else x  # noqa: E731
    img = np.concatenate([row(pad(a)), np.full((4, n * W, 3), 255, np.float32), row(pad(b))]).astype(np.uint8)
    subprocess.run(io.resolve_cmd(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{img.shape[1]}x{img.shape[0]}",
                                   "-i", "-", str(out)]), input=img.tobytes(), check=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scene")
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--strips")
    ap.add_argument("--json", action="store_true")
    for k, v in (("--luma", 18.0), ("--hist", 0.35), ("--ratio", 3.0), ("--chained-ratio", 4.5)):
        ap.add_argument(k, type=float, default=v)
    a = ap.parse_args()
    sd = Path(a.scene).expanduser().resolve()
    fps = float(io.load_json(sd / "edl.json").get("fps", 24))
    thr = {"luma": a.luma, "hist": a.hist, "ratio": a.ratio, "chained_ratio": a.chained_ratio}
    plan = io.load_json(sd.parents[1] / "gen-plan.json") if (sd.parents[1] / "gen-plan.json").exists() else {}
    rows, flagged = [], 0
    for sa, sb in pairs(sd):
        ep = sd.parents[1]  # EDL `src` paths are relative to the episode
        ca, cb = ep / sa["src"], ep / sb["src"]
        if not (ca.exists() and cb.exists()):
            rows.append({"join": f"{sa['id']}|{sb['id']}", "verdict": "skip", "why": ["clip missing"]})
            continue
        a_end = float(sa.get("in", 0)) + (sa["end"] - sa["start"]) * float(sa.get("speed", 1.0))
        fa, fb = frames(ca, a_end, a.n, fps, tail=True), frames(cb, float(sb.get("in", 0)), a.n, fps, tail=False)
        if not len(fa) or not len(fb):
            rows.append({"join": f"{sa['id']}|{sb['id']}", "verdict": "skip", "why": ["no frames decoded"]})
            continue
        m = join_metrics(fa, fb)
        chained, still_p = chain_still(ep, sb, plan)
        if chained:
            st = still(still_p) if still_p and still_p.exists() else None
            m["src_ratio"] = None if st is None else round(float(np.abs(fa[-1] - st).mean()) / max(m["inner_diff"], 1.0), 2)
        verdict, why = judge(m, sb.get("boundary"), thr, chained=chained)
        if chained and m.get("src_ratio") is None:
            why.append("chained, but the chain still is missing: judged on --chained-ratio only")
        flagged += verdict == "flag"
        if a.strips:
            Path(a.strips).mkdir(parents=True, exist_ok=True)
            strip(fa, fb, Path(a.strips) / f"{sa['id']}-{sb['id']}.png")
        rows.append({"join": f"{sa['id']}|{sb['id']}", "mode": (sb.get("boundary") or {}).get("mode"), "chained": chained,
                     "verdict": verdict, "why": why, **m})
    if a.json:
        print(json.dumps(rows, indent=2))
    else:
        for r in rows:
            print(f"{r['join']:12s} {r['verdict']:7s} " + " ".join(f"{k}={r[k]}" for k in ("luma", "hist", "ratio", "src_ratio") if r.get(k) is not None)
                  + "  " + "; ".join(r["why"]))
    sys.exit(1 if flagged else 0)


if __name__ == "__main__":
    main()
