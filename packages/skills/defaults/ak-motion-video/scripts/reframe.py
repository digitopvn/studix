#!/usr/bin/env python3
"""Derive a 1:1 or 9:16 edition of a finished 16:9 motion-video project.

The edition reuses the master's audio, TIMING and mix; only the frame size and
the ratio flag change. Layout differences live in the master's
html[data-ratio="..."] CSS rules, so re-running this after any master change
keeps every edition in sync. Standard library only.

Usage:
  python reframe.py <project> --ratio 9x16 [--out <dir>]
Writes <project>-<ratio>/ next to the project: index.html, hyperframes.json and
hard-linked assets/ and compositions/ (copied when hard links are unavailable). Then run lint,
check, snapshot and render inside that directory as usual.
"""
import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

RATIOS = {"1x1": (1080, 1080, "square"), "9x16": (1080, 1920, "portrait")}
MARKER = ".reframe.json"
LINKED_DIRS = ("assets", "compositions")
# px values that only make sense in a 1920x1080 frame
RATIO_BLOCK = re.compile(r"html\[data-ratio=[^\]]*\][^{]*\{[^}]*\}")
HARDCODED = re.compile(r"(?<![\d.#-])(1920|1080|960|540)(?:px)?(?![\d])")


class ReframeError(Exception):
    pass


def edition_html(src, ratio):
    w, h, preset = RATIOS[ratio]
    if "window.TIMING=null" in src.replace(" ", ""):
        raise ReframeError("TIMING is not injected; run `node scripts/build-timeline.mjs` in the master first")
    out, n = re.subn(r'data-width="\d+"(\s+)data-height="\d+"', f'data-width="{w}"\\1data-height="{h}"', src, count=1)
    if n != 1:
        raise ReframeError('no root with data-width="..." data-height="..." found')
    out = re.sub(r'<meta name="viewport" content="[^"]*">', f'<meta name="viewport" content="width={w}, height={h}">', out, count=1)
    html_tag = re.search(r"<html\b[^>]*>", out)
    if not html_tag:
        raise ReframeError("no <html> tag found")
    tag = html_tag.group(0)
    tag = re.sub(r'\s(data-resolution|data-ratio)="[^"]*"', "", tag)
    tag = tag[:-1] + f' data-resolution="{preset}" data-ratio="{ratio}">'
    out = out[: html_tag.start()] + tag + out[html_tag.end():]
    size = f"<style>/*reframe*/ :root {{ --W: {w}px; --H: {h}px; }}</style>\n  </head>"
    out = out.replace("</head>", size, 1)
    return out


def lint_master(src, ratio):
    """Warnings the agent can act on without re-reading the whole composition."""
    warnings = []
    if f'data-ratio="{ratio}"' not in src:
        warnings.append(f'no html[data-ratio="{ratio}"] rules: scenes keep their 16:9 layout and will be cropped')
    if "var(--W" not in src:
        warnings.append("layout does not read --W/--H; #root and .layer stay 1920x1080 unless the CSS uses them")
    root = re.search(r'data-width="\d+"\s+data-height="\d+"', src)
    # ratio override blocks are written for the edition's frame: blank them, keeping line numbers
    scan = RATIO_BLOCK.sub(lambda m: "\n" * m.group(0).count("\n"), src)
    lines = []
    for i, line in enumerate(scan.splitlines(), 1):
        if "/*TIMING" in line or "data-ratio" in line:
            continue
        line = re.sub(r'<meta name="viewport"[^>]*>|--[WH]:\s*\d+px', "", line)
        if root:
            line = line.replace(root.group(0), "")
        if HARDCODED.search(line):
            lines.append(i)
    if lines:
        shown = ", ".join(map(str, lines[:20])) + (" ..." if len(lines) > 20 else "")
        warnings.append(f"16:9 pixel values (1920/1080/960/540) on lines {shown}; check them for {ratio}")
    return warnings


def _inside(path, parent):
    try:
        return os.path.commonpath([path, parent]) == os.path.normpath(parent)
    except ValueError:  # different drives
        return False


