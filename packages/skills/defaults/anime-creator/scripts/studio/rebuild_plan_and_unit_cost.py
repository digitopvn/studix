"""What to rebuild after an asset changes, and what an accepted second of film cost.

rebuild_plan(series, changed) turns `assets impact` into a task graph instead of "re-render the episode":
  regenerate  a catalogued descendant a gen-plan job made (gate "approval"; this module never runs it)
  retrim      a scene whose EDL src was trimmed or upscaled from a regenerated clip (src_raw): trim again, and run the
              upscale job again (regenerate, gate "approval") on the new trim
  render      a scene whose EDL shows a changed or regenerated file (src, src_raw, img or pick of a shot)
  assemble    an episode with a re-rendered scene
  remux       an episode whose change is audio: the picture is reused, only the mix and master are redone
Each task: {id, action, episode, scene, inputs (asset ids), outputs (paths), output_assets (ids of the records it
replaces), resource, lease, cost_usd, cost_source, est_seconds, time_source, gates, after}.
resource is paid-api, gpu-local, cpu-render or cpu-mux; lease is what its runner must hold to start it ("heavy" for
gpu-local, taken by generate-video-via-comfyui.py; "provider-<name>" for a paid API, held by the media runner while it
submits, only when that provider is limited; see admission_leases.py), None for local CPU work. cost_usd is the job's
recorded cost, else the price-table estimate `budget` uses (cost_source says which), else None (unpriced, never
guessed). est_seconds is the job's own measured wall time (a ComfyUI sidecar, else submit to done in the trace;
"trace-async" when that span ran to a later download, an upper bound), else the median of the sidecar and in-place
trace times of its model in that episode, else None. A changed path covers every
record ever catalogued there, so a file edited and re-scanned still reaches the children of its older record. Scenes no task names are reused as they are. This only plans: nothing is submitted,
rendered or deleted. The plan lists the series' live leases, the work already holding a GPU or provider slot.

unit_cost() splits spend into media (the ledger), tokens (the linked transcript), GPU (wall seconds of local clips x
rates.gpu_usd_per_hour), storage/egress (catalogued bytes x months held x rates.storage_usd_per_gb_month, plus bytes
copied to remotes x rates.egress_usd_per_gb) and people (trace `hours` x rates.people_usd_per_hour), and divides it by
accepted seconds: seconds of generated video the scene EDLs show. `rates` live in the price table (skill or series)
and ship empty. A bucket is None when it has no recorded usage, and also when it has usage but no rate (those are
listed in `unpriced_usage`); never 0. So cost_per_accepted_second is a floor until they are measured. Storage is an
approximation: today's catalogued bytes as if held since the episode was created, plus each recorded copy once. by_engine gives accepted seconds, yield and spend per
video engine, the numbers an engine A/B is read from.
"""
from __future__ import annotations

import os
import time
from datetime import datetime
from pathlib import Path
from statistics import median

from . import asset_registry_catalog as ac
from .admission_leases import HEAVY, listing, provider_of, resource_of
from .common_io_and_paths import TEMPLATES, load_json, read_jsonl
from .edl_validation_and_budget import estimate_job

FILE_KEYS = ("src", "src_raw", "img", "pick")  # src_raw: the generated clip behind a trimmed or upscaled src
RATES = ("gpu_usd_per_hour", "storage_usd_per_gb_month", "egress_usd_per_gb", "people_usd_per_hour")
WALK_SKIP = {"node_modules", "logs", ".git", "__pycache__"}
MEDIAN_SOURCES = ("sidecar", "trace")  # an async span (submit to a later download) is not a job's time


def _rel(p: Path, root: Path) -> str | None:
    try:
        return p.resolve().relative_to(root).as_posix()
    except ValueError:
        return None


def _edl_shots(edl_p: Path, bad: list[str]) -> list[dict]:
    try:
        shots = load_json(edl_p).get("shots", [])
    except (OSError, ValueError, AttributeError) as e:
        bad.append(f"{edl_p.as_posix()}: {e.__class__.__name__}")
        return []
    return [s for s in shots if isinstance(s, dict)]


def _resolve(ep: Path, sd: Path, key: str, v: str) -> list[Path]:
    cands = [ep / v, sd / v] if key in ("src", "src_raw") else [sd / v, ep / v]
    return [c for c in cands if c.exists()][:1] or cands  # both are kept when neither exists


