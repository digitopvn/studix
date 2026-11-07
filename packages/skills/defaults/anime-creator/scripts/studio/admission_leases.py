"""Admission control for job runners: one heavy (GPU/local) job per machine, and per-provider submit concurrency.

A lease is a file <dir>/<key>.<slot>.json created with O_EXCL:
  {key, slot, resource, provider, job, episode, pid, start, host, token, acquired_at, expires_at}
key "heavy" has one slot per machine, in machine_lease_dir() (~/.anime-studio/leases, or $ANIME_STUDIO_LEASES): at
most one GPU job runs at a time whatever series it belongs to, since they share one GPU's VRAM.
generate-video-via-comfyui.py takes it around every job; the media runner refuses local GPU jobs instead.
key "provider-<name>" has as many slots as episode.json `admission.providers` allows, in <series>/catalog/leases/. A
provider slot is held only while a job submits (upload, request, and for a synchronous job its download): it limits
concurrent submits to that provider, not predictions still running on the provider after an async submit. A
provider with no limit takes no lease, so a run without `admission` config behaves as before.
Liveness: a lease from this host whose owner's start time was recorded is live exactly while that pid runs with that
start time (pid reuse cannot keep it alive, and a long job is never taken from a live owner); expires_at decides
only a lease from another host, one without a start time, or one whose owner runs under an account this one may not
inspect. Reclaiming a dead lease and releasing one both unlink it under the lock <lease>.reclaim (hard-linked in
already written, abandoned after LOCK_TTL_S whoever holds it), and only if its token is still the one judged dead
(or owned): a lease file is never moved aside, so no other process's lease is ever absent while it is handled.
Config, all optional, in episode.json: {"admission": {"providers": {"atlas": 2}, "ttl_s": 3600, "wait_s": 600}}.
wait_s is how long a job waits for a slot before it is held (left as it was, nothing submitted).
"""
from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import uuid
from pathlib import Path

from . import common_io_and_paths as io

LOCAL_PROVIDERS = ("comfyui", "local")
HEAVY = "heavy"
DEFAULTS = {"providers": {}, "ttl_s": 3600, "wait_s": 600}
UNREADABLE_GRACE_S = 60  # a lease file still unreadable this long after creation was cut off mid-write
LOCK_TTL_S = 30  # a reclaim lock is held for milliseconds; one older than this is abandoned, whoever holds it
LOCK_GRACE_S = 2  # a lock is linked in already written, so an unreadable one is debris after this
HOST = socket.gethostname()
UNKNOWN = object()  # proc_start: the process exists, but this account may not read its start time


class Busy(Exception):
    """No slot is free for a lease this job needs; the message names who holds it."""


class Unwritable(RuntimeError):
    """The lease folder cannot be written: no runner can be admitted until it is fixed."""


def proc_start(pid: int):
    """When process `pid` started, in the OS's own units (Windows FILETIME, Linux clock ticks since boot): with the
    pid it names one process, never a reused pid. None when it is not running or this OS gives no start time;
    UNKNOWN when it runs under an account this one may not inspect (then only expires_at can judge its lease)."""
    if pid <= 0:
        return None
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return UNKNOWN if ctypes.get_last_error() == 5 else None  # ERROR_ACCESS_DENIED: alive, not ours to read
        try:
            t = [wintypes.FILETIME() for _ in range(4)]
            code = wintypes.DWORD()
            if not k32.GetExitCodeProcess(wintypes.HANDLE(h), ctypes.byref(code)) or code.value != 259:  # STILL_ACTIVE
                return None
            if not k32.GetProcessTimes(wintypes.HANDLE(h), *(ctypes.byref(x) for x in t)):
                return None
            return (t[0].dwHighDateTime << 32) | t[0].dwLowDateTime
        finally:
            k32.CloseHandle(wintypes.HANDLE(h))
    try:  # Linux: field 22 of /proc/<pid>/stat, counted after the parenthesised command name
        return int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])
    except PermissionError:
        return UNKNOWN
    except (OSError, IndexError, ValueError):
        return None


START = proc_start(os.getpid())
START = None if START is UNKNOWN else START  # a lease without a start time is judged by expires_at


def lease_dir(series: Path) -> Path:
    """Provider slots: per series."""
    return series / "catalog" / "leases"


def machine_lease_dir() -> Path:
    """The heavy slot: one per machine, since every series shares its GPU. $ANIME_STUDIO_LEASES, else
    ~/.anime-studio/leases (beside ~/.multix and ~/.codex, the other per-user tool folders)."""
    return Path(os.environ.get("ANIME_STUDIO_LEASES") or Path.home() / ".anime-studio" / "leases").expanduser()


def _dir(series: Path | None, key: str) -> Path:
    if key == HEAVY:
        return machine_lease_dir()
    if series is None:
        raise ValueError(f"lease {key} is per series: pass the series folder")
    return lease_dir(series)


def resource_of(job: dict) -> str:
    """gpu-local for a job on the local GPU (ComfyUI), else paid-api."""
    return "gpu-local" if job.get("provider") in LOCAL_PROVIDERS or job.get("resource") == "gpu-local" else "paid-api"


