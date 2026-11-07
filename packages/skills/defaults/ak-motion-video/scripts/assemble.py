#!/usr/bin/env python3
"""Assemble a renderable build from the shell and one fragment file per scene.

The shell is <project>/index.html (copied from index-skeleton.html, TIMING
injected). It keeps three splice regions: <!--SCENES:BEGIN-->...<!--SCENES:END-->
in #stage, /*SCENE-CSS:BEGIN*/.../*SCENE-CSS:END*/ in the main <style> and
/*SCENE-JS:BEGIN*/.../*SCENE-JS:END*/ in the main script. Each selected scene
contributes scenes/<sid>.scene.html (its <section>, <style> and <script>), or the
legacy triple scenes/<sid>.html|.css|.js. Fragments are pasted in script order.

A partial range (a part or a short) gets a rebased TIMING: the first selected
scene starts at 0, words, captions and sfx outside the range are dropped, and
the mix is cut to the range (plus --tail seconds with a fade out). The master
project is never modified: assets are hard-linked (copied when links are not
possible) and a rewritten mix is always a fresh file in the build.

Usage:
  python assemble.py <project> [--scenes a..b|all] [--tag T] [--ratio 16x9|1x1|9x16]
                     [--title TEXT] [--tail S] [--fade S] [--out DIR]
Writes <project>/builds/<tag>/ (or --out): index.html, timeline.json,
hyperframes.json and linked assets/ and compositions/. The tag defaults to
"full" for every scene, else "<a>..<b>". Standard library only; ffmpeg is needed
when the audio has to be cut.
"""
import argparse
import html as htmllib
import importlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
reframe = importlib.import_module("reframe")

MARKER = ".assemble.json"
RATIOS = ("16x9", "1x1", "9x16")
SID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
TIMING_RE = re.compile(r"/\*TIMING:BEGIN\*/\s*window\.TIMING\s*=\s*([\s\S]*?);?\s*/\*TIMING:END\*/")
HTML_MARKERS = ("<!--SCENES:BEGIN-->", "<!--SCENES:END-->")
CSS_MARKERS = ("/*SCENE-CSS:BEGIN*/", "/*SCENE-CSS:END*/")
JS_MARKERS = ("/*SCENE-JS:BEGIN*/", "/*SCENE-JS:END*/")
BLOCK_RE = {tag: re.compile(rf"<{tag}\b[^>]*>([\s\S]*?)</{tag}\s*>", re.I) for tag in ("style", "script")}
SECTION_TAG_RE = re.compile(r"<(/?)section\b[^>]*>", re.I)
CLOSE_TAG_RE = re.compile(r"</(script|style)", re.I)


class AssembleError(Exception):
    """A condition the operator can fix; printed as one line without a traceback."""


# ---------- project data shared with scaffold-scenes.py ----------

def read_json(path, what):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise AssembleError(f"{path} not found ({what})") from None
    except (OSError, ValueError, UnicodeDecodeError) as e:
        raise AssembleError(f"{path} is not valid UTF-8 JSON ({e})") from None


def script_scenes(project):
    """Scene dicts of data/script.json in script order, or None when the file is absent."""
    path = Path(project) / "data/script.json"
    if not path.is_file():
        return None
    data = read_json(path, "script")
    scenes = data.get("scenes") if isinstance(data, dict) else None
    if not isinstance(scenes, list) or not scenes:
        raise AssembleError(f"{path} has no scenes list")
    seen = set()
    for i, s in enumerate(scenes):
        sid = s.get("id") if isinstance(s, dict) else None
        if not isinstance(sid, str) or not SID_RE.match(sid):
            raise AssembleError(f"{path}: scene #{i + 1} has a missing or unsafe id {sid!r} (letters, digits, . _ - only)")
        if sid in seen:
            raise AssembleError(f"{path}: duplicate scene id {sid}")
        seen.add(sid)
    return scenes


def _match_id(token, ids):
    if token in ids:
        return token
    hits = [i for i in ids if i.startswith(token + "-")] or [i for i in ids if i.startswith(token)]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise AssembleError(f"scene {token!r} is not in the script")
    raise AssembleError(f"scene {token!r} is ambiguous: {', '.join(hits)}")


