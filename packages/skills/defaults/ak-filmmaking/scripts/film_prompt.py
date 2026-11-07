"""Compile provider-neutral shot prompts and render-routing requirements from the graph.

Prompts are derived from production state so identity, wardrobe, props, audio
authority and continuity cannot drift between shots the way hand-written
prompts do. Provider syntax (parameter names, upload calls) stays with the
installed generation skill: this module only fixes the input order and the text.
"""

from film_checks import recommended_dedicated

# Rendering tier per budget mode and render class. The agent maps a tier to a
# concrete provider/model only after checking live provider evidence.
TIER = {
    "low": {"PREVIS": "economy", "CHEAP_BROLL": "economy", "STANDARD": "economy", "CHARACTER_CRITICAL": "standard", "HERO": "premium"},
    "balanced": {"PREVIS": "economy", "CHEAP_BROLL": "economy", "STANDARD": "standard", "CHARACTER_CRITICAL": "standard", "HERO": "premium"},
    "quality": {"PREVIS": "economy", "CHEAP_BROLL": "standard", "STANDARD": "standard", "CHARACTER_CRITICAL": "premium", "HERO": "premium"},
}
DEFAULT_NEGATIVE = ["No subtitles or on-screen text.", "No extra dialogue.", "No background music."]


def _ref_slots(film, shot):
    """Order conditioning images: identity, wardrobe, location, props."""
    groups = {"identity": [], "wardrobe": [], "location": [], "prop": []}
    for ref_id in shot["references"]:
        if ref_id not in film.references:
            continue
        owner, ref = film.references[ref_id]
        role = "identity" if owner in film.characters else film.assets[owner]["kind"]
        groups[role].append({"ref_id": ref_id, "owner": owner, "view": ref["view"], "path": ref["path"], "role": role})
    slots = groups["identity"] + groups["wardrobe"] + groups["location"] + groups["prop"]
    for index, slot in enumerate(slots, start=1):
        slot["slot"] = f"Image {index}"
    return slots


def _sentences_in_shot(film, cue, cue_offset_in_shot, lo, hi):
    """Sentence timings of a cue, shifted onto the shot clock and clipped to [lo, hi]."""
    spans = []
    for span in (film.alignments.get(cue["id"]) or {}).get("sentences", []):
        start, end = span["start"] + cue_offset_in_shot, span["end"] + cue_offset_in_shot
        if end > lo and start < hi:
            spans.append((round(max(start, lo), 2), round(min(end, hi), 2), span["text"]))
    return spans


