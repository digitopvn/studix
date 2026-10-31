"""Golden tests for the reviewer-report consolidation (evidence only in Studix).

Ported from zuey-workspace@10719856:.agents/skills/anime-creator/scripts/tests/test_delivery_and_mix_tools.py
(QaGateCheckTest).
"""
from __future__ import annotations

import json

import pytest

from conftest import run_tool
from studix_qa import judge_reports as gc
from studix_qa.sandbox import ToolError


def report(agent, verdict="PASS", score=8, items=None, issues=None):
    return {"round": 1, "agent": agent, "render": {"file": "renders/sc03-r4.mp4", "verdict": verdict, "score": score,
                                                   "items": items or [{"rubric": "A1", "verdict": "PASS"}],
                                                   "issues": issues or []}}


def test_both_pass():
    res = gc.gate([report("A"), report("B", "PASS-TRIM", 7)])
    assert res["sc03-r4.mp4"]["pass"]


def test_medium_issue_failed_item_low_score_or_one_agent_blocks():
    low = {"severity": "thấp", "t": "1.0", "desc": "minor"}
    mid = {"severity": "vừa", "t": "2.0", "desc": "late hit"}
    assert gc.gate([report("A", issues=[low]), report("B")])["sc03-r4.mp4"]["pass"]
    assert not gc.gate([report("A", issues=[mid]), report("B")])["sc03-r4.mp4"]["pass"]
    bad_item = [{"rubric": "A2", "verdict": "FAIL", "t": "40.9"}]
    assert not gc.gate([report("A", items=bad_item), report("B")])["sc03-r4.mp4"]["pass"]
    assert not gc.gate([report("A", score=6.5), report("B")])["sc03-r4.mp4"]["pass"]
    assert not gc.gate([report("A")])["sc03-r4.mp4"]["pass"]


def test_json_inside_a_markdown_reply():
    text = "Report\n```json\n" + json.dumps(report("A")) + "\n```\nStatus: DONE\n"
    assert gc.parse_report(text)["agent"] == "A"


def test_text_without_json_is_a_validation_error():
    with pytest.raises(ToolError) as err:
        gc.parse_report("no json here")
    assert err.value.code == "VALIDATION"


def test_cli_reports_a_failing_render_as_a_result_not_an_error():
    response = run_tool("judge-reports", {"reports": [report("A", "FAIL", 4), json.dumps(report("B"))]})
    assert response["ok"]
    assert response["result"]["pass"] is False
    assert response["result"]["renders"][0]["file"] == "sc03-r4.mp4"
    assert any("verdict FAIL" in p for p in response["result"]["renders"][0]["problems"])
