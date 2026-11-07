#!/usr/bin/env python3
"""Run HyperFrames lint and check on a build directory and print one summary line.

Fails fast when the directory holds more than one root *.html (HyperFrames would
report multiple_root_compositions). Full logs go to <build-dir>/.validate/
{lint,check}.log; the console gets one line plus the first error lines.
Standard library only.

Usage:
  python -X utf8 validate.py <build-dir> [--json] [--hf-cmd "npx --yes hyperframes@0.8.77"]
Exit 1 when either step reports errors.
"""
import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

HYPERFRAMES = "hyperframes@0.8.77"
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SHOWN_ERRORS = 5


class ValidateError(Exception):
    pass


def utf8_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def hf_command(override):
    if override:
        posix = os.name != "nt"  # keep Windows backslashes; strip the quotes non-posix mode leaves
        cmd = [t if posix else t.strip('"') for t in shlex.split(override, posix=posix)]
        if not cmd:
            raise ValidateError("--hf-cmd is empty")
        return cmd
    npx = shutil.which("npx") or shutil.which("npx.cmd")  # Windows ships npx as npx.cmd
    if not npx:
        raise ValidateError("npx not found on PATH; install Node.js 18+ (run scripts/doctor.py)")
    return [npx, "--yes", HYPERFRAMES]


def parse_counts(text, returncode):
    """(errors, warnings) from HyperFrames output; the exit code decides when counts are absent."""
    errors = [int(n) for n in re.findall(r"(\d+)\s+errors?\b", text)]
    warnings = [int(n) for n in re.findall(r"(\d+)\s+warnings?\b", text)]
    e, w = sum(errors), sum(warnings)
    failed = returncode != 0 or re.search(r"\bcheck failed\b", text, re.I)
    if failed and e == 0:
        e = 1  # failed without a parsable count: still an error
    return e, w


def error_lines(text):
    out = []
    for raw in text.splitlines():
        s = raw.strip()
        if s.startswith(("✗", "×", "error", "Error", "ERROR")):
            out.append(s)
    return out


def run_step(cmd, step, build, logdir):
    try:
        proc = subprocess.run([*cmd, step], cwd=build, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
    except OSError as e:
        raise ValidateError(f"could not run {shlex.join(cmd)} {step}: {e}") from e
    text = ANSI.sub("", (proc.stdout or "") + (proc.stderr or ""))
    (logdir / f"{step}.log").write_text(text, encoding="utf-8", newline="\n")
    e, w = parse_counts(text, proc.returncode)
    errs = error_lines(text)
    if e and not errs:
        tail = [ln.strip() for ln in text.splitlines() if ln.strip()][-3:]
        errs = [f"{step} exited {proc.returncode}: " + " | ".join(tail)] if tail else [f"{step} exited {proc.returncode}"]
    return {"errors": e, "warnings": w, "exit": proc.returncode, "first_errors": errs[:SHOWN_ERRORS]}


def validate(build, override=None):
    build = Path(build)
    if not build.is_dir():
        raise ValidateError(f"build directory not found: {build}")
    roots = sorted(p.name for p in build.glob("*.html") if p.is_file())
    if len(roots) > 1:
        return {"dir": str(build), "ok": False, "roots": roots,
                "first_errors": [f"multiple root html files ({', '.join(roots)}); keep only index.html"]}
    if not roots:
        raise ValidateError(f"{build} has no root .html composition")
    cmd = hf_command(override)
    logdir = build / ".validate"
    logdir.mkdir(exist_ok=True)
    result = {"dir": str(build)}
    for step in ("lint", "check"):
        result[step] = run_step(cmd, step, build, logdir)
    result["ok"] = not (result["lint"]["errors"] or result["check"]["errors"])
    merged = dict.fromkeys(result["lint"]["first_errors"] + result["check"]["first_errors"])  # check repeats lint
    result["first_errors"] = list(merged)[:SHOWN_ERRORS]
    return result


def summary(r):
    if "roots" in r:
        return f"validate {r['dir']}: FAIL multiple root html: {', '.join(r['roots'])}"
    lint, check = r["lint"], r["check"]
    status = "OK" if r["ok"] else "FAIL"
    return f"validate {r['dir']}: lint {lint['errors']}/{lint['warnings']} · check {check['errors']}/{check['warnings']} · {status}"


def main(argv=None):
    utf8_stdio()
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("build_dir", help="directory holding the root index.html")
    ap.add_argument("--json", action="store_true", help="print the result as JSON")
    ap.add_argument("--hf-cmd", help=f"command that runs HyperFrames (default: npx --yes {HYPERFRAMES})")
    a = ap.parse_args(argv)
    try:
        r = validate(a.build_dir, a.hf_cmd)
    except (ValidateError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if a.json:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    else:
        print(summary(r))
        if not r["ok"]:
            for line in r["first_errors"]:
                print(f"  {line}")
            if "roots" not in r:
                print(f"  logs: {Path(r['dir']) / '.validate'}")
    return 0 if r["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
