"""Check a scene EDL and an episode gen-plan before anything is rendered or paid for.

validate_edl  -> (errors, warnings): contiguous, frame-aligned shots, known kinds and tiers, required fields per
                 kind, dialogue and word timings inside the film, and (with a scene dir) the files each shot needs.
budget        -> per-job estimate from the price table, spend so far (measured cost wins over estimate),
                 the ceiling check and video utilization (seconds used in the edit / seconds paid for).
"""
from __future__ import annotations

from pathlib import Path

from .multix_job_commands import DEFAULT_MODELS
from . import shot_boundary_contract as sb

KINDS = {"gl", "video", "cel"}
TIERS = {"T0", "T1", "T2", "T3"}
EPS = 1e-6


def _aligned(t: float, fps: float) -> bool:
    return abs(t * fps - round(t * fps)) < 1e-3


def validate_edl(edl: dict, scene_dir: Path | None = None) -> tuple[list[str], list[str]]:
    err, warn = [], []
    fps, dur, shots = edl.get("fps"), edl.get("duration"), edl.get("shots") or []
    if not fps or not dur:
        return ["edl needs fps and duration"], warn
    if not shots:
        return ["edl has no shots"], warn
    if not _aligned(dur, fps):
        err.append(f"duration {dur} is not a whole number of frames at {fps} fps")
    seen, prev_end = set(), 0.0
    speakers = edl.get("speakers") or {}
    for s in shots:
        sid = s.get("id", "?")
        if sid in seen:
            err.append(f"{sid}: duplicate shot id")
        seen.add(sid)
        a, b = s.get("start"), s.get("end")
        if a is None or b is None:
            err.append(f"{sid}: start and end are required")
            continue
        if abs(a - prev_end) > EPS:
            err.append(f"{sid}: starts at {a} but the previous shot ends at {prev_end} (shots must be contiguous)")
        prev_end = b
        for name, t in (("start", a), ("end", b)):
            if not _aligned(t, fps):
                err.append(f"{sid}: {name} {t} is not on a frame boundary ({t * fps:.3f} frames)")
        n = round((b - a) * fps)
        if n < 2:
            err.append(f"{sid}: {n} frame(s) is too short to read")
        elif b - a > 8:
            warn.append(f"{sid}: {b - a:.2f}s hold; make sure something moves (camera, acting or FX)")
        kind = s.get("kind")
        if kind not in KINDS:
            err.append(f"{sid}: kind {kind!r} is not one of {sorted(KINDS)}")
        if s.get("tier") not in TIERS:
            warn.append(f"{sid}: no tier (T0 code, T1 cel/image, T2 Omni, T3 Seedance)")
        if kind == "video":
            if not s.get("src"):
                err.append(f"{sid}: video shot needs src (path relative to the episode dir)")
            if s.get("speed", 1) <= 0:
                err.append(f"{sid}: speed must be > 0")
            if s.get("in", 0) < 0:
                err.append(f"{sid}: in must be >= 0")
            if scene_dir and not (scene_dir / "clips" / f"{sid}.mp4").exists():
                warn.append(f"{sid}: clips/{sid}.mp4 missing (run conform)")
        if kind == "gl" and not s.get("set"):
            err.append(f"{sid}: gl shot needs set")
        if kind == "cel":
            if not s.get("img"):
                err.append(f"{sid}: cel shot needs img")
            elif scene_dir and not (scene_dir / s["img"]).exists():
                warn.append(f"{sid}: {s['img']} missing")
        for i, line in enumerate(s.get("dialogue") or []):
            t0, t1 = line.get("t0", -1), line.get("t1", -1)
            tag = f"{sid} line {i}"
            if not (t0 < t1):
                err.append(f"{tag}: t0 {t0} must be before t1 {t1}")
            if not (a - EPS <= t0 < b):
                err.append(f"{tag}: starts at {t0}, outside its shot [{a}, {b})")
            if t1 > dur + EPS:
                err.append(f"{tag}: ends at {t1}, after the film ends ({dur})")
            if not line.get("text"):
                err.append(f"{tag}: empty text")
            if speakers and line.get("speaker") not in speakers:
                warn.append(f"{tag}: speaker {line.get('speaker')!r} not in edl.speakers")
            last = t0 - EPS
            for w in line.get("words") or []:
                if w.get("t0", -1) < last or w["t0"] > t1 + EPS:
                    err.append(f"{tag}: word {w.get('text')!r} at {w.get('t0')} is out of order or outside the line")
                last = w.get("t0", last)
    if abs(prev_end - dur) > EPS:
        err.append(f"last shot ends at {prev_end} but duration is {dur}")
    title = edl.get("title") or {}
    if title and not (0 <= title.get("at", 0) < dur):
        err.append(f"title.at {title.get('at')} is outside the film")
    for t in edl.get("hits") or []:
        if not (0 <= t < dur):
            err.append(f"hit at {t} is outside the film")
    b_err, b_warn = sb.validate(edl)  # camera-aware join contracts, only on shots that carry `boundary`
    return err + b_err, warn + b_warn


# ---------------------------------------------------------------- budget

