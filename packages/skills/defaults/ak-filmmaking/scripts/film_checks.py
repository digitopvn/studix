"""Referential integrity, production gates and lipsync policy for a loaded Film.

Every rule here protects a concrete production failure: a shot that silently
changes wardrobe, an expensive render started before its frame was approved, a
lipsync shot generated against temp dialogue, or a speaking close-up with no
lipsync route. Continuity between linked shots lives in film_continuity.py.
"""

from film_graph import STATE_RANK, TIME_EPSILON, animatic_frame, timecode

FRAME_REQUIRED = {"STANDARD", "CHARACTER_CRITICAL", "HERO"}
CLOSE_FRAMINGS = {"medium_close_up", "close_up", "extreme_close_up", "hero"}
MASTER_DX = {"master", "approved"}


def check_bibles(film):
    for char_id, char in film.characters.items():
        where = f"bibles/characters {char_id}"
        used = {char["identity_version"]} | {
            film.identity_version_for(char_id, sid) for sid, scene in film.scenes.items() if char_id in scene["characters"]}
        for version in sorted(used):
            pack = [r for r in char["references"] if r["status"] == "canonical" and r["version"] == version]
            if not any(r["view"] == "front" for r in pack):
                film.add("error", "identity-pack", where, f"no canonical front reference for identity v{version}")
            missing = {"three_quarter_left", "three_quarter_right", "profile", "full_body"} - {r["view"] for r in pack}
            if missing:
                film.add("warning", "identity-pack", where, f"identity v{version} pack lacks views: {', '.join(sorted(missing))}")
        for ref in char["references"]:
            if ref["version"] > char["identity_version"]:
                film.add("error", "identity-version", where, f"{ref['id']} claims version {ref['version']} above identity_version")
    for asset_id, asset in film.assets.items():
        if asset["kind"] == "wardrobe":
            owner = asset.get("character")
            if owner not in film.characters:
                film.add("error", "dangling-ref", f"bibles/wardrobe {asset_id}", f"wardrobe owner {owner!r} is not a character")


def _asset_of_kind(film, asset_id, kind):
    asset = film.assets.get(asset_id)
    return asset is not None and asset["kind"] == kind


def check_scenes(film):
    for scene_id, scene in film.scenes.items():
        where = f"scenes/{scene_id}"
        if not _asset_of_kind(film, scene["location"], "location"):
            film.add("error", "dangling-ref", where, f"location {scene['location']} is not in bibles/locations")
        for char_id in scene["characters"]:
            if char_id not in film.characters:
                film.add("error", "dangling-ref", where, f"character {char_id} is not in bibles/characters")
            elif char_id not in scene["wardrobe"]:
                film.add("error", "wardrobe", where, f"character {char_id} has no scene wardrobe state")
        for char_id, wardrobe_id in scene["wardrobe"].items():
            if char_id not in scene["characters"]:
                film.add("error", "wardrobe", where, f"wardrobe given for {char_id}, who is not in the scene")
            if not _asset_of_kind(film, wardrobe_id, "wardrobe") or film.assets[wardrobe_id].get("character") != char_id:
                film.add("error", "wardrobe", where, f"{wardrobe_id} is not a wardrobe state of {char_id}")
        for char_id, version in scene.get("identity_versions", {}).items():
            if char_id not in scene["characters"] or char_id not in film.characters:
                film.add("error", "identity-version", where, f"identity version given for {char_id}, who is not an active character")
            elif version > film.characters[char_id]["identity_version"]:
                film.add("error", "identity-version", where, f"{char_id} v{version} is above the bible's identity_version")
        for prop_id in scene["props"]:
            if not _asset_of_kind(film, prop_id, "prop"):
                film.add("error", "dangling-ref", where, f"prop {prop_id} is not in bibles/props")
    if film.beats:
        covered = set()
        for beat in film.beats["beats"]:
            for scene_id in beat["scenes"]:
                if scene_id not in film.project["scenes"]:
                    film.add("error", "dangling-ref", f"beat-sheet {beat['id']}", f"scene {scene_id} is not in project.json")
                covered.add(scene_id)
        for scene_id in film.project["scenes"]:
            if scene_id not in covered:
                film.add("warning", "beat-coverage", f"scenes/{scene_id}", "no beat records this scene's narrative purpose")