def compile_prompt(film, shot_id):
    shot = film.shots[shot_id]
    scene = film.scenes[shot["scene_id"]]
    spot = film.placement(shot_id)
    slots = _ref_slots(film, shot)
    by_owner = {}
    for slot in slots:
        by_owner.setdefault(slot["owner"], []).append(slot["slot"])
    sections = []

    def section(title, lines):
        lines = [line for line in lines if line]
        if lines:
            sections.append((title, lines))

    section("IDENTITY REFERENCES", [
        f"{' + '.join(by_owner[c])} = canonical identity of {film.characters[c]['name']} ({c}), identity v{film.identity_version_for(c, shot['scene_id'])}."
        for c in shot["characters"] if c in by_owner])
    section("WARDROBE", [
        f"{film.characters[c]['name']} wears {film.assets[w]['name']}: {film.assets[w]['description']}"
        + (f" ({' + '.join(by_owner[w])})" if w in by_owner else "")
        for c, w in shot["wardrobe"].items() if c in film.characters and w in film.assets])
    location = film.assets.get(shot["location"])
    if location:
        light = ", ".join(x for x in (scene["time_of_day"], scene.get("weather"), scene.get("lighting")) if x)
        section("LOCATION", [f"{location['name']}: {location['description']} ({light})"
                             + (f" ({' + '.join(by_owner[shot['location']])})" if shot["location"] in by_owner else "")])
    section("PROPS", [
        f"{film.assets[p]['name']}" + (f" at {shot['continuity']['prop_states'][p]}" if p in shot["continuity"]["prop_states"] else "")
        + (f" ({' + '.join(by_owner[p])})" if p in by_owner else "")
        for p in shot["props"] if p in film.assets])

    audio_inputs, audio_lines, lipsync_lines, spoken = [], [], [], {}
    visible = {cue["id"] for cue, _, _ in film.visible_dialogue(shot_id)}
    for cue, start, end in film.dialogue_over(shot_id):
        speaker = film.characters.get(cue.get("character"), {}).get("name", cue.get("character"))
        if cue["id"] in visible and shot["lipsync"] != "none":
            label = f"Audio {len(audio_inputs) + 1}"
            cue_offset = cue["start"] - spot["scene_start"]
            audio_inputs.append({"slot": label, "cue_id": cue["id"], "file": cue.get("file"),
                                 "trim_start": round(max(0.0, -cue_offset), 3), "shot_start": start, "shot_end": end})
            audio_lines.append(f"{label} = authoritative dialogue {cue['id']} by {speaker}, {start:.2f}-{end:.2f}s of this shot.")
            audio_lines += [f"  {a:.2f}-{b:.2f}s: \"{text}\"" for a, b, text in _sentences_in_shot(film, cue, cue_offset, start, end)]
            spoken.setdefault(speaker, []).append(f"{label} ({start:.2f}-{end:.2f}s)")
        else:
            audio_lines.append(f"Off-screen dialogue by {speaker} plays {start:.2f}-{end:.2f}s; nobody in frame lip-moves to it.")
    for speaker, spans in spoken.items():
        lipsync_lines.append(f"{speaker}'s mouth matches {' and '.join(spans)} exactly; "
                             "no mouth movement outside those intervals or during pauses.")
    if audio_lines and not lipsync_lines:
        lipsync_lines.append("Characters in frame listen and react; mouths stay closed except non-verbal reactions.")
    section("AUDIO AUTHORITY", audio_lines)
    section("SHOT / LENS", [f"{shot['shot_type'].replace('_', ' ')}, {shot['lens']}, {shot['duration_target']}s."])
    section("ACTION", [shot["action"]])
    section("PERFORMANCE", [shot["emotion"]])
    section("CAMERA", [shot["camera"]])
    section("LIPSYNC", lipsync_lines)
    continuity = shot["continuity"]
    section("CONTINUITY", [
        *(f"{film.characters[c]['name']} stays screen-{side}." for c, side in continuity["screen_positions"].items() if c in film.characters and side != "offscreen"),
        *(f"{film.characters[c]['name']}: {', '.join(conds)}." for c, conds in continuity["conditions"].items() if c in film.characters and conds),
        *(f"{film.characters[c]['name']} keeps hair as {film.characters[c]['canonical_hair']}"
          + (f" and wears {', '.join(film.characters[c]['accessories'])}." if film.characters[c].get("accessories") else ".")
          for c in shot["characters"] if c in film.characters),
        f"Movement direction: {continuity['screen_direction'].replace('_', ' ')}." if continuity["screen_direction"] != "static" else "",
        f"Cuts from {shot['continuity_from']}; match its end state." if shot["continuity_from"] else "",
        *(f"Intended change ({change['field']}): {change['reason']}" for change in shot.get("continuity_changes", []))])
    section("STYLE", [film.project["style"]["visual"]])
    section("NEGATIVE CONSTRAINTS", DEFAULT_NEGATIVE + film.project["style"].get("negative", []))

    text = "\n\n".join(f"{title}\n" + "\n".join(lines) for title, lines in sections)
    return {"shot_id": shot_id, "image_inputs": slots, "audio_inputs": audio_inputs, "prompt": text}


def route(film):
    """Per-shot render tier and required capabilities; the agent maps tiers to live providers."""
    rows = []
    mode = film.project["budget_mode"]
    for spot in film.timeline():
        shot = film.shots[spot["shot_id"]]
        visible = film.visible_dialogue(shot["shot_id"])
        capabilities = set(shot.get("model_requirements", []))
        if len(shot["references"]) > 1:
            capabilities.add("multi_reference")
        if shot.get("keyframe", {}).get("status") == "approved":
            capabilities.add("start_frame")
        if visible and shot["lipsync"] != "none":
            capabilities.add("audio_reference")
            if shot["lipsync"] == "native":
                capabilities.add("native_lipsync")
        rows.append({
            "shot_id": shot["shot_id"],
            "state": shot["state"],
            "render_class": shot["render_class"],
            "tier": TIER[mode][shot["render_class"]],
            "seconds": shot["duration_target"],
            "retry_budget": shot["retry_budget"],
            "capabilities": sorted(capabilities),
            "lipsync": shot["lipsync"],
            "dedicated_lipsync_recommended": bool(visible) and recommended_dedicated(film, shot),
        })
    return rows
