#!/usr/bin/env python3
"""Audit that ratio-edition edits never change the 16:9 master.

Adding a 1:1 or 9:16 edition must only add ratio-scoped overrides to the master:
CSS rules whose every selector starts with html[data-ratio="..."] and JS changes
inside a block gated on the ratio flag. This script diffs the working tree
against a git ref (default HEAD) and reports every change that can alter the
16:9 render. Run it before every commit that touches ratio overrides.

Rules
  css-unscoped  an added or changed CSS rule has a selector that is not ratio-scoped
  css-removed   a line of a master (non-ratio) CSS rule was removed or changed
  css-at-rule   an existing @-rule changed, or an unscoped @-statement was added
  js-ungated    an added, changed or removed JS line is not inside a ratio gate
  markup        HTML outside <style>/<script> changed (warning; error with --strict)

Files: index.html, scenes/*.scene.html and legacy scenes/*.css|*.js, or --file.
The injected TIMING block (/*TIMING:BEGIN*/ ... /*TIMING:END*/) is ignored.
CR-only (CRLF vs LF) differences are ignored.

Usage:
  python audit-ratio-scope.py <project> [--base REF] [--file PATH ...] [--ratio 9x16|1x1|any] [--json]
  python audit-ratio-scope.py <project> --before OLD --after NEW [--before OLD2 --after NEW2 ...]
Exit 0 when clean, 1 on violations or errors. Standard library only.
"""
import argparse
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

GROUP_AT = {"media", "supports", "container", "layer", "document", "scope"}
DEFAULT_GATE = (
    r"\bRATIO\s*===?\s*[\"'](?!16x9)[0-9]+x[0-9]+[\"']"
    r"|[\"'](?!16x9)[0-9]+x[0-9]+[\"']\s*===?\s*RATIO\b"
    r"|document\.documentElement\.dataset\.ratio"
    r"|\bisRatio\("
)
HINT = (
    'hint: scope CSS with html[data-ratio="<ratio>"] selectors and gate JS with '
    'if (RATIO === "<ratio>") { ... }; this audit is a required step before commit.'
)
TIMING = re.compile(r"/\*TIMING:BEGIN\*/.*?/\*TIMING:END\*/", re.S)
BLOCK_TAG = re.compile(r"(<(style|script)\b[^>]*>)(.*?)(</\2\s*>)", re.S | re.I)
BARE_TAG = re.compile(r"</?(?:style|script)\s*>", re.I)


class AuditError(Exception):
    pass


# ---------------------------------------------------------------- text helpers

def blank(text, a, b):
    """Replace text[a:b] with spaces, keeping newlines so offsets and lines stay put."""
    return text[:a] + re.sub(r"[^\n]", " ", text[a:b]) + text[b:]


def strip_comments(text, js):
    """Return (no_comments, code_only): comments blanked; code_only also blanks strings."""
    out, code = list(text), list(text)
    i, n = 0, len(text)

    def fill(arr, a, b):
        for k in range(a, b):
            if arr[k] != "\n":
                arr[k] = " "

    while i < n:
        c = text[i]
        if c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            fill(out, i, j)
            fill(code, i, j)
            i = j
        elif js and c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            fill(out, i, j)
            fill(code, i, j)
            i = j
        elif c in "\"'" or (js and c == "`"):
            j = i + 1
            while j < n and text[j] != c:
                if text[j] == "\\":
                    j += 1
                elif text[j] == "\n" and c != "`":
                    break
                j += 1
            j = min(n, j + 1)
            fill(code, i + 1, j - 1)
            i = j
        else:
            i += 1
    return "".join(out), "".join(code)


def line_starts(text):
    starts = [0]
    for m in re.finditer("\n", text):
        starts.append(m.end())
    return starts


