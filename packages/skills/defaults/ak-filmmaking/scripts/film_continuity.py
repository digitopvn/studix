"""Continuity between linked shots and the shot-level QC routing report.

Each shot reads the state carried along its continuity_from chain. A change in
a character's wardrobe, left/right screen side or physical condition, a prop's
holder/position, or the movement direction across the cut must be declared in
continuity_changes with a reason; otherwise it is a continuity error at the cut
point. QC failures route back to the cheapest stage that can fix them.
"""

from film_graph import timecode

MOVING = {"left_to_right", "right_to_left"}
SIDES = {"left", "right"}  # center/offscreen framings are neutral for the 180-degree rule

# Cheapest stage that fixes each QC failure category. "audio" and "edit" mean the
# fix happens in the mix or the cut and the shot's video must not be regenerated.
RETURN_STAGE = {
    **dict.fromkeys(["identity", "wardrobe", "hair", "accessories", "prop", "spatial", "lighting", "location"], "STORYBOARDED"),
    **dict.fromkeys(["morphing", "anatomy", "camera", "physics", "temporal_artifact"], "APPROVED_FRAME"),
    **dict.fromkeys(["lipsync_drift", "lipsync_offset", "pause_motion"], "GENERATED"),
    "dialogue_timing": "PLANNED",
    **dict.fromkeys(["pronunciation", "audio_mix", "music", "sfx_timing", "ambience_seam", "loudness"], "audio"),
    **dict.fromkeys(["pacing", "redundant", "coverage"], "edit"),
}

RETURN_ACTION = {
    "STORYBOARDED": "fix the keyframe/reference and re-approve it before any video rerender",
    "APPROVED_FRAME": "regenerate the video from the approved frame only",
    "GENERATED": "rerun the lipsync pass on the selected generation; do not rerender video",
    "NATIVE_LIPSYNC": "regenerate from the approved frame with the master audio, or route the shot to a dedicated lipsync pass",
    "PLANNED": "fix dialogue or shot timing, then re-storyboard; no generation until timing holds",
    "audio": "fix the affected stem in the mix; no video regeneration",
    "edit": "solve in the cut (trim, reorder, add coverage); no regeneration",
}


def _ancestors(film, shot):
    """Walk continuity_from links backwards; stop at the chain start or a cycle."""
    seen, current = {shot["shot_id"]}, shot
    while current["continuity_from"] in film.shots and current["continuity_from"] not in seen:
        current = film.shots[current["continuity_from"]]
        seen.add(current["shot_id"])
        yield current


def _last_seen(film, shot, member, key):
    """Nearest earlier shot in the chain where a character or prop was on screen.

    Reaction shots and cutaways often drop a character for a cut or two; the
    state they left with is still the state they must return with.
    """
    return next((prior for prior in _ancestors(film, shot) if member in prior[key]), None)


def _diff(film, shot):
    """Yield (field, before, after, source_shot_id) for every carried state that changed."""
    state = shot["continuity"]
    for char_id in shot["characters"]:
        prior = _last_seen(film, shot, char_id, "characters")
        if prior is None:
            continue
        was = prior["continuity"]
        if prior["wardrobe"].get(char_id) != shot["wardrobe"].get(char_id):
            yield f"wardrobe.{char_id}", prior["wardrobe"].get(char_id), shot["wardrobe"].get(char_id), prior["shot_id"]
        sides = {was["screen_positions"].get(char_id), state["screen_positions"].get(char_id)}
        if sides == SIDES:
            yield (f"screen_positions.{char_id}", was["screen_positions"][char_id],
                   state["screen_positions"][char_id], prior["shot_id"])
        before_cond = sorted(was["conditions"].get(char_id, []))
        after_cond = sorted(state["conditions"].get(char_id, []))
        if before_cond != after_cond:
            yield f"conditions.{char_id}", before_cond, after_cond, prior["shot_id"]
    for prop_id in shot["props"]:
        prior = _last_seen(film, shot, prop_id, "props")
        if prior is None:
            continue
        before, after = prior["continuity"]["prop_states"].get(prop_id), state["prop_states"].get(prop_id)
        if before and after and before != after:
            yield f"prop_states.{prop_id}", before, after, prior["shot_id"]
    previous = film.shots.get(shot["continuity_from"])
    if previous is not None:
        before_dir, after_dir = previous["continuity"]["screen_direction"], state["screen_direction"]
        if before_dir in MOVING and after_dir in MOVING and before_dir != after_dir:
            yield "screen_direction", before_dir, after_dir, previous["shot_id"]


def check_continuity(film):
    for spot in film.timeline():
        shot = film.shots[spot["shot_id"]]
        declared = {change["field"]: change["reason"] for change in shot.get("continuity_changes", [])}
        where, tc = f"shot {shot['shot_id']}", timecode(spot["film_start"])
        if shot["continuity_from"] is None:
            if declared:
                film.add("warning", "continuity", where, "continuity_changes declared without a continuity_from shot", tc)
            continue
        if any(prior["continuity_from"] == shot["shot_id"] for prior in _ancestors(film, shot)):
            film.add("error", "continuity-link", where, "continuity_from links form a cycle", tc)
            continue
        changed = set()
        for field, before, after, source in _diff(film, shot):
            changed.add(field)
            if field not in declared:
                film.add("error", "continuity", where,
                         f"{field} changes from {before} (last seen in {source}) to {after} without a declared reason", tc)
        for field in sorted(set(declared) - changed):
            film.add("warning", "continuity", where, f"declared change {field} does not differ from the carried state", tc)


def qc_report(film):
    """Every open QC failure on the film timeline with its cheapest fix.

    Only records with status "failed" are open; a shot sent back for rework sets
    qc.status to "pending", so its old failures stop being actionable.
    """
    rows = []
    for spot in film.timeline():
        shot = film.shots[spot["shot_id"]]
        qc = shot.get("qc") or {}
        if qc.get("status") != "failed":
            continue
        for failure in qc["failures"]:
            stage = RETURN_STAGE[failure["category"]]
            action = RETURN_ACTION[stage]
            if stage == "GENERATED" and shot["lipsync"] != "dedicated":
                # Native or absent lipsync has no separate pass to rerun: the video itself is redone.
                stage, action = "APPROVED_FRAME", RETURN_ACTION["NATIVE_LIPSYNC"]
            row = {
                "shot_id": shot["shot_id"],
                "timecode": timecode(spot["film_start"] + failure["at"]),
                "category": failure["category"],
                "note": failure["note"],
                "return_to": stage,
                "action": action,
            }
            if "end" in failure:
                row["timecode_end"] = timecode(spot["film_start"] + failure["end"])
            rows.append(row)
    return rows
