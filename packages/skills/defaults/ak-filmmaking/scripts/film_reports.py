"""Derived production reports: cue sheet, dialogue coverage, edit timelines and costs.

Everything here is read-only over the graph and deterministic, so two runs on
the same project produce byte-identical output that can be diffed in review.
"""

import os

from film_graph import STATE_RANK, animatic_frame, timecode

STEMS = ("DX", "FX", "AMB", "MX")
USABLE_TEMP = {"temp", "master", "approved"}
MASTER = {"master", "approved"}


def _cue_film_start(film, cue):
    scene_start = film.scene_film_start(cue["scene_id"])
    return None if scene_start is None else scene_start + cue["start"]


def cue_sheet(film):
    """Music cue sheet plus per-stem inventory; stems are never merged here."""
    stems = {stem: {"cues": 0, "seconds": 0.0, "status": {}} for stem in STEMS}
    music, ambience, sync = [], [], []
    for cue in sorted(film.cues.values(), key=lambda c: (_cue_film_start(film, c) or 0.0, c["id"])):
        at = _cue_film_start(film, cue)
        if at is None:
            continue
        info = stems[cue["stem"]]
        info["cues"] += 1
        info["seconds"] = round(info["seconds"] + cue["duration"], 3)
        info["status"][cue["status"]] = info["status"].get(cue["status"], 0) + 1
        row = {"cue_id": cue["id"], "scene_id": cue["scene_id"], "in": timecode(at),
               "out": timecode(at + cue["duration"]), "duration": cue["duration"], "status": cue["status"]}
        if cue["stem"] == "MX":
            music.append({**row, "theme": cue.get("theme")})
        elif cue["stem"] == "AMB":
            ambience.append({**row, "loop": bool(cue.get("loop"))})
        elif cue["stem"] == "FX" and cue.get("sync_event"):
            sync.append({**row, "shot_id": cue["sync_event"]["shot_id"], "event": cue["sync_event"]["description"]})
    themes = sorted({row["theme"] for row in music if row["theme"]})
    return {"stems": stems, "music_cues": music, "themes": themes, "ambience_beds": ambience, "sync_events": sync}


def dialogue_coverage(film):
    """How much dialogue is carried by visible lips versus reaction/cutaway coverage."""
    rows, visible_total, offscreen_total = [], 0.0, 0.0
    for spot in film.timeline():
        shot = film.shots[spot["shot_id"]]
        visible_ids = {cue["id"] for cue, _, _ in film.visible_dialogue(shot["shot_id"])}
        for cue, start, end in film.dialogue_over(shot["shot_id"]):
            seconds = round(end - start, 3)
            on_lips = cue["id"] in visible_ids
            if on_lips:
                visible_total += seconds
            else:
                offscreen_total += seconds
            rows.append({"shot_id": shot["shot_id"], "shot_type": shot["shot_type"], "cue_id": cue["id"],
                         "speaker": cue.get("character"), "seconds": seconds,
                         "coverage": "lipsync" if on_lips else "off_screen", "lipsync": shot["lipsync"],
                         "timecode": timecode(spot["film_start"] + start)})
    total = visible_total + offscreen_total
    return {"dialogue_seconds": round(total, 3), "visible_lipsync_seconds": round(visible_total, 3),
            "off_screen_seconds": round(offscreen_total, 3),
            "visible_ratio": round(visible_total / total, 3) if total else 0.0, "shots": rows}


def _final_source(shot):
    if shot["lipsync"] == "dedicated":
        lipsync_pass = shot.get("lipsync_pass") or {}
        return lipsync_pass["output"] if lipsync_pass.get("status") == "done" else None
    selected = [g for g in shot.get("generations", []) if g["status"] == "selected"]
    return selected[0]["output"] if len(selected) == 1 else None


