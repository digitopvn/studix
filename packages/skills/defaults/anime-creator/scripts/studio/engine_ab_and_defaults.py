"""Engine A/B evidence and measured routing: which engine gives a usable second of film for the least money.

catalog/engine-ab.jsonl     one row per blind rating of a clip: {at, ab, shot, engine, seconds, cost_usd, verdict,
                            rater, source}. `ab` names the comparison, `source` the rated clip (a path, stored
                            series-relative with / separators, or a job id), `verdict` accept or reject, `cost_usd`
                            null when unknown (0 only for a local adapter: kind comfyui or `local: true`). A clip is
                            (engine, shot, source): several raters give it one verdict by majority, a tie rejects, and
                            its seconds and cost count once. Append-only, under the catalog's locked append.
catalog/engine-defaults.jsonl  every change of a role's default engine: who, why, the A/B numbers it rested on, and
                            `forced` when it went through without them. The row is written before engines.json, both
                            under this log's lock, so no default changes without its row.

measured() keeps two sources per engine apart: `ab` (blind ratings pooled over every A/B: clips, accept rate,
accepted and generated seconds, yield, spend, cost per accepted second) and `production` (unit-cost `by_engine`
over the series' episodes, what the EDLs kept, not blind). Engines are ranked by the A/B cost per accepted second;
one with fewer than `min_clips` rated clips is "insufficient evidence" and is not ranked.

set_default() changes <series>/engines.json only when the latest A/B (by the time of its first row) that rated the
new engine and the current default has MIN_CLIPS clips of each, no unknown cost, and shows the new engine cheaper
per accepted second (both free: a higher accept rate) at an accept rate no lower than the default's minus
TOLERANCE. The gate is fixed; --force is the only way past it and is logged as forced. A default only steers
runners that route by it (ROUTED_BY_DEFAULT): the multix runner takes each job's `model` from gen-plan.json, so an
i2v-cloud default does not change which model a paid job runs. Nothing here changes a default by itself.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from . import asset_registry_catalog as ac
from . import common_io_and_paths as io
from . import engine_routing as er

AB_LOG = Path("catalog") / "engine-ab.jsonl"
DEFAULTS_LOG = Path("catalog") / "engine-defaults.jsonl"
FIELDS = ("at", "ab", "shot", "engine", "seconds", "cost_usd", "verdict", "rater", "source")
TEXT_FIELDS = ("ab", "shot", "engine", "rater", "source")
VERDICTS = ("accept", "reject")
MIN_CLIPS = 6
TOLERANCE = 0.1
FUTURE_SKEW_S = 60  # clock drift allowed between machines before an `at` counts as in the future
# roles whose default a runner uses when no --engine or job field names one
ROUTED_BY_DEFAULT = {
    "i2v-local": "generate-video-via-comfyui.py",
    "upscaler": "upscale-finished-scenes.py",
    "asr": "gate-tts-takes.py",
    "ai-judge": "ai-shot-qa.py",
    "sound-generation": "generate-media-via-multix.py (text-to-audio jobs with no engine or model)",
}


class Refused(Exception):
    """set_default's check failed; the message names the condition."""


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def _ts(s) -> float | None:
    """An ISO timestamp that carries a UTC offset -> epoch seconds; None for anything else."""
    if not isinstance(s, str):
        return None
    try:
        t = datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith("Z") else s)
    except ValueError:
        return None
    return t.timestamp() if t.tzinfo is not None else None


def _aliases(doc: dict) -> dict[str, str]:
    """A provider model id (what ledgers and gen-plan jobs name) -> the adapter name engines.json gives it. Two roles
    naming one model would make the mapping ambiguous: that raises ValueError."""
    out, owner = {}, {}
    for role, r in sorted(doc.get("roles", {}).items()):
        for name, ad in (r.get("adapters") or {}).items():
            m = ad.get("model") if isinstance(ad, dict) else None
            if not isinstance(m, str):
                continue
            if m in owner:
                raise ValueError(f"engines.json: model {m} is named by {owner[m][0]}.{owner[m][1]} and {role}.{name}; "
                                 "one model needs one adapter")
            owner[m], out[m] = (role, name), name
    return out