def regions(text, suffix):
    """[(start, end, kind)] covering the file; kind is css, js, markup or ignore."""
    if suffix == ".css":
        return [(0, len(text), "css")]
    if suffix == ".js":
        spans = [(0, len(text), "js")]
    else:
        spans, pos = [], 0
        for m in BLOCK_TAG.finditer(text):
            spans.append((pos, m.start(3), "markup"))
            kind = "css" if m.group(2).lower() == "style" else "js"
            spans.append((m.start(3), m.end(3), kind))
            pos = m.end(3)
        spans.append((pos, len(text), "markup"))
    out = []
    for a, b, kind in spans:  # carve TIMING out of JS
        if kind != "js":
            out.append((a, b, kind))
            continue
        cur = a
        for m in TIMING.finditer(text, a, b):
            out.append((cur, m.start(), "js"))
            out.append((m.start(), m.end(), "ignore"))
            cur = m.end()
        out.append((cur, b, "js"))
    return [r for r in out if r[1] > r[0]]


# ---------------------------------------------------------------- CSS parsing

class Item:
    def __init__(self, kind, start, end, prelude, children=None):
        self.kind, self.start, self.end = kind, start, end
        self.prelude = " ".join(prelude.split())
        self.children = children or []


def _scan(text, i, end, stops):
    depth = 0
    while i < end:
        c = text[i]
        if c in "\"'":
            j = text.find(c, i + 1, end)
            i = end if j < 0 else j + 1
            continue
        if c in "([":
            depth += 1
        elif c in ")]":
            depth = max(0, depth - 1)
        elif depth == 0 and c in stops:
            return i
        i += 1
    return end


def _match_brace(text, i, end):
    depth = 0
    while i < end:
        c = text[i]
        if c in "\"'":
            j = text.find(c, i + 1, end)
            i = end if j < 0 else j + 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return end - 1


def parse_css(text, i, end, nested=False):
    """Parse rules in text[i:end] (comments already blanked). Returns (items, stop)."""
    items = []
    while i < end:
        while i < end and text[i].isspace():
            i += 1
        if i >= end:
            break
        if text[i] == "}":
            if nested:
                return items, i
            items.append(Item("stray", i, i + 1, "}"))
            i += 1
            continue
        j = _scan(text, i, end, "{};")
        prelude = text[i:j]
        if j >= end or text[j] == "}":
            items.append(Item("stray", i, j, prelude))
            i = j
            continue
        if text[j] == ";":
            items.append(Item("statement", i, j + 1, prelude))
            i = j + 1
            continue
        name = re.match(r"\s*@([\w-]+)", prelude)
        if name and name.group(1).lower() in GROUP_AT:
            children, k = parse_css(text, j + 1, end, nested=True)
            items.append(Item("group", i, min(end, k + 1), prelude, children))
            i = k + 1
        else:
            k = _match_brace(text, j, end)
            items.append(Item("at" if name else "rule", i, k + 1, prelude))
            i = k + 1
    return items, end


def split_selectors(prelude):
    parts, depth, cur = [], 0, ""
    for c in prelude:
        if c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        if c == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += c
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def scope_regex(ratio):
    value = r"(?!16x9\b)[^\"'\]\s]+" if ratio == "any" else re.escape(ratio)
    return re.compile(r"^html\[data-ratio=([\"']?)" + value + r"\1\]")


def scoped(item, rx):
    if item.kind == "rule":
        sels = split_selectors(item.prelude)
        return bool(sels) and all(rx.match(s) for s in sels)
    if item.kind == "group":
        return bool(item.children) and all(scoped(c, rx) for c in item.children)
    return False


def innermost(items, o):
    for it in items:
        if it.start <= o < it.end:
            if it.kind == "group":
                inner = innermost(it.children, o)
                return inner or it
            return it
    return None


def flatten(items):
    for it in items:
        yield it
        yield from flatten(it.children)


# ---------------------------------------------------------------- JS gating