def scene_refs(series: Path, bad: list[str] | None = None) -> dict[tuple[str, str], set[str]]:
    """(episode, scene) -> series-relative paths its edl.json shows. src and src_raw are relative to the episode, img
    and pick to the scene; the first candidate that exists wins. Unreadable EDLs are listed in bad and skipped."""
    out, root, bad = {}, series.resolve(), bad if bad is not None else []
    for edl_p in sorted(series.glob("episodes/*/scenes/*/edl.json")):
        sd, ep = edl_p.parent, edl_p.parents[2]
        paths = set()
        for shot in _edl_shots(edl_p, bad):
            for k in FILE_KEYS:
                v = shot.get(k)
                if isinstance(v, str) and v:
                    paths |= {r for r in (_rel(c, root) for c in _resolve(ep, sd, k, v)) if r}
        out[(ep.name, sd.name)] = paths
    return out


def _rewritten(series: Path, bad: list[str]) -> dict[str, list[tuple[str, str, str, str | None]]]:
    """generated clip path -> [(episode, scene, shot, src path)] for shots whose EDL src was rewritten to a trimmed or
    upscaled copy of it (src_raw keeps the original)."""
    out, root = {}, series.resolve()
    for edl_p in sorted(series.glob("episodes/*/scenes/*/edl.json")):
        sd, ep = edl_p.parent, edl_p.parents[2]
        for s in _edl_shots(edl_p, bad):
            raw, src = s.get("src_raw"), s.get("src")
            if isinstance(raw, str) and isinstance(src, str) and raw != src:
                r = _rel(_resolve(ep, sd, "src_raw", raw)[0], root)
                if r:
                    out.setdefault(r, []).append((ep.name, sd.name, s.get("id"), _rel(_resolve(ep, sd, "src", src)[0], root)))
    return out


def _jobs_by_out(series: Path) -> dict[str, dict]:
    out, root = {}, series.resolve()
    for gp in sorted(series.glob("episodes/*/gen-plan.json")):
        for j in load_json(gp).get("jobs", []):
            r = _rel(gp.parent / j["out"], root) if isinstance(j.get("out"), str) and j["out"] else None
            if r:
                out[r] = {**j, "_episode": gp.parent.name}
    return out


def _episode_of(r: dict) -> str | None:
    return r.get("episode") or (r.get("source") or {}).get("episode")


def _cost(j: dict, prices: dict | None) -> tuple[float | None, str | None]:
    """A recorded cost first, else the price-table estimate `budget` uses, else unpriced (never guessed)."""
    if j.get("cost_usd") is not None:
        return float(j["cost_usd"]), "recorded"
    if prices:
        try:
            return estimate_job(j, prices), "estimate"
        except (KeyError, TypeError, ValueError):
            pass
    return None, None


def _key(series: Path, key: str) -> str:
    p = Path(key)
    if p.is_absolute():
        return _rel(p, series.resolve()) or key
    return p.as_posix()


def _ts(s) -> float | None:
    try:
        return datetime.fromisoformat(str(s)).timestamp()
    except ValueError:
        return None


def _walk_json(root: Path):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in WALK_SKIP and not x.startswith(".")]
        for f in files:
            if f.endswith(".json"):
                yield Path(d) / f


def sidecars(episode_dir: Path) -> dict[Path, dict]:
    """clip -> its ComfyUI sidecar (<clip stem>.json beside an .mp4, with wall_seconds and prompt_id): every local clip
    of the episode, run from a gen-plan job or by hand."""
    out = {}
    for p in _walk_json(episode_dir):
        clip = p.with_suffix(".mp4")
        if not clip.is_file():
            continue
        try:
            d = load_json(p)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and isinstance(d.get("wall_seconds"), (int, float)) and d.get("prompt_id"):
            out[clip.resolve()] = d
    return out


