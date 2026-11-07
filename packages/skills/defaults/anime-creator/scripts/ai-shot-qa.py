#!/usr/bin/env python3
"""Context-aware AI sound QA: short shot-group clips of an assembled episode, each judged with its beat and dialogue.

usage: ai-shot-qa.py <episode-dir> <episode.mp4> --tag "{sc}-cut3-r1" [--scenes sc01,sc02] [--engine NAME]
                     [--rubric shot-sound] [--max-len 9] [--workers 6] [--out DIR] [--collect] [--dry-run]
Cuts the episode into clips of whole shots (each scene's edl.json, at most --max-len seconds), and sends every clip
(picture and the final mix) with its shots' beats and intended lines to the `ai-judge` role of engines.json (default
gemini-analyze), in parallel. The prompt is the `## <rubric>` section of assets/templates/qa-prompts.md. Scene offsets
in the episode come from the durations of renders/<tag>-master-720p.mp4, so pass the tag the episode was joined from.
Results: one <clip>.json per clip (rerun reuses them, --collect only re-reads), summary.json, and the issues sorted by
episode time. An issue within --edge seconds of a clip boundary is marked `edge`: the judge saw a sound cut off by the
clip, not by the film. Every finding is a lead: listen at that time before changing the mix; an AI judge has
reported missing or mistimed sounds that were present and in sync.
An aesthetic scorer (role `audio-aesthetic`) cannot replace this: it rates an asset's quality, not whether it fits
the shot; use it only to compare two versions of one asset.
Supported: Windows, macOS, Linux. Needs ffmpeg, ffprobe and the judge's CLI.
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402
from studio import engine_routing as er  # noqa: E402
from studio import multix_job_commands as mj  # noqa: E402

PROMPTS = io.TEMPLATES / "qa-prompts.md"


def shot_groups(shots: list[dict], max_len: float) -> list[list[dict]]:
    """Consecutive whole shots, each group at most max_len long (a longer single shot stays alone)."""
    out, cur = [], []
    for s in shots:
        if cur and s["end"] - cur[0]["start"] > max_len:
            out.append(cur)
            cur = []
        cur.append(s)
    return out + ([cur] if cur else [])


def mmss(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:05.2f}"


def fill_prompt(rubric: str, sc: str, ep_t0: float, group: list[dict]) -> str:
    t0 = group[0]["start"]
    shots = "\n".join(f"- {s['id']} {s['start'] - t0:.2f}-{s['end'] - t0:.2f}s: {s.get('beat') or s.get('brief') or ''}"
                      for s in group)
    lines = "\n".join(f"- {d.get('speaker')} {d.get('t0', s['start']) - t0:.2f}s: {d.get('text')}"
                      for s in group for d in s.get("dialogue") or []) or "- (none)"
    return (rubric.replace("{{EP_T}}", mmss(ep_t0)).replace("{{SCENE}}", sc)
            .replace("{{SHOTS}}", shots).replace("{{LINES}}", lines))


def mark_edges(result: dict, edge: float) -> dict:
    for i in result.get("issues") or []:
        try:
            t = float(i.get("t", 0))
        except (TypeError, ValueError):
            continue
        i["edge"] = t < edge or t > result.get("len", 0) - edge
    return result


def issues_by_time(results: list[dict]) -> list[tuple[float, str, dict]]:
    rows = []
    for r in results:
        for i in r.get("issues") or []:
            try:
                rows.append((r["ep_t0"] + float(i.get("t", 0)), r["id"], i))
            except (TypeError, ValueError):
                continue
    return sorted(rows, key=lambda x: x[0])


def judge(job: dict, adapter: dict, edge: float) -> dict:
    if job["out"].exists():
        return json.loads(job["out"].read_text(encoding="utf-8"))
    if not job["clip"].exists():
        io.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{job['t0']:.3f}", "-t", f"{job['len']:.3f}", "-i", job["src"],
                "-vf", "scale=854:-2", "-c:v", "libx264", "-crf", "26", "-preset", "veryfast",
                "-c:a", "aac", "-b:a", "160k", str(job["clip"])])
    try:
        res = er.run_cli(adapter, clip=str(job["clip"]), prompt=job["prompt"], timeout=900)
        res = res if isinstance(res, dict) else {"error": "reply was not a JSON object", "raw": str(res)[-600:]}
    except (RuntimeError, OSError) as e:
        res = {"error": str(e)[-600:]}
    res.update({"id": job["id"], "scene": job["scene"], "ep_t0": round(job["t0"], 2), "len": round(job["len"], 2)})
    mark_edges(res, edge)
    if "error" not in res:  # failed calls are retried by the next run
        job["out"].write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return res


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("episode", type=Path)
    ap.add_argument("src", help="the assembled episode (720p master is enough)")
    ap.add_argument("--tag", required=True, help='scene render tag the episode was joined from, e.g. "{sc}-cut3-r1"')
    ap.add_argument("--scenes", help="comma list in episode order (default: episode.json scenes)")
    ap.add_argument("--only", help="comma list of scenes to judge (offsets still use every scene)")
    ap.add_argument("--engine", help="ai-judge adapter in engines.json")
    ap.add_argument("--rubric", default="shot-sound", help="section of assets/templates/qa-prompts.md")
    ap.add_argument("--max-len", type=float, default=9.0)
    ap.add_argument("--edge", type=float, default=0.4, help="seconds from a clip boundary that mark an issue `edge`")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--out", type=Path, help="default: <episode>/qa/<rubric>/<episode file stem>")
    ap.add_argument("--collect", action="store_true", help="only re-read saved results; no new calls")
    ap.add_argument("--dry-run", action="store_true", help="print the clips and the first prompt; no calls")
    a = ap.parse_args()
    ep = a.episode.expanduser().resolve()
    scenes = a.scenes.split(",") if a.scenes else io.load_json(ep / "episode.json")["scenes"]
    rubric = mj.qa_prompts(PROMPTS).get(a.rubric) or sys.exit(f"no '## {a.rubric}' section in {PROMPTS}")
    _, adapter = er.pick(er.load(ep), "ai-judge", a.engine)
    out = a.out or ep / "qa" / a.rubric / Path(a.src).stem
    offs, t = {}, 0.0
    for sc in scenes:
        offs[sc] = t
        t += io.ffprobe_duration(ep / "renders" / f"{a.tag.format(sc=sc)}-master-720p.mp4")
    jobs = []
    for sc in (a.only.split(",") if a.only else scenes):
        for g in shot_groups(io.load_json(ep / "scenes" / sc / "edl.json")["shots"], a.max_len):
            jid = f"{sc}-{g[0]['id']}-{g[-1]['id']}"
            jobs.append({"id": jid, "scene": sc, "src": a.src, "t0": offs[sc] + g[0]["start"],
                         "len": g[-1]["end"] - g[0]["start"], "clip": out / f"{jid}.mp4", "out": out / f"{jid}.json",
                         "prompt": fill_prompt(rubric, sc, offs[sc] + g[0]["start"], g)})
    if a.dry_run:
        for j in jobs:
            print(f"{j['id']:20} {mmss(j['t0'])} {j['len']:.2f}s")
        print("---\n" + (jobs[0]["prompt"] if jobs else "(no clips)"))
        return 0
    out.mkdir(parents=True, exist_ok=True)
    if a.collect:
        results = [json.loads(j["out"].read_text(encoding="utf-8")) for j in jobs if j["out"].exists()]
    else:
        with ThreadPoolExecutor(a.workers) as ex:
            results = list(ex.map(lambda j: judge(j, adapter, a.edge), jobs))
    io.save_json(out / "summary.json", results)
    for r in results:
        print(f"{r['id']:20} {mmss(r['ep_t0'])} score {r.get('score')}  {str(r.get('summary', r.get('error', '')))[:110]}")
    print("--- issues by episode time (verify each by ear; `edge` = likely cut off by the clip)")
    for t, _, i in issues_by_time(results):
        print(f"{mmss(t)} [{i.get('severity')}/{i.get('category')}]{' edge' if i.get('edge') else ''} "
              f"{i.get('what')} -> {i.get('fix')}")
    failed = [r["id"] for r in results if "error" in r]
    if failed:
        print(f"{len(failed)} clip(s) failed and will be retried by the next run: {', '.join(failed)}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