LOCAL_KINDS = ("comfyui",)


def _is_local(ad) -> bool:
    """Local only on a positive signal: a local kind or an explicit `local: true`. A cli adapter may wrap a paid API
    (multix tts, asr, analyze), so having no provider `model` proves nothing."""
    return isinstance(ad, dict) and (ad.get("kind") in LOCAL_KINDS or ad.get("local") is True)


def _free(doc: dict) -> set[str]:
    """Adapter names that run locally in every role that names them: the only engines that may cost 0."""
    named, paid = set(), set()
    for r in doc.get("roles", {}).values():
        for name, ad in (r.get("adapters") or {}).items():
            named.add(name)
            if not _is_local(ad):
                paid.add(name)
    return named - paid


def known_engines(doc: dict) -> set[str]:
    """Every adapter name and provider model id in the merged table."""
    return {n for r in doc.get("roles", {}).values() for n in (r.get("adapters") or {})} | set(_aliases(doc))


def norm_source(series: Path | None, src: str) -> str:
    """/ separators, no leading ./, and series-relative when it is a path inside the series."""
    s = src.strip().replace("\\", "/")
    p = Path(s)
    if series is not None and p.is_absolute():
        try:
            s = p.resolve().relative_to(Path(series).resolve()).as_posix()
        except ValueError:
            s = p.as_posix()
    while s.startswith("./"):
        s = s[2:]
    return s


def _clip(r: dict, alias: dict) -> tuple:
    return alias.get(r["engine"], r["engine"]), r["shot"], norm_source(None, r["source"])


def validate_rows(rows, existing: list[dict] = (), *, doc: dict, series: Path | None = None) -> list[dict]:
    """A JSON list of rating rows -> the rows to append (`at` filled with local time when absent, `source`
    normalised). Every problem of every row is collected; any problem raises ValueError and nothing is kept.
    Refused: an engine the table does not name, cost 0 for a provider engine, an `at` in the future, a rating that
    repeats one in the log or the batch (ab, engine, shot, source, rater), and a clip whose seconds or cost differ
    from an earlier rating of the same clip."""
    if not isinstance(rows, list) or not rows:
        raise ValueError("expected a non-empty JSON list of rating rows")
    alias, free, names = _aliases(doc), _free(doc), known_engines(doc)
    seen = {(r.get("ab"), *_clip(r, alias), r.get("rater")) for r in existing if all(isinstance(r.get(k), str) for k in TEXT_FIELDS)}
    facts = {_clip(r, alias): (r.get("seconds"), r.get("cost_usd")) for r in existing if all(isinstance(r.get(k), str) for k in TEXT_FIELDS)}
    errs, out, now = [], [], time.time()
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            errs.append(f"row {i}: not an object")
            continue
        bad = []
        extra = sorted(set(r) - set(FIELDS))
        if extra:
            bad.append(f"unknown field(s) {', '.join(extra)}")
        for k in TEXT_FIELDS:
            if not isinstance(r.get(k), str) or not r[k].strip():
                bad.append(f"{k} must be a non-empty string")
        eng = r["engine"].strip() if isinstance(r.get("engine"), str) else None
        if eng and eng not in names:
            bad.append(f"engine {eng!r} is not in engines.json; use an adapter name or model id: {', '.join(sorted(names))}")
        if not _num(r.get("seconds")) or r["seconds"] <= 0:
            bad.append("seconds must be a number > 0")
        cost = r.get("cost_usd", "missing")
        if cost is not None and (not _num(cost) or cost < 0):
            bad.append("cost_usd must be a number >= 0, or null when unknown")
        elif cost == 0 and eng in names and alias.get(eng, eng) not in free:
            bad.append(f"cost_usd 0 is only for a local adapter (kind comfyui or local: true); {eng} is not marked local "
                       "(use null when unknown)")
        if r.get("verdict") not in VERDICTS:
            bad.append(f"verdict must be accept or reject (got {r.get('verdict')!r})")
        if "at" in r:
            t = _ts(r["at"])
            if t is None:
                bad.append(f"at must be an ISO timestamp with a UTC offset (got {r['at']!r})")
            elif t > now + FUTURE_SKEW_S:
                bad.append(f"at {r['at']} is in the future")
        if bad:
            errs.append(f"row {i}: " + "; ".join(bad))
            continue
        row = {**{k: r[k].strip() for k in TEXT_FIELDS}, "source": norm_source(series, r["source"]), "seconds": float(r["seconds"]),
               "cost_usd": None if cost is None else float(cost), "verdict": r["verdict"], "at": r.get("at") or io.local_iso()}
        clip = _clip(row, alias)
        key = (row["ab"], *clip, row["rater"])
        if key in seen:
            errs.append(f"row {i}: {row['engine']} {row['shot']} ({row['source']}) by {row['rater']} is already rated in A/B {row['ab']}")
            continue
        if clip in facts and facts[clip] != (row["seconds"], row["cost_usd"]):
            errs.append(f"row {i}: {row['source']} was rated before with seconds/cost {facts[clip]}, not "
                        f"{(row['seconds'], row['cost_usd'])}; one clip has one length and one cost")
            continue
        seen.add(key)
        facts[clip] = (row["seconds"], row["cost_usd"])
        out.append(row)
    if errs:
        raise ValueError("\n".join(errs))
    return out