def job_seconds(episode_dir: Path, jobs: list[dict], side: dict[Path, dict] | None = None) -> dict[str, tuple[float, str]]:
    """job id -> (wall seconds, source): its clip's ComfyUI sidecar, else gen_submit to the first gen_done that is not
    `submitted` in the trace: "trace" for a job that finished in place, "trace-async" for one that was submitted and
    downloaded later (that span includes however long nobody fetched, so it is an upper bound)."""
    out, start, went_async = {}, {}, set()
    for r in read_jsonl(episode_dir / "logs" / "trace.jsonl"):
        parts, t = str(r.get("detail") or "").split(), _ts(r.get("ts"))
        if r.get("event") not in ("gen_submit", "gen_done") or len(parts) < 2 or t is None:
            continue
        jid = parts[1]
        if r["event"] == "gen_submit":
            start[jid] = t
            went_async.discard(jid)
        elif jid in start and parts[-1] == "submitted":
            went_async.add(jid)
        elif jid in start:
            out[jid] = (round(t - start.pop(jid), 1), "trace-async" if jid in went_async else "trace")
    side = sidecars(episode_dir) if side is None else side
    for j in jobs:
        s = side.get((episode_dir / j["out"]).resolve()) if isinstance(j.get("out"), str) and j.get("id") else None
        if s:
            out[j["id"]] = (float(s["wall_seconds"]), "sidecar")
    return out


def _estimate_time(j: dict, jobs: list[dict], times: dict) -> tuple[float | None, str | None]:
    if j.get("id") in times:
        return times[j["id"]][0], times[j["id"]][1]
    same = [times[x["id"]][0] for x in jobs if x.get("id") in times and times[x["id"]][1] in MEDIAN_SOURCES
            and x.get("model") == j.get("model") and x.get("kind") == j.get("kind")]
    return (round(median(same), 1), "model-median") if same else (None, None)


def _lease(j: dict) -> str:
    return HEAVY if resource_of(j) == "gpu-local" else f"provider-{provider_of(j)}"


def _regen_task(tid, j, d_path, inputs, prices, out_ids, timing):
    cost, src = _cost(j, prices)
    est, tsrc = timing(j)
    return {"id": tid, "action": "regenerate", "episode": j["_episode"], "scene": j.get("scene"), "inputs": inputs,
            "outputs": [d_path], "output_assets": out_ids, "job": j.get("id"), "kind": j.get("kind"),
            "resource": resource_of(j), "lease": _lease(j), "cost_usd": cost, "cost_source": src,
            "est_seconds": est, "time_source": tsrc, "gates": ["approval"], "after": []}


def _local_task(tid, action, ep, sc, inputs, outputs, resource, out_ids=()):
    """A render, trim or mux on this machine: no lease, no cash cost, no measured time yet."""
    return {"id": tid, "action": action, "episode": ep, "scene": sc, "inputs": inputs, "outputs": outputs,
            "output_assets": list(out_ids), "resource": resource, "lease": None, "cost_usd": 0.0, "cost_source": None,
            "est_seconds": None, "time_source": None, "gates": [], "after": []}


