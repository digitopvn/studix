"""Salvage plan: turn paid takes into usable spans instead of a whole-clip keep/reject.

A clip with a morph at 2.1 s often has two clean seconds on each side. scenes/<sc>/salvage.json lists takes
({id, clip, fps, duration, cost_usd, defects: [{t0, t1, kind, severity: minor|major}], keep_audio?}) and the shots
that want footage ({shot, min_s, max_s?, take?, center?, replaces?: the old shot id whose mix events move}); defects are copied in from QA (qa-prescan, ai-shot-qa, review). plan() cuts each take
around its major defects (minus handles), rates every span keep / needs-fix (a minor defect inside) / reject (too
short), assigns the best spans to the wanted shots in order and reports the money:
  accepted_seconds, utilization (accepted / paid seconds), cost_per_accepted_second, retakes_avoided.
retakes_avoided is measured against keeping or dropping whole clips: there a take fills at most one shot and a take
with a major defect is dropped, so every assigned shot beyond that (a trimmed defective take, or a second span of one
take) is a generation not paid for; retake_usd_saved prices each at --retake-usd, else the cost of the take used.
Proposals only: EDL rows (kind video, src, in, start/end on the scene's frame grid) and an at_shot remap for mix events of a
shot that now spans two takes. Offline; no frame is read here (qa-prescan and ai-shot-qa produce the defects).
"""
from __future__ import annotations

import math

SEVERITIES = ("minor", "major")


def _snap(t: float, fps: float) -> float:
    return round(round(t * fps) / fps, 6)


def clean_spans(take: dict, *, handle_frames: int = 2) -> list[dict]:
    """Spans of a take between major defects, each pulled in by `handle_frames` on the defect side; frame-aligned to
    the take's own fps (24, 25, 30 or 48 all work; mixed-fps takes are normalized when placed on the scene grid)."""
    fps = float(take.get("fps", 24))
    dur = float(take["duration"])
    pad = handle_frames / fps
    major = sorted((float(d["t0"]), float(d["t1"])) for d in take.get("defects", []) if d.get("severity", "major") == "major")
    spans, t = [], 0.0
    for a, b in major:
        if a - pad > t:
            spans.append((t, a - pad))
        t = max(t, b + pad)
    if t < dur:
        spans.append((t, dur))
    out = []
    for a, b in spans:
        a, b = _snap(a, fps), _snap(b, fps)
        if b - a <= 0:
            continue
        minors = [d for d in take.get("defects", []) if d.get("severity") == "minor" and float(d["t0"]) < b and float(d["t1"]) > a]
        out.append({"take": take["id"], "clip": take.get("clip"), "in": a, "out": b, "len": round(b - a, 6),
                    "minor": [f"{d.get('kind', 'defect')} {d['t0']}-{d['t1']}" for d in minors]})
    return out