def read_ab(series: Path) -> list[dict]:
    return ac.read_log(series / AB_LOG)[0]


def _rows(series: Path, doc: dict) -> list[dict]:
    """The A/B log with engines under their adapter names."""
    alias = _aliases(doc)
    return [{**r, "engine": alias.get(r["engine"], r["engine"])} for r in read_ab(series)]


def record(series: Path, rows) -> list[dict]:
    """Validate and append rating rows to catalog/engine-ab.jsonl, all or none. -> the rows written."""
    p = series / AB_LOG
    existing, rev = ac.read_log(p)
    ok = validate_rows(rows, existing, doc=er.load_series(series), series=series)
    ac.append_log(p, ok, expect_rev=rev)  # a concurrent append is refused, so a duplicate never slips in between
    return ok


def ab_stats(rows: list[dict]) -> dict:
    """Ratings of one engine -> per clip ((shot, source); majority verdict, a tie rejects): clips, ratings, accept
    rate, accepted and generated seconds, yield, spend and cost per accepted second (None while any clip's cost is
    unknown, listed in unknown_cost_clips)."""
    clips: dict[tuple, dict] = {}
    for r in rows:
        c = clips.setdefault((r["shot"], norm_source(None, r["source"])), {"seconds": r["seconds"], "cost": r["cost_usd"], "votes": 0})
        c["votes"] += 1 if r["verdict"] == "accept" else -1
    acc = [c for c in clips.values() if c["votes"] > 0]
    acc_s, gen_s = sum(c["seconds"] for c in acc), sum(c["seconds"] for c in clips.values())
    unknown = sum(c["cost"] is None for c in clips.values())
    usd = None if unknown else sum(c["cost"] for c in clips.values())
    return {"clips": len(clips), "ratings": len(rows), "accepted_clips": len(acc),
            "accept_rate": round(len(acc) / len(clips), 3) if clips else None,
            "accepted_seconds": round(acc_s, 3), "generated_seconds": round(gen_s, 3),
            "yield": round(acc_s / gen_s, 3) if gen_s else None, "spend_usd": None if usd is None else round(usd, 4),
            "unknown_cost_clips": unknown,
            "usd_per_accepted_second": round(usd / acc_s, 4) if usd is not None and acc_s else None,
            "abs": sorted({r["ab"] for r in rows})}