def js_blocks(code, a, b):
    """Brace blocks [(open, close)] inside code[a:b] (strings/comments already blanked)."""
    stack, blocks = [], []
    for k in range(a, b):
        c = code[k]
        if c == "{":
            stack.append(k)
        elif c == "}" and stack:
            blocks.append((stack.pop(), k))
    blocks.extend((o, b) for o in stack)
    return blocks


def block_header(code, nocom, open_pos, region_start):
    q = open_pos - 1
    while q >= region_start and code[q] not in ";{}":
        q -= 1
    return nocom[q + 1:open_pos]


# ---------------------------------------------------------------- per-file view

class View:
    """One version of a file with its regions, CSS items and JS blocks."""

    def __init__(self, text, suffix):
        self.text = text
        self.starts = line_starts(text)
        self.regions = regions(text, suffix)
        self.nocom = text
        self.code = text
        self.css_items = []
        self.js = []  # (start, end, blocks)
        for a, b, kind in self.regions:
            if kind == "css":
                nc, _ = strip_comments(text[a:b], js=False)
                self.nocom = self.nocom[:a] + nc + self.nocom[b:]
                self.code = self.code[:a] + nc + self.code[b:]
                self.css_items.extend(parse_css(self.nocom, a, b)[0])
            elif kind == "js":
                nc, cd = strip_comments(text[a:b], js=True)
                self.nocom = self.nocom[:a] + nc + self.nocom[b:]
                self.code = self.code[:a] + cd + self.code[b:]
        for a, b, kind in self.regions:
            if kind == "js":
                self.js.append((a, b, js_blocks(self.code, a, b)))

    def line_span(self, ln):
        a = self.starts[ln - 1] if ln - 1 < len(self.starts) else len(self.text)
        b = self.starts[ln] - 1 if ln < len(self.starts) else len(self.text)
        return a, b

    def segments(self, ln):
        """[(kind, a, b)] parts of line ln (1-based) by region kind."""
        la, lb = self.line_span(ln)
        out = []
        for a, b, kind in self.regions:
            s, e = max(a, la), min(b, lb)
            if s < e:
                out.append((kind, s, e))
        return out

    def gated(self, a, b, gate):
        if gate.search(self.nocom[a:b]):
            return True
        first = next((k for k in range(a, b) if not self.code[k].isspace()), a)
        for ra, rb, blocks in self.js:
            if not ra <= first < rb:
                continue
            for o, c in blocks:
                if o < first <= c and gate.search(block_header(self.code, self.nocom, o, ra)):
                    return True
        return False


# ---------------------------------------------------------------- diff sources

def git(cwd, *args, check=True):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True)
    if check and r.returncode != 0:
        msg = r.stderr.decode("utf-8", "replace").strip().splitlines()
        raise AuditError(f"git {' '.join(args[:2])}: {msg[-1] if msg else 'failed'}")
    return r


def norm(data):
    return data.decode("utf-8", "replace").replace("\r\n", "\n")


HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def parse_hunks(diff):
    removed, added = [], []
    old = new = 0
    in_hunk = False
    for line in diff.split("\n"):
        m = HUNK.match(line)
        if m:
            old, new, in_hunk = int(m.group(1)), int(m.group(3)), True
            # -U0 reports an empty side as "-N,0": the hunk starts after line N
            old += 1 if m.group(2) == "0" else 0
            new += 1 if m.group(4) == "0" else 0
            continue
        if line.startswith("diff --git"):
            in_hunk = False
        if not in_hunk:
            continue
        if line.startswith("-"):
            removed.append(old)
            old += 1
        elif line.startswith("+"):
            added.append(new)
            new += 1
    return removed, added


def difflib_lines(old, new):
    removed, added = [], []
    a, b = old.split("\n"), new.split("\n")
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed.extend(range(i1 + 1, i2 + 1))
        if tag in ("replace", "insert"):
            added.extend(range(j1 + 1, j2 + 1))
    return removed, added