def plan(doc: dict, *, fps: int = 24, handle_frames: int = 2, retake_usd: float | None = None) -> dict:
    """-> {spans, assignments, unfilled, metrics, edl_shots}. Assignment is greedy and deterministic: per wanted shot,
    the longest keep span that fits (then needs-fix), each span used once."""
    takes = doc.get("takes", [])
    spans = [s for t in takes for s in clean_spans(t, handle_frames=handle_frames)]
    min_any = min((float(w.get("min_s", 0.5)) for w in doc.get("wanted", [])), default=0.5)
    for s in spans:
        s["status"] = "reject" if s["len"] < min_any else ("needs-fix" if s["minor"] else "keep")
    used, assignments, unfilled = set(), [], []
    for w in doc.get("wanted", []):
        lo, hi = float(w.get("min_s", 0.5)), float(w.get("max_s", 1e9))
        pool = [(i, s) for i, s in enumerate(spans) if i not in used and s["status"] != "reject" and s["len"] >= lo
                and (not w.get("take") or s["take"] == w["take"])]
        pool.sort(key=lambda x: (x[1]["status"] != "keep", -x[1]["len"], x[0]))
        if not pool:
            unfilled.append(w["shot"])
            continue
        i, s = pool[0]
        used.add(i)
        use = min(s["len"], hi)
        mid = s["in"] + (s["len"] - use) / 2 if w.get("center") else s["in"]
        assignments.append({"shot": w["shot"], "replaces": w.get("replaces"), "take": s["take"], "clip": s["clip"], "in": round(mid, 6),
                            "len": round(math.floor(use * fps) / fps, 6), "status": s["status"], "minor": s["minor"]})
    paid = sum(float(t["duration"]) for t in takes)
    cost = sum(float(t.get("cost_usd") or 0) for t in takes)
    accepted = round(sum(a["len"] for a in assignments), 6)
    per_take = (cost / len(takes)) if takes else 0.0
    by_id = {t["id"]: t for t in takes}
    defective = {t["id"] for t in takes if any(d.get("severity", "major") == "major" for d in t.get("defects", []))}
    whole_clip, avoided = set(), []  # shots a whole-clip keep-or-drop would also have filled; the rest are retakes avoided
    for a in assignments:
        if a["take"] in defective or a["take"] in whole_clip:
            avoided.append(a)
        else:
            whole_clip.add(a["take"])
    retakes = len(avoided)
    take_usd = lambda tid: float(by_id.get(tid, {}).get("cost_usd") or 0) or per_take  # noqa: E731
    metrics = {"paid_seconds": round(paid, 3), "accepted_seconds": round(accepted, 3),
               "utilization": round(accepted / paid, 3) if paid else 0.0,
               "cost_usd": round(cost, 4), "cost_per_accepted_second": round(cost / accepted, 4) if accepted else None,
               "retakes_avoided": retakes, "salvaged_shots": [a["shot"] for a in avoided],
               "retake_usd_saved": round(sum(retake_usd if retake_usd is not None else take_usd(a["take"]) for a in avoided), 4)}
    return {"spans": spans, "assignments": assignments, "unfilled": unfilled, "metrics": metrics,
            "edl_shots": edl_rows(assignments, start=float(doc.get("start", 0.0)), fps=fps)}


def edl_rows(assignments: list[dict], *, start: float = 0.0, fps: int = 24) -> list[dict]:
    """Back-to-back EDL rows on the scene's frame grid, for review; the EDL itself is edited by hand or a merge."""
    rows, t = [], start
    for a in assignments:
        end = _snap(t + a["len"], fps)
        row = {"id": a["shot"], "kind": "video", "src": a["clip"], "in": a["in"], "speed": 1.0, "start": _snap(t, fps), "end": end,
               "salvaged_from": a["take"]}
        if a["minor"]:
            row["needs_fix"] = a["minor"]
        if a.get("replaces"):
            row["replaces"] = a["replaces"]
        rows.append(row)
        t = end
    return rows


def remap_mix(events: list[dict], scene: str, old_shot: str, old_in: float, new_rows: list[dict], old_src: str | None = None) -> dict:
    """Mix events anchored at_shot=old_shot -> a mix-add proposal moving each to the new row that now shows its source
    moment (source time = old_in + t). Events whose moment fell in a cut-out defect are listed for removal by hand."""
    modify, orphans = [], []
    new_rows = [r for r in new_rows if old_src is None or r.get("src") == old_src]  # only rows cut from the same clip
    for e in events:
        if e.get("scene") != scene or e.get("at_shot") != old_shot:
            continue
        src_t = old_in + float(e.get("t", 0))
        row = next((r for r in new_rows if r["in"] <= src_t < r["in"] + (r["end"] - r["start"])), None)
        if row is None:
            orphans.append({"file": e.get("file"), "t": e.get("t")})
            continue
        modify.append({"match": {"at_shot": old_shot, "t": e.get("t"), "file": e.get("file")},
                       "set": {"at_shot": row["id"], "t": round(src_t - row["in"], 6)}})
    return {"scene": scene, "notes": "salvage remap: review, then merge-mix-proposals.py", "modify": modify, "orphans": orphans}