def roles_matching(doc: dict, role: str) -> list[str]:
    """`i2v` matches i2v-local and i2v-cloud; an exact role name matches itself."""
    roles = doc.get("roles", {})
    hit = sorted(r for r in roles if r == role or r.startswith(role + "-"))
    if not hit:
        raise ValueError(f"no role {role!r} in engines.json (have: {', '.join(sorted(roles))})")
    return hit


def _production(series: Path, alias: dict[str, str]) -> tuple[dict[str, dict], list[str]]:
    """unit-cost by_engine summed over the series' episodes (offline ledger). -> (engine -> totals, errors)."""
    from . import rebuild_plan_and_unit_cost as rp  # heavy: catalog, leases, telemetry
    from . import telemetry_trace_and_ledger as tl
    out, errors = {}, []
    for ep in sorted(p for p in (series / "episodes").glob("*") if (p / "episode.json").is_file()):
        try:
            by = rp.unit_cost(ep, ledger=tl.ledger(ep, fetch=False), tokens=None)["by_engine"]
        except (OSError, ValueError, KeyError, TypeError) as e:
            errors.append(f"{ep.name}: {e.__class__.__name__}: {e}")
            continue
        for name, e in by.items():
            t = out.setdefault(alias.get(name, name), {"episodes": [], "clips": 0, "accepted_seconds": 0.0, "generated_seconds": 0.0,
                                                       "usd": 0.0, "usd_unknown_in": []})
            t["episodes"].append(ep.name)
            t["clips"] += e["clips"]
            t["accepted_seconds"] += e["accepted_seconds"]
            t["generated_seconds"] += e["generated_seconds"]
            if e["usd"] is None:
                t["usd_unknown_in"].append(ep.name)
            else:
                t["usd"] += e["usd"]
    for t in out.values():
        a, g = t["accepted_seconds"], t["generated_seconds"]
        t.update(accepted_seconds=round(a, 3), generated_seconds=round(g, 3), usd=round(t["usd"], 4),
                 **{"yield": round(a / g, 3) if g else None,
                    "usd_per_accepted_second": round(t["usd"] / a, 4) if a and not t["usd_unknown_in"] else None})
    return out, errors


def _rank_key(item):
    name, e = item
    c = e["ab"]["usd_per_accepted_second"]
    return c is None, c if c is not None else 0.0, -(e["ab"]["accept_rate"] or 0.0), name


def measured(series: Path, role: str | None = None, *, min_clips: int = MIN_CLIPS, production: bool = True,
             exact: bool = False) -> dict:
    """A/B ratings pooled over every A/B, beside production by_engine. role: a role or a family (exact=True: only
    that role). -> {role, min_clips, engines: {name: {ab, production, evidence, rank}}, ranking, insufficient,
    production_errors}."""
    doc = er.load_series(series)
    alias = _aliases(doc)
    rows = _rows(series, doc)
    prod, perr = _production(series, alias) if production else ({}, [])
    names = set(prod) | {r["engine"] for r in rows}
    if role:
        roles = [role] if exact else roles_matching(doc, role)
        names &= {n for r in roles for n in doc["roles"][r].get("adapters", {})}
    engines = {}
    for n in sorted(names):
        mine = [r for r in rows if r["engine"] == n]
        ab = ab_stats(mine) if mine else None
        enough = bool(ab) and ab["clips"] >= min_clips
        engines[n] = {"ab": ab, "production": prod.get(n), "evidence": "ranked" if enough else "insufficient evidence", "rank": None}
    ranking = [n for n, _ in sorted(((n, e) for n, e in engines.items() if e["evidence"] == "ranked"), key=_rank_key)]
    for i, n in enumerate(ranking, 1):
        engines[n]["rank"] = i
    return {"role": role, "min_clips": min_clips, "engines": engines, "ranking": ranking,
            "insufficient": sorted(n for n, e in engines.items() if e["evidence"] != "ranked"), "production_errors": perr}