def select_range(spec, ids):
    """Resolve 'all', 'a' or 'a..b' (inclusive, script order, id prefixes allowed) to scene ids."""
    if not ids:
        raise AssembleError("no scenes to select")
    if spec in (None, "", "all"):
        return list(ids)
    a, sep, b = spec.partition("..")
    first = _match_id(a.strip(), ids)
    last = _match_id(b.strip(), ids) if sep else first
    i, j = ids.index(first), ids.index(last)
    if i > j:
        raise AssembleError(f"--scenes {spec}: {first} comes after {last} in script order")
    return list(ids[i:j + 1])


# ---------- fragments ----------

def split_fragment(text):
    """(section, css, js) of a fragment: the outermost first <section>, all <style> and <script> bodies."""
    css, js = [], []

    def take(store):
        def sub(m):
            store.append(m.group(1).strip("\n"))
            return ""
        return sub

    rest = BLOCK_RE["script"].sub(take(js), text)
    rest = BLOCK_RE["style"].sub(take(css), rest)
    rest = re.sub(r"<!--[\s\S]*?-->", "", rest)
    depth, start = 0, None
    for m in SECTION_TAG_RE.finditer(rest):
        if not m.group(1):
            if depth == 0:
                start = m.start()
            depth += 1
        elif depth:
            depth -= 1
            if depth == 0:
                return rest[start:m.end()], "\n".join(css), "\n".join(js)
    return None, "\n".join(css), "\n".join(js)


def load_fragment(project, sid):
    """(section, css, js) for a scene, or None when it has no fragment."""
    scenes = Path(project) / "scenes"
    new = scenes / f"{sid}.scene.html"
    legacy = scenes / f"{sid}.html"
    path = new if new.is_file() else legacy if legacy.is_file() else None
    if path is None:
        return None
    try:
        section, css, js = split_fragment(path.read_text(encoding="utf-8"))
        if path is legacy:
            extra = [(scenes / f"{sid}{ext}") for ext in (".css", ".js")]
            css = "\n".join(x for x in (css, extra[0].read_text(encoding="utf-8") if extra[0].is_file() else "") if x.strip())
            js = "\n".join(x for x in (js, extra[1].read_text(encoding="utf-8") if extra[1].is_file() else "") if x.strip())
    except (OSError, UnicodeDecodeError) as e:
        raise AssembleError(f"cannot read the fragment of {sid}: {e}") from None
    if section is None:
        raise AssembleError(f"{path} has no complete <section ...>...</section> block")
    # a literal </script> or </style> inside a fragment would close the shell's block early
    return section.strip(), CLOSE_TAG_RE.sub(r"<\\/\1", css).strip("\n"), CLOSE_TAG_RE.sub(r"<\\/\1", js).strip("\n")


def splice(text, markers, body, where):
    begin, end = markers
    if text.count(begin) != 1 or text.count(end) != 1:
        raise AssembleError(f"{where} needs exactly one {begin} and one {end} marker (see assets/templates/index-skeleton.html)")
    i, j = text.index(begin) + len(begin), text.index(end)
    if j < i:
        raise AssembleError(f"{where}: {end} comes before {begin}")
    return text[:i] + body + text[j:]


def scene_js(sid, body):
    # the body is pasted verbatim: re-indenting would change multi-line template strings
    return f"/* {sid} */ {{ const sid = {json.dumps(sid)}; if (SC[sid]) {{\n{body}\n}} }}"


# ---------- TIMING ----------

