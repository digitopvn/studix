"""Shot boundaries by camera intent, instead of "frame B = frame A with the same framing" for every pair.

An EDL shot may carry `boundary` describing how it joins the PREVIOUS shot:
  locked-composition  same camera, same framing: the clip continues the previous one (chain its last frame)
  camera-transition   the camera moves across the join: {camera: {from, to, move}}; the end frame is a NEW
                      composition, so "same framing as A" would be wrong
  intentional-cut     a real cut (angle, size or time changes): {cut: hard|match|on-action|whip|fx}; no chaining
Shots may also carry `axis` {actor: left|right} and `hands` {actor: right|left}; a continuous join that flips either
is an error. validate() checks the contract per pair; prompt_line() gives the compiler the sentence each mode needs;
chain_proposal() proposes the previous accepted take's last frame as the next first frame (locked-composition and
camera-transition only), or with `at` the frame shown just before a given second, such as the EDL out-point of a
take usable only up to mid-clip (edl_out_point()); it refuses a source that is rejected or has a major defect in the
frames before that point, and records the frame index and sha256 so a later retake of the source shows up as stale. previz_camera() turns a 3D blockout's
keyed camera (blockout.json: [{t, pos, target, fov}]) into the camera fields of a transition, as a proposal.
"""
from __future__ import annotations

import math
from pathlib import Path

from .reference_roles import sha256

MODES = ("locked-composition", "camera-transition", "intentional-cut")
CUT_KINDS = ("hard", "match", "on-action", "whip", "fx")


def validate(edl: dict) -> tuple[list[str], list[str]]:
    err, warn = [], []
    shots = edl.get("shots", [])
    for prev, s in zip(shots, shots[1:]):
        b = s.get("boundary")
        if not b:
            continue
        mode = b.get("mode")
        sid = s.get("id")
        if mode not in MODES:
            err.append(f"{sid}: boundary mode {mode!r} is not one of {', '.join(MODES)}")
            continue
        if mode == "locked-composition" and s.get("set") and prev.get("set") and s["set"] != prev["set"]:
            err.append(f"{sid}: locked-composition across sets ({prev['set']} -> {s['set']}); use intentional-cut")
        if mode == "camera-transition":
            cam = b.get("camera") or {}
            if not (cam.get("from") and cam.get("to")):
                err.append(f"{sid}: camera-transition needs camera.from and camera.to (the start and end composition)")
            if cam.get("from") and cam.get("from") == cam.get("to"):
                warn.append(f"{sid}: camera-transition with from == to is a locked composition")
        if mode == "intentional-cut" and b.get("cut") not in CUT_KINDS:
            err.append(f"{sid}: intentional-cut needs cut in {', '.join(CUT_KINDS)}")
        if mode == "intentional-cut" and b.get("chain"):
            err.append(f"{sid}: an intentional cut never chains the previous clip's last frame")
        if mode in ("locked-composition", "camera-transition") and not b.get("intentional_discontinuity"):
            # a continuous join keeps every actor on their side of the 180-degree line and the prop in the same hand
            for key, what in (("axis", "screen side"), ("hands", "hand")):
                was, now = prev.get(key) or {}, s.get(key) or {}
                for actor in sorted(set(was) & set(now)):
                    if was[actor] != now[actor]:
                        err.append(f"{sid}: {actor} {what} {was[actor]} -> {now[actor]} across a {mode} join "
                                   "(use intentional-cut, or boundary.intentional_discontinuity with a reason)")
    return err, warn


def prompt_line(boundary: dict | None, prev_id: str | None = None) -> str:
    """The sentence the prompt compiler adds for a shot's join; empty when the shot has no contract."""
    if not boundary:
        return ""
    mode = boundary.get("mode")
    src = f" of {prev_id}" if prev_id else ""
    if mode == "locked-composition":
        return f"Continue from the last frame{src}: same camera, lens and framing; only the action moves."
    if mode == "camera-transition":
        cam = boundary.get("camera") or {}
        move = f" ({cam['move']})" if cam.get("move") else ""
        return (f"Start on the last frame{src} ({cam.get('from', '')}); the camera moves{move} to end on {cam.get('to', '')}. "
                "The end frame is a new composition, not the start framing.")
    if mode == "intentional-cut":
        return f"A {boundary.get('cut', 'hard')} cut from the previous shot: a fresh composition, no carried framing."
    return ""


def edl_out_point(edl: dict, job: dict) -> float | None:
    """Source second where the EDL stops using job's clip (in + length x speed), or None when no shot uses it. A
    shot is matched by `src`; by id only when it names no src, so a retake's trim is never applied to this clip.
    A salvaged take can fill several shots: the one with job's shot id is used, else this raises with the choices."""
    shots = edl.get("shots", [])

    def out_point(shot):
        if shot.get("end") is None or shot.get("start") is None:
            return None
        return round(float(shot.get("in", 0)) + (float(shot["end"]) - float(shot["start"])) * float(shot.get("speed", 1.0)), 4)

    using = [s for s in shots if job.get("out") and s.get("src") == job["out"]]
    copies = [s for s in shots if job.get("out") and s.get("src_raw") == job["out"] and s.get("src") != job["out"]]
    # a copy's `in` counts from the trimmed/upscaled copy's start, not from job's clip: refuse when no shot reads the
    # clip directly, or when job's own shot is the copy
    if copies and (not using or any(s.get("id") == job.get("shot") for s in copies)):
        raise ValueError("shots " + ", ".join(f"{s.get('id')} ({s.get('src')})" for s in copies)
                         + f" read a trimmed copy of {job['out']} (or their src_raw is stale after a retake), so their"
                         " `in` is not a second of it: pass --at <seconds>")
    if len(using) > 1:
        using = [s for s in using if s.get("id") == job.get("shot")] or using
    if len(using) > 1:
        raise ValueError("shots " + ", ".join(f"{s.get('id')} (out {out_point(s)}s)" for s in using)
                         + f" all use {job['out']}: pass --at <seconds>")
    shot = (using or [None])[0] or next((s for s in shots if job.get("shot") and s.get("id") == job["shot"] and not s.get("src")), None)
    return out_point(shot) if shot else None