def default_files(project, base):
    found = {"index.html"} if (project / "index.html").is_file() else set()
    for pat in ("scenes/*.scene.html", "scenes/*.css", "scenes/*.js"):
        found.update(p.relative_to(project).as_posix() for p in project.glob(pat))
    if base:
        r = git(project, "ls-tree", "-r", "--name-only", base, "--", "index.html", "scenes", check=False)
        for name in norm(r.stdout).splitlines():
            if name == "index.html" or re.fullmatch(r"scenes/[^/]+(\.scene\.html|\.css|\.js)", name):
                found.add(name)
    return sorted(found)


def git_changes(project, base, files):
    if git(project, "rev-parse", "--is-inside-work-tree", check=False).returncode != 0:
        raise AuditError(f"{project} is not inside a git work tree; pass --before OLD --after NEW pairs")
    if git(project, "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}", check=False).returncode != 0:
        raise AuditError(f"git ref {base!r} does not name a commit")
    out = []
    for rel in files or default_files(project, base):
        path = project / rel
        in_ref = git(project, "cat-file", "-e", f"{base}:./{rel}", check=False).returncode == 0
        old = norm(git(project, "show", f"{base}:./{rel}").stdout) if in_ref else ""
        new = norm(path.read_bytes()) if path.is_file() else ""
        if not in_ref and not path.is_file():
            raise AuditError(f"{rel}: not found in the working tree or at {base}")
        if in_ref and path.is_file():
            diff = git(project, "diff", "--no-color", "--ignore-cr-at-eol", "-U0", base, "--", rel).stdout
            removed, added = parse_hunks(norm(diff))
        else:
            removed, added = difflib_lines(old, new)
        out.append((rel, old, new, removed, added))
    return out


def pair_changes(project, befores, afters):
    if len(befores) != len(afters):
        raise AuditError("--before and --after must be given in pairs")
    out = []
    for b, a in zip(befores, afters):
        bp, ap = Path(b), Path(a)
        for p in (bp, ap):
            if not p.is_file():
                raise AuditError(f"{p}: file not found")
        old, new = norm(bp.read_bytes()), norm(ap.read_bytes())
        try:
            label = ap.resolve().relative_to(project.resolve()).as_posix()
        except ValueError:
            label = str(ap)
        old = old.replace("\r", "")
        new = new.replace("\r", "")
        out.append((label, old, new, *difflib_lines(old, new)))
    return out


# ---------------------------------------------------------------- audit

def audit_file(label, old, new, removed, added, rx, gate, strict):
    suffix = ".css" if label.endswith(".css") else ".js" if label.endswith(".js") else ".html"
    views = {"old": View(old, suffix), "new": View(new, suffix)}
    viol, warn = [], []
    seen = set()
    markup = {"old": [], "new": []}

    for side, lines in (("new", added), ("old", removed)):
        v, other = views[side], views["old" if side == "new" else "new"]
        for ln in lines:
            for kind, a, b in v.segments(ln):
                if kind == "ignore":
                    continue
                if kind == "markup":
                    if BARE_TAG.sub("", v.text[a:b]).strip():
                        markup[side].append(ln)
                    continue
                if not v.nocom[a:b].strip():
                    continue  # whitespace or comment only
                if kind == "js":
                    if not v.gated(a, b, gate):
                        what = "adds/changes" if side == "new" else "removes"
                        where = "" if side == "new" else " (line at base)"
                        viol.append((label, ln, "js-ungated", f"{what} JS outside a ratio gate{where}: {v.text[a:b].strip()[:80]}"))
                    continue
                for o in range(a, b):
                    if v.nocom[o].isspace():
                        continue
                    it = innermost(v.css_items, o)
                    key = (side, id(it))
                    if key in seen:
                        continue
                    seen.add(key)
                    msg = css_finding(it, side, rx, other)
                    if msg:
                        viol.append((label, ln, *msg))

    for side, lines in markup.items():
        for a, b in ranges(lines):
            where = f"{a}" if a == b else f"{a}-{b}"
            what = "added/changed" if side == "new" else "removed at base"
            entry = (label, where, "markup", f"HTML structure {what}; check the 16:9 render")
            (viol if strict else warn).append(entry)
    return viol, warn