def rebuild_plan(series: Path, changed: list[str], prices: dict | None = None) -> dict:
    """changed: asset ids or paths. -> {tasks, scenes_rendered, scenes_total, reused_scenes, render_seconds, ...}."""
    st = ac.state(series)
    recs = []
    for key in changed:
        aid = key if key in st["assets"] else st["by_path"].get(_key(series, key))
        if not aid:
            raise SystemExit(f"no asset {key}")
        recs.append(st["assets"][aid])
    # every record ever catalogued at a changed path: children made before a re-scan point at the older record
    roots = {r["asset_id"] for r in recs} | {a["asset_id"] for a in st["assets"].values() if a["path"] in {r["path"] for r in recs}}
    by_path = {}
    for aid in sorted(roots):
        for d in ac.impact(series, aid):
            cur = st["assets"].get(st["by_path"].get(d["path"], ""), d)  # one entry per path: its current record
            by_path.setdefault(d["path"], cur)
    for r in recs:
        by_path.pop(r["path"], None)
    jobs, bad = _jobs_by_out(series), []
    ep_jobs, times = {}, {}

    def timing(j):
        ep = j["_episode"]
        if ep not in times:
            ep_jobs[ep] = [x for x in jobs.values() if x["_episode"] == ep]
            times[ep] = job_seconds(series / "episodes" / ep, ep_jobs[ep])
        return _estimate_time(j, ep_jobs[ep], times[ep])
    tasks, regen_of = [], {}
    for path, d in sorted(by_path.items()):
        j = jobs.get(path)
        if j:  # not made by a job: the scene render below still picks the file up
            regen_of[path] = f"regen:{d['asset_id']}"
            tasks.append(_regen_task(regen_of[path], j, path, list(d.get("parents", [])), prices, [d["asset_id"]], timing))
    path_of = {a["asset_id"]: a["path"] for a in st["assets"].values()}

    def nearest(aid, seen):
        """The closest ancestor (within the impact) that has a regenerate task."""
        p = path_of.get(aid)
        if p in regen_of:
            return {regen_of[p]}
        if aid in seen or p not in by_path:
            return set()
        seen.add(aid)
        return set().union(*(nearest(x, seen) for x in by_path[p].get("parents", []))) if by_path[p].get("parents") else set()
    for t in tasks:
        t["after"] = sorted(set().union(*(nearest(x, set()) for x in t["inputs"])) - {t["id"]}) if t["inputs"] else []

    audio = [r for r in recs if r["kind"] == "audio"] + [d for d in by_path.values() if d["kind"] == "audio"]
    picture = ({r["path"] for r in recs if r["kind"] != "audio"} | {p for p, d in by_path.items() if d["kind"] != "audio"})
    refs, rewritten = scene_refs(series, bad), _rewritten(series, bad)
    conform = {}  # (ep, sc) -> task id of the re-trim (and re-upscale) a regenerated clip needs before the render
    for raw, uses in sorted(rewritten.items()):
        if raw not in picture:
            continue
        for ep, sc, shot, src in uses:
            tid = conform.setdefault((ep, sc), f"retrim:{ep}/{sc}")
            t = next((x for x in tasks if x["id"] == tid), None)
            if not t:
                t = {**_local_task(tid, "retrim", ep, sc, [], [], "cpu-render"), "shots": []}
                tasks.append(t)
            t["shots"].append(shot)
            t["after"] = sorted(set(t["after"]) | ({regen_of[raw]} if raw in regen_of else set()))
            if raw in st["by_path"] and st["by_path"][raw] not in t["inputs"]:
                t["inputs"].append(st["by_path"][raw])
            trim = src  # the trimmed file: src itself, or the input of the upscale job that made src
            if src and src in jobs and isinstance(jobs[src].get("input"), str):
                trim = _rel(series / "episodes" / jobs[src]["_episode"] / jobs[src]["input"], series.resolve()) or src
            if trim and trim not in t["outputs"]:
                t["outputs"].append(trim)
                t["output_assets"] += [st["by_path"][trim]] if trim in st["by_path"] else []
            if src and src in jobs and src not in regen_of:  # an upscaled copy: its paid job runs again on the new trim
                up = st["by_path"].get(src) or src
                regen_of[src] = f"regen:{up}"
                ut = _regen_task(regen_of[src], jobs[src], src, [], prices, [up] if src in st["by_path"] else [], timing)
                ut["after"] = [tid]
                tasks.append(ut)
            elif src in regen_of:
                t2 = next(x for x in tasks if x["id"] == regen_of[src])
                t2["after"] = sorted(set(t2["after"]) | {tid})
            if src:
                picture.add(src)
    renders = {}
    for (ep, sc), paths in sorted(refs.items()):
        hit = sorted(paths & picture)
        if hit:
            renders[(ep, sc)] = tid = f"render:{ep}/{sc}"
            after = {regen_of[p] for p in hit if p in regen_of} | ({conform[(ep, sc)]} if (ep, sc) in conform else set())
            tasks.append({**_local_task(tid, "render", ep, sc, [st["by_path"][p] for p in hit if p in st["by_path"]],
                                        [f"episodes/{ep}/scenes/{sc}/renders"], "cpu-render"), "after": sorted(after)})
    for ep in sorted({e for e, _ in renders}):
        tasks.append({**_local_task(f"assemble:{ep}", "assemble", ep, None, [], [f"episodes/{ep}/renders"], "cpu-render"),
                      "after": sorted(t for (e, _), t in renders.items() if e == ep)})

    def ep_of(r):
        return _episode_of(r) or (jobs.get(r["path"]) or {}).get("_episode")
    audio_eps = sorted({ep_of(r) for r in audio} - {None})
    for ep in audio_eps:
        mine = [r for r in audio if ep_of(r) == ep]
        after = {regen_of[r["path"]] for r in mine if r["path"] in regen_of} | ({f"assemble:{ep}"} if any(e == ep for e, _ in renders) else set())
        tasks.append({**_local_task(f"remux:{ep}", "remux", ep, None, [r["asset_id"] for r in mine], [f"episodes/{ep}/renders"], "cpu-mux"),
                      "after": sorted(after)})

    def seconds(k):
        try:
            return float(load_json(series / "episodes" / k[0] / "scenes" / k[1] / "edl.json").get("duration") or 0)
        except (OSError, ValueError, AttributeError):
            return 0.0
    touched = [k for k in refs if k[0] in {e for e, _ in renders} | set(audio_eps)]
    return {"changed": [r["asset_id"] for r in recs], "tasks": tasks,
            "paid_tasks": sum(1 for t in tasks if "approval" in t["gates"]),
            "unpriced": [t["id"] for t in tasks if t["cost_usd"] is None],
            "cost_usd_known": round(sum(t["cost_usd"] or 0 for t in tasks), 4),
            "est_seconds_known": round(sum(t["est_seconds"] or 0 for t in tasks), 1),
            "untimed": [t["id"] for t in tasks if t["est_seconds"] is None and t["action"] == "regenerate"],
            "leases": [x for x in listing(series) if x["live"]],
            "scenes_total": len(touched), "scenes_rendered": len(renders),
            "reused_scenes": sorted(f"{e}/{s}" for e, s in touched if (e, s) not in renders),
            "render_seconds": round(sum(seconds(k) for k in renders), 3),
            "render_seconds_all": round(sum(seconds(k) for k in touched), 3),
            "audio_without_episode": [r["path"] for r in audio if not ep_of(r)], "unreadable_edls": sorted(set(bad))}