def check_shots(film):
    for spot in film.timeline():
        shot_id = spot["shot_id"]
        shot, scene = film.shots[shot_id], film.scenes[spot["scene_id"]]
        tc = timecode(spot["film_start"])
        where = f"shot {shot_id}"

        def add(severity, code, message, _where=where, _tc=tc):
            film.add(severity, code, _where, message, _tc)

        declared = {change["field"] for change in shot.get("continuity_changes", [])}
        frames = shot["duration_target"] * film.project["fps"]
        if abs(frames - round(frames)) > 1e-6:
            add("warning", "timing", f"duration {shot['duration_target']}s is not a whole number of frames at {film.project['fps']} fps")
        if shot["location"] != scene["location"]:
            add("error", "location", f"location {shot['location']} differs from scene location {scene['location']}")
        for char_id in shot["characters"]:
            if char_id not in scene["characters"]:
                add("error", "dangling-ref", f"character {char_id} is not active in scene {scene['scene_id']}")
                continue
            worn = shot["wardrobe"].get(char_id)
            if worn is None:
                add("error", "wardrobe", f"visible character {char_id} has no wardrobe state")
            elif worn != scene["wardrobe"].get(char_id) and f"wardrobe.{char_id}" not in declared:
                add("error", "wardrobe", f"{char_id} wears {worn} but the scene state is {scene['wardrobe'].get(char_id)}")
            elif not _asset_of_kind(film, worn, "wardrobe") or film.assets[worn].get("character") != char_id:
                add("error", "wardrobe", f"{worn} is not a wardrobe state of {char_id}")
        for key in shot["wardrobe"]:
            if key not in shot["characters"]:
                add("error", "wardrobe", f"wardrobe given for {key}, who is not in frame")
        for prop_id in shot["props"]:
            if prop_id not in scene["props"]:
                add("error", "dangling-ref", f"prop {prop_id} is not part of scene {scene['scene_id']}")
        for speaker in shot["visible_speakers"]:
            if speaker not in shot["characters"]:
                add("error", "lipsync", f"visible speaker {speaker} is not in frame")
        _check_continuity_keys(shot, add)
        _check_references(film, shot, add)
        _check_links(film, shot, add)
        _check_gates(film, shot, add)
        _check_lipsync(film, shot, add)


def _check_continuity_keys(shot, add):
    state = shot["continuity"]
    for char_id in list(state["screen_positions"]) + list(state["conditions"]):
        if char_id not in shot["characters"]:
            add("error", "continuity", f"continuity state names {char_id}, who is not in frame")
    for prop_id in state["prop_states"]:
        if prop_id not in shot["props"]:
            add("error", "continuity", f"prop state names {prop_id}, which is not in the shot's props")


