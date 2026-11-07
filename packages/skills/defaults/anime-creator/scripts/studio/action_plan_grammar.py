"""Action grammar for fight and action sequences: a reviewable plan upstream of keyframes, EDL and paid video.

scenes/<sc>/action-plan.json (template assets/templates/action-plan.example.json) models a sequence as beats in the
grammar anticipation -> execution -> contact -> reaction -> recovery (not every phase is needed). Each beat says who
does what to whom, from which side of the 180-degree line, with which hand and prop, whether the contact is shown,
implied (cut around it) or both, and which shots carry it, with the event frame inside each shot.

validate()  offline checks, no API cost: schema, unique shot ids, at most one signature (T3) beat, the axis and
            screen sides, prop ownership through the beats, implied contact that stays legible (who hit whom, with
            what, and where both ended up), event frames inside their shots, FX presets that exist, and a flash rate
            under three a second.
propose()   proposals only, never written into edl.json: shot rows and hits for the EDL, keyframe jobs for
            gen-plan.json, edit-cue lines from the impact presets and SFX anchors at the event frame (at_shot +
            onset, the mix's own convention). The accepted EDL stays the single timing source.
grid()      a markdown shot grid for G0-G2 review, with keyframe thumbnails when they exist.
"""
from __future__ import annotations

import json
from pathlib import Path

from .common_io_and_paths import TEMPLATES, load_json

PHASES = ("anticipation", "execution", "contact", "reaction", "recovery")
VISIBILITY = ("show", "imply", "hybrid")
EMPHASIS = ("signature", "support")
TIERS = ("T0", "T1", "T2", "T3")
SHOT_ROLES = ("establishing", "anticipation", "execution", "occluder", "insert", "contact", "reaction", "aftermath", "silhouette", "fx-transition")
CUTS = ("on-action", "hard", "match", "whip", "fx")
SIDES = ("left", "right", "center", "off")
MAX_FLASHES_PER_S = 3  # photosensitivity guidance: no more than three general flashes in any one second


def presets() -> dict:
    return load_json(TEMPLATES / "impact-fx-presets.json")["presets"]


def _frames(sec: float, fps: int) -> float:
    return sec * fps


def _shots(plan: dict):
    for b in plan.get("beats", []):
        for s in b.get("shots", []):
            yield b, s