def link_tree(src_dir, dst_dir, guard, skipped, chain=()):
    """Hard-link src_dir into dst_dir, following symlinked folders.

    A folder is skipped (and reported) when it is on its own ancestor chain (a
    loop), lies inside the edition being written, or contains the master (a link
    up the tree would pull in the edition or other projects).
    """
    real = os.path.realpath(src_dir)
    project_real, out_real = guard
    if real in chain or _inside(real, out_real) or _inside(project_real, real):
        skipped.append(str(src_dir))
        return 0
    dst_dir.mkdir(parents=True, exist_ok=True)
    count = 0
    for entry in sorted(os.scandir(src_dir), key=lambda e: e.name):
        s, d = Path(entry.path), dst_dir / entry.name
        if entry.is_dir():
            count += link_tree(s, d, guard, skipped, chain + (real,))
            continue
        target = os.path.realpath(s)  # link the file a symlink points at, not the link
        if not os.path.isfile(target):
            skipped.append(str(s))
            continue
        try:
            os.link(target, d)
        except OSError:
            shutil.copy2(target, d)
        count += 1
    return count


def _reclaimable(out):
    """An edition directory left by a run killed before its marker landed."""
    return all(p.name == MARKER + ".tmp" for p in out.iterdir())


def read_owner(out):
    """The master recorded in an edition marker, or an error: never guess ownership."""
    try:
        meta = json.loads((out / MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as e:
        raise ReframeError(f"{out / MARKER} is unreadable ({e}); remove {out} yourself or pass --out") from e
    owner = meta.get("master") if isinstance(meta, dict) else None
    if not isinstance(owner, str) or not owner:
        raise ReframeError(f"{out / MARKER} names no master; remove {out} yourself or pass --out")
    return Path(owner).resolve()


def reframe(project, ratio, out=None):
    project = Path(project).resolve()
    index = project / "index.html"
    if not index.is_file():
        raise ReframeError(f"{index} not found")
    out = Path(out or project.parent / f"{project.name}-{ratio}").resolve()  # a linked edition dir is judged by its target
    if out == project or project in out.parents or out in project.parents:
        raise ReframeError("the edition directory must be outside the master project and must not contain it")
    if out.exists() and not (out / MARKER).is_file() and not _reclaimable(out):
        raise ReframeError(f"{out} exists and was not made by reframe.py; pass --out to choose another directory")
    if (out / MARKER).is_file():
        owner = read_owner(out)
        if owner != project:
            raise ReframeError(f"{out} is an edition of {owner}; pass --out to choose another directory")
    try:
        src = index.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        raise ReframeError(f"{index} is not UTF-8") from e
    html = edition_html(src, ratio)
    warnings = lint_master(src, ratio)
    out.mkdir(parents=True, exist_ok=True)
    # only an owned or empty edition reaches here: clear it but keep the marker until
    # the end, so a delete that fails half-way (a file held open) can simply be re-run
    for child in out.iterdir():
        if child.name != MARKER:
            shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
    tmp = out / (MARKER + ".tmp")
    tmp.write_text(json.dumps({"master": str(project), "ratio": ratio}, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, out / MARKER)
    (out / "index.html").write_text(html, encoding="utf-8", newline="\n")
    for name in ("hyperframes.json",):
        if (project / name).is_file():
            shutil.copy2(project / name, out / name)
    guard, skipped = (os.path.realpath(project), os.path.realpath(out)), []
    files = sum(link_tree(project / d, out / d, guard, skipped) for d in LINKED_DIRS if (project / d).is_dir())
    if skipped:
        warnings.append(f"skipped links that loop, point above the master or are broken: {', '.join(skipped)}")
    return out, files, warnings


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("project", help="master project directory (holds index.html)")
    ap.add_argument("--ratio", required=True, choices=sorted(RATIOS))
    ap.add_argument("--out", help="edition directory (default: <project>-<ratio> next to the project)")
    a = ap.parse_args(argv)
    try:
        out, files, warnings = reframe(a.project, a.ratio, a.out)
    except (ReframeError, OSError) as e:
        print(f"reframe: {e}", file=sys.stderr)
        return 1
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    w, h, _ = RATIOS[a.ratio]
    print(f"{a.ratio} edition ({w}x{h}): {out} ({files} asset files linked)")
    print(f"next: cd {out} && npx --yes hyperframes@0.8.77 lint && npx --yes hyperframes@0.8.77 check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