def provider_of(job: dict, voice: dict | None = None) -> str:
    """The provider a job calls: its own `provider`, else what the runner routes that kind to."""
    if job.get("provider"):
        return job["provider"]
    k = job.get("kind")
    if k in ("sheet", "keyframe", "video", "upscale", "run"):
        return "atlas"
    if k == "qa":
        return "gemini"
    if k == "sfx" and job.get("mode") == "video-to-audio":
        return "fal"
    if k == "tts" and isinstance(voice, dict) and voice.get("provider"):
        return voice["provider"]
    return "elevenlabs"


def config(episode_dir: Path) -> dict:
    p = episode_dir / "episode.json"
    raw = (io.load_json(p) if p.exists() else {}).get("admission") or {}
    if not isinstance(raw, dict):
        raise SystemExit(f"{p}: `admission` must be an object")
    cfg = {**DEFAULTS, **raw}
    lim = cfg["providers"]
    if not isinstance(lim, dict) or not all(isinstance(v, int) and not isinstance(v, bool) and v >= 1 for v in lim.values()):
        raise SystemExit(f"{p}: admission.providers maps a provider to a whole number of slots >= 1 (got {lim!r})")
    for k in ("ttl_s", "wait_s"):
        if not isinstance(cfg[k], (int, float)) or isinstance(cfg[k], bool) or cfg[k] < 0:
            raise SystemExit(f"{p}: admission.{k} must be seconds >= 0 (got {cfg[k]!r})")
    return cfg


def needs(job: dict, cfg: dict, voice: dict | None = None) -> list[tuple[str, int]]:
    """[(key, slots)] a cloud job must hold while it submits: its provider's slot when that provider is limited."""
    p = provider_of(job, voice)
    return [(f"provider-{p}", cfg["providers"][p])] if p in cfg["providers"] else []


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _read(p: Path) -> dict | None:
    """A lease row, or None when missing, unreadable or malformed (no numeric expires_at): judged by file age."""
    try:
        row = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return row if isinstance(row, dict) and _num(row.get("expires_at")) else None


def is_live(row: dict | None, p: Path, now: float | None = None) -> bool:
    now = time.time() if now is None else now
    if row is None:  # created but not written yet, or cut off: live for a short grace, then reclaimable
        try:
            return now - p.stat().st_mtime < UNREADABLE_GRACE_S
        except OSError:
            return False
    pid = row.get("pid")
    if row.get("host") == HOST and isinstance(pid, int):
        if row.get("start") is not None:  # this host, a known process: alive or not, whatever the clock says
            started = proc_start(pid)
            if started is not UNKNOWN:
                return started == row["start"]
        elif not io.pid_alive(pid):
            return False
    return now < row["expires_at"]


def _lock_live(row: dict | None, lock: Path, now: float | None = None) -> bool:
    """A reclaim lock is held for milliseconds: abandoned once LOCK_TTL_S passes even if its owner still runs (hung
    or suspended), and an unreadable one after LOCK_GRACE_S."""
    now = time.time() if now is None else now
    if row is None:
        try:
            return now - lock.stat().st_mtime < LOCK_GRACE_S
        except OSError:
            return False
    return now < row["expires_at"] and is_live(row, lock, now)


def _create(p: Path, row: dict) -> bool:
    """O_EXCL create. False when the file exists (or, on Windows, is still being deleted); Unwritable when the
    folder refuses new files."""
    for i in range(20):
        try:
            fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        except PermissionError as e:
            if p.exists():
                return False
            if os.name != "nt" or i == 19:  # Windows: a file pending deletion refuses for a few ms, then frees
                raise Unwritable(f"cannot create a lease in {p.parent}: {e.strerror}; fix its permissions") from e
            time.sleep(0.01)
            continue
        except OSError as e:
            raise Unwritable(f"cannot create a lease in {p.parent}: {e.strerror}") from e
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(row))
        return True
    return False


def _create_filled(p: Path, row: dict) -> bool:
    """Like _create, but p appears already written: the row goes to a temp file that is hard-linked to p (the link
    fails if p exists). A filesystem without hard links falls back to _create."""
    tmp = p.with_name(f"{p.name}.{row['token']}.tmp")
    try:
        tmp.write_text(json.dumps(row), encoding="utf-8")
    except OSError as e:
        raise Unwritable(f"cannot create a lease lock in {p.parent}: {e.strerror}") from e
    try:
        for i in range(20):
            try:
                os.link(tmp, p)
                return True
            except FileExistsError:
                return False
            except PermissionError:
                if p.exists():
                    return False
                if os.name == "nt" and i < 19:  # a file pending deletion refuses for a few ms, then frees
                    time.sleep(0.01)
                    continue
                return _create(p, row)
            except OSError:
                return _create(p, row)
        return False
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass  # a stray .tmp beside the lock is never read


def _owner(ttl: float) -> dict:
    return {"pid": os.getpid(), "start": START, "host": HOST, "token": uuid.uuid4().hex, "expires_at": round(time.time() + ttl, 3)}