def _check_references(film, shot, add):
    anchored = set()
    for ref_id in shot["references"]:
        if ref_id not in film.references:
            add("error", "dangling-ref", f"reference {ref_id} is not in any bible")
            continue
        owner, ref = film.references[ref_id]
        if ref["status"] != "canonical":
            add("error", "non-canonical-ref", f"{ref_id} is {ref['status']}; promote it explicitly before it conditions a shot")
            continue
        if owner in film.characters:
            expected = film.identity_version_for(owner, shot["scene_id"])
            if ref["version"] != expected:
                add("error", "identity-version", f"{ref_id} depicts identity v{ref['version']}, scene {shot['scene_id']} uses v{expected}")
            anchored.add(owner)
        else:
            anchored.add(owner)
    recorded = [(f"{key} frame", shot[key]) for key in ("storyboard", "keyframe")
                if shot.get(key) and shot[key]["status"] != "rejected"]
    recorded += [(f"generation {g['id']}", g) for g in shot.get("generations", []) if g["status"] != "discarded"]
    for label, item in recorded:
        for ref_id in item.get("references", []):
            if ref_id not in film.references:
                add("error", "dangling-ref", f"{label} records reference {ref_id}, which is not in any bible")
            elif film.references[ref_id][1]["status"] != "canonical":
                add("error", "non-canonical-ref", f"{label} was conditioned on {ref_id}, which is {film.references[ref_id][1]['status']}")
    if shot["render_class"] == "PREVIS":
        return
    for char_id in shot["characters"]:
        if char_id in film.characters and char_id not in anchored:
            add("error", "identity-unanchored", f"{char_id} is in frame without a canonical identity reference")
        worn = shot["wardrobe"].get(char_id)
        if worn in film.assets and film.assets[worn]["references"] and worn not in anchored:
            add("warning", "wardrobe-unanchored", f"{worn} has reference images but none conditions this shot")
    location = film.assets.get(shot["location"])
    if location and location["references"] and shot["location"] not in anchored:
        add("warning", "location-unanchored", f"{shot['location']} has reference images but none conditions this shot")


def _check_links(film, shot, add):
    for field, back in (("continuity_from", "continuity_to"), ("continuity_to", "continuity_from")):
        other_id = shot[field]
        if other_id is None:
            continue
        if other_id == shot["shot_id"]:
            add("error", "continuity-link", f"{field} points at the shot itself")
            continue
        other = film.shots.get(other_id)
        if other is None:
            add("error", "dangling-ref", f"{field} {other_id} is not a shot in the cut")
        elif other[back] != shot["shot_id"]:
            add("error", "continuity-link", f"{field} {other_id} does not link back ({other_id}.{back} = {other[back]})")
    order = film.shot_order(shot["scene_id"])
    if order.index(shot["shot_id"]) > 0 and shot["continuity_from"] is None:
        add("warning", "continuity-link", "shot has no continuity_from, so no continuity state is carried into it")