def validate(plan: dict, edl: dict | None = None) -> tuple[list[str], list[str]]:  # noqa: C901 - one pass, one list
    err, warn = [], []
    fps = plan.get("fps") or (edl or {}).get("fps") or 24
    actors = plan.get("actors") or {}
    beats = plan.get("beats") or []
    if not beats:
        return ["action plan has no beats"], warn
    axis = plan.get("axis") or {}
    if axis and not set(axis.values()) <= set(SIDES):
        err.append(f"axis sides must be among {SIDES}")
    # prop ownership state: "<actor>.<prop>" -> hand; starts from the actor table
    held = {f"{a}.{p}": h for a, d in actors.items() for p, h in (d.get("props") or {}).items()}
    seen_shots, signature, sides = set(), [], dict(axis)
    pfx = presets()
    flash_times = []
    for i, b in enumerate(beats):
        bid = b.get("id", f"#{i}")
        if b.get("phase") not in PHASES:
            err.append(f"{bid}: phase {b.get('phase')!r} is not one of {PHASES}")
        vis = b.get("visibility", "show")
        if vis not in VISIBILITY:
            err.append(f"{bid}: visibility {vis!r} is not one of {VISIBILITY}")
        if b.get("emphasis", "support") not in EMPHASIS:
            err.append(f"{bid}: emphasis must be one of {EMPHASIS}")
        if b.get("tier") and b["tier"] not in TIERS:
            err.append(f"{bid}: tier {b['tier']!r} is not one of {TIERS}")
        if b.get("emphasis") == "signature" or b.get("tier") == "T3":
            signature.append(bid)
        for a in b.get("actors", []):
            if a not in actors:
                err.append(f"{bid}: actor {a!r} is not in the plan's actors")
        # 180-degree line: an actor changes screen side only with an explicit, reasoned axis cross
        for a, side in (b.get("positions") or {}).items():
            if side not in SIDES:
                err.append(f"{bid}: {a} position {side!r} is not one of {SIDES}")
            elif a in sides and side != sides[a] and "off" not in (side, sides[a]) and not b.get("axis_cross"):
                err.append(f"{bid}: {a} jumps from screen {sides[a]} to {side} without axis_cross {{reason}} (180-degree rule)")
            sides[a] = side
        prev = beats[i - 1] if i else None
        if prev and prev.get("screen_direction") and b.get("screen_direction") and prev["screen_direction"] != b["screen_direction"] \
                and not b.get("axis_cross") and b.get("phase") not in ("reaction", "recovery"):
            warn.append(f"{bid}: screen direction flips {prev['screen_direction']} -> {b['screen_direction']}; motivate it or cut on a neutral shot")
        c = b.get("contact")
        if b.get("phase") == "contact" or c:
            if not c or not all(c.get(k) for k in ("by", "to")):
                err.append(f"{bid}: a contact beat needs contact.by and contact.to")
            elif c.get("with") and c["with"] not in ("fist", "foot", "body", "energy"):
                key = f"{c['by']}.{c['with']}"
                if key not in held:
                    owner = next((k.split(".")[0] for k in held if k.endswith("." + c["with"])), None)
                    err.append(f"{bid}: {c['by']} strikes with {c['with']} but " + (f"{owner} holds it" if owner else "nobody holds it"))
            if vis in ("imply", "hybrid"):
                nxt = beats[i + 1] if i + 1 < len(beats) else None
                legible = (nxt and nxt.get("phase") in ("reaction", "recovery")) or any(s.get("role") in ("reaction", "aftermath") for s in b.get("shots", []))
                if not legible:
                    err.append(f"{bid}: implied contact needs a reaction or aftermath shot next, or the viewer cannot tell who hit whom")
                if not (b.get("end_positions") or (nxt or {}).get("positions")):
                    warn.append(f"{bid}: implied contact without end positions; show where both ended up")
                if not b.get("concealment"):
                    warn.append(f"{bid}: say why the contact is hidden (concealment), e.g. morph-prone hand contact")
        for k, v in (b.get("state_after") or {}).items():
            if v in (None, "", "dropped", "none"):
                held.pop(k, None)
            else:
                held[k] = v
        for s in b.get("shots", []):
            sid = s.get("id", "?")
            if sid in seen_shots:
                err.append(f"{bid}/{sid}: shot id used twice")
            seen_shots.add(sid)
            if s.get("role") and s["role"] not in SHOT_ROLES:
                warn.append(f"{bid}/{sid}: shot role {s['role']!r} is not one of {SHOT_ROLES}")
            if s.get("cut") and s["cut"] not in CUTS:
                warn.append(f"{bid}/{sid}: cut {s['cut']!r} is not one of {CUTS}")
            d = s.get("duration")
            if d is None or d <= 0:
                err.append(f"{bid}/{sid}: duration (seconds) is required")
                continue
            if abs(_frames(d, fps) - round(_frames(d, fps))) > 1e-3:
                err.append(f"{bid}/{sid}: duration {d}s is not a whole number of frames at {fps} fps")
            ef = s.get("event_frame")
            if ef is not None and not (0 <= ef < round(d * fps)):
                err.append(f"{bid}/{sid}: event_frame {ef} is outside the shot's {round(d * fps)} frames")
            fx = s.get("fx")
            if fx:
                if fx not in pfx:
                    err.append(f"{bid}/{sid}: fx preset {fx!r} is not in impact-fx-presets.json")
                elif ef is None:
                    err.append(f"{bid}/{sid}: fx {fx} needs an event_frame to land on")
            if s.get("frames_impact", 0) > 4:
                warn.append(f"{bid}/{sid}: {s['frames_impact']} impact frames; 1-4 frames read as a hit, more strobes")
    if len(signature) > 1:
        err.append(f"more than one signature/T3 beat ({', '.join(signature)}); the skill allows one sakuga shot per scene")
    timeline = _timeline(plan, edl)
    for row in timeline:
        if row.get("fx") in pfx and row.get("event_t") is not None:
            flash_times += [row["event_t"]] * pfx[row["fx"]].get("flashes", 0)
    flash_times.sort()
    for j, t in enumerate(flash_times):
        n = sum(1 for u in flash_times[j:] if u - t < 1.0)
        if n > MAX_FLASHES_PER_S:
            warn.append(f"{n} flashes within 1 s from {t:.2f}s: over the photosensitivity guide; use --reduced-flash presets or spread them")
            break
    if edl:
        ids = {s["id"] for s in edl.get("shots", [])}
        for row in timeline:
            if row["shot"] not in ids:
                warn.append(f"{row['shot']}: planned but not in edl.json yet (fine before the EDL is cut)")
    return err, warn


