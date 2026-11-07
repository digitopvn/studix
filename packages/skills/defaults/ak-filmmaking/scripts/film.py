#!/usr/bin/env python3
"""Deterministic tooling for a films/<slug>/ production graph (standard library only).

Usage:
  film.py init <films-dir> <slug> --title TITLE [--minutes N] [--budget low|balanced|quality]
               [--aspect 16:9] [--fps 24] [--currency USD]
  film.py validate <film-dir> [--check-media] [--json]   schema, integrity, gates, continuity
  film.py continuity <film-dir> [--json]                  continuity findings only
  film.py prompt <film-dir> <shot-id> [--json]            compiled shot prompt + input order
  film.py route <film-dir>                                render tier and capabilities per shot
  film.py coverage <film-dir>                             visible-lipsync vs off-screen dialogue
  film.py cue-sheet <film-dir>                            music cue sheet and stem inventory
  film.py timeline <film-dir> --mode animatic|final [--write]
  film.py costs <film-dir>                                estimated vs recorded spend
  film.py qc <film-dir>                                   timestamped QC failures and fix stage

Exit codes: 0 ok, 1 findings/blockers that stop the next stage, 2 usage or I/O error.
"""

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from film_checks import check_audio, check_bibles, check_media, check_scenes, check_shots  # noqa: E402
from film_continuity import check_continuity, qc_report  # noqa: E402
from film_graph import load_film  # noqa: E402
from film_prompt import compile_prompt, route  # noqa: E402
from film_reports import build_timeline, costs, cue_sheet, dialogue_coverage, ffconcat  # noqa: E402
from film_schema import SchemaSet  # noqa: E402

FILM_DIRS = [
    "bibles/characters", "bibles/locations", "bibles/props", "bibles/wardrobe", "scenes", "storyboard",
    "animatic", "audio/dialogue", "audio/alignment", "audio/ambience", "audio/sfx", "audio/music",
    "audio/stems", "renders", "qc", "final",
]
SCREENPLAY_TEMPLATE = """# {title}

<!-- Screenplay. Scene headings map 1:1 to scene IDs (S01, S02...). Dialogue lines
become DX cues in audio/cues.json once the voice direction is settled. -->

## S01 - INT./EXT. LOCATION - TIME OF DAY

Action.

CHARACTER
(direction)
Line of dialogue.
"""


class UsageError(Exception):
    pass


def cmd_init(args):
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", args.slug):
        raise UsageError(f"slug {args.slug!r} must be lowercase kebab-case (letters, digits, hyphens)")
    target = Path(args.films_dir) / args.slug
    if target.exists() and any(target.iterdir()):
        raise UsageError(f"{target} already exists and is not empty; refusing to overwrite a production")
    project = {
        "schema_version": 1, "slug": args.slug, "title": args.title, "logline": "",
        "target_duration_minutes": args.minutes, "budget_mode": args.budget, "aspect_ratio": args.aspect,
        "fps": args.fps, "currency": args.currency, "scenes": [], "animatic": {"status": "pending"},
        "style": {"visual": "Describe the film's visual language.", "negative": []},
    }
    problems = SchemaSet().validate(project, "project.schema.json")
    if problems:
        raise UsageError(f"invalid project settings: {problems[0]}")
    for rel in FILM_DIRS:
        (target / rel).mkdir(parents=True, exist_ok=True)
    (target / "project.json").write_text(json.dumps(project, indent=2) + "\n", encoding="utf-8")
    (target / "audio" / "cues.json").write_text(json.dumps({"cues": []}, indent=2) + "\n", encoding="utf-8")
    (target / "screenplay.md").write_text(SCREENPLAY_TEMPLATE.format(title=args.title), encoding="utf-8")
    film = load_film(target)
    errors = [f for f in film.findings if f.severity == "error"]
    if errors:
        raise UsageError(f"init produced an invalid project: {errors[0].message}")
    print(f"Created {target}")
    return 0


def _load(path):
    root = Path(path)
    if not root.is_dir():
        raise UsageError(f"{root} is not a directory")
    return load_film(root)


def _validated(path, check_media_files=False):
    film = _load(path)
    if film.project is not None:
        check_bibles(film)
        check_scenes(film)
        check_shots(film)
        check_audio(film)
        check_continuity(film)
        if check_media_files:
            check_media(film)
    return film


