#!/usr/bin/env python3
"""Merge sound designers' proposal files into audio/mix-events.json, one writer, all-or-nothing.

usage: python -X utf8 merge-mix-proposals.py <episode-dir> <proposal.json>... [--dry-run] [--backup-label cut2-final]

Parallel sound designers (one per scene) never edit the shared mix-events.json. Each writes a proposal
(template assets/templates/mix-add.example.json) and the controller merges them here:
  remove  [{match}]              drop the one event whose keys all equal `match`
  modify  [{match, set}]         update the one matching event with `set`
  add     [{event}]              append (the proposal's `scene` is filled in; files must exist)
  duck    {bus: [{window}]}      append duck windows ({at_shot, t0, t1, gain}) for beds, music or hits
Every match must hit exactly one event of that scene (numbers equal within 1e-6), or nothing is written.
The first real merge with a label backs the old file up as audio/mix-events.<label>.json; that backup is never
overwritten (a stale earlier backup once hid the real pre-merge state). A lock file holding the merger's PID stops two merges
at once (a lock whose PID is dead is reclaimed):
parallel writers corrupted a shared EDL with "Extra data" JSON and WinError 32 in FRONTIER EP01.
FRONTIER cut 3: five designers, 650 events merged, zero conflicts.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from studio import common_io_and_paths as io  # noqa: E402


def same(a, b) -> bool:
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        return abs(a - b) < 1e-6
    return a == b


def find_one(events: list[dict], match: dict, scene: str) -> int:
    sc = match.get("scene", scene)
    hits = [i for i, e in enumerate(events) if e.get("scene") == sc and all(k in e and same(e[k], v) for k, v in match.items())]
    if len(hits) != 1:
        raise ValueError(f"{scene}: match {match} hits {len(hits)} events, expected 1")
    return hits[0]


def apply(doc: dict, prop: dict, scene: str, ep: Path) -> str:
    """Apply one proposal to doc in place; raise ValueError on any ambiguity before anything is changed."""
    events = doc.setdefault("events", [])
    drop = sorted({find_one(events, r["match"], scene) for r in prop.get("remove", [])}, reverse=True)
    mods = [(find_one(events, m["match"], scene), m["set"]) for m in prop.get("modify", [])]
    new = [{"scene": scene, **e} for e in prop.get("add", [])]
    missing = [e["file"] for e in new if not (Path(e["file"]) if Path(e["file"]).is_absolute() else ep / e["file"]).exists()]
    if missing:
        raise ValueError(f"{scene}: missing files {missing[:5]}")
    for i, s in mods:
        events[i].update(s)
    for i in drop:
        events.pop(i)
    events.extend(new)
    ducks = prop.get("duck") or {}
    for bus, wins in ducks.items():
        doc.setdefault("duck", {}).setdefault(bus, []).extend({"scene": scene, **w} for w in wins)
    return f"{scene}: -{len(drop)} ~{len(mods)} +{len(new)} duck {sum(len(w) for w in ducks.values())}"


def scene_of(path: Path, prop: dict) -> str:
    if prop.get("scene"):
        return prop["scene"]
    stem = path.stem  # mix-add-sc03.json -> sc03
    return stem.rsplit("-", 1)[-1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episode")
    ap.add_argument("proposals", nargs="+")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backup-label", default="pre-merge", help="backup name part: audio/mix-events.<label>.json")
    ap.add_argument("--events", help="target file (default <episode>/audio/mix-events.json)")
    a = ap.parse_args()
    ep = Path(a.episode).expanduser().resolve()
    path = Path(a.events) if a.events else ep / "audio" / "mix-events.json"
    lock = path.with_suffix(".lock")
    io.take_lock(lock, f"merge {time.time():.0f}")  # a lock left by a dead merge is reclaimed; a live one stops here
    try:
        doc = io.load_json(path)
        before = len(doc.get("events", []))
        try:
            for p in map(Path, a.proposals):
                prop = io.load_json(p)
                print(apply(doc, prop, scene_of(p, prop), ep))
        except ValueError as e:
            sys.exit(f"nothing written: {e}")
        print(f"events {before} -> {len(doc['events'])}")
        if a.dry_run:
            return
        backup = path.with_name(f"{path.stem}.{a.backup_label}.json")
        if not backup.exists():
            backup.write_bytes(path.read_bytes())
            print(f"backup {backup.name}")
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