def _check_gates(film, shot, add):
    rank = STATE_RANK[shot["state"]]
    storyboard, keyframe = shot.get("storyboard"), shot.get("keyframe")
    if rank >= STATE_RANK["STORYBOARDED"] and storyboard is None:
        add("error", "gate", f"state {shot['state']} needs a storyboard frame")
    if rank >= STATE_RANK["APPROVED_FRAME"]:
        if not storyboard or storyboard["status"] != "approved":
            add("error", "gate", "storyboard frame must be approved before keyframe/video work")
        if shot["render_class"] in FRAME_REQUIRED and (not keyframe or keyframe["status"] != "approved"):
            add("error", "gate", f"{shot['render_class']} shots need an approved keyframe before video generation")
    generations = shot.get("generations", [])
    selected = [g for g in generations if g["status"] == "selected"]
    if rank >= STATE_RANK["GENERATED"]:
        if len(selected) != 1:
            add("error", "gate", f"state {shot['state']} needs exactly one selected generation, found {len(selected)}")
        for cue, _, _ in film.visible_dialogue(shot["shot_id"]):
            if cue["status"] not in MASTER_DX:
                add("error", "audio-first", f"dialogue {cue['id']} is {cue['status']}; generate master dialogue before lipsync shots")
            elif cue["id"] not in film.alignments:
                add("error", "audio-first", f"dialogue {cue['id']} has no forced alignment yet")
    elif selected:
        add("error", "gate", f"a generation is selected while the shot is still {shot['state']}")
    # Live (candidate/selected) generations prove video was spent, whatever the state says.
    # Discarded attempts are history and may remain after a QC return to an earlier stage.
    live = [g for g in generations if g["status"] != "discarded"]
    if live and shot["render_class"] != "PREVIS":
        if rank < STATE_RANK["APPROVED_FRAME"]:
            add("error", "gate", "video was generated before the storyboard/keyframe was approved")
        if film.project["animatic"]["status"] != "approved":
            add("error", "gate", "video generated before the animatic was approved; review the full animatic first")
    if film.project["animatic"]["status"] == "approved" and animatic_frame(shot) is None:
        add("error", "gate", "the animatic is recorded as approved but this shot has no frame in it")
    if len(generations) > shot["retry_budget"] + 1:
        add("warning", "retry-budget", f"{len(generations)} attempts exceed retry_budget {shot['retry_budget']}; re-plan before retrying")
    lipsync_pass = shot.get("lipsync_pass")
    if shot["state"] == "LIPSYNCED" and shot["lipsync"] != "dedicated":
        add("error", "gate", "LIPSYNCED is only valid for shots routed to a dedicated lipsync pass")
    if shot["lipsync"] == "dedicated" and rank >= STATE_RANK["LIPSYNCED"] and shot["state"] != "QC_FAILED":
        if not lipsync_pass or lipsync_pass["status"] != "done":
            add("error", "gate", "dedicated lipsync pass is not done")
    qc = shot.get("qc")
    if shot["state"] == "QC_FAILED" and (not qc or qc["status"] != "failed" or not qc["failures"]):
        add("error", "gate", "QC_FAILED needs a failed QC record with at least one failure")
    if shot["state"] in ("APPROVED", "ASSEMBLED") and (not qc or qc["status"] != "passed"):
        add("error", "gate", f"state {shot['state']} needs a passed QC record")
    if qc and qc["status"] == "failed" and shot["state"] != "QC_FAILED":
        add("error", "gate", f"QC failed but the shot is still {shot['state']}")
    for failure in (qc or {}).get("failures", []):
        if failure["at"] > shot["duration_target"] + TIME_EPSILON:
            add("error", "qc", f"QC failure at {failure['at']}s is past the shot end")
        end = failure.get("end")
        if end is not None and (end < failure["at"] or end > shot["duration_target"] + TIME_EPSILON):
            add("error", "qc", f"QC failure end {end}s must lie between its start and the shot end")


def recommended_dedicated(film, shot):
    """Budget policy: which speaking shots deserve a dedicated lipsync pass."""
    mode, klass, framing = film.project["budget_mode"], shot["render_class"], shot["shot_type"]
    if mode == "low":
        return klass == "HERO" and framing in CLOSE_FRAMINGS
    if mode == "balanced":
        return klass in ("CHARACTER_CRITICAL", "HERO") and framing in CLOSE_FRAMINGS
    return klass in FRAME_REQUIRED


def _check_lipsync(film, shot, add):
    visible = film.visible_dialogue(shot["shot_id"])
    if visible and shot["lipsync"] == "none":
        add("error", "lipsync", "a visible speaker talks over this shot with lipsync none; cut away or route lipsync")
    if not visible and shot["lipsync"] != "none":
        add("warning", "lipsync", "lipsync is routed but no visible speaker talks during this shot")
    if visible and shot["lipsync"] == "native" and recommended_dedicated(film, shot):
        add("warning", "lipsync-policy",
            f"{film.project['budget_mode']} budget recommends a dedicated lipsync pass for this {shot['shot_type']}")


