"""Shared helpers: studio root and project paths, JSON IO, subprocess, ffprobe, secret redaction.

Every studio command takes explicit paths; nothing here hardcodes a machine. The studio root defaults to
$ANIME_STUDIO_ROOT, so scratch and renders can live on a big external volume.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Windows consoles default to a legacy code page that cannot print Vietnamese or CJK lines
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure") and (_stream.encoding or "").lower() not in ("utf-8", "utf8"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

SKILL_DIR = Path(__file__).resolve().parents[2]
ASSETS = SKILL_DIR / "assets"
TEMPLATES = ASSETS / "templates"
ENGINE_ASSET = ASSETS / "film-engine"

# anything that looks like a credential is cut from tool output before it reaches the transcript
_SECRET_KV = re.compile(r"""(api[_-]?key|xi-api-key|secret|password|token)(\s*["']?\s*[:=]\s*["']?)[^\s,;"']+""", re.I)
_BEARER = re.compile(r"(bearer\s+)[^\s,;\"']+", re.I)


def redact(text: str) -> str:
    text = _SECRET_KV.sub(lambda m: m.group(1) + m.group(2) + "[redacted]", text)
    return _BEARER.sub(lambda m: m.group(1) + "[redacted]", text)


def studio_root(arg: str | None = None) -> Path:
    root = arg or os.environ.get("ANIME_STUDIO_ROOT")
    if not root:
        sys.exit("set ANIME_STUDIO_ROOT (or pass --root) to the folder that holds series projects")
    return Path(root).expanduser().resolve()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def local_iso() -> str:
    """Local wall time with its UTC offset (2026-10-27T17:05:00+07:00): its first 19 characters read as local time,
    and the offset pins it for comparisons with UTC times."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def retry_sharing(fn, tries: int = 50):
    """Windows refuses to open a file while another process replaces it (and to replace one another process has
    open); both clear within milliseconds. Elsewhere the first call succeeds."""
    for i in range(tries):
        try:
            return fn()
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.02)


def load_json(path: Path | str):
    return json.loads(retry_sharing(lambda: Path(path).read_text(encoding="utf-8-sig")))


def save_json(path: Path | str, data, indent: int = 2) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + f".{os.getpid()}.tmp")  # per process: two writers never share one temp file
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")
    retry_sharing(lambda: tmp.replace(p))  # atomic: a crash or compaction never leaves half a state file


def append_jsonl(path: Path | str, row: dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path: Path | str) -> list[dict]:
    p = Path(path)
    if not p.exists():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def cli_override(name: str) -> list[str] | None:
    """$ANIME_CLI_<NAME> (e.g. ANIME_CLI_MULTIX="node /path/to/multix/dist/cli.js") replaces a bare program name.
    For a shim that resolves to the wrong install or not at all (version managers such as fnm put node and its
    global packages in per-shell folders); never write such a path into a script."""
    val = os.environ.get("ANIME_CLI_" + re.sub(r"\W", "_", Path(name).stem).upper())
    if not val:
        return None
    import shlex
    return [p.strip('"') for p in shlex.split(val, posix=os.name != "nt")]  # posix=False keeps C:\ backslashes


def resolve_cmd(cmd: list[str]) -> list[str]:
    """Windows runs npm shims (npx.CMD, multix.CMD) only by full path; resolve the program through PATH, after the
    $ANIME_CLI_<NAME> override."""
    if not cmd:
        return cmd
    return [*(cli_override(cmd[0]) or [shutil.which(cmd[0]) or cmd[0]]), *cmd[1:]]


def pid_alive(pid: int) -> bool:
    """True while process `pid` runs. Windows: OpenProcess + exit code (os.kill there would terminate it)."""
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        try:
            return bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def lock_owner(lock: Path) -> int | None:
    """PID written as the first word of a lock file, or None."""
    try:
        word = lock.read_text(encoding="utf-8", errors="replace").split()[0]
        return int(word)
    except (OSError, IndexError, ValueError):
        return None


