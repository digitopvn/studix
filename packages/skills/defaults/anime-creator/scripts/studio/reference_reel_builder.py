"""Reference reel: one reviewed manifest of the references a shot is generated from, and the payload each adapter gets.

A reel is {shot, refs: [{path, role, span?: [t0, t1]}]} (roles from reference_roles). build() hashes every file,
checks the roles, cuts video spans and lists what the chosen adapter will receive, using that adapter's `refs` caps
in engines.json ({images, videos, roles?, image_key, video_key, image_tag, video_tag}). An adapter that takes no
reference video gets the fallback the docs recommend: the first and last frame of each motion reference as images.
reel_cmds() returns the ffmpeg commands (span cuts, the concatenated preview reel, fallback stills) without running
them, so a dry run costs nothing and the manifest is reviewed before any paid call.
"""
from __future__ import annotations

from pathlib import Path

from . import reference_roles as rr


def adapter_caps(doc: dict, role: str, name: str | None) -> tuple[str, dict]:
    r = (doc.get("roles") or {}).get(role) or {}
    name = name or r.get("default")
    ad = (r.get("adapters") or {}).get(name)
    if ad is None:
        raise SystemExit(f"role {role}: no adapter {name!r} in engines.json")
    return name, {**rr.DEFAULT_CAPS, **(ad.get("refs") or {})}


def build(reel: dict, base: Path, caps: dict, *, out_dir: Path) -> dict:
    """-> manifest {shot, refs (with sha256), errors, chosen, dropped, fallback_stills, payload, role_line}."""
    refs = rr.normalize(reel.get("refs", []))
    errors = rr.validate(refs, base)
    for r in refs:
        r["sha256"] = r.get("sha256") or rr.sha256(base / r["path"])
        span = r.get("span")
        if span and not rr.is_video(r):
            errors.append(f"{r['path']}: span given on a still image")
        if span and (len(span) != 2 or float(span[1]) <= float(span[0])):
            errors.append(f"{r['path']}: span must be [t0, t1] with t1 > t0")
    fallback = []
    if not caps.get("videos"):  # no video input: carry motion refs as first/last stills, kept in their role
        for r in [r for r in refs if rr.is_video(r)]:
            stem = Path(r["path"]).stem
            t0, t1 = (r.get("span") or [0.0, None])
            for tag, t in (("first", t0), ("last", t1)):
                still = out_dir / f"{stem}-{tag}.png"
                try:
                    still = still.relative_to(base)
                except ValueError:
                    pass
                fallback.append({"path": str(still), "role": r["role"], "from": r["path"], "at": tag, "t": t})
    pool = [r for r in refs if caps.get("videos") or not rr.is_video(r)] + fallback
    sel = rr.select(pool, caps)
    pf = rr.payload_fields(sel["chosen"], caps)
    return {"shot": reel.get("shot"), "refs": refs, "errors": errors, "chosen": sel["chosen"], "dropped": sel["dropped"],
            "fallback_stills": fallback, "payload": pf["fields"], "role_line": pf["role_line"]}


def reel_cmds(manifest: dict, base: Path, out_dir: Path, *, fps: int = 24, size: str = "1280x720") -> list[list[str]]:
    """ffmpeg argv lists: one cut per video span, one concat preview of them, one still per fallback frame."""
    cmds, parts = [], []
    w, h = size.split("x")
    for i, r in enumerate(x for x in manifest["refs"] if rr.is_video(x)):
        part = out_dir / f"seg{i:02d}-{Path(r['path']).stem}.mp4"
        span = r.get("span")
        cut = ["-ss", str(span[0]), "-to", str(span[1])] if span else []
        cmds.append(["ffmpeg", "-v", "error", "-n", *cut, "-i", str(base / r["path"]), "-an", "-vf",
                     f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps}",
                     "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", str(part)])
        parts.append(part)
    if len(parts) > 1:
        lst = out_dir / "reel.txt"
        cmds.append(["ffmpeg", "-v", "error", "-n", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(out_dir / "reel.mp4")])
    for f in manifest["fallback_stills"]:
        src = base / f["from"]
        pick = ["-sseof", "-0.05"] if f["at"] == "last" and f["t"] is None else ["-ss", str(f["t"] or 0.0)]
        cmds.append(["ffmpeg", "-v", "error", "-n", *pick, "-i", str(src), "-frames:v", "1", str(base / f["path"])])
    return cmds


def concat_list(parts: list[Path]) -> str:
    return "".join(f"file '{p.as_posix()}'\n" for p in parts)
