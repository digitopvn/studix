#!/usr/bin/env python3
"""anime-studio: the deterministic half of an anime production, one command per step.

Python 3.9+ standard library; ffmpeg/ffprobe for media; node/npx for the scene bundle and HyperFrames.
Supported: macOS and Linux. Paths are explicit; series projects live under $ANIME_STUDIO_ROOT (or --root).
Run `python3 anime-studio.py <command> -h` for the arguments of one command. Groups:
  setup     preflight, init-series, init-episode, init-scene, init-clip, status, gate
  plan      validate, budget, prompt, context-pack
  footage   trim, conform
  edit      build, build-edit, render, snapshot, subtitles, concat
  finish    grade, sheet, strip, loudness, onsets, lipsync, edge
  telemetry run-start, phase, trace, ledger, tokens, report, finish, insights
  knowledge knowledge (list|show|for|lint), filmspec
  production validate-action, plan-action, salvage-plan, ref-reel, continuity, chain, previz-camera, v2a-stale,
            assets (scan|list|get|resolve|refs|lineage|impact|check|pin|unpin|gc --dry-run)
  observability observe, context-bytes, dod (record|status)
  engines   engines (ab-record|measured|set-default)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from studio import asset_observability_and_dod_gates as og  # noqa: E402
from studio import common_io_and_paths as io  # noqa: E402
from studio import conform_and_trim as ct  # noqa: E402
from studio import edit_page_builder as eb  # noqa: E402
from studio import edl_validation_and_budget as vb  # noqa: E402
from studio import engine_ab_and_defaults as ea  # noqa: E402
from studio import environment_preflight as pf  # noqa: E402
from studio import grade_filter_graph as gr  # noqa: E402
from studio import knowledge_packs_and_film_spec as kf  # noqa: E402
from studio import media_inspection as mi  # noqa: E402
from studio import production_commands_cli as pc  # noqa: E402
from studio import project_layout_and_init as pl  # noqa: E402
from studio import rebuild_plan_and_unit_cost as rp  # noqa: E402
from studio import shot_prompt_compiler as sp  # noqa: E402
from studio import telemetry_tokens_report_insights as tr  # noqa: E402
from studio import telemetry_trace_and_ledger as tl  # noqa: E402

HF = ["npx", "-y", "hyperframes@0.8.77"]


def P(s: str) -> Path:
    return Path(s).expanduser().resolve()


def series_of(episode_dir: Path) -> Path:
    return episode_dir.parents[1]


def prices_for(series_dir: Path | None) -> dict:
    """Skill price table, overlaid by <series>/price-table.json (prices measured on this project win)."""
    base = io.load_json(io.TEMPLATES / "price-table.json")
    local = series_dir / "price-table.json" if series_dir else None
    if local and local.exists():
        over = io.load_json(local)
        base["items"].update(over.get("items", {}))
        base.setdefault("tokens", {}).update(over.get("tokens", {}))
    return base


def episode_hits(episode_dir: Path) -> list[float]:
    return [row["offset"] + t for row in eb.episode_timeline(episode_dir) for t in row["edl"].get("hits", [])]


def cmd(a: argparse.Namespace) -> None:  # noqa: C901 - one flat dispatch is easier to scan than 30 functions
    c = a.cmd
    if pc.run(a) or kf.run(a) or og.run(a) or ea.run(a):  # action plans, salvage, references, continuity, joins, Foley staleness, assets; knowledge; observability; engine A/B
        return
    if c == "preflight":
        rep = pf.preflight(P(a.project) if a.project else None, tuple(int(p) for p in a.ports.split(",") if p))
        print(json.dumps(rep, indent=2)) if a.json else pf.print_report(rep)
    elif c == "init-series":
        s = pl.init_series(io.studio_root(a.root), a.slug, title=a.title, fps=a.fps, aspect=a.aspect, languages=a.lang.split(","),
                           fetch=not a.offline, three_from=P(a.three_from) if a.three_from else None)
        print(f"series {s}")
    elif c == "init-episode":
        print(f"episode {pl.init_episode(P(a.series), a.ep, target_seconds=a.seconds, ceiling_usd=a.ceiling)}")
    elif c == "init-scene":
        print(f"scene {pl.init_scene(P(a.episode), a.scene, fetch_font=not a.offline)}")
    elif c == "init-clip":
        s = pl.init_series(io.studio_root(a.root), a.slug, title=a.title, fps=a.fps, fetch=not a.offline,
                           three_from=P(a.three_from) if a.three_from else None)
        e = pl.init_episode(s, "ep01", target_seconds=a.seconds, ceiling_usd=a.ceiling)
        print(f"clip project {pl.init_scene(e, 'sc01', fetch_font=not a.offline)}")
    elif c == "status":
        e = P(a.episode)
        ep = io.load_json(e / "episode.json")
        print(f"{e.name}: target {ep['target_seconds']}s, ceiling ${ep['ceiling_usd']}, run {ep.get('current_run', '-')}")
        print("gates: " + "  ".join(f"{g} {s}" for g, s in ep["gates"].items()))
        for row in eb.episode_timeline(e) if ep["scenes"] else []:
            err, warn = vb.validate_edl(row["edl"], e / "scenes" / row["scene"])
            print(f"  {row['scene']} @{row['offset']:.2f}s {row['duration']:.2f}s {len(row['edl']['shots'])} shots, {len(err)} errors, {len(warn)} warnings")
        if (e / "gen-plan.json").exists():
            b = vb.budget(io.load_json(e / "gen-plan.json"), prices_for(series_of(e)), ep["ceiling_usd"])
            print(f"budget: planned ${b['planned_usd']}, spent ${b['spent_usd']}, headroom ${b['headroom_usd']}")
        for r in tl.run_events(e)[-a.last:]:
            print(f"  {r['ts'][11:19]} {r['event']:11s} {r.get('phase', '') or r.get('shot', '')} {r.get('detail', '')[:90]}")
    elif c == "gate":
        e = P(a.episode)
        ep = pl.set_gate(e, a.gate, a.status, a.note)
        tl.trace(e, "gate", gate=a.gate, status=a.status, detail=a.note)
        print("gates: " + "  ".join(f"{g} {s}" for g, s in ep["gates"].items()))
    elif c == "validate":
        bad = 0
        for sd in map(P, a.scenes):
            err, warn = vb.validate_edl(io.load_json(sd / "edl.json"), sd)
            for x in err:
                print(f"ERROR {sd.name}: {x}")
            for x in warn:
                print(f"warn  {sd.name}: {x}")
            print(f"{sd.name}: {len(err)} errors, {len(warn)} warnings")
            bad += len(err)
        sys.exit(1 if bad else 0)
    elif c == "budget":
        e = P(a.episode)
        b = vb.budget(io.load_json(e / "gen-plan.json"), prices_for(series_of(e)), io.load_json(e / "episode.json")["ceiling_usd"])
        print(json.dumps(b, indent=2)) if a.json else vb.print_budget(b)
        sys.exit(2 if b["over_ceiling"] else 0)
    elif c == "prompt":
        e = P(a.episode)
        job = next((j for j in io.load_json(e / "gen-plan.json")["jobs"] if j["id"] == a.job), None)
        if not job:
            sys.exit(f"job {a.job} not in gen-plan.json")
        print(json.dumps(sp.compile_prompt(series_of(e), job, max_refs=a.max_refs), ensure_ascii=False, indent=2))
    elif c == "context-pack":
        e = P(a.episode)
        print(sp.context_pack(series_of(e), e, a.scene, a.shot))
    elif c == "trim":
        ct.trim(P(a.scene), handle_frames=a.handle, only=a.shots.split(",") if a.shots else None, rewrite=a.rewrite, dry=a.dry_run)
    elif c == "conform":
        ct.conform(P(a.scene), size=a.size, only=a.shots.split(",") if a.shots else None, dry=a.dry_run)
    elif c in ("build", "build-edit"):
        sd = P(a.scene)
        err, _ = vb.validate_edl(io.load_json(sd / "edl.json"), sd)
        if err:
            sys.exit("edl.json has errors (run validate): " + "; ".join(err[:5]))
        if c == "build":
            io.run(["bash", str(pl.engine_dir_for(sd) / "build-scene.sh"), str(sd)], capture=False)
        out = eb.build_edit(sd, duration=a.duration, lang=a.lang)
        print(f"{out} ({f'{a.duration}s preview' if a.duration else 'full length'})")
    elif c == "render":
        sd = P(a.scene)
        out = P(a.out) if a.out else sd.parents[1] / "renders" / f"{sd.name}-{a.quality}.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        workers = a.workers or pf.preflight()["render_workers"]  # sized from free memory, load and cores
        io.run(HF + ["check"], cwd=str(sd), capture=False)
        io.run(HF + ["render", ".", "--fps", str(a.fps or io.load_json(sd / "edl.json")["fps"]), "--quality", a.quality,
                     "--video-frame-format", "png", "-w", str(workers), "-o", str(out)], cwd=str(sd), capture=False)
        print(f"{out}: {io.ffprobe_frames(out)} frames")
    elif c == "snapshot":
        sd = P(a.scene)
        io.run(HF + ["snapshot", "--at", a.at, "--no-end", "--timeout", "20000", "--describe", "false", "-o", str(P(a.out))],
               cwd=str(sd), capture=False)
    elif c == "subtitles":
        print(eb.export_subtitles(P(a.episode), a.format, which=a.which, name=a.out))
    elif c == "concat":
        e = P(a.episode)
        ep = io.load_json(e / "episode.json")
        renders = [e / "renders" / f"{s}-{a.quality}.mp4" for s in ep["scenes"]]
        missing = [str(r) for r in renders if not r.exists()]
        if missing:
            sys.exit("missing scene renders: " + ", ".join(missing))
        out = e / "renders" / f"{e.name}-{a.quality}.mp4"
        io.run(gr.concat_scenes(renders, out))
        print(out)
    elif c == "grade":
        src, base = P(a.src), P(a.out)
        hits = [float(x) for x in a.hits.split(",") if x] if a.hits else (episode_hits(P(a.episode)) if a.episode else [])
        g = gr.grade_graph(hits=hits, fps=a.fps, look=a.look, bloom=a.bloom, grain=a.grain)
        if a.test:
            print(gr.color_test(src, base.with_name(base.name + "-colortest.jpg"), g))
            return
        master = base.with_name(base.name + "-master.mp4")
        io.run(gr.master_cmd(src, P(a.mix) if a.mix else None, master, g, a.fps))
        prev = base.with_name(base.name + "-preview.mp4")
        for cc in gr.preview_cmds(master, prev, target_mb=a.preview_mb):
            io.run(cc)
        for f in Path(str(base) + "-preview-x264").parent.glob(base.name + "-preview-x264*"):
            f.unlink()
        for f in (master, prev):
            print(f"{f.name}: {io.ffprobe_duration(f):.2f}s {f.stat().st_size / 1e6:.1f} MB")
    elif c == "sheet":
        mi.contact_sheet(P(a.video), P(a.out), step=a.step, cols=a.cols, tile_w=a.tile_w, t0=a.t0, t1=a.t1)
    elif c == "strip":
        print(mi.strip(P(a.video), P(a.out), a.t0, a.t1, n=a.n))
    elif c == "loudness":
        for f in a.files:
            print(f"{Path(f).name}: {mi.loudness(P(f))}")
    elif c == "onsets":
        print(mi.voice_onsets(P(a.file), threshold_db=a.threshold, t0=a.t0, dur=a.dur))
    elif c == "lipsync":
        print(json.dumps(mi.lip_sync_lag(P(a.video), P(a.audio), a.crop, t0=a.t0, dur=a.dur, fps=a.fps), indent=2))
    elif c == "edge":
        for f in a.files:
            print(f"{Path(f).name}: {mi.edge_touch(P(f))}")
    elif c == "run-start":
        print(tl.run_start(P(a.episode), transcript=str(P(a.transcript)) if a.transcript else "", note=a.note))
    elif c == "phase":
        tl.phase(P(a.episode), a.name, end=a.end, detail=a.detail)
    elif c == "trace":
        extra = dict(kv.split("=", 1) for kv in a.set or [])
        tl.trace(P(a.episode), a.event, detail=a.detail, shot=a.shot, tag=a.tag, tool=a.tool,
                 cost_usd=a.cost, pred_id=a.pred, phase=a.phase_name, **extra)
    elif c == "ledger":
        tl.print_ledger(tl.ledger(P(a.episode), fetch=not a.offline))
    elif c == "tokens":
        e = P(a.episode) if a.episode else None
        phases = [(r["phase"], r["ts"]) for r in tl.run_events(e) if r["event"] == "phase_start"] if e else []
        files = [f for t in a.transcript for f in tr.transcript_files(P(t), not a.no_subagents)]  # a resumed run spans sessions
        u = tr.token_usage(files, a.start, a.end, phases,
                           prices_for(series_of(e) if e else None))
        print(json.dumps(u, indent=2))
    elif c == "unit-cost":
        e = P(a.episode)
        lg = tl.ledger(e, fetch=not a.offline)
        tk = tr.tokens_for_run(e, prices_for(series_of(e)), a.transcript)
        print(json.dumps(rp.unit_cost(e, ledger=lg, tokens=tk), indent=2))
    elif c == "rebuild-plan":
        res = rp.rebuild_plan(P(a.series), a.changed, prices_for(P(a.series)))
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=2))
        else:
            for t in res["tasks"]:
                gate = " [needs approval]" if t["gates"] else ""
                cost = "unpriced" if t["cost_usd"] is None else f"${t['cost_usd']:.3f}" + ("~" if t["cost_source"] == "estimate" else "")
                print(f"{t['id']:40s} {t['resource']:10s} {cost:>9s}{gate}" + (f"  after {', '.join(t['after'])}" if t["after"] else ""))
            print(f"render {res['scenes_rendered']} of {res['scenes_total']} scene(s), {res['render_seconds']} of "
                  f"{res['render_seconds_all']} s; {res['paid_tasks']} paid task(s), {len(res['unpriced'])} unpriced; nothing was run")
            for x in res["audio_without_episode"]:
                print(f"note  {x}: audio with no episode (series music?): remux each episode that uses it")
            for x in res["unreadable_edls"]:
                print(f"warn  unreadable {x}: its scene is not planned")
    elif c == "voice-direction":
        from studio import voice_direction as vd
        doc = io.load_json(P(a.manifest))
        problems = vd.check_manifest(doc)
        for x in problems:
            print(f"fail  {x}")
        if problems:
            sys.exit(f"{len(problems)} problem(s): fix the manifest before any Drama 3 line is generated")
        print("ok    every line strips back to its plain text; voices pinned")
        if a.emit_jobs:
            plan_p = P(a.emit_jobs) / "gen-plan.json"
            new = vd.jobs_from_manifest(doc)

            def merge(disk):  # adds lines not planned yet; a job already in the plan (maybe paid) is left alone
                have = {j.get("id") for j in disk.setdefault("jobs", [])}
                disk["jobs"] += [j for j in new if j["id"] not in have]
                return disk
            io.update_json_locked(plan_p, merge)
            print(f"wrote up to {len(new)} tts job(s) to {plan_p}")
    elif c == "report":
        e = P(a.episode)
        print(tr.report(e, prices_for(series_of(e)), transcript=a.transcript, fetch=not a.offline))
    elif c == "finish":
        e = P(a.episode)
        tl.trace(e, "run_end")
        scores = dict((k, float(v)) for k, v in (s.split("=", 1) for s in a.score or []))
        row = tr.finish(e, prices_for(series_of(e)), io.studio_root(a.root) if a.root else series_of(e).parent,
                        lessons=a.lesson or [], scores=scores, fetch=not a.offline)
        print(json.dumps(row, ensure_ascii=False, indent=2))
    elif c == "insights":
        print(tr.insights(io.studio_root(a.root)))


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="anime-studio.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, *args, **kw):
        p = sub.add_parser(name, help=kw.pop("help", None))
        for spec in args:
            flags, opts = spec if isinstance(spec, tuple) else ((spec,), {})
            p.add_argument(*flags, **opts)
        return p

    O = lambda *f, **o: (f, o)  # noqa: E731
    root = O("--root", help="studio root (default $ANIME_STUDIO_ROOT)")
    add("preflight", O("--project"), O("--ports", default=""), O("--json", action="store_true"), help="machine, tools, disk, load, ports")
    add("init-series", "slug", root, O("--title", default=""), O("--fps", type=int, default=24), O("--aspect", default="16:9"),
        O("--lang", default="vi"), O("--three-from"), O("--offline", action="store_true"))
    add("init-episode", "series", "ep", O("--seconds", type=float, default=15.0), O("--ceiling", type=float, default=4.0))
    add("init-scene", "episode", "scene", O("--offline", action="store_true"))
    add("init-clip", "slug", root, O("--title", default=""), O("--fps", type=int, default=24), O("--seconds", type=float, default=15.0),
        O("--ceiling", type=float, default=4.0), O("--three-from"), O("--offline", action="store_true"), help="series + ep01 + sc01 for one clip")
    add("status", "episode", O("--last", type=int, default=8), help="gates, scenes, budget, last trace events (compaction recovery)")
    add("gate", "episode", "gate", "status", O("--note", default=""))
    add("validate", O("scenes", nargs="+"))
    add("budget", "episode", O("--json", action="store_true"))
    add("voice-direction", "manifest", O("--emit-jobs", metavar="EPISODE", help="add one planned tts job per line to its gen-plan.json"),
        help="check a Drama 3 voice-direction manifest (plain vs directed text, tags, pinned voices, consent)")
    add("prompt", "episode", "job", O("--max-refs", type=int, default=3))
    add("context-pack", "episode", "scene", "shot")
    add("trim", "scene", O("--shots"), O("--handle", type=int, default=4), O("--rewrite", help="e.g. upscaled"), O("--dry-run", action="store_true"))
    add("conform", "scene", O("--shots"), O("--size", help="WxH, default EDL size"), O("--dry-run", action="store_true"))
    for n in ("build", "build-edit"):
        add(n, "scene", O("--duration", type=float), O("--lang", default="vi"))
    add("render", "scene", O("--quality", default="draft", help="draft (review) or delivery (final)"), O("--fps", type=int),
        O("--workers", type=int, help="default: preflight suggestion"), O("--out"))
    add("snapshot", "scene", "at", "out")
    add("subtitles", "episode", O("--format", default="srt", choices=["srt", "vtt"]), O("--which", default="both", choices=["spoken", "tr", "both"]),
        O("--out", help="file stem in renders/ (default: the episode name, overwritten by every export)"))
    add("concat", "episode", O("--quality", default="delivery"))
    add("grade", "src", O("--out", required=True, help="output base path"), O("--mix"), O("--episode"), O("--hits"), O("--fps", type=float, default=24),
        O("--look", default="warm"), O("--bloom", type=float, default=0.35), O("--grain", type=int, default=6), O("--preview-mb", type=float, default=25),
        O("--test", action="store_true"))
    add("sheet", "video", "out", O("--step", type=float, default=0.25), O("--cols", type=int, default=6), O("--tile-w", type=int, default=480),
        O("--t0", type=float, default=0.0), O("--t1", type=float))
    add("strip", "video", "out", O("t0", type=float), O("t1", type=float), O("--n", type=int, default=8))
    add("loudness", O("files", nargs="+"))
    add("onsets", "file", O("--threshold", type=float, default=-32.0), O("--t0", type=float, default=0.0), O("--dur", type=float))
    add("lipsync", "video", "audio", O("--crop", required=True, help="mouth box w:h:x:y in source px"), O("--t0", type=float, default=0.0),
        O("--dur", type=float), O("--fps", type=int, default=24), help="lip lag behind voice onsets, measured")
    add("edge", O("files", nargs="+"))
    add("run-start", "episode", O("--transcript"), O("--note", default=""))
    add("phase", "episode", "name", O("--end", action="store_true"), O("--detail", default=""))
    add("trace", "episode", "event", O("--detail", default=""), O("--shot"), O("--tag"), O("--tool"), O("--cost", type=float), O("--pred"),
        O("--phase-name"), O("--set", nargs="*", help="extra key=value fields"))
    add("ledger", "episode", O("--offline", action="store_true"))
    add("tokens", O("transcript", nargs="+"), O("--start", required=True), O("--end"), O("--episode"), O("--no-subagents", action="store_true"))
    add("report", "episode", O("--transcript"), O("--offline", action="store_true"))
    add("unit-cost", "episode", O("--transcript"), O("--offline", action="store_true"),
        help="spend by media/tokens/gpu/storage/people per accepted second (seconds of generated video the EDLs show)")
    add("rebuild-plan", "series", O("changed", nargs="+", help="asset ids or paths that changed"), O("--json", action="store_true"),
        help="task graph from assets impact: regenerate (needs approval), render only touched scenes, assemble, remux for audio")
    add("finish", "episode", root, O("--lesson", action="append"), O("--score", action="append", help="name=value"), O("--offline", action="store_true"))
    add("insights", root)
    pc.register(add, O)
    kf.register(add, O)
    og.register(add, O)
    ea.register(add, O)
    return ap


if __name__ == "__main__":
    try:
        cmd(parser().parse_args())
    except subprocess.CalledProcessError as e:
        sys.exit(io.redact(str(e)))
