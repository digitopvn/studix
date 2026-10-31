"""judge-reports: consolidate AI reviewer reports into one verdict per render, so nobody re-reads long reports to
find the one FAIL.

Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/qa-gate-check.py. In the source this
was the two-agent QA gate; in Studix a model's verdict is evidence only: the worker records this result next to
the hard checks and the human review decides. The consolidation rules are unchanged:

Each report is `{"round", "agent", "render": {file, verdict, score, items[], issues[]}}` (or `"renders": [...]`);
items carry `rubric`, `verdict`, `t`, `desc`; issues carry `severity`, `t`, `frames`, `desc`, `fix`. A report may
also be the raw text of a reply with a JSON block inside. A render passes when every agent's verdict and every
item is PASS (PASS-TRIM counts), every score is >= minScore, no issue is high or medium ("cao"/"vừa"), and at
least `agents` distinct agents reported on it.
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import PurePath

from .sandbox import Deadline, Media, ToolError

BLOCKING = {"cao", "vừa", "vua", "high", "medium", "critical", "major"}
MAX_REPORT_CHARS = 2_000_000


def parse_report(raw: object) -> dict:
    """A report object, or the text of a reply: whole-text JSON first, then the outermost {...} inside it."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        raise ToolError("VALIDATION", "a report must be an object or the text of a reply")
    if len(raw) > MAX_REPORT_CHARS:
        raise ToolError("VALIDATION", "report text is too large")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        i, j = raw.find("{"), raw.rfind("}")
        if i < 0 or j <= i:
            raise ToolError("VALIDATION", "no JSON object found in the report text") from None
        try:
            parsed = json.loads(raw[i:j + 1])
        except json.JSONDecodeError as err:
            raise ToolError("VALIDATION", f"report JSON is malformed: {err.msg}") from err
    if not isinstance(parsed, dict):
        raise ToolError("VALIDATION", "a report must be a JSON object")
    return parsed


def renders(report: dict) -> list[dict]:
    if isinstance(report.get("render"), dict):
        return [report["render"]]
    return [r for r in report.get("renders") or [] if isinstance(r, dict)]


def is_pass(verdict) -> bool:
    return str(verdict or "").strip().upper().startswith("PASS")


def render_problems(r: dict, min_score: float) -> list[str]:
    """Why one agent's verdict on one render fails (empty = it passes)."""
    out = []
    if not is_pass(r.get("verdict")):
        out.append(f"verdict {r.get('verdict')}")
    score = r.get("score")
    try:
        low = score is None or float(score) < min_score
    except (TypeError, ValueError):
        low = True
    if low:
        out.append(f"score {score} < {min_score:g}")
    for it in r.get("items") or []:
        if isinstance(it, dict) and not is_pass(it.get("verdict")):
            out.append(f"item {it.get('rubric', '?')} {it.get('verdict')} @ {it.get('t', '')}".rstrip(" @"))
    for iss in r.get("issues") or []:
        if isinstance(iss, dict) and str(iss.get("severity", "")).strip().lower() in BLOCKING:
            out.append(f"{iss.get('severity')} issue @ {iss.get('t', '?')}: {str(iss.get('desc', ''))[:90]}")
    return out


def gate(reports: list[dict], need_agents: int = 2, min_score: float = 7.0) -> dict:
    """{render file: {"agents": [...], "pass": bool, "problems": [...]}}"""
    by_file: dict = defaultdict(lambda: {"agents": [], "problems": []})
    for rep in reports:
        agent = str(rep.get("agent", "?"))
        for r in renders(rep):
            key = PurePath(str(r.get("file", "?")).replace("\\", "/")).name
            slot = by_file[key]
            slot["agents"].append(agent)
            slot["problems"] += [f"{agent}: {p}" for p in render_problems(r, min_score)]
    for slot in by_file.values():
        if len(set(slot["agents"])) < need_agents:
            slot["problems"].append(f"only {len(set(slot['agents']))} agent(s) reported, need {need_agents}")
        slot["pass"] = not slot["problems"]
    return dict(by_file)


def run(payload: dict, _media: Media, _deadline: Deadline, _outputs) -> dict:
    raw = payload.get("reports")
    if not isinstance(raw, list) or not raw:
        raise ToolError("VALIDATION", "reports must be a non-empty array")
    agents = int(payload.get("agents", 2))
    if agents < 1:
        raise ToolError("VALIDATION", "agents must be >= 1")
    result = gate([parse_report(r) for r in raw], agents, float(payload.get("minScore", 7.0)))
    return {"renders": [{"file": k, **v} for k, v in result.items()],
            "pass": bool(result) and all(v["pass"] for v in result.values())}