def read_timing(shell, where):
    m = TIMING_RE.search(shell)
    if not m:
        raise AssembleError(f"{where} has no /*TIMING:BEGIN*/window.TIMING=...;/*TIMING:END*/ block")
    raw = m.group(1).strip()
    if raw in ("null", "undefined", ""):
        raise AssembleError(f"{where}: TIMING is not injected; run the timeline builder first")
    try:
        timing = json.loads(raw)
    except ValueError as e:
        raise AssembleError(f"{where}: injected TIMING is not plain JSON ({e})") from None
    if not isinstance(timing, dict) or not isinstance(timing.get("scenes"), dict) or not timing["scenes"]:
        raise AssembleError(f"{where}: injected TIMING has no scenes")
    for key in ("duration", "fps"):
        if not isinstance(timing.get(key), (int, float)) or timing[key] <= 0:
            raise AssembleError(f"{where}: injected TIMING has no positive {key}")
    for sid, sc in timing["scenes"].items():
        if not isinstance(sc, dict) or not all(isinstance(sc.get(k), (int, float)) for k in ("start", "end")):
            raise AssembleError(f"{where}: TIMING scene {sid} has no numeric start/end")
    return timing


def inject_timing(shell, timing):
    payload = json.dumps(timing, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    block = f"/*TIMING:BEGIN*/window.TIMING={payload};/*TIMING:END*/"
    return TIMING_RE.sub(lambda _m: block, shell, count=1)


def set_duration(shell, duration):
    out, n = re.subn(r'(<div\b[^>]*?\bid="root"[^>]*?data-duration=")[\d.]+"', lambda m: f'{m.group(1)}{duration:g}"', shell, count=1)
    if n != 1:
        raise AssembleError('index.html has no <div id="root" ... data-duration="..."> to resize')
    return re.sub(r'(<audio\b[^>]*?\bid="mix"[^>]*?data-duration=")[\d.]+"', lambda m: f'{m.group(1)}{duration:g}"', out, count=1)


def set_title(shell, title):
    pat = re.compile(r'(<div\b[^>]*\bid="hud-title"[^>]*>)[\s\S]*?(</div>)')
    if not pat.search(shell):
        raise AssembleError('--title needs a <div id="hud-title"> in index.html (see assets/templates/index-skeleton.html)')
    return pat.sub(lambda m: f"{m.group(1)}<span>{htmllib.escape(title)}</span>{m.group(2)}", shell, count=1)


def _r(x):
    return round(x, 3)


def rebase(timing, ids, t0, t1, end, env):
    """TIMING for the window [t0, end): selected scenes only, times shifted by -t0."""
    fps = timing["fps"]
    out = {k: v for k, v in timing.items() if k not in ("scenes", "captions", "sfx", "env")}
    out["duration"] = _r(round((end - t0) * fps) / fps)
    if isinstance(timing.get("beat0"), (int, float)):
        out["beat0"] = _r(timing["beat0"] - t0)
    scenes = {}
    for sid in ids:
        sc = dict(timing["scenes"][sid])
        sc["start"], sc["end"] = _r(sc["start"] - t0), _r(sc["end"] - t0)
        lines = []
        for line in sc.get("lines") or []:
            line = dict(line)
            for k in ("on", "off"):
                if isinstance(line.get(k), (int, float)):
                    line[k] = _r(line[k] - t0)
            line["words"] = [[w[0], *(_r(x - t0) for x in w[1:])] for w in line.get("words") or []]
            lines.append(line)
        if "lines" in sc:
            sc["lines"] = lines
        scenes[sid] = sc
    out["scenes"] = scenes
    caps = []
    for c in timing.get("captions") or []:
        if c["end"] <= t0 or c["start"] >= t1:
            continue
        words = [[w[0], _r(w[1] - t0), *w[2:]] for w in c.get("words") or [] if t0 - 1e-6 <= w[1] < t1]
        if c.get("words") and not words:
            continue
        caps.append({**c, "start": _r(max(c["start"], t0) - t0), "end": _r(min(c["end"], t1) - t0), "words": words})
    if "captions" in timing:
        out["captions"] = caps
    if "sfx" in timing:
        out["sfx"] = [{**e, "t": _r(e["t"] - t0)} for e in timing.get("sfx") or [] if t0 <= e["t"] <= t1]
    out["env"] = env
    return out


def envelope(project, timing, t0, end):
    fps = timing["fps"]
    path = Path(project) / "data/vo-envelope.json"
    if path.is_file():
        src = read_json(path, "voice envelope")
        if isinstance(src, dict):
            src = src.get("env")
        if not isinstance(src, list) or not all(isinstance(v, (int, float)) for v in src):
            raise AssembleError(f"{path} must be a list of numbers")
    else:
        src = timing.get("env") if isinstance(timing.get("env"), list) else []
        if not src:
            return []
    a, b = int(round(t0 * fps)), int(round(end * fps))
    part = list(src[a:b])
    return part + [0] * (b - a - len(part))


# ---------- audio ----------

def _ffmpeg(args):
    try:
        p = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    except OSError as e:
        raise AssembleError(f"ffmpeg could not start ({e})") from None
    if p.returncode != 0:
        tail = " | ".join(p.stderr.strip().splitlines()[-3:])
        raise AssembleError(f"ffmpeg failed: {tail}")
    return p.stderr


STEREO = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"


def render_mix(project, dst, t0, t1, end, duration, fade):
    """Write a fresh mix for [t0, end) to dst (never through a hard link into the master)."""
    audio = Path(project) / "assets/audio"
    voice, music, mix = audio / "stem-voice.wav", audio / "stem-music.wav", audio / "mix.m4a"
    fade = max(0.0, min(fade, duration))
    tail = f",afade=t=out:st={duration - fade:.3f}:d={fade:.3f}" if fade > 0 else ""
    pad = f"apad=whole_dur={duration:.3f},atrim=0:{duration:.3f}"
    enc = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    tmp_out = dst.with_name(dst.stem + ".tmp" + dst.suffix)
    # A part is a slice of the master mix, so joined parts keep one level. Only a stand-alone build with a
    # music tail past its last word (a short) re-mixes the stems and is normalised on its own.
    if end > t1 + 1e-3 and voice.is_file() and music.is_file():
        with tempfile.TemporaryDirectory() as work:
            pre = Path(work) / "pre.wav"
            graph = (
                f"[0:a]atrim=start={t0:.3f}:end={t1:.3f},asetpts=PTS-STARTPTS,{STEREO}[v];"
                f"[1:a]atrim=start={t0:.3f}:end={end:.3f},asetpts=PTS-STARTPTS,{STEREO}[m];"
                f"[v][m]amix=inputs=2:normalize=0:duration=longest,{pad}{tail}[out]"
            )
            _ffmpeg(["-i", str(voice), "-i", str(music), "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_f32le", str(pre)])
            ln = "loudnorm=I=-14:TP=-1.5:LRA=11"
            log = _ffmpeg(["-i", str(pre), "-af", f"{ln}:print_format=json", "-f", "null", "-"])
            m = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", log)
            meas = json.loads(m[-1]) if m else {}
            vals = {k: meas.get(k) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
            try:
                ok = all(math.isfinite(float(v)) for v in vals.values())
            except (TypeError, ValueError):
                ok = False
            if ok:  # silence measures -inf: keep it as is rather than amplify nothing
                af = (f"{ln}:measured_I={vals['input_i']}:measured_TP={vals['input_tp']}:measured_LRA={vals['input_lra']}"
                      f":measured_thresh={vals['input_thresh']}:offset={vals['target_offset']}:linear=true,aresample=48000,{pad}")
            else:
                af = pad
            _ffmpeg(["-i", str(pre), "-af", af, *enc, str(tmp_out)])
    elif mix.is_file():
        cut = end if end <= t1 + 1e-3 else t1  # without stems a tail would carry the next scene's voice: pad silence
        graph = f"atrim=start={t0:.3f}:end={cut:.3f},asetpts=PTS-STARTPTS,{STEREO},{pad}{tail}"
        _ffmpeg(["-i", str(mix), "-af", graph, *enc, str(tmp_out)])
    else:
        return False
    os.replace(tmp_out, dst)
    return True


# ---------- build directory ----------

def _reclaimable(out):
    return all(p.name == MARKER + ".tmp" for p in out.iterdir())


def prepare_out(project, out):
    if out == project or out in project.parents:
        raise AssembleError(f"{out} contains the project; choose another --out")
    for d in reframe.LINKED_DIRS + ("scenes", "data"):
        if reframe._inside(str(out), str(project / d)):
            raise AssembleError(f"{out} lies inside the project's {d}/; choose another --out")
    if out.exists() and not out.is_dir():
        raise AssembleError(f"{out} exists and is not a directory")
    if out.exists():
        if (out / MARKER).is_file():
            try:
                meta = json.loads((out / MARKER).read_text(encoding="utf-8"))
                owner = Path(meta["project"]).resolve()
            except (OSError, ValueError, UnicodeDecodeError, KeyError, TypeError) as e:
                raise AssembleError(f"{out / MARKER} is unreadable ({e}); remove {out} yourself or pass --out") from None
            if owner != project:
                raise AssembleError(f"{out} is a build of {owner}; pass --out to choose another directory")
        elif not _reclaimable(out):
            raise AssembleError(f"{out} exists and was not made by assemble.py; pass --out to choose another directory")


def write_build(project, out, html, timing, meta):
    out.mkdir(parents=True, exist_ok=True)
    for child in out.iterdir():  # owned or empty: clear it, keeping the marker until the new one lands
        if child.name != MARKER:
            shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
    tmp = out / (MARKER + ".tmp")
    tmp.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, out / MARKER)
    (out / "index.html").write_text(html, encoding="utf-8", newline="\n")
    (out / "timeline.json").write_text(json.dumps({k: v for k, v in timing.items() if k != "env"}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    if (project / "hyperframes.json").is_file():
        shutil.copy2(project / "hyperframes.json", out / "hyperframes.json")
    guard, skipped = (os.path.realpath(project), os.path.realpath(out)), []
    files = sum(reframe.link_tree(project / d, out / d, guard, skipped) for d in reframe.LINKED_DIRS if (project / d).is_dir())
    return files, skipped


def assemble(project, scenes="all", tag=None, ratio="16x9", title=None, tail=0.0, fade=None, out=None):
    """Build and return (out_dir, summary_line, warnings)."""
    project = Path(project).resolve()
    if not project.is_dir():
        raise AssembleError(f"{project} is not a directory")
    if tail < 0 or (fade is not None and fade < 0):
        raise AssembleError("--tail and --fade must be >= 0")
    if ratio not in RATIOS:
        raise AssembleError(f"--ratio must be one of {', '.join(RATIOS)}")
    index = project / "index.html"
    try:
        shell = index.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise AssembleError(f"{index} not found (copy assets/templates/index-skeleton.html)") from None
    except (OSError, UnicodeDecodeError) as e:
        raise AssembleError(f"{index} is unreadable ({e})") from None
    for markers in (HTML_MARKERS, CSS_MARKERS, JS_MARKERS):
        splice(shell, markers, "", str(index))
    timing = read_timing(shell, str(index))

    script = script_scenes(project)
    if script is not None:
        order = [s["id"] for s in script]
        absent = [sid for sid in order if sid not in timing["scenes"]]
        if absent:
            raise AssembleError(f"scenes in data/script.json but not in the injected TIMING (re-run the timeline builder): {', '.join(absent)}")
    else:
        order = sorted(timing["scenes"], key=lambda k: timing["scenes"][k]["start"])
        bad = [sid for sid in order if not SID_RE.match(sid)]
        if bad:
            raise AssembleError(f"unsafe scene ids in TIMING: {', '.join(bad)}")
    ids = select_range(scenes, order)
    full = ids == order
    if tag is None:
        tag = "full" if scenes in (None, "", "all") else scenes.replace(" ", "")
    if not TAG_RE.match(tag) or tag in (".", ".."):
        raise AssembleError(f"--tag {tag!r} must be a plain directory name (letters, digits, . _ -)")

    frags, missing = [], []
    for sid in ids:
        frag = load_fragment(project, sid)
        (missing.append(sid) if frag is None else frags.append((sid, frag)))
    if missing:
        raise AssembleError(f"missing scene fragments (scenes/<sid>.scene.html): {', '.join(missing)}")

    if full:
        t0, t1 = 0.0, float(timing["duration"])
    else:
        t0, t1 = float(timing["scenes"][ids[0]]["start"]), float(timing["scenes"][ids[-1]]["end"])
    end = t1 + tail
    if end <= t0:
        raise AssembleError(f"scene range {ids[0]}..{ids[-1]} has no duration")
    new_timing = rebase(timing, ids, t0, t1, end, envelope(project, timing, t0, end))
    duration = new_timing["duration"]

    html = splice(shell, HTML_MARKERS, "\n" + "\n".join(f[0] for _, f in frags) + "\n", str(index))
    html = splice(html, CSS_MARKERS, "\n" + "\n".join(f"/* {sid} */\n{f[1]}" for sid, f in frags if f[1].strip()) + "\n", str(index))
    html = splice(html, JS_MARKERS, "\n" + "\n".join(scene_js(sid, f[2]) for sid, f in frags) + "\n", str(index))
    html = set_duration(inject_timing(html, new_timing), duration)
    if title is not None:
        html = set_title(html, title)
    if ratio != "16x9":
        try:
            html = reframe.edition_html(html, ratio)
        except reframe.ReframeError as e:
            raise AssembleError(str(e)) from None

    warnings = []
    rewrite_mix = not full or tail > 0
    audio = project / "assets/audio"
    has_audio = (audio / "mix.m4a").is_file() or ((audio / "stem-voice.wav").is_file() and (audio / "stem-music.wav").is_file())
    if rewrite_mix and has_audio and not shutil.which("ffmpeg"):
        raise AssembleError("ffmpeg is not on PATH; it is needed to cut the mix for a partial range or a tail")
    if rewrite_mix and not has_audio:
        warnings.append("no assets/audio/mix.m4a or stems: the build has no mix to cut")
    others = sorted(p.name for p in project.glob("*.html") if p.name != "index.html")
    if others:
        warnings.append(f"not copied into the build (only index.html is assembled): {', '.join(others)}")

    out = Path(out).resolve() if out else project / "builds" / tag
    prepare_out(project, out)
    meta = {"project": str(project), "tag": tag, "scenes": [ids[0], ids[-1]], "ratio": ratio}
    _, skipped = write_build(project, out, html, new_timing, meta)
    if skipped:
        warnings.append(f"skipped links that loop, point above the project or are broken: {', '.join(skipped)}")
    if rewrite_mix and has_audio:
        dst = out / "assets/audio/mix.m4a"
        dst.parent.mkdir(parents=True, exist_ok=True)
        render_mix(project, dst, t0, t1, end, duration, tail if fade is None else fade)

    try:
        shown = out.relative_to(project).as_posix()
    except ValueError:
        shown = str(out)
    line = f"{shown}: {len(ids)} scenes {ids[0]}..{ids[-1]}, {t0:.2f}–{t1:.2f} s, duration {duration:g} s, ratio {ratio}"
    return out, line, warnings


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0], epilog="Example: assemble.py . --scenes s012..s018 --tag short-01 --ratio 9x16 --title 'Plan mode' --tail 1.5")
    ap.add_argument("project", help="project directory (holds index.html, data/, scenes/)")
    ap.add_argument("--scenes", default="all", help="'all' (default) or an inclusive script-order range a..b; id prefixes are accepted")
    ap.add_argument("--tag", help="build name under builds/ (default: full, or a..b)")
    ap.add_argument("--ratio", default="16x9", choices=RATIOS)
    ap.add_argument("--title", help="text for the #hud-title element (shorts)")
    ap.add_argument("--tail", type=float, default=0.0, help="seconds of music after the last scene (default 0)")
    ap.add_argument("--fade", type=float, help="audio fade-out seconds at the end (default: --tail)")
    ap.add_argument("--out", help="build directory (default: <project>/builds/<tag>)")
    a = ap.parse_args(argv)
    try:
        _, line, warnings = assemble(a.project, a.scenes, a.tag, a.ratio, a.title, a.tail, a.fade, a.out)
    except (AssembleError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
