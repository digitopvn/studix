#!/usr/bin/env python3
"""Preflight the machine for a motion-video project and print a one-line agent brief.

Probes bash (and its login profile) and PowerShell, picks the working shell,
finds a Python that prints UTF-8, and checks ffmpeg, ffprobe, Node 18+, npx,
the pinned HyperFrames, multix, playwright and the optional Python modules.
It never edits a shell profile; when one is broken it names the file to fix.
Standard library only.

Usage:
  python -X utf8 doctor.py [project] [--mode tts|recording] [--json] [--skip-npx]
Writes <project>/data/env.json when a project is given. Exit 1 if a required
check fails.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HYPERFRAMES = "hyperframes@0.8.77"
UTF8_SAMPLE = "tiếng Việt"
TIMEOUT = 30
NPX_TIMEOUT = 240
# optional Python modules and the skill scripts that need them
MODULES = {
    "numpy": "fit-beat-grid.py, measure-mix-balance.py, verify-arrangement.py",
    "scipy": "fit-beat-grid.py",
    "yaml": "resolve-style.py (PyYAML)",
}
MULTIX_USE = {"tts": "TTS voice, SFX and forced alignment", "recording": "transcription (ElevenLabs Scribe)"}
PROFILE_ERROR = re.compile(r"unexpected EOF|syntax error|command not found|No such file|bad substitution", re.I)


def utf8_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def run(argv, timeout=TIMEOUT, cwd=None, raw=False):
    """(returncode, stdout, stderr); returncode None when the command could not run or timed out."""
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=timeout, cwd=cwd, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as e:
        return None, b"" if raw else "", str(e)
    if raw:
        return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace")
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


def which(name):
    return shutil.which(name) or (shutil.which(name + ".cmd") if os.name == "nt" else None)


class Report:
    def __init__(self):
        self.checks = []
        self.tools = {}

    def add(self, name, ok, required, detail):
        self.checks.append({"name": name, "ok": ok, "required": required, "detail": detail})
        return ok


def first_line(text):
    return next((ln.strip() for ln in text.splitlines() if ln.strip()), "")


def profile_file(stderr):
    """The startup file a login bash complained about, else the first one bash reads."""
    m = re.search(r"^(\S[^:\n]*?): line \d+:", stderr, re.M)
    if m:
        return m.group(1)
    home = Path.home()
    for name in (".bash_profile", ".bash_login", ".profile"):
        if (home / name).is_file():
            return str(home / name)
    return str(home / ".bash_profile")


def probe_bash(rep):
    bash = which("bash")
    if not bash:
        rep.add("bash", False, False, "not on PATH")
        return False
    code, out, err = run([bash, "-c", "echo 'quoted ok'"])
    quoted = code == 0 and out.strip() == "quoted ok"
    code2, out2, _ = run([bash, "-c", 'printf "%s|" "$@"', "_", "a", "b c"])
    multi = code2 == 0 and out2 == "a|b c|"
    ok = quoted and multi
    detail = bash if ok else f"{bash}: quoted echo {'ok' if quoted else 'failed'}, multi-arg {'ok' if multi else 'failed'}" + (
        f" ({first_line(err)})" if err.strip() else "")
    rep.add("bash", ok, False, detail)
    if ok:
        code3, out3, err3 = run([bash, "-lc", "echo ok"])
        clean = code3 == 0 and out3.strip().endswith("ok") and not PROFILE_ERROR.search(err3)
        if clean:
            rep.add("bash profile", True, False, "login shell starts cleanly")
        else:
            why = first_line(err3) or f"exit {code3}"
            rep.add("bash profile", False, False, f"login startup error: {why}; fix {profile_file(err3)} yourself")
        out_v = run([bash, "-c", "echo $BASH_VERSION"])[1].strip()
        rep.tools["bash"] = out_v or "?"
    return ok


def probe_powershell(rep):
    for exe in ("pwsh", "powershell"):
        path = which(exe)
        if not path:
            continue
        code, out, err = run([path, "-NoProfile", "-Command", "Write-Output 'quoted ok'; $PSVersionTable.PSVersion.ToString()"])
        lines = out.split()
        if code == 0 and out.startswith("quoted ok"):
            rep.tools[exe] = lines[-1] if len(lines) > 2 else "?"
            rep.add(exe, True, False, path)
            return exe
        rep.add(exe, False, False, f"{path}: {first_line(err) or f'exit {code}'}")
    return None


def utf8_ok(argv):
    code, out, _ = run([*argv, "-c", f"print('{UTF8_SAMPLE}')"], raw=True)
    return code == 0 and out.decode("utf-8", "replace").strip() == UTF8_SAMPLE


def version_tuple(text):
    m = re.match(r"\s*(\d+)\.(\d+)", text or "")
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def modules_of(exe):
    code, out, _ = run([exe, "-X", "utf8", "-c",
                        "import importlib.util as u, json;print(json.dumps({m: u.find_spec(m) is not None for m in %r}))"
                        % list(MODULES)])
    try:
        return json.loads(out) if code == 0 else {}
    except ValueError:
        return {}


def probe_python(rep):
    """A 3.9+ Python, preferring the first (running interpreter, then PATH) that has every module."""
    names = [sys.executable, "python3", "python"] + (["py"] if os.name == "nt" else [])
    found_any = None
    for name in dict.fromkeys(names):
        if not shutil.which(name) and not Path(name).is_file():
            continue
        code, out, _ = run([name, "-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"])
        if code != 0 or version_tuple(out) < (3, 9):
            continue
        cand = (name, out.strip(), modules_of(name))
        found_any = found_any or cand
        if all(cand[2].get(m) for m in MODULES):
            found_any = cand
            break
    if found_any is None:
        found_any = (sys.executable, "%d.%d.%d" % sys.version_info[:3], modules_of(sys.executable))
    exe, version, found = found_any
    ok = version_tuple(version) >= (3, 9)
    rep.add("python", ok, True, f"{exe} {version}" + ("" if ok else " (needs 3.9+)"))
    rep.tools["python"] = version
    plain, forced = utf8_ok([exe]), utf8_ok([exe, "-X", "utf8"])
    rep.add("python utf-8", forced, True,
            f"plain {'ok' if plain else 'fails'}, -X utf8 {'ok' if forced else 'fails'}; always run `{exe} -X utf8`"
            " (`-I` ignores PYTHONIOENCODING)")
    for mod, users in MODULES.items():
        rep.add(f"py:{mod}", bool(found.get(mod)), False, f"needed by {users}")
    return {"exe": exe, "invoke": f"{exe} -X utf8", "version": version, "utf8": {"plain": plain, "x_utf8": forced}}


def probe_tool(rep, name, argv, required, detail_fail, parse=first_line):
    path = which(name)
    if not path:
        return rep.add(name, False, required, f"not on PATH; {detail_fail}")
    code, out, err = run([path, *argv])
    if code != 0:
        return rep.add(name, False, required, f"{path}: {first_line(err) or f'exit {code}'}")
    rep.tools[name] = parse(out or err)
    return rep.add(name, True, required, rep.tools[name])


def ffmpeg_version(text):
    m = re.search(r"version\s+(\S+)", text)
    return m.group(1) if m else first_line(text)


def probe_node(rep, cwd, skip_npx, mode):
    node = which("node")
    if not node:
        rep.add("node", False, True, "not on PATH; install Node.js 18+")
    else:
        code, out, _ = run([node, "--version"])
        m = re.match(r"v(\d+)", out.strip())
        ok = code == 0 and bool(m) and int(m.group(1)) >= 18
        rep.tools["node"] = out.strip()
        rep.add("node", ok, True, out.strip() + ("" if ok else " (needs 18+)"))
        code, _, err = run([node, "-e", "require.resolve('playwright')"], cwd=cwd)
        rep.add("playwright", code == 0, False,
                "resolvable" if code == 0 else "not resolvable from node; needed by check-bounds.mjs (npm i playwright)")
    npx = which("npx")
    rep.add("npx", bool(npx), True, npx or "not on PATH; ships with Node.js")
    if skip_npx:
        rep.add("hyperframes", None, True, f"{HYPERFRAMES} skipped (--skip-npx)")
    elif npx:
        code, out, err = run([npx, "--yes", HYPERFRAMES, "--version"], timeout=NPX_TIMEOUT)
        ok = code == 0
        if ok:
            rep.tools["hyperframes"] = first_line(out)
        rep.add("hyperframes", ok, True, first_line(out) if ok else f"{HYPERFRAMES}: {first_line(err) or f'exit {code}'}")
    else:
        rep.add("hyperframes", False, True, "needs npx")
    probe_tool(rep, "multix", ["--version"], False, f"needed for {MULTIX_USE[mode]}")


def probe_fonts(rep, project):
    """Local fonts the composition references; the skill ships none, so a fresh project must add them."""
    page = Path(project) / "index.html"
    if not page.is_file():
        return
    refs = sorted(set(re.findall(r"url\([\"']?(\./)?(assets/fonts/[^\"')]+)", page.read_text(encoding="utf-8", errors="replace"))))
    missing = [ref for _, ref in refs if not (Path(project) / ref).is_file()]
    rep.add("fonts", not missing, False,
            f"missing {', '.join(missing)}; download the TTF (Google Fonts) or point @font-face at a local font"
            if missing else f"{len(refs)} local font file(s) present")


def doctor(project, mode, skip_npx):
    rep = Report()
    bash_ok = probe_bash(rep)
    ps = probe_powershell(rep)
    shell = "bash" if bash_ok else ps
    rep.add("shell", bool(shell), True, shell or "neither bash nor PowerShell runs a quoted echo")
    python = probe_python(rep)
    probe_tool(rep, "ffmpeg", ["-version"], True, "install ffmpeg", ffmpeg_version)
    probe_tool(rep, "ffprobe", ["-version"], True, "ships with ffmpeg", ffmpeg_version)
    probe_node(rep, project or Path(__file__).resolve().parent, skip_npx, mode)
    if project:
        probe_fonts(rep, project)
    brief = (f"Shell: {shell or 'none'}. Python: `{python['invoke']}`. "
             "Write files with Write/Edit, never heredocs.")
    return {"mode": mode, "platform": sys.platform, "shell": shell, "python": python, "tools": rep.tools,
            "checks": rep.checks, "brief": brief}


def table(env):
    rows = []
    for c in env["checks"]:
        mark = "skip" if c["ok"] is None else "ok" if c["ok"] else ("FAIL" if c["required"] else "warn")
        rows.append(f"{mark:<4} {c['name']:<14} {c['detail']}")
    return rows


def main(argv=None):
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("project", nargs="?", help="project directory; data/env.json is written there")
    ap.add_argument("--mode", choices=("tts", "recording"), default="tts", help="pipeline mode (default tts)")
    ap.add_argument("--json", action="store_true", help="print the env JSON instead of the table")
    ap.add_argument("--skip-npx", action="store_true", help=f"do not run npx {HYPERFRAMES} (offline)")
    a = ap.parse_args(argv)
    project = Path(a.project) if a.project else None
    if project and not project.is_dir():
        print(f"error: project directory not found: {project}", file=sys.stderr)
        return 1
    env = doctor(project, a.mode, a.skip_npx)
    if project:
        try:
            (project / "data").mkdir(exist_ok=True)
            (project / "data/env.json").write_text(json.dumps(env, ensure_ascii=False, indent=1) + "\n",
                                                   encoding="utf-8", newline="\n")
        except OSError as e:
            print(f"error: cannot write {project / 'data/env.json'}: {e}", file=sys.stderr)
            return 1
    if a.json:
        print(json.dumps(env, ensure_ascii=False, indent=1))
    else:
        print("\n".join(table(env)))
        print(env["brief"])
    return 1 if any(c["required"] and c["ok"] is False for c in env["checks"]) else 0


if __name__ == "__main__":
    sys.exit(main())