def take_lock(lock: Path, note: str = "", *, wait: float = 0, poll: float = 15) -> None:
    """Create `lock` holding "<pid> <note>". An existing lock whose owner PID is dead is reclaimed (and said so); a
    live owner is waited on for up to `wait` seconds, then this exits. Never delete a lock by age or by hand without
    this check: two ep02 renders were unblocked by deleting locks only after their owner PIDs proved dead."""
    lock.parent.mkdir(parents=True, exist_ok=True)
    end, waited = time.monotonic() + wait, False
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, f"{os.getpid()} {note}".strip().encode())
            os.close(fd)
            return
        except (FileExistsError, PermissionError) as err:  # Windows: PermissionError while the old lock is being deleted
            owner = lock_owner(lock)
            if owner is not None and not pid_alive(owner):
                # rename, not unlink: one waiter wins the stale file, and a loser that took a lock created after
                # the dead one (another waiter's reclaim) sees a live pid in it and puts it back
                stale = lock.with_name(f"{lock.name}.stale.{os.getpid()}")
                try:
                    os.replace(lock, stale)
                except FileNotFoundError:
                    continue
                except PermissionError:  # held open (an indexer, AV): wait like for a live owner
                    if time.monotonic() >= end:
                        sys.exit(f"{lock} belongs to dead pid {owner} but cannot be removed; delete it by hand")
                    time.sleep(poll)
                    continue
                if lock_owner(stale) == owner:
                    print(f"reclaiming {lock.name}: owner pid {owner} is not running", file=sys.stderr)
                    stale.unlink(missing_ok=True)
                else:  # another waiter's live lock: put it back, never delete it
                    try:
                        os.link(stale, lock)
                        stale.unlink(missing_ok=True)
                    except OSError:  # no hard links (exFAT) or a new lock already there
                        try:
                            if not lock.exists():
                                os.rename(stale, lock)
                        except OSError:
                            pass
                continue
            try:
                held = lock.read_text(encoding="utf-8", errors="replace")[:120]
            except FileNotFoundError:
                if isinstance(err, FileExistsError):  # released between the create and this read
                    continue
                if os.name != "nt":  # POSIX: no lock there means the directory is not writable; waiting will not help
                    sys.exit(f"cannot create {lock}: {err.strerror}")
                held = f"cannot create it ({err.strerror})"  # Windows: also a lock still being deleted
            except PermissionError:
                held = "being released"
            if time.monotonic() >= end:
                sys.exit(f"{lock} is held by a running process ({held}); wait for it, or check that pid before deleting")
            if not waited:
                print(f"waiting for {lock.name}: {held}", file=sys.stderr, flush=True)
                waited = True
            time.sleep(poll)


_UNRELEASED: set = set()  # locks this process wrote but Windows would not let it delete


def update_json_locked(path: Path | str, fn, *, wait: float = 120.0):
    """Read-modify-write `path` under `<path>.lock`: fn gets the copy on disk now and returns what to save. Two
    processes on one file (a background --fetch beside a new submit) then never write back from stale copies."""
    p = Path(path)
    lock = p.with_name(p.name + ".lock")
    if lock in _UNRELEASED and lock_owner(lock) == os.getpid():  # this process's own leftover, not a holder
        try:
            lock.unlink()
            _UNRELEASED.discard(lock)
        except OSError:
            pass
    take_lock(lock, f"update {p.name}", wait=wait, poll=0.05)
    try:
        for i in range(5):  # a hand edit or an agent writing the file without the lock can leave it half-written
            try:
                current = load_json(p)
                break
            except ValueError:
                if i == 4:
                    raise
                time.sleep(0.2)
        data = fn(current)
        save_json(p, data)
        return data
    finally:
        for _ in range(100):  # Windows refuses the unlink while a waiter is reading the owner line
            try:
                lock.unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(0.02)
        else:  # the write itself succeeded: warn, and clear it before this process's next update
            _UNRELEASED.add(lock)
            print(f"could not release {lock} yet (pid {os.getpid()}); it is retried on the next update", file=sys.stderr)


def run(cmd: list[str], *, check: bool = True, capture: bool = True, input_bytes: bytes | None = None, cwd: str | None = None):
    r = subprocess.run(resolve_cmd(cmd), capture_output=capture, input=input_bytes, cwd=cwd)
    if check and r.returncode:
        err = (r.stderr or b"").decode(errors="ignore")[-1500:]
        sys.exit(f"command failed ({r.returncode}): {' '.join(cmd[:6])} ...\n{redact(err)}")
    return r


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


def ffprobe_duration(path: Path | str) -> float:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    return float(r.stdout.decode().strip() or 0)


def ffprobe_frames(path: Path | str) -> int:
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)])
    return int(r.stdout.decode().strip() or 0)


def frames(seconds: float, fps: float) -> int:
    return int(round(seconds * fps))