def table(m: dict) -> str:
    """A short text table of measured()."""
    def f(v, spec):
        return "-" if v is None else format(v, spec)
    lines = [f"{'#':>2} {'engine':28s} {'clips':>5} {'accept':>6} {'acc s':>7} {'yield':>5} {'$/acc s':>8}   {'prod acc s':>10} {'prod $/acc s':>12}"]
    for n in m["ranking"] + m["insufficient"]:
        e = m["engines"][n]
        ab, pr = e["ab"] or {}, e["production"] or {}
        lines.append(f"{f(e['rank'], 'd'):>2} {n[:28]:28s} {f(ab.get('clips'), 'd'):>5} {f(ab.get('accept_rate'), '.0%'):>6} "
                     f"{f(ab.get('accepted_seconds'), '.1f'):>7} {f(ab.get('yield'), '.2f'):>5} {f(ab.get('usd_per_accepted_second'), '.4f'):>8}   "
                     f"{f(pr.get('accepted_seconds'), '.1f'):>10} {f(pr.get('usd_per_accepted_second'), '.4f'):>12}"
                     + ("" if e["rank"] else "  insufficient evidence"))
    lines.append(f"ranked by A/B cost per accepted second, pooled over every A/B; fewer than {m['min_clips']} rated clips is "
                 "insufficient evidence; prod = unit-cost by_engine over the episodes (not blind)")
    return "\n".join(lines)


def compare(rows: list[dict], new: str, cur: str) -> dict:
    """The latest A/B (by its first row's `at`) that rated both engines decides. -> {ab, new, current, ok, failed};
    failed names the first condition that does not hold (None when ok). Raises Refused when no A/B rated both."""
    first, by_ab = {}, {}
    for r in rows:
        first.setdefault(r["ab"], _ts(r.get("at")) or 0.0)
        if r["engine"] in (new, cur):
            by_ab.setdefault(r["ab"], []).append(r)
    both = [ab for ab, rs in by_ab.items() if {r["engine"] for r in rs} >= {new, cur}]
    if not both:
        raise Refused(f"no A/B in {AB_LOG.as_posix()} rated both {new} and the current default {cur}; "
                      f"rate at least {MIN_CLIPS} clips of each in one A/B, blind")
    ab = max(both, key=lambda x: (first[x], x))
    s_new, s_cur = (ab_stats([r for r in by_ab[ab] if r["engine"] == e]) for e in (new, cur))
    res = {"ab": ab, "new": s_new, "current": s_cur, "min_clips": MIN_CLIPS, "tolerance": TOLERANCE}
    c_new, c_cur = s_new["usd_per_accepted_second"], s_cur["usd_per_accepted_second"]
    if s_new["clips"] < MIN_CLIPS or s_cur["clips"] < MIN_CLIPS:
        res["failed"] = (f"A/B {ab}: {new} has {s_new['clips']} rated clip(s) and {cur} has {s_cur['clips']}; "
                         f"each needs at least {MIN_CLIPS}")
    elif s_new["unknown_cost_clips"] or s_cur["unknown_cost_clips"]:
        res["failed"] = (f"A/B {ab}: the cost of {s_new['unknown_cost_clips']} {new} clip(s) and {s_cur['unknown_cost_clips']} "
                         f"{cur} clip(s) is unknown; record what they cost")
    elif c_new == 0 and c_cur == 0:  # both free: the accept rate is the only difference left
        res["failed"] = None if s_new["accept_rate"] > s_cur["accept_rate"] else (
            f"A/B {ab}: both cost $0, and {new} accepts {s_new['accept_rate']:.0%} of its clips, not more than {cur}'s "
            f"{s_cur['accept_rate']:.0%}")
    elif c_new is None or (c_cur is not None and c_new >= c_cur):
        res["failed"] = f"A/B {ab}: {new} costs {c_new} per accepted second, not less than {cur}'s {c_cur}"
    elif s_new["accept_rate"] < s_cur["accept_rate"] - TOLERANCE - 1e-9:
        res["failed"] = (f"A/B {ab}: {new} accepts {s_new['accept_rate']:.0%} of its clips, below {cur}'s "
                         f"{s_cur['accept_rate']:.0%} minus the {TOLERANCE:.0%} tolerance")
    else:
        res["failed"] = None
    res["ok"] = res["failed"] is None
    return res


