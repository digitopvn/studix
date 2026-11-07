#!/usr/bin/env python3
"""Query a project's timeline compactly, so scene builders need not read timeline.json.

Reads <project>/data/timeline.json (TIMING shape) and, when present,
data/parts.json [{tag, scenes:"a..b"}] and data/shorts.json [{id, title, scenes:"a..b"}].
Scene ids accept a unique prefix (s012 for s012-plan). Times are seconds.
Standard library only.

Usage:
  python -X utf8 tl.py <project> list
  python -X utf8 tl.py <project> scene <sid>
  python -X utf8 tl.py <project> words <sid> <regex>
  python -X utf8 tl.py <project> short <id>
  python -X utf8 tl.py <project> part <tag>
"""
import argparse
import difflib
import json
import os
import re
import sys
from pathlib import Path


class TlError(Exception):
    pass


def utf8_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def read_json(path, required=True):
    path = Path(path)
    if not path.is_file():
        if required:
            raise TlError(f"missing {path}")
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise TlError(f"{path}: invalid JSON ({e})") from e


def load_scenes(timeline_path):
    """Scenes of a timeline.json as an ordered {id: scene} dict (by start time)."""
    data = read_json(timeline_path)
    scenes = data.get("scenes") if isinstance(data, dict) else None
    if not isinstance(scenes, dict) or not scenes:
        raise TlError(f"{timeline_path}: no scenes{{}} object")
    for sid, sc in scenes.items():
        if not isinstance(sc, dict) or not all(isinstance(sc.get(k), (int, float)) for k in ("start", "end")):
            raise TlError(f"{timeline_path}: scene {sid} needs numeric start and end")
    order = sorted(scenes, key=lambda s: (scenes[s]["start"], scenes[s]["end"]))
    return {sid: scenes[sid] for sid in order}


def resolve(sid, ids):
    """Exact id or a unique prefix; errors name the closest ids."""
    if sid in ids:
        return sid
    hits = [i for i in ids if i.startswith(sid)]
    if len(hits) == 1:
        return hits[0]
    if hits:
        raise TlError(f"scene '{sid}' is ambiguous: {', '.join(hits[:8])}")
    near = difflib.get_close_matches(sid, list(ids), n=5, cutoff=0.4)
    tail = f"; near: {', '.join(near)}" if near else ""
    raise TlError(f"unknown scene '{sid}'{tail}")


def scene_range(spec, ids):
    """'a..b' (inclusive, in order), 'all', or one id -> list of scene ids."""
    ids = list(ids)
    spec = (spec or "all").strip()
    if spec == "all":
        return ids
    a, sep, b = spec.partition("..")
    first = resolve(a.strip(), ids)
    last = resolve(b.strip(), ids) if sep else first
    i, j = ids.index(first), ids.index(last)
    if j < i:
        raise TlError(f"range {spec}: {last} comes before {first}")
    return ids[i:j + 1]


def window(scenes, ids):
    return scenes[ids[0]]["start"], scenes[ids[-1]]["end"]


def fmt(t):
    return f"{t:.2f}"


def span(a, b):
    return f"{fmt(a)}-{fmt(b)}"


class Project:
    def __init__(self, root):
        self.root = Path(root)
        if not self.root.is_dir():
            raise TlError(f"project directory not found: {self.root}")
        self.scenes = load_scenes(self.root / "data/timeline.json")
        self.parts = self._groups("parts.json", "tag")
        self.shorts = self._groups("shorts.json", "id")

    def _groups(self, name, key):
        data = read_json(self.root / "data" / name, required=False)
        if data is None:
            return []
        if not isinstance(data, list) or not all(isinstance(g, dict) and key in g for g in data):
            raise TlError(f"data/{name}: expected a list of objects with '{key}'")
        out = []
        for g in data:
            try:
                ids = scene_range(g.get("scenes"), self.scenes)
            except TlError as e:
                raise TlError(f"data/{name} {key}={g[key]}: {e}") from e
            out.append(dict(g, ids=ids))
        return out

    def part_of(self, sid):
        return next((p for p in self.parts if sid in p["ids"]), None)

    def group(self, groups, key, value, label):
        for g in groups:
            if str(g[key]) == value:
                return g
        known = ", ".join(str(g[key]) for g in groups) or "none defined"
        raise TlError(f"unknown {label} '{value}' (known: {known})")


