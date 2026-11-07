"""Reference roles: which approved image or video is fed to a generator, in what role, and why others were dropped.

A reference is {path, role, asset_id?, sha256?, span?}. Roles say what a reference is FOR, so a set painting can
never override a face and a blockout never becomes a style:
  identity        approved character sheet (face, hair, body)
  costume-prop    approved costume or prop sheet (helmet on/off, damaged armour, the pipe)
  environment     clean set or lighting sheet
  spatial-blocking composition anchor or 3D blockout still (where bodies stand)
  motion-camera   approved blockout or reference video (camera path, timing)
  previous-clip   end state of the previous accepted take
  style           look reference
  extra           a path a job listed without a role (legacy jobs)
Selection keeps the adapter's limits (images and videos counted apart; three images stays the default because
past runs drifted with four or more) and returns what was chosen and, for each dropped reference, the reason.
No provider is named here: limits and payload keys come from the adapter entry in engines.json (`refs`).
"""
from __future__ import annotations

import hashlib
from pathlib import Path

ROLES = ("identity", "costume-prop", "environment", "spatial-blocking", "motion-camera", "previous-clip", "style", "extra")
VIDEO_ROLES = {"motion-camera", "previous-clip"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv"}
DEFAULT_CAPS = {"images": 3, "videos": 0}


def is_video(ref: dict) -> bool:
    return Path(str(ref.get("path", ""))).suffix.lower() in VIDEO_EXT


def sha256(path: Path, chunk: int = 1 << 20) -> str | None:
    p = Path(path)
    if not p.is_file():
        return None
    h = hashlib.sha256()
    with p.open("rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


def normalize(refs: list) -> list[dict]:
    """Strings become {path, role: extra}; unknown roles are kept but sorted last and flagged by validate()."""
    out = []
    for r in refs or []:
        out.append({"path": str(r), "role": "extra"} if isinstance(r, (str, Path)) else dict(r))
    return out


def validate(refs: list[dict], base: Path | None = None) -> list[str]:
    """Problems that make a reference untraceable: unknown role, missing file, or a hash that no longer matches."""
    errs = []
    for r in refs:
        if r.get("role") not in ROLES:
            errs.append(f"{r.get('path')}: role {r.get('role')!r} is not one of {', '.join(ROLES)}")
        p = Path(r["path"]) if base is None or Path(r["path"]).is_absolute() else base / r["path"]
        if base is not None and not p.exists():
            errs.append(f"{r['path']}: file missing")
        elif r.get("sha256") and base is not None and sha256(p) != r["sha256"]:
            errs.append(f"{r['path']}: content changed since it was approved (sha256 mismatch)")
    return errs


def select(refs: list, caps: dict | None = None, order: tuple = ROLES) -> dict:
    """-> {chosen: [...], dropped: [{path, role, reason}]}. Deterministic: role precedence, then the given order."""
    caps = {**DEFAULT_CAPS, **(caps or {})}
    allowed = set(caps.get("roles") or ROLES)
    rank = {r: i for i, r in enumerate(order)}
    items = sorted(enumerate(normalize(refs)), key=lambda x: (rank.get(x[1].get("role"), len(rank)), x[0]))
    chosen, dropped, seen, n_img, n_vid = [], [], set(), 0, 0
    for _, r in items:
        key = r.get("sha256") or r["path"]
        if key in seen:
            dropped.append({**r, "reason": "duplicate of a reference already chosen"})
            continue
        seen.add(key)
        if r.get("role") not in allowed:
            dropped.append({**r, "reason": f"adapter does not accept role {r.get('role')}"})
        elif is_video(r):
            if n_vid >= caps["videos"]:
                dropped.append({**r, "reason": "adapter takes no reference video" if not caps["videos"]
                                else f"video limit {caps['videos']} reached"})
            else:
                chosen.append(r)
                n_vid += 1
        elif n_img >= caps["images"]:
            dropped.append({**r, "reason": f"image limit {caps['images']} reached; higher-precedence roles kept"})
        else:
            chosen.append(r)
            n_img += 1
    return {"chosen": chosen, "dropped": dropped}


def payload_fields(chosen: list[dict], caps: dict | None, urls: dict | None = None) -> dict:
    """Map chosen refs to an adapter's input keys (caps.image_key / caps.video_key), in order. `urls` maps a path to its
    uploaded URL; without it the paths stand in (dry-run). Tags (`@Image1`, `image 1`) are the adapter's prompt
    convention and are returned so the prompt can name each reference's role."""
    caps = caps or {}
    urls = urls or {}
    imgs = [r for r in chosen if not is_video(r)]
    vids = [r for r in chosen if is_video(r)]
    out, tags = {}, []
    if imgs and caps.get("image_key"):
        out[caps["image_key"]] = [urls.get(r["path"], r["path"]) for r in imgs]
    if vids and caps.get("video_key"):
        out[caps["video_key"]] = [urls.get(r["path"], r["path"]) for r in vids]
    img_tag, vid_tag = caps.get("image_tag", "image {n}"), caps.get("video_tag", "video {n}")
    off = int(caps.get("image_tag_offset", 0))  # images the adapter numbers first (a keyframe sent as `image`)
    tags += [f"{img_tag.format(n=i + 1 + off)}: {r['role']}" for i, r in enumerate(imgs)]
    tags += [f"{vid_tag.format(n=i + 1)}: {r['role']}" for i, r in enumerate(vids)]
    return {"fields": out, "role_line": "; ".join(tags)}