def _evidence(rows: list[dict], engine: str, cur: str | None, force: bool) -> dict:
    if not cur:  # a role with no default yet: the new engine still needs its own clips, one of them accepted
        mine = [r for r in rows if r["engine"] == engine]
        st = ab_stats(mine) if mine else None
        failed = None
        if not st or st["clips"] < MIN_CLIPS:
            failed = f"{engine} has {st['clips'] if st else 0} rated clip(s) in {AB_LOG.as_posix()}; it needs at least {MIN_CLIPS}"
        elif not st["accepted_clips"]:
            failed = f"no clip of {engine} was accepted"
        elif st["unknown_cost_clips"]:
            failed = f"the cost of {st['unknown_cost_clips']} {engine} clip(s) is unknown"
        return {"ab": None, "new": st, "current": None, "ok": failed is None, "failed": failed}
    try:
        return compare(rows, engine, cur)
    except Refused as e:
        if not force:
            raise
        return {"ab": None, "new": None, "current": None, "ok": False, "failed": str(e)}


def _create_empty(p: Path) -> None:
    """Create {} at p unless it exists (O_EXCL: two creators never both write it)."""
    try:
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("{}\n")


def routing_note(role: str) -> str | None:
    """A warning for a role whose default no runner reads; None when one does."""
    if role in ROUTED_BY_DEFAULT:
        return None
    return (f"warning: no runner generates through the {role} default; jobs take their model from gen-plan.json "
            "(the multix runner), so set `model` on those jobs too")


def set_default(series: Path, role: str, engine: str, *, by: str, reason: str, force: bool = False) -> dict:
    """Make `engine` the default of `role` in <series>/engines.json when the A/B evidence holds (see compare).
    Raises Refused naming the failed condition; force skips the evidence and is recorded as forced. Under the
    defaults log's lock: re-read the default, write the log row, then engines.json (refused if the default moved)."""
    if not by.strip() or not reason.strip():
        raise Refused("--by and --reason are required: the change log names who changed the default and why")
    log_p, over_p = series / DEFAULTS_LOG, series / "engines.json"
    with ac.log_lock(log_p):
        doc = er.load_series(series)
        roles = doc.get("roles", {})
        if role not in roles:
            raise Refused(f"no role {role!r} in engines.json (have: {', '.join(sorted(roles))})")
        adapters = roles[role].get("adapters", {})
        if engine not in adapters:
            raise Refused(f"role {role} has no adapter {engine!r} ({', '.join(sorted(adapters)) or 'none'}); add it to engines.json first")
        cur = roles[role].get("default")
        if cur == engine:
            raise Refused(f"{engine} is already the default of {role}")
        ev = _evidence(_rows(series, doc), engine, cur, force)
        if not ev["ok"] and not force:
            raise Refused(f"not changing the {role} default from {cur} to {engine}: {ev['failed']}")
        row = {"op": "set-default", "at": io.local_iso(), "role": role, "from": cur, "to": engine, "by": by.strip(),
               "reason": reason.strip(), "forced": not ev["ok"], "ab": ev.get("ab"),
               "evidence": {"new": ev.get("new"), "current": ev.get("current")}, "failed_check": ev.get("failed"),
               "min_clips": MIN_CLIPS, "tolerance": TOLERANCE}
        ac.append_log(log_p, [row], held=True)

        def change(d):
            d = d if isinstance(d, dict) else {}
            now = er.merge(io.load_json(er.TABLE), d)["roles"].get(role, {}).get("default")
            if now != cur:
                raise Refused(f"the {role} default is now {now}, no longer {cur}: someone changed engines.json meanwhile; "
                              "read the A/B again before changing it")
            return er.merge(d, {"roles": {role: {"default": engine}}})
        try:
            _create_empty(over_p)
            io.update_json_locked(over_p, change)
        except BaseException as e:  # any failure (refusal, bad JSON, lock timeout, disk): the row above says it changed
            try:  # an interrupt after the atomic replace: the change did land, so the row is true as it stands
                landed = er.load_series(series)["roles"].get(role, {}).get("default") == engine
            except Exception:  # unreadable: the replace is atomic, so a file no one can read is not our write
                landed = False
            if landed:
                raise
            why = str(e) if isinstance(e, Refused) else f"{e.__class__.__name__}: {e}"
            try:
                ac.append_log(log_p, [{**row, "op": "set-default-aborted", "at": io.local_iso(), "failed_check": why}], held=True)
            except Exception as log_err:  # keep the original error; say the log could not record it
                print(f"could not log the aborted change in {log_p}: {log_err}", file=sys.stderr)
            raise
    return row