def cmd_list(p):
    rows = []
    for sid, sc in p.scenes.items():
        part = p.part_of(sid)
        tag = f"  {part['tag']}" if part else ""
        rows.append(f"{sid}  {span(sc['start'], sc['end'])}  {sc['end'] - sc['start']:.2f}s{tag}")
    start, end = window(p.scenes, list(p.scenes))
    rows.append(f"{len(p.scenes)} scenes  {span(start, end)}")
    return rows


def cmd_scene(p, sid):
    sid = resolve(sid, p.scenes)
    sc = p.scenes[sid]
    head = f"{sid}  {span(sc['start'], sc['end'])} ({sc['end'] - sc['start']:.2f}s)"
    part = p.part_of(sid)
    if part:
        p0 = window(p.scenes, part["ids"])[0]
        head += f"  part {part['tag']} rel {span(sc['start'] - p0, sc['end'] - p0)}"
    rows = [head]
    ids = list(p.scenes)
    i = ids.index(sid)
    nb = []
    if i > 0:
        nb.append(f"prev {ids[i - 1]} {span(p.scenes[ids[i - 1]]['start'], p.scenes[ids[i - 1]]['end'])}")
    if i + 1 < len(ids):
        nb.append(f"next {ids[i + 1]} {span(p.scenes[ids[i + 1]]['start'], p.scenes[ids[i + 1]]['end'])}")
    if nb:
        rows.append(" | ".join(nb))
    for n, line in enumerate(sc.get("lines") or [], 1):
        words = " ".join(f"{w[0]}@{fmt(w[1])}" for w in line.get("words") or [] if len(w) >= 2)
        rows.append(f"L{n} {span(line.get('on', 0), line.get('off', 0))}: {words}")
    return rows


def cmd_words(p, sid, pattern):
    sid = resolve(sid, p.scenes)
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        raise TlError(f"bad regex '{pattern}': {e}") from e
    sc = p.scenes[sid]
    seen, rows = {}, []
    for line in sc.get("lines") or []:
        for w in line.get("words") or []:
            if len(w) < 3:
                continue
            word = str(w[0])
            seen[word] = seen.get(word, 0) + 1
            if rx.search(word):
                nth = seen[word]
                rows.append(f"{word} #{nth}  {span(w[1], w[2])}  rel {fmt(w[1] - sc['start'])}  "
                            f"W(\"{sid}\",\"{word}\",{nth})")
    if not rows:
        raise TlError(f"no word in {sid} matches /{pattern}/")
    return rows


def group_rows(p, g, label):
    ids = g["ids"]
    start, end = window(p.scenes, ids)
    title = f"  \"{g['title']}\"" if g.get("title") else ""
    rows = [f"{label} {span(start, end)} ({end - start:.2f}s)  {ids[0]}..{ids[-1]} ({len(ids)} scenes){title}"]
    for sid in ids:
        sc = p.scenes[sid]
        rows.append(f"  {sid}  rel {span(sc['start'] - start, sc['end'] - start)}  abs {span(sc['start'], sc['end'])}")
    return rows


def main(argv=None):
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("project", help="project directory (holds data/timeline.json)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="one line per scene: id, window, length, part")
    s = sub.add_parser("scene", help="window, lines with word times, neighbours")
    s.add_argument("sid")
    w = sub.add_parser("words", help="words matching a regex (case-insensitive) with W() lookups")
    w.add_argument("sid")
    w.add_argument("regex")
    sh = sub.add_parser("short", help="a short's window and per-scene relative windows")
    sh.add_argument("id")
    pt = sub.add_parser("part", help="a part's window and per-scene relative windows")
    pt.add_argument("tag")
    a = ap.parse_args(argv)
    try:
        p = Project(a.project)
        if a.cmd == "list":
            rows = cmd_list(p)
        elif a.cmd == "scene":
            rows = cmd_scene(p, a.sid)
        elif a.cmd == "words":
            rows = cmd_words(p, a.sid, a.regex)
        elif a.cmd == "short":
            rows = group_rows(p, p.group(p.shorts, "id", a.id, "short"), f"short {a.id}")
        else:
            rows = group_rows(p, p.group(p.parts, "tag", a.tag, "part"), f"part {a.tag}")
    except TlError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    try:
        print("\n".join(rows))
        sys.stdout.flush()
    except BrokenPipeError:  # piped into head: stop quietly
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
    return 0


if __name__ == "__main__":
    sys.exit(main())
