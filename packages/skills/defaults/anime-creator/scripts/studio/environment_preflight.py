"""Environment awareness before heavy work: tools, versions, disk, memory, load, heavy processes, ports.

Prints a short table and returns a dict so the agent can decide how many render workers or parallel agents
the machine can take. Never reads credential values; it only reports whether the env file and keys exist.
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
from pathlib import Path

from .common_io_and_paths import have, resolve_cmd

TOOLS = ("ffmpeg", "ffprobe", "node", "npx", "multix", "uv", "lsof")
# heavy processes that compete with a render for CPU/RAM
HEAVY = {"chrome-headless": r"chrome.*--headless|chrome-headless-shell", "ffmpeg": r"(^|/)ffmpeg ", "hyperframes": r"hyperframes"}


def _out(cmd: list[str]) -> str:
    try:
        return subprocess.run(resolve_cmd(cmd), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def memory_gb() -> tuple[float, float]:
    """(total, available) in GB; available counts free + inactive + purgeable pages on macOS."""
    if platform.system() == "Darwin":
        total = int(_out(["sysctl", "-n", "hw.memsize"]) or 0) / 1e9
        vm = _out(["vm_stat"])
        page = int(re.search(r"page size of (\d+)", vm).group(1)) if "page size" in vm else 16384
        pages = sum(int(m) for k in ("Pages free", "Pages inactive", "Pages purgeable")
                    for m in re.findall(rf"{k}:\s+(\d+)", vm))
        return round(total, 1), round(pages * page / 1e9, 1)
    if platform.system() == "Windows":
        import ctypes

        class _Mem(ctypes.Structure):
            _fields_ = [("len", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                (n, ctypes.c_ulonglong) for n in ("total", "avail", "pf_total", "pf_avail", "v_total", "v_avail", "v_ext")]
        m = _Mem(); m.len = ctypes.sizeof(_Mem)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return round(m.total / 1e9, 1), round(m.avail / 1e9, 1)
    info = Path("/proc/meminfo").read_text(encoding="utf-8") if Path("/proc/meminfo").exists() else ""
    kb = lambda k: int(re.search(rf"{k}:\s+(\d+)", info).group(1)) if k in info else 0  # noqa: E731
    return round(kb("MemTotal") / 1e6, 1), round(kb("MemAvailable") / 1e6, 1)


def disk_free_gb(path: Path) -> float:
    p = path
    while not p.exists() and p != p.parent:
        p = p.parent
    return round(shutil.disk_usage(p).free / 1e9, 1)


def load_1m() -> float:
    """1-minute load average; Windows has none, so use CPU busy % scaled to cores as the closest equivalent."""
    if hasattr(os, "getloadavg"):
        return round(os.getloadavg()[0], 2)
    pct = _out(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average"]).strip()
    return round(float(pct or 0) / 100 * (os.cpu_count() or 1), 2)


def heavy_processes() -> dict[str, int]:
    if platform.system() == "Windows":
        ps = _out(["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"])
        ps = re.sub(r"(?mi)^\S*?ffmpeg(\.exe)?\"?\s", "/ffmpeg ", ps)
    else:
        ps = _out(["ps", "-axo", "command"])
    return {k: len(re.findall(rx, ps, re.M)) for k, rx in HEAVY.items()}


def port_owner(port: int) -> str:
    if platform.system() == "Windows":
        for line in _out(["netstat", "-ano", "-p", "TCP"]).splitlines():
            f = line.split()
            if len(f) >= 5 and f[3] == "LISTENING" and f[1].rsplit(":", 1)[-1] == str(port):
                return "pid " + f[4]
        return ""
    if not have("lsof"):
        return "unknown"
    out = _out(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"]).splitlines()
    return out[1].split()[0] + " pid " + out[1].split()[1] if len(out) > 1 else ""


def preflight(project: Path | None = None, ports: tuple[int, ...] = (), env_file: Path = Path("~/.multix/.env")) -> dict:
    rep: dict = {"platform": f"{platform.system()} {platform.machine()}", "cpus": os.cpu_count()}
    rep["tools"] = {t: bool(have(t)) for t in TOOLS}
    if have("multix"):
        rep["multix"] = (_out(["multix", "--version"]).strip().splitlines() or ["?"])[-1]
    if have("ffmpeg"):
        rep["ffmpeg"] = (_out(["ffmpeg", "-version"]).split("\n")[0].split(" ")[2:3] or ["?"])[0]
    rep["mem_total_gb"], rep["mem_avail_gb"] = memory_gb()
    rep["load_1m"] = load_1m()
    rep["disk_free_gb"] = {"home": disk_free_gb(Path.home())}
    if project:
        rep["disk_free_gb"]["project"] = disk_free_gb(project)
    rep["heavy"] = heavy_processes()
    rep["ports"] = {p: port_owner(p) for p in ports}
    ef = env_file.expanduser()
    names = re.findall(r"^\s*(?:export\s+)?([A-Z0-9_]+)=", ef.read_text(encoding="utf-8"), re.M) if ef.exists() else []
    rep["env_keys"] = {k: (k in names) for k in ("ATLASCLOUD_API_KEY", "ELEVENLABS_API_KEY", "GEMINI_API_KEY")}
    # how many headless Chrome render workers fit: ~1.2 GB each, keep 3 GB for the OS, cap at 4
    rep["render_workers"] = max(1, min(4, int((rep["mem_avail_gb"] - 3) / 1.2), (rep["cpus"] or 2) // 2))
    if rep["load_1m"] > (rep["cpus"] or 2):  # another job owns the CPU: one worker, never more
        rep["render_workers"] = 1
    warn = []
    if rep["disk_free_gb"]["home"] < 20:
        warn.append("internal disk under 20 GB: keep renders and scratch on the project volume")
    if project and rep["disk_free_gb"].get("project", 99) < 15:
        warn.append("project volume under 15 GB: a 15 s 1080p episode needs ~3 GB, a 20 min one ~60 GB")
    if rep["heavy"]["chrome-headless"] or rep["heavy"]["ffmpeg"] > 1:
        warn.append("another render or encode is running: run heavy jobs one at a time")
    if rep["load_1m"] > (rep["cpus"] or 4):
        warn.append("load above core count: wait or lower workers")
    missing = [t for t, ok in rep["tools"].items() if not ok and t != "lsof"]
    if missing:
        warn.append("missing tools: " + ", ".join(missing))
    rep["warnings"] = warn
    return rep


def print_report(rep: dict) -> None:
    print(f"platform {rep['platform']}  cpus {rep['cpus']}  load {rep['load_1m']}  mem {rep['mem_avail_gb']}/{rep['mem_total_gb']} GB free")
    print("disk free GB: " + ", ".join(f"{k} {v}" for k, v in rep["disk_free_gb"].items()))
    print("tools: " + " ".join(f"{t}{'' if ok else '(missing)'}" for t, ok in rep["tools"].items()) + (f"  multix {rep['multix']}" if "multix" in rep else ""))
    print("env keys present: " + ", ".join(f"{k} {'yes' if v else 'no'}" for k, v in rep["env_keys"].items()))
    print("heavy processes: " + ", ".join(f"{k} {v}" for k, v in rep["heavy"].items()))
    for p, owner in rep["ports"].items():
        print(f"port {p}: {owner or 'free'}")
    print(f"suggested render workers: {rep['render_workers']}")
    for w in rep["warnings"]:
        print("WARN " + w)