def _print_findings(findings, as_json):
    errors = sum(1 for f in findings if f.severity == "error")
    if as_json:
        print(json.dumps({"errors": errors, "warnings": len(findings) - errors,
                          "findings": [f.as_dict() for f in findings]}, indent=2))
    else:
        for f in findings:
            stamp = f" @ {f.timecode}" if f.timecode else ""
            print(f"[{f.severity.upper()}] {f.code} {f.where}{stamp}: {f.message}")
        print(f"{errors} error(s), {len(findings) - errors} warning(s)")
    return 1 if errors else 0


def cmd_validate(args):
    film = _validated(args.film, args.check_media)
    return _print_findings(film.findings, args.json)


def cmd_continuity(args):
    film = _validated(args.film)
    return _print_findings([f for f in film.findings if f.code.startswith("continuity")], args.json)


def _ready(path):
    """Reports need a structurally valid graph; refuse to derive output from broken data."""
    film = _validated(path)
    blocking = [f for f in film.findings if f.severity == "error" and f.code in ("schema", "invalid-json", "missing", "id-mismatch", "duplicate-id")]
    if film.project is None or blocking:
        _print_findings(blocking or film.findings, False)
        raise UsageError("fix the structural errors above before deriving reports")
    return film


def _emit(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0


def cmd_prompt(args):
    film = _ready(args.film)
    if args.shot_id not in film.shots:
        raise UsageError(f"shot {args.shot_id} is not in the cut")
    compiled = compile_prompt(film, args.shot_id)
    if args.json:
        return _emit(compiled)
    for slot in compiled["image_inputs"]:
        print(f"{slot['slot']}: {slot['ref_id']} ({slot['role']}, {slot['view']}) -> {slot['path']}")
    for slot in compiled["audio_inputs"]:
        print(f"{slot['slot']}: {slot['cue_id']} -> {slot['file']} (trim {slot['trim_start']}s)")
    print()
    print(compiled["prompt"])
    return 0


def cmd_timeline(args):
    film = _ready(args.film)
    timeline = build_timeline(film, args.mode, film.findings)
    if args.write and timeline["blockers"]:
        # A track list with skipped shots would silently drift against the absolute audio starts.
        print(f"error: {len(timeline['blockers'])} blocker(s); nothing written", file=sys.stderr)
    elif args.write:
        out_dir = film.root / ("animatic" if args.mode == "animatic" else "final")
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "timeline.json").write_text(json.dumps(timeline, indent=2) + "\n", encoding="utf-8")
        (out_dir / "video.ffconcat").write_text(ffconcat(film, timeline, out_dir), encoding="utf-8")
    _emit(timeline)
    return 1 if timeline["blockers"] else 0


def build_parser():
    parser = argparse.ArgumentParser(description="Production-graph tooling for long-form AI films.")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init")
    init.add_argument("films_dir")
    init.add_argument("slug")
    init.add_argument("--title", required=True)
    init.add_argument("--minutes", type=float, default=10.0)
    init.add_argument("--budget", choices=["low", "balanced", "quality"], default="balanced")
    init.add_argument("--aspect", default="16:9")
    init.add_argument("--fps", type=float, default=24.0)
    init.add_argument("--currency", default="USD")
    init.set_defaults(func=cmd_init)
    for name, func in (("validate", cmd_validate), ("continuity", cmd_continuity)):
        cmd = sub.add_parser(name)
        cmd.add_argument("film")
        cmd.add_argument("--json", action="store_true")
        if name == "validate":
            cmd.add_argument("--check-media", action="store_true")
        cmd.set_defaults(func=func)
    prompt = sub.add_parser("prompt")
    prompt.add_argument("film")
    prompt.add_argument("shot_id")
    prompt.add_argument("--json", action="store_true")
    prompt.set_defaults(func=cmd_prompt)
    timeline = sub.add_parser("timeline")
    timeline.add_argument("film")
    timeline.add_argument("--mode", choices=["animatic", "final"], required=True)
    timeline.add_argument("--write", action="store_true")
    timeline.set_defaults(func=cmd_timeline)
    for name, report in (("route", route), ("coverage", dialogue_coverage), ("cue-sheet", cue_sheet),
                         ("costs", costs), ("qc", qc_report)):
        cmd = sub.add_parser(name)
        cmd.add_argument("film")
        cmd.set_defaults(func=lambda args, _report=report: _emit(_report(_ready(args.film))))
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