def _engine(j: dict) -> str:
    return j.get("model") or j.get("engine") or j.get("provider") or "default"


def _plan_jobs(episode_dir: Path) -> list[dict]:
    plan_p = episode_dir / "gen-plan.json"
    return [j for j in (load_json(plan_p).get("jobs", []) if plan_p.exists() else []) if isinstance(j, dict)]


def clips(episode_dir: Path, jobs: list[dict] | None = None, side: dict[Path, dict] | None = None,
          billed: dict[str, str] | None = None) -> dict[Path, dict]:
    """Generated video clips -> {engine, generated, gpu_seconds, local}: the done video jobs of gen-plan.json ((duration
    or units) x takes), and every ComfyUI clip by its sidecar (seconds, wall_seconds), run by a job or by hand.
    gpu_seconds is None for a local job whose clip has no sidecar (GPU time not measured). billed: job id -> the model
    its ledger rows name, for a job that ran on the runner's default model and so names none itself."""
    side, billed = sidecars(episode_dir) if side is None else side, billed or {}
    out = {p: {"engine": d.get("engine") or "comfyui-local", "generated": float(d.get("seconds") or 0),
               "gpu_seconds": float(d["wall_seconds"]), "local": True} for p, d in side.items()}
    for j in _plan_jobs(episode_dir) if jobs is None else jobs:
        if j.get("kind") == "video" and j.get("status") == "done" and isinstance(j.get("out"), str):
            p, local = (episode_dir / j["out"]).resolve(), resource_of(j) == "gpu-local"
            s = out.get(p, {})
            out[p] = {"engine": j.get("model") or j.get("engine") or billed.get(j.get("id")) or s.get("engine") or j.get("provider") or "default",
                      "generated": float(j.get("duration") or j.get("units") or s.get("generated") or 0) * int(j.get("takes", 1)),
                      "gpu_seconds": s.get("gpu_seconds"), "local": local or bool(s)}
    return out


def accepted_by_engine(episode_dir: Path, made: dict[Path, dict] | None = None) -> dict[str, dict]:
    """engine -> {accepted_seconds, generated_seconds, clips, gpu_seconds, gpu_unmeasured}. accepted: timeline seconds
    of shots whose src (or src_raw, behind a trim or upscale) is a generated clip; a clip used by two shots counts
    twice, so yield can pass 1."""
    made = clips(episode_dir) if made is None else made
    out = {}
    for c in made.values():
        e = out.setdefault(c["engine"], {"accepted_seconds": 0.0, "generated_seconds": 0.0, "clips": 0, "gpu_seconds": 0.0, "gpu_unmeasured": 0})
        e["generated_seconds"] += c["generated"]
        e["clips"] += 1
        if c["local"] and c["gpu_seconds"] is None:
            e["gpu_unmeasured"] += 1
        e["gpu_seconds"] += c["gpu_seconds"] or 0.0
    ep = load_json(episode_dir / "episode.json") if (episode_dir / "episode.json").exists() else {}
    bad = []
    for sc in ep.get("scenes", []):
        for s in _edl_shots(episode_dir / "scenes" / sc / "edl.json", bad) if (episode_dir / "scenes" / sc / "edl.json").exists() else []:
            hit = next((made[p] for p in ((episode_dir / s[k]).resolve() for k in ("src", "src_raw") if isinstance(s.get(k), str)) if p in made), None)
            if hit:
                out[hit["engine"]]["accepted_seconds"] += max(0.0, float(s.get("end", 0)) - float(s.get("start", 0)))
    for e in out.values():
        for k in ("accepted_seconds", "generated_seconds", "gpu_seconds"):
            e[k] = round(e[k], 3)
    return out