def window_price(model: str, windows: list[dict], now: str | None = None) -> float:
    """The price of the window covering `now` (ISO UTC). Within a day of a boundary the higher price is used,
    since a provider may switch in either time zone; with no covering window the model is unpriced."""
    import datetime as dt
    t = dt.datetime.fromisoformat((now or dt.datetime.now(dt.timezone.utc).isoformat()).replace("Z", "+00:00"))
    day, hits = dt.timedelta(days=1), []
    for w in windows:
        lo = dt.datetime.fromisoformat(w["from"].replace("Z", "+00:00")) if w.get("from") else None
        hi = dt.datetime.fromisoformat(w["until"].replace("Z", "+00:00")) if w.get("until") else None
        if (lo is None or t >= lo - day) and (hi is None or t < hi + day):
            hits.append(float(w["price"]))
    if not hits:
        raise KeyError(f"no current price for {model}: every dated price has expired; re-check the source and update the table")
    return max(hits)


def unit_price(prices: dict, model: str, variant: str | None, now: str | None = None) -> tuple[float, float, str]:
    """(price per unit, minimum units, basis). Unknown models raise so a plan never silently costs $0."""
    item = (prices.get("items") or {}).get(model)
    if not item:
        raise KeyError(f"no price for {model}; add it to the price table (probe one call and read its real price)")
    if item.get("windows"):  # dated prices (a promotion, then list price): none covering today means unpriced
        item = {**item, "price": window_price(model, item["windows"], now)}
    p = (item.get("variants") or {}).get(variant, item["price"]) if variant else item["price"]
    return float(p), float(item.get("min_units", 0)), item.get("basis", "catalog")


def job_seconds(job: dict) -> float | None:
    """Seconds a job is billed for: `units` when set, else its `duration` when that is a positive finite number;
    None when neither says. Shared by the estimate and video utilization so both count a job the same way."""
    if job.get("units") is not None:
        return float(job["units"])
    d = job.get("duration")
    if isinstance(d, (int, float)) and not isinstance(d, bool) and 0 < d < float("inf"):
        return float(d)
    return None


def estimate_job(job: dict, prices: dict) -> float:
    model = job.get("model") or DEFAULT_MODELS.get(job.get("kind", ""), f"<{job.get('id')} has no model>")
    p, mn, _ = unit_price(prices, model, job.get("variant"))
    units = job_seconds(job)
    if job.get("units") is None:
        per_s = ((prices.get("items") or {}).get(model) or {}).get("unit") == "second"
        if not per_s or "duration" not in job:
            units = 1.0
        elif units is None:  # a per-second price bills the length; a bad one leaves the job unpriced, never $0
            raise KeyError(f"{job.get('id')}: duration {job['duration']!r} is not a positive number of seconds; "
                           f"set duration or units to price {model}")
    return round(p * max(units, mn) * int(job.get("takes", 1)), 4)


def budget(plan: dict, prices: dict, ceiling: float) -> dict:
    rows, planned, spent, unknown = [], 0.0, 0.0, []
    paid_video_s, used_video_s = 0.0, 0.0
    for job in plan.get("jobs", []):
        status = job.get("status", "planned")
        if status in ("cancelled", "skipped"):
            continue
        try:
            est = estimate_job(job, prices)
        except KeyError as e:
            unknown.append(str(e))
            est = 0.0
        actual = job.get("cost_usd")
        cost = float(actual) if actual is not None else est
        planned += cost
        if status in ("submitted", "done", "rejected", "failed") and (actual is not None or status != "failed"):
            spent += cost
        if job.get("kind") == "video" and status in ("done", "rejected"):
            paid_video_s += (job_seconds(job) or 0.0) * int(job.get("takes", 1))
            used_video_s += float(job.get("used_seconds", 0))
        rows.append({"id": job.get("id"), "kind": job.get("kind"), "model": job.get("model"), "status": status,
                     "estimate": est, "actual": actual})
    return {"rows": rows, "planned_usd": round(planned, 3), "spent_usd": round(spent, 3), "ceiling_usd": ceiling,
            "headroom_usd": round(ceiling - planned, 3), "over_ceiling": planned > ceiling + 1e-9,
            "video_utilization": round(used_video_s / paid_video_s, 3) if paid_video_s else None,
            "unknown_prices": unknown}


def print_budget(b: dict) -> None:
    print(f"{'job':14s} {'kind':10s} {'status':10s} {'estimate':>9s} {'actual':>9s}  model")
    for r in b["rows"]:
        act = "" if r["actual"] is None else f"{float(r['actual']):.4f}"
        print(f"{str(r['id']):14s} {str(r['kind']):10s} {r['status']:10s} {r['estimate']:9.4f} {act:>9s}  {r['model']}")
    util = b["video_utilization"]
    print(f"planned ${b['planned_usd']:.3f}  spent ${b['spent_usd']:.3f}  ceiling ${b['ceiling_usd']:.2f}  headroom ${b['headroom_usd']:.3f}"
          + (f"  video utilization {util:.0%}" if util is not None else ""))
    if b["over_ceiling"]:
        print("OVER CEILING: cut takes, drop a tier (T3 -> T2 -> T1) or ask the user to raise the ceiling")
    for u in b["unknown_prices"]:
        print("UNKNOWN PRICE " + u)