def build_timeline(film, mode, findings=()):
    """Edit decision list for the animatic (stills) or the final cut (approved video).

    In final mode every validation error passed in via findings is also a blocker.
    Generated video audio is always discarded: the dialogue master and the other
    stems are laid in separately so the final mix keeps the original waveform.
    """
    video, blockers = [], []
    for spot in film.timeline():
        shot = film.shots[spot["shot_id"]]
        if mode == "animatic":
            source, kind = animatic_frame(shot), "still"
            if source is None:
                blockers.append(f"{shot['shot_id']}: no usable frame (approved keyframe or non-rejected storyboard)")
        else:
            source, kind = _final_source(shot), "video"
            if STATE_RANK[shot["state"]] < STATE_RANK["APPROVED"] or shot["state"] == "QC_FAILED":
                blockers.append(f"{shot['shot_id']}: state {shot['state']} is not approved for assembly")
            if source is None:
                blockers.append(f"{shot['shot_id']}: no selected generation or finished lipsync pass")
        video.append({"shot_id": shot["shot_id"], "source": source, "kind": kind,
                      "in": timecode(spot["film_start"]), "start": round(spot["film_start"], 3), "duration": spot["duration"]})
    audio = {stem: [] for stem in STEMS}
    for cue in sorted(film.cues.values(), key=lambda c: (_cue_film_start(film, c) or 0.0, c["id"])):
        at = _cue_film_start(film, cue)
        if at is None:
            continue
        # The animatic already runs on master dialogue (it is the timing authority);
        # ambience, Foley and music may still be temp until the final mix.
        allowed = MASTER if (mode == "final" or cue["stem"] == "DX") else USABLE_TEMP
        if cue["status"] not in allowed:
            blockers.append(f"{cue['id']}: {cue['stem']} cue is {cue['status']}; {mode} needs {'/'.join(sorted(allowed))}")
        if not cue.get("file"):
            blockers.append(f"{cue['id']}: no audio file")
        audio[cue["stem"]].append({"cue_id": cue["id"], "file": cue.get("file"), "start": round(at, 3),
                                   "duration": cue["duration"], "loop": bool(cue.get("loop"))})
    if mode == "final":
        # Any open validation error (gate, continuity, audio-first) blocks the final cut.
        blockers += [f"{f.where}: {f.message}" for f in findings if f.severity == "error"]
    total = round(sum(item["duration"] for item in video), 3)
    return {"mode": mode, "fps": film.project["fps"], "aspect_ratio": film.project["aspect_ratio"],
            "duration": total, "duration_timecode": timecode(total), "video_audio": "discard",
            "video": video, "audio": audio, "blockers": blockers}


def ffconcat(film, timeline, out_dir):
    """ffconcat track list with paths relative to out_dir (the file's own folder)."""
    lines = ["ffconcat version 1.0"]
    for item in timeline["video"]:
        if item["source"] is None:
            continue
        rel = os.path.relpath(film.root / item["source"], out_dir).replace(os.sep, "/")
        quoted = rel.replace("'", "'\\''")
        lines.append(f"file '{quoted}'")
        lines.append(f"{'duration' if item['kind'] == 'still' else 'outpoint'} {item['duration']}")
    return "\n".join(lines) + "\n"


def costs(film):
    """Estimated versus recorded spend; no prices are assumed or converted."""
    currency = film.project["currency"]
    report = {"currency": currency, "by_class": {}, "audio": {}, "foreign_currency": [], "unpriced": []}

    def add_money(bucket, key, cost, label):
        if cost is None:
            report["unpriced"].append(label)
        elif cost["currency"] != currency:
            report["foreign_currency"].append({"item": label, **cost})
        else:
            bucket[key] = round(bucket[key] + cost["amount"], 4)

    for spot in film.timeline():
        shot = film.shots[spot["shot_id"]]
        bucket = report["by_class"].setdefault(shot["render_class"], {
            "shots": 0, "estimated_seconds": 0.0, "estimated_cost": 0.0, "actual_cost": 0.0,
            "generated_seconds": 0.0, "selected_seconds": 0.0, "discarded_seconds": 0.0, "attempts": 0})
        bucket["shots"] += 1
        estimate = shot.get("estimate")
        if estimate:
            bucket["estimated_seconds"] = round(bucket["estimated_seconds"] + estimate["generation_seconds"], 3)
            if "cost" in estimate:
                add_money(bucket, "estimated_cost", estimate["cost"], f"{shot['shot_id']} estimate")
        for gen in shot.get("generations", []):
            bucket["attempts"] += 1
            bucket["generated_seconds"] = round(bucket["generated_seconds"] + gen["seconds"], 3)
            key = {"selected": "selected_seconds", "discarded": "discarded_seconds"}.get(gen["status"])
            if key:
                bucket[key] = round(bucket[key] + gen["seconds"], 3)
            add_money(bucket, "actual_cost", gen.get("cost"), f"{shot['shot_id']} {gen['id']}")
        if shot.get("lipsync_pass"):
            add_money(bucket, "actual_cost", shot["lipsync_pass"].get("cost"), f"{shot['shot_id']} lipsync pass")
    for cue in film.cues.values():
        bucket = report["audio"].setdefault(cue["stem"], {"cues": 0, "actual_cost": 0.0})
        bucket["cues"] += 1
        if cue["status"] in MASTER or cue.get("cost"):
            add_money(bucket, "actual_cost", cue.get("cost"), f"{cue['id']} audio")
    report["total_estimated"] = round(sum(b["estimated_cost"] for b in report["by_class"].values()), 4)
    report["total_actual"] = round(sum(b["actual_cost"] for b in report["by_class"].values())
                                   + sum(b["actual_cost"] for b in report["audio"].values()), 4)
    return report