def accepted_seconds(episode_dir: Path) -> tuple[float, float]:
    """-> (accepted, generated) over every engine (see accepted_by_engine)."""
    by = accepted_by_engine(episode_dir)
    return round(sum(e["accepted_seconds"] for e in by.values()), 3), round(sum(e["generated_seconds"] for e in by.values()), 3)


def load_rates(series: Path) -> dict:
    """`rates` of the skill price table overlaid by <series>/price-table.json. None ship with a value: they are what
    this studio pays (GPU hour, GB-month, GB copied out, a person's hour), never guessed here."""
    out = {}
    for p in (TEMPLATES / "price-table.json", series / "price-table.json"):
        raw = (load_json(p).get("rates") or {}) if p.exists() else {}
        for k, v in raw.items():
            if k in RATES and (not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0):
                raise SystemExit(f"{p}: rates.{k} must be a number >= 0 (got {v!r})")
        out.update({k: float(v) for k, v in raw.items() if k in RATES})
    return out


def _months_since(created) -> float | None:
    t = _ts(created)
    return round(max(0.0, time.time() - t) / (30.44 * 86400), 3) if t is not None else None


def _priced(qty: float | None, rate: float | None, used: bool) -> tuple[float | None, bool]:
    """-> (usd, unpriced). usd is None when nothing was used, and also when something was but its quantity or rate is
    unknown; unpriced tells the second case apart (listed in unit_cost's `unpriced_usage`)."""
    if not used:
        return None, False
    if qty is None or rate is None:
        return None, True
    return round(qty * rate, 4), False


