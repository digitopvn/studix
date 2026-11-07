"""Build, render and probe the 9:16 shorts listed in data/shorts.json.

build   assemble.py --scenes a..b --tag short-<id> --ratio 9x16 --title <title> --tail 1.2 --fade 1.2
render  hyperframes render in builds/short-<id> (one at a time), then finish.py with the
        webcam from the short's first scene start and the build's own mix
probe   probe.py renders/shorts/<id>.mp4 --expect 1080x1920 --fps 30 --loudness --black

Usage: python -X utf8 shorts.py <project> build|render|probe [ids...] [--dry-run]
"""
import argparse
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import reclib  # noqa: E402

HYPERFRAMES = "hyperframes@0.8.77"
REC = Path(__file__).resolve().parent
SKILL = REC.parents[2]


def load_shorts(root, ids):
    shorts = reclib.read_json(root / "data/shorts.json")
    if not isinstance(shorts, list):
        raise reclib.StepError("shorts.json: expected a list of {id, title, scenes}")
    for s in shorts:
        if not isinstance(s, dict) or not s.get("id") or not s.get("scenes"):
            raise reclib.StepError(f"shorts.json: each short needs id and scenes ({s!r:.80})")
        s["id"] = str(s["id"])
    if ids:
        known = {s["id"] for s in shorts}
        unknown = [i for i in ids if i not in known]
        if unknown:
            raise reclib.StepError(f"unknown short id(s): {', '.join(unknown)} (known: {', '.join(sorted(known))})")
        shorts = [s for s in shorts if s["id"] in ids]
    return shorts


def scene_start(root, rng):
    """Edited start of the first scene of a range, from data/timeline.json."""
    timeline = reclib.read_json(root / "data/timeline.json")
    scenes = timeline.get("scenes") or {}
    first = rng.split("..")[0].strip()
    if first == "all":
        return 0.0
    if first in scenes:
        return float(scenes[first]["start"])
    # same id matching as assemble.py: "s012" finds "s012-plan", then any unique prefix
    hits = [sid for sid in scenes if sid.startswith(first + "-")] or [sid for sid in scenes if sid.startswith(first)]
    if len(hits) != 1:
        raise reclib.StepError(f"scene {first!r} is not in data/timeline.json; run build-timeline.py")
    return float(scenes[hits[0]]["start"])


def show(argv, cwd=None):
    print(("(cd " + shlex.quote(str(cwd)) + ") " if cwd else "") + shlex.join(str(a) for a in argv))


def execute(argv, dry, cwd=None):
    """Run one step; return True on success. Failures are reported, never raised."""
    show(argv, cwd)
    if dry:
        return True
    try:
        return subprocess.run([str(a) for a in argv], cwd=cwd).returncode == 0
    except OSError as err:
        print(f"error: {err}", file=sys.stderr)
        return False


def build(root, shorts, dry):
    bad = []
    for s in shorts:
        argv = [sys.executable, "-X", "utf8", SKILL / "scripts/assemble.py", root, "--scenes", s["scenes"], "--tag", f"short-{s['id']}",
                "--ratio", "9x16", "--tail", "1.2", "--fade", "1.2"]
        if str(s.get("title") or "").strip():  # an empty title would still draw the HUD pill
            argv += ["--title", str(s["title"]).strip()]
        if not execute(argv, dry):
            bad.append(s["id"])
    return bad


def render(root, shorts, dry):
    npx = shutil.which("npx") or "npx"
    if not dry and not shutil.which("npx"):
        raise reclib.StepError("npx not found on PATH; run scripts/doctor.py")
    out_dir = root / "renders/shorts"
    if not dry:
        out_dir.mkdir(parents=True, exist_ok=True)
    bad = []
    for s in shorts:
        sid = s["id"]
        build_dir = root / "builds" / f"short-{sid}"
        if not dry and not (build_dir / "index.html").exists():
            print(f"error: short {sid}: {build_dir} is not built; run shorts.py build {sid}", file=sys.stderr)
            bad.append(sid)
            continue
        try:
            start = scene_start(root, s["scenes"])
        except reclib.StepError as err:
            print(f"error: short {sid}: {err}", file=sys.stderr)
            bad.append(sid)
            continue
        raw = out_dir / f"{sid}-raw.mp4"
        ok = execute([npx, "--yes", HYPERFRAMES, "render", "-q", "high", "-f", "30", "--strict", "-o", raw], dry, cwd=build_dir)
        ok = ok and execute([sys.executable, "-X", "utf8", REC / "finish.py", root, "--render", raw, "--ratio", "9x16", "--from", f"{start:.3f}",
                             "--audio", build_dir / "assets/audio/mix.m4a", "-o", out_dir / f"{sid}.mp4"], dry)
        if not ok:
            bad.append(sid)
    return bad


def probe(root, shorts, dry):
    script = SKILL / "scripts/probe.py"
    if not dry and not script.exists():
        raise reclib.StepError(f"missing {script}")
    bad, missing = [], []
    for s in shorts:
        argv = [sys.executable, "-X", "utf8", script, root / "renders/shorts" / f"{s['id']}.mp4", "--expect", "1080x1920", "--fps", "30", "--loudness", "--black"]
        show(argv)
        if dry:
            continue
        try:
            code = subprocess.run([str(a) for a in argv]).returncode
        except OSError as err:
            print(f"error: {err}", file=sys.stderr)
            code = 1
        if code == 2:
            missing.append(s["id"])
        elif code != 0:
            bad.append(s["id"])
    return bad, missing


def main():
    ap = argparse.ArgumentParser(description="Build, render and probe the 9:16 shorts of data/shorts.json.")
    ap.add_argument("project", help="project directory")
    ap.add_argument("action", choices=["build", "render", "probe"])
    ap.add_argument("ids", nargs="*", help="short ids (default: all)")
    ap.add_argument("--dry-run", action="store_true", help="print the commands instead of running them")
    args = ap.parse_args()
    root = reclib.project_dir(args.project)
    shorts = load_shorts(root, args.ids)
    if not shorts:
        print("shorts.json lists no shorts")
        return 0
    missing = []
    if args.action == "build":
        bad = build(root, shorts, args.dry_run)
    elif args.action == "render":
        bad = render(root, shorts, args.dry_run)
    else:
        bad, missing = probe(root, shorts, args.dry_run)
    if args.dry_run:
        return 0
    ok = len(shorts) - len(bad) - len(missing)
    print(f"shorts {args.action}: {ok}/{len(shorts)} ok"
          + (f", failed {', '.join(bad)}" if bad else "") + (f", not rendered {', '.join(missing)}" if missing else ""))
    return 1 if bad else (2 if missing else 0)


if __name__ == "__main__":
    reclib.main_guard(main)