def _locked_unlink(p: Path, token, *, judge=None, wait: float = 0.0) -> bool:
    """Unlink p under <p>.reclaim, only if its token is still `token` (and judge(row) agrees). Nobody else can
    unlink p meanwhile, and nobody can create it while it exists, so the check and the unlink cannot be split."""
    lock = p.with_name(p.name + ".reclaim")
    end = time.monotonic() + wait
    while not _create_filled(lock, {"op": "reclaim", **_owner(LOCK_TTL_S)}):
        held = _read(lock)
        if not _lock_live(held, lock):  # a reclaimer died or hung holding it: same token-checked removal, one level down
            if _locked_unlink(lock, (held or {}).get("token")):
                continue
        if time.monotonic() >= end:
            return False
        time.sleep(0.005)
    try:
        cur = _read(p)
        if not p.exists() or (cur or {}).get("token") != token or (judge and not judge(cur)):
            return False
        io.retry_sharing(lambda: p.unlink(missing_ok=True))
        return True
    finally:
        try:
            io.retry_sharing(lambda: lock.unlink(missing_ok=True))
        except OSError as e:  # a stuck lock frees itself: its owner's pid ends, or LOCK_TTL_S passes
            print(f"could not remove {lock.name}: {e}", file=sys.stderr)


def _reclaim(p: Path, old: dict | None) -> None:
    if _locked_unlink(p, (old or {}).get("token"), judge=lambda cur: not is_live(cur, p)):
        print(f"reclaiming lease {p.name}: " + (f"pid {old.get('pid')} on {old.get('host')}, job {old.get('job')}" if old else "unreadable"),
              file=sys.stderr)


def acquire(series: Path | None, key: str, slots: int, owner: dict, ttl: float) -> dict | None:
    """Take a free slot of `key`, reclaiming dead ones. -> the lease (with `path`), or None when every slot is live.
    series may be None for the heavy slot, which is machine-wide."""
    d = _dir(series, key)
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise Unwritable(f"cannot create the lease folder {d}: {e.strerror}") from e
    for slot in range(slots):
        p = d / f"{key}.{slot}.json"
        row = {"key": key, "slot": slot, **owner, **_owner(ttl), "acquired_at": io.now_iso()}
        for _ in range(2):  # once more after a reclaim
            if _create(p, row):
                return {**row, "path": str(p)}
            old = _read(p)
            if not p.exists() or is_live(old, p):
                break
            _reclaim(p, old)
    return None


def release(lease: dict) -> None:
    p = Path(lease["path"])
    try:
        if _locked_unlink(p, lease["token"], wait=10):
            return
    except OSError as e:  # an undeletable lease only delays others until its owner (this process) ends
        print(f"could not release {p.name}: {e}; it frees itself when this process ends", file=sys.stderr)
        return
    if (_read(p) or {}).get("token") != lease["token"]:
        print(f"lease {p.name} was reclaimed before release", file=sys.stderr)
    else:
        print(f"could not release {p.name} (its reclaim lock stayed busy); it frees itself when this process ends", file=sys.stderr)


def acquire_all(series: Path | None, need: list[tuple[str, int]], owner: dict, *, ttl: float, wait: float = 0,
                poll: float = 1.0, stop: threading.Event | None = None) -> list[dict]:
    """Every lease in `need`, or none: waits up to `wait` seconds, then raises Busy naming the holder."""
    deadline = time.monotonic() + wait
    while True:
        held, missing = [], None
        for key, slots in need:
            lease = acquire(series, key, slots, owner, ttl)
            if lease is None:
                missing = key
                break
            held.append(lease)
        if missing is None:
            return held
        for lease in held:
            release(lease)
        if time.monotonic() >= deadline or (stop is not None and stop.is_set()):
            holders = [r for r in listing(series) if r["key"] == missing and r["live"]]
            who = "; ".join(f"pid {r.get('pid')} on {r.get('host')} job {r.get('job')} until {r.get('expires')}" for r in holders)
            raise Busy(f"no free {missing} lease ({who or 'held'})")
        time.sleep(poll)


def listing(series: Path | None) -> list[dict]:
    """Every lease file, live or not: the machine's heavy slot (whichever series holds it) and the series' provider
    slots. -> [{key, slot, job, episode, pid, host, live, expires, path, ...}]."""
    now, out = time.time(), []
    files = sorted(machine_lease_dir().glob(f"{HEAVY}.*.json")) if machine_lease_dir().is_dir() else []
    if series is not None and lease_dir(series).is_dir():
        files += sorted(p for p in lease_dir(series).glob("*.json") if not p.name.startswith(f"{HEAVY}."))
    for p in files:
        row = _read(p)
        exp = (row or {}).get("expires_at")
        out.append({**(row or {"key": p.name.rsplit(".", 2)[0], "unreadable": True}), "path": p.as_posix(),
                    "live": is_live(row, p, now),
                    "expires": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(exp)) if exp else None})
    return out
