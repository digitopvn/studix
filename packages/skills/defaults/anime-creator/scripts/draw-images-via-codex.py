#!/usr/bin/env python3
"""Draw sheets, sets and keyframes with the local Codex CLI (ChatGPT plan quota, no per-image cash).

Usage: draw-images-via-codex.py JOBS.json [--parallel 3] [--codex /abs/path/codex] [--force]
JOBS.json: [{"id": "zuey-sheet", "out": "/abs/bible/refs/zuey-sheet.png", "prompt": "...", "refs": ["/abs/ref.png"]}]

Codex saves into ~/.codex/generated_images/<session>/; the prompt asks it to copy the PNG to `out`, and when it
does not, the newest PNG written after the job started is copied instead. "At capacity" errors retry with
backoff. Existing outputs are skipped (never overwritten) unless --force. Each attempt is logged to
<out dir>/codex-draw-log.jsonl. Supported: macOS, Linux, Windows.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402

GEN_DIR = Path.home() / ".codex" / "generated_images"
SUFFIX = ("\n\nUse your image generation tool to generate exactly ONE image. If reference images are attached, keep the "
          "character design IDENTICAL to them (face, hair, outfit, colours, proportions). Do not write text in the image. "
          "After generation, copy the generated PNG file from {gen} to {out} using cp. Do nothing else.")


_claimed: set[Path] = set()
_lock = threading.Lock()


def newest_png(since: float) -> Path | None:
    """Parallel jobs share GEN_DIR, so a PNG another job already took is never handed out twice."""
    with _lock:
        pngs = [p for p in GEN_DIR.rglob("*.png") if p.stat().st_mtime >= since and p not in _claimed]
        best = max(pngs, key=lambda p: p.stat().st_mtime) if pngs else None
        if best:
            _claimed.add(best)
        return best


def codex_argv(codex: str) -> list[str]:
    """On Windows the npm shim is a .cmd batch file, and cmd.exe cuts a multi-line prompt at the first newline;
    run its codex.js with node directly instead."""
    p = Path(codex)
    js = p.parent / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    if sys.platform == "win32" and p.suffix.lower() in ("", ".cmd", ".ps1") and js.exists():
        node = p.parent / "node.exe"
        return [str(node) if node.exists() else (shutil.which("node") or "node"), str(js)]
    return [codex]


QUOTA = threading.Event()  # set once codex reports a usage limit: the rest of the batch would only fail too


def draw(job: dict, codex: list[str], force: bool, retries: int = 4) -> tuple[str, str]:
    out = Path(job["out"])
    if out.exists() and not force:
        return job["id"], "skip (exists)"
    if QUOTA.is_set():
        return job["id"], "skip (codex usage limit)"
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [*codex, "exec", "--skip-git-repo-check", "-s", "workspace-write", "--add-dir", str(GEN_DIR), "--add-dir", str(out.parent)]
    for r in job.get("refs") or []:
        cmd += ["-i", str(r)]
    cmd += ["--", job["prompt"] + SUFFIX.format(gen=GEN_DIR.as_posix(), out=out.as_posix())]
    for attempt in range(1, retries + 1):
        t0 = time.time()
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL)
        tail = io.redact((r.stdout + r.stderr)[-600:])
        if not out.exists():
            src = newest_png(t0)
            if src:
                shutil.copy2(src, out)
        ok = out.exists() and out.stat().st_mtime >= t0 - 1
        io.append_jsonl(out.parent / "codex-draw-log.jsonl", {"t": io.now_iso(), "id": job["id"], "attempt": attempt,
                        "ok": ok, "seconds": round(time.time() - t0), "rc": r.returncode, "tail": "" if ok else tail})
        if ok:
            return job["id"], f"ok in {round(time.time() - t0)}s"
        if "usage limit" in tail.lower():
            QUOTA.set()
            return job["id"], f"codex usage limit: {tail[-160:]}"
        if "capacity" not in tail.lower() and attempt >= 2:
            return job["id"], f"failed rc={r.returncode}: {tail[-200:]}"
        time.sleep(30 * attempt)
    return job["id"], "failed after retries"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs")
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--codex", default=shutil.which("codex") or "codex")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only", nargs="*", help="job ids to run")
    a = ap.parse_args()
    jobs = [j for j in io.load_json(a.jobs) if not a.only or j["id"] in a.only]
    codex = codex_argv(a.codex)
    with ThreadPoolExecutor(max_workers=min(a.parallel, 3)) as pool:
        for jid, status in pool.map(lambda j: draw(j, codex, a.force), jobs):
            print(f"{jid}: {status}", flush=True)


if __name__ == "__main__":
    main()