def css_finding(it, side, rx, other):
    if it is None:
        return ("css-unscoped", "CSS text outside any rule changed")
    sel = it.prelude[:80]
    if it.kind in ("rule", "group"):
        if scoped(it, rx):
            return None
        if side == "new":
            return ("css-unscoped", f"rule `{sel}` is not scoped to html[data-ratio=...]")
        return ("css-removed", f"removes or changes master rule `{sel}` (line at base)")
    if it.kind == "at":
        exists = any(o.kind == "at" and o.prelude == it.prelude for o in flatten(other.css_items))
        if side == "new" and not exists:
            return None  # a new @keyframes / @font-face name cannot change the master
        return ("css-at-rule", f"changes existing `{sel}`")
    return ("css-at-rule", f"unscoped CSS statement `{sel}` changed")


def ranges(lines):
    out = []
    for ln in sorted(set(lines)):
        if out and ln == out[-1][1] + 1:
            out[-1][1] = ln
        else:
            out.append([ln, ln])
    return out


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], epilog=__doc__.split("\n\n", 1)[1],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", nargs="?", default=".", help="master project directory (default .)")
    ap.add_argument("--base", default="HEAD", help="git ref to diff against (default HEAD)")
    ap.add_argument("--file", action="append", default=[], help="file to audit, relative to the project (repeatable)")
    ap.add_argument("--ratio", default="any", choices=["9x16", "1x1", "any"], help="ratio the scoped rules must target (default any non-16x9)")
    ap.add_argument("--gate", help="extra regex that marks a JS ratio gate")
    ap.add_argument("--before", action="append", default=[], help="old file (no git; pair with --after)")
    ap.add_argument("--after", action="append", default=[], help="new file (no git; pair with --before)")
    ap.add_argument("--strict", action="store_true", help="treat markup changes as violations")
    ap.add_argument("--json", action="store_true", help="print a JSON report")
    args = ap.parse_args(argv)

    project = Path(args.project)
    try:
        if not project.is_dir():
            raise AuditError(f"{project}: not a directory")
        gate_src = DEFAULT_GATE + (f"|(?:{args.gate})" if args.gate else "")
        try:
            gate = re.compile(gate_src)
        except re.error as e:
            raise AuditError(f"--gate is not a valid regex: {e}") from None
        if args.before or args.after:
            changes = pair_changes(project, args.before, args.after)
        else:
            changes = git_changes(project, args.base, args.file)
        if not changes:
            raise AuditError(f"{project}: no index.html or scenes/*.scene.html to audit")
    except (AuditError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    rx = scope_regex(args.ratio)
    viol, warn = [], []
    for ch in changes:
        v, w = audit_file(*ch, rx, gate, args.strict)
        viol += v
        warn += w

    ok = not viol
    if args.json:
        fmt = lambda rows: [{"file": f, "line": ln, "rule": r, "message": m} for f, ln, r, m in rows]  # noqa: E731
        print(json.dumps({"project": str(project), "base": None if args.before else args.base, "ratio": args.ratio,
                          "files": [c[0] for c in changes], "violations": fmt(viol), "warnings": fmt(warn),
                          "ok": ok}, indent=2))
    else:
        for f, ln, r, m in viol:
            print(f"{f}:{ln} {r} {m}")
        for f, ln, r, m in warn:
            print(f"{f}:{ln} warning {r} {m}")
        print(f"audit-ratio-scope: {len(changes)} files, {len(viol)} violations, {len(warn)} warnings · {'OK' if ok else 'FAIL'}")
        if not ok:
            print(HINT)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