def check_audio(film):
    durations = {sid: film.scene_duration(sid) for sid in film.scene_order()}
    for cue in film.cues.values():
        where = f"audio cue {cue['id']}"
        scene_id = cue["scene_id"]
        if scene_id not in film.scenes:
            film.add("error", "dangling-ref", where, f"scene {scene_id} is not in the cut")
            continue
        end = cue["start"] + cue["duration"]
        if end > durations[scene_id] + TIME_EPSILON:
            film.add("error", "timing", where, f"ends at {end:.2f}s but scene {scene_id} cuts at {durations[scene_id]:.2f}s; fix audio or shot timing before generation",
                     timecode(film.scene_film_start(scene_id) + cue["start"]))
        if cue["stem"] == "DX":
            if not cue.get("character") or not cue.get("text"):
                film.add("error", "dialogue", where, "dialogue cues need character and text")
            elif cue["character"] not in film.scenes[scene_id]["characters"]:
                film.add("error", "dialogue", where, f"speaker {cue['character']} is not in scene {scene_id}")
            if cue.get("alignment") and not (film.root / cue["alignment"]).is_file():
                film.add("warning", "alignment", where, f"alignment file {cue['alignment']} does not exist yet")
            _check_alignment(film, cue, where)
        if cue["stem"] == "MX" and not cue.get("theme"):
            film.add("warning", "music", where, "music cue has no theme/motif ID for the cue sheet")
        event = cue.get("sync_event")
        if event:
            spot = film.placement(event["shot_id"])
            if spot is None or spot["scene_id"] != scene_id:
                film.add("error", "sync-event", where, f"sync shot {event['shot_id']} is not in scene {scene_id}")
            elif not spot["scene_start"] - TIME_EPSILON <= cue["start"] <= spot["scene_start"] + spot["duration"]:
                film.add("error", "sync-event", where, f"onset {cue['start']}s lands outside shot {event['shot_id']}",
                         timecode(film.scene_film_start(scene_id) + cue["start"]))
    _check_dialogue_overlap(film)


def _check_dialogue_overlap(film):
    """One voice cannot deliver two lines at once; overlap usually means a timing slip."""
    lines = sorted((c for c in film.cues.values() if c["stem"] == "DX" and c.get("character") and c["scene_id"] in film.scenes),
                   key=lambda c: (c["scene_id"], c["character"], c["start"], c["id"]))
    latest = {}  # (scene, speaker) -> (end, cue_id) of the line that ends last so far
    for cue in lines:
        key = (cue["scene_id"], cue["character"])
        end, other = latest.get(key, (None, None))
        if end is not None and cue["start"] < end - TIME_EPSILON:
            film.add("warning", "dialogue", f"audio cue {cue['id']}", f"overlaps {other} from the same speaker",
                     timecode(film.scene_film_start(cue["scene_id"]) + cue["start"]))
        cue_end = cue["start"] + cue["duration"]
        if end is None or cue_end > end:
            latest[key] = (cue_end, cue["id"])


def _check_spans(film, spans, cue, where, kind):
    previous = 0.0
    for span in spans:
        if span["start"] < previous - TIME_EPSILON or span["end"] < span["start"] or span["end"] > cue["duration"] + TIME_EPSILON:
            label = repr(span["text"]) if "text" in span else f"at {span['start']}s"
            film.add("error", "alignment", where, f"{kind} {label} has out-of-order or out-of-range timing")
        previous = span["end"]


def _check_alignment(film, cue, where):
    alignment = film.alignments.get(cue["id"])
    if alignment is None:
        return
    if alignment["cue_id"] != cue["id"]:
        film.add("error", "alignment", where, f"alignment file belongs to {alignment['cue_id']}")
    _check_spans(film, alignment["sentences"], cue, where, "sentence")
    _check_spans(film, alignment.get("words", []), cue, where, "word")
    _check_spans(film, alignment.get("silences", []), cue, where, "silence")


def check_media(film):
    """Optional: every declared file exists on disk (run once assets are produced)."""
    declared = [(f"reference {rid}", ref["path"]) for rid, (_, ref) in film.references.items() if ref["status"] != "retired"]
    for shot_id, shot in film.shots.items():
        for key in ("storyboard", "keyframe", "lipsync_pass"):
            if shot.get(key):
                declared.append((f"shot {shot_id} {key}", shot[key]["output" if key == "lipsync_pass" else "path"]))
        declared += [(f"shot {shot_id} generation {g['id']}", g["output"]) for g in shot.get("generations", []) if g["status"] != "discarded"]
    for cue in film.cues.values():
        declared += [(f"audio cue {cue['id']} {key}", cue[key]) for key in ("file", "alignment") if cue.get(key)]
    for where, rel in declared:
        if not (film.root / rel).is_file():
            film.add("error", "missing-media", where, f"{rel} does not exist")