def unit_cost(episode_dir: Path, *, ledger: dict, tokens: dict | None, storage_bytes: int | None = None,
              rates: dict | None = None) -> dict:
    """ledger: telemetry ledger(); tokens: tokens_for_run() or None; storage_bytes: the episode's bytes (default: its
    live catalogued assets); rates: load_rates(series) by default."""
    series = episode_dir.parents[1]
    rates = load_rates(series) if rates is None else rates
    video_rows = [r for r in ledger.get("rows", []) if r.get("kind") == "video"]
    # Atlas rows carry the job id as `name`, other providers as `id`; the billed model names a job's engine
    billed = {(r.get("name") if r.get("provider", "atlas") == "atlas" else r.get("id")): r["model"] for r in video_rows if r.get("model")}
    made = clips(episode_dir, billed=billed)
    by = accepted_by_engine(episode_dir, made)
    acc, gen = sum(e["accepted_seconds"] for e in by.values()), sum(e["generated_seconds"] for e in by.values())
    gpu_s = sum(e["gpu_seconds"] for e in by.values())
    gpu_unmeasured = sum(e["gpu_unmeasured"] for e in by.values())
    gpu_used = any(c["local"] for c in made.values())
    gpu_usd, gpu_unpriced = _priced(None if gpu_unmeasured else gpu_s / 3600, rates.get("gpu_usd_per_hour"), gpu_used)
    # storage/egress, approximated: the episode's live catalogued bytes today, as if held since episode.json `created`
    # (files added later count from the start, deleted or superseded ones not at all), and bytes copied to remotes
    # (each receipt once; what the remote charges to hold them is not counted)
    st = ac.state(series) if ac.catalog_path(series).exists() else None
    mine = {a["asset_id"]: a for a in (st or {"assets": {}})["assets"].values() if not a.get("superseded_by")
            and (_episode_of(a) == episode_dir.name or a["path"].startswith(f"episodes/{episode_dir.name}/"))}
    if storage_bytes is None and st is not None:
        storage_bytes = sum(int(a.get("bytes") or 0) for a in mine.values())
    egress = sum(int(r.get("bytes") or 0) for r in ac.read_log(series / "catalog" / "replicas.jsonl")[0]
                 if r.get("op") == "replica" and r.get("how") != "adopted" and r.get("asset_id") in mine)
    months = _months_since((load_json(episode_dir / "episode.json") if (episode_dir / "episode.json").exists() else {}).get("created"))
    hold, hold_unpriced = _priced(storage_bytes / 1e9 * months if storage_bytes is not None and months is not None else None,
                                  rates.get("storage_usd_per_gb_month"), storage_bytes is None or storage_bytes > 0)
    out_usd, out_unpriced = _priced(egress / 1e9, rates.get("egress_usd_per_gb"), egress > 0)
    storage_unpriced = hold_unpriced or out_unpriced
    parts = [x for x in (hold, out_usd) if x is not None]
    storage_usd = round(sum(parts), 4) if parts and not storage_unpriced else None
    # people: hours recorded on trace events (`trace $EP human --set hours=1.5`), every run of the episode
    hours, bad_hours = 0.0, 0
    for r in read_jsonl(episode_dir / "logs" / "trace.jsonl"):
        if "hours" in r:
            try:
                hours += max(0.0, float(r["hours"]))
            except (TypeError, ValueError):
                bad_hours += 1
    people_usd, people_unpriced = _priced(hours, rates.get("people_usd_per_hour"), hours > 0)
    split = {"media_usd": ledger["total_usd"], "tokens_usd": tokens["total"]["usd"] if tokens else None,
             "gpu_usd": gpu_usd, "storage_usd": storage_usd, "people_usd": people_usd}
    known = sum(v for v in split.values() if v is not None)
    # per engine: video spend from the ledger rows of that model, GPU time of its local clips
    spend: dict[str, list] = {}
    for r in video_rows:
        s = spend.setdefault(r.get("model") or "default", [0.0, 0])
        s[0] += r.get("cost_usd") or 0.0
        s[1] += r.get("cost_usd") is None
    engines = {}
    for name in sorted(set(by) | set(spend)):
        e = by.get(name, {"accepted_seconds": 0.0, "generated_seconds": 0.0, "clips": 0, "gpu_seconds": 0.0, "gpu_unmeasured": 0})
        media, unpriced = spend.get(name, [0.0, 0])
        g, g_unpriced = _priced(None if e["gpu_unmeasured"] else e["gpu_seconds"] / 3600, rates.get("gpu_usd_per_hour"),
                                e["gpu_seconds"] > 0 or e["gpu_unmeasured"] > 0)
        usd = None if g_unpriced else round(media + (g or 0.0), 4)
        engines[name] = {**e, "yield": round(e["accepted_seconds"] / e["generated_seconds"], 3) if e["generated_seconds"] else None,
                         "media_usd": round(media, 4), "unpriced": unpriced, "gpu_usd": g, "usd": usd,
                         "usd_per_accepted_second": round(usd / e["accepted_seconds"], 4) if usd is not None and e["accepted_seconds"] else None}
    return {"episode": episode_dir.name, "accepted_seconds": round(acc, 3), "generated_seconds": round(gen, 3),
            "yield": round(acc / gen, 3) if gen else None, "split": split,
            "not_measured": [k for k, v in split.items() if v is None],
            "unpriced_usage": [k for k, u in (("gpu_usd", gpu_unpriced), ("storage_usd", storage_unpriced), ("people_usd", people_unpriced)) if u],
            "usage": {"gpu_seconds": round(gpu_s, 1), "gpu_jobs_unmeasured": gpu_unmeasured,
                      "storage_gb": round(storage_bytes / 1e9, 3) if storage_bytes is not None else None, "storage_months": months,
                      "egress_gb": round(egress / 1e9, 3), "people_hours": round(hours, 2), "bad_hours_rows": bad_hours},
            "rates": rates, "missing_rates": [k for k in RATES if k not in rates],
            "storage_gb": round(storage_bytes / 1e9, 3) if storage_bytes is not None else None,
            "unpriced_media": ledger.get("unpriced", []), "by_engine": engines,
            "cost_per_accepted_second": round(known / acc, 4) if acc else None,
            "media_per_accepted_second": round(ledger["total_usd"] / acc, 4) if acc else None}
