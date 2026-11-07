"""Engine routing: pick the adapter that fills a role (local i2v, upscaler, ASR, AI judge...) and run `cli` adapters.

The table is assets/templates/engines.json; a series may override it with <series>/engines.json, merged per role and
per adapter, so one machine's engines never leak into the skill. Adding an engine of an existing kind is a JSON edit:
- `cli`: `cmd` is an argv list with {placeholders}; `output` is `stdout`, `stdout-json` or `file` ({out} is read back);
- `comfyui`: `workflow` names an API-format graph in assets/comfyui-workflows/ (generate-video-via-comfyui.py);
- `atlas-async`: a multix Atlas model with upload, submit and fetch (upscale-finished-scenes.py).
Pure helpers, plus run_cli(), which runs one command through the shared subprocess wrapper (keys never echoed).
recommend() reads the measured A/B evidence (engine_ab_and_defaults.py) and names the cheapest engine per accepted
second; it never changes a default, only `engines set-default` does, behind its A/B check.
"""
from __future__ import annotations

import copy
import json
import re
import subprocess
from pathlib import Path

from . import common_io_and_paths as io

TABLE = io.TEMPLATES / "engines.json"
WORKFLOWS = io.ASSETS / "comfyui-workflows"


def merge(base: dict, over: dict) -> dict:
    """Per-key deep merge: `over` wins, nested dicts merge (how a series engines.json overlays the skill table)."""
    out = copy.deepcopy(base)
    for k, v in over.items():
        out[k] = merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


_merge = merge


def series_dir(episode: Path | None) -> Path | None:
    """<root>/<series>/episodes/epNN -> <root>/<series>; None when the path is not inside that layout."""
    if episode is None:
        return None
    p = Path(episode).resolve()
    return p.parents[1] if len(p.parents) > 1 and p.parent.name == "episodes" else None


def load_series(series: Path | None, table: Path = TABLE) -> dict:
    """The skill table overlaid by <series>/engines.json when the series has one."""
    doc = io.load_json(table)
    if series and (Path(series) / "engines.json").exists():
        doc = merge(doc, io.load_json(Path(series) / "engines.json"))
    return doc


def load(episode: Path | None = None, table: Path = TABLE) -> dict:
    return load_series(series_dir(episode), table)


def pick(doc: dict, role: str, name: str | None = None) -> tuple[str, dict]:
    roles = doc.get("roles", {})
    if role not in roles:
        raise SystemExit(f"no role {role!r} in engines.json (have: {', '.join(sorted(roles))})")
    r = roles[role]
    name = name or r.get("default")
    adapters = r.get("adapters", {})
    if not name or name not in adapters:
        raise SystemExit(f"role {role}: no adapter {name!r}; add one to engines.json or pass --engine "
                         f"({', '.join(sorted(adapters)) or 'none yet'})")
    return name, adapters[name]


def recommend(series: Path, role: str, *, min_clips: int | None = None) -> dict:
    """The measured best engine for the exact role `role` and its evidence; advisory only. -> {role, default, engine,
    evidence, differs, ranking, insufficient}. engine is None when no engine of the role has enough rated clips.
    Raises ValueError for a role the table does not have."""
    from . import engine_ab_and_defaults as ab  # that module builds on this one
    doc = load_series(series)
    if role not in doc.get("roles", {}):
        raise ValueError(f"no role {role!r} in engines.json (have: {', '.join(sorted(doc.get('roles', {})))})")
    m = ab.measured(Path(series), role, min_clips=ab.MIN_CLIPS if min_clips is None else min_clips, production=False, exact=True)
    best = m["ranking"][0] if m["ranking"] else None
    default = doc["roles"][role].get("default")
    return {"role": role, "default": default, "engine": best, "evidence": m["engines"][best]["ab"] if best else None,
            "differs": bool(best) and best != default, "ranking": m["ranking"], "insufficient": m["insufficient"]}


def argv(adapter: dict, **values) -> list[str]:
    """Fill a `cli` adapter's cmd; a missing placeholder names itself instead of a bare KeyError."""
    cmd = adapter.get("cmd")
    if adapter.get("kind") != "cli" or not cmd:
        raise SystemExit("adapter is not a runnable `cli` kind (set kind cli and a cmd list)")
    try:
        return [str(part).format(**values) for part in cmd]
    except KeyError as e:
        raise SystemExit(f"adapter cmd needs {{{e.args[0]}}}; this script provides: {', '.join(sorted(values))}")


def json_reply(text: str):
    """The JSON object in a model reply: a ```json fence first, else the outermost {...} span; None if neither parses."""
    for m in re.finditer(r"```(?:json)?\s*\n(.*?)```", text, re.S):
        try:
            return json.loads(m.group(1))
        except ValueError:
            pass
    i, j = text.find("{"), text.rfind("}")
    if 0 <= i < j:
        try:
            return json.loads(text[i:j + 1])
        except ValueError:
            return None
    return None


def run_cli(adapter: dict, *, timeout: float | None = None, **values):
    """Run a `cli` adapter; return its result per `output` (text, parsed JSON or the {out} file's text)."""
    cmd = io.resolve_cmd(argv(adapter, **values))
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    out_kind = adapter.get("output", "stdout")
    if r.returncode:
        raise RuntimeError(f"{Path(cmd[0]).name} exited {r.returncode}: {io.redact((r.stderr or r.stdout)[-400:])}")
    if out_kind == "file":
        p = Path(values["out"])
        return p.read_text(encoding="utf-8", errors="replace") if p.suffix in (".txt", ".json", ".srt") else p
    if out_kind == "stdout-json":
        res = json_reply(r.stdout)
        if res is None:
            raise RuntimeError(f"no JSON in reply: {io.redact(r.stdout[-300:])}")
        return res
    return r.stdout