def _timeline(plan: dict, edl: dict | None = None) -> list[dict]:
    """Shot rows in plan order. Times come from the EDL when the shot is already cut there, else laid end to end."""
    fps = plan.get("fps") or (edl or {}).get("fps") or 24
    cut = {s["id"]: s for s in (edl or {}).get("shots", [])}
    t, rows = float(plan.get("start", 0.0)), []
    for b, s in _shots(plan):
        d = float(s.get("duration") or 0)
        start = cut[s["id"]]["start"] if s.get("id") in cut else t
        end = cut[s["id"]]["end"] if s.get("id") in cut else round((round(start * fps) + round(d * fps)) / fps, 6)
        ef = s.get("event_frame")
        rows.append({"beat": b.get("id"), "phase": b.get("phase"), "shot": s.get("id"), "start": round(start, 6), "end": end,
                     "event_t": None if ef is None else round(start + ef / fps, 6), "fx": s.get("fx"), "role": s.get("role"),
                     "framing": s.get("framing", ""), "camera": s.get("camera", ""), "tier": b.get("tier", "T1"),
                     "visibility": b.get("visibility", "show"), "beat_text": b.get("intent", "")})
        t = end
    return rows


def fx_lines(rows: list[dict], *, reduced: bool = False, seed0: int = 40) -> list[str]:
    pfx, out = presets(), []
    for i, r in enumerate(rows):
        name = r.get("fx")
        if not name or r.get("event_t") is None or name not in pfx:
            continue
        if reduced and pfx[name].get("reduced"):
            name = pfx[name]["reduced"]
        for call in pfx[name]["calls"]:
            out.append(call.format(t=f"{r['event_t']:.4f}", seed=seed0 + i) + f";  // {r['shot']} {name}")
    return out


def propose(plan: dict, edl: dict | None = None, *, reduced: bool = False) -> dict:
    rows = _timeline(plan, edl)
    actors = plan.get("actors") or {}
    beats = {b.get("id"): b for b in plan.get("beats", [])}
    shots, kf, sfx = [], [], []
    for r in rows:
        b = beats[r["beat"]]
        shots.append({"id": r["shot"], "start": r["start"], "end": r["end"], "tier": r["tier"],
                      "kind": "video" if r["tier"] in ("T2", "T3") else ("gl" if r["tier"] == "T0" else "cel"),
                      "beat": f"{r['phase']}: {r['beat_text']}".strip(": ")})
        if r["tier"] != "T0":
            kf.append({"id": f"kf-{plan.get('scene', 'sc')}-{r['shot']}-a", "kind": "keyframe", "status": "proposed",
                       "scene": plan.get("scene"), "shot": r["shot"], "characters": [a for a in b.get("actors", []) if a in actors],
                       "framing": r["framing"], "action": b.get("intent", ""), "camera": r["camera"],
                       "staging": "; ".join(f"{a} screen-{p}" for a, p in (b.get("positions") or {}).items()),
                       "refs": b.get("refs", [])})
        if r["event_t"] is not None:
            for text in b.get("sfx", []):
                sfx.append({"at_shot": r["shot"], "t": round(r["event_t"] - r["start"], 6), "onset": 0.0, "bus": "hits",
                            "text": text, "file": None, "note": "place by the transient at this event frame"})
    hits = [r["event_t"] for r in rows if r["event_t"] is not None and beats[r["beat"]].get("phase") == "contact"]
    return {"scene": plan.get("scene"), "note": "proposal only; merge by hand or through the existing locked writers",
            "edl_shots": shots, "hits": hits, "keyframe_jobs": kf, "edit_cues": fx_lines(rows, reduced=reduced), "sfx_anchors": sfx}


def grid(plan: dict, scene_dir: Path | None = None, edl: dict | None = None) -> str:
    rows = _timeline(plan, edl)
    out = [f"# Action plan {plan.get('scene', '')}: shot grid", "",
           "| # | beat | phase | shot | time | frame | framing / camera | visibility | tier | fx | keyframe |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(rows, 1):
        thumb = ""
        if scene_dir:
            hit = next(iter(sorted((scene_dir.parents[1] / "gen/keyframes").glob(f"*{r['shot']}*.png"))), None) if (scene_dir.parents[1] / "gen/keyframes").exists() else None
            thumb = f"![]({hit})" if hit else ""
        ef = "" if r["event_t"] is None else f"{r['event_t']:.3f}s"
        out.append(f"| {i} | {r['beat']} {r['beat_text'][:40]} | {r['phase']} | {r['shot']} | {r['start']:.3f}-{r['end']:.3f} | {ef} | "
                   f"{r['framing']} / {r['camera']} | {r['visibility']} | {r['tier']} | {r['fx'] or ''} | {thumb} |")
    return "\n".join(out) + "\n"


def dumps(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=2)
