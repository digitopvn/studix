"""Run trace and measured cost ledger.

trace   one JSON line per event in <episode>/logs/trace.jsonl:
        {ts, run, episode, phase, event, detail, shot, tag, tool, cost_usd, pred_id, gate, status, ...}
        events: run_start, run_end, phase_start, phase_end, gate, decision, workaround, error, retake,
        qa_finding, gen_submit, gen_done, note. `tag` is a short stable label (e.g. "omni-misread-hanzi",
        "cut-off-limb") so recurring problems can be counted across runs by `insights`.
ledger  every paid job: Atlas predictions read back from the API (data.price is the billed price, which can be
        18x the catalog price), plus non-Atlas jobs from gen-plan.json (ElevenLabs credits, fal). Cached in
        logs/ledger.json so a re-run only asks for new ids.
The API key is read from the environment or ~/.multix/.env and never printed or written anywhere.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from pathlib import Path

from .common_io_and_paths import append_jsonl, load_json, now_iso, read_jsonl, save_json

ATLAS_PRED = "https://api.atlascloud.ai/api/v1/model/prediction/{}"


def current_run(episode_dir: Path) -> str:
    ep_p = episode_dir / "episode.json"
    ep = load_json(ep_p) if ep_p.exists() else {}
    return os.environ.get("ANIME_RUN") or ep.get("current_run") or f"{episode_dir.name}-adhoc"


def trace(episode_dir: Path, event: str, **fields) -> dict:
    row = {"ts": now_iso(), "run": current_run(episode_dir), "episode": episode_dir.name, "event": event}
    row.update({k: v for k, v in fields.items() if v not in (None, "")})
    append_jsonl(episode_dir / "logs" / "trace.jsonl", row)
    return row


def run_start(episode_dir: Path, *, transcript: str = "", note: str = "") -> str:
    ep = load_json(episode_dir / "episode.json")
    rid = f"{episode_dir.name}-{now_iso()[:16].replace(':', '').replace('-', '')}"
    ep["current_run"] = rid
    ep.setdefault("runs", []).append({"run": rid, "start": now_iso(), "transcript": transcript})
    save_json(episode_dir / "episode.json", ep)
    trace(episode_dir, "run_start", detail=note, transcript=transcript)
    return rid


def phase(episode_dir: Path, name: str, *, end: bool = False, detail: str = "") -> dict:
    return trace(episode_dir, "phase_end" if end else "phase_start", phase=name, detail=detail)


def run_events(episode_dir: Path, run: str | None = None) -> list[dict]:
    rows = read_jsonl(episode_dir / "logs" / "trace.jsonl")
    run = run or current_run(episode_dir)
    return [r for r in rows if r.get("run") == run]


# ---------------------------------------------------------------- ledger

def _atlas_key() -> str | None:
    k = os.environ.get("ATLASCLOUD_API_KEY")
    if k:
        return k
    env = Path("~/.multix/.env").expanduser()
    if env.exists():
        m = re.search(r"^\s*(?:export\s+)?ATLASCLOUD_API_KEY\s*=\s*['\"]?([^'\"\s]+)", env.read_text(encoding="utf-8"), re.M)
        return m.group(1) if m else None
    return None


def parse_predictions_log(path: Path) -> list[dict]:
    """Lines: '<32-hex id> <kind> <name> [model]'. Blank and # lines are skipped."""
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 3 and re.fullmatch(r"[0-9a-f]{32}", parts[0]):
            rows.append({"id": parts[0], "kind": parts[1], "name": parts[2], "model": parts[3] if len(parts) > 3 else ""})
    return rows


def fetch_atlas(pred_id: str, key: str) -> dict:
    req = urllib.request.Request(ATLAS_PRED.format(pred_id), headers={
        "Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": "curl/8.7.1"})
    try:
        data = json.loads(urllib.request.urlopen(req, timeout=30).read()).get("data") or {}
    except OSError as e:
        return {"error": type(e).__name__}
    return {"price": data.get("price"), "model": data.get("model"), "status": data.get("status"), "created_at": data.get("created_at")}


def ledger(episode_dir: Path, *, fetch: bool = True) -> dict:
    cache_p = episode_dir / "logs" / "ledger.json"
    cache = load_json(cache_p) if cache_p.exists() else {}
    preds = parse_predictions_log(episode_dir / "logs" / "predictions.log")
    key = _atlas_key() if fetch else None
    if fetch and preds and not key:
        print("no ATLASCLOUD_API_KEY in env or ~/.multix/.env: showing cached prices only")
    rows = []
    for p in preds:
        c = cache.get(p["id"])
        if (not c or c.get("status") not in ("completed", "succeeded", "failed")) and key:
            c = fetch_atlas(p["id"], key)
            if not c.get("error"):
                cache[p["id"]] = c
        c = c or {}
        rows.append({**p, "provider": "atlas", "cost_usd": float(c["price"]) if c.get("price") is not None else None,
                     "status": c.get("status", "unknown"), "model": c.get("model") or p["model"]})
    plan_p = episode_dir / "gen-plan.json"
    for j in (load_json(plan_p).get("jobs", []) if plan_p.exists() else []):
        if j.get("provider", "atlas") != "atlas" and j.get("status") in ("done", "rejected", "failed"):
            rows.append({"id": j.get("id"), "kind": j.get("kind"), "name": j.get("name", j.get("id")), "provider": j["provider"],
                         "model": j.get("model"), "status": j.get("status"), "cost_usd": j.get("cost_usd"),
                         "basis": j.get("cost_basis", "estimate")})
    save_json(cache_p, cache)
    by_kind: dict[str, float] = {}
    for r in rows:
        by_kind[r["kind"]] = round(by_kind.get(r["kind"], 0) + (r["cost_usd"] or 0), 4)
    total = round(sum(r["cost_usd"] or 0 for r in rows), 4)
    return {"rows": rows, "by_kind": by_kind, "total_usd": total, "unpriced": [r["id"] for r in rows if r["cost_usd"] is None]}


def print_ledger(lg: dict) -> None:
    for r in lg["rows"]:
        cost = "?" if r["cost_usd"] is None else f"{r['cost_usd']:.4f}"
        print(f"{str(r['id'])[:12]:12s} {r['kind']:10s} {str(r['name'])[:22]:22s} {r['provider']:10s} {r['status']:10s} {cost:>8s}  {r['model']}")
    print("by kind: " + ", ".join(f"{k} ${v:.3f}" for k, v in sorted(lg["by_kind"].items())))
    print(f"total ${lg['total_usd']:.3f}" + (f"  ({len(lg['unpriced'])} unpriced)" if lg["unpriced"] else ""))
