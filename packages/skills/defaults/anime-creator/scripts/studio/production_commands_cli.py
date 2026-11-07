"""anime-studio.py commands for action planning, salvage, references, continuity, shot joins, Foley staleness and the
asset registry. Kept apart from the main dispatch so anime-studio.py stays one screen of plumbing; every command here
is offline and writes proposals or reports, never edl.json, mix-events.json or media.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from . import action_plan_grammar as ag
from . import admission_leases as adm
from . import asset_registry_catalog as ac
from . import common_io_and_paths as io
from . import continuity_transition_validator as cv
from . import engine_routing as er
from . import reference_reel_builder as rb
from . import shot_boundary_contract as sb
from . import sound_generation_adapters as sg
from . import storage_policy_and_replication as st
from . import take_salvage_planner as sv

GROUP = "production validate-action, plan-action, salvage-plan, ref-reel, continuity, chain, previz-camera, v2a-stale, assets, leases"
ASSET_ACTIONS = ("scan", "list", "get", "resolve", "refs", "lineage", "impact", "check", "pin", "unpin", "gc",
                 "policy", "replicate", "verify-remote", "restore", "export-check",
                 "adopt-delivery")


def _P(s: str) -> Path:
    return Path(s).expanduser().resolve()


def _edl(sd: Path) -> dict | None:
    return io.load_json(sd / "edl.json") if (sd / "edl.json").exists() else None


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(path)


def register(add, O) -> None:
    add("validate-action", "scene", help="check scenes/<sc>/action-plan.json (axis, props, contact, flash rate)")
    add("plan-action", "scene", O("--grid", action="store_true"), O("--reduced-flash", action="store_true"), O("--out"),
        help="proposals from the action plan: EDL rows, hits, keyframe jobs, edit cues, SFX anchors")
    add("salvage-plan", "scene", O("--fps", type=int), O("--handle", type=int, default=2), O("--retake-usd", type=float), O("--out"),
        help="clean spans from paid takes (scenes/<sc>/salvage.json) + EDL and mix remap proposals")
    add("ref-reel", "episode", "reel", O("--role", default="i2v-cloud"), O("--engine"), O("--out-dir"), O("--fps", type=int, default=24),
        help="reference manifest with hashes and the adapter payload; prints ffmpeg commands (dry run)")
    add("continuity", "episode", "scene", O("--next", help="<scene>/<shot> in this episode, or <episode>/<scene>/<shot>"),
        O("--series-state", action="store_true", help="check the scene's last shot against story/continuity.json `state` (an episode's end)"),
        O("--json", action="store_true"), help="state across every cut: definite / suspected / allowed")
    add("chain", "episode", "job", O("--at", help="seconds into the source, or `edl` for this take's out-point in its scene EDL"),
        help="propose a take's last frame (or the frame at --at) as the next first frame (refuses defective sources)")
    add("previz-camera", "blockout", O("t0", type=float), O("t1", type=float), help="blockout camera keys -> camera-transition fields")
    add("v2a-stale", "episode", help="Foley stems whose clip, in-point or speed changed since generation")
    add("assets", O("action", choices=ASSET_ACTIONS), "series", O("target", nargs="?"), O("--kind"), O("--role"), O("--episode"),
        O("--scene"), O("--shot"), O("--status"), O("--limit", type=int, default=50), O("--offset", type=int, default=0),
        O("--by", default=""), O("--reason", default=""), O("--dry-run", action="store_true"), O("--json", action="store_true"),
        O("--rehash", action="store_true", help="scan/check: hash every file, ignoring catalog/hash-cache.json"),
        O("--remote", help="replicate/verify-remote/restore: remote name from catalog/policy.json (default: the first)"),
        O("--init", action="store_true", help="policy: write the default catalog/policy.json"),
        O("--remote-root", help="policy --init: folder of the first fs remote (a Drive mirror, a NAS share)"),
        O("--deep", action="store_true", help="verify-remote: re-hash every remote copy, not only compare sizes"),
        O("--force", action="store_true", help="restore: also replace local files that differ from their record (moved aside first); adopt-delivery: adopt a file no earlier delivery row names"),
        O("--quarantine", action="store_true", help="gc: move unused derivatives to catalog/quarantine/<stamp>/ (with --dry-run: list them)"),
        O("--restore", metavar="STAMP", dest="gc_restore", help="gc: put the quarantine batch STAMP back where it came from"),
        O("--purge", action="store_true", help="gc: delete quarantine batches older than --older-than days"),
        O("--older-than", type=float, help="gc --purge: age in days (default: policy retention quarantine_days, 7)"),
        help="series asset catalog (catalog/assets.jsonl): " + ", ".join(ASSET_ACTIONS))
    add("leases", "series", O("--all", action="store_true", help="also expired or orphaned leases (reclaimable)"),
        O("--json", action="store_true"), help="admission leases a runner holds (catalog/leases): heavy GPU slot, provider slots")


def run(a) -> bool:  # noqa: C901 - flat dispatch, like anime-studio.py
    c = a.cmd
    if c == "validate-action":
        sd = _P(a.scene)
        err, warn = ag.validate(io.load_json(sd / "action-plan.json"), _edl(sd))
        for x in err:
            print(f"ERROR {sd.name}: {x}")
        for x in warn:
            print(f"warn  {sd.name}: {x}")
        print(f"{sd.name}: {len(err)} errors, {len(warn)} warnings")
        sys.exit(1 if err else 0)
    elif c == "plan-action":
        sd = _P(a.scene)
        plan = io.load_json(sd / "action-plan.json")
        err, _ = ag.validate(plan, _edl(sd))
        if err:
            sys.exit("action-plan.json has errors (run validate-action): " + "; ".join(err[:5]))
        out = _P(a.out) if a.out else sd.parents[1] / "work/action" / f"{sd.name}-proposal.json"
        _write(out, ag.dumps(ag.propose(plan, _edl(sd), reduced=a.reduced_flash)) + "\n")
        if a.grid:
            _write(out.with_suffix(".grid.md"), ag.grid(plan, sd, _edl(sd)))
    elif c == "salvage-plan":
        sd = _P(a.scene)
        fps = a.fps or (_edl(sd) or {}).get("fps", 24)
        res = sv.plan(io.load_json(sd / "salvage.json"), fps=fps, handle_frames=a.handle, retake_usd=a.retake_usd)
        ep = sd.parents[1]
        mix_p = ep / "audio/mix-events.json"
        if mix_p.exists() and _edl(sd):
            events = io.load_json(mix_p).get("events", [])
            old = {s["id"]: s for s in _edl(sd)["shots"]}
            res["mix_remap"] = [sv.remap_mix(events, sd.name, sid, float(old[sid].get("in", 0)), [r for r in res["edl_shots"] if r.get("replaces") == sid], old[sid].get("src"))
                                for sid in sorted({r["replaces"] for r in res["edl_shots"] if r.get("replaces")}) if sid in old]
        _write(_P(a.out) if a.out else ep / "work/salvage" / f"{sd.name}-salvage.json", json.dumps(res, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(res["metrics"]))
        if res["unfilled"]:
            print("unfilled shots: " + ", ".join(res["unfilled"]))
    elif c == "ref-reel":
        e = _P(a.episode)
        _, caps = rb.adapter_caps(er.load(e), a.role, a.engine)
        out_dir = _P(a.out_dir) if a.out_dir else e / "work/refs" / Path(a.reel).stem
        man = rb.build(io.load_json(_P(a.reel)), e, caps, out_dir=out_dir)
        _write(out_dir / "manifest.json", json.dumps(man, ensure_ascii=False, indent=2) + "\n")
        for cmd in rb.reel_cmds(man, e, out_dir, fps=a.fps):
            print("$ " + " ".join(cmd))
        for x in man["errors"]:
            print(f"ERROR {x}")
        sys.exit(1 if man["errors"] else 0)
    elif c == "continuity":
        e = _P(a.episode)
        cont = io.load_json(e.parents[1] / "story/continuity.json")
        ids = [s["id"] for s in io.load_json(e / "scenes" / a.scene / "edl.json")["shots"]]
        try:
            nxt = cv.parse_next(a.next, e.name) if a.next else None
        except ValueError as x:
            sys.exit(str(x))
        if nxt and nxt[0] != e.name and not (e.parent / nxt[0]).is_dir():
            sys.exit(f"--next {a.next}: no episode {nxt[0]} in {e.parent}")
        res = cv.check(cont, e.name, a.scene, ids, next_first=nxt, series_state=a.series_state)
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            for f in res:
                print(f"{f['class']:9s} {f['from']} -> {f['to']} {f['key']}: {f['detail']}")
            print(json.dumps(cv.summary(res)))
        sys.exit(1 if any(f["class"] == "definite" for f in res) else 0)
    elif c == "chain":
        e = _P(a.episode)
        job = next((j for j in io.load_json(e / "gen-plan.json")["jobs"] if j["id"] == a.job), None)
        if not job:
            sys.exit(f"job {a.job} not in gen-plan.json")
        edl, at = None, None
        if a.at == "edl":  # only --at edl reads the EDL: a plain chain works without one
            edl = _edl(e / "scenes" / str(job.get("scene")))
            try:
                at = sb.edl_out_point(edl, job) if edl else None
            except ValueError as x:
                sys.exit(str(x))
            if at is None:
                sys.exit(f"no shot in scenes/{job.get('scene')}/edl.json uses {job.get('out') or a.job}; pass --at <seconds>")
        elif a.at:
            try:
                at = float(a.at)
            except ValueError:
                sys.exit(f"--at takes seconds or `edl`, not {a.at!r}")
        prop = sb.chain_proposal(job, e, fps=float((edl or {}).get("fps", 24)), at=at)
        print(json.dumps(prop, indent=2))
        sys.exit(0 if prop["ok"] else 1)
    elif c == "previz-camera":
        keys = io.load_json(_P(a.blockout))
        print(json.dumps(sb.previz_camera(keys.get("camera", keys) if isinstance(keys, dict) else keys, a.t0, a.t1), indent=2))
    elif c == "v2a-stale":
        e = _P(a.episode)
        bad = 0
        for side_p in sorted(e.glob("audio/**/*.wav.json")):
            side = io.load_json(side_p)
            if side.get("mode") != "video-to-audio":
                continue
            plan = next((j for j in io.load_json(e / "gen-plan.json")["jobs"] if j["id"] == side.get("job")), {}) if (e / "gen-plan.json").exists() else {}
            edl_p = e / "scenes" / str(plan.get("scene")) / "edl.json"
            shot = next((s for s in io.load_json(edl_p)["shots"] if s["id"] == plan.get("shot")), None) if edl_p.exists() else None
            why = sg.stale(side, e, shot)
            bad += bool(why)
            print(f"{side_p.relative_to(e)}: " + ("; ".join(why) if why else "current"))
        sys.exit(1 if bad else 0)
    elif c == "assets":
        assets_cmd(a)
    elif c == "leases":
        rows = [x for x in adm.listing(_P(a.series)) if a.all or x["live"]]
        if a.json:
            print(json.dumps(rows, indent=2))
        else:
            for x in rows:
                print(f"{x['key']}.{x.get('slot')} {'live' if x['live'] else 'reclaimable':11s} pid {x.get('pid')} on {x.get('host')} "
                      f"{x.get('episode')} {x.get('job')} {x.get('resource')} until {x['expires']}")
            print(f"{len(rows)} lease(s)" + ("" if a.all else " live"))
    else:
        return False
    return True


def assets_cmd(a) -> None:
    try:
        _assets_cmd(a)
    except ac.CatalogChanged as e:
        sys.exit(str(e))


def _assets_cmd(a) -> None:  # noqa: C901
    s = _P(a.series)
    act, t = a.action, a.target
    if act not in ("scan", "list", "check", "gc", "policy", "replicate", "verify-remote", "restore") and not t:
        sys.exit(f"assets {act} needs a target (asset id, path or episode/scene)")
    if act == "scan":
        cache = ac.HashCache(s, rehash=a.rehash)
        print(json.dumps({**ac.scan(s, cache=cache), "hashed": cache.hashed}))
    elif act == "list":
        res = ac.query(s, kind=a.kind, role=a.role, episode=a.episode, scene=a.scene, status=a.status, limit=a.limit, offset=a.offset)
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            for r in res["items"]:
                print(f"{r['asset_id']} {r['kind']:5s} {r['role']:11s} {r['status']:9s} {'pin ' if r.get('pinned') else ''}{r['path']}")
            print(f"{len(res['items'])} of {res['total']}" + (f"; next --offset {res['next_offset']}" if res["next_offset"] is not None else ""))
    elif act in ("get", "resolve"):
        r = ac.get(s, t)
        if not r:
            sys.exit(f"no asset {t}")
        while act == "resolve" and r.get("superseded_by"):
            r = ac.get(s, r["superseded_by"])
        print(json.dumps(r, ensure_ascii=False, indent=2) if act == "get" else s / r["path"])
    elif act == "refs":
        ep, sc = (t.split("/") + [None])[:2]
        rows = ac.refs(s, ep, sc, a.shot)
        print(json.dumps(rows, ensure_ascii=False, indent=2) if a.json else "\n".join(f"{r['asset_id']} {r['role']:11s} {r['path']}" for r in rows))
    elif act in ("lineage", "impact"):
        r = ac.get(s, t)
        if not r:
            sys.exit(f"no asset {t}")
        rows = (ac.lineage if act == "lineage" else ac.impact)(s, r["asset_id"])
        print(json.dumps(rows, ensure_ascii=False, indent=2) if a.json else "\n".join(f"{x['asset_id']} {x['role']:11s} {x['path']}" for x in rows) or "(none)")
    elif act == "check":
        cache = ac.HashCache(s, rehash=a.rehash)
        probs = ac.check(s, cache=cache)
        print("\n".join(probs) or "catalog consistent")
        print(f"hashed {cache.hashed} file(s)" + ("" if a.rehash else "; --rehash verifies every file"), file=sys.stderr)
        sys.exit(1 if any(not p.startswith("dup") for p in probs) else 0)
    elif act in ("pin", "unpin"):
        r = ac.get(s, t)
        if not r:
            sys.exit(f"no asset {t}")
        ac.pin(s, r["asset_id"], on=act == "pin", by=a.by, reason=a.reason)
        print(f"{act} {r['asset_id']}")
    elif act == "policy":
        if a.init:
            print(f"wrote {st.init_policy(s, a.remote_root)}")
        pol = st.load_policy(s)
        if pol is None:
            sys.exit(f"no {st.policy_path(s)}: storage tiers and remotes are off (assets policy {s} --init turns them on)")
        tiers = {}
        for r in st.live(s):
            t_ = st.tier_of(r, pol)
            n, b = tiers.get(t_, (0, 0))
            tiers[t_] = (n + 1, b + r["bytes"])
        print(json.dumps({"policy": str(st.policy_path(s)), "remotes": pol["remotes"], "replicate": pol["replicate"],
                          "tiers": {k: {"assets": n, "gb": round(b / 1e9, 3)} for k, (n, b) in sorted(tiers.items())}}, indent=2))
    elif act == "replicate":
        res = st.replicate(s, a.remote, dry_run=a.dry_run)
        print(json.dumps(res, indent=2))
        sys.exit(1 if res["failed"] else 0)
    elif act == "verify-remote":
        res = st.verify_remote(s, a.remote, deep=a.deep)
        print(json.dumps(res, indent=2) if a.json else "\n".join(res["problems"] + [f"{res['remote']}: {res['status']} {res['counts']}"]))
        sys.exit(0 if res["status"] == "ok" else 1)
    elif act == "restore":
        r = ac.get(s, t.replace("\\", "/")) if t else None
        if t and not r:
            sys.exit(f"no asset {t}")
        res = st.restore(s, a.remote, targets=[r["asset_id"]] if r else None, dry_run=a.dry_run, force=a.force)
        print(json.dumps(res, indent=2))
        sys.exit(0 if res["ok"] else 1)
    elif act == "export-check":
        res = st.export_check(s, t)
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            for o in res["offenders"]:
                print(f"{o['asset_id'] or '-':22s} {o['role'] or '-':11s} {o['path'] or '(outside the series)'}: no {', no '.join(o['missing'])}")
            print(f"{res['target']}: {len(res['offenders'])} of {res['checked']} inputs lack provenance, licence or consent"
                  + ("" if res["ok"] else "; record them in catalog/licences.json {path: {source, licence|consent, by}}"))
        sys.exit(0 if res["ok"] else 1)
    elif act == "adopt-delivery":
        print(json.dumps(st.adopt_delivery(s, t, by=a.by, reason=a.reason, force=a.force), ensure_ascii=False))
    elif act == "gc":
        _gc(s, a)


def _gc(s: Path, a) -> None:
    modes = [m for m, on in (("--quarantine", a.quarantine), ("--restore", a.gc_restore), ("--purge", a.purge)) if on]
    if len(modes) > 1 or not (modes or a.dry_run) or (a.gc_restore and a.dry_run):
        sys.exit("assets gc takes --dry-run, --quarantine, --restore <stamp> or --purge, one at a time "
                 "(--dry-run previews --quarantine and --purge)")
    if a.gc_restore:
        res = st.restore_batch(s, a.gc_restore, by=a.by, reason=a.reason)
        print(json.dumps(res, indent=2))
        sys.exit(0 if res["ok"] else 1)
    if a.purge:
        res = st.purge(s, a.older_than, by=a.by, reason=a.reason, dry_run=a.dry_run)
        print(json.dumps(res, indent=2))
        sys.exit(1 if res["skipped"] else 0)
    res = st.quarantine(s, by=a.by, reason=a.reason, dry_run=a.dry_run)
    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        sys.exit(1 if res["unreadable"] else 0)
    for r in res["moved"]:
        print(f"{r['asset_id']} {r['why']:10s} {r['bytes'] / 1e6:8.2f} MB {r['path']}")
    for r in res["held"]:
        print(f"{r['asset_id']} {r['why']:10s} {r['bytes'] / 1e6:8.2f} MB {r['path']}  held: {r['held']}")
    for x in res["changed"]:
        print(f"skipped {x}")
    n, mb = len(res["moved"]), res["bytes"] / 1e6
    print(f"{n + len(res['held'])} candidates; {n} ({mb:.1f} MB) " + (
        "can be quarantined (assets gc --quarantine); nothing deleted" if a.dry_run
        else f"moved to catalog/quarantine/{res['batch']}/ (assets gc --restore {res['batch']} puts them back); nothing deleted"
        if res["batch"] else "to move; nothing deleted"))
    if res["unreadable"]:  # an EDL or episode JSON gc could not read may name any candidate: nothing moves
        sys.exit("gc held every candidate: unreadable " + "; ".join(res["unreadable"]))