def register(add, O) -> None:
    add("engines", O("action", choices=("ab-record", "measured", "set-default")), "series",
        O("--from", dest="src", help="ab-record: JSON file holding a list of rating rows"),
        O("--role", help="measured: a role or a family (i2v covers i2v-local and i2v-cloud); set-default: the exact role"),
        O("--engine", help="set-default: the adapter to make the default"),
        O("--by", default="", help="set-default: who decided"), O("--reason", default="", help="set-default: why"),
        O("--min-clips", type=int, help=f"measured: rated clips, pooled over every A/B, an engine needs to be ranked (default {MIN_CLIPS}); "
                                        "display only, the set-default gate is fixed"),
        O("--force", action="store_true", help="set-default: change it without the evidence; logged as forced"),
        O("--json", action="store_true", help="measured: print JSON instead of the table"),
        help="blind A/B ratings per engine (catalog/engine-ab.jsonl), measured cost per accepted second, evidence-gated default changes")


def run(a) -> bool:
    if a.cmd != "engines":
        return False
    series = Path(a.series).expanduser().resolve()
    if not series.is_dir():
        sys.exit(f"no series folder {series}")
    if a.action == "ab-record":
        if not a.src:
            sys.exit("ab-record needs --from <rows.json>")
        try:
            rows = io.load_json(Path(a.src).expanduser())
        except (OSError, ValueError) as e:
            sys.exit(f"cannot read {a.src}: {e}")
        try:
            ok = record(series, rows)
        except (ValueError, ac.CatalogChanged) as e:
            sys.exit(f"nothing recorded:\n{e}")
        print(f"recorded {len(ok)} rating(s) in {(series / AB_LOG).as_posix()}")
    elif a.action == "measured":
        n = MIN_CLIPS if a.min_clips is None else a.min_clips
        if n < 1:
            sys.exit("--min-clips must be >= 1")
        try:
            m = measured(series, a.role, min_clips=n)
        except ValueError as e:
            sys.exit(str(e))
        print(json.dumps(m, ensure_ascii=False, indent=2) if a.json else table(m))
    else:
        if a.min_clips is not None:
            sys.exit(f"set-default takes no --min-clips: its gate is fixed at {MIN_CLIPS} clips per engine")
        if not a.role or not a.engine:
            sys.exit("set-default needs --role and --engine")
        try:
            row = set_default(series, a.role, a.engine, by=a.by, reason=a.reason, force=a.force)
        except (Refused, ValueError) as e:
            sys.exit(f"refused: {e}")
        print(json.dumps(row, ensure_ascii=False, indent=2))
        note = routing_note(a.role)
        if note:
            print(note, file=sys.stderr)
    return True