def chain_proposal(prev_job: dict, ep: Path, *, fps: float = 24, defect_frames: int = 6, at: float | None = None) -> dict:
    """Propose prev take's last frame (or the frame shown just before source second `at`) as the next first frame.
    -> {ok, reason?, source, frame_index | at, sha256, out, cmd}. `at` is cut by time (`trim` ending at it, the
    last frame kept), so the still is right whatever the clip's own frame rate; fps only sizes the defect window."""
    clip = prev_job.get("out")
    if prev_job.get("status") in ("rejected", "failed", "cancelled") or not clip:
        return {"ok": False, "reason": f"source {prev_job.get('id')} is {prev_job.get('status', 'not generated')}"}
    dur = float(prev_job.get("duration") or prev_job.get("units") or 0)
    if at is not None and (not math.isfinite(at) or at <= 0 or (dur and at > dur + 0.5 / fps)):
        return {"ok": False, "reason": f"--at {at}s is outside source {prev_job['id']} (0..{dur}s)"}
    end = dur if at is None else float(at)
    tail = end - defect_frames / fps
    # a major defect overlapping the frames up to the chain point; one that starts after it is cut away anyway
    bad = [d for d in prev_job.get("defects", []) if float(d.get("t1", 0)) >= tail and float(d.get("t0", 0)) < end
           and d.get("severity", "major") == "major"]
    where = f"last {defect_frames} frames" if at is None else f"{defect_frames} frames before {end}s"
    if bad:
        return {"ok": False, "reason": f"source {prev_job['id']} has a defect in its {where}: {bad[0].get('kind', 'defect')}"}
    src = ep / clip
    digest = sha256(src)
    if digest is None:
        return {"ok": False, "reason": f"source clip {clip} is missing"}
    if at is None:
        idx = max(0, int(round(dur * fps)) - 1) if dur else None
        out = f"gen/keyframes/chain-{prev_job['id']}-last.png"
        return {"ok": True, "source": clip, "frame_index": idx, "sha256": digest, "out": out,
                "cmd": ["ffmpeg", "-v", "error", "-n", "-sseof", f"-{1 / fps:.4f}", "-i", str(src), "-frames:v", "1", str(ep / out)]}
    out = f"gen/keyframes/chain-{prev_job['id']}-at{int(round(end * 1000))}ms.png"
    # the out-point is exclusive: keep frames before it and overwrite the still with each, so the last one stays;
    # decoded from the start (about 0.8 s for 15 s of 1080p): a seek with -t kept one frame too many at 23.976/29.97
    # fps, and a seek with -copyts wrote no still for a clip with a non-zero start time or a point past its end.
    # trim counts from the clip's first frame; past the end, the last frame stays
    return {"ok": True, "source": clip, "at": end, "sha256": digest, "out": out,
            "cmd": ["ffmpeg", "-v", "error", "-n", "-i", str(src), "-an", "-vf", f"trim=end={end:.4f}",
                    "-update", "1", str(ep / out)]}


def chain_stale(chain: dict, ep: Path) -> bool:
    return sha256(ep / chain["source"]) != chain.get("sha256")


def previz_camera(keys: list[dict], t0: float, t1: float) -> dict:
    """Blockout camera keys -> {from, to, move} words for a camera-transition (proposal, reviewed by a human)."""
    def at(t):
        ks = sorted(keys, key=lambda k: k["t"])
        prev = max((k for k in ks if k["t"] <= t), key=lambda k: k["t"], default=ks[0])
        return prev
    a, b = at(t0), at(t1)
    da = [b["pos"][i] - a["pos"][i] for i in range(3)]
    dist = math.sqrt(sum(x * x for x in da))
    words = []
    if abs(da[2]) > 0.25 * max(dist, 1e-6):
        words.append("push in" if da[2] < 0 else "pull back")
    if abs(da[0]) > 0.25 * max(dist, 1e-6):
        words.append("truck right" if da[0] > 0 else "truck left")
    if abs(da[1]) > 0.25 * max(dist, 1e-6):
        words.append("crane up" if da[1] > 0 else "crane down")
    if abs(float(b.get("fov", 0)) - float(a.get("fov", 0))) > 3:
        words.append("zoom in" if b["fov"] < a["fov"] else "zoom out")

    def size(k):
        d = math.dist(k["pos"], k.get("target", [0, 0, 0]))
        return "close-up" if d < 2 else ("medium shot" if d < 5 else "wide shot")
    return {"from": f"{size(a)}, fov {a.get('fov', '?')}", "to": f"{size(b)}, fov {b.get('fov', '?')}",
            "move": ", ".join(words) or "static", "source": "blockout", "t": [t0, t1]}
