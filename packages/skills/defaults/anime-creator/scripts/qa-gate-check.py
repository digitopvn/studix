#!/usr/bin/env python3
"""Decide the two-agent QA gate from the agents' JSON reports, so nobody re-reads two long reports to find one FAIL.

usage: python -X utf8 qa-gate-check.py <qa-a.json> <qa-b.json> [more.json ...] [--agents 2] [--min-score 7]

Each report is `{"round", "agent", "render": {file, verdict, score, items[], issues[]}}` (or `"renders": [...]`);
items carry `rubric`, `verdict`, `t`, `desc`; issues carry `severity`, `t`, `frames`, `desc`, `fix`. A JSON block
inside a markdown reply is found too. A render passes when every agent's verdict and every item is PASS (PASS-TRIM
counts), every score is >= --min-score, no issue is high or medium ("cao"/"vừa"), and at least --agents distinct
agents reported on it. Exit 0 when every render passes, 1 otherwise; the blocking reasons are printed per render.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

BLOCKING = {"cao", "vừa", "vua", "high", "medium", "critical", "major"}


def load_report(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        i, j = text.find("{"), text.rfind("}")
        if i < 0 or j <= i:
            raise SystemExit(f"{path}: no JSON object found")
        return json.loads(text[i:j + 1])


def renders(report: dict) -> list[dict]:
    if isinstance(report.get("render"), dict):
        return [report["render"]]
    return list(report.get("renders") or [])


def is_pass(verdict) -> bool:
    return str(verdict or "").strip().upper().startswith("PASS")


def render_problems(r: dict, min_score: float) -> list[str]:
    """Why one agent's verdict on one render blocks the gate (empty = it passes)."""
    out = []
    if not is_pass(r.get("verdict")):
        out.append(f"verdict {r.get('verdict')}")
    score = r.get("score")
    if score is None or float(score) < min_score:
        out.append(f"score {score} < {min_score:g}")
    for it in r.get("items") or []:
        if not is_pass(it.get("verdict")):
            out.append(f"item {it.get('rubric', '?')} {it.get('verdict')} @ {it.get('t', '')}".rstrip(" @"))
    for iss in r.get("issues") or []:
        if str(iss.get("severity", "")).strip().lower() in BLOCKING:
            out.append(f"{iss.get('severity')} issue @ {iss.get('t', '?')}: {str(iss.get('desc', ''))[:90]}")
    return out


def gate(reports: list[dict], need_agents: int = 2, min_score: float = 7.0) -> dict:
    """{render file: {"agents": [...], "pass": bool, "problems": [...]}}"""
    by_file: dict = defaultdict(lambda: {"agents": [], "problems": []})
    for rep in reports:
        agent = str(rep.get("agent", "?"))
        for r in renders(rep):
            key = Path(str(r.get("file", "?"))).name
            slot = by_file[key]
            slot["agents"].append(agent)
            slot["problems"] += [f"{agent}: {p}" for p in render_problems(r, min_score)]
    for slot in by_file.values():
        if len(set(slot["agents"])) < need_agents:
            slot["problems"].append(f"only {len(set(slot['agents']))} agent(s) reported, need {need_agents}")
        slot["pass"] = not slot["problems"]
    return dict(by_file)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):  # severities are Vietnamese; a cp1252 console would crash on them
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("reports", nargs="+")
    ap.add_argument("--agents", type=int, default=2)
    ap.add_argument("--min-score", type=float, default=7.0)
    a = ap.parse_args()
    result = gate([load_report(Path(p)) for p in a.reports], a.agents, a.min_score)
    for name, slot in result.items():
        print(f"{'PASS' if slot['pass'] else 'FAIL'}  {name}  agents {','.join(slot['agents'])}")
        for p in slot["problems"]:
            print(f"   - {p}")
    sys.exit(0 if result and all(s["pass"] for s in result.values()) else 1)


if __name__ == "__main__":
    main()
