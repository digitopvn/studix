#!/usr/bin/env python3
"""Write stub scene fragments (scenes/<sid>.scene.html) for scene builders.

Each stub holds the scene's <section id="scNNN" class="scene layer"> with a
headline placeholder, a <style> block scoped under #scNNN (with an empty 9:16
override) and a <script> block with a commented choreography example keyed to
the scene's first spoken word. scripts/assemble.py splices the fragments into
the shell. Existing fragments (new or legacy scenes/<sid>.html) are never
overwritten. Standard library only.

Usage:
  python scaffold-scenes.py <project> [--scenes a..b]
Reads data/script.json (TTS scenes with lines/en, or recording scenes with
from/to/title) and data/timeline.json when present; prints one line per file.
"""
import argparse
import html as htmllib
import importlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
asm = importlib.import_module("assemble")


def section_ids(ids):
    """sc + the scene number padded to 3 (s012-plan -> sc012, s16a -> sc016a); script index when there is none."""
    out, used = {}, set()
    for i, sid in enumerate(ids, 1):
        m = re.search(r"(\d+)(?:([a-z])(?![a-z]))?", sid)
        cand = f"sc{int(m.group(1)):03d}{m.group(2) or ''}" if m else f"sc{i:03d}"
        if cand in used:
            cand = f"sc{i:03d}"
        if cand in used:
            raise asm.AssembleError(f"cannot derive a unique section id for {sid}; rename the scene ids")
        used.add(cand)
        out[sid] = cand
    return out


def norm_word(text):
    return re.sub(r"[^\w'-]", "", text.lower())


def first_word(scene, timeline):
    sc = (timeline.get("scenes") or {}).get(scene["id"]) if isinstance(timeline, dict) else None
    for line in (sc or {}).get("lines") or []:
        for w in line.get("words") or []:
            if w and isinstance(w[0], str) and w[0]:
                return w[0]
    for line in scene.get("lines") or []:
        text = (line.get("en") or line.get("say") or "") if isinstance(line, dict) else ""
        for tok in text.split():
            if norm_word(tok):
                return norm_word(tok)
    return None


def headline(scene):
    if isinstance(scene.get("title"), str) and scene["title"].strip():
        return scene["title"].strip()
    lines = scene.get("lines") or []
    if lines and isinstance(lines[0], dict) and isinstance(lines[0].get("en"), str) and lines[0]["en"].strip():
        return lines[0]["en"].strip()
    return scene["id"]


def stub(scene, sec, word):
    sid = scene["id"]
    w = json.dumps(word or "word", ensure_ascii=False)
    hint = "" if word else " (no timeline yet: replace with a spoken word)"
    return (
        f'<section id="{sec}" class="scene layer" data-sid="{sid}">\n'
        f'  <div class="abs hl" style="left: 120px; top: 380px; font-size: 96px">{htmllib.escape(headline(scene))}</div>\n'
        "</section>\n"
        "<style>\n"
        f"  #{sec} .hl {{ color: var(--ink); }}\n"
        f'  html[data-ratio="9x16"] #{sec} {{}}\n'
        "</style>\n"
        "<script>\n"
        f"  // sid = {json.dumps(sid)} is in scope; key every reveal to a spoken word{hint}:\n"
        f'  // pop("#{sec} .hl", W(sid, {w}) - 0.1);\n'
        "</script>\n"
    )


def scaffold(project, scenes="all"):
    """Return [(path, created: bool)] for the selected scenes."""
    project = Path(project).resolve()
    script = asm.script_scenes(project)
    if script is None:
        raise asm.AssembleError(f"{project / 'data/script.json'} not found")
    ids = [s["id"] for s in script]
    chosen = set(asm.select_range(scenes, ids))
    secs = section_ids(ids)
    tl_path = project / "data/timeline.json"
    timeline = asm.read_json(tl_path, "timeline") if tl_path.is_file() else {}
    out_dir = project / "scenes"
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for scene in script:
        sid = scene["id"]
        if sid not in chosen:
            continue
        path = out_dir / f"{sid}.scene.html"
        if path.exists() or (out_dir / f"{sid}.html").exists():
            results.append((path if path.exists() else out_dir / f"{sid}.html", False))
            continue
        try:
            with open(path, "x", encoding="utf-8", newline="\n") as fh:
                fh.write(stub(scene, secs[sid], first_word(scene, timeline)))
        except FileExistsError:
            results.append((path, False))
            continue
        results.append((path, True))
    return results


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("project", help="project directory (holds data/script.json)")
    ap.add_argument("--scenes", default="all", help="'all' (default) or an inclusive script-order range a..b")
    a = ap.parse_args(argv)
    try:
        results = scaffold(a.project, a.scenes)
    except (asm.AssembleError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    root = Path(a.project).resolve()
    for path, created in results:
        rel = path.relative_to(root).as_posix()
        print(f"created {rel}" if created else f"skipped {rel} (exists)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
