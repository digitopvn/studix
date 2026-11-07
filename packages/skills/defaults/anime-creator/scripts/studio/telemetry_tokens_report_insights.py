"""Token meter, process report, run registry and cross-run insights.

tokens    Claude usage from the session transcript (+ its subagents/), de-duplicated by message.id, split by the
          phase_start events of the trace, priced from the price table's `tokens` section (API-equivalent).
report    fills assets/templates/process-report.md with everything measurable (phases, gates, decisions,
          workarounds, errors, retakes, QA findings, ledger, tokens, utilization); the agent then writes only
          the narrative sections marked <!-- agent -->.
finish    closes the run: one summary row in <series>/runs.jsonl and <studio-root>/runs.jsonl.
insights  aggregates runs.jsonl: cost and tokens per film second, utilization, gate rejections and the tags
          that keep coming back. A tag in 2+ runs is a candidate for a script or a SKILL.md failure-mode line.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime
from pathlib import Path

from .common_io_and_paths import TEMPLATES, append_jsonl, load_json, now_iso, read_jsonl
from . import rebuild_plan_and_unit_cost as rp
from .telemetry_trace_and_ledger import current_run, ledger, run_events

KEYS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
PRICE_KEYS = {"input_tokens": "input", "cache_creation_input_tokens": "cache_write", "cache_read_input_tokens": "cache_read",
              "output_tokens": "output"}


def _ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def transcript_files(transcript: Path, subagents: bool = True) -> list[Path]:
    files = [transcript]
    sub = transcript.with_suffix("") / "subagents"
    if subagents and sub.is_dir():
        files += sorted(sub.glob("*.jsonl"))
    return files


def token_usage(files: list[Path], start: str, end: str | None, phases: list[tuple[str, str]], prices: dict) -> dict:
    t0, t1 = _ts(start), (_ts(end) if end else None)
    ph = sorted(((n, _ts(t)) for n, t in phases), key=lambda x: x[1])
    msgs = {}
    for f in files:
        with f.open(errors="ignore", encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                m = r.get("message") if isinstance(r.get("message"), dict) else {}
                u, t = m.get("usage"), r.get("timestamp")
                if r.get("type") != "assistant" or not u or not t:
                    continue
                tt = _ts(t)
                if tt < t0 or (t1 and tt > t1):
                    continue
                msgs[m.get("id") or r.get("uuid")] = (tt, u, m.get("model", "?"), f.name != files[0].name)
    tok_prices = prices.get("tokens", {})

    def rate(model: str) -> dict:
        return next((v for k, v in tok_prices.items() if model.startswith(k)), {})

    per: dict[str, dict] = {}
    for tt, u, model, is_sub in msgs.values():
        name = "pre"
        for n, s in ph:
            if tt >= s:
                name = n
        p = per.setdefault(name, {**{k: 0 for k in KEYS}, "calls": 0, "usd": 0.0, "subagent_calls": 0})
        p["calls"] += 1
        p["subagent_calls"] += int(is_sub)
        r = rate(model)
        for k in KEYS:
            v = u.get(k) or 0
            p[k] += v
            p["usd"] += v / 1e6 * float(r.get(PRICE_KEYS[k], 0))
    tot = {k: sum(p[k] for p in per.values()) for k in (*KEYS, "calls", "subagent_calls")}
    tot["usd"] = round(sum(p["usd"] for p in per.values()), 3)
    for p in per.values():
        p["usd"] = round(p["usd"], 3)
    return {"phases": per, "total": tot, "files": len(files)}


def tokens_for_run(episode_dir: Path, prices: dict, transcript: str | None = None) -> dict | None:
    ev = run_events(episode_dir)
    start = next((e for e in ev if e["event"] == "run_start"), None)
    tr = transcript or (start or {}).get("transcript")
    if not start or not tr or not Path(tr).exists():
        return None
    end = next((e["ts"] for e in reversed(ev) if e["event"] == "run_end"), None)
    phases = [(e["phase"], e["ts"]) for e in ev if e["event"] == "phase_start"]
    return token_usage(transcript_files(Path(tr)), start["ts"], end, phases, prices)


def _bullets(ev: list[dict], kind: str) -> str:
    rows = [e for e in ev if e["event"] == kind]
    if not rows:
        return "- none recorded\n"
    return "".join(f"- {e['ts'][11:16]} {('[' + e['tag'] + '] ') if e.get('tag') else ''}{e.get('shot', '') + ': ' if e.get('shot') else ''}"
                   f"{e.get('detail', '')}\n" for e in rows)


def report(episode_dir: Path, prices: dict, *, transcript: str | None = None, fetch: bool = True) -> Path:
    ev = run_events(episode_dir)
    ep = load_json(episode_dir / "episode.json")
    lg = ledger(episode_dir, fetch=fetch)
    tk = tokens_for_run(episode_dir, prices, transcript)
    secs = sum(load_json(episode_dir / "scenes" / s / "edl.json")["duration"] for s in ep["scenes"]) if ep["scenes"] else 0
    phases = [e for e in ev if e["event"] in ("phase_start", "phase_end")]
    ph_lines = "".join(f"| {e['ts'][11:19]} | {e['event'].replace('phase_', '')} | {e['phase']} | {e.get('detail', '')} |\n" for e in phases) or "| | | | |\n"
    gates = "".join(f"| {g['gate']} | {g['status']} | {g['ts'][:16]} | {g.get('note', '')} |\n" for g in ep.get("gate_log", [])) or "| | | | |\n"
    money = lambda v: "" if v is None else f"{v:.4f}"  # noqa: E731
    led = "".join(f"| {r['kind']} | {r['name']} | {r['model']} | {r['status']} | {money(r['cost_usd'])} |\n"
                  for r in lg["rows"]) or "| | | | | |\n"
    if tk:
        tok = "".join(f"| {n} | {p['calls']} | {p['subagent_calls']} | {p['output_tokens']:,} | {p['cache_read_input_tokens']:,} | ${p['usd']:.2f} |\n"
                      for n, p in tk["phases"].items())
        tok += f"| **total** | {tk['total']['calls']} | {tk['total']['subagent_calls']} | {tk['total']['output_tokens']:,} | {tk['total']['cache_read_input_tokens']:,} | **${tk['total']['usd']:.2f}** |\n"
    else:
        tok = "| (no transcript linked: run `anime-studio.py run-start --transcript <session.jsonl>`) | | | | | |\n"
    tools = Counter(e["tool"] for e in ev if e.get("tool"))
    fill = {
        "{{EPISODE}}": episode_dir.name, "{{RUN}}": current_run(episode_dir), "{{DATE}}": now_iso()[:10],
        "{{SECONDS}}": f"{secs:.2f}", "{{CASH_USD}}": f"{lg['total_usd']:.3f}",
        "{{CASH_PER_SEC}}": f"{lg['total_usd'] / secs:.3f}" if secs else "n/a",
        "{{TOKENS_USD}}": f"{tk['total']['usd']:.2f}" if tk else "n/a",
        "{{CEILING}}": f"{ep.get('ceiling_usd', 0):.2f}", "{{PHASES}}": ph_lines, "{{GATES}}": gates,
        "{{DECISIONS}}": _bullets(ev, "decision"), "{{WORKAROUNDS}}": _bullets(ev, "workaround"),
        "{{ERRORS}}": _bullets(ev, "error"), "{{RETAKES}}": _bullets(ev, "retake"), "{{QA}}": _bullets(ev, "qa_finding"),
        "{{LEDGER}}": led, "{{BY_KIND}}": ", ".join(f"{k} ${v:.3f}" for k, v in sorted(lg["by_kind"].items())) or "none",
        "{{TOKENS}}": tok, "{{TOOLS}}": ", ".join(f"{k} x{v}" for k, v in tools.most_common()) or "not traced",
    }
    txt = (TEMPLATES / "process-report.md").read_text(encoding="utf-8")
    for k, v in fill.items():
        txt = txt.replace(k, v.rstrip("\n"))
    out = episode_dir / "reports" / f"process-report-{current_run(episode_dir)}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(txt, encoding="utf-8")
    return out


def finish(episode_dir: Path, prices: dict, studio_root: Path, *, lessons: list[str] = (), scores: dict | None = None,
           fetch: bool = True) -> dict:
    ev = run_events(episode_dir)
    ep = load_json(episode_dir / "episode.json")
    lg = ledger(episode_dir, fetch=fetch)
    tk = tokens_for_run(episode_dir, prices)
    secs = sum(load_json(episode_dir / "scenes" / s / "edl.json")["duration"] for s in ep["scenes"]) if ep["scenes"] else 0
    tags = Counter(e["tag"] for e in ev if e.get("tag"))
    row = {"run": current_run(episode_dir), "series": episode_dir.parents[1].name, "episode": episode_dir.name, "ended": now_iso(),
           "seconds": secs, "cash_usd": lg["total_usd"], "by_kind": lg["by_kind"],
           "tokens_usd": tk["total"]["usd"] if tk else None, "calls": tk["total"]["calls"] if tk else None,
           "gate_rejections": sum(1 for g in ep.get("gate_log", []) if g["status"] in ("changes", "rejected")),
           "retakes": sum(1 for e in ev if e["event"] == "retake"), "errors": sum(1 for e in ev if e["event"] == "error"),
           "tags": dict(tags), "scores": scores or {}, "lessons": list(lessons)}
    uc = rp.unit_cost(episode_dir, ledger=lg, tokens=tk)  # seconds the EDLs show of generated video, not the cut length
    row.update({k: uc[k] for k in ("accepted_seconds", "generated_seconds", "yield", "cost_per_accepted_second")})
    append_jsonl(episode_dir.parents[1] / "runs.jsonl", row)
    append_jsonl(studio_root / "runs.jsonl", row)
    return row


def insights(studio_root: Path) -> str:
    rows = read_jsonl(studio_root / "runs.jsonl")
    if not rows:
        return "no runs yet"
    secs = sum(r.get("seconds") or 0 for r in rows)
    cash = sum(r.get("cash_usd") or 0 for r in rows)
    tok = sum(r.get("tokens_usd") or 0 for r in rows)
    tags = Counter()
    seen_in = Counter()
    for r in rows:
        tags.update(r.get("tags") or {})
        seen_in.update(set((r.get("tags") or {}).keys()))
    out = [f"runs {len(rows)}  film {secs:.1f}s  cash ${cash:.2f} (${cash / secs:.3f}/s)  tokens ${tok:.2f} (${tok / secs:.3f}/s)" if secs else f"runs {len(rows)}",
           f"gate rejections {sum(r.get('gate_rejections', 0) for r in rows)}  retakes {sum(r.get('retakes', 0) for r in rows)}  errors {sum(r.get('errors', 0) for r in rows)}"]
    rec = [(t, n, seen_in[t]) for t, n in tags.most_common() if seen_in[t] >= 2]
    if rec:
        out.append("recurring tags (in 2+ runs): candidates for a script or a SKILL.md failure-mode line")
        out += [f"  {t}: {n} events in {k} runs" for t, n, k in rec]
    lessons = [l for r in rows[-5:] for l in r.get("lessons", [])]
    if lessons:
        out.append("latest lessons:")
        out += [f"  - {l}" for l in lessons[-12:]]
    return "\n".join(out)
